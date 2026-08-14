"""Bake LoRA adapter into base ACE-Step model.

Loads base model weights + LoRA adapter, merges them into a single model.
Supports PEFT-style LoRA (lora_A/lora_B decomposition) and direct delta weights.

Formula: merged_weight = base_weight + strength * (lora_B @ lora_A)

Usage:
  python bake_lora.py --base <model_dir> --lora <lora_path> --output <output_dir> [--strength 1.0]
"""

from __future__ import annotations

import json
import shutil
import sys
import traceback
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def emit(event: str, **kwargs):
    print(json.dumps({"event": event, **kwargs}), flush=True)


def find_safetensors(folder: Path) -> List[Path]:
    """Find all .safetensors files recursively."""
    return sorted(p for p in folder.rglob("*.safetensors") if p.is_file())


def load_state_dict(files: List[Path]) -> Tuple[Dict[str, torch.Tensor], dict]:
    """Load all tensors from safetensors files into a single state dict."""
    state_dict: Dict[str, torch.Tensor] = {}
    metadata: dict = {}
    for f in files:
        with safe_open(str(f), framework="pt", device="cpu") as sf:
            if not metadata:
                metadata = sf.metadata() or {}
            for key in sf.keys():
                state_dict[key] = sf.get_tensor(key)
    return state_dict, metadata


def parse_lora_pairs(lora_sd: Dict[str, torch.Tensor]) -> Tuple[
    Dict[str, Dict[str, torch.Tensor]],  # decomposed pairs: base_key -> {A, B, [alpha]}
    Dict[str, torch.Tensor],              # direct delta weights: base_key -> tensor
]:
    """Parse LoRA state dict into decomposed A/B pairs and direct deltas.

    Supports naming conventions:
    - PEFT: base_model.model.{key}.lora_A.weight / .lora_B.weight
    - kohya: {key}.lora_down.weight / .lora_up.weight
    - Simple: {key}.lora_A / {key}.lora_B
    """
    pairs: Dict[str, Dict[str, torch.Tensor]] = {}
    directs: Dict[str, torch.Tensor] = {}

    for lora_key, tensor in lora_sd.items():
        # Detect A matrix (down projection)
        is_A = any(tag in lora_key for tag in ['.lora_A.', '.lora_A', '.lora_down.', '.lora_down'])
        is_B = any(tag in lora_key for tag in ['.lora_B.', '.lora_B', '.lora_up.', '.lora_up'])
        is_alpha = '.alpha' in lora_key

        if is_A or is_B or is_alpha:
            # Strip LoRA suffixes to get base key
            base_key = lora_key
            for suffix in ['.lora_A.weight', '.lora_B.weight', '.lora_A', '.lora_B',
                           '.lora_down.weight', '.lora_up.weight', '.lora_down', '.lora_up',
                           '.alpha']:
                base_key = base_key.replace(suffix, '')
            # Strip PEFT prefix
            base_key = base_key.replace('base_model.model.', '')

            if base_key not in pairs:
                pairs[base_key] = {}

            if is_A:
                pairs[base_key]['A'] = tensor
            elif is_B:
                pairs[base_key]['B'] = tensor
            elif is_alpha:
                pairs[base_key]['alpha'] = tensor
        else:
            # Direct weight (not decomposed)
            clean_key = lora_key.replace('base_model.model.', '')
            directs[clean_key] = tensor

    return pairs, directs


def find_base_key(candidates: List[str], base_sd: Dict[str, torch.Tensor]) -> Optional[str]:
    """Try to find a matching key in the base state dict."""
    for c in candidates:
        if c in base_sd:
            return c
    return None


def bake_lora(
    base_sd: Dict[str, torch.Tensor],
    lora_sd: Dict[str, torch.Tensor],
    strength: float,
) -> Tuple[Dict[str, torch.Tensor], int, int]:
    """Merge LoRA weights into base model.

    Returns (merged_state_dict, applied_count, skipped_count).
    """
    merged = dict(base_sd)
    applied = 0
    skipped = 0

    pairs, directs = parse_lora_pairs(lora_sd)
    total = len(pairs) + len(directs)

    emit("status", message=f"Found {len(pairs)} LoRA layers + {len(directs)} direct weights")

    # Apply decomposed LoRA pairs: delta = B @ A, scaled by strength and alpha
    for i, (base_key, pair) in enumerate(pairs.items()):
        if 'A' not in pair or 'B' not in pair:
            emit("status", message=f"Incomplete pair: {base_key}")
            skipped += 1
            continue

        # Find matching base key
        target = find_base_key(
            [base_key, f"{base_key}.weight", base_key.removesuffix('.weight')],
            merged,
        )

        if target is None:
            skipped += 1
            continue

        lora_A = pair['A'].to(torch.float32)
        lora_B = pair['B'].to(torch.float32)
        base_weight = merged[target].to(torch.float32)
        orig_dtype = merged[target].dtype

        # Per-layer alpha scaling (kohya style): scale = alpha / rank
        rank = lora_A.shape[0]
        lora_alpha = float(pair['alpha'].item()) if 'alpha' in pair else float(rank)
        scale = strength * (lora_alpha / rank)

        # Compute delta: B @ A for linear, or reshape for conv
        if lora_A.dim() == 2 and lora_B.dim() == 2:
            delta = lora_B @ lora_A
        elif lora_A.dim() == 4 and lora_B.dim() == 4:
            # Conv2d LoRA
            delta = torch.nn.functional.conv2d(
                lora_A.permute(1, 0, 2, 3), lora_B
            ).permute(1, 0, 2, 3)
        else:
            # Fallback: try matmul on first 2 dims
            try:
                delta = lora_B.reshape(lora_B.shape[0], -1) @ lora_A.reshape(lora_A.shape[0], -1)
                delta = delta.reshape(base_weight.shape)
            except Exception:
                skipped += 1
                continue

        if delta.shape != base_weight.shape:
            try:
                delta = delta.reshape(base_weight.shape)
            except Exception:
                emit("status", message=f"Shape mismatch: {base_key} base={base_weight.shape} delta={delta.shape}")
                skipped += 1
                continue

        merged[target] = (base_weight + scale * delta).to(orig_dtype)
        applied += 1

        if (i + 1) % 10 == 0 or i == len(pairs) - 1:
            emit("tensor_progress", current=i + 1, total=total,
                 file="LoRA merge", file_idx=1, total_files=1)

    # Apply direct delta weights
    for clean_key, delta_tensor in directs.items():
        target = find_base_key(
            [clean_key, f"{clean_key}.weight"],
            merged,
        )
        if target is None:
            skipped += 1
            continue

        base_weight = merged[target]
        if base_weight.shape != delta_tensor.shape:
            skipped += 1
            continue

        merged[target] = (base_weight.to(torch.float32) + strength * delta_tensor.to(torch.float32)).to(base_weight.dtype)
        applied += 1

    return merged, applied, skipped


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, help="Base model directory")
    parser.add_argument("--lora", required=True, help="LoRA adapter (directory or .safetensors file)")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--strength", type=float, default=1.0, help="LoRA strength (default 1.0)")
    args = parser.parse_args()

    try:
        base_path = Path(args.base)
        lora_path = Path(args.lora)
        output_dir = Path(args.output)
        strength = args.strength

        if not base_path.exists():
            raise RuntimeError(f"Base model not found: {base_path}")
        if not lora_path.exists():
            raise RuntimeError(f"LoRA not found: {lora_path}")

        base_files = find_safetensors(base_path)
        lora_files = [lora_path] if lora_path.is_file() else find_safetensors(lora_path)

        if not base_files:
            raise RuntimeError(f"No .safetensors in base model: {base_path}")
        if not lora_files:
            raise RuntimeError(f"No .safetensors in LoRA: {lora_path}")

        emit("analyze", base=str(base_path), lora=str(lora_path),
             base_files=len(base_files), lora_files=len(lora_files), strength=strength)

        # Load
        emit("status", message=f"Loading base model ({len(base_files)} files)...")
        base_sd, base_meta = load_state_dict(base_files)
        emit("status", message=f"Base: {len(base_sd)} tensors")

        emit("status", message=f"Loading LoRA ({len(lora_files)} files)...")
        lora_sd, _ = load_state_dict(lora_files)
        emit("status", message=f"LoRA: {len(lora_sd)} tensors")

        # Merge
        emit("status", message=f"Baking LoRA (strength={strength})...")
        merged, applied, skipped_ = bake_lora(base_sd, lora_sd, strength)
        emit("status", message=f"Applied {applied} layers, skipped {skipped_}")

        del base_sd, lora_sd

        # Save
        output_dir.mkdir(parents=True, exist_ok=True)

        # Copy support files (config, modeling scripts, etc.)
        for f in base_path.iterdir():
            if f.is_file() and f.suffix.lower() != '.safetensors':
                dst = output_dir / f.name
                if not dst.exists():
                    shutil.copy2(f, dst)

        emit("status", message="Saving merged model...")
        out_file = output_dir / "model.safetensors"
        base_meta['format'] = 'pt'
        save_file(merged, str(out_file), metadata=base_meta)

        # Remove stale index if saved as single file
        idx = output_dir / "model.safetensors.index.json"
        if idx.exists():
            idx.unlink()

        size_mb = round(out_file.stat().st_size / 1024 / 1024, 1)
        emit("done", output_dir=str(output_dir), applied=applied,
             skipped=skipped_, output_size_mb=size_mb)

    except Exception as e:
        emit("error", message=str(e), traceback=traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
