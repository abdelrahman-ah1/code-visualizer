"""Worker implementation. Internal protocol; use trace_capture.py to launch."""
import io
import json
import math
from pathlib import Path
import sys
import types

FILENAME = "<visualized>"


class TraceLimit(BaseException):
    pass


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
                if t is int and value.bit_length() > 4096:
                    truncated.append("integer")
                    return {"kind": "truncated", "type": "int"}
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
                    raise TraceLimit()
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
            raise TraceLimit()
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


def run(root):
    # Best effort Unix limits. Windows relies on the parent's wall timeout.
    resource_limits = False
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024**2, 256 * 1024**2))
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024**2, 16 * 1024**2))
        resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
        resource_limits = True
    except (ImportError, ValueError, OSError):
        pass
    req = json.loads((root / "request.json").read_text(encoding="utf-8"))
    stdout = BoundedOutput(req["max_output"])
    stderr = BoundedOutput(req["max_output"])
    sys.stdin = io.StringIO(req["stdin"])
    sys.stdout, sys.stderr = stdout, stderr
    encoder = Encoder()
    count = 0
    status = "ok"
    error = None
    with (root / "events.jsonl").open("w", encoding="utf-8", buffering=1) as stream:
        def trace(frame, event, arg):
            nonlocal count
            if frame.f_code.co_filename != FILENAME:
                return None
            if event not in ("line", "call", "return", "exception"):
                return trace
            if count >= req["max_events"]:
                raise TraceLimit()
            frames = []
            cursor = frame
            while cursor:
                if cursor.f_code.co_filename == FILENAME:
                    frames.append(cursor)
                cursor = cursor.f_back
            stack, heap, result, truncated = encoder.snapshot(
                list(reversed(frames)), arg if event == "return" else None)
            record = {"step": count, "event": event, "line": frame.f_lineno,
                      "frames": stack, "heap": heap, "stdout": stdout.getvalue(),
                      "stderr": stderr.getvalue(), "truncated": truncated}
            if event == "return":
                record["return_value"] = result or {"kind": "scalar", "type": "NoneType", "value": None}
            if event == "exception":
                record["exception_type"] = arg[0].__name__
            stream.write(json.dumps(record, ensure_ascii=True, allow_nan=False) + "\n")
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
        except TraceLimit:
            status = "trace_limit"
        except OutputLimit:
            status = "output_limit"
        except BaseException as exc:
            status = "error"
            error = {"type": type(exc).__name__}
            if isinstance(exc, SyntaxError):
                error["line"] = exc.lineno
        finally:
            sys.settrace(None)
    final = {"status": status, "complete": status in ("ok", "error"),
             "stdout": stdout.getvalue(), "stderr": stderr.getvalue(),
             "resource_limits_applied": resource_limits}
    if error:
        final["error"] = error
    (root / "final.json").write_text(json.dumps(final, ensure_ascii=True), encoding="utf-8")


if __name__ == "__main__":
    run(Path(sys.argv[1]))
