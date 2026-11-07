// SPDX-License-Identifier: GPL-3.0-or-later
// Fourth-rank tensors of lane MOM (DevLog-034): cubic (m3m) stiffness and photoelastic tensors from their contracted
// constants, rotation about the z axis, the azimuthal average over phi (the part of a crystal tensor seen by an
// axisymmetric field), and the axisymmetric Voigt stiffness [rr, zz, phiphi, rz] (engineering shear) of MT's
// coupled/assemble.ts.
//
// Contracted notation: 11 -> 1, 22 -> 2, 33 -> 3, 23 -> 4, 13 -> 5, 12 -> 6, with engineering shear strain
// (S_4 = 2 S_23). Then T_iijj (i != j) = X12, T_iiii = X11, T_ijij = T_ijji = T_jiij = T_jiji = X44 (i != j) for both the
// stiffness C (sigma_I = C_IJ S_J) and the photoelastic tensor p (Delta(eps^-1)_I = p_IJ S_J): with tensor strain,
// Delta(eps^-1)_23 = p_2323 S_23 + p_2332 S_32 = 2 p44 S_23 = p44 S_4.
//
// Azimuthal average: frame (e_r, e_phi, e_z) at angle phi = crystal (x, y, z) rotated by phi about z. The rotated
// components are trigonometric polynomials of degree <= 4 in phi, so the N-point trapezoid average (N > 8) is exact.

/** Flat 3^4 tensor, index ((i * 3 + j) * 3 + k) * 3 + l. */
export type T4 = Float64Array;

const ix = (i: number, j: number, k: number, l: number) => ((i * 3 + j) * 3 + k) * 3 + l;

/** Cubic (m3m) tensor in its crystal frame from the contracted constants X11, X12, X44. */
export function cubicT4(x11: number, x12: number, x44: number): T4 {
  const t = new Float64Array(81);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    if (i === j) t[ix(i, i, i, i)] = x11;
    else {
      t[ix(i, i, j, j)] = x12;
      t[ix(i, j, i, j)] = x44; t[ix(i, j, j, i)] = x44;
    }
  }
  return t;
}

/** T'_ijkl = R_ia R_jb R_kc R_ld T_abcd with R the rotation by angle phi about z (rows: e_r, e_phi, e_z in crystal axes). */
export function rotateZ(t: T4, phi: number): T4 {
  const c = Math.cos(phi), s = Math.sin(phi);
  const R = [[c, s, 0], [-s, c, 0], [0, 0, 1]];
  // four successive single-index contractions
  let a = t;
  for (let slot = 0; slot < 4; slot++) {
    const b = new Float64Array(81);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) {
      const idx = [i, j, k, l];
      let v = 0;
      for (let q = 0; q < 3; q++) {
        const r = R[idx[slot]!]![q]!;
        if (!r) continue;
        const src = [...idx]; src[slot] = q;
        v += r * a[ix(src[0]!, src[1]!, src[2]!, src[3]!)]!;
      }
      b[ix(i, j, k, l)] = v;
    }
    a = b;
  }
  return a;
}

/** Azimuthal average of a crystal-frame tensor in the local cylindrical frame (r, phi, z), crystal z along the axis. */
export function azimuthalAverage(t: T4, n = 36): T4 {
  const out = new Float64Array(81);
  for (let q = 0; q < n; q++) { const r = rotateZ(t, (2 * Math.PI * q) / n); for (let i = 0; i < 81; i++) out[i]! += r[i]! / n; }
  return out;
}

/** Tensor component in the (r, phi, z) frame, indices 0 = r, 1 = phi, 2 = z. */
export const t4 = (t: T4, i: number, j: number, k: number, l: number): number => t[ix(i, j, k, l)]!;

/**
 * Axisymmetric constitutive matrix (4 x 4, row-major) of MT's Voigt order [rr, zz, phiphi, rz] (engineering shear
 * g_rz = 2 S_rz) from a stiffness tensor in the (r, phi, z) frame. Rows / columns use the tensor pairs (r r), (z z),
 * (phi phi), (r z); the shear column picks C_ij02 (sigma_ij = C_ij02 S_02 + C_ij20 S_20 = C_ij02 g_rz).
 */
export function axisymD(c: T4): Float64Array {
  const P = [[0, 0], [2, 2], [1, 1], [0, 2]] as const;
  const D = new Float64Array(16);
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) D[4 * a + b] = t4(c, P[a]![0], P[a]![1], P[b]![0], P[b]![1]);
  return D;
}

/** Largest relative asymmetry |D - D^T| / max |D| (check of the averaged stiffness). */
export function asym(D: Float64Array, n: number): number {
  let mx = 0, a = 0;
  for (let i = 0; i < n * n; i++) mx = Math.max(mx, Math.abs(D[i]!));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) a = Math.max(a, Math.abs(D[n * i + j]! - D[n * j + i]!));
  return a / mx;
}
