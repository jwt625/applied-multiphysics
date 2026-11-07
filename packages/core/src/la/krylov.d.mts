// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/krylov.mjs (hand-written 2026-11-06, audit S2).
import type { ComplexVector } from './types.d.mts';
/** y = A x for split complex vectors. */
export type ComplexOperator = (xr: Float64Array, xi: Float64Array, yr: Float64Array, yi: Float64Array) => void;
/** z = M^-1 r for split complex vectors. */
export type ComplexPrecond = (rr: Float64Array, ri: Float64Array, zr: Float64Array, zi: Float64Array) => void;
export interface ComplexGmresOptions {
  /** relative to ||b|| (unpreconditioned residual) */
  rtol?: number; maxIter?: number; restart?: number; x0?: ComplexVector | null;
  onIter?: ((iteration: number, relres: number) => void) | null;
  /** reusable Krylov workspace (pass the same object across calls of the same size) */
  work?: Record<string, unknown> | null;
}
/** Restarted right-preconditioned complex GMRES (Palace-derived). pc null = identity. */
export function gmres(op: ComplexOperator, pc: ComplexPrecond | null, br: Float64Array, bi: Float64Array, options?: ComplexGmresOptions):
  ComplexVector & { iterations: number; relres: number; converged: boolean; history: number[] };
