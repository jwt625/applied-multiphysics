// SPDX-License-Identifier: GPL-3.0-or-later
// Evaluations (DevLog-026, DevLog-023 s.3.3): point, global, integral, average, max, min and measure over domains,
// boundaries (2D edges, 3D faces), 2D edge datasets and cut lines. On axisymmetric meshes integrals and measures carry
// the 2 pi r weight by default (`revolve`; r = the first mesh coordinate). Every result states its unit (SI, from the
// expression dimension times the region measure) and, for max / min, its method:
//   nodal    the expression at every node of every selected cell (or boundary facet), in that cell
//   lattice  at the points of a refined barycentric lattice of level `resolution` per triangle (refine.mjs pattern)
//   quad     at the quadrature points of the region
//   points   at the dataset's sample points (cut line, edge, cut points)

import type { Mesh, Solution } from '@amp/spec/types';
import { NPC } from '@amp/physics/common/mesh';
import { compileExpression } from '@amp/core/expr';
import { formatUnit, parseUnit, dimMul, type Dim } from '@amp/core/units';
import { meshOf } from './store.ts';
import { compileFieldExpr, isPointSet, paramLookup, type ExprOptions, type FieldExpr } from './expr.ts';
import { locatePoints, mapToPhysical, NODE_REF, type PointSet } from './points.ts';
import { boundaryQuad, cellsOfDomains, domainQuad, facetCell, facetsOfBoundaries, type CutPointsDataset, type EdgeDataset, type LineDataset, type QuadSet } from './datasets.ts';
import { locatorFor } from './evaluate.ts';
import { refinePattern } from './refine.mjs';

export type Region =
  | { kind: 'domain'; ids?: readonly string[] }
  | { kind: 'boundary'; ids: readonly string[] }
  | LineDataset | EdgeDataset | CutPointsDataset;

export interface EvalOptions extends ExprOptions {
  mesh?: Mesh;
  /** 2 pi r weight (default: true on axisymmetric meshes; an error on other meshes) */
  revolve?: boolean;
  /** polynomial degree of the domain / boundary quadrature (default 5 on P2 cells, 3 otherwise) */
  degree?: number;
}

export interface EvalResult {
  value: number;
  /** SI unit */
  unit: string;
  dim: number[];
  method: string;
  /** number of evaluation points used */
  n: number;
  /** false when the expression jumps across elements (d(), DG0) */
  continuous: boolean;
  /** location of the max / min */
  at?: number[];
  /** region measure for integrals and averages */
  measure?: { value: number; unit: string };
  /** quadrature or sample points outside the mesh (skipped) */
  nOutside?: number;
  /** points inside the mesh where the expression is NaN (skipped by max / min; they make an integral NaN) */
  nNaN?: number;
  /** cut lines: the length inside the mesh and the full length (the integral covers the inside part only) */
  coverage?: { covered: number; length: number };
}

const mPow = (k: number): Dim => [k, 0, 0, 0, 0];

function regionMesh(sol: Solution | null, region: Region, o: { mesh?: Mesh }): Mesh {
  if (region.kind === 'domain' || region.kind === 'boundary') {
    if (sol) return meshOf(sol, o.mesh);
    if (!o.mesh) throw new Error('a mesh is needed');
    return o.mesh;
  }
  if (sol && region.mesh.hash !== sol.meshHash) throw new Error(`the ${region.kind} dataset is on mesh ${region.mesh.hash.slice(0, 12)}, the solution on ${sol.meshHash.slice(0, 12)} (a dataset is evaluated on its own mesh only)`);
  return region.mesh;
}

function quadOf(mesh: Mesh, region: Region, o: EvalOptions): QuadSet {
  switch (region.kind) {
    case 'domain': return domainQuad(mesh, region.ids, o.degree !== undefined ? { degree: o.degree } : {});
    case 'boundary': return boundaryQuad(mesh, region.ids, o.degree !== undefined ? { degree: o.degree } : {});
    case 'line': case 'edge': return region.quad;
    case 'points': throw new Error('integrals, averages and measures need a domain, boundary, edge or cut line (not cut points)');
  }
}

function revolveOf(mesh: Mesh, o: EvalOptions): boolean {
  if (o.revolve && !mesh.axisym) throw new Error('revolve (2 pi r weight) needs an axisymmetric mesh');
  return o.revolve ?? !!mesh.axisym;
}

/** Weights with the 2 pi r factor applied where revolving. */
function weights(q: QuadSet, revolve: boolean): Float64Array {
  if (!revolve) return q.w;
  const dim = q.points.mesh.dim, w = new Float64Array(q.w.length);
  for (let i = 0; i < w.length; i++) w[i] = q.w[i]! * 2 * Math.PI * q.points.x[dim * i]!;
  return w;
}

/** Measure of a region: length, area or volume (with 2 pi r on axisymmetric meshes: surface or volume of revolution). */
export function evalMeasure(mesh: Mesh, region: Region, o: EvalOptions = {}): { value: number; unit: string; dim: number[]; rdim: number; revolved: boolean; n: number } {
  const m = regionMesh(null, region, { mesh });
  const q = quadOf(m, region, o), rev = revolveOf(m, o), w = weights(q, rev);
  let s = 0, n = 0;
  for (let i = 0; i < w.length; i++) if (q.points.cell[i]! >= 0) { s += w[i]!; n++; }
  const d = mPow(q.rdim + (rev ? 1 : 0));
  return { value: s, unit: formatUnit(d), dim: [...d], rdim: q.rdim, revolved: rev, n };
}

/** Integral of an expression over a region (Gauss quadrature; Gauss 3 per element piece on cut lines). */
export function evalIntegral(sol: Solution, expr: string, region: Region, o: EvalOptions = {}): EvalResult {
  return integral(sol, expr, region, o).r;
}

function integral(sol: Solution, expr: string, region: Region, o: EvalOptions): { r: EvalResult; c: FieldExpr } {
  const mesh = regionMesh(sol, region, o);
  const c = compileFieldExpr(sol, expr, { ...o, mesh });
  const q = quadOf(mesh, region, o), rev = revolveOf(mesh, o), w = weights(q, rev);
  const v = c.evaluate(q.points);
  let s = 0, meas = 0, out = 0, nan = 0;
  for (let i = 0; i < w.length; i++) {
    if (q.points.cell[i]! < 0) { out++; continue; }
    if (Number.isNaN(v[i]!)) nan++;
    s += v[i]! * w[i]!; meas += w[i]!;
  }
  const md = mPow(q.rdim + (rev ? 1 : 0)), d = dimMul(c.dim, md);
  const rule = region.kind === 'line' ? 'gauss3_per_element_piece' : `quad_degree_${o.degree ?? (mesh.cells.type === 'tri6' || mesh.cells.type === 'tet10' ? 5 : 3)}`;
  return {
    c,
    r: {
      value: s, unit: formatUnit(d), dim: d, method: `${rule}${rev ? '_2pi_r' : ''}`,
      n: w.length - out, continuous: c.continuous, measure: { value: meas, unit: formatUnit(md) }, ...(out ? { nOutside: out } : {}), ...(nan ? { nNaN: nan } : {}),
      ...(region.kind === 'line' ? { coverage: { covered: region.covered, length: region.length } } : {}),
    },
  };
}

/** Average = integral / measure (same weights). */
export function evalAverage(sol: Solution, expr: string, region: Region, o: EvalOptions = {}): EvalResult {
  const { r, c } = integral(sol, expr, region, o);
  return { ...r, value: r.value / r.measure!.value, unit: c.unit, dim: c.dim, method: `average_${r.method}` };
}

export type ExtremeMethod = 'nodal' | 'lattice' | 'quad' | 'points';

/** Points at which max / min are taken, for a region and method. */
function extremePoints(mesh: Mesh, region: Region, method: ExtremeMethod, o: EvalOptions & { resolution?: number }): PointSet {
  if (method === 'quad') return quadOf(mesh, region, o).points;
  if (region.kind === 'line' || region.kind === 'edge' || region.kind === 'points') {
    if (method !== 'points') throw new Error(`max / min over a ${region.kind} dataset: method 'points' or 'quad' (not '${method}')`);
    return region.points;
  }
  if (method === 'points') throw new Error(`method 'points' needs a cut line, edge or cut points dataset`);
  const type = mesh.cells.type, k = NPC[type], dim = mesh.dim, X = mesh.nodes, C = mesh.cells.conn;
  if (region.kind === 'domain') {
    const mask = cellsOfDomains(mesh, region.ids);
    let ref0: readonly number[];
    let np: number;
    if (method === 'lattice') {
      if (type !== 'tri3' && type !== 'tri6') throw new Error(`method 'lattice' is for triangle meshes (have ${type})`);
      const pat = refinePattern(o.resolution ?? 3);
      const r: number[] = [];
      for (let i = 0; i < pat.np; i++) r.push(pat.L[3 * i + 1]!, pat.L[3 * i + 2]!);
      ref0 = r; np = pat.np;
    } else {
      const nr = NODE_REF[type];
      if (!nr) throw new Error(`method 'nodal' not available for ${type}`);
      ref0 = nr; np = k;
    }
    const rd = ref0.length / np;
    let nc = 0; for (const m of mask) nc += m;
    const n = nc * np, x = new Float64Array(dim * n), cell = new Int32Array(n), ref = new Float64Array(3 * n);
    const xp = new Float64Array(dim);
    let i = 0;
    for (let c = 0; c < mask.length; c++) {
      if (!mask[c]) continue;
      for (let a = 0; a < np; a++, i++) {
        cell[i] = c;
        for (let s = 0; s < rd; s++) ref[3 * i + s] = ref0[rd * a + s]!;
        if (method === 'nodal') for (let q = 0; q < dim; q++) x[dim * i + q] = X[dim * C[k * c + a]! + q]!;
        else { mapToPhysical(mesh, c, ref.subarray(3 * i, 3 * i + 3), xp); for (let q = 0; q < dim; q++) x[dim * i + q] = xp[q]!; }
      }
    }
    return { mesh, n, x, cell, ref };
  }
  // boundary: facet nodes in the adjacent cell
  if (method !== 'nodal') throw new Error(`max / min over a boundary: method 'nodal' or 'quad' (not '${method}')`);
  const fs = facetsOfBoundaries(mesh, region.ids), kf = NPC[mesh.facets.type], L = locatorFor(mesh);
  const n = fs.length * kf, x = new Float64Array(dim * n), cell = new Int32Array(n).fill(-1), ref = new Float64Array(3 * n);
  const p = new Float64Array(dim), r = new Float64Array(3);
  let i = 0;
  for (const f of fs) {
    const c = facetCell(mesh, f);
    for (let a = 0; a < kf; a++, i++) {
      const nd = mesh.facets.conn[kf * f + a]!;
      for (let q = 0; q < dim; q++) { p[q] = X[dim * nd + q]!; x[dim * i + q] = p[q]!; }
      if (L.inCell(c, p, r, 1e-7)) { cell[i] = c; ref.set(r, 3 * i); }
    }
  }
  return { mesh, n, x, cell, ref };
}

function extreme(sol: Solution, expr: string, region: Region, o: EvalOptions & { method?: ExtremeMethod; resolution?: number }, max: boolean): EvalResult {
  const mesh = regionMesh(sol, region, o);
  const method: ExtremeMethod = o.method ?? (region.kind === 'domain' || region.kind === 'boundary' ? 'nodal' : 'points');
  const c = compileFieldExpr(sol, expr, { ...o, mesh });
  const ps = extremePoints(mesh, region, method, o);
  const v = c.evaluate(ps);
  let best = max ? -Infinity : Infinity, arg = -1, out = 0, nan = 0;
  for (let i = 0; i < ps.n; i++) {
    if (ps.cell[i]! < 0) { out++; continue; }
    if (Number.isNaN(v[i]!)) { nan++; continue; }
    if (max ? v[i]! > best : v[i]! < best) { best = v[i]!; arg = i; }
  }
  const dim = mesh.dim;
  return {
    value: arg >= 0 ? best : NaN, unit: c.unit, dim: c.dim, method: method === 'lattice' ? `lattice_r${o.resolution ?? 3}` : method, n: ps.n - out - nan, continuous: c.continuous,
    ...(arg >= 0 ? { at: Array.from(ps.x.subarray(dim * arg, dim * arg + dim)) } : {}), ...(out ? { nOutside: out } : {}), ...(nan ? { nNaN: nan } : {}),
  };
}

export function evalMax(sol: Solution, expr: string, region: Region, o: EvalOptions & { method?: ExtremeMethod; resolution?: number } = {}): EvalResult { return extreme(sol, expr, region, o, true); }
export function evalMin(sol: Solution, expr: string, region: Region, o: EvalOptions & { method?: ExtremeMethod; resolution?: number } = {}): EvalResult { return extreme(sol, expr, region, o, false); }

/** Values of an expression at the points of a dataset (cut points, cut line, edge: its `points`), a point set, or
 *  coordinates. NaN outside the mesh. */
export function evalPoint(sol: Solution, expr: string, at: CutPointsDataset | LineDataset | EdgeDataset | PointSet | ArrayLike<number> | readonly (readonly number[])[], o: EvalOptions & { snap?: number } = {}): { values: Float64Array; unit: string; dim: number[]; continuous: boolean; outside: number[] } {
  const mesh = meshOf(sol, o.mesh);
  const isDataset = (x: unknown): x is CutPointsDataset | LineDataset | EdgeDataset => !!x && typeof x === 'object' && 'kind' in x && 'points' in x && isPointSet((x as { points: unknown }).points);
  const ps = isPointSet(at) ? at : isDataset(at) ? at.points : locatePoints(mesh, at as ArrayLike<number>, o.snap ? { snap: o.snap } : {});
  if (ps.mesh.hash !== sol.meshHash) throw new Error('evalPoint: the points are located on another mesh than the solution');
  const c = compileFieldExpr(sol, expr, { ...o, mesh });
  const values = c.evaluate(ps), outside: number[] = [];
  for (let i = 0; i < ps.n; i++) if (ps.cell[i]! < 0) outside.push(i);
  return { values, unit: c.unit, dim: c.dim, continuous: c.continuous, outside };
}

/**
 * Global evaluation: an expression of params, `pi` and solution scalars (`<physicsId>.<scalar>` or `<scalar>`) only;
 * a field, coordinate or d() reference is an error. `sol` may be null (params only).
 */
export function evalGlobal(sol: Solution | null, expr: string, o: Pick<ExprOptions, 'params' | 'physicsId'> = {}): { value: number; unit: string; dim: number[] } {
  const scalars = sol?.scalars ?? {};
  const pv = (name: string) => paramLookup(o.params, name);
  const c = compileExpression(expr, {
    resolve: (name: string) => {
      const segs = name.split('.');
      for (const k of [name, ...(segs.length > 1 && (!o.physicsId || segs[0] === o.physicsId) ? [segs.slice(1).join('.')] : [])]) {
        if (Object.hasOwn(scalars, k)) { const s = scalars[k]!, u = parseUnit(s.unit || '1'); return { kind: 'const', re: s.value * u.factor, dim: u.dim, global: true }; }
      }
      const p = pv(name);
      return p ? { kind: 'const', re: p.si, dim: p.dim, global: true } : null;
    },
    describe: () => ` (global evaluations take params and solution scalars: ${Object.keys(scalars).join(', ') || 'none'})`,
  });
  if (!c.constant) throw new Error(`global expression "${expr}" is not constant`);
  if (c.constant.im !== 0) throw new Error(`global expression "${expr}" is complex`);
  return { value: c.constant.re, unit: c.unit, dim: c.dim };
}

