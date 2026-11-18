// SPDX-License-Identifier: GPL-3.0-or-later
// Structured cross-section meshes for the em-modes tests and gates: a horizontal slab window (core |y| < t/2, cladding
// to |y| = L, width W in x) with mesh lines on the interfaces and a smooth grading map in the cladding, so that
// refinement levels are nested (h ratio exactly 2 per level). Domains: dom:clad (0), dom:core (1); boundaries
// bnd:rect.bottom | right | top | left (from common/mesh rectTriMesh).

import type { Mesh } from '@amp/spec/types';
import { rectTriMesh } from '../common/mesh.ts';

export interface SlabMeshOptions {
  /** core thickness (m) */ t: number;
  /** half height of the window (m), > t / 2 */ L: number;
  /** window width (m) */ W: number;
  /** cells across the half core */ nCoreHalf: number;
  /** cells across one cladding */ nClad: number;
  /** cells across the width */ nx: number;
  /** grading exponent c of the cladding map (y - t/2) / (L - t/2) = (e^(c eta) - 1) / (e^c - 1); 0 = uniform */ c: number;
  order?: 1 | 2;
}

export function slabMesh(o: SlabMeshOptions): Mesh {
  const nyHalf = o.nCoreHalf + o.nClad;
  const ny = 2 * nyHalf;
  const a = o.nCoreHalf / nyHalf; // fraction of the half index range in the core
  const g = (eta: number) => (o.c === 0 ? eta : (Math.exp(o.c * eta) - 1) / (Math.exp(o.c) - 1));
  // s in [0, 1] over the full height; symmetric about s = 1/2
  const yOf = (s: number): number => {
    const u = Math.abs(2 * s - 1); // 0 at the centre, 1 at the outer wall
    const sign = s < 0.5 ? -1 : 1;
    const y = u <= a ? (u / a) * (o.t / 2) : o.t / 2 + (o.L - o.t / 2) * g((u - a) / (1 - a));
    return sign * y;
  };
  // rectTriMesh maps fy(s) into [0, 1] over [y0, y1] = [-L, L]
  const m = rectTriMesh({ x: [0, o.W], y: [-o.L, o.L], nx: o.nx, ny, order: o.order ?? 1, ys: (s) => (yOf(s) + o.L) / (2 * o.L) });
  const k = m.cells.type === 'tri6' ? 6 : 3;
  const nc = m.cells.conn.length / k;
  const dom = new Int32Array(nc);
  for (let c = 0; c < nc; c++) {
    let yc = 0;
    for (let q = 0; q < 3; q++) yc += m.nodes[2 * m.cells.conn[k * c + q]! + 1]!;
    dom[c] = Math.abs(yc / 3) < o.t / 2 ? 1 : 0;
  }
  return { ...m, cells: { ...m.cells, domain: dom }, entities: { ...m.entities, domains: [{ id: 'dom:clad' }, { id: 'dom:core' }] } };
}

/** Graded 1D node coordinates: segments [a, b] with n cells each, geometric grading toward one end (ratio r of the
 *  largest to the smallest cell; r = 1 uniform; toward 'a' = smallest cells at a). Shared endpoints appear once. */
export function gradedLine(segs: Array<{ a: number; b: number; n: number; r?: number; toward?: 'a' | 'b' | 'both' }>): number[] {
  const out: number[] = [];
  for (const [i, s] of segs.entries()) {
    const r = s.r ?? 1, n = s.n;
    const w: number[] = [];
    if (s.toward === 'both') {
      const h = Math.ceil(n / 2);
      for (let k = 0; k < n; k++) { const kk = k < h ? k : n - 1 - k; w.push(h > 1 ? r ** (kk / (h - 1)) : 1); }
    } else for (let k = 0; k < n; k++) w.push(n > 1 ? r ** (k / (n - 1)) : 1);
    if (s.toward === 'b') w.reverse();
    const tot = w.reduce((x, y) => x + y, 0);
    let acc = 0;
    if (i === 0) out.push(s.a);
    for (let k = 0; k < n; k++) { acc += w[k]!; out.push(k === n - 1 ? s.b : s.a + (s.b - s.a) * (acc / tot)); }
  }
  return out;
}

/** Tensor-product tri3 mesh on explicit node lines xs, ys (m) with named domains from the cell centroid. Boundaries as
 *  rectTriMesh: bnd:rect.bottom | right | top | left. */
export function tensorMesh(xs: number[], ys: number[], domains: string[], domainOf: (x: number, y: number) => number): Mesh {
  const at = (arr: number[]) => (s: number) => {
    const u = s * (arr.length - 1), i = Math.min(arr.length - 2, Math.floor(u + 1e-12));
    const t = u - i;
    return (arr[i]! + (arr[i + 1]! - arr[i]!) * t - arr[0]!) / (arr[arr.length - 1]! - arr[0]!);
  };
  const m = rectTriMesh({ x: [xs[0]!, xs[xs.length - 1]!], y: [ys[0]!, ys[ys.length - 1]!], nx: xs.length - 1, ny: ys.length - 1, order: 1, xs: at(xs), ys: at(ys) });
  const nc = m.cells.conn.length / 3;
  const dom = new Int32Array(nc);
  for (let c = 0; c < nc; c++) {
    let x = 0, y = 0;
    for (let q = 0; q < 3; q++) { x += m.nodes[2 * m.cells.conn[3 * c + q]!]!; y += m.nodes[2 * m.cells.conn[3 * c + q]! + 1]!; }
    dom[c] = domainOf(x / 3, y / 3);
  }
  return { ...m, cells: { ...m.cells, domain: dom }, entities: { ...m.entities, domains: domains.map((id) => ({ id })) } };
}
