// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of fem/tri-fe.mjs (hand-written 2026-11-06, audit S1 / S2). lengthScale = metres per mesh coordinate
// unit (default 1: SI metres; UM for micrometre meshes as in APA em2d).
import type { CsrPattern, TriMesh, TriGeometry } from '../la/types.d.mts';
export const UM2: number;
export const UM: number;
export interface TriLagrangeSpace {
  kind: 'P1' | 'P2';
  /** DOFs per triangle (3 or 6) */
  k: 3 | 6;
  nV: number; nDof: number; elem: Int32Array; x: Float64Array; y: Float64Array; pat: CsrPattern;
  nEdges?: number; edgeA?: Int32Array; edgeB?: Int32Array;
}
export function triangleGeometry(mesh: TriMesh): TriGeometry;
export function p1Space(mesh: TriMesh): TriLagrangeSpace;
export function p2Space(mesh: TriMesh): TriLagrangeSpace;
export function makeSpace(mesh: TriMesh, order: 1 | 2): TriLagrangeSpace;
export function p2Grad(geo: TriGeometry, t: number, L: ArrayLike<number>, gxN: Float64Array, gyN: Float64Array): void;
/** Unit-coefficient Laplace element matrix into Ke (k x k row-major); buf: {gxN, gyN} of length 6 for P2. */
export function elementStiffness(space: TriLagrangeSpace, geo: TriGeometry, t: number, Ke: Float64Array, buf: { gxN: Float64Array; gyN: Float64Array }): Float64Array;
/** Unit-coefficient mass matrix (m^2). */
export function elementMass(space: TriLagrangeSpace, geo: TriGeometry, t: number, Me: Float64Array, lengthScale?: number): Float64Array;
/** Load vector int N_a dA (m^2). */
export function elementLoad(space: TriLagrangeSpace, geo: TriGeometry, t: number, fe: Float64Array, lengthScale?: number): Float64Array;
/** One stiffness and / or mass value array per tag on space.pat; triTag[t] = tag or -1. */
export function assembleByTag(space: TriLagrangeSpace, geo: TriGeometry, triTag: ArrayLike<number>, nTags: number,
  options?: { stiffness?: boolean; mass?: boolean; coefM?: ArrayLike<number> | null; lengthScale?: number }): { K: Float64Array[] | null; M: Float64Array[] | null };
export function restrictPattern(pat: CsrPattern, isFree: ArrayLike<number>): { pat: CsrPattern; src: Int32Array; map: Int32Array; nf: number };
/** y = A x, complex CSR values (im may be null) and complex x. */
export function cmatvec(pat: CsrPattern, re: Float64Array, im: Float64Array | null, xr: Float64Array, xi: Float64Array, yr: Float64Array, yi: Float64Array): void;
