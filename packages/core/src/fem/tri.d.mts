// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of fem/tri.mjs (hand-written 2026-11-06, audit S2). The module is length-unit agnostic: areas and
// gradients are in mesh coordinate units (EO used um); the stiffness form is scale free in 2D, the optional mass term
// scales with area. C2 meshes are in metres.
import { SparseCholesky } from '../la/sparse.mjs';
import type { CsrPattern, SymbolicAnalysis, TriMesh, TriGeometry } from '../la/types.d.mts';
export type { TriMesh, TriGeometry } from '../la/types.d.mts';

export interface TriP2Space {
  kind: 'P2'; nV: number; nDof: number; nEdges: number;
  /** 6 DOFs per triangle: v0 v1 v2 m01 m12 m20 */
  elem: Int32Array; edgeA: Int32Array; edgeB: Int32Array;
  /** DOF coordinates (vertices, then edge midpoints) */
  x: Float64Array; y: Float64Array;
  pat: CsrPattern;
  edgeOf(a: number, b: number): number;
}
export interface RestrictedMatrix { pat: CsrPattern; val: Float64Array; src: Int32Array; map: Int32Array; nf: number }

export function triangleGeometry(mesh: TriMesh): TriGeometry;
/** K = sum_T A_T gradN^T C_T gradN (+ m_T (A/12)(1 + delta_ij)); cTri 3 per triangle (xx, xy, yy), mTri 1 per triangle. */
export function assemble(mesh: TriMesh, geo: TriGeometry, pat: CsrPattern, cTri: Float64Array | null, mTri: Float64Array | null, val?: Float64Array | null): Float64Array;
export function p2Space(mesh: TriMesh): TriP2Space;
/** Gradients of the 6 P2 shape functions at barycentric point L of triangle t. */
export function p2Grad(geo: TriGeometry, t: number, L: ArrayLike<number>, gxN: Float64Array, gyN: Float64Array): void;
export function assembleP2(mesh: TriMesh, geo: TriGeometry, space: TriP2Space, cTri: Float64Array, val?: Float64Array | null): Float64Array;
/** Restrict a full CSR matrix to the rows / columns with isFree[i] != 0. */
export function restrictMatrix(pat: CsrPattern, val: Float64Array, isFree: ArrayLike<number>): RestrictedMatrix;

/** Anisotropic Poisson div(eps grad phi) = 0 with Dirichlet DOFs (P1, or P2 with options.space). */
export class PoissonSolver {
  constructor(mesh: TriMesh, epsTri: Float64Array, isDirichlet: Uint8Array, geo?: TriGeometry | null, pat?: CsrPattern | null,
    options?: { sym?: SymbolicAnalysis | null; space?: TriP2Space | null });
  mesh: TriMesh;
  geo: TriGeometry;
  space: TriP2Space | null;
  pat: CsrPattern;
  epsTri: Float64Array;
  K: Float64Array;
  isDirichlet: Uint8Array;
  sub: RestrictedMatrix;
  chol: SparseCholesky;
  timing: { setup_ms: number; assemble_ms: number; restrict_ms: number; ordering_ms: number; nFree: number; chol: SparseCholesky['timing'] };
  /** phiD: values at Dirichlet DOFs (full length). residual = K phi (terminal charge at Dirichlet DOFs). */
  solve(phiD: Float64Array): { phi: Float64Array; residual: Float64Array };
  /** phi^T K phi */
  energyForm(phi: Float64Array): number;
  triEnergyForm(phi: Float64Array): Float64Array;
  /** Gradient per triangle (P2: at the centroid). */
  gradient(phi: Float64Array): { gx: Float64Array; gy: Float64Array };
}
