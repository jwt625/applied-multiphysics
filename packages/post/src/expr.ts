// SPDX-License-Identifier: GPL-3.0-or-later
// Field expressions over a solution (DevLog-026, DevLog-023 s.3.2 vocabulary), compiled by @amp/core/expr (array at a
// time, SI dimension inference) and evaluated on a PointSet from each point's own cell.
//
// Names (resolved in this order; a bare name that is both a param and a field is an error):
//   defs          named sub-expressions given in the options (e.g. th = atan2(y, x)), evaluated on the same points
//   coordinates   planar 2D / 3D: x y (z), r = sqrt(x^2 + y^2); axisym meshes: r z (mesh coordinates)
//   normals       nx ny (nz) and tangents tx ty (tz) where the point set carries them (boundaries, edges, cut lines)
//   t             the step value of a time solution (s)
//   fields        <physicsId>.<field>[.<comp>] or <field>[.<comp>]; comp .x .y .z (planar / 3D), .r .z (axisym,
//                 2 components), .r .phi .z (axisym, 3 components), .norm (Euclidean norm); a vector field needs a comp
//   scalars       <physicsId>.<scalar> or <scalar> from Solution.scalars (constants)
//   params        SI values with dimension (e.g. resolveParams(...).scope of @amp/spec), and pi
// d(f, v): the derivative of a field (component) f along v in x, y, z or r (r: radial, grad f . (x, y)/r in planar
// meshes; the mesh coordinate on axisym meshes). Computed per element from the element basis: discontinuous across
// elements (the result is flagged `continuous: false`). The core grammar has no `d`, so d(f, v) is rewritten to a
// synthetic name before compilation; d of a general expression is not supported (error).

import type { FieldData, Mesh, Solution } from '@amp/spec/types';
import { compileExpression, ExpressionError, type CompiledExpression, type ScopeEntry } from '@amp/core/expr';
import { parseUnit, DIMLESS, type Dim } from '@amp/core/units';
import { fieldOf, meshOf } from './store.ts';
import { interpolate, locatePoints, type PointSet } from './points.ts';

const M: Dim = [1, 0, 0, 0, 0];
const S: Dim = [0, 0, 1, 0, 0];
const PER_M = (d: Dim): number[] => d.map((v, i) => (i === 0 ? v - 1 : v));

export type ParamValue = number | { si: number; dim?: Dim; unit?: string };
export type ParamScope = ReadonlyMap<string, { si: number; dim: Dim }> | Readonly<Record<string, ParamValue>>;

export interface ExprOptions {
  /** physics id accepted as a name prefix (`es.V`); without it any first segment that is not a field is a prefix */
  physicsId?: string;
  params?: ParamScope;
  /** named sub-expressions, usable by name in the expression and in each other (no cycles) */
  defs?: Readonly<Record<string, string>>;
  /** step index of the solution fields (default: the last step present, as `fieldOf`) */
  step?: number;
}

export interface FieldExpr {
  src: string;
  /** SI unit string of the result (formatUnit of the inferred dimension) */
  unit: string;
  dim: number[];
  /** false when the expression uses d() or a DG0 field (values jump across elements) */
  continuous: boolean;
  /** no field, coordinate or point dependence: `constant` holds the value */
  constant: number | null;
  /** solution fields read, by name */
  fields: string[];
  /** values at the point set (NaN outside the mesh) */
  evaluate(ps: PointSet): Float64Array;
}

type Source =
  | { k: 'coord'; axis: number | 'rho' }
  | { k: 'normal' | 'tangent'; axis: number }
  | { k: 'time' }
  | { k: 'field'; field: FieldData; comp: number | 'norm' }
  | { k: 'grad'; field: FieldData; comp: number; v: number | 'rho' }
  | { k: 'def'; name: string };

const D_CALL = /(?<![A-Za-z0-9_.\]])d\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;

function compNames(mesh: Mesh, nc: number): string[] {
  if (mesh.axisym) return nc === 3 ? ['r', 'phi', 'z'] : nc === 2 ? ['r', 'z'] : [];
  return nc === 1 ? [] : ['x', 'y', 'z'].slice(0, nc);
}

/** A param by name (SI value and dimension), `pi` built in; a unit other than SI is an error. */
export function paramLookup(p: ParamScope | undefined, name: string): { si: number; dim: Dim } | null {
  if (name === 'pi') return { si: Math.PI, dim: DIMLESS };
  if (!p) return null;
  const v0: ParamValue | { si: number; dim: Dim } | undefined = p instanceof Map ? p.get(name) : (p as Record<string, ParamValue>)[name];
  if (v0 === undefined) return null;
  if (typeof v0 === 'number') return { si: v0, dim: DIMLESS };
  const v = v0 as { si: number; dim?: Dim; unit?: string };
  if (v.dim) return { si: v.si, dim: v.dim };
  if (v.unit) { const u = parseUnit(v.unit); if (u.factor !== 1) throw new Error(`param '${name}': unit '${v.unit}' is not SI (factor ${u.factor}); give the SI value with an SI unit`); return { si: v.si, dim: u.dim }; }
  return { si: v.si, dim: DIMLESS };
}

/** Compile a field expression for a solution on its mesh. Throws ExpressionError / Error with the reason. */
export function compileFieldExpr(sol: Solution, src: string, o: ExprOptions & { mesh?: Mesh } = {}): FieldExpr {
  const mesh = meshOf(sol, o.mesh);
  return compileOn(mesh, sol, src, o, new Map(), []);
}

function compileOn(mesh: Mesh, sol: Solution, src0: string, o: ExprOptions, defsDone: Map<string, FieldExpr>, chain: string[]): FieldExpr {
  const dim = mesh.dim, axisym = !!mesh.axisym;
  const fieldNames = new Set(sol.fields.map((f) => f.name));
  // merged multiphysics solutions (C11): a first segment equal to a field's physics tag selects that physics' fields
  const tagged = new Set(sol.fields.flatMap((f) => (f.physics !== undefined ? [f.physics] : [])));
  const sources = new Map<string, Source>();
  const fieldsRead = new Set<string>();
  // d(f, v) -> synthetic name __d<k>
  const dcalls: Array<{ f: string; v: string }> = [];
  if (/(?<![A-Za-z0-9_.])__d/.test(src0)) throw new ExpressionError(`expression "${src0}": names starting with __d are reserved`);
  const src = src0.replace(D_CALL, (_m, f: string, v: string) => { dcalls.push({ f, v }); return `__d${dcalls.length - 1}`; });

  const coordAxis = (v: string): number | 'rho' | null => {
    if (axisym) return v === 'r' ? 0 : v === 'z' ? 1 : null;
    if (v === 'x') return 0; if (v === 'y') return 1; if (v === 'z' && dim === 3) return 2;
    if (v === 'r') return 'rho';
    return null;
  };

  /** field (+ component) for a name without the d() wrapper, or null */
  const fieldRef = (name: string): { field: FieldData; comp: number | 'norm' } | null => {
    const segs = name.split('.');
    const tries: Array<{ s: string[]; physics?: string }> = [{ s: segs }];
    if (segs.length > 1 && tagged.has(segs[0]!)) {
      // a tagged physics prefix: only that physics' fields (an untagged-style fallback would pick another physics' field)
      const pid = segs[0]!;
      if (!sol.fields.some((f) => f.name === segs[1] && f.physics === pid)) return null;
      tries.splice(0, 1, { s: segs.slice(1), physics: pid });
    } else if (segs.length > 1 && (o.physicsId ? segs[0] === o.physicsId : !fieldNames.has(segs[0]!))) tries.unshift({ s: segs.slice(1) });
    for (const { s, physics } of tries) {
      if (!s.length || !fieldNames.has(s[0]!)) continue;
      const f = fieldOf(sol, s[0]!, o.step, physics);
      const names = compNames(mesh, f.components);
      if (s.length === 1) {
        if (f.components === 1) return { field: f, comp: 0 };
        throw new ExpressionError(`expression "${src0}": '${name}' is a vector field with ${f.components} components; add a component (${names.map((c) => `.${c}`).join(', ')}) or .norm`);
      }
      if (s.length !== 2) continue;
      if (s[1] === 'norm') return { field: f, comp: 'norm' };
      const j = names.indexOf(s[1]!);
      if (j < 0) throw new ExpressionError(`expression "${src0}": '${name}': component '${s[1]}' unknown (have: ${names.map((c) => `.${c}`).join(', ') || 'none, scalar field'}${axisym ? '; axisymmetric mesh' : ''})`);
      return { field: f, comp: j };
    }
    return null;
  };
  const scalarRef = (name: string): { value: number; unit: string } | null => {
    const segs = name.split('.');
    const keys = [name];
    if (segs.length > 1 && (!o.physicsId || segs[0] === o.physicsId)) keys.push(segs.slice(1).join('.'));
    for (const k of keys) if (Object.hasOwn(sol.scalars, k)) return sol.scalars[k]!;
    return null;
  };
  const fieldDim = (f: FieldData): Dim => { const u = parseUnit(f.unit || '1'); if (u.factor !== 1) throw new Error(`field '${f.name}': unit '${f.unit}' is not SI`); return u.dim; };

  const scope = {
    resolve: (name: string): ScopeEntry | null => {
      const dm = /^__d(\d+)$/.exec(name);
      if (dm) {
        const { f, v } = dcalls[Number(dm[1])]!;
        const r = fieldRef(f);
        if (!r) throw new ExpressionError(`expression "${src0}": d(${f}, ${v}): '${f}' is not a solution field (d() takes a field or field component and a coordinate)`);
        if (r.comp === 'norm') throw new ExpressionError(`expression "${src0}": d(${f}, ${v}): the derivative of a norm is not supported; differentiate a component`);
        const ax = coordAxis(v);
        if (ax === null) throw new ExpressionError(`expression "${src0}": d(${f}, ${v}): '${v}' is not a coordinate (${axisym ? 'r, z on an axisymmetric mesh' : dim === 3 ? 'x, y, z, r' : 'x, y, r'})`);
        if (r.field.space === 'DG0') throw new ExpressionError(`expression "${src0}": d(${f}, ${v}): '${r.field.name}' is DG0 (piecewise constant); its derivative is not defined`);
        fieldsRead.add(r.field.name);
        sources.set(name, { k: 'grad', field: r.field, comp: r.comp, v: ax });
        return { kind: 'field', key: name, dim: PER_M(fieldDim(r.field)), complex: false, continuous: false };
      }
      // a user param with the same bare name as a def, coordinate, normal, t, field or module scalar is ambiguous
      const userParam = !name.includes('.') && !!o.params && (o.params instanceof Map ? o.params.has(name) : Object.hasOwn(o.params, name));
      const clash = (what: string) => { if (userParam) throw new ExpressionError(`expression "${src0}": '${name}' is both a param and a ${what}; rename the param${what === 'field' ? ` or write <physics>.${name} for the field` : ''}`); };
      if (o.defs && Object.hasOwn(o.defs, name)) {
        clash('def');
        if (chain.includes(name)) throw new ExpressionError(`defs cycle: ${[...chain, name].join(' -> ')}`);
        let c = defsDone.get(name);
        if (!c) { c = compileOn(mesh, sol, o.defs[name]!, o, defsDone, [...chain, name]); defsDone.set(name, c); }
        for (const f of c.fields) fieldsRead.add(f);
        if (c.constant !== null) return { kind: 'const', re: c.constant, dim: c.dim };
        sources.set(name, { k: 'def', name });
        return { kind: 'field', key: name, dim: c.dim, complex: false, continuous: c.continuous };
      }
      const ax = coordAxis(name);
      if (ax !== null) { clash('coordinate'); sources.set(name, { k: 'coord', axis: ax }); return { kind: 'field', key: name, dim: M, complex: false, continuous: true }; }
      const nt = /^([nt])([xyz])$/.exec(name);
      if (nt && !axisym && 'xyz'.indexOf(nt[2]!) < dim) { clash('normal / tangent component'); sources.set(name, { k: nt[1] === 'n' ? 'normal' : 'tangent', axis: 'xyz'.indexOf(nt[2]!) }); return { kind: 'field', key: name, dim: DIMLESS, complex: false, continuous: true }; }
      const ntr = /^([nt])([rz])$/.exec(name);
      if (ntr && axisym) { clash('normal / tangent component'); sources.set(name, { k: ntr[1] === 'n' ? 'normal' : 'tangent', axis: ntr[2] === 'r' ? 0 : 1 }); return { kind: 'field', key: name, dim: DIMLESS, complex: false, continuous: true }; }
      if (name === 't' && sol.steps?.kind === 'time') { clash('time symbol'); sources.set(name, { k: 'time' }); return { kind: 'field', key: name, dim: S, complex: false, continuous: true }; }
      const fr = fieldRef(name);
      if (fr) {
        clash('field');
        fieldsRead.add(fr.field.name);
        sources.set(name, { k: 'field', field: fr.field, comp: fr.comp });
        return { kind: 'field', key: name, dim: fieldDim(fr.field), complex: false, continuous: fr.field.space !== 'DG0' };
      }
      const sc = scalarRef(name);
      if (sc) { clash('module scalar'); const u = parseUnit(sc.unit || '1'); return { kind: 'const', re: sc.value * u.factor, dim: u.dim, global: true }; }
      const pv = paramLookup(o.params, name);
      if (pv) return { kind: 'const', re: pv.si, dim: pv.dim, global: true };
      return null;
    },
    describe: (name: string) => {
      const have = [...fieldNames].join(', ');
      return ` (fields: ${have || 'none'}; coordinates: ${axisym ? 'r, z' : dim === 3 ? 'x, y, z, r' : 'x, y, r'}${o.physicsId ? `; prefix ${o.physicsId}.` : ''})`;
    },
  };

  let ce: CompiledExpression;
  try { ce = compileExpression(src, scope); } catch (e) {
    if (!(e instanceof ExpressionError)) throw e;
    if (/unknown function 'd'/.test(e.message)) throw new ExpressionError(`expression "${src0}": d() takes a field (or field component) name and a coordinate name, e.g. d(es.V, x)`);
    // messages of the core compiler quote the rewritten source: quote the original; positions only when unchanged
    if (src !== src0) throw new ExpressionError(e.message.replace(`"${src}"`, `"${src0}"`).replace(/ at position \d+$/, ''));
    throw e;
  }
  if (ce.complex) throw new ExpressionError(`expression "${src0}" is complex; the solution fields are real (use real() or abs())`);

  const evaluate = (ps: PointSet): Float64Array => {
    if (ps.mesh.hash !== mesh.hash) throw new Error(`expression "${src0}": the point set is on mesh ${ps.mesh.hash.slice(0, 12)}, the solution on ${mesh.hash.slice(0, 12)}`);
    const n = ps.n;
    if (ce.constant) { const c = new Float64Array(n).fill(ce.constant.re); for (let i = 0; i < n; i++) if (ps.cell[i]! < 0) c[i] = NaN; return c; }
    const cache = new Map<FieldData, { values: Float64Array; grad?: Float64Array }>();
    const interp = (f: FieldData, grad: boolean) => {
      const c = cache.get(f);
      if (c && (!grad || c.grad)) return c;
      const r = interpolate(f, ps, { grad });
      cache.set(f, r);
      return r;
    };
    const arrays = new Map<string, Float64Array>();
    const get = (key: string): { re: Float64Array; im: null } => {
      let a = arrays.get(key);
      if (!a) { a = sourceValues(key); arrays.set(key, a); }
      return { re: a, im: null };
    };
    const sourceValues = (key: string): Float64Array => {
      const s = sources.get(key);
      if (!s) throw new Error(`internal: no source for '${key}'`);
      const out = new Float64Array(n);
      const outside = (i: number) => ps.cell[i]! < 0;
      switch (s.k) {
        case 'coord':
          for (let i = 0; i < n; i++) {
            if (s.axis === 'rho') { const x = ps.x[dim * i]!, y = ps.x[dim * i + 1]!; out[i] = Math.sqrt(x * x + y * y); }
            else out[i] = ps.x[dim * i + s.axis]!;
          }
          return out;
        case 'normal': case 'tangent': {
          const src = s.k === 'normal' ? ps.normal : ps.tangent;
          if (!src) throw new ExpressionError(`expression "${src0}": '${key}' needs a point set with ${s.k}s (a boundary, edge or cut line)`);
          for (let i = 0; i < n; i++) out[i] = src[dim * i + s.axis]!;
          return out;
        }
        case 'time': {
          const idx = o.step ?? Math.max(0, ...sol.fields.map((f) => f.step ?? 0));
          return out.fill(sol.steps!.values[idx] ?? NaN);
        }
        case 'field': {
          const { values } = interp(s.field, false), nc = s.field.components;
          for (let i = 0; i < n; i++) {
            if (outside(i)) { out[i] = NaN; continue; }
            if (s.comp === 'norm') { let q = 0; for (let j = 0; j < nc; j++) q += values[i * nc + j]! * values[i * nc + j]!; out[i] = Math.sqrt(q); }
            else out[i] = values[i * nc + s.comp]!;
          }
          return out;
        }
        case 'grad': {
          const { grad } = interp(s.field, true), nc = s.field.components;
          for (let i = 0; i < n; i++) {
            if (outside(i)) { out[i] = NaN; continue; }
            const o0 = (i * nc + s.comp) * dim;
            if (s.v === 'rho') {
              const x = ps.x[dim * i]!, y = ps.x[dim * i + 1]!, r = Math.sqrt(x * x + y * y);
              out[i] = (grad![o0]! * x + grad![o0 + 1]! * y) / r;
            } else out[i] = grad![o0 + s.v]!;
          }
          return out;
        }
        case 'def': return defsDone.get(s.name)!.evaluate(ps);
      }
    };
    const v = ce.run({ n, get }) as { s?: boolean; re: Float64Array | number; im: Float64Array | number | null };
    const re = v.s ? new Float64Array(n).fill(v.re as number) : Float64Array.from(v.re as Float64Array);
    // a real-valued expression can turn complex at run time (sqrt or log of a negative value): an error, never a real part
    const im = v.im;
    if (typeof im === 'number' ? im !== 0 : im && im.some((q, i) => q !== 0 && !Number.isNaN(q) && ps.cell[i]! >= 0)) throw new ExpressionError(`expression "${src0}" is complex at some points (sqrt, log or a fractional power of a negative value)`);
    for (let i = 0; i < n; i++) if (ps.cell[i]! < 0) re[i] = NaN;
    return re;
  };
  return {
    src: src0, unit: ce.unit, dim: ce.dim, continuous: ce.continuous,
    constant: ce.constant ? ce.constant.re : null, fields: [...fieldsRead], evaluate,
  };
}

/** One-call form: an expression at points ([[x, y], ...] or flat). Values NaN outside the mesh. */
export function evaluateExpr(sol: Solution, src: string, points: ArrayLike<number> | readonly (readonly number[])[] | PointSet, o: ExprOptions & { mesh?: Mesh; snap?: number } = {}): { values: Float64Array; unit: string; dim: number[]; continuous: boolean } {
  const mesh = meshOf(sol, o.mesh);
  const ps = isPointSet(points) ? points : locatePoints(mesh, points, o.snap ? { snap: o.snap } : {});
  const c = compileFieldExpr(sol, src, { ...o, mesh });
  return { values: c.evaluate(ps), unit: c.unit, dim: c.dim, continuous: c.continuous };
}

export function isPointSet(p: unknown): p is PointSet {
  return !!p && typeof p === 'object' && 'cell' in p && 'ref' in p && 'mesh' in p;
}

