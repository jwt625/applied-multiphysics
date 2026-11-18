// SPDX-License-Identifier: GPL-3.0-or-later
// Layer stacks (DevLog-044): entity names, selections through parents, gaps, mixed primitives, spec registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecText, resolveParams } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';
import { buildStack, stackFromSolids, resolveEntityIds, type Feature } from '../src/index.ts';
import { registerGeomFeatures, makeResolver, geometryFromSpec } from '../src/spec.ts';

const cell: Feature = { id: 'cell', type: 'rect', x: [-5e-5, 5e-5], y: [-5e-5, 5e-5] };
const pad: Feature = { id: 'pad', type: 'rect', x: [-2e-5, 2e-5], y: [-1.5e-5, 1.5e-5] };
const tsv = () => buildStack({ id: 'st', layers: [
  { id: 'sub', thickness: 1e-4, features: [cell, { id: 'via', type: 'circle', c: [0, 0], r: 1e-5 }, { id: 'si', type: 'difference', target: 'cell', tools: ['via'], keepTools: true }] },
  { id: 'rdl', thickness: 5e-6, features: [cell, pad, { id: 'poly', type: 'difference', target: 'cell', tools: ['pad'], keepTools: true }] },
  { id: 'bump', z0: 1.1e-4, thickness: 2e-5, features: [pad] },
] });
const sel = (t: { domains: Array<{ id: string }>; boundaries: Array<{ id: string }> }, kind: 'domains' | 'boundaries', ids: string[]) =>
  resolveEntityIds(t, kind, ids).indices.map((i) => t[kind][i]!.id);

test('stack: domain, wall and cap names (owner rule, piece numbering, stack aggregates)', () => {
  const st = tsv();
  assert.deepEqual(st.layers.map((l) => [l.id, l.gap]), [['sub', false], ['rdl', false], ['st-gap2', true], ['bump', false]]);
  const E = st.entities;
  assert.deepEqual(E.domains.map((d) => d.id), ['dom:via.sub', 'dom:si.sub', 'dom:pad.rdl', 'dom:poly.rdl', 'dom:pad.bump']);
  assert.deepEqual(E.boundaries.map((b) => b.id), [
    'bnd:via.sub.bottom', 'bnd:si.sub.bottom',
    'bnd:via.edge.sub', 'bnd:cell.bottom.sub', 'bnd:cell.right.sub', 'bnd:cell.top.sub', 'bnd:cell.left.sub',
    'bnd:via.sub.top', 'bnd:si.sub.top#1', 'bnd:si.sub.top#2',
    'bnd:pad.bottom.rdl', 'bnd:pad.right.rdl', 'bnd:pad.top.rdl', 'bnd:pad.left.rdl', 'bnd:cell.bottom.rdl', 'bnd:cell.right.rdl', 'bnd:cell.top.rdl', 'bnd:cell.left.rdl',
    'bnd:pad.rdl.top', 'bnd:poly.rdl.top',
    'bnd:pad.bump.bottom',
    'bnd:pad.bottom.bump', 'bnd:pad.right.bump', 'bnd:pad.top.bump', 'bnd:pad.left.bump',
    'bnd:pad.bump.top',
  ]);
  // the lower domain owns an interface; the upper bottom piece is in parent
  const cap = (id: string) => E.boundaries.find((b) => b.id === id)!;
  assert.deepEqual(cap('bnd:via.sub.top').parent, ['bnd:pad.rdl.bottom#1']);
  assert.deepEqual(cap('bnd:si.sub.top#1').parent, ['bnd:pad.rdl.bottom#2']);
  assert.deepEqual(cap('bnd:si.sub.top#2').parent, ['bnd:poly.rdl.bottom']);
  // selections
  assert.deepEqual(sel(E, 'domains', ['dom:via']), ['dom:via.sub']);
  assert.deepEqual(sel(E, 'domains', ['dom:pad']), ['dom:pad.rdl', 'dom:pad.bump']);
  assert.deepEqual(sel(E, 'domains', ['dom:st.rdl']), ['dom:pad.rdl', 'dom:poly.rdl']);
  assert.equal(sel(E, 'domains', ['dom:st']).length, 5);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:via.edge']), ['bnd:via.edge.sub']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:pad.rdl.bottom']), ['bnd:via.sub.top', 'bnd:si.sub.top#1']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:si.sub.top']), ['bnd:si.sub.top#1', 'bnd:si.sub.top#2']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:cell.left']), ['bnd:cell.left.sub', 'bnd:cell.left.rdl']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:st.top']), ['bnd:pad.bump.top']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:st.bottom']), ['bnd:via.sub.bottom', 'bnd:si.sub.bottom']);
  // overlay: 3 faces; every face maps to one sketch domain per non-gap layer
  assert.equal(st.overlay.entities.domains.length, 3);
  assert.deepEqual([...st.dom3].map((d) => (d < 0 ? -1 : 1)), [1, 1, -1, 1, 1, 1, -1, 1, 1, 1, -1, -1]);
});

test('stack: default layer ids, split pieces keep the C2 grammar, errors', () => {
  const st = buildStack({ id: 'st', layers: [{ thickness: 1, features: [
    { id: 'r', type: 'rect', x: [0, 3], y: [0, 1] }, { id: 'b', type: 'rect', x: [1, 2], y: [-1, 2] },
    { id: 'cut', type: 'difference', target: 'r', tools: ['b'] }] }] });
  assert.deepEqual(st.entities.domains.map((d) => d.id), ['dom:cut.L0#1', 'dom:cut.L0#2']);
  assert.deepEqual(st.entities.domains[0]!.parent, ['dom:cut#1', 'dom:st.L0']);
  assert.throws(() => buildStack({ id: 'st', layers: [{ id: 'top', thickness: 1, features: [cell] }] }), /reserved/);
  assert.throws(() => buildStack({ id: 'st', layers: [{ thickness: 1, features: [cell] }, { z0: 0.5, thickness: 1, features: [cell] }] }), /may not overlap/);
  assert.throws(() => buildStack({ id: 'st', layers: [{ thickness: 1, features: [cell, pad] }] }), /sketch: overlapping domains/);
});

test('mixed primitives: box + z cylinder as a stack keeps the primitive names; overlap needs a boolean', () => {
  const st = stackFromSolids([
    { type: 'box', id: 'slab', x: [0, 1], y: [0, 1], z: [0, 0.2] },
    { type: 'cylinder', id: 'post', radius: 0.1, height: 0.5, base: [0.5, 0.5, 0.2], axis: 'z' },
  ]);
  const E = st.entities;
  assert.deepEqual(sel(E, 'domains', ['dom:slab']), ['dom:slab.z0']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:slab.zmax']), ['bnd:slab.z0.top#1', 'bnd:slab.z0.top#2']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:post.bottom']), ['bnd:slab.z0.top#2']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:post.side']), ['bnd:post.side.z1']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:slab.xmin', 'bnd:slab.ymax']), ['bnd:slab.ymax.z0', 'bnd:slab.xmin.z0']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:post.top', 'bnd:slab.zmin']), ['bnd:slab.z0.bottom', 'bnd:post.z1.top']);
  assert.equal(resolveEntityIds(E, 'boundaries', ['bnd:slab.top']).unknown.length, 1, '2D rect names do not leak into box faces');
  assert.throws(() => stackFromSolids([{ type: 'box', id: 'slab', x: [0, 1], y: [0, 1], z: [0, 0.2] }, { type: 'cylinder', id: 'tsv', radius: 0.1, height: 0.2, base: [0.5, 0.5, 0], axis: 'z' }]),
    /3D solids slab, tsv overlap in z \[0, 0.2\] m: .*extrude/);
  assert.throws(() => stackFromSolids([{ type: 'box', id: 'b', x: [0, 1], y: [0, 1], z: [0, 1] }, { type: 'cylinder', id: 'c', radius: 0.1, height: 1, base: [2, 0.5, 0.5], axis: 'x' }]), /only z-axis cylinders/);
});

test('spec: extrude registration, sketch checks, geometryFromSpec routing', () => {
  const reg = registerGeomFeatures(wave1Registry());
  const good = `
schema: amp-spec/0
id: s
title: t
geometry:
  dim: 3
  features:
    - {id: cell, type: rect, settings: {size: {value: [100, 100], unit: um}, center: {value: [0, 0], unit: um}}}
    - {id: via, type: circle, settings: {center: {value: [0, 0], unit: um}, radius: 10 um}}
    - {id: si, type: difference, settings: {base: cell, tools: [via], keepTools: true}}
    - id: st
      type: extrude
      settings:
        layers:
          - {id: sub, thickness: 100 um, sketch: [si, via], nz: 4}
          - {id: ox, thickness: 2 um, sketch: [cell], dz: 1 um}
`;
  const v = parseSpecText(good, reg);
  assert.deepEqual(v.issues.map((i) => i.message), []);
  const bad = good.replace('sketch: [cell], dz', 'sketch: [cell, nope], dz').replace('{id: ox', '{id: top');
  const msgs = parseSpecText(bad, reg).issues.map((i) => i.message).join(' | ');
  assert.match(msgs, /'nope' is not an earlier geometry feature/);
  assert.match(msgs, /layer id 'top' is reserved/);
  const data = v.spec as unknown as { params?: unknown; geometry: { dim: number; features: Array<{ id: string; type: string; settings?: Record<string, unknown> }> } };
  const R = makeResolver(resolveParams(data.params ?? {}).scope);
  const G = geometryFromSpec(data.geometry, R);
  assert.ok(G.dim === 3 && G.stack);
  if (G.dim !== 3 || !G.stack) return;
  assert.deepEqual(G.stack.layers.map((l) => [l.id, l.nz, l.dz]), [['sub', 4, undefined], ['ox', undefined, 1e-6]]);
  assert.ok(Math.abs(G.stack.layers[1]!.z[1] - 1.02e-4) < 1e-18);
  // the ox sketch is the rect alone: the difference and the via are not in it
  assert.deepEqual(G.stack.entities.domains.map((d) => d.id), ['dom:via.sub', 'dom:si.sub', 'dom:cell.ox']);
  const feats = data.geometry.features;
  assert.throws(() => geometryFromSpec({ dim: 3, features: feats.slice(0, 3) }, R), /sketches for an extrude feature/);
  assert.throws(() => geometryFromSpec({ dim: 3, features: [...feats, { id: 'b', type: 'box', settings: { size: ['1 m', '1 m', '1 m'], center: ['0 m', '0 m', '0 m'] } }] }, R), /cannot be combined with an extrude/);
});

// DevLog-044 s.7 (audit A1): a face shared by two solids / sketch entities is selected by both owners' names.
const box = (id: string, x: [number, number], y: [number, number], z: [number, number]) => ({ type: 'box' as const, id, x, y, z });
test('mixed primitives: fully shared box face is selected by both boxes\' names', () => {
  const E = stackFromSolids([box('A', [0, 1], [0, 1], [0, 1]), box('B', [1, 2], [0, 1], [0, 1])]).entities;
  assert.deepEqual(sel(E, 'boundaries', ['bnd:A.xmax']), ['bnd:A.xmax.z0']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:B.xmin']), ['bnd:A.xmax.z0']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:B.xmin.z0']), ['bnd:A.xmax.z0']);
  const f = E.boundaries.find((b) => b.id === 'bnd:A.xmax.z0')!;
  assert.deepEqual(f.parent, ['bnd:A.xmax', 'bnd:B.xmin']);
  assert.equal(E.boundaries.filter((b) => [...(b.parent ?? []), ...(b.ancestors ?? [])].some((p) => /\.(left|right|top|bottom|edge)(#|\.|$)/.test(p.replace(/^bnd:solids\./, ''))) && !/^bnd:solids\./.test(b.parent![0]!)).length, 0, 'no 2D rect / circle names leak');
});

test('mixed primitives: partly shared box faces (in y and in z) are selected by both names, exposed pieces by the owner', () => {
  // partly in y: B covers y [0.5, 2] against A y [0, 1]
  let E = stackFromSolids([box('A', [0, 1], [0, 1], [0, 1]), box('B', [1, 2], [0.5, 2], [0, 1])]).entities;
  assert.deepEqual(sel(E, 'boundaries', ['bnd:A.xmax']), ['bnd:A.xmax.z0#1', 'bnd:A.xmax.z0#2']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:B.xmin']), ['bnd:A.xmax.z0#2', 'bnd:B.xmin.z0']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:B.xmin.z0']), ['bnd:A.xmax.z0#2', 'bnd:B.xmin.z0']);
  assert.equal(resolveEntityIds(E, 'boundaries', ['bnd:B.left', 'bnd:A.right']).unknown.length, 2, '2D rect names do not leak');
  // partly in z: B spans z [0.5, 1.5] against A z [0, 1]: the shared wall is in layer z1 only
  E = stackFromSolids([box('A', [0, 1], [0, 1], [0, 1]), box('B', [1, 2], [0, 1], [0.5, 1.5])]).entities;
  assert.deepEqual(sel(E, 'boundaries', ['bnd:A.xmax']), ['bnd:A.xmax.z0', 'bnd:A.xmax.z1']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:B.xmin']), ['bnd:A.xmax.z1', 'bnd:B.xmin.z2']);
});

test('mixed primitives: z cylinder on and beside a box', () => {
  // on top, partly covering the box top: the cap interface is selected by both, the exposed ring by the box only
  let E = stackFromSolids([box('A', [-1, 1], [-1, 1], [0, 1]), { type: 'cylinder', id: 'C', radius: 0.5, height: 1, base: [0, 0, 1], axis: 'z' }]).entities;
  assert.deepEqual(sel(E, 'boundaries', ['bnd:A.zmax']), ['bnd:A.z0.top#1', 'bnd:A.z0.top#2']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:C.bottom']), ['bnd:A.z0.top#2']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:C.side']), ['bnd:C.side.z1']);
  // beside, same z range, tangent at one line: no shared area, every face keeps its own name only
  E = stackFromSolids([box('A', [-1, 1], [-1, 1], [0, 1]), { type: 'cylinder', id: 'C', radius: 0.5, height: 1, base: [1.5, 0, 0], axis: 'z' }]).entities;
  assert.deepEqual(sel(E, 'boundaries', ['bnd:C.side']), ['bnd:C.side.z0']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:A.xmax']), ['bnd:A.xmax.z0#1', 'bnd:A.xmax.z0#2'], 'split at the tangent line only');
  // a box hugging a cylinder in z: cylinder below, box above covering it fully
  E = stackFromSolids([{ type: 'cylinder', id: 'C', radius: 0.5, height: 1, base: [0, 0, 0], axis: 'z' }, box('A', [-1, 1], [-1, 1], [1, 2])]).entities;
  assert.deepEqual(sel(E, 'boundaries', ['bnd:C.top']), ['bnd:C.z0.top']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:A.zmin']), ['bnd:A.z1.bottom#1', 'bnd:C.z0.top']);
});

test('extrude: a wall shared by two sketch rects is selected by both 2D names, plain and per layer', () => {
  const st = buildStack({ id: 'st', layers: [{ id: 'm', thickness: 1, features: [
    { id: 'A', type: 'rect', x: [0, 1], y: [0, 1] }, { id: 'B', type: 'rect', x: [1, 2], y: [0.5, 2] }] }] });
  const E = st.entities;
  assert.deepEqual(sel(E, 'boundaries', ['bnd:B.left']), ['bnd:A.right.m#2', 'bnd:B.left.m']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:B.left.m']), ['bnd:A.right.m#2', 'bnd:B.left.m']);
  assert.deepEqual(sel(E, 'boundaries', ['bnd:A.right.m']), ['bnd:A.right.m#1', 'bnd:A.right.m#2']);
});

test('mixed primitives: the stack id is reserved (geom error and spec issue)', () => {
  assert.throws(() => stackFromSolids([box('solids', [0, 1], [0, 1], [0, 1]), { type: 'cylinder', id: 'c', radius: 0.1, height: 1, base: [0.5, 0.5, 1], axis: 'z' }]),
    /solid id 'solids' is reserved in a geometry of mixed boxes \/ cylinders.*rename the solid/);
  const reg = registerGeomFeatures(wave1Registry());
  const spec = (f2: string) => `
schema: amp-spec/0
id: s
title: t
geometry:
  dim: 3
  features:
    - {id: solids, type: box, settings: {size: {value: [1, 1, 1], unit: mm}, center: {value: [0, 0, 0], unit: mm}}}
${f2}
`;
  const mixed = parseSpecText(spec('    - {id: c, type: cylinder, settings: {radius: 0.1 mm, height: 1 mm, base: {value: [0, 0, 0.5], unit: mm}, axis: z}}'), reg);
  assert.match(mixed.issues.map((i) => i.message).join(' | '), /id 'solids' is reserved/);
  // a box list (not a stack) may use the id
  const list = parseSpecText(spec('    - {id: b2, type: box, settings: {size: {value: [1, 1, 1], unit: mm}, center: {value: [1, 0, 0], unit: mm}}}'), reg);
  assert.deepEqual(list.issues.map((i) => i.message), []);
});
