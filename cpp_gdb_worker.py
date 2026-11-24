"""M5 C++ tracer, the part that runs INSIDE gdb. Internal protocol; use cpp_trace.py to launch it.

Start it with:  gdb -nx -batch -q -x cpp_gdb_worker.py   (CODEVIZ_DIR names a folder holding request.json)

What it does: runs the compiled program one source line at a time with gdb's `step`, and after
every line writes one snapshot (stack frames, variables, reachable objects) as a JSON line.
Snapshots use the same shape as the Python tracer (TRACE_FORMAT.md, codeviz.trace/1.0).

What it does NOT do: judge whether the program is correct. Memory errors are found by a second,
separate run (see cpp_trace.py). Every number in a snapshot is read from the stopped program.
"""
import bisect
import json
import math
import os
import re
import sys
import time

import gdb  # only importable inside gdb

D = os.environ["CODEVIZ_DIR"]
REQ = json.load(open(os.path.join(D, "request.json"), encoding="utf-8"))
SRC = os.path.realpath(REQ["source_path"])
MAX_EVENTS = REQ["max_events"]
MAX_OUT = REQ["max_output"]
MAX_FRAMES, MAX_NODES, MAX_DEPTH, MAX_ITEMS, MAX_LOCALS = 32, 300, 64, 40, 40
FATAL = {"SIGSEGV", "SIGABRT", "SIGFPE", "SIGBUS", "SIGILL", "SIGTERM", "SIGXCPU", "SIGXFSZ", "SIGPIPE", "SIGSYS", "SIGTRAP"}

EVENTS = open(os.path.join(D, "events.jsonl"), "w", encoding="utf-8")


class Stop(Exception):
    """Ends the run with a final status."""
    def __init__(self, status, **extra):
        self.status, self.extra = status, extra


# ---------------------------------------------------------------- memory map and allocation table
class Maps:
    """Classifies an address as stack, heap, global or unknown from /proc/<pid>/maps."""
    def __init__(self):
        self.rows = []
        self.pid = None

    def refresh(self):
        pid = gdb.selected_inferior().pid
        rows = []
        try:
            for line in open(f"/proc/{pid}/maps"):
                parts = line.split(None, 5)
                lo, hi = (int(x, 16) for x in parts[0].split("-"))
                rows.append((lo, hi, parts[1], parts[5].strip() if len(parts) > 5 else ""))
        except OSError:
            pass
        self.rows = rows

    def kind(self, addr):
        for attempt in (0, 1):
            for lo, hi, perms, name in self.rows:
                if lo <= addr < hi:
                    if name == "[stack]":
                        return "stack"
                    if name == "[heap]":
                        return "heap"
                    if "w" in perms and name == "":
                        return "heap"  # big malloc blocks live in anonymous mappings
                    if "w" in perms:
                        return "global"
                    return "unknown"
            if attempt == 0:
                self.refresh()
        return "unknown"


class Allocs:
    """Every block handed out by operator new / new[] / malloc after main started.

    A block is only marked freed when the program really called the matching deallocator, so
    "freed" is observed, never guessed from reachability.
    """
    def __init__(self):
        self.by_start = {}
        self.starts = []
        self.serial = 0

    def add(self, start, size, kind):
        if start == 0:
            return
        # A new block replaces any older (freed) block it overlaps.
        i = bisect.bisect_left(self.starts, start)
        while i < len(self.starts) and self.starts[i] < start + max(size, 1):
            self.by_start.pop(self.starts[i], None)
            del self.starts[i]
        j = bisect.bisect_right(self.starts, start) - 1
        if j >= 0:
            prev = self.by_start[self.starts[j]]
            if self.starts[j] + prev["size"] > start:
                self.by_start.pop(self.starts[j], None)
                del self.starts[j]
        self.serial += 1
        self.by_start[start] = {"start": start, "size": size, "kind": kind, "serial": self.serial, "freed": False}
        bisect.insort(self.starts, start)

    def free(self, start):
        rec = self.by_start.get(start)
        if rec is not None:
            rec["freed"] = True

    def find(self, addr):
        i = bisect.bisect_right(self.starts, addr) - 1
        if i < 0:
            return None
        rec = self.by_start[self.starts[i]]
        return rec if addr < rec["start"] + max(rec["size"], 1) else None


MAPS, ALLOCS = Maps(), Allocs()
TRACKING = {"on": False}


def reg(name):
    return int(gdb.selected_frame().read_register(name).cast(gdb.lookup_type("unsigned long")))


def caller_has_source():
    older = gdb.newest_frame().older()
    return older is not None and older.find_sal().symtab is not None


class AllocBreak(gdb.Breakpoint):
    """Watches an allocator or deallocator. Never stops the program."""
    def __init__(self, spec, role, kind):
        super().__init__(spec, internal=True)
        self.role, self.kind = role, kind
        self.silent = True

    def stop(self):
        try:
            if not TRACKING["on"]:
                return False
            if self.role == "free":
                if self.kind == "c" and not caller_has_source():
                    return False
                ALLOCS.free(reg("rdi"))
                return False
            if self.kind == "c" and not caller_has_source():
                return False
            size = reg("rdi")
            if self.role == "calloc":
                size = reg("rdi") * reg("rsi")
            AllocDone(gdb.newest_frame(), size, "array" if self.kind == "array" else "single")
        except gdb.error:
            pass
        return False


class AllocDone(gdb.FinishBreakpoint):
    def __init__(self, frame, size, kind):
        super().__init__(frame, internal=True)
        self.size, self.kind = size, kind

    def stop(self):
        try:
            ALLOCS.add(reg("rax"), self.size, self.kind)
        except gdb.error:
            pass
        return False

    def out_of_scope(self):
        pass


# ---------------------------------------------------------------- value encoding
_ALLOC = re.compile(r",\s*std::allocator<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*")


def pretty(name):
    """Shorten the very long names gdb gives to standard library types."""
    name = name.replace("std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >", "std::string")
    name = name.replace("std::__cxx11::", "std::")
    for _ in range(4):
        name = _ALLOC.sub("", name)
    return name.replace("> >", ">>")


def printer_for(val):
    try:
        return gdb.default_visualizer(val)
    except gdb.error:
        return None


class Encoder:
    def __init__(self):
        self.ids = {}          # identity key -> "oN"
        self.next_id = 0
        self.sps = []

    def owner(self, addr):
        """(index, epoch) of the call-stack frame whose locals contain addr, so a reused stack slot gets a new ID."""
        for i in range(len(self.sps) - 1, -1, -1):          # innermost frame first
            upper = self.sps[i - 1] if i > 0 else 1 << 64
            if self.sps[i] <= addr < upper:
                return i, ACT.get(i, 0)
        return -1, 0

    def snapshot(self, frames, ret=None):
        self.heap, self.truncated, self.queue = {}, [], []
        self.node_count = 0
        self.returned = None
        out = []
        for depth, (name, line, bindings) in enumerate(frames):
            local = {}
            for i, (n, v) in enumerate(bindings):
                if i >= MAX_LOCALS:
                    self.truncated.append("locals")
                    break
                local[n] = self.value(v, 0)
            out.append({"depth": depth, "function": name, "line": line, "locals": local})
        if ret is not None:
            self.returned = ret()  # encoded now so any object it points to lands in this snapshot's heap
        while self.queue:
            nid, val, info, depth = self.queue.pop(0)
            self.expand(nid, val, info, depth)
        return out

    # -- scalars and pointers
    def value(self, v, depth):
        try:
            return self._value(v, depth)
        except gdb.MemoryError:
            return {"kind": "opaque", "type": "unreadable memory"}
        except gdb.error as exc:
            return {"kind": "opaque", "type": "unreadable (" + str(exc)[:60] + ")"}

    def _value(self, v, depth):
        t = v.type.strip_typedefs()
        code = t.code
        tname = pretty(str(v.type.unqualified()))
        if code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF:
            return self.pointee(v.referenced_value().address, v.referenced_value(), tname, depth, is_ref=True)
        if code == gdb.TYPE_CODE_BOOL:
            return {"kind": "scalar", "type": "bool", "value": bool(v)}
        if code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR):
            n = int(v)
            base = str(t.unqualified())
            if base in ("char", "signed char", "unsigned char", "char16_t", "char32_t", "wchar_t"):
                if 32 <= n < 127:
                    return {"kind": "scalar", "type": tname, "value": chr(n)}
                return {"kind": "scalar", "type": tname, "value": n}
            if t.sizeof > 8 and abs(n).bit_length() > 4096:
                self.truncated.append("integer")
                return {"kind": "truncated", "type": tname}
            return {"kind": "scalar", "type": tname, "value": n}
        if code == gdb.TYPE_CODE_FLT:
            f = float(v)
            return {"kind": "scalar", "type": tname, "value": f if math.isfinite(f) else str(f)}
        if code == gdb.TYPE_CODE_ENUM:
            return {"kind": "scalar", "type": tname, "value": str(v)}
        if code == gdb.TYPE_CODE_PTR:
            return self.pointer(v, t, tname, depth)
        if code == gdb.TYPE_CODE_STRUCT and tname == "std::string":
            text = v.format_string(max_elements=200)
            if text.startswith('"'):
                end = text.rfind('"')
                body = text[1:end] if end > 0 else text[1:]
                return {"kind": "scalar", "type": "std::string", "value": body.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\"),
                        "truncated": text.endswith("...")}
        if code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION, gdb.TYPE_CODE_ARRAY):
            if v.address is None:
                return {"kind": "opaque", "type": tname}
            return self.pointee(v.address, v, tname, depth)
        if code in (gdb.TYPE_CODE_FUNC, gdb.TYPE_CODE_METHOD):
            return {"kind": "opaque", "type": tname}
        return {"kind": "opaque", "type": tname}

    def pointer(self, v, t, tname, depth):
        addr = int(v.cast(gdb.lookup_type("unsigned long")))
        if addr == 0:
            return {"kind": "scalar", "type": tname, "value": None}
        target = t.target().strip_typedefs()
        tcode = target.code
        if tcode == gdb.TYPE_CODE_INT and str(target.unqualified()) == "char":
            try:
                text = v.string(length=200, errors="replace")
                more = False
                try:
                    more = v.string(length=201, errors="replace") != text
                except gdb.error:
                    pass
                return {"kind": "scalar", "type": tname, "value": text, "truncated": more}
            except gdb.error:
                return {"kind": "opaque", "type": tname + " (unreadable string)"}
        if tcode in (gdb.TYPE_CODE_VOID, gdb.TYPE_CODE_FUNC, gdb.TYPE_CODE_METHOD):
            return {"kind": "scalar", "type": tname, "value": hex(addr)}
        rec = ALLOCS.find(addr)
        if rec is not None and rec["freed"]:
            return self.freed(rec, addr, target, tname)
        if str(target).startswith("std::"):
            return {"kind": "opaque", "type": tname}
        return self.pointee(addr, v.dereference(), tname, depth, ptr_target=target)

    def freed(self, rec, addr, target, tname):
        key = ("f", rec["serial"], addr - rec["start"], str(target))
        nid = self.ids.get(key)
        if nid is None:
            self.next_id += 1
            nid = self.ids[key] = f"o{self.next_id}"
        self.heap[nid] = {"type": str(target.unqualified()), "opaque": True, "freed": True, "storage": "heap",
                          "address": hex(addr)}
        return {"kind": "ref", "id": nid}

    def pointee(self, addr, val, tname, depth, ptr_target=None, is_ref=False):
        addr = int(addr.cast(gdb.lookup_type("unsigned long"))) if isinstance(addr, gdb.Value) else int(addr)
        """Return a ref to the object at addr, queueing the object for expansion."""
        t = val.type.strip_typedefs()
        storage = MAPS.kind(addr)
        rec = ALLOCS.find(addr) if storage != "stack" else None
        count = None
        if rec is not None and not rec["freed"] and ptr_target is not None:
            size = t.sizeof or 1
            avail = rec["start"] + rec["size"] - addr
            if (rec["kind"] == "array" or avail >= 2 * size) and avail // size >= 1 and t.code != gdb.TYPE_CODE_ARRAY:
                n = avail // size
                if rec["kind"] == "array" or n > 1:
                    count = n
            storage = "heap"
            key = ("h", rec["serial"], addr - rec["start"], str(t))
        elif storage == "stack":
            key = ("s", self.owner(addr), addr, str(t))
        else:
            key = (storage[0], addr, str(t))
        nid = self.ids.get(key)
        if nid is None:
            self.next_id += 1
            nid = self.ids[key] = f"o{self.next_id}"
        if nid in self.heap:
            return {"kind": "ref", "id": nid}
        if self.node_count >= MAX_NODES:
            if "nodes" not in self.truncated:
                self.truncated.append("nodes")
            return {"kind": "truncated", "type": "nodes"}
        if depth >= MAX_DEPTH:
            if "depth" not in self.truncated:
                self.truncated.append("depth")
            return {"kind": "truncated", "type": "depth"}
        self.node_count += 1
        self.heap[nid] = {"type": pretty(str(t.unqualified())), "storage": storage, "address": hex(addr)}  # filled by expand
        self.queue.append((nid, val, {"count": count, "storage": storage}, depth + 1))
        return {"kind": "ref", "id": nid}

    # -- objects
    def expand(self, nid, val, info, depth):
        node = self.heap[nid]
        try:
            t = val.type.strip_typedefs()
            code = t.code
            tname = pretty(str(t.unqualified()))
            if tname.startswith("std::vector<") and printer_for(val) is not None:
                # experimental: elements come from libstdc++'s own gdb printer
                children = []
                for i, (_, child) in enumerate(printer_for(val).children()):
                    if i >= MAX_ITEMS:
                        node["truncated"] = True
                        self.truncated.append("items")
                        break
                    children.append(child)
                node["type"], node["element_type"] = "std::vector", tname[len("std::vector<"):-1]
                node["items"] = [self.value(c, depth) for c in children]
                node["length"] = len(children) if not node.get("truncated") else len(children) + 1
                return
            if info["count"]:                              # new T[n] / malloc(n * sizeof(T))
                node["type"], node["element_type"] = "array", tname
                n = info["count"]
                node["length"] = n
                items = []
                base = val.address
                for i in range(min(n, MAX_ITEMS)):
                    items.append(self.value((base + i).dereference(), depth))
                node["items"] = items
                if n > MAX_ITEMS:
                    node["truncated"] = True
                    self.truncated.append("items")
            elif code == gdb.TYPE_CODE_ARRAY:
                lo, hi = t.range()
                n = hi - lo + 1
                node["type"], node["element_type"] = "array", str(t.target().unqualified())
                node["length"] = n
                node["items"] = [self.value(val[lo + i], depth) for i in range(min(n, MAX_ITEMS))]
                if n > MAX_ITEMS:
                    node["truncated"] = True
                    self.truncated.append("items")
            elif code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
                if tname.startswith("std::"):
                    node["opaque"] = True
                    return
                node["fields"] = {}
                self.add_fields(node, val, t, depth, prefix="")
            else:                                           # a lone int, double, pointer...
                node["fields"] = {"value": self.value(val, depth)}
        except gdb.MemoryError:
            node["opaque"] = True
            node.pop("fields", None)
            node.pop("items", None)
        except gdb.error:
            node["opaque"] = True
            node.pop("fields", None)
            node.pop("items", None)

    def add_fields(self, node, val, t, depth, prefix):
        for f in t.fields():
            if getattr(f, "bitpos", None) is None and not f.is_base_class:
                continue  # static member
            if f.is_base_class:
                self.add_fields(node, val[f], f.type.strip_typedefs(), depth, prefix)
                continue
            name = f.name or ""
            if name.startswith("_vptr"):
                continue
            if len(node["fields"]) >= MAX_ITEMS:
                node["truncated"] = True
                self.truncated.append("fields")
                return
            node["fields"][prefix + name] = self.value(val[f], depth)


ENC = Encoder()


# ---------------------------------------------------------------- frames
_closing = {}


def closing_line(frame):
    """Line of the function's final `}`: the last line in the function's line table."""
    block = frame.block()
    while block is not None and block.function is None:
        block = block.superblock
    if block is None:
        return None
    key = block.start
    if key not in _closing:
        lines = [e.line for e in frame.find_sal().symtab.linetable() if block.start <= e.pc < block.end and e.line]
        _closing[key] = max(lines) if lines else None
    return _closing[key]


def is_user(frame):
    sal = frame.find_sal()
    return sal.symtab is not None and os.path.realpath(sal.symtab.fullname()) == SRC


def user_frames():
    """Innermost-first list of gdb frames that belong to the user's file, or None when over the cap."""
    out, f = [], gdb.newest_frame()
    guard = 0
    while f is not None:
        guard += 1
        if guard > 4096:
            raise Stop("trace_limit", limit="frames")
        if is_user(f):
            out.append(f)
            if len(out) > MAX_FRAMES:
                raise Stop("trace_limit", limit="frames")
        f = f.older()
    return out


def frame_bindings(frame, visited):
    """Locals in scope at this frame's line. A variable declared on the current line only counts once the
    line has been visited before in this call (a `for` header coming round again); the first time, it is not set yet."""
    line = frame.find_sal().line
    seen, out, decl = set(), [], []
    block = frame.block()
    while block is not None and not (block.is_global or block.is_static):
        for sym in block:
            if not (sym.is_variable or sym.is_argument):
                continue
            n = sym.print_name
            if n in seen or n.startswith("__"):
                continue
            if sym.is_variable and sym.line and sym.addr_class != gdb.SYMBOL_LOC_STATIC and (
                    sym.line > line or (sym.line == line and line not in visited)):
                continue  # declared further down: its memory is not initialised yet
            seen.add(n)
            decl.append((n, sym))
            try:
                out.append((n, frame.read_var(sym)))
            except gdb.error:
                out.append((n, None))
        if block.function is not None:
            break
        block = block.superblock
    order = {n: (0 if s.is_argument else 1, s.line) for n, s in decl}
    out.sort(key=lambda kv: order.get(kv[0], (2, 0)))
    return out


def short_name(name):
    depth = 0
    for i in range(len(name) - 1, -1, -1):  # drop the trailing "(args)" that gdb adds to C++ names
        if name[i] == ")":
            depth += 1
        elif name[i] == "(":
            depth -= 1
            if depth == 0:
                return name[:i]
    return name


def global_bindings(frame):
    out = []
    try:
        blk0 = frame.block()
        for blk in (blk0.static_block, blk0.global_block):
            for sym in blk:
                if sym.is_variable and sym.symtab is not None and os.path.realpath(sym.symtab.fullname()) == SRC:
                    out.append((sym.print_name, sym.value()))
    except (gdb.error, RuntimeError):
        pass
    return out


def capture_state(chain, ret=None):
    """chain: user frames, innermost first. Returns the frames list, heap, truncated for one snapshot."""
    ordered = list(reversed(chain))
    ENC.sps = [int(f.read_register("rsp").cast(gdb.lookup_type("unsigned long"))) for f in ordered]
    specs = []
    globs = global_bindings(ordered[0])
    if globs:
        specs.append(("<globals>", ordered[0].find_sal().line if False else GLOBALS_LINE[0], globs))
    for f in ordered:
        fn = f.function()
        specs.append((short_name(fn.print_name if fn is not None else "??"), f.find_sal().line, frame_bindings(f, VISITED.get(len(specs) - (1 if globs else 0), set()))))
    # The binding values were read lazily; encode now, while the program is stopped.
    specs = [(n, ln, [(k, v) for k, v in b if v is not None]) for n, ln, b in specs]
    return ENC.snapshot(specs, ret)


GLOBALS_LINE = [1]
ACT = {}       # call-stack index -> number of activations seen there (a new call bumps it)
VISITED = {}   # call-stack index -> lines already executed in that activation

# ---------------------------------------------------------------- output files
class Streams:
    def __init__(self):
        self.pos = {"stdout": 0, "stderr": 0}
        self.text = {"stdout": "", "stderr": ""}

    def poll(self):
        for name in ("stdout", "stderr"):
            try:
                with open(os.path.join(D, name + ".txt"), "rb") as fh:
                    fh.seek(self.pos[name])
                    data = fh.read(MAX_OUT * 4 + 1)
            except OSError:
                continue
            self.pos[name] += len(data)
            self.text[name] += data.decode("utf-8", "replace")
            if len(self.text[name]) > MAX_OUT:
                self.text[name] = self.text[name][:MAX_OUT]
                raise Stop("output_limit")


OUT = Streams()
STATE = {"step": 0, "stop": None, "exited": None, "throw": None, "epoch": {}}


def on_stop(ev):
    STATE["stop"] = ev


def on_exit(ev):
    STATE["exited"] = ev


gdb.events.stop.connect(on_stop)
gdb.events.exited.connect(on_exit)


def alive():
    try:
        return gdb.selected_inferior().pid != 0 and STATE["exited"] is None
    except gdb.error:
        return False


def emit(kind, chain, extra=None, ret=None):
    OUT.poll()
    frames = capture_state(chain, ret)
    ev = {"step": STATE["step"], "event": kind, "line": frames[-1]["line"], "frames": frames,
          "heap": ENC.heap, "stdout": OUT.text["stdout"], "stderr": OUT.text["stderr"],
          "truncated": sorted(set(ENC.truncated))}
    if extra:
        ev.update(extra)
    if ret is not None:
        ev["return_value"] = ENC.returned
    EVENTS.write(json.dumps(ev, ensure_ascii=True, allow_nan=False) + "\n")
    EVENTS.flush()
    STATE["step"] += 1
    if STATE["step"] >= MAX_EVENTS:
        raise Stop("trace_limit", limit="events")


def return_value(frame):
    """Best-effort return value, read from the ABI return register at the closing brace."""
    fn = frame.function()
    try:
        rtype = fn.type.target().strip_typedefs()
    except gdb.error:
        return {"kind": "opaque", "type": "unknown return type"}
    code = rtype.code
    name = str(rtype.unqualified())
    if code == gdb.TYPE_CODE_VOID:
        return {"kind": "scalar", "type": "void", "value": None}
    try:
        if code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_ENUM, gdb.TYPE_CODE_CHAR) and rtype.sizeof <= 8:
            raw = int(frame.read_register("rax").cast(gdb.lookup_type("unsigned long")))
            bits = rtype.sizeof * 8
            raw &= (1 << bits) - 1
            if code == gdb.TYPE_CODE_BOOL:
                return {"kind": "scalar", "type": "bool", "value": bool(raw)}
            if rtype.is_signed if hasattr(rtype, "is_signed") else name in ("int", "long", "short", "signed char", "long long"):
                if raw >= 1 << (bits - 1):
                    raw -= 1 << bits
            return {"kind": "scalar", "type": name, "value": raw}
        if code == gdb.TYPE_CODE_FLT and rtype.sizeof in (4, 8):
            x = frame.read_register("xmm0")
            f = float(x["v4_float"][0]) if rtype.sizeof == 4 else float(x["v2_double"][0])
            return {"kind": "scalar", "type": name, "value": f if math.isfinite(f) else str(f)}
        if code == gdb.TYPE_CODE_PTR:
            raw = int(frame.read_register("rax").cast(gdb.lookup_type("unsigned long")))
            if raw == 0:
                return {"kind": "scalar", "type": name, "value": None}
            v = gdb.Value(raw).cast(rtype)
            return ENC.value(v, 0)
    except gdb.error:
        pass
    return {"kind": "opaque", "type": name + " (return value not captured)"}


# ---------------------------------------------------------------- the run
def finish(status, **extra):
    OUT.poll() if status != "output_limit" else None
    result = {"status": status, "complete": status in ("ok", "error"),
              "stdout": OUT.text["stdout"], "stderr": OUT.text["stderr"]}
    result.update(extra)
    with open(os.path.join(D, "final.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=True, allow_nan=False)
    try:
        gdb.execute("kill", to_string=True)
    except gdb.error:
        pass
    gdb.execute("quit")


def signal_name(ev):
    return getattr(ev, "stop_signal", None) if isinstance(ev, gdb.SignalEvent) else None


def thrown_type():
    try:
        out = gdb.execute("info symbol $rsi", to_string=True)
        m = re.match(r"typeinfo for (.+?)(?:@\S+)?(?: in section|$)", out.strip())
        if m:
            return m.group(1).strip()
    except gdb.error:
        pass
    return "C++ exception"


def resume(command):
    """Run one gdb command and return the stop event it produced (None when the program exited)."""
    STATE["stop"] = None
    try:
        gdb.execute(command, to_string=True)
    except gdb.error:
        if alive():
            raise
    return STATE["stop"]


def safe_chain():
    try:
        return user_frames()
    except (gdb.error, RuntimeError):
        return []


def handle_catchpoints(ev):
    """Follow C++ throw/catch stops until the program is at an ordinary line stop, a signal, or the end."""
    while alive() and isinstance(ev, gdb.BreakpointEvent):
        try:
            name = gdb.newest_frame().name()
        except gdb.error:
            name = None
        if name == "__cxa_throw":
            kind = thrown_type()
            STATE["throw"] = kind
            chain = safe_chain()
            if chain:
                emit("exception", chain, {"exception_type": kind})
            ev = resume("continue")
        elif name == "__cxa_begin_catch":
            older = gdb.newest_frame().older()
            if older is not None and is_user(older):
                ev = resume("step")     # a real handler in the user's code: go to its first line
                if isinstance(ev, gdb.BreakpointEvent):
                    continue
                return ev
            ev = resume("continue")     # std::terminate's own handler: not a catch in user code
        else:
            ev = resume("continue")
    return ev


def run():
    try:
        gdb.execute("set pagination off")
        gdb.execute("set confirm off")
        gdb.execute("set width 0")
        gdb.execute("set breakpoint pending off")
        gdb.execute("set print thread-events off")
        gdb.execute("set step-mode off")
        gdb.execute("set auto-load safe-path /usr/share/gdb/auto-load:/usr/share/gcc:/usr/lib")
        gdb.execute("set auto-load scripts-directory $debugdir:$datadir/auto-load:/usr/share/gdb/auto-load")
        main_bp = gdb.Breakpoint("main", internal=True)
        resume("run < %s > %s 2> %s" % (os.path.join(D, "stdin.txt"), os.path.join(D, "stdout.txt"),
                                          os.path.join(D, "stderr.txt")))
        if not alive():
            finish("worker_error", error={"type": "ProgramDidNotStart"})
        main_bp.delete()
        MAPS.refresh()
        fn = gdb.lookup_global_symbol("main")
        GLOBALS_LINE[0] = fn.line if fn is not None else 1
        for spec, role, kind in (("*_Znwm", "new", "single"), ("*_Znam", "new", "array"),
                                 ("*_ZdlPv", "free", "single"), ("*_ZdlPvm", "free", "single"),
                                 ("*_ZdaPv", "free", "array"), ("*_ZdaPvm", "free", "array"),
                                 ("*malloc", "new", "c"), ("*calloc", "calloc", "c"), ("*free", "free", "c")):
            try:
                AllocBreak(spec, role, kind)
            except gdb.error:
                pass
        for ex in ("catch throw", "catch catch"):
            try:
                gdb.execute(ex, to_string=True)
            except gdb.error:
                pass
        TRACKING["on"] = True

        chain = safe_chain()
        if not chain:
            finish("worker_error", error={"type": "NoUserFrame"})
        prev, dead = list(reversed(chain)), None
        emit("call", chain)  # the program is stopped at main's first line, before it runs
        VISITED[len(chain) - 1] = {chain[0].find_sal().line}
        ACT[len(chain) - 1] = 1
        ev = None
        while True:
            ev = resume("step")
            ev = handle_catchpoints(ev)
            sig = signal_name(ev)
            if sig == "SIGINT":
                # cpp_trace.py interrupts a program that stays inside one source line for too long
                # (for example `while (true) i++;`). gdb's `step` cannot tell us more than the line.
                chain = safe_chain()
                extra = {"stuck_line": chain[0].find_sal().line} if chain and chain[0].find_sal().line else {}
                finish("timeout", **extra)
            if sig is not None:
                chain = safe_chain()
                if sig == "SIGABRT" and STATE["throw"]:
                    name = STATE["throw"]          # std::terminate after an uncaught throw
                else:
                    name = sig
                    if chain:
                        emit("exception", chain, {"exception_type": name})
                OUT.poll()
                err = {"type": name}
                if chain and chain[0].find_sal().line:
                    err["line"] = chain[0].find_sal().line
                finish("error", error=err, signal=sig)
            if not alive():
                break
            chain = safe_chain()
            if not chain:
                # Stepped out of main into the C runtime: let the program finish.
                ev = handle_catchpoints(resume("continue"))
                sig = signal_name(ev)
                if sig:
                    c2 = safe_chain()
                    if c2:
                        emit("exception", c2, {"exception_type": sig})
                    finish("error", error={"type": sig}, signal=sig)
                if not alive():
                    break
                continue
            if not is_user(gdb.newest_frame()):
                # step landed in header code that has debug info (templates): run back out to our file
                guard = 0
                while alive() and not is_user(gdb.newest_frame()) and guard < 200:
                    guard += 1
                    ev = handle_catchpoints(resume("finish"))
                    if signal_name(ev):
                        break
                if signal_name(ev):
                    continue_signal = signal_name(ev)
                    c2 = safe_chain()
                    if c2:
                        emit("exception", c2, {"exception_type": continue_signal})
                    finish("error", error={"type": continue_signal}, signal=continue_signal)
                if not alive():
                    break
                chain = safe_chain()
                if not chain:
                    continue
            top = chain[0]
            cur = list(reversed(chain))             # outermost first
            line = top.find_sal().line
            # How many outer frames are the very same activations as at the previous snapshot?
            k = 0
            while k < min(len(cur), len(prev)) and cur[k] == prev[k]:
                k += 1
            if dead is not None and k > dead:
                # The activation that just returned can show up again with the same stack address
                # (a fresh call of the same function). It is the old one only while it is still at its closing line.
                still_closing = len(cur) > dead and cur[dead] == prev[dead] and line == closing_line(top)
                if not still_closing:
                    k = dead
            for stale in [d for d in VISITED if d >= k]:
                del VISITED[stale]               # activations above the shared part are new or gone
            if len(cur) > k:
                ACT[len(cur) - 1] = ACT.get(len(cur) - 1, 0) + 1
            if len(cur) > k:
                emit("call", chain)
                dead = len(cur) - 1 if line == closing_line(top) else None  # one-line function: no separate return event
            else:
                if len(cur) < len(prev):
                    # A function just returned. gdb reports the middle of the caller's line; skip that stop.
                    prev, dead = cur, None
                    if top.pc() != top.find_sal().pc:
                        continue
                if line == closing_line(top) and dead != len(cur) - 1:
                    dead = len(cur) - 1
                    emit("return", chain, None, ret=lambda: return_value(top))
                else:
                    emit("line", chain)
            VISITED.setdefault(len(cur) - 1, set()).add(line)
            prev = cur
        OUT.poll()
        ex = STATE["exited"]
        code = getattr(ex, "exit_code", None) if ex is not None else None
        extra = {"exit_code": code} if code is not None else {}
        finish("ok", **extra)
    except Stop as stop:
        finish(stop.status, **stop.extra)
    except SystemExit:
        raise
    except BaseException as exc:  # a tracer bug must show up as worker_error, not as a user error
        finish("worker_error", error={"type": type(exc).__name__}, detail=str(exc)[:300])


run()
