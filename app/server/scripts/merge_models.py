"""ACE-Step model merger with multiple merge methods.

Supports:
- weighted_sum: output = (1 - alpha) * A + alpha * B
- add_difference: output = A + alpha * (B - A)  (same as task arithmetic)
- multiply: output = A * (B / A) ^ alpha  (geometric / SmoothStep)

Usage:
  python merge_models.py --model-a <path> --model-b <path> --output <path> \
    [--alpha 0.5] [--method weighted_sum]
"""

from __future__ import annotations

import json
import shutil
import sys
import traceback
from pathlib import Path
from typing import Dict, List, Tuple

import torch
from safetensors import safe_open
from safetensors.torch import save_file

METHODS = ['weighted_sum', 'add_difference', 'multiply']


def emit(event: str, **kwargs):
    print(json.dumps({"event": event, **kwargs}), flush=True)


def find_safetensors(source: Path) -> Tuple[List[Path], List[Path], bool]:
    """Returns (safetensor_files, support_files, is_folder)."""
    if source.is_file():
        if source.suffix.lower() != ".safetensors":
            raise RuntimeError(f"Not a safetensors file: {source}")
        return [source], [], False

    safetensor_files = sorted(p for p in source.rglob("*.safetensors") if p.is_file())
    if not safetensor_files:
        raise RuntimeError(f"No .safetensors files found in {source}")

    support_files = [
        p for p in source.rglob("*")
        if p.is_file() and p.suffix.lower() != ".safetensors"
    ]
    return safetensor_files, support_files, True


def merge_tensors(
    tensor_a: torch.Tensor,
    tensor_b: torch.Tensor,
    alpha: float,
    method: str,
) -> torch.Tensor:
    """Merge two tensors using the specified method."""
    if not tensor_a.is_floating_point() or not tensor_b.is_floating_point():
        return tensor_a  # Non-float tensors (indices, etc.) — keep from A

    a = tensor_a.to(torch.float32)
    b = tensor_b.to(torch.float32)

    if method == 'weighted_sum':
        result = (1.0 - alpha) * a + alpha * b
    elif method == 'add_difference':
        result = a + alpha * (b - a)
    elif method == 'multiply':
        # Geometric merge: A * (B/A)^alpha
        # Safe division: avoid div by zero, use sign-aware power
        eps = 1e-10
        ratio = b / (a + eps * a.sign().clamp(min=eps))
        ratio = ratio.clamp(-1e6, 1e6)  # Prevent explosion
        result = a * torch.pow(ratio.abs() + eps, alpha) * ratio.sign()
    else:
        result = (1.0 - alpha) * a + alpha * b

    return result.to(tensor_a.dtype)


def merge_single_file(
    path_a: Path, path_b: Path, output_path: Path,
    alpha: float, method: str,
    file_idx: int, total_files: int,
) -> int:
    """Merge two safetensors files. Returns tensor count."""
    merged: Dict[str, torch.Tensor] = {}

    with safe_open(str(path_a), framework="pt", device="cpu") as f_a, \
         safe_open(str(path_b), framework="pt", device="cpu") as f_b:

        metadata_a = f_a.metadata() or {}
        keys_a = set(f_a.keys())
        keys_b = set(f_b.keys())
        common_keys = sorted(keys_a & keys_b)
        only_a = keys_a - keys_b
        total = len(common_keys) + len(only_a)

        for i, key in enumerate(common_keys, 1):
            tensor_a = f_a.get_tensor(key)
            tensor_b = f_b.get_tensor(key)
            merged[key] = merge_tensors(tensor_a, tensor_b, alpha, method).contiguous()
            del tensor_a, tensor_b

            if i % 50 == 0 or i == len(common_keys):
                emit("tensor_progress", file=path_a.name, current=i, total=total,
                     file_idx=file_idx, total_files=total_files)

        # Keys only in A — copy as-is
        for key in sorted(only_a):
            merged[key] = f_a.get_tensor(key).contiguous()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_a['format'] = 'pt'
    save_file(merged, str(output_path), metadata=metadata_a)
    return len(merged)


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-a", required=True, help="Path to model A (base)")
    parser.add_argument("--model-b", required=True, help="Path to model B (merge)")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--alpha", type=float, default=0.5, help="Blend weight (0=A, 1=B)")
    parser.add_argument("--method", choices=METHODS, default="weighted_sum", help="Merge method")
    args = parser.parse_args()

    try:
        path_a = Path(args.model_a)
        path_b = Path(args.model_b)
        output_dir = Path(args.output)
        alpha = max(0.0, min(1.0, args.alpha))
        method = args.method

        files_a, support_a, is_folder_a = find_safetensors(path_a)
        files_b, support_b, is_folder_b = find_safetensors(path_b)

        emit("analyze", model_a=str(path_a), model_b=str(path_b),
             files_a=len(files_a), files_b=len(files_b),
             alpha=alpha, method=method)

        output_dir.mkdir(parents=True, exist_ok=True)

        # Copy support files from model A
        if is_folder_a and support_a:
            emit("status", message=f"Copying {len(support_a)} support files from Model A...")
            for src_file in support_a:
                relative = src_file.relative_to(path_a)
                dst_file = output_dir / relative
                dst_file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_file, dst_file)

        # Build file pairs
        if not is_folder_a and not is_folder_b:
            out_name = f"{path_a.stem}-merged.safetensors"
            pairs = [(files_a[0], files_b[0], output_dir / out_name)]
        elif is_folder_a and is_folder_b:
            b_map = {fb.relative_to(path_b): fb for fb in files_b}
            pairs = []
            for fa in files_a:
                rel = fa.relative_to(path_a)
                fb = b_map.get(rel)
                if fb:
                    pairs.append((fa, fb, output_dir / rel))
                else:
                    emit("status", message=f"No match for {rel} in Model B, copying from A")
                    dst = output_dir / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(fa, dst)
        else:
            pairs = [(files_a[0], files_b[0], output_dir / files_a[0].name)]

        total_tensors = 0
        for idx, (fa, fb, out) in enumerate(pairs, 1):
            emit("file_start", file=fa.name, file_idx=idx, total_files=len(pairs))
            count = merge_single_file(fa, fb, out, alpha, method, idx, len(pairs))
            total_tensors += count
            emit("file_done", file=fa.name, tensors=count)

        emit("done", output_dir=str(output_dir), total_tensors=total_tensors,
             alpha=alpha, method=method)

    except Exception as e:
        emit("error", message=str(e), traceback=traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
