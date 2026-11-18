// SPDX-License-Identifier: GPL-3.0-or-later
// Parameter access for sliders and exact fields (state/params.ts): value, unit, slider span, pointer and the patches a
// slider or handle writes. Expected spans and SI conversions worked out by hand (lane T1, DevLog-038).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyString } from '@amp/spec';
import { paramViews, paramValue, paramPatchSI } from '../src/lib/state/params.ts';

const PARAMS = {
	n: 4,
	d: '2 mm',
	e: 'd * 2',
	r: { value: 3, unit: 'um', range: [1, 10] as [number, number], description: 'radius' },
	neg: -2,
	z: 0,
	x: { value: 'n + 1', unit: 'm' },
	k: '5'
};

test('paramViews: value, unit, expression, pointer, description per param form', () => {
	const v = Object.fromEntries(paramViews(PARAMS, PARAMS).map((p) => [p.name, p]));
	assert.deepEqual(Object.keys(v), ['n', 'd', 'e', 'r', 'neg', 'z', 'x', 'k']);
	assert.deepEqual([v.n!.value, v.n!.unit, v.n!.expr, v.n!.pointer], [4, '', null, '/params/n']);
	assert.deepEqual([v.d!.value, v.d!.unit, v.d!.pointer], [2, 'mm', '/params/d']);
	assert.deepEqual([v.e!.value, v.e!.expr, v.e!.span], [null, 'd * 2', null]);
	assert.deepEqual([v.r!.value, v.r!.unit, v.r!.pointer, v.r!.description], [3, 'um', '/params/r/value', 'radius']);
	assert.deepEqual([v.x!.value, v.x!.expr, v.x!.unit, v.x!.pointer], [null, 'n + 1', 'm', '/params/x/value']);
	assert.deepEqual([v.k!.value, v.k!.unit], [5, '1']);
	assert.deepEqual(paramViews(undefined, PARAMS), []);
});

test('paramViews: span = spec range, else 0.5x..2x of the ORIGINAL value (ordered for negatives), none for 0', () => {
	const v = Object.fromEntries(paramViews(PARAMS, PARAMS).map((p) => [p.name, p]));
	assert.deepEqual([v.r!.span, v.r!.spanFromSpec], [[1, 10], true]);
	assert.deepEqual([v.n!.span, v.n!.spanFromSpec], [[2, 8], false]);
	assert.deepEqual(v.d!.span, [1, 4]);
	assert.deepEqual(v.neg!.span, [-4, -1]);
	assert.equal(v.z!.span, null);
	// the span follows the original model, not the edited value
	const edited = Object.fromEntries(paramViews({ ...PARAMS, n: 100 }, PARAMS).map((p) => [p.name, p]));
	assert.deepEqual([edited.n!.value, edited.n!.span], [100, [2, 8]]);
	// without an original entry the current value is the base
	const fresh = Object.fromEntries(paramViews({ q: 10 }, {}).map((p) => [p.name, p]));
	assert.deepEqual(fresh.q!.span, [5, 20]);
});

test('paramValue: writes the param in its own form', () => {
	const v = Object.fromEntries(paramViews(PARAMS, PARAMS).map((p) => [p.name, p]));
	assert.equal(paramValue(v.n!, 7), 7);
	assert.equal(paramValue(v.d!, 3), '3 mm');
	assert.equal(paramValue(v.r!, 5), 5);
	// a unitless string param: the written string parses back to the same literal
	const k = paramValue(v.k!, 7);
	assert.equal(typeof k, 'string');
	assert.deepEqual(classifyString(k as string), { kind: 'literal', value: 7, unit: '1' });
});

test('paramPatchSI: SI value written in the param unit; expressions become a literal in the SI unit', () => {
	const L = [1, 0, 0, 0, 0];
	assert.deepEqual(paramPatchSI(PARAMS, 'n', 5, L), [{ op: 'replace', path: '/params/n', value: 5 }]);
	assert.deepEqual(paramPatchSI(PARAMS, 'd', 0.003, L), [{ op: 'replace', path: '/params/d', value: '3 mm' }]);
	// object param: whole object written (one pointer per gesture), value in its unit, range and description kept
	assert.deepEqual(paramPatchSI(PARAMS, 'r', 4e-6, L), [{ op: 'replace', path: '/params/r', value: { value: 4, unit: 'um', range: [1, 10], description: 'radius' } }]);
	// expression string: the user's drag replaces it by a literal in the SI unit of the dimension
	assert.deepEqual(paramPatchSI(PARAMS, 'e', 0.004, L), [{ op: 'replace', path: '/params/e', value: '0.004 m' }]);
	// expression object: value replaced, unit from the dimension
	assert.deepEqual(paramPatchSI(PARAMS, 'x', 2, L), [{ op: 'replace', path: '/params/x', value: { value: 2, unit: 'm' } }]);
	// 6 significant digits
	assert.deepEqual(paramPatchSI(PARAMS, 'n', 1 / 3, L), [{ op: 'replace', path: '/params/n', value: 0.333333 }]);
	assert.deepEqual(paramPatchSI(PARAMS, 'nope', 1, L), []);
	assert.deepEqual(paramPatchSI(undefined, 'n', 1, L), []);
});

test('paramPatchSI: affine units (degC) subtract the offset', () => {
	// 300 K -> 26.85 degC
	const p = paramPatchSI({ T: '20 degC' }, 'T', 300, [0, 0, 0, 0, 1]);
	assert.equal(p.length, 1);
	const c = classifyString(p[0]!.value as string);
	assert.equal(c.kind, 'literal');
	if (c.kind === 'literal') { assert.equal(c.unit, 'degC'); assert.ok(Math.abs(c.value - 26.85) < 1e-9); }
});
