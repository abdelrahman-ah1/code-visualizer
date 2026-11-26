"""capture(as_json=True) must be the same trace as capture(): the server forwards it unparsed."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from trace_capture import capture  # noqa: E402

CASES = {
    "ok": ("x = [1, 2, 3]\nfor i in range(5):\n    x.append(i * 300)\n", {}),
    "event_limit": ("for i in range(100):\n    a = i\n", {"max_events": 10}),
    "output_limit": ("for i in range(100):\n    print('x' * 50)\n", {"max_output": 100}),
    "error": ("a = [1]\nprint(a[3])\n", {}),
    "syntax_error": ("def (:\n", {}),
    "unsupported": ("def g():\n    yield 1\n", {}),
    "unicode_and_ints": ("s = 'h\u00e9llo \u2603'\nprint(s)\nd = {'a': s, 'b': 1025, 'c': -5, 'd': True, 'e': 2 ** 70}\n", {}),
    "cycle": ("a = []\na.append(a)\n", {}),
    "empty_source": ("", {}),
    "timeout": ("a = [1, 2]\nx = sum(range(10 ** 9))\n", {"timeout": 0.5}),
}


class RawCapture(unittest.TestCase):
    def test_same_trace_as_the_dict_path(self):
        for name, (source, kwargs) in CASES.items():
            with self.subTest(name):
                raw = capture(source, as_json=True, **kwargs)
                self.assertIsInstance(raw, str)
                self.assertEqual(json.loads(raw), capture(source, **kwargs))


class TimeLimitAboveThreeSeconds(unittest.TestCase):
    def test_a_long_time_limit_ends_as_timeout_not_worker_error(self):
        # The worker's CPU backstop used to be a fixed 3 s, so a 4 s limit died as worker_error.
        result = capture("x = sum(range(10 ** 10))\n", timeout=4.0)
        self.assertEqual(result["status"], "timeout")
        self.assertFalse(result["complete"])


if __name__ == "__main__":
    unittest.main()
