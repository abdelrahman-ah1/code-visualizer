# M3.5 test report

Checked 24 November 2026 on the M3 base (main at commit 21b0179).

## Results actually run

- `npm ci` clean, `npx tsc --noEmit` clean, `npm run build` passed (JS 247.7 kB / 78.1 kB gzip, CSS 7.1 kB; `dist/session-template.html` about 255 kB).
- `npm test`: **66 tests passed** (60 earlier plus 6 new in `session.test.ts`).
- `CHROME_BIN=/usr/bin/google-chrome npm run test:ui`: **22 tests passed** in real headless Chrome (20 earlier plus 2 new). The new ones export from the running app, save the download, open it from `file://` in a separate browser context with `offline: true`, and check: no request other than file/data/blob, no console or page errors, shared view shown, no example menu or export button, Last/Next boundaries, structures panel drawn, no sideways scroll at 390 px in light mode. A hostile-source export (`<img onerror>`, `</script><script>`) sets no globals and renders as text.
- `npm audit`: 0 vulnerabilities at check time (point in time only).
- The trace format, the tracer and earlier fixtures were not touched. The Python baseline was not rerun.

## Visual inspection

Looked at the offline-opened session: 1280 px dark (list at final step with tags, arrows, tail pointing back to head, source, stack, heap, output) and 390 px light (readable, structure panel scrolls inside itself). Both showed the share notice and "SHARED SESSION" label. Layout matches the M3 app.

## Not tested

Firefox, Safari, Windows, a real phone, opening the file from email or chat apps (some block or rewrite HTML attachments), very large traces (up to 10,000 events should embed, but file size was only checked with the small examples).

---

# M3 test report

Checked 24 November 2026 on the M2 base (frontend folder from main, commit ef2299e).

## Results actually run

- `npm ci` clean, `npx tsc --noEmit` clean, `npm run build` passed (JS 245.5 kB / 77.4 kB gzip, CSS 7.1 kB).
- `npm test`: **60 tests passed** (35 from M2, 25 new in `structures.test.ts`). Covers: list built at head, empty then single node, None variables, self cycle, middle insert (later node shifts right, head does not), tail-to-head cycle, aliases, split list keeps old head's row, nested arrays, omitted elements, trace not mutated, row stability on all new examples, change detection.
- `CHROME_BIN=/usr/bin/google-chrome npm run test:ui`: **20 tests passed** in real headless Chrome (9 from M2 plus 11 new): boxes/arrows/tags, empty and single, untouched head stays put mid-transition, enter and changed marks, join arrow, arrays, cycle arrow, reduced motion gives 0s transitions, markup stays text, no page-level sideways scroll at 1280/390/320 in both themes.
- `npm audit`: 0 vulnerabilities at check time (point in time only).
- Python baseline was not changed or rerun. The five new traces came from the existing `trace_capture.py` on Python 3.10.12 and all report status `ok`.

## Visual inspection

Looked at the rendered Structures panel: a 3-node list at 1280 dark, a 4-node cyclic list at 390 light, the array/nested-list example at 1280 dark. Arrows, tags, None markers and index labels are readable. One problem found and fixed: an arrow from the outer list to the second inner list crossed the first inner list; arrows that skip a row now bow out to the right. 320 px screenshots were captured but only the 390 and 1280 ones were inspected closely.

## Measured

Scene building for 10,000 snapshots of a 3-node list: about 110 ms in Node 22 on one Linux core. Not measured: large heaps (hundreds of nodes) in the browser, Safari, Firefox, Windows. Animation smoothness was not judged on a real phone.

---

# M2 test report (earlier)

Checked 24 November 2026. Base repository main commit: `67610f9c7c2613079966dd12a00bf24b388c99e3`.

## Results actually run

- Existing Python baseline: `python3 -m unittest -v`, Python 3.10.12, Linux x64. **13 test methods passed**, including ten fixture programs and additional edge scenarios. Its generated example changes were discarded after the run; no baseline expectations or tracer code changed.
- `npm ci`: clean lockfile installation, followed by all checks below.
- `npm test`: **35 tests passed** across trace validation, the ten repository recordings, known states, boundaries and a larger bounded recording.
- `npm run build`: **passed**, including strict TypeScript checks and Vite production build.
- `CHROME_BIN=/usr/bin/google-chrome npm run test:ui`: **9 tests passed** in real headless Chrome. Includes actual file import, navigation/keyboard controls, playback with controlled browser time, pause/speed cleanup, final-state/replay, replacement while playing, stdout rewind, empty/single/partial recordings, all seven statuses, cycles, omission markers, safe text and responsive screenshots.
- `npm audit`: no known vulnerabilities reported at installation time. This is a point-in-time advisory check, not a security guarantee.
- Bundled example JSON files match the repository source bytes. Pack excludes generated files and dependencies.

A browser-test rerun initially caught an ambiguous test locator while the loading message and event status overlapped. The assertion now targets the event-status panel, not every live region. No product behavior was bypassed.

## Visual inspection

Inspected rendered Chrome screenshots at 1280, 390 and 320 CSS-pixel widths in both themes. Source, stack, cyclic heap, output, status labels and controls are readable, with no page-level horizontal overflow. Also inspected before-line and malformed-file states. Source alone may scroll horizontally for long code, keeping original indentation. Reference links resolve to heap cards. Reduced-motion rules are included; there are no structure animations in M2.

## Measured performance, not a laptop promise

Environment: Node 22.23.5, Chrome 157.0.8103.78, Linux x64, one exposed Intel Xeon Platinum 8375C CPU core. Synthetic recording: **10,000 events / 3,989,187 UTF-8 bytes**, repeated small alias snapshots.

- One Node parser run: **121.51 ms**.
- One browser import plus first-render assertion: **752 ms**.
- Last-event seek plus assertion: **74 ms**.
- Production JS: about **234.92 kB**, **73.62 kB gzip**; CSS about **5.66 kB**, **1.90 kB gzip**.

Browser timings include test automation overhead. These are bounded smoke measurements, not worst-case latency or memory claims. Complex large heaps and sources can cost more. No per-step parsing or code execution is used.

## Limits and checks not run

- This environment did not have CPython 3.12; the fresh Python regression run is 3.10 only. Existing 3.12 evidence remains in the original M1 report, not a new claim here.
- Windows/macOS, Safari/Firefox and the owner's laptop were not tested. His M1 local run is unconfirmed.
- Parser limits are 20 MiB and 10,000 events. Validation and parsing happen on the main browser thread; files near the cap may briefly block the UI. This is not a streaming reader or proof against every resource-exhaustion input.
- Exact schema 1.0 only. No reader changes to tracer semantics.
- Heap is a text inspector, not the M3 structure canvas. No backend, editor, breakpoints, watch, animation or session export.
- Existing root README says not to start React until its M1 learning gate. The user's explicit M2 request starts this pack without claiming that local gate was completed. Root docs are preserved.
- Existing plan.md settles FastAPI while agent.md retains an older open-backend sentence. No backend is part of M2; this pack does not silently revise either document.

# Milestone 4 test report

Environment: Linux x64, one CPU core, Node 22.23.5, Chrome 157.0.8103.78 (headless), Python 3.10.12 in a fresh virtual environment, FastAPI 0.162.5, uvicorn 0.54.0. Run on the final files, Nov 24, 2026. Python 3.12 was not available, so the backend and tracer were not run on 3.12 here.

## Results actually run

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | clean |
| Build | `npm run build` | ok (JS 264.20 kB, gzip 83.48 kB; session template written) |
| Unit tests | `npx vitest run` | **88 passed** (66 from M3.5, 22 new: breakpoints 10, watch 11, M4 timings 1) |
| Chrome UI tests | `npx playwright test` | **38 passed** (22 from M3.5 unchanged and passing, 14 in `m4.spec.ts`, 2 in `performance.spec.ts`) |
| Python tests with backend installed | `python -m unittest` | **41 passed** (13 M1 + 28 backend API tests) |
| Python tests without FastAPI | `python3 -m unittest` | 13 M1 tests pass, backend tests skipped with a message |
| npm audit | not rerun for M4 | no npm package was added or changed |

## What the new tests check

- Backend (real tracer subprocesses): trace equals `capture()` output; stdin; uncaught exception, syntax error with line, timeout with partial events, event limit and unsupported construct all return HTTP 200 with the true status; limits and types give 422; source over 64 KiB in bytes gives 413; oversized body 413; wrong content type 415; foreign Origin 403 and the tracer is not called; foreign Host (including `127.0.0.1.evil.example`) 403; no CORS headers; busy server 429 within the request and the slot is freed afterwards or after a tracer crash; gzip; all 19 examples trace to a documented status.
- Breakpoints (hand-derived from recorded events): loop body stops at events 3, 5, 7; recursion line with `line` and `return` events stops only on `line`; never-run lines are reported; Play pauses before a breakpoint line and continues to the next; Previous/Next breakpoint; keyboard toggle; breakpoints survive a re-run and are cleared by opening another recording.
- Watch: parsing accepts only names, fields, indexes and string keys (12 hostile inputs rejected); lookup order current frame then module; list index, negative index, out of range, missing field; linked list with a cycle prints without looping; change detection finds loop changes, in-place list mutation, rebinding to an equal copy, and going out of scope.
- UI: run, example programs and stdin, honest failures (error, trace_limit, unsupported, syntax error), 429, 500, a wrong-version trace refused, backend unreachable with saved recordings still opening, cancel then late answer ignored, draft survives reload, stale-editor notice, 64 KiB limit, Tab and Esc keys, export of a run then opening it offline with zero network requests and no console errors, desktop dark and light and phone screenshots with no sideways scroll.

## Measured performance

See `PERF_REPORT.md`: backend 268 ms to trace 1,806 events, response built about 12x faster than the framework default, gzip to about 2%, click Run to first frame about 1 s, stepping at the 33 ms frame floor for 1,806 and 10,000 events, long-source seeking improved at 6x slower CPU.

## Limits and checks not run

- Only Chrome was exercised in the browser. Edge and Safari were not tested; Firefox was not retested for M4.
- Python 3.12, Windows and macOS were not tested. The user's laptop numbers are unknown.
- The backend is not a sandbox and must not be exposed. Tests do not claim security beyond the local Host/Origin checks.
- A cancelled run keeps running on the backend until its time limit.
- The editor has no syntax highlighting or auto-indent. Watches cannot evaluate expressions.
- The 10,000-event performance recording is synthetic; the tracer itself stops at 2,000 events.
- The M3.5 plan.md checkbox is still unticked in the repo; this pack does not edit plan.md. When you are happy with M4, tick M4 and M3.5 yourself.
