// SPDX-License-Identifier: GPL-3.0-or-later
// Linear piezoelectricity, monolithic u-V (lane MT, DevLog-033; coupling type 'piezoelectric', elastic ->
// electrostatics). Stress-charge form T = c^E S - e^T E, D = e S + eps^S E, E = -grad V; quasi-static electric field.
// Weak form: K_uu = int B^T c B, K_uV = int B^T e^T grad N, K_VV = int grad N^T eps grad N, M_uu = int rho N N:
//   [[K_uu, K_uV], [K_uV^T, -K_VV]] [u; V] = [F; -Q]   (symmetric indefinite; eigen: = omega^2 [[M_uu, 0], [0, 0]])
// Models: 3D (tet4 / tet10) and 2D plane strain in x-y (S_zz = S_yz = S_xz = 0, E_z = 0; the out-of-plane
// displacement is not modelled, an approximation for anisotropic crystals whose x-y plane is not a mirror plane).
// Cells of the elastic selection carry u, cells of the electrostatics selection carry V, cells in both are piezo
// (e from the material; e = 0 when the material has none). Electrodes (electrostatics BCs): ground (V = 0),
// potential (V given; homogeneous in eigen), terminal = floating electrode (one shared DOF, net charge 0: open circuit),
// zero-charge / free = natural D . n = 0. Short circuit = all electrodes grounded.
// Eigen: shift-invert block Arnoldi (common/eigen.ts) on the LDL^T of K - sigma M (the singular M of the V block maps
// to infinite eigenvalues, mu = 0, never selected). Stationary: LDL^T with iterative refinement.

import type { Mesh, Solution, FieldData } from '@amp/spec/types';
import { analyze } from '@amp/core/la/sparse';
import { SupernodalLDLT } from '@amp/core/la/ldlt';
import { NPC, facetNodes, facetsOn, nCells, nNodes } from '../common/mesh.ts';
import { cellOrder, restrict } from '../common/scalar.ts';
import { defaultRule, gatherX, physGrad, shapeTable } from '../common/lagrange.ts';
import { shiftInvertEigen } from '../common/eigen.ts';
import { StageTimer, makeSolution, attachMesh, scalar } from '../common/solution.ts';
import { dofPattern, scatter, solidConstraints, solidLoads, strainB, csrMv, jacobiScale, scaleSym, type SolidBc } from './assemble.ts';
import type { Mat } from './tensors.ts';

export const PIEZO_NORMALIZATION =
  'u per mode is M-orthonormal: int rho u . u dV = 1 (SI numbers, kg m^2; 2D per unit thickness); V scaled with u; arbitrary sign';

export interface PiezoCellMaterial {
  rho: number;
  /** model-frame stiffness (6x6, Pa); required on solid cells */
  C?: Mat;
  /** model-frame piezoelectric stress constants (3x6, C/m^2) */
  e?: Mat;
  /** model-frame absolute permittivity (3x3, F/m); required on dielectric cells */
  eps?: Mat;
}

export interface PiezoProblem {
  mesh: Mesh;
  model: 'plane-strain' | '3d';
  /** cell flags: u lives on solid cells, V on dielectric cells */
  solid: Uint8Array;
  dielectric: Uint8Array;
  /** cell -> index into mats */
  matOf: Int32Array;
  mats: PiezoCellMaterial[];
  solidBcs: SolidBc[];
  ground: string[];
  potentials: Array<{ id: string; select: string[]; V: number }>;
  floating: Array<{ id: string; select: string[] }>;
  study: { kind: 'eigen'; nModes: number; shiftHz?: number | null } | { kind: 'stationary' };
  spec?: unknown;
  signal?: AbortSignal;
  /** physics ids for field tags (C11) */
  tags?: { u: string; V: string };
}

export async function solvePiezo(p: PiezoProblem): Promise<Solution & { detail: Record<string, unknown> }> {
  const timer = new StageTimer();
  const m = p.mesh, dim = m.dim, k = NPC[m.cells.type], nn = nNodes(m), nc = nCells(m), nComp = dim + 1;
  if ((dim === 3) !== (p.model === '3d')) throw new Error(`piezo: model ${p.model} on a ${dim}D mesh`);
  if (m.axisym) throw new Error('piezo: axisymmetric meshes are not supported');
  const vi = dim === 3 ? [0, 1, 2, 3, 4, 5] : [0, 1, 5], ei = dim === 3 ? [0, 1, 2] : [0, 1];
  const nv = vi.length;
  timer.start('assemble');
  // DOF map: u at nodes of solid cells, V at nodes of dielectric cells; floating electrodes share one DOF
  const hasU = new Uint8Array(nn), hasV = new Uint8Array(nn);
  for (let e = 0; e < nc; e++) for (let a = 0; a < k; a++) { const v = m.cells.conn[k * e + a]!; if (p.solid[e]) hasU[v] = 1; if (p.dielectric[e]) hasV[v] = 1; }
  const map = new Int32Array(nn * nComp).fill(-1);
  let n = 0;
  const floatDof: number[] = [];
  const floatOf = new Int32Array(nn).fill(-1);
  p.floating.forEach((f, i) => { for (const v of facetNodes(m, facetsOn(m, f.select))) { if (floatOf[v]! >= 0 && floatOf[v] !== i) throw new Error(`piezo: node ${v} on two floating electrodes`); floatOf[v] = i; } });
  for (let v = 0; v < nn; v++) {
    if (hasU[v]) for (let d = 0; d < dim; d++) map[nComp * v + d] = n++;
    if (hasV[v] && floatOf[v]! < 0) map[nComp * v + dim] = n++;
  }
  p.floating.forEach(() => floatDof.push(n++));
  for (let v = 0; v < nn; v++) if (floatOf[v]! >= 0) { if (!hasV[v]) throw new Error(`piezo: floating electrode '${p.floating[floatOf[v]!]!.id}' is not on the dielectric`); map[nComp * v + dim] = floatDof[floatOf[v]!]!; }
  const pat = dofPattern(m, { nComp, map, n });
  const K = new Float64Array(pat.nnz), M = new Float64Array(pat.nnz);
  const r = defaultRule(m.cells.type, 2 * cellOrder(m)), t = shapeTable(m.cells.type, r);
  const ndU = k * dim, nd = ndU + k;
  const X = new Float64Array(k * dim), G = new Float64Array(k * dim), B = new Float64Array(nv * ndU);
  const Ae = new Float64Array(nd * nd), Me = new Float64Array(nd * nd), dofs = new Int32Array(nd);
  const red = new Map<number, { C: Float64Array | null; e: Float64Array | null; eps: Float64Array | null }>();
  const reduced = (mi: number) => {
    let h = red.get(mi);
    if (h) return h;
    const mt = p.mats[mi]!;
    h = {
      C: mt.C ? Float64Array.from(vi.flatMap((I) => vi.map((J) => mt.C![I]![J]!))) : null,
      e: mt.e ? Float64Array.from(ei.flatMap((i) => vi.map((J) => mt.e![i]![J]!))) : null,
      eps: mt.eps ? Float64Array.from(ei.flatMap((i) => ei.map((j) => mt.eps![i]![j]!))) : null,
    };
    red.set(mi, h);
    return h;
  };
  const N0 = new Float64Array(k);
  for (let e = 0; e < nc; e++) {
    const S = !!p.solid[e], Dl = !!p.dielectric[e];
    if (!S && !Dl) continue;
    const mi = p.matOf[e]!, mt = p.mats[mi]!, h = reduced(mi);
    if (S && !h.C) throw new Error(`piezo: cell ${e} of the elastic selection has no stiffness`);
    if (Dl && !h.eps) throw new Error(`piezo: cell ${e} of the electrostatics selection has no permittivity`);
    const pz = S && Dl && h.e;
    gatherX(m.nodes, dim, m.cells.conn, e, k, X);
    Ae.fill(0); Me.fill(0);
    for (let q = 0; q < r.n; q++) {
      const w = physGrad(t, q, X, dim, G) * r.wts[q]!;
      const N = t.N.subarray(q * k, q * k + k);
      if (S) {
        strainB(p.model, G, N0, 0, k, B);
        const C = h.C!;
        for (let a = 0; a < ndU; a++) for (let b = a; b < ndU; b++) {
          let s = 0;
          for (let I = 0; I < nv; I++) { const bi = B[I * ndU + a]!; if (bi === 0) continue; for (let J = 0; J < nv; J++) s += bi * C[I * nv + J]! * B[J * ndU + b]!; }
          Ae[a * nd + b]! += s * w;
        }
        for (let a = 0; a < k; a++) for (let b = a; b < k; b++) { const v = mt.rho * N[a]! * N[b]! * w; for (let d = 0; d < dim; d++) Me[(dim * a + d) * nd + dim * b + d]! += v; }
      }
      if (Dl) {
        const ep = h.eps!;
        for (let a = 0; a < k; a++) for (let b = a; b < k; b++) {
          let s = 0;
          for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) s += G[dim * a + i]! * ep[dim * i + j]! * G[dim * b + j]!;
          Ae[(ndU + a) * nd + ndU + b]! -= s * w;
        }
      }
      if (pz) {
        const ee = h.e!;
        // K_uV[a_u][b] = sum_J sum_i B[J][a_u] e[i][J] dN_b/dx_i
        for (let a = 0; a < ndU; a++) for (let b = 0; b < k; b++) {
          let s = 0;
          for (let J = 0; J < nv; J++) { const bj = B[J * ndU + a]!; if (bj === 0) continue; for (let i = 0; i < dim; i++) s += bj * ee[nv * i + J]! * G[dim * b + i]!; }
          Ae[a * nd + ndU + b]! += s * w;
        }
      }
    }
    // symmetric fill: uu and VV from the upper triangle, Vu = uV^T
    for (let a = 0; a < nd; a++) for (let b = 0; b < a; b++) {
      if (a < ndU || b >= ndU) { Ae[a * nd + b] = Ae[b * nd + a]!; Me[a * nd + b] = Me[b * nd + a]!; }
      else Ae[a * nd + b] = Ae[b * nd + a]!;   // a in V, b in u: (V_a, u_b) = (u_b, V_a)
    }
    for (let a = 0; a < k; a++) {
      const v = m.cells.conn[k * e + a]!;
      for (let d = 0; d < dim; d++) dofs[dim * a + d] = S ? map[nComp * v + d]! : -1;
      dofs[ndU + a] = Dl ? map[nComp * v + dim]! : -1;
    }
    scatter(pat, K, dofs, Ae, nd);
    if (S) scatter(pat, M, dofs, Me, nd);
  }
  // loads and constraints
  const F = new Float64Array(n);
  const eigen = p.study.kind === 'eigen';
  if (!eigen) {
    const Fu = new Float64Array(nn * dim);
    solidLoads(m, p.model, p.solidBcs, Fu, p.solid);
    for (let v = 0; v < nn; v++) for (let d = 0; d < dim; d++) { const g = map[nComp * v + d]!; if (g >= 0) F[g]! += Fu[dim * v + d]!; }
  }
  const fixed = new Uint8Array(n), val = new Float64Array(n);
  const sc = solidConstraints(m, p.model, p.solidBcs as Parameters<typeof solidConstraints>[2]);
  for (let v = 0; v < nn; v++) for (let d = 0; d < dim; d++) { const g = map[nComp * v + d]!; if (g >= 0 && sc.fixed[dim * v + d]) { fixed[g] = 1; val[g] = eigen ? 0 : sc.value[dim * v + d]!; } }
  const elect: Array<{ id: string; dofs: number[] }> = [];
  const fixV = (sel: string[], V: number, id: string) => {
    const ds: number[] = [];
    for (const v of facetNodes(m, facetsOn(m, sel))) {
      const g = map[nComp * v + dim]!;
      if (g < 0) throw new Error(`piezo: electrode '${id}' node ${v} is not on the dielectric`);
      if (floatOf[v]! >= 0) throw new Error(`piezo: electrode '${id}' touches floating electrode '${p.floating[floatOf[v]!]!.id}'`);
      fixed[g] = 1; val[g] = eigen ? 0 : V; ds.push(g);
    }
    elect.push({ id, dofs: ds });
  };
  if (p.ground.length) fixV(p.ground, 0, 'ground');
  for (const x of p.potentials) fixV(x.select, x.V, x.id);
  if (!elect.length) throw new Error('piezo: no ground or potential electrode (the potential is undetermined)');
  const free = Uint8Array.from(fixed, (f) => (f ? 0 : 1));
  const R = restrict(pat, K, free);
  // Jacobi scaling of the restricted system (u and V blocks differ by ~20 orders of magnitude in SI)
  const dsc = jacobiScale(R.pat, R.val);
  const Ks = scaleSym(R.pat, R.val, dsc);
  timer.stop('assemble');
  const space = cellOrder(m) === 2 ? 'H1P2' : 'H1P1';
  const tagU = p.tags ? { physics: p.tags.u } : {}, tagV = p.tags ? { physics: p.tags.V } : {};
  const unpack = (x: Float64Array) => {
    const full = new Float64Array(n);
    for (let i = 0; i < n; i++) full[i] = free[i] ? x[R.map[i]!]! : val[i]!;
    const u = new Float64Array(nn * dim), V = new Float64Array(nn).fill(NaN);
    for (let v = 0; v < nn; v++) {
      for (let d = 0; d < dim; d++) { const g = map[nComp * v + d]!; if (g >= 0) u[dim * v + d] = full[g]!; }
      const g = map[nComp * v + dim]!; if (g >= 0) V[v] = full[g]!;
    }
    return { full, u, V };
  };
  const fields: FieldData[] = [];
  const scalars: Solution['scalars'] = {};
  const detail: Record<string, unknown> = { n, nFree: R.pat.n };
  let stats: Solution['stats'];
  let steps: Solution['steps'] | undefined;
  if (eigen) {
    const st = p.study as { nModes: number; shiftHz?: number | null };
    const Mr = scaleSym(R.pat, restrict(pat, M, free).val, dsc);
    // spectral scale: fastest wave speed max(C_ii / rho) over the bounding box
    let c2 = 0, diag2 = 0;
    for (let e = 0; e < nc; e++) if (p.solid[e]) { const mt = p.mats[p.matOf[e]!]!; for (let i = 0; i < 6; i++) c2 = Math.max(c2, mt.C![i]![i]! / mt.rho); }
    for (let d = 0; d < dim; d++) { let lo = Infinity, hi = -Infinity; for (let v = 0; v < nn; v++) { const x = m.nodes[dim * v + d]!; lo = Math.min(lo, x); hi = Math.max(hi, x); } diag2 += (hi - lo) ** 2; }
    const lamScale = (Math.PI ** 2 * c2) / diag2;
    const sigma = st.shiftHz && st.shiftHz > 0 ? (2 * Math.PI * st.shiftHz) ** 2 : -0.01 * lamScale;
    timer.start('solve');
    const eig = shiftInvertEigen({ pat: R.pat, K: Ks, M: Mr, sigma, nWant: st.nModes, factor: 'ldlt', tol: 1e-10, ...(p.signal ? { signal: p.signal } : {}) });
    timer.stop('solve');
    timer.add('factor', eig.stats.factorMs);
    timer.timing.solve = (timer.timing.solve ?? 0) - eig.stats.factorMs;
    const freqs = Float64Array.from(eig.lambda, (l) => (Math.abs(l) < 1e-8 * lamScale ? 0 : Math.sign(l) * Math.sqrt(Math.abs(l)) / (2 * Math.PI)));
    eig.vecs.forEach((xs, i) => {
      const x = Float64Array.from(xs, (v, j) => v * dsc[j]!);
      const { u, V, full } = unpack(x);
      fields.push({ name: 'u', unit: 'm', space, components: dim as 2 | 3, data: u, step: i, ...tagU });
      fields.push({ name: 'V', unit: 'V', space, components: 1, data: V, step: i, ...tagV });
      scalars[`f_${i}`] = scalar(freqs[i]!, 'Hz');
      p.floating.forEach((f, j) => { scalars[`V_${f.id}_${i}`] = scalar(full[floatDof[j]!]!, 'V'); });
    });
    steps = { kind: 'eigen', values: freqs, unit: 'Hz' };
    stats = { dof: R.pat.n, nnz: R.pat.nnz, iterations: eig.stats.opApplications, residual: Math.max(0, ...eig.residual), solver: `shift-invert block Arnoldi, ${eig.stats.factor} (supernodal)` };
    Object.assign(detail, { eigResidual: eig.residual, eig: { ...eig.stats, sigma, lamScale } });
  } else {
    const b = new Float64Array(R.pat.n);
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue;
      let s = F[i]!;
      for (let z = pat.rowptr[i]!; z < pat.rowptr[i + 1]!; z++) { const c = pat.colidx[z]!; if (!free[c]) s -= K[z]! * val[c]!; }
      b[R.map[i]!] = s * dsc[R.map[i]!]!;
    }
    const t0 = performance.now();
    const f = new SupernodalLDLT(analyze(R.pat));
    const fr = f.factor(Ks);
    if (!fr.ok) throw new Error('piezo: LDL^T failed');
    timer.add('factor', performance.now() - t0);
    const t1 = performance.now();
    const sol = f.solveRefined(R.pat, Ks, b, {});
    timer.add('solve', performance.now() - t1);
    if (!(sol.relResidual < 1e-8)) throw new Error(`piezo: stationary solve residual ${sol.relResidual} (LDL^T perturbed pivots: ${fr.nPerturbed ?? 0})`);
    const { u, V, full } = unpack(Float64Array.from(sol.x, (v, j) => v * dsc[j]!));
    fields.push({ name: 'u', unit: 'm', space, components: dim as 2 | 3, data: u, ...tagU });
    fields.push({ name: 'V', unit: 'V', space, components: 1, data: V, ...tagV });
    // electrode charges: Q = -sum of the V-row residuals over the electrode DOFs (per unit length in 2D)
    const Kx = csrMv(pat, K, full, new Float64Array(n));
    for (const el of elect) { let s = 0; for (const g of el.dofs) s += Kx[g]!; scalars[`Q_${el.id}`] = scalar(-s, dim === 2 ? 'C/m' : 'C'); }
    p.floating.forEach((fl, j) => { scalars[`V_${fl.id}`] = scalar(full[floatDof[j]!]!, 'V'); });
    let umax = 0; for (let v = 0; v < nn; v++) { let s = 0; for (let d = 0; d < dim; d++) s += u[dim * v + d]! ** 2; umax = Math.max(umax, Math.sqrt(s)); }
    scalars.u_max = scalar(umax, 'm');
    stats = { dof: R.pat.n, nnz: R.pat.nnz, residual: sol.relResidual, solver: 'LDL^T (supernodal) + refinement' };
  }
  const solOut = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { module: 'piezoelectric', model: p.model, study: p.study, mats: p.mats.length, mesh: m.hash } }),
    fields, ...(steps ? { steps } : {}), scalars, stats, timer,
  });
  attachMesh(solOut, m);
  if (eigen) (solOut as Solution & { normalization?: string }).normalization = PIEZO_NORMALIZATION;
  return Object.assign(solOut, { detail });
}
