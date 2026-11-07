// SPDX-License-Identifier: GPL-3.0-or-later
// Acoustic-structure eigenfrequencies, monolithic u-p (lane MT, DevLog-033; coupling type 'acoustic-structure',
// elastic -> acoustics). Unsymmetric u-p formulation (e.g. Zienkiewicz-Bettess; Everstine 1981 discusses the
// symmetric alternatives), with the acoustics module's scaling of the fluid:
//   K_s u - C p = lambda M_s u,      K_f p = lambda (M_f p + C^T u),      lambda = omega^2,
//   K_f = int (1/rho_f) grad p . grad w,  M_f = int p w / (rho_f c^2),  C = int_Gamma N_u n_f N_p dS,
// n_f = outward normal of the fluid on the wet interface Gamma (faces shared by a solid and a fluid cell). The fluid
// load on the solid is the traction -p n_s = p n_f; the fluid boundary condition is (1/rho_f) dp/dn_f = omega^2 u . n_f.
// Solved in (u, q = -p): K' = [[K_s, C], [0, K_f]], M' = [[M_s, 0], [-C^T, M_f]], whose shifted matrix scaled by
// 1 / sigma on the fluid rows is symmetric [[K_s - sigma M_s, C], [C^T, (K_f - sigma M_f) / sigma]] (quasi-definite
// for sigma < 0), factored by LDL^T; eigenvalues by block Arnoldi on the unsymmetric operator (coupled/eigen-ns.ts).
// Solid: plane stress / plane strain / 3D / axisym (fluid then axisymmetric too, weight r). Fluid walls off the
// interface: sound-hard (natural) or p = 0. Each closed fluid region (no p = 0) gives one f = 0 mode: at lambda = 0
// the pencil only asks K_f p = 0 (p uniform per region) and K_s u = C p (static deformation); for lambda != 0 the
// fluid rows tested with w = 1 give mean(p) / (rho c^2) = -dV / V, the cavity compressibility, so the non-zero modes
// are exact (DevLog-033, membrane-air).

import type { Mesh, Solution, FieldData } from '@amp/spec/types';
import { NPC, facetNodes, facetsOn, nCells, nNodes } from '../common/mesh.ts';
import { assembleCells, cellOrder, cellPattern, facetTable } from '../common/scalar.ts';
import { facetJac, gatherX } from '../common/lagrange.ts';
import { StageTimer, makeSolution, attachMesh, scalar } from '../common/solution.ts';
import { dofPattern, isoD, slotOf, solidConstraints, sharedFaces, csrMv, voigtSize, type SolidModel, type SolidBc } from './assemble.ts';
import { assembleSolid, solidLambdaScale } from '../elastic/modal.ts';
import { shiftInvertEigenNs } from './eigen-ns.ts';

export const FSI_NORMALIZATION =
  'per mode: int rho_s u . u dV + int p^2 / (rho_f c^2 omega^2) dV = 1 (SI numbers, kg m^2; 2D per unit thickness, axisym per radian; the fluid term is dropped for omega = 0); arbitrary sign';

export interface FsiProblem {
  mesh: Mesh;
  model: SolidModel;
  solid: Uint8Array;
  fluid: Uint8Array;
  /** solid E, nu, rho per cell (NaN outside the solid) */
  E: Float64Array; nu: Float64Array; rhoS: Float64Array;
  /** fluid speed of sound and density per cell (NaN outside the fluid) */
  c: Float64Array; rhoF: Float64Array;
  solidBcs: SolidBc[];
  pressureZero?: string[];
  nModes: number;
  shiftHz?: number | null;
  spec?: unknown;
  signal?: AbortSignal;
  tags?: { u: string; p: string };
  /** debugging / tests: return the assembled pencil (detail.pat, K, M, isFluid, map) without solving */
  assembleOnly?: boolean;
}

export async function solveAcousticStructure(p: FsiProblem): Promise<Solution & { detail: Record<string, unknown> }> {
  const timer = new StageTimer();
  const m = p.mesh, dim = m.dim, k = NPC[m.cells.type], nn = nNodes(m), nc = nCells(m), nComp = dim + 1, axi = p.model === 'axisym';
  if ((dim === 3) !== (p.model === '3d')) throw new Error(`acoustic-structure: model ${p.model} on a ${dim}D mesh`);
  if (axi !== !!m.axisym) throw new Error(`acoustic-structure: model ${p.model} on a ${m.axisym ? 'axisymmetric' : 'planar'} mesh`);
  for (let e = 0; e < nc; e++) if (p.solid[e] && p.fluid[e]) throw new Error(`acoustic-structure: cell ${e} is in both the solid and the fluid selection`);
  timer.start('assemble');
  const hasU = new Uint8Array(nn), hasP = new Uint8Array(nn);
  for (let e = 0; e < nc; e++) for (let a = 0; a < k; a++) { const v = m.cells.conn[k * e + a]!; if (p.solid[e]) hasU[v] = 1; if (p.fluid[e]) hasP[v] = 1; }
  const sc = solidConstraints(m, p.model, p.solidBcs as Parameters<typeof solidConstraints>[2]);
  const pZero = new Uint8Array(nn);
  if (p.pressureZero?.length) for (const v of facetNodes(m, facetsOn(m, p.pressureZero))) pZero[v] = 1;
  const map = new Int32Array(nn * nComp).fill(-1), fluidRow: number[] = [];
  let n = 0;
  for (let v = 0; v < nn; v++) {
    if (hasU[v]) for (let d = 0; d < dim; d++) if (!sc.fixed[dim * v + d]) map[nComp * v + d] = n++;
    if (hasP[v] && !pZero[v]) { map[nComp * v + dim] = n; fluidRow.push(n); n++; }
  }
  const isFluid = new Uint8Array(n); for (const i of fluidRow) isFluid[i] = 1;
  const pat = dofPattern(m, { nComp, map, n });
  const K = new Float64Array(pat.nnz), M = new Float64Array(pat.nnz);
  // solid blocks
  const uDof = new Int32Array(nn * dim).fill(-1);
  for (let v = 0; v < nn; v++) for (let d = 0; d < dim; d++) uDof[dim * v + d] = map[nComp * v + d]!;
  const Dc = new Map<string, Float64Array>();
  const D = (e: number) => { const key = `${p.E[e]},${p.nu[e]}`; let v = Dc.get(key); if (!v) { v = isoD(p.model, p.E[e]!, p.nu[e]!); Dc.set(key, v); } return v; };
  assembleSolid({ mesh: m, model: p.model, mask: p.solid, D, rho: p.rhoS, uDof, pat, K, M });
  // fluid blocks (K' qq = K_f, M' qq = M_f)
  const kf = new Float64Array(nc), mf = new Float64Array(nc);
  for (let e = 0; e < nc; e++) if (p.fluid[e]) {
    const rho = p.rhoF[e]!, c = p.c[e]!;
    if (!(rho > 0) || !(c > 0)) throw new Error(`acoustic-structure: fluid density / speed of sound missing on cell ${e}`);
    kf[e] = 1 / rho; mf[e] = 1 / (rho * c * c);
  }
  const A = assembleCells(m, { k: kf, m: mf, mask: p.fluid, weight: axi ? 'r' : 'none' });
  const np = cellPattern(m);
  for (let i = 0; i < nn; i++) {
    const gi = map[nComp * i + dim]!;
    if (gi < 0) continue;
    for (let z = np.rowptr[i]!; z < np.rowptr[i + 1]!; z++) {
      const gj = map[nComp * np.colidx[z]! + dim]!;
      if (gj < 0) continue;
      const s = slotOf(pat, gi, gj);
      K[s]! += A.K![z]!; M[s]! += A.M![z]!;
    }
  }
  // interface coupling: K' uq += C, M' qu -= C^T
  const faces = sharedFaces(m, p.solid, p.fluid);
  const tf = facetTable(m, 2 * cellOrder(m) + 2), kfn = tf.nn;
  if (kfn !== faces.nper) throw new Error('acoustic-structure: facet type does not match the cell faces');
  const Xf = new Float64Array(kfn * dim), nrm = new Float64Array(dim), P = new Float64Array(dim), cen = new Float64Array(dim);
  const nFaces = faces.cellB.length;
  let wetArea = 0;
  for (let f = 0; f < nFaces; f++) {
    const nodes = faces.nodes.subarray(f * kfn, (f + 1) * kfn);
    for (let a = 0; a < kfn; a++) for (let d = 0; d < dim; d++) Xf[dim * a + d] = m.nodes[dim * nodes[a]! + d]!;
    const cf = faces.cellB[f]!;
    cen.fill(0);
    for (let a = 0; a < k; a++) for (let d = 0; d < dim; d++) cen[d]! += m.nodes[dim * m.cells.conn[k * cf + a]! + d]! / k;
    for (let q = 0; q < tf.rule.n; q++) {
      let w = facetJac(tf, q, Xf, dim, nrm) * tf.rule.wts[q]!;
      P.fill(0);
      for (let a = 0; a < kfn; a++) for (let d = 0; d < dim; d++) P[d]! += tf.N[q * kfn + a]! * Xf[dim * a + d]!;
      if (axi) w *= P[0]!;
      let dot = 0; for (let d = 0; d < dim; d++) dot += nrm[d]! * (P[d]! - cen[d]!);
      if (dot < 0) for (let d = 0; d < dim; d++) nrm[d] = -nrm[d]!;   // outward from the fluid
      wetArea += w;
      for (let a = 0; a < kfn; a++) for (let b = 0; b < kfn; b++) {
        const gq = map[nComp * nodes[b]! + dim]!;
        if (gq < 0) continue;
        const v0 = tf.N[q * kfn + a]! * tf.N[q * kfn + b]! * w;
        for (let d = 0; d < dim; d++) {
          const gu = map[nComp * nodes[a]! + d]!;
          if (gu < 0) continue;
          const v = v0 * nrm[d]!;
          K[slotOf(pat, gu, gq)]! += v;
          M[slotOf(pat, gq, gu)]! -= v;
        }
      }
    }
  }
  // closed fluid regions (connected through shared nodes, no p = 0 node): each adds one f = 0 pair of the u-p form
  const par = Int32Array.from({ length: nn }, (_, i) => i);
  const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]!]!; i = par[i]!; } return i; };
  for (let e = 0; e < nc; e++) if (p.fluid[e]) { const r0 = find(m.cells.conn[k * e]!); for (let a = 1; a < k; a++) { const r1 = find(m.cells.conn[k * e + a]!); if (r1 !== r0) par[r1] = r0; } }
  const open = new Set<number>(), roots = new Set<number>();
  for (let v = 0; v < nn; v++) if (hasP[v]) { roots.add(find(v)); if (pZero[v]) open.add(find(v)); }
  const closedRegions = [...roots].filter((r) => !open.has(r)).length;
  timer.stop('assemble');
  if (p.assembleOnly) return Object.assign({} as Solution, { detail: { pat, K, M, isFluid, map, n } });
  // spectral scale and shift
  const lamS = solidLambdaScale(m, p.solid, D, p.rhoS, voigtSize(p.model));
  let cmax = 0; for (let e = 0; e < nc; e++) if (p.fluid[e]) cmax = Math.max(cmax, p.c[e]!);
  let diag2 = 0;
  for (let d = 0; d < dim; d++) { let lo = Infinity, hi = -Infinity; for (let v = 0; v < nn; v++) { const x = m.nodes[dim * v + d]!; lo = Math.min(lo, x); hi = Math.max(hi, x); } diag2 += (hi - lo) ** 2; }
  const lamScale = Math.max(lamS, (Math.PI * cmax) ** 2 / diag2);
  const sigma = p.shiftHz && p.shiftHz > 0 ? (2 * Math.PI * p.shiftHz) ** 2 : -0.01 * lamScale;
  timer.start('solve');
  const eig = shiftInvertEigenNs({ pat, K, M, rowScale: (sg) => Float64Array.from(isFluid, (f) => (f ? 1 / sg : 1)), sigma, nWant: p.nModes, tol: 1e-10, ...(p.signal ? { signal: p.signal } : {}) });
  timer.stop('solve');
  timer.add('factor', eig.stats.factorMs);
  timer.timing.solve = (timer.timing.solve ?? 0) - eig.stats.factorMs;
  timer.start('post');
  const freqs = Float64Array.from(eig.lambda, (l) => (Math.abs(l) < 1e-8 * lamScale ? 0 : Math.sign(l) * Math.sqrt(Math.abs(l)) / (2 * Math.PI)));
  const space = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
  const fields: FieldData[] = [], scalars: Solution['scalars'] = {};
  const Ms = new Float64Array(pat.nnz), Mf = new Float64Array(pat.nnz);
  for (let i = 0; i < n; i++) for (let z = pat.rowptr[i]!; z < pat.rowptr[i + 1]!; z++) { const j = pat.colidx[z]!; if (!isFluid[i] && !isFluid[j]) Ms[z] = M[z]!; else if (isFluid[i] && isFluid[j]) Mf[z] = M[z]!; }
  const y = new Float64Array(n);
  const uShare: number[] = [];
  eig.vecs.forEach((x, i) => {
    const lam = eig.lambda[i]!;
    let us = 0, qs = 0;
    csrMv(pat, Ms, x, y); for (let j = 0; j < n; j++) us += x[j]! * y[j]!;
    csrMv(pat, Mf, x, y); for (let j = 0; j < n; j++) qs += x[j]! * y[j]!;
    const fl = freqs[i]! > 0 ? qs / lam : 0;
    const nm = Math.sqrt(us + fl) || 1;
    uShare.push(us / (us + fl || 1));
    const u = new Float64Array(nn * dim), pr = new Float64Array(nn).fill(NaN);
    for (let v = 0; v < nn; v++) {
      for (let d = 0; d < dim; d++) { const g = map[nComp * v + d]!; if (g >= 0) u[dim * v + d] = x[g]! / nm; }
      if (hasP[v]) { const g = map[nComp * v + dim]!; pr[v] = g >= 0 ? -x[g]! / nm : 0; }
    }
    fields.push({ name: 'u', unit: 'm', space, components: dim as 2 | 3, data: u, step: i, ...(p.tags ? { physics: p.tags.u } : {}) });
    fields.push({ name: 'p', unit: 'Pa', space, components: 1, data: pr, step: i, ...(p.tags ? { physics: p.tags.p } : {}) });
    scalars[`f_${i}`] = scalar(freqs[i]!, 'Hz');
  });
  timer.stop('post');
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { module: 'acoustic-structure', model: p.model, nModes: p.nModes, shiftHz: p.shiftHz ?? null, mesh: m.hash } }),
    fields, steps: { kind: 'eigen', values: freqs, unit: 'Hz' }, scalars,
    stats: { dof: n, nnz: pat.nnz, iterations: eig.stats.opApplications, residual: Math.max(0, ...eig.residual), solver: 'shift-invert block Arnoldi (unsymmetric u-p), LDL^T of the row-scaled shifted matrix (supernodal)' },
    timer,
  });
  attachMesh(sol, m);
  (sol as Solution & { normalization?: string }).normalization = FSI_NORMALIZATION;
  if (closedRegions) (sol as Solution & { notes?: string[] }).notes = [`acoustic-structure: ${closedRegions} closed fluid region(s) without a p = 0 boundary: each adds an f = 0 mode of the u-p form (with a solid that has no rigid-body freedom) (uniform pressure in each region with the static deformation it causes; not vibration modes). The non-zero modes include the cavity compressibility exactly.`];
  return Object.assign(sol, { detail: { eigResidual: eig.residual, solidEnergyShare: uShare, interfaceFaces: nFaces, closedRegions, wetMeasure: wetArea, eig: { ...eig.stats, sigma, lamScale } } });
}
