# SPDX-License-Identifier: GPL-3.0-or-later
"""TSV thermal stress, two-phase plane-strain Lame solution with a finite traction-free outer radius (PK-01, PK-02).

Derivation (own; same form as advanced-packaging-atlas validation/cases/A/MA7-lame-tsv.yaml, re-derived here):
isotropic linear thermo-elasticity, eps_zz = 0, uniform temperature change dT, per phase
lambda = E nu / ((1 + nu)(1 - 2 nu)), mu = E / (2 (1 + nu)), beta = E alpha / (1 - 2 nu).
Core 0 <= r <= a: u_r = A r; shell a <= r <= R: u_r = B r + C / r.
sigma_rr = 2 (lambda + mu) A - beta dT (core, uniform; sigma_phi = sigma_rr);
shell: sigma_rr = 2 (lambda + mu) B - 2 mu C / r^2 - beta dT, sigma_phi = 2 (lambda + mu) B + 2 mu C / r^2 - beta dT;
sigma_zz = 2 lambda (A or B) - beta dT. Conditions: u_r and sigma_rr continuous at r = a, sigma_rr(R) = 0 (3 x 3 linear
system, solved exactly). The interface pressure p = -sigma_rr(a). Infinite-matrix limit (R -> inf):
p = [(1 + nu1) a1 - (1 + nu2) a2] dT / [(1 + nu1)(1 - 2 nu1)/E1 + (1 + nu2)/E2] (reported as a check).

Run: cd validation && uv run python pkg/tsv_lame.py
"""

from __future__ import annotations

import numpy as np
from common_pkg import LIB, write_expected

A_VIA, R_OUT = 5e-6, 25e-6
DT = 298.15 - 398.15


def lame(a: float, R: float, dT: float, m1: dict, m2: dict) -> dict:
    def lmb(m):
        E, nu, al = m["E"], m["nu"], m["alpha"]
        return E * nu / ((1 + nu) * (1 - 2 * nu)), E / (2 * (1 + nu)), E * al / (1 - 2 * nu)

    l1, u1, b1 = lmb(m1)
    l2, u2, b2 = lmb(m2)
    M = np.array(
        [
            [a, -a, -1 / a],
            [2 * (l1 + u1), -2 * (l2 + u2), 2 * u2 / a**2],
            [0.0, 2 * (l2 + u2), -2 * u2 / R**2],
        ]
    )
    rhs = np.array([0.0, (b1 - b2) * dT, b2 * dT])
    A, B, C = np.linalg.solve(M, rhs)

    def shell(r):
        srr = 2 * (l2 + u2) * B - 2 * u2 * C / r**2 - b2 * dT
        sph = 2 * (l2 + u2) * B + 2 * u2 * C / r**2 - b2 * dT
        return srr, sph

    cu_srr = 2 * (l1 + u1) * A - b1 * dT
    s2a = shell(2 * a)
    E1, n1, a1 = m1["E"], m1["nu"], m1["alpha"]
    E2, n2, a2 = m2["E"], m2["nu"], m2["alpha"]
    p_inf = ((1 + n1) * a1 - (1 + n2) * a2) * dT / ((1 + n1) * (1 - 2 * n1) / E1 + (1 + n2) / E2)
    return {
        "cu_srr": cu_srr,
        "cu_szz": 2 * l1 * A - b1 * dT,
        "si_srr_2a": s2a[0],
        "si_sphi_2a": s2a[1],
        "si_szz": 2 * l2 * B - b2 * dT,
        "rim_ur": B * R + C / R,
        "p_interface": -cu_srr,
        "p_infinite_matrix": p_inf,
        "coeffs": {"A": A, "B": B, "C": C},
    }


def main() -> None:
    r = lame(A_VIA, R_OUT, DT, LIB["copper"], LIB["silicon"])
    loc = "validation/pkg/tsv_lame.py lame() (two-phase plane-strain Lame, finite traction-free outer radius)"
    tg = [
        ("cu_srr", r["cu_srr"], "Pa", "radial stress in the Cu (uniform; = -p)"),
        ("cu_szz", r["cu_szz"], "Pa", "axial stress in the Cu (plane strain)"),
        ("si_srr_2a", r["si_srr_2a"], "Pa", "radial stress in the Si at r = 2a"),
        ("si_sphi_2a", r["si_sphi_2a"], "Pa", "hoop stress in the Si at r = 2a"),
        ("si_szz", r["si_szz"], "Pa", "axial stress in the Si (uniform, plane strain)"),
        ("rim_ur", r["rim_ur"], "m", "radial displacement at r = R"),
    ]
    targets = [
        {"metric_id": m, "value": float(v), "unit": u, "definition": d, "precision": {"method": "exact closed form (3 x 3 solve, float64)"}, "locator": loc}
        for m, v, u, d in tg
    ]
    inputs = {"a_m": A_VIA, "R_m": R_OUT, "dT_K": DT, "copper": LIB["copper"], "silicon": LIB["silicon"],
              "p_interface_Pa": float(r["p_interface"]), "p_infinite_matrix_Pa": float(r["p_infinite_matrix"])}
    method = ("Two-phase plane-strain Lame solution (eps_zz = 0), Cu core radius a in a Si annulus to R, traction-free rim, "
              "uniform dT = T_use - T_ref; isotropic constants from the library at 298.15 K (Si: Voigt-Reuss-Hill E, nu)")
    for cid in ("PK-01", "PK-02"):
        p = write_expected(cid, targets, "validation/pkg/tsv_lame.py", method, extra={"inputs": inputs},
                           command="cd validation && uv run python pkg/tsv_lame.py")
        print(p)
    for m, v, u, _ in tg:
        print(f"{m:12s} {v: .9e} {u}")
    print("p_interface", r["p_interface"], "p_infinite_matrix", r["p_infinite_matrix"])


if __name__ == "__main__":
    main()
