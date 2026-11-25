"""API tests for the M4 backend. Run from the repo root:  python -m unittest discover -s backend/tests -t .

Each test checks an observable result (status code, trace contents, error code), not just that
JSON came back. Real tracer subprocesses run, so these are slower than pure unit tests.
"""
import json
from pathlib import Path
import threading
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient
    from backend import app as backend
except ImportError as exc:  # M1 users who never installed backend/requirements.txt
    raise unittest.SkipTest(f"backend dependencies not installed ({exc}); see backend/requirements.txt")
from trace_capture import capture

ROOT = Path(__file__).resolve().parents[2]
# The Host header must be local, or the guard refuses the request (that is tested below).
client = TestClient(backend.app, base_url="http://127.0.0.1:8000")
JSON = {"content-type": "application/json"}


def post(body, headers=None):
    return client.post("/api/trace", content=json.dumps(body), headers={**JSON, **(headers or {})})


class HealthAndExamples(unittest.TestCase):
    def test_health(self):
        r = client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "ok")

    def test_examples_list_every_baseline_program_with_real_source(self):
        items = client.get("/api/examples").json()["examples"]
        ids = [e["id"] for e in items]
        for stem in ("01_scalars", "05_alias", "10_timeout", "12_linked_list_insert", "16_bubble_sort"):
            self.assertIn(stem, ids)
        self.assertEqual(len(ids), len(set(ids)), "ids must be unique")
        alias = next(e for e in items if e["id"] == "05_alias")
        self.assertEqual(alias["source"], (ROOT / "fixtures/05_alias.py").read_text(encoding="utf-8"))
        self.assertEqual(next(e for e in items if e["id"] == "08_stdout_input")["stdin"], "Ada\n")

    def test_every_example_traces_to_a_documented_status(self):
        # Runs all examples (including the deliberate timeout one with a short wall limit).
        for e in client.get("/api/examples").json()["examples"]:
            r = post({"source": e["source"], "stdin": e["stdin"], "timeout": 0.5, "max_events": 2000})
            self.assertEqual(r.status_code, 200, e["id"])
            self.assertIn(r.json()["status"], {"ok", "timeout", "error"}, e["id"])


class TraceEndpoint(unittest.TestCase):
    def test_alias_program_returns_the_same_trace_the_tracer_makes(self):
        source = "a = [1]\nb = a\nb.append(2)\n"
        r = post({"source": source})
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data["schema_version"], "codeviz.trace/1.0")
        self.assertEqual(data["status"], "ok")
        direct = capture(source)
        # IDs and events are deterministic for the same source; compare the replay-relevant parts.
        self.assertEqual(data["events"], direct["events"])
        last = data["events"][-1]
        self.assertEqual(last["frames"][0]["locals"]["a"], last["frames"][0]["locals"]["b"])
        self.assertEqual([i["value"] for i in last["heap"][last["frames"][0]["locals"]["a"]["id"]]["items"]], [1, 2])

    def test_stdin_reaches_the_program(self):
        data = post({"source": "name = input()\nprint('Hi', name)\n", "stdin": "Ada\n"}).json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["stdout"], "Hi Ada\n")

    def test_uncaught_exception_is_a_200_recording_with_status_error(self):
        r = post({"source": "x = 1\nraise ValueError('no')\n"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "error")
        self.assertEqual(r.json()["error"]["type"], "ValueError")

    def test_syntax_error_reports_line(self):
        data = post({"source": "x = 1\nif x\n"}).json()
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error"]["type"], "SyntaxError")
        self.assertEqual(data["error"]["line"], 2)

    def test_timeout_keeps_partial_events_and_is_not_success(self):
        data = post({"source": "import time\nx = 1\ntime.sleep(5)\n", "timeout": 0.5}).json()
        self.assertEqual(data["status"], "timeout")
        self.assertFalse(data["complete"])
        self.assertGreater(len(data["events"]), 0)

    def test_event_limit_status(self):
        data = post({"source": "i = 0\nwhile True:\n    i = i + 1\n", "max_events": 50}).json()
        self.assertEqual(data["status"], "trace_limit")
        self.assertEqual(len(data["events"]), 50)

    def test_unsupported_construct_is_reported_not_faked(self):
        data = post({"source": "def g():\n    yield 1\n"}).json()
        self.assertEqual(data["status"], "unsupported")

    def test_response_is_not_cached(self):
        self.assertEqual(post({"source": "x = 1"}).headers["cache-control"], "no-store")

    def test_server_timing_header_present(self):
        self.assertIn("capture;dur=", post({"source": "x = 1"}).headers["server-timing"])

    def test_large_response_is_gzipped_when_the_client_accepts_it(self):
        body = {"source": (ROOT / "backend/examples/19_long_loop.py").read_text(), "max_events": 2000, "timeout": 10}
        r = client.post("/api/trace", content=json.dumps(body), headers={**JSON, "accept-encoding": "gzip"})
        self.assertEqual(r.headers.get("content-encoding"), "gzip")
        self.assertGreater(len(r.json()["events"]), 1500)  # httpx already decoded the gzip


class RequestValidation(unittest.TestCase):
    def test_missing_source(self):
        r = post({})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"]["code"], "invalid_request")

    def test_limits_out_of_range(self):
        for body in ({"source": "x=1", "max_events": 0}, {"source": "x=1", "max_events": 2001},
                     {"source": "x=1", "timeout": 0}, {"source": "x=1", "timeout": 11}):
            self.assertEqual(post(body).status_code, 422, body)

    def test_wrong_types(self):
        self.assertEqual(post({"source": 5}).status_code, 422)
        self.assertEqual(post({"source": "x", "max_events": "many"}).status_code, 422)

    def test_malformed_json(self):
        r = client.post("/api/trace", content="{not json", headers=JSON)
        self.assertEqual(r.status_code, 422)

    def test_source_over_64_kib_is_rejected_as_too_large(self):
        # 40,000 three-byte characters: under the 65,536 character field limit, over 64 KiB in bytes.
        r = post({"source": "# " + "\u20ac" * 40000})
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["error"]["code"], "too_large")

    def test_body_over_cap_is_rejected_before_parsing(self):
        r = client.post("/api/trace", content=b"x" * 400_000, headers=JSON)
        self.assertEqual(r.status_code, 413)

    def test_non_json_content_type(self):
        r = client.post("/api/trace", content='{"source": "x=1"}', headers={"content-type": "text/plain"})
        self.assertEqual(r.status_code, 415)


class LocalOnlyGuard(unittest.TestCase):
    def test_foreign_origin_is_refused_and_nothing_runs(self):
        with mock.patch.object(backend, "capture") as run:
            r = post({"source": "x = 1"}, {"origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"]["code"], "bad_origin")
        run.assert_not_called()

    def test_dev_server_origin_is_allowed(self):
        self.assertEqual(post({"source": "x = 1"}, {"origin": "http://127.0.0.1:5173"}).status_code, 200)
        self.assertEqual(post({"source": "x = 1"}, {"origin": "http://localhost:5173"}).status_code, 200)

    def test_extra_origin_via_environment(self):
        with mock.patch.dict("os.environ", {"CODEVIZ_ORIGINS": "http://127.0.0.1:3000"}):
            self.assertEqual(post({"source": "x = 1"}, {"origin": "http://127.0.0.1:3000"}).status_code, 200)

    def test_foreign_host_header_is_refused(self):
        # A DNS-rebinding page reaches this server under its own hostname.
        for host in ("evil.example", "evil.example:8000", "127.0.0.1.evil.example"):
            r = client.get("/api/health", headers={"host": host})
            self.assertEqual(r.status_code, 403, host)
            self.assertEqual(r.json()["error"]["code"], "bad_host")

    def test_local_host_names_work_with_any_port(self):
        for host in ("localhost:8000", "127.0.0.1:9999", "[::1]:8000"):
            self.assertEqual(client.get("/api/health", headers={"host": host}).status_code, 200, host)

    def test_no_cors_headers_are_ever_sent(self):
        r = client.get("/api/health", headers={"origin": "http://127.0.0.1:5173"})
        self.assertNotIn("access-control-allow-origin", r.headers)


class Concurrency(unittest.TestCase):
    def test_busy_server_answers_429_quickly_and_releases_slots(self):
        started, release = threading.Event(), threading.Event()
        real = backend.capture

        def slow(*args):
            started.set()
            release.wait(5)
            return real(*args)

        with mock.patch.object(backend, "_slots", threading.BoundedSemaphore(1)), \
                mock.patch.object(backend, "capture", slow):
            first = {}
            t = threading.Thread(target=lambda: first.update(r=post({"source": "x = 1"})))
            t.start()
            self.assertTrue(started.wait(5))
            busy = post({"source": "x = 2"})
            self.assertEqual(busy.status_code, 429)
            self.assertEqual(busy.json()["error"]["code"], "busy")
            release.set()
            t.join(10)
            self.assertEqual(first["r"].status_code, 200)
            # The slot is free again after the first run finished.
            self.assertEqual(post({"source": "x = 3"}).status_code, 200)

    def test_slot_is_released_when_the_tracer_raises(self):
        with mock.patch.object(backend, "_slots", threading.BoundedSemaphore(1)), \
                mock.patch.object(backend, "capture", side_effect=RuntimeError("boom")):
            # A tracer bug is reported as a 500 (the server stays up), and the slot is released.
            failed = post({"source": "x = 1"})
            self.assertEqual(failed.status_code, 500)
            self.assertEqual(failed.json()["error"]["code"], "tracer_failed")
            self.assertNotIn("boom", failed.text)
        with mock.patch.object(backend, "_slots", threading.BoundedSemaphore(1)):
            self.assertEqual(post({"source": "x = 1"}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
