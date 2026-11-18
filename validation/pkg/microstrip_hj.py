# SPDX-License-Identifier: GPL-3.0-or-later
"""Microstrip, zero strip thickness, quasi-static: Hammerstad-Jensen closed forms (PK-03).

E. Hammerstad, O. Jensen, "Accurate models for microstrip computer-aided design", IEEE MTT-S International Microwave
Symposium Digest 1980, pp. 407-409 (primary not read). Formulas as re-tabulated (open, read 2026-11-18):
- Qucs technical documentation, s.11.1 "Single microstrip line" (qucs.sourceforge.net/tech/node75.html), eqs. (11.4)-(11.6)
  for Z_L1 and (11.15)-(11.18) for eps_eff, with the stated accuracy: Z_L1 better than 0.01 % for W/h <= 1 and 0.03 %
  for W/h <= 1000; eps_eff better than 0.2 % for eps_r < 128 and 0.01 <= W/h <= 100;
- scikit-rf skrf/media/mline.py (BSD-3-Clause), functions hammerstad_zl, hammerstad_ab, hammerstad_er (same forms).
u = W/h; f(u) = 6 + (2 pi - 6) exp(-(30.666/u)^0.7528); Z01 = eta0/(2 pi) ln(f(u)/u + sqrt(1 + (2/u)^2));
a(u) = 1 + ln((u^4 + (u/52)^2)/(u^4 + 0.432))/49 + ln(1 + (u/18.1)^3)/18.7; b = 0.564 ((eps_r - 0.9)/(eps_r + 3))^0.053;
eps_eff = (eps_r + 1)/2 + (eps_r - 1)/2 (1 + 10/u)^(-a b); Z0 = Z01 / sqrt(eps_eff).
TEM line constants: L' = Z01 / c0, C'_0 = 1/(c0 Z01), C' = eps_eff C'_0. eta0 = mu0 c0 with the CODATA 2018 mu0 (the
engine's MU0, EPS0), c0 = 1/sqrt(mu0 eps0).

Run: cd validation && uv run python pkg/microstrip_hj.py
"""

from __future__ import annotations

import math

from common_pkg import write_expected

MU0, EPS0 = 1.25663706212e-6, 8.8541878128e-12  # CODATA 2018, as @amp/physics electrostatics
C0 = 1 / math.sqrt(MU0 * EPS0)
ETA0 = math.sqrt(MU0 / EPS0)


def hj(W: float, h: float, er: float) -> dict:
    u = W / h
    fu = 6 + (2 * math.pi - 6) * math.exp(-((30.666 / u) ** 0.7528))
    z01 = ETA0 / (2 * math.pi) * math.log(fu / u + math.sqrt(1 + (2 / u) ** 2))
    a = 1 + math.log((u**4 + (u / 52) ** 2) / (u**4 + 0.432)) / 49 + math.log(1 + (u / 18.1) ** 3) / 18.7
    b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053
    ee = (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / u) ** (-a * b)
    return {"u": u, "Z01": z01, "eps_eff": ee, "Z0": z01 / math.sqrt(ee), "L_per_m": z01 / C0, "C_per_m": ee / (C0 * z01)}


def main() -> None:
    W, h, er = 10e-6, 10e-6, 2.9  # sims/microstrip-rdl.yaml; eps_r: materials/polyimide-pi2600 (1 kHz data sheet)
    r = hj(W, h, er)
    loc = "Qucs technical documentation s.11.1 eqs. (11.4)-(11.6), (11.15)-(11.18); scikit-rf skrf/media/mline.py"
    acc = {"Z01": "0.01 % (W/h <= 1, Qucs s.11.1)", "eps_eff": "0.2 % (eps_r < 128, 0.01 <= W/h <= 100, Qucs s.11.1)"}
    targets = [
        {"metric_id": "L_per_m", "value": r["L_per_m"], "unit": "H/m", "definition": "Z01 / c0", "precision": {"closed_form_accuracy": acc["Z01"]}, "locator": loc},
        {"metric_id": "C_per_m", "value": r["C_per_m"], "unit": "F/m", "definition": "eps_eff / (c0 Z01)", "precision": {"closed_form_accuracy": f"{acc['Z01']}; {acc['eps_eff']}"}, "locator": loc},
        {"metric_id": "Z0", "value": r["Z0"], "unit": "Ohm", "definition": "Z01 / sqrt(eps_eff)", "precision": {"closed_form_accuracy": f"{acc['Z01']}; half of {acc['eps_eff']}"}, "locator": loc},
    ]
    p = write_expected("PK-03", targets, "validation/pkg/microstrip_hj.py",
                       "Hammerstad-Jensen 1980 quasi-static microstrip (zero thickness), via the open re-tabulations named in the locator",
                       extra={"inputs": {"W_m": W, "h_m": h, "eps_r": er, "u": r["u"], "eps_eff": r["eps_eff"], "Z01_ohm": r["Z01"]}},
                       command="cd validation && uv run python pkg/microstrip_hj.py")
    print(p)
    print(r)


if __name__ == "__main__":
    main()
