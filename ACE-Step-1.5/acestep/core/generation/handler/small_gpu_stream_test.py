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
