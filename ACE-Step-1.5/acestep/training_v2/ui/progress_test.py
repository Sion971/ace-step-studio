"""Tests for the training statistics gathered from trainer updates."""

import unittest

from acestep.training_v2.ui import TrainingUpdate
from acestep.training_v2.ui.progress import TrainingStats, _process_structured


class ProcessStructuredTest(unittest.TestCase):
    def test_complete_update_keeps_epoch_count(self):
        stats = TrainingStats()
        _process_structured(
            TrainingUpdate(40, 0.7, "e", kind="epoch", epoch=100, max_epochs=100), stats
        )
        _process_structured(TrainingUpdate(400, 0.64, "done", kind="complete"), stats)
        self.assertEqual(stats.current_epoch, 100)
        self.assertEqual(stats.max_epochs, 100)
        self.assertEqual(stats.current_step, 400)

    def test_epoch_counter_follows_updates(self):
        stats = TrainingStats()
        _process_structured(TrainingUpdate(4, 1.0, "e", kind="epoch", epoch=1, max_epochs=10), stats)
        self.assertEqual(stats.current_epoch, 1)
        _process_structured(TrainingUpdate(8, 0.9, "e", kind="epoch", epoch=2, max_epochs=10), stats)
        self.assertEqual(stats.current_epoch, 2)


if __name__ == "__main__":
    unittest.main()
