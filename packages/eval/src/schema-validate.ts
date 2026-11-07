// SPDX-License-Identifier: GPL-3.0-or-later
// Dependency-free validator for the JSON Schema 2020-12 keywords used by eval/schema/*.json.
// Errors carry a JSON pointer (RFC 6901) to the offending value. Unsupported keywords throw at compile time,
// so the schema cannot silently use a keyword this validator ignores.

export interface SchemaError {
  path: string;          // JSON pointer into the instance, '' = root
  keyword: string;       // schema keyword that failed
  message: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Schema = boolean | { [k: string]: unknown };

const SUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', '$comment', 'default', 'examples',
  'type', 'enum', 'const', 'required', 'properties', 'patternProperties', 'additionalProperties',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
]);

export function pointerEscape(seg: string | number): string {
  return String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function pointerParse(ptr: string): string[] {
  if (ptr === '') return [];
  return ptr.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    default: throw new Error(`schema: unknown type '${t}'`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function fmt(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + '...' : s;
}

export class Validator {
  private root: Schema;
  private reCache = new Map<string, RegExp>();

  constructor(root: Schema) {
    this.root = root;
    this.checkKeywords(root, '#');
  }

  private checkKeywords(s: unknown, at: string): void {
    if (typeof s === 'boolean' || s === null || typeof s !== 'object') return;
    for (const k of Object.keys(s as object)) {
      if (!SUPPORTED.has(k)) throw new Error(`schema: unsupported keyword '${k}' at ${at}`);
    }
    const o = s as Record<string, unknown>;
    for (const k of ['properties', 'patternProperties', '$defs']) {
      const m = o[k];
      if (m && typeof m === 'object') for (const [n, sub] of Object.entries(m)) this.checkKeywords(sub, `${at}/${k}/${n}`);
    }
    for (const k of ['additionalProperties', 'items', 'not', 'if', 'then', 'else']) if (k in o) this.checkKeywords(o[k], `${at}/${k}`);
    for (const k of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      const arr = o[k];
      if (Array.isArray(arr)) arr.forEach((sub, i) => this.checkKeywords(sub, `${at}/${k}/${i}`));
    }
  }

  private re(p: string): RegExp {
    let r = this.reCache.get(p);
    if (!r) { r = new RegExp(p, 'u'); this.reCache.set(p, r); }
    return r;
  }

  private resolve(ref: string): Schema {
    if (!ref.startsWith('#')) throw new Error(`schema: only local $ref supported, got ${ref}`);
    let cur: unknown = this.root;
    for (const seg of pointerParse(ref.slice(1))) {
      if (cur === null || typeof cur !== 'object') throw new Error(`schema: bad $ref ${ref}`);
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur === undefined) throw new Error(`schema: unresolved $ref ${ref}`);
    return cur as Schema;
  }

  validate(instance: unknown): SchemaError[] {
    const errs: SchemaError[] = [];
    this.v(instance, this.root, '', errs);
    return errs;
  }

  private v(x: unknown, s: Schema, path: string, errs: SchemaError[]): void {
    if (s === true) return;
    if (s === false) { errs.push({ path, keyword: 'false', message: 'value not allowed here' }); return; }
    const o = s as Record<string, unknown>;

    if (typeof o.$ref === 'string') this.v(x, this.resolve(o.$ref), path, errs);

    if (o.type !== undefined) {
      const ts = Array.isArray(o.type) ? (o.type as string[]) : [o.type as string];
      if (!ts.some((t) => matchesType(x, t))) {
        const got = typeof x === 'number' && !Number.isFinite(x) ? `non-finite number ${String(x)}` : typeOf(x);
        errs.push({ path, keyword: 'type', message: `expected ${ts.join(' | ')}, got ${got}` });
        return; // further keywords would only add noise
      }
    }
    if (o.const !== undefined && !deepEqual(x, o.const)) {
      errs.push({ path, keyword: 'const', message: `must equal ${fmt(o.const)}, got ${fmt(x)}` });
    }
    if (Array.isArray(o.enum) && !o.enum.some((e) => deepEqual(e, x))) {
      errs.push({ path, keyword: 'enum', message: `must be one of ${o.enum.map(fmt).join(', ')}; got ${fmt(x)}` });
    }

    if (typeof x === 'string') {
      if (typeof o.minLength === 'number' && x.length < o.minLength) errs.push({ path, keyword: 'minLength', message: `shorter than ${o.minLength}` });
      if (typeof o.maxLength === 'number' && x.length > o.maxLength) errs.push({ path, keyword: 'maxLength', message: `longer than ${o.maxLength}` });
      if (typeof o.pattern === 'string' && !this.re(o.pattern).test(x)) errs.push({ path, keyword: 'pattern', message: `${fmt(x)} does not match /${o.pattern}/` });
      if (o.format === 'date' && !isIsoDate(x)) errs.push({ path, keyword: 'format', message: `${fmt(x)} is not an ISO date YYYY-MM-DD` });
    }
    if (typeof x === 'number') {
      if (typeof o.minimum === 'number' && x < o.minimum) errs.push({ path, keyword: 'minimum', message: `${x} < ${o.minimum}` });
      if (typeof o.maximum === 'number' && x > o.maximum) errs.push({ path, keyword: 'maximum', message: `${x} > ${o.maximum}` });
      if (typeof o.exclusiveMinimum === 'number' && x <= o.exclusiveMinimum) errs.push({ path, keyword: 'exclusiveMinimum', message: `${x} <= ${o.exclusiveMinimum}` });
      if (typeof o.exclusiveMaximum === 'number' && x >= o.exclusiveMaximum) errs.push({ path, keyword: 'exclusiveMaximum', message: `${x} >= ${o.exclusiveMaximum}` });
    }
    if (Array.isArray(x)) {
      if (typeof o.minItems === 'number' && x.length < o.minItems) errs.push({ path, keyword: 'minItems', message: `has ${x.length} items, needs >= ${o.minItems}` });
      if (typeof o.maxItems === 'number' && x.length > o.maxItems) errs.push({ path, keyword: 'maxItems', message: `has ${x.length} items, allows <= ${o.maxItems}` });
      if (o.uniqueItems === true) {
        for (let i = 0; i < x.length; i++) for (let j = 0; j < i; j++) {
          if (deepEqual(x[i], x[j])) errs.push({ path: `${path}/${i}`, keyword: 'uniqueItems', message: `duplicate of item ${j}` });
        }
      }
      const pre = Array.isArray(o.prefixItems) ? (o.prefixItems as Schema[]) : [];
      pre.forEach((ps, i) => { if (i < x.length) this.v(x[i], ps, `${path}/${i}`, errs); });
      if (o.items !== undefined) for (let i = pre.length; i < x.length; i++) this.v(x[i], o.items as Schema, `${path}/${i}`, errs);
    }
    if (typeof x === 'object' && x !== null && !Array.isArray(x)) {
      const obj = x as Record<string, unknown>;
      if (Array.isArray(o.required)) for (const r of o.required as string[]) {
        if (!(r in obj)) errs.push({ path, keyword: 'required', message: `missing required key '${r}'` });
      }
      const props = (o.properties ?? {}) as Record<string, Schema>;
      const pats = (o.patternProperties ?? {}) as Record<string, Schema>;
      for (const [k, val] of Object.entries(obj)) {
        const p = `${path}/${pointerEscape(k)}`;
        let known = false;
        if (k in props) { known = true; this.v(val, props[k] as Schema, p, errs); }
        for (const [pat, ps] of Object.entries(pats)) if (this.re(pat).test(k)) { known = true; this.v(val, ps, p, errs); }
        if (!known && o.additionalProperties !== undefined) {
          if (o.additionalProperties === false) errs.push({ path: p, keyword: 'additionalProperties', message: `unknown key '${k}'` });
          else this.v(val, o.additionalProperties as Schema, p, errs);
        }
      }
    }

    if (Array.isArray(o.allOf)) for (const sub of o.allOf as Schema[]) this.v(x, sub, path, errs);
    if (Array.isArray(o.anyOf)) {
      const branches = (o.anyOf as Schema[]).map((sub) => { const e: SchemaError[] = []; this.v(x, sub, path, e); return e; });
      if (!branches.some((e) => e.length === 0)) errs.push(...this.bestBranch(branches, path, 'anyOf'));
    }
    if (Array.isArray(o.oneOf)) {
      const branches = (o.oneOf as Schema[]).map((sub) => { const e: SchemaError[] = []; this.v(x, sub, path, e); return e; });
      const ok = branches.filter((e) => e.length === 0).length;
      if (ok === 0) errs.push(...this.bestBranch(branches, path, 'oneOf'));
      else if (ok > 1) errs.push({ path, keyword: 'oneOf', message: `matches ${ok} alternatives, expected exactly 1` });
    }
    if (o.not !== undefined) {
      const e: SchemaError[] = [];
      this.v(x, o.not as Schema, path, e);
      if (e.length === 0) errs.push({ path, keyword: 'not', message: 'matches a forbidden schema' });
    }
    if (o.if !== undefined) {
      const e: SchemaError[] = [];
      this.v(x, o.if as Schema, path, e);
      if (e.length === 0) { if (o.then !== undefined) this.v(x, o.then as Schema, path, errs); }
      else if (o.else !== undefined) this.v(x, o.else as Schema, path, errs);
    }
  }

  // For a failed anyOf/oneOf: report the branch that got furthest (deepest error path, then fewest errors);
  // when no branch gets past the value itself, report one summary error listing the alternatives.
  private bestBranch(branches: SchemaError[][], path: string, kw: string): SchemaError[] {
    const depth = (e: SchemaError[]) => Math.max(...e.map((x) => x.path.length));
    const sorted = [...branches].sort((a, b) => depth(b) - depth(a) || a.length - b.length);
    const best = sorted[0] ?? [];
    if (depth(best) > path.length) return best;
    const msgs = branches.map((b) => b.map((e) => e.message).join('; '));
    return [{ path, keyword: kw, message: `no alternative matches: ${msgs.map((m, i) => `(${i + 1}) ${m}`).join(' | ')}` }];
  }
}

export type { Json };
