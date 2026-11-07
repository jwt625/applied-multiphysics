// SPDX-License-Identifier: GPL-3.0-or-later
// Materials library: property evaluation at temperature / wavelength / frequency, conversion to SI, tensors
// (DevLog-013 s.1.2). Values come only from validated amp-material/0 documents; nothing is defaulted here.
// The one derivation rule: sigma = 1 / rho_e when a material gives rho_e and no sigma (stated in the result).

import type { MaterialDoc, Leaf, AltLeaf, Table, Fit, Component, Uncertainty, Conditions } from './schema.ts';
import { PROPERTY_BY_NAME, tensorMatrix, type Symmetry } from './properties.ts';
import { FORMULAS } from './formulas.ts';
import { parseUnit, toSI, fromSI, parseQuantity } from './units.ts';

export interface EvalOptions {
  /** Temperature in K. */
  T?: number;
  /** Vacuum wavelength in m. */
  lambda?: number;
  /** Frequency in Hz. */
  f?: number;
  /** Return one tensor component as a scalar (e.g. 'C11', 'perp', 'r33'). */
  component?: string;
  /** Use a named alternative instead of the default leaf. */
  alternative?: string;
  /** Evaluate tables / fits outside their valid range (linear extrapolation for tables); flagged in the result. */
  extrapolate?: boolean;
}

export interface PropertyValue {
  material: string;
  property: string;
  /** SI value in `unit`: a number, or the independent tensor components. */
  value: number | Record<string, number>;
  /** SI reference unit of the property. */
  unit: string;
  symmetry?: Symmetry;
  /** Full tensor (Voigt 6x6 for C, 3x3 for uniaxial, 6x3 for trigonal-3m r). */
  matrix?: number[][];
  /** Citation(s) of the source(s) with DOI / URL, joined by '; '. */
  source: string;
  sourceKeys: string[];
  basis: string;
  locator: string;
  accessed: string;
  conditions?: Conditions;
  uncertainty?: Uncertainty;
  alternative?: string;
  derived?: string;
  analogOf?: string;
  cteKind?: 'instantaneous' | 'secant';
  /** Reference temperature of a secant CTE, K. */
  T_ref?: number;
  extrapolated?: boolean;
}

export class MaterialNAError extends Error {
  readonly missing: string;
  constructor(material: string, property: string, missing: string) {
    super(`${material}.${property} is N/A: ${missing}`);
    this.name = 'MaterialNAError';
    this.missing = missing;
  }
}

export class MaterialRangeError extends Error {
  constructor(message: string) { super(message); this.name = 'MaterialRangeError'; }
}

const VAR_SI: Record<string, keyof EvalOptions> = { T: 'T', lambda: 'lambda', f: 'f' };

interface Ctx { mat: string; prop: string; opts: EvalOptions; extrapolated: boolean }

function query(ctx: Ctx, v: string): number {
  const q = ctx.opts[VAR_SI[v] as 'T' | 'lambda' | 'f'];
  if (typeof q !== 'number' || !Number.isFinite(q)) throw new Error(`${ctx.mat}.${ctx.prop} depends on ${v}: pass {${v}} in SI (${v === 'T' ? 'K' : v === 'lambda' ? 'm' : 'Hz'})`);
  return q;
}

function evalTable(ctx: Ctx, t: Table): number {
  const x = fromSI(query(ctx, t.x), parseUnit(t.x_unit));
  const xs = t.xs, ys = t.ys, n = xs.length;
  const lo = xs[0] as number, hi = xs[n - 1] as number;
  if (x < lo || x > hi) {
    if (!ctx.opts.extrapolate) throw new MaterialRangeError(`${ctx.mat}.${ctx.prop}: ${t.x} = ${x} ${t.x_unit} outside the table range [${lo}, ${hi}] ${t.x_unit}`);
    ctx.extrapolated = true;
  }
  let i = 0;
  while (i < n - 2 && x > (xs[i + 1] as number)) i++;
  const x0 = xs[i] as number, x1 = xs[i + 1] as number, y0 = ys[i] as number, y1 = ys[i + 1] as number;
  if (t.interp === 'loglog') {
    const s = (Math.log(x) - Math.log(x0)) / (Math.log(x1) - Math.log(x0));
    return Math.exp(Math.log(y0) + s * (Math.log(y1) - Math.log(y0)));
  }
  return y0 + (x - x0) / (x1 - x0) * (y1 - y0);
}

function evalFit(ctx: Ctx, f: Fit): number {
  const fm = FORMULAS[f.formula];
  if (!fm) throw new Error(`unknown formula ${f.formula}`);
  const x: Record<string, number> = {};
  for (const v of f.vars) {
    const xv = fromSI(query(ctx, v.name), parseUnit(v.unit));
    if (xv < v.range[0] || xv > v.range[1]) {
      if (!ctx.opts.extrapolate) throw new MaterialRangeError(`${ctx.mat}.${ctx.prop}: ${v.name} = ${xv} ${v.unit} outside the fit range [${v.range[0]}, ${v.range[1]}] ${v.unit}`);
      ctx.extrapolated = true;
    }
    x[v.name] = xv;
  }
  return fm.evaluate(x, f.coeffs);
}

/** Evaluate a value form to SI (number), using the leaf unit. */
function evalForm(ctx: Ctx, l: { value?: number | 'N/A'; table?: Table; fit?: Fit }, unit: string, missing: string | undefined): number {
  const u = parseUnit(unit);
  if (l.value === 'N/A') throw new MaterialNAError(ctx.mat, ctx.prop, missing ?? 'N/A');
  if (typeof l.value === 'number') return toSI(l.value, u);
  if (l.table) return toSI(evalTable(ctx, l.table), u);
  if (l.fit) return toSI(evalFit(ctx, l.fit), u);
  throw new Error(`${ctx.mat}.${ctx.prop}: no value form`);
}

function evalComponent(ctx: Ctx, c: Component, unit: string, missing: string | undefined): number {
  if (c === 'N/A') throw new MaterialNAError(ctx.mat, ctx.prop, missing ?? 'tensor component N/A');
  if (typeof c === 'number') return toSI(c, parseUnit(unit));
  return evalForm(ctx, c, unit, missing);
}

export interface Library {
  ids(): string[];
  get(id: string): MaterialDoc | undefined;
  getProperty(materialId: string, prop: string, opts?: EvalOptions): PropertyValue;
  /** Properties stored as N/A (and N/A tensor components), with their `missing` text. */
  listNA(): Array<{ material: string; property: string; missing: string }>;
}

/** Strip a spec reference "materials/<id>" to the id. */
export const materialIdFromRef = (ref: string): string => ref.replace(/^materials\//, '');

export function createLibrary(docs: readonly MaterialDoc[]): Library {
  const byId = new Map<string, MaterialDoc>();
  for (const d of docs) {
    if (byId.has(d.id)) throw new Error(`duplicate material id '${d.id}'`);
    byId.set(d.id, d);
  }

  function citation(d: MaterialDoc, keys: string[]): string {
    return keys.map((k) => {
      const s = d.sources[k];
      if (!s) return k;
      return [s.citation, s.doi ? `doi:${s.doi}` : s.url].filter(Boolean).join(', ');
    }).join('; ');
  }

  function evalLeaf(d: MaterialDoc, prop: string, l: Leaf | AltLeaf, opts: EvalOptions, alt?: string): PropertyValue {
    const def = PROPERTY_BY_NAME.get(prop);
    if (!def) throw new Error(`unknown property '${prop}'`);
    const ctx: Ctx = { mat: d.id, prop, opts, extrapolated: false };
    const ref = parseUnit(def.unit);
    const toRef = (si: number): number => fromSI(si, ref);
    let value: number | Record<string, number>;
    let matrix: number[][] | undefined;
    let symmetry: Symmetry | undefined;
    if (l.tensor) {
      symmetry = l.tensor.symmetry as Symmetry;
      if (opts.component !== undefined) {
        const c = l.tensor.components[opts.component];
        if (c === undefined) throw new Error(`${d.id}.${prop}: no component '${opts.component}' (have ${Object.keys(l.tensor.components).join(', ')})`);
        value = toRef(evalComponent(ctx, c, l.unit, l.missing));
      } else {
        const comps: Record<string, number> = {};
        for (const [k, c] of Object.entries(l.tensor.components)) comps[k] = toRef(evalComponent(ctx, c, l.unit, l.missing));
        value = comps;
        matrix = tensorMatrix(symmetry, comps);
      }
    } else {
      if (opts.component !== undefined) throw new Error(`${d.id}.${prop} is a scalar; 'component' does not apply`);
      value = toRef(evalForm(ctx, l, l.unit, l.missing));
    }
    const keys = l.source === undefined ? [] : ([] as string[]).concat(l.source);
    const out: PropertyValue = {
      material: d.id, property: prop, value, unit: def.unit,
      source: citation(d, keys), sourceKeys: keys,
      basis: l.basis ?? 'N/A', locator: l.locator ?? 'N/A', accessed: l.accessed ?? 'N/A',
    };
    if (symmetry) out.symmetry = symmetry;
    if (matrix) out.matrix = matrix;
    if (l.conditions) out.conditions = l.conditions;
    if (l.uncertainty) out.uncertainty = l.uncertainty;
    if (alt) out.alternative = alt;
    if (l.derivation) out.derived = l.derivation;
    if (l.analog_of) out.analogOf = l.analog_of;
    if (l.cte_kind) out.cteKind = l.cte_kind;
    if (l.T_ref) out.T_ref = (parseQuantity(l.T_ref) as { si: number }).si;
    if (ctx.extrapolated) out.extrapolated = true;
    return out;
  }

  const lib: Library = {
    ids: () => [...byId.keys()].sort(),
    get: (id) => byId.get(materialIdFromRef(id)),
    getProperty(materialId, prop, opts = {}) {
      const id = materialIdFromRef(materialId);
      const d = byId.get(id);
      if (!d) throw new Error(`unknown material '${materialId}' (have ${[...byId.keys()].sort().join(', ')})`);
      const leaf = d.properties[prop];
      if (!leaf) {
        if (prop === 'sigma' && d.properties.rho_e && d.properties.rho_e.value !== 'N/A') {
          const r = lib.getProperty(id, 'rho_e', opts);
          const derived = `sigma = 1 / rho_e (package rule, DevLog-013); rho_e from ${r.locator}`;
          return { ...r, property: 'sigma', unit: 'S/m', value: 1 / (r.value as number), derived: r.derived ? `${derived}; ${r.derived}` : derived };
        }
        throw new Error(`${id} has no property '${prop}' (have ${Object.keys(d.properties).join(', ')})`);
      }
      if (opts.alternative !== undefined) {
        const a = leaf.alternatives.find((x) => x.id === opts.alternative);
        if (!a) throw new Error(`${id}.${prop}: no alternative '${opts.alternative}' (have ${leaf.alternatives.map((x) => x.id).join(', ') || 'none'})`);
        return evalLeaf(d, prop, a, opts, a.id);
      }
      return evalLeaf(d, prop, leaf, opts);
    },
    listNA() {
      const out: Array<{ material: string; property: string; missing: string }> = [];
      for (const d of [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        for (const [p, l] of Object.entries(d.properties)) {
          if (l.value === 'N/A') out.push({ material: d.id, property: p, missing: l.missing ?? '' });
          else if (l.tensor) for (const [k, c] of Object.entries(l.tensor.components)) if (c === 'N/A' || (typeof c === 'object' && c.value === 'N/A')) out.push({ material: d.id, property: `${p}.${k}`, missing: l.missing ?? '' });
        }
      }
      return out;
    },
  };
  return lib;
}
