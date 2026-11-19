# SPDX-License-Identifier: GPL-3.0-or-later
"""Waveguide under a thin-film heater (PK-10 3D, PK-11 2D cut): bounds on the mean heater temperature rise per power.

Model (sims/waveguide-heater-3d.yaml, quarter of the device; sims/waveguide-heater-to.yaml, 2D cross-section): layer
stack Si substrate (bottom isothermal) / BOX oxide / core layer (Si strip in oxide) / oxide cladding; the heater is a
uniform heat flux q on a rectangle of the cladding top (|x| < w_h/2, |y| < L_h/2; 2D: |x| < w_h/2), every other surface
adiabatic (side walls and, in the quarter model, the symmetry planes).

Bound (own derivation): the thermal compliance J = int q T dA = P mean_heater(T - T_sub) decreases monotonically when
any conductivity increases (Thomson / Rayleigh). Replacing the core layer by oxide everywhere (Si strip -> oxide) gives
an upper bound, replacing it by Si everywhere gives a lower bound. Both replaced models are horizontally layered, so
they are solved exactly by a cosine series in x (and y in 3D) on the adiabatic box: for each mode with wavenumber kappa
the layer transfer gives the surface impedance Z (temperature per unit downward flux):
Z_top = (Z_b + tanh(kappa d) / (kappa k)) / (1 + kappa k Z_b tanh(kappa d)), Z_top = Z_b + d / k for kappa = 0, with
Z = 0 at the isothermal substrate bottom. Mean heater temperature: sum_mn Z_mn q_mn s_m s_n with the cosine coefficients
q_mn of the heater rectangle and its mean s_m = sin(m pi c / A) / (m pi c / A) of each mode over the heater.
Sharper bounds (used for the gate), from the same principles with the layered fields as trial fields in the true
medium (Si strip |x| < w_wg/2 in the core layer, oxide around it):
- lower (Dirichlet principle, trial T = T_Si of the all-Si core layer): J >= J_Si + (k_Si - k_ox) E_out[T_Si], with
  E_out = integral of |grad T|^2 over the core layer outside the strip;
- upper (complementary energy, trial flux = flux of T_ox of the all-oxide core layer):
  J <= J_ox - (k_ox - k_ox^2 / k_Si) E_in[T_ox], E_in = integral of |grad T|^2 over the strip.
E_in, E_out from the series fields (stable layer propagation, midpoint quadrature in x and z, exact orthogonality in y).
A conforming finite-element solution under-estimates the compliance, so it approaches the exact value from below.

Run: cd validation && uv run python pkg2/heater_layers.py
"""

from __future__ import annotations

import math

import numpy as np
from common_pkg2 import LIB, write_expected

K_SI, K_OX = LIB["silicon"]["k"], LIB["sio2"]["k"]


def z_surface(kap: np.ndarray, layers: list[tuple[float, float]]) -> np.ndarray:
    """Surface impedance of a layer stack (bottom first: (thickness, k)) over an isothermal base."""
    Z = np.zeros_like(kap)
    pos = kap > 0
    for d, k in layers:
        th = np.tanh(np.minimum(kap * d, 50.0))
        kk = np.where(pos, kap, 1.0)
        Zn = (Z + th / (kk * k)) / (1 + kk * k * Z * th)
        Z = np.where(pos, Zn, Z + d / k)
    return Z


def _coef(n: np.ndarray, c: float, A: float) -> tuple[np.ndarray, np.ndarray]:
    """Cosine coefficients of the indicator |x| < c on (-A, A) (Neumann) and the mean of each mode over |x| < c."""
    with np.errstate(divide="ignore", invalid="ignore"):
        arg = n * math.pi * c / A
        s = np.where(n == 0, 1.0, np.sin(arg) / np.where(n == 0, 1.0, arg))
    coef = np.where(n == 0, c / A, 2 * c / A * s)
    return coef, s


def mean_rise(layers: list[tuple[float, float]], q: float, A: float, c: float, B: float | None = None,
              e: float | None = None, N: int = 4000) -> float:
    """Mean heater temperature rise: heater |x| < c (and |y| < e) on a box |x| < A (|y| < B); 2D when B is None."""
    m = np.arange(N, dtype=float)
    cx, sx = _coef(m, c, A)
    if B is None:
        Z = z_surface(m * math.pi / A, layers)
        return float(np.sum(Z * q * cx * sx))
    assert e is not None
    n = np.arange(N, dtype=float)
    cy, sy = _coef(n, e, B)
    tot = 0.0
    for i in range(N):  # row by row to bound memory
        kap = np.sqrt((m[i] * math.pi / A) ** 2 + (n * math.pi / B) ** 2)
        Z = z_surface(kap, layers)
        tot += float(np.sum(Z * q * cx[i] * sx[i] * cy * sy))
    return tot


def _ratios(kap: np.ndarray, Zb: np.ndarray, d: float, k: float, zp: float) -> tuple[np.ndarray, np.ndarray]:
    """T(z') / T_top and F(z') / F_top in a layer of thickness d over a base impedance Zb (z' above the layer bottom;
    F = downward heat flux), written with decaying exponentials only."""
    kk = np.where(kap > 0, kap, 1.0)
    e2z, e2d, sc = np.exp(-2 * kk * zp), np.exp(-2 * kk * d), np.exp(kk * (zp - d))
    numT = sc * (Zb * (1 + e2z) / 2 + (1 - e2z) / (2 * k * kk))
    denT = Zb * (1 + e2d) / 2 + (1 - e2d) / (2 * k * kk)
    numF = sc * ((1 + e2z) / 2 + k * kk * Zb * (1 - e2z) / 2)
    denF = (1 + e2d) / 2 + k * kk * Zb * (1 - e2d) / 2
    rT = np.where(kap > 0, numT / denT, (Zb + zp / k) / (Zb + d / k))
    rF = np.where(kap > 0, numF / denF, 1.0)
    return rT, rF


def core_energies(core_k: float, p: dict, q: float, three_d: bool, N: int, nx: int, nz: int) -> tuple[float, float, float]:
    """Compliance J, E_in, E_out over the half (2D: x > 0) or quarter (3D: x, y > 0) model of the layered problem with
    a homogeneous core layer of conductivity core_k (heater flux q on |x| < w_h/2, |y| < L_h/2)."""
    layers = stack(core_k, p)
    A, c, wg, d = p["W"] / 2, p["w_h"] / 2, p["w_wg"] / 2, p["t_wg"]
    m = np.arange(N, dtype=float)
    cx, sx = _coef(m, c, A)
    x = (np.arange(nx) + 0.5) / nx * A
    kx = m * math.pi / A
    cosx, sinx = np.cos(np.outer(x, kx)), np.sin(np.outer(x, kx))
    inside = x < wg
    if three_d:
        B, e = p["L"] / 2, p["L_h"] / 2
        nn = np.arange(N, dtype=float)
        cy, sy = _coef(nn, e, B)
        ky = nn * math.pi / B
        rows = [(cy[j], ky[j], (B if j == 0 else B / 2), sy[j]) for j in range(N)]
    else:
        rows = [(1.0, 0.0, 1.0, 1.0)]
    J = Ein = Eout = 0.0
    for cyj, kyj, wy, syj in rows:
        kap = np.sqrt(kx**2 + kyj**2)
        qm = q * cx * cyj
        Z4, Z3, Z2 = z_surface(kap, layers), z_surface(kap, layers[:3]), z_surface(kap, layers[:2])
        Ttop = Z4 * qm
        J += float(np.sum(Ttop * q * sx * syj)) * (c * (p["L_h"] / 2 if three_d else 1.0))
        rT, rF = _ratios(kap, Z3, p["t_c"], K_OX, 0.0)
        Tc, Fc = Ttop * rT, qm * rF
        for j in range(nz):
            zp = (j + 0.5) / nz * d
            rT, rF = _ratios(kap, Z2, d, core_k, zp)
            Ts, Fs = Tc * rT, Fc * rF
            gx = -(sinx * (kx * Ts)).sum(1)
            gy2 = ((cosx * (kyj * Ts)).sum(1)) ** 2 * (wy if kyj > 0 else 0.0)  # sin^2 in y integrates to B/2
            gz = (cosx * (Fs / core_k)).sum(1)
            g2 = (gx**2 + gz**2) * wy + gy2
            w = (A / nx) * (d / nz)
            Ein += float(g2[inside].sum()) * w
            Eout += float(g2[~inside].sum()) * w
    return J, Ein, Eout


def improved(p: dict, q: float, three_d: bool, N: int, nx: int, nz: int) -> dict:
    Jo, Ei_o, _ = core_energies(K_OX, p, q, three_d, N, nx, nz)
    Js, _, Eo_s = core_energies(K_SI, p, q, three_d, N, nx, nz)
    Pq = q * p["w_h"] / 2 * (p["L_h"] / 2 if three_d else 1.0)
    return {"plain_upper": Jo / Pq, "plain_lower": Js / Pq,
            "upper": (Jo - (K_OX - K_OX**2 / K_SI) * Ei_o) / Pq, "lower": (Js + (K_SI - K_OX) * Eo_s) / Pq}


def stack(core_k: float, p: dict) -> list[tuple[float, float]]:
    return [(p["t_sub"], K_SI), (p["t_box"], K_OX), (p["t_wg"], core_k), (p["t_c"], K_OX)]


P = {  # sims/waveguide-heater-3d.yaml and sims/waveguide-heater-to.yaml (illustrative inputs, SI)
    "W": 30e-6, "L": 30e-6, "w_h": 2e-6, "w_wg": 0.5e-6, "L_h": 20e-6, "t_sub": 15e-6, "t_box": 2e-6, "t_wg": 0.22e-6, "t_c": 1e-6,
    "P_h": 1e-3,
}


def main() -> None:
    p = P
    q = p["P_h"] / (p["w_h"] * p["L_h"])
    A, c = p["W"] / 2, p["w_h"] / 2
    # plain bounds (core layer all oxide / all Si), mean_rise with two mode counts
    plain = {
        "3d": {N: (mean_rise(stack(K_SI, p), q, A, c, p["L"] / 2, p["L_h"] / 2, N),
                   mean_rise(stack(K_OX, p), q, A, c, p["L"] / 2, p["L_h"] / 2, N)) for N in (300, 600)},
        "2d": {N: (mean_rise(stack(K_SI, p), q, A, c, N=N), mean_rise(stack(K_OX, p), q, A, c, N=N)) for N in (4000, 8000)},
    }
    # sharper bounds (gate); x grid aligned with the strip edge (A / (w_wg / 2) = 60 cells per strip-edge spacing unit)
    sharp = {"3d": {N: improved(p, q, True, N, nx, 8) for N, nx in ((150, 1200), (300, 2400))},
             "2d": {N: improved(p, q, False, N, nx, 16) for N, nx in ((1500, 3000), (3000, 6000))}}
    print("plain", plain)
    print("sharp", sharp)
    loc = ("validation/pkg2/heater_layers.py improved(), core_energies(), mean_rise(), z_surface(); "
           "eval/expected/PK-10.json (3D quarter model), PK-11.json (2D section)")
    for cid, key in (("PK-10", "3d"), ("PK-11", "2d")):
        n1, n2 = sorted(sharp[key])
        lo, up = sharp[key][n2]["lower"], sharp[key][n2]["upper"]
        ch = max(abs(sharp[key][n2][x] / sharp[key][n1][x] - 1) for x in ("lower", "upper"))
        m1, m2 = sorted(plain[key])
        plo, pup = plain[key][m2]
        # the series truncation lowers every compliance (positive terms): the plain upper bound at the larger mode count
        # is added as a check that the sharp upper bound stays below it
        print(f"{cid}: gate [{lo:.6f}, {up:.6f}] K at 1 mW, width {up / lo - 1:.3e}, change {ch:.2e}; plain [{plo:.6f}, {pup:.6f}]")
        targets = [
            {"metric_id": "dT_heater_lower", "value": lo, "unit": "K",
             "definition": "mean heater temperature rise at 1 mW: Dirichlet bound with the all-Si-core-layer field as trial",
             "precision": {"modes_per_direction": n2, "rel_change_vs_half": ch}, "locator": loc},
            {"metric_id": "dT_heater_upper", "value": up, "unit": "K",
             "definition": "mean heater temperature rise at 1 mW: complementary bound with the all-oxide-core-layer flux as trial",
             "precision": {"modes_per_direction": n2, "rel_change_vs_half": ch}, "locator": loc},
            {"metric_id": "dT_heater_all_si", "value": plo, "unit": "K",
             "definition": "mean heater temperature rise at 1 mW, core layer all Si (exact for that layered model; plain lower bound)", "locator": loc},
            {"metric_id": "dT_heater_all_oxide", "value": pup, "unit": "K",
             "definition": "mean heater temperature rise at 1 mW, core layer all oxide (exact for that layered model; plain upper bound)", "locator": loc},
        ]
        out = write_expected(cid, targets, "validation/pkg2/heater_layers.py",
                             "compliance bounds of steady conduction (monotonicity in k; Dirichlet and complementary principles with "
                             "exact cosine-series fields of layered models as trials; own derivation)",
                             extra={"inputs": {**p, "k_si": K_SI, "k_oxide": K_OX, "q_W_per_m2": q},
                                    "sharp_by_modes": {str(k): v for k, v in sharp[key].items()},
                                    "plain_by_modes": {str(k): v for k, v in plain[key].items()}},
                             command="cd validation && uv run python pkg2/heater_layers.py")
        print(out)


if __name__ == "__main__":
    main()
