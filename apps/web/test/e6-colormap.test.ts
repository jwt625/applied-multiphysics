// SPDX-License-Identifier: GPL-3.0-or-later
// Colormap tables and the reverse switch (gfx/colormaps.ts, DevLog-052).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLORMAPS, CYCLIC, colormapLut, cssGradient } from '../src/lib/gfx/colormaps.ts';

test('every colormap has 256 opaque entries', () => {
	for (const c of COLORMAPS) {
		const l = colormapLut(c);
		assert.equal(l.length, 1024, c);
		for (let i = 3; i < 1024; i += 4) assert.equal(l[i], 255, c);
	}
});

test('reverse is the table read backwards', () => {
	for (const c of COLORMAPS) {
		const a = colormapLut(c), b = colormapLut(c, true);
		for (let i = 0; i < 256; i++) for (let k = 0; k < 4; k++) assert.equal(b[4 * i + k], a[4 * (255 - i) + k], `${c}[${i}]`);
	}
	assert.notEqual(cssGradient('viridis'), cssGradient('viridis', true));
	assert.ok(cssGradient('viridis', true).startsWith('linear-gradient(to top, rgb(253,231,37) 0.00%'));
});

test('gray is a linear ramp; cyclic maps end where they start', () => {
	const g = colormapLut('gray');
	assert.deepEqual([...g.slice(0, 3)], [0, 0, 0]);
	assert.deepEqual([...g.slice(1020, 1023)], [255, 255, 255]);
	for (const c of CYCLIC) {
		const l = colormapLut(c);
		for (let k = 0; k < 3; k++) assert.ok(Math.abs(l[k]! - l[1020 + k]!) <= 3, `${c} channel ${k}`);
	}
});
