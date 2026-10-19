"""LoRA operations of the handler while the DiT is streamed (small-card mode): see ``small_gpu_stream_lora``."""

import os
from typing import Any, Optional

from loguru import logger

from acestep.core.generation.handler import small_gpu_stream, small_gpu_stream_lora
from acestep.core.generation.handler.small_gpu_stream_lora import StreamLoraError, StreamLoraSet


def streaming() -> bool:
    return small_gpu_stream.active_pool() is not None


def _set(pool, create: bool = False) -> Optional[StreamLoraSet]:
    if pool is None:
        return None
    if pool.lora is None and create:
        pool.lora = StreamLoraSet(pool)
    return pool.lora


def _reset_flags(host: Any) -> None:
    host.lora_loaded = False
    host.use_lora = False
    host._adapter_type = None
    host.lora_scale = 1.0
    host._active_loras = {}
    host._lora_active_adapter = None


def has_streamed_adapters(host: Any) -> bool:
    lora = _set(small_gpu_stream.active_pool())
    return lora is not None and bool(lora.adapters)


def add(host: Any, lora_path: str, adapter_name: str) -> str:
    """Load an adapter into the streamed DiT. ``host`` is the handler."""
    pool = small_gpu_stream.active_pool()
    if pool is None:
        return "❌ The streamed DiT is not available."
    if not lora_path or not lora_path.strip():
        return "❌ Please provide a LoRA path."
    lora_path = lora_path.strip()
    if not os.path.isdir(lora_path):
        return f"❌ LoRA path not found: {lora_path}"
    from acestep.core.generation.handler.lora.lifecycle import _resolve_lokr_weights_path

    if _resolve_lokr_weights_path(lora_path) is not None:
        return "❌ LoKr adapters are not supported in small-card mode; use a LoRA adapter."
    lora = _set(pool, create=True)
    active = getattr(host, "_active_loras", None)
    if active is None:
        host._active_loras = active = {}
    if adapter_name in lora.adapters:
        return f"❌ Adapter name already in use: {adapter_name}. Use a different name or remove it first."
    try:
        adapter = small_gpu_stream_lora.load_adapter(adapter_name, lora_path, pool.param_names, pool.param_shapes, pool.count)
    except StreamLoraError as exc:
        return f"❌ Failed to load LoRA: {exc}"
    except Exception as exc:
        logger.exception("Failed to read the LoRA adapter")
        return f"❌ Failed to load LoRA: {exc}"
    lora.add(adapter)
    lora.set_enabled(True)
    host.lora_loaded = True
    host.use_lora = True
    host._adapter_type = "lora"
    host._lora_active_adapter = adapter_name
    active[adapter_name] = 1.0
    host.lora_scale = 1.0
    note = f" ({adapter.ignored} weight(s) outside the DiT blocks ignored)" if adapter.ignored else ""
    logger.info("[small_gpu_stream] LoRA '{}' loaded from {}: {} targets in {} blocks{}", adapter_name, lora_path,
                adapter.targets, len(adapter.layers), note)
    return f"✅ LoRA '{adapter_name}' loaded from {lora_path}{note}"


def remove(host: Any, adapter_name: str) -> str:
    lora = _set(small_gpu_stream.active_pool())
    active = getattr(host, "_active_loras", None) or {}
    if lora is None or adapter_name not in lora.adapters:
        return f"❌ Unknown adapter: {adapter_name}. Loaded: {list(active.keys())}"
    lora.remove(adapter_name)
    active.pop(adapter_name, None)
    if not lora.adapters:
        _reset_flags(host)
        logger.info("[small_gpu_stream] last LoRA removed, base model")
        return "✅ LoRA unloaded, using base model"
    host._lora_active_adapter = lora.active
    return f"✅ Adapter '{adapter_name}' removed. Active: {lora.active}"


def unload(host: Any) -> str:
    lora = _set(small_gpu_stream.active_pool())
    if lora is not None:
        lora.clear()
    _reset_flags(host)
    logger.info("[small_gpu_stream] LoRA unloaded, base model")
    return "✅ LoRA unloaded, using base model"


def set_scale(host: Any, adapter_name: str, scale: float) -> str:
    lora = _set(small_gpu_stream.active_pool())
    if lora is None or adapter_name not in lora.adapters:
        return f"❌ Adapter '{adapter_name}' not in loaded adapters: {list((getattr(host, '_active_loras', None) or {}).keys())}"
    lora.set_scale(adapter_name, scale)
    return f"✅ LoRA scale ({adapter_name}): {scale:.2f}" + ("" if host.use_lora else " (LoRA disabled)")


def set_use(host: Any, enabled: bool) -> str:
    lora = _set(small_gpu_stream.active_pool())
    if lora is not None:
        lora.set_enabled(enabled)
    return f"✅ LoRA {'enabled' if enabled else 'disabled'}"


def set_active(host: Any, adapter_name: str) -> str:
    lora = _set(small_gpu_stream.active_pool())
    if lora is None or adapter_name not in lora.adapters:
        return f"❌ Unknown adapter: {adapter_name}"
    lora.set_active(adapter_name)
    host._lora_active_adapter = adapter_name
    return f"✅ Active LoRA adapter: {adapter_name}"


def adapter_names() -> Optional[list]:
    lora = _set(small_gpu_stream.active_pool())
    return list(lora.adapters.keys()) if lora is not None and lora.adapters else None
