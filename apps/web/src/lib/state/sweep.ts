// SPDX-License-Identifier: GPL-3.0-or-later
// Parametric study editing (sweep definition) and the sweep-vs-parameter curve data. Pure functions:
//   - sweepDefOf / setSweepPatch / removeSweepPatch: the editor's model of a parametric study (inner study, axes of a
//     param with a value list or a range start / stop / n, each value with a unit) and its patch (one op). A value
//     list is written as quantity strings "<v> <unit>" (numbers when the unit is empty or "1"), a range as
//     {start, stop, n}; reading back gives the same editor model (round trip).
//   - sweepScalars / sweepSeries: every scalar the solved points report, plotted against the first axis in the
//     param's own unit; one series per combination of the other axes; unsolved points are gaps (NaN).
import { NODE_ID, PARAM_NAME, classifyString } from '@amp/spec';
import type { JsonPatchOp } from '@amp/spec/types';
import { allIds, freshId, type EditResult } from './edit-ops.ts';

type O = Record<string, unknown>;
const isObj = (x: unknown): x is O => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

export interface SweepAxisDef {
	param: string;
	mode: 'values' | 'range';
	/** values: numbers as typed (text); range: start, stop as text */
	values: string[];
	start: string;
	stop: string;
	n: number;
	/** unit of every value of the axis ('' = unitless or the values carry their own units) */
	unit: string;
}
export interface SweepDef {
	/** id of the parametric study (new or existing) */
	id: string;
	/** inner study it sweeps */
	study: string;
	axes: SweepAxisDef[];
}

/** Text of a quantity value and its unit: 2 -> ['2', ''], "0.1 um" -> ['0.1', 'um'], {value, unit} -> [v, unit]; an expression stays whole. */
export function splitQuantity(q: unknown): [string, string] {
	if (typeof q === 'number') return [String(q), ''];
	if (typeof q === 'string') {
		const c = classifyString(q);
		if (c.kind === 'literal') return [String(c.value), c.unit === '1' ? '' : c.unit];
		return [q, ''];
	}
	if (isObj(q) && (typeof q.value === 'number' || typeof q.value === 'string')) return [String(q.value), typeof q.unit === 'string' && q.unit !== '1' ? q.unit : ''];
	return ['', ''];
}

/** The parametric studies of the data. */
export function parametricStudies(data: unknown): Array<{ index: number; id: string }> {
	const st = isObj(data) ? arr(data.studies) : [];
	return st.flatMap((s, index) => (isObj(s) && s.type === 'parametric' && typeof s.id === 'string' ? [{ index, id: s.id }] : []));
}

/** Editor model of the parametric study `id` (null when it is not a parametric study). */
export function sweepDefOf(data: unknown, id: string): SweepDef | null {
	const st = (isObj(data) ? arr(data.studies) : []).find((s) => isObj(s) && s.id === id && s.type === 'parametric') as O | undefined;
	if (!st) return null;
	const set = isObj(st.settings) ? st.settings : {};
	const axes = arr(set.sweep).filter(isObj).map((ax): SweepAxisDef => {
		const param = typeof ax.param === 'string' ? ax.param : '';
		if (Array.isArray(ax.values)) {
			const parts = ax.values.map(splitQuantity);
			const units = [...new Set(parts.map((p) => p[1]))];
			// one shared unit is factored out; mixed units stay on each value
			return units.length === 1
				? { param, mode: 'values', values: parts.map((p) => p[0]), start: '', stop: '', n: 2, unit: units[0]! }
				: { param, mode: 'values', values: parts.map((p) => (p[1] ? `${p[0]} ${p[1]}` : p[0])), start: '', stop: '', n: 2, unit: '' };
		}
		const r = isObj(ax.range) ? ax.range : {};
		const [a, ua] = splitQuantity(r.start), [b, ub] = splitQuantity(r.stop);
		const same = ua === ub;
		return { param, mode: 'range', values: [], start: same ? a : (ua ? `${a} ${ua}` : a), stop: same ? b : (ub ? `${b} ${ub}` : b), n: typeof r.n === 'number' ? r.n : 2, unit: same ? ua : '' };
	});
	return { id, study: typeof set.study === 'string' ? set.study : '', axes };
}

/** Value list text "0.1, 0.2 0.3; 0.5" -> ['0.1', '0.2', '0.3', '0.5'] (commas, semicolons or spaces between numbers). */
export function parseValueList(text: string): string[] {
	const t = text.trim();
	if (!t) return [];
	// separators: comma / semicolon; spaces separate only when every piece is a plain number
	const byComma = t.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
	if (byComma.length > 1) return byComma;
	const bySpace = t.split(/\s+/);
	return bySpace.every((x) => Number.isFinite(Number(x))) ? bySpace : [t];
}

/** Spec form of one axis value: a number when unitless and numeric, else "<v> <unit>" (or the text as typed). */
function quantityOf(v: string, unit: string): number | string {
	const t = v.trim();
	const num = Number(t);
	if (!unit || unit === '1') return t !== '' && Number.isFinite(num) ? num : t;
	return Number.isFinite(num) && t !== '' ? `${t} ${unit}` : t;
}

/**
 * Design limit on the number of sweep points (product over the axes). Every point is a full solve kept in the session
 * (scalars of every point, fields of the recent ones), so a larger sweep belongs in a batch run, not the browser.
 */
export const MAX_SWEEP_POINTS = 200;

/** Problems of an editor model ('' when it can be written). */
export function sweepProblem(data: unknown, def: SweepDef, isNew: boolean): string {
	if (!NODE_ID.test(def.id)) return `'${def.id}' is not a valid study id`;
	const studies = isObj(data) ? arr(data.studies).filter(isObj) : [];
	if (isNew && allIds(data).has(def.id)) return `id '${def.id}' is already used in this model`;
	const inner = studies.find((s) => s.id === def.study);
	if (!inner) return def.study ? `no study '${def.study}'` : 'choose the study to sweep';
	if (inner.type === 'parametric') return 'a parametric study cannot sweep another parametric study';
	if (!def.axes.length) return 'add at least one swept parameter';
	if (def.axes.length > 4) return 'at most 4 swept parameters';
	const params = isObj(data) && isObj(data.params) ? data.params : {};
	const seen = new Set<string>();
	for (const [i, a] of def.axes.entries()) {
		const at = `axis ${i + 1}`;
		if (!a.param || !PARAM_NAME.test(a.param) || !Object.hasOwn(params, a.param)) return `${at}: choose a parameter of the model`;
		if (seen.has(a.param)) return `${at}: ${a.param} is swept twice`;
		seen.add(a.param);
		if (a.mode === 'values') { if (!a.values.filter((v) => v.trim()).length) return `${at}: enter at least one value`; }
		else {
			if (!a.start.trim() || !a.stop.trim()) return `${at}: enter start and stop`;
			if (!(Number.isInteger(a.n) && a.n >= 2)) return `${at}: n must be an integer >= 2`;
		}
	}
	const count = sweepCount(def);
	if (count > MAX_SWEEP_POINTS) return `${count} sweep points: at most ${MAX_SWEEP_POINTS} per sweep (each point is a full solve)`;
	return '';
}

/** Number of points (row-major product of the axes). */
export const sweepCount = (def: SweepDef): number => def.axes.reduce((n, a) => n * (a.mode === 'values' ? a.values.filter((v) => v.trim()).length : a.n), 1);

/** Spec node of an editor model (keeps label and other keys of an existing study). */
export function sweepNode(data: unknown, def: SweepDef, prev?: O): O {
	const inner = (isObj(data) ? arr(data.studies) : []).find((s) => isObj(s) && s.id === def.study) as O | undefined;
	const physics = Array.isArray(inner?.physics) ? [...(inner.physics as string[])] : [];
	const sweep = def.axes.map((a) => (a.mode === 'values'
		? { param: a.param, values: a.values.filter((v) => v.trim()).map((v) => quantityOf(v, a.unit)) }
		: { param: a.param, range: { start: quantityOf(a.start, a.unit), stop: quantityOf(a.stop, a.unit), n: a.n } }));
	return { ...(prev ?? {}), id: def.id, type: 'parametric', physics, settings: { ...(isObj(prev?.settings) ? prev.settings : {}), study: def.study, sweep } };
}

/** Create (new id) or replace (existing parametric study) as one op; the patch touches only what changed. */
export function setSweepPatch(data: unknown, def: SweepDef): EditResult {
	const studies = isObj(data) ? arr(data.studies) : [];
	const i = studies.findIndex((s) => isObj(s) && s.id === def.id);
	const prev = i >= 0 ? (studies[i] as O) : undefined;
	if (prev && prev.type !== 'parametric') return { ok: false, reason: `study '${def.id}' is not a parametric study` };
	const why = sweepProblem(data, def, !prev);
	if (why) return { ok: false, reason: why };
	const node = sweepNode(data, def, prev);
	if (!prev) {
		const n = studies.length;
		return Array.isArray(isObj(data) ? data.studies : undefined)
			? { ok: true, patch: [{ op: 'add', path: `/studies/${n}`, value: node }], id: def.id, pointer: `/studies/${n}` }
			: { ok: true, patch: [{ op: 'add', path: '/studies', value: [node] }], id: def.id, pointer: '/studies/0' };
	}
	const patch: JsonPatchOp[] = [];
	const base = `/studies/${i}`;
	// RFC 6902: `replace` needs the member to exist, so an absent key is added
	const opFor = (o: O, k: string): 'add' | 'replace' => (Object.hasOwn(o, k) ? 'replace' : 'add');
	if (JSON.stringify(prev.physics) !== JSON.stringify(node.physics)) patch.push({ op: opFor(prev, 'physics'), path: `${base}/physics`, value: node.physics });
	const ns = node.settings as O;
	if (!isObj(prev.settings)) {
		// no settings object (absent or not an object): the whole settings value is written, after the physics op
		patch.push({ op: opFor(prev, 'settings'), path: `${base}/settings`, value: ns });
		return { ok: true, patch, id: def.id, pointer: base };
	}
	const ps = prev.settings;
	if (ps.study !== ns.study) patch.push({ op: opFor(ps, 'study'), path: `${base}/settings/study`, value: ns.study });
	if (JSON.stringify(ps.sweep) !== JSON.stringify(ns.sweep)) patch.push({ op: opFor(ps, 'sweep'), path: `${base}/settings/sweep`, value: ns.sweep });
	return { ok: true, patch, id: def.id, pointer: base };
}

/** A new editor model: a fresh id, the first non-parametric study, the first numeric param with its value as one point. */
export function newSweepDef(data: unknown, params: ReadonlyArray<{ name: string; value: number | null; unit: string }>): SweepDef {
	const used = allIds(data);
	const inner = (isObj(data) ? arr(data.studies) : []).find((s) => isObj(s) && s.type !== 'parametric' && typeof s.id === 'string') as O | undefined;
	const p = params.find((x) => x.value !== null) ?? params[0];
	return {
		id: freshId(used, 'sweep'),
		study: (inner?.id as string | undefined) ?? '',
		axes: p ? [{ param: p.name, mode: 'values', values: p.value !== null ? [String(p.value)] : [], start: '', stop: '', n: 5, unit: p.unit === '1' ? '' : p.unit }] : []
	};
}

/** Remove a parametric study; refused while results datasets read it. */
export function removeSweepPatch(data: unknown, id: string): EditResult {
	const studies = isObj(data) ? arr(data.studies) : [];
	const i = studies.findIndex((s) => isObj(s) && s.id === id && s.type === 'parametric');
	if (i < 0) return { ok: false, reason: `no parametric study '${id}'` };
	const r = isObj(data) && isObj(data.results) ? data.results : {};
	const readers = arr(r.datasets).filter((d) => isObj(d) && d.data === id).map((d) => String((d as O).id));
	if (readers.length) return { ok: false, reason: `results datasets read '${id}': ${readers.join(', ')}; delete them first (Results > Datasets)` };
	return { ok: true, patch: [{ op: 'remove', path: `/studies/${i}` }], id, pointer: '/studies' };
}

// ---- sweep-vs-parameter curves --------------------------------------------------------------------------------

/** What the curve needs from a session sweep (SweepState of workbench/session.svelte.ts, structurally). */
export interface SweepLike {
	studyId: string;
	axes: ReadonlyArray<{ param: string; unit: string; values: readonly number[] }>;
	points: ReadonlyArray<{ index: number; values: Record<string, number>; status: string; scalars: Record<string, { value: number; unit: string }> | null }>;
}

/** Scalar names reported by any solved point (first-seen order) and their unit. */
export function sweepScalars(sw: SweepLike | null): Array<{ name: string; unit: string }> {
	const out = new Map<string, string>();
	for (const p of sw?.points ?? []) if (p.status === 'solved' && p.scalars) for (const [k, v] of Object.entries(p.scalars)) if (!out.has(k) && Number.isFinite(v.value)) out.set(k, v.unit);
	return [...out].map(([name, unit]) => ({ name, unit }));
}

export interface SweepSeries { name: string; x: number[]; y: number[] }

/** `scalar` vs the first axis (in the param's unit); one series per combination of the other axes; gaps as NaN. */
export function sweepSeries(sw: SweepLike, scalar: string): { series: SweepSeries[]; xLabel: string; yUnit: string; solved: number } {
	const ax0 = sw.axes[0];
	if (!ax0) return { series: [], xLabel: '', yUnit: '', solved: 0 };
	const rest = sw.axes.slice(1);
	const groups = new Map<string, { name: string; pts: Array<[number, number]> }>();
	let yUnit = '', solved = 0;
	for (const p of sw.points) {
		const key = rest.map((a) => String(p.values[a.param])).join('|');
		const name = rest.map((a) => `${a.param} = ${p.values[a.param]}${a.unit && a.unit !== '1' ? ` ${a.unit}` : ''}`).join(', ') || scalar;
		const g = groups.get(key) ?? { name, pts: [] };
		groups.set(key, g);
		const s = p.status === 'solved' ? p.scalars?.[scalar] : undefined;
		if (s && Number.isFinite(s.value)) { yUnit ||= s.unit; solved++; }
		g.pts.push([p.values[ax0.param]!, s && Number.isFinite(s.value) ? s.value : NaN]);
	}
	const series = [...groups.values()].map((g) => ({ name: g.name, x: g.pts.map((q) => q[0]), y: g.pts.map((q) => q[1]) }));
	return { series, xLabel: `${ax0.param}${ax0.unit && ax0.unit !== '1' ? ` (${ax0.unit})` : ''}`, yUnit, solved };
}
