# Backend (Milestone 4)

A small FastAPI server that runs the existing tracer once and returns the trace JSON. It does no layout and keeps no state. The browser replays the result.

**Local use only, trusted programs only.** Traced code runs as your user and can read files and use the network. The server binds to `127.0.0.1`, refuses any request whose Host or Origin is not local, and is not a sandbox. Never expose it publicly, never bind it to `0.0.0.0`, never run other people's code.

## Run it

From the repository root (Python 3.10 or newer; the project baseline is 3.12):

```sh
python3.12 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

In a second terminal: `cd frontend`, `npm ci`, `npm run dev`, and open http://127.0.0.1:5173. The page shows "Backend online" when it can reach the server. The Vite dev server forwards `/api` to port 8000. To use another port, start Vite with `CODEVIZ_BACKEND_PORT=9000 npm run dev`.

## API

| Request | Answer |
|---|---|
| `GET /api/health` | `{status, python, max_concurrent_runs}` |
| `GET /api/examples` | `{examples: [{id, title, source, stdin}]}`, from `fixtures/`, `frontend/programs/`, `backend/examples/` |
| `POST /api/trace` with JSON `{source, stdin?, timeout?, max_events?}` | the trace, exactly as `trace_capture.capture()` returns it (`codeviz.trace/1.0`) |

Limits: source up to 64 KiB, stdin up to 8 KiB, `timeout` 0.05 to 10 seconds (default 2), `max_events` 1 to 2000 (default 500). A run that fails inside the tracer (`error`, `timeout`, `trace_limit`, `output_limit`, `unsupported`, `worker_error`) still returns HTTP 200: the status is inside the trace and the UI replays whatever was recorded. HTTP errors mean the request never reached the tracer:

| Status | `error.code` | When |
|---|---|---|
| 401 | `bad_token` | Missing or wrong session token (see below) |
| 403 | `bad_host`, `bad_origin` | Host is not localhost / 127.0.0.1 / ::1, or the Origin is not an allowed page |
| 413 | `too_large` | body over 300 kB, or source/stdin over their byte limits |
| 415 | `bad_content_type` | POST that is not `application/json` |
| 422 | `invalid_request` | missing or out-of-range field |
| 429 | `busy` | more than `CODEVIZ_MAX_RUNS` (default 2) runs at once |

Allowed Origins are the Vite dev and preview servers on `127.0.0.1` and `localhost` (ports 5173, 4173). Add more with `CODEVIZ_ORIGINS=http://127.0.0.1:3000,...`.

**Session token.** At startup the server makes a random token and writes it to `.codeviz-token` in the repository root (readable only by your user; `CODEVIZ_TOKEN_FILE` changes the path). The backend holds an exclusive lock on that file while it runs (the system releases it if the backend crashes), so only one backend can use a token file: a second one stops at startup with a message telling you to give it its own `CODEVIZ_TOKEN_FILE` (and to start its Vite server with the same variable). The file stays after exit and the next backend replaces its token. A request without the token gets 401, so a web page that reaches port 8000 directly, or another local app on an allowed port, cannot run code. It does not stop programs already running as your user, which can read the file.

Every trace response carries `Server-Timing: capture;dur=..., encode;dur=...`, and is gzip-compressed when the browser accepts it.

## Tests and measurements

```sh
python -m unittest                                    # all Python tests (M1 + backend)
python -m unittest discover -s backend/tests -t .     # backend only
python backend/bench.py                               # backend timings (see frontend/PERF_REPORT.md)
```
