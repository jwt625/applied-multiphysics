// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/ldlt-select.mjs (hand-written 2026-11-06, audit S2).
import type { ComplexSupernodalLDLT } from './ldlt.mjs';
import type { SymbolicAnalysis } from './types.d.mts';
export type FactorKind = 'base' | 'blocked' | 'wasm';
/** Default 'blocked'; WASM is opt-in. */
export let DEFAULT_FACTOR: FactorKind;
export function setDefaultFactor(k: FactorKind): FactorKind;
/** Complex-symmetric supernodal LDL^T of the requested kind ('wasm' falls back to 'blocked' without SIMD). */
export function makeFactor(kind: FactorKind | null | undefined, sym: SymbolicAnalysis): ComplexSupernodalLDLT;
export function factorFallbackWarning(kind: FactorKind | null | undefined): string | null;
