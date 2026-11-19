// SPDX-License-Identifier: GPL-3.0-or-later
// Consumption rule (DevLog-065 D1): a feature may feed several booleans; each reference uses that feature's own shape;
// referencing consumes (except keepTools); duplicates within one boolean and undefined inputs are clear errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeometry2D, domainAreas, buildStack, type Feature, type Geometry2D } from '../src/index.ts';

const area = (g: Geometry2D, id: string) => domainAreas(g)[g.entities.domains.findIndex((d) => d.id === id)]!;
const close = (a: number, b: number, rel: number) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${a} vs ${b}`);

// quarter cell of a via (radius a) in a ring (outer radius R), as sims/tsv-stress-3d builds it with duplicate shapes
const a = 1, R = 3;
const withDuplicates: Feature[] = [
  { id: 'tsv', type: 'circle', c: [0, 0], r: a },
  { id: 'hole', type: 'circle', c: [0, 0], r: a },
  { id: 'outer', type: 'circle', c: [0, 0], r: R },
  { id: 'quad', type: 'rect', x: [0, R], y: [0, R] },
  { id: 'quad2', type: 'rect', x: [0, R], y: [0, R] },
  { id: 'ring', type: 'difference', target: 'outer', tools: ['hole'] },
  { id: 'via', type: 'intersection', inputs: ['tsv', 'quad'] },
  { id: 'si', type: 'intersection', inputs: ['ring', 'quad2'] },
];
const reused: Feature[] = [
  { id: 'tsv', type: 'circle', c: [0, 0], r: a },
  { id: 'outer', type: 'circle', c: [0, 0], r: R },
  { id: 'quad', type: 'rect', x: [0, R], y: [0, R] },
  { id: 'ring', type: 'difference', target: 'outer', tools: ['tsv'] },
  { id: 'via', type: 'intersection', inputs: ['tsv', 'quad'] },
  { id: 'si', type: 'intersection', inputs: ['ring', 'quad'] },
];

test('reuse: a circle as a difference tool and an intersection input, a rect in two intersections', () => {
  const g0 = buildGeometry2D({ features: withDuplicates }), g = buildGeometry2D({ features: reused });
  assert.deepEqual(g.entities.domains.map((d) => d.id), ['dom:via', 'dom:si']);
  close(area(g, 'dom:via'), Math.PI * a * a / 4, 1e-12);
  close(area(g, 'dom:si'), Math.PI * (R * R - a * a) / 4, 1e-12);
  close(area(g, 'dom:via'), area(g0, 'dom:via'), 1e-14);
  close(area(g, 'dom:si'), area(g0, 'dom:si'), 1e-14);
  // same topology as the duplicate-shape sketch; the via arc is named after the circle once (no `hole` names)
  assert.equal(g.edges.length, g0.edges.length);
  assert.equal(g.entities.boundaries.length, g0.entities.boundaries.length);
  assert.ok(g.entities.boundaries.some((b) => b.id === 'bnd:tsv.edge'));
  assert.ok(!JSON.stringify(g.entities).includes('hole') && !JSON.stringify(g.entities).includes('quad2'));
});

test('reuse: one tool in two differences of disjoint targets', () => {
  const g = buildGeometry2D({ features: [
    { id: 'L', type: 'rect', x: [0, 2], y: [0, 2] },
    { id: 'Rr', type: 'rect', x: [2, 4], y: [0, 2] },
    { id: 'slot', type: 'rect', x: [1, 3], y: [0.5, 1.5] },
    { id: 'l2', type: 'difference', target: 'L', tools: ['slot'] },
    { id: 'r2', type: 'difference', target: 'Rr', tools: ['slot'] },
  ] });
  assert.deepEqual(g.entities.domains.map((d) => d.id), ['dom:l2', 'dom:r2']);
  close(area(g, 'dom:l2'), 4 - 1, 1e-13);
  close(area(g, 'dom:r2'), 4 - 1, 1e-13);
});

test('reuse: keepTools after an earlier consumption puts the tool back as a domain', () => {
  const g = buildGeometry2D({ features: [
    { id: 'L', type: 'rect', x: [0, 2], y: [0, 2] },
    { id: 'Rr', type: 'rect', x: [2, 4], y: [0, 2] },
    { id: 'slot', type: 'rect', x: [1, 3], y: [0.5, 1.5] },
    { id: 'l2', type: 'difference', target: 'L', tools: ['slot'] },
    { id: 'u', type: 'union', inputs: ['l2', 'Rr'] },
    { id: 'body', type: 'difference', target: 'u', tools: ['slot'], keepTools: true },
  ] });
  assert.deepEqual(g.entities.domains.map((d) => d.id).sort(), ['dom:body', 'dom:slot']);
  close(area(g, 'dom:slot'), 2, 1e-13);
  close(area(g, 'dom:body'), 8 - 2, 1e-13);
});

test('reuse: union and difference of one primitive; consumed features stay out of the final set', () => {
  const g = buildGeometry2D({ features: [
    { id: 'a1', type: 'rect', x: [0, 1], y: [0, 1] },
    { id: 'b1', type: 'rect', x: [0.5, 1.5], y: [0, 1] },
    { id: 'c1', type: 'rect', x: [3, 4], y: [0, 1] },
    { id: 'u', type: 'union', inputs: ['a1', 'b1'] },
    { id: 'd', type: 'difference', target: 'c1', tools: ['a1'] },   // a1 does not touch c1: d = c1
  ] });
  assert.deepEqual(g.entities.domains.map((x) => x.id), ['dom:u', 'dom:d']);
  close(area(g, 'dom:u'), 1.5, 1e-13);
  close(area(g, 'dom:d'), 1, 1e-13);
});

test('reuse: a reused feature that overlaps a live one is still an overlap error', () => {
  assert.throws(() => buildGeometry2D({ features: [
    { id: 'a1', type: 'rect', x: [0, 1], y: [0, 1] },
    { id: 'b1', type: 'rect', x: [0.5, 1.5], y: [0, 1] },
    { id: 'c1', type: 'rect', x: [0.2, 0.4], y: [0.2, 0.4] },
    { id: 'u', type: 'union', inputs: ['a1', 'b1'] },
    { id: 'v', type: 'union', inputs: ['a1', 'c1'] },
  ] }), /overlapping domains u, v without a boolean/);
});

test('errors: input listed twice, base among the tools, undefined and forward inputs', () => {
  const r: Feature = { id: 'r', type: 'rect', x: [0, 1], y: [0, 1] };
  const s: Feature = { id: 's', type: 'rect', x: [0.5, 2], y: [0, 1] };
  assert.throws(() => buildGeometry2D({ features: [r, s, { id: 'u', type: 'union', inputs: ['r', 'r', 's'] }] }), /u: input 'r' is listed twice/);
  assert.throws(() => buildGeometry2D({ features: [r, s, { id: 'd', type: 'difference', target: 'r', tools: ['s', 'r'] }] }), /d: input 'r' is listed twice/);
  assert.throws(() => buildGeometry2D({ features: [r, s, { id: 'u', type: 'union', inputs: ['r', 'zz'] }] }), /u: input 'zz' is not defined before this feature/);
  assert.throws(() => buildGeometry2D({ features: [r, { id: 'u', type: 'union', inputs: ['r', 's'] }, s] }), /u: input 's' is not defined before this feature/);
  assert.throws(() => buildGeometry2D({ features: [r, s, { id: 'u', type: 'union', inputs: ['u', 's'] }] }), /u: input 'u' is not defined before this feature/);
});

test('stack sketch with a reused primitive (no duplicate shapes)', () => {
  const st = buildStack({ id: 'cell', layers: [{ id: 'wafer', thickness: 1, features: reused }] });
  assert.deepEqual(st.entities.domains.map((d) => d.id), ['dom:via.wafer', 'dom:si.wafer']);
  assert.ok(st.entities.boundaries.some((b) => b.id === 'bnd:tsv.edge.wafer'));
});
