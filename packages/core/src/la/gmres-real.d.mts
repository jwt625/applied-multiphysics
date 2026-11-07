// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/gmres-real.mjs (hand-written 2026-11-06, audit S2).
import { SparseCholesky } from './sparse.mjs';
import type { CsrPattern, SymbolicAnalysis } from './types.d.mts';
/** Bernoulli function B(x) = x / (exp(x) - 1) and its derivative: [B, dB/dx]. */
export function bernoulli(x: number): number[];
export type RealOperator = (v: Float64Array, out: Float64Array) => void;
/** Restarted right-preconditioned GMRES: solve A x = b, x = M y. */
export function gmres(matvec: RealOperator, precond: RealOperator, b: Float64Array, options?: {
  tol?: number; restart?: number; maxIter?: number; x0?: Float64Array | null; work?: Record<string, unknown> | null;
}): { x: Float64Array; iterations: number; relres: number; converged: boolean };
export function norm2(v: ArrayLike<number>): number;
/** SPD block on a free subset of a node pattern, Jacobi-scaled, factorized by SparseCholesky. */
export class ScaledSpdBlock {
  constructor(pat: CsrPattern, isFree: ArrayLike<number>, options?: { sym?: SymbolicAnalysis | null });
  sub: { pat: CsrPattern; val: Float64Array; src: Int32Array; map: Int32Array; nf: number };
  n: number;
  chol: SparseCholesky;
  /** Factor from full-pattern values; throws when not positive definite. */
  factor(full: Float64Array): void;
  solve(b: Float64Array, out: Float64Array): Float64Array;
}
