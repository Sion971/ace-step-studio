"""Per-token timing of the 5Hz LM decoding loops, switched on with ``ACESTEP_LM_PROFILE=1``.

The loops are Python code that runs one token at a time, so a slow LM can come from the model itself or from what
surrounds it (masks, filters, the constrained-decoding automaton, synchronisations with the card). The profile tells
which: each ``lap`` waits for the card and adds the time since the previous one to a named bucket. The waiting makes a
profiled run a little slower than a normal one; it costs nothing when the variable is not set.
"""

import os
import time
from typing import Dict, Optional

import torch
from loguru import logger

ENV_PROFILE = "ACESTEP_LM_PROFILE"


def requested() -> bool:
    return os.environ.get(ENV_PROFILE, "").strip().lower() in ("1", "true", "yes", "on")


class StepProfile:
    def __init__(self, label: str, device, enabled: Optional[bool] = None):
        self.enabled = requested() if enabled is None else bool(enabled)
        self.label = label
        self.cuda = self.enabled and str(device).startswith("cuda") and torch.cuda.is_available()
        self.times: Dict[str, float] = {}
        self.tokens = 0
        self._start = 0.0
        self._last = 0.0

    def _wait(self) -> None:
        if self.cuda:
            try:
                torch.cuda.synchronize()
            except Exception:  # the card may be unusable: the timing is then only approximate
                pass

    def begin(self) -> None:
        if self.enabled:
            self._wait()
            self._start = self._last = time.perf_counter()

    def lap(self, name: str) -> None:
        if self.enabled:
            self._wait()
            now = time.perf_counter()
            self.times[name] = self.times.get(name, 0.0) + (now - self._last)
            self._last = now

    def step(self) -> None:
        if self.enabled:
            self.tokens += 1

    def text(self) -> str:
        total = sum(self.times.values())
        if not self.tokens or total <= 0:
            return ""
        parts = " | ".join(f"{name} {value * 1000 / self.tokens:.1f} ms ({100 * value / total:.0f}%)"
                           for name, value in sorted(self.times.items(), key=lambda kv: -kv[1]))
        return (f"[lm_profile] {self.label}: {self.tokens} tokens in {total:.2f} s ({total * 1000 / self.tokens:.1f} ms per token, "
                f"the card is waited for at each measure) | per token: {parts}")

    def report(self) -> None:
        if self.enabled:
            line = self.text()
            if line:
                logger.info(line)
