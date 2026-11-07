# SPDX-License-Identifier: GPL-3.0-or-later
"""Write eval/cases/c/<ID>.yaml (amp-eval/0) for class c (lane L7c, DevLog-008).

Values of regenerable targets are read from eval/expected/<ID>.json (written by gen_palace.py,
gen_suites.py, gen_devsim.py); cited values are typed here with their locator. Every case was checked
against its primary source on 2026-11-06 (pages kept in cache/eval-c/sources/, gitignored).

Run: cd validation && uv run python c/build_cases.py [--force]
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "eval" / "cases" / "c"
EXP = ROOT / "eval" / "expected"
SRC = ROOT / "cache" / "eval-c" / "sources"
ACC = "2026-11-06"

PALACE = "github.com/awslabs/palace tag v0.19.0 (ca9a6a2d1e64a410229c3d7538507e5eae975cc6)"
MPB = "github.com/NanoComp/mpb tag v1.12.0"
MEEP = "github.com/NanoComp/meep tag v1.35.1"
ASTER = "gitlab.com/codeaster/src tag 17.5.8 (c1f5c46ef795e0bf6d82a29dc20da30d281535ce)"
DEALII = "github.com/dealii/dealii tag v9.8.0"
SKFEM = "github.com/kinnala/scikit-fem tag 12.0.2"
TMR = "tmbwg.github.io/turbmodels (repo TMBWG/turbmodels main 20a39f549dbff988a6accc421ac84dafc4487695)"
FEAT = "wwwold.mathematik.tu-dortmund.de/~featflow/en/benchmarks/cfdbenchmarking/fsi_benchmark/fsi_tests/fsi_cfd_tests.html"
EO = "eo-modulator-atlas (sibling repo, read-only; HEAD 0546007 on 2026-11-06)"
DEVSIM = "github.com/devsim/devsim main e3a25f08c7f17cc6932624c12bf9f0f10d7f7cfd"
HFW = "huggingface.co/datasets/polymathic-ai"
DARUS = "darus.uni-stuttgart.de doi:10.18419/darus-2986 (dataset version 8.0, released 2024-02-13)"
PDEB_PAPER = "Takamoto et al., PDEBench, NeurIPS 2022 Datasets and Benchmarks, arXiv:2210.07182v7 (2024-08-26)"
WELL_PAPER = "Ohana et al., The Well, NeurIPS 2024 Datasets and Benchmarks, arXiv:2412.00568"
PENDING = {"status": "pending", "reason": "amp-spec/0 models not yet published by lane L2; sims/ id is a proposal"}
CONV = {"levels_min": 3, "ratio_min": 1.5, "method": "richardson_gci", "safety_factor": 1.25}
CONV_DS = {
    "method": "none",
    "note": "dataset case: report own self-convergence floor (two finest levels) next to the dataset metric (R3 s.4)",
}
NO_HERO = {"suitable": False, "why": "verification case, not a demo"}


def sha(rel: str) -> str:
    p = SRC / rel
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else "N/A (not cached)"


def src_case(suite: str, file: str, url: str, cache: str | None = None, note: str = "") -> dict[str, Any]:
    n = note
    if cache:
        n = (n + "; " if n else "") + f"cache/eval-c/sources/{cache} sha256 {sha(cache)}"
    d = {"suite": suite, "file": file, "url": url, "accessed": ACC}
    if n:
        d["note"] = n
    return d


def exp_val(case: str, mid: str) -> float:
    d = json.loads((EXP / f"{case}.json").read_text())
    for t in d["targets"]:
        if t["metric_id"] == mid:
            return t["value"]
    raise KeyError(f"{case}:{mid}")


def ref(
    q: str,
    value: Any,
    unit: str,
    tol: dict,
    basis: str,
    form: str,
    citation: str,
    locator: str,
    *,
    case: str | None = None,
    mid: str | None = None,
    gate: bool = True,
    definition: str | None = None,
    note: str | None = None,
    bounds: list | None = None,
    extraction: str | None = None,
    url: str | None = None,
    extract: dict | None = None,
) -> dict[str, Any]:
    r: dict[str, Any] = {"quantity": q}
    if mid:
        r["metric_id"] = mid
    if definition:
        r["definition"] = definition
    if case and mid:
        value = exp_val(case, mid)
    r.update(
        {"value": value, "unit": unit, "tolerance": tol, "bounds": bounds, "basis": basis, "form": form, "gate": gate}
    )
    prov: dict[str, Any] = {"citation": citation, "locator": locator, "accessed": None if basis == "D" else ACC}
    if url:
        prov["url"] = url
    if case and mid:
        gen = json.loads((EXP / f"{case}.json").read_text())["generator"]
        prov["generator"] = gen
        r["expected"] = {"file": f"eval/expected/{case}.json", "metric_id": mid}
    r["provenance"] = prov
    if extraction:
        r["extraction"] = extraction
    if extract:
        r["extract"] = extract
    if note:
        r["note"] = note
    return r


def rights(
    lic: str, allowed=("cite_values", "re_derive_setup"), forbidden=("copy_text", "copy_figures", "copy_input_files")
) -> dict:
    return {"source_license": lic, "allowed": list(allowed), "forbidden": list(forbidden)}


def speed(browser: float | None, basis: str, report=("dofs", "wall_s_by_stage", "iterations", "error_vs_ref")):
    return {
        "budget_s": {"browser": browser, "native": None},
        "budget_basis": basis,
        "report": list(report),
        "reference_timings": [],
    }


def case(
    cid: str,
    title: str,
    physics: list,
    dim: Any,
    refs: list,
    rts: dict,
    *,
    status="unvalidated",
    geometry=None,
    materials=None,
    bcs=None,
    initial=None,
    study=None,
    reference_results=None,
    conv=CONV,
    spd=None,
    dataset=None,
    hero=NO_HERO,
    missing=None,
    assumptions=None,
    source_case=None,
    notes=None,
    sim: str | None = None,
    untestable_reason=None,
    activation=None,
    field_reference=None,
) -> dict:
    d: dict[str, Any] = {
        "schema": "amp-eval/0",
        "id": cid,
        "class": "c",
        "title": title,
        "status": status,
        "untestable_reason": untestable_reason,
    }
    if activation:
        d["activation"] = activation
    d.update(
        {
            "physics": physics,
            "dimension": dim,
            "units": "SI",
            "geometry": geometry,
            "materials": materials,
            "bcs": bcs,
            "initial": initial,
            "study": study,
            "references": refs,
            "reference_results": reference_results or [],
            "convergence": conv,
            "speed": spd or speed(None, "not estimated; set after the first timing run (R3 O3)"),
            "dataset": dataset,
            "rights": rts,
            "hero": hero,
            "spec": dict(PENDING, ref=f"sims/{sim}.yaml") if sim else PENDING,
            "missing": missing or [],
            "assumptions": assumptions or [],
        }
    )
    if source_case:
        d["source_case"] = source_case
    if field_reference:
        d["field_reference"] = field_reference
    if notes:
        d["notes"] = notes
    d["lane"] = "L7c"
    d["created"] = ACC
    return d


R4 = {"rel": 1e-4, "after": "richardson"}
R5 = {"rel": 1e-5, "after": "richardson"}
R3_ = {"rel": 1e-3, "after": "richardson"}


def all_cases() -> list[dict]:
    cs: list[dict] = []
    ap2 = "Apache-2.0 (Palace code and docs)"

    # ---------------- Palace (Apache-2.0) ----------------
    loc = "palace docs/src/examples/spheres.md"
    cs.append(
        case(
            "EM-02",
            "Palace spheres: Maxwell capacitance matrix of two conducting spheres in vacuum (Lekner series)",
            ["electrostatics"],
            ["2D-axisym", "3D"],
            [
                ref(
                    q,
                    None,
                    "F",
                    R4,
                    "D",
                    "closed_form",
                    "Lekner, J. Electrostat. 69 (2011) 11-14, series as in Palace docs",
                    f"{loc} L27-40 (series), L74-80 (values)",
                    case="EM-02",
                    mid=q,
                )
                for q in ("C_aa", "C_bb", "C_ab")
            ],
            rights(ap2, ("cite_values", "re_derive_setup", "copy_with_attribution")),
            geometry={
                "kind": "analytic",
                "spec": {
                    "sphere_a": {"radius_m": 0.01, "center_m": [0, 0, 0]},
                    "sphere_b": {"radius_m": 0.02, "center_m": [0.05, 0, 0]},
                },
                "symmetry": "axisymmetric about the centre line",
                "note": "outer ground boundary 'sufficiently far' (spheres.md L60-62): truncation radius is a solver choice",
            },
            materials={"vacuum": {"eps_r": 1.0, "source": "spheres.md L22-23"}},
            bcs=[
                {"selection": "sphere_a", "type": "terminal"},
                {"selection": "sphere_b", "type": "terminal"},
                {"selection": "outer", "type": "ground"},
            ],
            study={"type": "stationary"},
            reference_results=[
                {
                    "solver": "Palace v0.19.0 regression gold (coarse CI mesh, order 3)",
                    "C_aa_F": 1.237445610357e-12,
                    "C_bb_F": 2.478413459856e-12,
                    "C_ab_F": -4.770975738888e-13,
                    "locator": "test/data/regression/ref/spheres/terminal-C.csv",
                }
            ],
            spd=speed(2.0, "R3 s.3.3 browser est. < 2 s; est., not measured"),
            source_case=src_case("Palace examples", "docs/src/examples/spheres.md", f"{PALACE}", "palace/spheres.md"),
            sim="two-spheres",
        )
    )

    loc = "palace docs/src/examples/rings.md"
    cs.append(
        case(
            "EM-03",
            "Palace rings: inductance matrix of two coplanar concentric current rings",
            ["magnetostatics"],
            ["2D-axisym", "3D"],
            [
                ref(
                    "M_ab",
                    None,
                    "H",
                    {
                        "rel": 2e-2,
                        "after": "richardson",
                        "note": "formula is the r_a << r_b, w = 0 limit; the exact filament-loop value differs "
                        "(see expected JSON); tolerance sized to that model error (assumption)",
                    },
                    "D",
                    "closed_form",
                    "Biot-Savart small-loop limit, Palace docs",
                    f"{loc} L28-30, L73-75",
                    case="EM-03",
                    mid="M_ab",
                ),
                ref(
                    "L_aa",
                    None,
                    "H",
                    {
                        "rel": 3e-2,
                        "after": "richardson",
                        "note": "thin-ring approximation; Palace itself "
                        "reports percent-level differences (rings.md L86-87)",
                    },
                    "D",
                    "closed_form",
                    "thin-ring self inductance, Palace docs ref. [1]",
                    f"{loc} L35-39, L79-83",
                    case="EM-03",
                    mid="L_aa",
                ),
                ref(
                    "L_bb",
                    None,
                    "H",
                    {"rel": 3e-2, "after": "richardson", "note": "as L_aa"},
                    "D",
                    "closed_form",
                    "thin-ring self inductance, Palace docs ref. [1]",
                    f"{loc} L35-39, L79-83",
                    case="EM-03",
                    mid="L_bb",
                ),
            ],
            rights(ap2, ("cite_values", "re_derive_setup", "copy_with_attribution")),
            geometry={
                "kind": "analytic",
                "spec": {
                    "ring_a": {"radius_m": 10e-6, "width_m": 1e-6},
                    "ring_b": {"radius_m": 100e-6, "width_m": 1e-6},
                    "coplanar": True,
                    "concentric": True,
                },
            },
            materials={"vacuum": {"mu_r": 1.0, "source": "rings.md L24-25"}},
            bcs=[
                {"selection": "ring_a", "type": "surface_current"},
                {"selection": "ring_b", "type": "surface_current"},
                {"selection": "farfield", "type": "pec_magnetic_insulation"},
            ],
            study={"type": "stationary"},
            reference_results=[
                {
                    "solver": "Palace v0.19.0 regression gold (coarse CI mesh)",
                    "M_11_H": 4.271797046795e-11,
                    "M_12_H": 1.960101643863e-12,
                    "M_22_H": 7.139527404879e-10,
                    "locator": "test/data/regression/ref/rings/terminal-M.csv",
                }
            ],
            assumptions=[
                "rings.md L29 prints M_ab = mu0 pi r_b^2 / (2 r_a); the printed 1.973921 pH equals mu0 pi r_a^2 / (2 r_b), "
                "used here (docs typo)."
            ],
            spd=speed(2.0, "R3 s.3.3 browser est. < 2 s; est."),
            source_case=src_case("Palace examples", "docs/src/examples/rings.md", PALACE, "palace/rings.md"),
            sim="coplanar-rings",
        )
    )

    loc = "palace docs/src/examples/cylinder.md"
    cs.append(
        case(
            "RF-01",
            "Palace cylinder: Teflon-filled cylindrical cavity, modes, dielectric and copper-wall Q",
            ["rf-resonator"],
            ["2D-axisym", "3D"],
            [
                ref(
                    "f TM010",
                    None,
                    "Hz",
                    R5,
                    "D",
                    "closed_form",
                    "Pozar via Palace docs",
                    f"{loc} L31-44, L115",
                    case="RF-01",
                    mid="f_TM010",
                    note="exact; Palace's table entry 2.903605 GHz uses a rounded Bessel zero (L7a RF-21 "
                    "resolution); equals RF-21",
                ),
                ref(
                    "f TE111",
                    None,
                    "Hz",
                    R5,
                    "D",
                    "closed_form",
                    "Pozar via Palace docs",
                    f"{loc} L119",
                    case="RF-01",
                    mid="f_TE111",
                ),
                ref(
                    "f TE011",
                    None,
                    "Hz",
                    R5,
                    "D",
                    "closed_form",
                    "Pozar via Palace docs",
                    f"{loc} L118",
                    case="RF-01",
                    mid="f_TE011",
                    note="degenerate with TM111",
                ),
                ref(
                    "Q_c TE011 (R_s 0.0184 Ohm)",
                    None,
                    "1",
                    {"rel": 1e-2, "after": "richardson"},
                    "D",
                    "closed_form",
                    "Pozar Ex. 6.4 formula as printed in Palace docs",
                    f"{loc} L53-65, L150-159",
                    case="RF-01",
                    mid="Q_c_TE011",
                ),
                ref(
                    "Q TE011 copper walls",
                    None,
                    "1",
                    {"rel": 1e-2, "after": "richardson"},
                    "D",
                    "closed_form",
                    "1/Q = 1/Q_c + 1/Q_d",
                    f"{loc} L150-156",
                    case="RF-01",
                    mid="Q_TE011_copper",
                ),
                ref(
                    "Q_d",
                    None,
                    "1",
                    {"rel": 1e-3},
                    "D",
                    "closed_form",
                    "1/tan delta",
                    f"{loc} L50, L135",
                    case="RF-01",
                    mid="Q_d",
                ),
            ],
            rights(ap2, ("cite_values", "re_derive_setup", "copy_with_attribution")),
            geometry={"kind": "analytic", "spec": {"radius_m": 0.0274, "height_m": 0.0548}, "symmetry": "axisymmetric"},
            materials={
                "teflon": {"eps_r": 2.08, "tan_delta": 4e-4, "source": "cylinder.md L26-27"},
                "copper_walls": {"R_s_ohm": 0.0184, "source": "cylinder.md L100-101 (copper at 5 GHz)"},
            },
            bcs=[
                {"selection": "walls", "type": "pec"},
                {
                    "selection": "walls",
                    "type": "surface_impedance",
                    "params": {"R_s_ohm": 0.0184},
                    "note": "second configuration (cavity_impedance.json)",
                },
            ],
            study={"type": "eigen", "n": 15, "shift": 2.0e9},
            reference_results=[
                {
                    "solver": "Palace v0.19.0 regression gold cavity_pec (coarse CI mesh)",
                    "f_GHz_first4": [2.904769618774, 2.922855211084, 2.922855211091, 3.469124240109],
                    "locator": "test/data/regression/ref/cylinder/cavity_pec/eig.csv rows 1-4",
                },
                {
                    "source": "Palace docs analytic table (rounded Bessel zeros)",
                    "f_TM010_GHz": 2.903605,
                    "f_TE111_GHz": 2.922212,
                    "locator": f"{loc} L113-123",
                },
            ],
            hero={
                "suitable": True,
                "why": "animated E/H of cavity modes; R3 hero RF-01",
                "visual": ["E_field", "H_field"],
            },
            spd=speed(2.0, "R3 s.3.4: 2D-axisym < 2 s, 3D 5-30 s; est."),
            source_case=src_case("Palace examples", "docs/src/examples/cylinder.md", PALACE, "palace/cylinder.md"),
            sim="cylinder-cavity",
        )
    )

    cs.append(
        case(
            "RF-03",
            "Palace CPW: coplanar waveguide on 500 um C-axis sapphire, characteristic impedance",
            ["rf-waveguide"],
            "2D",
            [
                ref(
                    "Z0",
                    56.02,
                    "ohm",
                    {
                        "rel": 1e-2,
                        "after": "richardson",
                        "note": "source gives 4 digits and a handbook "
                        "formula (Visser 2012); tolerance proposed (assumption)",
                    },
                    "P",
                    "solver_ref",
                    "Palace docs, citing H. J. Visser, Antenna Theory and Applications, Wiley 2012",
                    "palace docs/src/examples/cpw.md L18-25",
                    extraction="text",
                )
            ],
            rights(ap2),
            geometry={
                "kind": "layer_stack",
                "spec": {
                    "trace_w_m": 30e-6,
                    "gap_s_m": 18e-6,
                    "substrate_t_m": 500e-6,
                    "metal": "infinitely thin PEC",
                    "pair_pitch_m": 266e-6,
                },
            },
            materials={
                "sapphire": {
                    "eps_r_parallel_c": 11.5,
                    "tan_delta_parallel_c": 8.6e-5,
                    "eps_r_perp_c": 9.3,
                    "tan_delta_perp_c": 3.0e-5,
                    "c_axis": "z",
                    "source": "cpw.md L20-24",
                }
            },
            study={"type": "frequency", "f_list": "2D port mode at the 3D model's frequencies (cpw.md); quasi-TEM Z0"},
            missing=[
                "Visser's exact formula for anisotropic sapphire is not stated in the docs; ground width and "
                "enclosure of the 2D cross-section N/A"
            ],
            source_case=src_case("Palace examples", "docs/src/examples/cpw.md", PALACE, "palace/cpw.md"),
            sim="cpw-sapphire",
        )
    )

    loc = "palace docs/src/examples/coaxial.md"
    cs.append(
        case(
            "EM-61",
            "Palace coaxial: micro-coax inductance with superconducting (London) films",
            ["magnetostatics"],
            ["2D-axisym", "3D"],
            [
                ref(
                    "L_geom",
                    None,
                    "H",
                    R4,
                    "D",
                    "closed_form",
                    "coax geometric inductance",
                    f"{loc} L166-170, L180",
                    case="EM-61",
                    mid="L_geom",
                ),
                ref(
                    "L_total (lambda 0.4 um, d 0.1 um)",
                    None,
                    "H",
                    R4,
                    "D",
                    "closed_form",
                    "Swihart 1961 / Van Duzer-Turner flat-film sheet inductance via Palace docs",
                    f"{loc} L152-170, L181",
                    case="EM-61",
                    mid="L_total_london",
                ),
                ref("L_kin", None, "H", R4, "D", "closed_form", "as above", f"{loc} L182", case="EM-61", mid="L_kin"),
            ],
            rights(ap2, ("cite_values", "re_derive_setup", "copy_with_attribution")),
            geometry={
                "kind": "analytic",
                "spec": {
                    "a_m": 0.81915e-6,
                    "b_m": 2.7305e-6,
                    "length_m": 40e-6,
                    "note": "RG-401/U diameters 0.0645 / 0.215 in read in um (L0 = 1e-6)",
                },
            },
            materials={"films": {"london_depth_m": 0.4e-6, "thickness_m": 0.1e-6, "source": "coaxial.md L133-137"}},
            bcs=[
                {"selection": "far_end", "type": "pec_short"},
                {"selection": "near_end", "type": "surface_current", "params": {"direction": "+R", "I_A": 1.0}},
                {"selection": ["inner", "outer"], "type": "superconductor"},
            ],
            study={"type": "stationary"},
            reference_results=[
                {
                    "solver": "Palace (256 hex elements, order 3)",
                    "L_geom_pH": 9.6234,
                    "L_total_pH": 30.3591,
                    "L_kin_pH": 20.7357,
                    "locator": f"{loc} L178-182",
                }
            ],
            notes=["The expected JSON also holds the lambda sweep 0.025-1.6 um of coaxial.md L223-231 (all agree)."],
            spd=speed(2.0, "axisym magnetostatics, by analogy with EM-03; est."),
            source_case=src_case("Palace examples", "docs/src/examples/coaxial.md", PALACE, "palace/coaxial.md"),
            sim="micro-coax-london",
        )
    )

    cs.append(
        case(
            "RF-61",
            "Palace coaxial: RG-401/U section with a 100 Ohm lumped port, reflection magnitude",
            ["rf-sparams"],
            ["2D-axisym", "3D"],
            [
                ref(
                    "|S11|",
                    None,
                    "1",
                    {"rel": 2e-3, "after": "richardson"},
                    "D",
                    "closed_form",
                    "quasi-TEM coax impedance with lossy dielectric",
                    f"{loc} L19-23, L99-116",
                    case="RF-61",
                    mid="abs_S11_lumped100",
                    note="Palace docs state |Gamma| = 1/3 for a 50 Ohm line; the line is 50.05 Ohm "
                    "with tan d 4e-2, giving 0.33318",
                ),
                ref(
                    "Z0 (lossless)",
                    None,
                    "ohm",
                    {"rel": 1e-3, "after": "richardson"},
                    "D",
                    "closed_form",
                    "eta0 ln(b/a) / (2 pi sqrt(eps_r))",
                    f"{loc} L19-21",
                    case="RF-61",
                    mid="Z0_lossless",
                    gate=False,
                ),
            ],
            rights(ap2, ("cite_values", "re_derive_setup", "copy_with_attribution")),
            geometry={
                "kind": "analytic",
                "spec": {"d_inner_m": 0.0645 * 0.0254, "d_outer_m": 0.215 * 0.0254, "length_m": 0.040},
            },
            materials={
                "teflon_lossy": {"eps_r": 2.08, "tan_delta": 4e-2, "source": "coaxial.md L21-24 (100x real tan d)"}
            },
            bcs=[
                {"selection": "z0", "type": "lumped_port", "params": {"R_ohm": 100.0}},
                {"selection": "zL", "type": "wave_port"},
            ],
            study={"type": "frequency", "f_list": [5e9, 15e9]},
            spd=speed(10.0, "3D driven sweep; est."),
            source_case=src_case("Palace examples", "docs/src/examples/coaxial.md", PALACE, "palace/coaxial.md"),
            sim="coax-lumped-wave",
        )
    )

    # ---------------- Ansys VM pointers (textbook targets re-derived) ----------------
    ansys = "Ansys MAPDL Verification Manual page, (c) ANSYS Inc. all rights reserved; target cites the textbook/report"
    vmloc = "ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM{}.html, Results Comparison table"
    cs.append(
        case(
            "EM-05",
            "Hollow aluminium cylinder in a uniform 60 Hz transverse field (eddy currents)",
            ["eddy", "currents"],
            "2D",
            [
                ref(
                    "By(0,0) real",
                    None,
                    "T",
                    {"rel": 2e-3, "after": "richardson"},
                    "D",
                    "closed_form",
                    "exact 2D Bessel solution (this lane); target Emson RAL-86-049 p. 39 via Ansys VM166",
                    vmloc.format(166),
                    case="EM-05",
                    mid="By_center_re",
                    note="phasor e^{+j w t}",
                ),
                ref(
                    "By(0,0) imag",
                    None,
                    "T",
                    {"rel": 2e-3, "after": "richardson"},
                    "D",
                    "closed_form",
                    "as above",
                    vmloc.format(166),
                    case="EM-05",
                    mid="By_center_im",
                ),
                ref(
                    "loss per length, full section",
                    None,
                    "W/m",
                    {"rel": 2e-3, "after": "richardson"},
                    "D",
                    "closed_form",
                    "as above",
                    vmloc.format(166),
                    case="EM-05",
                    mid="loss_per_length",
                ),
                ref(
                    "VM166 target loss (quarter section, inferred)",
                    2288,
                    "W/m",
                    {"rel": 1e-3},
                    "P",
                    "benchmark",
                    "Emson 1986 via Ansys VM166",
                    vmloc.format(166),
                    gate=False,
                    extraction="text",
                    note="equals full-section loss / 4 to 2.3e-5; read as a quarter-symmetry value (assumption)",
                ),
            ],
            rights(ansys + "; formula textbook", ("cite_values",), ("copy_text", "copy_figures", "copy_input_files")),
            geometry={
                "kind": "analytic",
                "spec": {"r_inner_m": 0.05715, "r_outer_m": 0.06985, "external_boundary_m": 0.84},
            },
            materials={"aluminium": {"sigma_S_per_m": 2.5380711e7, "mu_r": 1.0, "source": "Ansys VM166 inputs"}},
            bcs=[
                {
                    "selection": "external",
                    "type": "applied_field",
                    "params": {"B0_T": 0.1, "direction": "y", "f_Hz": 60.0},
                }
            ],
            study={"type": "frequency", "f_list": [60.0]},
            reference_results=[
                {"solver": "Ansys PLANE233", "By_T": "-0.0018 - j0.0212", "loss_W_per_m": 2315.2128},
                {"solver": "Ansys PLANE13", "By_T": "-0.0019 - j0.02140", "loss_W_per_m": 2341.3041},
            ],
            assumptions=[
                "B0 = 0.1 T is the peak of B_y = B0 cos(w t); the VM166 page writes 'omega = 60 Hz', read as f = 60 Hz.",
                "The 0.84 m external boundary is replaced by the exact far-field condition in the generator.",
            ],
            spd=speed(2.0, "R3 s.3.3 est."),
            source_case=src_case("Ansys VM166 (pointer)", "Hlp_V_VM166.html", vmloc.format(166).split(",")[0]),
            sim="eddy-hollow-cylinder",
        )
    )

    cs.append(
        case(
            "CP-03",
            "Wire with uniform heat generation and surface convection (Rohsenow-Choi ex. 6.5)",
            ["heat-cond", "heat-conv"],
            ["1D-axisym", "2D-axisym"],
            [
                ref(
                    "T_center",
                    None,
                    "K",
                    R4,
                    "D",
                    "closed_form",
                    "closed form; target Rohsenow-Choi 1963 p. 106 ex. 6.5 via VM58",
                    vmloc.format(58),
                    case="CP-03",
                    mid="T_center",
                ),
                ref(
                    "T_surface",
                    None,
                    "K",
                    R4,
                    "D",
                    "closed_form",
                    "as above",
                    vmloc.format(58),
                    case="CP-03",
                    mid="T_surface",
                ),
                ref(
                    "q per 1 ft",
                    None,
                    "W",
                    R4,
                    "D",
                    "closed_form",
                    "as above",
                    vmloc.format(58),
                    case="CP-03",
                    mid="q_per_ft",
                ),
            ],
            rights(ansys + "; formula textbook", ("cite_values",), ("copy_text", "copy_figures", "copy_input_files")),
            geometry={"kind": "analytic", "spec": {"r0_m": 0.009525, "length_m": 0.3048}},
            materials={
                "wire": {
                    "k_W_per_mK": exp_json_input("CP-03", "k_W_per_mK"),
                    "source": "VM58: 13 Btu/hr-ft-F converted",
                }
            },
            bcs=[
                {
                    "selection": "surface",
                    "type": "convection",
                    "params": {
                        "h_W_per_m2K": exp_json_input("CP-03", "h_W_per_m2K"),
                        "T_inf_K": exp_json_input("CP-03", "T_air_K"),
                    },
                },
                {
                    "selection": "domain",
                    "type": "heat_source",
                    "params": {"q_W_per_m3": exp_json_input("CP-03", "q_W_per_m3")},
                },
            ],
            study={"type": "stationary"},
            notes=["Targets in degF on the VM58 page: 419.9 / 417.9 F, 341.5 Btu/hr; this case uses SI."],
            spd=speed(0.5, "R3 est. < 0.5 s"),
            source_case=src_case("Ansys VM58 (pointer)", "Hlp_V_VM58.html", vmloc.format(58).split(",")[0]),
            sim="heated-wire",
        )
    )

    cs.append(
        case(
            "CP-04",
            "Si electrothermal (hot-arm) microactuator at 15 V (Mankame-Ananthasuresh 2001)",
            ["coupled-joule", "coupled-thermoelastic"],
            "3D",
            [
                ref(
                    "tip UY",
                    2.700e-5,
                    "m",
                    {"rel": 2e-2},
                    "P",
                    "paper_sim",
                    "Mankame, Ananthasuresh, JMM 11:252 (2001) via Ansys VM223",
                    vmloc.format(223),
                    extraction="text",
                    note="units not printed on the page; m inferred from magnitude (assumption)",
                )
            ],
            rights(ansys, ("cite_values",)),
            status="untestable",
            untestable_reason="VM223 page gives no convection coefficient, emissivity or ambient temperature, and does not "
            "define d10 (geometry); the primary paper (JMM 11:252) is paywalled",
            activation="source h, emissivity, T_ambient and the full geometry from Mankame-Ananthasuresh 2001",
            geometry={
                "kind": "analytic",
                "spec": {
                    "d_m": {
                        "d1": 40e-6,
                        "d2": 255e-6,
                        "d3": 40e-6,
                        "d4": 330e-6,
                        "d5": 1900e-6,
                        "d6": 90e-6,
                        "d7": 75e-6,
                        "d8": 352e-6,
                        "d9": 352e-6,
                        "d11": 20e-6,
                    }
                },
                "note": "dimension names as on VM223",
            },
            materials={
                "si": {
                    "E_Pa": 169e9,
                    "nu": 0.3,
                    "resistivity_ohm_m_300K": 4.2e-4,
                    "alpha_k_table": "T 300-1500 K, VM223 table (units garbled on the page)",
                    "source": "Ansys VM223",
                }
            },
            missing=["convection h", "emissivity", "ambient temperature", "d10", "alpha and k units"],
            source_case=src_case("Ansys VM223 (pointer)", "Hlp_V_VM223.html", vmloc.format(223).split(",")[0]),
            sim="hot-arm-actuator",
        )
    )

    cs.append(
        case(
            "CP-06",
            "PZT-4 cube 20 mm, short- and open-circuit breathing modes (Boucher et al. 1981)",
            ["coupled-piezo", "solid-modal"],
            "3D",
            [
                ref(
                    f"{lab}",
                    val,
                    "Hz",
                    {"rel": 3e-2, "note": "measured target (Boucher 1981 Table 1); tolerance proposed"},
                    "P",
                    "paper_measured",
                    "Boucher, Lagier, Maerfeld, IEEE SU-28 (1981) 318, Table 1 via Ansys VM175",
                    vmloc.format(175),
                    extraction="text",
                    note="page labels the column kHz; 66560 kHz is implausible for a 20 mm PZT cube, Hz is consistent (flag)",
                )
                for lab, val in [
                    ("f1 short", 66560.0),
                    ("f2 short", 88010.0),
                    ("f1 open", 81590.0),
                    ("f2 open", 93410.0),
                ]
            ],
            rights(ansys, ("cite_values",)),
            status="untestable",
            untestable_reason="PZT-4 stiffness, piezoelectric and permittivity matrices are images on VM175 (not recoverable as "
            "text); target is experimental",
            activation="PZT-4 constants from an open primary source (e.g. Boucher 1981 Table or a materials datasheet with locator)",
            geometry={"kind": "analytic", "spec": {"edge_m": 0.02, "polarization": "z"}},
            materials={"pzt4": {"rho": 7500.0, "source": "Ansys VM175; matrices N/A"}},
            missing=["PZT-4 [c], [e], [eps_r] values"],
            source_case=src_case("Ansys VM175 (pointer)", "Hlp_V_VM175.html", vmloc.format(175).split(",")[0]),
            sim="pzt-cube",
        )
    )

    # ---------------- MPB / Meep (GPL-2.0-or-later) ----------------
    mpbl = "mpb doc/docs/Python_Tutorial.md"
    gpl2 = "GPL-2.0-or-later (MPB / Meep; License_and_Copyright.md)"
    mpb_tol = {
        "rel": 1e-2,
        "after": "richardson",
        "note": "MPB value at resolution 32 with subpixel averaging, not a "
        "converged reference; tolerance proposed (assumption)",
    }
    cs.append(
        case(
            "WO-04",
            "MPB square lattice of dielectric rods (r 0.2a, eps 12): first TM band gap",
            ["optics-phc"],
            "2D-periodic",
            [
                ref(
                    "gap lower edge (band 1 max)",
                    0.282623311147724,
                    "1 (c/a)",
                    mpb_tol,
                    "P",
                    "solver_ref",
                    "MPB Python tutorial",
                    f"{mpbl} L120",
                    extraction="text",
                ),
                ref(
                    "gap upper edge (band 2 min)",
                    0.419334798706834,
                    "1 (c/a)",
                    mpb_tol,
                    "P",
                    "solver_ref",
                    "MPB Python tutorial",
                    f"{mpbl} L120",
                    extraction="text",
                ),
            ],
            rights(gpl2),
            geometry={"kind": "analytic", "spec": {"lattice": "square", "a": 1, "rod_radius": 0.2, "unit": "a"}},
            materials={
                "rod": {"eps_r": 12.0, "source": f"{mpbl} L69"},
                "background": {"eps_r": 1.0, "source": "default air"},
            },
            study={"type": "eigen", "n": 8, "shift": "Bloch k on Gamma-X-M-Gamma, 4 interpolated points per segment"},
            reference_results=[
                {
                    "source": "Joannopoulos et al., Photonic Crystals 2nd ed. ch. 5 (eps 8.9 variant)",
                    "note": "R3 s.3.5; figure precision only",
                }
            ],
            hero={"suitable": True, "why": "photonic band diagram (H7)", "visual": ["band_diagram", "Ez_mode"]},
            spd=speed(2.0, "R3 est. < 2 s for a 30-point k path"),
            source_case=src_case("MPB tutorial", "doc/docs/Python_Tutorial.md", MPB, "mpb/Python_Tutorial.md"),
            sim="phc-square-rods",
        )
    )
    cs.append(
        case(
            "WO-61",
            "MPB triangular lattice of dielectric rods (r 0.2a, eps 12): first TM band gap",
            ["optics-phc"],
            "2D-periodic",
            [
                ref(
                    "gap lower edge",
                    0.275065617068082,
                    "1 (c/a)",
                    mpb_tol,
                    "P",
                    "solver_ref",
                    "MPB Python tutorial",
                    f"{mpbl} L184",
                    extraction="text",
                ),
                ref(
                    "gap upper edge",
                    0.446289918847647,
                    "1 (c/a)",
                    mpb_tol,
                    "P",
                    "solver_ref",
                    "MPB Python tutorial",
                    f"{mpbl} L184",
                    extraction="text",
                ),
            ],
            rights(gpl2),
            geometry={
                "kind": "analytic",
                "spec": {
                    "lattice": "triangular",
                    "basis1": [0.8660254, 0.5],
                    "basis2": [0.8660254, -0.5],
                    "rod_radius": 0.2,
                    "unit": "a",
                },
            },
            materials={"rod": {"eps_r": 12.0, "source": f"{mpbl} L69, L181"}},
            study={"type": "eigen", "n": 8, "shift": "Gamma-M-K-Gamma, 4 interpolated points"},
            spd=speed(2.0, "as WO-04; est."),
            source_case=src_case("MPB tutorial", "doc/docs/Python_Tutorial.md", MPB, "mpb/Python_Tutorial.md"),
            sim="phc-triangular-rods",
        )
    )
    cs.append(
        case(
            "WO-62",
            "MPB triangular lattice, anisotropic rod/hole (r 0.3a): complete 2D band gap",
            ["optics-phc"],
            "2D-periodic",
            [
                ref(
                    "complete gap lower edge (band 2)",
                    0.223977612336924,
                    "1 (c/a)",
                    mpb_tol,
                    "P",
                    "solver_ref",
                    "MPB Python tutorial",
                    f"{mpbl} L269",
                    extraction="text",
                ),
                ref(
                    "complete gap upper edge (band 3)",
                    0.274704473679751,
                    "1 (c/a)",
                    mpb_tol,
                    "P",
                    "solver_ref",
                    "MPB Python tutorial",
                    f"{mpbl} L269",
                    extraction="text",
                ),
            ],
            rights(gpl2),
            geometry={"kind": "analytic", "spec": {"lattice": "triangular", "rod_radius": 0.3, "unit": "a"}},
            materials={
                "rod": {"eps_diag": [1, 1, 12], "source": f"{mpbl} L248"},
                "background": {"eps_diag": [12, 12, 1], "source": f"{mpbl} L256"},
            },
            study={"type": "eigen", "n": 8, "shift": "both polarizations (ms.run)"},
            spd=speed(3.0, "anisotropic, both polarizations; est."),
            source_case=src_case("MPB tutorial", "doc/docs/Python_Tutorial.md", MPB, "mpb/Python_Tutorial.md"),
            sim="phc-anisotropic",
        )
    )
    cs.append(
        case(
            "WO-63",
            "MPB point defect (one rod removed) in a 5x5 supercell of the square rod lattice: TM defect mode",
            ["optics-phc"],
            "2D-periodic",
            [
                ref(
                    "defect frequency (band 25)",
                    0.378166,
                    "1 (c/a)",
                    {
                        "rel": 5e-3,
                        "after": "richardson",
                        "note": "MPB resolution 16, 5x5 supercell; supercell size changes the value at this level (assumption)",
                    },
                    "P",
                    "solver_ref",
                    "MPB Python tutorial",
                    f"{mpbl} L320, L349",
                    extraction="text",
                ),
                ref(
                    "energy fraction in the defect region",
                    0.624794702341156,
                    "1",
                    {"rel": 2e-2},
                    "P",
                    "solver_ref",
                    "MPB Python tutorial",
                    f"{mpbl} L337",
                    extraction="text",
                    gate=False,
                    note="region and energy computation at L322-335 of the tutorial",
                ),
            ],
            rights(gpl2),
            geometry={
                "kind": "analytic",
                "spec": {"supercell": [5, 5], "rod_radius": 0.2, "removed": "centre rod", "unit": "a"},
            },
            materials={"rod": {"eps_r": 12.0, "source": f"{mpbl} L288"}},
            study={"type": "eigen", "n": 50, "shift": "k = (0.5, 0.5); or target frequency 0.38 (L341-349)"},
            spd=speed(5.0, "supercell eigen; est."),
            source_case=src_case("MPB tutorial", "doc/docs/Python_Tutorial.md", MPB, "mpb/Python_Tutorial.md"),
            sim="phc-point-defect",
        )
    )

    meepl = "meep doc/docs/Python_Tutorials/Basics.md"
    cs.append(
        case(
            "WO-05",
            "Meep ring resonator (n 3.4, w 1, r 1): TM (Ez) resonances and Q",
            ["optics-modes", "rf-resonator"],
            "2D",
            [
                ref(
                    "f1",
                    0.118101575043663,
                    "1 (c/a)",
                    {"rel": 5e-3, "after": "richardson", "note": "Meep resolution 10 (not converged); proposed"},
                    "P",
                    "solver_ref",
                    "Meep tutorial 'Modes of a Ring Resonator'",
                    f"{meepl} L1116-1117",
                    extraction="text",
                ),
                ref(
                    "f2",
                    0.147162555528154,
                    "1 (c/a)",
                    {"rel": 5e-3, "after": "richardson"},
                    "P",
                    "solver_ref",
                    "Meep tutorial",
                    f"{meepl} L1118",
                    extraction="text",
                ),
                ref(
                    "f3",
                    0.175246750722663,
                    "1 (c/a)",
                    {"rel": 5e-3, "after": "richardson"},
                    "P",
                    "solver_ref",
                    "Meep tutorial",
                    f"{meepl} L1119",
                    extraction="text",
                ),
                ref(
                    "Q1",
                    80.683059081382,
                    "1",
                    {"rel": 0.2},
                    "P",
                    "solver_ref",
                    "Meep tutorial",
                    f"{meepl} L1117",
                    gate=False,
                ),
                ref(
                    "Q2",
                    316.29272471914,
                    "1",
                    {"rel": 0.2},
                    "P",
                    "solver_ref",
                    "Meep tutorial",
                    f"{meepl} L1118",
                    gate=False,
                ),
                ref(
                    "Q3",
                    1677.48461212767,
                    "1",
                    {"rel": 0.2},
                    "P",
                    "solver_ref",
                    "Meep tutorial",
                    f"{meepl} L1119",
                    gate=False,
                ),
            ],
            rights(gpl2),
            geometry={
                "kind": "analytic",
                "spec": {"ring_inner_r": 1, "ring_width": 1, "pad": 4, "pml": 2, "unit": "a (c = 1)"},
            },
            materials={"ring": {"n": 3.4, "source": "meep python/tests/test_ring.py L21"}},
            study={"type": "transient", "t_end": 300, "source": "Gaussian Ez at (r + 0.1, 0), fcen 0.15, df 0.1"},
            reference_results=[
                {
                    "solver": "Meep v1.35.1 unit-test gold",
                    "f1": 0.118101315147,
                    "decay": -0.000731513241623,
                    "tolerance_in_test": "1e-3 relative",
                    "locator": "meep python/tests/test_ring.py L67-68",
                }
            ],
            hero={"suitable": True, "why": "ring resonance build-up (R3 hero WO-05)", "visual": ["Ez", "spectrum"]},
            spd=speed(10.0, "R3: FDTD 2-10 s, FEM eig < 2 s; est."),
            source_case=src_case("Meep tutorial + test", "python/tests/test_ring.py", MEEP, "meep/test_ring.py"),
            sim="meep-ring",
        )
    )
    cs.append(
        case(
            "WO-64",
            "Meep holey-waveguide cavity (eps 13, w 1.2, 3+3 holes r 0.36, defect d 1.4): resonance f, Q",
            ["optics-phc", "rf-resonator"],
            "2D",
            [
                ref(
                    "f",
                    0.23445415346009466,
                    "1 (c/a)",
                    {"rel": 5e-3, "after": "richardson", "note": "Meep resolution 20 gold; proposed"},
                    "P",
                    "solver_ref",
                    "Meep unit test test_resonant_modes",
                    "meep python/tests/test_holey_wvg_cavity.py L66-73",
                    extraction="text",
                ),
                ref(
                    "Q",
                    372.40808234438254,
                    "1",
                    {"rel": 0.1},
                    "P",
                    "solver_ref",
                    "Meep unit test",
                    "meep python/tests/test_holey_wvg_cavity.py L69",
                    gate=False,
                ),
            ],
            rights(gpl2),
            geometry={
                "kind": "analytic",
                "spec": {
                    "wg_width": 1.2,
                    "hole_r": 0.36,
                    "defect_d": 1.4,
                    "holes_per_side": 3,
                    "cell_y": 6,
                    "pad": 2,
                    "pml": 1,
                    "unit": "a",
                },
            },
            materials={"wg": {"eps_r": 13.0, "source": "test_holey_wvg_cavity.py L10"}},
            study={
                "type": "transient",
                "t_end": 400,
                "source": "Gaussian Hz at origin, fcen 0.25, df 0.2; mirror X, Y phase -1",
            },
            spd=speed(10.0, "FDTD; est."),
            source_case=src_case(
                "Meep tests", "python/tests/test_holey_wvg_cavity.py", MEEP, "meep/test_holey_wvg_cavity.py"
            ),
            sim="meep-holey-cavity",
        )
    )

    # ---------------- Code_Aster, deal.II, scikit-fem, DEVSIM, EO atlas ----------------
    cs.append(
        case(
            "SM-61",
            "Code_Aster SDLL01A: short simply supported Timoshenko beam, in-plane bending and axial modes",
            ["solid-modal"],
            ["1D", "2D"],
            [
                ref(
                    f"f{i}",
                    None,
                    "Hz",
                    R4,
                    "D",
                    "closed_form",
                    "Timoshenko beam frequency equation / fixed-free bar (this lane)",
                    f"{ASTER} astest/sdll01a.comm L186-246 (VALE_REFE), L44-95 (inputs)",
                    case="SM-61",
                    mid=f"f{i}",
                )
                for i in range(1, 7)
            ],
            rights("GPL-3.0-or-later (code_aster test file header)", ("cite_values", "re_derive_setup")),
            geometry={
                "kind": "analytic",
                "spec": {
                    "L_m": 1.0,
                    "section_m": [0.2, 0.1],
                    "A_m2": 0.02,
                    "Iz_m4": 6.6667e-5,
                    "Iy_m4": 1.6667e-5,
                    "shear_coefficient": "1/1.17692 (code_aster AY)",
                },
            },
            materials={"steel": {"E_Pa": 2.0e11, "nu": 0.3, "rho": 7800.0, "source": "sdll01a.comm L79"}},
            bcs=[
                {"selection": "A (N100)", "type": "pinned", "note": "DX = DY = 0"},
                {"selection": "B (N200)", "type": "roller", "note": "DY = 0"},
                {"selection": "all", "type": "planar", "note": "DZ = DRX = DRY = 0"},
            ],
            study={"type": "eigen", "n": 6, "shift": 430.0},
            reference_results=[
                {
                    "source": "code_aster VALE_REFE (SFM.VPCS SDLL01, ANALYTIQUE)",
                    "f_Hz": [431.555, 1265.924, 1498.295, 2870.661, 3797.773, 4377.837],
                },
                {
                    "solver": "code_aster 40 POU_D_T elements (VALE_CALC)",
                    "f_Hz": [431.891559270, 1266.00555, 1500.76348, 2873.53437, 3799.96925],
                },
            ],
            assumptions=[
                "The VALE_REFE bending values differ from the continuum Timoshenko closed form by 7.6e-4, 1.4e-3, "
                "4.8e-5, 3.8e-3 (modes 1, 3, 4, 6); code_aster's own FE values sit within 3e-4 of the closed form "
                "for modes 1-3. Gate on the closed form; VALE_REFE informative (flag)."
            ],
            spd=speed(1.0, "beam/2D modal; est."),
            source_case=src_case("Code_Aster astest", "astest/sdll01a.comm", ASTER, "aster/sdll01a.comm"),
            sim="timoshenko-beam-ss",
        )
    )

    st7 = "dealii examples/step-7"
    cs.append(
        case(
            "TR-61",
            "deal.II step-7: -lap u + u = f on [-1,1]^2 with a three-Gaussian exact solution, mixed BCs",
            ["transport-reaction"],
            "2D",
            [
                ref(
                    "L2 error rate, Q1 global refinement",
                    2.0,
                    "1",
                    {"rule": {"type": "rate", "min": 1.9, "note": "p + 1"}},
                    "P",
                    "solver_ref",
                    "deal.II step-7 results",
                    f"{st7}/doc/results.dox L66-97",
                    extraction="tabulated",
                ),
                ref(
                    "H1 error rate, Q2 global refinement",
                    2.0,
                    "1",
                    {"rule": {"type": "rate", "min": 1.9, "note": "p"}},
                    "P",
                    "solver_ref",
                    "deal.II step-7 results",
                    f"{st7}/doc/results.dox L141-172",
                    extraction="tabulated",
                ),
                ref(
                    "L2 error, Q1, 16384 cells",
                    7.660e-04,
                    "1",
                    {"rel": 2e-2, "note": "same mesh family required"},
                    "P",
                    "solver_ref",
                    "deal.II step-7 results",
                    f"{st7}/doc/results.dox L90",
                    gate=False,
                    extraction="tabulated",
                ),
                ref(
                    "L2 error, Q2, 16384 cells",
                    1.394e-05,
                    "1",
                    {"rel": 2e-2},
                    "P",
                    "solver_ref",
                    "deal.II step-7 results",
                    f"{st7}/doc/results.dox L165",
                    gate=False,
                    extraction="tabulated",
                ),
            ],
            rights(
                "LGPL-2.1-or-later (step-7.cc SPDX); deal.II library Apache-2.0 WITH LLVM-exception OR LGPL-2.1-or-later"
            ),
            geometry={
                "kind": "analytic",
                "spec": {"domain": [[-1, 1], [-1, 1]], "initial_mesh": "hyper_cube refined 3x (64 cells)"},
            },
            materials=None,
            bcs=[
                {"selection": ["x = -1", "y = -1"], "type": "neumann", "expr": "n . grad u_exact"},
                {"selection": ["x = 1", "y = 1"], "type": "dirichlet", "expr": "u_exact"},
            ],
            study={"type": "stationary"},
            notes=[
                "u_exact = sum_i exp(-|x - x_i|^2 / w^2), x_i = (-0.5, 0.5), (-0.5, -0.5), (0.5, -0.5), w = 1/8 "
                "(step-7.cc L115-132); f = -lap u_exact + u_exact; alpha = 1 (L600-606)."
            ],
            reference_results=[
                {
                    "Q1_global_L2": [1.840e00, 3.570e-02, 1.192e-02, 3.047e-03, 7.660e-04],
                    "Q1_global_H1": [2.858e00, 1.199e00, 7.565e-01, 3.823e-01, 1.917e-01],
                    "Q2_global_L2": [1.606e-01, 7.638e-03, 8.601e-04, 1.107e-04, 1.394e-05],
                    "Q2_global_H1": [1.278e00, 5.248e-01, 1.086e-01, 2.756e-02, 6.915e-03],
                    "cells": [64, 256, 1024, 4096, 16384],
                    "locator": f"{st7}/doc/results.dox L66-97, L141-172",
                }
            ],
            conv={"levels_min": 3, "ratio_min": 2.0, "method": "rate_fit", "expected_order": 2.0},
            spd=speed(1.0, "2D scalar FEM; est."),
            source_case=src_case("deal.II tutorial", "examples/step-7", DEALII, "dealii/step7_results.dox"),
            sim="dealii-step7",
        )
    )

    cs.append(
        case(
            "HT-61",
            "scikit-fem ex01: Poisson -lap u = 1 on the unit square, maximum of u",
            ["heat-cond"],
            "2D",
            [
                ref(
                    "u_max",
                    None,
                    "1",
                    R5,
                    "D",
                    "closed_form",
                    "double Fourier sine series (this lane)",
                    f"{SKFEM} tests/test_examples.py L8-12 (FEM gold 0.073657185490792)",
                    case="HT-61",
                    mid="u_max",
                )
            ],
            rights("BSD-3-Clause (scikit-fem)", ("cite_values", "re_derive_setup", "copy_with_attribution")),
            geometry={"kind": "analytic", "spec": {"domain": [[0, 1], [0, 1]]}},
            bcs=[{"selection": "boundary", "type": "dirichlet", "value": 0}],
            study={"type": "stationary"},
            reference_results=[
                {
                    "solver": "scikit-fem 12.0.2 P1, MeshTri().refined(6)",
                    "u_max": 0.073657185490792,
                    "locator": "tests/test_examples.py L12",
                }
            ],
            spd=speed(0.5, "2D Poisson; est."),
            source_case=src_case("scikit-fem examples", "docs/examples/ex01.py", SKFEM, "skfem/ex01.py"),
            sim="poisson-square",
        )
    )

    dg = "devsim_tests_macos_arm64@85e6e1f goldenresults/examples/diode/diode_1d.out"
    cs.append(
        case(
            "SC-02",
            "DEVSIM diode_1d: abrupt Si pn diode, forward DC sweep 0.1-0.5 V",
            ["semiconductor-dd"],
            "1D",
            [
                ref(
                    f"J_total {v:.1f} V",
                    None,
                    "A/cm^2",
                    {
                        "rel": 1e-3,
                        "after": "richardson",
                        "note": "DEVSIM's own mesh reproduces the golden to < 1e-15; 1e-3 is for an independent mesh (proposed)",
                    },
                    "P",
                    "solver_ref",
                    "DEVSIM example diode_1d.py, golden output",
                    f"{dg} (bias {v:.1f})",
                    case="SC-02",
                    mid=f"J_{v:.1f}V",
                )
                for v in (0.1, 0.2, 0.3, 0.4, 0.5)
            ],
            rights("Apache-2.0 (DEVSIM); golden-results repo has no LICENSE file (values cited only)"),
            geometry={
                "kind": "analytic",
                "spec": {
                    "length_cm": 1e-5,
                    "junction_cm": 0.5e-5,
                    "mesh_cm": "ps 1e-7 at ends, 1e-9 at the junction (diode_common.py CreateMesh)",
                },
            },
            materials={
                "si": {
                    "source": "DEVSIM simple_physics defaults via diode_common.SetParameters; mu_n 400, mu_p 200 cm2/Vs, "
                    "tau 1e-8 s (R3 s.3.9)"
                }
            },
            bcs=[
                {"selection": "top", "type": "ohmic", "params": {"V": "0..0.5 step 0.1"}},
                {"selection": "bot", "type": "ohmic", "params": {"V": 0}},
            ],
            study={"type": "parametric"},
            notes=[
                "Regenerated locally: validation/c/gen_devsim.py runs the unmodified example with devsim 2.11.2 (PyPI) "
                "and matches the golden to < 1e-15 relative at every bias."
            ],
            spd=speed(1.0, "R3 est. < 1 s"),
            source_case=src_case("DEVSIM examples", "examples/diode/diode_1d.py", DEVSIM, "devsim/diode_1d.py"),
            sim="devsim-diode-1d",
        )
    )

    eol = "eo-modulator-atlas DevLog/DevLog-028-open-source-references.md"
    cs.append(
        case(
            "WO-65",
            "EO-atlas K1: Si strip 500 x 220 nm in SiO2, 1550 nm, TE0 n_eff (vector FEM, femwell formulation)",
            ["optics-modes"],
            "2D",
            [
                ref(
                    "n_eff TE0",
                    2.44722338,
                    "1",
                    {"abs": 2e-6, "after": "richardson", "note": "fixture U 5.9e-7 (safety 3); window PEC at +-2 um"},
                    "P",
                    "solver_ref",
                    "EO atlas tier-B reference (eoref.fmode N2/P2, femwell formulation)",
                    f"{eol} L307; validation/reference/K1-fem.json extrapolated.n_eff (f_ext 2.447223377761226, U 5.86e-7)",
                    extraction="tabulated",
                ),
                ref(
                    "ng (energy)",
                    4.19616697,
                    "1",
                    {"abs": 3e-6, "after": "richardson"},
                    "P",
                    "solver_ref",
                    "EO atlas tier-B",
                    f"{eol} L308; K1-fem.json extrapolated.ng_energy",
                    extraction="tabulated",
                    gate=False,
                ),
            ],
            rights(
                "own work (Wentao Jiang, eo-modulator-atlas; engine GPL-3.0-or-later; validation/ has no separate licence)",
                ("cite_values", "re_derive_setup", "copy_with_attribution"),
                ("copy_text_without_attribution",),
            ),
            geometry={
                "kind": "analytic",
                "spec": {
                    "core_um": [0.5, 0.22],
                    "window_um": [[-2, 2], [-2, 2]],
                    "case_file": "eo-modulator-atlas validation/cases/K1.yaml (sha256 8e4c4fe2...)",
                },
            },
            materials={
                "si": {"n": 3.477723756, "source": "EO atlas K1.yaml (Salzberg-Tatian fit)"},
                "sio2": {"n": 1.444023622, "source": "EO atlas K1.yaml (Malitson fit)"},
            },
            bcs=[{"selection": "window", "type": "pec"}],
            study={"type": "eigen", "n": 6, "shift": 2.45},
            reference_results=[
                {
                    "solver": "tidy3d local mode solver (sanity only)",
                    "n_eff": 2.44655,
                    "U": 3.6e-2,
                    "locator": f"{eol} L310-311",
                },
                {"solver": "EO audit independent solver", "n_eff_range": [2.4472236, 2.4472239]},
            ],
            hero={"suitable": True, "why": "H4 Si waveguide modes", "visual": ["E_vector", "intensity"]},
            spd=speed(1.0, "EO measured vector modes 0.25-0.39 s at 32-56k DOF (Node); R1 s.3"),
            source_case=src_case("eo-modulator-atlas tier B", "validation/reference/K1-fem.json", EO),
            sim="si-strip-te0",
        )
    )
    cs.append(
        case(
            "RF-62",
            "EO-atlas K6a: CPW S 20 / W 5 um on an eps_r 11.7 half-space, quasi-static C', n_RF, Z0",
            ["electrostatics", "rf-waveguide"],
            "2D",
            [
                ref(
                    "C'",
                    None,
                    "F/m",
                    R4,
                    "D",
                    "closed_form",
                    "conformal map (this lane); EO atlas K6a closed form",
                    f"{eol} L345; validation/reference/K6a.json closed_form_t0_infinite",
                    case="RF-62",
                    mid="C_per_length",
                ),
                ref("n_RF", None, "1", R5, "D", "closed_form", "as above", f"{eol} L346", case="RF-62", mid="n_rf"),
                ref("Z0", None, "ohm", R4, "D", "closed_form", "as above", f"{eol} L347", case="RF-62", mid="Z0"),
            ],
            rights("own work (eo-modulator-atlas); conformal map textbook", ("cite_values", "re_derive_setup")),
            geometry={
                "kind": "analytic",
                "spec": {
                    "S_m": 20e-6,
                    "W_m": 5e-6,
                    "metal_t_m": 0.0,
                    "grounds": "semi-infinite",
                    "substrate": "half-space y < 0",
                },
            },
            materials={
                "substrate": {"eps_r": 11.7, "source": "EO atlas K6a.yaml"},
                "air": {"eps_r": 1.0, "source": "K6a.yaml"},
            },
            study={"type": "stationary"},
            reference_results=[
                {
                    "solver": "EO tier-B P2 FEM, t = 0, R -> inf",
                    "C_pF_per_m": 213.729,
                    "U": 0.014,
                    "Z0_ohm": 39.3282,
                    "locator": f"{eol} L345-347",
                },
                {
                    "solver": "EO tier-B P2 FEM, t = 0.1 um, R = 500 um (engine like-for-like)",
                    "C_pF_per_m": 214.261,
                    "Z0_ohm": 38.9688,
                },
            ],
            spd=speed(1.0, "EO measured 2D ES 0.17-0.32 s at 27-49k nodes (R1 s.3)"),
            source_case=src_case("eo-modulator-atlas tier B", "validation/reference/K6a.json", EO),
            sim="cpw-halfspace",
        )
    )

    # ---------------- FEATFLOW, NASA TMR ----------------
    cs.append(
        case(
            "FL-61",
            "Turek-Hron CFD1: steady flow past a cylinder with a rigid flag, Re 20 (FEATFLOW finest level)",
            ["laminar-ns"],
            "2D",
            [
                ref(
                    "drag force",
                    14.2929,
                    "N/m",
                    {"rel": 1e-3, "after": "richardson"},
                    "P",
                    "benchmark",
                    "Turek-Hron 2006 CFD1 via FEATFLOW 'CFD tests' page",
                    f"{FEAT} 'Results for CFD1', level 6+0 row (L190)",
                    extraction="tabulated",
                    note="reference row 'ref.' gives 14.29",
                ),
                ref(
                    "lift force",
                    1.11905,
                    "N/m",
                    {"rel": 2e-3, "after": "richardson"},
                    "P",
                    "benchmark",
                    "Turek-Hron 2006 CFD1 via FEATFLOW",
                    f"{FEAT} level 6+0 row (L190)",
                    extraction="tabulated",
                    note="reference row 'ref.' gives 1.119",
                ),
            ],
            rights("open web page, no terms stated; Turek-Hron 2006 (Springer LNCSE 53) paywalled"),
            geometry={
                "kind": "analytic",
                "spec": {
                    "channel_m": [2.5, 0.41],
                    "cylinder": {"center_m": [0.2, 0.2], "radius_m": 0.05},
                    "flag": {"length_m": 0.35, "height_m": 0.02, "right_bottom_corner_m": [0.6, 0.19], "rigid": True},
                },
                "note": "same geometry as class-b CP-07 (L7b), FEATFLOW FSI definitions page",
            },
            materials={
                "fluid": {"rho": 1.0e3, "nu": 1.0e-3, "source": "FEATFLOW CFD tests parameter table (L135-141)"}
            },
            bcs=[
                {
                    "selection": "inlet",
                    "type": "velocity",
                    "expr": "(1.5*Ubar*y*(H-y)/(H/2)^2, 0)",
                    "params": {"Ubar": 0.2, "H": 0.41},
                },
                {"selection": "outlet", "type": "do_nothing"},
                {"selection": ["walls", "cylinder", "flag"], "type": "no_slip"},
            ],
            study={"type": "stationary"},
            reference_results=[
                {
                    "FEATFLOW_levels": {
                        "4+0": [14.2919, 1.11896],
                        "5+0": [14.2927, 1.11904],
                        "6+0": [14.2929, 1.11905],
                    },
                    "ndof_6+0": 11225600,
                }
            ],
            spd=speed(10.0, "2D steady NS; R3 FL-03 2-10 s; est."),
            source_case=src_case(
                "FEATFLOW benchmarks",
                "fsi_tests/fsi_cfd_tests.html",
                FEAT,
                "featflow/cfd.html",
                "www.featflow.de fails TLS from this machine; TU Dortmund host used (as L7b)",
            ),
            sim="turek-hron-cfd1",
        )
    )

    tmrl = "tmbwg.github.io/turbmodels/FlatPlate/SA/"
    cs.append(
        case(
            "FL-05",
            "NASA TMR 2D zero-pressure-gradient flat plate, SA model, M 0.2, Re 5e6 per unit length",
            ["turbulent"],
            "2D",
            [
                ref(
                    "Cf(x = 0.970084071)",
                    2.70562153e-3,
                    "1",
                    {
                        "rel": 2e-3,
                        "after": "richardson",
                        "note": "CFL3D and FUN3D finest grids differ by 8e-5 relative",
                    },
                    "P",
                    "solver_ref",
                    "NASA TMR, CFL3D finest grid 545x385 (208896 cells)",
                    f"{tmrl}cf_convergence.dat zone CFL3D row 1",
                    extraction="tabulated",
                ),
                ref(
                    "C_D",
                    2.85985288e-3,
                    "1",
                    {"rel": 3e-3, "after": "richardson"},
                    "P",
                    "solver_ref",
                    "NASA TMR, CFL3D finest grid",
                    f"{tmrl}drag_convergence.dat zone CFL3D row 1",
                    extraction="tabulated",
                ),
            ],
            rights("CC0-1.0 (TMBWG/turbmodels repository licence)", ("cite_values", "re_derive_setup", "copy_data")),
            geometry={
                "kind": "step_ref",
                "spec": {"plate_m": [0, 2], "grid_family": "TMR 2DZP nested grids, finest 545x385"},
            },
            materials={
                "air": {"source": "TMR: compressible RANS, M 0.2, Re 5e6 based on unit length (flatplate.html L85-88)"}
            },
            study={"type": "stationary"},
            reference_results=[
                {"solver": "FUN3D finest", "Cf": 2.70540472596778e-3, "C_D": 2.852469e-3},
                {
                    "model": "SST (R3)",
                    "Cf_CFL3D": 2.69085355e-3,
                    "Cf_FUN3D": 2.69054633e-3,
                    "note": "not re-checked this round (SST page not fetched)",
                },
            ],
            hero=NO_HERO,
            spd=speed(None, "native only (R3 est. 1-10 min)"),
            source_case=src_case("NASA TMR", "flatplate_sa.html", TMR, "tmr/flatplate_sa.html"),
            sim="tmr-flatplate-sa",
        )
    )
    cs.append(
        case(
            "FL-62",
            "NASA TMR NACA 0012, SA model, M 0.15, Re 6e6, alpha 10 deg: lift and drag (897x257 grid)",
            ["turbulent"],
            "2D",
            [
                ref(
                    "C_L (alpha 10)",
                    1.0909,
                    "1",
                    {
                        "rule": {
                            "type": "range",
                            "range": [1.0909, 1.0983],
                            "note": "CFL3D .. FUN3D on the same grid; validation-page values, no grid-convergence data",
                        }
                    },
                    "P",
                    "solver_ref",
                    "NASA TMR NACA 0012 validation, SA",
                    "tmbwg.github.io/turbmodels/naca0012_val_sa.html table L170-183",
                    bounds=[1.0909, 1.0983],
                    extraction="tabulated",
                ),
                ref(
                    "C_D (alpha 10)",
                    0.01231,
                    "1",
                    {"rule": {"type": "range", "range": [0.01231, 0.01242]}},
                    "P",
                    "solver_ref",
                    "NASA TMR NACA 0012 validation, SA",
                    "naca0012_val_sa.html table L173, L183",
                    bounds=[0.01231, 0.01242],
                    extraction="tabulated",
                ),
            ],
            rights("CC0-1.0 (TMBWG/turbmodels repository licence)", ("cite_values", "re_derive_setup", "copy_data")),
            geometry={
                "kind": "step_ref",
                "spec": {
                    "airfoil": "NACA 0012 closed sharp TE, scaled by 1.008930411365",
                    "grid": "897x257 (TMR)",
                    "farfield_c": 500,
                },
            },
            materials={
                "air": {
                    "source": "M 0.15, Re 6e6 per chord, T_ref 540 R, Pr 0.72, Prt 0.9, Sutherland "
                    "(naca0012numerics_val.html)"
                }
            },
            study={"type": "stationary"},
            reference_results=[
                {"alpha_deg": 15, "C_L": [1.5461, 1.5547], "C_D": [0.02124, 0.02159], "codes": ["CFL3D", "FUN3D"]}
            ],
            spd=speed(None, "native only; est."),
            source_case=src_case("NASA TMR", "naca0012_val_sa.html", TMR, "tmr/naca0012_val_sa.html"),
            sim="tmr-naca0012-sa",
        )
    )

    # ---------------- AirfRANS ----------------
    cs.append(
        case(
            "FL-07",
            "AirfRANS sample (NACA 4/5-digit, Re 2-6e6, AoA -5 to 15 deg, incompressible RANS)",
            ["turbulent"],
            "2D",
            [
                ref(
                    "C_D, C_L relative error vs AirfRANS simulation",
                    None,
                    "1",
                    {
                        "rule": {
                            "type": "range",
                            "range": [0.0, 1.0],
                            "note": "sanity bound only; gate set after own convergence floor (R3 s.4)",
                        }
                    },
                    "P",
                    "dataset",
                    "Bonnet et al., AirfRANS, NeurIPS 2022 D&B, arXiv:2212.07564",
                    "airfrans.readthedocs.io notes/dataset.html",
                    gate=False,
                )
            ],
            rights(
                "ODbL-1.0 (github.com/Extrality/AirfRANS LICENSE, GitHub API 2026-11-06): data stays out of the repo",
                ("cite_values", "reference_by_hash"),
                ("copy_data", "redistribute_data"),
            ),
            geometry={
                "kind": "dataset_grid",
                "spec": {"format": "VTU internal field + VTP aerofoil/freestream, sliced at z 0.5"},
            },
            study={"type": "stationary"},
            conv=CONV_DS,
            dataset={
                "name": "AirfRANS",
                "subset": "full (800 train / 200 test)",
                "metric": "C_D, C_L relative error; field MSE",
                "url": "https://data.isir.upmc.fr/extrality/NeurIPS_2022/Dataset.zip",
                "license": "ODbL-1.0",
                "file": "N/A (not fetched: archive size not stated on the docs page; R3 states 10.0 GB)",
            },
            missing=[
                "turbulence model and OpenFOAM version are not stated on the docs page (R3: k-omega SST, simpleFoam, from the paper)"
            ],
            spd=speed(None, "native only (R3: ~25 min on 16 cores per simulation)"),
            source_case=src_case("AirfRANS", "notes/dataset.html", "airfrans.readthedocs.io"),
            sim="airfrans-sample",
        )
    )

    cs.extend(dataset_cases())
    return cs


def exp_json_input(cid: str, key: str) -> float:
    return json.loads((EXP / f"{cid}.json").read_text())["inputs_SI"][key]


def well(name: str, rel: str) -> str:
    return f"{HFW}/{name}"


def side(name: str) -> dict:
    p = ROOT / "cache" / "eval-c" / name / "sidecar.json"
    return json.loads(p.read_text()) if p.exists() else {}


def dataset_cases() -> list[dict]:
    cs: list[dict] = []
    vr = {
        "rule": {
            "type": "range",
            "range": [0.0, 1.0],
            "note": "sanity bound: VRMSE 1 = predicting the spatial mean "
            "(The Well App. E.3); the gate is the own self-convergence floor, set after the first run (R3 s.4)",
        }
    }
    nr = {
        "rule": {
            "type": "range",
            "range": [0.0, 1.0],
            "note": "sanity bound: nRMSE 1 = predicting zero; the gate is the own self-convergence floor (R3 s.4)",
        }
    }
    well_r = rights(
        "CC-BY-4.0 (HF dataset card license tag; The Well paper App. A.6); code BSD-3-Clause",
        ("cite_values", "re_derive_setup", "reference_by_hash"),
        ("redistribute_data_without_attribution",),
    )
    pdeb_r = rights(
        "CC BY 4.0 (DaRUS dataset licence field); code 'MIT except where otherwise stated' (LICENSE.txt)",
        ("cite_values", "re_derive_setup", "reference_by_hash"),
        ("redistribute_data_without_attribution",),
    )
    proto = (
        "Protocol (R3 s.4): load stored frame 0 (and stored coefficient fields), integrate with our solver at a "
        "resolution where our own result is converged, compare with the stored trajectory using the dataset metric, "
        "report it next to our self-convergence floor (two finest levels)."
    )

    def dref(q, metric_note, tol, cit, loc):
        return ref(q, None, "1", tol, "P", "dataset", cit, loc, gate=False, note=metric_note)

    # The Well
    def wds(
        cid,
        name,
        title,
        physics,
        dim,
        eq,
        params,
        grid,
        extra_notes,
        hero=NO_HERO,
        metric="VRMSE",
        browser=None,
        assumptions=None,
        missing=None,
    ):
        s = side(f"the_well-{name}")
        tree = json.loads((SRC / "hf" / f"{name}_tree.json").read_text())
        files = [x for x in tree if x["type"] == "file" and x["path"].endswith(".hdf5")]
        total = sum(x["size"] for x in files)
        hf = json.loads((SRC / "hf" / f"{name}.json").read_text())
        ds = {
            "name": f"The Well / {name}",
            "subset": "test",
            "metric": metric,
            "url": f"https://huggingface.co/datasets/polymathic-ai/{name}",
            "license": "CC-BY-4.0",
            "hf_revision": hf["sha"],
            "hf_last_modified": hf["lastModified"],
            "n_hdf5_files": len(files),
            "total_hdf5_bytes": total,
            "file": s.get("url", "").split("/resolve/")[-1].split("/", 1)[-1] if s else None,
            "file_bytes": s.get("file_size_bytes"),
            "hash": s.get("upstream_checksum"),
            "sample_index": 0,
            "frame0": "t0_fields/* [0, 0]",
            "probe_sidecar": f"cache/eval-c/the_well-{name}/sidecar.json",
            "stored_grid": grid,
        }
        refs = [
            dref(
                f"{metric} vs stored trajectory at frames 1, 10, last",
                "per field; The Well metric definition",
                vr,
                WELL_PAPER,
                f"HF {name} README 'About the data'; paper App. E.3 (VRMSE)",
            )
        ]
        return case(
            cid,
            title,
            physics,
            dim,
            refs,
            well_r,
            geometry={"kind": "dataset_grid", "spec": grid},
            study={"type": "transient"},
            conv=CONV_DS,
            dataset=ds,
            hero=hero,
            notes=[f"Equations: {eq}", f"Parameters: {params}", proto] + extra_notes,
            spd=speed(browser, "R3 s.3.8 est." if browser else "not estimated"),
            assumptions=assumptions,
            missing=missing,
            source_case=src_case("The Well", f"{name} README.md + {name}.yaml", well(name, ""), f"hf/{name}_README.md"),
            sim=f"well-{name.replace('_', '-')}",
        )

    cs.append(
        wds(
            "TR-03",
            "gray_scott_reaction_diffusion",
            "The Well gray_scott_reaction_diffusion: Gray-Scott patterns, 6 (F, k) sets, periodic [-1,1]^2",
            ["transport-reaction"],
            "2D-periodic",
            "A_t = dA lap A - A B^2 + F (1 - A); B_t = dB lap B + A B^2 - (F + k) B (README prints '- A B^2' in the B equation: "
            "sign typo vs the standard model; flag)",
            "dA 2e-5, dB 1e-5; (F, k) gliders (0.014, 0.054), bubbles (0.098, 0.057), maze (0.029, 0.057), worms (0.058, 0.065), "
            "spirals (0.018, 0.051), spots (0.03, 0.062); dt_sim 1, stored every 10, t 0-10000",
            {
                "nx": 128,
                "ny": 128,
                "frames": 1001,
                "x_stored": "linspace(-1, 1, 128) (spacing 2/127)",
                "fields": ["t0_fields/A", "t0_fields/B"],
                "dtype": "float32",
                "per_file_trajectories": 20,
            },
            [
                "Generator: Chebfun spin2, Fourier spectral + ETDRK4 (github.com/danfortunato/spectral-gray-scott, MATLAB).",
                "Probed file: test/..._bubbles_F_0.098_k_0.057.hdf5 (2,650,800,128 B): A, B [20, 1001, 128, 128] float32; "
                "dimensions/time 0..10000 step 10.",
            ],
            hero={"suitable": True, "why": "H12 Turing patterns on the GPU", "visual": ["A_concentration"]},
            browser=20.0,
            assumptions=[
                "Stored x coordinates are linspace(-1, 1, 128) including both ends, while a periodic Fourier grid "
                "has spacing 2/128; we assume the stored array is a label and the data sit on the periodic grid "
                "(to verify against the generator before gating)."
            ],
        )
    )
    cs.append(
        wds(
            "AC-61",
            "helmholtz_staircase",
            "The Well helmholtz_staircase: point-source scattering by a periodic sound-hard staircase",
            ["acoustics"],
            "2D",
            "-(lap + omega^2) u = delta(x - x0) above a right-angle staircase, u_n = 0 on the surface, outgoing radiation; "
            "stored fields are Re/Im of u(x) e^{-i omega t} over one period",
            "16 omega in 0.06283032-2.5110908; sources x0 in {-0.4..0.4} x {-0.2..0.4} (README); stored dt = 2 pi/(50 omega)",
            {
                "nx": 1024,
                "ny": 256,
                "frames": 50,
                "x": [-8.0, 8.0],
                "y": [-0.5, 3.5],
                "fields": ["pressure_re", "pressure_im", "mask"],
                "dtype": "float32",
            },
            [
                "Generator: Floquet-Bloch transform + boundary integral equations (github.com/fruzsinaagocs/bies), "
                "Agocs-Barnett arXiv:2310.12486.",
                "Probed file: test/helmholtz_staircase_omega_006.hdf5 (335,544,320 B): 3 trajectories, root attr omega 0.06283032.",
                "Gate idea: frame 0 alone does not fix the solution (source term); solve the frequency-domain BVP with our "
                "solver (PML + quasi-periodic) and compare frame-by-frame phases.",
            ],
            missing=[
                "staircase period d and step geometry in physical units are not in the README (mask field gives them)"
            ],
        )
    )
    cs.append(
        wds(
            "AC-62",
            "acoustic_scattering_maze",
            "The Well acoustic_scattering (maze, inclusions, discontinuous): variable-coefficient linear acoustics",
            ["acoustics"],
            "2D",
            "p_t + K (u_x + v_y) = 0; u_t + p_x / rho = 0; v_t + p_y / rho = 0",
            "K 4 (maze); maze walls rho 1e6, paths rho 3; maze IC 1-6 rings, intensity U(3, 5), radius U(0.01, 0.04); "
            "inclusions IC 1-4 rings U(0.5, 2), radius U(0.06, 0.15); open in y, reflective in x",
            {
                "nx": 256,
                "ny": 256,
                "frames_maze": 202,
                "t_maze": [0.0, 4.0],
                "frames_inclusions": 102,
                "frames_discontinuous": 102,
                "t_inclusions": [0.0, 2.0],
                "x_stored": [0.0, 1.0],
                "fields": ["pressure", "velocity (2)", "density", "speed_of_sound"],
                "dtype": "float32",
            },
            [
                "Variants probed (one test file each): maze chunk_18 (15,980,298,240 B, 100 traj., 202 frames, t 0-4); "
                "inclusions chunk_36 and discontinuous chunk_18 (8,111,783,936 B each, 100 traj., 102 frames, t 0-2).",
                "R3 flag '201 vs 100 steps' resolved from the stored arrays: maze 202 frames (README says 201 steps and "
                "dt 2/201; metadata yaml says 202), inclusions/discontinuous 102 frames (README 101; yaml 102).",
                "Stored x, y run 0..1 (256 points); README states [-1, 1]^2 (flag).",
                "Generator: Clawpack acoustics_2d_interface, generation scripts in the HF repo (generation/*.py), double precision.",
            ],
            assumptions=[
                "Frame-0 velocity is zero (flat static pressure field plus rings, README); to confirm from the stored "
                "velocity frame 0 before gating."
            ],
        )
    )
    cs.append(
        wds(
            "FL-63",
            "rayleigh_benard",
            "The Well rayleigh_benard: 2D Boussinesq convection, Ra 1e6-1e10, Pr 0.1-10 (short-horizon comparison)",
            ["coupled-heat-ns", "laminar-ns"],
            "2D",
            "b_t - kappa lap b = -u . grad b; u_t - nu lap u + grad p - b e_z = -u . grad u; kappa = (Ra Pr)^-1/2, "
            "nu = (Ra/Pr)^-1/2; b(z=0) = Lz, b(z=Lz) = 0, no-slip; periodic in x",
            "Ra in {1e6, 1e7, 1e8, 1e9, 1e10}, Pr in {0.1, 0.2, 0.5, 1, 2, 5, 10}; db0 in {0.2..1.0}; noise seeds 40-49",
            {
                "nx": 512,
                "nz": 128,
                "frames": 200,
                "t": [0.0, 49.75],
                "x": [0.0, 4.0],
                "z": [0.0, 1.0],
                "fields": ["buoyancy", "pressure", "velocity (2)"],
                "dtype": "float32",
            },
            [
                "Generator: Dedalus (github.com/RudyMorel/the-well-rbc-sf); single precision; README 'time-step 0.25' is the "
                "stored-frame spacing (stored t step 0.25).",
                "Probed file: test/rayleigh_benard_Rayleigh_1e6_Prandtl_1.hdf5 (1,082,130,432 B): 5 trajectories.",
                "Chaotic at high Ra: use Ra 1e6 and short horizons (VRMSE at the first frames), statistics later (R3 s.4).",
            ],
        )
    )
    cs.append(
        wds(
            "FL-64",
            "shear_flow",
            "The Well shear_flow: 2D periodic incompressible shear layers with a passive tracer, Re 1e4-5e5",
            ["laminar-ns", "transport-diffusion"],
            "2D-periodic",
            "u_t + grad p - nu lap u = -u . grad u; s_t - D lap s = -u . grad s; nu = 1/Re, D = nu/Sc",
            "Re in {1e4, 5e4, 1e5, 5e5}, Sc in {0.1, 0.2, 0.5, 1, 2, 5, 10}; IC indexed by n_shear {2, 4}, n_blobs {2..5}, "
            "w {0.25..4}",
            {
                "nx": 256,
                "ny": 512,
                "frames": 200,
                "t": [0.0, 19.9],
                "x": [0.0, 1.0],
                "y_stored": [0.0, 1.0],
                "fields": ["tracer", "pressure", "velocity (2)"],
                "dtype": "float32 (time float64)",
            },
            [
                "R3 size/grid conflict resolved from the stored arrays (HF revision 1bca59ae, 2026-10-19, v2 rebuild): "
                "256 x 512 per frame, 200 frames, 4 trajectories per file; HF total 471.19 GB over 84 HDF5 files. "
                "README still says 128 x 256 and 114.7 GB; metadata yaml says 256 x 512 (and names the scalars "
                "'Rayleigh, Schmidt', while the file attrs are Reynolds, Schmidt).",
                "Stored y runs 0..1; README states -1 <= y <= 1 (flag: coordinates may be rescaled).",
                "Generator: Dedalus (github.com/RudyMorel/the-well-rbc-sf), single precision.",
            ],
        )
    )

    # PDEBench
    def pds(
        cid,
        sname,
        title,
        physics,
        dim,
        eq,
        params,
        grid,
        notes,
        file_id,
        fname,
        size,
        md5,
        metric="nRMSE",
        browser=None,
        assumptions=None,
        missing=None,
        extra_refs=None,
        hero=NO_HERO,
    ):
        s = side(f"pdebench-{sname}")
        ds = {
            "name": f"PDEBench / {sname}",
            "subset": fname,
            "metric": metric,
            "url": f"https://darus.uni-stuttgart.de/api/access/datafile/{file_id}",
            "license": "CC BY 4.0",
            "file": fname,
            "file_bytes": size,
            "hash": f"md5:{md5}",
            "darus_file_id": file_id,
            "sample_index": 0,
            "frame0": "tensor[0, 0]" if "Darcy" not in sname else "nu[0] (coefficient field)",
            "probe_sidecar": f"cache/eval-c/pdebench-{sname}/sidecar.json"
            if s
            else "N/A (probe failed, see DevLog-008)",
            "stored_grid": grid,
        }
        refs = [dref(f"{metric} vs stored solution", "PDEBench eq. 4 (App. B)", nr, PDEB_PAPER, notes[0])]
        refs += extra_refs or []
        return case(
            cid,
            title,
            physics,
            dim,
            refs,
            pdeb_r,
            geometry={"kind": "dataset_grid", "spec": grid},
            study={"type": "transient"} if "Darcy" not in sname else {"type": "stationary"},
            conv=CONV_DS,
            dataset=ds,
            notes=[f"Equations: {eq}", f"Parameters: {params}", proto] + notes[1:],
            spd=speed(browser, "R3 est." if browser else "not estimated"),
            assumptions=assumptions,
            missing=missing,
            hero=hero,
            source_case=src_case("PDEBench", fname, DARUS, "pdebench/darus.json"),
            sim=f"pdebench-{sname.lower().replace('_', '-').replace('.', 'p')}",
        )

    cs.append(
        pds(
            "TR-02",
            "1D_Advection_beta1.0",
            "PDEBench 1D advection, periodic, beta in {0.1 .. 7} (exact shift)",
            ["transport-diffusion"],
            "1D",
            "u_t + beta u_x = 0, x in (0, 1), t in (0, 2], periodic; exact u(t, x) = u0(x - beta t) (paper eq. 6-7)",
            "beta in {0.1, 0.2, 0.4, 0.7, 1, 2, 4, 7}; u0 = sum of N = 2 sines, k_max 8 (eq. 8); 10000 samples per beta",
            {
                "nx": 1024,
                "x": "cell centres 1/2048 .. 2047/2048",
                "frames": 201,
                "t": "0..2 step 0.01",
                "t_coordinate_entries": 202,
                "fields": ["tensor"],
                "dtype": "float32",
            },
            [
                "paper App. D.1 eq. 6-8; Table 1 (Ns 1024, Nt 200)",
                "Probed 1D_Advection_Sols_beta1.0.hdf5: tensor [10000, 201, 1024] float32, x-coordinate 1024 cell centres, "
                "t-coordinate has 202 entries (0 .. 2.01) for 201 frames (flag: one extra coordinate).",
                "Generator: JAX 2nd-order upwind (R3 s.4); the exact shift of frame 0 is an independent reference.",
            ],
            255675,
            "1D_Advection_Sols_beta1.0.hdf5",
            8232966952,
            "1fe41923a4123db55bf4e89bea32e142",
            browser=0.1,
            extra_refs=[
                ref(
                    "nRMSE of exact shift vs stored frames",
                    None,
                    "1",
                    nr,
                    "P",
                    "dataset",
                    PDEB_PAPER,
                    "eq. 6-7 exact solution vs stored tensor",
                    gate=False,
                    note="measures the dataset's own discretization floor (upwind scheme error)",
                )
            ],
        )
    )
    cs.append(
        pds(
            "TR-62",
            "1D_Burgers_Nu0.01",
            "PDEBench 1D Burgers, periodic, nu in {0.001 .. 4}",
            ["transport-diffusion"],
            "1D",
            "u_t + (u^2/2)_x = (nu/pi) u_xx, x in (0, 1), t in (0, 2], periodic (paper eq. 11-12)",
            "nu in {0.001, 0.002, 0.004, 0.01, 0.02, 0.04, 0.1, 0.2, 0.4, 1, 2, 4} (DaRUS file names); IC eq. 8",
            {"nx": 1024, "frames": 201, "t": "0..2 step 0.01", "t_coordinate_entries": 202, "dtype": "float32"},
            [
                "paper App. D.3 eq. 11-12",
                "Probed 1D_Burgers_Sols_Nu0.01.hdf5: tensor [10000, 201, 1024] float32, same coordinates as advection.",
                "Repo config BurgersEq/config/multi/config.yaml (main 2026) says xL -1, xR 1, dt_save 0.05, epsilon 1e-2: "
                "does not match the stored file (x in (0, 1), 201 frames): flag; the stored file is the reference.",
            ],
            281363,
            "1D_Burgers_Sols_Nu0.01.hdf5",
            8232968312,
            "e6d9a4f62baf9a29121a816b919e2770",
            browser=0.5,
        )
    )
    cs.append(
        pds(
            "FL-06",
            "2D_DarcyFlow_beta1.0",
            "PDEBench 2D Darcy flow, -div(a grad u) = beta, u = 0 on the boundary",
            ["porous"],
            "2D",
            "-div(a(x) grad u(x)) = beta in (0, 1)^2, u = 0 on the boundary (paper eq. 13-14); stored by pseudo-time "
            "relaxation to steady state (eq. 15)",
            "beta in {0.01, 0.1, 1, 10, 100}; a(x) stored per sample ('nu'); a(x) generator not described",
            {
                "nx": 128,
                "ny": 128,
                "x": "cell centres 1/256 .. 255/256",
                "fields": ["nu (a(x)) [10000,128,128]", "tensor (u) [10000,1,128,128]"],
                "dtype": "float32",
            },
            [
                "paper App. D.4 eq. 13-15",
                "Probed 2D_DarcyFlow_beta1.0_Train.hdf5 (1,310,724,488 B): nu [10000, 128, 128], tensor [10000, 1, 128, 128].",
                "Our solve uses the stored a(x) directly (steady problem): this is the most deterministic PDEBench gate.",
            ],
            133219,
            "2D_DarcyFlow_beta1.0_Train.hdf5",
            1310724488,
            "81694ed31306ff2e5f6b76349b0b4389",
            browser=1.0,
            missing=["how a(x) is represented between cell centres (piecewise constant per cell assumed)"],
        )
    )
    cs.append(
        pds(
            "TR-63",
            "2D_diff-react",
            "PDEBench 2D diffusion-reaction (FitzHugh-Nagumo), Neumann, t <= 5",
            ["transport-reaction"],
            "2D",
            "u_t = Du lap u + u - u^3 - k - v; v_t = Dv lap v + u - v, (x, y) in (-1, 1)^2, t in (0, 5] (paper eq. 24-26)",
            "Du 1e-3, Dv 5e-3, k 5e-3; IC u, v ~ N(0, 1) white noise; FV in space, scipy RK45 in time; computed at 512^2 x 501, "
            "stored 128^2 x 101 (paper D.9)",
            {"nx": 128, "ny": 128, "frames": 101, "samples": 1000, "layout": "one HDF5 group per sample (R3)"},
            [
                "paper App. D.9 eq. 24-26; Table 1 (128 x 128, Nt 100, 1000 samples)",
                "Header probe failed: the file holds one group per sample and the HDF5 symbol table is scattered; three "
                "attempts hit their byte caps (49.3, 11.8, 8.0 MB) before the walk finished. Layout and dtype not verified.",
                "File size 13,243,560,688 B equals 1000 x 101 x 128 x 128 x 2 x 4 B + 5.3 MB: consistent with float32 u, v (D).",
            ],
            133017,
            "2D_diff-react_NA_NA.h5",
            13243560688,
            "b8d0b86064193195ddc30c33be5dc949",
            browser=3.0,
            missing=[
                "stored group/dataset names and dtype (probe failed)",
                "boundary condition: paper D.9 does not state it in the extracted text; R3 says Neumann (no-flux)",
            ],
        )
    )

    # PDEArena Maxwell-3D
    pa = "github.com/pdearena/pdearena main 78a8b03d50115d8bb24ce9f04efa5b920fcd4369"
    cs.append(
        case(
            "WO-66",
            "PDEArena Maxwell-3D: FDTD in a periodic eps_r 10 cube, random plane sources (32^3 crop)",
            ["optics-scattering"],
            "3D-periodic",
            [
                ref(
                    "nRMSE of E, H vs stored frames",
                    None,
                    "1",
                    nr,
                    "P",
                    "dataset",
                    "Gupta, Brandstetter, PDEArena, arXiv:2209.15616",
                    f"{pa} pdedatagen/maxwell.py L54-148, configs/maxwell3d.yaml",
                    gate=False,
                    note="frame 0 does not contain the sources (outside the stored crop): regenerate the full 64^3 run from the "
                    "seed with the python 'fdtd' package, then compare our FDTD on the same grid",
                )
            ],
            rights(
                "MIT (HF dataset card; pdearena repo LICENSE)",
                ("cite_values", "re_derive_setup", "copy_with_attribution"),
            ),
            geometry={
                "kind": "dataset_grid",
                "spec": {
                    "L_m": 3.2e-5,
                    "n_large": 64,
                    "dx_m": 5.0e-7,
                    "stored_crop": 32,
                    "stored_extent_m": 1.6e-5,
                    "frames": 8,
                },
            },
            materials={"medium": {"eps_r": 10.0, "mu_r": 1.0, "source": "configs/maxwell3d.yaml"}},
            study={"type": "transient"},
            conv=CONV_DS,
            dataset={
                "name": "PDEArena / Maxwell-3D",
                "subset": "test",
                "metric": "nRMSE",
                "url": "https://huggingface.co/datasets/pdearena/Maxwell-3D",
                "license": "MIT",
                "hf_revision": "945a09ca69064ecd588da832c783794dd852680e",
                "file": "Maxwell3D_test_126488.h5",
                "file_bytes": 314575504,
                "hash": "sha256:b8fbaae84b2f003ebd24e30febd10919789d0efbb5d2234d4cf9826061c61db9",
                "n_files": 194,
                "total_bytes": 120.8e9,
                "sample_index": 0,
                "frame0": "d_field[0, 0], h_field[0, 0]",
            },
            notes=[
                "Config (configs/maxwell3d.yaml): wavelength 1e-5 m, amplitude 1, eps 10, mu 1, L 3.2e-5 m, n 32, "
                "n_large 64, nt 8, skip_nt 250, sample_rate 25; class defaults in pde.py differ (nt 12, sample_rate 15).",
                "Generator (maxwell.py): fdtd.Grid((L, L, L), grid_spacing = L/64), periodic in x, y, z (L74-76); "
                "6 random plane sources per plane family in the outer band (L78-127); fields cropped to the central 32^3 "
                "(outer_area = 16); datasets d_field, h_field shaped (samples, nt, 32, 32, 32, 3), dtype float (float64).",
                "File size 314,575,504 B = 25 samples x 8 x 32^3 x 3 x 8 B x 2 fields + 2.7 kB (D), matching 25 test "
                "samples per seed and float64 storage.",
                "Header probe hit its 7.9 MB cap (frame read too large); layout above is from the generator code, not the file.",
            ],
            missing=["python 'fdtd' package version used for the dataset (not pinned in the repo files read)"],
            spd=speed(10.0, "WebGPU FDTD est."),
            source_case=src_case("PDEArena", "pdedatagen/maxwell.py", pa, "pdearena/maxwell.py"),
            sim="pdearena-maxwell3d",
        )
    )
    return cs


class _NoAlias(yaml.SafeDumper):
    def ignore_aliases(self, data):  # no &id anchors in case files
        return True


# ---------------------------------------------------------------------------------------------------------------
# Audit corrections (DevLog/audits/2026-11-06-L7c-eval-c-audit.md; dispositions in DevLog-008 "Audit corrections").
# Applied after all_cases() so the original definitions stay readable; every change is keyed by case id.
# ---------------------------------------------------------------------------------------------------------------

RIGHTS = {  # one rule per licence family; tags from the eval/schema rightsItem enum (authoritative, L8)
    "open_code": (["cite_values", "re_derive_setup", "copy_with_attribution"], []),
    "proprietary": (
        ["cite_values", "re_derive_setup"],
        ["copy_with_attribution", "copy_text", "copy_figures", "copy_input_files"],
    ),
    "open_data": (["cite_values", "re_derive_setup", "reference_by_hash"], []),
    "open_data_and_code": (["cite_values", "re_derive_setup", "reference_by_hash", "copy_with_attribution"], []),
    "odbl_no_hash": (["cite_values", "re_derive_setup"], ["copy_data", "redistribute_data"]),
}
FAMILY = {
    **{
        c: "open_code"
        for c in (
            "EM-02",
            "EM-03",
            "RF-01",
            "RF-03",
            "EM-61",
            "RF-61",
            "WO-04",
            "WO-61",
            "WO-62",
            "WO-63",
            "WO-05",
            "WO-64",
            "SM-61",
            "TR-61",
            "HT-61",
            "SC-02",
            "WO-65",
            "RF-62",
            "FL-05",
            "FL-62",
        )
    },
    **{c: "proprietary" for c in ("EM-05", "CP-03", "CP-04", "CP-06", "FL-61")},
    **{c: "open_data" for c in ("TR-03", "AC-61", "AC-62", "FL-63", "FL-64", "TR-02", "TR-62", "FL-06", "TR-63")},
    "WO-66": "open_data_and_code",
    "FL-07": "odbl_no_hash",
}


def _refs(d, pred):
    return [r for r in d["references"] if pred(r)]


def _ungate(d, note, pred=lambda r: True):
    for r in _refs(d, pred):
        r["gate"] = False
        r["note"] = (r.get("note", "") + "; " if r.get("note") else "") + note


def _dstat(q, note, tol=None):
    return ref(
        q,
        None,
        "1",
        tol
        or {
            "rule": {
                "type": "range",
                "range": [0.0, 1.0],
                "note": "sanity bound only; gate = own self-convergence floor (R3 s.4), pending",
            }
        },
        "P",
        "dataset",
        WELL_PAPER,
        "R3 s.4 protocol; audit S4",
        gate=False,
        note=note,
    )


def apply_audit(d: dict) -> dict:
    cid = d["id"]
    allowed, forbidden = RIGHTS[FAMILY[cid]]
    d["rights"]["allowed"], d["rights"]["forbidden"] = list(allowed), list(forbidden)
    if cid == "SM-61":  # same rule as L7a's SM-21 (code_aster astest, GPL-3.0-or-later; FDL V-docs not used)
        d["rights"]["forbidden"] = ["copy_v_doc_text"]
    for r in d["references"]:
        if r["basis"] == "D":
            r["provenance"]["source_accessed"] = ACC
    pal = "palace docs/src/examples/cpw.md L18-25"
    if cid == "RF-03":  # B1
        d["title"] = "Palace CPW: coplanar waveguide on 500 um C-axis sapphire (uniaxial), quasi-static Z0"
        d["references"] = [
            ref(
                "Z0 (uniaxial sapphire)",
                None,
                "ohm",
                {
                    "rel": 5e-3,
                    "after": "richardson",
                    "note": "partial-capacitance model; finite-substrate correction itself is 3.8e-4, so the model error "
                    "is taken as < 5e-3 (est.)",
                },
                "D",
                "closed_form",
                "uniaxial-to-isotropic map (eps_eq = sqrt(eps_x eps_y), h' = h sqrt(eps_x/eps_y)) + partial-capacitance "
                "conformal map (this lane)",
                f"{pal} (inputs)",
                case="RF-03",
                mid="Z0_anisotropic",
            ),
            ref(
                "Z0 printed by Palace docs",
                56.02,
                "ohm",
                {"rel": 1e-3},
                "P",
                "closed_form",
                "Palace docs citing H. J. Visser, Antenna Theory and Applications (2012)",
                pal,
                gate=False,
                extraction="text",
                note="equals the isotropic eps 9.3 conformal map with the 30 pi prefactor (56.019 "
                "Ohm); not the uniaxial substrate the docs describe (audit B1)",
            ),
            ref(
                "Z0 isotropic eps 9.3 (variant)",
                None,
                "ohm",
                {"rel": 5e-3, "after": "richardson"},
                "D",
                "closed_form",
                "partial-capacitance conformal map (this lane)",
                pal,
                case="RF-03",
                mid="Z0_isotropic_9p3",
                gate=False,
                note="for a solver run with isotropic eps 9.3 only",
            ),
        ]
        d["geometry"]["spec"].update(
            {
                "air_below_substrate": True,
                "grounds": "semi-infinite (solver: wide grounds)",
                "single_line": "Z0 of one isolated CPW (the 3D example has two lines 266 um apart)",
            }
        )
        d["study"] = {
            "type": "stationary",
            "note": "quasi-static 2D: Z0 = 1/(c sqrt(C C0)) from two electrostatic solves",
        }
        d["missing"] = ["enclosure size of the 2D cross-section (solver choice; report the truncation study)"]
        d["assumptions"] = [
            "Uniaxial sapphire, C axis normal to the substrate (cpw.md L21-24): eps 9.3 in plane, "
            "11.5 normal; the planar-interface map to an isotropic layer is exact for the Laplace "
            "equation, the partial-capacitance step is the approximation."
        ]
    if cid == "SC-02":  # B2, S8
        for r in d["references"]:
            r["quantity"] = r["quantity"].replace("J_total", "J (contact current density)")
            r["tolerance"] = {
                "rel": 1e-3,
                "after": "richardson",
                "note": "reference mesh-extrapolated (3 levels, p ~ 2), float128, current continuity "
                "|J_top + J_bot| / |J| < 3e-16; Richardson-minus-finest <= 4.6e-6",
            }
            r["basis"], r["form"] = "D", "solver_ref"
            r["provenance"]["citation"] = (
                "DEVSIM 2.11.2 re-run of the diode_1d set-up in extended precision, three "
                "meshes, Richardson (this lane, validation/c/devsim_diode_tight.py)"
            )
            r["provenance"]["accessed"] = None
            r["provenance"]["source_accessed"] = ACC
        d["materials"] = {
            "si": {
                "eps_r": 11.1,
                "eps0_F_per_cm": 8.85e-14,
                "n_i_per_cm3": 1.0e10,
                "T_K": 300,
                "q_C": 1.6e-19,
                "k_B_J_per_K": 1.3806503e-23,
                "mu_n_cm2_per_Vs": 400.0,
                "mu_p_cm2_per_Vs": 200.0,
                "mobility": "constant",
                "recombination": "SRH, tau_n = tau_p = 1e-8 s, n1 = p1 = n_i",
                "source": "devsim 2.11.2 python_packages/simple_physics.py L34-44 (constants), L122-141 "
                "(SetSiliconParameters); diode_1d.py L24-25 (tau override)",
            }
        }
        d["geometry"]["spec"] = {
            "length_cm": 1e-5,
            "junction_cm": 0.5e-5,
            "doping": "N_A = 1e18 cm^-3 for x < 0.5e-5 cm, N_D = 1e18 cm^-3 for x > 0.5e-5 cm "
            "(diode_common.SetNetDoping)",
            "mesh_cm": "DEVSIM 1D mesh lines: spacing 1e-7 at x = 0 and 1e-5, 1e-9 at the junction "
            "(diode_common.CreateMesh); reference levels divide all three by 1, 2, 4",
        }
        d["bcs"] = [
            {
                "selection": "top (x = 0)",
                "type": "ohmic",
                "params": {"V": "0.1..0.5 step 0.1"},
                "note": "equilibrium carrier densities, Dirichlet potential = bias + built-in",
            },
            {"selection": "bot (x = 1e-5 cm)", "type": "ohmic", "params": {"V": 0}},
        ]
        d["units"] = "SI"
        d["assumptions"] = [
            "Units follow DEVSIM (cm based): J in A/cm^2 for the 1D device.",
            "The DEVSIM golden (double precision, absolute_error 1e10) has |J_top + J_bot|/|J_top| = "
            "2.45e-2, 3.26e-2, 3.5e-3, 1.5e-4, 4e-6 at 0.1-0.5 V and is 4.0e-2, 4.0e-3, 3.0e-4, 3.4e-5, "
            "2.2e-5 off the reference: kept per target in the expected JSON, informative only. "
            "Tightening Newton in double precision does not help (low-bias current is a difference of "
            "large majority fluxes); float128 restores exact continuity.",
        ]
        d["notes"] = [
            "Gate values: validation/c/gen_devsim.py -> devsim_diode_tight.py (extended precision, Newton rel "
            "1e-11, abs 1e4 cm^-3 at the observed round-off floor, mesh / 1, 2, 4)."
        ]
    if cid == "RF-01":  # S1
        _ungate(
            d,
            "duplicate of class-a RF-21 (same closed form); gated there, kept here for traceability",
            lambda r: r.get("metric_id") in ("f_TM010", "f_TE111", "f_TE011", "Q_d"),
        )
        d["title"] = "Palace cylinder: Teflon-filled cavity with copper (impedance) walls, conductor Q of TE011"
    if cid == "FL-62":  # S2
        d["references"][0]["tolerance"] = {
            "rule": {
                "type": "range",
                "range": [1.0891, 1.1000],
                "note": "envelope of all seven TMR codes (CFL3D 1.0909, FUN3D 1.0983, NTS 1.0891, JOE 1.0918, SUMB 1.0904, "
                "TURNS 1.1000, GGNS 1.0941); page: max 1 % lift spread",
            }
        }
        d["references"][0]["bounds"] = [1.0891, 1.1000]
        d["references"][0]["provenance"]["locator"] = (
            "tmbwg.github.io/turbmodels/naca0012_val_sa.html table L160-235, text L122-129"
        )
        d["references"][1]["tolerance"] = {
            "rule": {
                "type": "range",
                "range": [0.01225, 0.01245],
                "note": "envelope of all seven codes (GGNS 0.01225 .. JOE 0.01245); page: max 4 % drag spread",
            }
        }
        d["references"][1]["bounds"] = [0.01225, 0.01245]
        d["references"][1]["provenance"]["locator"] = "naca0012_val_sa.html table L160-235"
        d["reference_results"] = [
            {"alpha_deg": 15, "C_L_range": [1.5446, 1.5642], "C_D_range": [0.02073, 0.02159], "codes": 7}
        ]
        d["notes"] = [
            "Validation-page values on the 897x257 grid (GGNS adaptive); no grid convergence on this page. "
            "The grid-converged numerical-analysis case (naca0012numerics_val_sa.html) gives results only as "
            "plots, so no numeric gate is available from it."
        ]
    if cid == "AC-62":  # S3
        d["bcs"] = [
            {"selection": "x0 (x = -1)", "type": "wall", "note": "pyclaw BC.wall; stored attr x0_wall WALL"},
            {"selection": "xL (x = +1)", "type": "open", "note": "pyclaw BC.extrap; stored attr xL_open OPEN"},
            {"selection": "y0 (y = -1)", "type": "wall", "note": "pyclaw BC.wall; stored attr y0_wall WALL"},
            {"selection": "yL (y = +1)", "type": "open", "note": "pyclaw BC.extrap; stored attr yL_open OPEN"},
        ]
        d["geometry"]["spec"]["domain_generator"] = [[-1.0, 1.0], [-1.0, 1.0]]
        d["materials"] = {
            "medium": {
                "K": 4.0,
                "rho": "stored per sample (maze: walls 1e6 + 3, paths 3)",
                "c": "sqrt(K / rho)",
                "source": "generation/acoustics_2d_interface_maze.py L129-134",
            }
        }
        d["notes"] = [n for n in d["notes"] if "Stored x, y run" not in n] + [
            "BCs (audit S3): authoritative = stored HDF5 boundary_conditions attrs (all three variants: x0 WALL, xL OPEN, "
            "y0 WALL, yL OPEN) and the HF generation script acoustics_2d_interface_maze.py L105-112 (lower = wall, "
            "upper = extrap, both axes). The README ('open in y, reflective in x') disagrees: recorded as a conflict.",
            "Domain: the generator uses [-1, 1]^2 (L114-115); the stored coordinate arrays run 0..1 (relabelled); use "
            "the generator extent for physical lengths.",
        ]
        d["source_case"]["note"] = (
            d["source_case"].get("note", "")
            + "; generation/acoustics_2d_interface_maze.py cached at cache/eval-c/sources/hf/ sha256 "
            + sha("hf/acoustics_2d_interface_maze.py")
        )
    if cid in ("TR-03", "FL-63", "FL-64"):  # S4
        stats = {
            "TR-03": [
                "spatial mean and variance of A and B vs t (all stored frames)",
                "radially averaged power spectrum of A at t = 10000 (pattern wavelength)",
            ],
            "FL-63": [
                "horizontally averaged buoyancy profile b(z), time mean over t in [25, 49.75]",
                "Nusselt number time series (mean and std over t in [25, 49.75])",
            ],
            "FL-64": ["tracer variance and kinetic energy vs t (all stored frames)", "x-averaged u_x(y) profile vs t"],
        }[cid]
        d["references"] = [
            _dstat(
                "VRMSE vs stored frames up to the own predictability horizon",
                "horizon H = first stored frame where our two finest levels differ by VRMSE > 0.1; frames beyond H "
                "are not compared pointwise",
            ),
        ] + [
            _dstat(
                f"statistic: {q}",
                "relative difference of the statistic; long-horizon check instead of last-frame VRMSE (audit S4)",
            )
            for q in stats
        ]
    if cid == "AC-61":  # S5
        d["status"] = "untestable"
        d["untestable_reason"] = (
            "time-harmonic point-source problem: frame 0 does not determine the solution; the "
            "staircase geometry and the per-trajectory source position are not yet extracted"
        )
        d["activation"] = (
            "extract the staircase from the stored mask and x0 per trajectory, then solve the "
            "frequency-domain BVP (PML + quasi-periodic) and compare Re/Im fields at stored phases"
        )
        d["notes"] = [n for n in d["notes"] if not n.startswith("Protocol")] + [
            "Protocol (case-specific): frequency-domain solve of -(lap + omega^2) u = delta(x - x0), u_n = 0 on the "
            "staircase, outgoing; compare u(x) e^{-i omega t_j} with the stored pressure_re/im at the 50 phases."
        ]
    if cid == "WO-66":  # S5, m7
        d["status"] = "untestable"
        d["untestable_reason"] = (
            "stored 32^3 crop holds neither the sources nor the exterior; regeneration needs the "
            "python 'fdtd' package at the dataset's (unpinned) version and the per-sample seed"
        )
        d["activation"] = (
            "pin an fdtd version, reproduce one stored sample from its seed (maxwell.py L65, L148), then "
            "compare our FDTD on the full periodic 64^3 grid against the crop"
        )
        d["notes"] = [n for n in d["notes"] if not n.startswith("Protocol")] + [
            "Protocol (case-specific): regenerate, not integrate-from-frame-0. Note maxwell.py stores grid.E in the "
            "dataset named d_field (L142).",
            "configs/maxwell3d.yaml says samples 32; the test file size implies 25 samples (m7).",
        ]
    if cid == "TR-63":  # S5
        d["status"] = "untestable"
        d["untestable_reason"] = "HDF5 layout, dtype and boundary condition not verified (header probe failed)"
        d["activation"] = (
            "header probe within a new byte budget (walker that lists one sample group only) + BC from sim_diff_react.py"
        )
    if cid == "FL-07":  # S6
        d["status"] = "untestable"
        d["untestable_reason"] = "no content hash for the AirfRANS archive (ODbL data stays out of the repo)"
        d["activation"] = (
            "sha256 of Dataset.zip recorded (10,029,067,577 B, Last-Modified 2022-08-11, ETag 62f519b5-255c76d39)"
        )
        d["dataset"]["file"] = "Dataset.zip"
        d["dataset"]["file_bytes"] = 10029067577
        d["dataset"]["http_etag"] = "62f519b5-255c76d39 (HEAD 2026-11-06)"
    if cid in ("WO-04", "WO-61"):  # S9
        mpb = d["references"]
        for r in mpb:
            r["gate"] = False
        diffs = {"WO-04": ("6.9e-3", "5.2e-3"), "WO-61": ("2.4e-3", "2.4e-3")}[cid]
        mpb[0]["note"] = f"MPB resolution 32; {diffs[0]} above the converged PWE value (gen_pwe.py)"
        mpb[1]["note"] = f"MPB resolution 32; {diffs[1]} above the converged PWE value (gen_pwe.py)"
        d["references"] = [
            ref(
                "gap lower edge (converged)",
                None,
                "1 (c/a)",
                {"rel": 1e-3, "after": "richardson", "note": "PWE last-step change 2e-6; margin 500x"},
                "D",
                "solver_ref",
                "plane-wave expansion (this lane)",
                "validation/c/gen_pwe.py, MPB k path",
                case=cid,
                mid="gap_lower",
            ),
            ref(
                "gap upper edge (converged)",
                None,
                "1 (c/a)",
                {"rel": 1e-3, "after": "richardson", "note": "PWE last-step change 6e-6"},
                "D",
                "solver_ref",
                "plane-wave expansion (this lane)",
                "validation/c/gen_pwe.py, MPB k path",
                case=cid,
                mid="gap_upper",
            ),
        ] + mpb
        d["study"]["resolution_source"] = "MPB resolution 32 (tutorial)"
        # Coordinator rule (16:35): a self-built reference gates only after reproducing the external reference
        # under its own settings. gen_pwe.py is a pure plane-wave expansion (no real-space grid, no subpixel
        # smoothing); MPB's printed edges come from a 32 x 32 grid with anisotropic subpixel averaging, which
        # gen_pwe.py does not implement, so it cannot reproduce them to MPB's printed digits. Not gated.
        for r in d["references"]:
            if r.get("expected"):
                r["gate"] = False
                r["note"] = (r.get("note", "") + "; " if r.get("note") else "") + (
                    "not gated: gen_pwe.py has not reproduced MPB's printed edges at MPB's own settings "
                    "(resolution 32, subpixel averaging); gate after that check (DevLog-008)")
    if cid in ("WO-62", "WO-63", "WO-64"):  # S9
        _ungate(
            d,
            "margin vs a converged reference not measured (MPB/Meep at the tutorial resolution); gate pending an "
            "independent check (DevLog-008 TODO)",
        )
        d["study"]["resolution_source"] = {
            "WO-62": "MPB resolution 32",
            "WO-63": "MPB resolution 16, 5x5 supercell",
            "WO-64": "Meep resolution 20",
        }[cid]
        if cid == "WO-63":
            d["notes"] = (d.get("notes") or []) + [
                "The MPB tutorial quotes the bulk gap as 0.2812-0.4174 at L320 but "
                "prints 0.2826-0.4193 at L120 (resolution 32); PWE converged: "
                "0.28066-0.41717 (WO-04)."
            ]
    if cid == "WO-05":  # S9, m5
        meep = d["references"]
        for r in meep:
            r["gate"] = False
            r["note"] = (r.get("note", "") + "; " if r.get("note") else "") + "Meep resolution 10, informative"
        d["references"] = (
            [
                ref(
                    f"f{i} exact (m = {m})",
                    None,
                    "1 (c/a)",
                    {"rel": 1e-4, "after": "richardson"},
                    "D",
                    "closed_form",
                    "exact annulus TM resonance (this lane)",
                    "validation/c/gen_suites.py wo05",
                    case="WO-05",
                    mid=f"f{i}",
                )
                for i, m in ((1, 3), (2, 4), (3, 5))
            ]
            + [
                ref(
                    f"Q{i} exact",
                    None,
                    "1",
                    {"rel": 1e-2, "after": "richardson"},
                    "D",
                    "closed_form",
                    "exact annulus TM resonance (this lane)",
                    "validation/c/gen_suites.py wo05",
                    case="WO-05",
                    mid=f"Q{i}",
                )
                for i in (1, 2, 3)
            ]
            + meep
        )
        d["study"]["resolution_source"] = "Meep resolution 10 (tutorial)"
    if cid == "EM-05":  # m1
        for r in d["references"]:
            if r.get("metric_id") in ("By_center_re", "By_center_im"):
                r["tolerance"] = {"abs": 4.2e-5, "after": "richardson", "note": "2e-3 of |By(0,0)| = 0.02105 T"}
            if r.get("quantity", "").startswith("VM166 target loss"):
                r["note"] = (
                    "VM166 states a quarter-symmetry model (Analysis Assumptions); equals full-section loss / 4 "
                    "to 2.3e-5; Ansys quarter-model results 2341.3 (PLANE13) / 2315.2 (PLANE233) W/m"
                )
        d["assumptions"] = [a for a in d["assumptions"]] + [
            "Quarter-symmetry reading of 2288 W/m is stated on the VM166 page (audit m1)."
        ]
    if cid == "SM-61":  # m2
        d["reference_results"][1]["f_Hz"] = [431.891559270, 1266.00555, 1500.76348, 2873.53437, 3799.96925, 4370.82061]
    if cid == "EM-03":  # m3
        for r in d["references"]:
            if r.get("metric_id") == "M_ab":
                r["gate"] = False
                r["note"] = "small-loop limit printed by Palace; 0.38 % below the exact filament-loop value"
        d["references"].insert(
            0,
            ref(
                "M_ab (exact coplanar filament loops)",
                None,
                "H",
                {"rel": 5e-3, "after": "richardson", "note": "remaining model error: 1 um strip width (est. < 5e-3)"},
                "D",
                "closed_form",
                "Maxwell mutual inductance of coaxial coplanar loops (this lane)",
                "palace docs/src/examples/rings.md L42 (inputs)",
                case="EM-03",
                mid="M_ab_filament_exact",
            ),
        )
    if cid == "HT-61":  # m4
        d["bcs"] = d["bcs"] + [{"selection": "domain", "type": "source", "value": 1.0, "note": "-lap u = f, f = 1"}]
    # I1 engine wiring (DevLog-014 s.5 item 8): spec pointers and extract lines, preserved by this builder
    wiring = {
        "EM-02": ("sims/two-spheres.yaml", {"C_aa": {"kind": "scalar", "name": "C_ta_ta"},
                                            "C_bb": {"kind": "scalar", "name": "C_tb_tb"},
                                            "C_ab": {"kind": "scalar", "name": "C_ta_tb"}}),
        "EM-03": ("sims/coplanar-rings.yaml", {"M_ab_filament_exact": {"kind": "scalar", "name": "L_ra_rb"},
                                               "M_ab": {"kind": "scalar", "name": "L_ra_rb"},
                                               "L_aa": {"kind": "scalar", "name": "L_ra_ra"},
                                               "L_bb": {"kind": "scalar", "name": "L_rb_rb"}}),
        "RF-01": ("sims/cylinder-cavity.yaml", {"f_TM010": {"kind": "eigen", "floor": 1.0e6, "index": 0},
                                                "f_TE111": {"kind": "eigen", "floor": 1.0e6, "index": 1},
                                                "f_TE011": {"kind": "eigen", "floor": 1.0e6, "index": 11},
                                                "Q_d": {"kind": "scalar", "name": "Q_0"}}),
    }
    if cid in wiring:
        d["spec"], ex = wiring[cid]
        for r in d["references"]:
            if r.get("metric_id") in ex:
                r["extract"] = ex[r["metric_id"]]
        if cid == "RF-01":
            d["notes"] = (d.get("notes") or []) + ["Q_c_TE011 and Q_TE011_copper need a surface-impedance BC, not yet "
                                                   "in the engine: these targets stay pending (DevLog-014 s.5 item 8)."]
    # every target gets an explicit, unique metric_id (L8 loader: engine looks targets up by metric_id)
    used = {r["metric_id"] for r in d["references"] if r.get("metric_id")}
    prefix = {"WO-05": "meep_", "WO-04": "mpb_", "WO-61": "mpb_"}.get(cid, "")
    for r in d["references"]:
        if r.get("metric_id"):
            continue
        base = re.sub(r"[^A-Za-z0-9]+", "_", r["quantity"]).strip("_")
        mid = base if base not in used else prefix + base if prefix else base + "_info"
        i = 2
        while mid in used:
            mid, i = f"{base}_{i}", i + 1
        new = {"quantity": r["quantity"], "metric_id": mid}
        new.update({k: v for k, v in r.items() if k != "quantity"})
        r.clear()
        r.update(new)
        used.add(mid)
    return d


def dump(d: dict) -> str:
    head = (
        f"# {d['id']}: {d['title']}\n# Built by validation/c/build_cases.py (lane L7c, DevLog-008). Schema amp-eval/0 "
        f"(eval/schema/amp-eval-0.schema.json).\n"
    )
    return head + yaml.dump(
        d, Dumper=_NoAlias, sort_keys=False, allow_unicode=False, width=120, default_flow_style=None
    )


def main() -> int:
    force = "--force" in sys.argv
    CASES.mkdir(parents=True, exist_ok=True)
    ids = []
    for d in map(apply_audit, all_cases()):
        p = CASES / f"{d['id']}.yaml"
        ids.append(d["id"])
        if p.exists() and not force:
            continue
        p.write_text(dump(d))
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        raise SystemExit(f"duplicate ids {dup}")
    print(len(ids), "cases:", " ".join(sorted(ids)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
