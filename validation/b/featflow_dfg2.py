"""Extrema of the FEATFLOW 2014 'new reference results' for DFG 2D-2 (Re 100).

Input: cache/eval-b/featflow-dfg2-2014/20141124_dfg_bench2_official.zip (sha256 in its sidecar), files
logs/results_cc2d_bench2_referencenew/bdforces_q2_lv<L>_dt<k> (columns: step, time, bdc, c_D, c_L) and
pointvalues_q2_lv<L>_dt<k> (pressure at (0.15, 0.2) col 7 and (0.25, 0.2) col 12, 1-based).
Output: dict per (level, dt index) with c_D max, c_L max, St (from upward zero crossings of c_L, Ubar = 1, D = 0.1),
dp at t0 + 1/(2f) with t0 at a c_L maximum (1996 definition).
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
ZIP = ROOT / "cache/eval-b/featflow-dfg2-2014/20141124_dfg_bench2_official.zip"
DIR = "logs/results_cc2d_bench2_referencenew/"


def _load(z: zipfile.ZipFile, name: str) -> np.ndarray:
    return np.loadtxt(io.StringIO(z.read(DIR + name).decode()), comments="#")


def extrema() -> dict:
    out = {}
    with zipfile.ZipFile(ZIP) as z:
        names = set(z.namelist())
        for lv in range(2, 7):
            for k in (1, 2, 4):
                fn = f"bdforces_q2_lv{lv}_dt{k}"
                if DIR + fn not in names:
                    continue
                b = _load(z, fn)
                t, cd, cl = b[:, 1], b[:, 3], b[:, 4]
                up = np.nonzero((cl[:-1] < 0) & (cl[1:] >= 0))[0]
                tz = t[up] - cl[up] * (t[up + 1] - t[up]) / (cl[up + 1] - cl[up])
                period = float(np.mean(np.diff(tz))) if len(tz) > 1 else float("nan")
                f = 1.0 / period
                rec = {"c_D_max": float(cd.max()), "c_L_max": float(cl.max()), "St": 0.1 * f / 1.0,
                       "periods_used": int(len(tz) - 1), "t_range": [float(t[0]), float(t[-1])], "n": int(len(t))}
                pn = f"pointvalues_q2_lv{lv}_dt{k}"
                if DIR + pn in names:
                    p = _load(z, pn)
                    dp = p[:, 6] - p[:, 11]
                    i0 = int(np.argmax(cl[: max(2, int(len(cl) * 0.6))]))
                    th = t[i0] + 0.5 * period
                    if th <= p[-1, 1]:
                        rec["dp_half_period"] = float(np.interp(th, p[:, 1], dp))
                out[f"lv{lv}_dt{k}"] = rec
    return out


if __name__ == "__main__":
    for key, r in extrema().items():
        print(key, {k: (round(v, 6) if isinstance(v, float) else v) for k, v in r.items()})
