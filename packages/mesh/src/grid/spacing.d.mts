// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations for spacing.mjs (ported from advanced-packaging-atlas/engine/src/grid/spacing.mjs at fe39985).
export function mergeBreakpoints(vals: number[], tol: number): number[];
export function snapClusters(vals: number[], tol: number, keep?: number[]): { values: number[]; snap: (v: number) => number; maxShift: number; nSnapped: number };
export function gradedNodes(bps: number[], H: number, g: number, opt?: { maxIter?: number }): { nodes: Float64Array; bpIndex: Int32Array; ratio: number; iterations: number };
export function layeredNodes(bps: number[], maxZ: number | null, minCells: number, minRanges: Array<[number, number]>): { nodes: Float64Array; bpIndex: Int32Array };
