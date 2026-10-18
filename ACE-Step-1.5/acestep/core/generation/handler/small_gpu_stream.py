"""Small-GPU mode (about 2 GB of VRAM): stream the DiT block by block, decode audio on the card.

A 2 GB card cannot hold the DiT (about 1.6 billion parameters), so ACE-Step falls back to the
processor, where a 30 s track takes about 7 minutes. This module keeps the engine in processor mode
and uses the card for the two heavy steps only:

* DiT diffusion: the weights of the 24 transformer blocks stay in RAM (bfloat16); each block is copied
  into one of two float32 slots on the card, computed there, then replaced by the next block (the next
  copy overlaps the current computation). Peak VRAM is the size of two blocks plus the activations
  (about 0.8 GB for 30 s of audio). Everything else (text encoder, condition encoder, sampler, DCW)
  keeps running on the processor, so the rest of the engine is unaware of the card.
* Condition encoder: the 12 text/lyric/timbre layers (and the 4 layers of the audio tokenizer/detokenizer) go
  through a second, smaller pool the same way. When the generation is not a cover, the tokenizer/detokenizer
  step is skipped: its result is discarded by the engine in that case, so the output is identical.
* VAE decode: float32 on the card in small tiles (96 latent frames, overlap 16).

Measured on a GTX 1050 (2 GB): one DiT step 12.7 s (processor) -> 1.26 s; VAE decode 170 s -> about 10 s;
streamed output equal to the processor output (relative difference 2e-6).

Opt-in: ``ACESTEP_SMALL_GPU_STREAM=1`` (written by the Studio launcher for cards of 3 GB or less).
Not supported in this mode: LoRA adapters (the blocks are replaced by streamed proxies).
"""

from __future__ import annotations

import copy
import gc
import os
from typing import Any, List, Optional

import torch
from loguru import logger
from torch import nn

ENV_FLAG = "ACESTEP_SMALL_GPU_STREAM"
ENV_VAE_CHUNK = "ACESTEP_STREAM_VAE_CHUNK"
ENV_CPU_DTYPE = "ACESTEP_STREAM_CPU_DTYPE"
DEFAULT_VAE_CHUNK = 96
DEFAULT_VAE_OVERLAP = 16
_SIMPLE_TYPES = (int, float, bool, str, type(None))

# The pool attached to the loaded DiT, if any (one DiT per handler process).
_ACTIVE_POOL: Optional["StreamPool"] = None
# The pool of the condition encoder (lyric + timbre + tokenizer + detokenizer layers), if any.
_ENCODER_POOL: Optional["StreamPool"] = None


def _truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


def requested() -> bool:
    """True when the launcher asked for the small-GPU mode (whether or not a card is usable)."""
    return _truthy(os.environ.get(ENV_FLAG))


def enabled() -> bool:
    """True when the mode is requested AND a CUDA card is available."""
    if not requested():
        return False
    try:
        return torch.cuda.is_available()
    except Exception:  # pragma: no cover - a broken driver must not break startup
        return False


def active() -> bool:
    """True once the DiT has been attached to the pool (the mode is really running)."""
    return _ACTIVE_POOL is not None


def lora_blocked_message() -> Optional[str]:
    """Message to show when a LoRA is requested while the DiT is streamed, else None."""
    if not active():
        return None
    return (
        "❌ LoRA adapters are not supported in small-GPU mode (the DiT is streamed block by block). "
        "Use a card with more memory or the regular processor mode to apply a LoRA."
    )


# ----------------------------------------------------------------------------------------------------------------
# Moving call arguments between processor and card
# ----------------------------------------------------------------------------------------------------------------
def _to_device(obj: Any, device: torch.device) -> Any:
    if torch.is_tensor(obj):
        if obj.is_floating_point():
            return obj.to(device=device, dtype=torch.float32, non_blocking=True)
        return obj.to(device=device, non_blocking=True)
    if isinstance(obj, tuple):
        return tuple(_to_device(o, device) for o in obj)
    if isinstance(obj, list):
        return [_to_device(o, device) for o in obj]
    if isinstance(obj, dict):
        return {k: _to_device(v, device) for k, v in obj.items()}
    return obj  # caches and other objects keep their own tensors (created on the card by the slot)


def _to_cpu(obj: Any) -> Any:
    if torch.is_tensor(obj):
        return obj.to("cpu")
    if isinstance(obj, tuple):
        return tuple(_to_cpu(o) for o in obj)
    if isinstance(obj, list):
        return [_to_cpu(o) for o in obj]
    if isinstance(obj, dict):
        return {k: _to_cpu(v) for k, v in obj.items()}
    return obj


# ----------------------------------------------------------------------------------------------------------------
# Block pool
# ----------------------------------------------------------------------------------------------------------------
class StreamPool:
    """All block weights in RAM; two float32 slots on the card that blocks pass through."""

    def __init__(self, real_layers: List[nn.Module], device: torch.device, cpu_dtype: torch.dtype, pin: bool = True):
        self.dev = device
        self.cuda = device.type == "cuda"
        self.n_slots = 2
        self.count = len(real_layers)
        self.real = real_layers
        self._check_layers(real_layers)

        # RAM copy of every block's parameters (bfloat16 by default: exact for bfloat16 checkpoints, half the
        # RAM and half the PCIe traffic of float32).
        self.cpu_params: List[List[torch.Tensor]] = []
        for layer in real_layers:
            tensors = []
            for p in layer.parameters():
                data = p.data.detach().to(device="cpu", dtype=cpu_dtype).contiguous()
                if pin and self.cuda:
                    try:
                        data = data.pin_memory()
                    except Exception:  # not enough lockable RAM: keep pageable memory
                        pin = False
                p.data = data  # drops the original (float32) storage
                tensors.append(data)
            self.cpu_params.append(tensors)
        self.attrs = [self._snapshot(layer) for layer in real_layers]
        self.bytes_per_layer = sum(t.numel() * t.element_size() for t in self.cpu_params[0])
        self._template = real_layers[0]
        self.slots: List[nn.Module] = []
        self.slot_params: List[List[torch.Tensor]] = []
        self.loaded: List[int] = []
        self._copy_stream = None
        self._ready: List[Any] = []
        self._free: List[Any] = []
        self.ensure_gpu()

    @staticmethod
    def _check_layers(layers: List[nn.Module]) -> None:
        if not layers:
            raise RuntimeError("the DiT has no layers to stream")
        shapes0 = [tuple(p.shape) for p in layers[0].parameters()]
        for i, layer in enumerate(layers):
            if any(True for _ in layer.buffers()):
                raise RuntimeError(f"block {i} has buffers: streaming only supports parameter-only blocks")
            if [tuple(p.shape) for p in layer.parameters()] != shapes0:
                raise RuntimeError(f"block {i} differs in structure from block 0 (LoRA or quantization applied?)")
            for p in layer.parameters():
                if type(p.data) is not torch.Tensor:
                    raise RuntimeError("quantized or wrapped weights cannot be streamed (disable quantization)")

    @staticmethod
    def _snapshot(layer: nn.Module) -> List[dict]:
        return [
            {k: v for k, v in m.__dict__.items() if isinstance(v, _SIMPLE_TYPES) and k != "training"}
            for m in layer.modules()
        ]

    # -- card memory ---------------------------------------------------------------------------------------------
    def ensure_gpu(self) -> None:
        """Create the two float32 slots on the card if they do not exist (first use, or after release_gpu)."""
        if self.slots:
            return
        # Normal tensors even when called inside torch.inference_mode(): inference tensors cannot be updated in place
        # from outside inference mode, and the slots are refilled on every block.
        with torch.inference_mode(False):
            for _ in range(self.n_slots):
                slot = copy.deepcopy(self._template).to(device=self.dev, dtype=torch.float32).eval()
                params = list(slot.parameters())
                for p in params:
                    p.requires_grad_(False)
                self.slots.append(slot)
                self.slot_params.append(params)
        self.loaded = [-1] * self.n_slots
        if self.cuda:
            self._copy_stream = torch.cuda.Stream(self.dev)
            self._ready = [torch.cuda.Event() for _ in range(self.n_slots)]
            self._free = [torch.cuda.Event() for _ in range(self.n_slots)]
            for ev in self._free:
                ev.record(torch.cuda.current_stream(self.dev))

    def release_gpu(self) -> None:
        """Give the card back (before the VAE decode needs it)."""
        if not self.slots:
            return
        if self.cuda:
            torch.cuda.synchronize(self.dev)
        self.slots, self.slot_params, self.loaded = [], [], []
        self._copy_stream, self._ready, self._free = None, [], []
        gc.collect()
        if self.cuda:
            torch.cuda.empty_cache()

    # -- streaming -----------------------------------------------------------------------------------------------
    @torch.no_grad()
    def _load(self, layer_idx: int, slot_idx: int) -> None:
        if self.cuda:
            with torch.cuda.stream(self._copy_stream):
                self._copy_stream.wait_event(self._free[slot_idx])  # the previous computation in this slot is over
                for dst, src in zip(self.slot_params[slot_idx], self.cpu_params[layer_idx]):
                    dst.copy_(src.to(self.dev, non_blocking=True))  # bf16 over the bus, float32 on the card
                self._ready[slot_idx].record(self._copy_stream)
        else:
            for dst, src in zip(self.slot_params[slot_idx], self.cpu_params[layer_idx]):
                dst.copy_(src)
        for module, attrs in zip(self.slots[slot_idx].modules(), self.attrs[layer_idx]):
            module.__dict__.update(attrs)  # attention type, layer index... differ from block to block
        self.loaded[slot_idx] = layer_idx

    def acquire(self, layer_idx: int) -> nn.Module:
        self.ensure_gpu()
        slot = layer_idx % self.n_slots
        if self.loaded[slot] != layer_idx:
            self._load(layer_idx, slot)
        if self.cuda:
            torch.cuda.current_stream(self.dev).wait_event(self._ready[slot])
        nxt = (layer_idx + 1) % self.count
        nxt_slot = nxt % self.n_slots
        if nxt_slot != slot and self.loaded[nxt_slot] != nxt:
            self._load(nxt, nxt_slot)  # copy of the next block overlaps the computation of this one
        return self.slots[slot]

    def release(self, layer_idx: int) -> None:
        if self.cuda:
            self._free[layer_idx % self.n_slots].record(torch.cuda.current_stream(self.dev))


class StreamedLayer(nn.Module):
    """Stand-in for one DiT block: same interface, computed in a card slot.

    The real block is kept outside the module tree (``object.__setattr__``) so ``model.to(...)`` and
    ``parameters()`` never see its weights; attributes the DiT reads (``attention_type``,
    ``use_cross_attention``) are forwarded to it.
    """

    def __init__(self, index: int, real: nn.Module, pool: StreamPool):
        super().__init__()
        object.__setattr__(self, "_s_index", index)
        object.__setattr__(self, "_s_real", real)
        object.__setattr__(self, "_s_pool", pool)

    def __getattr__(self, name: str):
        try:
            return super().__getattr__(name)
        except AttributeError:
            return getattr(object.__getattribute__(self, "_s_real"), name)

    def forward(self, *args, **kwargs):
        pool: StreamPool = object.__getattribute__(self, "_s_pool")
        index: int = object.__getattribute__(self, "_s_index")
        slot = pool.acquire(index)
        dev = pool.dev
        try:
            out = slot(*_to_device(args, dev), **_to_device(kwargs, dev))
        except torch.cuda.OutOfMemoryError:
            logger.error(
                "[small_gpu_stream] the card ran out of memory in block {}: the track is too long for this card. "
                "Try a shorter duration (the whole DiT needs about 0.8 GB of VRAM for 30 s of audio).", index,
            )
            raise
        pool.release(index)
        return _to_cpu(out)


# ----------------------------------------------------------------------------------------------------------------
# Attaching to the loaded model
# ----------------------------------------------------------------------------------------------------------------
def install(decoder: nn.Module, device: torch.device, cpu_dtype: torch.dtype = torch.bfloat16, pin: bool = True) -> StreamPool:
    """Replace ``decoder.layers`` by streamed proxies and return the pool (no environment checks)."""
    layers = list(decoder.layers)
    pool = StreamPool(layers, device, cpu_dtype, pin=pin)
    decoder.layers = nn.ModuleList([StreamedLayer(i, layer, pool) for i, layer in enumerate(layers)])
    return pool


def attach_if_enabled(model: nn.Module, quantized: bool = False) -> bool:
    """Replace the DiT blocks of ``model.decoder`` by streamed proxies. Returns True when the mode is active.

    Never raises: on any problem the engine keeps its regular processor mode and the reason is logged.
    """
    global _ACTIVE_POOL
    if not requested():
        return False
    if not enabled():
        logger.warning("[small_gpu_stream] {}=1 but no CUDA card is available: regular processor mode.", ENV_FLAG)
        return False
    if quantized:
        logger.warning("[small_gpu_stream] quantized DiT cannot be streamed: regular processor mode.")
        return False
    try:
        decoder = model.decoder
        layers = list(decoder.layers)  # only to report the count below
        dtype_name = os.environ.get(ENV_CPU_DTYPE, "bfloat16").strip().lower()
        cpu_dtype = torch.float32 if dtype_name in ("float32", "fp32") else torch.bfloat16
        device = torch.device("cuda")
        free_before = torch.cuda.mem_get_info(device)[0] / 1024**3
        pool = install(decoder, device, cpu_dtype)
        _ACTIVE_POOL = pool
        attach_encoder(model, device, cpu_dtype)
        gc.collect()
        logger.info(
            "[small_gpu_stream] DiT streamed through {}: {} blocks, {:.0f} MB per block in {} RAM, "
            "2 float32 slots on the card ({:.2f} GB free before).",
            torch.cuda.get_device_name(device), len(layers), pool.bytes_per_layer / 1024**2,
            "bfloat16" if cpu_dtype == torch.bfloat16 else "float32", free_before,
        )
        return True
    except Exception as exc:
        logger.warning("[small_gpu_stream] could not stream the DiT ({}: {}): regular processor mode.", type(exc).__name__, exc)
        _ACTIVE_POOL = None
        return False


def release_gpu() -> None:
    """Free the card's slots (DiT and condition encoder); they are recreated on the next use."""
    if _ACTIVE_POOL is not None:
        _ACTIVE_POOL.release_gpu()
    if _ENCODER_POOL is not None:
        _ENCODER_POOL.release_gpu()


# ----------------------------------------------------------------------------------------------------------------
# Condition encoder
# ----------------------------------------------------------------------------------------------------------------
def _encoder_holders(model: nn.Module) -> List[nn.Module]:
    """The sub-modules owning a ``layers`` list of encoder blocks, in execution order (missing ones are skipped)."""
    paths = (
        ("encoder", "lyric_encoder"),
        ("encoder", "timbre_encoder"),
        ("tokenizer", "attention_pooler"),
        ("detokenizer",),
    )
    holders = []
    for path in paths:
        obj: Any = model
        for name in path:
            obj = getattr(obj, name, None)
            if obj is None:
                break
        if obj is not None and len(getattr(obj, "layers", [])) > 0:
            holders.append(obj)
    return holders


def install_encoder(model: nn.Module, device: torch.device, cpu_dtype: torch.dtype = torch.bfloat16, pin: bool = True) -> StreamPool:
    """Stream the condition-encoder blocks of ``model`` through one pool (no environment checks)."""
    holders = _encoder_holders(model)
    if not holders:
        raise RuntimeError("no condition-encoder layers found")
    flat = [layer for holder in holders for layer in holder.layers]
    pool = StreamPool(flat, device, cpu_dtype, pin=pin)
    index = 0
    for holder in holders:
        proxies = []
        for layer in holder.layers:
            proxies.append(StreamedLayer(index, layer, pool))
            index += 1
        holder.layers = nn.ModuleList(proxies)
    return pool


def _is_plain_generation(is_covers: Any, precomputed_lm_hints_25Hz: Any, audio_codes: Any) -> bool:
    """True when ``prepare_condition`` would throw away the tokenizer/detokenizer result (not a cover)."""
    if precomputed_lm_hints_25Hz is not None or audio_codes is not None:
        return False
    if is_covers is None:
        return False
    return not bool((is_covers > 0).any())


def wrap_prepare_condition(model: nn.Module) -> None:
    """Make ``model.prepare_condition`` skip the audio tokenizer/detokenizer when the generation is not a cover.

    The engine computes ``torch.where(is_covers > 0, lm_hints, src_latents)``; with no cover in the batch the
    result is ``src_latents`` whatever ``lm_hints`` is, so the tokenizer and detokenizer are replaced by stubs
    returning a tensor of the right shape for the duration of the call. The condition-encoder slots are given
    back to the card as soon as the call is over.
    """
    original = model.prepare_condition

    def prepare_condition(*args, **kwargs):
        try:
            call = inspect_bind(original, args, kwargs)
            plain = _is_plain_generation(call.get("is_covers"), call.get("precomputed_lm_hints_25Hz"), call.get("audio_codes"))
        except Exception:
            plain = False
        stubbed = False
        if plain:
            model.tokenize = lambda x, silence_latent, attention_mask: (x, None, attention_mask)
            model.detokenize = lambda quantized: quantized
            stubbed = True
        try:
            return original(*args, **kwargs)
        finally:
            if stubbed:
                # remove the instance attributes: the class methods are visible again
                model.__dict__.pop("tokenize", None)
                model.__dict__.pop("detokenize", None)
            if _ENCODER_POOL is not None:
                _ENCODER_POOL.release_gpu()

    model.prepare_condition = prepare_condition


def inspect_bind(func: Any, args: tuple, kwargs: dict) -> dict:
    import inspect

    bound = inspect.signature(func).bind_partial(*args, **kwargs)
    return dict(bound.arguments)


def attach_encoder(model: nn.Module, device: torch.device, cpu_dtype: torch.dtype) -> bool:
    """Stream the condition encoder and skip the useless cover step. Never raises (the encoder then stays on the processor)."""
    global _ENCODER_POOL
    try:
        pool = install_encoder(model, device, cpu_dtype)
        wrap_prepare_condition(model)
        _ENCODER_POOL = pool
        pool.release_gpu()  # the slots are created again when the encoder runs, then released before the DiT
        logger.info(
            "[small_gpu_stream] condition encoder streamed: {} blocks, {:.0f} MB per block, tokenizer/detokenizer skipped unless cover.",
            pool.count, pool.bytes_per_layer / 1024**2,
        )
        return True
    except Exception as exc:
        logger.warning("[small_gpu_stream] could not stream the condition encoder ({}: {}): it stays on the processor.", type(exc).__name__, exc)
        _ENCODER_POOL = None
        return False


# ----------------------------------------------------------------------------------------------------------------
# VAE on the card
# ----------------------------------------------------------------------------------------------------------------
def vae_decode_enabled() -> bool:
    return enabled() and active()


def vae_chunk_size() -> int:
    try:
        return max(24, int(os.environ.get(ENV_VAE_CHUNK, DEFAULT_VAE_CHUNK)))
    except ValueError:
        return DEFAULT_VAE_CHUNK


def tiled_decode_on_card(handler: Any, latents: torch.Tensor) -> torch.Tensor:
    """Decode ``latents`` ([batch, 64, frames]) with the handler's VAE on the card, in float32 tiles.

    The VAE is moved back to the processor afterwards. If the card runs out of memory the engine's own
    fallback chain (smaller tiles on the card, then processor) takes over inside ``_tiled_decode_inner``.
    """
    release_gpu()  # the DiT slots are not needed any more; the VAE needs the room
    device = torch.device("cuda")
    vae = handler.vae
    chunk = vae_chunk_size()
    overlap = min(DEFAULT_VAE_OVERLAP, max(4, chunk // 4))
    logger.info("[small_gpu_stream] VAE decode on {} (float32, tiles of {} frames, overlap {})",
                torch.cuda.get_device_name(device), chunk, overlap)
    try:
        vae.to(device=device, dtype=torch.float32)
        card_latents = latents.to(device=device, dtype=torch.float32)
        result = handler._tiled_decode_inner(card_latents, chunk, overlap, True)
        return result.to("cpu")
    finally:
        try:
            handler.vae = handler.vae.to(device="cpu", dtype=torch.float32)
        except Exception as exc:  # pragma: no cover
            logger.warning("[small_gpu_stream] could not move the VAE back to the processor: {}", exc)
        gc.collect()
        torch.cuda.empty_cache()
