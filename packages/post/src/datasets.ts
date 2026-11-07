// SPDX-License-Identifier: GPL-3.0-or-later
// Results datasets (DevLog-026, DevLog-023 s.3.2 / s.3.3): solution steps, cut points, cut lines (2D and 3D; uniform
// sampling or element-crossing pieces; Gauss 3 points per piece for integrals), 2D edges (boundary facets selected by
// entity id, chained and ordered by arc length), and region quadrature (domains, boundaries) used by the evaluations.
// Plain arguments only (mesh, solution, points, ids): no spec node shapes (lane R0 owns the schema).

import type { CellType, Mesh, Solution } from '@amp/spec/types';
// selectEntities = @amp/geom resolveEntityIds (exact id, split pieces, parents, ancestors) that throws on unknown ids;
// @amp/geom is not a direct dependency of @amp/post (DevLog-026 s.1.4)
import { NPC, nCells, nFacets, selectEntities } from '@amp/physics/common/mesh';
import { REF_DIM, defaultRule, shape } from '@amp/physics/common/lagrange';
import { locatorFor } from './evaluate.ts';
import { locatePoints, type PointSet } from './points.ts';

/** Quadrature points of a region: point set, weights (measure element times rule weight, no 2 pi r), arc length. */
export interface QuadSet {
  points: PointSet;
  /** dV, dA or ds per point (the axisymmetric 2 pi r factor is applied by the evaluations) */
  w: Float64Array;
  /** arc length per point (lines and edges) */
  s?: Float64Array;
  /** geometric dimension of the region: 1 line or edge, 2 surface, 3 volume */
  rdim: number;
}

// ------------------------------------------------------------------------------------------------ solution steps

export type StepSelect = 'all' | 'first' | 'last' | readonly number[];

export interface SolutionSteps {
  /** step indices (field `step`; a solution without steps has the single index 0) */
  indices: number[];
  /** step values in `unit` (time, eigenvalue / frequency, parameter), or null without `Solution.steps` */
  values: number[] | null;
  unit: string | null;
  kind: 'time' | 'eigen' | 'freq' | 'param' | 'stationary';
}

/** Steps of a solution: all, first, last, or given indices (each must exist). */
export function solutionSteps(sol: Solution, steps: StepSelect = 'all'): SolutionSteps {
  const present = [...new Set(sol.fields.map((f) => f.step ?? 0))].sort((a, b) => a - b);
  let idx: number[];
  if (steps === 'all') idx = present;
  else if (steps === 'first') idx = present.slice(0, 1);
  else if (steps === 'last') idx = present.slice(-1);
  else {
    const missing = steps.filter((i) => !present.includes(i));
    if (missing.length) throw new Error(`steps ${missing.join(', ')} not in the solution (have ${present.join(', ')})`);
    idx = [...steps];
  }
  const st = sol.steps;
  return { indices: idx, values: st ? idx.map((i) => st.values[i] ?? NaN) : null, unit: st ? st.unit : null, kind: st ? st.kind : 'stationary' };
}

// ------------------------------------------------------------------------------------------------------ cut points

export interface CutPointsDataset { kind: 'points'; mesh: Mesh; points: PointSet; /** indices of points outside the mesh */ outside: number[] }

export function cutPoints(mesh: Mesh, points: ArrayLike<number> | readonly (readonly number[])[], o: { snap?: number } = {}): CutPointsDataset {
  const ps = locatePoints(mesh, points, o);
  const outside: number[] = [];
  for (let i = 0; i < ps.n; i++) if (ps.cell[i]! < 0) outside.push(i);
  return { kind: 'points', mesh, points: ps, outside };
}

// -------------------------------------------------------------------------------------------------------- cut line

const G3X = [0.5 - 0.5 * Math.sqrt(0.6), 0.5, 0.5 + 0.5 * Math.sqrt(0.6)];
const G3W = [5 / 18, 8 / 18, 5 / 18];
const SIMPLEX = new Set<CellType>(['tri3', 'tri6', 'tet4', 'tet10']);
const EDGES_TRI: Array<[number, number, number]> = [[0, 1, 3], [1, 2, 4], [2, 0, 5]];
const EDGES_TET: Array<[number, number, number]> = [[0, 1, 4], [1, 2, 5], [0, 2, 6], [0, 3, 7], [1, 3, 8], [2, 3, 9]];

export interface LineDataset {
  kind: 'line';
  mesh: Mesh;
  p0: number[]; p1: number[];
  length: number;
  /** length of the parts of the line inside the mesh */
  covered: number;
  mode: 'uniform' | 'crossing';
  /** plot points: uniform n points, or per element piece its start, middle and end (in that piece's cell) */
  points: PointSet;
  s: Float64Array;
  /** element pieces (arc length start, end), inside the mesh */
  pieces: Float64Array;
  /** Gauss 3 points per piece; w = ds */
  quad: QuadSet;
}

const affineCache = new WeakMap<Mesh, Uint8Array>();
/** Per cell: 1 when the cell is an affine simplex (straight edges, mid nodes at edge midpoints). */
function affineCells(mesh: Mesh): Uint8Array {
  let a = affineCache.get(mesh);
  if (a) return a;
  const type = mesh.cells.type, k = NPC[type], dim = mesh.dim, nc = nCells(mesh), X = mesh.nodes, C = mesh.cells.conn;
  a = new Uint8Array(nc);
  if (!SIMPLEX.has(type)) { affineCache.set(mesh, a); return a; }
  const edges = type === 'tri6' ? EDGES_TRI : type === 'tet10' ? EDGES_TET : null;
  for (let c = 0; c < nc; c++) {
    let ok = 1;
    if (edges) for (const [i, j, m] of edges) {
      let dev = 0, len = 0;
      for (let d = 0; d < dim; d++) {
        const xi = X[dim * C[k * c + i]! + d]!, xj = X[dim * C[k * c + j]! + d]!, xm = X[dim * C[k * c + m]! + d]!;
        dev += (xm - 0.5 * (xi + xj)) ** 2; len += (xj - xi) ** 2;
      }
      if (dev > 1e-24 * len) { ok = 0; break; }
    }
    a[c] = ok;
  }
  affineCache.set(mesh, a);
  return a;
}

/** Parameter interval [lo, hi] (in [0, 1]) of p0 + t (p1 - p0) inside an affine simplex c, or null. */
function simplexInterval(mesh: Mesh, c: number, p0: ArrayLike<number>, d: ArrayLike<number>, lo0: number, hi0: number): [number, number] | null {
  const dim = mesh.dim, k = NPC[mesh.cells.type], X = mesh.nodes, C = mesh.cells.conn;
  const v = (a: number, q: number) => X[dim * C[k * c + a]! + q]!;
  // barycentric l_1..l_dim = A^-1 (p - v0), A columns v_i - v0
  const A: number[] = [];
  for (let r = 0; r < dim; r++) for (let s = 0; s < dim; s++) A.push(v(s + 1, r) - v(0, r));
  const inv = invert(A, dim);
  const q0 = new Array<number>(dim + 1).fill(0), dq = new Array<number>(dim + 1).fill(0);
  let s0 = 0, sd = 0;
  for (let i = 0; i < dim; i++) {
    let a = 0, b = 0;
    for (let j = 0; j < dim; j++) { a += inv[dim * i + j]! * (p0[j]! - v(0, j)); b += inv[dim * i + j]! * d[j]!; }
    q0[i + 1] = a; dq[i + 1] = b; s0 += a; sd += b;
  }
  q0[0] = 1 - s0; dq[0] = -sd;
  let lo = lo0, hi = hi0;
  for (let i = 0; i <= dim; i++) {
    const a = q0[i]!, b = dq[i]!;
    if (b === 0) { if (a < 0) return null; continue; }
    const t = -a / b;
    if (b > 0) { if (t > lo) lo = t; } else if (t < hi) hi = t;
    if (lo > hi) return null;
  }
  return hi > lo ? [lo, hi] : null;
}

function invert(A: number[], dim: number): number[] {
  if (dim === 2) {
    const [a, b, c, d] = A as [number, number, number, number], det = a * d - b * c;
    return [d / det, -b / det, -c / det, a / det];
  }
  const [a, b, c, d, e, f, g, h, k] = A as [number, number, number, number, number, number, number, number, number];
  const A0 = e * k - f * h, B0 = -(d * k - f * g), C0 = d * h - e * g, det = a * A0 + b * B0 + c * C0;
  return [A0 / det, -(b * k - c * h) / det, (b * f - c * e) / det, B0 / det, (a * k - c * g) / det, -(a * f - c * d) / det, C0 / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Clip the segment parameter range [0, 1] to the axis-aligned box of cell c (slab test), or null. */
function clipBox(boxes: Float64Array, dim: number, c: number, p0: ArrayLike<number>, d: ArrayLike<number>): [number, number] | null {
  let lo = 0, hi = 1;
  for (let q = 0; q < dim; q++) {
    const a = boxes[2 * dim * c + q]!, b = boxes[2 * dim * c + dim + q]!;
    if (d[q] === 0) { if (p0[q]! < a || p0[q]! > b) return null; continue; }
    let t0 = (a - p0[q]!) / d[q]!, t1 = (b - p0[q]!) / d[q]!;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > lo) lo = t0; if (t1 < hi) hi = t1;
    if (lo > hi) return null;
  }
  return [lo, hi];
}

const EDGES_2D: Partial<Record<CellType, Array<[number, number, number]>>> = {
  tri3: [[0, 1, -1], [1, 2, -1], [2, 0, -1]], tri6: [[0, 1, 3], [1, 2, 4], [2, 0, 5]], quad4: [[0, 1, -1], [1, 2, -1], [2, 3, -1], [3, 0, -1]],
};

/**
 * 2D cell c (straight or P2-curved edges): parameters t of every intersection of the line p0 + t d with the cell's
 * edges. On an edge x(xi) = sum N_i(xi) X_i (line3 basis, or line2), n . (x(xi) - p0) = 0 with n normal to d is a
 * quadratic in xi, solved in closed form; so short inside pieces of curved boundary cells are never missed.
 */
function edgeHits(mesh: Mesh, c: number, p0: readonly number[], d: readonly number[], out: number[]): void {
  const k = NPC[mesh.cells.type], X = mesh.nodes, C = mesh.cells.conn, edges = EDGES_2D[mesh.cells.type];
  if (!edges) throw new Error(`cut line: ${mesh.cells.type} cells not supported in 2D`);
  const nx = -d[1]!, ny = d[0]!, dd = d[0]! * d[0]! + d[1]! * d[1]!;
  const g = (nd: number) => nx * (X[2 * nd]! - p0[0]!) + ny * (X[2 * nd + 1]! - p0[1]!);
  for (const [i, j, mi] of edges) {
    const a = C[k * c + i]!, b = C[k * c + j]!, m = mi >= 0 ? C[k * c + mi]! : -1;
    const g0 = g(a), g1 = g(b);
    const roots: number[] = [];
    if (m < 0) { if (g0 !== g1) roots.push(g0 / (g0 - g1)); }
    else {
      const gm = g(m), A = 2 * g0 + 2 * g1 - 4 * gm, B = -3 * g0 - g1 + 4 * gm, Cc = g0;
      const scale = Math.abs(g0) + Math.abs(g1) + Math.abs(gm);
      if (Math.abs(A) <= 1e-14 * scale) { if (B !== 0) roots.push(-Cc / B); }
      else {
        const disc = B * B - 4 * A * Cc;
        if (disc >= 0) {
          const q = -0.5 * (B + (B >= 0 ? Math.sqrt(disc) : -Math.sqrt(disc)));
          roots.push(q / A); if (q !== 0) roots.push(Cc / q);
        }
      }
    }
    for (const xi of roots) {
      if (!(xi >= -1e-12 && xi <= 1 + 1e-12)) continue;
      const u = Math.min(1, Math.max(0, xi));
      let px: number, py: number;
      if (m < 0) { px = (1 - u) * X[2 * a]! + u * X[2 * b]!; py = (1 - u) * X[2 * a + 1]! + u * X[2 * b + 1]!; }
      else {
        const N0 = (1 - u) * (1 - 2 * u), N1 = u * (2 * u - 1), N2 = 4 * u * (1 - u);
        px = N0 * X[2 * a]! + N1 * X[2 * b]! + N2 * X[2 * m]!; py = N0 * X[2 * a + 1]! + N1 * X[2 * b + 1]! + N2 * X[2 * m + 1]!;
      }
      const t = (d[0]! * (px - p0[0]!) + d[1]! * (py - p0[1]!)) / dd;
      if (t > 0 && t < 1) out.push(t);
    }
  }
}

/** Sorted breakpoints t in [0, 1] where p0 -> p1 enters or leaves a cell (0 and 1 included). */
export function lineCrossings(mesh: Mesh, p0: readonly number[], p1: readonly number[]): Float64Array {
  const dim = mesh.dim, L = locatorFor(mesh), nc = nCells(mesh), aff = affineCells(mesh);
  const d = p0.map((v, i) => p1[i]! - v);
  const br: number[] = [0, 1];
  const p = new Float64Array(dim), ref = new Float64Array(3);
  const inside = (c: number, t: number) => { for (let q = 0; q < dim; q++) p[q] = p0[q]! + t * d[q]!; return L.inCell(c, p, ref, 1e-12); };
  for (let c = 0; c < nc; c++) {
    const box = clipBox(L.boxes, dim, c, p0, d);
    if (!box) continue;
    if (aff[c]) { const iv = simplexInterval(mesh, c, p0, d, box[0], box[1]); if (iv) br.push(iv[0], iv[1]); continue; }
    if (dim === 2) { edgeHits(mesh, c, p0, d, br); continue; }
    // 3D curved or non-simplex cell: sample the clipped range (and the corner simplex interval, if any), bisect each
    // inside / outside change; an inside interval shorter than the sample spacing can be missed (DevLog-026 s.6)
    const ts: number[] = [];
    const m = 32;
    for (let i = 0; i <= m; i++) ts.push(box[0] + ((box[1] - box[0]) * i) / m);
    if (SIMPLEX.has(mesh.cells.type)) { const iv = simplexInterval(mesh, c, p0, d, box[0], box[1]); if (iv) for (let i = 0; i <= 8; i++) ts.push(iv[0] + ((iv[1] - iv[0]) * i) / 8); }
    ts.sort((a, b) => a - b);
    const fl = ts.map((t) => inside(c, t));
    for (let i = 0; i + 1 < ts.length; i++) {
      if (fl[i] === fl[i + 1]) continue;
      let a = ts[i]!, b = ts[i + 1]!;
      const fa = fl[i]!;
      for (let it = 0; it < 60 && b - a > 1e-15; it++) { const h = 0.5 * (a + b); if (inside(c, h) === fa) a = h; else b = h; }
      br.push(0.5 * (a + b));
    }
    if (fl[0]) br.push(ts[0]!);
    if (fl[fl.length - 1]) br.push(ts[ts.length - 1]!);
  }
  br.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of br) { const u = Math.min(1, Math.max(0, t)); if (!out.length || u - out[out.length - 1]! > 1e-11) out.push(u); }
  if (out[out.length - 1]! < 1) out[out.length - 1] = 1;
  return Float64Array.from(out);
}

/**
 * Cut line from p0 to p1 (2D or 3D, SI metres). `mode` 'uniform' samples n points (default 200) for plots; 'crossing'
 * gives per element piece its start, middle and end, located in that piece's cell (exact element-wise representation,
 * shows jumps of discontinuous expressions). The quadrature is always Gauss 3 points per element piece.
 */
export function cutLine(mesh: Mesh, p0: readonly number[], p1: readonly number[], o: { n?: number; mode?: 'uniform' | 'crossing'; snap?: number } = {}): LineDataset {
  const dim = mesh.dim;
  if (p0.length !== dim || p1.length !== dim) throw new Error(`cutLine: points need ${dim} coordinates`);
  const d = p0.map((v, i) => p1[i]! - v);
  let len2 = 0; for (const v of d) len2 += v * v;
  const length = Math.sqrt(len2);
  if (!(length > 0)) throw new Error('cutLine: p0 and p1 coincide');
  const tan = d.map((v) => v / length);
  const L = locatorFor(mesh);
  const br = lineCrossings(mesh, p0, p1);
  const pieces: number[] = [], qx: number[] = [], qc: number[] = [], qr: number[] = [], qw: number[] = [], qs: number[] = [];
  const px: number[] = [], pc: number[] = [], pr: number[] = [], pss: number[] = [];
  const p = new Float64Array(dim), ref = new Float64Array(3);
  const at = (t: number) => { for (let q = 0; q < dim; q++) p[q] = p0[q]! + t * d[q]!; return p; };
  const inCellOrLocate = (c: number, t: number): [number, Float64Array] | null => {
    at(t);
    if (L.inCell(c, p, ref, 1e-7)) return [c, ref.slice()];
    const loc = L.locate(p, o.snap ?? 0);
    return loc ? [loc.cell, Float64Array.from([loc.ref[0] ?? 0, loc.ref[1] ?? 0, loc.ref[2] ?? 0])] : null;
  };
  let covered = 0;
  for (let i = 0; i + 1 < br.length; i++) {
    const ta = br[i]!, tb = br[i + 1]!;
    const loc = L.locate(at(0.5 * (ta + tb)), o.snap ?? 0);
    if (!loc) continue;
    pieces.push(ta * length, tb * length);
    covered += (tb - ta) * length;
    for (let g = 0; g < 3; g++) {
      const t = ta + G3X[g]! * (tb - ta), r = inCellOrLocate(loc.cell, t);
      for (let q = 0; q < dim; q++) qx.push(p[q]!);
      qc.push(r ? r[0] : -1); qr.push(r ? r[1][0]! : 0, r ? r[1][1]! : 0, r ? r[1][2]! : 0);
      qw.push(G3W[g]! * (tb - ta) * length); qs.push(t * length);
    }
    if (o.mode === 'crossing') for (const t of [ta, 0.5 * (ta + tb), tb]) {
      const r: [number, Float64Array] | null = inCellOrLocate(loc.cell, t);
      for (let q = 0; q < dim; q++) px.push(p[q]!);
      pc.push(r ? r[0] : -1); pr.push(r ? r[1][0]! : 0, r ? r[1][1]! : 0, r ? r[1][2]! : 0); pss.push(t * length);
    }
  }
  const tangentOf = (n: number) => { const t = new Float64Array(dim * n); for (let i = 0; i < n; i++) for (let q = 0; q < dim; q++) t[dim * i + q] = tan[q]!; return t; };
  const normalOf = (n: number) => { if (dim !== 2) return undefined; const v = new Float64Array(2 * n); for (let i = 0; i < n; i++) { v[2 * i] = tan[1]!; v[2 * i + 1] = -tan[0]!; } return v; };
  const mk = (x: number[], c: number[], r: number[]): PointSet => {
    const n = c.length, nm = normalOf(n);
    return { mesh, n, x: Float64Array.from(x), cell: Int32Array.from(c), ref: Float64Array.from(r), tangent: tangentOf(n), ...(nm ? { normal: nm } : {}) };
  };
  let points: PointSet, s: Float64Array;
  if (o.mode === 'crossing') { points = mk(px, pc, pr); s = Float64Array.from(pss); }
  else {
    const n = o.n ?? 200;
    if (!(Number.isInteger(n) && n >= 2)) throw new Error('cutLine: n must be an integer >= 2');
    const x = new Float64Array(dim * n); s = new Float64Array(n);
    for (let i = 0; i < n; i++) { const t = i / (n - 1); for (let q = 0; q < dim; q++) x[dim * i + q] = p0[q]! + t * d[q]!; s[i] = t * length; }
    points = locatePoints(mesh, x, o.snap ? { snap: o.snap } : {});
    points.tangent = tangentOf(n);
    const nm = normalOf(n); if (nm) points.normal = nm;
  }
  return {
    kind: 'line', mesh, p0: [...p0], p1: [...p1], length, covered, mode: o.mode ?? 'uniform', points, s, pieces: Float64Array.from(pieces),
    quad: { points: mk(qx, qc, qr), w: Float64Array.from(qw), s: Float64Array.from(qs), rdim: 1 },
  };
}

// --------------------------------------------------------------------------------------- facets: cells, quadrature

const LOCAL_FACETS: Partial<Record<CellType, number[][]>> = {
  tri3: [[0, 1], [1, 2], [2, 0]], tri6: [[0, 1], [1, 2], [2, 0]], quad4: [[0, 1], [1, 2], [2, 3], [3, 0]],
  tet4: [[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]], tet10: [[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]],
  hex8: [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
};
const FACET_CORNERS: Partial<Record<CellType, number>> = { line2: 2, line3: 2, tri3: 3, tri6: 3, quad4: 4 };

const adjCache = new WeakMap<Mesh, Map<string, number>>();
/** Cell adjacent to facet f (first cell found that has the facet's corner nodes). */
export function facetCell(mesh: Mesh, f: number): number {
  let m = adjCache.get(mesh);
  if (!m) {
    m = new Map();
    const type = mesh.cells.type, k = NPC[type], lf = LOCAL_FACETS[type];
    if (!lf) throw new Error(`facets of ${type} cells not supported`);
    const nc = nCells(mesh);
    for (let c = 0; c < nc; c++) for (const fl of lf) {
      const key = fl.map((a) => mesh.cells.conn[k * c + a]!).sort((a, b) => a - b).join(',');
      if (!m.has(key)) m.set(key, c);
    }
    adjCache.set(mesh, m);
  }
  const ft = mesh.facets.type, kf = NPC[ft], nk = FACET_CORNERS[ft]!;
  const key = Array.from({ length: nk }, (_, a) => mesh.facets.conn[kf * f + a]!).sort((a, b) => a - b).join(',');
  const c = m.get(key);
  if (c === undefined) throw new Error(`facet ${f}: no adjacent cell`);
  return c;
}

/** Facet indices on boundaries selected by entity ids (resolveEntityIds; unknown ids are an error). */
export function facetsOfBoundaries(mesh: Mesh, ids: readonly string[]): number[] {
  const bs = new Set(selectEntities(mesh.entities, 'boundaries', ids)), out: number[] = [], nf = nFacets(mesh);
  for (let f = 0; f < nf; f++) if (bs.has(mesh.facets.boundary[f]!)) out.push(f);
  return out;
}

/** Cell mask of domains selected by ids (all cells without ids; unknown ids are an error). */
export function cellsOfDomains(mesh: Mesh, ids?: readonly string[]): Uint8Array {
  const nc = nCells(mesh), mask = new Uint8Array(nc);
  if (!ids) return mask.fill(1);
  const ds = new Set(selectEntities(mesh.entities, 'domains', ids));
  for (let c = 0; c < nc; c++) if (ds.has(mesh.cells.domain[c]!)) mask[c] = 1;
  return mask;
}

/** Facet geometry at facet reference point xi: physical point, measure element, unit normal by the node order. */
function rawFacetPoint(mesh: Mesh, f: number, xi: ArrayLike<number>, x: Float64Array, nrm: Float64Array): number {
  const ft = mesh.facets.type, kf = NPC[ft], rd = REF_DIM[ft]!, dim = mesh.dim, X = mesh.nodes;
  const N = new Float64Array(kf), dN = new Float64Array(kf * rd);
  shape(ft, xi, N, dN);
  const t1 = [0, 0, 0], t2 = [0, 0, 0];
  for (let q = 0; q < dim; q++) x[q] = 0;
  for (let a = 0; a < kf; a++) {
    const nd = mesh.facets.conn[kf * f + a]!;
    for (let q = 0; q < dim; q++) { const v = X[dim * nd + q]!; x[q]! += N[a]! * v; t1[q]! += dN[rd * a]! * v; if (rd === 2) t2[q]! += dN[rd * a + 1]! * v; }
  }
  let J: number;
  if (dim === 2) { J = Math.sqrt(t1[0]! * t1[0]! + t1[1]! * t1[1]!); nrm[0] = t1[1]! / J; nrm[1] = -t1[0]! / J; }
  else {
    const n0 = t1[1]! * t2[2]! - t1[2]! * t2[1]!, n1 = t1[2]! * t2[0]! - t1[0]! * t2[2]!, n2 = t1[0]! * t2[1]! - t1[1]! * t2[0]!;
    J = Math.sqrt(n0 * n0 + n1 * n1 + n2 * n2); nrm[0] = n0 / J; nrm[1] = n1 / J; nrm[2] = n2 / J;
  }
  return J;
}

const FACET_MID: Partial<Record<CellType, number[]>> = { line2: [0.5], line3: [0.5], tri3: [1 / 3, 1 / 3], tri6: [1 / 3, 1 / 3], quad4: [0.5, 0.5] };
const signCache = new WeakMap<Mesh, Int8Array>();
/** +1 / -1: the node-order normal of facet f points out of cell c (decided once per facet, at its middle). */
function facetSign(mesh: Mesh, f: number, c: number): number {
  let sc = signCache.get(mesh);
  if (!sc) { sc = new Int8Array(nFacets(mesh)); signCache.set(mesh, sc); }
  if (sc[f]) return sc[f]!;
  const dim = mesh.dim, X = mesh.nodes, k = NPC[mesh.cells.type], x = new Float64Array(dim), nrm = new Float64Array(dim);
  rawFacetPoint(mesh, f, FACET_MID[mesh.facets.type]!, x, nrm);
  let dot = 0;
  for (let q = 0; q < dim; q++) { let s = 0; for (let a = 0; a < k; a++) s += X[dim * mesh.cells.conn[k * c + a]! + q]!; dot += (x[q]! - s / k) * nrm[q]!; }
  sc[f] = dot < 0 ? -1 : 1;
  return sc[f]!;
}

/** Facet geometry at facet reference point xi: physical point, measure element, unit normal outward from cell c. */
function facetPoint(mesh: Mesh, f: number, xi: ArrayLike<number>, c: number, x: Float64Array, nrm: Float64Array): number {
  const J = rawFacetPoint(mesh, f, xi, x, nrm), sg = facetSign(mesh, f, c);
  if (sg < 0) for (let q = 0; q < mesh.dim; q++) nrm[q] = -nrm[q]!;
  return J;
}

/** Quadrature over boundary facets (2D: edges, 3D: faces), each point located in the facet's adjacent cell. */
export function boundaryQuad(mesh: Mesh, ids: readonly string[], o: { degree?: number } = {}): QuadSet {
  const facets = facetsOfBoundaries(mesh, ids);
  return facetQuad(mesh, facets, null, o.degree ?? defaultDegree(mesh));
}

function defaultDegree(mesh: Mesh): number { return mesh.cells.type === 'tri6' || mesh.cells.type === 'tet10' ? 5 : 3; }

function facetQuad(mesh: Mesh, facets: readonly number[], flip: Uint8Array | null, degree: number): QuadSet {
  const dim = mesh.dim, ft = mesh.facets.type, rule = defaultRule(ft, degree), rd = REF_DIM[ft]!, L = locatorFor(mesh);
  const n = facets.length * rule.n;
  const x = new Float64Array(dim * n), cell = new Int32Array(n), ref = new Float64Array(3 * n), w = new Float64Array(n), normal = new Float64Array(dim * n);
  const xp = new Float64Array(dim), nr = new Float64Array(dim), r = new Float64Array(3), xi = new Float64Array(rd);
  let i = 0;
  facets.forEach((f, fi) => {
    const c = facetCell(mesh, f);
    for (let q = 0; q < rule.n; q++, i++) {
      for (let a = 0; a < rd; a++) xi[a] = rule.pts[rd * q + a]!;
      if (flip && flip[fi] && rd === 1) xi[0] = 1 - xi[0]!;
      w[i] = facetPoint(mesh, f, xi, c, xp, nr) * rule.wts[q]!;
      for (let a = 0; a < dim; a++) { x[dim * i + a] = xp[a]!; normal[dim * i + a] = nr[a]!; }
      if (L.inCell(c, xp, r, 1e-7)) { cell[i] = c; for (let a = 0; a < 3; a++) ref[3 * i + a] = r[a]!; }
      else { const loc = L.locate(xp, 1e-6); cell[i] = loc ? loc.cell : -1; if (loc) for (let a = 0; a < 3; a++) ref[3 * i + a] = loc.ref[a] ?? 0; }
    }
  });
  return { points: { mesh, n, x, cell, ref, normal }, w, rdim: dim - 1 };
}

/** Quadrature over the cells of the selected domains (all without ids); w = det J times the rule weight. */
export function domainQuad(mesh: Mesh, ids?: readonly string[], o: { degree?: number } = {}): QuadSet {
  const mask = cellsOfDomains(mesh, ids);
  const type = mesh.cells.type, k = NPC[type], rd = REF_DIM[type]!, dim = mesh.dim, rule = defaultRule(type, o.degree ?? defaultDegree(mesh));
  let nc = 0; for (const m of mask) nc += m;
  const n = nc * rule.n;
  const x = new Float64Array(dim * n), cell = new Int32Array(n), ref = new Float64Array(3 * n), w = new Float64Array(n);
  const N = new Float64Array(k), dN = new Float64Array(k * rd), J = new Float64Array(9);
  const X = mesh.nodes, C = mesh.cells.conn;
  let i = 0;
  for (let c = 0; c < mask.length; c++) {
    if (!mask[c]) continue;
    for (let q = 0; q < rule.n; q++, i++) {
      const pq = rule.pts.subarray(rd * q, rd * q + rd);
      shape(type, pq, N, dN);
      J.fill(0);
      for (let a = 0; a < k; a++) {
        const nd = C[k * c + a]!;
        for (let p = 0; p < dim; p++) { const v = X[dim * nd + p]!; x[dim * i + p]! += N[a]! * v; for (let s = 0; s < rd; s++) J[3 * p + s]! += v * dN[rd * a + s]!; }
      }
      const det = dim === 2 ? J[0]! * J[4]! - J[1]! * J[3]!
        : J[0]! * (J[4]! * J[8]! - J[5]! * J[7]!) - J[1]! * (J[3]! * J[8]! - J[5]! * J[6]!) + J[2]! * (J[3]! * J[7]! - J[4]! * J[6]!);
      if (!(det > 0)) throw new Error(`domainQuad: non-positive Jacobian ${det} in cell ${c}`);
      w[i] = det * rule.wts[q]!;
      cell[i] = c;
      for (let a = 0; a < rd; a++) ref[3 * i + a] = pq[a]!;
    }
  }
  return { points: { mesh, n, x, cell, ref }, w, rdim: dim };
}

// ------------------------------------------------------------------------------------------------------- 2D edges

export interface EdgeDataset {
  kind: 'edge';
  mesh: Mesh;
  ids: string[];
  /** facets in traversal order, and per facet whether it is traversed from its second corner to its first */
  facets: Int32Array;
  flip: Uint8Array;
  /** chains as [first, end) ranges into `facets` (one per connected piece) */
  chains: Array<[number, number]>;
  /** the same chains as [first, end) ranges into `points` / `s` (s runs on across chains: do not join chains in a plot) */
  chainPoints: Array<[number, number]>;
  length: number;
  /** plot points: facet nodes in traversal order (shared nodes once per chain), with outward normal and tangent */
  points: PointSet;
  s: Float64Array;
  quad: QuadSet;
}

/**
 * 2D edge dataset: boundary facets of the selected boundaries (entity ids through resolveEntityIds), chained by shared
 * corner nodes and ordered by arc length s. An open chain starts at the open end with the smaller x, then y. A closed
 * loop starts at its node with the smallest x, then y, and runs with the outward normal n (out of the adjacent cells) on
 * its right, t = (-n_y, n_x): counterclockwise around a domain, clockwise around a hole. `reverse` flips every chain.
 * Fields are evaluated in the facet's adjacent cell (the first one found on internal interfaces).
 */
export function edgeDataset(mesh: Mesh, ids: readonly string[], o: { reverse?: boolean; degree?: number } = {}): EdgeDataset {
  if (mesh.dim !== 2) throw new Error('edgeDataset: 2D meshes only (3D edges are not in the C2 mesh)');
  const ft = mesh.facets.type, kf = NPC[ft], X = mesh.nodes, FC = mesh.facets.conn;
  const fs = facetsOfBoundaries(mesh, ids);
  if (!fs.length) throw new Error(`edgeDataset: no facets on ${ids.join(', ')}`);
  const ends = (f: number) => [FC[kf * f]!, FC[kf * f + 1]!] as const;
  const byNode = new Map<number, number[]>();
  for (const f of fs) for (const v of ends(f)) { const l = byNode.get(v) ?? []; l.push(f); byNode.set(v, l); }
  const less = (a: number, b: number) => X[2 * a]! < X[2 * b]! || (X[2 * a] === X[2 * b] && X[2 * a + 1]! < X[2 * b + 1]!);
  const used = new Set<number>();
  const order: number[] = [], flips: number[] = [], chains: Array<[number, number]> = [];
  while (used.size < fs.length) {
    // start node: an open end (degree 1) of the unused facets, smallest (x, y); else the smallest node of a loop
    let open = -1, any = -1;
    for (const [v, l] of byNode) {
      if (!l.some((f) => !used.has(f))) continue;
      if (l.length === 1 && (open < 0 || less(v, open))) open = v;
      if (any < 0 || less(v, any)) any = v;
    }
    const start = open >= 0 ? open : any;
    const c0 = order.length;
    let v = start;
    for (;;) {
      const f = byNode.get(v)!.find((g) => !used.has(g));
      if (f === undefined) break;
      used.add(f);
      const [a, b] = ends(f);
      order.push(f); flips.push(a === v ? 0 : 1);
      v = a === v ? b : a;
    }
    if (v === start && order.length - c0 > 1 && traversalSign(mesh, order[c0]!, flips[c0]!).t0 < 0) {
      // closed loop against the convention: reverse it (same start node)
      const seg = order.slice(c0).reverse(), fl = flips.slice(c0).reverse().map((x) => 1 - x);
      for (let i = c0; i < order.length; i++) { order[i] = seg[i - c0]!; flips[i] = fl[i - c0]!; }
    }
    chains.push([c0, order.length]);
  }
  if (o.reverse) for (const [a, b] of chains) {
    const seg = order.slice(a, b).reverse(), fl = flips.slice(a, b).reverse().map((x) => 1 - x);
    for (let i = a; i < b; i++) { order[i] = seg[i - a]!; flips[i] = fl[i - a]!; }
  }
  const flip = Uint8Array.from(flips), facets = Int32Array.from(order);
  // arc length: facet lengths and partial lengths by a 6-point Gauss rule on [0, xi]
  const flen = new Float64Array(facets.length);
  const xp = new Float64Array(2), nr = new Float64Array(2);
  const G = defaultRule('line2', 9);
  const partial = (f: number, c: number, xi: number) => {
    let s = 0;
    for (let q = 0; q < G.n; q++) s += G.wts[q]! * xi * facetPoint(mesh, f, [G.pts[q]! * xi], c, xp, nr);
    return s;
  };
  const cells = Array.from(facets, (f) => facetCell(mesh, f));
  facets.forEach((f, i) => { flen[i] = partial(f, cells[i]!, 1); });
  const s0 = new Float64Array(facets.length);
  let length = 0;
  for (const [a, b] of chains) for (let i = a; i < b; i++) { s0[i] = length; length += flen[i]!; }
  // quadrature in traversal order with s
  const quad = facetQuad(mesh, Array.from(facets), flip, o.degree ?? defaultDegree(mesh));
  const nq = quad.w.length / facets.length, qs = new Float64Array(quad.w.length);
  const rule = defaultRule(ft, o.degree ?? defaultDegree(mesh));
  for (let i = 0; i < facets.length; i++) for (let q = 0; q < nq; q++) {
    const xi = rule.pts[q]!, xt = flip[i] ? 1 - xi : xi;
    // s grows along the traversal: from the start corner
    qs[i * nq + q] = s0[i]! + (flip[i] ? flen[i]! - partial(facets[i]!, cells[i]!, xt) : partial(facets[i]!, cells[i]!, xt));
  }
  quad.s = qs;
  // tangent along the traversal at the quadrature points: normal rotated (outward n, t = (-ny, nx) or its reverse)
  // plot points: nodes at xi = 0 (, 0.5), 1 in traversal order
  const L = locatorFor(mesh);
  const px: number[] = [], pc: number[] = [], pr: number[] = [], pn: number[] = [], pt: number[] = [], ps: number[] = [];
  const r = new Float64Array(3);
  const stops = kf === 3 ? [0, 0.5, 1] : [0, 1];
  const tsg = Array.from(facets, (f, i) => traversalSign(mesh, f, flip[i]!).t0);
  const chainPoints: Array<[number, number]> = [];
  for (const [a, b] of chains) for (let i = a; i < b; i++) {
    if (i === a) chainPoints.push([pc.length, pc.length]);
    const f = facets[i]!, c = cells[i]!;
    for (const [j, u] of stops.entries()) {
      if (j === stops.length - 1 && i < b - 1) continue;   // the next facet starts here
      const xi = flip[i] ? 1 - u : u;
      facetPoint(mesh, f, [xi], c, xp, nr);
      px.push(xp[0]!, xp[1]!); pn.push(nr[0]!, nr[1]!);
      pt.push(-nr[1]! * tsg[i]!, nr[0]! * tsg[i]!);
      const ok = L.inCell(c, xp, r, 1e-7);
      pc.push(ok ? c : -1); pr.push(ok ? r[0]! : 0, ok ? r[1]! : 0, 0);
      ps.push(s0[i]! + (u === 0 ? 0 : u === 1 ? flen[i]! : (flip[i] ? flen[i]! - partial(f, c, xi) : partial(f, c, xi))));
    }
    chainPoints[chainPoints.length - 1]![1] = pc.length;
  }
  const qt = new Float64Array(quad.points.n * 2);
  for (let i = 0; i < facets.length; i++) {
    for (let q = 0; q < nq; q++) { const m = i * nq + q; qt[2 * m] = -quad.points.normal![2 * m + 1]! * tsg[i]!; qt[2 * m + 1] = quad.points.normal![2 * m]! * tsg[i]!; }
  }
  quad.points.tangent = qt;
  const points: PointSet = { mesh, n: pc.length, x: Float64Array.from(px), cell: Int32Array.from(pc), ref: Float64Array.from(pr), normal: Float64Array.from(pn), tangent: Float64Array.from(pt) };
  return { kind: 'edge', mesh, ids: [...ids], facets, flip, chains, chainPoints, length, points, s: Float64Array.from(ps), quad };
}

/** Sign so that t = sign * (-ny, nx) points along the traversal of facet f (outward normal n). */
function traversalSign(mesh: Mesh, f: number, flip: number): { t0: number } {
  const kf = NPC[mesh.facets.type], X = mesh.nodes, FC = mesh.facets.conn;
  let a = FC[kf * f]!, b = FC[kf * f + 1]!;
  if (flip) { const s = a; a = b; b = s; }
  const dx = X[2 * b]! - X[2 * a]!, dy = X[2 * b + 1]! - X[2 * a + 1]!;
  // outward normal of the facet's cell at its middle
  const c = facetCell(mesh, f), xp = new Float64Array(2), nr = new Float64Array(2);
  facetPoint(mesh, f, [0.5], c, xp, nr);
  return { t0: -nr[1]! * dx + nr[0]! * dy >= 0 ? 1 : -1 };
}

