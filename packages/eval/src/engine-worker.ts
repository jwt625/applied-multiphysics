// SPDX-License-Identifier: GPL-3.0-or-later
// Worker entry for one engine case (audit B1): loads @amp/physics / @amp/spec / @amp/post from the repo root, runs
// every mesh level through prepareRun + module.run, extracts the targets while each level's mesh is alive (audit B5),
// optionally times every level (warm-up + median of 5, audit S5) and posts one structured-clone result. The parent
// enforces the wall-clock timeout (terminate) and the heap cap (resourceLimits).

import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EvalCase } from './loader.ts';
import type { LevelObservation, TargetObservation } from './evaluate.ts';
import type { Solution } from './contract-shim.ts';
import type { Spec } from './contract-shim.ts';
import { callPrepare, dtFactorsFor, extractFromSolution, loadDefaultRegistry, setExpressionCompiler, setUnitsApi, specRuntime, type ResultEvaluator, type WorkerResult, type WorkerTarget } from './registry.ts';
import { importWorkspace } from './workspace.ts';
import { timeRuns } from './speed.ts';
import type { LevelTimingSummary } from './source.ts';

interface Data { root: string; caseData: EvalCase; spec: Spec; physicsId: string; type: string; factors: number[]; levelIdx: number[]; speed: boolean; targets: WorkerTarget[]; timeoutMs: number }

async function main(d: Data): Promise<WorkerResult> {
  const { registry } = await loadDefaultRegistry(d.root);
  if (registry.loadError) throw new Error(`engine load failed: ${registry.loadError}`);
  const mod = registry.modules.get(d.type);
  if (!mod || !registry.prepare) throw new Error(`module '${d.type}' or prepareRun missing in the worker`);
  const sr = await specRuntime(d.root, registry.specRegistry);
  setUnitsApi(sr.rt?.units ?? null);
  if (d.targets.some((t) => JSON.stringify(t.ref.extract ?? {}).includes('"expr"'))) {
    const ce = await importWorkspace<{ compileExpression?: Parameters<typeof setExpressionCompiler>[0] }>('@amp/core/expr', d.root);
    setExpressionCompiler(ce.mod?.compileExpression ?? null);
  }
  // extract kind 'result' (C8, DevLog-028): evaluation items of the spec's results through the web app's results adapter
  // (@amp/post kernels), loaded by path (packages do not depend on apps/web)
  type Adapter = { evalItemValue: (spec: unknown, id: string, run: unknown, o: unknown) => { si: number; siUnit: string } | { error: string } };
  let adapter: Adapter | null = null;
  let adapterReason = '';
  if (d.targets.some((t) => t.ref.extract?.kind === 'result')) {
    try { adapter = (await import(pathToFileURL(join(d.root, 'apps', 'web', 'src', 'lib', 'results', 'adapter.ts')).href)) as Adapter; }
    catch (e) { adapterReason = (e as Error).message.split('\n')[0]!; }
  }
  const resultFor = (sol: Solution, ctx: { mesh: unknown; spec?: unknown; physicsId?: string }): ResultEvaluator | undefined => {
    if (!adapter) return adapterReason ? () => ({ error: `results adapter not loaded: ${adapterReason}` }) : undefined;
    const spec = (ctx.spec && typeof ctx.spec === 'object' && 'results' in ctx.spec ? ctx.spec : d.spec) as { params?: unknown; studies?: Array<{ id?: string; physics?: string[] }> };
    const resolve = (sr.rt as unknown as { resolveParams?: (p: unknown) => { scope: unknown } } | null)?.resolveParams;
    const study = (spec.studies ?? []).find((st) => st.physics?.includes(d.physicsId))?.id;
    const run = { key: 'eval', solution: sol, mesh: ctx.mesh, params: resolve ? resolve(spec.params).scope : new Map(), studies: study ? [study] : [], label: '' };
    const ad = adapter;
    return (node, o) => ad.evalItemValue(spec, node, run, o);
  };
  const signal = AbortSignal.timeout(d.timeoutMs);
  const dtf = dtFactorsFor(d.caseData, d.factors);
  const once = async (level: number) => {
    const t0 = performance.now();
    const ctx = await callPrepare(registry.prepare!, { case: d.caseData, spec: d.spec, physicsId: d.physicsId, level, hFactor: d.factors[level]!, dtFactor: dtf[level]!, signal });
    const t1 = performance.now();
    const sol: Solution = await mod.run(ctx);
    const t2 = performance.now();
    return { ctx, sol, wall_ms: t2 - t0, prepare_ms: t1 - t0, run_ms: t2 - t1 };
  };
  const levels: WorkerResult['levels'] = [];
  const per = new Map<string, LevelObservation[]>();
  const bad = new Map<string, { pending: string } | { error: string }>();
  for (const i of d.levelIdx) {
    // cold: first call of this level in a fresh worker (JIT, geometry, meshing and refinement included)
    const { ctx, sol, wall_ms, prepare_ms, run_ms } = await once(i);
    levels.push({ level: i, timing: 'cold', prepare_ms, run_ms, hFactor: d.factors[i]!, dtFactor: dtf[i]!, dof: sol.stats.dof, meshHash: sol.meshHash, run: sol.run, wall_ms, stages: sol.timing, ...(sol.stats.iterations !== undefined ? { iterations: sol.stats.iterations } : {}) });
    for (const t of d.targets) {
      if (bad.has(t.tid)) continue;
      if (t.ref.levels && !t.ref.levels.includes(i)) continue;   // per-target levels
      const rf = t.ref.extract?.kind === 'result' ? resultFor(sol, ctx as { mesh: unknown; spec?: unknown }) : undefined;
      const ex = extractFromSolution(sol, t.ref, { mesh: ctx.mesh, ...(registry.sample ? { sample: registry.sample } : {}), ...(t.points ? { points: t.points } : {}), ...(rf ? { result: rf } : {}) });
      if (!('value' in ex)) { bad.set(t.tid, ex); continue; }
      const arr = per.get(t.tid) ?? [];
      arr.push({ value: ex.value, h: d.factors[i]!, dof: sol.stats.dof, wall_ms, stages: sol.timing, meshHash: sol.meshHash, ...(sol.stats.iterations !== undefined ? { iterations: sol.stats.iterations } : {}) });
      per.set(t.tid, arr);
    }
  }
  const targets: Record<string, TargetObservation | { pending: string } | { error: string }> = {};
  for (const t of d.targets) targets[t.tid] = bad.get(t.tid) ?? { levels: per.get(t.tid) ?? [] };
  let speed: WorkerResult['speed'];
  if (d.speed) {
    const lt: LevelTimingSummary[] = [];
    for (const i of d.levelIdx) {
      const t = await timeRuns(async () => (await once(i)).sol, { warmup: 1, repeats: 5 });
      lt.push({ level: i, dof: t.last.stats.dof, warmup_ms: t.summary.warmup_ms, samples_ms: t.summary.samples_ms, median_ms: t.summary.median_ms, mad_ms: t.summary.mad_ms, stages_median_ms: t.summary.stages_median_ms, iterations: t.last.stats.iterations ?? null });
    }
    speed = { protocol: 'warmup1_median5_per_level', timing: 'warm', mesh_cache_note: 'warm repeats call prepareRun again in the same worker; @amp/physics may reuse its cached mesh chain, so warm medians can exclude meshing (solve-dominated)', levels: lt };
  }
  return { ok: true, targets, levels, ...(speed ? { speed } : {}) };
}

main(workerData as Data).then(
  (r) => parentPort!.postMessage(r),
  (e) => parentPort!.postMessage({ ok: false, error: `run failed: ${(e as Error).message}` }),
);
