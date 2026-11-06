// SPDX-License-Identifier: GPL-3.0-or-later
// 3D entity tables for a layered extrusion (z) and a revolution (about the z axis, x = r) of a 2D geometry.
// IDs: domain `<d>@<layer>`, side face `<b>@<layer>`, caps `<d>@<layer>.bottom` / `.top` (a cap shared by two layers
// takes the lower layer's `.top`, with the upper `.bottom` in `parent`). Revolve: `<d>@<rev>`, `<b>@<rev>`, partial
// angles add `<d>@<rev>.start` / `.end`; boundaries on the axis vanish. Every 3D entity lists its 2D origin in `parent`.

import type { EntityRef, EntityTable } from './types.ts';
import type { Geometry2D } from './model.ts';

export interface Layer {
  id: string;
  /** [z0, z1] in metres; layers are contiguous and ascending */
  z: [number, number];
  /** 2D domain ids (`dom:` prefix optional) present in this layer; default all */
  domains?: string[];
}

export interface Extruded {
  kind: 'extrude';
  base: Geometry2D;
  layers: Layer[];
  /** (d2 * nL + k) -> 3D domain index or -1 (domain absent in layer k) */
  domainIndex: Int32Array;
  /** (b2 * nL + k) -> boundary index or -1 */
  sideIndex: Int32Array;
  /** (j * nD2 + d2) -> boundary index or -1, j = z-plane 0..nL */
  capIndex: Int32Array;
  entities: EntityTable;
}

const strip = (id: string, p: string) => (id.startsWith(p) ? id.slice(p.length) : id);
const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Left / right 2D domain of each boundary entity. */
export function boundarySides(g: Geometry2D): Array<[number, number]> {
  const out: Array<[number, number]> = g.entities.boundaries.map(() => [-1, -1]);
  const seen = new Uint8Array(out.length);
  for (const e of g.edges)
    if (!seen[e.boundary]) {
      seen[e.boundary] = 1;
      out[e.boundary] = [e.left, e.right];
    }
  return out;
}

export function extrudeLayered(g: Geometry2D, layers: Layer[]): Extruded {
  if (!layers.length) throw new Error('geom: extrude needs at least one layer');
  const scale = Math.max(g.bbox[2] - g.bbox[0], g.bbox[3] - g.bbox[1], ...layers.map((l) => l.z[1] - l.z[0]));
  const ztol = 1e-9 * scale;
  const ids = new Set<string>();
  layers.forEach((L, k) => {
    if (!ID_RE.test(L.id) || ids.has(L.id)) throw new Error(`geom: layer id '${L.id}' invalid or duplicate`);
    ids.add(L.id);
    if (!(L.z[1] > L.z[0])) throw new Error(`geom: layer ${L.id}: z1 must exceed z0`);
    if (k && Math.abs(L.z[0] - layers[k - 1]!.z[1]) > ztol) throw new Error(`geom: layer ${L.id} does not start where ${layers[k - 1]!.id} ends`);
  });
  const nD = g.entities.domains.length, nB = g.entities.boundaries.length, nL = layers.length;
  const d2 = g.entities.domains.map((d) => strip(d.id, 'dom:'));
  const active = new Uint8Array(nD * nL);
  layers.forEach((L, k) => {
    if (!L.domains) { for (let d = 0; d < nD; d++) active[d * nL + k] = 1; return; }
    for (const x of L.domains) {
      const d = d2.indexOf(strip(x, 'dom:'));
      if (d < 0) throw new Error(`geom: layer ${L.id}: unknown 2D domain '${x}'`);
      active[d * nL + k] = 1;
    }
  });
  const domains: EntityRef[] = [], boundaries: EntityRef[] = [];
  const domainIndex = new Int32Array(nD * nL).fill(-1);
  for (let k = 0; k < nL; k++)
    for (let d = 0; d < nD; d++)
      if (active[d * nL + k]) {
        domainIndex[d * nL + k] = domains.length;
        domains.push({ id: `dom:${d2[d]}@${layers[k]!.id}`, parent: [`dom:${d2[d]}`] });
      }
  const sides = boundarySides(g);
  const sideIndex = new Int32Array(nB * nL).fill(-1);
  for (let k = 0; k < nL; k++)
    for (let b = 0; b < nB; b++) {
      const [l, r] = sides[b]!;
      const al = l >= 0 && active[l * nL + k] === 1, ar = r >= 0 && active[r * nL + k] === 1;
      if (!al && !ar) continue;
      const b2 = strip(g.entities.boundaries[b]!.id, 'bnd:');
      sideIndex[b * nL + k] = boundaries.length;
      boundaries.push({ id: `bnd:${b2}@${layers[k]!.id}`, parent: [`bnd:${b2}`] });
    }
  const capIndex = new Int32Array((nL + 1) * nD).fill(-1);
  for (let j = 0; j <= nL; j++)
    for (let d = 0; d < nD; d++) {
      const below = j > 0 && active[d * nL + j - 1] === 1, above = j < nL && active[d * nL + j] === 1;
      if (!below && !above) continue;
      const id = below ? `bnd:${d2[d]}@${layers[j - 1]!.id}.top` : `bnd:${d2[d]}@${layers[j]!.id}.bottom`;
      const parent = [`dom:${d2[d]}`];
      if (below && above) parent.push(`bnd:${d2[d]}@${layers[j]!.id}.bottom`);
      capIndex[j * nD + d] = boundaries.length;
      boundaries.push({ id, parent });
    }
  return { kind: 'extrude', base: g, layers, domainIndex, sideIndex, capIndex, entities: { domains, boundaries } };
}

export interface Revolved {
  kind: 'revolve';
  base: Geometry2D;
  id: string;
  angle: number;
  domainIndex: Int32Array;
  /** b2 -> boundary index or -1 (on the axis) */
  sideIndex: Int32Array;
  /** start / end caps per 2D domain (-1 for a full turn) */
  startIndex: Int32Array;
  endIndex: Int32Array;
  entities: EntityTable;
}

/** Revolve a meridional (r = x, z = y) geometry about the z axis by `angle` (rad, default 2 pi). */
export function revolve(g: Geometry2D, id: string, angle = 2 * Math.PI): Revolved {
  if (!ID_RE.test(id)) throw new Error(`geom: revolve id '${id}' invalid`);
  if (!(angle > 0 && angle <= 2 * Math.PI + 1e-12)) throw new Error('geom: revolve angle must be in (0, 2 pi]');
  if (g.bbox[0] < -g.tol) throw new Error('geom: revolve needs x = r >= 0');
  const full = Math.abs(angle - 2 * Math.PI) <= 1e-12;
  const nD = g.entities.domains.length, nB = g.entities.boundaries.length;
  const d2 = g.entities.domains.map((d) => strip(d.id, 'dom:'));
  const domains: EntityRef[] = d2.map((d) => ({ id: `dom:${d}@${id}`, parent: [`dom:${d}`] }));
  const boundaries: EntityRef[] = [];
  const sideIndex = new Int32Array(nB).fill(-1);
  const onAxis = new Uint8Array(nB).fill(1);
  for (const e of g.edges) {
    const ok = e.curve.kind === 'line' && Math.abs(e.curve.a[0]) <= g.tol && Math.abs(e.curve.b[0]) <= g.tol;
    if (!ok) onAxis[e.boundary] = 0;
  }
  for (let b = 0; b < nB; b++) {
    if (onAxis[b]) continue;
    const b2 = strip(g.entities.boundaries[b]!.id, 'bnd:');
    sideIndex[b] = boundaries.length;
    boundaries.push({ id: `bnd:${b2}@${id}`, parent: [`bnd:${b2}`] });
  }
  const startIndex = new Int32Array(nD).fill(-1), endIndex = new Int32Array(nD).fill(-1);
  if (!full)
    for (let d = 0; d < nD; d++) {
      startIndex[d] = boundaries.length;
      boundaries.push({ id: `bnd:${d2[d]}@${id}.start`, parent: [`dom:${d2[d]}`] });
      endIndex[d] = boundaries.length;
      boundaries.push({ id: `bnd:${d2[d]}@${id}.end`, parent: [`dom:${d2[d]}`] });
    }
  return {
    kind: 'revolve', base: g, id, angle, domainIndex: Int32Array.from({ length: nD }, (_, i) => i), sideIndex,
    startIndex, endIndex, entities: { domains, boundaries },
  };
}
