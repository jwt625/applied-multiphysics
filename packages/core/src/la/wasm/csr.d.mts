// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/wasm/csr.mjs (hand-written 2026-11-18, lane G3 DevLog-060).
export type CsrKernelKind = 'js' | 'wasm';
/** Whether this runtime compiles the CSR kernel module. */
export function wasmCsrSupported(): boolean;
/** CSR kernel for kernels created afterwards ('wasm' default; bitwise identical to 'js'). */
export let DEFAULT_CSR_KERNEL: CsrKernelKind;
export function setDefaultCsrKernel(k: CsrKernelKind): CsrKernelKind;
/** Matrices with fewer stored entries use the JS loops. */
export const CSR_MIN_NNZ: number;
/** WASM spmv / Gauss-Seidel for one CSR matrix (values copied at creation), or null (JS loops). */
export function makeCsrKernels(pat: { n: number; rowptr: Int32Array; colidx: Int32Array }, val: Float64Array, diag?: Int32Array | null): {
  kind: 'wasm';
  spmv(x: Float64Array, y: Float64Array): Float64Array;
  gs(b: Float64Array, x: Float64Array, dir: number): void;
} | null;
