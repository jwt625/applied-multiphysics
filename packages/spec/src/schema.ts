// SPDX-License-Identifier: GPL-3.0-or-later
// amp-spec/0 schema, defined once with zod v4 (DevLog-003 s.1.1-1.2). The same builder yields
//   - static TS types (z.infer of the generic form, where registered nodes are open records),
//   - the runtime validator for a registry (registered types composed into discriminated unions),
//   - the exported JSON Schema (z.toJSONSchema of the registry form).
// Quantity fields carry their expected SI dimension; expressions are dimension-checked against the params that the
// caller resolved first (withScope). Cross-reference checks live in validate.ts.

import * as z from 'zod';
import { ENTITY_ID, ENTITY_KINDS, ISO_DATE, MATERIAL_REF, NODE_ID, PARAM_NAME, DOTTED_PATH, type EntityKind } from './ids.ts';
import { classifyString, quantityRefs, resolveQuantity, dimMatches, dimMismatchMessage, unitlessMessage, type QuantityInput, type DimSpec } from './quantity.ts';
import { units, expressionRefs, type ScopeValue } from './units.ts';
import type { Registry, Registration, RegKind } from './registry.ts';

export const SCHEMA_ID = 'amp-spec/0';

// ---- quantity scope (params resolved by the caller; parse is synchronous) ------------------------------------
let activeScope: ReadonlyMap<string, ScopeValue> | null = null;
let activeFailed: ReadonlySet<string> = new Set();
const EMPTY_SCOPE: ReadonlyMap<string, ScopeValue> = new Map();

/**
 * Run fn with params available to quantity checks (expressions are only syntax-checked without a scope). Expressions
 * that reference a param in `failed` are skipped: that param's own issue is already reported.
 */
export function withScope<T>(scope: ReadonlyMap<string, ScopeValue>, fn: () => T, failed: ReadonlySet<string> = new Set()): T {
  const prev = activeScope, prevFailed = activeFailed;
  activeScope = scope; activeFailed = failed;
  try { return fn(); } finally { activeScope = prev; activeFailed = prevFailed; }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- leaf schemas ----------------------------------------------------------------------------------------------
export const nodeId = z.string().regex(NODE_ID, { message: 'id: a letter or underscore, then letters, digits, _ or - (at most 64)' });
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

function isDimless(dim: DimSpec): boolean {
  return dim !== '*' && units.dimEq(units.parseUnit(dim).dim, units.dimless);
}

/** Scalar quantity of the given reference SI unit ('*' = any dimension). */
export function quantity(dim: DimSpec = '*'): z.ZodType<QuantityInput> {
  const hit = qCache.get(dim);
  if (hit) return hit;
  units.parseUnit(dim === '*' ? '1' : dim); // throws on a bad reference unit at definition time
  const dimless = dim === '*' || isDimless(dim);
  const s = z.union([
    z.number(),
    z.string().min(1).max(2000),
    z.strictObject({ value: z.union([z.number(), z.literal('N/A')]), unit: unitString }),
  ]).superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message, input: v, params: { amp: 'quantity' } });
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) issue('non-finite number');
      else if (!dimless) issue(unitlessMessage(v, dim));
      return;
    }
    const scope = activeScope;
    if (typeof v === 'string' && !scope) {
      const f = classifyString(v);
      if (f.kind === 'expr') { try { expressionRefs(f.src); } catch (e) { issue(msg(e)); } return; }
    }
    if (typeof v === 'string' && activeFailed.size && quantityRefs(v).some((n) => activeFailed.has(n))) return;
    try {
      const r = resolveQuantity(v, scope ?? EMPTY_SCOPE);
      if (!r.na && !dimMatches(r.dim, dim)) issue(dimMismatchMessage(r.dim, dim));
    } catch (e) { issue(msg(e)); }
  }).meta({
    id: `Quantity_${safeId(dim)}`,
    description: `Quantity${dim === '*' ? '' : ` in ${dim}`}: {value, unit}, "5 mm", an expression over params ("2*a", "2[mm] + a") or "N/A"`,
    'x-amp-quantity': dim,
    'x-amp-dimensionless': dimless,
  }) as z.ZodType<QuantityInput>;
  qCache.set(dim, s);
  return s;
}

const vCache = new Map<string, z.ZodType>();
export type VectorValue = QuantityInput[] | { value: number[]; unit: string };

/** Vector quantity: an array of scalar quantities, or {value: [..], unit}. */
export function vector(dim: DimSpec, n?: number): z.ZodType<VectorValue> {
  const key = `${dim}|${n ?? ''}`;
  const hit = vCache.get(key);
  if (hit) return hit as z.ZodType<VectorValue>;
  const arr = n ? z.array(quantity(dim)).length(n) : z.array(quantity(dim)).min(1);
  const nums = n ? z.array(z.number()).length(n) : z.array(z.number()).min(1);
  const obj = z.strictObject({ value: nums, unit: unitString }).superRefine((v, ctx) => {
    try {
      const u = units.parseUnit(v.unit);
      if (u.offset !== 0) ctx.addIssue({ code: 'custom', message: 'affine units are not allowed in vectors', path: ['unit'] });
      else if (!dimMatches(u.dim, dim)) ctx.addIssue({ code: 'custom', message: dimMismatchMessage(u.dim, dim), path: ['unit'] });
    } catch (e) { ctx.addIssue({ code: 'custom', message: msg(e), path: ['unit'] }); }
  });
  const s = z.union([arr, obj]).meta({ 'x-amp-vector': dim, ...(n ? { 'x-amp-length': n } : {}) });
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
    .meta({ 'x-amp-selection': [...kinds], description: `Entity ids of kind ${kinds.join('|')}` });
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

export const BASIS = [
  'analytic', 'textbook', 'standard', 'benchmark', 'handbook', 'datasheet', 'paper', 'paper_exact', 'figure_digitized',
  'measured', 'derived', 'inference', 'user', 'template', 'sensitivity', 'memory', 'unknown',
] as const;
/** APA geometry status axis ("status never upgrades"). */
export const STATUS = ['reported', 'derived', 'public', 'template', 'user'] as const;

export const provenanceEntry = z.strictObject({
  basis: z.enum(BASIS),
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

export const meshSchema = z.strictObject({
  mesher: typeName.optional(),
  size: z.strictObject({ hmax: quantity('m'), hmin: quantity('m').optional(), grading: quantity('1').optional() }),
  refine: z.array(z.strictObject({ select: selection(), h: quantity('m') })).optional(),
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

const label = freeText(200).optional();
const openSettings = z.record(z.string(), z.unknown());

const genericBc = z.strictObject({ id: nodeId, type: typeName, label, select: selection(), settings: openSettings.optional() });
export const GENERIC_PARTS = {
  feature: z.strictObject({ id: nodeId, type: typeName, label, settings: openSettings.optional() }),
  physics: z.strictObject({ id: nodeId, type: typeName, label, select: selection(['dom']), settings: openSettings.optional(), bcs: z.array(genericBc).optional() }),
  coupling: z.strictObject({ id: nodeId, type: typeName, label, from: nodeId, to: nodeId, settings: openSettings.optional() }),
  study: z.strictObject({ id: nodeId, type: typeName, label, physics: z.array(nodeId).min(1), settings: openSettings.optional() }),
  override: z.record(z.string().regex(PARAM_NAME), quantity('*')),
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

function noneRegistered(kind: RegKind): z.ZodType {
  return z.strictObject({ type: typeName }).passthrough().superRefine((v, ctx) => {
    ctx.addIssue({ code: 'custom', message: `no ${kind} types are registered (type '${v.type}')`, path: ['type'] });
  });
}

function union(kind: RegKind, options: z.ZodType[], names: string[]): z.ZodType {
  if (!options.length) return noneRegistered(kind);
  const error = (iss: { code?: string; note?: string; input?: unknown }) => {
    if (iss.code === 'invalid_union' && iss.note === 'No matching discriminator') {
      const t = iss.input && typeof iss.input === 'object' ? (iss.input as { type?: unknown }).type : undefined;
      return `unknown ${kind} type ${t === undefined ? '(missing type)' : `'${String(t)}'`} (registered: ${names.join(', ')})`;
    }
    return undefined;
  };
  return z.discriminatedUnion('type', options as never, { error } as never);
}

function registryParts(reg: Registry): Parts {
  const features = reg.list('feature');
  const feature = union('feature', features.map((r) => z.strictObject({ id: nodeId, type: z.literal(r.type), label, ...settingsShape(r) }).meta({ description: r.description })), features.map((r) => r.type));
  const bcs = reg.list('bc');
  const physicsRegs = reg.list('physics');
  const physics = union('physics', physicsRegs.map((r) => {
    const mine = bcs.filter((b) => b.for?.includes(r.type) || b.for?.includes('*'));
    const bcUnion = union('bc', mine.map((b) => z.strictObject({ id: nodeId, type: z.literal(b.type), label, select: selection(b.select), ...settingsShape(b) }).meta({ description: b.description })), mine.map((b) => b.type));
    return z.strictObject({ id: nodeId, type: z.literal(r.type), label, select: selection(r.select ?? ['dom']), ...settingsShape(r), bcs: z.array(bcUnion).optional() }).meta({ description: r.description });
  }), physicsRegs.map((r) => r.type));
  const couplings = reg.list('coupling');
  const coupling = union('coupling', couplings.map((r) => z.strictObject({ id: nodeId, type: z.literal(r.type), label, from: nodeId, to: nodeId, ...settingsShape(r) }).meta({ description: r.description })), couplings.map((r) => r.type));
  const studies = reg.list('study');
  const study = union('study', studies.map((r) => z.strictObject({ id: nodeId, type: z.literal(r.type), label, physics: z.array(nodeId).min(1), ...settingsShape(r) }).meta({ description: r.description })), studies.map((r) => r.type));
  const props = reg.list('property');
  const override = z.strictObject(Object.fromEntries(props.map((r) => [r.type, quantity(r.unit as string).optional().meta({ description: r.description })])));
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
  }) as Record<string, unknown>;
  return { $id: 'urn:amp-spec:0', title: SCHEMA_ID, ...js };
}
