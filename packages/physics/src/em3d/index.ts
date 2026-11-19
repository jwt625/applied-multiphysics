// SPDX-License-Identifier: GPL-3.0-or-later
// `emw` eigenfrequencies: 3D Maxwell eigenproblem of a closed cavity,
//   curl (mu_r^-1 curl E) = k0^2 eps_r E,  k0 = 2 pi f / c0,  n x E = 0 on PEC (natural PMC elsewhere),
// with hierarchical Nedelec (first kind) order 1 or 2 elements (@amp/core fem/hcurl.mjs, fem/space.mjs). Straight
// tets use the exact affine element tables; curved tet10 cells (mid-edge nodes off the chord) use isoparametric
// quadratic geometry with the covariant Piola map N = J^-T N_ref, curl N = J curl_ref N / det J and a collapsed Gauss
// rule. Gradient null space: the discrete gradient G of the matching H1 space (order 1: P1; order 2: hierarchical P2,
// exact sequence of hcurl.mjs) gives an M-orthogonal projector P = I - G (G^T M G)^-1 G^T M applied to the Krylov
// vectors, so gradient (zero-frequency) eigenvectors never enter; the divergence residual ||G^T M x|| / ||M x|| is
// reported per mode. Shift: (2 pi shift / c0)^2 when the study gives one (LDL^T; inertia minus the null-space
// dimension counts the physical modes below it), else a negative shift below the spectrum (Cholesky).
// Dielectric Q by first-order perturbation: Q_d^-1 = sum_cells tan_delta eps_r int |E|^2 / sum eps_r int |E|^2.

import type { Mesh, PhysicsModule, RunContext, Solution, FieldData } from '@amp/spec/types';
import { buildElementPattern, elementSlots, SparseCholesky, analyze } from '@amp/core/la/sparse';
import { buildAMSReal, buildPMGReal, leadingBlock, pcgCsr } from '@amp/core/la/ams-real';
import { csrMatMat, csrTranspose } from '@amp/core/la/amg';
import { ndBasis, curlOf, pairIndex, evalVector, tetMatricesP, TET_EDGES } from '@amp/core/fem/hcurl';
import { buildSpace } from '@amp/core/fem/space';
import { NPC, nCells, facetsOn } from '../common/mesh.ts';
import { tetRule } from '../common/quad.ts';
import { shapeTable } from '../common/lagrange.ts';
import { restrict, type Csr } from '../common/scalar.ts';
import { eigenCheckNote, shiftInvertEigen, csrMatVec, dotVec } from '../common/eigen.ts';
import { StageTimer, makeSolution, checkAbort, attachMesh } from '../common/solution.ts';
import { cellProps, optionalCellProp, bcSelections, bcTypes, eigenStudy, physicsNode } from './ctx.ts';

/** Speed of light in vacuum, exact by the SI definition of the metre (CODATA 2018). */
export const C0 = 299792458;

// ------------------------------------------------------------------------------------------------- mesh adapter

export interface HcurlMesh {
  nodes: Float64Array; nNodes: number; tets: Int32Array; nTets: number; edges: Int32Array; nEdges: number;
  tetEdges: Int32Array; edgeIndex: (a: number, b: number) => number | undefined;
  /** tet10 geometry nodes per tet in VTK order of the sorted vertices (null for tet4 meshes) */
  geo10: Int32Array | null;
  /** cell index of every tet (same order as the C2 mesh) */
  curved: Uint8Array;
}

/** APA em3d mesh shape (DevLog-002 contract request 3) from a C2 tet4 / tet10 mesh: vertices sorted per tet. */
export function toHcurlMesh(m: Mesh, curvedTol = 1e-9): HcurlMesh {
  if (m.dim !== 3 || (m.cells.type !== 'tet4' && m.cells.type !== 'tet10')) throw new Error(`em3d: needs a tet4 / tet10 mesh, got ${m.cells.type}`);
  const k = NPC[m.cells.type], nT = nCells(m), nN = m.nodes.length / 3;
  const tets = new Int32Array(4 * nT);
  const geo10 = m.cells.type === 'tet10' ? new Int32Array(10 * nT) : null;
  const curved = new Uint8Array(nT);
  const map = new Map<number, number>();
  const edges: number[] = [];
  const tetEdges = new Int32Array(6 * nT);
  const key = (a: number, b: number) => (a < b ? a * nN + b : b * nN + a);
  const VTK_E: Array<[number, number]> = [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]];
  const perm = [0, 1, 2, 3];
  for (let t = 0; t < nT; t++) {
    const v = [0, 1, 2, 3].map((i) => m.cells.conn[k * t + i]!);
    perm.sort((i, j) => v[i]! - v[j]!);
    for (let i = 0; i < 4; i++) tets[4 * t + i] = v[perm[i]!]!;
    for (let e = 0; e < 6; e++) {
      const [i, j] = TET_EDGES[e] as [number, number];
      const a = tets[4 * t + i]!, b = tets[4 * t + j]!;
      const kk = key(a, b);
      let id = map.get(kk);
      if (id === undefined) { id = edges.length / 2; map.set(kk, id); edges.push(a, b); }
      tetEdges[6 * t + e] = id;
    }
    if (geo10) {
      // original mid node of the original local edge (p, q)
      const midOrig = (p: number, q: number) => {
        const e = VTK_E.findIndex(([x, y]) => (x === p && y === q) || (x === q && y === p));
        return m.cells.conn[k * t + 4 + e]!;
      };
      for (let i = 0; i < 4; i++) geo10[10 * t + i] = tets[4 * t + i]!;
      VTK_E.forEach(([i, j], e) => { geo10[10 * t + 4 + e] = midOrig(perm[i]!, perm[j]!); });
      for (let e = 0; e < 6; e++) {
        const [i, j] = VTK_E[e]!;
        const a = geo10[10 * t + i]!, b = geo10[10 * t + j]!, c = geo10[10 * t + 4 + e]!;
        let dev = 0, len = 0;
        for (let d = 0; d < 3; d++) {
          dev += (m.nodes[3 * c + d]! - 0.5 * (m.nodes[3 * a + d]! + m.nodes[3 * b + d]!)) ** 2;
          len += (m.nodes[3 * a + d]! - m.nodes[3 * b + d]!) ** 2;
        }
        if (Math.sqrt(dev) > curvedTol * Math.sqrt(len)) curved[t] = 1;
      }
    }
  }
  return {
    nodes: m.nodes, nNodes: nN, tets, nTets: nT, edges: Int32Array.from(edges), nEdges: edges.length / 2, tetEdges,
    edgeIndex: (a, b) => map.get(key(a, b)), geo10, curved,
  };
}

// ------------------------------------------------------------------------------------------ curved element tables

interface RefTables { nq: number; nb: number; w: Float64Array; Nref: Float64Array; Cref: Float64Array; dN: Float64Array }
const refCache = new Map<string, RefTables>();

/** Reference ND basis values and curls (nq x nb x 3) and tet10 shape derivatives (nq x 10 x 3) on a tet rule. */
function refTables(order: 1 | 2, nGauss: number): RefTables {
  const key = `${order}:${nGauss}`;
  const hit = refCache.get(key);
  if (hit) return hit;
  const rule = tetRule(nGauss);
  const B = ndBasis(order, 4) as unknown[][];
  const C = B.map((f) => curlOf(f, 4) as Array<[number, number[], number]>);
  const gRef = Float64Array.from([-1, -1, -1, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const { pairs } = pairIndex(4) as unknown as { pairs: Array<[number, number]> };
  const cr = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const X = pairs.map(([k, m]) => cr(Array.from(gRef.subarray(3 * k, 3 * k + 3)), Array.from(gRef.subarray(3 * m, 3 * m + 3))));
  const nq = rule.n, nb = B.length;
  const Nref = new Float64Array(nq * nb * 3), Cref = new Float64Array(nq * nb * 3);
  const out = new Float64Array(3);
  for (let q = 0; q < nq; q++) {
    const x = rule.pts[3 * q]!, y = rule.pts[3 * q + 1]!, z = rule.pts[3 * q + 2]!;
    const l = [1 - x - y - z, x, y, z];
    for (let a = 0; a < nb; a++) {
      evalVector(B[a], l, gRef, 3, out);
      Nref.set(out, 3 * (q * nb + a));
      let c0 = 0, c1 = 0, c2 = 0;
      for (const [c, al, p] of C[a]!) {
        let v = c;
        al.forEach((ak, kk) => { if (ak) v *= l[kk]! ** ak; });
        c0 += v * X[p]![0]!; c1 += v * X[p]![1]!; c2 += v * X[p]![2]!;
      }
      Cref[3 * (q * nb + a)] = c0; Cref[3 * (q * nb + a) + 1] = c1; Cref[3 * (q * nb + a) + 2] = c2;
    }
  }
  const t10 = shapeTable('tet10', rule);
  const r = { nq, nb, w: rule.wts, Nref, Cref, dN: t10.dN };
  refCache.set(key, r);
  return r;
}

/** Element curl-curl S and mass M (nb x nb, row-major, full) of a curved tet10 (geometry node coords X, 10 x 3). */
export function curvedTetMatrices(order: 1 | 2, X: Float64Array, nu: number, eps: number, S: Float64Array, M: Float64Array, nGauss = 4): void {
  const T = refTables(order, nGauss);
  const nb = T.nb;
  S.fill(0); M.fill(0);
  const N = new Float64Array(nb * 3), C = new Float64Array(nb * 3);
  for (let q = 0; q < T.nq; q++) {
    const J = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let a = 0; a < 10; a++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) J[3 * r + c]! += X[3 * a + r]! * T.dN[(q * 10 + a) * 3 + c]!;
    const [a, b, c, d, e, f, g, h, k] = J as [number, number, number, number, number, number, number, number, number];
    const A = e * k - f * h, Bc = -(d * k - f * g), Cc = d * h - e * g;
    const det = a * A + b * Bc + c * Cc;
    const inv = [A / det, -(b * k - c * h) / det, (b * f - c * e) / det, Bc / det, (a * k - c * g) / det, -(a * f - c * d) / det, Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det];
    const wq = T.w[q]! * Math.abs(det);
    for (let i = 0; i < nb; i++) {
      const o = 3 * (q * nb + i);
      const n0 = T.Nref[o]!, n1 = T.Nref[o + 1]!, n2 = T.Nref[o + 2]!;
      // J^-T n: (J^-T)_{rc} = inv_{cr}
      N[3 * i] = inv[0]! * n0 + inv[3]! * n1 + inv[6]! * n2;
      N[3 * i + 1] = inv[1]! * n0 + inv[4]! * n1 + inv[7]! * n2;
      N[3 * i + 2] = inv[2]! * n0 + inv[5]! * n1 + inv[8]! * n2;
      const c0 = T.Cref[o]!, c1 = T.Cref[o + 1]!, c2 = T.Cref[o + 2]!;
      C[3 * i] = (a * c0 + b * c1 + c * c2) / det;
      C[3 * i + 1] = (d * c0 + e * c1 + f * c2) / det;
      C[3 * i + 2] = (g * c0 + h * c1 + k * c2) / det;
    }
    const wm = wq * eps, ws = wq * nu;
    for (let i = 0; i < nb; i++) for (let j = i; j < nb; j++) {
      M[nb * i + j]! += wm * (N[3 * i]! * N[3 * j]! + N[3 * i + 1]! * N[3 * j + 1]! + N[3 * i + 2]! * N[3 * j + 2]!);
      S[nb * i + j]! += ws * (C[3 * i]! * C[3 * j]! + C[3 * i + 1]! * C[3 * j + 1]! + C[3 * i + 2]! * C[3 * j + 2]!);
    }
  }
  for (let i = 0; i < nb; i++) for (let j = 0; j < i; j++) { M[nb * i + j] = M[nb * j + i]!; S[nb * i + j] = S[nb * j + i]!; }
}

/** Barycentric gradients (4 x 3) and volume of a straight tet from 4 vertex coordinates (12). */
export function tetGrads(P: Float64Array, g: Float64Array): number {
  const e1 = [P[3]! - P[0]!, P[4]! - P[1]!, P[5]! - P[2]!], e2 = [P[6]! - P[0]!, P[7]! - P[1]!, P[8]! - P[2]!], e3 = [P[9]! - P[0]!, P[10]! - P[1]!, P[11]! - P[2]!];
  const cr = (u: number[], v: number[]) => [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const det = e1[0]! * (e2[1]! * e3[2]! - e2[2]! * e3[1]!) - e1[1]! * (e2[0]! * e3[2]! - e2[2]! * e3[0]!) + e1[2]! * (e2[0]! * e3[1]! - e2[1]! * e3[0]!);
  const g1 = cr(e2, e3), g2 = cr(e3, e1), g3 = cr(e1, e2);
  for (let d = 0; d < 3; d++) {
    g[3 + d] = g1[d]! / det; g[6 + d] = g2[d]! / det; g[9 + d] = g3[d]! / det;
    g[d] = -(g[3 + d]! + g[6 + d]! + g[9 + d]!);
  }
  return Math.abs(det) / 6;
}

// ---------------------------------------------------------------------------------------------- problem / solve

export interface CavityProblem {
  mesh: Mesh;
  order: 1 | 2;
  /** per cell; cells with mask 0 are not assembled */
  epsR: Float64Array; muR: Float64Array; tanDelta?: Float64Array; mask?: Uint8Array;
  /** PEC boundary selections (entity ids) */
  pec: string[];
  nModes: number;
  shiftHz?: number | null;
  /** gradient projection (default true) */
  project?: boolean;
  /** use curved geometry on tet10 cells off the chord (default true) */
  curved?: boolean;
  nGauss?: number;
  /** Arnoldi block size and Ritz tolerance (defaults 4 and 1e-9) */
  blockSize?: number;
  eigTol?: number;
  /** compute E_z fraction and azimuthal order per mode about the z axis through `axis` (x, y) (default true, (0, 0)) */
  characterize?: boolean;
  axis?: [number, number];
  spec?: unknown;
  signal?: AbortSignal;
  progress?: (stage: string, frac: number, msg?: string) => void;
  /**
   * Linear solver of the shift-invert operator (DevLog-054): 'direct' (default: sparse Cholesky / LDL^T), 'ams'
   * (preconditioned CG with the auxiliary-space Maxwell preconditioner, order 2 through a p-multigrid level; needs the
   * negative shift, so it finds the lowest modes), 'auto' (AMS when the direct factor would exceed
   * EM3D_DIRECT_MAX_BYTES, else direct).
   */
  solver?: 'direct' | 'ams' | 'auto';
  /** inner PCG relative residual of the AMS path (default EM3D_AMS_RTOL) */
  solverRtol?: number;
}

/** 'auto': direct factor storage (8 nnzL bytes) above which em3d uses the AMS path. Measured (DevLog-054 s.3.4): factor 119 MiB -> run RSS 0.74-0.82 GB, 237 MiB -> 1.18-1.44 GB; 300 MiB keeps the direct path below the 2 GB budget. */
export const EM3D_DIRECT_MAX_BYTES = 300 * 2 ** 20;
/** Default inner PCG relative residual of the AMS path. */
export const EM3D_AMS_RTOL = 1e-10;

/**
 * Nodal interpolation Pi_x, Pi_y, Pi_z (nc x nP each) from P1 vector fields to the Whitney DOFs of the free edges
 * rows < nc (Whitney coefficient of a P1 field u = int_e u . dl = (u_a + u_b) / 2 . (x_b - x_a), the DOF of the discrete
 * gradient G = [-1, +1] on (a, b)); columns: the vertices of those edges.
 */
function whitneyInterpolation(hm: HcurlMesh, inv: Int32Array, nc: number) {
  const col = new Int32Array(hm.nNodes).fill(-1);
  let nP = 0;
  for (let r = 0; r < nc; r++) for (const v of [hm.edges[2 * inv[r]!]!, hm.edges[2 * inv[r]! + 1]!]) if (col[v]! < 0) col[v] = nP++;
  return [0, 1, 2].map((d) => {
    const rowptr = new Int32Array(nc + 1), colidx = new Int32Array(2 * nc), val = new Float64Array(2 * nc);
    for (let r = 0; r < nc; r++) {
      const a = hm.edges[2 * inv[r]!]!, b = hm.edges[2 * inv[r]! + 1]!;
      const h = 0.5 * (hm.nodes[3 * b + d]! - hm.nodes[3 * a + d]!);
      const [c0, c1] = col[a]! < col[b]! ? [col[a]!, col[b]!] : [col[b]!, col[a]!];
      colidx[2 * r] = c0; colidx[2 * r + 1] = c1; val[2 * r] = h; val[2 * r + 1] = h;
      rowptr[r + 1] = 2 * r + 2;
    }
    return { n: nc, m: nP, rowptr, colidx, val };
  });
}

export interface CavityDetail {
  divResidual: Float64Array; eigResidual: Float64Array; nNull: number; nBelowShift: number | null;
  /** per kept mode: energy fraction of E_z (0 for TE modes about the z axis) and dominant azimuthal order m about z */
  ezFraction: Float64Array; azimuthalOrder: Int32Array;
  stats: Record<string, number | string | boolean | null>;
}

/**
 * E at the reference centroid of every tet (covariant Piola with J at the centroid; affine tets exactly) for global
 * ND coefficients x (full numbering); returns E (3 per tet), centroid coordinates (3 per tet) and |det J| / 6.
 */
export function centroidFields(hm: HcurlMesh, order: 1 | 2, tetDofs: Int32Array, x: Float64Array, useCurved: boolean) {
  const B = ndBasis(order, 4) as unknown[][];
  const nb = B.length, nT = hm.nTets;
  const l = [0.25, 0.25, 0.25, 0.25];
  const gRef = Float64Array.from([-1, -1, -1, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const Nref = new Float64Array(3 * nb), o3 = new Float64Array(3);
  for (let a = 0; a < nb; a++) { evalVector(B[a], l, gRef, 3, o3); Nref.set(o3, 3 * a); }
  const dN = new Float64Array(30), N10 = new Float64Array(10);
  // tet10 shape derivatives at the centroid
  {
    const L = [0.25, 0.25, 0.25, 0.25], G = [[-1, -1, -1], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let i = 0; i < 4; i++) for (let d = 0; d < 3; d++) dN[3 * i + d] = (4 * L[i]! - 1) * G[i]![d]!;
    [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]].forEach(([a, b], e) => { for (let d = 0; d < 3; d++) dN[3 * (4 + e) + d] = 4 * (G[a!]![d]! * L[b!]! + L[a!]! * G[b!]![d]!); });
    void N10;
  }
  const E = new Float64Array(3 * nT), C = new Float64Array(3 * nT), W = new Float64Array(nT);
  for (let t = 0; t < nT; t++) {
    const J = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const curved = useCurved && hm.geo10 && hm.curved[t];
    if (curved) {
      for (let a = 0; a < 10; a++) { const n = hm.geo10![10 * t + a]!; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) J[3 * r + c]! += hm.nodes[3 * n + r]! * dN[3 * a + c]!; }
    } else {
      const v0 = hm.tets[4 * t]!;
      for (let c = 0; c < 3; c++) { const v = hm.tets[4 * t + 1 + c]!; for (let r = 0; r < 3; r++) J[3 * r + c] = hm.nodes[3 * v + r]! - hm.nodes[3 * v0 + r]!; }
    }
    const [a, b, c, d, e, f, g, h, k] = J as [number, number, number, number, number, number, number, number, number];
    const A = e * k - f * h, Bc = -(d * k - f * g), Cc = d * h - e * g;
    const det = a * A + b * Bc + c * Cc;
    const inv = [A / det, -(b * k - c * h) / det, (b * f - c * e) / det, Bc / det, (a * k - c * g) / det, -(a * f - c * d) / det, Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det];
    let r0 = 0, r1 = 0, r2 = 0;
    for (let i = 0; i < nb; i++) {
      const xi = x[tetDofs[nb * t + i]!]!;
      if (xi === 0) continue;
      const n0 = Nref[3 * i]!, n1 = Nref[3 * i + 1]!, n2 = Nref[3 * i + 2]!;
      r0 += xi * (inv[0]! * n0 + inv[3]! * n1 + inv[6]! * n2);
      r1 += xi * (inv[1]! * n0 + inv[4]! * n1 + inv[7]! * n2);
      r2 += xi * (inv[2]! * n0 + inv[5]! * n1 + inv[8]! * n2);
    }
    E[3 * t] = r0; E[3 * t + 1] = r1; E[3 * t + 2] = r2;
    for (let q = 0; q < 4; q++) { const n = hm.tets[4 * t + q]!; for (let dd = 0; dd < 3; dd++) C[3 * t + dd]! += 0.25 * hm.nodes[3 * n + dd]!; }
    W[t] = Math.abs(det) / 6;
  }
  return { E, C, W };
}

/**
 * H1 projection of an ND field for drawing and point probes (L5 request 5; audit S3): E evaluated in every tet at its
 * geometry nodes (4 corners, plus the 6 edge nodes on tet10 meshes; covariant Piola with the local J, curved or
 * affine) and averaged over the tets sharing the node. Tangential E is continuous, so the average is exact for it;
 * the normal component is averaged across material interfaces (a drawing projection, not a solution).
 * Returns 3 components per mesh node (H1P1 on tet4, H1P2 on tet10 node numbering).
 */
export function nodalFields(hm: HcurlMesh, order: 1 | 2, tetDofs: Int32Array, x: Float64Array, useCurved: boolean, mask?: Uint8Array): Float64Array {
  const B = ndBasis(order, 4) as unknown[][];
  const nb = B.length, nT = hm.nTets, nN = hm.nNodes;
  const gRef = Float64Array.from([-1, -1, -1, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const REF = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0, 0.5], [0, 0.5, 0.5]];
  const np = hm.geo10 ? 10 : 4;
  // reference basis values and tet10 shape derivatives at the reference nodes
  const Nref = new Float64Array(np * nb * 3), o3 = new Float64Array(3);
  const dN10 = new Float64Array(np * 30), n10 = new Float64Array(10), d10 = new Float64Array(30);
  for (let q = 0; q < np; q++) {
    const [a, b, c] = REF[q] as [number, number, number];
    const l = [1 - a - b - c, a, b, c];
    for (let i = 0; i < nb; i++) { evalVector(B[i], l, gRef, 3, o3); Nref.set(o3, 3 * (q * nb + i)); }
    shapeOf10(REF[q]!, n10, d10); dN10.set(d10, 30 * q);
  }
  const acc = new Float64Array(3 * nN), cnt = new Float64Array(nN);
  for (let t = 0; t < nT; t++) {
    if (mask && !mask[t]) continue;
    const curved = useCurved && !!hm.geo10 && hm.curved[t] === 1;
    for (let q = 0; q < np; q++) {
      const J = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      if (curved) {
        for (let a = 0; a < 10; a++) { const n = hm.geo10![10 * t + a]!; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) J[3 * r + c]! += hm.nodes[3 * n + r]! * dN10[30 * q + 3 * a + c]!; }
      } else {
        const v0 = hm.tets[4 * t]!;
        for (let c = 0; c < 3; c++) { const v = hm.tets[4 * t + 1 + c]!; for (let r = 0; r < 3; r++) J[3 * r + c] = hm.nodes[3 * v + r]! - hm.nodes[3 * v0 + r]!; }
      }
      const [a, b, c, d, e, f, g, h, k] = J as [number, number, number, number, number, number, number, number, number];
      const A = e * k - f * h, Bc = -(d * k - f * g), Cc = d * h - e * g, det = a * A + b * Bc + c * Cc;
      const inv = [A / det, -(b * k - c * h) / det, (b * f - c * e) / det, Bc / det, (a * k - c * g) / det, -(a * f - c * d) / det, Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det];
      let r0 = 0, r1 = 0, r2 = 0;
      for (let i = 0; i < nb; i++) {
        const xi = x[tetDofs[nb * t + i]!]!;
        if (xi === 0) continue;
        const o = 3 * (q * nb + i), n0 = Nref[o]!, n1 = Nref[o + 1]!, n2 = Nref[o + 2]!;
        r0 += xi * (inv[0]! * n0 + inv[3]! * n1 + inv[6]! * n2);
        r1 += xi * (inv[1]! * n0 + inv[4]! * n1 + inv[7]! * n2);
        r2 += xi * (inv[2]! * n0 + inv[5]! * n1 + inv[8]! * n2);
      }
      const node = q < 4 ? hm.tets[4 * t + q]! : hm.geo10![10 * t + q]!;
      acc[3 * node]! += r0; acc[3 * node + 1]! += r1; acc[3 * node + 2]! += r2; cnt[node]!++;
    }
  }
  for (let n = 0; n < nN; n++) if (cnt[n]) for (let d = 0; d < 3; d++) acc[3 * n + d]! /= cnt[n]!;
  return acc;
}

function shapeOf10(p: number[], N: Float64Array, dN: Float64Array): void {
  const L = [1 - p[0]! - p[1]! - p[2]!, p[0]!, p[1]!, p[2]!], G = [[-1, -1, -1], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let i = 0; i < 4; i++) { N[i] = L[i]! * (2 * L[i]! - 1); for (let d = 0; d < 3; d++) dN[3 * i + d] = (4 * L[i]! - 1) * G[i]![d]!; }
  [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]].forEach(([a, b], e) => { N[4 + e] = 4 * L[a!]! * L[b!]!; for (let d = 0; d < 3; d++) dN[3 * (4 + e) + d] = 4 * (G[a!]![d]! * L[b!]! + L[a!]! * G[b!]![d]!); });
}

/**
 * Field character about the z axis through (cx, cy): energy fraction of E_z, and the azimuthal order m in 0..mMax with
 * the largest binned Fourier energy (cells binned in (r, z), cylindrical components transformed per cell).
 */
export function fieldCharacter(E: Float64Array, C: Float64Array, W: Float64Array, cx = 0, cy = 0, mMax = 4, bins = 6) {
  const nT = W.length;
  let ez = 0, all = 0, rMax = 0, z0 = Infinity, z1 = -Infinity;
  for (let t = 0; t < nT; t++) {
    rMax = Math.max(rMax, Math.hypot(C[3 * t]! - cx, C[3 * t + 1]! - cy));
    z0 = Math.min(z0, C[3 * t + 2]!); z1 = Math.max(z1, C[3 * t + 2]!);
    const e2 = E[3 * t]! ** 2 + E[3 * t + 1]! ** 2 + E[3 * t + 2]! ** 2;
    all += W[t]! * e2; ez += W[t]! * E[3 * t + 2]! ** 2;
  }
  const nb = bins * bins;
  let best = 0, bestP = -1;
  for (let m = 0; m <= mMax; m++) {
    const acc = new Float64Array(nb * 6);
    for (let t = 0; t < nT; t++) {
      const x = C[3 * t]! - cx, y = C[3 * t + 1]! - cy, r = Math.hypot(x, y), ph = Math.atan2(y, x);
      const er = (E[3 * t]! * x + E[3 * t + 1]! * y) / (r || 1), ep = (-E[3 * t]! * y + E[3 * t + 1]! * x) / (r || 1), e3 = E[3 * t + 2]!;
      const bi = Math.min(bins - 1, Math.floor((r / (rMax * 1.0000001)) * bins)), bz = Math.min(bins - 1, Math.floor(((C[3 * t + 2]! - z0) / ((z1 - z0) * 1.0000001)) * bins));
      const o = 6 * (bi * bins + bz), cs = Math.cos(m * ph), sn = Math.sin(m * ph), w = W[t]!;
      acc[o]! += w * er * cs; acc[o + 1]! += w * er * sn; acc[o + 2]! += w * ep * cs; acc[o + 3]! += w * ep * sn; acc[o + 4]! += w * e3 * cs; acc[o + 5]! += w * e3 * sn;
    }
    let P = 0;
    for (let q = 0; q < acc.length; q++) P += acc[q]! ** 2;
    if (m === 0) P *= 2;  // cos(0) carries the full amplitude, sin(0) none: normalise against m >= 1
    if (P > bestP) { bestP = P; best = m; }
  }
  return { ezFraction: all > 0 ? ez / all : 0, m: best };
}

export async function solveCavity(p: CavityProblem): Promise<Solution & { detail: CavityDetail }> {
  const timer = new StageTimer();
  const { mesh, order } = p;
  timer.start('assemble');
  const hm = toHcurlMesh(mesh);
  const space = buildSpace(hm, order) as ReturnType<typeof buildSpace> & { tetDofs: Int32Array; nDof: number; ndt: number; faceDofs: (v: Int32Array | number[]) => Int32Array };
  const nDof = space.nDof, ndt = space.ndt, nT = hm.nTets;
  const pat = buildElementPattern(nDof, space.tetDofs, ndt) as Csr;
  const slots = elementSlots(pat, space.tetDofs, ndt) as Int32Array;
  const S = new Float64Array(pat.nnz), M = new Float64Array(pat.nnz);
  const lossy = !!p.tanDelta && Array.from(p.tanDelta).some((x) => x > 0);
  const Mt = lossy ? new Float64Array(pat.nnz) : null;
  const Se = new Float64Array(ndt * ndt), Me = new Float64Array(ndt * ndt), Si = new Float64Array(ndt * ndt), Mi = new Float64Array(ndt * ndt);
  const g = new Float64Array(12), P = new Float64Array(12), X10 = new Float64Array(30);
  const useCurved = (p.curved ?? true) && !!hm.geo10;
  const work = {};
  const active = new Uint8Array(nDof);
  let nCurved = 0;
  for (let t = 0; t < nT; t++) {
    if (p.mask && !p.mask[t]) continue;
    const eps = p.epsR[t]!, nu = 1 / p.muR[t]!;
    if (useCurved && hm.curved[t]) {
      for (let a = 0; a < 10; a++) for (let d = 0; d < 3; d++) X10[3 * a + d] = mesh.nodes[3 * hm.geo10![10 * t + a]! + d]!;
      curvedTetMatrices(order, X10, nu, eps, Se, Me, p.nGauss ?? 4);
      nCurved++;
    } else {
      for (let a = 0; a < 4; a++) for (let d = 0; d < 3; d++) P[3 * a + d] = mesh.nodes[3 * hm.tets[4 * t + a]! + d]!;
      const V = tetGrads(P, g);
      tetMatricesP(order, g, V, { re: [nu, nu, nu], im: [0, 0, 0] }, { re: [eps, eps, eps], im: [0, 0, 0] }, Se, Si, Me, Mi, work);
    }
    const base = ndt * ndt * t, td = p.tanDelta ? p.tanDelta[t]! : 0;
    for (let i = 0; i < ndt; i++) {
      active[space.tetDofs[ndt * t + i]!] = 1;
      for (let j = 0; j < ndt; j++) {
        const s = slots[base + ndt * i + j]!;
        S[s]! += Se[ndt * i + j]!; M[s]! += Me[ndt * i + j]!;
        if (Mt && td > 0) Mt[s]! += td * Me[ndt * i + j]!;
      }
    }
  }
  // PEC: tangential DOFs on the selected boundary facets; DOFs of inactive cells
  const free = Uint8Array.from(active);
  const kf = NPC[mesh.facets.type];
  const pecFacets = p.pec.length ? facetsOn(mesh, p.pec) : [];
  const v3 = [0, 0, 0];
  const fixedNode = new Uint8Array(hm.nNodes), fixedEdge = new Uint8Array(hm.nEdges);
  for (const f of pecFacets) {
    for (let i = 0; i < 3; i++) v3[i] = mesh.facets.conn[kf * f + i]!;
    v3.sort((x, y) => x - y);
    for (const d of space.faceDofs(v3)) free[d] = 0;
    for (const v of v3) fixedNode[v] = 1;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) fixedEdge[hm.edgeIndex(v3[i]!, v3[j]!)!] = 1;
  }
  const R = restrict(pat, S, free);
  const Mr = restrict(pat, M, free).val;
  const Mtr = Mt ? restrict(pat, Mt, free).val : null;
  const nf = R.pat.n;
  // discrete gradient from the free H1 DOFs (vertices; order 2 also edge bubbles) to the free ND DOFs
  const usedNode = new Uint8Array(hm.nNodes);
  for (let t = 0; t < nT; t++) if (!p.mask || p.mask[t]) for (let i = 0; i < 4; i++) usedNode[hm.tets[4 * t + i]!] = 1;
  const usedEdge = new Uint8Array(hm.nEdges);
  for (let t = 0; t < nT; t++) if (!p.mask || p.mask[t]) for (let e = 0; e < 6; e++) usedEdge[hm.tetEdges[6 * t + e]!] = 1;
  const h1Node = new Int32Array(hm.nNodes).fill(-1), h1Edge = new Int32Array(hm.nEdges).fill(-1);
  let nH = 0;
  for (let v = 0; v < hm.nNodes; v++) if (usedNode[v] && !fixedNode[v]) h1Node[v] = nH++;
  if (order === 2) for (let e = 0; e < hm.nEdges; e++) if (usedEdge[e] && !fixedEdge[e]) h1Edge[e] = nH++;
  const gRow = new Int32Array(nf + 1), gCol: number[] = [], gVal: number[] = [];
  const nE = hm.nEdges;
  for (let r = 0; r < nf; r++) {
    const d = R.inv[r]!;
    if (d < nE) {
      const a = hm.edges[2 * d]!, b = hm.edges[2 * d + 1]!;
      const ca = h1Node[a]!, cb = h1Node[b]!;
      if (ca >= 0) { gCol.push(ca); gVal.push(-1); }
      if (cb >= 0) { gCol.push(cb); gVal.push(1); }
      if (ca >= 0 && cb >= 0 && ca > cb) { const n = gCol.length; [gCol[n - 2], gCol[n - 1]] = [gCol[n - 1]!, gCol[n - 2]!]; [gVal[n - 2], gVal[n - 1]] = [gVal[n - 1]!, gVal[n - 2]!]; }
    } else if (order === 2 && d < 2 * nE) {
      const c = h1Edge[d - nE]!;
      if (c >= 0) { gCol.push(c); gVal.push(1); }
    }
    gRow[r + 1] = gCol.length;
  }
  const G = { n: nf, m: nH, rowptr: gRow, colidx: Int32Array.from(gCol), val: Float64Array.from(gVal) };
  const Gt = csrTranspose(G);
  const Mcsr = { n: nf, m: nf, rowptr: R.pat.rowptr, colidx: R.pat.colidx, val: Mr };
  const Ah = csrMatMat(Gt, csrMatMat(Mcsr, G));
  timer.stop('assemble');
  checkAbort(p.signal);
  p.progress?.('factor', 0.3, `ND${order}: ${nf} free DOFs, H1 null space ${nH}`);
  timer.start('factor');
  const hPat = { n: nH, rowptr: Ah.rowptr, colidx: Ah.colidx, nnz: Ah.colidx.length };
  const hChol = nH ? new SparseCholesky(hPat) : null;
  if (hChol && !hChol.factor(Ah.val)) throw new Error('em3d: G^T M G not positive definite');
  timer.stop('factor');
  const Mx = new Float64Array(nf), gr = new Float64Array(nH), gz = new Float64Array(nf);
  const gtmv = (x: Float64Array) => {   // G^T M x
    csrMatVec(R.pat, Mr, x, Mx);
    gr.fill(0);
    for (let r = 0; r < nf; r++) for (let q = gRow[r]!; q < gRow[r + 1]!; q++) gr[gCol[q]!]! += gVal[q]! * Mx[r]!;
    return gr;
  };
  const project = (x: Float64Array) => {
    if (!hChol) return;
    const z = hChol.solve(gtmv(x), new Float64Array(nH)) as Float64Array;
    csrMatVec({ n: nf, rowptr: gRow, colidx: G.colidx, nnz: gCol.length }, G.val, z, gz);
    for (let i = 0; i < nf; i++) x[i]! -= gz[i]!;
  };
  // shift: in k0^2 units
  const diag = (() => {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let n = 0; n < hm.nNodes; n++) for (let d = 0; d < 3; d++) { const x = mesh.nodes[3 * n + d]!; lo[d] = Math.min(lo[d]!, x); hi[d] = Math.max(hi[d]!, x); }
    return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  })();
  let epsMuMax = 0;
  for (let t = 0; t < nT; t++) if (!p.mask || p.mask[t]) epsMuMax = Math.max(epsMuMax, p.epsR[t]! * p.muR[t]!);
  const sigmaBelow = -((Math.PI / diag) ** 2) / epsMuMax;
  const sigmaShift = p.shiftHz ? (2 * Math.PI * p.shiftHz / C0) ** 2 : sigmaBelow;
  const doProject = p.project ?? true;
  // linear solver (DevLog-054): direct factor, or AMS-preconditioned CG ('ams'; 'auto' above the direct byte budget)
  const want = p.solver ?? 'direct';
  if (want !== 'direct' && want !== 'ams' && want !== 'auto') throw new Error(`em3d: solver '${String(want)}' (direct | ams | auto)`);
  let sym: ReturnType<typeof analyze> | undefined;
  let useAms = want === 'ams';
  let solverReason = '';
  if (want === 'auto') {
    sym = analyze(R.pat);
    const bytes = 8 * Number(sym.nnzL);
    useAms = bytes > EM3D_DIRECT_MAX_BYTES;
    solverReason = `auto: direct factor ${(bytes / 2 ** 20).toFixed(0)} MiB ${useAms ? '>' : '<='} ${EM3D_DIRECT_MAX_BYTES / 2 ** 20} MiB`;
  }
  const sigma = useAms ? sigmaBelow : sigmaShift;
  const amsRtol = p.solverRtol ?? EM3D_AMS_RTOL;
  if (!(amsRtol > 0 && amsRtol < 1)) throw new Error(`em3d: solverRtol ${amsRtol}: expected 0 < rtol < 1`);
  const amsStats = { setupMs: 0, solves: 0, itMin: Infinity, itMax: 0, itSum: 0, relresMax: 0, nCoarse: 0, nAux: 0 };
  const linearSolver = useAms ? (A: Float64Array) => {
    const t0 = performance.now();
    // free Whitney DOFs are the leading free DOFs (R numbers free DOFs by increasing DOF id, Whitney ids < nE)
    let nc = 0;
    while (nc < nf && R.inv[nc]! < nE) nc++;
    for (let r = nc; r < nf; r++) if (R.inv[r]! < nE) throw new Error('em3d ams: free Whitney DOFs are not a prefix');
    const Pis = whitneyInterpolation(hm, R.inv, nc);
    let nV = 0;
    for (let v = 0; v < hm.nNodes; v++) if (h1Node[v]! >= 0) nV++;
    const G1 = { n: nc, m: nV, rowptr: gRow.slice(0, nc + 1), colidx: G.colidx.slice(0, gRow[nc]!), val: G.val.slice(0, gRow[nc]!) };
    let pre: { apply: (b: Float64Array, x: Float64Array) => void };
    if (order === 1) pre = buildAMSReal({ pat: R.pat, val: A, G: G1, Pis });
    else {
      const C = leadingBlock(R.pat, A, nc);
      const coarse = buildAMSReal({ pat: C.pat, val: C.val, G: G1, Pis });
      pre = buildPMGReal({ pat: R.pat, val: A, nc, Gf: G, coarse });
    }
    amsStats.setupMs = performance.now() - t0; amsStats.nCoarse = nc; amsStats.nAux = nH;
    return {
      label: `AMS-PCG (rtol ${amsRtol})`,
      solveMany: (b: Float64Array, m: number) => {
        const out = new Float64Array(nf * m);
        for (let c = 0; c < m; c++) {
          checkAbort(p.signal);
          const x = out.subarray(c * nf, (c + 1) * nf);
          const r = pcgCsr(R.pat, A, pre.apply, b.subarray(c * nf, (c + 1) * nf), x, { rtol: amsRtol, maxIter: 2000 });
          if (!r.converged) throw new Error(`em3d ams: PCG did not converge (relative residual ${r.relres.toExponential(2)} after ${r.iterations} iterations)`);
          amsStats.solves++; amsStats.itSum += r.iterations; amsStats.itMin = Math.min(amsStats.itMin, r.iterations); amsStats.itMax = Math.max(amsStats.itMax, r.iterations);
          amsStats.relresMax = Math.max(amsStats.relresMax, r.relres);
        }
        return out;
      },
    };
  } : undefined;
  if (useAms) p.progress?.('solve', 0.35, `ND${order}: AMS-preconditioned CG (rtol ${amsRtol}), ${nf} free DOFs${solverReason ? `; ${solverReason}` : ''}`);
  timer.start('solve');
  const eig = shiftInvertEigen({
    pat: R.pat, K: R.val, M: Mr, sigma, nWant: p.nModes, kPsd: true,
    ...(doProject ? { project, nullDim: nH } : {}), tol: p.eigTol ?? 1e-9, blockSize: p.blockSize ?? 4, ...(p.signal ? { signal: p.signal } : {}),
    ...(sym ? { sym } : {}), ...(linearSolver ? { linearSolver } : {}),
  });
  timer.stop('solve');
  timer.add('factor', eig.stats.factorMs);
  timer.timing.solve = (timer.timing.solve ?? 0) - eig.stats.factorMs;
  timer.start('post');
  // spurious filter: lambda at or below a small fraction of the lowest physical scale is a gradient mode
  const lamScale = (Math.PI / diag) ** 2 / epsMuMax;
  const keep: number[] = [];
  const divRes: number[] = [];
  eig.lambda.forEach((l, i) => {
    const x = eig.vecs[i]!;
    const gm = gtmv(x);
    csrMatVec(R.pat, Mr, x, Mx);
    const dr = Math.sqrt(dotVec(gm, gm)) / Math.sqrt(dotVec(Mx, Mx));
    if (l > 1e-6 * lamScale) { keep.push(i); divRes.push(dr); }
  });
  const freqs = Float64Array.from(keep, (i) => (C0 * Math.sqrt(eig.lambda[i]!)) / (2 * Math.PI));
  // the AMS path computes the lowest modes (negative shift): equal to the modes closest to a study shift only when the
  // shift is at or below the lowest of them
  if (useAms && p.shiftHz && freqs.length && p.shiftHz > freqs[0]!) throw new Error(`em3d ams: the study shift ${p.shiftHz} Hz is above the lowest computed eigenfrequency ${freqs[0]!.toPrecision(6)} Hz; the AMS path finds the lowest modes only, use the direct solver for modes around an interior shift`);
  const ezFraction = new Float64Array(keep.length), azimuthalOrder = new Int32Array(keep.length);
  const fields: FieldData[] = [];
  const scalars: Solution['scalars'] = {};
  const tmp = new Float64Array(nf);
  keep.forEach((i, k) => {
    const x = eig.vecs[i]!;
    const full = new Float64Array(nDof);
    for (let r = 0; r < nf; r++) full[R.inv[r]!] = x[r]!;
    fields.push({ name: 'E', unit: 'V/m', space: order === 1 ? 'NED1' : 'NED2', components: 3, data: full, step: k });
    fields.push({ name: 'E_nodal', unit: 'V/m', space: hm.geo10 ? 'H1P2' : 'H1P1', components: 3, data: nodalFields(hm, order, space.tetDofs, full, useCurved, p.mask), step: k });
    if (p.characterize ?? true) {
      const cf = centroidFields(hm, order, space.tetDofs, full, useCurved);
      const ch = fieldCharacter(cf.E, cf.C, cf.W, p.axis?.[0] ?? 0, p.axis?.[1] ?? 0);
      ezFraction[k] = ch.ezFraction; azimuthalOrder[k] = ch.m;
    }
    scalars[`f_${k}`] = { value: freqs[k]!, unit: 'Hz' };
    if (Mtr) {
      csrMatVec(R.pat, Mtr, x, tmp);
      const lossW = dotVec(x, tmp);
      csrMatVec(R.pat, Mr, x, tmp);
      scalars[`Q_${k}`] = { value: dotVec(x, tmp) / lossW, unit: '1' };
    }
  });
  timer.stop('post');
  const nBelow = p.shiftHz && !useAms && eig.stats.nNegative !== null ? eig.stats.nNegative - (doProject ? 0 : nH) : null;
  const amsLine = useAms ? `AMS-preconditioned CG (${order === 2 ? 'p-multigrid ND2 -> ND1, ' : ''}rtol ${amsRtol}, ${amsStats.solves} solves, iterations ${amsStats.itMin}-${amsStats.itMax}, max relative residual ${amsStats.relresMax.toExponential(2)})` : '';
  const sol = await makeSolution({
    mesh, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { module: 'emw', order, nModes: p.nModes, pec: p.pec, shiftHz: p.shiftHz ?? null, mesh: mesh.hash } }),
    fields, steps: { kind: 'eigen', values: freqs, unit: 'Hz' }, scalars,
    stats: { dof: nf, nnz: R.pat.nnz, iterations: eig.stats.opApplications, residual: Math.max(0, ...keep.map((i) => eig.residual[i]!)), solver: `shift-invert block Arnoldi, ${useAms ? amsLine : `${eig.stats.factor} (supernodal)`}, gradient projection ${doProject ? 'on' : 'off'}` },
    timer,
  });
  const chkNote = eigenCheckNote(eig.stats.check);
  if (chkNote) (sol as Solution & { notes?: string[] }).notes = [...((sol as Solution & { notes?: string[] }).notes ?? []), chkNote];
  // machine-readable linear solver of the run (C5 RunRecord.solver, DevLog-060)
  sol.run.solver = useAms ? { kind: 'ams-pcg', rtol: amsRtol, iterations: amsStats.itMax, residual: amsStats.relresMax } : { kind: 'direct', rtol: null, iterations: null, residual: null };
  if (useAms || solverReason) (sol as Solution & { notes?: string[] }).notes = [...((sol as Solution & { notes?: string[] }).notes ?? []), `linear solver${solverReason ? ` (${solverReason})` : ''}: ${useAms ? `${amsLine}; setup ${amsStats.setupMs.toFixed(0)} ms, ${amsStats.itSum} PCG iterations in total; eigenvalues found below the negative shift (lowest modes), no inertia count` : 'direct'}`];
  attachMesh(sol, mesh);
  const { check: eigCheck, ...eigStats } = eig.stats;
  return Object.assign(sol, {
    detail: {
      divResidual: Float64Array.from(divRes), eigResidual: Float64Array.from(keep, (i) => eig.residual[i]!), nNull: nH,
      nBelowShift: nBelow === null ? null : nBelow - (doProject ? nH : 0), ezFraction, azimuthalOrder,
      stats: { ...eigStats, eigenCheck: eigCheck ? `${eigCheck.status}${eigCheck.reason ? `: ${eigCheck.reason}` : ''}` : 'none', nCurved, nTets: nT, nDofTotal: nDof, sigma, nNegativeRaw: eig.stats.nNegative, ...(useAms ? { amsSetupMs: amsStats.setupMs, amsSolves: amsStats.solves, amsIterations: amsStats.itSum, amsIterMax: amsStats.itMax, amsRelresMax: amsStats.relresMax, amsRtol, amsCoarse: amsStats.nCoarse, amsAux: amsStats.nAux } : {}) },
    },
  });
}

// ---------------------------------------------------------------------------------------------- C4 module

export const emwModule: PhysicsModule = {
  type: 'emw',
  dims: ['3d'],
  readiness(spec, physicsId) {
    const reasons: string[] = [];
    try {
      const p = physicsNode(spec, physicsId);
      const bad = (p.bcs ?? []).filter((b) => b.type !== 'pec' && b.type !== 'pmc');
      if (bad.length) reasons.push(`unsupported BC types: ${bad.map((b) => b.type).join(', ')} (eigen supports pec, pmc)`);
      if (spec.geometry && (spec.geometry as { dim?: number }).dim !== 3) reasons.push('emw needs a 3D geometry');
      const st = (spec.studies ?? []).filter((s) => s.physics.includes(physicsId));
      if (!st.some((s) => s.type === 'eigen')) reasons.push('no eigen study for this physics (frequency-domain driven runs not implemented)');
    } catch (e) { reasons.push((e as Error).message); }
    return { ready: reasons.length === 0, reasons };
  },
  async run(ctx: RunContext) {
    const { mask, values } = cellProps(ctx, ['eps_r']);
    const mu = optionalCellProp(ctx, 'mu_r', mask);
    for (let c = 0; c < mu.length; c++) if (mask[c] && !Number.isFinite(mu[c]!)) throw new Error('material without mu_r: emw needs mu_r on every domain (no default)');
    const td = optionalCellProp(ctx, 'tan_delta', mask);
    // no tan_delta on a domain: Q_d is not computed (no hidden lossless default; audit M2)
    const lossy = Array.from(td).some((v, c) => mask[c] && Number.isFinite(v));
    if (lossy) for (let c = 0; c < td.length; c++) if (mask[c] && !Number.isFinite(td[c]!)) throw new Error('emw: tan_delta is given on some domains but not on all; state it on every domain (no default)');
    const { nModes, shiftHz } = eigenStudy(ctx);
    const types = bcTypes(ctx.spec, ctx.physicsId);
    if (types.some((t) => t !== 'pec' && t !== 'pmc')) throw new Error('emw eigen: only pec / pmc boundaries');
    const order = ((physicsNode(ctx.spec, ctx.physicsId).settings as { order?: number } | undefined)?.order ?? 2) as 1 | 2;
    // eigen study `settings.solver` / `settings.rtol` (DevLog-054; registration requested from the coordinator)
    const ss = (ctx.study.settings ?? {}) as { solver?: unknown; rtol?: unknown };
    if (ss.solver !== undefined && ss.solver !== 'direct' && ss.solver !== 'ams' && ss.solver !== 'auto') throw new Error(`eigen study solver '${String(ss.solver)}': expected direct, ams or auto`);
    if (ss.rtol !== undefined && !(Number(ss.rtol) > 0 && Number(ss.rtol) < 1)) throw new Error(`eigen study rtol ${String(ss.rtol)}: expected 0 < rtol < 1`);
    return solveCavity({
      ...(ss.solver !== undefined ? { solver: ss.solver as 'direct' | 'ams' | 'auto' } : {}), ...(ss.rtol !== undefined ? { solverRtol: Number(ss.rtol) } : {}),
      mesh: ctx.mesh, order, epsR: values.eps_r!, muR: mu, ...(lossy ? { tanDelta: td } : {}), mask, pec: bcSelections(ctx.spec, ctx.physicsId, 'pec'),
      nModes, shiftHz, spec: ctx.spec, signal: ctx.signal, progress: ctx.progress,
    });
  },
};
