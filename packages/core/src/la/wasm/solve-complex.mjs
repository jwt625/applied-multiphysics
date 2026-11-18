// SPDX-License-Identifier: GPL-3.0-or-later
// WebAssembly kernels for the triangular solve of the complex-symmetric supernodal LDL^T (ldlt.mjs
// ComplexSupernodalLDLT.solve, inherited by BlockedComplexLDLT and WasmComplexLDLT; lane E8, DevLog-054). Module bytes
// are built at run time with the in-repo encoder (./encoder.mjs), as ./solve-real.mjs.
//
// Memory: the factor's Lr and Li live in a per-factor WebAssembly.Memory (Lr from byte 0, then Li), followed by the
// interleaved work vector y (re, im per row) and an Int32 copy of the row-index array Si. The memory never grows, so
// the Float64Array views handed to ldlt.mjs (this.Lr, this.Li) stay valid for the life of the factor; the factor
// writes L through them as before and the JS solve keeps working on the same views.
//
// Arithmetic: one f64x2 holds a complex number (lane 0 re, lane 1 im). Per entry the kernels apply exactly the
// operations of the JS solve, in the same order, so the results are bitwise identical (WebAssembly has no implicit
// fused multiply-add; x - y = x + (-y) and l (-b) = -(l b) exactly in IEEE 754):
//   forward, column c with (a, b) = y[f + c], skipped when a = 0 and b = 0:
//     JS:   yr[t] -= lr a - li b;  yi[t] -= lr b + li a
//     WASM: y[t] = y[t] - (splat(lr) (a, b) + splat(li) (-b, a))
//   backward, column c, running (a, b) = y[f + c]:
//     JS:   a -= lr yr[t] - li yi[t];  b -= lr yi[t] + li yr[t]
//     WASM: (a, b) = (a, b) - (splat(lr) (yr, yi) + splat(li) (-yi, yr))
// The permutation gather / scatter and the diagonal step stay in JS (same expressions on the same values).
// License: GPL-3.0-or-later.

import { Fn, buildModule, I32, V128, simdSupported } from './encoder.mjs';

const vsub = (f) => f.op(0xfd, 0xf1, 0x01); // f64x2.sub
const vneg = (f) => f.op(0xfd, 0xed, 0x01); // f64x2.neg
// i8x16.shuffle(x, y) -> (lane 1 of x, lane 0 of y): bytes 8..15 of x, then bytes 0..7 of y (indices 16..23)
const swapNeg = (f) => f.op(0xfd, 0x0d, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23);
const shl = (f, s) => f.i32(s).op(0x74);
const geS = (f) => f.op(0x4e);
const ltS = (f) => f.op(0x48);
const feq = (f) => f.op(0x61);
const iand = (f) => f.op(0x71);
const i32load = (f) => f.op(0x28, 2, 0);

function whileNot(f, exitCond, body) {
  f.block().loop();
  exitCond();
  f.brIf(1);
  body();
  f.br(0).end().end();
}

/** Push (-im, re) of the complex value in local v (v128). */
function pushRot(f, v) {
  f.get(v);
  vneg(f);
  f.get(v);
  swapNeg(f);
}

/**
 * cfwd(pLr, pLi, pY, pSi, m, nc, fc): forward elimination of one supernode (pLr = &Lr[lo], pLi = &Li[lo], pY = &y[0]
 * interleaved, pSi = &Si[r0], fc = first column). Same order and skip as ldlt.mjs ComplexSupernodalLDLT.solve.
 */
function buildFwd() {
  const f = new Fn('cfwd', [I32, I32, I32, I32, I32, I32, I32]);
  const [pLr, pLi, pY, pSi, m, nc, fc] = [0, 1, 2, 3, 4, 5, 6];
  const mb = f.local(I32), c = f.local(I32), colR = f.local(I32), colI = f.local(I32), r = f.local(I32), a = f.local(I32);
  const ab = f.local(V128), rot = f.local(V128);
  f.get(m); shl(f, 3); f.set(mb);
  f.i32(0).set(c);
  f.get(pLr).set(colR);
  f.get(pLi).set(colI);
  whileNot(f, () => { f.get(c).get(nc); geS(f); }, () => {
    f.block();
    // (a, b) = y[fc + c]; skip when both are zero
    f.get(pY).get(fc).get(c).add(); shl(f, 4); f.add().vload().set(ab);
    f.get(ab).vextract(0).f64const(0); feq(f);
    f.get(ab).vextract(1).f64const(0); feq(f);
    iand(f);
    f.brIf(0);
    pushRot(f, ab); f.set(rot);
    f.get(c).i32(1).add().set(r);
    whileNot(f, () => { f.get(r).get(m); geS(f); }, () => {
      // a = &y[Si[r]]
      f.get(pY);
      f.get(pSi).get(r); shl(f, 2); f.add(); i32load(f); shl(f, 4);
      f.add().set(a);
      f.get(a);
      f.get(a).vload();
      f.get(colR).get(r); shl(f, 3); f.add().fload().vsplat().get(ab).vmul();
      f.get(colI).get(r); shl(f, 3); f.add().fload().vsplat().get(rot).vmul();
      f.vadd();
      vsub(f);
      f.vstore();
      f.get(r).i32(1).add().set(r);
    });
    f.end();
    f.get(c).i32(1).add().set(c);
    f.get(colR).get(mb).add().set(colR);
    f.get(colI).get(mb).add().set(colI);
  });
  return f;
}

/** cbwd(pLr, pLi, pY, pSi, m, nc, fc): backward substitution of one supernode (columns nc-1 .. 0). */
function buildBwd() {
  const f = new Fn('cbwd', [I32, I32, I32, I32, I32, I32, I32]);
  const [pLr, pLi, pY, pSi, m, nc, fc] = [0, 1, 2, 3, 4, 5, 6];
  const mb = f.local(I32), c = f.local(I32), colR = f.local(I32), colI = f.local(I32), r = f.local(I32), yc = f.local(I32);
  const acc = f.local(V128), v = f.local(V128);
  f.get(m); shl(f, 3); f.set(mb);
  f.get(nc).i32(1).sub().set(c);
  f.get(pLr).get(c).get(mb).mul().add().set(colR);
  f.get(pLi).get(c).get(mb).mul().add().set(colI);
  whileNot(f, () => { f.get(c).i32(0); ltS(f); }, () => {
    f.get(pY).get(fc).get(c).add(); shl(f, 4); f.add().tee(yc).vload().set(acc);
    f.get(c).i32(1).add().set(r);
    whileNot(f, () => { f.get(r).get(m); geS(f); }, () => {
      f.get(pY);
      f.get(pSi).get(r); shl(f, 2); f.add(); i32load(f); shl(f, 4);
      f.add().vload().set(v);
      f.get(acc);
      f.get(colR).get(r); shl(f, 3); f.add().fload().vsplat().get(v).vmul();
      f.get(colI).get(r); shl(f, 3); f.add().fload().vsplat();
      pushRot(f, v);
      f.vmul();
      f.vadd();
      vsub(f);
      f.set(acc);
      f.get(r).i32(1).add().set(r);
    });
    f.get(yc).get(acc).vstore();
    f.get(c).i32(1).sub().set(c);
    f.get(colR).get(mb).sub().set(colR);
    f.get(colI).get(mb).sub().set(colI);
  });
  return f;
}

let bytes = null,
  compiled = null,
  supported = null;
function moduleBytes() {
  if (!bytes) bytes = buildModule([buildFwd(), buildBwd()]);
  return bytes;
}

/** Whether this runtime compiles the complex solve module (WebAssembly fixed-width SIMD; CSP 'wasm-unsafe-eval'). */
export function wasmComplexSolveSupported() {
  if (supported != null) return supported;
  try {
    supported = simdSupported() && WebAssembly.validate(moduleBytes());
    if (supported) compiled = compiled ?? new WebAssembly.Module(moduleBytes());
  } catch {
    supported = false;
  }
  return supported;
}

/** Size of the compiled module in bytes (Chrome compiles modules below 4 KB synchronously on the main thread). */
export const complexSolveModuleBytes = () => moduleBytes().length;

// ---- selection state ----

/**
 * Complex triangular solve: 'wasm' (this module; L allocated in WebAssembly memory) or 'js'. Read when a factor
 * allocates its storage (memory placement) and at each solve (kernel choice); results are identical either way.
 */
export let DEFAULT_COMPLEX_SOLVE = 'wasm';
export const setDefaultComplexSolve = (k) => {
  if (k !== 'js' && k !== 'wasm') throw new Error(`unknown complex solve ${k} (js | wasm)`);
  return (DEFAULT_COMPLEX_SOLVE = k);
};
/** Factors with fewer stored L entries keep plain Float64Arrays and the JS solve (speed only). */
export const CSOLVE_MIN_NNZL = 20000;
/** Largest per-factor memory (Lr, Li, y, Si) in bytes; larger factors keep the JS solve. */
export const CSOLVE_MAX_BYTES = 2 ** 31 - 2 ** 16;

/**
 * Storage of a complex factor: Lr, Li (length nnzL each) and, when the WASM solve is selected and available, the
 * kernel state `ws` sharing their memory; else `ws` is null and Lr, Li are plain Float64Arrays.
 */
export function allocComplexFactorStorage(nnzL, n, siLen) {
  const ws = DEFAULT_COMPLEX_SOLVE === 'wasm' && nnzL >= CSOLVE_MIN_NNZL ? complexMemory(nnzL, n, siLen) : null;
  return ws ? { Lr: ws.Lr, Li: ws.Li, ws } : { Lr: new Float64Array(nnzL), Li: new Float64Array(nnzL), ws: null };
}

function complexMemory(nnzL, n, siLen) {
  if (!wasmComplexSolveSupported()) return null;
  // doubles: Lr | Li | y (2 n, 16-byte aligned) ; then int32 Si
  const liOff = nnzL + 2,
    yOff = (liOff + nnzL + 3) & ~1,
    siByte = (yOff + 2 * n + 2) * 8;
  const need = siByte + 4 * siLen + 64;
  if (need > CSOLVE_MAX_BYTES) return null;
  try {
    const memory = new WebAssembly.Memory({ initial: Math.ceil(need / 65536) });
    const ex = new WebAssembly.Instance(compiled, { env: { memory } }).exports;
    const buf = memory.buffer;
    return { memory, ex, H: new Float64Array(buf), I: new Int32Array(buf), Lr: new Float64Array(buf, 0, nnzL), Li: new Float64Array(buf, liOff * 8, nnzL), liOff, yOff, siOff: siByte / 4, siReady: false };
  } catch {
    return null; // allocation refused: plain arrays, JS solve
  }
}

/** Whether a factor with storage `ws` solves through the WASM kernels now. */
export const useWasmComplexSolve = (ws) => !!ws && DEFAULT_COMPLEX_SOLVE === 'wasm';

/** ComplexSupernodalLDLT.solve through the kernels; same contract: (br, bi) in the original ordering -> {re, im}. */
export function complexLdltSolveWasm(ws, sym, Dr, Di, br, bi) {
  const { n, perm, nsuper, superStart, Sp, Si, Lxp } = sym;
  if (!ws.siReady) {
    ws.I.set(Si, ws.siOff);
    ws.siReady = true;
  }
  const { H, ex, yOff, liOff, siOff } = ws;
  const yB = yOff * 8,
    siB = siOff * 4,
    liB = liOff * 8;
  for (let i = 0; i < n; i++) {
    H[yOff + 2 * i] = br[perm[i]];
    H[yOff + 2 * i + 1] = bi[perm[i]];
  }
  for (let s = 0; s < nsuper; s++) {
    const f = superStart[s];
    ex.cfwd(Lxp[s] * 8, liB + Lxp[s] * 8, yB, siB + Sp[s] * 4, Sp[s + 1] - Sp[s], superStart[s + 1] - f, f);
  }
  for (let j = 0; j < n; j++) {
    const ar = Dr[j], ai = Di[j], den = ar * ar + ai * ai, a = H[yOff + 2 * j], b = H[yOff + 2 * j + 1];
    H[yOff + 2 * j] = (a * ar + b * ai) / den;
    H[yOff + 2 * j + 1] = (b * ar - a * ai) / den;
  }
  for (let s = nsuper - 1; s >= 0; s--) {
    const f = superStart[s];
    ex.cbwd(Lxp[s] * 8, liB + Lxp[s] * 8, yB, siB + Sp[s] * 4, Sp[s + 1] - Sp[s], superStart[s + 1] - f, f);
  }
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[perm[i]] = H[yOff + 2 * i];
    im[perm[i]] = H[yOff + 2 * i + 1];
  }
  return { re, im };
}
