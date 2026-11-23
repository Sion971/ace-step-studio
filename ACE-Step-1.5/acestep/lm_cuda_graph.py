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
3. The following steps replay the graph. The attention only reads the start of the buffers that holds tokens: one graph
   is captured per window of ``window_step`` positions (a view of the same buffers), when the generation reaches it.
   If a later capture fails, the remaining steps run the same forward without the graph.
4. The graph points at the current GPU weights, which are moved off the card when the LM is offloaded, so everything is
   built for one generation and thrown away at its end.

The sampled tokens may differ from the usual loop's on a close call: the attention runs over a longer, masked buffer,
which changes the rounding. The result is as valid, not identical.

Audio-code phase (``set_head_rows``): there the constrained decoding only lets the audio codes and the end token through,
every other token of the 217k vocabulary is set to -inf before sampling. The step can then compute the output layer
(lm_head, about a quarter of the weights read per token on the 1.7B) for those rows only and write -inf in the others:
the tokens that can be sampled get the same scores, up to the rounding of the product. The loops ask for it per step,
only while the processor is in that phase; ``ACESTEP_LM_HEAD_ROWS=0`` turns it off.
"""

import os
import time
from types import SimpleNamespace
from typing import Any, Optional

import torch
import torch.nn.functional as F
from loguru import logger

ENV_GRAPH = "ACESTEP_LM_CUDA_GRAPH"
ENV_HEAD_ROWS = "ACESTEP_LM_HEAD_ROWS"  # 0 turns the audio-code rows of the output layer off (whole vocabulary)  # 0 turns it off; 1 turns it on where it is not on by default (ROCm)
MIN_STEPS = 48  # a generation shorter than this does not pay back the capture
CHECK_ABS = 0.25  # logits of the graph and of the usual step may differ by this much plus
CHECK_REL = 0.03  # this share of the largest logit (bf16 keeps about 3 significant digits)
WARMUP_STEPS = 3
WINDOW_MIN = 256  # positions read by the attention grow by this much (or more, to keep the graphs below WINDOW_MAX_COUNT)
WINDOW_MAX_COUNT = 8


def requested() -> bool:
    value = os.environ.get(ENV_GRAPH, "").strip().lower()
    if value in ("0", "false", "no", "off"):
        return False
    if value in ("1", "true", "yes", "on"):
        return True
    return torch.version.cuda is not None  # unset: on for NVIDIA, off elsewhere


def head_rows_requested() -> bool:
    return os.environ.get(ENV_HEAD_ROWS, "").strip().lower() not in ("0", "false", "no", "off")


def head_rows_problem(model) -> Optional[str]:
    """Why the output layer of this model cannot be computed on a subset of rows (None when it can)."""
    base = getattr(model, "model", None)
    if base is None or not callable(base):
        return "no inner model"
    getter = getattr(model, "get_output_embeddings", None)
    head = getter() if callable(getter) else None
    if not isinstance(head, torch.nn.Linear):
        return "the output layer is not a plain linear layer"
    if head.bias is not None:
        return "the output layer has a bias"
    config = getattr(model, "config", None)
    for name in ("final_logit_softcapping", "logit_scale", "output_multiplier_scale"):
        if getattr(config, name, None):
            return f"the model rescales its logits ({name})"
    return None


def logits_match(reference: torch.Tensor, candidate: torch.Tensor):
    """Return (ok, largest difference) between the logits of the usual step and of the graph step."""
    ref = reference.float()
    cand = candidate.float()
    if not bool(torch.isfinite(cand).all()):
        return False, float("inf")
    diff = float((ref - cand).abs().max())
    return diff <= CHECK_ABS + CHECK_REL * float(ref.abs().max()), diff


def _card_mb() -> Optional[float]:
    """Memory held by live tensors on the card, in MB; None without a card."""
    if not torch.cuda.is_available():
        return None
    try:
        return torch.cuda.memory_allocated() / 1024 ** 2
    except Exception:
        return None


_side_streams = {}


def _side_stream() -> "torch.cuda.Stream":
    """The stream the warm-up steps of every capture run on: one per card, created once.

    cuBLAS keeps a workspace (32 MB on recent cards) for each stream a matrix product runs on, and PyTorch never gives it
    back. A new stream per capture took 5 to 6 streams, so 130 to 190 MB, from the card at every generation, until the 32
    streams of PyTorch's pool had all been used (about 1 GB), which the card could not afford.
    """
    key = torch.cuda.current_device()
    stream = _side_streams.get(key)
    if stream is None:
        stream = _side_streams[key] = torch.cuda.Stream()
    return stream


class _Captured:
    def __init__(self, graph, logits):
        self.graph = graph
        self.logits = logits


class GraphDecoder:
    """Static buffers plus the one-token forward of the model, captured in CUDA graphs (or run as it is)."""

    def __init__(self, model, cache, mask, ids, position, next_position: int, capture: bool, window_step: int):
        self.model = model
        self.cache = cache
        self.mask = mask
        self.ids = ids
        self.position = position  # the position of the next token, on the card
        self.next_position = next_position  # the same, for the host
        self.max_len = mask.shape[3]
        self.window_step = max(1, int(window_step))
        self.eager_only = not capture
        self.captured = {}
        self.views = {}
        self.capture_seconds = 0.0
        self.eager_steps = 0
        self.rows: Optional[torch.Tensor] = None  # allowed rows of the output layer, set by set_head_rows
        self.head_weight: Optional[torch.Tensor] = None  # those rows of the output layer, copied once
        self.full: Optional[torch.Tensor] = None  # [batch, vocab] scores: -inf outside the rows, rewritten in place
        self.head_off: Optional[str] = None  # why the rows cannot be used (then every step computes the whole layer)

    @classmethod
    def build(cls, model, dynamic_cache, attention_mask: torch.Tensor, last_token: torch.Tensor,
              max_new_tokens: int, capture: bool = True, window_step: Optional[int] = None) -> "GraphDecoder":
        """Copy the prompt cache into static buffers. Raises when the model is unsuitable.

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
        if window_step is None:
            window_step = max(WINDOW_MIN, -(-max_len // WINDOW_MAX_COUNT // 64) * 64)
        return cls(
            model, cache, mask,
            last_token.clone().to(device=device, dtype=torch.long),
            torch.full((1,), width - 1, dtype=torch.long, device=device),
            width - 1, capture, window_step,
        )

    def set_head_rows(self, rows: Optional[torch.Tensor]) -> None:
        """The rows of the output layer that can be sampled in the audio-code phase (None: always the whole layer)."""
        if rows is None or self.rows is not None:
            return
        self.head_off = head_rows_problem(self.model)
        if self.head_off is None:
            self.rows = rows.to(device=self.ids.device, dtype=torch.long)

    def _prepare_rows(self) -> bool:
        """Copy the allowed rows of the output layer once; False when they cannot be used."""
        if self.rows is None or self.head_off is not None:
            return False
        if self.head_weight is not None:
            return True
        try:
            weight = self.model.get_output_embeddings().weight
            self.head_weight = weight.index_select(0, self.rows).contiguous()
            self.full = torch.full((self.ids.shape[0], weight.shape[0]), float("-inf"), dtype=weight.dtype,
                                   device=weight.device)
        except Exception as exc:
            self.head_off = f"{type(exc).__name__}: {exc}"
            self.head_weight = self.full = None
            logger.warning("[lm_graph] audio-code rows of the output layer not used: {}", self.head_off)
            return False
        logger.info("[lm_graph] audio-code phase: output layer computed on {} of {} rows ({:.2f} GB copied once)",
                    self.head_weight.shape[0], self.full.shape[1],
                    self.head_weight.numel() * self.head_weight.element_size() / 1024 ** 3)
        return True

    def _window(self) -> int:
        """Positions the attention reads at this step: the next multiple of ``window_step`` that holds the token."""
        need = self.next_position + 1
        return min(-(-need // self.window_step) * self.window_step, self.max_len)

    def _view(self, window: int):
        """A cache over the first ``window`` positions of the buffers (the same memory, a shorter attention)."""
        if window >= self.max_len:
            return self.cache
        view = self.views.get(window)
        if view is None:
            from transformers import StaticCache

            view = StaticCache(config=self.model.config, max_cache_len=window)
            for part, whole in zip(view.layers, self.cache.layers):
                part.keys = whole.keys[:, :, :window]
                part.values = whole.values[:, :, :window]
                part.max_batch_size, part.num_heads, _, part.head_dim = part.keys.shape
                part.dtype, part.device = part.keys.dtype, part.keys.device
                part.is_initialized = True
            self.views[window] = view
        return view

    def _forward(self, window: int, rows: bool = False) -> torch.Tensor:
        """One token: open the mask column of this position, run the model, move to the next position.

        With ``rows`` the output layer is computed on the allowed rows only, written into ``self.full`` (-inf elsewhere).
        """
        self.mask.index_fill_(3, self.position, True)
        inputs = dict(
            input_ids=self.ids,
            attention_mask=self.mask[:, :, :, :window],
            past_key_values=self._view(window),
            cache_position=self.position,
            use_cache=True,
        )
        if rows:
            hidden = self.model.model(**inputs).last_hidden_state[:, -1, :]
            self.full.index_copy_(1, self.rows, F.linear(hidden, self.head_weight))
            logits = self.full
        else:
            logits = self.model(**inputs).logits[:, -1, :]
        self.position.add_(1)
        return logits

    def _capture(self, window: int, rows: bool = False) -> "_Captured":
        start = time.perf_counter()
        first = self.position.clone()
        opened = self.mask.clone()
        side = _side_stream()
        side.wait_stream(torch.cuda.current_stream())
        try:
            with torch.cuda.stream(side):
                for _ in range(WARMUP_STEPS if not self.captured else 2):
                    self._forward(window, rows)
            torch.cuda.current_stream().wait_stream(side)
            torch.cuda.synchronize()
        finally:
            # The warm-up wrote key/values of the real token at a few positions: they are rewritten, in order, before
            # any step reads them. The position and the mask go back to where this step expects them.
            self.position.copy_(first)
            self.mask.copy_(opened)
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph):
            logits = self._forward(window, rows)
        torch.cuda.synchronize()
        self.capture_seconds += time.perf_counter() - start
        return _Captured(graph, logits)

    def step(self, generated_ids: torch.Tensor, rows: bool = False) -> Any:
        """Logits of the next token, shaped like the output of the usual forward ([batch, 1, vocab]).

        ``rows``: the loop is in the audio-code phase, only the rows given to ``set_head_rows`` can be sampled.
        """
        rows = bool(rows) and self._prepare_rows()
        self.ids.copy_(generated_ids[:, -1:])
        window = self._window()
        key = (window, rows)
        entry = None
        if not self.eager_only:
            entry = self.captured.get(key)
            if entry is None:
                try:
                    entry = self._capture(window, rows)
                except Exception as exc:
                    if not self.captured:
                        raise  # the very first capture: the caller still has the usual cache and falls back to it
                    logger.warning("[lm_graph] capture of the window {} failed, the rest of the generation runs "
                                   "without the graph: {}: {}", window, type(exc).__name__, exc)
                    self.eager_only = True
                    entry = None
                else:
                    self.captured[key] = entry
        if entry is not None:
            entry.graph.replay()
            logits = entry.logits
        else:
            logits = self._forward(window, rows)
            self.eager_steps += 1
        self.next_position += 1
        return SimpleNamespace(logits=logits.clone().unsqueeze(1))

    def release(self) -> None:
        """Let go of everything this decoder holds, graphs first, instead of waiting for the references to die."""
        for entry in self.captured.values():
            try:
                entry.graph.reset()
            except Exception:  # a graph that cannot be reset is dropped with the entry
                pass
            entry.graph = entry.logits = None
        self.captured.clear()
        self.views.clear()
        if self.cache is not None:
            for layer in getattr(self.cache, "layers", []):
                layer.keys = layer.values = None
        self.cache = self.mask = self.ids = self.position = None
        self.rows = self.head_weight = self.full = None

    def summary(self) -> str:
        return (f"{len(self.captured)} graph(s), capture {self.capture_seconds:.2f} s in all, "
                f"{self.eager_steps} step(s) without graph")


class LmGraph:
    """State machine used by the decoding loops: usual steps, then a checked step, then graph steps (or back)."""

    def __init__(self, model, max_new_tokens: int, capture: bool = True, window_step: Optional[int] = None):
        self.model = model
        self.max_new_tokens = int(max_new_tokens)
        self.capture = capture
        self.window_step = window_step
        self.decoder: Optional[GraphDecoder] = None
        self.state = "new"  # new -> checking -> ready, or off at any moment
        self.card_before = _card_mb()
        self.head_rows: Optional[torch.Tensor] = None

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
                self.max_new_tokens, capture=self.capture, window_step=self.window_step,
            )
            self.decoder.set_head_rows(self.head_rows)
            self.state = "checking"
        except Exception as exc:
            self._give_up(f"{type(exc).__name__}: {exc}")

    def set_head_rows(self, rows: Optional[torch.Tensor]) -> None:
        """Rows of the output layer allowed in the audio-code phase (see the module notes); None leaves the layer whole."""
        self.head_rows = rows if head_rows_requested() else None
        if self.decoder is not None:
            self.decoder.set_head_rows(self.head_rows)

    def check(self, outputs: Any, generated_ids: torch.Tensor, rows: bool = False) -> None:
        """After the usual second step: the graph runs the same step and both logits are compared.

        With ``rows`` only the allowed rows are compared: the graph leaves the others at -inf.
        """
        if self.state != "checking":
            return
        try:
            result = self.decoder.step(generated_ids, rows)
            reference, candidate = outputs.logits[:, -1, :], result.logits[:, -1, :]
            if rows and self.decoder.head_weight is not None:
                reference = reference.index_select(1, self.decoder.rows)
                candidate = candidate.index_select(1, self.decoder.rows)
            ok, diff = logits_match(reference, candidate)
        except Exception as exc:
            self._give_up(f"{type(exc).__name__}: {exc}")
            return
        if not ok:
            self._give_up(f"the logits of the graph differ from the usual ones (largest difference {diff:.3f})")
            return
        self.state = "ready"
        logger.info("[lm_graph] CUDA graph active: first capture {:.2f} s, largest logit difference on the check step "
                    "{:.3f}", self.decoder.capture_seconds, diff)

    def step(self, generated_ids: torch.Tensor, rows: bool = False) -> Any:
        return self.decoder.step(generated_ids, rows)

    def close(self) -> None:
        """End of the generation: log, release the decoder, and say what the card held before, at the end and after."""
        decoder, self.decoder = self.decoder, None
        ready = self.state == "ready"
        self.state = "off"
        if decoder is None:
            return
        if ready:
            logger.info("[lm_graph] generation done: {}", decoder.summary())
        at_end = _card_mb()
        decoder.release()
        del decoder
        after = _card_mb()
        if after is not None:
            logger.info("[lm_graph] card memory held by tensors: {:.0f} MB before the generation, {:.0f} MB at its end, "
                        "{:.0f} MB once the graphs are released",
                        self.card_before or 0.0, at_end or 0.0, after)


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
