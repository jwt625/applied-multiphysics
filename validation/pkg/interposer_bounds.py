# SPDX-License-Identifier: GPL-3.0-or-later
"""Two-sided closed-form bounds on the power-weighted mean active-layer temperature rise of sims/interposer-thermal-3d
(PK-05).

Model: steady conduction, die tops at T_case (Dirichlet), all other surfaces adiabatic, uniform volume source in each
die's active layer (thickness t_a at the die bottom). Thermal compliance J = int Q (T - T_case) dV = sum_i P_i dT_i,
dT_i = mean active-layer temperature rise of die i (uniform source, so the volume mean is the power-weighted mean).
Variational principle (Thomson / Rayleigh): J = max_T [2 int Q (T - T_case) dV - int k |grad T|^2 dV] over T = T_case on
the Dirichlet faces, hence J does not increase when k increases anywhere (monotonicity). Bounds:
- upper (k = 0 in the bump layer and the interposer): each die is a 1D slab, adiabatic bottom and sides, isothermal top;
  dT_i = P_i / (k_si A_i) (t_d - t_a + t_a / 3);
- lower (k -> infinity in the bump layer and the interposer): those regions share one temperature T_p; each die is a 1D
  slab between T_p (bottom) and T_case (top) with the source layer at the bottom; T_p follows from zero net heat into
  the adiabatic interposer, sum_i (heat from die i into the plate) = 0.
Also: a conforming finite-element solution under-estimates J (the Galerkin solution maximises over a subspace), so the
upper bound holds on every mesh level; the lower bound holds for the exact field and for a converged FE solution.
Reported quantity: dT_mean = J / P_total (K).

Run: cd validation && uv run python pkg/interposer_bounds.py
"""

from __future__ import annotations

import numpy as np
from common_pkg import LIB, write_expected

K_SI = LIB["silicon"]["k"]
T_A, T_D = 10e-6, 300e-6
DIES = {  # name: (area m^2, power W); sims/interposer-thermal-3d.yaml
    "logic": (6e-3 * 6e-3, 30.0),
    "mem_l": (3e-3 * 5e-3, 5.0),
    "mem_r": (3e-3 * 5e-3, 5.0),
}


def die_1d(A: float, P: float, Tp: float | None) -> tuple[float, float]:
    """1D slab x in [0, t_d] (x = 0 die bottom), source s = P / (A t_a) on [0, t_a], T(t_d) = 0 (rise over T_case).
    Tp None: adiabatic bottom; else T(0) = Tp. Returns (mean rise over the source layer, heat into the plate at x = 0, W)."""
    s, k, ta, td = P / (A * T_A), K_SI, T_A, T_D
    # T(x) = T0 + g x - s x^2 / (2k) on [0, ta]; linear above with slope g - s ta / k
    # T(td) = T0 + g ta - s ta^2/(2k) + (g - s ta/k)(td - ta) = 0
    if Tp is None:
        g = 0.0
        T0 = -(g * ta - s * ta**2 / (2 * k) + (g - s * ta / k) * (td - ta))
    else:
        T0 = Tp
        # T0 + g td - s ta^2/(2k) - s ta (td - ta)/k = 0
        g = (-T0 + s * ta**2 / (2 * k) + s * ta * (td - ta) / k) / td
    mean = T0 + g * ta / 2 - s * ta**2 / (6 * k)
    q_plate = k * A * g  # heat flowing down (x decreasing) out of the die into the plate: -k dT/dx * (-1)
    return mean, q_plate


def bounds() -> dict:
    P = sum(p for _, p in DIES.values())
    up = {n: die_1d(A, p, None)[0] for n, (A, p) in DIES.items()}
    # lower: find Tp with sum of heat into the plate = 0 (linear in Tp)
    f = lambda Tp: sum(die_1d(A, p, Tp)[1] for A, p in DIES.values())  # noqa: E731
    f0, f1 = f(0.0), f(1.0)
    Tp = -f0 / (f1 - f0)
    lo = {n: die_1d(A, p, Tp)[0] for n, (A, p) in DIES.items()}
    J_up = sum(DIES[n][1] * up[n] for n in DIES)
    J_lo = sum(DIES[n][1] * lo[n] for n in DIES)
    # closed-form check of the upper bound
    for n, (A, p) in DIES.items():
        assert np.isclose(up[n], p / (K_SI * A) * (T_D - T_A + T_A / 3), rtol=1e-13)
    return {"P_total": P, "dT_mean_upper": J_up / P, "dT_mean_lower": J_lo / P, "T_plate_rise_lower": Tp,
            "upper_per_die": up, "lower_per_die": lo}


def main() -> None:
    b = bounds()
    loc = "validation/pkg/interposer_bounds.py bounds() (compliance monotonicity in k; 1D slab solutions)"
    targets = [
        {"metric_id": "dT_mean_upper", "value": b["dT_mean_upper"], "unit": "K",
         "definition": "upper bound of sum_i P_i dT_i / P_total (dies alone, 1D)", "locator": loc},
        {"metric_id": "dT_mean_lower", "value": b["dT_mean_lower"], "unit": "K",
         "definition": "lower bound (bump layer and interposer perfectly conducting)", "locator": loc},
    ]
    p = write_expected("PK-05", targets, "validation/pkg/interposer_bounds.py",
                       "Two-sided bounds on the power-weighted mean active-layer temperature rise from the monotonicity of "
                       "the thermal compliance in k (exact for the modelled geometry, not estimates)",
                       extra={"inputs": {"k_si": K_SI, "t_a_m": T_A, "t_d_m": T_D, "dies": {n: {"area_m2": A, "P_W": p} for n, (A, p) in DIES.items()}},
                              "per_die": {"upper": b["upper_per_die"], "lower": b["lower_per_die"], "T_plate_rise_lower_K": b["T_plate_rise_lower"]}},
                       command="cd validation && uv run python pkg/interposer_bounds.py")
    print(p)
    print(b)


if __name__ == "__main__":
    main()
