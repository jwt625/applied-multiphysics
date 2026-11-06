// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/complex.mjs (hand-written, 2026-11-06).
export interface Complex { re: number; im: number }
export function cx(re: number, im?: number): Complex;
export function cadd(a: Complex, b: Complex): Complex;
export function csub(a: Complex, b: Complex): Complex;
export function cscale(a: Complex, s: number): Complex;
export function cmul(a: Complex, b: Complex): Complex;
export function cabs(a: Complex): number;
export function cdiv(a: Complex, b: Complex): Complex;
/** Principal root (Re >= 0). */
export function csqrt(z: Complex): Complex;
export function cexp(z: Complex): Complex;
export function ccosh(z: Complex): Complex;
export function csinh(z: Complex): Complex;
