# SPDX-License-Identifier: GPL-3.0-or-later
"""Prints the core polygon of sims/si-grating-coupler-2d.yaml (uniform grating, N periods, tooth first) (edges: e0 = input end x = 0, e1 = bottom, e2 = output end x = X, independent of N) as a YAML flow
list of [x, y] expression pairs in the sim's params (xg0, Lam, ff, t_si, etch, X). The geometry kernel has no array
feature, so the N grooves are notches of one polygon. Run: cd validation && uv run python photonics2/grating_polygon.py [N]
"""

from __future__ import annotations

import sys


def points(n: int) -> list[list[str]]:
    pts = [["0 um", "t_si"], ["0 um", "0 um"], ["X", "0 um"], ["X", "t_si"]]   # edges e0 left, e1 bottom, e2 right
    for k in range(n - 1, -1, -1):
        x1 = f"xg0 + {k + 1}*Lam"
        x0 = f"xg0 + {k}*Lam + ff*Lam" if k else "xg0 + ff*Lam"
        pts += [[x1, "t_si"], [x1, "t_si - etch"], [x0, "t_si - etch"], [x0, "t_si"]]
    return pts


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    print("[" + ", ".join(f'["{a}", "{b}"]' for a, b in points(n)) + "]")
