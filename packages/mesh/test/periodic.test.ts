// SPDX-License-Identifier: GPL-3.0-or-later
// Periodic unit cells (DevLog-050 s.1.3, gate G-M1): the mesher puts the same nodes on both sides of each periodic
// pair (rectangular and parallelogram cells, P1 and P2, nested refinement), deterministically; pairPeriodicNodes pairs
// them and rejects meshes whose sides differ, and the side split rejects non-parallel or unequal sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeometry2D, type Feature, type Mesh } from '@amp/geom';
import { mesh2d, refineUniform, pairPeriodicNodes, periodicSides } from '../src/index.ts';

const facetsOf = (m: Mesh, ids: string[]) => {
  const want = new Set(ids.map((id) => m.entities.boundaries.findIndex((b) => b.id === `bnd:${id}`)));
  const out: number[] = [];
  m.facets.boundary.forEach((b, f) => { if (want.has(b)) out.push(f); });
  return out;
};

// unit cell with an off-centre rod near the left side and a fine refinement there: the size field is not symmetric
const cell: Feature[] = [
  { id: 'cell', type: 'rect', x: [0, 1], y: [0, 1] },
  { id: 'rod', type: 'circle', c: [0.22, 0.61], r: 0.15 },
  { id: 'bg', type: 'difference', target: 'cell', tools: ['rod'], keepTools: true },
];
const PX = { id: 'px', select: ['bnd:cell.left', 'bnd:cell.right'] }, PY = { id: 'py', select: ['bnd:cell.bottom', 'bnd:cell.top'] };
const opts = { hmax: 0.1, refine: [{ select: ['bnd:rod.edge'], h: 0.012 }] };

test('without the periodic option the sides of this cell differ (the case the option exists for)', () => {
  const m = mesh2d(buildGeometry2D({ features: cell }), opts);
  assert.throws(() => pairPeriodicNodes(m, facetsOf(m, ['cell.left', 'cell.right']), "periodic condition 'px'"), /has no partner at .* on the opposite side/);
});

test('rectangular cell: x and y pairs match at order 1 and 2, after nested refinement, deterministic', () => {
  const g = buildGeometry2D({ features: cell });
  for (const order of [1, 2] as const) {
    const m = mesh2d(g, { ...opts, order, periodic: [PX, PY] });
    const m2 = mesh2d(buildGeometry2D({ features: cell }), { ...opts, order, periodic: [PX, PY] });
    assert.equal(m.hash, m2.hash);
    assert.equal(m.tagHash, m2.tagHash);
    for (const mm of [m, refineUniform(m, { geometry: g })]) {
      const px = pairPeriodicNodes(mm, facetsOf(mm, ['cell.left', 'cell.right']));
      const py = pairPeriodicNodes(mm, facetsOf(mm, ['cell.bottom', 'cell.top']));
      assert.deepEqual(px.d.map((v) => Math.round(v * 1e12) / 1e12 + 0), [1, 0]);
      assert.deepEqual(py.d.map((v) => Math.round(v * 1e12) / 1e12 + 0), [0, 1]);
      assert.ok(px.a.length > 10 && py.a.length > 10);
      for (let i = 0; i < px.a.length; i++) assert.ok(Math.abs(mm.nodes[2 * px.a[i]!]! + 1 - mm.nodes[2 * px.b[i]!]!) < 1e-12 && Math.abs(mm.nodes[2 * px.a[i]! + 1]! - mm.nodes[2 * px.b[i]! + 1]!) < 1e-12);
    }
  }
});

test('parallelogram cell (tangential offset): both pairs match', () => {
  const pg: Feature[] = [
    { id: 'p', type: 'polygon', points: [[0, 0], [1, 0], [1.5, 0.9], [0.5, 0.9]] },
    { id: 'rod', type: 'circle', c: [0.62, 0.3], r: 0.12 },
    { id: 'bg', type: 'difference', target: 'p', tools: ['rod'], keepTools: true },
  ];
  const m = mesh2d(buildGeometry2D({ features: pg }), { hmax: 0.08, refine: [{ select: ['bnd:rod.edge'], h: 0.01 }], order: 2, periodic: [{ id: 'a1', select: ['bnd:p.e0', 'bnd:p.e2'] }, { id: 'a2', select: ['bnd:p.e1', 'bnd:p.e3'] }] });
  const a1 = pairPeriodicNodes(m, facetsOf(m, ['p.e0', 'p.e2']));
  const a2 = pairPeriodicNodes(m, facetsOf(m, ['p.e1', 'p.e3']));
  assert.ok(Math.abs(a1.d[0] - 0.5) < 1e-12 && Math.abs(a1.d[1] - 0.9) < 1e-12, `a1 ${a1.d}`);
  assert.ok(Math.abs(a2.d[0] - 1) < 1e-12 && Math.abs(a2.d[1]) < 1e-12, `a2 ${a2.d}`);
});

test('side split errors: three lines, non-parallel, unequal lengths', () => {
  assert.throws(() => periodicSides([0, 0, 0, 1, 1, 0, 1, 1, 2, 0, 2, 1], 'p'), /lie on 3 parallel lines/);
  assert.throws(() => periodicSides([0, 0, 0, 1, 1, 0, 1.2, 1], 'p'), /not parallel/);
  assert.throws(() => periodicSides([0, 0, 0, 1, 1, 0, 1, 1.5], 'p'), /different lengths/);
  assert.throws(() => mesh2d(buildGeometry2D({ features: cell }), { hmax: 0.2, periodic: [{ id: 'bad', select: ['bnd:cell.left', 'bnd:cell.top'] }] }), /periodic condition 'bad': .*not parallel/);
  assert.throws(() => mesh2d(buildGeometry2D({ features: cell }), { hmax: 0.2, periodic: [{ id: 'curved', select: ['bnd:rod.edge', 'bnd:cell.left'] }] }), /curved/);
});
