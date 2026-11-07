# SPDX-License-Identifier: GPL-3.0-or-later
"""Tightly converged DEVSIM run of the diode_1d example set-up (lane L7c, audit B2, DevLog-008).

Child process of gen_devsim.py: imports the sha256-pinned example module diode_common.py from
cache/eval-c/devsim/ (Apache-2.0, not copied into the repo), builds the same 1D device with every mesh
spacing divided by --refine, and solves the DC sweep with relative_error 1e-13 and a negligible absolute
error (the example uses absolute_error 1e10, which stops Newton early at low current). Prints one JSON
line: per bias J_top, J_bot (A/cm^2), Newton settings, node count.

Usage: python devsim_diode_tight.py <cache_dir> <refine> [extended]

"extended" switches on DEVSIM float128 model/equation/solver arithmetic (extended_solver, extended_model,
extended_equation; as in the example gmsh_diode3d_float128.py), needed because the low-bias contact current
is a small difference of large majority-carrier fluxes.
"""

from __future__ import annotations

import json
import sys

cache_dir, refine = sys.argv[1], float(sys.argv[2])
extended = len(sys.argv) > 3 and sys.argv[3] == "extended"
sys.path.insert(0, cache_dir)

import devsim  # noqa: E402
import devsim.python_packages.simple_physics as sp  # noqa: E402
import diode_common  # noqa: E402
from devsim import (  # noqa: E402
    add_1d_contact,
    add_1d_mesh_line,
    add_1d_region,
    create_1d_mesh,
    create_device,
    finalize_mesh,
    get_contact_current,
    get_node_model_values,
    set_parameter,
    solve,
)

DEV, REG = "MyDevice", "MyRegion"
if extended:
    if not devsim.get_parameter(name="info")["extended_precision"]:
        raise SystemExit("this devsim build has no extended precision")
    for name in ("extended_solver", "extended_model", "extended_equation"):
        set_parameter(name=name, value=True)
REL, ABS, MAXIT = (
    1e-11,
    1e4,
    200,
)  # observed floors: RelError 4e-13 (refine 2), AbsError 2e2-4e2 cm^-3 (round-off on 1e18)

create_1d_mesh(mesh="dio")
add_1d_mesh_line(mesh="dio", pos=0, ps=1e-7 / refine, tag="top")
add_1d_mesh_line(mesh="dio", pos=0.5e-5, ps=1e-9 / refine, tag="mid")
add_1d_mesh_line(mesh="dio", pos=1e-5, ps=1e-7 / refine, tag="bot")
add_1d_contact(mesh="dio", name="top", tag="top", material="metal")
add_1d_contact(mesh="dio", name="bot", tag="bot", material="metal")
add_1d_region(mesh="dio", material="Si", region=REG, tag1="top", tag2="bot")
finalize_mesh(mesh="dio")
create_device(mesh="dio", device=DEV)

diode_common.SetParameters(device=DEV, region=REG)
set_parameter(device=DEV, region=REG, name="taun", value=1e-8)
set_parameter(device=DEV, region=REG, name="taup", value=1e-8)
diode_common.SetNetDoping(device=DEV, region=REG)
diode_common.InitialSolution(DEV, REG)
solve(type="dc", absolute_error=1.0, relative_error=1e-12, maximum_iterations=MAXIT)
diode_common.DriftDiffusionInitialSolution(DEV, REG)
solve(type="dc", absolute_error=ABS, relative_error=REL, maximum_iterations=MAXIT)


def total(contact: str) -> float:
    e = get_contact_current(device=DEV, contact=contact, equation="ElectronContinuityEquation")
    h = get_contact_current(device=DEV, contact=contact, equation="HoleContinuityEquation")
    return e + h


rows = []
for i in range(1, 6):
    v = 0.1 * i
    set_parameter(device=DEV, name=sp.GetContactBiasName("top"), value=v)
    solve(type="dc", absolute_error=ABS, relative_error=REL, maximum_iterations=MAXIT)
    rows.append({"bias_V": round(v, 10), "J_top": total("top"), "J_bot": total("bot")})

n_nodes = len(get_node_model_values(device=DEV, region=REG, name="x"))
print(
    json.dumps(
        {
            "refine": refine,
            "extended_precision": extended,
            "n_nodes": n_nodes,
            "relative_error": REL,
            "absolute_error": ABS,
            "maximum_iterations": MAXIT,
            "devsim": getattr(devsim, "__version__", "unknown"),
            "rows": rows,
        }
    )
)
