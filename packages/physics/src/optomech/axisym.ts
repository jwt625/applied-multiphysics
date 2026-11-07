// SPDX-License-Identifier: GPL-3.0-or-later
// Optomechanical coupling on a meridional (r, z) mesh (lane MOM, DevLog-034): optical modes of emw-axisym (azimuthal
// order m) x torsion-free axisymmetric solid modes (azimuthal order 0).
//
// Conventions (sources in DevLog-034 s.1.1):
//   g_OM = d omega_o / d alpha, alpha = max |Q| (Eichenfield et al. 2009 app. D; Chan et al. 2012 APL 101 081115).
//   Moving boundary (Johnson et al. 2002 PRE 65 066611; Chan 2012 eq. 1):
//     g_MB = -(omega / 2) oint (q . n)(Delta eps |E_par|^2 - Delta(eps^-1) |D_perp|^2) dA / int eps |E|^2 dV,
//     q = Q / max |Q|, n from medium 1 into medium 2, Delta eps = eps_1 - eps_2, Delta(eps^-1) = 1/eps_1 - 1/eps_2
//     (relative permittivities: eps0 cancels). Medium 1 = the solid side of each meridional edge.
//   Photoelastic (Chan 2012 eq. 2): g_PE = -(omega / 2) int E . (d eps / d alpha) . E dV / int eps |E|^2 dV with
//     d eps_ij = -eps_r^2 p_ijkl S_kl (isotropic optical background n^2 = eps_r; S from q).
//   Azimuthal integration: E = (E_r cos m phi, E_phi sin m phi, E_z cos m phi); for m >= 1 every squared component and
//     the E_r E_z product carry the same factor pi, the E_r E_phi and E_phi E_z products integrate to 0; for m = 0 all
//     carry 2 pi. The factor is common to numerator and denominator and is dropped (meridional integrals, weight r).
//     The m = 0 strain has no r-phi or phi-z shear. With a phi-averaged photoelastic tensor (crystal z on the axis) the
//     4 phi part of a cubic crystal is dropped: exact for m != 2 (the cos^2 m phi x cos 4 phi integral vanishes).
//   m_eff = int rho |Q|^2 dV / max |Q|^2 over the 3D body (2 pi x the meridional integral; max over mesh nodes);
//   x_zpf = sqrt(hbar / (2 m_eff Omega_m)); g0 = g_OM x_zpf (independent of the eigenvector normalisation).
// Fields: E is evaluated inside each triangle from the Nedelec / Lagrange coefficients of solveAxisymModes (same basis
// code and DOF layout as em-axisym/index.ts), never from the vertex-averaged nodal field (E_perp jumps at interfaces).

import type { Mesh } from '@amp/spec/types';
import { ndBasis, h1Basis } from '@amp/core/fem/hcurl';
import { NPC, nCells, nNodes } from '../common/mesh.ts';
import { gaussLegendre01, triRule } from '../common/quad.ts';
import { shape, shapeTable, physGrad, gatherX } from '../common/lagrange.ts';
import { restrict } from '../common/scalar.ts';
import { shiftInvertEigen } from '../common/eigen.ts';
import { dofPattern, solidConstraints, type SolidBc } from '../coupled/assemble.ts';
import { assembleSolid, solidDofMap, solidLambdaScale } from '../elastic/modal.ts';
import { t4, type T4 } from './tensors.ts';

/** Reduced Planck constant, J s (CODATA 2018; exact from the 2019 SI value of h). */
export const HBAR = 1.054571817e-34;

type Term = [number, number[], number];

/** The part of em-axisym's Space this module reads. */
export interface AxiSpace { nT: number; triV: Int32Array; dofs: Int32Array; ndl: number }

const basisCache = new Map<number, { E: Term[][]; W: Term[][] }>();
function basis(order: 1 | 2) {
  let b = basisCache.get(order);
  if (!b) { b = { E: ndBasis(order, 3) as Term[][], W: h1Basis(order, 3) as Term[][] }; basisCache.set(order, b); }
  return b;
}

/** tri6 -> tri3 on the corner nodes (node indices kept), as em-axisym does. */
export function toTri3(m: Mesh): Mesh {
  if (m.cells.type === 'tri3') return m;
  if (m.cells.type !== 'tri6') throw new Error(`optomechanical: meridional mesh must be tri3 or tri6, got ${m.cells.type}`);
  const nT = nCells(m), conn = new Int32Array(3 * nT);
  for (let t = 0; t < nT; t++) for (let i = 0; i < 3; i++) conn[3 * t + i] = m.cells.conn[6 * t + i]!;
  const nF = m.facets.conn.length / 3, fc = new Int32Array(2 * nF);
  for (let f = 0; f < nF; f++) { fc[2 * f] = m.facets.conn[3 * f]!; fc[2 * f + 1] = m.facets.conn[3 * f + 1]!; }
  return { ...m, cells: { ...m.cells, type: 'tri3', conn }, facets: { ...m.facets, type: 'line2', conn: fc } };
}

/** Barycentric coordinates of point (r, z) in the triangle with corners X (3 x [r, z]). */
function bary(X: number[][], r: number, z: number, out: number[]): void {
  const [a, b, c] = X as [number[], number[], number[]];
  const det = (b[0]! - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (b[1]! - a[1]!);
  const l1 = ((r - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (z - a[1]!)) / det;
  const l2 = ((b[0]! - a[0]!) * (z - a[1]!) - (r - a[0]!) * (b[1]! - a[1]!)) / det;
  out[0] = 1 - l1 - l2; out[1] = l1; out[2] = l2;
}

/** Optical mode data needed for the overlaps. */
export interface OpticalMode {
  mesh: Mesh; space: AxiSpace; order: 1 | 2; x: Float64Array; omega: number; m: number;
  /** E at the photoelastic quadrature points / interface points, filled on first use (reused across mechanical modes) */
  cache?: { pe?: Float64Array; mb?: { edges: readonly InterfaceEdge[]; nq: number; e: Float64Array } };
}

/** (E_r, E_phi, E_z) meridional amplitudes of an optical mode at (r, z) inside triangle t (r > 0). */
export function evalE(o: OpticalMode, t: number, r: number, z: number, out: number[] = [0, 0, 0]): number[] {
  const { E, W } = basis(o.order), sp = o.space, mesh = o.mesh;
  const v = [sp.triV[3 * t]!, sp.triV[3 * t + 1]!, sp.triV[3 * t + 2]!];
  const X = v.map((i) => [mesh.nodes[2 * i]!, mesh.nodes[2 * i + 1]!]);
  const det = (X[1]![0]! - X[0]![0]!) * (X[2]![1]! - X[0]![1]!) - (X[2]![0]! - X[0]![0]!) * (X[1]![1]! - X[0]![1]!);
  const g = [0, 1, 2].map((i) => { const j = (i + 1) % 3, k = (i + 2) % 3; return [(X[j]![1]! - X[k]![1]!) / det, (X[k]![0]! - X[j]![0]!) / det]; });
  const l = [0, 0, 0]; bary(X, r, z, l);
  const nle = E.length;
  let er = 0, ez = 0, w = 0;
  for (let i = 0; i < nle; i++) {
    const xi = o.x[sp.dofs[sp.ndl * t + i]!]!; if (!xi) continue;
    for (const [c, a, gi] of E[i]!) {
      let val = c; for (let k = 0; k < 3; k++) if (a[k]) val *= l[k]! ** a[k]!;
      er += xi * val * g[gi]![0]!; ez += xi * val * g[gi]![1]!;
    }
  }
  for (let i = 0; i < W.length; i++) {
    const xi = o.x[sp.dofs[sp.ndl * t + nle + i]!]!; if (!xi) continue;
    for (const [c, a] of W[i]!) { let val = c; for (let k = 0; k < 3; k++) if (a[k]) val *= l[k]! ** a[k]!; w += xi * val; }
  }
  out[0] = er; out[1] = w / r; out[2] = ez;
  return out;
}

/** int eps_r |E|^2 r dr dz over the optical cells (same form as the em-axisym mass matrix: |e_t|^2 r + w^2 / r). */
export function opticalEnergy(o: OpticalMode, epsR: Float64Array, mask: Uint8Array): number {
  const rule = triRule(5), mesh = o.mesh, nT = nCells(mesh), e = [0, 0, 0];
  let s = 0;
  for (let t = 0; t < nT; t++) {
    if (!mask[t]) continue;
    const c = [0, 1, 2].map((i) => mesh.cells.conn[3 * t + i]!);
    const X = c.map((i) => [mesh.nodes[2 * i]!, mesh.nodes[2 * i + 1]!]);
    const A2 = Math.abs((X[1]![0]! - X[0]![0]!) * (X[2]![1]! - X[0]![1]!) - (X[2]![0]! - X[0]![0]!) * (X[1]![1]! - X[0]![1]!));
    for (let q = 0; q < rule.n; q++) {
      const a = rule.pts[2 * q]!, b = rule.pts[2 * q + 1]!;
      const r = (1 - a - b) * X[0]![0]! + a * X[1]![0]! + b * X[2]![0]!, z = (1 - a - b) * X[0]![1]! + a * X[1]![1]! + b * X[2]![1]!;
      evalE(o, t, r, z, e);
      s += epsR[t]! * (e[0]! ** 2 + e[1]! ** 2 + e[2]! ** 2) * r * rule.wts[q]! * A2;
    }
  }
  return s;
}

/** Displacement (u_r, u_z) at (r, z) inside cell t of the mechanical mesh (tri3 / tri6, straight sides). */
export function evalU(mesh: Mesh, u: Float64Array, t: number, r: number, z: number, out: number[] = [0, 0]): number[] {
  const type = mesh.cells.type, k = NPC[type];
  const X = [0, 1, 2].map((i) => { const n = mesh.cells.conn[k * t + i]!; return [mesh.nodes[2 * n]!, mesh.nodes[2 * n + 1]!]; });
  const l = [0, 0, 0]; bary(X, r, z, l);
  const N = new Float64Array(k), dN = new Float64Array(2 * k);
  shape(type, [l[1]!, l[2]!], N, dN);
  out[0] = 0; out[1] = 0;
  for (let a = 0; a < k; a++) { const n = mesh.cells.conn[k * t + a]!; out[0]! += N[a]! * u[2 * n]!; out[1]! += N[a]! * u[2 * n + 1]!; }
  return out;
}

/** Interface edges of the optical mesh: meridional edges with different eps_r on the two sides and a solid on side 1. */
export interface InterfaceEdge { a: number; b: number; c1: number; c2: number; n: [number, number] }
export function interfaceEdges(opt: Mesh, optMask: Uint8Array, solid: Uint8Array, epsR: Float64Array): { edges: InterfaceEdge[]; open: number } {
  const nT = nCells(opt), nV = opt.nodes.length / 2;
  const adj = new Map<number, number[]>();
  for (let t = 0; t < nT; t++) {
    if (!optMask[t] && !solid[t]) continue;
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
      const a = opt.cells.conn[3 * t + i]!, b = opt.cells.conn[3 * t + j]!;
      const key = a < b ? a * nV + b : b * nV + a;
      const l = adj.get(key); if (l) l.push(t); else adj.set(key, [t]);
    }
  }
  const edges: InterfaceEdge[] = [];
  let open = 0;
  const cen = (t: number) => { let r = 0, z = 0; for (let i = 0; i < 3; i++) { const n = opt.cells.conn[3 * t + i]!; r += opt.nodes[2 * n]! / 3; z += opt.nodes[2 * n + 1]! / 3; } return [r, z]; };
  for (const [key, cells] of adj) {
    const a = Math.floor(key / nV), b = key % nV;
    if (cells.length === 1) { if (solid[cells[0]!]) open++; continue; }
    let [c1, c2] = cells as [number, number];
    if (!solid[c1]) [c1, c2] = [c2, c1];
    if (!solid[c1] || !optMask[c1] || !optMask[c2] || epsR[c1] === epsR[c2]) continue;
    const ra = opt.nodes[2 * a]!, za = opt.nodes[2 * a + 1]!, rb = opt.nodes[2 * b]!, zb = opt.nodes[2 * b + 1]!;
    const L = Math.hypot(rb - ra, zb - za);
    let n: [number, number] = [(zb - za) / L, -(rb - ra) / L];
    const c = cen(c1);
    if (n[0] * (0.5 * (ra + rb) - c[0]!) + n[1] * (0.5 * (za + zb) - c[1]!) < 0) n = [-n[0], -n[1]];   // outward from the solid cell
    edges.push({ a, b, c1, c2, n });
  }
  return { edges, open };
}

/**
 * Moving-boundary numerator oint (q . n)(Delta eps |E_par|^2 - Delta(1/eps) |D_perp|^2) r ds over the interface edges,
 * q(t, r, z) = displacement on the solid side. E_par (meridional tangential + E_phi) and D_perp averaged over the two
 * sides (continuous in the exact solution).
 */
export function movingBoundaryIntegral(o: OpticalMode, edges: readonly InterfaceEdge[], epsR: Float64Array, q: (t: number, r: number, z: number) => [number, number], nq = 5): number {
  const gl = gaussLegendre01(nq), e1 = [0, 0, 0], e2 = [0, 0, 0], mesh = o.mesh;
  o.cache ??= {};
  if (!o.cache.mb || o.cache.mb.edges !== edges || o.cache.mb.nq !== nq) o.cache.mb = { edges, nq, e: new Float64Array(6 * nq * edges.length).fill(NaN) };
  const C = o.cache.mb.e;
  let s = 0;
  for (let ie = 0; ie < edges.length; ie++) {
    const ed = edges[ie]!;
    const ra = mesh.nodes[2 * ed.a]!, za = mesh.nodes[2 * ed.a + 1]!, rb = mesh.nodes[2 * ed.b]!, zb = mesh.nodes[2 * ed.b + 1]!;
    const L = Math.hypot(rb - ra, zb - za), tr = (rb - ra) / L, tz = (zb - za) / L;
    const eps1 = epsR[ed.c1]!, eps2 = epsR[ed.c2]!, dEps = eps1 - eps2, dInv = 1 / eps1 - 1 / eps2;
    for (let k = 0; k < nq; k++) {
      const sk = gl.x[k]!, r = ra + sk * (rb - ra), z = za + sk * (zb - za);
      if (!(r > 0)) continue;
      const Q = q(ed.c1, r, z), qn = Q[0] * ed.n[0] + Q[1] * ed.n[1];
      if (!qn) continue;
      const off = 6 * (nq * ie + k);
      if (Number.isNaN(C[off]!)) { evalE(o, ed.c1, r, z, e1); evalE(o, ed.c2, r, z, e2); C.set(e1, off); C.set(e2, off + 3); }
      else for (let c = 0; c < 3; c++) { e1[c] = C[off + c]!; e2[c] = C[off + 3 + c]!; }
      const et = 0.5 * ((e1[0]! * tr + e1[2]! * tz) + (e2[0]! * tr + e2[2]! * tz)), ephi = 0.5 * (e1[1]! + e2[1]!);
      const dn = 0.5 * (eps1 * (e1[0]! * ed.n[0] + e1[2]! * ed.n[1]) + eps2 * (e2[0]! * ed.n[0] + e2[2]! * ed.n[1]));
      s += qn * (dEps * (et * et + ephi * ephi) - dInv * dn * dn) * r * L * gl.w[k]!;
    }
  }
  return s;
}

/**
 * Photoelastic numerator int E . d eps . E r dr dz over the solid cells for displacement u (nodal, mechanical mesh):
 * d eps_ij = -eps_r^2 P_ijkl S_kl, P in the (r, phi, z) frame per cell (null = not photoelastic).
 */
export function photoelasticIntegral(o: OpticalMode, mech: Mesh, u: Float64Array, solid: Uint8Array, epsR: Float64Array, P: (t: number) => T4 | null): number {
  const type = mech.cells.type, k = NPC[type], rule = triRule(5), tab = shapeTable(type, rule);
  const X = new Float64Array(2 * k), G = new Float64Array(2 * k), e = [0, 0, 0];
  const nT = nCells(mech);
  o.cache ??= {};
  if (!o.cache.pe || o.cache.pe.length !== 3 * nT * rule.n) o.cache.pe = new Float64Array(3 * nT * rule.n).fill(NaN);
  const C = o.cache.pe;
  let s = 0;
  for (let t = 0; t < nT; t++) {
    if (!solid[t]) continue;
    const Pt = P(t); if (!Pt) continue;
    gatherX(mech.nodes, 2, mech.cells.conn, t, k, X);
    const n4 = epsR[t]! ** 2;
    for (let q = 0; q < rule.n; q++) {
      const det = physGrad(tab, q, X, 2, G);
      let r = 0, z = 0, ur = 0, dur_r = 0, dur_z = 0, duz_r = 0, duz_z = 0;
      for (let a = 0; a < k; a++) {
        const N = tab.N[q * k + a]!, n = mech.cells.conn[k * t + a]!;
        r += N * X[2 * a]!; z += N * X[2 * a + 1]!;
        const vr = u[2 * n]!, vz = u[2 * n + 1]!;
        ur += N * vr; dur_r += G[2 * a]! * vr; dur_z += G[2 * a + 1]! * vr; duz_r += G[2 * a]! * vz; duz_z += G[2 * a + 1]! * vz;
      }
      if (!(r > 0)) continue;
      // S (tensor): rr, phiphi, zz, rz = zr
      const S = [dur_r, 0, 0.5 * (dur_z + duz_r), 0, ur / r, 0, 0.5 * (dur_z + duz_r), 0, duz_z];
      const off = 3 * (rule.n * t + q);
      if (Number.isNaN(C[off]!)) { evalE(o, t, r, z, e); C.set(e, off); } else for (let c = 0; c < 3; c++) e[c] = C[off + c]!;
      // d(1/eps)_ij for ij in rr, phiphi, zz, rz
      const dInv = (i: number, j: number) => { let v = 0; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { const sab = S[3 * a + b]!; if (sab) v += t4(Pt, i, j, a, b) * sab; } return v; };
      const val = e[0]! * e[0]! * dInv(0, 0) + e[1]! * e[1]! * dInv(1, 1) + e[2]! * e[2]! * dInv(2, 2) + 2 * e[0]! * e[2]! * dInv(0, 2);
      s += -n4 * val * r * det * rule.wts[q]!;
    }
  }
  return s;
}

/** int rho |u|^2 dV over the 3D body (2 pi x meridional integral) and max |u| over the mesh nodes of the solid. */
export function modalMass(mech: Mesh, u: Float64Array, solid: Uint8Array, rho: Float64Array): { mass: number; umax: number; at: number } {
  // integrand |u|^2 r det in reference coordinates: degree 5 on affine tri6 (det constant), up to 8 on curved
  // (isoparametric) tri6 (r and det quadratic); triRule(n) (Duffy n x n) is exact to degree 2n - 2 (checked
  // 2026-11-07), so triRule(5) covers both (triRule(4), exact to 6, already covered affine cells; audit FE item 6)
  const type = mech.cells.type, k = NPC[type], rule = triRule(5), tab = shapeTable(type, rule);
  const X = new Float64Array(2 * k), G = new Float64Array(2 * k);
  let s = 0, umax = 0, at = -1;
  for (let t = 0; t < nCells(mech); t++) {
    if (!solid[t]) continue;
    gatherX(mech.nodes, 2, mech.cells.conn, t, k, X);
    for (let q = 0; q < rule.n; q++) {
      const det = physGrad(tab, q, X, 2, G);
      let r = 0, ur = 0, uz = 0;
      for (let a = 0; a < k; a++) { const N = tab.N[q * k + a]!, n = mech.cells.conn[k * t + a]!; r += N * X[2 * a]!; ur += N * u[2 * n]!; uz += N * u[2 * n + 1]!; }
      s += rho[t]! * (ur * ur + uz * uz) * r * det * rule.wts[q]!;
    }
    for (let a = 0; a < k; a++) { const n = mech.cells.conn[k * t + a]!, v = Math.hypot(u[2 * n]!, u[2 * n + 1]!); if (v > umax) { umax = v; at = n; } }
  }
  return { mass: 2 * Math.PI * s, umax, at };
}

// ------------------------------------------------------------------------------------------------ axisym solid modes

export interface SolidModesInput {
  mesh: Mesh; mask: Uint8Array; D: (e: number) => Float64Array; rho: Float64Array; bcs: readonly SolidBc[];
  nModes: number; shiftHz: number | null; signal?: AbortSignal;
}
export interface SolidModes { freqs: Float64Array; u: Float64Array[]; dof: number; nnz: number; residual: number; solver: string; ms: Record<string, number> }

/**
 * Torsion-free axisymmetric solid modes K u = omega^2 M u with an arbitrary constitutive matrix per cell (MT's
 * assembleSolid; same scheme as elastic/modal.ts solveElasticModes, which takes isotropic E, nu only). Rigid modes
 * (z translation of a free body) are reported as f = 0 below 1e-8 of the spectral scale.
 */
export function solidModesAxisym(p: SolidModesInput): SolidModes {
  const m = p.mesh, nn = nNodes(m), t0 = performance.now();
  if (!m.axisym) throw new Error('optomechanical: the solid modes need an axisymmetric mesh');
  const { dm, active } = solidDofMap(m, p.mask);
  const pat = dofPattern(m, dm);
  const K = new Float64Array(pat.nnz), M = new Float64Array(pat.nnz);
  assembleSolid({ mesh: m, model: 'axisym', mask: p.mask, D: p.D, rho: p.rho, uDof: dm.map, pat, K, M });
  const { fixed } = solidConstraints(m, 'axisym', p.bcs.filter((b) => b.type === 'fixed' || b.type === 'roller'));
  const free = new Uint8Array(nn * 2);
  for (let v = 0; v < nn; v++) if (active[v]) for (let d = 0; d < 2; d++) free[2 * v + d] = fixed[2 * v + d] ? 0 : 1;
  const R = restrict(pat, K, free), Mr = restrict(pat, M, free).val;
  const lamScale = solidLambdaScale(m, p.mask, p.D, p.rho, 4);
  const positive = !!p.shiftHz && p.shiftHz > 0;
  const sigma = positive ? (2 * Math.PI * p.shiftHz!) ** 2 : -0.01 * lamScale;
  const t1 = performance.now();
  const eig = shiftInvertEigen({ pat: R.pat, K: R.val, M: Mr, sigma, nWant: p.nModes, kPsd: true, tol: 1e-10, ...(p.signal ? { signal: p.signal } : {}) });
  const t2 = performance.now();
  const order = Array.from(eig.lambda, (l, i) => [l, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const freqs = Float64Array.from(order, (i) => { const l = eig.lambda[i]!; return Math.abs(l) < 1e-8 * lamScale ? 0 : Math.sign(l) * Math.sqrt(Math.abs(l)) / (2 * Math.PI); });
  const u = order.map((i) => { const x = eig.vecs[i]!, out = new Float64Array(nn * 2); for (let r = 0; r < R.pat.n; r++) out[R.inv[r]!] = x[r]!; return out; });
  return { freqs, u, dof: R.pat.n, nnz: R.pat.nnz, residual: Math.max(0, ...eig.residual), solver: `axisym solid (MOM): shift-invert block Arnoldi, ${eig.stats.factor}`, ms: { assemble: t1 - t0, solve: t2 - t1 } };
}

/** Fix the arbitrary sign of a mode: the dominant component of u at the max-|u| node is made positive (in place). */
export function fixSign(u: Float64Array, at: number): void {
  if (at < 0) return;
  const d = Math.abs(u[2 * at]!) >= Math.abs(u[2 * at + 1]!) ? u[2 * at]! : u[2 * at + 1]!;
  if (d < 0) for (let i = 0; i < u.length; i++) u[i] = -u[i]!;
}


/** r-weighted cell mean of tr S = S_rr + S_phiphi + S_zz per solid cell (NaN elsewhere); used by the finite-difference gate. */
export function traceStrainCellMean(mech: Mesh, u: Float64Array, solid: Uint8Array): Float64Array {
  const type = mech.cells.type, k = NPC[type], rule = triRule(4), tab = shapeTable(type, rule);
  const X = new Float64Array(2 * k), G = new Float64Array(2 * k), out = new Float64Array(nCells(mech)).fill(NaN);
  for (let t = 0; t < nCells(mech); t++) {
    if (!solid[t]) continue;
    gatherX(mech.nodes, 2, mech.cells.conn, t, k, X);
    let s = 0, w = 0;
    for (let q = 0; q < rule.n; q++) {
      const det = physGrad(tab, q, X, 2, G);
      let r = 0, ur = 0, tr = 0;
      for (let a = 0; a < k; a++) { const N = tab.N[q * k + a]!, n = mech.cells.conn[k * t + a]!; r += N * X[2 * a]!; ur += N * u[2 * n]!; tr += G[2 * a]! * u[2 * n]! + G[2 * a + 1]! * u[2 * n + 1]!; }
      const wq = r * det * rule.wts[q]!;
      s += (tr + ur / r) * wq; w += wq;
    }
    out[t] = s / w;
  }
  return out;
}
