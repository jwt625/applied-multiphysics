// SPDX-License-Identifier: GPL-3.0-or-later
// Linear elasticity (C4 type 'elastic'), small strain, isotropic: 2D plane stress / plane strain on tri3/tri6 and 3D on
// tet4/tet10 (isoparametric; P2 is the default element). Loads: boundary traction (constant vector, or a function of
// the point and outward normal), normal pressure, body force; thermal strain alpha (T - T_ref) per node (coupling
// input). Constraints: fixed, roller (zero normal displacement on boundaries whose normal is a coordinate axis),
// prescribed component. Derived: stresses (nodal averages of element values at the nodes), von Mises, principal
// stresses, K_t = max over a selection of sigma_1 / sigma_ref.

import type { Mesh, PhysicsModule, RunContext, Solution, Spec } from '@amp/spec/types';
import { NPC, facetNodes, facetsOn, nCells, nNodes } from '../common/mesh.ts';
import { cellPattern, restrict, SpdSolver, facetTable, cellOrder, type Csr } from '../common/scalar.ts';
import { defaultRule, gatherX, physGrad, shapeTable, facetJac, shape, REF_DIM } from '../common/lagrange.ts';
import { makeSolution, StageTimer, scalar } from '../common/solution.ts';
import { attachMesh } from '../common/solution.ts';
import { bcsOf, cellProps, physicsNode, optionalCellProp } from '../common/ctx.ts';
import { compileField, spaceOf, evalField } from '../common/field.ts';

export type Model = 'plane-stress' | 'plane-strain' | '3d';
export type VecFn = (x: Float64Array, n: Float64Array) => number[];
export type ElasticBc =
  | { type: 'fixed'; select: string[] }
  | { type: 'roller'; select: string[] }
  | { type: 'displacement'; select: string[]; component: number; value: number }
  | { type: 'traction'; select: string[]; t: number[] | VecFn }
  | { type: 'pressure'; select: string[]; p: number | ((x: Float64Array) => number) };   // traction = -p n (p > 0 pushes inward)

export interface ElasticProblem {
  mesh: Mesh; model: Model;
  E: Float64Array; nu: Float64Array;
  mask?: Uint8Array;
  /** body force per cell (dim components), N/m^3 */
  body?: Float64Array;
  /** thermal strain input: alpha per cell, nodal temperature, reference temperature */
  thermal?: { alpha: Float64Array; T: Float64Array; Tref: number };
  /** out-of-plane thickness for 2D reaction forces (m); stiffness is per unit thickness either way */
  thickness?: number;
  bcs: ElasticBc[];
  solver?: 'cholesky' | 'amg-pcg';
  spec?: unknown;
}

/** Elasticity matrix (Voigt: 2D [xx, yy, xy], 3D [xx, yy, zz, yz, xz, xy]) for E, nu. */
export function dMatrix(model: Model, E: number, nu: number): Float64Array {
  if (model === 'plane-stress') { const c = E / (1 - nu * nu); return Float64Array.from([c, c * nu, 0, c * nu, c, 0, 0, 0, (c * (1 - nu)) / 2]); }
  const lam = (E * nu) / ((1 + nu) * (1 - 2 * nu)), mu = E / (2 * (1 + nu));
  if (model === 'plane-strain') return Float64Array.from([lam + 2 * mu, lam, 0, lam, lam + 2 * mu, 0, 0, 0, mu]);
  const D = new Float64Array(36);
  for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) D[6 * i + j] = lam; D[6 * i + i] = lam + 2 * mu; D[6 * (i + 3) + i + 3] = mu; }
  return D;
}

/** Block pattern: node pattern expanded to bs x bs blocks (DOF = node * bs + component). */
export function blockPattern(p: Csr, bs: number): Csr {
  const n = p.n * bs, rowptr = new Int32Array(n + 1);
  for (let i = 0; i < p.n; i++) { const len = (p.rowptr[i + 1]! - p.rowptr[i]!) * bs; for (let c = 0; c < bs; c++) rowptr[i * bs + c + 1] = len; }
  for (let i = 0; i < n; i++) rowptr[i + 1]! += rowptr[i]!;
  const colidx = new Int32Array(rowptr[n]!);
  for (let i = 0; i < p.n; i++) for (let c = 0; c < bs; c++) {
    let z = rowptr[i * bs + c]!;
    for (let q = p.rowptr[i]!; q < p.rowptr[i + 1]!; q++) for (let d = 0; d < bs; d++) colidx[z++] = p.colidx[q]! * bs + d;
  }
  return { n, rowptr, colidx, nnz: rowptr[n]! };
}

const blockCache = new WeakMap<Csr, Map<number, Csr>>();
function blockPatternCached(p: Csr, bs: number): Csr {
  let m = blockCache.get(p);
  if (!m) { m = new Map(); blockCache.set(p, m); }
  let b = m.get(bs);
  if (!b) { b = blockPattern(p, bs); m.set(bs, b); }
  return b;
}

/** Strain-displacement rows: B (nv x k*dim, row-major) from physical gradients G (k x dim). */
function bMatrix(G: Float64Array, k: number, dim: number, B: Float64Array): void {
  B.fill(0);
  const nd = k * dim;
  if (dim === 2) {
    for (let a = 0; a < k; a++) {
      const gx = G[2 * a]!, gy = G[2 * a + 1]!;
      B[0 * nd + 2 * a] = gx; B[1 * nd + 2 * a + 1] = gy; B[2 * nd + 2 * a] = gy; B[2 * nd + 2 * a + 1] = gx;
    }
    return;
  }
  for (let a = 0; a < k; a++) {
    const gx = G[3 * a]!, gy = G[3 * a + 1]!, gz = G[3 * a + 2]!, c = 3 * a;
    B[0 * nd + c] = gx; B[1 * nd + c + 1] = gy; B[2 * nd + c + 2] = gz;
    B[3 * nd + c + 1] = gz; B[3 * nd + c + 2] = gy;
    B[4 * nd + c] = gz; B[4 * nd + c + 2] = gx;
    B[5 * nd + c] = gy; B[5 * nd + c + 1] = gx;
  }
}

/** Facet -> adjacent cell (first cell containing all facet corner nodes) and the outward unit normal helper. */
function facetCellMap(m: Mesh): Int32Array {
  const k = NPC[m.cells.type], kf = NPC[m.facets.type], nc = nCells(m), nf = m.facets.conn.length / kf;
  const corners = m.dim === 2 ? 2 : 3;
  const nodeCells = new Map<number, number[]>();
  for (let c = 0; c < nc; c++) for (let a = 0; a < (m.dim === 2 ? 3 : 4); a++) {
    const v = m.cells.conn[k * c + a]!;
    let l = nodeCells.get(v); if (!l) { l = []; nodeCells.set(v, l); } l.push(c);
  }
  const out = new Int32Array(nf).fill(-1);
  for (let f = 0; f < nf; f++) {
    const vs = Array.from({ length: corners }, (_, a) => m.facets.conn[kf * f + a]!);
    const cand = nodeCells.get(vs[0]!) ?? [];
    for (const c of cand) {
      const cn = new Set(Array.from({ length: k }, (_, a) => m.cells.conn[k * c + a]!));
      if (vs.every((v) => cn.has(v))) { out[f] = c; break; }
    }
  }
  return out;
}

export interface ElasticDetail { dof: number; reaction?: number[] }

export async function solveElastic(p: ElasticProblem): Promise<Solution & { detail: ElasticDetail; u: Float64Array }> {
  const timer = new StageTimer();
  const m = p.mesh, dim = m.dim, k = NPC[m.cells.type], nn = nNodes(m), nc = nCells(m);
  if ((dim === 3) !== (p.model === '3d')) throw new Error(`elastic: model ${p.model} on a ${dim}D mesh`);
  const nv = dim === 2 ? 3 : 6, nd = k * dim;
  const mask = p.mask ?? Uint8Array.from(p.E, (v) => (Number.isFinite(v) ? 1 : 0));
  const node = cellPattern(m);
  const pat = blockPatternCached(node, dim);
  const K = new Float64Array(pat.nnz), F = new Float64Array(nn * dim);
  const active = new Uint8Array(nn);
  timer.time('assemble', () => {
    const r = defaultRule(m.cells.type, 2 * cellOrder(m));
    const t = shapeTable(m.cells.type, r);
    const X = new Float64Array(nd), G = new Float64Array(nd), B = new Float64Array(nv * nd), DB = new Float64Array(nv * nd);
    const Ke = new Float64Array(nd * nd), Fe = new Float64Array(nd);
    const dofs = new Int32Array(nd);
    for (let e = 0; e < nc; e++) {
      if (!mask[e]) continue;
      const D = dMatrix(p.model, p.E[e]!, p.nu[e]!);
      gatherX(m.nodes, dim, m.cells.conn, e, k, X);
      Ke.fill(0); Fe.fill(0);
      for (let q = 0; q < r.n; q++) {
        const w = physGrad(t, q, X, dim, G) * r.wts[q]!;
        bMatrix(G, k, dim, B);
        for (let i = 0; i < nv; i++) for (let j = 0; j < nd; j++) { let s = 0; for (let l = 0; l < nv; l++) s += D[nv * i + l]! * B[l * nd + j]!; DB[i * nd + j] = s; }
        for (let a = 0; a < nd; a++) for (let b = a; b < nd; b++) { let s = 0; for (let l = 0; l < nv; l++) s += B[l * nd + a]! * DB[l * nd + b]!; Ke[a * nd + b]! += s * w; }
        if (p.body) for (let a = 0; a < k; a++) for (let d = 0; d < dim; d++) Fe[dim * a + d]! += p.body[dim * e + d]! * t.N[q * k + a]! * w;
        if (p.thermal) {
          let T = 0; for (let a = 0; a < k; a++) T += t.N[q * k + a]! * p.thermal.T[m.cells.conn[k * e + a]!]!;
          const al = p.thermal.alpha[e]!, nu = p.nu[e]!;
          const eth = al * (T - p.thermal.Tref) * (p.model === 'plane-strain' ? 1 + nu : 1);
          const ev = dim === 2 ? [eth, eth, 0] : [eth, eth, eth, 0, 0, 0];
          // F += B^T D eps_th
          for (let a = 0; a < nd; a++) { let s = 0; for (let l = 0; l < nv; l++) s += DB[l * nd + a]! * ev[l]!; Fe[a]! += s * w; }
        }
      }
      for (let a = 0; a < k; a++) { const v = m.cells.conn[k * e + a]!; active[v] = 1; for (let d = 0; d < dim; d++) dofs[dim * a + d] = dim * v + d; }
      for (let a = 0; a < nd; a++) {
        F[dofs[a]!]! += Fe[a]!;
        const row = dofs[a]!;
        for (let b = 0; b < nd; b++) {
          const col = dofs[b]!, v = a <= b ? Ke[a * nd + b]! : Ke[b * nd + a]!;
          let lo = pat.rowptr[row]!, hi = pat.rowptr[row + 1]! - 1;
          while (lo <= hi) { const mid = (lo + hi) >> 1, c = pat.colidx[mid]!; if (c === col) { K[mid]! += v; break; } if (c < col) lo = mid + 1; else hi = mid - 1; }
        }
      }
    }
    // boundary loads
    const fc = facetCellMap(m);
    const tf = facetTable(m, 2 * cellOrder(m) + 2);
    const kf = tf.nn;
    const Xf = new Float64Array(kf * dim), nrm = new Float64Array(dim), P = new Float64Array(dim), cen = new Float64Array(dim);
    for (const b of p.bcs) {
      if (b.type !== 'traction' && b.type !== 'pressure') continue;
      for (const f of facetsOn(m, b.select)) {
        gatherX(m.nodes, dim, m.facets.conn, f, kf, Xf);
        const c = fc[f]!;
        cen.fill(0);
        for (let a = 0; a < k; a++) for (let d = 0; d < dim; d++) cen[d]! += m.nodes[dim * m.cells.conn[k * c + a]! + d]! / k;
        for (let q = 0; q < tf.rule.n; q++) {
          const w = facetJac(tf, q, Xf, dim, nrm) * tf.rule.wts[q]!;
          P.fill(0);
          for (let a = 0; a < kf; a++) for (let d = 0; d < dim; d++) P[d]! += tf.N[q * kf + a]! * Xf[dim * a + d]!;
          let dot = 0; for (let d = 0; d < dim; d++) dot += nrm[d]! * (P[d]! - cen[d]!);
          if (dot < 0) for (let d = 0; d < dim; d++) nrm[d] = -nrm[d]!;
          const pv = b.type === 'pressure' ? (typeof b.p === 'number' ? b.p : b.p(P)) : 0;
          const tv = b.type === 'pressure' ? Array.from(nrm, (v) => -pv * v) : typeof b.t === 'function' ? b.t(P, nrm) : b.t;
          for (let a = 0; a < kf; a++) { const v = m.facets.conn[kf * f + a]!, Na = tf.N[q * kf + a]!; for (let d = 0; d < dim; d++) F[dim * v + d]! += tv[d]! * Na * w; }
        }
      }
    }
  });
  // constraints
  const fixed = new Uint8Array(nn * dim), uc = new Float64Array(nn * dim);
  for (let v = 0; v < nn; v++) if (!active[v]) for (let d = 0; d < dim; d++) fixed[dim * v + d] = 1;
  for (const b of p.bcs) {
    if (b.type === 'fixed') for (const v of facetNodes(m, facetsOn(m, b.select))) for (let d = 0; d < dim; d++) fixed[dim * v + d] = 1;
    else if (b.type === 'displacement') for (const v of facetNodes(m, facetsOn(m, b.select))) { fixed[dim * v + b.component] = 1; uc[dim * v + b.component] = b.value; }
    else if (b.type === 'roller') {
      const fs = facetsOn(m, b.select);
      // axis of the normal: all nodes share one coordinate
      const ns = facetNodes(m, fs);
      let axis = -1;
      for (let d = 0; d < dim; d++) {
        let lo = Infinity, hi = -Infinity;
        for (const v of ns) { const x = m.nodes[dim * v + d]!; lo = Math.min(lo, x); hi = Math.max(hi, x); }
        let span = 0; for (let e = 0; e < dim; e++) { let l = Infinity, h = -Infinity; for (const v of ns) { const x = m.nodes[dim * v + e]!; l = Math.min(l, x); h = Math.max(h, x); } span = Math.max(span, h - l); }
        if (hi - lo <= 1e-12 * span) axis = d;
      }
      if (axis < 0) throw new Error(`elastic: roller on ${b.select.join(', ')} needs a boundary normal to a coordinate axis`);
      for (const v of ns) fixed[dim * v + axis] = 1;
    }
  }
  const N = nn * dim, free = Uint8Array.from(fixed, (f) => (f ? 0 : 1));
  const R = timer.time('assemble', () => restrict(pat, K, free));
  const b = new Float64Array(R.pat.n);
  for (let i = 0; i < N; i++) {
    if (!free[i]) continue;
    let s = F[i]!;
    for (let z = pat.rowptr[i]!; z < pat.rowptr[i + 1]!; z++) { const c = pat.colidx[z]!; if (fixed[c]) s -= K[z]! * uc[c]!; }
    b[R.map[i]!] = s;
  }
  const S = new SpdSolver(R.pat, p.solver ?? 'cholesky');
  timer.time('factor', () => S.factor(R.val));
  const uf = timer.time('solve', () => S.solve(b));
  const u = new Float64Array(N);
  for (let i = 0; i < N; i++) u[i] = free[i] ? uf[R.map[i]!]! : uc[i]!;
  // stresses: nodal averages of element stresses evaluated at the element nodes
  const t0 = performance.now();
  const sig = nodalStress(p, u, mask);
  const nsc = dim === 2 ? 4 : 6;  // 2D: sxx syy sxy szz
  const mises = new Float64Array(nn), s1 = new Float64Array(nn), s2 = new Float64Array(nn), s3 = dim === 3 ? new Float64Array(nn) : null;
  for (let v = 0; v < nn; v++) {
    const s = sig.subarray(nsc * v, nsc * v + nsc);
    if (dim === 2) {
      const [xx, yy, xy, zz] = s as unknown as [number, number, number, number];
      mises[v] = Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * xy * xy);
      const c = 0.5 * (xx + yy), r = Math.hypot(0.5 * (xx - yy), xy);
      s1[v] = c + r; s2[v] = c - r;
    } else {
      const [xx, yy, zz, yz, xz, xy] = s as unknown as number[];
      mises[v] = Math.sqrt(0.5 * ((xx! - yy!) ** 2 + (yy! - zz!) ** 2 + (zz! - xx!) ** 2) + 3 * (yz! ** 2 + xz! ** 2 + xy! ** 2));
      const ev = symEig3(xx!, yy!, zz!, yz!, xz!, xy!);
      s1[v] = ev[0]!; s2[v] = ev[1]!; s3![v] = ev[2]!;
    }
  }
  const space: 'H1P1' | 'H1P2' = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
  const comp = (j: number) => Float64Array.from({ length: nn }, (_, v) => sig[nsc * v + j]!);
  const names = dim === 2 ? ['sxx', 'syy', 'sxy', 'szz'] : ['sxx', 'syy', 'szz', 'syz', 'sxz', 'sxy'];
  const fields: Solution['fields'] = [
    { name: 'u', unit: 'm', space, components: dim as 2 | 3, data: u },
    ...names.map((nm, j) => ({ name: nm, unit: 'Pa', space, components: 1 as const, data: comp(j) })),
    { name: 'mises', unit: 'Pa', space, components: 1, data: mises },
    { name: 's1', unit: 'Pa', space, components: 1, data: s1 },
    { name: 's2', unit: 'Pa', space, components: 1, data: s2 },
    ...(s3 ? [{ name: 's3', unit: 'Pa', space, components: 1 as const, data: s3 }] : []),
  ];
  let mmax = 0, umax = 0;
  for (let v = 0; v < nn; v++) if (active[v]) { mmax = Math.max(mmax, mises[v]!); let s = 0; for (let d = 0; d < dim; d++) s += u[dim * v + d]! ** 2; umax = Math.max(umax, Math.sqrt(s)); }
  timer.add('post', performance.now() - t0);
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { physics: 'elastic', model: p.model, bcs: p.bcs.map((x) => x.type), nn } }),
    fields, scalars: { mises_max: scalar(mmax, 'Pa'), u_max: scalar(umax, 'm') },
    stats: { dof: R.pat.n, nnz: R.pat.nnz, solver: S.kind, ...(S.kind === 'amg-pcg' ? { iterations: S.lastIterations, residual: S.lastResidual } : {}) },
    timer,
  });
  attachMesh(sol, m);
  return Object.assign(sol, { detail: { dof: R.pat.n }, u });
}

/** Reference coordinates of the nodes of a cell type (node order of common/mesh.ts). */
export function refNodes(type: string): number[][] {
  switch (type) {
    case 'tri3': return [[0, 0], [1, 0], [0, 1]];
    case 'tri6': return [[0, 0], [1, 0], [0, 1], [0.5, 0], [0.5, 0.5], [0, 0.5]];
    case 'tet4': return [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    case 'tet10': return [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0, 0.5], [0, 0.5, 0.5]];
    default: throw new Error(`refNodes: ${type}`);
  }
}

/** Stress (Voigt; 2D plus szz) at reference point `ref` of cell e. */
export function cellStress(p: ElasticProblem, u: Float64Array, e: number, ref: ArrayLike<number>, out: Float64Array): void {
  const m = p.mesh, dim = m.dim, k = NPC[m.cells.type], rd = REF_DIM[m.cells.type]!, nd = k * dim, nv = dim === 2 ? 3 : 6;
  const N = new Float64Array(k), dN = new Float64Array(k * rd);
  shape(m.cells.type, ref, N, dN);
  const X = new Float64Array(nd); gatherX(m.nodes, dim, m.cells.conn, e, k, X);
  // single-point table
  const t = { type: m.cells.type, nn: k, rd, rule: { dim: rd, n: 1, pts: Float64Array.from(ref), wts: Float64Array.of(1) }, N, dN };
  const G = new Float64Array(nd), B = new Float64Array(nv * nd);
  physGrad(t, 0, X, dim, G);
  bMatrix(G, k, dim, B);
  const eps = new Float64Array(nv);
  for (let i = 0; i < nv; i++) { let s = 0; for (let a = 0; a < k; a++) for (let d = 0; d < dim; d++) s += B[i * nd + dim * a + d]! * u[dim * m.cells.conn[k * e + a]! + d]!; eps[i] = s; }
  let dT = 0;
  if (p.thermal) { for (let a = 0; a < k; a++) dT += N[a]! * p.thermal.T[m.cells.conn[k * e + a]!]!; dT -= p.thermal.Tref; }
  const E = p.E[e]!, nu = p.nu[e]!, al = p.thermal ? p.thermal.alpha[e]! : 0;
  const eth = al * dT * (p.model === 'plane-strain' ? 1 + nu : 1);
  for (let i = 0; i < (dim === 2 ? 2 : 3); i++) eps[i]! -= eth;
  const D = dMatrix(p.model, E, nu);
  for (let i = 0; i < nv; i++) { let s = 0; for (let j = 0; j < nv; j++) s += D[nv * i + j]! * eps[j]!; out[i] = s; }
  if (dim === 2) out[3] = p.model === 'plane-strain' ? nu * (out[0]! + out[1]!) - E * al * dT : 0;
}

function nodalStress(p: ElasticProblem, u: Float64Array, mask: Uint8Array): Float64Array {
  const m = p.mesh, dim = m.dim, k = NPC[m.cells.type], nn = nNodes(m), nc = nCells(m);
  const nsc = dim === 2 ? 4 : 6;
  const acc = new Float64Array(nn * nsc), cnt = new Float64Array(nn);
  const rn = refNodes(m.cells.type), s = new Float64Array(nsc);
  for (let e = 0; e < nc; e++) {
    if (!mask[e]) continue;
    for (let a = 0; a < k; a++) {
      cellStress(p, u, e, rn[a]!, s);
      const v = m.cells.conn[k * e + a]!;
      for (let j = 0; j < nsc; j++) acc[nsc * v + j]! += s[j]!;
      cnt[v]!++;
    }
  }
  for (let v = 0; v < nn; v++) if (cnt[v]) for (let j = 0; j < nsc; j++) acc[nsc * v + j]! /= cnt[v]!;
  return acc;
}

/** Eigenvalues (descending) of a symmetric 3x3 tensor (closed form, trigonometric). */
export function symEig3(xx: number, yy: number, zz: number, yz: number, xz: number, xy: number): number[] {
  const p1 = xy * xy + xz * xz + yz * yz;
  const qm = (xx + yy + zz) / 3;
  if (p1 <= 1e-30 * (qm * qm + 1e-300)) return [xx, yy, zz].sort((a, b) => b - a);
  const p2 = (xx - qm) ** 2 + (yy - qm) ** 2 + (zz - qm) ** 2 + 2 * p1;
  const pp = Math.sqrt(p2 / 6);
  const b = [(xx - qm) / pp, xy / pp, xz / pp, xy / pp, (yy - qm) / pp, yz / pp, xz / pp, yz / pp, (zz - qm) / pp];
  const det = b[0]! * (b[4]! * b[8]! - b[5]! * b[7]!) - b[1]! * (b[3]! * b[8]! - b[5]! * b[6]!) + b[2]! * (b[3]! * b[7]! - b[4]! * b[6]!);
  const r = Math.max(-1, Math.min(1, det / 2));
  const phi = Math.acos(r) / 3;
  const e1 = qm + 2 * pp * Math.cos(phi), e3 = qm + 2 * pp * Math.cos(phi + (2 * Math.PI) / 3);
  return [e1, 3 * qm - e1 - e3, e3];
}

/** Relative L2 error of the element stresses (in-plane Voigt components) against an exact field, by quadrature. */
export function stressErrorL2(p: ElasticProblem, u: Float64Array, exact: (x: Float64Array) => number[]): number {
  const m = p.mesh, dim = m.dim, k = NPC[m.cells.type], nc = nCells(m), nv = dim === 2 ? 3 : 6;
  const r = defaultRule(m.cells.type, 2 * cellOrder(m) + 2), t = shapeTable(m.cells.type, r);
  const X = new Float64Array(k * dim), G = new Float64Array(k * dim), P = new Float64Array(dim), s = new Float64Array(nv + 1);
  const mask = p.mask ?? Uint8Array.from(p.E, (v) => (Number.isFinite(v) ? 1 : 0));
  let num = 0, den = 0;
  for (let e = 0; e < nc; e++) {
    if (!mask[e]) continue;
    gatherX(m.nodes, dim, m.cells.conn, e, k, X);
    for (let q = 0; q < r.n; q++) {
      const w = physGrad(t, q, X, dim, G) * r.wts[q]!;
      P.fill(0); for (let a = 0; a < k; a++) for (let d = 0; d < dim; d++) P[d]! += t.N[q * k + a]! * X[dim * a + d]!;
      cellStress(p, u, e, r.pts.subarray(dim * q, dim * q + dim), s);
      const ex = exact(P);
      for (let i = 0; i < nv; i++) { const wgt = i >= dim ? 2 : 1; num += wgt * (s[i]! - ex[i]!) ** 2 * w; den += wgt * ex[i]! ** 2 * w; }
    }
  }
  return Math.sqrt(num / den);
}

// ------------------------------------------------------------------------------------------------- spec binding

export function elasticProblemFromContext(ctx: RunContext): ElasticProblem {
  const spec = ctx.spec as Spec, m = ctx.mesh;
  const ph = physicsNode(spec, ctx.physicsId) as { settings?: { model?: Model; thickness?: unknown } };
  const model = ph.settings?.model ?? (m.dim === 3 ? '3d' : undefined);
  if (!model) throw new Error('elastic: settings.model (plane-stress | plane-strain) required in 2D');
  const { mask, values } = cellProps(ctx, ['E', 'nu']);
  const sp = spaceOf(m);
  const bcs: ElasticBc[] = [];
  for (const b of bcsOf(spec, ctx.physicsId)) {
    const s = b.settings ?? {};
    switch (b.type) {
      case 'fixed': bcs.push({ type: 'fixed', select: b.select }); break;
      case 'roller': bcs.push({ type: 'roller', select: b.select }); break;
      case 'free': break;
      case 'boundary-load': {
        // vector of field components ({value: [..], unit} or a list of field settings), static: t = 0
        const tr = s.traction as unknown;
        const comps = Array.isArray(tr) ? tr : tr && typeof tr === 'object' && Array.isArray((tr as { value: unknown[] }).value)
          ? (tr as { value: number[]; unit: string }).value.map((v) => ({ value: v, unit: (tr as { unit: string }).unit })) : null;
        if (!comps) throw new Error(`${b.id}.traction: expected a vector`);
        const fs = comps.map((c, i) => compileField(spec, c, sp, `${b.id}.traction[${i}]`, 'space'));
        bcs.push({ type: 'traction', select: b.select, t: fs.every((v) => typeof v === 'number') ? (fs as number[]) : (x) => fs.map((f) => evalField(f, x)) });
        break;
      }
      case 'pressure': { const pf = compileField(spec, s.p, sp, `${b.id}.p`, 'space'); bcs.push({ type: 'pressure', select: b.select, p: typeof pf === 'number' ? pf : (x) => pf(x, 0) }); break; }
      default: throw new Error(`elastic: unsupported condition '${b.type}'`);
    }
  }
  void optionalCellProp;
  return { mesh: m, model, E: values.E!, nu: values.nu!, mask, bcs, spec };
}

export const elasticModule: PhysicsModule = {
  type: 'elastic',
  dims: ['2d', '3d'],
  readiness(spec, physicsId) {
    const reasons: string[] = [];
    try {
      const ph = physicsNode(spec as Spec, physicsId);
      const ok = new Set(['fixed', 'roller', 'free', 'boundary-load', 'pressure']);
      for (const b of ph.bcs ?? []) if (!ok.has(b.type)) reasons.push(`unsupported condition '${b.type}'`);
    } catch (e) { reasons.push((e as Error).message); }
    return { ready: !reasons.length, reasons };
  },
  async run(ctx) { return solveElastic(elasticProblemFromContext(ctx)); },
};
