// SPDX-License-Identifier: GPL-3.0-or-later
// Stack point entities (DevLog-065 D2 / D4), flat-tet layer guidance (D5) and the opt-in thin-layer refinement (D6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStack, stackFromSolids, resolveEntityIds, type Feature, type Mesh, type Stack } from '@amp/geom';
import { meshStack, refineUniform, stackProjector, stackQuality, tagHash } from '../src/index.ts';
import { meshFromSpec } from '../src/spec.ts';
import { tetMinDihedralDeg } from '../src/quality.ts';

const cell: Feature = { id: 'cell', type: 'rect', x: [0, 1e-3], y: [0, 1e-3] };
const pad: Feature = { id: 'pad', type: 'rect', x: [2e-4, 6e-4], y: [3e-4, 7e-4] };
const ids = (st: Stack) => (st.entities.points ?? []).map((p) => p.id);
const xyz = (m: Mesh, id: string) => {
  const i = m.entities.points!.findIndex((p) => p.id === id);
  assert.ok(i >= 0, `no point ${id}`);
  const v = m.pointNode![i]!;
  assert.ok(v >= 0, `${id} has no node`);
  return [m.nodes[3 * v]!, m.nodes[3 * v + 1]!, m.nodes[3 * v + 2]!];
};
/** coordinates to round-off (1e-12 of the 1 mm model) */
const near = (a: number[], b: number[]) => assert.ok(a.every((x, i) => Math.abs(x - b[i]!) <= 1e-15), `${a} vs ${b}`);
const sel = (m: Mesh | Stack, x: string) => resolveEntityIds(m.entities, 'points', [x]).indices.map((i) => m.entities.points![i]!.id);

test('stack points: names, shared planes owned by the lower layer, aliases', () => {
  const st = buildStack({ id: 'S', layers: [
    { id: 'A', thickness: 1e-4, features: [cell] },
    { id: 'B', thickness: 2e-4, features: [cell, pad, { id: 'ring', type: 'difference', target: 'cell', tools: ['pad'], keepTools: true }] },
  ] });
  const P = ids(st);
  // plane 0: A bottom; plane 1: A top (B bottom of the same corners as parents), then the pad corners of B; plane 2: B top
  assert.deepEqual(P.slice(0, 4), ['pnt:cell.p0.A.bottom', 'pnt:cell.p1.A.bottom', 'pnt:cell.p2.A.bottom', 'pnt:cell.p3.A.bottom']);
  assert.deepEqual(P.slice(4, 8), ['pnt:cell.p0.A.top', 'pnt:cell.p1.A.top', 'pnt:cell.p2.A.top', 'pnt:cell.p3.A.top']);
  assert.equal(P.length, 4 + 8 + 8);
  assert.equal(new Set(P).size, P.length);
  const a0 = st.entities.points![4]!;
  assert.deepEqual(a0.parent, ['pnt:cell.p0', 'pnt:cell.p0.B.bottom']);
  assert.deepEqual(sel(st, 'pnt:cell.p0.B.bottom'), ['pnt:cell.p0.A.top']);
  assert.deepEqual(sel(st, 'pnt:cell.p0'), ['pnt:cell.p0.A.bottom', 'pnt:cell.p0.A.top', 'pnt:cell.p0.B.top']);
  assert.deepEqual(sel(st, 'pnt:cell.p0.A'), ['pnt:cell.p0.A.bottom', 'pnt:cell.p0.A.top']);
  assert.deepEqual(sel(st, 'pnt:pad.p2.B.bottom').length, 1);
  assert.deepEqual(sel(st, 'pnt:pad.p2.B'), ['pnt:pad.p2.B.bottom', 'pnt:pad.p2.B.top']);
  // nothing reads like a 2D-only id
  for (const p of st.entities.points!) assert.match(p.id, /^pnt:[a-z]+\.p\d\.[AB]\.(top|bottom)$/);
});

test('stack points: nodes at the right coordinates (tet4, tet10, nested refinement)', () => {
  const st = buildStack({ id: 'S', layers: [
    { id: 'A', thickness: 1e-4, features: [cell], nz: 2 },
    { id: 'B', z0: 1.5e-4, thickness: 2e-4, features: [pad] },   // gap 1e-4 .. 1.5e-4
  ] });
  // after the gap only the upper layer's bottom names exist
  assert.ok(ids(st).includes('pnt:pad.p0.B.bottom') && ids(st).includes('pnt:cell.p0.A.top'));
  for (const order of [1, 2] as const) {
    const m = meshStack(st, { mesh2d: { hmax: 2e-4 }, order });
    assert.equal(m.pointNode!.length, m.entities.points!.length);
    near(xyz(m, 'pnt:cell.p2.A.top'), [1e-3, 1e-3, 1e-4]);
    near(xyz(m, 'pnt:cell.p0.A.bottom'), [0, 0, 0]);
    near(xyz(m, 'pnt:pad.p1.B.bottom'), [6e-4, 3e-4, 1.5e-4]);
    near(xyz(m, 'pnt:pad.p3.B.top'), [2e-4, 7e-4, 3.5e-4]);
    // 3D tag hash covers domain and boundary ids only (as before points existed)
    assert.equal(m.tagHash, tagHash(m.cells.domain, m.facets.conn, m.facets.boundary, [...m.entities.domains, ...m.entities.boundaries].map((e) => e.id)));
    const r = refineUniform(m, { project: stackProjector(m)!, quality: stackQuality });
    near(xyz(r, 'pnt:pad.p3.B.top'), [2e-4, 7e-4, 3.5e-4]);
    assert.equal(r.tagHash, tagHash(r.cells.domain, r.facets.conn, r.facets.boundary, [...r.entities.domains, ...r.entities.boundaries].map((e) => e.id)));
  }
});

test('stack points: boolean intersection points and a circle (no corner) in the sketch', () => {
  const st = buildStack({ id: 'S', layers: [{ id: 'w', thickness: 1e-4, features: [
    { id: 'tsv', type: 'circle', c: [0, 0], r: 2e-4 },
    { id: 'q', type: 'rect', x: [0, 5e-4], y: [0, 5e-4] },
    { id: 'via', type: 'intersection', inputs: ['tsv', 'q'] },
    { id: 'si', type: 'difference', target: 'q', tools: ['tsv'] },
  ] }] });
  const m = meshStack(st, { mesh2d: { hmax: 1e-4 }, order: 2 });
  for (const p of m.entities.points!) assert.ok(m.pointNode![m.entities.points!.indexOf(p)]! >= 0, p.id);
  const x = xyz(m, sel(m, 'pnt:via.x1.w.top')[0]!);
  assert.ok(Math.abs(Math.hypot(x[0]!, x[1]!) - 2e-4) < 1e-15 && x[2] === 1e-4, `${x}`);
});

test('mixed boxes / cylinders: no point entities (unchanged)', () => {
  const st = stackFromSolids([
    { type: 'box', id: 'A', x: [0, 1], y: [0, 1], z: [0, 1] },
    { type: 'box', id: 'B', x: [0, 1], y: [0, 1], z: [1, 2] },
    { type: 'cylinder', id: 'C', radius: 0.2, height: 0.5, base: [0.5, 0.5, 2], axis: 'z' },
  ]);
  assert.equal(st.entities.points, undefined);
  assert.equal(meshStack(st, { mesh2d: { hmax: 0.3 } }).pointNode, undefined);
});

/** thin layer (2 um) on a 1 mm slab under 0.2 mm in-plane cells */
const thinSpec = (aspect?: number) => ({
  schema: 'amp-spec/0', id: 'thin',
  geometry: { dim: 3, features: [
    { id: 'plate', type: 'rect', settings: { size: { value: [1, 1], unit: 'mm' }, center: { value: [0, 0], unit: 'mm' } } },
    { id: 'film', type: 'rect', settings: { size: { value: [0.4, 0.4], unit: 'mm' }, center: { value: [0, 0], unit: 'mm' } } },
    { id: 'st', type: 'extrude', settings: { layers: [
      { id: 'sub', thickness: { value: 0.5, unit: 'mm' }, sketch: ['plate'], nz: 2 },
      { id: 'skin', thickness: { value: 2, unit: 'um' }, sketch: ['film'] },
    ] } },
  ] },
  mesh: { size: { hmax: { value: 0.2, unit: 'mm' }, ...(aspect !== undefined ? { maxLayerAspect: aspect } : {}) } },
});

test('flat-tet warning names the thin layer, its cell sizes and its sketch domains', () => {
  const m = meshFromSpec(thinSpec());
  const w = (m.warnings ?? []).filter((x) => x.startsWith('flat tetrahedra'));
  assert.equal(w.length, 1, JSON.stringify(m.warnings));
  assert.match(w[0]!, /^flat tetrahedra in layer 'skin': min dihedral angle \d+\.\d\d deg \(below 5 deg\) in a cell [\d.]+ um wide and 2 um high; the cell is much wider than tall \(a thin layer under coarse in-plane cells\)\. Remedy: mesh\.refine on this layer's sketch domains \(dom:film\) with h comparable to the z cell height/);
  assert.ok(!/layer 'sub'/.test(w[0]!));
  // the per-cell screen equals the mesh quality summary (same formulas)
  let md = 180;
  for (let c = 0; c < m.cells.domain.length; c++) md = Math.min(md, tetMinDihedralDeg(m.nodes, m.cells.conn.subarray(4 * c, 4 * c + 4)));
  assert.equal(md, m.quality!.minDihedralDeg);
});

test('maxLayerAspect: off = identical mesh; on = the thin layer refined in plane; tall cells below are diagnosed', () => {
  const m0 = meshFromSpec(thinSpec());
  // a large aspect does not trigger (aspect * dz >= hmax): same mesh as without the option
  const mBig = meshFromSpec(thinSpec(1e3));
  assert.equal(mBig.hash, m0.hash);
  assert.equal(mBig.tagHash, m0.tagHash);
  // aspect 4: 8 um cells over the film; the skin is well shaped, the 0.25 mm z cells of the substrate under it are not
  const m1 = meshFromSpec(thinSpec(4));
  assert.ok(!(m1.warnings ?? []).some((x) => x.includes("layer 'skin'")), JSON.stringify(m1.warnings));
  assert.ok((m1.warnings ?? []).some((x) => /^flat tetrahedra in layer 'sub': .* high; the cell is much taller than wide .* Remedy: more z cells in this layer \(nz or dz\)/.test(x)), JSON.stringify(m1.warnings));
  assert.ok(m1.nodes.length > m0.nodes.length);
  assert.throws(() => meshStack(buildStack({ id: 'S', layers: [{ thickness: 1, features: [cell] }] }), { maxLayerAspect: 0 }), /maxLayerAspect must be a finite number > 0/);
});
