// SPDX-License-Identifier: GPL-3.0-or-later
// Nested uniform (red) refinement for tri3 / tri6 / tet4 / tet10, P1 -> P2 conversion with boundary projection, and
// measures (area, volume, boundary area) by collapsed Gauss-Legendre quadrature on the P2 geometry map.
//
// Nesting: every child is the image of a reference sub-simplex under its parent's geometry map (affine for P1,
// quadratic for P2), so the refined mesh reproduces the parent geometry exactly. The exception is new nodes on curved
// boundary facets, which go to the exact curve instead:
// - 2D: through the mesh's facetCurve / facetParam and the Geometry2D;
// - any dimension: through a `project(boundary, p)` hook, e.g. cylinderProjector.
// Domain, boundary and entity tables are kept; old nodes keep their indices (new nodes are appended), so pointNode
// stays valid.
// Node orders (VTK): tri6 = corners, (01) (12) (20); tet10 = corners, (01) (12) (02) (03) (13) (23); line3 = a b mid.

import { type Geometry2D, type Mesh, point, detmath } from '@amp/geom';

const { hyp2, hyp3 } = detmath;
import { meshHash, tagHash } from './sha256.ts';
import { triQuality, tetQuality } from './quality.ts';

export type Projector = (boundary: number, p: Float64Array) => void;

const TRI_E = [[0, 1], [1, 2], [2, 0]] as const;
const TET_E = [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]] as const;
const TRI_F_E = TRI_E;

/** P2 shape functions at barycentric L (nv = 3 or 4 vertices, edges in the order above). */
function p2N(L: number[], edges: ReadonlyArray<readonly [number, number]>, out: number[]) {
  const nv = L.length;
  for (let i = 0; i < nv; i++) out[i] = L[i]! * (2 * L[i]! - 1);
  edges.forEach(([i, j], k) => { out[nv + k] = 4 * L[i]! * L[j]!; });
  return out;
}
/** dN/dL_k (k = 1..d, with L_0 = 1 - sum) of the P2 basis. */
function p2dN(L: number[], edges: ReadonlyArray<readonly [number, number]>, k: number, out: number[]) {
  const nv = L.length;
  const dL = (i: number) => (i === k ? 1 : 0) - (i === 0 ? 1 : 0);
  for (let i = 0; i < nv; i++) out[i] = (4 * L[i]! - 1) * dL(i);
  edges.forEach(([i, j], e) => { out[nv + e] = 4 * (dL(i) * L[j]! + L[i]! * dL(j)); });
  return out;
}

// collapsed Gauss-Legendre (Duffy), 5 points per direction on [0, 1]
const GX = [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664].map((x) => 0.5 * (1 + x));
const GW = [0.23692688505618908, 0.47862867049936647, 0.5688888888888889, 0.47862867049936647, 0.23692688505618908].map((w) => 0.5 * w);
/** Quadrature on the reference simplex in barycentric coordinates; weights sum to the reference measure (1/2, 1/6). */
export function simplexRule(d: 2 | 3): Array<{ L: number[]; w: number }> {
  const out: Array<{ L: number[]; w: number }> = [];
  for (let a = 0; a < 5; a++)
    for (let b = 0; b < 5; b++) {
      const s = GX[a]!, t = GX[b]!;
      if (d === 2) { const L1 = s, L2 = t * (1 - s); out.push({ L: [1 - L1 - L2, L1, L2], w: GW[a]! * GW[b]! * (1 - s) }); continue; }
      for (let c = 0; c < 5; c++) {
        const r = GX[c]!;
        const L1 = s, L2 = t * (1 - s), L3 = r * (1 - s) * (1 - t);
        out.push({ L: [1 - L1 - L2 - L3, L1, L2, L3], w: GW[a]! * GW[b]! * GW[c]! * (1 - s) * (1 - s) * (1 - t) });
      }
    }
  return out;
}

interface CellInfo { nv: number; d: 2 | 3; edges: ReadonlyArray<readonly [number, number]>; p2: boolean }
const INFO: Record<string, CellInfo> = {
  tri3: { nv: 3, d: 2, edges: TRI_E, p2: false }, tri6: { nv: 3, d: 2, edges: TRI_E, p2: true },
  tet4: { nv: 4, d: 3, edges: TET_E, p2: false }, tet10: { nv: 4, d: 3, edges: TET_E, p2: true },
};

/** Physical point of cell e at barycentric L (P1 or P2 map), for a mesh with spatial dimension D. */
function mapPoint(m: Mesh, ci: CellInfo, e: number, L: number[], out: Float64Array, N: number[] = []) {
  const D = m.dim, npe = ci.p2 ? ci.nv + ci.edges.length : ci.nv;
  out.fill(0);
  if (ci.p2) p2N(L, ci.edges, N);
  for (let a = 0; a < npe; a++) {
    const w = ci.p2 ? N[a]! : L[a]!;
    const v = m.cells.conn[npe * e + a]!;
    for (let c = 0; c < D; c++) out[c]! += w * m.nodes[D * v + c]!;
  }
  return out;
}

// red refinement of the reference simplex: children as lists of barycentric points (parent vertices and edge mids)
const MID = (i: number, j: number, nv: number) => { const L = new Array(nv).fill(0); L[i] = 0.5; L[j] = 0.5; return L; };
const VTX = (i: number, nv: number) => { const L = new Array(nv).fill(0); L[i] = 1; return L; };

export interface RefineOptions {
  /** 2D: geometry used for exact curves (with mesh.facetCurve / facetParam) */
  geometry?: Geometry2D;
  /** boundary projection hook for new nodes on facets (any dimension); applied after the exact-curve rule */
  project?: Projector;
}

/** One level of nested uniform refinement (each cell -> 4 (2D) or 8 (3D) children). */
export function refineUniform(m: Mesh, o: RefineOptions = {}): Mesh {
  const t0 = performance.now();
  const ci = INFO[m.cells.type];
  if (!ci) throw new Error(`mesh: refineUniform supports tri3 / tri6 / tet4 / tet10, not ${m.cells.type}`);
  const D = m.dim, nv = ci.nv, npe = ci.p2 ? nv + ci.edges.length : nv;
  const nOld = m.nodes.length / D;
  const nCell = m.cells.domain.length;
  const coords: number[] = Array.from(m.nodes);
  const key = new Map<string, number>();
  const tmp = new Float64Array(D);
  const N: number[] = [];
  // a new node, keyed by the parent cell's local definition made global: sorted global ids of the defining nodes
  const nodeAt = (k: string, compute: () => Float64Array) => {
    let id = key.get(k);
    if (id !== undefined) return id;
    const p = compute();
    id = coords.length / D;
    for (let c = 0; c < D; c++) coords.push(p[c]!);
    key.set(k, id);
    return id;
  };
  const pairKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  // level-1 nodes: P1 parents get new mid-edge nodes; P2 parents already have them
  const local: number[][] = []; // per cell: [vertex ids..., level-1 mid ids in ci.edges order]
  for (let e = 0; e < nCell; e++) {
    const ids: number[] = [];
    for (let a = 0; a < nv; a++) ids.push(m.cells.conn[npe * e + a]!);
    ci.edges.forEach(([i, j], k) => {
      if (ci.p2) ids.push(m.cells.conn[npe * e + nv + k]!);
      else ids.push(nodeAt(pairKey(ids[i]!, ids[j]!), () => mapPoint(m, ci, e, MID(i, j, nv), tmp, N)));
    });
    local.push(ids);
  }
  // children (indices into the parent's level-1 node list: vertices 0..nv-1, mids nv + k)
  const midIdx = (i: number, j: number) => nv + ci.edges.findIndex(([a, b]) => (a === i && b === j) || (a === j && b === i));
  const pos = (e: number, li: number) => { // physical position of local level-1 node li (for the octahedron diagonal)
    const v = local[e]![li]!;
    return [coords[D * v]!, coords[D * v + 1]!, D === 3 ? coords[D * v + 2]! : 0];
  };
  const childrenOf = (e: number): number[][] => {
    if (nv === 3) {
      const m01 = midIdx(0, 1), m12 = midIdx(1, 2), m20 = midIdx(2, 0);
      return [[0, m01, m20], [m01, 1, m12], [m20, m12, 2], [m01, m12, m20]];
    }
    const M = (i: number, j: number) => midIdx(i, j);
    const ch = [[0, M(0, 1), M(0, 2), M(0, 3)], [M(0, 1), 1, M(1, 2), M(1, 3)], [M(0, 2), M(1, 2), 2, M(2, 3)], [M(0, 3), M(1, 3), M(2, 3), 3]];
    // octahedron: shortest of the three diagonals; ring ordered A, B, A', B' over the two remaining opposite pairs
    const pairs = [[M(0, 1), M(2, 3)], [M(0, 2), M(1, 3)], [M(0, 3), M(1, 2)]] as const;
    let best = 0, bl = Infinity;
    pairs.forEach(([p, q], k) => { const a = pos(e, p), b = pos(e, q); const l = hyp3(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!); if (l < bl) { bl = l; best = k; } });
    const [p, q] = pairs[best]!, [A, A2] = pairs[(best + 1) % 3]!, [B, B2] = pairs[(best + 2) % 3]!;
    const ring = [A, B, A2, B2];
    for (let r = 0; r < 4; r++) ch.push([p, q, ring[r]!, ring[(r + 1) % 4]!]);
    return ch;
  };
  // barycentric of local level-1 nodes in the parent
  const baryOf = (li: number) => (li < nv ? VTX(li, nv) : MID(ci.edges[li - nv]![0], ci.edges[li - nv]![1], nv));
  const outConn: number[] = [], outDom: number[] = [];
  for (let e = 0; e < nCell; e++) {
    const ids = local[e]!;
    for (const ch0 of childrenOf(e)) {
      const ch = ch0.slice();
      if (nv === 4) {
        // positive orientation in the parent's reference frame (the parent itself is positively oriented)
        const B = ch.map(baryOf);
        const u = [1, 2, 3].map((c) => B[1]![c]! - B[0]![c]!), v = [1, 2, 3].map((c) => B[2]![c]! - B[0]![c]!), w = [1, 2, 3].map((c) => B[3]![c]! - B[0]![c]!);
        const det = u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
        if (det < 0) { const t = ch[2]!; ch[2] = ch[3]!; ch[3] = t; }
      }
      const cv = ch.map((li) => ids[li]!);
      if (ci.p2) {
        // child mid nodes: parent P2 map at the child edge midpoints
        const mids = ci.edges.map(([i, j]) => {
          const La = baryOf(ch[i]!), Lb = baryOf(ch[j]!);
          return nodeAt(pairKey(cv[i]!, cv[j]!), () => mapPoint(m, ci, e, La.map((x, k) => 0.5 * (x + Lb[k]!)), tmp, N));
        });
        outConn.push(...cv, ...mids);
      } else outConn.push(...cv);
      outDom.push(m.cells.domain[e]!);
    }
  }
  // facets: split like the cell faces; exact curve / projection for the new boundary nodes
  const fType = m.facets.type;
  const fp2 = fType === 'line3' || fType === 'tri6';
  const fnv = fType === 'line2' || fType === 'line3' ? 2 : 3;
  const fnpe = fp2 ? fnv + (fnv === 2 ? 1 : 3) : fnv;
  const nF = m.facets.boundary.length;
  const fConn: number[] = [], fB: number[] = [], fCurve: number[] = [], fParam: number[] = [];
  const onBoundary = new Map<number, number>(); // node -> boundary index (new nodes on facets, for the projector)
  const hasCurve = D === 2 && !!o.geometry && !!m.facetCurve && !!m.facetParam;
  const exact = new Map<number, Float64Array>();
  for (let f = 0; f < nF; f++) {
    const b = m.facets.boundary[f]!;
    const v = Array.from({ length: fnv }, (_, a) => m.facets.conn[fnpe * f + a]!);
    if (fnv === 2) {
      const mid = fp2 ? m.facets.conn[fnpe * f + 2]! : key.get(pairKey(v[0]!, v[1]!))!;
      if (mid === undefined) throw new Error('mesh: refineUniform: facet is not an edge of a cell');
      const curve = m.facetCurve?.[f] ?? -1, ta = m.facetParam?.[2 * f] ?? 0, tb = m.facetParam?.[2 * f + 1] ?? 1, tm = 0.5 * (ta + tb);
      const seg = [[v[0]!, mid, ta, tm], [mid, v[1]!, tm, tb]] as const;
      if (!fp2 && hasCurve && curve >= 0) exact.set(mid, Float64Array.from(point(o.geometry!.edges[curve]!.curve, tm)));
      for (const [a, c, s0, s1] of seg) {
        if (fp2) {
          const q = key.get(pairKey(a, c));
          if (q === undefined) throw new Error('mesh: refineUniform: facet child edge not found in the cells');
          if (hasCurve && curve >= 0) exact.set(q, Float64Array.from(point(o.geometry!.edges[curve]!.curve, 0.5 * (s0 + s1))));
          onBoundary.set(q, b);
          fConn.push(a, c, q);
        } else fConn.push(a, c);
        fB.push(b); fCurve.push(curve); fParam.push(s0, s1);
      }
      onBoundary.set(mid, b);
    } else {
      const mid = (i: number, j: number, k: number) => (fp2 ? m.facets.conn[fnpe * f + 3 + k]! : key.get(pairKey(v[i]!, v[j]!))!);
      const m01 = mid(0, 1, 0), m12 = mid(1, 2, 1), m20 = mid(2, 0, 2);
      for (const t of [[v[0]!, m01, m20], [m01, v[1]!, m12], [m20, m12, v[2]!], [m01, m12, m20]]) {
        if (fp2) {
          const q = TRI_F_E.map(([i, j]) => {
            const id = key.get(pairKey(t[i]!, t[j]!));
            if (id === undefined) throw new Error('mesh: refineUniform: facet child edge not found in the cells');
            onBoundary.set(id, b);
            return id;
          });
          fConn.push(...t, ...q);
        } else fConn.push(...t);
        fB.push(b);
      }
      for (const x of [m01, m12, m20]) onBoundary.set(x, b);
    }
  }
  const nodes = Float64Array.from(coords);
  for (const [v, p] of exact) nodes.set(p, D * v);
  if (o.project) {
    const p = new Float64Array(D);
    for (const [v, b] of onBoundary) {
      if (v < nOld) continue;
      for (let c = 0; c < D; c++) p[c] = nodes[D * v + c]!;
      o.project(b, p);
      nodes.set(p, D * v);
    }
  }
  const conn = Int32Array.from(outConn), domain = Int32Array.from(outDom), fc = Int32Array.from(fConn), fb = Int32Array.from(fB);
  const out: Mesh = {
    dim: m.dim, nodes, cells: { type: m.cells.type, conn, domain }, facets: { type: fType, conn: fc, boundary: fb },
    entities: m.entities, hash: meshHash(nodes, conn),
  };
  if (m.axisym !== undefined) out.axisym = m.axisym;
  if (m.pointNode) out.pointNode = m.pointNode;
  if (fnv === 2 && m.facetCurve) { out.facetCurve = Int32Array.from(fCurve); out.facetParam = Float64Array.from(fParam); }
  out.tagHash = tagHash(domain, fc, fb, [...m.entities.domains, ...m.entities.boundaries, ...(m.entities.points ?? [])].map((x) => x.id));
  out.quality = curvedQuality(out);
  out.stats = { nodes: nodes.length / D, cells: domain.length, facets: fb.length, refine_ms: performance.now() - t0 };
  return out;
}

/** P1 -> P2 (tri3 -> tri6, tet4 -> tet10; facets line2 -> line3, tri3 -> tri6). Mid nodes: straight midpoints, then the
 * exact curve (2D, geometry + facetCurve) or `project` for nodes on facets. */
export function toP2(m: Mesh, o: RefineOptions = {}): Mesh {
  const ci = INFO[m.cells.type];
  if (!ci || ci.p2) throw new Error(`mesh: toP2 needs tri3 or tet4, not ${m.cells.type}`);
  const D = m.dim, nv = ci.nv, nCell = m.cells.domain.length;
  const coords: number[] = Array.from(m.nodes);
  const key = new Map<string, number>();
  const mid = (a: number, b: number) => {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    let id = key.get(k);
    if (id !== undefined) return id;
    id = coords.length / D;
    for (let c = 0; c < D; c++) coords.push(0.5 * (m.nodes[D * a + c]! + m.nodes[D * b + c]!));
    key.set(k, id);
    return id;
  };
  const conn: number[] = [];
  for (let e = 0; e < nCell; e++) {
    const v = Array.from({ length: nv }, (_, a) => m.cells.conn[nv * e + a]!);
    conn.push(...v, ...ci.edges.map(([i, j]) => mid(v[i]!, v[j]!)));
  }
  const fnv = m.facets.type === 'line2' ? 2 : 3;
  const fConn: number[] = [];
  const onB = new Map<number, number>();
  const nodes0 = () => Float64Array.from(coords);
  const exact = new Map<number, Float64Array>();
  for (let f = 0; f < m.facets.boundary.length; f++) {
    const v = Array.from({ length: fnv }, (_, a) => m.facets.conn[fnv * f + a]!);
    const ms = (fnv === 2 ? [[0, 1]] : TRI_F_E).map(([i, j]) => mid(v[i]!, v[j]!));
    fConn.push(...v, ...ms);
    for (const x of ms) onB.set(x, m.facets.boundary[f]!);
    if (fnv === 2 && D === 2 && o.geometry && m.facetCurve && m.facetCurve[f]! >= 0)
      exact.set(ms[0]!, Float64Array.from(point(o.geometry.edges[m.facetCurve[f]!]!.curve, 0.5 * (m.facetParam![2 * f]! + m.facetParam![2 * f + 1]!))));
  }
  const nodes = nodes0();
  for (const [v, p] of exact) nodes.set(p, D * v);
  if (o.project) {
    const p = new Float64Array(D);
    for (const [v, b] of onB) { for (let c = 0; c < D; c++) p[c] = nodes[D * v + c]!; o.project(b, p); nodes.set(p, D * v); }
  }
  const C = Int32Array.from(conn), FC = Int32Array.from(fConn);
  const out: Mesh = {
    ...m, nodes, cells: { type: nv === 3 ? 'tri6' : 'tet10', conn: C, domain: m.cells.domain },
    facets: { type: fnv === 2 ? 'line3' : 'tri6', conn: FC, boundary: m.facets.boundary }, hash: meshHash(nodes, C),
  };
  out.tagHash = tagHash(out.cells.domain, FC, out.facets.boundary, [...m.entities.domains, ...m.entities.boundaries, ...(m.entities.points ?? [])].map((x) => x.id));
  out.quality = curvedQuality(out);
  return out;
}

/** Projector onto a cylinder side (radius a, axis through `base` along x | y | z) for the given boundary indices. */
export function cylinderProjector(boundaries: number[], radius: number, base: [number, number, number], axis: 'x' | 'y' | 'z'): Projector {
  const set = new Set(boundaries);
  const ax = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const [u, v] = [0, 1, 2].filter((k) => k !== ax) as [number, number];
  return (b, p) => {
    if (!set.has(b)) return;
    const bu = base[u]!, bv = base[v]!;
    const du = p[u]! - bu, dv = p[v]! - bv, r = hyp2(du, dv);
    if (r > 0) { p[u] = bu + (du * radius) / r; p[v] = bv + (dv * radius) / r; }
  };
}

/** Area (2D) or volume (3D) by quadrature on the cell map, and the minimum Jacobian ratio over the quadrature points
 * (detJ relative to the straight cell; < 0 means an invalid curved cell). */
export function curvedQuality(m: Mesh): Record<string, number> {
  const ci = INFO[m.cells.type];
  if (!ci) return {};
  const D = m.dim, d = ci.d, nv = ci.nv, npe = ci.p2 ? nv + ci.edges.length : nv;
  if (!ci.p2) {
    const q = d === 2 ? triQuality(m.nodes, m.cells.conn) : tetQuality(m.nodes, m.cells.conn);
    const r: Record<string, number> = { minShape: q.minShape, meanShape: q.meanShape, nInverted: q.nInverted, [d === 2 ? 'area' : 'volume']: q.measure };
    if (q.minAngleDeg !== undefined) r.minAngleDeg = q.minAngleDeg;
    if (q.minDihedralDeg !== undefined) r.minDihedralDeg = q.minDihedralDeg;
    return r;
  }
  const rule = simplexRule(d);
  const dN: number[] = [];
  let meas = 0, minJ = Infinity;
  const J = new Float64Array(9);
  for (let e = 0; e < m.cells.domain.length; e++) {
    // straight reference: vertices only
    const X = (a: number, c: number) => m.nodes[D * m.cells.conn[npe * e + a]! + c]!;
    let det0: number;
    if (d === 2) det0 = (X(1, 0) - X(0, 0)) * (X(2, 1) - X(0, 1)) - (X(2, 0) - X(0, 0)) * (X(1, 1) - X(0, 1));
    else {
      const a = [0, 1, 2].map((c) => X(1, c) - X(0, c)), b = [0, 1, 2].map((c) => X(2, c) - X(0, c)), g = [0, 1, 2].map((c) => X(3, c) - X(0, c));
      det0 = a[0]! * (b[1]! * g[2]! - b[2]! * g[1]!) - a[1]! * (b[0]! * g[2]! - b[2]! * g[0]!) + a[2]! * (b[0]! * g[1]! - b[1]! * g[0]!);
    }
    for (const { L, w } of rule) {
      for (let k = 1; k <= d; k++) {
        p2dN(L, ci.edges, k, dN);
        for (let c = 0; c < d; c++) {
          let s = 0;
          for (let a = 0; a < npe; a++) s += dN[a]! * X(a, c);
          J[3 * c + (k - 1)] = s;
        }
      }
      const det = d === 2 ? J[0]! * J[4]! - J[1]! * J[3]!
        : J[0]! * (J[4]! * J[8]! - J[5]! * J[7]!) - J[1]! * (J[3]! * J[8]! - J[5]! * J[6]!) + J[2]! * (J[3]! * J[7]! - J[4]! * J[6]!);
      meas += w * det;
      minJ = Math.min(minJ, det / det0);
    }
  }
  return { [d === 2 ? 'area' : 'volume']: meas, minJacobianRatioP2: minJ };
}

/** Area of the facets of the given boundaries (3D: tri3 / tri6 facets; 2D: length of line2 / line3 facets). */
export function boundaryMeasure(m: Mesh, boundaries: number[]): number {
  const set = new Set(boundaries), D = m.dim, t = m.facets.type;
  const fp2 = t === 'line3' || t === 'tri6', fnv = t === 'line2' || t === 'line3' ? 2 : 3;
  const npe = fp2 ? fnv + (fnv === 2 ? 1 : 3) : fnv;
  let s = 0;
  const X = (f: number, a: number, c: number) => m.nodes[D * m.facets.conn[npe * f + a]! + c]!;
  const dN: number[] = [];
  for (let f = 0; f < m.facets.boundary.length; f++) {
    if (!set.has(m.facets.boundary[f]!)) continue;
    if (fnv === 2) {
      // line: 5-point Gauss on [0, 1], P2 map x = sum N_i(t) x_i with nodes a, b, mid
      for (let q = 0; q < 5; q++) {
        const u = GX[q]!;
        const dn = fp2 ? [4 * u - 3, 4 * u - 1, 4 - 8 * u] : [-1, 1];
        let gx = 0, gy = 0;
        dn.forEach((w, a) => { gx += w * X(f, a, 0); gy += w * X(f, a, 1); });
        s += GW[q]! * 2 * 0.5 * hyp2(gx, gy);
      }
      continue;
    }
    for (const { L, w } of simplexRule(2)) {
      const g: number[][] = [];
      for (let k = 1; k <= 2; k++) {
        if (fp2) p2dN(L, TRI_F_E, k, dN);
        else { dN[0] = -1; dN[1] = k === 1 ? 1 : 0; dN[2] = k === 2 ? 1 : 0; }
        g.push([0, 1, 2].map((c) => { let x = 0; for (let a = 0; a < npe; a++) x += dN[a]! * X(f, a, c); return x; }));
      }
      const [a, b] = g as [number[], number[]];
      s += w * hyp3(a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!);
    }
  }
  return s;
}
