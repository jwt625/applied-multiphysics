// SPDX-License-Identifier: GPL-3.0-or-later
// Per-frequency global items (DevLog-061 R2, DevLog-066): a table of global items on a multi-frequency solution gets
// one row per frequency, read from the `<name>_<step>` scalars; on a single-step solution one row as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectTriMesh } from '@amp/physics/common/mesh';
import type { Solution } from '@amp/spec/types';
import { evalTable } from '../src/lib/results/adapter.ts';

const spec = {
	studies: [{ id: 's', type: 'frequency', physics: ['w'] }],
	physics: [{ id: 'w', type: 'emw-2d' }],
	results: {
		datasets: [{ id: 'sol_s', type: 'solution', data: 's' }],
		evaluations: [{ id: 'ev_g', data: 'sol_s', items: [{ id: 'T', type: 'global', expr: 'w.S21_abs^2', unit: '1' }] }],
	},
};
const mesh = rectTriMesh({ x: [0, 1], y: [0, 1], nx: 1, ny: 1 });
const sol = (values: number[], scalars: Solution['scalars']): Solution => ({
	// one field per step, as the wave2d producer gives them (the steps of a solution are those of its fields)
	meshHash: mesh.hash, fields: values.map((_, k) => ({ name: 'Ez_re', unit: 'V/m', space: 'H1P1' as const, components: 1 as const, data: new Float64Array(mesh.nodes.length / 2), step: k })), steps: { kind: 'freq', values: Float64Array.from(values), unit: 'Hz' }, scalars,
	stats: { dof: 0, solver: 'test' }, timing: {}, run: {} as Solution['run'],
});
const run = (s: Solution) => ({ key: 'k', solution: s, mesh, params: new Map(), studies: ['s'], label: '' }) as never;

test('global items on a multi-frequency solution: one row per frequency with the step column', () => {
	const t = evalTable(spec, 'ev_g', [run(sol([1.9e14, 2.0e14, 2.1e14], { S21_abs_0: { value: 0.5, unit: '1' }, S21_abs_1: { value: 0.25, unit: '1' }, S21_abs_2: { value: 0.1, unit: '1' } }))]);
	assert.deepEqual(t.errors, []);
	assert.deepEqual(t.columns.map((c) => c.key), ['#', 'step', 'T']);
	assert.deepEqual(t.rows.map((r) => r.cells), [[1, 1.9e14, 0.25], [2, 2.0e14, 0.0625], [3, 2.1e14, 0.1 * 0.1]]);
});

test('global items on a single-frequency solution: one row, no step column (unchanged)', () => {
	const t = evalTable(spec, 'ev_g', [run(sol([2.0e14], { S21_abs: { value: 0.5, unit: '1' } }))]);
	assert.deepEqual(t.errors, []); assert.deepEqual(t.columns.map((c) => c.key), ['#', 'T']);
	assert.deepEqual(t.rows.map((r) => r.cells), [[1, 0.25]]);
});
