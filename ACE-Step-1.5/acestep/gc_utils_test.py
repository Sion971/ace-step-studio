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


if __name__ == "__main__":
    unittest.main()
