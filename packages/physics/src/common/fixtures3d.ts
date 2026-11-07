// SPDX-License-Identifier: GPL-3.0-or-later
// 3D fixture meshes until the L3 tet mesher lands: a circular cylinder (radius a, height d, axis z, base at z0) as a
// disk mesh (L3 mesh2d of a circle, tri3) extruded in nz layers to prisms, each prism split into 3 tets by the
// Dompierre et al. (1999) minimum-global-index rule (every quadrilateral face is cut by the diagonal through its
// smallest vertex index, so neighbouring prisms agree and the tet mesh is conforming). tet4, or tet10 with the
// mid-edge nodes of side-surface edges projected radially onto the exact cylinder (isoparametric quadratic geometry).
// Domain `dom:<id>`; boundaries `bnd:<id>.side`, `bnd:<id>.bottom`, `bnd:<id>.top` (indices 0, 1, 2), facets tri3 / tri6.

import type { Mesh } from '@amp/spec/types';
import { buildGeometry2D } from '@amp/geom';
import { mesh2d } from '@amp/mesh';
import { makeMesh } from './mesh.ts';

export interface CylinderOptions {
  radius: number; height: number; z0?: number; id?: string;
  /** in-plane target size of the disk mesh (m) */
  h: number;
  /** number of layers (default round(height / h)) */
  nz?: number;
  cell: 'tet4' | 'tet10';
  /** snap tet10 side mid-nodes to the exact cylinder (default true) */
  curved?: boolean;
  /** disk triangulation: 'mesh2d' (L3 CDT mesher, default) or 'rings' (structured concentric rings, self-similar
   *  under refinement: ring k of N at radius k a / N carries 6 k equally spaced nodes) */
  disk?: 'mesh2d' | 'rings';
}

/** Structured disk: N rings, ring k at radius k a / N with 6 k nodes; strips between rings triangulated by angle. */
export function ringDisk(a: number, N: number): { nodes: Float64Array; tri: Int32Array; bnd: Int32Array } {
  const xy: number[] = [0, 0];
  const start: number[] = [0];
  for (let k = 1; k <= N; k++) {
    start.push(xy.length / 2);
    for (let j = 0; j < 6 * k; j++) { const t = (2 * Math.PI * j) / (6 * k); xy.push((a * k * Math.cos(t)) / N, (a * k * Math.sin(t)) / N); }
  }
  const tri: number[] = [];
  for (let k = 1; k <= N; k++) {
    const ni = k === 1 ? 1 : 6 * (k - 1), no = 6 * k, si = start[k - 1]!, so = start[k]!;
    if (k === 1) { for (let j = 0; j < 6; j++) tri.push(0, so + j, so + ((j + 1) % 6)); continue; }
    // merge by angle: advance on the ring whose next node has the smaller angle
    let i = 0, o = 0;
    while (i < ni || o < no) {
      const ai = (2 * Math.PI * (i + 1)) / ni, ao = (2 * Math.PI * (o + 1)) / no;
      if (o < no && (i >= ni || ao <= ai)) { tri.push(si + (i % ni), so + (o % no), so + ((o + 1) % no)); o++; }
      else { tri.push(si + (i % ni), so + (o % no), si + ((i + 1) % ni)); i++; }
    }
  }
  const bnd: number[] = [];
  const so = start[N]!;
  for (let j = 0; j < 6 * N; j++) bnd.push(so + j, so + ((j + 1) % (6 * N)));
  return { nodes: Float64Array.from(xy), tri: Int32Array.from(tri), bnd: Int32Array.from(bnd) };
}

// rotations of the prism (v0 v1 v2 bottom, v3 v4 v5 top above them) that move vertex k to position 0
const ROT = [[0, 1, 2, 3, 4, 5], [1, 2, 0, 4, 5, 3], [2, 0, 1, 5, 3, 4], [3, 5, 4, 0, 2, 1], [4, 3, 5, 1, 0, 2], [5, 4, 3, 2, 1, 0]];

export function cylinderTetMesh(o: CylinderOptions): Mesh {
  const id = o.id ?? 'cav';
  const a = o.radius, H = o.height, z0 = o.z0 ?? 0;
  let disk: { nodes: Float64Array; cells: { conn: Int32Array }; facets: { conn: Int32Array } };
  if (o.disk === 'rings') {
    const r = ringDisk(a, Math.max(1, Math.round(a / o.h)));
    disk = { nodes: r.nodes, cells: { conn: r.tri }, facets: { conn: r.bnd } };
  } else {
    const g = buildGeometry2D({ features: [{ id, type: 'circle', c: [0, 0], r: a }] });
    disk = mesh2d(g, { hmax: o.h, order: 1 });
  }
  const nv = disk.nodes.length / 2, nt = disk.cells.conn.length / 3;
  const nz = o.nz ?? Math.max(1, Math.round(H / o.h));
  // vertex nodes: layer-major
  const nV = nv * (nz + 1);
  const coords: number[] = new Array(3 * nV);
  for (let l = 0; l <= nz; l++) for (let v = 0; v < nv; v++) {
    const n = l * nv + v;
    coords[3 * n] = disk.nodes[2 * v]!; coords[3 * n + 1] = disk.nodes[2 * v + 1]!; coords[3 * n + 2] = z0 + (H * l) / nz;
  }
  // disk boundary vertices (on the circle)
  const onCircle = new Uint8Array(nv);
  for (let f = 0; f < disk.facets.conn.length / 2; f++) { onCircle[disk.facets.conn[2 * f]!] = 1; onCircle[disk.facets.conn[2 * f + 1]!] = 1; }
  const tets: number[] = [];
  const vol = (p: number[]) => {
    const P = p.map((n) => [coords[3 * n]!, coords[3 * n + 1]!, coords[3 * n + 2]!]);
    const u = P[1]!.map((x, d) => x - P[0]![d]!), v = P[2]!.map((x, d) => x - P[0]![d]!), w = P[3]!.map((x, d) => x - P[0]![d]!);
    return u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
  };
  const push = (t: number[]) => { if (vol(t) < 0) t = [t[0]!, t[2]!, t[1]!, t[3]!]; tets.push(...t); };
  for (let l = 0; l < nz; l++) for (let t = 0; t < nt; t++) {
    const b = [0, 1, 2].map((k) => l * nv + disk.cells.conn[3 * t + k]!);
    const P = [...b, ...b.map((x) => x + nv)];
    let kmin = 0;
    for (let k = 1; k < 6; k++) if (P[k]! < P[kmin]!) kmin = k;
    const V = ROT[kmin]!.map((k) => P[k]!);
    if (Math.min(V[1]!, V[5]!) < Math.min(V[2]!, V[4]!)) {
      push([V[0]!, V[1]!, V[2]!, V[5]!]); push([V[0]!, V[1]!, V[5]!, V[4]!]); push([V[0]!, V[4]!, V[5]!, V[3]!]);
    } else {
      push([V[0]!, V[1]!, V[2]!, V[4]!]); push([V[0]!, V[4]!, V[2]!, V[5]!]); push([V[0]!, V[4]!, V[5]!, V[3]!]);
    }
  }
  // boundary facets: caps from the disk triangles, side from the boundary-segment quads (same min-index diagonal)
  const fac: number[] = [], fb: number[] = [];
  for (let t = 0; t < nt; t++) {
    const c = [0, 1, 2].map((k) => disk.cells.conn[3 * t + k]!);
    fac.push(c[0]!, c[1]!, c[2]!); fb.push(1);
    fac.push(...c.map((x) => nz * nv + x)); fb.push(2);
  }
  for (let l = 0; l < nz; l++) for (let f = 0; f < disk.facets.conn.length / 2; f++) {
    const p = l * nv + disk.facets.conn[2 * f]!, q = l * nv + disk.facets.conn[2 * f + 1]!;
    const Q = [p, q, q + nv, p + nv];   // quad cycle
    let kmin = 0;
    for (let k = 1; k < 4; k++) if (Q[k]! < Q[kmin]!) kmin = k;
    const A = Q[kmin]!, B = Q[(kmin + 1) % 4]!, C = Q[(kmin + 2) % 4]!, D = Q[(kmin + 3) % 4]!;
    fac.push(A, B, C, A, C, D); fb.push(0, 0);
  }
  let nodes = Float64Array.from(coords);
  let conn = Int32Array.from(tets);
  let fconn = Int32Array.from(fac);
  if (o.cell === 'tet10') {
    const mid = new Map<number, number>();
    const extra: number[] = [];
    const sideEdge = new Set<number>();
    const key = (x: number, y: number) => (x < y ? x * nV + y : y * nV + x);
    for (let f = 0; f < fb.length; f++) if (fb[f] === 0) {
      const v = [fac[3 * f]!, fac[3 * f + 1]!, fac[3 * f + 2]!];
      sideEdge.add(key(v[0]!, v[1]!)); sideEdge.add(key(v[1]!, v[2]!)); sideEdge.add(key(v[0]!, v[2]!));
    }
    const curved = o.curved ?? true;
    const midOf = (x: number, y: number) => {
      const k = key(x, y);
      let m = mid.get(k);
      if (m === undefined) {
        m = nV + extra.length / 3;
        let px = 0.5 * (coords[3 * x]! + coords[3 * y]!), py = 0.5 * (coords[3 * x + 1]! + coords[3 * y + 1]!);
        const pz = 0.5 * (coords[3 * x + 2]! + coords[3 * y + 2]!);
        if (curved && sideEdge.has(k)) { const r = Math.hypot(px, py); px *= a / r; py *= a / r; }
        extra.push(px, py, pz);
        mid.set(k, m);
      }
      return m;
    };
    const c10: number[] = [];
    for (let t = 0; t < tets.length / 4; t++) {
      const [p, q, r, s] = tets.slice(4 * t, 4 * t + 4) as [number, number, number, number];
      c10.push(p, q, r, s, midOf(p, q), midOf(q, r), midOf(p, r), midOf(p, s), midOf(q, s), midOf(r, s));
    }
    const f6: number[] = [];
    for (let f = 0; f < fb.length; f++) {
      const [p, q, r] = fac.slice(3 * f, 3 * f + 3) as [number, number, number];
      f6.push(p, q, r, midOf(p, q), midOf(q, r), midOf(r, p));
    }
    nodes = Float64Array.from([...coords, ...extra]);
    conn = Int32Array.from(c10);
    fconn = Int32Array.from(f6);
  }
  void onCircle;
  return makeMesh({
    dim: 3, nodes,
    cells: { type: o.cell, conn, domain: new Int32Array(conn.length / (o.cell === 'tet10' ? 10 : 4)) },
    facets: { type: o.cell === 'tet10' ? 'tri6' : 'tri3', conn: fconn, boundary: Int32Array.from(fb) },
    entities: { domains: [{ id: `dom:${id}` }], boundaries: [{ id: `bnd:${id}.side` }, { id: `bnd:${id}.bottom` }, { id: `bnd:${id}.top` }] },
  });
}
