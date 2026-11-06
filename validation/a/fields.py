# SPDX-License-Identifier: GPL-3.0-or-later
"""Exact-field evaluator for class-a cases (input to lane L8's field-error metric).

Usage (from validation/):
  uv run python a/fields.py <CASE> --points pts.json [--out vals.json]
  uv run python a/fields.py --list
  uv run python a/fields.py --selftest

pts.json: {"points": [[x, y], ...] or [[x, y, z], ...], "params": {...optional overrides...}}. SI units.
Output JSON: {"case", "fields": {name: [values...]}, "units": {name: unit}, "params", "generated_at", "versions"}.
Complex fields are written as {"re": [...], "im": [...]}.

Coordinates per case:
  SM-01        (x, y), hole at origin, remote stress along x. Fields sxx syy sxy (Pa), ux uy (m).
  FL-01        (x, y). Kovasznay u v (m/s), p (Pa, zero mean over the domain).
  FL-01-pois   (x, y). Planar Poiseuille u v p.
  WO-03        (x, y, z), sphere at origin, x-polarized plane wave along +z. Ex Ey Ez (complex, units of E0).
  EM-04        (rho, z) or (x, y, z), coil centre at origin, axis z. B_rho B_z (T).
  AC-03        (x, y, z) or (r, theta) with "polar": true; total pressure p (complex, units of p0).
  TR-01        (x,). C/C0 for params Pe (default 10).
  CP-05        (y,). u (m/s).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
from common import iso_now, versions
from gen_em import helmholtz_field
from gen_misc import CP05, TR01, ac03_pressure, danckwerts_profile, eof_profile, kovasznay, poiseuille
from gen_optics import mie_field
from gen_solid import SM01, kirsch_field

DEFAULTS: dict[str, dict[str, Any]] = {
    "SM-01": dict(SM01),
    "FL-01": {"Re": 10.0, "domain": [[-0.5, 1.5], [-0.5, 1.5]]},
    "FL-01-pois": {"mu": 1.0},
    "WO-03": {"radius": 0.525e-6, "wavelength": 0.6328e-6, "m_re": 1.55, "m_im": 0.0, "n_medium": 1.0},
    "EM-04": {"R": 0.1, "I": 1.0, "N": 1},
    "AC-03": {"ka": 5.0, "a": 1.0, "p0": 1.0, "polar": False},
    "TR-01": {"L": TR01["L"], "u": TR01["u"], "k": TR01["k"], "Pe": 10.0},
    "CP-05": dict(CP05),
}


def evaluate(case: str, pts: np.ndarray, params: dict[str, Any] | None = None) -> tuple[dict, dict, dict]:
    p = {**DEFAULTS[case], **(params or {})}
    if case == "SM-01":
        f = kirsch_field(pts[:, 0], pts[:, 1], p["a"], p["s_inf"], p["E"], p["nu"])
        out = {k: f[k] for k in ["sxx", "syy", "sxy", "ux", "uy"]}
        units = {"sxx": "Pa", "syy": "Pa", "sxy": "Pa", "ux": "m", "uy": "m"}
    elif case == "FL-01":
        out = kovasznay(pts[:, 0], pts[:, 1], p["Re"], p["domain"])
        units = {"u": "m/s", "v": "m/s", "p": "Pa"}
    elif case == "FL-01-pois":
        out = poiseuille(pts[:, 0], pts[:, 1], p["mu"])
        units = {"u": "m/s", "v": "m/s", "p": "Pa"}
    elif case == "WO-03":
        E = mie_field(pts, p["radius"], p["wavelength"], complex(p["m_re"], p["m_im"]), p["n_medium"])
        out = {"Ex": E[:, 0], "Ey": E[:, 1], "Ez": E[:, 2]}
        units = {"Ex": "E0", "Ey": "E0", "Ez": "E0"}
    elif case == "EM-04":
        if pts.shape[1] == 3:
            rho, z = np.hypot(pts[:, 0], pts[:, 1]), pts[:, 2]
        else:
            rho, z = pts[:, 0], pts[:, 1]
        Br, Bz = helmholtz_field(rho, z, p["R"], p["I"], p["N"])
        out, units = {"B_rho": Br, "B_z": Bz}, {"B_rho": "T", "B_z": "T"}
    elif case == "AC-03":
        if p["polar"]:
            r, th = pts[:, 0], pts[:, 1]
        else:
            r = np.linalg.norm(pts, axis=1)
            th = np.arccos(np.clip(pts[:, 2] / r, -1, 1))
        out, units = {"p": ac03_pressure(r, th, p["ka"], p["a"], p["p0"])}, {"p": "p0"}
    elif case == "TR-01":
        D = p["u"] * p["L"] / p["Pe"]
        out, units = {"C_over_C0": danckwerts_profile(pts[:, 0], p["L"], p["u"], D, p["k"])}, {"C_over_C0": "1"}
    elif case == "CP-05":
        out, units = {"u": eof_profile(pts[:, 0], p)}, {"u": "m/s"}
    else:
        raise KeyError(case)
    return out, units, p


def _ser(v: np.ndarray) -> Any:
    v = np.asarray(v)
    if np.iscomplexobj(v):
        return {"re": v.real.tolist(), "im": v.imag.tolist()}
    return v.tolist()


def selftest() -> int:
    ok = True
    f, _, _ = evaluate("SM-01", np.array([[0.0, 5e-3]]))
    ok &= math.isclose(f["sxx"][0], 300e6, rel_tol=1e-12)
    f, _, _ = evaluate("EM-04", np.array([[0.0, 0.0]]))
    ok &= math.isclose(f["B_z"][0], (4 / 5) ** 1.5 * 4e-7 * math.pi / 0.1, rel_tol=1e-9)
    f, _, _ = evaluate("WO-03", np.array([[0.0, 0.0, 1e-3]]))  # far from the sphere: |E| close to 1
    ok &= abs(abs(f["Ex"][0]) - 1) < 5e-3
    f, _, _ = evaluate("AC-03", np.array([[1.0, 0.3], [1.0, 2.0]]), {"polar": True})
    ok &= bool(np.all(np.isfinite(f["p"])))
    print("selftest", "ok" if ok else "FAILED")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("case", nargs="?")
    ap.add_argument("--points")
    ap.add_argument("--out")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.list:
        print("\n".join(DEFAULTS))
        return 0
    if a.selftest:
        return selftest()
    if not a.case or not a.points:
        ap.error("case and --points are required")
    spec = json.loads(Path(a.points).read_text())
    pts = np.atleast_2d(np.asarray(spec["points"], dtype=float))
    if pts.shape[0] == 1 and pts.shape[1] > 3:
        pts = pts.T
    vals, units, params = evaluate(a.case, pts, spec.get("params"))
    rec = {"case": a.case, "n_points": int(pts.shape[0]), "fields": {k: _ser(v) for k, v in vals.items()},
           "units": units, "params": params, "generated_at": iso_now(), "versions": versions(),
           "generator": "validation/a/fields.py"}
    text = json.dumps(rec)
    if a.out:
        Path(a.out).write_text(text + "\n")
    else:
        sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
