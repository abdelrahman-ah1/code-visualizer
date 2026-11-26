"""The per-session token: made at startup, required on /api, one owner per token file."""
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import backend.app as backend  # noqa: E402

BASE = "http://127.0.0.1:8000"
HOLDER = ("import sys, time; sys.path.insert(0, sys.argv[1]); import backend.app as b; "
          "b.acquire_token_file(sys.argv[2]); print('ready', flush=True); time.sleep(60)")


def start(path):
    return mock.patch.dict(os.environ, {"CODEVIZ_TOKEN_FILE": str(path)})


class SessionToken(unittest.TestCase):
    def test_token_file_is_private_and_required(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "token"
            with start(path), TestClient(backend.app, base_url=BASE) as client:
                if os.name == "posix":
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                token = path.read_text(encoding="utf-8")
                self.assertGreaterEqual(len(token), 32)
                body = {"source": "x = 1"}
                for headers in ({}, {"x-codeviz-token": "wrong"}, {"x-codeviz-token": token + "x"}):
                    r = client.get("/api/health", headers=headers)
                    self.assertEqual(r.status_code, 401, headers)
                    self.assertEqual(r.json()["error"]["code"], "bad_token")
                self.assertEqual(client.post("/api/trace", json=body).status_code, 401)
                good = {"x-codeviz-token": token}
                self.assertEqual(client.get("/api/health", headers=good).status_code, 200)
                self.assertEqual(client.post("/api/trace", json=body, headers=good).status_code, 200)
                # Host and Origin checks still apply with a valid token.
                self.assertEqual(client.get("/api/health", headers={**good, "origin": "https://evil.example"}).status_code, 403)

    def test_each_start_makes_a_new_token(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "token"
            seen = []
            for _ in range(2):
                with start(path), TestClient(backend.app, base_url=BASE):
                    seen.append(path.read_text(encoding="utf-8"))
            self.assertNotEqual(seen[0], seen[1])

    def _holder(self, path):
        proc = subprocess.Popen([sys.executable, "-c", HOLDER, str(ROOT), str(path)],
                                stdout=subprocess.PIPE, text=True)
        self.assertEqual(proc.stdout.readline().strip(), "ready")
        return proc

    def test_a_second_backend_cannot_take_a_live_ones_file(self):
        # A owns the file, B tries the same file: B refuses, A's token is untouched.
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "token"
            holder = self._holder(path)
            try:
                before = path.read_text(encoding="utf-8")
                with start(path), self.assertRaises(RuntimeError) as caught:
                    with TestClient(backend.app, base_url=BASE):
                        pass
                self.assertIn("CODEVIZ_TOKEN_FILE", str(caught.exception))
                self.assertEqual(path.read_text(encoding="utf-8"), before)
            finally:
                holder.kill()
                holder.wait()

    def test_a_crashed_owner_does_not_block_the_next_start(self):
        # A owns the file and is killed hard (no clean shutdown): C starts at once with a new token.
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "token"
            holder = self._holder(path)
            old = path.read_text(encoding="utf-8")
            holder.kill()
            holder.wait()
            with start(path), TestClient(backend.app, base_url=BASE) as client:
                new = path.read_text(encoding="utf-8")
                self.assertNotEqual(new, old)
                self.assertEqual(client.get("/api/health", headers={"x-codeviz-token": new}).status_code, 200)

    def test_two_backends_with_their_own_files_do_not_interfere(self):
        with tempfile.TemporaryDirectory() as folder:
            one, two = Path(folder) / "one", Path(folder) / "two"
            holder = self._holder(one)
            try:
                with start(two), TestClient(backend.app, base_url=BASE) as client:
                    token = two.read_text(encoding="utf-8")
                    self.assertEqual(client.get("/api/health", headers={"x-codeviz-token": token}).status_code, 200)
                self.assertTrue(len(one.read_text(encoding="utf-8")) >= 32)
            finally:
                holder.kill()
                holder.wait()


    def test_simultaneous_starts_have_exactly_one_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "token"
            procs = [subprocess.Popen([sys.executable, "-c",
                                       HOLDER.replace("b.acquire_token_file(sys.argv[2]);", "b.acquire_token_file(sys.argv[2]) if True else 0;")
                                       .replace("time.sleep(60)", "time.sleep(3)"), str(ROOT), str(path)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(6)]
            outcomes = []
            for p in procs:
                out, _ = p.communicate(timeout=30)
                outcomes.append(out.strip() == "ready")
            self.assertEqual(sum(outcomes), 1, outcomes)


if __name__ == "__main__":
    unittest.main()
