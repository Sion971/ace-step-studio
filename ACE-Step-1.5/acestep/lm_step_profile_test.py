import os
import unittest
from unittest import mock

from acestep import lm_step_profile as prof


class StepProfileTests(unittest.TestCase):
    def test_off_by_default_and_costs_nothing(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(prof.ENV_PROFILE, None)
            p = prof.StepProfile("x", "cpu")
        p.begin(); p.lap("a"); p.step()
        self.assertFalse(p.enabled)
        self.assertEqual(p.times, {})
        self.assertEqual(p.text(), "")

    def test_switched_on_by_the_variable(self):
        for value in ("1", "true", "YES", "on"):
            with mock.patch.dict(os.environ, {prof.ENV_PROFILE: value}):
                self.assertTrue(prof.requested())
        with mock.patch.dict(os.environ, {prof.ENV_PROFILE: "0"}):
            self.assertFalse(prof.requested())

    def test_the_time_goes_to_the_named_buckets(self):
        clock = iter([0.0, 1.0, 1.5, 3.0, 3.2])
        with mock.patch.object(prof.time, "perf_counter", side_effect=lambda: next(clock)):
            p = prof.StepProfile("CFG decoding", "cpu", enabled=True)
            p.begin()            # 0.0
            p.lap("model")       # 1.0 -> model 1.0
            p.lap("sampling")    # 1.5 -> sampling 0.5
            p.lap("model")       # 3.0 -> model 2.5
            p.step(); p.step()
            p.lap("bookkeeping")  # 3.2 -> 0.2
        self.assertAlmostEqual(p.times["model"], 1.0 + 1.5)
        self.assertAlmostEqual(p.times["sampling"], 0.5)
        text = p.text()
        self.assertIn("CFG decoding: 2 tokens", text)
        self.assertLess(text.index("model"), text.index("sampling"))  # biggest bucket first
        self.assertIn("per token", text)

    def test_the_report_is_logged_only_when_enabled(self):
        with mock.patch.object(prof.logger, "info") as info:
            prof.StepProfile("x", "cpu", enabled=False).report()
            info.assert_not_called()
            p = prof.StepProfile("x", "cpu", enabled=True)
            p.times = {"model": 1.0}
            p.tokens = 4
            p.report()
            info.assert_called_once()


if __name__ == "__main__":
    unittest.main()
