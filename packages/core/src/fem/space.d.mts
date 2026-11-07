// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of fem/space.mjs (hand-written 2026-11-06, audit S2). The mesh must have vertex indices sorted
// ascending per tet (hierarchical basis without signs; not checked at run time).
import type { HcurlTetMesh } from '../la/types.d.mts';
export type { HcurlTetMesh } from '../la/types.d.mts';
export interface TetFaces { faces: Int32Array; nFaces: number; tetFaces: Int32Array; faceIndex(a: number, b: number, c: number): number | undefined }
export interface HcurlSpace {
  order: 1 | 2;
  nDof: number;
  /** DOFs per tet (6 or 20) and per face (3 or 8) */
  ndt: 6 | 20; nfl: 3 | 8;
  nEdges: number; nFaces: number;
  tetDofs: Int32Array;
  faceDofs(v: ArrayLike<number>): Int32Array;
  /** edge midpoint or face centroid (metres) */
  dofPoint(id: number, out: Float64Array): Float64Array;
  /** edge of a Whitney / gradient DOF, -1 for face DOFs */
  dofEdge(id: number): number;
  faces?: Int32Array; tetFaces?: Int32Array; faceIndex?: (a: number, b: number, c: number) => number | undefined;
}
export function buildFaces(mesh: HcurlTetMesh): TetFaces;
/** DOF map: order 1 = Whitney (nEdges); order 2 = [Whitney, edge gradients, 2 per face] (2 nEdges + 2 nFaces). */
export function buildSpace(mesh: HcurlTetMesh, order?: 1 | 2): HcurlSpace;
