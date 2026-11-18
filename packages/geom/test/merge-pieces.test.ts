// SPDX-License-Identifier: GPL-3.0-or-later
// 2D keepTools differences with curved tools (DevLog-044 O1, DevLog-055 s.1.2 item 1): the tool edge must not stay
// as its 1-degree arrangement pieces; geometries without such pieces are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeometry2D, domainAreas, mergeEdgePieces, type Feature, type Geometry2D } from '../src/index.ts';

const keepCircle = (keepTools: boolean): Feature[] => [
  { id: 'cell', type: 'rect', x: [-50e-6, 50e-6], y: [-50e-6, 50e-6] },
  { id: 'via', type: 'circle', c: [0, 0], r: 10e-6 },
  { id: 'si', type: 'difference', target: 'cell', tools: ['via'], keepTools },
];
const table = (g: Geometry2D) => JSON.stringify(g.entities);
const edgesOf = (g: Geometry2D, id: string) => {
  const b = g.entities.boundaries.findIndex((e) => e.id === id);
  return g.edges.filter((e) => e.boundary === b);
};

test('keepTools circle tool: arcs merged (no 1-degree pieces), entities and areas unchanged', () => {
  const raw = buildGeometry2D({ features: keepCircle(true) }, { mergeCurvePieces: false });
  const g = buildGeometry2D({ features: keepCircle(true) });
  const plain = buildGeometry2D({ features: keepCircle(false) });
  assert.ok(raw.edges.length > 100, `unmerged geometry keeps the arrangement pieces (${raw.edges.length} edges)`);
  assert.ok(g.edges.length <= plain.edges.length + 2, `${g.edges.length} edges (without keepTools ${plain.edges.length})`);
  assert.equal(table(g), table(raw));
  const via = edgesOf(g, 'bnd:via.edge');
  assert.ok(via.length >= 2 && via.length <= 4, `${via.length} arcs on the tool circle`);
  // every arc spans at most a half turn, and the arcs cover the circle once
  let span = 0;
  for (const e of via) {
    assert.equal(e.curve.kind, 'arc');
    if (e.curve.kind === 'arc') { assert.ok(Math.abs(e.curve.a1 - e.curve.a0) <= Math.PI * (1 + 1e-12)); span += Math.abs(e.curve.a1 - e.curve.a0); }
  }
  assert.ok(Math.abs(span - 2 * Math.PI) <= 1e-12, `arc span ${span}`);
  const A = domainAreas(g), B = domainAreas(raw);
  A.forEach((a, i) => assert.ok(Math.abs(a - B[i]!) <= 1e-12 * Math.abs(B[i]!), `domain ${i}: ${a} vs ${B[i]}`));
  // every edge end is a vertex of the geometry and every vertex is used
  const used = new Uint8Array(g.vertices.length / 2);
  for (const e of g.edges) { used[e.v0] = 1; used[e.v1] = 1; }
  for (const p of g.pointVertex) used[p] = 1;
  assert.ok(used.every((u) => u === 1));
});

test('geometries without curved pieces are returned as built (same object, same vertex numbering)', () => {
  const f: Feature[] = [
    { id: 'air_box', type: 'rect', x: [0, 1], y: [-1, 1] },
    { id: 'coil', type: 'rect', x: [0.4, 0.5], y: [-0.05, 0.05] },
    { id: 'air', type: 'difference', target: 'air_box', tools: ['coil'], keepTools: true },
    { id: 'a', type: 'rect', x: [2, 4], y: [0, 1] },
    { id: 'b', type: 'rect', x: [3, 5], y: [0, 1] },
    { id: 'u', type: 'union', inputs: ['a', 'b'] },
  ];
  const raw = buildGeometry2D({ features: f }, { mergeCurvePieces: false });
  const g = buildGeometry2D({ features: f });
  assert.deepEqual(Array.from(g.vertices), Array.from(raw.vertices));
  assert.deepEqual(g.edges, raw.edges);
  assert.equal(mergeEdgePieces(raw, { curvesOnly: true, stable: true }), raw);
});

test('curvesOnly keeps collinear line pieces; a named point vertex is never merged through (stable)', () => {
  const g = buildGeometry2D({ features: keepCircle(true) }, { mergeCurvePieces: false });
  const lines = g.edges.filter((e) => e.curve.kind === 'line').length;
  const m = mergeEdgePieces(g, { curvesOnly: true, stable: true });
  assert.equal(m.edges.filter((e) => e.curve.kind === 'line').length, lines);
  for (const p of m.pointVertex) assert.ok(p >= 0 && p < m.vertices.length / 2);
  // the stack path (default options) still merges everything it did before
  const d = mergeEdgePieces(g);
  assert.ok(d.edges.length <= m.edges.length);
});
