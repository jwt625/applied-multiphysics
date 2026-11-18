// SPDX-License-Identifier: GPL-3.0-or-later
// View link hardening (gfx/view-link.ts, fix lane FX-web, DevLog-057 items 3-4): non-finite numbers and degenerate
// cameras are dropped on decode; the component index is bounded by the drawn field's components (link: ignored to the
// default; agent: refused with a message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundComponent, componentProblem, decodeView, encodeView } from '../src/lib/gfx/view-link.ts';

test('decodeView drops non-finite numbers and a camera with a non-finite or zero distance', () => {
	assert.deepEqual(decodeView('ph:1e999~cam:1e999_0_0_0_0_0'), {});
	assert.deepEqual(decodeView(encodeURIComponent('ph:-1e999~c:1e999~s:1e999')), {});
	assert.deepEqual(decodeView('cam:1_2_3_1_2_3'), {});
	assert.deepEqual(decodeView('cam:1e308_0_0_-1e308_0_0'), {});
	assert.deepEqual(decodeView('ph:1.5~cam:1_0_0_0_0_0'), { phase: 1.5, cam: { pos: [1, 0, 0], target: [0, 0, 0] } });
	assert.deepEqual(decodeView('ph:1e%2B2'), { phase: 100 });
	// encode never writes a degenerate camera
	assert.equal(encodeView({ cam: { pos: [1, 1, 1], target: [1, 1, 1] } }), '');
	assert.equal(encodeView({ cam: { pos: [Infinity, 0, 0], target: [0, 0, 0] } }), '');
});

test('component: link values outside -1 .. 15 dropped; the drawn field bounds the rest to its components', () => {
	assert.deepEqual(decodeView('c:15'), { comp: 15 });
	assert.deepEqual(decodeView('c:16'), {});
	assert.deepEqual(decodeView('c:-2'), {});
	// a 2-component field: -1, 0, 1 kept; 2 .. 15 -> -1 (magnitude, the default)
	assert.deepEqual([-1, 0, 1, 2, 15, 1.5, NaN].map((c) => boundComponent(c, 2)), [-1, 0, 1, -1, -1, -1, -1]);
	// 3 components: 2 kept, 3 not
	assert.deepEqual([2, 3].map((c) => boundComponent(c, 3)), [2, -1]);
	// a scalar field keeps -1 or 0 (both draw the value)
	assert.deepEqual([-1, 0, 1].map((c) => boundComponent(c, 1)), [-1, 0, -1]);
});

test('component: agent requests out of range are refused with the field and its range named', () => {
	assert.equal(componentProblem(1, 2, 'u'), '');
	assert.equal(componentProblem(-1, 3, 'E'), '');
	assert.equal(componentProblem(3, 3, 'E'), 'field E has 3 components: component 3 is out of range (0 .. 2, -1 = magnitude)');
	assert.equal(componentProblem(0, 1, 'T'), '');
	assert.equal(componentProblem(2, 1, 'T'), 'field T is a scalar: no component 2 (use -1 or omit)');
	assert.match(componentProblem(0.5, 3, 'E'), /integer/);
});
