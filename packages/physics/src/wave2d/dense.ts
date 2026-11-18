// SPDX-License-Identifier: GPL-3.0-or-later
// Small dense eigen solvers for the port cross-section problems of wave2d (DevLog-042 s.1.4):
//  - real symmetric A x = lambda B x with B SPD: Cholesky B = L L^T, C = L^-1 A L^-T, Householder tridiagonalisation and
//    implicit QL (the tred2 / tql2 algorithms of EISPACK as in the public-domain JAMA EigenvalueDecomposition), x = L^-T y;
//  - complex A x = lambda B x (lossy or PML-stretched ports): C = B^-1 A (@amp/core la/dense cluFactor / cluSolve), then
//    @amp/core cmatEig (Hessenberg + shifted QR).
// Row-major n x n Float64Arrays.

import { CMat, cluFactor, cluSolve, cmatEig } from '@amp/core/la/dense';

/** Symmetric eigen decomposition (in place on a copy): values ascending, vectors as columns of V (row-major n x n). */
export function symEig(A0: Float64Array, n: number): { d: Float64Array; V: Float64Array } {
  const V = Float64Array.from(A0);
  const d = new Float64Array(n), e = new Float64Array(n);
  const at = (i: number, j: number) => i * n + j;
  for (let j = 0; j < n; j++) d[j] = V[at(n - 1, j)]!;
  // tred2: Householder reduction to tridiagonal form
  for (let i = n - 1; i > 0; i--) {
    let scale = 0, h = 0;
    for (let k = 0; k < i; k++) scale += Math.abs(d[k]!);
    if (scale === 0) {
      e[i] = d[i - 1]!;
      for (let j = 0; j < i; j++) { d[j] = V[at(i - 1, j)]!; V[at(i, j)] = 0; V[at(j, i)] = 0; }
    } else {
      for (let k = 0; k < i; k++) { d[k]! /= scale; h += d[k]! * d[k]!; }
      let f = d[i - 1]!;
      let g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g;
      h -= f * g;
      d[i - 1] = f - g;
      for (let j = 0; j < i; j++) e[j] = 0;
      for (let j = 0; j < i; j++) {
        f = d[j]!;
        V[at(j, i)] = f;
        g = e[j]! + V[at(j, j)]! * f;
        for (let k = j + 1; k <= i - 1; k++) { g += V[at(k, j)]! * d[k]!; e[k]! += V[at(k, j)]! * f; }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j++) { e[j]! /= h; f += e[j]! * d[j]!; }
      const hh = f / (h + h);
      for (let j = 0; j < i; j++) e[j]! -= hh * d[j]!;
      for (let j = 0; j < i; j++) {
        f = d[j]!; g = e[j]!;
        for (let k = j; k <= i - 1; k++) V[at(k, j)]! -= f * e[k]! + g * d[k]!;
        d[j] = V[at(i - 1, j)]!;
        V[at(i, j)] = 0;
      }
    }
    d[i] = h;
  }
  for (let i = 0; i < n - 1; i++) {
    V[at(n - 1, i)] = V[at(i, i)]!;
    V[at(i, i)] = 1;
    const h = d[i + 1]!;
    if (h !== 0) {
      for (let k = 0; k <= i; k++) d[k] = V[at(k, i + 1)]! / h;
      for (let j = 0; j <= i; j++) {
        let g = 0;
        for (let k = 0; k <= i; k++) g += V[at(k, i + 1)]! * V[at(k, j)]!;
        for (let k = 0; k <= i; k++) V[at(k, j)]! -= g * d[k]!;
      }
    }
    for (let k = 0; k <= i; k++) V[at(k, i + 1)] = 0;
  }
  for (let j = 0; j < n; j++) { d[j] = V[at(n - 1, j)]!; V[at(n - 1, j)] = 0; }
  V[at(n - 1, n - 1)] = 1;
  e[0] = 0;
  // tql2: implicit QL on the tridiagonal matrix; the rotations act on columns of V, kept as rows of VT (contiguous)
  const VT = new Float64Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) VT[c * n + r] = V[r * n + c]!;
  for (let i = 1; i < n; i++) e[i - 1] = e[i]!;
  e[n - 1] = 0;
  let f = 0, tst1 = 0;
  const eps = 2 ** -52;
  for (let l = 0; l < n; l++) {
    tst1 = Math.max(tst1, Math.abs(d[l]!) + Math.abs(e[l]!));
    let m = l;
    while (m < n) { if (Math.abs(e[m]!) <= eps * tst1) break; m++; }
    if (m === n) m = n - 1;
    if (m > l) {
      let iter = 0;
      do {
        if (++iter > 200) throw new Error('symEig: QL iteration did not converge');
        let g = d[l]!;
        let p = (d[l + 1]! - g) / (2 * e[l]!);
        let r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l]! / (p + r);
        d[l + 1] = e[l]! * (p + r);
        const dl1 = d[l + 1]!;
        let h = g - d[l]!;
        for (let i = l + 2; i < n; i++) d[i]! -= h;
        f += h;
        p = d[m]!;
        let c = 1, c2 = c, c3 = c, s = 0, s2 = 0;
        const el1 = e[l + 1]!;
        for (let i = m - 1; i >= l; i--) {
          c3 = c2; c2 = c; s2 = s;
          g = c * e[i]!; h = c * p;
          r = Math.hypot(p, e[i]!);
          e[i + 1] = s * r;
          s = e[i]! / r; c = p / r;
          p = c * d[i]! - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]!);
          const o1 = (i + 1) * n, o0 = i * n;
          for (let k = 0; k < n; k++) {
            h = VT[o1 + k]!;
            VT[o1 + k] = s * VT[o0 + k]! + c * h;
            VT[o0 + k] = c * VT[o0 + k]! - s * h;
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]!) / dl1;
        e[l] = s * p;
        d[l] = c * p;
      } while (Math.abs(e[l]!) > eps * tst1);
    }
    d[l] = d[l]! + f;
    e[l] = 0;
  }
  // sort ascending
  const ord = Array.from({ length: n }, (_, i) => i).sort((a, b) => d[a]! - d[b]!);
  const d2 = Float64Array.from(ord, (i) => d[i]!);
  const V2 = new Float64Array(n * n);
  for (let k = 0; k < n; k++) { const o = ord[k]! * n; for (let r = 0; r < n; r++) V2[at(r, k)] = VT[o + r]!; }
  return { d: d2, V: V2 };
}

/** Generalised symmetric-definite A x = lambda B x: values ascending, B-orthonormal vectors as columns (n x n row-major). */
export function symGenEig(A: Float64Array, B: Float64Array, n: number): { d: Float64Array; X: Float64Array } {
  const L = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let s = B[j * n + j]!;
    for (let k = 0; k < j; k++) s -= L[j * n + k]! * L[j * n + k]!;
    if (!(s > 0)) throw new Error('symGenEig: B is not positive definite');
    const ljj = Math.sqrt(s);
    L[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let t = B[i * n + j]!;
      for (let k = 0; k < j; k++) t -= L[i * n + k]! * L[j * n + k]!;
      L[i * n + j] = t / ljj;
    }
  }
  // row-oriented triangular solves (contiguous rows): W = L^-1 A, C = L^-1 W^T (= L^-1 A L^-T, A symmetric)
  const fwd = (R: Float64Array): Float64Array => {
    const out = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      const oi = i * n;
      for (let c = 0; c < n; c++) out[oi + c] = R[oi + c]!;
      for (let k = 0; k < i; k++) { const l = L[oi + k]!; if (l === 0) continue; const ok = k * n; for (let c = 0; c < n; c++) out[oi + c]! -= l * out[ok + c]!; }
      const d = L[oi + i]!;
      for (let c = 0; c < n; c++) out[oi + c]! /= d;
    }
    return out;
  };
  const W = fwd(A);
  const Wt = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Wt[j * n + i] = W[i * n + j]!;
  const C = fwd(Wt);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) { const v = 0.5 * (C[i * n + j]! + C[j * n + i]!); C[i * n + j] = v; C[j * n + i] = v; }
  const { d, V } = symEig(C, n);
  // X = L^-T V (back substitution, row-oriented)
  const X = new Float64Array(n * n);
  for (let i = n - 1; i >= 0; i--) {
    const oi = i * n;
    for (let c = 0; c < n; c++) X[oi + c] = V[oi + c]!;
    for (let k = i + 1; k < n; k++) { const l = L[k * n + i]!; if (l === 0) continue; const ok = k * n; for (let c = 0; c < n; c++) X[oi + c]! -= l * X[ok + c]!; }
    const d = L[oi + i]!;
    for (let c = 0; c < n; c++) X[oi + c]! /= d;
  }
  return { d, X };
}

/**
 * Complex A x = lambda B x (A, B complex symmetric, B non-singular): eigenvalues and vectors of B^-1 A, vectors
 * normalised x^T B x = 1 (unconjugated) after a bilinear Gram-Schmidt within clusters of equal eigenvalues.
 */
export function cplxGenEig(Ar: Float64Array, Ai: Float64Array, Br: Float64Array, Bi: Float64Array, n: number): { lr: Float64Array; li: Float64Array; Xr: Float64Array; Xi: Float64Array } {
  const B = new CMat(n, n, Float64Array.from(Br), Float64Array.from(Bi));
  const A = new CMat(n, n, Float64Array.from(Ar), Float64Array.from(Ai));
  const C = cluSolve(cluFactor(B), A) as CMat;
  const eig = cmatEig(C);
  const lr = Float64Array.from(eig.values.re), li = Float64Array.from(eig.values.im);
  const Xr = Float64Array.from(eig.vectors.re as Float64Array), Xi = Float64Array.from(eig.vectors.im as Float64Array);
  // bilinear products x_k^T B x_l
  const bil = (k: number, l: number): [number, number] => {
    let sr = 0, si = 0;
    for (let i = 0; i < n; i++) {
      // (B x_l)_i
      let tr = 0, ti = 0;
      for (let j = 0; j < n; j++) {
        const br = Br[i * n + j]!, bi = Bi[i * n + j]!, xr = Xr[j * n + l]!, xi = Xi[j * n + l]!;
        tr += br * xr - bi * xi; ti += br * xi + bi * xr;
      }
      const ar = Xr[i * n + k]!, ai = Xi[i * n + k]!;
      sr += ar * tr - ai * ti; si += ar * ti + ai * tr;
    }
    return [sr, si];
  };
  let scale = 1e-300;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.hypot(lr[i]!, li[i]!));
  for (let k = 0; k < n; k++) {
    for (let l = 0; l < k; l++) {
      if (Math.hypot(lr[k]! - lr[l]!, li[k]! - li[l]!) > 1e-8 * scale) continue;
      const [pr, pi] = bil(l, k);   // x_l normalised: x_k -= (x_l^T B x_k) x_l
      for (let i = 0; i < n; i++) {
        const xr = Xr[i * n + l]!, xi = Xi[i * n + l]!;
        Xr[i * n + k]! -= pr * xr - pi * xi; Xi[i * n + k]! -= pr * xi + pi * xr;
      }
    }
    const [nr, ni] = bil(k, k);
    // 1 / sqrt(nr + j ni)
    const mod = Math.hypot(nr, ni);
    if (!(mod > 0)) throw new Error('cplxGenEig: a mode has zero bilinear norm (x^T B x = 0)');
    const sm = Math.sqrt(mod), ph = Math.atan2(ni, nr) / 2;
    const cr = Math.cos(-ph) / sm, ci = Math.sin(-ph) / sm;
    for (let i = 0; i < n; i++) {
      const xr = Xr[i * n + k]!, xi = Xi[i * n + k]!;
      Xr[i * n + k] = xr * cr - xi * ci; Xi[i * n + k] = xr * ci + xi * cr;
    }
  }
  return { lr, li, Xr, Xi };
}
