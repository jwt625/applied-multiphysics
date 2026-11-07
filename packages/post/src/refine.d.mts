// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of refine.mjs (ported from eo-modulator-atlas engine/src/postproc/refine.mjs at 0546007).
export interface TriMeshLike { x: ArrayLike<number>; y: ArrayLike<number>; tri: ArrayLike<number>; nNodes?: number }
export interface RefinePattern { r: number; np: number; nSub: number; L: Float64Array; sub: Int32Array }
export const RESOLUTIONS: Readonly<{ none: 1; coarse: 2; normal: 3; fine: 4; finer: 6; extra: 8 }>;
export const MAX_RESOLUTION: number;
export const MAX_SUBTRIANGLES: number;
export const SMOOTHING: readonly ['none', 'material', 'everywhere'];
export function latticeIndex(r: number, n0: number, n1: number): number;
export function refinePattern(r: number): RefinePattern;
export function resolutionLevel(res?: string | number): number;
export function cappedLevel(nTris: number, r: number, cap?: number): number;
export function refinedPoints(mesh: TriMeshLike, r: number): { x: Float64Array; y: Float64Array };
export function interpolateRefined(values: ArrayLike<number>, r: number, t: number, L0: number, L1: number): number;
export function edgeNeighbours(mesh: TriMeshLike): Int32Array;
export function smoothingSlots(mesh: TriMeshLike, nb: Int32Array, r: number, group: ArrayLike<number> | null): { slot: Int32Array; nSlots: number };
export function smoothValues(values: Float64Array, slots: { slot: Int32Array; nSlots: number }): Float64Array;
