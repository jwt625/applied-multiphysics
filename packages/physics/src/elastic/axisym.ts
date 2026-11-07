// SPDX-License-Identifier: GPL-3.0-or-later
// Axisymmetric linear elasticity (C4 type 'elastic', model 'axisym'; lane MT, DevLog-033): small strain, isotropic,
// meridional (r, z) mesh with x = r, y = z, torsion-free (u = (u_r, u_z), azimuthal order 0). Strains
// [e_rr, e_zz, e_phiphi = u_r / r, g_rz]; integrals carry the weight r (per radian; the factor 2 pi cancels).
// Loads: traction / pressure on meridional boundaries (per radian), body force; thermal strain alpha (T - Tref) in
// rr, zz and phiphi (coupling input `thermal`, as for the planar models). Constraints: fixed, roller, displacement;
// nodes on the axis r = 0 get u_r = 0. Derived: srr, szz, srz, sphi (nodal averages of element values at the
// element nodes), von Mises, principal stresses s1 >= s2 >= s3.

import type { Solution } from '@amp/spec/types';
import { NPC, nCells, nNodes } from '../common/mesh.ts';
import { cellOrder, restrict, SpdSolver } from '../common/scalar.ts';
import { gatherX, physGrad, shape } from '../common/lagrange.ts';
import { makeSolution, StageTimer, scalar, attachMesh } from '../common/solution.ts';
import { dofPattern, isoD, solidConstraints, solidLoads, strainB, type SolidBc } from '../coupled/assemble.ts';
import { assembleSolid, solidDofMap } from './modal.ts';
import type { ElasticProblem } from './index.ts';

const REF: Record<string, number[][]> = {
  tri3: [[0, 0], [1, 0], [0, 1]],
  tri6: [[0, 0], [1, 0], [0, 1], [0.5, 0], [0.5, 0.5], [0, 0.5]],
};

/** Stress [srr, szz, sphi, srz] at reference point `ref` of cell e (thermal strain subtracted). */
export function axisymCellStress(p: ElasticProblem, u: Float64Array, e: number, ref: ArrayLike<number>, out: Float64Array): void {
  const m = p.mesh, k = NPC[m.cells.type], nd = 2 * k;
  const N = new Float64Array(k), dN = new Float64Array(2 * k);
  shape(m.cells.type, ref, N, dN);
  const X = new Float64Array(nd); gatherX(m.nodes, 2, m.cells.conn, e, k, X);
  const t = { type: m.cells.type, nn: k, rd: 2, rule: { dim: 2, n: 1, pts: Float64Array.from(ref), wts: Float64Array.of(1) }, N, dN };
  const G = new Float64Array(nd), B = new Float64Array(4 * nd);
  physGrad(t, 0, X, 2, G);
  let r = 0; for (let a = 0; a < k; a++) r += N[a]! * X[2 * a]!;
  strainB('axisym', G, N, r, k, B);
  const eps = new Float64Array(4);
  for (let i = 0; i < 4; i++) { let s = 0; for (let a = 0; a < k; a++) for (let d = 0; d < 2; d++) s += B[i * nd + 2 * a + d]! * u[2 * m.cells.conn[k * e + a]! + d]!; eps[i] = s; }
  if (p.thermal) {
    let T = 0; for (let a = 0; a < k; a++) T += N[a]! * p.thermal.T[m.cells.conn[k * e + a]!]!;
    const eth = p.thermal.alpha[e]! * (T - p.thermal.Tref);
    for (let i = 0; i < 3; i++) eps[i]! -= eth;
  }
  const D = isoD('axisym', p.E[e]!, p.nu[e]!);
  for (let i = 0; i < 4; i++) { let s = 0; for (let j = 0; j < 4; j++) s += D[4 * i + j]! * eps[j]!; out[i] = s; }
}

export async function solveElasticAxisym(p: ElasticProblem): Promise<Solution & { detail: { dof: number }; u: Float64Array }> {
  const timer = new StageTimer();
  const m = p.mesh, nn = nNodes(m), nc = nCells(m), k = NPC[m.cells.type];
  if (m.dim !== 2 || !m.axisym) throw new Error('elastic axisym: needs a 2D axisymmetric (r, z) mesh');
  if (m.cells.type !== 'tri3' && m.cells.type !== 'tri6') throw new Error(`elastic axisym: cell type ${m.cells.type} not supported (tri3 / tri6)`);
  const mask = p.mask ?? Uint8Array.from(p.E, (v) => (Number.isFinite(v) ? 1 : 0));
  const { dm, active } = timer.time('assemble', () => solidDofMap(m, mask));
  const pat = timer.time('assemble', () => dofPattern(m, dm));
  const K = new Float64Array(pat.nnz), F = new Float64Array(nn * 2);
  timer.time('assemble', () => {
    assembleSolid({
      mesh: m, model: 'axisym', mask, D: (e) => isoD('axisym', p.E[e]!, p.nu[e]!), uDof: dm.map, pat, K, F,
      ...(p.body ? { body: p.body } : {}),
      ...(p.thermal ? { thermal: { eps: (e: number, dT: number) => { const v = p.thermal!.alpha[e]! * dT; return Float64Array.of(v, v, v, 0); }, T: p.thermal.T, Tref: p.thermal.Tref } } : {}),
    });
    solidLoads(m, 'axisym', p.bcs as SolidBc[], F, mask);
  });
  const { fixed, value } = solidConstraints(m, 'axisym', p.bcs as Parameters<typeof solidConstraints>[2]);
  const N = nn * 2, free = new Uint8Array(N);
  for (let v = 0; v < nn; v++) if (active[v]) for (let d = 0; d < 2; d++) free[2 * v + d] = fixed[2 * v + d] ? 0 : 1;
  const R = timer.time('assemble', () => restrict(pat, K, free));
  const b = new Float64Array(R.pat.n);
  for (let i = 0; i < N; i++) {
    if (!free[i]) continue;
    let s = F[i]!;
    for (let z = pat.rowptr[i]!; z < pat.rowptr[i + 1]!; z++) { const c = pat.colidx[z]!; if (!free[c]) s -= K[z]! * value[c]!; }
    b[R.map[i]!] = s;
  }
  const S = new SpdSolver(R.pat, p.solver ?? 'cholesky');
  timer.time('factor', () => S.factor(R.val));
  const uf = timer.time('solve', () => S.solve(b));
  const u = new Float64Array(N);
  for (let i = 0; i < N; i++) u[i] = free[i] ? uf[R.map[i]!]! : active[i >> 1] ? value[i]! : 0;
  const t0 = performance.now();
  // nodal stresses: average of the element values at the element nodes
  const acc = new Float64Array(nn * 4), cnt = new Float64Array(nn), s = new Float64Array(4), ref = REF[m.cells.type]!;
  for (let e = 0; e < nc; e++) {
    if (!mask[e]) continue;
    for (let a = 0; a < k; a++) {
      axisymCellStress(p, u, e, ref[a]!, s);
      const v = m.cells.conn[k * e + a]!;
      for (let j = 0; j < 4; j++) acc[4 * v + j]! += s[j]!;
      cnt[v]!++;
    }
  }
  for (let v = 0; v < nn; v++) if (cnt[v]) for (let j = 0; j < 4; j++) acc[4 * v + j]! /= cnt[v]!;
  const comp = (j: number) => Float64Array.from({ length: nn }, (_, v) => acc[4 * v + j]!);
  const mises = new Float64Array(nn), s1 = new Float64Array(nn), s2 = new Float64Array(nn), s3 = new Float64Array(nn);
  let mmax = 0, umax = 0;
  for (let v = 0; v < nn; v++) {
    const rr = acc[4 * v]!, zz = acc[4 * v + 1]!, pp = acc[4 * v + 2]!, rz = acc[4 * v + 3]!;
    mises[v] = Math.sqrt(0.5 * ((rr - zz) ** 2 + (zz - pp) ** 2 + (pp - rr) ** 2) + 3 * rz * rz);
    const c = 0.5 * (rr + zz), h = Math.hypot(0.5 * (rr - zz), rz);
    const ps = [c + h, c - h, pp].sort((x, y) => y - x);
    s1[v] = ps[0]!; s2[v] = ps[1]!; s3[v] = ps[2]!;
    if (active[v]) { mmax = Math.max(mmax, mises[v]!); umax = Math.max(umax, Math.hypot(u[2 * v]!, u[2 * v + 1]!)); }
  }
  timer.add('post', performance.now() - t0);
  const space: 'H1P1' | 'H1P2' = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
  const fields: Solution['fields'] = [
    { name: 'u', unit: 'm', space, components: 2, data: u },
    ...(['srr', 'szz', 'sphi', 'srz'] as const).map((nm, j) => ({ name: nm, unit: 'Pa', space, components: 1 as const, data: comp(j) })),
    { name: 'mises', unit: 'Pa', space, components: 1, data: mises },
    { name: 's1', unit: 'Pa', space, components: 1, data: s1 },
    { name: 's2', unit: 'Pa', space, components: 1, data: s2 },
    { name: 's3', unit: 'Pa', space, components: 1, data: s3 },
  ];
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { physics: 'elastic', model: 'axisym', bcs: p.bcs.map((x) => x.type), nn } }),
    fields, scalars: { mises_max: scalar(mmax, 'Pa'), u_max: scalar(umax, 'm') },
    stats: { dof: R.pat.n, nnz: R.pat.nnz, solver: S.kind, ...(S.kind === 'amg-pcg' ? { iterations: S.lastIterations, residual: S.lastResidual } : {}) },
    timer,
  });
  attachMesh(sol, m);
  return Object.assign(sol, { detail: { dof: R.pat.n }, u });
}
