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
