// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/ams-real.mjs (hand-written 2026-11-18, lane E8 DevLog-054).
import type { CsrPattern } from './types.d.mts';
export interface CsrReal { n: number; m: number; rowptr: Int32Array; colidx: Int32Array; val: Float64Array }
export interface Preconditioner { apply(b: Float64Array, x: Float64Array): void; stats: Record<string, unknown> }
export function diagSlots(pat: CsrPattern): Int32Array;
export function spmvCsr(pat: CsrPattern, val: Float64Array, x: Float64Array, y: Float64Array): Float64Array;
/** Hiptmair-Xu AMS for the real SPD Whitney system (pat, val); G: discrete gradient; Pis: nodal interpolation x, y, z. */
export function buildAMSReal(o: { pat: CsrPattern; val: Float64Array; G: CsrReal; Pis: CsrReal[]; amg?: { theta?: number; coarseMax?: number; maxLevels?: number; sweeps?: number } }): Preconditioner;
/** Two-level p-multigrid (order 2 -> Whitney prefix of nc DOFs) with Hiptmair smoothing on the gradient space Gf. */
export function buildPMGReal(o: { pat: CsrPattern; val: Float64Array; nc: number; Gf: CsrReal; coarse: { apply(b: Float64Array, x: Float64Array): void } }): Preconditioner;
/** Leading principal block A[0:nc, 0:nc]. */
export function leadingBlock(pat: CsrPattern, val: Float64Array, nc: number): { pat: CsrPattern; val: Float64Array };
/** Preconditioned CG to ||b - A x|| <= rtol ||b|| (x: initial guess, overwritten). */
export function pcgCsr(pat: CsrPattern, val: Float64Array, precond: (r: Float64Array, z: Float64Array) => void, b: Float64Array, x: Float64Array, o?: { rtol?: number; maxIter?: number }): { iterations: number; relres: number; converged: boolean };
