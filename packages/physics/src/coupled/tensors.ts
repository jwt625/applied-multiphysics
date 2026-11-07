// SPDX-License-Identifier: GPL-3.0-or-later
// Crystal tensors for the monolithic couplings (lane MT, DevLog-033): stiffness C (6x6 Voigt, Pa), piezoelectric
// stress constants e (3x6, C/m^2) and permittivity (3x3) from independent components per symmetry, and their
// rotation to the model frame. Voigt order (xx, yy, zz, yz, xz, xy) with engineering shear strains, so C_IJ = c_ijkl
// and e_iJ = e_ikl without factors. Matrix forms (crystal frame; z = c / poling axis):
//   hexagonal-6mm (poled ceramics, e.g. PZT): C11 C12 C13 C33 C44, C66 = (C11 - C12) / 2; e31 e33 e15:
//     e = [[0, 0, 0, 0, e15, 0], [0, 0, 0, e15, 0, 0], [e31, e31, e33, 0, 0, 0]]
//   trigonal-3m (LiNbO3, LiTaO3; x = a axis, mirror plane = y-z, the convention of materials/ trigonal-3m r_eo):
//     C = [[C11, C12, C13, C14, 0, 0], [C12, C11, C13, -C14, 0, 0], [C13, C13, C33, 0, 0, 0],
//          [C14, -C14, 0, C44, 0, 0], [0, 0, 0, 0, C44, C14], [0, 0, 0, 0, C14, (C11 - C12) / 2]]
//     e = [[0, 0, 0, 0, e15, -e22], [-e22, e22, 0, e15, 0, 0], [e31, e31, e33, 0, 0, 0]]
//   tetragonal-4mm: as 6mm with an independent C66 (C11 C12 C13 C33 C44 C66; e15 e31 e33), e.g. for data sets that
//     list C66 apart from (C11 - C12) / 2;
//   cubic: C11 C12 C44; isotropic: from E, nu.
// Rotation: R (3x3) maps crystal-frame components to model-frame components (columns of R = crystal axes in the
// model frame); c'_ijkl = R_ia R_jb R_kc R_ld c_abcd, e'_ijk = R_ia R_jb R_kc e_abc, eps'_ij = R_ia R_jb eps_ab.
// Euler angles ZXZ: R = Rz(phi) Rx(theta) Rz(psi).

export type Mat = number[][];

export const STIFFNESS_COMPONENTS: Record<string, readonly string[]> = {
  'hexagonal-6mm': ['C11', 'C12', 'C13', 'C33', 'C44'],
  'tetragonal-4mm': ['C11', 'C12', 'C13', 'C33', 'C44', 'C66'],
  'trigonal-3m': ['C11', 'C12', 'C13', 'C14', 'C33', 'C44'],
  cubic: ['C11', 'C12', 'C44'],
};
export const PIEZO_COMPONENTS: Record<string, readonly string[]> = {
  'hexagonal-6mm': ['e15', 'e31', 'e33'],
  'tetragonal-4mm': ['e15', 'e31', 'e33'],
  'trigonal-3m': ['e15', 'e22', 'e31', 'e33'],
};
export const PERMITTIVITY_COMPONENTS: Record<string, readonly string[]> = { uniaxial: ['perp', 'par'] };

const get = (c: Record<string, number>, k: string): number => {
  const v = c[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`tensor component ${k} missing or N/A`);
  return v;
};

export function stiffnessMatrix(sym: string, c: Record<string, number>): Mat {
  if (sym === 'hexagonal-6mm') {
    const [a, b, d, z, f] = ['C11', 'C12', 'C13', 'C33', 'C44'].map((k) => get(c, k)) as [number, number, number, number, number];
    return [[a, b, d, 0, 0, 0], [b, a, d, 0, 0, 0], [d, d, z, 0, 0, 0], [0, 0, 0, f, 0, 0], [0, 0, 0, 0, f, 0], [0, 0, 0, 0, 0, (a - b) / 2]];
  }
  if (sym === 'tetragonal-4mm') {
    const [a, b, d, z, f, h] = ['C11', 'C12', 'C13', 'C33', 'C44', 'C66'].map((k) => get(c, k)) as [number, number, number, number, number, number];
    return [[a, b, d, 0, 0, 0], [b, a, d, 0, 0, 0], [d, d, z, 0, 0, 0], [0, 0, 0, f, 0, 0], [0, 0, 0, 0, f, 0], [0, 0, 0, 0, 0, h]];
  }
  if (sym === 'trigonal-3m') {
    const [a, b, d, g, z, f] = ['C11', 'C12', 'C13', 'C14', 'C33', 'C44'].map((k) => get(c, k)) as [number, number, number, number, number, number];
    return [[a, b, d, g, 0, 0], [b, a, d, -g, 0, 0], [d, d, z, 0, 0, 0], [g, -g, 0, f, 0, 0], [0, 0, 0, 0, f, g], [0, 0, 0, 0, g, (a - b) / 2]];
  }
  if (sym === 'cubic') {
    const [a, b, f] = ['C11', 'C12', 'C44'].map((k) => get(c, k)) as [number, number, number];
    return [[a, b, b, 0, 0, 0], [b, a, b, 0, 0, 0], [b, b, a, 0, 0, 0], [0, 0, 0, f, 0, 0], [0, 0, 0, 0, f, 0], [0, 0, 0, 0, 0, f]];
  }
  throw new Error(`stiffness symmetry '${sym}' not supported (${Object.keys(STIFFNESS_COMPONENTS).join(', ')})`);
}

export function isotropicStiffness(E: number, nu: number): Mat {
  const lam = (E * nu) / ((1 + nu) * (1 - 2 * nu)), mu = E / (2 * (1 + nu)), a = lam + 2 * mu;
  return [[a, lam, lam, 0, 0, 0], [lam, a, lam, 0, 0, 0], [lam, lam, a, 0, 0, 0], [0, 0, 0, mu, 0, 0], [0, 0, 0, 0, mu, 0], [0, 0, 0, 0, 0, mu]];
}

export function piezoMatrix(sym: string, c: Record<string, number>): Mat {
  if (sym === 'hexagonal-6mm' || sym === 'tetragonal-4mm') {
    const [e15, e31, e33] = ['e15', 'e31', 'e33'].map((k) => get(c, k)) as [number, number, number];
    return [[0, 0, 0, 0, e15, 0], [0, 0, 0, e15, 0, 0], [e31, e31, e33, 0, 0, 0]];
  }
  if (sym === 'trigonal-3m') {
    const [e15, e22, e31, e33] = ['e15', 'e22', 'e31', 'e33'].map((k) => get(c, k)) as [number, number, number, number];
    return [[0, 0, 0, 0, e15, -e22], [-e22, e22, 0, e15, 0, 0], [e31, e31, e33, 0, 0, 0]];
  }
  throw new Error(`piezoelectric symmetry '${sym}' not supported (${Object.keys(PIEZO_COMPONENTS).join(', ')})`);
}

export function permittivityMatrix(sym: string, c: Record<string, number>): Mat {
  if (sym === 'uniaxial') { const p = get(c, 'perp'), q = get(c, 'par'); return [[p, 0, 0], [0, p, 0], [0, 0, q]]; }
  throw new Error(`permittivity symmetry '${sym}' not supported (uniaxial)`);
}

export function eulerZXZ(phi: number, theta: number, psi: number): Mat {
  const rz = (a: number): Mat => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const rx = (a: number): Mat => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  return mul(mul(rz(phi), rx(theta)), rz(psi));
}

function mul(A: Mat, B: Mat): Mat {
  return A.map((row) => B[0]!.map((_, j) => row.reduce((s, a, k) => s + a * B[k]![j]!, 0)));
}

const VOIGT = [[0, 5, 4], [5, 1, 3], [4, 3, 2]];

export function rotateStiffness(C: Mat, R: Mat): Mat {
  const c = (i: number, j: number, k: number, l: number) => C[VOIGT[i]![j]!]![VOIGT[k]![l]!]!;
  const pairs = [[0, 0], [1, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
  return pairs.map(([i, j]) => pairs.map(([k, l]) => {
    let s = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      const rab = R[i!]![a]! * R[j!]![b]!;
      if (rab === 0) continue;
      for (let cc = 0; cc < 3; cc++) for (let d = 0; d < 3; d++) s += rab * R[k!]![cc]! * R[l!]![d]! * c(a, b, cc, d);
    }
    return s;
  }));
}

export function rotatePiezo(e: Mat, R: Mat): Mat {
  const t = (i: number, k: number, l: number) => e[i]![VOIGT[k]![l]!]!;
  const pairs = [[0, 0], [1, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
  return [0, 1, 2].map((i) => pairs.map(([k, l]) => {
    let s = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) s += R[i]![a]! * R[k!]![b]! * R[l!]![c]! * t(a, b, c);
    return s;
  }));
}

export function rotate2(A: Mat, R: Mat): Mat {
  return mul(mul(R, A), R[0]!.map((_, j) => R.map((row) => row[j]!)));
}
