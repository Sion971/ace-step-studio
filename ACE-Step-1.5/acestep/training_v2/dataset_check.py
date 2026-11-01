"""Check, before a training starts, that the preprocessed tensors belong to the model about to be trained.

The tensors are made by the model's own condition encoder, so their width (the last size of ``encoder_hidden_states``) is the
model's hidden size: 2048 for the 2B models (Turbo, Base, SFT), 2560 for the XL ones. A LoRA is tied to that architecture too.
Training with tensors of the other width used to stop deep inside the first step with a shape error that says nothing about
the cause; this check names it at once. When anything is unclear (no tensor found, unknown model layout) it says nothing and
lets the training go on as before.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

_KNOWN = {2048: "a 2B model (Turbo, Base or SFT)", 2560: "an XL (4B) model"}


def _first_tensor_file(dataset_dir: str) -> Optional[str]:
    try:
        manifest = os.path.join(dataset_dir, "manifest.json")
        if os.path.isfile(manifest):
            with open(manifest, "r", encoding="utf-8") as fh:
                for raw in json.load(fh).get("samples", []):
                    for candidate in (os.path.join(dataset_dir, raw), raw):
                        if os.path.isfile(candidate):
                            return candidate
        for name in sorted(os.listdir(dataset_dir)):
            if name.endswith(".pt"):
                return os.path.join(dataset_dir, name)
    except (OSError, ValueError, AttributeError):
        pass
    return None


def dataset_width(dataset_dir: str) -> Optional[int]:
    """Width of the tensors in ``dataset_dir`` (None when it cannot be read)."""
    path = _first_tensor_file(dataset_dir)
    if path is None:
        return None
    try:
        import torch

        data = torch.load(path, map_location="cpu", weights_only=True)
        return int(data["encoder_hidden_states"].shape[-1])
    except Exception:  # noqa: BLE001 - an unreadable file is the dataset loader's business, not ours
        return None


def model_width(model: Any) -> Optional[int]:
    """Hidden size of the model about to be trained (None when the layout is unknown)."""
    for holder in (getattr(model, "decoder", None), model):
        config = getattr(holder, "config", None)
        value = getattr(config, "hidden_size", None)
        if isinstance(value, int) and value > 0:
            return value
    return None


def _name(width: int) -> str:
    return _KNOWN.get(width, "a model")


def mismatch_message(dataset_dir: str, model: Any) -> Optional[str]:
    """An explanation when the tensors and the model do not have the same width, else None."""
    data_w = dataset_width(dataset_dir)
    model_w = model_width(model)
    if data_w is None or model_w is None or data_w == model_w:
        return None
    return (
        f"The preprocessed tensors in {dataset_dir} were made with {_name(data_w)} (width {data_w}), but the model loaded for "
        f"training is {_name(model_w)} (width {model_w}). The tensors belong to the model that preprocessed them, and a LoRA "
        f"only fits the model it was trained on. Load the matching model (Create tab in the Studio, or --model-variant on the "
        f"command line), or run the preprocessing again with the model you want to train."
    )
