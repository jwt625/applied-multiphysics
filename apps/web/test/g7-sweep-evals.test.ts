// SPDX-License-Identifier: GPL-3.0-or-later
// Lane G7 (DevLog-064): spec evaluation items per sweep point. Two real solves of si-rib-waveguide (t_slab 0.1 and
// 0.4 um, the inner mode study of its parametric study sweep_t); the evaluation group ev_sweep_t (dataset of the
// parametric study) is evaluated per point as the session does at solve time, and the kept numbers equal the table
// cells; the sweep plot view gives one curve point per solved point, gaps for the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml, resolveParams, runId } from '@amp/spec';
import { prepareRun, registry } from '@amp/physics';
import type { Mesh, Solution } from '@amp/spec/types';
import { evalTable, type AdapterRun } from '../src/lib/results/adapter.ts';
import { runStudies, NOT_SELECTED, type ResultTable } from '../src/lib/results/api.ts';
import { evalGroups, evalsOfTable, evalKey, quantityView, sweepQuantities, evalGaps, type SweepEval } from '../src/lib/workbench/sweep-evals.ts';
import { sweepSeries } from '../src/lib/state/sweep.ts';

const text = readFileSync(new URL('../../../sims/si-rib-waveguide.yaml', import.meta.url), 'utf8');

async function solvePoint(tSlabUm: number): Promise<{ base: Record<string, unknown>; run: AdapterRun }> {
	const base = parseYaml(text).data as Record<string, unknown>;
	const spec = structuredClone(base) as Record<string, any>;
	spec.params.t_slab.value = tSlabUm;
	const ctx = await prepareRun({ spec, physicsId: 'ewg' });
	const sol = (await registry['em-modes']!.run(ctx)) as Solution;
	// the session's run of a sweep point: point params, studies of the parametric study (sweep_t and its inner study)
	return { base, run: { key: await runId(sol.run), solution: sol, mesh: ctx.mesh as Mesh, params: resolveParams(spec.params).scope, studies: runStudies(base, 'sweep_t'), label: `t_slab = ${tSlabUm} um` } };
}

test('sweep evaluation items: per-point values equal the evaluation table cells; curve over the swept param', async () => {
	const a = await solvePoint(0.1), b = await solvePoint(0.4);
	assert.deepEqual(runStudies(a.base, 'sweep_t'), ['sweep_t', 'modes']);
	const groups = evalGroups(a.base);
	assert.deepEqual(groups, [{ id: 'ev_sweep_t', label: 'ev_sweep_t' }]);
	const evals: Array<Record<string, SweepEval>> = [];
	const tables: ResultTable[] = [];
	for (const p of [a, b]) {
		const t = { ...evalTable(a.base, 'ev_sweep_t', [p.run]), hash: '', ms: 0, cached: false } as ResultTable;
		assert.deepEqual(t.errors, []);
		tables.push(t);
		evals.push(evalsOfTable(t, groups[0]!));
	}
	for (const [k, t] of tables.entries()) {
		const ci = t.columns.findIndex((c) => c.item === 'neff');
		assert.ok(ci >= 0);
		const rows = t.rows.filter((r) => r.errors[ci] !== NOT_SELECTED);
		const v = rows.at(-1)!.cells[ci];
		assert.equal(typeof v, 'number');
		const e = evals[k]![evalKey('ev_sweep_t', t.columns[ci]!.key)]!;
		assert.equal(e.value, v, 'kept value = table cell (bitwise)');
		assert.equal(e.group, 'ev_sweep_t');
		console.log(`point ${k}: neff ${v} (${t.rows.length} rows)`);
	}
	const key = evalKey('ev_sweep_t', 'neff');
	assert.notEqual(evals[0]![key]!.value, evals[1]![key]!.value, 'the two points differ');
	// a thicker slab raises the effective index of the guided mode
	assert.ok(evals[1]![key]!.value! > evals[0]![key]!.value!);
	// the sweep plot view: 3 points (the third failed), the evaluated item listed before module scalars, a gap
	const sw = {
		studyId: 'sweep_t',
		axes: [{ param: 't_slab', unit: 'um', values: [0.1, 0.4, 0.7] }],
		points: [
			{ index: 0, values: { t_slab: 0.1 }, status: 'solved', scalars: { neff_0: { value: 1, unit: '1' } }, evals: evals[0]! },
			{ index: 1, values: { t_slab: 0.4 }, status: 'solved', scalars: { neff_0: { value: 2, unit: '1' } }, evals: evals[1]! },
			{ index: 2, values: { t_slab: 0.7 }, status: 'error', scalars: null, evals: null },
		],
	};
	const qs = sweepQuantities(sw);
	assert.equal(qs[0]!.kind, 'eval');
	assert.equal(qs[0]!.key, key);
	assert.ok(qs.some((q) => q.kind === 'scalar' && q.key === 'neff_0'));
	const d = sweepSeries({ ...sw, points: quantityView(sw.points, qs[0]!) }, key);
	assert.equal(d.solved, 2);
	assert.deepEqual(d.series[0]!.x, [0.1, 0.4, 0.7]);
	assert.deepEqual(d.series[0]!.y.slice(0, 2), [evals[0]![key]!.value, evals[1]![key]!.value]);
	assert.ok(Number.isNaN(d.series[0]!.y[2]));
	assert.deepEqual(evalGaps(sw, key), []);
	const sw2 = { ...sw, points: [...sw.points, { index: 3, values: { t_slab: 0.5 }, status: 'solved', scalars: null, evals: null }] };
	// a solved point without evaluated items and without a queue state (DevLog-067: reason per state)
	assert.deepEqual(evalGaps(sw2, key), ['not evaluated (evaluated when the point is shown)']);
});

test('evalsOfTable: last selected row, error reasons kept, multi-point columns separate', () => {
	const col = (key: string, item: string) => ({ key, name: key, unit: 'K', kind: 'item' as const, item, tip: `max of ${item}` });
	const t: ResultTable = {
		id: 'g', group: 'g', label: '', orient: 'rows', hash: '', runs: [], ms: 0, cached: false, errors: [],
		columns: [{ key: 'step', name: 'step', unit: '', kind: 'step', tip: '' }, col('T[0]', 'T'), col('T[1]', 'T'), col('q', 'q')],
		rows: [
			{ cells: [0, 1, 2, 5], meta: [null, null, null, null], errors: [null, null, null, null], run: 'r', step: 0 },
			{ cells: [1, 3, 4, null], meta: [null, null, null, null], errors: [null, null, null, 'outside the mesh'], run: 'r', step: 1 },
			{ cells: [2, null, null, 7], meta: [null, null, null, null], errors: [null, NOT_SELECTED, NOT_SELECTED, null], run: 'r', step: 2 },
		],
	};
	const e = evalsOfTable(t, { id: 'g', label: 'Group' }, (k) => `#${k}`);
	assert.deepEqual(Object.keys(e), [evalKey('g', 'T[0]'), evalKey('g', 'T[1]'), evalKey('g', 'q')]);
	assert.equal(e[evalKey('g', 'T[0]')]!.value, 3);
	assert.equal(e[evalKey('g', 'T[1]')]!.value, 4);
	assert.match(e[evalKey('g', 'T[0]')]!.tip, /solution step #1/);
	assert.equal(e[evalKey('g', 'q')]!.value, 7);
	assert.equal(e[evalKey('g', 'T[0]')]!.groupLabel, 'Group');
	const t2 = { ...t, rows: t.rows.slice(0, 2) };
	const e2 = evalsOfTable(t2, { id: 'g', label: 'g' });
	assert.equal(e2[evalKey('g', 'q')]!.value, null);
	assert.equal(e2[evalKey('g', 'q')]!.why, 'outside the mesh');
	// keys are option values of the plot's select: printable ASCII (a control character does not survive the DOM)
	for (const k of Object.keys(e)) assert.match(k, /^[\x20-\x7e]+$/);
	// a group of a study the run does not answer for: no rows, nothing listed
	assert.deepEqual(evalsOfTable({ ...t, rows: [], errors: ['study s2 not solved'] }, { id: 'g', label: 'g' }), {});
});
