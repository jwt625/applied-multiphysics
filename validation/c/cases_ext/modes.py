# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-c cases of the photonic mode-solver examples (DevLog-048, lane E2): em-modes library sims checked against
analytic, published or other-solver references (values in eval/expected/<ID>.json, written by
validation/modes3/references.py).

Gate rule (same as DevLog-047): every gated quantity is checked on two nested mesh levels (h_factors [1, 0.5]) as two
targets, the finer level with an equal or tighter tolerance. Tolerances are decisions recorded in DevLog-048 s.5 (the
measured errors are listed there); where the reference itself is coarse (other solver, figure reading) the tolerance
states that basis. Loaded by validation/c/build_cases.py (cases_ext); ids WO-80..WO-89.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
EXP = ROOT / "eval" / "expected"
CREATED = "2026-11-18"
OWN = {"source_license": "own reference scripts (GPL-3.0-or-later); cited published values", "allowed": ["cite_values", "re_derive_setup"],
       "forbidden": ["copy_text", "copy_figures"]}
ATLAS = {"source_license": "own work (Wentao Jiang, eo-modulator-atlas; engine GPL-3.0-or-later)",
         "allowed": ["cite_values", "re_derive_setup", "copy_with_attribution"], "forbidden": []}
CONV2 = {
    "levels_min": 2,
    "ratio_min": 2.0,
    "method": "none",
    "h_factors": [1, 0.5],
    "note": "two nested levels (one uniform refinement); each quantity is gated on both levels, the finer one with an equal or tighter tolerance",
}
NO_HERO = {"suitable": False, "why": "verification of a library example"}
BIEN = "P. Bienstman et al., Modelling leaky photonic wires: a mode solver comparison, Opt. Quantum Electron. 38, 731-759 (2006), doi 10.1007/s11082-006-9025-9"
KAK = "T. Kakihara, N. Kono, K. Saitoh, M. Koshiba, Full-vectorial finite element method in a cylindrical coordinate system for loss analysis of photonic wire bends, Opt. Express 14, 11128-11141 (2006), doi 10.1364/OE.14.011128"
TIDY = "Flexcompute Tidy3D example notebook BroadbandDirectionalCoupler (github.com/flexcompute/tidy3d-notebooks, develop branch), cell 14 printed output"
ATLAS_CIT = "eo-modulator-atlas tier-B reference (vector FEM N2/P2, femwell formulation; Richardson over 4 levels)"


def _exp(case: str) -> dict[str, Any]:
    return json.loads((EXP / f"{case}.json").read_text())


def _t(case: str, mid: str) -> dict[str, Any]:
    for t in _exp(case)["targets"]:
        if t["metric_id"] == mid:
            return t
    raise KeyError(f"{case}:{mid}")


def two_level(case: str, mid: str, quantity: str, unit: str, tol0: float, tol1: float, citation: str, locator: str, *,
              kind: str = "rel", basis: str = "P", form: str = "solver_ref", gate: bool = True, scalar: str | None = None,
              extract: dict | None = None, spec: Any = None, note: str | None = None, rid: str | None = None) -> list[dict[str, Any]]:
    out = []
    for lvl, tol in ((0, tol0), (1, tol1)):
        r: dict[str, Any] = {
            "id": f"{rid or mid}.L{lvl}",
            "quantity": f"{quantity} (mesh level {lvl})",
            "metric_id": mid,
            "value": _t(case, mid)["value"],
            "unit": unit,
            "tolerance": {kind: tol, "after": "finest"},
            "bounds": None,
            "basis": basis,
            "form": form,
            "gate": gate,
            "levels": [lvl],
            "expected": {"file": f"eval/expected/{case}.json", "metric_id": mid},
            "provenance": {"citation": citation, "locator": locator, "accessed": CREATED, "generator": _exp(case)["generator"]},
            "extract": extract or {"kind": "scalar", "name": scalar or mid},
        }
        if spec is not None:
            r["spec"] = spec
        if note:
            r["note"] = note
        out.append(r)
    return out


def mk_case(cid: str, title: str, refs: list[dict[str, Any]], spec: Any, rights: dict, *, geometry: dict, materials: dict,
            study: dict, bcs: list | None = None, notes: list | None = None, assumptions: list | None = None,
            reference_results: list | None = None, budget_basis: str = "not set") -> dict[str, Any]:
    d: dict[str, Any] = {
        "schema": "amp-eval/0", "id": cid, "class": "c", "title": title, "status": "unvalidated", "untestable_reason": None,
        "physics": ["optics-modes"], "dimension": "2D", "units": "SI", "geometry": geometry, "materials": materials,
        "bcs": bcs, "initial": None, "study": study, "references": refs, "reference_results": reference_results or [],
        "convergence": CONV2,
        "speed": {"budget_s": {"browser": None, "native": None}, "budget_basis": budget_basis,
                  "report": ["dofs", "wall_s_by_stage", "error_vs_ref"], "reference_timings": []},
        "dataset": None, "rights": dict(rights), "hero": NO_HERO, "spec": spec, "missing": [], "assumptions": assumptions or [],
    }
    if notes:
        d["notes"] = notes
    d["lane"] = "E2"
    d["created"] = CREATED
    return d


def wo80() -> dict[str, Any]:
    loc = "derivation in validation/modes3/references.py (continuity of H_x and (1/eps) dH_x/dy); textbook form S. A. Maier, Plasmonics: Fundamentals and Applications, Springer 2007, ch. 2"
    cit = "analytic planar surface plasmon polariton, mpmath 40 digits"
    refs = (two_level("WO-80", "neff_0", "Re n_eff", "1", 1e-6, 1e-7, cit, loc, basis="D", form="closed_form")
            + two_level("WO-80", "kappaEff_0", "Im n_eff (attenuation index)", "1", 2e-5, 2e-6, cit, loc, basis="D", form="closed_form")
            + two_level("WO-80", "Lprop_0", "power 1/e propagation length", "m", 2e-5, 2e-6, cit, loc, basis="D", form="closed_form"))
    return mk_case("WO-80", "Planar gold / air surface plasmon at 659.5 nm (Johnson and Christy gold): complex effective index vs analytic",
                   refs, "sims/au-air-spp.yaml", OWN,
                   geometry={"kind": "analytic", "spec": {"interface": "planar Au / air", "window_m": {"au": 5e-7, "air": 5e-6}}},
                   materials={"au": {"n": 0.14, "kappa": 3.697, "source": "materials/gold.yaml (Johnson and Christy 1972 table row 0.6595 um)"},
                              "air": {"n": 1, "source": "assumption: vacuum"}},
                   study={"type": "eigen", "solver": "mode", "wavelength_m": 6.595e-7, "n": 1},
                   bcs=[{"selection": "far walls", "type": "pec"}],
                   notes=["Library material binding: em-modes settings.loss reads the gold kappa from the library at the mode wavelength (prepareRun)."],
                   budget_basis="not set; level 1 (18.6k DOF) 0.3 s in Node on 2026-11-18")


def wo81() -> dict[str, Any]:
    loc = "structure p.732 Fig. 1; value p.751 Fig. 18 caption (aperiodic Fourier modal method, extrapolated); CAMFR p.749 agrees to 6 digits"
    refs = (two_level("WO-81", "neff_0", "Re n_eff, quasi-TE", "1", 1.5e-4, 6e-5, BIEN, loc, kind="abs",
                      note="tolerance set by the discretisation of the wire corners (measured errors in DevLog-048 s.5); the paper's methods spread 2.41233-2.4131 (Table 6)")
            + two_level("WO-81", "kappaEff_0", "Im n_eff (substrate leakage), quasi-TE", "1", 3e-3, 1e-3, BIEN, loc,
                        note="the paper's methods spread 2.45e-8 to 3.0e-8 (Table 6 p.757)"))
    return mk_case("WO-81", "Leaky silicon wire (Bienstman 2006 benchmark): 500 x 220 nm Si on 1 um SiO2 over Si, substrate leakage at 1.55 um",
                   refs, "sims/leaky-si-wire.yaml", OWN,
                   geometry={"kind": "analytic", "spec": {"core_m": [5e-7, 2.2e-7], "buffer_m": 1e-6, "half_window": "x >= 0 (PEC mirror)", "pml_m": 1e-6}},
                   materials={"si": {"n": 3.5, "source": "Bienstman 2006 p.732"}, "sio2": {"n": 1.45, "source": "Bienstman 2006 p.732"},
                              "air": {"n": 1, "source": "Bienstman 2006 p.732"}},
                   study={"type": "eigen", "solver": "mode", "wavelength_m": 1.55e-6, "n": 2, "shift": 2.42},
                   bcs=[{"selection": "x = 0", "type": "pec (mirror of the even quasi-TE mode)"}, {"selection": "outer layers", "type": "pml"}],
                   reference_results=[{"solver": "CAMFR (Bienstman 2006 p.749)", "n_eff": "2.412372 - 2.9135e-8 j"},
                                      {"solver": "Table 6 p.757 FEM entries", "n_eff_re": [2.4131, 2.41233], "im_e8": [2.97, 2.45]}],
                   budget_basis="not set; level 1 (140k DOF) 8.6 s in Node on 2026-11-18")


def atlas_case(cid: str, k: str, sim: str, clad: str) -> dict[str, Any]:
    loc = f"eo-modulator-atlas validation/reference/{k}-fem.json extrapolated (sha256 in eval/expected/{cid}.json inputs); case validation/cases/{k}.yaml"
    refs = (two_level(cid, "neff_0", "n_eff TE0", "1", 2e-6 if k == "K3" else 1e-6, 1e-6 if k == "K2" else 5e-7, ATLAS_CIT, loc, kind="abs")
            + two_level(cid, "ng_0", "group index TE0 (with material dispersion)", "1", 1e-5, 3e-6, ATLAS_CIT, loc, kind="abs",
                        note="engine dn/dlambda from the library (LN Zelmon o / e, SiO2 Malitson converted to vacuum wavelength) at the case indices; the reference used the Sellmeier fits directly")
            + two_level(cid, "teFraction_0", "TE fraction", "1", 2e-6, 2e-6, ATLAS_CIT, loc, kind="abs", gate=False,
                        note="informative: TE fraction definitions may differ between implementations"))
    return mk_case(cid, f"Thin-film LN rib ({k} of the EO atlas): x-cut, 600 nm film, 300 nm etch, 1 um top, 60 deg walls, {clad} clad, TE0 at 1550 nm",
                   refs, f"sims/{sim}.yaml", ATLAS,
                   geometry={"kind": "analytic", "spec": {"window_um": [[-5, 5], [-3, 3]], "rib_polygon_um": [[-0.673205081, 0.3], [0.673205081, 0.3], [0.5, 0.6], [-0.5, 0.6]], "slab_um": [0, 0.3]}},
                   materials={"ln": {"n_o": 2.211111009, "n_e": 2.13755965, "source": f"atlas {k}.yaml (Zelmon 1997 at 1550 nm)"},
                              "sio2": {"n": 1.444023622, "source": f"atlas {k}.yaml (Malitson 1965 at 1550 nm)"},
                              **({"air": {"n": 1.0, "source": f"atlas {k}.yaml"}} if clad == "air" else {})},
                   study={"type": "eigen", "solver": "mode", "wavelength_m": 1.55e-6, "n": 2},
                   bcs=[{"selection": "window", "type": "pec"}],
                   budget_basis="not set; level 1 (253k DOF) 2.3 s in Node on 2026-11-18")


def wo84() -> dict[str, Any]:
    loc = "notebook cell 14 output 'Effective indices: 2.459162628532339, 2.43821523251537'; L_c and dn derived"
    est = ("estimate: the reference is a finite-difference solver at grid_resolution 40 with other material models; its "
           "discretisation error in n_eff is of order 1e-3 to 1e-2 (eo-modulator-atlas K2-tidy3d.json levels 25 / 12.5 / 6.25 nm: "
           "1.9078 / 1.9010 / 1.8976 vs FEM 1.89417); a Li 1980 293 K silicon index (3.47667) moves the engine dn by 0.5 %")
    lam = {"value": 1.55, "unit": "um"}
    refs = (two_level("WO-84", "L_c", "coupling length lambda / (2 dn)", "m", 5e-2, 5e-2, TIDY, loc, basis="D", form="solver_ref", note=est,
                      extract={"kind": "expr", "expr": "lam / (2 * (a - b))", "terms": {"a": {"kind": "scalar", "name": "neff_0"}, "b": {"kind": "scalar", "name": "neff_1"}, "lam": lam}})
            + two_level("WO-84", "dn", "supermode index split n_even - n_odd", "1", 5e-2, 5e-2, TIDY, loc, basis="D", form="solver_ref", gate=False, note=est,
                        extract={"kind": "expr", "expr": "a - b", "terms": {"a": {"kind": "scalar", "name": "neff_0"}, "b": {"kind": "scalar", "name": "neff_1"}}})
            + two_level("WO-84", "neff_0", "n_eff even supermode", "1", 5e-3, 5e-3, TIDY, loc, kind="abs", gate=False, note=est)
            + two_level("WO-84", "neff_1", "n_eff odd supermode", "1", 5e-3, 5e-3, TIDY, loc, kind="abs", gate=False, note=est))
    return mk_case("WO-84", "Silicon directional coupler supermodes: two 500 x 220 nm strips, 200 nm gap, SiO2 clad, 1550 nm TE; coupling length",
                   refs, "sims/si-dc-supermodes.yaml", OWN,
                   geometry={"kind": "analytic", "spec": {"strips_m": [5e-7, 2.2e-7], "gap_m": 2e-7, "window_m": [5e-6, 4e-6]}},
                   materials={"si": {"n": 3.4787089554992723, "source": "materials/silicon.yaml salzberg_villa_tatian at 1.55 um (reference: Li 1993 293 K model)"},
                              "sio2": {"n": 1.4444232909003691, "source": "materials/sio2-thermal-oxide.yaml Malitson (reference: Horiba model)"}},
                   study={"type": "eigen", "solver": "mode", "wavelength_m": 1.55e-6, "n": 2},
                   bcs=[{"selection": "window", "type": "pec"}],
                   assumptions=["Material models differ from the reference; the tolerance is an estimate (see the target notes)"],
                   budget_basis="not set; level 1 (187k DOF) 2.1 s in Node on 2026-11-18")


def wo85() -> dict[str, Any]:
    refs: list[dict[str, Any]] = []
    gated = {"te_R1p25", "te_R1p5", "tm_R5p0", "tm_R10p0"}
    for t in _exp("WO-85")["targets"]:
        mid, R, mode = t["metric_id"], t["R_um"], t["mode"]
        key = mid.replace("loss90_", "")
        pr = t["precision"]
        tol = pr["half_extent_dB"] + 2 * pr["dB_per_px"]
        study = "modes_te" if "TE" in mode else "modes_tm"
        g = key in gated
        note = (f"tolerance = half the drawn line extent at R ({pr['half_extent_dB']:.3g} dB) + 2 px axis registration ({2 * pr['dB_per_px']:.3g} dB)"
                if g else "informative: " + ("steep curve end at the first plotted radius" if key == "te_R1p0" else "value below a few pixels of the axis" if key == "te_R2p0" else "not gated (other radii gate the trend)"))
        refs += two_level("WO-85", mid, f"radiation loss per 90 deg bend, {mode}, R = {R} um", "dB", tol, tol, KAK,
                          "Fig. 4 (a) quasi-TE, (b) quasi-TM, red CCS curve, p.11139 (digitized, validation/modes3/kakihara2006_fig4.json)",
                          kind="abs", basis="P", form="paper_sim", gate=g, scalar="bendLossDbPer90_0",
                          spec={"sim": "sims/si-wire-bend.yaml", "params": {"R": R}, "study": study}, note=note)
    return mk_case("WO-85", "Silicon wire bend loss vs radius (Kakihara 2006): 445 x 220 nm Si on SiO2, air clad, 1.55 um, quasi-TE and quasi-TM per 90 deg",
                   refs, {"status": "pending", "reason": "no single model: each target sets the bend radius and the TE or TM study of sims/si-wire-bend.yaml (target specs)"},
                   OWN,
                   geometry={"kind": "analytic", "spec": {"core_m": [4.45e-7, 2.2e-7], "window_x_m": [-7.5e-7, 2e-6], "window_y_m": [-2e-6, 1e-6], "pml_m": 1e-6}},
                   materials={"si": {"n": 3.5, "source": "Kakihara 2006 s.3"}, "sio2": {"n": 1.45, "source": "Kakihara 2006 s.3"}, "air": {"n": 1, "source": "Kakihara 2006 s.3"}},
                   study={"type": "eigen", "solver": "mode", "wavelength_m": 1.55e-6, "n": 1, "bend": "metric (cylindrical coordinates), radius to the wire centre"},
                   bcs=[{"selection": "outer layers", "type": "pml"}, {"selection": "inner edge x = -0.75 um", "type": "pec"}],
                   notes=["Reference values are read from a figure (no table in the paper); the tolerance is the reading resolution, not the solver accuracy.",
                          "Measured loss of the same structure (Vlasov and McNab, Opt. Express 12, 1622 (2004), abstract): 0.086 +- 0.005 dB per 90 deg at R = 1 um and 0.013 at R = 2 um (TE, includes transition loss; not comparable to radiation loss)."],
                   budget_basis="not set; level 1 (140k DOF) 3-5 s per radius in Node on 2026-11-18")


CASES: list[dict[str, Any]] = [wo80(), wo81(), atlas_case("WO-82", "K2", "tfln-rib-air", "air"),
                               atlas_case("WO-83", "K3", "tfln-rib-oxide", "SiO2"), wo84(), wo85()]
