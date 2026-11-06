// Ported from eo-modulator-atlas/engine/src/vector-mode.mjs at 0546007 (GPL-3.0-or-later). Changes: the 6-point
// degree-4 triangle rule `Q4` (vector-mode.mjs lines 634-642, used there and in EO postproc/evaluate.mjs) copied
// verbatim as TRI_Q4; the module also re-exports the rules already in @amp/core (no new rules): GAUSS01 (Gauss-Legendre
// on [0, 1], 2 and 3 points; fem/q1-grid.mjs from APA thermal/assemble.mjs), TRI_QUAD (16-point collapsed rule,
// degree 6) and simplexMoment (exact barycentric monomial integrals) from fem/hcurl.mjs (APA em3d/hcurl.mjs).
// SPDX-License-Identifier: GPL-3.0-or-later

export { GAUSS01 } from './q1-grid.mjs';
export { TRI_QUAD, simplexMoment } from './hcurl.mjs';

/** 6-point degree-4 rule on the triangle: [l0, l1, l2, w] with sum w = 1 (multiply by the area). */
export const TRI_Q4 = (() => {
  const a1 = 0.445948490915965, w1 = 0.223381589678011, a2 = 0.091576213509771, w2 = 0.109951743655322;
  const pts = [];
  for (const [a, w] of [[a1, w1], [a2, w2]]) {
    const b = 1 - 2 * a;
    pts.push([b, a, a, w], [a, b, a, w], [a, a, b, w]);
  }
  return pts;
})();
