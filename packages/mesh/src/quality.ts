// SPDX-License-Identifier: GPL-3.0-or-later
// Element quality metrics. Triangles: angles, radius-edge ratio R/l_min, shape q = 4 sqrt(3) A / sum l^2 (1 = equilateral).
// Tetrahedra: dihedral angles, radius ratio 3 r_in / R_circ (1 = regular), signed volume. Hexes / prisms: signed
// volume at corners (scaled Jacobian minimum). Histograms use 10 bins on [0, 1] for q.

export interface QualitySummary {
  n: number;
  minAngleDeg?: number;
  maxAngleDeg?: number;
  minDihedralDeg?: number;
  maxDihedralDeg?: number;
  maxRadiusEdge?: number;
  minShape: number;
  meanShape: number;
  /** count with shape < 0.1, and with negative (or zero) signed measure */
  nPoor: number;
  nInverted: number;
  /** sum of element areas (2D) or volumes (3D) */
  measure: number;
  hist: number[];
}

const deg = 180 / Math.PI;

export function triQuality(nodes: Float64Array, conn: Int32Array, nv = 3): QualitySummary {
  const n = conn.length / nv;
  let amin = 180, amax = 0, re = 0, qmin = Infinity, qsum = 0, poor = 0, inv = 0, meas = 0;
  const hist = new Array(10).fill(0);
  for (let t = 0; t < n; t++) {
    const i = conn[nv * t]!, j = conn[nv * t + 1]!, k = conn[nv * t + 2]!;
    const ax = nodes[2 * i]!, ay = nodes[2 * i + 1]!, bx = nodes[2 * j]!, by = nodes[2 * j + 1]!, cx = nodes[2 * k]!, cy = nodes[2 * k + 1]!;
    const A = 0.5 * ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
    meas += A;
    if (!(A > 0)) inv++;
    const la2 = (bx - cx) ** 2 + (by - cy) ** 2, lb2 = (cx - ax) ** 2 + (cy - ay) ** 2, lc2 = (ax - bx) ** 2 + (ay - by) ** 2;
    const la = Math.sqrt(la2), lb = Math.sqrt(lb2), lc = Math.sqrt(lc2);
    const angA = Math.acos(Math.max(-1, Math.min(1, (lb2 + lc2 - la2) / (2 * lb * lc)))) * deg;
    const angB = Math.acos(Math.max(-1, Math.min(1, (la2 + lc2 - lb2) / (2 * la * lc)))) * deg;
    const angC = 180 - angA - angB;
    amin = Math.min(amin, angA, angB, angC);
    amax = Math.max(amax, angA, angB, angC);
    const R = (la * lb * lc) / (4 * Math.abs(A));
    re = Math.max(re, R / Math.min(la, lb, lc));
    const q = (4 * Math.sqrt(3) * A) / (la2 + lb2 + lc2);
    qmin = Math.min(qmin, q);
    qsum += q;
    if (q < 0.1) poor++;
    hist[Math.min(9, Math.max(0, Math.floor(q * 10)))]++;
  }
  return { n, minAngleDeg: amin, maxAngleDeg: amax, maxRadiusEdge: re, minShape: qmin, meanShape: qsum / n, nPoor: poor, nInverted: inv, measure: meas, hist };
}

const FACES = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];

export function tetQuality(nodes: Float64Array, conn: Int32Array, nv = 4): QualitySummary {
  const n = conn.length / nv;
  let dmin = 180, dmax = 0, qmin = Infinity, qsum = 0, poor = 0, inv = 0, meas = 0;
  const hist = new Array(10).fill(0);
  const P = new Float64Array(12);
  const nrm = new Float64Array(12), area = new Float64Array(4);
  for (let e = 0; e < n; e++) {
    for (let a = 0; a < 4; a++) {
      const v = conn[nv * e + a]!;
      P[3 * a] = nodes[3 * v]!; P[3 * a + 1] = nodes[3 * v + 1]!; P[3 * a + 2] = nodes[3 * v + 2]!;
    }
    const ux = P[3]! - P[0]!, uy = P[4]! - P[1]!, uz = P[5]! - P[2]!;
    const vx = P[6]! - P[0]!, vy = P[7]! - P[1]!, vz = P[8]! - P[2]!;
    const wx = P[9]! - P[0]!, wy = P[10]! - P[1]!, wz = P[11]! - P[2]!;
    const V = (ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6;
    meas += V;
    if (!(V > 0)) inv++;
    // outward face normals (area-weighted, for faces opposite each vertex)
    let S = 0;
    for (let f = 0; f < 4; f++) {
      const [a, b, c] = FACES[f]!;
      const e1x = P[3 * b!]! - P[3 * a!]!, e1y = P[3 * b! + 1]! - P[3 * a! + 1]!, e1z = P[3 * b! + 2]! - P[3 * a! + 2]!;
      const e2x = P[3 * c!]! - P[3 * a!]!, e2y = P[3 * c! + 1]! - P[3 * a! + 1]!, e2z = P[3 * c! + 2]! - P[3 * a! + 2]!;
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz);
      area[f] = 0.5 * l;
      S += 0.5 * l;
      nrm[3 * f] = nx / l; nrm[3 * f + 1] = ny / l; nrm[3 * f + 2] = nz / l;
    }
    // dihedral between faces f, g: pi - angle between outward normals
    for (let f = 0; f < 4; f++)
      for (let g = f + 1; g < 4; g++) {
        const c = nrm[3 * f]! * nrm[3 * g]! + nrm[3 * f + 1]! * nrm[3 * g + 1]! + nrm[3 * f + 2]! * nrm[3 * g + 2]!;
        const d = (Math.PI - Math.acos(Math.max(-1, Math.min(1, c)))) * deg;
        if (d < dmin) dmin = d;
        if (d > dmax) dmax = d;
      }
    // radius ratio 3 r / R: r = 3V / S, R from the circumsphere
    const r = (3 * Math.abs(V)) / S;
    const a2 = ux * ux + uy * uy + uz * uz, b2 = vx * vx + vy * vy + vz * vz, c2 = wx * wx + wy * wy + wz * wz;
    const cx = a2 * (vy * wz - vz * wy) + b2 * (wy * uz - wz * uy) + c2 * (uy * vz - uz * vy);
    const cy = a2 * (vz * wx - vx * wz) + b2 * (wz * ux - wx * uz) + c2 * (uz * vx - ux * vz);
    const cz = a2 * (vx * wy - vy * wx) + b2 * (wx * uy - wy * ux) + c2 * (ux * vy - uy * vx);
    const R = Math.hypot(cx, cy, cz) / (12 * Math.abs(V));
    const q = V > 0 ? (3 * r) / R : 0;
    qmin = Math.min(qmin, q);
    qsum += q;
    if (q < 0.1) poor++;
    hist[Math.min(9, Math.max(0, Math.floor(q * 10)))]++;
  }
  return { n, minDihedralDeg: dmin, maxDihedralDeg: dmax, minShape: qmin, meanShape: qsum / n, nPoor: poor, nInverted: inv, measure: meas, hist };
}

/** Signed volume of a prism6 / hex8 by splitting into tets (min tet volume ratio as a validity check). */
export function solidQuality(nodes: Float64Array, conn: Int32Array, type: 'hex8' | 'prism6'): QualitySummary {
  const split = type === 'hex8'
    ? [[0, 1, 3, 4], [1, 2, 3, 6], [1, 6, 3, 4], [4, 6, 5, 1], [3, 6, 7, 4]]
    : [[0, 1, 2, 3], [1, 2, 3, 4], [2, 3, 4, 5]];
  const nv = type === 'hex8' ? 8 : 6;
  const n = conn.length / nv;
  let meas = 0, inv = 0, qmin = Infinity, qsum = 0, poor = 0;
  const hist = new Array(10).fill(0);
  for (let e = 0; e < n; e++) {
    let V = 0, vmin = Infinity;
    for (const t of split) {
      const p = t.map((a) => conn[nv * e + a]!);
      const o = p[0]!;
      const u = [0, 1, 2].map((c) => nodes[3 * p[1]! + c]! - nodes[3 * o + c]!);
      const v = [0, 1, 2].map((c) => nodes[3 * p[2]! + c]! - nodes[3 * o + c]!);
      const w = [0, 1, 2].map((c) => nodes[3 * p[3]! + c]! - nodes[3 * o + c]!);
      const vt = (u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!)) / 6;
      V += vt;
      vmin = Math.min(vmin, vt);
    }
    meas += V;
    if (!(vmin > 0)) inv++;
    const q = V > 0 ? Math.max(0, (vmin * (type === 'hex8' ? 6 : 3)) / V) : 0; // 1 for a parallelepiped / right prism
    qmin = Math.min(qmin, q);
    qsum += q;
    if (q < 0.1) poor++;
    hist[Math.min(9, Math.max(0, Math.floor(q * 10)))]++;
  }
  return { n, minShape: qmin, meanShape: qsum / n, nPoor: poor, nInverted: inv, measure: meas, hist };
}
