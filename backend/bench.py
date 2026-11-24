"""Measure the backend's own costs, so performance claims come with numbers.

Run from the repo root:  python backend/bench.py
Times the tracer, the two ways of turning the result into a response, and gzip.
Nothing here starts a server or touches the network.
"""
import gzip
import json
from pathlib import Path
import platform
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from fastapi.encoders import jsonable_encoder  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from trace_capture import capture  # noqa: E402

PROGRAMS = {
    "long_loop (1,800 events)": ROOT / "backend/examples/19_long_loop.py",
    "linked list build (35 events)": ROOT / "frontend/programs/11_linked_list_build.py",
}
RUNS = 5


def ms(fn):
    start = time.perf_counter()
    out = fn()
    return (time.perf_counter() - start) * 1000, out


def median_ms(fn):
    return statistics.median(ms(fn)[0] for _ in range(RUNS))


def main():
    print(f"python {platform.python_version()} on {platform.platform()}, median of {RUNS} runs")
    for name, path in PROGRAMS.items():
        source = path.read_text(encoding="utf-8")
        capture_ms, result = ms(lambda: capture(source, "", 10, 2000))
        capture_ms = median_ms(lambda: capture(source, "", 10, 2000))
        direct = json.dumps(result, ensure_ascii=True, allow_nan=False)
        raw = len(direct.encode())
        packed = len(gzip.compress(direct.encode(), 4))
        print(f"\n{name}: status {result['status']}, {len(result['events'])} events, {raw / 1e6:.2f} MB")
        print(f"  tracer run (capture)            {capture_ms:7.1f} ms")
        print(f"  json.dumps (what app.py does)   {median_ms(lambda: json.dumps(result, ensure_ascii=True, allow_nan=False)):7.1f} ms")
        print(f"  FastAPI dict return (naive)     {median_ms(lambda: JSONResponse(jsonable_encoder(result)).body):7.1f} ms")
        print(f"  gzip level 4                    {median_ms(lambda: gzip.compress(direct.encode(), 4)):7.1f} ms  -> {packed / 1e6:.2f} MB ({100 * packed / raw:.0f}%)")


if __name__ == "__main__":
    main()
