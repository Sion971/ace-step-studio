"""Cross-attention of the lyric alignment, a few heads at a time: same values as the plain eager attention, far fewer weights kept."""

import os
import unittest
from unittest import mock

import torch

from acestep.core.generation.handler import small_gpu_stream as sgs
from acestep.core.generation.handler.lyric_alignment_common import compact_alignment_attentions
from acestep.core.generation.handler.lyric_alignment_compact_test import _inputs, _tiny_decoder
from acestep.models.common import alignment_attention as aa


class ChunkedAlignmentTests(unittest.TestCase):
    # Not sorted, a head and a layer out of range, a layer left out (2), a layer with an empty list (0).
    CONFIG = {3: [1, 0], 1: [2], 4: [3, 99], 9: [0], 0: []}

    def _run(self, decoder, config, use_decoder=True):
        with mock.patch.object(sgs, "_ACTIVE_POOL", None), torch.no_grad():
            with sgs.alignment_heads(config, decoder if use_decoder else None) as decoder_config:
                out = decoder(**_inputs(), custom_layers_config=decoder_config, enable_early_exit=True)
        return out, decoder_config

    def test_same_matrix_and_same_hidden_states_as_the_plain_decoder(self):
        decoder = _tiny_decoder()
        plain, plain_config = self._run(decoder, self.CONFIG, use_decoder=False)
        self.assertIs(plain_config, self.CONFIG)
        expected, expected_config = compact_alignment_attentions(plain[2], self.CONFIG)
        for chunk in ("1", "3", "64"):
            with mock.patch.dict(os.environ, {aa.ENV_CHUNK: chunk}):
                lean, given = self._run(decoder, self.CONFIG)
            matrix, config = compact_alignment_attentions(lean[2], given)
            self.assertEqual(config, expected_config)
            self.assertEqual(matrix.shape, expected.shape)
            self.assertTrue(torch.allclose(matrix, expected, atol=1e-6, rtol=1e-5), chunk)
            self.assertTrue(torch.allclose(lean[0], plain[0], atol=1e-6, rtol=1e-5), chunk)

    def test_only_the_listed_heads_are_returned(self):
        decoder = _tiny_decoder()
        lean, given = self._run(decoder, self.CONFIG)
        self.assertEqual(given, {3: [0, 1], 1: [0], 4: [0, 1], 9: [0], 0: []})
        attentions = lean[2]
        self.assertIsNone(attentions[0])
        self.assertEqual(attentions[1].shape[1], 1)
        self.assertIsNone(attentions[2])
        self.assertEqual(attentions[3].shape[1], 2)
        self.assertEqual(attentions[4].shape[1], 1)  # head 99 does not exist

    def test_the_layers_are_unmarked_after_the_call_even_on_error(self):
        decoder = _tiny_decoder()
        with mock.patch.object(sgs, "_ACTIVE_POOL", None):
            with self.assertRaises(RuntimeError):
                with sgs.alignment_heads(self.CONFIG, decoder):
                    self.assertTrue(any(hasattr(l.cross_attn, aa.KEEP_ATTR) for l in decoder.layers if l.use_cross_attention))
                    raise RuntimeError("boom")
        self.assertFalse(any(hasattr(l.cross_attn, aa.KEEP_ATTR) for l in decoder.layers if l.use_cross_attention))
        # and the decoder gives the whole weights again, as before
        with torch.no_grad():
            full = decoder(**_inputs())[2]
        self.assertEqual(full[0].shape[1], 4)

    def test_no_config_changes_nothing(self):
        decoder = _tiny_decoder()
        with mock.patch.object(sgs, "_ACTIVE_POOL", None):
            with sgs.alignment_heads({}, decoder) as config:
                self.assertEqual(config, {})
            with sgs.alignment_heads(None, decoder) as config:
                self.assertIsNone(config)
        self.assertFalse(any(hasattr(l.cross_attn, aa.KEEP_ATTR) for l in decoder.layers if l.use_cross_attention))


class CheckpointCodeTests(unittest.TestCase):
    """The model code that runs is the checkpoint's own copy of the modeling file (another module): the chunked attention reaches it too."""

    def _remote_decoder(self):
        import importlib.util
        import sys

        from acestep.models.xl_turbo import modeling_acestep_v15_xl_turbo as local
        from acestep.models.xl_turbo.configuration_acestep_v15 import AceStepConfig

        name = "acestep.models.xl_turbo.checkpoint_copy_for_test"
        spec = importlib.util.spec_from_file_location(name, local.__file__)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        self.addCleanup(sys.modules.pop, name, None)
        spec.loader.exec_module(module)
        cfg = AceStepConfig(
            hidden_size=32, intermediate_size=64, num_hidden_layers=5, num_attention_heads=4, num_key_value_heads=2,
            head_dim=8, in_channels=24, audio_acoustic_hidden_dim=8, patch_size=2, use_sliding_window=False,
            layer_types=["full_attention"] * 5, vocab_size=100, max_position_embeddings=256,
        )
        cfg.encoder_hidden_size = 32
        cfg._attn_implementation = "eager"
        torch.manual_seed(0)
        return module, module.AceStepDiTModel(cfg).eval()

    def test_the_copy_of_the_checkpoint_gets_the_chunked_attention_with_the_same_values(self):
        config = {3: [1, 0], 1: [2], 4: [3, 99]}
        module, decoder = self._remote_decoder()
        original = module.eager_attention_forward
        with mock.patch.object(sgs, "_ACTIVE_POOL", None), torch.no_grad():
            plain = decoder(**_inputs(), custom_layers_config=config, enable_early_exit=True)
            with mock.patch.object(aa, "chunked_cross_attention", wraps=aa.chunked_cross_attention) as spy:
                with sgs.alignment_heads(config, decoder) as given:
                    lean = decoder(**_inputs(), custom_layers_config=given, enable_early_exit=True)
        self.assertGreater(spy.call_count, 0)
        self.assertTrue(getattr(module.eager_attention_forward, "_alignment_dispatch", False))
        self.assertIsNot(module.eager_attention_forward, original)
        expected, expected_config = compact_alignment_attentions(plain[2], config)
        matrix, got_config = compact_alignment_attentions(lean[2], given)
        self.assertEqual(got_config, expected_config)
        self.assertTrue(torch.allclose(matrix, expected, atol=1e-6, rtol=1e-5))
        self.assertTrue(torch.allclose(lean[0], plain[0], atol=1e-6, rtol=1e-5))

    def test_the_dispatch_is_installed_once_and_unmarked_layers_keep_the_original(self):
        module, decoder = self._remote_decoder()
        with mock.patch.object(sgs, "_ACTIVE_POOL", None), torch.no_grad():
            with sgs.alignment_heads({1: [0]}, decoder):
                first = module.eager_attention_forward
            with sgs.alignment_heads({1: [0]}, decoder):
                self.assertIs(module.eager_attention_forward, first)
            full = decoder(**_inputs())[2]  # no config: the whole weights, from the original function
        self.assertEqual(full[0].shape[1], 4)


if __name__ == "__main__":
    unittest.main()
