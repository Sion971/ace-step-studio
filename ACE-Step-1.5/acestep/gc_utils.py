"""Garbage collection that is only run when it can free something that matters on the accelerator.

``gc.collect()`` walks every tracked object: with the models, the tokenizer and the constrained-decoding tables loaded it
takes about 0.35 s, and the generation path called it four times (after the VAE, at the end of ``generate_music``, and
twice in the batch wrapper). Reference counting already frees the tensors of a finished generation; the collector is
only needed for reference cycles that still hold memory on the card.
"""

import gc
import time

import torch
from loguru import logger

LEFTOVER_BYTES = 256 * 1024 ** 2  # below this on the card, a collection would free nothing worth waiting for


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
    return True
