"""Tests for moving torchao-quantized DiT weights between devices.

GPUs with compute capability < 7 (Pascal and older) get the ``w8a8_dynamic`` scheme from ACE-Step. torchao wraps
the weights in a ``LinearActivationQuantizedTensor``, which ``_is_quantized_tensor`` did not recognise: the move
fell into the generic ``param.data.to(device)`` branch and failed inside ``torch.inference_mode()`` with
"Cannot set version_counter for inference tensor" (reproduced on a GTX 1050).

The recognition tests run anywhere. The move tests need a CUDA device and torchao, and mirror the real
conditions: quantization on the CPU, then ``_recursive_to_device`` inside ``torch.inference_mode()``, in both
directions and twice (ACE-Step offloads the DiT to the CPU after each diffusion).
"""

import copy
import importlib
import unittest
from unittest.mock import patch

import torch

_PKG = "acestep.core.generation.handler"
_BASIC = importlib.import_module(f"{_PKG}.init_service_memory_basic")

try:
    from torchao.quantization.linear_activation_quantized_tensor import LinearActivationQuantizedTensor  # noqa: F401

    _HAS_TORCHAO = True
except Exception:  # pragma: no cover - depends on the environment
    _HAS_TORCHAO = False

_HAS_CUDA = bool(torch.cuda.is_available())
_DIM = 256


class _FakeAffine:
    """Stand-in for torchao's AffineQuantizedTensor."""


class _FakeWrapper:
    """Stand-in for torchao's LinearActivationQuantizedTensor."""


class _RecognitionHost(_BASIC.InitServiceMemoryBasicMixin):
    """Minimal host exposing the recognition helpers."""


class QuantizedTensorRecognitionTests(unittest.TestCase):
    """``_is_quantized_tensor`` must recognise both torchao quantized tensor types."""

    def _host(self, affine=_FakeAffine, wrapper=_FakeWrapper):
        host = _RecognitionHost()
        for name, cls in (
            ("_get_affine_quantized_tensor_class", affine),
            ("_get_linear_activation_quantized_tensor_class", wrapper),
        ):
            patcher = patch.object(_RecognitionHost, name, staticmethod(lambda c=cls: c))
            patcher.start()
            self.addCleanup(patcher.stop)
        return host

    def test_affine_tensor_is_recognised(self):
        """It keeps recognising AffineQuantizedTensor (int8_weight_only)."""
        self.assertTrue(self._host()._is_quantized_tensor(_FakeAffine()))

    def test_linear_activation_wrapper_is_recognised(self):
        """It recognises the wrapper built by w8a8_dynamic (the Pascal default)."""
        self.assertTrue(self._host()._is_quantized_tensor(_FakeWrapper()))

    def test_plain_objects_and_none_are_not_quantized(self):
        """It does not claim ordinary parameters or None."""
        host = self._host()
        self.assertFalse(host._is_quantized_tensor(object()))
        self.assertFalse(host._is_quantized_tensor(None))

    def test_missing_wrapper_class_keeps_previous_behaviour(self):
        """Without the wrapper class, only the affine type is recognised, as before."""
        host = self._host(wrapper=None)
        self.assertTrue(host._is_quantized_tensor(_FakeAffine()))
        self.assertFalse(host._is_quantized_tensor(_FakeWrapper()))

    def test_missing_affine_class_still_recognises_wrapper(self):
        """A torchao without the affine class must not hide the wrapper type."""
        host = self._host(affine=None)
        self.assertTrue(host._is_quantized_tensor(_FakeWrapper()))
        self.assertFalse(host._is_quantized_tensor(_FakeAffine()))

    def test_no_torchao_classes_at_all(self):
        """With neither class available nothing is reported as quantized."""
        host = self._host(affine=None, wrapper=None)
        self.assertFalse(host._is_quantized_tensor(_FakeAffine()))
        self.assertFalse(host._is_quantized_tensor(_FakeWrapper()))


@unittest.skipUnless(_HAS_TORCHAO, "torchao is not installed")
class RealTorchaoRecognitionTests(unittest.TestCase):
    """The real torchao weights must be recognised."""

    @staticmethod
    def _quantized_weight(scheme):
        from torchao.quantization import quantize_

        layer = torch.nn.Linear(64, 64)
        if scheme == "int8_weight_only":
            from torchao.quantization import Int8WeightOnlyConfig

            config = Int8WeightOnlyConfig()
        else:
            from torchao.quantization import Int8DynamicActivationInt8WeightConfig, MappingType

            config = Int8DynamicActivationInt8WeightConfig(act_mapping_type=MappingType.ASYMMETRIC)
        quantize_(layer, config)
        return layer.weight

    def test_int8_weight_only_weight_is_recognised(self):
        """It recognises the weight produced by int8_weight_only."""
        self.assertTrue(_RecognitionHost()._is_quantized_tensor(self._quantized_weight("int8_weight_only")))

    def test_w8a8_dynamic_weight_is_recognised(self):
        """It recognises the weight produced by w8a8_dynamic (this failed before the fix)."""
        self.assertTrue(_RecognitionHost()._is_quantized_tensor(self._quantized_weight("w8a8_dynamic")))

    def test_plain_weight_is_not_recognised(self):
        """It does not claim an unquantized weight."""
        self.assertFalse(_RecognitionHost()._is_quantized_tensor(torch.nn.Linear(8, 8).weight))


def _toy_model():
    """A tiny DiT-like model; the ``decoder`` name matters to ACE-Step's quantization filter."""

    class Block(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.attn = torch.nn.Linear(_DIM, _DIM)
            self.ff1 = torch.nn.Linear(_DIM, 4 * _DIM)
            self.ff2 = torch.nn.Linear(4 * _DIM, _DIM)

        def forward(self, x):
            return x + self.attn(x) + self.ff2(torch.nn.functional.gelu(self.ff1(x)))

    class Toy(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.decoder = torch.nn.ModuleList([Block() for _ in range(4)])

        def forward(self, x):
            for block in self.decoder:
                x = block(x)
            return x

    torch.manual_seed(0)
    return Toy()


@unittest.skipUnless(_HAS_TORCHAO and _HAS_CUDA, "needs torchao and a CUDA device")
class QuantizedMoveOnCudaTests(unittest.TestCase):
    """Move quantized weights CPU -> CUDA -> CPU -> CUDA inside ``torch.inference_mode()``."""

    @classmethod
    def setUpClass(cls):
        catalog = importlib.import_module(f"{_PKG}.init_service_catalog")
        loader = importlib.import_module(f"{_PKG}.init_service_loader")
        transfer = importlib.import_module(f"{_PKG}.init_service_memory_transfer")

        class Host(
            catalog.InitServiceCatalogMixin,
            loader.InitServiceLoaderMixin,
            _BASIC.InitServiceMemoryBasicMixin,
            transfer.InitServiceMemoryTransferMixin,
        ):
            """The ACE-Step pieces involved, without the rest of the handler."""

            def __init__(self, model):
                self.model = model
                self.device = "cuda"

        cls.Host = Host

    def _round_trips(self, scheme):
        reference = _toy_model()
        sample = torch.randn(2, 32, _DIM)
        with torch.no_grad():
            expected = reference(sample)
        model = copy.deepcopy(reference).to(torch.float16)
        host = self.Host(model)
        host._apply_dit_quantization(scheme)
        with torch.inference_mode():  # service_generate is decorated with @torch.inference_mode()
            for round_number in (1, 2):
                host._recursive_to_device(model, "cuda", torch.float16)
                self.assertTrue(
                    all(p.device.type == "cuda" for p in model.parameters()),
                    f"{scheme}: parameters left off CUDA after the move (round {round_number})",
                )
                got = model(sample.to("cuda", torch.float16)).float().cpu()
                relative_error = ((got - expected).norm() / expected.norm()).item()
                self.assertLess(relative_error, 0.05, f"{scheme}: result drifted (round {round_number})")
                host._recursive_to_device(model, "cpu", torch.float16)
                self.assertTrue(
                    all(p.device.type == "cpu" for p in model.parameters()),
                    f"{scheme}: parameters left on CUDA after the offload (round {round_number})",
                )

    def test_int8_weight_only_round_trips(self):
        """Control: the scheme used on Ampere and newer keeps working."""
        self._round_trips("int8_weight_only")

    def test_w8a8_dynamic_round_trips(self):
        """The Pascal default must move to the GPU and back, twice, and still compute correctly."""
        self._round_trips("w8a8_dynamic")


if __name__ == "__main__":
    unittest.main()
