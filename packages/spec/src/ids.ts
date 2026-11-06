// SPDX-License-Identifier: GPL-3.0-or-later
// Identifier grammars of amp-spec/0 (CONTRACTS-v0 C2, C3).

/** Node ids (features, materials, physics, bcs, studies, results): letter or underscore first. */
export const NODE_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** Param names: usable inside expressions (no dots, no dashes). */
export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Entity kinds of C2: domains, boundaries (codimension 1), edges (3D), points. */
export const ENTITY_KINDS = ['dom', 'bnd', 'edg', 'pnt'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
/** Persistent entity id: `<kind>:<feature id>(.<sub-entity>)*(#<k>)?`, e.g. `bnd:rect1.top`, `dom:plate#1`. */
export const ENTITY_ID = /^(dom|bnd|edg|pnt):([A-Za-z_][A-Za-z0-9_-]{0,63})((?:\.[A-Za-z0-9_-]{1,64})*)(#\d{1,6})?$/;
/** Reference to a materials/ file id. */
export const MATERIAL_REF = /^materials\/[a-z0-9][a-z0-9._-]{0,127}$/;
/** ISO 8601 calendar date. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Dotted spec path: segments are keys, array indices or element ids. */
export const DOTTED_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export interface EntityIdParts { kind: EntityKind; feature: string; sub: string[]; split: number | null }

export function parseEntityId(id: string): EntityIdParts | null {
  const m = ENTITY_ID.exec(id);
  if (!m) return null;
  return {
    kind: m[1] as EntityKind,
    feature: m[2] as string,
    sub: m[3] ? m[3].slice(1).split('.') : [],
    split: m[4] ? Number(m[4].slice(1)) : null,
  };
}

/** Feature ids may not use the reserved split marker; actor ids follow C7. */
export const AGENT_ACTOR = /^agent:[A-Za-z0-9_.:-]{1,128}$/;
export type Actor = 'user' | `agent:${string}`;
export const isAgentActor = (a: string): boolean => a.startsWith('agent:');
export const isValidActor = (a: unknown): a is Actor => a === 'user' || (typeof a === 'string' && AGENT_ACTOR.test(a));
