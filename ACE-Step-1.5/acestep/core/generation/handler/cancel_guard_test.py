"""Unit tests for the diffusion cancel guard."""

import types
import unittest

from acestep.core.generation.handler.cancel_guard import cancel_guard


class _Handle:
    def __init__(self, hooks, hook):
        self._hooks, self._hook = hooks, hook

    def remove(self):
        self._hooks.remove(self._hook)


class _Decoder:
    """Stands in for a torch module: calling it runs the registered pre-hooks first."""

    def __init__(self):
        self.hooks = []
        self.calls = 0

    def register_forward_pre_hook(self, hook, with_kwargs=False):
        assert with_kwargs
        self.hooks.append(hook)
        return _Handle(self.hooks, hook)

    def __call__(self, *args, **kwargs):
        for hook in list(self.hooks):
            hook(self, args, kwargs)
        self.calls += 1


class CancelGuardTests(unittest.TestCase):
    """The guard stops the diffusion at the next decoder call and leaves nothing behind."""

    def test_runs_normally_without_cancel(self):
        decoder = _Decoder()
        model = types.SimpleNamespace(decoder=decoder, _cancel_generation=False)
        with cancel_guard(model):
            decoder()
            decoder()
        self.assertEqual(decoder.calls, 2)
        self.assertEqual(decoder.hooks, [])

    def test_cancel_stops_at_next_call_and_clears_the_flag(self):
        decoder = _Decoder()
        model = types.SimpleNamespace(decoder=decoder, _cancel_generation=False)
        with self.assertRaises(InterruptedError):
            with cancel_guard(model):
                decoder()
                model._cancel_generation = True
                decoder()
        self.assertEqual(decoder.calls, 1)
        self.assertFalse(model._cancel_generation)
        self.assertEqual(decoder.hooks, [])

    def test_model_without_a_hookable_decoder_is_left_alone(self):
        model = types.SimpleNamespace(decoder=None, _cancel_generation=True)
        with cancel_guard(model):
            pass
        self.assertTrue(model._cancel_generation)


if __name__ == "__main__":
    unittest.main()
