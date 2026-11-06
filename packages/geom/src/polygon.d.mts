// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations for polygon.mjs (ported from eo-modulator-atlas/engine/src/geometry.mjs at 0546007).
export type Pt = [number, number];
export interface BBox { x0: number; y0: number; x1: number; y1: number }
export function rectToPolygon(x: [number, number], y: [number, number]): Pt[];
export function polygonArea(poly: ArrayLike<Pt>): number;
export function ensureCcw(poly: Pt[]): Pt[];
export function polygonBBox(poly: ArrayLike<Pt>): BBox;
export function pointInPolygon(px: number, py: number, poly: ArrayLike<Pt>): boolean;
export function distPointSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number;
export function distPointPolygon(px: number, py: number, poly: ArrayLike<Pt>, filled?: boolean): number;
export function clipSegmentToRect(ax: number, ay: number, bx: number, by: number, r: BBox): [number, number, number, number] | null;
