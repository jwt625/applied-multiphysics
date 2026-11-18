// SPDX-License-Identifier: GPL-3.0-or-later
// Mesh of a layer stack (@amp/geom buildStack / stackFromSolids; DevLog-044): one 2D mesh of the overlay of every
// layer sketch, swept through the z planes of each layer. tet4: every prism -> 3 tets by the minimum-global-index rule
// (Dompierre, Labbe, Vallet, Camarero 1999; layered.mjs), side quads cut by the same rule, so the mesh conforms across
// layers and domains. tet10: lift of the 2D tri6 mesh: the mid node of the edge (v, p)-(w, q) is (2D mid node of vw,
// (z_p + z_q) / 2), or (x_v, (z_p + z_q) / 2) for v = w. The prism map is quadratic in (x, y) and linear in z, i.e.
// degree 2 in each tet's barycentric coordinates, so this is its exact P2 interpolant (walls on circles / ellipses
// get mid nodes on the exact curve). Facets: caps (tri3 / tri6; +z where a domain lies below, else -z) and walls
// (outward on exterior walls; interfaces out of the lower-index domain). Nodes are numbered plane-major (2D vertex
// v on plane p before compaction: v + N p), mid nodes after the vertices in order of first use by the cells.

import { type Curve, type Mesh, type Stack, capKey, point, project, detmath } from '@amp/geom';
import { mesh2d, type MeshOptions2D } from './mesh2d.ts';
import { subdivideInterval, splitPrism, splitQuad } from './layered.mjs';
import { meshHash, tagHash } from './sha256.ts';
import { tetQuality } from './quality.ts';
import type { Projector } from './refine.ts';

export interface StackMeshOptions {
  mesh2d?: MeshOptions2D;
  /** default cell size along z (m) of layers without nz / dz; default mesh2d.hmax */
  dz?: number;
  order?: 1 | 2;
}

const projectors = new WeakMap<Mesh, Projector>();
/** min dihedral (deg) below which meshStack warns: a design threshold, not a sourced value (DevLog-055 s.9 R1) */
export const FLAT_TET_DEG = 5;
/** Projector of a meshStack mesh (new nodes on curved walls onto the exact 2D curve, z kept), for refineUniform. */
export const stackProjector = (m: Mesh): Projector | undefined => projectors.get(m);

const TET_E = [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]] as const;
const TRI_E = [[0, 1], [1, 2], [2, 0]] as const;

// sample points (barycentric) of the P2 Jacobian check: corners, edge midpoints, centroid
const JPTS: number[][] = [
  [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
  ...TET_E.map(([i, j]) => { const L = [0, 0, 0, 0]; L[i] = 0.5; L[j] = 0.5; return L; }), [0.25, 0.25, 0.25, 0.25],
];
/** min over cells of det J / det J(straight) of the P2 map at the corners, edge midpoints and centroid (cheap
 * screen; refine.ts curvedQuality integrates with 125 points per cell, about 50x slower here). */
function p2MinJacobianRatio(N: Float64Array, C: Int32Array): number {
  let min = Infinity;
  const J = new Float64Array(9), dN = new Float64Array(30);
  const det = (A: Float64Array) => A[0]! * (A[4]! * A[8]! - A[5]! * A[7]!) - A[1]! * (A[3]! * A[8]! - A[5]! * A[6]!) + A[2]! * (A[3]! * A[7]! - A[4]! * A[6]!);
  for (let c = 0; c < C.length / 10; c++) {
    const v = (a: number, k: number) => N[3 * C[10 * c + a]! + k]!;
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) J[3 * r + k] = v(k + 1, r) - v(0, r);
    const d0 = det(J);
    for (const L of JPTS) {
      // dN_a / dxi_k, xi_k = L_k (k = 1..3), L_0 = 1 - sum
      for (let k = 0; k < 3; k++) {
        const dL = (i: number) => (i === 0 ? -1 : i === k + 1 ? 1 : 0);
        for (let i = 0; i < 4; i++) dN[3 * i + k] = (4 * L[i]! - 1) * dL(i);
        TET_E.forEach(([i, j], e) => { dN[3 * (4 + e) + k] = 4 * (dL(i) * L[j]! + L[i]! * dL(j)); });
      }
      J.fill(0);
      for (let a = 0; a < 10; a++) for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) J[3 * r + k]! += v(a, r) * dN[3 * a + k]!;
      min = Math.min(min, det(J) / d0);
    }
  }
  return min;
}

/** Quality of a tet4 / tet10 mesh: straight-cell metrics (tetQuality on the corners; volume of the straight cells)
 * and, for tet10, the P2 Jacobian screen. Used for meshStack output and its nested refinements. */
export function stackQuality(m: Mesh): Record<string, number> {
  const p2 = m.cells.type === 'tet10';
  const q = tetQuality(m.nodes, m.cells.conn, p2 ? 10 : 4);
  const out: Record<string, number> = { minShape: q.minShape, meanShape: q.meanShape, nPoor: q.nPoor, nInverted: q.nInverted, volume: q.measure };
  if (q.minDihedralDeg !== undefined) { out.minDihedralDeg = q.minDihedralDeg; out.maxDihedralDeg = q.maxDihedralDeg!; }
  if (p2) out.minJacobianRatioP2 = p2MinJacobianRatio(m.nodes, m.cells.conn);
  return out;
}

export function meshStack(st: Stack, o: StackMeshOptions = {}): Mesh {
  const t0 = performance.now();
  const order = o.order ?? 1;
  const ov = st.overlay;
  const m2 = mesh2d(ov, { ...o.mesh2d, order });
  const t2d = performance.now();
  const nL = st.layers.length;
  const npe2 = order === 2 ? 6 : 3;
  const T = m2.cells.conn, TD = m2.cells.domain, nT = TD.length;
  let N = 0;
  for (let t = 0; t < nT; t++) for (let i = 0; i < 3; i++) N = Math.max(N, T[npe2 * t + i]! + 1);
  const X2 = m2.nodes;
  // counter-clockwise corner triples
  const tri = new Int32Array(3 * nT);
  for (let t = 0; t < nT; t++) {
    const a = T[npe2 * t]!, b = T[npe2 * t + 1]!, c = T[npe2 * t + 2]!;
    const ar = (X2[2 * b]! - X2[2 * a]!) * (X2[2 * c + 1]! - X2[2 * a + 1]!) - (X2[2 * c]! - X2[2 * a]!) * (X2[2 * b + 1]! - X2[2 * a + 1]!);
    tri.set(ar >= 0 ? [a, b, c] : [a, c, b], 3 * t);
  }
  // z planes
  const hz = o.dz ?? o.mesh2d?.hmax ?? detmath.hyp2(ov.bbox[2] - ov.bbox[0], ov.bbox[3] - ov.bbox[1]) / 20;
  const zs: number[] = [st.layers[0]!.z[0]];
  const layerStart: number[] = [];
  for (const L of st.layers) {
    layerStart.push(zs.length - 1);
    const dz = L.nz ? (L.z[1] - L.z[0]) / L.nz : (L.dz ?? hz);
    zs.push(...subdivideInterval(L.z[0], L.z[1], dz));
  }
  layerStart.push(zs.length - 1);
  const nP = zs.length;
  const gx = (g: number) => X2[2 * (g % N)]!, gy = (g: number) => X2[2 * (g % N) + 1]!, gz = (g: number) => zs[Math.floor(g / N)]!;
  const vol = (a: number, b: number, c: number, d: number) => {
    const ux = gx(b) - gx(a), uy = gy(b) - gy(a), uz = gz(b) - gz(a);
    const vx = gx(c) - gx(a), vy = gy(c) - gy(a), vz = gz(c) - gz(a);
    const wx = gx(d) - gx(a), wy = gy(d) - gy(a), wz = gz(d) - gz(a);
    return ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx);
  };
  // cells (global ids before compaction)
  const used = new Uint8Array(N * nP);
  const conn: number[] = [], dom: number[] = [];
  const G = new Int32Array(6);
  for (let k = 0; k < nL; k++)
    for (let t = 0; t < nT; t++) {
      const d3 = st.dom3[TD[t]! * nL + k]!;
      if (d3 < 0) continue;
      for (let p = layerStart[k]!; p < layerStart[k + 1]!; p++) {
        for (let i = 0; i < 3; i++) { G[i] = tri[3 * t + i]! + N * p; G[i + 3] = tri[3 * t + i]! + N * (p + 1); }
        for (let i = 0; i < 6; i++) used[G[i]!] = 1;
        splitPrism(G, (a, b, c, d) => {
          if (vol(a, b, c, d) < 0) conn.push(a, c, b, d); else conn.push(a, b, c, d);
          dom.push(d3);
        });
      }
    }
  // facets: caps, plane by plane
  const fconn: number[] = [], fb: number[] = [];
  for (let j = 0; j <= nL; j++) {
    const p = layerStart[j]!;
    for (let t = 0; t < nT; t++) {
      const f = TD[t]!;
      const b = j > 0 ? st.dom3[f * nL + j - 1]! : -1, a = j < nL ? st.dom3[f * nL + j]! : -1;
      if (b < 0 && a < 0) continue;
      const ci = st.capIndex.get(capKey(j, b, a));
      if (ci === undefined) throw new Error(`mesh: stack ${st.id}: no cap entity on plane ${j} for domains ${b} / ${a}`);
      const A = tri[3 * t]! + N * p, B = tri[3 * t + 1]! + N * p, C = tri[3 * t + 2]! + N * p;
      if (b >= 0) fconn.push(A, B, C); else fconn.push(A, C, B);
      fb.push(ci);
    }
  }
  // walls from the 2D boundary segments; the domain left / right of a segment from the CCW triangle holding it
  const dirTri = new Map<number, number>();
  for (let t = 0; t < nT; t++) for (const [i, j] of TRI_E) dirTri.set(tri[3 * t + i]! * N + tri[3 * t + j]!, t);
  const fnpe2 = order === 2 ? 3 : 2;
  const FS = m2.facets.conn, FB = m2.facets.boundary;
  const sideCurves = new Map<number, Curve[]>();
  const tmp: number[] = [];
  for (let s = 0; s < FB.length; s++) {
    const a = FS[fnpe2 * s]!, b = FS[fnpe2 * s + 1]!, bo = FB[s]!;
    const tl = dirTri.get(a * N + b), tr = dirTri.get(b * N + a);
    const fl = tl === undefined ? -1 : TD[tl]!, fr = tr === undefined ? -1 : TD[tr]!;
    for (let k = 0; k < nL; k++) {
      const Dl = fl >= 0 ? st.dom3[fl * nL + k]! : -1, Dr = fr >= 0 ? st.dom3[fr * nL + k]! : -1;
      if (Dl === Dr) continue;
      const b2 = st.bndSrc[bo * nL + k]!;
      const si = b2 >= 0 ? st.sideIndex[st.sideOff[k]! + b2]! : -1;
      if (si < 0) throw new Error(`mesh: stack ${st.id}: wall between domains ${Dl} / ${Dr} in layer ${st.layers[k]!.id} has no sketch boundary (overlay ${ov.entities.boundaries[bo]!.id})`);
      if (!sideCurves.has(si)) sideCurves.set(si, []);
      const outOfLeft = Dr < 0 || (Dl >= 0 && Dl < Dr);
      for (let p = layerStart[k]!; p < layerStart[k + 1]!; p++) {
        const q = outOfLeft ? [a + N * p, b + N * p, b + N * (p + 1), a + N * (p + 1)] : [a + N * p, a + N * (p + 1), b + N * (p + 1), b + N * p];
        tmp.length = 0;
        splitQuad(q, tmp);
        fconn.push(...tmp);
        fb.push(si, si);
      }
    }
  }
  // exact curves of the curved walls (projector)
  for (const e of ov.edges) {
    if (e.curve.kind === 'line') continue;
    for (let k = 0; k < nL; k++) {
      const b2 = st.bndSrc[e.boundary * nL + k]!;
      const si = b2 >= 0 ? st.sideIndex[st.sideOff[k]! + b2]! : -1;
      if (si >= 0 && sideCurves.has(si)) sideCurves.get(si)!.push(e.curve);
    }
  }
  // compaction (monotone: keeps the min-index diagonals) and P2 mid nodes
  const map = new Int32Array(N * nP).fill(-1);
  let nv = 0;
  for (let g = 0; g < used.length; g++) if (used[g]) map[g] = nv++;
  const coords: number[] = new Array(3 * nv);
  for (let g = 0; g < used.length; g++) if (map[g]! >= 0) { const i = map[g]!; coords[3 * i] = gx(g); coords[3 * i + 1] = gy(g); coords[3 * i + 2] = gz(g); }
  let C: Int32Array, FC: Int32Array;
  if (order === 1) {
    C = Int32Array.from(conn, (g) => map[g]!);
    FC = Int32Array.from(fconn, (g) => map[g]!);
  } else {
    const mid2 = new Map<number, number>();
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const a = T[6 * t + TRI_E[e]![0]]!, b = T[6 * t + TRI_E[e]![1]]!;
      mid2.set(a < b ? a * N + b : b * N + a, T[6 * t + 3 + e]!);
    }
    const mids = new Map<string, number>();
    const mid = (u: number, w: number) => {
      const key = u < w ? `${u},${w}` : `${w},${u}`;
      let id = mids.get(key);
      if (id !== undefined) return id;
      const v1 = u % N, v2 = w % N;
      let x: number, y: number;
      if (v1 === v2) { x = X2[2 * v1]!; y = X2[2 * v1 + 1]!; }
      else {
        const m = mid2.get(v1 < v2 ? v1 * N + v2 : v2 * N + v1);
        if (m === undefined) throw new Error('mesh: stack P2 lift: 3D edge without a 2D edge');
        x = X2[2 * m]!; y = X2[2 * m + 1]!;
      }
      id = coords.length / 3;
      coords.push(x, y, 0.5 * (gz(u) + gz(w)));
      mids.set(key, id);
      return id;
    };
    const nc = conn.length / 4;
    C = new Int32Array(10 * nc);
    for (let c = 0; c < nc; c++) {
      const v = [conn[4 * c]!, conn[4 * c + 1]!, conn[4 * c + 2]!, conn[4 * c + 3]!];
      for (let i = 0; i < 4; i++) C[10 * c + i] = map[v[i]!]!;
      TET_E.forEach(([i, j], e) => { C[10 * c + 4 + e] = mid(v[i]!, v[j]!); });
    }
    const nf = fconn.length / 3;
    FC = new Int32Array(6 * nf);
    for (let f = 0; f < nf; f++) {
      const v = [fconn[3 * f]!, fconn[3 * f + 1]!, fconn[3 * f + 2]!];
      for (let i = 0; i < 3; i++) FC[6 * f + i] = map[v[i]!]!;
      TRI_E.forEach(([i, j], e) => {
        const key = v[i]! < v[j]! ? `${v[i]},${v[j]}` : `${v[j]},${v[i]}`;
        const id = mids.get(key);
        if (id === undefined) throw new Error('mesh: stack facet edge is not a cell edge');
        FC[6 * f + 3 + e] = id;
      });
    }
  }
  const nodes = Float64Array.from(coords);
  const D = Int32Array.from(dom), FBo = Int32Array.from(fb);
  const mesh: Mesh = {
    dim: 3, nodes, cells: { type: order === 2 ? 'tet10' : 'tet4', conn: C, domain: D },
    facets: { type: order === 2 ? 'tri6' : 'tri3', conn: FC, boundary: FBo }, entities: st.entities, hash: meshHash(nodes, C),
  };
  mesh.tagHash = tagHash(D, FC, FBo, [...st.entities.domains, ...st.entities.boundaries].map((e) => e.id));
  mesh.quality = stackQuality(mesh);
  const md = mesh.quality.minDihedralDeg;
  const flat = md !== undefined && md < FLAT_TET_DEG
    ? [`flat tetrahedra: min dihedral angle ${md.toFixed(2)} deg (below ${FLAT_TET_DEG} deg): a layer much thinner than the in-plane cell size; refine that layer's sketch edges (mesh.refine) or lower mesh.size.hmax`]
    : [];
  const warnings = [...new Set([...st.warnings, ...(m2.warnings ?? []), ...flat])];
  if (warnings.length) mesh.warnings = warnings;
  mesh.stats = {
    nodes: nodes.length / 3, cells: dom.length, facets: fb.length, tris2d: nT, planes: nP, layers: nL,
    mesh2d_ms: t2d - t0, total_ms: performance.now() - t0,
  };
  // projector for nested refinement: nodes on a curved wall onto its exact 2D curve (z kept)
  const pq: [number, number] = [0, 0];
  projectors.set(mesh, (b, p) => {
    const cs = sideCurves.get(b);
    if (!cs?.length) return;
    pq[0] = p[0]!; pq[1] = p[1]!;
    let best = Infinity, bx = p[0]!, by = p[1]!;
    for (const cv of cs)
      for (const g of [0, 0.25, 0.5, 0.75, 1]) {
        const q = point(cv, project(cv, pq, g));
        const d = detmath.hyp2(q[0] - pq[0], q[1] - pq[1]);
        if (d < best) { best = d; bx = q[0]; by = q[1]; }
      }
    p[0] = bx; p[1] = by;
  });
  return mesh;
}
