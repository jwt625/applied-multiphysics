// SPDX-License-Identifier: GPL-3.0-or-later
// Units of the materials library (DevLog-013). Every unit string goes to @amp/core/units, except a short list of
// whole-string extensions with exact defining factors, so source values can be stored in the units the source prints:
//   degC     affine absolute temperature, K = degC + 273.15 (definition of the Celsius scale)
//   ksi, psi pound-force per square inch: 1 lbf = 4.4482216152605 N, 1 in = 0.0254 m (exact) -> 1 psi = 6894.757293168361 Pa
//   lb/in^3  1 lb = 0.45359237 kg, 1 in = 0.0254 m (exact)
// value_SI = value * factor + offset.

import { parseUnit as coreParseUnit, dimEq, DIMLESS } from '@amp/core/units';

export interface Unit { dim: number[]; factor: number; offset: number }

const PSI = 4.4482216152605 / (0.0254 * 0.0254);
const EXT: Record<string, Unit> = {
  degC: { dim: [0, 0, 0, 0, 1], factor: 1, offset: 273.15 },
  ksi: { dim: [-1, 1, -2, 0, 0], factor: 1e3 * PSI, offset: 0 },
  psi: { dim: [-1, 1, -2, 0, 0], factor: PSI, offset: 0 },
  'lb/in^3': { dim: [-3, 1, 0, 0, 0], factor: 0.45359237 / 0.0254 ** 3, offset: 0 },
};

export const EXTENSION_UNITS: readonly string[] = Object.keys(EXT);

export function parseUnit(src: string): Unit {
  const key = src.trim();
  const e = EXT[key];
  if (e) return { dim: [...e.dim], factor: e.factor, offset: e.offset };
  const u = coreParseUnit(key);
  return { dim: [...u.dim], factor: u.factor, offset: 0 };
}

export const sameDim = (a: readonly number[], b: readonly number[]): boolean => dimEq(a, b);
export const DIMENSIONLESS = DIMLESS;

export const toSI = (v: number, u: Unit): number => v * u.factor + u.offset;
export const fromSI = (v: number, u: Unit): number => (v - u.offset) / u.factor;

/** Parse a quantity string "293.15 K", "1.55 um", "20 degC" to SI. Returns null for "N/A". */
export function parseQuantity(s: string): { si: number; dim: number[]; value: number; unit: string } | null {
  const t = s.trim();
  if (t === 'N/A') return null;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(t);
  if (!m) throw new Error(`quantity "${s}": expected "<number> <unit>"`);
  const value = Number(m[1]);
  const unit = (m[2] ?? '').trim() || '1';
  const u = parseUnit(unit);
  return { si: toSI(value, u), dim: u.dim, value, unit };
}
