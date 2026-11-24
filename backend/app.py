"""M4 local backend: a thin FastAPI layer over trace_capture.capture().

What it does: receive source code, run the existing tracer once, return the trace JSON.
What it does NOT do: lay anything out, keep state between requests, or sandbox code.

LOCAL ONLY, TRUSTED PROGRAMS ONLY. Traced code runs as your OS user and can read files and
use the network. Start it bound to 127.0.0.1 (see README) and never expose it publicly.
Because a web page you visit could try to POST code to localhost, every /api request is
checked for a local Host header and, when present, an allowed Origin (see guard() below).
"""
import json
import os
from pathlib import Path
import sys
import threading
import time
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, Response
from typing import Literal, Optional

from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from trace_capture import capture  # noqa: E402  (needs ROOT on sys.path first)
from cpp_trace import capture_cpp, find_tools, tool_version  # noqa: E402

# Where the example programs live. Each .py file is one example.
EXAMPLE_DIRS = [ROOT / "fixtures", ROOT / "frontend" / "programs", ROOT / "backend" / "examples"]
CPP_EXAMPLE_DIR = ROOT / "backend" / "cpp_examples"
# Hosts the browser may use to reach this server, and pages allowed to call it.
# The Vite dev server proxies /api, so the Origin is the dev server's address.
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
DEFAULT_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173",
                   "http://127.0.0.1:4173", "http://localhost:4173"]
MAX_BODY_BYTES = 300_000          # source is capped at 64 KiB and stdin at 8 KiB by capture()
MAX_CONCURRENT_RUNS = int(os.environ.get("CODEVIZ_MAX_RUNS", "2"))


def allowed_origins():
    extra = os.environ.get("CODEVIZ_ORIGINS", "")
    return set(DEFAULT_ORIGINS) | {o.strip() for o in extra.split(",") if o.strip()}


# One tracer run is a whole Python process. A small cap keeps a laptop responsive.
# acquire(blocking=False) means extra requests get a quick 429 instead of piling up.
_slots = threading.BoundedSemaphore(MAX_CONCURRENT_RUNS)

app = FastAPI(title="Code Visualizer local backend", docs_url=None, redoc_url=None, openapi_url=None)
# Traces are repetitive JSON (about 4 MB for 1,800 events), so compression pays off.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=4)


def fail(status, code, message):
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


@app.middleware("http")
async def guard(request: Request, call_next):
    """Reject requests that did not come from a local page. This is CSRF / DNS-rebinding defence."""
    host = urlsplit("//" + (request.headers.get("host") or "")).hostname  # drops the port, handles [::1]
    if host not in LOCAL_HOSTS:
        return fail(403, "bad_host", "This server only answers requests addressed to localhost.")
    origin = request.headers.get("origin")
    if origin is not None and origin not in allowed_origins():
        return fail(403, "bad_origin", "This page is not allowed to call the local backend.")
    if request.method == "POST":
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            return fail(415, "bad_content_type", "Send application/json.")
        length = request.headers.get("content-length")
        if length is None or not length.isdigit() or int(length) > MAX_BODY_BYTES:
            return fail(413, "too_large", "Request body is missing a length or is too large.")
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", [])[1:]) or "request"
    return fail(422, "invalid_request", f"{where}: {first.get('msg', 'invalid value')}")


class TraceRequest(BaseModel):
    # Bounds mirror trace_capture.capture(); it re-validates them, this gives early clear errors.
    source: str = Field(max_length=65536)
    stdin: str = Field(default="", max_length=8192)
    language: Literal["python", "cpp"] = "python"
    timeout: Optional[float] = Field(default=None, ge=0.05, le=10)   # default: 2 s Python, 5 s C++
    max_events: int = Field(default=500, ge=1, le=2000)


def cpp_status():
    """Is the C++ toolchain installed? Looked up on every call so installing gdb needs no restart."""
    gdb, gpp = find_tools()
    return {"available": bool(gdb and gpp), "gpp": bool(gpp), "gdb": bool(gdb)}


@app.get("/api/health")
def health():
    return {"status": "ok", "python": sys.version.split()[0], "max_concurrent_runs": MAX_CONCURRENT_RUNS, "cpp": cpp_status()}


def title_of(stem: str) -> str:
    return stem.replace("_", " ")


@app.get("/api/examples")
def examples():
    """Built-in example programs. The ids are file names without .py; sources are plain text."""
    found = {}
    for folder in EXAMPLE_DIRS:
        for path in sorted(folder.glob("*.py")):
            if path.stem not in found and path.stat().st_size <= 65536:
                found[path.stem] = path
    stdin = {"08_stdout_input": "Ada\n"}  # the one baseline program that reads input
    items = [{"id": stem, "title": title_of(stem), "source": path.read_text(encoding="utf-8"),
              "stdin": stdin.get(stem, ""), "language": "python"} for stem, path in sorted(found.items())]
    for path in sorted(CPP_EXAMPLE_DIR.glob("*.cpp")):
        if path.stat().st_size <= 65536:
            items.append({"id": "cpp_" + path.stem, "title": "C++ " + title_of(path.stem), "source": path.read_text(encoding="utf-8"),
                          "stdin": "", "language": "cpp"})
    return {"examples": items}


@app.post("/api/trace")
def trace(req: TraceRequest):
    """Run the tracer once and return the canonical trace (codeviz.trace/1.0) unchanged.

    The tracer's own statuses (error, timeout, trace_limit...) come back as HTTP 200 with that
    status inside the trace: a run that failed is still a recording the UI can replay.
    HTTP errors are reserved for requests that never reached the tracer.
    """
    if not _slots.acquire(blocking=False):
        return fail(429, "busy", f"{MAX_CONCURRENT_RUNS} runs are already in progress. Try again in a moment.")
    try:
        started = time.perf_counter()
        try:
            if req.language == "cpp":
                result = capture_cpp(req.source, req.stdin, req.timeout or 5.0, req.max_events)
            else:
                result = capture(req.source, req.stdin, req.timeout or 2.0, req.max_events)
        except ValueError as exc:  # size limits checked in bytes by the launchers
            return fail(413, "too_large", str(exc))
        except Exception as exc:  # a launcher bug must not take the server down: report it, stay up
            return fail(500, "tracer_failed", f"The tracer failed unexpectedly ({type(exc).__name__}). The server is still running; try again.")
        captured = time.perf_counter()
        # json.dumps directly: returning the dict would make FastAPI walk all ~100k values first.
        body = json.dumps(result, ensure_ascii=True, allow_nan=False)
        encoded = time.perf_counter()
    finally:
        _slots.release()
    timing = f"capture;dur={(captured - started) * 1000:.1f}, encode;dur={(encoded - captured) * 1000:.1f}"
    return Response(body, media_type="application/json",
                    headers={"Server-Timing": timing, "Cache-Control": "no-store"})
