# SPDX-License-Identifier: GPL-3.0-or-later
"""Microstrip with a strip of finite thickness (PK-07): independent references.

1. Air line (vacuum) capacitance C'_0 of a rectangular strip [-W/2, W/2] x [h, h + t] over an infinite ground plane
   y = 0: boundary-element method (own code), free-space 2D Green function with the image charge in the ground plane,
   piecewise-constant surface charge on panels graded towards the four corners (geometric grading), Galerkin-free
   midpoint collocation with exact panel integrals of ln r. Converged by doubling the panel count; the reference is the
   Richardson extrapolation of the last two levels, with the last-level change reported as its uncertainty. This is a
   numerical reference independent of the finite-element code (different method, different discretisation).
   L' = mu0 eps0 / C'_0 (TEM line in a homogeneous medium), as the engine computes it.
2. Hammerstad and Jensen 1980 closed forms with their strip-thickness correction, Qucs technical documentation
   s.11.1.3 eqs. (11.22)-(11.25) (qucs.sourceforge.net/tech/node75.html, read 2026-11-18) with W normalised by h in
   the coth argument (as scikit-rf skrf/media/mline.py, which notes the printed (11.22) needs the normalised width):
   du1 = (t/pi) ln(1 + 4e / (t coth^2 sqrt(6.517 u))), dur = du1 (1 + sech sqrt(eps_r - 1)) / 2 (t, u normalised by h);
   Z0 = Z_L1(u_r) / sqrt(eps_eff(u_r)), eps_eff = eps_eff(u_r) (Z_L1(u_1) / Z_L1(u_r))^2. The source states no accuracy
   for the thickness term (only for the zero-thickness forms): informative.
3. Zero-thickness Hammerstad-Jensen values (the PK-03 limit), for the thickness increment.

Run: cd validation && uv run python pkg2/strip_bem.py
"""

from __future__ import annotations

import math

import numpy as np
from common_pkg2 import C0, EPS0, ETA0, MU0, write_expected


def _graded(L: float, n: int, ratio: float) -> np.ndarray:
    """Panel end points on [0, L], geometric grading towards both ends (first panel / middle panel = 1 / ratio)."""
    half = n // 2
    q = ratio ** (1 / max(half - 1, 1))
    w = q ** np.arange(half)
    w = np.concatenate([w, w[::-1]]) if n % 2 == 0 else np.concatenate([w, [w[-1] * q], w[::-1]])
    s = np.concatenate([[0.0], np.cumsum(w)])
    return s / s[-1] * L


def _panels(W: float, h: float, t: float, n_side: int, ratio: float) -> tuple[np.ndarray, np.ndarray]:
    """Panels of the rectangle boundary (counter-clockwise): arrays of start and end points, shape (N, 2)."""
    corners = [(-W / 2, h), (W / 2, h), (W / 2, h + t), (-W / 2, h + t)]
    A, B = [], []
    for i in range(4):
        p, q = np.array(corners[i]), np.array(corners[(i + 1) % 4])
        L = float(np.linalg.norm(q - p))
        n = max(4, int(round(n_side * (L / W) ** 0.5)))
        s = _graded(L, n, ratio)
        d = (q - p) / L
        pts = p[None, :] + s[:, None] * d[None, :]
        A.append(pts[:-1])
        B.append(pts[1:])
    return np.vstack(A), np.vstack(B)


def _int_ln(P: np.ndarray, A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """I[i, j] = integral over panel j of ln |P_i - r'| ds' (exact)."""
    d = B - A
    L = np.linalg.norm(d, axis=1)
    e = d / L[:, None]
    rx = P[:, None, 0] - A[None, :, 0]
    ry = P[:, None, 1] - A[None, :, 1]
    u = rx * e[None, :, 0] + ry * e[None, :, 1]
    v = np.abs(-rx * e[None, :, 1] + ry * e[None, :, 0])
    x1, x2 = -u, L[None, :] - u

    def F(x: np.ndarray) -> np.ndarray:
        r2 = x * x + v * v
        with np.errstate(divide="ignore", invalid="ignore"):
            lg = np.where(r2 > 0, 0.5 * np.log(np.where(r2 > 0, r2, 1.0)), 0.0)
            at = np.where(v > 0, v * np.arctan2(x, np.where(v > 0, v, 1.0)), 0.0)
        return x * lg - x + at

    return F(x2) - F(x1)


def bem_c0(W: float, h: float, t: float, n_side: int, ratio: float = 60.0) -> float:
    A, B = _panels(W, h, t, n_side, ratio)
    P = 0.5 * (A + B)
    Ai, Bi = A * [1, -1], B * [1, -1]  # images in the ground plane y = 0 (charge -sigma)
    G = (-_int_ln(P, A, B) + _int_ln(P, Ai, Bi)) / (2 * math.pi * EPS0)
    sigma = np.linalg.solve(G, np.ones(len(P)))
    return float(np.sum(sigma * np.linalg.norm(B - A, axis=1)))


def hj(W: float, h: float, er: float, t: float = 0.0) -> dict:
    """Hammerstad-Jensen 1980 (Qucs s.11.1 eqs. 11.4-11.6, 11.15-11.18; thickness 11.22-11.25)."""
    def zl1(u: float) -> float:
        fu = 6 + (2 * math.pi - 6) * math.exp(-((30.666 / u) ** 0.7528))
        return ETA0 / (2 * math.pi) * math.log(fu / u + math.sqrt(1 + (2 / u) ** 2))

    def ee(u: float) -> float:
        a = 1 + math.log((u**4 + (u / 52) ** 2) / (u**4 + 0.432)) / 49 + math.log(1 + (u / 18.1) ** 3) / 18.7
        b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053
        return (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / u) ** (-a * b)

    u, tn = W / h, t / h
    du1 = tn / math.pi * math.log(1 + 4 * math.e / tn * math.tanh(math.sqrt(6.517 * u)) ** 2) if tn > 0 else 0.0
    dur = du1 * (1 + 1 / math.cosh(math.sqrt(er - 1))) / 2
    u1, ur = u + du1, u + dur
    e_eff = ee(ur) * (zl1(u1) / zl1(ur)) ** 2
    z01 = zl1(u1)
    return {"u1": u1, "ur": ur, "Z01": z01, "eps_eff": e_eff, "Z0": z01 / math.sqrt(e_eff),
            "L_per_m": z01 / C0, "C_per_m": e_eff / (C0 * z01)}


def converge(W: float, h: float, t: float, ns: tuple[int, ...] = (40, 80, 160, 320, 640)) -> dict:
    cs = [bem_c0(W, h, t, n) for n in ns]
    r = [(cs[i] - cs[i - 1]) for i in range(1, len(cs))]
    p = math.log2(abs(r[-2] / r[-1])) if r[-1] != 0 else float("inf")
    ext = cs[-1] + r[-1] / (2**p - 1)
    return {"n_side": list(ns), "C0": cs, "p_obs": p, "C0_ext": ext, "rel_last_change": abs(r[-1] / cs[-1]),
            "rel_ext_minus_fine": abs(ext - cs[-1]) / ext}


def main() -> None:
    W, h, t, er = 10e-6, 10e-6, 2e-6, 2.9  # sims/microstrip-thick.yaml; eps_r: materials/polyimide-pi2600 (1 kHz)
    cv = converge(W, h, t)
    C0x = cv["C0_ext"]
    L_bem = MU0 * EPS0 / C0x
    # zero-thickness check of the BEM against Hammerstad-Jensen (0.01 % for W/h <= 1): thin strip t -> small
    thin = converge(W, h, 1e-3 * h)
    r_hj = hj(W, h, er, t)
    r_hj0 = hj(W, h, er, 0.0)
    print("BEM thick:", cv)
    print("BEM t = 1e-3 h:", thin["C0_ext"], " HJ air t=0:", 1 / (C0 * r_hj0["Z01"]))
    print("HJ thick:", r_hj)
    print("HJ zero:", r_hj0)
    print("L' BEM", L_bem, " HJ thick", r_hj["L_per_m"], " rel", r_hj["L_per_m"] / L_bem - 1)
    loc_bem = "validation/pkg2/strip_bem.py bem_c0(), converge(): Richardson of the last two panel levels"
    loc_hj = ("Qucs technical documentation s.11.1.3 eqs. (11.22)-(11.25) with (11.4)-(11.6), (11.15)-(11.18); "
              "scikit-rf skrf/media/mline.py (hammerstadjensen branch)")
    targets = [
        {"metric_id": "L_per_m", "value": L_bem, "unit": "H/m", "definition": "mu0 eps0 / C'_0 (boundary elements, thick strip, vacuum)",
         "precision": {"bem_rel_ext_minus_fine": cv["rel_ext_minus_fine"], "bem_p_obs": cv["p_obs"]}, "locator": loc_bem},
        {"metric_id": "L_per_m_hj", "value": r_hj["L_per_m"], "unit": "H/m", "definition": "Z_L1(u1) / c0 (Hammerstad-Jensen with thickness)",
         "precision": {"closed_form_accuracy": "not stated by the source for the thickness term"}, "locator": loc_hj},
        {"metric_id": "C_per_m", "value": r_hj["C_per_m"], "unit": "F/m", "definition": "eps_eff / (c0 Z_L1(u1)) (Hammerstad-Jensen with thickness)",
         "precision": {"closed_form_accuracy": "not stated by the source for the thickness term"}, "locator": loc_hj},
        {"metric_id": "Z0", "value": r_hj["Z0"], "unit": "Ohm", "definition": "Z_L1(u_r) / sqrt(eps_eff(u_r)) (Hammerstad-Jensen with thickness)",
         "precision": {"closed_form_accuracy": "not stated by the source for the thickness term"}, "locator": loc_hj},
        {"metric_id": "C0_ratio", "value": r_hj0["L_per_m"] / L_bem, "unit": "1",
         "definition": "C'_0(t) / C'_0(0) = L'(0) / L'(t): BEM thick strip over Hammerstad-Jensen zero thickness",
         "precision": {"zero_thickness_accuracy": "0.01 % (W/h <= 1, Qucs s.11.1)"}, "locator": f"{loc_bem}; {loc_hj}"},
    ]
    p = write_expected("PK-07", targets, "validation/pkg2/strip_bem.py",
                       "air-line C'_0 of the thick strip by boundary elements with an image (own code, converged); "
                       "Hammerstad-Jensen with thickness correction (informative)",
                       extra={"inputs": {"W_m": W, "h_m": h, "t_m": t, "eps_r": er},
                              "bem": cv, "bem_thin_check": {"t_m": 1e-3 * h, "C0_ext": thin["C0_ext"],
                                                            "hj_zero_thickness_C0": 1 / (C0 * r_hj0["Z01"])},
                              "hj_thick": r_hj, "hj_zero": r_hj0},
                       command="cd validation && uv run python pkg2/strip_bem.py")
    print(p)


if __name__ == "__main__":
    main()
