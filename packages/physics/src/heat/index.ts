// SPDX-License-Identifier: GPL-3.0-or-later
// Heat transfer in solids (C4 type 'heat'): rho cp dT/dt - div(k grad T) = Q on 2D (per unit depth), 2D axisymmetric
// (weight r) and 3D meshes (tri3/tri6, tet4/tet10, hex8). Boundary conditions: fixed temperature (constant or a
// function of (x, t)), inward heat flux q, convection q = h (T_ext - T), surface radiation q = eps sigma (T_amb^4 - T^4)
// (Newton linearisation, tangent 4 eps sigma T^3), insulation (natural). Steady (Newton when radiation is present) or
// transient with BDF2 (BDF1 first step), consistent mass. Material values come from the spec / caller, never defaults.

import type { Mesh, PhysicsModule, RunContext, Solution, Spec } from '@amp/spec/types';
import { NPC, facetNodes, facetsOn, nCells, nNodes, cellMask } from '../common/mesh.ts';
import { assembleCells, assembleFacets, cellOrder, entry, restrict, SpdSolver, type Csr, facetTable } from '../common/scalar.ts';
import { gatherX, facetJac } from '../common/lagrange.ts';
import { makeSolution, StageTimer, checkAbort, scalar } from '../common/solution.ts';
import { attachMesh } from '@amp/post';
import { bcsOf, cellProps, optionalCellProp, q as qty, physicsNode } from '../common/ctx.ts';

/** Stefan-Boltzmann constant, W m^-2 K^-4 (CODATA 2018, exact in the 2019 SI: 2 pi^5 k^4 / (15 h^3 c^2)). */
export const SIGMA_SB = 5.670374419e-8;

export type Fn = (x: Float64Array, t: number) => number;
export type HeatBc =
  | { type: 'temperature'; select: string[]; T: number | Fn }
  | { type: 'heat-flux'; select: string[]; q: number }
  | { type: 'convection'; select: string[]; h: number; T_ext: number }
  | { type: 'radiation'; select: string[]; emissivity: number; T_amb: number }
  | { type: 'insulation'; select: string[] };

export interface HeatProblem {
  mesh: Mesh;
  /** per-cell conductivity (W/(m K)); cells with NaN or outside `mask` are inactive */
  k: Float64Array;
  /** per-cell rho * cp (J/(m^3 K)), transient only */
  rhoCp?: Float64Array;
  /** per-cell volume source (W/m^3) */
  Q?: Float64Array;
  mask?: Uint8Array;
  bcs: HeatBc[];
  /** transient: times from t0 by dt to t1; T0 initial temperature (K, constant or per node); save: output times */
  transient?: { t0: number; t1: number; dt: number; T0: number | Float64Array; save?: number[] };
  newton?: { tol?: number; maxIt?: number };
  solver?: 'cholesky' | 'amg-pcg';
  spec?: unknown;
  signal?: AbortSignal;
}

interface Sys {
  pat: Csr; K: Float64Array; M?: Float64Array; F: Float64Array; Fconst: Float64Array;
  fixed: Uint8Array; fixedNodes: Int32Array; dir: Array<{ nodes: Int32Array; T: number | Fn }>;
  rad: Array<{ facets: number[]; eps: number; Tamb: number }>; active: Uint8Array;
}

function build(p: HeatProblem, timer: StageTimer): Sys {
  const m = p.mesh, n = nNodes(m), nc = nCells(m);
  const axi = !!m.axisym;
  const mask = p.mask ?? Uint8Array.from(p.k, (v) => (Number.isFinite(v) ? 1 : 0));
  const k = Float64Array.from(p.k, (v, c) => (mask[c] ? v : 0));
  const A = timer.time('assemble', () => assembleCells(m, {
    k, mask, weight: axi ? 'r' : 'none',
    ...(p.rhoCp ? { m: Float64Array.from(p.rhoCp, (v, c) => (mask[c] ? v : 0)) } : {}),
    f: p.Q ? Float64Array.from(p.Q, (v, c) => (mask[c] && Number.isFinite(v) ? v : 0)) : new Float64Array(nc),
  }));
  const K = A.K!, F = A.F!;
  const dir: Sys['dir'] = [], rad: Sys['rad'] = [];
  timer.time('assemble', () => {
    for (const b of p.bcs) {
      if (b.type === 'temperature') { dir.push({ nodes: facetNodes(m, facetsOn(m, b.select)), T: b.T }); continue; }
      if (b.type === 'insulation') { facetsOn(m, b.select); continue; } // selection checked; natural BC
      const fs = facetsOn(m, b.select);
      if (b.type === 'heat-flux') assembleFacets(m, A.pat, fs, { g: b.q, F, weight: axi ? 'r' : 'none' });
      else if (b.type === 'convection') assembleFacets(m, A.pat, fs, { h: b.h, g: b.h * b.T_ext, Kval: K, F, weight: axi ? 'r' : 'none' });
      else if (b.type === 'radiation') rad.push({ facets: fs, eps: b.emissivity, Tamb: b.T_amb });
    }
  });
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!A.active[i]) fixed[i] = 1;   // nodes outside the heat domain: removed
  for (const d of dir) for (const v of d.nodes) fixed[v] = 1;
  const fixedNodes = Int32Array.from({ length: n }, (_, i) => i).filter((i) => fixed[i] && A.active[i]);
  return { pat: A.pat, K, ...(A.M ? { M: A.M } : {}), F, Fconst: F.slice(), fixed, fixedNodes, dir, rad, active: A.active };
}

/** Radiation residual and tangent on facets: R_a = int eps sigma (T^4 - Tamb^4) N_a, J_ab = int 4 eps sigma T^3 N_a N_b. */
function radiation(m: Mesh, S: Sys, T: Float64Array, R: Float64Array, Jval: Float64Array | null): void {
  if (!S.rad.length) return;
  const dim = m.dim, type = m.facets.type, kf = NPC[type];
  const t = facetTable(m, 4 * cellOrder(m) + 2);
  const X = new Float64Array(kf * dim);
  const axi = !!m.axisym;
  const Je = new Float64Array(kf * kf), Re = new Float64Array(kf);
  for (const r of S.rad) for (const f of r.facets) {
    gatherX(m.nodes, dim, m.facets.conn, f, kf, X);
    Je.fill(0); Re.fill(0);
    for (let qp = 0; qp < t.rule.n; qp++) {
      let w = facetJac(t, qp, X, dim) * t.rule.wts[qp]!;
      let Tq = 0, rq = 0;
      for (let a = 0; a < kf; a++) { const Na = t.N[qp * kf + a]!; Tq += Na * T[m.facets.conn[kf * f + a]!]!; rq += Na * X[dim * a]!; }
      if (axi) w *= rq;
      const res = r.eps * SIGMA_SB * (Tq ** 4 - r.Tamb ** 4), tan = 4 * r.eps * SIGMA_SB * Tq ** 3;
      for (let a = 0; a < kf; a++) {
        const Na = t.N[qp * kf + a]!;
        Re[a]! += res * Na * w;
        for (let b = 0; b < kf; b++) Je[kf * a + b]! += tan * Na * t.N[qp * kf + b]! * w;
      }
    }
    for (let a = 0; a < kf; a++) {
      const ia = m.facets.conn[kf * f + a]!;
      R[ia]! += Re[a]!;
      if (Jval) for (let b = 0; b < kf; b++) Jval[entry(S.pat, ia, m.facets.conn[kf * f + b]!)]! += Je[kf * a + b]!;
    }
  }
}

function applyDirichlet(m: Mesh, S: Sys, T: Float64Array, t: number): void {
  const x = new Float64Array(m.dim);
  for (const d of S.dir) for (const v of d.nodes) {
    if (typeof d.T === 'number') T[v] = d.T;
    else { for (let c = 0; c < m.dim; c++) x[c] = m.nodes[m.dim * v + c]!; T[v] = d.T(x, t); }
  }
}

/**
 * Solve one (possibly nonlinear) system: (K + a M) T + R_rad(T) = F + a M T_hist, by Newton on the free nodes.
 * a = 0 for steady. Returns Newton iterations.
 */
function solveStep(m: Mesh, S: Sys, solver: { s: SpdSolver | null; R: ReturnType<typeof restrict> | null }, kind: 'cholesky' | 'amg-pcg',
  T: Float64Array, a: number, rhsExtra: Float64Array | null, timer: StageTimer, tol: number, maxIt: number): { it: number; res: number } {
  const n = nNodes(m), pat = S.pat;
  const free = Uint8Array.from(S.fixed, (f) => (f ? 0 : 1));
  const A = new Float64Array(pat.nnz);
  const r = new Float64Array(n), tmp = new Float64Array(n);
  let it = 0, res = Infinity;
  const nonlinear = S.rad.length > 0;
  for (; it < (nonlinear ? maxIt : 1); it++) {
    // A = K + a M (+ J_rad); residual r = F + extra - (K + a M) T - R_rad(T)
    for (let z = 0; z < pat.nnz; z++) A[z] = S.K[z]! + (a && S.M ? a * S.M[z]! : 0);
    r.fill(0);
    radiation(m, S, T, r, nonlinear ? A : null);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let z = pat.rowptr[i]!; z < pat.rowptr[i + 1]!; z++) s += (S.K[z]! + (a && S.M ? a * S.M[z]! : 0)) * T[pat.colidx[z]!]!;
      tmp[i] = S.F[i]! + (rhsExtra ? rhsExtra[i]! : 0) - s - r[i]!;
    }
    if (!solver.R) solver.R = restrict(pat, A, free);
    const R = solver.R;
    const vals = new Float64Array(R.pat.nnz);
    for (let z = 0; z < R.pat.nnz; z++) vals[z] = A[R.src[z]!]!;
    const b = new Float64Array(R.pat.n);
    let rn = 0, fn = 0;
    for (let i = 0; i < n; i++) if (free[i]) { b[R.map[i]!] = tmp[i]!; rn += tmp[i]! ** 2; fn += (S.F[i]! + (rhsExtra ? rhsExtra[i]! : 0)) ** 2; }
    res = Math.sqrt(rn) / Math.max(Math.sqrt(fn), 1e-300);
    if (nonlinear && it > 0 && res < tol) break;
    if (!solver.s) solver.s = new SpdSolver(R.pat, kind);
    timer.time('factor', () => solver.s!.factor(vals));
    const dT = timer.time('solve', () => solver.s!.solve(b));
    let dmax = 0, tmax = 0;
    for (let i = 0; i < n; i++) if (free[i]) { const d = dT[R.map[i]!]!; T[i]! += d; dmax = Math.max(dmax, Math.abs(d)); tmax = Math.max(tmax, Math.abs(T[i]!)); }
    if (nonlinear && dmax <= tol * tmax) { it++; break; }
  }
  return { it, res };
}

export interface HeatDetail { times?: Float64Array; newton: number[]; dof: number; solver: string }

export async function solveHeat(p: HeatProblem): Promise<Solution & { detail: HeatDetail; T: Float64Array }> {
  const timer = new StageTimer();
  const m = p.mesh, n = nNodes(m);
  const S = build(p, timer);
  const kind = p.solver ?? 'cholesky';
  const tol = p.newton?.tol ?? 1e-12, maxIt = p.newton?.maxIt ?? 50;
  const space: 'H1P1' | 'H1P2' = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
  const solver: { s: SpdSolver | null; R: ReturnType<typeof restrict> | null } = { s: null, R: null };
  const fields: Solution['fields'] = [];
  const newton: number[] = [];
  let T: Float64Array;
  let times: Float64Array | undefined;
  if (!p.transient) {
    T = new Float64Array(n);
    // start from the mean Dirichlet / ambient level for Newton
    const guess = S.dir.length && typeof S.dir[0]!.T === 'number' ? (S.dir[0]!.T as number) : S.rad[0]?.Tamb ?? 0;
    T.fill(guess);
    applyDirichlet(m, S, T, 0);
    newton.push(solveStep(m, S, solver, kind, T, 0, null, timer, tol, maxIt).it);
    fields.push({ name: 'T', unit: 'K', space, components: 1, data: T });
  } else {
    const tr = p.transient;
    if (!S.M) throw new Error('heat: transient needs rhoCp');
    const nSteps = Math.round((tr.t1 - tr.t0) / tr.dt);
    if (Math.abs(nSteps * tr.dt - (tr.t1 - tr.t0)) > 1e-9 * Math.abs(tr.t1 - tr.t0)) throw new Error('heat: (t1 - t0) / dt must be an integer');
    const save = new Set((tr.save ?? Array.from({ length: nSteps + 1 }, (_, i) => tr.t0 + i * tr.dt)).map((t) => Math.round((t - tr.t0) / tr.dt)));
    T = typeof tr.T0 === 'number' ? new Float64Array(n).fill(tr.T0) : Float64Array.from(tr.T0);
    let Tm1 = T.slice();
    const out: number[] = [];
    const push = (step: number, t: number) => { if (save.has(step)) { fields.push({ name: 'T', unit: 'K', space, components: 1, data: T.slice(), step: out.length }); out.push(t); } };
    push(0, tr.t0);
    const Mv = new Float64Array(n), w = new Float64Array(n);
    // BDF1 and BDF2 have different a: keep two factorizations' worth by refactoring when a changes
    let aPrev = NaN;
    for (let s = 1; s <= nSteps; s++) {
      checkAbort(p.signal);
      const t = tr.t0 + s * tr.dt;
      const bdf2 = s > 1;
      const a = bdf2 ? 1.5 / tr.dt : 1 / tr.dt;
      // history: BDF1 a M T^n ; BDF2 (2 T^n - 0.5 T^{n-1}) M / dt
      for (let i = 0; i < n; i++) w[i] = bdf2 ? (2 * T[i]! - 0.5 * Tm1[i]!) / tr.dt : T[i]! / tr.dt;
      for (let i = 0; i < n; i++) { let z = 0; for (let q = S.pat.rowptr[i]!; q < S.pat.rowptr[i + 1]!; q++) z += S.M[q]! * w[S.pat.colidx[q]!]!; Mv[i] = z; }
      Tm1 = T.slice();
      applyDirichlet(m, S, T, t);
      if (a !== aPrev) { solver.s = null; aPrev = a; }
      // linear problems: factor once per a value
      const keep = !S.rad.length;
      const stepSolver = keep && solver.s ? { s: solver.s, R: solver.R, reuse: true } : null;
      if (stepSolver) {
        // reuse factor: one linear solve with the cached factorization
        const r = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          let z = 0;
          for (let q = S.pat.rowptr[i]!; q < S.pat.rowptr[i + 1]!; q++) z += (S.K[q]! + a * S.M[q]!) * T[S.pat.colidx[q]!]!;
          r[i] = S.F[i]! + Mv[i]! - z;
        }
        const R = solver.R!;
        const b = new Float64Array(R.pat.n);
        for (let i = 0; i < n; i++) if (!S.fixed[i]) b[R.map[i]!] = r[i]!;
        const dT = timer.time('solve', () => solver.s!.solve(b));
        for (let i = 0; i < n; i++) if (!S.fixed[i]) T[i]! += dT[R.map[i]!]!;
        newton.push(1);
      } else newton.push(solveStep(m, S, solver, kind, T, a, Mv, timer, tol, maxIt).it);
      push(s, t);
    }
    times = Float64Array.from(out);
  }
  const t0 = performance.now();
  let Tmax = -Infinity, Tmin = Infinity;
  for (let i = 0; i < n; i++) if (S.active[i]) { Tmax = Math.max(Tmax, T[i]!); Tmin = Math.min(Tmin, T[i]!); }
  timer.add('post', performance.now() - t0);
  const dof = n - S.fixedNodes.length - (n - S.active.reduce((s, v) => s + v, 0));
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { physics: 'heat', bcs: p.bcs.map((b) => b.type), n } }),
    fields, ...(times ? { steps: { kind: 'time' as const, values: times, unit: 's' } } : {}),
    scalars: { T_max: scalar(Tmax, 'K'), T_min: scalar(Tmin, 'K') },
    stats: { dof, nnz: S.pat.nnz, iterations: newton.reduce((s, v) => s + v, 0), solver: `${kind}${S.rad.length ? '+newton' : ''}${p.transient ? '+bdf2' : ''}` },
    timer,
  });
  attachMesh(sol, m);
  return Object.assign(sol, { detail: { ...(times ? { times } : {}), newton, dof, solver: kind }, T });
}

// ------------------------------------------------------------------------------------------------- spec binding

function heatProblemFromContext(ctx: RunContext): HeatProblem {
  const spec = ctx.spec as Spec, m = ctx.mesh;
  const transient = ctx.study.type === 'time';
  const { mask, values } = cellProps(ctx, transient ? ['k', 'rho', 'cp'] : ['k']);
  const nc = nCells(m);
  const k = Float64Array.from(values.k!, (v, c) => (mask[c] ? v : NaN));
  const bcs: HeatBc[] = [];
  const Q = new Float64Array(nc);
  let hasQ = false;
  for (const b of bcsOf(spec, ctx.physicsId)) {
    const s = b.settings ?? {};
    switch (b.type) {
      case 'temperature': bcs.push({ type: 'temperature', select: b.select, T: qty(spec, s.T, `${b.id}.T`) }); break;
      case 'heat-flux': bcs.push({ type: 'heat-flux', select: b.select, q: qty(spec, s.q, `${b.id}.q`) }); break;
      case 'convection': bcs.push({ type: 'convection', select: b.select, h: qty(spec, s.h, `${b.id}.h`), T_ext: qty(spec, s.T_ext, `${b.id}.T_ext`) }); break;
      case 'surface-radiation': bcs.push({ type: 'radiation', select: b.select, emissivity: qty(spec, s.emissivity, `${b.id}.emissivity`), T_amb: qty(spec, s.T_amb, `${b.id}.T_amb`) }); break;
      case 'insulation': bcs.push({ type: 'insulation', select: b.select }); break;
      case 'heat-source': {
        const v = qty(spec, s.Q, `${b.id}.Q`), cm = cellMask(m, b.select);
        for (let c = 0; c < nc; c++) if (cm[c]) { Q[c] = v; hasQ = true; }
        break;
      }
      default: throw new Error(`heat: unsupported condition type '${b.type}'`);
    }
  }
  const p: HeatProblem = { mesh: m, k, mask, bcs, ...(hasQ ? { Q } : {}), spec, signal: ctx.signal };
  if (transient) {
    const st = (ctx.study.settings ?? {}) as { start?: unknown; stop?: unknown; step?: unknown };
    const ph = physicsNode(spec, ctx.physicsId) as { settings?: { T0?: unknown } };
    if (ph.settings?.T0 === undefined) throw new Error('heat: transient study needs physics settings.T0 (initial temperature)');
    p.rhoCp = Float64Array.from(values.rho!, (v, c) => v * values.cp![c]!);
    p.transient = { t0: qty(spec, st.start, 'study.start'), t1: qty(spec, st.stop, 'study.stop'), dt: qty(spec, st.step, 'study.step'), T0: qty(spec, ph.settings.T0, 'settings.T0') };
  }
  void optionalCellProp;
  return p;
}

export const heatModule: PhysicsModule = {
  type: 'heat',
  dims: ['2d', '2d-axisym', '3d'],
  readiness(spec, physicsId) {
    const reasons: string[] = [];
    try {
      const ph = physicsNode(spec as Spec, physicsId);
      if (!ph.select?.length) reasons.push('physics has no domain selection');
      const types = new Set(['temperature', 'heat-flux', 'convection', 'surface-radiation', 'insulation', 'heat-source']);
      for (const b of (ph.bcs ?? [])) if (!types.has(b.type)) reasons.push(`unsupported condition '${b.type}'`);
    } catch (e) { reasons.push((e as Error).message); }
    return { ready: !reasons.length, reasons };
  },
  async run(ctx) {
    ctx.progress('assemble', 0);
    const s = await solveHeat(heatProblemFromContext(ctx));
    ctx.progress('done', 1);
    return s;
  },
};
