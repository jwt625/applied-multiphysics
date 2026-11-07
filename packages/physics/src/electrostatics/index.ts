// SPDX-License-Identifier: GPL-3.0-or-later
// Electrostatics (C4 type 'electrostatics'), 2D (per unit length) and 2D axisymmetric (full 3D body of revolution):
//   -div(eps0 eps_r grad V) = rho_v,  V fixed on potential / ground boundaries, zero normal D elsewhere (natural).
// Terminals: boundaries of conductors; the Maxwell capacitance matrix C_ij = int eps grad V_i . grad V_j dV with
// V_i = 1 on terminal i and 0 on the others and on ground (energy form, symmetric by construction); dV = 2 pi r dr dz
// in axisymmetry, per unit length in 2D. For a 2D two-conductor line, C'_0 (all eps_r = 1) gives the TEM
// L' = mu0 eps0 / C'_0 and Z0 = sqrt(L' / C').

import type { Mesh, PhysicsModule, RunContext, Solution, Spec } from '@amp/spec/types';
import { facetNodes, facetsOn, nCells, nNodes, cellMask } from '../common/mesh.ts';
import { assembleCells, matVec, restrict, SpdSolver, cellOrder } from '../common/scalar.ts';
import { makeSolution, StageTimer, scalar } from '../common/solution.ts';
import { attachMesh } from '../common/solution.ts';
import { bcsOf, cellProps, physicsNode } from '../common/ctx.ts';
import { compileField, spaceOf } from '../common/field.ts';

/** Vacuum permittivity, F/m (CODATA 2018). */
export const EPS0 = 8.8541878128e-12;
/** Vacuum permeability, H/m (CODATA 2018). */
export const MU0 = 1.25663706212e-6;

export interface ElectrostaticsProblem {
  mesh: Mesh;
  epsR: Float64Array;           // per cell (NaN = not in the domain)
  mask?: Uint8Array;
  /** terminal boundary selections, in matrix order */
  terminals: Array<{ id: string; select: string[] }>;
  ground?: string[];
  /** fixed potentials (in addition to terminals / ground) */
  potentials?: Array<{ select: string[]; V: number | ((x: ArrayLike<number>) => number) }>;
  /** also compute the vacuum capacitance (2D TEM lines: L', Z0) */
  vacuum?: boolean;
  solver?: 'cholesky' | 'amg-pcg';
  spec?: unknown;
}

export async function solveElectrostatics(p: ElectrostaticsProblem): Promise<Solution & { C: Float64Array; C0?: Float64Array }> {
  const timer = new StageTimer();
  const m = p.mesh, n = nNodes(m), axi = !!m.axisym;
  const mask = p.mask ?? Uint8Array.from(p.epsR, (v) => (Number.isFinite(v) ? 1 : 0));
  const eps = Float64Array.from(p.epsR, (v, c) => (mask[c] ? EPS0 * v : 0));
  const A = timer.time('assemble', () => assembleCells(m, { k: eps, mask, weight: axi ? 'r' : 'none' }));
  const fac = axi ? 2 * Math.PI : 1;
  const termNodes = p.terminals.map((t) => facetNodes(m, facetsOn(m, t.select)));
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!A.active[i]) fixed[i] = 1;
  const ground = p.ground?.length ? facetNodes(m, facetsOn(m, p.ground)) : new Int32Array(0);
  for (const v of ground) fixed[v] = 1;
  for (const t of termNodes) for (const v of t) fixed[v] = 1;
  const pots = (p.potentials ?? []).map((x) => ({ nodes: facetNodes(m, facetsOn(m, x.select)), V: x.V }));
  for (const x of pots) for (const v of x.nodes) fixed[v] = 1;
  const free = Uint8Array.from(fixed, (f) => (f ? 0 : 1));
  const R = timer.time('assemble', () => restrict(A.pat, A.K!, free));
  const S = new SpdSolver(R.pat, p.solver ?? 'cholesky');
  timer.time('factor', () => S.factor(R.val));
  const nt = p.terminals.length;
  const solveFor = (K: Float64Array, Sv: SpdSolver, term: number): Float64Array => {
    const uc = new Float64Array(n);
    if (term >= 0) for (const v of termNodes[term]!) uc[v] = 1;
    else for (const x of pots) for (const v of x.nodes) uc[v] = typeof x.V === 'number' ? x.V : x.V(m.nodes.subarray(m.dim * v, m.dim * v + m.dim));
    const b = new Float64Array(R.pat.n);
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue;
      let s = 0;
      for (let z = A.pat.rowptr[i]!; z < A.pat.rowptr[i + 1]!; z++) { const c = A.pat.colidx[z]!; if (fixed[c]) s -= K[z]! * uc[c]!; }
      b[R.map[i]!] = s;
    }
    const x = timer.time('solve', () => Sv.solve(b));
    const u = uc.slice();
    for (let i = 0; i < n; i++) if (free[i]) u[i] = x[R.map[i]!]!;
    return u;
  };
  // terminal solves (other terminals, ground and potential boundaries at 0), then the applied-potential case (audit M1)
  const Vs = Array.from({ length: nt + (pots.length ? 1 : 0) }, (_, i) => solveFor(A.K!, S, i < nt ? i : -1));
  const capMatrix = (K: Float64Array, V: Float64Array[]) => {
    const C = new Float64Array(nt * nt), KV = new Float64Array(n);
    for (let j = 0; j < nt; j++) {
      matVec(A.pat, K, V[j]!, KV);
      for (let i = 0; i < nt; i++) { let s = 0; for (let q = 0; q < n; q++) s += V[i]![q]! * KV[q]!; C[i * nt + j] = fac * s; }
    }
    return C;
  };
  const t0 = performance.now();
  const C = capMatrix(A.K!, Vs);
  timer.add('post', performance.now() - t0);
  let C0: Float64Array | undefined;
  const scalars: Solution['scalars'] = {};
  const unit = axi ? 'F' : 'F/m';
  for (let i = 0; i < nt; i++) for (let j = 0; j < nt; j++) scalars[`C_${p.terminals[i]!.id}_${p.terminals[j]!.id}`] = scalar(C[i * nt + j]!, unit);
  if (p.vacuum) {
    const A0 = timer.time('assemble', () => assembleCells(m, { k: Float64Array.from(mask, (v) => (v ? EPS0 : 0)), mask, weight: axi ? 'r' : 'none' }));
    const R0 = restrict(A0.pat, A0.K!, free);
    const S0 = new SpdSolver(R0.pat, p.solver ?? 'cholesky');
    timer.time('factor', () => S0.factor(R0.val));
    const V0 = Array.from({ length: nt }, (_, i) => solveFor(A0.K!, S0, i));
    C0 = capMatrix(A0.K!, V0);
    if (!axi && nt === 1) {
      const Lp = (MU0 * EPS0) / C0[0]!;
      scalars["C_per_m"] = scalar(C[0]!, 'F/m');
      scalars["L_per_m"] = scalar(Lp, 'H/m');
      scalars["Z0"] = scalar(Math.sqrt(Lp / C[0]!), 'Ohm');
    }
  }
  const space: 'H1P1' | 'H1P2' = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
  const fields: Solution['fields'] = Vs.map((V, i) => ({ name: i < nt ? 'V' : 'V_applied', unit: 'V', space, components: 1 as const, data: V, ...(i < nt ? { step: i } : {}) }));
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { physics: 'electrostatics', terminals: p.terminals.map((t) => t.id), n } }),
    fields, ...(nt > 1 ? { steps: { kind: 'param' as const, values: Float64Array.from({ length: nt }, (_, i) => i), unit: '1' } } : {}),
    scalars, stats: { dof: R.pat.n, nnz: R.pat.nnz, solver: S.kind }, timer,
  });
  attachMesh(sol, m);
  return Object.assign(sol, { C, ...(C0 ? { C0 } : {}) });
}

export function electrostaticsProblemFromContext(ctx: RunContext): ElectrostaticsProblem {
  const spec = ctx.spec as Spec;
  const { mask, values } = cellProps(ctx, ['eps_r']);
  const terminals: ElectrostaticsProblem['terminals'] = [], ground: string[] = [], potentials: NonNullable<ElectrostaticsProblem['potentials']> = [];
  let rho = false;
  for (const b of bcsOf(spec, ctx.physicsId)) {
    if (b.type === 'terminal') terminals.push({ id: b.id, select: b.select });
    else if (b.type === 'ground') ground.push(...b.select);
    else if (b.type === 'potential') { const f = compileField(spec, (b.settings ?? {}).V, spaceOf(ctx.mesh), `${b.id}.V`, 'space'); potentials.push({ select: b.select, V: typeof f === 'number' ? f : (x) => f(x, 0) }); }
    else if (b.type === 'zero-charge') continue;
    else if (b.type === 'space-charge') rho = true;
    else throw new Error(`electrostatics: unsupported condition '${b.type}'`);
  }
  if (rho) throw new Error('electrostatics: space charge is not implemented in wave 1');
  void cellMask;
  return { mesh: ctx.mesh, epsR: values.eps_r!, mask, terminals, ground, potentials, vacuum: ctx.mesh.dim === 2 && !ctx.mesh.axisym && terminals.length === 1, spec };
}

export const electrostaticsModule: PhysicsModule = {
  type: 'electrostatics',
  dims: ['2d', '2d-axisym'],
  readiness(spec, physicsId) {
    const reasons: string[] = [];
    try {
      const ph = physicsNode(spec as Spec, physicsId);
      const ok = new Set(['terminal', 'ground', 'potential', 'zero-charge']);
      for (const b of ph.bcs ?? []) if (!ok.has(b.type)) reasons.push(`unsupported condition '${b.type}'`);
      if (!(ph.bcs ?? []).some((b) => b.type === 'terminal' || b.type === 'potential')) reasons.push('no terminal or potential condition');
    } catch (e) { reasons.push((e as Error).message); }
    return { ready: !reasons.length, reasons };
  },
  async run(ctx) { return solveElectrostatics(electrostaticsProblemFromContext(ctx)); },
};

void nCells;
