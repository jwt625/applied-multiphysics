// SPDX-License-Identifier: GPL-3.0-or-later
// Reports: JSONL per C8 (logs/eval-YYYYMMDDTHHMMSS.jsonl) and a markdown summary (logs/eval-...-summary.md).
// Target lines carry the C8 minimum {case, target, value, ref, tol, pass, time_ms, dof, run} plus diagnostics.

import type { CaseResult } from './runner.ts';
import { formatIssue } from './loader.ts';

export interface RunMeta {
  schema: 'amp-eval-run/0';
  started_at: string;
  finished_at?: string;
  harness: string;
  source: string;
  source_detail: string;
  filter: Record<string, unknown>;
  dry_run: boolean;
  speed: boolean;
  platform: { runtime: 'node' | 'browser'; ua?: string; crossOriginIsolated?: boolean; node?: string; os?: string; arch?: string; cores?: number; cpu?: string; mem_gb?: number };
}

function plain(x: unknown): unknown {
  if (ArrayBuffer.isView(x) && !(x instanceof DataView)) return Array.from(x as unknown as ArrayLike<number>);
  if (typeof x === 'number' && !Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity';
  if (Array.isArray(x)) return x.map(plain);
  if (x && typeof x === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (v !== undefined) o[k] = plain(v);
    return o;
  }
  return x;
}

export function toJsonl(meta: RunMeta, results: CaseResult[]): string {
  const lines: unknown[] = [{ kind: 'meta', ...meta }];
  for (const r of results) {
    const common = { case: r.case, class: r.class, physics: r.physics, source: r.source, case_status: r.status };
    if (!r.targets.length) {
      lines.push({ kind: 'case', ...common, target: null, value: null, ref: null, tol: null, pass: null, time_ms: null, dof: null, run: r.run, status: r.status, reason: r.reason ?? null, issues: r.issues.map(formatIssue) });
      continue;
    }
    if (r.issues.length) lines.push({ kind: 'issues', ...common, issues: r.issues.map(formatIssue) });
    for (const t of r.targets) {
      const { target, value, ref, tol, pass, time_ms, dof, ...rest } = t;
      lines.push({ kind: 'target', ...common, target, value, ref, tol, pass, time_ms, dof, run: r.run, ...rest });
    }
    if (r.speed) lines.push({ kind: 'speed', ...common, ...r.speed });
  }
  lines.push({ kind: 'summary', ...summarize(results) });
  return lines.map((l) => JSON.stringify(plain(l))).join('\n') + '\n';
}

type Counts = { pass: number; fail: number; pending: number; error: number; info: number };
const zero = (): Counts => ({ pass: 0, fail: 0, pending: 0, error: 0, info: 0 });

export interface Summary {
  cases: Counts;
  targets: Counts;
  by_class: Record<string, { cases: Counts; targets: Counts }>;
  by_physics: Record<string, { cases: Counts; targets: Counts }>;
  loader_errors: number;
  loader_warnings: number;
}

export function summarize(results: CaseResult[]): Summary {
  const s: Summary = { cases: zero(), targets: zero(), by_class: {}, by_physics: {}, loader_errors: 0, loader_warnings: 0 };
  const bucket = (m: Record<string, { cases: Counts; targets: Counts }>, k: string) => (m[k] ??= { cases: zero(), targets: zero() });
  for (const r of results) {
    s.cases[r.status]++;
    s.loader_errors += r.issues.filter((i) => i.severity === 'error').length;
    s.loader_warnings += r.issues.filter((i) => i.severity === 'warning').length;
    const groups = [bucket(s.by_class, r.class ?? '?'), ...(r.physics.length ? r.physics : ['?']).map((p) => bucket(s.by_physics, p))];
    for (const g of groups) g.cases[r.status]++;
    for (const t of r.targets) {
      s.targets[t.status]++;
      for (const g of groups) g.targets[t.status]++;
    }
  }
  return s;
}

const row = (k: string, c: Counts, t: Counts) => `| ${k} | ${c.pass} | ${c.fail} | ${c.pending} | ${c.error} | ${t.pass} | ${t.fail} | ${t.pending} | ${t.error} | ${t.info} |`;
const head = (k: string) => [
  `| ${k} | cases pass | fail | pending | error | targets pass | fail | pending | error | info |`,
  '|---|---|---|---|---|---|---|---|---|---|',
];

function num(x: unknown): string {
  if (typeof x === 'number') return Number.isFinite(x) ? x.toPrecision(6) : String(x);
  if (Array.isArray(x)) return `[${x.slice(0, 6).map(num).join(', ')}${x.length > 6 ? ', ...' : ''}]`;
  return x === null || x === undefined ? 'N/A' : String(x);
}

export function toMarkdown(meta: RunMeta, results: CaseResult[], jsonlName: string): string {
  const s = summarize(results);
  const L: string[] = [];
  L.push(`# Eval run ${meta.started_at}`, '');
  L.push(`| Field | Value |`, `|---|---|`);
  L.push(`| Harness | ${meta.harness} |`, `| Source | ${meta.source_detail} |`, `| Filter | ${JSON.stringify(meta.filter)} |`);
  L.push(`| Mode | ${meta.dry_run ? 'dry run' : 'run'}${meta.speed ? ' + speed' : ''} |`);
  L.push(`| Platform | ${[meta.platform.runtime, meta.platform.node, meta.platform.os, meta.platform.arch, meta.platform.cpu, meta.platform.cores ? `${meta.platform.cores} cores` : '', meta.platform.mem_gb ? `${meta.platform.mem_gb} GB` : ''].filter(Boolean).join(', ')} |`);
  L.push(`| Records | ${jsonlName} |`, `| Loader | ${s.loader_errors} errors, ${s.loader_warnings} warnings |`, '');
  L.push(...head('class'));
  for (const k of Object.keys(s.by_class).sort()) L.push(row(k, s.by_class[k]!.cases, s.by_class[k]!.targets));
  L.push(row('all', s.cases, s.targets), '');
  L.push(...head('physics'));
  for (const k of Object.keys(s.by_physics).sort()) L.push(row(k, s.by_physics[k]!.cases, s.by_physics[k]!.targets));
  L.push('');
  const fails = results.flatMap((r) => r.targets.filter((t) => t.status === 'fail').map((t) => ({ r, t })));
  if (fails.length) {
    L.push('## Missed targets', '', '| case | target | value | ref | diff | limit | u_num | reason |', '|---|---|---|---|---|---|---|---|');
    for (const { r, t } of fails) L.push(`| ${r.case} | ${t.target} | ${num(t.value)} | ${num(t.ref)} | ${num(t.diff)} | ${num(t.limit)} | ${num(t.u_num)} | ${t.reason ?? ''} |`);
    L.push('');
  }
  const passes = results.flatMap((r) => r.targets.filter((t) => t.status === 'pass').map((t) => ({ r, t })));
  if (passes.length) {
    L.push('## Passed targets', '', '| case | target | value | ref | diff | limit | time_ms | dof |', '|---|---|---|---|---|---|---|---|');
    for (const { r, t } of passes) L.push(`| ${r.case} | ${t.target} | ${num(t.value)} | ${num(t.ref)} | ${num(t.diff)} | ${num(t.limit)} | ${num(t.time_ms)} | ${num(t.dof)} |`);
    L.push('');
  }
  const errs = results.filter((r) => r.status === 'error');
  if (errs.length) {
    L.push('## Errors', '');
    for (const r of errs) {
      L.push(`- ${r.case} (${r.file}): ${r.reason ?? ''}`);
      for (const i of r.issues.filter((x) => x.severity === 'error')) L.push(`  - \`${formatIssue(i)}\``);
      for (const t of r.targets.filter((x) => x.status === 'error')) L.push(`  - ${t.target}: ${t.reason ?? ''}`);
    }
    L.push('');
  }
  const pend = new Map<string, string[]>();
  for (const r of results) if (r.status === 'pending') {
    const why = r.reason ?? 'pending';
    pend.set(why, [...(pend.get(why) ?? []), r.case]);
  }
  if (pend.size) {
    L.push('## Pending (grouped by reason)', '');
    for (const [why, ids] of [...pend.entries()].sort((a, b) => b[1].length - a[1].length)) L.push(`- ${ids.length}: ${why}: ${ids.join(', ')}`);
    L.push('');
  }
  const warns = results.flatMap((r) => r.issues.filter((i) => i.severity === 'warning'));
  if (warns.length) {
    L.push('## Loader warnings', '');
    for (const w of warns) L.push(`- \`${formatIssue(w)}\``);
    L.push('');
  }
  const sp = results.filter((r) => r.speed);
  if (sp.length) {
    L.push('## Speed (warm-up 1, median of 5)', '', '| case | dof | median ms | MAD ms | iterations | budget s | meets budget | stages (median ms) |', '|---|---|---|---|---|---|---|---|');
    for (const r of sp) {
      const x = r.speed!;
      L.push(`| ${r.case} | ${num(x.dof)} | ${num(x.median_ms)} | ${num(x.mad_ms)} | ${num(x.iterations)} | ${num(x.budget_s)} | ${x.meets_budget === undefined ? 'N/A' : String(x.meets_budget)} | ${Object.entries(x.stages_median_ms).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')} |`);
    }
    L.push('');
  }
  return L.join('\n');
}
