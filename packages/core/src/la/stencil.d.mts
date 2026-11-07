// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/stencil.mjs (hand-written 2026-11-06, audit S2; replaces the tsc-generated baseline).
import { SparseCholesky } from './sparse.mjs';
import type { CsrPattern, StencilOp } from './types.d.mts';
export type { StencilOp } from './types.d.mts';
export const S_CENTER: 13;
export const S_ZM: 4;
export const S_ZP: 22;
/** Stencil slot of the coupling to node (i + di, j + dj, k + dk); di, dj, dk in {-1, 0, 1}. */
export function slot(di: number, dj: number, dk: number): number;
export function stencilOffsets(NX: number, NY: number): Int32Array;
/** Empty stencil operator on NX x NY x NZ nodes. */
export function createStencil(NX: number, NY: number, NZ: number): StencilOp;
/** Padded vector (length N + 2 pad) for applyStencil / pcg / mgPrecond. */
export function padded(op: StencilOp): Float64Array;
/** y = A x on padded vectors. */
export function applyStencil(op: StencilOp, x: Float64Array, y: Float64Array): Float64Array;
export function stencilAsymmetry(op: StencilOp): number;
/** CSR of the free-node block; map: node -> free index (-1 fixed), inv: free index -> node. */
export function stencilToCSR(op: StencilOp): { pat: CsrPattern; val: Float64Array; map: Int32Array; inv: Int32Array };
export function gridNDOrder(NX: number, NY: number, NZ: number, map: Int32Array, leaf?: number): Int32Array;
/** Direct solver on the free block of a stencil operator. */
export class StencilCholesky {
  constructor(op: StencilOp, options?: { ordering?: 'nd' | 'amd' });
  op: StencilOp;
  map: Int32Array;
  inv: Int32Array;
  chol: SparseCholesky;
  timing: { csr_ordering_symbolic_ms: number; factor_ms: number; nnzL: number; n: number; nnzA: number };
  /** x_free = A_ff^-1 b_free on padded vectors; fixed nodes get b. */
  solvePadded(b: Float64Array, x: Float64Array): Float64Array;
}
