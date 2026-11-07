// SPDX-License-Identifier: GPL-3.0-or-later
// Field-valued settings (contracts v1, DevLog-003 s.9): a constant quantity, an expression string in params and the
// field symbols, or {expr, unit}. Symbols: 1d x; 2d x, y; 2d-axisym r, z; 3d x, y, z (m); t (s). Compiled with
// @amp/core/expr (fields as scope entries); evaluated per point. The value is SI: for {expr, unit} it is
// expr * factor(unit) + offset(unit) (affine units such as degC only with a dimensionless expression, checked by spec).

import type { Mesh, Spec } from '@amp/spec/types';
import { resolveField, resolveParams, units, FIELD_SYMBOLS, classifyString } from '@amp/spec';
import { compileExpression } from '@amp/core/expr';

/** Value of a field at a point x (mesh coordinates) and time t (s), SI. */
export type FieldFn = (x: ArrayLike<number>, t: number) => number;
export type FieldValue = number | FieldFn;

export type Space = '1d' | '2d' | '2d-axisym' | '3d';
export const spaceOf = (m: Mesh): Space => (m.dim === 3 ? '3d' : m.dim === 1 ? '1d' : m.axisym ? '2d-axisym' : '2d');
const SYMS: Record<Space, string[]> = { '1d': ['x'], '2d': ['x', 'y'], '2d-axisym': ['r', 'z'], '3d': ['x', 'y', 'z'] };

/** True when the field depends on t. */
export function dependsOnTime(v: FieldValue): boolean { return typeof v === 'function' && !!(v as FieldFn & { time?: boolean }).time; }

/**
 * Compile a field setting. Returns a number for constants (and N/A throws, naming `what`), else a function.
 * `vars`: 'space' rejects t, 'time' rejects space symbols (the spec validator checks this too).
 */
export function compileField(spec: Spec, q: unknown, space: Space, what: string, vars: 'space' | 'time' | 'spacetime' = 'spacetime'): FieldValue {
  const P = resolveParams(spec.params ?? {});
  const syms = [...(vars === 'time' ? [] : SYMS[space]), ...(vars === 'space' ? [] : ['t'])];
  const symDims = new Map(syms.map((s) => [s, FIELD_SYMBOLS.get(s)!]));
  const r = resolveField(q, P.scope, symDims);
  if (r.na) throw new Error(`${what} is N/A`);
  if (r.si !== null) return r.si;
  // non-constant: compile
  let src: string, factor = 1, offset = 0;
  if (q && typeof q === 'object' && 'expr' in q) {
    const o = q as { expr: string; unit: string };
    const u = units.parseUnit(o.unit);
    src = o.expr; factor = u.factor; offset = u.offset;
  } else if (typeof q === 'string' && classifyString(q).kind === 'expr') src = q;
  else throw new Error(`${what}: not a field expression`);
  const c = compileExpression(src, {
    resolve: (name: string) => {
      const v = P.scope.get(name);
      if (v) return { kind: 'const', re: v.si, dim: v.dim };
      const d = symDims.get(name);
      return d ? { kind: 'field', key: name, dim: d, complex: false, continuous: true } : null;
    },
  });
  if (c.complex) throw new Error(`${what}: complex expression`);
  const used = [...c.fields.keys()] as string[];
  const idx: Record<string, number> = space === '2d-axisym' ? { r: 0, z: 1 } : { x: 0, y: 1, z: 2 };
  const buf = new Map<string, { re: Float64Array; im: null }>(used.map((k) => [k, { re: new Float64Array(1), im: null }]));
  const fn: FieldFn = (x, t) => {
    for (const k of used) buf.get(k)!.re[0] = k === 't' ? t : x[idx[k]!]!;
    const out = c.run({ n: 1, get: (k: string) => buf.get(k)! }) as { re: Float64Array };
    return out.re[0]! * factor + offset;
  };
  (fn as FieldFn & { time?: boolean }).time = used.includes('t');
  return fn;
}

export const evalField = (v: FieldValue, x: ArrayLike<number>, t = 0): number => (typeof v === 'number' ? v : v(x, t));
