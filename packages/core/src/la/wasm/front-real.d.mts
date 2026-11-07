// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/wasm/front-real.mjs (hand-written 2026-11-06, lane P1 DevLog-016).
export type RealFactorKind = 'blocked' | 'wasm';
/** Whether this runtime validates the real front module (WebAssembly fixed-width SIMD). */
export function wasmRealSupported(): boolean;
/** Default real front kernel of SparseCholesky / factorNumeric / SupernodalLDLT ('wasm' since 2026-11-06, DevLog-016). */
export let DEFAULT_REAL_FACTOR: RealFactorKind;
export function setDefaultRealFactor(k: RealFactorKind): RealFactorKind;
/** Fronts with fewer rows run the JS kernels (identical results; speed only). */
export const WASM_MIN_FRONT: number;
/** Largest scratch (front + weights) in bytes; larger fronts use the JS kernels. */
export const WASM_MAX_BYTES: number;
export interface RealFrontKernel {
  memory: WebAssembly.Memory;
  /** whole-memory view; the front is H[0 .. m*m) (column-major), weights from H[wIdx] */
  H: Float64Array;
  wIdx: number;
  /** dense partial factorization in place; mode 0 Cholesky, 1 LDL^T (pivots to D[f ..], counts to st) */
  front(m: number, nc: number, mode: 0 | 1, D: Float64Array | null, f: number, tau: number, st: { nNeg: number; nPert: number } | null): boolean;
}
/** Shared kernel sized for fronts up to maxFront, or null (no SIMD, or too large). Valid until the next call. */
export function realFrontKernel(maxFront: number): RealFrontKernel | null;
/** Drop the shared kernel memory (it never shrinks); the next 'wasm' factor allocates a fresh one. */
export function releaseRealFrontKernel(): void;
/** Kernel for 'wasm' (null when unavailable), null for 'blocked'; kind null/undefined uses DEFAULT_REAL_FACTOR. */
export function resolveRealKernel(kind: RealFactorKind | null | undefined, maxFront: number): RealFrontKernel | null;
