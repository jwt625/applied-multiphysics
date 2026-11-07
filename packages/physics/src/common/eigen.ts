// SPDX-License-Identifier: GPL-3.0-or-later
// Shift-invert eigen driver for the symmetric pencil K x = lambda M x (K symmetric, PSD or indefinite; M SPD), on
// @amp/core: the shifted matrix K - sigma M is factored once (supernodal Cholesky when it is SPD, i.e. sigma below the
// spectrum; supernodal LDL^T otherwise, whose negative pivot count gives the Sylvester inertia = number of eigenvalues
// below sigma), the operator is op(x) = (K - sigma M)^-1 M x, block Arnoldi with thick restart (la/arnoldi.mjs, EO
// vector-mode solveReal pattern) finds the Ritz values mu of largest modulus, lambda = sigma + 1 / mu. Ritz vectors are
// refined by one inverse-iteration step, eigenvalues recomputed as Rayleigh quotients, clusters M-orthonormalised.
// A projector hook (e.g. removal of a gradient null space) is applied to the start block and after every operator
// application, so null-space eigenvalues never enter the Krylov space.

import { analyze, SparseCholesky } from '@amp/core/la/sparse';
import { SupernodalLDLT } from '@amp/core/la/ldlt';
import { blockArnoldi } from '@amp/core/la/arnoldi';
import type { Csr } from './scalar.ts';

export interface EigenInput {
  pat: Csr;
  /** values of K and M on `pat` (full symmetric storage) */
  K: Float64Array;
  M: Float64Array;
  /** shift; eigenvalues closest to sigma are found first */
  sigma: number;
  nWant: number;
  /** in-place projection applied to every Krylov vector (null-space removal) */
  project?: (x: Float64Array) => void;
  tol?: number;
  blockSize?: number;
  maxBasis?: number;
  maxRestarts?: number;
  seed?: number;
  /** 'auto' (default): Cholesky if sigma < 0 and K is PSD by the caller's statement `kPsd`, else LDL^T */
  factor?: 'auto' | 'cholesky' | 'ldlt';
  kPsd?: boolean;
  signal?: AbortSignal;
}

export interface EigenResult {
  lambda: Float64Array;
  vecs: Float64Array[];
  /** relative residual ||K x - lambda M x|| / (||K x|| + |lambda| ||M x||) per pair */
  residual: Float64Array;
  stats: {
    n: number; nnz: number; factor: 'cholesky' | 'ldlt'; nnzL: number; nNegative: number | null; nPerturbed: number;
    factorMs: number; arnoldiMs: number; refineMs: number; opApplications: number; restarts: number; converged: boolean;
  };
}

function mv(p: Csr, v: Float64Array, x: Float64Array, out: Float64Array): Float64Array {
  for (let i = 0; i < p.n; i++) {
    let s = 0;
    for (let q = p.rowptr[i]!; q < p.rowptr[i + 1]!; q++) s += v[q]! * x[p.colidx[q]!]!;
    out[i] = s;
  }
  return out;
}
const dot = (a: Float64Array, b: Float64Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

export function shiftInvertEigen(o: EigenInput): EigenResult {
  const { pat, K, M, sigma } = o;
  const n = pat.n;
  const A = new Float64Array(pat.nnz);
  for (let q = 0; q < pat.nnz; q++) A[q] = K[q]! - sigma * M[q]!;
  const kind = o.factor === 'cholesky' || (o.factor !== 'ldlt' && sigma < 0 && o.kPsd) ? 'cholesky' : 'ldlt';
  const t0 = performance.now();
  let solveMany: (b: Float64Array, m: number) => Float64Array;
  let nnzL = 0, nNegative: number | null = null, nPerturbed = 0;
  if (kind === 'cholesky') {
    const ch = new SparseCholesky(pat);
    if (!ch.factor(A)) throw new Error('eigen: K - sigma M is not positive definite (sigma not below the spectrum?)');
    nnzL = Number(ch.nnzL);
    solveMany = (b, m) => {
      if (m === 1) return ch.solve(b, new Float64Array(n)) as Float64Array;
      const bs = Array.from({ length: m }, (_, c) => b.subarray(c * n, (c + 1) * n));
      const xs = ch.solveMany(bs) as Float64Array[];
      const out = new Float64Array(n * m);
      xs.forEach((x, c) => out.set(x, c * n));
      return out;
    };
    nNegative = 0;
  } else {
    const sym = analyze(pat);
    const f = new SupernodalLDLT(sym);
    const r = f.factor(A);
    if (!r.ok) throw new Error('eigen: LDL^T of K - sigma M failed (sigma on an eigenvalue?)');
    nnzL = Number(sym.nnzL); nNegative = r.nNeg ?? null; nPerturbed = r.nPerturbed ?? 0;
    solveMany = (b, m) => (m === 1 ? f.solve(b, new Float64Array(n)) : f.solveMany(b, m, new Float64Array(n * m))) as Float64Array;
  }
  const factorMs = performance.now() - t0;
  const tmp = new Float64Array(n);
  let opApps = 0;
  const op = (X: Float64Array[]): Float64Array[] => {
    if (o.signal?.aborted) throw new Error('run cancelled');
    const m = X.length, rhs = new Float64Array(n * m);
    for (let c = 0; c < m; c++) mv(pat, M, X[c]!, rhs.subarray(c * n, (c + 1) * n));
    const sol = solveMany(rhs, m);
    opApps += m;
    return X.map((_, c) => {
      const y = sol.slice(c * n, (c + 1) * n);
      if (o.project) o.project(y);
      return y;
    });
  };
  const b = o.blockSize ?? 1;
  const nWant = o.nWant;
  const X0: Float64Array[] = [];
  if (o.project) {
    // projected random start block (Arnoldi's own random start would carry null-space components)
    let s = (o.seed ?? 20261106) >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
    for (let c = 0; c < b; c++) { const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = rnd(); o.project(v); X0.push(v); }
  }
  const t1 = performance.now();
  const ar = blockArnoldi(n, op, {
    nWant, blockSize: b, maxBasis: o.maxBasis ?? Math.max(30, 2 * nWant + 12), tol: o.tol ?? 1e-10,
    X0: X0.length ? X0 : null, maxRestarts: o.maxRestarts ?? 60, seed: o.seed ?? 20261106, realOnly: true,
  });
  const arnoldiMs = performance.now() - t1;
  // refine: one inverse-iteration step, Rayleigh quotients, M-orthonormalise clusters
  const t2 = performance.now();
  let vecs = op(ar.vecs.map((v) => v.re));
  const Kx = new Float64Array(n), Mx = new Float64Array(n);
  let lam = vecs.map((x) => { mv(pat, K, x, Kx); mv(pat, M, x, Mx); return dot(x, Kx) / dot(x, Mx); });
  const order = lam.map((_, i) => i).sort((i, j) => lam[i]! - lam[j]!);
  vecs = order.map((i) => vecs[i]!); lam = order.map((i) => lam[i]!);
  // M-Gram-Schmidt within clusters (relative gap 1e-6), then M-normalise
  const done: Float64Array[] = [];
  for (let i = 0; i < vecs.length; i++) {
    const x = vecs[i]!;
    for (let j = 0; j < i; j++) {
      if (Math.abs(lam[j]! - lam[i]!) > 1e-6 * Math.max(Math.abs(lam[i]!), 1e-300)) continue;
      const y = done[j]!;
      mv(pat, M, y, Mx);
      const c = dot(x, Mx);
      for (let q = 0; q < n; q++) x[q]! -= c * y[q]!;
    }
    mv(pat, M, x, Mx);
    const nm = Math.sqrt(dot(x, Mx));
    for (let q = 0; q < n; q++) x[q]! /= nm;
    done.push(x);
  }
  const residual = new Float64Array(done.length);
  const lambda = new Float64Array(done.length);
  done.forEach((x, i) => {
    mv(pat, K, x, Kx); mv(pat, M, x, Mx);
    const l = dot(x, Kx) / dot(x, Mx);
    lambda[i] = l;
    let r = 0, a = 0, c = 0;
    for (let q = 0; q < n; q++) { r += (Kx[q]! - l * Mx[q]!) ** 2; a += Kx[q]! ** 2; c += Mx[q]! ** 2; }
    residual[i] = Math.sqrt(r) / (Math.sqrt(a) + Math.abs(l) * Math.sqrt(c) || 1);
  });
  const refineMs = performance.now() - t2;
  return {
    lambda, vecs: done, residual,
    stats: { n, nnz: pat.nnz, factor: kind, nnzL, nNegative, nPerturbed, factorMs, arnoldiMs, refineMs, opApplications: opApps + 0, restarts: ar.restarts, converged: ar.converged },
  };
}

// small helper shared by the eigen modules
export { mv as csrMatVec, dot as dotVec };
