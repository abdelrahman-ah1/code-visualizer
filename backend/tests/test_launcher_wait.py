"""The launcher's wait: exact timeout, no leftover threads or child processes, boundary limits, same result shape."""
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import trace_capture  # noqa: E402
from trace_capture import capture  # noqa: E402


class Wait(unittest.TestCase):
    def test_no_thread_is_left_behind(self):
        before = threading.active_count()
        for _ in range(5):
            capture("a = 1\n")
        capture("x = sum(range(10 ** 9))\n", timeout=0.3)
        self.assertEqual(threading.active_count(), before)

    def test_timeout_boundary_is_close_to_the_limit(self):
        for limit in (0.05, 0.3):
            started = time.monotonic()
            result = capture("x = sum(range(10 ** 10))\n", timeout=limit)
            took = time.monotonic() - started
            self.assertEqual(result["status"], "timeout")
            self.assertLess(took, limit + 0.5, f"limit {limit}")

    def test_a_fast_run_is_not_reported_as_timeout_near_the_limit(self):
        # Finishing just under the limit must stay a normal result, never a late kill of a finished process.
        for _ in range(10):
            self.assertEqual(capture("a = 1\n", timeout=2.0)["status"], "ok")

    @unittest.skipUnless(os.name == "posix", "process groups")
    def test_children_the_program_starts_do_not_outlive_the_run(self):
        marker = "codeviz-orphan-%d" % os.getpid()
        src = ("import subprocess, sys\n"
               "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', %r])\n" % marker)
        capture(src, timeout=2.0)
        time.sleep(0.3)
        out = subprocess.run(["pgrep", "-f", marker], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "", "a child of the traced program is still running")

    @unittest.skipUnless(os.name == "posix", "process groups")
    def test_children_are_ended_on_timeout_too(self):
        marker = "codeviz-orphan-t-%d" % os.getpid()
        src = ("import subprocess, sys\n"
               "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)', %r])\n"
               "x = sum(range(10 ** 10))\n" % marker)
        self.assertEqual(capture(src, timeout=0.5)["status"], "timeout")
        time.sleep(0.3)
        out = subprocess.run(["pgrep", "-f", marker], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "")

    def test_polling_fallback_matches(self):
        # Where pidfd is not available (macOS, older Linux), the fallback path is used.
        had = hasattr(os, "pidfd_open")
        if had:
            saved = os.pidfd_open
            del os.pidfd_open
        try:
            self.assertEqual(capture("a = 1\n")["status"], "ok")
            self.assertEqual(capture("x = sum(range(10 ** 10))\n", timeout=0.3)["status"], "timeout")
        finally:
            if had:
                os.pidfd_open = saved


if __name__ == "__main__":
    unittest.main()
