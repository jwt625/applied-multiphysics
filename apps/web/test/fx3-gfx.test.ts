// SPDX-License-Identifier: GPL-3.0-or-later
// Fix lane FX3-web (DevLog-067 items 2, 4, 6): the hover of a complex field reads Re and Im from the pair resident in
// the post worker (probeHit) and equals the click path (evalAt per component, fields posted) bitwise; complex vectors
// at magnitude: |u| and Re(u e^(j phi)) are norms over the per-component parts (hover, click and the per-frame lattice
// combination agree), the phase of a vector is not defined; camera preset detection compares the look-at point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectTriMesh, nCells, nNodes } from '@amp/physics/common/mesh';
import { Locator, probeHit, toMesh2D, withPerDomain, evalElement, type Field2D } from '../src/lib/post/field2d.ts';
import { probe2d } from '../src/lib/post/probe.ts';
import type { PostClient } from '../src/lib/post/client.ts';
import type { FieldData } from '@amp/spec/types';
import { complexValue, complexVectorValue, instNorm, peakAbsVector, type ComplexPart } from '../src/lib/gfx/complex.ts';
import { currentPreset, presetDirection, presetOfPose, registerCameraTarget, setCameraPreset, type CameraPose } from '../src/lib/gfx/camera.ts';

test('complexVectorValue: component, scalar and vector norms of the per-component parts', () => {
	assert.equal(complexVectorValue([3], [4], -1, 'abs', 0), 5);
	assert.equal(complexVectorValue([1, 2], [3, 4], 1, 'inst', 0.3), complexValue(2, 4, 'inst', 0.3));
	assert.equal(complexVectorValue([3, 0], [0, 4], -1, 'abs', 0), 5);
	// |u| of a vector = sqrt(|Re|^2 + |Im|^2)
	assert.ok(Math.abs(complexVectorValue([1, 2], [3, 4], -1, 'abs', 0)! - Math.sqrt(1 + 4 + 9 + 16)) < 1e-15);
	const phi = 0.3, c = Math.cos(phi), s = Math.sin(phi);
	assert.ok(Math.abs(complexVectorValue([1, 2], [3, 4], -1, 'inst', phi)! - Math.hypot(c * 1 - s * 3, c * 2 - s * 4)) < 1e-15);
	// Re(u e^(j phi)) of the circularly polarised vector (1, -j) has length 1 at every phase (forcing component 0 gave cos phi)
	for (const p of [0, 0.4, 1.2, 2.5]) assert.ok(Math.abs(complexVectorValue([1, 0], [0, -1], -1, 'inst', p)! - 1) < 1e-15);
	assert.equal(complexVectorValue([1, 2], [3, 4], -1, 'arg', 0), null, 'the phase of a vector is not defined');
	assert.equal(complexVectorValue([1, null], [3, 4], -1, 'abs', 0), null);
	assert.equal(complexVectorValue([3, 4], [0, 0], -1, 'abs', 0, -1, 2, 1), 11, 'display affine on the norm; parity sign drops out');
});

test('instNorm and peakAbsVector at lattice points equal the per-point vector value', () => {
	const re = [Float32Array.from([1, 0, 2]), Float32Array.from([0, 1, -1])], im = [Float32Array.from([0, 3, 0]), Float32Array.from([-1, 0, 2])];
	for (const phi of [0, 0.7, 3]) {
		const v = instNorm(re, im, phi);
		for (let i = 0; i < 3; i++) assert.ok(Math.abs(v[i]! - complexVectorValue([re[0]![i]!, re[1]![i]!], [im[0]![i]!, im[1]![i]!], -1, 'inst', phi)!) < 1e-6);
	}
	assert.ok(Math.abs(peakAbsVector(re, im) - Math.sqrt(0 + 1 + 9 + 0)) < 1e-6, "point 1: 0^2 + 1^2 + 3^2 + 0^2");
});

/** the click path: the post worker's evalAt (withPerDomain, then the located element), fields posted per request */
function fakePost(m2: ReturnType<typeof toMesh2D>, loc: Locator): { post: PostClient; posts: () => number } {
	let n = 0;
	const post = { call: async (q: { field: Field2D; comp: number; points: number[] }) => {
		n++;
		const ef = withPerDomain(m2, q.field), h = loc.locate(q.points[0]!, q.points[1]!);
		return { values: [h ? evalElement(m2, ef, h.t, h.L[0], h.L[1], h.L[2], q.comp) : null] };
	} } as unknown as PostClient;
	return { post, posts: () => n };
}

test('hover from the resident pair equals the click path bitwise (scalar P2 and 2-component DG0 fields)', async () => {
	const m = rectTriMesh({ x: [0, 2], y: [0, 1], nx: 5, ny: 3, order: 2 });
	const m2 = toMesh2D(m), loc = new Locator(m2), nn = nNodes(m), nc = nCells(m);
	const X = (v: number) => m.nodes[2 * v]!, Y = (v: number) => m.nodes[2 * v + 1]!;
	const sRe = Float64Array.from({ length: nn }, (_, v) => Math.sin(2 * X(v)) + Y(v)), sIm = Float64Array.from({ length: nn }, (_, v) => Math.cos(3 * Y(v)) - X(v) * Y(v));
	const vRe = Float64Array.from({ length: 2 * nc }, (_, i) => Math.sin(0.7 * i)), vIm = Float64Array.from({ length: 2 * nc }, (_, i) => Math.cos(1.3 * i));
	const fields: Array<{ re: FieldData; im: FieldData }> = [
		{ re: { name: 'Ez_re', unit: 'V/m', space: 'H1P2', components: 1, data: sRe }, im: { name: 'Ez_im', unit: 'V/m', space: 'H1P2', components: 1, data: sIm } },
		{ re: { name: 'H_re', unit: 'A/m', space: 'DG0', components: 2, data: vRe }, im: { name: 'H_im', unit: 'A/m', space: 'DG0', components: 2, data: vIm } }
	];
	const pts: Array<[number, number]> = [[0.37, 0.41], [1.73, 0.88], [X(7), Y(7)], [X(20), Y(20)]];
	for (const P of fields) {
		const pf = (g: FieldData): Field2D => ({ space: g.space as Field2D['space'], data: g.data, components: g.components });
		const pair = { key: 3, re: withPerDomain(m2, pf(P.re)), im: withPerDomain(m2, pf(P.im)) };
		const { post, posts } = fakePost(m2, loc);
		const ncmp = P.re.components;
		for (const [x, y] of pts) {
			const h = probeHit(m2, loc, null, pair, x, y)!;
			assert.equal(h.cx!.key, 3);
			for (const c of ncmp > 1 ? [-1, 0, 1] : [0]) {
				const ks = c >= 0 ? [c] : Array.from({ length: ncmp }, (_, k) => k);
				const re: Array<number | null> = Array.from({ length: ncmp }, () => null), im = re.slice();
				for (const k of ks) { re[k] = await probe2d(post, P.re, k, x, y); im[k] = await probe2d(post, P.im, k, x, y); }
				for (const part of ['abs', 'inst', 'arg', 're', 'im'] as ComplexPart[]) {
					const hv = complexVectorValue(h.cx!.re, h.cx!.im, c, part, 0.9, 1, 2.5, 0);
					const cv = complexVectorValue(re, im, c, part, 0.9, 1, 2.5, 0);
					assert.equal(hv, cv, `${P.re.name} comp ${c} ${part} at (${x}, ${y})`);
				}
			}
		}
		assert.ok(posts() > 0);
	}
	// at a mesh node of the P2 scalar pair the hover |u| is the nodal |u| (difference 0 up to the barycentric rounding)
	const pair = { key: 1, re: { space: 'H1P2' as const, data: sRe, components: 1 }, im: { space: 'H1P2' as const, data: sIm, components: 1 } };
	for (const v of [7, 20, 33]) {
		const h = probeHit(m2, loc, null, pair, X(v), Y(v))!;
		const hv = complexVectorValue(h.cx!.re, h.cx!.im, 0, 'abs', 0)!, ex = Math.hypot(sRe[v]!, sIm[v]!);
		assert.ok(Math.abs(hv - ex) <= 1e-12 * ex, `node ${v}: ${hv} vs ${ex}`);
	}
	assert.equal(probeHit(m2, loc, null, pair, 5, 5), null);
});

test('presetOfPose compares the look-at point when given; currentPreset uses the view centre and the last lookAt', () => {
	const d = presetDirection('iso'), t: [number, number, number] = [1, 2, 3];
	const at = (dir: [number, number, number], tg: [number, number, number], r = 5): CameraPose => ({ pos: [tg[0] + r * dir[0], tg[1] + r * dir[1], tg[2] + r * dir[2]], target: tg });
	assert.equal(presetOfPose(at(d, t), 0.5, t), 'iso');
	assert.equal(presetOfPose(at(d, [1.2, 2, 3]), 0.5, t), null, 'a pan of 0.2 at distance 5 is not the preset view');
	assert.equal(presetOfPose(at(d, [1.2, 2, 3])), 'iso', 'without a look-at point only the direction counts');
	let pose: CameraPose = at(d, t);
	const unreg = registerCameraTarget({
		preset: (dir, lookAt) => { pose = at(dir, lookAt ?? t); },
		pose: () => pose,
		setPose: (p) => { pose = p; },
		centre: () => t
	});
	try {
		assert.equal(currentPreset(), 'iso');
		pose = at(d, [1, 2.5, 3]);
		assert.equal(currentPreset(), null, 'panned');
		assert.ok(setCameraPreset('top', [4, 4, 4]));
		assert.equal(currentPreset(), 'top', 'preset at an explicit look-at point');
		pose = at(presetDirection('front'), t);
		assert.equal(currentPreset(), 'front', 'the view centre still counts after an explicit lookAt');
		// re-applying the shown preset is a plain call (the select returns to its current-view option after each pick)
		assert.ok(setCameraPreset('front'));
		assert.equal(currentPreset(), 'front');
	} finally { unreg(); }
});
