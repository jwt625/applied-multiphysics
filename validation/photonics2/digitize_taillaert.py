# SPDX-License-Identifier: GPL-3.0-or-later
"""Digitize the dashed "power up" curve of D. Taillaert et al., Jpn. J. Appl. Phys. 45, 6071 (2006), Fig. 3 (p.6072):
upward radiated power of a uniform SOI grating (period 630 nm, etch 70 nm, fill 0.5; 220 nm Si, 1 um oxide, Si
substrate, air top; TE; 2D eigenmode expansion with PML) vs wavelength.

Input: a 600 dpi render of the author copy's page 2 (pdftoppm -f 2 -l 2 -r 600 -png Taillaert2006_JJAP.pdf p2; author
copy biblio.ugent.be/publication/354299/file/571130.pdf). The PDF and the render are not committed (rights).
Calibration (found on the render, checked here): plot frame columns 2767.5 (1500 nm) and 4374 (1650 nm), x ticks at
columns 3303 / 3838 (1550 / 1600 nm); y ticks at rows 2700.0, 2894.5, 3089.5, 3284.5, 3479.0, 3674.0 (0.6 .. 0.1),
linear fit; frame bottom 3869.5 (fit value 0.000).
For a wavelength the dark pixels (grey < 128) of the column inside the value band 0.36..0.52 are the dashed curve
(inside the legend's columns only rows below its bottom line count); the curve is tracked from 1620 nm downwards,
choosing in each column the run nearest (within 0.02) to the previous value; if the column falls in a dash
gap, the nearest column within +-40 px (3.7 nm) that has the curve is used and its wavelength reported. Value = mean
row of the run; line_extent = the run's first / last row; the reading resolution is half the run extent plus 1 px of
calibration. Usage: uv run python photonics2/digitize_taillaert.py <p2-2.png>  -> writes photonics2/taillaert2006_fig3.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
X_PX = (2767.5, 4374.0)          # 1500, 1650 nm
X_TICKS = {1550.0: 3303.0, 1600.0: 3838.0}
Y_TICKS = {0.6: 2700.0, 0.5: 2894.5, 0.4: 3089.5, 0.3: 3284.5, 0.2: 3479.0, 0.1: 3674.0}
LAMS = [1500.0 + 10 * i for i in range(13)]


def main() -> int:
    a = np.asarray(Image.open(sys.argv[1]).convert("L")).astype(int)
    if a.shape != (7017, 4959):
        raise SystemExit(f"unexpected render size {a.shape}: use pdftoppm -r 600 of page 2")
    dark = a < 128
    vs = np.array(list(Y_TICKS.keys()))
    rs = np.array(list(Y_TICKS.values()))
    k, b0 = np.polyfit(rs, vs, 1)                    # value = k * row + b0
    resid = float(np.max(np.abs(k * rs + b0 - vs)))
    col = lambda lam: X_PX[0] + (X_PX[1] - X_PX[0]) * (lam - 1500.0) / 150.0  # noqa: E731
    xres = max(abs(col(l) - c) for l, c in X_TICKS.items())
    # legend box (frame lines found on the render): right edge and bottom line; inside its columns only rows below it count
    legend_cols = [c for c in range(2780, 3800) if dark[2640:2940, c].mean() > 0.9]
    legend_rows = [r for r in range(2900, 3000) if dark[r, 2800:3200].mean() > 0.9]
    legend_right, legend_bottom = max(legend_cols), max(legend_rows)
    r_lo, r_hi = int((0.50 - b0) / k), int((0.38 - b0) / k)

    def runs_at(c: int) -> list[list[int]]:
        rows = [r for r in range(r_lo, r_hi) if dark[r, c] and not (c <= legend_right + 2 and r <= legend_bottom + 4)]
        out: list[list[int]] = []
        for r in rows:
            if out and r - out[-1][-1] <= 1:
                out[-1].append(r)
            else:
                out.append([r])
        return [u for u in out if len(u) <= 8]          # curve strokes are about 4-6 px thick at 600 dpi

    # track the curve from the long-wavelength end (no other curve and no legend in the band there) downwards:
    # in each column the run closest to the previously accepted value is the dashed curve
    pts = []
    prev = None
    for lam in sorted(LAMS, reverse=True):
        c0 = int(round(col(lam)))
        hit = None
        for dc in sorted(range(-40, 41), key=abs):
            rs_ = runs_at(c0 + dc)
            if prev is not None:
                rs_ = [u for u in rs_ if abs(k * np.mean(u) + b0 - prev) < 0.02]
            if rs_:
                run = min(rs_, key=lambda u: abs(k * np.mean(u) + b0 - (prev if prev is not None else 0.44)))
                hit = (c0 + dc, run)
                break
        if hit is None:
            pts.append({"lambda_nm": lam, "value": None})
            continue
        c, run = hit
        lam_used = 1500.0 + 150.0 * (c - X_PX[0]) / (X_PX[1] - X_PX[0])
        v = float(k * np.mean(run) + b0)
        ext = [float(k * run[-1] + b0), float(k * run[0] + b0)]
        pts.append({"lambda_nm": lam, "lambda_read_nm": round(lam_used, 3), "col_px": c, "value": v, "line_extent": ext,
                    "resolution": float(abs(ext[1] - ext[0]) / 2 + abs(k))})
        prev = v
    pts.sort(key=lambda q: q["lambda_nm"])
    out = {"source": "D. Taillaert et al., Jpn. J. Appl. Phys. 45(8A), 6071-6077 (2006), doi 10.1143/JJAP.45.6071, Fig. 3 p.6072, dashed curve 'power up'",
           "render": "pdftoppm -r 600, page 2 of the author copy (biblio.ugent.be/publication/354299/file/571130.pdf), accessed 2026-11-18",
           "calibration": {"value_per_px": float(k), "value_at_row0": float(b0), "y_tick_fit_max_residual": resid, "x_tick_check_px": xres,
                           "legend_right_px": legend_right, "legend_bottom_px": legend_bottom},
           "points": pts}
    p = HERE / "taillaert2006_fig3.json"
    p.write_text(json.dumps(out, indent=1) + "\n")
    for q in pts:
        print(q)
    print("calibration", out["calibration"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
