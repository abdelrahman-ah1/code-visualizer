# C++ support: what it covers and what it does not (Milestone 5)

See WSL_SETUP.md for Windows (WSL2). Run C++ with the Language selector set to C++. There is no automatic language detection yet (deferred).
Needs `g++` and `gdb` on the machine running the backend. Verified on Linux (Ubuntu 22.04, g++ 11.4, gdb 12.1) only.
Windows and macOS (especially Apple Silicon, where gdb is hard to set up) are NOT verified. On Windows, use WSL.

## How a run works
1. Static scan (heuristic text match): rejects threads, fork/system/exec, sockets, inline asm, and `#include "..."`.
2. Compile with `-g -O0 -fno-inline -std=c++17 -Wall -Wextra`. Compiler errors and warnings become Findings with a line.
3. Two runs in parallel: (a) gdb steps the program line by line and records the trace; (b) a separate native run with
   AddressSanitizer + UndefinedBehaviorSanitizer + LeakSanitizer.

## The program runs more than once
A normal run executes your program twice, at the same time: once under gdb (the recording) and once natively with the sanitizers
(the memory check), with the same stdin. Each run gets its own empty working folder (run_trace and run_san inside a temporary
folder), so files written with relative names do not collide and the program cannot see the tool's own files by relative path.
Tested: examples 10_writes_a_file appends one line to notes.txt and each run counts 1 line.
Still possible twice: files written with absolute paths (for example /tmp/x), network calls, and anything outside the folders.
Both runs also consume CPU at once. Only the recording's stdout is shown. The warning sits next to the Run button for every C++ run.
If the program is not safe to run twice, do not run it here.

## Error coverage (tested = a test in backend/tests/test_cpp.py runs it for real)
| Problem | Result | Tested |
|---|---|---|
| Syntax/type error | status error, CompileError, line shown, no trace | yes |
| Missing system header | status unsupported | yes |
| Threads, fork, system, sockets | unsupported, never compiled | yes |
| Null dereference, bad pointer (SIGSEGV), SIGFPE, abort | partial trace up to the crash, exception event, status error | yes |
| Uncaught C++ exception | status error with exception type and message | yes |
| Caught exception | status ok, exception event in the trace | yes |
| Use after free, double free | Finding from ASan with allocation and free lines; freed block marked in Heap | yes |
| Heap/stack/global buffer overflow | Finding from ASan | yes (heap, stack) |
| Signed overflow, bad shift, null member access | Finding from UBSan | yes |
| Memory leak | Finding from LSan | yes |
| Infinite loop | timeout, stuck line reported | yes |
| Runaway recursion | trace_limit (frame depth) | yes |
| Huge program output | output_limit | yes |
| Uninitialised reads | NOT detected (only some compiler warnings) | n/a |
| Logic bugs (wrong answer) | NOT detected | n/a |
| Global overflow, UBSan beyond the common cases | not individually tested | no |

Four different things, kept apart: compiler diagnostics (before running), runtime failures (partial trace kept),
unsupported visualization (opaque nodes, truncation markers), and undetectable logic bugs (never reported).

## Lifetime tracking limits
- "Freed" is observed: breakpoints on operator new/delete/malloc/free after main starts. Not inferred.
- Not tracked: memory allocated before main, custom allocators, realloc, arena/pool allocations.
- Pointers into the middle of a block get an approximate node.
- Stack object IDs are tied to the call-stack frame, so a reused stack slot gets a new ID.
- Uninitialised locals show whatever the memory holds. A local is hidden until its declaration line has run.
- Functions that fit on one line produce no return event. Return values are captured for scalars, pointers, bool, enum only.
- Sanitizer findings come from the separate checker run, not the traced run. ASan stops at its first fatal error.
  The checker is skipped when compilation fails.

## Visualization limits
std::string is shown as a value and std::vector as an array (libstdc++ pretty printers, experimental).
Other STL types (map, set, list, unique_ptr...) are opaque. Limits: 32 frames, 300 heap nodes, 40 items per node, 40 locals.

## Crash containment (reliability protection, NOT a security sandbox)
Process groups, CPU/file-size/core rlimits, 6 GiB address-space cap on the tracer tree, kill on timeout, output-size
watcher, no-progress watcher (SIGINT after about 1.5 s on one line), trace-event cap, schema-checked reader for
tracer output. The program runs as your OS user: it can read your files and use the network (except what the scanner
rejects heuristically). Run only programs you trust.
Tested: user-program crash, infinite loop (single and multi-line), oversized output, memory hog, stack overflow,
malformed or flooding tracer output, hung tracer, missing toolchain, and a normal run afterwards each time.
Residual risks: a program that forks past the scanner, writes large files within rlimits, or sleeps in a syscall;
the scanner is text matching and can be bypassed.

## Trace format additions (additive, need owner OK)
Optional top-level: `diagnostics[]`, `exit_code`, `compile_ms`, `trace_ms`. Optional node fields: `storage`, `address`,
`freed`, `element_type`. Node types `array` and `std::vector`. A `<globals>` pseudo-frame. Version stays 1.0; old
recordings still load (tested), new fields are validated when present (tested).
