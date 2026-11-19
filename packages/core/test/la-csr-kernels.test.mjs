// SPDX-License-Identifier: GPL-3.0-or-later
// WASM CSR spmv / Gauss-Seidel kernels (lane G3, DevLog-060): bitwise equal to the JS loops (signed zeros, NaN, Inf
// included), fallback to JS when off or small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCsrKernels, setDefaultCsrKernel, CSR_MIN_NNZ } from '../src/la/wasm/csr.mjs';
import { spmvCsr, diagSlots } from '../src/la/ams-real.mjs';
import { buildAMG } from '../src/la/amg.mjs';

function grid(N) {
  const n = N ** 3, cols = [], rowptr = [0];
  for (let p = 0; p < n; p++) {
    const x = p % N, y = Math.floor(p / N) % N, z = Math.floor(p / N / N);
    for (const [dx, dy, dz] of [[0, 0, -1], [0, -1, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) continue;
      cols.push((Z * N + Y) * N + X);
    }
    rowptr.push(cols.length);
  }
  const pat = { n, rowptr: Int32Array.from(rowptr), colidx: Int32Array.from(cols), nnz: cols.length };
  const val = Float64Array.from(cols, (c, q) => -1 - (q % 7) / 10);
  const d = diagSlots(pat);
  for (let i = 0; i < n; i++) val[d[i]] = 8 + (i % 5) / 3;
  return { pat, val, d };
}
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

test('csr kernels: spmv and Gauss-Seidel bitwise equal to the JS loops', () => {
  const { pat, val, d } = grid(18);
  assert.ok(pat.nnz >= CSR_MIN_NNZ);
  const K = makeCsrKernels(pat, val, d);
  assert.ok(K, 'kernels available');
  const n = pat.n;
  const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i) * 1e3);
  x[3] = -0; x[10] = 0; x[20] = Infinity; x[21] = NaN;
  const y1 = spmvCsr(pat, val, x, new Float64Array(n)), y2 = K.spmv(x, new Float64Array(n));
  assert.ok(same(y1, y2), 'spmv');
  const b = Float64Array.from({ length: n }, (_, i) => Math.cos(i));
  for (const dir of [1, -1]) {
    const g1 = Float64Array.from({ length: n }, (_, i) => Math.sin(2 * i)), g2 = g1.slice();
    for (let k = 0; k < n; k++) {
      const i = dir > 0 ? k : n - 1 - k;
      let s = b[i];
      for (let q = pat.rowptr[i]; q < pat.rowptr[i + 1]; q++) if (q !== d[i]) s -= val[q] * g1[pat.colidx[q]];
      g1[i] = s / val[d[i]];
    }
    K.gs(b, g2, dir);
    assert.ok(same(g1, g2), `gs dir ${dir}`);
  }
});

test('csr kernels: AMG V-cycle identical with the JS loops; js setting and small matrices give null', () => {
  const { pat, val } = grid(18);
  const b = Float64Array.from({ length: pat.n }, (_, i) => Math.sin(i));
  const run = () => { const h = buildAMG({ ...pat, val }); const x = new Float64Array(pat.n); h.cycle(b, x); return x; };
  const w = run();
  const prev = setDefaultCsrKernel('js');
  try {
    assert.equal(makeCsrKernels(pat, val, null), null);
    assert.ok(same(w, run()), 'V-cycle bitwise');
  } finally { setDefaultCsrKernel(prev); }
  const s = grid(5);
  assert.equal(makeCsrKernels(s.pat, s.val, s.d), null);
});
