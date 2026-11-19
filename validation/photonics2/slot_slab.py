# SPDX-License-Identifier: GPL-3.0-or-later
"""Reference of WO-88 (sims/si-slot-slab.yaml): 1D slot waveguide (five-layer slab SiO2 / Si / slot / Si / SiO2), the
fundamental mode with E normal to the layers (TM of the slab, H = H_x(y) x^), which concentrates E_y in the low-index slot.

Exact dispersion relation by a transfer matrix on (u, v) = (H_x, (1/eps) dH_x/dy), both continuous at the interfaces
(Maxwell: E_z = -(j / (omega eps0)) (1/eps) dH_x/dy is tangential). Even mode about the slot centre: v(0) = 0.
Two closures:
  open    : semi-infinite cladding, v / u = -gamma_C / eps_C at the rail outer face (bound mode);
  walled  : the engine model, PEC walls at y = +-L (E_z = 0 -> v(L) = 0).
Roots by mpmath findroot (40 digits) and scipy brentq (double); the two must agree to 1e-13. The gate uses the walled
value (it is the exact solution of the modelled problem); the open value is reported (difference ~1e-10 or less).

Geometry and indices: rails 220 nm, slot 100 nm, n_H 3.48 (Si), n_S = n_C 1.44 (SiO2), lambda 1.55 um: the slot
waveguide dimensions and indices of Lipson et al., US patent 7,519,257 B2 (2009), used here for the 1D (slab) form.

Writes eval/expected/WO-88.json.
Run: cd validation && uv run python photonics2/slot_slab.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import mpmath as mp
from scipy.optimize import brentq

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, write_expected  # noqa: E402

LAM = 1.55e-6
N_H, N_S, N_C = 3.48, 1.44, 1.44
W_RAIL, W_SLOT = 220e-9, 100e-9
L = W_SLOT / 2 + W_RAIL + 2.5e-6     # sim window half height (params.L of sims/si-slot-slab.yaml)


def layers() -> list[tuple[float, float]]:
    return [(N_S**2, W_SLOT / 2), (N_H**2, W_RAIL), (N_C**2, L - W_SLOT / 2 - W_RAIL)]


def step(lib, eps, d, k2, u, v):
    """Transfer (u, v) = (H, H'/eps) over thickness d in a layer with kappa^2 = k2."""
    if k2 > 0:
        k = lib.sqrt(k2)
        c, s = lib.cos(k * d), lib.sin(k * d)
        return c * u + (eps / k) * s * v, -(k / eps) * s * u + c * v
    g = lib.sqrt(-k2)
    c, s = lib.cosh(g * d), lib.sinh(g * d)
    return c * u + (eps / g) * s * v, (g / eps) * s * u + c * v


def residual(lib, neff, closure: str):
    k0 = 2 * lib.pi / LAM
    b2 = (k0 * neff) ** 2
    u, v = lib.mpf(1) if lib is mp else 1.0, lib.mpf(0) if lib is mp else 0.0
    ls = layers()
    for i, (eps, d) in enumerate(ls):
        if closure == "open" and i == len(ls) - 1:
            g = lib.sqrt(b2 - k0**2 * eps)
            return v + (g / eps) * u   # v / u = -g / eps (decaying)
        u, v = step(lib, eps, d, k0**2 * eps - b2, u, v)
    eps, d = ls[-1]
    return v * lib.exp(-lib.sqrt(b2 - k0**2 * eps) * d)   # smooth scaling of the cladding growth


class _np:
    import math as _m
    pi = _m.pi
    sqrt, cos, sin, cosh, sinh, exp = _m.sqrt, _m.cos, _m.sin, _m.cosh, _m.sinh, _m.exp


def solve(closure: str) -> tuple[float, float]:
    # bracket the fundamental TM root: scan downward from the rail index
    xs = [N_H - 1e-9 - i * (N_H - N_C - 2e-9) / 4000 for i in range(4001)]
    fs = [residual(_np, x, closure) for x in xs]
    for i in range(len(xs) - 1):
        if fs[i] == 0 or fs[i] * fs[i + 1] < 0:
            a, b = xs[i + 1], xs[i]
            break
    else:
        raise RuntimeError("no root")
    r_d = brentq(lambda x: residual(_np, x, closure), a, b, xtol=1e-16, rtol=1e-15, maxiter=500)
    mp.mp.dps = 40
    r_m = mp.findroot(lambda x: residual(mp, x, closure), (mp.mpf(a), mp.mpf(b)), solver="illinois")
    return float(r_m), r_d


def main() -> int:
    out = {}
    for cl in ("walled", "open"):
        rm, rd = solve(cl)
        out[cl] = rm
        print(f"{cl:7s} n_eff mpmath {rm:.15f}  scipy {rd:.15f}  diff {abs(rm - rd):.2e}")
        assert abs(rm - rd) < 1e-13, "mpmath and scipy roots differ"
    print(f"walled - open: {out['walled'] - out['open']:.3e}")
    targets = [{"metric_id": "neff_0", "value": out["walled"], "unit": "1",
                "precision": {"method": "mpmath findroot 40 digits vs scipy brentq", "open_cladding_value": out["open"],
                              "walled_minus_open": out["walled"] - out["open"]}}]
    method = ("exact transfer-matrix dispersion relation of the five-layer slab, TM (H_x, E_y, E_z), even mode, PEC walls at "
              f"y = +-L (L = {L * 1e6:.3f} um, the sim window); rails {W_RAIL * 1e9:.0f} nm, slot {W_SLOT * 1e9:.0f} nm, n {N_H} / {N_S} / {N_C}, lambda {LAM * 1e6} um")
    p = write_expected("WO-88", "validation/photonics2/slot_slab.py", "cd validation && uv run python photonics2/slot_slab.py", method, targets)
    print("wrote", p.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
