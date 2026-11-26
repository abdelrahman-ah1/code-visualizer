"""Every trace the recorders produce must be self-consistent, whatever it draws.

Catches the class of bug where a picture points into nothing: a reference with no heap node,
out-of-order steps, or an event with a line outside the source. Runs over all built-in
examples; C++ examples run only when g++ and gdb are installed.
"""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from trace_capture import capture  # noqa: E402
from cpp_trace import capture_cpp, find_tools  # noqa: E402

PY_DIRS = [ROOT / "fixtures", ROOT / "frontend" / "programs", ROOT / "backend" / "examples"]


def refs(value, out):
    if isinstance(value, dict):
        if value.get("kind") == "ref":
            out.append(value.get("id"))
        for item in value.values():
            refs(item, out)
    elif isinstance(value, list):
        for item in value:
            refs(item, out)


def problems(trace):
    found = []
    lines = len(trace["source"].splitlines()) or 1
    for index, event in enumerate(trace["events"]):
        if event["step"] != index:
            found.append(f"step {index}: numbered {event['step']}")
        if not 1 <= event["line"] <= lines:
            found.append(f"step {index}: line {event['line']} outside the source")
        used = []
        refs(event["frames"], used)
        refs(event["heap"], used)
        refs(event.get("return_value"), used)
        for ref in set(used):
            if ref not in event["heap"]:
                found.append(f"step {index}: reference {ref} has no heap node")
    return found


class TraceIntegrity(unittest.TestCase):
    def test_validator_notices_a_dangling_reference(self):
        trace = {"source": "x = 1\n", "events": [
            {"step": 0, "event": "line", "line": 1, "heap": {},
             "frames": [{"locals": {"x": {"kind": "ref", "id": "o9"}}}]}]}
        self.assertEqual(len(problems(trace)), 1)

    def test_python_examples(self):
        for folder in PY_DIRS:
            for path in sorted(folder.glob("*.py")):
                if path.name == "__init__.py" or "timeout" in path.name:
                    continue
                with self.subTest(path.name):
                    stdin = "Ada\n" if "stdout_input" in path.name else ""
                    trace = capture(path.read_text(encoding="utf-8"), stdin, 2.0, 2000)
                    self.assertEqual(problems(trace), [])

    @unittest.skipUnless(all(find_tools()), "g++ and gdb are needed")
    def test_cpp_examples(self):
        for path in sorted((ROOT / "backend" / "cpp_examples").glob("*.cpp")):
            with self.subTest(path.name):
                trace = capture_cpp(path.read_text(encoding="utf-8"), "", 5.0, 500)
                self.assertEqual(problems(trace), [])


if __name__ == "__main__":
    unittest.main()
