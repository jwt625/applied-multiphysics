// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/ldlt.mjs (hand-written 2026-11-06, audit S2; replaces the tsc-generated baseline).
// Up-looking classes (LDLT, ComplexLDLT) take a SymbolicLDLT; supernodal classes take sparse.analyze() output.
import type { CsrPattern, SymbolicAnalysis, LdltFactorResult, ComplexVector } from './types.d.mts';
import type { RealFactorKind } from './wasm/front-real.mjs';

export interface PivotOptions { pivotTol?: number }
export interface RefineOptions { maxSteps?: number; tol?: number }

/** Symbolic analysis for the up-looking LDL^T (perm new -> old). */
export class SymbolicLDLT {
  constructor(pat: CsrPattern, perm: Int32Array);
  n: number;
  perm: Int32Array;
  pinv: Int32Array;
  parent: Int32Array;
  Lp: Int32Array;
  nnzL: number;
}
export class LDLT {
  constructor(sym: SymbolicLDLT);
  sym: SymbolicLDLT;
  D: Float64Array;
  nNeg: number;
  nPerturbed: number;
  factor(values: Float64Array, options?: PivotOptions): LdltFactorResult;
  solve(b: Float64Array, out?: Float64Array | null): Float64Array;
  /** m right-hand sides stored column after column (length n m). */
  solveMany(b: Float64Array, m: number, out?: Float64Array | null): Float64Array;
  solveRefined(pat: CsrPattern, values: Float64Array, b: Float64Array, options?: RefineOptions): { x: Float64Array; relResidual: number; steps: number };
}
export class ComplexLDLT {
  constructor(sym: SymbolicLDLT);
  sym: SymbolicLDLT;
  nPerturbed: number;
  factor(re: Float64Array, im: Float64Array, options?: PivotOptions): LdltFactorResult;
  solve(br: Float64Array, bi: Float64Array): ComplexVector;
  solveRefined(pat: CsrPattern, re: Float64Array, im: Float64Array, br: Float64Array, bi: Float64Array, options?: RefineOptions): ComplexVector & { relResidual: number; steps: number };
}
export class SupernodalLDLT {
  /** `factor`: real front kernel ('blocked' JS, 'wasm' SIMD; default ldlt-select DEFAULT_REAL_FACTOR); bitwise-identical results. */
  constructor(sym: SymbolicAnalysis, options?: { factor?: RealFactorKind | null });
  sym: SymbolicAnalysis;
  factorKind: RealFactorKind | null;
  /** kernel of the last factor() */
  kernel: RealFactorKind;
  D: Float64Array;
  nNeg: number;
  nPerturbed: number;
  factor(values: Float64Array, options?: PivotOptions): LdltFactorResult;
  solve(b: Float64Array, out?: Float64Array | null): Float64Array;
  /** q right-hand sides stored column after column (length n q). */
  solveMany(b: Float64Array, q: number, out?: Float64Array | null): Float64Array;
  solveRefined(pat: CsrPattern, values: Float64Array, b: Float64Array, options?: RefineOptions): { x: Float64Array; relResidual: number; steps: number };
}
export class ComplexSupernodalLDLT {
  constructor(sym: SymbolicAnalysis);
  sym: SymbolicAnalysis;
  nPerturbed: number;
  factor(re: Float64Array, im: Float64Array, options?: PivotOptions): LdltFactorResult;
  solve(br: Float64Array, bi: Float64Array): ComplexVector;
  solveRefined(pat: CsrPattern, re: Float64Array, im: Float64Array, br: Float64Array, bi: Float64Array, options?: RefineOptions): ComplexVector & { relResidual: number; steps: number };
}
