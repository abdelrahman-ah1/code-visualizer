# Test report

Executed 23 November 2026. This report covers the supplied local starter, not a production executor.

## Results

| Environment | Outcome |
|---|---|
| Linux, CPython 3.12.16 | PASS: 10 baseline programs and 12 extra edge scenarios. `unittest` reports 13 methods because the ten baseline programs use subtests inside one method. |
| Linux, CPython 3.10.12 | PASS: the same suite. Useful compatibility evidence, but 3.12 remains the selected project baseline. |

Commands actually run:

```sh
python3 make_fixtures.py
python3 -m unittest -v
uv run --python 3.12 --no-project python -m unittest -v
```

`uv` was used only to select the test interpreter. It is not a runtime dependency. On your machine, use the simpler commands in README.md with an installed Python 3.12.

Actual runner output is in `test-results.txt` and `test-results-3.12.txt`. The latter reports 13 methods, OK. Runtime is only one local observation, not a performance benchmark. Example traces were last regenerated during the 3.12 test run.

## Baseline assertions

1. Scalar values at the right before-line boundary and final snapshot.
2. Loop body's three incoming totals, then final total.
3. Recursive call arguments, return values and four-frame maximum stack.
4. List mutation values at an intermediate checkpoint and final snapshot.
5. Alias identity equality, mutation through either name and identity persistence.
6. Distinct shallow-copy outer identities and shared nested identity.
7. Cyclic object self-edge and stored value.
8. Fixed stdin, exact stdout and output timing.
9. Exception type, failing line, preserved locals and absent failed assignment.
10. Wall timeout, incomplete status, partial trace and last known state before sleep.

## Extra edge scenarios

- Event-budget exhaustion on an infinite loop.
- Output-budget exhaustion.
- Compile-time syntax error before events exist.
- Caught exception, followed by successful completion.
- Dictionary graph encoding and identity of a returned object.
- Generator rejection.
- Object with a failing custom `__repr__`, proving the encoder does not need that method.
- Explicit snapshot item truncation.
- Deleted variable absent in the next snapshot.
- Captured stderr followed by exhausted fixed stdin / EOFError.
- Snapshot immutability after list mutation.
- Observed-object-budget exhaustion, and bounded traversal of a large outer list.

Assertions use independent hand-written expected values in `fixtures/*.expected.json`; they do not use the generated traces as their oracle. `examples/*.trace.json` are inspection aids only.

A separate reference-integrity walk over all ten saved traces confirmed that every encoded object reference resolves inside its own snapshot. The alias CLI returned 0; the timeout CLI returned 1 and preserved four events.

## Not validated

Windows/macOS execution and Windows descendant cleanup, every CPython patch release, hostile code, network/filesystem containment, multi-user deployment, threads, async, generators, native-extension internals, full garbage-collection fidelity, memory-leak detection, arbitrarily large structures and performance at scale.

The timeout fixture imports `time` only to demonstrate a native blocking call. Imported internals are not traced. The latest checkpoint is before `sleep(5)`, not a snapshot from inside it.

## Honest limitations to preserve

- This is a separate process, not a security sandbox. It must run only trusted local programs.
- Object pinning prevents address reuse at the cost of changing lifetime/GC behavior.
- Snapshots have bounded fields/items/depth and visible truncation markers.
- A clean `ok` status does not prove an untruncated graph. Check per-event truncation too.
- Killed workers can lose text produced since the last event. Do not invent final output.
- A return during exception unwind is not proof of a successful return.
- No project repository was read, changed or pushed. The pack is self-contained and has no repository-specific patch assumptions.
