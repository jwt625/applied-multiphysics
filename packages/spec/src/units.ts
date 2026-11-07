// SPDX-License-Identifier: GPL-3.0-or-later
// Units and expressions used by the spec, behind a small interface (DevLog-003 s.1.6). Backed by @amp/core/units and
// @amp/core/expr (lane L1). The spec adds one thing on top: affine absolute-temperature units (degC) in literal
// quantities, with the exact defining offset 273.15 K. Affine units are refused inside expressions.

import { parseUnit as coreParseUnit, dimEq as coreDimEq, formatUnit as coreFormatUnit, DIMLESS } from '@amp/core/units';
import { compileExpression, parseExpression, referencedNames } from '@amp/core/expr';

export type Dim = readonly number[];

/** The unit operations the spec needs; any implementation with these semantics can replace @amp/core. */
export interface UnitsApi {
  /** value_SI = value_in_unit * factor + offset (offset only for affine units). Throws on unknown units. */
  parseUnit(src: string): { dim: number[]; factor: number; offset: number };
  dimEq(a: Dim, b: Dim): boolean;
  formatUnit(dim: Dim): string;
  dimless: Dim;
}

/** Preferred display names for dimensions common in specs (first match wins); others fall back to @amp/core. */
const SPEC_NAMED = ['1', 'm', 'm^2', 'm^3', 's', 'Hz', 'kg', 'A', 'K', 'V', 'W', 'J', 'N', 'Pa', 'T', 'C', 'W/m^2', 'W/m^3',
  'W/(m*K)', 'W/(m^2*K)', 'J/(kg*K)', 'kg/m^3', 'm/s', 'S/m', 'V/m', 'A/m^2', 'F/m', 'H/m', '1/K'];
const namedCache = new Map<string, number[]>();
const namedDim = (n: string): number[] => {
  let d = namedCache.get(n);
  if (!d) { d = coreParseUnit(n).dim; namedCache.set(n, d); }
  return d;
};

/** Affine absolute-temperature units: K value = value * 1 + 273.15 (definition of the Celsius scale). */
const AFFINE: Record<string, { offset: number }> = { degC: { offset: 273.15 }, '°C': { offset: 273.15 } };

export const units: UnitsApi = {
  parseUnit(src: string) {
    const key = src.trim();
    const affine = AFFINE[key];
    if (affine) return { dim: [0, 0, 0, 0, 1], factor: 1, offset: affine.offset };
    const u = coreParseUnit(key);
    return { dim: u.dim, factor: u.factor, offset: 0 };
  },
  dimEq: (a, b) => coreDimEq(a, b),
  formatUnit: (d) => SPEC_NAMED.find((n) => coreDimEq(namedDim(n), d)) ?? coreFormatUnit(d),
  dimless: DIMLESS,
};

export const isAffineUnit = (src: string): boolean => Object.hasOwn(AFFINE, src.trim());

/** Dimension of a reference SI unit string such as 'm', 'Pa', 'W/(m^2*K)', '1'. */
export function dimOf(unit: string): number[] {
  return units.parseUnit(unit).dim;
}

export interface ScopeValue { si: number; dim: Dim }

/** Names referenced by an expression (params, functions excluded). Throws on syntax errors. */
export function expressionRefs(src: string): string[] {
  return referencedNames(parseExpression(src));
}

/** Evaluate a constant expression over params; returns the SI value and dimension. Throws with a message on error. */
export function evaluateExpression(src: string, scope: ReadonlyMap<string, ScopeValue>): { si: number; dim: number[] } {
  const c = compileExpression(src, {
    resolve: (name: string) => {
      const v = scope.get(name);
      return v ? { kind: 'const', re: v.si, dim: v.dim } : null;
    },
  });
  if (!c.constant) throw new Error(`expression "${src}" is not constant`);
  if (c.constant.im !== 0) throw new Error(`expression "${src}" is complex`);
  return { si: c.constant.re, dim: c.dim };
}

/** Space and time symbols of field expressions (contracts v1): x, y, z, r in m, t in s. */
export const FIELD_SYMBOLS: ReadonlyMap<string, Dim> = new Map([
  ['x', [1, 0, 0, 0, 0]], ['y', [1, 0, 0, 0, 0]], ['z', [1, 0, 0, 0, 0]], ['r', [1, 0, 0, 0, 0]], ['t', [0, 0, 1, 0, 0]],
]);

/**
 * Dimension of an expression over params and field symbols (`vars`: allowed symbols with their dimensions). `si` is
 * the value when the expression does not depend on any symbol, else null. Throws with a message on error.
 */
export function evaluateFieldExpression(src: string, scope: ReadonlyMap<string, ScopeValue>, vars: ReadonlyMap<string, Dim>): { si: number | null; dim: number[] } {
  const c = compileExpression(src, {
    resolve: (name: string) => {
      const v = scope.get(name);
      if (v) return { kind: 'const', re: v.si, dim: v.dim };
      const d = vars.get(name);
      return d ? { kind: 'field', key: name, dim: d, complex: false, continuous: true } : null;
    },
  });
  if (c.complex) throw new Error(`expression "${src}" is complex`);
  if (c.constant) {
    if (c.constant.im !== 0) throw new Error(`expression "${src}" is complex`);
    return { si: c.constant.re, dim: c.dim };
  }
  return { si: null, dim: c.dim };
}
