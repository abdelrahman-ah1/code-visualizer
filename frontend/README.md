# Milestone 4: run your own code (M2 replay, M3 structures and M3.5 export included)

A React + TypeScript interface for the existing `codeviz.trace/1.0` recordings. Replay reads saved state and never runs Python. From M4 it can also ask a local backend to record a program you paste. Opening saved recordings and exported sessions still needs no backend.

## What is new in M4

- **Write code.** A new panel at the top has a code editor (plain textarea with line numbers, no editor library), an example menu (the fixtures, the M3 programs and four new ones), optional program input, an event limit (500, 1000, 2000) and a time limit (2, 5, 10 seconds). **Run and record** (or Ctrl+Enter) sends the code to the local backend and replays the result. The status chip shows "Backend online" or "Backend offline".
- **The backend** is a small FastAPI server in `backend/` (see `backend/README.md`). It runs the existing tracer once and returns the trace. It is for trusted programs on your own computer only.
- **Breakpoints.** Click a line number in the source panel (or focus it and press Enter). Play now stops just before that line runs. **Previous breakpoint** and **Next breakpoint** jump between stops. A breakpoint stops at every recorded `line` event on that line, which is a snapshot taken before the line executes. Lines that never ran in this recording are listed instead of silently ignored. Breakpoints stay when you re-run edited code and are cleared when you open a different recording.
- **Watch.** Type a variable or path such as `total`, `head.next.value` or `items[0]` and press Add watch. Each watch shows its value at the current step, says "Changed at this step" when it differs from the previous step, and has Previous change / Next change buttons. Nothing is evaluated: values are read from the saved snapshots, so a watch can never run code. Name lookup follows Python: the current function's variables first, then the module's.
- **Saved recordings still work** with the backend off, and exported session files still open offline. A session file now also has breakpoints and watch, but no editor and no Run.
- **Honest failures.** An uncaught exception, timeout, event limit and unsupported construct all come back as recordings with their real status. A busy backend (HTTP 429), a rejected request, a server error or a missing backend each show a clear message and never replace the recording on screen.
- **Performance** was measured, not assumed: see `PERF_REPORT.md`. Stepping stays at one frame in Chrome for 1,806 and 10,000 events, long source files render only the lines that change, and the backend response is built about 12x faster than the framework default and compresses to about 2%.
- The trace format, the tracer and the M3.5 export are unchanged. Only one new development dependency group is needed, and only for Python (`backend/requirements.txt`).

## Run the whole thing (M4)

Terminal 1, from the repository root (details in `backend/README.md`):

```sh
python3.12 -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Terminal 2:

```sh
cd frontend
npm ci
npm run dev
```

Open http://127.0.0.1:5173 (or http://localhost:5173), pick **Example program, 17 reverse linked list**, press **Run and record**, click the line number `10`, press **Next breakpoint** twice, and add the watches `cur.value` and `prev`.

To run all tests: `npm test` (unit), and `npm run test:ui` (Chrome; it starts both servers itself, using `CODEVIZ_PYTHON` to pick the Python that has the backend installed, for example `CODEVIZ_PYTHON=../.venv/bin/python npm run test:ui`).

## What was new in M3.5

- An **Export session (.html)** button appears under the recording name once a trace is loaded. It downloads one file, for example `12_linked_list_insert.session.html`.
- Double-click that file (or drag it into any modern browser). It replays the recording with no server, no internet and no install. It opens in a "Shared session" view: no example menu, no file picker, no export button. Everything else (stepping, structures, dark mode) works as before.
- The file contains the replay app itself plus the recording: the program source, every captured value and the program output. It contains nothing else, no file paths, no credentials. **Whoever receives the file can read all of it**, so share it only when you are happy to share the code and its output. The app says this next to the button and inside the shared view.
- The file blocks all network access by itself (a Content-Security-Policy with `default-src 'none'`), and the source and output are inserted as text, never as markup.
- `sample-sessions/12_linked_list_insert.session.html` is a ready-made example. Double-click it to see what a recipient sees.
- No real share link yet: that needs hosting (open question in plan.md).

## What was new in M3

- A **Structures** panel draws linked lists and arrays as boxes and arrows. Tags above a box are the variables that point at it, so aliases are visible (`head, other`).
- Boxes slide when they move, new boxes pop in, and a box that changed since the previous snapshot flashes. Turn on reduced motion in your OS and all of this switches off.
- Each structure keeps its own row, so a list does not jump around while you step. Inserting in the middle slides the later nodes right.
- Empty and single-node lists, cycles (a curved arrow back), two lists that share a tail, nested lists and cut-off arrays (a dashed `...` cell) are all handled.
- Dark and light mode, desktop and phone layout. On a narrow screen the diagram scrolls sideways inside its own panel.
- Five new bundled examples (11 to 15) with their Python in `frontend/programs/`. They were recorded by the repo's own `trace_capture.py` (Python 3.10.12 here, which M1 supports).
- The trace format and the M1 files are untouched.

## Add this pack to the repo

This pack is the whole `frontend` folder again, so it replaces the M3 one. Easiest way: delete your local `frontend` folder, extract the new one in its place, then commit. Files that are new or changed in M3 are listed in `WALKTHROUGH.md`.


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

Open the local URL printed in the terminal, normally http://127.0.0.1:5173. Keep that terminal running. Ctrl+C stops it. Do not double-click `index.html` or anything in `dist/`: Vite must serve the app. Only exported `*.session.html` files are meant to be double-clicked. Installation needs internet once; playback uses local files and bundled assets only.

If scripts are blocked in Windows PowerShell, use `npm.cmd` in place of `npm`, or open Command Prompt. Do not change your machine's security settings just to run this project.

## Try M3.5 first

1. Run `npm run dev`, pick `12 linked list insert`, click **Export session (.html)**. Your browser saves the file.
2. Turn off Wi-Fi if you like, then open the saved file straight from your Downloads folder. Click Last: the list is spliced and the tail points back to the head.
3. Open `sample-sessions/12_linked_list_insert.session.html` the same way.
4. Production check: `npm run build` also writes `dist/session-template.html`, the file the export starts from.

## Try M3 first

1. Pick `12 linked list insert` from the example menu, then drag the slider. Watch `new` appear, then `prev.next = new` splice it in between 2 and 4, then the tail point back at the head.
2. Pick `15 alias list nodes` and step to the end. `b` tags one node while `a` tags another; the second row shows a list that joins the first.
3. Pick `14 array mutation`. The outer `grid` list has arrows to the two inner lists.
4. Toggle dark and light mode, and shrink the browser window to phone width.

## First five minutes (from M2)

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
- No editor, tracing API, backend, breakpoints, watch expressions, hosted runner or share link. Those are later milestones. Export exists as of M3.5.

The M1 runner is only for trusted local programs, not a sandbox. Replay cannot undo side effects from the original run. Do not run strangers' source or expose the runner on the internet.

See WALKTHROUGH.md for each file, TEST_REPORT.md for actual checks and limitations, and DEPENDENCIES.md for dependency licenses.
