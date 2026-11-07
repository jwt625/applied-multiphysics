// SPDX-License-Identifier: GPL-3.0-or-later
// YAML text <-> typed spec (DevLog-003 s.1.3). YAML is the canonical text; parse errors and schema issues come back
// with key paths, JSON Pointers and 1-based line/column positions in the source.

import { parseDocument, LineCounter, isMap, isSeq, isScalar, isPair, visit, type Document } from 'yaml';
import { disallowed } from './yaml-edit.mjs';
import { validateSpec, issue, type SpecIssue, type ValidationResult } from './validate.ts';
import type { Registry, PathKey } from './registry.ts';

export interface ParseResult extends ValidationResult {
  /** Plain data parsed from the YAML (null on YAML syntax errors). */
  data: unknown;
  doc: Document.Parsed | null;
  /** Every string in a loaded model is untrusted for agent prompts (see untrusted.ts). */
  trust: 'untrusted';
}

/** Parse YAML (duplicate keys, anchors, aliases, custom tags and forbidden keys rejected) to plain data with positions. */
export function parseYaml(text: string): { data: unknown; doc: Document.Parsed | null; lc: LineCounter; issues: SpecIssue[] } {
  const lc = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: true, lineCounter: lc, prettyErrors: false });
  const issues: SpecIssue[] = [];
  for (const e of [...doc.errors, ...doc.warnings]) {
    const pos = lc.linePos(e.pos[0]);
    issues.push({ ...issue([], 'yaml', e.message.split('\n')[0] ?? e.message), line: pos.line, col: pos.col });
  }
  const flag = (n: unknown, range: number[] | undefined | null) => {
    const bad = disallowed(n);
    if (!bad) return;
    const pos = range ? lc.linePos(range[0] as number) : { line: 0, col: 0 };
    const why = /alias|anchor/.test(bad) ? ' (an edit by path must change exactly one value)' : '';
    issues.push({ ...issue([], 'yaml', `${bad}${why}`), line: pos.line, col: pos.col });
  };
  visit(doc, {
    Node(_, n) { flag(n, (n as { range?: number[] }).range); return undefined; },
    Pair(_, p) { flag(p, (p.key as { range?: number[] } | null)?.range); return undefined; },
  });
  if (issues.length) return { data: null, doc: null, lc, issues };
  return { data: doc.toJS({ maxAliasCount: 0 }), doc, lc, issues };
}

/** Source offset of the node at a path, or of the deepest existing ancestor; keys of unknown-key issues point at the key. */
export function offsetOf(doc: Document.Parsed, path: readonly PathKey[]): number | null {
  let node: unknown = doc.contents;
  let best: number | null = (node as { range?: number[] } | null)?.range?.[0] ?? null;
  if (!path.length) return best;
  const start = (n: unknown): number | undefined => (n as { range?: number[] } | null)?.range?.[0];
  for (let i = 0; i < path.length; i++) {
    const k = path[i];
    if (isMap(node)) {
      const p = node.items.find((q) => isPair(q) && (isScalar(q.key) ? q.key.value : q.key) === k);
      if (!p) break;
      best = (i === path.length - 1 ? start(p.key) : start(p.value) ?? start(p.key)) ?? best;
      node = p.value;
    } else if (isSeq(node) && typeof k === 'number' && node.items[k]) {
      node = node.items[k];
      best = start(node) ?? best;
    } else break;
  }
  return best;
}

/** Parse and validate a spec text against a registry. */
export function parseSpecText(text: string, reg: Registry): ParseResult {
  const y = parseYaml(text);
  if (!y.doc) return { ok: false, spec: null, issues: y.issues, params: new Map(), data: null, doc: null, trust: 'untrusted' };
  const v = validateSpec(y.data, reg);
  for (const i of v.issues) {
    const off = offsetOf(y.doc, i.path);
    if (off != null) { const p = y.lc.linePos(off); i.line = p.line; i.col = p.col; }
  }
  return { ...v, data: y.data, doc: y.doc, trust: 'untrusted' };
}

/** One line per issue: `<line>:<col> <dotted path>: <message>`. */
export function formatIssues(issues: readonly SpecIssue[]): string {
  return issues.map((i) => `${i.line ? `${i.line}:${i.col} ` : ''}${i.dotted || '(root)'}: ${i.message}`).join('\n');
}
