// SPDX-License-Identifier: GPL-3.0-or-later
// CSR spmv / Gauss-Seidel: JS loops vs the WASM kernels (la/wasm/csr.mjs), bitwise check and timing (lane G3,
// DevLog-060). Usage: node --max-old-space-size=1536 packages/core/bench/csr-bench.mjs [--N 24] [--reps 20]
import { makeCsrKernels } from '../src/la/wasm/csr.mjs';
import { spmvCsr, diagSlots } from '../src/la/ams-real.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('N', 24)), reps = Number(arg('reps', 20));
// 3D 27-point grid, 2 unknowns per point (random SPD-like values), n = 2 N^3
const nP = N ** 3, n = 2 * nP, cols = [], rowptr = [0];
let s = 12345; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
for (let p = 0; p < nP; p++) {
  const x = p % N, y = Math.floor(p / N) % N, z = Math.floor(p / N / N);
  for (let c = 0; c < 2; c++) {
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) continue;
      const q = (Z * N + Y) * N + X;
      cols.push(2 * q, 2 * q + 1);
    }
    rowptr.push(cols.length);
  }
}
const pat = { n, rowptr: Int32Array.from(rowptr), colidx: Int32Array.from(cols), nnz: cols.length };
const val = Float64Array.from(cols, (c, q) => -rnd());
const diag = diagSlots(pat);
for (let i = 0; i < n; i++) val[diag[i]] = 60;
const K = makeCsrKernels(pat, val, diag);
if (!K) { console.log('wasm kernels not available'); process.exit(1); }
const x = Float64Array.from({ length: n }, () => rnd() - 0.5), b = Float64Array.from({ length: n }, () => rnd() - 0.5);
const y1 = new Float64Array(n), y2 = new Float64Array(n);
const gsJs = (bb, xx, dir) => { for (let k = 0; k < n; k++) { const i = dir > 0 ? k : n - 1 - k; let t = bb[i]; const dq = diag[i]; for (let q = rowptr[i]; q < rowptr[i + 1]; q++) if (q !== dq) t -= val[q] * xx[cols[q]]; xx[i] = t / val[dq]; } };
const T = (f) => { const t = []; for (let r = 0; r < reps; r++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); } t.sort((a, c) => a - c); return t[t.length >> 1]; };
const tJs = T(() => spmvCsr(pat, val, x, y1)), tW = T(() => K.spmv(x, y2));
const bitS = y1.every((v, i) => Object.is(v, y2[i]));
const g1 = x.slice(), g2 = x.slice();
gsJs(b, g1, 1); gsJs(b, g1, -1); K.gs(b, g2, 1); K.gs(b, g2, -1);
const bitG = g1.every((v, i) => Object.is(v, g2[i]));
const tgJ = T(() => gsJs(b, g1, 1)), tgW = T(() => K.gs(b, g2, 1));
console.log(JSON.stringify({ n, nnz: pat.nnz, spmvJsMs: +tJs.toFixed(2), spmvWasmMs: +tW.toFixed(2), spmvBitwise: bitS, gsJsMs: +tgJ.toFixed(2), gsWasmMs: +tgW.toFixed(2), gsBitwise: bitG }));
