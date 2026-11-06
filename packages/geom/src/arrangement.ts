// SPDX-License-Identifier: GPL-3.0-or-later
// Planar arrangement of exact curve pieces: split at crossings and T-junctions, merge coincident pieces, trace faces
// (half-edge "next = clockwise neighbour of twin"), nest components, and number faces. Topology is computed on fine
// polylines with robust orientation predicates; every crossing is refined onto the exact curves by Newton, so the
// geometry stays exact. Coincident curved pieces are merged only when their endpoints and midpoints agree within tol.

import { orient2d } from 'robust-predicates';
import { pointInPolygon } from './polygon.mjs';
import {
  type Curve, type Vec2, point, deriv, curvature, finePieces, subCurve, project, refineIntersection, curveBBox,
} from './curves.ts';

export interface ArrSrc { rec: number; fwd: boolean; ta: number; tb: number }
export interface ArrSub { v0: number; v1: number; curve: Curve; srcs: ArrSrc[]; fine: Float64Array }
export interface ArrFace { outer: number[]; holes: number[][]; area: number; centroid: Vec2 }
export interface Arrangement {
  vx: Float64Array; vy: Float64Array;
  subs: ArrSub[];
  faces: ArrFace[];
  /** face index on the left of half-edge h (h = 2 s forward, 2 s + 1 backward); -1 = unbounded */
  heFace: Int32Array;
}

const sq = (x: number) => x * x;

export function arrange(curves: Curve[], tol: number): Arrangement {
  // ---- vertices (spatial hash, merge within tol) ----
  const VX: number[] = [], VY: number[] = [];
  const cell = Math.max(4 * tol, 1e-300);
  const hash = new Map<string, number[]>();
  const vertexAt = (x: number, y: number): number => {
    const ix = Math.floor(x / cell), iy = Math.floor(y / cell);
    let best = -1, bd = tol;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const l = hash.get(`${ix + dx},${iy + dy}`);
        if (!l) continue;
        for (const v of l) {
          const d = Math.hypot(VX[v]! - x, VY[v]! - y);
          if (d <= bd) { bd = d; best = v; }
        }
      }
    if (best >= 0) return best;
    const id = VX.length;
    VX.push(x); VY.push(y);
    const k = `${ix},${iy}`;
    const l = hash.get(k);
    if (l) l.push(id); else hash.set(k, [id]);
    return id;
  };

  // ---- fine polylines ----
  const n = curves.length;
  const fineP: Float64Array[] = [], fineT: Float64Array[] = [], len: number[] = [], bbox: number[][] = [];
  const vStart: number[] = [], vEnd: number[] = [];
  for (let i = 0; i < n; i++) {
    const cv = curves[i]!;
    const m = finePieces(cv);
    const P = new Float64Array(2 * (m + 1)), T = new Float64Array(m + 1);
    let L = 0;
    for (let k = 0; k <= m; k++) {
      const t = k / m, p = point(cv, t);
      P[2 * k] = p[0]; P[2 * k + 1] = p[1]; T[k] = t;
      if (k) L += Math.hypot(P[2 * k]! - P[2 * k - 2]!, P[2 * k + 1]! - P[2 * k - 1]!);
    }
    fineP.push(P); fineT.push(T); len.push(L);
    const b = curveBBox(cv);
    bbox.push([b[0] - tol, b[1] - tol, b[2] + tol, b[3] + tol]);
    vStart.push(vertexAt(P[0]!, P[1]!));
    vEnd.push(vertexAt(P[2 * m]!, P[2 * m + 1]!));
  }
  const splits: Array<Array<{ t: number; v: number }>> = curves.map((_, i) => [{ t: 0, v: vStart[i]! }, { t: 1, v: vEnd[i]! }]);
  const nearEnd = (i: number, t: number) => t * len[i]! <= tol || (1 - t) * len[i]! <= tol;

  // T-junction: point (x, y), the true endpoint vertex v of another curve, on fine segment k of curve i
  const tJunction = (i: number, k: number, x: number, y: number, v: number) => {
    const P = fineP[i]!, T = fineT[i]!;
    const ax = P[2 * k]!, ay = P[2 * k + 1]!, bx = P[2 * k + 2]!, by = P[2 * k + 3]!;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let s = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    s = Math.min(1, Math.max(0, s));
    let t = T[k]! + s * (T[k + 1]! - T[k]!);
    const cv = curves[i]!;
    t = project(cv, [x, y], t);
    const q = point(cv, t);
    if (Math.hypot(q[0] - x, q[1] - y) > tol) return;
    if (nearEnd(i, t)) return;
    splits[i]!.push({ t, v });
  };

  for (let i = 0; i < n; i++) {
    const Pi = fineP[i]!, mi = fineT[i]!.length - 1, bi = bbox[i]!;
    for (let j = i + 1; j < n; j++) {
      const bj = bbox[j]!;
      if (bi[0]! > bj[2]! || bj[0]! > bi[2]! || bi[1]! > bj[3]! || bj[1]! > bi[3]!) continue;
      const Pj = fineP[j]!, mj = fineT[j]!.length - 1;
      for (let k = 0; k < mi; k++) {
        const ax = Pi[2 * k]!, ay = Pi[2 * k + 1]!, bx = Pi[2 * k + 2]!, by = Pi[2 * k + 3]!;
        const sx0 = Math.min(ax, bx) - tol, sx1 = Math.max(ax, bx) + tol, sy0 = Math.min(ay, by) - tol, sy1 = Math.max(ay, by) + tol;
        if (sx1 < bj[0]! || sx0 > bj[2]! || sy1 < bj[1]! || sy0 > bj[3]!) continue;
        for (let l = 0; l < mj; l++) {
          const cx = Pj[2 * l]!, cy = Pj[2 * l + 1]!, dx = Pj[2 * l + 2]!, dy = Pj[2 * l + 3]!;
          if (Math.max(cx, dx) < sx0 || Math.min(cx, dx) > sx1 || Math.max(cy, dy) < sy0 || Math.min(cy, dy) > sy1) continue;
          // T-junctions at true endpoints
          if (l === 0) tJunction(i, k, cx, cy, vStart[j]!);
          if (l === mj - 1) tJunction(i, k, dx, dy, vEnd[j]!);
          if (k === 0) tJunction(j, l, ax, ay, vStart[i]!);
          if (k === mi - 1) tJunction(j, l, bx, by, vEnd[i]!);
          // crossing
          const o1 = orient2d(ax, ay, bx, by, cx, cy), o2 = orient2d(ax, ay, bx, by, dx, dy);
          if ((o1 > 0 && o2 > 0) || (o1 < 0 && o2 < 0) || (o1 === 0 && o2 === 0)) continue;
          const o3 = orient2d(cx, cy, dx, dy, ax, ay), o4 = orient2d(cx, cy, dx, dy, bx, by);
          if ((o3 > 0 && o4 > 0) || (o3 < 0 && o4 < 0)) continue;
          const ex = bx - ax, ey = by - ay, fx = dx - cx, fy = dy - cy;
          const den = ex * fy - ey * fx;
          if (den === 0) continue;
          const s = Math.min(1, Math.max(0, ((cx - ax) * fy - (cy - ay) * fx) / den));
          const u = Math.min(1, Math.max(0, ((cx - ax) * ey - (cy - ay) * ex) / den));
          const Ti = fineT[i]!, Tj = fineT[j]!;
          let ti = Ti[k]! + s * (Ti[k + 1]! - Ti[k]!), tj = Tj[l]! + u * (Tj[l + 1]! - Tj[l]!);
          let px = ax + s * ex, py = ay + s * ey;
          const r = refineIntersection(curves[i]!, curves[j]!, ti, tj, tol);
          if (r) {
            ti = Math.min(1, Math.max(0, r[0])); tj = Math.min(1, Math.max(0, r[1]));
            const pa = point(curves[i]!, ti), pb = point(curves[j]!, tj);
            // a line keeps its own point (exact on axis-aligned lines such as r = 0); else the midpoint
            const li = curves[i]!.kind === 'line', lj = curves[j]!.kind === 'line';
            if (li && !lj) { px = pa[0]; py = pa[1]; } else if (lj && !li) { px = pb[0]; py = pb[1]; }
            else { px = 0.5 * (pa[0] + pb[0]); py = 0.5 * (pa[1] + pb[1]); }
          }
          if (nearEnd(i, ti) || nearEnd(j, tj)) continue; // endpoint contacts: vertex merge / T-junction
          const v = vertexAt(px, py);
          splits[i]!.push({ t: ti, v });
          splits[j]!.push({ t: tj, v });
        }
      }
    }
  }

  // ---- pieces, coincident merge ----
  const subs: ArrSub[] = [];
  const byPair = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const sp = splits[i]!.sort((a, b) => a.t - b.t);
    const list: Array<{ t: number; v: number }> = [];
    for (const s of sp) {
      if (list.length && list[list.length - 1]!.v === s.v) continue;
      list.push(s);
    }
    for (let q = 0; q + 1 < list.length; q++) {
      const a = list[q]!, b = list[q + 1]!;
      if (a.v === b.v) continue;
      const cv = subCurve(curves[i]!, a.t, b.t);
      const key = a.v < b.v ? `${a.v}_${b.v}` : `${b.v}_${a.v}`;
      const mid = point(cv, 0.5);
      let merged = false;
      for (const si of byPair.get(key) ?? []) {
        const S = subs[si]!;
        const m2 = point(S.curve, 0.5);
        const q1 = point(cv, 0.25), fwd = S.v0 === a.v;
        const q2 = point(S.curve, fwd ? 0.25 : 0.75);
        if (Math.hypot(mid[0] - m2[0], mid[1] - m2[1]) <= 10 * tol && Math.hypot(q1[0] - q2[0], q1[1] - q2[1]) <= 10 * tol) {
          S.srcs.push({ rec: i, fwd, ta: a.t, tb: b.t });
          merged = true;
          break;
        }
      }
      if (merged) continue;
      const m = finePieces(cv);
      const fine = new Float64Array(2 * (m + 1));
      for (let k = 0; k <= m; k++) {
        const p = k === 0 ? [VX[a.v]!, VY[a.v]!] : k === m ? [VX[b.v]!, VY[b.v]!] : point(cv, k / m);
        fine[2 * k] = p[0]!; fine[2 * k + 1] = p[1]!;
      }
      const id = subs.length;
      subs.push({ v0: a.v, v1: b.v, curve: cv, srcs: [{ rec: i, fwd: true, ta: a.t, tb: b.t }], fine });
      const l = byPair.get(key);
      if (l) l.push(id); else byPair.set(key, [id]);
    }
  }

  // ---- half-edges sorted around vertices ----
  const nV = VX.length, nS = subs.length, nH = 2 * nS;
  const ang = new Float64Array(nH), kap = new Float64Array(nH);
  const out: number[][] = Array.from({ length: nV }, () => []);
  for (let s = 0; s < nS; s++) {
    const S = subs[s]!;
    let d0: Vec2, d1: Vec2;
    if (S.curve.kind === 'line') {
      d0 = [VX[S.v1]! - VX[S.v0]!, VY[S.v1]! - VY[S.v0]!];
      d1 = [-d0[0], -d0[1]];
    } else {
      const a = deriv(S.curve, 0), b = deriv(S.curve, 1);
      d0 = a; d1 = [-b[0], -b[1]];
    }
    ang[2 * s] = Math.atan2(d0[1], d0[0]);
    ang[2 * s + 1] = Math.atan2(d1[1], d1[0]);
    kap[2 * s] = curvature(S.curve, 0);
    kap[2 * s + 1] = -curvature(S.curve, 1);
    out[S.v0]!.push(2 * s);
    out[S.v1]!.push(2 * s + 1);
  }
  const posInV = new Int32Array(nH);
  for (let v = 0; v < nV; v++) {
    const l = out[v]!;
    l.sort((a, b) => {
      const d = ang[a]! - ang[b]!;
      if (Math.abs(d) > 1e-10) return d;
      return kap[a]! - kap[b]! || a - b;
    });
    l.forEach((h, i) => { posInV[h] = i; });
  }
  const origin = (h: number) => (h & 1 ? subs[h >> 1]!.v1 : subs[h >> 1]!.v0);
  const next = new Int32Array(nH);
  for (let h = 0; h < nH; h++) {
    const tw = h ^ 1;
    const v = origin(tw);
    const l = out[v]!;
    next[h] = l[(posInV[tw]! - 1 + l.length) % l.length]!;
  }

  // ---- cycles ----
  const cyc = new Int32Array(nH).fill(-1);
  const cycles: number[][] = [], cArea: number[] = [], cCent: Vec2[] = [];
  const hePts = (h: number): Float64Array => {
    const f = subs[h >> 1]!.fine;
    if (!(h & 1)) return f;
    const r = new Float64Array(f.length);
    const m = f.length / 2;
    for (let k = 0; k < m; k++) { r[2 * k] = f[2 * (m - 1 - k)]!; r[2 * k + 1] = f[2 * (m - 1 - k) + 1]!; }
    return r;
  };
  for (let h0 = 0; h0 < nH; h0++) {
    if (cyc[h0]! >= 0) continue;
    const c: number[] = [];
    let h = h0, guard = 0;
    while (cyc[h]! < 0) {
      cyc[h] = cycles.length;
      c.push(h);
      h = next[h]!;
      if (++guard > nH + 1) throw new Error('geom: arrangement cycle walk did not close');
    }
    let A = 0, cx = 0, cy = 0;
    for (const e of c) {
      const p = hePts(e);
      for (let k = 0; k + 3 < p.length; k += 2) {
        const cr = p[k]! * p[k + 3]! - p[k + 2]! * p[k + 1]!;
        A += cr; cx += (p[k]! + p[k + 2]!) * cr; cy += (p[k + 1]! + p[k + 3]!) * cr;
      }
    }
    A *= 0.5;
    cycles.push(c);
    cArea.push(A);
    cCent.push(A !== 0 ? [cx / (6 * A), cy / (6 * A)] : [VX[origin(c[0]!)]!, VY[origin(c[0]!)]!]);
  }

  // ---- components (union-find over vertices) ----
  const uf = Int32Array.from({ length: nV }, (_, i) => i);
  const find = (a: number): number => { while (uf[a] !== a) { uf[a] = uf[uf[a]!]!; a = uf[a]!; } return a; };
  for (const S of subs) uf[find(S.v0)] = find(S.v1);
  const compOuter = new Map<number, number>();
  for (let c = 0; c < cycles.length; c++) {
    const r = find(origin(cycles[c]![0]!));
    const o = compOuter.get(r);
    if (o === undefined || cArea[c]! < cArea[o]!) compOuter.set(r, c);
  }
  const isOuter = new Uint8Array(cycles.length);
  for (const c of compOuter.values()) isOuter[c] = 1;
  const faces: ArrFace[] = [];
  const cycFace = new Int32Array(cycles.length).fill(-1);
  const polyOf = (c: number): Vec2[] => {
    const pts: Vec2[] = [];
    for (const e of cycles[c]!) {
      const p = hePts(e);
      for (let k = 0; k + 2 < p.length; k += 2) pts.push([p[k]!, p[k + 1]!]);
    }
    return pts;
  };
  const polys = new Map<number, Vec2[]>();
  for (let c = 0; c < cycles.length; c++) {
    if (isOuter[c]) continue;
    cycFace[c] = faces.length;
    faces.push({ outer: cycles[c]!, holes: [], area: cArea[c]!, centroid: cCent[c]! });
    polys.set(c, polyOf(c));
  }
  // nest each component's outer cycle into the smallest bounded cycle of another component containing it
  for (const [root, c] of compOuter) {
    const v = origin(cycles[c]![0]!);
    const x = VX[v]!, y = VY[v]!;
    let best = -1, bestA = Infinity;
    for (const [bc, poly] of polys) {
      if (find(origin(cycles[bc]![0]!)) === root) continue;
      if (cArea[bc]! >= bestA) continue;
      if (pointInPolygon(x, y, poly)) { best = bc; bestA = cArea[bc]!; }
    }
    if (best >= 0) {
      cycFace[c] = cycFace[best]!;
      const F = faces[cycFace[best]!]!;
      F.holes.push(cycles[c]!);
      F.area += cArea[c]!;
    }
  }
  const heFace = new Int32Array(nH);
  for (let h = 0; h < nH; h++) heFace[h] = cycFace[cyc[h]!]!;
  void sq;
  return { vx: Float64Array.from(VX), vy: Float64Array.from(VY), subs, faces, heFace };
}
