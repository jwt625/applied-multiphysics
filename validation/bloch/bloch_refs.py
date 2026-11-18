# SPDX-License-Identifier: GPL-3.0-or-later
"""Reference values for the Bloch / Floquet gates of wave2d (DevLog-050 s.1.5). Time convention exp(+j omega t).
Scalar field u (TM: u = E_z, a = 1/mu_r = 1; TE: u = H_z, a = 1/eps_r), lambda0 and lengths in metres, c0 = 299792458
m/s (SI defining constant). Frequencies in Hz.

1. Bragg stack (G-B2): layers eps1 (thickness d1) and eps2 (d2) alternating along x, period ax = d1 + d2, unit cell
   [0, ax] x [0, ay] periodic in x (Bloch K) and in y (Bloch ky, folded: qy = ky + 2 pi m / ay). In each layer
   q_i^2 = eps_i k0^2 - qy^2 and continuity of u and a du/dx gives the Bloch dispersion
     cos(K ax) = cos(q1 d1) cos(q2 d2) - (1/2) (p1/p2 + p2/p1) sin(q1 d1) sin(q2 d2),   p_i = a_i q_i
   (Yariv and Yeh, Optical Waves in Crystals, 1984, ch. 6; equation number not checked offline: the derivation here
   is the reference). Written with C_i = cos(q_i d_i) and S_i = sin(q_i d_i) / q_i, which are even in q_i, the right
   side is C1 C2 - (1/2) (a1/a2 q1^2 + a2/a1 q2^2) S1 S2: real also for evanescent layers (q_i^2 < 0).
   Route 1: this closed form; route 2: half the trace of the product of the two 2 x 2 transfer matrices of (u, a du/dx)
   (complex arithmetic). Roots in omega by bracketing on a fine grid and brentq, per fold index m; the lowest 8 over
   all m are the bands. Routes must agree to 1e-12 at every root.
2. Oblique slab (G-B4): slab eps_s, thickness t, in vacuum, plane wave at angle theta from the slab normal. Along the
   normal s (into the slab) u ~ exp(-j kx x) f(s), kx = k0 sin(theta), q0 = k0 cos(theta), qs = k0 sqrt(eps_s -
   sin^2 theta). Interface r01 = (p0 - ps)/(p0 + ps), p = a q; Airy film (Born and Wolf, Principles of Optics, 7th ed.,
   sec. 1.6.4; equation numbers not checked offline):
     r = r01 (1 - e^{-2 j qs t}) / (1 - r01^2 e^{-2 j qs t}),   tau = (1 - r01^2) e^{-j qs t} / (1 - r01^2 e^{-2 j qs t}),
   r referred to the front face (s = 0), tau from the front face to the back face (s = t). Route 2: 2 x 2 transfer
   matrix; routes agree to 1e-13; |r|^2 + |tau|^2 = 1 (lossless).
3. Rod lattice band table (G-B3, informative): plane-wave expansion TM of validation/c/gen_pwe.py (function `bands`,
   imported unchanged) on the MPB tutorial path (Gamma-X-M-Gamma, 4 interpolated points), r 0.2 a, eps 12, 8 bands,
   cut-offs nmax 20 and 24; the change between them is the PWE floor.

Output: validation/bloch/bloch_reference.json. Run: cd validation && uv run python bloch/bloch_refs.py
"""

from __future__ import annotations

import cmath
import datetime
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import brentq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "c"))
from gen_pwe import bands as pwe_bands  # noqa: E402
from gen_pwe import path as pwe_path  # noqa: E402

C0 = 299792458.0
OUT = Path(__file__).resolve().parent / "bloch_reference.json"


# ---- 1. Bragg stack ----------------------------------------------------------------------------------------------
def cs(q2: float, d: float) -> tuple[float, float]:
    """cos(q d) and sin(q d)/q for q^2 = q2 (real for either sign)."""
    if q2 >= 0:
        q = math.sqrt(q2)
        return math.cos(q * d), (math.sin(q * d) / q if q > 0 else d)
    g = math.sqrt(-q2)
    return math.cosh(g * d), math.sinh(g * d) / g


def rhs_closed(k0, qy, L):
    (e1, d1, a1), (e2, d2, a2) = L
    q1s, q2s = e1 * k0 * k0 - qy * qy, e2 * k0 * k0 - qy * qy
    c1, s1 = cs(q1s, d1)
    c2, s2 = cs(q2s, d2)
    return c1 * c2 - 0.5 * (a1 / a2 * q1s + a2 / a1 * q2s) * s1 * s2


def rhs_matrix(k0, qy, L):
    m = np.eye(2, dtype=complex)
    for e, d, a in L:
        q = cmath.sqrt(e * k0 * k0 - qy * qy)
        c = cmath.cos(q * d)
        s = cmath.sin(q * d) / q if abs(q) > 0 else d
        # (u, a u') at s = d from s = 0
        m = np.array([[c, s / a], [-a * q * q * s, c]]) @ m
    return 0.5 * (m[0, 0] + m[1, 1])


def bragg_bands(K, ky, ax, ay, L, nb=8, fmax=None):
    roots = []
    for mfold in range(-6, 7):
        qy = ky + 2 * math.pi * mfold / ay

        def fn(f, qy=qy):
            return rhs_closed(2 * math.pi * f / C0, qy, L) - math.cos(K * ax)

        fs = np.linspace(1e-6 * fmax, fmax, 40001)
        vals = np.array([fn(f) for f in fs])
        for i in range(len(fs) - 1):
            if vals[i] == 0 or vals[i] * vals[i + 1] < 0:
                r = brentq(fn, fs[i], fs[i + 1], xtol=1e-15 * fmax, rtol=1e-15)
                chk = abs(rhs_closed(2 * math.pi * r / C0, qy, L) - rhs_matrix(2 * math.pi * r / C0, qy, L).real)
                roots.append((r, mfold, chk))
    roots.sort()
    return roots[:nb]


# ---- 2. oblique slab ---------------------------------------------------------------------------------------------
def slab(eps_s, t, theta_deg, pol, lam=1.0):
    k0 = 2 * math.pi / lam
    th = math.radians(theta_deg)
    q0, qs = k0 * math.cos(th), k0 * cmath.sqrt(eps_s - math.sin(th) ** 2)
    a0, as_ = (1.0, 1.0) if pol == "TM" else (1.0, 1.0 / eps_s)
    p0, ps = a0 * q0, as_ * qs
    r01 = (p0 - ps) / (p0 + ps)
    e2 = cmath.exp(-2j * qs * t)
    r = r01 * (1 - e2) / (1 - r01**2 * e2)
    tau = (1 - r01**2) * cmath.exp(-1j * qs * t) / (1 - r01**2 * e2)
    # route 2: transfer matrix of (u, a du/ds) across the slab; incident side u = e^{-j q0 s} + r e^{j q0 s}
    c, sn = cmath.cos(qs * t), cmath.sin(qs * t)
    M = np.array([[c, sn / (as_ * qs)], [-as_ * qs * sn, c]])
    # state at s = 0: [1 + r; -j p0 (1 - r)] = v0 + r v1; at s = t: tau [1; -j p0]; so r M v1 - tau w = -M v0
    v0, v1 = np.array([1, -1j * p0]), np.array([1, 1j * p0])
    lhs = np.column_stack([M @ v1, -np.array([1, -1j * p0])])
    sol = np.linalg.solve(lhs, -(M @ v0))
    return {"r": [r.real, r.imag], "tau": [tau.real, tau.imag], "route2_diff": max(abs(sol[0] - r), abs(sol[1] - tau)),
            "energy": abs(r) ** 2 + abs(tau) ** 2 - 1}


def main():
    out = {"generator": "validation/bloch/bloch_refs.py", "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
           "c0": C0, "convention": "exp(+j omega t); u(x + a) = u(x) exp(-j k.a)"}
    # Bragg stack: test inputs (DevLog-050 s.1.5 G-B2)
    ax, ay, d1 = 1.0, 0.5, 0.4
    pts = [[0.3, 0.2], [0.11, 0.37], [0.5, 0.1]]
    bragg = {"ax": ax, "ay": ay, "d1": d1, "eps1": 4.0, "eps2": 1.0, "points": []}
    for pol in ("TM", "TE"):
        L = [(4.0, d1, 1.0 if pol == "TM" else 1 / 4.0), (1.0, ax - d1, 1.0)]
        for kr in pts:
            K, ky = 2 * math.pi * kr[0] / ax, 2 * math.pi * kr[1] / ay
            rs = bragg_bands(K, ky, ax, ay, L, 8, fmax=1.1e9)
            bragg["points"].append({"pol": pol, "kReduced": kr, "f": [r[0] for r in rs], "fold": [r[1] for r in rs], "route2_max": max(r[2] for r in rs)})
    out["bragg"] = bragg
    # oblique slab
    sl = {"eps_s": 4.0, "t": 0.3, "lambda": 1.0, "cases": []}
    for pol in ("TM", "TE"):
        for th in (30.0, 60.0):
            sl["cases"].append({"pol": pol, "theta_deg": th, **slab(4.0, 0.3, th, pol)})
    out["slab"] = sl
    # rod lattice PWE band table on the MPB path
    b1, b2 = np.array([2 * math.pi, 0.0]), np.array([0.0, 2 * math.pi])
    corners = np.array([[0, 0], [0.5, 0], [0.5, 0.5], [0, 0]], dtype=float)
    kred = pwe_path(corners, 4)
    kpts = [k[0] * b1 + k[1] * b2 for k in kred]
    tab = {}
    for nmax in (20, 24):
        f, npw = pwe_bands(b1, b2, kpts, 0.2, 12.0, 1.0, nmax, nb=8)
        tab[nmax] = (f, npw)
    f20, f24 = tab[20][0], tab[24][0]
    out["rods_pwe"] = {"r_over_a": 0.2, "eps_rod": 12.0, "unit": "1 (c/a)", "kReduced": kred.tolist(), "nmax": 24, "n_plane_waves": tab[24][1],
                       "f": f24.tolist(), "floor_abs_nmax20_vs_24": float(np.max(np.abs(f24 - f20)))}
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    worst_b = max(p["route2_max"] for p in bragg["points"])
    worst_s = max(c["route2_diff"] for c in sl["cases"])
    print(f"bragg route2 max {worst_b:.2e}; slab route2 max {worst_s:.2e}, energy {max(abs(c['energy']) for c in sl['cases']):.2e}; pwe floor {out['rods_pwe']['floor_abs_nmax20_vs_24']:.2e}")


if __name__ == "__main__":
    main()
