"""Tests of the LoRA adapters in small-card stream mode (run on the processor)."""

import copy
import json
import os
import tempfile
import types
import unittest
from unittest import mock

import torch

from acestep.core.generation.handler import small_gpu_stream as sgs
from acestep.core.generation.handler import small_gpu_stream_lora as sgl
from acestep.core.generation.handler.lora import stream_adapter
from acestep.core.generation.handler.small_gpu_stream_test import _inputs, _tiny_decoder

CPU = torch.device("cpu")
TARGETS = ("self_attn.q_proj", "cross_attn.v_proj")


def _bf16_exact(tensor):
    return tensor.to(torch.bfloat16).to(torch.float32)


def _write_adapter(directory, decoder, rank=4, alpha=8, config_extra=None, key_prefix="base_model.model.", seed=0, layers=None):
    """Write a PEFT-looking adapter for ``TARGETS`` of every block; return {(layer, module): (A, B)} (float32, bf16-exact)."""
    from safetensors.torch import save_file

    g = torch.Generator().manual_seed(seed)
    tensors, factors = {}, {}
    for index, layer in enumerate(decoder.layers):
        if layers is not None and index not in layers:
            continue
        for module in TARGETS:
            parent = layer
            for part in module.split("."):
                parent = getattr(parent, part, None)
                if parent is None:
                    break
            if parent is None:
                continue
            out_features, in_features = parent.weight.shape
            a = _bf16_exact(torch.randn(rank, in_features, generator=g) * 0.2)
            b = _bf16_exact(torch.randn(out_features, rank, generator=g) * 0.2)
            tensors[f"{key_prefix}layers.{index}.{module}.lora_A.weight"] = a
            tensors[f"{key_prefix}layers.{index}.{module}.lora_B.weight"] = b
            factors[(index, module)] = (a, b)
    save_file(tensors, os.path.join(directory, "adapter_model.safetensors"))
    config = {"peft_type": "LORA", "r": rank, "lora_alpha": alpha}
    config.update(config_extra or {})
    with open(os.path.join(directory, "adapter_config.json"), "w", encoding="utf-8") as fh:
        json.dump(config, fh)
    return factors


def _merged(decoder, factors, factor):
    """A copy of ``decoder`` with the adapter merged into its weights (the reference result)."""
    merged = copy.deepcopy(decoder)
    for (index, module), (a, b) in factors.items():
        parent = merged.layers[index]
        for part in module.split("."):
            parent = getattr(parent, part)
        parent.weight.data += factor * (b @ a)
    return merged


class StreamLoraTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        decoder, self.cfg = _tiny_decoder(layers=4)
        decoder.float().eval()
        self.streamed = copy.deepcopy(decoder).eval()
        decoder.to(torch.bfloat16).float()  # the reference keeps the weights the streamed copy holds
        self.reference = decoder
        self.inputs = _inputs(self.cfg)

    def _pool(self, **options):
        return sgs.install(self.streamed, CPU, torch.bfloat16, **options)

    def _load(self, pool, name="a", **kwargs):
        adapter = sgl.load_adapter(name, self.tmp.name, pool.param_names, pool.param_shapes, pool.count)
        if pool.lora is None:
            pool.lora = sgl.StreamLoraSet(pool)
        pool.lora.add(adapter)
        return adapter

    @torch.no_grad()
    def _out(self, model):
        return model(**self.inputs, use_cache=False)[0]

    def test_the_streamed_output_equals_the_merged_model(self):
        factors = _write_adapter(self.tmp.name, self.reference)
        pool = self._pool()
        base = self._out(self.streamed)
        adapter = self._load(pool)
        self.assertEqual(adapter.targets, len(factors))
        out = self._out(self.streamed)
        ref = self._out(_merged(self.reference, factors, 8 / 4))
        self.assertLess((out - ref).abs().max().item(), 1e-4)
        self.assertGreater((out - base).abs().max().item(), 1e-3, "the adapter must change the result")

    def test_the_strength_scales_the_change(self):
        factors = _write_adapter(self.tmp.name, self.reference)
        pool = self._pool()
        self._load(pool)
        pool.lora.set_scale("a", 0.5)
        ref = self._out(_merged(self.reference, factors, 8 / 4 * 0.5))
        self.assertLess((self._out(self.streamed) - ref).abs().max().item(), 1e-4)

    def test_switching_off_or_removing_gives_the_base_result_back(self):
        _write_adapter(self.tmp.name, self.reference)
        pool = self._pool()
        base = self._out(self.streamed)
        self._load(pool)
        with_adapter = self._out(self.streamed)
        pool.lora.set_enabled(False)
        self.assertLess((self._out(self.streamed) - base).abs().max().item(), 1e-4)
        pool.lora.set_enabled(True)
        self.assertLess((self._out(self.streamed) - with_adapter).abs().max().item(), 1e-4)
        pool.lora.set_scale("a", 0.0)
        self.assertLess((self._out(self.streamed) - base).abs().max().item(), 1e-4)
        pool.lora.set_scale("a", 1.0)
        pool.lora.remove("a")
        self.assertLess((self._out(self.streamed) - base).abs().max().item(), 1e-4)

    def test_the_ram_copies_of_the_base_weights_are_never_changed(self):
        _write_adapter(self.tmp.name, self.reference)
        pool = self._pool()
        before = [[t.clone() for t in layer] for layer in pool.cpu_params]
        self._load(pool)
        self._out(self.streamed)
        for old, new in zip(before, pool.cpu_params):
            for a, b in zip(old, new):
                self.assertTrue(torch.equal(a, b))

    def test_resident_blocks_get_the_adapter_too(self):
        factors = _write_adapter(self.tmp.name, self.reference)
        ref = self._out(_merged(self.reference, factors, 8 / 4))
        for resident in (0, 2, 4):
            with self.subTest(resident=resident):
                streamed = copy.deepcopy(self.streamed)
                pool = sgs.install(streamed, CPU, torch.bfloat16, resident=resident)
                adapter = sgl.load_adapter("a", self.tmp.name, pool.param_names, pool.param_shapes, pool.count)
                pool.lora = sgl.StreamLoraSet(pool)
                pool.lora.add(adapter)
                self.assertLess((self._out(streamed) - ref).abs().max().item(), 1e-4)

    def test_a_change_after_the_blocks_were_placed_is_taken_into_account(self):
        factors = _write_adapter(self.tmp.name, self.reference)
        pool = self._pool(resident=2)
        base = self._out(self.streamed)  # the blocks are on the "card" now
        self._load(pool)
        ref = self._out(_merged(self.reference, factors, 8 / 4))
        self.assertLess((self._out(self.streamed) - ref).abs().max().item(), 1e-4)
        pool.lora.clear()
        self.assertLess((self._out(self.streamed) - base).abs().max().item(), 1e-4)

    def test_only_the_active_adapter_counts(self):
        factors_a = _write_adapter(self.tmp.name, self.reference, seed=1)
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        factors_b = _write_adapter(other.name, self.reference, seed=2)
        pool = self._pool()
        self._load(pool, "a")
        pool.lora.add(sgl.load_adapter("b", other.name, pool.param_names, pool.param_shapes, pool.count))
        self.assertEqual(pool.lora.active, "b")
        self.assertLess((self._out(self.streamed) - self._out(_merged(self.reference, factors_b, 2.0))).abs().max().item(), 1e-4)
        pool.lora.set_active("a")
        self.assertLess((self._out(self.streamed) - self._out(_merged(self.reference, factors_a, 2.0))).abs().max().item(), 1e-4)

    def test_rank_stabilised_scaling_and_alpha_patterns(self):
        factors = _write_adapter(self.tmp.name, self.reference, rank=4, alpha=8, config_extra={"use_rslora": True})
        pool = self._pool()
        self._load(pool)
        ref = self._out(_merged(self.reference, factors, 8 / 2))
        self.assertLess((self._out(self.streamed) - ref).abs().max().item(), 1e-4)
        pool.lora.clear()
        _write_adapter(self.tmp.name, self.reference, rank=4, alpha=8, config_extra={"alpha_pattern": {"q_proj": 4}})
        adapter = sgl.load_adapter("p", self.tmp.name, pool.param_names, pool.param_shapes, pool.count)
        factors_seen = {round(t.factor, 6) for targets in adapter.layers.values() for t in targets}
        self.assertEqual(factors_seen, {1.0, 2.0})  # q_proj: 4/4, v_proj: 8/4

    def test_keys_with_an_adapter_name_or_a_decoder_prefix_are_read(self):
        from safetensors.torch import load_file, save_file

        factors = _write_adapter(self.tmp.name, self.reference)
        path = os.path.join(self.tmp.name, "adapter_model.safetensors")
        state = load_file(path)
        renamed = {k.replace(".lora_A.weight", ".lora_A.default.weight").replace(".lora_B.weight", ".lora_B.default.weight")
                   .replace("base_model.model.", "base_model.model.decoder."): v for k, v in state.items()}
        save_file(renamed, path)
        pool = self._pool()
        self.assertEqual(self._load(pool).targets, len(factors))

    def test_weights_outside_the_blocks_are_counted_and_ignored(self):
        from safetensors.torch import load_file, save_file

        _write_adapter(self.tmp.name, self.reference, layers={0})
        path = os.path.join(self.tmp.name, "adapter_model.safetensors")
        state = load_file(path)
        state["base_model.model.condition_embedder.lora_A.weight"] = torch.zeros(4, 8)
        state["base_model.model.condition_embedder.lora_B.weight"] = torch.zeros(8, 4)
        state["base_model.model.layers.99.self_attn.q_proj.lora_A.weight"] = torch.zeros(4, 8)
        save_file(state, path)
        pool = self._pool()
        adapter = self._load(pool)
        self.assertEqual(adapter.ignored, 3)
        self.assertEqual(sorted(adapter.layers), [0])

    def test_unusable_adapters_are_refused_with_a_reason(self):
        pool = self._pool()
        for extra, expected in (({"use_dora": True}, "DoRA"), ({"fan_in_fan_out": True}, "transposed")):
            with self.subTest(extra=extra):
                _write_adapter(self.tmp.name, self.reference, config_extra=extra)
                with self.assertRaisesRegex(sgl.StreamLoraError, expected):
                    sgl.load_adapter("x", self.tmp.name, pool.param_names, pool.param_shapes, pool.count)
        _write_adapter(self.tmp.name, self.reference, key_prefix="base_model.model.nowhere.")
        with self.assertRaisesRegex(sgl.StreamLoraError, "no LoRA weight"):
            sgl.load_adapter("x", self.tmp.name, pool.param_names, pool.param_shapes, pool.count)
        empty = tempfile.TemporaryDirectory()
        self.addCleanup(empty.cleanup)
        with self.assertRaises(sgl.StreamLoraError):
            sgl.load_adapter("x", empty.name, pool.param_names, pool.param_shapes, pool.count)

    def test_factors_that_do_not_fit_the_weight_are_refused(self):
        from safetensors.torch import load_file, save_file

        _write_adapter(self.tmp.name, self.reference, layers={0})
        path = os.path.join(self.tmp.name, "adapter_model.safetensors")
        state = load_file(path)
        key = next(k for k in state if k.endswith("lora_A.weight"))
        state[key] = torch.zeros(4, state[key].shape[1] + 1)
        save_file(state, path)
        pool = self._pool()
        with self.assertRaisesRegex(sgl.StreamLoraError, "do not fit"):
            sgl.load_adapter("x", self.tmp.name, pool.param_names, pool.param_shapes, pool.count)


class HandlerTests(unittest.TestCase):
    """The handler-level operations (load, scale, switch, unload) on a streamed DiT."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        decoder, cfg = _tiny_decoder(layers=4)
        decoder.float().eval()
        self.reference = copy.deepcopy(decoder).to(torch.bfloat16).float()
        self.pool = sgs.install(decoder, CPU, torch.bfloat16)
        self.decoder, self.cfg = decoder, cfg
        patcher = mock.patch.object(sgs, "_ACTIVE_POOL", self.pool)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.host = types.SimpleNamespace(lora_loaded=False, use_lora=False, lora_scale=1.0, _active_loras={},
                                          _adapter_type=None, _lora_active_adapter=None)
        _write_adapter(self.tmp.name, self.reference)

    def test_load_scale_switch_off_and_unload(self):
        self.assertTrue(stream_adapter.streaming())
        message = stream_adapter.add(self.host, self.tmp.name, "mine")
        self.assertTrue(message.startswith("✅"), message)
        self.assertTrue(self.host.lora_loaded and self.host.use_lora)
        self.assertEqual(self.host._active_loras, {"mine": 1.0})
        self.assertEqual(stream_adapter.adapter_names(), ["mine"])
        self.assertTrue(stream_adapter.set_scale(self.host, "mine", 0.5).startswith("✅"))
        self.assertEqual(self.pool.lora.scales["mine"], 0.5)
        self.assertTrue(stream_adapter.set_use(self.host, False).startswith("✅"))
        self.assertFalse(self.pool.lora.enabled)
        self.assertTrue(stream_adapter.unload(self.host).startswith("✅"))
        self.assertFalse(self.host.lora_loaded)
        self.assertEqual(self.host._active_loras, {})
        self.assertIsNone(stream_adapter.adapter_names())

    def test_a_second_adapter_with_the_same_name_is_refused(self):
        stream_adapter.add(self.host, self.tmp.name, "mine")
        self.assertIn("already in use", stream_adapter.add(self.host, self.tmp.name, "mine"))

    def test_removing_the_last_adapter_resets_the_flags(self):
        stream_adapter.add(self.host, self.tmp.name, "mine")
        self.assertTrue(stream_adapter.remove(self.host, "mine").startswith("✅"))
        self.assertFalse(self.host.lora_loaded)
        self.assertIn("Unknown adapter", stream_adapter.remove(self.host, "mine"))

    def test_bad_paths_and_lokr_are_refused_in_plain_words(self):
        self.assertIn("not found", stream_adapter.add(self.host, os.path.join(self.tmp.name, "nope"), "x"))
        self.assertIn("provide a LoRA path", stream_adapter.add(self.host, " ", "x"))
        lokr = tempfile.TemporaryDirectory()
        self.addCleanup(lokr.cleanup)
        open(os.path.join(lokr.name, "lokr_weights.safetensors"), "wb").close()
        self.assertIn("LoKr", stream_adapter.add(self.host, lokr.name, "x"))
        self.assertFalse(self.host.lora_loaded)

    def test_a_failed_load_changes_nothing(self):
        empty = tempfile.TemporaryDirectory()
        self.addCleanup(empty.cleanup)
        self.assertTrue(stream_adapter.add(self.host, empty.name, "x").startswith("❌"))
        self.assertFalse(self.host.lora_loaded)
        self.assertIsNone(stream_adapter.adapter_names())

    def test_without_a_streamed_dit_nothing_is_streaming(self):
        with mock.patch.object(sgs, "_ACTIVE_POOL", None):
            self.assertFalse(stream_adapter.streaming())


if __name__ == "__main__":
    unittest.main()
