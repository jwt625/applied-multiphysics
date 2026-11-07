# SPDX-License-Identifier: GPL-3.0-or-later
"""Local checks for eval/cases/c/*.yaml (lane L7c, DevLog-008). The authoritative schema check is lane L8's
`node packages/eval/src/cli.ts --class c --dry-run`; this script adds:

  1. JSON Schema validation against eval/schema/amp-eval-0.schema.json (if `jsonschema` is importable),
  2. id == file name, class == c, ID range rule (R3 ids or 61-79 for new class-c ids, CONTRACTS-v0 changelog),
  3. every reference with `expected` has the same value as eval/expected/<ID>.json (and the JSON is class c),
  4. every basis P/S reference has an ISO `accessed` date and a non-empty locator,
  5. no mention of COMSOL anywhere in a case file (DevLog-001 Q5),
  6. rights tags are in the eval/schema rightsItem enum (authoritative vocabulary),
     and reference_by_hash requires dataset.hash.

Run: cd validation && uv run python c/validate_cases.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "eval" / "cases" / "c"
R3_C_IDS = {
    "EM-02",
    "EM-03",
    "EM-05",
    "RF-01",
    "RF-03",
    "WO-04",
    "WO-05",
    "FL-05",
    "FL-06",
    "FL-07",
    "TR-02",
    "TR-03",
    "SC-02",
    "CP-03",
    "CP-04",
    "CP-06",
}


def main() -> int:
    errs: list[str] = []
    try:
        import jsonschema

        schema = json.loads((ROOT / "eval" / "schema" / "amp-eval-0.schema.json").read_text())
        validator = jsonschema.Draft202012Validator(schema)
    except ImportError:
        validator = None
        print("jsonschema not importable: schema step skipped (use the L8 CLI)")
    files = sorted(CASES.glob("*.yaml"))
    n_refs = 0
    for p in files:
        d = yaml.safe_load(p.read_text())
        cid = p.stem
        if validator is not None:
            for e in validator.iter_errors(json.loads(json.dumps(d, default=str))):
                errs.append(f"{cid}: schema {'/'.join(map(str, e.path))}: {e.message[:160]}")
        if d.get("id") != cid:
            errs.append(f"{cid}: id {d.get('id')} != file name")
        if d.get("class") != "c":
            errs.append(f"{cid}: class {d.get('class')}")
        nn = int(re.match(r"^[A-Z]+-(\d+)", cid).group(1))
        if cid not in R3_C_IDS and not 61 <= nn <= 79:
            errs.append(f"{cid}: new class-c id outside 61-79")
        vocab = set(
            json.loads((ROOT / "eval" / "schema" / "amp-eval-0.schema.json").read_text())["$defs"]["rightsItem"]["enum"]
        )
        tags = set(d["rights"]["allowed"]) | set(d["rights"]["forbidden"])
        if tags - vocab:
            errs.append(f"{cid}: rights tags outside the contract vocabulary: {sorted(tags - vocab)}")
        if "reference_by_hash" in d["rights"]["allowed"] and not (d.get("dataset") or {}).get("hash"):
            errs.append(f"{cid}: reference_by_hash without dataset.hash")
        if "comsol" in p.read_text().lower():
            errs.append(f"{cid}: mentions COMSOL")
        for r in d["references"]:
            n_refs += 1
            pv = r["provenance"]
            if r["basis"] in ("P", "S") and not re.match(r"^\d{4}-\d{2}-\d{2}$", str(pv.get("accessed"))):
                errs.append(f"{cid}: {r['quantity']}: basis {r['basis']} without ISO accessed date")
            if not pv.get("locator"):
                errs.append(f"{cid}: {r['quantity']}: empty locator")
            if "expected" in r:
                ex = json.loads((ROOT / r["expected"]["file"]).read_text())
                if ex.get("class") != "c" or ex.get("schema") != "amp-eval-expected/0":
                    errs.append(f"{cid}: expected file not class-c amp-eval-expected/0")
                vals = {t["metric_id"]: t["value"] for t in ex["targets"]}
                mid = r["expected"]["metric_id"]
                if mid not in vals:
                    errs.append(f"{cid}: metric {mid} not in expected JSON")
                elif vals[mid] != r["value"]:
                    errs.append(f"{cid}: {mid} YAML {r['value']} != JSON {vals[mid]}")
    for e in errs:
        print("ERROR", e)
    print(f"{len(files)} cases, {n_refs} references, {len(errs)} errors")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
