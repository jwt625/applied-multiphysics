# SPDX-License-Identifier: GPL-3.0-or-later
"""CPW on a finite substrate without backside metal, zero metal thickness, quasi-static (PK-04).

Conformal mapping, as written in the Qucs technical documentation s.12 "Coplanar waveguides (CPW)"
(qucs.sourceforge.net/tech/node86.html, read 2026-11-18; main source cited there: Gupta et al., Microstrip Lines and
Slotlines, p.375 ff.):
- k1 = S / (S + 2G) (text before eq. 12.4); k2 = sinh(pi S / (4h)) / sinh(pi (S + 2G) / (4h)) (eq. 12.9);
- eps_re = 1 + (eps_r - 1)/2 * K(k2)/K'(k2) * K'(k1)/K(k1) (eq. 12.8), partial-capacitance (filling-factor) form;
- Z = 30 pi / sqrt(eps_re) * K'(k1)/K(k1) (eq. 12.7); here written with eta0 / 4 = sqrt(mu0/eps0)/4 instead of 30 pi
  (30 pi is 7.7e-4 relative above eta0 / 4), so that the TEM identities hold exactly with the engine's mu0, eps0.
Air line (no dielectric): C'_0 = 4 eps0 K(k1)/K'(k1), L' = mu0 eps0 / C'_0 = (mu0/4) K'(k1)/K(k1): exact for zero
thickness and semi-infinite grounds (the map is exact; only the finite-h dielectric term is approximate).
C' = eps_re C'_0, Z0 = sqrt(L'/C'). K by scipy.special.ellipk (parameter m = k^2), checked against the AGM.

Run: cd validation && uv run python pkg/cpw_conformal.py
"""

from __future__ import annotations

import math

from common_pkg import write_expected
from scipy.special import ellipk

MU0, EPS0 = 1.25663706212e-6, 8.8541878128e-12  # CODATA 2018, as @amp/physics electrostatics


def K(k: float) -> float:
    return float(ellipk(k * k))


def Kp(k: float) -> float:
    return float(ellipk(1 - k * k))


def agm_K(k: float) -> float:
    a, b = 1.0, math.sqrt(1 - k * k)
    for _ in range(80):
        a, b = (a + b) / 2, math.sqrt(a * b)
    return math.pi / (2 * a)


def cpw(S: float, G: float, h: float, er: float) -> dict:
    k1 = S / (S + 2 * G)
    k2 = math.sinh(math.pi * S / (4 * h)) / math.sinh(math.pi * (S + 2 * G) / (4 * h))
    assert abs(K(k1) - agm_K(k1)) < 1e-13 * K(k1)
    q = 0.5 * (K(k2) / Kp(k2)) * (Kp(k1) / K(k1))
    ere = 1 + (er - 1) * q
    C0p = 4 * EPS0 * K(k1) / Kp(k1)
    Lp = MU0 * EPS0 / C0p
    Cp = ere * C0p
    return {"k1": k1, "k2": k2, "q": q, "eps_re": ere, "C0_per_m": C0p, "L_per_m": Lp, "C_per_m": Cp, "Z0": math.sqrt(Lp / Cp)}


def main() -> None:
    S, G, h, er = 20e-6, 10e-6, 100e-6, 11.662595  # sims/cpw-si-interposer.yaml
    r = cpw(S, G, h, er)
    loc = "Qucs technical documentation s.12 (CPW) eqs. (12.7)-(12.9), k1 before (12.4); eta0/4 for 30 pi"
    targets = [
        {"metric_id": "L_per_m", "value": r["L_per_m"], "unit": "H/m", "definition": "(mu0/4) K(k1')/K(k1), exact conformal map (zero thickness, semi-infinite grounds)", "precision": {"method": "elliptic integrals, float64"}, "locator": loc},
        {"metric_id": "C_per_m", "value": r["C_per_m"], "unit": "F/m", "definition": "eps_re 4 eps0 K(k1)/K(k1'), partial-capacitance eps_re (accuracy not stated by the source)", "precision": {"method": "elliptic integrals, float64"}, "locator": loc},
        {"metric_id": "Z0", "value": r["Z0"], "unit": "Ohm", "definition": "sqrt(L'/C')", "precision": {"method": "elliptic integrals, float64"}, "locator": loc},
    ]
    p = write_expected("PK-04", targets, "validation/pkg/cpw_conformal.py",
                       "Conformal mapping for a CPW on a finite substrate without backside metal (Qucs s.12 after Gupta et al.)",
                       extra={"inputs": {"S_m": S, "G_m": G, "h_m": h, "eps_r": er, **{k: r[k] for k in ("k1", "k2", "q", "eps_re", "C0_per_m")}}},
                       command="cd validation && uv run python pkg/cpw_conformal.py")
    print(p)
    print(r)


if __name__ == "__main__":
    main()
