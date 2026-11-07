// SPDX-License-Identifier: GPL-3.0-or-later
// Parse + validate one amp-material/0 document (DevLog-013 s.1.5 gate 1): zod structure, then semantic checks.

import { parse as parseYaml } from 'yaml';
import { materialSchema, type MaterialDoc, type Leaf, type AltLeaf, type Table, type Fit, type Component, type Valid } from './schema.ts';
import { PROPERTY_BY_NAME, SYMMETRY_COMPONENTS, type PropertyDef, type Symmetry } from './properties.ts';
import { FORMULAS, checkFormulaCoeffs } from './formulas.ts';
import { parseUnit, parseQuantity, sameDim } from './units.ts';

export interface Issue { path: string; message: string }

const VAR_UNIT: Record<string, string> = { T: 'K', lambda: 'm', f: 'Hz' };

function unitDim(u: string): number[] | null {
  try { return parseUnit(u).dim; } catch { return null; }
}

function checkVarUnit(issues: Issue[], where: string, v: string, unit: string): void {
  const d = unitDim(unit);
  if (!d) issues.push({ path: where, message: `unit '${unit}' does not parse` });
  else if (!sameDim(d, parseUnit(VAR_UNIT[v] as string).dim)) issues.push({ path: where, message: `unit '${unit}' is not a ${v} unit` });
}

function checkTable(issues: Issue[], where: string, t: Table): void {
  if (t.xs.length !== t.ys.length) issues.push({ path: where, message: `xs (${t.xs.length}) and ys (${t.ys.length}) differ in length` });
  for (let i = 1; i < t.xs.length; i++) if (!((t.xs[i] as number) > (t.xs[i - 1] as number))) { issues.push({ path: `${where}.xs`, message: 'xs must be strictly increasing' }); break; }
  if (t.interp === 'loglog' && [...t.xs, ...t.ys].some((v) => !(v > 0))) issues.push({ path: where, message: 'loglog interpolation needs positive xs and ys' });
  checkVarUnit(issues, `${where}.x_unit`, t.x, t.x_unit);
}

function checkFit(issues: Issue[], where: string, f: Fit): void {
  for (const m of checkFormulaCoeffs(f.formula, f.coeffs)) issues.push({ path: `${where}.coeffs`, message: m });
  const fm = FORMULAS[f.formula];
  if (fm) {
    const names = f.vars.map((v) => v.name).sort().join(',');
    if (names !== [...fm.vars].sort().join(',')) issues.push({ path: `${where}.vars`, message: `formula ${f.formula} takes vars [${fm.vars.join(', ')}]` });
  }
  f.vars.forEach((v, i) => {
    checkVarUnit(issues, `${where}.vars.${i}.unit`, v.name, v.unit);
    if (!(v.range[1] > v.range[0])) issues.push({ path: `${where}.vars.${i}.range`, message: 'range must be [lo, hi] with hi > lo' });
  });
}

function checkValid(issues: Issue[], where: string, v: Valid): void {
  let n = 0;
  for (const k of ['T', 'lambda', 'f'] as const) {
    const e = v[k];
    if (!e) continue;
    n++;
    if ('unit' in e) {
      checkVarUnit(issues, `${where}.${k}.unit`, k, e.unit);
      if (!(e.range[1] >= e.range[0])) issues.push({ path: `${where}.${k}.range`, message: 'range must be [lo, hi] with hi >= lo' });
    }
  }
  if (n === 0) issues.push({ path: where, message: 'valid needs at least one of T, lambda, f' });
}

function forms(l: { value?: unknown; table?: unknown; fit?: unknown; tensor?: unknown }): string[] {
  return (['value', 'table', 'fit', 'tensor'] as const).filter((k) => l[k] !== undefined);
}

function checkComponent(issues: Issue[], where: string, c: Component): boolean {
  if (c === 'N/A') return true;
  if (typeof c === 'number') return false;
  const f = forms(c);
  if (f.length !== 1 || f[0] === 'tensor') issues.push({ path: where, message: 'component needs exactly one of value | table | fit' });
  if (c.table) checkTable(issues, `${where}.table`, c.table);
  if (c.fit) checkFit(issues, `${where}.fit`, c.fit);
  return c.value === 'N/A';
}

function checkLeaf(issues: Issue[], where: string, l: Leaf | AltLeaf, def: PropertyDef, sources: Record<string, unknown>): void {
  const f = forms(l);
  if (f.length !== 1) { issues.push({ path: where, message: `exactly one of value | table | fit | tensor required (found ${f.join(', ') || 'none'})` }); return; }
  const ud = unitDim(l.unit);
  if (!ud) issues.push({ path: `${where}.unit`, message: `unit '${l.unit}' does not parse` });
  else if (!sameDim(ud, parseUnit(def.unit).dim)) issues.push({ path: `${where}.unit`, message: `unit '${l.unit}' has another dimension than ${def.name} (${def.unit})` });
  if (l.value === 'N/A') {
    if (!l.missing) issues.push({ path: where, message: 'N/A value needs `missing` (why, and what source would fill it)' });
    return;
  }
  let naComponent = false;
  if (l.tensor) {
    const sym = l.tensor.symmetry as Symmetry;
    if (!def.tensor.includes(sym)) issues.push({ path: `${where}.tensor.symmetry`, message: `${def.name} does not take a ${sym} tensor (allowed: ${def.tensor.join(', ') || 'none'})` });
    const want = SYMMETRY_COMPONENTS[sym];
    const have = Object.keys(l.tensor.components);
    for (const k of want) if (!have.includes(k)) issues.push({ path: `${where}.tensor.components`, message: `component ${k} missing (use N/A with missing)` });
    for (const k of have) if (!want.includes(k)) issues.push({ path: `${where}.tensor.components.${k}`, message: `unknown component for ${sym}` });
    for (const [k, c] of Object.entries(l.tensor.components)) naComponent = checkComponent(issues, `${where}.tensor.components.${k}`, c) || naComponent;
    if (naComponent && !l.missing) issues.push({ path: where, message: 'N/A tensor component needs `missing` on the leaf' });
  } else if (!def.scalar) issues.push({ path: where, message: `${def.name} is a tensor property (symmetries: ${def.tensor.join(', ')})` });
  const singleNumber = typeof l.value === 'number' || l.tensor !== undefined;
  if (singleNumber && !l.valid) issues.push({ path: `${where}.valid`, message: 'a single-number value needs `valid` (range per T / lambda / f, or {na: reason})' });
  if (l.valid) checkValid(issues, `${where}.valid`, l.valid);
  if ((def.name === 'n' || def.name === 'dndT') && !l.n_medium) issues.push({ path: `${where}.n_medium`, message: 'refractive-index data need n_medium: air | vacuum | unstated' });
  if (l.n_medium === 'unstated' && !l.n_medium_note) issues.push({ path: `${where}.n_medium_note`, message: 'n_medium unstated needs a note' });
  for (const k of ['basis', 'source', 'locator', 'accessed', 'uncertainty', 'conditions'] as const)
    if (l[k] === undefined) issues.push({ path: `${where}.${k}`, message: `${k} required for a non-N/A value` });
  for (const s of l.source === undefined ? [] : ([] as string[]).concat(l.source))
    if (!Object.hasOwn(sources, s)) issues.push({ path: `${where}.source`, message: `source '${s}' not in sources` });
  if (l.table) checkTable(issues, `${where}.table`, l.table);
  if (l.fit) checkFit(issues, `${where}.fit`, l.fit);
  if (def.name === 'alpha') {
    if (!l.cte_kind) issues.push({ path: `${where}.cte_kind`, message: 'CTE needs cte_kind: instantaneous | secant (APA A6)' });
    if (l.cte_kind === 'secant' && !l.T_ref) issues.push({ path: `${where}.T_ref`, message: 'secant CTE needs T_ref' });
  }
  for (const [k, q] of [['T_ref', l.T_ref], ...Object.entries(l.conditions ?? {}).filter(([k]) => k !== 'text')] as Array<[string, string | undefined]>) {
    if (q === undefined) continue;
    try { parseQuantity(q); } catch (e) { issues.push({ path: `${where}.${k}`, message: (e as Error).message }); }
  }
}

export function validateDoc(doc: unknown, fileStem?: string): { ok: boolean; doc?: MaterialDoc; issues: Issue[] } {
  const r = materialSchema.safeParse(doc);
  if (!r.success) return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  const d = r.data;
  const issues: Issue[] = [];
  if (fileStem !== undefined && d.id !== fileStem) issues.push({ path: 'id', message: `id '${d.id}' must equal the file name '${fileStem}'` });
  for (const [name, leaf] of Object.entries(d.properties)) {
    const def = PROPERTY_BY_NAME.get(name);
    if (!def) { issues.push({ path: `properties.${name}`, message: `unknown property '${name}' (registered: ${[...PROPERTY_BY_NAME.keys()].join(', ')})` }); continue; }
    checkLeaf(issues, `properties.${name}`, leaf, def, d.sources);
    const seen = new Set<string>();
    leaf.alternatives.forEach((a, i) => {
      if (seen.has(a.id)) issues.push({ path: `properties.${name}.alternatives.${i}.id`, message: `duplicate alternative id '${a.id}'` });
      seen.add(a.id);
      checkLeaf(issues, `properties.${name}.alternatives.${a.id}`, a, def, d.sources);
    });
  }
  for (const [i, m] of (d.missing ?? []).entries())
    if (m.property !== undefined && !PROPERTY_BY_NAME.has(m.property)) issues.push({ path: `missing.${i}.property`, message: `unknown property '${m.property}'` });
  return { ok: issues.length === 0, doc: d, issues };
}

export function parseMaterialText(text: string, fileStem?: string): { ok: boolean; doc?: MaterialDoc; issues: Issue[] } {
  let raw: unknown;
  try {
    raw = parseYaml(text, { uniqueKeys: true, merge: false, maxAliasCount: 0 });
  } catch (e) {
    return { ok: false, issues: [{ path: '', message: `YAML: ${(e as Error).message}` }] };
  }
  return validateDoc(raw, fileStem);
}
