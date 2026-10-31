"""Block-by-block weight streaming for LoRA training on a small card.

The DiT is a stack of identical blocks (`decoder.layers`).  Training a LoRA only needs gradients for the few adapter
weights, but the frozen base weights of a block are needed twice per step: once for the forward pass and once more for the
backward pass (which, with gradient checkpointing, first recomputes the block).  Instead of keeping the whole model on the
card, the frozen weights stay in (pinned) RAM and each block copies its own weights to the card just before it runs and
lets them go right after.

How it fits in:

* the module tree is NOT changed (no wrapper module): the names of the parameters stay what they were, so a LoRA saved
  through PEFT / the trainer's own code keeps the same keys.  Only the `forward` of each block is replaced.
* the trainable parameters (the LoRA matrices) are moved to the card once and stay there.
* each block runs under `torch.utils.checkpoint` (non reentrant): the forward keeps only the block's input; the backward
  reruns the block, which loads the weights a second time.  The copies of the weights that autograd keeps for the backward
  of that block are freed as soon as it is done.
* the block's own `gradient_checkpointing` flag is turned off so that it does not checkpoint a second time.

Nothing here depends on CUDA: on a machine without a card the "device" can be the CPU, which is what the equivalence test
does (same gradients as a normal run).
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

import torch
import torch.nn as nn
from torch.utils.checkpoint import checkpoint

logger = logging.getLogger(__name__)

_MARK = "_block_stream"


def _frozen_params(layer: nn.Module) -> List[Tuple[nn.Module, str, torch.Tensor]]:
    """Every frozen parameter of the block as (owner module, attribute name, tensor)."""
    found = []
    for module in layer.modules():
        for name, param in list(module._parameters.items()):
            if param is not None and not param.requires_grad:
                found.append((module, name, param))
    return found


def _frozen_buffers(layer: nn.Module) -> List[Tuple[nn.Module, str, torch.Tensor]]:
    found = []
    for module in layer.modules():
        for name, buf in list(module._buffers.items()):
            if buf is not None:
                found.append((module, name, buf))
    return found


def _pin(tensor: torch.Tensor) -> torch.Tensor:
    """Pinned RAM makes the copy to the card asynchronous and faster; silently skipped when it is not possible."""
    if tensor.is_cuda or not torch.cuda.is_available():
        return tensor
    try:
        return tensor.pin_memory()
    except RuntimeError:  # not enough lockable memory
        return tensor


@contextmanager
def _on_card(
    items: List[Tuple[nn.Module, str, torch.Tensor]],
    copier: Callable[[torch.Tensor], torch.Tensor],
    buffers: bool = False,
):
    """Put copies of the frozen tensors on the card for the duration of the block.

    The module keeps its CPU tensors afterwards.  The copies that autograd saved for the backward stay alive until that
    backward is done (they are referenced by the graph, not by the module), which is exactly the lifetime wanted.
    """
    slot = "_buffers" if buffers else "_parameters"
    for module, name, tensor in items:
        copy = copier(tensor)
        if buffers:
            module._buffers[name] = copy
        else:
            # a plain tensor (not a Parameter): it is only read by the block, and carries no gradient
            module._parameters[name] = copy  # type: ignore[assignment]
    try:
        yield
    finally:
        for module, name, tensor in items:
            getattr(module, slot)[name] = tensor


def enable_block_streaming(
    layers: Iterable[nn.Module],
    device: torch.device | str,
    pin: bool = True,
    checkpoint_kwargs: Optional[Dict[str, Any]] = None,
    copier: Optional[Callable[[torch.Tensor], torch.Tensor]] = None,
) -> int:
    """Turn every block into a streamed, checkpointed block.  Returns the number of blocks converted.

    Call it once the adapters are injected (so the trainable parameters are known) and before the optimizer is built.
    The trainable parameters of the blocks are moved to ``device``; the frozen ones stay where they are (put on the CPU
    before calling, ideally already in the compute dtype).
    """
    device = torch.device(device)
    if copier is None:
        def copier(t: torch.Tensor) -> torch.Tensor:  # noqa: F811 - default: a copy on the card
            return t.detach().to(device, non_blocking=True)
    ckpt_kwargs = {"use_reentrant": False}
    if checkpoint_kwargs:
        ckpt_kwargs.update(checkpoint_kwargs)

    count = 0
    for layer in layers:
        if getattr(layer, _MARK, False):
            continue

        for module in layer.modules():
            for name, param in list(module._parameters.items()):
                if param is None:
                    continue
                if param.requires_grad:
                    param.data = param.data.to(device)  # the adapters live on the card for good
                else:
                    param.data = _pin(param.data) if pin else param.data

        frozen = _frozen_params(layer)
        buffers = _frozen_buffers(layer)
        original_forward = layer.forward

        # the block must not checkpoint on its own on top of ours (Hugging Face's GradientCheckpointingLayer does)
        if hasattr(layer, "gradient_checkpointing"):
            layer.gradient_checkpointing = False

        def streamed_forward(*args, _layer=layer, _fwd=original_forward, _frozen=frozen, _buffers=buffers, **kwargs):
            def run(*a, **kw):
                with _on_card(_frozen, copier), _on_card(_buffers, copier, buffers=True):
                    return _fwd(*a, **kw)

            if torch.is_grad_enabled() and _layer.training:
                return checkpoint(run, *args, **ckpt_kwargs, **kwargs)
            return run(*args, **kwargs)

        layer.forward = streamed_forward  # type: ignore[method-assign]
        setattr(layer, _MARK, True)
        count += 1

    logger.info("[block-stream] %d blocks stream their frozen weights to %s", count, device)
    return count


def disable_block_streaming(layers: Iterable[nn.Module]) -> int:
    """Undo `enable_block_streaming` (the forward comes back; the weights stay where they are)."""
    count = 0
    for layer in layers:
        if getattr(layer, _MARK, False):
            if "forward" in layer.__dict__:
                del layer.__dict__["forward"]
            delattr(layer, _MARK)
            count += 1
    return count


def find_layers(decoder: nn.Module) -> nn.ModuleList:
    """The stack of blocks of a decoder, whether it is bare, wrapped by PEFT or wrapped by Fabric."""
    module = getattr(decoder, "_forward_module", decoder)
    if hasattr(module, "get_base_model"):
        module = module.get_base_model()
    layers = getattr(module, "layers", None)
    if layers is None:
        raise RuntimeError("block streaming: no `layers` found on the decoder")
    return layers


def move_outside_layers(root: nn.Module, layers: nn.Module, device: torch.device | str) -> int:
    """Move every parameter and buffer of ``root`` that does not belong to ``layers`` to ``device`` (in place).

    These are the small parts around the stack of blocks (input projection, timestep embeddings, output head, rotary
    tables...).  Returns the number of tensors moved.
    """
    device = torch.device(device)
    inside = {id(t) for t in layers.parameters()} | {id(t) for t in layers.buffers()}
    moved = 0
    for module in root.modules():
        for name, param in list(module._parameters.items()):
            if param is not None and id(param) not in inside and param.device != device:
                param.data = param.data.to(device)
                moved += 1
        for name, buf in list(module._buffers.items()):
            if buf is not None and id(buf) not in inside and buf.device != device:
                module._buffers[name] = buf.to(device)
                moved += 1
    return moved


def keep_layers_unwrapped(layers: Iterable[nn.Module]) -> None:
    """Turn the blocks' own checkpointing flag off again (Hugging Face's ``gradient_checkpointing_enable`` sets it)."""
    for layer in layers:
        if getattr(layer, _MARK, False) and hasattr(layer, "gradient_checkpointing"):
            layer.gradient_checkpointing = False


# ---------------------------------------------------------------------------
# Attention in slices of queries (cards without bf16 attention kernels)
# ---------------------------------------------------------------------------
_SDPA_STATE: Dict[str, Any] = {"original": None}


def wants_chunked_attention(device: Any) -> bool:
    """True on cards older than Ampere (compute capability below 8): they have no bf16 memory-efficient attention kernel, so
    PyTorch falls back to the plain one, which builds the whole ``heads x N x N`` table (about 400 MiB for 200 s of music, and
    several of them in the backward pass). ``ACESTEP_CHUNKED_ATTENTION=on`` / ``off`` overrides the choice."""
    import os

    choice = os.environ.get("ACESTEP_CHUNKED_ATTENTION", "auto").strip().lower()
    if choice in ("on", "1", "yes", "true"):
        return True
    if choice in ("off", "0", "no", "false"):
        return False
    if not torch.cuda.is_available():
        return False
    return torch.cuda.get_device_capability(device)[0] < 8


def _make_chunked_sdpa(original: Callable, budget_bytes: int) -> Callable:
    def sdpa(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, **kwargs):
        if is_causal or dropout_p or query.dim() != 4 or key.dim() != 4:
            return original(query, key, value, attn_mask=attn_mask, dropout_p=dropout_p, is_causal=is_causal,
                            scale=scale, **kwargs)
        batch, heads, q_len, _ = query.shape
        k_len = key.shape[-2]
        rows = max(16, int(budget_bytes // max(1, batch * heads * k_len * 4)))  # the table is counted in float32
        if rows >= q_len:
            return original(query, key, value, attn_mask=attn_mask, scale=scale, **kwargs)
        grad = torch.is_grad_enabled() and (query.requires_grad or key.requires_grad or value.requires_grad)

        def part(q_part, k_all, v_all, m_part):
            return original(q_part, k_all, v_all, attn_mask=m_part, scale=scale, **kwargs)

        outs = []
        for start in range(0, q_len, rows):
            stop = min(start + rows, q_len)
            m_part = attn_mask
            if attn_mask is not None and attn_mask.dim() >= 2 and attn_mask.shape[-2] == q_len:
                m_part = attn_mask[..., start:stop, :]
            q_part = query[:, :, start:stop]
            if grad:  # the table of one slice is rebuilt in the backward pass instead of being kept
                outs.append(checkpoint(part, q_part, key, value, m_part, use_reentrant=False))
            else:
                outs.append(part(q_part, key, value, m_part))
        return torch.cat(outs, dim=-2)

    return sdpa


def enable_chunked_attention(budget_mib: int = 48) -> bool:
    """Replace ``torch.nn.functional.scaled_dot_product_attention`` by a version that works on slices of queries so that the
    attention table of a slice stays under ``budget_mib`` MiB. Same results as the original (each query row is independent);
    calls that are small enough, causal or with dropout go to the original untouched. Returns False if already on."""
    import torch.nn.functional as F

    if _SDPA_STATE["original"] is not None:
        return False
    _SDPA_STATE["original"] = F.scaled_dot_product_attention
    F.scaled_dot_product_attention = _make_chunked_sdpa(_SDPA_STATE["original"], int(budget_mib) * 2**20)
    return True


def disable_chunked_attention() -> bool:
    import torch.nn.functional as F

    if _SDPA_STATE["original"] is None:
        return False
    F.scaled_dot_product_attention = _SDPA_STATE["original"]
    _SDPA_STATE["original"] = None
    return True

