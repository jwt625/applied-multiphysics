# SPDX-License-Identifier: GPL-3.0-or-later
"""Reference values of the photonic mode-solver library examples (lane E2, DevLog-048): writes
eval/expected/WO-80.json ... WO-85.json (amp-eval-expected/0).

- WO-80 Au / air surface plasmon: analytic n_spp = sqrt(eps_m eps_d / (eps_m + eps_d)), eps_m = (n + i kappa)^2 from
  materials/gold.yaml (Johnson and Christy 1972 table row at 0.6595 um), eps_d = 1; mpmath 40 digits, numpy cross-check.
- WO-81 leaky Si wire: tabulated from Bienstman et al., Opt. Quantum Electron. 38, 731 (2006) (author copy read 2026-11-18).
- WO-82 / WO-83 TFLN rib K2 / K3: eo-modulator-atlas validation/reference/K2-fem.json, K3-fem.json (sibling repository,
  read only; same author), Richardson-extrapolated values with their uncertainty U.
- WO-84 Si directional coupler: Tidy3D example notebook BroadbandDirectionalCoupler printed output (read 2026-11-18).
- WO-85 Si wire bend loss: points digitized from Kakihara et al. 2006 Fig. 4 (modes3/kakihara2006_fig4.json, written by
  modes3/digitize_fig.py from a 400 dpi rendering of the open copy).

Usage (from validation/): uv run python modes3/references.py [--atlas ../../eo-modulator-atlas] [--dry-run]
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import platform
import sys
from pathlib import Path

import mpmath as mp
import numpy as np
import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EXP = ROOT / "eval" / "expected"
GEN = "validation/modes3/references.py"
CMD = "cd validation && uv run python modes3/references.py"


def versions() -> dict:
    return {"python": platform.python_version(), "numpy": np.__version__, "mpmath": mp.__version__, "pyyaml": yaml.__version__}


def doc(case: str, method: str, targets: list[dict], inputs: dict | None = None) -> dict:
    d = {
        "schema": "amp-eval-expected/0",
        "case": case,
        "class": "c",
        "generator": GEN,
        "command": CMD,
        "method": method,
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "versions": versions(),
        "platform": {"system": platform.system(), "machine": platform.machine(), "python_impl": platform.python_implementation().lower()},
        "targets": targets,
    }
    if inputs:
        d["inputs"] = inputs
    return d


def wo80() -> dict:
    g = yaml.safe_load((ROOT / "materials" / "gold.yaml").read_text())
    lam_um = 0.6595
    tn, tk = g["properties"]["n"]["table"], g["properties"]["kappa"]["table"]
    i = tn["xs"].index(lam_um)
    assert tk["xs"][i] == lam_um
    n, k = tn["ys"][i], tk["ys"][i]
    mp.mp.dps = 40
    em = (mp.mpf(str(n)) + 1j * mp.mpf(str(k))) ** 2
    ns = mp.sqrt(em / (em + 1))
    lam = mp.mpf("0.6595e-6")
    lprop = lam / (4 * mp.pi * ns.imag)
    # numpy cross-check (double)
    em2 = (n + 1j * k) ** 2
    ns2 = np.sqrt(em2 / (em2 + 1))
    tg = [
        {"metric_id": "neff_0", "value": float(ns.real), "unit": "1", "precision": {"method": "mpmath 40 digits", "numpy": float(ns2.real), "diff": float(ns.real) - float(ns2.real)}},
        {"metric_id": "kappaEff_0", "value": float(ns.imag), "unit": "1", "precision": {"method": "mpmath 40 digits", "numpy": float(ns2.imag), "diff": float(ns.imag) - float(ns2.imag)}},
        {"metric_id": "Lprop_0", "value": float(lprop), "unit": "m", "definition": "power 1/e length lambda / (4 pi Im n_spp)"},
    ]
    return doc("WO-80", "Analytic planar surface plasmon polariton (TM): beta = k0 sqrt(eps_m eps_d / (eps_m + eps_d)) from continuity of "
               "H_x and (1/eps) dH_x/dy; eps_m = (n + i kappa)^2 (exp(-i omega t)), eps_d = 1; kappaEff = Im n_spp.",
               tg, {"lambda_um": lam_um, "gold_n": n, "gold_kappa": k, "source": "materials/gold.yaml n / kappa tables (Johnson and Christy 1972, refractiveindex.info Au/nk/Johnson.yml)"})


BIEN = "P. Bienstman et al., Opt. Quantum Electron. 38, 731-759 (2006), doi 10.1007/s11082-006-9025-9"


def wo81() -> dict:
    tg = [
        {"metric_id": "neff_0", "value": 2.412372039, "unit": "1", "precision": {"source": f"{BIEN}, p.751 Fig. 18 caption (aperiodic Fourier modal method extrapolated to Mx -> infinity: 2.412372039 + i 2.9134801e-8)", "agreement": "CAMFR 2.412372 (p.749, text below Fig. 16); Fourier modal 2.4123720 +- 2e-7 (p.751)"}},
        {"metric_id": "kappaEff_0", "value": 2.9134801e-8, "unit": "1", "precision": {"source": f"{BIEN}, p.751 Fig. 18 caption", "agreement": "CAMFR 2.9135e-8 (p.749); Fourier modal (2.913480 +- 2e-6) e-8 (p.751)"}},
    ]
    return doc("WO-81", "Tabulated from the primary paper (open author copy photonics.intec.ugent.be/download/pub_2092.pdf, sha256 "
               "aa33532665aadc58c228a0c6bfb493a854c0be8b8372fe7371dea95a4ef4d64a, read 2026-11-18); method spread in Table 6 p.757", tg,
               {"structure": "p.732 Fig. 1: Si wire 500 x 220 nm, n 3.5, on 1 um SiO2 (n 1.45) over Si (n 3.5), air top, 1.55 um, fundamental TE"})


def atlas(case: str, k: str, atlas_root: Path) -> dict:
    f = atlas_root / "validation" / "reference" / f"{k}-fem.json"
    raw = f.read_bytes()
    d = json.loads(raw)
    e = d["extrapolated"]
    tg = []
    for q, mid in (("n_eff", "neff_0"), ("ng_energy", "ng_0"), ("te_fraction", "teFraction_0")):
        tg.append({"metric_id": mid, "value": e[q]["f_ext"], "unit": "1",
                   "precision": {"U": e[q]["U"], "f_finest": e[q]["f_finest"], "p_observed": e[q]["p_observed"], "method": e[q]["method"], "levels_h_um": e[q]["h"]}})
    return doc(case, f"eo-modulator-atlas case {k} reference ({d['solver']}; {d['boundary']}), Richardson-extrapolated over 4 levels "
               f"(date {d['date']}); ng_energy includes Sellmeier material dispersion (LN Zelmon 1997, SiO2 Malitson 1965)",
               tg, {"file": f"eo-modulator-atlas validation/reference/{k}-fem.json", "sha256": hashlib.sha256(raw).hexdigest(),
                    "case_sha256": d["case_sha256"], "atlas_commit": "0546007"})


TIDY = "Flexcompute Tidy3D example notebook BroadbandDirectionalCoupler (tidy3d-notebooks, develop branch, read 2026-11-18), cell 14 printed output"


def wo84() -> dict:
    ne, no = 2.459162628532339, 2.43821523251537
    lam = 1.55e-6
    tg = [
        {"metric_id": "neff_0", "value": ne, "unit": "1", "precision": {"source": TIDY}},
        {"metric_id": "neff_1", "value": no, "unit": "1", "precision": {"source": TIDY}},
        {"metric_id": "dn", "value": ne - no, "unit": "1", "definition": "n_even - n_odd (derived)"},
        {"metric_id": "L_c", "value": lam / (2 * (ne - no)), "unit": "m", "definition": "lambda / (2 (n_even - n_odd)) (derived)"},
    ]
    return doc("WO-84", "Other open solver: Tidy3D finite-difference mode solver (waveguide plugin RectangularDielectric, grid_resolution 40), "
               "Si 'Li1993_293K', SiO2 'Horiba' material models; values printed in the notebook", tg)


def wo85() -> dict:
    d = json.loads((HERE / "kakihara2006_fig4.json").read_text())
    tg = []
    for p in d["points"]:
        if p["value"] is None:
            continue
        mid = f"loss90_{p['mode'].lower()}_R{str(p['R_um']).replace('.', 'p')}"
        lo, hi = p["line_extent"]
        tg.append({"metric_id": mid, "value": p["value"], "unit": "dB", "R_um": p["R_um"], "mode": f"quasi-{p['mode']}",
                   "precision": {"method": "digitized red (CCS) curve, mean row of the drawn line at the column of R",
                                 "line_extent_dB": [lo, hi], "half_extent_dB": (hi - lo) / 2, "dB_per_px": p["dB_per_px"]}})
    return doc("WO-85", "Digitized from Kakihara, Kono, Saitoh, Koshiba, Opt. Express 14, 11128-11141 (2006), doi 10.1364/OE.14.011128, "
               "Fig. 4 (p.11139; full-vector FEM in local cylindrical coordinates with PML, 'CCS'); open copy "
               "eprints.lib.hokudai.ac.jp (OE14-23.pdf sha256 5a6c0d60a7061f717274db36cd9c4a4b8edbdab356cbec3c199c7383497b4b78) "
               "rendered at 400 dpi (pdftoppm), digitized by validation/modes3/digitize_fig.py", tg,
               {"panels": d["panels"]})


def main() -> int:
    args = sys.argv[1:]
    atlas_root = Path(args[args.index("--atlas") + 1]) if "--atlas" in args else ROOT.parent / "eo-modulator-atlas"
    docs = [wo80(), wo81(), atlas("WO-82", "K2", atlas_root), atlas("WO-83", "K3", atlas_root), wo84(), wo85()]
    for d in docs:
        print(d["case"], {t["metric_id"]: t["value"] for t in d["targets"]})
        if "--dry-run" not in args:
            (EXP / f"{d['case']}.json").write_text(json.dumps(d, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
