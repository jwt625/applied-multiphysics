// Ported from eo-modulator-atlas/engine/src/yaml-edit.mjs at 5a06dfd (GPL-3.0-or-later). Changes: (1) sequence
// splices: insertIn (block and flow) and sequence-item deletion; (2) setIn replaces a block collection by a flow value
// in place instead of reprinting the document; (3) a key added to a block map that starts on a `- ` line (sequence
// item) is indented under the item; (4) deleteIn option {prune} (default true = original behaviour; false keeps an
// emptied map/sequence as {} / [] for RFC 6902 semantics); (5) parse rejects anchors and aliases (an edit by path
// must change exactly one value), as are custom tags and the keys __proto__/constructor/prototype; (6) exported
// parseStrict and disallowed; (7) JSDoc types; (8) splice/fallback counters (stats); (9) -0 is written as 0.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// YAML round-trip helpers for form editing (EO DevLog-023 D6, L-UI requests DevLog-027): edits are source splices,
// so the rest of the text (comments, key order, number spellings such as 4.1e7, flow spacing, sequence indentation)
// is kept byte for byte. Every splice is verified by re-parsing; when a splice is not possible or does not reproduce
// the intended data, the helpers fall back to the yaml Document printer (PRINT options).

import { parseDocument, isMap, isSeq, isScalar, isPair, isAlias, visit } from 'yaml';

export { parseDocument as parseYamlDocument };

/** Counters: verified source splices vs document-printer fallbacks (for gates and diagnostics). */
export const stats = { splice: 0, fallback: 0 };

/** Fallback printer options: no line folding, flow collections without inner padding (`{a: 1}`). */
export const PRINT = Object.freeze({ lineWidth: 0, flowCollectionPadding: false });

/** Mapping keys that reach Object.prototype machinery (audit S3). */
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Why a node is not allowed in amp YAML (aliases, anchors, custom tags, forbidden keys), or null. */
export function disallowed(n) {
  if (isAlias(n)) return 'aliases are not allowed';
  if (n.anchor) return 'anchors are not allowed';
  if (n.tag && !String(n.tag).startsWith('tag:yaml.org,2002:')) return `tag ${n.tag} is not allowed`;
  if (isPair(n) && isScalar(n.key) && FORBIDDEN_KEYS.has(String(n.key.value))) return `key '${n.key.value}' is not allowed`;
  return null;
}

/** Parse with duplicate keys, anchors, aliases, custom tags and forbidden keys rejected. Throws Error('YAML: ...'). */
export function parseStrict(text) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`YAML: ${doc.errors.map((e) => e.message).join('; ')}`);
  let bad = null;
  visit(doc, {
    Node(_, n) { bad = disallowed(n); return bad ? visit.BREAK : undefined; },
    Pair(_, n) { bad = disallowed(n); return bad ? visit.BREAK : undefined; },
  });
  if (bad) throw new Error(`YAML: ${bad}`);
  return doc;
}
const parse = parseStrict;

/** Dotted path to keys; numeric segments index sequences (`geometry.regions.0.name`). Arrays pass through. */
export function splitPath(path) {
  if (Array.isArray(path)) return path;
  return String(path).split('.').filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** Plain JS value at a path (undefined when absent). */
export function getIn(text, path) {
  const v = parse(text).getIn(splitPath(path), false);
  return v && typeof v === 'object' && typeof v.toJSON === 'function' ? v.toJSON() : v;
}

// ---- value formatting (flow style, as the sims configs are written) --------------------------------------------
const RESERVED = /^(true|false|null|yes|no|on|off|~|y|n)$/i;
const PLAIN = /^[A-Za-z_][A-Za-z0-9_ ./()+-]*$/;
/** @param {unknown} v @returns {string} */
export function fmt(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite numbers are not written');
    return String(v); // -0 prints as 0 (canonical JSON and spec hash treat them as equal)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return PLAIN.test(v) && !RESERVED.test(v) && !/\s$/.test(v) && !/:\s|\s#/.test(v) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  if (typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${fmtKey(k)}: ${fmt(x)}`).join(', ')}}`;
  throw new Error(`cannot write a ${typeof v}`);
}
const fmtKey = (k) => (typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) && !RESERVED.test(k) ? k : JSON.stringify(String(k)));

// ---- plain-data helpers for verification ------------------------------------------------------------------------
const clone = (x) => (x === undefined ? undefined : structuredClone(x));
function setPlain(obj, path, value) {
  if (!path.length) return clone(value);
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (o[k] === undefined || o[k] === null || typeof o[k] !== 'object') o[k] = typeof path[i + 1] === 'number' ? [] : {};
    o = o[k];
  }
  o[path.at(-1)] = clone(value);
  return obj;
}
function deletePlain(obj, path) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) { o = o?.[path[i]]; if (o == null) return obj; }
  if (Array.isArray(o)) o.splice(path.at(-1), 1); else if (o) delete o[path.at(-1)];
  return obj;
}
function insertPlain(obj, path, index, value) {
  let o = obj;
  for (const k of path) o = o?.[k];
  if (!Array.isArray(o)) throw new Error('insertIn: target is not a sequence');
  o.splice(index, 0, clone(value));
  return obj;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Walk a path; returns {node, parent, pair, depth} of the deepest existing node. */
function locate(doc, path) {
  let node = doc.contents, parent = null, pair = null;
  for (let i = 0; i < path.length; i++) {
    const k = path[i];
    if (isMap(node)) {
      const p = node.items.find((q) => isPair(q) && (isScalar(q.key) ? q.key.value : q.key) === k);
      if (!p) return { node, parent, pair, depth: i, missing: true };
      parent = node; pair = p; node = p.value;
    } else if (isSeq(node) && typeof k === 'number' && k < node.items.length) {
      parent = node; pair = null; node = node.items[k];
    } else return { node, parent, pair, depth: i, missing: true, blocked: true };
  }
  return { node, parent, pair, depth: path.length, missing: false };
}
const lineStart = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (text, pos) => { const i = text.indexOf('\n', pos); return i < 0 ? text.length : i; };
const nest = (keys, value) => keys.reduceRight((v, k) => ({ [k]: v }), value);
/** End of a node's value without trailing whitespace/newlines (block collections include them in range[1]). */
const valueEnd = (text, n) => { let e = n.range[1]; while (e > n.range[0] && /\s/.test(text[e - 1])) e--; return e; };
/** Indentation for a new line aligned with `pos`; `- ` sequence markers before it count as spaces. */
function indentAt(text, pos) {
  const pre = text.slice(lineStart(text, pos), pos);
  if (!/\S/.test(pre)) return pre;
  if (/^\s*-\s+$/.test(pre)) return ' '.repeat(pre.length);
  return null;
}
/** Start of the `- ` marker line of a block sequence item (null when the marker is not alone at line start). */
function dashLine(text, item) {
  const s = lineStart(text, item.range[0]);
  const pre = text.slice(s, item.range[0]);
  const m = /^(\s*)-(\s+|$)/.exec(pre);
  if (!m || m[0].length !== pre.length) return null;
  return { start: s, indent: m[1] };
}

function spliceSet(text, doc, path, value) {
  const loc = locate(doc, path);
  if (!loc.missing) {
    const n = loc.node;
    if (!n || !n.range) return null;
    const scalarValue = value === null || ['number', 'string', 'boolean'].includes(typeof value);
    if (isScalar(n) && scalarValue) {
      const quoted = n.type === 'QUOTE_DOUBLE' || n.type === 'QUOTE_SINGLE';
      const out = typeof value === 'string' && quoted ? JSON.stringify(value) : fmt(value);
      return text.slice(0, n.range[0]) + out + text.slice(n.range[1]);
    }
    if (n.flow || isScalar(n)) return text.slice(0, n.range[0]) + fmt(value) + text.slice(n.range[1]);
    // block collection: replace it by a flow value in place (comments inside the replaced value go with it)
    return text.slice(0, n.range[0]) + fmt(value) + text.slice(valueEnd(text, n));
  }
  if (loc.blocked) return null;
  const parent = loc.node; // the map that lacks path[depth]
  const key = path[loc.depth];
  if (!isMap(parent) || typeof key !== 'string') return null;
  const entry = `${fmtKey(key)}: ${fmt(nest(path.slice(loc.depth + 1), value))}`;
  if (parent.flow) {
    const close = parent.range[1] - 1;
    if (text[close] !== '}') return null;
    if (!parent.items.length) return text.slice(0, close) + entry + text.slice(close);
    const last = parent.items.at(-1);
    const end = (last.value ?? last.key).range[1];
    return text.slice(0, end) + `, ${entry}` + text.slice(end);
  }
  if (!parent.items.length || !parent.items[0].key?.range) return null;
  const indent = indentAt(text, parent.items[0].key.range[0]);
  if (indent == null) return null; // first key after other content on its line: fallback
  const last = parent.items.at(-1);
  const end = Math.max(last.value?.range ? valueEnd(text, last.value) : 0, last.key.range[1]);
  const at = lineEnd(text, Math.max(end - 1, 0)); // the newline ending the last entry's line, or the end of the text
  if (at < text.length) return text.slice(0, at + 1) + indent + entry + '\n' + text.slice(at + 1);
  return `${text}\n${indent}${entry}\n`;
}

function spliceDeletePair(text, parent, pair) {
  const i = parent.items.indexOf(pair);
  const vEnd = pair.value?.range ? valueEnd(text, pair.value) : pair.key.range[1];
  if (parent.flow) {
    if (parent.items.length === 1) return text.slice(0, pair.key.range[0]) + text.slice(vEnd);
    if (i < parent.items.length - 1) return text.slice(0, pair.key.range[0]) + text.slice(parent.items[i + 1].key.range[0]);
    const prev = parent.items[i - 1];
    const prevEnd = prev.value?.range ? prev.value.range[1] : prev.key.range[1];
    return text.slice(0, prevEnd) + text.slice(vEnd);
  }
  const s = lineStart(text, pair.key.range[0]);
  if (/\S/.test(text.slice(s, pair.key.range[0]))) return null;
  const e = lineEnd(text, Math.max(vEnd - 1, pair.key.range[1]));
  return text.slice(0, s) + text.slice(Math.min(e + 1, text.length));
}

function spliceDeleteItem(text, seq, k) {
  const item = seq.items[k];
  if (!item?.range) return null;
  if (seq.flow) {
    if (seq.items.length === 1) return text.slice(0, item.range[0]) + text.slice(item.range[1]);
    if (k < seq.items.length - 1) return text.slice(0, item.range[0]) + text.slice(seq.items[k + 1].range[0]);
    return text.slice(0, seq.items[k - 1].range[1]) + text.slice(item.range[1]);
  }
  const d = dashLine(text, item);
  if (!d) return null;
  const e = lineEnd(text, Math.max(valueEnd(text, item) - 1, item.range[0]));
  return text.slice(0, d.start) + text.slice(Math.min(e + 1, text.length));
}

function spliceInsert(text, seq, index, value) {
  if (!isSeq(seq) || !seq.range) return null;
  const n = seq.items.length;
  if (index < 0 || index > n) return null;
  if (seq.flow) {
    const close = seq.range[1] - 1;
    if (text[close] !== ']') return null;
    if (!n) return text.slice(0, close) + fmt(value) + text.slice(close);
    if (index < n) return text.slice(0, seq.items[index].range[0]) + `${fmt(value)}, ` + text.slice(seq.items[index].range[0]);
    const end = seq.items[n - 1].range[1];
    return text.slice(0, end) + `, ${fmt(value)}` + text.slice(end);
  }
  if (!n) return null;
  const ref = dashLine(text, seq.items[Math.min(index, n - 1)]);
  if (!ref) return null;
  const line = `${ref.indent}- ${fmt(value)}`;
  if (index < n) return text.slice(0, ref.start) + line + '\n' + text.slice(ref.start);
  const last = seq.items[n - 1];
  const at = lineEnd(text, Math.max(valueEnd(text, last) - 1, last.range[0]));
  if (at < text.length) return text.slice(0, at + 1) + line + '\n' + text.slice(at + 1);
  return `${text}\n${line}\n`;
}

function verified(candidate, expected) {
  if (candidate == null) return null;
  try { return same(parse(candidate).toJS(), expected) ? candidate : null; } catch { return null; }
}

/** New text with one value set; source splice when possible (verified), printer fallback otherwise. */
export function setIn(text, path, value) {
  const keys = splitPath(path);
  const doc = parse(text);
  const expected = setPlain(clone(doc.toJS()) ?? {}, keys, value);
  if (!keys.length) return verified(fmtDocument(value), expected) ?? docOf(value).toString(PRINT);
  const spliced = verified(spliceSet(text, doc, keys, value), expected);
  if (spliced != null) { stats.splice++; return spliced; }
  stats.fallback++;
  doc.setIn(keys, value);
  return doc.toString(PRINT);
}

const docOf = (value) => { const d = parseDocument('null'); d.contents = d.createNode(value); return d; };
const fmtDocument = (value) => docOf(value).toString(PRINT);

/**
 * New text with a path removed; source splice when possible (verified), printer fallback otherwise. With prune
 * (default) a map left empty by the deletion is removed too, up to the first non-empty ancestor (EO round-6 audit G9:
 * no `mode_select: {}` remains). With {prune: false} an emptied map or sequence stays as {} or [].
 */
export function deleteIn(text, path, { prune = true } = {}) {
  let keys = splitPath(path);
  const doc = parse(text);
  if (prune) {
    while (keys.length > 1) {
      const parent = doc.getIn(keys.slice(0, -1), true);
      if (!(isMap(parent) && parent.items.length === 1 && typeof keys.at(-2) === 'string')) break;
      keys = keys.slice(0, -1);
    }
  }
  const expected = deletePlain(clone(doc.toJS()), keys);
  const loc = locate(doc, keys);
  let candidate = null;
  if (!loc.missing && loc.parent) {
    const single = loc.parent.items.length === 1;
    if (single && !prune && !loc.parent.flow) candidate = spliceSet(text, doc, keys.slice(0, -1), isSeq(loc.parent) ? [] : {});
    else if (isMap(loc.parent) && loc.pair) candidate = spliceDeletePair(text, loc.parent, loc.pair);
    else if (isSeq(loc.parent)) candidate = spliceDeleteItem(text, loc.parent, keys.at(-1));
  }
  const spliced = verified(candidate, expected);
  if (spliced != null) { stats.splice++; return spliced; }
  stats.fallback++;
  doc.deleteIn(keys);
  return doc.toString(PRINT);
}

/** New text with value inserted into the sequence at `path` before `index` (index = length appends). */
export function insertIn(text, path, index, value) {
  const keys = splitPath(path);
  const doc = parse(text);
  const expected = insertPlain(clone(doc.toJS()), keys, index, value);
  const loc = locate(doc, keys);
  const spliced = loc.missing ? null : verified(spliceInsert(text, loc.node, index, value), expected);
  if (spliced != null) { stats.splice++; return spliced; }
  stats.fallback++;
  const seq = keys.length ? doc.getIn(keys, true) : doc.contents;
  if (!isSeq(seq)) throw new Error('insertIn: target is not a sequence');
  seq.items.splice(index, 0, doc.createNode(value));
  return doc.toString(PRINT);
}

/** Apply several [path, value] overrides in order. */
export function applyOverrides(text, overrides) {
  let out = text;
  for (const [p, v] of overrides ?? []) out = setIn(out, p, v);
  return out;
}
