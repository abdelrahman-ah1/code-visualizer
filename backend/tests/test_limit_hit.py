"""A run that a limit stopped says which limit, with its value."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from trace_capture import capture  # noqa: E402


class LimitHit(unittest.TestCase):
    def hit(self, source, **kw):
        r = capture(source, **kw)
        return r["status"], r.get("limit_hit")

    def test_events(self):
        self.assertEqual(self.hit("for i in range(100):\n    a = i\n", max_events=10), ("trace_limit", {"kind": "events", "limit": 10}))

    def test_objects(self):
        status, hit = self.hit("for i in range(400):\n    xs = [[i]]\n", max_events=2000)
        self.assertEqual((status, hit), ("trace_limit", {"kind": "objects", "limit": 300}))

    def test_stack_depth(self):
        status, hit = self.hit("def f(n):\n    return f(n + 1)\nf(0)\n", max_events=2000)
        self.assertEqual((status, hit), ("trace_limit", {"kind": "stack_depth", "limit": 32}))

    def test_output(self):
        self.assertEqual(self.hit("for i in range(100):\n    print('x' * 50)\n", max_output=100), ("output_limit", {"kind": "output_chars", "limit": 100}))

    def test_wall_time(self):
        status, hit = self.hit("x = sum(range(10 ** 10))\n", timeout=0.4)
        self.assertEqual((status, hit), ("timeout", {"kind": "wall_time", "limit": 0.4}))

    def test_memory(self):
        status, hit = self.hit("x = bytearray(10 ** 9)\n")
        self.assertEqual(status, "error")
        self.assertEqual(hit["kind"], "memory")

    def test_recording_size_is_a_limit_not_a_user_error(self):
        # 40 distinct 900-character strings and many nested lists in every event fill the 16 MiB recording file long before
        # 2000 events. Python ignores SIGXFSZ, so this used to come back as status "error", OSError, as if the program had failed.
        src = "data = {}\nfor i in range(2000):\n    data[i % 40] = [list(range(40)) for _ in range(5)]\n    names = ['x' * 900 for _ in range(30)]\n"
        for kw in ({}, {"as_json": True}):
            r = capture(src, max_events=2000, timeout=10, **kw)
            if isinstance(r, str):
                import json
                r = json.loads(r)
            self.assertEqual((r["status"], r["limit_hit"]["kind"]), ("trace_limit", "recording_size"))
            self.assertNotIn("error", r)
            self.assertGreater(len(r["events"]), 10)

    def test_a_normal_run_and_a_user_error_name_no_limit(self):
        self.assertEqual(self.hit("a = 1\n"), ("ok", None))
        self.assertEqual(self.hit("a = [1]\nprint(a[3])\n"), ("error", None))

    def test_same_in_the_pooled_and_raw_forms(self):
        import json
        raw = json.loads(capture("for i in range(100):\n    a = i\n", max_events=10, as_json=True, pooled=True))
        self.assertEqual(raw["limit_hit"], {"kind": "events", "limit": 10})


if __name__ == "__main__":
    unittest.main()
