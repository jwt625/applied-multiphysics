// SPDX-License-Identifier: GPL-3.0-or-later
// Results tree operations (DevLog-027 s.1.2, DevLog-023 s.3.4): "+" menus generated from the schema unions of
// @amp/spec (dataset, evaluation item, plot group and plot item types), node templates, and the JSON Patch of each
// tree action (add, delete, duplicate, enable / disable, move). Every action is one patch, applied as one operation by
// the caller, so a UI gesture and an agent `apply_ops` with the same patch give the same YAML text.
// Templates are filled from the model only (DevLog-023 s.3.1 rule 5): the first study, the first solution dataset, the
// mesh bounding box, the first domain / boundary id, the first field of the solution (or of RESULT_NAMES), and the
// display unit the spec already uses for that expression. Nothing physical is invented; a type whose inputs do not
// exist is listed with the reason instead.
import { DATASET_TYPES, EVAL_ITEM_TYPES, PLOT_GROUP_TYPES, PLOT_ITEM_TYPES, resultUnits, type ResultSection } from '@amp/spec';
import type { JsonPatchOp, Mesh, Solution } from '@amp/spec/types';

type O = Record<string, unknown>;
const isObj = (x: unknown): x is O => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x: unknown): O[] => (Array.isArray(x) ? (x.filter(isObj) as O[]) : []);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** What the templates may read: the spec data, the current mesh and solution (both optional). */
export interface PlotCtx {
	data: unknown;
	mesh?: Mesh | null;
	sol?: Solution | null;
	/** fields and scalars per physics type when no solution exists (RESULT_NAMES of @amp/physics) */
	names?: Record<string, { fields: string[]; scalars: string[] }>;
}

export interface MenuEntry {
	section: ResultSection;
	/** node type (evaluation groups: 'group', tables: 'table') */
	type: string;
	label: string;
	/** id of the group the item goes into (items only) */
	group?: string;
	/** why the entry cannot be added now (shown in the tooltip; the entry is disabled) */
	disabled?: string;
	tip: string;
}

export const DATASET_LABEL: Record<string, string> = {
	solution: 'Solution', cutpoint: 'Cut Point', cutline: 'Cut Line', edge: 'Edge', cutplane: 'Cut Plane', revolve: 'Revolution', mirror: 'Mirror', join: 'Join'
};
export const EVAL_LABEL: Record<string, string> = {
	point: 'Point Evaluation', global: 'Global Evaluation', integral: 'Integration', average: 'Average', max: 'Maximum', min: 'Minimum', measure: 'Measure'
};
export const GROUP_LABEL: Record<string, string> = { plot1d: '1D Plot Group', plot2d: '2D Plot Group', plot3d: '3D Plot Group' };
export const ITEM_LABEL: Record<string, string> = {
	linegraph: 'Line Graph', pointgraph: 'Point Graph', global: 'Global', tablegraph: 'Table Graph',
	surface: 'Surface', contour: 'Contour', arrow: 'Arrow Surface', streamline: 'Streamline', line: 'Line', maxmin: 'Max/Min Marker', point: 'Point', mesh: 'Mesh',
	deformation: 'Deformation', height: 'Height', slice: 'Slice', isosurface: 'Isosurface', volume: 'Volume'
};
const ID_PREFIX: Record<string, string> = {
	solution: 'sol', cutpoint: 'cpt', cutline: 'cln', edge: 'edg', cutplane: 'cpl', revolve: 'rev', mirror: 'mir', join: 'join',
	group: 'ev', table: 'tbl', plot1d: 'pg1d', plot2d: 'pg2d', plot3d: 'pg3d',
	linegraph: 'lg', pointgraph: 'ptg', global: 'glb', tablegraph: 'tg', surface: 'surf', contour: 'cont', arrow: 'arr', streamline: 'strm', line: 'line',
	maxmin: 'mm', point: 'pt', mesh: 'mesh', deformation: 'dfm', height: 'hgt', slice: 'slc', isosurface: 'iso', volume: 'vol',
	integral: 'int', average: 'avg', max: 'max', min: 'min', measure: 'meas'
};

/** Every string at an `id` key anywhere in the data (one id namespace, C10). */
export function allIds(data: unknown, out = new Set<string>()): Set<string> {
	if (Array.isArray(data)) for (const x of data) allIds(x, out);
	else if (isObj(data)) for (const [k, v] of Object.entries(data)) { if (k === 'id' && typeof v === 'string') out.add(v); else allIds(v, out); }
	return out;
}
/** First free id `<prefix><n>` (n from 1). */
export function freshId(used: Set<string>, prefix: string): string {
	for (let n = 1; ; n++) { const id = `${prefix}${n}`; if (!used.has(id)) { used.add(id); return id; } }
}

const results = (data: unknown): O => (isObj(data) && isObj(data.results) ? data.results : {});
const section = (data: unknown, sec: ResultSection): O[] => arr(results(data)[sec]);
const geomDim = (data: unknown): number => Number((isObj(data) && isObj(data.geometry) ? data.geometry.dim : 2) ?? 2) || 2;
const axisym = (data: unknown): boolean => !!(isObj(data) && isObj(data.geometry) && data.geometry.axisym);

/** Shape of a dataset by its chain: 'domain' (solution, mirror, join, revolve), 'line', 'points', 'plane'; and its dimension. */
export function datasetShape(data: unknown, id: string | undefined, depth = 0): { kind: 'domain' | 'line' | 'points' | 'plane' | null; dim: number } {
	const d = section(data, 'datasets').find((x) => x.id === id);
	const gd = geomDim(data);
	if (!d || depth > 32) return { kind: null, dim: gd };
	switch (d.type) {
		case 'solution': return { kind: 'domain', dim: gd };
		case 'cutline': case 'edge': return { kind: 'line', dim: datasetShape(data, str(d.data), depth + 1).dim };
		case 'cutpoint': return { kind: 'points', dim: datasetShape(data, str(d.data), depth + 1).dim };
		case 'cutplane': return { kind: 'plane', dim: 2 };
		case 'revolve': return { kind: 'domain', dim: 3 };
		case 'mirror': return datasetShape(data, str(d.data), depth + 1);
		case 'join': return datasetShape(data, str(d.a), depth + 1);
		default: return { kind: null, dim: gd };
	}
}
const datasetsOf = (data: unknown, pred: (s: ReturnType<typeof datasetShape>, d: O) => boolean): string[] =>
	section(data, 'datasets').filter((d) => d.enabled !== false && pred(datasetShape(data, str(d.id)), d)).map((d) => str(d.id));

/** Physics id and field / scalar names of the first study's physics; vector fields from the solution. */
function fieldsOf(ctx: PlotCtx): { phys: string; scalarFields: string[]; vectorFields: string[]; scalars: string[] } {
	const data = ctx.data;
	const ph = isObj(data) ? arr(data.physics) : [];
	const st = isObj(data) ? arr(data.studies) : [];
	const want = new Set(st.flatMap((s) => (Array.isArray(s.physics) ? s.physics.map(String) : [])));
	const p = ph.find((x) => want.has(str(x.id))) ?? ph[0];
	const phys = str(p?.id);
	if (ctx.sol) {
		const f = ctx.sol.fields;
		const draw = (x: { space: string }) => x.space === 'H1P1' || x.space === 'H1P2' || x.space === 'DG0';
		return {
			phys,
			scalarFields: [...new Set(f.filter((x) => x.components === 1 && draw(x)).map((x) => x.name))],
			vectorFields: [...new Set(f.filter((x) => x.components > 1 && draw(x)).map((x) => x.name))],
			scalars: Object.keys(ctx.sol.scalars ?? {})
		};
	}
	const n = ctx.names?.[str(p?.type)];
	return { phys, scalarFields: (n?.fields ?? []).filter((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x)), vectorFields: [], scalars: (n?.scalars ?? []).filter((x) => !x.includes('<')) };
}
const exprOf = (phys: string, name: string) => (phys ? `${phys}.${name}` : name);
/** The spec's display unit for an expression, when it already has one (e.g. solid.sxx -> MPa). */
const unitFor = (data: unknown, expr: string): string | undefined => resultUnits(results(data)).find((r) => r.expr === expr)?.unit;
/** Expression of the default field: the spec's first surface, else the first scalar field. */
function defaultExpr(ctx: PlotCtx): string | null {
	const surf = section(ctx.data, 'plots').flatMap((g) => arr(g.items)).find((it) => it.type === 'surface' && typeof it.expr === 'string');
	if (surf) return str(surf.expr);
	const f = fieldsOf(ctx);
	return f.scalarFields[0] ? exprOf(f.phys, f.scalarFields[0]) : null;
}

/** Bounding box of the mesh (SI m), or null. */
export function meshBox(mesh: Mesh | null | undefined): { lo: number[]; hi: number[] } | null {
	if (!mesh) return null;
	const d = mesh.dim, N = mesh.nodes, lo = Array(d).fill(Infinity), hi = Array(d).fill(-Infinity);
	for (let i = 0; i < N.length; i += d) for (let k = 0; k < d; k++) { const v = N[i + k]!; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
	return Number.isFinite(lo[0]) ? { lo, hi } : null;
}
/** Length unit for coordinates written by the UI (display only: mm for a 50 mm model). */
export function coordUnit(mesh: Mesh | null | undefined): { unit: string; f: number } {
	const b = meshBox(mesh);
	const size = b ? Math.max(...b.hi.map((v, i) => v - b.lo[i]!)) : 1;
	return size < 1e-4 ? { unit: 'um', f: 1e6 } : size < 0.2 ? { unit: 'mm', f: 1e3 } : size < 2 ? { unit: 'cm', f: 1e2 } : { unit: 'm', f: 1 };
}
/** A point (SI m) as a spec vector in the model's length unit, rounded to 6 significant digits. */
export function vec(p: readonly number[], u: { unit: string; f: number }): { value: number[]; unit: string } {
	return { value: p.map((v) => (v === 0 ? 0 : Number((v * u.f).toPrecision(6)))), unit: u.unit };
}

type Built = { node: O } | { disabled: string };

function firstStudy(data: unknown): string | null {
	const st = isObj(data) ? arr(data.studies) : [];
	return st.length ? str(st[0]!.id) : null;
}
function firstSolution(data: unknown): string | null {
	return section(data, 'datasets').find((d) => d.type === 'solution' && d.enabled !== false)?.id as string ?? null;
}
const firstDomain = (mesh: Mesh | null | undefined): string | null => mesh?.entities.domains[0]?.id ?? null;
const firstBoundary = (mesh: Mesh | null | undefined): string | null => mesh?.entities.boundaries[0]?.id ?? null;

function datasetTemplate(ctx: PlotCtx, type: string, id: string): Built {
	const data = ctx.data, gd = geomDim(data), sol = firstSolution(data), box = meshBox(ctx.mesh), u = coordUnit(ctx.mesh);
	const needSol = (): Built | null => (sol ? null : { disabled: 'add a Solution dataset first' });
	const centre = box ? box.lo.map((v, i) => 0.5 * (v + box.hi[i]!)) : Array(gd).fill(0);
	switch (type) {
		case 'solution': {
			const st = firstStudy(data);
			return st ? { node: { id, type, data: st } } : { disabled: 'the model has no study' };
		}
		case 'cutpoint': return needSol() ?? { node: { id, type, data: sol, points: [vec(centre, u)] } };
		case 'cutline': {
			if (!box) return { disabled: 'mesh the model first (the line runs along the bounding-box diagonal)' };
			return needSol() ?? { node: { id, type, data: sol, from: vec(box.lo, u), to: vec(box.hi, u) } };
		}
		case 'edge': {
			if (gd === 3) return { disabled: '3D edges are not in the mesh entity table yet (DevLog-026 s.6)' };
			const b = firstBoundary(ctx.mesh);
			if (!b) return { disabled: 'mesh the model first (needs a boundary id)' };
			return needSol() ?? { node: { id, type, data: sol, select: [b] } };
		}
		case 'cutplane': return gd !== 3 ? { disabled: 'a cut plane needs a 3D model' } : needSol() ?? { node: { id, type, data: sol, point: vec(centre, u), normal: [0, 0, 1] } };
		case 'revolve': return !axisym(data) ? { disabled: 'a revolution needs an axisymmetric model' } : needSol() ?? { node: { id, type, data: sol, sweep: { value: 360, unit: 'deg' }, layers: 64 } };
		case 'mirror': return needSol() ?? { node: { id, type, data: sol, planes: [{ normal: gd === 3 ? [1, 0, 0] : [1, 0] }] } };
		case 'join': {
			const ds = section(data, 'datasets').filter((d) => d.type === 'solution');
			return ds.length < 2 ? { disabled: 'a join needs two solution datasets' } : { node: { id, type, a: ds[0]!.id, b: ds[1]!.id, op: 'difference' } };
		}
	}
	return { disabled: `unknown dataset type ${type}` };
}

/** Evaluation item on the group's dataset: `over` the first domain when that dataset is a solution. */
function evalItemTemplate(ctx: PlotCtx, group: O, type: string, id: string): Built {
	const data = ctx.data, f = fieldsOf(ctx), e = defaultExpr(ctx), dsId = str(group.data);
	const shape = datasetShape(data, dsId);
	const dom = firstDomain(ctx.mesh);
	const unit = (x: string) => { const u = unitFor(data, x); return u ? { unit: u } : {}; };
	const over = (): O | Built => (shape.kind === 'domain' ? (dom ? { over: [dom] } : { disabled: 'mesh the model first (needs a domain id)' }) : {});
	switch (type) {
		case 'point': {
			const cp = datasetsOf(data, (s) => s.kind === 'points')[0];
			if (!cp) return { disabled: 'add a Cut Point dataset first' };
			return e ? { node: { id, type, data: cp, expr: e, ...unit(e) } } : { disabled: 'no field to evaluate (Compute first)' };
		}
		case 'global': {
			const sc = f.scalars[0];
			return sc ? { node: { id, type, expr: exprOf(f.phys, sc) } } : { disabled: 'the solution has no module scalar (Compute first)' };
		}
		case 'integral': case 'average': case 'max': case 'min': {
			if (!e) return { disabled: 'no field to evaluate (Compute first)' };
			const o = over();
			if ('disabled' in o) return o as Built;
			return { node: { id, type, expr: e, ...unit(e), ...o, ...(type === 'max' || type === 'min' ? { method: shape.kind === 'line' || shape.kind === 'points' ? 'points' : 'nodal' } : {}) } };
		}
		case 'measure': {
			const o = over();
			if ('disabled' in o) return o as Built;
			return { node: { id, type, ...o } };
		}
	}
	return { disabled: `unknown evaluation type ${type}` };
}

function plotGroupTemplate(ctx: PlotCtx, type: string, id: string, used: Set<string>): Built {
	const data = ctx.data, gd = geomDim(data);
	if (type === 'plot1d') return { node: { id, type, items: [] } };
	const want = type === 'plot2d' ? 2 : 3;
	const ds = datasetsOf(data, (s) => (s.kind === 'domain' && s.dim === want) || (want === 2 && s.kind === 'plane'))[0];
	if (!ds) return { disabled: want === 2 ? (gd === 3 ? 'add a Cut Plane dataset first' : 'add a Solution dataset first') : gd === 3 ? 'add a Solution dataset first' : 'a 3D plot group needs a 3D model or a Revolution dataset' };
	const e = defaultExpr(ctx);
	const items = e ? [{ id: freshId(used, ID_PREFIX.surface!), type: 'surface', expr: e, ...(unitFor(data, e) ? { unit: unitFor(data, e) } : {}) }] : [];
	return { node: { id, type, data: ds, items } };
}

function plotItemTemplate(ctx: PlotCtx, group: O, type: string, id: string): Built {
	const data = ctx.data, f = fieldsOf(ctx), e = defaultExpr(ctx);
	const unit = (x: string) => { const u = unitFor(data, x); return u ? { unit: u } : {}; };
	const needE = (): Built | null => (e ? null : { disabled: 'no field to plot (Compute first)' });
	const vecE = f.vectorFields[0] ? exprOf(f.phys, f.vectorFields[0]) : null;
	const needV = (): Built | null => (vecE ? null : { disabled: 'the solution has no vector field (Compute first)' });
	const box = meshBox(ctx.mesh), u = coordUnit(ctx.mesh);
	switch (type) {
		case 'linegraph': {
			const ln = datasetsOf(data, (s) => s.kind === 'line')[0];
			if (!ln) return { disabled: 'add a Cut Line or Edge dataset first (or draw one on the 2D canvas)' };
			return needE() ?? { node: { id, type, data: ln, x: 'arc', expr: e, ...unit(e!) } };
		}
		case 'pointgraph': {
			const cp = datasetsOf(data, (s) => s.kind === 'points')[0];
			if (!cp) return { disabled: 'add a Cut Point dataset first' };
			return needE() ?? { node: { id, type, data: cp, expr: e, ...unit(e!) } };
		}
		case 'global': {
			const sc = f.scalars[0];
			return sc ? { node: { id, type, data: firstSolution(data), expr: exprOf(f.phys, sc) } } : { disabled: 'the solution has no module scalar (Compute first)' };
		}
		case 'tablegraph': {
			const t = section(data, 'tables')[0];
			return t ? { node: { id, type, table: t.id } } : { disabled: 'add a Table first' };
		}
		case 'surface': case 'volume': return needE() ?? { node: { id, type, expr: e, ...unit(e!) } };
		case 'contour': return needE() ?? { node: { id, type, expr: e, ...unit(e!), levels: { count: 14 } } };
		case 'isosurface': return needE() ?? { node: { id, type, expr: e, ...unit(e!), levels: { count: 5 } } };
		case 'slice': {
			if (!box || box.lo.length !== 3) return { disabled: 'mesh the 3D model first' };
			return needE() ?? { node: { id, type, expr: e, ...unit(e!), normal: 'x', at: [{ value: Number((0.5 * (box.lo[0]! + box.hi[0]!) * u.f).toPrecision(6)), unit: u.unit }] } };
		}
		case 'arrow': case 'streamline': return needV() ?? { node: { id, type, expr: vecE } };
		case 'deformation': return needV() ?? { node: { id, type, expr: vecE, scale: 'auto' } };
		case 'line': {
			const gd = section(data, 'datasets').find((d) => d.id === group.data);
			if (gd?.type !== 'solution') return { disabled: `a line plot draws on the boundaries of a Solution dataset (the group's dataset is ${gd ? String(gd.type) : 'not set'})` };
			return needE() ?? { node: { id, type, expr: e, ...unit(e!) } };
		}
		case 'maxmin': return needE() ?? { node: { id, type, expr: e, ...unit(e!), show: 'both', method: 'nodal' } };
		case 'point': {
			const cp = datasetsOf(data, (s) => s.kind === 'points' && s.dim === (group.type === 'plot3d' ? 3 : 2))[0];
			if (!cp) return { disabled: 'add a Cut Point dataset first (or click one on the 2D canvas)' };
			return { node: { id, type, data: cp, ...(e ? { expr: e, ...unit(e) } : {}) } };
		}
		case 'mesh': return { node: { id, type } };
		case 'height': return needE() ?? { node: { id, type, expr: e, ...unit(e!), scale: 'auto' } };
	}
	return { disabled: `unknown plot item type ${type}` };
}

/** "+" menu of a folder (section) or of a group (its items). */
export function addMenu(ctx: PlotCtx, sec: ResultSection, groupId?: string): MenuEntry[] {
	const data = ctx.data, used = allIds(data);
	const out: MenuEntry[] = [];
	const push = (type: string, label: string, b: Built, tip: string, group?: string) => out.push({ section: sec, type, label, tip, ...(group ? { group } : {}), ...('disabled' in b ? { disabled: b.disabled } : {}) });
	const probe = new Set(used);
	if (sec === 'datasets') for (const t of DATASET_TYPES) push(t, DATASET_LABEL[t] ?? t, datasetTemplate(ctx, t, 'x'), `dataset type ${t}`);
	else if (sec === 'tables') {
		const ev = section(data, 'evaluations')[0];
		push('table', 'Table', ev ? { node: {} } : { disabled: 'add an Evaluation Group first' }, 'table of an evaluation group (values in session memory)');
	} else if (sec === 'evaluations' && !groupId) {
		push('group', 'Evaluation Group', firstSolution(data) ? { node: {} } : { disabled: 'add a Solution dataset first' }, 'evaluation group (items evaluated on its dataset; one table row per step)');
	} else if (sec === 'evaluations' && groupId) {
		const g = section(data, 'evaluations').find((x) => x.id === groupId);
		if (g) for (const t of EVAL_ITEM_TYPES) push(t, EVAL_LABEL[t] ?? t, evalItemTemplate(ctx, g, t, 'x'), `evaluation item type ${t}`, groupId);
	} else if (sec === 'plots' && !groupId) {
		for (const t of PLOT_GROUP_TYPES) push(t, GROUP_LABEL[t] ?? t, plotGroupTemplate(ctx, t, 'x', probe), `plot group type ${t}`);
	} else if (sec === 'plots' && groupId) {
		const g = section(data, 'plots').find((x) => x.id === groupId);
		const types = g ? (PLOT_ITEM_TYPES as Record<string, readonly string[]>)[str(g.type)] ?? [] : [];
		for (const t of types) push(t, ITEM_LABEL[t] ?? t, plotItemTemplate(ctx, g!, t, 'x'), `${str(g!.type)} item type ${t}`, groupId);
	}
	return out;
}

/** Patch that appends a node to an array at `arrPath` (creating /results and the section when absent). */
function appendPatch(data: unknown, sec: ResultSection, value: O, groupIndex?: number): JsonPatchOp[] {
	const r = isObj(data) ? data.results : undefined;
	if (groupIndex !== undefined) return [{ op: 'add', path: `/results/${sec}/${groupIndex}/items/-`, value }];
	if (!isObj(r)) return [{ op: 'add', path: '/results', value: { [sec]: [value] } }];
	if (!Array.isArray(r[sec])) return [{ op: 'add', path: `/results/${sec}`, value: [value] }];
	return [{ op: 'add', path: `/results/${sec}/-`, value }];
}

/** Node of a menu entry with fresh ids (null when the entry is disabled). */
export function buildNode(ctx: PlotCtx, e: MenuEntry): O | null {
	if (e.disabled) return null;
	const data = ctx.data, used = allIds(data);
	const id = freshId(used, ID_PREFIX[e.type] ?? 'n');
	let b: Built;
	if (e.section === 'datasets') b = datasetTemplate(ctx, e.type, id);
	else if (e.section === 'tables') b = { node: { id, from: section(data, 'evaluations')[0]?.id } };
	else if (e.section === 'evaluations' && !e.group) b = { node: { id, data: firstSolution(data), items: [] } };
	else if (e.section === 'evaluations') b = evalItemTemplate(ctx, section(data, 'evaluations').find((x) => x.id === e.group) ?? {}, e.type, id);
	else if (!e.group) b = plotGroupTemplate(ctx, e.type, id, used);
	else b = plotItemTemplate(ctx, section(data, 'plots').find((x) => x.id === e.group) ?? {}, e.type, id);
	return 'node' in b ? b.node : null;
}

/** Add: one patch, the new node's id and JSON Pointer (index form, after the patch). */
export function addPatch(ctx: PlotCtx, e: MenuEntry, node = buildNode(ctx, e)): { patch: JsonPatchOp[]; id: string; pointer: string } | null {
	if (!node) return null;
	const data = ctx.data;
	if (e.group) {
		const gi = section(data, e.section).findIndex((x) => x.id === e.group);
		if (gi < 0) return null;
		const n = arr(section(data, e.section)[gi]!.items).length;
		return { patch: appendPatch(data, e.section, node, gi), id: str(node.id), pointer: `/results/${e.section}/${gi}/items/${n}` };
	}
	const n = section(data, e.section).length;
	return { patch: appendPatch(data, e.section, node), id: str(node.id), pointer: `/results/${e.section}/${n}` };
}

/** Results node at a pointer `/results/<sec>/<i>[/items/<j>]`: the array, index and node. */
export function nodeAt(data: unknown, pointer: string): { sec: ResultSection; list: O[]; i: number; node: O; base: string } | null {
	const m = /^\/results\/(datasets|evaluations|tables|plots)\/(\d+)(?:\/items\/(\d+))?$/.exec(pointer);
	if (!m) return null;
	const sec = m[1] as ResultSection, gi = Number(m[2]);
	const g = section(data, sec)[gi];
	if (!g) return null;
	if (m[3] === undefined) return { sec, list: section(data, sec), i: gi, node: g, base: `/results/${sec}` };
	const items = arr(g.items), j = Number(m[3]);
	return items[j] ? { sec, list: items, i: j, node: items[j]!, base: `/results/${sec}/${gi}/items` } : null;
}

export function removePatch(data: unknown, pointer: string): JsonPatchOp[] {
	return nodeAt(data, pointer) ? [{ op: 'remove', path: pointer }] : [];
}

/**
 * Delete a node and every results node that reads it, transitively (a dataset, the datasets cut from it, the groups and
 * items that plot or evaluate them, tables of a removed evaluation group), in one patch, so the model stays valid.
 * Items are removed before groups, each list from the highest index down. `removed` lists the ids (the node first).
 */
export function cascadeRemovePatch(data: unknown, pointer: string): { patch: JsonPatchOp[]; removed: string[] } {
	const at = nodeAt(data, pointer);
	if (!at) return { patch: [], removed: [] };
	const r = results(data);
	const gone = new Set<string>([str(at.node.id)]);
	for (const it of arr(at.node.items)) gone.add(str(it.id));
	const reads = (n: O) => ['data', 'a', 'b', 'from', 'table'].some((k) => typeof n[k] === 'string' && gone.has(n[k] as string)) || (Array.isArray(n.columns) && n.columns.some((c) => gone.has(String(c))));
	for (let grew = true; grew; ) {
		grew = false;
		for (const sec of ['datasets', 'evaluations', 'tables', 'plots'] as const)
			for (const n of arr(r[sec])) {
				if (!gone.has(str(n.id)) && reads(n)) { gone.add(str(n.id)); for (const it of arr(n.items)) gone.add(str(it.id)); grew = true; }
				for (const it of arr(n.items)) if (!gone.has(str(it.id)) && reads(it)) { gone.add(str(it.id)); grew = true; }
			}
	}
	const items: Array<[number, number, string]> = [], tops: Array<[number, string]> = [];
	for (const sec of ['datasets', 'evaluations', 'tables', 'plots'] as const)
		arr(r[sec]).forEach((n, i) => {
			if (gone.has(str(n.id))) tops.push([i, `/results/${sec}/${i}`]);
			else arr(n.items).forEach((it, j) => { if (gone.has(str(it.id))) items.push([i, j, `/results/${sec}/${i}/items/${j}`]); });
		});
	items.sort((p, q) => q[1] - p[1]);
	tops.sort((p, q) => q[0] - p[0]);
	const patch: JsonPatchOp[] = [...items.map(([, , path]) => ({ op: 'remove' as const, path })), ...tops.map(([, path]) => ({ op: 'remove' as const, path }))];
	const first = str(at.node.id);
	return { patch, removed: [first, ...[...gone].filter((x) => x !== first)] };
}

/** Duplicate after the original, with fresh ids for the node and its items. */
export function duplicatePatch(data: unknown, pointer: string): { patch: JsonPatchOp[]; id: string; pointer: string } | null {
	const at = nodeAt(data, pointer);
	if (!at) return null;
	const used = allIds(data);
	const prefixOf = (id: string, type: string) => ID_PREFIX[type] ?? (id.replace(/\d+$/, '') || 'n');
	const copy = structuredClone(at.node) as O;
	copy.id = freshId(used, prefixOf(str(at.node.id), str(at.node.type) || (at.sec === 'tables' ? 'table' : at.sec === 'evaluations' ? 'group' : '')));
	if (Array.isArray(copy.items)) copy.items = (copy.items as O[]).map((it) => (isObj(it) ? { ...it, id: freshId(used, prefixOf(str(it.id), str(it.type))) } : it));
	const p = `${at.base}/${at.i + 1}`;
	return { patch: [{ op: 'add', path: p, value: copy }], id: str(copy.id), pointer: p };
}

/** Disable (`enabled: false`) or enable (the key removed: absent = enabled). */
export function togglePatch(data: unknown, pointer: string): JsonPatchOp[] {
	const at = nodeAt(data, pointer);
	if (!at) return [];
	return at.node.enabled === false ? [{ op: 'remove', path: `${pointer}/enabled` }] : [{ op: 'add', path: `${pointer}/enabled`, value: false }];
}

export function movePatch(data: unknown, pointer: string, dir: -1 | 1): { patch: JsonPatchOp[]; pointer: string } | null {
	const at = nodeAt(data, pointer);
	if (!at) return null;
	const j = at.i + dir;
	if (j < 0 || j >= at.list.length) return null;
	return { patch: [{ op: 'move', from: pointer, path: `${at.base}/${j}` }], pointer: `${at.base}/${j}` };
}

// ------------------------------------------------------------------------------------------------ quick view, drawing

/** Toolbar state of the quick view (Graphics) that "Save as plot group" writes. */
export interface QuickView {
	/** field name of the solution, its component (-1 magnitude) and number of components */
	field: string;
	comp: number;
	components: number;
	axisym: boolean;
	step: number;
	nSteps: number;
	/** display unit ('' for none: SI or a normalized eigenmode) */
	unit: string;
	rule: 'full' | 'robust';
	log: boolean;
	colormap: string;
	contours: boolean;
	/** number of contour levels drawn (nice ticks) */
	levels: number;
	wire: boolean;
}

/** Expression of a field component: `.x .y .z` (`.r .z`, `.r .phi .z` axisym), magnitude as sqrt of the squares. */
export function componentExpr(phys: string, field: string, comp: number, n: number, axisym: boolean): string {
	const base = exprOf(phys, field);
	if (n <= 1) return base;
	const names = axisym ? (n === 3 ? ['r', 'phi', 'z'] : ['r', 'z']) : ['x', 'y', 'z'].slice(0, n);
	if (comp >= 0) return `${base}.${names[comp]}`;
	return `sqrt(${names.map((c) => `${base}.${c}^2`).join(' + ')})`;
}

/** "Save as plot group": one patch adding a plot2d group (surface, contour when on, mesh when wireframe). */
export function quickViewPatch(ctx: PlotCtx, q: QuickView): { patch: JsonPatchOp[]; id: string; pointer: string } | null {
	const data = ctx.data, used = allIds(data);
	const ds = datasetsOf(data, (s) => s.kind === 'domain' && s.dim === 2)[0];
	const patch: JsonPatchOp[] = [];
	let dsId = ds;
	let shadow = data;
	if (!dsId) {
		const st = firstStudy(data);
		if (!st) return null;
		dsId = freshId(used, ID_PREFIX.solution!);
		const n = { id: dsId, type: 'solution', data: st };
		patch.push(...appendPatch(data, 'datasets', n));
		shadow = { ...(isObj(data) ? data : {}), results: { ...results(data), datasets: [...section(data, 'datasets'), n] } };
	}
	const f = fieldsOf(ctx);
	const expr = componentExpr(f.phys, q.field, q.comp, q.components, q.axisym);
	const unit = q.unit ? { unit: q.unit } : {};
	const surf: O = { id: freshId(used, 'surf'), type: 'surface', expr, ...unit, ...(q.rule === 'robust' ? { range: { rule: 'p1-99' } } : {}), ...(q.colormap !== 'auto' ? { colormap: q.colormap } : {}), ...(q.log ? { log: true } : {}) };
	const items: O[] = [surf];
	if (q.contours) items.push({ id: freshId(used, 'cont'), type: 'contour', expr, ...unit, levels: { count: q.levels } });
	if (q.wire) items.push({ id: freshId(used, 'mesh'), type: 'mesh' });
	const id = freshId(used, 'pg2d');
	const g: O = { id, type: 'plot2d', data: dsId, ...(q.nSteps > 1 ? { steps: q.step } : {}), items };
	patch.push(...appendPatch(shadow, 'plots', g));
	return { patch, id, pointer: `/results/plots/${section(data, 'plots').length}` };
}

/** Drawn cut line (SI m ends): a cutline dataset and, optionally, a 1D group with a line graph of `expr`, one patch. */
export function cutLinePatch(ctx: PlotCtx, p0: readonly number[], p1: readonly number[], expr: string | null): { patch: JsonPatchOp[]; id: string; group: string | null; pointer: string } | null {
	const data = ctx.data, used = allIds(data), sol = firstSolution(data);
	if (!sol) return null;
	const u = coordUnit(ctx.mesh);
	const id = freshId(used, 'cln');
	const ds: O = { id, type: 'cutline', data: sol, from: vec(p0, u), to: vec(p1, u) };
	const patch = appendPatch(data, 'datasets', ds);
	let group: string | null = null;
	if (expr) {
		group = freshId(used, 'pg1d');
		const shadow = { ...(isObj(data) ? data : {}), results: { ...results(data), datasets: [...section(data, 'datasets'), ds] } };
		const unit = unitFor(data, expr);
		patch.push(...appendPatch(shadow, 'plots', { id: group, type: 'plot1d', items: [{ id: freshId(used, 'lg'), type: 'linegraph', data: id, x: 'arc', expr, ...(unit ? { unit } : {}) }] }));
	}
	return { patch, id, group, pointer: `/results/datasets/${section(data, 'datasets').length}` };
}

/** Clicked cut point (SI m): a cutpoint dataset, one patch. */
export function cutPointPatch(ctx: PlotCtx, p: readonly number[]): { patch: JsonPatchOp[]; id: string; pointer: string } | null {
	const data = ctx.data, used = allIds(data), sol = firstSolution(data);
	if (!sol) return null;
	const id = freshId(used, 'cpt');
	return { patch: appendPatch(data, 'datasets', { id, type: 'cutpoint', data: sol, points: [vec(p, coordUnit(ctx.mesh))] }), id, pointer: `/results/datasets/${section(data, 'datasets').length}` };
}

/** One end of a cut line moved (SI m): a single-path replace, so a drag coalesces into one op. */
export function cutLineEndPatch(ctx: PlotCtx, pointer: string, end: 'from' | 'to', p: readonly number[]): JsonPatchOp[] {
	const at = nodeAt(ctx.data, pointer);
	if (!at || at.node.type !== 'cutline') return [];
	const prev = at.node[end];
	// keep the unit the end is written in when it is a {value, unit} vector of a length unit
	const pu = isObj(prev) && typeof prev.unit === 'string' ? prev.unit : null;
	const f = pu === 'm' ? 1 : pu === 'mm' ? 1e3 : pu === 'cm' ? 1e2 : pu === 'um' ? 1e6 : null;
	const u = pu && f ? { unit: pu, f } : coordUnit(ctx.mesh);
	return [{ op: 'replace', path: `${pointer}/${end}`, value: vec(p, u) }];
}

// ------------------------------------------------------------------------------------------------ x-amp-ref pickers

export interface RefOption { id: string; label: string; ok: boolean; why?: string }

/**
 * Candidate ids for an `x-amp-ref` field at `pointer` (Settings pickers, DevLog-025 s.5 R2): studies, datasets,
 * evaluation groups, tables, evaluation items, each marked compatible or not with the reason (CONTRACTS C10 table).
 */
export function refOptions(data: unknown, pointer: string, kind: string): RefOption[] {
	const m = /^\/results\/(datasets|evaluations|tables|plots)\/(\d+)(?:\/items\/(\d+))?\/([A-Za-z]+)$/.exec(pointer);
	const sec = m?.[1], gi = Number(m?.[2]), ii = m?.[3] === undefined ? -1 : Number(m[3]), key = m?.[4] ?? '';
	const g = sec ? section(data, sec as ResultSection)[gi] : undefined;
	const it = g && ii >= 0 ? arr(g.items)[ii] : undefined;
	const self = it ?? g;
	if (kind === 'study') return (isObj(data) ? arr(data.studies) : []).map((x) => ({ id: str(x.id), label: `${str(x.id)} (${str(x.type)})`, ok: true }));
	if (kind === 'evaluation') return section(data, 'evaluations').map((x) => ({ id: str(x.id), label: str(x.id), ok: true }));
	if (kind === 'table') return section(data, 'tables').map((x) => ({ id: str(x.id), label: `${str(x.id)} (of ${str(x.from)})`, ok: true }));
	if (kind === 'item') {
		const t = section(data, 'tables').find((x) => x.id === self?.table);
		const ev = section(data, 'evaluations').find((x) => x.id === t?.from);
		return arr(ev?.items).map((x) => ({ id: str(x.id), label: `${str(x.id)} (${str(x.type)})`, ok: true }));
	}
	// datasets: compatibility by the reading node (C10)
	const need = ((): { test: (s: ReturnType<typeof datasetShape>, d: O) => boolean; what: string } => {
		const any = { test: () => true, what: 'any dataset' };
		if (sec === 'plots' && !it && key === 'data') {
			if (g?.type === 'plot2d') return { test: (s) => (s.kind === 'domain' && s.dim === 2) || s.kind === 'plane', what: 'a 2D dataset' };
			if (g?.type === 'plot3d') return { test: (s) => s.kind === 'domain' && s.dim === 3, what: 'a 3D dataset' };
			return any;
		}
		if (sec === 'plots' && it) {
			if (it.type === 'linegraph') return { test: (s) => s.kind === 'line', what: 'a line dataset (cut line, edge)' };
			if (it.type === 'pointgraph' || it.type === 'point') return { test: (s) => s.kind === 'points', what: 'a cut point dataset' };
			if (it.type === 'global') return any;
			if (g?.type === 'plot2d') return { test: (s) => (s.kind === 'domain' && s.dim === 2) || s.kind === 'plane', what: 'a 2D dataset' };
			if (g?.type === 'plot3d') return { test: (s) => s.kind === 'domain' && s.dim === 3, what: 'a 3D dataset' };
		}
		if (sec === 'evaluations' && it?.type === 'point') return { test: (s) => s.kind === 'points', what: 'a cut point dataset' };
		if (sec === 'datasets' && g) {
			if (g.type === 'edge') return { test: (_s, d) => d.type === 'solution' || d.type === 'join', what: 'a solution (or a join of solutions)' };
			if (g.type === 'cutplane') return { test: (s) => s.kind === 'domain' && s.dim === 3, what: 'a 3D dataset' };
			if (g.type === 'revolve') return { test: (s, d) => s.kind === 'domain' && s.dim === 2 && (d.type !== 'solution' || axisym(data)), what: 'an axisymmetric dataset' };
			if (g.type === 'cutpoint' || g.type === 'cutline' || g.type === 'mirror') return { test: (s) => s.kind === 'domain' || s.kind === 'plane', what: 'a domain dataset or a cut plane' };
		}
		return any;
	})();
	return section(data, 'datasets').filter((d) => d !== self).map((d) => {
		const s = datasetShape(data, str(d.id)), ok = need.test(s, d);
		return { id: str(d.id), label: `${str(d.id)} (${str(d.type)})`, ok, ...(ok ? {} : { why: `needs ${need.what}` }) };
	});
}
