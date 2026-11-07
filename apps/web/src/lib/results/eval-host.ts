// SPDX-License-Identifier: GPL-3.0-or-later
// The agent's ResultsHost in the workbench (lane R3, DevLog-028): evaluate / get_table read the displayed dataset
// through the post worker (results/api.ts, the same tables as the Table tab and the headlines). Read-only.
import type { DatasetValuesJson, HostAnswer, ResultsHost, ResultsTableJson, AdhocEvaluation } from '@amp/agent';
import { resultNodes } from '@amp/spec';
import { resultsClient, runOf, type PostLike, type RunSource } from './api.ts';

export interface HostSession extends RunSource { post: PostLike; staleSolution: boolean }

export function agentResultsHost(s: HostSession): ResultsHost {
	const rc = resultsClient(s.post);
	const run = async () => {
		const r = await runOf(s);
		if (!r) throw new Error('no solution on the shown mesh in the workbench: call run_study first');
		return r;
	};
	return {
		async table(id: string): Promise<HostAnswer<ResultsTableJson>> {
			const r = await run();
			const n = resultNodes((s.model.data as { results?: unknown } | null)?.results).find((x) => x.id === id && x.section === 'evaluations');
			const gid = n?.parent ?? id;
			return { value: await rc.table(s.model.data, gid, [r]), stale: s.staleSolution, study: r.studies[0] ?? null };
		},
		async dataset(id: string, expr: string | null, o: { unit?: string; step?: number | 'last' | 'first' }): Promise<HostAnswer<DatasetValuesJson>> {
			const r = await run();
			const d = await rc.datasetValues(s.model.data, id, expr, r, o);
			const n = d.points.length / d.dim;
			const points: number[][] = [];
			for (let i = 0; i < n; i++) points.push(Array.from(d.points.subarray(d.dim * i, d.dim * i + d.dim)));
			return {
				value: {
					id: d.id, type: d.type, dim: d.dim, n, points, ...(d.s ? { s: Array.from(d.s) } : {}), ...(d.length !== undefined ? { length: d.length } : {}), ...(d.covered !== undefined ? { covered: d.covered } : {}),
					values: d.values ? Array.from(d.values) : null, unit: d.unit, continuous: d.continuous, outside: d.outside, step: d.step, stepValue: d.stepValue, stepUnit: d.stepUnit, ...(d.error ? { error: d.error } : {}),
				},
				stale: s.staleSolution, study: r.studies[0] ?? null,
			};
		},
		async adhoc(q: AdhocEvaluation): Promise<HostAnswer<ResultsTableJson>> {
			const r = await run();
			return { value: await rc.evaluate(s.model.data, q, [r]), stale: s.staleSolution, study: r.studies[0] ?? null };
		},
	};
}
