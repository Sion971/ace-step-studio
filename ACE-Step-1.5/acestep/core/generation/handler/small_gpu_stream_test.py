"""Unit tests for the small-GPU stream mode (run on the processor: the card path is checked by hand)."""

import copy
import os
import unittest
from unittest import mock

import torch
from torch import nn

from acestep.core.generation.handler import small_gpu_stream as sgs


def _tiny_decoder(layers: int = 4):
    """A small randomly initialised DiT built from the real turbo modeling code."""
    import importlib.util
    import sys

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", "..", "..", ".."))
    path = os.path.join(root, "acestep", "models", "turbo", "modeling_acestep_v15_turbo.py")
    name = "_sgs_test_modeling_turbo"
    if name not in sys.modules:
        sys.path.insert(0, os.path.dirname(path))
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    modeling = sys.modules[name]
    from acestep.models.common.configuration_acestep_v15 import AceStepConfig

    cfg = AceStepConfig(
        hidden_size=64, intermediate_size=128, num_hidden_layers=layers,
        num_attention_heads=4, num_key_value_heads=2, head_dim=16,
    )
    cfg._attn_implementation = "sdpa"
    torch.manual_seed(0)
    return modeling.AceStepDiTModel(cfg).to(torch.bfloat16), cfg


def _inputs(cfg, frames=20, cond=12):
    g = torch.Generator().manual_seed(3)
    audio = cfg.audio_acoustic_hidden_dim
    return dict(
        hidden_states=torch.randn(1, frames, audio, generator=g),
        timestep=torch.tensor([0.5]),
        timestep_r=torch.tensor([0.0]),
        attention_mask=None,
        encoder_hidden_states=torch.randn(1, cond, cfg.hidden_size, generator=g),
        encoder_attention_mask=None,
        context_latents=torch.randn(1, frames, cfg.in_channels - audio, generator=g),
    )


class EnvironmentTests(unittest.TestCase):
    def test_disabled_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(sgs.ENV_FLAG, None)
            self.assertFalse(sgs.requested())
            self.assertFalse(sgs.enabled())
            self.assertFalse(sgs.attach_if_enabled(nn.Linear(1, 1)))

    def test_requested_without_card_leaves_the_model_alone(self):
        model = mock.Mock()
        with mock.patch.dict(os.environ, {sgs.ENV_FLAG: "1"}), mock.patch.object(torch.cuda, "is_available", return_value=False):
            self.assertTrue(sgs.requested())
            self.assertFalse(sgs.enabled())
            self.assertFalse(sgs.attach_if_enabled(model))
        self.assertFalse(sgs.active())

    def test_quantized_model_is_refused(self):
        with mock.patch.dict(os.environ, {sgs.ENV_FLAG: "1"}), mock.patch.object(torch.cuda, "is_available", return_value=True):
            self.assertFalse(sgs.attach_if_enabled(mock.Mock(), quantized=True))

    def test_lora_blocked_only_when_active(self):
        self.assertIsNone(sgs.lora_blocked_message())
        with mock.patch.object(sgs, "_ACTIVE_POOL", object()):
            self.assertIn("LoRA", sgs.lora_blocked_message())

    def test_vae_chunk_size(self):
        with mock.patch.dict(os.environ, {sgs.ENV_VAE_CHUNK: "64"}):
            self.assertEqual(sgs.vae_chunk_size(), 64)
        with mock.patch.dict(os.environ, {sgs.ENV_VAE_CHUNK: "abc"}):
            self.assertEqual(sgs.vae_chunk_size(), sgs.DEFAULT_VAE_CHUNK)
        with mock.patch.dict(os.environ, {sgs.ENV_VAE_CHUNK: "2"}):
            self.assertEqual(sgs.vae_chunk_size(), 24)


class MovementTests(unittest.TestCase):
    def test_to_device_keeps_integer_masks_and_passes_objects(self):
        cache = object()
        out = sgs._to_device(
            {"a": torch.ones(2, dtype=torch.bfloat16), "m": torch.ones(2, dtype=torch.bool), "c": cache, "t": (torch.zeros(1), 3)},
            torch.device("cpu"),
        )
        self.assertEqual(out["a"].dtype, torch.float32)
        self.assertEqual(out["m"].dtype, torch.bool)
        self.assertIs(out["c"], cache)
        self.assertEqual(out["t"][1], 3)

    def test_to_cpu_recurses(self):
        out = sgs._to_cpu(([torch.ones(1)], {"x": torch.ones(1)}, None))
        self.assertEqual(out[0][0].device.type, "cpu")
        self.assertIsNone(out[2])


class StreamingEquivalenceTests(unittest.TestCase):
    def _pair(self):
        decoder, cfg = _tiny_decoder()
        decoder.float().eval()
        streamed = copy.deepcopy(decoder).eval()
        # the reference keeps bfloat16-exact weights, like the streamed copy does
        decoder.to(torch.bfloat16).float()
        pool = sgs.install(streamed, torch.device("cpu"), torch.bfloat16)
        return decoder, streamed, pool, cfg

    @torch.no_grad()
    def test_same_output_as_the_plain_decoder(self):
        decoder, streamed, _pool, cfg = self._pair()
        inputs = _inputs(cfg)
        ref = decoder(**inputs, use_cache=False)[0]
        out = streamed(**inputs, use_cache=False)[0]
        self.assertTrue(torch.isfinite(out).all())
        self.assertLess((out - ref).abs().max().item(), 1e-4)

    @torch.no_grad()
    def test_same_output_over_several_steps_with_the_cross_attention_cache(self):
        from transformers.cache_utils import DynamicCache, EncoderDecoderCache

        decoder, streamed, _pool, cfg = self._pair()
        inputs = _inputs(cfg)
        cache_ref = EncoderDecoderCache(DynamicCache(), DynamicCache())
        cache_str = EncoderDecoderCache(DynamicCache(), DynamicCache())
        x_ref = inputs["hidden_states"].clone()
        x_str = inputs["hidden_states"].clone()
        for step in range(3):
            t = torch.tensor([1.0 - 0.3 * step])
            kw = dict(inputs, timestep=t, timestep_r=t)
            o_ref = decoder(**dict(kw, hidden_states=x_ref), use_cache=True, past_key_values=cache_ref)
            o_str = streamed(**dict(kw, hidden_states=x_str), use_cache=True, past_key_values=cache_str)
            cache_ref, cache_str = o_ref[1], o_str[1]
            x_ref = x_ref - 0.1 * o_ref[0]
            x_str = x_str - 0.1 * o_str[0]
            self.assertLess((o_ref[0] - o_str[0]).abs().max().item(), 1e-4, f"step {step}")

    def test_proxies_expose_the_block_attributes_the_dit_reads(self):
        _decoder, streamed, _pool, _cfg = self._pair()
        types = {layer.attention_type for layer in streamed.layers}
        self.assertEqual(types, {"sliding_attention", "full_attention"})  # both kinds are streamed
        self.assertTrue(hasattr(streamed.layers[0], "use_cross_attention"))

    def test_proxies_hold_no_weights_in_the_module_tree(self):
        _decoder, streamed, _pool, _cfg = self._pair()
        self.assertEqual(sum(1 for _ in streamed.layers.parameters()), 0)

    @torch.no_grad()
    def test_releasing_the_card_slots_is_transparent(self):
        decoder, streamed, pool, cfg = self._pair()
        inputs = _inputs(cfg)
        before = streamed(**inputs, use_cache=False)[0]
        pool.release_gpu()
        self.assertEqual(pool.slots, [])
        after = streamed(**inputs, use_cache=False)[0]  # slots are recreated on demand
        self.assertEqual(len(pool.slots), 2)
        self.assertTrue(torch.equal(before, after))

    def test_inference_mode_and_no_grad_can_be_mixed(self):
        decoder, streamed, pool, cfg = self._pair()
        inputs = _inputs(cfg)
        ref = decoder(**inputs, use_cache=False)[0]
        with torch.inference_mode():
            first = streamed(**inputs, use_cache=False)[0]
            pool.release_gpu()  # as the VAE step does
            second = streamed(**inputs, use_cache=False)[0]  # slots recreated inside inference mode
        with torch.no_grad():
            third = streamed(**inputs, use_cache=False)[0]  # ... then refilled outside it
        for out in (first, second, third):
            self.assertLess((out - ref).abs().max().item(), 1e-4)

    def test_cpu_copy_is_bfloat16_by_default(self):
        _decoder, _streamed, pool, _cfg = self._pair()
        self.assertTrue(all(t.dtype == torch.bfloat16 for t in pool.cpu_params[0]))

    def test_layers_with_different_structure_are_refused(self):
        decoder, _cfg = _tiny_decoder()
        decoder.layers[1].mlp.gate_proj = nn.Linear(64, 130, bias=False)
        with self.assertRaises(RuntimeError):
            sgs.install(decoder, torch.device("cpu"))


class VaeRoutingTests(unittest.TestCase):
    def test_tiled_decode_goes_through_the_card_when_the_mode_is_active(self):
        from acestep.core.generation.handler.vae_decode import VaeDecodeMixin

        class Host(VaeDecodeMixin):
            use_mlx_vae = False
            mlx_vae = None
            device = "cpu"

        latents = torch.zeros(1, 64, 10)
        sentinel = torch.ones(1, 2, 5)
        with mock.patch.object(sgs, "vae_decode_enabled", return_value=True), \
                mock.patch.object(sgs, "tiled_decode_on_card", return_value=sentinel) as card:
            out = Host().tiled_decode(latents)
        card.assert_called_once()
        self.assertIs(out, sentinel)


if __name__ == "__main__":
    unittest.main()
