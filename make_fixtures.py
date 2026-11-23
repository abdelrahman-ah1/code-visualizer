"""Create teaching fixtures with independent, hand-written expectations."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
CASES = [
    ("01_scalars", "x = 1\nx = x + 2\ny = x * 4\n", {"status": "ok", "final": {"x": 3, "y": 12}, "before_line": {"3": {"x": 3}}}),
    ("02_loop", "total = 0\nfor i in range(3):\n    total += i\n", {"status": "ok", "final": {"total": 3, "i": 2}, "line_series": {"line": 3, "name": "total", "values": [0, 0, 1]}}),
    ("03_recursion", "def factorial(n):\n    if n <= 1:\n        return 1\n    partial = factorial(n - 1)\n    return n * partial\nanswer = factorial(3)\n", {"status": "ok", "final": {"answer": 6}, "calls": [3, 2, 1], "returns": [1, 2, 6]}),
    ("04_list_mutation", "items = [10, 20]\nitems.append(30)\nitems[0] = 99\n", {"status": "ok", "final": {"items": [99, 20, 30]}, "before_line": {"3": {"items": [10, 20, 30]}}}),
    ("05_alias", "a = [1]\nb = a\nb.append(2)\n", {"status": "ok", "final": {"a": [1, 2], "b": [1, 2]}, "same_ref": [["a", "b"]]}),
    ("06_shallow_copy", "inner = [1]\na = [inner]\nb = a[:]\nb[0].append(2)\nb.append([9])\n", {"status": "ok", "final": {"inner": [1, 2], "a": [[1, 2]], "b": [[1, 2], [9]]}, "different_ref": [["a", "b"]], "shared_first_item": ["a", "b", "inner"]}),
    ("07_cycle", "class Node:\n    pass\nnode = Node()\nnode.value = 7\nnode.next = node\n", {"status": "ok", "self_cycle": {"name": "node", "field": "next", "value": 7}}),
    ("08_stdout_input", "name = input()\nprint('Hello', name)\n", {"status": "ok", "stdin": "Ada\n", "final": {"name": "Ada"}, "stdout": "Hello Ada\n"}),
    ("09_exception", "x = 5\ny = 0\nanswer = x / y\n", {"status": "error", "error": "ZeroDivisionError", "exception_line": 3, "at_exception": {"x": 5, "y": 0}, "absent": "answer"}),
    ("10_timeout", "import time\nx = 1\ntime.sleep(5)\nx = 2\n", {"status": "timeout", "timeout": 0.5, "last": {"x": 1}, "last_line": 3}),
]
for name, source, expected in CASES:
    (ROOT / "fixtures" / f"{name}.py").write_text(source, encoding="utf-8")
    (ROOT / "fixtures" / f"{name}.expected.json").write_text(json.dumps(expected, indent=2) + "\n", encoding="utf-8")
