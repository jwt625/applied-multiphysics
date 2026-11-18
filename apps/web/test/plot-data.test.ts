// SPDX-License-Identifier: GPL-3.0-or-later
// Plot-group data (results/plot-data.ts): the pure helpers, and the arrangement of 1D series and 2D overlays from the
// values a ResultsClient returns. The client is a stub with hand-written values, so every expected x, y, NaN break,
// label and marker below is worked out by hand from those values (lane T1, DevLog-038).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlotGroup } from '@amp/spec';
import type { Mesh } from '@amp/spec/types';
import type { DatasetValues, NodalValues, ResultsClient, ResultsRun, ResultTable } from '../src/lib/results/api.ts';
import { enabledItems, plotGroup, groupsReading, lengthDisplay, fieldRef, plot1dData, overlay2d } from '../src/lib/results/plot-data.ts';

const SPEC = {
	results: {
		plots: [
			{ id: 'p1', type: 'plot1d', data: 'cl1', items: [] },
			{ id: 'p2', type: 'plot2d', items: [{ id: 'pt', type: 'point', data: 'cl1' }] },
			{ id: 'p3', type: 'plot2d', data: 'sol', items: [] }
		]
	}
};

test('enabledItems, plotGroup, groupsReading', () => {
	const g = { id: 'g', type: 'plot1d', items: [{ id: 'a' }, { id: 'b', enabled: false }, 5, null, { id: 'c', enabled: true }] } as unknown as PlotGroup;
	assert.deepEqual(enabledItems(g).map((i) => i.id), ['a', 'c']);
	assert.deepEqual(enabledItems(null), []);
	assert.deepEqual(enabledItems({ id: 'x', type: 'plot1d' } as unknown as PlotGroup), []);
	assert.equal(plotGroup(SPEC, 'p3')?.data, 'sol');
	assert.equal(plotGroup(SPEC, 'nope'), null);
	assert.equal(plotGroup(SPEC, null), null);
	assert.equal(plotGroup({}, 'p1'), null);
	assert.deepEqual(groupsReading(SPEC, 'cl1'), ['p1', 'p2']);
	assert.deepEqual(groupsReading(SPEC, 'none'), []);
});

const meshOf = (nodes: number[], dim = 2, extra: Record<string, unknown> = {}) => ({ dim, nodes: Float64Array.from(nodes), ...extra }) as unknown as Mesh;

test('lengthDisplay: unit from the largest bounding-box extent (<1e-4 um, <0.2 mm, <2 cm, else m)', () => {
	assert.deepEqual(lengthDisplay(null), { unit: 'm', f: 1 });
	assert.deepEqual(lengthDisplay(meshOf([0, 0, 5e-5, 1e-6])), { unit: 'um', f: 1e6 });
	assert.deepEqual(lengthDisplay(meshOf([0, 0, 1e-4, 0])), { unit: 'mm', f: 1e3 });
	assert.deepEqual(lengthDisplay(meshOf([0, 0, 0.05, 0.19])), { unit: 'mm', f: 1e3 });
	assert.deepEqual(lengthDisplay(meshOf([0, 0, 0, 0.2])), { unit: 'cm', f: 1e2 });
	assert.deepEqual(lengthDisplay(meshOf([-1, 0, 0.99, 0])), { unit: 'cm', f: 1e2 });
	assert.deepEqual(lengthDisplay(meshOf([-1, 0, 1, 0])), { unit: 'm', f: 1 });
	// 3D: the z extent counts
	assert.deepEqual(lengthDisplay(meshOf([0, 0, 0, 0, 0, 3], 3)), { unit: 'm', f: 1 });
});

test('fieldRef: <physics>.<field>[.<comp>] with component names per geometry and physics tags', () => {
	const fields = [{ name: 'T', components: 1 }, { name: 'u', components: 2 }, { name: 'E', components: 3, physics: 'es' }];
	const ph = ['ht', 'es', 'solid'];
	assert.deepEqual(fieldRef('ht.T', fields, ph, false), { name: 'T', comp: -1 });
	assert.deepEqual(fieldRef('  ht.T ', fields, ph, false), { name: 'T', comp: -1 });
	assert.deepEqual(fieldRef('solid.u.x', fields, ph, false), { name: 'u', comp: 0 });
	assert.deepEqual(fieldRef('solid.u.y', fields, ph, false), { name: 'u', comp: 1 });
	assert.equal(fieldRef('solid.u', fields, ph, false), null, 'a vector needs a component');
	assert.equal(fieldRef('solid.u.z', fields, ph, false), null, 'no z component in a 2-vector');
	assert.deepEqual(fieldRef('solid.u.r', fields, ph, true), { name: 'u', comp: 0 });
	assert.deepEqual(fieldRef('solid.u.z', fields, ph, true), { name: 'u', comp: 1 });
	assert.equal(fieldRef('ht.E.x', fields, ph, false), null, 'E is tagged with physics es');
	assert.deepEqual(fieldRef('es.E.z', fields, ph, false), { name: 'E', comp: 2, physics: 'es' });
	assert.deepEqual(fieldRef('es.E.phi', fields, ph, true), { name: 'E', comp: 1, physics: 'es' });
	assert.equal(fieldRef('foo.T', fields, ph, false), null);
	assert.equal(fieldRef('ht.T + 1', fields, ph, false), null);
	assert.equal(fieldRef(undefined, fields, ph, false), null);
});

// ---- stub client
type DV = Partial<DatasetValues>;
const dv = (o: DV): DatasetValues => ({ id: 'd', type: 'cutline', dim: 2, points: new Float64Array(0), values: null, unit: 'K', siUnit: 'K', continuous: true, outside: [], step: 0, stepValue: null, stepUnit: null, ...o });
function stub(h: { datasetValues?: (ds: string, expr: string | null, o: { step?: unknown; unit?: string }) => DatasetValues; evaluate?: (req: Record<string, unknown>) => ResultTable; nodalValues?: (expr: string) => NodalValues }) {
	const calls: unknown[] = [];
	const rc = {
		datasetValues: async (_s: unknown, ds: string, expr: string | null, _r: unknown, o: { step?: unknown; unit?: string } = {}) => { calls.push(['dv', ds, expr, o]); return h.datasetValues!(ds, expr, o); },
		evaluate: async (_s: unknown, req: Record<string, unknown>) => { calls.push(['ev', req]); return h.evaluate!(req); },
		table: async () => { throw new Error('not used'); },
		nodalValues: async (_s: unknown, expr: string) => { calls.push(['nv', expr]); return h.nodalValues!(expr); }
	} as unknown as ResultsClient;
	return { rc, calls };
}
const run = (o: { steps?: unknown; mesh?: Mesh } = {}): ResultsRun => ({ key: 'k', solution: { steps: o.steps } as never, mesh: o.mesh ?? meshOf([0, 0, 0.01, 0.01]), params: new Map(), studies: [], label: '' });
const arr = (a: ArrayLike<number>) => Array.from(a);
const eqNaN = (a: ArrayLike<number>, b: number[]) => { assert.equal(a.length, b.length); b.forEach((v, i) => (Number.isNaN(v) ? assert.ok(Number.isNaN(a[i]!), `[${i}] NaN`) : assert.ok(Math.abs(a[i]! - v) < 1e-12, `[${i}] ${a[i]} vs ${v}`))); };

test('plot1dData: line graphs; crossing pieces and edge chains split by NaN; x in the requested length unit; overlay dashed', async () => {
	const { rc, calls } = stub({
		datasetValues: (ds) => ds === 'cross'
			// crossing mode: 2 element pieces (pieces = 2 numbers per piece), 3 points each -> break before index 3
			? dv({ values: Float64Array.from([1, 2, 3, 4, 5, 6]), s: Float64Array.from([0, 1e-3, 2e-3, 2e-3, 3e-3, 4e-3]), pieces: Float64Array.from([0, 2e-3, 2e-3, 4e-3]), length: 4e-3, covered: 2e-3, continuous: false })
			// edge with 2 chains [0, 2) and [2, 4) -> break before index 2
			: dv({ type: 'edge', values: Float64Array.from([10, 20, 30, 40]), s: Float64Array.from([0, 1, 2, 3]), chains: [[0, 2], [2, 4]] })
	});
	const g = { id: 'g', type: 'plot1d', data: 'cross', items: [
		{ id: 'a', type: 'linegraph', expr: 'ht.T', xunit: 'mm' },
		{ id: 'b', type: 'linegraph', expr: 'ht.T', data: 'edge', xunit: 'm', label: 'edge T' }
	] } as unknown as PlotGroup;
	const out = await plot1dData(rc, {}, g, run());
	assert.deepEqual(out.errors, []);
	assert.equal(out.series.length, 2);
	const [a, b] = out.series;
	eqNaN(a!.x, [0, 1, 2, NaN, 2, 3, 4]);
	eqNaN(a!.y, [1, 2, 3, NaN, 4, 5, 6]);
	assert.equal(a!.name, 'ht.T');
	assert.equal(a!.dash, undefined);
	eqNaN(b!.x, [0, 1, NaN, 2, 3]);
	eqNaN(b!.y, [10, 20, NaN, 30, 40]);
	assert.equal(b!.dash, true, 'the second line series is dashed');
	assert.equal(out.xLabel, 'arc length (mm) | arc length (m)');
	assert.equal(out.yLabel, '(K)', 'two names, one unit');
	assert.deepEqual(out.notes, ['cross: 50.0 % of the line inside the mesh']);
	assert.deepEqual(out.datasets, ['cross', 'edge']);
	assert.deepEqual(calls.map((c) => (c as unknown[])[1]), ['cross', 'edge']);
});

test('plot1dData: x expression, single-name y label, errors carry reasons, non-1D items are refused', async () => {
	const { rc } = stub({
		datasetValues: (ds, expr) => (ds === 'bad' ? dv({ error: 'dataset bad: no such cut line' }) : expr === 'x' ? dv({ values: Float64Array.from([5, 6]), unit: 'mm' }) : dv({ values: Float64Array.from([7, 8]), unit: 'MPa' }))
	});
	const g = { id: 'g', type: 'plot1d', data: 'cl', items: [
		{ id: 'a', type: 'linegraph', expr: 'solid.sxx', x: 'x', xunit: 'mm', unit: 'MPa' },
		{ id: 'e', type: 'linegraph', expr: 'solid.sxx', data: 'bad' },
		{ id: 's', type: 'surface', expr: 'solid.sxx' },
		{ id: 'off', type: 'linegraph', expr: 'solid.sxx', enabled: false }
	] } as unknown as PlotGroup;
	const out = await plot1dData(rc, {}, g, run());
	assert.equal(out.series.length, 1);
	eqNaN(out.series[0]!.x, [5, 6]);
	eqNaN(out.series[0]!.y, [7, 8]);
	assert.equal(out.xLabel, 'x (mm)');
	assert.equal(out.yLabel, 'solid.sxx (MPa)');
	assert.deepEqual(out.errors, [{ id: 'e', message: 'dataset bad: no such cut line' }, { id: 's', message: 'surface: not a 1D item' }]);
});

test('plot1dData: point graph = one series per point over the solution steps', async () => {
	const { rc } = stub({ datasetValues: (_ds, _e, o) => { const k = o.step as number; return dv({ type: 'cutpoint', values: Float64Array.from([10 * k, 20 * k]), stepValue: [1, 2, 3][k]!, unit: 'K' }); } });
	const g = { id: 'g', type: 'plot1d', items: [{ id: 'p', type: 'pointgraph', expr: 'ht.T', data: 'pts' }] } as unknown as PlotGroup;
	const out = await plot1dData(rc, {}, g, run({ steps: { kind: 'parametric', values: [1, 2, 3], unit: 'mm' } }));
	assert.deepEqual(out.series.map((s) => s.name), ['ht.T #1', 'ht.T #2']);
	assert.deepEqual(arr(out.series[0]!.x), [1, 2, 3]);
	assert.deepEqual(arr(out.series[0]!.y), [0, 10, 20]);
	assert.deepEqual(arr(out.series[1]!.y), [0, 20, 40]);
	assert.ok(out.series.every((s) => s.markers && !s.dash));
	assert.equal(out.xLabel, 'parametric (mm)');
});

const table = (cells: Array<number | null>, meta: Array<Record<string, unknown> | null>, unit = 'K'): ResultTable => ({
	id: 't', group: 'g', label: '', orient: 'rows', errors: [], hash: '', runs: [], ms: 0, cached: false,
	columns: [{ key: 'v', name: 'v', unit, kind: 'item', tip: '' }],
	rows: [{ cells, meta: meta as never, errors: [null], run: 'k', step: 0 }]
});

test('overlay2d: max / min markers at the reported location; eigen shows no number; point markers with N/A outside', async () => {
	const vals: Record<string, number> = { max: 350, min: 0.0001234 };
	const { rc, calls } = stub({
		evaluate: (req) => table([vals[req.kind as string]!], [{ at: req.kind === 'max' ? [0.01, 0.02] : [0, 0.005], method: 'nodal', n: 10 }]),
		datasetValues: () => dv({ type: 'cutpoint', points: Float64Array.from([0.001, 0.002, 0.5, 0.5]), values: Float64Array.from([1.5, NaN]) })
	});
	const mesh = meshOf([0, 0, 0.02, 0.02], 2, { entities: { domains: [{ id: 'dom:a' }, { id: 'dom:b' }], boundaries: [] } });
	const g = { id: 'g', type: 'plot2d', data: 'sol', items: [{ id: 'mm', type: 'maxmin', expr: 'ht.T' }, { id: 'pt', type: 'point', data: 'pts', expr: 'ht.T' }] } as unknown as PlotGroup;
	const lu = { unit: 'mm', f: 1e3 };
	const out = await overlay2d(rc, {}, g, run({ mesh }), () => '#fff', lu);
	assert.deepEqual(out.errors, []);
	assert.deepEqual(out.markers.map((m) => [m.x, m.y, m.label, m.kind]), [[0.01, 0.02, 'max 350 K', undefined], [0, 0.005, 'min 1.23e-4 K', undefined], [0.001, 0.002, '1.5 K', 'probe'], [0.5, 0.5, 'N/A', 'probe']]);
	// max / min reduce over every domain of the mesh
	assert.deepEqual((calls[0] as [string, { over: string[] }])[1].over, ['dom:a', 'dom:b']);
	const eig = await overlay2d(rc, {}, { ...g, items: [{ id: 'mm', type: 'maxmin', expr: 'p', show: 'max' }] } as unknown as PlotGroup, run({ mesh }), () => '#fff', lu, { eigen: true });
	assert.deepEqual(eig.markers.map((m) => m.label), ['max p']);
	assert.match(eig.markers[0]!.tip, /amplitude is arbitrary/);
});

test('overlay2d: boundary line colours binned by the mean of the segment end values; selection by boundary id', async () => {
	// nodes 0 (0,0), 1 (1,0), 2 (2,0); facets 0-1 on boundary 0, 1-2 on boundary 1; nodal values 0, 1, 3
	const mesh = meshOf([0, 0, 1, 0, 2, 0], 2, { facets: { type: 'line2', conn: Int32Array.from([0, 1, 1, 2]), boundary: Int32Array.from([0, 1]) }, entities: { domains: [], boundaries: [{ id: 'bnd:a' }, { id: 'bnd:b' }] } });
	const { rc } = stub({ nodalValues: () => ({ values: Float64Array.from([0, 1, 3]), space: 'H1P1', unit: 'K', siUnit: 'K', continuous: true, step: 0, meshHash: '' }) });
	const cmap = (t: number) => t.toFixed(5);
	const all = await overlay2d(rc, {}, { id: 'g', type: 'plot2d', items: [{ id: 'l', type: 'line', expr: 'ht.T' }] } as unknown as PlotGroup, run({ mesh }), cmap, { unit: 'm', f: 1 });
	// segment means 0.5 and 2 -> range [0.5, 2]; t = 0 -> bin 0, t = 1 -> bin 31 (last)
	assert.deepEqual(all.lineRange, { min: 0.5, max: 2, unit: 'K', expr: 'ht.T' });
	assert.deepEqual(all.lines.map((l) => [arr(l.segs), l.color]), [[[0, 0, 1, 0], (0.5 / 32).toFixed(5)], [[1, 0, 2, 0], (31.5 / 32).toFixed(5)]]);
	const sel = await overlay2d(rc, {}, { id: 'g', type: 'plot2d', items: [{ id: 'l', type: 'line', expr: 'ht.T', select: ['bnd:b'] }] } as unknown as PlotGroup, run({ mesh }), cmap, { unit: 'm', f: 1 });
	// one segment, lo = hi -> t = 0.5 -> bin 16
	assert.deepEqual(sel.lineRange, { min: 2, max: 2, unit: 'K', expr: 'ht.T' });
	assert.deepEqual(sel.lines.map((l) => [arr(l.segs), l.color]), [[[1, 0, 2, 0], (16.5 / 32).toFixed(5)]]);
});
