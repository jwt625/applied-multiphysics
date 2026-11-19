// SPDX-License-Identifier: GPL-3.0-or-later
// WebAssembly kernels for CSR matrix-vector products and Gauss-Seidel sweeps (lane G3, DevLog-060), used by the
// iterative preconditioners (./../ams-real.mjs). Module bytes are built at run time with the in-repo encoder
// (./encoder.mjs), as ./solve-real.mjs.
//
// Arithmetic: scalar f64, per row exactly the operations of the JS loops in the same order, so results are bitwise
// identical to the JS path (WebAssembly has no implicit fused multiply-add):
//   spmv:  s = +0; s = s + val[q] * x[col[q]] for q in the row; y[i] = s
//   gs:    s = b[i]; s = s - val[q] * x[col[q]] for q in the row, q != diagonal slot; x[i] = s / val[diag]
//          (forward: i = 0 .. n-1; backward: i = n-1 .. 0)
// Memory: one WebAssembly.Memory per matrix holding rowptr, colidx, val, the diagonal slots and two work vectors of
// length n; JS vectors are copied in and out per call (O(n) against the O(nnz) kernel).
// License: GPL-3.0-or-later.

import { Fn, buildModule, I32, F64 } from './encoder.mjs';

const i32load = (f) => f.op(0x28, 2, 0);
const shl = (f, s) => f.i32(s).op(0x74);
const geS = (f) => f.op(0x4e);
const ltS = (f) => f.op(0x48);
const ne = (f) => f.op(0x47);
const fdiv = (f) => f.op(0xa3);

/** while (!exit) body */
function loopUntil(f, exitCond, body) {
  f.block().loop();
  exitCond();
  f.brIf(1);
  body();
  f.br(0).end().end();
}

/** spmv(pR, pC, pV, pX, pY, n) */
function buildSpmv() {
  const f = new Fn('spmv', [I32, I32, I32, I32, I32, I32]);
  const [pR, pC, pV, pX, pY, n] = [0, 1, 2, 3, 4, 5];
  const i = f.local(I32), q = f.local(I32), qe = f.local(I32), s = f.local(F64);
  f.i32(0).set(i);
  loopUntil(f, () => { f.get(i).get(n); geS(f); }, () => {
    f.get(pR).get(i); shl(f, 2); f.add(); i32load(f); f.set(q);
    f.get(pR).get(i); shl(f, 2); f.add().i32(4).add(); i32load(f); f.set(qe);
    f.f64const(0).set(s);
    loopUntil(f, () => { f.get(q).get(qe); geS(f); }, () => {
      f.get(s);
      f.get(pV).get(q); shl(f, 3); f.add().fload();
      f.get(pX); f.get(pC).get(q); shl(f, 2); f.add(); i32load(f); shl(f, 3); f.add().fload();
      f.fmul().fadd().set(s);
      f.get(q).i32(1).add().set(q);
    });
    f.get(pY).get(i); shl(f, 3); f.add().get(s).fstore();
    f.get(i).i32(1).add().set(i);
  });
  return f;
}

/** gsf / gsb(pR, pC, pV, pD, pB, pX, n): one Gauss-Seidel sweep, forward or backward. */
function buildGs(forward) {
  const f = new Fn(forward ? 'gsf' : 'gsb', [I32, I32, I32, I32, I32, I32, I32]);
  const [pR, pC, pV, pD, pB, pX, n] = [0, 1, 2, 3, 4, 5, 6];
  const k = f.local(I32), i = f.local(I32), q = f.local(I32), qe = f.local(I32), dq = f.local(I32), s = f.local(F64);
  f.i32(0).set(k);
  loopUntil(f, () => { f.get(k).get(n); geS(f); }, () => {
    if (forward) f.get(k).set(i);
    else f.get(n).i32(1).sub().get(k).sub().set(i);
    f.get(pR).get(i); shl(f, 2); f.add(); i32load(f); f.set(q);
    f.get(pR).get(i); shl(f, 2); f.add().i32(4).add(); i32load(f); f.set(qe);
    f.get(pD).get(i); shl(f, 2); f.add(); i32load(f); f.set(dq);
    f.get(pB).get(i); shl(f, 3); f.add().fload().set(s);
    loopUntil(f, () => { f.get(q).get(qe); geS(f); }, () => {
      f.get(q).get(dq); ne(f);
      f.op(0x04, 0x40); // if
      f.get(s);
      f.get(pV).get(q); shl(f, 3); f.add().fload();
      f.get(pX); f.get(pC).get(q); shl(f, 2); f.add(); i32load(f); shl(f, 3); f.add().fload();
      f.fmul().fsub().set(s);
      f.end();
      f.get(q).i32(1).add().set(q);
    });
    f.get(pX).get(i); shl(f, 3); f.add();
    f.get(s);
    f.get(pV).get(dq); shl(f, 3); f.add().fload();
    fdiv(f);
    f.fstore();
    f.get(k).i32(1).add().set(k);
  });
  return f;
}
void ltS;

let compiled = null;
let blocked = false;
/** Whether the CSR kernels compile here (cached). */
export function wasmCsrSupported() {
  if (compiled) return true;
  if (blocked) return false;
  try {
    compiled = new WebAssembly.Module(buildModule([buildSpmv(), buildGs(true), buildGs(false)]));
    return true;
  } catch {
    blocked = true;
    return false;
  }
}

/** Default: 'wasm' (bitwise identical to 'js'; falls back to JS when compilation is blocked). */
export let DEFAULT_CSR_KERNEL = 'wasm';
/** Select the CSR kernel ('wasm' | 'js') for kernels created afterwards; returns the previous value. */
export function setDefaultCsrKernel(k) {
  const p = DEFAULT_CSR_KERNEL;
  DEFAULT_CSR_KERNEL = k;
  return p;
}
/** Below this many stored entries the JS loops are used (call overhead; identical results). */
export const CSR_MIN_NNZ = 20000;

/**
 * Kernels for one CSR matrix {n, rowptr, colidx} with values val; diag: diagonal slot per row (Int32Array, needed by
 * gs). Returns {spmv(x, y), gs(b, x, dir), kind} or null when the WASM path is off, unsupported or the matrix is small.
 */
export function makeCsrKernels(pat, val, diag = null) {
  const n = pat.n, nnz = pat.rowptr[n];
  if (DEFAULT_CSR_KERNEL !== 'wasm' || nnz < CSR_MIN_NNZ || !wasmCsrSupported()) return null;
  // layout (bytes, 8-aligned): val | x | y | rowptr | colidx | diag
  const oV = 0, oX = oV + 8 * nnz, oY = oX + 8 * n, oR = oY + 8 * n, oC = oR + 4 * (n + 1), oD = oC + 4 * nnz, end = oD + 4 * n;
  const memory = new WebAssembly.Memory({ initial: Math.ceil(end / 65536) + 1 });
  const ex = new WebAssembly.Instance(compiled, { env: { memory } }).exports;
  const buf = memory.buffer;
  new Float64Array(buf, oV, nnz).set(val.subarray ? val.subarray(0, nnz) : val);
  new Int32Array(buf, oR, n + 1).set(pat.rowptr.subarray(0, n + 1));
  new Int32Array(buf, oC, nnz).set(pat.colidx.subarray(0, nnz));
  if (diag) new Int32Array(buf, oD, n).set(diag);
  const X = new Float64Array(buf, oX, n), Y = new Float64Array(buf, oY, n);
  return {
    kind: 'wasm',
    spmv(x, y) {
      X.set(x);
      ex.spmv(oR, oC, oV, oX, oY, n);
      y.set(Y);
      return y;
    },
    gs(b, x, dir) {
      if (!diag) throw new Error('csr kernels: gs needs the diagonal slots');
      Y.set(b);
      X.set(x);
      (dir > 0 ? ex.gsf : ex.gsb)(oR, oC, oV, oD, oY, oX, n);
      x.set(X);
    },
  };
}
