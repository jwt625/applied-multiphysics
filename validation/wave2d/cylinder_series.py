# SPDX-License-Identifier: GPL-3.0-or-later
"""Reference values for the wave2d cylinder gates (DevLog-042 G-a1, G-a2, G-e).

Plane wave u_inc = U0 exp(-j k0 x) (time convention exp(+j omega t), as in Balanis, Advanced Engineering
Electromagnetics, 2nd ed. 2012, ch. 11) on an infinite circular cylinder of radius a. Jacobi-Anger:
exp(-j k rho cos phi) = sum_n j^-n J_n(k rho) exp(j n phi). Scattered field u_s = U0 sum_n j^-n c_n H_n^(2)(k0 rho) e^{j n phi}:
  Dirichlet (TM PEC, sound-soft):  c_n = -J_n(k0 a) / H_n(k0 a)          (Balanis 2nd ed. sec. 11.5.1, TM^z)
  Neumann  (TE PEC, sound-hard):   c_n = -J_n'(k0 a) / H_n'(k0 a)        (Balanis 2nd ed. sec. 11.5.1, TE^z)
  penetrable (continuity of u and a du/drho at rho = a; a = 1/mu_r for TM, 1/eps_r for TE; inside d_n J_n(k1 rho)):
    c_n = (a1 k1 J_n(k0a) J_n'(k1a) - a0 k0 J_n'(k0a) J_n(k1a)) / (a0 k0 H_n'(k0a) J_n(k1a) - a1 k1 H_n(k0a) J_n'(k1a))
    d_n = (J_n(k0a) + c_n H_n(k0a)) / J_n(k1a)
Far field (H_n^(2)(x) ~ sqrt(2/(pi x)) exp(-j(x - n pi/2 - pi/4))): sigma_2D(phi) = (4/k0) |sum_n c_n e^{j n phi}|^2;
total scattering width W_s = (4/k0) sum |c_n|^2; optical theorem (lossless): W_ext = -(4/k0) Re sum c_n = W_s.

Independent routes: scipy.special and mpmath (50 digits) must agree to 1e-12 relative; the optical theorem must hold
to 1e-12. Output: validation/wave2d/cylinder_reference.json (consumed by packages/physics/test/wave2d-scatter.test.ts).

Run: cd validation && OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 uv run python wave2d/cylinder_series.py
"""

import json
import math
from pathlib import Path

import mpmath as mp
import numpy as np
from scipy import special as sp

mp.mp.dps = 50

LAMBDA0 = 1.0  # m (test geometry; results depend on k0 a only)
K0 = 2 * math.pi / LAMBDA0
A = 0.5  # m, cylinder radius: k0 a = pi
NMAX = 40


def coeffs_scipy(kind, eps1=1.0, pol="TM"):
    n = np.arange(-NMAX, NMAX + 1)
    x0 = K0 * A
    J, Jp = sp.jv(n, x0), sp.jvp(n, x0)
    H, Hp = sp.hankel2(n, x0), sp.h2vp(n, x0)
    if kind == "dirichlet":
        return n, -J / H, None
    if kind == "neumann":
        return n, -Jp / Hp, None
    k1 = K0 * math.sqrt(eps1)
    a0, a1 = (1.0, 1.0) if pol == "TM" else (1.0, 1.0 / eps1)
    x1 = k1 * A
    J1, J1p = sp.jv(n, x1), sp.jvp(n, x1)
    c = (a1 * k1 * J * J1p - a0 * K0 * Jp * J1) / (a0 * K0 * Hp * J1 - a1 * k1 * H * J1p)
    d = (J + c * H) / J1
    return n, c, d


def coeffs_mpmath(kind, eps1=1.0, pol="TM"):
    out_c, out_d = [], []
    x0 = mp.mpf(K0) * A
    for n in range(-NMAX, NMAX + 1):
        J = mp.besselj(n, x0)
        Jp = mp.besselj(n, x0, derivative=1)
        H = mp.besselj(n, x0) - 1j * mp.bessely(n, x0)
        Hp = mp.besselj(n, x0, derivative=1) - 1j * mp.bessely(n, x0, derivative=1)
        if kind == "dirichlet":
            out_c.append(-J / H)
            continue
        if kind == "neumann":
            out_c.append(-Jp / Hp)
            continue
        k1 = mp.mpf(K0) * mp.sqrt(eps1)
        a0, a1 = (1, 1) if pol == "TM" else (1, mp.mpf(1) / eps1)
        x1 = k1 * A
        J1, J1p = mp.besselj(n, x1), mp.besselj(n, x1, derivative=1)
        c = (a1 * k1 * J * J1p - a0 * K0 * Jp * J1) / (a0 * K0 * Hp * J1 - a1 * k1 * H * J1p)
        out_c.append(c)
        out_d.append((J + c * H) / J1)
    c = np.array([complex(v) for v in out_c])
    d = np.array([complex(v) for v in out_d]) if out_d else None
    return c, d


def field_total(n, c, d, rho, phi, eps1=1.0):
    """total u / U0 at (rho, phi)"""
    jn = (1j) ** (-n.astype(float))
    if rho >= A:
        terms = jn * (sp.jv(n, K0 * rho) + c * sp.hankel2(n, K0 * rho)) * np.exp(1j * n * phi)
    else:
        if d is None:
            return 0j
        terms = jn * d * sp.jv(n, K0 * math.sqrt(eps1) * rho) * np.exp(1j * n * phi)
    return complex(terms.sum())


def sigma2d(n, c, phi):
    return float(4 / K0 * abs((c * np.exp(1j * n * phi)).sum()) ** 2)


CASES = [
    ("pec_tm", "dirichlet", 1.0, "TM"),
    ("pec_te", "neumann", 1.0, "TE"),
    ("diel_tm", "pen", 4.0, "TM"),
    ("diel_te", "pen", 4.0, "TE"),
]
PROBES = [(1.0, 0.0), (1.0, math.pi / 2), (1.0, math.pi), (0.75, math.pi / 4), (0.25, 0.0), (0.25, math.pi / 2)]


def main():
    out = {"lambda0_m": LAMBDA0, "a_m": A, "k0a": K0 * A, "nmax": NMAX, "time_convention": "exp(+j omega t)",
           "incident": "U0 exp(-j k0 x), U0 = 1", "cases": {}}
    for name, kind, eps1, pol in CASES:
        n, c, d = coeffs_scipy(kind, eps1, pol)
        cm, dm = coeffs_mpmath(kind, eps1, pol)
        dev = float(np.max(np.abs(c - cm)) / np.max(np.abs(c)))
        devd = float(np.max(np.abs(d - dm)) / np.max(np.abs(d))) if d is not None else 0.0
        assert dev < 1e-12 and devd < 1e-11, (name, dev, devd)
        ws = 4 / K0 * float(np.sum(np.abs(c) ** 2))
        wext = -4 / K0 * float(np.sum(c).real)
        assert abs(ws - wext) < 1e-12 * ws, (name, ws, wext)
        assert np.max(np.abs(c[-5:])) < 1e-25  # series converged
        probes = []
        for rho, phi in PROBES:
            if rho < A and d is None:
                continue
            u = field_total(n, c, d, rho, phi, eps1)
            probes.append({"rho": rho, "phi": phi, "re": u.real, "im": u.imag, "abs": abs(u)})
        out["cases"][name] = {
            "kind": kind, "eps_r": eps1, "polarization": pol,
            "sigma2d_back_m": sigma2d(n, c, math.pi), "sigma2d_fwd_m": sigma2d(n, c, 0.0),
            "sigma2d_90_m": sigma2d(n, c, math.pi / 2), "sigma2d_total_m": ws,
            "scipy_vs_mpmath_rel": max(dev, devd), "optical_theorem_rel": abs(ws - wext) / ws,
            "probes": probes,
        }
        print(f"{name}: back {sigma2d(n, c, math.pi):.10g} m, fwd {sigma2d(n, c, 0):.10g} m, total {ws:.10g} m, "
              f"scipy-mpmath {max(dev, devd):.1e}, optical theorem {abs(ws - wext) / ws:.1e}")
    Path(__file__).with_name("cylinder_reference.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
