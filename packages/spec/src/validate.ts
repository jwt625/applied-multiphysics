// SPDX-License-Identifier: GPL-3.0-or-later
// Validation of amp-spec/0 data (DevLog-003 s.1.2): params resolved first (dimensions, cycles), then the zod schema
// of the registry with the params in scope, then cross-reference checks (ids, selections, references, provenance
// paths, N/A coverage by `missing`). Every issue carries a key path, its dotted form and a JSON Pointer.

import * as z from 'zod';
import { EXPRESSION_FUNCTIONS } from '@amp/core/expr';
import { buildSpecSchema, withScope, type Spec } from './schema.ts';
import { classifyString, resolveQuantity, QuantityError, NA } from './quantity.ts';
import { units, expressionRefs, evaluateExpression, type ScopeValue } from './units.ts';
import { parseEntityId, type EntityKind } from './ids.ts';
import type { Registry, CheckContext, PathKey, SpaceDim, Registration } from './registry.ts';

export interface SpecIssue {
  path: PathKey[];
  dotted: string;
  pointer: string;
  code: string;
  message: string;
  line?: number;
  col?: number;
}

export interface ParamInfo { name: string; si: number; dim: number[]; unit: string | null; expr: string | null; refs: string[] }

export interface ValidationResult {
  ok: boolean;
  spec: Spec | null;
  issues: SpecIssue[];
  params: Map<string, ParamInfo>;
}

// ---- paths -----------------------------------------------------------------------------------------------------
export const dottedOf = (keys: readonly PathKey[]): string => keys.map(String).join('.');
const esc = (k: PathKey) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
export const pointerOf = (keys: readonly PathKey[]): string => (keys.length ? `/${keys.map(esc).join('/')}` : '');

export function issue(path: PathKey[], code: string, message: string): SpecIssue {
  return { path, dotted: dottedOf(path), pointer: pointerOf(path), code, message };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Resolve a dotted path whose segments are keys, array indices or element ids. Null when it does not resolve. */
export function resolveDotted(data: unknown, dotted: string): PathKey[] | null {
  const keys: PathKey[] = [];
  let cur: unknown = data;
  for (const seg of dotted.split('.')) {
    if (Array.isArray(cur)) {
      let i = /^\d+$/.test(seg) ? Number(seg) : -1;
      if (i < 0) i = cur.findIndex((e) => isObj(e) && e.id === seg);
      if (i < 0 || i >= cur.length) return null;
      keys.push(i);
      cur = cur[i];
    } else if (isObj(cur) && Object.hasOwn(cur, seg)) {
      keys.push(seg);
      cur = cur[seg];
    } else return null;
  }
  return keys;
}

/** Dotted path with element ids in place of array indices where the element has an id. */
export function idPathOf(data: unknown, keys: readonly PathKey[]): string {
  const out: string[] = [];
  let cur: unknown = data;
  for (const k of keys) {
    if (Array.isArray(cur) && typeof k === 'number') {
      const e = cur[k];
      out.push(isObj(e) && typeof e.id === 'string' ? e.id : String(k));
      cur = e;
    } else {
      out.push(String(k));
      cur = isObj(cur) ? cur[String(k)] : undefined;
    }
  }
  return out.join('.');
}

// ---- params ----------------------------------------------------------------------------------------------------
const RESERVED = new Set<string>(['pi', ...EXPRESSION_FUNCTIONS]);
export const BUILTIN_SCOPE: ReadonlyMap<string, ScopeValue> = new Map([['pi', { si: Math.PI, dim: units.dimless }]]);

type ParamPlan = { name: string; value?: { si: number; dim: number[]; unit: string | null }; expr?: string; refs: string[] };

export function resolveParams(raw: unknown): { scope: Map<string, ScopeValue>; info: Map<string, ParamInfo>; issues: SpecIssue[]; failed: Set<string> } {
  const issues: SpecIssue[] = [];
  const scope = new Map<string, ScopeValue>(BUILTIN_SCOPE);
  const info = new Map<string, ParamInfo>();
  if (!isObj(raw)) return { scope, info, issues, failed: new Set() };
  const plans = new Map<string, ParamPlan>();
  for (const [name, def] of Object.entries(raw)) {
    const at: PathKey[] = ['params', name];
    if (RESERVED.has(name)) { issues.push(issue(at, 'param_reserved', `'${name}' is reserved (constant or function name)`)); continue; }
    try {
      const plan = planParam(name, def, at, issues);
      if (plan) plans.set(name, plan);
    } catch (e) {
      issues.push(issue(at, 'param_invalid', (e as Error).message));
    }
  }
  const state = new Map<string, 'visiting' | 'done' | 'failed'>();
  const visit = (name: string, chain: string[]): boolean => {
    const s = state.get(name);
    if (s === 'done') return true;
    if (s === 'failed') return false;
    const plan = plans.get(name);
    if (!plan) return false;
    if (s === 'visiting') {
      issues.push(issue(['params', name], 'param_cycle', `param cycle: ${[...chain, name].join(' -> ')}`));
      state.set(name, 'failed');
      return false;
    }
    state.set(name, 'visiting');
    let ok = true;
    for (const r of plan.refs) {
      if (BUILTIN_SCOPE.has(r)) continue;
      if (!plans.has(r) && !Object.hasOwn(raw, r)) {
        issues.push(issue(['params', name], 'param_unknown_ref', `param '${name}' references unknown param '${r}'`));
        ok = false;
      } else if (!visit(r, [...chain, name])) ok = false;
    }
    if (ok && plan.expr !== undefined) {
      try {
        const v = evaluateExpression(plan.expr, scope);
        plan.value = { si: v.si, dim: v.dim, unit: null };
      } catch (e) {
        issues.push(issue(['params', name], 'param_invalid', (e as Error).message));
        ok = false;
      }
    }
    if (ok && plan.value && !Number.isFinite(plan.value.si)) {
      issues.push(issue(['params', name], 'param_invalid', `param '${name}' is not finite (overflow or division by zero)`));
      ok = false;
    }
    if (!ok || !plan.value) { if (state.get(name) !== 'failed') state.set(name, 'failed'); return false; }
    scope.set(name, { si: plan.value.si, dim: plan.value.dim });
    info.set(name, { name, si: plan.value.si, dim: plan.value.dim, unit: plan.value.unit, expr: plan.expr ?? null, refs: plan.refs });
    state.set(name, 'done');
    return true;
  };
  for (const name of plans.keys()) visit(name, []);
  const failed = new Set(Object.keys(raw).filter((n) => !scope.has(n)));
  return { scope, info, issues, failed };
}

function planParam(name: string, def: unknown, at: PathKey[], issues: SpecIssue[]): ParamPlan | null {
  const literal = (value: number, unit: string | null): ParamPlan | null => {
    let u;
    try { u = units.parseUnit(unit ?? '1'); } catch { return null; } // the schema reports the unit at params.<name>.unit
    return { name, value: { si: value * u.factor + u.offset, dim: u.dim, unit }, refs: [] };
  };
  const fromString = (s: string, path: PathKey[]): ParamPlan | null => {
    const f = classifyString(s);
    if (f.kind === 'na') { issues.push(issue(path, 'param_na', 'params need values; write N/A at the field that uses the value and add a missing entry')); return null; }
    if (f.kind === 'literal') return literal(f.value, f.unit === '1' ? null : f.unit);
    return { name, expr: f.src, refs: expressionRefs(f.src) };
  };
  if (typeof def === 'number') return literal(def, null);
  if (typeof def === 'string') return fromString(def, at);
  if (isObj(def)) {
    const { value, unit, range } = def as { value?: unknown; unit?: unknown; range?: unknown };
    if (typeof value === 'number') {
      const plan = literal(value, typeof unit === 'string' ? unit : null);
      if (plan && Array.isArray(range) && range.length === 2 && typeof range[0] === 'number' && typeof range[1] === 'number') {
        if (range[0] > range[1]) issues.push(issue([...at, 'range'], 'param_range', `range [${range[0]}, ${range[1]}] is reversed`));
        else if (value < range[0] || value > range[1]) issues.push(issue([...at, 'value'], 'param_range', `value ${value} outside range [${range[0]}, ${range[1]}]`));
      }
      return plan;
    }
    if (typeof value === 'string') {
      if (unit !== undefined) { issues.push(issue([...at, 'unit'], 'param_unit', 'the unit of a string-valued param comes from the string ("5 mm" or an expression); remove unit')); return null; }
      if (range !== undefined) { issues.push(issue([...at, 'range'], 'param_range', 'range needs a numeric value with a unit')); }
      return fromString(value, [...at, 'value']);
    }
  }
  return null; // structural errors are reported by the schema
}

// ---- zod issue mapping -----------------------------------------------------------------------------------------
type RawIssue = z.core.$ZodIssue;

const errorMap = (iss: { code?: string; input?: unknown; path?: PropertyKey[]; keys?: string[]; inst?: unknown; expected?: string }) => {
  if (iss.code === 'invalid_type' && iss.input === undefined) return `missing required key '${String(iss.path?.at(-1) ?? '')}'`;
  if (iss.code === 'unrecognized_keys') {
    const shape = (iss.inst as { _zod?: { def?: { shape?: Record<string, unknown> } } } | undefined)?._zod?.def?.shape;
    const allowed = shape ? Object.keys(shape) : null;
    return `unknown key${(iss.keys?.length ?? 0) > 1 ? 's' : ''} ${(iss.keys ?? []).map((k) => `'${k}'`).join(', ')}${allowed ? ` (allowed: ${allowed.join(', ')})` : ''}`;
  }
  return undefined;
};

function flattenIssues(raw: RawIssue[], prefix: PathKey[], out: SpecIssue[]): void {
  for (const r of raw) {
    const path = [...prefix, ...(r.path as PathKey[])];
    if (r.code === 'unrecognized_keys') {
      for (const k of r.keys) out.push(issue([...path, k], 'unknown_key', r.message));
      continue;
    }
    if (r.code === 'invalid_union' && r.errors?.length && !(r as { note?: string }).note) {
      // Report the branch that got furthest: fewest issues, ignoring branches that failed on the root type.
      const branches = r.errors.filter((b) => !b.some((x) => x.code === 'invalid_type' && x.path.length === 0));
      const best = branches.sort((a, b) => a.length - b.length)[0];
      if (best) { flattenIssues(best, path, out); continue; }
      out.push(issue(path, 'invalid_value', `invalid value (${describeInput(r.input)})`));
      continue;
    }
    const code = (r as { params?: { amp?: string } }).params?.amp ?? (r.code === 'invalid_type' && r.input === undefined ? 'missing_key' : r.code);
    out.push(issue(path, code, r.message));
  }
}

const describeInput = (x: unknown): string => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);

// ---- cross references ------------------------------------------------------------------------------------------
const spaceOf = (g: Spec['geometry']): SpaceDim => (g.dim === 1 ? '1d' : g.dim === 2 ? (g.axisym ? '2d-axisym' : '2d') : '3d');

function crossCheck(spec: Spec, reg: Registry, scope: ReadonlyMap<string, ScopeValue>, issues: SpecIssue[]): void {
  const data = spec as unknown as Record<string, unknown>;
  const space = spaceOf(spec.geometry);
  const ids = new Map<string, PathKey[]>();
  const addId = (id: string, path: PathKey[]) => {
    const first = ids.get(id);
    if (first) issues.push(issue([...path, 'id'], 'duplicate_id', `duplicate id '${id}' (first at ${dottedOf(first)})`));
    else ids.set(id, path);
  };
  const physicsMap = new Map<string, { type: string }>();
  const studyMap = new Map<string, { type: string }>();
  const featureIds = new Set<string>();
  const ctx: CheckContext = {
    spec: data, params: scope, space, featureIds, physics: physicsMap, studies: studyMap,
    resolve: (q) => { const r = resolveQuantity(q, scope); return r.na ? null : { si: r.si, dim: r.dim }; },
  };
  const hook = (r: Registration | undefined, node: Record<string, unknown>, path: PathKey[]) => {
    if (!r?.check) return;
    try {
      for (const h of r.check(node, ctx)) issues.push(issue([...path, ...h.path], h.code ?? 'check', h.message));
    } catch (e) {
      issues.push(issue(path, e instanceof QuantityError ? 'quantity' : 'check', (e as Error).message));
    }
  };
  const dimsOk = (r: Registration | undefined, path: PathKey[], what: string) => {
    if (r?.dims && !r.dims.includes(space)) issues.push(issue([...path, 'type'], 'space_dim', `${what} '${r.type}' supports ${r.dims.join(', ')}, geometry is ${space}`));
  };

  spec.geometry.features.forEach((f, i) => {
    const path: PathKey[] = ['geometry', 'features', i];
    addId(f.id, path);
    const r = reg.get('feature', f.type);
    dimsOk(r, path, 'feature');
    for (const key of r?.refs ?? []) {
      const v = (f.settings as Record<string, unknown> | undefined)?.[key];
      const list = typeof v === 'string' ? [[v, [key]]] : Array.isArray(v) ? v.map((x, j) => [x, [key, j]]) : [];
      for (const [ref, sub] of list as [unknown, PathKey[]][]) {
        if (typeof ref === 'string' && !featureIds.has(ref)) issues.push(issue([...path, 'settings', ...sub], 'unknown_feature', `'${ref}' is not an earlier geometry feature`));
      }
    }
    featureIds.add(f.id);
    hook(r, f as Record<string, unknown>, path);
  });

  const checkSel = (sel: readonly string[] | undefined, path: PathKey[]) => {
    sel?.forEach((id, j) => {
      const p = parseEntityId(id);
      if (p && !featureIds.has(p.feature)) issues.push(issue([...path, j], 'unknown_feature', `entity '${id}': no geometry feature '${p.feature}'`));
    });
  };

  // each domain gets at most one material; a parent id overlaps its split parts (`dom:a` vs `dom:a#1`)
  const assigned: Array<{ d: string; m: string }> = [];
  const overlaps = (a: string, b: string) => a === b || a.replace(/#\d+$/, '') === b || b.replace(/#\d+$/, '') === a;
  spec.materials?.forEach((m, i) => {
    const path: PathKey[] = ['materials', i];
    addId(m.id, path);
    checkSel(m.select, [...path, 'select']);
    m.select.forEach((d, j) => {
      const prev = assigned.find((x) => x.m !== m.id && overlaps(x.d, d));
      if (prev) issues.push(issue([...path, 'select', j], 'material_overlap', `'${d}' overlaps '${prev.d}' of material '${prev.m}' (no overlap order; assign each domain once)`));
      assigned.push({ d, m: m.id });
    });
  });

  spec.physics?.forEach((p, i) => {
    const path: PathKey[] = ['physics', i];
    addId(p.id, path);
    physicsMap.set(p.id, { type: p.type });
    const r = reg.get('physics', p.type);
    dimsOk(r, path, 'physics');
    checkSel(p.select, [...path, 'select']);
    hook(r, p as Record<string, unknown>, path);
    p.bcs?.forEach((b, j) => {
      const bp: PathKey[] = [...path, 'bcs', j];
      addId(b.id, bp);
      checkSel(b.select, [...bp, 'select']);
      hook(reg.get('bc', b.type), b as Record<string, unknown>, bp);
    });
  });

  spec.couplings?.forEach((c, i) => {
    const path: PathKey[] = ['couplings', i];
    addId(c.id, path);
    const r = reg.get('coupling', c.type);
    const ends: Array<['from' | 'to', number]> = [['from', 0], ['to', 1]];
    for (const [end, k] of ends) {
      const target = physicsMap.get(c[end]);
      if (!target) issues.push(issue([...path, end], 'unknown_physics', `no physics '${c[end]}'`));
      else if (r?.for && r.for[k] !== '*' && r.for[k] !== target.type) issues.push(issue([...path, end], 'coupling_type', `coupling '${c.type}' ${end} must be a '${r.for[k]}' physics, '${c[end]}' is '${target.type}'`));
    }
    hook(r, c as Record<string, unknown>, path);
  });

  spec.studies?.forEach((s, i) => {
    const path: PathKey[] = ['studies', i];
    addId(s.id, path);
    studyMap.set(s.id, { type: s.type });
    s.physics.forEach((pid, j) => { if (!physicsMap.has(pid)) issues.push(issue([...path, 'physics', j], 'unknown_physics', `no physics '${pid}'`)); });
  });
  spec.studies?.forEach((s, i) => hook(reg.get('study', s.type), s as Record<string, unknown>, ['studies', i]));

  spec.mesh?.refine?.forEach((r, i) => checkSel(r.select, ['mesh', 'refine', i, 'select']));

  spec.results?.forEach((r, i) => {
    const path: PathKey[] = ['results', i];
    addId(r.id, path);
    if (!studyMap.has(r.data)) issues.push(issue([...path, 'data'], 'unknown_study', `no study '${r.data}'`));
    checkSel(r.select, [...path, 'select']);
  });

  for (const key of Object.keys(spec.provenance?.values ?? {})) {
    if (!resolveDotted(data, key)) issues.push(issue(['provenance', 'values', key], 'unresolved_path', `provenance path '${key}' does not resolve`));
  }
  spec.assumptions?.forEach((a, i) => {
    if (typeof a === 'string') return;
    a.paths?.forEach((p, j) => { if (!resolveDotted(data, p)) issues.push(issue(['assumptions', i, 'paths', j], 'unresolved_path', `assumption path '${p}' does not resolve`)); });
  });

  // every N/A is covered by a missing entry with that path or a parent path
  const covered: PathKey[][] = [];
  (spec.missing ?? []).forEach((m, i) => {
    if (typeof m === 'string' || !m.path) return;
    const keys = resolveDotted(data, m.path);
    if (keys) covered.push(keys);
    else issues.push(issue(['missing', i, 'path'], 'unresolved_path', `missing path '${m.path}' does not resolve (describe absent items without a path)`));
  });
  const isCovered = (keys: PathKey[]) => covered.some((c) => c.length <= keys.length && c.every((k, i) => k === keys[i]));
  const walk = (x: unknown, keys: PathKey[]) => {
    if (typeof x === 'string') {
      if (x.trim() === NA && !isCovered(keys)) issues.push(issue(keys, 'na_without_missing', `"N/A" at ${dottedOf(keys)} needs a missing entry with path '${idPathOf(data, keys)}'`));
    } else if (Array.isArray(x)) x.forEach((e, i) => walk(e, [...keys, i]));
    else if (isObj(x)) for (const [k, v] of Object.entries(x)) walk(v, [...keys, k]);
  };
  for (const [k, v] of Object.entries(data)) if (!['missing', 'assumptions', 'provenance', 'title', 'description'].includes(k)) walk(v, [k]);
}

/** Validate plain spec data against a registry. */
export function validateSpec(data: unknown, reg: Registry): ValidationResult {
  const issues: SpecIssue[] = [];
  const params = resolveParams(isObj(data) ? data.params : undefined);
  issues.push(...params.issues);
  const schema = buildSpecSchema(reg);
  const r = withScope(params.scope, () => schema.safeParse(data, { error: errorMap as never }), params.failed);
  if (!r.success) flattenIssues(r.error.issues, [], issues);
  if (r.success) crossCheck(r.data, reg, params.scope, issues);
  dedupe(issues);
  return { ok: issues.length === 0, spec: r.success && issues.length === 0 ? r.data : r.success ? r.data : null, issues, params: params.info };
}

function dedupe(issues: SpecIssue[]): void {
  const seen = new Set<string>();
  for (let i = issues.length - 1; i >= 0; i--) {
    const k = `${issues[i]!.pointer}|${issues[i]!.message}`;
    if (seen.has(k)) issues.splice(i, 1); else seen.add(k);
  }
}

export type { EntityKind };
