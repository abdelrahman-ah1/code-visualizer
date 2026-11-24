# M4 performance report

Measured, not promised. Everything here was run in one environment: Linux x64, **one** CPU core, Node 22.23.5, Chrome 157.0.8103.78 (headless), Python 3.10.12 (3.12 was not available), FastAPI 0.162.5, uvicorn 0.54.0. A real laptop will differ; rerun the commands below to get your own numbers.

## What the design already did, and what M4 changed

The trace is recorded once and replayed in the browser, so stepping never contacts the backend. M4 keeps that. The new work is on the way in (run, transfer, parse) and in the two new features (breakpoints, watch).

## 1. Backend (`python backend/bench.py`, median of 5)

| Program | Events | Trace size | Tracer run | `json.dumps` (used) | FastAPI default dict return | gzip level 4 |
|---|---|---|---|---|---|---|
| `19_long_loop` | 1,806 | 4.10 MB | 268 ms | **54.8 ms** | 649.6 ms | 20.4 ms, **0.08 MB (2%)** |
| `11_linked_list_build` | 35 | 0.02 MB | 33 ms | 0.3 ms | 3.2 ms | 0.1 ms |

- Returning the dict the usual FastAPI way costs **about 12x** more than encoding it once with `json.dumps`, because FastAPI first walks every value. `app.py` builds the response bytes itself.
- The trace compresses to about 2% with gzip, so the response that crosses the connection is small. `GZipMiddleware` is on.
- The tracer subprocess is the dominant cost (about 150 microseconds per event here). It is the M1 worker, unchanged. Its cost grows with the size of the heap it re-encodes at each event.
- Runs are capped at 2 at a time (`CODEVIZ_MAX_RUNS`). A third request gets a quick HTTP 429 instead of queueing.

## 2. Run button to replay, in the browser (`tests/performance.spec.ts`, dev server)

`19_long_loop`, 2,000 event limit, real backend, 1,806 events, 4.10 MB:

| Step | Time |
|---|---|
| Backend time (tracer + encode, from `Server-Timing`) | 386 to 407 ms |
| Whole request, round trip in the page | 488 to 494 ms |
| Validate and parse in the page (`parseTrace`) | 47 ms |
| Click Run to first replay frame visible | 966 to 1007 ms |

## 3. Replay speed, M3.5 compared with M4 (`node perf/measure.mjs`, production builds, same traces)

"Step" is the time from a Next click until two animation frames later (new snapshot committed and painted). At 60 Hz the floor of this method is 33.3 ms. "6x slower CPU" uses Chrome's CPU throttling to imitate a weaker device. Long tasks are main-thread blocks over 50 ms.

Normal speed:

| Scenario | Build | Load | Step median / p95 | Seek p95 | Long tasks |
|---|---|---|---|---|---|
| 1,806 events (real trace) | M3.5 | 244 ms | 33.3 / 33.5 ms | 33.7 ms | 0 |
| | M4 | 257 ms | 33.3 / 33.5 ms | 34.1 ms | 0 |
| 10,000 events (synthetic) | M3.5 | 362 ms | 33.3 / 33.5 ms | 33.9 ms | 0 |
| | M4 | 391 ms | 33.3 / 33.5 ms | 33.7 ms | 0 |
| 2,500-line source | M3.5 | 259 ms | 33.3 / 33.6 ms | 44.5 ms | 0 |
| | M4 | 269 ms | 33.3 / 33.5 ms | 33.5 ms | 0 |

6x slower CPU:

| Scenario | Build | Load | Step median / p95 | Seek p95 | Long tasks (total) |
|---|---|---|---|---|---|
| 1,806 events | M3.5 | 1,035 ms | 37.0 / 79.4 ms | 72.3 ms | 16 (1,060 ms) |
| | M4 | 1,039 ms | 36.1 / 65.9 ms | 69.7 ms | 17 (1,147 ms) |
| 10,000 events | M3.5 | 1,303 ms | 33.4 / 38.8 ms | 34.6 ms | 1 (56 ms) |
| | M4 | 1,318 ms | 33.4 / 37.6 ms | 34.3 ms | 1 (68 ms) |
| 2,500-line source | M3.5 | 1,077 ms | 33.3 / 106 ms | **154 ms** | 36 (2,319 ms) |
| | M4 | 1,365 ms | 33.5 / 67.0 ms | **66.5 ms** | 27 (1,570 ms) |

What this says:

- Adding the editor, run panel, breakpoints and watch did **not** slow stepping on normal recordings. Load time is the same within noise (the first numbers I took right after page load differed by about 60 ms because the page was still starting; the tables above wait for the page to settle).
- Every step in normal conditions lands on the 60 Hz frame floor, so this method cannot show anything faster than that. It does show regressions.
- The one real gain: **long source files**. Each source line is now its own memoized component, so a step re-renders two lines, not all of them. On a 2,500-line source with the CPU slowed 6x, seek p95 fell from 154 ms to 66.5 ms and long-task time from 2.3 s to 1.6 s. The price is a slower first load for such a file at 6x slowdown (1,077 to 1,365 ms) because each line now carries a breakpoint button. Programs are capped at 64 KiB, so this is the worst case.
- Heap use is 21 to 22 MB for the 10,000-event file in both builds.
- Bundle size: JS 247.69 kB to **264.20 kB** (gzip 78.13 to 83.48 kB). CSS 10.48 kB (3.00 kB gzip). No new npm package was added.

## 4. Breakpoints and watch on 10,000 events

`tests/m4perf.test.ts` (Node, real parser): building the line index **1.84 ms**; collecting 5,000 stops **1.02 ms**; 10,000 "next stop" lookups **1.80 ms** in total (binary search); change signatures for one watch over 10,000 events **30.6 ms**.

`tests/performance.spec.ts` (Chrome): with 3,333 stops, one "Next breakpoint" click until the new event is on screen took **83 to 98 ms** including test automation; adding a watch and showing its value **170 to 177 ms**.

Design choices behind these numbers: the line index is built once per trace; stops are recomputed only when the set of lines changes; a watch computes one signature per event once, when it is added, so "changed here" and "next change" are array reads; playback keeps the single-timeout design from M2.

## Limits (not claims)

- One machine, one core, headless Chrome. No Windows, macOS, Safari, Edge or phone numbers.
- Backend capture speed was measured on Python 3.10, not 3.12.
- The 10,000-event file is synthetic (one snapshot repeated). Real long traces with large heaps will cost more to record, transfer and parse. The tracer itself caps recordings at 2,000 events, so a 10,000-event recording can only come from a file.
- The watch cost grows with how much data a watched variable reaches (it walks the reachable heap per event).
- Dev-server numbers (section 2) include development React and proxying. Production builds were used for section 3.

## Rerun

```sh
python backend/bench.py                                   # section 1
cd frontend && npm run build
npx vite preview --port 4173 &                            # then:
CHROME_BIN=/path/to/chrome node perf/measure.mjs http://127.0.0.1:4173
CPU_THROTTLE=6 CHROME_BIN=... node perf/measure.mjs http://127.0.0.1:4173
npx vitest run tests/m4perf.test.ts                       # section 4 (Node)
npx playwright test tests/performance.spec.ts             # sections 2 and 4 (needs the backend)
```
