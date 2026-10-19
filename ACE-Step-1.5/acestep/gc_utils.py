"""Garbage collection that is only run when it can free something that matters on the accelerator.

``gc.collect()`` walks every tracked object: with the models, the tokenizer and the constrained-decoding tables loaded it
takes about 0.35 s, and the generation path called it four times (after the VAE, at the end of ``generate_music``, and
twice in the batch wrapper). Reference counting already frees the tensors of a finished generation; the collector is
only needed for reference cycles that still hold memory on the card.
"""

import gc
import os
import time

import torch
from loguru import logger

LEFTOVER_BYTES = 256 * 1024 ** 2  # below this on the card, a collection would free nothing worth waiting for
ENV_MEM_DEBUG = "ACESTEP_MEM_DEBUG"  # 1: after each collection on a card, log which tensors the card still holds and who holds them


def mem_debug_requested() -> bool:
    return os.environ.get(ENV_MEM_DEBUG, "").strip().lower() in ("1", "true", "yes", "on")


def _holder(referrer) -> str:
    """One short description of an object that refers to a tensor."""
    if isinstance(referrer, dict):
        keys = [str(k) for k in list(referrer)[:6]]
        return "dict{" + ", ".join(keys) + (", ..." if len(referrer) > 6 else "") + "}"
    if type(referrer).__name__ == "frame":
        code = referrer.f_code
        return f"frame {code.co_name} ({os.path.basename(code.co_filename)}:{referrer.f_lineno})"
    if isinstance(referrer, (list, tuple, set)):
        return f"{type(referrer).__name__} of {len(referrer)}"
    return type(referrer).__name__


def live_tensors(top: int = 6, device_type: str = "cuda"):
    """The ``top`` largest storages that tensors alive in Python keep on the device, and the total of all of them.

    Returns (total bytes, bytes of model weights, [(bytes, shape, dtype, number of tensors on it, holders)]).
    """
    storages = {}
    for obj in gc.get_objects():
        try:
            if not torch.is_tensor(obj) or obj.device.type != device_type:
                continue
            storage = obj.untyped_storage()
            key = storage.data_ptr()
            entry = storages.get(key)
            if entry is None:
                storages[key] = [storage.nbytes(), obj, 1]
            else:
                entry[2] += 1
        except Exception:
            continue
    total = sum(entry[0] for entry in storages.values())
    weights = sum(entry[0] for entry in storages.values() if isinstance(entry[1], torch.nn.Parameter))
    largest = sorted((e for e in storages.values() if not isinstance(e[1], torch.nn.Parameter)),
                     key=lambda e: e[0], reverse=True)[:top]
    rows = []
    for nbytes, tensor, count in largest:
        holders = []
        for referrer in gc.get_referrers(tensor):
            if referrer is storages or type(referrer).__name__ == "frame" and referrer.f_code.co_name == "live_tensors":
                continue
            holders.append(_holder(referrer))
        rows.append((nbytes, tuple(tensor.shape), str(tensor.dtype), count, sorted(set(holders))[:6]))
    del storages, largest
    return total, weights, rows


def log_live_tensors(site: str, device_type: str = "cuda") -> None:
    """With ``ACESTEP_MEM_DEBUG=1``: say what the card holds, what Python can see of it, and who holds the largest tensors."""
    try:
        start = time.perf_counter()
        total, weights, rows = live_tensors(device_type=device_type)
        allocated = torch.cuda.memory_allocated() if device_type == "cuda" else 0
        mb = 1024 ** 2
        logger.info("[mem] {}: the card holds {:.0f} MB, tensors seen from Python {:.0f} MB (weights {:.0f} MB, others {:.0f} MB),"
                    " not seen from Python {:.0f} MB (checked in {:.2f} s)",
                    site, allocated / mb, total / mb, weights / mb, (total - weights) / mb,
                    (allocated - total) / mb, time.perf_counter() - start)
        for nbytes, shape, dtype, count, holders in rows:
            logger.info("[mem]   {:.1f} MB {} {} on {} tensor(s), held by: {}", nbytes / mb, list(shape), dtype, count,
                        "; ".join(holders) or "nothing in Python")
    except Exception as exc:  # a diagnostic must never break a generation
        logger.warning("[mem] could not inspect the card: {}: {}", type(exc).__name__, exc)


def collect_if_card_holds(site: str = "", threshold: int = LEFTOVER_BYTES) -> bool:
    """Run ``gc.collect()`` unless an NVIDIA/ROCm card is in use and holds less than ``threshold`` bytes.

    Without such a card (CPU, MPS, XPU) the collection is run as before. Returns whether it ran. When it runs on a card, one
    log line says what the card held and how much the collection freed, to tell whether it is worth its time.
    """
    held = None
    if torch.cuda.is_available():
        try:
            held = torch.cuda.memory_allocated()
            if held <= threshold:
                return False
        except Exception:  # the card cannot be queried: collect, as before
            held = None
    start = time.perf_counter()
    gc.collect()
    if held is not None:
        try:
            freed = held - torch.cuda.memory_allocated()
        except Exception:
            freed = 0
        logger.info("[gc] {}: the card held {:.0f} MB, the collection took {:.2f} s and freed {:.0f} MB",
                    site or "?", held / 1024 ** 2, time.perf_counter() - start, freed / 1024 ** 2)
        if mem_debug_requested():
            log_live_tensors(site or "?")
    return True
