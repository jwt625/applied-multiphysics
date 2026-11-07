// Ported from eo-modulator-atlas/engine/src/materials.mjs at 0546007 (GPL-3.0-or-later). Changes: only the crystal-frame part (AXIS, cross, dot3, mat3, labFromCrystal, pockelsVoigt, deltaInvEpsCrystal, deltaEpsLab); pockelsVoigt takes SI coefficients (m/V) as {r13, r22, r33, r51} and every one is required (no default 0); material library, dispersion and config resolution removed.
// SPDX-License-Identifier: GPL-3.0-or-later
// Crystal frame -> lab frame. Lab frame: x lateral, y film normal (up), z propagation. Crystal axes 1,2,3 = x,y,z (c axis = 3).

const AXIS = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
  '+x': [1, 0, 0],
  '+y': [0, 1, 0],
  '+z': [0, 0, 1],
  '-x': [-1, 0, 0],
  '-y': [0, -1, 0],
  '-z': [0, 0, -1],
};

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 3x3 helpers (row-major arrays of 9). */
export const mat3 = {
  mul(A, B) {
    const C = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[3 * i + j] += A[3 * i + k] * B[3 * k + j];
    return C;
  },
  T(A) {
    return [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
  },
  diag(a, b, c) {
    return [a, 0, 0, 0, b, 0, 0, 0, c];
  },
  identity() {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  },
  apply(A, v) {
    return [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
  },
};

/**
 * Rotation A with v_lab = A v_crystal for a film cut (axis along lab y) and propagation (lab z).
 * lab_x = n x p so that (x,y,z) is right handed.
 * @param {string} cut crystal axis normal to the film (x|y|z, optional sign)
 * @param {string} propagation crystal axis of propagation
 * @param {number} [rotationDeg] CCW rotation of the LAB frame about the propagation axis (lab z), seen from +z:
 *   new lab axes x' = cos(t) x + sin(t) y, y' = -sin(t) x + cos(t) y, with x, y the unrotated lab axes (y = film
 *   normal). Equivalently the crystal turns clockwise relative to the lab.
 */
export function labFromCrystal(cut, propagation, rotationDeg = 0) {
  const n = AXIS[String(cut).toLowerCase()];
  const p = AXIS[String(propagation).toLowerCase()];
  if (!n || !p) throw new Error(`crystal cut/propagation must be one of x,y,z (optionally signed); got ${cut}, ${propagation}`);
  if (Math.abs(dot3(n, p)) > 1e-12) throw new Error('crystal cut and propagation axes must be orthogonal');
  if (typeof rotationDeg !== 'number' || !Number.isFinite(rotationDeg)) throw new Error(`crystal rotation_deg must be a finite number; got ${rotationDeg}`);
  const lx = cross(n, p);
  let A = [...lx, ...n, ...p];
  if (rotationDeg) {
    const th = (rotationDeg * Math.PI) / 180;
    const c = Math.cos(th),
      s = Math.sin(th);
    // Rows of A are the lab axes in crystal coordinates: row0' = c row0 + s row1, row1' = -s row0 + c row1.
    A = mat3.mul([c, s, 0, -s, c, 0, 0, 0, 1], A);
  }
  return A;
}

/**
 * Pockels tensor of a trigonal 3m crystal, 6x3 Voigt rows (xx, yy, zz, yz, xz, xy) x field (x, y, z), crystal frame,
 * SI (m/V), as a flat Float64Array(18):
 *  row(11)=[0,-r22,r13] row(22)=[0,r22,r13] row(33)=[0,0,r33] row(23)=[0,r51,0] row(13)=[r51,0,0] row(12)=[-r22,0,0].
 * @param {{r13:number, r22:number, r33:number, r51:number}} c
 */
export function pockelsVoigt(c) {
  const g = (k) => {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Pockels coefficient ${k} missing or not finite`);
    return v;
  };
  const r13 = g('r13'),
    r22 = g('r22'),
    r33 = g('r33'),
    r51 = g('r51');
  const r = new Float64Array(18);
  const set = (i, k, v) => (r[3 * i + k] = v);
  set(0, 1, -r22);
  set(0, 2, r13);
  set(1, 1, r22);
  set(1, 2, r13);
  set(2, 2, r33);
  set(3, 1, r51);
  set(4, 0, r51);
  set(5, 0, -r22);
  return r;
}

/** Delta(1/eps) 3x3 in the crystal frame for crystal-frame field Ec (V/m). */
export function deltaInvEpsCrystal(r, Ec) {
  const d = new Array(6).fill(0);
  for (let i = 0; i < 6; i++) d[i] = r[3 * i] * Ec[0] + r[3 * i + 1] * Ec[1] + r[3 * i + 2] * Ec[2];
  return [d[0], d[5], d[4], d[5], d[1], d[3], d[4], d[3], d[2]];
}

/**
 * First-order optical permittivity change in the lab frame for a lab-frame static field Elab (V/m):
 *   d(eps) = - eps * d(1/eps) * eps   (all in lab frame)
 * @param {Float64Array|number[]} r 6x3 Voigt (m/V), crystal frame
 * @param {number[]} A lab-from-crystal rotation
 * @param {number[]} epsOptLab 3x3 optical permittivity (n^2) in lab frame
 * @param {number[]} Elab
 */
export function deltaEpsLab(r, A, epsOptLab, Elab) {
  const Ec = mat3.apply(mat3.T(A), Elab);
  const dc = deltaInvEpsCrystal(r, Ec);
  const dl = mat3.mul(mat3.mul(A, dc), mat3.T(A));
  const t = mat3.mul(mat3.mul(epsOptLab, dl), epsOptLab);
  return t.map((v) => -v);
}
