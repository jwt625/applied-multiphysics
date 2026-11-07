"""Write eval/expected/<ID>.json (amp-eval-expected/0) for class-b targets that a script produces.

Currently:
- CP-44: digitized cross-check values from validation/b/digitized/arabjuneghani2022-fig4.json
  (produced by validation/b/digitize.py from the spec in validation/b/digitize_specs/).
- FL-04: DFG 2D-2 extrema from the FEATFLOW 2014 reference data (validation/b/featflow_dfg2.py).

Usage (from validation/): uv run python b/gen_expected.py
"""

from __future__ import annotations

import datetime as dt
import json
import platform
import re
import shutil
import subprocess
import sys
from importlib import metadata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import featflow_dfg2  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def tool_version(cmd: list[str]) -> str:
    if shutil.which(cmd[0]) is None:
        return "N/A (not installed)"
    r = subprocess.run(cmd, capture_output=True, text=True)
    txt = (r.stdout + r.stderr).strip().splitlines()
    m = re.search(r"\d+\.\d+(\.\d+)?", txt[0] if txt else "")
    return m.group(0) if m else "N/A"


def versions() -> dict:
    v = {"python": platform.python_version()}
    for pkg in ("numpy", "pillow"):
        try:
            v[pkg] = metadata.version(pkg)
        except metadata.PackageNotFoundError:
            v[pkg] = "N/A"
    v["tesseract"] = tool_version(["tesseract", "--version"])
    v["pdftoppm (poppler)"] = tool_version(["pdftoppm", "-v"])
    return v


def sample(curve: dict, x: float) -> dict:
    for s in curve["samples"]:
        if s["x"] == x and s.get("y") is not None:
            return s
    raise SystemExit(f"no digitized sample at x = {x}")


def cp44() -> dict:
    src = ROOT / "validation/b/digitized/arabjuneghani2022-fig4.json"
    d = json.loads(src.read_text())
    p = d["panels"]
    targets = []
    for mid, panel, curve, x, unit, what in [
        ("alpha_measured_66GHz", "alpha", "alpha_measured_dB_per_cm", 66, "dB/cm", "measured RF loss at 66 GHz"),
        ("alpha_simulated_66GHz", "alpha", "alpha_simulated_dB_per_cm", 66, "dB/cm", "paper-simulated RF loss at 66 GHz"),
        ("nm_measured_50GHz", "nm", "nm_measured", 50, "1", "measured RF effective index at 50 GHz"),
        ("Zm_measured_40GHz", "Zm", "Zm_measured_ohm", 40, "ohm", "measured Z_m at 40 GHz"),
        ("Zm_simulated_40GHz", "Zm", "Zm_simulated_ohm", 40, "ohm", "paper-simulated Z_m at 40 GHz"),
    ]:
        s = sample(p[panel]["curves"][curve], x)
        targets.append({"metric_id": mid, "value": round(s["y"], 6), "unit": unit, "what": what,
                        "precision": {"method": "digitized (validation/b/digitize.py)", "u_k1": round(s["u"], 6),
                                      "U_k2": round(s["U_k2"], 6)}})
    for mid, panel, curve, unit in [("Zm_measured_range", "Zm", "Zm_measured_ohm", "ohm"),
                                     ("Zm_simulated_range", "Zm", "Zm_simulated_ohm", "ohm")]:
        c = p[panel]["curves"][curve]
        targets.append({"metric_id": mid, "value": [round(v, 4) for v in c["y_range"]], "unit": unit,
                        "what": f"min / max over {c['x_range'][0]:.2f}-{c['x_range'][1]:.2f} GHz",
                        "precision": {"method": "digitized", "u_k1_median": round(c["u_y_median"], 6)}})
    return {
        "schema": "amp-eval-expected/0",
        "case": "CP-44",
        "class": "b",
        "generator": "validation/b/gen_expected.py",
        "command": "uv run --no-project python validation/b/gen_expected.py",
        "method": "Code-based digitization of Arab Juneghani 2022 Fig. 4 (CC BY 4.0), p.4; protocol in DevLog-007 s.7; "
                  "inputs validation/b/digitize_specs/arabjuneghani2022-fig4.json",
        "inputs": {"digitized": "validation/b/digitized/arabjuneghani2022-fig4.json",
                   "source_sha256": d["source"]["source_sha256"], "digitized_at": d["created"]},
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "versions": versions(),
        "platform": {"system": platform.system(), "machine": platform.machine()},
        "targets": targets,
    }


def fl04() -> dict:
    ex = featflow_dfg2.extrema()
    fin, l5, d2 = ex["lv6_dt4"], ex["lv5_dt4"], ex["lv6_dt2"]
    side = json.loads((ROOT / "cache/eval-b/featflow-dfg2-2014/20141124_dfg_bench2_official.zip.json").read_text())
    targets = []
    for mid, key, unit in [("c_D_max", "c_D_max", "1"), ("c_L_max", "c_L_max", "1"), ("St", "St", "1"),
                           ("delta_p_half_period", "dp_half_period", "Pa (rho = 1)")]:
        v = fin[key]
        spread = abs(v - l5[key]) + abs(v - d2[key])
        targets.append({"metric_id": mid, "value": round(v, 7), "unit": unit,
                        "precision": {"method": "FEATFLOW Q2/P1disc level 6, finest time step (dt index 4)",
                                      "level_spread_L5_L6": round(abs(v - l5[key]), 8),
                                      "dt_spread_dt2_dt4": round(abs(v - d2[key]), 8),
                                      "proposed_rel_tol": round(2 * spread / abs(v), 6)}})
    return {
        "schema": "amp-eval-expected/0",
        "case": "FL-04",
        "class": "b",
        "generator": "validation/b/gen_expected.py (fl04) + validation/b/featflow_dfg2.py",
        "command": "cd validation && uv run python b/gen_expected.py",
        "method": "Extrema over the stored 1 s window (t 9-10 s, about 3 periods) of bdforces_q2_lv*_dt* (c_D, c_L) "
                  "and pointvalues (p(0.15, 0.2) - p(0.25, 0.2)); St from upward zero crossings of c_L, Ubar 1, D 0.1; "
                  "dp at t0 + 1/(2f) with t0 at the first c_L maximum (1996 definition). Proposed tolerance = "
                  "2 x (level spread + time-step spread), an assumption.",
        "inputs": {"zip": "cache/eval-b/featflow-dfg2-2014/20141124_dfg_bench2_official.zip", "zip_sha256": side["sha256"],
                   "url": side["url"], "all_levels": ex},
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "versions": versions(),
        "platform": {"system": platform.system(), "machine": platform.machine()},
        "targets": targets,
    }


def main() -> int:
    for cid, fn in (("CP-44", cp44), ("FL-04", fl04)):
        out = ROOT / f"eval/expected/{cid}.json"
        out.write_text(json.dumps(fn(), indent=2) + "\n")
        print("wrote", out.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
