# Milestone 2: file-based replay

A React + TypeScript interface for the existing `codeviz.trace/1.0` recordings. It reads saved state, never runs Python, and needs no backend.

## Add this pack to the repo

1. Extract the ZIP. It contains one `frontend` folder.
2. Open the repository root on GitHub, choose **Add file → Upload files** and drag the entire extracted `frontend` folder into the upload area. Do not upload the ZIP itself.
3. Before committing, confirm the paths begin with `frontend/`, not `frontend/frontend/` or a numbered filename. No existing root file needs replacing.
4. Pull the changes on your laptop (or download a fresh repository ZIP). Open that repository folder in your editor.

The old root README describes M1 only. Use this README for M2. This pack does not mark roadmap checkboxes or alter earlier documents.

## Run on your laptop

Install the current Node.js LTS from https://nodejs.org/ if Node is missing. This pack requires Node 22.12 or later. First check:

```sh
node --version
npm --version
```

From the repository root, on Windows PowerShell, macOS or Linux:

```sh
cd frontend
npm ci
npm run dev
```

Open the local URL printed in the terminal, normally http://127.0.0.1:5173. Keep that terminal running. Ctrl+C stops it. Do not double-click `index.html`: Vite must serve the app. Installation needs internet once; playback uses local files and bundled assets only.

If scripts are blocked in Windows PowerShell, use `npm.cmd` in place of `npm`, or open Command Prompt. Do not change your machine's security settings just to run this project.

## First five minutes

1. Click **Explore alias example**. The first event is frame entry, not an executed assignment.
2. Click **Next** until the event says `line · step 3 · line 3`. It says **Before this line executes**. Both `a` and `b` refer to `o1`, whose only item is `1`.
3. Click **Last**. The same object `o1` now contains `1` and `2`.
4. Click **Previous**. It goes back to the saved `[1]` state without running Python.
5. Pick `03 recursion` or `07 cycle` from the example menu. Reference links jump to a heap object, including self-cycles.
6. Try **Play**, **Pause**, speed changes and the event slider. **Replay** restarts at event 1 after reaching the end. All buttons work with Tab and Enter/Space; the focused slider uses arrow keys.
7. Switch between light and dark mode. Theme is temporary, not saved.

The ten bundled examples are exact copies of the repository's saved traces at the source commit recorded in TEST_REPORT.md. They are not newly generated or invented states. Their embedded runtime is displayed as recorded.

## Import your own M1 recording

You do not need to rerun Python to explore the built-in recordings. Your own local week-1 check is still a separate step; this pack does not assume you completed it.

In a second terminal, from the repository root (outside `frontend`):

```sh
# macOS/Linux, CPython 3.12 installed:
python3.12 -m unittest -v
python3.12 trace_capture.py fixtures/05_alias.py -o my-alias.trace.json

# Windows, CPython 3.12 installed:
py -3.12 -m unittest -v
py -3.12 trace_capture.py fixtures/05_alias.py -o my-alias.trace.json
```

Use one platform's commands, not both. Choose an unused output filename. The tests should say `OK`; note that the existing M1 suite regenerates the root `examples` files. Review those diffs before committing. In the browser, **Open trace JSON** and select the resulting JSON. The file stays in the browser; nothing uploads it.

## Checks

From `frontend`:

```sh
npm test
npm run build
npx playwright install chromium
npm run test:ui
```

The last two commands are optional for normal use, required for browser tests. Playwright's Chromium download needs internet and extra disk space. A Linux developer with Chrome installed can instead run `CHROME_BIN=/usr/bin/google-chrome npm run test:ui`. The normal browser test command starts and stops its own development server.

`npm run build` type-checks and creates `dist/`. To inspect that production build, run `npm run preview`. Do not upload `node_modules`, `dist`, `test-results` or `playwright-report` to GitHub.

## What M2 does and does not do

- Shows source, the current event, all captured frames/locals, a text heap inspector and captured stdout/stderr.
- References point to one object ID, so aliases and cycles are preserved. This is not the M3 linked-list/array diagram or animation work.
- A `line` event is before execution. Parent frames show suspended call sites. Exception events may later be caught; returns can be exception unwinding.
- The end uses top-level final output when present, otherwise the last checkpoint, with a warning. Backwards restores checkpoints rather than appending output.
- All seven run statuses, snapshot omissions, opaque values and truncated values remain visible. `complete` does not mean every value was captured.
- Empty recordings, one-event recordings and partial captures are supported. Broken/missing fields or references get a field-specific error; the previous valid recording is kept.
- Reader limits: 20 MiB and 10,000 events. The exact documented schema 1.0 is supported. Future minor versions require a compatibility review rather than silently guessing.
- No editor, tracing API, backend, breakpoints, watch expressions, export, hosted runner or structure layout. Those are later milestones.

The M1 runner is only for trusted local programs, not a sandbox. Replay cannot undo side effects from the original run. Do not run strangers' source or expose the runner on the internet.

See WALKTHROUGH.md for each file, TEST_REPORT.md for actual checks and limitations, and DEPENDENCIES.md for dependency licenses.
