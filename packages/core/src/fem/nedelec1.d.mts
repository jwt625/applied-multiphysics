// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of fem/nedelec1.mjs (hand-written 2026-11-06, audit S2).
import type { DiagComplexTensor } from '../la/types.d.mts';
/** Volume (m^3) of tet v (4 vertex indices into nodes, metres); writes the 12 barycentric gradient components to g. */
export function tetGeometry(nodes: Float64Array, v: ArrayLike<number>, g: Float64Array): number;
/** Whitney curl-curl S (nu) and mass M (eps), 6 x 6 row-major, complex split into re / im. */
export function tetMatrices(g: Float64Array, V: number, nu: DiagComplexTensor, eps: DiagComplexTensor, Sre: Float64Array, Sim: Float64Array, Mre: Float64Array, Mim: Float64Array): void;
export const FACE_EDGES: number[][];
/** Tangential face mass (3 x 3) of a triangle (vertices sorted ascending). */
export function faceMass(nodes: Float64Array, v: ArrayLike<number>): { T: Float64Array; area: number; grads: number[][] };
