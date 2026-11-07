// SPDX-License-Identifier: GPL-3.0-or-later
// Shared-edge names (DevLog-036 G1): an electrode hole on a layer is selectable by its own bottom edge name and by the
// layer's top edge name; tool edges in free space leave no name on unrelated edges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeometry2D, resolveEntityIds, type Feature } from '../src/index.ts';

const res = (g: ReturnType<typeof buildGeometry2D>, id: string) => resolveEntityIds(g.entities, 'boundaries', [id]);

test('G1 electrode hole on a layer: bnd:sig.bottom and bnd:slab.top both resolve to the shared piece', () => {
  const feats: Feature[] = [
    { id: 'slab', type: 'rect', x: [-10, 10], y: [0, 1] },
    { id: 'sig', type: 'rect', x: [-2, 2], y: [1, 2] },
    { id: 'top', type: 'rect', x: [-10, 10], y: [1, 10] },
    { id: 'air', type: 'difference', target: 'top', tools: ['sig'] },
    { id: 'frag', type: 'fragment', inputs: ['slab', 'air'] },
  ];
  const g = buildGeometry2D({ features: feats });
  const r = res(g, 'bnd:sig.bottom');
  assert.deepEqual(r.unknown, []);
  assert.equal(r.indices.length, 1);
  const shared = g.entities.boundaries[r.indices[0]!]!;
  assert.match(shared.id, /^bnd:slab\.top#\d$/);
  assert.ok(res(g, 'bnd:slab.top').indices.includes(r.indices[0]!));
  // the shared piece spans exactly the electrode bottom x in [-2, 2] at y = 1
  const es = g.edges.filter((e) => e.boundary === r.indices[0]);
  const xs = es.flatMap((e) => [g.vertices[2 * e.v0]!, g.vertices[2 * e.v1]!]).sort((a, b) => a - b);
  assert.deepEqual([xs[0], xs[xs.length - 1]], [-2, 2]);
  // all four electrode edges select the closed electrode outline
  assert.equal(resolveEntityIds(g.entities, 'boundaries', ['bnd:sig.left', 'bnd:sig.top', 'bnd:sig.right', 'bnd:sig.bottom']).indices.length, 4);
});

test('G1 tool edges in free space (not on the target boundary) add no parent', () => {
  // quarter disk by two cut rects; the cut rect edge outside the disk lies on the later cell edge
  const g = buildGeometry2D({ features: [
    { id: 'cell', type: 'rect', x: [0, 0.5], y: [0, 0.5] },
    { id: 'disk', type: 'circle', c: [0, 0], r: 0.2 },
    { id: 'cutx', type: 'rect', x: [-1, 0], y: [-0.5, 0.5] },
    { id: 'cuty', type: 'rect', x: [-1, 1], y: [-1, 0] },
    { id: 'rod', type: 'difference', target: 'disk', tools: ['cutx', 'cuty'] },
    { id: 'bg', type: 'difference', target: 'cell', tools: ['rod'], keepTools: true },
  ] });
  const ids = res(g, 'bnd:cutx.right').indices.map((i) => g.entities.boundaries[i]!.id);
  assert.ok(!ids.some((x) => x.startsWith('bnd:cell.')), ids.join(', '));
});
