"""Check, before a training starts, that the preprocessed tensors were made by a model of the architecture about to be trained.

Tensors made by a 2B model and tensors made by an XL model have the same shape, so training the wrong pair raises no error: it
just learns from encodings the model does not understand. Since the preprocessing writes the decoder's hidden size (2048 for the
2B models, 2560 for XL) into each file's metadata, the trainer can compare it with the loaded model. Tensors made before that
was added carry no such entry: they are accepted without a word, and so is anything unreadable.

Only the architecture is compared, not the exact variant: Turbo, Base and SFT share the 2B architecture.

Tensors without the mention cannot be checked. The trainer says so (``unmarked_message``) instead of staying silent, and a folder
whose origin the user knows can be marked by hand::

    python -m acestep.training_v2.dataset_check ./datasets/preprocessed_turbo --family 2b
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Optional, Tuple

from acestep.training.model_signature import HIDDEN_SIZE_KEY, NAME_KEY, model_hidden_size

_FAMILY = {2048: "a 2B model (Turbo, Base or SFT)", 2560: "an XL (4B) model"}


def _first_tensor_file(dataset_dir: str) -> Optional[str]:
    try:
        manifest = os.path.join(dataset_dir, "manifest.json")
        if os.path.isfile(manifest):
            with open(manifest, "r", encoding="utf-8") as fh:
                for raw in json.load(fh).get("samples", []):
                    for candidate in (os.path.join(dataset_dir, raw), raw):
                        if isinstance(candidate, str) and candidate.endswith(".pt") and os.path.isfile(candidate):
                            return candidate
        for name in sorted(os.listdir(dataset_dir)):
            if name.endswith(".pt"):
                return os.path.join(dataset_dir, name)
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return None


def dataset_signature(dataset_dir: str) -> Tuple[Optional[int], Optional[str]]:
    """``(hidden_size, model_name)`` written by the preprocessing into the first tensor file (None when absent)."""
    path = _first_tensor_file(dataset_dir)
    if path is None:
        return None, None
    try:
        import torch

        meta = torch.load(path, map_location="cpu", weights_only=True).get("metadata") or {}
        size = meta.get(HIDDEN_SIZE_KEY)
        name = meta.get(NAME_KEY)
        return (size if isinstance(size, int) else None), (name if isinstance(name, str) else None)
    except Exception:  # noqa: BLE001 - an unreadable file is the dataset loader's business, not ours
        return None, None


def _family(width: int) -> str:
    return _FAMILY.get(width, f"a model of width {width}")


def config_hidden_size(checkpoint_dir: str, variant: str) -> Optional[int]:
    """Hidden size written in the model's ``config.json`` (None when it cannot be read): no weights are loaded."""
    try:
        from acestep.training_v2.model_loader import read_model_config

        value = read_model_config(checkpoint_dir, variant).get("hidden_size")
    except Exception:  # noqa: BLE001 - unknown layout: the check after loading takes over
        return None
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def mismatch_message(dataset_dir: str, model: Any) -> Optional[str]:
    """An explanation when the tensors come from another architecture than ``model``, else None."""
    return mismatch_message_for_width(dataset_dir, model_hidden_size(model))


def mismatch_message_for_width(dataset_dir: str, model_w: Optional[int]) -> Optional[str]:
    """Same as :func:`mismatch_message` for a model known only by its hidden size."""
    data_w, data_name = dataset_signature(dataset_dir)
    if data_w is None or model_w is None or data_w == model_w:
        return None
    made_with = f"{_family(data_w)}" + (f" ({data_name})" if data_name else "")
    return (
        f"The preprocessed tensors in {dataset_dir} were made with {made_with}, but the model loaded for training is "
        f"{_family(model_w)}. The tensors belong to the model that preprocessed them, and a LoRA only fits the model it was "
        f"trained on. Load the matching model (Create tab in the Studio, or --model-variant on the command line), or run the "
        f"preprocessing again with the model you want to train."
    )


def unmarked_message(dataset_dir: str) -> Optional[str]:
    """A warning when the first tensor file carries no model mark (None when it has one or no file can be read)."""
    path = _first_tensor_file(dataset_dir)
    if path is None:
        return None
    size, _name = dataset_signature(dataset_dir)
    if size is not None:
        return None
    try:
        import torch

        torch.load(path, map_location="cpu", weights_only=True)
    except Exception:  # noqa: BLE001 - unreadable: the dataset loader reports it
        return None
    return (
        f"The tensors in {dataset_dir} carry no model mark (made before 2026-11-02), so it cannot be checked that they come "
        f"from the architecture being trained. A 2B and an XL model give tensors of the same shape: with the wrong ones the "
        f"training runs but learns nothing useful. To get the check, run the preprocessing again, or mark this folder if you "
        f"know which model made it: python -m acestep.training_v2.dataset_check {dataset_dir} --family 2b   (or xl)."
    )


FAMILY_WIDTH = {"2b": 2048, "xl": 2560}


def mark_dataset(dataset_dir: str, family: str, force: bool = False) -> Tuple[int, int, int]:
    """Write the model mark into every ``.pt`` of ``dataset_dir`` by hand.

    Returns ``(marked, already_marked, refused)``. A file already marked is left alone, unless it says another architecture
    and ``force`` is false (counted as refused).
    """
    import torch

    width = FAMILY_WIDTH[family.lower()]
    marked = already = refused = 0
    for name in sorted(os.listdir(dataset_dir)):
        if not name.endswith(".pt") or name.endswith(".tmp.pt"):
            continue
        path = os.path.join(dataset_dir, name)
        data = torch.load(path, map_location="cpu", weights_only=True)
        meta = dict(data.get("metadata") or {})
        current = meta.get(HIDDEN_SIZE_KEY)
        if isinstance(current, int):
            if current == width:
                already += 1
                continue
            if not force:
                refused += 1
                continue
        meta[HIDDEN_SIZE_KEY] = width
        meta[NAME_KEY] = f"marked by hand ({family.lower()})"
        data["metadata"] = meta
        tmp = path + ".marking"
        torch.save(data, tmp)
        os.replace(tmp, path)
        marked += 1
    return marked, already, refused


def _main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m acestep.training_v2.dataset_check",
        description="Mark the preprocessed tensors of a folder with the architecture of the model that made them.",
    )
    parser.add_argument("dataset_dir")
    parser.add_argument("--family", required=True, choices=sorted(FAMILY_WIDTH), help="2b (Turbo, Base, SFT) or xl")
    parser.add_argument("--force", action="store_true", help="overwrite a mark that says the other architecture")
    args = parser.parse_args(argv)
    if not os.path.isdir(args.dataset_dir):
        print(f"Not a folder: {args.dataset_dir}", file=sys.stderr)
        return 1
    marked, already, refused = mark_dataset(args.dataset_dir, args.family, args.force)
    print(f"{marked} file(s) marked {args.family}, {already} already marked, {refused} refused (other architecture; --force to overwrite).")
    return 1 if refused else 0


if __name__ == "__main__":
    sys.exit(_main())
