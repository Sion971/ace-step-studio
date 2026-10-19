"""Garbage collection that is only run when it can free something that matters on the accelerator.

``gc.collect()`` walks every tracked object: with the models, the tokenizer and the constrained-decoding tables loaded it
takes about 0.35 s, and the generation path called it four times (after the VAE, at the end of ``generate_music``, and
twice in the batch wrapper). Reference counting already frees the tensors of a finished generation; the collector is
only needed for reference cycles that still hold memory on the card.
"""

import gc

import torch

LEFTOVER_BYTES = 256 * 1024 ** 2  # below this on the card, a collection would free nothing worth waiting for


def collect_if_card_holds(threshold: int = LEFTOVER_BYTES) -> bool:
    """Run ``gc.collect()`` unless an NVIDIA/ROCm card is in use and holds less than ``threshold`` bytes.

    Without such a card (CPU, MPS, XPU) the collection is run as before. Returns whether it ran.
    """
    if torch.cuda.is_available():
        try:
            if torch.cuda.memory_allocated() <= threshold:
                return False
        except Exception:  # the card cannot be queried: collect, as before
            pass
    gc.collect()
    return True
