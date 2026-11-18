// SPDX-License-Identifier: GPL-3.0-or-later
// DG0 corner recovery for 1D / point sampling (DevLog-055 s.1.2 item 2): the rule of the 2D view, so a cut line of a
// per-cell field is not a staircase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMesh, rectTriMesh, nCells, nNodes } from '@amp/physics/common/mesh';
import type { FieldData, Mesh, Solution } from '@amp/spec/types';
import { attachMesh, cutLine, evaluateExpr, interpolate, linePoints, locatePoints, recoverDG0, sample } from '../src/index.ts';

/** DG0 field of the cell-centroid values of f (the cell mean for a linear f on straight cells). */
function centroidField(m: Mesh, f: (x: number[]) => number, name = 'd'): FieldData {
  const k = m.cells.type === 'tri6' ? 6 : m.cells.type === 'tet10' ? 10 : m.cells.conn.length / nCells(m);
  const nk = m.cells.type === 'tri3' || m.cells.type === 'tri6' ? 3 : m.cells.type === 'tet4' || m.cells.type === 'tet10' ? 4 : k;
  const data = new Float64Array(nCells(m));
  for (let c = 0; c < data.length; c++) {
    const x = new Array<number>(m.dim).fill(0);
    for (let a = 0; a < nk; a++) for (let d = 0; d < m.dim; d++) x[d]! += m.nodes[m.dim * m.cells.conn[k * c + a]! + d]! / nk;
    data[c] = f(x);
  }
  return { name, unit: '1', space: 'DG0', components: 1, data };
}
const solOf = (m: Mesh, fields: FieldData[]): Solution => {
  const sol = { meshHash: m.hash, fields, scalars: {}, stats: { dof: nNodes(m), solver: 'none' }, timing: {},
    run: { engine: 'test', specHash: '0'.repeat(64), meshHash: m.hash, startedAt: '2026-11-18T00:00:00.000-08:00', platform: { runtime: 'node' }, fidelity: 'rigorous' } } as Solution;
  attachMesh(sol, m);
  return sol;
};
const lin = ([x, y]: number[]) => 1 + 2 * x! - y!;

test('recoverDG0: a linear field is recovered exactly at interior nodes (tri3 and tri6), cut line without staircase', () => {
  for (const order of [1, 2] as const) {
    const m = rectTriMesh({ x: [0, 1], y: [0, 1], nx: 8, ny: 8, order });
    const d = centroidField(m, lin);
    const sol = solOf(m, [d]);
    // points inside cells whose corners are all interior nodes (x, y in [1/8, 7/8])
    const L = linePoints([0.13, 0.4], [0.87, 0.6], 400);
    const raw = sample(sol, 'd', L.points);
    const sm = sample(sol, 'd', L.points, { smooth: true });
    let worst = 0, jumpRaw = 0, jumpSm = 0;
    for (let i = 0; i < L.s.length; i++) {
      worst = Math.max(worst, Math.abs(sm[i]! - lin([L.points[2 * i]!, L.points[2 * i + 1]!])));
      if (i) { jumpRaw = Math.max(jumpRaw, Math.abs(raw[i]! - raw[i - 1]!)); jumpSm = Math.max(jumpSm, Math.abs(sm[i]! - sm[i - 1]!)); }
    }
    assert.ok(worst <= 1e-12, `order ${order}: max error ${worst}`);
    // step of the exact line values: |grad f . dp| = |2 * 0.74 - 0.2| / 399
    const step = Math.abs(2 * 0.74 - 0.2) / 399;
    assert.ok(jumpSm <= step * (1 + 1e-9), `smooth step ${jumpSm} vs ${step}`);
    assert.ok(jumpRaw > 10 * step, `raw cell values jump ${jumpRaw} (staircase)`);
  }
});

test('recoverDG0: jumps kept across domain interfaces, values bounded by the cell values', () => {
  const m = rectTriMesh({ x: [0, 1], y: [0, 1], nx: 6, ny: 4, order: 1 });
  const dom = Int32Array.from(m.cells.domain);
  const cent = centroidField(m, ([x]) => x!);
  for (let c = 0; c < dom.length; c++) dom[c] = cent.data[c]! < 0.5 ? 0 : 1;
  const m2: Mesh = { ...m, cells: { ...m.cells, domain: dom } };
  const step: FieldData = { name: 's', unit: '1', space: 'DG0', components: 1, data: Float64Array.from(dom, (g) => (g === 0 ? 2 : 5)) };
  const ps = locatePoints(m2, [0.5 - 1e-9, 0.3, 0.5 + 1e-9, 0.3, 0.25, 0.77, 0.9, 0.1]);
  const v = interpolate(step, ps, { smooth: true }).values;
  assert.deepEqual(Array.from(v), [2, 5, 2, 5]);
  // pseudo-random cell values: corner values within [min, max]
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const r: FieldData = { name: 'r', unit: '1', space: 'DG0', components: 2, data: Float64Array.from({ length: 2 * dom.length }, () => rnd() * 10 - 3) };
  const cr = recoverDG0(m2, r);
  for (let j = 0; j < 2; j++) {
    const vals = Array.from({ length: dom.length }, (_, c) => r.data[2 * c + j]!);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    for (let q = j; q < cr.length; q += 2) assert.ok(cr[q]! >= lo - 1e-12 && cr[q]! <= hi + 1e-12);
  }
  assert.equal(recoverDG0(m2, r), cr, 'cached per field and mesh');
});

test('smooth expressions and 3D: tet4 linear field exact at an interior point, continuous flag, default unchanged', () => {
  const t = boxMesh({ x: [0, 1], y: [0, 1], z: [0, 1], nx: 4, ny: 4, nz: 4, cell: 'tet4' });
  const f3 = ([x, y, z]: number[]) => 1 + x! + 2 * y! - 3 * z!;
  const d = centroidField(t, f3, 'q');
  const sol = solOf(t, [d]);
  const P = [0.5, 0.5, 0.5];
  const sm = evaluateExpr(sol, 'q', [P], { smooth: true });
  const raw = evaluateExpr(sol, 'q', [P]);
  assert.equal(sm.continuous, true);
  assert.equal(raw.continuous, false);
  // the interior node (0.5, 0.5, 0.5) is surrounded by a point-symmetric patch in this tet split: recovery is exact there
  assert.ok(Math.abs(sm.values[0]! - f3(P)) <= 1e-12, `${sm.values[0]} vs ${f3(P)}`);
  // cut line through the smooth path matches sample()
  const cl = cutLine(t, [0.3, 0.4, 0.45], [0.7, 0.6, 0.55], { n: 50 });
  const a = evaluateExpr(sol, 'q', cl.points, { smooth: true }).values;
  const b = sample(sol, 'q', cl.points.x, { smooth: true });
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i]! - b[i]!) <= 1e-14);
  assert.throws(() => evaluateExpr(sol, 'd(q, x)', [P], { smooth: true }), /DG0/);
});
