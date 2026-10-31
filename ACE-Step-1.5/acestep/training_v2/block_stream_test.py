"""Equivalence tests for block streaming, on the CPU with a small model shaped like the DiT (a stack of blocks with frozen
weights, a frozen scale-shift table, and LoRA-style trainable matrices with dropout).

Run:  python3 -m acestep.training_v2.block_stream_test     (from the ACE-Step-1.5 folder)
"""

import copy

import torch
import torch.nn as nn
import torch.nn.functional as F

try:
    from acestep.training_v2 import block_stream as bs
except ImportError:  # run next to the module
    import block_stream as bs


class LoraLinear(nn.Module):
    """Frozen base weight + trainable low-rank pair, like a PEFT LoRA layer."""

    def __init__(self, dim, rank=4, dropout=0.1):
        super().__init__()
        self.base_layer = nn.Linear(dim, dim, bias=False)
        self.lora_A = nn.Linear(dim, rank, bias=False)
        self.lora_B = nn.Linear(rank, dim, bias=False)
        self.drop = nn.Dropout(dropout)
        nn.init.normal_(self.lora_B.weight, std=0.05)  # non zero so that the gradients of both matrices are non zero

    def forward(self, x):
        return self.base_layer(x) + self.lora_B(self.lora_A(self.drop(x))) * 2.0


class Block(nn.Module):
    """Same call shape as AceStepDiTLayer: positional tensors, tuples, None, extra kwargs."""

    def __init__(self, dim):
        super().__init__()
        self.norm = nn.LayerNorm(dim)
        self.q = LoraLinear(dim)
        self.v = LoraLinear(dim)
        self.mlp = nn.Sequential(nn.Linear(dim, 2 * dim), nn.GELU(), nn.Linear(2 * dim, dim))
        self.scale_shift_table = nn.Parameter(torch.randn(1, 2, dim) / dim**0.5)
        self.register_buffer("rope_like", torch.linspace(0.5, 1.5, dim))
        self.gradient_checkpointing = True  # like transformers' GradientCheckpointingLayer

    def forward(self, hidden_states, position_embeddings, temb, attention_mask=None, flag=False, **kwargs):
        cos, sin = position_embeddings
        shift, scale = (self.scale_shift_table + temb.unsqueeze(1)).chunk(2, dim=1)
        h = self.norm(hidden_states) * (1 + scale) + shift
        h = h * self.rope_like
        a = F.scaled_dot_product_attention(self.q(h)[:, None], self.v(h)[:, None], self.v(h)[:, None])[:, 0]
        hidden_states = hidden_states + a * cos + sin
        hidden_states = hidden_states + self.mlp(self.norm(hidden_states))
        return (hidden_states,)


class Stack(nn.Module):
    def __init__(self, dim=16, n=4):
        super().__init__()
        self.layers = nn.ModuleList([Block(dim) for _ in range(n)])
        self.out = nn.Linear(dim, dim)

    def forward(self, x, temb):
        pe = (torch.ones(1, dtype=x.dtype), torch.zeros(1, dtype=x.dtype))
        for layer in self.layers:
            x = layer(x, pe, temb, None, False)[0]
        return self.out(x)


def make(seed=0):
    torch.manual_seed(seed)
    model = Stack()
    for name, p in model.named_parameters():
        p.requires_grad = ("lora_" in name) or name.startswith("out.")  # frozen base, trainable adapters (+ head)
    model.train()
    return model


def run(model, steps=2, seed=123):
    torch.manual_seed(seed)
    losses, grads = [], None
    x = torch.randn(2, 8, 16)
    temb = torch.randn(2, 16)
    tgt = torch.randn(2, 8, 16)
    for _ in range(steps):
        for p in model.parameters():
            p.grad = None
        loss = F.mse_loss(model(x, temb), tgt)
        loss.backward()
        losses.append(loss.item())
        grads = {n: p.grad.clone() for n, p in model.named_parameters() if p.grad is not None}
    return losses, grads


def test_same_losses_and_gradients_as_a_normal_run():
    ref = make()
    streamed = copy.deepcopy(ref)
    ref_losses, ref_grads = run(ref)

    n = bs.enable_block_streaming(streamed.layers, "cpu", pin=False, copier=lambda t: t.detach().clone())
    assert n == 4
    s_losses, s_grads = run(streamed)

    assert ref_losses == s_losses
    assert ref_grads.keys() == s_grads.keys()
    assert any("lora_A" in k for k in ref_grads)
    for k in ref_grads:
        assert torch.equal(ref_grads[k], s_grads[k]), k


def test_frozen_weights_are_loaded_twice_per_step_and_released():
    model = make()
    loads = []

    def copier(t):
        loads.append(t.shape)
        return t.detach().clone()

    bs.enable_block_streaming(model.layers, "cpu", pin=False, copier=copier)
    frozen_per_block = len(bs._frozen_params(model.layers[0])) + len(bs._frozen_buffers(model.layers[0]))
    run(model, steps=1)
    assert len(loads) == 2 * 4 * frozen_per_block  # forward + recompute, for 4 blocks

    # after the step the modules hold their own tensors again (no copy left behind)
    for layer in model.layers:
        for module in layer.modules():
            for name, p in module._parameters.items():
                assert p is None or isinstance(p, nn.Parameter), name


def test_parameter_names_and_state_dict_do_not_change():
    ref = make()
    streamed = copy.deepcopy(ref)
    bs.enable_block_streaming(streamed.layers, "cpu", pin=False)
    assert list(ref.state_dict().keys()) == list(streamed.state_dict().keys())
    assert [n for n, _ in ref.named_parameters()] == [n for n, _ in streamed.named_parameters()]


def test_no_double_checkpointing_and_idempotent():
    model = make()
    assert bs.enable_block_streaming(model.layers, "cpu", pin=False) == 4
    assert bs.enable_block_streaming(model.layers, "cpu", pin=False) == 0  # second call changes nothing
    assert all(layer.gradient_checkpointing is False for layer in model.layers)


def test_eval_and_no_grad_run_without_checkpoint():
    ref = make()
    streamed = copy.deepcopy(ref)
    bs.enable_block_streaming(streamed.layers, "cpu", pin=False, copier=lambda t: t.detach().clone())
    ref.eval()
    streamed.eval()
    x, temb = torch.randn(2, 8, 16), torch.randn(2, 16)
    with torch.no_grad():
        assert torch.equal(ref(x, temb), streamed(x, temb))


def test_disable_restores_the_normal_forward():
    model = make()
    bs.enable_block_streaming(model.layers, "cpu", pin=False)
    assert bs.disable_block_streaming(model.layers) == 4
    assert all("forward" not in layer.__dict__ for layer in model.layers)


def test_works_when_the_card_copy_is_a_different_object_with_a_dtype_change():
    """The real card copy has another device (and maybe dtype): the block must only use the copies it is given."""
    ref = make()
    streamed = copy.deepcopy(ref)
    seen = []

    def copier(t):
        c = t.detach().clone()
        seen.append(c)
        return c

    bs.enable_block_streaming(streamed.layers, "cpu", pin=False, copier=copier)
    # poison the CPU originals: if the block read them instead of the copies, the results would differ
    originals = {}
    for i, layer in enumerate(streamed.layers):
        for module in layer.modules():
            for name, p in module._parameters.items():
                if p is not None and not p.requires_grad:
                    originals[(i, id(module), name)] = p.data.clone()
    ref_losses, _ = run(ref, steps=1)
    s_losses, _ = run(streamed, steps=1)
    assert ref_losses == s_losses
    assert len(seen) > 0


def test_the_block_really_reads_the_copies_not_the_originals():
    model = make()
    bs.enable_block_streaming(model.layers, "cpu", pin=False, copier=lambda t: t.detach().clone())
    checked = []
    for layer in model.layers:
        original = layer.mlp[0].weight
        assert isinstance(original, nn.Parameter)

        def hook(module, args, _orig=original):
            w = module.weight
            checked.append(True)
            assert w is not _orig and not isinstance(w, nn.Parameter) and w.requires_grad is False

        layer.mlp[0].register_forward_pre_hook(hook)
    run(model, steps=1)
    assert len(checked) == 2 * 4  # forward + recompute, 4 blocks


def test_bfloat16_matches_a_normal_bfloat16_run():
    ref = make().to(torch.bfloat16)
    streamed = copy.deepcopy(ref)
    bs.enable_block_streaming(streamed.layers, "cpu", pin=False, copier=lambda t: t.detach().clone())

    def go(model):
        torch.manual_seed(7)
        x = torch.randn(2, 8, 16).bfloat16()
        temb = torch.randn(2, 16).bfloat16()
        tgt = torch.randn(2, 8, 16).bfloat16()
        loss = F.mse_loss(model(x, temb), tgt)
        loss.backward()
        return loss.item(), {n: p.grad.clone() for n, p in model.named_parameters() if p.grad is not None}

    l1, g1 = go(ref)
    l2, g2 = go(streamed)
    assert l1 == l2 and g1.keys() == g2.keys()
    assert all(torch.equal(g1[k], g2[k]) for k in g1)


def test_find_layers_and_move_outside_layers():
    class Wrapped(nn.Module):  # looks like a PEFT / Fabric wrapper
        def __init__(self, inner):
            super().__init__()
            self._forward_module = inner

    model = make()
    model.register_buffer("rope_outside", torch.ones(3))
    assert bs.find_layers(Wrapped(model)) is model.layers
    inside_before = [p.data_ptr() for p in model.layers.parameters()]
    n = bs.move_outside_layers(model, model.layers, "cpu")
    assert n == 0  # already on the target device
    assert inside_before == [p.data_ptr() for p in model.layers.parameters()]


def test_keep_layers_unwrapped_resets_the_flag():
    model = make()
    bs.enable_block_streaming(model.layers, "cpu", pin=False)
    for layer in model.layers:
        layer.gradient_checkpointing = True  # what gradient_checkpointing_enable() does
    bs.keep_layers_unwrapped(model.layers)
    assert all(layer.gradient_checkpointing is False for layer in model.layers)


if __name__ == "__main__":
    import sys

    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok  ", name)
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print("FAIL", name, type(exc).__name__, exc)
    sys.exit(1 if failed else 0)
