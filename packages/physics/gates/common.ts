// SPDX-License-Identifier: GPL-3.0-or-later
// Shared gate driver for the L4 heroes. Verdicts come from the harness metrics (`@amp/eval` evaluateTarget, read-only
// import), so the gates and L8 apply ONE rule (audit S2): with `after: richardson`, pass needs the extrapolated value
// and the finest level within the budget and the observed order within +-25 % of the theoretical order; an
// oscillatory / non-converging sequence is never extrapolated (Richardson unavailable: finest value within budget and
// non-increasing |error|, reported as such); an out-of-band order fails. Exit code: 0 pass, 1 error, 2 gate missed.
// Logs: JSONL in logs/ with a UTC timestamp.

import { readCase, readExpected, GateLog, waitForLoad, stagesOf, fmt, REPO } from './modes-common.ts';
import { evaluateTarget, type TargetResult } from '../../eval/src/evaluate.ts';
import type { Reference } from '../../eval/src/loader.ts';
import type { Solution } from '@amp/spec/types';

export { readCase, readExpected, GateLog, waitForLoad, stagesOf, fmt, REPO };

export interface Target {
  id: string; ref: number; unit: string; rel?: number; abs?: number;
  /** 'richardson' (default when >= 3 levels) or 'finest' (no extrapolation: e.g. exact-at-nodes problems) */
  after?: 'richardson' | 'finest';
  /** theoretical convergence order of this quantity (gates the observed order, band 0.25) */
  order?: number;
  gate?: boolean;
}
export interface Level { level: number; h: number; dof: number; wall_ms: number; stages: Record<string, number>; values: Record<string, number> }

export function expectedValue(id: string, metric: string): { value: number; unit: string } {
  const e = readExpected(id);
  const t = (e.targets as Array<{ metric_id: string; value: number; unit: string }>).find((x) => x.metric_id === metric);
  if (!t) throw new Error(`${id}: no expected target ${metric}`);
  return { value: t.value, unit: t.unit };
}

/** Case reference by metric_id: value (from the expected file when linked) and tolerance. */
export function caseTarget(cls: string, id: string, metric: string, extra: Partial<Target> = {}): Target {
  const c = readCase(cls, id);
  const r = (c.references as Array<{ metric_id: string; value?: number; unit: string; tolerance: { rel?: number; abs?: number; after?: string }; expected?: { metric_id?: string }; gate?: boolean }>).find((x) => x.metric_id === metric);
  if (!r) throw new Error(`${id}: no reference ${metric}`);
  const ref = r.expected?.metric_id ? expectedValue(id, r.expected.metric_id).value : (r.value as number);
  return {
    id: metric, ref, unit: r.unit, ...(r.tolerance.rel !== undefined ? { rel: r.tolerance.rel } : {}), ...(r.tolerance.abs !== undefined ? { abs: r.tolerance.abs } : {}),
    after: r.tolerance.after === 'richardson' ? 'richardson' : 'finest', ...(r.gate === false ? { gate: false } : {}), ...extra,
  };
}

export interface GateResult { target: string; ref: number; fine: number; value: number | null; p_obs: number | null; err: number | null; limit: number | null; status: string; basis: string; reason?: string }

/** Evaluate targets over levels (coarse -> fine) with the harness rule. */
export function evaluate(levels: Level[], targets: Target[]): GateResult[] {
  return targets.map((t) => {
    const after = t.after ?? (levels.length >= 3 ? 'richardson' : 'finest');
    const ref: Reference = {
      quantity: t.id, metric_id: t.id, unit: t.unit, basis: 'D', form: 'closed_form',
      provenance: { citation: 'L4 gate', locator: 'packages/physics/gates', accessed: null },
      tolerance: { ...(t.rel !== undefined ? { rel: t.rel } : {}), ...(t.abs !== undefined ? { abs: t.abs } : {}), ...(after === 'richardson' ? { after: 'richardson' } : {}) } as Reference['tolerance'],
      ...(t.gate === false ? { gate: false } : {}),
    };
    const obs = { levels: (after === 'richardson' ? levels.slice(-3) : levels).map((l) => ({ value: l.values[t.id]!, dof: l.dof, h: l.h, wall_ms: l.wall_ms })) };
    const r: TargetResult = evaluateTarget(ref, t.ref, obs, { ...(t.order !== undefined ? { expectedOrder: t.order } : {}) });
    const fine = levels[levels.length - 1]!.values[t.id]!;
    const v = typeof r.value === 'number' ? r.value : null;
    return {
      target: t.id, ref: t.ref, fine, value: v, p_obs: r.richardson?.p_obs ?? null, err: v === null ? null : v - t.ref, limit: r.limit ?? null,
      status: r.status, basis: after === 'richardson' ? (r.richardson_fallback ? 'finest+monotone (richardson unavailable)' : 'richardson') : 'finest', ...(r.reason ? { reason: r.reason } : {}),
    };
  });
}

/** First level whose raw value meets every gated target's limit, and the wall time to it (single run and cumulative). */
export function timeToAccuracy(levels: Level[], targets: Target[]): { level: number | null; wall_ms: number | null; cumulative_ms: number | null } {
  let cum = 0;
  for (const l of levels) {
    cum += l.wall_ms;
    const ok = targets.filter((t) => t.gate !== false).every((t) => Math.abs(l.values[t.id]! - t.ref) <= Math.max(t.abs ?? 0, (t.rel ?? 0) * Math.abs(t.ref)));
    if (ok) return { level: l.level, wall_ms: l.wall_ms, cumulative_ms: cum };
  }
  return { level: null, wall_ms: null, cumulative_ms: null };
}

export function printTable(name: string, levels: Level[], res: GateResult[], log: GateLog): void {
  console.log(`\n${name}`);
  for (const l of levels) console.log(`  L${l.level} h=${fmt(l.h)} dof=${l.dof} wall=${l.wall_ms.toFixed(1)} ms ${JSON.stringify(l.stages)} ${Object.entries(l.values).map(([k, v]) => `${k}=${v.toPrecision(10)}`).join(' ')}`);
  for (const r of res) {
    const tag = r.status === 'info' ? 'INFO' : r.status.toUpperCase();
    console.log(`  ${tag} ${r.target}: ref ${r.ref} fine ${r.fine.toPrecision(10)} value ${r.value?.toPrecision(10) ?? '-'} [${r.basis}] p ${r.p_obs?.toFixed(2) ?? '-'} err ${r.err?.toExponential(3) ?? '-'} (rel ${r.err !== null ? (r.err / r.ref).toExponential(2) : '-'}) limit ${r.limit?.toExponential(2) ?? '-'}${r.reason ? ` | ${r.reason}` : ''}`);
  }
  log.write({ kind: 'gate', name, levels, results: res });
}

/** Gate summary line: time to accuracy and the < 5 s check, printed as met only when every gated target passes. */
export function speedLine(id: string, levels: Level[], targets: Target[], res: GateResult[], log: GateLog): void {
  const pass = res.filter((r) => r.status !== 'info').every((r) => r.status === 'pass');
  const tta = timeToAccuracy(levels, targets);
  const total = levels.slice(-3).reduce((s, l) => s + l.wall_ms, 0);
  const t5 = !pass ? 'n/a (gate not passed)' : total < 5000 ? 'yes' : 'no';
  console.log(`  time to accuracy (single level): ${tta.level === null ? 'not reached' : `L${tta.level} ${tta.wall_ms!.toFixed(1)} ms`}; levels used by the verdict ${total.toFixed(1)} ms; <5 s at the gate accuracy: ${t5}`);
  log.write({ kind: 'speed', id, tta, verdict_levels_ms: total, under_5s: t5 });
}

/** Process exit code from all gate results: 1 error, 2 a gated target missed (or pending), else 0. */
export class ExitCode {
  code = 0;
  add(res: GateResult[]): void {
    for (const r of res) {
      if (r.status === 'error') this.code = 1;
      else if ((r.status === 'fail' || r.status === 'pending') && this.code === 0) this.code = 2;
    }
  }
  set(): void { process.exitCode = this.code; }
}

export const timingOf = (s: Solution) => stagesOf(s);

/** Shared-rule verdict for a single-target level table (rows as in modes-common LevelRow). */
export function verdictRows(rows: Array<{ level: number; dof: number; h: number; value: number; wall_ms: number; stages: Record<string, number> }>, t: Omit<Target, 'id'> & { id?: string }): GateResult {
  const id = t.id ?? 'x';
  const lv: Level[] = rows.map((r, k) => ({ level: k, h: r.h, dof: r.dof, wall_ms: r.wall_ms, stages: r.stages, values: { [id]: r.value } }));
  return evaluate(lv, [{ ...t, id }])[0]!;
}
