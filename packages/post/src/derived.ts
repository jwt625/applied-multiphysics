// SPDX-License-Identifier: GPL-3.0-or-later
// Derived values over fields: integral, mean, max/min (nodal) over selected domains; probe = point evaluation.

import type { FieldData, Mesh } from '@amp/spec/types';
import { NPC, cellMask, nCells } from '@amp/physics/common/mesh';
import { defaultRule, gatherX, physGrad, shapeTable } from '@amp/physics/common/lagrange';
import { derivedValues, type DerivedMode } from './points.ts';

/** int f dV (weight r for axisym meshes when `axisym` is true: int f 2 pi r dr dz), per component. A field with element
 *  values (`elementNodal`, derived fields) is read per material group at interface nodes (`derived`, default 'recovered';
 *  points.ts). */
export function integrate(mesh: Mesh, f: FieldData, o: { select?: string[]; revolve?: boolean; derived?: DerivedMode } = {}): Float64Array {
  const dim = mesh.dim, k = NPC[mesh.cells.type], nc = f.components;
  const mask = cellMask(mesh, o.select);
  const t = shapeTable(mesh.cells.type, defaultRule(mesh.cells.type, 5));
  const X = new Float64Array(k * dim), G = new Float64Array(k * dim);
  const out = new Float64Array(nc);
  const n = nCells(mesh);
  const dv = f.space === 'DG0' ? null : derivedValues(mesh, f, o.derived), src = dv ?? f.data;
  for (let c = 0; c < n; c++) {
    if (!mask[c]) continue;
    gatherX(mesh.nodes, dim, mesh.cells.conn, c, k, X);
    for (let q = 0; q < t.rule.n; q++) {
      let w = physGrad(t, q, X, dim, G) * t.rule.wts[q]!;
      if (o.revolve) { let r = 0; for (let a = 0; a < k; a++) r += t.N[q * k + a]! * X[dim * a]!; w *= 2 * Math.PI * r; }
      for (let j = 0; j < nc; j++) {
        let v = 0;
        if (f.space === 'DG0') v = f.data[c * nc + j]!;
        else for (let a = 0; a < k; a++) v += t.N[q * k + a]! * src[(dv ? k * c + a : mesh.cells.conn[k * c + a]!) * nc + j]!;
        out[j]! += v * w;
      }
    }
  }
  return out;
}

/** Max and min over nodal (or DG0) values in the selected domains, with the location of the max. A field with element
 *  values is read per material group at interface nodes (`derived`, default 'recovered'; points.ts). */
export function extrema(mesh: Mesh, f: FieldData, o: { select?: string[]; component?: number; derived?: DerivedMode } = {}): { max: number; min: number; argmax: number[] } {
  const dim = mesh.dim, k = NPC[mesh.cells.type], nc = f.components, j = o.component ?? 0;
  const mask = cellMask(mesh, o.select);
  let max = -Infinity, min = Infinity, arg = -1, argCell = -1;
  const n = nCells(mesh);
  const dv = f.space === 'DG0' ? null : derivedValues(mesh, f, o.derived), src = dv ?? f.data;
  for (let c = 0; c < n; c++) {
    if (!mask[c]) continue;
    if (f.space === 'DG0') { const v = f.data[c * nc + j]!; if (v > max) { max = v; argCell = c; arg = -1; } if (v < min) min = v; continue; }
    for (let a = 0; a < k; a++) {
      const nd = mesh.cells.conn[k * c + a]!, v = src[(dv ? k * c + a : nd) * nc + j]!;
      if (v > max) { max = v; arg = nd; } if (v < min) min = v;
    }
  }
  const argmax: number[] = [];
  if (arg >= 0) for (let d = 0; d < dim; d++) argmax.push(mesh.nodes[dim * arg + d]!);
  else if (argCell >= 0) for (let d = 0; d < dim; d++) { let s = 0; for (let a = 0; a < k; a++) s += mesh.nodes[dim * mesh.cells.conn[k * argCell + a]! + d]!; argmax.push(s / k); }
  return { max, min, argmax };
}
