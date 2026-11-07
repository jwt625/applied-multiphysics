// SPDX-License-Identifier: GPL-3.0-or-later
// Axisymmetric Maxwell eigenmodes per azimuthal order m (C4 type 'emw-axisym', dims '2d-axisym'), on a meridional
// (r, z) tri3 mesh; the 3D field is E = (E_r(r, z) cos m phi, E_phi(r, z) sin m phi, E_z(r, z) cos m phi).
// Formulation (derived in DevLog-010 s.8.1): unknowns e_t = (E_r, E_z) in Nedelec order p and w = r E_phi in
// hierarchical Lagrange order p on the same triangles (the exact-sequence pair: grad P_p is in ND_p). With
// q = m e_t + grad w and curl_t e_t = dE_r/dz - dE_z/dr,
//   a = int (1/mu_r) [ (curl_t e_t)^2 r + |q|^2 / r ] dr dz,   b = int eps_r [ |e_t|^2 r + w^2 / r ] dr dz,
// K x = k0^2 M x (the azimuthal factor pi or 2 pi is common to both forms). The kernel {e_t = -grad(phi)/m, w = phi}
// (m >= 1) or {e_t = grad(psi), w = 0} (m = 0), i.e. the 3D gradients, is removed by an M-orthogonal projector
// built from the discrete gradient, so no spurious mode reaches the shift-invert Arnoldi. Constraints: PEC: tangential
// e_t and w = 0; axis r = 0: w = 0, and for m >= 1 also tangential e_t (E_z) = 0. Straight-sided triangles: exact for
// polygonal meridional sections (e.g. a cylinder cavity is a rectangle).

import type { Mesh, PhysicsModule, RunContext, Solution, FieldData, Spec } from '@amp/spec/types';
import { buildElementPattern, elementSlots, SparseCholesky } from '@amp/core/la/sparse';
import { csrMatMat, csrTranspose } from '@amp/core/la/amg';
import { ndBasis, h1Basis } from '@amp/core/fem/hcurl';
import { NPC, nCells, facetsOn } from '../common/mesh.ts';
import { triRule } from '../common/quad.ts';
import { restrict, type Csr } from '../common/scalar.ts';
import { shiftInvertEigen, csrMatVec } from '../common/eigen.ts';
import { StageTimer, makeSolution, attachMesh, checkAbort } from '../common/solution.ts';
import { cellProps, optionalCellProp, bcSelections, bcTypes, eigenStudy, physicsNode } from '../common/ctx.ts';

/** Speed of light in vacuum, m/s (exact, SI). */
export const C0 = 299792458;

type Term = [number, number[], number];

export interface AxisymProblem {
  mesh: Mesh;                     // tri3, axisym (r = x >= 0)
  m: number;                      // azimuthal order
  order: 1 | 2;
  epsR: Float64Array; muR: Float64Array; mask?: Uint8Array;
  pec: string[];
  nModes: number;
  shiftHz: number;
  spec?: unknown;
  signal?: AbortSignal;
}

interface Space { nV: number; nE: number; nT: number; edges: Int32Array; triV: Int32Array; triE: Int32Array; nEt: number; nW: number; nDof: number; ndl: number; dofs: Int32Array; edgeOf: Map<number, number> }

function buildSpace(mesh: Mesh, order: 1 | 2): Space {
  if (mesh.cells.type !== 'tri3') throw new Error(`emw-axisym: needs a tri3 meridional mesh, got ${mesh.cells.type}`);
  const nV = mesh.nodes.length / 2, nT = nCells(mesh);
  const triV = new Int32Array(3 * nT), triE = new Int32Array(3 * nT);
  const edgeOf = new Map<number, number>(), edges: number[] = [];
  const key = (a: number, b: number) => (a < b ? a * nV + b : b * nV + a);
  const LE = [[0, 1], [0, 2], [1, 2]] as const;   // TRI_EDGES order of hcurl
  for (let t = 0; t < nT; t++) {
    const v = [0, 1, 2].map((i) => mesh.cells.conn[3 * t + i]!).sort((a, b) => a - b);
    triV.set(v, 3 * t);
    LE.forEach(([i, j], e) => {
      const k = key(v[i]!, v[j]!);
      let id = edgeOf.get(k);
      if (id === undefined) { id = edges.length / 2; edgeOf.set(k, id); edges.push(v[i]!, v[j]!); }
      triE[3 * t + e] = id;
    });
  }
  const nE = edges.length / 2;
  // e_t dofs: Whitney per edge, (order 2) gradient per edge, 2 face functions per triangle; then w: vertices, (2) edge bubbles
  const nEt = order === 1 ? nE : 2 * nE + 2 * nT;
  const nW = order === 1 ? nV : nV + nE;
  const nle = order === 1 ? 3 : 8, nlw = order === 1 ? 3 : 6, ndl = nle + nlw;
  const dofs = new Int32Array(ndl * nT);
  for (let t = 0; t < nT; t++) {
    const o = ndl * t;
    for (let e = 0; e < 3; e++) dofs[o + e] = triE[3 * t + e]!;
    if (order === 2) { for (let e = 0; e < 3; e++) dofs[o + 3 + e] = nE + triE[3 * t + e]!; dofs[o + 6] = 2 * nE + 2 * t; dofs[o + 7] = 2 * nE + 2 * t + 1; }
    for (let i = 0; i < 3; i++) dofs[o + nle + i] = nEt + triV[3 * t + i]!;
    if (order === 2) for (let e = 0; e < 3; e++) dofs[o + nle + 3 + e] = nEt + nV + triE[3 * t + e]!;
  }
  return { nV, nE, nT, edges: Int32Array.from(edges), triV, triE, nEt, nW, nDof: nEt + nW, ndl, dofs, edgeOf };
}

/** Value (2), curl (scalar) of a 2D vector basis function, value and gradient of a scalar one, at barycentric l. */
function evalVec(fn: Term[], l: number[], g: number[][], out: number[]): void {
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (const [c, a, gi] of fn) {
    let v = c;
    for (let k = 0; k < 3; k++) if (a[k]) v *= l[k]! ** a[k]!;
    out[0]! += v * g[gi]![0]!; out[1]! += v * g[gi]![1]!;
    // curl (scalar, d/dr of z-comp - d/dz of r-comp in (r, z) = (x, y)): curl(f grad l_g) = grad f x grad l_g
    for (let k = 0; k < 3; k++) {
      if (!a[k]) continue;
      let d = c * a[k]!;
      for (let j = 0; j < 3; j++) { const p = j === k ? a[j]! - 1 : a[j]!; if (p) d *= l[j]! ** p; }
      out[2]! += d * (g[k]![0]! * g[gi]![1]! - g[k]![1]! * g[gi]![0]!);
    }
  }
}
function evalScalar(fn: Term[], l: number[], g: number[][], out: number[]): void {
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (const [c, a] of fn) {
    let v = c;
    for (let k = 0; k < 3; k++) if (a[k]) v *= l[k]! ** a[k]!;
    out[0]! += v;
    for (let k = 0; k < 3; k++) {
      if (!a[k]) continue;
      let d = c * a[k]!;
      for (let j = 0; j < 3; j++) { const p = j === k ? a[j]! - 1 : a[j]!; if (p) d *= l[j]! ** p; }
      out[1]! += d * g[k]![0]!; out[2]! += d * g[k]![1]!;
    }
  }
}

export interface AxisymDetail { m: number; ezFraction: Float64Array; eigResidual: Float64Array; nNull: number; stats: Record<string, unknown> }

export async function solveAxisymModes(p: AxisymProblem): Promise<Solution & { detail: AxisymDetail; x: Float64Array[]; space: Space }> {
  const timer = new StageTimer();
  const { mesh, order, m } = p;
  if (!mesh.axisym) throw new Error('emw-axisym: mesh must be axisymmetric (r, z)');
  timer.start('assemble');
  const sp = buildSpace(mesh, order);
  const E = ndBasis(order, 3) as Term[][], W = h1Basis(order, 3) as Term[][];
  const nle = E.length, nlw = W.length, ndl = sp.ndl;
  const pat = buildElementPattern(sp.nDof, sp.dofs, ndl) as Csr;
  const slots = elementSlots(pat, sp.dofs, ndl) as Int32Array;
  const K = new Float64Array(pat.nnz), M = new Float64Array(pat.nnz), Mz = new Float64Array(pat.nnz);
  const rule = triRule(order === 1 ? 5 : 7);
  const V = new Float64Array(ndl * 2), C = new Float64Array(ndl), S = new Float64Array(ndl), Gw = new Float64Array(ndl * 2);
  const Ke = new Float64Array(ndl * ndl), Me = new Float64Array(ndl * ndl), Mze = new Float64Array(ndl * ndl);
  const o3 = [0, 0, 0];
  for (let t = 0; t < sp.nT; t++) {
    if (p.mask && !p.mask[t]) continue;
    const v = [sp.triV[3 * t]!, sp.triV[3 * t + 1]!, sp.triV[3 * t + 2]!];
    const X = v.map((i) => [mesh.nodes[2 * i]!, mesh.nodes[2 * i + 1]!]) as [number, number][];
    const det = (X[1]![0] - X[0]![0]) * (X[2]![1] - X[0]![1]) - (X[2]![0] - X[0]![0]) * (X[1]![1] - X[0]![1]);
    const A2 = Math.abs(det);
    // barycentric gradients (constant on straight triangles)
    const g = [0, 1, 2].map((i) => { const j = (i + 1) % 3, k = (i + 2) % 3; return [(X[j]![1] - X[k]![1]) / det, (X[k]![0] - X[j]![0]) / det]; });
    const nu = 1 / p.muR[t]!, eps = p.epsR[t]!;
    Ke.fill(0); Me.fill(0); Mze.fill(0);
    for (let q = 0; q < rule.n; q++) {
      const x = rule.pts[2 * q]!, y = rule.pts[2 * q + 1]!;
      const l = [1 - x - y, x, y];
      const r = l[0]! * X[0]![0] + l[1]! * X[1]![0] + l[2]! * X[2]![0];
      const w = rule.wts[q]! * A2;
      V.fill(0); C.fill(0); S.fill(0); Gw.fill(0);
      for (let i = 0; i < nle; i++) { evalVec(E[i]!, l, g, o3); V[2 * i] = o3[0]!; V[2 * i + 1] = o3[1]!; C[i] = o3[2]!; }
      for (let i = 0; i < nlw; i++) { evalScalar(W[i]!, l, g, o3); S[nle + i] = o3[0]!; Gw[2 * (nle + i)] = o3[1]!; Gw[2 * (nle + i) + 1] = o3[2]!; }
      for (let i = 0; i < ndl; i++) {
        const qi0 = m * V[2 * i]! + Gw[2 * i]!, qi1 = m * V[2 * i + 1]! + Gw[2 * i + 1]!;
        for (let j = i; j < ndl; j++) {
          const qj0 = m * V[2 * j]! + Gw[2 * j]!, qj1 = m * V[2 * j + 1]! + Gw[2 * j + 1]!;
          Ke[i * ndl + j]! += nu * (C[i]! * C[j]! * r + (qi0 * qj0 + qi1 * qj1) / r) * w;
          Me[i * ndl + j]! += eps * ((V[2 * i]! * V[2 * j]! + V[2 * i + 1]! * V[2 * j + 1]!) * r + (S[i]! * S[j]!) / r) * w;
          Mze[i * ndl + j]! += eps * V[2 * i + 1]! * V[2 * j + 1]! * r * w;   // E_z part (TE / TM character)
        }
      }
    }
    const base = ndl * ndl * t;
    for (let i = 0; i < ndl; i++) for (let j = 0; j < ndl; j++) {
      const a = i <= j ? i * ndl + j : j * ndl + i, s = slots[base + ndl * i + j]!;
      K[s]! += Ke[a]!; M[s]! += Me[a]!; Mz[s]! += Mze[a]!;
    }
  }
  // constraints
  const free = new Uint8Array(sp.nDof).fill(1);
  const kf = NPC[mesh.facets.type];
  const fixEdge = (a: number, b: number, et: boolean, wv: boolean) => {
    const e = sp.edgeOf.get(a < b ? a * sp.nV + b : b * sp.nV + a);
    if (e === undefined) return;
    if (et) { free[e] = 0; if (order === 2) free[sp.nE + e] = 0; }
    if (wv) { free[sp.nEt + a] = 0; free[sp.nEt + b] = 0; if (order === 2) free[sp.nEt + sp.nV + e] = 0; }
  };
  for (const f of p.pec.length ? facetsOn(mesh, p.pec) : []) fixEdge(mesh.facets.conn[kf * f]!, mesh.facets.conn[kf * f + 1]!, true, true);
  let rmax = 0; for (let i = 0; i < sp.nV; i++) rmax = Math.max(rmax, mesh.nodes[2 * i]!);
  const onAxis = (i: number) => Math.abs(mesh.nodes[2 * i]!) <= 1e-12 * rmax;
  for (let e = 0; e < sp.nE; e++) { const a = sp.edges[2 * e]!, b = sp.edges[2 * e + 1]!; if (onAxis(a) && onAxis(b)) fixEdge(a, b, m >= 1, true); }
  for (let i = 0; i < sp.nV; i++) if (onAxis(i)) free[sp.nEt + i] = 0;
  const R = restrict(pat, K, free);
  const Mr = restrict(pat, M, free).val, Mzr = restrict(pat, Mz, free).val;
  const nf = R.pat.n;
  // discrete gradient G: scalar phi (vertex values, edge bubbles) -> (e_t, w): m >= 1: e_t = -grad(phi)/m, w = phi;
  // m = 0: e_t = grad(psi), w = 0. phi / psi constrained like the field (zero where the image dofs are fixed).
  const hV = new Int32Array(sp.nV).fill(-1), hE = new Int32Array(sp.nE).fill(-1);
  let nH = 0;
  const usedV = new Uint8Array(sp.nV); for (let t = 0; t < sp.nT; t++) if (!p.mask || p.mask[t]) for (let i = 0; i < 3; i++) usedV[sp.triV[3 * t + i]!] = 1;
  // a scalar dof is admissible when every field dof it maps to is free
  const edgeFreeEt = (e: number) => free[e] === 1;
  const vtxOk = (i: number) => {
    if (!usedV[i]) return false;
    if (m >= 1 && !free[sp.nEt + i]) return false;
    return true;
  };
  // a vertex value must vanish when an incident fixed edge requires zero tangential gradient: check through edges
  const vBad = new Uint8Array(sp.nV);
  for (let e = 0; e < sp.nE; e++) if (!edgeFreeEt(e)) { vBad[sp.edges[2 * e]!] = 1; vBad[sp.edges[2 * e + 1]!] = 1; }
  for (let i = 0; i < sp.nV; i++) if (vtxOk(i) && !vBad[i]) hV[i] = nH++;
  if (order === 2) for (let e = 0; e < sp.nE; e++) {
    const okEt = edgeFreeEt(e) && free[sp.nE + e] === 1;
    const okW = m === 0 || free[sp.nEt + sp.nV + e] === 1;
    if (okEt && okW) hE[e] = nH++;
  }
  const rows: Array<Array<[number, number]>> = Array.from({ length: nf }, () => []);
  const s = m === 0 ? 1 : -1 / m;
  const put = (dof: number, col: number, val: number) => { const r = R.map[dof]!; if (r >= 0 && col >= 0) rows[r]!.push([col, val]); };
  for (let e = 0; e < sp.nE; e++) {
    const a = sp.edges[2 * e]!, b = sp.edges[2 * e + 1]!;
    // Whitney coefficient of grad(phi) on edge (a < b) = phi_b - phi_a; gradient dof = edge bubble coefficient
    put(e, hV[b]!, s); put(e, hV[a]!, -s);
    if (order === 2) put(sp.nE + e, hE[e]!, s);
  }
  if (m >= 1) {
    for (let i = 0; i < sp.nV; i++) put(sp.nEt + i, hV[i]!, 1);
    if (order === 2) for (let e = 0; e < sp.nE; e++) put(sp.nEt + sp.nV + e, hE[e]!, 1);
  }
  const gRow = new Int32Array(nf + 1), gCol: number[] = [], gVal: number[] = [];
  for (let r = 0; r < nf; r++) { rows[r]!.sort((x, y) => x[0] - y[0]); for (const [c, v] of rows[r]!) { gCol.push(c); gVal.push(v); } gRow[r + 1] = gCol.length; }
  const G = { n: nf, m: nH, rowptr: gRow, colidx: Int32Array.from(gCol), val: Float64Array.from(gVal) };
  const Ah = csrMatMat(csrTranspose(G), csrMatMat({ n: nf, m: nf, rowptr: R.pat.rowptr, colidx: R.pat.colidx, val: Mr }, G));
  timer.stop('assemble');
  checkAbort(p.signal);
  timer.start('factor');
  const hChol = nH ? new SparseCholesky({ n: nH, rowptr: Ah.rowptr, colidx: Ah.colidx, nnz: Ah.colidx.length }) : null;
  if (hChol && !hChol.factor(Ah.val)) throw new Error('emw-axisym: G^T M G not positive definite');
  timer.stop('factor');
  const Mx = new Float64Array(nf), gr = new Float64Array(nH), gz = new Float64Array(nf);
  const project = (x: Float64Array) => {
    if (!hChol) return;
    csrMatVec(R.pat, Mr, x, Mx);
    gr.fill(0);
    for (let r = 0; r < nf; r++) for (let q = gRow[r]!; q < gRow[r + 1]!; q++) gr[G.colidx[q]!]! += G.val[q]! * Mx[r]!;
    const z = hChol.solve(gr, new Float64Array(nH)) as Float64Array;
    csrMatVec({ n: nf, rowptr: gRow, colidx: G.colidx, nnz: gCol.length }, G.val, z, gz);
    for (let i = 0; i < nf; i++) x[i]! -= gz[i]!;
  };
  const sigma = (2 * Math.PI * p.shiftHz / C0) ** 2;
  timer.start('solve');
  const eig = shiftInvertEigen({ pat: R.pat, K: R.val, M: Mr, sigma, nWant: p.nModes, project, tol: 1e-11, ...(p.signal ? { signal: p.signal } : {}) });
  timer.stop('solve');
  timer.add('factor', eig.stats.factorMs);
  timer.timing.solve = (timer.timing.solve ?? 0) - eig.stats.factorMs;
  timer.start('post');
  const keep = Array.from(eig.lambda, (l, i) => [l, i] as const).filter(([l]) => l > 1e-8 * sigma).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const freqs = Float64Array.from(keep, (i) => (C0 * Math.sqrt(eig.lambda[i]!)) / (2 * Math.PI));
  const ezFraction = new Float64Array(keep.length);
  const xs: Float64Array[] = [];
  const fields: FieldData[] = [];
  const scalars: Solution['scalars'] = {};
  const tmp = new Float64Array(nf);
  keep.forEach((i, k) => {
    const x = eig.vecs[i]!;
    csrMatVec(R.pat, Mzr, x, tmp); let ez = 0; for (let r = 0; r < nf; r++) ez += x[r]! * tmp[r]!;
    csrMatVec(R.pat, Mr, x, tmp); let tot = 0; for (let r = 0; r < nf; r++) tot += x[r]! * tmp[r]!;
    ezFraction[k] = ez / tot;
    const full = new Float64Array(sp.nDof);
    for (let r = 0; r < nf; r++) full[R.inv[r]!] = x[r]!;
    xs.push(full);
    const nod = nodalFields(mesh, sp, order, full);
    fields.push({ name: 'E_rphiz', unit: 'V/m', space: 'H1P1', components: 3, data: nod, step: k });
    scalars[`f_${k}`] = { value: freqs[k]!, unit: 'Hz' };
    scalars[`ezFraction_${k}`] = { value: ezFraction[k]!, unit: '1' };
  });
  scalars.m = { value: m, unit: '1' };
  timer.stop('post');
  const sol = await makeSolution({
    mesh, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { module: 'emw-axisym', m, order, nModes: p.nModes, shiftHz: p.shiftHz, mesh: mesh.hash } }),
    fields, steps: { kind: 'eigen', values: freqs, unit: 'Hz' }, scalars,
    stats: { dof: nf, nnz: R.pat.nnz, iterations: eig.stats.opApplications, residual: Math.max(0, ...keep.map((i) => eig.residual[i]!)), solver: `axisym m=${m}: shift-invert block Arnoldi, ${eig.stats.factor}, gradient projection` },
    timer,
  });
  attachMesh(sol, mesh);
  return Object.assign(sol, { detail: { m, ezFraction, eigResidual: Float64Array.from(keep, (i) => eig.residual[i]!), nNull: nH, stats: { ...eig.stats } }, x: xs, space: sp });
}

/**
 * Nodal (E_r, E_phi, E_z) of the meridional field at the mesh vertices (averaged over the triangles sharing a vertex;
 * E_phi = w / r, on the axis the limit dw/dr). 3 components per vertex.
 */
function nodalFields(mesh: Mesh, sp: Space, order: 1 | 2, x: Float64Array): Float64Array {
  const E = ndBasis(order, 3) as Term[][], W = h1Basis(order, 3) as Term[][];
  const nle = E.length, out = new Float64Array(3 * sp.nV), cnt = new Float64Array(sp.nV), o3 = [0, 0, 0];
  for (let t = 0; t < sp.nT; t++) {
    const v = [sp.triV[3 * t]!, sp.triV[3 * t + 1]!, sp.triV[3 * t + 2]!];
    const X = v.map((i) => [mesh.nodes[2 * i]!, mesh.nodes[2 * i + 1]!]) as [number, number][];
    const det = (X[1]![0] - X[0]![0]) * (X[2]![1] - X[0]![1]) - (X[2]![0] - X[0]![0]) * (X[1]![1] - X[0]![1]);
    const g = [0, 1, 2].map((i) => { const j = (i + 1) % 3, k = (i + 2) % 3; return [(X[j]![1] - X[k]![1]) / det, (X[k]![0] - X[j]![0]) / det]; });
    for (let c = 0; c < 3; c++) {
      const l = [0, 0, 0]; l[c] = 1;
      let er = 0, ez = 0, w = 0, dwr = 0;
      for (let i = 0; i < nle; i++) { const xi = x[sp.dofs[sp.ndl * t + i]!]!; if (!xi) continue; evalVec(E[i]!, l, g, o3); er += xi * o3[0]!; ez += xi * o3[1]!; }
      for (let i = 0; i < W.length; i++) { const xi = x[sp.dofs[sp.ndl * t + nle + i]!]!; if (!xi) continue; evalScalar(W[i]!, l, g, o3); w += xi * o3[0]!; dwr += xi * o3[1]!; }
      const r = X[c]![0];
      const n = v[c]!;
      out[3 * n]! += er; out[3 * n + 1]! += r > 0 ? w / r : dwr; out[3 * n + 2]! += ez; cnt[n]!++;
    }
  }
  for (let n = 0; n < sp.nV; n++) if (cnt[n]) for (let d = 0; d < 3; d++) out[3 * n + d]! /= cnt[n]!;
  return out;
}

/** 3D Cartesian E at a point from meridional (E_r, E_phi, E_z) of azimuthal order m (cos / sin m phi parity). */
export function reconstruct3D(m: number, Erphiz: ArrayLike<number>, p: ArrayLike<number>): [number, number, number] {
  const phi = Math.atan2(p[1]!, p[0]!), c = Math.cos(phi), s = Math.sin(phi);
  const er = Erphiz[0]! * Math.cos(m * phi), ep = Erphiz[1]! * Math.sin(m * phi), ez = Erphiz[2]! * Math.cos(m * phi);
  return [er * c - ep * s, er * s + ep * c, ez];
}

// ------------------------------------------------------------------------------------------------- spec binding

export const emwAxisymModule: PhysicsModule = {
  type: 'emw-axisym',
  dims: ['2d-axisym'],
  readiness(spec, physicsId) {
    const reasons: string[] = [];
    try {
      const ph = physicsNode(spec as Spec, physicsId);
      for (const b of ph.bcs ?? []) if (b.type !== 'pec') reasons.push(`unsupported BC type '${b.type}' (pec only; other boundaries are PMC)`);
      const s = (ph.settings ?? {}) as { azimuthal?: number[] };
      if (!s.azimuthal?.length) reasons.push('settings.azimuthal (list of azimuthal orders m) is required');
      const st = ((spec as Spec).studies ?? []).filter((x) => (x as { physics?: string[] }).physics?.includes(physicsId));
      if (!st.some((x) => x.type === 'eigen')) reasons.push('no eigen study');
    } catch (e) { reasons.push((e as Error).message); }
    return { ready: !reasons.length, reasons };
  },
  async run(ctx: RunContext) {
    const { mask, values } = cellProps(ctx, ['eps_r']);
    const mu = optionalCellProp(ctx, 'mu_r', mask);
    for (let c = 0; c < mu.length; c++) if (mask[c] && !Number.isFinite(mu[c]!)) throw new Error('emw-axisym: mu_r required on every domain');
    const { nModes, shiftHz } = eigenStudy(ctx);
    if (shiftHz === null) throw new Error('emw-axisym: eigen study needs a shift (Hz)');
    if (bcTypes(ctx.spec, ctx.physicsId).some((t) => t !== 'pec')) throw new Error('emw-axisym: pec only');
    const s = (physicsNode(ctx.spec, ctx.physicsId).settings ?? {}) as { azimuthal: number[]; order?: 1 | 2 };
    let mesh = ctx.mesh;
    if (mesh.cells.type === 'tri6') mesh = toTri3(mesh);
    const runs = [];
    for (const m of s.azimuthal) runs.push(await solveAxisymModes({ mesh, m, order: s.order ?? 2, epsR: values.eps_r!, muR: mu, mask, pec: bcSelections(ctx.spec, ctx.physicsId, 'pec'), nModes, shiftHz, spec: ctx.spec, signal: ctx.signal }));
    // merge: steps sorted over all m, scalars f_<k>, m_<k>, ezFraction_<k>
    const all = runs.flatMap((r) => Array.from(r.steps!.values, (f, k) => ({ f, m: r.detail.m, ez: r.detail.ezFraction[k]!, field: r.fields[k]! })));
    all.sort((a, b) => a.f - b.f);
    const sol = runs[0]!;
    const timing: Record<string, number> = {};
    for (const r of runs) for (const [k, v] of Object.entries(r.timing)) timing[k] = (timing[k] ?? 0) + v;
    const scalars: Solution['scalars'] = {};
    all.forEach((a, k) => { scalars[`f_${k}`] = { value: a.f, unit: 'Hz' }; scalars[`m_${k}`] = { value: a.m, unit: '1' }; scalars[`ezFraction_${k}`] = { value: a.ez, unit: '1' }; });
    const out: Solution = { ...sol, fields: all.map((a, k) => ({ ...a.field, step: k })), steps: { kind: 'eigen', values: Float64Array.from(all, (a) => a.f), unit: 'Hz' }, scalars, timing,
      stats: { ...sol.stats, dof: runs.reduce((s2, r) => s2 + r.stats.dof, 0), solver: `axisym per m (${s.azimuthal.join(', ')})` } };
    attachMesh(out, mesh);
    return out;
  },
};

/** tri6 -> tri3 (corner nodes; straight edges): the axisym ND solver uses straight triangles. */
function toTri3(m: Mesh): Mesh {
  const nT = nCells(m), conn = new Int32Array(3 * nT);
  for (let t = 0; t < nT; t++) for (let i = 0; i < 3; i++) conn[3 * t + i] = m.cells.conn[6 * t + i]!;
  const kf = 3, nF = m.facets.conn.length / kf, fc = new Int32Array(2 * nF);
  for (let f = 0; f < nF; f++) { fc[2 * f] = m.facets.conn[kf * f]!; fc[2 * f + 1] = m.facets.conn[kf * f + 1]!; }
  return { ...m, cells: { ...m.cells, type: 'tri3', conn }, facets: { ...m.facets, type: 'line2', conn: fc } };
}
