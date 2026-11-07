// SPDX-License-Identifier: GPL-3.0-or-later
// Quantities of amp-spec/0 (DevLog-003 s.1.2). Accepted forms:
//   {value: 5, unit: mm}            literal
//   "5 mm", "2.4 GHz", "100 degC"   literal string: a number followed by a unit (units win over param names here)
//   "2*a", "a/10", "2[mm] + a"      expression over params (@amp/core/expr grammar; units inside brackets)
//   {value: "N/A", unit: W/(m*K)}   not available, unit recorded (object values are numbers or "N/A" only)
//   {expr: "100*sin(pi*t/(40[s]))", unit: degC}   expression whose value is in `unit` (contracts v1); affine units
//                                   only when the expression is dimensionless. In field settings the expression may
//                                   use x, y, z, r (m) and t (s), see field() in schema.ts
//   "N/A"                        not available; must be covered by a `missing` entry
//   5                               bare number: only for dimensionless quantities
// Vectors: {value: [0, 5], unit: mm} or an array of scalar quantities.

import { units, evaluateExpression, evaluateFieldExpression, expressionRefs, type Dim, type ScopeValue } from './units.ts';

export const NA = 'N/A';
export type QuantityObject = { value: number | string; unit: string };
export type ExprObject = { expr: string; unit: string };
export type QuantityInput = number | string | QuantityObject | ExprObject;
export type VectorInput = QuantityInput[] | { value: number[]; unit: string };

export type StringForm =
  | { kind: 'na' }
  | { kind: 'literal'; value: number; unit: string }
  | { kind: 'expr'; src: string };

const LITERAL = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(\S.*?)?\s*$/;

const formCache = new Map<string, StringForm>();

/** Classify a quantity string without evaluating params. */
export function classifyString(s: string): StringForm {
  const hit = formCache.get(s);
  if (hit) return hit;
  let out: StringForm;
  if (s.trim() === NA) out = { kind: 'na' };
  else {
    const m = LITERAL.exec(s);
    if (m && m[2] === undefined) out = { kind: 'literal', value: Number(m[1]), unit: '1' };
    else if (m && m[2] !== undefined && unitOk(m[2])) out = { kind: 'literal', value: Number(m[1]), unit: m[2] };
    else out = { kind: 'expr', src: s };
  }
  if (formCache.size > 4000) formCache.clear();
  formCache.set(s, out);
  return out;
}

function unitOk(u: string): boolean {
  try { units.parseUnit(u); return true; } catch { return false; }
}

export class QuantityError extends Error {}

export interface Resolved { na: false; si: number; dim: number[] }
export interface ResolvedNA { na: true }

/** Param names an input references (empty for literals). Syntax errors yield no names. */
export function quantityRefs(q: unknown): string[] {
  if (q && typeof q === 'object' && typeof (q as ExprObject).expr === 'string') { try { return expressionRefs((q as ExprObject).expr); } catch { return []; } }
  const src = typeof q === 'string' ? q : q && typeof q === 'object' && typeof (q as QuantityObject).value === 'string' ? (q as QuantityObject).value as string : null;
  if (src == null) return [];
  const f = classifyString(src);
  if (f.kind !== 'expr') return [];
  try { return expressionRefs(f.src); } catch { return []; }
}

function evalExpr(src: string, scope: ReadonlyMap<string, ScopeValue>): { si: number; dim: number[] } {
  try { return evaluateExpression(src, scope); } catch (e) { throw new QuantityError(affineHint(src, (e as Error).message)); }
}

export interface ResolvedField { na: false; si: number | null; dim: number[] }
const NO_VARS: ReadonlyMap<string, Dim> = new Map();

/**
 * Resolve a quantity that may depend on field symbols (`vars`). si is null when the value varies in space or time.
 * Throws QuantityError with a user-facing message.
 */
export function resolveField(q: unknown, scope: ReadonlyMap<string, ScopeValue>, vars: ReadonlyMap<string, Dim>): ResolvedField | ResolvedNA {
  const expr = (src: string) => { try { return evaluateFieldExpression(src, scope, vars); } catch (e) { throw new QuantityError(affineHint(src, (e as Error).message)); } };
  if (q && typeof q === 'object' && 'expr' in q) {
    const { expr: src, unit } = q as ExprObject;
    let u;
    try { u = units.parseUnit(unit); } catch (e) { throw new QuantityError((e as Error).message); }
    const e = expr(src);
    const dimless = units.dimEq(e.dim, units.dimless);
    if (u.offset !== 0 && !dimless) throw new QuantityError(`affine unit ${unit} needs a dimensionless expression, got ${units.formatUnit(e.dim)}`);
    return { na: false, si: e.si === null ? null : e.si * u.factor + u.offset, dim: e.dim.map((d, i) => d + (u.dim[i] ?? 0)) };
  }
  if (typeof q === 'string' && vars.size) {
    const f = classifyString(q);
    if (f.kind === 'expr') return { na: false, ...expr(f.src) };
  }
  return resolveQuantity(q, scope);
}

const affineHint = (src: string, msg: string) => (/degC|°C/.test(src) ? `${msg}; affine units (degC) are allowed only in literals such as "20 degC" or as {expr, unit: degC}` : msg);

/** Resolve a scalar quantity to SI. Throws QuantityError with a user-facing message. */
export function resolveQuantity(q: unknown, scope: ReadonlyMap<string, ScopeValue>): Resolved | ResolvedNA {
  if (q && typeof q === 'object' && 'expr' in q) {
    const r = resolveField(q, scope, NO_VARS);
    if (r.na) return r;
    if (r.si === null) throw new QuantityError('expression is not constant');
    return { na: false, si: r.si, dim: r.dim };
  }
  if (typeof q === 'number') {
    if (!Number.isFinite(q)) throw new QuantityError('non-finite number');
    return { na: false, si: q, dim: [...units.dimless] };
  }
  if (typeof q === 'string') {
    const f = classifyString(q);
    if (f.kind === 'na') return { na: true };
    if (f.kind === 'literal') {
      const u = units.parseUnit(f.unit);
      return { na: false, si: f.value * u.factor + u.offset, dim: u.dim };
    }
    return { na: false, ...evalExpr(f.src, scope) };
  }
  if (q && typeof q === 'object' && 'unit' in q && 'value' in q) {
    const { value, unit } = q as QuantityObject;
    let u;
    try { u = units.parseUnit(unit); } catch (e) { throw new QuantityError((e as Error).message); }
    if (typeof value === 'number') return { na: false, si: value * u.factor + u.offset, dim: u.dim };
    if (typeof value === 'string') {
      if (value.trim() === NA) return { na: true };
      throw new QuantityError('{value, unit} takes a number or "N/A"; write an expression as a string, e.g. "2*a" or "2[mm] + a"');
    }
  }
  throw new QuantityError('not a quantity');
}

/** Reference SI unit for an expected dimension; '*' accepts any dimension. */
export type DimSpec = string;

export function dimMatches(actual: Dim, expected: DimSpec): boolean {
  if (expected === '*') return true;
  return units.dimEq(actual, units.parseUnit(expected).dim);
}

export function dimMismatchMessage(actual: Dim, expected: DimSpec): string {
  return `expected a quantity in ${units.formatUnit(units.parseUnit(expected).dim)}, got ${units.formatUnit(actual)}`;
}

export function unitlessMessage(value: number, expected: DimSpec): string {
  const u = units.formatUnit(units.parseUnit(expected).dim);
  return `unitless value ${value} for a quantity in ${u}: write "${value} <unit>" or {value: ${value}, unit: <unit>}`;
}
