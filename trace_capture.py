"""Local-only trace launcher. Run trusted programs, never public submissions."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import select

SCHEMA = "codeviz.trace/1.0"


def _wait(proc, timeout):
    """True when the process ended within `timeout` seconds. No timer thread, nothing to cancel.

    Popen.wait(timeout=...) polls with sleeps that grow to 50 ms, so a fast run was noticed up to 50 ms late. On Linux a
    pidfd is readable exactly when the process ends, which gives an exact wait. The process is not reaped here, so its
    process-group id cannot be reused before _kill_group runs. Elsewhere: a short fixed poll (at most 2 ms).
    """
    if hasattr(os, "pidfd_open"):
        try:
            fd = os.pidfd_open(proc.pid)
        except OSError:
            fd = None
        if fd is not None:
            try:
                ready, _, _ = select.select([fd], [], [], timeout)
            finally:
                os.close(fd)
            return bool(ready)
    deadline = time.monotonic() + timeout
    while proc.poll() is None:
        left = deadline - time.monotonic()
        if left <= 0:
            return False
        time.sleep(min(0.002, left))
    return True


def _kill_group(proc):
    if os.name == "posix":
        try:
            os.killpg(proc.pid, signal.SIGKILL)   # the worker runs in its own session (start_new_session), so this is its group only
        except ProcessLookupError:
            pass
    elif proc.poll() is None:
        proc.kill()   # Windows: no process groups here; only the worker itself is ended


def capture(source, stdin="", timeout=2.0, max_events=500, max_output=8192, as_json=False, pooled=False):
    """as_json=True returns the same trace as a JSON string, splicing the worker's event lines
    without parsing and re-encoding them (the server only forwards it)."""
    if len(source.encode("utf-8")) > 65536:
        raise ValueError("Source exceeds 64 KiB")
    if len(stdin.encode("utf-8")) > 8192:
        raise ValueError("Input exceeds 8 KiB")
    if not 0.05 <= timeout <= 10 or not 1 <= max_events <= 2000 or not 1 <= max_output <= 65536:
        raise ValueError("Limits out of range")
    worker = Path(__file__).with_name("worker.py").resolve()
    timed_out = False
    with tempfile.TemporaryDirectory(prefix="codeviz-") as folder:
        root = Path(folder)
        (root / "request.json").write_text(json.dumps({
            "source": source, "stdin": stdin, "max_events": max_events,
            "max_output": max_output,
            "cpu_seconds": int(timeout) + 2, "pooled": bool(pooled and as_json),
        }), encoding="utf-8")
        # A fresh interpreter, temp cwd, no inherited PYTHONPATH or secret env vars.
        # This is process separation, NOT a security boundary.
        env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "WINDIR", "LANG") if k in os.environ}
        with (root / "worker.log").open("wb") as log:
            proc = subprocess.Popen(
                [sys.executable, "-I", str(worker), str(root)], cwd=root,
                env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                start_new_session=(os.name == "posix"),
            )
            timed_out = not _wait(proc, timeout)
            try:
                _kill_group(proc)   # also ends anything the program left running
            finally:
                proc.wait()
        events = []
        raw_lines = []
        stream = root / "events.jsonl"
        if stream.exists():
            text = stream.read_text(encoding="utf-8")
            if as_json:
                # Every complete record ends with a newline; a kill can cut the last one short.
                raw_lines = text[:text.rfind("\n") + 1].splitlines() if text else []
            else:
                for line in text.splitlines():
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        break  # A kill can interrupt the final write.
        # Accesses live in their own optional file, one entry per step: the event stream keeps its old shape and a
        # killed run loses nothing it used to keep. Each entry belongs to the step whose line performed it.
        access_file = root / "accesses.jsonl"
        if access_file.exists():
            by_step = {}
            for line in access_file.read_text(encoding="utf-8").splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    break   # A kill can interrupt the final write.
                by_step[entry["step"]] = entry["accesses"]
            if by_step and as_json:
                merged = []
                for i, line in enumerate(raw_lines):
                    if i in by_step:
                        line = json.dumps(dict(json.loads(line), accesses=by_step[i]), separators=(",", ":"))
                    merged.append(line)
                raw_lines = merged
            else:
                for i, event in enumerate(events):
                    if i in by_step:
                        event["accesses"] = by_step[i]
        final = root / "final.json"
        result = json.loads(final.read_text(encoding="utf-8")) if final.exists() else {}
        if timed_out:
            result = {"status": "timeout", "complete": False, "limit_hit": {"kind": "wall_time", "limit": timeout}}
        elif not result:
            result = {"status": "worker_error", "complete": False,
                      "worker_exit_code": proc.returncode}
            # A signal ends the worker with a negative code. The two resource limits we set announce themselves this way.
            if proc.returncode == -getattr(signal, "SIGXCPU", 0):
                result["limit_hit"] = {"kind": "cpu_time", "limit": int(timeout) + 2}
            elif proc.returncode == -getattr(signal, "SIGXFSZ", 0):
                result["limit_hit"] = {"kind": "recording_size", "limit": 16 * 1024 * 1024}
        if as_json and pooled:
            def whole_lines(name):
                p = root / (name + ".txt")
                t = p.read_text(encoding="utf-8") if p.exists() else ""
                return t[:t.rfind("\n") + 1].split("\n")[:-1]
            def raw_text(name):
                p = root / (name + ".txt")
                if not p.exists():
                    return ""
                with p.open(encoding="utf-8", errors="surrogatepass", newline="") as fh:
                    return fh.read()
            enc = lambda v: json.dumps(v, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
            head = {"schema_version": SCHEMA,
                    "runtime": {"implementation": sys.implementation.name,
                                "version": sys.version.split()[0]},
                    "source": source,
                    "limits": {"wall_seconds": timeout, "events": max_events,
                               "output_chars": max_output}}
            tail = enc(result)
            return (enc(head)[:-1] + ',"encoding":"' + ("node-pool/3" if (root / "deltas.flag").exists() else "node-pool/2") + '","node_pool":[' + ",".join(whole_lines("nodes"))
                    + '],"frame_pool":[' + ",".join(whole_lines("frames"))
                    + '],"stdout_text":' + enc(raw_text("stdout")) + ',"stderr_text":' + enc(raw_text("stderr"))
                    + ',"events":[' + ",".join(raw_lines) + "]," + tail[1:])
        if as_json:
            head = {"schema_version": SCHEMA,
                    "runtime": {"implementation": sys.implementation.name,
                                "version": sys.version.split()[0]},
                    "source": source,
                    "limits": {"wall_seconds": timeout, "events": max_events,
                               "output_chars": max_output}}
            tail = json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
            return (json.dumps(head, ensure_ascii=True, allow_nan=False, separators=(",", ":"))[:-1]
                    + ',"events":[' + ",".join(raw_lines) + "]," + tail[1:])
        return {"schema_version": SCHEMA,
                "runtime": {"implementation": sys.implementation.name,
                            "version": sys.version.split()[0]},
                "source": source,
                "limits": {"wall_seconds": timeout, "events": max_events,
                           "output_chars": max_output},
                "events": events, **result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("-o", "--output", type=Path, default=Path("trace.json"))
    parser.add_argument("--stdin-file", type=Path)
    parser.add_argument("--timeout", type=float, default=2.0)
    parser.add_argument("--max-events", type=int, default=500)
    args = parser.parse_args()
    result = capture(args.source.read_text(encoding="utf-8"),
                     args.stdin_file.read_text(encoding="utf-8") if args.stdin_file else "",
                     args.timeout, args.max_events)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=True, allow_nan=False), encoding="utf-8")
    print(f"{result['status']}: {len(result['events'])} events -> {args.output}")
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
