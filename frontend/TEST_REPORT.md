# M2 test report

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
