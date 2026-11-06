// SPDX-License-Identifier: GPL-3.0-or-later
// Types of units.mjs (ported from advanced-packaging-atlas engine/src/params/units.mjs at fe39985; EO
// postproc/index.d.mts unit declarations at 0546007 as the starting point; Dim widened to 5 base dimensions).
/** Exponents over the SI base units [m, kg, s, A, K]. EO 4-entry vectors are accepted (missing K = 0). */
export type Dim = readonly number[];
export interface ParsedUnit { dim: number[]; factor: number }
export const BASE_UNITS: readonly ['m', 'kg', 's', 'A', 'K'];
export const DIMLESS: Dim;
export class UnitError extends Error {
  constructor(message: string, detail?: string, pos?: number | null);
  detail: string;
  pos: number | null;
}
export function dimMul(a: Dim, b: Dim): number[];
export function dimDiv(a: Dim, b: Dim): number[];
export function dimPow(a: Dim, p: number): number[];
export function dimEq(a: Dim, b: Dim): boolean;
export function isDimless(a: Dim): boolean;
/** value_SI = value_in_unit * factor. */
export function parseUnit(src: string): ParsedUnit;
export function formatUnit(dim: Dim): string;
/** display value = SI value / factor. Throws UnitError when the unit has another dimension. */
export function displayConversion(dim: Dim, unit?: string | null): { factor: number; unit: string };
