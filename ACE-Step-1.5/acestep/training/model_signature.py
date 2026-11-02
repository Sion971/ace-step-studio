"""Which model made a set of preprocessed tensors.

The tensors hold the output of the model's own condition encoder, and a LoRA is tied to the decoder architecture (hidden size
2048 for the 2B models, 2560 for XL). The tensors alone cannot tell which model made them: the condition encoder outputs the
same width (2048) for both families. So the preprocessing writes the decoder's hidden size and the model name into each
file's ``metadata``, and the trainer compares the hidden size with the model it is about to train.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

HIDDEN_SIZE_KEY = "model_hidden_size"
NAME_KEY = "model_name"


def model_hidden_size(model: Any) -> Optional[int]:
    """Decoder hidden size of ``model`` (None when the layout is unknown)."""
    for holder in (getattr(model, "decoder", None), model):
        config = getattr(holder, "config", None)
        value = getattr(config, "hidden_size", None)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    return None


def model_signature(model: Any, name: Optional[str] = None) -> Dict[str, Any]:
    """The entries to merge into a tensor file's ``metadata`` (empty when nothing is known)."""
    signature: Dict[str, Any] = {}
    size = model_hidden_size(model)
    if size is not None:
        signature[HIDDEN_SIZE_KEY] = size
    if isinstance(name, str) and name.strip():
        signature[NAME_KEY] = name.strip()
    return signature
