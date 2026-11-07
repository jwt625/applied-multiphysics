// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/sparse.mjs (hand-written 2026-11-06, audit S2; replaces the tsc-generated baseline).
import type { CsrPattern, SymbolicAnalysis, AnalyzeOptions, NumericFactor } from './types.d.mts';
export type { CsrPattern, SymbolicAnalysis, AnalyzeOptions, NumericFactor } from './types.d.mts';
import type { RealFactorKind } from './wasm/front-real.mjs';

export const timingSink: { records: Array<{ kind: string; [k: string]: unknown }> | null };
export function recordTiming(kind: string, timing: Record<string, unknown>): void;
/** Symmetric CSR pattern from triangle connectivity (3 vertices per triangle). */
export function buildPattern(n: number, tri: Int32Array): CsrPattern;
/** Symmetric CSR pattern of elements with k DOFs each. */
export function buildElementPattern(n: number, elem: Int32Array, k: number): CsrPattern;
/** CSR slots of the k x k local entries of every element (row-major), cached on the pattern. */
export function elementSlots(pat: CsrPattern, elem: Int32Array, k: number): Int32Array;
/** CSR slots of the 3 x 3 local entries of every triangle. */
export function triangleSlots(pat: CsrPattern, tri: Int32Array): Int32Array;
/** Index of entry (i, j), -1 when absent. */
export function entryIndex(pat: CsrPattern, i: number, j: number): number;
export function matVec(pat: CsrPattern, val: Float64Array, x: Float64Array, out?: Float64Array | null): Float64Array;
/** Nested dissection by coordinate bisection; perm new -> old. */
export function ndOrder(pat: CsrPattern, x: Float64Array, y: Float64Array, leaf?: number): Int32Array;
/** Approximate minimum degree; perm new -> old. */
export function amdOrder(pat: CsrPattern, options?: { denseFactor?: number }): Int32Array;
export function analyze(pat: CsrPattern, opts?: AnalyzeOptions): SymbolicAnalysis;
export function patternFingerprint(pat: CsrPattern): string;
export function checkSymbolic(sym: SymbolicAnalysis, pat: CsrPattern): void;
/** `factor`: real front kernel ('blocked' JS, 'wasm' SIMD; default ldlt-select DEFAULT_REAL_FACTOR); bitwise-identical results. */
export function factorNumeric(sym: SymbolicAnalysis, values: Float64Array, num?: NumericFactor | null, pat?: CsrPattern | null, options?: { factor?: RealFactorKind | null }): NumericFactor;
export function solveNumeric(num: NumericFactor, b: Float64Array, out?: Float64Array | null): Float64Array;
export function solveNumericMulti(num: NumericFactor, bs: Float64Array[], outs?: Float64Array[] | null): Float64Array[];

/** Supernodal multifrontal Cholesky of an SPD matrix on a fixed pattern; factor() may be repeated. */
export class SparseCholesky {
  constructor(pat: CsrPattern, perm?: Int32Array | null, options?: { sym?: SymbolicAnalysis | null; ordering?: 'amd' | 'nd'; x?: Float64Array | null; y?: Float64Array | null; factor?: RealFactorKind | null });
  /** requested real front kernel; null: DEFAULT_REAL_FACTOR at each factor() */
  factorKind: RealFactorKind | null;
  sym: SymbolicAnalysis;
  n: number;
  perm: Int32Array;
  nnzL: number;
  num: NumericFactor | null;
  ok: boolean;
  timing: {
    n: number; nnzA: number; nnzL: number; fill: number; flops: number; nsuper: number; symbolicReused: boolean;
    ordering_ms: number; symbolic_ms: number; factor_ms: number; nFactor: number; solve_ms: number; nSolve: number;
    /** kernel of the last factor() ('wasm' falls back to 'blocked' without SIMD) */
    kernel?: RealFactorKind;
  };
  /** false when the matrix is not positive definite. */
  factor(values: Float64Array): boolean;
  solve(b: Float64Array, out?: Float64Array | null): Float64Array;
  solveMany(bs: Float64Array[], outs?: Float64Array[] | null): Float64Array[];
}
/** Up-looking Cholesky (test oracle). */
export class UpLookingCholesky {
  constructor(pat: CsrPattern, perm: Int32Array);
  n: number;
  perm: Int32Array;
  Lp: Int32Array;
  Li: Int32Array;
  Lx: Float64Array;
  nnzL: number;
  ok: boolean;
  timing: { n: number; nnzA: number; nnzL: number; fill: number; symbolic_ms: number; factor_ms: number; nFactor: number; solve_ms: number; nSolve: number };
  factor(values: Float64Array): boolean;
  solve(b: Float64Array, out?: Float64Array | null): Float64Array;
}
/** Convenience: SparseCholesky of an SPD matrix (throws when not positive definite); x, y unused. */
export function cholesky(pat: CsrPattern, val: Float64Array, x?: unknown, y?: unknown): SparseCholesky;
/** Jacobi eigenvalue iteration for a symmetric dense p x p matrix (row-major). */
export function jacobiEigen(A: ArrayLike<number>, p: number): { values: number[]; vectors: Float64Array };
