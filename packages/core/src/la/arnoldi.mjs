// Ported from eo-modulator-atlas/engine/src/vector-mode.mjs at 0546007 (GPL-3.0-or-later). Changes: lines 825-1087
// (block Arnoldi with DGKS reorthogonalisation and thick restart, Ritz extraction) extracted verbatim into this
// module; the physics (Lee-Sun-Cendes pencil, shift choice, inertia check, post-processing) stays in EO. `blockArnoldi`
// is exported as before; `ritz`, `ritzBasis`, `seededRandom` and `dotv` are exported in addition (no code change).
// The caller supplies the operator, e.g. shift-invert X -> (A + sigma B)^-1 B X with an LDL^T of la/ldlt.mjs (EO
// vector-mode.mjs solveReal: Ritz value mu gives the pencil eigenvalue theta = sigma - 1 / mu).
// SPDX-License-Identifier: GPL-3.0-or-later

import { eigenvalues, realEigenvectors, complexEigenvectors } from './vector-dense.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Block Arnoldi (shift-invert operator), Ritz extraction.

export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

export function dotv(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Block Arnoldi with full (DGKS) reorthogonalisation and thick restart for the eigenvalues of largest modulus of a
 * linear operator. Thick restart: from C V_m = V_m H_m + W H_low, the kept Ritz vectors V_m Q (Q orthonormal basis of
 * the selected Ritz vectors of H_m) give the Krylov decomposition C U = U (Q^T H_m Q) + W (H_low Q) (exact up to the
 * Ritz-vector accuracy), and the Arnoldi process continues from the residual block W without losing the kept space.
 * @param {number} N vector length
 * @param {(X:Float64Array[]) => Float64Array[]} op
 * @param {{nWant:number, blockSize:number, maxBasis:number, tol:number, X0:Float64Array[]|null, maxRestarts:number,
 *   seed:number, realOnly:boolean, nKeep?:number}} o
 * @returns {{mu:{re:number,im:number}[], vecs:{re:Float64Array, im:Float64Array|null}[], ritzRes:number[], basis:number, opVectors:number, restarts:number, converged:boolean}}
 */
export function blockArnoldi(N, op, o) {
  const rnd = seededRandom(o.seed ?? 20261014);
  const b = o.blockSize;
  let mMax = Math.max(o.firstCycleBasis ?? o.maxBasis, o.nWant + 3 * b);
  const mMaxLater = Math.max(o.maxBasis, o.nWant + 3 * b);
  const nKeep = Math.min(o.nKeep ?? o.nWant + Math.max(2, o.nWant), Math.min(mMax, mMaxLater) - 2 * b);
  const ld = Math.max(mMax, mMaxLater);
  let H = new Float64Array((ld + b) * ld);
  let V = [];
  let opVectors = 0, restarts = 0;
  const addVec = (w, col) => {
    // DGKS: orthogonalise against V, a second pass if the norm dropped; coefficients accumulate into column col
    const n0 = Math.sqrt(dotv(w, w));
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < V.length; i++) {
        const vi = V[i];
        const h = dotv(vi, w);
        if (col >= 0) H[i * ld + col] += h;
        for (let q = 0; q < N; q++) w[q] -= h * vi[q];
      }
      if (Math.sqrt(dotv(w, w)) > 0.7 * n0) break;
    }
    let nw = Math.sqrt(dotv(w, w));
    if (!(nw > 1e-12 * (n0 || 1))) {
      // breakdown (invariant subspace or dependent start): continue with a random direction, H entry 0
      for (let q = 0; q < N; q++) w[q] = rnd();
      for (let pass = 0; pass < 2; pass++)
        for (let i = 0; i < V.length; i++) {
          const h = dotv(V[i], w);
          for (let q = 0; q < N; q++) w[q] -= h * V[i][q];
        }
      const nr = Math.sqrt(dotv(w, w));
      for (let q = 0; q < N; q++) w[q] /= nr;
      nw = 0;
    } else for (let q = 0; q < N; q++) w[q] /= nw;
    if (col >= 0) H[V.length * ld + col] = nw;
    V.push(w);
  };
  // initial block: warm vectors folded into b columns, random otherwise
  const X0 = o.X0 && o.X0.length ? o.X0 : null;
  for (let k = 0; k < b; k++) {
    const w = new Float64Array(N);
    if (X0 && k < X0.length) for (let j = k; j < X0.length; j += b) for (let q = 0; q < N; q++) w[q] += X0[j][q];
    else for (let q = 0; q < N; q++) w[q] = rnd();
    addVec(w, -1);
  }
  let col = 0;
  for (;;) {
    let converged = false;
    while (col < mMax) {
      const nb = Math.min(b, mMax - col);
      const W = op(V.slice(col, col + nb));
      opVectors += nb;
      for (let c = 0; c < nb; c++) addVec(W[c], col + c);
      col += nb;
      if (col >= o.nWant + b && ritz(H, ld, col, V, o, false).converged) {
        converged = true;
        break;
      }
    }
    if (converged || restarts >= o.maxRestarts) {
      const last = ritz(H, ld, col, V, o, true);
      return { ...last, basis: col, opVectors, restarts };
    }
    if (restarts === 0 && o.onFirstRestart) {
      // caller may change the operator (adaptive shift): return the current Ritz pairs and stop
      const peek = ritz(H, ld, col, V, o, false);
      if (o.onFirstRestart(peek.mu)) {
        const last = ritz(H, ld, col, V, o, true);
        return { ...last, basis: col, opVectors, restarts, switched: true };
      }
    }
    // thick restart
    restarts++;
    const m = col;
    const keep = ritzBasis(H, ld, m, nKeep, o.realOnly);
    const k = keep.k, Q = keep.Q; // Q: m x k row-major, orthonormal columns
    const Hm = keep.Hm;
    const U = [];
    for (let c = 0; c < k; c++) {
      const u = new Float64Array(N);
      for (let i = 0; i < m; i++) {
        const qi = Q[i * k + c];
        if (qi === 0) continue;
        const vi = V[i];
        for (let q = 0; q < N; q++) u[q] += qi * vi[q];
      }
      U.push(u);
    }
    const Wv = V.slice(m, m + b);
    const Hn = new Float64Array((ld + b) * ld);
    // Q^T H_m Q
    const HQ = new Float64Array(m * k);
    for (let i = 0; i < m; i++)
      for (let c = 0; c < k; c++) {
        let sum = 0;
        for (let j = 0; j < m; j++) sum += Hm[i * m + j] * Q[j * k + c];
        HQ[i * k + c] = sum;
      }
    for (let r = 0; r < k; r++)
      for (let c = 0; c < k; c++) {
        let sum = 0;
        for (let i = 0; i < m; i++) sum += Q[i * k + r] * HQ[i * k + c];
        Hn[r * ld + c] = sum;
      }
    for (let r = 0; r < Wv.length; r++)
      for (let c = 0; c < k; c++) {
        let sum = 0;
        for (let j = 0; j < m; j++) sum += H[(m + r) * ld + j] * Q[j * k + c];
        Hn[(k + r) * ld + c] = sum;
      }
    H = Hn;
    V = [...U, ...Wv];
    col = k;
    mMax = mMaxLater;
  }
}

/** Orthonormal basis (m x k, row-major) of the nKeep dominant Ritz vectors of H_m (complex pairs as re/im columns). */
export function ritzBasis(H, ld, m, nKeep, realOnly) {
  const Hm = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) Hm[i * m + j] = H[i * ld + j];
  const { re, im } = eigenvalues(Hm, m);
  const idx = [];
  for (let i = 0; i < m; i++) {
    const real = Math.abs(im[i]) <= 1e-9 * Math.hypot(re[i], im[i]);
    if (realOnly && !real) continue;
    if (!real && im[i] < 0) continue;
    idx.push(i);
  }
  idx.sort((a, c) => Math.hypot(re[c], im[c]) - Math.hypot(re[a], im[a]));
  const cols = [];
  const realL = [];
  const sel = [];
  for (const i of idx) {
    const real = Math.abs(im[i]) <= 1e-9 * Math.hypot(re[i], im[i]);
    const need = real ? 1 : 2;
    if (cols.length + sel.reduce((s, x) => s + x.need, 0) + need > nKeep) break;
    sel.push({ i, real, need });
    if (real) realL.push(re[i]);
  }
  const rv = realL.length ? realEigenvectors(Hm, m, realL) : [];
  let ri = 0;
  const cplx = [];
  for (const s of sel) {
    if (s.real) cols.push(rv[ri++]);
    else {
      const prev = cplx.filter((c) => Math.hypot(re[c.i] - re[s.i], im[c.i] - im[s.i]) <= 1e-7 * Math.hypot(re[s.i], im[s.i])).map((c) => c.v);
      const v = complexEigenvectors(Hm, m, re[s.i], im[s.i], { prev });
      cplx.push({ i: s.i, v });
      cols.push(v.re, v.im);
    }
  }
  // modified Gram-Schmidt (twice) in R^m, dropping dependent columns
  const kept = [];
  for (const c0 of cols) {
    const c = Float64Array.from(c0);
    const n0 = Math.sqrt(dotv(c, c));
    for (let pass = 0; pass < 2; pass++)
      for (const q of kept) {
        const d = dotv(q, c);
        for (let i = 0; i < m; i++) c[i] -= d * q[i];
      }
    const nc = Math.sqrt(dotv(c, c));
    if (nc > 1e-8 * n0) {
      for (let i = 0; i < m; i++) c[i] /= nc;
      kept.push(c);
    }
  }
  const k = kept.length;
  const Q = new Float64Array(m * k);
  for (let c = 0; c < k; c++) for (let i = 0; i < m; i++) Q[i * k + c] = kept[c][i];
  return { k, Q, Hm };
}

/** Ritz pairs of the leading m x m block of H; residual norms from the rows below m. */
export function ritz(H, ld, m, V, o, formVectors) {
  const Hm = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) Hm[i * m + j] = H[i * ld + j];
  const { re, im } = eigenvalues(Hm, m);
  const idx = [];
  for (let i = 0; i < m; i++) {
    const real = Math.abs(im[i]) <= 1e-9 * Math.hypot(re[i], im[i]);
    if (o.realOnly && !real) continue;
    if (!o.realOnly && im[i] < 0) continue; // take one of each conjugate pair (the operator is realified)
    idx.push(i);
  }
  idx.sort((a, b) => Math.hypot(re[b], im[b]) - Math.hypot(re[a], im[a]));
  const want = idx.slice(0, o.nWant);
  const mus = want.map((i) => ({ re: re[i], im: Math.abs(im[i]) <= 1e-9 * Math.hypot(re[i], im[i]) ? 0 : im[i] }));
  const rows = V.length - m; // rows below the leading block
  const vecs = [], ritzRes = [];
  let converged = want.length === o.nWant;
  // real eigenvectors in one call (clusters handled), complex ones separately
  const realLams = mus.filter((u) => u.im === 0).map((u) => u.re);
  const realVecs = realLams.length ? realEigenvectors(Hm, m, realLams) : [];
  let ri = 0;
  const cplx = [];
  for (const mu of mus) {
    let yr, yi = null;
    if (mu.im === 0) yr = realVecs[ri++];
    else {
      const prev = cplx.filter((c) => Math.hypot(c.mu.re - mu.re, c.mu.im - mu.im) <= 1e-7 * Math.hypot(mu.re, mu.im)).map((c) => c.v);
      const v = complexEigenvectors(Hm, m, mu.re, mu.im, { prev });
      cplx.push({ mu, v });
      ({ re: yr, im: yi } = v);
    }
    // residual || H[m:, :m] y ||
    let rs = 0;
    for (let r = 0; r < rows; r++) {
      let sr = 0, si = 0;
      for (let c = 0; c < m; c++) {
        const h = H[(m + r) * ld + c];
        if (h === 0) continue;
        sr += h * yr[c];
        if (yi) si += h * yi[c];
      }
      rs += sr * sr + si * si;
    }
    const rel = Math.sqrt(rs) / Math.hypot(mu.re, mu.im);
    ritzRes.push(rel);
    if (!(rel < o.tol)) converged = false;
    if (!formVectors) continue;
    const N = V[0].length;
    const ur = new Float64Array(N), ui = yi ? new Float64Array(N) : null;
    for (let c = 0; c < m; c++) {
      const a = yr[c], bb = yi ? yi[c] : 0, vc = V[c];
      if (a !== 0) for (let q = 0; q < N; q++) ur[q] += a * vc[q];
      if (bb !== 0) for (let q = 0; q < N; q++) ui[q] += bb * vc[q];
    }
    vecs.push({ re: ur, im: ui });
  }
  return { mu: mus, vecs, ritzRes, converged };
}

