# SPDX-License-Identifier: GPL-3.0-or-later
"""Regression test: a fresh class-c build must reproduce eval/cases/c byte for byte, so a rebuild never reverts
edits made in the case files (DevLog-029 O6, DevLog-035 s.13; T2 wiring in build_cases.py, DevLog-039).

Steps: build all class-c cases into a temp dir (`build_cases.py --force --out DIR`), compare every file with
eval/cases/c, report files that differ or exist on one side only. Nothing in the repo is written.

Run: cd validation && uv run python c/test_build_matches.py
"""

from __future__ import annotations

import difflib
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = HERE.parents[1] / "eval" / "cases" / "c"


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="t2-rebuild-c-") as td:
        p = subprocess.run([sys.executable, str(HERE / "build_cases.py"), "--force", "--out", td],
                           capture_output=True, text=True, cwd=HERE.parent)
        if p.returncode != 0:
            print(p.stdout, p.stderr)
            return 1
        built = {f.name: f for f in Path(td).glob("*.yaml")}
        repo = {f.name: f for f in CASES.glob("*.yaml")}
        fails = 0
        for name in sorted(set(built) | set(repo)):
            if name not in built or name not in repo:
                fails += 1
                print(f"FAIL {name}: only in {'repo' if name in repo else 'rebuilt'}")
                continue
            a, b = repo[name].read_text(), built[name].read_text()
            if a != b:
                fails += 1
                diff = list(difflib.unified_diff(a.splitlines(), b.splitlines(), "repo", "rebuilt", n=0, lineterm=""))
                print(f"FAIL {name}: {len(diff)} diff lines")
                print("\n".join(diff[:20]))
        print(f"class-c cases compared: {len(repo)}; differing: {fails}")
    print("test_build_matches:", "ok" if fails == 0 else "FAILED")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
