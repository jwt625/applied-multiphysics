// SPDX-License-Identifier: GPL-3.0-or-later
// WASM triangular solves of the real supernodal factors (la/wasm/solve-real.mjs, lane S4 DevLog-045): solutions must be
// bitwise identical to the JS solves for Cholesky (solveNumeric, solveNumericMulti) and LDL^T (solve, solveMany),
// including odd sizes, exact zeros in L and in the right-hand side (skip paths), -0, NaN / Inf, multi-vector blocks
// larger than the workspace (QCAP chunks), and the fallbacks (small factor, 'js' at allocation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildElementPattern, analyze, SparseCholesky, solveNumericMulti } from '../src/la/sparse.mjs';
import { SupernodalLDLT } from '../src/la/ldlt.mjs';
import { DEFAULT_REAL_SOLVE, setDefaultRealSolve, wasmSolveSupported, SOLVE_MIN_NNZL, QCAP } from '../src/la/wasm/solve-real.mjs';

const skip = !wasmSolveSupported() && 'no WebAssembly SIMD';

/** 27-point (hex element) pattern on an Nx x Ny x Nz node grid; symmetric SPD values (shift > 0: indefinite). */
function grid(Nx, Ny, Nz, { zeroEvery = 0, shift = 0 } = {}) {
  const n = Nx * Ny * Nz, el = [];
  const id = (i, j, k) => i + Nx * (j + Ny * k);
  for (let k = 0; k + 1 < Nz; k++)
    for (let j = 0; j + 1 < Ny; j++)
      for (let i = 0; i + 1 < Nx; i++)
        for (const [a, b, c] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]) el.push(id(i + a, j + b, k + c));
  const pat = buildElementPattern(n, Int32Array.from(el), 8);
  const v = new Float64Array(pat.nnz);
  for (let r = 0; r < n; r++)
    for (let p = pat.rowptr[r]; p < pat.rowptr[r + 1]; p++) {
      const c = pat.colidx[p];
      if (c === r) v[p] = 26.5 + 0.01 * (r % 7) - shift;
      else v[p] = zeroEvery && (r + c) % zeroEvery === 0 ? 0 : -1 + 0.001 * ((Math.min(r, c) * 31 + Math.max(r, c) * 17) % 11);
    }
  return { pat, v, n };
}

let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
function rhs(n, { zeros = 0, special = false } = {}) {
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) b[i] = zeros && i % zeros === 0 ? (i % (2 * zeros) === 0 ? -0 : 0) : rnd();
  if (special) { b[1] = NaN; b[n - 2] = Infinity; b[n >> 1] = 5e-324; }
  return b;
}
const bitwise = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
function withSolve(kind, fn) {
  const old = DEFAULT_REAL_SOLVE;
  setDefaultRealSolve(kind);
  try { return fn(); } finally { setDefaultRealSolve(old); }
}

test('real solve selector: default wasm; unknown kind rejected', () => {
  assert.equal(DEFAULT_REAL_SOLVE, 'wasm');
  assert.throws(() => setDefaultRealSolve('fast'), /unknown real solve/);
});

for (const [name, dims, opt] of [
  ['cube 12^3', [12, 12, 12], {}],
  ['slab 29 x 9 x 7 (odd sizes)', [29, 9, 7], {}],
  ['cube 11^3 with exact zeros in L', [11, 11, 11], { zeroEvery: 3 }],
]) {
  test(`Cholesky solve wasm = js bitwise: ${name}`, { skip }, () => {
    const { pat, v, n } = grid(...dims, opt);
    const ch = new SparseCholesky(pat);
    assert.ok(ch.factor(v));
    assert.ok(Number(ch.nnzL) >= SOLVE_MIN_NNZL, `nnzL ${ch.nnzL} uses the wasm storage`);
    assert.ok(ch.num.ws, 'factor storage in WebAssembly memory');
    for (const o of [{}, { zeros: 3 }, { special: true }]) {
      const b = rhs(n, o);
      const xw = withSolve('wasm', () => ch.solve(b));
      const xj = withSolve('js', () => ch.solve(b));
      assert.ok(bitwise(xw, xj), `single solve ${JSON.stringify(o)}`);
    }
    // multi-vector (wasm runs one vector at a time; js sweeps supernode by supernode)
    const bs = [rhs(n), rhs(n, { zeros: 4 }), rhs(n)];
    const mw = withSolve('wasm', () => solveNumericMulti(ch.num, bs));
    const mj = withSolve('js', () => solveNumericMulti(ch.num, bs));
    for (let k = 0; k < bs.length; k++) assert.ok(bitwise(mw[k], mj[k]), `multi vector ${k}`);
    // residual sanity
    const x = mw[0], b = bs[0];
    let rr = 0, bb = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let q = pat.rowptr[i]; q < pat.rowptr[i + 1]; q++) s += v[q] * x[pat.colidx[q]];
      rr += (s - b[i]) ** 2; bb += b[i] ** 2;
    }
    assert.ok(Math.sqrt(rr / bb) < 1e-12);
  });

  test(`LDL^T solve wasm = js bitwise (indefinite): ${name}`, { skip }, () => {
    const { pat, v, n } = grid(...dims, { ...opt, shift: 30 });
    const f = new SupernodalLDLT(analyze(pat));
    const r = f.factor(v);
    assert.ok(r.ok && r.nNeg > 0, 'indefinite factor');
    assert.ok(f.ws, 'factor storage in WebAssembly memory');
    for (const o of [{}, { zeros: 3 }, { special: true }]) {
      const b = rhs(n, o);
      assert.ok(bitwise(withSolve('wasm', () => f.solve(b)), withSolve('js', () => f.solve(b))), `single solve ${JSON.stringify(o)}`);
    }
    for (const q of [1, 2, 3, 4, QCAP + 3]) {
      const b = new Float64Array(n * q);
      for (let k = 0; k < q; k++) b.set(rhs(n, { zeros: k % 2 ? 5 : 0 }), k * n);
      const xw = withSolve('wasm', () => f.solveMany(b, q));
      const xj = withSolve('js', () => f.solveMany(b, q));
      assert.ok(bitwise(xw, xj), `solveMany q = ${q}`);
    }
  });
}

test('fallbacks: small factors and factors allocated under js keep plain arrays and solve in JS', { skip }, () => {
  const small = grid(5, 5, 5);
  const c1 = new SparseCholesky(small.pat);
  assert.ok(c1.factor(small.v));
  assert.ok(Number(c1.nnzL) < SOLVE_MIN_NNZL);
  assert.equal(c1.num.ws, null);
  const big = grid(12, 12, 12);
  const c2 = withSolve('js', () => { const c = new SparseCholesky(big.pat); c.factor(big.v); return c; });
  assert.equal(c2.num.ws, null);
  const c3 = new SparseCholesky(big.pat);
  c3.factor(big.v);
  const b = rhs(big.n);
  assert.ok(bitwise(c2.solve(b), c3.solve(b)), 'js-storage factor and wasm-storage factor give the same solution');
  // refactor with new values on the same storage (num reused)
  const v2 = big.v.map((x, i) => (big.pat.colidx[i] === 0 ? x : x * 1.0001));
  c3.factor(v2);
  const c4 = withSolve('js', () => { const c = new SparseCholesky(big.pat); c.factor(v2); return c; });
  assert.ok(bitwise(c3.solve(b), c4.solve(b)), 'refactor on reused wasm storage');
});
