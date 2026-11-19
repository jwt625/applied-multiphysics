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
  /** AMD symbolic analysis of `pat` computed by the caller (reused by the direct factor) */
  sym?: ReturnType<typeof analyze>;
  /**
   * Iterative path (DevLog-054): called once with the values of K - sigma M on `pat`; returns the block solve used in
   * place of a direct factor (each column solved to the solver's own tolerance). `factor` is then ignored.
   */
  linearSolver?: (A: Float64Array) => { solveMany: (b: Float64Array, m: number) => Float64Array; label: string };
  /**
   * Completeness check (DevLog-060; window form DevLog-066): Sylvester inertia of K - theta M (LDL^T, same symbolic
   * analysis) at theta = sigma +- (1 - eps) D, D the largest distance of a computed eigenvalue from sigma: the count on
   * each side of the shift must equal the eigenvalues found there (plus `nullDim` when a projector removes a null space
   * and the interval contains 0), i.e. the computed ones are the nearest to sigma. A miss retries the Krylov search with a larger subspace and another seed (the factor is
   * kept), up to EIGEN_CHECK_RETRIES times. 'auto' (default): check when the stored L of K - sigma M has at most
   * EIGEN_CHECK_MAX_NNZL entries (an extra factor of that size per check), else skip; 'inertia': always; 'off': never.
   * Skipped for the iterative path and for a projector without `nullDim`. When the first search passes, the result is
   * the unchanged first result (bitwise) plus stats.check.
   */
  check?: 'auto' | 'inertia' | 'off';
  /** dimension of the null space removed by `project` (eigenvalue 0, counted by the inertia when theta > 0) */
  nullDim?: number;
}

/** Result of the completeness check (stats.check). */
export interface EigenCheck {
  status: 'pass' | 'retried' | 'missed' | 'skipped';
  /** why the check was skipped, or what was missed */
  reason?: string;
  /** checked intervals (theta_lo, theta_hi] with the inertia counts and the number of computed eigenvalues inside */
  intervals: Array<{ lo: number; hi: number; count: number; found: number }>;
  /** Krylov searches run (1 = no retry) */
  attempts: number;
  checkMs: number;
}

let defaultCheck: 'auto' | 'inertia' | 'off' = 'auto';
/** Completeness check used when EigenInput.check is not given (default 'auto'); returns the previous value. */
export function setEigenCheckDefault(mode: 'auto' | 'inertia' | 'off'): 'auto' | 'inertia' | 'off' { const p = defaultCheck; defaultCheck = mode; return p; }

let checkListener: ((c: EigenCheck) => void) | null = null;
/** Diagnostics: called with stats.check of every shiftInvertEigen result (null: none); returns the previous listener. */
export function setEigenCheckListener(fn: ((c: EigenCheck) => void) | null): ((c: EigenCheck) => void) | null { const p = checkListener; checkListener = fn; return p; }

/** Solution note for a check that retried or missed (null when it passed or was skipped). */
export function eigenCheckNote(c: EigenCheck | undefined): string | null {
  if (!c || (c.status !== 'retried' && c.status !== 'missed')) return null;
  return c.status === 'retried'
    ? `eigen: the completeness check (Sylvester inertia) found a missed eigenvalue; the search was repeated with a larger subspace (${c.attempts} searches) and then passed`
    : `eigen: the completeness check (Sylvester inertia) still finds missed eigenvalues after ${c.attempts} searches (${c.reason ?? ''}); some modes may be missing`;
}

/** 'auto' completeness check limit on the stored L entries of K - sigma M (8 bytes each: 64 MiB). */
export const EIGEN_CHECK_MAX_NNZL = 8e6;
/** Window check margins (DevLog-066): the window ends at (1 - WINDOW_EPS) D, and at least WINDOW_ABS max |lambda| inside D,
 *  so round-off in the outermost computed eigenvalue cannot put it inside its own window. */
export const WINDOW_EPS = 1e-6;
export const WINDOW_ABS = 1e-9;
/** Retries of the Krylov search after a missed eigenvalue. */
export const EIGEN_CHECK_RETRIES = 3;

export interface EigenResult {
  lambda: Float64Array;
  vecs: Float64Array[];
  /** relative residual ||K x - lambda M x|| / (||K x|| + |lambda| ||M x||) per pair */
  residual: Float64Array;
  stats: {
    n: number; nnz: number; factor: 'cholesky' | 'ldlt' | 'iterative'; nnzL: number; nNegative: number | null; nPerturbed: number;
    factorMs: number; arnoldiMs: number; refineMs: number; opApplications: number; restarts: number; converged: boolean;
    check?: EigenCheck;
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
  const r = shiftInvertEigenChecked(o);
  if (checkListener && r.stats.check) checkListener(r.stats.check);
  return r;
}

function shiftInvertEigenChecked(o: EigenInput): EigenResult {
  const { pat, K, M, sigma } = o;
  const n = pat.n;
  const A = new Float64Array(pat.nnz);
  for (let q = 0; q < pat.nnz; q++) A[q] = K[q]! - sigma * M[q]!;
  const kind: 'cholesky' | 'ldlt' | 'iterative' = o.linearSolver ? 'iterative' : o.factor === 'cholesky' || (o.factor !== 'ldlt' && sigma < 0 && o.kPsd) ? 'cholesky' : 'ldlt';
  const t0 = performance.now();
  let solveMany: (b: Float64Array, m: number) => Float64Array;
  let nnzL = 0, nNegative: number | null = null, nPerturbed = 0;
  if (kind === 'iterative') {
    solveMany = o.linearSolver!(A).solveMany;
  } else if (kind === 'cholesky') {
    const ch = o.sym ? new SparseCholesky(pat, null, { sym: o.sym }) : new SparseCholesky(pat);
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
    const sym = o.sym ?? analyze(pat);
    const f = new SupernodalLDLT(sym);
    const r = f.factor(A);
    if (!r.ok) throw new Error('eigen: LDL^T of K - sigma M failed (sigma on an eigenvalue?)');
    nnzL = Number(sym.nnzL); nNegative = r.nNeg ?? null; nPerturbed = r.nPerturbed ?? 0;
    solveMany = (b, m) => (m === 1 ? f.solve(b, new Float64Array(n)) : f.solveMany(b, m, new Float64Array(n * m))) as Float64Array;
  }
  const factorMs = performance.now() - t0;
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
  const search = (nWant: number, maxBasis: number, seed: number): EigenResult => {
  const X0: Float64Array[] = [];
  if (o.project) {
    // projected random start block (Arnoldi's own random start would carry null-space components)
    let s = seed >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
    for (let c = 0; c < b; c++) { const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = rnd(); o.project(v); X0.push(v); }
  }
  const t1 = performance.now();
  const ar = blockArnoldi(n, op, {
    nWant, blockSize: b, maxBasis, tol: o.tol ?? 1e-10,
    X0: X0.length ? X0 : null, maxRestarts: o.maxRestarts ?? 60, seed, realOnly: true,
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
  };
  const seed0 = o.seed ?? 20261106;
  const first = search(o.nWant, o.maxBasis ?? Math.max(30, 2 * o.nWant + 12), seed0);
  const mode = o.check ?? defaultCheck;
  const skip = (reason: string): EigenResult => { first.stats.check = { status: 'skipped', reason, intervals: [], attempts: 1, checkMs: 0 }; return first; };
  if (mode === 'off') return skip('check off');
  if (kind === 'iterative') return skip('iterative linear solver (no factor for the inertia)');
  if (o.project && o.nullDim === undefined) return skip('projector without a null-space dimension');
  if (mode === 'auto' && nnzL > EIGEN_CHECK_MAX_NNZL) return skip(`factor ${nnzL} stored entries > ${EIGEN_CHECK_MAX_NNZL} (auto)`);
  const tc = performance.now();
  // inertia (number of eigenvalues below theta) by LDL^T of K - theta M; null when pivots were perturbed
  let symC: ReturnType<typeof analyze> | null = o.sym ?? null;
  const counts = new Map<number, number | null>();
  counts.set(sigma, nNegative === null || nPerturbed > 0 ? null : nNegative);
  const inertia = (theta: number): number | null => {
    if (counts.has(theta)) return counts.get(theta)!;
    if (!symC) symC = analyze(pat);
    const B = new Float64Array(pat.nnz);
    for (let q = 0; q < pat.nnz; q++) B[q] = K[q]! - theta * M[q]!;
    const f = new SupernodalLDLT(symC);
    const r = f.factor(B);
    const c = r.ok && !r.nPerturbed && r.nNeg !== undefined && r.nNeg !== null ? Number(r.nNeg) : null;
    counts.set(theta, c);
    return c;
  };
  const nullDim = o.project ? o.nullDim ?? 0 : 0;
  /**
   * Window check (DevLog-066): D = the largest |lambda - sigma| over the computed eigenvalues. Every eigenvalue strictly
   * nearer to sigma than D must be among the computed ones, so the inertia counts in (sigma, sigma + (1 - eps) D) and
   * (sigma - (1 - eps) D, sigma) must equal the computed eigenvalues there (plus nullDim when the interval contains 0,
   * the eigenvalue of the projected null space). A hidden k-th nearest eigenvalue (k <= nWant) is caught on either side
   * of the shift, up to the outermost computed one; eigenvalues at the outermost distance itself (degenerate partners
   * that were not requested) lie outside the window and are not counted. The lower side is skipped when the inertia at
   * sigma is 0 (nothing lies below).
   */
  const verify = (e: EigenResult): { ok: boolean; intervals: EigenCheck['intervals']; reason?: string } => {
    const L = Array.from(e.lambda);
    const intervals: EigenCheck['intervals'] = [];
    const cs = inertia(sigma);
    if (cs === null) return { ok: true, intervals, reason: 'inertia at the shift not available (perturbed pivots)' };
    if (!L.length) return { ok: true, intervals, reason: 'no computed eigenvalues' };
    let D = 0, lmax = 0;
    for (const l of L) { D = Math.max(D, Math.abs(l - sigma)); lmax = Math.max(lmax, Math.abs(l)); }
    const w = D - Math.max(WINDOW_EPS * D, WINDOW_ABS * lmax);
    if (!(w > 0)) return { ok: true, intervals, reason: 'computed eigenvalues at the shift only (no window)' };
    const hi = sigma + w, lo = sigma - w;
    let ok = true, reason: string | undefined;
    const inside = (a: number, b: number) => L.filter((l) => l > a && l < b).length;
    // above the shift: (sigma, hi)
    const ch = inertia(hi);
    if (ch !== null) {
      const found = inside(sigma, hi), expect = found + (sigma <= 0 && hi > 0 ? nullDim : 0);
      intervals.push({ lo: sigma, hi, count: ch - cs, found });
      if (ch - cs !== expect) { ok = false; reason = `${ch - cs} eigenvalues in (${sigma.toPrecision(6)}, ${hi.toPrecision(6)}), ${found} found`; }
    }
    // below the shift: (lo, sigma)
    if (cs > 0) {
      const cl = inertia(lo);
      if (cl !== null) {
        const found = inside(lo, sigma), expect = found + (lo <= 0 && sigma > 0 ? nullDim : 0);
        intervals.push({ lo, hi: sigma, count: cs - cl, found });
        if (cs - cl !== expect) { ok = false; reason = `${reason ? `${reason}; ` : ''}${cs - cl} eigenvalues in (${lo.toPrecision(6)}, ${sigma.toPrecision(6)}), ${found} found`; }
      }
    }
    return { ok, intervals, ...(reason ? { reason } : {}) };
  };
  let v = verify(first);
  if (v.ok) { first.stats.check = { status: v.intervals.length ? 'pass' : 'skipped', ...(v.intervals.length ? {} : { reason: v.reason ?? 'no interval checked' }), intervals: v.intervals, attempts: 1, checkMs: performance.now() - tc }; return first; }
  // retries: larger search, the requested number closest to sigma kept
  let best = first, attempts = 1, lastReason = v.reason;
  for (let a = 1; a <= EIGEN_CHECK_RETRIES; a++) {
    const nW = Math.min(o.nWant + 4 * a, n);
    const e = search(nW, Math.max(o.maxBasis ?? 0, 30, 3 * nW + 2 * b), seed0 + a);
    attempts++;
    const idx = Array.from(e.lambda, (_, i) => i).sort((i, j) => Math.abs(e.lambda[i]! - sigma) - Math.abs(e.lambda[j]! - sigma)).slice(0, o.nWant).sort((i, j) => e.lambda[i]! - e.lambda[j]!);
    const sub: EigenResult = { lambda: Float64Array.from(idx, (i) => e.lambda[i]!), vecs: idx.map((i) => e.vecs[i]!), residual: Float64Array.from(idx, (i) => e.residual[i]!), stats: { ...e.stats } };
    // check the kept subset (the window check concerns the nearest nWant)
    v = verify(sub);
    best = sub;
    if (v.ok) { lastReason = undefined; break; }
    lastReason = v.reason;
  }
  best.stats.check = { status: lastReason ? 'missed' : 'retried', ...(lastReason ? { reason: lastReason } : {}), intervals: v.intervals, attempts, checkMs: performance.now() - tc };
  return best;
}

// small helper shared by the eigen modules
export { mv as csrMatVec, dot as dotVec };
