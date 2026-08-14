"""Flow-matching ODE/SDE samplers for ACE-Step diffusion.

All samplers operate on the flow-matching ODE:  dx/dt = v(x, t)
where t goes from 1.0 (pure noise) to 0.0 (clean signal).

Each sampler function receives the current state and returns the updated state.
The model evaluation (decoder call + CFG) is done externally; samplers only
handle the numerical integration step.
"""

import math
from typing import Optional, List

import torch


# ---------------------------------------------------------------------------
# Timestep schedule generators (schedulers)
# ---------------------------------------------------------------------------

def schedule_linear(n_steps: int, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    """Uniform linear schedule from 1.0 to 0.0."""
    return torch.linspace(1.0, 0.0, n_steps + 1, device=device, dtype=dtype)


def schedule_karras(n_steps: int, device: torch.device, dtype: torch.dtype,
                    sigma_min: float = 0.002, sigma_max: float = 1.0, rho: float = 7.0) -> torch.Tensor:
    """Karras-style schedule: more steps near t=0 (the detail region).

    Adapted from Karras et al. 2022 for flow-matching (t ∈ [0,1] instead of sigma).
    """
    ramp = torch.linspace(0, 1, n_steps + 1, device=device, dtype=dtype)
    min_inv_rho = sigma_min ** (1 / rho)
    max_inv_rho = sigma_max ** (1 / rho)
    t = (max_inv_rho + ramp * (min_inv_rho - max_inv_rho)) ** rho
    # Clamp to [0, 1] and ensure endpoints
    t = t.clamp(0.0, 1.0)
    t[0] = 1.0
    t[-1] = 0.0
    return t


def schedule_cosine(n_steps: int, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    """Cosine schedule: smooth transition with more steps in the middle."""
    ramp = torch.linspace(0, 1, n_steps + 1, device=device, dtype=dtype)
    t = 0.5 * (1.0 + torch.cos(ramp * math.pi))
    t[0] = 1.0
    t[-1] = 0.0
    return t


def schedule_beta(n_steps: int, device: torch.device, dtype: torch.dtype,
                  alpha: float = 0.6, beta: float = 0.6) -> torch.Tensor:
    """Beta-distribution schedule: configurable concentration at endpoints.

    alpha < 1, beta < 1 → more steps near both ends (U-shaped)
    alpha > 1, beta > 1 → more steps in the middle
    alpha < 1, beta > 1 → more steps near t=1 (start)
    alpha > 1, beta < 1 → more steps near t=0 (end/detail)
    """
    ramp = torch.linspace(0, 1, n_steps + 1, device=device, dtype=dtype)
    # Approximate beta CDF via the regularized incomplete beta function
    # Use simple power-law approximation for efficiency
    t = 1.0 - torch.pow(ramp, alpha) / (torch.pow(ramp, alpha) + torch.pow(1.0 - ramp, beta))
    # Handle NaN at endpoints
    t[0] = 1.0
    t[-1] = 0.0
    return t


def apply_shift(t: torch.Tensor, shift: float) -> torch.Tensor:
    """Apply shift transformation to any schedule: t' = shift*t / (1 + (shift-1)*t)."""
    if shift != 1.0:
        t = shift * t / (1 + (shift - 1) * t)
    return t


def schedule_sway(n_steps: int, device: torch.device, dtype: torch.dtype,
                  sway: float = -1.0) -> torch.Tensor:
    """Sway Sampling schedule (from F5-TTS, ACL 2025).

    Concentrates steps in the early high-curvature phase:
      t' = t + sway * (cos(π/2 * t) - 1 + t)
    With sway=-1 (default), more steps near t=1 (noise end).
    """
    ramp = torch.linspace(0, 1, n_steps + 1, device=device, dtype=dtype)
    t = 1.0 - ramp  # 1.0 → 0.0
    t = t + sway * (torch.cos(math.pi / 2.0 * t) - 1.0 + t)
    t = t.clamp(0.0, 1.0)
    t[0] = 1.0
    t[-1] = 0.0
    return t


def schedule_logit_normal(n_steps: int, device: torch.device, dtype: torch.dtype,
                          mu: float = 0.0, sigma: float = 1.0) -> torch.Tensor:
    """Logit-Normal schedule (SD3/FLUX training distribution).

    Concentrates steps around t≈0.5 (mid-noise), where model error is highest.
    t = sigmoid(N(μ, σ²)) mapped to quantiles.
    """
    # Use quantiles of the logit-normal distribution
    ramp = torch.linspace(0.001, 0.999, n_steps + 1, device=device, dtype=dtype)
    # Inverse sigmoid = logit, then apply normal CDF shift
    logit_vals = torch.log(ramp / (1.0 - ramp))
    t = 1.0 - torch.sigmoid(logit_vals * sigma + mu)
    t = t.clamp(0.0, 1.0)
    t[0] = 1.0
    t[-1] = 0.0
    return t


def schedule_laplace(n_steps: int, device: torch.device, dtype: torch.dtype,
                     mu: float = 0.0, beta: float = 0.5) -> torch.Tensor:
    """Laplace schedule — best-performing in Hang et al. (ICCV 2025).

    Heavier tails than logit-normal: 26.6% FID improvement over cosine.
    Samples λ from Laplace distribution, mapped to timesteps.
    """
    ramp = torch.linspace(0.001, 0.999, n_steps + 1, device=device, dtype=dtype)
    # Inverse CDF of Laplace: mu - beta * sign(p-0.5) * ln(1 - 2|p-0.5|)
    p = ramp
    laplace_vals = mu - beta * torch.sign(p - 0.5) * torch.log(1.0 - 2.0 * torch.abs(p - 0.5) + 1e-10)
    t = torch.sigmoid(-laplace_vals)  # Map to [0,1] descending
    t = t.clamp(0.0, 1.0)
    t[0] = 1.0
    t[-1] = 0.0
    return t


def build_schedule(scheduler_type: str, n_steps: int, shift: float,
                   device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    """Build a timestep schedule by name.

    Args:
        scheduler_type: One of the supported scheduler types.
        n_steps: Number of diffusion steps.
        shift: Shift parameter (1.0 = no shift).
        device: Torch device.
        dtype: Torch dtype.

    Returns:
        Tensor of shape (n_steps + 1,) from 1.0 → 0.0.
    """
    builders = {
        "linear": schedule_linear,
        "karras": schedule_karras,
        "cosine": schedule_cosine,
        "beta": schedule_beta,
        "sway": schedule_sway,
        "logit_normal": schedule_logit_normal,
        "laplace": schedule_laplace,
    }
    builder = builders.get(scheduler_type, schedule_linear)
    t = builder(n_steps, device, dtype)
    return apply_shift(t, shift)


# ---------------------------------------------------------------------------
# Sampler step functions
# ---------------------------------------------------------------------------
# Convention:
#   vt       = velocity at current point (after CFG, clamping, EMA)
#   xt       = current latent state
#   t_curr   = current timestep (float scalar)
#   t_prev   = next timestep (float scalar, closer to 0)
#   dt       = t_curr - t_prev (positive)
#   bsz      = batch size
#   model_fn = callable(x, t) -> velocity  (for multi-eval samplers)

def euler_step(xt: torch.Tensor, vt: torch.Tensor,
               t_curr: float, t_prev: float,
               bsz: int, device: torch.device, dtype: torch.dtype,
               **kwargs) -> torch.Tensor:
    """First-order Euler step: x_{t-1} = x_t - v_t * dt."""
    dt = t_curr - t_prev
    dt_tensor = dt * torch.ones((bsz,), device=device, dtype=dtype).unsqueeze(-1).unsqueeze(-1)
    return xt - vt * dt_tensor


def midpoint_step(xt: torch.Tensor, vt: torch.Tensor,
                  t_curr: float, t_prev: float,
                  bsz: int, device: torch.device, dtype: torch.dtype,
                  model_fn=None, **kwargs) -> torch.Tensor:
    """Second-order Midpoint method (RK2 variant).

    1. Euler half-step to midpoint: x_mid = x_t - v_t * (dt/2)
    2. Evaluate model at midpoint: v_mid = model(x_mid, t_mid)
    3. Full step using midpoint velocity: x_{t-1} = x_t - v_mid * dt
    """
    dt = t_curr - t_prev
    dt_tensor = dt * torch.ones((bsz,), device=device, dtype=dtype).unsqueeze(-1).unsqueeze(-1)
    t_mid = (t_curr + t_prev) / 2.0
    # Half Euler step to midpoint
    x_mid = xt - vt * (dt_tensor * 0.5)
    # Evaluate at midpoint
    v_mid = model_fn(x_mid, t_mid)
    return xt - v_mid * dt_tensor


def rk4_step(xt: torch.Tensor, vt: torch.Tensor,
             t_curr: float, t_prev: float,
             bsz: int, device: torch.device, dtype: torch.dtype,
             model_fn=None, **kwargs) -> torch.Tensor:
    """Classical 4th-order Runge-Kutta.

    4 model evaluations per step for maximum accuracy.
    k1 = v(x, t)            — already computed as vt
    k2 = v(x - k1*dt/2, t - dt/2)
    k3 = v(x - k2*dt/2, t - dt/2)
    k4 = v(x - k3*dt, t - dt)
    x_{t-1} = x_t - (k1 + 2*k2 + 2*k3 + k4) * dt/6
    """
    dt = t_curr - t_prev
    dt_tensor = dt * torch.ones((bsz,), device=device, dtype=dtype).unsqueeze(-1).unsqueeze(-1)
    t_mid = (t_curr + t_prev) / 2.0

    k1 = vt
    k2 = model_fn(xt - k1 * (dt_tensor * 0.5), t_mid)
    k3 = model_fn(xt - k2 * (dt_tensor * 0.5), t_mid)
    k4 = model_fn(xt - k3 * dt_tensor, t_prev)

    return xt - (k1 + 2 * k2 + 2 * k3 + k4) * (dt_tensor / 6.0)


def bogacki_step(xt: torch.Tensor, vt: torch.Tensor,
                 t_curr: float, t_prev: float,
                 bsz: int, device: torch.device, dtype: torch.dtype,
                 model_fn=None, **kwargs) -> torch.Tensor:
    """Bogacki-Shampine 3rd-order method (3 model evaluations).

    A popular embedded RK method; we use the 3rd-order solution.
    """
    dt = t_curr - t_prev
    dt_tensor = dt * torch.ones((bsz,), device=device, dtype=dtype).unsqueeze(-1).unsqueeze(-1)

    k1 = vt
    t2 = t_curr - dt * 0.5
    k2 = model_fn(xt - k1 * (dt_tensor * 0.5), t2)
    t3 = t_curr - dt * 0.75
    k3 = model_fn(xt - k2 * (dt_tensor * 0.75), t3)

    # 3rd-order solution: x_{n+1} = x_n - dt * (2/9*k1 + 1/3*k2 + 4/9*k3)
    return xt - dt_tensor * (2.0 / 9.0 * k1 + 1.0 / 3.0 * k2 + 4.0 / 9.0 * k3)


def deis_step(xt: torch.Tensor, vt: torch.Tensor,
              t_curr: float, t_prev: float,
              bsz: int, device: torch.device, dtype: torch.dtype,
              prev_velocities: Optional[List[torch.Tensor]] = None,
              **kwargs) -> torch.Tensor:
    """DEIS-inspired multistep solver (uses velocity history).

    Uses up to 3 previous velocity evaluations for higher-order extrapolation.
    Falls back to Euler when no history is available.
    Single model evaluation per step after warmup.
    """
    dt = t_curr - t_prev
    dt_tensor = dt * torch.ones((bsz,), device=device, dtype=dtype).unsqueeze(-1).unsqueeze(-1)

    if prev_velocities is None or len(prev_velocities) == 0:
        # 1st-order (Euler)
        return xt - vt * dt_tensor
    elif len(prev_velocities) == 1:
        # 2nd-order Adams-Bashforth
        return xt - dt_tensor * (1.5 * vt - 0.5 * prev_velocities[-1])
    elif len(prev_velocities) == 2:
        # 3rd-order Adams-Bashforth
        return xt - dt_tensor * (
            23.0 / 12.0 * vt
            - 16.0 / 12.0 * prev_velocities[-1]
            + 5.0 / 12.0 * prev_velocities[-2]
        )
    else:
        # 4th-order Adams-Bashforth
        return xt - dt_tensor * (
            55.0 / 24.0 * vt
            - 59.0 / 24.0 * prev_velocities[-1]
            + 37.0 / 24.0 * prev_velocities[-2]
            - 9.0 / 24.0 * prev_velocities[-3]
        )


def ipndm_step(xt: torch.Tensor, vt: torch.Tensor,
               t_curr: float, t_prev: float,
               bsz: int, device: torch.device, dtype: torch.dtype,
               prev_velocities: Optional[List[torch.Tensor]] = None,
               **kwargs) -> torch.Tensor:
    """iPNDM (Improved Pseudo Numerical Methods for Diffusion).

    Currently uses the same Adams-Bashforth coefficients as DEIS.
    Both produce identical results. Kept as separate entry for UI clarity
    and future differentiation (iPNDM-specific coefficients from
    Zhang & Chen 2022 could be implemented here).
    """
    return deis_step(xt, vt, t_curr, t_prev, bsz, device, dtype,
                     prev_velocities=prev_velocities)


def dopri5_step(xt: torch.Tensor, vt: torch.Tensor,
                t_curr: float, t_prev: float,
                bsz: int, device: torch.device, dtype: torch.dtype,
                model_fn=None, **kwargs) -> torch.Tensor:
    """Dormand-Prince 5th-order method (7 stages, FSAL).

    The most battle-tested adaptive solver for neural ODEs.
    Here used as fixed-step (7 model evals per step, 5th-order accuracy).
    """
    dt = t_curr - t_prev
    dt_t = dt * torch.ones((bsz,), device=device, dtype=dtype).unsqueeze(-1).unsqueeze(-1)

    # Dormand-Prince coefficients (Butcher tableau)
    k1 = vt
    k2 = model_fn(xt - k1 * (dt_t * 1.0/5.0), t_curr - dt * 1.0/5.0)
    k3 = model_fn(xt - (k1 * 3.0/40.0 + k2 * 9.0/40.0) * dt_t, t_curr - dt * 3.0/10.0)
    k4 = model_fn(xt - (k1 * 44.0/45.0 - k2 * 56.0/15.0 + k3 * 32.0/9.0) * dt_t, t_curr - dt * 4.0/5.0)
    k5 = model_fn(xt - (k1 * 19372.0/6561.0 - k2 * 25360.0/2187.0 + k3 * 64448.0/6561.0 - k4 * 212.0/729.0) * dt_t, t_curr - dt * 8.0/9.0)
    k6 = model_fn(xt - (k1 * 9017.0/3168.0 - k2 * 355.0/33.0 + k3 * 46732.0/5247.0 + k4 * 49.0/176.0 - k5 * 5103.0/18656.0) * dt_t, t_prev)

    # 5th-order solution
    return xt - dt_t * (35.0/384.0 * k1 + 500.0/1113.0 * k3 + 125.0/192.0 * k4 - 2187.0/6784.0 * k5 + 11.0/84.0 * k6)


def a2s_step(xt: torch.Tensor, vt: torch.Tensor,
             t_curr: float, t_prev: float,
             bsz: int, device: torch.device, dtype: torch.dtype,
             model_fn=None, **kwargs) -> torch.Tensor:
    """Acceleration-Aware Sampling (A²S) — 2nd order at 2 NFE cost.

    From A²S (2025): decomposes acceleration into temporal and spatial
    components. Evaluates at mid-interval for temporal correction,
    then applies smooth time-dependent gain for spatial correction.
    Achieves 2nd-order accuracy with just 2 model evaluations.
    """
    dt = t_curr - t_prev
    dt_t = dt * torch.ones((bsz,), device=device, dtype=dtype).unsqueeze(-1).unsqueeze(-1)
    t_mid = (t_curr + t_prev) / 2.0

    # 1. Mid-interval velocity evaluation (temporal acceleration correction)
    x_mid = xt - vt * (dt_t * 0.5)
    v_mid = model_fn(x_mid, t_mid)

    # 2. Smooth gain for spatial acceleration: g(t) = (1 - t_curr) / (1 - t_mid + 1e-8)
    gain = max((1.0 - t_curr), 1e-8) / max((1.0 - t_mid), 1e-8)
    gain = min(gain, 2.0)  # Clamp for stability

    # 3. Corrected step: blend mid-velocity with gain-adjusted original
    v_corrected = (1.0 - gain) * vt + gain * v_mid
    return xt - v_corrected * dt_t


def pingpong_step(xt: torch.Tensor, vt: torch.Tensor,
                  t_curr: float, t_prev: float,
                  bsz: int, device: torch.device, dtype: torch.dtype,
                  model_fn=None, **kwargs) -> torch.Tensor:
    """PingPong sampler — predictor-corrector via trapezoidal rule.

    Euler predict → evaluate at predicted point → average velocities.
    Equivalent to Heun but framed as forward prediction + backward correction.
    Good for temporal coherence in music generation. 2 NFE per step.
    """
    dt = t_curr - t_prev
    dt_t = dt * torch.ones((bsz,), device=device, dtype=dtype).unsqueeze(-1).unsqueeze(-1)

    # Forward: Euler step
    x_forward = xt - vt * dt_t

    # Reverse: evaluate at next position and correct
    v_next = model_fn(x_forward, t_prev)

    # Average forward and reverse velocities (trapezoidal rule)
    v_avg = 0.5 * (vt + v_next)
    return xt - v_avg * dt_t


# Registry of available samplers
SAMPLER_REGISTRY = {
    "euler": {"fn": euler_step, "order": 1, "model_evals": 1, "needs_model_fn": False, "needs_history": False},
    "heun": {"fn": None, "order": 2, "model_evals": 2, "needs_model_fn": True, "needs_history": False},  # kept inline
    "midpoint": {"fn": midpoint_step, "order": 2, "model_evals": 2, "needs_model_fn": True, "needs_history": False},
    "rk4": {"fn": rk4_step, "order": 4, "model_evals": 4, "needs_model_fn": True, "needs_history": False},
    "bogacki": {"fn": bogacki_step, "order": 3, "model_evals": 3, "needs_model_fn": True, "needs_history": False},
    "dopri5": {"fn": dopri5_step, "order": 5, "model_evals": 6, "needs_model_fn": True, "needs_history": False},
    "a2s": {"fn": a2s_step, "order": 2, "model_evals": 2, "needs_model_fn": True, "needs_history": False},
    "pingpong": {"fn": pingpong_step, "order": 2, "model_evals": 2, "needs_model_fn": True, "needs_history": False},
    "deis": {"fn": deis_step, "order": "1-4", "model_evals": 1, "needs_model_fn": False, "needs_history": True},
    "ipndm": {"fn": ipndm_step, "order": "1-4", "model_evals": 1, "needs_model_fn": False, "needs_history": True},
}

SCHEDULER_TYPES = ["linear", "karras", "cosine", "beta", "sway", "logit_normal", "laplace"]
SAMPLER_MODES = list(SAMPLER_REGISTRY.keys())
