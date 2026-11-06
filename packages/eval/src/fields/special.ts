// SPDX-License-Identifier: GPL-3.0-or-later
// Special functions for the exact-field evaluators (TS port of the closed forms in validation/a/, lane L7a):
// complex arithmetic, spherical Bessel j_n (complex argument, Miller downward recurrence) and y_n (real argument,
// upward recurrence), Legendre P_n, complete elliptic integrals K(m), E(m) (Carlson RF / RD), and the
// physical constants used by the Python generators (scipy.constants, CODATA 2022).

export interface C { re: number; im: number }
export const c = (re: number, im = 0): C => ({ re, im });
export const add = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });
export const sub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
export const mul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
export const scale = (a: C, s: number): C => ({ re: a.re * s, im: a.im * s });
export function div(a: C, b: C): C {
  // Smith's algorithm
  if (Math.abs(b.re) >= Math.abs(b.im)) {
    const r = b.im / b.re, d = b.re + b.im * r;
    return { re: (a.re + a.im * r) / d, im: (a.im - a.re * r) / d };
  }
  const r = b.re / b.im, d = b.re * r + b.im;
  return { re: (a.re * r + a.im) / d, im: (a.im * r - a.re) / d };
}
export const abs = (a: C): number => Math.hypot(a.re, a.im);
export const cexp = (a: C): C => { const e = Math.exp(a.re); return { re: e * Math.cos(a.im), im: e * Math.sin(a.im) }; };
export const csin = (z: C): C => ({ re: Math.sin(z.re) * Math.cosh(z.im), im: Math.cos(z.re) * Math.sinh(z.im) });
export const ccos = (z: C): C => ({ re: Math.cos(z.re) * Math.cosh(z.im), im: -Math.sin(z.re) * Math.sinh(z.im) });
/** i^n */
export const ipow = (n: number): C => [c(1), c(0, 1), c(-1), c(0, -1)][((n % 4) + 4) % 4]!;

/** Python round(): round half to even (used by the generators for nmax). */
export function pyRound(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Spherical Bessel j_0..j_nmax at complex z (z != 0): Miller downward recurrence, normalized by j_0 or j_1. */
export function sphJ(nmax: number, z: C): C[] {
  const n0 = Math.ceil(Math.max(nmax, abs(z))) + 60;
  const f: C[] = new Array(n0 + 2);
  f[n0 + 1] = c(0);
  f[n0] = c(1e-200);
  for (let n = n0; n >= 1; n--) {
    // j_{n-1} = (2n + 1)/z j_n - j_{n+1}
    f[n - 1] = sub(scale(div(f[n]!, z), 2 * n + 1), f[n + 1]!);
    if (abs(f[n - 1]!) > 1e250) for (let k = n - 1; k <= n0 + 1; k++) f[k] = scale(f[k]!, 1e-250);
  }
  const j0 = div(csin(z), z);
  const j1 = sub(div(csin(z), mul(z, z)), div(ccos(z), z));
  const s = abs(j0) >= abs(j1) ? div(j0, f[0]!) : div(j1, f[1]!);
  const out: C[] = [];
  for (let n = 0; n <= nmax; n++) out.push(mul(f[n]!, s));
  return out;
}

/** Spherical Bessel y_0..y_nmax at real x > 0 (upward recurrence, stable for y_n). */
export function sphY(nmax: number, x: number): number[] {
  const y = [-Math.cos(x) / x];
  if (nmax >= 1) y.push(-Math.cos(x) / (x * x) - Math.sin(x) / x);
  for (let n = 1; n < nmax; n++) y.push(((2 * n + 1) / x) * y[n]! - y[n - 1]!);
  return y;
}

/** Derivative from the order sequence (scipy convention): f'_0 = -f_1, f'_n = f_{n-1} - (n + 1)/z f_n. */
export function sphDeriv(f: C[], z: C, n: number, fn1?: C): C {
  if (n === 0) return scale(fn1 ?? f[1]!, -1);
  return sub(f[n - 1]!, scale(div(f[n]!, z), n + 1));
}

/** Legendre P_0..P_nmax at x. */
export function legendre(nmax: number, x: number): number[] {
  const p = [1, x];
  for (let n = 1; n < nmax; n++) p.push(((2 * n + 1) * x * p[n]! - n * p[n - 1]!) / (n + 1));
  return p.slice(0, nmax + 1);
}

/** Carlson RF(x, y, z) by duplication (Carlson 1995, Numer. Algorithms 10:13; series DLMF 19.36.1), r = 1e-16. */
export function carlsonRF(x: number, y: number, z: number): number {
  const A0 = (x + y + z) / 3;
  let A = A0, xn = x, yn = y, zn = z, f = 1;
  const Q = Math.pow(3e-16, -1 / 6) * Math.max(Math.abs(A0 - x), Math.abs(A0 - y), Math.abs(A0 - z));
  while (Q * f > Math.abs(A)) {
    const sx = Math.sqrt(xn), sy = Math.sqrt(yn), sz = Math.sqrt(zn);
    const lam = sx * sy + sx * sz + sy * sz;
    A = (A + lam) / 4; xn = (xn + lam) / 4; yn = (yn + lam) / 4; zn = (zn + lam) / 4; f /= 4;
  }
  const X = ((A0 - x) * f) / A, Y = ((A0 - y) * f) / A, Z = -X - Y;
  const E2 = X * Y - Z * Z, E3 = X * Y * Z;
  return (1 - E2 / 10 + E3 / 14 + (E2 * E2) / 24 - (3 * E2 * E3) / 44) / Math.sqrt(A);
}

/** Carlson RD(x, y, z) by duplication (Carlson 1995; series DLMF 19.36.2), r = 1e-16. */
export function carlsonRD(x: number, y: number, z: number): number {
  const A0 = (x + y + 3 * z) / 5;
  let A = A0, xn = x, yn = y, zn = z, f = 1, sum = 0;
  const Q = Math.pow(1e-16 / 4, -1 / 6) * Math.max(Math.abs(A0 - x), Math.abs(A0 - y), Math.abs(A0 - z));
  while (Q * f > Math.abs(A)) {
    const sx = Math.sqrt(xn), sy = Math.sqrt(yn), sz = Math.sqrt(zn);
    const lam = sx * sy + sx * sz + sy * sz;
    sum += f / (sz * (zn + lam));
    A = (A + lam) / 4; xn = (xn + lam) / 4; yn = (yn + lam) / 4; zn = (zn + lam) / 4; f /= 4;
  }
  const X = ((A0 - x) * f) / A, Y = ((A0 - y) * f) / A, Z = -(X + Y) / 3;
  const XY = X * Y, Z2 = Z * Z;
  const E2 = XY - 6 * Z2, E3 = (3 * XY - 8 * Z2) * Z, E4 = 3 * (XY - Z2) * Z2, E5 = XY * Z2 * Z;
  const ser = 1 - (3 * E2) / 14 + E3 / 6 + (9 * E2 * E2) / 88 - (3 * E4) / 22 - (9 * E2 * E3) / 52 + (3 * E5) / 26;
  return f * Math.pow(A, -1.5) * ser + 3 * sum;
}

/** Complete elliptic integrals, parameter m = k^2 in [0, 1): K = RF(0, 1 - m, 1), K - E = (m / 3) RD(0, 1 - m, 1)
 *  (DLMF 19.25.1), so K - E carries no cancellation; E = K - (K - E). */
export function ellipKE(m: number): { K: number; E: number; KmE: number } {
  if (m === 1) return { K: Infinity, E: 1, KmE: Infinity };
  const K = carlsonRF(0, 1 - m, 1);
  const KmE = m === 0 ? 0 : (m / 3) * carlsonRD(0, 1 - m, 1);
  return { K, E: K - KmE, KmE };
}

// scipy.constants values used by validation/a/common.py (CODATA 2022 as reported in the expected JSONs)
export const MU0 = 1.25663706127e-6;   // N A^-2
export const EPS0 = 8.8541878188e-12;  // F m^-1
export const K_B = 1.380649e-23;       // J K^-1 (exact, SI 2019)
export const N_A = 6.02214076e23;      // mol^-1 (exact, SI 2019)
export const Q_E = 1.602176634e-19;    // C (exact, SI 2019)
