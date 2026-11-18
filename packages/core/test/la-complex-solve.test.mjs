// SPDX-License-Identifier: GPL-3.0-or-later
// WASM triangular solve of the complex-symmetric supernodal LDL^T (la/wasm/solve-complex.mjs, lane E8 DevLog-054):
// solutions bitwise identical to the JS solve for ComplexSupernodalLDLT, BlockedComplexLDLT and WasmComplexLDLT,
// including exact zeros in L and in the right-hand side (skip path), -0, NaN / Inf, perturbed pivots, refinement, and
// the fallbacks (small factor, 'js' at allocation, 'js' at solve time on WASM storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildElementPattern, analyze } from '../src/la/sparse.mjs';
import { ComplexSupernodalLDLT } from '../src/la/ldlt.mjs';
import { BlockedComplexLDLT } from '../src/la/ldlt-blocked.mjs';
import { WasmComplexLDLT, wasmLdltSupported } from '../src/la/ldlt-wasm.mjs';
import { DEFAULT_COMPLEX_SOLVE, setDefaultComplexSolve, wasmComplexSolveSupported, CSOLVE_MIN_NNZL, complexSolveModuleBytes } from '../src/la/wasm/solve-complex.mjs';

const skip = !wasmComplexSolveSupported() && 'no WebAssembly SIMD';

/** 27-point pattern on an N^3 grid, complex-symmetric values (shift: indefinite real part). */
function grid(N, { zeroEvery = 0, shift = 0 } = {}) {
  const n = N * N * N, el = [];
  const id = (i, j, k) => i + N * (j + N * k);
  for (let k = 0; k + 1 < N; k++)
    for (let j = 0; j + 1 < N; j++)
      for (let i = 0; i + 1 < N; i++)
        for (const [a, b, c] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]) el.push(id(i + a, j + b, k + c));
  const pat = buildElementPattern(n, Int32Array.from(el), 8);
  const re = new Float64Array(pat.nnz), im = new Float64Array(pat.nnz);
  for (let r = 0; r < n; r++)
    for (let p = pat.rowptr[r]; p < pat.rowptr[r + 1]; p++) {
      const c = pat.colidx[p], lo = Math.min(r, c), hi = Math.max(r, c);
      if (c === r) { re[p] = 26.5 + 0.01 * (r % 7) - shift; im[p] = 0.2 + 0.001 * (r % 5); }
      else {
        re[p] = zeroEvery && (r + c) % zeroEvery === 0 ? 0 : -1 + 0.001 * ((lo * 31 + hi * 17) % 11);
        im[p] = (lo + hi) % 3 === 0 ? 0 : 0.01 * ((lo * 7 + hi) % 5);
      }
    }
  return { pat, re, im, n };
}

let seed = 4242;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
function rhs(n, { zeros = 0, special = false } = {}) {
  const br = new Float64Array(n), bi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const z = zeros && i % zeros === 0;
    br[i] = z ? (i % (2 * zeros) === 0 ? -0 : 0) : rnd();
    bi[i] = z ? 0 : i % 4 === 1 ? -0 : rnd();
  }
  if (special) { br[1] = NaN; bi[n - 2] = Infinity; br[n >> 1] = 5e-324; }
  return { br, bi };
}
const same = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

function factorPair(Cls, g, kindA, kindB) {
  const sym = analyze(g.pat);
  const prev = DEFAULT_COMPLEX_SOLVE;
  try {
    setDefaultComplexSolve(kindA);
    const A = new Cls(sym);
    setDefaultComplexSolve(kindB);
    const B = new Cls(sym);
    A.factor(g.re, g.im);
    B.factor(g.re, g.im);
    return { A, B, sym };
  } finally { setDefaultComplexSolve(prev); }
}

test('complex solve module: size below 4 KB (synchronous compile on a main thread)', { skip }, () => {
  assert.ok(complexSolveModuleBytes() < 4096);
});

for (const [name, Cls] of [['base', ComplexSupernodalLDLT], ['blocked', BlockedComplexLDLT], ...(wasmLdltSupported() ? [['wasm-front', WasmComplexLDLT]] : [])]) {
  test(`complex solve ${name}: WASM bitwise identical to JS (zeros, -0, NaN / Inf, skip paths)`, { skip }, () => {
    for (const [N, opt] of [[9, {}], [12, { zeroEvery: 5 }], [11, { shift: 30 }]]) {
      const g = grid(N, opt);
      const { A, B } = factorPair(Cls, g, 'js', 'wasm');
      assert.equal(A._cws, null, 'js at allocation: plain arrays');
      assert.ok(B._cws, `wasm storage expected (nnzL ${B.Lr.length} >= ${CSOLVE_MIN_NNZL})`);
      assert.ok(same(A.Lr, B.Lr) && same(A.Li, B.Li) && same(A.Dr, B.Dr) && same(A.Di, B.Di), 'factor independent of storage');
      for (const o of [{}, { zeros: 3 }, { special: true }, { zeros: 2, special: true }]) {
        const { br, bi } = rhs(g.n, o);
        const x = A.solve(br, bi), y = B.solve(br, bi);
        assert.ok(same(x.re, y.re) && same(x.im, y.im), `N ${N} ${JSON.stringify(opt)} rhs ${JSON.stringify(o)}`);
      }
      // refinement (several solves) and residual check
      const { br, bi } = rhs(g.n);
      const rx = A.solveRefined(g.pat, g.re, g.im, br, bi), ry = B.solveRefined(g.pat, g.re, g.im, br, bi);
      assert.ok(same(rx.re, ry.re) && same(rx.im, ry.im) && rx.relResidual === ry.relResidual);
      assert.ok(ry.relResidual < 1e-12, `residual ${ry.relResidual}`);
    }
  });
}

test('complex solve: js at solve time on WASM storage, and the small-factor fallback', { skip }, () => {
  const g = grid(10);
  const { A, B } = factorPair(ComplexSupernodalLDLT, g, 'wasm', 'wasm');
  const { br, bi } = rhs(g.n, { zeros: 4 });
  const ref = A.solve(br, bi);
  const prev = DEFAULT_COMPLEX_SOLVE;
  try {
    setDefaultComplexSolve('js');
    const x = B.solve(br, bi);
    assert.ok(same(ref.re, x.re) && same(ref.im, x.im));
  } finally { setDefaultComplexSolve(prev); }
  const small = grid(4);
  const f = new ComplexSupernodalLDLT(analyze(small.pat));
  assert.equal(f._cws, null, 'below CSOLVE_MIN_NNZL: plain arrays');
  f.factor(small.re, small.im);
  const r = rhs(small.n);
  const y = f.solveRefined(small.pat, small.re, small.im, r.br, r.bi);
  assert.ok(y.relResidual < 1e-12);
});

test('complex solve: unknown kind rejected', () => {
  assert.throws(() => setDefaultComplexSolve('gpu'), /unknown complex solve/);
});
