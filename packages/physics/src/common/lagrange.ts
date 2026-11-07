// SPDX-License-Identifier: GPL-3.0-or-later
// Lagrange shape functions on reference cells (node orders as in common/mesh.ts, VTK) and isoparametric geometry:
// values N_a and reference derivatives dN_a/dxi at quadrature points, tabulated once per (cell type, rule).
// Reference cells: line [0, 1]; triangle (0,0) (1,0) (0,1); tet (0,0,0) (1,0,0) (0,1,0) (0,0,1); quad / hex [0, 1]^d.

import type { CellType } from '@amp/spec/types';
import { type Rule, cubeRule, lineRule, tetRule, triRule } from './quad.ts';
import { NPC } from './mesh.ts';

export const REF_DIM: Partial<Record<CellType, number>> = { line2: 1, line3: 1, tri3: 2, tri6: 2, quad4: 2, tet4: 3, tet10: 3, hex8: 3 };

/** Values (nn) and derivatives (nn x rd, row-major) of the shape functions of `type` at reference point p. */
export function shape(type: CellType, p: ArrayLike<number>, N: Float64Array, dN: Float64Array): void {
  switch (type) {
    case 'line2': { const s = p[0]!; N[0] = 1 - s; N[1] = s; dN[0] = -1; dN[1] = 1; return; }
    case 'line3': {
      const s = p[0]!;
      N[0] = (1 - s) * (1 - 2 * s); N[1] = s * (2 * s - 1); N[2] = 4 * s * (1 - s);
      dN[0] = 4 * s - 3; dN[1] = 4 * s - 1; dN[2] = 4 - 8 * s; return;
    }
    case 'tri3': {
      const x = p[0]!, y = p[1]!;
      N[0] = 1 - x - y; N[1] = x; N[2] = y;
      dN.set([-1, -1, 1, 0, 0, 1]); return;
    }
    case 'tri6': {
      const x = p[0]!, y = p[1]!, l0 = 1 - x - y;
      N[0] = l0 * (2 * l0 - 1); N[1] = x * (2 * x - 1); N[2] = y * (2 * y - 1);
      N[3] = 4 * l0 * x; N[4] = 4 * x * y; N[5] = 4 * y * l0;
      // d/dx, d/dy (dl0 = (-1, -1))
      dN[0] = 1 - 4 * l0; dN[1] = 1 - 4 * l0;
      dN[2] = 4 * x - 1; dN[3] = 0;
      dN[4] = 0; dN[5] = 4 * y - 1;
      dN[6] = 4 * (l0 - x); dN[7] = -4 * x;
      dN[8] = 4 * y; dN[9] = 4 * x;
      dN[10] = -4 * y; dN[11] = 4 * (l0 - y);
      return;
    }
    case 'quad4': {
      const x = p[0]!, y = p[1]!;
      N[0] = (1 - x) * (1 - y); N[1] = x * (1 - y); N[2] = x * y; N[3] = (1 - x) * y;
      dN.set([-(1 - y), -(1 - x), 1 - y, -x, y, x, -y, 1 - x]); return;
    }
    case 'tet4': {
      const x = p[0]!, y = p[1]!, z = p[2]!;
      N[0] = 1 - x - y - z; N[1] = x; N[2] = y; N[3] = z;
      dN.set([-1, -1, -1, 1, 0, 0, 0, 1, 0, 0, 0, 1]); return;
    }
    case 'tet10': {
      const L = [1 - p[0]! - p[1]! - p[2]!, p[0]!, p[1]!, p[2]!];
      // dL_i / dxi_d
      const G = [[-1, -1, -1], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (let i = 0; i < 4; i++) {
        N[i] = L[i]! * (2 * L[i]! - 1);
        for (let d = 0; d < 3; d++) dN[3 * i + d] = (4 * L[i]! - 1) * G[i]![d]!;
      }
      const E = [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]];
      E.forEach(([a, b], e) => {
        N[4 + e] = 4 * L[a!]! * L[b!]!;
        for (let d = 0; d < 3; d++) dN[3 * (4 + e) + d] = 4 * (G[a!]![d]! * L[b!]! + L[a!]! * G[b!]![d]!);
      });
      return;
    }
    case 'hex8': {
      const x = p[0]!, y = p[1]!, z = p[2]!;
      const C = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
      for (let a = 0; a < 8; a++) {
        const [i, j, k] = C[a] as [number, number, number];
        const fx = i ? x : 1 - x, fy = j ? y : 1 - y, fz = k ? z : 1 - z;
        const sx = i ? 1 : -1, sy = j ? 1 : -1, sz = k ? 1 : -1;
        N[a] = fx * fy * fz;
        dN[3 * a] = sx * fy * fz; dN[3 * a + 1] = fx * sy * fz; dN[3 * a + 2] = fx * fy * sz;
      }
      return;
    }
    default: throw new Error(`shape: cell type ${type} not supported`);
  }
}

export interface ShapeTable { type: CellType; nn: number; rd: number; rule: Rule; N: Float64Array; dN: Float64Array }

const tabCache = new Map<string, ShapeTable>();

/** Default rule for a cell type and polynomial degree of the integrand (exact for affine simplices). */
export function defaultRule(type: CellType, degree: number): Rule {
  const n = Math.max(1, Math.ceil((degree + 2) / 2));
  switch (REF_DIM[type]) {
    case 1: return lineRule(n);
    case 2: return type === 'quad4' ? cubeRule(2, n) : triRule(n);
    case 3: return type === 'hex8' ? cubeRule(3, n) : tetRule(Math.max(1, Math.ceil((degree + 3) / 2)));
    default: throw new Error(`no rule for ${type}`);
  }
}

export function shapeTable(type: CellType, rule: Rule): ShapeTable {
  const key = `${type}:${rule.dim}:${rule.n}:${rule.pts[0]}`;
  const hit = tabCache.get(key);
  if (hit) return hit;
  const nn = NPC[type], rd = REF_DIM[type]!;
  const N = new Float64Array(rule.n * nn), dN = new Float64Array(rule.n * nn * rd);
  const n1 = new Float64Array(nn), d1 = new Float64Array(nn * rd);
  for (let q = 0; q < rule.n; q++) {
    shape(type, rule.pts.subarray(rd * q, rd * q + rd), n1, d1);
    N.set(n1, q * nn); dN.set(d1, q * nn * rd);
  }
  const t = { type, nn, rd, rule, N, dN };
  tabCache.set(key, t);
  return t;
}

/**
 * Isoparametric map at quadrature point q of a cell with node coordinates X (nn x dim, row-major, dim = rd):
 * writes physical gradients G (nn x dim) and returns det J. Throws on det J <= 0 (inverted element).
 */
export function physGrad(t: ShapeTable, q: number, X: Float64Array, dim: number, G: Float64Array): number {
  const nn = t.nn, rd = t.rd;
  if (rd !== dim) throw new Error('physGrad: cell dimension must equal mesh dimension');
  const off = q * nn * rd;
  if (dim === 2) {
    let a = 0, b = 0, c = 0, d = 0;   // J = [[dx/dxi, dx/deta], [dy/dxi, dy/deta]]
    for (let i = 0; i < nn; i++) {
      const gx = t.dN[off + 2 * i]!, gy = t.dN[off + 2 * i + 1]!;
      a += X[2 * i]! * gx; b += X[2 * i]! * gy; c += X[2 * i + 1]! * gx; d += X[2 * i + 1]! * gy;
    }
    const det = a * d - b * c;
    if (!(det > 0)) throw new Error(`physGrad: non-positive Jacobian ${det}`);
    // grad N = J^-T dN/dxi
    for (let i = 0; i < nn; i++) {
      const gx = t.dN[off + 2 * i]!, gy = t.dN[off + 2 * i + 1]!;
      G[2 * i] = (d * gx - c * gy) / det;
      G[2 * i + 1] = (-b * gx + a * gy) / det;
    }
    return det;
  }
  if (dim === 3) {
    const J = [0, 0, 0, 0, 0, 0, 0, 0, 0];   // J[r][c] = dx_r / dxi_c
    for (let i = 0; i < nn; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) J[3 * r + c]! += X[3 * i + r]! * t.dN[off + 3 * i + c]!;
    const [a, b, c, d, e, f, g, h, k] = J as [number, number, number, number, number, number, number, number, number];
    const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!(det > 0)) throw new Error(`physGrad: non-positive Jacobian ${det}`);
    // inverse of J (row-major) ; grad N = J^-T dN
    const inv = [A / det, -(b * k - c * h) / det, (b * f - c * e) / det, B / det, (a * k - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
    for (let i = 0; i < nn; i++) {
      const g0 = t.dN[off + 3 * i]!, g1 = t.dN[off + 3 * i + 1]!, g2 = t.dN[off + 3 * i + 2]!;
      // (J^-T)_{rc} = inv_{cr}
      G[3 * i] = inv[0]! * g0 + inv[3]! * g1 + inv[6]! * g2;
      G[3 * i + 1] = inv[1]! * g0 + inv[4]! * g1 + inv[7]! * g2;
      G[3 * i + 2] = inv[2]! * g0 + inv[5]! * g1 + inv[8]! * g2;
    }
    return det;
  }
  throw new Error('physGrad: dim 2 or 3');
}

/** Physical point at quadrature point q (sum N_a X_a). */
export function physPoint(t: ShapeTable, q: number, X: Float64Array, dim: number, out: Float64Array): void {
  out.fill(0);
  for (let i = 0; i < t.nn; i++) { const w = t.N[q * t.nn + i]!; for (let d = 0; d < dim; d++) out[d]! += w * X[dim * i + d]!; }
}

/**
 * Facet measure element at quadrature point q of a facet (reference dim rd = dim - 1) with node coordinates X
 * (nn x dim): |dx/ds| (2D) or |dx/dxi x dx/deta| (3D); `normal` receives the unit normal (orientation as given by the
 * node order: 2D (dy, -dx); 3D t1 x t2).
 */
export function facetJac(t: ShapeTable, q: number, X: Float64Array, dim: number, normal?: Float64Array): number {
  const nn = t.nn, rd = t.rd, off = q * nn * rd;
  if (dim === 2) {
    let tx = 0, ty = 0;
    for (let i = 0; i < nn; i++) { tx += X[2 * i]! * t.dN[off + i]!; ty += X[2 * i + 1]! * t.dN[off + i]!; }
    const L = Math.hypot(tx, ty);
    if (normal) { normal[0] = ty / L; normal[1] = -tx / L; }
    return L;
  }
  const t1 = [0, 0, 0], t2 = [0, 0, 0];
  for (let i = 0; i < nn; i++) for (let r = 0; r < 3; r++) { t1[r]! += X[3 * i + r]! * t.dN[off + 2 * i]!; t2[r]! += X[3 * i + r]! * t.dN[off + 2 * i + 1]!; }
  const n0 = t1[1]! * t2[2]! - t1[2]! * t2[1]!, n1 = t1[2]! * t2[0]! - t1[0]! * t2[2]!, n2 = t1[0]! * t2[1]! - t1[1]! * t2[0]!;
  const L = Math.hypot(n0, n1, n2);
  if (normal) { normal[0] = n0 / L; normal[1] = n1 / L; normal[2] = n2 / L; }
  return L;
}

/** Gather node coordinates of element e (k nodes) into X. */
export function gatherX(nodes: Float64Array, dim: number, conn: Int32Array, e: number, k: number, X: Float64Array): void {
  for (let a = 0; a < k; a++) { const n = conn[k * e + a]!; for (let d = 0; d < dim; d++) X[dim * a + d] = nodes[dim * n + d]!; }
}
