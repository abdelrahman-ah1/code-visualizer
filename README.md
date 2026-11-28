# Code Visualizer

Step through unmodified Python and C++ programs in the browser and watch how the stack, variables, heap objects, references and data structures change.

The program runs once while it is being recorded. The browser then replays the saved snapshots, so stepping backward, breakpoints and watches never run your code again.

> [!WARNING]
> **Run only programs you trust.** This is a local tool, **not a sandbox**. Recorded programs run as your OS user and can read your files and use the network. Keep the backend on `127.0.0.1`, never expose it publicly, and never run other people's code with it.

## Features

- **Write and record:** paste code or pick a built-in example, add program input, set event and time limits, then press **Run and record** (Ctrl+Enter).
- **Replay:** step forward and back, play at different speeds, and inspect call frames, locals, heap objects and program output.
- **Data structure views:** linked lists, arrays, stacks, queues, trees and graphs, with aliases and cycles shown and positions kept stable between steps. Anything the rules cannot safely classify gets a plainer view.
- **Breakpoints and watches:** jump between stops and follow values such as `head.next.value` or `items[0]`. Watches read saved snapshots and never evaluate code.
- **C++ memory checks:** a second run with AddressSanitizer, UndefinedBehaviorSanitizer and LeakSanitizer reports many memory errors, leaks and undefined behavior.
- **Honest results:** timeouts, crashes, limits and unsupported constructs are reported as such. A partial recording can still be replayed where one exists.
- **Offline sharing:** export a session as one HTML file that replays without a server. The file includes the source, captured values and output, so share it only if all of that can be public to the recipient.
- Dark and light mode, with desktop and phone layouts.

## Platform support

| Mode | Requirements | Notes |
| --- | --- | --- |
| Replay saved recordings | Node.js 22.12+ for the app | No backend needed. Exported session files need only a browser. |
| Record Python | Python 3.10+ (3.12 is the project baseline) | The command-line recorder needs no third-party packages. The web app's backend does. |
| Record C++ | Linux with `g++` and `gdb` | Not supported on native Windows. Use WSL2, which has **not been verified end to end**: see [WSL_SETUP.md](WSL_SETUP.md). macOS is not verified. |

## Quick start

You need two terminals. Start both from the repository root.

### 1. Backend

macOS or Linux:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Windows PowerShell (Python mode only):

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r backend/requirements.txt
.venv\Scripts\python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

For C++ on Ubuntu or WSL2, first install the tools, then follow the Linux steps:

```sh
sudo apt update && sudo apt install -y g++ gdb python3-venv
```

### 2. Frontend

```sh
cd frontend
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The page shows **Backend online** when it can reach the server.

### Try it

1. Choose the example **17 reverse linked list** and press **Run and record**.
2. Click line number `10` to set a breakpoint, then press **Next breakpoint** twice.
3. Add watches for `cur.value` and `prev`.

To replay without the backend, run only the frontend and open one of the bundled recordings, or your own trace JSON file.

## Record from the command line (Python)

From the repository root (on Windows, replace `python3` with `py -3.12`):

```sh
python3 trace_capture.py fixtures/05_alias.py -o alias.trace.json
```

Options: `--stdin-file`, `--timeout` (seconds, default 2) and `--max-events` (default 500). The exit code is `0` when the run's status is `ok`. A run that is recorded with any other status exits with `1`.

The same recorder can be called from Python:

```python
from trace_capture import capture
trace = capture("a = [1]\nb = a\nb.append(2)\n")
```

## How it works

```text
React + TypeScript app  (editor, replay, structure views)
        |  source code               ^  trace JSON
        v                            |
FastAPI backend on 127.0.0.1
        |-- Python: a fresh worker process using sys.settrace
        `-- C++:    g++ build stepped by gdb, plus a separate sanitizer run
```

The trace format, `codeviz.trace/1.0`, is the contract between the recorders and the interface. It is described in [TRACE_FORMAT.md](TRACE_FORMAT.md). For Python runs, the web app asks the backend for a more compact, pooled form.

A `line` event is a snapshot taken **before** that line runs.

| Path | Contents |
| --- | --- |
| `trace_capture.py`, `worker.py` | Python recorder |
| `cpp_trace.py`, `cpp_gdb_worker.py` | C++ recorder |
| `backend/` | Local API, C++ examples and backend tests. See [backend/README.md](backend/README.md). |
| `frontend/` | React app, browser tests and unit tests |
| `fixtures/`, `test_trace.py` | Hand-checked Python programs and recorder tests |
| `examples/` | Sample Python recordings, rewritten by `test_trace.py` |

## Limits

| Limit | Value |
| --- | --- |
| Source code | 64 KiB |
| Program input | 8 KiB |
| Events per run (web app) | 500 (default), 1,000 or 2,000 |
| Time limit (web app) | 2, 5 or 10 seconds (default: 2 for Python, 5 for C++) |
| Recording opened for replay | 20 MiB and 10,000 events |
| Concurrent backend runs | 2 by default (`CODEVIZ_MAX_RUNS`) |

### Python

- Not every value is captured. Opaque and truncated values are marked in the recording.
- Replay cannot undo side effects, such as file writes or network calls, from the original run.

### C++

- **Your program runs twice**, once under gdb and once with the sanitizers. File writes to absolute paths and network calls can happen twice. Do not use C++ mode on a program that is unsafe to run twice.
- Programs using threads, new processes, sockets or inline assembly are rejected by a text scan. This scan can be bypassed and is **not** a security filter.
- Uninitialized reads and logic errors are not reliably detected.
- Library containers are read through GDB's libstdc++ pretty printers, so what you see depends on them being available.

More detail is in [CPP_LIMITS.md](CPP_LIMITS.md). It dates from Milestone 5, and its list of opaque standard library types is out of date: the current recorder also reads common containers, container adaptors and smart pointers.

## Tests

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every push and pull request on Ubuntu 24.04: Python and C++ tests, the TypeScript type check, unit tests and browser tests.

To run the same checks on Linux, with the virtual environment active:

```sh
pip install pytest
python -m pytest -q test_trace.py backend/tests
cd frontend
npm ci
npx tsc --noEmit
npm test
npx playwright install chromium
CODEVIZ_PYTHON="$VIRTUAL_ENV/bin/python" npm run test:ui
```

The C++ tests need `g++` and `gdb`. `test_trace.py` rewrites the files in `examples/`, so review those changes before committing.

## Performance

These are local measurements from one machine with 1 core, **not guarantees**. The baseline is commit `3bee74b`. "p95" is the 95th percentile of the listed runs. Chrome heap figures are the JavaScript heap after load, over an empty page, after forced garbage collection, using a production build (`vite build` and preview).

| What | Before | After | Runs |
| --- | --- | --- | --- |
| Python, 1,806-event loop: server capture | 67 ms | 60 ms (66 ms with the compact form) | 20, median; p95 62 (plain), 71 (compact) |
| Python print-heavy: server capture | 33 ms | 25 ms (20 ms compact) | 20, median |
| Run response, 1,806-event loop | 3.59 MB | 0.57 MB compact (gzip 0.036 → 0.026 MB) | 1 |
| Run response, print-heavy | 1.99 MB | 0.11 MB | 1 |
| Chrome heap, 1,806-event loop | 5.33 MB | 3.37 MB | 3, no spread |
| Chrome heap, print-heavy (453 events) | 2.94 MB | 1.13 MB | 3 |
| Click to first frame, 1,806-event loop (production build, patched tree only) | not measured on baseline | 252-286 ms: 35-51 ms before the request, first byte 135-169 ms (capture about 60 ms), about 100-113 ms parse and draw after the response | 5 |
| Far seeks in Chrome | about 34 ms | about 34 ms (60 Hz frame floor) | 8 per run |
| C++ Huffman (278 events): cold / warm median / warm p95 | 1,716 / 1,681 / 1,790 ms | 1,106 / 1,099 / 1,182 ms | 10 runs, n=9 warm |
| C++ hashtree (198 events) | 679 / 692 / 714 ms | 659 / 653 / 694 ms | 10 runs |
| 10,000-event compact file (synthetic: one 40-item list whose length grows), first frame | 2,020 ms (plain, 19.2 MB) | 303 ms (compact, 1.4 MB) | 2 |
| Same file, Chrome heap | 17.9-18.2 MB | 6.7 MB | 2 |

The compact form shrinks gzip transfer very little, because gzip already removes the repetition. The 10,000-event row is a best case for the delta encoding. These measurements do not cover Windows, Safari or Edge.

## Project status

Milestones 1 to 6 are done: the Python recorder, replay interface, structure views, offline export, local backend with editor, C++ support, and graphs and trees with stable layout. Next is Milestone 7 (evaluation, documentation and reproducible demos). Java support is a possible later milestone. See [plan.md](plan.md).

## More documentation

- [TRACE_FORMAT.md](TRACE_FORMAT.md): event meanings and schema rules
- [backend/README.md](backend/README.md): API, errors and session token
- [frontend/README.md](frontend/README.md): interface notes by milestone
- [CPP_LIMITS.md](CPP_LIMITS.md) and [WSL_SETUP.md](WSL_SETUP.md): C++ coverage and Windows setup
- [HAND_CHECKS.md](HAND_CHECKS.md): the baseline programs and their expected states
- [agent.md](agent.md): guide for coding agents working on this repository
