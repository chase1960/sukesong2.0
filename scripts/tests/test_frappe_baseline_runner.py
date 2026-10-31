"""Frappe bench may exit zero without running, or even with failed tests."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("frappe_runner", Path(__file__).parents[1] / "run-frappe-baseline.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class FrappeResultTests(unittest.TestCase):
    def test_zero_exit_does_not_override_failed_summary(self):
        result = runner.classify("Ran 10 tests in 0.4s\n\nFAILED (failures=1)\n", 0)
        self.assertEqual(result, {"status": "FAIL", "tests": 10})

    def test_disabled_empty_and_zero_tests_are_not_passes(self):
        for output in ("Testing is disabled for the site!", "", "Ran 0 tests in 0.0s\nOK"):
            self.assertEqual(runner.classify(output, 0)["status"], "NOT_RUN")

    def test_success_requires_real_non_skipped_tests(self):
        self.assertEqual(runner.classify("Ran 3 tests in 0.1s\nOK\n", 0)["status"], "PASS")
        self.assertEqual(runner.classify("Ran 3 tests in 0.1s\nOK (skipped=3)\n", 0)["status"], "NOT_RUN")


if __name__ == "__main__":
    unittest.main()
