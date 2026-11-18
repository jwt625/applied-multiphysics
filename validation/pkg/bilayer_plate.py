# SPDX-License-Identifier: GPL-3.0-or-later
"""Bilayer plate (die on substrate) under a uniform temperature change: spherical-bending curvature (PK-06).

Classical laminated-plate theory, two isotropic layers, equibiaxial state (kappa_x = kappa_y, the interior of a thin
plate far from free edges): in each layer sigma_xx = sigma_yy = M_i (eps0 + kappa z - alpha_i dT), M_i = E_i / (1 - nu_i),
sigma_zz = 0. Force and moment balance, sum_i int sigma dz = 0 and sum_i int sigma z dz = 0, give a 2 x 2 linear system
for (eps0, kappa) (own derivation). Check: the closed form of Timoshenko, J. Opt. Soc. Am. 11, 233 (1925),
kappa = 6 (a2 - a1) dT (1 + m)^2 / (h [3 (1 + m)^2 + (1 + m n)(m^2 + 1/(m n))]), m = t1/t2, n = M1/M2, h = t1 + t2
(as written in validation/mp/references.py bimetal_strip and advanced-packaging-atlas MA3) with E -> M, must agree to
round-off. Plate kinematics eps(z) = eps0 - z d2w/dr2, so the bottom-surface bow is w(r) - w(0) = -kappa r^2 / 2.

Run: cd validation && uv run python pkg/bilayer_plate.py
"""

from __future__ import annotations

import numpy as np
from common_pkg import LIB, write_expected

BT = {"E": 28e9, "nu": 0.19, "alpha": 14e-6}  # materials/bt-hl832nx (MGC data page, in-plane, below Tg)
SI = LIB["silicon"]
T_SUB, T_DIE = 0.5e-3, 0.3e-3
DT = 298.15 - 398.15
X1, X2 = 1e-3, 2e-3


def clt(layers: list[tuple[float, dict]], dT: float) -> tuple[float, float]:
    """layers bottom to top: (thickness, {E, nu, alpha}); z from the bottom. Returns (eps0 at z = 0, kappa)."""
    A = np.zeros((2, 2))
    b = np.zeros(2)
    z0 = 0.0
    for t, m in layers:
        M = m["E"] / (1 - m["nu"])
        z1 = z0 + t
        I0, I1, I2 = z1 - z0, (z1**2 - z0**2) / 2, (z1**3 - z0**3) / 3
        A += M * np.array([[I0, I1], [I1, I2]])
        b += M * m["alpha"] * dT * np.array([I0, I1])
        z0 = z1
    eps0, kappa = np.linalg.solve(A, b)
    return float(eps0), float(kappa)


def timoshenko(t1: float, m1: dict, t2: float, m2: dict, dT: float) -> float:
    """Layer 1 bottom, layer 2 top; positive kappa = concave up (z up) when the top layer contracts less."""
    M1, M2 = m1["E"] / (1 - m1["nu"]), m2["E"] / (1 - m2["nu"])
    m, n, h = t1 / t2, M1 / M2, t1 + t2
    return 6 * (m2["alpha"] - m1["alpha"]) * dT * (1 + m) ** 2 / (h * (3 * (1 + m) ** 2 + (1 + m * n) * (m**2 + 1 / (m * n))))


def main() -> None:
    eps0, kappa = clt([(T_SUB, BT), (T_DIE, SI)], DT)
    kt = timoshenko(T_SUB, BT, T_DIE, SI, DT)
    assert abs(kt - kappa) <= 1e-12 * abs(kappa), (kt, kappa)
    w2 = -kappa  # plate kinematics eps(z) = eps0 - z w'', so d2w/dr2 = -kappa (z up)
    duz = w2 * (X2**2 - X1**2) / 2
    loc = "validation/pkg/bilayer_plate.py clt() (equals timoshenko() with biaxial moduli to round-off)"
    targets = [
        {"metric_id": "w_curv", "value": w2, "unit": "1/m", "definition": "centre curvature d2w/dr2 of the bottom surface, z up (< 0: dome, centre up)", "locator": loc},
        {"metric_id": "duz_x1_x2", "value": duz, "unit": "m", "definition": "u_z(x2) - u_z(x1) on the bottom = (d2w/dr2) (x2^2 - x1^2) / 2", "locator": loc},
    ]
    p = write_expected("PK-06", targets, "validation/pkg/bilayer_plate.py",
                       "Laminated-plate (biaxial Timoshenko 1925) curvature of a two-layer plate under uniform dT, thin-plate interior limit",
                       extra={"inputs": {"substrate": {"t_m": T_SUB, **BT}, "die": {"t_m": T_DIE, **SI}, "dT_K": DT, "x1_m": X1, "x2_m": X2,
                                         "eps0_bottom": eps0, "kappa_timoshenko_check": kt}},
                       command="cd validation && uv run python pkg/bilayer_plate.py")
    print(p, "kappa", kappa, "timoshenko", kt, "w_curv", w2, "duz", duz)


if __name__ == "__main__":
    main()
