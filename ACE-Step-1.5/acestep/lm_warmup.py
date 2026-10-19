"""Warm-up of the 5Hz LM when it is loaded, so that the first generation does not pay for it.

The first generation after a start or a change of LM was 3 to 7 s slower in the LM phases (4 s for its very first token,
5.6 s to put the 1.7B on the card the first time): the card loads its kernels and builds its libraries' handles on first
use. A few prompt passes and decoding steps with the same operations (batch of 1 and of 2 for the CFG, top-k and top-p
filters, sampling) do that work while the model is loaded. Turned off with ``ACESTEP_LM_WARMUP=0``; it never raises.
"""

import os
import time

import torch

ENV_WARMUP = "ACESTEP_LM_WARMUP"
PROMPT_TOKENS = 24
STEPS = 6


def requested(device) -> bool:
    if os.environ.get(ENV_WARMUP, "").strip().lower() in ("0", "false", "no", "off"):
        return False
    return str(device).startswith("cuda") and torch.cuda.is_available()


def _sampling_operations(logits: torch.Tensor) -> None:
    """The operations of the top-k / top-p filters and of the sampling, on the real vocabulary size."""
    x = logits.float()
    kth = torch.topk(x, 50)[0][..., -1, None]
    x = x.masked_fill(x < kth, float("-inf"))
    ordered, _ = torch.sort(x, descending=True)
    torch.softmax(ordered, dim=-1).cumsum(dim=-1)
    torch.multinomial(torch.softmax(x, dim=-1), 1)


def run(model, device, steps: int = STEPS) -> float:
    """Run the model on made-up prompts for batches of 1 and 2; return the time taken in seconds."""
    start = time.perf_counter()
    vocab = int(model.config.vocab_size)
    low = min(100, max(0, vocab - 2))
    high = max(low + 1, min(vocab, 5000))
    generator = torch.Generator(device="cpu").manual_seed(0)
    with torch.inference_mode():
        for batch in (1, 2):
            ids = torch.randint(low, high, (batch, PROMPT_TOKENS), generator=generator).to(device)
            mask = torch.ones_like(ids)
            out = model(input_ids=ids, attention_mask=mask, use_cache=True)
            cache = out.past_key_values
            logits = out.logits[:, -1, :]
            for _ in range(steps):
                _sampling_operations(logits)
                token = logits.argmax(dim=-1, keepdim=True)
                ids = torch.cat([ids, token], dim=1)
                mask = torch.cat([mask, torch.ones_like(token)], dim=1)
                out = model(input_ids=ids[:, -1:], attention_mask=mask, past_key_values=cache, use_cache=True)
                cache = out.past_key_values
                logits = out.logits[:, -1, :]
        if str(device).startswith("cuda") and torch.cuda.is_available():
            torch.cuda.synchronize()
    return time.perf_counter() - start
