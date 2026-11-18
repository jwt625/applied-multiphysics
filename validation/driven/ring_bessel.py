# SPDX-License-Identifier: GPL-3.0-or-later
"""Resonances of an isolated 2D dielectric ring (annulus), TM (u = E_z), for the ring-resonator example, DevLog-047.

Ring of index n_s between radii R_i and R_o in a cladding of index n_c (2D, infinite along z), time convention
exp(+j omega t). Whispering-gallery mode of azimuthal order m: E_z = f(r) exp(-j m phi) with
  r < R_i: A J_m(k_c r);  R_i < r < R_o: B J_m(k_s r) + C Y_m(k_s r);  r > R_o: D H_m^(2)(k_c r) (outgoing),
k_c = n_c k0, k_s = n_s k0. TM with mu_r = 1: E_z and dE_z/dr continuous at R_i and R_o, so the 4 x 4 determinant
  | J(k_c R_i)       -J(k_s R_i)       -Y(k_s R_i)        0              |
  | k_c J'(k_c R_i)  -k_s J'(k_s R_i)  -k_s Y'(k_s R_i)   0              |
  | 0                 J(k_s R_o)        Y(k_s R_o)       -H(k_c R_o)     |
  | 0                 k_s J'(k_s R_o)   k_s Y'(k_s R_o)  -k_c H'(k_c R_o) |
vanishes at a complex k0 = (omega_r + j omega_i) / c0 (omega_i > 0: the mode decays in time by radiation). Resonance
wavelength lambda_m = 2 pi / Re(k0); radiation Q = Re(k0) / (2 Im(k0)). The boundary-value problem and the Bessel
solutions are textbook (e.g. Balanis, Advanced Engineering Electromagnetics, 2nd ed. 2012, ch. 11 for the cylindrical
wave functions); the determinant is derived here and is the reference.

Routes: mpmath findroot (40 digits) and a scipy-based Newton iteration on the same determinant (double precision);
they must agree to 1e-10 in k0. Output: validation/driven/ring_reference.json (resonances m, lambda_m, Q_rad, FSR).
Run: cd validation && OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 uv run python driven/ring_bessel.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import mpmath as mp
import numpy as np
from scipy import special as sp

mp.mp.dps = 40

# inputs (must equal sims/ring-resonator-bus.yaml), lengths in um
N_S, N_C = 3.4767, 1.4444
R_MID, W = 2.0, 0.24
R_I, R_O = R_MID - W / 2, R_MID + W / 2
LAM_WINDOW = (1.45, 1.70)


def det_mp(m: int, k0):
    kc, ks = N_C * k0, N_S * k0

    def J(z):
        return mp.besselj(m, z)

    def Y(z):
        return mp.bessely(m, z)

    def Jp(z):
        return (mp.besselj(m - 1, z) - mp.besselj(m + 1, z)) / 2

    def Yp(z):
        return (mp.bessely(m - 1, z) - mp.bessely(m + 1, z)) / 2

    def H(z):
        return J(z) - 1j * Y(z)

    def Hp(z):
        return Jp(z) - 1j * Yp(z)

    M = mp.matrix([
        [J(kc * R_I), -J(ks * R_I), -Y(ks * R_I), 0],
        [kc * Jp(kc * R_I), -ks * Jp(ks * R_I), -ks * Yp(ks * R_I), 0],
        [0, J(ks * R_O), Y(ks * R_O), -H(kc * R_O)],
        [0, ks * Jp(ks * R_O), ks * Yp(ks * R_O), -kc * Hp(kc * R_O)],
    ])
    # scale: Y_m grows fast for large m at small argument; normalise each column by its largest entry
    for j in range(4):
        s = max(abs(M[i, j]) for i in range(4))
        for i in range(4):
            M[i, j] /= s
    return mp.det(M)


def det_np(m: int, k0: complex) -> complex:
    kc, ks = N_C * k0, N_S * k0
    J, Y = (lambda z: sp.jv(m, z)), (lambda z: sp.yv(m, z))
    Jp, Yp = (lambda z: sp.jvp(m, z)), (lambda z: sp.yvp(m, z))
    H, Hp = (lambda z: sp.hankel2(m, z)), (lambda z: sp.h2vp(m, z))
    M = np.array([
        [J(kc * R_I), -J(ks * R_I), -Y(ks * R_I), 0],
        [kc * Jp(kc * R_I), -ks * Jp(ks * R_I), -ks * Yp(ks * R_I), 0],
        [0, J(ks * R_O), Y(ks * R_O), -H(kc * R_O)],
        [0, ks * Jp(ks * R_O), ks * Yp(ks * R_O), -kc * Hp(kc * R_O)],
    ], dtype=complex)
    M /= np.max(np.abs(M), axis=0)[None, :]
    return complex(np.linalg.det(M))


def newton_np(m: int, k: complex) -> complex:
    for _ in range(60):
        h = 1e-7 * abs(k)
        f = det_np(m, k)
        d = (det_np(m, k + h) - det_np(m, k - h)) / (2 * h)
        step = f / d
        k -= step
        if abs(step) < 1e-15 * abs(k):
            break
    return k


def slab_neff(lam: float) -> float:
    """TE-like (E_z along the slab) fundamental mode of the straight Si strip of width W: guess for the ring roots."""
    k0 = 2 * math.pi / lam

    def f(n):
        kx, g = k0 * math.sqrt(N_S**2 - n**2), k0 * math.sqrt(n**2 - N_C**2)
        return math.tan(kx * W / 2) - g / kx

    lo, hi = N_C + 1e-9, N_S - 1e-9
    a, b = lo, hi
    # bracket the fundamental (largest n) root
    ns = np.linspace(lo, hi, 4001)
    vals = [f(n) for n in ns]
    for i in range(len(ns) - 1, 0, -1):
        if np.sign(vals[i]) != np.sign(vals[i - 1]) and abs(vals[i]) < 1e3 and abs(vals[i - 1]) < 1e3:
            a, b = ns[i - 1], ns[i]
            break
    for _ in range(200):
        c = 0.5 * (a + b)
        if np.sign(f(c)) == np.sign(f(a)):
            a = c
        else:
            b = c
    return 0.5 * (a + b)


def main() -> int:
    n0 = slab_neff(1.55)
    out = []
    m_lo = int(math.floor(2 * math.pi * R_MID * n0 / LAM_WINDOW[1])) - 3
    m_hi = int(math.ceil(2 * math.pi * R_MID * n0 / LAM_WINDOW[0])) + 3
    for m in range(m_lo, m_hi + 1):
        k_guess = m / (R_MID * n0 * 1.0)
        try:
            k_mp = complex(mp.findroot(lambda k: det_mp(m, k), mp.mpc(k_guess, 1e-6)))
        except Exception as e:  # noqa: BLE001
            print("m", m, "no root", e)
            continue
        k_np = newton_np(m, k_mp * (1 + 1e-6))
        agree = abs(k_np - k_mp) / abs(k_mp)
        lam = 2 * math.pi / k_mp.real
        if not (LAM_WINDOW[0] - 0.1 < lam < LAM_WINDOW[1] + 0.1):
            continue
        q = k_mp.real / (2 * k_mp.imag) if k_mp.imag > 0 else float("inf")
        print(f"m {m}: lambda {lam:.9f} um, Im k0 {k_mp.imag:.3e}, Q_rad {q:.4g}, routes {agree:.1e}")
        assert agree < 1e-10, agree
        out.append({"m": m, "k0_re_per_um": k_mp.real, "k0_im_per_um": k_mp.imag, "lambda_um": lam, "Q_rad": q, "route_agreement": agree})
    out.sort(key=lambda r: r["lambda_um"])
    for a, b in zip(out, out[1:]):
        a["fsr_to_next_um"] = b["lambda_um"] - a["lambda_um"]
    doc = {
        "generator": "validation/driven/ring_bessel.py",
        "inputs": {"n_ring": N_S, "n_clad": N_C, "R_mid_um": R_MID, "width_um": W, "polarization": "TM (E_z)"},
        "straight_strip_neff_1550": n0,
        "resonances": out,
    }
    (Path(__file__).resolve().parent / "ring_reference.json").write_text(json.dumps(doc, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
