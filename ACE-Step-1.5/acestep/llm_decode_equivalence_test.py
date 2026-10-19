"""The LM decoding loops give the very same tokens after the per-token synchronisations were removed.

``GOLDEN`` was recorded with the loops as they were before the change (same seeds, same fake model): any difference in
the sampled tokens, the stopping point or the handling of finished sequences shows up here.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

import torch
from torch import nn

try:
    from acestep.llm_inference import LLMHandler
    from acestep.constrained_logits_processor import FSMState
    _IMPORT_ERROR = None
except ImportError as exc:  # pragma: no cover - dependency guard
    LLMHandler = None
    FSMState = None
    _IMPORT_ERROR = exc

VOCAB = 48
EOS = 1


class _FakeLM(nn.Module):
    """Logits depend on the last token and on the length so far; the cache is a placeholder object."""

    def __init__(self, eos_bias=1.5):
        super().__init__()
        torch.manual_seed(7)
        self.emb = nn.Embedding(VOCAB, 16)
        self.out = nn.Linear(16, VOCAB)
        with torch.no_grad():
            self.out.bias[EOS] += eos_bias
        self.generation_config = SimpleNamespace(use_cache=True)

    def forward(self, input_ids, past_key_values=None, attention_mask=None, use_cache=True):
        length = attention_mask.shape[1] if attention_mask is not None else input_ids.shape[1]
        logits = self.out(self.emb(input_ids)) + 0.3 * torch.sin(torch.tensor(float(length)))
        return SimpleNamespace(logits=logits, past_key_values=object())


class _CodesProcessor:
    """Stands in for the constrained processor in the codes phase: only audio ids 10..39 and EOS are allowed."""

    def __init__(self, target):
        self.state = FSMState.CODES_GENERATION
        mask = torch.full((1, VOCAB), float("-inf"))
        mask[0, 10:40] = 0.0
        mask[0, EOS] = 0.0
        self.non_audio_code_mask = mask
        self.target = target
        self.count = 0

    def __call__(self, input_ids, scores):
        scores = scores + self.non_audio_code_mask
        if self.count < self.target:
            scores[:, EOS] = float("-inf")
        else:
            keep = scores[:, EOS].clone()
            scores.fill_(float("-inf"))
            scores[:, EOS] = keep
        return scores / 0.9

    def update_state(self, token):
        self.count += 1


def _handler(eos_bias=1.5):
    handler = LLMHandler()
    handler.llm = _FakeLM(eos_bias)
    handler.device = "cpu"
    handler.disable_tqdm = True
    tokenizer = MagicMock()
    tokenizer.eos_token_id = EOS
    tokenizer.pad_token_id = EOS
    handler.llm_tokenizer = tokenizer
    return handler


def _prompt(rows):
    torch.manual_seed(3)
    return torch.randint(10, 40, (rows, 6))


def run(name):
    handler = _handler(-0.4 if name == "cfg_staggered" else 1.5)
    torch.manual_seed(1234)
    with torch.inference_mode():
        if name == "plain_batch2":
            out = handler._generate_with_constrained_decoding(
                input_ids=_prompt(2), attention_mask=None, max_new_tokens=14, temperature=0.9, top_k=6, top_p=0.9,
                repetition_penalty=1.2, pad_token_id=EOS, streamer=None, constrained_processor=None)
        elif name == "plain_codes":
            out = handler._generate_with_constrained_decoding(
                input_ids=_prompt(1), attention_mask=None, max_new_tokens=14, temperature=1.0, top_k=None, top_p=None,
                repetition_penalty=1.0, pad_token_id=EOS, streamer=None, constrained_processor=_CodesProcessor(5))
        elif name == "cfg_codes_batch2":
            out = handler._generate_with_cfg_custom(
                batch_input_ids=_prompt(4), batch_attention_mask=None, max_new_tokens=16, temperature=0.8, cfg_scale=2.0,
                top_k=8, top_p=0.95, repetition_penalty=1.1, pad_token_id=EOS, streamer=None,
                constrained_processor=_CodesProcessor(6))
        elif name == "cfg_free_batch2":
            out = handler._generate_with_cfg_custom(
                batch_input_ids=_prompt(4), batch_attention_mask=None, max_new_tokens=16, temperature=1.0, cfg_scale=1.5,
                top_k=None, top_p=0.9, repetition_penalty=1.0, pad_token_id=EOS, streamer=None, constrained_processor=None)
        elif name == "cfg_staggered":
            out = handler._generate_with_cfg_custom(
                batch_input_ids=_prompt(6), batch_attention_mask=None, max_new_tokens=24, temperature=1.3, cfg_scale=1.2,
                top_k=None, top_p=None, repetition_penalty=1.0, pad_token_id=EOS, streamer=None, constrained_processor=None)
        elif name == "cfg_greedy_single":
            out = handler._generate_with_cfg_custom(
                batch_input_ids=_prompt(2), batch_attention_mask=None, max_new_tokens=12, temperature=0.0, cfg_scale=2.0,
                top_k=5, top_p=None, repetition_penalty=1.0, pad_token_id=EOS, streamer=None, constrained_processor=None)
        else:
            raise KeyError(name)
    return out.tolist()


GOLDEN = {
    "plain_batch2": [
        [26, 18, 17, 37, 20, 10, 25, 3],
        [10, 15, 11, 29, 14, 31, 39, 1],
    ],
    "plain_codes": [
        [26, 18, 17, 37, 20, 10, 29, 27, 17, 10, 16, 1],
    ],
    "cfg_codes_batch2": [
        [26, 18, 17, 37, 20, 10, 37, 27, 15, 1],
        [10, 15, 11, 29, 14, 31, 18, 25, 22, 1],
        [15, 39, 16, 29, 25, 34, 37, 27, 15, 1],
        [30, 24, 16, 39, 31, 26, 18, 25, 22, 1],
    ],
    "cfg_free_batch2": [
        [26, 18, 17, 37, 20, 10, 20, 1],
        [10, 15, 11, 29, 14, 31, 18, 1],
        [15, 39, 16, 29, 25, 34, 20, 1],
        [30, 24, 16, 39, 31, 26, 18, 1],
    ],
    "cfg_staggered": [
        [26, 18, 17, 37, 20, 10, 14, 29, 19, 24, 9, 10, 29, 44, 35, 5, 38, 23, 36, 45, 45, 45, 16, 46, 25, 22, 26, 14, 15, 32],
        [10, 15, 11, 29, 14, 31, 13, 36, 9, 45, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [15, 39, 16, 29, 25, 34, 19, 40, 26, 14, 35, 39, 18, 41, 43, 47, 42, 6, 38, 43, 13, 34, 10, 34, 47, 41, 39, 6, 43, 9],
        [30, 24, 16, 39, 31, 26, 14, 29, 19, 24, 9, 10, 29, 44, 35, 5, 38, 23, 36, 45, 45, 45, 16, 46, 25, 22, 26, 14, 15, 32],
        [22, 18, 27, 34, 14, 30, 13, 36, 9, 45, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [10, 11, 14, 23, 19, 12, 19, 40, 26, 14, 35, 39, 18, 41, 43, 47, 42, 6, 38, 43, 13, 34, 10, 34, 47, 41, 39, 6, 43, 9],
    ],
    "cfg_greedy_single": [
        [26, 18, 17, 37, 20, 10, 25, 22, 1],
        [10, 15, 11, 29, 14, 31, 25, 22, 1],
    ],
}


@unittest.skipIf(LLMHandler is None, f"llm_inference import failed: {_IMPORT_ERROR}")
class DecodeEquivalenceTests(unittest.TestCase):
    def _check(self, name):
        self.assertEqual(run(name), GOLDEN[name])

    def test_plain_loop_batch_of_two(self):
        self._check("plain_batch2")

    def test_plain_loop_codes_phase(self):
        self._check("plain_codes")

    def test_cfg_loop_codes_phase_batch_of_two(self):
        self._check("cfg_codes_batch2")

    def test_cfg_loop_without_processor(self):
        self._check("cfg_free_batch2")

    def test_cfg_loop_sequences_finishing_at_different_steps(self):
        self._check("cfg_staggered")

    def test_cfg_loop_greedy(self):
        self._check("cfg_greedy_single")


if __name__ == "__main__":  # pragma: no cover - used once to record GOLDEN
    import json
    print(json.dumps({n: run(n) for n in ("plain_batch2", "plain_codes", "cfg_codes_batch2", "cfg_free_batch2", "cfg_staggered", "cfg_greedy_single")}))
