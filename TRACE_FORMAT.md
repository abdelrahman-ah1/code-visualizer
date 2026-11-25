# Trace format, version 1.0

## Timeline semantics

`line` means **before the highlighted line runs**. It is not an after-line snapshot.
For `x = 1` on line 1 and `x = 3` on line 2, the line-2 event still has `x == 1`.
The next event, or the module's final `return`, reveals the completed assignment.
One physical line can contain several statements. This is a line tracer, not an expression tracer.

- `call`: entry into a Python frame. Function parameters are bound. The reported line can be the `def` line, not the first body line.
- `line`: the interpreter is about to execute that line. Loop lines can repeat.
- `return`: the frame is still present, with its locals and encoded `return_value`. It disappears in the next caller snapshot.
- `exception`: an exception has been raised or propagated into this frame. `exception_type` names it. It might be caught later.

Python emits a return event with `None` during exception unwinding too. Do not label every return event as a successful function result. The final run status distinguishes uncaught failure, while the event sequence retains propagation. There is no explicit unwind flag in v1.0.

A UI must highlight the current event's line as the next line on `line`, with an explicit before-execution label. A parent's frame line during a recursive call is a suspended call site, not another pending independent instruction.

`stdout` and `stderr` on each event are cumulative up to that snapshot. A `print` on the highlighted line has not happened yet. Final output also lives at the top level for completed workers.

## Top-level fields

| Field | Meaning |
|---|---|
| `schema_version` | Exactly `codeviz.trace/1.0`. Reject unknown major versions in a viewer. |
| `runtime` | Interpreter implementation and exact version used. Baseline is CPython 3.12. |
| `source` | Original source string. Lines are 1-indexed. |
| `limits` | Wall seconds, maximum event count and output-character budget per stream. |
| `events` | Saved snapshots in ascending `step` order, starting at 0. |
| `status` | `ok`, `error`, `timeout`, `trace_limit`, `output_limit`, `unsupported` or `worker_error`. |
| `complete` | True only when the traced run finished normally or with a captured uncaught exception. Does not promise a complete heap view. |
| `stdout`, `stderr` | Final cumulative captured text when a final record exists. Missing after a killed worker; use the last event's checkpoint, which may lag. |
| `error` | For captured execution errors, exception type; syntax errors also carry a line. Messages are intentionally not rendered via arbitrary exception `str`. |
| `resource_limits_applied` | Whether Unix memory/file/CPU limit setup succeeded. Missing when the worker had no final record. |

`trace_limit` covers event, total observed-object or stack-depth caps. It does not currently distinguish those causes. `worker_error` can mean OS termination or a failed worker protocol. Do not show it as a user-code exception.

A timeout kills the worker and preserves complete JSONL event records already written. No final snapshot is invented. If the kill happens during a native call, the latest state can be the pre-call snapshot.

## Each event

```json
{
  "step": 3,
  "event": "line",
  "line": 3,
  "frames": [
    {"depth": 0, "function": "<module>", "line": 3,
     "locals": {"a": {"kind": "ref", "id": "o1"},
                "b": {"kind": "ref", "id": "o1"}}}
  ],
  "heap": {"o1": {"type": "list", "length": 1,
                    "items": [{"kind": "scalar", "type": "int", "value": 1}]}},
  "stdout": "",
  "stderr": "",
  "truncated": []
}
```

This is an illustrative shape, not a promised event number for every Python build.
`frames` runs from module to current frame. Functions and classes can appear as opaque bindings. Class bodies also produce frames; not every `call` is a student function call.

Values are tagged:

- `scalar`: null, bool, int, float or string, with a type and JSON value. Non-finite floats use a string. Strings over 1,000 characters are marked truncated; integers over 4,096 bits become truncated values.
- `ref`: a run-local object ID. For captured objects, the matching node is in this snapshot's `heap`.
- `opaque`: function, class, built-in function or module, with no traversal.
- `truncated`: value omitted at a depth or scalar limit.

Heap nodes describe exact built-in lists/tuples (`items`), dictionaries (`entries`, an ordered list of key/value pairs), or ordinary objects (`fields`). Other types can be opaque nodes. Sets, custom container subclasses, slots and descriptors are not modeled as normal supported data structures.

IDs persist across snapshots in one run. They are not memory addresses and are not comparable across runs. Shared references use the same ID. A shallow copy has a different outer ID but may share nested IDs. A cycle can refer to a node already present in the same heap.

Object IDs are assigned in encounter order. Do not attach meaning to `o1` versus `o2`. The encoder pins up to 300 objects so Python cannot reuse an old object's address for a new object. That changes garbage-collection behavior. A missing node later means it is no longer reachable from the captured roots, not proof it was freed.

Every snapshot is serialized immediately. Mutating a list later does not rewrite earlier snapshots. A viewer can replay snapshots in either direction without executing the program again.

## Limits and omitted data

The starter captures only frames from its synthetic source filename, not imported library internals. Supported input is single-file, single-threaded, synchronous Python. Generators, generator expressions, async functions and await are rejected by a syntax-tree check. Imports are not blocked, but library internals, external state and threads are not visualized. Dynamic `exec`/`eval` code, arbitrary I/O, descriptors, slots and process management are outside the supported contract.

Per snapshot: 32 captured frames, depth 16, 40 locals per frame, 40 list items/dictionary entries/fields per node. Partial snapshots contain explicit `truncated` markers. A consumer must keep those markers visible. `status: ok` can coexist with snapshot truncation, which is why `complete` alone is not enough for a correctness claim.

Defaults: 500 events, 8,192 output characters per stream, 2-second wall timeout. Source cap: 64 KiB. Stdin cap: 8 KiB. Configurable public limits are validated in the parent. Unix best-effort caps are 256 MiB address space, 16 MiB per file and 3 CPU seconds. They are process guardrails, not security or a total disk quota.

On POSIX systems the launcher kills the worker process group at completion or timeout. Windows kills only the worker process; descendant cleanup is not implemented or tested. Never allow child-process programs under this prototype.

Schema evolution: new meanings for existing fields require a new major version. Additive optional metadata can use a minor version after reader compatibility is tested.

## Milestone 5 additions (optional, additive; version stays codeviz.trace/1.0)
See CPP_LIMITS.md. Top level: `diagnostics` (array of {source, severity, kind, line?, message}), `exit_code`, `compile_ms`, `trace_ms`.
Heap nodes: `storage` ("stack"|"heap"|"global"), `address`, `freed` (bool, observed free), `element_type`; node types `array`, `std::vector`.
Frame named `<globals>` holds C++ globals. Readers that ignore unknown fields keep working.

## Optional `unreached_heap` (C++ snapshots)

An event may carry `"unreached_heap": {"count": N, "bytes": B}`: live heap blocks the program allocated (and has not freed) that this snapshot could not draw. Every live block is drawn, either as its type (see `orphan`) or as raw bytes (`"type": "untyped block"`), so this appears only when the per-snapshot node budget (300 nodes) ran out; `truncated` then also contains `orphans`. It is a count, not a diagnosis. A consumer should show it. Absent means every tracked live block is drawn.

## Optional `orphan` on heap objects (C++)

A heap object may carry `"orphan": true`: the block is still allocated (never freed), but it is not reachable through the captured roots in this snapshot (no captured local, global, file-level static or top-level function-static leads to it, directly or through other blocks) (statics declared in nested blocks, lambdas or library code, thread-locals, registers and unmanaged buffers are not checked, so this is not a leak report), for example because the only chain to it ran through a node that was freed, or because it leaked. The tracker re-reads such a block as the type it was last seen with through a typed pointer (struct, scalar or array). A block never seen with a type is drawn as `"type": "untyped block"` (an array of `byte` items, `length` = block size, first 40 bytes) with no type invented and no `orphan` claim. Reachable nodes beyond the old depth limit are drawn normally.

## Compressed recordings (`.json.gz`)

A recording may be stored gzip-compressed. The viewer detects gzip by its first two bytes, not the file name, and `.json` files open exactly as before. The compressed bytes unpack to the same JSON text (the viewer saves the exact validated text, nothing is re-serialised). The 20 MiB limit applies to the unpacked text: unpacking stops as soon as that limit is passed, and a truncated or damaged file is refused with the previous recording kept. Saving and opening use the browser's Compression Streams; where they are missing, `.json` and session export still work and the save button is hidden.

When the recording file itself reaches its size limit (16 MiB), the run ends with status `trace_limit` and a diagnostic saying so; the steps recorded before that point are kept and are a valid beginning of the run (the incomplete last line is dropped). It is no longer reported as `worker_error`.
