# SPDX-License-Identifier: GPL-3.0-or-later
"""Regression test: rebuilding the class-a cases must not change downstream-owned fields (spec, extract, metric_id,
convergence.h_factors, convergence.expected_order) and must leave the expected values reproducible.

Steps: copy eval/cases/a to a temp dir, rebuild there in place with --force (merging preserved fields), compare
every case semantically and byte-wise with eval/cases/a, then run `run_all.py --check`.
Nothing in the repo is written except the run_all log.

Run: cd validation && uv run python a/test_build_preserves.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml
from build_cases import PRESERVE_CONVERGENCE, PRESERVE_REFERENCE, PRESERVE_TOP
from common import CASES_DIR

HERE = Path(__file__).resolve().parent


def diff_paths(a: Any, b: Any, path: str = "") -> list[str]:
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b), key=str):
            if k not in a or k not in b:
                out.append(f"{path}/{k} (only in {'repo' if k not in a else 'rebuilt'})")
            else:
                out += diff_paths(a[k], b[k], f"{path}/{k}")
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return [x for i, (u, v) in enumerate(zip(a, b, strict=True)) for x in diff_paths(u, v, f"{path}/{i}")]
    return [] if a == b else [f"{path} (changed)"]


def preserved_paths(d: dict[str, Any]) -> list[str]:
    out = [f"/{k}" for k in PRESERVE_TOP if k in d]
    out += [f"/convergence/{k}" for k in PRESERVE_CONVERGENCE if k in (d.get("convergence") or {})]
    for i, r in enumerate(d.get("references") or []):
        out += [f"/references/{i}/{k}" for k in PRESERVE_REFERENCE if k in r]
    return out


def main() -> int:
    fails = 0
    with tempfile.TemporaryDirectory(prefix="l7a-rebuild-") as td:
        for f in CASES_DIR.glob("*.yaml"):
            shutil.copy2(f, Path(td) / f.name)  # rebuild in place over a copy of the repo cases
        p = subprocess.run([sys.executable, str(HERE / "build_cases.py"), "--out", td, "--preserve-from", td,
                            "--force"], capture_output=True, text=True, cwd=HERE)
        print(p.stdout.strip())
        if p.returncode != 0:
            print(p.stderr)
            return 1
        n_pres = 0
        for f in sorted(CASES_DIR.glob("*.yaml")):
            repo = yaml.safe_load(f.read_text())
            rebuilt = yaml.safe_load((Path(td) / f.name).read_text())
            pres = preserved_paths(repo)
            n_pres += len(pres)
            d = diff_paths(rebuilt, repo)
            bad_pres = [x for x in d if any(x.startswith(pp) for pp in pres)]
            if bad_pres:
                fails += 1
                print(f"FAIL {f.name}: preserved fields changed: {bad_pres}")
            other = [x for x in d if x not in bad_pres]
            if other:
                print(f"note {f.name}: builder differs from repo outside preserved fields: {other}")
        print(f"preserved-field paths checked: {n_pres}; cases with a preserved-field change: {fails}")
        changed = [f.name for f in sorted(CASES_DIR.glob("*.yaml"))
                   if f.read_bytes() != (Path(td) / f.name).read_bytes()]
        print(f"files changed byte-wise by an in-place --force rebuild: {len(changed)} {changed if changed else ''}")
    c = subprocess.run([sys.executable, str(HERE / "run_all.py"), "--check"], capture_output=True, text=True, cwd=HERE)
    print(c.stdout.strip())
    if c.returncode != 0:
        fails += 1
    print("test_build_preserves:", "ok" if fails == 0 else "FAILED")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
