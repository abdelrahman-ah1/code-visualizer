"""Local-only trace launcher. Run trusted programs, never public submissions."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

SCHEMA = "codeviz.trace/1.0"


def capture(source, stdin="", timeout=2.0, max_events=500, max_output=8192):
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
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
            finally:
                if os.name == "posix":
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                elif proc.poll() is None:
                    proc.kill()
                proc.wait()
        events = []
        stream = root / "events.jsonl"
        if stream.exists():
            for line in stream.read_text(encoding="utf-8").splitlines():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    break  # A kill can interrupt the final write.
        final = root / "final.json"
        result = json.loads(final.read_text(encoding="utf-8")) if final.exists() else {}
        if timed_out:
            result = {"status": "timeout", "complete": False}
        elif not result:
            result = {"status": "worker_error", "complete": False,
                      "worker_exit_code": proc.returncode}
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
