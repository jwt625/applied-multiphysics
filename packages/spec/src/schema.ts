// SPDX-License-Identifier: GPL-3.0-or-later
// amp-spec/0 schema, defined once with zod v4 (DevLog-003 s.1.1-1.2). The same builder yields
//   - static TS types (z.infer of the generic form, where registered nodes are open records),
//   - the runtime validator for a registry (registered types composed into discriminated unions),
//   - the exported JSON Schema (z.toJSONSchema of the registry form).
// Quantity fields carry their expected SI dimension; expressions are dimension-checked against the params that the
// caller resolved first (withScope). Cross-reference checks live in validate.ts.

import * as z from 'zod';
import { ENTITY_ID, ENTITY_KINDS, ISO_DATE, MATERIAL_REF, NODE_ID, PARAM_NAME, DOTTED_PATH, type EntityKind } from './ids.ts';
import { classifyString, quantityRefs, resolveQuantity, resolveField, dimMatches, dimMismatchMessage, unitlessMessage, type QuantityInput, type DimSpec } from './quantity.ts';
import { units, expressionRefs, FIELD_SYMBOLS, type ScopeValue, type Dim } from './units.ts';
import type { Registry, Registration, RegKind, SpaceDim } from './registry.ts';

export const SCHEMA_ID = 'amp-spec/0';

// ---- quantity scope (params resolved by the caller; parse is synchronous) ------------------------------------
let activeScope: ReadonlyMap<string, ScopeValue> | null = null;
let activeFailed: ReadonlySet<string> = new Set();
let activeSpace: SpaceDim | null = null;
const EMPTY_SCOPE: ReadonlyMap<string, ScopeValue> = new Map();

/**
 * Run fn with params available to quantity checks (expressions are only syntax-checked without a scope). Expressions
 * that reference a param in `failed` are skipped: that param's own issue is already reported.
 */
export function withScope<T>(scope: ReadonlyMap<string, ScopeValue>, fn: () => T, failed: ReadonlySet<string> = new Set(), space: SpaceDim | null = null): T {
  const prev = activeScope, prevFailed = activeFailed, prevSpace = activeSpace;
  activeScope = scope; activeFailed = failed; activeSpace = space;
  try { return fn(); } finally { activeScope = prev; activeFailed = prevFailed; activeSpace = prevSpace; }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- leaf schemas ----------------------------------------------------------------------------------------------
export const nodeId = z.string().regex(NODE_ID, { message: 'id: a letter or underscore, then letters, digits, _ or - (at most 64)' }).meta({ id: 'NodeId' });
export const typeName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const isoDate = z.string().regex(ISO_DATE, { message: 'ISO date YYYY-MM-DD' });
export const dottedPath = z.string().regex(DOTTED_PATH, { message: 'dotted path: keys, indices or element ids joined by "."' });
/** Free text from the model file: untrusted for agent prompts (R5 s.4.5). */
export const freeText = (max = 2000) => z.string().max(max).meta({ 'x-amp-untrusted': true });

export const unitString = z.string().min(1).max(64).superRefine((u, ctx) => {
  try { units.parseUnit(u); } catch (e) { ctx.addIssue({ code: 'custom', message: msg(e), input: u }); }
}).meta({ id: 'Unit', description: 'Unit string, e.g. mm, W/(m^2*K), GHz, degC (affine, literals only)' });

const safeId = (dim: string) => (dim === '*' ? 'any' : dim.replace(/\^/g, '').replace(/\//g, '_per_').replace(/[^A-Za-z0-9_]/g, '_'));

const qCache = new Map<string, z.ZodType<QuantityInput>>();

/** Bounds on the SI value of a quantity (audit S4). Only physical bounds: sizes > 0, absolute temperature >= 0, ... */
export interface Bounds { gt?: number; ge?: number; lt?: number; le?: number }

function isDimless(dim: DimSpec): boolean {
  return dim === '*' || units.dimEq(units.parseUnit(dim).dim, units.dimless);
}

const boundsKey = (b?: Bounds) => (b ? (['gt', 'ge', 'lt', 'le'] as const).filter((k) => b[k] !== undefined).map((k) => `${k}${b[k]}`).join('_') : '');
const idNum = (k: string) => k.replace(/-/g, 'm').replace(/\./g, 'p');

/** Message when an SI value is not finite or violates bounds; null when fine. */
export function boundsMessage(si: number, dim: DimSpec, b?: Bounds): string | null {
  if (!Number.isFinite(si)) return 'value is not finite (overflow or division by zero)';
  if (!b) return null;
  const u = dim === '*' ? '' : ` ${units.formatUnit(units.parseUnit(dim).dim)}`;
  const shown = `${si}${u}`;
  if (b.gt !== undefined && !(si > b.gt)) return `must be > ${b.gt}${u} (got ${shown})`;
  if (b.ge !== undefined && !(si >= b.ge)) return `must be >= ${b.ge}${u} (got ${shown})`;
  if (b.lt !== undefined && !(si < b.lt)) return `must be < ${b.lt}${u} (got ${shown})`;
  if (b.le !== undefined && !(si <= b.le)) return `must be <= ${b.le}${u} (got ${shown})`;
  return null;
}

const boundsMeta = (b?: Bounds) => (b ? {
  ...(b.gt !== undefined ? { 'x-amp-exclusive-min': b.gt } : {}), ...(b.ge !== undefined ? { 'x-amp-min': b.ge } : {}),
  ...(b.lt !== undefined ? { 'x-amp-exclusive-max': b.lt } : {}), ...(b.le !== undefined ? { 'x-amp-max': b.le } : {}),
} : {});

/** Scalar quantity of the given reference SI unit ('*' = any dimension), with optional bounds on the SI value. */
export function quantity(dim: DimSpec = '*', bounds?: Bounds): z.ZodType<QuantityInput> {
  const bk = boundsKey(bounds);
  const key = `${dim}|${bk}`;
  const hit = qCache.get(key);
  if (hit) return hit;
  units.parseUnit(dim === '*' ? '1' : dim); // throws on a bad reference unit at definition time
  const dimless = isDimless(dim);
  const s = z.union([
    z.number(),
    z.string().min(1).max(2000),
    z.strictObject({ value: z.union([z.number(), z.literal('N/A')]), unit: unitString }),
    z.strictObject({ expr: z.string().min(1).max(2000), unit: unitString }),
  ]).superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message, input: v, params: { amp: 'quantity' } });
    if (typeof v === 'number') {
      if (!dimless) issue(unitlessMessage(v, dim));
      else { const m = boundsMessage(v, dim, bounds); if (m) issue(m); }
      return;
    }
    const scope = activeScope;
    const src = typeof v === 'string' ? (classifyString(v).kind === 'expr' ? v : null) : 'expr' in v ? v.expr : null;
    if (src !== null && !scope) { try { expressionRefs(src); } catch (e) { issue(msg(e)); } return; }
    if (typeof v === 'object' && 'expr' in v && activeFailed.size && quantityRefs(v).some((n) => activeFailed.has(n))) return;
    if (typeof v === 'string' && activeFailed.size && quantityRefs(v).some((n) => activeFailed.has(n))) return;
    try {
      const r = resolveQuantity(v, scope ?? EMPTY_SCOPE);
      if (r.na) return;
      if (!dimMatches(r.dim, dim)) { issue(dimMismatchMessage(r.dim, dim)); return; }
      const m = boundsMessage(r.si, dim, bounds);
      if (m) issue(m);
    } catch (e) { issue(msg(e)); }
  }).meta({
    id: `Quantity_${safeId(dim)}${bk ? `_${idNum(bk)}` : ''}`,
    description: `Quantity${dim === '*' ? '' : ` in ${dim}`}: {value, unit}, "5 mm", an expression over params ("2*a", "2[mm] + a") or "N/A"`,
    'x-amp-quantity': dim,
    'x-amp-dimensionless': dimless,
    ...boundsMeta(bounds),
  }) as z.ZodType<QuantityInput>;
  qCache.set(key, s);
  return s;
}

// ---- field-valued settings (contracts v1) ------------------------------------------------------------------------
/** Which field symbols a setting may use: space (x, y, z, r by geometry), time (t), or both. */
export type FieldVars = 'space' | 'time' | 'spacetime';
const SPACE_SYMBOLS: Record<SpaceDim, readonly string[]> = { '1d': ['x'], '2d': ['x', 'y'], '2d-axisym': ['r', 'z'], '3d': ['x', 'y', 'z'] };

/** Symbols allowed for `vars` in the active geometry (all space symbols when the geometry is not known). */
export function fieldSymbols(vars: FieldVars, space: SpaceDim | null = activeSpace): Map<string, Dim> {
  const names = [...(vars === 'time' ? [] : space ? SPACE_SYMBOLS[space] : ['x', 'y', 'z', 'r']), ...(vars === 'space' ? [] : ['t'])];
  return new Map(names.map((n) => [n, FIELD_SYMBOLS.get(n) as Dim]));
}

const fCache = new Map<string, z.ZodType<QuantityInput>>();

/**
 * Field-valued setting (BCs, sources, initial conditions): a quantity, or an expression in params and the field
 * symbols x, y, z, r (m) and t (s) allowed by `vars` and the geometry, as a string or {expr, unit}. Bounds apply
 * when the value is constant.
 */
export function field(dim: DimSpec, opts: { bounds?: Bounds; vars?: FieldVars } = {}): z.ZodType<QuantityInput> {
  const vars = opts.vars ?? 'spacetime';
  const bk = boundsKey(opts.bounds);
  const key = `${dim}|${bk}|${vars}`;
  const hit = fCache.get(key);
  if (hit) return hit;
  units.parseUnit(dim === '*' ? '1' : dim);
  const dimless = isDimless(dim);
  const s = z.union([
    z.number(),
    z.string().min(1).max(2000),
    z.strictObject({ value: z.union([z.number(), z.literal('N/A')]), unit: unitString }),
    z.strictObject({ expr: z.string().min(1).max(2000), unit: unitString }),
  ]).superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message, input: v, params: { amp: 'quantity' } });
    if (typeof v === 'number') {
      if (!dimless) issue(unitlessMessage(v, dim));
      else { const m = boundsMessage(v, dim, opts.bounds); if (m) issue(m); }
      return;
    }
    const src = typeof v === 'string' ? (classifyString(v).kind === 'expr' ? v : null) : 'expr' in v ? v.expr : null;
    if (src !== null) {
      let refs: string[];
      try { refs = expressionRefs(src); } catch (e) { issue(msg(e)); return; }
      const allowed = fieldSymbols(vars);
      const bad = refs.filter((n) => FIELD_SYMBOLS.has(n) && !allowed.has(n));
      if (bad.length) { issue(`${bad.map((n) => `'${n}'`).join(', ')} not available here (allowed: ${[...allowed.keys()].join(', ') || 'none'}${activeSpace ? `; geometry ${activeSpace}` : ''})`); return; }
      if (!activeScope) return;
      if (activeFailed.size && refs.some((n) => activeFailed.has(n))) return;
    }
    try {
      const r = resolveField(v, activeScope ?? EMPTY_SCOPE, src !== null ? fieldSymbols(vars) : new Map());
      if (r.na) return;
      if (!dimMatches(r.dim, dim)) { issue(dimMismatchMessage(r.dim, dim)); return; }
      if (r.si !== null) { const m = boundsMessage(r.si, dim, opts.bounds); if (m) issue(m); }
    } catch (e) { issue(msg(e)); }
  }).meta({
    id: `Field_${safeId(dim)}${bk ? `_${idNum(bk)}` : ''}_${vars}`,
    description: `Field value${dim === '*' ? '' : ` in ${dim}`}: a quantity, or an expression in params and ${vars === 'time' ? 't' : vars === 'space' ? 'x, y, z, r' : 'x, y, z, r, t'} ("100[K]*sin(pi*t/(40[s]))", {expr, unit})`,
    'x-amp-quantity': dim,
    'x-amp-dimensionless': dimless,
    'x-amp-field': vars,
    ...boundsMeta(opts.bounds),
  }) as z.ZodType<QuantityInput>;
  fCache.set(key, s);
  return s;
}

const vCache = new Map<string, z.ZodType>();
export type VectorValue = QuantityInput[] | { value: number[]; unit: string };

/** Vector quantity: an array of scalar quantities, or {value: [..], unit}; bounds apply to every component. */
export function vector(dim: DimSpec, n?: number, bounds?: Bounds, vars?: FieldVars): z.ZodType<VectorValue> {
  const bk = boundsKey(bounds);
  const key = `${dim}|${n ?? ''}|${bk}|${vars ?? ''}`;
  const hit = vCache.get(key);
  if (hit) return hit as z.ZodType<VectorValue>;
  const comp = vars ? field(dim, { ...(bounds ? { bounds } : {}), vars }) : quantity(dim, bounds);
  const arr = n ? z.array(comp).length(n) : z.array(comp).min(1);
  const nums = n ? z.array(z.number()).length(n) : z.array(z.number()).min(1);
  const obj = z.strictObject({ value: nums, unit: unitString }).superRefine((v, ctx) => {
    try {
      const u = units.parseUnit(v.unit);
      if (u.offset !== 0) ctx.addIssue({ code: 'custom', message: 'affine units are not allowed in vectors', path: ['unit'] });
      else if (!dimMatches(u.dim, dim)) ctx.addIssue({ code: 'custom', message: dimMismatchMessage(u.dim, dim), path: ['unit'] });
      else v.value.forEach((x, i) => { const m = boundsMessage(x * u.factor, dim, bounds); if (m) ctx.addIssue({ code: 'custom', message: m, path: ['value', i] }); });
    } catch (e) { ctx.addIssue({ code: 'custom', message: msg(e), path: ['unit'] }); }
  });
  const s = z.union([arr, obj]).meta({
    id: `Vector_${safeId(dim)}${n ? `_${n}` : ''}${bk ? `_${idNum(bk)}` : ''}${vars ? `_${vars}` : ''}`,
    'x-amp-vector': dim, ...(n ? { 'x-amp-length': n } : {}), ...boundsMeta(bounds),
  });
  vCache.set(key, s);
  return s as z.ZodType<VectorValue>;
}

const selCache = new Map<string, z.ZodType<string[]>>();

/** Explicit selection: list of persistent entity ids (C2) of the allowed kinds. */
export function selection(kinds: readonly EntityKind[] = ENTITY_KINDS): z.ZodType<string[]> {
  const key = kinds.join(',');
  const hit = selCache.get(key);
  if (hit) return hit;
  const s = z.array(z.string().regex(ENTITY_ID, { message: 'entity id: <dom|bnd|edg|pnt>:<feature>(.<sub>)*(#k), e.g. bnd:rect1.top' }))
    .min(1)
    .superRefine((ids, ctx) => {
      const seen = new Set<string>();
      ids.forEach((id, i) => {
        if (!ENTITY_ID.test(id)) return; // reported by the regex
        const kind = id.slice(0, 3) as EntityKind;
        if (!kinds.includes(kind)) ctx.addIssue({ code: 'custom', message: `entity kind '${kind}' not allowed here (allowed: ${kinds.join(', ')})`, path: [i] });
        if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `duplicate entity id '${id}'`, path: [i] });
        seen.add(id);
      });
    })
    .meta({ id: `Selection_${kinds.join('_')}`, 'x-amp-selection': [...kinds], description: `Entity ids of kind ${kinds.join('|')}` });
  selCache.set(key, s);
  return s;
}

// ---- fixed blocks ------------------------------------------------------------------------------------------------
export const paramSchema = z.union([
  z.number(),
  z.string().min(1).max(2000),
  z.strictObject({
    value: z.union([z.number(), z.string().min(1).max(2000)]),
    unit: unitString.optional(),
    range: z.tuple([z.number(), z.number()]).optional(),
    description: freeText().optional(),
  }),
]).meta({ description: 'Param: number (dimensionless), "5 mm", expression over other params, or {value, unit, range, description}' });

/** Basis vocabulary with definitions (contracts v1 adds paper_model_input and reference_correlation from L10). */
export const BASIS_DEFINITIONS = {
  analytic: 'closed-form result (e.g. Biot-Savart, Kirsch), exact for the stated idealization',
  textbook: 'value or formula taken from a textbook',
  standard: 'value fixed by a standard or design code (e.g. ISO, Eurocode)',
  benchmark: 'input defined by a published benchmark case (e.g. NAFEMS, Palace examples), as recorded in DevLog research R3',
  handbook: 'value from a reference handbook compilation',
  datasheet: "manufacturer's datasheet value",
  paper: 'value reported in a paper',
  paper_exact: 'value stated exactly in a paper text or table (EO provenance class)',
  figure_digitized: 'value read off a figure by digitization (EO provenance class)',
  paper_model_input: 'value a paper states as an input of its own model, not measured by that paper (APA A6)',
  reference_correlation: 'value computed from a reference equation of state or correlation at the stated condition (e.g. Lemmon 2000 for air; DevLog-013)',
  measured: 'measured value, or an evaluated compilation of measurements',
  derived: 'computed from other sourced values by a stated relation',
  inference: 'project inference from indirect evidence, labelled as such (EO project_inference)',
  user: 'chosen by the user or a modelling choice; not physical data',
  template: 'default of a generator template or family',
  sensitivity: 'value set for a sensitivity-study variant',
  memory: "applied from the user's memory defaults",
  unknown: 'origin unknown',
} as const;
export const BASIS = Object.keys(BASIS_DEFINITIONS) as (keyof typeof BASIS_DEFINITIONS)[] as unknown as readonly [keyof typeof BASIS_DEFINITIONS, ...(keyof typeof BASIS_DEFINITIONS)[]];
/** APA geometry status axis ("status never upgrades"). */
export const STATUS = ['reported', 'derived', 'public', 'template', 'user'] as const;

export const provenanceEntry = z.strictObject({
  basis: z.enum(BASIS).meta({ description: Object.entries(BASIS_DEFINITIONS).map(([k, v]) => `${k}: ${v}`).join('; ') }),
  status: z.enum(STATUS).optional(),
  source: freeText().optional(),
  locator: freeText().optional(),
  date: isoDate.optional(),
  verified_on: isoDate.optional(),
  note: freeText().optional(),
});

export const STAGES = ['geometry', 'mesh', 'solution', 'plots', 'eval'] as const;

export const assumptionEntry = z.union([
  freeText(),
  z.strictObject({ id: nodeId.optional(), text: freeText(), paths: z.array(dottedPath).optional() }),
]);

export const missingEntry = z.union([
  freeText(),
  z.strictObject({
    path: dottedPath.optional(),
    what: freeText(),
    needed_for: z.array(z.enum(STAGES)).optional(),
    source: freeText().optional(),
    note: freeText().optional(),
  }),
]);

/** Strictly positive. */
export const POS: Bounds = Object.freeze({ gt: 0 });
/** Non-negative (absolute temperature, conductances, loss). */
export const NONNEG: Bounds = Object.freeze({ ge: 0 });

export const meshSchema = z.strictObject({
  mesher: typeName.optional(),
  size: z.strictObject({ hmax: quantity('m', POS), hmin: quantity('m', POS).optional(), grading: quantity('1', POS).optional().meta({ description: 'Maximum size growth per unit distance, |dh/dx| (dimensionless; L3 mapping, contract changelog 2026-11-06)' }) }),
  refine: z.array(z.strictObject({ select: selection(), h: quantity('m', POS) })).optional(),
  budget: z.strictObject({ maxNodes: z.number().int().positive().optional(), maxDof: z.number().int().positive().optional() }).optional(),
});

export const RESULT_TYPES = ['plot1d', 'plot2d', 'plot3d', 'table', 'scalar', 'probe'] as const;

export const resultSchema = z.strictObject({
  id: nodeId,
  type: z.enum(RESULT_TYPES),
  label: freeText(200).optional(),
  data: nodeId,
  expr: z.string().min(1).max(2000).optional(),
  unit: unitString.optional(),
  select: selection().optional(),
  at: vector('m').optional(),
  step: z.number().int().nonnegative().optional(),
}).superRefine((r, ctx) => {
  if (r.type === 'probe' && !r.at) ctx.addIssue({ code: 'custom', message: "a probe needs 'at'", path: ['at'] });
});

// ---- registered parts -----------------------------------------------------------------------------------------
export interface Parts {
  feature: z.ZodType;
  physics: z.ZodType;
  coupling: z.ZodType;
  study: z.ZodType;
  override: z.ZodType;
}

const label = freeText(200).meta({ id: 'Label', 'x-amp-untrusted': true }).optional();
const openSettings = z.record(z.string(), z.unknown());

const genericBc = z.strictObject({ id: nodeId, type: typeName, label, select: selection(), settings: openSettings.optional() });
export const GENERIC_PARTS = {
  feature: z.strictObject({ id: nodeId, type: typeName, label, settings: openSettings.optional() }),
  physics: z.strictObject({ id: nodeId, type: typeName, label, select: selection(['dom']), settings: openSettings.optional(), bcs: z.array(genericBc).optional() }),
  coupling: z.strictObject({ id: nodeId, type: typeName, label, from: nodeId, to: nodeId, settings: openSettings.optional() }),
  study: z.strictObject({ id: nodeId, type: typeName, label, physics: z.array(nodeId).min(1), settings: openSettings.optional() }),
  override: z.record(z.string().regex(PARAM_NAME), z.union([quantity('*'), z.strictObject({ symmetry: typeName, unit: unitString.optional(), components: z.record(z.string().regex(PARAM_NAME), z.union([z.number(), quantity('*')])) })])),
};

function specFromParts<P extends Parts>(p: P) {
  return z.strictObject({
    schema: z.literal(SCHEMA_ID),
    id: nodeId,
    title: freeText(200).min(1),
    description: freeText(20000).optional(),
    params: z.record(z.string().regex(PARAM_NAME, { message: 'param name: letter or underscore, then letters, digits or _' }), paramSchema).optional(),
    geometry: z.strictObject({
      dim: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      axisym: z.boolean().optional(),
      features: z.array(p.feature as P['feature']),
    }).superRefine((g, ctx) => {
      if (g.axisym && g.dim !== 2) ctx.addIssue({ code: 'custom', message: 'axisym requires dim 2 (meridional r-z plane)', path: ['axisym'] });
    }),
    materials: z.array(z.strictObject({
      id: nodeId,
      label,
      ref: z.string().regex(MATERIAL_REF, { message: 'materials/<id>' }).optional(),
      override: (p.override as P['override']).optional(),
      select: selection(['dom']),
    }).superRefine((m, ctx) => {
      if (m.ref === undefined && m.override === undefined) ctx.addIssue({ code: 'custom', message: 'a material needs ref or override' });
    })).optional(),
    physics: z.array(p.physics as P['physics']).optional(),
    couplings: z.array(p.coupling as P['coupling']).optional(),
    mesh: meshSchema.optional(),
    studies: z.array(p.study as P['study']).optional(),
    results: z.array(resultSchema).optional(),
    provenance: z.strictObject({ values: z.record(dottedPath, provenanceEntry) }).optional(),
    assumptions: z.array(assumptionEntry).optional(),
    missing: z.array(missingEntry).optional(),
  });
}

/** Generic schema: registered nodes are open records. Source of the static types. */
export const SpecSchema = specFromParts(GENERIC_PARTS);
export type Spec = z.infer<typeof SpecSchema>;
export type FeatureNode = z.infer<typeof GENERIC_PARTS.feature>;
export type PhysicsNode = z.infer<typeof GENERIC_PARTS.physics>;
export type BcNode = z.infer<typeof genericBc>;
export type CouplingNode = z.infer<typeof GENERIC_PARTS.coupling>;
export type StudyNode = z.infer<typeof GENERIC_PARTS.study>;
export type MaterialNode = NonNullable<Spec['materials']>[number];
export type ResultNode = z.infer<typeof resultSchema>;
export type MeshBlock = z.infer<typeof meshSchema>;
export type ParamDef = z.infer<typeof paramSchema>;
export type ProvenanceEntry = z.infer<typeof provenanceEntry>;

// ---- registry form ---------------------------------------------------------------------------------------------
const acceptsEmpty = (s: z.ZodType) => s.safeParse({}).success;
const settingsShape = (r: Registration) => (r.settings ? { settings: acceptsEmpty(r.settings) ? r.settings.optional() : r.settings } : {});

function noneRegistered(kind: string, scope: string): z.ZodType {
  return z.strictObject({ type: typeName }).passthrough().superRefine((v, ctx) => {
    ctx.addIssue({ code: 'custom', message: `no ${kind} types are registered${scope} (type '${v.type}')`, path: ['type'] });
  });
}

/** Discriminated union of registered types; `scope` (e.g. " for physics type 'heat'") is named in errors. */
function union(kind: RegKind, options: z.ZodType[], names: string[], scope = ''): z.ZodType {
  if (!options.length) return noneRegistered(kind, scope);
  const error = (iss: { code?: string; note?: string; input?: unknown }) => {
    if (iss.code === 'invalid_union' && iss.note === 'No matching discriminator') {
      const t = iss.input && typeof iss.input === 'object' ? (iss.input as { type?: unknown }).type : undefined;
      return `unknown ${kind} type ${t === undefined ? '(missing type)' : `'${String(t)}'`}${scope} (registered${scope ? ' there' : ''}: ${names.join(', ')})`;
    }
    return undefined;
  };
  return z.discriminatedUnion('type', options as never, { error } as never);
}

/**
 * Override value of a material property (contracts v1): a scalar quantity (unless scalar: false) and/or tensor forms
 * {symmetry, unit?, components}, one per registered symmetry; components are quantities of the property's dimension,
 * or numbers when `unit` is given, or "N/A". A registration's own `value` schema replaces both.
 */
function propertyValue(r: Registration): z.ZodType {
  if (r.value) return r.value;
  const unit = r.unit as string;
  const forms: z.ZodType[] = [];
  if (r.scalar !== false) forms.push(quantity(unit, r.bounds));
  for (const [sym, comps] of Object.entries(r.tensor ?? {})) {
    const comp = z.union([z.number(), quantity(unit)]);
    forms.push(z.strictObject({ symmetry: z.literal(sym), unit: unitString.optional(), components: z.strictObject(Object.fromEntries(comps.map((c) => [c, comp]))) })
      .superRefine((v, ctx) => {
        let factor: number | null = null;
        if (v.unit !== undefined) {
          try {
            const u = units.parseUnit(v.unit);
            if (u.offset !== 0 || !dimMatches(u.dim, unit)) { ctx.addIssue({ code: 'custom', message: u.offset !== 0 ? 'affine units are not allowed in tensors' : dimMismatchMessage(u.dim, unit), path: ['unit'] }); return; }
            factor = u.factor;
          } catch { return; } // reported by unitString
        }
        for (const [c, x] of Object.entries(v.components)) {
          if (typeof x !== 'number') continue;
          if (factor === null && !isDimless(unit)) ctx.addIssue({ code: 'custom', message: `component ${c}: a bare number needs the tensor 'unit' (or write "${x} <unit>")`, path: ['components', c] });
          else { const m = boundsMessage(x * (factor ?? 1), unit); if (m) ctx.addIssue({ code: 'custom', message: m, path: ['components', c] }); }
        }
      }).meta({ id: `Tensor_${r.type}_${sym.replace(/[^A-Za-z0-9]/g, '_')}`, description: `${r.type} tensor, ${sym} symmetry: components ${comps.join(', ')} in ${unit}` }));
  }
  if (!forms.length) throw new Error(`property '${r.type}': no value form`);
  return forms.length === 1 ? forms[0] as z.ZodType : z.union(forms as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

function registryParts(reg: Registry): Parts {
  const features = reg.list('feature');
  const feature = union('feature', features.map((r) => z.strictObject({ id: nodeId, type: z.literal(r.type), label, ...settingsShape(r) }).meta({ description: r.description })), features.map((r) => r.type));
  const bcs = reg.list('bc');
  // one schema object per bc registration, shared by every physics it covers (one $defs entry in the JSON Schema);
  // a BC name registered for several physics separately gets the physics in its id
  const shared = new Set(bcs.filter((b, i) => bcs.findIndex((c) => c.type === b.type) !== i).map((b) => b.type));
  const bcNode = new Map(bcs.map((b) => [b, z.strictObject({ id: nodeId, type: z.literal(b.type), label, select: selection(b.select), ...settingsShape(b) }).meta({ id: shared.has(b.type) ? `Bc_${(b.for ?? ['any']).join('_').replace(/\*/g, 'any')}_${b.type}` : `Bc_${b.type}`, description: b.description })]));
  const physicsRegs = reg.list('physics');
  const physics = union('physics', physicsRegs.map((r) => {
    const mine = reg.bcsFor(r.type);
    const bcUnion = union('bc', mine.map((b) => bcNode.get(b) as z.ZodType), mine.map((b) => b.type), ` for physics type '${r.type}'`);
    return z.strictObject({ id: nodeId, type: z.literal(r.type), label, select: selection(r.select ?? ['dom']), ...settingsShape(r), bcs: z.array(bcUnion).optional() }).meta({ description: r.description });
  }), physicsRegs.map((r) => r.type));
  const couplings = reg.list('coupling');
  const coupling = union('coupling', couplings.map((r) => z.strictObject({ id: nodeId, type: z.literal(r.type), label, from: nodeId, to: nodeId, ...settingsShape(r) }).meta({ description: r.description })), couplings.map((r) => r.type));
  const studies = reg.list('study');
  const study = union('study', studies.map((r) => z.strictObject({ id: nodeId, type: z.literal(r.type), label, physics: z.array(nodeId).min(1), ...settingsShape(r) }).meta({ description: r.description })), studies.map((r) => r.type));
  const props = reg.list('property');
  const override = z.strictObject(Object.fromEntries(props.map((r) => [r.type, propertyValue(r).optional().meta({ description: r.description })])));
  return { feature, physics, coupling, study, override };
}

const built = new WeakMap<Registry, { version: number; schema: z.ZodType<Spec> }>();

/** Runtime schema for a registry (cached per registry version). */
export function buildSpecSchema(reg: Registry): z.ZodType<Spec> {
  const hit = built.get(reg);
  if (hit && hit.version === reg.version) return hit.schema;
  const schema = specFromParts(registryParts(reg)) as unknown as z.ZodType<Spec>;
  built.set(reg, { version: reg.version, schema });
  return schema;
}

/** JSON Schema (draft 2020-12) of amp-spec/0 for a registry: the one schema agents and external validators read. */
export function specJsonSchema(reg: Registry): Record<string, unknown> {
  const js = z.toJSONSchema(buildSpecSchema(reg), {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    override: (ctx) => {
      const meta = z.globalRegistry.get(ctx.zodSchema as unknown as z.ZodType) as Record<string, unknown> | undefined;
      const j = ctx.jsonSchema as { anyOf?: Array<{ type?: string }> };
      if (meta && meta['x-amp-quantity'] !== undefined && meta['x-amp-dimensionless'] === false && j.anyOf) {
        j.anyOf = j.anyOf.filter((b) => b.type !== 'number'); // bare numbers only for dimensionless quantities
      }
    },
  }) as Record<string, unknown> & { $defs?: Record<string, Record<string, unknown>> };
  // every quantity variant shares one of two form definitions; the variant keeps only its dimension and bounds
  const defs = js.$defs ?? {};
  const forms: Record<string, Record<string, unknown>> = {};
  for (const [k, d] of Object.entries(defs)) {
    if (d['x-amp-quantity'] === undefined || !Array.isArray(d.anyOf)) continue;
    const base = d['x-amp-dimensionless'] ? 'QuantityForms' : 'QuantityFormsDimensional';
    forms[base] ??= { anyOf: d.anyOf, description: 'Quantity: {value, unit} (value a number or "N/A"), "5 mm", an expression over params ("2*a", "2[mm] + a") or "N/A"; bare numbers only for dimensionless quantities' };
    const { anyOf: _a, description: _d, ...rest } = d;
    defs[k] = { $ref: `#/$defs/${base}`, ...rest };
  }
  Object.assign(defs, forms);
  return { $id: 'urn:amp-spec:0', title: SCHEMA_ID, ...js };
}

// ---- schema lookup by path (audit S6 groundwork) ---------------------------------------------------------------
type Def = { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; innerType?: z.ZodType; valueType?: z.ZodType; items?: z.ZodType[]; options?: z.ZodType[]; discriminator?: string; in?: z.ZodType; values?: unknown[] };
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;
const isObjLike = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function unwrap(s: z.ZodType, data: unknown): z.ZodType {
  for (let i = 0; i < 32; i++) {
    const d = defOf(s);
    if ((d.type === 'optional' || d.type === 'nullable' || d.type === 'default' || d.type === 'readonly') && d.innerType) { s = d.innerType; continue; }
    if (d.type === 'pipe' && d.in) { s = d.in; continue; }
    if (d.type === 'union' && d.discriminator && isObjLike(data)) {
      const want = data[d.discriminator];
      const hit = d.options?.find((o) => defOf(defOf(o).shape?.[d.discriminator as string] as z.ZodType)?.values?.includes(want));
      if (hit) { s = hit; continue; }
    }
    return s;
  }
  return s;
}

/**
 * The sub-schema that governs the value at a JSON Pointer (`@id` tokens allowed), for type-checking a patch value
 * before apply and for showing an agent or a form only the relevant part. Registered unions are resolved with `data`
 * (the current spec) by their `type`. Returns null when the pointer leaves the schema.
 */
export function schemaAt(reg: Registry, pointer: string, data?: unknown): { schema: z.ZodType; json: Record<string, unknown> } | null {
  const tokens = pointer === '' ? [] : pointer.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  let s: z.ZodType = buildSpecSchema(reg);
  let cur: unknown = data;
  for (const t of tokens) {
    s = unwrap(s, cur);
    const d = defOf(s);
    if (d.type === 'object' && d.shape) {
      const next = d.shape[t];
      if (!next) return null;
      s = next; cur = isObjLike(cur) ? cur[t] : undefined;
    } else if (d.type === 'array' && d.element) {
      const arr = Array.isArray(cur) ? cur : [];
      const i = t.startsWith('@') ? arr.findIndex((e) => isObjLike(e) && e.id === t.replace(/^@|\+$/g, '')) : Number(t);
      s = d.element; cur = arr[i];
    } else if (d.type === 'record' && d.valueType) {
      s = d.valueType; cur = isObjLike(cur) ? cur[t] : undefined;
    } else if (d.type === 'tuple' && d.items) {
      const next = d.items[Number(t)];
      if (!next) return null;
      s = next; cur = Array.isArray(cur) ? cur[Number(t)] : undefined;
    } else return null;
  }
  s = unwrap(s, cur);
  const json = z.toJSONSchema(s, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown> & { $ref?: string; $defs?: Record<string, Record<string, unknown>> };
  // a sub-schema with its own id comes back as {$ref, $defs}: inline the referenced definition at the top
  const ref = typeof json.$ref === 'string' && json.$ref.startsWith('#/$defs/') ? json.$defs?.[json.$ref.slice(8)] : undefined;
  if (ref) { const { $ref: _r, ...rest } = json; return { schema: s, json: { ...rest, ...ref } }; }
  return { schema: s, json };
}
