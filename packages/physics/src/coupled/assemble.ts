// SPDX-License-Identifier: GPL-3.0-or-later
// Shared finite-element machinery of lane MT (DevLog-033): DOF maps over (node, component) with fixed (-1) and merged
// (floating) DOFs, the CSR pattern of a DOF map, element scatter, solid strain-displacement rows for plane stress /
// plane strain / 3D / axisymmetric (r, z; azimuthal order 0), isotropic constitutive matrices, solid constraint
// flags (fixed, roller, displacement) and boundary loads (traction, pressure; weight r in axisymmetry), and the
// faces shared by two cell sets (fluid-structure interface). Every mesh node of a tri6 / tet10 mesh is a DOF.

import type { Mesh } from '@amp/spec/types';
import { NPC, facetNodes, facetsOn, nCells, nNodes, selectEntities } from '../common/mesh.ts';
import { cellPattern, cellOrder, facetTable, type Csr } from '../common/scalar.ts';
import { facetJac, gatherX } from '../common/lagrange.ts';

export type SolidModel = 'plane-stress' | 'plane-strain' | '3d' | 'axisym';

/** Voigt size: 2D [xx, yy, xy]; axisym [rr, zz, phiphi, rz]; 3D [xx, yy, zz, yz, xz, xy]. */
export const voigtSize = (model: SolidModel): number => (model === '3d' ? 6 : model === 'axisym' ? 4 : 3);

/** Isotropic constitutive matrix (nv x nv, row-major) for E, nu. */
export function isoD(model: SolidModel, E: number, nu: number): Float64Array {
  if (model === 'plane-stress') { const c = E / (1 - nu * nu); return Float64Array.from([c, c * nu, 0, c * nu, c, 0, 0, 0, (c * (1 - nu)) / 2]); }
  const lam = (E * nu) / ((1 + nu) * (1 - 2 * nu)), mu = E / (2 * (1 + nu));
  if (model === 'plane-strain') return Float64Array.from([lam + 2 * mu, lam, 0, lam, lam + 2 * mu, 0, 0, 0, mu]);
  if (model === 'axisym') {
    const a = lam + 2 * mu;
    return Float64Array.from([a, lam, lam, 0, lam, a, lam, 0, lam, lam, a, 0, 0, 0, 0, mu]);
  }
  const D = new Float64Array(36);
  for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) D[6 * i + j] = lam; D[6 * i + i] = lam + 2 * mu; D[6 * (i + 3) + i + 3] = mu; }
  return D;
}

/**
 * Strain-displacement rows B (nv x k*dim, row-major) from physical gradients G (k x dim), shape values N (k) and the
 * radius r (axisym only). Axisym: e_rr = du_r/dr, e_zz = du_z/dz, e_phiphi = u_r / r, g_rz = du_r/dz + du_z/dr; at
 * r = 0 the hoop row uses du_r/dr (limit of u_r / r with u_r(0) = 0).
 */
export function strainB(model: SolidModel, G: Float64Array, N: Float64Array, r: number, k: number, B: Float64Array): void {
  B.fill(0);
  if (model === '3d') {
    const nd = 3 * k;
    for (let a = 0; a < k; a++) {
      const gx = G[3 * a]!, gy = G[3 * a + 1]!, gz = G[3 * a + 2]!, c = 3 * a;
      B[c] = gx; B[nd + c + 1] = gy; B[2 * nd + c + 2] = gz;
      B[3 * nd + c + 1] = gz; B[3 * nd + c + 2] = gy;
      B[4 * nd + c] = gz; B[4 * nd + c + 2] = gx;
      B[5 * nd + c] = gy; B[5 * nd + c + 1] = gx;
    }
    return;
  }
  const nd = 2 * k;
  if (model === 'axisym') {
    for (let a = 0; a < k; a++) {
      const gr = G[2 * a]!, gz = G[2 * a + 1]!, c = 2 * a;
      B[c] = gr; B[nd + c + 1] = gz; B[2 * nd + c] = r > 0 ? N[a]! / r : gr; B[3 * nd + c] = gz; B[3 * nd + c + 1] = gr;
    }
    return;
  }
  for (let a = 0; a < k; a++) {
    const gx = G[2 * a]!, gy = G[2 * a + 1]!, c = 2 * a;
    B[c] = gx; B[nd + c + 1] = gy; B[2 * nd + c] = gy; B[2 * nd + c + 1] = gx;
  }
}

// ------------------------------------------------------------------------------------------------ DOF maps, pattern

/** map[node * nComp + c] = global DOF or -1 (not a DOF: fixed, or outside the field's domain). */
export interface DofMap { nComp: number; map: Int32Array; n: number }

/** CSR pattern (full symmetric storage, sorted columns) of the DOF map over the cell connectivity of `m`. */
export function dofPattern(m: Mesh, dm: DofMap): Csr {
  const np = cellPattern(m), nn = nNodes(m), nc = dm.nComp, map = dm.map, n = dm.n;
  const cnt = new Int32Array(n + 1);
  for (let a = 0; a < nn; a++) for (let c = 0; c < nc; c++) {
    const r = map[a * nc + c]!;
    if (r < 0) continue;
    let s = 0;
    for (let q = np.rowptr[a]!; q < np.rowptr[a + 1]!; q++) { const b = np.colidx[q]!; for (let d = 0; d < nc; d++) if (map[b * nc + d]! >= 0) s++; }
    cnt[r + 1]! += s;
  }
  for (let i = 0; i < n; i++) cnt[i + 1]! += cnt[i]!;
  const raw = new Int32Array(cnt[n]!), fill = cnt.slice(0, n);
  for (let a = 0; a < nn; a++) for (let c = 0; c < nc; c++) {
    const r = map[a * nc + c]!;
    if (r < 0) continue;
    for (let q = np.rowptr[a]!; q < np.rowptr[a + 1]!; q++) { const b = np.colidx[q]!; for (let d = 0; d < nc; d++) { const col = map[b * nc + d]!; if (col >= 0) raw[fill[r]!++] = col; } }
  }
  const rowptr = new Int32Array(n + 1);
  let z = 0;
  for (let i = 0; i < n; i++) {
    const seg = raw.subarray(cnt[i]!, cnt[i + 1]!).sort();
    let last = -1;
    const start = z;
    for (let q = 0; q < seg.length; q++) { const v = seg[q]!; if (v !== last) { raw[z++] = v; last = v; } }
    void start;
    rowptr[i + 1] = z;
  }
  return { n, rowptr, colidx: raw.slice(0, z), nnz: z };
}

/** CSR slot of (i, j) by binary search, -1 if absent. */
export function slotOf(p: Csr, i: number, j: number): number {
  let lo = p.rowptr[i]!, hi = p.rowptr[i + 1]! - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1, c = p.colidx[mid]!; if (c === j) return mid; if (c < j) lo = mid + 1; else hi = mid - 1; }
  return -1;
}

/** vals[(dofs[a], dofs[b])] += s * Ae[a * nd + b] for dofs >= 0 (dofs may repeat: merged DOFs). */
export function scatter(p: Csr, vals: Float64Array, dofs: ArrayLike<number>, Ae: Float64Array, nd: number, s = 1): void {
  for (let a = 0; a < nd; a++) {
    const i = dofs[a]!;
    if (i < 0) continue;
    for (let b = 0; b < nd; b++) {
      const j = dofs[b]!, v = Ae[a * nd + b]!;
      if (j < 0 || v === 0) continue;
      const z = slotOf(p, i, j);
      if (z < 0) throw new Error(`scatter: (${i}, ${j}) not in the pattern`);
      vals[z]! += s * v;
    }
  }
}

/** y = A x for a CSR matrix. */
export function csrMv(p: Csr, v: Float64Array, x: Float64Array, y: Float64Array): Float64Array {
  for (let i = 0; i < p.n; i++) { let s = 0; for (let q = p.rowptr[i]!; q < p.rowptr[i + 1]!; q++) s += v[q]! * x[p.colidx[q]!]!; y[i] = s; }
  return y;
}

// ------------------------------------------------------------------------------------------------ BC node sets

/**
 * Nodes of a constraint selection: `pnt:` ids through the mesh's point entities (Mesh.pointNode: point entity ->
 * node, set by the 2D mesher for geometry vertices), every other id through the boundary facets. Point selections on a
 * mesh without point entities are an error naming the selection.
 */
export function bcNodes(m: Mesh, select: readonly string[]): Int32Array {
  const pts = select.filter((x) => x.startsWith('pnt:')), rest = select.filter((x) => !x.startsWith('pnt:'));
  const out = new Set<number>(rest.length ? facetNodes(m, facetsOn(m, rest)) : []);
  if (pts.length) {
    const pn = (m as Mesh & { pointNode?: Int32Array }).pointNode;
    if (!pn || !m.entities.points?.length) throw new Error(`selection ${pts.join(', ')}: the mesh has no point entities (point constraints need a mesh with Mesh.pointNode)`);
    for (const i of selectEntities(m.entities, 'points', pts)) {
      const v = pn[i]!;
      if (v < 0) throw new Error(`point ${m.entities.points[i]!.id} has no mesh node`);
      out.add(v);
    }
  }
  return Int32Array.from([...out].sort((a, b) => a - b));
}

// ------------------------------------------------------------------------------------------------ solid constraints

export type SolidBc =
  | { type: 'fixed'; select: string[] }
  | { type: 'roller'; select: string[] }
  | { type: 'displacement'; select: string[]; component: number; value: number }
  | { type: 'traction'; select: string[]; t: number[] | ((x: Float64Array, n: Float64Array) => number[]) }
  | { type: 'pressure'; select: string[]; p: number | ((x: Float64Array) => number) };

/**
 * Constrained displacement components (flags + values over node * dim + c) from fixed / roller / displacement
 * conditions; a roller fixes the component along the boundary normal, which must be a coordinate axis. Axisym:
 * nodes on r = 0 get u_r = 0.
 */
export function solidConstraints(m: Mesh, model: SolidModel, bcs: readonly { type: string; select: string[]; component?: number; value?: number }[]): { fixed: Uint8Array; value: Float64Array } {
  const dim = m.dim, nn = nNodes(m), fixed = new Uint8Array(nn * dim), value = new Float64Array(nn * dim);
  for (const b of bcs) {
    if (b.type === 'fixed') for (const v of bcNodes(m, b.select)) for (let d = 0; d < dim; d++) fixed[dim * v + d] = 1;
    else if (b.type === 'displacement') for (const v of bcNodes(m, b.select)) { fixed[dim * v + b.component!] = 1; value[dim * v + b.component!] = b.value!; }
    else if (b.type === 'roller') {
      if (b.select.some((x) => x.startsWith('pnt:'))) throw new Error(`elastic: roller on ${b.select.join(', ')}: a point has no normal; use a displacement condition with the components to fix`);
      const ns = facetNodes(m, facetsOn(m, b.select));
      let span = 0;
      const lo = new Float64Array(dim).fill(Infinity), hi = new Float64Array(dim).fill(-Infinity);
      for (const v of ns) for (let d = 0; d < dim; d++) { const x = m.nodes[dim * v + d]!; lo[d] = Math.min(lo[d]!, x); hi[d] = Math.max(hi[d]!, x); }
      for (let d = 0; d < dim; d++) span = Math.max(span, hi[d]! - lo[d]!);
      let axis = -1;
      for (let d = 0; d < dim; d++) if (hi[d]! - lo[d]! <= 1e-12 * span) axis = d;
      if (axis < 0) throw new Error(`elastic: roller on ${b.select.join(', ')} needs a boundary normal to a coordinate axis`);
      for (const v of ns) fixed[dim * v + axis] = 1;
    }
  }
  if (model === 'axisym') {
    let rmax = 0;
    for (let v = 0; v < nn; v++) rmax = Math.max(rmax, Math.abs(m.nodes[2 * v]!));
    for (let v = 0; v < nn; v++) if (Math.abs(m.nodes[2 * v]!) <= 1e-12 * rmax) { fixed[2 * v] = 1; value[2 * v] = 0; }
  }
  return { fixed, value };
}

/** Facet -> one adjacent cell (cell containing all facet corner nodes), -1 if none. */
export function facetCells(m: Mesh, mask?: Uint8Array): Int32Array {
  const k = NPC[m.cells.type], kf = NPC[m.facets.type], nc = nCells(m), nf = m.facets.conn.length / kf;
  const corners = m.dim === 2 ? 2 : 3, kc = m.dim === 2 ? 3 : 4;
  const nodeCells = new Map<number, number[]>();
  for (let c = 0; c < nc; c++) {
    if (mask && !mask[c]) continue;
    for (let a = 0; a < kc; a++) { const v = m.cells.conn[k * c + a]!; let l = nodeCells.get(v); if (!l) { l = []; nodeCells.set(v, l); } l.push(c); }
  }
  const out = new Int32Array(nf).fill(-1);
  for (let f = 0; f < nf; f++) {
    const vs = Array.from({ length: corners }, (_, a) => m.facets.conn[kf * f + a]!);
    for (const c of nodeCells.get(vs[0]!) ?? []) {
      let ok = true;
      for (const v of vs) { let hit = false; for (let a = 0; a < kc; a++) if (m.cells.conn[k * c + a] === v) { hit = true; break; } if (!hit) { ok = false; break; } }
      if (ok) { out[f] = c; break; }
    }
  }
  return out;
}

/**
 * Boundary loads (traction, pressure = -p n with n the outward normal of the solid) into F over node * dim + c;
 * weight r in axisymmetry (per radian). `mask` restricts the adjacent-cell search to the solid.
 */
export function solidLoads(m: Mesh, model: SolidModel, bcs: readonly SolidBc[], F: Float64Array, mask?: Uint8Array): void {
  const dim = m.dim, k = NPC[m.cells.type];
  const loads = bcs.filter((b) => b.type === 'traction' || b.type === 'pressure');
  if (!loads.length) return;
  const fc = facetCells(m, mask);
  const tf = facetTable(m, 2 * cellOrder(m) + 2), kf = tf.nn;
  const Xf = new Float64Array(kf * dim), nrm = new Float64Array(dim), P = new Float64Array(dim), cen = new Float64Array(dim);
  for (const b of loads) {
    for (const f of facetsOn(m, b.select)) {
      gatherX(m.nodes, dim, m.facets.conn, f, kf, Xf);
      const c = fc[f]!;
      if (c < 0) throw new Error(`load on ${b.select.join(', ')}: facet ${f} is not on the solid`);
      cen.fill(0);
      for (let a = 0; a < k; a++) for (let d = 0; d < dim; d++) cen[d]! += m.nodes[dim * m.cells.conn[k * c + a]! + d]! / k;
      for (let q = 0; q < tf.rule.n; q++) {
        let w = facetJac(tf, q, Xf, dim, nrm) * tf.rule.wts[q]!;
        P.fill(0);
        for (let a = 0; a < kf; a++) for (let d = 0; d < dim; d++) P[d]! += tf.N[q * kf + a]! * Xf[dim * a + d]!;
        if (model === 'axisym') w *= P[0]!;
        let dot = 0; for (let d = 0; d < dim; d++) dot += nrm[d]! * (P[d]! - cen[d]!);
        if (dot < 0) for (let d = 0; d < dim; d++) nrm[d] = -nrm[d]!;
        const tv = b.type === 'pressure' ? Array.from(nrm, (v) => -(typeof b.p === 'number' ? b.p : b.p(P)) * v) : typeof (b as { t: unknown }).t === 'function' ? (b as { t: (x: Float64Array, n: Float64Array) => number[] }).t(P, nrm) : (b as { t: number[] }).t;
        for (let a = 0; a < kf; a++) { const v = m.facets.conn[kf * f + a]!, Na = tf.N[q * kf + a]!; for (let d = 0; d < dim; d++) F[dim * v + d]! += tv[d]! * Na * w; }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ shared faces

/** Local faces of a cell type: node indices in the facet type's order (line2/line3, tri3/tri6), corners first. */
export function cellFaces(type: string): number[][] {
  switch (type) {
    case 'tri3': return [[0, 1], [1, 2], [2, 0]];
    case 'tri6': return [[0, 1, 3], [1, 2, 4], [2, 0, 5]];
    case 'tet4': return [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];
    case 'tet10': {
      // tet10 edges: 4 = 01, 5 = 12, 6 = 02, 7 = 03, 8 = 13, 9 = 23
      const mid = (a: number, b: number) => { const k = a < b ? `${a}${b}` : `${b}${a}`; return ({ '01': 4, '12': 5, '02': 6, '03': 7, '13': 8, '23': 9 } as Record<string, number>)[k]!; };
      return [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]].map(([a, b, c]) => [a!, b!, c!, mid(a!, b!), mid(b!, c!), mid(c!, a!)]);
    }
    default: throw new Error(`cellFaces: ${type}`);
  }
}

/** Faces shared by a cell of set A and a cell of set B: global node lists (facet order) and the B cell of each. */
export function sharedFaces(m: Mesh, inA: Uint8Array, inB: Uint8Array): { nodes: Int32Array; nper: number; cellB: Int32Array; cellA: Int32Array } {
  const k = NPC[m.cells.type], faces = cellFaces(m.cells.type), nc = nCells(m), corners = m.dim === 2 ? 2 : 3;
  const key = (c: number, f: number[]) => f.slice(0, corners).map((a) => m.cells.conn[k * c + a]!).sort((x, y) => x - y).join(',');
  const aFaces = new Map<string, number>();
  for (let c = 0; c < nc; c++) if (inA[c]) for (const f of faces) aFaces.set(key(c, f), c);
  const out: number[] = [], cb: number[] = [], ca: number[] = [];
  for (let c = 0; c < nc; c++) {
    if (!inB[c]) continue;
    for (const f of faces) {
      const a = aFaces.get(key(c, f));
      if (a === undefined || a === c) continue;
      for (const l of f) out.push(m.cells.conn[k * c + l]!);
      cb.push(c); ca.push(a);
    }
  }
  return { nodes: Int32Array.from(out), nper: faces[0]!.length, cellB: Int32Array.from(cb), cellA: Int32Array.from(ca) };
}

// ------------------------------------------------------------------------------------------------ scaling

/**
 * Symmetric diagonal (Jacobi) scaling d_i = 1 / sqrt(|A_ii|) (1 where the diagonal is 0): the coupled blocks differ
 * by many orders of magnitude (K_uu ~ c h ~ 1e8 N/m vs K_VV ~ eps h ~ 1e-12 F; acoustic 1 / rho vs solid E), and the
 * LDL^T static pivoting would perturb the small pivots. A' = D A D, x = D x'; eigenvalues are unchanged.
 */
export function jacobiScale(p: Csr, A: Float64Array): Float64Array {
  const d = new Float64Array(p.n).fill(1);
  for (let i = 0; i < p.n; i++) for (let q = p.rowptr[i]!; q < p.rowptr[i + 1]!; q++) if (p.colidx[q] === i) { const a = Math.abs(A[q]!); if (a > 0) d[i] = 1 / Math.sqrt(a); }
  return d;
}

/** Values of D A D (row scale d_i, column scale d_j). */
export function scaleSym(p: Csr, A: Float64Array, d: Float64Array): Float64Array {
  const out = new Float64Array(A.length);
  for (let i = 0; i < p.n; i++) for (let q = p.rowptr[i]!; q < p.rowptr[i + 1]!; q++) out[q] = d[i]! * A[q]! * d[p.colidx[q]!]!;
  return out;
}
