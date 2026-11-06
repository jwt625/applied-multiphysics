// SPDX-License-Identifier: GPL-3.0-or-later
// 3D meshes swept from a 2D mesh: layered extrusion along z (prism6 or tet4 by the min-index split, layered.mjs) and
// revolution about the z axis (x = r; tet4, axis nodes merged, degenerate tets dropped). Facet tags follow the 3D
// entity tables of @amp/geom (extrudeLayered / revolve). Facet orientation: normal pointing out of the domain on the
// left of the 2D boundary segment (extrude sides, revolve sides), +z on interfaces and tops, -z on bottoms.

import { type Geometry2D, type Layer, type Mesh, buildGeometry2D, extrudeLayered, revolve } from '@amp/geom';
import { mesh2d, type MeshOptions2D } from './mesh2d.ts';
import { subdivideInterval, splitPrism, splitQuad } from './layered.mjs';
import { meshHash, tagHash } from './sha256.ts';
import { tetQuality, solidQuality } from './quality.ts';

export interface LayerMesh extends Layer {
  /** cell size along z in this layer (m); default options.dz */
  dz?: number;
  /** z grading: first cell size at both layer ends (m) and growth ratio (APA zPlanes) */
  dzMin?: number;
  growth?: number;
}
export interface ExtrudeOptions { mesh2d?: MeshOptions2D; dz?: number; cell?: 'tet4' | 'prism6' }

function tetVol(N: Float64Array, a: number, b: number, c: number, d: number) {
  const ux = N[3 * b]! - N[3 * a]!, uy = N[3 * b + 1]! - N[3 * a + 1]!, uz = N[3 * b + 2]! - N[3 * a + 2]!;
  const vx = N[3 * c]! - N[3 * a]!, vy = N[3 * c + 1]! - N[3 * a + 1]!, vz = N[3 * c + 2]! - N[3 * a + 2]!;
  const wx = N[3 * d]! - N[3 * a]!, wy = N[3 * d + 1]! - N[3 * a + 1]!, wz = N[3 * d + 2]! - N[3 * a + 2]!;
  return (ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6;
}

/** Compact used nodes (monotone renumbering keeps the min-index diagonals) and build the C2 mesh. */
function finish(
  N: Float64Array, used: Uint8Array, cellType: 'tet4' | 'prism6', conn: number[], dom: number[],
  fType: 'tri3', fconn: number[], fb: number[], f2: { conn: number[]; boundary: number[] } | null, ent: Mesh['entities'],
): Mesh {
  const map = new Int32Array(used.length).fill(-1);
  let nn = 0;
  for (let i = 0; i < used.length; i++) if (used[i]) map[i] = nn++;
  const nodes = new Float64Array(3 * nn);
  for (let i = 0; i < used.length; i++) if (map[i]! >= 0) nodes.set(N.subarray(3 * i, 3 * i + 3), 3 * map[i]!);
  const C = Int32Array.from(conn, (v) => map[v]!), D = Int32Array.from(dom);
  const FC = Int32Array.from(fconn, (v) => map[v]!), FB = Int32Array.from(fb);
  const mesh: Mesh = {
    dim: 3, nodes, cells: { type: cellType, conn: C, domain: D }, facets: { type: fType, conn: FC, boundary: FB },
    entities: ent, hash: meshHash(nodes, C),
  };
  if (f2) mesh.facets2 = { type: 'quad4', conn: Int32Array.from(f2.conn, (v) => map[v]!), boundary: Int32Array.from(f2.boundary) };
  mesh.tagHash = tagHash(D, FC, FB, [...ent.domains, ...ent.boundaries].map((e) => e.id));
  const q = cellType === 'tet4' ? tetQuality(nodes, C) : solidQuality(nodes, C, 'prism6');
  mesh.quality = { minShape: q.minShape, meanShape: q.meanShape, nPoor: q.nPoor, nInverted: q.nInverted, volume: q.measure };
  if (q.minDihedralDeg !== undefined) { mesh.quality.minDihedralDeg = q.minDihedralDeg; mesh.quality.maxDihedralDeg = q.maxDihedralDeg!; }
  return mesh;
}

export function meshExtruded(g: Geometry2D, layers: LayerMesh[], o: ExtrudeOptions = {}): Mesh {
  const t0 = performance.now();
  const E = extrudeLayered(g, layers);
  const m2 = mesh2d(g, { ...o.mesh2d, order: 1 });
  const t2d = performance.now();
  const cell = o.cell ?? 'tet4';
  const nD = g.entities.domains.length, nL = layers.length;
  const dzDef = o.dz ?? o.mesh2d?.hmax ?? Math.hypot(g.bbox[2] - g.bbox[0], g.bbox[3] - g.bbox[1]) / 20;
  const zs: number[] = [layers[0]!.z[0]];
  const layerStart: number[] = [];
  for (const L of layers) {
    layerStart.push(zs.length - 1);
    zs.push(...subdivideInterval(L.z[0], L.z[1], L.dz ?? dzDef, L.dzMin ?? 0, L.growth ?? 1.5));
  }
  layerStart.push(zs.length - 1);
  const nV2 = m2.nodes.length / 2, nP = zs.length;
  const N = new Float64Array(3 * nV2 * nP);
  for (let p = 0; p < nP; p++)
    for (let v = 0; v < nV2; v++) N.set([m2.nodes[2 * v]!, m2.nodes[2 * v + 1]!, zs[p]!], 3 * (v + nV2 * p));
  const used = new Uint8Array(nV2 * nP);
  const conn: number[] = [], dom: number[] = [];
  const T = m2.cells.conn, TD = m2.cells.domain, nT = TD.length;
  const G = new Int32Array(6);
  for (let k = 0; k < nL; k++)
    for (let t = 0; t < nT; t++) {
      const d3 = E.domainIndex[TD[t]! * nL + k]!;
      if (d3 < 0) continue;
      for (let p = layerStart[k]!; p < layerStart[k + 1]!; p++) {
        for (let i = 0; i < 3; i++) { G[i] = T[3 * t + i]! + nV2 * p; G[i + 3] = T[3 * t + i]! + nV2 * (p + 1); }
        for (let i = 0; i < 6; i++) used[G[i]!] = 1;
        if (cell === 'prism6') { conn.push(...G); dom.push(d3); continue; }
        splitPrism(G, (a, b, c, d) => {
          if (tetVol(N, a, b, c, d) < 0) conn.push(a, c, b, d); else conn.push(a, b, c, d);
          dom.push(d3);
        });
      }
    }
  const fconn: number[] = [], fb: number[] = [];
  const f2 = cell === 'prism6' ? { conn: [] as number[], boundary: [] as number[] } : null;
  // caps on layer-boundary planes
  for (let j = 0; j <= nL; j++) {
    const p = layerStart[j]!;
    for (let t = 0; t < nT; t++) {
      const d = TD[t]!;
      const ci = E.capIndex[j * nD + d]!;
      if (ci < 0) continue;
      const below = j > 0 && E.domainIndex[d * nL + j - 1]! >= 0;
      const a = T[3 * t]! + nV2 * p, b = T[3 * t + 1]! + nV2 * p, c = T[3 * t + 2]! + nV2 * p;
      if (below) fconn.push(a, b, c); else fconn.push(a, c, b);
      fb.push(ci);
    }
  }
  // sides from the 2D boundary segments
  const FS = m2.facets.conn, FBd = m2.facets.boundary;
  const tmp: number[] = [];
  for (let s = 0; s < FBd.length; s++) {
    const b2 = FBd[s]!, a = FS[2 * s]!, b = FS[2 * s + 1]!;
    for (let k = 0; k < nL; k++) {
      const si = E.sideIndex[b2 * nL + k]!;
      if (si < 0) continue;
      for (let p = layerStart[k]!; p < layerStart[k + 1]!; p++) {
        const q = [a + nV2 * p, b + nV2 * p, b + nV2 * (p + 1), a + nV2 * (p + 1)];
        if (f2) { f2.conn.push(...q); f2.boundary.push(si); continue; }
        tmp.length = 0;
        splitQuad(q, tmp);
        fconn.push(...tmp);
        fb.push(si, si);
      }
    }
  }
  const mesh = finish(N, used, cell, conn, dom, 'tri3', fconn, fb, f2, E.entities);
  mesh.stats = {
    nodes: mesh.nodes.length / 3, cells: dom.length, facets: fb.length + (f2 ? f2.boundary.length : 0), tris2d: nT, planes: nP,
    mesh2d_ms: t2d - t0, total_ms: performance.now() - t0,
  };
  return mesh;
}

export interface RevolveOptions { id: string; angle?: number; sectors: number; mesh2d?: MeshOptions2D }

export function meshRevolved(g: Geometry2D, o: RevolveOptions): Mesh {
  const t0 = performance.now();
  const angle = o.angle ?? 2 * Math.PI;
  const R = revolve(g, o.id, angle);
  const full = Math.abs(angle - 2 * Math.PI) <= 1e-12;
  const m2 = mesh2d(g, { ...o.mesh2d, order: 1 });
  const t2d = performance.now();
  const nS = o.sectors;
  if (!(Number.isInteger(nS) && nS >= 3)) throw new Error('mesh: revolve needs >= 3 sectors');
  const nV2 = m2.nodes.length / 2, nPl = full ? nS : nS + 1;
  const tol = 1e-12 * Math.max(g.bbox[2] - g.bbox[0], g.bbox[3] - g.bbox[1]);
  const onAxis = new Uint8Array(nV2);
  for (let v = 0; v < nV2; v++) if (Math.abs(m2.nodes[2 * v]!) <= tol) onAxis[v] = 1;
  const id = (v: number, s: number) => (onAxis[v] ? v : v + nV2 * (full ? s % nS : s));
  const N = new Float64Array(3 * nV2 * nPl);
  for (let s = 0; s < nPl; s++) {
    const th = (angle * s) / nS, c = Math.cos(th), sn = Math.sin(th);
    for (let v = 0; v < nV2; v++) {
      const r = onAxis[v] ? 0 : m2.nodes[2 * v]!;
      N.set([r * c, r * sn, m2.nodes[2 * v + 1]!], 3 * (v + nV2 * s));
    }
  }
  const used = new Uint8Array(nV2 * nPl);
  const conn: number[] = [], dom: number[] = [];
  const T = m2.cells.conn, TD = m2.cells.domain, nT = TD.length;
  const G = new Int32Array(6);
  let dropped = 0;
  for (let s = 0; s < nS; s++)
    for (let t = 0; t < nT; t++) {
      for (let i = 0; i < 3; i++) { G[i] = id(T[3 * t + i]!, s); G[i + 3] = id(T[3 * t + i]!, s + 1); }
      splitPrism(G, (a, b, c, d) => {
        if (a === b || a === c || a === d || b === c || b === d || c === d) { dropped++; return; }
        used[a] = used[b] = used[c] = used[d] = 1;
        if (tetVol(N, a, b, c, d) < 0) conn.push(a, c, b, d); else conn.push(a, b, c, d);
        dom.push(TD[t]!);
      });
    }
  const fconn: number[] = [], fb: number[] = [];
  const FS = m2.facets.conn, FBd = m2.facets.boundary;
  const tmp: number[] = [];
  for (let k = 0; k < FBd.length; k++) {
    const si = R.sideIndex[FBd[k]!]!;
    if (si < 0) continue;
    const a = FS[2 * k]!, b = FS[2 * k + 1]!;
    for (let s = 0; s < nS; s++) {
      tmp.length = 0;
      splitQuad([id(a, s), id(a, s + 1), id(b, s + 1), id(b, s)], tmp);
      for (let q = 0; q < tmp.length; q += 3) {
        const x = tmp[q]!, y = tmp[q + 1]!, z = tmp[q + 2]!;
        if (x === y || y === z || x === z) continue;
        fconn.push(x, y, z);
        fb.push(si);
      }
    }
  }
  if (!full)
    for (let t = 0; t < nT; t++) {
      const d = TD[t]!;
      const a = T[3 * t]!, b = T[3 * t + 1]!, c = T[3 * t + 2]!;
      fconn.push(id(a, 0), id(b, 0), id(c, 0));
      fb.push(R.startIndex[d]!);
      fconn.push(id(a, nS), id(c, nS), id(b, nS));
      fb.push(R.endIndex[d]!);
    }
  const mesh = finish(N, used, 'tet4', conn, dom, 'tri3', fconn, fb, null, R.entities);
  mesh.stats = { nodes: mesh.nodes.length / 3, cells: dom.length, facets: fb.length, tris2d: nT, sectors: nS, droppedDegenerate: dropped, mesh2d_ms: t2d - t0, total_ms: performance.now() - t0 };
  return mesh;
}

export interface CylinderSpec { id: string; radius: number; height: number; base: [number, number, number]; axis: 'x' | 'y' | 'z' }

/**
 * Single circular cylinder (spec feature `cylinder`) as an extruded disk, tet4 or prism6, with the 3D primitive IDs:
 * domain `dom:<id>`, boundaries `bnd:<id>.side`, `bnd:<id>.bottom` (at base), `bnd:<id>.top`. Axis x / y use the
 * cyclic frames (u, v, w) -> (y, z, x) / (z, x, y), which keep orientation.
 */
export function meshCylinder(c: CylinderSpec, o: ExtrudeOptions = {}): Mesh {
  const g = buildGeometry2D({ features: [{ id: c.id, type: 'circle', c: [0, 0], r: c.radius }] });
  const m = meshExtruded(g, [{ id: 'L', z: [0, c.height] }], o);
  const rename: Record<string, string> = {
    [`dom:${c.id}@L`]: `dom:${c.id}`, [`bnd:${c.id}.edge@L`]: `bnd:${c.id}.side`,
    [`bnd:${c.id}@L.bottom`]: `bnd:${c.id}.bottom`, [`bnd:${c.id}@L.top`]: `bnd:${c.id}.top`,
  };
  const ren = (e: { id: string }) => ({ id: rename[e.id] ?? e.id });
  m.entities = { domains: m.entities.domains.map(ren), boundaries: m.entities.boundaries.map(ren) };
  const N = m.nodes, nn = N.length / 3;
  const perm = c.axis === 'z' ? [0, 1, 2] : c.axis === 'x' ? [1, 2, 0] : [2, 0, 1]; // local u, v, w -> physical index
  const out = new Float64Array(N.length);
  for (let i = 0; i < nn; i++) for (let k = 0; k < 3; k++) out[3 * i + perm[k]!] = N[3 * i + k]! + c.base[perm[k]!]!;
  m.nodes = out;
  m.hash = meshHash(out, m.cells.conn);
  m.tagHash = tagHash(m.cells.domain, m.facets.conn, m.facets.boundary, [...m.entities.domains, ...m.entities.boundaries].map((e) => e.id));
  return m;
}
