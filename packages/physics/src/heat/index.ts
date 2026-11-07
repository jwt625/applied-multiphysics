// SPDX-License-Identifier: GPL-3.0-or-later
// Heat transfer in solids (C4 type 'heat'): rho cp dT/dt - div(k grad T) = Q on 2D (per unit depth), 2D axisymmetric
// (weight r) and 3D meshes (tri3/tri6, tet4/tet10, hex8). Boundary conditions: fixed temperature, inward heat flux q,
// convection q = h (T_ext - T), surface radiation q = eps sigma (T_amb^4 - T^4) (Newton linearisation, tangent
// 4 eps sigma T^3), insulation (natural). Every BC value and the source may be a field of (x, t) (common/field.ts;
// h may depend on space only). Steady (Newton when radiation is present) or transient: bdf1, bdf2 (BDF1 first
// step) or crank-nicolson (linear problems), consistent mass. Material values come from the spec / caller.

import type { Mesh, PhysicsModule, RunContext, Solution, Spec } from '@amp/spec/types';
import { NPC, facetNodes, facetsOn, nCells, nNodes, cellMask } from '../common/mesh.ts';
import { assembleCells, assembleFacets, cellOrder, entry, restrict, SpdSolver, type Csr, facetTable } from '../common/scalar.ts';
import { gatherX, facetJac } from '../common/lagrange.ts';
import { makeSolution, StageTimer, checkAbort, scalar } from '../common/solution.ts';
import { attachMesh } from '../common/solution.ts';
import { bcsOf, cellProps, q as qty, physicsNode } from '../common/ctx.ts';
import { compileField, dependsOnTime, evalField, spaceOf, type FieldValue } from '../common/field.ts';

/** Stefan-Boltzmann constant, W m^-2 K^-4 (CODATA 2018, exact in the 2019 SI: 2 pi^5 k^4 / (15 h^3 c^2)). */
export const SIGMA_SB = 5.670374419e-8;

export type Fn = (x: ArrayLike<number>, t: number) => number;
export type HeatBc =
  | { type: 'temperature'; select: string[]; T: FieldValue }
  | { type: 'heat-flux'; select: string[]; q: FieldValue }
  | { type: 'convection'; select: string[]; h: FieldValue; T_ext: FieldValue }
  | { type: 'radiation'; select: string[]; emissivity: number; T_amb: FieldValue }
  | { type: 'insulation'; select: string[] };

export type TimeMethod = 'bdf1' | 'bdf2' | 'crank-nicolson';

export interface HeatProblem {
  mesh: Mesh;
  /** per-cell conductivity (W/(m K)); cells with NaN or outside `mask` are inactive */
  k: Float64Array;
  /** per-cell rho * cp (J/(m^3 K)), transient only */
  rhoCp?: Float64Array;
  /** volume source per cell (W/m^3) */
  Q?: Float64Array;
  /** volume sources as fields of (x, t) on cell sets (they add where they overlap) */
  sources?: Array<{ mask: Uint8Array; Q: FieldValue }>;
  mask?: Uint8Array;
  bcs: HeatBc[];
  /** transient: t0 to t1 by dt; T0 initial temperature (K: constant, per node, or a field of x); save: output times */
  transient?: { t0: number; t1: number; dt: number; T0: number | Float64Array | FieldValue; save?: number[]; method?: TimeMethod };
  newton?: { tol?: number; maxIt?: number };
  solver?: 'cholesky' | 'amg-pcg';
  spec?: unknown;
  signal?: AbortSignal;
}

interface Sys {
  pat: Csr; K: Float64Array; M?: Float64Array;
  /** load vector at time t (cached when nothing depends on t) */
  F(t: number): Float64Array;
  timeDependentF: boolean;
  fixed: Uint8Array; fixedNodes: Int32Array; dir: Array<{ nodes: Int32Array; T: FieldValue }>;
  rad: Array<{ facets: number[]; eps: number; Tamb: FieldValue }>; active: Uint8Array;
}

function build(p: HeatProblem, timer: StageTimer): Sys {
  const m = p.mesh, n = nNodes(m), nc = nCells(m);
  const axi = !!m.axisym;
  const w = axi ? 'r' as const : 'none' as const;
  const mask = p.mask ?? Uint8Array.from(p.k, (v) => (Number.isFinite(v) ? 1 : 0));
  const k = Float64Array.from(p.k, (v, c) => (mask[c] ? v : 0));
  const A = timer.time('assemble', () => assembleCells(m, {
    k, mask, weight: w, ...(p.rhoCp ? { m: Float64Array.from(p.rhoCp, (v, c) => (mask[c] ? v : 0)) } : {}),
  }));
  const K = A.K!;
  const dir: Sys['dir'] = [], rad: Sys['rad'] = [];
  const loads: Array<(F: Float64Array, t: number) => void> = [];
  let timeDep = false;
  if (p.Q) {
    const f = Float64Array.from(p.Q, (v, c) => (mask[c] && Number.isFinite(v) ? v : 0));
    loads.push((F) => { const a = assembleCells(m, { mask, weight: w, f }); for (let i = 0; i < n; i++) F[i]! += a.F![i]!; });
  }
  for (const src of p.sources ?? []) {
    const sm = Uint8Array.from(src.mask, (v, c) => (v && mask[c] ? 1 : 0));
    timeDep ||= dependsOnTime(src.Q);
    loads.push((F, t) => {
      const a = assembleCells(m, { mask: sm, weight: w, fFn: (x) => evalField(src.Q, x, t) });
      for (let i = 0; i < n; i++) F[i]! += a.F![i]!;
    });
  }
  timer.time('assemble', () => {
    for (const b of p.bcs) {
      if (b.type === 'temperature') { dir.push({ nodes: facetNodes(m, facetsOn(m, b.select)), T: b.T }); continue; }
      if (b.type === 'insulation') { facetsOn(m, b.select); continue; } // selection checked; natural BC
      const fs = facetsOn(m, b.select);
      if (b.type === 'heat-flux') {
        timeDep ||= dependsOnTime(b.q);
        loads.push((F, t) => assembleFacets(m, A.pat, fs, { g: typeof b.q === 'number' ? b.q : (x) => evalField(b.q, x, t), F, weight: w }));
      } else if (b.type === 'convection') {
        if (dependsOnTime(b.h)) throw new Error('heat: a time-dependent convection coefficient h is not supported (h may depend on space)');
        assembleFacets(m, A.pat, fs, { h: typeof b.h === 'number' ? b.h : (x) => evalField(b.h, x), Kval: K, weight: w });
        timeDep ||= dependsOnTime(b.T_ext);
        loads.push((F, t) => assembleFacets(m, A.pat, fs, { g: (x) => evalField(b.h, x) * evalField(b.T_ext, x, t), F, weight: w }));
      } else if (b.type === 'radiation') rad.push({ facets: fs, eps: b.emissivity, Tamb: b.T_amb });
    }
  });
  let cache: Float64Array | null = null;
  const F = (t: number): Float64Array => {
    if (cache && !timeDep) return cache;
    const out = new Float64Array(n);
    for (const l of loads) l(out, t);
    if (!timeDep) cache = out;
    return out;
  };
  timer.time('assemble', () => F(p.transient?.t0 ?? 0));
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!A.active[i]) fixed[i] = 1;   // nodes outside the heat domain: removed
  for (const d of dir) for (const v of d.nodes) fixed[v] = 1;
  const fixedNodes = Int32Array.from({ length: n }, (_, i) => i).filter((i) => fixed[i] && A.active[i]);
  return { pat: A.pat, K, ...(A.M ? { M: A.M } : {}), F, timeDependentF: timeDep, fixed, fixedNodes, dir, rad, active: A.active };
}

/** Radiation residual and tangent on facets: R_a = int eps sigma (T^4 - Tamb^4) N_a, J_ab = int 4 eps sigma T^3 N_a N_b. */
function radiation(m: Mesh, S: Sys, T: Float64Array, t: number, R: Float64Array, Jval: Float64Array | null): void {
  if (!S.rad.length) return;
  const dim = m.dim, type = m.facets.type, kf = NPC[type];
  const tb = facetTable(m, 4 * cellOrder(m) + 2);
  const X = new Float64Array(kf * dim), P = new Float64Array(dim);
  const axi = !!m.axisym;
  const Je = new Float64Array(kf * kf), Re = new Float64Array(kf);
  for (const r of S.rad) for (const f of r.facets) {
    gatherX(m.nodes, dim, m.facets.conn, f, kf, X);
    Je.fill(0); Re.fill(0);
    for (let qp = 0; qp < tb.rule.n; qp++) {
      let w = facetJac(tb, qp, X, dim) * tb.rule.wts[qp]!;
      let Tq = 0;
      P.fill(0);
      for (let a = 0; a < kf; a++) { const Na = tb.N[qp * kf + a]!; Tq += Na * T[m.facets.conn[kf * f + a]!]!; for (let d = 0; d < dim; d++) P[d]! += Na * X[dim * a + d]!; }
      if (axi) w *= P[0]!;
      const Ta = evalField(r.Tamb, P, t);
      const res = r.eps * SIGMA_SB * (Tq ** 4 - Ta ** 4), tan = 4 * r.eps * SIGMA_SB * Tq ** 3;
      for (let a = 0; a < kf; a++) {
        const Na = tb.N[qp * kf + a]!;
        Re[a]! += res * Na * w;
        for (let b = 0; b < kf; b++) Je[kf * a + b]! += tan * Na * tb.N[qp * kf + b]! * w;
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

type Cache = { s: SpdSolver | null; R: ReturnType<typeof restrict> | null; a: number };

/**
 * One step: (K + a M) T + R_rad(T) = rhs with rhs = F(t) + extra, by Newton on the free nodes (one linear solve when
 * there is no radiation; the factorization is reused while a is unchanged). a = 0 for steady.
 */
function solveStep(m: Mesh, S: Sys, c: Cache, kind: 'cholesky' | 'amg-pcg', T: Float64Array, a: number, rhs: Float64Array,
  t: number, timer: StageTimer, tol: number, maxIt: number): number {
  const n = nNodes(m), pat = S.pat;
  const nonlinear = S.rad.length > 0;
  const A = new Float64Array(pat.nnz);
  const r = new Float64Array(n), tmp = new Float64Array(n);
  let fn = 0; for (let i = 0; i < n; i++) if (!S.fixed[i]) fn += rhs[i]! ** 2;
  fn = Math.sqrt(fn);
  let it = 0;
  for (; it < (nonlinear ? maxIt : 1); it++) {
    for (let z = 0; z < pat.nnz; z++) A[z] = S.K[z]! + (a && S.M ? a * S.M[z]! : 0);
    r.fill(0);
    radiation(m, S, T, t, r, nonlinear ? A : null);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let z = pat.rowptr[i]!; z < pat.rowptr[i + 1]!; z++) s += A[z]! * T[pat.colidx[z]!]!;
      // A includes the radiation tangent; the residual uses the operator without it
      if (nonlinear) for (let z = pat.rowptr[i]!; z < pat.rowptr[i + 1]!; z++) s -= (A[z]! - S.K[z]! - (a && S.M ? a * S.M[z]! : 0)) * T[pat.colidx[z]!]!;
      tmp[i] = rhs[i]! - s - r[i]!;
    }
    if (!c.R) c.R = restrict(pat, A, Uint8Array.from(S.fixed, (f) => (f ? 0 : 1)));
    const R = c.R;
    const b = new Float64Array(R.pat.n);
    let rn = 0;
    for (let i = 0; i < n; i++) if (!S.fixed[i]) { b[R.map[i]!] = tmp[i]!; rn += tmp[i]! ** 2; }
    if (nonlinear && it > 0 && Math.sqrt(rn) <= tol * Math.max(fn, 1e-300)) break;
    if (!c.s || nonlinear || c.a !== a) {
      const vals = new Float64Array(R.pat.nnz);
      for (let z = 0; z < R.pat.nnz; z++) vals[z] = A[R.src[z]!]!;
      if (!c.s) c.s = new SpdSolver(R.pat, kind);
      timer.time('factor', () => c.s!.factor(vals));
      c.a = a;
    }
    const dT = timer.time('solve', () => c.s!.solve(b));
    let dmax = 0, tmax = 0;
    for (let i = 0; i < n; i++) if (!S.fixed[i]) { const d = dT[R.map[i]!]!; T[i]! += d; dmax = Math.max(dmax, Math.abs(d)); tmax = Math.max(tmax, Math.abs(T[i]!)); }
    if (nonlinear && dmax <= tol * tmax) { it++; break; }
  }
  return it;
}

export interface HeatDetail { times?: Float64Array; newton: number[]; dof: number; solver: string }

const mulAdd = (pat: Csr, val: Float64Array, x: Float64Array, s: number, out: Float64Array) => {
  for (let i = 0; i < pat.n; i++) { let z = 0; for (let q = pat.rowptr[i]!; q < pat.rowptr[i + 1]!; q++) z += val[q]! * x[pat.colidx[q]!]!; out[i]! += s * z; }
};

export async function solveHeat(p: HeatProblem): Promise<Solution & { detail: HeatDetail; T: Float64Array }> {
  const timer = new StageTimer();
  const m = p.mesh, n = nNodes(m);
  const S = build(p, timer);
  const kind = p.solver ?? 'cholesky';
  const tol = p.newton?.tol ?? 1e-12, maxIt = p.newton?.maxIt ?? 50;
  const space: 'H1P1' | 'H1P2' = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
  const cache: Cache = { s: null, R: null, a: NaN };
  const fields: Solution['fields'] = [];
  const newton: number[] = [];
  let T: Float64Array;
  let times: Float64Array | undefined;
  const method = p.transient?.method ?? 'bdf2';
  if (!p.transient) {
    T = new Float64Array(n);
    const d0 = S.dir[0]?.T, r0 = S.rad[0]?.Tamb;
    T.fill(typeof d0 === 'number' ? d0 : typeof r0 === 'number' ? r0 : 0);   // Newton start
    applyDirichlet(m, S, T, 0);
    newton.push(solveStep(m, S, cache, kind, T, 0, S.F(0), 0, timer, tol, maxIt));
    fields.push({ name: 'T', unit: 'K', space, components: 1, data: T });
  } else {
    const tr = p.transient;
    if (!S.M) throw new Error('heat: transient needs rhoCp');
    if (method === 'crank-nicolson' && S.rad.length) throw new Error('heat: crank-nicolson is implemented for linear problems (no radiation); use bdf1 / bdf2');
    const nSteps = Math.round((tr.t1 - tr.t0) / tr.dt);
    if (Math.abs(nSteps * tr.dt - (tr.t1 - tr.t0)) > 1e-9 * Math.abs(tr.t1 - tr.t0)) throw new Error('heat: (stop - start) / dt must be an integer');
    const saveSteps = new Set((tr.save ?? Array.from({ length: nSteps + 1 }, (_, i) => tr.t0 + i * tr.dt)).map((t) => {
      const s = Math.round((t - tr.t0) / tr.dt);
      if (Math.abs(tr.t0 + s * tr.dt - t) > 1e-9 * Math.max(1, Math.abs(t))) throw new Error(`heat: output time ${t} s is not on the dt grid`);
      return s;
    }));
    const x = new Float64Array(m.dim);
    T = tr.T0 instanceof Float64Array ? Float64Array.from(tr.T0)
      : Float64Array.from({ length: n }, (_, i) => { for (let d = 0; d < m.dim; d++) x[d] = m.nodes[m.dim * i + d]!; return evalField(tr.T0 as FieldValue, x, tr.t0); });
    let Tm1 = T.slice();
    const out: number[] = [];
    const push = (step: number, t: number) => { if (saveSteps.has(step)) { fields.push({ name: 'T', unit: 'K', space, components: 1, data: T.slice(), step: out.length }); out.push(t); } };
    push(0, tr.t0);
    let Fprev = S.F(tr.t0);
    for (let s = 1; s <= nSteps; s++) {
      checkAbort(p.signal);
      const t = tr.t0 + s * tr.dt;
      const Ft = S.F(t);
      const rhs = new Float64Array(n);
      let a: number;
      if (method === 'crank-nicolson') {
        // (M/dt + K/2) T1 = (M/dt - K/2) T0 + (F0 + F1)/2
        a = 2 / tr.dt;   // scaled by 2: (K + (2/dt) M) T1 = (2/dt M - K) T0 + F0 + F1
        mulAdd(S.pat, S.M, T, a, rhs); mulAdd(S.pat, S.K, T, -1, rhs);
        for (let i = 0; i < n; i++) rhs[i]! += Fprev[i]! + Ft[i]!;
      } else {
        const bdf2 = method === 'bdf2' && s > 1;
        a = bdf2 ? 1.5 / tr.dt : 1 / tr.dt;
        const w = Float64Array.from(T, (v, i) => (bdf2 ? (2 * v - 0.5 * Tm1[i]!) / tr.dt : v / tr.dt));
        mulAdd(S.pat, S.M, w, 1, rhs);
        for (let i = 0; i < n; i++) rhs[i]! += Ft[i]!;
      }
      Tm1 = T.slice();
      applyDirichlet(m, S, T, t);
      newton.push(solveStep(m, S, cache, kind, T, a, rhs, t, timer, tol, maxIt));
      Fprev = Ft;
      push(s, t);
    }
    times = Float64Array.from(out);
  }
  const t0 = performance.now();
  let Tmax = -Infinity, Tmin = Infinity;
  for (let i = 0; i < n; i++) if (S.active[i]) { Tmax = Math.max(Tmax, T[i]!); Tmin = Math.min(Tmin, T[i]!); }
  timer.add('post', performance.now() - t0);
  let nActive = 0; for (let i = 0; i < n; i++) nActive += S.active[i]!;
  const dof = nActive - S.fixedNodes.length;
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { physics: 'heat', bcs: p.bcs.map((b) => b.type), n } }),
    fields, ...(times ? { steps: { kind: 'time' as const, values: times, unit: 's' } } : {}),
    scalars: { T_max: scalar(Tmax, 'K'), T_min: scalar(Tmin, 'K') },
    stats: { dof, nnz: S.pat.nnz, iterations: newton.reduce((s, v) => s + v, 0), solver: `${kind}${S.rad.length ? '+newton' : ''}${p.transient ? `+${method}` : ''}` },
    timer,
  });
  attachMesh(sol, m);
  return Object.assign(sol, { detail: { ...(times ? { times } : {}), newton, dof, solver: kind }, T });
}

// ------------------------------------------------------------------------------------------------- spec binding

export function heatProblemFromContext(ctx: RunContext): HeatProblem {
  const spec = ctx.spec as Spec, m = ctx.mesh;
  const sp = spaceOf(m);
  const transient = ctx.study.type === 'time';
  const { mask, values } = cellProps(ctx, transient ? ['k', 'rho', 'cp'] : ['k']);
  const nc = nCells(m);
  const k = Float64Array.from(values.k!, (v, c) => (mask[c] ? v : NaN));
  const bcs: HeatBc[] = [];
  const f = (v: unknown, what: string, vars: 'space' | 'time' | 'spacetime' = 'spacetime') => compileField(spec, v, sp, what, vars);
  const sources: Array<{ cm: Uint8Array; Q: FieldValue }> = [];
  for (const b of bcsOf(spec, ctx.physicsId)) {
    const s = b.settings ?? {};
    switch (b.type) {
      case 'temperature': bcs.push({ type: 'temperature', select: b.select, T: f(s.T, `${b.id}.T`) }); break;
      case 'heat-flux': bcs.push({ type: 'heat-flux', select: b.select, q: f(s.q, `${b.id}.q`) }); break;
      case 'convection': bcs.push({ type: 'convection', select: b.select, h: f(s.h, `${b.id}.h`, 'space'), T_ext: f(s.T_ext, `${b.id}.T_ext`) }); break;
      case 'surface-radiation': bcs.push({ type: 'radiation', select: b.select, emissivity: qty(spec, s.emissivity, `${b.id}.emissivity`), T_amb: f(s.T_amb, `${b.id}.T_amb`) }); break;
      case 'insulation': bcs.push({ type: 'insulation', select: b.select }); break;
      case 'heat-source': sources.push({ cm: cellMask(m, b.select), Q: f(s.Q, `${b.id}.Q`) }); break;
      default: throw new Error(`heat: unsupported condition type '${b.type}'`);
    }
  }
  const p: HeatProblem = { mesh: m, k, mask, bcs, spec, signal: ctx.signal };
  if (sources.length) p.sources = sources.map((sc) => ({ mask: sc.cm, Q: sc.Q }));
  if (transient) {
    const st = (ctx.study.settings ?? {}) as { start?: unknown; stop?: unknown; dt?: unknown; step?: unknown; method?: string; output?: unknown[] };
    const ph = physicsNode(spec, ctx.physicsId) as { settings?: { T0?: unknown } };
    if (ph.settings?.T0 === undefined) throw new Error('heat: a time study needs physics settings.T0 (initial temperature)');
    const method = st.method;
    if (method !== 'bdf1' && method !== 'bdf2' && method !== 'crank-nicolson') throw new Error(`heat: time method '${method}' is not implemented (bdf1, bdf2, crank-nicolson)`);
    p.rhoCp = Float64Array.from(values.rho!, (v, c) => v * values.cp![c]!);
    p.transient = {
      t0: qty(spec, st.start, 'study.start'), t1: qty(spec, st.stop, 'study.stop'), dt: qty(spec, st.dt ?? st.step, 'study.dt'),
      T0: f(ph.settings.T0, 'settings.T0', 'space'), method,
      ...(st.output ? { save: st.output.map((o, i) => qty(spec, o, `study.output[${i}]`)) } : {}),
    };
  }
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
      for (const st of (spec as Spec).studies ?? []) {
        const s = st as { type: string; physics?: string[]; settings?: { method?: string } };
        if (s.type === 'time' && (!s.physics || s.physics.includes(physicsId)) && s.settings?.method === 'generalized-alpha') reasons.push(`study '${(st as { id: string }).id}': generalized-alpha is not implemented for heat (bdf1, bdf2, crank-nicolson)`);
      }
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
