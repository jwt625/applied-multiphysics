// SPDX-License-Identifier: GPL-3.0-or-later
// L1 additions (new tests, not ports): direct checks of extracted solvers whose atlas tests exercise them only through
// physics modules (EO vector-mode / semi, APA em3d). The atlas tests themselves run against these core modules in
// the redirect check (DevLog-002 section 4). References are closed forms: eigenvalues of the 1D Dirichlet Laplacian
// stencil tridiag(-1, 2, -1) are 2 - 2 cos(k pi / (n + 1)); the companion matrix of prod (x - r_i) has eigenvalues r_i.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildElementPattern, SparseCholesky } from '../src/la/sparse.mjs';
import { SymbolicLDLT, LDLT } from '../src/la/ldlt.mjs';
import { blockArnoldi } from '../src/la/arnoldi.mjs';
import { eigenvalues, realEigenvectors } from '../src/la/vector-dense.mjs';
import { gmres as gmresReal } from '../src/la/gmres-real.mjs';
import { gmres as gmresComplex } from '../src/la/krylov.mjs';
import { buildAMG } from '../src/la/amg.mjs';
import { nd3Order } from '../src/la/order3d.mjs';
import { CMat, cmatSolve, cmatMul, cmatEig } from '../src/la/dense.mjs';
import { analyze } from '../src/la/sparse.mjs';

/** 1D chain pattern and tridiag(-1, d, -1) values (full CSR, as buildElementPattern stores it). */
function chain(n, diag = 2, off = -1) {
  const el = new Int32Array(2 * (n - 1));
  for (let i = 0; i + 1 < n; i++) { el[2 * i] = i; el[2 * i + 1] = i + 1; }
  const pat = buildElementPattern(n, el, 2);
  const val = new Float64Array(pat.nnz);
  for (let r = 0; r < n; r++) for (let p = pat.rowptr[r]; p < pat.rowptr[r + 1]; p++) val[p] = pat.colidx[p] === r ? diag : off;
  return { pat, val };
}
const lap1d = (n, k) => 2 - 2 * Math.cos((k * Math.PI) / (n + 1));

/** 3D 7-point Laplacian on an m^3 interior grid (Dirichlet), CSR with sorted columns. */
function lap3d(m) {
  const n = m ** 3, id = (i, j, k) => i + m * (j + m * k);
  const rowptr = new Int32Array(n + 1), cols = [], vals = [];
  for (let k = 0; k < m; k++) for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const r = id(i, j, k), nb = [];
    if (k > 0) nb.push(id(i, j, k - 1));
    if (j > 0) nb.push(id(i, j - 1, k));
    if (i > 0) nb.push(id(i - 1, j, k));
    nb.push(r);
    if (i < m - 1) nb.push(id(i + 1, j, k));
    if (j < m - 1) nb.push(id(i, j + 1, k));
    if (k < m - 1) nb.push(id(i, j, k + 1));
    for (const c of nb) { cols.push(c); vals.push(c === r ? 6 : -1); }
    rowptr[r + 1] = cols.length;
  }
  return { n, rowptr, colidx: Int32Array.from(cols), val: Float64Array.from(vals), nnz: cols.length };
}
const spmv = (A, x, y) => { for (let i = 0; i < A.n; i++) { let s = 0; for (let p = A.rowptr[i]; p < A.rowptr[i + 1]; p++) s += A.val[p] * x[A.colidx[p]]; y[i] = s; } };

test('vector-dense: Hessenberg + Francis QR eigenvalues of a companion matrix; real eigenvectors', () => {
  // p(x) = (x - 1)(x - 2)(x - 3)(x + 0.5)(x^2 + 1): roots 1, 2, 3, -0.5, +-i
  const roots = [[1, 0], [2, 0], [3, 0], [-0.5, 0], [0, 1], [0, -1]];
  let c = [{ re: 1, im: 0 }];
  for (const [r, i] of roots) {
    const nx = Array.from({ length: c.length + 1 }, () => ({ re: 0, im: 0 }));
    c.forEach((a, k) => { nx[k].re += a.re; nx[k].im += a.im; nx[k + 1].re -= a.re * r - a.im * i; nx[k + 1].im -= a.re * i + a.im * r; });
    c = nx;
  }
  const n = 6, A = new Float64Array(n * n);
  for (let j = 0; j < n; j++) A[j] = -c[j + 1].re;
  for (let i = 1; i < n; i++) A[i * n + i - 1] = 1;
  const { re, im } = eigenvalues(A, n);
  const got = Array.from(re, (r, k) => [r, im[k]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const want = roots.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (let k = 0; k < n; k++) assert.ok(Math.hypot(got[k][0] - want[k][0], got[k][1] - want[k][1]) < 1e-10, `${got[k]} vs ${want[k]}`);
  const [v] = realEigenvectors(A, n, [3]);
  const Av = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Av[i] += A[i * n + j] * v[j];
  for (let i = 0; i < n; i++) assert.ok(Math.abs(Av[i] - 3 * v[i]) < 1e-9 * Math.max(...v.map(Math.abs)));
});

test('arnoldi: shift-invert block Arnoldi (thick restart) finds the lowest 1D Laplacian eigenvalues', () => {
  const n = 400, { pat, val } = chain(n);
  const ch = new SparseCholesky(pat);
  assert.ok(ch.factor(val));
  for (const blockSize of [1, 2]) {
    const op = (X) => X.map((x) => ch.solve(x));
    const ar = blockArnoldi(n, op, { nWant: 4, blockSize, maxBasis: 20, tol: 1e-10, X0: null, maxRestarts: 30, seed: 20261014, realOnly: true });
    assert.ok(ar.converged, `block ${blockSize}`);
    const lam = ar.mu.map((m) => 1 / m.re).sort((a, b) => a - b);
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(lam[k] / lap1d(n, k + 1) - 1) < 1e-9, `block ${blockSize}, k ${k + 1}: ${lam[k]} vs ${lap1d(n, k + 1)}`);
    for (const v of ar.vecs) { const y = ch.solve(v.re); const mu = v.re.reduce((s, x, i) => s + x * y[i], 0) / v.re.reduce((s, x) => s + x * x, 0); assert.ok(mu > 0); }
  }
});

test('arnoldi: indefinite shift (LDL^T at sigma between eigenvalues) gives the eigenvalues nearest sigma', () => {
  const n = 300, { pat } = chain(n);
  const sigma = 0.5 * (lap1d(n, 10) + lap1d(n, 11));
  const { val } = chain(n, 2 - sigma, -1);
  const sym = new SymbolicLDLT(pat, analyze(pat).perm);
  const f = new LDLT(sym);
  const r = f.factor(val);
  assert.ok(r.ok);
  assert.equal(r.nNeg, 10); // Sylvester: 10 eigenvalues below sigma
  const op = (X) => X.map((x) => f.solve(x));
  const ar = blockArnoldi(n, op, { nWant: 2, blockSize: 1, maxBasis: 20, tol: 1e-10, X0: null, maxRestarts: 30, seed: 7, realOnly: true });
  assert.ok(ar.converged);
  const lam = ar.mu.map((m) => sigma + 1 / m.re).sort((a, b) => a - b);
  assert.ok(Math.abs(lam[0] / lap1d(n, 10) - 1) < 1e-9 && Math.abs(lam[1] / lap1d(n, 11) - 1) < 1e-9, `${lam}`);
});

test('gmres-real: restarted right-preconditioned GMRES on a nonsymmetric convection-diffusion chain', () => {
  const n = 500, { pat } = chain(n);
  const val = new Float64Array(pat.nnz);
  for (let r = 0; r < n; r++) for (let p = pat.rowptr[r]; p < pat.rowptr[r + 1]; p++) { const c = pat.colidx[p]; val[p] = c === r ? 2.2 : c < r ? -1.3 : -0.7; }
  const mv = (x, y) => { for (let i = 0; i < n; i++) { let s = 0; for (let p = pat.rowptr[i]; p < pat.rowptr[i + 1]; p++) s += val[p] * x[pat.colidx[p]]; y[i] = s; } };
  const b = Float64Array.from({ length: n }, (_, i) => Math.sin(0.1 * i) + 1);
  const r = gmresReal(mv, (v, out) => { for (let i = 0; i < n; i++) out[i] = v[i] / 2.2; }, b, { tol: 1e-12, restart: 40, maxIter: 2000 });
  assert.ok(r.converged, `relres ${r.relres}`);
  const y = new Float64Array(n);
  mv(r.x, y);
  let e = 0, bn = 0;
  for (let i = 0; i < n; i++) { e += (y[i] - b[i]) ** 2; bn += b[i] ** 2; }
  assert.ok(Math.sqrt(e / bn) < 1e-11);
});

test('krylov: complex GMRES (right preconditioning) on a complex-symmetric Helmholtz-type chain', () => {
  const n = 400, { pat } = chain(n);
  const re = new Float64Array(pat.nnz), im = new Float64Array(pat.nnz);
  for (let r = 0; r < n; r++) for (let p = pat.rowptr[r]; p < pat.rowptr[r + 1]; p++) { const d = pat.colidx[p] === r; re[p] = d ? 2 - 0.05 : -1; im[p] = d ? 0.02 : 0; }
  const op = (xr, xi, yr, yi) => {
    for (let i = 0; i < n; i++) {
      let sr = 0, si = 0;
      for (let p = pat.rowptr[i]; p < pat.rowptr[i + 1]; p++) { const c = pat.colidx[p]; sr += re[p] * xr[c] - im[p] * xi[c]; si += re[p] * xi[c] + im[p] * xr[c]; }
      yr[i] = sr; yi[i] = si;
    }
  };
  const br = Float64Array.from({ length: n }, (_, i) => Math.cos(0.05 * i)), bi = new Float64Array(n);
  const r = gmresComplex(op, null, br, bi, { rtol: 1e-10, maxIter: 3000, restart: 60 });
  assert.ok(r.converged, `relres ${r.relres}`);
  const yr = new Float64Array(n), yi = new Float64Array(n);
  op(r.re, r.im, yr, yi);
  let e = 0, bn = 0;
  for (let i = 0; i < n; i++) { e += (yr[i] - br[i]) ** 2 + yi[i] ** 2; bn += br[i] ** 2; }
  assert.ok(Math.sqrt(e / bn) < 1e-9);
});

test('amg: smoothed-aggregation V-cycle preconditions PCG on a 3D Laplacian (APA status line: 10-19 iterations)', () => {
  const A = lap3d(24);
  const amg = buildAMG(A);
  assert.ok(amg.levels.length >= 2);
  const n = A.n, b = Float64Array.from({ length: n }, (_, i) => Math.sin(i) + 0.5);
  const x = new Float64Array(n), r = b.slice(), z = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n);
  amg.cycle(r, z);
  p.set(z);
  let rz = r.reduce((s, v, i) => s + v * z[i], 0);
  const bn = Math.hypot(...b);
  let it = 0;
  for (; it < 200; it++) {
    spmv(A, p, q);
    const alpha = rz / p.reduce((s, v, i) => s + v * q[i], 0);
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * q[i]; }
    if (Math.hypot(...r) / bn < 1e-10) { it++; break; }
    amg.cycle(r, z);
    const rz2 = r.reduce((s, v, i) => s + v * z[i], 0);
    for (let i = 0; i < n; i++) p[i] = z[i] + (rz2 / rz) * p[i];
    rz = rz2;
  }
  assert.ok(it <= 30, `PCG + AMG iterations ${it}`);
});

test('order3d: nested dissection by 3D coordinate bisection returns a permutation with less fill than natural order', () => {
  const m = 12, A = lap3d(m);
  const x = new Float64Array(A.n), y = new Float64Array(A.n), z = new Float64Array(A.n);
  for (let k = 0, q = 0; k < m; k++) for (let j = 0; j < m; j++) for (let i = 0; i < m; i++, q++) { x[q] = i; y[q] = j; z[q] = k; }
  const pat = { n: A.n, rowptr: A.rowptr, colidx: A.colidx, nnz: A.nnz };
  const perm = nd3Order(pat, x, y, z, { leaf: 64 });
  assert.equal(new Set(perm).size, A.n);
  const nd = analyze(pat, { perm }), nat = analyze(pat, { perm: Int32Array.from({ length: A.n }, (_, i) => i) });
  assert.ok(nd.nnzL < nat.nnzL, `${nd.nnzL} vs ${nat.nnzL}`);
});

test('dense (complex): LU solve and eigen-decomposition of a small complex matrix', () => {
  const A = new CMat(3);
  const vals = [[2, 1], [0.5, -0.3], [0, 0.2], [0.1, 0], [3, -1], [0.4, 0.4], [0, 0], [0.2, 0.1], [1, 2]];
  vals.forEach(([r, i], k) => { A.re[k] = r; A.im[k] = i; });
  const B = new CMat(3, 1);
  B.re[0] = 1; B.im[1] = 2; B.re[2] = -1;
  const X = cmatSolve(A, B), AX = cmatMul(A, X);
  for (let k = 0; k < 3; k++) assert.ok(Math.hypot(AX.re[k] - B.re[k], AX.im[k] - B.im[k]) < 1e-13);
  const e = cmatEig(A);
  // A v = lambda v for every eigenpair
  for (let k = 0; k < 3; k++) {
    const v = new CMat(3, 1);
    for (let i = 0; i < 3; i++) { v.re[i] = e.vectors.re[i * 3 + k]; v.im[i] = e.vectors.im[i * 3 + k]; }
    const Av = cmatMul(A, v), lr = e.values.re[k], li = e.values.im[k];
    for (let i = 0; i < 3; i++) assert.ok(Math.hypot(Av.re[i] - (lr * v.re[i] - li * v.im[i]), Av.im[i] - (lr * v.im[i] + li * v.re[i])) < 1e-12);
  }
});
