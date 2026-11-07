# SPDX-License-Identifier: GPL-3.0-or-later
"""MPB TM band gap of the MPB Python tutorial rod lattices (lane L7c, DevLog-008 "MPB gating").

Set-up as in mpb doc/docs/Python_Tutorial.md (tag v1.12.0): rods r 0.2, eps 12, air background, num_bands 8,
k path = corners + mp.interpolate(4, ...), MPB defaults for mesh_size (subpixel averaging) and tolerance;
only `resolution` is varied. Prints one JSON line with the band-1 maximum and band-2 minimum (the first TM gap)
and the gap list MPB reports.

Interpreter: a conda env with conda-forge pymeep 1.34.0 (python 3.13), path in $MPB_PYTHON, used
read-only and outside uv; see README.md. Usage: python -I mpb_gaps.py <square|triangular> <resolution>
"""

import json
import math
import sys
import time

import meep as mp
from meep import mpb

lattice, res = sys.argv[1], int(sys.argv[2])
geometry = [mp.Cylinder(0.2, material=mp.Medium(epsilon=12))]
if lattice == "square":
    geometry_lattice = mp.Lattice(size=mp.Vector3(1, 1))
    corners = [mp.Vector3(), mp.Vector3(0.5), mp.Vector3(0.5, 0.5), mp.Vector3()]
else:
    geometry_lattice = mp.Lattice(size=mp.Vector3(1, 1), basis1=mp.Vector3(math.sqrt(3) / 2, 0.5),
                                  basis2=mp.Vector3(math.sqrt(3) / 2, -0.5))
    corners = [mp.Vector3(), mp.Vector3(y=0.5), mp.Vector3(-1 / 3, 1 / 3), mp.Vector3()]
ms = mpb.ModeSolver(num_bands=8, k_points=mp.interpolate(4, corners), geometry=geometry,
                    geometry_lattice=geometry_lattice, resolution=res)
t0 = time.time()
ms.run_tm()
f = ms.all_freqs
out = {"lattice": lattice, "resolution": res, "mesh_size": ms.mesh_size, "tolerance": ms.tolerance,
       "n_k": len(ms.k_points), "band1_max": float(f[:, 0].max()), "band2_min": float(f[:, 1].min()),
       "gap_list": [list(map(float, g)) for g in ms.gap_list], "wall_s": round(time.time() - t0, 2),
       "meep": mp.__version__}
print("JSON " + json.dumps(out))
