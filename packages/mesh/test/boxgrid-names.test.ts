// SPDX-License-Identifier: GPL-3.0-or-later
// Box-grid face names (DevLog-036 G2): a min-side face split into an exterior remainder and interfaces owned by the
// neighbours numbers its pieces (exterior first); the plain face id still selects every piece, `#1` the exterior only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntityIds } from '@amp/geom';
import { meshBoxes } from '../src/index.ts';

test('G2 exterior remainder of a min-side face is selectable alone', () => {
  // two arms (a, b) end on the xmin face of a connector c; the gap between the arms is exterior
  const m = meshBoxes([
    { id: 'a', x: [0, 2], y: [0, 1], z: [0, 1] },
    { id: 'b', x: [0, 2], y: [2, 3], z: [0, 1] },
    { id: 'c', x: [2, 3], y: [0, 3], z: [0, 1] },
  ], { h: 0.25 });
  const nf = (ids: string[]) => { const on = new Set(resolveEntityIds(m.entities, 'boundaries', ids).indices); return m.facets.boundary.filter((b) => on.has(b)).length; };
  const all = resolveEntityIds(m.entities, 'boundaries', ['bnd:c.xmin']).expansion['bnd:c.xmin']!;
  assert.deepEqual(all.sort(), ['bnd:a.xmax', 'bnd:b.xmax', 'bnd:c.xmin#1'].sort());
  assert.deepEqual(resolveEntityIds(m.entities, 'boundaries', ['bnd:c.xmin#1']).expansion['bnd:c.xmin#1'], ['bnd:c.xmin#1']);
  // c.xmin is 3 x 1 (48 quads of 0.25 x 0.25), the gap between the arms 1 x 1 (16 quads)
  assert.equal(nf(['bnd:c.xmin']), 48);
  assert.equal(nf(['bnd:c.xmin#1']), 16);
  assert.equal(nf(['bnd:a.xmax']), 16);
  const a = m.entities.boundaries.find((b) => b.id === 'bnd:a.xmax')!, b = m.entities.boundaries.find((x) => x.id === 'bnd:b.xmax')!;
  assert.deepEqual([a.parent, b.parent], [['bnd:c.xmin#2'], ['bnd:c.xmin#3']]);
});
