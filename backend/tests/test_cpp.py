"""M5 tests for the C++ tracer. They compile and run real programs, so they need g++ and gdb.

Run from the repository root:  python -m unittest backend.tests.test_cpp -v
Without both tools every test is skipped (and says so), never silently passed.

Each expected value below was worked out by hand from the program text, not copied from tracer output.
"""
import json
import os
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
        self.assertNotIn("r", by_line[0]["frames"][-1]["locals"])  # `int r` is not declared yet at the line before it runs

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
        self.assertLess(time.time() - t0, 3.0 + 5)

    def test_endless_recursion_hits_frame_limit(self):
        r = run("stack_overflow")
        self.assertEqual(r["status"], "trace_limit")
        self.assertIn("deeper than 32", diag(r, "trace-limit")["message"])

    def test_event_limit(self):
        r = run("big_output", max_events=50)
        self.assertEqual((r["status"], len(r["events"])), ("trace_limit", 50))

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
