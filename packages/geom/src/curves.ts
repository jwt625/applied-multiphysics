// SPDX-License-Identifier: GPL-3.0-or-later
// Exact parametric curve pieces for 2D geometry: line segment, circular arc, elliptical arc. Parameter t in [0, 1].
// Curves stay exact through booleans; discretization happens only for topology (fine) and in the mesher (size field).

import { sinCos, atan2 as detAtan2, hyp2 } from './detmath.ts';

export type Vec2 = [number, number];

export type Curve =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  /** Circular arc: centre c, radius r, angle from a0 to a1 (a1 > a0 is ccw). */
  | { kind: 'arc'; c: Vec2; r: number; a0: number; a1: number }
  /** Elliptical arc: centre c, semi-axes rx, ry, rotation rot (rad), parametric angle a0 -> a1. */
  | { kind: 'earc'; c: Vec2; rx: number; ry: number; rot: number; a0: number; a1: number };

export function point(cv: Curve, t: number): Vec2 {
  switch (cv.kind) {
    case 'line':
      return [cv.a[0] + t * (cv.b[0] - cv.a[0]), cv.a[1] + t * (cv.b[1] - cv.a[1])];
    case 'arc': {
      const [sn, cs] = sinCos(cv.a0 + t * (cv.a1 - cv.a0));
      return [cv.c[0] + cv.r * cs, cv.c[1] + cv.r * sn];
    }
    case 'earc': {
      const [sn, cs] = sinCos(cv.a0 + t * (cv.a1 - cv.a0));
      const u = cv.rx * cs, v = cv.ry * sn;
      const [sr, cr] = sinCos(cv.rot);
      return [cv.c[0] + cr * u - sr * v, cv.c[1] + sr * u + cr * v];
    }
  }
}

/** First derivative d point / dt. */
export function deriv(cv: Curve, t: number): Vec2 {
  switch (cv.kind) {
    case 'line':
      return [cv.b[0] - cv.a[0], cv.b[1] - cv.a[1]];
    case 'arc': {
      const d = cv.a1 - cv.a0, [sn, cs] = sinCos(cv.a0 + t * d);
      return [-cv.r * sn * d, cv.r * cs * d];
    }
    case 'earc': {
      const d = cv.a1 - cv.a0, [sn, cs] = sinCos(cv.a0 + t * d);
      const u = -cv.rx * sn * d, v = cv.ry * cs * d;
      const [sr, cr] = sinCos(cv.rot);
      return [cr * u - sr * v, sr * u + cr * v];
    }
  }
}

/** Second derivative. */
export function deriv2(cv: Curve, t: number): Vec2 {
  switch (cv.kind) {
    case 'line':
      return [0, 0];
    case 'arc': {
      const d = cv.a1 - cv.a0, [sn, cs] = sinCos(cv.a0 + t * d);
      return [-cv.r * cs * d * d, -cv.r * sn * d * d];
    }
    case 'earc': {
      const d = cv.a1 - cv.a0, [sn, cs] = sinCos(cv.a0 + t * d);
      const u = -cv.rx * cs * d * d, v = -cv.ry * sn * d * d;
      const [sr, cr] = sinCos(cv.rot);
      return [cr * u - sr * v, sr * u + cr * v];
    }
  }
}

/** Signed curvature at t for traversal in the +t direction (positive = turning left). */
export function curvature(cv: Curve, t: number): number {
  const d1 = deriv(cv, t), d2 = deriv2(cv, t);
  const n = hyp2(d1[0], d1[1]);
  return n > 0 ? (d1[0] * d2[1] - d1[1] * d2[0]) / (n * n * n) : 0;
}

/** Number of fine pieces for topology (lines: 1; arcs: <= maxAngle per piece). */
export function finePieces(cv: Curve, maxAngle = Math.PI / 180): number {
  if (cv.kind === 'line') return 1;
  const span = Math.abs(cv.a1 - cv.a0);
  let n = Math.ceil(span / maxAngle);
  if (cv.kind === 'earc') {
    // ellipse: bound the angle step by the axis ratio so the chord sagitta stays comparable to a circle's
    const q = Math.max(cv.rx, cv.ry) / Math.max(1e-300, Math.min(cv.rx, cv.ry));
    n = Math.ceil(n * Math.min(8, Math.sqrt(q)));
  }
  return Math.max(2, n);
}

/** Sub-curve covering [t0, t1] of cv, re-parametrized to [0, 1] (same kind). */
export function subCurve(cv: Curve, t0: number, t1: number): Curve {
  switch (cv.kind) {
    case 'line':
      return { kind: 'line', a: point(cv, t0), b: point(cv, t1) };
    case 'arc': {
      const d = cv.a1 - cv.a0;
      return { kind: 'arc', c: cv.c, r: cv.r, a0: cv.a0 + t0 * d, a1: cv.a0 + t1 * d };
    }
    case 'earc': {
      const d = cv.a1 - cv.a0;
      return { ...cv, a0: cv.a0 + t0 * d, a1: cv.a0 + t1 * d };
    }
  }
}

/** Arc length of [t0, t1] (Gauss-Legendre for ellipses, closed form otherwise). */
export function arcLength(cv: Curve, t0 = 0, t1 = 1): number {
  if (cv.kind === 'line') return Math.abs(t1 - t0) * hyp2(cv.b[0] - cv.a[0], cv.b[1] - cv.a[1]);
  if (cv.kind === 'arc') return Math.abs(t1 - t0) * Math.abs(cv.a1 - cv.a0) * cv.r;
  const n = 64;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = t0 + ((t1 - t0) * i) / n, b = t0 + ((t1 - t0) * (i + 1)) / n;
    for (const [x, w] of GL5) {
      const d = deriv(cv, 0.5 * (a + b) + 0.5 * (b - a) * x);
      s += 0.5 * Math.abs(b - a) * w * hyp2(d[0], d[1]);
    }
  }
  return s;
}
const GL5: Array<[number, number]> = [
  [0, 0.5688888888888889],
  [-0.5384693101056831, 0.47862867049936647],
  [0.5384693101056831, 0.47862867049936647],
  [-0.906179845938664, 0.23692688505618908],
  [0.906179845938664, 0.23692688505618908],
];

/** Closest parameter on cv to p by Newton from guess (clamped to [0, 1]). */
export function project(cv: Curve, p: Vec2, guess: number): number {
  if (cv.kind === 'line') {
    const dx = cv.b[0] - cv.a[0], dy = cv.b[1] - cv.a[1];
    const l2 = dx * dx + dy * dy;
    return l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - cv.a[0]) * dx + (p[1] - cv.a[1]) * dy) / l2)) : 0;
  }
  if (cv.kind === 'arc') {
    let th = detAtan2(p[1] - cv.c[1], p[0] - cv.c[0]);
    const d = cv.a1 - cv.a0;
    // bring th to the branch nearest the guess
    const thg = cv.a0 + guess * d;
    th += 2 * Math.PI * Math.round((thg - th) / (2 * Math.PI));
    return Math.min(1, Math.max(0, (th - cv.a0) / d));
  }
  let t = guess;
  for (let it = 0; it < 30; it++) {
    const q = point(cv, t), d1 = deriv(cv, t), d2 = deriv2(cv, t);
    const rx = q[0] - p[0], ry = q[1] - p[1];
    const f = rx * d1[0] + ry * d1[1];
    const fp = d1[0] * d1[0] + d1[1] * d1[1] + rx * d2[0] + ry * d2[1];
    if (!(Math.abs(fp) > 0)) break;
    const dt = f / fp;
    t = Math.min(1, Math.max(0, t - dt));
    if (Math.abs(dt) < 1e-15) break;
  }
  return t;
}

/**
 * Exact intersection of two curves near (ta, tb) by Newton on point(A, ta) = point(B, tb). Returns refined parameters,
 * or null when the iteration leaves [0, 1] by more than `slack` or does not converge (the caller keeps its estimate).
 */
export function refineIntersection(A: Curve, B: Curve, ta: number, tb: number, tol: number, slack = 1e-6): [number, number] | null {
  if (A.kind === 'line' && B.kind === 'line') return [ta, tb];
  let s = ta, u = tb;
  for (let it = 0; it < 40; it++) {
    const pa = point(A, s), pb = point(B, u);
    const fx = pa[0] - pb[0], fy = pa[1] - pb[1];
    if (hyp2(fx, fy) <= 1e-3 * tol) return [s, u];
    const da = deriv(A, s), db = deriv(B, u);
    // J = [da, -db]; solve J [ds, du] = -f
    const det = -da[0] * db[1] + db[0] * da[1];
    if (!(Math.abs(det) > 0)) return null;
    const ds = (-fx * -db[1] - -db[0] * -fy) / det;
    const du = (da[0] * -fy - da[1] * -fx) / det;
    s += ds;
    u += du;
    if (s < -slack || s > 1 + slack || u < -slack || u > 1 + slack) return null;
  }
  const pa = point(A, s), pb = point(B, u);
  return hyp2(pa[0] - pb[0], pa[1] - pb[1]) <= tol ? [s, u] : null;
}

/** Bounding box of the curve (sampled; arcs and ellipses use the fine pieces plus endpoints, padded by sagitta). */
export function curveBBox(cv: Curve): [number, number, number, number] {
  const n = cv.kind === 'line' ? 1 : finePieces(cv) * 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= n; i++) {
    const p = point(cv, i / n);
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  if (cv.kind !== 'line') {
    const r = cv.kind === 'arc' ? cv.r : Math.max(cv.rx, cv.ry);
    const pad = r * (1 - sinCos(Math.PI / 360)[1]) * 2;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  }
  return [x0, y0, x1, y1];
}

/** Reverse parametrization (t -> 1 - t). */
export function reverse(cv: Curve): Curve {
  switch (cv.kind) {
    case 'line':
      return { kind: 'line', a: cv.b, b: cv.a };
    case 'arc':
      return { ...cv, a0: cv.a1, a1: cv.a0 };
    case 'earc':
      return { ...cv, a0: cv.a1, a1: cv.a0 };
  }
}
