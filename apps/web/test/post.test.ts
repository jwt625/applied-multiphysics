// SPDX-License-Identifier: GPL-3.0-or-later
// Pure post kernels of the web app (DevLog-011 s.1.9 gate 6). Analytic test functions only (no physics data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeometry2D } from '@amp/geom';
import { mesh2d, meshBoxes } from '@amp/mesh';
import { toMesh2D, latticeValues, refinePattern, refinedDisplay, Locator, evalElement, triShapeQuality } from '../src/lib/post/field2d.ts';
import { exterior, marchingTets, slice, cutArea, bbox3, cellQuality, autoDeformScale } from '../src/lib/post/solid3d.ts';

const f = (x: number, y: number) => x * x + 0.5 * x * y - 2 * y * y + 3 * x - 1;

test('refine pattern: r^2 sub-triangles covering the reference triangle', () => {
  for (const r of [1, 2, 3, 5]) {
    const p = refinePattern(r);
    assert.equal(p.np, ((r + 1) * (r + 2)) / 2);
    assert.equal(p.sub.length, 3 * r * r);
    let A = 0;
    for (let s = 0; s < r * r; s++) {
      const [a, b, c] = [p.sub[3 * s]!, p.sub[3 * s + 1]!, p.sub[3 * s + 2]!];
      const ax = p.L[3 * a + 1]!, ay = p.L[3 * a + 2]!, bx = p.L[3 * b + 1]!, by = p.L[3 * b + 2]!, cx = p.L[3 * c + 1]!, cy = p.L[3 * c + 2]!;
      const s2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      assert.ok(s2 > 0, 'counter-clockwise');
      A += s2 / 2;
    }
    assert.ok(Math.abs(A - 0.5) < 1e-14);
  }
});

test('P2 lattice values and the point probe are exact for a quadratic on straight tri6', () => {
  const g = buildGeometry2D({ features: [{ id: 'r', type: 'rect', x: [0, 2], y: [0, 1] }] });
  const m = toMesh2D(mesh2d(g, { hmax: 0.2, order: 2 }));
  const nn = m.nodes.length / 2;
  const data = new Float64Array(nn);
  for (let i = 0; i < nn; i++) data[i] = f(m.nodes[2 * i]!, m.nodes[2 * i + 1]!);
  const fld = { space: 'H1P2' as const, data, components: 1 };
  const r = 4, lv = latticeValues(m, fld, r, 0), d = refinedDisplay(m, r);
  let err = 0;
  for (let i = 0; i < lv.length; i++) err = Math.max(err, Math.abs(lv[i]! - f(d.pos[2 * i]! + d.c0[0], d.pos[2 * i + 1]! + d.c0[1])));
  assert.ok(err < 1e-5, `lattice err ${err}`); // float32 storage
  const loc = new Locator(m);
  let perr = 0, n = 0;
  for (let k = 0; k < 500; k++) {
    const x = 2 * ((k * 0.6180339887) % 1), y = (k * 0.7548776662) % 1;
    const h = loc.locate(x, y);
    assert.ok(h, `point ${x},${y} located`);
    perr = Math.max(perr, Math.abs(evalElement(m, fld, h.t, ...h.L, 0) - f(x, y)));
    n++;
  }
  assert.ok(perr < 1e-12, `probe err ${perr}`);
  assert.equal(loc.locate(3, 0.5), null);
  const q = triShapeQuality(m);
  assert.ok(Math.min(...q) > 0.5 && Math.max(...q) <= 1 + 1e-12);
});

test('probe on curved tri6 (disk) finds every interior point', () => {
  const g = buildGeometry2D({ features: [{ id: 'd', type: 'circle', c: [0, 0], r: 1 }] });
  const m = toMesh2D(mesh2d(g, { hmax: 0.15, order: 2 }));
  const loc = new Locator(m);
  let miss = 0;
  for (let k = 0; k < 400; k++) {
    const rr = 0.999 * Math.sqrt((k + 0.5) / 400), th = k * 2.399963;
    if (!loc.locate(rr * Math.cos(th), rr * Math.sin(th))) miss++;
  }
  assert.equal(miss, 0);
});

test('marching tets: isosurface of |x - c| on a hex box approximates a sphere; slice area is exact', () => {
  const m = meshBoxes([{ id: 'b', x: [0, 1], y: [0, 1], z: [0, 1] }], { h: 0.04 });
  const nn = m.nodes.length / 3, s = new Float64Array(nn);
  for (let i = 0; i < nn; i++) s[i] = Math.hypot(m.nodes[3 * i]! - 0.5, m.nodes[3 * i + 1]! - 0.5, m.nodes[3 * i + 2]! - 0.5);
  const R = 0.3, c0 = bbox3(m.nodes).c;
  const iso = marchingTets(m, s, R, null, null, c0);
  const rel = Math.abs(cutArea(iso) / (4 * Math.PI * R * R) - 1);
  assert.ok(rel < 0.01, `sphere area rel err ${rel}`);
  const sl = slice(m, [0, 0, 1], 0.37, s, null, c0);
  assert.ok(Math.abs(cutArea(sl) - 1) < 1e-9, `slice area ${cutArea(sl)}`);
  const ext = exterior(m);
  let A = 0;
  for (let t = 0; t < ext.pos.length / 9; t++) {
    const o = 9 * t, p = ext.pos;
    const ux = p[o + 3]! - p[o]!, uy = p[o + 4]! - p[o + 1]!, uz = p[o + 5]! - p[o + 2]!, vx = p[o + 6]! - p[o]!, vy = p[o + 7]! - p[o + 1]!, vz = p[o + 8]! - p[o + 2]!;
    A += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  assert.ok(Math.abs(A - 6) < 1e-5, `exterior area ${A}`);
  const q = cellQuality(m);
  assert.ok(Math.min(...q) > 0.3);
  assert.ok(Math.abs(autoDeformScale(2, [0, 0, 2, 1, 0, 0], 3) - 0.1) < 1e-15);
});

// DevLog-015 (visual design pass): tet10 exterior split with outward smooth normals, flux-line gradients, accuracy verdicts
import { meshCylinder } from '@amp/mesh';
import { gradAt } from '../src/lib/post/flux2d.ts';
import { verdict, type AccState } from '../src/lib/post/accuracy.ts';

test('tet10 exterior: 4 triangles per face through the mid-edge nodes, curved area, outward unit normals', () => {
  const R = 0.5, H = 1;
  const m = meshCylinder({ id: 'c', radius: R, height: H, base: [0, 0, 0], axis: 'z' }, { mesh2d: { hmax: 0.2 }, dz: 0.2, cell: 'tet4', order: 2 } as never);
  assert.equal(m.cells.type, 'tet10');
  const ext = exterior(m);
  let A = 0, bad = 0, badLen = 0;
  const c0 = ext.c0;
  for (let t = 0; t < ext.pos.length / 9; t++) {
    const o = 9 * t, p = ext.pos;
    const ux = p[o + 3]! - p[o]!, uy = p[o + 4]! - p[o + 1]!, uz = p[o + 5]! - p[o + 2]!, vx = p[o + 6]! - p[o]!, vy = p[o + 7]! - p[o + 1]!, vz = p[o + 8]! - p[o + 2]!;
    A += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    for (let k = 0; k < 3; k++) {
      const i = 3 * (3 * t + k), n = [ext.nrm[i]!, ext.nrm[i + 1]!, ext.nrm[i + 2]!];
      if (Math.abs(Math.hypot(n[0]!, n[1]!, n[2]!) - 1) > 1e-5) badLen++;
      // convex body centred at c0 (positions are relative to c0): outward normals point away from the centre
      if (n[0]! * p[i]! + n[1]! * p[i + 1]! + n[2]! * p[i + 2]! <= 0) bad++;
    }
  }
  void c0;
  const exact = 2 * Math.PI * R * H + 2 * Math.PI * R * R;
  assert.ok(Math.abs(A / exact - 1) < 2e-3, `curved exterior area rel err ${A / exact - 1}`);
  assert.equal(badLen, 0);
  assert.equal(bad, 0, 'outward normals');
  // mid-edge vertices carry their edge corners
  let mids = 0;
  for (let i = 0; i < ext.node.length; i++) if (ext.pair[2 * i] !== ext.pair[2 * i + 1]) mids++;
  assert.equal(mids, (3 * ext.node.length) / 4, '9 of the 12 vertices of a split face are mid-edge nodes');
});

test('flux lines: element gradient of a P2 field is exact for a quadratic on straight tri6', () => {
  const g = buildGeometry2D({ features: [{ id: 'r', type: 'rect', x: [0, 2], y: [0, 1] }] });
  const m = toMesh2D(mesh2d(g, { hmax: 0.25, order: 2 }));
  const nn = m.nodes.length / 2, data = new Float64Array(nn);
  for (let i = 0; i < nn; i++) data[i] = f(m.nodes[2 * i]!, m.nodes[2 * i + 1]!);
  const loc = new Locator(m);
  let err = 0;
  for (let k = 0; k < 200; k++) {
    const x = 2 * ((k * 0.6180339887) % 1), y = (k * 0.7548776662) % 1, h = loc.locate(x, y)!;
    const gr = gradAt(m, { space: 'H1P2', data, components: 1 }, h.t, ...h.L);
    err = Math.max(err, Math.abs(gr[0] - (2 * x + 0.5 * y + 3)), Math.abs(gr[1] - (0.5 * x - 4 * y)));
  }
  assert.ok(err < 1e-9, `gradient err ${err}`);
});

test('accuracy verdict: no Richardson, no "within"; GCI against the case tolerance otherwise', () => {
  const base = { status: 'done', levels: [], next: null, def: { metric: 'K_t', quantity: { headline: 'kt' }, label: 'kt' }, reason: '', doneAt: 1, startedAt: 0, conv: { hFactors: [1, 0.5, 0.25], hNote: '', order: 2, fs: 1.25, tol: { rel: 1e-3 }, caseId: 'X' } } as unknown as AccState;
  const r = (available: boolean, gci: number | null) => ({ levels: 3, p_obs: 2, p_used: 2, f_fine: 1, f_ext: 1, r: 2, rel_change_last: 1e-4, gci_fine: gci, u_abs: gci, fs: 1.25, available, order_ratio: 1, band: 0.25 });
  assert.equal(verdict({ ...base, rich: [r(false, 1e-6)] }, 0).kind, 'na');
  assert.equal(verdict({ ...base, rich: [r(true, 1e-6)] }, 0).kind, 'within');
  assert.equal(verdict({ ...base, rich: [r(true, 1e-2)] }, 0).kind, 'above');
  assert.equal(verdict({ ...base, rich: [] }, 0).kind, 'na');
});
