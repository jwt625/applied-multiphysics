// SPDX-License-Identifier: GPL-3.0-or-later
// WebAssembly kernels for the triangular solves of the real supernodal factors (lane S4, DevLog-045):
// SparseCholesky / factorNumeric (sparse.mjs solveNumeric, supernodalSolve) and SupernodalLDLT (ldlt.mjs solve,
// solveMany). Module bytes are built at run time with the in-repo encoder (./encoder.mjs), as ./front-real.mjs.
//
// Memory: the factor's L values live in a per-factor WebAssembly.Memory (L from byte 0), followed by the solve
// workspace (y for up to QCAP vectors, the update vector t, and for LDL^T a copy of the row-index array Si). The memory
// never grows, so the Float64Array views handed to sparse.mjs / ldlt.mjs (num.Lx, this.Lx) stay valid for the life of
// the factor; the JS solves keep working on the same views.
//
// Arithmetic: per entry the kernels apply exactly the operations of the JS solves, in the same order, so the results
// are bitwise identical to the JS path (f64x2 lanes are IEEE f64, WebAssembly has no implicit fused multiply-add, V8
// does not fuse JS arithmetic):
//   Cholesky forward, in-supernode:  y[c] = y[c] / L[c,c];  y[r] = y[r] - L[r,c] y[c]   (r > c, vectorised over r)
//   Cholesky forward, below:         t[r] = 0;  t[r] = t[r] + (L[r,c] y[c] + L[r,c+1] y[c+1]) per column pair, then
//                                    t[r] = t[r] + L[r,c] y[c] for an odd last column (vectorised over r)
//   Cholesky backward:               w = y[c]; w = w - L[r,c] y[r] for r = c+1 .. nc-1 (scalar, in order); the below
//                                    dot as 4 strided partial sums s0..s3 (two f64x2 accumulators), tail into s0,
//                                    (s0 + s1) + (s2 + s3);  y[c] = (w - dot) / L[c,c]
//   LDL^T forward (q vectors, interleaved y[i q + k]):  skip when L = 0 (q > 1) or y[c] = 0 (q = 1, as ldlt.mjs);
//                                    y[i] = y[i] - L[r,c] y[c]   (scalar rows; vectorised over k for q > 1)
//   LDL^T backward:                  v = y[c]; v = v - L[r,c] y[r] in row order, skip L = 0 (q > 1)
// Gathers / scatters through Si for Cholesky and the diagonal scaling of LDL^T stay in JS.
// License: GPL-3.0-or-later.

import { Fn, buildModule, I32, V128, F64, simdSupported, uleb } from './encoder.mjs';

const vsub = (f) => f.op(0xfd, 0xf1, 0x01); // f64x2.sub
const shl = (f, s) => f.i32(s).op(0x74);
const gtS = (f) => f.op(0x4a);
const geS = (f) => f.op(0x4e);
const ltS = (f) => f.op(0x48);
const fdiv = (f) => f.op(0xa3);
const feq = (f) => f.op(0x61);
const i32load = (f) => f.op(0x28, 2, 0);

/** while (cond) { body } with cond pushing an i32 that is nonzero to EXIT. */
function whileNot(f, exitCond, body) {
  f.block().loop();
  exitCond();
  f.brIf(1);
  body();
  f.br(0).end().end();
}

/** fdiag(pL, pY, m, nc): in-supernode forward substitution of a Cholesky block (pL = &L[lo], pY = &y[f]). */
function buildFdiag() {
  const f = new Fn('fdiag', [I32, I32, I32, I32]);
  const [pL, pY, m, nc] = [0, 1, 2, 3];
  const mb = f.local(I32), end = f.local(I32), cO = f.local(I32), col = f.local(I32), o = f.local(I32);
  const yj = f.local(F64), vy = f.local(V128);
  f.get(m); shl(f, 3); f.set(mb);
  f.get(nc); shl(f, 3); f.set(end);
  f.i32(0).set(cO);
  f.get(pL).set(col);
  whileNot(f, () => { f.get(cO).get(end); geS(f); }, () => {
    // y[c] = y[c] / L[c, c]
    f.get(pY).get(cO).add();
    f.get(pY).get(cO).add().fload();
    f.get(col).get(cO).add().fload();
    fdiv(f);
    f.tee(yj).fstore();
    f.get(yj).vsplat().set(vy);
    f.get(cO).i32(8).add().set(o);
    whileNot(f, () => { f.get(o).i32(16).add().get(end); gtS(f); }, () => {
      f.get(pY).get(o).add();
      f.get(pY).get(o).add().vload();
      f.get(col).get(o).add().vload().get(vy).vmul();
      vsub(f);
      f.vstore();
      f.get(o).i32(16).add().set(o);
    });
    f.block();
    f.get(o).get(end); geS(f); f.brIf(0);
    f.get(pY).get(o).add();
    f.get(pY).get(o).add().fload();
    f.get(col).get(o).add().fload().get(yj).fmul();
    f.fsub().fstore();
    f.end();
    f.get(cO).i32(8).add().set(cO);
    f.get(col).get(mb).add().set(col);
  });
  return f;
}

/** facc(pL, pY, pT, m, nc, mu): t[0 .. mu) = sum over the block's columns of L[nc + r, c] y[c] (pair order of JS). */
function buildFacc() {
  const f = new Fn('facc', [I32, I32, I32, I32, I32, I32]);
  const [pL, pY, pT, m, nc, mu] = [0, 1, 2, 3, 4, 5];
  const mb = f.local(I32), mub = f.local(I32), o = f.local(I32), c = f.local(I32);
  const A = [0, 1, 2, 3].map(() => f.local(I32));
  const ys = [0, 1, 2, 3].map(() => f.local(F64));
  const vs = [0, 1, 2, 3].map(() => f.local(V128));
  f.get(m); shl(f, 3); f.set(mb);
  f.get(mu); shl(f, 3); f.set(mub);
  // t = +0
  f.i32(0).set(o);
  whileNot(f, () => { f.get(o).i32(16).add().get(mub); gtS(f); }, () => {
    f.get(pT).get(o).add().vzero().vstore();
    f.get(o).i32(16).add().set(o);
  });
  f.block(); f.get(o).get(mub); geS(f); f.brIf(0);
  f.get(pT).get(o).add().f64const(0).fstore();
  f.end();
  // A[0] = &L[nc, 0] = pL + nc * 8
  f.get(pL).get(nc); shl(f, 3); f.add().set(A[0]);
  f.i32(0).set(c);
  // np pairs per row pass: np = 2 (columns c .. c+3), then 1 pair, then a single column
  const pass = (ncol) => {
    for (let q = 1; q < ncol; q++) f.get(A[q - 1]).get(mb).add().set(A[q]);
    for (let q = 0; q < ncol; q++) {
      f.get(pY).get(c); shl(f, 3); f.add().fload(8 * q).tee(ys[q]).vsplat().set(vs[q]);
    }
    const term = (scalar) => {
      // acc = acc + ((L_a y_a + L_b y_b)) per pair, or acc + L_a y_a for one column
      const ld = (q) => { f.get(A[q]).get(o).add(); if (scalar) f.fload().get(ys[q]).fmul(); else f.vload().get(vs[q]).vmul(); };
      const add = () => (scalar ? f.fadd() : f.vadd());
      if (ncol === 1) { ld(0); add(); return; }
      for (let p = 0; p < ncol; p += 2) { ld(p); ld(p + 1); add(); add(); }
    };
    f.i32(0).set(o);
    whileNot(f, () => { f.get(o).i32(16).add().get(mub); gtS(f); }, () => {
      f.get(pT).get(o).add();
      f.get(pT).get(o).add().vload();
      term(false);
      f.vstore();
      f.get(o).i32(16).add().set(o);
    });
    f.block(); f.get(o).get(mub); geS(f); f.brIf(0);
    f.get(pT).get(o).add();
    f.get(pT).get(o).add().fload();
    term(true);
    f.fstore();
    f.end();
    f.get(c).i32(ncol).add().set(c);
    f.get(A[0]).get(mb); shl(f, ncol === 4 ? 2 : ncol === 2 ? 1 : 0); f.add().set(A[0]);
  };
  // while (c + 3 < nc) pass(4)
  whileNot(f, () => { f.get(c).i32(3).add().get(nc); geS(f); }, () => pass(4));
  f.block(); f.get(c).i32(1).add().get(nc); geS(f); f.brIf(0); pass(2); f.end();
  f.block(); f.get(c).get(nc); geS(f); f.brIf(0); pass(1); f.end();
  return f;
}

/** bdiag(pL, pY, pT, m, nc, mu): backward substitution of a Cholesky block with the gathered below values t. */
function buildBdiag() {
  const f = new Fn('bdiag', [I32, I32, I32, I32, I32, I32]);
  const [pL, pY, pT, m, nc, mu] = [0, 1, 2, 3, 4, 5];
  const mb = f.local(I32), mub = f.local(I32), ncb = f.local(I32), cO = f.local(I32), col = f.local(I32), o = f.local(I32), lb = f.local(I32);
  const w = f.local(F64), s0 = f.local(F64), s1 = f.local(F64), s2 = f.local(F64), s3 = f.local(F64);
  const a01 = f.local(V128), a23 = f.local(V128);
  f.get(m); shl(f, 3); f.set(mb);
  f.get(mu); shl(f, 3); f.set(mub);
  f.get(nc); shl(f, 3); f.set(ncb);
  // c = nc - 1 (byte offset cO), col = pL + (nc - 1) * mb
  f.get(ncb).i32(8).sub().set(cO);
  f.get(pL).get(nc).i32(1).sub().get(mb).mul().add().set(col);
  whileNot(f, () => { f.get(cO).i32(0); ltS(f); }, () => {
    f.get(pY).get(cO).add().fload().set(w);
    f.get(cO).i32(8).add().set(o);
    whileNot(f, () => { f.get(o).get(ncb); geS(f); }, () => {
      f.get(w);
      f.get(col).get(o).add().fload();
      f.get(pY).get(o).add().fload();
      f.fmul().fsub().set(w);
      f.get(o).i32(8).add().set(o);
    });
    // dot over the rows below
    f.get(col).get(ncb).add().set(lb);
    f.vzero().set(a01);
    f.vzero().set(a23);
    f.i32(0).set(o);
    whileNot(f, () => { f.get(o).i32(32).add().get(mub); gtS(f); }, () => {
      f.get(a01);
      f.get(lb).get(o).add().vload();
      f.get(pT).get(o).add().vload();
      f.vmul().vadd().set(a01);
      f.get(a23);
      f.get(lb).get(o).add().vload(16);
      f.get(pT).get(o).add().vload(16);
      f.vmul().vadd().set(a23);
      f.get(o).i32(32).add().set(o);
    });
    f.get(a01).vextract(0).set(s0);
    f.get(a01).vextract(1).set(s1);
    f.get(a23).vextract(0).set(s2);
    f.get(a23).vextract(1).set(s3);
    whileNot(f, () => { f.get(o).get(mub); geS(f); }, () => {
      f.get(s0);
      f.get(lb).get(o).add().fload();
      f.get(pT).get(o).add().fload();
      f.fmul().fadd().set(s0);
      f.get(o).i32(8).add().set(o);
    });
    // y[c] = (w - ((s0 + s1) + (s2 + s3))) / L[c, c]
    f.get(pY).get(cO).add();
    f.get(w);
    f.get(s0).get(s1).fadd().get(s2).get(s3).fadd().fadd();
    f.fsub();
    f.get(col).get(cO).add().fload();
    fdiv(f);
    f.fstore();
    f.get(cO).i32(8).sub().set(cO);
    f.get(col).get(mb).sub().set(col);
  });
  return f;
}

/**
 * lfwd1(pL, pY, pSi, m, nc, f): LDL^T forward elimination of one supernode, one vector (pL = &L[lo], pY = &y[0],
 * pSi = &Si[r0], f = first column). Same order and skips as ldlt.mjs SupernodalLDLT.solve.
 */
function buildLfwd1() {
  const f = new Fn('lfwd1', [I32, I32, I32, I32, I32, I32]);
  const [pL, pY, pSi, m, nc, fc] = [0, 1, 2, 3, 4, 5];
  const mb = f.local(I32), c = f.local(I32), col = f.local(I32), r = f.local(I32), yf = f.local(I32), a = f.local(I32);
  const yj = f.local(F64);
  f.get(m); shl(f, 3); f.set(mb);
  f.get(pY).get(fc); shl(f, 3); f.add().set(yf);
  f.i32(0).set(c);
  f.get(pL).set(col);
  whileNot(f, () => { f.get(c).get(nc); geS(f); }, () => {
    f.block();
    f.get(yf).get(c); shl(f, 3); f.add().fload().tee(yj).f64const(0); feq(f); f.brIf(0);
    // rows c+1 .. nc-1 (contiguous in y)
    f.get(c).i32(1).add().set(r);
    whileNot(f, () => { f.get(r).get(nc); geS(f); }, () => {
      f.get(yf).get(r); shl(f, 3); f.add().set(a);
      f.get(a);
      f.get(a).fload();
      f.get(col).get(r); shl(f, 3); f.add().fload().get(yj).fmul();
      f.fsub().fstore();
      f.get(r).i32(1).add().set(r);
    });
    // rows nc .. m-1 through Si
    whileNot(f, () => { f.get(r).get(m); geS(f); }, () => {
      f.get(pY);
      f.get(pSi).get(r); shl(f, 2); f.add(); i32load(f); shl(f, 3);
      f.add().set(a);
      f.get(a);
      f.get(a).fload();
      f.get(col).get(r); shl(f, 3); f.add().fload().get(yj).fmul();
      f.fsub().fstore();
      f.get(r).i32(1).add().set(r);
    });
    f.end();
    f.get(c).i32(1).add().set(c);
    f.get(col).get(mb).add().set(col);
  });
  return f;
}

/** lbwd1(pL, pY, pSi, m, nc, f): LDL^T backward substitution of one supernode, one vector. */
function buildLbwd1() {
  const f = new Fn('lbwd1', [I32, I32, I32, I32, I32, I32]);
  const [pL, pY, pSi, m, nc, fc] = [0, 1, 2, 3, 4, 5];
  const mb = f.local(I32), c = f.local(I32), col = f.local(I32), r = f.local(I32), yf = f.local(I32);
  const v = f.local(F64);
  f.get(m); shl(f, 3); f.set(mb);
  f.get(pY).get(fc); shl(f, 3); f.add().set(yf);
  f.get(nc).i32(1).sub().set(c);
  f.get(pL).get(c).get(mb).mul().add().set(col);
  whileNot(f, () => { f.get(c).i32(0); ltS(f); }, () => {
    f.get(yf).get(c); shl(f, 3); f.add().fload().set(v);
    f.get(c).i32(1).add().set(r);
    whileNot(f, () => { f.get(r).get(nc); geS(f); }, () => {
      f.get(v);
      f.get(col).get(r); shl(f, 3); f.add().fload();
      f.get(yf).get(r); shl(f, 3); f.add().fload();
      f.fmul().fsub().set(v);
      f.get(r).i32(1).add().set(r);
    });
    whileNot(f, () => { f.get(r).get(m); geS(f); }, () => {
      f.get(v);
      f.get(col).get(r); shl(f, 3); f.add().fload();
      f.get(pY);
      f.get(pSi).get(r); shl(f, 2); f.add(); i32load(f); shl(f, 3);
      f.add().fload();
      f.fmul().fsub().set(v);
      f.get(r).i32(1).add().set(r);
    });
    f.get(yf).get(c); shl(f, 3); f.add().get(v).fstore();
    f.get(c).i32(1).sub().set(c);
    f.get(col).get(mb).sub().set(col);
  });
  return f;
}

/**
 * lfwdq(pL, pY, pSi, m, nc, f, q): LDL^T forward elimination, q interleaved vectors (y[i q + k]); entries with L = 0
 * are skipped (ldlt.mjs solveMany). Vectorised over k (pairs), scalar tail for odd q.
 * lbwdq(pL, pY, pSi, m, nc, f, q, pV): backward; pV = scratch for the q running sums.
 */
function buildQ(fwd) {
  const f = new Fn(fwd ? 'lfwdq' : 'lbwdq', fwd ? [I32, I32, I32, I32, I32, I32, I32] : [I32, I32, I32, I32, I32, I32, I32, I32]);
  const [pL, pY, pSi, m, nc, fc, q, pV] = [0, 1, 2, 3, 4, 5, 6, 7];
  const mb = f.local(I32), qb = f.local(I32), c = f.local(I32), col = f.local(I32), r = f.local(I32), jq = f.local(I32), iq = f.local(I32), k = f.local(I32);
  const l = f.local(F64), vl = f.local(V128);
  f.get(m); shl(f, 3); f.set(mb);
  f.get(q); shl(f, 3); f.set(qb);
  // row address of r: r < nc -> y + (f + r) q * 8; else y + Si[r] q * 8
  const rowAddr = () => {
    f.block(); f.block();
    f.get(r).get(nc); geS(f); f.brIf(0);
    f.get(fc).get(r).add().get(qb).mul().get(pY).add().set(iq);
    f.br(1);
    f.end();
    f.get(pSi).get(r); shl(f, 2); f.add(); i32load(f); f.get(qb).mul().get(pY).add().set(iq);
    f.end();
  };
  // inner k loop: dst[k] = dst[k] - l * src[k]; fwd: dst = row iq, src = jq; bwd: dst = V, src = iq
  const kloop = () => {
    const dst = fwd ? iq : pV, src = fwd ? jq : iq;
    f.i32(0).set(k);
    whileNot(f, () => { f.get(k).i32(16).add().get(qb); gtS(f); }, () => {
      f.get(dst).get(k).add();
      f.get(dst).get(k).add().vload();
      f.get(src).get(k).add().vload().get(vl).vmul();
      vsub(f);
      f.vstore();
      f.get(k).i32(16).add().set(k);
    });
    f.block(); f.get(k).get(qb); geS(f); f.brIf(0);
    f.get(dst).get(k).add();
    f.get(dst).get(k).add().fload();
    f.get(src).get(k).add().fload().get(l).fmul();
    f.fsub().fstore();
    f.end();
  };
  const body = () => {
    f.get(fc).get(c).add().get(qb).mul().get(pY).add().set(jq);
    if (!fwd) {
      // V = y[jq ..]
      f.i32(0).set(k);
      whileNot(f, () => { f.get(k).get(qb); geS(f); }, () => {
        f.get(pV).get(k).add();
        f.get(jq).get(k).add().fload();
        f.fstore();
        f.get(k).i32(8).add().set(k);
      });
    }
    f.get(c).i32(1).add().set(r);
    whileNot(f, () => { f.get(r).get(m); geS(f); }, () => {
      f.block();
      f.get(col).get(r); shl(f, 3); f.add().fload().tee(l).f64const(0); feq(f); f.brIf(0);
      f.get(l).vsplat().set(vl);
      rowAddr();
      kloop();
      f.end();
      f.get(r).i32(1).add().set(r);
    });
    if (!fwd) {
      f.i32(0).set(k);
      whileNot(f, () => { f.get(k).get(qb); geS(f); }, () => {
        f.get(jq).get(k).add();
        f.get(pV).get(k).add().fload();
        f.fstore();
        f.get(k).i32(8).add().set(k);
      });
    }
  };
  if (fwd) {
    f.i32(0).set(c);
    f.get(pL).set(col);
    whileNot(f, () => { f.get(c).get(nc); geS(f); }, () => {
      body();
      f.get(c).i32(1).add().set(c);
      f.get(col).get(mb).add().set(col);
    });
  } else {
    f.get(nc).i32(1).sub().set(c);
    f.get(pL).get(c).get(mb).mul().add().set(col);
    whileNot(f, () => { f.get(c).i32(0); ltS(f); }, () => {
      body();
      f.get(c).i32(1).sub().set(c);
      f.get(col).get(mb).sub().set(col);
    });
  }
  return f;
}

let bytes = null,
  compiled = null,
  supported = null;
function moduleBytes() {
  if (!bytes) bytes = buildModule([buildFdiag(), buildFacc(), buildBdiag(), buildLfwd1(), buildLbwd1(), buildQ(true), buildQ(false)]);
  return bytes;
}

/** Whether this runtime compiles the solve module (WebAssembly with fixed-width SIMD; CSP 'wasm-unsafe-eval'). */
export function wasmSolveSupported() {
  if (supported != null) return supported;
  try {
    supported = simdSupported() && WebAssembly.validate(moduleBytes());
    if (supported) compiled = compiled ?? new WebAssembly.Module(moduleBytes());
  } catch {
    supported = false;
  }
  return supported;
}

// ---- selection state ----

/**
 * Real triangular solve: 'wasm' (this module; the factor's L is allocated in WebAssembly memory) or 'js'. Read when a
 * factor allocates its storage (memory placement) and at each solve (kernel choice); results are identical either way.
 */
export let DEFAULT_REAL_SOLVE = 'wasm';
export const setDefaultRealSolve = (k) => {
  if (k !== 'js' && k !== 'wasm') throw new Error(`unknown real solve ${k} (js | wasm)`);
  return (DEFAULT_REAL_SOLVE = k);
};
/** Factors with fewer stored L entries keep a plain Float64Array and the JS solve (speed only). */
export const SOLVE_MIN_NNZL = 50000;
/** Largest per-factor memory (L + workspace) in bytes; larger factors keep the JS solve. */
export const SOLVE_MAX_BYTES = 2 ** 31 - 2 ** 16;
/** Vectors per multi-vector LDL^T solve held in the workspace; larger blocks run in chunks of QCAP. */
export const QCAP = 8;

/**
 * Storage of a real factor: `Lx` (length nnzL) and, when the WASM solve is selected and available, the kernel state
 * `ws` (memory, exports, offsets) sharing Lx's memory; else `ws` is null and Lx is a plain Float64Array.
 * siLen > 0 reserves an Int32 copy of Si (LDL^T kernels gather through it).
 */
export function allocRealFactorStorage(nnzL, n, maxFront, siLen = 0) {
  const ws = DEFAULT_REAL_SOLVE === 'wasm' && nnzL >= SOLVE_MIN_NNZL ? solveMemory(nnzL, n, maxFront, siLen) : null;
  return { Lx: ws ? ws.Lx : new Float64Array(nnzL), ws };
}

function solveMemory(nnzL, n, maxFront, siLen) {
  if (!wasmSolveSupported()) return null;
  // doubles: L | y (QCAP n) | t (maxFront) | V (QCAP) ; then int32 Si
  const yOff = nnzL + 2, tOff = yOff + QCAP * n + 2, vOff = tOff + maxFront + 2;
  const siByte = (vOff + QCAP + 2) * 8;
  const need = siByte + 4 * siLen + 64;
  if (need > SOLVE_MAX_BYTES) return null;
  try {
    const memory = new WebAssembly.Memory({ initial: Math.ceil(need / 65536) });
    const ex = new WebAssembly.Instance(compiled, { env: { memory } }).exports;
    const buf = memory.buffer;
    return { memory, ex, H: new Float64Array(buf), Lx: new Float64Array(buf, 0, nnzL), yOff, tOff, vOff, siOff: siByte / 4, I: new Int32Array(buf), siReady: false };
  } catch {
    return null; // allocation refused: plain arrays, JS solve
  }
}

/** Whether a factor with storage `ws` solves through the WASM kernels now. */
export const useWasmSolve = (ws) => !!ws && DEFAULT_REAL_SOLVE === 'wasm';

/** Cholesky solve (sparse.mjs solveNumeric) through the kernels; same contract (b, out in the original ordering). */
export function choleskySolveWasm(ws, sym, b, out) {
  const { n, perm, nsuper, superStart, Sp, Si, Lxp } = sym;
  const { H, ex, yOff, tOff } = ws;
  const yB = yOff * 8, tB = tOff * 8;
  for (let i = 0; i < n; i++) H[yOff + i] = b[perm[i]];
  for (let s = 0; s < nsuper; s++) {
    const f = superStart[s], nc = superStart[s + 1] - f, r0 = Sp[s], m = Sp[s + 1] - r0, mu = m - nc, pL = Lxp[s] * 8;
    ex.fdiag(pL, yB + f * 8, m, nc);
    if (mu === 0) continue;
    ex.facc(pL, yB + f * 8, tB, m, nc, mu);
    const rb = r0 + nc;
    for (let r = 0; r < mu; r++) H[yOff + Si[rb + r]] -= H[tOff + r];
  }
  for (let s = nsuper - 1; s >= 0; s--) {
    const f = superStart[s], nc = superStart[s + 1] - f, r0 = Sp[s], m = Sp[s + 1] - r0, mu = m - nc, pL = Lxp[s] * 8;
    const rb = r0 + nc;
    for (let r = 0; r < mu; r++) H[tOff + r] = H[yOff + Si[rb + r]];
    ex.bdiag(pL, yB + f * 8, tB, m, nc, mu);
  }
  out = out ?? new Float64Array(n);
  for (let i = 0; i < n; i++) out[perm[i]] = H[yOff + i];
  return out;
}

function ensureSi(ws, sym) {
  if (!ws.siReady) {
    ws.I.set(sym.Si, ws.siOff);
    ws.siReady = true;
  }
}

/** LDL^T solve of one vector (ldlt.mjs SupernodalLDLT.solve) through the kernels. */
export function ldltSolveWasm(ws, sym, D, b, out) {
  const { n, perm, nsuper, superStart, Sp, Lxp } = sym;
  ensureSi(ws, sym);
  const { H, ex, yOff, siOff } = ws;
  const yB = yOff * 8, siB = siOff * 4;
  for (let i = 0; i < n; i++) H[yOff + i] = b[perm[i]];
  for (let s = 0; s < nsuper; s++) {
    const f = superStart[s];
    ex.lfwd1(Lxp[s] * 8, yB, siB + Sp[s] * 4, Sp[s + 1] - Sp[s], superStart[s + 1] - f, f);
  }
  for (let j = 0; j < n; j++) H[yOff + j] /= D[j];
  for (let s = nsuper - 1; s >= 0; s--) {
    const f = superStart[s];
    ex.lbwd1(Lxp[s] * 8, yB, siB + Sp[s] * 4, Sp[s + 1] - Sp[s], superStart[s + 1] - f, f);
  }
  out = out ?? new Float64Array(n);
  for (let i = 0; i < n; i++) out[perm[i]] = H[yOff + i];
  return out;
}

/** LDL^T solve of q vectors stored one after another in b (ldlt.mjs solveMany), in chunks of at most QCAP. */
export function ldltSolveManyWasm(ws, sym, D, b, q, out) {
  const { n, perm, nsuper, superStart, Sp, Lxp } = sym;
  ensureSi(ws, sym);
  const { H, ex, yOff, vOff, siOff } = ws;
  const yB = yOff * 8, siB = siOff * 4, vB = vOff * 8;
  out = out ?? new Float64Array(n * q);
  for (let k0 = 0; k0 < q; k0 += QCAP) {
    const qq = Math.min(QCAP, q - k0);
    for (let i = 0; i < n; i++) {
      const pi = perm[i];
      for (let k = 0; k < qq; k++) H[yOff + i * qq + k] = b[(k0 + k) * n + pi];
    }
    for (let s = 0; s < nsuper; s++) {
      const f = superStart[s];
      ex.lfwdq(Lxp[s] * 8, yB, siB + Sp[s] * 4, Sp[s + 1] - Sp[s], superStart[s + 1] - f, f, qq);
    }
    for (let j = 0; j < n; j++) {
      const dj = 1 / D[j];
      for (let k = 0; k < qq; k++) H[yOff + j * qq + k] *= dj;
    }
    for (let s = nsuper - 1; s >= 0; s--) {
      const f = superStart[s];
      ex.lbwdq(Lxp[s] * 8, yB, siB + Sp[s] * 4, Sp[s + 1] - Sp[s], superStart[s + 1] - f, f, qq, vB);
    }
    for (let i = 0; i < n; i++) {
      const pi = perm[i];
      for (let k = 0; k < qq; k++) out[(k0 + k) * n + pi] = H[yOff + i * qq + k];
    }
  }
  return out;
}
