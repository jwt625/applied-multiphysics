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

import math

import numpy as np
from common_c import source_compare, target, write_expected
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
    floor_lo = abs(rows[-1]["lo"] - rows[-2]["lo"]) / lo
    floor_hi = abs(rows[-1]["hi"] - rows[-2]["hi"]) / hi
    tg = [
        target(
            "gap_lower",
            lo,
            "1 (c/a)",
            {"method": "PWE TM, MPB k path", "levels": rows, "last_step_rel": floor_lo},
            source_compare(lo, refs[0], 1.0, "MPB tutorial (resolution 32)"),
        ),
        target(
            "gap_upper",
            hi,
            "1 (c/a)",
            {"method": "PWE TM, MPB k path", "last_step_rel": floor_hi},
            source_compare(hi, refs[1], 1.0, "MPB tutorial (resolution 32)"),
        ),
    ]
    write_expected(
        case,
        tg,
        GEN,
        f"Plane-wave expansion, TM, {lattice} lattice of rods r 0.2a eps 12 in air; "
        "independent check of the MPB gap edges (MPB is the cited reference).",
        extra={"inputs": {"lattice": lattice, "r_over_a": 0.2, "eps_rod": 12.0, "k_path": "MPB tutorial"}},
    )
    return tg


if __name__ == "__main__":
    for c, lat, refs in [
        ("WO-04", "square", ("0.282623311147724", "0.419334798706834")),
        ("WO-61", "triangular", ("0.275065617068082", "0.446289918847647")),
    ]:
        for t in run(c, lat, refs):
            print(
                c,
                t["metric_id"],
                round(t["value"], 6),
                "vs MPB rel",
                f"{t['source']['rel_diff']:.2e}",
                "PWE last step",
                f"{t['precision']['last_step_rel']:.1e}",
            )
