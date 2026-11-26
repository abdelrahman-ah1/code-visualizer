"""The backend must start where the `resource` module does not exist (native Windows) and say C++ is unavailable.

Simulation on any OS: a child interpreter makes `resource` unimportable and sets cpp_trace.NATIVE_WINDOWS. It does not exercise the
Windows process launcher itself."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = r'''
import sys, json
sys.modules["resource"] = None
import cpp_trace
cpp_trace.NATIVE_WINDOWS = True
import backend.app as a
a.NATIVE_WINDOWS = True
from fastapi.testclient import TestClient
c = TestClient(a.app, base_url="http://127.0.0.1:8000")
def run(**body):
    j = c.post("/api/trace", json=body).json(); return j["status"], len(j["events"])
out = {
  "cpp": c.get("/api/health").json()["cpp"],
  "ok": run(source="x=[1]\nx.append(2)\n"),
  "error": run(source="x=1\nraise ValueError('boom')\n"),
  "timeout": run(source="import time\nwhile True:\n    time.sleep(0.05)\n", timeout=0.5, max_events=2000)[0],
}
j = c.post("/api/trace", json={"source": "int main(){return 0;}\n", "language": "cpp"}).json()
out["cpp_run"] = [j["status"], j["diagnostics"][0]["kind"]]
print("RESULT" + json.dumps(out))
'''


class WindowsGuard(unittest.TestCase):
    def test_backend_starts_without_resource_and_reports_cpp_unavailable(self):
        p = subprocess.run([sys.executable, "-W", "ignore", "-c", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr[-800:])
        out = json.loads(p.stdout.split("RESULT", 1)[1])
        self.assertEqual(out["cpp"], {"available": False, "gpp": False, "gdb": False, "unsupported_platform": True})
        self.assertEqual(out["ok"][0], "ok")
        self.assertEqual(out["error"][0], "error")
        self.assertEqual(out["timeout"], "timeout")
        self.assertEqual(out["cpp_run"], ["worker_error", "unsupported-platform"])


if __name__ == "__main__":
    unittest.main()
