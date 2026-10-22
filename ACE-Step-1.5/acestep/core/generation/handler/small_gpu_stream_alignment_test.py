"""The streamed DiT returns only the heads of the lyric alignment (chosen on the card side), with the same values as before."""

import unittest
from unittest import mock

import torch

from acestep.core.generation.handler import small_gpu_stream as sgs
from acestep.core.generation.handler.lyric_alignment_common import compact_alignment_attentions
from acestep.core.generation.handler.lyric_alignment_compact_test import _inputs, _tiny_decoder


class AlignmentHeadsTests(unittest.TestCase):
    # Not sorted, a head and a layer out of range, a layer left out (2), a layer with an empty list (0).
    CONFIG = {3: [1, 0], 1: [2], 4: [3, 99], 9: [0], 0: []}

    def _streamed(self):
        decoder = _tiny_decoder()
        pool = sgs.install(decoder, torch.device("cpu"), torch.float32)
        return decoder, pool

    def _run(self, decoder, config, active_pool=None):
        with mock.patch.object(sgs, "_ACTIVE_POOL", active_pool), torch.no_grad():
            with sgs.alignment_heads(config) as decoder_config:
                out = decoder(**_inputs(), custom_layers_config=decoder_config, enable_early_exit=True)
        return out[2], decoder_config

    def test_without_the_mode_the_config_is_untouched(self):
        decoder = _tiny_decoder()
        attentions, given = self._run(decoder, self.CONFIG)
        self.assertIs(given, self.CONFIG)
        self.assertEqual(len(attentions), 5)

    def test_the_streamed_decoder_gives_the_same_matrix_as_the_plain_one(self):
        plain, _ = self._run(_tiny_decoder(), self.CONFIG)
        expected, expected_config = compact_alignment_attentions(plain, self.CONFIG)
        streamed_decoder, pool = self._streamed()
        attentions, given = self._run(streamed_decoder, self.CONFIG, active_pool=pool)
        matrix, config = compact_alignment_attentions(attentions, given)
        self.assertEqual(config, expected_config)
        self.assertEqual(matrix.shape, expected.shape)
        self.assertTrue(torch.allclose(matrix, expected, atol=1e-5, rtol=1e-4))

    def test_only_the_listed_heads_leave_the_blocks(self):
        decoder, pool = self._streamed()
        attentions, given = self._run(decoder, self.CONFIG, active_pool=pool)
        self.assertEqual(given, {3: [0, 1], 1: [0], 4: [0, 1], 9: [0], 0: []})
        self.assertIsNone(attentions[0])
        self.assertEqual(attentions[1].shape[1], 1)
        self.assertIsNone(attentions[2])
        self.assertEqual(attentions[3].shape[1], 2)
        self.assertEqual(attentions[4].shape[1], 1)  # head 99 does not exist
        self.assertEqual(attentions[4].dtype, torch.float32)

    def test_the_self_attention_weights_are_not_sent(self):
        decoder, pool = self._streamed()
        with mock.patch.object(sgs, "_ACTIVE_POOL", pool), torch.no_grad(), sgs.alignment_heads({1: [0]}) as config:
            layer = decoder.layers[1]
            seen = []
            real_select = pool.select_alignment_heads

            def spy(index, out):
                result = real_select(index, out)
                seen.append((out[1] is not None, result[1]))
                return result

            with mock.patch.object(pool, "select_alignment_heads", spy):
                decoder(**_inputs(), custom_layers_config=config, enable_early_exit=True)
        self.assertTrue(seen)
        self.assertTrue(all(sent is None for _, sent in seen))
        self.assertIsNotNone(layer)

    def test_the_pool_is_reset_after_the_call_even_on_error(self):
        decoder, pool = self._streamed()
        with mock.patch.object(sgs, "_ACTIVE_POOL", pool):
            with self.assertRaises(RuntimeError):
                with sgs.alignment_heads(self.CONFIG):
                    self.assertIsNotNone(pool.align_heads)
                    raise RuntimeError("boom")
            self.assertIsNone(pool.align_heads)
            with sgs.alignment_heads({}) as config:  # nothing to select: the pool is left alone
                self.assertEqual(config, {})
                self.assertIsNone(pool.align_heads)

    def test_a_normal_generation_is_not_affected(self):
        plain = _tiny_decoder()
        decoder, pool = self._streamed()
        with mock.patch.object(sgs, "_ACTIVE_POOL", pool), torch.no_grad():
            streamed = decoder(**_inputs())[0]
        with torch.no_grad():
            expected = plain(**_inputs())[0]
        self.assertTrue(torch.allclose(streamed, expected, atol=1e-5, rtol=1e-4))


if __name__ == "__main__":
    unittest.main()
