// SPDX-License-Identifier: GPL-3.0-or-later
// Point sets for the results kernels (DevLog-026): physical coordinates with the cell that holds each point and its
// reference coordinates, so field values and gradients are interpolated from that cell's own basis (no second point
// location). Points outside every cell have cell -1 and evaluate to NaN. Only IEEE + - * / and Math.sqrt are used
// (bit-identical in every JS engine; DevLog-026 s.1.1).

import type { CellType, FieldData, Mesh } from '@amp/spec/types';
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

/** Corner-only cell type of each cell type (the linear element on the same reference cell). */
const CORNER_TYPE: Partial<Record<string, CellType>> = { tri3: 'tri3', tri6: 'tri3', quad4: 'quad4', tet4: 'tet4', tet10: 'tet4', hex8: 'hex8' };
/** Reference centroid and reference measure of each corner type. */
const REF_CENTRE: Partial<Record<string, [number[], number]>> = {
  tri3: [[1 / 3, 1 / 3, 0], 1 / 2], quad4: [[0.5, 0.5, 0], 1], tet4: [[0.25, 0.25, 0.25], 1 / 6], hex8: [[0.5, 0.5, 0.5], 1],
};
const recovered = new WeakMap<FieldData, { mesh: Mesh; corners: Float64Array }>();

/**
 * Recovery of a DG0 (per cell) field to cell-corner values, the rule of the 2D view (apps/web field2d `recoverDG0`,
 * DevLog-019 s.1.2): at each corner node, the measure-weighted mean of the values of the cells that share the node
 * within the same domain (cells.domain), so a node on a material interface keeps one value per domain and jumps across
 * interfaces stay sharp. Cell measure from the straight corners (|det J| at the reference centroid; exact for
 * simplices and parallelograms); planar measure also on axisymmetric meshes (as the view). Non-finite cell values are
 * left out. Bounded by the cell values (a convex combination). Returns nCorner * nc values per cell: index
 * (cell * nCorner + corner) * nc + component, corners in VTK order (the first nCorner nodes of the cell).
 * Cached per (field, mesh).
 */
export function recoverDG0(mesh: Mesh, f: FieldData): Float64Array {
  if (f.space !== 'DG0') throw new Error(`recoverDG0: field '${f.name}' is ${f.space}, not DG0`);
  checkField(mesh, f);
  const hit = recovered.get(f);
  if (hit && hit.mesh === mesh) return hit.corners;
  const type = mesh.cells.type, ct = CORNER_TYPE[type];
  if (!ct) throw new Error(`recoverDG0: cell type ${type} not supported`);
  const k = NPC[type], nk = NPC[ct], rd = REF_DIM[ct]!, dim = mesh.dim, nc = f.components, conn = mesh.cells.conn, X = mesh.nodes;
  const nC = nCells(mesh), dom = mesh.cells.domain;
  // slot per (corner node, domain): a node's first domain uses the node index, other domains get extra slots
  const nN = X.length / dim;
  const first = new Int32Array(nN).fill(-1);
  const extra = new Map<string, number>();
  let next = nN;
  const slot = new Int32Array(nk * nC);
  for (let c = 0; c < nC; c++) {
    const g = dom[c]!;
    for (let a = 0; a < nk; a++) {
      const v = conn[k * c + a]!;
      let s = v;
      if (first[v]! < 0) first[v] = g;
      else if (first[v] !== g) {
        const key = `${v}|${g}`;
        let e = extra.get(key);
        if (e === undefined) { e = next++; extra.set(key, e); }
        s = e;
      }
      slot[nk * c + a] = s;
    }
  }
  const [rc, rm] = REF_CENTRE[ct]!;
  const N = new Float64Array(nk), dN = new Float64Array(nk * rd), J = new Float64Array(9);
  shape(ct, rc, N, dN);
  const sum = new Float64Array(next * nc), w = new Float64Array(next);
  for (let c = 0; c < nC; c++) {
    let ok = true;
    for (let j = 0; j < nc; j++) if (!Number.isFinite(f.data[c * nc + j]!)) ok = false;
    if (!ok) continue;
    J.fill(0);
    for (let a = 0; a < nk; a++) { const nd = conn[k * c + a]!; for (let p = 0; p < dim; p++) for (let q = 0; q < rd; q++) J[3 * p + q]! += X[dim * nd + p]! * dN[rd * a + q]!; }
    const det = rd === 2 ? J[0]! * J[4]! - J[1]! * J[3]! : J[0]! * (J[4]! * J[8]! - J[5]! * J[7]!) - J[1]! * (J[3]! * J[8]! - J[5]! * J[6]!) + J[2]! * (J[3]! * J[7]! - J[4]! * J[6]!);
    const A = Math.abs(det) * rm;
    for (let a = 0; a < nk; a++) {
      const s = slot[nk * c + a]!;
      for (let j = 0; j < nc; j++) sum[nc * s + j]! += A * f.data[c * nc + j]!;
      w[s]! += A;
    }
  }
  const corners = new Float64Array(nk * nc * nC);
  for (let c = 0; c < nC; c++)
    for (let a = 0; a < nk; a++) {
      const s = slot[nk * c + a]!;
      for (let j = 0; j < nc; j++) corners[(nk * c + a) * nc + j] = w[s]! > 0 ? sum[nc * s + j]! / w[s]! : NaN;
    }
  recovered.set(f, { mesh, corners });
  return corners;
}

/**
 * How a derived field (an H1 field whose producer averaged element values at the nodes and also gives them per cell:
 * `elementNodal`) is read:
 *   recovered  per-material recovery (`recoverPerDomain`): continuous inside each material group (FieldData.cellGroup,
 *              else each domain), one value per group at nodes on material interfaces; the value of the group of the
 *              cell that holds the point (default)
 *   element    the element's own values (no averaging), discontinuous between cells
 *   averaged   the producer's nodal mean over every cell at a node, across interfaces (the field's `data`)
 * Fields without `elementNodal` (primary fields, DG0, older producers) read `data` in every mode.
 */
export type DerivedMode = 'recovered' | 'element' | 'averaged';

/** A field with the optional element values at the cell nodes (FieldData.elementNodal, contract extension). */
type WithElement = FieldData & { elementNodal?: Float64Array; cellGroup?: Int32Array };

/**
 * Recovery group per cell of a derived field (DevLog-066): the producer's constitutive group (FieldData.cellGroup:
 * cells of the same material constants share a group, so a boundary between two domains of one material is not an
 * interface) when it is present, has one entry per cell and is >= 0 on every cell with element values; else the
 * geometric domain (cells.domain).
 */
export function recoveryGroups(mesh: Mesh, f: FieldData, active?: Uint8Array): Int32Array {
  const g = (f as WithElement).cellGroup, nC = nCells(mesh);
  if (!g || g.length !== nC) return mesh.cells.domain;
  for (let c = 0; c < nC; c++) if ((!active || active[c]) && g[c]! < 0) return mesh.cells.domain;
  return g;
}

/**
 * Element values at the cell nodes before nodal averaging, `(cell * k + a) * components + j` (k nodes per cell, VTK
 * order; NaN for cells the producer left out), or null when the field carries none (or is not H1).
 */
export function elementNodalOf(mesh: Mesh, f: FieldData): Float64Array | null {
  const e = (f as WithElement).elementNodal;
  if (!e || (f.space !== 'H1P1' && f.space !== 'H1P2')) return null;
  const n = nCells(mesh) * NPC[mesh.cells.type] * f.components;
  if (e.length !== n) throw new Error(`field '${f.name}': elementNodal has ${e.length} values, mesh needs ${n} (cells x nodes per cell x components)`);
  return e;
}

const perDomain = new WeakMap<FieldData, { mesh: Mesh; values: Float64Array | null }>();

/**
 * Per-material recovery of a derived field (DevLog-059; groups DevLog-066): per (cell, local node) values, index
 * `(cell * k + a) * nc + j`. Groups: `recoveryGroups` (the producer's constitutive group FieldData.cellGroup, else the
 * geometric domain cells.domain). At a node whose cells (those with finite element values) all lie in one group: the
 * producer's nodal value `data` (bitwise). At a node shared by cells of several groups: the mean of the element values
 * of the cells of the same group at that node (count-weighted, the producer's rule restricted to the group), so a
 * material interface keeps one value per side while a boundary between two domains of one material keeps the smooth
 * nodal mean. Returns null when the field has no `elementNodal` or no node is shared by two groups (every reader then
 * uses `data`, unchanged). Cached per (field, mesh).
 */
export function recoverPerDomain(mesh: Mesh, f: FieldData): Float64Array | null {
  const hit = perDomain.get(f);
  if (hit && hit.mesh === mesh) return hit.values;
  const el = elementNodalOf(mesh, f);
  let values: Float64Array | null = null;
  if (el) {
    checkField(mesh, f);
    const k = NPC[mesh.cells.type], nc = f.components, nC = nCells(mesh), conn = mesh.cells.conn;
    const nN = mesh.nodes.length / mesh.dim;
    const active = new Uint8Array(nC);
    for (let c = 0; c < nC; c++) { let ok = 1; for (let i = c * k * nc; i < (c + 1) * k * nc; i++) if (!Number.isFinite(el[i]!)) { ok = 0; break; } active[c] = ok; }
    const dom = recoveryGroups(mesh, f, active);
    const first = new Int32Array(nN).fill(-1), multi = new Uint8Array(nN);
    let nMulti = 0;
    for (let c = 0; c < nC; c++) {
      if (!active[c]) continue;
      const g = dom[c]!;
      for (let a = 0; a < k; a++) {
        const v = conn[k * c + a]!;
        if (first[v]! < 0) first[v] = g;
        else if (first[v] !== g && !multi[v]) { multi[v] = 1; nMulti++; }
      }
    }
    if (nMulti) {
      // slot per (interface node, group)
      const slotOf = new Map<number, number>(), slot = new Int32Array(k * nC).fill(-1);
      let nG = 0; for (let c = 0; c < nC; c++) nG = Math.max(nG, dom[c]! + 1);
      for (let c = 0; c < nC; c++) {
        if (!active[c]) continue;
        for (let a = 0; a < k; a++) {
          const v = conn[k * c + a]!;
          if (!multi[v]) continue;
          const key = v * nG + dom[c]!;
          let s = slotOf.get(key);
          if (s === undefined) { s = slotOf.size; slotOf.set(key, s); }
          slot[k * c + a] = s;
        }
      }
      const sum = new Float64Array(slotOf.size * nc), cnt = new Float64Array(slotOf.size);
      for (let c = 0; c < nC; c++)
        for (let a = 0; a < k; a++) {
          const s = slot[k * c + a]!;
          if (s < 0) continue;
          for (let j = 0; j < nc; j++) sum[nc * s + j]! += el[(k * c + a) * nc + j]!;
          cnt[s]!++;
        }
      values = new Float64Array(nC * k * nc);
      for (let c = 0; c < nC; c++)
        for (let a = 0; a < k; a++) {
          const s = slot[k * c + a]!, v = conn[k * c + a]!, o = (k * c + a) * nc;
          for (let j = 0; j < nc; j++) values[o + j] = s >= 0 ? sum[nc * s + j]! / cnt[s]! : f.data[v * nc + j]!;
        }
    }
  }
  perDomain.set(f, { mesh, values });
  return values;
}

const elementFilled = new WeakMap<FieldData, { mesh: Mesh; values: Float64Array | null }>();

/** Element values with the cells the producer left out (non-finite values) read from `data` at their nodes. */
function elementValues(mesh: Mesh, f: FieldData): Float64Array | null {
  const hit = elementFilled.get(f);
  if (hit && hit.mesh === mesh) return hit.values;
  const el = elementNodalOf(mesh, f);
  let values = el;
  if (el) {
    const k = NPC[mesh.cells.type], nc = f.components, nC = nCells(mesh), conn = mesh.cells.conn;
    for (let c = 0; c < nC; c++) {
      let ok = true;
      for (let i = c * k * nc; i < (c + 1) * k * nc; i++) if (!Number.isFinite(el[i]!)) { ok = false; break; }
      if (ok) continue;
      if (values === el) { checkField(mesh, f); values = Float64Array.from(el); }
      for (let a = 0; a < k; a++) for (let j = 0; j < nc; j++) values![(k * c + a) * nc + j] = f.data[conn[k * c + a]! * nc + j]!;
    }
  }
  elementFilled.set(f, { mesh, values });
  return values;
}

/** Per (cell, local node) values of a field for a mode, or null when the reader uses `data` at the cell's nodes. */
export function derivedValues(mesh: Mesh, f: FieldData, mode: DerivedMode = 'recovered'): Float64Array | null {
  if (mode === 'averaged') return null;
  return mode === 'element' ? elementValues(mesh, f) : recoverPerDomain(mesh, f);
}

/**
 * Values (point-major, components per point) and optionally gradients ((point * components + j) * dim + d) of a field
 * at a point set, from each point's own cell. NaN outside. Gradients of a DG0 field are an error (not differentiable).
 * `smooth`: a DG0 field is read through `recoverDG0` (corner values, linear / bilinear on the cell's corners), as the
 * 2D view draws it, instead of the cell constant; other spaces are unaffected. `derived` (default 'recovered'): how a
 * field with element values (`elementNodal`) is read (`DerivedMode`); no effect on other fields.
 */
export function interpolate(f: FieldData, ps: PointSet, o: { grad?: boolean; smooth?: boolean; derived?: DerivedMode } = {}): { values: Float64Array; grad?: Float64Array } {
  const mesh = ps.mesh, dim = mesh.dim, nc = f.components, np = ps.n;
  checkField(mesh, f);
  if (o.grad && f.space === 'DG0') throw new Error(`d(): field '${f.name}' is DG0 (piecewise constant); its derivative is not defined`);
  const values = new Float64Array(np * nc).fill(NaN);
  const grad = o.grad ? new Float64Array(np * nc * dim).fill(NaN) : undefined;
  const type = mesh.cells.type, k = NPC[type], rd = REF_DIM[type]!, conn = mesh.cells.conn, X = mesh.nodes;
  const N = new Float64Array(k), dN = new Float64Array(k * rd), r = new Float64Array(3);
  const J = new Float64Array(9), gr = new Float64Array(3);
  const smooth = !!o.smooth && f.space === 'DG0';
  const corners = smooth ? recoverDG0(mesh, f) : null;
  const ct = smooth ? CORNER_TYPE[type]! : type, nk = NPC[ct];
  const Nk = new Float64Array(nk), dNk = new Float64Array(nk * (REF_DIM[ct] ?? rd));
  // derived fields: per (cell, local node) values (index (k c + a) nc + j); else data at the cell's nodes
  const dv = f.space === 'DG0' ? null : derivedValues(mesh, f, o.derived);
  const src = dv ?? f.data;
  for (let i = 0; i < np; i++) {
    const c = ps.cell[i]!;
    if (c < 0) continue;
    if (corners) {
      r[0] = ps.ref[3 * i]!; r[1] = ps.ref[3 * i + 1]!; r[2] = ps.ref[3 * i + 2]!;
      shape(ct, r, Nk, dNk);
      for (let j = 0; j < nc; j++) { let s = 0; for (let a = 0; a < nk; a++) s += Nk[a]! * corners[(nk * c + a) * nc + j]!; values[i * nc + j] = s; }
      continue;
    }
    if (f.space === 'DG0') { for (let j = 0; j < nc; j++) values[i * nc + j] = f.data[c * nc + j]!; continue; }
    r[0] = ps.ref[3 * i]!; r[1] = ps.ref[3 * i + 1]!; r[2] = ps.ref[3 * i + 2]!;
    shape(type, r, N, dN);
    for (let j = 0; j < nc; j++) {
      let s = 0;
      for (let a = 0; a < k; a++) s += N[a]! * src[(dv ? k * c + a : conn[k * c + a]!) * nc + j]!;
      values[i * nc + j] = s;
    }
    if (!grad) continue;
    J.fill(0);
    for (let a = 0; a < k; a++) { const nd = conn[k * c + a]!; for (let p = 0; p < dim; p++) for (let s = 0; s < rd; s++) J[3 * p + s]! += X[dim * nd + p]! * dN[rd * a + s]!; }
    for (let j = 0; j < nc; j++) {
      gr.fill(0);
      for (let a = 0; a < k; a++) { const v = src[(dv ? k * c + a : conn[k * c + a]!) * nc + j]!; for (let s = 0; s < rd; s++) gr[s]! += v * dN[rd * a + s]!; }
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
