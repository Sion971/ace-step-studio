"""LoRA adapters for the small-card stream mode.

In stream mode the DiT blocks live in RAM and pass through two slots on the card, so PEFT cannot wrap them. The adapter is
applied where the weights arrive instead: right after a block's weights are copied into a slot (or into a resident block),
``weight += scale * alpha / r * (B @ A)`` is added on the card to every targeted weight. Nothing is merged into the RAM
copies, so the base model stays untouched: switching the adapter off, changing its strength or removing it only means that
the card copies are rebuilt, and no copy of the base weights is kept anywhere.

Supported: PEFT LoRA adapters on the linear layers of the DiT blocks (``layers.N.<module>.lora_A/B.weight``), with ``r``,
``lora_alpha``, ``use_rslora``, ``rank_pattern`` and ``alpha_pattern``. Refused: DoRA, transposed (``fan_in_fan_out``)
weights, and LoKr. Weights an adapter holds outside the blocks are ignored, and counted in the message.
"""

import json
import math
import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import torch
from loguru import logger

_KEY = re.compile(r"^base_model\.model\.(?:decoder\.)?layers\.(\d+)\.(.+)\.lora_([AB])(?:\.[^.]+)?\.weight$")
STORE_DTYPE = torch.bfloat16  # the factors are kept like the block weights: half the RAM and half the bus traffic


class StreamLoraError(Exception):
    """The adapter cannot be used in stream mode; the message is shown to the user."""


@dataclass
class Target:
    param_index: int
    a: torch.Tensor  # [r, in]
    b: torch.Tensor  # [out, r]
    factor: float    # alpha / r (or alpha / sqrt(r)), without the user's strength


@dataclass
class StreamAdapter:
    name: str
    path: str
    layers: Dict[int, List[Target]] = field(default_factory=dict)
    targets: int = 0
    ignored: int = 0  # LoRA weights that belong to something other than a streamed block


def _read_state(path: str) -> dict:
    safetensors_file = os.path.join(path, "adapter_model.safetensors")
    if os.path.isfile(safetensors_file):
        from safetensors.torch import load_file

        return load_file(safetensors_file, device="cpu")
    bin_file = os.path.join(path, "adapter_model.bin")
    if os.path.isfile(bin_file):
        return torch.load(bin_file, map_location="cpu", weights_only=True)
    raise StreamLoraError(f"no adapter_model.safetensors in {path}")


def _read_config(path: str) -> dict:
    try:
        with open(os.path.join(path, "adapter_config.json"), "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise StreamLoraError(f"could not read adapter_config.json: {exc}") from exc
    if not isinstance(config, dict):
        raise StreamLoraError("adapter_config.json must be a JSON object")
    if config.get("use_dora"):
        raise StreamLoraError("DoRA adapters are not supported in small-card mode")
    if config.get("fan_in_fan_out"):
        raise StreamLoraError("adapters with transposed weights (fan_in_fan_out) are not supported in small-card mode")
    return config


def _alpha_for(module_path: str, config: dict) -> float:
    patterns = config.get("alpha_pattern") or {}
    for pattern, value in patterns.items():
        if module_path == pattern or module_path.endswith("." + pattern):
            return float(value)
    return float(config.get("lora_alpha", config.get("r", 8)))


def load_adapter(name: str, path: str, param_names: List[str], param_shapes: List[tuple], layer_count: int) -> StreamAdapter:
    """Read an adapter folder and keep its factors for the blocks of the pool. Raises StreamLoraError."""
    config = _read_config(path)
    state = _read_state(path)
    rslora = bool(config.get("use_rslora"))
    index_of = {n: i for i, n in enumerate(param_names)}
    halves: Dict[Tuple[int, str], dict] = {}
    adapter = StreamAdapter(name=name, path=path)
    for key, tensor in state.items():
        match = _KEY.match(key)
        if match is None:
            if ".lora_" in key:
                adapter.ignored += 1
            continue
        layer, module_path, which = int(match.group(1)), match.group(2), match.group(3)
        if layer >= layer_count or f"{module_path}.weight" not in index_of:
            adapter.ignored += 1
            continue
        halves.setdefault((layer, module_path), {})[which] = tensor
    for (layer, module_path), pair in sorted(halves.items()):
        if "A" not in pair or "B" not in pair:
            raise StreamLoraError(f"layer {layer} {module_path}: lora_A or lora_B is missing")
        a, b = pair["A"], pair["B"]
        index = index_of[f"{module_path}.weight"]
        if a.dim() != 2 or b.dim() != 2 or a.shape[0] != b.shape[1] or (b.shape[0], a.shape[1]) != tuple(param_shapes[index]):
            raise StreamLoraError(
                f"layer {layer} {module_path}: factors {tuple(b.shape)} x {tuple(a.shape)} do not fit a weight of {tuple(param_shapes[index])}"
            )
        rank = a.shape[0]
        alpha = _alpha_for(module_path, config)
        factor = alpha / (math.sqrt(rank) if rslora else rank)
        adapter.layers.setdefault(layer, []).append(
            Target(index, a.detach().to(STORE_DTYPE).contiguous(), b.detach().to(STORE_DTYPE).contiguous(), factor)
        )
        adapter.targets += 1
    if adapter.targets == 0:
        raise StreamLoraError("no LoRA weight of this adapter matches a block of the DiT")
    return adapter


class StreamLoraSet:
    """The adapters known to the pool, which one is active, whether it is on, and its strength."""

    def __init__(self, pool) -> None:
        self.pool = pool
        self.adapters: Dict[str, StreamAdapter] = {}
        self.scales: Dict[str, float] = {}
        self.active: Optional[str] = None
        self.enabled = True
        self._pinned = False

    # -- bookkeeping --------------------------------------------------------------------------------------------
    def add(self, adapter: StreamAdapter) -> None:
        if self.pool.cuda:
            for targets in adapter.layers.values():
                for t in targets:
                    try:
                        t.a, t.b = t.a.pin_memory(), t.b.pin_memory()
                    except Exception:  # not enough lockable RAM: the copies are slower, nothing else changes
                        pass
        self.adapters[adapter.name] = adapter
        self.scales[adapter.name] = 1.0
        self.active = adapter.name
        self.changed()

    def remove(self, name: str) -> None:
        self.adapters.pop(name, None)
        self.scales.pop(name, None)
        if self.active == name:
            self.active = next(iter(self.adapters), None)
        self.changed()

    def clear(self) -> None:
        self.adapters.clear()
        self.scales.clear()
        self.active = None
        self.changed()

    def set_scale(self, name: str, scale: float) -> None:
        self.scales[name] = float(scale)
        self.changed()

    def set_enabled(self, enabled: bool) -> None:
        self.enabled = bool(enabled)
        self.changed()

    def set_active(self, name: str) -> None:
        if name in self.adapters:
            self.active = name
            self.changed()

    def changed(self) -> None:
        """Card copies were built with the previous settings: give them up, they are rebuilt at the next use."""
        self.pool.release_gpu()

    # -- use by the pool ----------------------------------------------------------------------------------------
    def targets_of(self, layer_idx: int) -> List[Target]:
        if not self.enabled or self.active is None or self.scales.get(self.active, 0.0) == 0.0:
            return []
        adapter = self.adapters.get(self.active)
        return adapter.layers.get(layer_idx, []) if adapter is not None else []

    @torch.no_grad()
    def apply(self, layer_idx: int, params: List[torch.Tensor]) -> None:
        """Add the active adapter's change to the card copy of block ``layer_idx`` (``params`` in the block's parameter order)."""
        targets = self.targets_of(layer_idx)
        if not targets:
            return
        strength = self.scales.get(self.active, 1.0)
        for t in targets:
            dst = params[t.param_index]
            a = t.a.to(dst.device, non_blocking=True).to(torch.float32)
            b = t.b.to(dst.device, non_blocking=True).to(torch.float32)
            alpha = t.factor * strength
            if dst.dtype == torch.float32:
                dst.addmm_(b, a, alpha=alpha)
            else:  # the change is worked out in float32 and rounded once into the weight
                dst.add_((b @ a).mul_(alpha).to(dst.dtype))
