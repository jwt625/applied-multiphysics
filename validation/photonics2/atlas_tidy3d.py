# SPDX-License-Identifier: GPL-3.0-or-later
"""Second reference of the thin-film LN rib cases WO-82 (air clad) and WO-83 (oxide clad): the Tidy3D finite-difference
mode-solver results of the sibling repository eo-modulator-atlas (own work of the same author, read only;
validation/reference/K2-tidy3d.json and K3-tidy3d.json, 2026-10-14, re-extrapolated 2026-10-15).

The values are written inline into validation/c/cases_ext/modes.py (TIDY3D) because a case can have only one expected
file (eval/expected/<ID>.json, owned by validation/modes3/references.py). This script re-reads the atlas files, checks
their sha256 and that the inline values equal the files, and prints the table used in DevLog-062.

Run: cd validation && uv run python photonics2/atlas_tidy3d.py [--atlas ../../eo-modulator-atlas]
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", default=str(ROOT.parent / "eo-modulator-atlas"))
    a = ap.parse_args()
    spec = importlib.util.spec_from_file_location("modes_ext", ROOT / "validation" / "c" / "cases_ext" / "modes.py")
    assert spec and spec.loader
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    fails = 0
    for cid, k in (("WO-82", "K2"), ("WO-83", "K3")):
        p = Path(a.atlas) / "validation" / "reference" / f"{k}-tidy3d.json"
        if not p.exists():
            print(f"{p} not found (sibling repository absent): nothing checked")
            return 2
        raw = p.read_bytes()
        d = json.loads(raw)
        inline = m.TIDY3D[k]
        sha = hashlib.sha256(raw).hexdigest()
        if sha != inline["sha256"]:
            print(f"{cid}: sha256 {sha} differs from the inline {inline['sha256']}")
            fails += 1
        for q in ("n_eff", "ng_tidy3d", "te_fraction"):
            e = d["extrapolated"][q]
            ok = e["f_ext"] == inline[q]["value"] and e["U"] == inline[q]["U"]
            fails += 0 if ok else 1
            print(f"{cid} {q:12s} f_ext {e['f_ext']:.10f}  U {e['U']:.3e}  levels {['%.7f' % v for v in e['f']]}  p {e['p_observed']:.3f}  {'ok' if ok else 'MISMATCH'}")
    print("atlas_tidy3d:", "ok" if fails == 0 else "FAILED")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
