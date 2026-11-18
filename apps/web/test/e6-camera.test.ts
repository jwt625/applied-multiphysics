// SPDX-License-Identifier: GPL-3.0-or-later
// 3D camera presets (gfx/camera.ts, DevLog-052): directions, the registry, false without a mounted 3D view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_PRESETS, applyCamera, cameraPose, hasCameraView, lastPreset, presetDirection, registerCameraTarget, setCameraPreset, type CameraPose } from '../src/lib/gfx/camera.ts';

test('preset directions are unit vectors; top looks down, front looks along +y', () => {
	for (const p of CAMERA_PRESETS) { const d = presetDirection(p); assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12, p); }
	assert.ok(presetDirection('top')[2] > 0.999);
	assert.ok(presetDirection('bottom')[2] < -0.999);
	assert.deepEqual(presetDirection('front'), [0, -1, 0]);
	assert.deepEqual(presetDirection('right'), [1, 0, 0]);
});

test('setCameraPreset is false without a 3D view and for bad input', () => {
	assert.equal(hasCameraView(), false);
	assert.equal(setCameraPreset('top'), false);
	assert.equal(cameraPose(), null);
});

test('the registered view receives direction and look-at; a queued pose applies on mount', () => {
	const calls: unknown[] = [];
	let pose: CameraPose = { pos: [1, 1, 1], target: [0, 0, 0] };
	applyCamera({ pos: [5, 0, 0], target: [1, 0, 0] });
	const off = registerCameraTarget({ preset: (d, l) => calls.push(['preset', d, l]), pose: () => pose, setPose: (p) => { pose = p; calls.push(['pose', p]); } });
	assert.deepEqual(calls.shift(), ['pose', { pos: [5, 0, 0], target: [1, 0, 0] }]);
	assert.equal(setCameraPreset('nope'), false);
	assert.equal(setCameraPreset('front', [1, 2] as never), false);
	assert.equal(setCameraPreset('front', [1, 2, Number.NaN]), false);
	assert.equal(setCameraPreset('front', [1, 2, 3]), true);
	assert.deepEqual(calls.shift(), ['preset', [0, -1, 0], [1, 2, 3]]);
	assert.equal(setCameraPreset('iso'), true);
	assert.deepEqual((calls.shift() as unknown[])[2], null);
	assert.equal(lastPreset(), 'iso');
	assert.deepEqual(cameraPose(), pose);
	off();
	assert.equal(setCameraPreset('top'), false);
});
