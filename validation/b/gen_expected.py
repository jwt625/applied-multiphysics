"""Write eval/expected/<ID>.json (amp-eval-expected/0) for class-b targets that a script produces.

Currently: CP-44 digitized cross-check values from validation/b/digitized/arabjuneghani2022-fig4.json
(produced by validation/b/digitize.py from the spec in validation/b/digitize_specs/).

Usage: uv run --no-project python validation/b/gen_expected.py
"""

from __future__ import annotations

import datetime as dt
import json
import platform
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


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
        "versions": {"python": platform.python_version()},
        "platform": {"system": platform.system(), "machine": platform.machine()},
        "targets": targets,
    }


def main() -> int:
    out = ROOT / "eval/expected/CP-44.json"
    out.write_text(json.dumps(cp44(), indent=2) + "\n")
    print("wrote", out.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
