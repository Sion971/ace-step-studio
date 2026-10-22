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
* VAE decode: float32 on the card in tiles (96 latent frames on a 2 GB card; on a bigger card the size follows the free
  memory, up to 256 frames, and falls back to smaller tiles instead of the processor if the card runs out of memory).

Measured on a GTX 1050 (2 GB): one DiT step 12.7 s (processor) -> 1.26 s; VAE decode 170 s -> about 10 s;
streamed output equal to the processor output (relative difference 2e-6).

Opt-in: ``ACESTEP_SMALL_GPU_STREAM=1`` (written by the Studio launcher for cards of 3 GB or less).
Not supported in this mode: LoRA adapters (the blocks are replaced by streamed proxies).

Larger cards (6 to 8 GB, a DiT that does not fit): two options make the same mechanism faster, both off by default
so that the 2 GB behaviour is unchanged.

* ``ACESTEP_STREAM_COMPUTE=bfloat16``: the card computes in bfloat16 (the format the checkpoints are shipped in)
  instead of float32. A card from the Turing generation on does this natively; the 2 GB card above (Pascal) does not.
* ``ACESTEP_STREAM_RESIDENT=auto`` (or a number of blocks): the first blocks stay on the card for good, so only
  the others cross the bus at every step. ``auto`` keeps as many as the free memory allows, minus
  ``ACESTEP_STREAM_RESERVE_GB`` (default 2.5) for the activations. If the card still runs out of memory in the
  middle of a block, the resident blocks are halved and that block is retried (and the lower number is kept).
  The first generation after the start uses that reserve; from then on the peak of the activations is measured at the
  end of every generation and the reserve follows it (the measured need plus a quarter and 0.3 GB, at least 0.5 GB,
  scaled when the next track is longer), so short tracks keep more blocks on the card. If the card still runs out of
  memory, the configured reserve comes back. ``ACESTEP_STREAM_RESERVE_AUTO=off`` keeps the fixed reserve.

Same seed, same track as the regular card mode: the engine runs on the processor in this mode, so the starting noise
would be drawn by the processor's generator (float32), which gives another track than the card's generator (bfloat16)
for the same seed. The noise is therefore drawn on the card in the format the regular mode uses
(``ACESTEP_STREAM_NOISE=cpu`` brings the old draw back). ``ACESTEP_STREAM_CHECK=1`` is a diagnostic: during the first
generation each block computed on the card is compared with the same block computed on the processor in float32, and
one line says whether the streaming changes the numbers (use a short track: the processor is slow).

Activations stay on the card between blocks: a block hands its result to the next one without going through the
processor, and the inputs that are the same for every block of a step (masks, positions, conditioning) are sent once
per step instead of once per block. The results are bit for bit the same (the processor round trip only converted
bfloat16 to float32 and back); ``ACESTEP_STREAM_ACTIVATIONS=cpu`` brings the round trip back.
"""

from __future__ import annotations

import copy
import gc
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

import torch
from loguru import logger
from torch import nn

from . import small_gpu_stream_attention

ENV_FLAG = "ACESTEP_SMALL_GPU_STREAM"
ENV_VAE_CHUNK = "ACESTEP_STREAM_VAE_CHUNK"
ENV_CPU_DTYPE = "ACESTEP_STREAM_CPU_DTYPE"
ENV_COMPUTE = "ACESTEP_STREAM_COMPUTE"
ENV_RESIDENT = "ACESTEP_STREAM_RESIDENT"
ENV_RESERVE = "ACESTEP_STREAM_RESERVE_GB"
ENV_STATS = "ACESTEP_STREAM_STATS"
ENV_NOISE = "ACESTEP_STREAM_NOISE"
ENV_CHECK = "ACESTEP_STREAM_CHECK"
ENV_ACTIVATIONS = "ACESTEP_STREAM_ACTIVATIONS"
ENV_MEMORY = "ACESTEP_STREAM_MEMORY"
ENV_CONDITION_CACHE = "ACESTEP_STREAM_CONDITION_CACHE"
ENV_RESERVE_AUTO = "ACESTEP_STREAM_RESERVE_AUTO"
# Reserve for the activations once a generation has been measured (see StreamPool.reserve_for): the measured peak plus
# a quarter, plus a fixed margin for what the card's other users take in the meantime, never below the minimum.
ACT_SAFETY = 1.25
ACT_MARGIN_BYTES = int(0.3 * 1024**3)
ACT_MIN_RESERVE_BYTES = int(0.5 * 1024**3)
RELEASE_LEFTOVER_BYTES = int(0.25 * 1024 ** 3)  # still allocated on the card after the slots are dropped: run the garbage collector
ACT_MEASURES_KEPT = 4
DEFAULT_RESERVE_GB = 2.5
DEFAULT_VAE_CHUNK = 96
DEFAULT_VAE_OVERLAP = 16
# Automatic tile size (no ACESTEP_STREAM_VAE_CHUNK): about 11 MB of float32 activations per latent frame (measured at the
# limit on a 2 GB card with 128 frames), of which VAE_FREE_SHARE of the free memory may be used, up to VAE_CHUNK_MAX.
VAE_CHUNK_MAX = 256
VAE_BYTES_PER_FRAME = 11 * 1024 * 1024
VAE_FREE_SHARE = 0.6
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


def compute_dtype_from_env() -> torch.dtype:
    """Dtype the card computes in: float32 (default, works on every card) or bfloat16."""
    name = os.environ.get(ENV_COMPUTE, "float32").strip().lower()
    return torch.bfloat16 if name in ("bfloat16", "bf16") else torch.float32


def resident_from_env() -> Any:
    """Blocks kept on the card: 0 (default), a number, or the string "auto"."""
    value = os.environ.get(ENV_RESIDENT, "0").strip().lower()
    if value == "auto":
        return "auto"
    try:
        return max(0, int(value))
    except ValueError:
        return 0


def reserve_bytes_from_env() -> int:
    try:
        gb = float(os.environ.get(ENV_RESERVE, DEFAULT_RESERVE_GB))
    except ValueError:
        gb = DEFAULT_RESERVE_GB
    return int(max(0.0, gb) * 1024**3)


def reserve_auto_from_env() -> bool:
    """True (default): with ``ACESTEP_STREAM_RESIDENT=auto`` the reserve for the activations follows what was measured;
    ``ACESTEP_STREAM_RESERVE_AUTO=off`` keeps the fixed ``ACESTEP_STREAM_RESERVE_GB``."""
    return os.environ.get(ENV_RESERVE_AUTO, "auto").strip().lower() not in ("off", "0", "no", "false")


def tokens_of(args: tuple, kwargs: dict) -> Optional[int]:
    """Batch x sequence length of a block call (its activations are ``[batch, tokens, channels]``), or None."""
    first = kwargs.get("hidden_states") if "hidden_states" in kwargs else (args[0] if args else None)
    if torch.is_tensor(first) and first.dim() == 3:
        return int(first.shape[0] * first.shape[1])
    return None


def active_pool() -> Optional["StreamPool"]:
    """The pool of the streamed DiT, or None when the mode is not running."""
    return _ACTIVE_POOL


# ----------------------------------------------------------------------------------------------------------------
# Starting noise: the same draw as the regular card mode
# ----------------------------------------------------------------------------------------------------------------
def noise_on_card_from_env() -> bool:
    """True (default) when the starting noise is drawn on the card; ``ACESTEP_STREAM_NOISE=cpu`` keeps the processor's draw."""
    return os.environ.get(ENV_NOISE, "card").strip().lower() != "cpu"


def regular_card_dtype() -> torch.dtype:
    """The format the engine's regular card mode computes in (and therefore draws its noise in)."""
    try:
        from acestep.gpu_config import cuda_supports_bfloat16

        return torch.bfloat16 if cuda_supports_bfloat16() else torch.float16
    except Exception:  # pragma: no cover - the helper is always there in the Studio
        return torch.bfloat16


def wrap_prepare_noise(model: nn.Module, device: torch.device, dtype: Optional[torch.dtype] = None) -> bool:
    """Make ``model.prepare_noise`` draw its noise on ``device`` in ``dtype``, like the regular card mode, then bring it back.

    The model's own function does the drawing (seeds, lists of seeds, no seed), on a tensor that only carries the shape,
    the device and the format; the result is converted to the device and format the processor-side engine works in.
    """
    original = getattr(model, "prepare_noise", None)
    if original is None or getattr(original, "_small_gpu_stream_noise", False):
        return False
    noise_dtype = dtype if dtype is not None else regular_card_dtype()

    def prepare_noise(context_latents, seed=None):
        carrier = torch.empty(context_latents.shape, device=device, dtype=noise_dtype)
        noise = original(carrier, seed)
        return noise.to(device=context_latents.device, dtype=context_latents.dtype)

    prepare_noise._small_gpu_stream_noise = True
    model.prepare_noise = prepare_noise
    return True


# ----------------------------------------------------------------------------------------------------------------
# Moving call arguments between processor and card
# ----------------------------------------------------------------------------------------------------------------
def activations_on_card_from_env() -> bool:
    """True (default): activations stay on the card between blocks; ``ACESTEP_STREAM_ACTIVATIONS=cpu`` restores the round trip."""
    return os.environ.get(ENV_ACTIVATIONS, "card").strip().lower() != "cpu"


def _move_tensor(obj: torch.Tensor, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    if obj.is_floating_point():
        if dtype != torch.float32 and obj.dtype == torch.float32:
            # A mask holds -inf or the float32 minimum: both would overflow to -inf (then NaN in a fully masked row)
            # in a narrower format, so values are clamped to its range first. Ordinary activations are unaffected.
            info = torch.finfo(dtype)
            obj = obj.clamp(min=info.min, max=info.max)
        return obj.to(device=device, dtype=dtype, non_blocking=True)
    return obj.to(device=device, non_blocking=True)


# ----------------------------------------------------------------------------------------------------------------
# Diagnostic: where the card's memory goes (ACESTEP_STREAM_MEMORY=1)
# ----------------------------------------------------------------------------------------------------------------
def memory_log_enabled() -> bool:
    """True when ``ACESTEP_STREAM_MEMORY=1``: the card's memory is logged at the main points of a generation."""
    return _truthy(os.environ.get(ENV_MEMORY))


def parse_compute_apps(text: str, pid: int) -> Optional[float]:
    """GB used by process ``pid`` in the output of ``nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits``."""
    for line in (text or "").splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 2 and parts[0] == str(pid):
            try:
                return float(parts[1]) / 1024.0  # MiB
            except ValueError:
                return None
    return None


def _process_used_gb() -> Optional[float]:
    """Memory the driver attributes to this program (torch's memory and the CUDA context), or None when nvidia-smi cannot say."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
        ).stdout
    except Exception:
        return None
    return parse_compute_apps(out, os.getpid())


def log_memory(tag: str) -> None:
    """One line on the card's memory: what is free, what torch holds (in use and idle cache), what the driver attributes to this
    program and what is left for the other programs on the card. Off unless ``ACESTEP_STREAM_MEMORY=1``; never raises."""
    if not memory_log_enabled():
        return
    try:
        if not torch.cuda.is_available():
            return
        gb = 1024 ** 3
        free, total = torch.cuda.mem_get_info()
        used = total - free
        allocated = torch.cuda.memory_allocated()
        reserved = torch.cuda.memory_reserved()
        ours = _process_used_gb()
        tail = f" | this program {ours:.2f} GB (torch + CUDA context), other programs {used / gb - ours:.2f} GB" if ours is not None else ""
        logger.info(
            "[small_gpu_stream] card memory ({}): free {:.2f} of {:.2f} GB | torch in use {:.2f}, idle cache {:.2f}{}",
            tag, free / gb, total / gb, allocated / gb, max(0, reserved - allocated) / gb, tail,
        )
    except Exception as exc:  # a diagnostic must never break a generation
        logger.debug("[small_gpu_stream] could not log the card memory: {}", exc)


class _ArgCache:
    """Card copies of the inputs that are the same for every block of a step (masks, positions, conditioning).

    An entry holds the source tensor itself, so its identity cannot be reused by another tensor while the entry lives,
    and the source's version counter, so a tensor changed in place is converted again. The cache is emptied when a new
    step starts and when the card is given back.
    """

    LIMIT = 64  # a caller that makes new tensors for every block would otherwise fill the card

    def __init__(self) -> None:
        self.items: dict = {}

    def clear(self) -> None:
        self.items.clear()

    @staticmethod
    def _version(tensor: torch.Tensor) -> Any:
        try:
            return tensor._version
        except RuntimeError:  # inference tensors do not track versions
            return None

    def get(self, tensor: torch.Tensor, convert: Any) -> torch.Tensor:
        entry = self.items.get(id(tensor))
        version = self._version(tensor)
        if entry is not None and entry[0] is tensor and entry[1] == version:
            return entry[2]
        converted = convert(tensor)
        if len(self.items) >= self.LIMIT:
            self.items.clear()
        self.items[id(tensor)] = (tensor, version, converted)
        return converted


def _to_device(obj: Any, device: torch.device, dtype: torch.dtype = torch.float32, cache: Optional[_ArgCache] = None) -> Any:
    if torch.is_tensor(obj):
        if cache is not None:
            return cache.get(obj, lambda t: _move_tensor(t, device, dtype))
        return _move_tensor(obj, device, dtype)
    if isinstance(obj, tuple):
        return tuple(_to_device(o, device, dtype, cache) for o in obj)
    if isinstance(obj, list):
        return [_to_device(o, device, dtype, cache) for o in obj]
    if isinstance(obj, dict):
        return {k: _to_device(v, device, dtype, cache) for k, v in obj.items()}
    return obj  # caches and other objects keep their own tensors (created on the card by the slot)


def _to_cpu(obj: Any) -> Any:
    if torch.is_tensor(obj):
        # The rest of the engine runs in float32 on the processor, whatever the card computed in.
        return obj.to("cpu", dtype=torch.float32) if obj.is_floating_point() else obj.to("cpu")
    if isinstance(obj, tuple):
        return tuple(_to_cpu(o) for o in obj)
    if isinstance(obj, list):
        return [_to_cpu(o) for o in obj]
    if isinstance(obj, dict):
        return {k: _to_cpu(v) for k, v in obj.items()}
    return obj


def _result_of_block(out: Any, keep_on_card: bool) -> Any:
    """What a block returns: the activations (first element) stay on the card for the next block, the rest goes to the processor."""
    if not keep_on_card:
        return _to_cpu(out)
    if torch.is_tensor(out):
        return out
    if isinstance(out, (tuple, list)) and len(out) > 0 and torch.is_tensor(out[0]):
        rest = [_to_cpu(o) for o in out[1:]]
        return (out[0], *rest) if isinstance(out, tuple) else [out[0], *rest]
    return _to_cpu(out)


# ----------------------------------------------------------------------------------------------------------------
# Block pool
# ----------------------------------------------------------------------------------------------------------------
def stats_enabled() -> bool:
    """One line of timing figures is logged per generation unless ACESTEP_STREAM_STATS=0."""
    return os.environ.get(ENV_STATS, "1").strip().lower() not in ("0", "false", "no", "off")


class StreamStats:
    """Where the time of a generation goes: weight copies, computation, waiting for weights, activation transfers.

    GPU times come from CUDA events (read after the work is done); the activation transfers are host wall times.
    Nothing here changes what runs: with the statistics off the pool behaves exactly as without this class.
    """

    def __init__(self, cuda: bool, enabled: bool):
        self.cuda = cuda
        self.enabled = enabled
        self.reset()

    def reset(self) -> None:
        self.runs = 0
        self.t0 = None           # host time when the first block of the generation started
        self.t1 = 0.0            # host time when the last block ended (the activations come back to the processor there)
        self.pending: list = []  # (start, ready, run, done) events of the blocks, read when the report is made
        self.copy_bytes = 0      # weights copied to the card by streaming
        self.copy_pairs: list = []  # (start, end) events on the copy stream
        self.copy_wall = 0.0     # host time of the same copies when there is no card (tests)
        self.compute = 0.0       # GPU time of the block computations
        self.stall = 0.0         # GPU time spent waiting for a block's weights to arrive
        self.to_card = 0.0       # activations sent to the card (host time)
        self.from_card = 0.0     # activations brought back (host time, after the block is done)
        self.resident_bytes = 0  # resident blocks put on the card at the start of the generation
        self.resident_s = 0.0

    def event(self):
        if not (self.enabled and self.cuda):
            return None
        try:
            ev = torch.cuda.Event(enable_timing=True)
            ev.record(torch.cuda.current_stream())
            return ev
        except Exception:  # the statistics must never break a generation
            return None

    def add_events(self, events: tuple) -> None:
        if None not in events and len(self.pending) < 20000:  # emptied after each generation; this only bounds a run that never reports
            self.pending.append(events)

    def collect(self) -> None:
        """Turn the recorded events into seconds (one wait for the card, instead of one per block)."""
        if not self.pending:
            return
        try:
            if self.cuda:
                torch.cuda.synchronize()
            for ev_start, ev_ready, ev_run, ev_done in self.pending:
                self.stall += ev_start.elapsed_time(ev_ready) / 1000.0
                self.compute += ev_run.elapsed_time(ev_done) / 1000.0
        except Exception:  # the statistics must never break a generation
            pass
        self.pending.clear()

    def summary(self) -> dict:
        self.collect()
        wall = (self.t1 - self.t0) if self.t0 is not None else 0.0
        copy_s = self.copy_wall
        if self.cuda and self.copy_pairs:
            torch.cuda.synchronize()
            copy_s = sum(a.elapsed_time(b) for a, b in self.copy_pairs) / 1000.0
        gb = self.copy_bytes / 1024**3
        return {
            "runs": self.runs, "wall_s": wall, "copy_gb": gb, "copy_s": copy_s,
            "copy_gbps": (gb / copy_s) if copy_s > 0 else 0.0, "compute_s": self.compute, "stall_s": self.stall,
            "to_card_s": self.to_card, "from_card_s": self.from_card,
            "resident_gb": self.resident_bytes / 1024**3, "resident_s": self.resident_s,
        }


def format_stats(summary: dict, pinned: Optional[str], resident: int, count: int) -> str:
    """The one-line report logged after each generation (see StreamStats)."""
    return (
        "[small_gpu_stream] DiT {runs} block runs in {wall:.1f} s | weights: {gb:.2f} GB streamed in {cs:.2f} s of copying "
        "({gbps:.1f} GB/s, pinned RAM: {pinned}) | on the card: computing {comp:.1f} s, waiting for weights {stall:.1f} s | "
        "activations: to the card {up:.1f} s, back {down:.1f} s | resident blocks {res}/{n}: {rgb:.2f} GB loaded in {rs:.1f} s"
    ).format(
        runs=summary["runs"], wall=summary["wall_s"], gb=summary["copy_gb"], cs=summary["copy_s"], gbps=summary["copy_gbps"],
        pinned=pinned or "unknown", comp=summary["compute_s"], stall=summary["stall_s"], up=summary["to_card_s"],
        down=summary["from_card_s"], res=resident, n=count, rgb=summary["resident_gb"], rs=summary["resident_s"],
    )


class SelfCheck:
    """Diagnostic (``ACESTEP_STREAM_CHECK=1``): compare each streamed block with the same block computed on the processor.

    The first time each block runs, it is run again on the processor in float32 with the same inputs and the two
    outputs are compared. In float32 the card must match to rounding noise; in bfloat16 it differs by the format's
    rounding (about one percent per block). A larger gap means the streaming itself changes the numbers.
    """

    LIMIT_FLOAT32 = 1e-3
    LIMIT_BFLOAT16 = 5e-2

    def __init__(self, name: str, count: int, compute_dtype: torch.dtype):
        self.name = name
        self.count = count
        self.compute_dtype = compute_dtype
        self.errors: dict = {}  # block index -> (relative difference, largest absolute difference)
        self.done = False       # reported, or the processor could not run the reference

    @property
    def limit(self) -> float:
        return self.LIMIT_BFLOAT16 if self.compute_dtype != torch.float32 else self.LIMIT_FLOAT32

    def wants(self, index: int) -> bool:
        return not self.done and index not in self.errors

    @staticmethod
    def _without_caches(obj: Any) -> Any:
        """Cache objects hold tensors that live on the card: the reference computes without them."""
        if torch.is_tensor(obj):
            return obj
        if type(obj).__name__.endswith("Cache"):
            return None
        if isinstance(obj, tuple):
            return tuple(SelfCheck._without_caches(o) for o in obj)
        if isinstance(obj, list):
            return [SelfCheck._without_caches(o) for o in obj]
        if isinstance(obj, dict):
            return {k: SelfCheck._without_caches(v) for k, v in obj.items()}
        return obj

    @staticmethod
    def _first_tensor(out: Any) -> torch.Tensor:
        return out[0] if isinstance(out, (tuple, list)) else out

    @staticmethod
    def _with_reference_masks(real: nn.Module, args: tuple, kwargs: dict) -> tuple:
        """A mask-free DiT hands no mask to the sliding layers (the card applies the window itself): the processor's
        reference needs the band mask the regular path would have built."""
        import inspect

        window = getattr(getattr(real, "self_attn", None), "sliding_window", None)
        if getattr(real, "attention_type", None) != "sliding_attention" or window is None:
            return args, kwargs
        bound = inspect.signature(real.forward).bind_partial(*args, **kwargs)
        if bound.arguments.get("attention_mask") is not None:
            return args, kwargs
        bound.arguments["attention_mask"] = small_gpu_stream_attention.reference_mask(int(bound.arguments["hidden_states"].shape[1]), int(window))
        return bound.args, bound.kwargs

    def compare(self, index: int, real: nn.Module, args: tuple, kwargs: dict, result: Any, mask_free: bool = False) -> None:
        """Run the block again on the processor (float32) and record how far the card's result is."""
        try:
            if mask_free:
                args, kwargs = self._with_reference_masks(real, args, kwargs)
            # The inputs may be activations the previous block left on the card: the reference gets them as float32.
            reference = copy.deepcopy(real).to(device="cpu", dtype=torch.float32).eval()
            with torch.no_grad():
                expected = self._first_tensor(reference(*self._without_caches(_to_cpu(args)), **self._without_caches(_to_cpu(kwargs))))
            got = self._first_tensor(_to_cpu(result))
            diff = (got.float() - expected.float()).abs()
            rel = float(torch.linalg.vector_norm(got.float() - expected.float()) / (torch.linalg.vector_norm(expected.float()) + 1e-12))
            self.errors[index] = (rel, float(diff.max()))
        except Exception as exc:  # a diagnostic must never break a generation
            logger.warning("[small_gpu_stream] self-check {}: could not compute block {} on the processor ({}: {}); check stopped.",
                           self.name, index, type(exc).__name__, exc)
            self.done = True

    def report(self) -> None:
        """One line (and the per-block figures) for the blocks compared so far, then the check stops."""
        if self.done or not self.errors:
            return
        self.done = True
        ordered = sorted(self.errors.items())
        rels = sorted(rel for _i, (rel, _m) in ordered)
        median = rels[len(rels) // 2]
        worst_index, (worst, worst_abs) = max(ordered, key=lambda item: item[1][0])
        ok = worst <= self.limit
        fmt = "bfloat16" if self.compute_dtype != torch.float32 else "float32"
        message = (
            f"[small_gpu_stream] self-check {self.name}: {len(ordered)} of {self.count} blocks compared with the processor (float32): "
            f"worst relative difference {worst * 100:.3f} % (block {worst_index}, largest absolute gap {worst_abs:.3g}), "
            f"median {median * 100:.3f} % -> {'OK' if ok else 'SUSPECT'} (limit {self.limit * 100:g} % for {fmt} compute)"
        )
        (logger.info if ok else logger.warning)(message)
        logger.info("[small_gpu_stream] self-check {} per block (%): {}", self.name,
                    " ".join(f"{i}:{rel * 100:.2f}" for i, (rel, _m) in ordered))


class StreamPool:
    """All block weights in RAM; some blocks may stay on the card, the others pass through two slots.

    ``resident`` is the number of blocks (the first ones) kept on the card, or ``"auto"`` to fit as many as the
    free memory allows (minus ``reserve_bytes`` for the activations). ``compute_dtype`` is the format of the card's
    copies. With the defaults (no resident block, float32) this is the original behaviour.
    """

    def __init__(
        self,
        real_layers: List[nn.Module],
        device: torch.device,
        cpu_dtype: torch.dtype,
        pin: bool = True,
        compute_dtype: torch.dtype = torch.float32,
        resident: Any = 0,
        reserve_bytes: int = int(DEFAULT_RESERVE_GB * 1024**3),
        keep_on_card: Optional[bool] = None,
    ):
        self.dev = device
        self.cuda = device.type == "cuda"
        self.n_slots = 2
        self.count = len(real_layers)
        self.real = real_layers
        # Rank of each block among those that return cross-attention weights (the numbering of the alignment config).
        self.cross_position: List[Optional[int]] = []
        rank = 0
        for layer in real_layers:
            if getattr(layer, "use_cross_attention", True):
                self.cross_position.append(rank)
                rank += 1
            else:
                self.cross_position.append(None)
        # While set (see alignment_heads), a block returns only these cross-attention heads, chosen on the card.
        self.align_heads: Optional[Dict[int, List[int]]] = None
        self.compute_dtype = compute_dtype
        self.resident_request = resident
        self.reserve_bytes = reserve_bytes
        self.resident_cap = self.count  # lowered when the card runs out of memory with resident blocks
        self.resident_n = 0
        self.resident: List[nn.Module] = []
        self._logged_resident = -1
        self.stats = StreamStats(self.cuda, stats_enabled())
        self.pin_error: Optional[str] = None
        self.check: Optional[SelfCheck] = None  # set by the attach functions when ACESTEP_STREAM_CHECK is on
        self.keep_on_card = activations_on_card_from_env() if keep_on_card is None else bool(keep_on_card)
        self.args = _ArgCache()  # card copies of the inputs shared by all the blocks of a step
        self._last_index = -1    # index of the previous block call: a call that does not go up starts a new step
        self.label = "DiT"     # name used in the memory log
        self.attention_name: Optional[str] = None  # attention function of the card copies (None: the model's own)
        self.mask_free = False   # True when the DiT is given no masks (see small_gpu_stream_attention)
        self.release_times: Optional[tuple] = None  # seconds spent in the last release_gpu: (collecting garbage, emptying the cache)
        # Reserve for the activations that follows what was measured (resident="auto" only): tokens -> extra bytes at the peak.
        self.reserve_auto = reserve_auto_from_env()
        self.act_tokens: Optional[int] = None   # batch x sequence length of the round being prepared
        self.act_needs: dict = {}
        self._act_base: Optional[int] = None    # bytes allocated on the card when the blocks were placed
        self._act_ran = False                   # a block has run since the blocks were placed
        self._act_hurt = False                  # the card ran out of memory in this round
        self._act_trusted = False               # this round's reserve came from a measurement
        self._logged_reserve = -1
        self._check_layers(real_layers)

        # RAM copy of every block's parameters (bfloat16 by default: exact for bfloat16 checkpoints, half the
        # RAM and half the PCIe traffic of float32).
        self.lora = None  # StreamLoraSet once an adapter is loaded (small_gpu_stream_lora)
        self.param_names = [name for name, _ in real_layers[0].named_parameters()]
        self.param_shapes = [tuple(p.shape) for _, p in real_layers[0].named_parameters()]
        self.cpu_params: List[List[torch.Tensor]] = []
        for layer in real_layers:
            tensors = []
            for p in layer.parameters():
                data = p.data.detach().to(device="cpu", dtype=cpu_dtype).contiguous()
                if pin and self.cuda:
                    try:
                        data = data.pin_memory()
                    except Exception as exc:  # not enough lockable RAM: keep pageable memory
                        pin = False
                        self.pin_error = f"{type(exc).__name__}: {exc}"
                p.data = data  # drops the original (float32) storage
                tensors.append(data)
            self.cpu_params.append(tensors)
        self.attrs = [self._snapshot(layer) for layer in real_layers]
        total = sum(len(t) for t in self.cpu_params)
        self.pinned_count = sum(1 for tensors in self.cpu_params for t in tensors if self.cuda and t.is_pinned())
        self.pinned_total = total
        if self.cuda and self.pinned_count < total:
            logger.warning(
                "[small_gpu_stream] only {} of {} weight tensors are in pinned RAM ({}): copies to the card will be slower. "
                "Check the locked-memory limit (ulimit -l) and the free RAM.",
                self.pinned_count, total, self.pin_error or "not enough lockable memory",
            )
        self.bytes_per_layer = sum(t.numel() * t.element_size() for t in self.cpu_params[0])
        cpu_item = self.cpu_params[0][0].element_size()
        self.bytes_on_card = self.bytes_per_layer // cpu_item * torch.empty((), dtype=compute_dtype).element_size()
        self._template = real_layers[0]
        self._skeleton: Optional[nn.Module] = None  # parameter-less copy of a block, to build resident blocks cheaply
        self.slots: List[nn.Module] = []
        self.slot_params: List[List[torch.Tensor]] = []
        self.loaded: List[int] = []
        self._gpu_ready = False
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
    def _free_bytes(self) -> int:
        """Memory currently free on the card (overridable: tests run on the processor)."""
        return int(torch.cuda.mem_get_info(self.dev)[0])

    def _allocated_bytes(self) -> int:
        return int(torch.cuda.memory_allocated(self.dev))

    def _peak_bytes(self) -> int:
        return int(torch.cuda.max_memory_allocated(self.dev))

    def observe(self, args: tuple, kwargs: dict) -> None:
        """Note the size of the activations of the first call of a round (before the blocks are placed)."""
        if not self._gpu_ready:
            tokens = tokens_of(args, kwargs)
            if tokens is not None:
                self.act_tokens = tokens

    def reserve_for(self, tokens: Optional[int]) -> tuple:
        """(bytes to leave free for the activations, measured need it came from or None) for a round of ``tokens`` tokens.

        Without a measurement (the first generation, or ``ACESTEP_STREAM_RESERVE_AUTO=off``) this is the configured
        reserve. With measurements, the smallest measured size that is at least as long as this round gives the need
        (activations grow with the length, so it is an upper bound); a longer round scales the longest measurement
        (linearly when the attention needs no mask, with the square of the length otherwise) and adds a quarter.
        """
        if not (self.reserve_auto and self.act_needs and tokens):
            return self.reserve_bytes, None
        longer = [t for t in self.act_needs if t >= tokens]
        if longer:
            need = self.act_needs[min(longer)]
        else:
            ref = max(self.act_needs)
            need = int(self.act_needs[ref] * (tokens / ref) ** (1 if self.mask_free else 2) * ACT_SAFETY)
        return max(ACT_MIN_RESERVE_BYTES, int(need * ACT_SAFETY) + ACT_MARGIN_BYTES), need

    def _record_activations(self) -> None:
        """At the end of a round: how much more than the weights the card held at the peak (the activations)."""
        if not (self.cuda and self.resident_request == "auto" and self.reserve_auto):
            return
        if not self._act_ran or self._act_hurt or not self.act_tokens or self._act_base is None:
            return
        try:
            need = max(0, self._peak_bytes() - self._act_base)
        except Exception as exc:  # a measurement must never break a generation
            logger.debug("[small_gpu_stream] could not measure the activations: {}", exc)
            return
        tokens = self.act_tokens
        self.act_needs[tokens] = max(need, self.act_needs.pop(tokens, 0))  # same length: keep the larger, latest last
        while len(self.act_needs) > ACT_MEASURES_KEPT:
            self.act_needs.pop(next(iter(self.act_needs)))
        logger.info("[small_gpu_stream] {}: the activations peaked at {:.2f} GB for {} tokens.", self.label, need / 1024**3, tokens)

    def _resident_target(self) -> int:
        """How many blocks to keep on the card for this round."""
        want = self.resident_request
        if want == "auto":
            if not self.cuda:
                return 0
            room = self._free_bytes() - self.reserve_for(self.act_tokens)[0]
            if room >= self.count * self.bytes_on_card:
                n = self.count  # everything fits: no streaming at all
            else:
                n = int((room - self.n_slots * self.bytes_on_card) // self.bytes_on_card)
        else:
            n = int(want)
        return max(0, min(n, self.count, self.resident_cap))

    def _build_resident(self, index: int) -> nn.Module:
        if self._skeleton is None:
            self._skeleton = copy.deepcopy(self._template).to("meta")
        module = copy.deepcopy(self._skeleton).to_empty(device=self.dev).to(dtype=self.compute_dtype).eval()
        params = list(module.parameters())
        for p in params:
            p.requires_grad_(False)
        for dst, src in zip(params, self.cpu_params[index]):
            dst.copy_(src.to(self.dev, non_blocking=self.cuda))
        if self.lora is not None:
            self.lora.apply(index, params)
        for sub, attrs in zip(module.modules(), self.attrs[index]):
            sub.__dict__.update(attrs)
        self._tune(module)
        return module

    def ensure_gpu(self) -> None:
        """Put the resident blocks and the two slots on the card if they are not there (first use, or after release_gpu)."""
        if self._gpu_ready:
            return
        # Normal tensors even when called inside torch.inference_mode(): inference tensors cannot be updated in place
        # from outside inference mode, and the slots are refilled on every block.
        log_memory(f"{self.label}: before placing the blocks")
        with torch.inference_mode(False), torch.no_grad():
            self.resident_n = self._resident_target()
            self._log_reserve()
            started = time.perf_counter()
            self.resident = [self._build_resident(i) for i in range(self.resident_n)]
            if self.resident_n and self.stats.enabled:
                if self.cuda:
                    torch.cuda.synchronize(self.dev)
                self.stats.resident_s += time.perf_counter() - started
                self.stats.resident_bytes += self.resident_n * self.bytes_per_layer
            if self.resident_n < self.count:
                self._make_slots()
        self._gpu_ready = True
        self._begin_measure()
        log_memory(f"{self.label}: {self.resident_n} resident blocks placed")
        if self.resident_n and self.resident_n != self._logged_resident:
            self._logged_resident = self.resident_n
            logger.info(
                "[small_gpu_stream] {} of {} blocks stay on the card ({:.2f} GB); the other {} pass through {} slots.",
                self.resident_n, self.count, self.resident_n * self.bytes_on_card / 1024**3,
                self.count - self.resident_n, self.n_slots if self.resident_n < self.count else 0,
            )

    def _log_reserve(self) -> None:
        if self.resident_request != "auto" or not self.cuda:
            return
        reserve, need = self.reserve_for(self.act_tokens)
        self._act_trusted = need is not None
        if need is not None and reserve != self._logged_reserve:
            self._logged_reserve = reserve
            logger.info(
                "[small_gpu_stream] {}: {:.2f} GB left free for the activations (measured need {:.2f} GB, {} tokens now; "
                "the configured reserve is {:.2f} GB).",
                self.label, reserve / 1024**3, need / 1024**3, self.act_tokens, self.reserve_bytes / 1024**3,
            )

    def _begin_measure(self) -> None:
        """Start measuring the peak of this round (after the weights are on the card)."""
        self._act_ran = False
        self._act_hurt = False
        self._act_base = None
        if self.cuda and self.resident_request == "auto" and self.reserve_auto:
            try:
                torch.cuda.synchronize(self.dev)
                self._act_base = self._allocated_bytes()
                torch.cuda.reset_peak_memory_stats(self.dev)
            except Exception as exc:
                logger.debug("[small_gpu_stream] could not start the activation measure: {}", exc)

    def _tune(self, module: nn.Module) -> None:
        """Give a card copy its own config naming the pool's attention function (nothing to do when none is set)."""
        if self.attention_name:
            small_gpu_stream_attention.private_config(module, self.attention_name)

    def set_attention(self, name: str) -> None:
        """Use attention function ``name`` in the card copies, existing ones included. The processor-side blocks keep theirs."""
        self.attention_name = name
        for module in list(self.slots) + list(self.resident):
            self._tune(module)

    def _make_slots(self) -> None:
        """The two slots blocks pass through, and the stream and events that overlap their copies with the computation."""
        for _ in range(self.n_slots):
            slot = copy.deepcopy(self._template).to(device=self.dev, dtype=self.compute_dtype).eval()
            self._tune(slot)
            params = list(slot.parameters())
            for p in params:
                p.requires_grad_(False)
            self.slots.append(slot)
            self.slot_params.append(params)
        self.loaded = [-1] * len(self.slots)
        if self.cuda:
            self._copy_stream = torch.cuda.Stream(self.dev)
            self._ready = [torch.cuda.Event() for _ in self.slots]
            self._free = [torch.cuda.Event() for _ in self.slots]
            for ev in self._free:
                ev.record(torch.cuda.current_stream(self.dev))

    def drop_weights(self) -> None:
        """Let go of every RAM copy and of the blocks themselves (the pool is not usable afterwards)."""
        self.cpu_params = []
        self.attrs = []
        self.real = []
        self._template = None
        self._skeleton = None
        self.args.clear()

    def release_gpu(self) -> None:
        """Give the card back (before the VAE decode needs it)."""
        if not self._gpu_ready:
            return
        if self.cuda:
            torch.cuda.synchronize(self.dev)
        self._record_activations()
        if self._act_hurt and self._act_trusted:
            # The measured reserve was too small for this round: forget it, go back to the configured reserve and to all
            # the resident blocks the card allows, instead of keeping the halved number for the rest of the session.
            self.reserve_auto = False
            self.act_needs.clear()
            self.resident_cap = self.count
            self._logged_resident = -1
            logger.warning("[small_gpu_stream] {}: the measured reserve was too small; the configured reserve is used from now on.", self.label)
        started = time.perf_counter()
        self.slots, self.slot_params, self.loaded = [], [], []
        self.resident, self.resident_n = [], 0
        self._copy_stream, self._ready, self._free = None, [], []
        self._gpu_ready = False
        self.args.clear()
        self._last_index = -1
        if not self.cuda:
            gc.collect()
        collected = time.perf_counter()
        if self.cuda:
            # Dropping the lists above frees the card's tensors by reference counting. The garbage collector (0.35 s with the
            # models in memory) is only needed when something stays allocated, for instance blocks kept alive by a reference cycle.
            torch.cuda.empty_cache()
            if torch.cuda.memory_allocated(self.dev) > RELEASE_LEFTOVER_BYTES:
                gc.collect()
                torch.cuda.empty_cache()
        done = time.perf_counter()
        self.release_times = (collected - started, done - collected)  # (dropping + garbage collection, cache emptying)

    def shrink_resident(self) -> bool:
        """The card ran out of memory: keep half as many resident blocks from now on. False when there is none left."""
        if not self._gpu_ready or self.resident_n == 0:
            return False
        keep = self.resident_n // 2
        self._act_hurt = True
        self.args.clear()
        if self.cuda:
            torch.cuda.synchronize(self.dev)
        # Blocks past `keep` are streamed from now on, which needs the two slots (they do not exist when everything was resident).
        self.resident = self.resident[:keep]
        self.resident_cap = keep
        self.resident_n = keep
        self.loaded = [-1] * len(self.slots)
        gc.collect()
        if self.cuda:
            torch.cuda.empty_cache()
        logger.warning("[small_gpu_stream] the card ran out of memory: {} block(s) stay resident from now on.", keep)
        if not self.slots:  # everything was resident: the slots did not exist
            with torch.inference_mode(False), torch.no_grad():
                self._make_slots()
        self._logged_resident = keep
        return True

    # -- streaming -----------------------------------------------------------------------------------------------
    def _slot_of(self, layer_idx: int) -> int:
        return (layer_idx - self.resident_n) % self.n_slots

    @torch.no_grad()
    def _load(self, layer_idx: int, slot_idx: int) -> None:
        timed = self.stats.enabled
        if self.cuda:
            with torch.cuda.stream(self._copy_stream):
                self._copy_stream.wait_event(self._free[slot_idx])  # the previous computation in this slot is over
                begin = None
                if timed:
                    try:
                        begin = torch.cuda.Event(enable_timing=True)
                        begin.record(self._copy_stream)
                    except Exception:
                        begin = None
                for dst, src in zip(self.slot_params[slot_idx], self.cpu_params[layer_idx]):
                    dst.copy_(src.to(self.dev, non_blocking=True))  # bf16 over the bus, converted on the card if needed
                if self.lora is not None:
                    self.lora.apply(layer_idx, self.slot_params[slot_idx])  # the adapter's change, added on the card
                self._ready[slot_idx].record(self._copy_stream)
                if timed and begin is not None:
                    end = torch.cuda.Event(enable_timing=True)
                    end.record(self._copy_stream)
                    if len(self.stats.copy_pairs) < 20000:  # the list is emptied after each generation; this only bounds a run that never reports
                        self.stats.copy_pairs.append((begin, end))
        else:
            started = time.perf_counter()
            for dst, src in zip(self.slot_params[slot_idx], self.cpu_params[layer_idx]):
                dst.copy_(src)
            if self.lora is not None:
                self.lora.apply(layer_idx, self.slot_params[slot_idx])
            self.stats.copy_wall += time.perf_counter() - started
        if timed:
            self.stats.copy_bytes += self.bytes_per_layer
        for module, attrs in zip(self.slots[slot_idx].modules(), self.attrs[layer_idx]):
            module.__dict__.update(attrs)  # attention type, layer index... differ from block to block
        self.loaded[slot_idx] = layer_idx

    def _prefetch_after(self, layer_idx: int) -> None:
        """Start copying the next streamed block while ``layer_idx`` computes."""
        if self.resident_n >= self.count:
            return
        nxt = (layer_idx + 1) % self.count
        target = nxt if nxt >= self.resident_n else self.resident_n  # resident blocks need no copy: skip to the first streamed one
        slot = self._slot_of(target)
        if layer_idx >= self.resident_n and slot == self._slot_of(layer_idx):
            return  # would overwrite the block being computed
        if self.loaded[slot] != target:
            self._load(target, slot)

    def select_alignment_heads(self, index: int, out: Any) -> Any:
        """Keep, from the output of block ``index``, only the cross-attention heads the lyric alignment reads.

        The block computes the weights of all its heads on the card (frames x lyric tokens x heads, about 0.5 GB per block
        on a 4-minute track), and sending them all to the processor, 32 times, filled the RAM of a 32 GB PC. Only a few
        heads of a few blocks are used, so the others are dropped here, before the transfer. The self-attention weights are
        never read and are dropped too.
        """
        if not (isinstance(out, tuple) and len(out) >= 3) or self.align_heads is None:
            return out
        rank = self.cross_position[index] if index < len(self.cross_position) else None
        heads = self.align_heads.get(rank) if rank is not None else None
        weights = out[2]
        if torch.is_tensor(weights) and heads:
            valid = [h for h in heads if 0 <= h < weights.shape[1]]
            weights = weights[:, torch.tensor(valid, dtype=torch.long, device=weights.device)]
        else:
            weights = None
        return (out[0], None, weights) + tuple(out[3:])

    def begin_call(self, layer_idx: int) -> None:
        """A block call whose index does not go up starts a new step: the shared inputs of the previous one are dropped."""
        if layer_idx <= self._last_index:
            self.args.clear()
        self._last_index = layer_idx

    def to_card(self, args: tuple, kwargs: dict) -> tuple:
        """Inputs of a block on the card. The activations (first argument) are moved as they come, and are already on the
        card after the first block; the other inputs are the same for every block of a step, so each is converted once."""
        cache = self.args if self.keep_on_card else None
        dargs = tuple(_to_device(a, self.dev, self.compute_dtype, None if i == 0 else cache) for i, a in enumerate(args))
        dkwargs = {k: _to_device(v, self.dev, self.compute_dtype, None if k == "hidden_states" else cache) for k, v in kwargs.items()}
        return dargs, dkwargs

    def acquire(self, layer_idx: int) -> nn.Module:
        self.ensure_gpu()
        if layer_idx < self.resident_n:
            self._prefetch_after(layer_idx)
            return self.resident[layer_idx]
        slot = self._slot_of(layer_idx)
        if self.loaded[slot] != layer_idx:
            self._load(layer_idx, slot)
        if self.cuda:
            torch.cuda.current_stream(self.dev).wait_event(self._ready[slot])
        self._prefetch_after(layer_idx)
        return self.slots[slot]

    def release(self, layer_idx: int) -> None:
        self._act_ran = True
        if self.cuda and layer_idx >= self.resident_n and self._free:
            self._free[self._slot_of(layer_idx)].record(torch.cuda.current_stream(self.dev))


class StreamedLayer(nn.Module):
    """Stand-in for one DiT block: same interface, computed in a card slot.

    The real block is kept outside the module tree (``object.__setattr__``) so ``model.to(...)`` and
    ``parameters()`` never see its weights; attributes the DiT reads (``attention_type``,
    ``use_cross_attention``) are forwarded to it.
    """

    def __init__(self, index: int, real: nn.Module, pool: StreamPool, last: Optional[bool] = None):
        super().__init__()
        object.__setattr__(self, "_s_index", index)
        object.__setattr__(self, "_s_real", real)
        object.__setattr__(self, "_s_pool", pool)
        # The last block of a stack hands its result back to the processor (the code after the loop runs there).
        object.__setattr__(self, "_s_last", (index == pool.count - 1) if last is None else bool(last))

    def __getattr__(self, name: str):
        try:
            return super().__getattr__(name)
        except AttributeError:
            return getattr(object.__getattribute__(self, "_s_real"), name)

    def forward(self, *args, **kwargs):
        pool: StreamPool = object.__getattribute__(self, "_s_pool")
        index: int = object.__getattribute__(self, "_s_index")
        last: bool = object.__getattribute__(self, "_s_last")
        stats = pool.stats
        timed = stats.enabled
        began = time.perf_counter() if timed else 0.0
        if timed and stats.t0 is None:
            stats.t0 = began
        pool.begin_call(index)
        pool.observe(args, kwargs)
        while True:
            ev_start = stats.event()
            slot = pool.acquire(index)
            ev_ready = stats.event()  # recorded after the wait for this block's weights: ready - start = time spent waiting
            ran_out = False
            try:
                t_up = time.perf_counter() if timed else 0.0
                dargs, dkwargs = pool.to_card(args, kwargs)
                up = (time.perf_counter() - t_up) if timed else 0.0
                ev_run = stats.event()
                out = slot(*dargs, **dkwargs)
                ev_done = stats.event()
            except torch.cuda.OutOfMemoryError:
                ran_out = True
            if not ran_out:
                break
            # Outside the except block: while it is open the failed call's tensors are still referenced.
            slot = dargs = dkwargs = None
            if pool.shrink_resident():
                continue
            logger.error(
                "[small_gpu_stream] the card ran out of memory in block {}: the track is too long for this card. "
                "Try a shorter duration (the whole DiT needs about 0.8 GB of VRAM for 30 s of audio).", index,
            )
            raise torch.cuda.OutOfMemoryError(f"out of memory in streamed block {index}")
        pool.release(index)
        if pool.align_heads is not None:
            out = pool.select_alignment_heads(index, out)
        keep = pool.keep_on_card and not last
        if timed:
            stats.add_events((ev_start, ev_ready, ev_run, ev_done))
            if not keep and ev_done is not None:
                try:
                    ev_done.synchronize()  # so that "back" below counts the transfer only, not the computation still queued
                except Exception:  # the statistics must never break a generation
                    pass
            t_down = time.perf_counter()
            result = _result_of_block(out, keep)
            stats.from_card += time.perf_counter() - t_down
            stats.to_card += up
            stats.runs += 1
            stats.t1 = time.perf_counter()
        else:
            result = _result_of_block(out, keep)
        check = pool.check
        if check is not None and check.wants(index):  # diagnostic only, after the statistics so it is not counted in them
            check.compare(index, object.__getattribute__(self, "_s_real"), args, kwargs, result, mask_free=pool.mask_free)
        return result


# ----------------------------------------------------------------------------------------------------------------
# Attaching to the loaded model
# ----------------------------------------------------------------------------------------------------------------
def install(
    decoder: nn.Module,
    device: torch.device,
    cpu_dtype: torch.dtype = torch.bfloat16,
    pin: bool = True,
    compute_dtype: torch.dtype = torch.float32,
    resident: Any = 0,
    reserve_bytes: int = int(DEFAULT_RESERVE_GB * 1024**3),
    keep_on_card: Optional[bool] = None,
) -> StreamPool:
    """Replace ``decoder.layers`` by streamed proxies and return the pool (no environment checks)."""
    layers = list(decoder.layers)
    pool = StreamPool(layers, device, cpu_dtype, pin=pin, compute_dtype=compute_dtype, resident=resident,
                      reserve_bytes=reserve_bytes, keep_on_card=keep_on_card)
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
        compute_dtype = compute_dtype_from_env()
        resident = resident_from_env()
        pool = install(decoder, device, cpu_dtype, compute_dtype=compute_dtype, resident=resident,
                       reserve_bytes=reserve_bytes_from_env())
        _ACTIVE_POOL = pool
        small_gpu_stream_attention.enable(decoder, pool, device)  # never raises: on any doubt the regular masks stay
        if _truthy(os.environ.get(ENV_CHECK)):
            pool.check = SelfCheck("DiT", pool.count, compute_dtype)
        attach_encoder(model, device, cpu_dtype, compute_dtype)
        if noise_on_card_from_env() and wrap_prepare_noise(model, device):
            logger.info("[small_gpu_stream] starting noise drawn on the card in {} (same seed, same track as the regular card mode).",
                        str(regular_card_dtype()).replace("torch.", ""))
        if resident:
            pool.release_gpu()  # the resident blocks are put on the card when the DiT runs, after the condition encoder has finished
        gc.collect()
        logger.info(
            "[small_gpu_stream] DiT streamed through {}: {} blocks, {:.0f} MB per block in {} RAM, "
            "computed in {} on the card, resident blocks: {}, pinned RAM: {} ({:.2f} GB free before).",
            torch.cuda.get_device_name(device), len(layers), pool.bytes_per_layer / 1024**2,
            "bfloat16" if cpu_dtype == torch.bfloat16 else "float32",
            "bfloat16" if compute_dtype == torch.bfloat16 else "float32", resident,
            "yes" if pool.pinned_count == pool.pinned_total else f"NO ({pool.pinned_count}/{pool.pinned_total} tensors)",
            free_before,
        )
        return True
    except Exception as exc:
        logger.warning("[small_gpu_stream] could not stream the DiT ({}: {}): regular processor mode.", type(exc).__name__, exc)
        _ACTIVE_POOL = None
        return False


def release_pinned_cache() -> bool:
    """Give the system the pinned blocks that torch keeps cached after a DiT has been freed. Never raises.

    The pinned allocator keeps every freed block for reuse and shows it as ``Shmem``. When a DiT is loaded again the
    new weights are read in float32 first (about 19 GB for the XL model), on top of the 13.5 GB still held by the
    cache: on a 31 GB machine that went through 13 GB of swap and took 52 s instead of 17 s.
    """
    for name in ("_host_emptyCache", "_accelerator_emptyHostCache"):
        function = getattr(torch._C, name, None)
        if function is None:
            continue
        try:
            function()
            return True
        except Exception as exc:
            logger.debug("[small_gpu_stream] {} failed: {}", name, exc)
    return False


def detach() -> None:
    """Forget the pools of a DiT that is about to be replaced (a new initialisation of the service).

    The pools hold the pinned RAM copy of every block, and the model's proxies and wrappers refer to the pools: deleting
    the model alone frees nothing. Without this, loading a model again (for example after choosing another LM, which
    initialises the whole service) kept two DiTs in RAM at once: 13.5 GB + 11.7 GB of pinned memory on a 31 GB machine.
    Never raises.
    """
    global _ACTIVE_POOL, _ENCODER_POOL
    pools = [pool for pool in (_ENCODER_POOL, _ACTIVE_POOL) if pool is not None]
    if not pools:
        return
    try:
        clear_condition_cache()
        for pool in pools:
            try:
                pool.release_gpu()
            except Exception as exc:  # the card may already be unusable: the RAM must be freed anyway
                logger.debug("[small_gpu_stream] could not give the card back: {}", exc)
            pool.drop_weights()
        _ACTIVE_POOL = None
        _ENCODER_POOL = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("[small_gpu_stream] previous DiT forgotten before loading the new one.")
    except Exception as exc:
        logger.debug("[small_gpu_stream] could not forget the previous DiT: {}", exc)


def log_stats() -> None:
    """Log (and reset) the timing figures of the DiT pool for the generation that just ended."""
    pool = _ACTIVE_POOL
    if pool is None or not pool.stats.enabled or pool.stats.runs == 0:
        return
    try:
        pinned = None
        if pool.cuda:
            pinned = "yes" if pool.pinned_count == pool.pinned_total else f"NO ({pool.pinned_count}/{pool.pinned_total} tensors)"
        logger.info(format_stats(pool.stats.summary(), pinned, pool.resident_n, pool.count))
    except Exception as exc:  # statistics must never break a generation
        logger.debug("[small_gpu_stream] could not report the statistics: {}", exc)
    finally:
        pool.stats.reset()


def report_checks() -> None:
    """Log the result of the self-check (``ACESTEP_STREAM_CHECK=1``) for both pools, once."""
    for pool in (_ENCODER_POOL, _ACTIVE_POOL):
        if pool is not None and pool.check is not None:
            try:
                pool.check.report()
            except Exception as exc:  # a diagnostic must never break a generation
                logger.debug("[small_gpu_stream] could not report the self-check: {}", exc)


def give_card_back_if_active() -> None:
    """Free the card after a DiT pass that ran once the audio was already decoded (lyric timestamps, alignment score).

    The decode gives the card back before the VAE, but the DiT is attached to the card again when the lyric alignment runs
    afterwards, and nothing released it: the engine kept its resident blocks (about 6 GB) and the programs that need the
    card next (the cover worker) ran out of memory. Without the stream mode this does nothing.
    """
    if active():
        release_gpu()


@contextmanager
def alignment_heads(config: Dict[int, List[int]], decoder: Optional[nn.Module] = None):
    """Around a decoder call that reads the cross-attention of some heads (lyric timestamps, alignment score).

    Yields the config to give the decoder, which numbers the kept heads 0, 1, 2... per layer, so that the decoder's own selection and
    ``compact_alignment_attentions`` read the compact weights back unchanged.
    - Stream mode running: the blocks keep only the listed heads on the card side (``StreamPool.select_alignment_heads``).
    - Otherwise, when the decoder is given: its cross-attention layers compute their weights a few heads at a time and return only the
      listed heads (``models/common/alignment_attention.py``), so the peak on the card no longer holds the weights of all the heads.
    - Neither (no config, no decoder): the config is yielded as it is and nothing else happens.
    """
    identity = {rank: list(range(len(heads))) for rank, heads in (config or {}).items()}
    pool = _ACTIVE_POOL
    if pool is not None and config:
        pool.align_heads = {rank: list(heads) for rank, heads in config.items()}
        try:
            yield identity
        finally:
            pool.align_heads = None
        return
    if decoder is not None and config:
        from acestep.models.common.alignment_attention import clear_alignment_keep, set_alignment_keep

        if set_alignment_keep(decoder, config):
            try:
                yield identity
            finally:
                clear_alignment_keep(decoder)
            return
    yield config


def release_gpu() -> None:
    """Free the card's slots (DiT and condition encoder); they are recreated on the next use."""
    log_stats()
    report_checks()
    clear_condition_cache()
    if _ACTIVE_POOL is not None:
        _ACTIVE_POOL.release_gpu()
    if _ENCODER_POOL is not None:
        _ENCODER_POOL.release_gpu()
    log_memory("after giving the card back")


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


def install_encoder(
    model: nn.Module,
    device: torch.device,
    cpu_dtype: torch.dtype = torch.bfloat16,
    pin: bool = True,
    compute_dtype: torch.dtype = torch.float32,
) -> StreamPool:
    """Stream the condition-encoder blocks of ``model`` through one pool (no environment checks)."""
    holders = _encoder_holders(model)
    if not holders:
        raise RuntimeError("no condition-encoder layers found")
    flat = [layer for holder in holders for layer in holder.layers]
    pool = StreamPool(flat, device, cpu_dtype, pin=pin, compute_dtype=compute_dtype)
    pool.label = "condition encoder"
    index = 0
    for holder in holders:
        proxies = []
        layers = list(holder.layers)
        for position, layer in enumerate(layers):
            proxies.append(StreamedLayer(index, layer, pool, last=(position == len(layers) - 1)))
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


# The engine runs ``prepare_condition`` more than once per generation with inputs that are often identical: once in
# ``_execute_service_generate_diffusion`` and again inside ``generate_audio`` (and a third time there for the
# "non-cover" condition when the cover strength is below 1, which the Studio sends by default). Each pass streams the
# condition encoder through the card (about 0.6 s at 30 s). The result is a pure function of the inputs, so an
# identical call can return the earlier result: a few small tensors are compared, never a different answer.
_CONDITION_CACHE: list = []
_CONDITION_CACHE_LIMIT = 3


def condition_cache_enabled() -> bool:
    """``ACESTEP_STREAM_CONDITION_CACHE=off`` (or 0 / no / false) runs every pass of the condition encoder."""
    return os.environ.get(ENV_CONDITION_CACHE, "auto").strip().lower() not in ("off", "0", "no", "false")


def clear_condition_cache() -> None:
    """Forget the saved condition results (end of a generation: the next one starts from its own inputs)."""
    _CONDITION_CACHE.clear()


def _same_value(a: Any, b: Any) -> bool:
    """Exact equality of two call arguments (tensors by shape, dtype, device and every element)."""
    if torch.is_tensor(a) or torch.is_tensor(b):
        return (torch.is_tensor(a) and torch.is_tensor(b) and a.shape == b.shape and a.dtype == b.dtype
                and a.device == b.device and bool(torch.equal(a, b)))
    if isinstance(a, (list, tuple)) or isinstance(b, (list, tuple)):
        return (type(a) is type(b) and len(a) == len(b) and all(_same_value(x, y) for x, y in zip(a, b)))
    try:
        return type(a) is type(b) and bool(a == b)
    except Exception:
        return False


def _snapshot(value: Any) -> Any:
    """Copy of a call argument or result that later in-place changes of the original cannot reach."""
    if torch.is_tensor(value):
        return value.detach().clone()
    if isinstance(value, (list, tuple)):
        return type(value)(_snapshot(item) for item in value)
    return value


def _has_tensor(value: Any) -> bool:
    if torch.is_tensor(value):
        return True
    if isinstance(value, (list, tuple)):
        return any(_has_tensor(item) for item in value)
    return False


def condition_cache_lookup(call: dict) -> Any:
    """The saved result of an earlier call with exactly these arguments (a fresh copy), or None."""
    for entry in _CONDITION_CACHE:
        saved = entry["call"]
        if saved.keys() == call.keys() and all(_same_value(saved[name], call[name]) for name in call):
            return _snapshot(entry["result"])
    return None


def condition_cache_store(call: dict, result: Any) -> None:
    """Remember ``result`` for ``call`` (the last few distinct calls of this generation)."""
    if not _has_tensor(list(call.values())) or not _has_tensor(result):
        return
    _CONDITION_CACHE.append({"call": {name: _snapshot(value) for name, value in call.items()}, "result": _snapshot(result)})
    del _CONDITION_CACHE[:-_CONDITION_CACHE_LIMIT]


def wrap_prepare_condition(model: nn.Module) -> None:
    """Make ``model.prepare_condition`` skip the audio tokenizer/detokenizer when the generation is not a cover.

    The engine computes ``torch.where(is_covers > 0, lm_hints, src_latents)``; with no cover in the batch the
    result is ``src_latents`` whatever ``lm_hints`` is, so the tokenizer and detokenizer are replaced by stubs
    returning a tensor of the right shape for the duration of the call. The condition-encoder slots are given
    back to the card as soon as the call is over. A call whose arguments equal an earlier call of the same
    generation returns that call's result instead of streaming the encoder again.
    """
    original = model.prepare_condition

    def prepare_condition(*args, **kwargs):
        log_memory("start of a generation")
        call = None
        if condition_cache_enabled():
            try:
                call = inspect_bind(original, args, kwargs, defaults=True)
                saved = condition_cache_lookup(call)
            except Exception:
                call, saved = None, None
            if saved is not None:
                logger.info("[small_gpu_stream] condition encoder: same inputs as an earlier pass of this generation, result reused.")
                return saved
        try:
            bound = inspect_bind(original, args, kwargs)
            plain = _is_plain_generation(bound.get("is_covers"), bound.get("precomputed_lm_hints_25Hz"), bound.get("audio_codes"))
        except Exception:
            plain = False
        stubbed = False
        if plain:
            model.tokenize = lambda x, silence_latent, attention_mask: (x, None, attention_mask)
            model.detokenize = lambda quantized: quantized
            stubbed = True
        try:
            result = original(*args, **kwargs)
        finally:
            if stubbed:
                # remove the instance attributes: the class methods are visible again
                model.__dict__.pop("tokenize", None)
                model.__dict__.pop("detokenize", None)
            if _ENCODER_POOL is not None:
                _ENCODER_POOL.release_gpu()
                log_memory("after the condition encoder")
        if call is not None:
            try:
                condition_cache_store(call, result)
            except Exception as exc:  # a cache failure must never break a generation
                logger.debug("[small_gpu_stream] could not save the condition result: {}", exc)
        return result

    model.prepare_condition = prepare_condition


def inspect_bind(func: Any, args: tuple, kwargs: dict, defaults: bool = False) -> dict:
    """The arguments of a call by name; ``defaults=True`` also fills in the ones the caller left out (None passed or omitted look alike)."""
    import inspect

    bound = inspect.signature(func).bind_partial(*args, **kwargs)
    if defaults:
        bound.apply_defaults()
    return dict(bound.arguments)


def attach_encoder(model: nn.Module, device: torch.device, cpu_dtype: torch.dtype, compute_dtype: torch.dtype = torch.float32) -> bool:
    """Stream the condition encoder and skip the useless cover step. Never raises (the encoder then stays on the processor)."""
    global _ENCODER_POOL
    try:
        pool = install_encoder(model, device, cpu_dtype, compute_dtype=compute_dtype)
        if _truthy(os.environ.get(ENV_CHECK)):
            pool.check = SelfCheck("condition encoder", pool.count, compute_dtype)
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


def vae_chunk_explicit() -> Optional[int]:
    """The tile size asked for with ``ACESTEP_STREAM_VAE_CHUNK``, or ``None`` when it is not set (or not a number)."""
    raw = os.environ.get(ENV_VAE_CHUNK, "").strip()
    if not raw:
        return None
    try:
        int(raw)
    except ValueError:
        return None
    return vae_chunk_size()


def vae_chunk_ladder(free_bytes: int, explicit: Optional[int] = None) -> List[int]:
    """Tile sizes to try, biggest first: each one is half the previous, down to ``DEFAULT_VAE_CHUNK``.

    With ``explicit`` the first size is that value. Without it, the first size follows the free memory of the card
    (``VAE_FREE_SHARE`` of it at ``VAE_BYTES_PER_FRAME`` per latent frame), between ``DEFAULT_VAE_CHUNK`` and
    ``VAE_CHUNK_MAX``. A size at or below ``DEFAULT_VAE_CHUNK`` gives a ladder of one.
    """
    if explicit is not None:
        start = max(24, int(explicit))
    else:
        start = int(max(0, free_bytes) * VAE_FREE_SHARE / VAE_BYTES_PER_FRAME)
        start = max(DEFAULT_VAE_CHUNK, min(VAE_CHUNK_MAX, start))
    ladder = [start]
    while ladder[-1] > DEFAULT_VAE_CHUNK:
        ladder.append(max(DEFAULT_VAE_CHUNK, ladder[-1] // 2))
    return ladder


def decode_with_ladder(handler: Any, latents: torch.Tensor, ladder: List[int], clear: Any = None):
    """Decode ``latents`` ([batch, 64, frames], on the card) tile by tile; return ``(audio on the processor, tile size used)``.

    The engine's own ``_tiled_decode_inner`` answers a lack of memory by decoding the whole track on the processor,
    which is very slow. Here a lack of memory first retries the sample with the next smaller tile size of ``ladder``;
    only when the last one fails too does the engine's chain (which ends on the processor) take over.
    ``clear`` is called before each retry (it frees the card's cache).
    """
    import math

    pieces = []
    used = ladder[-1]
    for b in range(latents.shape[0]):
        single = latents[b : b + 1]
        frames = single.shape[-1]
        done = None
        for chunk in ladder:
            overlap = min(DEFAULT_VAE_OVERLAP, max(4, chunk // 4))
            failed = False
            try:
                if frames <= chunk:
                    done = handler.vae.decode(single).sample.to("cpu")
                else:
                    stride = chunk - 2 * overlap
                    done = handler._tiled_decode_offload_cpu(single, 1, frames, stride, overlap, math.ceil(frames / stride))
                used = chunk
                break
            except torch.cuda.OutOfMemoryError:
                logger.warning("[small_gpu_stream] VAE decode: out of memory with tiles of {} frames; trying smaller ones", chunk)
                failed = True
            if failed and clear is not None:
                clear()  # outside the except block, so the failed tile's tensors are no longer referenced
        if done is None:
            chunk = ladder[-1]
            logger.warning("[small_gpu_stream] VAE decode: smallest tiles failed; handing over to the engine's fallback")
            done = handler._tiled_decode_inner(single, chunk, min(DEFAULT_VAE_OVERLAP, max(4, chunk // 4)), True)
            done = done.to("cpu")
        pieces.append(done)
    return (pieces[0] if len(pieces) == 1 else torch.cat(pieces, dim=0)), used


def snapshot_cpu_weights(module: nn.Module) -> Optional[list]:
    """The processor tensors of a float32 module (parameters and buffers), to put back after it has been on the card; None if unsafe.

    ``Module.to`` replaces them by card copies; coming back with ``to("cpu")`` copies every weight again (0.3 s for the VAE)
    although nothing changed them. None when the module is not entirely float32 on the processor: the regular ``to`` is used then.
    """
    try:
        modules = list(module.modules())
        params = [(sub, name, p, p.data) for sub in modules for name, p in sub._parameters.items() if p is not None]
        buffers = [(sub, name, b) for sub in modules for name, b in sub._buffers.items() if b is not None]
        if not params or any(d.device.type != "cpu" or d.dtype != torch.float32 for _s, _n, _p, d in params):
            return None
        if any(b.device.type != "cpu" for _s, _n, b in buffers):
            return None
        return [params, buffers]
    except Exception:
        return None


def restore_cpu_weights(saved: list) -> None:
    """Put back the tensors taken by ``snapshot_cpu_weights`` (``to`` may have replaced the Parameter objects themselves)."""
    params, buffers = saved
    for sub, name, p, data in params:
        p.data = data
        sub._parameters[name] = p
    for sub, name, b in buffers:
        sub._buffers[name] = b


def drop_card_leftovers(module: nn.Module, on_card: Any = None) -> int:
    """Bring back to the processor the plain tensors a module keeps on the card after ``module.to("cpu")``; returns the bytes moved.

    ``Module.to`` moves parameters and buffers only. The audio decoder's convolutions use the (deprecated, hook based)
    ``weight_norm``, which stores the weight it computes for each forward as an ordinary attribute: after a decode on the card
    those copies stay there, about 0.3 GB for the VAE, for as long as the Studio runs. ``on_card`` tells whether a tensor is on the
    card (default: ``tensor.is_cuda``). The next forward recomputes these attributes, so only their place changes.
    """
    check = on_card if on_card is not None else (lambda tensor: tensor.is_cuda)
    moved = 0
    for sub in module.modules():
        for name, value in list(sub.__dict__.items()):
            if torch.is_tensor(value) and check(value):
                moved += value.numel() * value.element_size()
                sub.__dict__[name] = value.detach().to("cpu")
    return moved


def log_decode_steps(clock: "PhaseClock") -> None:
    """One line on where the time of the audio decoding went (with ``ACESTEP_STREAM_STATS=0`` it is not written). Never raises."""
    try:
        if not stats_enabled():
            return
        pool = _ACTIVE_POOL
        freed = getattr(pool, "release_times", None) if pool is not None else None
        detail = f" (DiT blocks dropped and collected {freed[0]:.2f} s, cache emptied {freed[1]:.2f} s)" if freed else ""
        logger.info("[small_gpu_stream] audio decoding steps: {}{}", clock.text(), detail)
    except Exception as exc:
        logger.debug("[small_gpu_stream] could not report the decoding steps: {}", exc)


class PhaseClock:
    """Seconds spent in each step of a sequence (the card is synchronised at each lap so that queued work is counted where it ran)."""

    def __init__(self) -> None:
        self.laps: List[tuple] = []
        self._t = time.perf_counter()

    def lap(self, name: str) -> None:
        try:
            if torch.cuda.is_available():
                torch.cuda.synchronize()
        except Exception:  # a measurement must never break a generation
            pass
        now = time.perf_counter()
        self.laps.append((name, now - self._t))
        self._t = now

    def text(self) -> str:
        return " | ".join(f"{name} {seconds:.2f} s" for name, seconds in self.laps)


def tiled_decode_on_card(handler: Any, latents: torch.Tensor) -> torch.Tensor:
    """Decode ``latents`` ([batch, 64, frames]) with the handler's VAE on the card, in float32 tiles.

    The tile size follows the card's free memory once the DiT slots are given back (``ACESTEP_STREAM_VAE_CHUNK``
    fixes it). The VAE is moved back to the processor afterwards. If the card runs out of memory the decode retries with
    smaller tiles on the card (``decode_with_ladder``) before the engine's fallback to the processor.
    """
    clock = PhaseClock()
    release_gpu()  # the DiT slots are not needed any more; the VAE needs the room
    clock.lap("card given back")
    device = torch.device("cuda")
    vae = handler.vae

    def clear(full: bool = True) -> None:
        # ``full`` also runs the garbage collector: needed after a failure (a failed tile's tensors may sit in reference
        # cycles), pointless after a normal step, where everything the decode held is released by reference counting.
        if full:
            gc.collect()
        torch.cuda.empty_cache()

    saved = snapshot_cpu_weights(vae)
    try:
        vae.to(device=device, dtype=torch.float32)
        clock.lap("weights to the card")
        card_latents = latents.to(device=device, dtype=torch.float32)
        clear(full=False)
        clock.lap("input and cache")
        free_bytes = torch.cuda.mem_get_info(device)[0]
        ladder = vae_chunk_ladder(free_bytes, vae_chunk_explicit())
        logger.info("[small_gpu_stream] VAE decode on {} (float32, tiles of {} frames, overlap {}, {:.2f} GB free)",
                    torch.cuda.get_device_name(device), ladder[0], min(DEFAULT_VAE_OVERLAP, max(4, ladder[0] // 4)),
                    free_bytes / 1024 ** 3)
        torch.cuda.reset_peak_memory_stats(device)
        t0 = time.perf_counter()
        result, used = decode_with_ladder(handler, card_latents, ladder, clear)
        logger.info("[small_gpu_stream] VAE decode done in {:.1f} s with tiles of {} frames, peak {:.2f} GB on the card",
                    time.perf_counter() - t0, used, torch.cuda.max_memory_allocated(device) / 1024 ** 3)
        clock.lap("decode")
        return result
    finally:
        failed = sys.exc_info()[0] is not None
        try:
            if saved is not None:
                restore_cpu_weights(saved)  # the weights did not change: take the processor copies again instead of copying them back
            else:
                handler.vae = handler.vae.to(device="cpu", dtype=torch.float32)
        except Exception as exc:  # pragma: no cover
            logger.warning("[small_gpu_stream] could not move the VAE back to the processor: {}", exc)
            try:
                handler.vae = handler.vae.to(device="cpu", dtype=torch.float32)
            except Exception:
                pass
        saved = None
        clock.lap("weights back")
        try:
            left = drop_card_leftovers(handler.vae)
            if left:
                logger.debug("[small_gpu_stream] {:.0f} MB of VAE weights left on the card by the decoder moved back to the processor.", left / 1024 ** 2)
        except Exception as exc:  # pragma: no cover - freeing memory must never break a generation
            logger.debug("[small_gpu_stream] could not free the VAE leftovers: {}", exc)
        clear(full=failed)
        clock.lap("cleanup")
        log_decode_steps(clock)
        log_memory("after the audio decoding")
