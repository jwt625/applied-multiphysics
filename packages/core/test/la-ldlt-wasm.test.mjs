// Ported from advanced-packaging-atlas/engine/tests/em2d-wasm.test.mjs at fe39985 (GPL-3.0-or-later). Changes: the
// second half (em3d TE10 block with factor 'wasm' vs 'blocked') needs the APA layered mesher and em3d solver (not in
// @amp/core) and is dropped here; it runs unchanged against the core LDL^T in the atlas redirect check (DevLog-002
// section 4). Imports: ../src/em2d/ldlt-*.mjs -> ../src/la/ldlt-*.mjs.
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wasmLdltSupported, WasmComplexLDLT } from '../src/la/ldlt-wasm.mjs';
import { BlockedComplexLDLT } from '../src/la/ldlt-blocked.mjs';
import { DEFAULT_FACTOR } from '../src/la/ldlt-select.mjs';
import { buildElementPattern, analyze } from '../src/la/sparse.mjs';
test('WASM complex LDL^T front update = JS blocked factor', { skip: !wasmLdltSupported() && 'no WebAssembly SIMD' }, () => {
  const N = 16,
    n = N * N * N,
    el = [];
  const id = (i, j, k) => i + N * (j + N * k);
  for (let k = 0; k < N; k++)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        if (i + 1 < N) el.push(id(i, j, k), id(i + 1, j, k));
        if (j + 1 < N) el.push(id(i, j, k), id(i, j + 1, k));
        if (k + 1 < N) el.push(id(i, j, k), id(i, j, k + 1));
      }
  const pat = buildElementPattern(n, Int32Array.from(el), 2);
  const re = new Float64Array(pat.nnz),
    im = new Float64Array(pat.nnz);
  for (let r = 0; r < n; r++)
    for (let p = pat.rowptr[r]; p < pat.rowptr[r + 1]; p++) {
      const c = pat.colidx[p];
      re[p] = c === r ? 6.2 : -1;
      im[p] = c === r ? 0.3 : 0.01 * ((r + c) % 7);
    }
  const sym = analyze(pat);
  const b = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
  const xs = [BlockedComplexLDLT, WasmComplexLDLT].map((C) => {
    const fac = new C(sym);
    fac.factor(re, im);
    return fac.solve(b, new Float64Array(n));
  });
  let d = 0,
    mx = 0;
  for (let i = 0; i < n; i++) {
    d = Math.max(d, Math.hypot(xs[0].re[i] - xs[1].re[i], xs[0].im[i] - xs[1].im[i]));
    mx = Math.max(mx, Math.hypot(xs[0].re[i], xs[0].im[i]));
  }
  assert.ok(d / mx < 1e-12, `rel diff ${d / mx}`);
});

test('factor selector: WASM stays opt-in (default blocked)', () => {
  assert.equal(DEFAULT_FACTOR, 'blocked');
});
