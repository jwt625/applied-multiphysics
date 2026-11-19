# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-c cases of the photonics examples, part 2 (DevLog-062, lane G5): push-pull thin-film LN modulator VpiL,
1D slot waveguide, 2D grating coupler, SiN strip. Reference values in eval/expected/<ID>.json, written by the scripts in
validation/photonics2/.

Gate rule (as DevLog-047 / 048): every gated quantity is checked on two nested mesh levels (h_factors [1, 0.5]) as two
targets, the finer level with an equal or tighter tolerance. Tolerance bases are stated per target and in DevLog-062.
Loaded by validation/c/build_cases.py (cases_ext); ids WO-74..WO-79, WO-86..WO-89.
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


def _exp(case: str) -> dict[str, Any]:
    return json.loads((EXP / f"{case}.json").read_text())


def _t(case: str, mid: str) -> dict[str, Any]:
    for t in _exp(case)["targets"]:
        if t["metric_id"] == mid:
            return t
    raise KeyError(f"{case}:{mid}")


def two_level(case: str, mid: str, quantity: str, unit: str, tol0: float, tol1: float, citation: str, locator: str, *,
              kind: str = "rel", basis: str = "P", form: str = "solver_ref", gate: bool = True, scalar: str | None = None,
              extract: dict | None = None, spec: Any = None, note: str | None = None, rid: str | None = None,
              tol_note: str | None = None) -> list[dict[str, Any]]:
    out = []
    for lvl, tol in ((0, tol0), (1, tol1)):
        tolerance: dict[str, Any] = {kind: tol, "after": "finest"}
        if tol_note:
            tolerance["note"] = tol_note
        r: dict[str, Any] = {
            "id": f"{rid or mid}.L{lvl}",
            "quantity": f"{quantity} (mesh level {lvl})",
            "metric_id": mid,
            "value": _t(case, mid)["value"],
            "unit": unit,
            "tolerance": tolerance,
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


def mk_case(cid: str, title: str, refs: list[dict[str, Any]], spec: Any, rights: dict, *, physics: list[str], geometry: dict,
            materials: dict, study: dict, bcs: list | None = None, notes: list | None = None, assumptions: list | None = None,
            reference_results: list | None = None, budget_basis: str = "not set", missing: list | None = None,
            budget_native: float | None = None) -> dict[str, Any]:
    d: dict[str, Any] = {
        "schema": "amp-eval/0", "id": cid, "class": "c", "title": title, "status": "unvalidated", "untestable_reason": None,
        "physics": physics, "dimension": "2D", "units": "SI", "geometry": geometry, "materials": materials,
        "bcs": bcs, "initial": None, "study": study, "references": refs, "reference_results": reference_results or [],
        "convergence": CONV2,
        "speed": {"budget_s": {"browser": None, "native": budget_native}, "budget_basis": budget_basis,
                  "report": ["dofs", "wall_s_by_stage", "error_vs_ref"], "reference_timings": []},
        "dataset": None, "rights": dict(rights), "hero": NO_HERO, "spec": spec, "missing": missing or [], "assumptions": assumptions or [],
    }
    if notes:
        d["notes"] = notes
    d["lane"] = "G5"
    d["created"] = CREATED
    return d


# ---------------------------------------------------------------------------------------------------------------------
K4_CIT = ("eo-modulator-atlas canonical push-pull thin-film LN modulator reference (scikit-fem P2 electrostatics on 3 mesh "
          "scales, vector FEM N2/P2 arm modes, first-order Pockels with the full tensor; extrapolated with a GCI band)")
K4_LOC = ("eo-modulator-atlas validation/reference/K4-es-eo.json key extrapolated (2026-10-15; sha256 in eval/expected/WO-86.json "
          "inputs); case validation/cases/K4.yaml")


def wo86() -> dict[str, Any]:
    meas = "set from the measured level errors with a margin of about 2 (DevLog-062 s.4); wider than the reference band U"
    refs = (two_level("WO-86", "VpiL_0", "push-pull VpiL (full terminal voltage)", "V*m", 3e-3, 1.5e-3, K4_CIT, K4_LOC, tol_note=meas)
            + two_level("WO-86", "dneffdV_0", "first-order dn_eff/dV of the right arm", "1/V", 3e-3, 1.5e-3, K4_CIT, K4_LOC, tol_note=meas)
            + two_level("WO-86", "neff_0", "n_eff TE0 of the right arm", "1", 1e-6, 1e-6, K4_CIT,
                        "eo-modulator-atlas validation/reference/K2-fem.json extrapolated (the arm window equals the air-clad rib case)", kind="abs",
                        tol_note="as the air-clad rib case (its level errors 2.8e-7 / 5.0e-7)"))
    return mk_case("WO-86", "Push-pull thin-film LN modulator: two x-cut ribs in the gaps of a gold GSG line (gap 5 um), VpiL at 1550 nm vs an independent FEM chain",
                   refs, {"sim": "sims/tfln-mzm-pushpull.yaml", "study": "std1"}, ATLAS, physics=["electrostatics", "optics-modes", "coupled-electro-optic"],
                   geometry={"kind": "analytic", "spec": {"domain_um": [[-500, 500], [-504.7, 500]], "ribs_um": "centred at x = +-12.5, film 0.6, etch 0.3, top 1.0, 60 deg walls",
                                                           "electrodes_um": {"signal": [[-10, 10], [0.3, 1.1]], "grounds": [[15, 115], [-115, -15]]}, "box_um": 4.7, "substrate_um": 500,
                                                           "optical_window_um": [[7.5, 17.5], [-3, 3]]}},
                   materials={"ln": {"n_o": 2.211111009, "n_e": 2.13755965, "eps_r": {"perp": 44, "par": 28}, "r_pm_per_V": {"r13": 9.6, "r22": 6.8, "r33": 30.9, "r51": 32.6},
                                     "source": "atlas validation/cases/K4.yaml (case inputs; n from Zelmon 1997 at 1550 nm)"},
                              "sio2": {"n": 1.444023622, "eps_r": 3.9, "source": "atlas K4.yaml"}, "si": {"eps_r": 11.7, "source": "atlas K4.yaml"},
                              "air": {"n": 1, "eps_r": 1, "source": "atlas K4.yaml"}, "gold": {"conductor": True, "source": "atlas K4.yaml (perfect conductor)"}},
                   study={"type": "eigen", "solver": "mode", "wavelength_m": 1.55e-6, "n": 2, "chain": "electrostatics (1 V terminal) -> first-order Pockels in the mode solver"},
                   bcs=[{"selection": "outer boundaries", "type": "zero charge"}, {"selection": "signal", "type": "terminal 1 V"}, {"selection": "grounds", "type": "ground"},
                        {"selection": "optical window", "type": "pec"}],
                   assumptions=["Arm B is the mirror image of arm A about the signal centre (both the case and the engine)",
                                "Electrodes are absent from the optical problem (replaced by air), as in the reference"],
                   budget_native=240, budget_basis="measured: both levels about 200 s in Node on 2026-11-18 (level 0 161k DOF 22 s 0.59 GB; level 1 646k DOF 179 s 1.46 GB RSS); the budget also sets the harness wall-clock limit")


# ---------------------------------------------------------------------------------------------------------------------
TAIL = "D. Taillaert et al., Grating couplers for coupling between optical fibers and nanophotonic waveguides, Jpn. J. Appl. Phys. 45(8A), 6071-6077 (2006), doi 10.1143/JJAP.45.6071"
GC_SIM = "sims/si-grating-coupler-2d.yaml"


def wo74() -> dict[str, Any]:
    flux = lambda node: {"kind": "result", "node": node}  # noqa: E731
    pin = {"kind": "scalar", "name": "P_in"}
    bal = {"kind": "expr", "expr": "(u + d + xo - xi) / p", "terms": {"u": flux("P_up"), "d": flux("P_down"), "xo": flux("P_x_out"), "xi": flux("P_x_in"), "p": pin}}
    refs = (two_level("WO-74", "neff_1_0", "effective index of the input-waveguide mode (port 1)", "1", 3e-5, 3e-6,
                      "exact TE slab dispersion of the port cross-section (transfer matrix, mpmath vs scipy)",
                      "validation/photonics2/gc_reference.py; the paper quotes 2.83 (p.6072)", kind="abs", basis="D", form="closed_form",
                      spec={"sim": GC_SIM, "study": "s"},
                      tol_note="set from the measured level errors (-1.1e-5, -7.4e-7) with a margin of about 3 (DevLog-062 s.4)")
            + two_level("WO-74", "balance", "net Poynting power out of the closed rectangle (two horizontal flux lines, two vertical lines near the ports) / incident power", "1",
                        5e-3, 1.5e-3, "Poynting theorem (lossless interior): exactly 0", "sim results P_up, P_down, P_x_out, P_x_in", kind="abs", basis="D",
                        form="closed_form", extract=bal, spec={"sim": GC_SIM, "study": "s"},
                        tol_note="set from the measured level values (2.5e-3, -5.6e-4 at 1550 nm) with a margin of 2-3: the line integrals use recovered gradients of E_z"))
    fig = {t["metric_id"]: t for t in _exp("WO-74")["targets"] if t["metric_id"].startswith("up_")}
    for mid, t in fig.items():
        lam_um = round(t["lambda_read_nm"] / 1000.0, 6)
        refs += two_level("WO-74", mid, f"upward power / incident power at {t['lambda_read_nm']:.1f} nm", "1", 0.03, 0.03, TAIL,
                          "Fig. 3 p.6072, dashed curve 'power up' (digitized, validation/photonics2/taillaert2006_fig3.json)", kind="abs",
                          basis="P", form="paper_sim", gate=False,
                          extract={"kind": "expr", "expr": "u / p", "terms": {"u": flux("P_up"), "p": pin}},
                          spec={"sim": GC_SIM, "params": {"lambda0": lam_um}, "study": "s"},
                          note=("informative: the paper does not state the number of periods; this model (30 periods) gives 0.451 / 0.465 / 0.469 / "
                                "0.471 / 0.472 at 1550 nm for 15 / 20 / 25 / 30 / 40 periods and 0.458 / 0.475 / 0.484 / 0.487 / 0.489 at 1600 nm "
                                "(level 0), a spread as large as the differences; reading resolution about 0.0015"))
    return mk_case("WO-74", "Uniform SOI grating coupler in 2D (Taillaert 2006 structure): port mode index and power balance gated; upward power vs Taillaert Fig. 3 at 1500-1650 nm informative",
                   refs, {"sim": GC_SIM, "study": "s"}, OWN, physics=["optics-scattering", "rf-sparams"],
                   geometry={"kind": "analytic", "spec": {"core_m": 2.2e-7, "etch_m": 7e-8, "period_m": 6.3e-7, "fill": 0.5, "periods": 30, "box_m": 1e-6,
                                                           "substrate": "Si, 0.5 um then PML", "air_m": 1.5e-6, "pml_m": 1e-6}},
                   materials={"si": {"n": 3.47, "source": "Taillaert 2006 Fig. 2"}, "sio2": {"n": 1.44, "source": "Taillaert 2006 Fig. 2"},
                              "air": {"n": 1, "source": "Taillaert 2006 p.6072 (n_top = 1)"}},
                   study={"type": "frequency", "wavelength_m": 1.55e-6, "polarization": "TE of the chip (E along the grooves; emw-2d TM)"},
                   bcs=[{"selection": "input and output waveguide ends", "type": "port"}, {"selection": "top and bottom layers", "type": "pml"}],
                   assumptions=["Number of periods not given by the paper: 30 (modelling choice); the upward fraction depends on it (target notes)",
                                "Substrate set back 1 um from each port (port cross-sections without the substrate)"],
                   reference_results=[{"solver": "2D eigenmode expansion with PML (Taillaert 2006 p.6072)", "quantity": "upward radiated power vs wavelength", "form": "figure"}],
                   budget_basis="not set; level 1 (443k DOF) 10 s, 0.79 GB RSS per wavelength in Node on 2026-11-18")


# ---------------------------------------------------------------------------------------------------------------------
def wo88() -> dict[str, Any]:
    refs = two_level("WO-88", "neff_0", "n_eff of the slot mode (E normal to the layers)", "1", 2e-6, 1.5e-7,
                     "exact five-layer slab dispersion relation (transfer matrix on H_x and (1/eps) dH_x/dy; mpmath vs scipy)",
                     "validation/photonics2/slot_slab.py; geometry and indices: US patent 7,519,257 B2 (2009-04-14), FIG. 1 embodiment", kind="abs",
                     basis="D", form="closed_form",
                     tol_note="set from the measured level errors (-9.6e-7, -6.2e-8; a third level -3.9e-9, order 4) with a margin of about 2 (DevLog-062 s.4)")
    return mk_case("WO-88", "Silicon slot waveguide in 1D: 220 nm Si rails around a 100 nm oxide slot at 1550 nm, slot-mode effective index vs the exact dispersion relation",
                   refs, {"sim": "sims/si-slot-slab.yaml", "study": "modes"}, OWN, physics=["optics-modes"],
                   geometry={"kind": "analytic", "spec": {"rails_m": 2.2e-7, "slot_m": 1e-7, "cladding_m": 2.5e-6, "window_x_m": 1e-7}},
                   materials={"si": {"n": 3.48, "source": "US 7,519,257 B2 (nH = 3.48 around 1.55 um)"}, "sio2": {"n": 1.44, "source": "US 7,519,257 B2 (nC = 1.44)"}},
                   study={"type": "eigen", "solver": "mode", "wavelength_m": 1.55e-6, "n": 1},
                   bcs=[{"selection": "y = +-L", "type": "pec"}, {"selection": "x walls", "type": "natural (exact for the x-invariant mode)"}],
                   notes=["The slot dimensions and indices come from the patent's 2D slot waveguide; the case uses the 1D (slab) form, for which the dispersion relation is exact.",
                          "No published slot effective index from a non-COMSOL solver was found (DevLog-062 s.1.1); the analytic slab is the reference."],
                   budget_basis="not set; level 1 (51k DOF) 0.4 s in Node on 2026-11-18")


# ---------------------------------------------------------------------------------------------------------------------
MUNOZ = ("P. Munoz et al., Silicon nitride photonic integration platforms for visible, near-infrared and mid-infrared applications, "
         "Sensors 17(9), 2088 (2017), doi 10.3390/s17092088")


def wo89() -> dict[str, Any]:
    refs = two_level("WO-89", "ng_0", "TE0 group index at 1555 nm (library dispersion) vs a measured value", "1", 0.03, 0.03, MUNOZ,
                     "s.3.4: OFDR group index 1.892 (TE), MZI 1.90-1.92 (TE); stack s.3.1", kind="abs", basis="P", form="paper_measured", gate=False,
                     note=("informative: measured on fabricated guides (strip or rib not stated; film indices and dimensions not known to the model's "
                           "precision); the model gives 1.9498 on both levels (2026-11-18)"))
    return mk_case("WO-89", "Silicon nitride strip waveguide (1.0 um x 300 nm LPCVD Si3N4 in oxide): TE0 group index at 1555 nm vs a measured value",
                   refs, {"sim": "sims/sin-strip.yaml", "study": "modes"}, OWN, physics=["optics-modes"],
                   geometry={"kind": "analytic", "spec": {"core_m": [1e-6, 3e-7], "oxide_below_m": 2.5e-6, "oxide_above_m": 2e-6, "window_x_m": 8e-6}},
                   materials={"si3n4": {"n": "library (Luke et al. 2015 film Sellmeier) at 1555 nm", "source": "materials/si3n4-lpcvd.yaml"},
                              "sio2": {"n": "library (Malitson 1965) at 1555 nm", "source": "materials/sio2-thermal-oxide.yaml"}},
                   study={"type": "eigen", "solver": "mode", "wavelength_m": 1.555e-6, "n": 2},
                   bcs=[{"selection": "window", "type": "pec"}],
                   missing=[{"what": "which waveguide (strip or rib) was measured; film indices of the measured wafer", "needed_for": ["gate"]}],
                   budget_basis="not set; level 1 (122k DOF) 2.1 s in Node on 2026-11-18")


CASES: list[dict[str, Any]] = [wo74(), wo86(), wo88(), wo89()]
