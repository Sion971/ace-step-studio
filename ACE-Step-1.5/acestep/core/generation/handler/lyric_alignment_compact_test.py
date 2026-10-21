"""The lyric alignment keeps only the configured heads of the decoder's cross-attention, with the same result as before."""

import unittest

import torch

from acestep.core.generation.handler.lyric_alignment_common import compact_alignment_attentions
from acestep.core.scoring.dit_alignment import MusicStampsAligner


def _tiny_decoder(layers=5, heads=4):
    """A small real decoder (the XL model code, random weights, eager attention so the weights come out)."""
    from acestep.models.xl_turbo import modeling_acestep_v15_xl_turbo as modeling
    from acestep.models.xl_turbo.configuration_acestep_v15 import AceStepConfig

    cfg = AceStepConfig(
        hidden_size=32, intermediate_size=64, num_hidden_layers=layers, num_attention_heads=heads, num_key_value_heads=2,
        head_dim=8, in_channels=24, audio_acoustic_hidden_dim=8, patch_size=2, use_sliding_window=False,
        layer_types=["full_attention"] * layers, vocab_size=100, max_position_embeddings=256,
    )
    cfg.encoder_hidden_size = 32
    cfg._attn_implementation = "eager"
    torch.manual_seed(0)
    return modeling.AceStepDiTModel(cfg).eval()


def _inputs(batch=1, frames=10, tokens=6):
    torch.manual_seed(1)
    time = torch.tensor([0.5] * batch)
    return dict(
        hidden_states=torch.randn(batch, frames, 8), timestep=time, timestep_r=time,
        attention_mask=torch.ones(batch, frames), encoder_hidden_states=torch.randn(batch, tokens, 32),
        encoder_attention_mask=torch.ones(batch, tokens), context_latents=torch.randn(batch, frames, 16),
        use_cache=False, output_attentions=True,
    )


def _reference(full_attentions, config):
    """What the scorer read before: one matrix per (layer, head) of the config, in the order of the config."""
    stacked = torch.stack([a.transpose(-1, -2) for a in full_attentions]).squeeze(1)  # [layers, heads, tokens, frames]
    return [stacked[layer, head] for layer, heads in config.items() for head in heads
            if layer < stacked.shape[0] and head < stacked.shape[1]]


class CompactAttentionTests(unittest.TestCase):
    CONFIG = {3: [1, 0], 1: [2], 4: [3, 99], 9: [0]}  # not sorted, a head and a layer out of range

    def test_the_decoder_returns_only_the_configured_heads(self):
        decoder = _tiny_decoder()
        with torch.no_grad():
            full = decoder(**_inputs())[2]
            lean = decoder(**_inputs(), custom_layers_config=self.CONFIG, enable_early_exit=True)[2]
        self.assertEqual(len(full), 5)
        self.assertEqual(len(lean), 5)  # stops after the last layer of the config (4); layer 9 does not exist
        self.assertIsNone(lean[0])
        self.assertIsNone(lean[2])
        self.assertEqual(lean[1].shape[1], 1)
        self.assertEqual(lean[3].shape[1], 2)
        self.assertEqual(lean[4].shape[1], 1)  # head 99 does not exist
        kept = sum(a.numel() for a in lean if a is not None)
        self.assertLess(kept, sum(a.numel() for a in full) / 2)

    def test_the_decoder_stops_after_the_last_layer_of_the_config(self):
        decoder = _tiny_decoder()
        with torch.no_grad():
            lean = decoder(**_inputs(), custom_layers_config={1: [0]}, enable_early_exit=True)[2]
        self.assertEqual(len(lean), 2)  # layers 2, 3 and 4 were not run

    def test_the_compact_matrix_equals_the_selection_from_the_full_attention(self):
        decoder = _tiny_decoder()
        with torch.no_grad():
            full = decoder(**_inputs())[2]
            lean = decoder(**_inputs(), custom_layers_config=self.CONFIG, enable_early_exit=True)[2]
        expected = _reference(full, self.CONFIG)
        for attentions in (lean, full):  # the lean output and a full output both give the same matrix
            matrix, config = compact_alignment_attentions(attentions, self.CONFIG)
            self.assertEqual(config, {0: list(range(len(expected)))})
            got = matrix.transpose(-1, -2).squeeze(0)  # [heads, tokens, frames]
            self.assertEqual(got.shape[0], len(expected))
            for index, wanted in enumerate(expected):
                self.assertTrue(torch.equal(got[index], wanted))

    def test_the_scorer_reads_the_same_values(self):
        decoder = _tiny_decoder()
        with torch.no_grad():
            full = decoder(**_inputs())[2]
            lean = decoder(**_inputs(), custom_layers_config=self.CONFIG, enable_early_exit=True)[2]
        aligner = MusicStampsAligner(None)
        old_stack = torch.stack([a.transpose(-1, -2) for a in full]).squeeze(1)
        old, _, _ = aligner._preprocess_attention(old_stack, self.CONFIG, 2.0, 1)
        matrix, config = compact_alignment_attentions(lean, self.CONFIG)
        new, _, _ = aligner._preprocess_attention(matrix.transpose(-1, -2).unsqueeze(0).squeeze(1), config, 2.0, 1)
        self.assertEqual(old.shape, new.shape)
        self.assertTrue((old == new).all())

    def test_nothing_selected(self):
        self.assertEqual(compact_alignment_attentions([None, None], {0: [0]}), (None, {}))
        self.assertEqual(compact_alignment_attentions([torch.zeros(1, 2, 3, 4)], {5: [0]}), (None, {}))

    def test_the_batched_score_pass_keeps_both_halves(self):
        decoder = _tiny_decoder()
        inputs = _inputs(batch=2)
        with torch.no_grad():
            full = decoder(**inputs)[2]
            lean = decoder(**inputs, custom_layers_config=self.CONFIG, enable_early_exit=True)[2]
        expected = _reference_batched(full, self.CONFIG)
        matrix, _ = compact_alignment_attentions(lean, self.CONFIG)
        got = matrix.transpose(-1, -2)  # [batch, heads, tokens, frames]
        self.assertTrue(torch.equal(got, expected))


def _reference_batched(full_attentions, config):
    parts = []
    for layer, heads in config.items():
        if layer >= len(full_attentions):
            continue
        valid = [h for h in heads if h < full_attentions[layer].shape[1]]
        parts.append(full_attentions[layer][:, valid].transpose(-1, -2))
    return torch.cat(parts, dim=1)


if __name__ == "__main__":
    unittest.main()
