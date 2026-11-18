// SPDX-License-Identifier: GPL-3.0-or-later
// Bloch / Floquet periodicity for wave2d (DevLog-050 s.1.2). Periodic conditions pair the nodes of opposite cell sides
// (@amp/mesh pairPeriodicNodes); a union-find with translation offsets maps every node i to a root node r(i) with
// x_i = x_r + T_i. A Bloch field u(x + a) = u(x) exp(-j k.a) (time convention exp(+j omega t)) then has u_i = p_i u_r,
// p_i = exp(-j k.T_i). The test functions of the unconjugated weak form carry 1 / p_i (so that the co-normal fluxes of
// the two sides cancel), hence the reduced operator R[r(i), r(j)] += q_i A_ij p_j with q_i = 1 / p_i, the reduced load
// b_r += q_i b_i, and the expansion u_i = p_i u_r. For real k, q = conj(p) and a Hermitian A stays Hermitian.

import type { Mesh } from '@amp/spec/types';
import { pairPeriodicNodes } from '@amp/mesh';
import type { Csr } from './kernel.ts';

export type V2 = [number, number];

export interface PeriodicCondition { id: string; facets: number[]; /** reduced Bloch component k.a / (2 pi) for eigen studies / sources */ k?: number }

/** Node classes of the periodic conditions and the lattice vectors (one per condition, in listed order). */
export class PeriodicMap {
  readonly nn: number;
  readonly root: Int32Array;
  /** translation from the root: x_i = x_root + T_i (2 per node) */
  readonly T: Float64Array;
  readonly lattice: V2[];
  readonly ids: string[];
  readonly kSetting: Array<number | undefined>;
  /** facets of all conditions (listed boundaries) */
  readonly facets: number[];

  constructor(mesh: Mesh, conds: PeriodicCondition[]) {
    const nn = mesh.nodes.length / 2;
    this.nn = nn;
    const parent = Int32Array.from({ length: nn }, (_, i) => i);
    const off = new Float64Array(2 * nn);
    this.lattice = []; this.ids = []; this.kSetting = []; this.facets = [];
    let span = 0;
    const find = (i: number): number => {
      // path compression with offset accumulation (iterative)
      const path: number[] = [];
      let r = i;
      while (parent[r] !== r) { path.push(r); r = parent[r]!; }
      for (let q = path.length - 1; q >= 0; q--) {
        const n = path[q]!, p = parent[n]!;
        if (p !== r) { off[2 * n]! += off[2 * p]!; off[2 * n + 1]! += off[2 * p + 1]!; }
        parent[n] = r;
      }
      return r;
    };
    for (const c of conds) {
      const what = `periodic condition '${c.id}'`;
      const pr = pairPeriodicNodes(mesh, c.facets, what);
      this.lattice.push([pr.d[0], pr.d[1]]); this.ids.push(c.id); this.kSetting.push(c.k); this.facets.push(...c.facets);
      span = Math.max(span, Math.hypot(pr.d[0], pr.d[1]));
      const tol = 1e-9 * span;
      for (let q = 0; q < pr.a.length; q++) {
        const a = pr.a[q]!, b = pr.b[q]!;
        const ra = find(a), rb = find(b);
        const Ta: V2 = ra === a ? [0, 0] : [off[2 * a]!, off[2 * a + 1]!], Tb: V2 = rb === b ? [0, 0] : [off[2 * b]!, off[2 * b + 1]!];
        if (ra === rb) {
          const ex = Tb[0] - Ta[0] - pr.d[0], ey = Tb[1] - Ta[1] - pr.d[1];
          if (Math.hypot(ex, ey) > tol) throw new Error(`${what}: the node at (${mesh.nodes[2 * b]}, ${mesh.nodes[2 * b + 1]}) m is reached by periodic translations that disagree; the periodic conditions do not describe one lattice`);
          continue;
        }
        // x_b = x_a + d: attach the larger root under the smaller one
        if (ra < rb) { parent[rb] = ra; off[2 * rb] = Ta[0] + pr.d[0] - Tb[0]; off[2 * rb + 1] = Ta[1] + pr.d[1] - Tb[1]; }
        else { parent[ra] = rb; off[2 * ra] = Tb[0] - pr.d[0] - Ta[0]; off[2 * ra + 1] = Tb[1] - pr.d[1] - Ta[1]; }
      }
    }
    this.root = new Int32Array(nn);
    this.T = new Float64Array(2 * nn);
    for (let i = 0; i < nn; i++) {
      const r = find(i);
      this.root[i] = r;
      if (r !== i) { this.T[2 * i] = off[2 * i]!; this.T[2 * i + 1] = off[2 * i + 1]!; }
    }
  }

  /** Reciprocal vectors b_i (a_i . b_j = 2 pi delta_ij) of the first one or two lattice vectors. */
  reciprocal(): V2[] {
    const a = this.lattice;
    if (a.length === 1) { const s = (2 * Math.PI) / (a[0]![0] ** 2 + a[0]![1] ** 2); return [[s * a[0]![0], s * a[0]![1]]]; }
    if (a.length !== 2) throw new Error(`Bloch wave vector in reduced coordinates needs one or two periodic conditions (lattice vectors), got ${a.length}`);
    const [a1, a2] = a as [V2, V2];
    const det = a1[0] * a2[1] - a1[1] * a2[0];
    if (Math.abs(det) <= 1e-12 * Math.hypot(...a1) * Math.hypot(...a2)) throw new Error('the two periodic conditions have parallel lattice vectors');
    const s = (2 * Math.PI) / det;
    return [[s * a2[1], -s * a2[0]], [-s * a1[1], s * a1[0]]];
  }

  /** Wave vector (1/m) from reduced coordinates on the reciprocal vectors. */
  kFromReduced(kr: readonly number[]): V2 {
    const b = this.reciprocal();
    if (kr.length > b.length) throw new Error(`k has ${kr.length} components but the cell has ${b.length} periodic direction${b.length === 1 ? '' : 's'}`);
    let kx = 0, ky = 0;
    kr.forEach((v, i) => { kx += v * b[i]![0]; ky += v * b[i]![1]; });
    return [kx, ky];
  }

  /** p_i = exp(-j k.T_i) for a complex wave vector k = kRe + j kIm (1/m). */
  phases(kRe: V2, kIm: V2 = [0, 0]): { re: Float64Array; im: Float64Array } {
    const re = new Float64Array(this.nn), im = new Float64Array(this.nn);
    for (let i = 0; i < this.nn; i++) {
      const tx = this.T[2 * i]!, ty = this.T[2 * i + 1]!;
      if (tx === 0 && ty === 0) { re[i] = 1; continue; }
      // -j (kr + j ki).T = ki.T - j kr.T
      const amp = Math.exp(kIm[0] * tx + kIm[1] * ty), ph = -(kRe[0] * tx + kRe[1] * ty);
      re[i] = amp * Math.cos(ph); im[i] = amp * Math.sin(ph);
    }
    return { re, im };
  }
}

/** Reduction of a full nodal system to the free node classes (DevLog-050 s.1.2). */
export class BlochReduction {
  readonly n: number;
  /** node -> reduced unknown (-1: excluded, i.e. Dirichlet or inactive) */
  readonly red: Int32Array;
  readonly pat: Csr;
  /** full CSR entry -> reduced slot (-1 when excluded) */
  readonly slot: Int32Array;

  constructor(mesh: Mesh, pm: PeriodicMap, full: Csr, excluded: Uint8Array) {
    const nn = pm.nn;
    // a class is either wholly excluded or wholly free
    const ex = new Int8Array(nn).fill(-1);   // per root: 1 excluded, 0 free
    const witness = new Int32Array(nn);
    for (let i = 0; i < nn; i++) {
      const r = pm.root[i]!, e = excluded[i] ? 1 : 0;
      if (ex[r] === -1) { ex[r] = e; witness[r] = i; continue; }
      if (ex[r] !== e) {
        const w = witness[r]!, d = excluded[i] ? i : w, f = excluded[i] ? w : i;
        throw new Error(`periodic condition: the node at (${mesh.nodes[2 * d]}, ${mesh.nodes[2 * d + 1]}) m is fixed (a Dirichlet wall or outside the physics) while its periodic partner at (${mesh.nodes[2 * f]}, ${mesh.nodes[2 * f + 1]}) m is free; give both sides the same wall conditions`);
      }
    }
    const red = new Int32Array(nn).fill(-1);
    let n = 0;
    for (let r = 0; r < nn; r++) if (pm.root[r] === r && ex[r] === 0) red[r] = n++;
    for (let i = 0; i < nn; i++) red[i] = red[pm.root[i]!]!;
    this.red = red; this.n = n;
    const rows: Array<Set<number>> = Array.from({ length: n }, (_, i) => new Set([i]));
    for (let i = 0; i < full.n; i++) {
      const ri = red[i]!;
      if (ri < 0) continue;
      for (let q = full.rowptr[i]!; q < full.rowptr[i + 1]!; q++) { const rj = red[full.colidx[q]!]!; if (rj >= 0) rows[ri]!.add(rj); }
    }
    const rowptr = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) rowptr[i + 1] = rowptr[i]! + rows[i]!.size;
    const colidx = new Int32Array(rowptr[n]!);
    for (let i = 0; i < n; i++) colidx.set(Int32Array.from(rows[i]!).sort(), rowptr[i]!);
    this.pat = { n, rowptr, colidx, nnz: colidx.length };
    const slot = new Int32Array(full.nnz).fill(-1);
    for (let i = 0; i < full.n; i++) {
      const ri = red[i]!;
      if (ri < 0) continue;
      for (let q = full.rowptr[i]!; q < full.rowptr[i + 1]!; q++) {
        const rj = red[full.colidx[q]!]!;
        if (rj < 0) continue;
        let lo = rowptr[ri]!, hi = rowptr[ri + 1]! - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (colidx[mid]! < rj) lo = mid + 1; else hi = mid; }
        slot[q] = lo;
      }
    }
    this.slot = slot;
  }

  /** R = Q^T A P with q = 1 / p (Aim may be null for a real A). */
  reduce(full: Csr, Are: Float64Array, Aim: Float64Array | null, p: { re: Float64Array; im: Float64Array }): { re: Float64Array; im: Float64Array } {
    const Rr = new Float64Array(this.pat.nnz), Ri = new Float64Array(this.pat.nnz);
    for (let i = 0; i < full.n; i++) {
      if (this.red[i]! < 0) continue;
      const pr = p.re[i]!, pi = p.im[i]!, d = pr * pr + pi * pi, qr = pr / d, qi = -pi / d;
      for (let k = full.rowptr[i]!; k < full.rowptr[i + 1]!; k++) {
        const s = this.slot[k]!;
        if (s < 0) continue;
        const j = full.colidx[k]!;
        const ar = Are[k]!, ai = Aim ? Aim[k]! : 0;
        if (ar === 0 && ai === 0) continue;
        const jr = p.re[j]!, ji = p.im[j]!;
        // q_i a p_j
        const tr = ar * jr - ai * ji, ti = ar * ji + ai * jr;
        Rr[s]! += qr * tr - qi * ti; Ri[s]! += qr * ti + qi * tr;
      }
    }
    return { re: Rr, im: Ri };
  }

  reduceVec(br: Float64Array, bi: Float64Array, p: { re: Float64Array; im: Float64Array }): { re: Float64Array; im: Float64Array } {
    const xr = new Float64Array(this.n), xi = new Float64Array(this.n);
    for (let i = 0; i < br.length; i++) {
      const r = this.red[i]!;
      if (r < 0 || (br[i] === 0 && bi[i] === 0)) continue;
      const pr = p.re[i]!, pi = p.im[i]!, d = pr * pr + pi * pi, qr = pr / d, qi = -pi / d;
      xr[r]! += qr * br[i]! - qi * bi[i]!; xi[r]! += qr * bi[i]! + qi * br[i]!;
    }
    return { re: xr, im: xi };
  }

  /** u_i = p_i u_r for free nodes (excluded nodes left as in `into`). */
  expand(ur: Float64Array, ui: Float64Array, p: { re: Float64Array; im: Float64Array }, intoRe: Float64Array, intoIm: Float64Array): void {
    for (let i = 0; i < intoRe.length; i++) {
      const r = this.red[i]!;
      if (r < 0) continue;
      const a = ur[r]!, b = ui[r]!, pr = p.re[i]!, pi = p.im[i]!;
      intoRe[i] = pr * a - pi * b; intoIm[i] = pr * b + pi * a;
    }
  }
}

/** k points of a band path: corners plus `interp` points between consecutive corners (MPB `interpolate`). */
export function bandPath(corners: Array<{ label: string; k: number[] }>, interp: number): { k: number[][]; label: Array<string | null> } {
  if (!corners.length) throw new Error('bands study: kPath is empty');
  const dim = Math.max(...corners.map((c) => c.k.length));
  const pad = (v: number[]) => Array.from({ length: dim }, (_, i) => v[i] ?? 0);
  const k: number[][] = [], label: Array<string | null> = [];
  for (let s = 0; s + 1 < corners.length; s++) {
    const p = pad(corners[s]!.k), q = pad(corners[s + 1]!.k);
    for (let i = 0; i <= interp; i++) {
      const t = i / (interp + 1);
      k.push(p.map((v, d) => v + t * (q[d]! - v)));
      label.push(i === 0 ? corners[s]!.label : null);
    }
  }
  k.push(pad(corners[corners.length - 1]!.k)); label.push(corners[corners.length - 1]!.label);
  return { k, label };
}
