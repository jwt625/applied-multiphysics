// SPDX-License-Identifier: GPL-3.0-or-later
// Selections against a built geometry (C2 EntityTable). The spec validates the entity-id grammar and that the feature
// of each id exists; it does not expand selections itself. Expansion (exact id, split pieces `id#k` at any depth,
// transitive closure over `parent`) has one canonical implementation, exported by @amp/geom (L3 audit S1). @amp/geom
// depends on @amp/spec, so the resolver is injected here rather than imported. Agreed name and signature: DevLog-003
// section 8 (`resolveEntityIds` in @amp/geom).

import { parseEntityId, type EntityKind } from './ids.ts';
import type { EntityTable } from './types/mesh.ts';
import type { Spec } from './schema.ts';
import { issue, type SpecIssue } from './validate.ts';
import type { PathKey } from './registry.ts';

export type EntityListName = 'domains' | 'boundaries' | 'edges' | 'points';
export const ENTITY_LIST: Record<EntityKind, EntityListName> = { dom: 'domains', bnd: 'boundaries', edg: 'edges', pnt: 'points' };

/** Canonical resolver contract (implemented by @amp/geom): indices into table[kind]; ids that match nothing in `unknown`. Never throws on unknown ids. */
export type EntityResolver = (table: EntityTable, kind: EntityListName, ids: readonly string[]) => { indices: number[]; unknown: string[] };

export interface BuiltGeometry { table: EntityTable; resolve: EntityResolver }

/** Every selection of the spec as [path, ids]. */
export function selectionsOf(spec: Spec): Array<{ path: PathKey[]; ids: string[] }> {
  const out: Array<{ path: PathKey[]; ids: string[] }> = [];
  spec.materials?.forEach((m, i) => out.push({ path: ['materials', i, 'select'], ids: m.select }));
  spec.physics?.forEach((p, i) => {
    out.push({ path: ['physics', i, 'select'], ids: p.select });
    p.bcs?.forEach((b, j) => out.push({ path: ['physics', i, 'bcs', j, 'select'], ids: b.select }));
  });
  spec.mesh?.refine?.forEach((r, i) => out.push({ path: ['mesh', 'refine', i, 'select'], ids: r.select }));
  spec.results?.forEach((r, i) => { if (r.select) out.push({ path: ['results', i, 'select'], ids: r.select }); });
  return out;
}

/**
 * Check every selection against a built geometry through the canonical resolver. Without a geometry, returns one
 * notice "selection not checked: geometry not built" (severity 'notice', not an error).
 */
export function checkSelections(spec: Spec, geometry?: BuiltGeometry | null): SpecIssue[] {
  if (!geometry) return [{ ...issue([], 'selection_unchecked', 'selection not checked: geometry not built'), severity: 'notice' }];
  const out: SpecIssue[] = [];
  for (const { path, ids } of selectionsOf(spec)) {
    ids.forEach((id, j) => {
      const p = parseEntityId(id);
      if (!p) { out.push(issue([...path, j], 'invalid_format', `not an entity id: '${id}'`)); return; }
      const r = geometry.resolve(geometry.table, ENTITY_LIST[p.kind], [id]);
      if (r.unknown.length || !r.indices.length) out.push(issue([...path, j], 'unknown_entity', `geometry has no entity '${id}'`));
    });
  }
  return out;
}
