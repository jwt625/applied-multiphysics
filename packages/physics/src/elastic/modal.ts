// SPDX-License-Identifier: GPL-3.0-or-later
// Solid modal analysis (C4 type 'elastic', eigen study; lane MT, DevLog-033): K u = omega^2 M u with the consistent
// mass M = int rho u . v dV, plane stress / plane strain (per unit thickness), 3D, and axisymmetric (r, z) meshes
// (azimuthal order 0: torsion-free axisymmetric modes only; weight r, per radian). Lagrange P1 / P2 (tri6 / tet10
// default). Constraints: fixed, roller, displacement (homogeneous in eigen); loads and thermal strain do not enter
// the eigenproblem (no prestress stiffening). Free bodies keep their rigid-body modes (f = 0 when |lambda| is below
// 1e-8 of the spectral scale); a positive study `shift` (Hz) selects the modes closest to it instead.
// Shift-invert block Arnoldi on common/eigen.ts (Cholesky of K - sigma M below the spectrum, LDL^T for a shift).

import type { Mesh, Solution, FieldData } from '@amp/spec/types';
import { NPC, nCells, nNodes } from '../common/mesh.ts';
import { cellOrder, restrict, type Csr } from '../common/scalar.ts';
import { defaultRule, gatherX, physGrad, shapeTable } from '../common/lagrange.ts';
import { shiftInvertEigen } from '../common/eigen.ts';
import { StageTimer, makeSolution, attachMesh } from '../common/solution.ts';
import { dofPattern, isoD, scatter, solidConstraints, strainB, voigtSize, type DofMap, type SolidModel } from '../coupled/assemble.ts';
import type { ElasticProblem } from './index.ts';

/** Eigenvector normalisation of the elastic eigen study (C5 `normalization`; MC merges it into NORMALIZATION). */
export const ELASTIC_MODAL_NORMALIZATION =
  'u per mode is M-orthonormal: int rho u . u dV = 1 (SI numbers, kg m^2; 2D per unit thickness, axisym per radian); arbitrary sign';

export interface SolidAssemblyInput {
  mesh: Mesh; model: SolidModel;
  /** cells taking part */
  mask: Uint8Array;
  /** constitutive matrix of cell e (nv x nv, Voigt order of the model) */
  D: (e: number) => Float64Array;
  /** density per cell (kg/m^3); omit for no mass matrix */
  rho?: Float64Array;
  /** global DOF of (node, component): uDof[node * dim + c], -1 = not a DOF */
  uDof: Int32Array;
  pat: Csr;
  K: Float64Array;
  M?: Float64Array;
  /** load vector over global DOFs (body force, thermal strain) */
  F?: Float64Array;
  body?: Float64Array;
  /** thermal strain: eps_th(e, dT) in Voigt order, nodal T, Tref */
  thermal?: { eps: (e: number, dT: number) => Float64Array; T: Float64Array; Tref: number };
}

/** Volume assembly of the solid stiffness (and mass, body force, thermal load) into the given pattern. */
export function assembleSolid(o: SolidAssemblyInput): void {
  const m = o.mesh, dim = m.dim, k = NPC[m.cells.type], nc = nCells(m), nd = k * dim, nv = voigtSize(o.model);
  const axi = o.model === 'axisym';
  const r = defaultRule(m.cells.type, 2 * cellOrder(m) + (axi ? 1 : 0));
  const t = shapeTable(m.cells.type, r);
  const X = new Float64Array(nd), G = new Float64Array(nd), B = new Float64Array(nv * nd), DB = new Float64Array(nv * nd);
  const Ke = new Float64Array(nd * nd), Me = new Float64Array(nd * nd), Fe = new Float64Array(nd);
  const dofs = new Int32Array(nd);
  for (let e = 0; e < nc; e++) {
    if (!o.mask[e]) continue;
    const D = o.D(e);
    gatherX(m.nodes, dim, m.cells.conn, e, k, X);
    Ke.fill(0); Me.fill(0); Fe.fill(0);
    const rho = o.rho ? o.rho[e]! : 0;
    for (let q = 0; q < r.n; q++) {
      let w = physGrad(t, q, X, dim, G) * r.wts[q]!;
      const N = t.N.subarray(q * k, q * k + k);
      let rr = 0;
      if (axi) { for (let a = 0; a < k; a++) rr += N[a]! * X[2 * a]!; w *= rr; }
      strainB(o.model, G, N, rr, k, B);
      for (let i = 0; i < nv; i++) for (let j = 0; j < nd; j++) { let s = 0; for (let l = 0; l < nv; l++) s += D[nv * i + l]! * B[l * nd + j]!; DB[i * nd + j] = s; }
      for (let a = 0; a < nd; a++) for (let b = a; b < nd; b++) { let s = 0; for (let l = 0; l < nv; l++) s += B[l * nd + a]! * DB[l * nd + b]!; Ke[a * nd + b]! += s * w; }
      if (o.M && rho) for (let a = 0; a < k; a++) for (let b = a; b < k; b++) { const v = rho * N[a]! * N[b]! * w; for (let d = 0; d < dim; d++) Me[(dim * a + d) * nd + dim * b + d]! += v; }
      if (o.F && o.body) for (let a = 0; a < k; a++) for (let d = 0; d < dim; d++) Fe[dim * a + d]! += o.body[dim * e + d]! * N[a]! * w;
      if (o.F && o.thermal) {
        let T = 0; for (let a = 0; a < k; a++) T += N[a]! * o.thermal.T[m.cells.conn[k * e + a]!]!;
        const ev = o.thermal.eps(e, T - o.thermal.Tref);
        for (let a = 0; a < nd; a++) { let s = 0; for (let l = 0; l < nv; l++) s += DB[l * nd + a]! * ev[l]!; Fe[a]! += s * w; }
      }
    }
    for (let a = 0; a < nd; a++) for (let b = 0; b < a; b++) { Ke[a * nd + b] = Ke[b * nd + a]!; Me[a * nd + b] = Me[b * nd + a]!; }
    for (let a = 0; a < k; a++) { const v = m.cells.conn[k * e + a]!; for (let d = 0; d < dim; d++) dofs[dim * a + d] = o.uDof[dim * v + d]!; }
    scatter(o.pat, o.K, dofs, Ke, nd);
    if (o.M) scatter(o.pat, o.M, dofs, Me, nd);
    if (o.F) for (let a = 0; a < nd; a++) if (dofs[a]! >= 0) o.F[dofs[a]!]! += Fe[a]!;
  }
}

/** Identity DOF map over the nodes of the masked cells (node * dim + c), and the active-node flags. */
export function solidDofMap(m: Mesh, mask: Uint8Array): { dm: DofMap; active: Uint8Array } {
  const dim = m.dim, k = NPC[m.cells.type], nn = nNodes(m), nc = nCells(m);
  const active = new Uint8Array(nn);
  for (let e = 0; e < nc; e++) if (mask[e]) for (let a = 0; a < k; a++) active[m.cells.conn[k * e + a]!] = 1;
  const map = new Int32Array(nn * dim).fill(-1);
  for (let v = 0; v < nn; v++) if (active[v]) for (let d = 0; d < dim; d++) map[dim * v + d] = dim * v + d;
  return { dm: { nComp: dim, map, n: nn * dim }, active };
}

/** Spectral scale (omega^2, rad^2/s^2) from the bounding box and the fastest wave speed sqrt(max D_ii / rho). */
export function solidLambdaScale(m: Mesh, mask: Uint8Array, D: (e: number) => Float64Array, rho: Float64Array, nv: number): number {
  const dim = m.dim, nn = nNodes(m), nc = nCells(m);
  let diag2 = 0, c2 = 0;
  for (let d = 0; d < dim; d++) { let lo = Infinity, hi = -Infinity; for (let i = 0; i < nn; i++) { const x = m.nodes[dim * i + d]!; lo = Math.min(lo, x); hi = Math.max(hi, x); } diag2 += (hi - lo) ** 2; }
  for (let e = 0; e < nc; e++) if (mask[e]) { const De = D(e); for (let i = 0; i < nv; i++) c2 = Math.max(c2, De[nv * i + i]! / rho[e]!); }
  return (Math.PI ** 2 * c2) / diag2;
}

export interface ModalProblem extends ElasticProblem {
  rho: Float64Array;
  nModes: number;
  shiftHz?: number | null;
  signal?: AbortSignal;
}

export async function solveElasticModes(p: ModalProblem): Promise<Solution & { detail: { eigResidual: Float64Array; stats: Record<string, unknown> } }> {
  const timer = new StageTimer();
  const m = p.mesh, dim = m.dim, nn = nNodes(m), model = p.model as SolidModel;
  if ((dim === 3) !== (model === '3d')) throw new Error(`elastic: model ${model} on a ${dim}D mesh`);
  if ((model === 'axisym') !== !!m.axisym) throw new Error(`elastic: model ${model} on a ${m.axisym ? 'axisymmetric' : 'planar'} mesh`);
  const mask = p.mask ?? Uint8Array.from(p.E, (v) => (Number.isFinite(v) ? 1 : 0));
  const nc = nCells(m);
  for (let e = 0; e < nc; e++) if (mask[e] && !(p.rho[e]! > 0)) throw new Error(`elastic eigen: density missing or not positive on cell ${e}`);
  const nv = voigtSize(model);
  const Dcache = new Map<string, Float64Array>();
  const D = (e: number) => { const key = `${p.E[e]},${p.nu[e]}`; let v = Dcache.get(key); if (!v) { v = isoD(model, p.E[e]!, p.nu[e]!); Dcache.set(key, v); } return v; };
  timer.start('assemble');
  const { dm, active } = solidDofMap(m, mask);
  const pat = dofPattern(m, dm);
  const K = new Float64Array(pat.nnz), M = new Float64Array(pat.nnz);
  assembleSolid({ mesh: m, model, mask, D, rho: p.rho, uDof: dm.map, pat, K, M });
  const { fixed } = solidConstraints(m, model, p.bcs as Parameters<typeof solidConstraints>[2]);
  const free = new Uint8Array(nn * dim);
  for (let v = 0; v < nn; v++) if (active[v]) for (let d = 0; d < dim; d++) free[dim * v + d] = fixed[dim * v + d] ? 0 : 1;
  const R = restrict(pat, K, free);
  const Mr = restrict(pat, M, free).val;
  timer.stop('assemble');
  const lamScale = solidLambdaScale(m, mask, D, p.rho, nv);
  const positive = !!p.shiftHz && p.shiftHz > 0;
  const sigma = positive ? (2 * Math.PI * p.shiftHz!) ** 2 : -0.01 * lamScale;
  timer.start('solve');
  const eig = shiftInvertEigen({ pat: R.pat, K: R.val, M: Mr, sigma, nWant: p.nModes, kPsd: true, tol: 1e-10, ...(p.signal ? { signal: p.signal } : {}) });
  timer.stop('solve');
  timer.add('factor', eig.stats.factorMs);
  timer.timing.solve = (timer.timing.solve ?? 0) - eig.stats.factorMs;
  timer.start('post');
  const freqs = Float64Array.from(eig.lambda, (l) => (Math.abs(l) < 1e-8 * lamScale ? 0 : Math.sign(l) * Math.sqrt(Math.abs(l)) / (2 * Math.PI)));
  const space = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
  const fields: FieldData[] = [];
  const scalars: Solution['scalars'] = {};
  eig.vecs.forEach((x, i) => {
    const u = new Float64Array(nn * dim);
    for (let r = 0; r < R.pat.n; r++) u[R.inv[r]!] = x[r]!;
    fields.push({ name: 'u', unit: 'm', space, components: dim as 2 | 3, data: u, step: i });
    scalars[`f_${i}`] = { value: freqs[i]!, unit: 'Hz' };
  });
  timer.stop('post');
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { module: 'elastic-modal', model, nModes: p.nModes, shiftHz: p.shiftHz ?? null, bcs: p.bcs.map((b) => b.type), mesh: m.hash } }),
    fields, steps: { kind: 'eigen', values: freqs, unit: 'Hz' }, scalars,
    stats: { dof: R.pat.n, nnz: R.pat.nnz, iterations: eig.stats.opApplications, residual: Math.max(0, ...eig.residual), solver: `shift-invert block Arnoldi, ${eig.stats.factor} (supernodal)` },
    timer,
  });
  attachMesh(sol, m);
  (sol as Solution & { normalization?: string }).normalization = ELASTIC_MODAL_NORMALIZATION;
  return Object.assign(sol, { detail: { eigResidual: eig.residual, stats: { ...eig.stats, sigma, lamScale } } });
}
