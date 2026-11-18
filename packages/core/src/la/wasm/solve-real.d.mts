// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/wasm/solve-real.mjs (hand-written 2026-11-18, lane S4 DevLog-045).
import type { SymbolicAnalysis } from '../types.d.mts';
export type RealSolveKind = 'js' | 'wasm';
/** Whether this runtime compiles the solve module (WebAssembly fixed-width SIMD; CSP 'wasm-unsafe-eval'). */
export function wasmSolveSupported(): boolean;
/** Real triangular solve kernel ('wasm' default since 2026-11-18, DevLog-045); read at factor allocation and at each solve. */
export let DEFAULT_REAL_SOLVE: RealSolveKind;
export function setDefaultRealSolve(k: RealSolveKind): RealSolveKind;
/** Factors with fewer stored L entries keep a plain Float64Array and the JS solve. */
export const SOLVE_MIN_NNZL: number;
/** Largest per-factor WebAssembly memory (L + workspace) in bytes. */
export const SOLVE_MAX_BYTES: number;
/** Vectors per chunk of a multi-vector LDL^T solve. */
export const QCAP: number;
/** Kernel state of a factor whose L lives in WebAssembly memory. */
export interface RealSolveState {
  memory: WebAssembly.Memory;
  ex: Record<string, (...a: number[]) => void>;
  H: Float64Array;
  I: Int32Array;
  Lx: Float64Array;
  yOff: number; tOff: number; vOff: number; siOff: number;
  siReady: boolean;
}
/** L storage of a real factor: in WebAssembly memory with kernel state (ws), or a plain Float64Array (ws null). */
export function allocRealFactorStorage(nnzL: number, n: number, maxFront: number, siLen?: number): { Lx: Float64Array; ws: RealSolveState | null };
export function useWasmSolve(ws: RealSolveState | null | undefined): boolean;
export function choleskySolveWasm(ws: RealSolveState, sym: SymbolicAnalysis, b: ArrayLike<number>, out?: Float64Array | null): Float64Array;
export function ldltSolveWasm(ws: RealSolveState, sym: SymbolicAnalysis, D: Float64Array, b: ArrayLike<number>, out?: Float64Array | null): Float64Array;
export function ldltSolveManyWasm(ws: RealSolveState, sym: SymbolicAnalysis, D: Float64Array, b: ArrayLike<number>, q: number, out?: Float64Array | null): Float64Array;
