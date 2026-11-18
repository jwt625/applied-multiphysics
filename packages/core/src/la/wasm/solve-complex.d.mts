// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/wasm/solve-complex.mjs (hand-written 2026-11-18, lane E8 DevLog-054).
import type { SymbolicAnalysis } from '../types.d.mts';
export type ComplexSolveKind = 'js' | 'wasm';
/** Whether this runtime compiles the complex solve module (WebAssembly fixed-width SIMD; CSP 'wasm-unsafe-eval'). */
export function wasmComplexSolveSupported(): boolean;
/** Size of the module bytes. */
export function complexSolveModuleBytes(): number;
/** Complex triangular solve kernel ('wasm' default, DevLog-054); read at factor allocation and at each solve. */
export let DEFAULT_COMPLEX_SOLVE: ComplexSolveKind;
export function setDefaultComplexSolve(k: ComplexSolveKind): ComplexSolveKind;
/** Factors with fewer stored L entries keep plain Float64Arrays and the JS solve. */
export const CSOLVE_MIN_NNZL: number;
/** Largest per-factor WebAssembly memory in bytes. */
export const CSOLVE_MAX_BYTES: number;
/** Kernel state of a complex factor whose Lr, Li live in WebAssembly memory. */
export interface ComplexSolveState {
  memory: WebAssembly.Memory;
  ex: Record<string, (...a: number[]) => void>;
  H: Float64Array;
  I: Int32Array;
  Lr: Float64Array;
  Li: Float64Array;
  liOff: number; yOff: number; siOff: number;
  siReady: boolean;
}
export function allocComplexFactorStorage(nnzL: number, n: number, siLen: number): { Lr: Float64Array; Li: Float64Array; ws: ComplexSolveState | null };
export function useWasmComplexSolve(ws: ComplexSolveState | null | undefined): boolean;
export function complexLdltSolveWasm(ws: ComplexSolveState, sym: SymbolicAnalysis, Dr: Float64Array, Di: Float64Array, br: ArrayLike<number>, bi: ArrayLike<number>): { re: Float64Array; im: Float64Array };
