"""M5 C++ launcher: compile with g++, trace through gdb, run a separate memory-error check.

    from cpp_trace import capture_cpp      # same call shape as trace_capture.capture()

Pipeline (see docs in backend/README.md and CPP_LIMITS.md):
  1. scan      : refuse programs that use threads, child processes, sockets or inline assembly.
  2. compile   : g++ -g -O0. Compiler errors end the run here as status "error", with line numbers.
  3. trace     : gdb steps the program line by line (cpp_gdb_worker.py) and writes events.
  4. check     : IN PARALLEL, a second build with AddressSanitizer + UBSan runs natively and its
                 reports become diagnostics. This is how memory errors are found.

RELIABILITY, NOT SECURITY. Everything here contains honest mistakes (crash, endless loop, huge
output, runaway memory, huge source). None of it stops a hostile program. Run trusted code only.
"""
import json
import os
from pathlib import Path
import re
try:
    import resource   # Unix only: there is no such module on Windows
except ImportError:
    resource = None
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

SCHEMA = "codeviz.trace/1.0"
HERE = Path(__file__).resolve().parent
WORKER = HERE / "cpp_gdb_worker.py"
SOURCE_NAME = "main.cpp"
COMPILE_TIMEOUT = 20.0
MAX_DIAGNOSTICS = 25

# Things the tracer cannot follow or contain. A heuristic text scan, not a security filter.
UNSUPPORTED = [
    (r"#\s*include\s*<\s*(thread|future|atomic|barrier|latch|semaphore|stop_token|execution)\s*>", "threads",
     "Multi-threaded programs are not supported (found #include <{0}>). The tracer follows one thread."),
    (r"\b(std\s*::\s*(thread|jthread|async)|pthread_\w+|thrd_create)\b", "threads",
     "Multi-threaded programs are not supported ({0})."),
    (r"#\s*pragma\s+omp\b", "threads", "OpenMP programs are not supported."),
    (r"\b(fork|vfork|execv|execvp|execve|execl|execlp|execle|system|popen|posix_spawn|posix_spawnp|clone)\s*\(", "process",
     "Starting other programs or processes is not supported ({0})."),
    (r"#\s*include\s*<\s*(sys/socket\.h|netinet/in\.h|arpa/inet\.h|netdb\.h)\s*>", "network",
     "Network programs are not supported (found #include <{0}>)."),
    (r"\b(asm|__asm__|__asm)\s*(volatile\s*)?\(", "assembly", "Inline assembly is not supported."),
]
INCLUDE = re.compile(r'#\s*include\s*([<"])([^>"\n]*)[>"]')


def strip_comments_and_strings(text):
    """Blank out comments and string/char literals, keeping line structure."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i)); i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", text[i:j])); i = j
        elif c in "\"'" and not (c == "'" and i > 0 and text[i - 1].isalnum()):
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            j = min(j + 1, n)
            out.append(c + " " * (j - i - 2) + c if j - i >= 2 else c); i = j
        else:
            out.append(c); i += 1
    return "".join(out)


def scan_source(source):
    """Return a list of diagnostics for unsupported features, or []."""
    found = []
    clean = strip_comments_and_strings(source)
    for lineno, (raw, line) in enumerate(zip(source.splitlines(), clean.splitlines()), 1):
        m = INCLUDE.search(raw)
        if m and line.lstrip().startswith("#"):
            kind, name = m.group(1), m.group(2).strip()
            if kind == '"':
                found.append(diag("scanner", "error", "multi-file", lineno,
                                  'Only single-file programs are supported (found #include "%s"). Paste everything into one file.' % name))
                continue
            if name.startswith("/") or ".." in name:
                found.append(diag("scanner", "error", "include-path", lineno, "Include paths that leave the standard library are not supported."))
                continue
        for pattern, kind, message in UNSUPPORTED:
            mm = re.search(pattern, raw if pattern.startswith("#") else line)
            if mm and (not pattern.startswith("#") or line.lstrip().startswith("#")):
                found.append(diag("scanner", "error", kind, lineno, message.format(*(g for g in mm.groups() if g) or [mm.group(0)])))
    return found[:MAX_DIAGNOSTICS]


def diag(source, severity, kind, line, message, column=None, extra=None):
    d = {"source": source, "severity": severity, "kind": kind, "message": message}
    if line:
        d["line"] = int(line)
    if column:
        d["column"] = int(column)
    if extra:
        d.update(extra)
    return d


# ---------------------------------------------------------------- toolchain discovery
NATIVE_WINDOWS = os.name == "nt"   # C++ mode needs Unix (gdb under ptrace, setsid, rlimits, process groups); on Windows use WSL2


def find_tools():
    if NATIVE_WINDOWS:
        return None, None   # reported as toolchain missing, even if a Windows g++ or gdb happens to be on PATH
    env_gdb = os.environ.get("CODEVIZ_GDB")
    gdb = env_gdb or shutil.which("gdb")
    gpp = os.environ.get("CODEVIZ_GPP") or shutil.which("g++")
    return gdb, gpp


def tool_version(cmd, env=None):
    try:
        out = subprocess.run([cmd, "--version"], capture_output=True, text=True, timeout=3, env=env).stdout
        m = re.search(r"(\d+\.\d+(?:\.\d+)?)", out.splitlines()[0]) if out else None
        return m.group(1) if m else "unknown"
    except (OSError, subprocess.SubprocessError, IndexError):
        return "unknown"


def child_env(extra=None):
    keep = ("PATH", "LANG", "LD_LIBRARY_PATH", "HOME", "TMPDIR")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env["LC_ALL"] = "C.UTF-8"
    if extra:
        env.update(extra)
    return env


FILE_LIMIT_BYTES = 16 * 1024 * 1024


def limiter(cpu_seconds, address_space=None, file_bytes=FILE_LIMIT_BYTES):
    """Best-effort Unix limits applied to child processes. They stop accidents, not attackers."""
    def apply():
        os.setsid()
        for res, value in ((resource.RLIMIT_CPU, int(cpu_seconds) + 1), (resource.RLIMIT_FSIZE, file_bytes),
                           (resource.RLIMIT_CORE, 0), (resource.RLIMIT_AS, address_space)):
            if value is None:
                continue
            try:
                resource.setrlimit(res, (value, value))
            except (ValueError, OSError):
                pass
    return apply


def kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.SubprocessError:
        pass


def child_pids(pid):
    """Direct children of pid, read from /proc (Linux)."""
    out = []
    try:
        for name in os.listdir("/proc"):
            if name.isdigit():
                try:
                    with open(f"/proc/{name}/stat") as fh:
                        stat = fh.read()
                    if int(stat.rsplit(")", 1)[1].split()[1]) == pid:
                        out.append(int(name))
                except (OSError, ValueError, IndexError):
                    continue
    except OSError:
        pass
    return out


def run_limited(cmd, cwd, timeout, env, stdin=None, stdout=None, stderr=None, watch=None, cpu=None, address_space=None):
    """Run a child in its own process group. Returns (returncode, timed_out, reason).

    watch: optional callable polled every 50 ms; returning a string kills the child with that reason.
    """
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=stdin or subprocess.DEVNULL, stdout=stdout or subprocess.DEVNULL,
                            stderr=stderr or subprocess.DEVNULL, preexec_fn=limiter(cpu or timeout + 2, address_space))
    deadline, reason = time.monotonic() + timeout, None
    try:
        while proc.poll() is None:
            if time.monotonic() > deadline:
                reason = "timeout"
                break
            if watch is not None:
                reason = watch()
                if reason == "interrupt":   # ask the traced program (gdb's child) to stop, then let gdb report it
                    for child in child_pids(proc.pid):
                        try:
                            os.kill(child, signal.SIGINT)
                        except OSError:
                            pass
                    reason = None
                    time.sleep(0.1)
                elif reason:
                    break
            time.sleep(0.02)
    finally:
        kill_group(proc)
    return proc.returncode, reason == "timeout", reason


# ---------------------------------------------------------------- compiler output
GCC_LINE = re.compile(r"^(?P<file>[^\s:][^:]*):(?P<line>\d+):(?:(?P<col>\d+):)?\s*(?P<sev>fatal error|error|warning):\s*(?P<msg>.*)$")


def parse_compiler(text, source_name=SOURCE_NAME):
    out = []
    for raw in text.splitlines():
        m = GCC_LINE.match(raw)
        if not m or os.path.basename(m["file"]) != source_name:
            continue
        sev = "error" if m["sev"] in ("error", "fatal error") else "warning"
        msg = m["msg"].strip()
        kind = "compile-error" if sev == "error" else "compiler-warning"
        if "No such file or directory" in msg and "fatal" in m["sev"]:
            kind = "missing-include"
        out.append(diag("compiler", sev, kind, m["line"], msg, column=m["col"]))
        if len(out) >= MAX_DIAGNOSTICS:
            break
    return out


# ---------------------------------------------------------------- sanitizer reports
ASAN_HEAD = re.compile(r"ERROR: AddressSanitizer: (?P<kind>[\w-]+)(?P<rest>[^\n]*)")
FRAME = re.compile(r"#\d+ 0x[0-9a-f]+ in (?P<fn>\S.*?) (?:\S*/)?%s:(?P<line>\d+)(?::(?P<col>\d+))?" % re.escape(SOURCE_NAME))
ASAN_TEXT = {
    "heap-use-after-free": "Memory used after it was freed",
    "heap-buffer-overflow": "Read or write past the end of a heap block",
    "stack-buffer-overflow": "Read or write past the end of a local array or variable",
    "stack-buffer-underflow": "Read or write before the start of a local array",
    "global-buffer-overflow": "Read or write past the end of a global array",
    "stack-use-after-return": "Pointer to a local variable used after its function returned",
    "stack-use-after-scope": "Pointer to a local variable used after its block ended",
    "double-free": "Memory freed twice",
    "invalid-free": "free() or delete on memory that was not allocated that way",
    "alloc-dealloc-mismatch": "Memory freed with the wrong operator (new/delete, new[]/delete[], malloc/free)",
    "SEGV": "Invalid memory access (segmentation fault)",
    "stack-overflow": "Stack overflow (endless or very deep recursion)",
    "FPE": "Arithmetic error (such as integer division by zero)",
    "negative-size-param": "Negative size passed to a memory function",
    "memcpy-param-overlap": "Overlapping memory passed to memcpy",
}


def section_line(report, header):
    """First user-code line inside the block that starts with `header` (e.g. 'freed by thread T0 here:')."""
    i = report.find(header)
    if i < 0:
        return None
    for raw in report[i + len(header):].splitlines()[1:12]:
        if raw.strip() == "":
            break
        m = FRAME.search(raw)
        if m:
            return int(m["line"])
        if not raw.lstrip().startswith("#"):
            break
    return None


def parse_sanitizer(text):
    out = []
    # AddressSanitizer: one fatal report per run.
    m = ASAN_HEAD.search(text)
    if m:
        kind = m["kind"]
        if kind == "attempting":  # "attempting double-free" / "attempting free on address which was not malloc()-ed"
            kind = "double-free" if "double-free" in m["rest"] else "invalid-free"
        report = text[m.start():]
        first = FRAME.search(report)
        base = ASAN_TEXT.get(kind, "Memory error detected (%s)" % kind)
        extra = {}
        freed = section_line(report, "freed by thread T0 here:")
        alloc = section_line(report, "previously allocated by thread T0 here:") or section_line(report, "allocated by thread T0 here:")
        notes = []
        if freed:
            notes.append("freed on line %d" % freed)
            extra["freed_line"] = freed
        if alloc:
            notes.append("allocated on line %d" % alloc)
            extra["allocated_line"] = alloc
        where = re.search(r"\b(READ|WRITE) of size (\d+)", report)
        message = base + (" (%s of %s bytes)" % (where[1].lower(), where[2]) if where else "")
        if notes:
            message += "; " + ", ".join(notes)
        out.append(diag("sanitizer", "error", "asan-" + kind, first["line"] if first else None, message,
                        column=first["col"] if first and first["col"] else None, extra=extra))
    # UndefinedBehaviorSanitizer: many runtime errors possible.
    seen = set()
    for um in re.finditer(r"(?:^|\n)(?:\S*/)?%s:(\d+):(\d+): runtime error: ([^\n]+)" % re.escape(SOURCE_NAME), text):
        key = (um[1], um[3][:40])
        if key in seen:
            continue
        seen.add(key)
        out.append(diag("sanitizer", "error", "undefined-behavior", um[1], "Undefined behavior: " + um[3].strip(), column=um[2]))
        if len(out) > 8:
            break
    # LeakSanitizer.
    if "LeakSanitizer: detected memory leaks" in text:
        direct = [0, 0]      # bytes, objects: blocks nothing points to any more
        indirect = [0, 0]    # blocks only reachable through a direct leak
        shown = 0
        for lm in re.finditer(r"(Direct|Indirect) leak of (\d+) byte\(s\) in (\d+) object\(s\) allocated from:\n((?:\s+#\d+[^\n]*\n?)+)", text):
            fm = FRAME.search(lm[4])
            if lm[1] == "Direct":
                direct[0] += int(lm[2]); direct[1] += int(lm[3])
                if shown < 5:
                    out.append(diag("sanitizer", "warning", "memory-leak", fm["line"] if fm else None,
                                    "Memory leak (direct): %s bytes in %s object(s) lost, never freed. Objects only reachable through them are counted in the total below" % (lm[2], lm[3])))
                    shown += 1
            else:
                indirect[0] += int(lm[2]); indirect[1] += int(lm[3])
        if direct[1] == 0:
            out.append(diag("sanitizer", "warning", "memory-leak", None, "Memory leak: some allocated memory was never freed"))
        else:
            out.append(diag("sanitizer", "warning", "memory-leak", None,
                            "Total never freed: %d bytes in %d object(s) (%d bytes in %d directly lost, %d bytes in %d reachable only through those)"
                            % (direct[0] + indirect[0], direct[1] + indirect[1], direct[0], direct[1], indirect[0], indirect[1])))
    return out[:MAX_DIAGNOSTICS]


# ---------------------------------------------------------------- the pipeline
def read_text(path, limit=200000):
    try:
        with open(path, "rb") as fh:
            return fh.read(limit).decode("utf-8", "replace")
    except OSError:
        return ""


PRELUDE = """\
#include <cstdio>
// Added by the visualizer: stdout and stderr unbuffered, so output shows up at the line that printed it.
__attribute__((constructor)) static void codeviz_unbuffer() { setvbuf(stdout, nullptr, _IONBF, 0); setvbuf(stderr, nullptr, _IONBF, 0); }
"""
STD_FLAGS = ["-std=c++17", "-g", "-fno-omit-frame-pointer", "-D_GLIBCXX_ASSERTIONS", "-Wall", "-Wextra"]


def base_result(source, timeout, max_events, max_output, runtime):
    return {"schema_version": SCHEMA, "runtime": runtime, "source": source,
            "limits": {"wall_seconds": timeout, "events": max_events, "output_chars": max_output}}


def capture_cpp(source, stdin="", timeout=5.0, max_events=500, max_output=8192):
    if len(source.encode("utf-8")) > 65536:
        raise ValueError("Source exceeds 64 KiB")
    if len(stdin.encode("utf-8")) > 8192:
        raise ValueError("Input exceeds 8 KiB")
    if not 0.05 <= timeout <= 10 or not 1 <= max_events <= 2000 or not 1 <= max_output <= 65536:
        raise ValueError("Limits out of range")
    gdb_path, gpp = find_tools()
    runtime = {"implementation": "g++ + gdb", "version": "unavailable"}
    if NATIVE_WINDOWS:
        r = base_result(source, timeout, max_events, max_output, runtime)
        r.update(events=[], status="worker_error", complete=False,
                 diagnostics=[diag("toolchain", "error", "unsupported-platform", None,
                                   "C++ tracing does not run on native Windows (it needs gdb under Linux). Use WSL2 (see WSL_SETUP.md), or record Python here.")])
        return r
    if not gdb_path or not gpp:
        missing = [n for n, p in (("g++", gpp), ("gdb", gdb_path)) if not p]
        r = base_result(source, timeout, max_events, max_output, runtime)
        r.update(events=[], status="worker_error", complete=False,
                 diagnostics=[diag("toolchain", "error", "toolchain-missing", None,
                                   "C++ tracing needs %s on PATH. On Ubuntu or WSL: sudo apt install g++ gdb." % " and ".join(missing))])
        return r
    env = child_env()
    gdb_env = child_env({k[len("CODEVIZ_GDB_ENV_"):]: v for k, v in os.environ.items() if k.startswith("CODEVIZ_GDB_ENV_")})
    runtime = {"implementation": "g++ + gdb", "version": "g++ %s, gdb %s" % (tool_version(gpp), tool_version(gdb_path, gdb_env))}
    result = base_result(source, timeout, max_events, max_output, runtime)
    scan = scan_source(source)
    if scan:
        result.update(events=[], status="unsupported", complete=False, diagnostics=scan)
        return result

    with tempfile.TemporaryDirectory(prefix="codeviz-cpp-") as folder:
        root = Path(folder)
        (root / SOURCE_NAME).write_text(source, encoding="utf-8")
        (root / "prelude.h").write_text(PRELUDE, encoding="utf-8")
        (root / "stdin.txt").write_text(stdin, encoding="utf-8")
        (root / "request.json").write_text(json.dumps({
            "source_path": str(root / SOURCE_NAME), "max_events": max_events, "max_output": max_output}), encoding="utf-8")

        # 1. compile for tracing
        t0 = time.perf_counter()
        with open(root / "compile.log", "wb") as log:
            code, timed_out, _ = run_limited(
                [gpp, *STD_FLAGS, "-O0", "-fno-inline", "-include", "prelude.h", SOURCE_NAME, "-o", "prog"],
                root, COMPILE_TIMEOUT, env, stdout=log, stderr=log, cpu=COMPILE_TIMEOUT + 5)
        compile_ms = (time.perf_counter() - t0) * 1000
        log_text = read_text(root / "compile.log", 100000)
        diags = parse_compiler(log_text)
        if timed_out:
            diags.append(diag("compiler", "error", "compile-timeout", None, "The compiler took longer than %d seconds." % COMPILE_TIMEOUT))
        if code != 0 or not (root / "prog").exists():
            errors = [d for d in diags if d["severity"] == "error"]
            if not errors:
                errors = [diag("compiler", "error", "compile-error", None, (log_text.strip().splitlines() or ["The compiler failed."])[-1][:300])]
                diags += errors
            missing = [d for d in errors if d["kind"] == "missing-include"]
            result.update(events=[], diagnostics=diags, compile_ms=round(compile_ms, 1))
            if missing:
                for d in missing:
                    d["message"] += " (extra libraries and your own headers are not supported)"
                result.update(status="unsupported", complete=False)
            else:
                first = errors[0]
                err = {"type": "CompileError"}
                if first.get("line"):
                    err["line"] = first["line"]
                result.update(status="error", complete=True, error=err)
            return result

        # 2+3. trace under gdb and, in parallel, the sanitizer check run
        check = {}
        checker = threading.Thread(target=sanitizer_check, args=(gpp, root, stdin, timeout, env, check), daemon=True)
        checker.start()
        t1 = time.perf_counter()
        gdb_cmd = [gdb_path, "-nx", "-batch", "-q"]
        data_dir = os.environ.get("CODEVIZ_GDB_DATA")
        if data_dir:
            gdb_cmd += ["--data-directory", data_dir]
        gdb_cmd += ["-x", str(WORKER), str(root / "prog")]
        gdb_env["CODEVIZ_DIR"] = str(root)
        stdout_file = root / "stdout.txt"
        events_file = root / "events.jsonl"
        progress = {"size": -1, "at": time.monotonic(), "sent": 0}
        step_budget = min(1.5, max(0.3, timeout * 0.4))

        def watch():
            try:
                if stdout_file.stat().st_size > max_output * 8 + 4096:
                    return "output_limit"
            except OSError:
                pass
            try:
                size = events_file.stat().st_size
            except OSError:
                size = 0
            now = time.monotonic()
            if size != progress["size"]:
                progress.update(size=size, at=now, sent=0)
            elif size > 0 and now - progress["at"] > step_budget and progress["sent"] < 3:
                progress["sent"] += 1           # one source line is taking too long: interrupt the program
                progress["at"] = now
                return "interrupt"
            return None

        trace_cwd = root / "run_trace"   # the program's own working folder; the checker run gets a different one
        trace_cwd.mkdir(exist_ok=True)
        with open(root / "gdb.log", "wb") as log:
            gcode, timed_out, reason = run_limited(gdb_cmd, trace_cwd, timeout, gdb_env, stdout=log, stderr=log, watch=watch,
                                                   cpu=timeout + 5, address_space=6 * 1024 ** 3)
        trace_ms = (time.perf_counter() - t1) * 1000
        events = []
        stream = root / "events.jsonl"
        if stream.exists():
            for line in stream.read_text(encoding="utf-8").splitlines():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    break  # a kill can cut the last write
        final = {}
        fpath = root / "final.json"
        if fpath.exists():
            try:
                final = json.loads(fpath.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                final = {}
        if reason == "output_limit":
            final = {"status": "output_limit", "complete": False}
        elif timed_out:
            final = {"status": "timeout", "complete": False}
            stuck_line = None
        elif not final:
            final = {"status": "worker_error", "complete": False, "worker_exit_code": gcode}
            tail = read_text(root / "gdb.log", 4000).strip().splitlines()
            if tail:
                diags.append(diag("tracer", "error", "worker-failed", None, "The tracer process ended without a result. Last output: " + tail[-1][:200]))
        stuck_line = final.pop("stuck_line", None)
        limit_kind = final.pop("limit", None)
        detail = final.pop("detail", None)
        exit_code = final.pop("exit_code", None)
        signal_name = final.pop("signal", None)
        # Which limit ended the run, in the shared recording field (see TRACE_FORMAT.md "limit_hit").
        status_now = final.get("status")
        if status_now == "trace_limit" and limit_kind == "events":
            final["limit_hit"] = {"kind": "events", "limit": max_events}
        elif status_now == "trace_limit" and limit_kind == "frames":
            final["limit_hit"] = {"kind": "stack_depth", "limit": 32}
        elif status_now == "trace_limit" and limit_kind == "file":
            final["limit_hit"] = {"kind": "recording_size", "limit": FILE_LIMIT_BYTES}
        elif status_now == "output_limit":
            final["limit_hit"] = {"kind": "output_chars", "limit": max_output}
        elif status_now == "timeout":
            # Two different clocks: one line that never finishes (step budget), or the whole run's time limit.
            final["limit_hit"] = {"kind": "step_time", "limit": step_budget} if stuck_line else {"kind": "wall_time", "limit": timeout}
        if final.get("status") == "worker_error" and detail:
            diags.append(diag("tracer", "error", "worker-failed", None, "Tracer failure: " + detail))
        checker.join(timeout=timeout + 8)
        if os.environ.get("CODEVIZ_KEEP_DIR"):  # developer aid: keep the work folder for inspection
            shutil.copytree(root, os.environ["CODEVIZ_KEEP_DIR"], dirs_exist_ok=True)
        diags += check.get("diagnostics", [])
        if final.get("status") == "error" and signal_name:
            diags.append(diag("runtime", "error", "signal-" + signal_name, final.get("error", {}).get("line"),
                              runtime_message(final["error"]["type"], signal_name)))
        elif exit_code:
            diags.append(diag("runtime", "info", "exit-code", None, "The program finished with exit code %d." % exit_code))
        if final.get("status") in ("trace_limit",):
            diags.append(diag("tracer", "info", "trace-limit", None,
                              ("Recording stopped because the call stack grew deeper than 32 frames (endless recursion?)."
                               if limit_kind == "frames" else
                               ("Recording stopped after %d steps because the recording reached its %d MiB file limit. The program may have continued; the steps shown are a valid beginning of the run. A separate memory check covered the whole run." % (len(events), FILE_LIMIT_BYTES // 1048576))
                               if limit_kind == "file" else
                               "Recording stopped after %d steps. The program may have continued. A separate memory check covered the whole run." % max_events)))
        if final.get("status") == "timeout":
            diags.append(diag("tracer", "warning", "timeout", stuck_line,
                              ("The program stayed on this line without finishing it (for %.1f seconds). This usually means an endless loop. Recording stopped." % step_budget)
                              if stuck_line else
                              ("Recording stopped at its %.1f second time limit after %d steps, so the capture is incomplete. The steps shown are a valid beginning of the run. Raise the Time limit to record further; this alone does not show whether the program would finish." % (timeout, len(events)))
                              if events else
                              "The program ran longer than %.1f seconds. Recording stopped; this can mean an endless loop." % timeout))
        if check.get("timed_out"):
            diags.append(diag("sanitizer", "info", "check-timeout", None, "The separate memory-check run timed out, so it may have missed later problems."))
        diags = merge_runtime(diags)
        diags = dedupe(diags)[:MAX_DIAGNOSTICS]
        result.update(events=events, diagnostics=diags, compile_ms=round(compile_ms, 1), trace_ms=round(trace_ms, 1), **final)
        if exit_code is not None:
            result["exit_code"] = exit_code
        return result


def runtime_message(kind, sig):
    pretty = {"SIGSEGV": "The program crashed with a segmentation fault (invalid memory access).",
              "SIGFPE": "The program crashed on an arithmetic error such as integer division by zero.",
              "SIGABRT": "The program aborted (an uncaught exception, a failed assert, or a heap error detected by the C library).",
              "SIGBUS": "The program crashed on a bad memory access (bus error).",
              "SIGILL": "The program executed an illegal instruction.",
              "SIGXCPU": "The program used too much CPU time.", "SIGXFSZ": "The program wrote too much data to a file.",
              "SIGTERM": "The program was terminated."}.get(sig, "The program stopped with signal %s." % sig)
    if kind != sig:
        pretty = "The program ended with an uncaught C++ exception (%s)." % kind
    return pretty


def merge_runtime(items):
    """One crash should read as one finding: drop sanitizer lines that only repeat the crash itself."""
    crash_lines = {d.get("line") for d in items if d["kind"].startswith("signal-")}
    out, per_line = [], set()
    for d in items:
        if d["kind"] in ("asan-SEGV", "asan-FPE", "asan-ABRT", "asan-BUS", "asan-ILL") and crash_lines:
            continue
        if d["kind"] == "undefined-behavior" and "insufficient space" in d["message"] and (d.get("line"), "ub") in per_line:
            continue
        if d["kind"] == "undefined-behavior":
            per_line.add((d.get("line"), "ub"))
        out.append(d)
    return out


def dedupe(items):
    seen, out = set(), []
    for d in items:
        key = (d["severity"], d.get("line"), d["message"])
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def sanitizer_check(gpp, root, stdin, timeout, env, result):
    """Second build with AddressSanitizer + UBSan, run natively. Reports become diagnostics."""
    try:
        with open(root / "san.log", "wb") as log:
            code, timed_out, _ = run_limited(
                [gpp, *STD_FLAGS, "-O0", "-fsanitize=address,undefined", "-fno-sanitize-recover=address", "-fno-inline",
                 "-include", "prelude.h", SOURCE_NAME, "-o", "prog_san"], root, COMPILE_TIMEOUT, env,
                stdout=log, stderr=log, cpu=COMPILE_TIMEOUT + 5)
        diags = [d for d in parse_compiler(read_text(root / "san.log")) if d["severity"] == "warning"]
        if code != 0 or not (root / "prog_san").exists():
            result["diagnostics"] = diags
            return
        san_env = dict(env)
        san_env["ASAN_OPTIONS"] = ("detect_leaks=1:abort_on_error=0:detect_stack_use_after_return=1:allocator_may_return_null=1:"
                                   "max_allocation_size_mb=512:hard_rss_limit_mb=1024:symbolize=1:handle_segv=1:color=0")
        san_env["UBSAN_OPTIONS"] = "print_stacktrace=0:color=0"
        san_env["LSAN_OPTIONS"] = "color=0"
        san_cwd = root / "run_san"
        san_cwd.mkdir(exist_ok=True)
        with open(root / "stdin.txt", "rb") as fin, open(root / "san_out.txt", "wb") as out, open(root / "san_err.txt", "wb") as err:
            def watch():
                try:
                    return "output_limit" if (root / "san_out.txt").stat().st_size > 1_000_000 else None
                except OSError:
                    return None
            _, timed_out, _ = run_limited([str(root / "prog_san")], san_cwd, timeout, san_env, stdin=fin, stdout=out, stderr=err, watch=watch,
                                          cpu=timeout + 5)
        result["timed_out"] = timed_out
        result["diagnostics"] = diags + parse_sanitizer(read_text(root / "san_err.txt", 400000))
    except Exception as exc:  # the checker must never take the trace down with it
        result["diagnostics"] = [diag("sanitizer", "info", "check-failed", None, "The memory check could not run: %s" % type(exc).__name__)]


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("-o", "--output", type=Path, default=Path("trace.json"))
    parser.add_argument("--stdin-file", type=Path)
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--max-events", type=int, default=500)
    args = parser.parse_args()
    result = capture_cpp(args.source.read_text(encoding="utf-8"),
                         args.stdin_file.read_text(encoding="utf-8") if args.stdin_file else "", args.timeout, args.max_events)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=True, allow_nan=False), encoding="utf-8")
    print(f"{result['status']}: {len(result['events'])} events -> {args.output}")
    for d in result.get("diagnostics", []):
        print(f"  [{d['severity']}] {d['source']}" + (f" line {d['line']}" if d.get("line") else "") + f": {d['message']}")
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
