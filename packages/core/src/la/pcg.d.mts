// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/pcg.mjs (hand-written 2026-11-06, audit S2).
import type { StencilOp, BlockStencilOp, Precond } from './types.d.mts';
export interface PcgOptions {
  /** stop when ||r|| <= rtol ||b - A x0|| (ref 'r0', default) or rtol ||b|| (ref 'b') */
  rtol?: number; maxIter?: number;
  /** padded null-space vectors (e.g. block.rigidBodyModes of a floating body) */
  nullspace?: Float64Array[] | null;
  ref?: 'r0' | 'b';
}
export interface PcgResult { iterations: number; relres: number; converged: boolean; history: number[]; inconsistency: number }
/** Solve A x = b on padded vectors for a scalar stencil or a 3-DOF block operator; x is the initial guess. */
export function pcg(op: StencilOp | BlockStencilOp, precond: Precond, b: Float64Array, x: Float64Array, options?: PcgOptions): PcgResult;
/** Jacobi preconditioner of a scalar stencil operator. */
export function jacobiPrecond(op: StencilOp): Precond;
