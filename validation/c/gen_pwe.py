# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent plane-wave-expansion (PWE) check of the MPB TM band gaps (lane L7c, audit S9, DevLog-008).

2D photonic crystal of circular rods (eps_a) in air, TM polarization (E_z): for each Bloch vector k,
  |k + G|^2 E_G = (omega/c)^2 sum_G' eps(G - G') E_G'   (generalized Hermitian eigenproblem),
eps(G) = eps_b delta_G0 + (eps_a - eps_b) f 2 J1(|G| r) / (|G| r), f = rod area fraction.
Gap edges are taken on the same k path as the MPB tutorial (corners + 4 interpolated points per segment)
and at several plane-wave cut-offs; the spread between the two largest cut-offs is the PWE floor.
Frequencies in units of c/a (a = lattice constant).

  WO-04  square lattice, r 0.2, eps 12 (MPB tutorial L120: 0.282623311 - 0.419334799)
  WO-61  triangular lattice, r 0.2, eps 12 (MPB tutorial L184: 0.275065617 - 0.446289919)

Run: cd validation && uv run python c/gen_pwe.py
"""

from __future__ import annotations

import json
import math

import numpy as np
from common_c import CACHE_DIR, source_compare, target, write_expected
from scipy import linalg, special

GEN = "validation/c/gen_pwe.py"


def bands(b1, b2, kpts, r, eps_a, area, nmax, nb=4):
    idx = np.array([(i, j) for i in range(-nmax, nmax + 1) for j in range(-nmax, nmax + 1) if i * i + j * j <= nmax**2])
    g = idx[:, :1] * b1 + idx[:, 1:] * b2
    dg = g[:, None, :] - g[None, :, :]
    gm = np.linalg.norm(dg, axis=2)
    fr = math.pi * r * r / area
    with np.errstate(invalid="ignore", divide="ignore"):
        ff = np.where(gm > 0, 2 * special.j1(gm * r) / (gm * r), 1.0)
    epsm = (eps_a - 1.0) * fr * ff + np.eye(len(g)) * 1.0
    out = []
    for k in kpts:
        kg2 = np.sum((k + g) ** 2, axis=1)
        w2 = linalg.eigh(np.diag(kg2), epsm, eigvals_only=True, subset_by_index=[0, nb - 1])
        out.append(np.sqrt(np.abs(w2)) / (2 * math.pi))
    return np.array(out), len(g)


def path(corners, n_interp=4):
    pts = []
    for p, q in zip(corners[:-1], corners[1:], strict=True):
        for t in np.linspace(0, 1, n_interp + 2)[:-1]:
            pts.append(p + t * (q - p))
    pts.append(corners[-1])
    return np.array(pts)


def mpb_levels(lattice):
    """Band-1 max / band-2 min from the MPB runs (JSON lines written by validation/c/mpb/mpb_gaps.py)."""
    out = {}
    for p in sorted(CACHE_DIR.joinpath("mpb-runs").glob(f"run_{lattice}_*.log")):
        for line in p.read_text().splitlines():
            if line.startswith("JSON "):
                d = json.loads(line[5:])
                out[d["resolution"]] = {"lo": d["band1_max"], "hi": d["band2_min"]}
    return out


def run(case, lattice, refs, nmaxes=(8, 12, 16, 20, 24)):
    if lattice == "square":
        a1, a2 = np.array([1.0, 0.0]), np.array([0.0, 1.0])
    else:
        a1, a2 = np.array([math.sqrt(3) / 2, 0.5]), np.array([math.sqrt(3) / 2, -0.5])
    area = abs(a1[0] * a2[1] - a1[1] * a2[0])
    rot = np.array([[0, -1], [1, 0]])
    b1 = 2 * math.pi * (rot @ a2) / (a1 @ (rot @ a2))
    b2 = 2 * math.pi * (rot @ a1) / (a2 @ (rot @ a1))
    if lattice == "square":
        corners = [np.zeros(2), 0.5 * b1, 0.5 * b1 + 0.5 * b2, np.zeros(2)]
    else:
        corners = [np.zeros(2), 0.5 * b2, -b1 / 3 + b2 / 3, np.zeros(2)]
    kp = path(corners)
    rows = []
    for nm in nmaxes:
        bb, npw = bands(b1, b2, kp, 0.2, 12.0, area, nm)
        rows.append({"nmax": nm, "n_plane_waves": npw, "lo": float(bb[:, 0].max()), "hi": float(bb[:, 1].min())})
    lo, hi = rows[-1]["lo"], rows[-1]["hi"]
    mpb = mpb_levels(lattice)
    tg = []
    for key, edge, ref_txt in (("lo", "lower", refs[0]), ("hi", "upper", refs[1])):
        pw = [r[key] for r in rows]
        steps = [abs(b - a) for a, b in zip(pw[:-1], pw[1:], strict=True)]
        ratio = steps[-1] / steps[-2]
        pwe_tail = steps[-1] * ratio / (1 - ratio) if ratio < 1 else float("nan")  # geometric-tail estimate
        pwe_lim = pw[-1] + math.copysign(pwe_tail, pw[-1] - pw[-2])
        if not mpb:
            raise SystemExit("MPB runs missing: run validation/c/mpb/mpb_gaps.py first (see its README)")
        res = sorted(mpb)
        f = [mpb[r][key] for r in res]
        d1, d2 = f[-2] - f[-3], f[-1] - f[-2]
        p_obs = math.log(abs(d1 / d2)) / math.log(2)
        f_ext = f[-1] + d2 / (2**p_obs - 1)
        u_mpb = 1.25 * abs(d2) / (2**p_obs - 1)  # GCI, safety 1.25
        diff = abs(f_ext - pwe_lim)
        tg.append(target(
            f"gap_{edge}", f_ext, "1 (c/a)",
            {"method": "MPB (meep 1.34.0 conda env, read-only), tutorial set-up, resolutions " + ", ".join(map(str, res))
                       + "; Richardson on the three finest with observed order",
             "mpb_levels": [{"resolution": r, "value": mpb[r][key]} for r in res], "observed_order": p_obs,
             "gci_U": u_mpb, "pwe_limit_est": pwe_lim, "pwe_finest": pw[-1], "pwe_tail_est": pwe_tail,
             "mpb_vs_pwe_abs": diff, "mpb_vs_pwe_rel": diff / f_ext,
             "agreement": "same limit" if diff <= max(3 * u_mpb, 3 * pwe_tail, 1e-5 * f_ext) else "differ"},
            source_compare(f_ext, ref_txt, 1.0, "MPB tutorial printout (resolution 32; not reproducible with MPB 1.34.0)"),
        ))
        tg.append(target(f"pwe_gap_{edge}", pw[-1], "1 (c/a)",
                         {"method": "PWE TM, MPB k path", "levels": rows, "last_step_rel": steps[-1] / pw[-1]}))
        tg.append(target(f"mpb32_gap_{edge}", mpb[32][key], "1 (c/a)",
                         {"method": "MPB 1.34.0 at the tutorial resolution 32, defaults"},
                         source_compare(mpb[32][key], ref_txt, 1.0, "MPB tutorial printout")))
    write_expected(
        case,
        tg,
        GEN,
        f"TM band-gap edges, {lattice} lattice of rods r 0.2a eps 12 in air: MPB resolution study (Richardson) and an "
        "independent plane-wave expansion.",
        extra={"inputs": {"lattice": lattice, "r_over_a": 0.2, "eps_rod": 12.0, "k_path": "MPB tutorial"},
               "mpb_runs": "cache/eval-c/mpb-runs/run_<lattice>_<res>.log (validation/c/mpb/mpb_gaps.py)"},
    )
    return tg


if __name__ == "__main__":
    for c, lat, refs in [
        ("WO-04", "square", ("0.282623311147724", "0.419334798706834")),
        ("WO-61", "triangular", ("0.275065617068082", "0.446289918847647")),
    ]:
        for t in run(c, lat, refs):
            pr = t["precision"]
            print(c, t["metric_id"], f"{t['value']:.9f}", pr.get("observed_order", ""), pr.get("gci_U", ""),
                  pr.get("mpb_vs_pwe_rel", ""), pr.get("agreement", ""))
