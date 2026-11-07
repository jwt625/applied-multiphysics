// SPDX-License-Identifier: GPL-3.0-or-later
// Runner: loaded cases + a source -> case and target results; exit code policy.

import type { LoadedCase, LoadIssue } from './loader.ts';
import { getPath, referenceValue, targetId } from './loader.ts';
import { evaluateTarget, pendingTarget, type TargetObservation, type TargetResult } from './evaluate.ts';
import { timeToAccuracy, type TimeToAccuracy } from './speed.ts';
import type { ObserveOptions, Source, SpeedRecord } from './source.ts';
import type { evaluateExactField } from './adapters/fields.ts';

export type CaseStatus = 'pass' | 'fail' | 'pending' | 'error' | 'timeout';

export interface CaseResult {
  case: string;
  file: string;
  class: string | null;
  physics: string[];
  status: CaseStatus;
  reason?: string;
  source: string;
  targets: TargetResult[];
  run: Record<string, unknown> | null;
  issues: LoadIssue[];
  speed?: SpeedRecord & { time_to_accuracy?: Record<string, TimeToAccuracy> };
  levelRuns?: Array<{ level: number; dof: number; meshHash: string; wall_ms: number; spec?: string }>;
}

export interface RunOptions extends ObserveOptions { dryRun?: boolean; exactField?: typeof evaluateExactField }

export function caseStatus(targets: TargetResult[], loaderErrors: number): CaseStatus {
  if (targets.some((t) => t.status === 'timeout')) return 'timeout';
  if (loaderErrors > 0 || targets.some((t) => t.status === 'error')) return 'error';
  const gated = targets.filter((t) => t.gated);
  if (gated.some((t) => t.status === 'fail')) return 'fail';
  if (gated.length && gated.every((t) => t.status === 'pass')) return 'pass';
  return 'pending';
}

function samplesFor(lc: LoadedCase, key: string | undefined): number[] | undefined {
  if (!key) return undefined;
  const s = getPath(lc.expected, key) as { values?: unknown } | undefined;
  // flat, or one array per component (concatenated component-major)
  return Array.isArray(s?.values) ? (s!.values as Array<number | number[]>).flat() : undefined;
}

export async function runCase(lc: LoadedCase, source: Source, opts: RunOptions = {}): Promise<CaseResult> {
  const errors = lc.issues.filter((i) => i.severity === 'error');
  const c = lc.data;
  const base: CaseResult = {
    case: typeof c?.id === 'string' ? c.id : lc.file, file: lc.file, class: typeof c?.class === 'string' ? c.class : null,
    physics: Array.isArray(c?.physics) ? c!.physics : [], status: 'pending', source: source.name, targets: [], run: null, issues: lc.issues,
  };
  if (!c || errors.length) return { ...base, status: 'error', reason: `${errors.length} loader error(s)` };
  const refs = c.references;
  if (c.status === 'untestable') {
    return { ...base, status: 'pending', reason: `untestable: ${c.untestable_reason}`, targets: refs.map((r) => pendingTarget(r, referenceValue(r, lc.expected), `untestable: ${c.untestable_reason}`)) };
  }
  if (opts.dryRun) {
    const p = await source.plan(lc);
    const st = p.error ? 'error' : 'pending';
    return { ...base, status: st, reason: `dry run: ${p.reason}`, targets: refs.map((r) => pendingTarget(r, referenceValue(r, lc.expected), `dry run: ${p.reason}`, st)) };
  }
  let obs;
  try { obs = await source.observe(lc, opts); } catch (e) { obs = { kind: 'error' as const, reason: `source threw: ${(e as Error).message}` }; }
  if (obs.kind !== 'observed') {
    const st = obs.kind === 'error' ? 'error' : obs.kind === 'timeout' ? 'timeout' : 'pending';
    return { ...base, status: st, reason: obs.reason, targets: refs.map((r) => pendingTarget(r, referenceValue(r, lc.expected), obs.reason, st)) };
  }
  const conv = c.convergence ?? undefined;
  const targets: TargetResult[] = [];
  for (const r of refs) targets.push(await (async (): Promise<TargetResult> => {
    const ref = referenceValue(r, lc.expected);
    const o = obs.targets[targetId(r)];
    if (!o) return pendingTarget(r, ref, `${source.name} returned nothing for this target`);
    if ('pending' in o) return pendingTarget(r, ref, o.pending);
    if ('error' in o) return pendingTarget(r, ref, o.error, 'error');
    if ('timeout' in o) return pendingTarget(r, ref, o.timeout, 'timeout');
    let rs = samplesFor(lc, r.extract?.samples_key);
    if (!rs && r.extract?.kind === 'field' && r.extract.evaluator && r.extract.points) {
      try {
        const exact = opts.exactField ?? (await import('./adapters/fields.ts')).evaluateExactField; // Node only, loaded lazily
        // tensor / vector targets: one evaluator field per engine component, concatenated in the same order
        const ex = r.extract;
        const n = ex.fields?.length ?? ex.components?.length ?? 1;
        const names = ex.evaluator_fields ?? ex.fields ?? (n > 1 ? null : [(ex.field ?? ex.name)!]);
        if (!names) return pendingTarget(r, ref, 'vector field target needs evaluator_fields (one per component)', 'error');
        rs = [];
        for (const name of names) {
          const ef = await exact(ex.evaluator!, ex.evaluator_case ?? c.id, name, ex.points!, { ...(ex.params ? { params: ex.params } : {}) });
          if (ef.unit !== undefined && ef.unit !== r.unit) return pendingTarget(r, ref, `evaluator unit '${ef.unit}' (${name}) vs reference unit '${r.unit}'`, 'error');
          // complex fields: re and im concatenated, so the L2 norm is the complex L2 norm
          rs.push(...(Array.isArray(ef.values) ? ef.values : [...ef.values.re, ...ef.values.im]));
        }
      } catch (e) { return pendingTarget(r, ref, `exact-field evaluator: ${(e as Error).message}`, 'error'); }
    }
    return evaluateTarget(r, ref, o as TargetObservation, {
      ...(obs.dim !== undefined ? { dim: obs.dim } : {}),
      ...(rs ? { refSamples: rs } : {}),
      ...(conv?.expected_order !== undefined ? { expectedOrder: conv.expected_order } : {}),
      ...(conv?.safety_factor !== undefined ? { safetyFactor: conv.safety_factor } : {}),
      ...(conv?.order_band !== undefined ? { orderBand: conv.order_band } : {}),
      ...(conv?.order_check !== undefined ? { orderCheck: conv.order_check } : {}),
    });
  })());
  const res: CaseResult = { ...base, targets, run: obs.run as Record<string, unknown>, status: caseStatus(targets, 0) };
  if (obs.levelRuns) res.levelRuns = obs.levelRuns;
  if (obs.speed) {
    // S5: per-level medians (warm-up + median of 5) drive time-to-accuracy; S6: judged against the native budget only
    const med = obs.speed.levels.map((l) => l.median_ms);
    const tta: Record<string, TimeToAccuracy> = {};
    let tTol: number | null = 0;
    for (const t of targets) {
      if (!t.levels || t.limit === undefined || t.levels.some((l) => l.err === undefined)) continue;
      const x = timeToAccuracy(t.levels.map((l, i) => ({ level: i, dof: l.dof ?? NaN, wall_ms: med[i] ?? NaN, error: l.err! })), t.limit);
      tta[t.target] = x;
      if (!t.gated) continue;
      const tt = !x.reached ? null : t.tol.after === 'richardson' ? med.reduce((a, b) => a + b, 0) : x.t_cum_ms;
      tTol = tTol === null || tt === null ? null : Math.max(tTol, tt);
    }
    const native = c.speed?.budget_s?.native ?? undefined;
    const allPass = targets.filter((t) => t.gated).every((t) => t.status === 'pass');
    res.speed = {
      ...obs.speed, time_to_accuracy: tta, t_tol_ms: allPass ? tTol : null,
      ...(native !== undefined && native !== null ? { budget_s: native } : {}),
      meets_budget: native === undefined || native === null || !allPass || tTol === null ? null : tTol / 1000 <= native,
      ...(native === undefined || native === null ? { budget_note: 'pending: no budget_s.native (the browser budget is judged by the browser runner)' } : !allPass ? { budget_note: 'pending: a gated target does not pass' } : {}),
    };
  }
  if (res.status !== 'pass') {
    const bad = targets.filter((t) => t.status === 'fail' || t.status === 'error' || t.status === 'pending');
    if (bad.length) res.reason = bad.map((t) => `${t.target}: ${t.status}${t.reason ? ` (${t.reason})` : ''}`).join('; ');
  }
  return res;
}

export async function runCases(cases: LoadedCase[], source: Source, opts: RunOptions = {}): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const lc of cases) out.push(await runCase(lc, source, opts));
  return out;
}

/** 0 = pass (pending allowed unless strict), 1 = error / timeout (or a gated pending target with strict), 2 = a
 * gated target missed. Errors take precedence. */
export function exitCode(results: CaseResult[], opts: { strict?: boolean } = {}): 0 | 1 | 2 {
  if (results.some((r) => r.status === 'error' || r.status === 'timeout')) return 1;
  if (opts.strict && results.some((r) => r.targets.some((t) => t.gated && t.status === 'pending'))) return 1;
  if (results.some((r) => r.status === 'fail')) return 2;
  return 0;
}
