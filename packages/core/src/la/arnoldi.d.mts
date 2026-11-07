// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/arnoldi.mjs (hand-written 2026-11-06, audit S2).
import type { Complex } from './complex.mjs';
/** Linear operator on a block of vectors (e.g. shift-invert X -> (A + sigma B)^-1 B X). */
export type BlockOperator = (X: Float64Array[]) => Float64Array[];
export interface BlockArnoldiOptions {
  nWant: number; blockSize: number; maxBasis: number; tol: number;
  /** warm start vectors (folded into blockSize columns) */
  X0: Float64Array[] | null;
  maxRestarts: number; seed: number;
  /** true: real Ritz values only (symmetric-type problems) */
  realOnly: boolean;
  nKeep?: number;
  /** basis size of the first cycle (EO adaptive shift) */
  firstCycleBasis?: number;
  /** called once at the first restart with the Ritz values; return true to stop there (switched = true) */
  onFirstRestart?: (mu: Complex[]) => boolean;
}
export interface RitzVector { re: Float64Array; im: Float64Array | null }
export interface BlockArnoldiResult {
  /** eigenvalues of largest modulus of the operator */
  mu: Complex[]; vecs: RitzVector[]; ritzRes: number[];
  basis: number; opVectors: number; restarts: number; converged: boolean; switched?: boolean;
}
/** Block Arnoldi with DGKS reorthogonalisation and thick restart (EO vector-mode). */
export function blockArnoldi(N: number, op: BlockOperator, o: BlockArnoldiOptions): BlockArnoldiResult;
/** Ritz pairs of the leading m x m block of the Hessenberg matrix H (leading dimension ld). */
export function ritz(H: Float64Array, ld: number, m: number, V: Float64Array[], o: BlockArnoldiOptions, formVectors: boolean): { mu: Complex[]; vecs: RitzVector[]; ritzRes: number[]; converged: boolean };
/** Orthonormal basis (m x k, row-major) of the nKeep dominant Ritz vectors of H_m. */
export function ritzBasis(H: Float64Array, ld: number, m: number, nKeep: number, realOnly: boolean): { k: number; Q: Float64Array; Hm: Float64Array };
/** Deterministic LCG in [-0.5, 0.5). */
export function seededRandom(seed: number): () => number;
export function dotv(a: ArrayLike<number>, b: ArrayLike<number>): number;
