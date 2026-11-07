// SPDX-License-Identifier: GPL-3.0-or-later
// Shift-invert driver on the tridiagonal Dirichlet Laplacian: lambda_j = 2 - 2 cos(j pi / (n + 1)), M = I.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftInvertEigen } from '../src/common/eigen.ts';

function tri(n: number) {
  const rowptr = new Int32Array(n + 1), col: number[] = [], K: number[] = [], M: number[] = [];
  for (let i = 0; i < n; i++) {
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < n) { col.push(j); K.push(j === i ? 2 : -1); M.push(j === i ? 1 : 0); }
    rowptr[i + 1] = col.length;
  }
  return { pat: { n, rowptr, colidx: Int32Array.from(col), nnz: col.length }, K: Float64Array.from(K), M: Float64Array.from(M) };
}
const exact = (n: number, j: number) => 2 - 2 * Math.cos((j * Math.PI) / (n + 1));

test('lowest modes, sigma < 0 (Cholesky)', () => {
  const n = 400, { pat, K, M } = tri(n);
  const r = shiftInvertEigen({ pat, K, M, sigma: -1e-3, nWant: 5, kPsd: true });
  assert.equal(r.stats.factor, 'cholesky');
  for (let j = 0; j < 5; j++) assert.ok(Math.abs(r.lambda[j]! - exact(n, j + 1)) < 1e-12 * exact(n, 1) * 1e3, `${j} ${r.lambda[j]} ${exact(n, j + 1)}`);
  assert.ok(Math.max(...r.residual) < 1e-9);
});

test('interior shift (LDLT) with inertia, and projector', () => {
  const n = 300, { pat, K, M } = tri(n);
  const sigma = 0.5 * (exact(n, 20) + exact(n, 21));
  const r = shiftInvertEigen({ pat, K, M, sigma, nWant: 4 });
  assert.equal(r.stats.factor, 'ldlt');
  assert.equal(r.stats.nNegative, 20);
  const want = [19, 20, 21, 22].map((j) => exact(n, j));
  for (let j = 0; j < 4; j++) assert.ok(Math.abs(r.lambda[j]! - want[j]!) < 1e-11, `${r.lambda[j]} ${want[j]}`);
  // remove the lowest eigenvector: the sigma < 0 run must then return modes 2..4
  const v1 = Float64Array.from({ length: n }, (_, i) => Math.sin(((i + 1) * Math.PI) / (n + 1)));
  const nv = Math.sqrt(v1.reduce((s, x) => s + x * x, 0)); v1.forEach((x, i) => (v1[i] = x / nv));
  const project = (x: Float64Array) => { let c = 0; for (let i = 0; i < n; i++) c += x[i]! * v1[i]!; for (let i = 0; i < n; i++) x[i]! -= c * v1[i]!; };
  const p = shiftInvertEigen({ pat, K, M, sigma: -1e-3, nWant: 3, kPsd: true, project });
  for (let j = 0; j < 3; j++) assert.ok(Math.abs(p.lambda[j]! - exact(n, j + 2)) < 1e-11, `${p.lambda[j]} ${exact(n, j + 2)}`);
});
