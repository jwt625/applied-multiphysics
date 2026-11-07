// SPDX-License-Identifier: GPL-3.0-or-later
// Shared gate driver for the L4 heroes: levels -> values per target, Richardson (harness metrics, read-only import),
// pass/fail against the case tolerance, per-stage timing, < 5 s check, JSONL log in logs/.

import { readCase, readExpected, GateLog, waitForLoad, stagesOf, fmt, REPO } from './modes-common.ts';
import { richardson } from '../../eval/src/metrics.ts';
import type { Solution } from '@amp/spec/types';

export { readCase, readExpected, GateLog, waitForLoad, stagesOf, fmt, REPO };

export interface Target { id: string; ref: number; unit: string; rel?: number; abs?: number; richardson?: boolean; gate?: boolean }
export interface Level { level: number; h: number; dof: number; wall_ms: number; stages: Record<string, number>; values: Record<string, number> }

export function expectedValue(id: string, metric: string): { value: number; unit: string } {
  const e = readExpected(id);
  const t = (e.targets as Array<{ metric_id: string; value: number; unit: string }>).find((x) => x.metric_id === metric);
  if (!t) throw new Error(`${id}: no expected target ${metric}`);
  return { value: t.value, unit: t.unit };
}

export interface GateResult { target: string; ref: number; fine: number; ext: number | null; p_obs: number | null; err: number; limit: number; pass: boolean; basis: string }

/** Evaluate targets over levels (coarse -> fine). */
export function evaluate(levels: Level[], targets: Target[]): GateResult[] {
  return targets.map((t) => {
    const f = levels.map((l) => l.values[t.id]!), h = levels.map((l) => l.h);
    const fine = f[f.length - 1]!;
    let ext: number | null = null, p: number | null = null;
    if (t.richardson !== false && levels.length >= 3) {
      const r = richardson(f.slice(-3), h.slice(-3));
      ext = r.f_ext; p = r.p_obs;
    }
    const v = ext ?? fine;
    const limit = Math.max(t.abs ?? 0, (t.rel ?? 0) * Math.abs(t.ref));
    const err = v - t.ref;
    return { target: t.id, ref: t.ref, fine, ext, p_obs: p, err, limit, pass: Math.abs(err) <= limit, basis: ext !== null ? 'richardson' : 'finest' };
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
  for (const r of res) console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.target}: ref ${r.ref} fine ${r.fine.toPrecision(10)} ext ${r.ext?.toPrecision(10) ?? '-'} p ${r.p_obs?.toFixed(2) ?? '-'} err ${r.err.toExponential(3)} (rel ${(r.err / r.ref).toExponential(2)}) limit ${r.limit.toExponential(2)}`);
  log.write({ kind: 'gate', name, levels, results: res });
}

export const timingOf = (s: Solution) => stagesOf(s);
