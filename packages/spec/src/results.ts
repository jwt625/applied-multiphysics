// SPDX-License-Identifier: GPL-3.0-or-later
// Results model of amp-spec/0 (DevLog-023 s.3.2, DevLog-025, CONTRACTS C10): a grouped `results` object that mirrors
// the model tree,
//   results: {datasets: [...], evaluations: [...], tables: [...], plots: [...]}
// with discriminated node types, cross-reference checks (references, acyclic dataset chains, dataset kind
// compatibility, vector lengths, selections), the result-expression vocabulary, and small pure helpers for readers
// (headline items, surface plots, units, node hashes for value artifacts). Values are never stored in the spec: they
// are artifacts keyed by (node hash, run id). Exports are not part of the schema (DevLog-023 s.5.1 Q2); the key
// `exports` is reserved for a later stage.
//
// The zod node schemas are built by buildResultsSchema(leaves), called from schema.ts with its leaf builders, so this
// module has no runtime import of schema.ts (no import cycle).

import * as z from 'zod';
import { compileExpression, parseExpression, referencedNames, EXPRESSION_FUNCTIONS } from '@amp/core/expr';
import { NODE_ID, parseEntityId, type EntityKind } from './ids.ts';
import { units, FIELD_SYMBOLS, type Dim, type ScopeValue } from './units.ts';
import { resolveQuantity, quantityRefs, type QuantityInput } from './quantity.ts';
import { canonicalJson, sha256Hex } from './canonical.ts';
import type { PathKey } from './registry.ts';

// ---- vocabulary -------------------------------------------------------------------------------------------------
export const RESULT_SECTIONS = ['datasets', 'evaluations', 'tables', 'plots'] as const;
export type ResultSection = (typeof RESULT_SECTIONS)[number];
export const DATASET_TYPES = ['solution', 'cutpoint', 'cutline', 'edge', 'cutplane', 'revolve', 'mirror', 'join'] as const;
export type DatasetType = (typeof DATASET_TYPES)[number];
export const EVAL_ITEM_TYPES = ['point', 'global', 'integral', 'average', 'max', 'min', 'measure'] as const;
export type EvalItemType = (typeof EVAL_ITEM_TYPES)[number];
export const PLOT_GROUP_TYPES = ['plot1d', 'plot2d', 'plot3d'] as const;
export type PlotGroupType = (typeof PLOT_GROUP_TYPES)[number];
export const PLOT_ITEM_TYPES = {
  plot1d: ['linegraph', 'pointgraph', 'global', 'tablegraph'],
  plot2d: ['surface', 'contour', 'arrow', 'streamline', 'line', 'maxmin', 'point', 'mesh', 'deformation', 'height'],
  plot3d: ['surface', 'slice', 'isosurface', 'volume', 'arrow', 'streamline', 'line', 'maxmin', 'mesh', 'deformation'],
} as const;
/** Plot items that modify the whole group (COMSOL plot attributes) rather than draw a layer of their own. */
export const ATTRIBUTE_ITEMS: ReadonlySet<string> = new Set(['deformation', 'height']);
/** How a max / min is found (honesty rule: each max / min states its method; DevLog-023 s.3.1, DevLog-026). */
export const MAXMIN_METHODS = ['nodal', 'quad', 'points', 'lattice'] as const;
export const STEP_KEYWORDS = ['all', 'first', 'last'] as const;
export const COLORMAP_CHOICES = ['auto', 'viridis', 'cividis', 'inferno', 'balance'] as const;
export const RANGE_RULES = ['full', 'p1-99', 'manual'] as const;
/** Functions of result expressions: the @amp/core/expr list plus d(f, v), the per-element derivative of f along v. */
export const RESULT_FUNCTIONS: readonly string[] = [...EXPRESSION_FUNCTIONS, 'd'];

// ---- schema -----------------------------------------------------------------------------------------------------
type Bounds = { gt?: number; ge?: number; lt?: number; le?: number };
/** Leaf builders of schema.ts (passed in; see the header). */
export interface ResultLeaves {
  nodeId: z.ZodType<string>;
  label: z.ZodOptional<z.ZodString>;
  unitString: z.ZodType<string>;
  quantity: (dim?: string, bounds?: Bounds) => z.ZodType<QuantityInput>;
  vector: (dim: string, n?: number, bounds?: Bounds) => z.ZodType<QuantityInput[] | { value: number[]; unit: string }>;
  selection: (kinds?: readonly EntityKind[]) => z.ZodType<string[]>;
}

const ID_MSG = { message: 'id: a letter or underscore, then letters, digits, _ or - (at most 64)' };
type RefKind = 'study' | 'dataset' | 'evaluation' | 'table' | 'item';
const refCache = new Map<RefKind, z.ZodString>();
/** Reference to another node by id; `x-amp-ref` names the section the id must be in (form pickers, agents). One $defs entry per kind. */
const ref = (to: RefKind): z.ZodString => {
  let r = refCache.get(to);
  if (!r) {
    r = z.string().regex(NODE_ID, ID_MSG).meta({ id: `Ref_${to}`, 'x-amp-ref': to, description: `id of ${to === 'item' ? 'an evaluation item' : to === 'evaluation' ? 'an evaluation group' : `a ${to}`}` });
    refCache.set(to, r);
  }
  return r;
};
let exprLeaf: z.ZodString | null = null;
/** Result expression (one $defs entry). */
const expr = (): z.ZodString => (exprLeaf ??= z.string().min(1).max(2000).meta({
  id: 'ResultExpr', 'x-amp-expression': 'results',
  description: `Result expression: <physics id>.<field or scalar>[.x|.y|.z|.r|.phi], params, x y z r (m; r z on axisymmetric models), t (s, time studies), functions ${RESULT_FUNCTIONS.join(' ')}`,
}));

export function buildResultsSchema(l: ResultLeaves) {
  const common = { id: l.nodeId, label: l.label, enabled: z.boolean().meta({ id: 'Enabled', description: 'false: the node and everything that reads it are not computed' }).optional() };
  const steps = z.union([
    z.enum(STEP_KEYWORDS),
    z.number().int().nonnegative(),
    z.array(z.number().int().nonnegative()).min(1),
    z.strictObject({ values: z.array(z.number()).min(1), unit: l.unitString }),
  ]).meta({ id: 'StepSelection', description: 'Steps (time, eigen, frequency or sweep points): all | first | last | index | [indices] | {values, unit} (nearest stored steps); absent = all steps of the source' });
  const dataRef = ref('dataset');
  const posInt = (max: number) => z.number().int().min(1).max(max);
  const scaleSchema = z.union([z.literal('auto'), z.number().positive()]).meta({ description: "'auto' or a positive factor" });
  const levels = z.union([z.strictObject({ count: posInt(200) }), z.strictObject({ values: z.array(l.quantity('*')).min(1) })]).meta({ id: 'Levels' });
  const range = z.strictObject({ rule: z.enum(RANGE_RULES), min: l.quantity('*').optional(), max: l.quantity('*').optional() })
    .superRefine((r, ctx) => {
      if (r.rule === 'manual' && (r.min === undefined || r.max === undefined)) ctx.addIssue({ code: 'custom', message: "range rule 'manual' needs min and max", path: [r.min === undefined ? 'min' : 'max'] });
      if (r.rule !== 'manual' && (r.min !== undefined || r.max !== undefined)) ctx.addIssue({ code: 'custom', message: `min / max are used only with rule 'manual' (rule '${r.rule}')`, path: [r.min !== undefined ? 'min' : 'max'] });
    }).meta({ id: 'ColorRange' });
  const disc = (kind: string, options: z.ZodType[], names: readonly string[]) => z.discriminatedUnion('type', options as never, {
    error: (iss: { code?: string; note?: string; input?: unknown }) => {
      if (iss.code === 'invalid_union' && iss.note === 'No matching discriminator') {
        const t = iss.input && typeof iss.input === 'object' ? (iss.input as { type?: unknown }).type : undefined;
        return `unknown ${kind} type ${t === undefined ? '(missing type)' : `'${String(t)}'`} (allowed: ${names.join(', ')})`;
      }
      return undefined;
    },
  } as never);
  const node = <T extends string>(id: string, type: T, shape: z.ZodRawShape, description: string) =>
    z.strictObject({ ...common, type: z.literal(type), ...shape }).meta({ id, description });

  // datasets
  const datasets: Record<DatasetType, z.ZodType> = {
    solution: node('Dataset_solution', 'solution', { data: ref('study'), steps: steps.optional() }, 'Solution of a study (the root of every dataset chain)'),
    cutpoint: node('Dataset_cutpoint', 'cutpoint', { data: dataRef, points: z.array(l.vector('m')).min(1) }, 'Points (coordinates in the source space)'),
    cutline: node('Dataset_cutline', 'cutline', { data: dataRef, from: l.vector('m'), to: l.vector('m'), n: z.number().int().min(2).max(100000).optional().meta({ description: 'uniform points; absent = the element-crossing points of the line (exact piecewise segments)' }) }, 'Straight cut line from -> to (2D or 3D source)'),
    edge: node('Dataset_edge', 'edge', { data: dataRef, select: l.selection(['bnd', 'edg']) }, 'Boundaries (2D) or edges (3D) as a line dataset ordered by arc length'),
    cutplane: node('Dataset_cutplane', 'cutplane', { data: dataRef, point: l.vector('m', 3), normal: l.vector('1', 3), offsets: z.array(l.quantity('m')).min(1).optional().meta({ description: 'extra parallel planes at these signed distances along the normal' }) }, 'Plane through point with normal (3D source; yields a 2D dataset)'),
    revolve: node('Dataset_revolve', 'revolve', { data: dataRef, start: l.quantity('rad').optional().meta({ description: 'start angle (absent = 0 rad)' }), sweep: l.quantity('rad', { gt: 0, le: 2 * Math.PI }), layers: posInt(1024) }, 'Revolution of an axisymmetric dataset about the z axis (yields a 3D dataset)'),
    mirror: node('Dataset_mirror', 'mirror', {
      data: dataRef,
      planes: z.array(z.strictObject({ point: l.vector('m').optional().meta({ description: 'a point on the plane (absent = the origin)' }), normal: l.vector('1') })).min(1).max(3),
      parity: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}\.[A-Za-z_][A-Za-z0-9_]{0,63}(\.(x|y|z|r|phi))?$/, { message: 'parity key: <physics id>.<field>[.<component>]' }), z.array(z.union([z.literal(1), z.literal(-1)])).min(1).max(3)).optional()
        .meta({ description: 'sign of a field (or component) in each mirrored copy, one entry per plane; fields not listed are even (+1)' }),
    }, 'Mirror copies across up to 3 planes (2D or 3D source)'),
    join: node('Dataset_join', 'join', { a: dataRef, b: dataRef, op: z.enum(['difference']) }, 'Combination of two datasets of the same shape (b evaluated at the points of a)'),
  };

  // evaluations
  const evalBase = { data: dataRef.optional(), steps: steps.optional() };
  const unitOpt = l.unitString.optional();
  const integralOver = l.selection(['dom', 'bnd', 'edg']).optional();
  const evalItems: Record<EvalItemType, z.ZodType> = {
    point: node('Eval_point', 'point', { ...evalBase, expr: expr(), unit: unitOpt }, 'Value at the points of a cutpoint dataset'),
    global: node('Eval_global', 'global', { ...evalBase, expr: expr(), unit: unitOpt }, 'Global value: module scalars (<physics>.<scalar>) and params'),
    integral: node('Eval_integral', 'integral', { ...evalBase, expr: expr(), unit: unitOpt, over: integralOver }, 'Integral over a selection (solution dataset) or over a line / plane dataset'),
    average: node('Eval_average', 'average', { ...evalBase, expr: expr(), unit: unitOpt, over: integralOver }, 'Integral divided by the measure'),
    max: node('Eval_max', 'max', { ...evalBase, expr: expr(), unit: unitOpt, over: l.selection().optional(), method: z.enum(MAXMIN_METHODS) }, 'Maximum, with its method'),
    min: node('Eval_min', 'min', { ...evalBase, expr: expr(), unit: unitOpt, over: l.selection().optional(), method: z.enum(MAXMIN_METHODS) }, 'Minimum, with its method'),
    measure: node('Eval_measure', 'measure', { ...evalBase, unit: unitOpt, over: integralOver }, 'Length, area or volume of a selection or dataset'),
  };
  const evalGroup = z.strictObject({
    ...common, data: dataRef.optional(), steps: steps.optional(),
    items: z.array(disc('evaluation', Object.values(evalItems), EVAL_ITEM_TYPES)),
  }).meta({ id: 'EvaluationGroup', description: 'Evaluation group: items evaluated on a dataset; its table lists one row per step' });

  const table = z.strictObject({ ...common, from: ref('evaluation'), orient: z.enum(['rows', 'columns']).optional().meta({ description: 'rows (default): one row per step or sweep point' }) })
    .meta({ id: 'Table', description: 'Table of an evaluation group (values computed in session memory, never stored in the spec)' });

  // plots
  const pBase = { data: dataRef.optional(), steps: steps.optional() };
  const surfaceLike = { ...pBase, expr: expr(), unit: unitOpt, range: range.optional(), colormap: z.enum(COLORMAP_CHOICES).optional(), log: z.boolean().optional() };
  const maxmin = (g: string) => node(`${g}_maxmin`, 'maxmin', { ...pBase, expr: expr(), unit: unitOpt, show: z.enum(['max', 'min', 'both']), method: z.enum(MAXMIN_METHODS) }, 'Max / min markers, with their method');
  const arrow = (g: string) => node(`${g}_arrow`, 'arrow', { ...pBase, expr: expr(), unit: unitOpt }, 'Arrows of a vector field');
  const streamline = (g: string) => node(`${g}_streamline`, 'streamline', { ...pBase, expr: expr(), unit: unitOpt, count: posInt(1000).optional() }, 'Streamlines of a vector field');
  const mesh = (g: string) => node(`${g}_mesh`, 'mesh', { ...pBase }, 'Mesh of the dataset');
  const deformation = (g: string) => node(`${g}_deformation`, 'deformation', { ...pBase, expr: expr(), scale: scaleSchema }, 'Attribute: deform the group by a displacement');
  const plotItems: { [G in PlotGroupType]: Record<(typeof PLOT_ITEM_TYPES)[G][number], z.ZodType> } = {
    plot1d: {
      linegraph: node('Plot1d_linegraph', 'linegraph', { ...pBase, x: z.union([z.literal('arc'), expr()]).meta({ description: "abscissa: 'arc' (arc length along the line, m) or an expression" }), expr: expr(), unit: unitOpt, xunit: unitOpt }, 'Expression along a line dataset'),
      pointgraph: node('Plot1d_pointgraph', 'pointgraph', { ...pBase, expr: expr(), unit: unitOpt }, 'Expression at cut points versus steps'),
      global: node('Plot1d_global', 'global', { ...pBase, expr: expr(), unit: unitOpt }, 'Global value versus steps'),
      tablegraph: node('Plot1d_tablegraph', 'tablegraph', { table: ref('table'), columns: z.array(ref('item')).min(1).optional().meta({ description: 'evaluation items of the table to draw (absent = all)' }) }, 'Columns of a table versus its rows'),
    },
    plot2d: {
      surface: node('Plot2d_surface', 'surface', surfaceLike, 'Colour map of an expression'),
      contour: node('Plot2d_contour', 'contour', { ...pBase, expr: expr(), unit: unitOpt, levels: levels.optional(), color: z.enum(['uniform', 'colormap']).optional() }, 'Contour lines'),
      arrow: arrow('Plot2d'), streamline: streamline('Plot2d'),
      line: node('Plot2d_line', 'line', { ...pBase, expr: expr(), unit: unitOpt, select: l.selection(['bnd']).optional().meta({ description: 'boundaries (absent = all)' }) }, 'Expression on boundaries'),
      maxmin: maxmin('Plot2d'),
      point: node('Plot2d_point', 'point', { data: dataRef, steps: steps.optional(), expr: expr().optional(), unit: unitOpt }, 'Markers at the points of a cutpoint dataset'),
      mesh: mesh('Plot2d'), deformation: deformation('Plot2d'),
      height: node('Plot2d_height', 'height', { ...pBase, expr: expr(), unit: unitOpt, scale: scaleSchema }, 'Attribute: height (warp by scalar)'),
    },
    plot3d: {
      surface: node('Plot3d_surface', 'surface', surfaceLike, 'Colour map on the boundary surfaces'),
      slice: node('Plot3d_slice', 'slice', { ...surfaceLike, normal: z.union([z.enum(['x', 'y', 'z']), l.vector('1', 3)]), at: z.array(l.quantity('m')).min(1).meta({ description: 'plane positions along the normal' }) }, 'Slices'),
      isosurface: node('Plot3d_isosurface', 'isosurface', { ...pBase, expr: expr(), unit: unitOpt, levels, colormap: z.enum(COLORMAP_CHOICES).optional() }, 'Isosurfaces'),
      volume: node('Plot3d_volume', 'volume', { ...pBase, expr: expr(), unit: unitOpt, range: range.optional(), colormap: z.enum(COLORMAP_CHOICES).optional() }, 'Volume colour'),
      arrow: arrow('Plot3d'), streamline: streamline('Plot3d'),
      line: node('Plot3d_line', 'line', { ...pBase, expr: expr(), unit: unitOpt, select: l.selection(['edg']).optional().meta({ description: 'edges (absent = all)' }) }, 'Expression on edges'),
      maxmin: maxmin('Plot3d'), mesh: mesh('Plot3d'), deformation: deformation('Plot3d'),
    },
  };
  const groupOf = (g: PlotGroupType, dataRequired: boolean) => z.strictObject({
    ...common, type: z.literal(g),
    data: dataRequired ? dataRef : dataRef.optional(),
    steps: steps.optional(),
    items: z.array(disc(`${g} item`, Object.values(plotItems[g]), PLOT_ITEM_TYPES[g])),
  }).meta({ id: `PlotGroup_${g}`, description: `${g.slice(4)} plot group` });
  const plotGroup = disc('plot group', [groupOf('plot1d', false), groupOf('plot2d', true), groupOf('plot3d', true)], PLOT_GROUP_TYPES);

  return z.strictObject({
    datasets: z.array(disc('dataset', Object.values(datasets), DATASET_TYPES)).optional(),
    evaluations: z.array(evalGroup).optional(),
    tables: z.array(table).optional(),
    plots: z.array(plotGroup).optional(),
  }).meta({ id: 'Results', description: 'Results (DevLog-023, CONTRACTS C10): datasets, evaluation groups, tables, plot groups. Exports are not supported yet (key reserved).' });
}

// ---- static types (plain data; the zod schema is the authority) -------------------------------------------------
export type StepSelection = (typeof STEP_KEYWORDS)[number] | number | number[] | { values: number[]; unit: string };
interface NodeBase { id: string; type: string; label?: string; enabled?: boolean }
export interface DatasetNode extends NodeBase {
  type: DatasetType; data?: string; steps?: StepSelection; points?: unknown[]; from?: unknown; to?: unknown; n?: number;
  select?: string[]; point?: unknown; normal?: unknown; offsets?: unknown[]; start?: unknown; sweep?: unknown; layers?: number;
  planes?: Array<{ point?: unknown; normal: unknown }>; parity?: Record<string, Array<1 | -1>>; a?: string; b?: string; op?: 'difference';
}
export interface EvalItem extends NodeBase { type: EvalItemType; data?: string; steps?: StepSelection; expr?: string; unit?: string; over?: string[]; method?: (typeof MAXMIN_METHODS)[number] }
export interface EvalGroup { id: string; label?: string; enabled?: boolean; data?: string; steps?: StepSelection; items: EvalItem[] }
export interface TableNode { id: string; label?: string; enabled?: boolean; from: string; orient?: 'rows' | 'columns' }
export interface PlotItem extends NodeBase { data?: string; steps?: StepSelection; expr?: string; unit?: string; x?: string; table?: string; columns?: string[]; select?: string[]; [k: string]: unknown }
export interface PlotGroup { id: string; type: PlotGroupType; label?: string; enabled?: boolean; data?: string; steps?: StepSelection; items: PlotItem[] }
export interface ResultsBlock { datasets?: DatasetNode[]; evaluations?: EvalGroup[]; tables?: TableNode[]; plots?: PlotGroup[] }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x.filter(isObj) as unknown as T[]) : []);
/** The results block of spec data as a typed view (empty sections when absent or malformed; never throws). */
export function resultsOf(data: unknown): Required<ResultsBlock> {
  const r = isObj(data) && isObj(data.results) ? data.results : {};
  return { datasets: list(r.datasets), evaluations: list(r.evaluations), tables: list(r.tables), plots: list(r.plots) };
}

// ---- expressions ------------------------------------------------------------------------------------------------
/** Dimension of `<physics type>.<name>` (fields and module scalars), or null when unknown. Injected (field units are not in the registry yet). */
export type ResultDimResolver = (physicsType: string, name: string) => Dim | null;

export interface ExprEnv {
  /** params (and pi) with SI values. */
  scope: ReadonlyMap<string, ScopeValue>;
  /** params that failed to resolve: expressions referencing them are not checked further. */
  failed: ReadonlySet<string>;
  /** space and time symbols allowed here (name -> dimension). */
  symbols: ReadonlyMap<string, Dim>;
  /** physics ids solved by the root study -> physics type. */
  physics: ReadonlyMap<string, string>;
  /** all physics ids of the spec (for a better message). */
  allPhysics: ReadonlySet<string>;
  axisym: boolean;
  resultDims?: ResultDimResolver | null;
}

/** Rewrite d(f, v) as ((f)/(v)) for syntax and dimension checks (the derivative has the dimension of f / v). */
export function rewriteDerivatives(src: string, symbols: ReadonlyMap<string, Dim>): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const m = /\bd\s*\(/y;
    m.lastIndex = i;
    const prev = i > 0 ? src[i - 1]! : '';
    if (!/[A-Za-z0-9_.]/.test(prev) && m.test(src)) {
      let depth = 1, j = m.lastIndex, comma = -1;
      for (; j < src.length && depth > 0; j++) {
        const c = src[j];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 1) { if (comma >= 0) throw new Error(`expression "${src}": d() takes 2 arguments (field, coordinate)`); comma = j; }
      }
      if (depth !== 0) throw new Error(`expression "${src}": unbalanced parentheses in d()`);
      if (comma < 0) throw new Error(`expression "${src}": d() takes 2 arguments (field, coordinate)`);
      const f = src.slice(m.lastIndex, comma), v = src.slice(comma + 1, j - 1).trim();
      if (!f.trim()) throw new Error(`expression "${src}": d() needs a field as its first argument`);
      if (!/^[A-Za-z_]\w*$/.test(v) || !symbols.has(v) || v === 't') throw new Error(`expression "${src}": d(f, v) needs a space coordinate v (here: ${[...symbols.keys()].filter((s) => s !== 't').join(', ') || 'none'}), got '${v}'`);
      out += `((${rewriteDerivatives(f, symbols)})/(${v}))`;
      i = j;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

/** Issues of one result expression; `unit` is checked when the expression's dimension is known. */
export function checkResultExpression(src: string, env: ExprEnv, unit?: string, compareUnit = true): string[] {
  let rewritten = src;
  let names: string[];
  // messages quote the source as written (positions refer to the d() rewrite, so they are dropped then)
  const own = (m: string) => (rewritten === src ? m : m.split(`expression "${rewritten}"`).join(`expression "${src}"`).replace(/ at position \d+$/, ''));
  try {
    rewritten = rewriteDerivatives(src, env.symbols);
    names = referencedNames(parseExpression(rewritten));
  } catch (e) { return [own((e as Error).message)]; }
  const out: string[] = [];
  let fieldRefs = 0, unknownDim = false, failedRef = false;
  const dims = new Map<string, Dim>();
  for (const n of names) {
    if (env.failed.has(n)) { failedRef = true; continue; } // that param's own issue is reported; no unit check
    if (env.scope.has(n)) continue;
    if (env.symbols.has(n)) continue;
    if (FIELD_SYMBOLS.has(n)) { out.push(`'${n}' is not available on this dataset (allowed: ${[...env.symbols.keys()].join(', ') || 'none'})`); continue; }
    const parts = n.split('.');
    if (parts.length === 1) { out.push(`unknown name '${n}' (params, ${[...env.symbols.keys()].join(', ') || 'no coordinates'}, or <physics id>.<name>)`); continue; }
    const [pid, name, comp, ...rest] = parts as [string, string, string | undefined, ...string[]];
    const type = env.physics.get(pid);
    if (type === undefined) {
      out.push(env.allPhysics.has(pid) ? `'${n}': physics '${pid}' is not solved by the study of this dataset (solved: ${[...env.physics.keys()].join(', ') || 'none'})` : `'${n}': no physics '${pid}' (names are <physics id>.<name>)`);
      continue;
    }
    const comps = env.axisym ? ['r', 'phi', 'z'] : ['x', 'y', 'z'];
    if (rest.length || (comp !== undefined && !comps.includes(comp))) { out.push(`'${n}': component must be one of .${comps.join(' .')}`); continue; }
    fieldRefs++;
    const d = env.resultDims ? env.resultDims(type, name) : null;
    if (env.resultDims && !d) { out.push(`'${n}': physics type '${type}' has no result '${name}'`); continue; }
    if (d) dims.set(n, d); else unknownDim = true;
  }
  if (out.length || failedRef || !unit || !compareUnit) return out;
  if (fieldRefs && unknownDim) return out; // dimension known only to the evaluator (R1)
  let c;
  try {
    c = compileExpression(rewritten, {
      resolve: (name: string) => {
        const p = env.scope.get(name);
        if (p) return { kind: 'const', re: p.si, dim: p.dim };
        const s = env.symbols.get(name) ?? dims.get(name);
        return s ? { kind: 'field', key: name, dim: s, complex: false, continuous: true } : null;
      },
    });
  } catch (e) { return [own((e as Error).message)]; }
  let u;
  try { u = units.parseUnit(unit); } catch { return out; } // the unit's own issue is reported by the schema
  if (!units.dimEq(c.dim, u.dim)) out.push(`expression has unit ${units.formatUnit(c.dim)}, but unit '${unit}' is ${units.formatUnit(u.dim)}`);
  return out;
}

// ---- cross-reference checks -------------------------------------------------------------------------------------
export interface RawIssue { path: PathKey[]; code: string; message: string }

/** Output shape of a dataset: its dimension, the dimension of its coordinates, and what it carries. */
export interface DatasetShape {
  type: DatasetType;
  /** 0 points, 1 lines, 2 surfaces, 3 volumes. */
  dim: 0 | 1 | 2 | 3;
  /** number of coordinates of its points. */
  embed: 1 | 2 | 3;
  axisym: boolean;
  /** carries the geometry entity table (selections resolve on it): solution datasets and joins of them. */
  entities: boolean;
  /** study at the root of the chain. */
  study: string;
}

interface StudyInfo { id: string; type: string; physics: string[]; inner: string | null }

export interface ResultsCheckEnv {
  spec: { geometry: { dim: 1 | 2 | 3; axisym?: boolean }; physics?: Array<{ id: string; type: string }>; studies?: Array<{ id: string; type: string; physics: string[]; settings?: Record<string, unknown> }> };
  scope: ReadonlyMap<string, ScopeValue>;
  failed: ReadonlySet<string>;
  addId(id: string, path: PathKey[]): void;
  checkSel(sel: readonly string[] | undefined, path: PathKey[]): void;
  resultDims?: ResultDimResolver | null;
}

const vecLen = (v: unknown): number | null => (Array.isArray(v) ? v.length : isObj(v) && Array.isArray(v.value) ? v.value.length : null);
const vecSi = (v: unknown, scope: ReadonlyMap<string, ScopeValue>): number[] | null => {
  try {
    if (Array.isArray(v)) {
      const out: number[] = [];
      for (const q of v) { const r = resolveQuantity(q as QuantityInput, scope); if (r.na) return null; out.push(r.si); }
      return out;
    }
    if (isObj(v) && Array.isArray(v.value)) { const u = units.parseUnit(String(v.unit)); return (v.value as number[]).map((x) => x * u.factor); }
  } catch { /* reported by the schema */ }
  return null;
};
const refsFailed = (v: unknown, failed: ReadonlySet<string>): boolean => {
  if (!failed.size) return false;
  const items = Array.isArray(v) ? v : [v];
  return items.some((q) => quantityRefs(q).some((n) => failed.has(n)));
};

/** Space symbols of expressions on a dataset (t is added for time studies). */
export function symbolsFor(shape: { embed: number; axisym: boolean; type?: string }): Map<string, Dim> {
  const names = shape.axisym ? ['r', 'z'] : shape.embed === 1 ? ['x'] : shape.embed === 2 ? ['x', 'y', 'r'] : ['x', 'y', 'z', 'r'];
  return new Map(names.map((n) => [n, FIELD_SYMBOLS.get(n) as Dim]));
}

/** Cross-reference checks of the results block (validate.ts calls this after the schema passed). */
export function checkResults(results: ResultsBlock, env: ResultsCheckEnv): RawIssue[] {
  const out: RawIssue[] = [];
  const push = (path: PathKey[], code: string, message: string) => out.push({ path, code, message });
  const R: PathKey[] = ['results'];
  const studies = new Map<string, StudyInfo>((env.spec.studies ?? []).map((s) => [s.id, { id: s.id, type: s.type, physics: s.physics ?? [], inner: s.type === 'parametric' && typeof s.settings?.study === 'string' ? s.settings.study : null }]));
  const physicsType = new Map((env.spec.physics ?? []).map((p) => [p.id, p.type]));
  const allPhysics = new Set(physicsType.keys());
  const g = env.spec.geometry;
  const sections = resultsOf({ results });

  // ids (one namespace with the rest of the spec), in section order
  sections.datasets.forEach((d, i) => env.addId(d.id, [...R, 'datasets', i]));
  sections.evaluations.forEach((e, i) => { env.addId(e.id, [...R, 'evaluations', i]); e.items.forEach((it, j) => env.addId(it.id, [...R, 'evaluations', i, 'items', j])); });
  sections.tables.forEach((t, i) => env.addId(t.id, [...R, 'tables', i]));
  sections.plots.forEach((p, i) => { env.addId(p.id, [...R, 'plots', i]); p.items.forEach((it, j) => env.addId(it.id, [...R, 'plots', i, 'items', j])); });

  // datasets: shapes along the chains (acyclic)
  const dsIndex = new Map(sections.datasets.map((d, i) => [d.id, i]));
  const shapes = new Map<string, DatasetShape | null>();
  const visiting = new Set<string>();
  const shapeOf = (id: string): DatasetShape | null => {
    if (shapes.has(id)) return shapes.get(id)!;
    const i = dsIndex.get(id);
    if (i === undefined) return null;
    if (visiting.has(id)) { push([...R, 'datasets', i], 'dataset_cycle', `dataset chain through '${id}' is cyclic`); shapes.set(id, null); return null; }
    visiting.add(id);
    const s = computeShape(sections.datasets[i]!, i);
    visiting.delete(id);
    shapes.set(id, s);
    return s;
  };
  const srcOf = (d: DatasetNode, i: number, key: 'data' | 'a' | 'b' = 'data'): DatasetShape | null => {
    const id = d[key] as string;
    if (!dsIndex.has(id)) { push([...R, 'datasets', i, key], 'unknown_dataset', studies.has(id) ? `'${id}' is a study: only a solution dataset reads a study; name a dataset here` : `no dataset '${id}'`); return null; }
    return shapeOf(id);
  };
  const need = (ok: boolean, path: PathKey[], message: string): boolean => { if (!ok) push(path, 'dataset_kind', message); return ok; };
  function computeShape(d: DatasetNode, i: number): DatasetShape | null {
    const P: PathKey[] = [...R, 'datasets', i];
    if (d.type === 'solution') {
      const st = studies.get(d.data as string);
      if (!st) { push([...P, 'data'], 'unknown_study', `no study '${d.data}'`); return null; }
      return { type: 'solution', dim: g.dim, embed: g.dim, axisym: !!g.axisym, entities: true, study: st.id };
    }
    if (d.type === 'join') {
      const a = srcOf(d, i, 'a'), b = srcOf(d, i, 'b');
      if (!a || !b) return null;
      if (!need(a.dim === b.dim && a.embed === b.embed && a.axisym === b.axisym, [...P, 'b'], `join needs datasets of the same shape ('${d.a}' is ${desc(a)}, '${d.b}' is ${desc(b)})`)) return null;
      return { ...a, type: 'join', entities: a.entities && b.entities };
    }
    const s = srcOf(d, i);
    if (!s) return null;
    const domainLike = s.dim === s.embed && s.dim >= 1;
    const at = [...P, 'data'];
    switch (d.type) {
      case 'cutpoint':
        if (!need(domainLike || s.type === 'cutplane', at, `a cutpoint needs a domain or cut-plane dataset ('${d.data}' is ${desc(s)})`)) return null;
        (d.points ?? []).forEach((p, k) => { const n = vecLen(p); if (n !== null && n !== s.embed) push([...P, 'points', k], 'vector_length', `point has ${n} coordinates, dataset '${d.data}' has ${s.embed}`); });
        return { ...s, type: 'cutpoint', dim: 0, entities: false };
      case 'cutline': {
        if (!need((domainLike && s.dim >= 2) || s.type === 'cutplane', at, `a cutline needs a 2D / 3D domain or cut-plane dataset ('${d.data}' is ${desc(s)})`)) return null;
        for (const k of ['from', 'to'] as const) { const n = vecLen(d[k]); if (n !== null && n !== s.embed) push([...P, k], 'vector_length', `'${k}' has ${n} coordinates, dataset '${d.data}' has ${s.embed}`); }
        const a = refsFailed(d.from, env.failed) ? null : vecSi(d.from, env.scope), b = refsFailed(d.to, env.failed) ? null : vecSi(d.to, env.scope);
        if (a && b && a.length === b.length && a.every((x, k) => x === b[k])) push([...P, 'to'], 'degenerate', 'cut line has zero length (from = to)');
        return { ...s, type: 'cutline', dim: 1, entities: false };
      }
      case 'edge':
        if (!need(s.entities && s.dim >= 2, at, `an edge dataset needs a solution dataset with geometry entities ('${d.data}' is ${desc(s)})`)) return null;
        env.checkSel(d.select, [...P, 'select']);
        (d.select ?? []).forEach((id, k) => {
          const kind = parseEntityId(id)?.kind, want = s.dim === 2 ? 'bnd' : 'edg';
          if (kind && kind !== want) push([...P, 'select', k], 'entity_kind', `an edge dataset of a ${s.dim}D model selects '${want}:' entities (curves), got '${id}'`);
        });
        return { ...s, type: 'edge', dim: 1, entities: false };
      case 'cutplane': {
        if (!need(domainLike && s.dim === 3, at, `a cutplane needs a 3D dataset ('${d.data}' is ${desc(s)})`)) return null;
        const nv = refsFailed(d.normal, env.failed) ? null : vecSi(d.normal, env.scope);
        if (nv && nv.every((x) => x === 0)) push([...P, 'normal'], 'degenerate', 'normal is the zero vector');
        return { ...s, type: 'cutplane', dim: 2, entities: false };
      }
      case 'revolve':
        if (!need(domainLike && s.axisym, at, `revolve needs an axisymmetric dataset ('${d.data}' is ${desc(s)})`)) return null;
        return { ...s, type: 'revolve', dim: 3, embed: 3, axisym: false, entities: false };
      case 'mirror': {
        if (!need(s.dim >= 2, at, `mirror needs a 2D or 3D dataset ('${d.data}' is ${desc(s)})`)) return null;
        const np = d.planes?.length ?? 0;
        d.planes?.forEach((pl, k) => {
          const n = vecLen(pl.normal);
          if (n !== null && n !== s.embed) push([...P, 'planes', k, 'normal'], 'vector_length', `normal has ${n} components, dataset '${d.data}' has ${s.embed}`);
          const pn = vecLen(pl.point);
          if (pn !== null && pn !== s.embed) push([...P, 'planes', k, 'point'], 'vector_length', `point has ${pn} coordinates, dataset '${d.data}' has ${s.embed}`);
          const nv = refsFailed(pl.normal, env.failed) ? null : vecSi(pl.normal, env.scope);
          if (nv && nv.every((x) => x === 0)) push([...P, 'planes', k, 'normal'], 'degenerate', 'normal is the zero vector');
        });
        const root = studies.get(s.study);
        for (const [key, signs] of Object.entries(d.parity ?? {})) {
          if (signs.length !== np) push([...P, 'parity', key], 'vector_length', `parity has ${signs.length} entries, there are ${np} planes`);
          const [pid, , comp] = key.split('.') as [string, string, string | undefined];
          const comps = s.axisym ? ['r', 'phi', 'z'] : ['x', 'y', 'z'];
          if (comp !== undefined && !comps.includes(comp)) push([...P, 'parity', key], 'expression', `parity '${key}': component must be one of .${comps.join(' .')}`);
          if (!allPhysics.has(pid)) push([...P, 'parity', key], 'unknown_physics', `no physics '${pid}'`);
          else if (root && !physicsOfStudy(root).has(pid)) push([...P, 'parity', key], 'unknown_physics', `physics '${pid}' is not solved by study '${root.id}'`);
        }
        return { ...s, type: 'mirror', entities: false };
      }
    }
    return null;
  }
  function physicsOfStudy(st: StudyInfo): Map<string, string> {
    return new Map(st.physics.filter((p) => physicsType.has(p)).map((p) => [p, physicsType.get(p)!]));
  }
  const timeOf = (st: StudyInfo | undefined): boolean => !!st && (st.type === 'time' || (st.inner !== null && studies.get(st.inner)?.type === 'time'));
  sections.datasets.forEach((d) => shapeOf(d.id));

  // steps {values, unit}: the unit fits the step kind of the study
  const checkSteps = (st: StepSelection | undefined, path: PathKey[], study: string | undefined) => {
    if (!isObj(st) || !study) return;
    const s = studies.get(study);
    const kind = s && (s.type === 'parametric' ? 'param' : s.type);
    let u;
    try { u = units.parseUnit((st as { unit: string }).unit); } catch { return; }
    const want = kind === 'time' ? 's' : kind === 'frequency' ? 'Hz' : null;
    if (want && !units.dimEq(u.dim, units.parseUnit(want).dim)) push([...path, 'unit'], 'step_unit', `steps of ${kind} study '${study}' are in ${want}, unit '${(st as { unit: string }).unit}' is ${units.formatUnit(u.dim)}`);
  };
  sections.datasets.forEach((d, i) => { if (d.type === 'solution') checkSteps(d.steps, [...R, 'datasets', i, 'steps'], d.data); });

  // expressions
  const exprEnv = (shape: DatasetShape, global = false): ExprEnv => {
    const st = studies.get(shape.study);
    const symbols = global ? new Map<string, Dim>() : symbolsFor(shape);
    if (timeOf(st)) symbols.set('t', FIELD_SYMBOLS.get('t') as Dim);
    // a study that lists an unknown physics is reported at the study; its expressions accept any physics of the spec
    const lenient = !st || st.physics.some((p) => !physicsType.has(p));
    return { scope: env.scope, failed: env.failed, symbols, physics: lenient ? physicsType : physicsOfStudy(st), allPhysics, axisym: shape.axisym, resultDims: env.resultDims ?? null };
  };
  const checkExpr = (src: unknown, unit: unknown, shape: DatasetShape, path: PathKey[], opts: { global?: boolean; compareUnit?: boolean } = {}) => {
    if (typeof src !== 'string') return;
    for (const m of checkResultExpression(src, exprEnv(shape, opts.global), typeof unit === 'string' ? unit : undefined, opts.compareUnit ?? true)) push(path, 'expression', m);
  };
  /** Shape of the dataset an item reads (own data or the group's); reports a missing or unknown dataset. */
  const dataShape = (own: string | undefined, group: string | undefined, path: PathKey[]): DatasetShape | null => {
    const id = own ?? group;
    if (id === undefined) { push([...path, 'data'], 'missing_dataset', 'no dataset: set data on the item or on its group'); return null; }
    if (!dsIndex.has(id)) {
      // an unknown group dataset is reported once, at the group
      if (own !== undefined) push([...path, 'data'], 'unknown_dataset', studies.has(id) ? `'${id}' is a study: name a dataset (e.g. a solution dataset of '${id}')` : `no dataset '${id}'`);
      return null;
    }
    return shapes.get(id) ?? null;
  };
  const groupData = (id: string | undefined, path: PathKey[]): void => {
    if (id !== undefined && !dsIndex.has(id)) push([...path, 'data'], 'unknown_dataset', studies.has(id) ? `'${id}' is a study: name a dataset (e.g. a solution dataset of '${id}')` : `no dataset '${id}'`);
  };

  // evaluation groups
  const evalIndex = new Map(sections.evaluations.map((e, i) => [e.id, i]));
  sections.evaluations.forEach((e, i) => {
    const GP: PathKey[] = [...R, 'evaluations', i];
    groupData(e.data, GP);
    if (e.data && shapes.get(e.data)) checkSteps(e.steps, [...GP, 'steps'], shapes.get(e.data)!.study);
    e.items.forEach((it, j) => {
      const P: PathKey[] = [...GP, 'items', j];
      const s = dataShape(it.data, e.data, P);
      if (it.over) env.checkSel(it.over, [...P, 'over']);
      if (!s) return;
      checkSteps(it.steps, [...P, 'steps'], s.study);
      const dpath: PathKey[] = [...P, it.data !== undefined ? 'data' : 'type'];
      const dsName = it.data ?? e.data;
      switch (it.type) {
        case 'point':
          need(s.type === 'cutpoint', dpath, `a point evaluation needs a cutpoint dataset ('${dsName}' is ${desc(s)})`);
          checkExpr(it.expr, it.unit, s, [...P, 'expr']);
          break;
        case 'global':
          checkExpr(it.expr, it.unit, s, [...P, 'expr'], { global: true });
          break;
        default: {
          const minDim = it.type === 'max' || it.type === 'min' ? 0 : 1;
          if (s.entities) need(!!it.over, [...P, 'over'], `'${it.type}' on solution dataset '${dsName}' needs 'over' (explicit selection)`);
          else {
            if (it.over) push([...P, 'over'], 'dataset_kind', `'over' needs a dataset with geometry entities ('${dsName}' is ${desc(s)}); the item covers the whole dataset`);
            need(s.dim >= minDim, dpath, `'${it.type}' needs a line, surface or volume dataset ('${dsName}' is ${desc(s)})`);
          }
          if (it.type !== 'measure') checkExpr(it.expr, it.unit, s, [...P, 'expr'], { compareUnit: it.type !== 'integral' });
        }
      }
    });
  });

  // tables
  const tableIndex = new Map(sections.tables.map((t, i) => [t.id, i]));
  sections.tables.forEach((t, i) => {
    if (!evalIndex.has(t.from)) push([...R, 'tables', i, 'from'], 'unknown_evaluation', `no evaluation group '${t.from}'`);
  });

  // plot groups
  sections.plots.forEach((p, i) => {
    const GP: PathKey[] = [...R, 'plots', i];
    groupData(p.data, GP);
    const gs = p.data !== undefined ? shapes.get(p.data) ?? null : null;
    if (gs) checkSteps(p.steps, [...GP, 'steps'], gs.study);
    let groupOk = true;
    if (gs && p.type === 'plot2d') groupOk = need(gs.dim === 2, [...GP, 'data'], `a 2D plot group needs a 2D dataset ('${p.data}' is ${desc(gs)})`);
    if (gs && p.type === 'plot3d') groupOk = need(gs.dim === 3, [...GP, 'data'], `a 3D plot group needs a 3D dataset ('${p.data}' is ${desc(gs)})`);
    p.items.forEach((it, j) => {
      const P: PathKey[] = [...GP, 'items', j];
      if (it.type === 'tablegraph') {
        const ti = tableIndex.get(it.table as string);
        if (ti === undefined) { push([...P, 'table'], 'unknown_table', `no table '${it.table}'`); return; }
        const ev = sections.evaluations[evalIndex.get(sections.tables[ti]!.from) ?? -1];
        if (ev && it.columns) it.columns.forEach((c, k) => { if (!ev.items.some((x) => x.id === c)) push([...P, 'columns', k], 'unknown_item', `table '${it.table}' (evaluation group '${ev.id}') has no item '${c}'`); });
        return;
      }
      if (it.select) env.checkSel(it.select, [...P, 'select']);
      const s = dataShape(it.data, p.data, P);
      if (!s) return;
      checkSteps(it.steps, [...P, 'steps'], s.study);
      const dsName = it.data ?? p.data;
      const dpath: PathKey[] = [...P, it.data !== undefined ? 'data' : 'type'];
      const t = it.type as string;
      if (it.data === undefined && !groupOk) return; // reported once, at the group
      if (p.type === 'plot1d') {
        if (t === 'linegraph') {
          need(s.dim === 1, dpath, `a line graph needs a line dataset (cutline, edge; '${dsName}' is ${desc(s)})`);
          if (it.x !== 'arc') checkExpr(it.x, it.xunit, s, [...P, 'x']);
        } else if (t === 'pointgraph') need(s.type === 'cutpoint', dpath, `a point graph needs a cutpoint dataset ('${dsName}' is ${desc(s)})`);
        checkExpr(it.expr, it.unit, s, [...P, 'expr'], { global: t === 'global' });
        return;
      }
      const want = p.type === 'plot2d' ? 2 : 3;
      if (t === 'point') need(s.type === 'cutpoint' && s.embed === (gs?.embed ?? s.embed), dpath, `a point plot needs a cutpoint dataset in the group's space ('${dsName}' is ${desc(s)})`);
      else if (t === 'line') need(s.entities && s.dim === want, dpath, `a line plot needs a ${want}D solution dataset with geometry entities ('${dsName}' is ${desc(s)})`);
      else need(s.dim === want, dpath, `a ${want}D plot item needs a ${want}D dataset ('${dsName}' is ${desc(s)})`);
      if (t === 'slice') {
        const nv = Array.isArray(it.normal) || isObj(it.normal) ? (refsFailed(it.normal, env.failed) ? null : vecSi(it.normal, env.scope)) : null;
        if (nv && nv.every((x) => x === 0)) push([...P, 'normal'], 'degenerate', 'normal is the zero vector');
      }
      checkExpr(it.expr, it.unit, s, [...P, 'expr'], { compareUnit: !['arrow', 'streamline', 'deformation'].includes(t) });
    });
  });
  return out;
}

const desc = (s: DatasetShape): string => `${s.type}, ${['points', 'lines', 'surface', 'volume'][s.dim]}${s.axisym ? ', axisymmetric' : ''} in ${s.embed}D`;

/** Every selection inside the results block, as [path from the spec root, ids]. */
export function resultSelections(results: unknown): Array<{ path: PathKey[]; ids: string[] }> {
  const r = resultsOf({ results });
  const out: Array<{ path: PathKey[]; ids: string[] }> = [];
  r.datasets.forEach((d, i) => { if (Array.isArray(d.select)) out.push({ path: ['results', 'datasets', i, 'select'], ids: d.select }); });
  r.evaluations.forEach((e, i) => list<EvalItem>(e.items).forEach((it, j) => { if (Array.isArray(it.over)) out.push({ path: ['results', 'evaluations', i, 'items', j, 'over'], ids: it.over }); }));
  r.plots.forEach((p, i) => list<PlotItem>(p.items).forEach((it, j) => { if (Array.isArray(it.select)) out.push({ path: ['results', 'plots', i, 'items', j, 'select'], ids: it.select }); }));
  return out;
}

// ---- reader helpers ---------------------------------------------------------------------------------------------
export interface ResultNodeRef {
  id: string;
  section: ResultSection;
  /** node type (tables: 'table'; evaluation groups: 'group'). */
  type: string;
  /** JSON Pointer with indices, e.g. /results/plots/0/items/1. */
  pointer: string;
  /** JSON Pointer with @id tokens (stable under reordering), e.g. /results/plots/@sxx/items/@sxx_surf. */
  idPointer: string;
  /** id of the group of an item. */
  parent?: string;
  node: Record<string, unknown>;
}

/** Every results node (groups before their items), in section order. Defensive: malformed input yields fewer nodes. */
export function resultNodes(results: unknown): ResultNodeRef[] {
  const r = resultsOf({ results });
  const out: ResultNodeRef[] = [];
  const add = (section: ResultSection, nodes: Array<Record<string, unknown>>, typeOf: (n: Record<string, unknown>) => string, items: boolean) => nodes.forEach((n, i) => {
    const id = typeof n.id === 'string' ? n.id : `#${i}`;
    const ptr = `/results/${section}/${i}`, idp = `/results/${section}/@${id}`;
    out.push({ id, section, type: typeOf(n), pointer: ptr, idPointer: idp, node: n });
    if (items) list<Record<string, unknown>>(n.items).forEach((it, j) => {
      const iid = typeof it.id === 'string' ? it.id : `#${j}`;
      out.push({ id: iid, section, type: String(it.type ?? ''), pointer: `${ptr}/items/${j}`, idPointer: `${idp}/items/@${iid}`, parent: id, node: it });
    });
  });
  add('datasets', r.datasets as unknown as Array<Record<string, unknown>>, (n) => String(n.type ?? ''), false);
  add('evaluations', r.evaluations as unknown as Array<Record<string, unknown>>, () => 'group', true);
  add('tables', r.tables as unknown as Array<Record<string, unknown>>, () => 'table', false);
  add('plots', r.plots as unknown as Array<Record<string, unknown>>, (n) => String(n.type ?? ''), true);
  return out;
}

/** One step of a selection when it names exactly one: an index, or 'last' (the readers resolve it); undefined otherwise. */
export const singleStep = (s: unknown): number | 'last' | undefined => (typeof s === 'number' ? s : Array.isArray(s) && s.length === 1 && typeof s[0] === 'number' ? s[0] : s === 'first' ? 0 : s === 'last' ? 'last' : undefined);

/** False when the dataset or any dataset up its chain is disabled (or the chain does not resolve). */
function chainEnabled(ds: ReadonlyMap<string, DatasetNode>, id: string | undefined): boolean {
  const seen = new Set<string>();
  const walk = (x: string | undefined): boolean => {
    if (x === undefined || seen.has(x)) return x !== undefined;
    seen.add(x);
    const d = ds.get(x);
    if (!d || d.enabled === false) return false;
    if (d.type === 'solution') return true;
    if (d.type === 'join') return walk(d.a) && walk(d.b);
    return walk(d.data);
  };
  return walk(id);
}

/** Root dataset of a chain (solution) and the type of the dataset itself. */
function rootOf(ds: ReadonlyMap<string, DatasetNode>, id: string | undefined): { root: DatasetNode | null; self: DatasetNode | null } {
  const self = id === undefined ? null : ds.get(id) ?? null;
  let d = self;
  for (let k = 0; d && d.type !== 'solution' && k < 64; k++) d = ds.get((d.type === 'join' ? d.a : d.data) ?? '') ?? null;
  return { root: d && d.type === 'solution' ? d : null, self };
}

export interface HeadlineItem {
  id: string;
  type: 'max' | 'min' | 'point';
  label?: string;
  expr: string;
  unit?: string;
  method?: string;
  /** max / min: the selection reduced over. */
  over?: string[];
  /** point: the coordinates of the single point of its cutpoint dataset (null when the dataset has none or several). */
  at?: unknown[] | null;
  /** a single step (index or 'last'), when the item or its group names exactly one. */
  step?: number | 'last';
  /** type of the dataset the item reads, and the study at the root of its chain. */
  dataset?: string;
  study?: string;
  /** point: type of the dataset the cutpoint samples (e.g. solution, mirror). */
  source?: string;
}

/** Enabled max / min / point evaluation items (the headline numbers of a model), with their datasets resolved. */
export function headlineItems(results: unknown): HeadlineItem[] {
  const r = resultsOf({ results });
  const ds = new Map(r.datasets.map((d) => [d.id, d]));
  const out: HeadlineItem[] = [];
  for (const e of r.evaluations) {
    if (e.enabled === false) continue;
    for (const it of list<EvalItem>(e.items)) {
      if (it.enabled === false || (it.type !== 'max' && it.type !== 'min' && it.type !== 'point') || typeof it.expr !== 'string') continue;
      const dsId = it.data ?? e.data;
      if (!chainEnabled(ds, dsId)) continue;
      const { root, self } = rootOf(ds, dsId);
      const step = singleStep(it.steps ?? e.steps);
      const h: HeadlineItem = {
        id: it.id, type: it.type, expr: it.expr, ...(it.label ? { label: it.label } : {}), ...(it.unit ? { unit: it.unit } : {}), ...(step !== undefined ? { step } : {}),
        ...(self ? { dataset: self.type } : {}), ...(root?.data ? { study: root.data } : {}),
      };
      if (it.type === 'point') {
        const p = self?.type === 'cutpoint' && Array.isArray(self.points) && self.points.length === 1 ? self.points[0] : null;
        // a point as [q, q] or {value: [..], unit}
        h.at = Array.isArray(p) ? (p as unknown[]) : isObj(p) && Array.isArray(p.value) && typeof p.unit === 'string' ? (p.value as unknown[]).map((v) => ({ value: v, unit: p.unit })) : null;
        const src = self?.type === 'cutpoint' ? ds.get(self.data ?? '') : undefined;
        if (src) h.source = src.type;
      } else {
        if (it.method) h.method = it.method;
        if (it.over) h.over = it.over;
      }
      out.push(h);
    }
  }
  return out;
}

export interface SurfaceItem { group: string; id: string; type: 'plot2d' | 'plot3d'; expr: string; unit?: string; step?: number | 'last' }

/** Enabled surface items of 2D / 3D plot groups, in order. */
export function surfaceItems(results: unknown): SurfaceItem[] {
  const r = resultsOf({ results });
  const ds = new Map(r.datasets.map((d) => [d.id, d]));
  const out: SurfaceItem[] = [];
  for (const p of r.plots) {
    if (p.enabled === false || (p.type !== 'plot2d' && p.type !== 'plot3d')) continue;
    for (const it of list<PlotItem>(p.items)) {
      if (it.enabled === false || it.type !== 'surface' || typeof it.expr !== 'string' || !chainEnabled(ds, it.data ?? p.data)) continue;
      const step = singleStep(it.steps ?? p.steps);
      out.push({ group: p.id, id: it.id, type: p.type, expr: it.expr, ...(it.unit ? { unit: it.unit } : {}), ...(step !== undefined ? { step } : {}) });
    }
  }
  return out;
}

/** (expression, unit) of every enabled plot item, then every enabled evaluation item, that has both: display units of named fields. */
export function resultUnits(results: unknown): Array<{ id: string; expr: string; unit: string }> {
  const r = resultsOf({ results });
  const out: Array<{ id: string; expr: string; unit: string }> = [];
  for (const g of [...r.plots, ...r.evaluations] as Array<{ enabled?: unknown; items?: unknown }>) {
    if (g.enabled === false) continue;
    for (const it of list<{ id: string; expr?: unknown; unit?: unknown; enabled?: unknown }>(g.items)) {
      if (it.enabled !== false && typeof it.expr === 'string' && typeof it.unit === 'string') out.push({ id: it.id, expr: it.expr, unit: it.unit });
    }
  }
  return out;
}

/** The node and everything it reads: its group's defaults (without siblings), its items, dataset chain, table source. */
function upstream(r: Required<ResultsBlock>, id: string): Array<Record<string, unknown>> {
  const byId = new Map(resultNodes(r).map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  let fromItem = false, ownSteps = false; // the item names its own dataset / steps: the group defaults do not apply
  const visit = (nid: unknown, shallow = false) => {
    if (typeof nid !== 'string' || seen.has(nid)) return;
    const n = byId.get(nid);
    if (!n) return; // a study id (solution datasets) or unknown
    seen.add(nid);
    const { items, label: _l, ...own } = n.node;
    const { label: _g, ...full } = n.node;
    if (Array.isArray(items) && !shallow) full.items = items.map((it) => (isObj(it) ? (({ label: _x, ...rest }) => rest)(it) : it));
    if (shallow && fromItem) delete own.data;
    if (shallow && ownSteps) delete own.steps;
    out.push(shallow ? own : full);
    if (n.parent) visit(n.parent, true);
    for (const k of ['data', 'a', 'b', 'from', 'table'] as const) if (!(shallow && k === 'data' && fromItem)) visit(n.node[k]);
    if (!shallow) for (const it of list<{ id: string; data?: unknown; table?: unknown }>(items)) { seen.add(it.id); visit(it.data); visit(it.table); }
  };
  const start = byId.get(id);
  fromItem = !!start?.parent && typeof start.node.data === 'string';
  ownSteps = !!start?.parent && start.node.steps !== undefined;
  visit(id);
  return out;
}

/** Params referenced (transitively through param expressions) by a value. */
function paramsReferenced(data: unknown, value: unknown): Record<string, unknown> {
  const params = isObj(data) && isObj(data.params) ? data.params : {};
  const out: Record<string, unknown> = {};
  const scan = (x: unknown) => {
    if (typeof x === 'string') {
      for (const n of safeRefs(x)) if (Object.hasOwn(params, n) && !Object.hasOwn(out, n)) { out[n] = params[n]; scan(isObj(params[n]) ? (params[n] as { value?: unknown }).value : params[n]); }
    } else if (Array.isArray(x)) x.forEach(scan);
    else if (isObj(x)) Object.values(x).forEach(scan);
  };
  scan(value);
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}
function safeRefs(s: string): string[] {
  try { return referencedNames(parseExpression(s.replace(/(^|[^A-Za-z0-9_.])d\s*\(/g, '$1max('))); } catch { return quantityRefs(s); }
}

/**
 * Hash of a results node for value artifacts (C10): sha-256 of the canonical JSON of the node, every node it reads
 * (group, items, dataset chain, table source) and the params those reference. The study and geometry are covered by
 * the run id. Null when the id is not a results node.
 */
export async function resultNodeHash(data: unknown, id: string): Promise<string | null> {
  const r = resultsOf(data);
  const nodes = upstream(r, id);
  if (!nodes.length) return null;
  return sha256Hex(canonicalJson({ nodes, params: paramsReferenced(data, nodes) }));
}

/** Ids of results nodes added, removed or with a changed hash between two specs (dependents included through the hashes). */
export async function changedResultNodes(before: unknown, after: unknown): Promise<string[]> {
  const ids = new Set([...resultNodes(resultsOf(before)).map((n) => n.id), ...resultNodes(resultsOf(after)).map((n) => n.id)]);
  const out: string[] = [];
  for (const id of ids) if ((await resultNodeHash(before, id)) !== (await resultNodeHash(after, id))) out.push(id);
  return out.sort();
}

/** Run id of a solution run (C10): sha-256 of its canonical run record (C5). */
export const runId = (run: unknown): Promise<string> => sha256Hex(canonicalJson(run));
/** Key of a value artifact (table rows, sampled arrays, plot data): node hash and run id. */
export const artifactKey = (nodeHash: string, run: string): string => `${nodeHash}:${run}`;
