// SPDX-License-Identifier: GPL-3.0-or-later
// Sweep editing edge cases and limits (state/sweep.ts, fix lane FX-web, DevLog-057 items 5-6): replacing a parametric
// study without `settings` or without `physics` gives a valid RFC 6902 patch (add, not replace) that keeps every op;
// the sweep point cap. Expected values written out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '@amp/spec';
import { MAX_SWEEP_POINTS, setSweepPatch, sweepProblem, type SweepDef } from '../src/lib/state/sweep.ts';

const model = (sweep: Record<string, unknown>) => ({
	params: { w: { value: 1, unit: 'um' }, t: { value: 2, unit: 'um' } },
	studies: [{ id: 'modes', type: 'mode', physics: ['ewg'] }, sweep]
});
const def: SweepDef = { id: 'sw', study: 'modes', axes: [{ param: 'w', mode: 'values', values: ['1', '2'], start: '', stop: '', n: 2, unit: 'um' }] };
const expected = { id: 'sw', type: 'parametric', physics: ['ewg'], settings: { study: 'modes', sweep: [{ param: 'w', values: ['1 um', '2 um'] }] } };

test('replace a parametric study without settings: physics op kept, settings added; the patch applies', () => {
	const d = model({ id: 'sw', type: 'parametric', physics: [] });
	const r = setSweepPatch(d, def);
	assert.ok(r.ok);
	assert.deepEqual(r.patch, [
		{ op: 'replace', path: '/studies/1/physics', value: ['ewg'] },
		{ op: 'add', path: '/studies/1/settings', value: { study: 'modes', sweep: [{ param: 'w', values: ['1 um', '2 um'] }] } }
	]);
	assert.deepEqual((applyPatch(d, r.patch).doc as { studies: unknown[] }).studies[1], expected);
});

test('replace a parametric study without physics (and without settings): add, not replace', () => {
	const d1 = model({ id: 'sw', type: 'parametric', settings: { study: 'modes', sweep: [{ param: 't', values: [1] }] } });
	const r1 = setSweepPatch(d1, def);
	assert.ok(r1.ok);
	assert.deepEqual(r1.patch, [
		{ op: 'add', path: '/studies/1/physics', value: ['ewg'] },
		{ op: 'replace', path: '/studies/1/settings/sweep', value: [{ param: 'w', values: ['1 um', '2 um'] }] }
	]);
	assert.deepEqual((applyPatch(d1, r1.patch).doc as { studies: unknown[] }).studies[1], expected);
	const d2 = model({ id: 'sw', type: 'parametric' });
	const r2 = setSweepPatch(d2, def);
	assert.ok(r2.ok);
	assert.deepEqual(r2.patch.map((o) => [o.op, o.path]), [['add', '/studies/1/physics'], ['add', '/studies/1/settings']]);
	assert.deepEqual((applyPatch(d2, r2.patch).doc as { studies: unknown[] }).studies[1], expected);
});

test(`sweep point cap: at most ${MAX_SWEEP_POINTS} points over all axes`, () => {
	assert.equal(MAX_SWEEP_POINTS, 200);
	const d = model({ id: 'other', type: 'mode' });
	const range = (param: string, n: number) => ({ param, mode: 'range' as const, values: [], start: '1', stop: '2', n, unit: 'um' });
	assert.equal(sweepProblem(d, { id: 'sw', study: 'modes', axes: [range('w', 200)] }, true), '');
	assert.match(sweepProblem(d, { id: 'sw', study: 'modes', axes: [range('w', 201)] }, true), /201 sweep points: at most 200/);
	assert.equal(sweepProblem(d, { id: 'sw', study: 'modes', axes: [range('w', 20), range('t', 10)] }, true), '');
	assert.match(sweepProblem(d, { id: 'sw', study: 'modes', axes: [range('w', 20), range('t', 11)] }, true), /220 sweep points/);
	const r = setSweepPatch(d, { id: 'sw', study: 'modes', axes: [range('w', 1000)] });
	assert.equal(r.ok, false);
});
