# Milestone 5 test report (Linux, Ubuntu 22.04, g++ 11.4, gdb 12.1, Python 3.10, Node 22, Chrome)
- backend/tests/test_cpp.py: 41 tests, all pass (includes 2 working-folder isolation tests) (features, every failure class in CPP_LIMITS.md, broken/flooding/hung tracer, missing toolchain).
- Existing Python tests (test_trace.py): 13 pass. Frontend vitest: 111 pass (14 new C++ reader tests, including malformed diagnostics rejected and old recordings still loading).
- Playwright tests/m5.spec.ts: 6 pass (run-twice warning beside Run, file-writing example; overall "Problems found" banner and run-twice note asserted) in real Chrome with real backend: list swap, null-pointer crash with Findings, use-after-free with freed node, compile error then successful re-run, infinite loop timeout then successful re-run. Screenshots inspected by eye.
- tsc --noEmit passes.
## Performance (backend/cpp_bench.py, simple loop)
loop n=20: status=ok events=45 wall=0.34s compile=62ms trace=206ms json=12KiB ms/event=4.59
loop n=100: status=ok events=205 wall=0.44s compile=63ms trace=327ms json=56KiB ms/event=1.59
loop n=400: status=ok events=805 wall=0.69s compile=62ms trace=570ms json=222KiB ms/event=0.71
Fixed start-up cost is about 0.2 s trace plus about 0.06 s compile (more for iostream programs, 0.3 s). Marginal cost about 0.3 to 0.4 ms per event. Event cap 2000, time cap 10 s.
## Not tested
Windows, macOS, Apple Silicon. Backend API tests for language=cpp through HTTP beyond the browser tests (health shape and the 500 path were not unit-tested). Programs above 2000 events.
