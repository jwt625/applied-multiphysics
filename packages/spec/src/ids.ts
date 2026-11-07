// SPDX-License-Identifier: GPL-3.0-or-later
// Identifier grammars of amp-spec/0 (CONTRACTS-v0 C2, C3).

/** Keys that can reach Object.prototype machinery; rejected everywhere (YAML keys, patch tokens and values, ids). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const NOT_FORBIDDEN = '(?!(?:__proto__|constructor|prototype)$)';
const SEG_NOT_FORBIDDEN = '(?!(?:.*\\.)?(?:__proto__|constructor|prototype)(?:\\.|$))';

/** Node ids (features, materials, physics, bcs, studies, results): letter or underscore first. */
export const NODE_ID = new RegExp(`^${NOT_FORBIDDEN}[A-Za-z_][A-Za-z0-9_-]{0,63}$`);
/** Param names: usable inside expressions (no dots, no dashes). */
export const PARAM_NAME = new RegExp(`^${NOT_FORBIDDEN}[A-Za-z_][A-Za-z0-9_]{0,63}$`);
/** Entity kinds of C2: domains, boundaries (codimension 1), edges (3D), points. */
export const ENTITY_KINDS = ['dom', 'bnd', 'edg', 'pnt'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
/**
 * Persistent entity id: `<kind>:<feature id>(.<sub-entity>)*(#<k>)*`, e.g. `bnd:rect1.top`, `dom:plate#1`, and
 * pieces of pieces `dom:a#1#2` (L3 splits a split piece again; L3 audit S1). At most 8 split levels.
 */
export const ENTITY_ID = /^(dom|bnd|edg|pnt):([A-Za-z_][A-Za-z0-9_-]{0,63})((?:\.[A-Za-z0-9_-]{1,64})*)((?:#\d{1,6}){0,8})$/;
/** Reference to a materials/ file id. */
export const MATERIAL_REF = /^materials\/[a-z0-9][a-z0-9._-]{0,127}$/;
/** ISO 8601 calendar date. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Dotted spec path: segments are keys, array indices or element ids. */
export const DOTTED_PATH = new RegExp(`^${SEG_NOT_FORBIDDEN}[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$`);

/** First forbidden key found in a value (deep), as a path, or null. */
export function findForbiddenKey(x: unknown, at: Array<string | number> = []): Array<string | number> | null {
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) { const r = findForbiddenKey(x[i], [...at, i]); if (r) return r; }
  } else if (x && typeof x === 'object') {
    for (const k of Object.keys(x)) {
      if (FORBIDDEN_KEYS.has(k)) return [...at, k];
      const r = findForbiddenKey((x as Record<string, unknown>)[k], [...at, k]);
      if (r) return r;
    }
  }
  return null;
}

/** split: the `#k` piece numbers, outermost first (empty when the id names an unsplit entity). */
export interface EntityIdParts { kind: EntityKind; feature: string; sub: string[]; split: number[] }

export function parseEntityId(id: string): EntityIdParts | null {
  const m = ENTITY_ID.exec(id);
  if (!m) return null;
  return {
    kind: m[1] as EntityKind,
    feature: m[2] as string,
    sub: m[3] ? m[3].slice(1).split('.') : [],
    split: m[4] ? m[4].slice(1).split('#').map(Number) : [],
  };
}

/** True when `a` and `b` name the same entity or one is a split piece (at any depth) of the other. */
export const entityOverlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}#`) || b.startsWith(`${a}#`);

/** Actor ids follow C7. */
export const AGENT_ACTOR = /^agent:[A-Za-z0-9_.:-]{1,128}$/;
export type Actor = 'user' | `agent:${string}`;
export const isAgentActor = (a: string): boolean => a.startsWith('agent:');
export const isValidActor = (a: unknown): a is Actor => a === 'user' || (typeof a === 'string' && AGENT_ACTOR.test(a));
