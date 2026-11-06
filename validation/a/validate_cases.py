# SPDX-License-Identifier: GPL-3.0-or-later
"""Minimal validator for amp-eval/0 case files (R3 s.2), used until lane L8's loader lands.

Checks: strict top-level keys, enums, id/file/class consistency, per-reference required fields, tolerance form,
spec block, and for basis D that eval/expected/<ID>.json exists, carries generator/versions/timestamp, and holds the
same value as the YAML.

Run: cd validation && uv run python a/validate_cases.py [paths...]   (default: eval/cases/a/*.yaml)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]

R3_KEYS = ["schema", "id", "class", "title", "status", "untestable_reason", "physics", "dimension", "units", "geometry",
           "materials", "bcs", "initial", "study", "references", "reference_results", "convergence", "speed", "dataset",
           "rights", "hero", "missing", "assumptions"]
# Additions by L7a (see DevLog-006 Contract requests): spec (C8), field_reference, source_case
EXTRA_KEYS = ["spec", "field_reference", "source_case"]
STATUS = {"unvalidated", "verified", "validated", "measured_regression", "untestable"}
DIMS = {"1D", "2D", "2D-axisym", "2D-periodic", "3D"}
GEOM_KINDS = {"analytic", "layer_stack", "step_ref", "dataset_grid"}
STUDY = {"stationary", "transient", "eigen", "frequency", "parametric"}
BASIS = {"P", "S", "D"}
FORMS = {"closed_form", "benchmark", "paper_sim", "paper_measured", "solver_ref", "dataset"}
TAGS = {"heat-cond", "heat-conv", "heat-rad", "heat-transient", "solid-linear", "solid-thermal-stress", "solid-modal",
        "solid-buckling", "solid-contact", "solid-plasticity", "electrostatics", "magnetostatics", "currents", "eddy",
        "rf-waveguide", "rf-sparams", "rf-antenna", "rf-resonator", "optics-modes", "optics-scattering", "optics-phc",
        "acoustics", "stokes", "laminar-ns", "porous", "turbulent", "transport-diffusion", "transport-reaction",
        "semiconductor-dd"}
COUPLED = {"joule", "thermoelastic", "piezo", "eof", "fsi", "thermo-optic", "optomech"}
REF_REQ = ["quantity", "value", "unit", "tolerance", "basis", "form", "provenance"]


def check(path: Path) -> list[str]:
    e: list[str] = []
    try:
        d = yaml.safe_load(path.read_text())
    except yaml.YAMLError as x:
        return [f"YAML parse error: {x}"]
    if not isinstance(d, dict):
        return ["top level is not a mapping"]
    for k in R3_KEYS:
        if k not in d:
            e.append(f"missing key: {k}")
    for k in d:
        if k not in R3_KEYS and k not in EXTRA_KEYS:
            e.append(f"unknown key: {k}")
    if d.get("schema") != "amp-eval/0":
        e.append("schema != amp-eval/0")
    cid = d.get("id", "")
    if not re.fullmatch(r"[A-Z]{2}-\d{2}", str(cid)):
        e.append(f"bad id: {cid}")
    if path.stem != cid:
        e.append(f"file name {path.stem} != id {cid}")
    if d.get("class") not in {"a", "b", "c"} or path.parent.name != d.get("class"):
        e.append(f"class {d.get('class')} vs directory {path.parent.name}")
    if d.get("status") not in STATUS:
        e.append(f"bad status {d.get('status')}")
    if d.get("status") == "untestable" and not d.get("untestable_reason"):
        e.append("untestable without untestable_reason")
    for t in d.get("physics") or []:
        if t not in TAGS and not (t.startswith("coupled-") and t.removeprefix("coupled-") in COUPLED):
            e.append(f"unknown physics tag {t}")
    if not d.get("physics"):
        e.append("physics empty")
    if d.get("dimension") not in DIMS:
        e.append(f"bad dimension {d.get('dimension')}")
    g = d.get("geometry") or {}
    if g.get("kind") not in GEOM_KINDS or "spec" not in g:
        e.append("geometry needs kind in enum and spec")
    if not isinstance(d.get("materials"), dict) or not d["materials"]:
        e.append("materials empty")
    for name, m in (d.get("materials") or {}).items():
        if not isinstance(m, dict) or not m.get("source"):
            e.append(f"material {name} without source")
    if not isinstance(d.get("bcs"), list) or not d["bcs"]:
        e.append("bcs empty")
    for i, b in enumerate(d.get("bcs") or []):
        if "selection" not in b or "type" not in b:
            e.append(f"bcs[{i}] needs selection and type")
    if (d.get("study") or {}).get("type") not in STUDY:
        e.append(f"bad study type {(d.get('study') or {}).get('type')}")
    refs = d.get("references") or []
    if not refs:
        e.append("no references")
    exp = None
    gated = 0
    for i, r in enumerate(refs):
        for k in REF_REQ:
            if k not in r:
                e.append(f"references[{i}] missing {k}")
        if r.get("basis") not in BASIS:
            e.append(f"references[{i}] bad basis")
        if r.get("form") not in FORMS:
            e.append(f"references[{i}] bad form")
        tol = r.get("tolerance") or {}
        if not any(k in tol for k in ("rel", "abs", "rule")):
            e.append(f"references[{i}] tolerance needs rel, abs or rule")
        pv = r.get("provenance") or {}
        if not pv.get("citation") or not pv.get("locator"):
            e.append(f"references[{i}] provenance needs citation and locator")
        if r.get("basis") == "P" and not pv.get("accessed"):
            e.append(f"references[{i}] basis P needs accessed date")
        if not isinstance(r.get("value"), (int, float)):
            e.append(f"references[{i}] value not numeric")
        gated += 1 if r.get("gate", True) else 0
        if r.get("basis") == "D":
            x = r.get("expected") or {}
            f = REPO / str(x.get("file", ""))
            if not f.is_file():
                e.append(f"references[{i}] expected file missing: {x.get('file')}")
                continue
            if exp is None:
                exp = json.loads(f.read_text())
                for k in ("generator", "versions", "generated_at", "targets"):
                    if k not in exp:
                        e.append(f"{f.name} missing {k}")
                if not (REPO / exp.get("generator", "")).is_file():
                    e.append(f"{f.name} generator path not found: {exp.get('generator')}")
            vals = {t["metric_id"]: t for t in exp.get("targets", [])}
            t = vals.get(x.get("metric_id"))
            if t is None:
                e.append(f"references[{i}] metric {x.get('metric_id')} not in {f.name}")
            elif t["value"] != r.get("value"):
                e.append(f"references[{i}] value {r.get('value')} != expected {t['value']}")
            elif "precision" not in t:
                e.append(f"references[{i}] expected target lacks precision record")
    if gated == 0:
        e.append("no gated reference")
    sp = d.get("speed") or {}
    if "budget_s" not in sp or not {"browser", "native"} <= set(sp["budget_s"] or {}):
        e.append("speed.budget_s needs browser and native")
    rt = d.get("rights") or {}
    for k in ("source_license", "allowed", "forbidden"):
        if k not in rt:
            e.append(f"rights missing {k}")
    h = d.get("hero") or {}
    if not isinstance(h.get("suitable"), bool) or not h.get("why"):
        e.append("hero needs suitable (bool) and why")
    s = d.get("spec")
    if s is None:
        e.append("spec missing (C8)")
    elif isinstance(s, dict):
        if s.get("status") == "pending" and not s.get("reason"):
            e.append("spec pending without reason")
        if s.get("ref") and not re.fullmatch(r"sims/[a-z0-9-]+\.yaml", s["ref"]):
            e.append(f"spec.ref bad form {s['ref']}")
    for k in ("missing", "assumptions"):
        if not isinstance(d.get(k), list):
            e.append(f"{k} must be a list")
    return e


def main(argv: list[str]) -> int:
    paths = [Path(p) for p in argv] or sorted((REPO / "eval" / "cases" / "a").glob("*.yaml"))
    n_bad = 0
    for p in paths:
        errs = check(p.resolve())
        if errs:
            n_bad += 1
            print(f"FAIL {p.name}")
            for x in errs:
                print(f"  - {x}")
    print(f"validated {len(paths)} case files: {len(paths) - n_bad} pass, {n_bad} fail")
    return 1 if n_bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
