// SPDX-License-Identifier: GPL-3.0-or-later
// Quadrature on reference cells: Gauss-Legendre on [0, 1], collapsed (Duffy) Gauss rules on the unit triangle
// {x, y >= 0, x + y <= 1} and unit tet, tensor rules on [0, 1]^d. Points are reference coordinates (xi, eta, zeta);
// weights sum to the reference measure (1, 1/2, 1/6, 1). A Duffy rule with n points per direction integrates
// polynomials of total degree <= 2n - 2 - (d - 1) exactly at least (here: degree 2n - 2 on the triangle, 2n - 3 on the
// tet are safe lower bounds; tests check the exact moments).

export interface Rule { dim: number; n: number; pts: Float64Array; wts: Float64Array }

const glCache = new Map<number, { x: Float64Array; w: Float64Array }>();

/** n-point Gauss-Legendre on [0, 1] (Newton on P_n, Golub-Welsch not needed for n <= 40). */
export function gaussLegendre01(n: number): { x: Float64Array; w: Float64Array } {
  const hit = glCache.get(n);
  if (hit) return hit;
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let dp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = z;
      for (let k = 2; k <= n; k++) { const p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k; p0 = p1; p1 = p2; }
      const pn = n === 0 ? 1 : n === 1 ? z : p1;
      const pnm1 = n === 1 ? 1 : p0;
      dp = (n * (z * pn - pnm1)) / (z * z - 1);
      const dz = pn / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-16) break;
    }
    x[n - 1 - i] = 0.5 * (1 + z);
    w[n - 1 - i] = 1 / ((1 - z * z) * dp * dp);
  }
  const r = { x, w };
  glCache.set(n, r);
  return r;
}

const ruleCache = new Map<string, Rule>();

export function lineRule(n: number): Rule {
  const { x, w } = gaussLegendre01(n);
  return { dim: 1, n, pts: Float64Array.from(x), wts: Float64Array.from(w) };
}

/** Collapsed Gauss rule on the unit triangle, n x n points. */
export function triRule(n: number): Rule {
  const key = `tri${n}`;
  const hit = ruleCache.get(key);
  if (hit) return hit;
  const { x, w } = gaussLegendre01(n);
  const pts = new Float64Array(2 * n * n), wts = new Float64Array(n * n);
  let q = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const u = x[i]!, v = x[j]!;
    pts[2 * q] = u; pts[2 * q + 1] = v * (1 - u);
    wts[q] = w[i]! * w[j]! * (1 - u);
    q++;
  }
  const r = { dim: 2, n: n * n, pts, wts };
  ruleCache.set(key, r);
  return r;
}

/** Collapsed Gauss rule on the unit tet, n^3 points. */
export function tetRule(n: number): Rule {
  const key = `tet${n}`;
  const hit = ruleCache.get(key);
  if (hit) return hit;
  const { x, w } = gaussLegendre01(n);
  const N = n * n * n;
  const pts = new Float64Array(3 * N), wts = new Float64Array(N);
  let q = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    const u = x[i]!, v = x[j]!, s = x[k]!;
    pts[3 * q] = u; pts[3 * q + 1] = v * (1 - u); pts[3 * q + 2] = s * (1 - u) * (1 - v);
    wts[q] = w[i]! * w[j]! * w[k]! * (1 - u) * (1 - u) * (1 - v);
    q++;
  }
  const r = { dim: 3, n: N, pts, wts };
  ruleCache.set(key, r);
  return r;
}

/** Tensor Gauss rule on [0, 1]^d. */
export function cubeRule(d: 2 | 3, n: number): Rule {
  const key = `cube${d}_${n}`;
  const hit = ruleCache.get(key);
  if (hit) return hit;
  const { x, w } = gaussLegendre01(n);
  const N = n ** d;
  const pts = new Float64Array(d * N), wts = new Float64Array(N);
  let q = 0;
  if (d === 2) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { pts[2 * q] = x[i]!; pts[2 * q + 1] = x[j]!; wts[q++] = w[i]! * w[j]!; }
  else for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    pts[3 * q] = x[i]!; pts[3 * q + 1] = x[j]!; pts[3 * q + 2] = x[k]!; wts[q++] = w[i]! * w[j]! * w[k]!;
  }
  const r = { dim: d, n: N, pts, wts };
  ruleCache.set(key, r);
  return r;
}

/**
 * Symmetric positive-weight rules on the unit tet (DevLog-060, degree-matched tet quadrature option): degree <= 1:
 * centroid (1 point); 2: the 4-point rule with barycentric orbit (b, a, a, a), a = (5 - sqrt 5) / 20 (Keast 1986,
 * Comput. Methods Appl. Mech. Eng. 55:339); 3..5: the 14-point degree-5 rule with two 4-point orbits and one 6-point
 * orbit (Walkington 2000, "Quadrature on simplices of arbitrary dimension", rule of degree 5; also Keast 1986). Weights
 * sum to 1/6. The exact moments of every monomial up to the stated degree are checked in the tests. Returns null for
 * degree > 5 (callers keep the collapsed rule).
 */
export function symTetRule(degree: number): Rule | null {
  const key = `symtet${degree <= 1 ? 1 : degree <= 2 ? 2 : degree <= 5 ? 5 : 0}`;
  if (degree > 5) return null;
  const hit = ruleCache.get(key);
  if (hit) return hit;
  const P: number[] = [], W: number[] = [];
  // orbit of barycentric (l0, l1, l2, l3) -> reference point (l1, l2, l3), distinct permutations only
  const orbit = (l: number[], w: number) => {
    const seen = new Set<string>();
    const perms = (a: number[]): number[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
    for (const p of perms(l)) {
      const k = p.join(',');
      if (seen.has(k)) continue;
      seen.add(k);
      P.push(p[1]!, p[2]!, p[3]!); W.push(w);
    }
  };
  if (degree <= 1) orbit([0.25, 0.25, 0.25, 0.25], 1 / 6);
  else if (degree <= 2) { const a = (5 - Math.sqrt(5)) / 20; orbit([1 - 3 * a, a, a, a], 1 / 24); }
  else {
    const a1 = 0.31088591926330061, w1 = 0.018781320953002642;
    const a2 = 0.092735250310891226, w2 = 0.012248840519393658;
    const b = 0.045503704125649649, w3 = 0.0070910034628469110;
    orbit([1 - 3 * a1, a1, a1, a1], w1);
    orbit([1 - 3 * a2, a2, a2, a2], w2);
    orbit([b, b, 0.5 - b, 0.5 - b], w3);
  }
  const r = { dim: 3, n: W.length, pts: Float64Array.from(P), wts: Float64Array.from(W) };
  ruleCache.set(key, r);
  return r;
}
