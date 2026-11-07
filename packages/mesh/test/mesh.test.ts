// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildGeometry2D, domainAreas, type Feature, type Mesh } from '@amp/geom';
import {
  mesh2d, meshBoxes, meshExtruded, meshRevolved, toHcurlMesh, meshHash, Sha256, triQuality, tetQuality,
} from '../src/index.ts';

const plate: Feature[] = [
  { id: 'plate', type: 'rect', x: [0, 0.1], y: [0, 0.05] },
  { id: 'hole', type: 'circle', c: [0, 0], r: 0.01 },
  { id: 'cut', type: 'difference', target: 'plate', tools: ['hole'] },
];
const bid = (m: Mesh, id: string) => m.entities.boundaries.findIndex((b) => b.id === id);

/** 2D: every edge used by one triangle must be a facet; facets must be triangle edges. */
function check2d(m: Mesh) {
  const nv = m.cells.type === 'tri6' ? 6 : 3, fv = m.facets.type === 'line3' ? 3 : 2;
  const cnt = new Map<string, number>();
  const nt = m.cells.domain.length;
  for (let t = 0; t < nt; t++)
    for (let i = 0; i < 3; i++) {
      const a = m.cells.conn[nv * t + i]!, b = m.cells.conn[nv * t + ((i + 1) % 3)]!;
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
  const fac = new Set<string>();
  for (let f = 0; f < m.facets.boundary.length; f++) {
    const a = m.facets.conn[fv * f]!, b = m.facets.conn[fv * f + 1]!;
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    assert.ok(cnt.has(k), 'facet is a triangle edge');
    fac.add(k);
  }
  for (const [k, c] of cnt) {
    assert.ok(c <= 2, 'edge shared by at most 2 triangles');
    if (c === 1) assert.ok(fac.has(k), `exterior edge ${k} is a facet`);
  }
}

/** 3D tet: faces shared by <= 2 tets; every exterior face is a facet; facets are tet faces; no inverted tets. */
function check3d(m: Mesh) {
  const cnt = new Map<string, number>();
  const nt = m.cells.domain.length;
  const key = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(',');
  const FACES = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
  for (let t = 0; t < nt; t++)
    for (const f of FACES) {
      const k = key(m.cells.conn[4 * t + f[0]!]!, m.cells.conn[4 * t + f[1]!]!, m.cells.conn[4 * t + f[2]!]!);
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
  const fac = new Set<string>();
  for (let f = 0; f < m.facets.boundary.length; f++) {
    const k = key(m.facets.conn[3 * f]!, m.facets.conn[3 * f + 1]!, m.facets.conn[3 * f + 2]!);
    assert.ok(cnt.has(k), 'facet is a tet face');
    fac.add(k);
  }
  for (const [k, c] of cnt) {
    assert.ok(c <= 2, `face ${k} shared by ${c} tets`);
    if (c === 1) assert.ok(fac.has(k), `exterior face ${k} is a facet`);
  }
  assert.equal(tetQuality(m.nodes, m.cells.conn).nInverted, 0);
}

test('sha256 matches node:crypto; meshHash is sha-256 of nodes + conn bytes', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000)])
    assert.equal(new Sha256().update(s).digestHex(), createHash('sha256').update(s).digest('hex'));
  const n = Float64Array.from([0, 1.5, -2, 3e-9]), c = Int32Array.from([0, 1, 1, 0]);
  const ref = createHash('sha256').update(new Uint8Array(n.buffer)).update(new Uint8Array(c.buffer)).digest('hex');
  assert.equal(meshHash(n, c), ref);
});

test('mesh2d plate with hole: tags, conformity, quality, area, determinism', () => {
  const g = buildGeometry2D({ features: plate });
  const m = mesh2d(g, { hmax: 0.005, refine: [{ select: ['bnd:hole.edge'], h: 5e-4, grade: 0.2 }] });
  check2d(m);
  assert.equal(m.cells.type, 'tri3');
  assert.ok(m.quality!.minAngleDeg! > 20.7, `min angle ${m.quality!.minAngleDeg}`);
  const exact = domainAreas(g)[0]!;
  assert.ok(Math.abs(m.quality!.area! - exact) / exact < 1e-4);
  // facets of the left edge lie on x = 0, facets of the hole on r = 0.01 (vertices on the exact circle)
  const L = bid(m, 'bnd:plate.left'), H = bid(m, 'bnd:hole.edge');
  let nh = 0;
  for (let f = 0; f < m.facets.boundary.length; f++) {
    const b = m.facets.boundary[f]!;
    for (const q of [0, 1]) {
      const v = m.facets.conn[2 * f + q]!, x = m.nodes[2 * v]!, y = m.nodes[2 * v + 1]!;
      if (b === L) assert.equal(x, 0);
      if (b === H) { assert.ok(Math.abs(Math.hypot(x, y) - 0.01) < 1e-15); nh++; }
    }
  }
  assert.ok(nh > 0);
  const m2 = mesh2d(g, { hmax: 0.005, refine: [{ select: ['bnd:hole.edge'], h: 5e-4, grade: 0.2 }] });
  assert.equal(m.hash, m2.hash);
  assert.equal(m.tagHash, m2.tagHash);
  const m3 = mesh2d(g, { hmax: 0.004 });
  assert.notEqual(m.hash, m3.hash);
});

test('mesh2d tri6: mid-edge nodes on the exact curve, valid Jacobians', () => {
  const g = buildGeometry2D({ features: plate });
  const m = mesh2d(g, { hmax: 0.01, order: 2 });
  check2d(m);
  assert.equal(m.cells.type, 'tri6');
  assert.equal(m.facets.type, 'line3');
  const H = bid(m, 'bnd:hole.edge');
  for (let f = 0; f < m.facets.boundary.length; f++) {
    if (m.facets.boundary[f] !== H) continue;
    const v = m.facets.conn[3 * f + 2]!;
    assert.ok(Math.abs(Math.hypot(m.nodes[2 * v]!, m.nodes[2 * v + 1]!) - 0.01) < 1e-15);
  }
  assert.ok(m.quality!.minJacobianRatioP2! > 0.5);
});

test('mesh2d local refinement by domain selection and fragment interfaces', () => {
  const g = buildGeometry2D({ features: [{ id: 'a', type: 'rect', x: [0, 2], y: [0, 1] }, { id: 'c', type: 'circle', c: [1, 1], r: 0.5 }, { id: 'f', type: 'fragment', inputs: ['a', 'c'] }] });
  const m = mesh2d(g, { hmax: 0.2, refine: [{ select: ['dom:a&c'], h: 0.02 }] });
  check2d(m);
  const di = g.entities.domains.findIndex((d) => d.id === 'dom:a&c');
  const count = new Array(g.entities.domains.length).fill(0);
  for (const d of m.cells.domain) count[d]++;
  const A = domainAreas(g);
  const dens = count.map((c, i) => c / A[i]!);
  const da = g.entities.domains.findIndex((d) => d.id === 'dom:a');
  assert.ok(dens[di]! > 5 * dens[da]! && dens[di]! > Math.max(...dens.filter((_, i) => i !== di)), `density ${dens}`);
  // the interface between a&c and c exists as facets
  const iface = g.entities.boundaries.findIndex((b) => b.id === 'bnd:a.top#2');
  assert.ok(m.facets.boundary.includes(iface));
});

test('mesh2d axisymmetric: flag carried, axis nodes at r = 0, embedded arc gets facets', () => {
  const g = buildGeometry2D({ axisym: true, features: [{ id: 'air', type: 'rect', x: [0, 1], y: [-1, 1] }, { id: 'coil', type: 'rect', x: [0.1, 0.11], y: [0.045, 0.055] }, { id: 'cut', type: 'difference', target: 'air', tools: ['coil'], keepTools: true }, { id: 'arc', type: 'arc', c: [0, 0], r: 0.5, a0: -1, a1: 1 }] });
  const m = mesh2d(g, { hmax: 0.1, refine: [{ select: ['dom:coil'], h: 0.002 }] });
  check2d(m);
  assert.equal(m.axisym, true);
  const ax = g.entities.boundaries.findIndex((b) => b.axis);
  const arc = g.entities.boundaries.findIndex((b) => b.id === 'bnd:arc.e0');
  let nax = 0;
  for (let f = 0; f < m.facets.boundary.length; f++) if (m.facets.boundary[f] === ax) { nax++; assert.equal(m.nodes[2 * m.facets.conn[2 * f]!], 0); }
  assert.ok(nax > 0 && m.facets.boundary.includes(arc));
});

test('mesh2d lifts the EO 80k-vertex cap', () => {
  const g = buildGeometry2D({ features: [{ id: 'r', type: 'rect', x: [0, 1], y: [0, 1] }] });
  const m = mesh2d(g, { hmax: 0.0045 });
  assert.ok(m.nodes.length / 2 > 80000, `${m.nodes.length / 2} nodes`);
  assert.equal(triQuality(m.nodes, m.cells.conn).nInverted, 0);
});

test('boxgrid: hex8 with tagged exterior and interface facets; equal-priority overlap rejected', () => {
  const m = meshBoxes([{ id: 'sub', x: [0, 1e-3], y: [0, 1e-3], z: [0, 2e-4] }, { id: 'die', x: [2e-4, 8e-4], y: [2e-4, 8e-4], z: [2e-4, 3e-4] }], { h: 1e-4, hz: 5e-5 });
  assert.equal(m.cells.type, 'hex8');
  assert.equal(m.quality!.nInverted, 0);
  assert.ok(Math.abs(m.quality!.volume! - (2e-10 + 0.36e-10)) < 1e-22);
  const ids = m.entities.boundaries.map((b) => b.id);
  assert.ok(ids.includes('bnd:sub.zmin') && ids.includes('bnd:die.zmax'));
  const iface = m.entities.boundaries.find((b) => b.parent?.includes('bnd:die.zmin'));
  assert.ok(iface && iface.id.startsWith('bnd:sub.zmax#'), JSON.stringify(iface));
  // facet count: every exterior quad once
  const cnt = new Map<string, number>();
  for (let e = 0; e < m.cells.domain.length; e++)
    for (const f of [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]]) {
      const k = f.map((a) => m.cells.conn[8 * e + a]!).sort((x, y) => x - y).join(',');
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
  const ext = [...cnt.values()].filter((c) => c === 1).length;
  const extFacets = m.facets.boundary.filter((b) => !m.entities.boundaries[b]!.parent?.some((p) => p.endsWith('.zmin') && p.includes('die'))).length;
  assert.equal(extFacets, ext);
  assert.throws(() => meshBoxes([{ id: 'a', x: [0, 2], y: [0, 1], z: [0, 1] }, { id: 'b', x: [1, 3], y: [0, 1], z: [0, 1] }], { h: 0.5 }), /priorit/);
});

test('meshExtruded: layered tet4 conforming, tagged, volume exact; prism6 option', () => {
  const g = buildGeometry2D({ features: [{ id: 'sub0', type: 'rect', x: [0, 2], y: [0, 2] }, { id: 'via', type: 'circle', c: [1, 1], r: 0.3 }, { id: 'sub', type: 'difference', target: 'sub0', tools: ['via'], keepTools: true }] });
  const layers = [{ id: 'L0', z: [0, 1] as [number, number], dz: 0.25 }, { id: 'L1', z: [1, 1.5] as [number, number], domains: ['via'], dz: 0.25 }];
  const m = meshExtruded(g, layers, { mesh2d: { hmax: 0.25 } });
  check3d(m);
  const m2 = mesh2d(g, { hmax: 0.25 });
  const via2d = m2.cells.domain.reduce((s, d, t) => {
    if (g.entities.domains[d]!.id !== 'dom:via') return s;
    const c = m2.cells.conn, n = m2.nodes;
    const a = c[3 * t]!, b = c[3 * t + 1]!, e = c[3 * t + 2]!;
    return s + 0.5 * ((n[2 * b]! - n[2 * a]!) * (n[2 * e + 1]! - n[2 * a + 1]!) - (n[2 * e]! - n[2 * a]!) * (n[2 * b + 1]! - n[2 * a + 1]!));
  }, 0);
  assert.ok(Math.abs(m.quality!.volume! - (4 * 1 + via2d * 0.5)) < 1e-12);
  const ids = new Set(m.entities.boundaries.map((b) => b.id));
  for (const want of ['bnd:sub0.top.L0', 'bnd:via.L0.top', 'bnd:via.L1.top', 'bnd:via.edge.L1', 'bnd:sub0.left.L0', 'bnd:sub.L0.bottom'])
    assert.ok(ids.has(want), want);
  for (let b = 0; b < m.entities.boundaries.length; b++) assert.ok(m.facets.boundary.includes(b), `boundary ${m.entities.boundaries[b]!.id} has facets`);
  const p = meshExtruded(g, layers, { mesh2d: { hmax: 0.25 }, cell: 'prism6' });
  assert.equal(p.cells.type, 'prism6');
  assert.ok(Math.abs(p.quality!.volume! - m.quality!.volume!) < 1e-12);
  assert.equal(p.facets2!.type, 'quad4');
});

test('meshRevolved: torus from a circle, volume vs Pappus, conforming; partial angle caps', () => {
  const R0 = 0.1, r0 = 0.02;
  const g = buildGeometry2D({ axisym: true, features: [{ id: 'core', type: 'circle', c: [R0, 0], r: r0 }] });
  const m = meshRevolved(g, { id: 'rev', sectors: 48, mesh2d: { hmax: 0.005 } });
  check3d(m);
  const pappus = 2 * Math.PI * R0 * Math.PI * r0 * r0;
  assert.ok(Math.abs(m.quality!.volume! - pappus) / pappus < 0.01, `${m.quality!.volume} vs ${pappus}`);
  const cyl = buildGeometry2D({ axisym: true, features: [{ id: 'c', type: 'rect', x: [0, 1], y: [0, 2] }] });
  const q = meshRevolved(cyl, { id: 'rev', sectors: 16, angle: Math.PI / 2, mesh2d: { hmax: 0.25 } });
  check3d(q);
  const ids = q.entities.boundaries.map((b) => b.id);
  assert.deepEqual(ids, ['bnd:c.bottom.rev', 'bnd:c.right.rev', 'bnd:c.top.rev', 'bnd:c.rev.start', 'bnd:c.rev.end']);
  for (let b = 0; b < ids.length; b++) assert.ok(q.facets.boundary.includes(b));
});

test('toHcurlMesh: sorted tets, unique edges, edgeIndex consistent', () => {
  const g = buildGeometry2D({ features: [{ id: 'c', type: 'circle', c: [0, 0], r: 1 }] });
  const m = meshExtruded(g, [{ id: 'L', z: [0, 1] }], { mesh2d: { hmax: 0.3 }, dz: 0.3 });
  const H = toHcurlMesh(m);
  assert.equal(H.nTets, m.cells.domain.length);
  for (let t = 0; t < H.nTets; t++) {
    for (let i = 0; i < 3; i++) assert.ok(H.tets[4 * t + i]! < H.tets[4 * t + i + 1]!);
    for (let l = 0; l < 6; l++) {
      const e = H.tetEdges[6 * t + l]!;
      assert.equal(H.edgeIndex(H.edges[2 * e]!, H.edges[2 * e + 1]!), e);
    }
  }
  // Euler characteristic of a ball: V - E + F - T = 1
  const faces = new Set<string>();
  for (let t = 0; t < H.nTets; t++) for (const f of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) faces.add(f.map((i) => H.tets[4 * t + i]).join(','));
  assert.equal(H.nNodes - H.nEdges + faces.size - H.nTets, 1);
});

test('audit S2/S4: warnings for near-degenerate input; the vertex budget fails fast', () => {
  // internally tangent circle: a cusp the mesher cannot grade -> min angle warning, mesh still returned
  const g = buildGeometry2D({ features: [{ id: 'r', type: 'rect', x: [0, 1], y: [0, 1] }, { id: 'c', type: 'circle', c: [0.5, 0.25], r: 0.25 }, { id: 'f', type: 'fragment', inputs: ['r', 'c'] }] });
  const m = mesh2d(g, { hmax: 0.05 });
  assert.ok(m.warnings?.some((w) => w.startsWith('minimum angle')), JSON.stringify(m.warnings));
  // a clean mesh has no warnings
  assert.equal(mesh2d(buildGeometry2D({ features: plate }), { hmax: 0.005 }).warnings, undefined);
  // a boundary shorter than 2 hmin is reported
  const s = buildGeometry2D({ features: [{ id: 'r', type: 'rect', x: [0, 1], y: [0, 1] }, { id: 'tiny', type: 'rect', x: [0.5, 0.5 + 1e-6], y: [0.5, 0.5 + 1e-6] }, { id: 'd', type: 'difference', target: 'r', tools: ['tiny'] }] });
  const ms = mesh2d(s, { hmax: 0.1, hmin: 1e-3 });
  assert.ok(ms.warnings?.some((w) => w.includes('bnd:tiny.') && w.includes('resolvable size')), JSON.stringify(ms.warnings));
  const t0 = performance.now();
  assert.throws(() => mesh2d(buildGeometry2D({ features: [{ id: 'r', type: 'rect', x: [0, 1], y: [0, 1] }] }), { hmax: 1e-4 }), /estimated from the size field exceed the budget/);
  assert.ok(performance.now() - t0 < 500);
});
