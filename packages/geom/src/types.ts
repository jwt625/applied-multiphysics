// SPDX-License-Identifier: GPL-3.0-or-later
// C2 types from @amp/spec/types, with the optional fields lane L3 adds (allowed by CONTRACTS-v0 C2; listed in
// DevLog-004 Contract requests so they can move into @amp/spec).

import type { CellType, EntityRef as EntityRefC2, EntityTable as EntityTableC2, Mesh as MeshC2 } from '@amp/spec/types';

export type { CellType };

export interface EntityRef extends EntityRefC2 {
  /** boundary lies on the symmetry axis r = 0 of an axisymmetric geometry */
  axis?: boolean;
}

export interface EntityTable extends EntityTableC2 {
  domains: EntityRef[];
  boundaries: EntityRef[];
  edges?: EntityRef[];
  points?: EntityRef[];
}

export interface Mesh extends MeshC2 {
  entities: EntityTable;
  /** sha-256 (hex) of cells.domain, facets.conn, facets.boundary bytes and the entity ids (newline-joined) */
  tagHash?: string;
  /** element quality summary */
  quality?: Record<string, number>;
  /** timings (ms) and counters */
  stats?: Record<string, number>;
  /** second facet block for mixed facet shapes (prism6: tri3 caps in `facets`, quad4 sides here) */
  facets2?: { type: CellType; conn: Int32Array; boundary: Int32Array };
  /** entities.points[k] -> node index (-1 if the point is not a mesh node) */
  pointNode?: Int32Array;
}
