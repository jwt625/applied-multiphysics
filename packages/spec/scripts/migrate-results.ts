// SPDX-License-Identifier: GPL-3.0-or-later
// One-pass migration of the legacy flat `results: [...]` list to the grouped results object (DevLog-025 s.1.4,
// CONTRACTS C10). Rerunnable: files whose `results` is already an object are skipped. Only the text of the `results`
// block is replaced; the script verifies, per file, that the rest of the parsed spec is unchanged, that every comment
// line is kept, that the new block parses to the intended object, and that the spec validates against the full
// registry (physics + geom + materials, loaded by relative path as in test/sims-live.test.ts).
// Scope: sims/*.yaml, packages/spec/test/fixtures/*.yaml, and eval/cases/**/*.yaml specs embedded under `spec:`.
// Usage: nice -n 10 node --max-old-space-size=1536 packages/spec/scripts/migrate-results.ts [--write]
//   default: dry run (prints the diff of each file, writes nothing but the log); --write writes the files.
// Log: logs/R0-migrate-results-<timestamp>.log
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { isMap, isScalar, type Document } from 'yaml';
import { parseStrict, fmt } from '../src/yaml-edit.mjs';
import { parseSpecText, formatIssues } from '../src/yaml.ts';
import { resolveParams } from '../src/validate.ts';
import { canonicalJson } from '../src/canonical.ts';
import { isoNow } from '../src/run-record.ts';
import type { Registry } from '../src/registry.ts';

const ROOT = new URL('../../../', import.meta.url);
const WRITE = process.argv.includes('--write');
const stamp = isoNow().replace(/[-:]/g, '').slice(0, 15);
mkdirSync(new URL('logs/', ROOT), { recursive: true });
const logPath = new URL(`logs/R0-migrate-results-${stamp}.log`, ROOT);
const lines: string[] = [];
const say = (s: string) => { lines.push(s); console.log(s); };

type O = Record<string, unknown>;
const isObj = (x: unknown): x is O => !!x && typeof x === 'object' && !Array.isArray(x);
interface Legacy { id: string; type: string; label?: string; data: string; expr?: string; unit?: string; select?: string[]; at?: unknown[]; step?: number }

async function fullRegistry(): Promise<Registry> {
  const phys = await import(new URL('packages/physics/src/registrations.ts', ROOT).href) as { physicsRegistry(): Registry };
  const geom = await import(new URL('packages/geom/src/spec.ts', ROOT).href) as { registerGeomFeatures(r: Registry): Registry };
  const mat = await import(new URL('packages/materials/src/properties.ts', ROOT).href) as { registerMaterialProperties(r: Registry): string[] };
  const reg = geom.registerGeomFeatures(phys.physicsRegistry());
  mat.registerMaterialProperties(reg);
  return reg;
}

function allIds(x: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(x)) x.forEach((e) => allIds(e, out));
  else if (isObj(x)) { if (typeof x.id === 'string') out.add(x.id); Object.values(x).forEach((v) => allIds(v, out)); }
  return out;
}

/**
 * Grouped results object for a legacy list (rules: DevLog-025 s.1.4), and the map of dotted paths into the legacy
 * nodes (provenance keys, assumption and missing paths) to their new paths. Throws on a legacy form it cannot map
 * exactly.
 */
export function convert(legacy: Legacy[], spec: O): { block: O; paths: (p: string) => string } {
  const moved = new Map<string, { node: string; fields: Record<string, string> }>();
  const taken = allIds(spec, new Set()); // legacy ids stay taken: they are reused as written, never by fresh()
  const fresh = (want: string) => { let id = want, k = 2; while (taken.has(id)) id = `${want}_${k++}`; taken.add(id); return id; };
  const studies = new Map<string, { physics: string[] }>(((spec.studies ?? []) as Array<{ id: string; physics: string[] }>).map((s) => [s.id, s]));
  const params = resolveParams(spec.params);
  const sol = new Map<string, string>();
  const solId = (study: string) => {
    if (!studies.has(study)) throw new Error(`result data '${study}' is not a study`);
    if (!sol.has(study)) sol.set(study, fresh(`sol_${study}`));
    return sol.get(study)!;
  };
  const fieldRef = (e: string, study: string): string => {
    if (e.includes('.') || params.scope.has(e)) return e;
    const ph = studies.get(study)!.physics;
    if (ph.length !== 1) throw new Error(`bare field '${e}' and study '${study}' solves ${ph.length} physics: cannot prefix`);
    return `${ph[0]}.${e}`;
  };
  const opt = (k: string, v: unknown): O => (v === undefined ? {} : { [k]: v });
  const points: O[] = [];
  const groups = new Map<string, { items: O[]; table: boolean }>();
  const group = (study: string) => { solId(study); if (!groups.has(study)) groups.set(study, { items: [], table: false }); return groups.get(study)!; };
  const plots: O[] = [];
  for (const r of legacy) {
    const unit = opt('unit', r.unit), label = opt('label', r.label), steps = opt('steps', r.step);
    const ex = r.expr === undefined ? undefined : r.expr.trim();
    switch (r.type) {
      case 'plot2d': case 'plot3d': case 'plot1d':
        if (r.type === 'plot1d' || ex === undefined || r.select || r.at) throw new Error(`${r.id}: legacy ${r.type} form not mapped (plot1d, no expr, select or at)`);
        {
          const surf = fresh(`${r.id}_surf`), it = `results.plots.${r.id}.items.${surf}`;
          plots.push({ id: r.id, type: r.type, ...label, data: solId(r.data), ...steps, items: [{ id: surf, type: 'surface', expr: fieldRef(ex, r.data), ...unit }] });
          moved.set(r.id, { node: `results.plots.${r.id}`, fields: { expr: `${it}.expr`, unit: `${it}.unit`, step: `results.plots.${r.id}.steps`, data: `results.plots.${r.id}.data` } });
        }
        break;
      case 'probe': {
        if (ex === undefined || !r.at || r.select) throw new Error(`${r.id}: probe needs expr and at, no select`);
        const pid = fresh(`${r.id}_pt`);
        points.push({ id: pid, type: 'cutpoint', data: solId(r.data), points: [r.at] });
        group(r.data).items.push({ id: r.id, type: 'point', ...label, data: pid, ...steps, expr: fieldRef(ex, r.data), ...unit });
        moved.set(r.id, { node: `@item:${r.id}`, fields: { at: `results.datasets.${pid}.points.0`, data: `results.datasets.${pid}.data` } });
        break;
      }
      case 'scalar': {
        const m = /^(max|min)\(\s*([\w.]+)\s*\)(.*)$/.exec(ex ?? '');
        if (!m || !r.select || r.at) throw new Error(`${r.id}: scalar form '${ex}' not mapped (max(f) or min(f) with a tail, over a select)`);
        const tail = m[3]!.trim();
        const t = /^([/*])\s*([A-Za-z_]\w*)$/.exec(tail);
        if (tail && !(t && (params.scope.get(t[2]!)?.si ?? 0) > 0)) throw new Error(`${r.id}: tail '${tail}' is not / or * by a positive param: max(f)${tail} != max(f${tail}) in general`);
        group(r.data).items.push({ id: r.id, type: m[1], ...label, ...steps, expr: `${fieldRef(m[2]!, r.data)}${tail ? `${t![1]}${t![2]}` : ''}`, ...unit, over: r.select, method: 'nodal' });
        moved.set(r.id, { node: `@item:${r.id}`, fields: { select: '@item.over', step: '@item.steps' } });
        break;
      }
      case 'table': {
        if (ex === undefined || r.select || r.at) throw new Error(`${r.id}: table needs expr, no select or at`);
        const g = group(r.data);
        g.items.push({ id: r.id, type: 'global', ...label, ...steps, expr: fieldRef(ex, r.data), ...unit });
        g.table = true;
        moved.set(r.id, { node: `@item:${r.id}`, fields: { step: '@item.steps' } });
        break;
      }
      default: throw new Error(`${r.id}: unknown legacy type '${r.type}'`);
    }
  }
  const out: O = {};
  const datasets = [...[...sol].map(([study, id]) => ({ id, type: 'solution', data: study })), ...points];
  if (datasets.length) out.datasets = datasets;
  if (groups.size) out.evaluations = [...groups].map(([study, g]) => ({ id: fresh(`ev_${study}`), data: sol.get(study)!, items: g.items }));
  const tables = [...groups].filter(([, g]) => g.table).map(([study]) => ({ id: fresh(`tbl_${study}`), from: (out.evaluations as O[]).find((e) => e.data === sol.get(study))!.id }));
  if (tables.length) out.tables = tables;
  if (plots.length) out.plots = plots;
  // item paths, now that the evaluation group ids are known
  const itemPath = (id: string) => {
    for (const e of (out.evaluations as O[] | undefined) ?? []) if ((e.items as O[]).some((it) => it.id === id)) return `results.evaluations.${String(e.id)}.items.${id}`;
    throw new Error(`no item ${id}`);
  };
  const paths = (p: string): string => {
    const m = /^results\.([^.]+)(?:\.([^.]+))?(\..*)?$/.exec(p);
    if (!m) return p;
    const r = /^\d+$/.test(m[1]!) ? legacy[Number(m[1])] : legacy.find((x) => x.id === m[1]);
    const mv = r && moved.get(r.id);
    if (!r || !mv) return p;
    const base = mv.node.startsWith('@item:') ? itemPath(r.id) : mv.node;
    if (m[2] === undefined) return base;
    const f = mv.fields[m[2]] ?? `${base}.${m[2]}`;
    return `${f.replace('@item', base)}${m[3] ?? ''}`;
  };
  return { block: out, paths };
}

/** YAML text of a grouped results block at `indent` spaces (sections and groups in block style, nodes in flow style). */
export function emit(block: O, indent: number): string {
  const pad = (n: number) => ' '.repeat(indent + n);
  const out = [`${pad(0)}results:`];
  for (const sec of ['datasets', 'evaluations', 'tables', 'plots']) {
    const nodes = block[sec] as O[] | undefined;
    if (!nodes) continue;
    out.push(`${pad(2)}${sec}:`);
    for (const n of nodes) {
      if (!Array.isArray(n.items)) { out.push(`${pad(4)}- ${fmt(n)}`); continue; }
      const keys = Object.keys(n).filter((k) => k !== 'items');
      keys.forEach((k, i) => out.push(`${pad(i === 0 ? 4 : 6)}${i === 0 ? '- ' : ''}${k}: ${fmt(n[k])}`));
      out.push(`${pad(6)}items:`);
      for (const it of n.items as O[]) out.push(`${pad(8)}- ${fmt(it)}`);
    }
  }
  return out.join('\n');
}

const commentLines = (t: string) => t.split('\n').filter((l) => l.trim().startsWith('#')).map((l) => l.trim()).sort();
const lineStart = (t: string, at: number) => t.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (t: string, at: number) => { const e = t.indexOf('\n', at); return e < 0 ? t.length : e; };

/** Migrate the spec map at `specPath` inside the document text; null when there is nothing to do. */
function migrateText(text: string, specPath: string[]): { text: string; legacy: number; block: O; paths: (p: string) => string; rewritten: number } | null {
  const doc = parseStrict(text) as Document.Parsed;
  const map = specPath.length ? doc.getIn(specPath, true) : doc.contents;
  if (!isMap(map)) return null;
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === 'results');
  if (!pair) return null;
  const plain = (specPath.length ? (doc.toJS() as O)[specPath[0]!] : doc.toJS()) as O;
  if (!Array.isArray(plain.results)) return null; // already grouped
  const key = pair.key as { range?: [number, number, number] };
  const val = pair.value as { range?: [number, number, number]; flow?: boolean } | null;
  if (!key.range || !val?.range) throw new Error('results: no source range');
  const start = lineStart(text, key.range[0]);
  const indent = key.range[0] - start;
  if (text.slice(start, key.range[0]).trim()) throw new Error('results key is not at the start of its line (flow mapping)');
  const end = lineEnd(text, val.range[1] - 1);
  const { block, paths } = convert(plain.results as Legacy[], plain);
  // phase 1 (on the text after the results block, so the offsets above stay valid): paths into the legacy nodes
  const edits = pathEdits(map, paths).filter((e) => e.at >= end || e.end <= start);
  if (edits.some((e) => e.at < end)) throw new Error('a provenance / assumption / missing path precedes the results block (not handled)');
  let tail = text.slice(end);
  for (const e of edits.sort((x, y) => y.at - x.at)) tail = tail.slice(0, e.at - end) + e.text + tail.slice(e.end - end);
  const next = text.slice(0, start) + emit(block, indent) + tail;
  return { text: next, legacy: (plain.results as unknown[]).length, block, paths, rewritten: edits.length };
}

/** Text edits that rewrite provenance keys, assumption paths and missing paths into the legacy results nodes. */
function pathEdits(map: unknown, paths: (p: string) => string): Array<{ at: number; end: number; text: string }> {
  const out: Array<{ at: number; end: number; text: string }> = [];
  const m = map as { get(k: string, keep: true): unknown };
  const scalar = (n: unknown) => {
    if (!isScalar(n) || typeof n.value !== 'string' || !n.range) return;
    const next = paths(n.value);
    if (next === n.value) return;
    if (n.type !== 'PLAIN' && n.type !== 'QUOTE_DOUBLE' && n.type !== 'QUOTE_SINGLE') throw new Error(`path scalar style ${n.type} not handled`);
    out.push({ at: n.range[0], end: n.range[1], text: n.type === 'PLAIN' ? next : JSON.stringify(next) });
  };
  const prov = m.get('provenance', true) as { get?(k: string, keep: true): unknown } | undefined;
  const vals = prov && isMap(prov) ? prov.get('values', true) : undefined;
  if (isMap(vals)) for (const p of vals.items) scalar(p.key);
  for (const k of ['assumptions', 'missing']) {
    const seq = m.get(k, true) as { items?: unknown[] } | undefined;
    for (const e of seq?.items ?? []) {
      if (!isMap(e)) continue;
      if (k === 'missing') scalar(e.get('path', true));
      else { const ps = e.get('paths', true) as { items?: unknown[] } | undefined; for (const x of ps?.items ?? []) scalar(x); }
    }
  }
  return out;
}

/** The spec data with the same path rewrites applied (for the verification). */
function rewritePaths(x: O, paths: (p: string) => string): O {
  const y = structuredClone(x);
  const prov = isObj(y.provenance) && isObj(y.provenance.values) ? y.provenance.values : null;
  if (prov) (y.provenance as O).values = Object.fromEntries(Object.entries(prov).map(([k, v]) => [paths(k), v]));
  if (Array.isArray(y.assumptions)) for (const a of y.assumptions) if (isObj(a) && Array.isArray(a.paths)) a.paths = a.paths.map((q) => (typeof q === 'string' ? paths(q) : q));
  if (Array.isArray(y.missing)) for (const a of y.missing) if (isObj(a) && typeof a.path === 'string') a.path = paths(a.path);
  return y;
}

function verify(before: string, after: string, specPath: string[], block: O, paths: (p: string) => string, reg: Registry): string[] {
  const bad: string[] = [];
  const pick = (t: string) => { const d = parseStrict(t).toJS() as O; return (specPath.length ? d[specPath[0]!] : d) as O; };
  const a = pick(before), b = pick(after);
  const rest = (x: O) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'results'));
  if (canonicalJson(rest(rewritePaths(a, paths))) !== canonicalJson(rest(b))) bad.push('spec outside results changed (beyond the rewritten paths)');
  if (canonicalJson(b.results) !== canonicalJson(block)) bad.push('new results block does not parse to the intended object');
  if (specPath.length) {
    const da = parseStrict(before).toJS() as O, db = parseStrict(after).toJS() as O;
    if (canonicalJson({ ...da, [specPath[0]!]: null }) !== canonicalJson({ ...db, [specPath[0]!]: null })) bad.push('eval case outside spec changed');
  }
  const ca = commentLines(before), cb = commentLines(after);
  if (ca.join('\n') !== cb.join('\n')) bad.push(`comment lines changed (${ca.length} -> ${cb.length})`);
  const specText = specPath.length ? JSON.stringify(b) : after;
  const v = parseSpecText(specText, reg);
  if (!v.ok) bad.push(`does not validate:\n${formatIssues(v.issues)}`);
  return bad;
}

/** Line diff of the changed region (first and last differing lines). */
function diff(a: string, b: string): string {
  const A = a.split('\n'), B = b.split('\n');
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return [...A.slice(p, A.length - s).map((l) => `- ${l}`), ...B.slice(p, B.length - s).map((l) => `+ ${l}`)].join('\n');
}

const reg = await fullRegistry();
const files: Array<{ rel: string; specPath: string[] }> = [];
for (const f of readdirSync(new URL('sims/', ROOT)).filter((f) => f.endsWith('.yaml')).sort()) files.push({ rel: `sims/${f}`, specPath: [] });
for (const f of readdirSync(new URL('packages/spec/test/fixtures/', ROOT)).filter((f) => f.endsWith('.yaml')).sort()) files.push({ rel: `packages/spec/test/fixtures/${f}`, specPath: [] });
let embedded = 0, evalFiles = 0;
for (const cls of ['a', 'b', 'c']) {
  const dir = new URL(`eval/cases/${cls}/`, ROOT);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    evalFiles++;
    const d = parseStrict(readFileSync(new URL(f, dir), 'utf8')).toJS() as O;
    if (isObj(d.spec) && d.spec.schema === 'amp-spec/0') { embedded++; files.push({ rel: `eval/cases/${cls}/${f}`, specPath: ['spec'] }); }
  }
}
say(`${isoNow()} R0 results migration (${WRITE ? 'write' : 'dry run'}); files: ${files.length - embedded} specs + ${embedded} eval cases with an embedded spec (of ${evalFiles} eval case files)`);
let migrated = 0, skipped = 0, failed = 0, nodes = 0, paths = 0;
const counts: Record<string, number> = {};
for (const { rel, specPath } of files) {
  const url = new URL(rel, ROOT);
  const text = readFileSync(url, 'utf8');
  let r;
  try { r = migrateText(text, specPath); } catch (e) { failed++; say(`FAIL ${rel}: ${(e as Error).message}`); continue; }
  if (!r) { skipped++; say(`skip ${rel}: no legacy results list`); continue; }
  const bad = verify(text, r.text, specPath, r.block, r.paths, reg);
  if (bad.length) { failed++; say(`FAIL ${rel}: ${bad.join('; ')}`); continue; }
  migrated++; nodes += r.legacy;
  for (const sec of ['datasets', 'evaluations', 'tables', 'plots']) {
    for (const n of (r.block[sec] as O[] | undefined) ?? []) {
      const k = `${sec}:${String(n.type ?? (sec === 'tables' ? 'table' : 'group'))}`;
      counts[k] = (counts[k] ?? 0) + 1;
      for (const it of (n.items as O[] | undefined) ?? []) counts[`${sec}.items:${String(it.type)}`] = (counts[`${sec}.items:${String(it.type)}`] ?? 0) + 1;
    }
  }
  paths += r.rewritten;
  say(`ok   ${rel}: ${r.legacy} legacy nodes${r.rewritten ? `, ${r.rewritten} path(s) into results rewritten` : ''}${WRITE ? ', written' : ''}`);
  if (!WRITE) say(diff(text, r.text).split('\n').map((l) => `     ${l}`).join('\n'));
  if (WRITE) writeFileSync(url, r.text);
}
say(`${isoNow()} migrated ${migrated}, skipped ${skipped}, failed ${failed}; legacy nodes ${nodes}; paths rewritten ${paths}; new nodes ${JSON.stringify(counts)}`);
writeFileSync(logPath, lines.join('\n') + '\n');
console.log(`log: logs/R0-migrate-results-${stamp}.log`);
process.exitCode = failed ? 1 : 0;
