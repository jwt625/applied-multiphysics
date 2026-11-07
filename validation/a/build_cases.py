# SPDX-License-Identifier: GPL-3.0-or-later
"""Writes eval/cases/a/<ID>.yaml (amp-eval/0, R3 s.2) for every class-a case.

D-basis reference values are read from eval/expected/<ID>.json (run the gen_*.py generators first), so the YAML and
the JSON cannot drift. Existing YAML files are not overwritten unless --force is given.

Run: cd validation && uv run python a/build_cases.py [--force]
"""

from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path
from typing import Any

import yaml
from common import CASES_DIR, EXPECTED_DIR

ACC = "2026-11-06"
VM = "ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM{}.html"
R3 = "DevLog/research/2026-11-06-R3-eval-set-sources.md"

TEXTBOOK_RIGHTS = {"source_license": "textbook formula (facts); no text, figures or tables copied",
                   "allowed": ["cite_values", "re_derive_setup"], "forbidden": ["copy_text", "copy_figures"]}
NAFEMS_RIGHTS = {"source_license": "NAFEMS TNSB booklet paid, site terms bar redistribution; target value cited via a "
                                   "public vendor or open-source page (all rights reserved on vendor pages)",
                 "allowed": ["cite_values", "re_derive_setup"],
                 "forbidden": ["copy_text", "copy_figures", "copy_input_files", "copy_booklet_content"]}
ANSYS_RIGHTS = {"source_license": "Ansys VM page public, (c) ANSYS, Inc., all rights reserved, no reuse grant; formula "
                                  "and cited textbook are the reference",
                "allowed": ["cite_values", "re_derive_setup"],
                "forbidden": ["copy_text", "copy_figures", "copy_input_files"]}

_EXP: dict[str, dict[str, Any]] = {}


def ev(case_id: str, metric_id: str) -> float:
    if case_id not in _EXP:
        _EXP[case_id] = json.loads((EXPECTED_DIR / f"{case_id}.json").read_text())
    for t in _EXP[case_id]["targets"]:
        if t["metric_id"] == metric_id:
            return float(t["value"])
    raise KeyError(f"{case_id}:{metric_id}")


def evt(case_id: str, metric_id: str) -> dict[str, Any]:
    ev(case_id, metric_id)
    return next(t for t in _EXP[case_id]["targets"] if t["metric_id"] == metric_id)


def ref(quantity: str, metric_id: str, definition: str, value: float, unit: str, tolerance: dict[str, Any],
        basis: str, form: str, citation: str, locator: str, *, case: str | None = None, bounds=None,
        gate: bool = True, accessed: str | None = ACC, note: str | None = None,
        extract: dict[str, Any] | None = None) -> dict[str, Any]:
    r: dict[str, Any] = {"quantity": quantity, "metric_id": metric_id, "definition": definition, "value": value,
                         "unit": unit, "tolerance": tolerance, "bounds": bounds, "basis": basis, "form": form,
                         "gate": gate,
                         "provenance": {"citation": citation, "locator": locator, "accessed": accessed}}
    if basis == "D":
        assert case is not None
        r["expected"] = {"file": f"eval/expected/{case}.json", "metric_id": metric_id}
    if note:
        r["note"] = note
    if extract:
        r["extract"] = extract
    return r


def dref(case: str, metric_id: str, quantity: str, definition: str, unit: str, tolerance: dict[str, Any],
         citation: str, gen: str, **kw: Any) -> dict[str, Any]:
    return ref(quantity, metric_id, definition, ev(case, metric_id), unit, tolerance, "D", "closed_form", citation,
               f"{gen}; eval/expected/{case}.json targets[metric_id={metric_id}]", case=case, accessed=None, **kw)


def speed(browser: float | None, basis: str) -> dict[str, Any]:
    return {"budget_s": {"browser": browser, "native": None},
            "budget_basis": basis + "; est., not measured; native budget set after the first timing run (R3 O3)",
            "report": ["dofs", "wall_s_by_stage", "iterations", "error_vs_ref"], "reference_timings": []}


CONV = {"levels_min": 3, "ratio_min": 1.5, "method": "richardson_gci", "safety_factor": 1.25}
NOHERO = {"suitable": False, "why": "verification case, not a demo"}


def spec_pending(sim_id: str) -> dict[str, Any]:
    return {"status": "pending", "ref": f"sims/{sim_id}.yaml",
            "reason": "amp-spec/0 models not yet published by lane L2; sims/ id is a proposal"}


def case(cid: str, title: str, physics: list[str], dimension: str, geometry: dict, materials: dict, bcs: list,
         study: dict, references: list, spd: dict, rights: dict, hero: dict, sim: str, *, initial=None,
         reference_results=None, convergence=CONV, missing=None, assumptions=None, extra=None) -> dict[str, Any]:
    convergence = copy.deepcopy(convergence)  # CONV is shared; preserved-field merges must not leak across cases
    d: dict[str, Any] = {
        "schema": "amp-eval/0", "id": cid, "class": "a", "title": title, "status": "unvalidated",
        "untestable_reason": None, "physics": physics, "dimension": dimension, "units": "SI",
        "geometry": geometry, "materials": materials, "bcs": bcs, "initial": initial, "study": study,
        "references": references, "reference_results": reference_results or [], "convergence": convergence,
        "speed": spd, "dataset": None, "rights": rights, "hero": hero, "spec": spec_pending(sim),
        "missing": missing or [], "assumptions": assumptions or [],
    }
    if extra:
        d.update(extra)
    return d


def build() -> list[dict[str, Any]]:
    C: list[dict[str, Any]] = []
    GH, GS, GE, GO, GM = (f"validation/a/{n}.py" for n in ["gen_heat", "gen_solid", "gen_em", "gen_optics", "gen_misc"])
    rel3 = {"rel": 1.0e-3, "after": "richardson"}

    # ------------------------------------------------------------------ heat
    C.append(case(
        "HT-01", "NAFEMS T4: 2D steady conduction, convection on two edges", ["heat-cond", "heat-conv"], "2D",
        {"kind": "analytic", "spec": {"plate_m": [0.6, 1.0], "origin": "corner of the insulated and fixed edges",
                                      "points_m": {"E": [0.6, 0.2]}}, "symmetry": "none"},
        {"plate": {"k": 52.0, "source": "NAFEMS T4 via Altair OS-V 0120 / FEATool ex_heattransfer4 (R3 s.3.1)"}},
        [{"selection": "y = 0", "type": "temperature", "value": 373.15, "note": "100 C"},
         {"selection": "x = 0", "type": "insulated"},
         {"selection": ["x = 0.6", "y = 1.0"], "type": "convection", "h": 750.0, "T_inf": 273.15, "note": "to 0 C"}],
        {"type": "stationary"},
        [dref("HT-01", "T_E", "T(E)", "temperature at E = (0.6, 0.2) m", "degC", rel3,
              "separation-of-variables series (this lane)", GH + "::ht01"),
         ref("T(E)", "T_E_nafems", "NAFEMS target (3 significant figures)", 18.3, "degC", {"abs": 0.05},
             "P", "benchmark", "NAFEMS T4 (Cameron, Casey, Simpson 1986) via Altair OS-V 0120",
             "2021.help.altair.com/2021/hwsolvers/os/topics/solvers/os/nafems_test_problem_t4_r.htm; FEATool "
             "ex_heattransfer4.m L127 (R3)", gate=False,
             note="the D value rounds to 18.3; the gate is the D value")],
        speed(1.0, "R3 s.3.1 browser est. < 1 s"), NAFEMS_RIGHTS, NOHERO, "nafems-t4",
        reference_results=[{"solver": "advanced-packaging-atlas L5 scikit-fem Q2 (read-only pointer)",
                            "value_degC": 18.25375654, "locator": "advanced-packaging-atlas validation/cases/B/"
                                                                  "nafems-T4.yaml"}],
        assumptions=["Temperatures in K for the solver; the target is reported in degC (T - 273.15)."]))

    C.append(case(
        "HT-02", "NAFEMS T3: 1D transient conduction, sinusoidal end temperature", ["heat-cond", "heat-transient"],
        "1D",
        {"kind": "analytic", "spec": {"bar_m": 0.1, "x_origin": "end held at 0 C"}, "symmetry": "none"},
        {"bar": {"k": 35.0, "cp": 440.5, "rho": 7200.0, "source": "NAFEMS T3 via Altair OS-V 0110 (R3 s.3.1)"}},
        [{"selection": "x = 0", "type": "temperature", "value": 273.15, "note": "0 C"},
         {"selection": "x = 0.1", "type": "temperature", "expr": "273.15 + 100 sin(pi t / 40)", "unit": "K"}],
        {"type": "transient", "t_end": 32.0, "dt_out": 1.0},
        [dref("HT-02", "T_x0.08_t32", "T(0.08 m, 32 s)", "x measured from the 0 C end", "degC", rel3,
              "two independent eigen series (this lane)", GH + "::ht02"),
         ref("T(0.08 m, 32 s)", "T_C_nafems", "NAFEMS target", 36.60, "degC", {"abs": 0.005}, "P", "benchmark",
             "NAFEMS T3 via Altair OS-V 0110",
             "2021.help.altair.com/2021/hwsolvers/os/topics/solvers/os/nafems_test_problem_t3_r.htm (R3)",
             gate=False)],
        speed(1.0, "R3 s.3.1 browser est. < 1 s"), NAFEMS_RIGHTS, NOHERO, "nafems-t3",
        initial={"T": 273.15, "note": "0 C everywhere"},
        convergence={**CONV, "dt_with_h": True, "time_order": 2,
                     "note": "dt scales with h (dt_factor = h_factor^(space_order/time_order)); sims/nafems-t3.yaml "
                             "steps with BDF2, so time_order 2"},
        assumptions=["Locator resolved (R3 s.8 flag): target point is 0.08 m from the 0 C end at t = 32 s; FEATool's "
                     "x = 0.02 m is the same point from the heated end, and its t = 36 s gives 36.681 C "
                     "(eval/expected/HT-02.json T_x0.08_t36)."]))

    C.append(case(
        "HT-03", "NAFEMS T2: 1D conduction with end radiation", ["heat-cond", "heat-rad"], "1D",
        {"kind": "analytic", "spec": {"rod_m": 0.1, "ends": {"A": 0.0, "B": 0.1}}, "symmetry": "none"},
        {"rod": {"k": 55.6, "emissivity_B": 0.98, "source": "R3 s.3.1 (NAFEMS T2 via Abaqus/CalculiX forum)"}},
        [{"selection": "A", "type": "temperature", "value": 1000.0},
         {"selection": "B", "type": "radiation", "emissivity": 0.98, "T_amb": 300.0,
          "sigma": "CODATA (scipy.constants.Stefan_Boltzmann)"},
         {"selection": "lateral surface", "type": "insulated"}],
        {"type": "stationary"},
        [dref("HT-03", "T_B.k55.6.sigma_codata", "T_B", "temperature at end B", "K",
              {"rel": 1.0e-6}, "brentq root of the 1D balance (this lane)", GH + "::ht03"),
         ref("T_B", "T_B_nafems", "NAFEMS target", 927.0, "K", {"abs": 0.5}, "P", "benchmark",
             "NAFEMS T2 via CalculiX forum (C3D20 927.004 K) (R3 s.3.1)",
             "calculix.discourse.group/t/t2-and-t3-one-dimensional-with-radiation-and-heat-transfer-b32-discrepancy"
             "/2534", gate=False)],
        speed(1.0, "R3 s.3.1 browser est. < 1 s"), NAFEMS_RIGHTS, NOHERO, "nafems-t2",
        convergence={**CONV, "note": "1D linear conduction is exact for P1 with the nonlinear BC: one mesh suffices"},
        missing=["NAFEMS booklet's sigma value and k digits (55.6 vs FEATool 55.563): sensitivity in "
                 "eval/expected/HT-03.json (sigma 5.67e-8 shifts T_B by +0.0037 K; k 55.563 by -0.037 K)"],
        assumptions=["Nonlinear radiation BC solved to |residual| < 1e-9 W/m^2."]))

    C.append(case(
        "HT-04", "Semi-infinite solid with sudden surface convection (Carslaw-Jaeger)",
        ["heat-cond", "heat-conv", "heat-transient"], "1D",
        {"kind": "analytic", "spec": {"domain_m": [0.0, 2.0], "note": "truncate at 2.0 m (>> 4 sqrt(a t) = 0.44 m)"},
         "symmetry": "none"},
        {"steel": {"k": 54.0, "rho": 7833.0, "c": 465.0,
                   "source": "Ansys VM28 (cites Holman 4th ed. p. 106), " + VM.format(28)}},
        [{"selection": "x = 0", "type": "convection", "h": 50.0, "T_inf": 1273.15, "note": "1000 C"},
         {"selection": "x = 2.0", "type": "insulated", "note": "far field; temperature rise < 1e-12 K at t = 2000 s"}],
        {"type": "transient", "t_end": 2000.0, "dt_out": 100.0},
        [dref("HT-04", f"T_x{x}_t2000", f"T({x} m, 2000 s)", "depth below the surface", "degC", rel3,
              "Carslaw-Jaeger closed form (Holman eq. 4-15 form)", GH + "::ht04")
         for x in [0.0223, 0.0859, 0.1866, 0.3462]],
        speed(1.0, "R3 s.3.1 browser est. < 1 s"), ANSYS_RIGHTS, NOHERO, "semi-infinite-convection",
        convergence={**CONV, "dt_with_h": True, "time_order": 2,
                     "note": "dt scales with h so the BDF2 time error (sims/semi-infinite-convection.yaml) does not "
                             "floor the space convergence (M2 audit)"},
        initial={"T": 273.15, "note": "0 C"},
        reference_results=[{"solver": "Ansys VM28 target (Holman)", "values_degC": [140.0, 98.9, 51.8, 14.5],
                            "locator": VM.format(28),
                            "note": "first point 0.3 % below the closed form (R3 s.8)"}],
        assumptions=["Truncation depth 2.0 m chosen by this lane (synthetic); its effect is below the tolerance."]))

    # ------------------------------------------------------------------ solid
    sm = {"a": 5.0e-3, "L": 50.0e-3, "s_inf": 100.0e6}
    C.append(case(
        "SM-01", "Kirsch: circular hole in a plate under uniaxial tension (plane stress)", ["solid-linear"], "2D",
        {"kind": "analytic", "spec": {"quarter_domain_m": [[0, sm["L"]], [0, sm["L"]]], "hole_radius_m": sm["a"],
                                      "hole_centre_m": [0, 0]}, "symmetry": "quarter (x = 0, y = 0)"},
        {"plate": {"E": 200.0e9, "nu": 0.3, "source": "synthetic (stresses independent of E, nu)"}},
        [{"selection": "x = 0", "type": "symmetry", "fixed": ["ux"]},
         {"selection": "y = 0", "type": "symmetry", "fixed": ["uy"]},
         {"selection": "hole", "type": "free"},
         {"selection": ["x = L", "y = L"], "type": "traction", "expr": "sigma_Kirsch(x, y) . n",
          "params": {"s_inf": sm["s_inf"], "a": sm["a"]},
          "note": "exact Kirsch traction from validation/a/fields.py SM-01, so the finite domain carries the "
                  "infinite-plate field exactly"}],
        {"type": "stationary", "settings": {"plane": "stress"}},
        [dref("SM-01", "K_t", "K_t", "sigma_xx(0, a) / sigma_inf", "1", rel3, "Kirsch 1898", GS + "::sm01"),
         dref("SM-01", "syy_hole_side", "sigma_yy(a, 0)", "hoop stress at the hole on the load axis", "Pa", rel3,
              "Kirsch 1898", GS + "::sm01"),
         dref("SM-01", "ux_at_L_0", "u_x(L, 0)", "displacement", "m", rel3, "Kirsch / Barber sec. 8.4",
              GS + "::sm01"),
         dref("SM-01", "uy_at_0_L", "u_y(0, L)", "displacement", "m", rel3, "Kirsch / Barber sec. 8.4",
              GS + "::sm01"),
         dref("SM-01", "field_rel_L2_stress", "field error", "relative L2 stress error vs the exact field", "1",
              {"abs": 1.0e-3, "norm": "rel_l2",
               "rule": {"type": "rate", "min": 1.0,
                        "note": "stress L2 error rate >= p over 3 meshes; min 1.0 is the P1 value (proposal)"}},
              "Kirsch 1898",
              "validation/a/fields.py SM-01")],
        speed(1.0, "R3 s.3.2 browser est. < 1 s"), TEXTBOOK_RIGHTS,
        {"suitable": True, "why": "R3 hero; stress concentration with a closed-form field to compare live",
         "visual": ["sigma_xx", "von_mises", "deformed_shape"]}, "kirsch-plate",
        assumptions=["Exact-traction outer BC chosen by this lane so the target is exact; the uniform-tension "
                     "variant with W/D >= 20 (R3) differs from Kirsch by the finite-width effect and is not gated."],
        extra={"field_reference": {"function": "validation/a/fields.py SM-01",
                                   "fields": ["sxx", "syy", "sxy", "ux", "uy"]}}))

    C.append(case(
        "SM-02", "NAFEMS LE1: elliptic membrane, plane stress", ["solid-linear"], "2D",
        {"kind": "analytic", "spec": {"inner_ellipse_m": {"semi_x": 2.0, "semi_y": 1.0},
                                      "outer_ellipse_m": {"semi_x": 3.25, "semi_y": 2.75},
                                      "points_m": {"A": [0, 1.0], "B": [0, 2.75], "C": [3.25, 0], "D": [2.0, 0]}},
         "symmetry": "quarter (x = 0, y = 0)",
         "source": "FeenoX examples/nafems-le1.geo via advanced-packaging-atlas validation/cases/B/nafems-LE1.yaml"},
        {"steel": {"E": 210.0e9, "nu": 0.3, "source": "NAFEMS LE1 via FeenoX mechanical examples (E = 210e3 MPa)"}},
        [{"selection": "x = 0 (edge AB)", "type": "symmetry", "fixed": ["ux"]},
         {"selection": "y = 0 (edge CD)", "type": "symmetry", "fixed": ["uy"]},
         {"selection": "outer ellipse (edge BC)", "type": "normal_traction", "value": 10.0e6,
          "note": "outward tension"}],
        {"type": "stationary", "settings": {"plane": "stress"}},
        [ref("sigma_yy(D)", "sigma_yy_D", "direct stress at D = (2.0, 0) m", 92.7e6, "Pa",
             {"rel": 1.0e-2, "after": "richardson"}, "P", "benchmark",
             "NAFEMS TNSB Rev. 3 LE1 via FeenoX mechanical examples (\"reference is 92.7\")",
             "seamplex.com/feenox/examples/mechanical.html, LE1 section (fetched 2026-11-06)")],
        speed(2.0, "R3 s.3.2 browser est. < 2 s"), NAFEMS_RIGHTS, NOHERO, "nafems-le1",
        reference_results=[{"solver": "FeenoX", "value_MPa": 92.7011}],
        missing=["Thickness (does not enter plane-stress stresses)."]))

    in_, lbf = 0.0254, 4.4482216152605
    psi = lbf / in_**2
    C.append(case(
        "SM-03", "Euler column, pinned-pinned, first buckling load", ["solid-buckling"], "1D",
        {"kind": "analytic", "spec": {"length_m": 200 * in_, "square_section_side_m": 0.5 * in_,
                                      "note": "200 in, 0.5 in square (Ansys VM127)"}, "symmetry": "none"},
        {"steel": {"E": 30.0e6 * psi,
                   "source": "Ansys VM127 (E = 30e6 psi), exact unit conversion, " + VM.format(127)}},
        [{"selection": "end 0", "type": "pinned", "fixed": ["ux", "uy"]},
         {"selection": "end L", "type": "pinned", "fixed": ["uy"], "load": "axial compression, unit reference load"}],
        {"type": "eigen", "n": 3, "shift": 0.0, "settings": {"kind": "linear_buckling",
                                                             "shift_note": "buckling eigenproblem has no null space"}},
        [dref("SM-03", "F_cr", "F_cr", "pi^2 E I / L^2", "N", {"rel": 1.0e-4, "after": "richardson"},
              "Timoshenko, Strength of Materials II, p. 148 (via Ansys VM127)", GS + "::sm03"),
         dref("SM-03", "F_cr_lbf", "F_cr", "same in lbf", "lbf", {"rel": 1.0e-4}, "Ansys VM127", GS + "::sm03",
              gate=False)],
        speed(1.0, "R3 s.3.2 browser est. < 1 s"), ANSYS_RIGHTS, NOHERO, "euler-column"))

    C.append(case(
        "SM-04", "Hertz: elastic sphere on a rigid plane", ["solid-contact"], "2D-axisym",
        {"kind": "analytic", "spec": {"sphere_radius_m": 8.0e-3, "plane": "rigid, z = 0"},
         "symmetry": "axisymmetric about the load axis"},
        {"sphere": {"E": 1000.0e6, "nu": 0.3, "source": "Ansys VM63 (E = 1000 N/mm^2, nu = 0.3), " + VM.format(63)}},
        [{"selection": "contact face", "type": "frictionless_contact", "target": "rigid plane"},
         {"selection": "load", "type": "force", "value": 60 * math.pi, "unit": "N",
          "note": "F = 30 * 2 pi N (VM63); applied far from the contact (e.g. on the equatorial plane of a "
                  "hemisphere) so the contact zone sees the Hertz load"}],
        {"type": "stationary", "settings": {"nonlinear": "contact"}},
        [dref("SM-04", "a_contact", "a", "contact radius", "m", {"rel": 5.0e-3, "after": "finest"},
              "Timoshenko-Goodier 3rd ed. art. 140 (via Ansys VM63)", GS + "::sm04"),
         dref("SM-04", "p0", "p0", "peak contact pressure", "Pa", {"rel": 1.0e-2}, "Hertz", GS + "::sm04"),
         dref("SM-04", "delta", "delta", "approach", "m", {"rel": 1.0e-2}, "Hertz", GS + "::sm04", gate=False,
              note="depends on where the load is applied relative to the far field; informative")],
        speed(3.0, "R3 s.3.2 browser est. 1-3 s"), ANSYS_RIGHTS, NOHERO, "hertz-sphere",
        reference_results=[{"solver": "Ansys VM63 target", "a_mm": 1.010, "ansys_result_mm": 1.011,
                            "locator": VM.format(63)}],
        missing=["VM63 load application detail is not stated on the public page."],
        assumptions=["Small-strain linear elasticity; Hertz assumes a << R (a/R = 0.126 here), so expect a "
                     "small model-form difference; tolerance 0.5 %."]))

    C.append(case(
        "SM-05", "NAFEMS FV52: simply supported thick square plate, free vibration", ["solid-modal"], "3D",
        {"kind": "analytic", "spec": {"plate_m": [10.0, 10.0, 1.0]}, "symmetry": "none"},
        {"steel": {"E": 200.0e9, "nu": 0.3, "rho": 8000.0, "source": "Ansys VM-NAFEMS FV52 (TNSB Aug 1989)"}},
        [{"selection": "4 bottom edges (z = 0)", "type": "displacement", "fixed": ["uz"],
          "note": "as on the Ansys page; in-plane rigid modes 1-3 remain"}],
        {"type": "eigen", "n": 10, "shift": -1.0,
         "settings": {"shift_unit": "(rad/s)^2; small negative shift avoids the rigid-body null space"}},
        [ref(f"f_mode{m}", f"f_mode{m}", f"natural frequency, mode {m} (modes 1-3 rigid)", v, "Hz",
             {"rel": 5.0e-3, "after": "richardson"}, "P", "benchmark",
             "NAFEMS TNSB FV52 (modified) via Ansys VM-NAFEMS",
             "ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VMC5.html, target table")
         for m, v in [(4, 45.897), (5, 109.44), (6, 109.44), (7, 167.89), (8, 193.59), (9, 206.19), (10, 206.19)]],
        speed(5.0, "R3 s.3.2 browser est. 2-5 s"), NAFEMS_RIGHTS, NOHERO, "nafems-fv52",
        reference_results=[{"solver": "Altair OS-V FV52", "note": "disagrees with TNSB-based tables; do not use (R3)"}],
        missing=["Constraints on ux, uy are not stated on the Ansys page beyond 'UZ = 0 along the 4 edges at Z = 0'."]))

    C.append(case(
        "SM-06", "NAFEMS FV12: free thin square plate, free vibration (midsurface plate model)", ["solid-modal"],
        "2D",
        {"kind": "analytic", "spec": {"plate_midsurface_m": [10.0, 10.0], "thickness_m": 0.05,
                                      "model": "Kirchhoff (or Mindlin) plate on the midsurface; in-plane motion "
                                               "decoupled (u_x = u_y = theta_z = 0)",
                                      "alt_3d": "3D solid allowed only with the in-plane constraint applied to "
                                                "midsurface nodes (or as a through-thickness average equation), "
                                                "never to all nodes: that locks bending"},
         "symmetry": "none",
         "source": "side 10 m per R3 s.3.2 (the mirror page shows it only in a figure); thickness 0.05 m"},
        {"steel": {"E": 200.0e9, "nu": 0.3, "rho": 8000.0,
                   "source": "Abaqus Benchmarks v2016 mirror, FV12 (pointer only; cites TNSB Rev. 3)"}},
        [{"selection": "all edges", "type": "free"},
         {"selection": "midsurface", "type": "constraint", "fixed": ["ux", "uy", "theta_z"],
          "note": "NAFEMS FV12 shell constraint; Abaqus continuum shells use equivalent midsurface equations"}],
        {"type": "eigen", "n": 10, "shift": -1.0,
         "settings": {"shift_unit": "(rad/s)^2; small negative shift avoids the three rigid-body modes' null space"}},
        [dref("SM-06", f"f_mode{m}", f"f mode {m}", f"natural frequency, mode {m} ascending (modes 1-3 rigid)", "Hz",
              {"rel": 2.0e-3, "after": "richardson"}, "Rayleigh-Ritz Kirchhoff plate (this lane)", GS + "::sm06",
              extract={"kind": "eigen", "offset": 3, "floor": 1.0e-2, "match": "sorted"})
         for m in range(4, 11)]
        + [ref(f"f_mode{m}", f"f_mode{m}.nafems", f"NAFEMS target, mode {m}", v, "Hz",
               {"rel": 1.5e-2}, "P", "benchmark", "NAFEMS TNSB Rev. 3 FV12 via Abaqus v2016 mirror",
               "ceae-server.colorado.edu/v2016/books/bmk/ch04s04anf18.html, target table (rights unclear: pointer)",
               gate=False, note="informative: modes 7-9 sit 0.8-1.0 % above the converged Kirchhoff solution; the "
                                "basis of the NAFEMS FV12 values is not stated on any page seen")
           for m, v in [(4, 1.622), (5, 2.360), (6, 2.922), (7, 4.233), (8, 4.233), (9, 7.416)]],
        speed(5.0, "R3 s.3.2 browser est. 2-5 s"), NAFEMS_RIGHTS, NOHERO, "nafems-fv12",
        reference_results=[{"solver": "Abaqus S4R (same mirror page)", "modes_7_9_Hz": [4.265, 7.880],
                            "note": "auditor reading, above both NAFEMS and Ritz"}],
        missing=["Exact NAFEMS constraint equation (an image on the mirror page).",
                 "Frequency unit not printed (Hz assumed)."],
        assumptions=["Gate is the converged Kirchhoff Ritz solution (change between the two finest levels <= 2e-8 "
                     "Hz). Shear deformation and rotary inertia are neglected; their effect at t/a = 0.005 is "
                     "est. < 1e-3 rel. (not computed), inside the 2e-3 tolerance; a Mindlin or 3D solver may sit "
                     "slightly below the Ritz values."]))

    C.append(case(
        "SM-07", "Plastic hinge in a rectangular beam under pure bending", ["solid-plasticity"], "2D",
        {"kind": "analytic", "spec": {"length_m": 10 * in_, "width_m": 1 * in_, "height_m": 2 * in_,
                                      "note": "10 x 1 x 2 in full beam (Ansys VM24); a half model (mid-span "
                                              "symmetry) is allowed"}, "symmetry": "half (mid-span), optional"},
        {"steel": {"E": 30.0e6 * psi, "nu": 0.3, "sigma_y": 36000 * psi, "hardening": "none (perfectly plastic)",
                   "source": "Ansys VM24"}},
        [{"selection": "mid-span section (half model)", "type": "symmetry", "fixed": ["ux"]},
         {"selection": "end section(s)", "type": "moment", "values_over_Myp": [1.0, 1.1666, 1.3333],
          "M_yp": 24000 * lbf * in_,
          "note": "pure bending: end section kept plane (rigid-section / kinematic coupling) with the moment applied "
                  "at its centroid; M/M_yp = 1.5 is the collapse limit, not a load step"}],
        {"type": "parametric", "settings": {"parameter": "M/M_yp", "values": [1.0, 1.1666, 1.3333]}},
        [dref("SM-07", f"rotation.m{m}.literal", f"theta(M/Myp = {m})",
              "relative rotation of the two end sections of the full 10 in beam = kappa L (half model: 2 x the "
              "end-section rotation relative to the mid-span plane)", "rad",
              {"rel": 2.0e-3}, "Timoshenko, Strength of Materials II art. 64 (via Ansys VM24)", GS + "::sm07")
         for m in ["1.0", "1.1666", "1.3333"]],
        speed(3.0, "R3 s.3.2 browser est. 1-3 s"), ANSYS_RIGHTS, NOHERO, "plastic-hinge",
        reference_results=[{"solver": "Ansys VM24 target", "rotations": [0.01200, 0.01469, 0.02078],
                            "note": "0.01469 is the closed form 0.0146955 truncated",
                            "locator": VM.format(24)}],
        assumptions=["Rotation = curvature x full length L = 10 in (reproduces the VM24 0.01200 at first yield)."]))

    # ------------------------------------------------------------------ EM / RF
    C.append(case(
        "EM-01", "Coaxial line: Z0, C', L' (TEM)", ["electrostatics", "magnetostatics"], "2D",
        {"kind": "analytic", "spec": {"inner_radius_m": 0.5e-3, "outer_radius_m": 1.75e-3}, "symmetry": "none"},
        {"dielectric": {"eps_r": 2.1, "mu_r": 1.0, "source": "synthetic (R3 s.3.3)"}},
        [{"selection": "inner conductor", "type": "potential", "value": 1.0},
         {"selection": "outer conductor", "type": "potential", "value": 0.0}],
        {"type": "stationary"},
        [dref("EM-01", "C_per_m", "C'", "capacitance per unit length", "F/m", rel3, "Pozar ch. 2", GE + "::em01"),
         dref("EM-01", "L_per_m", "L'", "inductance per unit length (magnetostatic, surface currents)", "H/m", rel3,
              "Pozar ch. 2", GE + "::em01"),
         dref("EM-01", "Z0", "Z0", "sqrt(L'/C')", "Ohm", rel3, "Pozar ch. 2", GE + "::em01")],
        speed(1.0, "R3 s.3.3 browser est. < 1 s"), TEXTBOOK_RIGHTS, NOHERO, "coax-line"))

    C.append(case(
        "EM-04", "Helmholtz coil: centre field and uniformity", ["magnetostatics"], "2D-axisym",
        {"kind": "analytic", "spec": {"loop_radius_m": 0.1, "loop_z_m": [-0.05, 0.05], "turns": 1,
                                      "wire": "filament (or thin wire, radius << R)",
                                      "air_box": "Kelvin transform or infinite elements; or a truncation sphere "
                                                 "R_b >= 30 R (truncation error <= 5.2e-5 B0, see "
                                                 "eval/expected/EM-04.json truncation.*)"},
         "symmetry": "axisymmetric"},
        {"air": {"mu_r": 1.0, "source": "vacuum"}},
        [{"selection": "loops", "type": "current", "value": 1.0, "unit": "A"},
         {"selection": "outer boundary", "type": "open",
          "note": "A_phi = 0 on a sphere R_b shifts B(0) by -1.398 (R/R_b)^3 B0 (H_t = 0: +0.699 (R/R_b)^3 B0); "
                  "R_b = 10 R gives 1.4e-3 B0, above the 1e-3 gate, so R_b >= 30 R or an exact open BC"}],
        {"type": "stationary"},
        [dref("EM-04", "B_center", "B(0)", "|B| at the centre", "T", rel3, "Biot-Savart closed form", GE + "::em04"),
         dref("EM-04", "Bz_probe", "B_z(0.02, 0.01)", "off-axis probe", "T", rel3,
              "elliptic-integral loop formula", GE + "::em04"),
         dref("EM-04", "Br_probe", "B_rho(0.02, 0.01)", "off-axis probe (|B_rho| = 9.3e-4 B0)", "T",
              {"abs": 9.0e-10, "note": "abs 1e-4 B0 (B0 = 8.99e-6 T), same absolute accuracy as B_z at 1e-4"},
              "elliptic-integral loop formula", GE + "::em04"),
         dref("EM-04", "uniformity_sphere_0.1R", "uniformity", "max | |B| - B0 | / B0 on a sphere r = 0.1 R", "1",
              {"abs": 2.0e-5}, "elliptic-integral loop formula", GE + "::em04", gate=False,
              note="informative: 1.14e-4 is the same order as the allowed truncation shift"),
         dref("EM-04", "truncation.dirichlet_A.Rb30R", "truncation shift",
              "(B(0) - B0)/B0 from A_phi = 0 at R_b = 30 R",
              "1", {"abs": 1.0e-5}, "dipole image, closed form (this lane)", GE + "::em04", gate=False,
              note="sensitivity record for the truncation requirement")],
        speed(2.0, "R3 s.3.3 browser est. < 2 s"), TEXTBOOK_RIGHTS,
        {"suitable": True, "why": "R3 hero; field lines and the uniform region respond live to spacing",
         "visual": ["B_magnitude", "field_lines"]}, "helmholtz-coil",
        extra={"field_reference": {"function": "validation/a/fields.py EM-04", "fields": ["B_rho", "B_z"]}}))

    C.append(case(
        "RF-02", "WR-90 rectangular waveguide: cutoffs and straight-section S-parameters",
        ["rf-waveguide", "rf-sparams"], "2D",
        {"kind": "analytic", "spec": {"a_m": 22.86e-3, "b_m": 10.16e-3, "section_length_m": 50.0e-3},
         "symmetry": "none"},
        {"air": {"eps_r": 1.0, "mu_r": 1.0, "source": "vacuum"}},
        [{"selection": "walls", "type": "pec"},
         {"selection": ["port1", "port2"], "type": "port", "mode": "TE10", "note": "3D S-parameter variant only"}],
        {"type": "eigen", "n": 4, "shift": 5.0e9, "settings": {"kind": "2D cross-section cutoff",
                                                               "shift_unit": "Hz, below the TE10 cutoff; a "
                                                                             "curl-curl form has a gradient null "
                                                                             "space at 0",
                                                               "frequency_variant_f_list": [10.0e9]}},
        [dref("RF-02", "fc_TE10", "f_c TE10", "cutoff", "Hz", {"rel": 1.0e-5, "after": "richardson"}, "Pozar ch. 3",
              GE + "::rf02"),
         dref("RF-02", "fc_TE20", "f_c TE20", "cutoff", "Hz", {"rel": 1.0e-5, "after": "richardson"}, "Pozar ch. 3",
              GE + "::rf02"),
         dref("RF-02", "fc_TE01", "f_c TE01", "cutoff", "Hz", {"rel": 1.0e-5, "after": "richardson"}, "Pozar ch. 3",
              GE + "::rf02"),
         dref("RF-02", "S21_phase_10GHz_L50mm", "arg S21", "-beta L wrapped, f = 10 GHz", "rad", {"abs": 1.0e-3},
              "Pozar ch. 3", GE + "::rf02", gate=False, note="3D S-parameter variant"),
         dref("RF-02", "S11_mag", "|S11|", "matched straight section", "1", {"abs": 1.0e-3}, "Pozar ch. 3",
              GE + "::rf02", gate=False, note="3D S-parameter variant")],
        speed(1.0, "R3 s.3.4 browser est. 2D eig < 1 s (3D S 5-20 s)"), TEXTBOOK_RIGHTS, NOHERO, "wr90-guide",
        assumptions=["S21/S11 targets belong to a 3D variant; split into its own case or sub-spec when the L2 "
                     "models land (audit M10)."]))

    C.append(case(
        "RF-04", "Centre-fed half-wave dipole: input conductance vs radius, thin-wire impedance", ["rf-antenna"],
        "2D-axisym",
        {"kind": "analytic", "spec": {"wavelength_m": 1.0, "half_length_m": 0.25,
                                      "radius_list_m": [1.0e-2, 1.0 / 300, 1.0e-3],
                                      "gap_width_m": "<= 2 x radius (finite-gap port); the reference is a delta gap",
                                      "note": "lambda = 1 m (f = 299.792458 MHz); all lengths scale with lambda"},
         "symmetry": "axisymmetric"},
        {"air": {"eps_r": 1.0, "mu_r": 1.0, "source": "vacuum"}, "wire": {"type": "pec", "source": "ideal conductor"}},
        [{"selection": "wire", "type": "pec"}, {"selection": "gap", "type": "lumped_port", "impedance": 50.0},
         {"selection": "outer boundary", "type": "absorbing", "note": "PML or first-order ABC"}],
        {"type": "frequency", "f_list": [299792458.0]},
        [dref("RF-04", f"G_in.a_{nm}", f"G_in, a = {lab}", "input conductance Re(1/Z_in) at L = lambda/2", "S",
              {"rel": 3.0e-2, "after": "finest",
               "note": "3 % covers the finite-gap vs delta-gap feed difference (proposal); the reference is a "
                       "Hallen MoM, Richardson-extrapolated (correction <= 0.18 %)"},
              "Hallen MoM, exact kernel (this lane)", GE + "::rf04 hallen_dipole")
         for nm, lab in [("lambda_over_100", "lambda/100"), ("lambda_over_300", "lambda/300"),
                         ("lambda_over_1000", "lambda/1000")]]
        + [dref("RF-04", "R_in", "R_in", "thin-wire limit, sinusoidal current (induced EMF)", "Ohm", {"rel": 5.0e-2},
                "Balanis ch. 4 (eq. 4-79 form; formula not fetched)", GE + "::rf04", gate=False,
                note="the a -> 0 limit; finite-radius solvers approach it logarithmically"),
           dref("RF-04", "X_in", "X_in", "thin-wire limit, sinusoidal current", "Ohm", {"rel": 1.0e-1},
                "Balanis ch. 4", GE + "::rf04", gate=False),
           dref("RF-04", "G_in.thin_limit", "G_in thin limit", "Re(1/(R_in + j X_in))", "S", {"rel": 5.0e-2},
                "closed form", GE + "::rf04", gate=False)],
        speed(10.0, "R3 s.3.4 browser est. 3-10 s"), TEXTBOOK_RIGHTS, NOHERO, "half-wave-dipole",
        assumptions=["Gate on input conductance only: with a delta gap the susceptance grows like ln N (zero-width "
                     "gap capacitance) and a finite gap adds its own capacitance, so X_in is not comparable between "
                     "feed models; a shunt gap capacitance leaves G unchanged.",
                     "MoM reference is this lane's Hallen solver (eval/expected/RF-04.json records levels, observed "
                     "order ~1 and the quadrature check); no published finite-radius table was fetched."]))

    C.append(case(
        "RF-21", "PEC circular cylinder cavity, filled with eps_r 2.08: closed-form modes", ["rf-resonator"],
        "2D-axisym",
        {"kind": "analytic", "spec": {"radius_m": 2.74e-2, "height_m": 5.48e-2},
         "symmetry": "axisymmetric (azimuthal order m per mode)",
         "source": "Palace docs examples/cylinder.md set-up (analytic twin of class-c RF-01)"},
        {"fill": {"eps_r": 2.08, "tan_delta": 4.0e-4, "mu_r": 1.0, "source": "Palace docs cylinder.md (R3 s.3.4)"}},
        [{"selection": "walls", "type": "pec"}],
        {"type": "eigen", "n": 16, "shift": 2.5e9,
         "settings": {"n_note": "3D: n >= 16 reaches TE011/TM111 (indices 12-14) with all degenerate partners; "
                                "2D-axisym: solve per azimuthal order m = 0, 1, 2 (n >= 4 each)",
                      "classifier": "TE: E_z = 0; TM: H_z = 0; m from the phi dependence. TE011 and TM111 are exactly "
                                    "degenerate (x'01 = x11, J0' = -J1): identify TE011 by m = 0 and E_z = 0"}},
        [dref("RF-21", f"f_{k}", f"f {k}",
              (lambda md: f"{md['family']}, m = {md['m']}, n = {md['n']}, p = {md['p']}, multiplicity "
                          f"{md['multiplicity']}, 3D ascending index {md['index_3d_first']}-{md['index_3d_last']}"
                          + (f", degenerate with {', '.join(md['degenerate_with'])}" if md['degenerate_with'] else ""))
              (evt("RF-21", f"f_{k}")["mode"]),
              "Hz", {"rel": 1.0e-5, "after": "richardson"}, "closed form (Pozar ch. 6)", GE + "::rf21")
         for k in ["TM010", "TE111", "TM011", "TM110", "TE211", "TE011"]]
        + [dref("RF-21", "Q_dielectric", "Q_d", "1/tan(delta)", "1", {"rel": 1.0e-3}, "closed form", GE + "::rf21",
                gate=False,
                note="identity, not a solver test: for a homogeneous fill Q_d^-1 = tan(delta) on any mesh and mode "
                     "(M2 audit: 2500 +- 2e-11 on every level, 13.1 s of the 15.2 s case on the 3D path). Kept as an "
                     "informative check; a single coarse level suffices once the harness supports per-target levels")],
        speed(2.0, "by analogy with R3 RF-01 2D browser est. < 2 s"),
        {"source_license": "formula textbook; set-up from Palace docs (Apache-2.0)",
         "allowed": ["cite_values", "re_derive_setup", "copy_with_attribution"],
         "forbidden": ["copy_text_without_attribution"]},
        NOHERO, "cylinder-cavity",
        assumptions=["R3 s.8 flag resolved: Palace's analytic table uses Bessel zeros rounded to 4 decimals "
                     "(reproduced within 1.1e-7); the exact TM010 is 2.903636072 GHz. Gate on the exact closed form."]))

    # ------------------------------------------------------------------ optics
    C.append(case(
        "WO-01", "Symmetric Si slab in SiO2 at 1550 nm: TE0 and TM0", ["optics-modes"], "1D",
        {"kind": "layer_stack", "spec": {"core_thickness_m": 220e-9, "cladding": "semi-infinite both sides",
                                         "computational_cladding_m": ">= 2 um each side with PML or decaying BC"},
         "symmetry": "mirror (even modes)"},
        {"Si": {"n": 3.477723756, "source": "eo-modulator-atlas K1 value (Salzberg-Tatian fit at 1550 nm) (R3)"},
         "SiO2": {"n": 1.444023622, "source": "eo-modulator-atlas K1 value (Malitson fit at 1550 nm) (R3)"}},
        [{"selection": "outer ends", "type": "pec_or_decay", "note": "field decays as exp(-gamma |x|)"}],
        {"type": "eigen", "n": 2, "shift": "n_eff near 3.0", "settings": {"wavelength_m": 1550e-9}},
        [dref("WO-01", "neff_TE0", "n_eff TE0", "fundamental TE", "1", {"rel": 1.0e-6, "after": "richardson"},
              "slab dispersion relation", GO + "::wo01"),
         dref("WO-01", "neff_TM0", "n_eff TM0", "fundamental TM", "1", {"rel": 1.0e-6, "after": "richardson"},
              "slab dispersion relation", GO + "::wo01")],
        speed(0.5, "R3 s.3.5 browser est. < 0.5 s"), TEXTBOOK_RIGHTS, NOHERO, "si-slab",
        assumptions=["Indices treated as constants at 1550 nm."]))

    x_bh = 2 * math.pi * 0.525 / 0.6328
    C.append(case(
        "WO-03", "Mie scattering by a sphere: efficiencies and near field", ["optics-scattering"], "3D",
        {"kind": "analytic", "spec": {"dielectric": {"radius_m": 0.525e-6, "wavelength_m": 0.6328e-6,
                                                     "size_parameter": x_bh},
                                      "absorbing": {"size_parameter": 1.0, "wavelength_m": 0.6328e-6,
                                                    "radius_m": 0.6328e-6 / (2 * math.pi),
                                                    "note": "synthetic radius a = lambda/(2 pi) so x = 1; same "
                                                            "frequency as the dielectric sub-case"},
                                      "background": "vacuum, n = 1"},
         "symmetry": "two mirror planes (x = 0, y = 0) for x-polarized incidence"},
        {"sphere_dielectric": {"m": "1.55", "source": "BH appendix example via miepython test_03_bh_dielectric"},
         "sphere_absorbing": {"m": "1.5 + 1i (BH sign; miepython writes 1.5 - 1j)",
                              "eps_r": "(1.5 + 1i)^2 = 1.25 + 3i under exp(-i w t); 1.25 - 3j under exp(+j w t)",
                              "source": "Wiscombe MIEV0 case 14 via miepython test_07"}},
        [{"selection": "incident", "type": "plane_wave", "polarization": "x", "direction": "+z", "amplitude": 1.0},
         {"selection": "outer boundary", "type": "pml"}],
        {"type": "frequency", "f_list": [299792458.0 / 0.6328e-6]},
        [dref("WO-03", f"dielectric.{q}", q, f"{q} efficiency", "1", {"rel": 1.0e-3, "after": "richardson"},
              "Bohren-Huffman BHMIE (this lane)", GO + "::wo03") for q in ["qext", "qsca", "g"]]
        + [dref("WO-03", "dielectric.qback", "qback", "BH backscatter efficiency", "1", {"rel": 5.0e-3},
                "Bohren-Huffman", GO + "::wo03")]
        + [dref("WO-03", f"absorbing.{q}", q, f"{q} efficiency", "1", {"rel": 1.0e-3}, "Bohren-Huffman",
                GO + "::wo03") for q in ["qext", "qsca", "qabs", "g"]]
        + [dref("WO-03", f"dielectric.near.E2.{p}", f"|E|^2 at {p}", "near-field probe", "E0^2",
                {"rel": 5.0e-3}, "BH vector harmonics (this lane)", GO + "::wo03")
           for p in ["zp1.5a", "zm1.5a", "centre", "xp1.5a"]],
        speed(60.0, "R3 s.3.5 browser est. 3D FEM 10-60 s; series < 0.1 s"),
        {"source_license": "formulas textbook (BH); reference digits from miepython tests (MIT)",
         "allowed": ["cite_values", "re_derive_setup", "copy_with_attribution"], "forbidden": ["copy_text"]},
        {"suitable": True, "why": "R3 hero; near-field and far-field pattern from one solve",
         "visual": ["E_magnitude", "far_field_pattern"]}, "mie-sphere",
        reference_results=[{"solver": "miepython tests (BHMIE, MIEV0)",
                            "dielectric": {"qext": 3.10543, "qback": 2.92534,
                                                                                       "g": 0.63314},
                            "absorbing": {"qext": 2.336321, "qsca": 0.6634538, "g": 0.192136}}],
        assumptions=["R3's 'x 5.213' is x = 2 pi 0.525/0.6328 = 5.2128197 rounded; at x = 5.213 exactly Qext = "
                     "3.104996 and the reference digits fail. The case uses the exact radius and wavelength."],
        extra={"field_reference": {"function": "validation/a/fields.py WO-03", "fields": ["Ex", "Ey", "Ez"],
                                   "complex": True}}))

    C.append(case(
        "WO-21", "Quarter-wave Bragg stack (Si/SiO2, 1550 nm): first gap edges", ["optics-phc"], "1D",
        {"kind": "layer_stack", "spec": {"lambda0_m": 1550e-9, "d_Si_m": 1550e-9 / (4 * 3.477723756),
                                         "d_SiO2_m": 1550e-9 / (4 * 1.444023622), "period": "Bloch-periodic unit cell"},
         "symmetry": "none"},
        {"Si": {"n": 3.477723756, "source": "as WO-01"}, "SiO2": {"n": 1.444023622, "source": "as WO-01"}},
        [{"selection": "cell ends", "type": "bloch_periodic", "k": "sweep 0 .. pi/Lambda"}],
        {"type": "eigen", "n": 4, "shift": 0.0, "settings": {"kind": "band structure, normal incidence"}},
        [dref("WO-21", "w_lower_over_w0", "omega_lower / omega0", "lower gap edge", "1", {"rel": 1.0e-6},
              "transfer-matrix closed form (JJ ch. 4)", GO + "::wo21"),
         dref("WO-21", "w_upper_over_w0", "omega_upper / omega0", "upper gap edge", "1", {"rel": 1.0e-6},
              "transfer-matrix closed form (JJ ch. 4)", GO + "::wo21"),
         dref("WO-21", "gap_to_midgap", "gap / midgap", "(4/pi) asin(|n1 - n2|/(n1 + n2))", "1", {"rel": 1.0e-6},
              "closed form", GO + "::wo21")],
        speed(0.5, "by analogy with R3 WO-01 < 0.5 s"), TEXTBOOK_RIGHTS, NOHERO, "bragg-stack",
        assumptions=["Inputs chosen by this lane (reuse WO-01 indices); nondispersive."]))

    # ------------------------------------------------------------------ acoustics
    C.append(case(
        "AC-02", "Rigid-walled rectangular room: lowest modes", ["acoustics"], "3D",
        {"kind": "analytic", "spec": {"box_m": [1.0, 0.8, 0.6]}, "symmetry": "none"},
        {"air": {"c": 343.0, "rho": 1.2, "source": "synthetic (R3 s.3.6); rho does not enter frequencies"}},
        [{"selection": "walls", "type": "rigid"}],
        {"type": "eigen", "n": 11, "shift": -1.0,
         "settings": {"shift_unit": "(rad/s)^2; avoids the constant-pressure null space"}},
        [dref("AC-02", f"f_mode{i}", f"f mode {i}", "non-zero mode, ascending", "Hz",
              {"rel": 1.0e-4, "after": "richardson"}, "closed form (Morse-Ingard / Kinsler)", GM + "::ac02")
         for i in range(1, 11)],
        speed(3.0, "R3 s.3.6 browser est. 1-3 s"), TEXTBOOK_RIGHTS,
        {"suitable": True, "why": "R3 hero; mode shapes animate with a slider for box size",
         "visual": ["pressure_mode_shape", "isosurfaces"]}, "rigid-box-modes",
        assumptions=["The zero mode (uniform pressure) is excluded from the numbering."]))

    C.append(case(
        "AC-03", "Plane wave scattering by a rigid sphere", ["acoustics"], "2D-axisym",
        {"kind": "analytic", "spec": {"sphere_radius_m": 1.0, "ka_list": [0.5, 1.0, 2.0, 5.0, 10.0]},
         "symmetry": "axisymmetric (incidence along the axis)"},
        {"air": {"c": 343.0, "rho": 1.2, "source": "synthetic; results depend on ka only"}},
        [{"selection": "sphere", "type": "rigid"},
         {"selection": "incident", "type": "plane_wave", "amplitude": 1.0, "direction": "+z"},
         {"selection": "outer boundary", "type": "pml_or_radiation"}],
        {"type": "frequency", "f_list": "c ka / (2 pi a) for each ka"},
        [dref("AC-03", f"sigma_over_pia2_ka{ka}", f"sigma_s/(pi a^2), ka = {ka}", "total scattering cross-section",
              "1", {"rel": 2.0e-3}, "partial-wave series (Morse-Ingard; not fetched)", GM + "::ac03")
         for ka in [0.5, 1.0, 2.0, 5.0, 10.0]]
        + [dref("AC-03", f"abs_f_back_ka{ka}", f"|f(pi)|, ka = {ka}",
                "backscatter form function 2/(ka) |sum_n (-1)^n (2n+1) j_n'(ka)/h_n'(ka)|, p_s -> p0 (a/2r) f e^{ikr}",
                "1",
                {"rel": 5.0e-3}, "partial-wave series", GM + "::ac03") for ka in [0.5, 1.0, 2.0, 5.0, 10.0]],
        speed(5.0, "R3 s.3.6 browser est. 1-5 s"), TEXTBOOK_RIGHTS, NOHERO, "rigid-sphere-scattering",
        assumptions=["ka list chosen by this lane within R3's range 0.5-10."],
        extra={"field_reference": {"function": "validation/a/fields.py AC-03", "fields": ["p"], "complex": True}}))

    # ------------------------------------------------------------------ fluids
    C.append(case(
        "FL-01", "Kovasznay flow (Re 10) and planar Poiseuille: exact NS solutions", ["laminar-ns", "stokes"], "2D",
        {"kind": "analytic", "spec": {"kovasznay_domain_m": [[-0.5, 1.5], [-0.5, 1.5]],
                                      "poiseuille_domain_m": [[0.0, 1.0], [0.0, 1.0]]}, "symmetry": "none"},
        {"kovasznay_fluid": {"rho": 1.0, "mu": 0.1, "source": "synthetic: Re = 10 with U = L = 1"},
         "poiseuille_fluid": {"rho": 1.0, "mu": 1.0, "source": "dolfinx-tutorial ns_code1 set-up (CC BY 4.0)"}},
        [{"selection": "kovasznay: all boundaries", "type": "velocity", "expr": "exact (fields.py FL-01)"},
         {"selection": "kovasznay: pressure", "type": "gauge", "note": "zero mean over the domain"},
         {"selection": "poiseuille: y = 0, y = 1", "type": "no_slip"},
         {"selection": "poiseuille: x = 0", "type": "pressure", "value": 8.0},
         {"selection": "poiseuille: x = 1", "type": "pressure", "value": 0.0}],
        {"type": "stationary", "settings": {"element_assumed_by_tolerances": "Taylor-Hood P2/P1 (velocity L2 rate "
                                                                    "3, H1 rate 2; Poiseuille exact)"}},
        [dref("FL-01", "kovasznay.field_rel_L2_u", "velocity field error", "relative L2 velocity error", "1",
              {"abs": 1.0e-4, "norm": "rel_l2",
               "rule": {"type": "rate", "min": 2.0,
                        "note": "velocity L2 rate p+1 (3 for Taylor-Hood P2/P1); min 2.0 is a proposal"}},
              "Kovasznay 1948",
              "validation/a/fields.py FL-01"),
         dref("FL-01", "kovasznay.v.x0.5_y0.25", "v(0.5, 0.25)", "probe", "m/s", rel3, "Kovasznay 1948",
              GM + "::fl01"),
         dref("FL-01", "kovasznay.p.x1.0_y0.5", "p(1.0, 0.5)", "probe, zero-mean pressure", "Pa", {"rel": 1.0e-2},
              "Kovasznay 1948", GM + "::fl01"),
         dref("FL-01", "poiseuille.u_max", "u_max", "centreline velocity", "m/s",
              {"rel": 1.0e-6, "after": "finest",
               "note": "Taylor-Hood P2/P1 contains the exact field; other elements: rel 1e-3 after richardson"},
              "Poiseuille (P2 velocity is exact)", GM + "::fl01"),
         dref("FL-01", "poiseuille.flow_rate", "Q", "flow rate per unit depth", "m^2/s",
              {"rel": 1.0e-6, "after": "finest",
               "note": "Taylor-Hood P2/P1 contains the exact field; other elements: rel 1e-3 after richardson"},
              "Poiseuille", GM + "::fl01")],
        speed(2.0, "R3 s.3.7 browser est. < 2 s"),
        {"source_license": "exact solutions (facts); set-ups as in deal.II step-55 "
                           "(Apache-2.0 WITH LLVM-exception) and "
                           "dolfinx-tutorial (CC BY 4.0)",
         "allowed": ["cite_values", "re_derive_setup"], "forbidden": ["copy_text"]},
        NOHERO, "kovasznay-poiseuille",
        assumptions=["Kovasznay domain [-0.5, 1.5]^2 as R3 states; the exact solution holds on any domain."],
        extra={"field_reference": {"function": "validation/a/fields.py FL-01 / FL-01-pois",
                                   "fields": ["u", "v", "p"]}}))

    # ------------------------------------------------------------------ transport / semiconductor / coupled
    C.append(case(
        "TR-01", "Isothermal tubular reactor, first-order reaction: plug flow and axial dispersion",
        ["transport-reaction", "transport-diffusion"], "1D",
        {"kind": "analytic", "spec": {"length_m": 1.0}, "symmetry": "none"},
        {"fluid": {"u": 1.0e-3, "k": 1.0e-3, "D_list": [1.0e-3, 1.0e-4, 1.0e-5],
                   "source": "synthetic: Da = 1, Pe = 1, 10, 100 (R3 gives no inputs)"}},
        [{"selection": "x = 0", "type": "danckwerts_inlet", "expr": "u C0 = u C - D dC/dx", "C0": 1.0},
         {"selection": "x = L", "type": "danckwerts_outlet", "expr": "dC/dx = 0"}],
        {"type": "parametric", "settings": {"parameter": "Pe", "values": [1.0, 10.0, 100.0]}},
        [dref("TR-01", "pfr.C_L_over_C0", "C(L)/C0, plug flow", "exp(-Da)", "1", {"rel": 1.0e-4},
              "closed form", GM + "::tr01", note="plug-flow model (no dispersion), e.g. an ODE in x")]
        + [dref("TR-01", f"danckwerts.C_L_over_C0_Pe{pe}", f"C(L)/C0, Pe = {pe}", "outlet conversion", "1",
                rel3, "Danckwerts 1953 (formula not fetched)", GM + "::tr01") for pe in ["1", "10", "100"]]
        + [dref("TR-01", f"danckwerts.C_0_over_C0_Pe{pe}", f"C(0+)/C0, Pe = {pe}", "inlet jump", "1",
                rel3, "Danckwerts 1953", GM + "::tr01") for pe in ["1", "10", "100"]],
        speed(0.5, "R3 s.3.8 browser est. < 0.5 s"), TEXTBOOK_RIGHTS, NOHERO, "dispersion-reactor",
        extra={"field_reference": {"function": "validation/a/fields.py TR-01", "fields": ["C_over_C0"]}}))

    C.append(case(
        "SC-01", "Abrupt Si pn junction at equilibrium", ["semiconductor-dd", "electrostatics"], "1D",
        {"kind": "analytic", "spec": {"length_m": 1.0e-6, "junction_at_m": 0.5e-6,
                                      "note": "length >> W = 50 nm; synthetic"}, "symmetry": "none"},
        {"Si": {"N_A": 1.0e24, "N_D": 1.0e24, "n_i": 1.0e16, "eps_r": 11.7, "T": 300.0,
                "source": "doping 1e18 cm^-3 and n_i 1e10 cm^-3: R3 s.3.9 (textbook inputs, synthetic); eps_r 11.7: "
                          "assumption (commonly quoted 300 K static value; primary table not fetched)"}},
        [{"selection": "x = 0", "type": "ohmic", "bias": 0.0}, {"selection": "x = L", "type": "ohmic", "bias": 0.0}],
        {"type": "stationary", "settings": {"statistics": "Boltzmann", "ionization": "full"}},
        [dref("SC-01", "V_bi", "V_bi", "(kT/q) ln(N_A N_D/n_i^2)", "V", {"rel": 1.0e-5}, "Hu eq. 4.1.2",
              GM + "::sc01"),
         dref("SC-01", "E_max_PB_0V.epsr11.7", "E_max", "peak field, exact Poisson-Boltzmann first integral", "V/m",
              {"rel": 1.0e-3, "after": "richardson"}, "first integral (this lane)", GM + "::sc01"),
         dref("SC-01", "W_0V.epsr11.7", "W", "depletion width, depletion approximation", "m", {"rel": 5.0e-2},
              "Hu eq. 4.2.8", GM + "::sc01", gate=False,
              note="depletion approximation; a drift-diffusion solve has no sharp edge")],
        speed(0.5, "R3 s.3.9 browser est. < 0.5 s"),
        {"source_license": "Hu textbook free author PDF, all rights reserved; formulas only",
         "allowed": ["cite_values", "re_derive_setup"], "forbidden": ["copy_text", "copy_figures"]},
        NOHERO, "pn-junction",
        missing=["Primary source for eps_r of Si (R3 lists 11.7 and 11.1; 11.1 has no source; the Ioffe NSM page "
                 "failed TLS on 2026-11-06)."],
        assumptions=["eps_r = 11.7 is an input of the test, not a measured target. Sensitivity: E_max scales as "
                     "eps_r^-1/2, so 11.9 gives -0.84 % (eval/expected/SC-01.json E_max_PB_0V.epsr11.9); V_bi does "
                     "not depend on eps_r."]))

    C.append(case(
        "CP-05", "Electro-osmotic flow in a slit (Debye-Hueckel + Stokes)", ["coupled-eof", "electrostatics", "stokes"],
        "2D",
        {"kind": "analytic", "spec": {"half_gap_m": 100e-9, "length_m": 1.0e-6, "note": "periodic in x"},
         "symmetry": "mirror about y = 0"},
        {"electrolyte": {"eps_r": 80.0, "eta": 1.0e-3, "c0": 1.0, "c0_unit": "mol/m^3", "valence": 1, "T": 298.15,
                         "source": "synthetic: eps_r 80, eta 1e-3 Pa s, zeta, E as R3 s.3.10 lists them (R3: "
                                   "Wikipedia re-tab, not fetched); c0, T, half gap chosen by this lane"}},
        [{"selection": "walls y = +-h", "type": "zeta_potential", "value": -0.050},
         {"selection": "walls", "type": "no_slip"},
         {"selection": "x ends", "type": "periodic"},
         {"selection": "domain", "type": "applied_field", "E_x": 1.0e4}],
        {"type": "stationary", "settings": {"poisson": "linearized (Debye-Hueckel)"}},
        [dref("CP-05", "u_HS", "u_HS", "-eps zeta E/eta", "m/s", {"rel": 1.0e-6}, "Helmholtz-Smoluchowski",
              GM + "::cp05", gate=False),
         dref("CP-05", "u_center", "u(0)", "centre velocity", "m/s", rel3, "DH + Stokes closed form", GM + "::cp05"),
         dref("CP-05", "u_mean", "u_mean", "slit-averaged velocity", "m/s", rel3, "DH + Stokes closed form",
              GM + "::cp05")],
        speed(1.0, "R3 s.3.10 browser est. < 1 s"), TEXTBOOK_RIGHTS, NOHERO, "eo-slit",
        assumptions=["Class a (closed form): R3's table labels CP-05 'c', but its basis is D and the R3 count "
                     "'a 24' requires it (contract request).",
                     "|zeta| e/kT = 1.95 > 1: Debye-Hueckel is outside its validity for a real electrolyte; the case "
                     "defines the linearized PDE, for which the closed form is exact."],
        extra={"field_reference": {"function": "validation/a/fields.py CP-05", "fields": ["u"]}}))

    C.append(case(
        "CP-02", "NAFEMS LE11: cylinder / taper / sphere under a temperature field", ["solid-thermal-stress"], "3D",
        {"kind": "analytic", "spec": {"meridian_points_m": {"A": [1.0, 0.0], "B": [1.4, 0.0], "H": [0.70711, 1.79711],
                                                            "I": [1.0, 1.79711]},
                                      "note": "full profile in FeenoX examples/nafems-le11.geo"},
         "symmetry": "axisymmetric body, quarter model",
         "source": "FeenoX nafems-le11.geo via advanced-packaging-atlas validation/cases/B/nafems-LE11.yaml"},
        {"steel": {"E": 210.0e9, "nu": 0.3, "alpha": 2.3e-4, "source": "NAFEMS LE11 via Altair OS-V 0070 / FeenoX"}},
        [{"selection": "plane y = 0", "type": "symmetry", "fixed": ["uy"]},
         {"selection": "plane x = 0", "type": "symmetry", "fixed": ["ux"]},
         {"selection": "plane z = 0", "type": "displacement", "fixed": ["uz"]},
         {"selection": "top face z = 1.79711", "type": "displacement", "fixed": ["uz"]},
         {"selection": "domain", "type": "temperature_load", "expr": "sqrt(x^2 + y^2) + z", "unit": "degC",
          "T_ref": 0.0}],
        {"type": "stationary"},
        [ref("sigma_zz(A)", "sigma_zz_A", "direct stress at A = (1.0, 0, 0) m", -105.0e6, "Pa",
             {"rel": 1.0e-2, "after": "richardson"}, "P", "benchmark", "NAFEMS LE11 via Altair OS-V 0070",
             "help.altair.com/2023/hwsolvers/os/topics/solvers/os/nafems_test_problem_le11_r.htm (R3)")],
        speed(20.0, "R3 s.3.10 browser est. 5-20 s"), NAFEMS_RIGHTS, NOHERO, "nafems-le11",
        reference_results=[{"solver": "FeenoX", "value_MPa": -105.04},
                           {"solver": "advanced-packaging-atlas L5 scikit-fem Q2s finest", "value_MPa": -105.54}],
        missing=["Reference temperature not stated on the public pages (0 C assumed)."],
        assumptions=["Temperature field sqrt(x^2 + y^2) + z (FeenoX, Altair 2023, CAST3M); the Abaqus-page "
                     "rendering (x^2 + y^2) + z is taken as a lost exponent (R3 s.8)."]))

    # ------------------------------------------------------------------ reserve (new IDs)
    C.append(case(
        "SM-21", "Code_Aster SSLV04A: hollow cylinder under internal pressure (plane stress, Lame)",
        ["solid-linear"], "2D",
        {"kind": "analytic", "spec": {"inner_radius": 0.1, "outer_radius": 0.2, "sector_deg": 45,
                                      "points": {"A": "r = a, 0 deg", "E": "r = a, 45 deg", "B": "r = b, 0 deg",
                                                 "D": "r = b, 22.5 deg", "F": "r = b, 45 deg"},
                                      "units_note": "length unit of the Code_Aster mesh, E in MPa"},
         "symmetry": "45 deg sector, normal displacement zero on both cut planes"},
        {"solid": {"E": 200000.0, "nu": 0.3, "source": "Code_Aster astest/sslv04a.comm DEFI_MATERIAU"}},
        [{"selection": "inner surface", "type": "pressure", "value": 60.0, "unit": "MPa"},
         {"selection": ["cut plane 0 deg", "cut plane 45 deg"], "type": "symmetry", "fixed": ["u_normal"]}],
        {"type": "stationary", "settings": {"plane": "stress"}},
        [dref("SM-21", k, k, d, u, {"rel": 1.0e-3, "after": "richardson"}, "Lame (Code_Aster REFERENCE='ANALYTIQUE')",
              GS + "::sm21")
         for k, d, u in [("DX_A", "radial displacement at A", "length"), ("DX_B", "radial displacement at B", "length"),
                         ("DX_D", "u_x at D", "length"), ("DY_D", "u_y at D", "length"),
                         ("DX_F", "u_x at F", "length"), ("SIXX_A", "sigma_rr at A", "MPa"),
                         ("SIYY_A", "sigma_tt at A", "MPa")]],
        speed(2.0, "by analogy with R3 SM-02 < 2 s"),
        {"source_license": "Code_Aster astest files GPL-3.0-or-later (EDF); V-docs GNU FDL not used",
         "allowed": ["cite_values", "re_derive_setup", "copy_with_attribution"], "forbidden": ["copy_v_doc_text"]},
        NOHERO, "lame-cylinder",
        reference_results=[{"solver": "Code_Aster sslv04a VALE_CALC (3D PENTA6/HEXA8)", "DX_A": 5.89502757871e-05,
                            "DX_B": 3.99591545793e-05, "SIXX_A": -59.2225501361, "SIYY_A": 100.415918124}],
        missing=["Mesh geometry (radii, sector angle) is in the MED mesh, not in the .comm; thickness N/A."],
        assumptions=["Radii a = 0.1, b = 0.2 inferred from the test's own ANALYTIQUE values (unique: b/a = 2 from "
                     "u(a)/u(b) = 5.9/4.0, then a from u(b) = 4.0e-5); sector 45 deg inferred from points E, F at "
                     "45 deg and D at 22.5 deg (DX = DY at E and F)."],
        extra={"source_case": {"suite": "Code_Aster astest", "file": "astest/sslv04a.comm",
                               "url": "gitlab.com/codeaster/src/-/raw/main/astest/sslv04a.comm", "accessed": ACC}}))

    C.append(case(
        "SM-22", "NAFEMS LE10: thick elliptic plate under uniform pressure", ["solid-linear"], "3D",
        {"kind": "step_ref", "spec": {"planform": "as SM-02 (inner ellipse 2.0 x 1.0 m, outer 3.25 x 2.75 m)",
                                      "z_range_m": [-0.3, 0.3], "point_D_m": [2.0, 0.0, 0.3],
                                      "cad": "FeenoX examples/nafems-le10.step (GPL-3.0-or-later)"},
         "symmetry": "quarter (x = 0, y = 0)",
         "source": "FeenoX nafems-le10.fee/.step via advanced-packaging-atlas validation/cases/B/nafems-LE10.yaml"},
        {"steel": {"E": 210.0e9, "nu": 0.3, "source": "NAFEMS LE10 via FeenoX (E = 210e3 MPa)"}},
        [{"selection": "upper face z = +0.3", "type": "pressure", "value": 1.0e6},
         {"selection": "face y = 0 (DCD'C')", "type": "symmetry", "fixed": ["uy"]},
         {"selection": "face x = 0 (ABA'B')", "type": "symmetry", "fixed": ["ux"]},
         {"selection": "outer curved face (BCB'C')", "type": "displacement", "fixed": ["ux", "uy"]},
         {"selection": "mid-plane line of the outer face (EE')", "type": "displacement", "fixed": ["uz"]}],
        {"type": "stationary"},
        [ref("sigma_yy(D)", "sigma_yy_D", "direct stress at D = (2.0, 0, 0.3) m", -5.38e6, "Pa",
             {"rel": 1.0e-2, "after": "richardson"}, "P", "benchmark",
             "NAFEMS TNSB Rev. 3 LE10 via Altair OS-V 0060 (target 5.38 MPa, compressive)",
             "2021.help.altair.com/2021/hwsolvers/os/topics/solvers/os/nafems_test_problem_le10_r.htm (versioned "
             "copy of the page fetched unversioned on 2026-11-06; the page normalizes its results by a 5.38 MPa "
             "target); sign from FeenoX -5.37968 MPa")],
        speed(20.0, "by analogy with R3 CP-02 5-20 s"), NAFEMS_RIGHTS, NOHERO, "nafems-le10",
        reference_results=[{"solver": "FeenoX", "value_MPa": -5.37968},
                           {"solver": "advanced-packaging-atlas L5 scikit-fem P2 tets", "value_MPa": -5.3847}],
        assumptions=["Sign per FeenoX (compressive at the loaded face); Altair states the magnitude only.",
                     "Altair's page cites 'NAFEMS R0015 - Selected benchmarks for natural frequency analysis' as its "
                     "reference, which is a citation slip (LE10 is in TNSB); the value matches TNSB as quoted by "
                     "Abaqus (via advanced-packaging-atlas) and FeenoX."]))

    C.append(case(
        "CP-21", "NAFEMS T1: plane-stress membrane with a circular hot spot", ["solid-thermal-stress"], "2D",
        {"kind": "analytic", "spec": {"quarter_membrane": [10.0, 10.0], "hot_spot_radius": 1.0, "point_D": [1.0, 0.0],
                                      "units_note": "length unit cancels for plane-stress stresses"},
         "symmetry": "quarter (x = 0, y = 0)",
         "source": "Abaqus deck nt1xxf8x.inp via advanced-packaging-atlas validation/cases/B/nafems-T1.yaml "
                   "(abaqus-docs.mit.edu now 410 Gone)"},
        {"hot_spot": {"E": 100.0e9, "nu": 0.3, "alpha": 1.0e-5, "source": "Altair OS-V 0100 (NAFEMS T1)"},
         "membrane": {"E": 100.0e9, "nu": 0.3, "alpha": 0.0, "source": "Altair OS-V 0100"}},
        [{"selection": "x = 0", "type": "symmetry", "fixed": ["ux"]},
         {"selection": "y = 0", "type": "symmetry", "fixed": ["uy"]},
         {"selection": "outer edges", "type": "free"},
         {"selection": "hot spot", "type": "temperature_load", "value": 100.0, "unit": "degC", "T_ref": 0.0}],
        {"type": "stationary", "settings": {"plane": "stress"}},
        [ref("sigma_yy(D)", "sigma_yy_D", "direct stress at D = (1, 0), just outside the hot spot", 50.0e6, "Pa",
             {"rel": 1.5e-2, "after": "richardson"}, "P", "benchmark", "NAFEMS TNSB Rev. 3 T1 via Altair OS-V 0100",
             "2021.help.altair.com/2021/hwsolvers/os/topics/solvers/os/nafems_test_problem_t1_r.htm (fetched "
             "2026-11-06)",
             note="1.5 % band: the target equals the infinite-plate value; the finite quarter lies between the "
                  "infinite (50.0 MPa) and free-disk (50.5 MPa) bounds"),
         dref("CP-21", "sigma_yy_D_infinite", "sigma_yy(D), infinite plate", "E e*/2", "Pa", {"rel": 1.5e-2},
              "Eshelby-type circular inclusion, plane stress", GS + "::cp21", gate=False,
              bounds=[ev("CP-21", "sigma_yy_D_infinite"), ev("CP-21", "sigma_yy_D_free_disk_R10")])],
        speed(2.0, "by analogy with R3 SM-02 < 2 s"), NAFEMS_RIGHTS, NOHERO, "nafems-t1",
        reference_results=[{"solver": "advanced-packaging-atlas L5 scikit-fem P2 Richardson", "value_MPa": 50.4475}],
        missing=["Hot-spot radius 1.0: from the Abaqus deck via advanced-packaging-atlas; no live public page "
                 "states it (Altair OS-V 0100 omits geometry).",
                 "Membrane geometry from the Abaqus deck, now unreachable at its MIT URL; no live public page "
                 "states the 10 x 10 quarter size (Altair page omits geometry)."]))
    return C


# Fields owned downstream (lane I1 hero integration, L2 specs): once present in the existing YAML they are kept
# verbatim and never regenerated. References are matched by position; the quantity must agree or the build stops.
PRESERVE_TOP = ["spec"]
PRESERVE_CONVERGENCE = ["h_factors", "expected_order"]
PRESERVE_REFERENCE = ["extract", "metric_id", "spec"]  # references[].spec: per-target model (I1)


def merge_preserved(new: dict[str, Any], old: dict[str, Any]) -> list[str]:
    """Copy downstream-owned fields from `old` (existing YAML) into `new` (builder output). Returns kept paths."""
    kept: list[str] = []
    for k in PRESERVE_TOP:
        if k in old and old[k] != new.get(k):
            new[k] = old[k]
            kept.append(k)
    oc, nc = old.get("convergence") or {}, new.get("convergence")
    for k in PRESERVE_CONVERGENCE:
        if k in oc:
            if nc is None:
                nc = new["convergence"] = {}
            if nc.get(k) != oc[k]:
                nc[k] = oc[k]
                kept.append(f"convergence.{k}")
    orefs, nrefs = old.get("references") or [], new.get("references") or []
    if orefs and len(orefs) != len(nrefs):
        raise SystemExit(f"{new['id']}: existing YAML has {len(orefs)} references, builder {len(nrefs)}; "
                         "reconcile by hand before rebuilding (preserved fields are matched by position)")
    for i, (o, n) in enumerate(zip(orefs, nrefs, strict=False)):
        if o.get("quantity") != n.get("quantity"):
            raise SystemExit(f"{new['id']}: references[{i}] quantity {o.get('quantity')!r} != {n.get('quantity')!r}")
        for k in PRESERVE_REFERENCE:
            if k in o and o[k] != n.get(k):
                n[k] = o[k]
                kept.append(f"references.{i}.{k}")
    return kept


class _NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="overwrite existing case files")
    ap.add_argument("--out", help="write into this directory instead of eval/cases/a (for diffs and tests)")
    ap.add_argument("--preserve-from", help="directory of existing YAML to merge preserved fields from "
                                            "(default eval/cases/a)")
    a = ap.parse_args()
    out_dir = Path(a.out) if a.out else CASES_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    n_w, n_s, n_u, n_kept = 0, 0, 0, 0
    for c in build():
        path = out_dir / f"{c['id']}.yaml"
        src = (Path(a.preserve_from) if a.preserve_from else CASES_DIR) / f"{c['id']}.yaml"
        kept = merge_preserved(c, yaml.safe_load(src.read_text())) if src.exists() else []
        n_kept += len(kept)
        head = (f"# {c['id']}: {c['title']}\n# Built by validation/a/build_cases.py from eval/expected/{c['id']}.json "
                f"where basis is D. Schema amp-eval/0 ({R3} s.2).\n")
        text = head + yaml.dump(c, Dumper=_NoAliasDumper, sort_keys=False, width=118, allow_unicode=False,
                                default_flow_style=None)
        if path.exists():
            if yaml.safe_load(path.read_text()) == c:
                n_u += 1  # semantically identical: keep the file byte for byte (hand formatting survives)
                continue
            if not a.force:
                print(f"skip (exists, differs; use --force): {path.name}")
                n_s += 1
                continue
        path.write_text(text)
        n_w += 1
    print(f"cases: wrote {n_w}, unchanged {n_u}, skipped {n_s}, preserved downstream fields: {n_kept}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
