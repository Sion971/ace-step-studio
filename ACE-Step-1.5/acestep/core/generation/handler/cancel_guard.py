"""Stops a diffusion run when the cancel flag is set, whatever the model's own code does.

``POST /v1/cancel`` sets ``model._cancel_generation``. The official model code reads it at the start of every diffusion step,
but community checkpoints (for example ``acestep-v15-xl-turbo-bf16``) ship their own modeling code, which never does: the
cancel reached the engine and the song was finished anyway. The guard puts the same check in front of the decoder (called
once per step, or twice with guidance), so it works for any model.
"""
from contextlib import contextmanager

from loguru import logger


def _check_cancel(model) -> None:
    if getattr(model, "_cancel_generation", False):
        model._cancel_generation = False
        logger.warning("[generate_audio] Generation cancelled by user (cancel guard)")
        raise InterruptedError("Generation cancelled")


@contextmanager
def cancel_guard(model):
    """Raise ``InterruptedError`` from the decoder's next call once the cancel flag is set; always unhooks on exit."""
    decoder = getattr(model, "decoder", None)
    register = getattr(decoder, "register_forward_pre_hook", None)
    if register is None:
        yield
        return

    def _hook(_module, _args, _kwargs):
        _check_cancel(model)

    handle = register(_hook, with_kwargs=True)
    try:
        yield
    finally:
        handle.remove()
