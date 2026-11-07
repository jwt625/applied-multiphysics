// SPDX-License-Identifier: GPL-3.0-or-later
// Generic scalar H1 finite elements on C2 meshes (Lagrange P1/P2 on triangles and tets, Q1 on hexes; isoparametric):
//   K_ab = int k grad N_a . grad N_b w dV,  M_ab = int m N_a N_b w dV,  F_a = int f N_a w dV,
// with w = 1 (2D per unit depth, 3D) or w = r (axisymmetric meridional (r, z) plane, r = x coordinate). Facet terms
// R_ab = int h N_a N_b w dS and G_a = int g N_a w dS (Robin / flux). Every mesh node is a DOF (tri6 / tet10 nodes
// included). Solves: supernodal Cholesky (@amp/core la/sparse), or AMG-preconditioned CG on request.

import type { Mesh } from '@amp/spec/types';
import { buildElementPattern, elementSlots, SparseCholesky } from '@amp/core/la/sparse';
import { buildAMG } from '@amp/core/la/amg';
import { NPC, nCells, nNodes } from './mesh.ts';
import { defaultRule, facetJac, gatherX, physGrad, shapeTable, type ShapeTable } from './lagrange.ts';

export interface Csr { n: number; rowptr: Int32Array; colidx: Int32Array; nnz: number }

export interface CellCoef {
  /** isotropic diffusion coefficient per cell */
  k?: Float64Array;
  /** mass coefficient per cell */
  m?: Float64Array;
  /** volume source per cell */
  f?: Float64Array;
  /** volume source as a function of the physical point (used instead of f when given; cell index for masks) */
  fFn?: (x: Float64Array, cell: number) => number;
  /** cells taking part (default all) */
  mask?: Uint8Array;
  /** extra weight: 'r' multiplies by the radius (axisym), 'invr' by 1/r */
  weight?: 'none' | 'r';
  /** integrand degree for the default rule (default 2 * order + 1 for curved P2 safety) */
  degree?: number;
}

export interface Assembled { pat: Csr; K?: Float64Array; M?: Float64Array; F?: Float64Array; active: Uint8Array }

export function cellOrder(m: Mesh): 1 | 2 {
  const t = m.cells.type;
  return t === 'tri6' || t === 'tet10' ? 2 : 1;
}

let patCache: WeakMap<Int32Array, Csr> = new WeakMap();

/** CSR pattern of the cell connectivity (cached per conn array). */
export function cellPattern(m: Mesh): Csr {
  const hit = patCache.get(m.cells.conn);
  if (hit) return hit;
  const p = buildElementPattern(nNodes(m), m.cells.conn, NPC[m.cells.type]) as Csr;
  patCache.set(m.cells.conn, p);
  return p;
}
export function clearPatternCache(): void { patCache = new WeakMap(); }

/** Volume assembly of K (if k), M (if m), F (if f). */
export function assembleCells(mesh: Mesh, c: CellCoef, rule?: ReturnType<typeof defaultRule>): Assembled {
  const type = mesh.cells.type, dim = mesh.dim, k = NPC[type];
  const nc = nCells(mesh), nn = nNodes(mesh);
  const pat = cellPattern(mesh);
  const slots = elementSlots(pat, mesh.cells.conn, k) as Int32Array;
  const ord = cellOrder(mesh);
  const r = rule ?? defaultRule(type, c.degree ?? (type === 'hex8' ? 3 : 2 * ord + (c.weight === 'r' ? 1 : 0)));
  const t = shapeTable(type, r);
  const K = c.k ? new Float64Array(pat.nnz) : undefined;
  const M = c.m ? new Float64Array(pat.nnz) : undefined;
  const F = c.f || c.fFn ? new Float64Array(nn) : undefined;
  const P = new Float64Array(dim);
  const active = new Uint8Array(nn);
  const X = new Float64Array(k * dim), G = new Float64Array(k * dim);
  const Ke = new Float64Array(k * k), Me = new Float64Array(k * k), Fe = new Float64Array(k);
  const axi = c.weight === 'r';
  for (let e = 0; e < nc; e++) {
    if (c.mask && !c.mask[e]) continue;
    gatherX(mesh.nodes, dim, mesh.cells.conn, e, k, X);
    Ke.fill(0); Me.fill(0); Fe.fill(0);
    const ke = c.k ? c.k[e]! : 0, me = c.m ? c.m[e]! : 0, fe = c.f ? c.f[e]! : 0;
    for (let q = 0; q < r.n; q++) {
      const det = physGrad(t, q, X, dim, G);
      let w = det * r.wts[q]!;
      if (axi) { let rr = 0; for (let a = 0; a < k; a++) rr += t.N[q * k + a]! * X[dim * a]!; w *= rr; }
      const Nq = t.N.subarray(q * k, q * k + k);
      let fq = fe;
      if (c.fFn) { P.fill(0); for (let a = 0; a < k; a++) for (let d = 0; d < dim; d++) P[d]! += Nq[a]! * X[dim * a + d]!; fq = c.fFn(P, e); }
      for (let a = 0; a < k; a++) {
        if (F) Fe[a]! += fq * Nq[a]! * w;
        for (let b = a; b < k; b++) {
          if (K) { let s = 0; for (let d = 0; d < dim; d++) s += G[dim * a + d]! * G[dim * b + d]!; Ke[k * a + b]! += ke * s * w; }
          if (M) Me[k * a + b]! += me * Nq[a]! * Nq[b]! * w;
        }
      }
    }
    const base = k * k * e;
    for (let a = 0; a < k; a++) {
      active[mesh.cells.conn[k * e + a]!] = 1;
      if (F) F[mesh.cells.conn[k * e + a]!]! += Fe[a]!;
      for (let b = 0; b < k; b++) {
        const v = a <= b ? k * a + b : k * b + a;
        if (K) K[slots[base + k * a + b]!]! += Ke[v]!;
        if (M) M[slots[base + k * a + b]!]! += Me[v]!;
      }
    }
  }
  return { pat, ...(K ? { K } : {}), ...(M ? { M } : {}), ...(F ? { F } : {}), active };
}

/** Facet shape table for the mesh's facet type. */
export function facetTable(mesh: Mesh, degree = 5): ShapeTable {
  return shapeTable(mesh.facets.type, defaultRule(mesh.facets.type, degree));
}

/**
 * Facet integrals over the listed facets: adds h N_a N_b w dS into Kval (CSR slots of pat), g N_a w dS into F.
 * h, g given per listed facet (arrays aligned with `facets`) or as constants; or as functions of the quadrature point.
 */
export function assembleFacets(mesh: Mesh, pat: Csr, facets: readonly number[], o: {
  h?: number | ((x: Float64Array, f: number) => number); g?: number | ((x: Float64Array, f: number) => number);
  Kval?: Float64Array; F?: Float64Array; weight?: 'none' | 'r';
}): void {
  const dim = mesh.dim, type = mesh.facets.type, k = NPC[type];
  const t = facetTable(mesh, 2 * (cellOrder(mesh)) + 2);
  const X = new Float64Array(k * dim), P = new Float64Array(dim);
  const nodes = new Int32Array(k);
  const He = new Float64Array(k * k), Ge = new Float64Array(k);
  for (const f of facets) {
    for (let a = 0; a < k; a++) nodes[a] = mesh.facets.conn[k * f + a]!;
    gatherX(mesh.nodes, dim, mesh.facets.conn, f, k, X);
    He.fill(0); Ge.fill(0);
    for (let q = 0; q < t.rule.n; q++) {
      let w = facetJac(t, q, X, dim) * t.rule.wts[q]!;
      P.fill(0);
      for (let a = 0; a < k; a++) for (let d = 0; d < dim; d++) P[d]! += t.N[q * k + a]! * X[dim * a + d]!;
      if (o.weight === 'r') w *= P[0]!;
      const hv = o.h === undefined ? 0 : typeof o.h === 'number' ? o.h : o.h(P, f);
      const gv = o.g === undefined ? 0 : typeof o.g === 'number' ? o.g : o.g(P, f);
      for (let a = 0; a < k; a++) {
        const Na = t.N[q * k + a]!;
        Ge[a]! += gv * Na * w;
        if (hv !== 0) for (let b = 0; b < k; b++) He[k * a + b]! += hv * Na * t.N[q * k + b]! * w;
      }
    }
    if (o.F) for (let a = 0; a < k; a++) o.F[nodes[a]!]! += Ge[a]!;
    if (o.Kval && o.h !== undefined) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) o.Kval[entry(pat, nodes[a]!, nodes[b]!)]! += He[k * a + b]!;
  }
}

/** CSR slot of (i, j) by binary search (throws if absent). */
export function entry(p: Csr, i: number, j: number): number {
  let lo = p.rowptr[i]!, hi = p.rowptr[i + 1]! - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, c = p.colidx[mid]!;
    if (c === j) return mid;
    if (c < j) lo = mid + 1; else hi = mid - 1;
  }
  throw new Error(`CSR entry (${i}, ${j}) not in pattern`);
}

export function matVec(p: Csr, val: Float64Array, x: Float64Array, out: Float64Array): Float64Array {
  for (let i = 0; i < p.n; i++) {
    let s = 0;
    for (let q = p.rowptr[i]!; q < p.rowptr[i + 1]!; q++) s += val[q]! * x[p.colidx[q]!]!;
    out[i] = s;
  }
  return out;
}

/** Restrict a CSR matrix to the rows/columns with free[i] = 1. */
export function restrict(p: Csr, val: Float64Array, free: Uint8Array): { pat: Csr; val: Float64Array; map: Int32Array; inv: Int32Array; src: Int32Array } {
  const n = p.n, map = new Int32Array(n).fill(-1);
  let nf = 0;
  for (let i = 0; i < n; i++) if (free[i]) map[i] = nf++;
  const inv = new Int32Array(nf);
  for (let i = 0; i < n; i++) if (map[i]! >= 0) inv[map[i]!] = i;
  const rowptr = new Int32Array(nf + 1);
  let nnz = 0;
  for (let i = 0; i < n; i++) {
    if (map[i]! < 0) continue;
    for (let q = p.rowptr[i]!; q < p.rowptr[i + 1]!; q++) if (map[p.colidx[q]!]! >= 0) nnz++;
    rowptr[map[i]! + 1] = nnz;
  }
  const colidx = new Int32Array(nnz), v = new Float64Array(nnz), src = new Int32Array(nnz);
  let z = 0;
  for (let i = 0; i < n; i++) {
    if (map[i]! < 0) continue;
    for (let q = p.rowptr[i]!; q < p.rowptr[i + 1]!; q++) {
      const c = map[p.colidx[q]!]!;
      if (c >= 0) { colidx[z] = c; v[z] = val[q]!; src[z] = q; z++; }
    }
  }
  return { pat: { n: nf, rowptr, colidx, nnz }, val: v, map, inv, src };
}

export interface LinearStats { solver: string; dof: number; nnz: number; iterations?: number; residual?: number; factorMs?: number; solveMs?: number }

/** Reusable SPD solver on a fixed restricted pattern: Cholesky (default) or AMG-PCG. */
export class SpdSolver {
  pat: Csr;
  kind: 'cholesky' | 'amg-pcg';
  private chol: SparseCholesky | null = null;
  private amg: ReturnType<typeof buildAMG> | null = null;
  private val: Float64Array | null = null;
  lastIterations = 0;
  lastResidual = 0;
  rtol: number;
  constructor(pat: Csr, kind: 'cholesky' | 'amg-pcg' = 'cholesky', rtol = 1e-11) { this.pat = pat; this.kind = kind; this.rtol = rtol; }
  factor(val: Float64Array): void {
    this.val = val;
    if (this.kind === 'cholesky') {
      if (!this.chol) this.chol = new SparseCholesky(this.pat);
      if (!this.chol.factor(val)) throw new Error('Cholesky: matrix not positive definite');
    } else {
      this.amg = buildAMG({ ...this.pat, val });
    }
  }
  get nnzL(): number { return this.chol ? Number(this.chol.nnzL) : 0; }
  solve(b: Float64Array, x0?: Float64Array): Float64Array {
    if (this.kind === 'cholesky') return this.chol!.solve(b, new Float64Array(b.length)) as Float64Array;
    return this.pcg(b, x0);
  }
  private pcg(b: Float64Array, x0?: Float64Array): Float64Array {
    const n = this.pat.n, A = this.val!;
    const x = x0 ? Float64Array.from(x0) : new Float64Array(n);
    const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n);
    matVec(this.pat, A, x, q);
    let bn = 0;
    for (let i = 0; i < n; i++) { r[i] = b[i]! - q[i]!; bn += b[i]! * b[i]!; }
    bn = Math.sqrt(bn) || 1;
    z.fill(0); this.amg!.cycle(r, z);
    p.set(z);
    let rz = 0; for (let i = 0; i < n; i++) rz += r[i]! * z[i]!;
    let it = 0, rn = 0;
    for (; it < 2000; it++) {
      rn = 0; for (let i = 0; i < n; i++) rn += r[i]! * r[i]!;
      rn = Math.sqrt(rn);
      if (rn <= this.rtol * bn) break;
      matVec(this.pat, A, p, q);
      let pq = 0; for (let i = 0; i < n; i++) pq += p[i]! * q[i]!;
      const al = rz / pq;
      for (let i = 0; i < n; i++) { x[i]! += al * p[i]!; r[i]! -= al * q[i]!; }
      z.fill(0); this.amg!.cycle(r, z);
      let rz2 = 0; for (let i = 0; i < n; i++) rz2 += r[i]! * z[i]!;
      const be = rz2 / rz; rz = rz2;
      for (let i = 0; i < n; i++) p[i] = z[i]! + be * p[i]!;
    }
    this.lastIterations = it; this.lastResidual = rn / bn;
    if (rn > this.rtol * bn * 10) throw new Error(`AMG-PCG did not converge: relres ${rn / bn} after ${it} iterations`);
    return x;
  }
}

/**
 * Dirichlet elimination: given full K (on pat), F, fixed flags and values, returns the restricted system
 * (K_ff, F_f - K_fc u_c) and a function lifting a free solution to the full vector.
 */
export function eliminate(pat: Csr, K: Float64Array, F: Float64Array, fixed: Uint8Array, uFixed: Float64Array) {
  const n = pat.n, free = new Uint8Array(n);
  for (let i = 0; i < n; i++) free[i] = fixed[i] ? 0 : 1;
  const R = restrict(pat, K, free);
  const b = new Float64Array(R.pat.n);
  for (let i = 0; i < n; i++) {
    const fi = R.map[i]!;
    if (fi < 0) continue;
    let s = F[i]!;
    for (let q = pat.rowptr[i]!; q < pat.rowptr[i + 1]!; q++) { const c = pat.colidx[q]!; if (fixed[c]) s -= K[q]! * uFixed[c]!; }
    b[fi] = s;
  }
  const lift = (uf: Float64Array): Float64Array => {
    const u = new Float64Array(n);
    for (let i = 0; i < n; i++) u[i] = fixed[i] ? uFixed[i]! : uf[R.map[i]!]!;
    return u;
  };
  return { R, b, lift, free };
}
