"""Machine-readable download events for the Studio.

The Studio server reads the pipeline's standard output only: stderr, where tqdm draws its progress bars, is
inherited by the terminal. While a model downloads, the server therefore cannot tell which download is running,
when it ends, or how far it got. This module prints one JSON object per line, after a marker, on standard output.

It prints NOTHING unless the Studio asks for it (``ACESTEP_STUDIO_EVENTS=1``, set when the Studio spawns the
pipeline), so a standalone ACE-Step keeps its usual output.

Events (``component`` is ``main`` for the VAE + text encoder bundle, otherwise the model folder name):

* ``start``  -- a download begins;
* ``bytes``  -- cumulative bytes seen on huggingface_hub's byte progress bars (``done``, ``total``, ``files``);
* ``end``    -- the download ended (``ok``, ``seconds``, ``error`` when it failed).

About ``bytes``: it is measured, not assumed. With the Xet client (huggingface_hub 0.36.2 + hf_xet) the updates
arrive in bursts -- nothing for 17 s, then 64 MiB, then the rest at once for a 337 MB file -- and the partial file
on disk stays at 0 bytes until the download ends. The numbers are exact but irregular: a consumer must not turn
them into a smooth bar or a precise remaining time.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from contextlib import contextmanager

MARKER = "[studio-download] "
ENV_FLAG = "ACESTEP_STUDIO_EVENTS"

_install_lock = threading.Lock()
_active_observer = None


def enabled() -> bool:
    """True when the Studio asked for events."""
    return os.environ.get(ENV_FLAG) == "1"


def emit(event: str, component: str, **fields) -> None:
    """Print one event line, never raising."""
    if not enabled():
        return
    payload = {"event": event, "component": component, "t": round(time.time(), 3)}
    payload.update({key: value for key, value in fields.items() if value is not None})
    try:
        sys.stdout.write(MARKER + json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:  # noqa: BLE001 - a broken stdout must never break a download
        pass


class _ByteObserver:
    """Wraps huggingface_hub's progress bar class while a download runs and reports the byte bars."""

    def __init__(self, component: str, min_interval: float):
        self.component = component
        self.min_interval = min_interval
        self._bars: dict = {}
        self._lock = threading.Lock()
        self._last = (-1, -1)
        self._last_emit = 0.0
        self._restore = None

    # -- installation ---------------------------------------------------------------------------
    def install(self) -> bool:
        global _active_observer
        with _install_lock:
            if _active_observer is not None:
                return False  # nested use: the outer observer already sees everything
            try:
                from huggingface_hub.utils import tqdm as bar_class
            except Exception:  # noqa: BLE001
                return False
            if not isinstance(bar_class, type):
                return False
            original = (bar_class.__init__, bar_class.update, bar_class.close)
            observer = self

            def init(self, *args, **kwargs):
                info = {
                    "unit": kwargs.get("unit"),
                    "total": kwargs.get("total"),
                    "n": kwargs.get("initial") or 0,
                }
                original[0](self, *args, **kwargs)
                observer._register(id(self), info)

            def update(self, n=1):
                observer._advance(id(self), n)
                return original[1](self, n)

            def close(self):
                observer._maybe_emit(force=True)
                return original[2](self)

            bar_class.__init__, bar_class.update, bar_class.close = init, update, close

            def restore():
                bar_class.__init__, bar_class.update, bar_class.close = original

            self._restore = restore
            _active_observer = self
            return True

    def uninstall(self) -> None:
        global _active_observer
        with _install_lock:
            if self._restore is not None:
                try:
                    self._restore()
                finally:
                    self._restore = None
                    if _active_observer is self:
                        _active_observer = None

    # -- bookkeeping ----------------------------------------------------------------------------
    def _register(self, key, info) -> None:
        if info.get("unit") != "B":
            return  # the "Fetching N files" bar counts files, not bytes
        with self._lock:
            self._bars[key] = info
        self._maybe_emit()

    def _advance(self, key, n) -> None:
        with self._lock:
            bar = self._bars.get(key)
            if bar is None or not n:
                return
            bar["n"] += n
        self._maybe_emit()

    def _maybe_emit(self, force: bool = False) -> None:
        now = time.monotonic()
        with self._lock:
            if not self._bars:
                return
            done = sum(bar["n"] for bar in self._bars.values())
            total = sum(bar["total"] or 0 for bar in self._bars.values())
            files = len(self._bars)
            if (done, total) == self._last:
                return
            if not force and now - self._last_emit < self.min_interval:
                return
            self._last = (done, total)
            self._last_emit = now
        emit("bytes", self.component, done=int(done), total=int(total), files=files)

    def finish(self) -> None:
        try:
            self._maybe_emit(force=True)
        finally:
            self.uninstall()


@contextmanager
def observe_bytes(component: str, min_interval: float = 1.0):
    """Report the bytes seen on huggingface_hub's progress bars while the block runs. Never raises."""
    if not enabled():
        yield
        return
    observer = _ByteObserver(component, min_interval)
    installed = False
    try:
        installed = observer.install()
    except Exception:  # noqa: BLE001
        installed = False
    try:
        yield
    finally:
        if installed:
            try:
                observer.finish()
            except Exception:  # noqa: BLE001
                pass


def tracked(component: str, action, **fields):
    """Run ``action()`` between a ``start`` and an ``end`` event, observing bytes. Returns its result.

    ``action`` returns either a ``(success, message)`` tuple, as the downloader functions do, or any value.
    Exceptions are re-raised after the ``end`` event.
    """
    emit("start", component, **fields)
    started = time.monotonic()
    try:
        with observe_bytes(component):
            result = action()
    except BaseException as exc:
        emit("end", component, ok=False, seconds=round(time.monotonic() - started, 1), error=str(exc)[:300])
        raise
    if isinstance(result, tuple) and result:
        ok, message = bool(result[0]), (str(result[1]) if len(result) > 1 else "")
    else:
        ok, message = bool(result) if result is not None else True, ""
    emit(
        "end",
        component,
        ok=ok,
        seconds=round(time.monotonic() - started, 1),
        error=None if ok else message[:300],
    )
    return result
