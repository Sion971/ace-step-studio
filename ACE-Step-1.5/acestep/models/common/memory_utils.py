"""Memory optimization utilities for ACE-Step DiT models.

Provides:
- Chunked FFN: split MLP forward along sequence dimension to reduce peak activations.
- Pinned memory helpers for faster CPU↔GPU offload transfers.
"""

import os
import math

import torch
from torch import nn, Tensor
from loguru import logger


# ---------------------------------------------------------------------------
# Environment-based feature flags
# ---------------------------------------------------------------------------
# Number of FFN chunks (0 or 1 = disabled). Higher values = less peak VRAM
# but slightly more kernel launches.  2-4 is the sweet spot.
CHUNKED_FFN_CHUNKS = int(os.environ.get("ACESTEP_CHUNKED_FFN", "2"))

# Enable pinned memory for offload weights (only effective on CUDA).
# Pinned memory locks weights in physical RAM (non-pageable) for faster
# DMA transfers. Disable on systems with limited RAM (<32GB).
PINNED_MEMORY_ENABLED = os.environ.get("ACESTEP_PINNED_MEMORY", "0") == "1"


# ---------------------------------------------------------------------------
# Chunked FFN
# ---------------------------------------------------------------------------
def chunked_ffn_forward(
    mlp: nn.Module,
    hidden_states: Tensor,
    num_chunks: int = 2,
) -> Tensor:
    """Run MLP forward in chunks along the sequence dimension.

    Splits ``hidden_states`` (shape ``[B, S, D]``) into ``num_chunks``
    along ``S``, processes each independently through the MLP, and
    concatenates results.  Peak activation memory is reduced because
    only one chunk's intermediate activations exist at a time.

    For Qwen3MLP (SwiGLU): ``down_proj(act(gate_proj(x)) * up_proj(x))``
    the intermediate tensors are ``[B, S/N, intermediate_size]`` instead
    of ``[B, S, intermediate_size]``.

    Args:
        mlp: The MLP module (must have a ``forward(x)`` method).
        hidden_states: Input tensor ``[B, S, D]``.
        num_chunks: Number of chunks.  1 = no chunking (passthrough).

    Returns:
        Output tensor ``[B, S, D]`` — same as ``mlp(hidden_states)``.
    """
    # NOTE: when torch.compile is active, varying seq_len causes recompilation
    # because chunk_size changes. Set ACESTEP_CHUNKED_FFN=1 if using torch.compile.
    if num_chunks <= 1:
        return mlp(hidden_states)

    seq_len = hidden_states.shape[1]
    if seq_len <= num_chunks:
        return mlp(hidden_states)

    chunk_size = math.ceil(seq_len / num_chunks)
    chunks = hidden_states.split(chunk_size, dim=1)
    output_chunks = []
    for chunk in chunks:
        output_chunks.append(mlp(chunk))
    return torch.cat(output_chunks, dim=1)


# ---------------------------------------------------------------------------
# Pinned memory helpers
# ---------------------------------------------------------------------------
def pin_module_memory(module: nn.Module) -> int:
    """Pin all CPU parameter tensors of a module into page-locked memory.

    Page-locked (pinned) memory enables faster DMA transfers between
    CPU and GPU, giving 20-40% speedup for offload workflows.

    Only pins parameters that are on CPU and not already pinned.
    Respects system RAM limits — will stop pinning if allocation fails.

    Note: pinned memory is non-pageable and stays locked in physical RAM.
    Call ``unpin_module_memory`` before loading back to GPU to release.

    Args:
        module: The nn.Module whose CPU parameters to pin.

    Returns:
        Number of parameters successfully pinned.
    """
    if not torch.cuda.is_available():
        return 0
    if not PINNED_MEMORY_ENABLED:
        return 0

    pinned_count = 0
    total_bytes = 0

    for name, param in module.named_parameters():
        if param.device.type != "cpu":
            continue
        if param.data.is_pinned():
            continue
        try:
            param.data = param.data.pin_memory()
            pinned_count += 1
            total_bytes += param.data.nelement() * param.data.element_size()
        except RuntimeError:
            logger.warning(
                f"[pin_module_memory] Failed to pin '{name}' "
                f"({param.data.nelement() * param.data.element_size() / 1024 / 1024:.1f} MB). "
                f"System pinned memory limit likely reached."
            )
            break

    if pinned_count > 0:
        logger.info(
            f"[pin_module_memory] Pinned {pinned_count} parameters "
            f"({total_bytes / 1024 / 1024:.1f} MB) to page-locked memory."
        )
    return pinned_count


def unpin_module_memory(module: nn.Module) -> int:
    """Unpin page-locked parameter tensors back to regular CPU memory.

    Frees the physical RAM lock so the OS can swap pages if needed.

    Args:
        module: The nn.Module whose parameters to unpin.

    Returns:
        Number of parameters unpinned.
    """
    unpinned = 0
    for _name, param in module.named_parameters():
        if param.device.type != "cpu":
            continue
        if not param.data.is_pinned():
            continue
        param.data = param.data.clone()
        unpinned += 1
    return unpinned
