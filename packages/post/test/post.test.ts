// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMesh, rectTriMesh, nNodes, nCells } from '@amp/physics/common/mesh';
import type { FieldData, Solution } from '@amp/spec/types';
import { evaluateField, integrate, extrema, sample, attachMesh, toCsv, linePoints, gridPoints, SolutionStore, refine } from '../src/index.ts';

const nodal = (m: { nodes: Float64Array; dim: number }, f: (x: number[]) => number, space: 'H1P1' | 'H1P2' = 'H1P2'): FieldData => ({
  name: 'f', unit: '1', space, components: 1,
  data: Float64Array.from({ length: m.nodes.length / m.dim }, (_, i) => f(Array.from(m.nodes.subarray(m.dim * i, m.dim * i + m.dim)))),
});

test('integrate 1 over a 1 m x 1 m square (SI metres) = 1 m^2; and over a revolved rectangle', () => {
  const m = rectTriMesh({ x: [0, 1], y: [0, 1], nx: 3, ny: 3, order: 2 });
  const one = nodal(m, () => 1);
  assert.ok(Math.abs(integrate(m, one)[0]! - 1) < 1e-14);
  const ma = rectTriMesh({ x: [1, 2], y: [0, 1], nx: 2, ny: 2, order: 2, axisym: true });
  assert.ok(Math.abs(integrate(ma, nodal(ma, () => 1), { revolve: true })[0]! - Math.PI * 3) < 1e-12);
});

test('evaluate P2 quadratic exactly at random points, with gradient; NaN outside', () => {
  const m = rectTriMesh({ x: [0, 2], y: [0, 1], nx: 5, ny: 3, order: 2 });
  const f = nodal(m, ([x, y]) => 1 + 2 * x! - y! + x! * y! + 0.5 * x! * x!);
  const pts = [0.3, 0.7, 1.99, 0.01, 1.234, 0.5, 3, 0.5];
  const r = evaluateField(m, f, pts, { grad: true });
  for (let i = 0; i < 3; i++) {
    const x = pts[2 * i]!, y = pts[2 * i + 1]!;
    assert.ok(Math.abs(r.values[i]! - (1 + 2 * x - y + x * y + 0.5 * x * x)) < 1e-12);
    assert.ok(Math.abs(r.grad![2 * i]! - (2 + y + x)) < 1e-11);
    assert.ok(Math.abs(r.grad![2 * i + 1]! - (-1 + x)) < 1e-11);
  }
  assert.ok(Number.isNaN(r.values[3]!));
});

test('evaluate on tet10 and hex8; extrema; DG0', () => {
  const t = boxMesh({ x: [0, 1], y: [0, 1], z: [0, 1], nx: 2, ny: 2, nz: 2, cell: 'tet10' });
  const f = nodal(t, ([x, y, z]) => x! * y! + z! * z!);
  const v = evaluateField(t, f, [0.31, 0.72, 0.43]).values[0]!;
  assert.ok(Math.abs(v - (0.31 * 0.72 + 0.43 * 0.43)) < 1e-12);
  const h = boxMesh({ x: [0, 1], y: [0, 2], z: [0, 1], nx: 2, ny: 3, nz: 2, cell: 'hex8' });
  const g = nodal(h, ([x, y, z]) => 1 + x! + 2 * y! - z!, 'H1P1');
  assert.ok(Math.abs(evaluateField(h, g, [0.37, 1.11, 0.66]).values[0]! - (1 + 0.37 + 2.22 - 0.66)) < 1e-12);
  const e = extrema(h, g);
  assert.equal(e.max, 1 + 1 + 4); assert.deepEqual(e.argmax, [1, 2, 0]);
  const d: FieldData = { name: 'd', unit: '1', space: 'DG0', components: 1, data: Float64Array.from({ length: nCells(h) }, (_, c) => c) };
  assert.ok(Number.isFinite(evaluateField(h, d, [0.1, 0.1, 0.1]).values[0]!));
});

test('sample() on an attached solution, store, CSV, line and grid points, refine port', () => {
  const m = rectTriMesh({ x: [0, 1], y: [0, 1], nx: 2, ny: 2, order: 1 });
  const sol = { meshHash: m.hash, fields: [{ ...nodal(m, ([x]) => x!, 'H1P1'), name: 'T', unit: 'K' }], scalars: {}, stats: { dof: nNodes(m), solver: 'none' }, timing: {},
    run: { engine: 'test', specHash: '0'.repeat(64), meshHash: m.hash, startedAt: '2026-11-06T00:00:00.000-08:00', platform: { runtime: 'node' }, fidelity: 'rigorous' } } as Solution;
  attachMesh(sol, m);
  const L = linePoints([0, 0.5], [1, 0.5], 5);
  const v = sample(sol, 'T', L.points);
  assert.deepEqual(Array.from(v), [0, 0.25, 0.5, 0.75, 1]);
  const st = new SolutionStore(); st.put('r1', sol, m);
  assert.equal(st.field('r1', 'T').unit, 'K');
  const csv = toCsv([{ name: 's', unit: 'm', values: L.s }, { name: 'T', unit: 'K', values: v }]);
  assert.equal(csv.split('\n')[0], 's [m],T [K]');
  assert.equal(gridPoints([0, 1], [0, 1], 3, 2).length, 12);
  assert.equal(refine.refinePattern(3).np, 10);
});
