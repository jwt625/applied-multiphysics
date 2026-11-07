// SPDX-License-Identifier: GPL-3.0-or-later
// Headline numbers of a model (audit top-10 #2): the spec's own evaluation items of type `max`, `min` and `point`
// (results model C10; `headlineItems` of @amp/spec), evaluated on the current solution and shown in their spec unit.
// Since lane R3 (DevLog-028) every value comes from the evaluation group's table, computed in the post worker by
// results/adapter.ts with the @amp/post kernels: every method and dataset the kernels support (max / min nodal, quad,
// points, lattice over boundaries, domains, cut lines, edges; points on cut points in 2D and 3D), the same numbers as
// the Table tab and the agent `evaluate` tool. Unsupported forms carry the adapter's reason (never a guessed value).
// The item's root study is honoured when the full spec is given (`o.spec`): an item of a study the session did not
// solve is "not evaluated". Without a single step in the item or its group, the last stored step is shown.
import { headlineItems, resultNodes, type ParamInfo } from '@amp/spec';
import type { Mesh, Solution } from '@amp/spec/types';
import type { PostClient } from './client';
import { NOT_SELECTED, paramsOf, ResultsClient, resultsClient, runKey, runStudies, type ResultTable, type ResultsRun } from '../results/api.ts';

export interface Headline { id: string; label: string; value: number | null; unit: string; tip: string; /** probe location (m), 2D */ at?: [number, number] }

/**
 * `results`: the spec's results block (C10); anything else (absent, legacy list) yields no headlines. `o.spec`: the
 * whole spec data (root studies and physics prefixes); `o.label`: dataset label of the run (sweep point).
 */
export async function headlines(results: unknown, sol: Solution, mesh: Mesh, params: Map<string, ParamInfo>, post: PostClient | ResultsClient, o: { spec?: unknown; label?: string } = {}): Promise<Headline[]> {
	const items = headlineItems(results);
	if (!items.length) return [];
	const spec = o.spec ?? { results };
	const parent = new Map(resultNodes(results).filter((n) => n.parent).map((n) => [n.id, n.parent!]));
	// without the full spec the root study cannot be checked: accept the items' own studies (behaviour before R3)
	const studies = o.spec ? runStudies(o.spec) : [...new Set(items.map((h) => h.study).filter((x): x is string => !!x))];
	const run: ResultsRun = { key: await runKey(sol), solution: sol, mesh, params: paramsOf(sol, params), studies, label: o.label ?? '' };
	const rc = post instanceof ResultsClient ? post : resultsClient(post);
	const tables = new Map<string, Promise<ResultTable | Error>>();
	const out: Headline[] = [];
	for (const h of items) {
		const unit = h.unit && h.unit !== '1' ? h.unit : '';
		const g = parent.get(h.id);
		const na = (tip: string): Headline => ({ id: h.id, label: h.id, value: null, unit, tip });
		if (!g) { out.push(na(`${h.expr}: no evaluation group`)); continue; }
		let tp = tables.get(g);
		if (!tp) { tp = rc.table(spec, g, [run]).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))); tables.set(g, tp); }
		const t = await tp;
		if (t instanceof Error) { out.push(na(`${h.expr}: ${t.message}`)); continue; }
		if (t.errors.length && !t.rows.length) { out.push(na(`${h.expr}: ${t.errors.join('; ')}`)); continue; }
		const cols = t.columns.map((c, i) => [c, i] as const).filter(([c]) => c.item === h.id);
		if (cols.length !== 1) { out.push(na(cols.length ? `${h.expr}: ${cols.length} points (a headline shows one value)` : `${h.expr}: not in the table`)); continue; }
		const [col, ci] = cols[0]!;
		// a single step of the item / group, else the last row in the item's own effective selection (C10 precedence)
		const mine = t.rows.filter((r) => r.errors[ci] !== NOT_SELECTED);
		const row = h.step === undefined || h.step === 'last' ? mine.at(-1) : mine.find((r) => r.step === h.step);
		if (!row) { out.push(na(`${h.expr}: step ${String(h.step)} not in the solution`)); continue; }
		const v = row.cells[ci], err = row.errors[ci], meta = row.meta[ci];
		if (typeof v !== 'number' || err) { out.push(na(`${h.expr}: ${err ?? 'not evaluated'}`)); continue; }
		const where = h.type === 'point'
			? (col.point ? ` at (${col.point.map((x) => x.toPrecision(4)).join(', ')}) m, exact FE evaluation` : '')
			: ` over ${h.over?.join(' ') ?? 'the dataset'} (${meta?.method ?? h.method ?? ''}${meta?.n !== undefined ? `, ${meta.n} points` : ''})`;
		const stepNote = sol.steps && row.step !== undefined ? `; step ${row.step} (${sol.steps.kind} ${sol.steps.values[row.step] ?? 'N/A'} ${sol.steps.unit})` : '';
		const hl: Headline = { id: h.id, label: h.id, value: v, unit: col.unit, tip: `${h.type === 'point' ? '' : `${h.type} of `}${h.expr}${where}${stepNote}; evaluation group ${g}` };
		if (h.type === 'point' && col.point?.length === 2) hl.at = [col.point[0]!, col.point[1]!];
		out.push(hl);
	}
	return out;
}
