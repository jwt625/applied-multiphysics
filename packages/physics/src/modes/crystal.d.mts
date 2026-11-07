// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of modes/crystal.mjs (port of eo-modulator-atlas engine/src/materials.mjs crystal-frame helpers at 0546007).
export type Mat3 = number[];
export const mat3: {
  mul(A: Mat3, B: Mat3): Mat3; T(A: Mat3): Mat3; diag(a: number, b: number, c: number): Mat3; identity(): Mat3;
  apply(A: Mat3, v: number[]): number[];
};
export function labFromCrystal(cut: string, propagation: string, rotationDeg?: number): Mat3;
export function pockelsVoigt(c: { r13: number; r22: number; r33: number; r51: number }): Float64Array;
export function deltaInvEpsCrystal(r: Float64Array, Ec: number[]): Mat3;
export function deltaEpsLab(r: Float64Array, A: Mat3, epsOptLab: Mat3, Elab: number[]): Mat3;
