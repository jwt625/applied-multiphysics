// SPDX-License-Identifier: GPL-3.0-or-later
// "Pin" probe rows (lane R3, DevLog-028; DevLog-023 s.3.5): one user operation that turns probe points into spec
// nodes, a `cutpoint` dataset per row and a `point` evaluation item per row in the evaluation group `ev_pins`
// (created when absent), on the solution dataset of the solved study (created when absent). The values are then
// computed like every other evaluation (Table tab, headlines, agent), never copied from the probe row.
import { resultNodes } from '@amp/spec';
import type { JsonPatchOp } from '@amp/spec/types';

/** What a pin needs from a probe row (ProbeRow of post/probe.ts). */
export interface PinRow { n: number; dim: 2 | 3; p: [number, number, number]; lu: { unit: string; f: number }; field: string; unit: string }

export const PIN_GROUP = 'ev_pins';
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (v: number) => Number(v.toPrecision(10));

/** Component suffix of a drawn field label ('sxx', 'u magnitude', 'u component 1', 'E_rphiz component phi'). */
export function exprOfLabel(label: string, physicsId: string | undefined, o: { axisym: boolean; dim: number; components?: number }): string | null {
	const m = /^(\S+)(?: (magnitude)| component (\S+))?$/.exec(label.trim());
	if (!m) return null;
	const base = physicsId ? `${physicsId}.${m[1]}` : m[1]!;
	if (m[2]) return `${base}.norm`;
	if (m[3] === undefined) return base;
	if (/^[a-z]+$/.test(m[3])) return `${base}.${m[3]}`;
	const k = Number(m[3]);
	const names = o.axisym ? ((o.components ?? 2) === 3 ? ['r', 'phi', 'z'] : ['r', 'z']) : ['x', 'y', 'z'];
	return Number.isInteger(k) && names[k] ? `${base}.${names[k]}` : null;
}

/**
 * JSON Patch (one op) pinning probe rows. `studies`: the study ids the shown solution answers for (first = solved).
 * Ids are fresh in the spec's one id namespace: pin<k>_pt (dataset) and pin<k> (item).
 */
export function pinPatch(spec: unknown, rows: readonly PinRow[], o: { studies: string[]; physicsId?: string; axisym: boolean; dim: number; components?: (field: string) => number | undefined; eigen?: boolean }): { patch: JsonPatchOp[]; items: string[]; skipped: Array<{ n: number; reason: string }> } {
	const data = isObj(spec) ? spec : {};
	const res = isObj(data.results) ? data.results : null;
	const datasets = res && Array.isArray(res.datasets) ? (res.datasets as Array<Record<string, unknown>>) : null;
	const evals = res && Array.isArray(res.evaluations) ? (res.evaluations as Array<Record<string, unknown>>) : null;
	const used = new Set<string>(resultNodes(res).map((r) => r.id));
	// every other id of the spec (one namespace): params are names, the rest carry `id`
	const scan = (x: unknown) => { if (Array.isArray(x)) x.forEach(scan); else if (isObj(x)) { if (typeof x.id === 'string') used.add(x.id); Object.values(x).forEach(scan); } };
	scan(data);
	const patch: JsonPatchOp[] = [];
	const skipped: Array<{ n: number; reason: string }> = [];
	if (!res) patch.push({ op: 'add', path: '/results', value: {} });
	if (!datasets) patch.push({ op: 'add', path: '/results/datasets', value: [] });
	if (!evals) patch.push({ op: 'add', path: '/results/evaluations', value: [] });
	const study = o.studies[0];
	if (!study) return { patch: [], items: [], skipped: rows.map((r) => ({ n: r.n, reason: 'no solved study' })) };
	let sol = (datasets ?? []).find((d) => d.type === 'solution' && o.studies.includes(String(d.data)) && d.enabled !== false)?.id as string | undefined;
	if (!sol) {
		sol = `sol_${study}`;
		for (let k = 2; used.has(sol); k++) sol = `sol_${study}_${k}`;
		used.add(sol);
		patch.push({ op: 'add', path: '/results/datasets/-', value: { id: sol, type: 'solution', data: study } });
	}
	const fresh = (stem: string) => { let k = 1; while (used.has(`${stem}${k}`) || used.has(`${stem}${k}_pt`)) k++; return `${stem}${k}`; };
	const items: Array<Record<string, unknown>> = [];
	for (const r of rows) {
		const expr = exprOfLabel(r.field, o.physicsId, { axisym: o.axisym, dim: o.dim, ...(o.components?.(r.field.split(' ')[0]!) !== undefined ? { components: o.components(r.field.split(' ')[0]!)! } : {}) });
		if (!expr) { skipped.push({ n: r.n, reason: `field '${r.field}' has no expression form` }); continue; }
		const id = fresh('pin');
		used.add(id); used.add(`${id}_pt`);
		const f = r.lu.f || 1;
		const pt = r.p.slice(0, r.dim).map((v) => num(v * f));
		patch.push({ op: 'add', path: '/results/datasets/-', value: { id: `${id}_pt`, type: 'cutpoint', data: sol, points: [{ value: pt, unit: r.lu.unit || 'm' }] } });
		// the probe's display unit when it is a unit of the field (eigenmodes are drawn normalized: SI instead)
		const unit = !o.eigen && r.unit && r.unit !== '1' ? r.unit : undefined;
		items.push({ id, type: 'point', label: `probe ${r.n}`, data: `${id}_pt`, expr, ...(unit ? { unit } : {}) });
	}
	if (!items.length) return { patch: [], items: [], skipped };
	const group = (evals ?? []).find((g) => g.id === PIN_GROUP);
	if (group) for (const it of items) patch.push({ op: 'add', path: `/results/evaluations/@${PIN_GROUP}/items/-`, value: it });
	else patch.push({ op: 'add', path: '/results/evaluations/-', value: { id: PIN_GROUP, label: 'Pinned probes', data: sol, items } });
	return { patch, items: items.map((i) => String(i.id)), skipped };
}
