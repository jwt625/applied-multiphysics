# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-a heat generators: HT-01 (NAFEMS T4 series), HT-02 (NAFEMS T3), HT-03 (NAFEMS T2), HT-04 (Carslaw-Jaeger).

Run: cd validation && uv run python a/gen_heat.py
"""

from __future__ import annotations

import math

import mpmath as mp
import numpy as np
from common import SIGMA_SB, r3_compare, target, write_expected
from scipy.optimize import brentq
from scipy.special import erfc, erfcx

GEN = "validation/a/gen_heat.py"


# ---------------------------------------------------------------- HT-01: NAFEMS T4, 2D steady, separation of variables
# Domain x in [0, W] (W = 0.6 m), y in [0, H] (H = 1.0 m). x = 0 insulated; x = W and y = H convect (h, T_inf = 0);
# y = 0 at T_b = 100 C. Eigenfunctions cos(b x) with b tan(b W) = h / k. In y:
# Y(y) = b cosh(b (H - y)) + (h/k) sinh(b (H - y)) satisfies -k Y' = h Y at y = H.
def t4_eigs(n: int, W: float, g: float) -> np.ndarray:
    # z = b W solves z sin z - (g W) cos z = 0 on [i pi, i pi + pi/2] (pole-free form of z tan z = g W)
    gw = g * W
    out = np.empty(n)
    for i in range(n):
        lo, hi = i * math.pi, i * math.pi + 0.5 * math.pi
        out[i] = brentq(lambda z: z * math.sin(z) - gw * math.cos(z), lo, hi, xtol=1e-14, rtol=1e-15, maxiter=500)
    return out / W


def t4_temperature(x: float, y: float, n: int, W: float = 0.6, H: float = 1.0, k: float = 52.0, h: float = 750.0,
                   Tb: float = 100.0) -> float:
    g = h / k
    b = t4_eigs(n, W, g)
    an = Tb * (np.sin(b * W) / b) / (W / 2 + np.sin(2 * b * W) / (4 * b))
    s = H - y
    # ratio Y(y)/Y(0), scaled by exp(-b H) to avoid overflow
    num = b * (np.exp(-b * y) + np.exp(-b * (H + s))) + g * (np.exp(-b * y) - np.exp(-b * (H + s)))
    den = b * (1 + np.exp(-2 * b * H)) + g * (1 - np.exp(-2 * b * H))
    return float(np.sum(an * np.cos(b * x) * num / den))


def ht01() -> None:
    n = 400
    v = t4_temperature(0.6, 0.2, n)
    v2 = t4_temperature(0.6, 0.2, 2 * n)
    # Check of the bottom BC away from the corner (series of a constant: algebraic convergence at y = 0)
    vb = t4_temperature(0.3, 0.0, 4000)
    write_expected(
        "HT-01",
        [
            target("T_E", v, "degC",
                   {"method": "eigenfunction series", "terms": n, "change_on_doubling": abs(v2 - v),
                    "bc_check_T(0.3,0)_4000_terms": vb},
                   r3=r3_compare(v, "18.3"), locator="point E = (0.6, 0.2) m"),
        ],
        GEN,
        "Separation of variables: T = sum a_n cos(b_n x) Y_n(y)/Y_n(0), b_n tan(b_n W) = h/k, "
        "a_n = T_b (sin(b_n W)/b_n) / (W/2 + sin(2 b_n W)/(4 b_n)). Independent check of the NAFEMS T4 target.",
    )


# ---------------------------------------------------------------- HT-02: NAFEMS T3, 1D transient, sinusoidal end
def t3_params() -> dict[str, float]:
    return {"L": 0.1, "k": 35.0, "cp": 440.5, "rho": 7200.0, "A": 100.0, "omega": math.pi / 40.0}


def t3_series_shift(x: float, t: float, n: int, p: dict[str, float]) -> float:
    """Method 1: T = (x/L) g(t) + sum b_n(t) sin(n pi x / L); terms O(n^-3)."""
    L, A, w = p["L"], p["A"], p["omega"]
    a = p["k"] / (p["rho"] * p["cp"])
    nn = np.arange(1, n + 1, dtype=float)
    lam = a * (nn * math.pi / L) ** 2
    cn = 2.0 * (-1.0) ** (nn + 1) / (nn * math.pi)
    integ = (lam * math.cos(w * t) + w * math.sin(w * t) - lam * np.exp(-lam * t)) / (lam**2 + w**2)
    bn = -cn * A * w * integ
    return float(x / L * A * math.sin(w * t) + np.sum(bn * np.sin(nn * math.pi * x / L)))


def t3_periodic_plus_transient(x: float, t: float, n: int, p: dict[str, float]) -> float:
    """Method 2: T = Im[A e^{i w t} sinh(kap x)/sinh(kap L)] + transient; transient terms decay as exp(-lam_n t)."""
    mp.mp.dps = 40
    L, A, w = mp.mpf(p["L"]), mp.mpf(p["A"]), mp.mpf(p["omega"])
    a = mp.mpf(p["k"]) / (mp.mpf(p["rho"]) * mp.mpf(p["cp"]))
    kap = mp.sqrt(1j * w / a)
    tp = mp.im(A * mp.exp(1j * w * t) * mp.sinh(kap * x) / mp.sinh(kap * L))
    # initial transient w(x,0) = -Im[A sinh(kap x)/sinh(kap L)]; project on sin(m pi x / L)
    # int_0^L sinh(kap x) sin(q x) dx = (q (-1)^{m+1} sinh(kap L)) / (kap^2 + q^2)
    s = mp.mpf(0)
    for m in range(1, n + 1):
        q = m * mp.pi / L
        coef = mp.im(A * q * (-1) ** (m + 1) / (kap**2 + q**2)) * 2 / L
        s += -coef * mp.sin(q * x) * mp.exp(-a * q**2 * t)
    return float(tp + s)


def ht02() -> None:
    p = t3_params()
    pts = [("T_x0.08_t32", 0.08, 32.0, "36.60", "x = 0.08 m from the T = 0 end, t = 32 s (Altair OS-V 0110)"),
           ("T_x0.08_t36", 0.08, 36.0, "36.68", "x = 0.08 m from the T = 0 end, t = 36 s (FEATool time, flag check)"),
           ("T_x0.02_t36", 0.02, 36.0, None, "x = 0.02 m from the T = 0 end, t = 36 s (FEATool literal reading)"),
           ("T_x0.02_t32", 0.02, 32.0, None, "x = 0.02 m from the T = 0 end, t = 32 s")]
    targets = []
    for mid, x, t, r3, loc in pts:
        n1 = 4000
        v1 = t3_series_shift(x, t, n1, p)
        v1d = t3_series_shift(x, t, 2 * n1, p)
        n2 = 40
        v2 = t3_periodic_plus_transient(x, t, n2, p)
        v2d = t3_periodic_plus_transient(x, t, 2 * n2, p)
        targets.append(target(
            mid, v2, "degC",
            {"method": "periodic + transient eigen series (mpmath 40 digits)", "terms": n2,
             "change_on_doubling": abs(v2d - v2),
             "cross_check": {"method": "shifted-BC eigen series", "terms": n1, "value": v1,
                             "change_on_doubling": abs(v1d - v1), "diff_vs_primary": abs(v1 - v2)}},
            r3=r3_compare(v2, r3) if r3 else None, locator=loc))
    write_expected(
        "HT-02", targets, GEN,
        "NAFEMS T3 1D bar: alpha = k/(rho cp); T(0,t) = 0, T(L,t) = 100 sin(pi t/40), T(x,0) = 0. Two independent "
        "series. R3 flag resolved: 36.60 C is at x = 0.08 m from the T = 0 end at t = 32 s.",
        extra={"flag_resolution": {
            "HT-02_locator": "Target 36.60 C = T(x = 0.08 m measured from the fixed-zero end, t = 32 s). "
                             "FEATool's (x = 0.02 m, t = 36 s) is a reversed coordinate (0.02 m from the heated end "
                             "= 0.08 m from the zero end) with the wrong time: at t = 36 s the value is 36.68 C."}},
    )


# ---------------------------------------------------------------- HT-03: NAFEMS T2, conduction + radiation at end B
def ht03() -> None:
    L, TA, eps, Tinf = 0.1, 1000.0, 0.98, 300.0
    targets = []
    for k, r3, label in [(55.6, "927.004", "k55.6"), (55.563, "926.967", "k55.563")]:
        for sig, sl in [(SIGMA_SB, "codata"), (5.67e-8, "5.67e-8")]:
            f = lambda TB, k=k, sig=sig: k * (TA - TB) / L - eps * sig * (TB**4 - Tinf**4)  # noqa: E731
            TB = brentq(f, Tinf, TA, xtol=1e-13, rtol=1e-15)
            targets.append(target(
                f"T_B.{label}.sigma_{sl}", TB, "K",
                {"method": "brentq root", "xtol_K": 1e-13, "residual_W_m2": f(TB)},
                r3=r3_compare(TB, r3) if sl == "codata" else None,
                locator=f"end B, x = L; k = {k} W/(m K), sigma = {sl}",
                inputs={"k": k, "sigma": sig}))
    write_expected("HT-03", targets, GEN,
                   "Root of k (T_A - T_B)/L = eps sigma (T_B^4 - T_inf^4), 1D, no other loss. Both sigma values "
                   "shown: the NAFEMS booklet's sigma is not public (missing).")


# ---------------------------------------------------------------- HT-04: semi-infinite solid, convective surface
def cj_convective(x: float, t: float, k: float, rho: float, c: float, h: float, Ti: float, Tinf: float) -> float:
    a = k / (rho * c)
    xi = x / (2 * math.sqrt(a * t))
    b = h * math.sqrt(a * t) / k
    # exp(h x/k + h^2 a t / k^2) erfc(xi + b) = exp(-xi^2) erfcx(xi + b)
    theta = erfc(xi) - math.exp(-xi * xi) * erfcx(xi + b)
    return Ti + (Tinf - Ti) * theta


def ht04() -> None:
    k, rho, c, h, Ti, Tinf, t = 54.0, 7833.0, 465.0, 50.0, 0.0, 1000.0, 2000.0
    targets = []
    for x, r3 in [(0.0223, "140.42"), (0.0859, "98.85"), (0.1866, "51.76"), (0.3462, "14.45")]:
        v = cj_convective(x, t, k, rho, c, h, Ti, Tinf)
        # mpmath cross-check of the direct (unscaled) formula
        mp.mp.dps = 40
        a = mp.mpf(k) / (rho * c)
        xi = x / (2 * mp.sqrt(a * t))
        b = h * mp.sqrt(a * t) / k
        vm = Ti + (Tinf - Ti) * (mp.erfc(xi) - mp.exp(h * x / k + h**2 * a * t / k**2) * mp.erfc(xi + b))
        targets.append(target(f"T_x{x}_t2000", v, "degC",
                              {"method": "closed form (erfc, erfcx)", "mpmath_40digit": float(vm),
                               "diff_vs_mpmath": abs(v - float(vm))},
                              r3=r3_compare(v, r3), locator=f"depth x = {x} m, t = 2000 s",
                              informative={"ansys_vm28_value": {"0.0223": 140.0, "0.0859": 98.9, "0.1866": 51.8,
                                                                "0.3462": 14.5}[str(x)]}))
    write_expected("HT-04", targets, GEN,
                   "Carslaw-Jaeger / Holman semi-infinite solid with surface convection: (T - Ti)/(Tinf - Ti) = "
                   "erfc(xi) - exp(h x/k + h^2 a t/k^2) erfc(xi + h sqrt(a t)/k), xi = x / (2 sqrt(a t)).")


if __name__ == "__main__":
    ht01()
    ht02()
    ht03()
    ht04()
    print("heat: wrote HT-01..HT-04")
