"""Tests of the LM warm-up."""

import unittest
from unittest import mock
from unittest.mock import MagicMock, patch

import torch

try:
    from transformers import Qwen3Config, Qwen3ForCausalLM
    from acestep import lm_warmup
    from acestep.llm_inference import LLMHandler
    _IMPORT_ERROR = None
except ImportError as exc:  # pragma: no cover - dependency guard
    lm_warmup = None
    LLMHandler = None
    _IMPORT_ERROR = exc


def _tiny_model():
    torch.manual_seed(2)
    config = Qwen3Config(
        vocab_size=64, hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=4,
        num_key_value_heads=2, head_dim=8, max_position_embeddings=128,
    )
    return Qwen3ForCausalLM(config).eval()


@unittest.skipIf(_IMPORT_ERROR is not None, f"dependencies missing: {_IMPORT_ERROR}")
class RunTests(unittest.TestCase):
    def test_runs_both_batch_sizes_and_leaves_the_model_untouched(self):
        model = _tiny_model()
        before = {name: value.clone() for name, value in model.state_dict().items()}
        batches = []
        original = model.forward

        def spy(*args, **kwargs):
            batches.append(kwargs["input_ids"].shape[0])
            return original(*args, **kwargs)

        with patch.object(model, "forward", spy):
            seconds = lm_warmup.run(model, "cpu", steps=3)
        self.assertGreaterEqual(seconds, 0.0)
        self.assertEqual(sorted(set(batches)), [1, 2])
        self.assertEqual(len(batches), 2 * (1 + 3))  # a prompt pass and three steps, for each batch size
        for name, value in model.state_dict().items():
            self.assertTrue(torch.equal(before[name], value), name)

    def test_requested(self):
        import os
        with patch.dict("os.environ", {}, clear=False), patch("torch.cuda.is_available", return_value=True):
            os.environ.pop(lm_warmup.ENV_WARMUP, None)
            self.assertTrue(lm_warmup.requested("cuda"))
            self.assertFalse(lm_warmup.requested("cpu"))
            os.environ[lm_warmup.ENV_WARMUP] = "0"
            self.assertFalse(lm_warmup.requested("cuda"))


@unittest.skipIf(_IMPORT_ERROR is not None, f"dependencies missing: {_IMPORT_ERROR}")
class LoadHookTests(unittest.TestCase):
    def _handler(self):
        handler = LLMHandler()
        handler.dtype = torch.float32
        handler.offload_to_cpu = True
        handler.device = "cpu"
        return handler

    def _load(self, handler, run):
        with patch("acestep.llm_inference.AutoModelForCausalLM.from_pretrained", return_value=_tiny_model()), \
                patch.object(lm_warmup, "requested", return_value=True), \
                patch.object(lm_warmup, "run", run):
            return handler._load_pytorch_model("/nowhere", "cpu")

    def test_the_load_warms_the_model_up_inside_the_load_context(self):
        handler = self._handler()
        seen = []
        entered = []
        real = handler._load_model_context

        def context():
            entered.append(1)
            return real()

        handler._load_model_context = context
        ok, _ = self._load(handler, lambda model, device: seen.append((model is handler.llm, len(entered))) or 0.1)
        self.assertTrue(ok)
        self.assertEqual(seen, [(True, 1)])

    def test_a_failing_warm_up_does_not_fail_the_load(self):
        handler = self._handler()

        def boom(model, device):
            raise RuntimeError("out of memory")

        ok, message = self._load(handler, boom)
        self.assertTrue(ok, message)
        self.assertTrue(handler.llm_initialized)


if __name__ == "__main__":
    unittest.main()
