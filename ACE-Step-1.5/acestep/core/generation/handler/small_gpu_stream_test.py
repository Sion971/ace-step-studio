"""Unit tests for the small-GPU stream mode (run on the processor: the card path is checked by hand)."""

import copy
import os
import types
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


def _tiny_condition_model():
    """A small randomly initialised condition-generation model built from the real turbo modeling code."""
    import sys

    _tiny_decoder()  # loads the modeling module under a private name
    modeling = sys.modules["_sgs_test_modeling_turbo"]
    from acestep.models.common.configuration_acestep_v15 import AceStepConfig

    cfg = AceStepConfig(
        hidden_size=64, intermediate_size=128, num_hidden_layers=4, num_attention_heads=4, num_key_value_heads=2,
        head_dim=16, num_lyric_encoder_hidden_layers=3, num_timbre_encoder_hidden_layers=2,
        num_attention_pooler_hidden_layers=2, text_hidden_dim=32, fsq_dim=64,
    )
    cfg._attn_implementation = "sdpa"
    torch.manual_seed(1)
    return modeling.AceStepConditionGenerationModel(cfg).float().eval(), cfg


def _condition_inputs(cfg, cover=False):
    g = torch.Generator().manual_seed(5)
    frames = 20
    latents = torch.randn(1, frames, cfg.audio_acoustic_hidden_dim, generator=g)
    return dict(
        text_hidden_states=torch.randn(1, 6, cfg.text_hidden_dim, generator=g),
        text_attention_mask=torch.ones(1, 6, dtype=torch.long),
        lyric_hidden_states=torch.randn(1, 9, cfg.text_hidden_dim, generator=g),
        lyric_attention_mask=torch.ones(1, 9, dtype=torch.long),
        refer_audio_acoustic_hidden_states_packed=torch.randn(2, 10, cfg.timbre_hidden_dim, generator=g),
        refer_audio_order_mask=torch.zeros(2, dtype=torch.long),
        hidden_states=latents,
        attention_mask=torch.ones(1, frames),
        silence_latent=torch.randn(1, 30, cfg.audio_acoustic_hidden_dim, generator=g),
        src_latents=latents.clone(),
        chunk_masks=torch.ones(1, frames, cfg.audio_acoustic_hidden_dim),
        is_covers=torch.tensor([1 if cover else 0]),
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


class ResidentAndComputeTests(unittest.TestCase):
    """The options for cards that are not tiny: blocks kept on the card, and computing in bfloat16."""

    CPU = torch.device("cpu")

    def _decoders(self, layers=6):
        decoder, cfg = _tiny_decoder(layers)
        decoder.float().eval()
        reference = copy.deepcopy(decoder).eval()
        reference.to(torch.bfloat16).float()  # the streamed copy holds bfloat16-exact weights
        return decoder, reference, cfg

    @torch.no_grad()
    def _run(self, layers=6, **options):
        decoder, reference, cfg = self._decoders(layers)
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, **options)
        inputs = _inputs(cfg)
        return decoder, pool, reference(**inputs, use_cache=False)[0], decoder(**inputs, use_cache=False)[0], inputs

    def test_resident_blocks_give_the_same_output_whatever_their_number(self):
        for layers in (5, 6):  # odd and even numbers of streamed blocks
            for resident in range(0, layers + 1):
                with self.subTest(layers=layers, resident=resident):
                    _d, pool, ref, out, _i = self._run(layers, resident=resident)
                    self.assertEqual(pool.resident_n, resident)
                    self.assertLess((out - ref).abs().max().item(), 1e-4)

    def test_resident_blocks_stay_correct_over_several_steps(self):
        decoder, reference, cfg = self._decoders()
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, resident=2)
        inputs = _inputs(cfg)
        with torch.no_grad():
            for step in range(4):
                kw = dict(inputs, timestep=torch.tensor([1.0 - 0.2 * step]))
                ref = reference(**kw, use_cache=False)[0]
                out = decoder(**kw, use_cache=False)[0]
                self.assertLess((out - ref).abs().max().item(), 1e-4, f"step {step}")
        self.assertEqual(len(pool.resident), 2)

    def test_when_everything_is_resident_there_are_no_slots(self):
        _d, pool, _ref, _out, _i = self._run(6, resident=6)
        self.assertEqual(pool.slots, [])
        self.assertEqual(len(pool.resident), 6)

    def test_resident_blocks_hold_their_own_weights_and_attributes(self):
        _d, pool, _ref, _out, _i = self._run(6, resident=3)
        kinds = {m.__dict__.get("attention_type") for m in pool.resident}
        self.assertTrue(kinds <= {"sliding_attention", "full_attention"})
        for index, module in enumerate(pool.resident):
            for dst, src in zip(module.parameters(), pool.cpu_params[index]):
                self.assertTrue(torch.equal(dst.detach().to(torch.bfloat16), src))
                self.assertFalse(dst.requires_grad)

    @torch.no_grad()
    def test_releasing_and_rebuilding_keeps_the_output(self):
        decoder, pool, _ref, before, inputs = self._run(6, resident=3)
        pool.release_gpu()
        self.assertEqual((pool.resident, pool.slots), ([], []))
        after = decoder(**inputs, use_cache=False)[0]
        self.assertEqual(len(pool.resident), 3)
        self.assertTrue(torch.equal(before, after))

    def test_bfloat16_compute_stays_close_and_comes_back_in_float32(self):
        decoder, reference, cfg = self._decoders()
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, compute_dtype=torch.bfloat16, resident=2)
        inputs = _inputs(cfg)
        with torch.no_grad():
            ref = reference(**inputs, use_cache=False)[0]
            out = decoder(**inputs, use_cache=False)[0]
        self.assertEqual(out.dtype, torch.float32)  # the engine on the processor keeps working in float32
        self.assertTrue(all(p.dtype == torch.bfloat16 for p in pool.slot_params[0]))
        self.assertTrue(all(p.dtype == torch.bfloat16 for p in pool.resident[0].parameters()))
        self.assertTrue(torch.isfinite(out).all())
        rel = ((out - ref).norm() / ref.norm()).item()
        self.assertLess(rel, 0.05)

    def test_narrow_formats_never_turn_a_mask_into_infinity(self):
        mask = torch.tensor([[0.0, float("-inf"), torch.finfo(torch.float32).min]])
        out = sgs._to_device(mask, self.CPU, torch.bfloat16)
        self.assertEqual(out.dtype, torch.bfloat16)
        self.assertTrue(torch.isfinite(out).all())
        wide = sgs._to_device(mask, self.CPU)  # float32: untouched, as before
        self.assertTrue(torch.isinf(wide).any())
        self.assertEqual(sgs._to_cpu(out).dtype, torch.float32)
        ints = torch.tensor([1, 2])
        self.assertEqual(sgs._to_cpu(sgs._to_device(ints, self.CPU, torch.bfloat16)).dtype, torch.int64)

    def test_auto_fills_the_free_memory_minus_the_reserve(self):
        decoder, _cfg = _tiny_decoder(6)
        pool = sgs.install(decoder, self.CPU, torch.bfloat16)
        pool.resident_request = "auto"
        pool.cuda = True  # only to let the sizing run: nothing touches a card in this test
        block, reserve = pool.bytes_on_card, 1000
        pool.reserve_bytes = reserve
        cases = [
            (reserve + 6 * block, 6),             # everything fits: nothing to stream
            (reserve + 5 * block, 3),             # two slots are kept for the others: (5 - 2) blocks
            (reserve + 2 * block, 0),
            (10, 0),                              # less than the reserve
        ]
        for free, expected in cases:
            with self.subTest(free=free):
                pool._free_bytes = lambda free=free: free
                self.assertEqual(pool._resident_target(), expected)
        pool.resident_cap = 2  # lowered by an earlier out-of-memory error
        pool._free_bytes = lambda: reserve + 6 * block
        self.assertEqual(pool._resident_target(), 2)
        pool.cuda = False
        self.assertEqual(pool._resident_target(), 0)  # on the processor, "auto" has nothing to fit

    @staticmethod
    def _fail_once(module):
        original = module.forward
        state = {"failed": 0}

        def forward(*args, **kwargs):
            if state["failed"] == 0:
                state["failed"] = 1
                raise torch.cuda.OutOfMemoryError("CUDA out of memory (simulated)")
            return original(*args, **kwargs)

        module.forward = forward
        return state

    @torch.no_grad()
    def test_out_of_memory_halves_the_resident_blocks_and_retries(self):
        decoder, reference, cfg = self._decoders(6)
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, resident=4)
        inputs = _inputs(cfg)
        state = self._fail_once(pool.resident[1])
        out = decoder(**inputs, use_cache=False)[0]
        ref = reference(**inputs, use_cache=False)[0]
        self.assertEqual(state["failed"], 1)
        self.assertEqual((pool.resident_n, pool.resident_cap, len(pool.resident)), (2, 2, 2))
        self.assertLess((out - ref).abs().max().item(), 1e-4)
        # the lower number is kept for the next generations, even after the card was given back
        pool.release_gpu()
        again = decoder(**inputs, use_cache=False)[0]
        self.assertEqual(pool.resident_n, 2)
        self.assertLess((again - ref).abs().max().item(), 1e-4)

    @torch.no_grad()
    def test_out_of_memory_with_everything_resident_creates_the_slots(self):
        decoder, reference, cfg = self._decoders(6)
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, resident=6)
        self.assertEqual(pool.slots, [])
        inputs = _inputs(cfg)
        self._fail_once(pool.resident[0])
        out = decoder(**inputs, use_cache=False)[0]
        self.assertEqual(pool.resident_n, 3)
        self.assertEqual(len(pool.slots), 2)
        self.assertLess((out - reference(**inputs, use_cache=False)[0]).abs().max().item(), 1e-4)

    @torch.no_grad()
    def test_out_of_memory_without_resident_blocks_is_reported(self):
        decoder, cfg = _tiny_decoder(4)
        decoder.float().eval()
        pool = sgs.install(decoder, self.CPU, torch.bfloat16)
        self._fail_once(pool.slots[0])
        with self.assertRaises(torch.cuda.OutOfMemoryError):
            decoder(**_inputs(cfg), use_cache=False)

    def test_options_are_read_from_the_environment(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(sgs.compute_dtype_from_env(), torch.float32)
            self.assertEqual(sgs.resident_from_env(), 0)
            self.assertEqual(sgs.reserve_bytes_from_env(), int(2.5 * 1024**3))
        env = {sgs.ENV_COMPUTE: "BF16", sgs.ENV_RESIDENT: " Auto ", sgs.ENV_RESERVE: "1.5"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(sgs.compute_dtype_from_env(), torch.bfloat16)
            self.assertEqual(sgs.resident_from_env(), "auto")
            self.assertEqual(sgs.reserve_bytes_from_env(), int(1.5 * 1024**3))
        with mock.patch.dict(os.environ, {sgs.ENV_RESIDENT: "7", sgs.ENV_COMPUTE: "nonsense"}, clear=True):
            self.assertEqual(sgs.resident_from_env(), 7)
            self.assertEqual(sgs.compute_dtype_from_env(), torch.float32)
        with mock.patch.dict(os.environ, {sgs.ENV_RESIDENT: "-3", sgs.ENV_RESERVE: "x"}, clear=True):
            self.assertEqual(sgs.resident_from_env(), 0)
            self.assertEqual(sgs.reserve_bytes_from_env(), int(2.5 * 1024**3))
        with mock.patch.dict(os.environ, {sgs.ENV_RESIDENT: "many"}, clear=True):
            self.assertEqual(sgs.resident_from_env(), 0)


class StatsTests(unittest.TestCase):
    """The per-generation timing line (where the time goes). On the processor only the counts and the plumbing can be checked."""

    CPU = torch.device("cpu")

    def _pool(self, layers=6, **options):
        decoder, cfg = _tiny_decoder(layers)
        decoder.float().eval()
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, **options)
        return decoder, pool, cfg

    @torch.no_grad()
    def test_every_block_run_is_counted_and_weights_are_counted_only_when_streamed(self):
        decoder, pool, cfg = self._pool(6, resident=2)
        for _ in range(3):
            decoder(**_inputs(cfg), use_cache=False)
        summary = pool.stats.summary()
        self.assertEqual(summary["runs"], 6 * 3)
        self.assertGreater(summary["wall_s"], 0)
        self.assertGreater(pool.stats.copy_bytes, 0)
        self.assertEqual(pool.stats.copy_bytes % pool.bytes_per_layer, 0)
        self.assertEqual(pool.stats.resident_bytes, 2 * pool.bytes_per_layer)  # put on the card once, at the start

        decoder, pool, cfg = self._pool(6, resident=6)  # everything resident: nothing is streamed
        decoder(**_inputs(cfg), use_cache=False)
        self.assertEqual(pool.stats.copy_bytes, 0)
        self.assertEqual(pool.stats.runs, 6)

    @torch.no_grad()
    def test_statistics_can_be_switched_off_without_changing_the_output(self):
        decoder, pool, cfg = self._pool(4)
        inputs = _inputs(cfg)
        with_stats = decoder(**inputs, use_cache=False)[0]
        with mock.patch.dict(os.environ, {sgs.ENV_STATS: "0"}):
            decoder2, pool2, _cfg = self._pool(4)
        self.assertFalse(pool2.stats.enabled)
        without = decoder2(**inputs, use_cache=False)[0]
        self.assertEqual(pool2.stats.runs, 0)
        self.assertEqual(pool2.stats.copy_bytes, 0)
        self.assertEqual(pool2.stats.resident_bytes, 0)
        self.assertTrue(torch.equal(with_stats, without))

    @torch.no_grad()
    def test_the_report_is_logged_once_per_generation_then_reset(self):
        decoder, pool, cfg = self._pool(6, resident=2)
        decoder(**_inputs(cfg), use_cache=False)
        previous = sgs._ACTIVE_POOL
        sgs._ACTIVE_POOL = pool
        try:
            with mock.patch.object(sgs.logger, "info") as info:
                sgs.log_stats()
                sgs.log_stats()  # nothing new since: no second line
            self.assertEqual(info.call_count, 1)
            line = info.call_args[0][0]
            for part in ("6 block runs", "GB streamed", "pinned RAM: unknown", "computing", "waiting for weights",
                         "activations: to the card", "resident blocks 2/6"):
                self.assertIn(part, line)
            self.assertEqual(pool.stats.runs, 0)
        finally:
            sgs._ACTIVE_POOL = previous

    def test_format_marks_unpinned_memory(self):
        summary = StatsSummaryFixture.make()
        text = sgs.format_stats(summary, "NO (3/10 tensors)", 4, 32)
        self.assertIn("pinned RAM: NO (3/10 tensors)", text)
        self.assertIn("resident blocks 4/32", text)
        self.assertIn("4.1 GB/s", text)

    def test_nothing_is_logged_without_a_pool_or_without_runs(self):
        previous = sgs._ACTIVE_POOL
        sgs._ACTIVE_POOL = None
        try:
            with mock.patch.object(sgs.logger, "info") as info:
                sgs.log_stats()
            info.assert_not_called()
        finally:
            sgs._ACTIVE_POOL = previous


class StatsSummaryFixture:
    @staticmethod
    def make():
        return {"runs": 256, "wall_s": 7.1, "copy_gb": 3.9, "copy_s": 0.95, "copy_gbps": 4.1, "compute_s": 2.3, "stall_s": 3.1,
                "to_card_s": 0.4, "from_card_s": 0.5, "resident_gb": 3.8, "resident_s": 0.8}


class ConditionEncoderTests(unittest.TestCase):
    @staticmethod
    def _count_calls(model):
        calls = {"tokenizer": 0, "detokenizer": 0}

        def bump(name):
            def hook(_m, _a, _o):
                calls[name] += 1
            return hook

        model.tokenizer.register_forward_hook(bump("tokenizer"))
        model.detokenizer.register_forward_hook(bump("detokenizer"))
        return calls

    @torch.no_grad()
    def test_skipping_tokenizer_gives_the_same_result_when_not_a_cover(self):
        model, cfg = _tiny_condition_model()
        reference = copy.deepcopy(model)
        sgs.wrap_prepare_condition(model)
        calls = self._count_calls(model)
        inputs = _condition_inputs(cfg, cover=False)
        want = reference.prepare_condition(**inputs)
        got = model.prepare_condition(**inputs)
        for a, b in zip(want, got):
            self.assertTrue(torch.equal(a, b))
        self.assertEqual(calls, {"tokenizer": 0, "detokenizer": 0})
        # the real methods are visible again afterwards
        self.assertNotIn("tokenize", model.__dict__)
        self.assertNotIn("detokenize", model.__dict__)

    @torch.no_grad()
    def test_cover_still_goes_through_tokenizer_and_detokenizer(self):
        model, cfg = _tiny_condition_model()
        reference = copy.deepcopy(model)
        sgs.wrap_prepare_condition(model)
        calls = self._count_calls(model)
        inputs = _condition_inputs(cfg, cover=True)
        want = reference.prepare_condition(**inputs)
        got = model.prepare_condition(**inputs)
        for a, b in zip(want, got):
            self.assertTrue(torch.equal(a, b))
        self.assertEqual(calls, {"tokenizer": 1, "detokenizer": 1})

    @torch.no_grad()
    def test_precomputed_hints_and_audio_codes_are_never_skipped(self):
        self.assertFalse(sgs._is_plain_generation(torch.tensor([0]), torch.zeros(1), None))
        self.assertFalse(sgs._is_plain_generation(torch.tensor([0]), None, torch.zeros(1)))
        self.assertFalse(sgs._is_plain_generation(torch.tensor([0, 1]), None, None))
        self.assertFalse(sgs._is_plain_generation(None, None, None))
        self.assertTrue(sgs._is_plain_generation(torch.tensor([0, 0]), None, None))

    @torch.no_grad()
    def test_streamed_encoder_matches_the_plain_encoder(self):
        model, cfg = _tiny_condition_model()
        model.to(torch.bfloat16).float()  # bfloat16-exact weights everywhere, like a bfloat16 checkpoint
        reference = copy.deepcopy(model)
        pool = sgs.install_encoder(model, torch.device("cpu"), torch.bfloat16)
        self.assertEqual(pool.count, 3 + 2 + 2 + 2)
        for cover in (False, True):
            inputs = _condition_inputs(cfg, cover=cover)
            want = reference.prepare_condition(**inputs)
            got = model.prepare_condition(**inputs)
            for a, b in zip(want, got):
                self.assertLess((a.float() - b.float()).abs().max().item(), 1e-4)

    def test_encoder_proxies_have_global_indices_and_no_weights(self):
        model, _cfg = _tiny_condition_model()
        sgs.install_encoder(model, torch.device("cpu"), torch.bfloat16)
        holders = [model.encoder.lyric_encoder, model.encoder.timbre_encoder, model.tokenizer.attention_pooler, model.detokenizer]
        indices = [layer._s_index for holder in holders for layer in holder.layers]
        self.assertEqual(indices, list(range(9)))
        self.assertEqual(sum(1 for holder in holders for _ in holder.layers.parameters()), 0)

    @torch.no_grad()
    def test_encoder_slots_are_given_back_after_prepare_condition(self):
        model, cfg = _tiny_condition_model()
        pool = sgs.install_encoder(model, torch.device("cpu"), torch.bfloat16)
        sgs.wrap_prepare_condition(model)
        with mock.patch.object(sgs, "_ENCODER_POOL", pool):
            model.prepare_condition(**_condition_inputs(cfg))
            self.assertEqual(pool.slots, [])
            model.prepare_condition(**_condition_inputs(cfg))  # recreated on demand
            self.assertEqual(pool.slots, [])

    def test_missing_encoder_parts_do_not_break_the_attachment(self):
        self.assertFalse(sgs.attach_encoder(nn.Linear(1, 1), torch.device("cpu"), torch.bfloat16))
        self.assertIsNone(sgs._ENCODER_POOL)

    def test_release_gpu_frees_both_pools(self):
        dit, enc = mock.Mock(), mock.Mock()
        with mock.patch.object(sgs, "_ACTIVE_POOL", dit), mock.patch.object(sgs, "_ENCODER_POOL", enc):
            sgs.release_gpu()
        dit.release_gpu.assert_called_once()
        enc.release_gpu.assert_called_once()


class ConditionCacheTests(unittest.TestCase):
    """Identical passes of the condition encoder inside one generation are computed once."""

    def setUp(self):
        sgs.clear_condition_cache()
        self.addCleanup(sgs.clear_condition_cache)

    def _model(self):
        model, cfg = _tiny_condition_model()
        reference = copy.deepcopy(model)
        runs = {"n": 0}

        def count(_m, _a, _o):
            runs["n"] += 1

        model.encoder.register_forward_hook(count)
        sgs.wrap_prepare_condition(model)
        return model, reference, cfg, runs

    @torch.no_grad()
    def test_a_second_identical_call_is_not_computed_again(self):
        model, reference, cfg, runs = self._model()
        inputs = _condition_inputs(cfg)
        want = reference.prepare_condition(**inputs)
        first = model.prepare_condition(**inputs)
        second = model.prepare_condition(**inputs)
        self.assertEqual(runs["n"], 1)
        for a, b, c in zip(want, first, second):
            self.assertTrue(torch.equal(a, b))
            self.assertTrue(torch.equal(a, c))

    @torch.no_grad()
    def test_none_passed_explicitly_or_left_out_is_the_same_call(self):
        model, _reference, cfg, runs = self._model()
        inputs = _condition_inputs(cfg)
        model.prepare_condition(**inputs)  # like the engine's first pass: optional arguments left out
        model.prepare_condition(**inputs, precomputed_lm_hints_25Hz=None, audio_codes=None)  # like generate_audio
        self.assertEqual(runs["n"], 1)

    @torch.no_grad()
    def test_the_reused_result_is_a_copy(self):
        model, reference, cfg, runs = self._model()
        inputs = _condition_inputs(cfg)
        want = reference.prepare_condition(**inputs)
        first = model.prepare_condition(**inputs)
        second = model.prepare_condition(**inputs)
        for tensor in list(second) + list(first):
            tensor.zero_()  # a consumer changing its tensors in place must not reach the saved result
        third = model.prepare_condition(**inputs)
        self.assertEqual(runs["n"], 1)
        for a, b in zip(want, third):
            self.assertTrue(torch.equal(a, b))

    @torch.no_grad()
    def test_changing_the_inputs_afterwards_does_not_reach_the_saved_call(self):
        model, reference, cfg, runs = self._model()
        inputs = _condition_inputs(cfg)
        want = reference.prepare_condition(**inputs)
        model.prepare_condition(**inputs)
        inputs["lyric_hidden_states"].add_(1.0)  # the caller reuses and changes its tensor
        got = model.prepare_condition(**inputs)
        self.assertEqual(runs["n"], 2)
        changed = reference.prepare_condition(**inputs)
        self.assertFalse(torch.equal(want[0], changed[0]))
        for a, b in zip(changed, got):
            self.assertTrue(torch.equal(a, b))

    @torch.no_grad()
    def test_a_single_different_value_is_a_new_computation(self):
        model, reference, cfg, runs = self._model()
        inputs = _condition_inputs(cfg)
        model.prepare_condition(**inputs)
        other = dict(inputs, text_hidden_states=inputs["text_hidden_states"].clone())
        other["text_hidden_states"][0, 0, 0] += 1e-3
        got = model.prepare_condition(**other)
        self.assertEqual(runs["n"], 2)
        for a, b in zip(reference.prepare_condition(**other), got):
            self.assertTrue(torch.equal(a, b))

    @torch.no_grad()
    def test_another_dtype_or_a_cover_flag_is_a_new_computation(self):
        model, _reference, cfg, runs = self._model()
        inputs = _condition_inputs(cfg)
        model.prepare_condition(**inputs)
        model.prepare_condition(**dict(inputs, is_covers=torch.tensor([1])))
        self.assertEqual(runs["n"], 2)
        different = dict(inputs, text_attention_mask=inputs["text_attention_mask"].to(torch.int32))
        model.prepare_condition(**different)
        self.assertEqual(runs["n"], 3)

    @torch.no_grad()
    def test_the_end_of_a_generation_clears_the_saved_results(self):
        model, _reference, cfg, runs = self._model()
        inputs = _condition_inputs(cfg)
        model.prepare_condition(**inputs)
        with mock.patch.object(sgs, "_ACTIVE_POOL", None), mock.patch.object(sgs, "_ENCODER_POOL", None):
            sgs.release_gpu()
        model.prepare_condition(**inputs)
        self.assertEqual(runs["n"], 2)

    @torch.no_grad()
    def test_it_can_be_switched_off(self):
        model, _reference, cfg, runs = self._model()
        inputs = _condition_inputs(cfg)
        with mock.patch.dict(os.environ, {sgs.ENV_CONDITION_CACHE: "off"}):
            model.prepare_condition(**inputs)
            model.prepare_condition(**inputs)
        self.assertEqual(runs["n"], 2)
        self.assertEqual(sgs._CONDITION_CACHE, [])

    @torch.no_grad()
    def test_only_the_last_few_distinct_calls_are_kept(self):
        model, _reference, cfg, runs = self._model()
        base = _condition_inputs(cfg)
        variants = [dict(base, chunk_masks=base["chunk_masks"] * (i + 2)) for i in range(sgs._CONDITION_CACHE_LIMIT + 1)]
        for v in variants:
            model.prepare_condition(**v)
        self.assertEqual(len(sgs._CONDITION_CACHE), sgs._CONDITION_CACHE_LIMIT)
        model.prepare_condition(**variants[-1])  # still saved
        self.assertEqual(runs["n"], len(variants))
        model.prepare_condition(**variants[0])  # dropped: computed again
        self.assertEqual(runs["n"], len(variants) + 1)

    @torch.no_grad()
    def test_a_failing_call_saves_nothing(self):
        model, _reference, cfg, runs = self._model()
        inputs = _condition_inputs(cfg)
        bad = dict(inputs, text_hidden_states=torch.zeros(1, 6, cfg.text_hidden_dim + 1))
        with self.assertRaises(Exception):
            model.prepare_condition(**bad)
        self.assertEqual(sgs._CONDITION_CACHE, [])
        model.prepare_condition(**inputs)
        self.assertEqual(len(sgs._CONDITION_CACHE), 1)

    def test_calls_without_any_tensor_are_not_saved(self):
        model = types.SimpleNamespace(prepare_condition=mock.Mock(return_value="done"))
        sgs.wrap_prepare_condition(model)
        self.assertEqual(model.prepare_condition(), "done")
        self.assertEqual(model.prepare_condition(), "done")
        self.assertEqual(sgs._CONDITION_CACHE, [])

    def test_same_value_rules(self):
        t = torch.ones(2)
        self.assertTrue(sgs._same_value(t, t.clone()))
        self.assertFalse(sgs._same_value(t, t.double()))
        self.assertFalse(sgs._same_value(t, torch.ones(3)))
        self.assertFalse(sgs._same_value(t, None))
        self.assertTrue(sgs._same_value(None, None))
        self.assertFalse(sgs._same_value(1, 1.0))
        self.assertFalse(sgs._same_value(True, 1))
        self.assertTrue(sgs._same_value([t, 2], (t.clone(), 2)) is False)  # list vs tuple differ
        self.assertTrue(sgs._same_value([t, 2], [t.clone(), 2]))
        self.assertFalse(sgs._same_value(torch.tensor([float("nan")]), torch.tensor([float("nan")])))


class AutoReserveTests(unittest.TestCase):
    """The reserve for the activations follows what the previous generations measured."""

    GB = 1024**3

    def _pool(self, request="auto", reserve=int(1.5 * 1024**3), resident=0):
        decoder, _cfg = _tiny_decoder(6)
        pool = sgs.install(decoder, torch.device("cpu"), torch.bfloat16, reserve_bytes=reserve, resident=resident)
        pool.resident_request = request
        pool.cuda = True  # only to let the sizing run: nothing touches a card in these tests
        pool.mask_free = True
        pool.reserve_auto = True
        return decoder, pool

    def _measure(self, pool, tokens, base, peak):
        pool.act_tokens, pool._act_base, pool._act_ran, pool._act_hurt = tokens, base, True, False
        with mock.patch.object(pool, "_peak_bytes", return_value=peak):
            pool._record_activations()

    def test_without_a_measurement_the_configured_reserve_is_used(self):
        _d, pool = self._pool()
        self.assertEqual(pool.reserve_for(363), (pool.reserve_bytes, None))
        self.assertEqual(pool.reserve_for(None), (pool.reserve_bytes, None))

    def test_a_measurement_sets_the_reserve_to_need_plus_a_quarter_and_the_margin(self):
        _d, pool = self._pool()
        self._measure(pool, 2000, 5 * self.GB, int(5.8 * self.GB))
        need = pool.act_needs[2000]
        self.assertAlmostEqual(need / self.GB, 0.8, places=2)
        reserve, got = pool.reserve_for(2000)
        self.assertEqual(got, need)
        self.assertEqual(reserve, int(need * sgs.ACT_SAFETY) + sgs.ACT_MARGIN_BYTES)

    def test_the_reserve_never_goes_below_the_minimum(self):
        _d, pool = self._pool()
        self._measure(pool, 400, 5 * self.GB, 5 * self.GB + 1000)
        self.assertEqual(pool.reserve_for(400)[0], sgs.ACT_MIN_RESERVE_BYTES)

    def test_a_shorter_round_uses_the_smallest_longer_measurement(self):
        _d, pool = self._pool()
        self._measure(pool, 2000, 0, int(0.8 * self.GB))
        self._measure(pool, 800, 0, int(0.3 * self.GB))
        self.assertEqual(pool.reserve_for(600)[1], pool.act_needs[800])
        self.assertEqual(pool.reserve_for(800)[1], pool.act_needs[800])
        self.assertEqual(pool.reserve_for(801)[1], pool.act_needs[2000])
        self.assertEqual(pool.reserve_for(2000)[1], pool.act_needs[2000])

    def test_a_longer_round_scales_the_longest_measurement_with_a_safety(self):
        _d, pool = self._pool()
        self._measure(pool, 1000, 0, int(0.4 * self.GB))
        need = pool.act_needs[1000]
        self.assertEqual(pool.reserve_for(3000)[1], int(need * 3 * sgs.ACT_SAFETY))
        pool.mask_free = False  # masks make the attention grow with the square of the length
        self.assertEqual(pool.reserve_for(3000)[1], int(need * 9 * sgs.ACT_SAFETY))

    def test_nothing_is_measured_unless_a_block_ran_cleanly_with_a_known_length(self):
        _d, pool = self._pool()
        pool.act_tokens, pool._act_base = 500, 0
        with mock.patch.object(pool, "_peak_bytes", return_value=100):
            pool._act_ran, pool._act_hurt = False, False
            pool._record_activations()
            pool._act_ran, pool._act_hurt = True, True   # ran out of memory in that round
            pool._record_activations()
            pool._act_hurt, pool.act_tokens = False, None
            pool._record_activations()
            pool.act_tokens, pool._act_base = 500, None
            pool._record_activations()
        self.assertEqual(pool.act_needs, {})

    def test_only_the_automatic_resident_mode_measures_and_it_can_be_switched_off(self):
        _d, pool = self._pool(request=3)
        self._measure(pool, 500, 0, 100)
        self.assertEqual(pool.act_needs, {})
        _d, pool = self._pool()
        pool.reserve_auto = False
        self._measure(pool, 500, 0, 100)
        self.assertEqual(pool.act_needs, {})
        with mock.patch.dict(os.environ, {sgs.ENV_RESERVE_AUTO: "off"}):
            self.assertFalse(sgs.reserve_auto_from_env())
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(sgs.ENV_RESERVE_AUTO, None)
            self.assertTrue(sgs.reserve_auto_from_env())

    def test_the_latest_larger_measure_wins_and_only_a_few_are_kept(self):
        _d, pool = self._pool()
        self._measure(pool, 500, 0, 300)
        self._measure(pool, 500, 0, 200)   # same length, smaller: the larger need stays
        self.assertEqual(pool.act_needs[500], 300)
        for tokens in range(1000, 1000 + 10 * sgs.ACT_MEASURES_KEPT, 10):
            self._measure(pool, tokens, 0, tokens)
        self.assertEqual(len(pool.act_needs), sgs.ACT_MEASURES_KEPT)
        self.assertNotIn(500, pool.act_needs)

    def test_more_blocks_stay_on_the_card_once_the_need_is_known(self):
        _d, pool = self._pool()
        block = pool.bytes_on_card
        pool.reserve_bytes = 20 * block
        free = pool.reserve_bytes + 4 * block   # two slots and two resident blocks
        with mock.patch.object(sgs, "ACT_MIN_RESERVE_BYTES", 10), mock.patch.object(sgs, "ACT_MARGIN_BYTES", 10), \
                mock.patch.object(pool, "_free_bytes", return_value=free):
            pool.act_tokens = 500
            before = pool._resident_target()
            self._measure(pool, 500, 0, block // 4)
            after = pool._resident_target()
        self.assertEqual(before, 2)
        self.assertEqual(after, pool.count)

    def test_the_length_comes_from_the_first_call_of_a_round(self):
        decoder, pool = self._pool(request=2)
        pool.cuda = False
        pool._gpu_ready = False              # the start of a round: the blocks are not on the card yet
        pool.observe((torch.zeros(2, 7, 4),), {})
        self.assertEqual(pool.act_tokens, 14)
        pool.observe((), {"hidden_states": torch.zeros(1, 9, 4)})
        self.assertEqual(pool.act_tokens, 9)
        pool.observe((torch.zeros(3),), {})  # not activations: unchanged
        self.assertEqual(pool.act_tokens, 9)
        pool._gpu_ready = True               # blocks already placed: this is not the start of a round
        pool.observe((torch.zeros(1, 50, 4),), {})
        self.assertEqual(pool.act_tokens, 9)

    @torch.no_grad()
    def test_a_real_run_records_the_length_and_that_a_block_ran(self):
        decoder, cfg = _tiny_decoder(4)
        decoder.float().eval()
        pool = sgs.install(decoder, torch.device("cpu"), torch.bfloat16, resident=1)
        pool.release_gpu()  # like attach_if_enabled: the blocks are placed when the first block runs
        inputs = _inputs(cfg)
        decoder(**inputs, use_cache=False)
        self.assertEqual(pool.act_tokens, inputs["hidden_states"].shape[1] // cfg.patch_size)  # the blocks see patches, not frames
        self.assertTrue(pool._act_ran)

    def test_running_out_of_memory_with_a_measured_reserve_brings_back_the_configured_one(self):
        _d, pool = self._pool()
        pool.cuda = False
        pool._gpu_ready, pool._act_trusted, pool._act_hurt = True, True, True
        pool.act_needs = {500: 123}
        pool.resident_cap = 3
        pool.release_gpu()
        self.assertFalse(pool.reserve_auto)
        self.assertEqual(pool.act_needs, {})
        self.assertEqual(pool.resident_cap, pool.count)
        self.assertEqual(pool.reserve_for(500), (pool.reserve_bytes, None))

    def test_running_out_of_memory_with_the_configured_reserve_keeps_the_halved_number(self):
        _d, pool = self._pool()
        pool.cuda = False
        pool._gpu_ready, pool._act_trusted, pool._act_hurt = True, False, True
        pool.resident_cap = 3
        pool.release_gpu()
        self.assertTrue(pool.reserve_auto)
        self.assertEqual(pool.resident_cap, 3)

    def test_shrinking_marks_the_round_as_hurt(self):
        _d, pool = self._pool(request=4, resident=4)
        pool.cuda = False
        self.assertEqual(pool.resident_n, 4)
        self.assertFalse(pool._act_hurt)
        with mock.patch.object(sgs, "log_memory"):
            self.assertTrue(pool.shrink_resident())
        self.assertTrue(pool._act_hurt)


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


class _FakeVae:
    """Pointwise "decoder" (each latent frame becomes 4 samples) that runs out of memory above ``max_frames``."""

    def __init__(self, max_frames=10 ** 9):
        self.max_frames = max_frames
        self.calls = []

    def decode(self, x):
        self.calls.append(x.shape[-1])
        if x.shape[-1] > self.max_frames:
            raise torch.cuda.OutOfMemoryError("fake")
        return types.SimpleNamespace(sample=x[:, :2].repeat_interleave(4, dim=-1))


def _vae_host(vae):
    from acestep.core.generation.handler.vae_decode import VaeDecodeMixin
    from acestep.core.generation.handler.vae_decode_chunks import VaeDecodeChunksMixin

    class Host(VaeDecodeChunksMixin, VaeDecodeMixin):
        disable_tqdm = True

        def _empty_cache(self):
            pass

    host = Host()
    host.vae = vae
    return host


class VaeTileLadderTests(unittest.TestCase):
    MB = 1024 * 1024

    def test_a_small_card_keeps_the_small_tiles(self):
        self.assertEqual(sgs.vae_chunk_ladder(1200 * self.MB), [sgs.DEFAULT_VAE_CHUNK])
        self.assertEqual(sgs.vae_chunk_ladder(0), [sgs.DEFAULT_VAE_CHUNK])

    def test_a_big_free_memory_gives_the_biggest_tiles_then_halves(self):
        self.assertEqual(sgs.vae_chunk_ladder(5000 * self.MB), [256, 128, 96])

    def test_the_size_follows_the_free_memory(self):
        # 2000 MB * 0.6 / 11 MB = 109 frames
        self.assertEqual(sgs.vae_chunk_ladder(2000 * self.MB), [109, 96])

    def test_an_explicit_size_is_used_as_given(self):
        self.assertEqual(sgs.vae_chunk_ladder(5000 * self.MB, 64), [64])
        self.assertEqual(sgs.vae_chunk_ladder(100 * self.MB, 400), [400, 200, 100, 96])
        self.assertEqual(sgs.vae_chunk_ladder(100 * self.MB, 2), [24])

    def test_explicit_size_from_the_environment(self):
        with mock.patch.dict(os.environ, {sgs.ENV_VAE_CHUNK: "160"}):
            self.assertEqual(sgs.vae_chunk_explicit(), 160)
        with mock.patch.dict(os.environ, {sgs.ENV_VAE_CHUNK: ""}):
            self.assertIsNone(sgs.vae_chunk_explicit())
        with mock.patch.dict(os.environ, {sgs.ENV_VAE_CHUNK: "abc"}):
            self.assertIsNone(sgs.vae_chunk_explicit())
        env = {k: v for k, v in os.environ.items() if k != sgs.ENV_VAE_CHUNK}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertIsNone(sgs.vae_chunk_explicit())


class VaeDecodeLadderTests(unittest.TestCase):
    def _latents(self, batch=1, frames=1000):
        return torch.randn(batch, 64, frames)

    def test_any_tile_size_gives_the_same_audio(self):
        lat = self._latents()
        whole = lat[:, :2].repeat_interleave(4, dim=-1)
        for ladder in ([96], [256, 128, 96], [400], [1000], [2000]):
            host = _vae_host(_FakeVae())
            out, used = sgs.decode_with_ladder(host, lat, ladder)
            self.assertEqual(used, ladder[0])
            self.assertEqual(out.shape, whole.shape)
            self.assertTrue(torch.equal(out, whole), ladder)

    def test_a_lack_of_memory_retries_with_smaller_tiles(self):
        lat = self._latents()
        vae = _FakeVae(max_frames=200)  # 256 frames + overlap does not fit, 128 + overlap does
        cleared = []
        out, used = sgs.decode_with_ladder(_vae_host(vae), lat, [256, 128, 96], clear=lambda: cleared.append(1))
        self.assertEqual(used, 128)
        self.assertEqual(len(cleared), 1)
        self.assertTrue(torch.equal(out, lat[:, :2].repeat_interleave(4, dim=-1)))

    def test_when_every_tile_size_fails_the_engines_fallback_takes_over(self):
        lat = self._latents(frames=300)
        host = _vae_host(_FakeVae(max_frames=10))
        sentinel = torch.ones(1, 2, 8)
        with mock.patch.object(type(host), "_tiled_decode_inner", return_value=sentinel) as inner:
            out, used = sgs.decode_with_ladder(host, lat, [128, 96])
        inner.assert_called_once()
        self.assertEqual(used, 96)
        self.assertTrue(torch.equal(out, sentinel))

    def test_a_batch_is_decoded_sample_by_sample(self):
        lat = self._latents(batch=2, frames=500)
        out, _used = sgs.decode_with_ladder(_vae_host(_FakeVae()), lat, [256, 128, 96])
        self.assertEqual(tuple(out.shape), (2, 2, 2000))
        self.assertTrue(torch.equal(out, lat[:, :2].repeat_interleave(4, dim=-1)))

    def test_a_track_that_fits_one_tile_is_decoded_in_one_go(self):
        vae = _FakeVae()
        out, used = sgs.decode_with_ladder(_vae_host(vae), self._latents(frames=200), [256, 128, 96])
        self.assertEqual(vae.calls, [200])
        self.assertEqual(used, 256)


class OffloadContextInStreamModeTests(unittest.TestCase):
    """In stream mode the engine's model contexts move nothing, so their memory trims are skipped (one is kept)."""

    def _host(self):
        from acestep.core.generation.handler.init_service_offload_context import InitServiceOffloadContextMixin

        class Host(InitServiceOffloadContextMixin):
            offload_to_cpu = True
            offload_dit_to_cpu = True
            device = "cpu"
            dtype = torch.float32
            current_offload_cost = 0.0

            def __init__(self):
                self.model, self.vae, self.text_encoder = nn.Linear(2, 2), nn.Linear(2, 2), nn.Linear(2, 2)
                self.trims = 0
                self.moves = 0

            def _get_rss_mb(self):
                return 1.0

            def _get_vae_dtype(self, device=None):
                return torch.float32

            def _recursive_to_device(self, *args, **kwargs):
                self.moves += 1

            def _release_system_memory(self):
                self.trims += 1

        return Host()

    def test_regular_mode_still_trims_after_every_move(self):
        host = self._host()
        with mock.patch.object(sgs, "_ACTIVE_POOL", None):
            for name in ("vae", "text_encoder", "model", "vae"):
                with host._load_model_context(name):
                    pass
        self.assertEqual(host.trims, 8)
        self.assertEqual(host.moves, 8)

    def test_stream_mode_moves_nothing_and_trims_once_after_the_dit(self):
        host = self._host()
        with mock.patch.object(sgs, "_ACTIVE_POOL", mock.Mock()):
            for name in ("vae", "text_encoder", "model", "vae"):
                with host._load_model_context(name):
                    pass
        self.assertEqual(host.moves, 0)
        self.assertEqual(host.trims, 1)

    def test_stream_mode_still_trims_when_the_dit_fails(self):
        host = self._host()
        with mock.patch.object(sgs, "_ACTIVE_POOL", mock.Mock()):
            with self.assertRaises(RuntimeError):
                with host._load_model_context("model"):
                    raise RuntimeError("boom")
        self.assertEqual(host.trims, 1)


class NoiseParityTests(unittest.TestCase):
    """The starting noise is drawn the way the regular card mode draws it, so a seed gives the same track in both modes."""

    CTX_SHAPE = (2, 20, 128)

    def _model(self):
        model, _cfg = _tiny_condition_model()
        return model

    def test_the_draw_is_made_in_the_card_format_then_converted(self):
        model = self._model()
        context = torch.zeros(self.CTX_SHAPE)
        plain = model.prepare_noise(context, 123)  # what the processor-side engine drew until now
        expected = model.prepare_noise(torch.empty(self.CTX_SHAPE, dtype=torch.bfloat16), 123).to(torch.float32)
        self.assertTrue(sgs.wrap_prepare_noise(model, torch.device("cpu"), torch.bfloat16))
        noise = model.prepare_noise(context, 123)
        self.assertEqual(noise.dtype, torch.float32)
        self.assertEqual(noise.device.type, "cpu")
        self.assertEqual(tuple(noise.shape), (2, 20, 64))
        self.assertTrue(torch.equal(noise, expected))
        self.assertFalse(torch.equal(noise, plain))

    def test_seeds_lists_and_no_seed_keep_their_meaning(self):
        model = self._model()
        sgs.wrap_prepare_noise(model, torch.device("cpu"), torch.bfloat16)
        context = torch.zeros(self.CTX_SHAPE)
        self.assertTrue(torch.equal(model.prepare_noise(context, 7), model.prepare_noise(context, 7)))
        self.assertFalse(torch.equal(model.prepare_noise(context, 7), model.prepare_noise(context, 8)))
        listed = model.prepare_noise(context, [7, 8])
        self.assertTrue(torch.equal(listed[0], model.prepare_noise(torch.zeros(1, 20, 128), 7)[0]))
        self.assertFalse(torch.equal(listed[0], listed[1]))
        self.assertEqual(tuple(model.prepare_noise(context, None).shape), (2, 20, 64))

    def test_it_is_wrapped_only_once_and_a_model_without_the_function_is_left_alone(self):
        model = self._model()
        self.assertTrue(sgs.wrap_prepare_noise(model, torch.device("cpu"), torch.bfloat16))
        self.assertFalse(sgs.wrap_prepare_noise(model, torch.device("cpu"), torch.bfloat16))
        self.assertFalse(sgs.wrap_prepare_noise(nn.Linear(1, 1), torch.device("cpu")))

    def test_the_old_draw_can_be_brought_back_and_the_format_follows_the_card(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(sgs.ENV_NOISE, None)
            self.assertTrue(sgs.noise_on_card_from_env())
        with mock.patch.dict(os.environ, {sgs.ENV_NOISE: "cpu"}):
            self.assertFalse(sgs.noise_on_card_from_env())
        with mock.patch("acestep.gpu_config.cuda_supports_bfloat16", return_value=False):
            self.assertEqual(sgs.regular_card_dtype(), torch.float16)
        with mock.patch("acestep.gpu_config.cuda_supports_bfloat16", return_value=True):
            self.assertEqual(sgs.regular_card_dtype(), torch.bfloat16)


class SelfCheckTests(unittest.TestCase):
    """ACESTEP_STREAM_CHECK: each block run on the card is compared with the same block run on the processor."""

    CPU = torch.device("cpu")

    def _pool(self, layers=6, compute=torch.float32, **options):
        decoder, cfg = _tiny_decoder(layers)
        decoder.float().eval()
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, compute_dtype=compute, **options)
        pool.check = sgs.SelfCheck("DiT", pool.count, compute)
        return decoder, pool, cfg

    @torch.no_grad()
    def test_a_correct_streaming_matches_the_processor_in_float32(self):
        decoder, pool, cfg = self._pool(6, resident=2)
        decoder(**_inputs(cfg), use_cache=False)
        self.assertEqual(sorted(pool.check.errors), list(range(6)))
        self.assertLess(max(rel for rel, _m in pool.check.errors.values()), 1e-5)
        with mock.patch.object(sgs.logger, "info") as info, mock.patch.object(sgs.logger, "warning") as warn:
            pool.check.report()
        warn.assert_not_called()
        self.assertIn("-> OK", info.call_args_list[0][0][0])
        self.assertIn("6 of 6 blocks", info.call_args_list[0][0][0])

    @torch.no_grad()
    def test_the_check_works_with_the_cross_attention_cache_of_the_real_pipeline(self):
        from transformers.cache_utils import DynamicCache, EncoderDecoderCache

        decoder, pool, cfg = self._pool(4)
        out = decoder(**_inputs(cfg), use_cache=True, past_key_values=EncoderDecoderCache(DynamicCache(), DynamicCache()))
        self.assertTrue(torch.isfinite(out[0]).all())
        self.assertEqual(len(pool.check.errors), 4)
        self.assertLess(max(rel for rel, _m in pool.check.errors.values()), 1e-5)

    @torch.no_grad()
    def test_bfloat16_compute_stays_inside_its_limit(self):
        decoder, pool, cfg = self._pool(6, compute=torch.bfloat16, resident=3)
        decoder(**_inputs(cfg), use_cache=False)
        worst = max(rel for rel, _m in pool.check.errors.values())
        self.assertGreater(worst, 1e-5)  # the format's rounding is really measured
        self.assertLess(worst, pool.check.limit)

    @torch.no_grad()
    def test_a_block_corrupted_on_the_card_is_reported_as_suspect(self):
        decoder, pool, cfg = self._pool(6, resident=1)
        original = sgs.StreamPool._load

        def corrupting(self_, layer_idx, slot_idx):
            original(self_, layer_idx, slot_idx)
            if layer_idx == 3:
                self_.slot_params[slot_idx][0].add_(2.0)  # the weights that arrive on the card are wrong

        with mock.patch.object(sgs.StreamPool, "_load", corrupting):
            decoder(**_inputs(cfg), use_cache=False)
        rels = {i: rel for i, (rel, _m) in pool.check.errors.items()}
        self.assertGreater(rels[3], pool.check.limit)
        with mock.patch.object(sgs.logger, "info"), mock.patch.object(sgs.logger, "warning") as warn:
            pool.check.report()
        self.assertIn("SUSPECT", warn.call_args[0][0])
        self.assertIn("block 3", warn.call_args[0][0])

    @torch.no_grad()
    def test_each_block_is_checked_once_and_the_report_is_given_once(self):
        decoder, pool, cfg = self._pool(4)
        decoder(**_inputs(cfg), use_cache=False)
        first = dict(pool.check.errors)
        decoder(**_inputs(cfg), use_cache=False)
        self.assertEqual(first, pool.check.errors)
        with mock.patch.object(sgs.logger, "info") as info:
            pool.check.report()
            pool.check.report()
        self.assertEqual(info.call_count, 2)  # the summary and the per-block figures, once
        self.assertFalse(pool.check.wants(0))

    @torch.no_grad()
    def test_a_failing_reference_never_breaks_the_generation(self):
        decoder, pool, cfg = self._pool(4)
        plain = decoder(**_inputs(cfg), use_cache=False)[0]
        pool.check = sgs.SelfCheck("DiT", pool.count, torch.float32)
        with mock.patch.object(sgs.copy, "deepcopy", side_effect=RuntimeError("no memory")), \
                mock.patch.object(sgs.logger, "warning") as warn:
            out = decoder(**_inputs(cfg), use_cache=False)[0]
        self.assertTrue(torch.equal(out, plain))
        self.assertTrue(pool.check.done)
        self.assertEqual(warn.call_count, 1)

    @torch.no_grad()
    def test_the_check_is_off_unless_asked_and_does_not_change_the_output(self):
        decoder, pool, cfg = self._pool(4)
        with_check = decoder(**_inputs(cfg), use_cache=False)[0]
        pool.check = None
        without = decoder(**_inputs(cfg), use_cache=False)[0]
        self.assertTrue(torch.equal(with_check, without))
        self.assertIsNone(pool.check)

    def test_the_module_level_report_covers_both_pools(self):
        dit, enc = mock.Mock(), mock.Mock()
        with mock.patch.object(sgs, "_ACTIVE_POOL", dit), mock.patch.object(sgs, "_ENCODER_POOL", enc):
            sgs.report_checks()
        enc.check.report.assert_called_once()
        dit.check.report.assert_called_once()


class ActivationsOnCardTests(unittest.TestCase):
    """Activations pass from block to block without going back to the processor; shared inputs are sent once per step.

    On the processor the "card" is the processor too, so what is checked here is the format each block hands over, how many
    conversions are made, and that the result never changes; the transfers themselves are measured on a real card."""

    CPU = torch.device("cpu")

    def _decoders(self, layers=6):
        decoder, cfg = _tiny_decoder(layers)
        decoder.float().eval()
        reference = copy.deepcopy(decoder).eval()
        reference.to(torch.bfloat16).float()
        return decoder, reference, cfg

    @staticmethod
    def _conversions():
        """Count the tensors that really had to be converted (a tensor already in the right place and format is not)."""
        counter = {"n": 0}
        original = sgs._move_tensor

        def counting(obj, device, dtype):
            out = original(obj, device, dtype)
            if out is not obj:
                counter["n"] += 1
            return out

        return counter, mock.patch.object(sgs, "_move_tensor", counting)

    @torch.no_grad()
    def test_blocks_hand_over_the_card_format_and_only_the_last_returns_to_the_processor(self):
        decoder, _reference, cfg = self._decoders(6)
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, compute_dtype=torch.bfloat16, resident=2)
        seen = []
        for layer in decoder.layers:
            layer.register_forward_hook(lambda _m, _a, out: seen.append(out[0].dtype))
        decoder(**_inputs(cfg), use_cache=False)
        self.assertTrue(pool.keep_on_card)
        self.assertEqual(seen, [torch.bfloat16] * 5 + [torch.float32])

    @torch.no_grad()
    def test_the_old_round_trip_can_be_brought_back(self):
        with mock.patch.dict(os.environ, {sgs.ENV_ACTIVATIONS: "cpu"}):
            self.assertFalse(sgs.activations_on_card_from_env())
            decoder, _reference, cfg = self._decoders(4)
            pool = sgs.install(decoder, self.CPU, torch.bfloat16, compute_dtype=torch.bfloat16)
        self.assertFalse(pool.keep_on_card)
        seen = []
        for layer in decoder.layers:
            layer.register_forward_hook(lambda _m, _a, out: seen.append(out[0].dtype))
        decoder(**_inputs(cfg), use_cache=False)
        self.assertEqual(seen, [torch.float32] * 4)
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(sgs.ENV_ACTIVATIONS, None)
            self.assertTrue(sgs.activations_on_card_from_env())

    @torch.no_grad()
    def test_the_result_is_exactly_the_one_of_the_round_trip(self):
        for compute in (torch.float32, torch.bfloat16):
            for resident in (0, 2, 6):
                outs = []
                for keep in (True, False):
                    decoder, _reference, cfg = self._decoders(6)
                    sgs.install(decoder, self.CPU, torch.bfloat16, compute_dtype=compute, resident=resident, keep_on_card=keep)
                    outs.append(decoder(**_inputs(cfg), use_cache=False)[0])
                self.assertTrue(torch.equal(outs[0], outs[1]), f"compute {compute}, resident {resident}")

    @torch.no_grad()
    def test_shared_inputs_are_converted_once_per_step_whatever_the_number_of_blocks(self):
        counts = {}
        for layers in (4, 8):
            for keep in (True, False):
                decoder, _reference, cfg = self._decoders(layers)
                sgs.install(decoder, self.CPU, torch.bfloat16, compute_dtype=torch.bfloat16, keep_on_card=keep)
                counter, patch = self._conversions()
                with patch:
                    decoder(**_inputs(cfg), use_cache=False)
                counts[(layers, keep)] = counter["n"]
        self.assertEqual(counts[(4, True)], counts[(8, True)])      # the number of blocks does not matter any more
        self.assertGreater(counts[(8, False)], counts[(4, False)])  # it used to
        self.assertLess(counts[(8, True)], counts[(8, False)])

    @torch.no_grad()
    def test_a_new_step_never_gets_the_previous_steps_inputs(self):
        decoder, reference, cfg = self._decoders(6)
        sgs.install(decoder, self.CPU, torch.bfloat16, resident=2)
        for seed in range(5):  # new tensors are made for every step, some may reuse the address of a freed one
            g = torch.Generator().manual_seed(100 + seed)
            inputs = _inputs(cfg)
            inputs["hidden_states"] = torch.randn(inputs["hidden_states"].shape, generator=g)
            inputs["encoder_hidden_states"] = torch.randn(inputs["encoder_hidden_states"].shape, generator=g)
            inputs["timestep"] = torch.tensor([0.1 + 0.2 * seed])
            want = reference(**inputs, use_cache=False)[0]
            got = decoder(**inputs, use_cache=False)[0]
            self.assertLess((got - want).abs().max().item(), 1e-4, f"step {seed}")

    def test_the_cache_follows_a_tensor_changed_in_place_and_keeps_the_source_alive(self):
        cache = sgs._ArgCache()
        calls = []

        def convert(t):
            calls.append(1)
            return t.clone()

        t = torch.zeros(3)
        first = cache.get(t, convert)
        self.assertIs(cache.get(t, convert), first)
        self.assertEqual(len(calls), 1)
        t.add_(1.0)  # changed in place: converted again
        second = cache.get(t, convert)
        self.assertEqual(len(calls), 2)
        self.assertTrue(torch.equal(second, torch.ones(3)))
        other = torch.zeros(3)
        cache.get(other, convert)
        self.assertEqual(len(calls), 3)
        self.assertIs(cache.items[id(t)][0], t)  # the entry holds its source, so the address cannot be reused meanwhile
        cache.clear()
        self.assertEqual(cache.items, {})

    def test_inference_tensors_can_be_cached_and_the_cache_is_bounded(self):
        cache = sgs._ArgCache()
        with torch.inference_mode():
            t = torch.ones(2)
        self.assertIs(cache.get(t, lambda x: x * 2), cache.get(t, lambda x: x * 3))  # no version to read: the identity decides
        keep = [torch.zeros(1) for _ in range(sgs._ArgCache.LIMIT + 5)]
        for x in keep:
            cache.get(x, lambda y: y)
        self.assertLessEqual(len(cache.items), sgs._ArgCache.LIMIT)

    @torch.no_grad()
    def test_the_cache_is_emptied_when_the_card_is_given_back_and_on_memory_trouble(self):
        decoder, _reference, cfg = self._decoders(4)
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, resident=2)
        decoder(**_inputs(cfg), use_cache=False)
        self.assertGreater(len(pool.args.items), 0)
        pool.release_gpu()
        self.assertEqual(pool.args.items, {})
        decoder(**_inputs(cfg), use_cache=False)
        pool.shrink_resident()
        self.assertEqual(pool.args.items, {})

    @torch.no_grad()
    def test_out_of_memory_retry_works_with_the_activations_on_the_card(self):
        decoder, reference, cfg = self._decoders(6)
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, compute_dtype=torch.bfloat16, resident=4)
        inputs = _inputs(cfg)
        original = pool.resident[2].forward
        state = {"failed": 0}

        def failing(*a, **k):
            if state["failed"] == 0:
                state["failed"] += 1
                raise torch.cuda.OutOfMemoryError("simulated")
            return original(*a, **k)

        pool.resident[2].forward = failing
        out = decoder(**inputs, use_cache=False)[0]
        ref = reference(**inputs, use_cache=False)[0]
        self.assertEqual(state["failed"], 1)
        self.assertLess(((out - ref).norm() / ref.norm()).item(), 0.05)

    def test_each_stack_of_the_condition_encoder_returns_to_the_processor_at_its_last_block(self):
        model, _cfg = _tiny_condition_model()
        sgs.install_encoder(model, self.CPU, torch.bfloat16)
        holders = [model.encoder.lyric_encoder, model.encoder.timbre_encoder, model.tokenizer.attention_pooler, model.detokenizer]
        for holder in holders:
            flags = [layer._s_last for layer in holder.layers]
            self.assertEqual(flags, [False] * (len(flags) - 1) + [True])

    @torch.no_grad()
    def test_the_encoder_gives_the_same_result_with_bfloat16_compute_and_either_way_of_passing_activations(self):
        results = []
        for keep in (True, False):
            model, cfg = _tiny_condition_model()
            model.to(torch.bfloat16).float()
            pool = sgs.install_encoder(model, self.CPU, torch.bfloat16, compute_dtype=torch.bfloat16)
            pool.keep_on_card = keep
            results.append(model.prepare_condition(**_condition_inputs(cfg)))
        for a, b in zip(*results):
            self.assertTrue(torch.equal(a, b))

    @torch.no_grad()
    def test_the_self_check_still_works_when_the_activations_stay_on_the_card(self):
        decoder, _reference, cfg = self._decoders(5)
        pool = sgs.install(decoder, self.CPU, torch.bfloat16, compute_dtype=torch.bfloat16, resident=1)
        pool.check = sgs.SelfCheck("DiT", pool.count, torch.bfloat16)
        decoder(**_inputs(cfg), use_cache=False)
        self.assertEqual(sorted(pool.check.errors), list(range(5)))
        self.assertLess(max(rel for rel, _m in pool.check.errors.values()), pool.check.limit)


class MemoryLogTests(unittest.TestCase):
    """ACESTEP_STREAM_MEMORY=1: where the card's memory goes, one line at the main points of a generation."""

    GB = 1024 ** 3

    def _cuda(self, free=6.0, total=8.0, allocated=1.0, reserved=1.5):
        gb = self.GB
        return (
            mock.patch.object(sgs.torch.cuda, "is_available", return_value=True),
            mock.patch.object(sgs.torch.cuda, "mem_get_info", return_value=(int(free * gb), int(total * gb))),
            mock.patch.object(sgs.torch.cuda, "memory_allocated", return_value=int(allocated * gb)),
            mock.patch.object(sgs.torch.cuda, "memory_reserved", return_value=int(reserved * gb)),
        )

    def _log(self, tag="tag", smi=None, **kw):
        patches = list(self._cuda(**kw)) + [mock.patch.object(sgs, "_process_used_gb", return_value=smi)]
        with mock.patch.dict(os.environ, {sgs.ENV_MEMORY: "1"}), mock.patch.object(sgs.logger, "info") as info:
            for p in patches:
                p.start()
            try:
                sgs.log_memory(tag)
            finally:
                mock.patch.stopall()
        return info

    def test_off_by_default_and_touches_nothing(self):
        env = {k: v for k, v in os.environ.items() if k != sgs.ENV_MEMORY}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sgs.torch.cuda, "is_available", return_value=True), \
                mock.patch.object(sgs.torch.cuda, "mem_get_info") as probe, mock.patch.object(sgs.logger, "info") as info:
            sgs.log_memory("tag")
        probe.assert_not_called()
        info.assert_not_called()

    def test_one_line_with_free_memory_and_torch_figures(self):
        info = self._log("after the audio decoding", free=6.0, total=8.0, allocated=1.0, reserved=1.5)
        info.assert_called_once()
        template, *values = info.call_args[0]
        line = template.format(*values)
        self.assertIn("after the audio decoding", line)
        self.assertIn("free 6.00 of 8.00 GB", line)
        self.assertIn("torch in use 1.00, idle cache 0.50", line)
        self.assertNotIn("other programs", line)  # nvidia-smi could not say

    def test_the_driver_figure_separates_this_program_from_the_others(self):
        info = self._log(free=5.0, total=8.0, smi=2.5)  # 3 GB used on the card, 2.5 of them by this program
        template, *values = info.call_args[0]
        line = template.format(*values)
        self.assertIn("this program 2.50 GB", line)
        self.assertIn("other programs 0.50 GB", line)

    def test_a_failing_probe_never_breaks_a_generation(self):
        with mock.patch.dict(os.environ, {sgs.ENV_MEMORY: "1"}), mock.patch.object(sgs.torch.cuda, "is_available", return_value=True), \
                mock.patch.object(sgs.torch.cuda, "mem_get_info", side_effect=RuntimeError("driver")):
            sgs.log_memory("tag")  # must not raise

    def test_no_card_no_line(self):
        with mock.patch.dict(os.environ, {sgs.ENV_MEMORY: "1"}), mock.patch.object(sgs.torch.cuda, "is_available", return_value=False), \
                mock.patch.object(sgs.logger, "info") as info:
            sgs.log_memory("tag")
        info.assert_not_called()

    def test_nvidia_smi_output_is_read_for_this_process_only(self):
        text = "1234, 2048\n4321, 512\n"
        self.assertAlmostEqual(sgs.parse_compute_apps(text, 1234), 2.0)
        self.assertAlmostEqual(sgs.parse_compute_apps(text, 4321), 0.5)
        self.assertIsNone(sgs.parse_compute_apps(text, 99))
        self.assertIsNone(sgs.parse_compute_apps("", 1))
        self.assertIsNone(sgs.parse_compute_apps("1234, [N/A]\n", 1234))
        with mock.patch.object(sgs.subprocess, "run", side_effect=FileNotFoundError("no nvidia-smi")):
            self.assertIsNone(sgs._process_used_gb())

    @torch.no_grad()
    def test_the_pools_log_before_and_after_placing_their_blocks(self):
        decoder, cfg = _tiny_decoder(4)
        decoder.float().eval()
        pool = sgs.install(decoder, torch.device("cpu"), torch.bfloat16, resident=2)
        pool.release_gpu()
        with mock.patch.object(sgs, "log_memory") as log:
            pool.ensure_gpu()
        tags = [call.args[0] for call in log.call_args_list]
        self.assertEqual(tags, ["DiT: before placing the blocks", "DiT: 2 resident blocks placed"])

    def test_the_condition_encoder_pool_has_its_own_name(self):
        model, cfg = _tiny_condition_model()
        pool = sgs.install_encoder(model, torch.device("cpu"), torch.bfloat16)
        self.assertEqual(pool.label, "condition encoder")

    def test_the_memory_is_logged_around_the_condition_encoder(self):
        model = types.SimpleNamespace(prepare_condition=mock.Mock(return_value="done"))
        tags = []
        with mock.patch.object(sgs, "log_memory", side_effect=tags.append), mock.patch.object(sgs, "_ENCODER_POOL", mock.Mock()):
            sgs.wrap_prepare_condition(model)
            self.assertEqual(model.prepare_condition(), "done")
        self.assertEqual(tags, ["start of a generation", "after the condition encoder"])

    def test_the_memory_is_logged_after_the_audio_decoding_even_when_it_fails(self):
        handler = types.SimpleNamespace(vae=mock.Mock())
        handler.vae.to.return_value = handler.vae
        tags = []
        cuda = [
            mock.patch.object(sgs.torch.cuda, "empty_cache"),
            mock.patch.object(sgs.torch.cuda, "mem_get_info", return_value=(6 * self.GB, 8 * self.GB)),
            mock.patch.object(sgs.torch.cuda, "get_device_name", return_value="fake"),
            mock.patch.object(sgs.torch.cuda, "reset_peak_memory_stats"),
        ]
        latents = mock.Mock()
        latents.to.return_value = latents
        for p in cuda:
            p.start()
        try:
            with mock.patch.object(sgs, "release_gpu"), mock.patch.object(sgs, "log_memory", side_effect=tags.append), \
                    mock.patch.object(sgs, "decode_with_ladder", side_effect=RuntimeError("boom")):
                with self.assertRaises(RuntimeError):
                    sgs.tiled_decode_on_card(handler, latents)
        finally:
            mock.patch.stopall()
        self.assertEqual(tags, ["after the audio decoding"])


class VaeLeftoversTests(unittest.TestCase):
    """The decoder's weight_norm keeps its computed weights as plain attributes: Module.to leaves them on the card."""

    def _vae(self):
        from diffusers import AutoencoderOobleck

        torch.manual_seed(0)
        vae = AutoencoderOobleck(encoder_hidden_size=16, downsampling_ratios=[2, 2], channel_multiples=[1, 2],
                                 decoder_channels=16, decoder_input_channels=8, audio_channels=2, sampling_rate=48000).eval()
        with torch.no_grad():
            vae.decode(torch.randn(1, 8, 20))
        return vae

    @staticmethod
    def _stale(vae):
        # float64 stands for "the processor": .to(float64) moves parameters and buffers, like .to("cpu") after the card
        return [(n, k) for n, mod in vae.named_modules() for k, v in mod.__dict__.items() if torch.is_tensor(v) and v.dtype != torch.float64]

    def test_the_real_decoder_leaves_tensors_behind_after_to(self):
        vae = self._vae()
        vae.to(torch.float64)
        self.assertGreater(len(self._stale(vae)), 0)  # the reason for the fix

    def test_they_are_moved_and_counted(self):
        vae = self._vae()
        vae.to(torch.float64)
        modules = dict(vae.named_modules())
        before = {(n, k): v for n, mod in modules.items() for k, v in mod.__dict__.items() if torch.is_tensor(v) and v.dtype != torch.float64}
        expected = sum(v.numel() * v.element_size() for v in before.values())
        moved = sgs.drop_card_leftovers(vae, on_card=lambda t: t.dtype != torch.float64)
        self.assertEqual(moved, expected)
        self.assertGreater(moved, 0)
        for (n, k), old in before.items():
            self.assertIsNot(modules[n].__dict__[k], old)  # every one of them was replaced by its processor copy
            self.assertTrue(torch.equal(modules[n].__dict__[k], old))
        self.assertEqual(sgs.drop_card_leftovers(vae, on_card=lambda t: False), 0)

    def test_parameters_and_the_decode_are_untouched(self):
        vae = self._vae()
        params = [p.clone() for p in vae.parameters()]
        latents = torch.randn(1, 8, 20)
        with torch.no_grad():
            before = vae.decode(latents).sample
        sgs.drop_card_leftovers(vae, on_card=lambda t: True)
        for a, b in zip(params, vae.parameters()):
            self.assertTrue(torch.equal(a, b))
        with torch.no_grad():
            after = vae.decode(latents).sample
        self.assertTrue(torch.equal(before, after))  # the next forward recomputes the attributes

    def test_nothing_on_the_card_means_nothing_to_do(self):
        vae = self._vae()
        weights = {(n, k): v for n, mod in vae.named_modules() for k, v in mod.__dict__.items() if torch.is_tensor(v)}
        self.assertEqual(sgs.drop_card_leftovers(vae), 0)  # default test: tensor.is_cuda, false on the processor
        for (n, k), v in weights.items():
            self.assertIs(dict(vae.named_modules())[n].__dict__[k], v)

    def test_a_graph_attached_copy_is_cut(self):
        mod = nn.Linear(2, 2)
        mod.cached = torch.ones(2, requires_grad=True) * 2  # a result with a graph, like a weight computed with gradients on
        self.assertIsNotNone(mod.cached.grad_fn)
        sgs.drop_card_leftovers(mod, on_card=lambda t: True)
        self.assertIsNone(mod.cached.grad_fn)

    def test_the_audio_decoding_frees_them_even_when_it_fails(self):
        handler = types.SimpleNamespace(vae=mock.Mock())
        handler.vae.to.return_value = handler.vae
        latents = mock.Mock()
        latents.to.return_value = latents
        order = []
        cuda = [
            mock.patch.object(sgs.torch.cuda, "empty_cache"),
            mock.patch.object(sgs.torch.cuda, "mem_get_info", return_value=(6 * 1024 ** 3, 8 * 1024 ** 3)),
            mock.patch.object(sgs.torch.cuda, "get_device_name", return_value="fake"),
            mock.patch.object(sgs.torch.cuda, "reset_peak_memory_stats"),
        ]
        for p in cuda:
            p.start()
        try:
            with mock.patch.object(sgs, "release_gpu"), mock.patch.object(sgs, "log_memory", side_effect=lambda tag: order.append(tag)), \
                    mock.patch.object(sgs, "drop_card_leftovers", side_effect=lambda vae: order.append("leftovers") or 0), \
                    mock.patch.object(sgs, "decode_with_ladder", side_effect=RuntimeError("boom")):
                with self.assertRaises(RuntimeError):
                    sgs.tiled_decode_on_card(handler, latents)
        finally:
            mock.patch.stopall()
        self.assertEqual(order, ["leftovers", "after the audio decoding"])  # freed before the memory is measured


class LazyStatsTests(unittest.TestCase):
    """The timings are read once at the report, not after every block (a wait per block would stop the card's queue from filling)."""

    class Ev:
        def __init__(self, ms):
            self.ms = ms

        def elapsed_time(self, other):
            return other.ms - self.ms

    def test_events_are_turned_into_seconds_only_when_the_report_is_made(self):
        stats = sgs.StreamStats(False, True)
        stats.add_events((self.Ev(0), self.Ev(300), self.Ev(300), self.Ev(1300)))
        stats.add_events((self.Ev(2000), self.Ev(2100), self.Ev(2100), self.Ev(2600)))
        stats.add_events((None, self.Ev(1), self.Ev(2), self.Ev(3)))  # an event that could not be recorded is ignored
        self.assertEqual((stats.compute, stats.stall), (0.0, 0.0))
        summary = stats.summary()
        self.assertAlmostEqual(summary["stall_s"], 0.4)
        self.assertAlmostEqual(summary["compute_s"], 1.5)
        self.assertEqual(stats.pending, [])
        stats.summary()
        self.assertAlmostEqual(stats.compute, 1.5)  # not counted twice

    def test_the_duration_is_the_time_from_the_first_block_to_the_last_one(self):
        stats = sgs.StreamStats(False, True)
        stats.t0, stats.t1 = 10.0, 14.5
        self.assertAlmostEqual(stats.summary()["wall_s"], 4.5)
        stats.reset()
        self.assertEqual(stats.summary()["wall_s"], 0.0)
        self.assertIsNone(stats.t0)


if __name__ == "__main__":
    unittest.main()
