# SPDX-License-Identifier: GPL-3.0-or-later
"""Reference of WO-86 (sims/tfln-mzm-pushpull.yaml): push-pull thin-film LN modulator, VpiL and dn/dV of arm A.

Source: sibling repository eo-modulator-atlas (own work of the same author, read only), canonical push-pull case
validation/cases/K4.yaml and its reference validation/reference/K4-es-eo.json (2026-10-15): scikit-fem P2
electrostatics on gmsh meshes at 3 scales, vector FEM N2/P2 arm modes (femwell formulation) at a fixed optical mesh
(h_core 0.04 um; a 0.028 um check changes VpiL by 1.0e-6 V cm), first-order Pockels perturbation with the full tensor;
observed-order extrapolation with a GCI band (factor 1.25). The arm-A TE0 index is the air-clad rib reference
(validation/reference/K2-fem.json, extrapolated), because the arm window equals that case (electrodes absent).

Writes eval/expected/WO-86.json (VpiL in V m, the engine unit).
Run: cd validation && uv run python photonics2/k4_reference.py [--atlas ../../eo-modulator-atlas]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, write_expected  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", default=str(ROOT.parent / "eo-modulator-atlas"))
    a = ap.parse_args()
    ref = Path(a.atlas) / "validation" / "reference"
    k4b, k2b = (ref / "K4-es-eo.json").read_bytes(), (ref / "K2-fem.json").read_bytes()
    k4, k2 = json.loads(k4b), json.loads(k2b)
    ex = k4["extrapolated"]

    def prec(e: dict, scale: float = 1.0) -> dict:
        return {"U": e["U"] * scale, "f_finest": e["f_finest"] * scale, "p_observed": e["p_observed"], "method": e["method"], "levels_f": [v * scale for v in e["f"]]}

    targets = [
        {"metric_id": "VpiL_0", "value": ex["vpil_vcm"]["f_ext"] * 1e-2, "unit": "V*m", "precision": prec(ex["vpil_vcm"], 1e-2),
         "note": "push-pull VpiL = lambda / (2 |dn_A - dn_B|), dn per volt of the full terminal voltage; atlas value in V cm x 1e-2"},
        {"metric_id": "dneffdV_0", "value": ex["dn_A_per_V"]["f_ext"], "unit": "1/V", "precision": prec(ex["dn_A_per_V"]),
         "note": "first-order dn_eff / dV of arm A (x > 0)"},
        {"metric_id": "neff_0", "value": k2["extrapolated"]["n_eff"]["f_ext"], "unit": "1", "precision": prec(k2["extrapolated"]["n_eff"]),
         "note": "arm-A TE0 index = the air-clad rib reference (same window, electrodes absent); K4 arm mode at h 0.04 um: " + repr(k4["arm_modes"]["A"]["n_eff"])},
    ]
    inputs = {"files": ["eo-modulator-atlas validation/reference/K4-es-eo.json", "eo-modulator-atlas validation/reference/K2-fem.json"],
              "sha256": [hashlib.sha256(k4b).hexdigest(), hashlib.sha256(k2b).hexdigest()],
              "case_sha256": [k4["case_sha256"], k2["case_sha256"]], "atlas_commit": "0546007", "atlas_date": k4["date"]}
    method = ("eo-modulator-atlas push-pull case reference: scikit-fem P2 electrostatics (3 mesh scales), vector FEM N2/P2 arm modes, "
              "first-order Pockels with the full tensor, Richardson-type extrapolation with a GCI band (factor 1.25)")
    p = write_expected("WO-86", "validation/photonics2/k4_reference.py", "cd validation && uv run python photonics2/k4_reference.py", method, targets, inputs)
    for t in targets:
        print(f"{t['metric_id']:10s} {t['value']:.10g} {t['unit']}  U {t['precision']['U']:.3g}")
    print("wrote", p.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
