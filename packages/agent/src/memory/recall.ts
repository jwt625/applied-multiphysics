// SPDX-License-Identifier: GPL-3.0-or-later
// Recall: choose the memory entries relevant to a request by their description (Claude Code pattern: an index of
// descriptions is always in context, topic files are pulled in when relevant; R5 s.3.4). Deterministic lexical score,
// no embeddings, no model call:
//   score = 2 * |query terms in description| + 1.5 * |query terms in name| + 3 if applies_when meets the spec's
//           physics types (entries with an applies_when that does not meet them are dropped when the spec has physics)
// Ties break by name. The reasons for each pick are returned, so the prompt inspector can show why it was included.

import type { MemoryEntry } from './frontmatter.ts';

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'what', 'when', 'make', 'use', 'set', 'please', 'are', 'was', 'its', 'all', 'any', 'can', 'you', 'our', 'then', 'than', 'have', 'has']);

export function terms(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return out;
}

export interface Recalled { entry: MemoryEntry & { file: string }; score: number; why: string[] }

export function recall(entries: ReadonlyArray<MemoryEntry & { file: string }>, ctx: { query: string; physicsTypes?: readonly string[] }, limit = 5): Recalled[] {
  const q = terms(ctx.query);
  const phys = new Set(ctx.physicsTypes ?? []);
  const out: Recalled[] = [];
  for (const e of entries) {
    const why: string[] = [];
    let score = 0;
    if (e.appliesWhen.length && phys.size) {
      const hit = e.appliesWhen.filter((p) => phys.has(p));
      if (!hit.length) continue;
      score += 3; why.push(`applies_when ${hit.join(',')}`);
    }
    const d = [...terms(e.description)].filter((t) => q.has(t));
    const n = [...terms(e.name.replace(/-/g, ' '))].filter((t) => q.has(t));
    if (d.length) { score += 2 * d.length; why.push(`description: ${d.join(',')}`); }
    if (n.length) { score += 1.5 * n.length; why.push(`name: ${n.join(',')}`); }
    if (d.length || n.length) out.push({ entry: e, score, why });
  }
  return out.sort((a, b) => b.score - a.score || (a.entry.name < b.entry.name ? -1 : 1)).slice(0, limit);
}
