// SPDX-License-Identifier: GPL-3.0-or-later
// Layer stack meshes (DevLog-044): conformity across layers and domains, facets = exterior faces + interfaces, volumes,
// P2 lift on the exact curves, nested refinement with the wall projector, determinism, spec routing and errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStack, stackFromSolids, selectIndices, type Feature, type Mesh } from '@amp/geom';
import { meshStack, stackProjector, stackQuality, refineUniform } from '../src/index.ts';
import { meshFromSpec } from '../src/spec.ts';

const cell: Feature = { id: 'cell', type: 'rect', x: [-5e-5, 5e-5], y: [-5e-5, 5e-5] };
const pad: Feature = { id: 'pad', type: 'rect', x: [-2e-5, 2e-5], y: [-1.5e-5, 1.5e-5] };
const A = 1e-5;
const tsv = () => buildStack({ id: 'st', layers: [
  { id: 'sub', thickness: 1e-4, features: [cell, { id: 'via', type: 'circle', c: [0, 0], r: A }, { id: 'si', type: 'difference', target: 'cell', tools: ['via'], keepTools: true }] },
  { id: 'rdl', thickness: 5e-6, features: [cell, pad, { id: 'poly', type: 'difference', target: 'cell', tools: ['pad'], keepTools: true }] },
  { id: 'bump', z0: 1.1e-4, thickness: 2e-5, features: [pad] },
] });

/** Every tet face is shared by <= 2 tets; faces with one tet or two tets of different domains are exactly the facets. */
function conformity(m: Mesh) {
  const npe = m.cells.type === 'tet10' ? 10 : 4, fpe = m.facets.type === 'tri6' ? 6 : 3;
  const faces = new Map<string, number[]>();
  for (let c = 0; c < m.cells.domain.length; c++)
    for (const f of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) {
      const k = f.map((i) => m.cells.conn[npe * c + i]!).sort((a, b) => a - b).join(',');
      const l = faces.get(k);
      if (l) l.push(c); else faces.set(k, [c]);
    }
  const fac = new Set<string>();
  for (let f = 0; f < m.facets.boundary.length; f++) fac.add([0, 1, 2].map((i) => m.facets.conn[fpe * f + i]!).sort((a, b) => a - b).join(','));
  let need = 0;
  for (const [k, cs] of faces) {
    assert.ok(cs.length <= 2, `face ${k} in ${cs.length} tets`);
    if (cs.length === 1 || m.cells.domain[cs[0]!] !== m.cells.domain[cs[1]!]) { need++; assert.ok(fac.has(k), `face ${k} has no facet`); }
  }
  assert.equal(fac.size, need, 'facets that are not exterior faces or interfaces');
  assert.equal(fac.size, m.facets.boundary.length, 'duplicate facets');
}
function domainVolumes(m: Mesh): Float64Array {
  const npe = m.cells.type === 'tet10' ? 10 : 4, X = m.nodes;
  const v = new Float64Array(m.entities.domains.length);
  for (let c = 0; c < m.cells.domain.length; c++) {
    const p = [0, 1, 2, 3].map((i) => m.cells.conn[npe * c + i]!);
    const d = (i: number, k: number) => X[3 * p[i]! + k]! - X[3 * p[0]! + k]!;
    const vol = (d(1, 0) * (d(2, 1) * d(3, 2) - d(2, 2) * d(3, 1)) - d(1, 1) * (d(2, 0) * d(3, 2) - d(2, 2) * d(3, 0)) + d(1, 2) * (d(2, 0) * d(3, 1) - d(2, 1) * d(3, 0))) / 6;
    assert.ok(vol > 0, `cell ${c} not positively oriented`);
    v[m.cells.domain[c]!]! += vol;
  }
  return v;
}

test('meshStack tet4 / tet10: conforming across layers and domains, straight volumes, every entity has facets', () => {
  const st = tsv();
  for (const order of [1, 2] as const) {
    const m = meshStack(st, { mesh2d: { hmax: 1e-5 }, dz: 2e-5, order });
    assert.equal(m.cells.type, order === 2 ? 'tet10' : 'tet4');
    conformity(m);
    const v = domainVolumes(m);
    const ids = m.entities.domains.map((d) => d.id);
    const V = (id: string) => v[ids.indexOf(id)]!;
    assert.ok(Math.abs(V('dom:pad.rdl') - 4e-5 * 3e-5 * 5e-6) < 1e-27);
    assert.ok(Math.abs(V('dom:pad.bump') - 4e-5 * 3e-5 * 2e-5) < 1e-27);
    assert.ok(Math.abs(V('dom:via.sub') + V('dom:si.sub') - 1e-8 * 1e-4) < 1e-24);
    // the straight via is the inscribed polygon: below pi a^2 t, within the chord deficit of 10-degree segments
    const vv = V('dom:via.sub') / (Math.PI * A * A * 1e-4);
    assert.ok(vv < 1 && vv > 1 - 0.006, `via volume ratio ${vv}`);
    const per = new Int32Array(m.entities.boundaries.length);
    for (const b of m.facets.boundary) per[b]!++;
    assert.deepEqual(m.entities.boundaries.filter((_, i) => !per[i]).map((b) => b.id), []);
    assert.equal(m.quality!.nInverted, 0);
    if (order === 2) assert.ok(m.quality!.minJacobianRatioP2! > 0.5);
  }
});

test('meshStack tet10: mid nodes on the via wall lie on the exact circle; refinement keeps them there', () => {
  const st = buildStack({ id: 'st', layers: [{ id: 'sub', thickness: 2e-5, features: [cell, { id: 'via', type: 'circle', c: [0, 0], r: A }, { id: 'si', type: 'difference', target: 'cell', tools: ['via'], keepTools: true }] }] });
  const m = meshStack(st, { mesh2d: { hmax: 1e-5 }, dz: 1e-5, order: 2 });
  const wall = m.entities.boundaries.findIndex((b) => b.id === 'bnd:via.edge.sub');
  const onWall = (mm: Mesh) => {
    const s = new Set<number>();
    for (let f = 0; f < mm.facets.boundary.length; f++) if (mm.facets.boundary[f] === wall) for (let a = 0; a < 6; a++) s.add(mm.facets.conn[6 * f + a]!);
    let e = 0;
    for (const n of s) e = Math.max(e, Math.abs(Math.hypot(mm.nodes[3 * n]!, mm.nodes[3 * n + 1]!) - A));
    return { n: s.size, e };
  };
  const w0 = onWall(m);
  assert.ok(w0.n > 100 && w0.e < 1e-15 * 1e3 * A, `wall nodes ${w0.n}, max |r - a| ${w0.e}`);
  const proj = stackProjector(m)!;
  const r = refineUniform(m, { project: proj, quality: stackQuality });
  conformity(r);
  const w1 = onWall(r);
  assert.ok(w1.n > 3 * w0.n && w1.e < 1e-15 * 1e3 * A, `refined wall nodes ${w1.n}, max |r - a| ${w1.e}`);
  assert.equal(r.quality!.nInverted, 0);
});

test('mixed primitives through meshFromSpec: box + z cylinder meshes as a stack; overlap and x cylinders error', () => {
  const spec = (cylBase: string, axis = 'z') => ({
    schema: 'amp-spec/0', id: 's', title: 't',
    geometry: { dim: 3, features: [
      { id: 'slab', type: 'box', settings: { size: ['1 mm', '1 mm', '0.2 mm'], center: ['0.5 mm', '0.5 mm', '0.1 mm'] } },
      { id: 'post', type: 'cylinder', settings: { radius: '0.1 mm', height: '0.5 mm', base: { value: JSON.parse(cylBase), unit: 'mm' }, axis } },
    ] },
    mesh: { size: { hmax: '0.1 mm' } },
  });
  const m = meshFromSpec(spec('[0.5, 0.5, 0.2]'), { order: 1 });
  conformity(m);
  const v = domainVolumes(m);
  assert.ok(Math.abs(v[0]! - 0.2e-9) < 1e-21);
  assert.ok(Math.abs(v[1]! / (Math.PI * 1e-8 * 0.5e-3) - 1) < 0.01);
  assert.throws(() => meshFromSpec(spec('[0.5, 0.5, 0]'), { order: 1 }), /overlap in z .* need a boolean/);
  assert.throws(() => meshFromSpec(spec('[0.5, 0.5, 0.2]', 'x'), { order: 1 }), /only z-axis cylinders/);
});

test('stack mesh determinism and stack of solids from stackFromSolids', () => {
  const a = meshStack(tsv(), { mesh2d: { hmax: 1e-5 }, dz: 2e-5, order: 2 });
  const b = meshStack(tsv(), { mesh2d: { hmax: 1e-5 }, dz: 2e-5, order: 2 });
  assert.equal(a.hash, b.hash);
  assert.equal(a.tagHash, b.tagHash);
  const s = stackFromSolids([{ type: 'box', id: 'b1', x: [0, 1], y: [0, 1], z: [0, 1] }, { type: 'box', id: 'b2', x: [0, 1], y: [0, 1], z: [1, 1.5] }, { type: 'cylinder', id: 'c', radius: 0.2, height: 1, base: [0.5, 0.5, 1.5], axis: 'z' }]);
  const m = meshStack(s, { mesh2d: { hmax: 0.25 }, dz: 0.25 });
  conformity(m);
});

// DevLog-044 s.7 (audit A1): a BC on either box's face name covers the whole contact region.
test('mixed primitives: facets selected by each box name of a partly shared face cover that whole face', () => {
  const s = stackFromSolids([{ type: 'box', id: 'A', x: [0, 1], y: [0, 1], z: [0, 1] }, { type: 'box', id: 'B', x: [1, 2], y: [0.5, 2], z: [0.25, 1.5] }]);
  const m = meshStack(s, { mesh2d: { hmax: 0.25 }, dz: 0.25 });
  conformity(m);
  const area = (ids: string[]) => {
    const sel = new Set(selectIndices(m.entities, 'boundaries', ids));
    let a = 0;
    for (let f = 0; f < m.facets.boundary.length; f++) {
      if (!sel.has(m.facets.boundary[f]!)) continue;
      const p = [0, 1, 2].map((i) => { const v = m.facets.conn[3 * f + i]!; return [m.nodes[3 * v]!, m.nodes[3 * v + 1]!, m.nodes[3 * v + 2]!]; });
      const u = [0, 1, 2].map((k) => p[1]![k]! - p[0]![k]!), w = [0, 1, 2].map((k) => p[2]![k]! - p[0]![k]!);
      a += 0.5 * Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!);
    }
    return a;
  };
  // A.xmax: 1 x 1; B.xmin: 1.5 x 1.25; contact: y [0.5, 1] x z [0.25, 1] = 0.375
  assert.ok(Math.abs(area(['bnd:A.xmax']) - 1) < 1e-12);
  assert.ok(Math.abs(area(['bnd:B.xmin']) - 1.875) < 1e-12);
  assert.ok(Math.abs(area(['bnd:A.xmax', 'bnd:B.xmin']) - (1 + 1.875 - 0.375)) < 1e-12);
});
