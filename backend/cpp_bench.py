"""Measure C++ trace cost. Run: python3 -m backend.cpp_bench (needs g++ and gdb)."""
import json, time
from cpp_trace import capture_cpp
SRC = """#include <cstdio>
int main() {
    int total = 0;
    for (int i = 0; i < %d; i++) {
        total += i;
    }
    printf("%%d\\n", total);
    return 0;
}
"""
for n in (20, 100, 400):
    t = time.time(); r = capture_cpp(SRC % n, "", 10.0, 2000)
    wall = time.time() - t; ev = len(r["events"])
    print(f"loop n={n}: status={r['status']} events={ev} wall={wall:.2f}s compile={r['compile_ms']:.0f}ms trace={r['trace_ms']:.0f}ms "
          f"json={len(json.dumps(r))/1024:.0f}KiB ms/event={r['trace_ms']/max(ev,1):.2f}")
