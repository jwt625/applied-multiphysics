// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic Poisson speed harness on @amp/core (structured Q1 hex grid on the unit cube, dimensionless).
//   bp3: -lap u = f, u = 0 on the boundary, manufactured u = sin(pi x) sin(pi y) sin(pi z), f = 3 pi^2 u.
//   bp1: mass M u = F (L2 projection of the same u), no boundary condition.
// Throughput (CEED BP-style, Fischer et al. 2020 eq. 3): Jacobi-PCG with a fixed iteration count, DOF x iterations / s.
//   NOT a conforming CEED BP (recorded as conforming_ceed: false in every record): Q1 only (p = 1), 3x3x3 Gauss load
//   quadrature, assembled 27-point stencil (not matrix-free), one process. DOF is reported both ways (audit M5):
//   dof_all = all (n+1)^3 nodes, which @amp/core pcg touches every iteration (Dirichlet rows are identity rows), and
//   dof_free = unknowns (non-Dirichlet nodes); r_max and n_0.8 are given for both. The initial guess is reset outside
//   the timed region; pcg's own 4 work vectors are allocated inside it (core API).
// Time-to-accuracy: MG-preconditioned CG to rtol 1e-10 on a mesh sequence; error = max nodal |u_h - u| / max |u|;
//   wall = assemble + constrain + MG setup + solve. Protocol: 1 warm-up + median of 5 per level.

import { cpus, platform, arch, release } from 'node:os';
import { join } from 'node:path';
import { importWorkspace } from '../src/workspace.ts';
import { isoWithOffset, repoCommit, timestampStamp, writeUnique } from '../src/node-io.ts';
import { ceedThroughput, throughputSummary, timeRuns, timeToAccuracy, type TimingSummary } from '../src/speed.ts';
import { convergenceRateFit, richardson } from '../src/metrics.ts';

type F64 = Float64Array;
interface Stencil { NX: number; NY: number; NZ: number; N: number; A: F64; fixed: Uint8Array; pad: number }
interface CoreLA {
  createStencil(NX: number, NY: number, NZ: number): Stencil;
  padded(op: Stencil): F64;
  pcg(op: Stencil, pc: (r: F64, z: F64) => void, b: F64, x: F64, o?: { rtol?: number; maxIter?: number }): { iterations: number; relres: number; converged: boolean };
  jacobiPrecond(op: Stencil): (r: F64, z: F64) => void;
  buildMG(op: Stencil, xs: F64, ys: F64, o?: Record<string, unknown>): unknown;
  mgPrecond(mg: unknown, r: F64, z: F64): F64;
  assembleConduction(grid: Grid, k: F64, op: Stencil, stride?: number): void;
  assembleMass(grid: Grid, rc: F64, op: Stencil, lumped?: boolean): void;
  addFieldSource(grid: Grid, F: F64, f: (x: number, y: number, z: number) => number): number;
  applyConstraints(op: Stencil, F: F64, Td: F64, active: Uint8Array): unknown;
}
interface Grid { nx: number; ny: number; nz: number; xs: F64; ys: F64; zs: F64; cellPart: Int32Array }

export async function loadCore(root?: string): Promise<{ core: CoreLA | null; reason: string; version?: string }> {
  const parts = ['@amp/core/la/stencil', '@amp/core/la/pcg', '@amp/core/la/mg', '@amp/core/fem/q1-grid'];
  const mods: Record<string, unknown>[] = [];
  let version: string | undefined;
  for (const p of parts) {
    const r = await importWorkspace(p, root);
    if (!r.mod) return { core: null, reason: r.reason };
    mods.push(r.mod);
    version = r.version;
  }
  const core = Object.assign({}, ...mods) as CoreLA;
  for (const f of ['createStencil', 'padded', 'pcg', 'jacobiPrecond', 'buildMG', 'mgPrecond', 'assembleConduction', 'assembleMass', 'addFieldSource', 'applyConstraints'] as const) {
    if (typeof core[f] !== 'function') return { core: null, reason: `@amp/core: missing export ${f}` };
  }
  return { core, reason: 'ok', ...(version ? { version } : {}) };
}

const uExact = (x: number, y: number, z: number) => Math.sin(Math.PI * x) * Math.sin(Math.PI * y) * Math.sin(Math.PI * z);

function unitGrid(n: number): Grid {
  const xs = Float64Array.from({ length: n + 1 }, (_, i) => i / n);
  return { nx: n, ny: n, nz: n, xs, ys: xs.slice(), zs: xs.slice(), cellPart: new Int32Array(n * n * n) };
}

export interface Problem { op: Stencil; b: F64; grid: Grid; dofFree: number; stages: Record<string, number> }

export function buildProblem(core: CoreLA, kind: 'bp1' | 'bp3', n: number): Problem {
  const st: Record<string, number> = {};
  let t = performance.now();
  const grid = unitGrid(n);
  const op = core.createStencil(n + 1, n + 1, n + 1);
  const nc = n * n * n;
  if (kind === 'bp3') core.assembleConduction(grid, new Float64Array(3 * nc).fill(1), op);
  else core.assembleMass(grid, new Float64Array(nc).fill(1), op);
  const F = new Float64Array(op.N);
  const f = kind === 'bp3' ? (x: number, y: number, z: number) => 3 * Math.PI * Math.PI * uExact(x, y, z) : uExact;
  core.addFieldSource(grid, F, f);
  st.assemble = performance.now() - t;
  t = performance.now();
  const N1 = n + 1;
  const Td = new Float64Array(op.N).fill(NaN);
  let dofFree = op.N;
  if (kind === 'bp3') {
    for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      if (i === 0 || j === 0 || k === 0 || i === n || j === n || k === n) { Td[i + N1 * (j + N1 * k)] = 0; dofFree--; }
    }
  }
  core.applyConstraints(op, F, Td, new Uint8Array(op.N).fill(1));
  st.constrain = performance.now() - t;
  const b = core.padded(op);
  b.set(F, op.pad);
  return { op, b, grid, dofFree, stages: st };
}

function nodalError(x: F64, op: Stencil, n: number): { max_rel: number; u_center: number | null } {
  const N1 = n + 1;
  let e = 0, m = 0;
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const u = uExact(i / n, j / n, k / n);
    e = Math.max(e, Math.abs(x[op.pad + i + N1 * (j + N1 * k)]! - u));
    m = Math.max(m, Math.abs(u));
  }
  const c = n % 2 === 0 ? x[op.pad + n / 2 + N1 * (n / 2 + N1 * (n / 2))]! : null;
  return { max_rel: e / m, u_center: c };
}

export interface BenchArgs { io?: { out: (s: string) => void; err: (s: string) => void }; kind: string; sizes?: string | undefined; iters?: number; root: string; outDir: string; json: boolean; noLog: boolean; log: (m: string) => void; tol?: number }

export async function runBench(a: BenchArgs): Promise<number> {
  const io = a.io ?? { out: (s: string) => { process.stdout.write(s); }, err: (s: string) => { process.stderr.write(s); } };
  const kinds = a.kind === 'all' ? ['bp1', 'bp3'] : [a.kind];
  if (!kinds.every((k) => k === 'bp1' || k === 'bp3')) { io.err(`--bench must be bp1, bp3 or all\n`); return 1; }
  const { core, reason, version } = await loadCore(a.root);
  if (!core) { io.err(`@amp/core not available: ${reason}\n`); return 1; }
  const sizes = (a.sizes ?? '8,16,32,64').split(',').map(Number);
  if (!sizes.every((s) => Number.isInteger(s) && s >= 2)) { io.err('--sizes: integers >= 2\n'); return 1; }
  const iters = a.iters ?? 50;
  const tol = a.tol ?? 1e-3;
  const started = new Date();
  const records: unknown[] = [{
    kind: 'meta', schema: 'amp-eval-bench/0', label: 'BP1/BP3-style, non-conforming (Q1, assembled stencil)', conforming_ceed: false, dof_counting: 'mdof_per_s on all nodes; mdof_per_s_free on unknowns', started_at: isoWithOffset(started), harness: `@amp/eval@0.0.0+${repoCommit(a.root)}`,
    core: `@amp/core@${version ?? '?'}`, problem: 'unit cube, Q1 hex, u = sin(pi x) sin(pi y) sin(pi z)', fixed_iterations: iters, tta_tol_rel: tol,
    platform: { runtime: 'node', node: process.version, os: `${platform()} ${release()}`, arch: arch(), cores: cpus().length, cpu: cpus()[0]?.model ?? 'unknown' },
  }];
  const out: Record<string, unknown> = {};
  for (const kind of kinds as Array<'bp1' | 'bp3'>) {
    const sweep: Array<{ n: number; dof: number; dof_free: number; iterations: number; solve: TimingSummary; dof_per_s: number; mdof_per_s: number; mdof_per_s_free: number }> = [];
    const levels: Array<{ n: number; dof: number; wall: TimingSummary; iterations: number; err: number; u_center: number | null; stages: Record<string, number> }> = [];
    for (const n of sizes) {
      // Throughput: Jacobi-PCG, fixed iterations (rtol 0), warm-up + median of 5 of the solve only.
      const P = buildProblem(core, kind, n);
      const pc = core.jacobiPrecond(P.op);
      let its = 0;
      const x0 = core.padded(P.op);
      const t = await timeRuns(() => {
        const r = core.pcg(P.op, pc, P.b, x0, { rtol: 0, maxIter: iters });
        its = r.iterations;
        return r;
      }, { setup: () => x0.fill(0) });
      const dofAll = P.op.N;
      const thr = ceedThroughput(dofAll, its, t.summary.median_ms / 1000);
      const thrFree = ceedThroughput(P.dofFree, its, t.summary.median_ms / 1000);
      sweep.push({ n, dof: dofAll, dof_free: P.dofFree, iterations: its, solve: t.summary, dof_per_s: thr.dof_per_s, mdof_per_s: thr.mdof_per_s, mdof_per_s_free: thrFree.mdof_per_s });
      a.log(`${kind}-style n=${n} dof_all=${dofAll} dof_free=${P.dofFree} jacobi-pcg ${its} it median ${t.summary.median_ms.toFixed(2)} ms -> ${thr.mdof_per_s.toFixed(2)} MDOF/s (all nodes), ${thrFree.mdof_per_s.toFixed(2)} (free)`);
      records.push({ kind: 'throughput', bench: `${kind}-style`, conforming_ceed: false, n, dof_all: dofAll, dof_free: P.dofFree, ...t.summary, ...thr, dof_counting: 'all_nodes', mdof_per_s_free: thrFree.mdof_per_s, stages_ms: P.stages });

      // Time-to-accuracy level: full pipeline with MG-PCG to rtol 1e-10.
      let last: { x: F64; iterations: number; stages: Record<string, number> } | null = null;
      const w = await timeRuns(() => {
        const Q = buildProblem(core, kind, n);
        let t0 = performance.now();
        const mg = core.buildMG(Q.op, Q.grid.xs, Q.grid.ys);
        const setup = performance.now() - t0;
        t0 = performance.now();
        const x = core.padded(Q.op);
        const r = core.pcg(Q.op, (rr, zz) => { core.mgPrecond(mg, rr, zz); }, Q.b, x, { rtol: 1e-10, maxIter: 500 });
        const solve = performance.now() - t0;
        last = { x, iterations: r.iterations, stages: { ...Q.stages, mg_setup: setup, solve } };
        return { timing: last.stages };
      });
      const L = last as unknown as { x: F64; iterations: number; stages: Record<string, number> };
      const ne = nodalError(L.x, P.op, n);
      levels.push({ n, dof: P.dofFree, wall: w.summary, iterations: L.iterations, err: ne.max_rel, u_center: ne.u_center, stages: w.summary.stages_median_ms });
      a.log(`${kind} n=${n} mg-pcg ${L.iterations} it, wall median ${w.summary.median_ms.toFixed(2)} ms, max rel nodal error ${ne.max_rel.toExponential(3)}`);
      records.push({ kind: 'level', bench: `${kind}-style`, conforming_ceed: false, n, dof: P.dofFree, iterations: L.iterations, error_max_rel: ne.max_rel, u_center: ne.u_center, ...w.summary });
    }
    const tta = timeToAccuracy(levels.map((l, i) => ({ level: i, dof: l.dof, wall_ms: l.wall.median_ms, error: l.err })), tol);
    const hs = levels.map((l) => 1 / l.n);
    const rate = convergenceRateFit(hs, levels.map((l) => l.err));
    const cen = levels.filter((l) => l.u_center !== null);
    const ri = cen.length >= 3 ? richardson(cen.map((l) => l.u_center!), cen.map((l) => 1 / l.n)) : null;
    const ts = throughputSummary(sweep.map((s) => ({ dof: s.dof, dof_per_s: s.dof_per_s })));
    const tsFree = throughputSummary(sweep.map((s) => ({ dof: s.dof_free, dof_per_s: s.mdof_per_s_free * 1e6 })));
    records.push({ kind: 'summary', bench: `${kind}-style`, conforming_ceed: false, throughput_free: tsFree, time_to_accuracy: tta, rate, richardson_u_center: ri, u_center_exact: 1, throughput: ts });
    out[kind] = { sweep, levels, tta, rate, richardson_u_center: ri, throughput: ts, throughput_free: tsFree };
  }
  const stamp = timestampStamp(started);
  let path: string | null = null;
  if (!a.noLog) {
    path = writeUnique(a.outDir, `bench-poisson-${stamp}`, [{ suffix: '.jsonl', text: records.map((r) => JSON.stringify(r)).join('\n') + '\n' }])[0]!;
  }
  if (a.json) io.out(JSON.stringify({ records, jsonl: path }) + '\n');
  else {
    type Row = { n: number; dof: number; dof_free: number; iterations: number; solve: TimingSummary; mdof_per_s: number; mdof_per_s_free: number };
    type Lv = { n: number; dof: number; wall: TimingSummary; iterations: number; err: number };
    type Sum = ReturnType<typeof throughputSummary>;
    for (const [k, v] of Object.entries(out) as Array<[string, { sweep: Row[]; levels: Lv[]; tta: ReturnType<typeof timeToAccuracy>; rate: ReturnType<typeof convergenceRateFit>; richardson_u_center: ReturnType<typeof richardson> | null; throughput: Sum; throughput_free: Sum }]>) {
      io.out(`\n${k.toUpperCase()}-style (non-conforming): n | DOF all | DOF free | Jacobi-PCG it | solve median ms | MDOF/s all | MDOF/s free | MG-PCG it | wall median ms | max rel err\n`);
      v.sweep.forEach((s, i) => {
        const l = v.levels[i]!;
        io.out(`  ${s.n} | ${s.dof} | ${s.dof_free} | ${s.iterations} | ${s.solve.median_ms.toFixed(2)} | ${s.mdof_per_s.toFixed(2)} | ${s.mdof_per_s_free.toFixed(2)} | ${l.iterations} | ${l.wall.median_ms.toFixed(2)} | ${l.err.toExponential(3)}\n`);
      });
      io.out(`  rate fit ${v.rate.rate.toFixed(3)} (r2 ${v.rate.r2.toFixed(4)}); r_max ${(v.throughput.r_max / 1e6).toFixed(2)} MDOF/s all nodes (n_0.8 ${v.throughput.n_08}), ${(v.throughput_free.r_max / 1e6).toFixed(2)} free (n_0.8 ${v.throughput_free.n_08}); `);
      io.out(`T_tol(${tol}) ${v.tta.reached ? `${v.tta.t_level_ms!.toFixed(1)} ms single, ${v.tta.t_cum_ms!.toFixed(1)} ms cumulative, ${v.tta.t_interp_ms!.toFixed(1)} ms interp (estimate)` : `not reached (min err ${v.tta.min_error.toExponential(3)})`}\n`);
      if (v.richardson_u_center) io.out(`  u(center) Richardson: f_ext ${v.richardson_u_center.f_ext} p_obs ${v.richardson_u_center.p_obs} GCI ${v.richardson_u_center.gci_fine} (exact 1)\n`);
    }
    if (path) io.out(`records: ${path}\n`);
  }
  return 0;
}
