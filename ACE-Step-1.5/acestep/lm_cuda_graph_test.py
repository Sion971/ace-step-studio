"""Tests of the CUDA graph helper of the LM loops.

There is no card in the test environment: the graph itself cannot be captured here. What is checked is everything around
it: the static-cache step gives the logits of the usual step (the graph replays exactly that code), the check that
guards the switch, the fall-backs, and the loops giving the same tokens when the helper drives them.
"""

import unittest
from unittest.mock import MagicMock, patch

import torch

try:
    from transformers import Qwen3Config, Qwen3ForCausalLM, DynamicCache
    from acestep import lm_cuda_graph
    from acestep.llm_inference import LLMHandler
    _IMPORT_ERROR = None
except ImportError as exc:  # pragma: no cover - dependency guard
    lm_cuda_graph = None
    LLMHandler = None
    _IMPORT_ERROR = exc

EOS = 1


def _tiny_model():
    torch.manual_seed(11)
    config = Qwen3Config(
        vocab_size=64, hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=4,
        num_key_value_heads=2, head_dim=8, max_position_embeddings=128,
    )
    model = Qwen3ForCausalLM(config)
    model.config._attn_implementation = "sdpa"
    return model.eval()


def _prompt(rows, length=7):
    torch.manual_seed(5)
    ids = torch.randint(10, 60, (rows, length))
    mask = torch.ones_like(ids)
    mask[0, :3] = 0  # the first row is left-padded
    return ids, mask


@unittest.skipIf(_IMPORT_ERROR is not None, f"dependencies missing: {_IMPORT_ERROR}")
class StaticStepTests(unittest.TestCase):
    def test_static_cache_step_gives_the_logits_of_the_usual_step(self):
        self._compare(window_step=None)

    def test_windows_of_a_few_positions_give_the_same_logits(self):
        self._compare(window_step=4)  # the 8 steps cross three windows

    def _compare(self, window_step):
        model = _tiny_model()
        ids, mask = _prompt(3)
        with torch.inference_mode():
            out = model(input_ids=ids, attention_mask=mask, use_cache=True)
            cache = out.past_key_values
            token = out.logits[:, -1, :].argmax(-1, keepdim=True)
            generated = torch.cat([ids, token], dim=1)
            mask = torch.cat([mask, torch.ones((3, 1), dtype=mask.dtype)], dim=1)
            decoder = lm_cuda_graph.GraphDecoder.build(
                model, cache, mask, token, max_new_tokens=9, capture=False, window_step=window_step)
            for _ in range(8):
                usual = model(input_ids=generated[:, -1:], attention_mask=mask, past_key_values=cache, use_cache=True)
                cache = usual.past_key_values
                graph = decoder.step(generated)
                self.assertTrue(
                    torch.allclose(usual.logits, graph.logits, atol=1e-4),
                    float((usual.logits - graph.logits).abs().max()),
                )
                token = usual.logits[:, -1, :].argmax(-1, keepdim=True)
                generated = torch.cat([generated, token], dim=1)
                mask = torch.cat([mask, torch.ones((3, 1), dtype=mask.dtype)], dim=1)
            if window_step:
                self.assertGreaterEqual(len(decoder.views), 2)

    def test_build_refuses_a_cache_that_does_not_match_the_mask(self):
        model = _tiny_model()
        ids, mask = _prompt(2)
        with torch.inference_mode():
            cache = model(input_ids=ids, attention_mask=mask, use_cache=True).past_key_values
            with self.assertRaises(RuntimeError):
                lm_cuda_graph.GraphDecoder.build(model, cache, mask, ids[:, -1:], 5, capture=False)  # mask too narrow


@unittest.skipIf(_IMPORT_ERROR is not None, f"dependencies missing: {_IMPORT_ERROR}")
class WindowFallbackTests(unittest.TestCase):
    def _decoder(self):
        model = _tiny_model()
        ids, mask = _prompt(2)
        with torch.inference_mode():
            out = model(input_ids=ids, attention_mask=mask, use_cache=True)
            token = out.logits[:, -1, :].argmax(-1, keepdim=True)
            generated = torch.cat([ids, token], dim=1)
            mask = torch.cat([mask, torch.ones((2, 1), dtype=mask.dtype)], dim=1)
            decoder = lm_cuda_graph.GraphDecoder.build(
                model, out.past_key_values, mask, token, max_new_tokens=9, capture=True, window_step=4)
        return model, decoder, generated, mask, out.past_key_values

    def test_a_failing_later_capture_leaves_the_steps_running_without_the_graph(self):
        model, decoder, generated, mask, cache = self._decoder()
        calls = []

        def capture(window):
            calls.append(window)
            if len(calls) > 1:
                raise RuntimeError("no more graphs")

            class Graph:
                def replay(inner):
                    entry.logits.copy_(decoder._forward(window))

            entry = lm_cuda_graph._Captured(Graph(), torch.zeros(2, model.config.vocab_size))
            return entry

        decoder._capture = capture
        with torch.inference_mode():
            for _ in range(8):
                usual = model(input_ids=generated[:, -1:], attention_mask=mask, past_key_values=cache, use_cache=True)
                cache = usual.past_key_values
                result = decoder.step(generated)
                self.assertTrue(torch.allclose(usual.logits, result.logits, atol=1e-4))
                token = usual.logits[:, -1, :].argmax(-1, keepdim=True)
                generated = torch.cat([generated, token], dim=1)
                mask = torch.cat([mask, torch.ones((2, 1), dtype=mask.dtype)], dim=1)
        self.assertTrue(decoder.eager_only)
        self.assertGreater(decoder.eager_steps, 0)
        self.assertEqual(len(decoder.captured), 1)

    def test_a_failing_first_capture_is_raised_for_the_check_to_fall_back(self):
        model, decoder, generated, mask, cache = self._decoder()
        decoder._capture = MagicMock(side_effect=RuntimeError("cannot capture"))
        with torch.inference_mode(), self.assertRaises(RuntimeError):
            decoder.step(generated)


@unittest.skipIf(_IMPORT_ERROR is not None, f"dependencies missing: {_IMPORT_ERROR}")
class ReleaseTests(unittest.TestCase):
    def _ready(self):
        model = _tiny_model()
        ids, mask = _prompt(2)
        with torch.inference_mode():
            out = model(input_ids=ids, attention_mask=mask, use_cache=True)
            token = out.logits[:, -1, :].argmax(-1, keepdim=True)
            generated = torch.cat([ids, token], dim=1)
            mask = torch.cat([mask, torch.ones((2, 1), dtype=mask.dtype)], dim=1)
            graph = lm_cuda_graph.LmGraph(model, 12, capture=False, window_step=4)
            graph.end_step(out, mask, generated)
            usual = model(input_ids=generated[:, -1:], attention_mask=mask, past_key_values=out.past_key_values,
                          use_cache=True)
            graph.check(usual, generated)
            for _ in range(5):  # several windows
                generated = torch.cat([generated, token], dim=1)
                graph.step(generated)
        return graph

    def test_release_drops_the_buffers_and_the_graphs(self):
        import weakref
        graph = self._ready()
        decoder = graph.decoder
        keys = [weakref.ref(layer.keys) for layer in decoder.cache.layers]
        reset = MagicMock()
        decoder.captured[4] = lm_cuda_graph._Captured(MagicMock(reset=reset), torch.zeros(1))
        decoder.release()
        reset.assert_called_once()
        self.assertEqual(decoder.captured, {})
        self.assertEqual(decoder.views, {})
        self.assertIsNone(decoder.cache)
        self.assertTrue(all(ref() is None for ref in keys))

    def test_release_goes_on_when_a_graph_cannot_be_reset(self):
        graph = self._ready()
        decoder = graph.decoder
        decoder.captured[4] = lm_cuda_graph._Captured(MagicMock(reset=MagicMock(side_effect=RuntimeError("busy"))),
                                                      torch.zeros(1))
        decoder.release()
        self.assertEqual(decoder.captured, {})

    def test_close_releases_and_reports_the_memory_of_the_card(self):
        graph = self._ready()
        readings = iter([4000.0, 4400.0])
        with patch.object(lm_cuda_graph, "_card_mb", side_effect=lambda: next(readings)), \
                patch.object(lm_cuda_graph, "logger") as logger:
            graph.card_before = 3000.0
            graph.close()
        text = [call.args for call in logger.info.call_args_list]
        self.assertTrue(any("card memory" in args[0] and args[1:] == (3000.0, 4000.0, 4400.0) for args in text), text)
        self.assertIsNone(graph.decoder)
        self.assertEqual(graph.state, "off")


@unittest.skipIf(_IMPORT_ERROR is not None, f"dependencies missing: {_IMPORT_ERROR}")
class CheckTests(unittest.TestCase):
    def test_rounding_passes_and_damage_does_not(self):
        base = torch.randn(2, 64) * 5
        self.assertTrue(lm_cuda_graph.logits_match(base, base + 0.05)[0])
        self.assertFalse(lm_cuda_graph.logits_match(base, base + 3.0)[0])
        broken = base.clone()
        broken[0, 3] = float("nan")
        self.assertFalse(lm_cuda_graph.logits_match(base, broken)[0])
        broken[0, 3] = float("inf")
        self.assertFalse(lm_cuda_graph.logits_match(base, broken)[0])


@unittest.skipIf(_IMPORT_ERROR is not None, f"dependencies missing: {_IMPORT_ERROR}")
class CreateTests(unittest.TestCase):
    def test_switches_and_conditions(self):
        import os
        model = _tiny_model()
        with patch.dict("os.environ", {}, clear=False):
            os.environ.pop(lm_cuda_graph.ENV_GRAPH, None)
            with patch("torch.cuda.is_available", return_value=True):
                with patch.object(torch.version, "cuda", "13.0"):
                    self.assertIsNotNone(lm_cuda_graph.create(model, "cuda", 500))  # on for NVIDIA when unset
                with patch.object(torch.version, "cuda", None):
                    self.assertIsNone(lm_cuda_graph.create(model, "cuda", 500))  # off elsewhere (ROCm...)
        with patch.dict("os.environ", {lm_cuda_graph.ENV_GRAPH: "0"}), patch("torch.cuda.is_available", return_value=True):
            self.assertIsNone(lm_cuda_graph.create(model, "cuda", 500))
        with patch.dict("os.environ", {lm_cuda_graph.ENV_GRAPH: "1"}):
            self.assertIsNone(lm_cuda_graph.create(model, "cpu", 500))  # no card: nothing to capture
            with patch("torch.cuda.is_available", return_value=True):
                self.assertIsNotNone(lm_cuda_graph.create(model, "cuda", 500))
                self.assertIsNone(lm_cuda_graph.create(model, "cuda", 10))  # too short to pay back
                model.config._attn_implementation = "eager"
                self.assertIsNone(lm_cuda_graph.create(model, "cuda", 500))


@unittest.skipIf(_IMPORT_ERROR is not None, f"dependencies missing: {_IMPORT_ERROR}")
class StateMachineTests(unittest.TestCase):
    def _after_first_step(self):
        model = _tiny_model()
        ids, mask = _prompt(2)
        with torch.inference_mode():
            out = model(input_ids=ids, attention_mask=mask, use_cache=True)
            token = out.logits[:, -1, :].argmax(-1, keepdim=True)
            generated = torch.cat([ids, token], dim=1)
            mask = torch.cat([mask, torch.ones((2, 1), dtype=mask.dtype)], dim=1)
            graph = lm_cuda_graph.LmGraph(model, 12, capture=False)
            graph.end_step(out, mask, generated)
            usual = model(input_ids=generated[:, -1:], attention_mask=mask, past_key_values=out.past_key_values,
                          use_cache=True)
        return graph, usual, generated

    def test_good_check_makes_the_graph_ready(self):
        graph, usual, generated = self._after_first_step()
        self.assertTrue(graph.checking)
        with torch.inference_mode():
            graph.check(usual, generated)
        self.assertTrue(graph.ready)

    def test_wrong_logits_switch_the_graph_off(self):
        graph, usual, generated = self._after_first_step()
        usual.logits = usual.logits + 5.0
        with torch.inference_mode():
            graph.check(usual, generated)
        self.assertEqual(graph.state, "off")
        self.assertFalse(graph.ready)

    def test_failing_build_switches_the_graph_off(self):
        model = _tiny_model()
        graph = lm_cuda_graph.LmGraph(model, 12, capture=False)
        ids, mask = _prompt(2)
        graph.end_step(MagicMock(past_key_values=object()), mask, ids)  # a cache without per-layer storage
        self.assertEqual(graph.state, "off")

    def test_failing_step_during_the_check_switches_the_graph_off(self):
        graph, usual, generated = self._after_first_step()
        graph.decoder.step = MagicMock(side_effect=RuntimeError("capture failed"))
        graph.check(usual, generated)
        self.assertEqual(graph.state, "off")


@unittest.skipIf(_IMPORT_ERROR is not None, f"dependencies missing: {_IMPORT_ERROR}")
class LoopTests(unittest.TestCase):
    """The loops give the same tokens whether the helper drives the steps after the check or not."""

    def _handler(self):
        handler = LLMHandler()
        handler.llm = _tiny_model()
        handler.device = "cpu"
        handler.disable_tqdm = True
        tokenizer = MagicMock()
        tokenizer.eos_token_id = EOS
        tokenizer.pad_token_id = EOS
        handler.llm_tokenizer = tokenizer
        return handler

    def _run(self, kind, with_graph):
        handler = self._handler()
        made = []

        def create(model, device, max_new_tokens):
            if not with_graph:
                return None
            graph = lm_cuda_graph.LmGraph(model, max_new_tokens, capture=False, window_step=4)
            made.append(graph)
            return graph

        ids, mask = _prompt(2 if kind == "plain" else 4)
        with patch.object(lm_cuda_graph, "create", create), torch.inference_mode():
            if kind == "plain":
                out = handler._generate_with_constrained_decoding(
                    input_ids=ids, attention_mask=mask, max_new_tokens=14, temperature=0.0, top_k=None, top_p=None,
                    repetition_penalty=1.0, pad_token_id=EOS, streamer=None, constrained_processor=None)
            else:
                out = handler._generate_with_cfg_custom(
                    batch_input_ids=ids, batch_attention_mask=mask, max_new_tokens=14, temperature=0.0,
                    cfg_scale=1.5, top_k=None, top_p=None, repetition_penalty=1.0, pad_token_id=EOS, streamer=None,
                    constrained_processor=None)
        return out.tolist(), made

    def test_plain_loop(self):
        usual, _ = self._run("plain", False)
        driven, made = self._run("plain", True)
        self.assertEqual(usual, driven)
        self.assertEqual(len(made), 1)
        self.assertEqual(made[0].state, "off")  # closed at the end of the generation

    def test_cfg_loop(self):
        usual, _ = self._run("cfg", False)
        driven, made = self._run("cfg", True)
        self.assertEqual(usual, driven)
        self.assertEqual(len(made), 1)

    def test_the_graph_really_drove_the_steps(self):
        states = []
        original = lm_cuda_graph.LmGraph.step

        def spy(self, generated_ids):
            states.append(self.state)
            return original(self, generated_ids)

        with patch.object(lm_cuda_graph.LmGraph, "step", spy):
            self._run("cfg", True)
        self.assertGreater(len(states), 3)
        self.assertEqual(set(states), {"ready"})


if __name__ == "__main__":
    unittest.main()
