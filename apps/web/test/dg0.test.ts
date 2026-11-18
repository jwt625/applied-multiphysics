// SPDX-License-Identifier: GPL-3.0-or-later
// DG0 recovery to element corners (post/field2d.ts recoverDG0, DevLog-019 s.1.2) and the smooth element coefficients
// built from it. Hand-built tri3 meshes; expected corner values are area-weighted means worked out by hand
// (lane T1, DevLog-038).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverDG0, smoothCoefficients, evalCoef, type Mesh2D, type Field2D } from '../src/lib/post/field2d.ts';

function mesh(nodes: number[], conn: number[], domain: number[], type: 'tri3' | 'tri6' = 'tri3'): Mesh2D {
	const npe = type === 'tri3' ? 3 : 6;
	const N = Float64Array.from(nodes);
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (let i = 0; i < N.length; i += 2) { x0 = Math.min(x0, N[i]!); x1 = Math.max(x1, N[i]!); y0 = Math.min(y0, N[i + 1]!); y1 = Math.max(y1, N[i + 1]!); }
	return { type, nodes: N, conn: Int32Array.from(conn), domain: Int32Array.from(domain), nT: conn.length / npe, npe, bbox: [x0, y0, x1, y1] };
}
const dg0 = (data: number[], components = 1): Field2D => ({ space: 'DG0', data: Float64Array.from(data), components });
const same = (a: ArrayLike<number>, b: number[], tol = 1e-14) => {
	assert.equal(a.length, b.length);
	for (let i = 0; i < b.length; i++) {
		if (Number.isNaN(b[i]!)) assert.ok(Number.isNaN(a[i]!), `[${i}] expected NaN, got ${a[i]}`);
		else assert.ok(Math.abs(a[i]! - b[i]!) <= tol, `[${i}] ${a[i]} vs ${b[i]}`);
	}
};

// two triangles sharing edge 1-2: T0 = (0,0),(2,0),(0,1) area 1; T1 = (2,0),(4,1),(0,1) area 2
const TWO = [0, 0, 2, 0, 0, 1, 4, 1];
const TWO_CONN = [0, 1, 2, 1, 3, 2];

test('recoverDG0: a constant field is reproduced at every corner', () => {
	same(recoverDG0(mesh(TWO, TWO_CONN, [0, 0]), dg0([7, 7])), [7, 7, 7, 7, 7, 7]);
});

test('recoverDG0: shared corners get the area-weighted mean, unshared corners the own cell value', () => {
	// shared nodes 1, 2: (1 * 3 + 2 * 6) / 3 = 5; node 0: 3; node 3: 6. Layout: element-major, corners in conn order
	same(recoverDG0(mesh(TWO, TWO_CONN, [0, 0]), dg0([3, 6])), [3, 5, 5, 5, 6, 5]);
});

test('recoverDG0: a domain interface keeps one value per domain (no smoothing across materials)', () => {
	same(recoverDG0(mesh(TWO, TWO_CONN, [0, 1]), dg0([3, 6])), [3, 3, 3, 6, 6, 6]);
});

test('recoverDG0: non-finite cells are skipped; a corner with no finite cell is NaN', () => {
	same(recoverDG0(mesh(TWO, TWO_CONN, [0, 0]), dg0([3, NaN])), [3, 3, 3, 3, NaN, 3]);
});

test('recoverDG0: vector components are recovered independently (component-major per element)', () => {
	// component 0 as above; component 1: cells -1, 2 -> shared (1 * -1 + 2 * 2) / 3 = 1
	same(recoverDG0(mesh(TWO, TWO_CONN, [0, 0]), dg0([3, -1, 6, 2], 2)), [3, 5, 5, -1, 1, 1, 5, 6, 5, 1, 2, 1]);
});

test('recoverDG0: fan of four equal cells in two domains; centre node has one value per domain; bounded by cell values', () => {
	// centre 0 at the origin, 1 (1,0), 2 (0,1), 3 (-1,0), 4 (0,-1); cells (0,1,2) d0 1, (0,2,3) d0 3, (0,3,4) d1 10, (0,4,1) d1 20
	const m = mesh([0, 0, 1, 0, 0, 1, -1, 0, 0, -1], [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1], [0, 0, 1, 1]);
	const r = recoverDG0(m, dg0([1, 3, 10, 20]));
	// d0 centre (1 + 3) / 2 = 2, d1 centre (10 + 20) / 2 = 15; node 1: d0 -> 1, d1 -> 20; node 3: d0 -> 3, d1 -> 10
	same(r, [2, 1, 2, 2, 2, 3, 15, 10, 15, 15, 15, 20]);
	for (let t = 0; t < 4; t++) {
		const lo = t < 2 ? 1 : 10, hi = t < 2 ? 3 : 20;
		for (let k = 0; k < 3; k++) assert.ok(r[3 * t + k]! >= lo && r[3 * t + k]! <= hi);
	}
});

test('recoverDG0: tri6 meshes use the corner nodes only (area from the corners)', () => {
	// same two triangles as tri6; mid nodes 4..8 appended (positions irrelevant to the recovery)
	const nodes = [...TWO, 1, 0, 1, 0.5, 0, 0.5, 3, 0.5, 2, 1];
	const conn = [0, 1, 2, 4, 5, 6, 1, 3, 2, 7, 8, 5];
	same(recoverDG0(mesh(nodes, conn, [0, 0], 'tri6'), dg0([3, 6])), [3, 5, 5, 5, 6, 5]);
});

test('smoothCoefficients: DG0 corners from the recovery, mids as edge means; P1 nodal; P2 the six nodal values', () => {
	const m = mesh(TWO, TWO_CONN, [0, 0]);
	const d = smoothCoefficients(m, dg0([3, 6]), 0);
	assert.equal(d.nc, 1);
	assert.equal(d.mag, false);
	// T0 corners 3, 5, 5 -> mids 01 = 4, 12 = 5, 20 = 4; T1 corners 5, 6, 5 -> mids 5.5, 5.5, 5
	same(d.coef, [3, 5, 5, 4, 5, 4, 5, 6, 5, 5.5, 5.5, 5]);
	// P2 reproduces the linear interpolant: centroid value = mean of the corners
	assert.ok(Math.abs(evalCoef(d.coef, 1, false, 0, 1 / 3, 1 / 3, 1 / 3) - 13 / 3) < 1e-14);
	const p1 = smoothCoefficients(m, { space: 'H1P1', data: [1, 2, 3, 4], components: 1 }, 0);
	same(p1.coef, [1, 2, 3, 1.5, 2.5, 2, 2, 4, 3, 3, 3.5, 2.5]);
	const nodes6 = [...TWO, 1, 0, 1, 0.5, 0, 0.5, 3, 0.5, 2, 1];
	const m6 = mesh(nodes6, [0, 1, 2, 4, 5, 6, 1, 3, 2, 7, 8, 5], [0, 0], 'tri6');
	const p2 = smoothCoefficients(m6, { space: 'H1P2', data: [0, 1, 2, 3, 4, 5, 6, 7, 8], components: 1 }, 0);
	same(p2.coef, [0, 1, 2, 4, 5, 6, 1, 3, 2, 7, 8, 5]);
	// magnitude of a 2-vector: both components kept, mag = true; |(3, 4)| = 5 at a corner
	const v = smoothCoefficients(m, dg0([3, 4, 3, 4], 2), -1);
	assert.equal(v.nc, 2);
	assert.equal(v.mag, true);
	assert.ok(Math.abs(evalCoef(v.coef, 2, true, 0, 1, 0, 0) - 5) < 1e-14);
});
