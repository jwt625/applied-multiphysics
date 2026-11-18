// SPDX-License-Identifier: GPL-3.0-or-later
// Complex LDL^T triangular solve, JS vs WASM (la/wasm/solve-complex.mjs, lane E8 DevLog-054): factor once, then the
// median of --runs solves per kernel and a bitwise comparison. Patterns: '3d' = 27-point hex-element grid N^3 (3D
// tet10-like fill), '2d' = 9-node quad-element grid N^2 (2D P2-like fill). Usage (repo root):
//   nice -n 10 node --max-old-space-size=1536 packages/core/bench/csolve-bench.mjs --dim 3 --N 24 [--runs 9]
import os from 'node:os';
import { buildElementPattern, analyze } from '../src/la/sparse.mjs';
import { BlockedComplexLDLT } from '../src/la/ldlt-blocked.mjs';
import { setDefaultComplexSolve } from '../src/la/wasm/solve-complex.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const dim = Number(arg('dim', 3)), N = Number(arg('N', 24)), RUNS = Number(arg('runs', 9));
const el = [];
let n;
if (dim === 3) {
  n = N * N * N;
  const id = (i, j, k) => i + N * (j + N * k);
  for (let k = 0; k + 1 < N; k++) for (let j = 0; j + 1 < N; j++) for (let i = 0; i + 1 < N; i++)
    for (const [a, b, c] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]) el.push(id(i + a, j + b, k + c));
} else {
  n = N * N;
  const id = (i, j) => i + N * j;
  for (let j = 0; j + 2 < N; j += 2) for (let i = 0; i + 2 < N; i += 2) for (let b = 0; b < 3; b++) for (let a = 0; a < 3; a++) el.push(id(i + a, j + b));
}
const k = dim === 3 ? 8 : 9;
const pat = buildElementPattern(n, Int32Array.from(el), k);
const re = new Float64Array(pat.nnz), im = new Float64Array(pat.nnz);
for (let r = 0; r < n; r++)
  for (let p = pat.rowptr[r]; p < pat.rowptr[r + 1]; p++) {
    const c = pat.colidx[p];
    if (c === r) { re[p] = 30 + 0.01 * (r % 7); im[p] = 0.3; } else { re[p] = -1 + 0.001 * ((Math.min(r, c) * 31 + Math.max(r, c) * 17) % 11); im[p] = 0.01 * ((r + c) % 3); }
  }
const sym = analyze(pat);
setDefaultComplexSolve('js');
const A = new BlockedComplexLDLT(sym);
setDefaultComplexSolve('wasm');
const B = new BlockedComplexLDLT(sym);
const tf = performance.now();
A.factor(re, im);
const factorMs = performance.now() - tf;
B.factor(re, im);
let s = 7;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
const br = Float64Array.from({ length: n }, rnd), bi = Float64Array.from({ length: n }, rnd);
const med = (f) => { const t = []; for (let q = 0; q < RUNS; q++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); } t.sort((x, y) => x - y); return t[RUNS >> 1]; };
const x = A.solve(br, bi), y = B.solve(br, bi);
const same = x.re.every((v, i) => Object.is(v, y.re[i])) && x.im.every((v, i) => Object.is(v, y.im[i]));
const js = med(() => A.solve(br, bi)), wasm = med(() => B.solve(br, bi));
console.log(JSON.stringify({ date: new Date().toISOString(), loadavg: os.loadavg().map((v) => +v.toFixed(2)), dim, N, n, nnzL: Number(sym.nnzL), factorMs: +factorMs.toFixed(0), solveJsMs: +js.toFixed(2), solveWasmMs: +wasm.toFixed(2), speedup: +(js / wasm).toFixed(2), bitwise: same, wasmStorage: !!B._cws }));
