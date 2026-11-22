"""Tests for acestep.training_v2.pause_request (stdlib only)."""

import os
import tempfile
import unittest
from unittest.mock import patch

from acestep.training_v2.pause_request import PAUSE_FILE_ENV, pause_requested, paused_message, should_pause


class PauseRequestTest(unittest.TestCase):
    def test_no_variable_no_pause(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(pause_requested())

    def test_pause_once_the_file_exists(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pause")
            with patch.dict(os.environ, {PAUSE_FILE_ENV: path}):
                self.assertFalse(pause_requested())
                open(path, "w").close()
                self.assertTrue(pause_requested())
                self.assertTrue(should_pause(3, 10))
                # After the last epoch the run finishes instead.
                self.assertFalse(should_pause(10, 10))

    def test_message_names_the_checkpoint(self):
        msg = paused_message(4, 20, "out/checkpoints/epoch_4_loss_0.5000")
        self.assertTrue(msg.startswith("[PAUSED]"))
        self.assertIn("4/20", msg)
        self.assertTrue(msg.endswith("Resume from: out/checkpoints/epoch_4_loss_0.5000"))


if __name__ == "__main__":
    unittest.main()
