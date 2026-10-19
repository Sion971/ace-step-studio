"""The 5Hz LM weights are read straight in the dtype they will run in (no float32 copy in RAM first)."""

import unittest
from unittest.mock import MagicMock, patch

import torch

try:
    from acestep.llm_inference import LLMHandler
    _IMPORT_ERROR = None
except ImportError as exc:  # pragma: no cover - dependency guard
    LLMHandler = None
    _IMPORT_ERROR = exc


@unittest.skipIf(LLMHandler is None, f"llm_inference import failed: {_IMPORT_ERROR}")
class LoadDtypeTests(unittest.TestCase):
    """_load_pytorch_model asks transformers for the final dtype."""

    def _load(self, dtype, offload):
        handler = LLMHandler()
        handler.dtype, handler.offload_to_cpu = dtype, offload
        model = MagicMock()
        model.to.return_value = model
        with patch("acestep.llm_inference.AutoModelForCausalLM") as auto:
            auto.from_pretrained.return_value = model
            ok, _ = handler._load_pytorch_model("/some/lm", "cpu")
        self.assertTrue(ok)
        return auto.from_pretrained.call_args

    def test_bfloat16_is_requested_when_offloading_to_cpu(self):
        call = self._load(torch.bfloat16, True)
        self.assertEqual(call.kwargs["torch_dtype"], torch.bfloat16)
        self.assertTrue(call.kwargs["low_cpu_mem_usage"])

    def test_bfloat16_is_requested_on_the_card_too(self):
        self.assertEqual(self._load(torch.bfloat16, False).kwargs["torch_dtype"], torch.bfloat16)

    def test_float32_stays_float32(self):
        self.assertEqual(self._load(torch.float32, True).kwargs["torch_dtype"], torch.float32)


if __name__ == "__main__":
    unittest.main()
