// SPDX-License-Identifier: GPL-3.0-or-later
// Constitutive groups of the elastic producers (FieldData.cellGroup, DevLog-066).

/**
 * Constitutive group per cell (FieldData.cellGroup, DevLog-066): cells with the same E, nu (and thermal-expansion alpha
 * when coupled) share a group, numbered in order of first appearance; -1 for cells outside the physics. Stresses are
 * continuous between cells of one group (same constants, continuous temperature: the exact field has no interface
 * there), so @amp/post recovers them per group: a boundary between two domains of one material gets the smooth nodal
 * mean, a material interface keeps one value per side.
 */
export function constitutiveGroups(mask: Uint8Array, E: Float64Array, nu: Float64Array, alpha?: Float64Array): Int32Array {
  const g = new Int32Array(mask.length).fill(-1), seen = new Map<string, number>();
  for (let e = 0; e < mask.length; e++) {
    if (!mask[e]) continue;
    const key = `${E[e]}|${nu[e]}|${alpha ? alpha[e] : ''}`;
    let k = seen.get(key);
    if (k === undefined) { k = seen.size; seen.set(key, k); }
    g[e] = k;
  }
  return g;
}
