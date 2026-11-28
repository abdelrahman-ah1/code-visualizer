import json
from pathlib import Path
import unittest
from trace_capture import capture, SCHEMA

ROOT = Path(__file__).parent


def locals_of(event):
    return event["frames"][-1]["locals"]


def value(event, name):
    def decode(encoded):
        if encoded["kind"] == "scalar":
            return encoded["value"]
        node = event["heap"][encoded["id"]]
        if node["type"] in ("list", "tuple"):
            return [decode(item) for item in node["items"]]
        raise AssertionError("Use explicit graph assertions for non-list objects")
    return decode(locals_of(event)[name])


class Fixtures(unittest.TestCase):
    def test_ten_programs(self):
        for source_path in sorted((ROOT / "fixtures").glob("*.py")):
            with self.subTest(program=source_path.stem):
                expected = json.loads(source_path.with_suffix(".expected.json").read_text())
                result = capture(source_path.read_text(), expected.get("stdin", ""), expected.get("timeout", 2.0))
                (ROOT / "examples" / f"{source_path.stem}.trace.json").write_text(json.dumps(result, indent=2))
                self.assertEqual(result["schema_version"], SCHEMA)
                self.assertEqual(result["status"], expected["status"])
                events = result["events"]
                self.assertTrue(events)
                for i, event in enumerate(events):
                    self.assertEqual(event["step"], i)
                    self.assertFalse(event["truncated"])
                last = events[-1]
                for name, wanted in expected.get("final", expected.get("last", {})).items():
                    self.assertEqual(value(last, name), wanted)
                for line, bindings in expected.get("before_line", {}).items():
                    event = next(e for e in events if e["event"] == "line" and e["line"] == int(line))
                    for name, wanted in bindings.items():
                        self.assertEqual(value(event, name), wanted)
                if "line_series" in expected:
                    series = expected["line_series"]
                    self.assertEqual([value(e, series["name"]) for e in events if e["event"] == "line" and e["line"] == series["line"]], series["values"])
                if "calls" in expected:
                    f_events = [e for e in events if e["frames"][-1]["function"] == "factorial"]
                    self.assertEqual([value(e, "n") for e in f_events if e["event"] == "call"], expected["calls"])
                    self.assertEqual([e["return_value"]["value"] for e in f_events if e["event"] == "return"], expected["returns"])
                    deepest = max(f_events, key=lambda e: len(e["frames"]))
                    self.assertEqual(len(deepest["frames"]), 4)
                for a, b in expected.get("same_ref", []):
                    self.assertEqual(locals_of(last)[a], locals_of(last)[b])
                    # The same identity must survive the mutation, not just match at the end.
                    ids = [locals_of(e)[a]["id"] for e in events if a in locals_of(e)]
                    self.assertEqual(len(set(ids)), 1)
                for a, b in expected.get("different_ref", []):
                    self.assertNotEqual(locals_of(last)[a], locals_of(last)[b])
                if "shared_first_item" in expected:
                    a, b, inner = expected["shared_first_item"]
                    bindings, heap = locals_of(last), last["heap"]
                    self.assertEqual(heap[bindings[a]["id"]]["items"][0], bindings[inner])
                    self.assertEqual(heap[bindings[b]["id"]]["items"][0], bindings[inner])
                if "self_cycle" in expected:
                    cycle = expected["self_cycle"]
                    ref = locals_of(last)[cycle["name"]]
                    node = last["heap"][ref["id"]]
                    self.assertEqual(node["fields"][cycle["field"]], ref)
                    self.assertEqual(node["fields"]["value"]["value"], cycle["value"])
                if "stdout" in expected:
                    self.assertEqual(result["stdout"], expected["stdout"])
                    self.assertEqual(last["stdout"], expected["stdout"])
                    line2 = next(e for e in events if e["event"] == "line" and e["line"] == 2)
                    self.assertEqual(line2["stdout"], "")
                if "error" in expected:
                    self.assertEqual(result["error"]["type"], expected["error"])
                    exc = next(e for e in events if e["event"] == "exception")
                    self.assertEqual(exc["line"], expected["exception_line"])
                    for name, wanted in expected["at_exception"].items():
                        self.assertEqual(value(exc, name), wanted)
                    self.assertNotIn(expected["absent"], locals_of(exc))
                if "last_line" in expected:
                    self.assertEqual(last["line"], expected["last_line"])
                    self.assertFalse(result["complete"])


class EdgeCases(unittest.TestCase):
    def test_event_budget(self):
        result = capture("while True:\n    pass\n", max_events=12)
        self.assertEqual(result["status"], "trace_limit")
        self.assertEqual(len(result["events"]), 12)

    def test_output_budget(self):
        result = capture("print('a' * 100)\n", max_output=10)
        self.assertEqual(result["status"], "output_limit")
        self.assertEqual(len(result["stdout"]), 10)

    def test_syntax_error(self):
        result = capture("if:\n")
        self.assertEqual(result["error"]["type"], "SyntaxError")
        self.assertEqual(result["events"], [])

    def test_caught_exception_is_not_run_failure(self):
        result = capture("try:\n    x = 1 / 0\nexcept ZeroDivisionError:\n    x = 4\n")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(value(result["events"][-1], "x"), 4)
        self.assertTrue(any(e["event"] == "exception" for e in result["events"]))

    def test_dict_and_returned_object(self):
        result = capture("def f():\n    return {'value': [2]}\nx = f()\n")
        ret = next(e for e in result["events"] if e["event"] == "return" and e["frames"][-1]["function"] == "f")
        ref = ret["return_value"]
        last = result["events"][-1]
        self.assertEqual(ref, locals_of(last)["x"])
        self.assertEqual(ret["heap"][ref["id"]]["entries"][0][0]["value"], "value")

    def test_generator_rejected(self):
        self.assertEqual(capture("def g():\n    yield 1\n")["status"], "unsupported")

    def test_no_custom_repr(self):
        result = capture("class X:\n    def __repr__(self):\n        raise RuntimeError()\nx = X()\n")
        self.assertEqual(result["status"], "ok")

    def test_snapshot_truncation(self):
        result = capture("a = list(range(50))\n")
        self.assertEqual(result["status"], "ok")
        self.assertIn("items", result["events"][-1]["truncated"])

    def test_deleted_binding(self):
        result = capture("a = [1]\ndel a\n")
        self.assertNotIn("a", locals_of(result["events"][-1]))

    def test_snapshots_are_immutable(self):
        result = capture("a = [1]\na.append(2)\n")
        before = next(e for e in result["events"] if e["event"] == "line" and e["line"] == 2)
        self.assertEqual(value(before, "a"), [1])
        self.assertEqual(value(result["events"][-1], "a"), [1, 2])

    def test_object_budget(self):
        result = capture("a = [[] for i in range(400)]\n", max_events=2000)
        self.assertEqual(result["status"], "ok")
        # Only the first 40 reachable children are captured, with explicit truncation.
        self.assertIn("items", result["events"][-1]["truncated"])
        result = capture("a = []\nfor i in range(310):\n    a[:] = [[]]\n", max_events=2000)
        self.assertEqual(result["status"], "trace_limit")

    def test_deque_is_captured_front_to_back(self):
        result = capture("import collections\nd = collections.deque([1, 2, 3])\nd.appendleft(0)\nd.pop()\n")
        self.assertEqual(result["status"], "ok")
        last = result["events"][-1]
        node = last["heap"][locals_of(last)["d"]["id"]]
        self.assertEqual(node["type"], "deque")
        self.assertEqual([item["value"] for item in node["items"]], [0, 1, 2])
        self.assertEqual(node["length"], 3)

    def test_deque_subclass_keeps_the_fields_path(self):
        # Only the exact built-in is a queue: a subclass can override the order, so it keeps its own fields.
        result = capture("import collections\nclass Bag(collections.deque):\n    pass\nb = Bag([1, 2])\nb.note = 'mine'\n")
        self.assertEqual(result["status"], "ok")
        last = result["events"][-1]
        node = last["heap"][locals_of(last)["b"]["id"]]
        self.assertNotIn("items", node)
        self.assertEqual(node["fields"]["note"]["value"], "mine")

    def test_stderr_and_eof(self):
        result = capture("import sys\nprint('warning', file=sys.stderr)\nx = input()\n")
        self.assertEqual(result["stderr"], "warning\n")
        self.assertEqual(result["error"]["type"], "EOFError")


class Accesses(unittest.TestCase):
    """Access marks: which object and cell a line touched, on the line that touched it."""

    def entries(self, result):
        return [m for e in result["events"] for m in e.get("accesses", [])]

    def test_read_marks_the_fetching_line_and_the_cell(self):
        result = capture("rows = [[7, 8]]\nx = rows[0][1]\n")
        last = result["events"][-1]
        rows_id = locals_of(last)["rows"]["id"]
        inner_id = last["heap"][rows_id]["items"][0]["id"]
        entries = self.entries(result)
        self.assertIn({"id": rows_id, "mode": "read", "line": 2, "cell": 0}, entries)
        self.assertIn({"id": inner_id, "mode": "read", "line": 2, "cell": 1}, entries)
        self.assertTrue(all(m["line"] == 2 for m in entries))
        self.assertEqual(value(last, "x"), 8)

    def test_store_and_in_place_update(self):
        result = capture("a = [0, 0]\na[1] = 5\na[0] += 2\n")
        last = result["events"][-1]
        a_id = locals_of(last)["a"]["id"]
        entries = self.entries(result)
        self.assertIn({"id": a_id, "mode": "write", "line": 2, "cell": 1}, entries)
        self.assertIn({"id": a_id, "mode": "readwrite", "line": 3, "cell": 0}, entries)
        self.assertEqual(value(last, "a"), [2, 5])

    def test_loop_iteration_is_marked_on_the_for_line(self):
        result = capture("rows = [[1], [2]]\ntotal = 0\nfor r in rows:\n    total += r[0]\n")
        last = result["events"][-1]
        rows_id = locals_of(last)["rows"]["id"]
        entries = self.entries(result)
        self.assertIn({"id": rows_id, "mode": "read", "line": 3, "cell": 0}, entries)
        self.assertIn({"id": rows_id, "mode": "read", "line": 3, "cell": 1}, entries)
        self.assertEqual(value(last, "total"), 3)

    def test_dict_iteration_marks_the_key(self):
        result = capture("d = {'a': 1, 'b': 2}\nseen = []\nfor k in d:\n    seen.append(k)\n")
        last = result["events"][-1]
        d_id = locals_of(last)["d"]["id"]
        entries = self.entries(result)
        self.assertIn({"id": d_id, "mode": "read", "line": 3, "key": "a"}, entries)
        self.assertIn({"id": d_id, "mode": "read", "line": 3, "key": "b"}, entries)
        self.assertEqual(value(last, "seen"), ["a", "b"])

    def test_the_cap_keeps_the_last_eight(self):
        expr = "+".join("a[%d]" % i for i in range(10))
        result = capture("a = list(range(20))\nx = " + expr + "\n")
        self.assertEqual([m["cell"] for m in self.entries(result)], list(range(2, 10)))
        self.assertEqual(value(result["events"][-1], "x"), sum(range(10)))

    def test_slices_and_del_are_not_marked(self):
        # A slice is one mark for a range and del is neither a read nor a write: both stay unmarked on purpose.
        result = capture("a = [1, 2, 3]\nb = a[0:2]\ndel a[0]\na[0] = 9\n")
        entries = self.entries(result)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["mode"], "write")
        self.assertEqual(value(result["events"][-1], "b"), [1, 2])

    def test_no_field_when_nothing_is_fetched(self):
        # The field is optional, so a recording made before this feature still parses.
        result = capture("x = 1\ny = x + 1\n")
        self.assertTrue(all("accesses" not in e for e in result["events"]))

    def test_a_killed_run_keeps_every_step(self):
        result = capture("import time\nrows = [1]\nx = rows[0]\ntime.sleep(5)\n", timeout=0.5)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["events"][-1]["line"], 4)
        self.assertEqual(value(result["events"][-1], "x"), 1)
        # The mark for line 3 is already on disk: a kill costs the hanging line's marks, never the steps before it.
        line3 = next(e for e in result["events"] if e["event"] == "line" and e["line"] == 3)
        self.assertEqual([m["mode"] for m in line3["accesses"]], ["read"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
