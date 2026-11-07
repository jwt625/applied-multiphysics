// SPDX-License-Identifier: GPL-3.0-or-later
// Data of plot groups (DevLog-027 s.1.2): 1D series (line graph, point graph, global, table graph) and the 2D overlay
// items (max / min markers, point markers, boundary line colours, arrows) of a group, from the spec and the displayed
// run. Every value comes from R3's ResultsClient (results/api.ts: the @amp/post kernels through results/adapter.ts in
// the post worker); this module only arranges them for drawing.
// Honesty rules (DevLog-023 s.3.1): values in absolute units (the item's unit, else SI); a value that cannot be
// computed carries its reason (shown, never drawn as a number); each max / min states its method; pieces of a cut line
// in crossing mode and separate chains of an edge are separate polylines (NaN between them), so the jumps of
// discontinuous expressions (d(), DG0) stay visible.
import { resultsOf, units, type PlotGroup, type PlotItem } from '@amp/spec';
import type { Mesh } from '@amp/spec/types';
import type { ResultsClient, ResultsRun } from './api';
import type { Series } from './LinePlot.svelte';

type O = Record<string, unknown>;
const isObj = (x: unknown): x is O => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown) => (typeof x === 'string' ? x : '');

export const enabledItems = (g: PlotGroup | null | undefined): PlotItem[] => (g && Array.isArray(g.items) ? g.items.filter((i) => isObj(i) && i.enabled !== false) : []);
export function plotGroup(data: unknown, id: string | null | undefined): PlotGroup | null {
	if (!id) return null;
	return resultsOf(data).plots.find((p) => p.id === id) ?? null;
}
/** Plot groups that read a dataset (directly or through an item). */
export function groupsReading(data: unknown, dataset: string): string[] {
	return resultsOf(data).plots.filter((p) => p.data === dataset || (Array.isArray(p.items) && p.items.some((i) => isObj(i) && i.data === dataset))).map((p) => p.id);
}

/** Length display unit (the model size decides: mm for a 50 mm model). */
export function lengthDisplay(mesh: Mesh | null | undefined): { unit: string; f: number } {
	if (!mesh) return { unit: 'm', f: 1 };
	const d = mesh.dim, N = mesh.nodes;
	let size = 0;
	for (let k = 0; k < d; k++) { let lo = Infinity, hi = -Infinity; for (let i = k; i < N.length; i += d) { const v = N[i]!; if (v < lo) lo = v; if (v > hi) hi = v; } size = Math.max(size, hi - lo); }
	return size < 1e-4 ? { unit: 'um', f: 1e6 } : size < 0.2 ? { unit: 'mm', f: 1e3 } : size < 2 ? { unit: 'cm', f: 1e2 } : { unit: 'm', f: 1 };
}
/** SI value -> unit (length units of the x axis). */
function lengthConv(unit: string | undefined, mesh: Mesh | null | undefined): { unit: string; f: number } {
	if (!unit) return lengthDisplay(mesh);
	try { const u = units.parseUnit(unit); return { unit, f: 1 / u.factor }; } catch { return lengthDisplay(mesh); }
}
const unitText = (u: string) => (u && u !== '1' ? u : '1');

export interface Plot1DData {
	series: Series[];
	xLabel: string;
	yLabel: string;
	/** reasons items are not drawn, per item id */
	errors: Array<{ id: string; message: string }>;
	/** facts shown in the status line (coverage of cut lines, step) */
	notes: string[];
	/** datasets drawn (for the 2D overlay of the split view) */
	datasets: string[];
	ms: number;
}

/** Insert NaN between pieces (crossing mode: 3 points per element piece) and chains (edges): separate polylines. */
function breaks(n: number, pieces: Float64Array | undefined, chains: Array<[number, number]> | undefined): number[] {
	const out: number[] = [];
	if (pieces && pieces.length / 2 * 3 === n) { for (let k = 3; k < n; k += 3) out.push(k); return out; }
	if (chains && chains.length > 1) for (const [a] of chains.slice(1)) out.push(a);
	return out;
}
function withBreaks(x: Float64Array, y: Float64Array, at: number[]): { x: Float64Array; y: Float64Array } {
	if (!at.length) return { x, y };
	const n = x.length + at.length, X = new Float64Array(n), Y = new Float64Array(n);
	let o = 0, b = 0;
	for (let i = 0; i < x.length; i++) {
		if (b < at.length && at[b] === i) { X[o] = NaN; Y[o] = NaN; o++; b++; }
		X[o] = x[i]!; Y[o] = y[i]!; o++;
	}
	return { x: X, y: Y };
}

/** Series of a 1D plot group on one run. */
export async function plot1dData(rc: ResultsClient, spec: unknown, g: PlotGroup, run: ResultsRun): Promise<Plot1DData> {
	const t0 = performance.now();
	const out: Plot1DData = { series: [], xLabel: '', yLabel: '', errors: [], notes: [], datasets: [], ms: 0 };
	const yUnits = new Set<string>(), xLabels = new Set<string>();
	const stepOf = (it: PlotItem): number | 'last' | 'first' | undefined => {
		const s = it.steps ?? g.steps;
		return typeof s === 'number' || s === 'last' || s === 'first' ? s : undefined;
	};
	for (const it of enabledItems(g)) {
		const name = it.label ?? `${it.expr ?? it.table ?? it.id}`;
		const fail = (message: string) => out.errors.push({ id: it.id, message });
		try {
			if (it.type === 'linegraph') {
				const ds = str(it.data ?? g.data);
				const step = stepOf(it);
				const y = await rc.datasetValues(spec, ds, str(it.expr), run, { ...(step !== undefined ? { step } : {}), ...(it.unit ? { unit: it.unit } : {}) });
				if (y.error || !y.values) { fail(y.error ?? 'no values'); continue; }
				let x: Float64Array, xl: string;
				if (!it.x || it.x === 'arc') {
					const L = lengthConv(typeof it.xunit === 'string' ? it.xunit : undefined, run.mesh);
					x = (y.s ?? new Float64Array(0)).map((v) => v * L.f);
					xl = `arc length (${L.unit})`;
				} else {
					const xv = await rc.datasetValues(spec, ds, str(it.x), run, { ...(step !== undefined ? { step } : {}), ...(typeof it.xunit === 'string' ? { unit: it.xunit } : {}) });
					if (xv.error || !xv.values) { fail(`x: ${xv.error ?? 'no values'}`); continue; }
					x = xv.values;
					xl = `${it.x} (${unitText(xv.unit)})`;
				}
				const br = withBreaks(x, y.values, breaks(y.values.length, y.pieces, y.chains));
				out.series.push({ name, x: br.x, y: br.y, tip: `${it.id}: ${it.expr} [${unitText(y.unit)}] on ${ds} (${y.type}${y.pieces ? ', element-crossing points: 3 per element piece, pieces drawn apart' : y.chains && y.chains.length > 1 ? `, ${y.chains.length} chains drawn apart` : ''}${y.continuous ? '' : '; discontinuous across elements'})${y.outside.length ? `; ${y.outside.length} points outside the mesh (not drawn)` : ''}` });
				yUnits.add(unitText(y.unit)); xLabels.add(xl);
				if (y.length !== undefined && y.covered !== undefined && y.covered < y.length * (1 - 1e-9)) out.notes.push(`${ds}: ${((100 * y.covered) / y.length).toFixed(1)} % of the line inside the mesh`);
				if (!out.datasets.includes(ds)) out.datasets.push(ds);
			} else if (it.type === 'pointgraph') {
				const ds = str(it.data ?? g.data);
				const st = run.solution.steps;
				const n = st ? st.values.length : 1;
				let pts: Float64Array[] | null = null, unit = '';
				const xs = new Float64Array(n);
				for (let k = 0; k < n; k++) {
					const v = await rc.datasetValues(spec, ds, str(it.expr), run, { step: k, ...(it.unit ? { unit: it.unit } : {}) });
					if (v.error || !v.values) { fail(v.error ?? 'no values'); pts = null; break; }
					pts ??= Array.from({ length: v.values.length }, () => new Float64Array(n));
					v.values.forEach((val, j) => { pts![j]![k] = val; });
					xs[k] = v.stepValue ?? k;
					unit = v.unit;
				}
				if (!pts) continue;
				pts.forEach((y, j) => out.series.push({ name: pts!.length > 1 ? `${name} #${j + 1}` : name, x: xs, y, markers: true, tip: `${it.id}: ${it.expr} [${unitText(unit)}] at point ${j + 1} of ${ds}` }));
				yUnits.add(unitText(unit)); xLabels.add(st ? `${st.kind} (${unitText(st.unit)})` : 'step');
			} else if (it.type === 'global' || it.type === 'tablegraph') {
				const t = it.type === 'global'
					? await rc.evaluate(spec, { data: str(it.data ?? g.data), kind: 'global', expr: str(it.expr), ...(it.unit ? { unit: it.unit } : {}) }, [run])
					: await rc.table(spec, str(it.table), [run]);
				if (t.errors.length) { fail(t.errors.join('; ')); continue; }
				const xi = t.columns.findIndex((c) => c.kind === 'step');
				const ii = t.columns.findIndex((c) => c.kind === 'index');
				const cols = t.columns.map((c, k) => ({ c, k })).filter(({ c }) => c.kind === 'item' && (it.type === 'global' || !Array.isArray(it.columns) || it.columns.includes(c.item ?? '')));
				const xcol = xi >= 0 ? xi : ii;
				const xs = Float64Array.from(t.rows.map((r, k) => (xcol >= 0 && typeof r.cells[xcol] === 'number' ? (r.cells[xcol] as number) : k + 1)));
				for (const { c, k } of cols) {
					const ys = Float64Array.from(t.rows.map((r) => (typeof r.cells[k] === 'number' ? (r.cells[k] as number) : NaN)));
					const errs = t.rows.map((r) => r.errors[k]).filter(Boolean);
					if (errs.length === t.rows.length) { fail(`${c.name}: ${errs[0]}`); continue; }
					out.series.push({ name: it.type === 'global' ? name : `${c.name}`, x: xs, y: ys, markers: true, tip: `${it.id}: ${c.tip}` });
					yUnits.add(unitText(c.unit));
				}
				xLabels.add(xcol >= 0 ? `${t.columns[xcol]!.name}${t.columns[xcol]!.unit ? ` (${t.columns[xcol]!.unit})` : ''}` : 'row');
			} else fail(`${it.type}: not a 1D item`);
		} catch (e) { fail(e instanceof Error ? e.message : String(e)); }
	}
	// a curve drawn over another (e.g. a closed form over the FE values) is dashed, so both stay visible where they agree
	out.series.forEach((s, k) => { if (k % 2 === 1 && !s.markers) s.dash = true; });
	out.xLabel = [...xLabels].join(' | ') || 'x';
	out.yLabel = yUnits.size === 1 ? `${[...new Set(out.series.map((s) => s.name))].length === 1 ? `${out.series[0]!.name} ` : ''}(${[...yUnits][0]})` : [...yUnits].map((u) => `(${u})`).join(' | ');
	out.ms = performance.now() - t0;
	return out;
}

// ---------------------------------------------------------------------------------------------------- 2D overlays

export interface Marker2D { x: number; y: number; label: string; tip: string; kind?: 'probe' }
export interface Overlay2D {
	markers: Marker2D[];
	/** boundary segments (x0 y0 x1 y1, m) binned by colour */
	lines: Array<{ segs: Float64Array; color: string }>;
	lineRange: { min: number; max: number; unit: string; expr: string } | null;
	/** arrows: x y vx vy per arrow (m; v already scaled to a world length) */
	arrows: Float64Array | null;
	/** mesh node of each arrow (a deformed view moves the arrow with its node) */
	arrowNodes: Int32Array | null;
	arrowNote: string;
	errors: Array<{ id: string; message: string }>;
}

/** Whole-mesh domain ids (max / min of a plot item reduce over the full dataset). */
const allDomains = (mesh: Mesh) => mesh.entities.domains.map((d) => d.id);

/** Max / min markers and point markers of a plot2d group (async; the post worker evaluates). */
export async function overlay2d(rc: ResultsClient, spec: unknown, g: PlotGroup, run: ResultsRun, cmap: (t: number) => string, lu: { unit: string; f: number }, o: { step?: number | 'last'; eigen?: boolean } = {}): Promise<Overlay2D> {
	// one step for every item (the step the colour field shows); eigenmodes have no absolute amplitude: no numbers
	const so = o.step !== undefined ? { step: o.step } : {};
	const out: Overlay2D = { markers: [], lines: [], lineRange: null, arrows: null, arrowNodes: null, arrowNote: '', errors: [] };
	const fmt = (v: number) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : String(Number(v.toPrecision(4))));
	for (const it of enabledItems(g)) {
		const fail = (message: string) => out.errors.push({ id: it.id, message });
		try {
			if (it.type === 'maxmin') {
				const show = str(it.show) || 'both';
				for (const kind of show === 'both' ? (['max', 'min'] as const) : ([show as 'max' | 'min'])) {
					const t = await rc.evaluate(spec, { data: str(it.data ?? g.data), kind, expr: str(it.expr), ...(it.unit ? { unit: it.unit } : {}), over: allDomains(run.mesh), method: (it.method as 'nodal') ?? 'nodal', ...(o.step !== undefined ? { steps: o.step } : {}) }, [run]);
					const k = t.columns.findIndex((c) => c.kind === 'item');
					const row = t.rows.at(-1);
					const v = row?.cells[k], m = row?.meta[k];
					if (t.errors.length || typeof v !== 'number' || !m?.at) { fail(t.errors[0] ?? row?.errors[k] ?? `${kind}: no value`); continue; }
					const u = t.columns[k]!.unit;
					out.markers.push({ x: m.at[0]!, y: m.at[1]!, label: o.eigen ? `${kind} ${it.expr}` : `${kind} ${fmt(v)}${u ? ` ${u}` : ''}`, tip: o.eigen ? `${it.id}: ${kind} of ${it.expr} at (${fmt(m.at[0]! * lu.f)}, ${fmt(m.at[1]! * lu.f)}) ${lu.unit}; method ${m.method ?? it.method}; eigenmode: the amplitude is arbitrary, no value shown` : `${it.id}: ${kind} of ${it.expr} = ${v} ${u} at (${fmt(m.at[0]! * lu.f)}, ${fmt(m.at[1]! * lu.f)}) ${lu.unit}; method ${m.method ?? it.method}${m.n ? `, ${m.n} points` : ''}` });
				}
			} else if (it.type === 'point') {
				const ds = str(it.data);
				const v = await rc.datasetValues(spec, ds, typeof it.expr === 'string' && !o.eigen ? it.expr : null, run, { ...so, ...(it.unit ? { unit: it.unit } : {}) });
				if (v.error) { fail(v.error); continue; }
				for (let i = 0; i < v.points.length / v.dim; i++) {
					const x = v.points[v.dim * i]!, y = v.points[v.dim * i + 1]!, val = v.values?.[i];
					out.markers.push({ x, y, kind: 'probe', label: val !== undefined ? (Number.isFinite(val) ? `${fmt(val)}${v.unit ? ` ${v.unit}` : ''}` : 'N/A') : `${ds}`, tip: `${it.id}: ${ds} point ${i + 1} at (${fmt(x * lu.f)}, ${fmt(y * lu.f)}) ${lu.unit}${val !== undefined ? `; ${it.expr} = ${Number.isFinite(val) ? `${val} ${v.unit}` : 'N/A (outside the mesh)'}` : ''}` });
				}
			} else if (it.type === 'line') {
				const nv = await rc.nodalValues(spec, str(it.expr), run, { ...so, ...(it.unit ? { unit: it.unit } : {}), ...(g.data ? { dataset: str(g.data) } : {}) });
				if (nv.error || !nv.values) { fail(nv.error ?? 'no values'); continue; }
				const m = run.mesh, f = m.facets, npf = f.type === 'line3' ? 3 : 2, N = m.nodes, V = nv.values;
				const sel = Array.isArray(it.select) && it.select.length ? new Set(it.select as string[]) : null;
				const bOk = m.entities.boundaries.map((b) => !sel || sel.has(b.id) || !!b.parent?.some((p) => sel.has(p)) || [...sel].some((s) => b.id.startsWith(`${s}#`)));
				let lo = Infinity, hi = -Infinity;
				const segs: Array<[number, number, number, number, number]> = [];
				for (let i = 0; i < f.conn.length / npf; i++) {
					if (!bOk[f.boundary[i]!]) continue;
					const ids = npf === 3 ? [f.conn[3 * i]!, f.conn[3 * i + 2]!, f.conn[3 * i + 1]!] : [f.conn[2 * i]!, f.conn[2 * i + 1]!];
					for (let k = 0; k + 1 < ids.length; k++) {
						const a = ids[k]!, b = ids[k + 1]!, v = 0.5 * (V[a]! + V[b]!);
						if (!Number.isFinite(v)) continue;
						lo = Math.min(lo, v); hi = Math.max(hi, v);
						segs.push([N[2 * a]!, N[2 * a + 1]!, N[2 * b]!, N[2 * b + 1]!, v]);
					}
				}
				const NB = 32, bins: number[][] = Array.from({ length: NB }, () => []);
				for (const [x0, y0, x1, y1, v] of segs) { const t = hi > lo ? (v - lo) / (hi - lo) : 0.5; bins[Math.min(NB - 1, Math.floor(t * NB))]!.push(x0, y0, x1, y1); }
				out.lines = bins.map((b, k) => ({ segs: Float64Array.from(b), color: cmap((k + 0.5) / NB) })).filter((b) => b.segs.length);
				out.lineRange = { min: lo, max: hi, unit: nv.unit, expr: str(it.expr) };
			} else if (it.type === 'arrow') {
				const m = run.mesh;
				const comps = m.axisym ? ['r', 'z'] : ['x', 'y'];
				const [vx, vy] = await Promise.all(comps.map((c) => rc.nodalValues(spec, `${str(it.expr)}.${c}`, run, { ...so, ...(g.data ? { dataset: str(g.data) } : {}) })));
				if (vx!.error || vy!.error || !vx!.values || !vy!.values) { fail(vx!.error ?? vy!.error ?? 'no values (arrow expressions name a vector field)'); continue; }
				// one arrow per cell of a 24 x 24 grid over the bounding box: the mesh node nearest the cell centre
				const N = m.nodes, n = N.length / 2, G = 24;
				let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
				for (let i = 0; i < n; i++) { x0 = Math.min(x0, N[2 * i]!); x1 = Math.max(x1, N[2 * i]!); y0 = Math.min(y0, N[2 * i + 1]!); y1 = Math.max(y1, N[2 * i + 1]!); }
				const h = Math.max(x1 - x0, y1 - y0) / G, nx = Math.max(1, Math.ceil((x1 - x0) / h)), ny = Math.max(1, Math.ceil((y1 - y0) / h));
				const best = new Int32Array(nx * ny).fill(-1), bd = new Float64Array(nx * ny).fill(Infinity);
				for (let i = 0; i < n; i++) {
					const gx = Math.min(nx - 1, Math.floor((N[2 * i]! - x0) / h)), gy = Math.min(ny - 1, Math.floor((N[2 * i + 1]! - y0) / h));
					const d = (N[2 * i]! - (x0 + (gx + 0.5) * h)) ** 2 + (N[2 * i + 1]! - (y0 + (gy + 0.5) * h)) ** 2;
					if (d < bd[gy * nx + gx]!) { bd[gy * nx + gx] = d; best[gy * nx + gx] = i; }
				}
				let vmax = 0;
				for (const i of best) if (i >= 0) vmax = Math.max(vmax, Math.hypot(vx!.values[i]!, vy!.values[i]!));
				const sc = vmax > 0 ? (0.8 * h) / vmax : 0, A: number[] = [], nodes: number[] = [];
				for (const i of best) if (i >= 0 && Number.isFinite(vx!.values[i]!) && Number.isFinite(vy!.values[i]!)) { A.push(N[2 * i]!, N[2 * i + 1]!, sc * vx!.values[i]!, sc * vy!.values[i]!); nodes.push(i); }
				out.arrows = Float64Array.from(A);
				out.arrowNodes = Int32Array.from(nodes);
				out.arrowNote = `${it.id}: arrows of ${it.expr} at the mesh node nearest each cell of a ${nx} x ${ny} grid; length proportional to |v|, longest = 0.8 cell (max |v| = ${fmt(vmax)} ${vx!.siUnit})`;
			}
		} catch (e) { fail(e instanceof Error ? e.message : String(e)); }
	}
	return out;
}

/** A field reference `<physics>.<field>[.<comp>]` of an expression: the field name and component index (-1: scalar). */
export function fieldRef(expr: string | undefined, fields: ReadonlyArray<{ name: string; components: number; physics?: string }>, physics: string[], axisym: boolean): { name: string; comp: number; physics?: string } | null {
	const m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\.(x|y|z|r|phi))?$/.exec((expr ?? '').trim());
	if (!m || !physics.includes(m[1]!)) return null;
	// merged multiphysics solutions (C11): a field tagged with another physics is not this one
	const f = fields.find((x) => x.name === m[2] && (x.physics === undefined || x.physics === m[1]));
	if (!f) return null;
	const ph = f.physics !== undefined ? { physics: f.physics } : {};
	if (!m[3]) return f.components === 1 ? { name: f.name, comp: -1, ...ph } : null;
	const names = axisym ? (f.components === 3 ? ['r', 'phi', 'z'] : ['r', 'z']) : ['x', 'y', 'z'];
	const c = names.indexOf(m[3]);
	return c >= 0 && c < f.components ? { name: f.name, comp: c, ...ph } : null;
}
