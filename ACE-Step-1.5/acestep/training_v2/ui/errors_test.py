"""Tests for the error suggestions shown when the model cannot be loaded."""

import contextlib
import io
import unittest

from acestep.training_v2.ui import set_plain_mode
from acestep.training_v2.ui.errors import handle_error, load_oom_suggestions


class OutOfMemory(Exception):
    """Stands in for torch.OutOfMemoryError (same name check, no torch needed)."""


OOM = OutOfMemory("CUDA out of memory. Tried to allocate 48.00 MiB.")


class LoadOomSuggestionsTest(unittest.TestCase):
    def test_out_of_memory_without_streaming_points_to_small_card_mode(self):
        tips = load_oom_suggestions(OOM, block_streaming=False)
        self.assertIsNotNone(tips)
        text = " ".join(tips)
        self.assertIn("Small-card mode", text)
        self.assertIn("--stream-blocks", text)
        self.assertNotIn("--batch-size", text)

    def test_out_of_memory_with_streaming_keeps_the_generic_advice(self):
        self.assertIsNone(load_oom_suggestions(OOM, block_streaming=True))

    def test_other_errors_keep_the_generic_advice(self):
        self.assertIsNone(load_oom_suggestions(FileNotFoundError("No such file"), block_streaming=False))

    def test_class_name_alone_is_enough(self):
        class OutOfMemoryError(Exception):
            pass

        self.assertIsNotNone(load_oom_suggestions(OutOfMemoryError("boom"), block_streaming=False))


class HandleErrorTest(unittest.TestCase):
    def setUp(self):
        set_plain_mode(True)

    def tearDown(self):
        set_plain_mode(False)

    def _shown(self, **kwargs):
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf), contextlib.redirect_stdout(buf):
            handle_error(OOM, context="Model loading", **kwargs)
        return buf.getvalue()

    def test_generic_advice_by_default(self):
        out = self._shown()
        self.assertIn("Reduce --batch-size", out)

    def test_given_suggestions_replace_the_generic_ones(self):
        out = self._shown(suggestions=load_oom_suggestions(OOM, False))
        self.assertIn("Small-card mode", out)
        self.assertNotIn("Reduce --batch-size", out)


if __name__ == "__main__":
    unittest.main()
