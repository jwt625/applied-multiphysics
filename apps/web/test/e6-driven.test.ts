// SPDX-License-Identifier: GPL-3.0-or-later
// Driven-solve plot data (gfx/driven.ts, engine/protocol.ts wave2dOf, DevLog-052). The S matrices below are made-up
// test inputs (a lossless 2-port with S11 = 0.6 e^(j a), S21 = 0.8 e^(j b)), not physical results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisPrefix, farFields, powerBalance, sParamSeries, sigmaDb } from '../src/lib/gfx/driven.ts';
import { notesOf, wave2dOf, type Wave2DExtras } from '../src/lib/engine/protocol.ts';

const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const twoPort = (f: number, a: number, b: number) => {
	const s11: [number, number] = [0.6 * Math.cos(a), 0.6 * Math.sin(a)], s21: [number, number] = [0.8 * Math.cos(b), 0.8 * Math.sin(b)];
	// [[S11, S12], [S21, S22]] with S12 = S21, S22 = -S11* e^(2 j b) (unitary)
	const s22: [number, number] = [-0.6 * Math.cos(2 * b - a), -0.6 * Math.sin(2 * b - a)];
	return { f, S: { keys: [{ port: 'in', mode: 0 }, { port: 'out', mode: 0 }], re: [s11[0], s21[0], s21[0], s22[0]], im: [s11[1], s21[1], s21[1], s22[1]] } };
};
const W: Wave2DExtras = { kind: 'emw', polarization: 'TM', field: 'Ez', freqs: [1.9e14, 1.95e14, 2e14], perFrequency: [twoPort(1.9e14, 0.1, -3), twoPort(1.95e14, 0.2, -6), twoPort(2e14, 0.3, -9)], pml: null };

test('axisPrefix picks the engineering prefix of the largest value', () => {
	assert.deepEqual(axisPrefix([1.9e14, 2e14], 'Hz'), { f: 1e-12, unit: 'THz' });
	assert.deepEqual(axisPrefix([343, 500], 'Hz'), { f: 1, unit: 'Hz' });
	assert.deepEqual(axisPrefix([2.4e9], 'Hz'), { f: 1e-9, unit: 'GHz' });
});

test('S-parameter series: dB, unwrapped phase, labels, power balance', () => {
	const r = sParamSeries(W);
	assert.equal(r.xUnit, 'THz');
	assert.equal(r.series.length, 4);
	const s21 = r.series.find((s) => s.name === 'S21')!;
	assert.deepEqual(s21.x.map((x) => Number(x.toFixed(6))), [190, 195, 200]);
	for (const v of s21.dB) close(v, 20 * Math.log10(0.8));
	// -3, -6, -9 rad unwrapped (the wrapped values jump by 2 pi)
	s21.deg.forEach((v, i) => close(v, (-3 * (i + 1) * 180) / Math.PI + (s21.deg[0]! - (-3 * 180) / Math.PI), 1e-9));
	assert.ok(Math.abs(s21.deg[2]! - s21.deg[0]!) > 300, 'unwrapped across -pi');
	const wrapped = sParamSeries(W, { wrap: true }).series.find((s) => s.name === 'S21')!;
	for (const v of wrapped.deg) assert.ok(v > -180 && v <= 180);
	assert.equal(s21.inLabel, 'port 1 (in)');
	for (const b of powerBalance(W)) close(b.sum, 1, 1e-12);
});

test('a key missing at one frequency gives NaN there (pen break)', () => {
	const w: Wave2DExtras = { ...W, perFrequency: [W.perFrequency[0]!, { f: 1.95e14 }, W.perFrequency[2]!] };
	const s = sParamSeries(w).series.find((x) => x.name === 'S11')!;
	assert.ok(Number.isNaN(s.dB[1]!) && Number.isFinite(s.dB[0]!) && Number.isFinite(s.dB[2]!));
});

test('far field and dB with floor', () => {
	const phi = Array.from({ length: 360 }, (_, i) => (2 * Math.PI * i) / 360);
	const w: Wave2DExtras = { ...W, perFrequency: [{ f: 3e8, farField: { phi, sigma2d: phi.map((p) => 1 + Math.cos(p)) } }] };
	const ff = farFields(w);
	assert.equal(ff.length, 1);
	close(ff[0]!.max, 2);
	close(ff[0]!.phiDeg[90]!, 90);
	const db = sigmaDb([2, 0.002, 0], 20);
	close(db[0]!, 10 * Math.log10(2));
	close(db[1]!, 10 * Math.log10(2) - 20);
	close(db[2]!, 10 * Math.log10(2) - 20);
});

test('wave2dOf reads the extras and rejects malformed ones; notesOf', () => {
	const sol = { fields: [], wave2d: { ...W, pml: { inner: { x0: -1, y0: -1, x1: 1, y1: 1 }, outer: { x0: -2, y0: -2, x1: 2, y1: 2 } } }, notes: ['a', 2] };
	const w = wave2dOf(structuredClone(sol));
	assert.ok(w && w.pml && w.pml.inner.x1 === 1);
	assert.equal(w!.perFrequency.length, 3);
	assert.equal(wave2dOf({ wave2d: { freqs: 'x' } }), null);
	assert.equal(wave2dOf({ wave2d: { ...W, pml: { inner: 1 } } })!.pml, null);
	assert.equal(wave2dOf(null), null);
	assert.deepEqual(notesOf(sol), ['a', '2']);
	assert.deepEqual(notesOf({}), []);
});

test('band diagram series from wave2d.bands (frequencies per path point)', async () => {
	const { bandSeries } = await import('../src/lib/gfx/driven.ts');
	const sol = { wave2d: { kind: 'emw', field: 'Ez', study: 'bands', bands: { labels: [{ index: 0, label: 'Γ' }, { index: 2, label: 'X' }], distance: [0, 1e6, 2e6], f: [[0, 2e14], [5e13, 1.5e14], [1e14, 1.2e14]] } } };
	const w = wave2dOf(sol);
	assert.ok(w && w.bands && w.freqs.length === 0);
	const b = bandSeries(w!)!;
	assert.equal(b.yUnit, 'THz');
	assert.equal(b.series.length, 2);
	assert.deepEqual(b.series[0]!.y.map((v) => Number(v.toFixed(9))), [0, 50, 100]);
	assert.deepEqual(b.marks, [{ x: 0, label: 'Γ' }, { x: 2e6, label: 'X' }]);
	assert.equal(wave2dOf({ wave2d: { bands: { distance: [0, 1], f: [[1]] } } }), null, 'f rows must match the path');
});
