# How the files fit together

Read these in order. Start the app and keep the alias example open while reading.

## Input and state

1. **src/types.ts**: TypeScript descriptions of the existing trace contract. `Value` is tagged, so a reference is never mistaken for a scalar.
2. **src/parseTrace.ts**: accepts text, parses JSON once, checks fields/steps/heap links and limits, and returns a typed trace. It follows references only for validation, never recursively expands them, so cycles terminate. Additive metadata is ignored on the exact supported version. User strings are never executed.
3. **src/replay.ts**: pure helpers for clamping steps, picking cumulative output, event explanations and the seven run statuses. The last event may use the final output record, which can be newer than its checkpoint.
4. **src/usePlayback.ts**: only the playback index, playing flag and speed live here. One cleaned-up timeout advances one snapshot. Pausing, seeking or changing speed clears old timing. At the end it stops; Replay resets to zero.
5. **src/App.tsx**: file input, local example loading and temporary theme. It validates before replacing a recording. A monotonically increasing request number stops a slow old read from replacing a newer selection. A new recording remounts playback, so its old timer cannot survive.

## Views

6. **src/components/Replay.tsx**: joins one index to the event, source, memory and output panels. All panels read the same snapshot. It shows partial-capture and omitted-output warnings.
7. **src/components/Controls.tsx**: buttons, timeline and speed selector. Native controls supply keyboard interaction. Disabled buttons enforce boundaries.
8. **src/components/Source.tsx**: read-only numbered source with the current event line highlighted. Only the source viewport scrolls when the active line leaves it. Line zero has no source highlight.
9. **src/components/Memory.tsx**: stack frames and one card per captured heap ID. It renders values through ValueView. No graph traversal or layout mutation occurs. Parent frames are labeled suspended.
10. **src/components/ValueView.tsx**: scalars as escaped text, references as local heap links, opaque and omitted values as explicit labels. It never calls HTML insertion APIs.
11. **src/style.css**: desktop three-column layout, stacked phone layout, theme variables, focus rings and reduced-motion handling. The app currently has no structural animations.
12. **src/main.tsx**: mounts React with StrictMode, which also helps expose unsafe effect cleanup during development.

## Setup and proof

- **index.html**: root element and TypeScript entrypoint, not a second JavaScript app.
- **package.json**: exact direct dependency versions and run/test/build scripts.
- **package-lock.json**: exact dependency resolution for `npm ci`. Generated, not intended to be read line by line.
- **tsconfig.json**: strict TypeScript and browser/Node library types.
- **vite.config.ts**: Vite build and unit-test discovery; relative production asset paths.
- **playwright.config.ts**: browser-test setup, loopback-only dev server and optional installed-Chrome override.
- **.gitignore**: keeps dependencies, generated builds and browser-test artifacts out of commits.
- **public/examples/01_scalars.trace.json through 10_timeout.trace.json**: unchanged snapshots from the existing repo. They make M2 independently explorable without running Python. Compare them with the matching root fixtures and HAND_CHECKS.md.
- **tests/trace.test.ts**: accepts the ten real fixtures, checks known timing/recursion/identity/output states, bad data, versions, status and boundaries.
- **tests/performance.test.ts**: a synthetic 10,000-event parse smoke check. Prints size and timing, not a universal speed guarantee.
- **tests/replay.spec.ts**: real Chrome interaction tests for controls, timer cleanup, backwards output, imports/errors, cycles, keyboard use, safe text and screenshots at desktop/phone sizes in both themes.
- **README.md**: installation, upload, first manual check and scope.
- **TEST_REPORT.md**: what was actually tested, measurements and unverified platforms.
- **DEPENDENCIES.md**: free/open-source dependencies, versions, licenses and no required paid service.

## Try explaining it back

Why does `a` still point to `[1]` on line 3? Where is the single timer canceled? Why does `node.next → o1` not create an infinite tree? Which output is shown at the final event versus an earlier event?

Next small step: run the alias walkthrough on your laptop and inspect the files above. Do not start M3 automatically.
