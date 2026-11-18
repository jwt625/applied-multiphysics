// SPDX-License-Identifier: GPL-3.0-or-later
// 2D scattering width from the FE scattered field (DevLog-042 s.1.5, s.1.6). Green's representation of a radiating
// solution of (lap + k^2) u = 0 outside a closed curve C around the scatterers (Colton and Kress, Inverse Acoustic and
// Electromagnetic Scattering Theory, Thm. 2.5 in 3D; same form in 2D with Phi = (i/4) H0^(1), here exp(+j w t) so
// Phi = -(j/4) H0^(2)) gives the far field u_s ~ C0 exp(-j k rho) / sqrt(rho) I(phi), C0 = -(j/4) sqrt(2/(pi k)) e^{j pi/4},
//   I(phi) = int_C (u_s dn g - g dn u_s) ds,  g = exp(j k xhat . y).
// The contour integral is written as a band integral with a C1 taper psi (1 inside, 0 outside the band B):
//   I(phi) = -int_B grad psi . (u_s grad g - g grad u_s) dA,
// which needs no normal derivatives on a contour. sigma_2D(phi) = lim 2 pi rho |u_s|^2 / |U0|^2 = |I|^2 / (4 k |U0|^2).

import type { Mesh } from '@amp/spec/types';
import { NPC, nCells } from '../common/mesh.ts';
import { defaultRule, gatherX, physGrad, shapeTable } from '../common/lagrange.ts';
import type { Box } from './pml.ts';

export interface FarFieldInput {
  mesh: Mesh;
  active: Uint8Array;
  /** cells that are not background (scatterers) or PML: not allowed in the band */
  notBackground: (c: number) => boolean;
  usRe: Float64Array; usIm: Float64Array;
  k: number;
  amp: number;
  inner: Box;
  /** points (x, y pairs) that must lie inside the band's inner edge (scatterer extent) */
  scatPts: Float64Array;
  angles: Float64Array;
}

export interface FarFieldResult { sigma: Float64Array; bandQ: [number, number]; nBandCells: number }

const P = 6;

export function farField(o: FarFieldInput): FarFieldResult {
  const { mesh, inner: I } = o;
  const xc = (I.x0 + I.x1) / 2, yc = (I.y0 + I.y1) / 2, Hx = (I.x1 - I.x0) / 2, Hy = (I.y1 - I.y0) / 2;
  const qOf = (x: number, y: number) => Math.pow(Math.pow(Math.abs(x - xc) / Hx, P) + Math.pow(Math.abs(y - yc) / Hy, P), 1 / P);
  let qs = 0;
  for (let i = 0; i < o.scatPts.length / 2; i++) qs = Math.max(qs, qOf(o.scatPts[2 * i]!, o.scatPts[2 * i + 1]!));
  if (!(qs < 0.9)) throw new Error(`scattering width: the scatterers reach q = ${qs.toFixed(3)} of the non-PML box (need < 0.9 to fit a band of background medium)`);
  const q1 = qs + 0.1 * (1 - qs), q2 = 1 - 0.1 * (1 - qs);
  const k = NPC[mesh.cells.type], nc = nCells(mesh);
  const ord = mesh.cells.type === 'tri6' ? 2 : 1;
  const tab = shapeTable(mesh.cells.type, defaultRule(mesh.cells.type, 2 * ord + 2));
  const X = new Float64Array(2 * k), G = new Float64Array(2 * k);
  const pts: number[] = [];   // per point: x, y, Pre, Pim (w u), Qre, Qim (w grad psi . grad u), psx, psy
  let nBand = 0;
  for (let c = 0; c < nc; c++) {
    if (!o.active[c]) continue;
    gatherX(mesh.nodes, 2, mesh.cells.conn, c, k, X);
    let inBand = false;
    for (let a = 0; a < 3; a++) { const q = qOf(X[2 * a]!, X[2 * a + 1]!); if (q > q1 && q < q2) inBand = true; }
    // a cell can straddle the band without a vertex in it only if it is larger than the band: check the centroid too
    const qcen = qOf((X[0]! + X[2]! + X[4]!) / 3, (X[1]! + X[3]! + X[5]!) / 3);
    if (qcen > q1 && qcen < q2) inBand = true;
    if (!inBand) continue;
    if (o.notBackground(c)) throw new Error(`scattering width: cell ${c} in the far-field band is not background medium (q band ${q1.toFixed(3)}-${q2.toFixed(3)} of the non-PML box)`);
    nBand++;
    for (let qq = 0; qq < tab.rule.n; qq++) {
      const det = physGrad(tab, qq, X, 2, G);
      const w = det * tab.rule.wts[qq]!;
      const Nq = tab.N.subarray(qq * k, qq * k + k);
      let x = 0, y = 0, ur = 0, ui = 0, gxr = 0, gxi = 0, gyr = 0, gyi = 0;
      for (let a = 0; a < k; a++) {
        const n = mesh.cells.conn[k * c + a]!;
        x += Nq[a]! * X[2 * a]!; y += Nq[a]! * X[2 * a + 1]!;
        ur += Nq[a]! * o.usRe[n]!; ui += Nq[a]! * o.usIm[n]!;
        gxr += G[2 * a]! * o.usRe[n]!; gxi += G[2 * a]! * o.usIm[n]!;
        gyr += G[2 * a + 1]! * o.usRe[n]!; gyi += G[2 * a + 1]! * o.usIm[n]!;
      }
      const q = qOf(x, y);
      if (!(q > q1 && q < q2)) continue;
      const t = (q - q1) / (q2 - q1);
      const dpsi = (-Math.PI / 2) * Math.sin(Math.PI * t) / (q2 - q1);
      const qp = Math.pow(q, 1 - P);
      const dqx = qp * Math.pow(Math.abs(x - xc), P - 1) * Math.sign(x - xc) / Math.pow(Hx, P);
      const dqy = qp * Math.pow(Math.abs(y - yc), P - 1) * Math.sign(y - yc) / Math.pow(Hy, P);
      const psx = dpsi * dqx, psy = dpsi * dqy;
      pts.push(x, y, w * ur, w * ui, w * (psx * gxr + psy * gyr), w * (psx * gxi + psy * gyi), psx, psy);
    }
  }
  const np = pts.length / 8;
  const kk = o.k;
  // I(phi) is band-limited: exp(j k r cos(phi - theta)) has harmonics |n| <= k r_max (+ a decaying tail), so I is
  // evaluated directly at M equispaced angles and trigonometrically interpolated to the requested ones
  let rMax = 0;
  for (let p = 0; p < np; p++) rMax = Math.max(rMax, Math.hypot(pts[8 * p]! - xc, pts[8 * p + 1]! - yc));
  const nh = Math.ceil(kk * rMax + 16);
  const M = 2 * nh + 1;
  const direct = (phi: number): [number, number] => {
    const cx = Math.cos(phi), cy = Math.sin(phi);
    let Ir = 0, Ii = 0;
    for (let p = 0; p < np; p++) {
      const b = 8 * p;
      // phase about the band centre (xc, yc); the common factor exp(j k xhat . c) has modulus 1
      const ph = kk * ((pts[b]! - xc) * cx + (pts[b + 1]! - yc) * cy);
      const gr = Math.cos(ph), gi = Math.sin(ph);
      // term = P j k (xhat . grad psi) - Q
      const s = kk * (cx * pts[b + 6]! + cy * pts[b + 7]!);
      const tr = -pts[b + 3]! * s - pts[b + 4]!, ti = pts[b + 2]! * s - pts[b + 5]!;
      Ir -= tr * gr - ti * gi; Ii -= tr * gi + ti * gr;
    }
    return [Ir, Ii];
  };
  const sigma = new Float64Array(o.angles.length);
  const norm = 4 * kk * o.amp * o.amp;
  if (M >= o.angles.length) {
    for (let ia = 0; ia < o.angles.length; ia++) { const [r, i] = direct(o.angles[ia]!); sigma[ia] = (r * r + i * i) / norm; }
  } else {
    const Sr = new Float64Array(M), Si = new Float64Array(M);
    for (let m = 0; m < M; m++) [Sr[m], Si[m]] = direct((2 * Math.PI * m) / M);
    const cr = new Float64Array(M), ci = new Float64Array(M);   // c_n, n = -nh..nh at index n + nh
    for (let n = -nh; n <= nh; n++) {
      let r = 0, i = 0;
      for (let m = 0; m < M; m++) { const a = (-2 * Math.PI * n * m) / M; const c = Math.cos(a), s = Math.sin(a); r += Sr[m]! * c - Si[m]! * s; i += Sr[m]! * s + Si[m]! * c; }
      cr[n + nh] = r / M; ci[n + nh] = i / M;
    }
    for (let ia = 0; ia < o.angles.length; ia++) {
      const phi = o.angles[ia]!;
      let r = 0, i = 0;
      for (let n = -nh; n <= nh; n++) { const c = Math.cos(n * phi), s = Math.sin(n * phi); r += cr[n + nh]! * c - ci[n + nh]! * s; i += cr[n + nh]! * s + ci[n + nh]! * c; }
      sigma[ia] = (r * r + i * i) / norm;
    }
  }
  return { sigma, bandQ: [q1, q2], nBandCells: nBand };
}
