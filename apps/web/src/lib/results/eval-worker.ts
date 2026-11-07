// SPDX-License-Identifier: GPL-3.0-or-later
// Results message handler of the post worker (lane R3, DevLog-028; C6 results set): holds runs (solution, mesh,
// params; LRU of RUNS), evaluates tables, dataset values, nodal values and ad hoc requests through the adapter, and
// caches tables / dataset values by artifact key (eval-cache.ts). Loaded on the first results message, so the
// display path of the worker does not load @amp/post.
import type { Mesh, Solution } from '@amp/spec/types';
import { adhocSpec, evalDataset, evalNodal, evalTable, indexSpec, type AdapterRun, type DatasetMemo } from './adapter.ts';
import { Lru, nodeArtifactKey, paramsHash } from './eval-cache.ts';
import type { DatasetValues, NodalValues, ParamMap, ResultTable, ResultsFromWorker, ResultsToWorker, RunRef } from './api.ts';

const RUNS = 4;
interface Held { solution: Solution; mesh: Mesh; params: ParamMap; ph: string; memo: DatasetMemo }
const runs = new Lru<Held>(RUNS);
const tables = new Lru<ResultTable>(256);
const datasets = new Lru<DatasetValues>(64);

function adapterRun(ref: RunRef): AdapterRun & { held: Held } {
	const h = runs.get(ref.key);
	if (!h) throw new Error(`run ${ref.key.slice(0, 12)} is not held by the post worker (send results:run first)`);
	return { key: ref.key, solution: h.solution, mesh: h.mesh, params: h.params, studies: ref.studies, label: ref.label, held: h };
}
const memoOf = (r: AdapterRun) => (r as AdapterRun & { held: Held }).held.memo;
const extraOf = (rs: Array<AdapterRun & { held: Held }>, labels: unknown = null) => JSON.stringify([rs.map((r) => [r.studies, r.label, r.held.ph]), labels]);
/** Labels of a table / group and its items: not in the node hash (C10), but shown in headers and tips (audit 7). */
function labelsOf(spec: unknown, id: string): unknown {
	const ix = indexSpec(spec);
	const t = ix.tables.get(id), g = ix.groups.get(t ? t.from : id);
	return [t?.label ?? null, g?.label ?? null, (g?.items ?? []).map((it) => it.label ?? null)];
}

/** Answer one results message; returns the reply and the buffers to transfer. */
export async function handleResults(m: ResultsToWorker): Promise<{ reply: ResultsFromWorker; transfer: Transferable[] }> {
	const t0 = performance.now();
	switch (m.type) {
		case 'results:run': {
			if (m.mesh.hash !== m.solution.meshHash) throw new Error('results:run: the mesh hash does not match the solution');
			runs.set(m.key, { solution: m.solution, mesh: m.mesh, params: m.params, ph: await paramsHash(m.params), memo: new Map() });
			return { reply: { type: 'results:ok', req: m.req }, transfer: [] };
		}
		case 'results:drop': {
			runs.delete(m.key);
			tables.dropMatching(m.key);
			datasets.dropMatching(m.key);
			return { reply: { type: 'results:ok', req: m.req }, transfer: [] };
		}
		case 'results:table': {
			const rs = m.runs.map(adapterRun);
			const key = await nodeArtifactKey(m.spec, m.id, rs.map((r) => r.key), extraOf(rs, labelsOf(m.spec, m.id)));
			const hit = key ? tables.get(key) : undefined;
			if (hit) return { reply: { type: 'results:table', req: m.req, table: { ...hit, ms: 0, cached: true } }, transfer: [] };
			const t = evalTable(m.spec, m.id, rs, memoOf);
			const table: ResultTable = { ...t, hash: key ?? '', ms: performance.now() - t0, cached: false };
			if (key) tables.set(key, table);
			return { reply: { type: 'results:table', req: m.req, table }, transfer: [] };
		}
		case 'results:adhoc': {
			const rs = m.runs.map(adapterRun);
			const a = adhocSpec(m.spec, m.q);
			const t = evalTable(a.spec, a.group, rs, memoOf);
			return { reply: { type: 'results:table', req: m.req, table: { ...t, hash: '', ms: performance.now() - t0, cached: false } }, transfer: [] };
		}
		case 'results:dataset': {
			const r = adapterRun(m.run);
			const key = await nodeArtifactKey(m.spec, m.id, [r.key], JSON.stringify([m.expr, m.unit ?? null, m.step ?? null, extraOf([r])]));
			const hit = key ? datasets.get(key) : undefined;
			// copies: the cached arrays stay in the worker, the reply's arrays are transferred
			const out = hit ?? evalDataset(m.spec, m.id, m.expr, r, { ...(m.step !== undefined ? { step: m.step } : {}), ...(m.unit ? { unit: m.unit } : {}), memo: r.held.memo });
			if (key && !hit) datasets.set(key, out);
			const v: DatasetValues = { ...out, points: out.points.slice(), values: out.values ? out.values.slice() : null, ...(out.s ? { s: out.s.slice() } : {}), ...(out.pieces ? { pieces: out.pieces.slice() } : {}) };
			const tr: Transferable[] = [v.points.buffer];
			if (v.values) tr.push(v.values.buffer);
			if (v.s) tr.push(v.s.buffer);
			if (v.pieces) tr.push(v.pieces.buffer);
			return { reply: { type: 'results:dataset', req: m.req, values: v }, transfer: tr };
		}
		case 'results:nodal': {
			const r = adapterRun(m.run);
			const v: NodalValues = evalNodal(m.spec, m.expr, r, { ...(m.step !== undefined ? { step: m.step } : {}), ...(m.unit ? { unit: m.unit } : {}), ...(m.dataset ? { dataset: m.dataset } : {}) });
			return { reply: { type: 'results:nodal', req: m.req, values: v }, transfer: v.values ? [v.values.buffer] : [] };
		}
	}
}
