# SPDX-License-Identifier: GPL-3.0-or-later
"""Hybrid-bond Cu pad expansion (PK-09): thin-film closed forms (own derivation).

Model (sims/hybrid-bond-pad.yaml): axisymmetric cell of a pad array, Cu pad (radius a, thickness h) flush in an SiO2
layer of the same thickness, bonded to a rigid Si wafer whose surface follows the free expansion of Si (alpha_Si dT),
top free, cell rim on rollers (array symmetry), uniform temperature change dT. The sim subtracts the free expansion of
Si everywhere (alpha' = alpha - alpha_Si, base fixed): an exact change of frame that leaves stresses unchanged and shifts
u_z by alpha_Si dT z, the same at the pad top and at the oxide top, so the protrusion is unchanged.

Thin-film limit (a >> h, far from the pad edge, rigid base): in-plane strain' = 0, sigma_zz = 0, so
eps_zz' = (1 + nu) / (1 - nu) alpha' dT and the top rises by u_z' = h (1 + nu) / (1 - nu) alpha' dT. Exact at the centre
of a wide pad and on the oxide far from it, up to the edge disturbance, which decays exponentially with distance / h
(film on a rigid base). Gate: a wide-pad variant (a = 10 h, cell radius 20 h).
Engineering limits for the real pad (a = 1.5 h), informative: laterally free pad and oxide, h (alpha_Cu - alpha_ox) dT,
and both biaxially constrained, h [(1 + nu_Cu) / (1 - nu_Cu) alpha'_Cu - (1 + nu_ox) / (1 - nu_ox) alpha'_ox] dT.

Run: cd validation && uv run python pkg2/pad_film.py
"""

from __future__ import annotations

from common_pkg2 import LIB, write_expected


def main() -> None:
    h, dT = 1e-6, 100.0  # sims/hybrid-bond-pad.yaml (illustrative)
    cu, ox, si = LIB["copper"], LIB["sio2"], LIB["silicon"]
    a_cu, a_ox = cu["alpha"] - si["alpha"], ox["alpha"] - si["alpha"]
    f_cu, f_ox = (1 + cu["nu"]) / (1 - cu["nu"]), (1 + ox["nu"]) / (1 - ox["nu"])
    uz_cu = h * f_cu * a_cu * dT
    uz_ox = h * f_ox * a_ox * dT
    free = h * (cu["alpha"] - ox["alpha"]) * dT
    constrained = uz_cu - uz_ox
    print(f"wide-pad centre u_z' {uz_cu:.6e} m, oxide u_z' {uz_ox:.6e} m; protrusion limits free {free:.6e}, constrained {constrained:.6e}")
    loc = "validation/pkg2/pad_film.py main(): u_z' = h (1 + nu) / (1 - nu) (alpha - alpha_Si) dT"
    targets = [
        {"metric_id": "uz_pad_wide", "value": uz_cu, "unit": "m", "definition": "pad-centre top rise (frame of the Si wafer), wide pad a = 10 h", "locator": loc},
        {"metric_id": "uz_ox_wide", "value": uz_ox, "unit": "m", "definition": "oxide top rise at the cell rim (frame of the Si wafer), wide pad cell", "locator": loc},
        {"metric_id": "protrusion_wide", "value": constrained, "unit": "m", "definition": "pad-centre protrusion over the oxide at the rim, wide pad", "locator": loc},
        {"metric_id": "protrusion_free", "value": free, "unit": "m", "definition": "laterally free limit h (alpha_Cu - alpha_ox) dT (engineering estimate)", "locator": loc},
        {"metric_id": "protrusion_constrained", "value": constrained, "unit": "m", "definition": "biaxially constrained thin-film limit (engineering estimate)", "locator": loc},
    ]
    out = write_expected("PK-09", targets, "validation/pkg2/pad_film.py",
                         "thin-film thermo-elastic closed forms on a rigid base (own derivation)",
                         extra={"inputs": {"h_m": h, "dT_K": dT, "alpha_cu": cu["alpha"], "alpha_ox": ox["alpha"], "alpha_si": si["alpha"],
                                           "nu_cu": cu["nu"], "nu_ox": ox["nu"]}},
                         command="cd validation && uv run python pkg2/pad_film.py")
    print(out)


if __name__ == "__main__":
    main()
