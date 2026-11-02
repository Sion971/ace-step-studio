"""Tests for the tensors-versus-model check done before a training."""

import json
import tempfile
import types
import unittest
from pathlib import Path

import torch

from acestep.training_v2.dataset_check import dataset_signature, mismatch_message


def _model(width):
    return types.SimpleNamespace(decoder=types.SimpleNamespace(config=types.SimpleNamespace(hidden_size=width)))


def _write(folder, name, **meta):
    torch.save(
        {"encoder_hidden_states": torch.zeros(4, 2048), "metadata": {"filename": name, **meta}},
        Path(folder) / f"{name}.pt",
    )


class DatasetCheckTest(unittest.TestCase):
    def test_same_architecture_is_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a", model_hidden_size=2560, model_name="acestep-v15-xl-turbo")
            self.assertIsNone(mismatch_message(d, _model(2560)))

    def test_xl_tensors_with_a_2b_model_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a", model_hidden_size=2560, model_name="acestep-v15-xl-turbo")
            msg = mismatch_message(d, _model(2048))
            self.assertIn("XL", msg)
            self.assertIn("2B", msg)
            self.assertIn("acestep-v15-xl-turbo", msg)

    def test_2b_tensors_with_an_xl_model_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a", model_hidden_size=2048)
            self.assertIn("2B", mismatch_message(d, _model(2560)))

    def test_tensors_without_signature_are_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a")  # preprocessed before the signature existed
            self.assertEqual(dataset_signature(d), (None, None))
            self.assertIsNone(mismatch_message(d, _model(2560)))

    def test_unknown_model_or_missing_folder_is_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a", model_hidden_size=2560)
            self.assertIsNone(mismatch_message(d, types.SimpleNamespace()))
        self.assertIsNone(mismatch_message("/nonexistent/folder", _model(2560)))

    def test_manifest_order_is_followed(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a", model_hidden_size=2048)
            _write(d, "b", model_hidden_size=2560)
            Path(d, "manifest.json").write_text(json.dumps({"samples": ["b.pt", "a.pt"]}), encoding="utf-8")
            self.assertEqual(dataset_signature(d)[0], 2560)


if __name__ == "__main__":
    unittest.main()
