"""Tests for the tensors-versus-model check done before a training."""

import json
import tempfile
import types
import unittest
from pathlib import Path

import torch

from acestep.training_v2.dataset_check import (
    _main,
    config_hidden_size,
    dataset_signature,
    mark_dataset,
    mismatch_message,
    mismatch_message_for_width,
    unmarked_message,
)


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

    def test_unmarked_tensors_give_a_warning(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a")
            msg = unmarked_message(d)
            self.assertIn("no model mark", msg)
            self.assertIn("--family", msg)
            self.assertIn(d, msg)

    def test_marked_or_missing_folder_gives_no_warning(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a", model_hidden_size=2048)
            self.assertIsNone(unmarked_message(d))
        self.assertIsNone(unmarked_message("/nonexistent/folder"))

    def test_marking_a_folder_by_hand_enables_the_check(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a")
            _write(d, "b")
            self.assertEqual(mark_dataset(d, "2b"), (2, 0, 0))
            self.assertIsNone(unmarked_message(d))
            self.assertIn("2B", mismatch_message(d, _model(2560)))
            self.assertIsNone(mismatch_message(d, _model(2048)))
            # the tensors themselves are untouched
            data = torch.load(Path(d) / "a.pt", weights_only=True)
            self.assertEqual(tuple(data["encoder_hidden_states"].shape), (4, 2048))
            self.assertEqual(data["metadata"]["filename"], "a")
            self.assertEqual(mark_dataset(d, "2b"), (0, 2, 0))

    def test_marking_does_not_overwrite_another_architecture_without_force(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a", model_hidden_size=2560)
            self.assertEqual(mark_dataset(d, "2b"), (0, 0, 1))
            self.assertEqual(dataset_signature(d)[0], 2560)
            self.assertEqual(mark_dataset(d, "2b", force=True), (1, 0, 0))
            self.assertEqual(dataset_signature(d)[0], 2048)

    def test_command_line(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a")
            self.assertEqual(_main([d, "--family", "xl"]), 0)
            self.assertEqual(dataset_signature(d)[0], 2560)
            self.assertEqual(_main(["/nonexistent/folder", "--family", "xl"]), 1)

    def test_width_known_only_from_the_config(self):
        with tempfile.TemporaryDirectory() as d:
            _write(d, "a", model_hidden_size=2048)
            self.assertIsNone(mismatch_message_for_width(d, 2048))
            self.assertIn("XL", mismatch_message_for_width(d, 2560))
            self.assertIsNone(mismatch_message_for_width(d, None))

    def test_config_hidden_size_reads_config_json(self):
        with tempfile.TemporaryDirectory() as root:
            for name, width in (("acestep-v15-xl-turbo-bf16", 2560), ("acestep-v15-turbo", 2048)):
                folder = Path(root) / name
                folder.mkdir()
                (folder / "config.json").write_text(json.dumps({"hidden_size": width}), encoding="utf-8")
            self.assertEqual(config_hidden_size(root, "acestep-v15-xl-turbo-bf16"), 2560)
            self.assertEqual(config_hidden_size(root, "turbo"), 2048)
            self.assertIsNone(config_hidden_size(root, "no-such-model"))
            (Path(root) / "acestep-v15-turbo" / "config.json").write_text("{}", encoding="utf-8")
            self.assertIsNone(config_hidden_size(root, "turbo"))


if __name__ == "__main__":
    unittest.main()
