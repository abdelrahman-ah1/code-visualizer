"""M5 tests for the C++ tracer. They compile and run real programs, so they need g++ and gdb.

Run from the repository root:  python -m unittest backend.tests.test_cpp -v
Without both tools every test is skipped (and says so), never silently passed.

Each expected value below was worked out by hand from the program text, not copied from tracer output.
"""
import json
import os
import re
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import cpp_trace  # noqa: E402

PROGRAMS = Path(__file__).with_name("cpp_programs")
HAVE_TOOLS = all(cpp_trace.find_tools())


def source(name):
    return (PROGRAMS / f"{name}.cpp").read_text(encoding="utf-8")


def run(name, stdin="", timeout=5.0, max_events=500):
    return cpp_trace.capture_cpp(source(name), stdin, timeout, max_events)


def kinds(result):
    return {d["kind"] for d in result.get("diagnostics", [])}


def diag(result, kind):
    return next(d for d in result["diagnostics"] if d["kind"] == kind)


def heap_chain(event, start_ref, field="next"):
    """Values along a linked list, following `field` from a ref."""
    out, ref = [], start_ref
    while ref and ref["kind"] == "ref" and len(out) < 50:
        node = event["heap"][ref["id"]]
        out.append(node["fields"]["value"]["value"])
        ref = node["fields"][field]
    return out


@unittest.skipUnless(HAVE_TOOLS, "g++ and gdb are required for the C++ tracer tests")
class Supported(unittest.TestCase):
    def test_linked_list_swap(self):
        from_example = (ROOT / "backend" / "cpp_examples" / "01_linked_list_swap.cpp").read_text(encoding="utf-8")
        r = cpp_trace.capture_cpp(from_example)
        self.assertEqual((r["status"], r["complete"]), ("ok", True))
        self.assertEqual(r["stdout"], "20 10 30 \n")          # list 10,20,30 with first two swapped
        last = r["events"][-1]
        self.assertEqual(last["event"], "return")              # main's closing brace
        self.assertEqual(last["return_value"], {"kind": "scalar", "type": "int", "value": 0})
        # Just before the swap loop starts (after swap_first_two returned), head -> 20 -> 10 -> 30.
        print_line = next(i for i, t in enumerate(from_example.splitlines(), 1) if "for (Node* n = head" in t)
        printing = [e for e in r["events"] if e["line"] == print_line and e["event"] == "line"]
        self.assertTrue(printing)
        head = printing[0]["frames"][-1]["locals"]["head"]
        self.assertEqual(heap_chain(printing[0], head), [20, 10, 30])
        # Calls and returns pair up: three push_front calls and one swap call.
        names = [e["frames"][-1]["function"] for e in r["events"] if e["event"] == "call"]
        self.assertEqual(names.count("push_front"), 3)
        self.assertEqual(names.count("swap_first_two"), 1)
        self.assertEqual(len([e for e in r["events"] if e["event"] == "return"]), 5)  # 3 + 1 + main

    def test_queue_stack_priority_queue_show_their_contents(self):
        # Container adaptors hold no elements themselves: the tracer reads the underlying container `c`.
        r = run("adaptors")
        self.assertEqual((r["status"], r["complete"]), ("ok", True))
        # At the `return 0;` line all three adaptors and the plain struct hold their final contents.
        # (The last event of the run is past teardown: every container reads as a released buffer there,
        # adaptors and plain std::vector alike.)
        ev = next(e for e in r["events"] if e["event"] == "line" and e["line"] == 23)
        local = ev["frames"][-1]["locals"]

        def items(name):
            node = ev["heap"][local[name]["id"]]
            return node, [item["value"] for item in node["items"]]

        node, values = items("q")
        self.assertEqual((node["type"], node["element_type"]), ("std::queue", "int"))
        self.assertEqual(values, [20, 30])          # front to back
        node, values = items("s")
        self.assertEqual((node["type"], node["element_type"]), ("std::stack", "int"))
        self.assertEqual(values, [1, 2, 3])         # bottom to top: the top comes last
        node, values = items("pq")
        self.assertEqual((node["type"], node["element_type"]), ("std::priority_queue", "int"))
        self.assertEqual(values[0], 9)              # heap order: the top comes first, the rest is storage order
        self.assertEqual(sorted(values), [1, 5, 9])
        # A user type that only shares the name is not an adaptor: plain struct fields, no items.
        mine = ev["heap"][local["mine"]["id"]]
        self.assertNotIn("items", mine)
        self.assertEqual(mine["fields"]["front"]["value"], 7)
        self.assertEqual(mine["type"], "queue")

    def test_huffman_slow_recording_has_neutral_incomplete_message(self):
        # priority_queue program: about 280 steps, needs more than 2 s on a typical machine.
        short = run("huffman_priority_queue", timeout=0.6, max_events=2000)
        self.assertEqual(short["status"], "timeout")
        msg = [d["message"] for d in short["diagnostics"] if d["kind"] == "timeout"][0]
        self.assertIn("capture is incomplete", msg)
        self.assertNotIn("endless loop", msg)
        self.assertNotIn("probably", msg)
        # The memory check is a separate whole-run check, so the leak is still reported.
        self.assertIn("memory-leak", kinds(short))
        full = run("huffman_priority_queue", timeout=10.0, max_events=2000)
        self.assertEqual((full["status"], full["complete"]), ("ok", True))
        self.assertGreater(len(full["events"]), 200)

    def test_all_nodes_freed_at_end_means_no_leak_finding(self):
        r = cpp_trace.capture_cpp((ROOT / "backend" / "cpp_examples" / "01_linked_list_swap.cpp").read_text(encoding="utf-8"))
        self.assertNotIn("memory-leak", kinds(r))

    def test_arrays_structs_globals(self):
        r = run("arrays_structs")
        self.assertEqual(r["status"], "ok")
        ev = [e for e in r["events"] if e["line"] == 20][0]    # std::cout line: everything is assigned
        self.assertEqual([f["function"] for f in ev["frames"]], ["<globals>", "main"])
        self.assertEqual(ev["frames"][0]["locals"]["total"]["value"], 5 + 1 + 4 + 2 + 0 + 1 + 4)
        loc = ev["frames"][1]["locals"]
        self.assertEqual(loc["ratio"]["value"], 17 / 4.0)
        self.assertEqual(loc["letter"], {"kind": "scalar", "type": "char", "value": "A"})
        self.assertEqual(loc["ok"]["value"], True)
        arr = ev["heap"][loc["arr"]["id"]]
        self.assertEqual((arr["type"], arr["storage"], [i["value"] for i in arr["items"]]), ("array", "stack", [5, 1, 4, 2]))
        point = ev["heap"][loc["p"]["id"]]
        self.assertEqual({k: v["value"] for k, v in point["fields"].items()}, {"x": 9, "y": 4})   # changed through q
        self.assertEqual(loc["q"], {"kind": "ref", "id": loc["p"]["id"]})                          # alias: same node
        heap_arr = ev["heap"][loc["heap"]["id"]]
        self.assertEqual((heap_arr["storage"], [i["value"] for i in heap_arr["items"]]), ("heap", [0, 1, 4]))

    def test_recursion_depth_and_return_values(self):
        r = run("recursion")
        depth = max(len(e["frames"]) for e in r["events"])
        self.assertEqual(depth, 5)                              # main + fact(4..1)
        returns = [e["return_value"]["value"] for e in r["events"] if e["event"] == "return" and e["frames"][-1]["function"] == "fact"]
        self.assertEqual(returns, [1, 2, 6, 24])

    def test_before_line_semantics(self):
        r = run("recursion")
        first = r["events"][0]
        self.assertEqual((first["event"], first["frames"][0]["function"]), ("call", "main"))
        by_line = [e for e in r["events"] if e["frames"][-1]["function"] == "main" and e["line"] == 6]
        # `int r` has not stored a value at the line before it runs: it exists, flagged uninitialised, with no value drawn
        self.assertEqual(by_line[0]["frames"][-1]["locals"]["r"], {"kind": "opaque", "type": "uninitialised int"})

    def test_tree_has_left_and_right(self):
        r = run("tree")
        last_line = [e for e in r["events"] if e["frames"][-1]["function"] == "main" and e["line"] == 11][0]
        root = last_line["heap"][last_line["frames"][-1]["locals"]["root"]["id"]]
        left = last_line["heap"][root["fields"]["left"]["id"]]
        right = last_line["heap"][root["fields"]["right"]["id"]]
        self.assertEqual((root["fields"]["k"]["value"], left["fields"]["k"]["value"], right["fields"]["k"]["value"]), (5, 2, 8))

    def test_stdin(self):
        r = run("stdin_echo", stdin="Ada\n")
        self.assertEqual(r["stdout"], "hello Ada\n")

    def test_string_and_vector(self):
        r = run("stl")
        ev = [e for e in r["events"] if e["line"] == 9][0]
        loc = ev["frames"][-1]["locals"]
        self.assertEqual(loc["name"]["value"], "Ada")
        self.assertEqual([i["value"] for i in ev["heap"][loc["v"]["id"]]["items"]], [1, 2, 3, 4])

    def test_c_strings_stop_at_their_terminator(self):
        # gdb's string(length=N) reads N bytes through NULs: neighbours must not leak into each value.
        r = run("c_strings")
        ev = r["events"][-1]
        loc = ev["frames"][-1]["locals"]
        self.assertEqual(loc["one"]["value"], "kiwi")
        words = ev["heap"][loc["words"]["id"]]["items"]
        self.assertEqual([w["value"] for w in words], ["apple", "pear", "", "fig"])
        self.assertFalse(any(w.get("truncated") for w in words + [loc["one"]]))

    def test_live_node_behind_freed_node_is_recovered_as_orphan(self):
        # "apple" was linked behind "pear", then pear was deleted. Nothing points at apple, but it is still allocated:
        # it must still be captured (flagged orphan), not silently missing.
        r = run("hash_chain", max_events=2000)
        self.assertEqual(r["status"], "ok")
        last = r["events"][-1]
        keys = {n["fields"]["key"]["value"]: n for n in last["heap"].values() if n.get("fields") and "key" in n["fields"]}
        self.assertEqual(set(keys), {"apple", "kiwi", "lime", "plum", "fig"})
        self.assertTrue(keys["apple"].get("orphan"))
        self.assertFalse(any(keys[k].get("orphan") for k in ("kiwi", "lime", "plum", "fig")))
        self.assertEqual(keys["apple"]["fields"]["value"]["value"], 0)
        self.assertNotIn("unreached_heap", last)                 # everything live is drawn
        self.assertTrue(any(n.get("freed") for n in last["heap"].values()))   # the deleted node is still shown as freed

    def test_block_that_never_had_a_type_is_shown_as_raw_bytes_not_invented(self):
        r = run("lost_block")
        last = r["events"][-1]
        self.assertNotIn("unreached_heap", last)                   # it is drawn
        nodes = [n for n in last["heap"].values() if n["storage"] == "heap"]
        self.assertEqual([n["type"] for n in nodes], ["untyped block"])
        self.assertEqual([i["value"] for i in nodes[0]["items"]], [5, 0, 0, 0])   # the int 5, as bytes, no type claimed
        self.assertEqual(nodes[0]["length"], 4)
        self.assertFalse(nodes[0].get("orphan"))

    def test_budget_overflow_is_explicit_not_silent(self):
        # 10 s, the most capture_cpp allows: allocation-heavy programs trace slower on newer toolchains
        # (g++ 15/gdb 17 step far slower per allocation than g++ 11/gdb 15/18).
        r = run("leak_many", timeout=10.0, max_events=100)
        last = r["events"][-1]
        # What "explicit, not silent" must mean on every toolchain: the outcome is a declared status and
        # any truncation shown to the UI uses only declared reason codes. Whether this program overflows
        # its budget at all depends on machine speed, and whether the end-of-trace scan can prove the 100
        # unreached nodes dead depends on LeakSanitizer's conservative stack scan (glibc 2.35 reports all
        # 100; 2.39+ keeps stale stack copies alive), so no fixed outcome is asserted here.
        self.assertIn(r["status"], ("ok", "timeout"))
        self.assertTrue(set(last.get("truncated", [])) <= {"orphans"})
        # When the scan does prove nodes unreachable, the orphan disclosure must be wired both ways.
        if "orphans" in last.get("truncated", []):
            self.assertGreater(last["unreached_heap"]["count"], 0)
        self.assertLessEqual(len(last.get("heap", [])), 300)

    def test_unreachable_chain_is_fully_recovered_without_a_cap(self):
        # 89 live nodes are cut off from head. All must be drawn (the old limit was 40); the reachable 61 are not flagged.
        r = run("lost_chain", max_events=100)
        last = r["events"][-1]
        self.assertEqual(sum(1 for n in last["heap"].values() if n.get("orphan")), 89)
        self.assertEqual(len(last["heap"]), 150)
        self.assertNotIn("unreached_heap", last)
        self.assertEqual(last["truncated"], [])

    def test_long_reachable_chain_is_drawn_whole_and_not_called_unreachable(self):
        r = run("lost_chain", max_events=100)
        mid = [e for e in r["events"] if e["line"] == 6][0]      # 150 reachable nodes in one chain
        self.assertEqual(len(mid["heap"]), 150)
        self.assertFalse(any(n.get("orphan") for n in mid["heap"].values()))
        self.assertEqual(mid["truncated"], [])

    def test_dropped_scalar_and_array_blocks_are_recovered(self):
        r = run("lost_scalar_array")
        orph = [n for n in r["events"][-1]["heap"].values() if n.get("orphan")]
        self.assertEqual(sorted(n["type"] for n in orph), ["array", "int"])
        self.assertEqual([n["length"] for n in orph if n["type"] == "array"], [5])
        self.assertNotIn("unreached_heap", r["events"][-1])

    def test_smart_pointers_show_what_they_own(self):
        r = run("smart_ptrs")
        ev = [e for e in r["events"] if e["line"] == 8][0]       # everything alive, before main returns
        self.assertNotIn("unreached_heap", ev)
        ks = sorted(n["fields"]["k"]["value"] for n in ev["heap"].values() if n.get("fields") and "k" in n["fields"])
        self.assertEqual(ks, [1, 2])
        self.assertTrue(any(n.get("fields", {}).get("v", {}).get("value") == 3 for n in ev["heap"].values()))

    def test_map_list_set_contents_are_drawn(self):
        r = run("containers")
        ev = [e for e in r["events"] if e["line"] == 11][0]
        self.assertNotIn("unreached_heap", ev)
        kinds_ = sorted(n["type"] for n in ev["heap"].values() if n["storage"] == "stack")
        self.assertEqual(kinds_, ["dict", "dict", "std::list", "std::set"])
        st = [n for n in ev["heap"].values() if n["type"] == "std::set"][0]
        self.assertEqual(st["element_type"], "int")
        self.assertEqual([i["value"] for i in st["items"]], [1, 2, 3])
        self.assertEqual(sum(1 for n in ev["heap"].values() if n["storage"] == "heap"), 3)

    def test_vector_bool_elements_are_drawn_as_bools(self):
        # vector<bool>'s bits have no addressable gdb.Value, so the printer hands plain Python bools
        # to the encoder. Before-line semantics: at line 9 flags[1] is set but flags[3] is not.
        r = run("vector_bool")
        self.assertEqual((r["status"], r["complete"]), ("ok", True))

        def bits(line):
            ev = next(e for e in r["events"] if e["line"] == line and e["event"] == "line")
            node = next(n for n in ev["heap"].values()
                        if n.get("type") == "std::vector" and n.get("element_type") == "bool")
            return [i["value"] for i in node["items"]]

        self.assertEqual(bits(9), [False, True, False, False])
        self.assertEqual(bits(10), [False, True, False, True])

    def test_nodes_held_by_globals_and_statics_are_never_flagged_unreachable(self):
        # reachable from: a global, a file-level static, a function-local static (function not running); one node is really lost
        r = run("globals_statics")
        self.assertEqual(r["status"], "ok")
        ev = r["events"][-1]
        nodes = {n["fields"]["v"]["value"]: n for n in ev["heap"].values() if n.get("type") == "N"}
        self.assertEqual(sorted(nodes), [1, 2, 3, 9, 11])                       # 1 and 11 (global chain), 2 (file static), 3 (function static), 9 (lost)
        for v in (1, 2, 3, 11):
            self.assertFalse(nodes[v].get("orphan"), "node %s is reachable from a global or static" % v)
        self.assertTrue(nodes[9].get("orphan"))
        self.assertNotIn("untyped block", [n.get("type") for n in ev["heap"].values()])

    def test_static_in_a_nested_block_is_a_known_root_gap_and_is_not_called_orphan(self):
        # KNOWN LIMIT: only statics at the top of a function are collected as roots. A static declared inside a nested
        # block is not, so its block is drawn as an untyped block of raw bytes. It must stay visible and must NOT be
        # labelled as an orphan (no variable we check points at it, but we cannot claim that for this case).
        r = run("nested_static")
        self.assertEqual(r["status"], "ok")
        heap = r["events"][-1]["heap"]
        self.assertEqual(len(heap), 1)
        node = next(iter(heap.values()))
        self.assertEqual(node["type"], "untyped block")
        self.assertFalse(node.get("orphan"))

    def test_lost_pointer_node_stays_allocated_intact_and_flagged_unreachable(self):
        r = run("lost_pointer")
        before = [e for e in r["events"] if e["line"] == 9][0]    # the line that loses the pointer has not run yet
        after = [e for e in r["events"] if e["line"] == 10][0]

        def by_key(ev):
            return {n["fields"]["key"]["value"]: (a, n) for a, n in ((n["address"], n) for n in ev["heap"].values())
                    if n.get("fields") and "key" in n["fields"]}
        b, a = by_key(before), by_key(after)
        self.assertEqual(sorted(b), [20, 30, 50, 70])
        self.assertEqual(sorted(a), [20, 30, 50, 70])               # nothing disappeared
        for key in (20, 30):
            self.assertEqual(b[key][0], a[key][0])                  # same block (same address), so same node
            self.assertFalse(b[key][1].get("orphan"))               # reachable before
            self.assertTrue(a[key][1].get("orphan"))                # unreachable after
            self.assertFalse(a[key][1].get("freed"))                # and not freed
            self.assertEqual(b[key][1]["fields"]["value"], a[key][1]["fields"]["value"])   # contents intact
        for key in (50, 70):
            self.assertFalse(a[key][1].get("orphan"))
        self.assertNotIn("unreached_heap", after)

    def test_leaked_node_is_shown_as_orphan(self):
        r = run("leak")
        self.assertTrue(any(n.get("orphan") for n in r["events"][-1]["heap"].values()))

    def test_fully_reachable_heap_has_no_unreached_note(self):
        r = run("tree")
        self.assertNotIn("unreached_heap", r["events"][-1])

    def test_exit_code_is_reported_not_hidden(self):
        r = run("tree")        # main returns the root key, 5
        self.assertEqual((r["status"], r["exit_code"]), ("ok", 5))
        self.assertIn("exit-code", kinds(r))

    def test_use_after_free_marks_freed_node(self):
        r = run("use_after_free")
        after = [e for e in r["events"] if e["line"] == 6][0]  # the line that reads n->v, after delete
        node = after["heap"][after["frames"][-1]["locals"]["n"]["id"]]
        self.assertTrue(node.get("freed"))
        self.assertNotIn("fields", node)                       # freed memory is never shown as if it were valid


@unittest.skipUnless(HAVE_TOOLS, "g++ and gdb are required for the C++ tracer tests")
class ErrorsAndLimits(unittest.TestCase):
    def test_compile_error(self):
        r = run("compile_error")
        self.assertEqual((r["status"], r["complete"], r["events"]), ("error", True, []))
        self.assertEqual(r["error"], {"type": "CompileError", "line": 3})
        self.assertEqual(diag(r, "compile-error")["line"], 3)

    def test_missing_library_is_unsupported(self):
        r = run("missing_include")
        self.assertEqual((r["status"], r["complete"]), ("unsupported", False))
        self.assertIn("missing-include", kinds(r))

    def test_threads_are_unsupported_without_compiling(self):
        r = run("threads")
        self.assertEqual(r["status"], "unsupported")
        self.assertIn("threads", kinds(r))

    def test_own_header_is_unsupported(self):
        r = cpp_trace.capture_cpp('#include "mine.h"\nint main() { return 0; }\n')
        self.assertEqual(r["status"], "unsupported")
        self.assertIn("multi-file", kinds(r))

    def test_scanner_ignores_comments_and_strings(self):
        r = cpp_trace.capture_cpp('// #include <thread>\n#include <cstdio>\nint main() { const char* s = "system(x)"; return s[0] == 0; }\n')
        self.assertEqual(r["status"], "ok", r.get("diagnostics"))

    def test_null_dereference_crash_keeps_partial_trace(self):
        r = run("null_deref")
        self.assertEqual((r["status"], r["complete"]), ("error", True))
        self.assertEqual(r["error"], {"type": "SIGSEGV", "line": 5})
        self.assertEqual(r["events"][-1]["event"], "exception")
        self.assertEqual(r["events"][-1]["line"], 5)
        self.assertEqual(diag(r, "signal-SIGSEGV")["line"], 5)

    def test_division_by_zero(self):
        r = run("div_zero")
        self.assertEqual((r["status"], r["error"]["type"], r["error"]["line"]), ("error", "SIGFPE", 6))
        self.assertEqual(r["stdout"], "start\n")                # output before the crash is kept

    def test_use_after_free_found_with_lines(self):
        r = run("use_after_free")
        d = diag(r, "asan-heap-use-after-free")
        self.assertEqual((d["line"], d["freed_line"], d["allocated_line"]), (6, 5, 4))

    def test_double_free(self):
        r = run("double_free")
        self.assertEqual(r["status"], "error")
        d = diag(r, "asan-double-free")
        self.assertEqual((d["line"], d["freed_line"]), (4, 3))

    def test_leak(self):
        r = run("leak")
        self.assertEqual(r["status"], "ok")
        d = diag(r, "memory-leak")
        self.assertEqual((d["severity"], d["line"]), ("warning", 3))

    def test_leak_report_counts_indirect_leaks_too(self):
        # lost_pointer never frees anything: node 30 (line 6) is lost directly, 70 and 20 hang off the tree.
        # The memory check must be built like the traced program (-O0); at -O1 the optimizer removed two of the
        # four allocations and the report said 48 bytes in 2 objects.
        # LeakSanitizer scans conservatively: a stale pointer in a dead stack slot or register keeps a block
        # "reachable", so the exact object count depends on the toolchain (g++ 11/glibc 2.35 reports all 4 blocks,
        # g++ 15/glibc 2.43 reports 2, ubuntu-24.04 CI reports 3). What must hold everywhere: at least one direct
        # leak mapped to its allocation line, only lines 5/6 as direct sites, 24-byte objects, and a consistent total.
        r = run("lost_pointer")
        d = [x for x in r["diagnostics"] if x["kind"] == "memory-leak"]
        direct = [x for x in d if x.get("line")]
        self.assertTrue(direct, "no direct leak reported at all")
        self.assertTrue(all(x["line"] in (5, 6) for x in direct))
        self.assertTrue(all(x["message"].startswith("Memory leak (direct): 24 bytes in 1 object") for x in direct))
        total = [x["message"] for x in d if not x.get("line")]
        self.assertEqual(len(total), 1)
        m = re.search(r"Total never freed: (\d+) bytes in (\d+) object", total[0])
        self.assertIsNotNone(m, total[0])
        self.assertGreaterEqual(int(m.group(2)), 2)
        self.assertEqual(int(m.group(1)), 24 * int(m.group(2)))

    def test_buffer_overflows(self):
        r = run("overflow")
        self.assertEqual(r["status"], "ok")                     # the plain run survives; only the checker sees it
        lines = {d["line"] for d in r["diagnostics"] if d["kind"].startswith("asan-")}
        self.assertEqual(lines, {4})                            # the stack array read; ASan stops at the first error
        self.assertIn("undefined-behavior", kinds(r))

    def test_uncaught_exception(self):
        r = run("uncaught_exception")
        self.assertEqual((r["status"], r["error"]["type"]), ("error", "std::out_of_range"))
        self.assertEqual(r["error"]["line"], 3)
        self.assertTrue(any(e["event"] == "exception" for e in r["events"]))
        self.assertIn("too big", r["stderr"])

    def test_caught_exception_is_not_an_error(self):
        r = run("caught_exception")
        self.assertEqual((r["status"], r["exit_code"]), ("ok", 0))
        self.assertTrue(any(e["event"] == "exception" and e["exception_type"] == "std::runtime_error" for e in r["events"]))

    def test_infinite_loop_times_out_and_names_the_line(self):
        t0 = time.time()
        r = run("infinite_loop", timeout=3.0)
        self.assertEqual((r["status"], r["complete"]), ("timeout", False))
        self.assertEqual(diag(r, "timeout")["line"], 4)
        self.assertEqual(r["limit_hit"]["kind"], "step_time")   # one line that never ends, not the whole-run clock
        self.assertLess(time.time() - t0, 3.0 + 5)

    def test_endless_recursion_hits_frame_limit(self):
        r = run("stack_overflow")
        self.assertEqual(r["status"], "trace_limit")
        self.assertIn("deeper than 32", diag(r, "trace-limit")["message"])
        self.assertEqual(r["limit_hit"], {"kind": "stack_depth", "limit": 32})

    def test_event_limit(self):
        r = run("big_output", max_events=50)
        self.assertEqual((r["status"], len(r["events"])), ("trace_limit", 50))
        self.assertEqual(r["limit_hit"], {"kind": "events", "limit": 50})

    def test_local_declared_after_an_early_return_is_not_shown(self):
        """A local whose declaration was skipped by an early return holds garbage; it must not appear or be followed."""
        src = (
            "struct N { int v; N* next; };\n"
            "N* pick(N* a, int k) {\n"
            "  if (k > 0) return a;\n"
            "  N* later = a->next;\n"
            "  return later;\n"
            "}\n"
            "int main() {\n"
            "  N b{2, nullptr}; N a{1, &b};\n"
            "  N* r = pick(&a, 1);\n"
            "  N* s = pick(&a, 0);\n"
            "  return r == s;\n"
            "}\n")
        runs = [cpp_trace.capture_cpp(src, "", 8.0, 200) for _ in range(2)]
        for r in runs:
            self.assertEqual(r["status"], "ok")
            for ev in r["events"]:
                for fr in ev["frames"]:
                    if fr["function"] == "pick" and ev["event"] == "return" and ev["step"] < 6:
                        pass
        first_call = [ev for ev in runs[0]["events"] if ev["frames"][-1]["function"] == "pick" and ev["frames"][-1]["line"] == 3]
        self.assertTrue(first_call)
        # in the call that returned early, `later` is never shown; in the call that ran line 4 it is
        calls = []
        cur = None
        for ev in runs[0]["events"]:
            top = ev["frames"][-1]
            if top["function"] != "pick":
                cur = None
                continue
            if ev["event"] == "call":
                cur = []
                calls.append(cur)
            if cur is not None:
                cur.append(top["locals"])
        self.assertEqual(len(calls), 2)
        self.assertFalse(any("later" in loc for loc in calls[0]), "skipped declaration shown")
        self.assertTrue(any("later" in loc for loc in calls[1]), "executed declaration missing")
        # and the recording is repeatable (the garbage value used to differ from run to run)
        self.assertEqual(json.dumps(runs[0]["events"], sort_keys=True), json.dumps(runs[1]["events"], sort_keys=True))

    def test_uninitialised_vector_shows_no_phantom_cells(self):
        """A vector whose three pointers are stale bytes (not constructed yet) must be drawn empty, not as invented cells.

        The stale words here point at readable stack memory with end < begin, so libstdc++'s printer would happily yield
        cells (it walks from begin until it meets end, which never happens); the tracer must refuse to draw them."""
        src = (
            "#include <vector>\n"
            "#include <cstdint>\n"
            "#include <cstring>\n"
            "int main() {\n"
            "    std::vector<int> v;\n"
            "    std::uint64_t saved[3];\n"
            "    std::uint64_t w[3];\n"
            "    std::memcpy(saved, (void*)&v, sizeof saved);\n"
            "    w[0] = (std::uint64_t)&w[0];\n"
            "    w[1] = w[0] - 8;\n"
            "    w[2] = w[0] + 64;\n"
            "    std::memcpy((void*)&v, w, sizeof w);\n"
            "    int n = 1;\n"
            "    n = n + 1;\n"
            "    std::memcpy((void*)&v, saved, sizeof saved);\n"
            "    return n - 2;\n"
            "}\n")
        r = cpp_trace.capture_cpp(src, "", 8.0, 300)
        self.assertEqual(r["status"], "ok")
        drawn = 0
        for ev in r["events"]:
            loc = ev["frames"][-1]["locals"] if ev["frames"] else {}
            v = loc.get("v")
            if v and v.get("kind") == "ref":
                node = ev["heap"][v["id"]]
                drawn += 1
                self.assertFalse(node.get("items"), "phantom cells drawn for a vector that is not constructed")
        self.assertGreater(drawn, 0, "the vector was never drawn")
        self.assertNotIn("items", r["events"][-1].get("truncated", []))

    def test_scalar_is_flagged_uninitialised_until_its_declaration_stores_a_value(self):
        """`int n = (int)v.size();` stops on its own line twice (before the call, then again after it returns, before the
        store). n holds stack garbage at both stops: it must be drawn as uninitialised, never as a number."""
        src = (
            "#include <vector>\n"
            "int main() {\n"
            "    std::vector<int> v = {1, 2, 3};\n"
            "    int n = (int)v.size();\n"
            "    return n - 3;\n"
            "}\n")
        want = {"kind": "opaque", "type": "uninitialised int"}
        runs = [cpp_trace.capture_cpp(src, "", 8.0, 300) for _ in range(2)]
        for r in runs:
            self.assertEqual(r["status"], "ok")
            at_decl = [ev for ev in r["events"] if ev["frames"] and ev["frames"][-1]["line"] == 4]
            self.assertTrue(at_decl)
            for ev in at_decl:
                self.assertEqual(ev["frames"][-1]["locals"]["n"], want)
            after = [ev for ev in r["events"] if ev["frames"] and ev["frames"][-1]["line"] == 5]
            self.assertEqual(after[0]["frames"][-1]["locals"]["n"]["value"], 3)
        # no stack garbage anywhere, so two runs record identically
        self.assertEqual(json.dumps(runs[0]["events"], sort_keys=True), json.dumps(runs[1]["events"], sort_keys=True))

    def test_loop_header_variable_is_hidden_first_time_and_shown_when_it_comes_round(self):
        """The rule must not hide a `for` variable on later passes over its header line."""
        src = (
            "int main() {\n"
            "    int s = 0;\n"
            "    for (int i = 0; i < 3; i++) {\n"
            "        s += i;\n"
            "    }\n"
            "    return s - 3;\n"
            "}\n")
        r = cpp_trace.capture_cpp(src, "", 8.0, 300)
        self.assertEqual(r["status"], "ok")
        header = [ev["frames"][-1]["locals"] for ev in r["events"] if ev["frames"] and ev["frames"][-1]["line"] == 3]
        self.assertNotIn("i", header[0], "i drawn before its declaration ran")
        self.assertEqual([h["i"]["value"] for h in header[1:] if "i" in h], [0, 1, 2])

    def test_destroyed_library_objects_do_not_show_freed_buffer_garbage(self):
        """After a vector or string is destroyed at scope end its buffer is freed; it must not be read as if still live."""
        src = (
            "#include <string>\n"
            "#include <vector>\n"
            "int main() {\n"
            "    std::string name = \"a string that is longer than the small-string buffer\";\n"
            "    std::vector<int> v = {1, 2, 3};\n"
            "    v.push_back(4);\n"
            "    int n = (int)v.size();\n"
            "    return n == 4 ? 0 : 1;\n"
            "}\n")
        r = cpp_trace.capture_cpp(src, "", 8.0, 300)
        runs = [r, cpp_trace.capture_cpp(src, "", 8.0, 300)]
        for r in runs:
            self.assertEqual(r["status"], "ok")
            seen_released = False
            seen_live = set()
            seen_names = set()
            for ev in r["events"]:
                loc = ev["frames"][-1]["locals"] if ev["frames"] else {}
                v = loc.get("v")
                if v and v.get("kind") == "ref":
                    node = ev["heap"][v["id"]]
                    if node.get("items") is not None:
                        vals = [i.get("value") for i in node["items"]]
                        self.assertIn(vals, ([], [1, 2, 3], [1, 2, 3, 4]), "vector shows values that are not its contents")
                        seen_live.add(len(vals)) if vals else None
                    elif "(buffer released)" in node.get("type", ""):
                        seen_released = True
                        self.assertTrue(node.get("opaque"))
                        self.assertFalse(node.get("freed"), "a stack object is not freed, only its buffer")
                name = loc.get("name")
                if name and name.get("kind") == "scalar":
                    # g++ 15 stops on the declaration line before the constructor has run (name still "");
                    # older g++ stops after. Both are honest pre-line states; freed-buffer garbage is the failure.
                    self.assertIn(name["value"], ("", "a string that is longer than the small-string buffer"))
                    seen_names.add(name["value"])
            self.assertEqual(seen_live, {3, 4}, "values before destruction must still be shown")
            self.assertIn("a string that is longer than the small-string buffer", seen_names)
            self.assertTrue(seen_released, "destroyed vector never marked as released")
        self.assertEqual(json.dumps(runs[0]["events"], sort_keys=True), json.dumps(runs[1]["events"], sort_keys=True))

    def test_live_containers_with_dangling_or_lookalike_values_are_not_marked_released(self):
        """A live container may hold a deleted pointer, a value equal to a freed address, or reallocate: it is still live."""
        src = (
            "#include <vector>\n#include <map>\n#include <list>\n#include <set>\n#include <string>\n"
            "struct Node { int v; };\n"
            "int main() {\n"
            "    Node* d = new Node{7};\n"
            "    unsigned long addr = (unsigned long)d;\n"
            "    std::vector<Node*> vp; vp.push_back(d);\n"
            "    std::map<int, Node*> mp; mp[1] = d;\n"
            "    std::list<Node*> lp; lp.push_back(d);\n"
            "    std::set<unsigned long> sa; sa.insert(addr);\n"
            "    std::vector<unsigned long> va; va.push_back(addr);\n"
            "    delete d;\n"
            "    std::string lookalike((const char*)&addr, 8);\n"
            "    std::vector<int> g; g.reserve(2); g.push_back(1); g.push_back(2); g.push_back(3);\n"
            "    g.clear(); g.shrink_to_fit(); g.push_back(5);\n"
            "    int last = (int)va.size() + (int)sa.size() + (int)lp.size() + (int)mp.size() + (int)vp.size() + g[0];\n"
            "    return last == 10 ? 0 : 1;\n"
            "}\n")
        r = cpp_trace.capture_cpp(src, "", 8.0, 300)
        self.assertEqual(r["status"], "ok")
        # the event whose line is the 'int last' statement: everything is still alive
        at = [e for e in r["events"] if e["frames"][-1]["line"] == 19][0]
        for e in r["events"]:
            if e["frames"][-1]["line"] >= 21:
                break
            for n in e["heap"].values():
                self.assertNotIn("(buffer released)", str(n.get("type", "")), "live container marked released at line %s" % e["frames"][-1]["line"])
        loc = at["frames"][-1]["locals"]
        def items(name):
            n = at["heap"][loc[name]["id"]]
            return n.get("items"), n
        self.assertEqual([i["value"] for i in items("va")[0]], [int(items("va")[0][0]["value"])])
        self.assertEqual(len(items("sa")[0]), 1)
        self.assertEqual(len(items("lp")[0]), 1)
        self.assertEqual(len(items("vp")[0]), 1)
        self.assertEqual(at["heap"][loc["mp"]["id"]]["length"], 1)
        self.assertEqual([i["value"] for i in items("g")[0]], [5])
        self.assertNotEqual(loc["lookalike"].get("kind"), "opaque", "inline string bytes equal to a freed address are data, not a released buffer")
        # the same objects after destruction (closing brace) do show a released buffer
        end = r["events"][-1]
        self.assertTrue(any("(buffer released)" in str(n.get("type", "")) for n in end["heap"].values()))

    def test_recording_file_limit_is_a_limit_not_a_tracer_failure(self):
        """The recording file reaching its size cap must end as trace_limit with a usable, validated beginning."""
        hashtree = (Path(__file__).resolve().parents[2] / "frontend" / "tests" / "programs" / "hashtree.cpp").read_text(encoding="utf-8")
        full = cpp_trace.capture_cpp(hashtree, "", 8.0, 2000)
        full_bytes = len(json.dumps(full["events"]))
        orig = cpp_trace.limiter.__defaults__
        try:
            cpp_trace.limiter.__defaults__ = (orig[0], max(65536, full_bytes // 3))
            r = cpp_trace.capture_cpp(hashtree, "", 8.0, 2000)
        finally:
            cpp_trace.limiter.__defaults__ = orig
        self.assertEqual((r["status"], r["complete"]), ("trace_limit", False))
        self.assertNotIn("worker-failed", [d["kind"] for d in r["diagnostics"]])
        self.assertIn("file limit", diag(r, "trace-limit")["message"])
        self.assertEqual(r["limit_hit"]["kind"], "recording_size")
        n = len(r["events"])
        self.assertTrue(0 < n < len(full["events"]))
        # the kept beginning is the real beginning of the run, not a damaged or reordered one
        key = lambda ev: (ev["event"], ev["line"], [f["function"] for f in ev["frames"]], sorted(ev["heap"]))
        self.assertEqual([key(e) for e in r["events"]], [key(e) for e in full["events"][:n]])
        self.assertEqual([e["step"] for e in r["events"]], list(range(n)))

    def test_oversized_output(self):
        r = run("big_output_oneline")
        self.assertEqual((r["status"], r["complete"]), ("output_limit", False))

    def test_memory_hog_is_stopped(self):
        t0 = time.time()
        r = run("memhog", timeout=3.0)
        self.assertIn(r["status"], ("ok", "timeout", "error", "worker_error", "trace_limit"))   # must END; "ok" happens when the memory cap makes malloc return null and the loop finishes
        self.assertLess(time.time() - t0, 15)

    def test_source_and_stdin_size_limits(self):
        with self.assertRaises(ValueError):
            cpp_trace.capture_cpp("x" * 70000)
        with self.assertRaises(ValueError):
            cpp_trace.capture_cpp("int main(){}", stdin="x" * 9000)
        with self.assertRaises(ValueError):
            cpp_trace.capture_cpp("int main(){}", timeout=99)

    def test_runs_again_after_every_kind_of_failure(self):
        for bad in ("null_deref", "infinite_loop", "big_output_oneline", "double_free", "stack_overflow", "compile_error"):
            run(bad, timeout=2.0)
            again = run("recursion")
            self.assertEqual(again["status"], "ok", f"after {bad}")
        self.assertEqual(again["events"][-1]["return_value"]["value"], 0)

    def test_no_stray_processes_left_behind(self):
        run("infinite_loop", timeout=2.0)
        run("memhog", timeout=2.0)
        time.sleep(0.5)
        left = []
        for pid in os.listdir("/proc"):
            if pid.isdigit():
                try:
                    cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace")
                except OSError:
                    continue
                if "codeviz-cpp-" in cmd:
                    left.append(cmd[:100])
        self.assertEqual(left, [])


class RunIsolation(unittest.TestCase):
    @unittest.skipUnless(cpp_trace.find_tools()[1] and cpp_trace.find_tools()[0], "g++ and gdb are required")
    def test_relative_file_is_not_shared_between_the_two_runs(self):
        src = (Path(__file__).parent.parent / "cpp_examples" / "10_writes_a_file.cpp").read_text()
        r = cpp_trace.capture_cpp(src)
        self.assertEqual(r["status"], "ok")
        # Each run starts in its own empty folder, so each appends once and counts 1 line.
        self.assertIn("lines in notes.txt: 1", r["stdout"])
        self.assertFalse([d for d in r["diagnostics"] if d["severity"] == "error"])

    @unittest.skipUnless(cpp_trace.find_tools()[1], "g++ is required")
    def test_program_cannot_see_the_tool_files_by_relative_path(self):
        src = '#include <cstdio>\nint main() {\n  FILE* f = fopen("prog", "r");\n  printf("%d\\n", f != nullptr);\n  return 0;\n}\n'
        r = cpp_trace.capture_cpp(src)
        self.assertIn("0", r["stdout"])


class BrokenTracer(unittest.TestCase):
    """A fake gdb that misbehaves. The launcher must still return a clear, well-formed result."""

    def fake_gdb(self, body):
        folder = tempfile.mkdtemp(prefix="fakegdb-")
        path = Path(folder) / "gdb"
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        return str(path)

    def run_with(self, gdb_body, timeout=2.0):
        old = os.environ.get("CODEVIZ_GDB")
        os.environ["CODEVIZ_GDB"] = self.fake_gdb(gdb_body)
        try:
            return cpp_trace.capture_cpp("int main() { return 0; }\n", "", timeout)
        finally:
            if old is None:
                del os.environ["CODEVIZ_GDB"]
            else:
                os.environ["CODEVIZ_GDB"] = old

    @unittest.skipUnless(cpp_trace.find_tools()[1], "g++ is required")
    def test_tracer_crashes_at_start(self):
        r = self.run_with('echo boom >&2; kill -SEGV $$')
        self.assertEqual((r["status"], r["complete"]), ("worker_error", False))
        self.assertIn("worker-failed", kinds(r))

    @unittest.skipUnless(cpp_trace.find_tools()[1], "g++ is required")
    def test_tracer_writes_garbage(self):
        r = self.run_with('printf "{not json\\n{\\"step\\":0}\\n" > "$CODEVIZ_DIR/events.jsonl"; printf "garbage" > "$CODEVIZ_DIR/final.json"')
        self.assertEqual(r["status"], "worker_error")
        self.assertEqual(r["events"], [])                       # the first line is invalid, nothing after it is trusted
        json.dumps(r, allow_nan=False)                          # result is still plain valid JSON

    @unittest.skipUnless(cpp_trace.find_tools()[1], "g++ is required")
    def test_tracer_hangs(self):
        t0 = time.time()
        r = self.run_with('sleep 30', timeout=1.0)
        self.assertEqual(r["status"], "timeout")
        self.assertLess(time.time() - t0, 6)

    @unittest.skipUnless(cpp_trace.find_tools()[1], "g++ is required")
    def test_tracer_floods_stdout(self):
        t0 = time.time()
        r = self.run_with('yes > "$CODEVIZ_DIR/stdout.txt"', timeout=3.0)
        # A flooding tracer must be stopped and reported as a failure, never hang or fill the disk.
        self.assertIn(r["status"], ("output_limit", "worker_error", "timeout"))
        self.assertLess(time.time() - t0, 8)
        json.dumps(r, allow_nan=False)

    def test_toolchain_missing(self):
        old = os.environ.get("PATH"), os.environ.get("CODEVIZ_GDB"), os.environ.get("CODEVIZ_GPP")
        os.environ["PATH"], os.environ["CODEVIZ_GDB"], os.environ["CODEVIZ_GPP"] = "/nonexistent", "", ""
        try:
            r = cpp_trace.capture_cpp("int main() { return 0; }\n")
        finally:
            os.environ["PATH"] = old[0]
            for key, value in (("CODEVIZ_GDB", old[1]), ("CODEVIZ_GPP", old[2])):
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.assertEqual(r["status"], "worker_error")
        self.assertIn("toolchain-missing", kinds(r))
        self.assertIn("apt install", r["diagnostics"][0]["message"])


class SanitizerParsing(unittest.TestCase):
    """Pure text tests: no compiler needed. The report text below is copied from real runs."""

    def test_asan_use_after_free(self):
        text = ("==1==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000010 at pc 0x1 bp 0x2 sp 0x3\n"
                "READ of size 4 at 0x602000000010 thread T0\n    #0 0x55 in main /tmp/x/main.cpp:6:20\n"
                "freed by thread T0 here:\n    #0 0x1 in operator delete(void*) ../x.cpp:1\n    #1 0x2 in main /tmp/x/main.cpp:5:5\n\n"
                "previously allocated by thread T0 here:\n    #0 0x1 in operator new(unsigned long) ../x.cpp:1\n    #1 0x2 in main /tmp/x/main.cpp:4:15\n")
        d = cpp_trace.parse_sanitizer(text)[0]
        self.assertEqual((d["line"], d["freed_line"], d["allocated_line"], d["kind"]), (6, 5, 4, "asan-heap-use-after-free"))

    def test_ubsan_lines_are_deduplicated(self):
        one = "main.cpp:7:15: runtime error: signed integer overflow: 1 + 1 cannot be represented in type 'int'\n"
        self.assertEqual(len(cpp_trace.parse_sanitizer(one * 5)), 1)

    def test_compiler_parse_ignores_other_files(self):
        text = "/usr/include/x.h:3:1: error: nope\nmain.cpp:4:5: error: expected ';'\nmain.cpp:4:5: note: ignore me\n"
        got = cpp_trace.parse_compiler(text)
        self.assertEqual([(d["line"], d["column"]) for d in got], [(4, 5)])


if __name__ == "__main__":
    unittest.main()
