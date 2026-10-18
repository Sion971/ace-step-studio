"""Attention of the streamed DiT without masks (small-GPU stream mode).

The regular path hands every DiT layer a full ``[1, 1, N, N]`` mask: an all-zero one for the full-attention layers and
the cross-attention, a band of ``|i - j| <= window`` for the sliding layers. A mask forbids the fast attention kernels, and the
band is computed as a whole N x N table (at 179 s: 2 238 tokens, a 257-token window uses 11 % of it). Measured on an
RTX 5060 at 179 s, the attention of one block costs 8.4 ms that way, 2.2 ms without masks.

This module gives the card copies of the blocks an attention function that needs no mask:

* full attention and cross-attention: ``flash_attn`` when it is installed (bfloat16 / float16, Ampere or newer), else the
  plain SDPA call without a mask;
* sliding layers: ``flash_attn`` with ``window_size``, else a banded attention made of torch operations only (each
  block of queries looks at the keys of its own block plus ``window`` on each side).

The DiT's own code already has a mask-free branch (``_attn_implementation == "flash_attention_2"``: it builds no mask at
all); the processor-side ``decoder.config`` is switched to that name so the masks are not even built, while the card
copies use ``ACESTEP_STREAM_ATTENTION_NAME`` (this function). Anything unexpected leaves the regular masks in place.
"""

import copy
import inspect
import os
from typing import Any, Optional

import torch
import torch.nn.functional as F
from loguru import logger

ENV_ATTENTION = "ACESTEP_STREAM_ATTENTION"
ATTENTION_NAME = "acestep_stream_attention"
MASKFREE_NAME = "flash_attention_2"  # the name the DiT code tests to skip building masks
_MASK_CACHE: dict = {}
_MASK_CACHE_LIMIT = 8
_STATE: dict = {"backend": None, "registered": False}


def requested() -> bool:
    """``ACESTEP_STREAM_ATTENTION=off`` (or 0 / no / sdpa) keeps the masks of the regular path."""
    return os.environ.get(ENV_ATTENTION, "auto").strip().lower() not in ("off", "0", "no", "false", "sdpa", "legacy")


def backend() -> Optional[str]:
    """``"flash"``, ``"torch"`` or None while attention is not set up."""
    return _STATE["backend"]


def _repeat_kv(x: torch.Tensor, groups: int) -> torch.Tensor:
    """``[B, Hkv, S, D]`` -> ``[B, Hkv * groups, S, D]`` (grouped-query attention)."""
    if groups == 1:
        return x
    b, hkv, s, d = x.shape
    return x[:, :, None, :, :].expand(b, hkv, groups, s, d).reshape(b, hkv * groups, s, d)


# ----------------------------------------------------------------------------------------------------------------
# Banded attention in torch operations (no flash_attn needed)
# ----------------------------------------------------------------------------------------------------------------
def _band_mask(seq: int, window: int, block: int, device: torch.device) -> torch.Tensor:
    """Boolean ``[nb, 1, block, block + 2 * window]`` mask of the blocks of :func:`banded_attention` (True = may attend)."""
    key = (seq, window, block, str(device))
    cached = _MASK_CACHE.get(key)
    if cached is not None:
        return cached
    nb = -(-seq // block)
    span = block + 2 * window
    a = torch.arange(block, device=device)[:, None]
    c = torch.arange(span, device=device)[None, :]
    band = ((c - a) >= 0) & ((c - a) <= 2 * window)                      # |query - key| <= window, block-relative
    starts = (torch.arange(nb, device=device) * block)[:, None]
    key_abs = starts + c - window                                         # [nb, span] absolute key position
    key_ok = (key_abs >= 0) & (key_abs < seq)                             # padding added around the sequence
    query_ok = (starts + torch.arange(block, device=device)[None, :]) < seq  # [nb, block]
    mask = (band[None] & key_ok[:, None, :]) | ~query_ok[:, :, None]      # padded query rows may see anything (dropped later)
    mask = mask[:, None]
    if len(_MASK_CACHE) >= _MASK_CACHE_LIMIT:
        _MASK_CACHE.clear()
    _MASK_CACHE[key] = mask
    return mask


def banded_attention(
    q: torch.Tensor, k: torch.Tensor, v: torch.Tensor, window: int, scale: Optional[float] = None, block: Optional[int] = None
) -> torch.Tensor:
    """Attention where position ``i`` sees positions ``j`` with ``|i - j| <= window``, without the full ``S x S`` table.

    ``q`` is ``[B, H, S, D]``; ``k`` and ``v`` are ``[B, H, S, D]`` too (grouped heads already repeated). The queries are cut
    in blocks; a block attends to the keys of its own span plus ``window`` on each side, through one batched SDPA call.
    """
    b, h, s, d = q.shape
    if s <= window + 1:  # the band covers the whole sequence
        return F.scaled_dot_product_attention(q, k, v, scale=scale)
    block = int(block) if block else max(2 * window, 16)
    nb = -(-s // block)
    padded = nb * block
    span = block + 2 * window
    q_b = F.pad(q, (0, 0, 0, padded - s)).view(b, h, nb, block, d).permute(0, 2, 1, 3, 4).reshape(b * nb, h, block, d)
    k_b = F.pad(k, (0, 0, window, window + padded - s)).unfold(2, span, block).permute(0, 2, 1, 4, 3).reshape(b * nb, h, span, d)
    v_b = F.pad(v, (0, 0, window, window + padded - s)).unfold(2, span, block).permute(0, 2, 1, 4, 3).reshape(b * nb, h, span, d)
    mask = _band_mask(s, window, block, q.device)
    if b > 1:
        mask = mask.repeat(b, 1, 1, 1)
    out = F.scaled_dot_product_attention(q_b, k_b, v_b, attn_mask=mask, scale=scale)
    return out.view(b, nb, h, block, d).permute(0, 2, 1, 3, 4).reshape(b, h, padded, d)[:, :, :s]


# ----------------------------------------------------------------------------------------------------------------
# The attention function registered for the card copies
# ----------------------------------------------------------------------------------------------------------------
def _flash_func() -> Any:
    from flash_attn import flash_attn_func  # imported on use: the package is optional

    return flash_attn_func


def stream_attention(
    module: Any,
    query: torch.Tensor,
    key: torch.Tensor,
    value: torch.Tensor,
    attention_mask: Optional[torch.Tensor] = None,
    dropout: float = 0.0,
    scaling: Optional[float] = None,
    sliding_window: Optional[int] = None,
    **kwargs: Any,
):
    """Attention of one DiT layer. ``query`` is ``[B, H, S, D]``, ``key`` / ``value`` ``[B, Hkv, Sk, D]``; returns ``([B, S, H, D], None)``.

    A call that carries a mask (or dropout) is not ours to simplify: it goes to the regular SDPA function unchanged.
    """
    if attention_mask is not None or dropout:
        from transformers.modeling_utils import ALL_ATTENTION_FUNCTIONS

        return ALL_ATTENTION_FUNCTIONS["sdpa"](module, query, key, value, attention_mask, dropout=dropout,
                                               scaling=scaling, sliding_window=sliding_window, **kwargs)
    windowed = sliding_window is not None and query.shape[2] == key.shape[2]
    if _STATE["backend"] == "flash" and query.dtype in (torch.bfloat16, torch.float16) and query.is_cuda:
        try:
            out = _flash_func()(
                query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2),
                softmax_scale=scaling, causal=False,
                window_size=(int(sliding_window), int(sliding_window)) if windowed else (-1, -1),
            )
            return out, None
        except Exception as exc:  # a kernel that fails once will fail again: the torch path takes over for good
            _STATE["backend"] = "torch"
            logger.warning("[small_gpu_stream] flash_attn failed ({}: {}): attention continues with torch operations.",
                           type(exc).__name__, exc)
    groups = query.shape[1] // key.shape[1]
    k, v = _repeat_kv(key, groups), _repeat_kv(value, groups)
    if windowed:
        out = banded_attention(query, k, v, int(sliding_window), scaling)
    else:
        out = F.scaled_dot_product_attention(query, k, v, scale=scaling)
    return out.transpose(1, 2).contiguous(), None


# ----------------------------------------------------------------------------------------------------------------
# Setting up
# ----------------------------------------------------------------------------------------------------------------
def register() -> bool:
    """Make ``ATTENTION_NAME`` known to transformers' attention registry. False when this transformers has no such registry."""
    if _STATE["registered"]:
        return True
    try:
        from transformers import AttentionInterface

        AttentionInterface.register(ATTENTION_NAME, stream_attention)
        _STATE["registered"] = True
        return True
    except Exception as exc:
        logger.info("[small_gpu_stream] attention registry unavailable ({}: {}): regular masks kept.", type(exc).__name__, exc)
        return False


def pick_backend(device: torch.device, dtype: torch.dtype) -> str:
    """``"flash"`` when flash_attn runs on this card (checked with a tiny windowed call), else ``"torch"``."""
    if device.type != "cuda" or dtype not in (torch.bfloat16, torch.float16):
        return "torch"
    try:
        if torch.cuda.get_device_capability(device)[0] < 8:
            return "torch"
        func = _flash_func()
        probe = torch.randn(1, 64, 4, 64, device=device, dtype=dtype)
        func(probe, probe, probe, causal=False, window_size=(8, 8))
        func(probe, probe, probe, causal=False)
        torch.cuda.synchronize(device)
        return "flash"
    except Exception as exc:
        logger.info("[small_gpu_stream] flash_attn not usable here ({}: {}): banded attention in torch.", type(exc).__name__, exc)
        return "torch"


def decoder_skips_masks(decoder: Any) -> bool:
    """True when the DiT's forward has the branch that builds no masks (it tests for the flash-attention name)."""
    try:
        return MASKFREE_NAME in inspect.getsource(type(decoder).forward)
    except Exception:
        return False


def private_config(module: Any, name: str) -> None:
    """Give every module of ``module`` that holds a model config its own copy of it, set to attention ``name``."""
    copies: dict = {}
    for sub in module.modules():
        cfg = sub.__dict__.get("config")
        if cfg is None or not hasattr(cfg, "_attn_implementation"):
            continue
        new = copies.get(id(cfg))
        if new is None:
            new = copies[id(cfg)] = copy.copy(cfg)
            new._attn_implementation = name
        sub.config = new


def enable(decoder: Any, pool: Any, device: torch.device) -> bool:
    """Switch the DiT to mask-free attention. Never raises; False (and the regular path untouched) when anything is unsuitable."""
    if not requested():
        logger.info("[small_gpu_stream] mask-free attention off ({}={}): regular masks.", ENV_ATTENTION, os.environ.get(ENV_ATTENTION))
        return False
    try:
        dtype = pool.compute_dtype
        if dtype not in (torch.bfloat16, torch.float16):
            return False  # float32 compute (small cards): the regular path stays as it is
        if not decoder_skips_masks(decoder):
            logger.info("[small_gpu_stream] this DiT has no mask-free branch: regular masks.")
            return False
        if not register():
            return False
        chosen = pick_backend(device, dtype)
        _STATE["backend"] = chosen
        host = copy.copy(decoder.config)
        host._attn_implementation = MASKFREE_NAME  # processor side: the forward builds no mask
        decoder.config = host
        pool.set_attention(ATTENTION_NAME)
        pool.mask_free = True
        logger.info("[small_gpu_stream] DiT attention without masks ({}).",
                    "flash_attn, window in the kernel" if chosen == "flash" else "torch operations, banded for the sliding layers")
        return True
    except Exception as exc:
        _STATE["backend"] = None
        logger.warning("[small_gpu_stream] mask-free attention not set up ({}: {}): regular masks.", type(exc).__name__, exc)
        return False


def reference_mask(seq: int, window: int, dtype: torch.dtype = torch.float32) -> torch.Tensor:
    """The additive ``[1, 1, S, S]`` mask of a sliding layer (what the regular path builds), for the self-check's processor run."""
    idx = torch.arange(seq)
    valid = (idx[:, None] - idx[None, :]).abs() <= window
    zero = torch.zeros((), dtype=dtype)
    return torch.where(valid, zero, torch.full((), torch.finfo(dtype).min, dtype=dtype))[None, None]
