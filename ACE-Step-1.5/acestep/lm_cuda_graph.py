"""CUDA graph for the one-token steps of the 5Hz LM decoding loops, switched on with ``ACESTEP_LM_CUDA_GRAPH=1``.

Measured on the 8 GB card, a LM step takes about 28 ms whatever the size of the model (0.6B or 1.7B, both 28 layers) and
the work around the model is below 1 ms: the card waits for Python to launch hundreds of small kernels. A CUDA graph
records those launches once and replays them with a single call.

How it works (the prompt pass and the first token stay exactly as they were):

1. After the first step the key/value pairs of the prompt are copied into a ``StaticCache`` (fixed buffers, long enough
   for the whole generation) and the one-token forward of the model is captured with fixed inputs: the token, the
   position, and a boolean attention mask that is opened one column per step *inside* the graph.
2. The second step is run twice, the usual way and through the graph, and the logits are compared. If they differ more
   than bf16 rounding allows (or contain NaN), or if anything fails, the graph is dropped and the loop goes on as before.
3. The following steps replay the graph. The graph points at the current GPU weights, which are moved off the card when
   the LM is offloaded, so it is built for one generation and thrown away at its end.

The sampled tokens may differ from the usual loop's on a close call: the attention runs over a longer, masked buffer,
which changes the rounding. The result is as valid, not identical.
"""

import os
import time
from types import SimpleNamespace
from typing import Any, Optional

import torch
from loguru import logger

ENV_GRAPH = "ACESTEP_LM_CUDA_GRAPH"
MIN_STEPS = 48  # a generation shorter than this does not pay back the capture
CHECK_ABS = 0.25  # logits of the graph and of the usual step may differ by this much plus
CHECK_REL = 0.03  # this share of the largest logit (bf16 keeps about 3 significant digits)
WARMUP_STEPS = 3


def requested() -> bool:
    return os.environ.get(ENV_GRAPH, "").strip().lower() in ("1", "true", "yes", "on")


def logits_match(reference: torch.Tensor, candidate: torch.Tensor):
    """Return (ok, largest difference) between the logits of the usual step and of the graph step."""
    ref = reference.float()
    cand = candidate.float()
    if not bool(torch.isfinite(cand).all()):
        return False, float("inf")
    diff = float((ref - cand).abs().max())
    return diff <= CHECK_ABS + CHECK_REL * float(ref.abs().max()), diff


class GraphDecoder:
    """Static buffers plus the one-token forward of the model, captured in a CUDA graph (or run as it is)."""

    def __init__(self, model, cache, mask, ids, position, capture: bool):
        self.model = model
        self.cache = cache
        self.mask = mask
        self.ids = ids
        self.position = position
        self.graph = None
        self.logits = None
        self._capture = capture

    @classmethod
    def build(cls, model, dynamic_cache, attention_mask: torch.Tensor, last_token: torch.Tensor,
              max_new_tokens: int, capture: bool = True) -> "GraphDecoder":
        """Copy the prompt cache into static buffers and capture the next step. Raises when the model is unsuitable.

        ``attention_mask`` is [batch, prompt + 1] (the token just sampled included); ``last_token`` is [batch, 1].
        """
        from transformers import StaticCache
        from transformers.cache_utils import StaticLayer

        layers = getattr(dynamic_cache, "layers", None)
        if not layers:
            raise RuntimeError("the cache has no per-layer storage (transformers too old)")
        batch, width = attention_mask.shape
        prompt = int(layers[0].keys.shape[2])
        if width != prompt + 1:
            raise RuntimeError(f"unexpected mask width {width} for a cache of {prompt} tokens")
        device = attention_mask.device
        max_len = width + int(max_new_tokens) + 1

        cache = StaticCache(config=model.config, max_cache_len=max_len)
        if len(cache.layers) != len(layers) or not all(isinstance(layer, StaticLayer) for layer in cache.layers):
            raise RuntimeError("the model has sliding-window layers")
        for static, dynamic in zip(cache.layers, layers):
            static.lazy_initialization(dynamic.keys)
            static.keys[:, :, :prompt].copy_(dynamic.keys)
            static.values[:, :, :prompt].copy_(dynamic.values)

        mask = torch.zeros((batch, 1, 1, max_len), dtype=torch.bool, device=device)
        mask[:, 0, 0, :width] = attention_mask.bool()
        decoder = cls(
            model, cache, mask,
            last_token.clone().to(device=device, dtype=torch.long),
            torch.full((1,), width - 1, dtype=torch.long, device=device),
            capture,
        )
        decoder._prepare(width)
        return decoder

    def _forward(self) -> torch.Tensor:
        """One token: open the mask column of this position, run the model, move to the next position."""
        self.mask.index_fill_(3, self.position, True)
        out = self.model(
            input_ids=self.ids,
            attention_mask=self.mask,
            past_key_values=self.cache,
            cache_position=self.position,
            use_cache=True,
        )
        self.position.add_(1)
        return out.logits[:, -1, :]

    def _prepare(self, width: int) -> None:
        if not self._capture:
            return
        start = time.perf_counter()
        first = self.position.clone()
        opened = self.mask.clone()
        side = torch.cuda.Stream()
        side.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(side):
            for _ in range(WARMUP_STEPS):
                self._forward()
        torch.cuda.current_stream().wait_stream(side)
        torch.cuda.synchronize()
        # The warm-up wrote key/values of the real token at a few positions: they are rewritten, in order, before
        # any step reads them. The position and the mask go back to where the first real step expects them.
        self.position.copy_(first)
        self.mask.copy_(opened)
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph):
            self.logits = self._forward()
        torch.cuda.synchronize()
        self.graph = graph
        self.capture_seconds = time.perf_counter() - start

    def step(self, generated_ids: torch.Tensor) -> Any:
        """Logits of the next token, shaped like the output of the usual forward ([batch, 1, vocab])."""
        self.ids.copy_(generated_ids[:, -1:])
        if self.graph is not None:
            self.graph.replay()
            logits = self.logits
        else:
            logits = self._forward()
        return SimpleNamespace(logits=logits.clone().unsqueeze(1))


class LmGraph:
    """State machine used by the decoding loops: usual steps, then a checked step, then graph steps (or back)."""

    def __init__(self, model, max_new_tokens: int, capture: bool = True):
        self.model = model
        self.max_new_tokens = int(max_new_tokens)
        self.capture = capture
        self.decoder: Optional[GraphDecoder] = None
        self.state = "new"  # new -> checking -> ready, or off at any moment

    @property
    def ready(self) -> bool:
        return self.state == "ready"

    @property
    def checking(self) -> bool:
        return self.state == "checking"

    def _give_up(self, reason: str) -> None:
        logger.warning("[lm_graph] CUDA graph not used, the usual decoding goes on: {}", reason)
        self.state = "off"
        self.decoder = None
        if self.capture and torch.cuda.is_available():
            try:
                torch.cuda.synchronize()
            except Exception:  # the card may be unusable: the usual path will report it
                pass

    def end_step(self, outputs: Any, attention_mask: torch.Tensor, generated_ids: torch.Tensor) -> None:
        """After the first step of the loop: build the decoder from the prompt cache."""
        if self.state != "new":
            return
        try:
            self.decoder = GraphDecoder.build(
                self.model, outputs.past_key_values, attention_mask, generated_ids[:, -1:],
                self.max_new_tokens, capture=self.capture,
            )
            self.state = "checking"
        except Exception as exc:
            self._give_up(f"{type(exc).__name__}: {exc}")

    def check(self, outputs: Any, generated_ids: torch.Tensor) -> None:
        """After the usual second step: the graph runs the same step and both logits are compared."""
        if self.state != "checking":
            return
        try:
            result = self.decoder.step(generated_ids)
            ok, diff = logits_match(outputs.logits[:, -1, :], result.logits[:, -1, :])
        except Exception as exc:
            self._give_up(f"{type(exc).__name__}: {exc}")
            return
        if not ok:
            self._give_up(f"the logits of the graph differ from the usual ones (largest difference {diff:.3f})")
            return
        self.state = "ready"
        seconds = getattr(self.decoder, "capture_seconds", 0.0)
        logger.info("[lm_graph] CUDA graph active: capture {:.2f} s, largest logit difference on the check step {:.3f}",
                    seconds, diff)

    def step(self, generated_ids: torch.Tensor) -> Any:
        return self.decoder.step(generated_ids)

    def close(self) -> None:
        self.decoder = None
        self.state = "off"


def create(model, device, max_new_tokens: int) -> Optional[LmGraph]:
    """Return the graph helper for one generation, or None when it is off, or the situation does not suit it."""
    if not requested():
        return None
    if not (str(device).startswith("cuda") and torch.cuda.is_available()):
        return None
    if int(max_new_tokens) < MIN_STEPS:
        return None
    config = getattr(model, "config", None)
    if config is None or getattr(config, "_attn_implementation", None) != "sdpa":
        logger.info("[lm_graph] CUDA graph not used: the LM does not run on the sdpa attention")
        return None
    return LmGraph(model, max_new_tokens)
