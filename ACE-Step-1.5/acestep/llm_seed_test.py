"""The song's seed drives the LM's sampling in single-song mode too (it used to be applied in batch mode only)."""

import unittest
from unittest.mock import patch

import torch

from acestep.llm_inference import LLMHandler


def _fake_generate(formatted_prompt, cfg, **kwargs):
    """Stands for the sampling loop: draws from the global generators, as torch.multinomial does."""
    if cfg.get("generation_phase") == "cot":
        bpm = int(torch.randint(60, 180, (1,)))
        return f"<think>\nbpm: {bpm}\nduration: 30\nkeyscale: C major\nlanguage: en\ntimesignature: 4\n</think>", "ok"
    codes = torch.randint(0, 64000, (6,)).tolist()
    return "".join(f"<|audio_code_{c}|>" for c in codes), "ok"


class LmSeedTests(unittest.TestCase):
    def _handler(self):
        handler = LLMHandler()
        handler.llm_initialized = True
        handler.llm_backend = "pt"
        return handler

    def _run(self, seeds):
        handler = self._handler()
        torch.manual_seed(int(torch.empty((), dtype=torch.int64).random_()))  # whatever ran before
        with patch.object(handler, "generate_from_formatted_prompt", side_effect=_fake_generate), \
                patch.object(handler, "build_formatted_prompt", return_value="prompt"), \
                patch.object(handler, "build_formatted_prompt_with_cot", return_value="prompt with cot"):
            result = handler.generate_with_stop_condition(
                caption="gospel", lyrics="la la", infer_type="llm_dit", batch_size=1, seeds=seeds)
        self.assertTrue(result["success"], result.get("error"))
        return result["metadata"].get("bpm"), result["audio_codes"]

    def test_the_same_seed_gives_the_same_metadata_and_codes(self):
        torch.manual_seed(1)
        first = self._run([42])
        torch.rand(1000)  # other work in between moves the global generators
        second = self._run([42])
        self.assertEqual(first, second)

    def test_another_seed_gives_other_codes(self):
        self.assertNotEqual(self._run([42])[1], self._run([7])[1])

    def test_first_seed(self):
        self.assertEqual(LLMHandler._first_seed([5, 6]), 5)
        self.assertEqual(LLMHandler._first_seed(9), 9)
        self.assertIsNone(LLMHandler._first_seed([]))
        self.assertIsNone(LLMHandler._first_seed(None))
        self.assertIsNone(LLMHandler._first_seed([-1]))


if __name__ == "__main__":
    unittest.main()
