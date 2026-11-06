// SPDX-License-Identifier: GPL-3.0-or-later
// L1 addition (new test): every quadrature rule in fem/quadrature.mjs integrates barycentric monomials up to its
// stated degree exactly, against the closed form int prod l^a / |T| = a! d! / (|a| + d)! (simplexMoment).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRI_Q4, TRI_QUAD, GAUSS01, simplexMoment } from '../src/fem/quadrature.mjs';

const monomials = (deg) => { const out = []; for (let a = 0; a <= deg; a++) for (let b = 0; a + b <= deg; b++) for (let c = 0; a + b + c <= deg; c++) out.push([a, b, c]); return out; };

test('triangle rules: TRI_Q4 exact to degree 4, TRI_QUAD exact to degree 6', () => {
  for (const [rule, deg, at] of [[TRI_Q4, 4, (q) => [q.slice(0, 3), q[3]]], [TRI_QUAD, 6, (q) => q]]) {
    let wsum = 0;
    for (const q of rule) wsum += at(q)[1];
    assert.ok(Math.abs(wsum - 1) < 1e-14);
    for (const al of monomials(deg)) {
      let s = 0;
      for (const q of rule) { const [l, w] = at(q); s += w * l[0] ** al[0] * l[1] ** al[1] * l[2] ** al[2]; }
      assert.ok(Math.abs(s - simplexMoment(al, 2)) < 1e-13, `${al}: ${s} vs ${simplexMoment(al, 2)}`);
    }
  }
});

test('Gauss-Legendre on [0, 1]: n points exact to degree 2n - 1', () => {
  for (const n of [2, 3]) {
    const g = GAUSS01[n];
    for (let p = 0; p <= 2 * n - 1; p++) {
      let s = 0;
      for (let q = 0; q < n; q++) s += g.w[q] * g.x[q] ** p;
      assert.ok(Math.abs(s - 1 / (p + 1)) < 1e-15, `n ${n}, x^${p}`);
    }
  }
});
