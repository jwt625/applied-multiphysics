// SPDX-License-Identifier: GPL-3.0-or-later
// Complex field display ops (gfx/complex.ts, DevLog-052): grouping of <u>_re / _im / _abs, parts, the per-frame
// instantaneous field, phase unwrap and lattice statistics. Inputs are hand-made numbers; expected values by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complexPart, groupComplex, instant, latticeStats, partLabel, peakAbs, unwrap, wrapPhase } from '../src/lib/gfx/complex.ts';

const close = (a: number, b: number, tol = 1e-12) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('groupComplex folds _re/_im/_abs into one entry and keeps the others in order', () => {
	const g = groupComplex(['w.Ez_re', 'w.Ez_im', 'w.Ez_abs', 'w.H_re', 'w.H_im', 'w.normH', 'T', 'q_re']);
	assert.deepEqual(g.entries, ['w.Ez', 'w.H', 'w.normH', 'T', 'q_re']);
	assert.deepEqual(g.groups.get('w.Ez'), { key: 'w.Ez', re: 'w.Ez_re', im: 'w.Ez_im', abs: 'w.Ez_abs' });
	assert.equal(g.groups.get('w.H')!.abs, null);
	assert.equal(g.groups.has('q'), false, 'a lone _re is not complex');
});

test('groupComplex does not shadow an existing field of the base name', () => {
	const g = groupComplex(['p', 'p_re', 'p_im']);
	assert.deepEqual(g.entries, ['p', 'p_re', 'p_im']);
	assert.equal(g.groups.size, 0);
});

test('complexPart: Re, Im, |.|, arg, Re(u e^(j phi))', () => {
	const re = [3, 0, -1, 1], im = [4, 2, 0, -1];
	assert.deepEqual([...complexPart(re, im, 're')], re);
	assert.deepEqual([...complexPart(re, im, 'im')], im);
	assert.deepEqual([...complexPart(re, im, 'abs')], [5, 2, 1, Math.SQRT2]);
	const a = complexPart(re, im, 'arg');
	close(a[0]!, Math.atan2(4, 3)); close(a[1]!, Math.PI / 2); close(a[2]!, Math.PI); close(a[3]!, -Math.PI / 4);
	// phi = 0: Re u; phi = pi/2: Re(j u) = -Im u; phi = pi: -Re u
	const i0 = complexPart(re, im, 'inst', 0), i1 = complexPart(re, im, 'inst', Math.PI / 2), i2 = complexPart(re, im, 'inst', Math.PI);
	for (let k = 0; k < 4; k++) { close(i0[k]!, re[k]!); close(i1[k]!, -im[k]!); close(i2[k]!, -re[k]!); }
});

test('instant equals complexPart inst and reuses the output buffer; peakAbs is max |u|', () => {
	const a = Float32Array.from([1, -2, 0.5]), b = Float32Array.from([0, 1, -0.5]);
	const out = new Float32Array(3);
	const r = instant(a, b, 0.7, out);
	assert.equal(r, out);
	const ref = complexPart(a, b, 'inst', 0.7);
	for (let k = 0; k < 3; k++) close(r[k]!, ref[k]!, 1e-6);
	close(peakAbs(a, b), Math.hypot(-2, 1), 1e-6);
	// |Re(u e^(j phi))| never exceeds max |u| over a full cycle
	for (let p = 0; p < 2 * Math.PI; p += 0.1) for (const v of instant(a, b, p)) assert.ok(Math.abs(v) <= peakAbs(a, b) + 1e-6);
});

test('wrapPhase and unwrap', () => {
	close(wrapPhase(-Math.PI / 2), 1.5 * Math.PI);
	close(wrapPhase(5 * Math.PI), Math.PI);
	// a linear phase -1 rad per step, wrapped into (-pi, pi], unwraps back to the line
	const lin = Array.from({ length: 12 }, (_, i) => -i);
	const wrapped = lin.map((v) => Math.atan2(Math.sin(v), Math.cos(v)));
	const u = unwrap(wrapped);
	for (let i = 0; i < lin.length; i++) close(u[i]!, lin[i]!, 1e-12);
});

test('latticeStats: full and robust range, focus box, peak position', () => {
	const n = 1000;
	const vals = Float32Array.from({ length: n }, (_, i) => i);
	vals[500] = 1e6; // one outlier
	const pos = Float32Array.from({ length: 2 * n }, (_, i) => (i % 2 ? 0 : Math.floor(i / 2)));
	const full = latticeStats(vals, pos, [10, 20], null, 'full');
	assert.equal(full.lo, 0); assert.equal(full.hi, 1e6);
	assert.deepEqual(full.peak, { x: 510, y: 20, v: 1e6 });
	const rob = latticeStats(vals, pos, [10, 20], null, 'robust');
	assert.ok(rob.hi < 1e3 && rob.lo >= 0, `${rob.lo} ${rob.hi}`);
	const foc = latticeStats(vals, pos, [10, 20], [10, 0, 109, 100], 'full');
	assert.equal(foc.lo, 0); assert.equal(foc.hi, 99); assert.equal(foc.dataHi, 1e6);
});

test('partLabel', () => {
	assert.deepEqual(['re', 'im', 'abs', 'arg', 'inst'].map((p) => partLabel(p as never, 'Ez')), ['Re Ez', 'Im Ez', '|Ez|', 'arg Ez', 'Re(Ez e^jφ)']);
});
