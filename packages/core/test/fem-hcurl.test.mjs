// Ported from advanced-packaging-atlas/engine/tests/em3d-p2.test.mjs at fe39985 (GPL-3.0-or-later). Changes: only the
// element-level test 'L22 hierarchical basis' is kept (verbatim); the TE10 / coax / thin-conductor / lumped-port /
// PROM tests need the APA layered mesher and em3d solver (not in @amp/core) and run unchanged against the core
// modules in the atlas redirect check (DevLog-002 section 4). Imports: ../src/em3d/elements.mjs ->
// ../src/fem/nedelec1.mjs, ../src/em3d/hcurl.mjs -> ../src/fem/hcurl.mjs.
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tetGeometry, tetMatrices, faceMass } from '../src/fem/nedelec1.mjs';
import { tetMatricesP, triTraceMass } from '../src/fem/hcurl.mjs';

test('L22 hierarchical basis: order-1 tables = Whitney elements; edge gradients curl-free; order-2 mass SPD', () => {
  const nodes = Float64Array.from([0, 0, 0, 1.3e-6, 0.1e-6, 0, 0.2e-6, 1.1e-6, 0.1e-6, 0.3e-6, 0.2e-6, 0.9e-6]);
  const g = new Float64Array(12);
  const V = tetGeometry(nodes, [0, 1, 2, 3], g);
  const nu = { re: [1, 1.5, 0.7], im: [0, 0.2, -0.1] },
    eps = { re: [2, 3, 4], im: [0.1, 0, 0.3] };
  const a = [0, 1, 2, 3].map(() => new Float64Array(36)),
    b = [0, 1, 2, 3].map(() => new Float64Array(36));
  tetMatrices(g, V, nu, eps, ...a);
  tetMatricesP(1, g, V, nu, eps, ...b);
  let d = 0,
    mx = 0;
  for (let k = 0; k < 4; k++)
    for (let i = 0; i < 36; i++) {
      d = Math.max(d, Math.abs(a[k][i] - b[k][i]));
      mx = Math.max(mx, Math.abs(a[k][i]));
    }
  assert.ok(d / mx < 1e-14, `order 1 vs Whitney ${d / mx}`);
  const fm = faceMass(nodes, [0, 1, 2]).T,
    tm = triTraceMass(1, nodes, [0, 1, 2]).T;
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(fm[i] - tm[i]) < 1e-14 * Math.abs(fm[0]));
  const c = [0, 1, 2, 3].map(() => new Float64Array(400));
  tetMatricesP(2, g, V, nu, eps, ...c);
  let cmax = 0;
  for (const v of c[0]) cmax = Math.max(cmax, Math.abs(v));
  for (let i = 6; i < 12; i++) for (let j = 0; j < 20; j++) assert.equal(c[0][20 * i + j], 0);
  // real mass with eps = 1: Cholesky succeeds
  const M = new Float64Array(400);
  tetMatricesP(2, g, V, { re: [1, 1, 1], im: [0, 0, 0] }, { re: [1, 1, 1], im: [0, 0, 0] }, new Float64Array(400), new Float64Array(400), M, new Float64Array(400));
  const L = M.slice();
  for (let j = 0; j < 20; j++) {
    let s = L[21 * j];
    for (let k = 0; k < j; k++) s -= L[20 * j + k] ** 2;
    assert.ok(s > 0, 'mass SPD');
    L[21 * j] = Math.sqrt(s);
    for (let i = j + 1; i < 20; i++) {
      let t = L[20 * i + j];
      for (let k = 0; k < j; k++) t -= L[20 * i + k] * L[20 * j + k];
      L[20 * i + j] = t / L[21 * j];
    }
  }
});
