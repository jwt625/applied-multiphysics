// SPDX-License-Identifier: GPL-3.0-or-later
// amp-eval/0 case loader and validator. Pure (no fs): give it text, get the parsed case plus precise errors
// `file:line:col /json/pointer message`. Node file discovery lives in node-io.ts.

import { LineCounter, parseDocument, isMap, isSeq, isScalar, isPair, type Document, type Node as YNode } from 'yaml';
import schemaJson from '../../../eval/schema/amp-eval-0.schema.json' with { type: 'json' };
import { Validator, pointerParse, type Schema } from './schema-validate.ts';

export const SCHEMA_ID = 'amp-eval/0';
export const CLASSES = ['a', 'b', 'c'] as const;
export type CaseClass = (typeof CLASSES)[number];

export interface Tolerance {
  rel?: number;
  abs?: number;
  after?: 'richardson' | 'finest' | 'none';
  norm?: 'l2' | 'max' | 'rel_l2' | 'rel_max';
  rule?: Rule;
  note?: string;
}
export interface Rule {
  type: 'range' | 'sign' | 'monotonic' | 'rate';
  range?: [number, number];
  sign?: -1 | 1;
  direction?: 'increasing' | 'decreasing';
  min?: number;
  max?: number;
  of?: 'value' | 'error';
  note?: string;
}
export interface ConstTerm { value: number; unit: string; source?: string }
export interface Extract {
  kind: 'scalar' | 'probe' | 'field' | 'eigen' | 'steps' | 'reduce' | 'expr';
  op?: 'max' | 'min' | 'mean' | 'absmax' | 'absmin';
  expr?: string;
  terms?: Record<string, Extract | ConstTerm>;
  fields?: string[];
  components?: number[];
  evaluator_fields?: string[];
  name?: string;
  field?: string;
  component?: number;
  point?: number[];
  samples_key?: string;
  points?: number[][];
  evaluator?: string;
  evaluator_case?: string;
  params?: Record<string, unknown>;
  offset?: number;
  floor?: number;
  index?: number;
  max_dropped?: number;
  match?: 'sorted' | 'subsequence';
}
export interface Reference {
  id?: string;
  quantity: string;
  definition?: string;
  value?: number | number[] | null;
  metric_id?: string;
  case?: Record<string, number | string | boolean>;
  extraction?: unknown;
  expected?: { file?: string; metric_id?: string; key?: string };
  unit: string;
  at?: unknown;
  tolerance: Tolerance;
  bounds?: [number, number] | null;
  basis: 'P' | 'S' | 'D';
  form: 'closed_form' | 'benchmark' | 'paper_sim' | 'paper_measured' | 'solver_ref' | 'dataset';
  provenance: { citation: string; locator: string; accessed: string | null; [k: string]: unknown };
  extract?: Extract;
  expected_order?: number;
  spec?: SpecRef;
  gate?: boolean;
  note?: string;
}
export type SpecRef = string | { schema: 'amp-spec/0'; [k: string]: unknown } | { status: 'pending'; reason: string };
export interface EvalCase {
  schema: 'amp-eval/0';
  id: string;
  class: CaseClass;
  title: string;
  status: 'unvalidated' | 'verified' | 'validated' | 'measured_regression' | 'untestable';
  untestable_reason?: string | null;
  physics: string[];
  dimension: string | string[];
  spec: SpecRef;
  references: Reference[];
  convergence?: {
    levels_min?: number; ratio_min?: number; method?: 'richardson_gci' | 'rate_fit' | 'none';
    safety_factor?: number; expected_order?: number; h_factors?: number[]; order_band?: number; order_check?: boolean; dt_with_h?: boolean; space_order?: number; time_order?: number;
  } | null;
  speed?: { budget_s?: { browser?: number; native?: number }; report?: string[]; reference_timings?: unknown[] | null } | null;
  adapter?: { python?: { script: string; args?: string[] } } | null;
  expected?: string | null;
  [k: string]: unknown;
}

export interface LoadIssue {
  file: string;
  line?: number;
  col?: number;
  path: string;            // JSON pointer into the case ('' = document)
  severity: 'error' | 'warning';
  keyword: string;         // schema keyword, 'yaml', or a semantic check name
  message: string;
}

export interface LoadedCase {
  file: string;
  data: EvalCase | null;   // null when YAML parsing failed
  expectedFile: string | null;
  expected: unknown;       // parsed expected JSON, undefined when absent
  issues: LoadIssue[];
}

export function formatIssue(i: LoadIssue): string {
  const pos = i.line !== undefined ? `:${i.line}:${i.col ?? 1}` : '';
  return `${i.file}${pos} ${i.path || '/'} [${i.severity} ${i.keyword}] ${i.message}`;
}

let validator: Validator | null = null;
export function caseValidator(): Validator {
  validator ??= new Validator(schemaJson as Schema);
  return validator;
}

/** Dotted path; array segments are indices or a metric_id / id match. */
export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      // numeric index, else the element whose metric_id / id equals the segment (amp-eval-expected/0 targets list)
      cur = /^\d+$/.test(part) ? cur[Number(part)]
        : cur.find((x) => x && typeof x === 'object' && ((x as Record<string, unknown>).metric_id === part || (x as Record<string, unknown>).id === part));
    }
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

// Source position of the node at a JSON pointer; falls back to the deepest existing ancestor. An unknown-key
// error points at the key itself.
function locate(doc: Document, lc: LineCounter, ptr: string): { line: number; col: number } | undefined {
  let node: unknown = doc.contents;
  let pos: number | undefined = (node as YNode | null)?.range?.[0];
  for (const seg of pointerParse(ptr)) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isPair(p) && isScalar(p.key) && String(p.key.value) === seg);
      if (!pair) break;
      const keyPos = (pair.key as YNode).range?.[0];
      node = pair.value;
      pos = (node as YNode | null)?.range?.[0] ?? keyPos;
      if (node === null || node === undefined) { pos = keyPos; break; }
    } else if (isSeq(node)) {
      const it = node.items[Number(seg)];
      if (it === undefined) break;
      node = it;
      pos = (it as YNode).range?.[0] ?? pos;
    } else break;
  }
  if (pos === undefined) return undefined;
  const lp = lc.linePos(pos);
  return { line: lp.line, col: lp.col };
}

function locateKey(doc: Document, lc: LineCounter, ptr: string): { line: number; col: number } | undefined {
  const segs = pointerParse(ptr);
  const last = segs.pop();
  if (last === undefined) return locate(doc, lc, ptr);
  let node: unknown = doc.contents;
  for (const seg of segs) {
    if (isMap(node)) node = node.items.find((p) => isPair(p) && isScalar(p.key) && String(p.key.value) === seg)?.value;
    else if (isSeq(node)) node = node.items[Number(seg)];
    else return locate(doc, lc, ptr);
  }
  if (isMap(node)) {
    const pair = node.items.find((p) => isPair(p) && isScalar(p.key) && String(p.key.value) === last);
    const at = (pair?.key as YNode | undefined)?.range?.[0];
    if (at !== undefined) { const lp = lc.linePos(at); return { line: lp.line, col: lp.col }; }
  }
  return locate(doc, lc, ptr);
}

export interface ParseOptions {
  /** parent directory name of the file (class check); omit to skip */
  dirClass?: string;
  /** file name without extension (id check); omit to skip */
  stem?: string;
  /** expected JSON text (null = file absent) */
  expectedText?: string | null;
  expectedFile?: string | null;
  /** ISO date used for the future-date check; default = today (local) */
  today?: string;
}

export function todayIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseCase(text: string, file: string, opts: ParseOptions = {}): LoadedCase {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  const issues: LoadIssue[] = [];
  const out: LoadedCase = { file, data: null, expectedFile: opts.expectedFile ?? null, expected: undefined, issues };

  for (const e of doc.errors) {
    const lp = lc.linePos(e.pos[0]);
    issues.push({ file, line: lp.line, col: lp.col, path: '', severity: 'error', keyword: 'yaml', message: e.message.split('\n')[0] ?? e.message });
  }
  for (const w of doc.warnings) {
    const lp = lc.linePos(w.pos[0]);
    issues.push({ file, line: lp.line, col: lp.col, path: '', severity: 'warning', keyword: 'yaml', message: w.message.split('\n')[0] ?? w.message });
  }
  if (doc.errors.length) return out;
  let data: unknown;
  try { data = doc.toJS({ maxAliasCount: 100 }); } catch (e) {
    issues.push({ file, path: '', severity: 'error', keyword: 'yaml', message: (e as Error).message });
    return out;
  }

  const at = (path: string, keyword: string, message: string, severity: 'error' | 'warning' = 'error', key = false) => {
    const pos = key ? locateKey(doc, lc, path) : locate(doc, lc, path);
    issues.push({ file, ...(pos ?? {}), path, severity, keyword, message });
  };

  for (const e of caseValidator().validate(data)) at(e.path, e.keyword, e.message, 'error', e.keyword === 'additionalProperties');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return out;
  const c = data as EvalCase;
  out.data = c;
  // normalize rule shorthands (schema S29)
  if (Array.isArray(c.references)) for (const r of c.references) {
    const ru = r?.tolerance?.rule as unknown;
    if (ru === 'range' || ru === 'within_bounds') r.tolerance.rule = { type: 'range' };
    else if (ru === 'sign') r.tolerance.rule = { type: 'sign' };
  }

  // Expected JSON (C8: eval/expected/<ID>.json)
  if (opts.expectedText !== undefined && opts.expectedText !== null) {
    try { out.expected = JSON.parse(opts.expectedText); } catch (e) {
      issues.push({ file: opts.expectedFile ?? 'expected', path: '', severity: 'error', keyword: 'json', message: (e as Error).message });
    }
  }
  semanticChecks(c, opts, out, at);
  return out;
}

function semanticChecks(
  c: EvalCase, opts: ParseOptions, out: LoadedCase,
  at: (path: string, keyword: string, message: string, severity?: 'error' | 'warning', key?: boolean) => void,
): void {
  if (opts.stem !== undefined && typeof c.id === 'string' && c.id !== opts.stem) {
    at('/id', 'id-filename', `id '${c.id}' differs from file name '${opts.stem}.yaml'`);
  }
  if (opts.dirClass !== undefined && (CLASSES as readonly string[]).includes(opts.dirClass) && c.class !== opts.dirClass) {
    at('/class', 'class-dir', `class '${String(c.class)}' differs from directory '${opts.dirClass}'`);
  }
  const today = opts.today ?? todayIso();
  const refs = Array.isArray(c.references) ? c.references : [];
  const seen = new Map<string, number>();
  const conv = c.convergence ?? null;
  refs.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const p = `/references/${i}`;
    const tid = targetId(r);
    if (typeof tid === 'string') {
      const j = seen.get(tid);
      if (j !== undefined) at(r.id ? `${p}/id` : r.metric_id ? `${p}/metric_id` : `${p}/quantity`, 'target-id', `target id '${tid}' repeats references/${j}; give each an explicit 'id' or 'metric_id'`);
      else seen.set(tid, i);
    }
    const acc = r.provenance?.accessed;
    if (typeof acc === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(acc) && acc > today) {
      at(`${p}/provenance/accessed`, 'future-date', `accessed ${acc} is after ${today}`);
    }
    if (Array.isArray(r.bounds) && r.bounds.length === 2 && typeof r.bounds[0] === 'number' && typeof r.bounds[1] === 'number') {
      if (r.bounds[0] > r.bounds[1]) at(`${p}/bounds`, 'bounds-order', `bounds [${r.bounds[0]}, ${r.bounds[1]}] not ascending`);
      else if (typeof r.value === 'number' && (r.value < r.bounds[0] || r.value > r.bounds[1])) {
        at(`${p}/value`, 'value-in-bounds', `value ${r.value} outside bounds [${r.bounds[0]}, ${r.bounds[1]}]`, 'warning');
      }
    }
    const rg = r.tolerance?.rule?.range;
    if (Array.isArray(rg) && rg.length === 2 && rg[0]! > rg[1]!) at(`${p}/tolerance/rule/range`, 'bounds-order', `range [${rg[0]}, ${rg[1]}] not ascending`);
    if (r.tolerance?.rule?.type === 'range' && !Array.isArray(rg) && !Array.isArray(r.bounds)) {
      at(`${p}/tolerance/rule`, 'rule-range', `rule 'range' needs tolerance.rule.range or bounds`);
    }
    if (r.tolerance?.rule?.type === 'monotonic' && !r.tolerance.rule.direction) at(`${p}/tolerance/rule`, 'rule-monotonic', `rule 'monotonic' needs direction`);
    if (r.tolerance?.rule?.type === 'rate' && r.tolerance.rule.min === undefined) at(`${p}/tolerance/rule`, 'rule-rate', `rule 'rate' needs min`);
    if (r.tolerance?.rule?.type === 'sign' && r.tolerance.rule.sign === undefined && typeof r.value !== 'number') {
      at(`${p}/tolerance/rule`, 'rule-sign', `rule 'sign' needs sign or a scalar value`);
    }
    if (r.tolerance?.rel !== undefined && typeof r.value === 'number' && r.value === 0 && r.tolerance.abs === undefined) {
      at(`${p}/tolerance`, 'rel-zero-ref', `rel tolerance with reference value 0; add abs`);
    }
    if (Array.isArray(r.value) && Array.isArray(r.at) && r.at.length !== r.value.length) {
      at(`${p}/at`, 'at-length', `at has ${r.at.length} entries, value has ${r.value.length}`);
    }
    if (r.extract?.kind === 'eigen') {
      if (r.extract.floor !== undefined && (r.extract.offset ?? 0) > 0) {
        at(`${p}/extract`, 'eigen-double-skip', `floor and offset both skip leading modes (offset applies after floor): keep one`);
      }
      if (typeof r.value === 'number' && r.extract.index === undefined) {
        at(`${p}/extract`, 'eigen-index', `scalar eigen target needs extract.index (0-based position in the sorted list after floor / offset)`);
      }
    }
    if (r.metric_id === undefined) {
      at(`${p}`, 'metric-id', `no metric_id: the engine looks targets up by metric_id only; this target stays pending on the engine path`, 'warning');
    }
    if (r.extract?.kind === 'field' && !r.extract.samples_key && !(r.extract.evaluator && r.extract.points)) {
      at(`${p}/extract`, 'extract-field', `extract kind 'field' needs samples_key, or evaluator + points`);
    }
    if (r.extract?.kind === 'field' && !(r.extract.field ?? r.extract.name ?? r.extract.fields)) at(`${p}/extract`, 'extract-field', `extract kind 'field' needs field or fields`);
    if (r.extract?.kind === 'field' && r.extract.fields && r.extract.components) at(`${p}/extract`, 'extract-field', `use fields (several fields) or components (one vector field), not both`);
    if (r.extract?.kind === 'field' && r.extract.evaluator_fields) {
      const n = r.extract.fields?.length ?? r.extract.components?.length ?? 1;
      if (r.extract.evaluator_fields.length !== n) at(`${p}/extract/evaluator_fields`, 'extract-field', `evaluator_fields has ${r.extract.evaluator_fields.length} names for ${n} engine components`);
    }
    if (r.extract?.kind === 'field' && ['', '1', '-', 'dimensionless'].includes((r.unit ?? '').trim()) && r.tolerance?.norm !== 'rel_l2' && r.tolerance?.norm !== 'rel_max') {
      at(`${p}/tolerance`, 'field-relative', `field target with unit '1' is evaluated as the relative norm (||e|| / ||ref||); write norm: rel_l2 or rel_max to say so`, 'warning');
    }
    const checkTerms = (ex: Extract | undefined, path: string) => {
      if (!ex) return;
      if (ex.kind === 'reduce' && (!ex.op || !(ex.field ?? ex.name) || !ex.points)) at(path, 'extract-reduce', `extract kind 'reduce' needs op, field and points`);
      if (ex.kind === 'expr') {
        if (!ex.expr || !ex.terms) { at(path, 'extract-expr', `extract kind 'expr' needs expr and terms`); return; }
        for (const [k, t] of Object.entries(ex.terms)) if (t && typeof t === 'object' && 'kind' in t) {
          if (!['scalar', 'probe', 'reduce', 'expr'].includes(t.kind)) at(`${path}/terms/${k}`, 'extract-expr', `term kind '${t.kind}' must be scalar, probe, reduce or expr`);
          if (t.kind === 'scalar' && !t.name) at(`${path}/terms/${k}`, 'extract-expr', `scalar term needs name`);
          checkTerms(t, `${path}/terms/${k}`);
        }
      }
    };
    checkTerms(r.extract, `${p}/extract`);
    if (r.extract?.kind === 'probe' && (!r.extract.point || !(r.extract.field ?? r.extract.name))) {
      at(`${p}/extract`, 'extract-probe', `extract kind 'probe' needs field and point`);
    }
    if (r.tolerance?.after === 'richardson') {
      if (!conv) at(`${p}/tolerance/after`, 'richardson-convergence', `after: richardson needs a convergence block (levels_min >= 3)`, 'warning');
      else if ((conv.levels_min ?? 0) < 3) at('/convergence/levels_min', 'richardson-levels', `after: richardson needs levels_min >= 3, got ${conv.levels_min ?? 'none'}`);
    }
    if ((r.basis === 'P' || r.basis === 'S') && r.provenance && r.provenance.accessed === null) {
      at(`${p}/provenance/accessed`, 'accessed-required', `basis ${r.basis} needs an accessed date (null only for basis D)`);
    }
    if (r.expected !== undefined && r.expected !== null && typeof r.expected === 'object') {
      const ef = r.expected.file;
      if (ef !== undefined && out.expectedFile !== null && ef !== out.expectedFile) {
        at(`${p}/expected/file`, 'expected-file', `expected.file '${ef}' differs from the case expected file '${out.expectedFile}'`);
      } else if (out.expected === undefined) {
        at(`${p}/expected`, 'expected-missing', `${out.expectedFile ?? 'expected JSON'} is absent or unreadable`);
      } else {
        const v = expectedEntry(out.expected, r.expected);
        if (v === undefined) at(`${p}/expected`, 'expected-key', `${r.expected.metric_id !== undefined ? `metric_id '${r.expected.metric_id}'` : `key '${r.expected.key}'`} not found in ${out.expectedFile}`);
        else if (numericOf(v) === undefined && r.extract?.kind !== 'field') at(`${p}/expected`, 'expected-key', `entry in ${out.expectedFile} is not a number, number array or {value}`);
        else if (typeof r.value === 'number' && typeof numericOf(v) === 'number') {
          const g = numericOf(v) as number;
          const rel = Math.abs(r.value - g) / Math.max(Math.abs(g), 1e-300);
          if (rel > 1e-12) at(`${p}/value`, 'value-vs-expected', `inline value ${r.value} differs from ${out.expectedFile} value ${g} (rel ${rel.toExponential(2)}); run --adapter expected for the budget check`, 'warning');
        }
      }
    }
    if (r.extract?.samples_key !== undefined && out.expected !== undefined) {
      const s = getPath(out.expected, r.extract.samples_key) as { points?: unknown; values?: unknown } | undefined;
      if (!s || !Array.isArray(s.points) || !Array.isArray(s.values)) {
        at(`${p}/extract/samples_key`, 'samples', `'${r.extract.samples_key}' in ${out.expectedFile} is not {points: [...], values: [...]}`);
      } else {
        const comps = (s.values as unknown[]).every((v) => Array.isArray(v)) ? (s.values as unknown[][]) : [s.values as unknown[]];
        for (const [k, cv] of comps.entries()) if (cv.length !== s.points.length) at(`${p}/extract/samples_key`, 'samples', `samples component ${k}: ${s.points.length} points and ${cv.length} values`);
      }
    }
  });
  const rights = c.rights as { allowed?: unknown[]; forbidden?: unknown[] } | undefined;
  if (Array.isArray(rights?.allowed) && rights.allowed.includes('reference_by_hash')) {
    const h = (c.dataset as { hash?: unknown } | null | undefined)?.hash;
    if (typeof h !== 'string' || !h.length) at(c.dataset ? '/dataset' : '/rights/allowed', 'reference-by-hash', `rights tag reference_by_hash requires dataset.hash (sha256:<64 hex> or md5:<32 hex>)`);
  }
  if (c.convergence?.dt_with_h) {
    if (c.convergence.time_order === undefined) at('/convergence', 'dt-with-h', `dt_with_h needs time_order`);
    if (c.convergence.space_order === undefined && c.convergence.expected_order === undefined) at('/convergence', 'dt-with-h', `dt_with_h needs space_order or expected_order`);
  }
  if (c.convergence?.h_factors && c.convergence.levels_min !== undefined && c.convergence.h_factors.length < c.convergence.levels_min) {
    at('/convergence/h_factors', 'levels', `h_factors has ${c.convergence.h_factors.length} levels, levels_min is ${c.convergence.levels_min}`);
  }
  if (c.convergence?.h_factors && c.convergence.ratio_min !== undefined) {
    const hf = c.convergence.h_factors;
    for (let k = 1; k < hf.length; k++) {
      const ratio = hf[k - 1]! / hf[k]!;
      if (ratio < c.convergence.ratio_min) at(`/convergence/h_factors/${k}`, 'ratio', `refinement ratio ${ratio.toFixed(3)} < ratio_min ${c.convergence.ratio_min}`);
    }
  }
  if (out.expected !== undefined && out.expected !== null && typeof out.expected === 'object') {
    const e = out.expected as Record<string, unknown>;
    for (const k of ['id', 'case'] as const) {
      if (typeof e[k] === 'string' && e[k] !== c.id) {
        out.issues.push({ file: out.expectedFile ?? 'expected', path: `/${k}`, severity: 'error', keyword: 'expected-id', message: `expected JSON ${k} '${String(e[k])}' differs from case id '${c.id}'` });
      }
    }
    // C8: generator path, package versions and ISO timestamp next to the values
    const has = (...ks: string[]) => ks.some((k) => k in e);
    if (!has('generator')) out.issues.push({ file: out.expectedFile ?? 'expected', path: '', severity: 'warning', keyword: 'expected-meta', message: `no 'generator' (C8)` });
    if (!has('versions', 'package_versions', 'packages')) out.issues.push({ file: out.expectedFile ?? 'expected', path: '', severity: 'warning', keyword: 'expected-meta', message: `no package versions (C8)` });
    if (!has('generated_at', 'timestamp', 'generated')) out.issues.push({ file: out.expectedFile ?? 'expected', path: '', severity: 'warning', keyword: 'expected-meta', message: `no ISO timestamp (C8)` });
  }
}

function numericOf(v: unknown): number | number[] | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'number')) return v as number[];
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object)) return numericOf((v as { value: unknown }).value);
  return undefined;
}

/** Entry of an expected JSON for a reference link: targets[] element by metric_id, or a dotted key. */
export function expectedEntry(expected: unknown, link: { metric_id?: string; key?: string }): unknown {
  if (link.metric_id !== undefined) {
    const ts = (expected as { targets?: unknown } | null)?.targets;
    return Array.isArray(ts) ? ts.find((t) => t && typeof t === 'object' && (t as { metric_id?: unknown }).metric_id === link.metric_id) : undefined;
  }
  if (link.key !== undefined) return getPath(expected, link.key);
  return undefined;
}

/** Generated value for a reference: explicit expected link, else targets[] by target id. */
export function generatedValue(r: Reference, expected: unknown): number | number[] | undefined {
  if (expected === undefined) return undefined;
  const v = r.expected ? expectedEntry(expected, r.expected) : expectedEntry(expected, { metric_id: targetId(r) });
  return numericOf(v);
}

/** Value of a reference: inline value, else the generated value from the expected JSON. */
export function referenceValue(r: Reference, expected: unknown): number | number[] | undefined {
  if (r.value !== undefined && r.value !== null) return r.value;
  return r.expected ? generatedValue(r, expected) : undefined;
}

/** Target id: id, else metric_id, else quantity with the parametric case appended, e.g. `u[Re=100]`. */
export function targetId(r: Reference): string {
  if (r.id ?? r.metric_id) return (r.id ?? r.metric_id)!;
  const c = r.case && typeof r.case === 'object' ? Object.entries(r.case).map(([k, v]) => `${k}=${String(v)}`).join(',') : '';
  return c ? `${r.quantity}[${c}]` : r.quantity;
}
