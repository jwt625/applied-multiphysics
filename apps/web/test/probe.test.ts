// SPDX-License-Identifier: GPL-3.0-or-later
// Probe helpers (post/probe.ts, DevLog-020 s.1.4): ray picking of the drawn triangle soup (Moller-Trumbore with clip and
// displacement) and the TSV export. Expected values derived by hand from the geometry (lane T1, DevLog-038).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rayHit, columns, toTsv, type ProbeRow } from '../src/lib/post/probe.ts';

type V3 = [number, number, number];
const soup = (...tris: V3[][]) => Float32Array.from(tris.flat(2));
const near = (a: readonly number[], b: readonly number[], tol = 1e-6) => {
	assert.equal(a.length, b.length);
	a.forEach((x, i) => assert.ok(Math.abs(x - b[i]!) <= tol, `component ${i}: ${x} vs ${b[i]}`));
};
// unit right triangle in z = 0 and the same triangle lifted to z = 0.5
const T0: V3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
const T5: V3[] = [[0, 0, 0.5], [1, 0, 0.5], [0, 1, 0.5]];
const down: V3 = [0, 0, -1];

test('rayHit: axis ray onto a triangle; hit point and the same point on the reference surface', () => {
	const h = rayHit([0.25, 0.25, 1], down, soup(T0), null, 1, null);
	assert.ok(h);
	near(h.drawn, [0.25, 0.25, 0]);
	near(h.ref, [0.25, 0.25, 0]);
	// skewed point: u = 0.5 along edge 0-1, v = 0.25 along edge 0-2 -> (0.5, 0.25, 0)
	const g = rayHit([0.5, 0.25, 3], down, soup(T0), null, 1, null);
	near(g!.drawn, [0.5, 0.25, 0]);
	near(g!.ref, [0.5, 0.25, 0]);
});

test('rayHit: the nearest of two triangles wins, regardless of order in the soup', () => {
	for (const s of [soup(T0, T5), soup(T5, T0)]) {
		const h = rayHit([0.25, 0.25, 1], down, s, null, 1, null);
		near(h!.drawn, [0.25, 0.25, 0.5]);
	}
	// from below the nearest is z = 0
	const up = rayHit([0.25, 0.25, -1], [0, 0, 1], soup(T5, T0), null, 1, null);
	near(up!.drawn, [0.25, 0.25, 0]);
});

test('rayHit: misses (outside the triangle, parallel ray, triangle behind the origin) return null', () => {
	assert.equal(rayHit([1, 1, 1], down, soup(T0), null, 1, null), null); // u + v = 2 > 1
	assert.equal(rayHit([-0.1, 0.2, 1], down, soup(T0), null, 1, null), null); // u < 0
	assert.equal(rayHit([0.25, 0.25, 0], [1, 0, 0], soup(T0), null, 1, null), null); // det = 0
	assert.equal(rayHit([0.25, 0.25, -1], down, soup(T0), null, 1, null), null); // s < 0
	assert.equal(rayHit([0.25, 0.25, 1], down, new Float32Array(0), null, 1, null), null);
});

test('rayHit: the clipped half space dot(p, n) > d is skipped (the hit behind the clip plane is found)', () => {
	const clip = { n: [0, 0, 1] as V3, d: 0.25 };
	const h = rayHit([0.25, 0.25, 1], down, soup(T5, T0), null, 1, clip);
	near(h!.drawn, [0.25, 0.25, 0]);
	// clip plane above both: the near one is kept
	const k = rayHit([0.25, 0.25, 1], down, soup(T5, T0), null, 1, { n: [0, 0, 1], d: 0.75 });
	near(k!.drawn, [0.25, 0.25, 0.5]);
});

test('rayHit: displacement times scale moves the drawn surface; ref stays on the undeformed body', () => {
	// every vertex displaced by (0, 0, 0.5), scale 2 -> drawn surface at z = 1
	const disp = Float32Array.from([0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5]);
	const h = rayHit([0.25, 0.25, 2], down, soup(T0), disp, 2, null);
	near(h!.drawn, [0.25, 0.25, 1]);
	near(h!.ref, [0.25, 0.25, 0]);
	// a shear: vertex 1 moves +1 in x (scale 1) -> drawn triangle (0,0),(2,0),(0,1); the drawn point (1, 0.25) has
	// barycentrics u = 0.5, v = 0.25 -> ref (0.5, 0.25, 0) on the undeformed triangle
	const shear = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 0]);
	const s = rayHit([1, 0.25, 1], down, soup(T0), shear, 1, null);
	near(s!.drawn, [1, 0.25, 0]);
	near(s!.ref, [0.5, 0.25, 0]);
});

const row = (o: Partial<ProbeRow>): ProbeRow => ({ n: 1, ts: '2026-11-18T00:00:00Z', dim: 2, p: [0, 0, 0], lu: { unit: 'mm', f: 1e3 }, field: 'T', value: 1, unit: 'K', dataset: '', point: -1, run: 'r', key: 'k', ...o });

test('columns: 2D only has no z column; any 3D row adds it; unit from the first row', () => {
	assert.deepEqual(columns([row({})]), ['#', 'x (mm)', 'y (mm)', 'field', 'value', 'unit', 'dataset']);
	assert.deepEqual(columns([row({}), row({ dim: 3 })]), ['#', 'x (mm)', 'y (mm)', 'z (mm)', 'field', 'value', 'unit', 'dataset']);
	assert.deepEqual(columns([]), ['#', 'x (m)', 'y (m)', 'field', 'value', 'unit', 'dataset']);
});

test('toTsv: coordinates converted with the first row length factor, 8 significant digits, N/A for null, empty z for 2D rows', () => {
	const rows = [
		row({ n: 1, p: [0.0015, 0.002, 0], value: 1234.56789123, field: 'T', unit: 'K', dataset: 'D=2 mm' }),
		// a 3D row with its own lu (um) is still written in the first row's unit (mm)
		row({ n: 2, dim: 3, p: [0.001, 0, 0.0005], lu: { unit: 'um', f: 1e6 }, value: null, field: 'u.x', unit: 'um' })
	];
	const lines = toTsv(rows).split('\n');
	assert.equal(lines.length, 4); // header, 2 rows, trailing newline -> empty last element
	assert.equal(lines[3], '');
	assert.equal(lines[0], ['#', 'x (mm)', 'y (mm)', 'z (mm)', 'field', 'value', 'unit', 'dataset'].join('\t'));
	assert.deepEqual(lines[1]!.split('\t'), ['1', '1.5', '2', '', 'T', '1234.5679', 'K', 'D=2 mm']);
	assert.deepEqual(lines[2]!.split('\t'), ['2', '1', '0', '0.5', 'u.x', 'N/A', 'um', '']);
	// non-finite coordinates are written empty
	const bad = toTsv([row({ p: [NaN, 0, 0] })]).split('\n')[1]!.split('\t');
	assert.equal(bad[1], '');
	assert.equal(toTsv([]), '#\tx (m)\ty (m)\tfield\tvalue\tunit\tdataset\n');
});
