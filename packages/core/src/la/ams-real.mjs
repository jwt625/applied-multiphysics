// SPDX-License-Identifier: GPL-3.0-or-later
// Real symmetric positive definite preconditioners for Nedelec (H(curl)) systems A = K + beta M (beta > 0), and a CSR
// preconditioned conjugate gradient (lane E8, DevLog-054). Real-valued counterparts of ./ams.mjs and ./pmg.mjs (ported
// from advanced-packaging-atlas for the complex driven problem; structure from Palace, Apache-2.0, see ../../NOTICE),
// written for the em3d eigen path (K - sigma M with sigma < 0) where everything is real:
//   buildAMSReal: Hiptmair-Xu auxiliary-space Maxwell preconditioner on the order-1 (Whitney) system: discrete gradient
//     G (nodal scalar space) and nodal interpolation Pi_x, Pi_y, Pi_z (nodal vector space), auxiliary operators
//     T^T A T with one smoothed-aggregation AMG V-cycle each (./amg.mjs), cycle "01210": forward Gauss-Seidel on A,
//     G correction, the three Pi corrections (additive, on one residual), G correction, backward Gauss-Seidel.
//     Symmetric (the AMG V-cycles are symmetric), so it can precondition CG.
//   buildPMGReal: two-level p-multigrid for the order-2 hierarchical Nedelec system (./pmg.mjs structure): forward
//     Gauss-Seidel on A, Hiptmair correction on the H1-P2 gradient space (forward Gauss-Seidel on G^T A G), coarse
//     correction on the Whitney block (a prefix of the DOFs; exact Galerkin with the hierarchical basis) by a given
//     coarse preconditioner (one AMS cycle), then the transpose post-smoothing. Symmetric.
//   pcgCsr: CG with a symmetric preconditioner on a CSR operator; stops at ||r|| <= rtol ||b||.
// License: GPL-3.0-or-later.

import { buildAMG, csrTranspose, csrMatMat } from './amg.mjs';
import { makeCsrKernels } from './wasm/csr.mjs';

// WASM CSR kernels (bitwise identical to the JS loops, DevLog-060) per value array; null = JS loops
const kernelCache = new WeakMap();
function kernelsOf(pat, val) {
  if (kernelCache.has(val)) {
    const k = kernelCache.get(val);
    if (!k || k.pat === pat) return k ? k.k : null;
  }
  const k = makeCsrKernels(pat, val, diagSlotsOrNull(pat));
  kernelCache.set(val, k ? { pat, k } : null);
  return k;
}
function diagSlotsOrNull(pat) {
  try { return diagSlots(pat); } catch { return null; }
}

const fail = (m) => {
  throw new Error(`ams-real: ${m}`);
};

/** Diagonal slot of every row (throws when a diagonal entry is missing). */
export function diagSlots(pat) {
  const d = new Int32Array(pat.n).fill(-1);
  for (let i = 0; i < pat.n; i++)
    for (let q = pat.rowptr[i]; q < pat.rowptr[i + 1]; q++)
      if (pat.colidx[q] === i) {
        d[i] = q;
        break;
      }
  for (let i = 0; i < pat.n; i++) if (d[i] < 0) fail(`diagonal of row ${i} missing`);
  return d;
}

/** y = A x (CSR). */
export function spmvCsr(pat, val, x, y) {
  return spmvJs(pat, val, x, y);
}

/** y = A x for a square A, through the WASM kernel when available (bitwise identical). */
function spmvSq(pat, val, x, y) {
  const k = kernelsOf(pat, val);
  if (k) return k.spmv(x, y);
  return spmvJs(pat, val, x, y);
}

function spmvJs(pat, val, x, y) {
  const { rowptr, colidx } = pat;
  for (let i = 0; i < pat.n; i++) {
    let s = 0;
    for (let q = rowptr[i]; q < rowptr[i + 1]; q++) s += val[q] * x[colidx[q]];
    y[i] = s;
  }
  return y;
}

/** One Gauss-Seidel sweep on A x = b in place; dir +1 forward, -1 backward. */
function gs(pat, val, diag, b, x, dir) {
  const k = kernelsOf(pat, val);
  if (k) return k.gs(b, x, dir);
  const { rowptr, colidx } = pat;
  const n = pat.n;
  for (let k = 0; k < n; k++) {
    const i = dir > 0 ? k : n - 1 - k;
    let s = b[i];
    const dq = diag[i];
    for (let q = rowptr[i]; q < rowptr[i + 1]; q++) if (q !== dq) s -= val[q] * x[colidx[q]];
    x[i] = s / val[dq];
  }
}

/** Galerkin product T^T A T (CSR, rows sorted) with zero-diagonal columns of T removed; returns {A, T, TT}. */
function auxOperator(Ap, T) {
  let TT = csrTranspose(T);
  let A = csrMatMat(TT, csrMatMat(Ap, T));
  const diag = new Float64Array(A.n);
  for (let i = 0; i < A.n; i++) for (let q = A.rowptr[i]; q < A.rowptr[i + 1]; q++) if (A.colidx[q] === i) diag[i] = A.val[q];
  const keep = [];
  for (let i = 0; i < A.n; i++) if (diag[i] > 0) keep.push(i);
  if (keep.length < A.n) {
    // columns of T whose auxiliary function has no energy on the free DOFs: drop them
    const map = new Int32Array(A.n).fill(-1);
    keep.forEach((c, k) => (map[c] = k));
    const rp = new Int32Array(T.n + 1), ci = [], cv = [];
    for (let i = 0; i < T.n; i++) {
      for (let q = T.rowptr[i]; q < T.rowptr[i + 1]; q++) {
        const c = map[T.colidx[q]];
        if (c >= 0) {
          ci.push(c);
          cv.push(T.val[q]);
        }
      }
      rp[i + 1] = ci.length;
    }
    T = { n: T.n, m: keep.length, rowptr: rp, colidx: Int32Array.from(ci), val: Float64Array.from(cv) };
    TT = csrTranspose(T);
    A = csrMatMat(TT, csrMatMat(Ap, T));
  }
  return { A, T, TT };
}

/**
 * AMS for the real SPD Whitney system. pat / val: CSR (full symmetric storage) of A; G: discrete gradient
 * {n, m, rowptr, colidx, val} (rows = DOFs of A); Pis: [Pi_x, Pi_y, Pi_z] in the same form. Returns
 * {apply(b, x): x = B^-1 b (x overwritten), stats}.
 */
export function buildAMSReal({ pat, val, G, Pis, amg = {} }) {
  const t0 = performance.now();
  const n = pat.n;
  const Ap = { n, m: n, rowptr: pat.rowptr, colidx: pat.colidx, val };
  const diag = diagSlots(pat);
  const aux = [G, ...Pis].map((T0) => {
    const { A, T, TT } = auxOperator(Ap, T0);
    const h = buildAMG({ n: A.n, rowptr: A.rowptr, colidx: A.colidx, val: A.val }, amg);
    return { T, TT, amg: h, m: A.n, b: new Float64Array(A.n), x: new Float64Array(A.n) };
  });
  const r = new Float64Array(n);
  const residual = (b, x) => {
    spmvSq(pat, val, x, r);
    for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
  };
  const auxStep = (a, x) => {
    spmvCsr(a.TT, a.TT.val, r, a.b);
    a.amg.cycle(a.b, a.x);
    const { T } = a;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let q = T.rowptr[i]; q < T.rowptr[i + 1]; q++) s += T.val[q] * a.x[T.colidx[q]];
      x[i] += s;
    }
  };
  let nApply = 0;
  const apply = (b, x) => {
    nApply++;
    x.fill(0);
    gs(pat, val, diag, b, x, 1);
    residual(b, x);
    auxStep(aux[0], x);
    residual(b, x);
    for (let d = 1; d < aux.length; d++) auxStep(aux[d], x);
    residual(b, x);
    auxStep(aux[0], x);
    gs(pat, val, diag, b, x, -1);
  };
  return { apply, stats: { setupMs: performance.now() - t0, aux: aux.map((a) => ({ n: a.m, levels: a.amg.levels.length })), get applications() { return nApply; } } };
}

/**
 * Two-level p-multigrid for the real SPD order-2 hierarchical Nedelec system. pat / val: A; nc: number of leading
 * (Whitney) DOFs; Gf: gradient of the H1-P2 auxiliary space (rows = DOFs of A); coarse: {apply(b, x)} on the Whitney
 * block. Returns {apply(b, x), stats}.
 */
export function buildPMGReal({ pat, val, nc, Gf, coarse }) {
  const t0 = performance.now();
  const n = pat.n;
  const diag = diagSlots(pat);
  const Ap = { n, m: n, rowptr: pat.rowptr, colidx: pat.colidx, val };
  const { A: AG, T: G, TT: GT } = auxOperator(Ap, Gf);
  const gpat = { n: AG.n, rowptr: AG.rowptr, colidx: AG.colidx, nnz: AG.rowptr[AG.n] };
  const gdiag = diagSlots(gpat);
  const r = new Float64Array(n), rg = new Float64Array(AG.n), xg = new Float64Array(AG.n);
  const rc = new Float64Array(nc), ec = new Float64Array(nc);
  const residual = (b, x) => {
    spmvSq(pat, val, x, r);
    for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
  };
  const auxCorrect = (b, x, dir) => {
    residual(b, x);
    spmvCsr(GT, GT.val, r, rg);
    xg.fill(0);
    gs(gpat, AG.val, gdiag, rg, xg, dir);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let q = G.rowptr[i]; q < G.rowptr[i + 1]; q++) s += G.val[q] * xg[G.colidx[q]];
      x[i] += s;
    }
  };
  let nApply = 0;
  const apply = (b, x) => {
    nApply++;
    x.fill(0);
    gs(pat, val, diag, b, x, 1);
    auxCorrect(b, x, 1);
    residual(b, x);
    for (let i = 0; i < nc; i++) rc[i] = r[i];
    coarse.apply(rc, ec);
    for (let i = 0; i < nc; i++) x[i] += ec[i];
    auxCorrect(b, x, -1);
    gs(pat, val, diag, b, x, -1);
  };
  return { apply, stats: { setupMs: performance.now() - t0, aux: AG.n, get applications() { return nApply; } } };
}

/** Leading principal block A[0:nc, 0:nc] of a CSR matrix (rows sorted): {pat, val}. */
export function leadingBlock(pat, val, nc) {
  const rowptr = new Int32Array(nc + 1), cols = [], vals = [];
  for (let i = 0; i < nc; i++) {
    for (let q = pat.rowptr[i]; q < pat.rowptr[i + 1]; q++) {
      const j = pat.colidx[q];
      if (j < nc) {
        cols.push(j);
        vals.push(val[q]);
      }
    }
    rowptr[i + 1] = cols.length;
  }
  return { pat: { n: nc, rowptr, colidx: Int32Array.from(cols), nnz: cols.length }, val: Float64Array.from(vals) };
}

/**
 * Preconditioned CG on a CSR operator: solves A x = b to ||b - A x|| <= rtol ||b|| (x: initial guess, overwritten).
 * precond(r, z) must be symmetric positive definite. Returns {iterations, relres, converged}. The products use the WASM
 * CSR kernels (la/wasm/csr.mjs, bitwise identical), which copy `val` on first use per value array: values must not be
 * changed in place afterwards (the same holds for the matrices given to buildAMSReal / buildPMGReal).
 */
export function pcgCsr(pat, val, precond, b, x, { rtol = 1e-10, maxIter = 1000 } = {}) {
  const n = pat.n;
  const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n);
  spmvSq(pat, val, x, q);
  let bn = 0;
  for (let i = 0; i < n; i++) {
    r[i] = b[i] - q[i];
    bn += b[i] * b[i];
  }
  bn = Math.sqrt(bn);
  if (bn === 0) {
    x.fill(0);
    return { iterations: 0, relres: 0, converged: true };
  }
  let rn = 0;
  for (let i = 0; i < n; i++) rn += r[i] * r[i];
  rn = Math.sqrt(rn);
  if (rn <= rtol * bn) return { iterations: 0, relres: rn / bn, converged: true };
  precond(r, z);
  p.set(z);
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  let it = 0;
  for (it = 1; it <= maxIter; it++) {
    spmvSq(pat, val, p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i] * q[i];
    if (!(pq > 0)) fail(`pcg: p^T A p = ${pq} at iteration ${it} (operator or preconditioner not SPD)`);
    const al = rz / pq;
    rn = 0;
    for (let i = 0; i < n; i++) {
      x[i] += al * p[i];
      r[i] -= al * q[i];
      rn += r[i] * r[i];
    }
    rn = Math.sqrt(rn);
    if (rn <= rtol * bn) break;
    precond(r, z);
    let rz2 = 0;
    for (let i = 0; i < n; i++) rz2 += r[i] * z[i];
    const be = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + be * p[i];
  }
  return { iterations: Math.min(it, maxIter), relres: rn / bn, converged: rn <= rtol * bn };
}
