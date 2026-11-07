// SPDX-License-Identifier: GPL-3.0-or-later
// Secret scan for tool inputs, memory writes and user chat text (audit M1). The key never enters model context by
// design; this is defense in depth for a key the user pasted into the chat or a model that got one anyway.
// Matching is done on normalized text (NFKC, format and zero-width controls removed, case-folded), on each string
// leaf, on all leaves joined (a key split across fields) with and without whitespace, and on base64-decoded leaves.
// The credential shape needs at least 20 characters after `sk-ant-`, so prose such as "keys look like sk-ant-xxxx"
// does not trip it.

/** Format and zero-width controls (soft hyphen, Mongolian vowel separator, zero-width, bidi, word joiner, BOM),
 * built from code points so the source stays ASCII. */
const FORMAT_RANGES: Array<[number, number]> = [[0xad, 0xad], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const BS = String.fromCharCode(92);
const esc = (c: number) => `${BS}u${c.toString(16).padStart(4, '0')}`;
export const FORMAT_CONTROLS = new RegExp(`[${FORMAT_RANGES.map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`)).join('')}]`, 'g');
const SHAPE = /sk-ant-[a-z0-9_-]{20,}/;
const B64 = /^[A-Za-z0-9+/_-]{24,}={0,2}$/;

export const normalizeForScan = (s: string): string => s.normalize('NFKC').replace(FORMAT_CONTROLS, '').toLowerCase();

function leaves(x: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 64) return out;
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const e of x) leaves(e, out, depth + 1);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x as Record<string, unknown>)) { out.push(k); leaves(v, out, depth + 1); }
  return out;
}

function b64(s: string): string | null {
  try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
}

/** True when the value carries a credential: the exact `forbidden` strings or an `sk-ant-` shaped token. */
export function containsSecret(x: unknown, forbidden: readonly string[] = []): boolean {
  const ls = leaves(x);
  const joined = ls.join('');
  const cands = [...ls, joined, joined.replace(/\s+/g, '')];
  for (const l of ls) if (B64.test(l)) { const d = b64(l); if (d) cands.push(d); }
  const keys = forbidden.filter((k) => !!k).map(normalizeForScan);
  return cands.some((c) => { const n = normalizeForScan(c); return SHAPE.test(n) || keys.some((k) => n.includes(k)); });
}

/** Replace credential-shaped tokens and the given secrets in a user's text (offered before sending). */
export function redactSecrets(text: string, forbidden: readonly string[] = []): string {
  let t = text.replace(FORMAT_CONTROLS, '');
  for (const k of forbidden) if (k) t = t.split(k).join('[redacted key]');
  return t.replace(/sk-ant-[A-Za-z0-9_-]{20,}/gi, '[redacted key]');
}
