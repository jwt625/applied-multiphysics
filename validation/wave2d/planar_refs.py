# SPDX-License-Identifier: GPL-3.0-or-later
"""Planar reference values for the wave2d gates (DevLog-042 G-b2, G-d). Time convention exp(+j omega t).

1. Dielectric slab at normal incidence (G-b2): slab eps2 of thickness t in eps1, scalar u with a = 1/mu_r (TM, u = E_z)
   or a = 1/eps_r (TE, u = H_z). Interface coefficient r12 = (a1 k1 - a2 k2)/(a1 k1 + a2 k2) (continuity of u and
   a du/dx; Born and Wolf, Principles of Optics, 7th ed., sec. 1.5.2 for the Fresnel form, sec. 1.6.4 for the film):
     r = r12 (1 - e^{-2 j d}) / (1 - r12^2 e^{-2 j d}),  tau = (1 - r12^2) e^{-j d} / (1 - r12^2 e^{-2 j d}),  d = k2 t,
   with r referred to the front face and tau from the front face to the back face. Route 2: 2 x 2 transfer matrix of
   (u, a du/dx) across the slab; both must agree to 1e-13 and |r|^2 + |tau|^2 = 1 (lossless).
2. Symmetric slab waveguide between PEC walls (G-d), TM (E_z out of plane, mu_r = 1): core |y| < w/2 (eps_c), cladding
   w/2 < |y| < H (eps_0), E_z(+-H) = 0. Fundamental (even) mode with beta > k0 n_0: E_z = cos(kc y) in the core,
   A sinh(g (H - |y|)) in the cladding, kc^2 = k0^2 eps_c - beta^2, g^2 = beta^2 - k0^2 eps_0:
     kc tan(kc w / 2) = g coth(g (H - w/2)).
   Route 1: scipy brentq; route 2: mpmath findroot (40 digits); agree to 1e-12.

Output: validation/wave2d/planar_reference.json. Run: cd validation && uv run python wave2d/planar_refs.py
"""

import cmath
import json
import math
from pathlib import Path

import mpmath as mp
from scipy.optimize import brentq

mp.mp.dps = 40
K0 = 2 * math.pi  # lambda0 = 1 m


def slab_closed(eps1, eps2, t, pol):
    k1, k2 = K0 * math.sqrt(eps1), K0 * math.sqrt(eps2)
    a1, a2 = (1.0, 1.0) if pol == "TM" else (1 / eps1, 1 / eps2)
    r12 = (a1 * k1 - a2 * k2) / (a1 * k1 + a2 * k2)
    e2 = cmath.exp(-2j * k2 * t)
    r = r12 * (1 - e2) / (1 - r12**2 * e2)
    tau = (1 - r12**2) * cmath.exp(-1j * k2 * t) / (1 - r12**2 * e2)
    return r, tau


def slab_tmm(eps1, eps2, t, pol):
    """transfer matrix of (u, a u') across the slab; outside: u = e^{-jk1 x} + r e^{jk1 x} (x<0), tau e^{-jk1 (x-t)} (x>t)"""
    k1, k2 = K0 * math.sqrt(eps1), K0 * math.sqrt(eps2)
    a1, a2 = (1.0, 1.0) if pol == "TM" else (1 / eps1, 1 / eps2)
    c, s = cmath.cos(k2 * t), cmath.sin(k2 * t)
    # [u; q](t) = M [u; q](0), q = a u', for u'' + k2^2 u = 0
    M = [[c, s / (a2 * k2)], [-a2 * k2 * s, c]]
    # unknowns r, tau: u(0) = 1 + r, q(0) = -j a1 k1 (1 - r); u(t) = tau, q(t) = -j a1 k1 tau
    # tau = M00 (1 + r) + M01 (-j a1 k1)(1 - r);  -j a1 k1 tau = M10 (1 + r) + M11 (-j a1 k1)(1 - r)
    z = -1j * a1 * k1
    # linear system A [r, tau] = b
    A = [[M[0][0] - M[0][1] * z, -1.0], [M[1][0] - M[1][1] * z, -z]]
    b = [-(M[0][0] + M[0][1] * z), -(M[1][0] + M[1][1] * z)]
    det = A[0][0] * A[1][1] - A[0][1] * A[1][0]
    r = (b[0] * A[1][1] - A[0][1] * b[1]) / det
    tau = (A[0][0] * b[1] - b[0] * A[1][0]) / det
    return r, tau


def wg_beta(eps_c, eps_0, w, H):
    def f(beta):
        kc = math.sqrt(K0**2 * eps_c - beta**2)
        g = math.sqrt(beta**2 - K0**2 * eps_0)
        return kc * math.tan(kc * w / 2) - g / math.tanh(g * (H - w / 2))

    # fundamental even mode: kc w / 2 in (0, pi/2): f -> +inf as kc w/2 -> pi/2, f < 0 as kc -> 0
    lo = max(math.sqrt(K0**2 * eps_c - (math.pi / w) ** 2), K0 * math.sqrt(eps_0)) * (1 + 1e-9)
    hi = K0 * math.sqrt(eps_c) * (1 - 1e-12)
    b1 = brentq(f, lo, hi, xtol=1e-15, rtol=1e-15)

    def fm(beta):
        kc = mp.sqrt(mp.mpf(K0) ** 2 * eps_c - beta**2)
        g = mp.sqrt(beta**2 - mp.mpf(K0) ** 2 * eps_0)
        return kc * mp.tan(kc * w / 2) - g * mp.coth(g * (H - mp.mpf(w) / 2))

    b2 = float(mp.findroot(fm, b1))
    assert abs(b1 - b2) < 1e-12 * b1, (b1, b2)
    return b1, abs(b1 - b2) / b1


def main():
    out = {"lambda0_m": 1.0, "time_convention": "exp(+j omega t)", "slab": {}, "waveguide": {}}
    for pol in ("TM", "TE"):
        r, tau = slab_closed(1.0, 4.0, 0.3, pol)
        r2, tau2 = slab_tmm(1.0, 4.0, 0.3, pol)
        dev = max(abs(r - r2), abs(tau - tau2))
        assert dev < 1e-13, (pol, dev)
        assert abs(abs(r) ** 2 + abs(tau) ** 2 - 1) < 1e-14
        out["slab"][pol] = {"eps1": 1.0, "eps2": 4.0, "t_m": 0.3, "r_re": r.real, "r_im": r.imag, "tau_re": tau.real, "tau_im": tau.imag,
                            "closed_vs_tmm": dev}
        print(f"slab {pol}: r = {r:.12f}, tau = {tau:.12f}, closed vs TMM {dev:.1e}")
    b, dev = wg_beta(4.0, 1.0, 0.5, 1.5)
    out["waveguide"] = {"eps_core": 4.0, "eps_clad": 1.0, "w_m": 0.5, "H_m": 1.5, "polarization": "TM (E_z), PEC walls at y = +-H",
                        "beta_1_per_m": b, "neff": b / K0, "brentq_vs_mpmath": dev}
    print(f"waveguide: beta = {b:.12f} 1/m, neff = {b / K0:.12f}, brentq vs mpmath {dev:.1e}")
    Path(__file__).with_name("planar_reference.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
