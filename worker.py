"""Worker implementation. Internal protocol; use trace_capture.py to launch."""
import errno
import io
import json
import math
from pathlib import Path
import sys
import types

FILENAME = "<visualized>"


class TraceLimit(BaseException):
    """The capture stopped at one of the tracer's own caps. `which` says which: events, objects or stack_depth."""
    def __init__(self, which="events", limit=None):
        super().__init__(which)
        self.which, self.limit = which, limit


class OutputLimit(BaseException):
    pass


class BoundedOutput(io.StringIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit

    def write(self, text):
        room = self.limit - self.tell()
        super().write(text[:room])
        if len(text) > room:
            raise OutputLimit()
        return len(text)


_INTS = {}
_ENCODE = json.JSONEncoder(ensure_ascii=True, allow_nan=False, check_circular=False,
                         separators=(",", ":")).encode


class Encoder:
    """Stable run-local identities. Pin referenced objects to avoid id reuse.

    This deliberately affects GC and caps total observed objects at 300.
    The heap is reachable supported data, not the interpreter's entire heap.
    """
    def __init__(self):
        self.ids = {}
        self.pinned = []

    def snapshot(self, frames, extra=None):
        heap = {}
        truncated = []

        def encode(value, depth=0):
            t = type(value)
            if value is None or t in (bool, int):
                if t is int:
                    if value.bit_length() > 4096:
                        truncated.append("integer")
                        return {"kind": "truncated", "type": "int"}
                    # Small ints repeat in every snapshot: reuse one read-only dict per value.
                    if -256 <= value <= 1024:
                        cached = _INTS.get(value)
                        if cached is None:
                            cached = _INTS[value] = {"kind": "scalar", "type": "int", "value": value}
                        return cached
                return {"kind": "scalar", "type": t.__name__, "value": value}
            if t is float:
                return {"kind": "scalar", "type": "float",
                        "value": value if math.isfinite(value) else str(value)}
            if t is str:
                if len(value) > 1000:
                    truncated.append("string")
                return {"kind": "scalar", "type": "str", "value": value[:1000],
                        "truncated": len(value) > 1000}
            if t in (types.FunctionType, type, types.BuiltinFunctionType, types.ModuleType):
                return {"kind": "opaque", "type": t.__name__}
            oid = id(value)
            if oid not in self.ids:
                if len(self.ids) >= 300:
                    raise TraceLimit("objects", 300)
                self.ids[oid] = f"o{len(self.ids) + 1}"
                self.pinned.append(value)
            ref = self.ids[oid]
            if ref in heap:
                return {"kind": "ref", "id": ref}
            if depth > 16:
                truncated.append("depth")
                return {"kind": "truncated", "type": "depth"}
            node = {"type": t.__name__}
            heap[ref] = node  # Register before recursion, so cycles terminate.
            if t in (list, tuple):
                node["items"] = [encode(x, depth + 1) for x in value[:40]]
                node["length"] = len(value)
                if len(value) > 40:
                    truncated.append("items")
                    node["truncated"] = True
            elif t is dict:
                node["entries"] = []
                for i, (key, item) in enumerate(value.items()):
                    if i == 40:
                        truncated.append("entries")
                        node["truncated"] = True
                        break
                    node["entries"].append([encode(key, depth + 1), encode(item, depth + 1)])
            else:
                # Bypass a user's __getattribute__, never call repr or properties.
                try:
                    fields = object.__getattribute__(value, "__dict__")
                except (AttributeError, TypeError):
                    fields = None
                if type(fields) is dict:
                    node["fields"] = {}
                    for i, (key, item) in enumerate(fields.items()):
                        if i == 40:
                            truncated.append("fields")
                            node["truncated"] = True
                            break
                        if type(key) is str:
                            node["fields"][key[:1000]] = encode(item, depth + 1)
                else:
                    node["opaque"] = True
            return {"kind": "ref", "id": ref}

        stack = []
        if len(frames) > 32:
            raise TraceLimit("stack_depth", 32)
        for index, frame in enumerate(frames):
            bindings = {}
            for name, value in frame.f_locals.copy().items():
                if name.startswith("__"):
                    continue
                if len(bindings) >= 40:
                    truncated.append("locals")
                    break
                bindings[name] = encode(value)
            stack.append({"depth": index, "function": frame.f_code.co_name,
                          "line": frame.f_lineno, "locals": bindings})
        detail = encode(extra) if extra is not None else None
        return stack, heap, detail, sorted(set(truncated))


def _delta(old, new):
    """`new` as a change to `old` (an earlier variant of the same object): changed top-level fields in "set", and items
    appended at the end in "append". None when the two differ in more than that (the full node is stored instead).
    Lists show at most 40 items, so most of a long run is a list whose items are unchanged and only `length` moves."""
    if old.keys() != new.keys():
        return None
    delta = {}
    changed = {k: new[k] for k in new if k != "items" and old[k] != new[k]}
    if changed:
        delta["set"] = changed
    a, b = old.get("items"), new.get("items")
    if isinstance(a, list) and isinstance(b, list) and a != b:
        if len(b) <= len(a) or b[:len(a)] != a:
            return None
        delta["append"] = b[len(a):]
    elif "items" in new and a != b:
        return None
    return delta or None


def run(root):
    # Best effort Unix limits. Windows relies on the parent's wall timeout.
    resource_limits = False
    req = json.loads((root / "request.json").read_text(encoding="utf-8"))
    try:
        import resource
        # CPU backstop: a bit above the wall-clock limit, so the parent's timeout decides first.
        cpu = max(3, int(req.get("cpu_seconds", 3)))
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024**2, 256 * 1024**2))
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024**2, 16 * 1024**2))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource_limits = True
    except (ImportError, ValueError, OSError):
        pass
    stdout = BoundedOutput(req["max_output"])
    stderr = BoundedOutput(req["max_output"])
    sys.stdin = io.StringIO(req["stdin"])
    sys.stdout, sys.stderr = stdout, stderr
    encoder = Encoder()
    pooled = bool(req.get("pooled"))
    node_ids, frame_ids, out_len = {}, {}, {"stdout": ("", 0), "stderr": ("", 0)}
    last_node, used_delta = {}, False
    count = 0
    status = "ok"
    error = None
    limit_hit = None
    # Pooled output (node-pool/2, see frontend/src/parseTrace.ts): each distinct heap node and frame list is written once
    # to its own file; an event refers to them by position. Output text is appended as it grows; an event stores its length.
    side = {}
    if pooled:
        for name in ("nodes", "frames", "stdout", "stderr"):
            side[name] = (root / (name + ".txt")).open("w", encoding="utf-8", errors="surrogatepass", newline="", buffering=1)

    def u16(key, text):
        # Lengths are in UTF-16 units because that is what the viewer's string slice counts.
        last, n = out_len[key]
        if text == last:
            return n
        n = len(text) if text.isascii() else len(text.encode("utf-16-le")) // 2
        side[key].write(text[len(last):] if text.startswith(last) else "")
        out_len[key] = (text, n)
        return n

    with (root / "events.jsonl").open("w", encoding="utf-8", buffering=1) as stream:
        def trace(frame, event, arg):
            nonlocal count, used_delta
            if frame.f_code.co_filename != FILENAME:
                return None
            if event not in ("line", "call", "return", "exception"):
                return trace
            if count >= req["max_events"]:
                raise TraceLimit("events", req["max_events"])
            frames = []
            cursor = frame
            while cursor:
                if cursor.f_code.co_filename == FILENAME:
                    frames.append(cursor)
                cursor = cursor.f_back
            stack, heap, result, truncated = encoder.snapshot(
                list(reversed(frames)), arg if event == "return" else None)
            try:
                if pooled:
                    links = {}
                    for oid, node in heap.items():
                        text = _ENCODE(node)
                        i = node_ids.get(text)
                        if i is None:
                            i = node_ids[text] = len(node_ids)
                            # An object that only changed a few fields (or grew a list) since its last variant is stored as that variant plus the change.
                            before = last_node.get(oid)
                            delta = _delta(before[1], node) if before is not None else None
                            if delta is not None:
                                side["nodes"].write('{"delta_of":%d,%s}\n' % (before[0], _ENCODE(delta)[1:-1]))
                                used_delta = True
                            else:
                                side["nodes"].write(text + "\n")
                        last_node[oid] = (node_ids[text], node)
                        links[oid] = i
                    ftext = _ENCODE(stack)
                    fi = frame_ids.get(ftext)
                    if fi is None:
                        fi = frame_ids[ftext] = len(frame_ids)
                        side["frames"].write(ftext + "\n")
                    record = {"step": count, "event": event, "line": frame.f_lineno,
                              "frames": fi, "heap": links, "stdout": u16("stdout", stdout.getvalue()),
                              "stderr": u16("stderr", stderr.getvalue()), "truncated": truncated}
                else:
                    record = {"step": count, "event": event, "line": frame.f_lineno,
                              "frames": stack, "heap": heap, "stdout": stdout.getvalue(),
                              "stderr": stderr.getvalue(), "truncated": truncated}
                if event == "return":
                    record["return_value"] = result or {"kind": "scalar", "type": "NoneType", "value": None}
                if event == "exception":
                    record["exception_type"] = arg[0].__name__
                stream.write(_ENCODE(record) + "\n")
            except OSError as exc:
                # The recording file reached its size limit (RLIMIT_FSIZE). Python ignores SIGXFSZ, so without this the
                # error would reach the user's program as an OSError and be reported as a bug in their code.
                if exc.errno == errno.EFBIG:
                    raise TraceLimit("recording_size", 16 * 1024 * 1024)
                raise
            count += 1
            return trace
        try:
            code = compile(req["source"], FILENAME, "exec")
            # Explicitly reject constructs whose scheduling this starter cannot model.
            import ast
            tree = ast.parse(req["source"])
            if any(isinstance(node, (ast.Yield, ast.YieldFrom, ast.Await, ast.AsyncFunctionDef, ast.AsyncFor, ast.AsyncWith, ast.GeneratorExp)) for node in ast.walk(tree)):
                status = "unsupported"
            else:
                sys.settrace(trace)
                exec(code, {"__name__": "__main__"})
        except TraceLimit as hit:
            status = "trace_limit"
            limit_hit = {"kind": hit.which, "limit": hit.limit}
        except OutputLimit:
            status = "output_limit"
            limit_hit = {"kind": "output_chars", "limit": req["max_output"]}
        except BaseException as exc:
            status = "error"
            error = {"type": type(exc).__name__}
            if isinstance(exc, MemoryError):
                limit_hit = {"kind": "memory", "limit": 256 * 1024 * 1024}
            if isinstance(exc, SyntaxError):
                error["line"] = exc.lineno
        finally:
            sys.settrace(None)
    for f in side.values():
        f.close()
    if pooled and used_delta:
        (root / "deltas.flag").write_text("1")
    final = {"status": status, "complete": status in ("ok", "error"),
             "stdout": stdout.getvalue(), "stderr": stderr.getvalue(),
             "resource_limits_applied": resource_limits}
    if limit_hit:
        final["limit_hit"] = limit_hit
    if error:
        final["error"] = error
    (root / "final.json").write_text(json.dumps(final, ensure_ascii=True), encoding="utf-8")


if __name__ == "__main__":
    run(Path(sys.argv[1]))
