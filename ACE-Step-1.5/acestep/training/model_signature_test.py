"""Tests for the model signature written into preprocessed tensors."""

import types
import unittest

from acestep.training.model_signature import model_hidden_size, model_signature


def _model(width, on_decoder=True):
    config = types.SimpleNamespace(hidden_size=width)
    if on_decoder:
        return types.SimpleNamespace(decoder=types.SimpleNamespace(config=config))
    return types.SimpleNamespace(config=config)


class ModelSignatureTest(unittest.TestCase):
    def test_reads_decoder_or_model_config(self):
        self.assertEqual(model_hidden_size(_model(2560)), 2560)
        self.assertEqual(model_hidden_size(_model(2048, on_decoder=False)), 2048)

    def test_unknown_layout_gives_nothing(self):
        self.assertIsNone(model_hidden_size(types.SimpleNamespace()))
        self.assertEqual(model_signature(types.SimpleNamespace(), None), {})

    def test_signature_has_width_and_name(self):
        self.assertEqual(
            model_signature(_model(2560), " acestep-v15-xl-turbo "),
            {"model_hidden_size": 2560, "model_name": "acestep-v15-xl-turbo"},
        )

    def test_name_alone_is_not_written_without_width_but_still_kept(self):
        self.assertEqual(model_signature(types.SimpleNamespace(), "x"), {"model_name": "x"})


if __name__ == "__main__":
    unittest.main()
