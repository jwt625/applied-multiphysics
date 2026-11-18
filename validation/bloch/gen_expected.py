# SPDX-License-Identifier: GPL-3.0-or-later
"""Expected values of the Bloch / Floquet class-c cases (DevLog-050 s.1.6), written to eval/expected/WO-9x.json.

WO-90  square rod lattice (r 0.2 a, eps 12) TM gap edges: the MPB values of eval/expected/WO-04.json (MPB 1.34.0
       resolutions 16-256, Richardson; same physical problem), copied with their precision record, plus the PWE limit
       estimates of the same file (informative).
WO-91  same lattice, TM bands 3 and 8 at X and M: plane-wave expansion (validation/c/gen_pwe.py `bands`, nmax 24,
       floor = change from nmax 20) from validation/bloch/bloch_reference.json.
WO-93  triangular rod lattice (r 0.2 a, eps 12) TM gap edges: the MPB values of eval/expected/WO-61.json, copied.
WO-92  film eps 4, thickness 0.3 lambda0, TM plane wave at 30 deg: |r| and |tau| of the Airy formula (two routes) from
       validation/bloch/bloch_reference.json.

Run (after bloch_refs.py): cd validation && uv run python bloch/gen_expected.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "validation" / "c"))
from common_c import target, write_expected  # noqa: E402

GEN = "validation/bloch/gen_expected.py"
REF = json.loads((ROOT / "validation" / "bloch" / "bloch_reference.json").read_text())


def wo04(mid: str, case: str = "WO-04") -> dict:
    for t in json.loads((ROOT / "eval" / "expected" / f"{case}.json").read_text())["targets"]:
        if t["metric_id"] == mid:
            return t
    raise KeyError(mid)


def main() -> None:
    # WO-90
    lo, hi = wo04("gap_lower"), wo04("gap_upper")
    t90 = [
        target("gap_lower", lo["value"], "1 (c/a)", {**lo["precision"], "copied_from": "eval/expected/WO-04.json gap_lower"}),
        target("gap_upper", hi["value"], "1 (c/a)", {**hi["precision"], "copied_from": "eval/expected/WO-04.json gap_upper"}),
        target("pwe_limit_lower", lo["precision"]["pwe_limit_est"], "1 (c/a)", {"method": "PWE limit estimate of eval/expected/WO-04.json (gap_lower precision.pwe_limit_est)"}),
        target("pwe_limit_upper", hi["precision"]["pwe_limit_est"], "1 (c/a)", {"method": "PWE limit estimate of eval/expected/WO-04.json (gap_upper precision.pwe_limit_est)"}),
    ]
    write_expected("WO-90", t90, GEN, "TM gap edges of the square lattice of rods r 0.2a eps 12 in air: MPB resolution study (Richardson) and PWE limit, as for WO-04 (copied from eval/expected/WO-04.json).",
                   extra={"inputs": {"lattice": "square", "r_over_a": 0.2, "eps_rod": 12.0, "k_path": "MPB tutorial (Gamma-X-M-Gamma, interpolate 4)"}})
    # WO-91
    P = REF["rods_pwe"]
    kred = P["kReduced"]
    ix = next(i for i, k in enumerate(kred) if abs(k[0] - 0.5) < 1e-12 and abs(k[1]) < 1e-12)
    im = next(i for i, k in enumerate(kred) if abs(k[0] - 0.5) < 1e-12 and abs(k[1] - 0.5) < 1e-12)
    prec = {"method": f"PWE TM (validation/c/gen_pwe.py bands, nmax 24, {P['n_plane_waves']} plane waves)", "floor_abs_nmax20_vs_24_all_bands": P["floor_abs_nmax20_vs_24"]}
    t91 = []
    for lab, i in (("X", ix), ("M", im)):
        for b in (2, 7):
            t91.append(target(f"band{b + 1}_{lab}", P["f"][i][b], "1 (c/a)", {**prec, "k_index": i, "k_reduced": kred[i]}))
    write_expected("WO-91", t91, GEN, "TM bands 3 and 8 at X and M of the square rod lattice (r 0.2a, eps 12): plane-wave expansion, nmax 24 (validation/bloch/bloch_refs.py).",
                   extra={"inputs": {"lattice": "square", "r_over_a": 0.2, "eps_rod": 12.0}})
    # WO-92
    c = next(x for x in REF["slab"]["cases"] if x["pol"] == "TM" and x["theta_deg"] == 30.0)
    prec = {"method": "Airy film formula (closed form) cross-checked by a 2 x 2 transfer matrix (validation/bloch/bloch_refs.py)", "route2_diff": c["route2_diff"], "energy_residual": c["energy"]}
    t92 = [target("r_abs", math.hypot(*c["r"]), "1", {**prec, "r": c["r"]}), target("tau_abs", math.hypot(*c["tau"]), "1", {**prec, "tau": c["tau"]})]
    write_expected("WO-92", t92, GEN, "Film eps 4, thickness 0.3 lambda0, in vacuum, TM plane wave at 30 deg: |r| and |tau| (incident amplitude 1).",
                   extra={"inputs": {"eps_film": 4.0, "t_over_lambda0": 0.3, "theta_deg": 30.0, "polarization": "TM (E_z)"}})
    # WO-93: triangular lattice, MPB values of WO-61
    lo, hi = wo04("gap_lower", "WO-61"), wo04("gap_upper", "WO-61")
    t93 = [
        target("gap_lower", lo["value"], "1 (c/a)", {**lo["precision"], "copied_from": "eval/expected/WO-61.json gap_lower"}),
        target("gap_upper", hi["value"], "1 (c/a)", {**hi["precision"], "copied_from": "eval/expected/WO-61.json gap_upper"}),
    ]
    write_expected("WO-93", t93, GEN, "TM gap edges of the triangular lattice of rods r 0.2a eps 12 in air: MPB resolution study (Richardson) and PWE limit, as for WO-61 (copied from eval/expected/WO-61.json).",
                   extra={"inputs": {"lattice": "triangular", "r_over_a": 0.2, "eps_rod": 12.0, "k_path": "MPB tutorial (Gamma-M-K-Gamma, interpolate 4)"}})
    print("WO-90, WO-91, WO-92, WO-93 written")


if __name__ == "__main__":
    main()
