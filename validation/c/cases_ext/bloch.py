# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-c cases of the Bloch / Floquet examples (DevLog-050): emw-2d band structures and Floquet cells checked against
MPB, a plane-wave expansion and the Airy film formula (values in eval/expected/WO-90..WO-93.json, written by
validation/bloch/gen_expected.py).

Gate rule: every gated quantity is checked on two nested mesh levels (h_factors [1, 0.5]) as two targets (coarse level
0, fine level 1). Loaded by validation/c/build_cases.py (cases_ext); ids WO-90..WO-94 (WO-94 not used yet).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
EXP = ROOT / "eval" / "expected"
CREATED = "2026-11-18"
GEN = "validation/bloch/gen_expected.py"
CONV2 = {
    "levels_min": 2,
    "ratio_min": 2.0,
    "method": "none",
    "h_factors": [1, 0.5],
    "note": "two nested levels (one uniform refinement); each quantity is gated on both levels",
}
C0 = {"value": 299792458, "unit": "m/s", "source": "SI defining constant (speed of light in vacuum)"}
A_UM = {"value": 1, "unit": "um", "source": "sims/phc-square-rods-bands.yaml params.a (lattice constant, scale choice)"}
MPB_RIGHTS = {"source_license": "GPL-2.0-or-later (MPB / Meep; License_and_Copyright.md)", "allowed": ["cite_values", "re_derive_setup", "copy_with_attribution"], "forbidden": []}
OWN_RIGHTS = {"source_license": "own reference scripts (GPL-3.0-or-later); cited textbook formulas", "allowed": ["cite_values", "re_derive_setup", "copy_with_attribution"], "forbidden": []}
MPB_SOURCE = {"suite": "MPB tutorial", "file": "doc/docs/Python_Tutorial.md", "url": "github.com/NanoComp/mpb tag v1.12.0", "accessed": "2026-11-06",
              "note": "same lattice as WO-04 (cache/eval-c/sources/mpb/Python_Tutorial.md)"}


def _exp(case: str) -> dict[str, Any]:
    return json.loads((EXP / f"{case}.json").read_text())


def _val(case: str, mid: str) -> float:
    for t in _exp(case)["targets"]:
        if t["metric_id"] == mid:
            return t["value"]
    raise KeyError(f"{case}:{mid}")


def two_level(case: str, mid: str, quantity: str, unit: str, tols: tuple[float, float], citation: str, locator: str, extract: dict[str, Any],
              *, kind: str = "rel", gate: bool = True, form: str = "solver_ref", note: str | None = None) -> list[dict[str, Any]]:
    out = []
    for lvl, tol in ((0, tols[0]), (1, tols[1])):
        r: dict[str, Any] = {
            "id": f"{mid}.L{lvl}", "quantity": f"{quantity} (mesh level {lvl})", "metric_id": mid, "value": _val(case, mid), "unit": unit,
            "tolerance": {kind: tol, "after": "finest"}, "bounds": None, "basis": "D", "form": form, "gate": gate, "levels": [lvl],
            "expected": {"file": f"eval/expected/{case}.json", "metric_id": mid},
            "provenance": {"citation": citation, "locator": locator, "accessed": None, "generator": GEN},
            "extract": extract,
        }
        if note:
            r["note"] = note
        out.append(r)
    return out


def freq_ca(name: str) -> dict[str, Any]:
    """Normalized frequency f a / c0 from a Hz scalar of the band sim."""
    return {"kind": "expr", "expr": "f * a / c", "terms": {"f": {"kind": "scalar", "name": name}, "a": A_UM, "c": C0}}


def mk_case(cid: str, title: str, physics: list[str], refs: list[dict[str, Any]], spec: str, *, geometry: dict, materials: dict, study: dict,
            rights: dict, budget: float, budget_basis: str, notes: list[str], source_case: dict | None = None, hero: dict | None = None) -> dict[str, Any]:
    d: dict[str, Any] = {
        "schema": "amp-eval/0", "id": cid, "class": "c", "title": title, "status": "unvalidated", "untestable_reason": None,
        "physics": physics, "dimension": "2D-periodic", "units": "SI", "geometry": geometry, "materials": materials, "bcs": None,
        "initial": None, "study": study, "references": refs, "reference_results": [], "convergence": CONV2,
        "speed": {"budget_s": {"browser": None, "native": budget}, "budget_basis": budget_basis, "report": ["dofs", "wall_s_by_stage", "error_vs_ref"], "reference_timings": []},
        "dataset": None, "rights": dict(rights), "hero": hero or {"suitable": False, "why": "verification of a library example"},
        "spec": spec, "missing": [], "assumptions": [], "notes": notes,
    }
    if source_case:
        d["source_case"] = source_case
    d["lane"] = "E4"
    d["created"] = CREATED
    return d


ROD_GEOM = {"kind": "analytic", "spec": {"lattice": "square", "a": 1, "rod_radius": 0.2, "unit": "a"}}
ROD_MATS = {"rod": {"eps_r": 12.0, "source": "mpb doc/docs/Python_Tutorial.md L69"}, "background": {"eps_r": 1.0, "source": "default air"}}
ROD_STUDY = {"type": "eigen", "n": 8, "shift": "bands study (Bloch eigenproblem); k on Gamma-X-M-Gamma, 4 interpolated points per segment (MPB tutorial path)"}
BUDGET_BANDS = (40.0, "measured 2026-11-18 by the harness (Node, M4 Pro, nice 10): 9.2 s at level 0 (3,048 DOF), 34 s at level 1 (12,192 DOF), 16 k points")

wo90 = mk_case(
    "WO-90", "Square rod lattice (r 0.2a, eps 12), TM band structure: first gap edges (Bloch eigenproblem)", ["optics-phc"],
    two_level("WO-90", "gap_lower", "gap lower edge (band 1 maximum, at M)", "1 (c/a)", (1e-4, 1e-4),
              "MPB (meep 1.34.0) resolutions 16-256, Richardson (copied from WO-04)", "eval/expected/WO-04.json; validation/c/mpb/mpb_gaps.py", freq_ca("fmax_0"))
    + two_level("WO-90", "gap_upper", "gap upper edge (band 2 minimum, at X)", "1 (c/a)", (1e-4, 1e-4),
                "MPB (meep 1.34.0) resolutions 16-256, Richardson (copied from WO-04)", "eval/expected/WO-04.json; validation/c/mpb/mpb_gaps.py", freq_ca("fmin_1"))
    + two_level("WO-90", "pwe_limit_lower", "PWE limit estimate, gap lower edge", "1 (c/a)", (1e-4, 1e-4),
                "plane-wave expansion limit estimate (WO-04)", "eval/expected/WO-04.json gap_lower precision.pwe_limit_est", freq_ca("fmax_0"), gate=False)
    + two_level("WO-90", "pwe_limit_upper", "PWE limit estimate, gap upper edge", "1 (c/a)", (1e-4, 1e-4),
                "plane-wave expansion limit estimate (WO-04)", "eval/expected/WO-04.json gap_upper precision.pwe_limit_est", freq_ca("fmin_1"), gate=False),
    "sims/phc-square-rods-bands.yaml", geometry=ROD_GEOM, materials=ROD_MATS, study=ROD_STUDY, rights=MPB_RIGHTS,
    budget=BUDGET_BANDS[0], budget_basis=BUDGET_BANDS[1], source_case=MPB_SOURCE,
    hero={"suitable": True, "why": "photonic band diagram", "visual": ["band_diagram", "Ez_mode"]},
    notes=["Same physical problem as WO-04 (whose sims use a scalar acoustics analog on quarter cells); here the emw-2d Bloch eigenproblem on the full unit cell. The MPB Richardson value and the PWE limit differ by 7.7e-6 rel; the FE values lie between them."],
)

wo91 = mk_case(
    "WO-91", "Square rod lattice (r 0.2a, eps 12), TM bands 3 and 8 at X and M vs plane-wave expansion", ["optics-phc"],
    [r for b, lab, k in ((3, "X", 5), (8, "X", 5), (3, "M", 10), (8, "M", 10))
     for r in two_level("WO-91", f"band{b}_{lab}", f"TM band {b} at {lab}", "1 (c/a)", (2e-4, 1e-4), "plane-wave expansion, nmax 24 (this lane)",
                        "validation/bloch/bloch_refs.py; validation/c/gen_pwe.py bands", freq_ca(f"f_{b - 1}_{k}"), kind="abs",
                        note="absolute tolerance in c/a; PWE floor (nmax 20 vs 24) 2.8e-5 c/a over all bands and k points")],
    "sims/phc-square-rods-bands.yaml", geometry=ROD_GEOM, materials=ROD_MATS, study=ROD_STUDY, rights=MPB_RIGHTS,
    budget=BUDGET_BANDS[0], budget_basis=BUDGET_BANDS[1], source_case=MPB_SOURCE,
    notes=["k index 5 = X, 10 = M on the 16-point path (corners plus 4 interpolated points per segment)."],
)

ABOVE = {"value": [0.25, 0.5], "unit": "um"}
BELOW = {"value": [0.25, -0.8], "unit": "um"}
wo92 = mk_case(
    "WO-92", "Film (eps 4, 0.3 lambda0) at 30 deg, TM: reflection and transmission through a Floquet cell", ["optics-scattering"],
    two_level("WO-92", "r_abs", "|r| (|E_z| of the reflected wave per unit incident amplitude)", "1", (5e-4, 1e-4),
              "Airy film formula (Born and Wolf, Principles of Optics, 7th ed., sec. 1.6.4)", "validation/bloch/bloch_refs.py",
              {"kind": "expr", "expr": "u / u0", "terms": {"u": {"kind": "probe", "field": "Ez_sc_abs", "point": [0.25e-6, 0.5e-6]}, "u0": {"value": 1, "unit": "V/m", "source": "sims/floquet-slab-oblique.yaml plane-wave amplitude"}}},
              form="closed_form")
    + two_level("WO-92", "tau_abs", "|tau| (|E_z| of the transmitted wave per unit incident amplitude)", "1", (5e-4, 1e-4),
                "Airy film formula (Born and Wolf, Principles of Optics, 7th ed., sec. 1.6.4)", "validation/bloch/bloch_refs.py",
                {"kind": "expr", "expr": "u / u0", "terms": {"u": {"kind": "probe", "field": "Ez_abs", "point": [0.25e-6, -0.8e-6]}, "u0": {"value": 1, "unit": "V/m", "source": "sims/floquet-slab-oblique.yaml plane-wave amplitude"}}},
                form="closed_form"),
    "sims/floquet-slab-oblique.yaml",
    geometry={"kind": "analytic", "spec": {"film_thickness": 0.3, "unit": "lambda0", "probe_above": ABOVE, "probe_below": BELOW}},
    materials={"film": {"eps_r": 4.0, "source": "test input"}, "background": {"eps_r": 1.0, "source": "vacuum"}},
    study={"type": "frequency", "shift": "lambda0 = 1 um, TM, incidence 30 deg"}, rights=OWN_RIGHTS,
    budget=5.0, budget_basis="measured 2026-11-18: 0.3 s at level 0 (11,467 DOF), 0.9 s at level 1 (45,053 DOF)",
    notes=["Above the film the scattered field is the reflected plane wave, so its modulus is |r| everywhere; below, the total field is the transmitted wave."],
)

wo93 = mk_case(
    "WO-93", "Triangular rod lattice (r 0.2a, eps 12), TM band structure: first gap edges (Bloch eigenproblem, rhombic cell)", ["optics-phc"],
    two_level("WO-93", "gap_lower", "gap lower edge (band 1 maximum)", "1 (c/a)", (1e-4, 1e-4),
              "MPB (meep 1.34.0) resolutions 16-256, Richardson (copied from WO-61)", "eval/expected/WO-61.json; validation/c/mpb/mpb_gaps.py", freq_ca("fmax_0"))
    + two_level("WO-93", "gap_upper", "gap upper edge (band 2 minimum)", "1 (c/a)", (1e-4, 1e-4),
                "MPB (meep 1.34.0) resolutions 16-256, Richardson (copied from WO-61)", "eval/expected/WO-61.json; validation/c/mpb/mpb_gaps.py", freq_ca("fmin_1")),
    "sims/phc-triangular-rods-bands.yaml", geometry={"kind": "analytic", "spec": {"lattice": "triangular", "a": 1, "rod_radius": 0.2, "unit": "a"}}, materials=ROD_MATS,
    study={"type": "eigen", "n": 8, "shift": "bands study (Bloch eigenproblem); k on Gamma-M-K-Gamma, 4 interpolated points per segment (MPB tutorial path)"}, rights=MPB_RIGHTS,
    budget=60.0, budget_basis="measured 2026-11-18 by the harness (Node, M4 Pro, nice 10): 16 s at level 0 (4,240 DOF), 48 s at level 1 (16,960 DOF), 16 k points", source_case=MPB_SOURCE,
    notes=["Same physical problem as WO-61 (whose spec is pending); M and K written on this cell's reciprocal basis (lattice a1 = (a, 0), a2 = (a/2, sqrt(3) a/2))."],
)

CASES = [wo90, wo91, wo92, wo93]
