// SPDX-License-Identifier: GPL-3.0-or-later
// Sparse complex LU without pivoting for the reduced Floquet systems of wave2d (DevLog-050 s.1.2). The reduced matrix
// Q^T A P is structurally symmetric but neither symmetric nor Hermitian, so the complex LDL^T of @amp/core does not
// apply. Reverse Cuthill-McKee ordering (pseudo-peripheral start, George and Liu 1979), envelope (skyline) storage
// A = L U with L unit lower (rows) and U upper (columns, diagonal separate), Crout order. Small pivots are perturbed
// statically (counted) and the solve is followed by iterative refinement on the unfactored matrix. Unit cells are
// small (10^3..10^4 unknowns), so the envelope cost n * bandwidth^2 stays modest. Deterministic.

import type { Csr } from './kernel.ts';

/** Reverse Cuthill-McKee permutation (perm[new] = old) of a structurally symmetric pattern. */
export function rcm(p: Csr): Int32Array {
  const n = p.n;
  const deg = new Int32Array(n);
  for (let i = 0; i < n; i++) deg[i] = p.rowptr[i + 1]! - p.rowptr[i]!;
  const seen = new Uint8Array(n);
  const order: number[] = [];
  const levels = (s: number, mark: Uint8Array): { last: number[]; depth: number; nodes: number[] } => {
    const lv = new Int32Array(n).fill(-1);
    lv[s] = 0;
    const q = [s];
    let h = 0, depth = 0;
    while (h < q.length) {
      const i = q[h++]!;
      for (let k = p.rowptr[i]!; k < p.rowptr[i + 1]!; k++) {
        const j = p.colidx[k]!;
        if (lv[j] === -1 && !mark[j]) { lv[j] = lv[i]! + 1; depth = Math.max(depth, lv[j]!); q.push(j); }
      }
    }
    return { last: q.filter((i) => lv[i] === depth), depth, nodes: q };
  };
  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0]) continue;
    // component: start at its minimum-degree node, then pseudo-peripheral search
    const comp = levels(s0, seen).nodes;
    let s = comp.reduce((a, b) => (deg[b]! < deg[a]! || (deg[b] === deg[a] && b < a) ? b : a), comp[0]!);
    let L = levels(s, seen);
    for (let it = 0; it < 8; it++) {
      const cand = L.last.reduce((a, b) => (deg[b]! < deg[a]! || (deg[b] === deg[a] && b < a) ? b : a), L.last[0]!);
      const L2 = levels(cand, seen);
      if (L2.depth <= L.depth) break;
      s = cand; L = L2;
    }
    // Cuthill-McKee BFS, neighbours by increasing degree
    const q = [s];
    seen[s] = 1;
    let h = 0;
    while (h < q.length) {
      const i = q[h++]!;
      const nb: number[] = [];
      for (let k = p.rowptr[i]!; k < p.rowptr[i + 1]!; k++) { const j = p.colidx[k]!; if (!seen[j]) { seen[j] = 1; nb.push(j); } }
      nb.sort((a, b) => deg[a]! - deg[b]! || a - b);
      q.push(...nb);
    }
    order.push(...q);
  }
  return Int32Array.from(order.reverse());
}

/**
 * Factor-storage budget of the envelope LU: 1 GiB. A design limit of this solver (half of the 2 GB per-process memory
 * rule of the project), not a property of the method; it counts the L, U and D arrays only (32 B per envelope entry,
 * 16 B per unknown), not the reduced matrix or the right-hand sides.
 */
export const ENVELOPE_LU_MAX_BYTES = 2 ** 30;

export class EnvelopeLU {
  readonly n: number;
  readonly perm: Int32Array;
  readonly iperm: Int32Array;
  readonly first: Int32Array;
  readonly ptr: Int32Array;
  Lr!: Float64Array; Li!: Float64Array; Ur!: Float64Array; Ui!: Float64Array; Dr!: Float64Array; Di!: Float64Array;
  nPerturbed = 0;
  readonly envelope: number;
  readonly pat: Csr;

  constructor(pat: Csr, o: { maxBytes?: number } = {}) {
    this.pat = pat;
    const n = pat.n;
    this.n = n;
    this.perm = rcm(pat);
    this.iperm = new Int32Array(n);
    for (let i = 0; i < n; i++) this.iperm[this.perm[i]!] = i;
    this.first = new Int32Array(n);
    for (let ni = 0; ni < n; ni++) {
      const i = this.perm[ni]!;
      let f = ni;
      for (let k = pat.rowptr[i]!; k < pat.rowptr[i + 1]!; k++) f = Math.min(f, this.iperm[pat.colidx[k]!]!);
      this.first[ni] = f;
    }
    // size estimate before any factor allocation (summed in a double: an Int32 pointer would overflow first)
    let env = 0;
    for (let i = 0; i < n; i++) env += i - this.first[i]!;
    const bytes = 32 * env + 16 * n, limit = o.maxBytes ?? ENVELOPE_LU_MAX_BYTES;
    if (bytes > limit) {
      const mib = (b: number) => (b / 2 ** 20).toFixed(1);
      throw new Error(`periodic cell: the envelope LU of the reduced system (${n} unknowns, ${env} envelope entries) needs an estimated factor storage ${mib(bytes)} MiB, over the limit ${mib(limit)} MiB (a design limit of this solver that keeps one run inside 2 GB of memory). Use a coarser mesh or a smaller unit cell`);
    }
    this.ptr = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.ptr[i + 1] = this.ptr[i]! + (i - this.first[i]!);
    this.envelope = this.ptr[n]!;
  }

  /** Factor A (values on `pat`). */
  factor(Are: Float64Array, Aim: Float64Array): void {
    const { n, pat, first, ptr, perm, iperm } = this;
    const E = this.envelope;
    const Lr = new Float64Array(E), Li = new Float64Array(E), Ur = new Float64Array(E), Ui = new Float64Array(E);
    const Dr = new Float64Array(n), Di = new Float64Array(n);
    let amax = 0;
    for (let ni = 0; ni < n; ni++) {
      const i = perm[ni]!;
      for (let k = pat.rowptr[i]!; k < pat.rowptr[i + 1]!; k++) {
        const nj = iperm[pat.colidx[k]!]!;
        const ar = Are[k]!, ai = Aim[k]!;
        amax = Math.max(amax, Math.abs(ar), Math.abs(ai));
        if (nj === ni) { Dr[ni] = ar; Di[ni] = ai; }
        else if (nj < ni) { const s = ptr[ni]! + (nj - first[ni]!); Lr[s] = ar; Li[s] = ai; }   // A(ni, nj), row ni of L
        else { const s = ptr[nj]! + (ni - first[nj]!); Ur[s] = ar; Ui[s] = ai; }   // A(ni, nj), nj > ni: column nj of U
      }
    }
    const tiny = 1e-14 * amax;
    let nPert = 0;
    for (let i = 0; i < n; i++) {
      const fi = first[i]!, pi = ptr[i]!;
      for (let j = fi; j < i; j++) {
        const fj = first[j]!, pj = ptr[j]!;
        const k0 = Math.max(fi, fj);
        // L(i, j) = (A(i, j) - sum_k L(i, k) U(k, j)) / U(j, j);  U(j, i) = A(j, i) - sum_k L(j, k) U(k, i)
        let sr = 0, si = 0, tr = 0, ti = 0;
        for (let k = k0; k < j; k++) {
          const lir = Lr[pi + k - fi]!, lii = Li[pi + k - fi]!, ukjr = Ur[pj + k - fj]!, ukji = Ui[pj + k - fj]!;
          sr += lir * ukjr - lii * ukji; si += lir * ukji + lii * ukjr;
          const ljr = Lr[pj + k - fj]!, lji = Li[pj + k - fj]!, ukir = Ur[pi + k - fi]!, ukii = Ui[pi + k - fi]!;
          tr += ljr * ukir - lji * ukii; ti += ljr * ukii + lji * ukir;
        }
        const ui = pi + j - fi;
        Ur[ui] = Ur[ui]! - tr; Ui[ui] = Ui[ui]! - ti;
        const ar = Lr[ui]! - sr, ai = Li[ui]! - si, dr = Dr[j]!, di = Di[j]!, dd = dr * dr + di * di;
        Lr[ui] = (ar * dr + ai * di) / dd; Li[ui] = (ai * dr - ar * di) / dd;
      }
      let sr = 0, si = 0;
      for (let k = fi; k < i; k++) {
        const lr = Lr[pi + k - fi]!, li = Li[pi + k - fi]!, ur = Ur[pi + k - fi]!, uim = Ui[pi + k - fi]!;
        sr += lr * ur - li * uim; si += lr * uim + li * ur;
      }
      Dr[i] = Dr[i]! - sr; Di[i] = Di[i]! - si;
      if (Math.hypot(Dr[i]!, Di[i]!) < tiny) { Dr[i] = tiny; Di[i] = 0; nPert++; }
    }
    Object.assign(this, { Lr, Li, Ur, Ui, Dr, Di });
    this.nPerturbed = nPert;
  }

  /** x = (LU)^-1 b in the original numbering. */
  solve(br: Float64Array, bi: Float64Array): { re: Float64Array; im: Float64Array } {
    const { n, first, ptr, perm, Lr, Li, Ur, Ui, Dr, Di } = this;
    const yr = new Float64Array(n), yi = new Float64Array(n);
    for (let i = 0; i < n; i++) { yr[i] = br[perm[i]!]!; yi[i] = bi[perm[i]!]!; }
    for (let i = 0; i < n; i++) {
      const fi = first[i]!, pi = ptr[i]!;
      let sr = 0, si = 0;
      for (let k = fi; k < i; k++) { const lr = Lr[pi + k - fi]!, li = Li[pi + k - fi]!; sr += lr * yr[k]! - li * yi[k]!; si += lr * yi[k]! + li * yr[k]!; }
      yr[i] = yr[i]! - sr; yi[i] = yi[i]! - si;
    }
    for (let i = n - 1; i >= 0; i--) {
      const dr = Dr[i]!, di = Di[i]!, dd = dr * dr + di * di;
      const xr = (yr[i]! * dr + yi[i]! * di) / dd, xi = (yi[i]! * dr - yr[i]! * di) / dd;
      yr[i] = xr; yi[i] = xi;
      const fi = first[i]!, pi = ptr[i]!;
      for (let k = fi; k < i; k++) { const ur = Ur[pi + k - fi]!, uim = Ui[pi + k - fi]!; yr[k] = yr[k]! - (ur * xr - uim * xi); yi[k] = yi[k]! - (ur * xi + uim * xr); }
    }
    const xr = new Float64Array(n), xi = new Float64Array(n);
    for (let i = 0; i < n; i++) { xr[perm[i]!] = yr[i]!; xi[perm[i]!] = yi[i]!; }
    return { re: xr, im: xi };
  }

  /** Solve with iterative refinement against the unfactored matrix; relative residual ||b - A x|| / ||b||. */
  solveRefined(Are: Float64Array, Aim: Float64Array, br: Float64Array, bi: Float64Array, maxSteps = 3, tol = 1e-13): { re: Float64Array; im: Float64Array; relResidual: number; steps: number } {
    const { n, pat } = this;
    const x = this.solve(br, bi);
    let bn = 0;
    for (let i = 0; i < n; i++) bn += br[i]! ** 2 + bi[i]! ** 2;
    bn = Math.sqrt(bn) || 1;
    const rr = new Float64Array(n), ri = new Float64Array(n);
    let rel = Infinity, steps = 0;
    for (;;) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        let ar = br[i]!, ai = bi[i]!;
        for (let k = pat.rowptr[i]!; k < pat.rowptr[i + 1]!; k++) {
          const j = pat.colidx[k]!, vr = Are[k]!, vi = Aim[k]!;
          ar -= vr * x.re[j]! - vi * x.im[j]!; ai -= vr * x.im[j]! + vi * x.re[j]!;
        }
        rr[i] = ar; ri[i] = ai; s += ar * ar + ai * ai;
      }
      rel = Math.sqrt(s) / bn;
      if (rel <= tol || steps >= maxSteps) break;
      const d = this.solve(rr, ri);
      for (let i = 0; i < n; i++) { x.re[i]! += d.re[i]!; x.im[i]! += d.im[i]!; }
      steps++;
    }
    return { ...x, relResidual: rel, steps };
  }
}
