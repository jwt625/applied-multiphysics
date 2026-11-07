// SPDX-License-Identifier: GPL-3.0-or-later
// Axisymmetric magnetostatics (C4 type 'magnetostatics', dims '2d-axisym'): A = A_phi(r, z) phi_hat,
//   B_r = -dA/dz,  B_z = (1/r) d(r A)/dr = dA/dr + A/r,
// weak form (energy): int (1/mu) [dA/dz dw/dz + (dA/dr + A/r)(dw/dr + w/r)] r dr dz = int J_phi w r dr dz
// (the common 2 pi cancels). The A/r terms are evaluated at quadrature points only (r > 0 there); A = 0 on the axis
// (Dirichlet) and on magnetic-insulation boundaries (n x A = 0). Coils: homogenised J_phi = turns * I / area per coil
// domain. Far boundary: a large air domain (half disk R_b) with A = 0; the truncation shift of the central field of a
// current-loop system is -1.398 (R / R_b)^3 for the Helmholtz pair (dipole image, eval/expected/EM-04.json), so the
// gates use R_b >= 100 R (shift <= 1.4e-6). Inductance matrix from the flux linkage L_ij = int A_j J_i dV / (I_i I_j).
// Nodal B fields are averages of element values at the nodes (on the axis, A/r -> dA/dr).

import type { Mesh, PhysicsModule, RunContext, Solution, Spec } from '@amp/spec/types';
import { NPC, cellMask, facetNodes, facetsOn, nCells, nNodes } from '../common/mesh.ts';
import { cellPattern, restrict, SpdSolver, cellOrder, matVec } from '../common/scalar.ts';
import { defaultRule, gatherX, physGrad, shapeTable, shape, REF_DIM } from '../common/lagrange.ts';
import { elementSlots } from '@amp/core/la/sparse';
import { makeSolution, StageTimer, scalar } from '../common/solution.ts';
import { attachMesh } from '@amp/post';
import { bcsOf, cellProps, physicsNode, q as qty } from '../common/ctx.ts';
import { MU0 } from '../electrostatics/index.ts';
import { refNodes } from '../elastic/index.ts';

export interface Coil { id: string; select: string[]; turns: number; current: number }
export interface MagnetostaticsProblem {
  mesh: Mesh;                 // axisym (r, z) mesh, r = x >= 0
  muR: Float64Array;          // per cell
  mask?: Uint8Array;
  coils: Coil[];
  /** n x A = 0 boundaries (outer truncation); the axis r = 0 is always A = 0 */
  insulation: string[];
  /** solve each coil separately and return the inductance matrix (default: coils driven together) */
  inductance?: boolean;
  solver?: 'cholesky' | 'amg-pcg';
  spec?: unknown;
}

function assemble(m: Mesh, nu: Float64Array, mask: Uint8Array) {
  const k = NPC[m.cells.type], nc = nCells(m);
  const pat = cellPattern(m);
  const slots = elementSlots(pat, m.cells.conn, k) as Int32Array;
  const r = defaultRule(m.cells.type, 2 * cellOrder(m) + 2);
  const t = shapeTable(m.cells.type, r);
  const K = new Float64Array(pat.nnz);
  const X = new Float64Array(2 * k), G = new Float64Array(2 * k), Ke = new Float64Array(k * k);
  const active = new Uint8Array(nNodes(m));
  for (let e = 0; e < nc; e++) {
    if (!mask[e]) continue;
    gatherX(m.nodes, 2, m.cells.conn, e, k, X);
    Ke.fill(0);
    for (let q = 0; q < r.n; q++) {
      const det = physGrad(t, q, X, 2, G);
      let rr = 0; for (let a = 0; a < k; a++) rr += t.N[q * k + a]! * X[2 * a]!;
      const w = det * r.wts[q]! * rr * nu[e]!;
      for (let a = 0; a < k; a++) {
        const ca = G[2 * a]! + t.N[q * k + a]! / rr, za = G[2 * a + 1]!;
        for (let b = 0; b < k; b++) Ke[k * a + b]! += (za * G[2 * b + 1]! + ca * (G[2 * b]! + t.N[q * k + b]! / rr)) * w;
      }
    }
    for (let a = 0; a < k; a++) { active[m.cells.conn[k * e + a]!] = 1; for (let b = 0; b < k; b++) K[slots[k * k * e + k * a + b]!]! += Ke[k * a + b]!; }
  }
  return { pat, K, active };
}

/** Load vector int J w r dr dz for J = 1 on the cells of `cm`, and the cross-section area of those cells. */
function unitLoad(m: Mesh, cm: Uint8Array): { F: Float64Array; area: number } {
  const k = NPC[m.cells.type], nc = nCells(m);
  const r = defaultRule(m.cells.type, 2 * cellOrder(m) + 1), t = shapeTable(m.cells.type, r);
  const X = new Float64Array(2 * k), G = new Float64Array(2 * k), F = new Float64Array(nNodes(m));
  let area = 0;
  for (let e = 0; e < nc; e++) {
    if (!cm[e]) continue;
    gatherX(m.nodes, 2, m.cells.conn, e, k, X);
    for (let q = 0; q < r.n; q++) {
      const w = physGrad(t, q, X, 2, G) * r.wts[q]!;
      let rr = 0; for (let a = 0; a < k; a++) rr += t.N[q * k + a]! * X[2 * a]!;
      area += w;
      for (let a = 0; a < k; a++) F[m.cells.conn[k * e + a]!]! += t.N[q * k + a]! * rr * w;
    }
  }
  return { F, area };
}

/** Nodal B_r, B_z (averages of element values at the element nodes). */
export function nodalB(m: Mesh, A: Float64Array, mask: Uint8Array): { Br: Float64Array; Bz: Float64Array } {
  const k = NPC[m.cells.type], nc = nCells(m), nn = nNodes(m), rd = REF_DIM[m.cells.type]!;
  const Br = new Float64Array(nn), Bz = new Float64Array(nn), cnt = new Float64Array(nn);
  const rn = refNodes(m.cells.type);
  const N = new Float64Array(k), dN = new Float64Array(k * rd), X = new Float64Array(2 * k), G = new Float64Array(2 * k);
  for (let e = 0; e < nc; e++) {
    if (!mask[e]) continue;
    gatherX(m.nodes, 2, m.cells.conn, e, k, X);
    for (let a = 0; a < k; a++) {
      shape(m.cells.type, rn[a]!, N, dN);
      physGrad({ type: m.cells.type, nn: k, rd, rule: { dim: 2, n: 1, pts: Float64Array.from(rn[a]!), wts: Float64Array.of(1) }, N, dN }, 0, X, 2, G);
      let dAr = 0, dAz = 0;
      for (let b = 0; b < k; b++) { const v = A[m.cells.conn[k * e + b]!]!; dAr += G[2 * b]! * v; dAz += G[2 * b + 1]! * v; }
      const node = m.cells.conn[k * e + a]!, rr = X[2 * a]!;
      const aOverR = rr !== 0 ? A[node]! / rr : dAr;   // on the axis A ~ c r: A / r -> dA/dr
      Br[node]! += -dAz; Bz[node]! += dAr + aOverR; cnt[node]!++;
    }
  }
  for (let v = 0; v < nn; v++) if (cnt[v]) { Br[v]! /= cnt[v]!; Bz[v]! /= cnt[v]!; }
  return { Br, Bz };
}

export async function solveMagnetostatics(p: MagnetostaticsProblem): Promise<Solution & { A: Float64Array; L?: Float64Array }> {
  const timer = new StageTimer();
  const m = p.mesh, n = nNodes(m);
  if (!m.axisym) throw new Error('magnetostatics: wave 1 supports axisymmetric (r, z) meshes only');
  const mask = p.mask ?? Uint8Array.from(p.muR, (v) => (Number.isFinite(v) ? 1 : 0));
  const nu = Float64Array.from(p.muR, (v, c) => (mask[c] ? 1 / (MU0 * v) : 0));
  const S0 = timer.time('assemble', () => assemble(m, nu, mask));
  const loads = timer.time('assemble', () => p.coils.map((c) => { const u = unitLoad(m, cellMask(m, c.select)); return { ...u, J: (c.turns * c.current) / u.area }; }));
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!S0.active[i]) fixed[i] = 1;
  // axis nodes: r == 0 exactly (geometry places the axis at r = 0)
  for (let i = 0; i < n; i++) if (m.nodes[2 * i] === 0) fixed[i] = 1;
  for (const v of facetNodes(m, facetsOn(m, p.insulation))) fixed[v] = 1;
  const free = Uint8Array.from(fixed, (f) => (f ? 0 : 1));
  const R = timer.time('assemble', () => restrict(S0.pat, S0.K, free));
  const S = new SpdSolver(R.pat, p.solver ?? 'cholesky');
  timer.time('factor', () => S.factor(R.val));
  const solveF = (F: Float64Array) => {
    const b = new Float64Array(R.pat.n);
    for (let i = 0; i < n; i++) if (free[i]) b[R.map[i]!] = F[i]!;
    const x = timer.time('solve', () => S.solve(b));
    const A = new Float64Array(n);
    for (let i = 0; i < n; i++) if (free[i]) A[i] = x[R.map[i]!]!;
    return A;
  };
  const Ftot = new Float64Array(n);
  for (const l of loads) for (let i = 0; i < n; i++) Ftot[i]! += l.J * l.F[i]!;
  const A = solveF(Ftot);
  const scalars: Solution['scalars'] = {};
  let L: Float64Array | undefined;
  const t0 = performance.now();
  // total energy W = 0.5 int A J dV (2 pi r measure): 2 pi * 0.5 * A . Ftot
  let AF = 0; for (let i = 0; i < n; i++) AF += A[i]! * Ftot[i]!;
  scalars.W_m = scalar(Math.PI * AF, 'J');
  if (p.inductance) {
    const nc = p.coils.length;
    const As = loads.map((l) => { const F = l.F.map((v) => v * l.J); return solveF(F); });
    L = new Float64Array(nc * nc);
    for (let i = 0; i < nc; i++) for (let j = 0; j < nc; j++) {
      // flux linkage of coil i from coil j: int A_j J_i dV, J_i = turns I / area (per unit current: divide by I_i I_j)
      let s = 0; for (let q = 0; q < n; q++) s += As[j]![q]! * loads[i]!.F[q]! * loads[i]!.J;
      L[i * nc + j] = (2 * Math.PI * s) / (p.coils[i]!.current * p.coils[j]!.current);
      scalars[`L_${p.coils[i]!.id}_${p.coils[j]!.id}`] = scalar(L[i * nc + j]!, 'H');
    }
  }
  const { Br, Bz } = nodalB(m, A, mask);
  const normB = Float64Array.from(Br, (v, i) => Math.hypot(v, Bz[i]!));
  timer.add('post', performance.now() - t0);
  const space: 'H1P1' | 'H1P2' = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { physics: 'magnetostatics', coils: p.coils, n } }),
    fields: [
      { name: 'A_phi', unit: 'Wb/m', space, components: 1, data: A },
      { name: 'Br', unit: 'T', space, components: 1, data: Br },
      { name: 'Bz', unit: 'T', space, components: 1, data: Bz },
      { name: 'normB', unit: 'T', space, components: 1, data: normB },
    ],
    scalars, stats: { dof: R.pat.n, nnz: R.pat.nnz, solver: S.kind }, timer,
  });
  attachMesh(sol, m);
  void matVec;
  return Object.assign(sol, { A, ...(L ? { L } : {}) });
}

export function magnetostaticsProblemFromContext(ctx: RunContext): MagnetostaticsProblem {
  const spec = ctx.spec as Spec;
  const { mask, values } = cellProps(ctx, ['mu_r']);
  const coils: Coil[] = [], insulation: string[] = [];
  for (const b of bcsOf(spec, ctx.physicsId)) {
    const s = b.settings ?? {};
    if (b.type === 'coil-current') {
      const turns = s.turns as number;
      if (!(Number.isInteger(turns) && turns >= 1)) throw new Error(`${b.id}: turns must be a positive integer`);
      coils.push({ id: b.id, select: b.select, turns, current: qty(spec, s.current, `${b.id}.current`) });
    } else if (b.type === 'magnetic-insulation') insulation.push(...b.select);
    else throw new Error(`magnetostatics: unsupported condition '${b.type}'`);
  }
  const ph = physicsNode(spec, ctx.physicsId) as { settings?: { inductance?: boolean } };
  return { mesh: ctx.mesh, muR: values.mu_r!, mask, coils, insulation, inductance: !!ph.settings?.inductance, spec };
}

export const magnetostaticsModule: PhysicsModule = {
  type: 'magnetostatics',
  dims: ['2d-axisym'],
  readiness(spec, physicsId) {
    const reasons: string[] = [];
    try {
      const ph = physicsNode(spec as Spec, physicsId);
      const ok = new Set(['coil-current', 'magnetic-insulation']);
      for (const b of ph.bcs ?? []) if (!ok.has(b.type)) reasons.push(`unsupported condition '${b.type}'`);
      const g = (spec as Spec).geometry as { dim?: number; axisym?: boolean };
      if (!g.axisym) reasons.push('wave 1 magnetostatics is axisymmetric only');
    } catch (e) { reasons.push((e as Error).message); }
    return { ready: !reasons.length, reasons };
  },
  async run(ctx) { return solveMagnetostatics(magnetostaticsProblemFromContext(ctx)); },
};
