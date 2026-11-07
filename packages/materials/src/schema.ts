// SPDX-License-Identifier: GPL-3.0-or-later
// Schema `amp-material/0` (DevLog-013 s.1.1): one YAML per material under materials/<id>.yaml. The zod definition is
// the single source of the static types and of the exported JSON Schema; semantic checks (units vs property
// dimension, source keys, monotonic tables, formula coefficients, tensor components) live in validate.ts.

import * as z from 'zod';

export const SCHEMA_ID = 'amp-material/0';

/** Basis vocabulary: APA DevLog-010 A6 plus `standard` and `reference_correlation` (DevLog-013 s.1.1). */
export const BASIS = ['measured', 'handbook', 'datasheet', 'paper_model_input', 'derived', 'standard', 'reference_correlation'] as const;
export const ACCESS = ['open', 'vendor_open', 'paywalled', 'local_cache'] as const;
export const CLASSES = ['metal', 'gas', 'liquid', 'semiconductor', 'glass', 'crystal', 'polymer', 'ceramic', 'piezoelectric', 'dielectric_film'] as const;
export const VARIABLES = ['T', 'lambda', 'f'] as const;
export const SYMMETRIES = ['cubic', 'uniaxial', 'trigonal-3m'] as const;
export const STAGES = ['geometry', 'mesh', 'solution', 'plots', 'eval'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

const text = (max = 4000) => z.string().min(1).max(max);
const isoDate = z.string().regex(ISO_DATE, { message: 'ISO date YYYY-MM-DD' });
const NA = z.literal('N/A');
const quantityString = z.string().regex(/^(N\/A|[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*\S*.*)$/, { message: 'quantity "<number> <unit>"' });
const finite = z.number().refine(Number.isFinite, { message: 'finite number' });

export const uncertaintySchema = z.union([
  z.strictObject({
    abs: finite.optional(),
    rel: finite.optional(),
    range: z.tuple([finite, finite]).optional(),
    unit: text(64).optional(),
    note: text().optional(),
  }).refine((u) => u.abs !== undefined || u.rel !== undefined || u.range !== undefined, { message: 'uncertainty needs abs, rel or range (or {na: reason})' }),
  z.strictObject({ na: text() }),
]).meta({ description: 'Uncertainty or range as stated by the source ({abs, unit} | {rel} | {range}); {na: reason} when the source states none' });

export const conditionsSchema = z.strictObject({
  T: quantityString.optional(),
  p: quantityString.optional(),
  lambda: quantityString.optional(),
  f: quantityString.optional(),
  text: text().optional(),
}).meta({ description: 'Conditions of the value (temperature, pressure, wavelength, frequency, free text)' });

export const tableSchema = z.strictObject({
  x: z.enum(VARIABLES),
  x_unit: text(32),
  xs: z.array(finite).min(2),
  ys: z.array(finite).min(2),
  interp: z.enum(['linear', 'loglog']).optional(),
}).meta({ description: 'Tabulated y(x); x strictly increasing; valid range = table span; linear interpolation unless loglog' });

export const fitSchema = z.strictObject({
  formula: text(64),
  vars: z.array(z.strictObject({ name: z.enum(VARIABLES), unit: text(32), range: z.tuple([finite, finite]) })).min(1),
  coeffs: z.record(z.string(), z.union([finite, z.array(finite)])),
}).meta({ description: 'Fit with a formula id implemented in @amp/materials/formulas; vars carry unit and validity range' });

const valueForms = {
  value: z.union([finite, NA]).optional(),
  table: tableSchema.optional(),
  fit: fitSchema.optional(),
};

export const componentSchema = z.union([
  finite,
  NA,
  z.strictObject({
    ...valueForms,
    locator: text().optional(),
    uncertainty: uncertaintySchema.optional(),
    note: text().optional(),
  }),
]);

export const tensorSchema = z.strictObject({
  symmetry: z.enum(SYMMETRIES),
  components: z.record(z.string(), componentSchema),
}).meta({ description: 'Tensor property: independent components for the symmetry (cubic C11 C12 C44; uniaxial perp par; trigonal-3m r13 r22 r33 r51)' });

const provenance = {
  unit: text(64),
  basis: z.enum(BASIS).optional(),
  source: z.union([text(64), z.array(text(64)).min(1)]).optional(),
  locator: text().optional(),
  accessed: isoDate.optional(),
  uncertainty: uncertaintySchema.optional(),
  conditions: conditionsSchema.optional(),
  cte_kind: z.enum(['instantaneous', 'secant']).optional(),
  T_ref: quantityString.optional(),
  derivation: text().optional(),
  analog_of: text(200).optional(),
  note: text().optional(),
  missing: text().optional(),
  needed_for: z.array(z.enum(STAGES)).optional(),
};

const leafShape = { ...valueForms, tensor: tensorSchema.optional(), ...provenance };

export const alternativeSchema = z.strictObject({
  id: z.string().regex(KEY),
  use: text(400),
  ...leafShape,
});

export const leafSchema = z.strictObject({
  ...leafShape,
  alternatives: z.array(alternativeSchema),
}).meta({ description: 'Property leaf: exactly one of value | table | fit | tensor; value N/A needs missing' });

export const sourceSchema = z.strictObject({
  citation: text(),
  doi: text(200).optional(),
  url: text(1000).optional(),
  access: z.enum(ACCESS),
  read: text(),
  via: text().optional(),
  licence: text(400).optional(),
});

export const materialSchema = z.strictObject({
  schema: z.literal(SCHEMA_ID),
  id: z.string().regex(ID),
  name: text(200),
  class: z.enum(CLASSES),
  description: text(),
  verified_on: isoDate,
  frame: text().optional(),
  sources: z.record(z.string().regex(KEY), sourceSchema),
  properties: z.record(z.string(), leafSchema),
  missing: z.array(z.strictObject({ property: z.string().optional(), what: text(), needed_for: z.array(z.enum(STAGES)).optional() })).optional(),
  assumptions: z.array(z.strictObject({ id: z.string().regex(KEY), text: text() })).optional(),
});

export type MaterialDoc = z.infer<typeof materialSchema>;
export type Leaf = z.infer<typeof leafSchema>;
export type AltLeaf = z.infer<typeof alternativeSchema>;
export type Table = z.infer<typeof tableSchema>;
export type Fit = z.infer<typeof fitSchema>;
export type Tensor = z.infer<typeof tensorSchema>;
export type Component = z.infer<typeof componentSchema>;
export type Uncertainty = z.infer<typeof uncertaintySchema>;
export type Conditions = z.infer<typeof conditionsSchema>;

export function materialJsonSchema(): Record<string, unknown> {
  const js = z.toJSONSchema(materialSchema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  return { $id: 'urn:amp-material:0', title: SCHEMA_ID, ...js };
}
