// SPDX-License-Identifier: GPL-3.0-or-later
// Smoothed-aggregation algebraic multigrid with a user near-nullspace, for real SPD systems with several unknowns per
// node, e.g. linear elasticity with the rigid-body modes (lane G3, DevLog-060). Method: Vanek, Mandel, Brezina,
// "Algebraic multigrid by smoothed aggregation for second and fourth order elliptic problems", Computing 56 (1996)
// 179-196: aggregation on the node graph (strength of connection between nodes I, J by the Frobenius norm of the
// matrix block A_IJ: ||A_IJ|| > theta sqrt(||A_II|| ||A_JJ||)), tentative prolongator from a QR of the near-nullspace
// rows of each aggregate (an aggregate whose rows have lower rank keeps fewer coarse unknowns; the R factors are the
// coarse near-nullspace), prolongator smoothing P = (I - omega D^-1 A) T with omega = 4 / (3 rho(D^-1 A)), Galerkin
// coarse operators P^T A P, symmetric Gauss-Seidel V-cycle (forward pre-, backward post-smoothing: a symmetric
// preconditioner for CG), dense Cholesky on the coarsest level. The scalar ./amg.mjs (constant vector only) is the
// special case of one unknown per node and B = 1; it is kept unchanged for the scalar solves.
// Unknowns of a node may be any subset of its components (Dirichlet-restricted systems): nodeOf maps each row to its
// node, and B holds the near-nullspace rows of the kept unknowns only.
// License: GPL-3.0-or-later.

const fail = (m) => {
  throw new Error(`amg-sa: ${m}`);
};

import { makeCsrKernels } from './wasm/csr.mjs';

/**
 * Coarsest-level pivot test (DevLog-066): a pivot at or below this fraction of its original diagonal entry marks the
 * coarse operator as singular. The Galerkin coarse operator keeps the near-nullspace exactly (P reproduces B), so a
 * system whose rigid-body motion is not suppressed has exactly singular coarse pivots, which round-off leaves near
 * 1e-16 of the diagonal; the threshold and the pivot ratios of constrained systems are in DevLog-066 s.4.
 */
export const SINGULAR_PIVOT_RATIO = 1e-10;

/** Diagonal slot per row of a square CSR matrix (-1 when absent). */
function diagSlotOf(A) {
  const d = new Int32Array(A.n).fill(-1);
  for (let i = 0; i < A.n; i++)
    for (let q = A.rowptr[i]; q < A.rowptr[i + 1]; q++)
      if (A.colidx[q] === i) {
        d[i] = q;
        break;
      }
  return d;
}

/** y = A x (CSR {n, rowptr, colidx, val}). */
function spmv(A, x, y) {
  const { rowptr, colidx, val } = A;
  for (let i = 0; i < A.n; i++) {
    let s = 0;
    for (let q = rowptr[i]; q < rowptr[i + 1]; q++) s += val[q] * x[colidx[q]];
    y[i] = s;
  }
}

/** C = A B for CSR matrices (A: n x k, B: k x m), two passes (count, fill) into typed arrays, rows sorted. */
export function csrMatMatTyped(A, B) {
  const m = B.m ?? B.n;
  const mark = new Int32Array(m).fill(-1);
  const rowptr = new Int32Array(A.n + 1);
  for (let i = 0; i < A.n; i++) {
    let c = 0;
    for (let p = A.rowptr[i]; p < A.rowptr[i + 1]; p++) {
      const k = A.colidx[p];
      for (let q = B.rowptr[k]; q < B.rowptr[k + 1]; q++) {
        const j = B.colidx[q];
        if (mark[j] !== i) { mark[j] = i; c++; }
      }
    }
    rowptr[i + 1] = rowptr[i] + c;
  }
  const nnz = rowptr[A.n];
  const colidx = new Int32Array(nnz), val = new Float64Array(nnz);
  const acc = new Float64Array(m);
  mark.fill(-1);
  for (let i = 0; i < A.n; i++) {
    let z = rowptr[i];
    const z0 = z;
    for (let p = A.rowptr[i]; p < A.rowptr[i + 1]; p++) {
      const k = A.colidx[p], a = A.val[p];
      for (let q = B.rowptr[k]; q < B.rowptr[k + 1]; q++) {
        const j = B.colidx[q];
        if (mark[j] !== i) { mark[j] = i; acc[j] = 0; colidx[z++] = j; }
        acc[j] += a * B.val[q];
      }
    }
    const row = colidx.subarray(z0, z);
    row.sort();
    for (let t = z0; t < z; t++) val[t] = acc[colidx[t]];
  }
  return { n: A.n, m, rowptr, colidx, val };
}

/** Transpose of a CSR matrix {n (rows), m (cols), rowptr, colidx, val}. */
export function csrTransposeTyped(A) {
  const m = A.m ?? A.n, nnz = A.rowptr[A.n];
  const cnt = new Int32Array(m + 1);
  for (let q = 0; q < nnz; q++) cnt[A.colidx[q] + 1]++;
  for (let i = 0; i < m; i++) cnt[i + 1] += cnt[i];
  const col = new Int32Array(nnz), val = new Float64Array(nnz);
  const fill = cnt.slice(0, m);
  for (let i = 0; i < A.n; i++)
    for (let q = A.rowptr[i]; q < A.rowptr[i + 1]; q++) {
      const j = A.colidx[q];
      col[fill[j]] = i;
      val[fill[j]++] = A.val[q];
    }
  return { n: m, m: A.n, rowptr: cnt, colidx: col, val };
}

/** Rows of each node: {start (nNodes + 1), rows} (CSR-style lists). */
function nodeRows(nodeOf, nNodes) {
  const start = new Int32Array(nNodes + 1);
  for (let i = 0; i < nodeOf.length; i++) start[nodeOf[i] + 1]++;
  for (let v = 0; v < nNodes; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nNodes), rows = new Int32Array(nodeOf.length);
  for (let i = 0; i < nodeOf.length; i++) rows[fill[nodeOf[i]]++] = i;
  return { start, rows };
}

/**
 * Strong node neighbours: CSR over nodes (no self entries) of the pairs with ||A_IJ||_F > theta sqrt(||A_II|| ||A_JJ||)
 * (theta = 0: every connected pair).
 */
function strongNodeGraph(A, nodeOf, nNodes, nr, theta) {
  const acc = new Float64Array(nNodes), mark = new Int32Array(nNodes).fill(-1);
  const diag = new Float64Array(nNodes);
  const lists = new Array(nNodes);
  const tmpJ = [];
  for (let I = 0; I < nNodes; I++) {
    tmpJ.length = 0;
    for (let t = nr.start[I]; t < nr.start[I + 1]; t++) {
      const i = nr.rows[t];
      for (let q = A.rowptr[i]; q < A.rowptr[i + 1]; q++) {
        const J = nodeOf[A.colidx[q]];
        if (mark[J] !== I) { mark[J] = I; acc[J] = 0; tmpJ.push(J); }
        acc[J] += A.val[q] * A.val[q];
      }
    }
    diag[I] = mark[I] === I ? Math.sqrt(acc[I]) : 0;
    const js = new Int32Array(tmpJ.length), vs = new Float64Array(tmpJ.length);
    for (let k = 0; k < tmpJ.length; k++) { js[k] = tmpJ[k]; vs[k] = Math.sqrt(acc[tmpJ[k]]); }
    lists[I] = { js, vs };
  }
  const rowptr = new Int32Array(nNodes + 1);
  const keep = (I, k) => {
    const J = lists[I].js[k];
    return J !== I && lists[I].vs[k] > theta * Math.sqrt(diag[I] * diag[J]);
  };
  for (let I = 0; I < nNodes; I++) {
    let c = 0;
    for (let k = 0; k < lists[I].js.length; k++) if (keep(I, k)) c++;
    rowptr[I + 1] = rowptr[I] + c;
  }
  const colidx = new Int32Array(rowptr[nNodes]), val = new Float64Array(rowptr[nNodes]);
  for (let I = 0; I < nNodes; I++) {
    let z = rowptr[I];
    for (let k = 0; k < lists[I].js.length; k++) if (keep(I, k)) { colidx[z] = lists[I].js[k]; val[z++] = lists[I].vs[k]; }
  }
  return { n: nNodes, rowptr, colidx, val };
}

/** Greedy three-phase aggregation of a node graph (as ./amg.mjs): {agg, nAgg}. */
function aggregateNodes(S) {
  const n = S.n, agg = new Int32Array(n).fill(-1);
  let nAgg = 0;
  for (let i = 0; i < n; i++) {
    if (agg[i] >= 0) continue;
    let ok = true;
    for (let q = S.rowptr[i]; q < S.rowptr[i + 1]; q++) if (agg[S.colidx[q]] >= 0) { ok = false; break; }
    if (!ok) continue;
    agg[i] = nAgg;
    for (let q = S.rowptr[i]; q < S.rowptr[i + 1]; q++) agg[S.colidx[q]] = nAgg;
    nAgg++;
  }
  const agg2 = agg.slice();
  for (let i = 0; i < n; i++) {
    if (agg[i] >= 0) continue;
    let best = -1, bv = -1;
    for (let q = S.rowptr[i]; q < S.rowptr[i + 1]; q++) if (agg[S.colidx[q]] >= 0 && S.val[q] > bv) { bv = S.val[q]; best = agg[S.colidx[q]]; }
    if (best >= 0) agg2[i] = best;
  }
  for (let i = 0; i < n; i++) {
    if (agg2[i] >= 0) continue;
    agg2[i] = nAgg;
    for (let q = S.rowptr[i]; q < S.rowptr[i + 1]; q++) if (agg2[S.colidx[q]] < 0) agg2[S.colidx[q]] = nAgg;
    nAgg++;
  }
  return { agg: agg2, nAgg };
}

/**
 * Tentative prolongator: per aggregate, modified Gram-Schmidt (two passes) on the columns of its near-nullspace rows;
 * a column whose remainder is below dropTol of its own norm adds no coarse unknown. Returns {T (CSR n x nc), nc,
 * nodeOfC (aggregate per coarse unknown), Bc (nc x nB)}.
 */
function tentative(nodeOf, B, nB, agg, nAgg, nr, dropTol) {
  const n = nodeOf.length;
  // rows of each aggregate
  const astart = new Int32Array(nAgg + 1);
  for (let I = 0; I < agg.length; I++) astart[agg[I] + 1] += nr.start[I + 1] - nr.start[I];
  for (let a = 0; a < nAgg; a++) astart[a + 1] += astart[a];
  const afill = astart.slice(0, nAgg), arows = new Int32Array(n);
  for (let I = 0; I < agg.length; I++) for (let t = nr.start[I]; t < nr.start[I + 1]; t++) arows[afill[agg[I]]++] = nr.rows[t];
  const tCols = new Int32Array(n * nB), tVals = new Float64Array(n * nB), tCnt = new Int32Array(n);
  const nodeOfC = [], Bc = [];
  let nc = 0;
  let Q = new Float64Array(0);
  for (let a = 0; a < nAgg; a++) {
    const r0 = astart[a], m = astart[a + 1] - r0;
    if (m === 0) continue;
    if (Q.length < m * nB) Q = new Float64Array(m * nB);
    const R = new Float64Array(nB * nB);
    const kept = [];
    for (let c = 0; c < nB; c++) {
      const v = new Float64Array(m);
      let n0 = 0;
      for (let t = 0; t < m; t++) { v[t] = B[arows[r0 + t] * nB + c]; n0 += v[t] * v[t]; }
      n0 = Math.sqrt(n0);
      const rc = new Float64Array(kept.length);
      for (let pass = 0; pass < 2; pass++)
        for (let k = 0; k < kept.length; k++) {
          const qk = kept[k];
          let s = 0;
          for (let t = 0; t < m; t++) s += Q[t * nB + qk] * v[t];
          for (let t = 0; t < m; t++) v[t] -= s * Q[t * nB + qk];
          rc[k] += s;
        }
      let nv = 0;
      for (let t = 0; t < m; t++) nv += v[t] * v[t];
      nv = Math.sqrt(nv);
      for (let k = 0; k < kept.length; k++) R[k * nB + c] = rc[k];
      if (n0 > 0 && nv > dropTol * n0 && kept.length < m) {
        const col = kept.length;
        for (let t = 0; t < m; t++) Q[t * nB + col] = v[t] / nv;
        R[col * nB + c] = nv;
        kept.push(col);
      }
    }
    const r = kept.length;
    for (let k = 0; k < r; k++) {
      nodeOfC.push(a);
      for (let c = 0; c < nB; c++) Bc.push(R[k * nB + c]);
    }
    for (let t = 0; t < m; t++) {
      const i = arows[r0 + t];
      for (let k = 0; k < r; k++) { tCols[i * nB + tCnt[i]] = nc + k; tVals[i * nB + tCnt[i]] = Q[t * nB + k]; tCnt[i]++; }
    }
    nc += r;
  }
  const rowptr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowptr[i + 1] = rowptr[i] + tCnt[i];
  const colidx = new Int32Array(rowptr[n]), val = new Float64Array(rowptr[n]);
  for (let i = 0; i < n; i++) for (let k = 0; k < tCnt[i]; k++) { colidx[rowptr[i] + k] = tCols[i * nB + k]; val[rowptr[i] + k] = tVals[i * nB + k]; }
  return { T: { n, m: nc, rowptr, colidx, val }, nc, nodeOfC: Int32Array.from(nodeOfC), Bc: Float64Array.from(Bc) };
}

/**
 * Dense Cholesky of a small SPD CSR matrix; returns solve(b, x) with `minPivotRatio` (smallest pivot / its original
 * diagonal entry, before any clamping; <= 0 when a pivot was not positive) and `nSmall` (pivots at or below
 * SINGULAR_PIVOT_RATIO times their diagonal entry). A non-positive pivot is clamped as before.
 */
function denseCholesky(A) {
  const n = A.n;
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let q = A.rowptr[i]; q < A.rowptr[i + 1]; q++) L[i * n + A.colidx[q]] = A.val[q];
  let minPivotRatio = Infinity, nSmall = 0;
  for (let j = 0; j < n; j++) {
    let s = L[j * n + j];
    const a0 = s;
    for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k];
    const ratio = s / a0;
    if (ratio < minPivotRatio) minPivotRatio = ratio;
    if (!(ratio > SINGULAR_PIVOT_RATIO)) nSmall++;
    if (!(s > 0)) s = Math.max(Math.abs(L[j * n + j]) * 1e-12, 1e-300);
    const r = Math.sqrt(s);
    L[j * n + j] = r;
    for (let i = j + 1; i < n; i++) {
      let t = L[i * n + j];
      for (let k = 0; k < j; k++) t -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = t / r;
    }
  }
  const solve = (b, x) => {
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k];
      x[i] = s / L[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
      x[i] = s / L[i * n + i];
    }
  };
  solve.minPivotRatio = minPivotRatio;
  solve.nSmall = nSmall;
  return solve;
}

/**
 * Rigid-body modes of a node-blocked system as the near-nullspace: rows `inv[i]` = node * dim + component of the
 * kept unknowns, coordinates `X` (dim per node). dim 3: 3 translations + rotations about x, y, z through the centroid
 * of the used nodes (nB 6); dim 2: 2 translations + the in-plane rotation (nB 3). Returns {nodeOf, B, nB}.
 */
export function rigidBodyModes(inv, X, dim) {
  const n = inv.length, nB = dim === 3 ? 6 : 3;
  const nodeOf = new Int32Array(n);
  const c = new Float64Array(dim);
  for (let i = 0; i < n; i++) nodeOf[i] = Math.floor(inv[i] / dim);
  for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) c[d] += X[dim * nodeOf[i] + d] / n;
  // node ids compressed to 0..nNodes-1 (the AMG needs contiguous node numbers)
  const map = new Map();
  for (let i = 0; i < n; i++) { const v = nodeOf[i]; if (!map.has(v)) map.set(v, map.size); }
  const B = new Float64Array(n * nB);
  for (let i = 0; i < n; i++) {
    const v = nodeOf[i], comp = inv[i] - dim * v;
    const x = X[dim * v] - c[0], y = X[dim * v + 1] - c[1], z = dim === 3 ? X[dim * v + 2] - c[2] : 0;
    B[i * nB + comp] = 1;
    if (dim === 2) B[i * nB + 2] = comp === 0 ? -y : x;
    else {
      // rotation about x: (0, -z, y); about y: (z, 0, -x); about z: (-y, x, 0)
      B[i * nB + 3] = comp === 0 ? 0 : comp === 1 ? -z : y;
      B[i * nB + 4] = comp === 0 ? z : comp === 1 ? 0 : -x;
      B[i * nB + 5] = comp === 0 ? -y : comp === 1 ? x : 0;
    }
    nodeOf[i] = map.get(v);
  }
  return { nodeOf, nNodes: map.size, B, nB };
}

/**
 * Build the hierarchy. A: real SPD CSR {n, rowptr, colidx, val}; nodeOf (Int32Array n, contiguous node ids 0..nNodes-1),
 * B (n x nB row-major near-nullspace). Options: theta (fine-level strength threshold; coarse levels keep every
 * connection, as ./amg.mjs), coarseMax (unknowns at which coarsening stops), sweeps (Gauss-Seidel sweeps per smoothing
 * step), dropTol (QR rank threshold), singular ('error', default: throw when the dense coarsest-level Cholesky has a
 * pivot <= SINGULAR_PIVOT_RATIO x its diagonal, i.e. the system is under-constrained; 'allow': clamp and continue, the
 * former behaviour). A coarsest level above 3000 unknowns (Gauss-Seidel, no factor) is not tested. Returns {levels,
 * cycle(b, x), coarse}: one V-cycle, x = M^-1 b (x overwritten); coarse = {n, minPivotRatio, nSmall} of the dense
 * coarsest level or null.
 */
export function buildAMGSA(A, { nodeOf, nNodes, B, nB, theta = 0.02, coarseMax = 800, maxLevels = 12, sweeps = 1, dropTol = 1e-8, singular = 'error' } = {}) {
  if (!nodeOf || !B || !nB) fail('nodeOf, B and nB are required');
  if (nodeOf.length !== A.n || B.length !== A.n * nB) fail('nodeOf / B sizes do not match the matrix');
  const levels = [];
  let cur = { n: A.n, m: A.n, rowptr: A.rowptr, colidx: A.colidx, val: A.val };
  let curNN = nNodes ?? 0;
  if (nNodes === undefined) for (let i = 0; i < nodeOf.length; i++) curNN = Math.max(curNN, nodeOf[i] + 1);
  let curNode = nodeOf, curB = B;
  for (let l = 0; l < maxLevels; l++) {
    const d = new Float64Array(cur.n);
    for (let i = 0; i < cur.n; i++)
      for (let q = cur.rowptr[i]; q < cur.rowptr[i + 1]; q++) if (cur.colidx[q] === i) { d[i] = cur.val[q]; break; }
    for (let i = 0; i < cur.n; i++) if (!(d[i] > 0)) fail(`non-positive diagonal at level ${l}, row ${i}`);
    const lev = { A: cur, d };
    levels.push(lev);
    if (cur.n <= coarseMax) break;
    const nr = nodeRows(curNode, curNN);
    const S = strongNodeGraph(cur, curNode, curNN, nr, l === 0 ? theta : 0);
    const { agg, nAgg } = aggregateNodes(S);
    if (nAgg >= curNN * 0.9 || nAgg === 0) break;
    const { T, nc, nodeOfC, Bc } = tentative(curNode, curB, nB, agg, nAgg, nr, dropTol);
    if (nc >= cur.n * 0.9) break;
    // rho(D^-1 A) by power iteration
    let v = Float64Array.from({ length: cur.n }, (_, i) => 1 + ((i * 7919) % 13) / 13);
    const w = new Float64Array(cur.n);
    let rho = 1;
    for (let it = 0; it < 15; it++) {
      spmv(cur, v, w);
      let nw = 0, nv = 0;
      for (let i = 0; i < cur.n; i++) { w[i] /= d[i]; nw += w[i] * w[i]; nv += v[i] * v[i]; }
      rho = Math.sqrt(nw / nv);
      const s = 1 / Math.sqrt(nw);
      for (let i = 0; i < cur.n; i++) v[i] = w[i] * s;
    }
    const omega = 4 / (3 * rho);
    // P = T - omega D^-1 A T (rows merged in column order)
    const AT = csrMatMatTyped(cur, T);
    const prow = new Int32Array(cur.n + 1);
    for (let i = 0; i < cur.n; i++) {
      // union size of AT row and T row (T columns are a subset of AT columns unless A_ii... count by merge)
      let a = AT.rowptr[i], b = T.rowptr[i], c = 0;
      while (a < AT.rowptr[i + 1] || b < T.rowptr[i + 1]) {
        const ca = a < AT.rowptr[i + 1] ? AT.colidx[a] : Infinity, cb = b < T.rowptr[i + 1] ? T.colidx[b] : Infinity;
        if (ca === cb) { a++; b++; } else if (ca < cb) a++; else b++;
        c++;
      }
      prow[i + 1] = prow[i] + c;
    }
    const pcol = new Int32Array(prow[cur.n]), pval = new Float64Array(prow[cur.n]);
    for (let i = 0; i < cur.n; i++) {
      let a = AT.rowptr[i], b = T.rowptr[i], z = prow[i];
      const f = omega / d[i];
      while (a < AT.rowptr[i + 1] || b < T.rowptr[i + 1]) {
        const ca = a < AT.rowptr[i + 1] ? AT.colidx[a] : Infinity, cb = b < T.rowptr[i + 1] ? T.colidx[b] : Infinity;
        if (ca === cb) { pcol[z] = ca; pval[z++] = T.val[b] - f * AT.val[a]; a++; b++; }
        else if (ca < cb) { pcol[z] = ca; pval[z++] = -f * AT.val[a]; a++; }
        else { pcol[z] = cb; pval[z++] = T.val[b]; b++; }
      }
    }
    const P = { n: cur.n, m: nc, rowptr: prow, colidx: pcol, val: pval };
    const PT = csrTransposeTyped(P);
    lev.P = P;
    lev.PT = PT;
    const Ac = csrMatMatTyped(PT, csrMatMatTyped(cur, P));
    cur = { n: nc, m: nc, rowptr: Ac.rowptr, colidx: Ac.colidx, val: Ac.val };
    curNode = nodeOfC; curNN = nAgg; curB = Bc;
  }
  const last = levels[levels.length - 1];
  if (last.A.n <= 3000) last.solve = denseCholesky(last.A);
  // singular coarse operator (DevLog-066): an under-constrained system (rigid-body motion not suppressed) would otherwise
  // be solved silently by CG on the consistent singular system; the direct path throws for it
  if (last.solve && last.solve.nSmall > 0 && singular !== 'allow')
    fail(`the matrix is singular: ${last.solve.nSmall} of ${last.A.n} coarsest-level pivots are <= ${SINGULAR_PIVOT_RATIO} x their diagonal (smallest ratio ${last.solve.minPivotRatio.toExponential(2)}); the system is under-constrained (rigid-body motion not suppressed?)`);
  for (const lev of levels) {
    lev.r = new Float64Array(lev.A.n);
    lev.x = new Float64Array(lev.A.n);
    lev.b = new Float64Array(lev.A.n);
    // WASM CSR kernels (bitwise identical to the loops below; DevLog-060), null on small levels or when unavailable
    lev.k = lev.solve ? null : makeCsrKernels(lev.A, lev.A.val, diagSlotOf(lev.A));
  }
  const gs = (lev, b, x, dir) => {
    if (lev.k) {
      for (let s = 0; s < sweeps; s++) lev.k.gs(b, x, dir);
      return;
    }
    const { A: M, d } = lev;
    const n = M.n, { rowptr, colidx, val } = M;
    for (let s = 0; s < sweeps; s++)
      for (let k = 0; k < n; k++) {
        const i = dir > 0 ? k : n - 1 - k;
        let t = b[i];
        for (let q = rowptr[i]; q < rowptr[i + 1]; q++) {
          const j = colidx[q];
          if (j !== i) t -= val[q] * x[j];
        }
        x[i] = t / d[i];
      }
  };
  const vcycle = (l, b, x) => {
    const lev = levels[l];
    if (l === levels.length - 1) {
      if (lev.solve) return lev.solve(b, x);
      x.fill(0);
      for (let s = 0; s < 4; s++) { gs(lev, b, x, 1); gs(lev, b, x, -1); }
      return;
    }
    x.fill(0);
    gs(lev, b, x, 1);
    if (lev.k) lev.k.spmv(x, lev.r);
    else spmv(lev.A, x, lev.r);
    for (let i = 0; i < lev.A.n; i++) lev.r[i] = b[i] - lev.r[i];
    const nxt = levels[l + 1];
    spmv(lev.PT, lev.r, nxt.b);
    vcycle(l + 1, nxt.b, nxt.x);
    const P = lev.P;
    for (let i = 0; i < P.n; i++) {
      let s = 0;
      for (let q = P.rowptr[i]; q < P.rowptr[i + 1]; q++) s += P.val[q] * nxt.x[P.colidx[q]];
      x[i] += s;
    }
    gs(lev, b, x, -1);
  };
  return {
    levels: levels.map((l) => ({ n: l.A.n, nnz: l.A.rowptr[l.A.n] })),
    cycle: (b, x) => vcycle(0, b, x),
    coarse: last.solve ? { n: last.A.n, minPivotRatio: last.solve.minPivotRatio, nSmall: last.solve.nSmall } : null,
  };
}

/**
 * Two-level multigrid with a given interpolation P (n x nc CSR, e.g. P2 -> P1 Lagrange interpolation: p-multigrid)
 * and a coarse preconditioner built on the Galerkin operator Ac = P^T A P by `coarse(Ac)` (e.g. buildAMGSA):
 * forward Gauss-Seidel on A, coarse correction P cycle_c(P^T r), backward Gauss-Seidel (symmetric when the coarse
 * cycle is symmetric). Returns {levels, cycle(b, x)} like buildAMGSA (levels: fine level, then the coarse hierarchy).
 */
export function buildTwoLevel(A, P, coarse, { sweeps = 1 } = {}) {
  const n = A.n;
  if (P.n !== n) fail('interpolation rows do not match the matrix');
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++)
    for (let q = A.rowptr[i]; q < A.rowptr[i + 1]; q++) if (A.colidx[q] === i) { d[i] = A.val[q]; break; }
  for (let i = 0; i < n; i++) if (!(d[i] > 0)) fail(`non-positive diagonal at row ${i}`);
  const PT = csrTransposeTyped(P);
  const Ac = csrMatMatTyped(PT, csrMatMatTyped({ ...A, m: n }, P));
  const C = coarse({ n: Ac.n, rowptr: Ac.rowptr, colidx: Ac.colidx, val: Ac.val });
  const r = new Float64Array(n), bc = new Float64Array(P.m), xc = new Float64Array(P.m);
  const { rowptr, colidx, val } = A;
  const K = makeCsrKernels(A, val, diagSlotOf(A));
  const gs = (b, x, dir) => {
    if (K) {
      for (let s = 0; s < sweeps; s++) K.gs(b, x, dir);
      return;
    }
    for (let s = 0; s < sweeps; s++)
      for (let k = 0; k < n; k++) {
        const i = dir > 0 ? k : n - 1 - k;
        let t = b[i];
        for (let q = rowptr[i]; q < rowptr[i + 1]; q++) {
          const j = colidx[q];
          if (j !== i) t -= val[q] * x[j];
        }
        x[i] = t / d[i];
      }
  };
  return {
    levels: [{ n, nnz: A.rowptr[n] }, ...C.levels],
    coarse: C.coarse ?? null,
    cycle: (b, x) => {
      x.fill(0);
      gs(b, x, 1);
      if (K) K.spmv(x, r);
      else spmv(A, x, r);
      for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
      spmv(PT, r, bc);
      xc.fill(0);
      C.cycle(bc, xc);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let q = P.rowptr[i]; q < P.rowptr[i + 1]; q++) s += P.val[q] * xc[P.colidx[q]];
        x[i] += s;
      }
      gs(b, x, -1);
    },
  };
}
