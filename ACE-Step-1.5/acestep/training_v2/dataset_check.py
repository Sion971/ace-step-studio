"""Check, before a training starts, that the preprocessed tensors were made by a model of the architecture about to be trained.

Tensors made by a 2B model and tensors made by an XL model have the same shape, so training the wrong pair raises no error: it
just learns from encodings the model does not understand. Since the preprocessing writes the decoder's hidden size (2048 for the
2B models, 2560 for XL) into each file's metadata, the trainer can compare it with the loaded model. Tensors made before that
was added carry no such entry: they are accepted without a word, and so is anything unreadable.

Only the architecture is compared, not the exact variant: Turbo, Base and SFT share the 2B architecture.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional, Tuple

from acestep.training.model_signature import HIDDEN_SIZE_KEY, NAME_KEY, model_hidden_size

_FAMILY = {2048: "a 2B model (Turbo, Base or SFT)", 2560: "an XL (4B) model"}


def _first_tensor_file(dataset_dir: str) -> Optional[str]:
    try:
        manifest = os.path.join(dataset_dir, "manifest.json")
        if os.path.isfile(manifest):
            with open(manifest, "r", encoding="utf-8") as fh:
                for raw in json.load(fh).get("samples", []):
                    for candidate in (os.path.join(dataset_dir, raw), raw):
                        if isinstance(candidate, str) and candidate.endswith(".pt") and os.path.isfile(candidate):
                            return candidate
        for name in sorted(os.listdir(dataset_dir)):
            if name.endswith(".pt"):
                return os.path.join(dataset_dir, name)
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return None


def dataset_signature(dataset_dir: str) -> Tuple[Optional[int], Optional[str]]:
    """``(hidden_size, model_name)`` written by the preprocessing into the first tensor file (None when absent)."""
    path = _first_tensor_file(dataset_dir)
    if path is None:
        return None, None
    try:
        import torch

        meta = torch.load(path, map_location="cpu", weights_only=True).get("metadata") or {}
        size = meta.get(HIDDEN_SIZE_KEY)
        name = meta.get(NAME_KEY)
        return (size if isinstance(size, int) else None), (name if isinstance(name, str) else None)
    except Exception:  # noqa: BLE001 - an unreadable file is the dataset loader's business, not ours
        return None, None


def _family(width: int) -> str:
    return _FAMILY.get(width, f"a model of width {width}")


def mismatch_message(dataset_dir: str, model: Any) -> Optional[str]:
    """An explanation when the tensors come from another architecture than ``model``, else None."""
    data_w, data_name = dataset_signature(dataset_dir)
    model_w = model_hidden_size(model)
    if data_w is None or model_w is None or data_w == model_w:
        return None
    made_with = f"{_family(data_w)}" + (f" ({data_name})" if data_name else "")
    return (
        f"The preprocessed tensors in {dataset_dir} were made with {made_with}, but the model loaded for training is "
        f"{_family(model_w)}. The tensors belong to the model that preprocessed them, and a LoRA only fits the model it was "
        f"trained on. Load the matching model (Create tab in the Studio, or --model-variant on the command line), or run the "
        f"preprocessing again with the model you want to train."
    )
