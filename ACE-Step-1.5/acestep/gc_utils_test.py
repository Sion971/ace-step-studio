"""Tests of the conditional garbage collection."""

import unittest
from unittest import mock

from acestep import gc_utils


class CollectIfCardHoldsTests(unittest.TestCase):
    def _run(self, available, allocated=None, error=None):
        collected = []
        memory = mock.Mock(return_value=allocated, side_effect=error)
        with mock.patch.object(gc_utils.torch.cuda, "is_available", return_value=available), \
                mock.patch.object(gc_utils.torch.cuda, "memory_allocated", memory), \
                mock.patch.object(gc_utils.gc, "collect", side_effect=lambda *a: collected.append(1) or 0):
            ran = gc_utils.collect_if_card_holds()
        self.assertEqual(ran, bool(collected))
        return ran

    def test_clean_card_skips_the_collection(self):
        self.assertFalse(self._run(True, allocated=10 * 1024 ** 2))

    def test_card_holding_memory_collects(self):
        self.assertTrue(self._run(True, allocated=gc_utils.LEFTOVER_BYTES + 1))

    def test_threshold_itself_does_not_collect(self):
        self.assertFalse(self._run(True, allocated=gc_utils.LEFTOVER_BYTES))

    def test_without_a_card_collects_as_before(self):
        self.assertTrue(self._run(False))

    def test_a_collection_on_a_card_says_what_it_freed(self):
        readings = iter([600 * 1024 ** 2, 100 * 1024 ** 2])
        with mock.patch.object(gc_utils.torch.cuda, "is_available", return_value=True), \
                mock.patch.object(gc_utils.torch.cuda, "memory_allocated", side_effect=lambda: next(readings)), \
                mock.patch.object(gc_utils.gc, "collect"), \
                mock.patch.object(gc_utils, "logger") as logger:
            self.assertTrue(gc_utils.collect_if_card_holds("somewhere"))
        args = logger.info.call_args[0]
        self.assertEqual(args[1], "somewhere")
        self.assertAlmostEqual(args[2], 600.0)
        self.assertAlmostEqual(args[4], 500.0)

    def test_a_skipped_collection_is_silent(self):
        with mock.patch.object(gc_utils.torch.cuda, "is_available", return_value=True), \
                mock.patch.object(gc_utils.torch.cuda, "memory_allocated", return_value=1), \
                mock.patch.object(gc_utils, "logger") as logger:
            self.assertFalse(gc_utils.collect_if_card_holds("somewhere"))
        logger.info.assert_not_called()

    def test_unreadable_card_collects(self):
        self.assertTrue(self._run(True, error=RuntimeError("no device")))




class LiveTensorsTests(unittest.TestCase):
    def test_a_tensor_kept_in_a_dict_is_reported_with_its_holder(self):
        import torch

        kept = {"cache": torch.zeros(1024, 1024)}  # 4 MB
        total, weights, rows = gc_utils.live_tensors(top=3, device_type="cpu")
        self.assertGreaterEqual(total, 4 * 1024 ** 2)
        big = [row for row in rows if row[1] == (1024, 1024)]
        self.assertEqual(len(big), 1)
        self.assertTrue(any(holder.startswith("dict{cache") for holder in big[0][4]), big[0][4])
        del kept

    def test_weights_are_counted_apart(self):
        import torch

        layer = torch.nn.Linear(512, 512)
        total, weights, rows = gc_utils.live_tensors(top=50, device_type="cpu")
        self.assertGreaterEqual(weights, 512 * 512 * 4)
        self.assertFalse(any(row[1] == (512, 512) for row in rows))
        del layer

    def test_views_of_one_storage_count_once(self):
        import torch

        base = torch.zeros(2048, 256)
        views = [base[:100], base[100:200]]
        _, _, rows = gc_utils.live_tensors(top=50, device_type="cpu")
        match = [row for row in rows if row[0] == base.untyped_storage().nbytes()]
        self.assertEqual(len(match), 1)
        self.assertGreaterEqual(match[0][3], 3)
        del views

    def test_the_report_is_silent_unless_asked_and_never_raises(self):
        with mock.patch.dict(gc_utils.os.environ, {}, clear=False):
            gc_utils.os.environ.pop(gc_utils.ENV_MEM_DEBUG, None)
            self.assertFalse(gc_utils.mem_debug_requested())
        with mock.patch.dict(gc_utils.os.environ, {gc_utils.ENV_MEM_DEBUG: "1"}):
            self.assertTrue(gc_utils.mem_debug_requested())
        with mock.patch.object(gc_utils, "live_tensors", side_effect=RuntimeError("boom")), \
                mock.patch.object(gc_utils, "logger") as logger:
            gc_utils.log_live_tensors("somewhere")
        self.assertTrue(logger.warning.called)

    def test_a_collection_logs_the_report_only_when_asked(self):
        readings = iter([600 * 1024 ** 2, 100 * 1024 ** 2])
        for flag, expected in (("1", 1), ("0", 0)):
            readings = iter([600 * 1024 ** 2, 100 * 1024 ** 2])
            with mock.patch.dict(gc_utils.os.environ, {gc_utils.ENV_MEM_DEBUG: flag}), \
                    mock.patch.object(gc_utils.torch.cuda, "is_available", return_value=True), \
                    mock.patch.object(gc_utils.torch.cuda, "memory_allocated", side_effect=lambda: next(readings)), \
                    mock.patch.object(gc_utils.gc, "collect"), \
                    mock.patch.object(gc_utils, "log_live_tensors") as report:
                gc_utils.collect_if_card_holds("somewhere")
            self.assertEqual(report.call_count, expected)


if __name__ == "__main__":
    unittest.main()
