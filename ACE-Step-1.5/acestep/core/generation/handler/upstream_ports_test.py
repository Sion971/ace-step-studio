"""Fixes taken from upstream pull requests not merged there (see the project note of Nov 26, 2026).

Each test names the pull request it covers.
"""

import ast
import random
import unittest
from pathlib import Path
from types import SimpleNamespace

from acestep.core.generation.handler.generate_music import GenerateMusicMixin

ROOT = Path(__file__).resolve().parents[4]  # the engine folder (ACE-Step-1.5)


class LoraDeviceCheckTests(unittest.TestCase):
    """Upstream #1319: no LoRA device check when the DiT is offloaded to the CPU."""

    def check(self, **state):
        return GenerateMusicMixin._lora_device_check_needed(SimpleNamespace(**state))

    def test_runs_with_a_lora_on_the_card(self):
        self.assertTrue(self.check(lora_loaded=True, use_lora=True, offload_dit_to_cpu=False))

    def test_skipped_when_the_dit_is_offloaded(self):
        self.assertFalse(self.check(lora_loaded=True, use_lora=True, offload_dit_to_cpu=True))

    def test_skipped_without_a_lora_in_use(self):
        self.assertFalse(self.check(lora_loaded=True, use_lora=False))
        self.assertFalse(self.check())


class VocalLanguageTests(unittest.TestCase):
    """Upstream #1302: the language the LM detects only fills a language left unset."""

    def test_unset_languages(self):
        from acestep.inference import _is_vocal_language_unset
        for unset in (None, "", "  ", "unknown", "Unknown "):
            self.assertTrue(_is_vocal_language_unset(unset), unset)
        for chosen in ("fr", "en", "ja"):
            self.assertFalse(_is_vocal_language_unset(chosen), chosen)


class PipelineLoggerImportTests(unittest.TestCase):
    """Upstream #1321: acestep_v15_pipeline uses ``logger``, so it must import it."""

    def test_logger_is_imported(self):
        tree = ast.parse((ROOT / "acestep" / "acestep_v15_pipeline.py").read_text(encoding="utf-8"))
        imported = {
            alias.asname or alias.name
            for node in tree.body if isinstance(node, ast.ImportFrom) and node.module == "loguru"
            for alias in node.names
        }
        self.assertIn("logger", imported)


if __name__ == "__main__":
    unittest.main()
