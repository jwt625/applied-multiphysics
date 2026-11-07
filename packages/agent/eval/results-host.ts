// SPDX-License-Identifier: GPL-3.0-or-later
// Node ResultsHost of the agent tests and task suite (lane R3, DevLog-028): evaluates results nodes of the session's
// current spec on the FE runner's latest solve of their root study, with the web app's adapter (the same file the
// browser post worker runs: apps/web/src/lib/results/adapter.ts, @amp/post kernels). Loaded by relative path: packages
// cannot depend on apps/web (DevLog-028 O2: move the adapter into a package in contracts v2).
import { canonicalJson, parseYaml, runId, type OpLog } from '@amp/spec';
import { adhocSpec, chainOf, evalDataset, evalTable, indexSpec, type AdapterRun } from '../../../apps/web/src/lib/results/adapter.ts';
import type { AdhocEvaluation, DatasetValuesJson, HostAnswer, ResultsHost, ResultsTableJson } from '../src/results.ts';
import type { FeRunner } from './fixtures.ts';

const noResults = (d: unknown): string => { const { results: _r, ...rest } = (d ?? {}) as Record<string, unknown>; return canonicalJson(rest); };

export class NodeResultsHost implements ResultsHost {
  private log: OpLog;
  private runner: FeRunner;
  readonly calls: Array<{ method: string; id: string }> = [];
  constructor(log: OpLog, runner: FeRunner) { this.log = log; this.runner = runner; }

  /** Root study of a results node (group: its data or its first item's data; table: its group; item: its group's). */
  private studyOf(spec: unknown, id: string): string {
    const ix = indexSpec(spec);
    const t = ix.tables.get(id);
    const g = ix.groups.get(t ? t.from : id) ?? ix.items.get(id)?.group;
    const ids = g ? [g.data, ...(Array.isArray(g.items) ? g.items.map((it) => it.data) : [])] : [id];
    for (const d of ids) {
      if (!d) continue;
      const c = chainOf(ix, d);
      if (!('error' in c)) return c.study;
    }
    throw new Error(`results node '${id}': no dataset chain to a solved study`);
  }

  private async run(study: string): Promise<{ run: AdapterRun; stale: boolean }> {
    const l = this.runner.last.get(study);
    if (!l) throw new Error(`no solution of study '${study}' in this session: call run_study first`);
    const stale = noResults(parseYaml(l.specText).data) !== noResults(this.log.data);
    return { run: { key: await runId(l.solution.run), solution: l.solution, mesh: l.mesh, params: l.params, studies: [study], label: '' }, stale };
  }

  async table(id: string): Promise<HostAnswer<ResultsTableJson>> {
    this.calls.push({ method: 'table', id });
    const spec = this.log.data;
    const ix = indexSpec(spec);
    const gid = ix.items.get(id)?.group.id ?? id;
    const study = this.studyOf(spec, gid);
    const { run, stale } = await this.run(study);
    const t = evalTable(spec, gid, [run]);
    return { value: { ...t, hash: '' }, stale, study };
  }

  async dataset(id: string, expr: string | null, o: { unit?: string; step?: number | 'last' | 'first' }): Promise<HostAnswer<DatasetValuesJson>> {
    this.calls.push({ method: 'dataset', id });
    const spec = this.log.data;
    const c = chainOf(indexSpec(spec), id);
    if ('error' in c) throw new Error(c.error);
    const { run, stale } = await this.run(c.study);
    const d = evalDataset(spec, id, expr, run, { ...(o.unit ? { unit: o.unit } : {}), ...(o.step !== undefined ? { step: o.step } : {}) });
    const n = d.points.length / d.dim;
    const pts: number[][] = [];
    for (let i = 0; i < n; i++) pts.push(Array.from(d.points.subarray(d.dim * i, d.dim * i + d.dim)));
    return {
      value: {
        id: d.id, type: d.type, dim: d.dim, n, points: pts, ...(d.s ? { s: Array.from(d.s) } : {}), ...(d.length !== undefined ? { length: d.length } : {}), ...(d.covered !== undefined ? { covered: d.covered } : {}),
        values: d.values ? Array.from(d.values) : null, unit: d.unit, continuous: d.continuous, outside: d.outside, step: d.step, stepValue: d.stepValue, stepUnit: d.stepUnit, ...(d.error ? { error: d.error } : {}),
      },
      stale, study: c.study,
    };
  }

  async adhoc(q: AdhocEvaluation): Promise<HostAnswer<ResultsTableJson>> {
    this.calls.push({ method: 'adhoc', id: q.data });
    const a = adhocSpec(this.log.data, q);
    const study = this.studyOf(a.spec, a.group);
    const { run, stale } = await this.run(study);
    const t = evalTable(a.spec, a.group, [run]);
    return { value: { ...t, hash: '' }, stale, study };
  }
}
