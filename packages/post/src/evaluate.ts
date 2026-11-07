// SPDX-License-Identifier: GPL-3.0-or-later
// Field evaluation at arbitrary points on C2 meshes: point location (bucket grid over cell bounding boxes, then the
// inverse isoparametric map by Newton, exact in one step on affine cells) and interpolation of H1 (nodal, P1/P2/Q1)
// and DG0 (per cell) fields, with values and gradients. Points outside every cell give NaN.

import type { FieldData, Mesh } from '@amp/spec/types';
import { NPC, nCells } from '@amp/physics/common/mesh';
import { REF_DIM, shape } from '@amp/physics/common/lagrange';

export interface Located { cell: number; ref: Float64Array }

const SIMPLEX = new Set(['tri3', 'tri6', 'tet4', 'tet10']);

export class Locator {
  readonly mesh: Mesh;
  private k: number;
  private dim: number;
  private lo: Float64Array; private hi: Float64Array;
  private g0: number[]; private gs: number[]; private gn: number[];
  private bucketCells: Int32Array; private bucketPtr: Int32Array;
  /** padded bounding box per cell: dim lows then dim highs (2 * dim per cell) */
  readonly boxes: Float64Array;
  tol = 1e-10;
  constructor(mesh: Mesh) {
    this.mesh = mesh;
    const dim = (this.dim = mesh.dim);
    const k = (this.k = NPC[mesh.cells.type]);
    const nc = nCells(mesh);
    const boxes = (this.boxes = new Float64Array(2 * dim * nc));
    this.lo = new Float64Array(dim).fill(Infinity); this.hi = new Float64Array(dim).fill(-Infinity);
    for (let c = 0; c < nc; c++) for (let d = 0; d < dim; d++) {
      let a = Infinity, b = -Infinity;
      for (let i = 0; i < k; i++) { const v = mesh.nodes[dim * mesh.cells.conn[k * c + i]! + d]!; if (v < a) a = v; if (v > b) b = v; }
      // curved P2 cells bulge at most a little beyond their node hull: pad by 5 % of the extent
      const pad = 0.05 * (b - a);
      boxes[2 * dim * c + d] = a - pad; boxes[2 * dim * c + dim + d] = b + pad;
      if (a < this.lo[d]!) this.lo[d] = a; if (b > this.hi[d]!) this.hi[d] = b;
    }
    // buckets per axis: the integer nearest to (nc / 2)^(1 / dim), by integer search (no Math.pow: same grid, hence
    // the same cell for points on shared edges, in every JS engine; DevLog-026 gate 7)
    const target = nc / 2, powi = (b: number) => (dim === 3 ? b * b * b : b * b);
    let fl = 0; while (powi(fl + 1) <= target) fl++;
    const per = Math.max(1, powi(fl + 0.5) <= target ? fl + 1 : fl);
    this.g0 = Array.from(this.lo); this.gn = Array(dim).fill(per);
    this.gs = this.gn.map((n, d) => Math.max((this.hi[d]! - this.lo[d]!) / n, 1e-300));
    const nb = this.gn.reduce((a, b) => a * b, 1);
    // count, then fill (CSR buckets)
    const cnt = new Int32Array(nb + 1);
    const span = (c: number, f: (b: number) => void) => {
      const i0 = [0, 0, 0], i1 = [0, 0, 0];
      for (let d = 0; d < dim; d++) {
        i0[d] = Math.max(0, Math.min(this.gn[d]! - 1, Math.floor((boxes[2 * dim * c + d]! - this.g0[d]!) / this.gs[d]!)));
        i1[d] = Math.max(0, Math.min(this.gn[d]! - 1, Math.floor((boxes[2 * dim * c + dim + d]! - this.g0[d]!) / this.gs[d]!)));
      }
      for (let z = i0[2]!; z <= (dim === 3 ? i1[2]! : 0); z++) for (let y = i0[1]!; y <= i1[1]!; y++) for (let x = i0[0]!; x <= i1[0]!; x++)
        f((z * this.gn[1]! + y) * this.gn[0]! + x);
    };
    for (let c = 0; c < nc; c++) span(c, (b) => { cnt[b + 1]!++; });
    for (let b = 0; b < nb; b++) cnt[b + 1]! += cnt[b]!;
    this.bucketPtr = cnt.slice();
    const fill = cnt.slice();
    this.bucketCells = new Int32Array(cnt[nb]!);
    for (let c = 0; c < nc; c++) span(c, (b) => { this.bucketCells[fill[b]!++] = c; });
  }

  /** Reference coordinates of p in cell c (Newton), or null if p is outside c. */
  inCell(c: number, p: ArrayLike<number>, out: Float64Array, tol = this.tol): boolean {
    const m = this.mesh, dim = this.dim, k = this.k, type = m.cells.type;
    const rd = REF_DIM[type]!;
    const N = new Float64Array(k), dN = new Float64Array(k * rd);
    // start at the reference centroid
    const simplex = SIMPLEX.has(type);
    for (let d = 0; d < rd; d++) out[d] = simplex ? 1 / (rd + 1) : 0.5;
    for (let it = 0; it < 30; it++) {
      shape(type, out, N, dN);
      const x = [0, 0, 0], J = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let a = 0; a < k; a++) {
        const n = m.cells.conn[k * c + a]!;
        for (let r = 0; r < dim; r++) {
          const X = m.nodes[dim * n + r]!;
          x[r]! += N[a]! * X;
          for (let s = 0; s < rd; s++) J[3 * r + s]! += X * dN[rd * a + s]!;
        }
      }
      const res = [p[0]! - x[0]!, p[1]! - x[1]!, dim === 3 ? p[2]! - x[2]! : 0];
      const dx = solve(J, res, dim);
      let step = 0;
      for (let d = 0; d < rd; d++) { out[d]! += dx[d]!; step = Math.max(step, Math.abs(dx[d]!)); }
      if (step < 1e-13) break;
      if (!Number.isFinite(step) || step > 10) return false;
    }
    const t = tol;
    if (simplex) {
      let s = 0;
      for (let d = 0; d < rd; d++) { if (out[d]! < -t) return false; s += out[d]!; }
      return s <= 1 + t;
    }
    for (let d = 0; d < rd; d++) if (out[d]! < -t || out[d]! > 1 + t) return false;
    return true;
  }

  /** `snap` (reference-coordinate tolerance, e.g. 1e-3): also accept points just outside the isoparametric cells, as
   *  for probes on curved walls (audit M5); the reference point is used as found (the map extrapolates slightly). */
  locate(p: ArrayLike<number>, snap = 0): Located | null {
    const dim = this.dim, idx = [0, 0, 0];
    for (let d = 0; d < dim; d++) {
      const v = p[d]!;
      if (v < this.lo[d]! - 1e-9 * (this.hi[d]! - this.lo[d]!) || v > this.hi[d]! + 1e-9 * (this.hi[d]! - this.lo[d]!)) return null;
      idx[d] = Math.max(0, Math.min(this.gn[d]! - 1, Math.floor((v - this.g0[d]!) / this.gs[d]!)));
    }
    const b = ((dim === 3 ? idx[2]! : 0) * this.gn[1]! + idx[1]!) * this.gn[0]! + idx[0]!;
    const ref = new Float64Array(3);
    for (let q = this.bucketPtr[b]!; q < this.bucketPtr[b + 1]!; q++) {
      const c = this.bucketCells[q]!;
      let inside = true;
      for (let d = 0; d < dim; d++) if (p[d]! < this.boxes[2 * dim * c + d]! || p[d]! > this.boxes[2 * dim * c + dim + d]!) { inside = false; break; }
      if (inside && this.inCell(c, p, ref)) return { cell: c, ref: ref.slice() };
    }
    if (snap > 0) for (let q = this.bucketPtr[b]!; q < this.bucketPtr[b + 1]!; q++) {
      const c = this.bucketCells[q]!;
      if (this.inCell(c, p, ref, snap)) return { cell: c, ref: ref.slice() };
    }
    return null;
  }
}

function solve(J: number[], r: number[], dim: number): number[] {
  if (dim === 2) {
    const a = J[0]!, b = J[1]!, c = J[3]!, d = J[4]!, det = a * d - b * c;
    return [(d * r[0]! - b * r[1]!) / det, (-c * r[0]! + a * r[1]!) / det];
  }
  const [a, b, c, d, e, f, g, h, k] = J as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  const x = (r[0]! * (e * k - f * h) - b * (r[1]! * k - f * r[2]!) + c * (r[1]! * h - e * r[2]!)) / det;
  const y = (a * (r[1]! * k - f * r[2]!) - r[0]! * (d * k - f * g) + c * (d * r[2]! - r[1]! * g)) / det;
  const z = (a * (e * r[2]! - r[1]! * h) - b * (d * r[2]! - r[1]! * g) + r[0]! * (d * h - e * g)) / det;
  return [x, y, z];
}

const locators = new WeakMap<Mesh, Locator>();
export function locatorFor(mesh: Mesh): Locator {
  let L = locators.get(mesh);
  if (!L) { L = new Locator(mesh); locators.set(mesh, L); }
  return L;
}

/**
 * Values of a field at points (dim coordinates per point, flattened). Returns components x nPoints values
 * (point-major: value of component j at point i is out[i * components + j]); NaN outside the mesh.
 * `grad`: also return the gradient (components x dim per point) for H1 fields.
 */
export function evaluateField(mesh: Mesh, field: FieldData, points: ArrayLike<number>, o: { grad?: boolean; snap?: number } = {}): { values: Float64Array; grad?: Float64Array } {
  const dim = mesh.dim, np = points.length / dim, nc = field.components;
  const L = locatorFor(mesh);
  const values = new Float64Array(np * nc).fill(NaN);
  const grad = o.grad ? new Float64Array(np * nc * dim).fill(NaN) : undefined;
  const k = NPC[mesh.cells.type], rd = REF_DIM[mesh.cells.type]!;
  const N = new Float64Array(k), dN = new Float64Array(k * rd);
  const p = new Float64Array(dim);
  const nNodes = mesh.nodes.length / dim;
  const isH1 = field.space === 'H1P1' || field.space === 'H1P2';
  if (isH1 && field.data.length !== nNodes * nc) throw new Error(`evaluateField: '${field.name}' has ${field.data.length} values, mesh has ${nNodes} nodes x ${nc} components`);
  if (field.space === 'DG0' && field.data.length !== nCells(mesh) * nc) throw new Error(`evaluateField: DG0 '${field.name}' length mismatch`);
  if (!isH1 && field.space !== 'DG0') throw new Error(`evaluateField: space ${field.space} not supported (Nedelec coefficients: evaluate the module's H1 projection, e.g. emw 'E_nodal', or a DG0 field)`);
  for (let i = 0; i < np; i++) {
    for (let d = 0; d < dim; d++) p[d] = points[dim * i + d]!;
    const loc = L.locate(p, o.snap ?? 0);
    if (!loc) continue;
    if (field.space === 'DG0') { for (let j = 0; j < nc; j++) values[i * nc + j] = field.data[loc.cell * nc + j]!; continue; }
    shape(mesh.cells.type, loc.ref, N, dN);
    for (let j = 0; j < nc; j++) {
      let s = 0;
      for (let a = 0; a < k; a++) s += N[a]! * field.data[mesh.cells.conn[k * loc.cell + a]! * nc + j]!;
      values[i * nc + j] = s;
    }
    if (grad) {
      // J and J^-T
      const J = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let a = 0; a < k; a++) { const n = mesh.cells.conn[k * loc.cell + a]!; for (let r = 0; r < dim; r++) for (let s = 0; s < rd; s++) J[3 * r + s]! += mesh.nodes[dim * n + r]! * dN[rd * a + s]!; }
      for (let j = 0; j < nc; j++) {
        const gr = [0, 0, 0];
        for (let a = 0; a < k; a++) { const v = field.data[mesh.cells.conn[k * loc.cell + a]! * nc + j]!; for (let s = 0; s < rd; s++) gr[s]! += v * dN[rd * a + s]!; }
        // grad_x = J^-T grad_ref: solve J^T g = gr
        const JT = [J[0]!, J[3]!, J[6]!, J[1]!, J[4]!, J[7]!, J[2]!, J[5]!, J[8]!];
        const g = solve(JT, gr, dim);
        for (let d = 0; d < dim; d++) grad[(i * nc + j) * dim + d] = g[d]!;
      }
    }
  }
  return grad ? { values, grad } : { values };
}
