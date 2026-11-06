// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of fem/quadrature.mjs (hand-written, 2026-11-06).
export { GAUSS01 } from './q1-grid.mjs';
export { TRI_QUAD, simplexMoment } from './hcurl.mjs';
/** [l0, l1, l2, w], sum of w = 1. */
export const TRI_Q4: [number, number, number, number][];
