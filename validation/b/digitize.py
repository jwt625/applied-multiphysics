"""Code-based figure digitizer for class-b eval values that a paper gives only as a plotted curve.

Protocol (DevLog-007 section 7): no manual eyeballing. Every digitized value comes out of this script with a recorded
standard uncertainty, from a spec file that records source, page, dpi, crop, expected tick labels and curve colours.

Steps per panel:
  1. Render the PDF page (pdftoppm, given dpi) or load an image; crop to `crop_px` (page pixels).
  2. Frame: left / right / top / bottom frame lines = the darkest column / row inside the panel's approximate box.
  3. Ticks: inward tick marks along the left and bottom frame lines (short dark runs perpendicular to the frame).
  4. Tick labels: tesseract OCR (digits) left of the y frame and below the x frame; each OCR number is matched to the
     nearest tick. The spec's expected labels are a cross-check. If OCR fails or disagrees, labels are assigned in
     order from the spec only when the tick count equals the label count; this is recorded as `labels_from`.
  5. Calibration: least-squares fit value = a + b * pixel (linear) or log10(value) = a + b * pixel (log), per axis.
     Residual RMS in data units is u_cal.
  6. Curve: RGB distance to the curve colour < tol, inside the frame (minus a 3 px margin and `exclude_px` boxes).
     Per pixel column: centre = mean row, thickness = number of rows.
  7. Uncertainty (standard, k = 1) per point, in data units:
        u_q    = 0.5 px / sqrt(3)            quantization (uniform over one pixel)
        u_line = (thickness / 2) / sqrt(3)  line width (centre anywhere inside the stroke, uniform)
        u_cal  = sqrt(fit RMS residual (n - 2 dof)^2 + (|b| 0.5 px / sqrt3)^2) for >= 3 calibration pairs; with 2 pairs
                 (only if the spec sets allow_two_ticks) the two tick localizations are propagated through the line
        floors : line-width term uses max(stroke, median stroke) (overlaps only thin a stroke); u_y >= 1 pixel
        u_y    = |dy/dpx| * sqrt(u_q^2 + u_line^2) (+) u_cal_y ; at a requested x, the x uncertainty is propagated
                 through the local slope: u = sqrt(u_y^2 + (slope * u_x)^2). Expanded U = 2 u.
  8. Output JSON (points, samples, calibration, uncertainties, source sha256, ISO timestamp) and an overlay PNG.

Usage:
  uv run --no-project --with numpy --with pillow python validation/b/digitize.py <spec.json> --out <dir>
  uv run --no-project --with numpy --with pillow --with matplotlib python validation/b/digitize.py --selftest --out <dir>
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
DARK = 110  # grey level below which a pixel counts as frame / tick ink


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render(spec: dict, work: Path) -> tuple[np.ndarray, dict]:
    src = spec["source"]
    meta: dict = {}
    if "pdf" in src:
        pdf = Path(src["pdf"]).expanduser()
        if not pdf.is_absolute():
            pdf = ROOT / pdf  # spec paths are relative to the repo root
        meta["source_sha256"] = sha256(pdf)
        if src.get("sha256") and src["sha256"] != meta["source_sha256"]:
            raise SystemExit(f"sha256 mismatch for {pdf}")
        base = work / "page"
        subprocess.run(["pdftoppm", "-f", str(src["page"]), "-l", str(src["page"]), "-r", str(src["dpi"]), "-png",
                        "-singlefile", str(pdf), str(base)], check=True)
        img = Image.open(str(base) + ".png").convert("RGB")
    else:
        p = Path(src["image"]).expanduser()
        if not p.is_absolute():
            p = ROOT / p
        meta["source_sha256"] = sha256(p)
        img = Image.open(p).convert("RGB")
    x0, y0, w, h = spec["crop_px"]
    arr = np.asarray(img.crop((x0, y0, x0 + w, y0 + h))).astype(np.int16)
    meta["crop_px"] = spec["crop_px"]
    return arr, meta


def gray(arr: np.ndarray) -> np.ndarray:
    """Grey level of neutral pixels; coloured pixels (curves) are returned as white so they never count as ink."""
    g = arr.mean(axis=2)
    chroma = arr.max(axis=2) - arr.min(axis=2)
    return np.where(chroma > 40, 255.0, g)


def find_frame(g: np.ndarray, box: list[int]) -> dict:
    """box = approximate [x0, y0, x1, y1] of the panel in crop pixels. Each frame line is the darkest column / row in
    its half of the box, widened to the full stroke (counts >= 80 % of the peak); the inner edge of each stroke is
    returned as left / right / top / bottom, the stroke widths as `stroke_px`."""
    x0, y0, x1, y1 = box
    sub = g[y0:y1, x0:x1] < DARK
    cols = sub.sum(axis=0).astype(float)
    rows = sub.sum(axis=1).astype(float)

    def line(counts: np.ndarray, lo: int, hi: int, inner_dir: int) -> tuple[int, int]:
        i = lo + int(np.argmax(counts[lo:hi]))
        thr = 0.8 * counts[i]
        a = b = i
        while a - 1 >= 0 and counts[a - 1] >= thr:
            a -= 1
        while b + 1 < len(counts) and counts[b + 1] >= thr:
            b += 1
        return (b if inner_dir > 0 else a), b - a + 1

    hc, hr = (x1 - x0) // 2, (y1 - y0) // 2
    left, wl = line(cols, 0, hc, +1)
    right, wr = line(cols, hc, len(cols), -1)
    top, wt = line(rows, 0, hr, +1)
    bottom, wb = line(rows, hr, len(rows), -1)
    return {"left": x0 + left, "right": x0 + right, "top": y0 + top, "bottom": y0 + bottom,
            "stroke_px": [int(wl), int(wr), int(wt), int(wb)]}


def _runs(mask: np.ndarray) -> list[float]:
    centres, start = [], None
    for i, v in enumerate(list(mask) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            centres.append((start + i - 1) / 2.0)
            start = None
    return centres


def find_ticks(g: np.ndarray, fr: dict, axis: str, length: int, gap: int = 3) -> list[float]:
    """Inward tick marks: pixels just inside the frame that are dark for `length` px."""
    ink = g < DARK
    if axis == "y":
        band = ink[:, fr["left"] + gap: fr["left"] + gap + length]
        mask = band.all(axis=1)
        mask[: fr["top"] + gap] = False
        mask[fr["bottom"] - gap:] = False
    else:
        band = ink[fr["bottom"] - gap - length: fr["bottom"] - gap, :]
        mask = band.all(axis=0)
        mask[: fr["left"] + gap] = False
        mask[fr["right"] - gap:] = False
    return _runs(mask)


def ocr_numbers(arr: np.ndarray, region: tuple[int, int, int, int], work: Path, tag: str) -> list[dict]:
    """tesseract TSV on a region; returns [{value, cx, cy}] in crop pixels. Empty if tesseract is absent."""
    if shutil.which("tesseract") is None:
        return []
    x0, y0, x1, y1 = [int(v) for v in region]
    x0, y0 = max(x0, 0), max(y0, 0)
    sub = Image.fromarray(arr[y0:y1, x0:x1].astype(np.uint8))
    scale = 2
    sub = sub.resize((sub.width * scale, sub.height * scale), Image.LANCZOS)
    p = work / f"ocr_{tag}.png"
    sub.save(p)
    out = subprocess.run(["tesseract", str(p), "stdout", "--psm", "11", "-c", "tessedit_char_whitelist=0123456789.-",
                          "tsv"], capture_output=True, text=True)
    res = []
    for line in out.stdout.splitlines()[1:]:
        f = line.split("\t")
        if len(f) < 12 or not f[11].strip():
            continue
        try:
            val = float(f[11].strip())
        except ValueError:
            continue
        left, top, w, h = (int(f[6]), int(f[7]), int(f[8]), int(f[9]))
        res.append({"value": val, "cx": x0 + (left + w / 2) / scale, "cy": y0 + (top + h / 2) / scale,
                    "conf": float(f[10])})
    return res


def ocr_per_tick(arr: np.ndarray, fr: dict, ticks: list[float], axis: str, work: Path, tag: str,
                 box: tuple[int, int, int, int]) -> list[dict]:
    """OCR one label per tick: a small window beside each tick (psm 7, digits). box = (outer, half, near, far)."""
    if shutil.which("tesseract") is None:
        return []
    outer, half, near, far = box
    res = []
    for i, t in enumerate(ticks):
        if axis == "y":
            reg = (fr["left"] - outer, int(t) - half, fr["left"] - near, int(t) + half)
        else:
            reg = (int(t) - half, fr["bottom"] + near, int(t) + half, fr["bottom"] + far)
        x0, y0, x1, y1 = [max(int(v), 0) for v in reg]
        sub = Image.fromarray(arr[y0:y1, x0:x1].astype(np.uint8)).convert("L")
        sub = sub.resize((max(sub.width * 3, 1), max(sub.height * 3, 1)), Image.LANCZOS)
        sub = Image.eval(sub, lambda v: 255 if v > 150 else 0)
        pth = work / f"ocr_{tag}_{i}.png"
        sub.save(pth)
        txt = subprocess.run(["tesseract", str(pth), "stdout", "--psm", "7", "-c",
                              "tessedit_char_whitelist=0123456789.-"], capture_output=True, text=True).stdout.strip()
        try:
            res.append({"value": float(txt), "cx": t if axis == "x" else (x0 + x1) / 2,
                        "cy": t if axis == "y" else (y0 + y1) / 2, "conf": -1.0})
        except ValueError:
            pass
    return res


def calibrate(ticks: list[float], expected: list[float], ocr: list[dict], axis: str, scale: str,
              allow_two: bool = False) -> dict:
    """Assign label values to tick pixel positions, fit the linear map, return calibration dict."""
    key = "cy" if axis == "y" else "cx"
    pairs, labels_from = [], "ocr"
    for t in ticks:
        near = [o for o in ocr if abs(o[key] - t) < 12 and o["value"] in expected]
        if near:
            pairs.append((t, min(near, key=lambda o: abs(o[key] - t))["value"]))
    if len(pairs) < 2 or len({v for _, v in pairs}) < len(pairs):
        ordered = sorted(ticks, reverse=(axis == "y"))  # y labels increase upward (decreasing row)
        if len(ordered) != len(expected):
            raise SystemExit(f"{axis}: {len(ordered)} ticks found, {len(expected)} labels expected, OCR failed")
        pairs = list(zip(ordered, sorted(expected)))
        labels_from = "spec_order"
    px = np.array([p for p, _ in pairs])
    val = np.array([v for _, v in pairs])
    vv = np.log10(val) if scale == "log" else val
    b, a = np.polyfit(px, vv, 1)
    # ticks whose label OCR missed: accept the expected label the first fit predicts, within 5 % of a label step
    used = {p for p, _ in pairs}
    step = float(np.min(np.diff(sorted(expected)))) if len(expected) > 1 else 0.0
    added = 0
    for t in ticks:
        if t in used or step == 0.0:
            continue
        pred = a + b * t
        pred = 10 ** pred if scale == "log" else pred
        cand = [e for e in expected if abs(e - pred) < 0.05 * step and e not in {v for _, v in pairs}]
        if cand:
            pairs.append((t, cand[0]))
            added += 1
    if added:
        labels_from += f"+{added}_inferred_from_fit"
        px = np.array([p for p, _ in pairs])
        val = np.array([v for _, v in pairs])
        vv = np.log10(val) if scale == "log" else val
        b, a = np.polyfit(px, vv, 1)
    resid = vv - (a + b * px)
    if len(px) < 3 and not allow_two:
        raise SystemExit(f"{axis}: only {len(px)} calibration pairs; need >= 3, or set allow_two_ticks in the spec "
                         "(then a two-point scale term is added)")
    rms_fit = float(np.sqrt(np.sum(resid ** 2) / (len(px) - 2))) if len(px) > 2 else 0.0
    u_tick = abs(float(b)) * 0.5 / math.sqrt(3)  # tick centre localization, one pixel uniform
    rms = math.sqrt(rms_fit ** 2 + u_tick ** 2)
    return {"a": float(a), "b": float(b), "scale": scale, "pairs": [[float(p), float(v)] for p, v in pairs],
            "rms_resid": rms, "rms_fit": rms_fit, "u_tick": u_tick, "n_pairs": len(px),
            "labels_from": labels_from, "n_ticks": len(ticks)}


def u_cal_at(cal: dict, px: np.ndarray) -> np.ndarray:
    """Calibration standard uncertainty at pixel positions. >= 3 pairs: fit RMS (+) tick localization.
    2 pairs: no residual exists, so propagate the localization of both ticks (u_tick_px each) through the line:
    u = |b| u_tick_px sqrt((p - p1)^2 + (p - p2)^2) / |p2 - p1| (zero only at no point; grows outside the ticks)."""
    px = np.asarray(px, float)
    if cal["n_pairs"] >= 3:
        return np.full_like(px, cal["rms_resid"])
    (p1, _), (p2, _) = cal["pairs"][:2]
    ut = 0.5 / math.sqrt(3)
    return abs(cal["b"]) * ut * np.sqrt((px - p1) ** 2 + (px - p2) ** 2) / abs(p2 - p1)


def to_data(cal: dict, px: np.ndarray) -> np.ndarray:
    v = cal["a"] + cal["b"] * px
    return 10 ** v if cal["scale"] == "log" else v


def extract_curve(arr: np.ndarray, fr: dict, rgb: list[int], tol: float, exclude: list[list[int]]) -> list[dict]:
    d = np.sqrt(((arr - np.array(rgb)) ** 2).sum(axis=2))
    mask = d < tol
    m = 3
    mask[: fr["top"] + m, :] = False
    mask[fr["bottom"] - m + 1:, :] = False
    mask[:, : fr["left"] + m] = False
    mask[:, fr["right"] - m + 1:] = False
    for x0, y0, x1, y1 in exclude:
        mask[y0:y1, x0:x1] = False
    pts = []
    for c in range(fr["left"] + m, fr["right"] - m + 1):
        rows = np.nonzero(mask[:, c])[0]
        if rows.size:
            pts.append({"col": c, "row": float(rows.mean()), "thick": int(rows.size)})
    return pts


def process_panel(arr: np.ndarray, panel: dict, cals: dict, work: Path, ocr_on: bool) -> dict:
    g = gray(arr)
    fr = find_frame(g, panel["box_px"])
    tick_len = panel.get("tick_len_px", 8)
    out: dict = {"frame": fr}
    yt = find_ticks(g, fr, "y", tick_len)
    if panel.get("y_edge_ticks"):  # labels sitting on the top / bottom frame lines (tick hidden by the frame)
        st, sb = fr["stroke_px"][2], fr["stroke_px"][3]
        yt = sorted(set(yt) | {fr["top"] - (st - 1) / 2.0, fr["bottom"] + (sb - 1) / 2.0})  # stroke centres
    yocr = ocr_per_tick(arr, fr, yt, "y", work, panel["name"] + "_y", tuple(panel.get("y_label_box", (120, 22, 4, 0))))  \
        if ocr_on else []
    out["y_ocr"] = [[o["value"], round(o["cx"], 1), round(o["cy"], 1)] for o in yocr]
    out["y_cal"] = calibrate(yt, panel["y_ticks"], yocr, "y", panel.get("y_scale", "linear"),
                             bool(panel.get("allow_two_ticks", False)))
    if panel.get("x_from"):
        out["x_cal"] = cals[panel["x_from"]]
        out["x_cal_note"] = f"x calibration shared with panel {panel['x_from']} (same page pixels)"
    else:
        xt = find_ticks(g, fr, "x", tick_len)
        if panel.get("x_edge_ticks"):
            sl, sr = fr["stroke_px"][0], fr["stroke_px"][1]
            xt = sorted(set(xt) | {fr["left"] - (sl - 1) / 2.0, fr["right"] + (sr - 1) / 2.0})
        xocr = ocr_numbers(arr, (fr["left"] - 20, fr["bottom"] + 2, fr["right"] + 20, fr["bottom"] + 60), work,
                           panel["name"] + "_x") if ocr_on else []
        if len(xocr) < 2 and ocr_on:
            xocr = ocr_per_tick(arr, fr, xt, "x", work, panel["name"] + "_x", tuple(panel.get("x_label_box", (0, 40, 3, 45))))
        out["x_ocr"] = [[o["value"], round(o["cx"], 1), round(o["cy"], 1)] for o in xocr]
        out["x_cal"] = calibrate(xt, panel["x_ticks"], xocr, "x", panel.get("x_scale", "linear"),
                                 bool(panel.get("allow_two_ticks", False)))
    cals[panel["name"]] = out["x_cal"]
    xc, yc = out["x_cal"], out["y_cal"]
    if xc["scale"] != "linear" or yc["scale"] != "linear":
        raise SystemExit("log axes: uncertainty propagation not implemented in this version")
    uq = 0.5 / math.sqrt(3)
    curves = {}
    for cv in panel["curves"]:
        pts = extract_curve(arr, fr, cv["rgb"], cv.get("tol", 60), panel.get("exclude_px", []))
        if not pts:
            curves[cv["name"]] = {"points": [], "error": "no pixels matched"}
            continue
        cols = np.array([p["col"] for p in pts], float)
        rows = np.array([p["row"] for p in pts], float)
        thick = np.array([p["thick"] for p in pts], float)
        x = to_data(xc, cols)
        y = to_data(yc, rows)
        # overlap floor: another curve or a legend can hide part of a stroke, which only thins it, so the line-width
        # term never drops below the median stroke of this curve, and u_y never below one pixel
        thick_eff = np.maximum(thick, np.median(thick))
        u_line_px = (thick_eff / 2) / math.sqrt(3)
        u_y = np.sqrt((abs(yc["b"]) ** 2) * (uq ** 2 + u_line_px ** 2) + u_cal_at(yc, rows) ** 2)
        u_y = np.maximum(u_y, abs(yc["b"]))
        u_x = float(math.sqrt((abs(xc["b"]) * uq) ** 2 + float(np.median(u_cal_at(xc, cols))) ** 2))
        samples = []
        for xs in cv.get("sample_x", []):
            if xs < x.min() or xs > x.max():
                samples.append({"x": xs, "y": None, "note": "outside digitized range"})
                continue
            ys = float(np.interp(xs, x, y))
            uy = float(np.interp(xs, x, u_y))
            k = max(1, int(round(1.0 / abs(xc["b"]))))  # slope over about one x unit of pixels
            i = int(np.argmin(abs(x - xs)))
            lo, hi = max(i - k, 0), min(i + k, len(x) - 1)
            slope = float((y[hi] - y[lo]) / (x[hi] - x[lo])) if hi > lo else 0.0
            u = math.sqrt(uy ** 2 + (slope * u_x) ** 2)
            samples.append({"x": xs, "y": ys, "u": u, "U_k2": 2 * u, "slope": slope})
        curves[cv["name"]] = {
            "rgb": cv["rgb"], "tol": cv.get("tol", 60), "n_columns": int(len(cols)),
            "x_range": [float(x.min()), float(x.max())], "y_range": [float(y.min()), float(y.max())],
            "y_mean": float(y.mean()), "median_thickness_px": float(np.median(thick)),
            "u_x": u_x, "u_y_median": float(np.median(u_y)),
            "pixel_size": {"x": abs(xc["b"]), "y": abs(yc["b"])},
            "samples": samples,
            "points": [[round(float(a), 6), round(float(b), 6), round(float(c), 6)] for a, b, c in zip(x, y, u_y)],
        }
    out["curves"] = curves
    return out


def overlay(arr: np.ndarray, panels: dict, path: Path, spec: dict) -> None:
    img = Image.fromarray(arr.astype(np.uint8)).convert("RGB")
    dr = ImageDraw.Draw(img)
    for name, res in panels.items():
        fr = res["frame"]
        dr.rectangle([fr["left"], fr["top"], fr["right"], fr["bottom"]], outline=(0, 200, 0))
        for p, _ in res["y_cal"]["pairs"]:
            dr.line([fr["left"] - 12, p, fr["left"], p], fill=(255, 0, 255), width=2)
        if not res.get("x_cal_note"):
            for p, _ in res["x_cal"]["pairs"]:
                dr.line([p, fr["bottom"], p, fr["bottom"] + 12], fill=(255, 0, 255), width=2)
        xc, yc = res["x_cal"], res["y_cal"]
        for cname, c in res["curves"].items():
            for x, y, _ in c.get("points", [])[::4]:
                col = (x - xc["a"]) / xc["b"]
                row = (y - yc["a"]) / yc["b"]
                dr.point([col, row], fill=(0, 0, 0))
            for s in c.get("samples", []):
                if s.get("y") is None:
                    continue
                col = (s["x"] - xc["a"]) / xc["b"]
                row = (s["y"] - yc["a"]) / yc["b"]
                dr.ellipse([col - 5, row - 5, col + 5, row + 5], outline=(0, 160, 0), width=2)
    img.save(path)


def run(spec: dict, out_dir: Path, ocr_on: bool = True) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        arr, meta = render(spec, work)
        cals: dict = {}
        panels = {p["name"]: process_panel(arr, p, cals, work, ocr_on) for p in spec["panels"]}
        overlay(arr, panels, out_dir / f"{spec['id']}-overlay.png", spec)
    result = {
        "schema": "amp-digitize/0",
        "id": spec["id"],
        "created": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "generator": "validation/b/digitize.py",
        "spec": spec,
        "source": meta,
        "panels": panels,
        "uncertainty_model": "k=1 standard: quantization 0.5px/sqrt3, half line width/sqrt3, calibration RMS; "
                             "x uncertainty propagated through local slope; U_k2 = 2u",
    }
    (out_dir / f"{spec['id']}.json").write_text(json.dumps(result, indent=1) + "\n")
    return result


def selftest(out_dir: Path) -> int:
    """Synthetic figure with a known curve: digitized values must agree within U_k2."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_dir.mkdir(parents=True, exist_ok=True)
    xs = np.linspace(2, 67, 400)
    f = lambda x: 1.2 + 0.035 * x + 0.4 * np.sin(x / 9.0)  # noqa: E731
    fig, ax = plt.subplots(figsize=(5, 3), dpi=200)
    ax.plot(xs, f(xs), color=(0 / 255, 114 / 255, 189 / 255), lw=1.5)
    ax.set_xlim(2, 67)
    ax.set_ylim(0, 6)
    ax.set_xticks([10, 20, 30, 40, 50, 60])
    ax.set_yticks([0, 2, 4, 6])
    ax.tick_params(direction="in", length=5, width=1.2, colors=(0.15, 0.15, 0.15))
    for s in ax.spines.values():
        s.set_linewidth(1.2)
        s.set_color((0.15, 0.15, 0.15))
    png = out_dir / "selftest-figure.png"
    fig.savefig(png, dpi=200)
    plt.close(fig)
    im = Image.open(png)
    w, h = im.size
    sample_x = [5.0, 15.0, 33.0, 50.0, 64.0]
    spec = {
        "id": "selftest", "source": {"image": str(png.resolve())}, "crop_px": [0, 0, w, h],
        "panels": [{"name": "p", "box_px": [60, 10, w - 10, h - 40], "x_ticks": [10, 20, 30, 40, 50, 60],
                    "y_ticks": [0, 2, 4, 6], "tick_len_px": 6, "y_edge_ticks": True,
                    "curves": [{"name": "c", "rgb": [0, 114, 189], "tol": 60, "sample_x": sample_x}]}],
    }
    res = run(spec, out_dir)
    ok = True
    for s in res["panels"]["p"]["curves"]["c"]["samples"]:
        err = s["y"] - float(f(s["x"]))
        within = abs(err) <= s["U_k2"]
        ok &= within
        print(f"x={s['x']:6.2f} y_dig={s['y']:.4f} y_true={float(f(s['x'])):.4f} err={err:+.4f} U_k2={s['U_k2']:.4f} "
              f"{'ok' if within else 'FAIL'}")
    cal = res["panels"]["p"]
    print("x labels from", cal["x_cal"]["labels_from"], "; y labels from", cal["y_cal"]["labels_from"])
    print("selftest", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", nargs="?")
    ap.add_argument("--out", required=True)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--no-ocr", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest(Path(a.out))
    spec = json.loads(Path(a.spec).read_text())
    res = run(spec, Path(a.out), ocr_on=not a.no_ocr)
    for pn, p in res["panels"].items():
        print(f"[{pn}] x labels {p['x_cal']['labels_from']} rms {p['x_cal']['rms_resid']:.3g}; "
              f"y labels {p['y_cal']['labels_from']} rms {p['y_cal']['rms_resid']:.3g}")
        for cn, c in p["curves"].items():
            if "error" in c:
                print(f"  {cn}: {c['error']}")
                continue
            print(f"  {cn}: x {c['x_range'][0]:.3g}..{c['x_range'][1]:.3g}, y {c['y_range'][0]:.4g}..{c['y_range'][1]:.4g},"
                  f" mean {c['y_mean']:.4g}, u_y median {c['u_y_median']:.3g}")
            for s in c["samples"]:
                if s.get("y") is None:
                    print(f"    x={s['x']}: {s['note']}")
                else:
                    print(f"    x={s['x']}: y={s['y']:.4g} u={s['u']:.2g} U_k2={s['U_k2']:.2g}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
