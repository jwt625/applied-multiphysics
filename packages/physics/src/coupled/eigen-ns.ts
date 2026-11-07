// SPDX-License-Identifier: GPL-3.0-or-later
// Shift-invert eigen driver for an unsymmetric pencil K x = lambda M x whose shifted matrix becomes symmetric after a
// row scaling: S = diag(s(sigma)) (K - sigma M) symmetric (lane MT, DevLog-033; the u-p acoustic-structure pencil,
// rows of the fluid block scaled by 1 / sigma). S is factored once by supernodal LDL^T; the operator
// op(x) = (K - sigma M)^-1 M x = S^-1 diag(s) M x is not symmetric, so the eigenvalues come from block Arnoldi
// (la/arnoldi.mjs, real Ritz values: the coupled spectrum is real), lambda = sigma + 1 / mu (Ritz value). Each Ritz
// vector gets one inverse-iteration step (repeated steps would drift towards the eigenvector nearest sigma); the
// residual ||K x - lambda M x|| / (||K x|| + |lambda| ||M x||) of the diag(M)^-1/2-scaled pencil is reported per pair.

import { analyze } from '@amp/core/la/sparse';
import { SupernodalLDLT } from '@amp/core/la/ldlt';
import { blockArnoldi } from '@amp/core/la/arnoldi';
import type { Csr } from '../common/scalar.ts';
import { csrMv, jacobiScale, scaleSym } from './assemble.ts';

export interface NsEigenInput {
  pat: Csr;
  /** K and M on `pat` (full storage, values need not be symmetric) */
  K: Float64Array;
  M: Float64Array;
  /** row scale of K - sigma M that makes it symmetric */
  rowScale: (sigma: number) => Float64Array;
  sigma: number;
  nWant: number;
  tol?: number;
  maxBasis?: number;
  maxRestarts?: number;
  seed?: number;
  signal?: AbortSignal;
}

export interface NsEigenResult {
  lambda: Float64Array;
  vecs: Float64Array[];
  residual: Float64Array;
  stats: { n: number; nnz: number; nnzL: number; nNegative: number | null; nPerturbed: number; asymmetry: number; factorMs: number; arnoldiMs: number; refineMs: number; opApplications: number; restarts: number; converged: boolean };
}

export function shiftInvertEigenNs(o: NsEigenInput): NsEigenResult {
  const { pat, sigma } = o, n = pat.n;
  if (sigma === 0) throw new Error('eigen-ns: sigma must be non-zero');
  // the whole driver runs on the pencil scaled by D = diag(M)^-1/2 (K' = D K D, M' = D M D, x = D x'): the solid and
  // fluid unknowns differ by orders of magnitude in SI, and Arnoldi's Euclidean orthogonalisation and the residuals
  // need comparable blocks; eigenvalues are unchanged, residuals are those of the scaled pencil
  const Dm = new Float64Array(n).fill(1);
  {
    const dk = jacobiScale(pat, o.K);
    for (let i = 0; i < n; i++) {
      Dm[i] = dk[i]!;
      for (let q = pat.rowptr[i]!; q < pat.rowptr[i + 1]!; q++) if (pat.colidx[q] === i && o.M[q]! !== 0) Dm[i] = 1 / Math.sqrt(Math.abs(o.M[q]!));
    }
  }
  const K = scaleSym(pat, o.K, Dm), M = scaleSym(pat, o.M, Dm);
  const s = o.rowScale(sigma);
  const S = new Float64Array(pat.nnz);
  for (let i = 0; i < n; i++) for (let q = pat.rowptr[i]!; q < pat.rowptr[i + 1]!; q++) S[q] = s[i]! * (K[q]! - sigma * M[q]!);
  // symmetry check of the scaled matrix (max |S_ij - S_ji| / max |S|)
  let asym = 0, smax = 0;
  for (let i = 0; i < n; i++) for (let q = pat.rowptr[i]!; q < pat.rowptr[i + 1]!; q++) {
    const j = pat.colidx[q]!;
    smax = Math.max(smax, Math.abs(S[q]!));
    if (j <= i) continue;
    let lo = pat.rowptr[j]!, hi = pat.rowptr[j + 1]! - 1, v = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1, c = pat.colidx[mid]!; if (c === i) { v = S[mid]!; break; } if (c < i) lo = mid + 1; else hi = mid - 1; }
    asym = Math.max(asym, Math.abs(S[q]! - v));
  }
  const asymmetry = asym / (smax || 1);
  if (asymmetry > 1e-10) throw new Error(`eigen-ns: scaled shifted matrix is not symmetric (${asymmetry})`);
  // Jacobi scaling S' = D S D (solid and fluid blocks differ by many orders of magnitude in SI)
  const dsc = jacobiScale(pat, S), Ss = scaleSym(pat, S, dsc);
  const t0 = performance.now();
  const f = new SupernodalLDLT(analyze(pat));
  const r = f.factor(Ss);
  if (!r.ok) throw new Error('eigen-ns: LDL^T of the scaled K - sigma M failed (sigma on an eigenvalue?)');
  const factorMs = performance.now() - t0;
  const tmp = new Float64Array(n);
  let opApps = 0;
  const op1 = (x: Float64Array): Float64Array => {
    csrMv(pat, M, x, tmp);
    for (let i = 0; i < n; i++) tmp[i]! *= s[i]! * dsc[i]!;
    opApps++;
    const y = f.solve(tmp, new Float64Array(n));
    for (let i = 0; i < n; i++) y[i]! *= dsc[i]!;
    return y;
  };
  const op = (X: Float64Array[]): Float64Array[] => {
    if (o.signal?.aborted) throw new Error('run cancelled');
    return X.map(op1);
  };
  const t1 = performance.now();
  const ar = blockArnoldi(n, op, {
    nWant: o.nWant, blockSize: 1, maxBasis: o.maxBasis ?? Math.max(30, 2 * o.nWant + 12), tol: o.tol ?? 1e-10,
    X0: null, maxRestarts: o.maxRestarts ?? 60, seed: o.seed ?? 20261107, realOnly: true,
  });
  const arnoldiMs = performance.now() - t1;
  const t2 = performance.now();
  const Kx = new Float64Array(n), Mx = new Float64Array(n);
  const pairs = ar.vecs.map((v, j) => {
    // Ritz value of the converged Arnoldi pair; the vector gets one inverse-iteration step (op x = mu x for the pair)
    const mu = ar.mu[j]!.re, lam = sigma + 1 / mu;
    const x = op1(v.re);
    let nm = 0; for (let i = 0; i < n; i++) nm += x[i]! * x[i]!;
    nm = Math.sqrt(nm);
    for (let i = 0; i < n; i++) x[i]! /= nm;
    csrMv(pat, K, x, Kx); csrMv(pat, M, x, Mx);
    let rr = 0, kk = 0, mm = 0; for (let i = 0; i < n; i++) { rr += (Kx[i]! - lam * Mx[i]!) ** 2; kk += Kx[i]! ** 2; mm += Mx[i]! ** 2; }
    return { lam, x, res: Math.sqrt(rr) / (Math.sqrt(kk) + Math.abs(lam) * Math.sqrt(mm) || 1) };
  }).sort((p, q) => p.lam - q.lam);
  const refineMs = performance.now() - t2;
  return {
    lambda: Float64Array.from(pairs, (p) => p.lam), vecs: pairs.map((p) => Float64Array.from(p.x, (v, i) => v * Dm[i]!)), residual: Float64Array.from(pairs, (p) => p.res),
    stats: { n, nnz: pat.nnz, nnzL: Number(f.sym.nnzL), nNegative: r.nNeg ?? null, nPerturbed: r.nPerturbed ?? 0, asymmetry, factorMs, arnoldiMs, refineMs, opApplications: opApps, restarts: ar.restarts, converged: ar.converged },
  };
}
