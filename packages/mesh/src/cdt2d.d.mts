// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations for cdt2d.mjs (ported from eo-modulator-atlas/engine/src/mesh.mjs at 0546007).
export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface SizeSource { segs: Float64Array; domain?: number; h0: number; grade?: number }
export type SizeAt = ((x: number, y: number, cls?: number | null) => number) & { count?: () => number };
export function createSizeField(spec: {
  rect: Rect; maxEdge: number; grade?: number; sources?: SizeSource[]; regionMax?: number[];
  classify?: (x: number, y: number) => number;
}): SizeAt;
export interface PslgSeg { a: number; b: number; tag: number; left: number; right: number; curve: number; ta: number; tb: number }
export interface OutSeg { a: number; b: number; tag: number; curve: number; ta: number; tb: number }
export function meshDomain(spec: {
  rect: Rect; verts: Float64Array; segs: PslgSeg[]; classify: (x: number, y: number) => number;
  curvePoint?: (curve: number, t: number) => [number, number]; sizeAt: SizeAt; minAngleBound?: number; minEdge: number;
  maxVertices?: number;
}): {
  nodes: Float64Array; tri: Int32Array; triDomain: Int32Array; segs: OutSeg[]; nNodes: number; nTris: number;
  stats: {
    nSegSplits: number; nInsert: number; nRepair: number; nProjected: number; nClassify: number; nUnlabeled: number;
    nSizeAt: number; ms: number; insert_ms: number; segments_ms: number; refine_ms: number; label_ms: number;
  };
};
