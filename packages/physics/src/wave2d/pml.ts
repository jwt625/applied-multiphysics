// SPDX-License-Identifier: GPL-3.0-or-later
// Cartesian PML by complex coordinate stretching for wave2d (DevLog-042 s.1.3). Inner box = bounding box of the nodes of
// the non-PML cells of the physics; outer box = bounding box of all physics cells. Beyond the inner box along x (or y)
// a PML point is stretched with s(d) = 1 - j f_max (d / L)^p, d = distance beyond the inner box, L = PML thickness on
// that side, f_max = -(p + 1) ln(R0) / (2 k L): a reflecting wall behind the layer then returns a normally incident
// wave with amplitude R0 in the continuum (exp(-2 k int_0^L f)). k is the wavenumber of the PML cell (real part).

import type { Mesh } from '@amp/spec/types';
import { NPC, nCells } from '../common/mesh.ts';

export interface Box { x0: number; x1: number; y0: number; y1: number }

export interface PmlModel {
  /** per cell: 1 = PML cell */
  cell: Uint8Array;
  inner: Box;
  outer: Box;
  /** per cell R0 and order (PML cells only) */
  R0: Float64Array;
  order: Float64Array;
}

/** Bounding box of the nodes of cells with flag(c) true. */
export function cellBox(mesh: Mesh, flag: (c: number) => boolean): Box | null {
  const k = NPC[mesh.cells.type], nc = nCells(mesh);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let c = 0; c < nc; c++) {
    if (!flag(c)) continue;
    for (let a = 0; a < k; a++) {
      const n = mesh.cells.conn[k * c + a]!;
      const x = mesh.nodes[2 * n]!, y = mesh.nodes[2 * n + 1]!;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x0 <= x1 ? { x0, x1, y0, y1 } : null;
}

/** Build the PML model; throws when a PML cell lies inside the inner box (non box-like layout). */
export function buildPml(mesh: Mesh, active: Uint8Array, pmlCell: Uint8Array, R0: Float64Array, order: Float64Array): PmlModel {
  const inner = cellBox(mesh, (c) => !!active[c] && !pmlCell[c]);
  const outer = cellBox(mesh, (c) => !!active[c]);
  if (!inner || !outer) throw new Error('pml: no non-PML cells in the physics selection (the PML must surround an interior region)');
  const k = NPC[mesh.cells.type], nc = nCells(mesh);
  const span = Math.max(outer.x1 - outer.x0, outer.y1 - outer.y0);
  const tol = 1e-9 * span;
  for (let c = 0; c < nc; c++) {
    if (!pmlCell[c] || !active[c]) continue;
    let cx = 0, cy = 0;
    for (let a = 0; a < 3; a++) { const n = mesh.cells.conn[k * c + a]!; cx += mesh.nodes[2 * n]! / 3; cy += mesh.nodes[2 * n + 1]! / 3; }
    if (cx > inner.x0 + tol && cx < inner.x1 - tol && cy > inner.y0 + tol && cy < inner.y1 - tol)
      throw new Error(`pml: PML cell ${c} (centroid ${cx.toPrecision(4)}, ${cy.toPrecision(4)} m) lies inside the box of the non-PML region [${inner.x0.toPrecision(4)}, ${inner.x1.toPrecision(4)}] x [${inner.y0.toPrecision(4)}, ${inner.y1.toPrecision(4)}] m; PML layers must be Cartesian slabs and corners outside that box`);
  }
  return { cell: pmlCell, inner, outer, R0, order };
}

/** Stretch factors at (x, y) of PML cell c with wavenumber kc (1/m): [sx_re, sx_im, sy_re, sy_im]. */
export function stretch(p: PmlModel, c: number, x: number, y: number, kc: number, out: Float64Array): Float64Array {
  out[0] = 1; out[1] = 0; out[2] = 1; out[3] = 0;
  if (!p.cell[c]) return out;
  const { inner: I, outer: O } = p;
  const lnR = Math.log(p.R0[c]!), ord = p.order[c]!;
  const one = (d: number, L: number): number => {
    if (!(d > 0) || !(L > 0)) return 0;
    const fmax = (-(ord + 1) * lnR) / (2 * kc * L);
    return fmax * Math.pow(Math.min(1, d / L), ord);
  };
  const fx = x < I.x0 ? one(I.x0 - x, I.x0 - O.x0) : x > I.x1 ? one(x - I.x1, O.x1 - I.x1) : 0;
  const fy = y < I.y0 ? one(I.y0 - y, I.y0 - O.y0) : y > I.y1 ? one(y - I.y1, O.y1 - I.y1) : 0;
  out[1] = -fx; out[3] = -fy;
  return out;
}
