// SPDX-License-Identifier: GPL-3.0-or-later
// Selections against a built geometry (C2 EntityTable). The spec validator checks only that the feature of each
// entity id exists; once the geometry is built, these helpers resolve ids to entity indices and report ids that the
// geometry does not have. A parent id selects all its split parts (`dom:a` -> `dom:a#0`, `dom:a#1`, ...).

import { parseEntityId, type EntityKind } from './ids.ts';
import type { EntityRef, EntityTable } from './types/mesh.ts';
import type { Spec } from './schema.ts';
import { issue, type SpecIssue } from './validate.ts';
import type { PathKey } from './registry.ts';

const TABLE: Record<EntityKind, keyof EntityTable> = { dom: 'domains', bnd: 'boundaries', edg: 'edges', pnt: 'points' };

/** Indices into the entity list of each id's kind; unknown ids are returned separately. */
export function resolveSelection(ids: readonly string[], table: EntityTable): { kind: EntityKind | null; indices: number[]; unknown: string[] } {
  const indices = new Set<number>();
  const unknown: string[] = [];
  let kind: EntityKind | null = null;
  for (const id of ids) {
    const p = parseEntityId(id);
    if (!p) { unknown.push(id); continue; }
    kind ??= p.kind;
    const list = (table[TABLE[p.kind]] ?? []) as EntityRef[];
    let hit = false;
    list.forEach((e, i) => {
      if (e.id === id || (p.split === null && e.id.startsWith(`${id}#`)) || e.parent?.includes(id)) { indices.add(i); hit = true; }
    });
    if (!hit) unknown.push(id);
  }
  return { kind, indices: [...indices].sort((a, b) => a - b), unknown };
}

/** Every selection in the spec checked against a built entity table. */
export function checkSelections(spec: Spec, table: EntityTable): SpecIssue[] {
  const out: SpecIssue[] = [];
  const check = (sel: readonly string[] | undefined, path: PathKey[]) => {
    sel?.forEach((id, j) => {
      if (resolveSelection([id], table).unknown.length) out.push(issue([...path, j], 'unknown_entity', `geometry has no entity '${id}'`));
    });
  };
  spec.materials?.forEach((m, i) => check(m.select, ['materials', i, 'select']));
  spec.physics?.forEach((p, i) => {
    check(p.select, ['physics', i, 'select']);
    p.bcs?.forEach((b, j) => check(b.select, ['physics', i, 'bcs', j, 'select']));
  });
  spec.mesh?.refine?.forEach((r, i) => check(r.select, ['mesh', 'refine', i, 'select']));
  spec.results?.forEach((r, i) => check(r.select, ['results', i, 'select']));
  return out;
}
