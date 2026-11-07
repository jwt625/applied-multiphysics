// SPDX-License-Identifier: GPL-3.0-or-later
// Spec-to-kernel adapter of the results model (lane R3, DevLog-028; C10). Resolves a results node of the spec (dataset
// chain to its root study, steps item > group > dataset, quantities to SI with the run's params, the physics id
// prefix) and calls the @amp/post kernels (DevLog-026) with plain arguments. Pure and synchronous: the browser post
// worker, the agent task-suite host and the eval harness (Node) run the same code, so every number agrees.
// Runtime imports: packages and ./api.ts (which imports packages only), so Node can load this file by path.
//
// Never throws for a node: a value that cannot be computed carries the reason (honesty rule: unavailable is never
// shown as a value). Supported datasets: solution, cutpoint, cutline (uniform n or element crossings), edge (2D);
// cutplane, revolve, mirror and join report "not evaluated" (stages R4 / R5).
import type { Mesh, Solution } from '@amp/spec/types';
import { parseEntityId, resolveQuantity, resultsOf, units, type DatasetNode, type EvalGroup, type EvalItem, type ScopeValue, type TableNode } from '@amp/spec';
import {
	cutLine, cutPoints, edgeDataset, evalAverage, evalGlobal, evalIntegral, evalMax, evalMeasure, evalMin, evalPoint, compileFieldExpr, solutionSteps, NODE_REF,
	facetCell, facetsOfBoundaries,
	type CutPointsDataset, type EdgeDataset, type LineDataset, type PointSet, type Region, type EvalResult,
} from '@amp/post';
import { NOT_SELECTED, type AdhocRequest, type CellMeta, type DatasetValues, type NodalValues, type ParamMap, type ResultTable, type TableColumn, type TableRow } from './api.ts';
export { NOT_SELECTED };

/** A run as the adapter sees it (the worker and Node hosts hold the arrays). */
export interface AdapterRun { key: string; solution: Solution; mesh: Mesh; params: ParamMap; studies: string[]; label: string }

/** Reference-coordinate tolerance used to locate cut points and cut-line points on curved walls. */
export const SNAP = 1e-6;
/** Refined-lattice level of max / min with method 'lattice' (DevLog-026: refine.mjs pattern). */
export const LATTICE_LEVEL = 3;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- spec index ---------------------------------------------------------------------------------------------------

interface Study { id: string; type: string; physics: string[] }
export interface SpecIndex {
	datasets: Map<string, DatasetNode>;
	groups: Map<string, EvalGroup>;
	tables: Map<string, TableNode>;
	/** evaluation item id -> item and its group */
	items: Map<string, { item: EvalItem; group: EvalGroup }>;
	studies: Map<string, Study>;
}

export function indexSpec(spec: unknown): SpecIndex {
	const r = resultsOf(spec);
	const items = new Map<string, { item: EvalItem; group: EvalGroup }>();
	for (const g of r.evaluations) for (const it of Array.isArray(g.items) ? g.items : []) if (isObj(it) && typeof it.id === 'string') items.set(it.id, { item: it, group: g });
	const st = (isObj(spec) && Array.isArray(spec.studies) ? spec.studies : []) as Obj[];
	const studies = new Map<string, Study>(st.filter((s) => typeof s.id === 'string').map((s) => [s.id as string, { id: s.id as string, type: String(s.type ?? ''), physics: Array.isArray(s.physics) ? (s.physics as unknown[]).filter((p): p is string => typeof p === 'string') : [] }]));
	return {
		datasets: new Map(r.datasets.filter((d) => typeof d.id === 'string').map((d) => [d.id, d])),
		groups: new Map(r.evaluations.filter((g) => typeof g.id === 'string').map((g) => [g.id, g])),
		tables: new Map(r.tables.filter((t) => typeof t.id === 'string').map((t) => [t.id, t])),
		items, studies,
	};
}

/** Dataset chain from `id` up to its solution dataset (first = the dataset itself). */
export function chainOf(ix: SpecIndex, id: string | undefined): { chain: DatasetNode[]; root: DatasetNode; study: string } | { error: string } {
	if (!id) return { error: 'no dataset (set data on the item or its group)' };
	const chain: DatasetNode[] = [];
	let cur: string | undefined = id;
	for (let k = 0; k < 64; k++) {
		const d: DatasetNode | undefined = cur === undefined ? undefined : ix.datasets.get(cur);
		if (!d) return { error: `dataset '${cur}' not found` };
		if (chain.includes(d)) return { error: `dataset chain cycle at '${cur}'` };
		if (d.enabled === false) return { error: `dataset '${d.id}' is disabled` };
		chain.push(d);
		if (d.type === 'solution') {
			if (typeof d.data !== 'string') return { error: `solution dataset '${d.id}' names no study` };
			// the kernels evaluate on the root solution's mesh: a parent between the dataset and its solution (cutplane,
			// revolve, mirror, join) would be silently ignored, so such chains are not evaluated yet (audit 1)
			const mid = chain.slice(1, -1).find((x) => x.type !== 'solution');
			if (mid) return { error: `dataset '${chain[0]!.id}' reads the ${mid.type} dataset '${mid.id}': not evaluated yet (stage ${mid.type === 'join' ? 'R5' : 'R4'})` };
			return { chain, root: d, study: d.data };
		}
		cur = d.type === 'join' ? d.a : d.data;
	}
	return { error: `dataset chain of '${id}' too long` };
}

/** Physics id accepted as the expression prefix: the root study's single physics (several: any prefix). */
function physicsIdOf(ix: SpecIndex, study: string): string | undefined {
	const p = ix.studies.get(study)?.physics ?? [];
	return p.length === 1 ? p[0] : undefined;
}

// ---- quantities, units, steps ---------------------------------------------------------------------------------------

const scopeOf = (p: ParamMap) => p as unknown as ReadonlyMap<string, ScopeValue>;

/** SI value of a spec quantity (number = SI, "5 mm", {value, unit}, param expression). */
export function siOf(q: unknown, params: ParamMap): number {
	const r = resolveQuantity(q, scopeOf(params));
	if (r.na) throw new Error('a coordinate is N/A');
	return r.si;
}

/** SI coordinates of a spec vector ([q, q, ...] or {value: [..], unit}). */
export function vectorOf(v: unknown, params: ParamMap): number[] {
	if (Array.isArray(v)) return v.map((q) => siOf(q, params));
	if (isObj(v) && Array.isArray(v.value) && typeof v.unit === 'string') {
		const u = units.parseUnit(v.unit);
		return (v.value as unknown[]).map((x) => { if (typeof x !== 'number') throw new Error('vector value is not a number'); return x * u.factor + u.offset; });
	}
	throw new Error('not a vector (expected [q, ...] or {value: [...], unit})');
}

const DIMLESS = new Set(['', '1', '-']);
/** Converter from the SI value of a result of dimension `dim` to the display unit `unit` (absent: SI). */
function displayOf(dim: number[], siUnit: string, unit: string | undefined): { unit: string; conv: (si: number) => number } {
	if (unit === undefined) return { unit: siUnit === '1' ? '' : siUnit, conv: (v) => v };
	const u = units.parseUnit(DIMLESS.has(unit.trim()) ? '1' : unit);
	if (!units.dimEq(u.dim as never, dim as never)) throw new Error(`unit '${unit}' does not match the result unit '${siUnit}'`);
	return { unit: DIMLESS.has(unit.trim()) ? '' : unit, conv: (v) => (v - u.offset) / u.factor };
}

/** Step indices of a selection on a solution (C10 StepSelection; {values, unit}: the nearest stored step of each). */
export function stepIndices(sol: Solution, sel: unknown): number[] {
	if (sel === undefined || sel === 'all') return solutionSteps(sol, 'all').indices;
	if (sel === 'first' || sel === 'last') return solutionSteps(sol, sel).indices;
	if (typeof sel === 'number') return solutionSteps(sol, [sel]).indices;
	if (Array.isArray(sel) && sel.every((x) => typeof x === 'number')) return solutionSteps(sol, sel as number[]).indices;
	if (isObj(sel) && Array.isArray(sel.values) && typeof sel.unit === 'string') {
		const st = sol.steps;
		if (!st) throw new Error('step values given, but the solution has no steps');
		const have = solutionSteps(sol, 'all').indices;
		const us = units.parseUnit(sel.unit), ut = units.parseUnit(st.unit || '1');
		if (!units.dimEq(us.dim as never, ut.dim as never)) throw new Error(`step unit '${sel.unit}' does not match the solution's '${st.unit}'`);
		return (sel.values as number[]).map((v) => {
			const si = v * us.factor + us.offset;
			let best = have[0]!, bd = Infinity;
			for (const i of have) { const d = Math.abs((st.values[i] ?? NaN) * ut.factor + ut.offset - si); if (d < bd) { bd = d; best = i; } }
			return best;
		});
	}
	throw new Error('steps: not a step selection');
}

// ---- datasets -----------------------------------------------------------------------------------------------------

type Built = { kind: 'solution' } | CutPointsDataset | LineDataset | EdgeDataset;
/** Datasets built for one run (cut lines are O(cells) to build): key = dataset id + its resolved arguments. */
export type DatasetMemo = Map<string, Built>;

function buildDataset(d: DatasetNode, run: AdapterRun, memo: DatasetMemo | undefined): Built {
	const mesh = run.mesh;
	if (d.type === 'solution') return { kind: 'solution' };
	if (d.type === 'cutplane' || d.type === 'revolve' || d.type === 'mirror' || d.type === 'join') throw new Error(`${d.type} datasets are not evaluated yet (stage ${d.type === 'join' ? 'R5' : 'R4'})`);
	let key: string, make: () => Built;
	if (d.type === 'cutpoint') {
		const pts = (Array.isArray(d.points) ? d.points : []).map((p) => vectorOf(p, run.params));
		for (const p of pts) if (p.length !== mesh.dim) throw new Error(`cut point with ${p.length} coordinates on a ${mesh.dim}D mesh`);
		key = JSON.stringify(['cutpoint', pts]);
		make = () => cutPoints(mesh, pts, { snap: SNAP });
	} else if (d.type === 'cutline') {
		const p0 = vectorOf(d.from, run.params), p1 = vectorOf(d.to, run.params);
		if (p0.length !== mesh.dim || p1.length !== mesh.dim) throw new Error(`cut line ends need ${mesh.dim} coordinates`);
		key = JSON.stringify(['cutline', p0, p1, d.n ?? null]);
		make = () => cutLine(mesh, p0, p1, d.n !== undefined ? { n: d.n, snap: SNAP } : { mode: 'crossing', snap: SNAP });
	} else if (d.type === 'edge') {
		const sel = Array.isArray(d.select) ? d.select : [];
		key = JSON.stringify(['edge', sel]);
		make = () => edgeDataset(mesh, sel);
	} else throw new Error(`dataset type '${String((d as { type?: unknown }).type)}' unknown`);
	key = `${d.id}|${mesh.hash}|${key}`;
	const hit = memo?.get(key);
	if (hit) return hit;
	const b = make();
	memo?.set(key, b);
	return b;
}

/** Region of an integral / average / max / min / measure: a selection on a solution dataset, or a line / point dataset. */
function regionOf(b: Built, over: string[] | undefined, mesh: Mesh, type: string): Region {
	if (b.kind === 'solution') {
		if (!over?.length) throw new Error(`${type} on a solution dataset needs 'over' (a selection)`);
		const kinds = new Set(over.map((id) => parseEntityId(id)?.kind ?? '?'));
		if (kinds.size !== 1) throw new Error(`'over' mixes entity kinds (${[...kinds].join(', ')}): one kind per item`);
		const k = [...kinds][0];
		if (k === 'dom') return { kind: 'domain', ids: over };
		if (k === 'bnd') return { kind: 'boundary', ids: over };
		throw new Error(`'over' of kind '${k}' is not evaluated on a ${mesh.dim}D mesh (dom or bnd)`);
	}
	if (over?.length) throw new Error(`'over' is not used on a ${b.kind} dataset`);
	if (b.kind === 'points' && type !== 'max' && type !== 'min') throw new Error(`${type} needs a line, edge or solution dataset (not cut points)`);
	return b;
}

/**
 * Facet nodes of boundaries as a cut-points region: each distinct node once, in the facet's adjacent cell at the
 * node's exact reference coordinates (NODE_REF), so H1 fields evaluate to their nodal coefficients exactly (a Newton
 * inverse map of the node position can differ in the last bits; DevLog-028 s.4).
 */
export function boundaryNodes(mesh: Mesh, ids: readonly string[]): CutPointsDataset {
	const type = mesh.cells.type, ref0 = NODE_REF[type];
	if (!ref0) throw new Error(`nodal max / min: cell type ${type} not supported`);
	const dim = mesh.dim, rd = type.startsWith('tet') || type === 'hex8' ? 3 : 2, npc = ref0.length / rd;
	const fc = mesh.facets.conn, kf = fc.length / Math.max(1, mesh.facets.boundary.length), cc = mesh.cells.conn;
	const seen = new Set<number>(), cell: number[] = [], ref: number[] = [], x: number[] = [];
	for (const f of facetsOfBoundaries(mesh, ids)) {
		const c = facetCell(mesh, f);
		for (let a = 0; a < kf; a++) {
			const n = fc[kf * f + a]!;
			if (seen.has(n)) continue;
			let loc = -1;
			for (let j = 0; j < npc; j++) if (cc[npc * c + j] === n) { loc = j; break; }
			if (loc < 0) continue;
			seen.add(n);
			cell.push(c);
			for (let q = 0; q < 3; q++) ref.push(q < rd ? ref0[rd * loc + q]! : 0);
			for (let q = 0; q < dim; q++) x.push(mesh.nodes[dim * n + q]!);
		}
	}
	return { kind: 'points', mesh, points: { mesh, n: cell.length, x: Float64Array.from(x), cell: Int32Array.from(cell), ref: Float64Array.from(ref) }, outside: [] };
}

// ---- one item ------------------------------------------------------------------------------------------------------

/** One evaluated value (SI) with diagnostics, or the reason it has none. */
export type ItemValue = { si: number; siUnit: string; dim: number[]; meta: Omit<CellMeta, 'si' | 'siUnit'> } | { error: string };

interface ItemCtx { ix: SpecIndex; run: AdapterRun; memo?: DatasetMemo }

/** Resolved inputs of an item: dataset chain, root study, physics prefix, step selection. */
function itemSetup(ctx: ItemCtx, it: EvalItem, g: EvalGroup): { b: Built; d: DatasetNode; study: string; physicsId: string | undefined; steps: unknown } | { error: string } {
	const c = chainOf(ctx.ix, it.data ?? g.data);
	if ('error' in c) return c;
	if (!ctx.run.studies.includes(c.study)) return { error: `study '${c.study}' is not solved in this session (the shown solution is of ${ctx.run.studies.join(' / ') || 'no study'})` };
	let b: Built;
	try { b = buildDataset(c.chain[0]!, ctx.run, ctx.memo); } catch (e) { return { error: msg(e) }; }
	return { b, d: c.chain[0]!, study: c.study, physicsId: physicsIdOf(ctx.ix, c.study), steps: it.steps ?? g.steps ?? c.root.steps };
}

const metaOf = (r: EvalResult): Omit<CellMeta, 'si' | 'siUnit'> => ({
	method: r.method, n: r.n, continuous: r.continuous,
	...(r.at ? { at: r.at } : {}), ...(r.nOutside ? { nOutside: r.nOutside } : {}), ...(r.nNaN ? { nNaN: r.nNaN } : {}),
	...(r.coverage ? { coverage: r.coverage } : {}), ...(r.measure ? { measure: r.measure } : {}),
});

/** Values of one item at one step: an array (point items: one per point; others: one). */
export function evalItemAt(ctx: ItemCtx, it: EvalItem, g: EvalGroup, step: number): ItemValue[] {
	const s = itemSetup(ctx, it, g);
	if ('error' in s) return [s];
	const { solution: sol, mesh, params } = ctx.run;
	const o = { mesh, params, step, ...(s.physicsId ? { physicsId: s.physicsId } : {}) };
	const expr = typeof it.expr === 'string' ? it.expr : '';
	try {
		if (it.type !== 'measure' && it.type !== 'global' && !expr) return [{ error: `${it.type} item without expr` }];
		switch (it.type) {
			case 'point': {
				if (s.b.kind !== 'points') return [{ error: `point items read a cutpoint dataset ('${s.d.id}' is ${s.d.type})` }];
				const r = evalPoint(sol, expr, s.b, o);
				return Array.from(r.values, (v, i) => (r.outside.includes(i) ? { error: `point ${i + 1} is outside the mesh` } : { si: v, siUnit: r.unit, dim: r.dim, meta: { method: 'fe_basis_at_point', n: 1, continuous: r.continuous } }));
			}
			case 'global': {
				if (!expr) return [{ error: 'global item without expr' }];
				const r = evalGlobal(sol, expr, { params, ...(s.physicsId ? { physicsId: s.physicsId } : {}) });
				return [{ si: r.value, siUnit: r.unit, dim: r.dim, meta: { method: 'global' } }];
			}
			case 'measure': {
				const r = evalMeasure(mesh, regionOf(s.b, it.over, mesh, it.type));
				return [{ si: r.value, siUnit: r.unit, dim: r.dim, meta: { method: `quad${r.revolved ? '_2pi_r' : ''}`, n: r.n } }];
			}
			case 'integral': case 'average': {
				const reg = regionOf(s.b, it.over, mesh, it.type);
				const r = it.type === 'integral' ? evalIntegral(sol, expr, reg, o) : evalAverage(sol, expr, reg, o);
				return [{ si: r.value, siUnit: r.unit, dim: r.dim, meta: metaOf(r) }];
			}
			case 'max': case 'min': {
				const reg = regionOf(s.b, it.over, mesh, it.type);
				const method = it.method ?? (s.b.kind === 'solution' ? 'nodal' : 'points');
				const f = it.type === 'max' ? evalMax : evalMin;
				// nodal on a boundary: the facet nodes at their exact reference coordinates in the adjacent cell (the
				// node values themselves, as the domain nodal path), reduced by the @amp/post kernel
				const r = method === 'nodal' && reg.kind === 'boundary'
					? { ...f(sol, expr, boundaryNodes(mesh, reg.ids), { ...o, method: 'points' }), method: 'nodal' }
					: f(sol, expr, reg, { ...o, method, ...(method === 'lattice' ? { resolution: LATTICE_LEVEL } : {}) });
				if (!Number.isFinite(r.value)) return [{ error: `${it.type} of ${expr}: no finite value (${r.nOutside ?? 0} points outside, ${r.nNaN ?? 0} NaN)` }];
				return [{ si: r.value, siUnit: r.unit, dim: r.dim, meta: metaOf(r) }];
			}
		}
		return [{ error: `item type '${String((it as { type?: unknown }).type)}' unknown` }];
	} catch (e) { return [{ error: msg(e) }]; }
}

// ---- tables ---------------------------------------------------------------------------------------------------------

/** Step-column name per solution step kind. */
const STEP_NAME: Record<string, string> = { time: 't', freq: 'freq', eigen: 'eigenvalue', param: 'param' };

/** Points of a point item's dataset (for one column per point), or null. */
function pointsOf(ctx: ItemCtx, it: EvalItem, g: EvalGroup): number[][] | null {
	const c = chainOf(ctx.ix, it.data ?? g.data);
	if ('error' in c || c.chain[0]!.type !== 'cutpoint') return null;
	try { return (c.chain[0]!.points ?? []).map((p) => vectorOf(p, ctx.run.params)); } catch { return null; }
}

/** Effective step selection of an item (C10: item > group > its dataset's solution). */
export function itemSteps(ix: SpecIndex, it: EvalItem, g: EvalGroup): unknown {
	if (it.steps !== undefined) return it.steps;
	if (g.steps !== undefined) return g.steps;
	const c = chainOf(ix, it.data ?? g.data);
	return 'error' in c ? undefined : c.root.steps;
}

/**
 * Table of an evaluation group (or of a table node: its group and orientation) over runs. Rows: one per step of the
 * group's step selection per run; a group of global items only has one row per run (module scalars do not depend on
 * the step). Columns: '#', dataset (when a run has a label or there are several runs), the step value (stepped
 * solutions), then one per item (point items: one per point). Values in the item unit, else in the SI unit of the
 * result (the first value found). An item with its own `steps` is evaluated only on the rows in them.
 */
export function evalTable(spec: unknown, id: string, runs: AdapterRun[], memo?: (run: AdapterRun) => DatasetMemo): Omit<ResultTable, 'hash' | 'ms' | 'cached'> {
	const ix = indexSpec(spec);
	const tnode = ix.tables.get(id);
	const gid = tnode ? tnode.from : id;
	const g = ix.groups.get(gid);
	const base = { id, group: gid, label: (tnode?.label ?? g?.label ?? id) as string, orient: (tnode?.orient ?? 'rows') as 'rows' | 'columns', runs: runs.map((r) => r.key) };
	if (!g) return { ...base, columns: [], rows: [], errors: [tnode ? `table '${id}': evaluation group '${gid}' not found` : `'${id}' is not an evaluation group or table`] };
	if (tnode?.enabled === false || g.enabled === false) return { ...base, columns: [], rows: [], errors: [`${tnode?.enabled === false ? `table '${id}'` : `evaluation group '${gid}'`} is disabled`] };
	const items = (Array.isArray(g.items) ? g.items : []).filter((it) => isObj(it) && it.enabled !== false);
	const errors: string[] = [];
	if (!items.length) errors.push(`evaluation group '${gid}' has no enabled items`);
	if (!runs.length) errors.push('no solution to evaluate on');
	const onlyGlobal = items.length > 0 && items.every((it) => it.type === 'global');
	const first = runs[0];
	const cols: TableColumn[] = [{ key: '#', name: '#', unit: '', kind: 'index', tip: 'row' }];
	const withDataset = runs.length > 1 || runs.some((r) => r.label);
	if (withDataset) cols.push({ key: 'dataset', name: 'dataset', unit: '', kind: 'dataset', tip: 'dataset (sweep point) the row is evaluated on' });
	const steps = first?.solution.steps;
	const withStep = !!steps && !onlyGlobal;
	if (withStep) cols.push({ key: 'step', name: STEP_NAME[steps.kind] ?? 'step', unit: steps.unit === '1' ? '' : steps.unit, kind: 'step', tip: `${steps.kind} step value (solution step index in the row tooltip)` });
	// eigenmode fields carry the solver's normalization (arbitrary scale): stated on every field-reading column
	const eigenNote = (it: EvalItem) => (first?.solution.steps?.kind === 'eigen' && it.type !== 'global' && it.type !== 'measure' ? '; eigenmode: field values in the solver normalization (arbitrary scale)' : '');
	// item columns: point items get one column per point of their dataset (from the first run's params)
	const icols: Array<{ it: EvalItem; k: number; col: TableColumn }> = [];
	const ctx0: ItemCtx | null = first ? { ix, run: first, ...(memo ? { memo: memo(first) } : {}) } : null;
	for (const it of items) {
		const pts = it.type === 'point' && ctx0 ? pointsOf(ctx0, it, g) : null;
		const n = Math.max(1, pts?.length ?? 1);
		const where = it.over?.length ? ` over ${it.over.join(' ')}` : '';
		const ds = it.data ?? g.data ?? '';
		for (let k = 0; k < n; k++) {
			const p = pts?.[k];
			const col: TableColumn = {
				key: n > 1 ? `${it.id}[${k}]` : it.id, name: n > 1 ? `${it.id}[${k + 1}]` : it.id, unit: it.unit !== undefined && !DIMLESS.has(it.unit.trim()) ? it.unit : '', kind: 'item', item: it.id, type: it.type,
				...(typeof it.expr === 'string' ? { expr: it.expr } : {}), ...(p ? { point: p } : {}),
				tip: `${it.label ? `${it.label}: ` : ''}${it.type}${it.expr ? ` of ${it.expr}` : ''}${where} on ${ds}${p ? ` at (${p.map((x) => x.toPrecision(4)).join(', ')}) m` : ''}${it.method ? `, method ${it.method}` : ''}${eigenNote(it)}`,
			};
			cols.push(col);
			icols.push({ it, k, col });
		}
	}
	const rows: TableRow[] = [];
	const siUnitSeen = new Map<TableColumn, string>();
	for (const run of runs) {
		const ctx: ItemCtx = run === first && ctx0 ? ctx0 : { ix, run, ...(memo ? { memo: memo(run) } : {}) };
		// rows: the union of the items' effective step selections (a group of global items: one row, the last step)
		const own = new Map<EvalItem, number[] | string>();
		for (const it of items) { try { own.set(it, onlyGlobal ? stepIndices(run.solution, 'last') : stepIndices(run.solution, itemSteps(ix, it, g))); } catch (e) { own.set(it, msg(e)); } }
		const rowSteps = [...new Set([...own.values()].flatMap((v) => (typeof v === 'string' ? [] : v)))].sort((a, b) => a - b);
		if (!rowSteps.length) { errors.push(`${run.label || 'run'}: ${[...new Set([...own.values()].filter((v): v is string => typeof v === 'string'))].join('; ') || 'no steps'}`); continue; }
		for (const step of rowSteps) {
			const cells: TableRow['cells'] = [rows.length + 1];
			const meta: TableRow['meta'] = [null];
			const errs: TableRow['errors'] = [null];
			if (withDataset) { cells.push(run.label || run.key.slice(0, 8)); meta.push(null); errs.push(null); }
			if (withStep) { const sv = run.solution.steps?.values[step]; cells.push(sv ?? null); meta.push(null); errs.push(sv === undefined ? `no step ${step}` : null); }
			const vals = new Map<EvalItem, ItemValue[]>();
			for (const c of icols) {
				let vs = vals.get(c.it);
				if (!vs) {
					const sel = own.get(c.it);
					vs = typeof sel === 'string' ? [{ error: sel }] : sel && !sel.includes(step) ? [{ error: NOT_SELECTED }] : evalItemAt(ctx, c.it, g, step);
					vals.set(c.it, vs);
				}
				const v = vs[c.k] ?? (vs.length === 1 && 'error' in vs[0]! ? vs[0]! : { error: `no value ${c.k + 1} (the item has ${vs.length})` });
				if ('error' in v) { cells.push(null); meta.push(null); errs.push(v.error); continue; }
				meta.push({ si: v.si, siUnit: v.siUnit, ...v.meta });
				try {
					const d = displayOf(v.dim, v.siUnit, c.it.unit);
					if (c.it.unit === undefined) {
						const seen = siUnitSeen.get(c.col);
						if (seen === undefined) { siUnitSeen.set(c.col, v.siUnit); c.col.unit = d.unit; }
						else if (seen !== v.siUnit) throw new Error(`unit '${v.siUnit}' differs from the column's '${seen}'`);
					}
					cells.push(d.conv(v.si)); errs.push(null);
				} catch (e) { cells.push(null); errs.push(msg(e)); }
			}
			rows.push({ cells, meta, errors: errs, run: run.key, step });
		}
	}
	return { ...base, columns: cols, rows, errors };
}

/** Ad hoc request -> a spec copy with a temporary evaluation group (and dataset), and the group id. */
export function adhocSpec(spec: unknown, q: AdhocRequest): { spec: unknown; group: string } {
	const s = (isObj(spec) ? structuredClone(spec) : {}) as Obj;
	const r = (isObj(s.results) ? s.results : (s.results = {})) as Obj;
	const ds = (Array.isArray(r.datasets) ? r.datasets : (r.datasets = [])) as Obj[];
	const ev = (Array.isArray(r.evaluations) ? r.evaluations : (r.evaluations = [])) as Obj[];
	let data = q.data;
	if (q.from !== undefined || q.to !== undefined) {
		data = '__adhoc_line';
		ds.push({ id: data, type: 'cutline', data: q.data, from: q.from, to: q.to, ...(q.n !== undefined ? { n: q.n } : {}) });
	} else if (q.points !== undefined) {
		data = '__adhoc_points';
		ds.push({ id: data, type: 'cutpoint', data: q.data, points: q.points });
	}
	const item: Obj = { id: '__adhoc', type: q.kind, ...(q.expr !== undefined ? { expr: q.expr } : {}), ...(q.unit !== undefined ? { unit: q.unit } : {}), ...(q.over ? { over: q.over } : {}), ...(q.method ? { method: q.method } : {}), ...(q.steps !== undefined ? { steps: q.steps } : {}) };
	if ((q.kind === 'max' || q.kind === 'min') && !q.method) {
		const d = ds.find((x) => x.id === data);
		item.method = d?.type === 'solution' ? 'nodal' : 'points';
	}
	ev.push({ id: '__adhoc_group', data, items: [item] });
	return { spec: s, group: '__adhoc_group' };
}

// ---- dataset values, nodal values ----------------------------------------------------------------------------------

/** The step a single-step request resolves to: the pick, else the dataset's own single step, else the last step. */
function stepFor(sol: Solution, pick: number | 'last' | 'first' | undefined, rootSteps: unknown): number {
	const sel = pick ?? (typeof rootSteps === 'number' || rootSteps === 'first' || rootSteps === 'last' ? rootSteps : 'last');
	return stepIndices(sol, sel).at(sel === 'first' ? 0 : -1) ?? 0;
}

export function evalDataset(spec: unknown, id: string, expr: string | null, run: AdapterRun, o: { step?: number | 'last' | 'first'; unit?: string; memo?: DatasetMemo } = {}): DatasetValues {
	const ix = indexSpec(spec), sol = run.solution, mesh = run.mesh;
	const st = sol.steps;
	const empty = (error: string, step = 0): DatasetValues => ({ id, type: 'solution', dim: mesh.dim, points: new Float64Array(0), values: null, unit: '', siUnit: '', continuous: true, outside: [], step, stepValue: st ? (st.values[step] ?? null) : null, stepUnit: st?.unit ?? null, error });
	const c = chainOf(ix, id);
	if ('error' in c) return empty(c.error);
	if (!run.studies.includes(c.study)) return empty(`study '${c.study}' is not solved in this session`);
	const d = c.chain[0]!;
	if (d.type === 'solution') return empty(`'${id}' is a solution dataset: use nodal values for its field plots`);
	let step: number;
	try { step = stepFor(sol, o.step, c.root.steps); } catch (e) { return empty(msg(e)); }
	let b: Built;
	try { b = buildDataset(d, run, o.memo); } catch (e) { return empty(msg(e), step); }
	if (b.kind === 'solution') return empty('solution dataset', step);
	const ps: PointSet = b.points;
	const out: DatasetValues = {
		id, type: d.type as DatasetValues['type'], dim: mesh.dim, points: Float64Array.from(ps.x), values: null, unit: '', siUnit: '', continuous: true,
		outside: [], step, stepValue: st ? (st.values[step] ?? null) : null, stepUnit: st?.unit ?? null,
		...(b.kind === 'line' ? { s: Float64Array.from(b.s), length: b.length, covered: b.covered, ...(b.mode === 'crossing' ? { pieces: Float64Array.from(b.pieces) } : {}) } : {}),
		...(b.kind === 'edge' ? { s: Float64Array.from(b.s), length: b.length, chains: b.chainPoints.map(([a, e]) => [a, e] as [number, number]) } : {}),
	};
	for (let i = 0; i < ps.n; i++) if (ps.cell[i]! < 0) out.outside.push(i);
	if (expr === null) return out;
	try {
		const pid = physicsIdOf(ix, c.study);
		const r = evalPoint(sol, expr, ps, { mesh, params: run.params, step, ...(pid ? { physicsId: pid } : {}) });
		const disp = displayOf(r.dim, r.unit, o.unit);
		out.values = r.values.map(disp.conv);
		out.unit = disp.unit; out.siUnit = r.unit; out.continuous = r.continuous;
	} catch (e) { out.error = msg(e); }
	return out;
}

/** Point set of every mesh node, each in the first cell that has it. */
function nodePoints(mesh: Mesh): PointSet {
	const type = mesh.cells.type, ref0 = NODE_REF[type];
	if (!ref0) throw new Error(`nodal values: cell type ${type} not supported`);
	const dim = mesh.dim, nn = mesh.nodes.length / dim, conn = mesh.cells.conn;
	const rd = type.startsWith('tet') || type === 'hex8' ? 3 : 2, npc = ref0.length / rd;
	const cell = new Int32Array(nn).fill(-1), ref = new Float64Array(3 * nn);
	for (let c = 0; c * npc < conn.length; c++)
		for (let a = 0; a < npc; a++) {
			const n = conn[c * npc + a]!;
			if (cell[n]! >= 0) continue;
			cell[n] = c;
			for (let s = 0; s < rd; s++) ref[3 * n + s] = ref0[rd * a + s]!;
		}
	return { mesh, n: nn, x: Float64Array.from(mesh.nodes), cell, ref };
}

export function evalNodal(spec: unknown, expr: string, run: AdapterRun, o: { step?: number | 'last' | 'first'; unit?: string; dataset?: string } = {}): NodalValues {
	const sol = run.solution, mesh = run.mesh;
	const space = mesh.cells.type === 'tri6' || mesh.cells.type === 'tet10' ? 'H1P2' : 'H1P1';
	const fail = (error: string, step = 0): NodalValues => ({ values: null, space, unit: '', siUnit: '', continuous: true, step, meshHash: mesh.hash, error });
	const ix = indexSpec(spec);
	let study = run.studies[0], rootSteps: unknown;
	if (o.dataset) {
		const c = chainOf(ix, o.dataset);
		if ('error' in c) return fail(c.error);
		if (c.chain[0]!.type !== 'solution') return fail(`nodal values read a solution dataset ('${o.dataset}' is ${c.chain[0]!.type})`);
		if (!run.studies.includes(c.study)) return fail(`study '${c.study}' is not solved in this session`);
		study = c.study; rootSteps = c.root.steps;
	}
	let step: number;
	try { step = stepFor(sol, o.step, rootSteps); } catch (e) { return fail(msg(e)); }
	try {
		const pid = study ? physicsIdOf(ix, study) : undefined;
		const f = compileFieldExpr(sol, expr, { mesh, params: run.params, step, ...(pid ? { physicsId: pid } : {}) });
		const v = f.evaluate(nodePoints(mesh));
		const disp = displayOf(f.dim, f.unit, o.unit);
		return { values: v.map(disp.conv), space, unit: disp.unit, siUnit: f.unit, continuous: f.continuous, step, meshHash: mesh.hash };
	} catch (e) { return fail(msg(e), step); }
}

/** Single value of an evaluation item (headlines, eval harness): its first value at its step (single-step items) or at the last step of its selection. */
export function evalItemValue(spec: unknown, itemId: string, run: AdapterRun, o: { step?: number | 'last' | 'first'; point?: number; memo?: DatasetMemo } = {}): ({ value: number; unit: string } & Exclude<ItemValue, { error: string }>) | { error: string } {
	const ix = indexSpec(spec);
	const e = ix.items.get(itemId);
	if (!e) return { error: `evaluation item '${itemId}' not found` };
	const { item: it, group: g } = e;
	if (it.enabled === false || g.enabled === false) return { error: `evaluation item '${itemId}' is disabled` };
	const c = chainOf(ix, it.data ?? g.data);
	if ('error' in c) return c;
	let step: number;
	try {
		const sel = itemSteps(ix, it, g);
		step = o.step !== undefined ? stepFor(run.solution, o.step, undefined) : (stepIndices(run.solution, sel).at(-1) ?? 0);
	} catch (err) { return { error: msg(err) }; }
	const vals = evalItemAt({ ix, run, ...(o.memo ? { memo: o.memo } : {}) }, it, g, step);
	const v = vals[o.point ?? 0];
	if (!v) return { error: `item '${itemId}' has ${vals.length} value(s), no index ${o.point ?? 0}` };
	if ('error' in v) return v;
	try { const d = displayOf(v.dim, v.siUnit, it.unit); return { ...v, value: d.conv(v.si), unit: d.unit }; } catch (err) { return { error: msg(err) }; }
}
