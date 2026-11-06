"""Replace `sha256: FILL` on lines that also name `cache: <path>` with the sha256 from the cache sidecar JSON.

Hashes are never typed by hand. Usage: uv run --no-project python validation/b/fill_hashes.py
Exit 1 if a FILL remains (missing cache file or sidecar).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAT = re.compile(r"cache: (cache/eval-b/[^,\s}]+)")


def main() -> int:
    left = 0
    for f in sorted((ROOT / "eval/cases/b").glob("*.yaml")):
        lines = f.read_text().splitlines(keepends=True)
        changed = False
        for i, line in enumerate(lines):
            if "sha256: FILL" not in line:
                continue
            m = PAT.search(line)
            side = ROOT / (m.group(1) + ".json") if m else None
            if side is None or not side.exists():
                print(f"{f.name}:{i + 1}: no sidecar for FILL")
                left += 1
                continue
            sha = json.loads(side.read_text())["sha256"]
            lines[i] = line.replace("sha256: FILL", f"sha256: {sha}")
            changed = True
        if changed:
            f.write_text("".join(lines))
    print("unfilled:", left)
    return 1 if left else 0


if __name__ == "__main__":
    sys.exit(main())
