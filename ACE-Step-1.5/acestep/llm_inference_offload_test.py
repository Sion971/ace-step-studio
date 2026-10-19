"""The 5Hz LM goes back to the processor without being copied again: its processor weights are kept while it runs elsewhere."""

import unittest

import torch
from torch import nn

try:
    from acestep.llm_inference import LLMHandler
    _IMPORT_ERROR = None
except ImportError as exc:  # pragma: no cover - dependency guard
    LLMHandler = None
    _IMPORT_ERROR = exc


class _Tiny(nn.Module):
    def __init__(self):
        super().__init__()
        self.linear = nn.Linear(4, 3)
        self.register_buffer("table", torch.arange(3, dtype=torch.float32))


@unittest.skipIf(LLMHandler is None, f"llm_inference import failed: {_IMPORT_ERROR}")
class OffloadWithoutCopyTests(unittest.TestCase):
    """_load_model_context uses the "meta" device as a stand-in for the card (the weights really leave the processor)."""

    def _handler(self):
        handler = LLMHandler()
        handler.llm = _Tiny()
        handler.llm_backend = "pt"
        handler.offload_to_cpu = True
        handler.device = "meta"
        handler.dtype = torch.float32
        return handler

    def test_the_same_processor_tensors_come_back(self):
        handler = self._handler()
        model = handler.llm
        before = {name: (p, p.data_ptr()) for name, p in model.named_parameters()}
        with handler._load_model_context():
            self.assertEqual(next(model.parameters()).device.type, "meta")
        for name, p in model.named_parameters():
            self.assertEqual(p.device.type, "cpu")
            self.assertIs(p, before[name][0])
            self.assertEqual(p.data_ptr(), before[name][1])  # not a copy: the very same memory

    def test_the_buffers_come_back_to_the_processor(self):
        handler = self._handler()
        with handler._load_model_context():
            self.assertEqual(handler.llm.table.device.type, "meta")
        self.assertEqual(handler.llm.table.device.type, "cpu")
        self.assertEqual(handler.llm.table.tolist(), [0.0, 1.0, 2.0])

    def test_the_weights_are_restored_when_the_work_fails(self):
        handler = self._handler()
        weight = handler.llm.linear.weight.detach().clone()
        with self.assertRaises(RuntimeError):
            with handler._load_model_context():
                raise RuntimeError("generation failed")
        self.assertEqual(handler.llm.linear.weight.device.type, "cpu")
        self.assertTrue(torch.equal(handler.llm.linear.weight, weight))

    def test_a_second_round_works_too(self):
        handler = self._handler()
        for _ in range(2):
            with handler._load_model_context():
                pass
            self.assertEqual(next(handler.llm.parameters()).device.type, "cpu")


if __name__ == "__main__":
    unittest.main()
