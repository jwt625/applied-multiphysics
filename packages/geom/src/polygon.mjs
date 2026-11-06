// Ported from eo-modulator-atlas/engine/src/geometry.mjs at 0546007 (GPL-3.0-or-later). Changes: buildPslg removed (replaced by the arrangement in arrangement.ts); unit-agnostic (SI metres in @amp); comments trimmed.
// SPDX-License-Identifier: GPL-3.0-or-later
/** @typedef {[number, number]} Pt */

/** Axis-aligned rectangle {x:[x0,x1], y:[y0,y1]} to a ccw polygon. */
export function rectToPolygon(x, y) {
  return [
    [x[0], y[0]],
    [x[1], y[0]],
    [x[1], y[1]],
    [x[0], y[1]],
  ];
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return 0.5 * a;
}

/** Return polygon in counter-clockwise order. */
export function ensureCcw(poly) {
  return polygonArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
}

export function polygonBBox(poly) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/** Even-odd point in polygon. Points exactly on the boundary may go either way. */
export function pointInPolygon(px, py, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0],
      yi = poly[i][1],
      xj = poly[j][0],
      yj = poly[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from point to segment. */
export function distPointSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px,
    qy = ay + t * dy - py;
  return Math.hypot(qx, qy);
}

/** Distance from point to polygon (0 if inside when filled=true). */
export function distPointPolygon(px, py, poly, filled = true) {
  if (filled && pointInPolygon(px, py, poly)) return 0;
  let d = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[(i + 1) % n];
    const di = distPointSegment(px, py, a[0], a[1], b[0], b[1]);
    if (di < d) d = di;
  }
  return d;
}

/** Liang-Barsky clip of a segment to a rectangle. Returns null or [x0,y0,x1,y1]. */
export function clipSegmentToRect(ax, ay, bx, by, r) {
  let t0 = 0,
    t1 = 1;
  const dx = bx - ax,
    dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x0, r.x1 - ax, ay - r.y0, r.y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  if (t1 - t0 <= 0) return null;
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

