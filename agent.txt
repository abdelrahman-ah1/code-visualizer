# Coding agent guide

Instructions for coding agents working on Code Visualizer in Cursor, Antigravity or Copilot.

## Start here

1. Read this file, `plan.md`, `README.md` and `TRACE_FORMAT.md` before changing code.
2. Inspect the repository and working tree. Read the files you will touch, the existing tests and representative traces. Do not assume this guide describes every file currently present.
3. Identify the user's current task and milestone. If no implementation task was requested, describe the next small step and wait. Reading this file is not permission to implement the whole plan.
4. Propose a short plan: files to change, behavior to add and tests to run. Work in small, reviewable batches.
5. Preserve unrelated and uncommitted work. Never reset, overwrite or delete it to make a task easier.

`plan.md` describes the roadmap. `TRACE_FORMAT.md` defines trace semantics. Existing code and tests establish what actually works. If they disagree, explain the conflict before changing behavior. Ask when a decision would change scope or architecture.

## Project purpose and priorities

Build an interactive web app that accepts unmodified Python and C++ source and helps people understand execution through stack frames, variables, heap objects, references and data structures.

- Goals: course project, portfolio piece, graduation project and eventually a product.
- Audience: students, teachers and interviewers.
- Priorities: correct traces, clear explanations, high performance and a clean interface.
- Work at a learning-friendly pace, roughly two hours a day without a fixed deadline. Estimates are not promises.
- The owner wants to understand every file. Working code without an explanation is an incomplete handoff.

## Decisions to preserve

- Run locally on the owner's laptop for now. Hosting is a separate future decision.
- Python and C++ are the first target languages. Java comes later.
- Build structure support in this order: linked lists, arrays, graphs, trees.
- Accept pasted code and offer built-in examples. Do not require a special language or user annotations.
- Use React for the interface. Use TypeScript for new frontend code to satisfy the no-plain-JavaScript requirement. If existing frontend conventions conflict, ask before converting them.
- Do not introduce PHP or a separate vanilla-JavaScript implementation.
- Use free, open-source project dependencies. Check licenses and whether any required service has a paid dependency. Do not add paid APIs or subscriptions.
- The owner's development tools are Antigravity, Cursor and Copilot. Do not replace their setup or require another paid tool.
- Keep user-facing text, comments and documentation in English.
- Design desktop first, but keep the interface usable on phones.
- Keep the interface clean and minimal, with dark mode and smooth, understandable transitions.
- The owner explicitly chose to keep the GitHub repo public. Older private-until-finished wording in `plan.md` is stale. Do not change repository visibility or edit that document without a request.

## Architecture

```text
React interface
  | source code, once the local backend milestone is reached
  v
Python + FastAPI local orchestration
  |-- Python tracer: sys.settrace
  `-- C++ tracer: g++ with debug information, then gdb
          |
          v
Canonical, versioned trace JSON
          |
          v
Browser replay engine -> visualization and playback controls
```

Before the backend milestone, the interface loads saved trace files directly.

### Boundaries

- Tracers execute programs and record execution state.
- The backend launches and supervises tracer processes and returns trace data. It does not calculate visual layout.
- Both language tracers must ultimately serve the same documented trace contract. Do not force C++ concepts into Python-only fields without designing and reviewing compatibility.
- The replay engine reads saved snapshots. It does not run source code or contact the backend for each step.
- The visualization layer consumes replay state. Keep layout and rendering separate from trace parsing and playback logic.
- Python + FastAPI is the current backend recommendation. A full C++ backend remains an open decision, not an instruction to rewrite anything. Ask before changing the backend stack.

### Performance rules

Trace once, replay locally. Measure before optimizing.

- Keep forward/backward stepping independent of program execution.
- Avoid reparsing the whole trace, recomputing the whole layout or rerendering every panel on every playback tick when the relevant data has not changed.
- Separate playback state from animation state. Rapid stepping, pausing and speed changes must not leave stale animations or the wrong snapshot on screen.
- Preserve visual positions where possible so users can follow object identity between steps.
- Test with small correctness examples and larger bounded traces. Record trace size, runtime, device/browser and measurements when making performance claims.
- Do not claim backward stepping is literally free, that a backend cannot be a bottleneck or that compilation has a fixed duration. Parsing, memory, layout and rendering still have costs.
- Prefer simple, measured improvements over speculative caching, a new framework or premature distributed infrastructure.

## Trace contract: do not break it

Read `TRACE_FORMAT.md` in full before touching capture, parsing or replay. It is the source of truth for exact fields and supported inputs.

- Preserve `codeviz.trace/1.0` unless a version change is explicitly approved. Do not silently rename fields or change meanings.
- A `line` event records state before that line executes. The UI must say so. It must not show a pending assignment or print as already completed.
- Keep the current event, stack, variables, heap and output synchronized.
- A `return` during exception unwinding is not necessarily a successful function result. An `exception` event can later be caught.
- Distinguish all documented run statuses. Timeouts, limits, unsupported inputs and worker failures must not look like successful completion.
- `complete` does not mean every heap value was captured. Keep truncation and omitted-data markers visible, even when the run status is `ok`.
- Object IDs describe identity within one run. Shared references must point to the same node; cycles must remain cycles. Never treat IDs as memory addresses or compare them across runs.
- A node missing from a later snapshot is not proof of deallocation. In particular, do not infer C++ dangling-pointer behavior from Python reachability.
- Earlier snapshots must remain unchanged when later snapshots are replayed or laid out. Store layout metadata separately instead of mutating trace input.
- Output checkpoints are cumulative. Do not append them repeatedly during replay. Handle traces with missing final output as the contract specifies.
- Reject unsupported major schema versions with a clear message. Discuss additive metadata and reader compatibility before changing the format.
- Validate imported files and show useful errors for malformed data, missing references and unsupported versions. Do not execute imported content or insert source/output as HTML.

## Milestone order and acceptance gates

M1 is recorded as delivered. Verify its current tests before relying on it. Do not report it as freshly tested unless you actually ran them.

### M1: trustworthy Python trace

Preserve the tracer, the ten baseline fixtures and independent expected-state tests. Understand event timing, recursion, identity, aliasing, copies, cycles, captured output and failure cases before building on them.

### M2: file-based replay interface

This is the next planned milestone unless the user requests something else.

Build a small React interface that loads saved trace JSON, shows source, current line, stack and variables, and supports previous/next, play/pause and playback speed. Do not add a backend yet.

Acceptance checks:

- Known fixture states appear correctly, including before-line timing, recursive calls, aliases and cycles.
- First/last-step boundaries, single-event and empty-event traces do not crash.
- Backward stepping restores the recorded state and output without rerunning code.
- Play/pause and speed changes do not create multiple timers or skip the final state.
- Malformed, incompatible and partial traces receive clear handling.

### M3: structures and presentation

Add linked-list rendering first, then arrays, with stable object identity, smooth transitions and dark mode. Test empty and single-node structures, aliases, cycles, insertion and mutation. Check real rendered output at desktop and phone sizes, in both themes. Honor reduced-motion settings.

### M3.5: single-file session export

After M3, export code plus trace as one self-contained file that someone can open and replay in a browser without a server. A real hosted share link comes later.

Verify an exported file opens offline, contains everything needed for replay and preserves trace semantics. Treat embedded source and output as data, not executable markup. Do not include credentials or unrelated local files. Explain that sharing a session shares its code, captured values and output.

### M4: local backend and editor

Add the FastAPI service, paste-code editor, examples, breakpoints and variable watch. Preserve file-based replay. Define replay breakpoints as stop points on recorded events unless another behavior is explicitly agreed. Add API and failure-path tests. Keep execution local and restricted to trusted programs.

### M5: C++ experiment

Start only after M1 through M4 are solid and the user chooses to proceed. Compile with debug information using g++, trace through gdb and test the shared contract. Begin with a narrow documented subset; report unsupported behavior rather than inventing values. Research platform/toolchain constraints and pointer-lifetime limitations before promising support.

### M6: graphs, trees and stable layout

Add graphs before trees. Test identity, cycles, disconnected nodes and position stability through changes. Choose and profile layout methods before adding a heavy dependency.

### M7: graduation and release

Prepare evaluation, learner-study materials if approved, a clear README, architecture documentation and reproducible demos. Advisor requirements, study participation and hosting are unresolved decisions. Do not invent approval or start recruiting people. The repo is already public; release readiness is a separate gate. Java is later work.

## Coding and testing workflow

1. Establish a baseline. Inspect the working tree and project configuration; run existing relevant tests before edits where possible.
2. Choose the smallest complete behavior for the requested task. Do not implement later milestones as a convenience.
3. Write or extend a test that checks observable behavior and expected values, not merely that a file or JSON object exists.
4. Implement in small, focused files with descriptive names. Avoid giant components and unnecessary abstractions. Reuse existing conventions.
5. Comment why code exists, non-obvious constraints and trace timing. Do not comment every obvious assignment.
6. Run relevant tests and the broader regression suite. Use the repository's actual scripts for type checks, lint and builds. Do not invent commands or say a check passed when it was not run.
7. For UI work, open the result and inspect actual rendered states. Check keyboard operation, readable labels, contrast, layout and error states. Automated tests alone do not verify appearance.
8. Review the diff for unrelated changes, secrets, generated clutter, dependency churn and accidental edits to fixtures or expected results.
9. Update run instructions and the file walkthrough when behavior or setup changes. Keep known limitations visible.

Existing Python baseline commands, from the repository README:

```sh
python3.12 --version
python3.12 -m unittest -v
python3.12 trace_capture.py fixtures/05_alias.py -o alias.trace.json
```

On Windows, the README uses `py -3.12` instead of `python3.12`. Inspect the environment first. Do not overwrite a user's existing output file. The baseline is CPython 3.12; preserve and check Python 3.10 compatibility when changing tracer code if the environment supports it. Report unavailable interpreters rather than claiming those checks passed.

Do not regenerate the baseline fixtures or rewrite expected states to make a failing test pass. First explain whether the implementation or the expectation is wrong, then make a justified, reviewable correction.

## Execution safety and scope

- The existing tracer is a local prototype for trusted programs, not a secure sandbox. A subprocess, isolated Python flag, temporary directory and resource limits do not make arbitrary code safe.
- Do not expose program execution on the public internet, accept strangers' code or bind a new runner to all network interfaces by default.
- Keep time, output, event, object and stack limits. Do not remove them to hide a failure. Preserve partial traces and their failure status.
- Run only inspected, trusted test programs. Traced code can still read files, access the network and cause side effects.
- Replay does not undo file writes, network calls or other effects from the original execution.
- Do not add telemetry, external uploads, hosted services or code-sharing destinations without approval.
- Never commit credentials, tokens, personal traces or machine-specific secrets. Public source visibility is not permission to upload private data.
- Do not publish, push commits, change repository settings or make destructive changes unless the current user task authorizes that action. Creating a local change is different from publishing it.

## Ask before these changes

Ask before changing the trace schema, language/framework stack, backend language, milestone order, supported execution model, security boundary or dependency with a major architectural cost. Also ask before deploying, spending money, adding a paid dependency or doing a broad refactor unrelated to the task.

Continue safe, independent work while a decision is pending. State the precise gap and offer a small recommendation with reasons. Do not silently turn an open question into a requirement.

## Handoff after each batch

Report:

- What changed and which milestone/task it serves.
- Each added or changed file, its job and how it connects to the others.
- Exact run commands and a short manual example with expected behavior.
- Checks actually run and their results, with failures and skipped checks clearly separated.
- Any measured performance results, remaining limits and decisions needed.
- The next small step, without starting it automatically.

Keep the walkthrough short enough to follow, but complete enough that the owner can explain every changed file. Never say the whole milestone is done until its agreed acceptance checks pass.

## Using this guide in different editors

Keep this file named `agent.md` as requested. Explicitly ask the coding assistant to read it and `plan.md` at the start of a session. Do not assume every editor automatically discovers this filename. If editor-specific instruction files are wanted, check the editor's current documentation and ask before adding them. Avoid maintaining several conflicting copies of these rules.
