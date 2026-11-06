// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeometry2D, domainAreas, resolveSelection, extrudeLayered, revolve, boundarySides,
  type Feature, type Geometry2D,
} from '../src/index.ts';

const ids = (g: Geometry2D) => ({
  domains: g.entities.domains.map((e) => e.id),
  boundaries: g.entities.boundaries.map((e) => e.id),
  points: (g.entities.points ?? []).map((e) => e.id),
});
/** boundary id -> [left domain id, right domain id] (orientation-free, sorted) */
const adjacency = (g: Geometry2D) => {
  const s = boundarySides(g);
  const name = (d: number) => (d < 0 ? '-' : g.entities.domains[d]!.id);
  return Object.fromEntries(g.entities.boundaries.map((b, i) => [b.id, [name(s[i]![0]), name(s[i]![1])].sort()]));
};
const area = (g: Geometry2D, id: string) => domainAreas(g)[g.entities.domains.findIndex((d) => d.id === id)]!;
const close = (a: number, b: number, rel: number) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${a} vs ${b}`);

const plateHole = (r: number, w = 0.1): Feature[] => [
  { id: 'quarter', type: 'rect', x: [0, w], y: [0, 0.05] },
  { id: 'hole', type: 'circle', c: [0, 0], r },
  { id: 'plate', type: 'difference', target: 'quarter', tools: ['hole'] },
];

test('rect primitive: entity table', () => {
  const g = buildGeometry2D({ features: [{ id: 'r', type: 'rect', x: [0, 2], y: [0, 1] }] });
  assert.deepEqual(ids(g), {
    domains: ['dom:r'], boundaries: ['bnd:r.bottom', 'bnd:r.right', 'bnd:r.top', 'bnd:r.left'],
    points: ['pnt:r.p0', 'pnt:r.p1', 'pnt:r.p2', 'pnt:r.p3'],
  });
  close(area(g, 'dom:r'), 2, 1e-14);
});

test('circle, ellipse and polygon areas (polygon given clockwise)', () => {
  const c = buildGeometry2D({ features: [{ id: 'c', type: 'circle', c: [1, 2], r: 0.3 }] });
  assert.deepEqual(ids(c).boundaries, ['bnd:c.edge']);
  close(area(c, 'dom:c'), Math.PI * 0.09, 1e-12);
  const e = buildGeometry2D({ features: [{ id: 'e', type: 'ellipse', c: [0, 0], rx: 2, ry: 0.5, rot: 0.3 }] });
  close(area(e, 'dom:e'), Math.PI, 1e-10);
  const p = buildGeometry2D({ features: [{ id: 'p', type: 'polygon', points: [[0, 0], [0, 1], [1, 1], [1, 0]] }] });
  close(area(p, 'dom:p'), 1, 1e-14);
  assert.deepEqual(ids(p).boundaries, ['bnd:p.e0', 'bnd:p.e1', 'bnd:p.e2', 'bnd:p.e3']);
});

test('difference: result domain named after the boolean; boundaries keep their creating feature', () => {
  const g = buildGeometry2D({ features: plateHole(0.01) });
  assert.deepEqual(ids(g).domains, ['dom:plate']);
  assert.deepEqual(g.entities.domains[0]!.parent, ['dom:quarter']);
  assert.deepEqual(ids(g).boundaries, ['bnd:quarter.bottom', 'bnd:quarter.right', 'bnd:quarter.top', 'bnd:quarter.left', 'bnd:hole.edge']);
  assert.ok(!ids(g).points.includes('pnt:quarter.p0'), 'corner inside the hole is removed');
  close(area(g, 'dom:plate'), 0.1 * 0.05 - (Math.PI * 1e-4) / 4, 1e-12);
});

test('ID stability: parameter changes that keep topology give identical tables and adjacency', () => {
  const cases: Array<[Feature[], Feature[]]> = [
    [plateHole(0.01), plateHole(0.03, 0.12)],
    [
      [{ id: 'a', type: 'rect', x: [0, 2], y: [0, 1] }, { id: 'c', type: 'circle', c: [1, 1], r: 0.5 }, { id: 'f', type: 'fragment', inputs: ['a', 'c'] }],
      [{ id: 'a', type: 'rect', x: [0, 2.5], y: [0, 1.2] }, { id: 'c', type: 'circle', c: [0.8, 1.1], r: 0.45 }, { id: 'f', type: 'fragment', inputs: ['a', 'c'] }],
    ],
    [
      [{ id: 'bar', type: 'rect', x: [0, 3], y: [0, 1] }, { id: 'c', type: 'circle', c: [1.5, 0.5], r: 0.7 }, { id: 'd', type: 'difference', target: 'bar', tools: ['c'] }],
      [{ id: 'bar', type: 'rect', x: [0, 3], y: [0, 1] }, { id: 'c', type: 'circle', c: [1.2, 0.45], r: 0.6 }, { id: 'd', type: 'difference', target: 'bar', tools: ['c'] }],
    ],
    [
      [{ id: 'base', type: 'rect', x: [0, 3], y: [0, 0.5] }, { id: 'f1', type: 'rect', x: [0.5, 0.7], y: [0.5, 2] }, { id: 'f2', type: 'rect', x: [1.5, 1.7], y: [0.5, 2] }, { id: 'u', type: 'union', inputs: ['base', 'f1', 'f2'] }],
      [{ id: 'base', type: 'rect', x: [0, 3], y: [0, 0.6] }, { id: 'f1', type: 'rect', x: [0.4, 0.9], y: [0.6, 1.5] }, { id: 'f2', type: 'rect', x: [1.2, 2.5], y: [0.6, 2.5] }, { id: 'u', type: 'union', inputs: ['base', 'f1', 'f2'] }],
    ],
    [
      [{ id: 'c1', type: 'circle', c: [0, 0], r: 1 }, { id: 'c2', type: 'circle', c: [1, 0], r: 1 }, { id: 'i', type: 'intersection', inputs: ['c1', 'c2'] }],
      [{ id: 'c1', type: 'circle', c: [0, 0], r: 1.2 }, { id: 'c2', type: 'circle', c: [0.7, 0.3], r: 0.9 }, { id: 'i', type: 'intersection', inputs: ['c1', 'c2'] }],
    ],
  ];
  for (const [fa, fb] of cases) {
    const a = buildGeometry2D({ features: fa }), b = buildGeometry2D({ features: fb });
    assert.deepEqual(ids(a), ids(b));
    assert.deepEqual(adjacency(a), adjacency(b));
  }
});

test('ID change on a topology change is visible (circle no longer splits the bar)', () => {
  const split = buildGeometry2D({ features: [{ id: 'bar', type: 'rect', x: [0, 3], y: [0, 1] }, { id: 'c', type: 'circle', c: [1.5, 0.5], r: 0.7 }, { id: 'd', type: 'difference', target: 'bar', tools: ['c'] }] });
  const hole = buildGeometry2D({ features: [{ id: 'bar', type: 'rect', x: [0, 3], y: [0, 1] }, { id: 'c', type: 'circle', c: [1.5, 0.5], r: 0.4 }, { id: 'd', type: 'difference', target: 'bar', tools: ['c'] }] });
  assert.deepEqual(ids(split).domains, ['dom:d#1', 'dom:d#2']);
  assert.deepEqual(ids(hole).domains, ['dom:d']);
  assert.deepEqual(split.entities.domains[0]!.parent, ['dom:bar']);
  // #k order follows the first boundary contact: piece 1 touches bar.bottom first (the left piece)
  close(area(split, 'dom:d#1'), area(split, 'dom:d#2'), 1e-9);
});

test('fragment: origin-set naming, split edges with parents, areas sum', () => {
  const g = buildGeometry2D({ features: [{ id: 'a', type: 'rect', x: [0, 2], y: [0, 1] }, { id: 'c', type: 'circle', c: [1, 1], r: 0.5 }, { id: 'f', type: 'fragment', inputs: ['a', 'c'] }] });
  assert.deepEqual(ids(g).domains.sort(), ['dom:a', 'dom:a&c', 'dom:c']);
  assert.deepEqual(g.entities.domains.find((d) => d.id === 'dom:a&c')!.parent, ['dom:a', 'dom:c']);
  const half = (Math.PI * 0.25) / 2;
  close(area(g, 'dom:a&c'), half, 1e-12);
  close(area(g, 'dom:c'), half, 1e-12);
  close(area(g, 'dom:a'), 2 - half, 1e-12);
  assert.deepEqual(resolveSelection(g.entities, 'boundaries', ['bnd:a.top']).length, 3);
  assert.deepEqual(resolveSelection(g.entities, 'domains', ['dom:c'], { descendants: true }).map((i) => g.entities.domains[i]!.id).sort(), ['dom:a&c', 'dom:c']);
  assert.deepEqual(resolveSelection(g.entities, 'domains', ['dom:c']).map((i) => g.entities.domains[i]!.id), ['dom:c']);
  assert.throws(() => resolveSelection(g.entities, 'domains', ['dom:nope']), /matches no domain/);
});

test('union and intersection of two circles: areas vs the closed-form lens', () => {
  const r = 1, d = 1;
  const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
  const I = buildGeometry2D({ features: [{ id: 'c1', type: 'circle', c: [0, 0], r }, { id: 'c2', type: 'circle', c: [d, 0], r }, { id: 'i', type: 'intersection', inputs: ['c1', 'c2'] }] });
  assert.deepEqual(ids(I).domains, ['dom:i']);
  close(area(I, 'dom:i'), lens, 1e-12);
  const U = buildGeometry2D({ features: [{ id: 'c1', type: 'circle', c: [0, 0], r }, { id: 'c2', type: 'circle', c: [d, 0], r }, { id: 'u', type: 'union', inputs: ['c1', 'c2'] }] });
  close(area(U, 'dom:u'), 2 * Math.PI - lens, 1e-12);
  assert.equal(U.entities.boundaries.length, 2);
});

test('overlap without a boolean is an error (no painter order)', () => {
  assert.throws(() => buildGeometry2D({ features: [{ id: 'a', type: 'rect', x: [0, 2], y: [0, 1] }, { id: 'b', type: 'rect', x: [1, 3], y: [0, 1] }] }), /overlapping domains/);
});

test('touching objects merge their shared edge into one interface entity', () => {
  const g = buildGeometry2D({ features: [{ id: 'lo', type: 'rect', x: [0, 2], y: [0, 1] }, { id: 'hi', type: 'rect', x: [0.5, 1.5], y: [1, 1.5] }] });
  const shared = g.entities.boundaries.find((b) => b.parent?.includes('bnd:hi.bottom'));
  assert.ok(shared, 'shared edge exists');
  assert.deepEqual(shared!.parent, ['bnd:lo.top', 'bnd:hi.bottom']);
  assert.deepEqual(adjacency(g)[shared!.id], ['dom:hi', 'dom:lo']);
});

test('keepTools difference gives disjoint, touching domains with shared boundaries', () => {
  const g = buildGeometry2D({ axisym: true, features: [{ id: 'air_box', type: 'rect', x: [0, 1], y: [-1, 1] }, { id: 'coil', type: 'rect', x: [0.4, 0.5], y: [-0.05, 0.05] }, { id: 'air', type: 'difference', target: 'air_box', tools: ['coil'], keepTools: true }] });
  assert.deepEqual(ids(g).domains.sort(), ['dom:air', 'dom:coil']);
  assert.deepEqual(adjacency(g)['bnd:coil.top'], ['dom:air', 'dom:coil']);
  assert.deepEqual(g.entities.boundaries.filter((b) => b.axis).map((b) => b.id), ['bnd:air_box.left']);
  close(area(g, 'dom:air') + area(g, 'dom:coil'), 2, 1e-14);
});

test('axisymmetric geometry with r < 0 is rejected', () => {
  assert.throws(() => buildGeometry2D({ axisym: true, features: [{ id: 'a', type: 'rect', x: [-1, 1], y: [0, 1] }] }), /r = -1/);
});

test('polyline and arc: cutting polyline splits a domain; a dangling arc stays embedded', () => {
  const g = buildGeometry2D({ features: [{ id: 'r', type: 'rect', x: [0, 2], y: [0, 1] }, { id: 'pl', type: 'polyline', points: [[1, -0.5], [1, 1.5]] }, { id: 'f', type: 'fragment', inputs: ['r', 'pl'] }] });
  assert.deepEqual(ids(g).domains, ['dom:r#1', 'dom:r#2']);
  assert.ok(ids(g).boundaries.includes('bnd:pl.e0'));
  close(area(g, 'dom:r#1'), 1, 1e-14);
  const h = buildGeometry2D({ features: [{ id: 'r', type: 'rect', x: [0, 2], y: [0, 1] }, { id: 'a', type: 'arc', c: [1, 0.5], r: 0.2, a0: 0, a1: 2 }] });
  assert.deepEqual(ids(h).domains, ['dom:r']);
  const b = h.entities.boundaries.findIndex((e) => e.id === 'bnd:a.e0');
  assert.ok(b >= 0);
  assert.deepEqual(boundarySides(h)[b], [0, 0]);
});

test('extrudeLayered and revolve entity tables', () => {
  const g = buildGeometry2D({ features: [{ id: 'sub0', type: 'rect', x: [0, 2], y: [0, 2] }, { id: 'via', type: 'circle', c: [1, 1], r: 0.3 }, { id: 'sub', type: 'difference', target: 'sub0', tools: ['via'], keepTools: true }] });
  const E = extrudeLayered(g, [{ id: 'L0', z: [0, 1] }, { id: 'L1', z: [1, 1.5], domains: ['via'] }]);
  assert.deepEqual(E.entities.domains.map((d) => d.id).sort(), ['dom:sub@L0', 'dom:via@L0', 'dom:via@L1']);
  const bid = E.entities.boundaries.map((b) => b.id);
  assert.ok(bid.includes('bnd:via@L0.top'), 'shared cap named after the lower layer');
  assert.ok(bid.includes('bnd:via@L1.top') && bid.includes('bnd:sub@L0.top') && bid.includes('bnd:via.edge@L1'));
  assert.ok(!bid.includes('bnd:sub0.left@L1'), 'absent domain gives no side face');
  assert.deepEqual(E.entities.boundaries.find((b) => b.id === 'bnd:via@L0.top')!.parent, ['dom:via', 'bnd:via@L1.bottom']);
  assert.throws(() => extrudeLayered(g, [{ id: 'L0', z: [0, 1] }, { id: 'L1', z: [1.1, 2] }]), /does not start/);
  const m = buildGeometry2D({ axisym: true, features: [{ id: 'core', type: 'rect', x: [0, 1], y: [0, 1] }] });
  const R = revolve(m, 'rev');
  assert.deepEqual(R.entities.boundaries.map((b) => b.id), ['bnd:core.bottom@rev', 'bnd:core.right@rev', 'bnd:core.top@rev']);
  const Rp = revolve(m, 'rev', Math.PI / 2);
  assert.equal(Rp.entities.boundaries.length, 5);
});

test('deterministic: the same input twice gives identical geometry', () => {
  const f: Feature[] = [{ id: 'a', type: 'rect', x: [0, 2], y: [0, 1] }, { id: 'e', type: 'ellipse', c: [1, 1], rx: 0.8, ry: 0.3, rot: 0.2 }, { id: 'f', type: 'fragment', inputs: ['a', 'e'] }];
  const a = buildGeometry2D({ features: f }), b = buildGeometry2D({ features: f });
  assert.deepEqual(ids(a), ids(b));
  assert.deepEqual(Array.from(a.vertices), Array.from(b.vertices));
});
