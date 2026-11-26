"""capture(pooled=True) is the node-pool/2 form of the same recording: unpooling it must give back capture() exactly."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from trace_capture import capture  # noqa: E402
from test_raw_capture import CASES  # noqa: E402

EXTRA = {
    "astral_output": ("print('a\U0001F600b')\nx = 'z\U0001F600'\nprint('end')\n", {}),
    "stderr": ("import sys\nsys.stderr.write('oops\\n')\nprint('after')\n", {}),
    "growing_lists": ("a = []\nb = [1]\nfor i in range(6):\n    a.append(i)\n    b = b + [i]\n    if i == 3:\n        a.pop()\nc = [a, a]\n", {}),
    "list_of_lists": ("g = [[0]]\nfor i in range(4):\n    g[0].append(i)\n    g.append([i])\n", {}),
    "crlf_output": ("print('a\\r\\nb')\nprint('c')\n", {}),
}
for _p in sorted((Path(__file__).resolve().parents[1] / "examples").glob("*.py")):
    EXTRA["example_" + _p.stem] = (_p.read_text(encoding="utf-8"), {"max_events": 400})


def u16(text):
    return len(text.encode("utf-16-le")) // 2


def utf16_prefix(text, n):
    return text.encode("utf-16-le", "surrogatepass")[: 2 * n].decode("utf-16-le", "surrogatepass")


def unpool(packed):
    frames = packed["frame_pool"]
    pool = []
    for entry in packed["node_pool"]:
        if "delta_of" in entry:
            base = pool[entry["delta_of"]]
            assert 0 <= entry["delta_of"] < len(pool)
            node = {**base, **entry.get("set", {})}
            if "append" in entry:
                node["items"] = base["items"] + entry["append"]
            entry = node
        pool.append(entry)
    events = []
    for e in packed["events"]:
        r = {**e, "heap": {oid: pool[i] for oid, i in e["heap"].items()}, "frames": frames[e["frames"]]}
        for k in ("stdout", "stderr"):
            r[k] = utf16_prefix(packed[k + "_text"], e[k])
        events.append(r)
    rest = {k: v for k, v in packed.items() if k not in ("events", "encoding", "node_pool", "frame_pool", "stdout_text", "stderr_text")}
    return {**rest, "events": events}


class PooledCapture(unittest.TestCase):
    def test_same_recording_as_the_plain_path(self):
        for name, (source, kwargs) in {**CASES, **EXTRA}.items():
            with self.subTest(name):
                raw = capture(source, as_json=True, pooled=True, **kwargs)
                packed = json.loads(raw)
                self.assertIn(packed["encoding"], ("node-pool/2", "node-pool/3"))
                self.assertEqual(unpool(packed), capture(source, **kwargs))

    def test_pooling_is_smaller_on_a_loop(self):
        src = "x = []\nfor i in range(200):\n    x.append(i)\n    print('line', i)\n"
        plain, pooled = capture(src, max_events=2000, as_json=True), capture(src, max_events=2000, as_json=True, pooled=True)
        self.assertLess(len(pooled) * 3, len(plain))

    def test_growing_list_uses_deltas_and_is_much_smaller(self):
        src = "items = []\nfor i in range(300):\n    items.append(i * 7)\n"
        packed = json.loads(capture(src, max_events=2000, as_json=True, pooled=True))
        self.assertEqual(packed["encoding"], "node-pool/3")
        self.assertTrue(any("delta_of" in n for n in packed["node_pool"]))
        self.assertEqual(unpool(packed), capture(src, max_events=2000))

    def test_long_list_beyond_the_40_item_view_stores_only_the_length_change(self):
        src = "items = []\nfor i in range(200):\n    items.append(i)\n"
        packed = json.loads(capture(src, max_events=2000, as_json=True, pooled=True))
        sets = [n for n in packed["node_pool"] if "set" in n]
        self.assertGreater(len(sets), 100)
        self.assertTrue(all(set(n) <= {"delta_of", "set"} for n in sets if "append" not in n))
        self.assertEqual(unpool(packed), capture(src, max_events=2000))

    def test_plain_request_is_unchanged(self):
        self.assertNotIn("encoding", json.loads(capture("a = 1\n", as_json=True)))


if __name__ == "__main__":
    unittest.main()
