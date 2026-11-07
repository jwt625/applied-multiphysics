// SPDX-License-Identifier: GPL-3.0-or-later
// Point sets for the results kernels (DevLog-026): physical coordinates with the cell that holds each point and its
// reference coordinates, so field values and gradients are interpolated from that cell's own basis (no second point
// location). Points outside every cell have cell -1 and evaluate to NaN. Only IEEE + - * / and Math.sqrt are used
// (bit-identical in every JS engine; DevLog-026 s.1.1).

import type { FieldData, Mesh } from '@amp/spec/types';
import { NPC, nCells } from '@amp/physics/common/mesh';
import { REF_DIM, shape } from '@amp/physics/common/lagrange';
import { locatorFor } from './evaluate.ts';

export interface PointSet {
  /** the mesh the cells refer to */
  mesh: Mesh;
  n: number;
  /** dim coordinates per point (SI metres) */
  x: Float64Array;
  /** cell index per point, -1 outside the mesh */
  cell: Int32Array;
  /** reference coordinates, 3 per point (unused trailing entries 0) */
  ref: Float64Array;
  /** unit normal per point (dim per point), where the set lies on a boundary or edge */
  normal?: Float64Array;
  /** unit tangent per point (dim per point), where the set lies on a line or a 2D edge */
  tangent?: Float64Array;
}

/** Flatten [[x, y(, z)], ...] or a flat array into dim coordinates per point. */
export function flatPoints(points: ArrayLike<number> | readonly (readonly number[])[], dim: number): Float64Array {
  const flat = Array.isArray(points) && Array.isArray(points[0]) ? Float64Array.from((points as number[][]).flat()) : Float64Array.from(points as ArrayLike<number>);
  if (flat.length % dim) throw new Error(`points: ${flat.length} coordinates is not a multiple of dim ${dim}`);
  return flat;
}

/** Locate points (bucket grid + Newton inverse map, `Locator`); `snap` as for `sample` (reference-coordinate tolerance). */
export function locatePoints(mesh: Mesh, points: ArrayLike<number> | readonly (readonly number[])[], o: { snap?: number } = {}): PointSet {
  const dim = mesh.dim, x = flatPoints(points, dim), n = x.length / dim;
  const L = locatorFor(mesh), cell = new Int32Array(n).fill(-1), ref = new Float64Array(3 * n);
  const p = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < dim; d++) p[d] = x[dim * i + d]!;
    const loc = L.locate(p, o.snap ?? 0);
    if (!loc) continue;
    cell[i] = loc.cell;
    for (let d = 0; d < 3; d++) ref[3 * i + d] = loc.ref[d] ?? 0;
  }
  return { mesh, n, x, cell, ref };
}

/** Physical point of reference coordinates `ref` in cell c (isoparametric map). */
export function mapToPhysical(mesh: Mesh, c: number, ref: ArrayLike<number>, out: Float64Array): void {
  const k = NPC[mesh.cells.type], rd = REF_DIM[mesh.cells.type]!, dim = mesh.dim;
  const N = new Float64Array(k), dN = new Float64Array(k * rd);
  shape(mesh.cells.type, ref, N, dN);
  for (let d = 0; d < dim; d++) out[d] = 0;
  for (let a = 0; a < k; a++) { const nd = mesh.cells.conn[k * c + a]!; for (let d = 0; d < dim; d++) out[d]! += N[a]! * mesh.nodes[dim * nd + d]!; }
}

/** Reference coordinates of the nodes of each cell type (VTK order, as @amp/physics/common/mesh). */
export const NODE_REF: Partial<Record<string, readonly number[]>> = {
  tri3: [0, 0, 1, 0, 0, 1],
  tri6: [0, 0, 1, 0, 0, 1, 0.5, 0, 0.5, 0.5, 0, 0.5],
  quad4: [0, 0, 1, 0, 1, 1, 0, 1],
  tet4: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  tet10: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0, 0, 0, 0.5, 0.5, 0, 0.5, 0, 0.5, 0.5],
  hex8: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
};

function checkField(mesh: Mesh, f: FieldData): void {
  const nc = f.components, nn = mesh.nodes.length / mesh.dim;
  if (f.space === 'H1P1' || f.space === 'H1P2') { if (f.data.length !== nn * nc) throw new Error(`field '${f.name}' has ${f.data.length} values, mesh has ${nn} nodes x ${nc} components`); return; }
  if (f.space === 'DG0') { if (f.data.length !== nCells(mesh) * nc) throw new Error(`DG0 field '${f.name}' length mismatch`); return; }
  throw new Error(`field '${f.name}': space ${f.space} not supported (Nedelec coefficients: use the module's H1 projection, e.g. emw 'E_nodal', or a DG0 field)`);
}

/**
 * Values (point-major, components per point) and optionally gradients ((point * components + j) * dim + d) of a field
 * at a point set, from each point's own cell. NaN outside. Gradients of a DG0 field are an error (not differentiable).
 */
export function interpolate(f: FieldData, ps: PointSet, o: { grad?: boolean } = {}): { values: Float64Array; grad?: Float64Array } {
  const mesh = ps.mesh, dim = mesh.dim, nc = f.components, np = ps.n;
  checkField(mesh, f);
  if (o.grad && f.space === 'DG0') throw new Error(`d(): field '${f.name}' is DG0 (piecewise constant); its derivative is not defined`);
  const values = new Float64Array(np * nc).fill(NaN);
  const grad = o.grad ? new Float64Array(np * nc * dim).fill(NaN) : undefined;
  const type = mesh.cells.type, k = NPC[type], rd = REF_DIM[type]!, conn = mesh.cells.conn, X = mesh.nodes;
  const N = new Float64Array(k), dN = new Float64Array(k * rd), r = new Float64Array(3);
  const J = new Float64Array(9), gr = new Float64Array(3);
  for (let i = 0; i < np; i++) {
    const c = ps.cell[i]!;
    if (c < 0) continue;
    if (f.space === 'DG0') { for (let j = 0; j < nc; j++) values[i * nc + j] = f.data[c * nc + j]!; continue; }
    r[0] = ps.ref[3 * i]!; r[1] = ps.ref[3 * i + 1]!; r[2] = ps.ref[3 * i + 2]!;
    shape(type, r, N, dN);
    for (let j = 0; j < nc; j++) {
      let s = 0;
      for (let a = 0; a < k; a++) s += N[a]! * f.data[conn[k * c + a]! * nc + j]!;
      values[i * nc + j] = s;
    }
    if (!grad) continue;
    J.fill(0);
    for (let a = 0; a < k; a++) { const nd = conn[k * c + a]!; for (let p = 0; p < dim; p++) for (let s = 0; s < rd; s++) J[3 * p + s]! += X[dim * nd + p]! * dN[rd * a + s]!; }
    for (let j = 0; j < nc; j++) {
      gr.fill(0);
      for (let a = 0; a < k; a++) { const v = f.data[conn[k * c + a]! * nc + j]!; for (let s = 0; s < rd; s++) gr[s]! += v * dN[rd * a + s]!; }
      // physical gradient g solves J^T g = gr
      solveT(J, gr, dim, grad, (i * nc + j) * dim);
    }
  }
  return grad ? { values, grad } : { values };
}

/** Solve J^T g = b (J row-major 3x3 storage, dim 2 or 3) into out[o..o+dim). */
function solveT(J: Float64Array, b: Float64Array, dim: number, out: Float64Array, o: number): void {
  if (dim === 2) {
    // J^T = [[J00, J10], [J01, J11]]
    const a = J[0]!, bb = J[3]!, c = J[1]!, d = J[4]!, det = a * d - bb * c;
    out[o] = (d * b[0]! - bb * b[1]!) / det;
    out[o + 1] = (-c * b[0]! + a * b[1]!) / det;
    return;
  }
  const a = J[0]!, bb = J[3]!, c = J[6]!, d = J[1]!, e = J[4]!, f = J[7]!, g = J[2]!, h = J[5]!, k = J[8]!;
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
  const det = a * A + bb * B + c * C;
  const r0 = b[0]!, r1 = b[1]!, r2 = b[2]!;
  out[o] = (r0 * A - bb * (r1 * k - f * r2) + c * (r1 * h - e * r2)) / det;
  out[o + 1] = (a * (r1 * k - f * r2) - r0 * (d * k - f * g) + c * (d * r2 - r1 * g)) / det;
  out[o + 2] = (a * (e * r2 - r1 * h) - bb * (d * r2 - r1 * g) + r0 * (d * h - e * g)) / det;
}
