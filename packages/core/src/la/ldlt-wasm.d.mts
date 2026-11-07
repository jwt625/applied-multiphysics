// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/ldlt-wasm.mjs (hand-written 2026-11-06, audit S2).
import { BlockedComplexLDLT } from './ldlt-blocked.mjs';
import type { SymbolicAnalysis } from './types.d.mts';
export function wasmLdltSupported(): boolean;
/** BlockedComplexLDLT with the WebAssembly SIMD front update (opt-in). */
export class WasmComplexLDLT extends BlockedComplexLDLT {
  constructor(sym: SymbolicAnalysis);
}
