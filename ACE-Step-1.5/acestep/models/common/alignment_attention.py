"""Cross-attention for the lyric alignment (LRC and score), computed a few heads at a time.

The alignment reads the cross-attention WEIGHTS of a few (layer, head) pairs. The plain eager attention builds the weights of all
the heads of a layer at once (frames x lyric tokens x 32 heads, several copies in float32 while the softmax runs), which on a long
track is a peak of several hundred MB on top of the model: on an 8 GB card with the XL model it ran out of memory.

``chunked_cross_attention`` gives the same result head by head (every head has its own softmax, so the values do not depend on the
grouping) and returns only the weights of the heads asked for. ``set_alignment_keep`` / ``clear_alignment_keep`` tell the
cross-attention layers of a decoder which heads to keep; the config the decoder is then given numbers the kept heads 0, 1, 2...
(see ``small_gpu_stream.alignment_heads``).
"""

import os
import sys
from typing import Dict, List, Optional

import torch
from torch import nn
from transformers.models.qwen3.modeling_qwen3 import repeat_kv

ENV_CHUNK = "ACESTEP_ALIGN_HEAD_CHUNK"
DEFAULT_CHUNK = 4
KEEP_ATTR = "align_keep"


def _chunk_size() -> int:
    try:
        return max(1, int(os.environ.get(ENV_CHUNK, DEFAULT_CHUNK)))
    except ValueError:
        return DEFAULT_CHUNK


def chunked_cross_attention(
    module: nn.Module,
    query: torch.Tensor,
    key: torch.Tensor,
    value: torch.Tensor,
    attention_mask: Optional[torch.Tensor],
    scaling: float,
    dropout: float = 0.0,
    **kwargs,
):
    """Same maths as transformers' ``eager_attention_forward``, ``chunk`` heads at a time.

    Returns ``(attn_output, weights)``. ``weights`` holds only the heads listed in ``module.align_keep`` (in that order, those that
    exist), or is None when the list is empty.
    """
    key_states = repeat_kv(key, module.num_key_value_groups)
    value_states = repeat_kv(value, module.num_key_value_groups)
    n_heads = query.shape[1]
    keep: List[int] = [h for h in (getattr(module, KEEP_ATTR, None) or []) if 0 <= h < n_heads]
    chunk = _chunk_size()

    outputs = []
    kept: Dict[int, torch.Tensor] = {}
    for start in range(0, n_heads, chunk):
        stop = min(start + chunk, n_heads)
        weights = torch.matmul(query[:, start:stop], key_states[:, start:stop].transpose(2, 3)) * scaling
        if attention_mask is not None:
            weights = weights + attention_mask
        weights = nn.functional.softmax(weights, dim=-1, dtype=torch.float32).to(query.dtype)
        weights = nn.functional.dropout(weights, p=dropout, training=module.training)
        outputs.append(torch.matmul(weights, value_states[:, start:stop]))
        for head in keep:
            if start <= head < stop:
                kept[head] = weights[:, head - start]
        del weights
    attn_output = torch.cat(outputs, dim=1).transpose(1, 2).contiguous()
    kept_weights = torch.stack([kept[h] for h in keep], dim=1) if keep else None
    return attn_output, kept_weights


def _install_dispatch(attention: nn.Module) -> bool:
    """Make the module that defines ``attention`` use ``chunked_cross_attention`` for the layers marked with ``align_keep``.

    The model code that runs is the one of the checkpoint (``models/modules/transformers_modules/<model>/modeling_*.py``, loaded with
    ``trust_remote_code``), not the copy in ``acestep/models``: it cannot be edited here, so the ``eager_attention_forward`` it calls by
    name is replaced, in that module only, by a function that sends the marked layers to the chunked version and every other call to the
    original. Done once per module; harmless when no layer is marked.
    """
    module = sys.modules.get(type(attention).__module__)
    original = getattr(module, "eager_attention_forward", None)
    if module is None or original is None:
        return False
    if getattr(original, "_alignment_dispatch", False):
        return True

    def eager_attention_forward(layer, *args, **kwargs):
        if getattr(layer, KEEP_ATTR, None) is not None:
            return chunked_cross_attention(layer, *args, **kwargs)
        return original(layer, *args, **kwargs)

    eager_attention_forward._alignment_dispatch = True  # type: ignore[attr-defined]
    eager_attention_forward._original = original  # type: ignore[attr-defined]
    module.eager_attention_forward = eager_attention_forward
    return True


def set_alignment_keep(decoder: nn.Module, config: Dict[int, List[int]]) -> int:
    """Tell the cross-attention layers which heads to keep: ``config`` maps the rank of a layer among those that have a
    cross-attention to its heads. Returns the number of layers marked (the others are marked with an empty list)."""
    rank = 0
    marked = 0
    for layer in getattr(decoder, "layers", []):
        if not getattr(layer, "use_cross_attention", False):
            continue
        attention = getattr(layer, "cross_attn", None)
        if attention is not None:
            if not _install_dispatch(attention):
                continue  # cannot reach the attention function of this model: leave the layer as it is
            setattr(attention, KEEP_ATTR, list(config.get(rank, [])))
            marked += 1
        rank += 1
    return marked


def clear_alignment_keep(decoder: nn.Module) -> None:
    for layer in getattr(decoder, "layers", []):
        attention = getattr(layer, "cross_attn", None)
        if attention is not None and hasattr(attention, KEEP_ATTR):
            delattr(attention, KEEP_ATTR)
