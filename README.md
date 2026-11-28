# Code Visualizer

An interactive web app that records the execution of unmodified **Python** or **C++** source and replays it step by step: stack frames, variables, heap objects, references, and data structures (linked lists, arrays, trees, graphs).

Status: Milestones 1 to 6 are done. See `plan.md` for the roadmap.

> **Local use only, trusted programs only.** Traced code runs as your OS user and can read files and use the network. A separate process, resource limits and a temporary working directory are not a sandbox. Do not expose the backend publicly or run other people's code. C++ programs are run twice (once under gdb, once natively with sanitizers), so do not run programs that are unsafe to run twice.

## How it works

```text
React + TypeScript UI  ->  FastAPI backend (127.0.0.1)  ->  Python tracer (sys.settrace)
                                                         ->  C++ tracer (g++ -g, then gdb)
                              |
                    versioned trace JSON (codeviz.trace/1.0)
                              |
                  browser replay engine and visualization
```

Replay happens entirely in the browser from saved snapshots. Stepping back never re-runs your program and cannot undo file or network effects.

## Quick start

Requirements: Python 3.12, Node 22.12 or newer. For C++ also `g++` and `gdb` (Linux verified; on Windows use WSL, see `WSL_SETUP.md`).

```sh
# Backend, from the repository root
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

```sh
# Frontend, in a second terminal
cd frontend
npm ci
npm run dev        # open http://127.0.0.1:5173
```

You can also trace a Python file from the command line without any server:

```sh
python3.12 trace_capture.py fixtures/05_alias.py -o alias.trace.json
```

## Tests

```sh
pip install pytest
python -m pytest -q test_trace.py backend/tests     # tracers, API, C++ (needs g++ and gdb)
cd frontend && npx tsc --noEmit && npx vitest run   # types and unit tests
cd frontend && npx playwright test                  # browser tests
```

CI (`.github/workflows/ci.yml`) runs all of these on every push and pull request.

## Repository map

| Path | Contents |
|---|---|
| `trace_capture.py`, `worker.py` | Python tracer: launcher/CLI and the `sys.settrace` worker |
| `cpp_trace.py`, `cpp_gdb_worker.py` | C++ tracer: compile, sanitizer run, and gdb stepping worker |
| `backend/` | FastAPI app, example programs, backend tests and C++ test programs |
| `frontend/` | Vite + React 19 + TypeScript replay UI, with unit and browser tests |
| `fixtures/`, `examples/` | Baseline Python programs with hand-written expected traces, and generated traces |
| `test_trace.py` | Tests for the baseline fixtures and edge scenarios |

## Documentation

- `TRACE_FORMAT.md`: trace event semantics and schema rules (the contract between tracer and UI)
- `CPP_LIMITS.md`: what C++ support covers and what it does not
- `backend/README.md`: API, limits and error codes
- `frontend/README.md`: frontend setup and design
- `HAND_CHECKS.md`: the baseline programs and the states to predict by hand
- `WSL_SETUP.md`: running C++ on Windows
- `TEST_REPORT*.md`, `WALKTHROUGH*.md`, `frontend/PERF_REPORT.md`: per-milestone evidence and walkthroughs
- `plan.md`: roadmap. `agent.md`: guide for coding agents.
