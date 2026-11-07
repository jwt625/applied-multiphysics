// SPDX-License-Identifier: GPL-3.0-or-later
// Test helper (not exported by @amp/core): structured tetrahedral box mesh in the H(curl) mesh shape of
// src/la/types.d.mts HcurlTetMesh (APA em3d mesh fields; DevLog-002 contract request 3), standing in for a tet mesher
// (lane L3) in core tests. Each hex is split into 6 Kuhn tets along monotone index paths, so every tet's vertex
// indices are ascending and the split is conforming. Edge numbering as APA em3d mesh.mjs buildEdges (local pairs
// 01 02 03 12 13 23). Coordinates in metres.

const PAIRS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/** Box [0, Lx] x [0, Ly] x [0, Lz] with nx x ny x nz hexes. boundaryNode[v] = 1 on the box surface. */
export function tetBox(nx, ny, nz, [Lx, Ly, Lz] = [1, 1, 1]) {
  const NX = nx + 1, NY = ny + 1, NZ = nz + 1, nNodes = NX * NY * NZ;
  const id = (i, j, k) => i + NX * (j + NY * k);
  const nodes = new Float64Array(3 * nNodes), boundaryNode = new Uint8Array(nNodes);
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const v = id(i, j, k);
    nodes[3 * v] = (Lx * i) / nx; nodes[3 * v + 1] = (Ly * j) / ny; nodes[3 * v + 2] = (Lz * k) / nz;
    if (i === 0 || j === 0 || k === 0 || i === nx || j === ny || k === nz) boundaryNode[v] = 1;
  }
  const tets = [];
  const step = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    for (const p of PERMS) {
      const c = [i, j, k], t = [id(i, j, k)];
      for (const ax of p) { c[0] += step[ax][0]; c[1] += step[ax][1]; c[2] += step[ax][2]; t.push(id(c[0], c[1], c[2])); }
      tets.push(...t);
    }
  const nTets = tets.length / 4;
  const T = Int32Array.from(tets);
  const emap = new Map(), edgeList = [], tetEdges = new Int32Array(6 * nTets);
  for (let e = 0; e < nTets; e++)
    for (let l = 0; l < 6; l++) {
      const a = T[4 * e + PAIRS[l][0]], b = T[4 * e + PAIRS[l][1]];
      const key = a * nNodes + b;
      let eid = emap.get(key);
      if (eid === undefined) { eid = edgeList.length / 2; emap.set(key, eid); edgeList.push(a, b); }
      tetEdges[6 * e + l] = eid;
    }
  const edges = Int32Array.from(edgeList);
  return {
    nodes, nNodes, tets: T, nTets, edges, nEdges: edges.length / 2, tetEdges, boundaryNode,
    tetSolid: new Int32Array(nTets).fill(-1),
    edgeIndex: (a, b) => emap.get(Math.min(a, b) * nNodes + Math.max(a, b)),
  };
}
