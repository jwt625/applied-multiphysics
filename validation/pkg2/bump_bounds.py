# SPDX-License-Identifier: GPL-3.0-or-later
"""Solder-bump array unit cell (PK-08): two-sided bounds on the thermal resistance, with spreading in the die and in
the interposer (own derivation).

Model (sims/bump-array-thermal.yaml): axisymmetric equal-area cell of radius b: Si die (thickness t_d) / cylindrical
SAC305 column (radius a, height h_b) / Si interposer (thickness t_s); die back at T_hot, interposer bottom at T_cold,
every other surface adiabatic (cell wall by symmetry, void around the column: no underfill). R = (T_hot - T_cold) / Q.

Plate problem P(k, tau, b, a): a plate of radius b and thickness tau, heat Q entering through a disc of radius a on one
face, the opposite face isothermal, every other surface adiabatic. Separation of variables (J0(lambda_n r), J1(lambda_n b)
= 0) for a flux distribution q(r) on the disc gives the disc temperature; two flux distributions are used:
- uniform flux: R_uf = tau / (pi b^2 k) + sum_n 4 J1(l_n a)^2 / (pi a^2 b^2 k l_n^3 J0(l_n b)^2 tanh(l_n tau)), where
  R_uf is defined with the area-mean disc temperature (exact series);
- isothermal disc: R_iso = min over flux distributions with total Q of (1 / Q^2) int q theta dA (complementary energy);
  computed by Galerkin with the basis (1 - r^2/a^2)^(m - 1/2), m = 0..M-1 (the m = 0 term carries the edge singularity
  of the isothermal disc), Sonine integral int_0^a (1 - r^2/a^2)^nu J0(l r) r dr = a^2 2^nu Gamma(nu + 1)
  J_(nu+1)(l a) / (l a)^(nu+1). The Galerkin value converges from above in M (change M 4 -> 6 below 1e-8 here); the
  series over n is truncated at N terms, with an error ~ 1/N for the singular basis (all terms positive), removed by
  extrapolation 2 R(2N) - R(N) (N = 40000; the N -> 2N change is about 2e-6 relative and is reported).

Bounds on the cell resistance (variational principles of steady conduction, linear k):
- upper (complementary energy, admissible flux = uniform flux in the column continued by the uniform-flux plate
  solutions on both sides): R <= R_col + R_uf(die) + R_uf(interposer);
- lower (Dirichlet principle, admissible temperature = isothermal-disc plate solutions joined by the 1D column field,
  continuous because both column ends are isothermal in this trial): R >= R_col + R_iso(die) + R_iso(interposer);
  with R_col = h_b / (k_sac pi a^2).
- informative: the parallel-column (1D, no spreading) resistance R_1D = R_col + t_d / (k pi b^2) + t_s / (k pi b^2) is a
  further, looser lower bound.
A conforming finite-element temperature solution over-estimates the conductance, so the FE resistance approaches the
exact R from below; the gate is that it lies between the two bounds.

Run: cd validation && uv run python pkg2/bump_bounds.py
"""

from __future__ import annotations

import math

import numpy as np
from common_pkg2 import LIB, write_expected
from scipy.special import gamma, j0, j1, jn_zeros, jv

N_TERMS = 40000


def _modes(b: float, n: int = N_TERMS) -> np.ndarray:
    return jn_zeros(1, n) / b


def r_uf(k: float, tau: float, b: float, a: float, n: int = N_TERMS) -> float:
    lam = _modes(b, n)
    th = np.tanh(np.minimum(lam * tau, 50.0))
    s = np.sum(4 * j1(lam * a) ** 2 / (math.pi * a**2 * b**2 * k * lam**3 * j0(lam * b) ** 2 * th))
    return tau / (math.pi * b**2 * k) + float(s)


def r_iso(k: float, tau: float, b: float, a: float, M: int, n: int = N_TERMS) -> float:
    lam = _modes(b, n)
    th = np.tanh(np.minimum(lam * tau, 50.0))
    nu = np.arange(M) - 0.5
    Q = math.pi * a**2 / (nu + 1)  # total flux of each basis function
    # F[m, n] = int_0^a phi_m J0(l_n r) r dr
    F = np.array([a**2 * 2**v * gamma(v + 1) * jv(v + 1, lam * a) / (lam * a) ** (v + 1) for v in nu])
    w = 2 / (b**2 * j0(lam * b) ** 2 * k * lam * th)  # disc temperature of mode n per unit flux coefficient
    K = np.outer(Q, Q) * tau / (math.pi * b**2 * k) + 2 * math.pi * (F * w) @ F.T
    x = np.linalg.solve(K, Q)
    return float(1 / (Q @ x))


def main() -> None:
    # sims/bump-array-thermal.yaml (illustrative inputs; k from the library)
    a, p, h_b, t_d, t_s = 50e-6, 200e-6, 75e-6, 200e-6, 100e-6
    b = p / math.sqrt(math.pi)
    k_si, k_sac = LIB["silicon"]["k"], LIB["sac305"]["k"]
    R_col = h_b / (k_sac * math.pi * a**2)
    uf_d, uf_s = r_uf(k_si, t_d, b, a), r_uf(k_si, t_s, b, a)
    def iso_x(tau: float, M: int) -> tuple[float, float]:
        r1, r2 = r_iso(k_si, tau, b, a, M, N_TERMS), r_iso(k_si, tau, b, a, M, 2 * N_TERMS)
        return 2 * r2 - r1, (r2 - r1) / r2

    conv = {M: (iso_x(t_d, M)[0], iso_x(t_s, M)[0]) for M in (2, 4, 6)}
    (iso_d, nch_d), (iso_s, nch_s) = iso_x(t_d, 6), iso_x(t_s, 6)
    ch = max(abs(conv[6][0] - conv[4][0]) / conv[6][0], abs(conv[6][1] - conv[4][1]) / conv[6][1])
    # series truncation check of the uniform-flux series: half the terms
    uf_d_half = r_uf(k_si, t_d, b, a, N_TERMS // 2)
    lower, upper = R_col + iso_d + iso_s, R_col + uf_d + uf_s
    one_d = R_col + (t_d + t_s) / (k_si * math.pi * b**2)
    # half-space checks of the two plate forms (thick plate, b = 100 a): 1/(4 k a) and 8/(3 pi^2 k a) times flux-tube
    # factors close to 1 - 1.41 a/b
    hs_iso = r_iso(1.0, 500.0, 100.0, 1.0, 6, 4 * N_TERMS) - 500.0 / (math.pi * 100.0**2)
    hs_uf = r_uf(1.0, 500.0, 100.0, 1.0) - 500.0 / (math.pi * 100.0**2)
    print(f"R_col {R_col:.6f}  uf die {uf_d:.6f} sub {uf_s:.6f}  iso die {iso_d:.6f} sub {iso_s:.6f}")
    print("iso Galerkin convergence", conv, "rel change M 4 -> 6", ch)
    print("series truncation: uf (N/2 vs N)", uf_d_half / uf_d - 1, " iso N -> 2N change", nch_d, nch_s)
    print(f"bounds [{lower:.6f}, {upper:.6f}] K/W, gap {(upper - lower) / lower:.3e}; 1D parallel {one_d:.6f}")
    print("half-space checks (b/a = 100): iso", hs_iso, "vs 0.25 and the flux-tube factor;", "uf", hs_uf, "vs", 8 / (3 * math.pi**2))
    loc = "validation/pkg2/bump_bounds.py r_uf(), r_iso(), main()"
    targets = [
        {"metric_id": "R_lower", "value": lower, "unit": "K/W", "definition": "R_col + R_iso(die) + R_iso(interposer) (Dirichlet principle)",
         "precision": {"galerkin_rel_change_M4_M6": ch, "series_terms": [N_TERMS, 2 * N_TERMS],
                                                                                                             "iso_rel_change_N_2N": [nch_d, nch_s]}, "locator": loc},
        {"metric_id": "R_upper", "value": upper, "unit": "K/W", "definition": "R_col + R_uf(die) + R_uf(interposer) (complementary energy)",
         "precision": {"series_terms": N_TERMS, "rel_change_half_terms": uf_d_half / uf_d - 1}, "locator": loc},
        {"metric_id": "R_1D", "value": one_d, "unit": "K/W", "definition": "parallel-column 1D resistance (no spreading), looser lower bound", "locator": loc},
    ]
    out = write_expected("PK-08", targets, "validation/pkg2/bump_bounds.py",
                         "variational two-sided bounds with exact (uniform flux) and Galerkin (isothermal disc) plate spreading resistances (own derivation)",
                         extra={"inputs": {"a_m": a, "pitch_m": p, "b_m": b, "h_b_m": h_b, "t_die_m": t_d, "t_interposer_m": t_s,
                                           "k_si": k_si, "k_sac305": k_sac},
                                "parts_K_per_W": {"R_col": R_col, "R_uf_die": uf_d, "R_uf_interposer": uf_s, "R_iso_die": iso_d,
                                                  "R_iso_interposer": iso_s},
                                "galerkin_convergence": {str(m): list(v) for m, v in conv.items()},
                                "half_space_check": {"iso_times_k_a": hs_iso, "uf_times_k_a": hs_uf,
                                                     "uf_exact_half_space": 8 / (3 * math.pi**2), "iso_exact_half_space": 0.25}},
                         command="cd validation && uv run python pkg2/bump_bounds.py")
    print(out)


if __name__ == "__main__":
    main()
