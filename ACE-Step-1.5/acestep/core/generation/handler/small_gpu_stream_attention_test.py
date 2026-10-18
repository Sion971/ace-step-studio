"""Unit tests for the mask-free attention of the small-GPU stream mode (run on the processor)."""

import copy
import sys
import unittest
from unittest import mock

import torch
import torch.nn.functional as F

from acestep.core.generation.handler import small_gpu_stream as sgs
from acestep.core.generation.handler import small_gpu_stream_attention as attn
from acestep.core.generation.handler.small_gpu_stream_test import _inputs, _tiny_decoder

CPU = torch.device("cpu")


def _reference(q, k, v, window=None, mask=None, scale=None):
    """Plain SDPA with the additive mask the regular path builds ([B, H, S, D] in, [B, H, S, D] out, float32)."""
    q, k, v = q.float(), k.float(), v.float()
    if k.shape[1] != q.shape[1]:
        k, v = attn._repeat_kv(k, q.shape[1] // k.shape[1]), attn._repeat_kv(v, q.shape[1] // v.shape[1])
    if window is not None:
        mask = attn.reference_mask(q.shape[2], window)
    return F.scaled_dot_product_attention(q, k, v, attn_mask=mask, scale=scale)


def _qkv(b=1, h=4, hkv=2, s=40, sk=None, d=16, dtype=torch.float32, seed=0):
    g = torch.Generator().manual_seed(seed)
    sk = s if sk is None else sk
    return (torch.randn(b, h, s, d, generator=g).to(dtype), torch.randn(b, hkv, sk, d, generator=g).to(dtype),
            torch.randn(b, hkv, sk, d, generator=g).to(dtype))


class BandedAttentionTests(unittest.TestCase):
    def test_matches_the_masked_attention_for_many_shapes(self):
        # (batch, sequence, window, block): padded tails, a block larger than the sequence, a window larger than it...
        for b, s, window, block in [(1, 50, 4, None), (2, 33, 8, 16), (1, 16, 4, 8), (1, 129, 16, 32), (1, 9, 4, 4),
                                    (3, 100, 128, None), (1, 257, 5, 7), (1, 5, 8, None), (1, 2, 1, None)]:
            with self.subTest(b=b, s=s, window=window, block=block):
                q, k, v = _qkv(b=b, hkv=4, s=s)
                got = attn.banded_attention(q, k, v, window, block=block)
                ref = _reference(q, k, v, window=window)
                self.assertEqual(got.shape, ref.shape)
                self.assertLess((got - ref).abs().max().item(), 2e-5)

    def test_the_window_really_limits_what_a_position_sees(self):
        q, k, v = _qkv(hkv=4, s=40)
        v_far = v.clone()
        v_far[:, :, 0] += 100.0  # position 0 is outside the window of position 20
        a = attn.banded_attention(q, k, v, 4)
        b = attn.banded_attention(q, k, v_far, 4)
        self.assertTrue(torch.equal(a[:, :, 20], b[:, :, 20]))
        self.assertFalse(torch.equal(a[:, :, 2], b[:, :, 2]))  # but position 2 still sees it

    def test_scale_is_applied(self):
        q, k, v = _qkv(hkv=4, s=30)
        got = attn.banded_attention(q, k, v, 3, scale=0.37)
        self.assertLess((got - _reference(q, k, v, window=3, scale=0.37)).abs().max().item(), 2e-5)

    def test_bfloat16_stays_close(self):
        q, k, v = _qkv(hkv=4, s=70, dtype=torch.bfloat16)
        got = attn.banded_attention(q, k, v, 8).float()
        ref = _reference(q, k, v, window=8)
        self.assertLess(((got - ref).norm() / ref.norm()).item(), 2e-2)

    def test_the_mask_is_built_once_per_shape(self):
        attn._MASK_CACHE.clear()
        q, k, v = _qkv(hkv=4, s=40)
        attn.banded_attention(q, k, v, 4)
        first = list(attn._MASK_CACHE.values())[0]
        attn.banded_attention(q, k, v, 4)
        self.assertIs(list(attn._MASK_CACHE.values())[0], first)
        self.assertEqual(len(attn._MASK_CACHE), 1)


class StreamAttentionTests(unittest.TestCase):
    def setUp(self):
        self._saved = dict(attn._STATE)
        attn._STATE["backend"] = "torch"

    def tearDown(self):
        attn._STATE.update(self._saved)

    def _module(self):
        return mock.Mock(is_cross_attention=False, is_causal=False, num_key_value_groups=2)

    def test_full_attention_with_grouped_heads(self):
        q, k, v = _qkv(s=24)
        out, weights = attn.stream_attention(self._module(), q, k, v, None, scaling=0.25)
        self.assertIsNone(weights)
        self.assertEqual(out.shape, (1, 24, 4, 16))  # [batch, sequence, heads, head_dim]
        self.assertLess((out.transpose(1, 2) - _reference(q, k, v, scale=0.25)).abs().max().item(), 2e-5)

    def test_sliding_layer(self):
        q, k, v = _qkv(s=60)
        out, _ = attn.stream_attention(self._module(), q, k, v, None, scaling=0.25, sliding_window=6)
        self.assertLess((out.transpose(1, 2) - _reference(q, k, v, window=6, scale=0.25)).abs().max().item(), 2e-5)

    def test_cross_attention_ignores_the_window_and_uses_the_other_length(self):
        q, k, v = _qkv(s=30, sk=11)
        out, _ = attn.stream_attention(self._module(), q, k, v, None, scaling=0.25, sliding_window=None)
        self.assertEqual(out.shape, (1, 30, 4, 16))
        self.assertLess((out.transpose(1, 2) - _reference(q, k, v, scale=0.25)).abs().max().item(), 2e-5)
        # a window passed with keys of another length is never applied
        out2, _ = attn.stream_attention(self._module(), q, k, v, None, scaling=0.25, sliding_window=3)
        self.assertTrue(torch.allclose(out, out2))

    def test_a_call_with_a_mask_goes_to_the_regular_sdpa_function(self):
        q, k, v = _qkv(s=20)
        mask = attn.reference_mask(20, 3)
        out, _ = attn.stream_attention(self._module(), q, k, v, mask, scaling=0.25, sliding_window=3)
        self.assertLess((out.transpose(1, 2) - _reference(q, k, v, mask=mask, scale=0.25)).abs().max().item(), 2e-5)

    def test_flash_is_called_with_the_window_in_the_kernel(self):
        q, k, v = _qkv(s=24, dtype=torch.bfloat16)
        calls = []

        def fake_flash(qq, kk, vv, **options):
            calls.append((qq.shape, kk.shape, options))
            return torch.zeros_like(qq)

        attn._STATE["backend"] = "flash"
        with mock.patch.object(attn, "_flash_func", return_value=fake_flash), \
                mock.patch.object(torch.Tensor, "is_cuda", new_callable=mock.PropertyMock, return_value=True):
            out, _ = attn.stream_attention(self._module(), q, k, v, None, scaling=0.25, sliding_window=5)
            attn.stream_attention(self._module(), q, k, v, None, scaling=0.25, sliding_window=None)
        self.assertEqual(out.shape, (1, 24, 4, 16))
        (q_shape, k_shape, window_call), (_, _, full_call) = calls
        self.assertEqual(tuple(q_shape), (1, 24, 4, 16))
        self.assertEqual(tuple(k_shape), (1, 24, 2, 16))  # the key/value heads are not repeated: flash does grouped heads itself
        self.assertEqual(window_call["window_size"], (5, 5))
        self.assertEqual(full_call["window_size"], (-1, -1))
        self.assertEqual(window_call["softmax_scale"], 0.25)
        self.assertFalse(window_call["causal"])

    def test_a_failing_flash_kernel_falls_back_to_torch_for_good(self):
        q, k, v = _qkv(s=24, dtype=torch.bfloat16)
        attn._STATE["backend"] = "flash"
        boom = mock.Mock(side_effect=RuntimeError("no kernel for this card"))
        with mock.patch.object(attn, "_flash_func", return_value=boom), \
                mock.patch.object(torch.Tensor, "is_cuda", new_callable=mock.PropertyMock, return_value=True), \
                mock.patch.object(attn.logger, "warning") as warn:
            out, _ = attn.stream_attention(self._module(), q, k, v, None, scaling=0.25, sliding_window=5)
            attn.stream_attention(self._module(), q, k, v, None, scaling=0.25, sliding_window=5)
        self.assertEqual(attn.backend(), "torch")
        self.assertEqual(boom.call_count, 1)  # not tried again
        self.assertEqual(warn.call_count, 1)
        ref = _reference(q, k, v, window=5, scale=0.25)
        self.assertLess(((out.transpose(1, 2).float() - ref).norm() / ref.norm()).item(), 2e-2)

    def test_float32_never_goes_to_flash(self):
        q, k, v = _qkv(s=24)
        attn._STATE["backend"] = "flash"
        boom = mock.Mock(side_effect=AssertionError("flash must not be used for float32"))
        with mock.patch.object(attn, "_flash_func", return_value=boom), \
                mock.patch.object(torch.Tensor, "is_cuda", new_callable=mock.PropertyMock, return_value=True):
            attn.stream_attention(self._module(), q, k, v, None, scaling=0.25, sliding_window=5)
        boom.assert_not_called()


def _decoder(layers=4, window=3, use_sliding=True):
    """A small DiT (built from the real turbo modeling code) whose sliding layers have a short window."""
    _tiny_decoder()  # loads the modeling module under a private name
    modeling = sys.modules["_sgs_test_modeling_turbo"]
    from acestep.models.common.configuration_acestep_v15 import AceStepConfig

    cfg = AceStepConfig(hidden_size=64, intermediate_size=128, num_hidden_layers=layers, num_attention_heads=4,
                        num_key_value_heads=2, head_dim=16, sliding_window=window, use_sliding_window=use_sliding)
    cfg._attn_implementation = "sdpa"
    torch.manual_seed(0)
    return modeling.AceStepDiTModel(cfg).float().eval(), cfg, modeling


class MaskFreeDecoderTests(unittest.TestCase):
    FRAMES = 40  # 20 tokens: more than the window of 3 on each side

    def setUp(self):
        self._saved = dict(attn._STATE)

    def tearDown(self):
        attn._STATE.update(self._saved)

    def _pair(self, layers=4, window=3, **options):
        decoder, cfg, modeling = _decoder(layers, window)
        plain = copy.deepcopy(decoder)
        pool = sgs.install(plain, CPU, torch.bfloat16, compute_dtype=torch.bfloat16, **options)
        free = copy.deepcopy(decoder)
        free_pool = sgs.install(free, CPU, torch.bfloat16, compute_dtype=torch.bfloat16, **options)
        return plain, pool, free, free_pool, cfg, modeling

    @staticmethod
    def _relative(a, b):
        return ((a - b).norm() / b.norm()).item()

    @torch.no_grad()
    def test_same_output_as_the_regular_masks(self):
        plain, _pool, free, free_pool, cfg, _m = self._pair(resident=2)
        self.assertTrue(attn.enable(free.eval(), free_pool, CPU))
        inputs = _inputs(cfg, frames=self.FRAMES)
        ref = plain(**inputs, use_cache=False)[0]
        out = free(**inputs, use_cache=False)[0]
        self.assertTrue(torch.isfinite(out).all())
        self.assertLess(self._relative(out, ref), 2e-2)  # bfloat16 rounding only

    @torch.no_grad()
    def test_the_window_is_really_applied(self):
        # Without a window the sliding layers would see everything: the output must differ clearly from that.
        plain, _pool, free, free_pool, cfg, _m = self._pair()
        attn.enable(free.eval(), free_pool, CPU)
        wide, wide_cfg, _ = _decoder(4, window=10_000)
        wide.load_state_dict(plain.state_dict(), strict=False)
        wide_pool = sgs.install(wide, CPU, torch.bfloat16, compute_dtype=torch.bfloat16)
        inputs = _inputs(cfg, frames=self.FRAMES)
        out = free(**inputs, use_cache=False)[0]
        no_window = wide(**inputs, use_cache=False)[0]
        ref = plain(**inputs, use_cache=False)[0]
        self.assertGreater(self._relative(out, no_window), 5 * self._relative(out, ref))
        del wide_pool

    @torch.no_grad()
    def test_the_forward_builds_no_mask(self):
        _plain, _pool, free, free_pool, cfg, modeling = self._pair()
        attn.enable(free.eval(), free_pool, CPU)
        with mock.patch.object(modeling, "create_4d_mask", side_effect=AssertionError("a mask was built")):
            out = free(**_inputs(cfg, frames=self.FRAMES), use_cache=False)[0]
        self.assertTrue(torch.isfinite(out).all())

    @torch.no_grad()
    def test_only_the_card_copies_and_the_decoder_host_change_their_attention(self):
        _plain, _pool, free, free_pool, cfg, _m = self._pair(resident=2)
        original = free.layers[0]._s_real.self_attn.config
        self.assertTrue(attn.enable(free.eval(), free_pool, CPU))
        # the processor-side blocks (self-check reference, tokenizer...) keep the model's config untouched
        self.assertEqual(original._attn_implementation, "sdpa")
        self.assertIs(free.layers[0]._s_real.self_attn.config, original)
        self.assertEqual(free.config._attn_implementation, attn.MASKFREE_NAME)
        self.assertIsNot(free.config, original)
        modules = list(free_pool.slots) + list(free_pool.resident)
        self.assertEqual(len(modules), 4)  # 2 resident + 2 slots
        for module in modules:
            for sub in (module.self_attn, module.cross_attn):
                self.assertEqual(sub.config._attn_implementation, attn.ATTENTION_NAME)
            self.assertIsNot(module.self_attn.config, original)
        self.assertTrue(free_pool.mask_free)

    @torch.no_grad()
    def test_card_copies_built_later_get_the_attention_too(self):
        _plain, _pool, free, free_pool, cfg, _m = self._pair(resident=2)
        attn.enable(free.eval(), free_pool, CPU)
        free_pool.release_gpu()
        free_pool.ensure_gpu()
        for module in list(free_pool.slots) + list(free_pool.resident):
            self.assertEqual(module.self_attn.config._attn_implementation, attn.ATTENTION_NAME)

    @torch.no_grad()
    def test_switched_off_by_the_environment(self):
        _plain, _pool, free, free_pool, cfg, _m = self._pair()
        for value in ("off", "0", "SDPA"):
            with mock.patch.dict("os.environ", {attn.ENV_ATTENTION: value}):
                self.assertFalse(attn.enable(free, free_pool, CPU))
        self.assertEqual(free.config._attn_implementation, "sdpa")
        self.assertFalse(free_pool.mask_free)
        self.assertIsNone(free_pool.attention_name)

    @torch.no_grad()
    def test_float32_compute_keeps_the_regular_path(self):
        decoder, cfg, _m = _decoder()
        pool = sgs.install(decoder, CPU, torch.bfloat16, compute_dtype=torch.float32)
        self.assertFalse(attn.enable(decoder, pool, CPU))
        self.assertEqual(decoder.config._attn_implementation, "sdpa")

    @torch.no_grad()
    def test_a_dit_without_the_mask_free_branch_keeps_the_regular_path(self):
        _plain, _pool, free, free_pool, cfg, _m = self._pair()
        with mock.patch.object(attn, "decoder_skips_masks", return_value=False):
            self.assertFalse(attn.enable(free, free_pool, CPU))
        self.assertEqual(free.config._attn_implementation, "sdpa")
        self.assertTrue(attn.decoder_skips_masks(free))  # the real DiT code does have it

    @torch.no_grad()
    def test_missing_registry_or_any_error_keeps_the_regular_path(self):
        _plain, _pool, free, free_pool, cfg, _m = self._pair()
        with mock.patch.object(attn, "register", return_value=False):
            self.assertFalse(attn.enable(free, free_pool, CPU))
        with mock.patch.object(attn, "pick_backend", side_effect=RuntimeError("boom")), \
                mock.patch.object(attn.logger, "warning") as warn:
            self.assertFalse(attn.enable(free, free_pool, CPU))
        warn.assert_called_once()
        self.assertEqual(free.config._attn_implementation, "sdpa")
        self.assertFalse(free_pool.mask_free)
        out = free(**_inputs(cfg, frames=self.FRAMES), use_cache=False)[0]  # still works as before
        self.assertTrue(torch.isfinite(out).all())

    @torch.no_grad()
    def test_self_check_gives_the_reference_the_band_mask(self):
        decoder, cfg, _m = _decoder(6)
        pool = sgs.install(decoder, CPU, torch.bfloat16, compute_dtype=torch.bfloat16, resident=3)
        attn.enable(decoder, pool, CPU)
        pool.check = sgs.SelfCheck("DiT", pool.count, torch.bfloat16)
        decoder(**_inputs(cfg, frames=self.FRAMES), use_cache=False)
        self.assertEqual(sorted(pool.check.errors), list(range(6)))
        good = max(rel for rel, _m in pool.check.errors.values())
        self.assertLess(good, pool.check.limit)
        # without the band mask the sliding blocks would be compared with full attention and be far off
        pool.check = sgs.SelfCheck("DiT", pool.count, torch.bfloat16)
        with mock.patch.object(sgs.SelfCheck, "_with_reference_masks", staticmethod(lambda real, args, kwargs: (args, kwargs))):
            pool.args.clear()
            decoder(**_inputs(cfg, frames=self.FRAMES), use_cache=False)
        self.assertGreater(max(rel for rel, _m in pool.check.errors.values()), 3 * good)

    @torch.no_grad()
    def test_attach_if_enabled_switches_it_on(self):
        decoder, cfg, _m = _decoder()
        model = torch.nn.Module()
        model.decoder = decoder
        env = {sgs.ENV_FLAG: "1", sgs.ENV_COMPUTE: "bfloat16"}
        with mock.patch.dict("os.environ", env), mock.patch.object(sgs, "enabled", return_value=True), \
                mock.patch.object(sgs, "attach_encoder", return_value=False), \
                mock.patch.object(sgs.torch.cuda, "mem_get_info", return_value=(8 * 1024**3, 8 * 1024**3)), \
                mock.patch.object(sgs.torch.cuda, "get_device_name", return_value="fake"), \
                mock.patch.object(sgs.StreamPool, "ensure_gpu", lambda self_: None), \
                mock.patch.object(attn, "pick_backend", return_value="torch"), \
                mock.patch.object(sgs, "noise_on_card_from_env", return_value=False):
            try:
                attached = sgs.attach_if_enabled(model)
            finally:
                sgs._ACTIVE_POOL = None
        self.assertTrue(attached)
        self.assertEqual(decoder.config._attn_implementation, attn.MASKFREE_NAME)


class ReferenceMaskTests(unittest.TestCase):
    def test_band_values(self):
        mask = attn.reference_mask(6, 1)
        self.assertEqual(mask.shape, (1, 1, 6, 6))
        valid = (mask[0, 0] == 0)
        for i in range(6):
            for j in range(6):
                self.assertEqual(bool(valid[i, j]), abs(i - j) <= 1)
        self.assertEqual(mask[0, 0, 0, 5].item(), torch.finfo(torch.float32).min)


if __name__ == "__main__":
    unittest.main()
