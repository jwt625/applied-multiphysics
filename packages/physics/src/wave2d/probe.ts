// SPDX-License-Identifier: GPL-3.0-or-later
// Point evaluation of nodal fields on 2D tri3 / tri6 meshes (isoparametric; Newton inversion of the cell map), used by
// the wave2d gates (probe values against series references) and by modules that report point values.

import type { Mesh } from '@amp/spec/types';
import { NPC, nCells } from '../common/mesh.ts';
import { shape } from '../common/lagrange.ts';

/** Locate (x, y): cell index and reference coordinates, or null. Brute force over cells with a bounding-box test. */
export function locate(mesh: Mesh, x: number, y: number, mask?: Uint8Array): { cell: number; xi: [number, number] } | null {
  const k = NPC[mesh.cells.type], nc = nCells(mesh);
  const N = new Float64Array(k), dN = new Float64Array(2 * k);
  for (let c = 0; c < nc; c++) {
    if (mask && !mask[c]) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let a = 0; a < k; a++) { const n = mesh.cells.conn[k * c + a]!; const px = mesh.nodes[2 * n]!, py = mesh.nodes[2 * n + 1]!; x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
    const pad = 1e-9 * Math.max(x1 - x0, y1 - y0);
    if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) continue;
    // Newton on the isoparametric map from the centroid
    let s = 1 / 3, t = 1 / 3;
    for (let it = 0; it < 30; it++) {
      shape(mesh.cells.type, [s, t], N, dN);
      let fx = -x, fy = -y, a = 0, b = 0, cc = 0, d = 0;
      for (let i = 0; i < k; i++) {
        const n = mesh.cells.conn[k * c + i]!; const px = mesh.nodes[2 * n]!, py = mesh.nodes[2 * n + 1]!;
        fx += N[i]! * px; fy += N[i]! * py;
        a += px * dN[2 * i]!; b += px * dN[2 * i + 1]!; cc += py * dN[2 * i]!; d += py * dN[2 * i + 1]!;
      }
      const det = a * d - b * cc;
      const ds = (d * fx - b * fy) / det, dt = (-cc * fx + a * fy) / det;
      s -= ds; t -= dt;
      if (Math.abs(ds) + Math.abs(dt) < 1e-14) break;
    }
    const tol = 1e-10;
    if (s >= -tol && t >= -tol && s + t <= 1 + tol) return { cell: c, xi: [s, t] };
  }
  return null;
}

/** Interpolated nodal values (any number of nodal arrays) at (x, y); null outside the mesh (or the mask). */
export function probe(mesh: Mesh, data: Float64Array[], x: number, y: number, mask?: Uint8Array): number[] | null {
  const hit = locate(mesh, x, y, mask);
  if (!hit) return null;
  const k = NPC[mesh.cells.type];
  const N = new Float64Array(k), dN = new Float64Array(2 * k);
  shape(mesh.cells.type, hit.xi, N, dN);
  return data.map((f) => { let v = 0; for (let a = 0; a < k; a++) v += N[a]! * f[mesh.cells.conn[k * hit.cell + a]!]!; return v; });
}
