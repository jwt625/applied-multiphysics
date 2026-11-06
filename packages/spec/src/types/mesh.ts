// SPDX-License-Identifier: GPL-3.0-or-later
// C2 mesh types (CONTRACTS-v0), shared by @amp/geom, @amp/mesh, @amp/physics, @amp/post.

export type CellType = 'line2' | 'line3' | 'tri3' | 'tri6' | 'quad4' | 'tet4' | 'tet10' | 'hex8' | 'prism6';

/** Persistent entity reference; id e.g. "dom:rect1", "bnd:rect1.top", split parts "<id>#<k>" with parent = [origin]. */
export interface EntityRef { id: string; label?: string; parent?: string[] }

export interface EntityTable { domains: EntityRef[]; boundaries: EntityRef[]; edges?: EntityRef[]; points?: EntityRef[] }

export interface Mesh {
  dim: 1 | 2 | 3;
  /** 2D meridional (r, z) mesh. */
  axisym?: boolean;
  /** dim * nNodes, SI metres. */
  nodes: Float64Array;
  /** domain = index into entities.domains. */
  cells: { type: CellType; conn: Int32Array; domain: Int32Array };
  /** boundary facets and internal interfaces; boundary = index into entities.boundaries. */
  facets: { type: CellType; conn: Int32Array; boundary: Int32Array };
  entities: EntityTable;
  /** sha-256 of nodes + conn (hex), used by run records. */
  hash: string;
}
