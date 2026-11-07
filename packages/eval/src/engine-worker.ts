// SPDX-License-Identifier: GPL-3.0-or-later
// Worker entry for one engine case (audit B1): loads @amp/physics / @amp/spec / @amp/post from the repo root, runs
// every mesh level through prepareRun + module.run, extracts the targets while each level's mesh is alive (audit B5),
// optionally times every level (warm-up + median of 5, audit S5) and posts one structured-clone result. The parent
// enforces the wall-clock timeout (terminate) and the heap cap (resourceLimits).

import { parentPort, workerData } from 'node:worker_threads';
import type { EvalCase } from './loader.ts';
import type { LevelObservation, TargetObservation } from './evaluate.ts';
import type { Solution } from './contract-shim.ts';
import type { Spec } from './contract-shim.ts';
import { callPrepare, extractFromSolution, loadDefaultRegistry, setUnitsApi, specRuntime, type WorkerResult, type WorkerTarget } from './registry.ts';
import { timeRuns } from './speed.ts';
import type { LevelTimingSummary } from './source.ts';

interface Data { root: string; caseData: EvalCase; spec: Spec; physicsId: string; type: string; factors: number[]; speed: boolean; targets: WorkerTarget[]; timeoutMs: number }

async function main(d: Data): Promise<WorkerResult> {
  const { registry } = await loadDefaultRegistry(d.root);
  if (registry.loadError) throw new Error(`engine load failed: ${registry.loadError}`);
  const mod = registry.modules.get(d.type);
  if (!mod || !registry.prepare) throw new Error(`module '${d.type}' or prepareRun missing in the worker`);
  const sr = await specRuntime(d.root, registry.specRegistry);
  setUnitsApi(sr.rt?.units ?? null);
  const signal = AbortSignal.timeout(d.timeoutMs);
  const once = async (level: number) => {
    const t0 = performance.now();
    const ctx = await callPrepare(registry.prepare!, { case: d.caseData, spec: d.spec, physicsId: d.physicsId, level, hFactor: d.factors[level]!, signal });
    const sol: Solution = await mod.run(ctx);
    return { ctx, sol, wall_ms: performance.now() - t0 };
  };
  const levels: WorkerResult['levels'] = [];
  const per = new Map<string, LevelObservation[]>();
  const bad = new Map<string, { pending: string } | { error: string }>();
  for (let i = 0; i < d.factors.length; i++) {
    const { ctx, sol, wall_ms } = await once(i);
    levels.push({ level: i, hFactor: d.factors[i]!, dof: sol.stats.dof, meshHash: sol.meshHash, run: sol.run, wall_ms, stages: sol.timing, ...(sol.stats.iterations !== undefined ? { iterations: sol.stats.iterations } : {}) });
    for (const t of d.targets) {
      if (bad.has(t.tid)) continue;
      const ex = extractFromSolution(sol, t.ref, { mesh: ctx.mesh, ...(registry.sample ? { sample: registry.sample } : {}), ...(t.points ? { points: t.points } : {}) });
      if (!('value' in ex)) { bad.set(t.tid, ex); continue; }
      const arr = per.get(t.tid) ?? [];
      arr.push({ value: ex.value, dof: sol.stats.dof, wall_ms, stages: sol.timing, meshHash: sol.meshHash, ...(sol.stats.iterations !== undefined ? { iterations: sol.stats.iterations } : {}) });
      per.set(t.tid, arr);
    }
  }
  const targets: Record<string, TargetObservation | { pending: string } | { error: string }> = {};
  for (const t of d.targets) targets[t.tid] = bad.get(t.tid) ?? { levels: per.get(t.tid) ?? [] };
  let speed: WorkerResult['speed'];
  if (d.speed) {
    const lt: LevelTimingSummary[] = [];
    for (let i = 0; i < d.factors.length; i++) {
      const t = await timeRuns(async () => (await once(i)).sol, { warmup: 1, repeats: 5 });
      lt.push({ level: i, dof: t.last.stats.dof, warmup_ms: t.summary.warmup_ms, samples_ms: t.summary.samples_ms, median_ms: t.summary.median_ms, mad_ms: t.summary.mad_ms, stages_median_ms: t.summary.stages_median_ms, iterations: t.last.stats.iterations ?? null });
    }
    speed = { protocol: 'warmup1_median5_per_level', levels: lt };
  }
  return { ok: true, targets, levels, ...(speed ? { speed } : {}) };
}

main(workerData as Data).then(
  (r) => parentPort!.postMessage(r),
  (e) => parentPort!.postMessage({ ok: false, error: `run failed: ${(e as Error).message}` }),
);
