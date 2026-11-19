// SPDX-License-Identifier: GPL-3.0-or-later
// 2D display of derived fields with element values (post/field2d.ts withPerDomain, DevLog-059): the local recovery
// equals @amp/post recoverPerDomain; values near a material interface are the side's own; without an interface the
// field is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectTriMesh, nCells, nNodes, NPC } from '@amp/physics/common/mesh';
import type { FieldData, Mesh } from '@amp/spec/types';
import { recoverPerDomain } from '@amp/post';
import { Locator, evalElement, smoothCoefficients, evalCoef, toMesh2D, withPerDomain, type Field2D } from '../src/lib/post/field2d.ts';
import { probe2d } from '../src/lib/post/probe.ts';
import type { PostClient } from '../src/lib/post/client.ts';

type Fn = (x: number, y: number) => number;
const left: Fn = (x, y) => 1 + 2 * x - y, right: Fn = (x, y) => 5 - x + 3 * y;

function split(m: Mesh, xs: number): Mesh {
	const k = NPC[m.cells.type], nc = nCells(m), domain = new Int32Array(nc);
	for (let c = 0; c < nc; c++) { let x = 0; for (let a = 0; a < k; a++) x += m.nodes[2 * m.cells.conn[k * c + a]!]! / k; domain[c] = x < xs ? 0 : 1; }
	return { ...m, hash: `${m.hash}-2dom`, cells: { ...m.cells, domain } };
}

/** element values = the domain's function at each node; data = count-weighted nodal mean across domains */
function derived(m: Mesh, fs: Fn[]): FieldData & { elementNodal: Float64Array } {
	const k = NPC[m.cells.type], nc = nCells(m), nn = nNodes(m);
	const el = new Float64Array(nc * k), acc = new Float64Array(nn), cnt = new Float64Array(nn);
	for (let c = 0; c < nc; c++)
		for (let a = 0; a < k; a++) {
			const v = m.cells.conn[k * c + a]!, val = fs[m.cells.domain[c]!]!(m.nodes[2 * v]!, m.nodes[2 * v + 1]!);
			el[k * c + a] = val; acc[v]! += val; cnt[v]!++;
		}
	for (let v = 0; v < nn; v++) acc[v]! /= cnt[v]!;
	return { name: 's', unit: 'Pa', space: 'H1P2', components: 1, data: acc, elementNodal: el };
}

test('withPerDomain equals @amp/post recoverPerDomain; points next to the interface read their side', () => {
	const m = split(rectTriMesh({ x: [0, 1], y: [0, 1], nx: 6, ny: 4, order: 2 }), 0.5);
	const f = derived(m, [left, right]), m2 = toMesh2D(m);
	const fd: Field2D = { space: 'H1P2', data: f.data, components: 1, elementNodal: f.elementNodal };
	const w = withPerDomain(m2, fd);
	assert.ok(w.perCell, 'per-domain values present');
	assert.deepEqual(Array.from(w.perCell!), Array.from(recoverPerDomain(m, f)!));
	// an element of each side touching the interface: evaluate at its centroid and at a point on the interface edge
	let tl = -1, tr = -1;
	for (let t = 0; t < m2.nT; t++) {
		const xs = [0, 1, 2].map((a) => m2.nodes[2 * m2.conn[6 * t + a]!]!);
		if (xs.some((x) => Math.abs(x - 0.5) < 1e-12)) { if (m2.domain[t] === 0 && tl < 0) tl = t; if (m2.domain[t] === 1 && tr < 0) tr = t; }
	}
	for (const [t, fn] of [[tl, left], [tr, right]] as const) {
		const L = [1 / 3, 1 / 3, 1 / 3];
		const x = L.reduce((s, l, a) => s + l * m2.nodes[2 * m2.conn[6 * t + a]!]!, 0), y = L.reduce((s, l, a) => s + l * m2.nodes[2 * m2.conn[6 * t + a]! + 1]!, 0);
		const v = evalElement(m2, w, t, L[0]!, L[1]!, L[2]!, 0);
		assert.ok(Math.abs(v - fn(x, y)) < 1e-12, `element ${t}: ${v} vs ${fn(x, y)}`);
		assert.ok(Math.abs(evalElement(m2, fd, t, L[0]!, L[1]!, L[2]!, 0) - fn(x, y)) > 1e-3, 'the nodal mean mixes the sides');
		const sc = smoothCoefficients(m2, w, 0);
		assert.ok(Math.abs(evalCoef(sc.coef, sc.nc, sc.mag, t, L[0]!, L[1]!, L[2]!) - fn(x, y)) < 1e-12);
	}
});

test('withPerDomain: no element values, DG0 or a single domain leave the field unchanged', () => {
	const m = rectTriMesh({ x: [0, 1], y: [0, 1], nx: 4, ny: 3, order: 2 }), m2 = toMesh2D(m);
	const f = derived(m, [left]);
	const a: Field2D = { space: 'H1P2', data: f.data, components: 1, elementNodal: f.elementNodal };
	assert.equal(withPerDomain(m2, a), a);
	const b: Field2D = { space: 'H1P2', data: f.data, components: 1 };
	assert.equal(withPerDomain(m2, b), b);
});

test('probe2d: a click next to the interface gives the clicked side (element values sent to the worker)', async () => {
	const m = split(rectTriMesh({ x: [0, 1], y: [0, 1], nx: 6, ny: 4, order: 2 }), 0.5);
	const f = derived(m, [left, right]), m2 = toMesh2D(m), loc = new Locator(m2);
	// the worker's evalAt path (post.worker.ts): withPerDomain, then the FE basis of the located element
	const post = { call: async (q: { field: Field2D; comp: number; points: number[] }) => {
		const ef = withPerDomain(m2, q.field), h = loc.locate(q.points[0]!, q.points[1]!);
		return { values: [h ? evalElement(m2, ef, h.t, h.L[0], h.L[1], h.L[2], q.comp) : null] };
	} } as unknown as PostClient;
	for (const [x, y, fn] of [[0.5 - 1e-9, 0.37, left], [0.5 + 1e-9, 0.37, right]] as const) {
		const v = await probe2d(post, f, 0, x, y);
		assert.ok(v !== null && Math.abs(v - fn(x, y)) < 1e-6, `(${x}, ${y}): ${v} vs ${fn(x, y)}`);
	}
	// without element values: the nodal mean (mixes the sides on the interface)
	const v0 = await probe2d(post, { ...f, elementNodal: undefined } as FieldData, 0, 0.5 - 1e-9, 0.37);
	assert.ok(v0 !== null && Math.abs(v0 - left(0.5, 0.37)) > 1e-3);
});

test('withPerDomain keys on the material group (cellGroup): one group over two domains leaves the field unchanged, as @amp/post', () => {
	const m = split(rectTriMesh({ x: [0, 1], y: [0, 1], nx: 6, ny: 4, order: 2 }), 0.5);
	const f = derived(m, [left, right]), m2 = toMesh2D(m), cellGroup = new Int32Array(m2.nT);
	const fd: Field2D = { space: 'H1P2', data: f.data, components: 1, elementNodal: f.elementNodal, cellGroup };
	assert.equal(withPerDomain(m2, fd), fd);
	assert.equal(recoverPerDomain(m, { ...f, cellGroup }), null);
	// distinct groups equal to the domains give the domain-keyed result
	const byDomain = Int32Array.from(m2.domain);
	const w = withPerDomain(m2, { ...fd, cellGroup: byDomain });
	assert.deepEqual(Array.from(w.perCell!), Array.from(recoverPerDomain(m, f)!));
});
