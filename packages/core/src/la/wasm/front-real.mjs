// SPDX-License-Identifier: GPL-3.0-or-later
// WebAssembly SIMD (f64x2) kernel for the dense partial factorization of a real front of the supernodal multifrontal
// Cholesky (sparse.mjs factorNumeric) and LDL^T (ldlt.mjs SupernodalLDLT) (lane P1, DevLog-016). Module bytes are built
// at run time with the in-repo encoder (./encoder.mjs): no toolchain, no binary asset, no runtime dependency, no
// SharedArrayBuffer. One WebAssembly.Memory per process holds the front (column-major m x m from byte 0) and a weight
// scratch; it grows when a larger front is factored and is reused by every factor (JS is single-threaded and factor()
// is synchronous, so the scratch is never shared between two factorizations in flight).
//
// Arithmetic: every real JS kernel of the engine applies, per front entry (row i, target column t),
//   groups of 4 source columns c = 0, 4, ... with c + 3 < cmax:
//     F[i,t] -= ((F[i,c] w_c + F[i,c+1] w_c+1) + F[i,c+2] w_c+2) + F[i,c+3] w_c+3
//   then the remaining source columns one at a time, skipped when w_c = 0:  F[i,t] -= F[i,c] w_c
// with cmax = k for panel column k, cmax = nc for the Schur block, w_c = F[t,c] (Cholesky) or F[t,c] D_c (LDL^T).
// The kernels below keep exactly that sequence per entry (f64x2 lanes are IEEE f64, WebAssembly has no implicit
// fused multiply-add, V8 does not fuse JS arithmetic), so the factor is bitwise identical to the JS path. Rows are
// processed two at a time (f64x2), 4 target columns share each source load (16 splatted weights in v128 locals).
//   g4(pF, pW, m, t, r0, ng)  targets t..t+3, rows [r0, m), groups g < ng, weights W[16 g + 4 jj + q]
//   s4(pF, pW, m, t, r0, c)   targets t..t+3, rows [r0, m), one source column c, weights W[jj] (all nonzero)
//   g1(pF, pW, m, t, r0, ng)  target t, rows [r0, m), groups g < ng, weights W[4 g + q]
//   s1(pF, w, m, t, r0, c)    target t, rows [r0, m), one source column c, weight w
// Pivots, scaling, the rows of a 4-target tile above a target's diagonal, assembly and extend-add stay in JS.
// License: GPL-3.0-or-later.

import { Fn, buildModule, I32, V128, F64, simdSupported, uleb } from './encoder.mjs';

const vsub = (f) => f.op(0xfd, 0xf1, 0x01); // f64x2.sub (241)
const splat64 = (f, off = 0) => f.op(0xfd, 0x0a, 3, ...uleb(off)); // v128.load64_splat
const shl = (f, s) => f.i32(s).op(0x74); // i32.shl
const gtS = (f) => f.op(0x4a);
const geS = (f) => f.op(0x4e);
const eqz = (f) => f.op(0x45);

/** Shared prologue: mb = m * 8, o0 = r0 * 8, T[jj] = pF + (t + jj) * mb. */
function prologue(f, pF, m, t, r0, nt) {
  const mb = f.local(I32), o0 = f.local(I32), o = f.local(I32);
  const T = Array.from({ length: nt }, () => f.local(I32));
  f.get(m);
  shl(f, 3);
  f.set(mb);
  f.get(r0);
  shl(f, 3);
  f.set(o0);
  f.get(pF).get(t).get(mb).mul().add().set(T[0]);
  for (let jj = 1; jj < nt; jj++) f.get(T[jj - 1]).get(mb).add().set(T[jj]);
  return { mb, o0, o, T };
}

/** Row-pair loop over o in [o0, mb) step 16, then the odd last row; `vec()` / `sca()` emit one step at offset o. */
function rows(f, { mb, o0, o }, vec, sca) {
  f.get(o0).set(o);
  f.block().loop();
  f.get(o).i32(16).add().get(mb);
  gtS(f);
  f.brIf(1);
  vec();
  f.get(o).i32(16).add().set(o);
  f.br(0).end().end();
  f.block();
  f.get(o).get(mb);
  geS(f);
  f.brIf(0);
  sca();
  f.end();
}

/** acc - (((a0 w0 + a1 w1) + a2 w2) + a3 w3) for one target, vector (lane = row) or scalar (lane 0 of w). */
function group(f, T, o, A, a, w, scalar) {
  f.get(T).get(o).add();
  f.get(T).get(o).add();
  if (scalar) f.fload();
  else f.vload();
  for (let q = 0; q < 4; q++) {
    if (scalar) f.get(A[q]).get(o).add().fload().get(w[q]).vextract(0).fmul();
    else f.get(a[q]).get(w[q]).vmul();
    if (q) scalar ? f.fadd() : f.vadd();
  }
  if (scalar) f.fsub().fstore();
  else {
    vsub(f);
    f.vstore();
  }
}

function buildG(nt) {
  const f = new Fn(nt === 4 ? 'g4' : 'g1', [I32, I32, I32, I32, I32, I32]);
  const [pF, pW, m, t, r0, ng] = [0, 1, 2, 3, 4, 5];
  const P = prologue(f, pF, m, t, r0, nt);
  const pa = f.local(I32), pw = f.local(I32);
  const A = [0, 1, 2, 3].map(() => f.local(I32));
  const a = [0, 1, 2, 3].map(() => f.local(V128));
  const w = Array.from({ length: 4 * nt }, () => f.local(V128));
  f.get(pF).set(pa);
  f.get(pW).set(pw);
  f.block().loop();
  f.get(ng);
  eqz(f);
  f.brIf(1);
  f.get(pa).set(A[0]);
  for (let q = 1; q < 4; q++) f.get(A[q - 1]).get(P.mb).add().set(A[q]);
  for (let jj = 0; jj < nt; jj++)
    for (let q = 0; q < 4; q++) {
      f.get(pw);
      splat64(f, 8 * (4 * jj + q));
      f.set(w[4 * jj + q]);
    }
  rows(
    f,
    P,
    () => {
      for (let q = 0; q < 4; q++) f.get(A[q]).get(P.o).add().vload().set(a[q]);
      for (let jj = 0; jj < nt; jj++) group(f, P.T[jj], P.o, A, a, w.slice(4 * jj, 4 * jj + 4), false);
    },
    () => {
      for (let jj = 0; jj < nt; jj++) group(f, P.T[jj], P.o, A, a, w.slice(4 * jj, 4 * jj + 4), true);
    },
  );
  f.get(pa).get(P.mb);
  shl(f, 2);
  f.add().set(pa);
  f.get(pw).i32(32 * nt).add().set(pw);
  f.get(ng).i32(1).sub().set(ng);
  f.br(0).end().end();
  return f;
}

function buildS(nt) {
  const f = new Fn(nt === 4 ? 's4' : 's1', [I32, nt === 4 ? I32 : F64, I32, I32, I32, I32]);
  const [pF, pW, m, t, r0, c] = [0, 1, 2, 3, 4, 5];
  const P = prologue(f, pF, m, t, r0, nt);
  const A = f.local(I32);
  const av = f.local(V128);
  const w = Array.from({ length: nt }, () => f.local(V128));
  f.get(pF).get(c).get(P.mb).mul().add().set(A);
  for (let jj = 0; jj < nt; jj++) {
    if (nt === 4) {
      f.get(pW);
      splat64(f, 8 * jj);
    } else f.get(pW).vsplat();
    f.set(w[jj]);
  }
  rows(
    f,
    P,
    () => {
      f.get(A).get(P.o).add().vload().set(av);
      for (let jj = 0; jj < nt; jj++) {
        f.get(P.T[jj]).get(P.o).add();
        f.get(P.T[jj]).get(P.o).add().vload();
        f.get(av).get(w[jj]).vmul();
        vsub(f);
        f.vstore();
      }
    },
    () => {
      for (let jj = 0; jj < nt; jj++) {
        f.get(P.T[jj]).get(P.o).add();
        f.get(P.T[jj]).get(P.o).add().fload();
        f.get(A).get(P.o).add().fload().get(w[jj]).vextract(0).fmul();
        f.fsub().fstore();
      }
    },
  );
  return f;
}

let bytes = null,
  compiled = null,
  supported = null;
function moduleBytes() {
  if (!bytes) bytes = buildModule([buildG(4), buildS(4), buildG(1), buildS(1)]);
  return bytes;
}

/**
 * Whether this runtime compiles the real front module (WebAssembly with fixed-width SIMD, and a CSP that allows
 * compilation: 'wasm-unsafe-eval' in a browser).
 */
export function wasmRealSupported() {
  if (supported != null) return supported;
  try {
    supported = simdSupported() && WebAssembly.validate(moduleBytes());
    if (supported) compiled = compiled ?? new WebAssembly.Module(moduleBytes());
  } catch {
    supported = false;
  }
  return supported;
}

// ---- selection state (re-exported by ../ldlt-select.mjs; kept here so sparse.mjs / ldlt.mjs import a leaf) ----

/**
 * Real SPD / LDL^T front kernel: 'blocked' (JS) or 'wasm' (this module; falls back to 'blocked' without SIMD or when the
 * scratch cannot be allocated). Default 'wasm' since 2026-11-06 (DevLog-016 gate: AC-02 2.72x, APA grid M 2.43x, EO
 * electrostatics 1.34x on the factor; bitwise-identical results on all three).
 */
export let DEFAULT_REAL_FACTOR = 'wasm';
export const setDefaultRealFactor = (k) => {
  if (k !== 'blocked' && k !== 'wasm') throw new Error(`unknown real factor ${k} (blocked | wasm)`);
  return (DEFAULT_REAL_FACTOR = k);
};
/** Fronts with fewer rows run the JS kernels (identical results; speed only). */
export const WASM_MIN_FRONT = 32;
/** Largest scratch (front + weights) the kernel allocates; larger fronts use the JS kernels. */
export const WASM_MAX_BYTES = 2 ** 30;

let K = null;

/**
 * The shared kernel sized for fronts up to `maxFront`, or null when 'wasm' is not available (no SIMD, or the front
 * exceeds WASM_MAX_BYTES). The returned object is valid until the next call (memory growth replaces `H`).
 */
export function realFrontKernel(maxFront) {
  if (!wasmRealSupported()) return null;
  const wIdx = maxFront * maxFront;
  const need = (wIdx + 8 * maxFront + 64) * 8;
  if (need > WASM_MAX_BYTES) return null;
  const pages = Math.ceil(need / 65536);
  try {
    if (!K) {
      compiled = compiled ?? new WebAssembly.Module(moduleBytes());
      const memory = new WebAssembly.Memory({ initial: pages });
      const ex = new WebAssembly.Instance(compiled, { env: { memory } }).exports;
      K = new RealFront(memory, ex);
    } else if (K.memory.buffer.byteLength < need) K.memory.grow(pages - K.memory.buffer.byteLength / 65536);
  } catch {
    return null; // allocation refused (RangeError): the caller runs the JS kernels
  }
  if (K.H.buffer !== K.memory.buffer) K.H = new Float64Array(K.memory.buffer);
  K.wIdx = wIdx;
  return K;
}

/** Drop the shared kernel memory (it never shrinks; the next 'wasm' factor allocates a fresh one). */
export function releaseRealFrontKernel() {
  K = null;
}

/** Resolve a requested real kernel: the kernel object for 'wasm' (null if unavailable), null for 'blocked'. */
export function resolveRealKernel(kind, maxFront) {
  const k = kind ?? DEFAULT_REAL_FACTOR;
  if (k === 'blocked') return null;
  if (k !== 'wasm') throw new Error(`unknown real factor ${k} (blocked | wasm)`);
  return realFrontKernel(maxFront);
}

class RealFront {
  constructor(memory, ex) {
    this.memory = memory;
    this.ex = ex;
    this.H = new Float64Array(memory.buffer);
    this.wIdx = 0;
  }

  /**
   * Dense partial factorization of the m x m front in H[0 .. m*m) with nc pivot columns, in place.
   * mode 0: Cholesky (returns false when a pivot is not positive). mode 1: LDL^T with static pivot perturbation
   * (pivots to D[f ..], counts to st.nNeg / st.nPert; returns false on a non-finite pivot).
   */
  front(m, nc, mode, D, f, tau, st) {
    const { H, wIdx, ex } = this;
    const pW = wIdx * 8;
    const ldlt = mode === 1;
    const wt = ldlt ? (t, c) => H[t + c * m] * D[f + c] : (t, c) => H[t + c * m];
    // ---- panel: 4-column tiles at k = 0, 4, ...; the groups c < k are shared by the 4 columns ----
    let k = 0;
    for (; k + 3 < nc; k += 4) {
      const ng = k >> 2;
      if (ng > 0) {
        this._pack4(k, ng, m, wt);
        this._heads(k, ng, 0, 0, m, wt);
        ex.g4(0, pW, m, k, k + 3, ng);
      }
      for (let jj = 0; jj < 4; jj++) {
        const t = k + jj;
        for (let c = k; c < t; c++) this._single(t, c, wt(t, c), t, m);
        if (!this._pivot(t, m, ldlt, D, f, tau, st)) return false;
      }
    }
    for (; k < nc; k++) {
      const ng = k >> 2;
      if (ng > 0) {
        this._pack1(k, ng, m, wt);
        ex.g1(0, pW, m, k, k, ng);
      }
      for (let c = 4 * ng; c < k; c++) this._single(k, c, wt(k, c), k, m);
      if (!this._pivot(k, m, ldlt, D, f, tau, st)) return false;
    }
    // ---- Schur complement of the trailing block (lower part), 4 target columns per tile ----
    const ng = nc >> 2, c4 = 4 * ng;
    let j = nc;
    for (; j + 3 < m; j += 4) {
      if (ng > 0) {
        this._pack4(j, ng, m, wt);
        this._heads(j, ng, c4, nc, m, wt);
        ex.g4(0, pW, m, j, j + 3, ng);
      } else if (c4 < nc) this._heads(j, 0, c4, nc, m, wt);
      for (let c = c4; c < nc; c++) {
        const w0 = wt(j, c), w1 = wt(j + 1, c), w2 = wt(j + 2, c), w3 = wt(j + 3, c);
        if (w0 !== 0 && w1 !== 0 && w2 !== 0 && w3 !== 0) {
          H[wIdx] = w0;
          H[wIdx + 1] = w1;
          H[wIdx + 2] = w2;
          H[wIdx + 3] = w3;
          ex.s4(0, pW, m, j, j + 3, c);
        } else {
          if (w0 !== 0) ex.s1(0, w0, m, j, j + 3, c);
          if (w1 !== 0) ex.s1(0, w1, m, j + 1, j + 3, c);
          if (w2 !== 0) ex.s1(0, w2, m, j + 2, j + 3, c);
          if (w3 !== 0) ex.s1(0, w3, m, j + 3, j + 3, c);
        }
      }
    }
    for (; j < m; j++) {
      if (ng > 0) {
        this._pack1(j, ng, m, wt);
        ex.g1(0, pW, m, j, j, ng);
      }
      for (let c = c4; c < nc; c++) this._single(j, c, wt(j, c), j, m);
    }
    return true;
  }

  /** W[16 g + 4 jj + q] = w(t + jj, 4 g + q). */
  _pack4(t, ng, m, wt) {
    const { H, wIdx } = this;
    for (let g = 0; g < ng; g++)
      for (let jj = 0; jj < 4; jj++) for (let q = 0; q < 4; q++) H[wIdx + 16 * g + 4 * jj + q] = wt(t + jj, 4 * g + q);
  }

  /** W[4 g + q] = w(t, 4 g + q). */
  _pack1(t, ng, m, wt) {
    const { H, wIdx } = this;
    for (let g = 0; g < ng; g++) for (let q = 0; q < 4; q++) H[wIdx + 4 * g + q] = wt(t, 4 * g + q);
  }

  /**
   * Entries (i, t + jj) with t + jj <= i < t + 3 of a 4-target tile (above the kernel's first row t + 3): the groups
   * from the packed weights, then the single source columns [s0, s1) with the zero-weight skip.
   */
  _heads(t, ng, s0, s1, m, wt) {
    const { H, wIdx } = this;
    for (let jj = 0; jj < 3; jj++) {
      const tb = (t + jj) * m;
      for (let i = t + jj; i < t + 3; i++) {
        for (let g = 0; g < ng; g++) {
          const b0 = 4 * g * m, wb = wIdx + 16 * g + 4 * jj;
          H[i + tb] -= H[i + b0] * H[wb] + H[i + b0 + m] * H[wb + 1] + H[i + b0 + 2 * m] * H[wb + 2] + H[i + b0 + 3 * m] * H[wb + 3];
        }
        for (let c = s0; c < s1; c++) {
          const w = wt(t + jj, c);
          if (w !== 0) H[i + tb] -= H[i + c * m] * w;
        }
      }
    }
  }

  /** Column t, rows [r0, m): F[i,t] -= F[i,c] w (skipped when w = 0). */
  _single(t, c, w, r0, m) {
    if (w === 0) return;
    if (m - r0 >= 8) this.ex.s1(0, w, m, t, r0, c);
    else {
      const H = this.H, tb = t * m, cb = c * m;
      for (let i = r0; i < m; i++) H[i + tb] -= H[i + cb] * w;
    }
  }

  _pivot(t, m, ldlt, D, f, tau, st) {
    const H = this.H, tb = t * m;
    let d = H[t + tb];
    if (!ldlt) {
      if (!(d > 0)) return false;
      const dk = Math.sqrt(d);
      H[t + tb] = dk;
      const inv = 1 / dk;
      for (let i = t + 1; i < m; i++) H[i + tb] *= inv;
      return true;
    }
    if (!(Math.abs(d) >= tau)) {
      if (!Number.isFinite(d)) return false;
      d = d < 0 ? -tau : tau;
      st.nPert++;
    }
    if (d < 0) st.nNeg++;
    D[f + t] = d;
    H[t + tb] = 1;
    const inv = 1 / d;
    for (let i = t + 1; i < m; i++) H[i + tb] *= inv;
    return true;
  }
}
