// SPDX-License-Identifier: GPL-3.0-or-later
// Sweep editor round trip (state/sweep.ts) through a real op log, sweep-vs-parameter series, eigenmode table data
// (state/modes.ts), headline items of the solved study and the plot group after a study switch
// (state/study-results.ts), and the unitless param write (state/params.ts). Expected values written by hand from
// the sims files (lane E5, DevLog-051).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOpLog, parseSpecText } from '@amp/spec';
import { physicsRegistry } from '@amp/physics';
import { newSweepDef, parseValueList, removeSweepPatch, setSweepPatch, splitQuantity, sweepCount, sweepDefOf, sweepScalars, sweepSeries, type SweepDef, type SweepLike } from '../src/lib/state/sweep.ts';
import { modeTable } from '../src/lib/state/modes.ts';
import { datasetStudy, headlineSplit, plotGroupForStudy } from '../src/lib/state/study-results.ts';
import { paramValue, paramViews } from '../src/lib/state/params.ts';

const sim = (id: string) => readFileSync(new URL(`../../../sims/${id}.yaml`, import.meta.url), 'utf8');
const reg = physicsRegistry();
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => { assert.ok(r.ok, JSON.stringify(r)); return r as Extract<T, { ok: true }>; };

test('sweep: the existing parametric study reads back as the editor model', async () => {
	const log = await createOpLog(sim('si-rib-waveguide'));
	const d = sweepDefOf(log.data, 'sweep_t')!;
	assert.deepEqual(d, { id: 'sweep_t', study: 'modes', axes: [{ param: 't_slab', mode: 'values', values: ['0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7'], start: '', stop: '', n: 2, unit: 'um' }] });
	assert.equal(sweepCount(d), 7);
	assert.equal(sweepDefOf(log.data, 'modes'), null);
	// unchanged model -> empty patch
	assert.deepEqual(ok(setSweepPatch(log.data, d)).patch, []);
});

test('sweep: create a range sweep, edit it to a list, round trip through the op log and the parser; remove', async () => {
	const text = sim('kirsch-plate');
	const log = await createOpLog(text, { registry: reg });
	const views = paramViews((log.data as { params: never }).params, undefined);
	const def = newSweepDef(log.data, views);
	assert.deepEqual(def, { id: 'sweep1', study: 'std1', axes: [{ param: 'D', mode: 'values', values: ['10'], start: '', stop: '', n: 5, unit: 'mm' }] });
	const r: SweepDef = { ...def, axes: [{ ...def.axes[0]!, mode: 'range', values: [], start: '2', stop: '10', n: 5 }] };
	const c = ok(setSweepPatch(log.data, r));
	assert.deepEqual(c.patch, [{ op: 'add', path: '/studies/1', value: { id: 'sweep1', type: 'parametric', physics: ['solid'], settings: { study: 'std1', sweep: [{ param: 'D', range: { start: '2 mm', stop: '10 mm', n: 5 } }] } } }]);
	await log.apply(c.patch, { actor: 'user', reason: 'sweep' });
	assert.ok(parseSpecText(log.text, reg).ok);
	assert.ok(log.text.includes('# Plate with a hole'));
	assert.deepEqual(sweepDefOf(log.data, 'sweep1'), r);
	// edit: a value list (text as typed), one op touching only the sweep
	const vals = { ...r, axes: [{ ...r.axes[0]!, mode: 'values' as const, values: parseValueList('2, 4.5, 8'), start: '', stop: '', n: 2 }] };
	const e = ok(setSweepPatch(log.data, vals));
	assert.deepEqual(e.patch, [{ op: 'replace', path: '/studies/1/settings/sweep', value: [{ param: 'D', values: ['2 mm', '4.5 mm', '8 mm'] }] }]);
	await log.apply(e.patch, { actor: 'user', reason: 'edit' });
	assert.deepEqual(sweepDefOf(parseSpecText(log.text, reg).data, 'sweep1'), vals);
	// remove
	const rm = ok(removeSweepPatch(log.data, 'sweep1'));
	await log.apply(rm.patch, { actor: 'user', reason: 'rm' });
	assert.equal(log.text, text);
});

test('sweep: refusals and value parsing', async () => {
	const log = await createOpLog(sim('kirsch-plate'));
	const base: SweepDef = { id: 'sw', study: 'std1', axes: [{ param: 'D', mode: 'values', values: ['1'], start: '', stop: '', n: 2, unit: 'mm' }] };
	const no = (d: SweepDef, re: RegExp) => { const r = setSweepPatch(log.data, d); assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, re); };
	no({ ...base, id: 'std1' }, /not a parametric study/);
	no({ ...base, id: 'kt' }, /already used/);
	no({ ...base, study: 'nope' }, /no study 'nope'/);
	no({ ...base, axes: [] }, /at least one/);
	no({ ...base, axes: [{ ...base.axes[0]!, param: 'Q' }] }, /choose a parameter/);
	no({ ...base, axes: [base.axes[0]!, base.axes[0]!] }, /swept twice/);
	no({ ...base, axes: [{ ...base.axes[0]!, values: [' '] }] }, /at least one value/);
	no({ ...base, axes: [{ ...base.axes[0]!, mode: 'range', start: '1', stop: '2', n: 1 }] }, /n must be/);
	assert.deepEqual(parseValueList('1 2 3'), ['1', '2', '3']);
	assert.deepEqual(parseValueList('1 mm; 2 mm'), ['1 mm', '2 mm']);
	assert.deepEqual(parseValueList('D/2'), ['D/2']);
	assert.deepEqual(splitQuantity('0.1 um'), ['0.1', 'um']);
	assert.deepEqual(splitQuantity({ value: 3, unit: 'GHz' }), ['3', 'GHz']);
	assert.deepEqual(splitQuantity(4), ['4', '']);
	assert.deepEqual(splitQuantity('W/4'), ['W/4', '']);
	// unitless values are written as numbers
	const u: SweepDef = { ...base, axes: [{ ...base.axes[0]!, unit: '', values: ['1', '2'] }] };
	assert.deepEqual((ok(setSweepPatch(log.data, u)).patch[0] as { value: { settings: { sweep: unknown } } }).value.settings.sweep, [{ param: 'D', values: [1, 2] }]);
	assert.equal(removeSweepPatch(log.data, 'std1').ok, false);
	const sr = await createOpLog(sim('si-rib-waveguide'));
	assert.match((removeSweepPatch(sr.data, 'sweep_t') as { reason: string }).reason, /sol_sweep_t/);
});

test('sweep series: scalar vs the first axis in its unit; other axes as series; unsolved points are gaps', () => {
	const pt = (index: number, a: number, b: number, status: string, v?: number) => ({ index, values: { a, b }, status, scalars: v === undefined ? null : { neff_0: { value: v, unit: '1' }, P: { value: 2 * v, unit: 'W' } } });
	const sw: SweepLike = {
		studyId: 'sw', axes: [{ param: 'a', unit: 'um', values: [1, 2, 3] }, { param: 'b', unit: '1', values: [0, 1] }],
		points: [pt(0, 1, 0, 'solved', 1.5), pt(1, 1, 1, 'solved', 1.6), pt(2, 2, 0, 'error'), pt(3, 2, 1, 'solved', 1.7), pt(4, 3, 0, 'solved', 1.8), pt(5, 3, 1, 'pending')]
	};
	assert.deepEqual(sweepScalars(sw), [{ name: 'neff_0', unit: '1' }, { name: 'P', unit: 'W' }]);
	const s = sweepSeries(sw, 'P');
	assert.equal(s.xLabel, 'a (um)');
	assert.equal(s.yUnit, 'W');
	assert.equal(s.solved, 4);
	assert.deepEqual(s.series.map((x) => x.name), ['b = 0', 'b = 1']);
	assert.deepEqual(s.series[0]!.x, [1, 2, 3]);
	assert.deepEqual(s.series[0]!.y.map((v) => (Number.isNaN(v) ? 'gap' : v)), [3, 'gap', 3.6]);
	assert.deepEqual(s.series[1]!.y.map((v) => (Number.isNaN(v) ? 'gap' : v)), [3.2, 3.4, 'gap']);
	const one = sweepSeries({ ...sw, axes: [sw.axes[0]!], points: sw.points.filter((p) => p.values.b === 0) }, 'neff_0');
	assert.deepEqual(one.series.map((x) => x.name), ['neff_0']);
	assert.deepEqual(sweepScalars(null), []);
});

test('mode table: step value per mode, per-mode scalars as columns, pair scalars and repeats of the step left out', () => {
	const sc = (v: number, unit: string) => ({ value: v, unit });
	const em = modeTable({ steps: { kind: 'eigen', values: Float64Array.from([4.9e9, 5.0e9]), unit: 'Hz' }, scalars: { f_0: sc(4.9e9, 'Hz'), f_1: sc(5.0e9, 'Hz'), Q_0: sc(1200, '1'), Q_1: sc(900, '1'), ezFraction_1: sc(0.9, '1'), g0_0_1: sc(3, 'Hz'), Q_7: sc(1, '1'), total: sc(1, 'W') } })!;
	assert.equal(em.stepName, 'f');
	assert.equal(em.stepUnit, 'Hz');
	assert.deepEqual(em.columns.map((c) => [c.name, c.unit]), [['Q', ''], ['ezFraction', '']]);
	assert.deepEqual(em.rows.map((r) => [r.k, r.value, ...r.cells]), [[0, 4.9e9, 1200, null], [1, 5.0e9, 900, 0.9]]);
	const md = modeTable({ steps: { kind: 'eigen', values: Float64Array.from([2.5, 2.1]), unit: '1' }, scalars: { neff: sc(2.5, '1'), neff_0: sc(2.5, '1'), neff_1: sc(2.1, '1'), ng_0: sc(4.1, '1'), ng_1: sc(4.3, '1'), lossDbPerM_0: sc(12, 'dB/m') } })!;
	assert.equal(md.stepName, 'n_eff');
	assert.deepEqual(md.columns.map((c) => [c.name, c.unit]), [['ng', ''], ['lossDbPerM', 'dB/m']]);
	assert.deepEqual(md.rows[1]!.cells, [4.3, null]);
	assert.equal(modeTable({ steps: { kind: 'time', values: Float64Array.from([0, 1]), unit: 's' }, scalars: {} }), null);
	assert.equal(modeTable(null), null);
	assert.equal(modeTable({ scalars: {} }), null);
});

test('headlines of the solved study; plot group after a study switch (pzt4-cube)', async () => {
	const log = await createOpLog(sim('pzt4-cube'));
	const d = log.data as { studies: Array<{ id: string }>; results: { plots?: Array<{ id: string; data?: string }>; datasets: Array<{ id: string; data?: string }> } };
	const ids = d.studies.map((s) => s.id);
	assert.ok(ids.length >= 2, 'pzt4-cube has several studies');
	const all = headlineSplit(d, null);
	const other = headlineSplit(d, ids[1]);
	// every item is either shown or named with the study it needs, for each choice
	const n = all.show.size + all.other.length;
	assert.equal(other.show.size + other.other.length, n);
	for (const o of [...all.other, ...other.other]) assert.ok(ids.includes(o.study));
	for (const g of d.results.plots ?? []) { const st = datasetStudy(d, g.data); if (st) assert.ok(ids.includes(st)); }
	// a group of the solved study is chosen; a fitting current group is kept
	for (const sid of ids) {
		const g = plotGroupForStudy(d, sid, null);
		if (g) { const st = datasetStudy(d, (d.results.plots ?? []).find((x) => x.id === g)!.data); assert.ok(st === sid || (d.studies.find((x) => x.id === sid) as { settings?: { study?: string } }).settings?.study === st, `${sid} -> ${g} (${st})`); }
		if (g) assert.equal(plotGroupForStudy(d, sid, g), g);
	}
});

test('headline split and plot choice on hand-written data', () => {
	const d = {
		studies: [{ id: 'a', type: 'stationary', physics: ['p'] }, { id: 'b', type: 'stationary', physics: ['p'] }],
		results: {
			datasets: [{ id: 'sa', type: 'solution', data: 'a' }, { id: 'sb', type: 'solution', data: 'b' }, { id: 'cl', type: 'cutline', data: 'sb' }],
			evaluations: [{ id: 'ea', data: 'sa', items: [{ id: 'ia', type: 'max', expr: 'p.T' }] }, { id: 'eb', data: 'cl', items: [{ id: 'ib', type: 'max', expr: 'p.T' }] }],
			plots: [{ id: 'ga', type: 'plot2d', data: 'sa', items: [] }, { id: 'gb', type: 'plot2d', data: 'sb', items: [] }]
		}
	};
	assert.deepEqual([...headlineSplit(d, null).show], ['ia']);
	assert.deepEqual(headlineSplit(d, null).other, [{ id: 'ib', study: 'b' }]);
	assert.deepEqual([...headlineSplit(d, 'b').show], ['ib']);
	assert.equal(datasetStudy(d, 'cl'), 'b');
	assert.equal(plotGroupForStudy(d, 'b', 'ga'), 'gb');
	assert.equal(plotGroupForStudy(d, 'a', 'ga'), 'ga');
	assert.equal(plotGroupForStudy(d, 'a', null), 'ga');
});

test('paramValue: a unitless string param is written as "7", not "7 1"', () => {
	const v = Object.fromEntries(paramViews({ k: '5', n: 4, d: '2 mm' }, undefined).map((p) => [p.name, p]));
	assert.equal(paramValue(v.k!, 7), '7');
	assert.equal(paramValue(v.n!, 7), 7);
	assert.equal(paramValue(v.d!, 3), '3 mm');
});
