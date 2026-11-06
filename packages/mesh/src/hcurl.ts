// SPDX-License-Identifier: GPL-3.0-or-later
// Adapter from a C2 tet4 mesh to the tet-mesh object read by @amp/core fem/space.mjs, fem/nedelec1.mjs and la/pmg.mjs
// (the APA em3d mesh shape, DevLog-002 contract request 3): nodes (3 per node, m), nNodes, tets (4 per tet, vertex
// indices sorted ascending, which the hierarchical Nedelec basis needs for global consistency without signs), nTets,
// edges (2 per edge, a < b), nEdges, tetEdges (6 per tet, local pairs 01 02 03 12 13 23 = core TET_EDGES), edgeIndex,
// tetSolid (= cells.domain). C2 keeps tet4 conn positively oriented; sorting happens only here.

import type { Mesh } from '@amp/geom';

export const LOCAL_EDGES: ReadonlyArray<readonly [number, number]> = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

export interface HcurlTetMesh {
  nodes: Float64Array; nNodes: number; tets: Int32Array; nTets: number; edges: Int32Array; nEdges: number;
  tetEdges: Int32Array; edgeIndex: (a: number, b: number) => number | undefined; tetSolid: Int32Array;
}

export function toHcurlMesh(m: Mesh): HcurlTetMesh {
  if (m.dim !== 3 || m.cells.type !== 'tet4') throw new Error('mesh: toHcurlMesh needs a 3D tet4 mesh');
  const nNodes = m.nodes.length / 3, nTets = m.cells.domain.length;
  const tets = new Int32Array(4 * nTets);
  const v = [0, 0, 0, 0];
  for (let t = 0; t < nTets; t++) {
    for (let i = 0; i < 4; i++) v[i] = m.cells.conn[4 * t + i]!;
    v.sort((a, b) => a - b);
    tets.set(v, 4 * t);
  }
  const emap = new Map<number, number>();
  const list: number[] = [];
  const tetEdges = new Int32Array(6 * nTets);
  for (let t = 0; t < nTets; t++)
    for (let l = 0; l < 6; l++) {
      const a = tets[4 * t + LOCAL_EDGES[l]![0]]!, b = tets[4 * t + LOCAL_EDGES[l]![1]]!;
      const k = a * nNodes + b;
      let id = emap.get(k);
      if (id === undefined) { id = list.length / 2; emap.set(k, id); list.push(a, b); }
      tetEdges[6 * t + l] = id;
    }
  const edges = Int32Array.from(list);
  return {
    nodes: m.nodes, nNodes, tets, nTets, edges, nEdges: edges.length / 2, tetEdges, tetSolid: m.cells.domain,
    edgeIndex: (a, b) => emap.get(Math.min(a, b) * nNodes + Math.max(a, b)),
  };
}
