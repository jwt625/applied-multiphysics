// SPDX-License-Identifier: GPL-3.0-or-later
// Invalidation rules (C7 `invalidates`, DevLog-003 s.1.4): which derived artifacts an edit makes stale. Artifacts
// form a chain geometry -> mesh -> solution -> plots; a change invalidates its own stage and everything after it.
// Param edits are traced through expression references (transitively through other params) to the sections that
// use them, so an edit to an unused param invalidates nothing.

import { parsePointer, type JsonPatchOp } from './patch.ts';
import { quantityRefs } from './quantity.ts';

export type Artifact = 'geometry' | 'mesh' | 'solution' | 'plots';
export const ARTIFACTS: readonly Artifact[] = ['geometry', 'mesh', 'solution', 'plots'];

const FROM: Record<Artifact, Artifact[]> = {
  geometry: ['geometry', 'mesh', 'solution', 'plots'],
  mesh: ['mesh', 'solution', 'plots'],
  solution: ['solution', 'plots'],
  plots: ['plots'],
};

/** First stage invalidated by an edit under each top-level key (null: metadata only). */
export const SECTION_STAGE: Record<string, Artifact | null> = {
  schema: 'geometry',
  geometry: 'geometry',
  mesh: 'mesh',
  materials: 'solution',
  physics: 'solution',
  couplings: 'solution',
  studies: 'solution',
  results: 'plots',
  id: null, title: null, description: null, provenance: null, assumptions: null, missing: null,
};

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Names of params referenced anywhere inside a value (expression strings and parametric sweep params). */
function refsIn(x: unknown, out: Set<string>): void {
  if (typeof x === 'string') { for (const r of quantityRefs(x)) out.add(r); return; }
  if (Array.isArray(x)) { for (const e of x) refsIn(e, out); return; }
  if (isObj(x)) {
    for (const [k, v] of Object.entries(x)) {
      if (k === 'param' && typeof v === 'string') out.add(v);
      refsIn(v, out);
    }
  }
}

/** Params whose value depends on any of `names` (including them), through param expressions. */
function dependents(params: Record<string, unknown>, names: Set<string>): Set<string> {
  const deps = new Map<string, Set<string>>();
  for (const [n, def] of Object.entries(params)) {
    const s = new Set<string>();
    refsIn(isObj(def) ? def.value : def, s);
    deps.set(n, s);
  }
  const out = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [n, s] of deps) if (!out.has(n) && [...s].some((r) => out.has(r))) { out.add(n); grew = true; }
  }
  return out;
}

function stagesForParams(spec: unknown, names: Set<string>, acc: Set<Artifact>): void {
  if (!isObj(spec)) return;
  const all = dependents(isObj(spec.params) ? spec.params : {}, names);
  for (const [section, stage] of Object.entries(SECTION_STAGE)) {
    if (!stage || section === 'schema') continue;
    const refs = new Set<string>();
    refsIn(spec[section], refs);
    if ([...refs].some((r) => all.has(r))) for (const a of FROM[stage]) acc.add(a);
  }
}

/** Artifacts invalidated by a patch, given the spec before and after it. */
export function invalidationsFor(patch: readonly JsonPatchOp[], before: unknown, after: unknown): Artifact[] {
  const acc = new Set<Artifact>();
  const touchedParams = new Set<string>();
  for (const op of patch) {
    if (op.op === 'test') continue;
    const paths = op.op === 'move' || op.op === 'copy' ? [op.from, op.path] : [op.path];
    if (op.op === 'copy') paths.shift(); // copy does not change its source
    for (const p of paths) {
      const t = parsePointer(p);
      if (!t.length) { for (const a of ARTIFACTS) acc.add(a); continue; }
      const top = t[0] as string;
      if (top === 'params') {
        if (t.length === 1) {
          const names = new Set([...Object.keys(isObj(before) && isObj(before.params) ? before.params : {}), ...Object.keys(isObj(after) && isObj(after.params) ? after.params : {})]);
          for (const n of names) touchedParams.add(n);
        } else touchedParams.add(t[1] as string);
        continue;
      }
      const stage = Object.hasOwn(SECTION_STAGE, top) ? SECTION_STAGE[top] : 'geometry'; // unknown key: be conservative
      if (stage) for (const a of FROM[stage]) acc.add(a);
    }
  }
  if (touchedParams.size) { stagesForParams(before, touchedParams, acc); stagesForParams(after, touchedParams, acc); }
  return ARTIFACTS.filter((a) => acc.has(a));
}
