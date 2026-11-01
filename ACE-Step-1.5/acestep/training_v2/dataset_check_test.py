"""Tests for the dataset / model width check.  Run:  python3 -m acestep.training_v2.dataset_check_test  (from ACE-Step-1.5)"""

import json
import os
import tempfile
from types import SimpleNamespace

import torch

from acestep.training_v2 import dataset_check as dc


def _make_dataset(width, manifest=False, n=2):
    tmp = tempfile.mkdtemp()
    names = []
    for i in range(n):
        name = f"s{i}.pt"
        torch.save({"encoder_hidden_states": torch.zeros(5, width)}, os.path.join(tmp, name))
        names.append(name)
    if manifest:
        with open(os.path.join(tmp, "manifest.json"), "w") as fh:
            json.dump({"samples": names}, fh)
    return tmp


def _model(width, nested=True):
    cfg = SimpleNamespace(hidden_size=width)
    return SimpleNamespace(decoder=SimpleNamespace(config=cfg)) if nested else SimpleNamespace(config=cfg)


def test_same_width_gives_no_message():
    assert dc.mismatch_message(_make_dataset(2048), _model(2048)) is None
    assert dc.mismatch_message(_make_dataset(2560, manifest=True), _model(2560, nested=False)) is None


def test_xl_tensors_with_a_2b_model_are_named():
    msg = dc.mismatch_message(_make_dataset(2560), _model(2048))
    assert msg is not None
    assert "XL" in msg and "2B" in msg and "2560" in msg and "2048" in msg
    assert "preprocessing again" in msg


def test_2b_tensors_with_an_xl_model_are_named():
    msg = dc.mismatch_message(_make_dataset(2048, manifest=True), _model(2560))
    assert msg is not None and "width 2048" in msg and "width 2560" in msg


def test_unknown_width_is_named_generically():
    msg = dc.mismatch_message(_make_dataset(1024), _model(2048))
    assert msg is not None and "a model (width 1024)" in msg


def test_unclear_situations_stay_silent():
    assert dc.mismatch_message(tempfile.mkdtemp(), _model(2048)) is None      # no tensor file
    assert dc.mismatch_message("/does/not/exist", _model(2048)) is None
    assert dc.mismatch_message(_make_dataset(2560), SimpleNamespace()) is None  # unknown model layout
    bad = tempfile.mkdtemp()
    with open(os.path.join(bad, "x.pt"), "wb") as fh:
        fh.write(b"not a tensor file")
    assert dc.mismatch_message(bad, _model(2048)) is None                      # unreadable file


if __name__ == "__main__":
    import sys

    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok  ", name)
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print("FAIL", name, type(exc).__name__, exc)
    sys.exit(1 if failed else 0)
