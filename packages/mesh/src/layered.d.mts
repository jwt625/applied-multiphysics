// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations for layered.mjs (ported from advanced-packaging-atlas/engine/src/em3d/mesh.mjs at fe39985).
export function subdivideInterval(a: number, b: number, dz: number, dzMin?: number, growth?: number): number[];
export function splitPrism(G: ArrayLike<number>, put: (a: number, b: number, c: number, d: number) => void): void;
export function splitQuad(q: ArrayLike<number>, out: number[]): number[];
