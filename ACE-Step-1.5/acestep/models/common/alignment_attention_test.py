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


if __name__ == "__main__":
    unittest.main()
