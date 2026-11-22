"""Pause after the current epoch, asked from outside the training process.

The Studio starts training with ``ACESTEP_TRAINING_PAUSE_FILE`` set to a path and creates that file when the user asks for a
pause. The loops look for it once per epoch, after the epoch's last optimiser step: the weights, optimiser and scheduler are
then in step, so the checkpoint saved there resumes cleanly with ``--resume-from``.
"""

from __future__ import annotations

import os

PAUSE_FILE_ENV = "ACESTEP_TRAINING_PAUSE_FILE"


def pause_requested() -> bool:
    """True when the pause file named by ``ACESTEP_TRAINING_PAUSE_FILE`` exists."""
    path = os.environ.get(PAUSE_FILE_ENV)
    return bool(path) and os.path.exists(path)


def should_pause(epoch_done: int, max_epochs: int) -> bool:
    """Pause after epoch ``epoch_done`` (1-based) only when epochs remain: after the last one the run simply finishes."""
    return epoch_done < max_epochs and pause_requested()


def paused_message(epoch_done: int, max_epochs: int, ckpt_dir: str) -> str:
    return f"[PAUSED] Training paused after epoch {epoch_done}/{max_epochs}. Resume from: {ckpt_dir}"
