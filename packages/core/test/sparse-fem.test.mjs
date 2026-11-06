// Ported from eo-modulator-atlas/engine/tests/perf-sparse.test.mjs at 0546007 (GPL-3.0-or-later). Changes: femMatrix
// builds the same problem (domain [0, 3] x [0, 2], inclusion triangle, electrode rect(0.2, 0.6, 0.2, 0.4) and x = 0
// Dirichlet, anisotropic eps per triangle) on a structured triangle mesh from helpers/tri-grid.mjs (graded towards
// the electrode) instead of the EO mesher (section.mjs, lane L3); maxEdge maps to the grid spacing. Assembly and
// restriction use the ported fem/tri.mjs. Test bodies verbatim. APA's port of this file (la-sparse.test.mjs, hex
// fixture) is also kept in test/la-sparse.test.mjs.
// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPattern, amdOrder, ndOrder, analyze, factorNumeric, solveNumeric, solveNumericMulti, SparseCholesky, UpLookingCholesky, matVec, entryIndex } from '../src/la/sparse.mjs';
import { triangleGeometry, assemble, restrictMatrix } from '../src/fem/tri.mjs';
import { lines, triGrid, inRect } from './helpers/tri-grid.mjs';

const inTri = ([[ax, ay], [bx, by], [cx, cy]]) => (x, y) => {
  const s = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (rx - px) * (qy - py);
  const d1 = s(ax, ay, bx, by, x, y), d2 = s(bx, by, cx, cy, x, y), d3 = s(cx, cy, ax, ay, x, y);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
};

function femMatrix(maxEdge = 0.12) {
  const incl = inTri([[1, 0.5], [2.2, 0.7], [1.6, 1.5]]), elec = inRect(0.2, 0.6, 0.2, 0.4);
  const xs = lines([0, 0.2, 0.6, 3], maxEdge, 1.05), ys = lines([0, 0.2, 0.4, 2], maxEdge, 1.05);
  const mesh = triGrid(xs, ys, (x, y) => (incl(x, y) ? 1 : 0));
  const geo = triangleGeometry(mesh);
  const pat = buildPattern(mesh.nNodes, mesh.tri);
  const n = mesh.nNodes;
  const eps = new Float64Array(3 * mesh.nTris);
  for (let t = 0; t < mesh.nTris; t++) { eps[3 * t] = 1 + (mesh.triRegion[t] ? 3 : 0); eps[3 * t + 1] = 0.2; eps[3 * t + 2] = 2; }
  const K = assemble(mesh, geo, pat, eps, null);
  const free = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) if (elec(mesh.x[i], mesh.y[i]) || mesh.x[i] === 0) free[i] = 0;
  return { mesh, sub: restrictMatrix(pat, K, free) };
}
const isPerm = (p, n) => p.length === n && new Set(p).size === n && Math.min(...p) === 0 && Math.max(...p) === n - 1;

test('buildPattern rows are sorted, unique, symmetric and contain the diagonal and every triangle edge', () => {
  const { mesh } = femMatrix(0.3);
  const pat = buildPattern(mesh.nNodes, mesh.tri);
  for (let i = 0; i < pat.n; i++) {
    for (let p = pat.rowptr[i] + 1; p < pat.rowptr[i + 1]; p++) assert.ok(pat.colidx[p] > pat.colidx[p - 1]);
    assert.ok(entryIndex(pat, i, i) >= 0);
    for (let p = pat.rowptr[i]; p < pat.rowptr[i + 1]; p++) assert.ok(entryIndex(pat, pat.colidx[p], i) >= 0);
  }
  for (let t = 0; t < mesh.nTris; t++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) assert.ok(entryIndex(pat, mesh.tri[3 * t + a], mesh.tri[3 * t + b]) >= 0);
});

test('AMD returns a permutation and beats coordinate-bisection ND on fill for a graded FEM mesh', () => {
  const { mesh, sub } = femMatrix();
  const n = sub.nf;
  const perm = amdOrder(sub.pat);
  assert.ok(isPerm(perm, n));
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < mesh.nNodes; i++) if (sub.map[i] >= 0) { x[sub.map[i]] = mesh.x[i]; y[sub.map[i]] = mesh.y[i]; }
  const amd = analyze(sub.pat, { perm });
  const nd = analyze(sub.pat, { perm: ndOrder(sub.pat, x, y) });
  assert.ok(amd.nnzL < nd.nnzL, `AMD ${amd.nnzL} vs ND ${nd.nnzL}`);
});

test('symbolic column counts equal the up-looking factor structure; supernode rows start with their own columns', () => {
  const { sub } = femMatrix(0.2);
  for (const relax of [false, true]) {
    const sym = analyze(sub.pat, { relax });
    const up = new UpLookingCholesky(sub.pat, sym.perm);
    assert.equal(sym.nnzL, up.nnzL);
    for (let j = 0; j < sym.n; j++) assert.equal(sym.colCount[j], up.Lp[j + 1] - up.Lp[j]);
    assert.ok(isPerm(sym.perm, sym.n));
    for (let s = 0; s < sym.nsuper; s++) {
      const f = sym.superStart[s], nc = sym.superStart[s + 1] - f;
      for (let c = 0; c < nc; c++) assert.equal(sym.Si[sym.Sp[s] + c], f + c);
      for (let r = sym.Sp[s] + 1; r < sym.Sp[s + 1]; r++) assert.ok(sym.Si[r] > sym.Si[r - 1]);
    }
    if (!relax) assert.equal(sym.nnzLStored - sym.superStart.reduce((a, f, s) => (s < sym.nsuper ? a + ((sym.superStart[s + 1] - f) * (sym.superStart[s + 1] - f - 1)) / 2 : a), 0), sym.nnzL);
  }
});

test('supernodal factor matches the up-looking oracle to round-off and reuses its symbolic analysis', () => {
  const { sub } = femMatrix();
  const n = sub.nf;
  const b = Float64Array.from({ length: n }, (_, i) => Math.sin(0.7 * i) + 0.3);
  const sn = new SparseCholesky(sub.pat);
  assert.ok(sn.factor(sub.val));
  const up = new UpLookingCholesky(sub.pat, sn.perm);
  assert.ok(up.factor(sub.val));
  const xs = sn.solve(b), xu = up.solve(b);
  let d = 0, m = 0;
  for (let i = 0; i < n; i++) { d = Math.max(d, Math.abs(xs[i] - xu[i])); m = Math.max(m, Math.abs(xu[i])); }
  assert.ok(d / m < 1e-12, `${d / m}`);
  const r = matVec(sub.pat, sub.val, xs);
  let rr = 0, bb = 0;
  for (let i = 0; i < n; i++) { rr += (r[i] - b[i]) ** 2; bb += b[i] ** 2; }
  assert.ok(Math.sqrt(rr / bb) < 1e-12);
  // reuse: scaled matrix, same symbolic object
  const v2 = sub.val.map((v) => 2 * v);
  const sn2 = new SparseCholesky(sub.pat, null, { sym: sn.sym });
  assert.equal(sn2.timing.symbolicReused, true);
  assert.ok(sn2.factor(v2));
  const x2 = sn2.solve(b);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(2 * x2[i] - xs[i]) <= 1e-12 * m);
});

test('supernodal factor reports an indefinite matrix instead of returning a factor', () => {
  const { sub } = femMatrix(0.3);
  const v = sub.val.slice();
  for (let i = 0; i < sub.nf; i++) v[entryIndex(sub.pat, i, i)] -= 1e3;
  const sn = new SparseCholesky(sub.pat);
  assert.equal(sn.factor(v), false);
  assert.throws(() => sn.solve(new Float64Array(sub.nf)), /without a successful factorization/);
});

test('a symbolic analysis from a different pattern with the same size is rejected (audit P1)', () => {
  const { sub } = femMatrix(0.3);
  const sym = analyze(sub.pat);
  // same n and nnz, one column index changed (the audit's edge-swap variants factor without error yet solve wrongly)
  const other = { ...sub.pat, colidx: sub.pat.colidx.slice() };
  const last = other.rowptr[1] - 1;
  other.colidx[last] = (other.colidx[last] + 1) % other.n;
  assert.throws(() => new SparseCholesky(other, null, { sym }), /different sparsity pattern/);
  assert.throws(() => factorNumeric(sym, sub.val, null, other), /different sparsity pattern/);
  assert.throws(() => factorNumeric(sym, sub.val.subarray(1)), /values for a pattern/);
});

test('empty pattern, nd without coordinates and solves after a failed factorization (audit P5, P1)', () => {
  const empty = { n: 0, rowptr: new Int32Array(1), colidx: new Int32Array(0), nnz: 0 };
  const ch = new SparseCholesky(empty);
  assert.ok(ch.factor(new Float64Array(0)));
  assert.equal(ch.solve(new Float64Array(0)).length, 0);
  const { sub } = femMatrix(0.3);
  assert.throws(() => analyze(sub.pat, { ordering: 'nd' }), /needs node coordinates/);
  const v = sub.val.map((x) => -x);
  const num = factorNumeric(analyze(sub.pat), v);
  assert.equal(num.ok, false);
  assert.throws(() => solveNumeric(num, new Float64Array(sub.nf)), /no successful numeric factorization/);
  assert.throws(() => solveNumericMulti(num, [new Float64Array(sub.nf), new Float64Array(sub.nf)]), /no successful numeric factorization/);
});
