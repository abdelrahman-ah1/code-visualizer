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

Heap nodes describe exact built-in lists/tuples (`items`), `collections.deque` (`items`, front-to-back order), dictionaries (`entries`, an ordered list of key/value pairs), or ordinary objects (`fields`). Other types can be opaque nodes. Sets, custom container subclasses, slots and descriptors are not modeled as normal supported data structures.

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
Container adaptors `std::queue`, `std::stack` and `std::priority_queue` are captured as `items` read from the adaptor's underlying container: `std::queue` runs front to back, `std::stack` bottom to top, and `std::priority_queue` keeps heap order (its real storage order, not sorted order). The node `type` is the adaptor's base name (for example `std::stack`), with `element_type` from the first template argument.
Frame named `<globals>` holds C++ globals. Readers that ignore unknown fields keep working.

## Optional `unreached_heap` (C++ snapshots)

An event may carry `"unreached_heap": {"count": N, "bytes": B}`: live heap blocks the program allocated (and has not freed) that this snapshot could not draw. Every live block is drawn, either as its type (see `orphan`) or as raw bytes (`"type": "untyped block"`), so this appears only when the per-snapshot node budget (300 nodes) ran out; `truncated` then also contains `orphans`. It is a count, not a diagnosis. A consumer should show it. Absent means every tracked live block is drawn.

## Optional `orphan` on heap objects (C++)

A heap object may carry `"orphan": true`: the block is still allocated (never freed), but it is not reachable through the captured roots in this snapshot (no captured local, global, file-level static or top-level function-static leads to it, directly or through other blocks) (statics declared in nested blocks, lambdas or library code, thread-locals, registers and unmanaged buffers are not checked, so this is not a leak report), for example because the only chain to it ran through a node that was freed, or because it leaked. The tracker re-reads such a block as the type it was last seen with through a typed pointer (struct, scalar or array). A block never seen with a type is drawn as `"type": "untyped block"` (an array of `byte` items, `length` = block size, first 40 bytes) with no type invented and no `orphan` claim. Reachable nodes beyond the old depth limit are drawn normally.

## Compressed recordings (`.json.gz`)

A recording may be stored gzip-compressed. The viewer detects gzip by its first two bytes, not the file name, and `.json` files open exactly as before. The compressed bytes unpack to the same JSON text (the viewer saves the exact validated text, nothing is re-serialised). The 20 MiB limit applies to the unpacked text: unpacking stops as soon as that limit is passed, and a truncated or damaged file is refused with the previous recording kept. Saving and opening use the browser's Compression Streams; where they are missing, `.json` and session export still work and the save button is hidden.

When the recording file itself reaches its size limit (16 MiB), the run ends with status `trace_limit` and a diagnostic saying so; the steps recorded before that point are kept and are a valid beginning of the run (the incomplete last line is dropped). It is no longer reported as `worker_error`.


## Which limit ended a run (`limit_hit`, optional)

When a limit stopped the run, the recording may carry `"limit_hit": {"kind": ..., "limit": number}`. Older recordings have no such field and open as before. `kind` is one of:

| `kind` | Meaning | `limit` |
| --- | --- | --- |
| `events` | The event limit chosen for the run (status `trace_limit`). | events |
| `objects` | More than 300 distinct objects to track (`trace_limit`, Python). | 300 |
| `stack_depth` | Calls nested deeper than 32 (`trace_limit`, Python). | 32 |
| `output_chars` | The output limit (`output_limit`). | characters |
| `wall_time` | The time limit (`timeout`). | seconds |
| `step_time` | C++ only: the program stayed on one line longer than the per-step budget (`timeout`). | seconds |
| `cpu_time` | The CPU-time backstop, set 2 s above the time limit (`worker_error`, Python; normally the wall limit fires first). | seconds |
| `memory` | A `MemoryError` under the 256 MiB allowance. The allowance covers the program and the recorder together, so it does not say which needed it (`error`, Python). | bytes |
| `recording_size` | One recording file reached its 16 MiB size limit (`trace_limit`; Python and C++). The steps before it are kept. | bytes |

C++ sets `events`, `stack_depth`, `output_chars`, `wall_time`, `step_time` and `recording_size`; it has no memory or CPU-time kinds. Nothing is attributed when the cause is not known (for example a worker killed by the operating system for another reason).

## Compact encodings (`encoding`, optional)

Recordings may be stored with `"encoding": "node-pool/1"`, `"node-pool/2"` or `"node-pool/3"`. The viewer expands them back to the plain 1.0 shape when it opens them, so everything downstream is unchanged. Plain 1.0 files have no `encoding` field and still open exactly as before.

- `node-pool/1`: `node_pool` holds each distinct heap node once; each event's `heap` is `{objectId: poolIndex}`.
- `node-pool/2`: also `frame_pool` (each distinct frame list once; an event's `frames` is an index), and `stdout_text` / `stderr_text` hold the final output once; an event's `stdout` / `stderr` is then a length into that text, counted in UTF-16 units.
- `node-pool/3`: a pool entry may be `{"delta_of": earlierIndex, "set": {field: value}, "append": [items]}`: the earlier entry with those top-level fields replaced and items added at the end. `items` is never replaced, only appended to.

The viewer bounds what a compact file may expand to by the same 20 MiB limit as a plain file (each rebuilt entry counts its full JSON size), and refuses bad indexes, forward or unknown delta bases, unknown delta fields and more than 10,000 events. The Run button asks the backend for the compact form (Python only); "Save recording" always writes the plain 1.0 shape, "Save compact" and the offline export write `node-pool/2`.

## Access marks (`accesses`, optional, Python)

An event may carry `"accesses": [{"id", "mode", "line", "cell" | "key" | "field"}]`: the elements the source line of that step touched. `mode` is `read`, `write` or `readwrite`; `id` is a heap id captured in the same event; `cell` is a list index, `key` a dict key (an int, string, boolean or null, as the program used it: `1`, `"1"` and `true` are three keys), `field` the name of an attribute held by an object. Recordings made before this field open as before.

- A Python `line` event fires before its line runs, so the accesses a line performs are known only after the next event starts. They are stored in a side file keyed by step and merged onto the event of the line that performed them. A run killed on a line keeps the marks of every earlier line, not of the line it was killed on.
- At most 8 per event (the last 8 are kept). Objects the recording did not capture get no mark. Booleans as indices get no mark.
- Marked: `v[i]` reads, `v[i] = x`, `v[i] += x`, and `for x in seq` over a bare name (one read per iteration; a dict gives the key). `name.field` reads, `name.field = x` and `name.field += x` mark a field the object holds itself (its own dict or slots); a method, a class attribute, a module member and a name the compiler mangles (`self.__x`) get no mark. `a.b.c = x` marks the read of `a.b` and the write of `c`; `+=` on a field is marked only when the object is a bare name (`p.n += 1`, not `a.b.n += 1`). Not marked (false negatives): a write that adds a key or field the snapshot does not hold yet (the line event is recorded before the line runs, so the row does not exist to ring; the summary still names it), slices, `del`, chained assignment, comprehensions, attributes, `for x in <expression>`, strings and sets.
- The renderer draws at most two rings per step; the lane summary lists them all.
