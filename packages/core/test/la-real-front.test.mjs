// SPDX-License-Identifier: GPL-3.0-or-later
// WASM SIMD real front kernel (la/wasm/front-real.mjs, lane P1 DevLog-016): the factor must be bitwise identical to the
// JS kernels ('blocked') for supernodal Cholesky (sparse.mjs) and LDL^T (ldlt.mjs), including zero weights inside
// fronts, odd row counts, perturbed pivots, failure on an indefinite matrix, and memory growth between factorizations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildElementPattern, analyze, factorNumeric, solveNumeric, SparseCholesky } from '../src/la/sparse.mjs';
import { SupernodalLDLT } from '../src/la/ldlt.mjs';
import { wasmRealSupported, WASM_MIN_FRONT, realFrontKernel, releaseRealFrontKernel } from '../src/la/wasm/front-real.mjs';
import { DEFAULT_REAL_FACTOR, setDefaultRealFactor, realFactorFallbackWarning } from '../src/la/ldlt-select.mjs';

const skip = !wasmRealSupported() && 'no WebAssembly SIMD';

/** 27-point (hex element) pattern on an Nx x Ny x Nz node grid; values: SPD, with a fraction of exact zeros off the diagonal. */
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
      else v[p] = zeroEvery && (r + c) % zeroEvery === 0 ? 0 : -1 + 0.001 * ((r * 31 + c * 17) % 11);
    }
  return { pat, v, n };
}

/** Lower parts (rows > c) and diagonals of every supernode's stored block are equal bit for bit. */
function sameLower(sym, La, Lb) {
  const { nsuper, superStart, Sp, Lxp } = sym;
  for (let s = 0; s < nsuper; s++) {
    const nc = superStart[s + 1] - superStart[s], m = Sp[s + 1] - Sp[s], lo = Lxp[s];
    for (let c = 0; c < nc; c++) for (let r = c; r < m; r++) if (!Object.is(La[lo + c * m + r], Lb[lo + c * m + r])) return false;
  }
  return true;
}

const bitwise = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

test('real factor selector: default wasm after the DevLog-016 gate; no fallback warning when SIMD is available', () => {
  assert.equal(DEFAULT_REAL_FACTOR, 'wasm');
  assert.equal(realFactorFallbackWarning('blocked'), null);
  if (wasmRealSupported()) assert.equal(realFactorFallbackWarning('wasm'), null);
  assert.throws(() => setDefaultRealFactor('fast'), /unknown real factor/);
});

for (const [name, dims, opt] of [
  ['cube 11^3', [11, 11, 11], {}],
  ['slab 23 x 9 x 5 (odd rows)', [23, 9, 5], {}],
  ['cube 10^3 with exact zeros in the fronts', [10, 10, 10], { zeroEvery: 3 }],
]) {
  test(`Cholesky wasm = blocked bitwise: ${name}`, { skip }, () => {
    const { pat, v, n } = grid(...dims, opt);
    const sym = analyze(pat);
    assert.ok(sym.maxFront >= WASM_MIN_FRONT, `maxFront ${sym.maxFront} engages the kernel`);
    const b = Float64Array.from({ length: n }, (_, i) => Math.cos(i));
    const nb = factorNumeric(sym, v, null, null, { factor: 'blocked' });
    const nw = factorNumeric(sym, v, null, null, { factor: 'wasm' });
    assert.equal(nb.kernel, 'blocked');
    assert.equal(nw.kernel, 'wasm');
    assert.ok(nb.ok && nw.ok);
    assert.ok(sameLower(sym, nb.Lx, nw.Lx), 'L identical');
    assert.ok(bitwise(solveNumeric(nb, b), solveNumeric(nw, b)), 'solution identical');
  });

  test(`LDL^T wasm = blocked bitwise (indefinite, perturbed pivots): ${name}`, { skip }, () => {
    const { pat, v, n } = grid(...dims, { ...opt, shift: 26 });
    const sym = analyze(pat);
    const b = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
    for (const pivotTol of [1e-13, 0.05]) {
      const fb = new SupernodalLDLT(sym, { factor: 'blocked' });
      const fw = new SupernodalLDLT(sym, { factor: 'wasm' });
      const rb = fb.factor(v, { pivotTol }), rw = fw.factor(v, { pivotTol });
      assert.equal(fw.kernel, 'wasm');
      assert.ok(rb.ok && rw.ok);
      assert.ok(rb.nNeg > 0, 'indefinite');
      if (pivotTol > 1e-3) assert.ok(rb.nPerturbed > 0, 'perturbed pivots exercised');
      assert.equal(rw.nNeg, rb.nNeg);
      assert.equal(rw.nPerturbed, rb.nPerturbed);
      assert.ok(bitwise(fb.D, fw.D), 'D identical');
      assert.ok(sameLower(sym, fb.Lx, fw.Lx), 'L identical');
      assert.ok(bitwise(fb.solve(b), fw.solve(b)), 'solution identical');
    }
  });
}

test('Cholesky wasm reports failure on an indefinite matrix like blocked', { skip }, () => {
  const { pat, v } = grid(11, 11, 11, { shift: 26 });
  const sym = analyze(pat);
  assert.equal(factorNumeric(sym, v, null, null, { factor: 'blocked' }).ok, false);
  assert.equal(factorNumeric(sym, v, null, null, { factor: 'wasm' }).ok, false);
});

test('failure inside a WASM front: non-positive Cholesky pivot and non-finite LDL^T pivot in the root front', { skip }, () => {
  const { pat, v } = grid(11, 11, 11);
  const sym = analyze(pat);
  const root = sym.nsuper - 1;
  assert.ok(sym.Sp[root + 1] - sym.Sp[root] >= WASM_MIN_FRONT, 'root front runs in the kernel');
  const last = sym.perm[sym.n - 1]; // eliminated last: its pivot lies in the root front
  const diag = (vals, x) => { const w = vals.slice(); for (let p = pat.rowptr[last]; p < pat.rowptr[last + 1]; p++) if (pat.colidx[p] === last) w[p] = x; return w; };
  const neg = diag(v, -1e6);
  for (const k of ['blocked', 'wasm']) assert.equal(factorNumeric(sym, neg, null, null, { factor: k }).ok, false, k);
  const bad = diag(v, NaN);
  const rb = new SupernodalLDLT(sym, { factor: 'blocked' }).factor(bad), rw = new SupernodalLDLT(sym, { factor: 'wasm' }).factor(bad);
  assert.equal(rb.ok, false);
  assert.equal(rw.ok, false);
  assert.equal(rw.nNeg, rb.nNeg);
  assert.equal(rw.nPerturbed, rb.nPerturbed);
});

test('shared kernel memory grows and is reused across factorizations; default switch reaches SparseCholesky', { skip }, () => {
  releaseRealFrontKernel(); // start from a fresh memory so the big case really grows it
  const small = grid(8, 8, 8), big = grid(14, 14, 12);
  const bytes0 = realFrontKernel(analyze(small.pat).maxFront).memory.buffer.byteLength;
  const solve = (g, kind) => {
    const ch = new SparseCholesky(g.pat, null, kind ? { factor: kind } : {});
    assert.ok(ch.factor(g.v));
    return { x: ch.solve(Float64Array.from({ length: g.n }, (_, i) => 1 + (i % 5))), kernel: ch.timing.kernel };
  };
  const ref = [small, big, small].map((g) => solve(g, 'blocked').x);
  const prev = DEFAULT_REAL_FACTOR;
  setDefaultRealFactor('wasm');
  try {
    [small, big, small].forEach((g, q) => {
      const r = solve(g, null);
      assert.equal(r.kernel, 'wasm');
      assert.ok(bitwise(r.x, ref[q]), `case ${q} identical`);
    });
    assert.ok(realFrontKernel(1).memory.buffer.byteLength > bytes0, 'memory grew');
  } finally {
    setDefaultRealFactor(prev);
  }
});
