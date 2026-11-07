// SPDX-License-Identifier: GPL-3.0-or-later
// C2 adapter for the APA rectilinear grid (grid/index.mjs): axis-aligned boxes (SI metres) -> hex8 mesh with quad4
// facets on the exterior and on interfaces between different boxes. Overlaps need distinct explicit priorities (an
// equal-priority overlap is an error: no later-wins ownership). IDs: domain `dom:<box>`; facets `bnd:<box>.<dir>` with
// dir in xmin xmax ymin ymax zmin zmax, owned by the box on the minus side for interfaces (the plus-side face is in
// `parent`); one (box, dir) split by different neighbours gives `#k` (exterior first, then neighbour box order);
// symmetry planes `bnd:sym.x` / `bnd:sym.y`. A min-side face (xmin, ymin, zmin) whose interfaces are owned by the
// neighbours is numbered over all its pieces too (DevLog-036 G2): exterior remainder first (`<box>.<dir>#1` when it
// exists), then the interface pieces in neighbour box order, which list `bnd:<box>.<dir>#k` in `parent`; so
// `<box>.<dir>` still selects every piece and, with an exterior remainder, `<box>.<dir>#1` selects it alone. A face
// with a single piece keeps its plain id.

import type { EntityRef, Mesh } from '@amp/geom';
import { buildGrid, type GridPart } from './grid/index.mjs';
import { meshHash, tagHash } from './sha256.ts';
import { solidQuality } from './quality.ts';

export interface Box3 { id: string; x: [number, number]; y: [number, number]; z: [number, number]; priority?: number }
export interface BoxGridOptions {
  /** in-plane target cell size (m) */
  h: number;
  /** through-thickness cell size cap (m); default h */
  hz?: number;
  /** max neighbour size ratio in x and y (APA default 1.3) */
  grading?: number;
  minCellsPerLayer?: number;
  maxNodes?: number;
  symmetry?: 'none' | 'half_x' | 'half_y' | 'quarter';
}

const DIRS = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];
const OPP = [1, 0, 3, 2, 5, 4];
// hex8 (VTK order) face quads with outward normals, per direction d
const FACE = [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]];

export function meshBoxes(boxes: Box3[], o: BoxGridOptions): Mesh {
  const t0 = performance.now();
  if (!(o.h > 0)) throw new Error('mesh: boxgrid h must be > 0');
  let minDim = Infinity;
  for (const b of boxes) for (const r of [b.x, b.y, b.z]) minDim = Math.min(minDim, r[1] - r[0]);
  const parts: GridPart[] = boxes.map((b) => {
    const p: GridPart = {
      id: b.id, kind: 'box', material: b.id, x_mm: 0.5 * (b.x[0] + b.x[1]) * 1e3, y_mm: 0.5 * (b.y[0] + b.y[1]) * 1e3,
      w_mm: (b.x[1] - b.x[0]) * 1e3, d_mm: (b.y[1] - b.y[0]) * 1e3, z_um: b.z[0] * 1e6, h_um: (b.z[1] - b.z[0]) * 1e6,
    };
    p.priority = b.priority ?? 0;
    return p;
  });
  const snap = Math.max(1e-9, 1e-6 * minDim * 1e6); // um; far below any box dimension
  const grid = buildGrid(parts, {
    max_xy_mm: o.h * 1e3, max_z_mm: (o.hz ?? o.h) * 1e3, grading: o.grading ?? 1.3, min_cells_per_layer: o.minCellsPerLayer ?? 1,
    max_nodes: o.maxNodes ?? 2e6, symmetry: o.symmetry ?? 'none', snap_xy_um: snap, snap_z_um: snap,
  });
  const tie = grid.warnings.find((w) => w.includes('equal-priority overlap'));
  if (tie) throw new Error(`mesh: ${tie.replace('(', '- ').replace(/; the later part owns them\)/, '')}: give the boxes distinct priorities or split them`);
  const { nx, ny, nz, xs, ys, zs, cellPart } = grid;
  const NX = nx + 1, NY = ny + 1;
  // active nodes, compacted
  const nodeId = new Int32Array(NX * NY * (nz + 1)).fill(-1);
  let nn = 0, nc = 0;
  for (let k = 0, c = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, c++) {
        if (cellPart[c]! < 0) continue;
        nc++;
        for (const [di, dj, dk] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] as const) {
          const n = i + di + NX * (j + dj + NY * (k + dk));
          if (nodeId[n]! < 0) nodeId[n] = nn++;
        }
      }
  const nodes = new Float64Array(3 * nn);
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        const id = nodeId[i + NX * (j + NY * k)]!;
        if (id >= 0) nodes.set([xs[i]!, ys[j]!, zs[k]!], 3 * id);
      }
  // domains: boxes that own cells, in box order
  const domOf = new Int32Array(boxes.length).fill(-1);
  const domains: EntityRef[] = [];
  boxes.forEach((b, p) => { if (grid.partCells[p]! > 0) { domOf[p] = domains.length; domains.push({ id: `dom:${b.id}` }); } });
  const conn = new Int32Array(8 * nc), domain = new Int32Array(nc);
  const cellIndex = new Int32Array(nx * ny * nz).fill(-1);
  let q = 0;
  for (let k = 0, c = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, c++) {
        if (cellPart[c]! < 0) continue;
        const n0 = i + NX * (j + NY * k);
        const L = [n0, n0 + 1, n0 + 1 + NX, n0 + NX];
        conn.set([...L, ...L.map((n) => n + NX * NY)].map((n) => nodeId[n]!), 8 * q);
        domain[q] = domOf[cellPart[c]!]!;
        cellIndex[c] = q++;
      }
  // facet groups keyed by (owner box, dir, neighbour): neighbour -1 exterior, -2 symmetry plane
  const symX = grid.symmetry === 'half_x' || grid.symmetry === 'quarter', symY = grid.symmetry === 'half_y' || grid.symmetry === 'quarter';
  const groups = new Map<string, { p: number; d: number; nb: number; faces: number[] }>();
  const add = (p: number, d: number, nb: number, cell: number) => {
    const key = nb === -2 ? `sym${d}` : `${p},${d},${nb}`;
    let gr = groups.get(key);
    if (!gr) { gr = { p, d, nb, faces: [] }; groups.set(key, gr); }
    gr.faces.push(cell, d);
  };
  for (let k = 0, c = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, c++) {
        const p = cellPart[c]!;
        if (p < 0) continue;
        for (let d = 0; d < 6; d++) {
          let ii = i, jj = j, kk = k;
          if (d === 0) ii--; else if (d === 1) ii++; else if (d === 2) jj--; else if (d === 3) jj++; else if (d === 4) kk--; else kk++;
          if (ii < 0 && symX) { add(p, d, -2, c); continue; }
          if (jj < 0 && symY) { add(p, d, -2, c); continue; }
          const out = ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz;
          const qn = out ? -1 : cellPart[ii + nx * (jj + ny * kk)]!;
          if (qn === p) continue;
          if (qn >= 0 && d % 2 === 0) continue; // interface: owned by the minus-side cell
          add(p, d, qn, c);
        }
      }
  const list = [...groups.values()].sort((a, b) => (a.nb === -2 ? 1 : 0) - (b.nb === -2 ? 1 : 0) || a.p - b.p || a.d - b.d || (a.nb < 0 ? -1 : a.nb) - (b.nb < 0 ? -1 : b.nb));
  const perPD = new Map<string, number>();
  for (const gr of list) if (gr.nb !== -2) perPD.set(`${gr.p},${gr.d}`, (perPD.get(`${gr.p},${gr.d}`) ?? 0) + 1);
  const seenPD = new Map<string, number>();
  // min-side faces (even dir) split into an exterior remainder and interfaces owned by neighbours: piece numbers
  const minPieces = new Map<string, Array<{ p: number; d: number; nb: number; faces: number[] }>>();
  for (const gr of list) {
    if (gr.nb === -2) continue;
    const key = gr.nb === -1 && gr.d % 2 === 0 ? `${gr.p},${gr.d}` : gr.nb >= 0 && gr.d % 2 === 1 ? `${gr.nb},${OPP[gr.d]!}` : null;
    if (!key) continue;
    const l = minPieces.get(key);
    if (l) l.push(gr); else minPieces.set(key, [gr]);
  }
  const minK = new Map<object, string>();
  for (const [key, l] of minPieces) {
    if (l.length < 2) continue;
    const [p, d] = key.split(',').map(Number) as [number, number];
    l.sort((a, b) => (a.nb === -1 ? -1 : a.p) - (b.nb === -1 ? -1 : b.p));
    l.forEach((gr, i) => minK.set(gr, `${boxes[p]!.id}.${DIRS[d]}#${i + 1}`));
  }
  const boundaries: EntityRef[] = [];
  const fconn: number[] = [], fb: number[] = [];
  for (const gr of list) {
    let ref: EntityRef;
    if (gr.nb === -2) ref = { id: `bnd:sym.${gr.d === 0 ? 'x' : 'y'}` };
    else {
      const pd = `${gr.p},${gr.d}`, cnt = perPD.get(pd)!, k = (seenPD.get(pd) ?? 0) + 1;
      seenPD.set(pd, k);
      const base = `${boxes[gr.p]!.id}.${DIRS[gr.d]}`;
      const ext = gr.nb === -1 ? minK.get(gr) : undefined;
      ref = { id: `bnd:${ext ?? (cnt > 1 ? `${base}#${k}` : base)}` };
      const par: string[] = [];
      if (cnt > 1 || ext) par.push(`bnd:${base}`);
      if (gr.nb >= 0) par.push(`bnd:${minK.get(gr) ?? `${boxes[gr.nb]!.id}.${DIRS[OPP[gr.d]!]}`}`);
      if (par.length) ref.parent = par;
    }
    const bi = boundaries.length;
    boundaries.push(ref);
    for (let f = 0; f < gr.faces.length; f += 2) {
      const e = cellIndex[gr.faces[f]!]!, d = gr.faces[f + 1]!;
      for (const a of FACE[d]!) fconn.push(conn[8 * e + a]!);
      fb.push(bi);
    }
  }
  const fc = Int32Array.from(fconn), fbi = Int32Array.from(fb);
  const qual = solidQuality(nodes, conn, 'hex8');
  const mesh: Mesh = {
    dim: 3, nodes, cells: { type: 'hex8', conn, domain }, facets: { type: 'quad4', conn: fc, boundary: fbi },
    entities: { domains, boundaries }, hash: meshHash(nodes, conn),
    quality: { minShape: qual.minShape, meanShape: qual.meanShape, nInverted: qual.nInverted, volume: qual.measure, maxAspect: Number(grid.stats.maxAspect) },
  };
  mesh.tagHash = tagHash(domain, fc, fbi, [...domains, ...boundaries].map((e) => e.id));
  mesh.stats = { nodes: nn, cells: nc, facets: fbi.length, nx, ny, nz, total_ms: performance.now() - t0 };
  return mesh;
}
