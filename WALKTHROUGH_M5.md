# Milestone 5 walkthrough: file by file

New
- cpp_trace.py: launcher. Static scan, compile, runs gdb tracer and sanitizer check in parallel, contains failures, maps every outcome to a trace status.
- cpp_gdb_worker.py: runs inside gdb. Steps line by line, reads locals/heap through pointers, tracks new/delete/malloc/free, writes JSONL events in the existing trace shape.
- make_cpp_fixtures.py: regenerates frontend/public/examples/cpp_*.trace.json.
- backend/cpp_bench.py: measures cost per event.
- backend/cpp_examples/*.cpp: nine example programs (list swap, arrays/structs, recursion, tree, crash, use-after-free, leak, exception, string/vector).
- backend/tests/test_cpp.py + backend/tests/cpp_programs/*.cpp: 39 tests of features and failure containment.
- frontend/src/components/Diagnostics.tsx: Findings panel (compiler, memory check, tracer).
- frontend/tests/cpp.test.ts, frontend/tests/m5.spec.ts: reader tests and real-browser tests.
- CPP_LIMITS.md, TEST_REPORT_M5.md, this file.
Changed
- backend/app.py: `language` field, C++ examples, `cpp` status in /api/health, 500 tracer_failed on unexpected launcher error.
- frontend/src/types.ts, parseTrace.ts: optional new fields, validated when present.
- structures.ts: arrays/std::vector drawn as arrays.
- Replay.tsx, Memory.tsx, replay.ts: show Findings, storage/address, freed note, error status text.
- RunPanel.tsx, CodeEditor.tsx, App.tsx: Language selector (manual), C++ examples/starter, C++ fixtures in list.
- style.css, package.json (0.5.0), TRACE_FORMAT.md.
Unchanged: Python tracer, trace contract semantics, breakpoints, watch, session export.
Overall state: Replay.tsx shows a red "Problems found: N errors" line when the checker or compiler reported errors, even if the recording itself finished ("Recorded run: ok" only means the recording finished).
The program runs twice (recording + memory check): see CPP_LIMITS.md and the note in the Findings panel.
Isolation: cpp_trace.py runs the recording in run_trace/ and the memory check in run_san/ (separate empty folders). RunPanel.tsx shows a run-twice warning beside Run for every C++ run. New example 10_writes_a_file.cpp and tests RunIsolation.
WSL: see WSL_SETUP.md (Windows users run the backend in WSL2; not verified end to end).
