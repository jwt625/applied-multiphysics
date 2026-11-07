// SPDX-License-Identifier: GPL-3.0-or-later
// C2 mesh access for the physics modules, plus structured fixture meshes (rect tri3/tri6, box tet4/tet10, box hex8)
// used by tests and gates until the L3 3D meshers land. Node orders (VTK):
//   tri6  = v0 v1 v2 m01 m12 m20          line3 = v0 v1 m01
//   tet10 = v0 v1 v2 v3 m01 m12 m02 m03 m13 m23
//   hex8  = (000) (100) (110) (010) (001) (101) (111) (011)

import type { CellType, EntityRef, EntityTable, Mesh } from '@amp/spec/types';
import { meshHash } from '@amp/mesh';
import { resolveEntityIds } from '@amp/geom';

export const NPC: Record<CellType, number> = { line2: 2, line3: 3, tri3: 3, tri6: 6, quad4: 4, tet4: 4, tet10: 10, hex8: 8, prism6: 6 };
export const ORDER_OF: Partial<Record<CellType, 1 | 2>> = { line2: 1, line3: 2, tri3: 1, tri6: 2, tet4: 1, tet10: 2, hex8: 1, quad4: 1 };

export const nNodes = (m: Mesh): number => m.nodes.length / m.dim;
export const nCells = (m: Mesh): number => m.cells.conn.length / NPC[m.cells.type];
export const nFacets = (m: Mesh): number => m.facets.conn.length / NPC[m.facets.type];

export function makeMesh(parts: Omit<Mesh, 'hash'>): Mesh {
  return { ...parts, hash: meshHash(parts.nodes, parts.cells.conn) };
}

/**
 * Indices of entities of `kind` selected by `ids`, through @amp/geom resolveEntityIds (exact id, split pieces
 * `id#k`, parents and ancestors); an id that matches nothing is an error here (a physics selection must exist).
 */
export function selectEntities(table: EntityTable, kind: 'domains' | 'boundaries' | 'points', ids: readonly string[]): number[] {
  const r = resolveEntityIds(table, kind, ids);
  if (r.unknown.length) throw new Error(`selection ${r.unknown.map((u) => `'${u}'`).join(', ')} matches no ${kind === 'boundaries' ? 'boundary' : kind.slice(0, -1)} (have: ${(table[kind] ?? []).map((e) => e.id).join(', ')})`);
  return r.indices;
}

/** Per-cell flag for the domains selected by ids (all cells when ids is undefined). */
export function cellMask(m: Mesh, ids?: readonly string[]): Uint8Array {
  const nc = nCells(m);
  const mask = new Uint8Array(nc);
  if (!ids) { mask.fill(1); return mask; }
  const doms = new Set(selectEntities(m.entities, 'domains', ids));
  for (let c = 0; c < nc; c++) if (doms.has(m.cells.domain[c]!)) mask[c] = 1;
  return mask;
}

/** Facet indices on the selected boundaries. */
export function facetsOn(m: Mesh, ids: readonly string[]): number[] {
  const bs = new Set(selectEntities(m.entities, 'boundaries', ids));
  const out: number[] = [];
  const nf = nFacets(m);
  for (let f = 0; f < nf; f++) if (bs.has(m.facets.boundary[f]!)) out.push(f);
  return out;
}

/** Distinct nodes of the given facets. */
export function facetNodes(m: Mesh, facets: readonly number[]): Int32Array {
  const k = NPC[m.facets.type];
  const s = new Set<number>();
  for (const f of facets) for (let a = 0; a < k; a++) s.add(m.facets.conn[k * f + a]!);
  return Int32Array.from([...s].sort((a, b) => a - b));
}

// ---------------------------------------------------------------------------------------------- structured fixtures

const bndRefs = (ids: string[]): EntityRef[] => ids.map((id) => ({ id }));

/**
 * Rectangle [x0, x1] x [y0, y1] split into nx x ny squares, 2 triangles each (alternating diagonal), tri3 or tri6.
 * Optional coordinate maps xs(i / nx), ys(j / ny) in [0, 1] -> [0, 1] grade the grid. Domain `dom:<id>`; boundaries
 * `bnd:<id>.bottom|right|top|left` (indices 0..3).
 */
export function rectTriMesh(o: {
  x: [number, number]; y: [number, number]; nx: number; ny: number; order?: 1 | 2; id?: string;
  xs?: (s: number) => number; ys?: (s: number) => number; axisym?: boolean;
}): Mesh {
  const id = o.id ?? 'rect';
  const ord = o.order ?? 1;
  const NX = ord * o.nx, NY = ord * o.ny;
  const fx = o.xs ?? ((s: number) => s), fy = o.ys ?? ((s: number) => s);
  const nodes = new Float64Array(2 * (NX + 1) * (NY + 1));
  const nid = (i: number, j: number) => j * (NX + 1) + i;
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    nodes[2 * nid(i, j)] = o.x[0] + (o.x[1] - o.x[0]) * fx(i / NX);
    nodes[2 * nid(i, j) + 1] = o.y[0] + (o.y[1] - o.y[0]) * fy(j / NY);
  }
  const conn: number[] = [];
  for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) {
    const I = ord * i, J = ord * j;
    const c = (a: number, b: number) => nid(I + a, J + b);
    const flip = (i + j) % 2 === 1;
    // corners of the square in units of the P1 cell; midpoints at half steps (ord = 2)
    const tris: Array<[number, number][]> = flip
      ? [[[0, 0], [2, 0], [2, 2]], [[0, 0], [2, 2], [0, 2]]]
      : [[[0, 0], [2, 0], [0, 2]], [[2, 0], [2, 2], [0, 2]]];
    for (const t of tris) {
      const p = t.map(([a, b]) => [(a / 2) * ord, (b / 2) * ord] as [number, number]);
      const v = p.map(([a, b]) => c(a, b));
      if (ord === 1) conn.push(v[0]!, v[1]!, v[2]!);
      else {
        const m = (u: [number, number], w: [number, number]) => c((u[0] + w[0]) / 2, (u[1] + w[1]) / 2);
        conn.push(v[0]!, v[1]!, v[2]!, m(p[0]!, p[1]!), m(p[1]!, p[2]!), m(p[2]!, p[0]!));
      }
    }
  }
  const fconn: number[] = [], fb: number[] = [];
  const edge = (a: number, b: number, m: number, tag: number) => { if (ord === 1) fconn.push(a, b); else fconn.push(a, b, m); fb.push(tag); };
  for (let i = 0; i < o.nx; i++) { const I = ord * i; edge(nid(I, 0), nid(I + ord, 0), nid(I + 1, 0), 0); }
  for (let j = 0; j < o.ny; j++) { const J = ord * j; edge(nid(NX, J), nid(NX, J + ord), nid(NX, J + 1), 1); }
  for (let i = 0; i < o.nx; i++) { const I = ord * i; edge(nid(I + ord, NY), nid(I, NY), nid(I + 1, NY), 2); }
  for (let j = 0; j < o.ny; j++) { const J = ord * j; edge(nid(0, J + ord), nid(0, J), nid(0, J + 1), 3); }
  return makeMesh({
    dim: 2, ...(o.axisym ? { axisym: true } : {}), nodes,
    cells: { type: ord === 1 ? 'tri3' : 'tri6', conn: Int32Array.from(conn), domain: new Int32Array(conn.length / (ord === 1 ? 3 : 6)) },
    facets: { type: ord === 1 ? 'line2' : 'line3', conn: Int32Array.from(fconn), boundary: Int32Array.from(fb) },
    entities: { domains: [{ id: `dom:${id}` }], boundaries: bndRefs(['bottom', 'right', 'top', 'left'].map((s) => `bnd:${id}.${s}`)) },
  });
}

const BOX_SIDES = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];

/**
 * Box split into nx x ny x nz hexes; 'hex8' cells with quad4 facets, or 6 tets per hex (Kuhn split along the main
 * diagonal: conforming across hexes) as tet4 / tet10 with tri3 / tri6 facets. Domain `dom:<id>`, boundaries
 * `bnd:<id>.xmin|xmax|ymin|ymax|zmin|zmax` (indices 0..5).
 */
export function boxMesh(o: {
  x: [number, number]; y: [number, number]; z: [number, number]; nx: number; ny: number; nz: number;
  cell: 'hex8' | 'tet4' | 'tet10'; id?: string;
}): Mesh {
  const id = o.id ?? 'box';
  const ord = o.cell === 'tet10' ? 2 : 1;
  const NX = ord * o.nx, NY = ord * o.ny, NZ = ord * o.nz;
  const nid = (i: number, j: number, k: number) => (k * (NY + 1) + j) * (NX + 1) + i;
  const nodes = new Float64Array(3 * (NX + 1) * (NY + 1) * (NZ + 1));
  for (let k = 0; k <= NZ; k++) for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const n = nid(i, j, k);
    nodes[3 * n] = o.x[0] + ((o.x[1] - o.x[0]) * i) / NX;
    nodes[3 * n + 1] = o.y[0] + ((o.y[1] - o.y[0]) * j) / NY;
    nodes[3 * n + 2] = o.z[0] + ((o.z[1] - o.z[0]) * k) / NZ;
  }
  const conn: number[] = [];
  const fconn: number[] = [], fb: number[] = [];
  // hex corner offsets (VTK order)
  const H = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  // Kuhn split: 6 tets sharing the diagonal 0-6, paths through corners
  const KUHN = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];
  const vol = (p: number[][]) => {
    const [a, b, c, d] = p as [number[], number[], number[], number[]];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!], w = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
    return u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
  };
  for (let k = 0; k < o.nz; k++) for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) {
    const at = (c: number[], s = ord) => nid(ord * i + s * c[0]!, ord * j + s * c[1]!, ord * k + s * c[2]!);
    if (o.cell === 'hex8') { for (const c of H) conn.push(at(c)); continue; }
    for (const t of KUHN) {
      let cs = t.map((q) => H[q]!);
      if (vol(cs) < 0) cs = [cs[0]!, cs[2]!, cs[1]!, cs[3]!];
      const v = cs.map((c) => at(c));
      if (ord === 1) conn.push(...v);
      else {
        const mid = (a: number[], b: number[]) => nid(2 * i + a[0]! + b[0]!, 2 * j + a[1]! + b[1]!, 2 * k + a[2]! + b[2]!);
        const [a, b, c, d] = cs as [number[], number[], number[], number[]];
        conn.push(...v, mid(a, b), mid(b, c), mid(a, c), mid(a, d), mid(b, d), mid(c, d));
      }
    }
  }
  // facets on the 6 sides
  const N = [o.nx, o.ny, o.nz];
  for (let s = 0; s < 6; s++) {
    const ax = s >> 1, hi = s & 1;
    const [a1, a2] = [0, 1, 2].filter((q) => q !== ax) as [number, number];
    for (let q = 0; q < N[a2]!; q++) for (let p = 0; p < N[a1]!; p++) {
      const corner = (dp: number, dq: number, sc = ord) => {
        const c = [0, 0, 0];
        c[ax] = hi * N[ax]! * ord; c[a1] = ord * p + sc * dp; c[a2] = ord * q + sc * dq;
        return c;
      };
      const n = (c: number[]) => nid(c[0]!, c[1]!, c[2]!);
      if (o.cell === 'hex8') { fconn.push(n(corner(0, 0)), n(corner(1, 0)), n(corner(1, 1)), n(corner(0, 1))); fb.push(s); continue; }
      // the Kuhn diagonal of a boundary face runs from the corner nearer the hex node 0 to the opposite one
      const tris: Array<[number, number][]> = [[[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 1], [0, 1]]];
      for (const t of tris) {
        const cs = t.map(([dp, dq]) => corner(dp, dq));
        if (ord === 1) fconn.push(...cs.map(n));
        else {
          const m = (u: number[], w: number[]) => n([(u[0]! + w[0]!) / 2, (u[1]! + w[1]!) / 2, (u[2]! + w[2]!) / 2]);
          fconn.push(...cs.map(n), m(cs[0]!, cs[1]!), m(cs[1]!, cs[2]!), m(cs[2]!, cs[0]!));
        }
        fb.push(s);
      }
    }
  }
  const npc = NPC[o.cell];
  return makeMesh({
    dim: 3, nodes,
    cells: { type: o.cell, conn: Int32Array.from(conn), domain: new Int32Array(conn.length / npc) },
    facets: { type: o.cell === 'hex8' ? 'quad4' : ord === 1 ? 'tri3' : 'tri6', conn: Int32Array.from(fconn), boundary: Int32Array.from(fb) },
    entities: { domains: [{ id: `dom:${id}` }], boundaries: bndRefs(BOX_SIDES.map((s) => `bnd:${id}.${s}`)) },
  });
}

/** Coordinates of node n (dim components). */
export function nodeXYZ(m: Mesh, n: number, out: number[] = [0, 0, 0]): number[] {
  for (let d = 0; d < m.dim; d++) out[d] = m.nodes[m.dim * n + d]!;
  return out;
}
