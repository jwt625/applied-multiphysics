// SPDX-License-Identifier: GPL-3.0-or-later
// Untrusted-data boundary for prompts (DevLog-001 A11, R5 s.4.5, OWASP LLM01; L2 audit S5).
//
// Rule: every string that comes from a loaded spec, the operation log (including reasons written by other sessions),
// a run result, a memory file or an error message that may echo any of those, reaches the model only inside one
// nonce-delimited block made by @amp/spec `wrapUntrusted`. The trusted part of a tool result holds only values this
// package produces itself: numbers, booleans, fixed enums and fixed messages. The split is enforced by `toolText`,
// which refuses a trusted string that is not on a short safe pattern.
//
// Strings inside the block are JSON-encoded (quotes, newlines and control characters escaped), bidi/format controls
// are escaped as \u sequences, long strings are cut, and the marker prefix is neutralized by wrapUntrusted.

import { wrapUntrusted, validateSpec, type Registry } from '@amp/spec';

/** Unicode bidi / format controls that can visually reorder text in a UI or a prompt. */
import { FORMAT_CONTROLS } from './secrets.ts';

/** Make one untrusted string safe to embed as data: format controls escaped; cut only when `max` is finite. */
export function sanitizeText(s: string, max = Infinity, cut?: { n: number }): string {
  const t = s.replace(FORMAT_CONTROLS, (c) => `${String.fromCharCode(92)}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (t.length <= max) return t;
  if (cut) cut.n++;
  return `${t.slice(0, max)}...[${t.length - max} more chars]`;
}

/** Deep copy with every string (values and keys) sanitized. Typed arrays become a marker. */
export function sanitizeDeep(x: unknown, max = Infinity, depth = 0, cut: { n: number } = { n: 0 }): unknown {
  if (depth > 64) { cut.n++; return '[depth limit]'; }
  if (typeof x === 'string') return sanitizeText(x, max, cut);
  if (typeof x === 'number') return Number.isFinite(x) ? x : String(x);
  if (x === null || typeof x === 'boolean') return x;
  if (ArrayBuffer.isView(x)) return '[binary]';
  if (Array.isArray(x)) return x.map((e) => sanitizeDeep(e, max, depth + 1, cut));
  if (typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[sanitizeText(k, Math.min(max, 1000), cut)] = sanitizeDeep(v, max, depth + 1, cut);
    return out;
  }
  return undefined;
}

export interface BlockInfo { text: string; truncated: boolean; totalBytes: number }

const enc = new TextEncoder();

/** One untrusted block of minified JSON. Reports whether anything was cut and the full size (audit B2). */
export function untrustedBlockInfo(data: unknown, source: string, maxString = Infinity): BlockInfo {
  const cut = { n: 0 };
  const body = JSON.stringify(sanitizeDeep(data, maxString, 0, cut));
  const totalBytes = cut.n ? enc.encode(JSON.stringify(sanitizeDeep(data))).length : enc.encode(body).length;
  return { text: wrapUntrusted(body, source).text, truncated: cut.n > 0, totalBytes };
}

export function untrustedBlock(data: unknown, source: string, maxString = Infinity): string {
  return untrustedBlockInfo(data, source, maxString).text;
}

/** Trusted strings: identifiers, enums, fixed messages. No newlines, no markers, bounded. */
const SAFE_TRUSTED = /^[A-Za-z0-9 _.,:;()/@#+\-=<>%'[\]?!*]{0,400}$/;

export class TrustBoundaryError extends Error {}

function checkTrusted(x: unknown, at: string): void {
  if (typeof x === 'string') { if (!SAFE_TRUSTED.test(x) || x.includes('<<<') || x.includes('>>>')) throw new TrustBoundaryError(`trusted field ${at} holds a string outside the safe pattern`); return; }
  if (x === null || typeof x === 'number' || typeof x === 'boolean' || x === undefined) return;
  if (Array.isArray(x)) { x.forEach((e, i) => checkTrusted(e, `${at}[${i}]`)); return; }
  if (typeof x === 'object') { for (const [k, v] of Object.entries(x as Record<string, unknown>)) { checkTrusted(k, `${at} key`); checkTrusted(v, `${at}.${k}`); } return; }
  throw new TrustBoundaryError(`trusted field ${at}: unsupported type`);
}

/**
 * Tool result text: trusted JSON first, then (optionally) one untrusted block. Throws TrustBoundaryError when a trusted
 * field carries a free-form string; callers put such strings into `untrusted` instead.
 */
export function toolText(trusted: Record<string, unknown>, untrusted?: { data: unknown; source: string; maxString?: number }): string {
  checkTrusted(trusted, 'result');
  if (untrusted === undefined) return JSON.stringify(trusted);
  const blk = untrustedBlockInfo(untrusted.data, untrusted.source, untrusted.maxString);
  // never a silent cut: the trusted head says so, with the full size
  const head = blk.truncated ? { ...trusted, truncated: true, total_bytes: blk.totalBytes } : trusted;
  return `${JSON.stringify(head)}\n${blk.text}`;
}

/** Structured validation issue for the model (S5 fix 2); every field is spec-derived and goes into a block. */
export interface AgentIssue { code: string; pointer: string; message: string; line?: number }

/** Validation issues of the current spec data, structured (code, pointer, message). */
export function structuredIssues(data: unknown, registry: Registry, max = 50): { ok: boolean; count: number; issues: AgentIssue[] } {
  const v = validateSpec(data, registry);
  return {
    ok: v.ok,
    count: v.issues.length,
    issues: v.issues.slice(0, max).map((i) => ({ code: i.code, pointer: i.pointer, message: i.message, ...(i.line !== undefined ? { line: i.line } : {}) })),
  };
}

/** Remove every well-formed nonce block from a text (used by tests and checkers: what remains is trusted text). */
export function outsideBlocks(text: string): string {
  return text.replace(/<<<AMP-UNTRUSTED ([0-9a-f]{24}) source=[^>]*>>>[\s\S]*?<<<\/AMP-UNTRUSTED \1>>>/g, '');
}
