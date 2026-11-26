"""M5 C++ tracer, the part that runs INSIDE gdb. Internal protocol; use cpp_trace.py to launch it.

Start it with:  gdb -nx -batch -q -x cpp_gdb_worker.py   (CODEVIZ_DIR names a folder holding request.json)

What it does: runs the compiled program one source line at a time with gdb's `step`, and after
every line writes one snapshot (stack frames, variables, reachable objects) as a JSON line.
Snapshots use the same shape as the Python tracer (TRACE_FORMAT.md, codeviz.trace/1.0).

What it does NOT do: judge whether the program is correct. Memory errors are found by a second,
separate run (see cpp_trace.py). Every number in a snapshot is read from the stopped program.
"""
import errno
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
_IN_SOURCE = {}


def _in_source(symtab):
    """Is this symbol table the user's file? Cached by file name: realpath was 65% of the tracing time (it ran for every
    global and function symbol at every event, about 54,000 calls on a 278-event run)."""
    name = symtab.fullname()
    hit = _IN_SOURCE.get(name)
    if hit is None:
        hit = _IN_SOURCE[name] = os.path.realpath(name) == SRC
    return hit
MAX_EVENTS = REQ["max_events"]
MAX_OUT = REQ["max_output"]
MAX_FRAMES, MAX_NODES, MAX_DEPTH, MAX_ITEMS, MAX_LOCALS = 32, 300, 300, 40, 40
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


_PRETTY = {}


def pretty(name):
    """Shorten the very long names gdb gives to standard library types (pure function, memoized)."""
    r = _PRETTY.get(name)
    if r is None:
        r = _PRETTY[name] = _pretty(name)
    return r


def _pretty(name):
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


LIB_MAPS = {"std::map", "std::unordered_map", "std::multimap"}
LIB_SEQS = {"std::set", "std::multiset", "std::unordered_set", "std::list", "std::deque", "std::forward_list"}
KNOWN_TYPES = {}   # allocation serial -> gdb type last seen through a typed pointer


def first_template_arg(text):
    depth = 0
    for i, ch in enumerate(text):
        depth += ch == "<"
        depth -= ch == ">"
        if ch == "," and depth == 0:
            return text[:i]
    return text


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
        self.owned = set()     # live blocks that belong to a drawn library object (string/vector buffer, smart pointer control block)
        self.seen = set()      # block starts some traversed pointer pointed at, before orphan recovery
        self.node_count = 0
        self.returned = None
        out = []
        for depth, (name, line, bindings) in enumerate(frames):
            local = {}
            for i, (n, v) in enumerate(bindings):
                if i >= MAX_LOCALS:
                    self.truncated.append("locals")
                    break
                if isinstance(v, Uninitialised):     # exists, holds no value yet: shown as such, never as stack garbage
                    local[n] = {"kind": "opaque", "type": "uninitialised " + v.type_name}
                    continue
                local[n] = self.value(v, 0)
            out.append({"depth": depth, "function": name, "line": line, "locals": local})
        if ret is not None:
            self.returned = ret()  # encoded now so any object it points to lands in this snapshot's heap
        while self.queue:
            nid, val, info, depth = self.queue.pop(0)
            self.expand(nid, val, info, depth)
        self.recover_orphans()
        return out

    def raw_block(self, rec):
        """A live block no typed pointer was ever seen at: shown as its raw bytes. No type is guessed."""
        if self.node_count >= MAX_NODES:
            if "orphans" not in self.truncated:
                self.truncated.append("orphans")
            return
        key = ("h", rec["serial"], 0, "untyped")
        nid = self.ids.get(key)
        if nid is None:
            self.next_id += 1
            nid = self.ids[key] = f"o{self.next_id}"
        if nid in self.heap:
            return
        n = min(rec["size"], MAX_ITEMS)
        try:
            data = bytes(gdb.selected_inferior().read_memory(rec["start"], n))
        except gdb.error:
            return
        self.node_count += 1
        node = {"type": "untyped block", "storage": "heap", "address": hex(rec["start"]), "element_type": "byte",
                "length": rec["size"], "items": [{"kind": "scalar", "type": "byte", "value": b} for b in data]}
        if rec["size"] > n:
            node["truncated"] = True
            self.truncated.append("items")
        self.heap[nid] = node

    def own(self, val):
        """Blocks a library object (std::string, vector, smart pointer...) holds: found by looking at the object's own words."""
        try:
            a = int(val.address)
            n = min(val.type.sizeof, 128)
            data = bytes(gdb.selected_inferior().read_memory(a, n))
        except (gdb.error, TypeError, ValueError, OverflowError):
            return False
        for i in range(0, n - 7, 8):
            rec = ALLOCS.find(int.from_bytes(data[i:i + 8], "little"))
            if rec is not None and not rec["freed"]:
                self.owned.add(rec["start"])

    def vector_uninitialised(self, val, items):
        """True when a std::vector's words cannot be a constructed vector: begin <= end <= capacity-end must hold and the
        used size must be a whole number of elements. When the layout cannot be read, fall back to the evidence of the
        cells themselves: every one of them unreadable."""
        try:
            if gdb.selected_frame().architecture().name() == "i386:x86-64" and val.type.strip_typedefs().sizeof == 24:
                data = bytes(gdb.selected_inferior().read_memory(int(val.address), 24))
                b, e, c = (int.from_bytes(data[i:i + 8], "little") for i in (0, 8, 16))
                size = val.type.strip_typedefs().template_argument(0).sizeof
                if not (b <= e <= c) or (size and (e - b) % size):
                    return True
                return False
        except (gdb.error, TypeError, ValueError, OverflowError, RuntimeError):
            pass
        return bool(items) and all(i.get("kind") == "opaque" for i in items)

    def buffer_released(self, val, base):
        """True when the library object's OWN backing buffer was freed (the object was destroyed or its storage released).

        Decided from the one word libstdc++ uses to point at that storage, never from any word that merely equals a freed
        address (user data, element values and dangling user pointers live elsewhere):
          std::vector / deque / unordered_*  word 0 (_M_start / _M_map / _M_buckets); forward_list / list: word 0 (first node)
          std::set / map (red-black tree): word 2 (header._M_parent, the root)
          std::string: word 0 (_M_p) unless it points at the inline buffer inside the object."""
        # Offsets below are libstdc++ (GNU, new string ABI) on x86-64 only. Outside that, or when the object size is not the
        # expected one, make no claim (return False) rather than guess at another layout.
        expect = {"std::string": 32, "std::vector": 24, "std::deque": 80, "std::list": 24, "std::forward_list": 8,
                  "std::map": 48, "std::multimap": 48, "std::set": 48, "std::multiset": 48}
        try:
            if gdb.selected_frame().architecture().name() != "i386:x86-64":
                return False
            if val.type.strip_typedefs().sizeof != expect.get(base):
                return False
            pr = printer_for(val)       # must be libstdc++'s own pretty printer, and the string must be the new (cxx11) ABI
            if pr is None or not type(pr).__module__.startswith("libstdcxx"):
                return False
            if base == "std::string" and "__cxx11" not in str(val.type.strip_typedefs()):
                return False
            a = int(val.address)
            n = min(val.type.sizeof, 48)
            data = bytes(gdb.selected_inferior().read_memory(a, n))
        except (gdb.error, TypeError, ValueError, OverflowError):
            return False
        w = lambda k: int.from_bytes(data[8 * k:8 * k + 8], "little") if len(data) >= 8 * k + 8 else 0
        if base in ("std::map", "std::multimap", "std::set", "std::multiset"):
            p = w(2)
        else:
            p = w(0)
        if p == 0 or (base == "std::string" and p == a + 16):
            return False
        rec = ALLOCS.find(p)
        return rec is not None and rec["freed"] and rec["start"] == p

    def recover_orphans(self):
        """Live heap objects no pointer leads to any more (for example behind a freed node) are still real memory.

        A block whose type was seen earlier through a typed pointer is read again as that type and added to the heap
        flagged "orphan", so the diagram can still show it. A block never seen with a type stays uncovered and is only
        counted (unreached_heap). Freed memory is never read.
        """
        if not ALLOCS.by_start:
            return
        covered = covered_blocks(self.heap, self.owned)
        seen = set(self.seen)       # frozen: pointers met while recovering must not hide an orphan
        added = 0
        recovered = []
        for start, rec in list(ALLOCS.by_start.items()):
            if rec["freed"] or start in covered:
                continue
            if rec["serial"] not in KNOWN_TYPES:
                self.raw_block(rec)
                continue
            if self.node_count >= MAX_NODES:                 # the same budget as every other node, never silent
                if "orphans" not in self.truncated:
                    self.truncated.append("orphans")
                break
            t = KNOWN_TYPES[rec["serial"]]
            try:
                val = gdb.Value(start).cast(t.pointer()).dereference()
                ref = self.pointee(start, val, str(t), 1, ptr_target=t)
            except gdb.error:
                continue
            if ref.get("kind") == "ref" and ref["id"] in self.heap:
                recovered.append((start, ref["id"]))
                added += 1
        while self.queue:
            nid, val, info, depth = self.queue.pop(0)
            self.expand(nid, val, info, depth)
        # Orphan = not reachable from any local, any drawn object, or any block a drawn pointer pointed at. A node only
        # cut off by the depth limit is reachable: it is drawn but not called unreachable.
        recovered_ids = {rid for _, rid in recovered}
        stack = [nid for nid, node in self.heap.items() if nid not in recovered_ids]
        stack += [rid for start, rid in recovered if start in seen]
        reach = set(stack)
        while stack:
            node = self.heap.get(stack.pop(), {})
            vals = list((node.get("fields") or {}).values()) + list(node.get("items") or [])
            for v in vals:
                if isinstance(v, dict) and v.get("kind") == "ref" and v["id"] not in reach:
                    reach.add(v["id"])
                    stack.append(v["id"])
        for rid in recovered_ids:
            if rid not in reach and rid in self.heap:
                self.heap[rid]["orphan"] = True

    # -- scalars and pointers
    def value(self, v, depth):
        try:
            return self._value(v, depth)
        except gdb.MemoryError:
            return {"kind": "opaque", "type": "unreadable memory"}
        except gdb.error as exc:
            return {"kind": "opaque", "type": "unreadable (" + str(exc)[:60] + ")"}

    def _value(self, v, depth):
        # libstdc++'s printer for std::vector<bool> yields plain Python bools, because a bit in the
        # packed backing word has no addressable gdb.Value. Native scalars from printers are real
        # values, so encode them directly instead of assuming gdb.Value. (bool before int:
        # isinstance(True, int) is True.)
        if isinstance(v, bool):
            return {"kind": "scalar", "type": "bool", "value": v}
        if isinstance(v, int):
            return {"kind": "scalar", "type": "int", "value": v}
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
            if self.buffer_released(v, "std::string"):          # its heap buffer was freed: never read it
                return {"kind": "opaque", "type": "std::string (buffer released)"}
            self.own(v)
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
            rec = ALLOCS.find(addr)
            if rec is not None and not rec["freed"]:
                self.owned.add(rec["start"])
            try:
                # gdb's string(length=N) ignores NUL and always reads N bytes: read bytes ourselves and stop at the first NUL.
                inf = gdb.selected_inferior()
                raw = b""
                for chunk in (201, 64, 16, 1):
                    try:
                        raw = bytes(inf.read_memory(addr, chunk))
                        break
                    except gdb.error:
                        continue
                if not raw:
                    raise gdb.error("unreadable")
                nul = raw.find(b"\0")
                more = nul < 0 and len(raw) > 200
                text = (raw[:nul] if nul >= 0 else raw[:200]).decode("utf-8", errors="replace")
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
            self.seen.add(rec["start"])
            if t.code != gdb.TYPE_CODE_VOID and (addr == rec["start"] or count is not None):
                if rec["serial"] not in KNOWN_TYPES or addr == rec["start"]:
                    KNOWN_TYPES[rec["serial"]] = t   # remembered so the block can still be drawn if it is later orphaned
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
            if tname.startswith(("std::unique_ptr<", "std::shared_ptr<", "std::weak_ptr<")) and printer_for(val) is not None:
                self.own(val)
                for _, child in printer_for(val).children():     # the one managed pointer
                    node["fields"] = {"get()": self.value(child, depth)}
                    break
                else:
                    node["fields"] = {"get()": {"kind": "scalar", "type": "pointer", "value": None}}
                return
            base_name = tname.split("<", 1)[0]
            if base_name in LIB_MAPS | LIB_SEQS and printer_for(val) is not None:
                if self.buffer_released(val, base_name):
                    node["opaque"], node["type"] = True, tname + " (buffer released)"
                    return
                self.own(val)
                pr = printer_for(val)
                kids = []
                for i, (_, child) in enumerate(pr.children()):
                    if i >= (2 if base_name in LIB_MAPS else 1) * MAX_ITEMS:
                        node["truncated"] = True
                        self.truncated.append("items")
                        break
                    kids.append(child)
                if base_name in LIB_MAPS:
                    node["type"] = "dict"
                    node["entries"] = [[self.value(kids[i], depth), self.value(kids[i + 1], depth)] for i in range(0, len(kids) - 1, 2)]
                    node["length"] = len(node["entries"])
                else:
                    node["type"], node["element_type"] = base_name, first_template_arg(tname[len(base_name) + 1:-1])
                    node["items"] = [self.value(c, depth) for c in kids]
                    node["length"] = len(kids)
                return
            if tname.startswith("std::vector<") and printer_for(val) is not None:
                if self.buffer_released(val, "std::vector"):     # backing buffer freed: reading elements would show garbage
                    node["opaque"], node["type"] = True, tname + " (buffer released)"
                    return
                self.own(val)
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
                if self.vector_uninitialised(val, node["items"]):
                    # Not constructed yet (the stop is on its declaration line): its three pointers are stale stack bytes,
                    # and drawing the cells they happen to point at would invent contents. An empty vector is the honest picture.
                    node["items"], node["length"] = [], 0
                    node.pop("truncated", None)
                    if "items" in self.truncated:
                        self.truncated.remove("items")
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
                    self.own(val)
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
    return sal.symtab is not None and _in_source(sal.symtab)


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


class Uninitialised:
    """Stands in for a scalar local whose declaration is the current line and has not stored its value yet."""
    def __init__(self, type_name):
        self.type_name = type_name


def _stored_after_initialiser(sym, block):
    """True for a scalar declared in the function's own block: `int n = f();` stores n only after f returns, so a stop
    back on that line after the call is still before n is set. A class object (std::string, vector, a struct returned by
    value) is built in place by the call itself and is live once it returns; a variable in a nested block (a `for` header)
    is set before the body that shares its line runs. Both keep the older rule."""
    try:
        if block.function is None:
            return False
        return sym.type.strip_typedefs().code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_FLT, gdb.TYPE_CODE_PTR,
                                                  gdb.TYPE_CODE_ENUM, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_CHAR)
    except (gdb.error, RuntimeError, AttributeError):
        return False


def frame_bindings(frame, visited, run_revisit=None):
    """Locals in scope at this frame's line. A variable declared on the current line only counts once the
    line has been visited before in this call (a `for` header coming round again); the first time, it is not set yet.
    run_revisit says whether the current run of stops on this line began on a revisit. Execution that moves forward through
    one line (a call inside the initialiser returns, then the store happens) is the same run, so the variable stays unset.
    That holds only where _stored_after_initialiser says so; everything else keeps the older rule."""
    line = frame.find_sal().line
    if run_revisit is None:
        run_revisit = line in visited
    seen, out, decl = set(), [], []
    block = frame.block()
    while block is not None and not (block.is_global or block.is_static):
        for sym in block:
            if not (sym.is_variable or sym.is_argument):
                continue
            n = sym.print_name
            if n in seen or n.startswith("__"):
                continue
            if sym.is_variable and sym.line and sym.addr_class != gdb.SYMBOL_LOC_STATIC and sym.line > line:
                continue  # declared further down: not in scope yet
            if sym.is_variable and sym.line and sym.addr_class != gdb.SYMBOL_LOC_STATIC and sym.line == line:
                if _stored_after_initialiser(sym, block):
                    if not run_revisit:       # its own declaration has not stored a value yet: say so, draw no value
                        seen.add(n)
                        decl.append((n, sym))
                        out.append((n, Uninitialised(pretty(str(sym.type.unqualified())))))
                        continue
                elif line not in visited:
                    continue  # declared on this line and not set yet (a class object is live once its constructor returned)
            if sym.is_variable and sym.line and sym.addr_class != gdb.SYMBOL_LOC_STATIC and sym.line < line and visited and max(visited) < sym.line:
                continue  # an early return skipped its declaration (the stop is reported at the closing brace): never set in this call
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


def _function_block(sym):
    blk = gdb.block_for_pc(int(sym.value().address.cast(gdb.lookup_type("unsigned long"))))
    while blk is not None and blk.function is None:
        blk = blk.superblock
    return blk if blk is not None else []


def global_bindings(frame):
    out = []
    try:
        blk0 = frame.block()
        for blk in (blk0.static_block, blk0.global_block):
            for sym in blk:
                if sym.is_variable and sym.symtab is not None and _in_source(sym.symtab):
                    out.append((sym.print_name, sym.value()))
                elif sym.is_function and sym.symtab is not None and _in_source(sym.symtab):
                    # `static` variables inside functions live for the whole run, so they are roots even while the function is not running
                    try:
                        for inner in _function_block(sym):
                            if inner.is_variable and inner.addr_class == gdb.SYMBOL_LOC_STATIC:
                                out.append((sym.print_name + "::" + inner.print_name, inner.value()))
                    except (gdb.error, RuntimeError, AttributeError):
                        pass
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
        specs.append((short_name(fn.print_name if fn is not None else "??"), f.find_sal().line, frame_bindings(f, VISITED.get(len(specs) - (1 if globs else 0), set()), RUN_REVISIT.get(len(specs) - (1 if globs else 0)))))
    # The binding values were read lazily; encode now, while the program is stopped.
    specs = [(n, ln, [(k, v) for k, v in b if v is not None]) for n, ln, b in specs]
    return ENC.snapshot(specs, ret)


GLOBALS_LINE = [1]
ACT = {}       # call-stack index -> number of activations seen there (a new call bumps it)
VISITED = {}   # call-stack index -> lines already executed in that activation
RUN_REVISIT = {}   # call-stack index -> whether the current run of stops on its line began on a revisit
RUN_STATE = {}     # call-stack index -> (line, pc) of the last stop, to tell "moving forward in the same line" from a new pass

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


def covered_blocks(heap, owned=()):
    covered = set(owned)
    for node in heap.values():
        addr = node.get("address")
        if node.get("storage") == "heap" and addr:
            try:
                rec = ALLOCS.find(int(addr, 16))
            except (TypeError, ValueError):
                continue
            if rec is not None:
                covered.add(rec["start"])
    return covered


def unreached_blocks(heap, owned=()):
    """Live heap blocks the program allocated that no captured object covers.

    These are blocks the program still owns but this snapshot did not draw: memory only reachable through freed
    memory, buffers owned by library objects (std::string, std::vector contents), or anything outside the capture
    limits. It is a count, not a diagnosis, so it can only say "the diagram does not cover all live memory".
    """
    covered = covered_blocks(heap, owned)
    count = size = 0
    for start, rec in ALLOCS.by_start.items():
        if not rec["freed"] and start not in covered:
            count += 1
            size += rec["size"]
    return {"count": count, "bytes": size}


def emit(kind, chain, extra=None, ret=None):
    OUT.poll()
    frames = capture_state(chain, ret)
    ev = {"step": STATE["step"], "event": kind, "line": frames[-1]["line"], "frames": frames,
          "heap": ENC.heap, "stdout": OUT.text["stdout"], "stderr": OUT.text["stderr"],
          "truncated": sorted(set(ENC.truncated))}
    unreached = unreached_blocks(ENC.heap, ENC.owned)
    if unreached["count"]:
        ev["unreached_heap"] = unreached
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
            for stale in [d for d in list(RUN_STATE) if d >= k]:
                del RUN_STATE[stale]
                RUN_REVISIT.pop(stale, None)
            top_idx = len(cur) - 1
            try:
                top_pc = top.pc()
            except gdb.error:
                top_pc = 0
            last = RUN_STATE.get(top_idx)
            if last is None or last[0] != line or top_pc <= last[1]:
                RUN_REVISIT[top_idx] = line in VISITED.get(top_idx, set())      # a new pass over this line
            RUN_STATE[top_idx] = (line, top_pc)
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
    except OSError as exc:
        if getattr(exc, "errno", None) == errno.EFBIG:   # the recording file hit its size limit: a limit, not a tracer bug
            finish("trace_limit", limit="file")
        else:
            finish("worker_error", error={"type": type(exc).__name__}, detail=str(exc)[:300])
    except BaseException as exc:  # a tracer bug must show up as worker_error, not as a user error
        finish("worker_error", error={"type": type(exc).__name__}, detail=str(exc)[:300])


run()
