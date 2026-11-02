"""Tests for the training statistics gathered from trainer updates."""

import unittest

from acestep.training_v2.ui import TrainingUpdate
from acestep.training_v2.ui.progress import TrainingStats, _process_structured
from acestep.training_v2.ui.summary import _loss_trajectory


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

    def test_summary_loss_uses_epoch_averages(self):
        stats = TrainingStats()
        for step, (epoch, loss) in enumerate([(1, 1.13), (2, 1.0), (3, 0.9)], start=1):
            _process_structured(
                TrainingUpdate(step * 4, 1.5, "s", kind="step", epoch=epoch, max_epochs=3), stats
            )
            _process_structured(
                TrainingUpdate(step * 4, loss, "e", kind="epoch", epoch=epoch, max_epochs=3), stats
            )
        # the final update carries the last single step, which must not be shown
        _process_structured(TrainingUpdate(12, 0.64, "done", kind="complete"), stats)
        self.assertEqual(_loss_trajectory(stats), (1.13, 0.9, "Loss (epoch avg)"))

    def test_summary_loss_falls_back_to_steps(self):
        stats = TrainingStats()
        _process_structured(TrainingUpdate(1, 1.2, "s", kind="step", epoch=1, max_epochs=3), stats)
        _process_structured(TrainingUpdate(2, 0.8, "s", kind="step", epoch=1, max_epochs=3), stats)
        self.assertEqual(_loss_trajectory(stats), (1.2, 0.8, "Loss"))


if __name__ == "__main__":
    unittest.main()
