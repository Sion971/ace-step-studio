"""BF16 converter for safetensors models.

Converts all floating-point tensors to bfloat16, copies support files.
Outputs JSON progress to stdout for the Node.js backend to consume.

Usage:
  python bf16_convert.py --source <path> --output <path> [--no-subfolder]
"""

from __future__ import annotations

import json
import shutil
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple

import torch
from safetensors import safe_open
from safetensors.torch import save_file


@dataclass
class SourceInfo:
    source_path: Path
    source_type: str  # 'file' or 'folder'
    display_name: str
    safetensor_files: List[Path]
    support_files: List[Path]
    is_sharded: bool
    has_index: bool


def emit(event: str, **kwargs):
    """Send a JSON event to stdout for the Node.js parent process."""
    print(json.dumps({"event": event, **kwargs}), flush=True)


def analyze_source(source_path: Path) -> SourceInfo:
    if not source_path.exists():
        raise RuntimeError(f"Path not found: {source_path}")

    if source_path.is_file():
        if source_path.suffix.lower() != ".safetensors":
            raise RuntimeError("Single file must be .safetensors")
        return SourceInfo(
            source_path=source_path,
            source_type="file",
            display_name=source_path.stem,
            safetensor_files=[source_path],
            support_files=[],
            is_sharded=False,
            has_index=False,
        )

    safetensor_files = sorted(p for p in source_path.rglob("*.safetensors") if p.is_file())
    if not safetensor_files:
        raise RuntimeError("No .safetensors files found in folder")

    support_files = []
    has_index = False
    for p in source_path.rglob("*"):
        if not p.is_file() or p.suffix.lower() == ".safetensors":
            continue
        support_files.append(p)
        if p.name == "model.safetensors.index.json":
            has_index = True

    shard_count = sum(1 for p in safetensor_files if p.name.startswith("model-"))
    is_sharded = has_index or shard_count > 1

    return SourceInfo(
        source_path=source_path,
        source_type="folder",
        display_name=source_path.name,
        safetensor_files=safetensor_files,
        support_files=support_files,
        is_sharded=is_sharded,
        has_index=has_index,
    )


def build_output_paths(info: SourceInfo, output_dir: Path, create_subfolder: bool) -> Tuple[Path, List[Tuple[Path, Path]]]:
    if info.source_type == "file":
        result_name = f"{info.display_name}-bf16.safetensors"
        base_dir = output_dir / f"{info.display_name}-bf16" if create_subfolder else output_dir
        return base_dir, [(info.safetensor_files[0], base_dir / result_name)]

    base_dir = output_dir / f"{info.display_name}-bf16" if create_subfolder else output_dir
    mapping = []
    for src_file in info.safetensor_files:
        relative = src_file.relative_to(info.source_path)
        mapping.append((src_file, base_dir / relative))
    return base_dir, mapping


def convert_file(src: Path, dst: Path, file_idx: int, total_files: int) -> int:
    """Convert a single safetensors file. Returns number of tensors processed."""
    tensors = {}
    with safe_open(str(src), framework="pt", device="cpu") as f:
        metadata = f.metadata() or {}
        keys = list(f.keys())
        total = len(keys)

        for i, key in enumerate(keys, 1):
            tensor = f.get_tensor(key)
            if tensor.is_floating_point():
                tensor = tensor.to(torch.bfloat16)
            tensors[key] = tensor.contiguous()

            if i % 50 == 0 or i == total:
                emit("tensor_progress", file=src.name, current=i, total=total,
                     file_idx=file_idx, total_files=total_files)

    dst.parent.mkdir(parents=True, exist_ok=True)
    # Ensure 'format' metadata is set — transformers requires it to be 'pt'
    metadata['format'] = 'pt'
    save_file(tensors, str(dst), metadata=metadata)
    return len(keys)


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="Source file or folder")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--no-subfolder", action="store_true", help="Don't create subfolder")
    args = parser.parse_args()

    try:
        source_path = Path(args.source)
        output_dir = Path(args.output)
        create_subfolder = not args.no_subfolder

        info = analyze_source(source_path)

        emit("analyze", source_type=info.source_type, display_name=info.display_name,
             safetensor_count=len(info.safetensor_files), support_count=len(info.support_files),
             is_sharded=info.is_sharded, has_index=info.has_index)

        base_dir, mapping = build_output_paths(info, output_dir, create_subfolder)
        base_dir.mkdir(parents=True, exist_ok=True)

        # Copy support files
        if info.source_type == "folder" and info.support_files:
            emit("status", message=f"Copying {len(info.support_files)} support files...")
            for src_file in info.support_files:
                relative = src_file.relative_to(info.source_path)
                dst_file = base_dir / relative
                dst_file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_file, dst_file)

        # Convert safetensors
        total_tensors = 0
        for file_idx, (src, dst) in enumerate(mapping, 1):
            emit("file_start", file=src.name, file_idx=file_idx, total_files=len(mapping))
            count = convert_file(src, dst, file_idx, len(mapping))
            total_tensors += count
            emit("file_done", file=src.name, tensors=count)

        # Calculate sizes
        src_size = sum(f.stat().st_size for f in info.safetensor_files)
        dst_size = sum(dst.stat().st_size for _, dst in mapping)

        emit("done", output_dir=str(base_dir), total_tensors=total_tensors,
             source_size_mb=round(src_size / 1024 / 1024, 1),
             output_size_mb=round(dst_size / 1024 / 1024, 1),
             savings_pct=round((1 - dst_size / src_size) * 100, 1) if src_size > 0 else 0)

    except Exception as e:
        emit("error", message=str(e), traceback=traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
