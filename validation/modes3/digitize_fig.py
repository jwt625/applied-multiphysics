# SPDX-License-Identifier: GPL-3.0-or-later
"""Digitize the red (CCS) curves of Kakihara et al., Opt. Express 14, 11128 (2006), Fig. 4 (a) quasi-TE, (b) quasi-TM,
from a 400 dpi rendering of p.11139 (pdftoppm -f 14 -l 14 -r 400 -png OE14-23.pdf p14). Axes frames are found from the
long dark lines; axis ranges are the printed ones ((a) R 0..10 um, loss 0..0.025 dB/90 deg; (b) R 0..30 um, 0..4).
For a radius R the red pixels of the column at R give the curve (mean row; line width reported as the reading spread).
Usage: uv run python modes3/digitize_fig.py <p14-14.png>  (prints JSON). The PDF is not committed (rights)."""

import json
import sys

import numpy as np
from PIL import Image


def frame(dark: np.ndarray, r0: int, r1: int) -> tuple[float, float, float, float]:
    """Plot frame inside rows r0..r1: the two full-width dark rows and the two full-height dark columns (centres)."""
    rows = [i for i in range(r0, r1) if dark[i, 1100:2500].sum() > 1300]
    top = [i for i in rows if i <= rows[0] + 3]
    bot = [i for i in rows if i >= rows[-1] - 3]
    t, b = float(np.mean(top)), float(np.mean(bot))
    cols = [j for j in range(1000, 2700) if dark[int(t) + 5:int(b) - 5, j].sum() > 0.8 * (b - t - 10)]
    left = [j for j in cols if j <= cols[0] + 3]
    right = [j for j in cols if j >= cols[-1] - 3]
    return t, b, float(np.mean(left)), float(np.mean(right))


def main() -> int:
    a = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(int)
    dark = a.sum(axis=2) < 300
    red = (a[:, :, 0] > 180) & (a[:, :, 1] < 80) & (a[:, :, 2] < 80)
    out: dict = {"panels": {}, "points": []}
    # row windows of the two panels on the 400 dpi page (panel (a) frame top near row 428, panel (b) near 1317)
    for lab, (r0, r1), (rmax, ymax), Rs in (("TE", (400, 1200), (10.0, 0.025), [1.0, 1.25, 1.5, 2.0]),
                                            ("TM", (1300, 2000), (30.0, 4.0), [2.0, 3.0, 5.0, 7.5, 10.0])):
        t, b, x0, x1 = frame(dark, r0, r1)
        out["panels"][lab] = {"top_px": t, "bottom_px": b, "left_px": x0, "right_px": x1, "R_max_um": rmax, "loss_max_dB": ymax}
        for R in Rs:
            c = int(round(x0 + (x1 - x0) * R / rmax))
            ys = np.where(red[int(t):int(b) + 1, c - 1:c + 2].any(axis=1))[0] + int(t)
            v = lambda y: ymax * (b - y) / (b - t)  # noqa: E731
            if not len(ys):
                out["points"].append({"mode": lab, "R_um": R, "value": None})
                continue
            out["points"].append({"mode": lab, "R_um": R, "value": v(ys.mean()), "line_extent": [v(ys.max()), v(ys.min())],
                                  "dB_per_px": ymax / (b - t), "col_px": c})
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
