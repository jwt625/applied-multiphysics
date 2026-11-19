// SPDX-License-Identifier: GPL-3.0-or-later
// Lane G7 (DevLog-064): camera preset of a pose (select shows "custom" after a free orbit), exact complex probe values
// from Re and Im, series palette beyond six (8 distinct colours, dashed beyond).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAMERA_PRESETS, presetDirection, presetOfPose } from '../src/lib/gfx/camera.ts';
import { complexValue } from '../src/lib/gfx/complex.ts';

test('presetOfPose: every preset direction maps back to its preset; a free orbit is null', () => {
	for (const p of CAMERA_PRESETS) {
		const d = presetDirection(p), t: [number, number, number] = [0.3, -2, 5];
		assert.equal(presetOfPose({ pos: [t[0] + 7 * d[0], t[1] + 7 * d[1], t[2] + 7 * d[2]], target: t }), p, p);
	}
	// the initial fit direction of the viewer (viewer3d.ts fit: 0.62, -0.55, 0.56, unnormalized) is iso
	assert.equal(presetOfPose({ pos: [0.62 * 3, -0.55 * 3, 0.56 * 3], target: [0, 0, 0] }), 'iso');
	// 2 degrees off the front view: custom
	const a = (2 * Math.PI) / 180;
	assert.equal(presetOfPose({ pos: [Math.sin(a), -Math.cos(a), 0], target: [0, 0, 0] }), null);
	assert.equal(presetOfPose({ pos: [0.2 * Math.sin(a / 8), -0.2, 0], target: [0, 0, 0] }), 'front');
	assert.equal(presetOfPose({ pos: [1, 1, 1], target: [1, 1, 1] }), null);
	assert.equal(presetOfPose(null), null);
});

test('complexValue: |u|, phase and Re(u e^(j phi)) from exact Re and Im (display affine not applied to the phase)', () => {
	assert.equal(complexValue(3, 4, 'abs', 0), 5);
	assert.equal(complexValue(3, 4, 'abs', 0, 1, 1e3), 5e3);
	assert.equal(complexValue(0, 1, 'arg', 0, 1, 1e3, 7), Math.PI / 2);
	// mirror parity -1: u -> -u, phase shifts by pi
	assert.ok(Math.abs(complexValue(0, 1, 'arg', 0, -1)! + Math.PI / 2) < 1e-15);
	assert.ok(Math.abs(complexValue(3, 4, 'inst', Math.PI / 2)! + 4) < 1e-12);
	assert.equal(complexValue(3, 4, 'inst', 0), 3);
	assert.equal(complexValue(3, 4, 're', 1), 3);
	assert.equal(complexValue(3, 4, 'im', 1), 4);
	assert.equal(complexValue(null, 4, 'abs', 0), null);
	assert.equal(complexValue(3, NaN, 'abs', 0), null);
	// the exact combination differs from interpolating nodal |u| between two nodes (the previous hover): u = 1 at one
	// node and j at the other: midpoint |0.5 + 0.5 j| = 0.7071 vs the mean of nodal |u| = 1
	assert.ok(Math.abs(complexValue(0.5, 0.5, 'abs', 0)! - Math.SQRT1_2) < 1e-15);
});

test('series palette: 8 distinct colours (bands 7 and 8 differ from 1 and 2), dashed from the ninth', () => {
	const src = readFileSync(new URL('../src/lib/results/LinePlot.svelte', import.meta.url), 'utf8');
	const m = /export const SERIES_COLORS = \[([^\]]+)\]/.exec(src);
	assert.ok(m);
	const cols = m[1]!.split(',').map((x) => x.trim().replace(/'/g, ''));
	assert.equal(cols.length, 8);
	assert.equal(new Set(cols).size, 8);
	for (const c of cols) assert.match(c, /^#[0-9a-f]{6}$/);
	assert.notEqual(cols[6], cols[0]);
	assert.notEqual(cols[7], cols[1]);
	assert.match(src, /export const seriesDashed = \(k: number\): boolean => k >= SERIES_COLORS\.length;/);
	// SweepPlot and the line plot both take colours from seriesColor (no own modulo-6 cycling left)
	const sweep = readFileSync(new URL('../src/lib/workbench/SweepPlot.svelte', import.meta.url), 'utf8');
	assert.match(sweep, /seriesColor\(i\)/);
	assert.doesNotMatch(sweep + src, /% 6\b/);
});
