"""Class-b checks on top of L8's schema validation, and the DevLog result table.

Checks per case (eval/cases/b/*.yaml): class b; id equals file name; new IDs in 41-59 unless carried from R3;
source.citation and source.doi (or 'N/A' with open_copy); source.open_access boolean; every reference has
extraction and provenance.locator; every `missing` item is {input, assumption}; no 'FILL' placeholders;
every `cache:` path exists with a sidecar whose sha256 matches the case.

Usage: uv run --no-project --with pyyaml python validation/b/check_cases.py [--table]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
R3_IDS = {"FL-02", "FL-03", "FL-04", "CP-01", "CP-07", "CP-08", "WO-02", "AC-01"}


def walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)


def check(f: Path) -> tuple[list[str], dict]:
    errs: list[str] = []
    text = f.read_text()
    c = yaml.safe_load(text)
    cid = c.get("id")
    if cid != f.stem:
        errs.append("id != file name")
    if c.get("class") != "b":
        errs.append("class != b")
    m = re.match(r"^[A-Z]{2}-(\d{2})$", cid or "")
    if cid not in R3_IDS and not (m and 41 <= int(m.group(1)) <= 59):
        errs.append("new class-b id outside 41-59")
    if "FILL" in text:
        errs.append("unfilled sha256")
    s = c.get("source") or {}
    if not s.get("citation"):
        errs.append("source.citation")
    if not s.get("doi"):
        errs.append("source.doi")
    if not isinstance(s.get("open_access"), bool):
        errs.append("source.open_access not boolean")
    for r in c.get("references", []):
        if "extraction" not in r:
            errs.append(f"reference {r.get('quantity')}: no extraction")
        if not (r.get("provenance") or {}).get("locator"):
            errs.append(f"reference {r.get('quantity')}: no locator")
    for it in c.get("missing") or []:
        if not (isinstance(it, dict) and it.get("input") and it.get("assumption")):
            errs.append(f"missing item without input/assumption: {it}")
    for d in walk(c):
        if "cache" in d and "sha256" in d:
            side = ROOT / (d["cache"] + ".json")
            if not side.exists():
                errs.append(f"cache sidecar missing: {d['cache']} (cache/ is local only)")
            elif json.loads(side.read_text())["sha256"] != d["sha256"]:
                errs.append(f"sha256 mismatch: {d['cache']}")
    return errs, c


def row(c: dict) -> str:
    refs = [r for r in c["references"] if r.get("gate", True)]
    r0 = refs[0] if refs else c["references"][0]
    val = r0.get("value")
    if isinstance(val, list):
        v = f"{len(val)} values, first {val[0]:g}"
    elif val is None:
        b = r0.get("bounds")
        v = f"bounds {b[0]:g}-{b[1]:g}" if b else "rule"
    else:
        v = f"{val:g}"
    loc = r0["provenance"]["locator"].split(";")[0][:60]
    oa = "yes" if c["source"].get("open_access") else "no"
    ext = sorted({(r.get("extraction") if isinstance(r.get("extraction"), str) else r["extraction"].get("method"))
                  for r in c["references"]})
    return (f"| {c['id']} | {', '.join(c['physics'])} | {c['source']['citation'].split(',')[0][:28]} "
            f"{c['source']['doi']} | {loc} | {r0['quantity']} ({len(c['references'])} targets) | {v} {r0['unit']} | "
            f"{oa} | {'/'.join(ext)} | {len(c.get('missing') or [])} |")


def main() -> int:
    files = sorted((ROOT / "eval/cases/b").glob("*.yaml"))
    bad = 0
    cases = []
    for f in files:
        errs, c = check(f)
        cases.append(c)
        if errs:
            bad += 1
            print(f"FAIL {f.stem}: " + "; ".join(errs))
    print(f"{len(files)} cases, {bad} with errors")
    if "--table" in sys.argv:
        print("| ID | Physics | Paper (first author / DOI) | Locator (first gated target) | Target | Value | Open access | Extraction | Missing inputs |")
        print("|---|---|---|---|---|---|---|---|---|")
        for c in cases:
            print(row(c))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
