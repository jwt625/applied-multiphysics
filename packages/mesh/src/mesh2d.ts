// SPDX-License-Identifier: GPL-3.0-or-later
// 2D meshing front end: Geometry2D (@amp/geom) -> C2 Mesh. Size field from global hmax / grade plus local refinement
// by entity selection (domains, boundaries, points); curves discretized by the size field and a maximum turning angle;
// PSLG checked for crossings (densified and retried); CDT quality refinement (cdt2d.mjs); tri3 or tri6 with mid-edge
// nodes on the exact curves; line2 / line3 facets carrying boundary entity indices; sha-256 hash (C2).

import { orient2d } from 'robust-predicates';
import { type Geometry2D, type Curve, type Mesh, point, curvature, finePieces, resolveSelection } from '@amp/geom';
import { meshDomain, createSizeField } from './cdt2d.mjs';
import { meshHash, tagHash } from './sha256.ts';
import { triQuality } from './quality.ts';

export interface Refine2D {
  /** entity ids: `dom:...`, `bnd:...`, `pnt:...` (pieces of a split id are included) */
  select: string[];
  /** target edge length at the selection (m) */
  h: number;
  /** growth of h per unit distance away from the selection (default: global grade) */
  grade?: number;
}

export interface MeshOptions2D {
  /** global maximum edge length (m); default bbox diagonal / 20 */
  hmax?: number;
  /** refinement floor (m); default min(hmax, refine h) / 50 */
  hmin?: number;
  /** size growth per unit distance (dimensionless); default 0.3 */
  grade?: number;
  /** radius-edge bound B (min angle = asin(1 / (2 B))); default 1.35 (21.7 deg) */
  radiusEdge?: number;
  /** maximum turning angle per boundary segment on curves (deg); default 10 */
  maxAngleDeg?: number;
  refine?: Refine2D[];
  order?: 1 | 2;
  /** vertex budget; default 4e6 */
  maxVertices?: number;
}

/** Ray-cast classifier on a segment set with per-segment left / right domains (horizontal bands). */
export function makeClassifier(S: Float64Array, left: Int32Array, right: Int32Array, y0: number, y1: number) {
  const ns = S.length / 4;
  const NB = Math.max(16, Math.min(4096, ns));
  const bh = (y1 - y0) / NB || 1;
  const bands: number[][] = Array.from({ length: NB }, () => []);
  for (let s = 0; s < ns; s++) {
    const a = S[4 * s + 1]!, b = S[4 * s + 3]!;
    if (a === b) continue;
    const lo = Math.max(0, Math.floor((Math.min(a, b) - y0) / bh)), hi = Math.min(NB - 1, Math.floor((Math.max(a, b) - y0) / bh));
    for (let q = lo; q <= hi; q++) bands[q]!.push(s);
  }
  return (x: number, y: number): number => {
    const q = Math.min(NB - 1, Math.max(0, Math.floor((y - y0) / bh)));
    let best = Infinity, dom = -1;
    for (const s of bands[q]!) {
      const ax = S[4 * s]!, ay = S[4 * s + 1]!, bx = S[4 * s + 2]!, by = S[4 * s + 3]!;
      if ((ay <= y) === (by <= y)) continue;
      const xi = ax + ((y - ay) * (bx - ax)) / (by - ay);
      if (xi > x && xi < best) { best = xi; dom = by > ay ? left[s]! : right[s]!; }
    }
    return dom;
  };
}

/** Fine segment set of each geometry edge (topology resolution), for classification and size sources. */
function fineSegments(g: Geometry2D) {
  const parts: number[] = [], L: number[] = [], R: number[] = [], edgeOf: number[] = [];
  g.edges.forEach((e, k) => {
    const n = e.curve.kind === 'line' ? 1 : finePieces(e.curve);
    let p = [g.vertices[2 * e.v0]!, g.vertices[2 * e.v0 + 1]!];
    for (let i = 1; i <= n; i++) {
      const q = i === n ? [g.vertices[2 * e.v1]!, g.vertices[2 * e.v1 + 1]!] : point(e.curve, i / n);
      parts.push(p[0]!, p[1]!, q[0]!, q[1]!);
      L.push(e.left); R.push(e.right); edgeOf.push(k);
      p = q;
    }
  });
  return { S: Float64Array.from(parts), L: Int32Array.from(L), R: Int32Array.from(R), edgeOf: Int32Array.from(edgeOf) };
}

interface Pslg { verts: Float64Array; segs: Array<{ a: number; b: number; tag: number; left: number; right: number; curve: number; ta: number; tb: number; edge: number }> }

function discretize(g: Geometry2D, sizeAt: (x: number, y: number) => number, maxAngle: number, mult: Float64Array): Pslg {
  const V: number[] = Array.from(g.vertices);
  const segs: Pslg['segs'] = [];
  g.edges.forEach((e, k) => {
    const cv = e.curve;
    const ns = cv.kind === 'line' ? 32 : Math.max(64, 2 * finePieces(cv));
    const cum = new Float64Array(ns + 1);
    let prev = point(cv, 0);
    for (let i = 1; i <= ns; i++) {
      const tm = (i - 0.5) / ns, p = point(cv, i / ns), pm = point(cv, tm);
      const ds = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      const rho = Math.max(1 / sizeAt(pm[0], pm[1]), Math.abs(curvature(cv, tm)) / maxAngle) * mult[k]!;
      cum[i] = cum[i - 1]! + rho * ds;
      prev = p;
    }
    const tot = cum[ns]!;
    let n = Math.max(1, Math.ceil(tot - 1e-9));
    if (cv.kind !== 'line') n = Math.max(2, n);
    let last = e.v0, lastT = 0, j = 1;
    for (let q = 1; q < n; q++) {
      const target = (q * tot) / n;
      while (j < ns && cum[j]! < target) j++;
      const f = (target - cum[j - 1]!) / (cum[j]! - cum[j - 1]! || 1);
      const t = (j - 1 + f) / ns;
      const p = point(cv, t);
      const id = V.length / 2;
      V.push(p[0], p[1]);
      segs.push({ a: last, b: id, tag: e.boundary, left: e.left, right: e.right, curve: cv.kind === 'line' ? -1 : k, ta: lastT, tb: t, edge: k });
      last = id; lastT = t;
    }
    segs.push({ a: last, b: e.v1, tag: e.boundary, left: e.left, right: e.right, curve: cv.kind === 'line' ? -1 : k, ta: lastT, tb: 1, edge: k });
  });
  return { verts: Float64Array.from(V), segs };
}

/** Edges (by geometry edge index) whose PSLG segments cross or touch another segment improperly. */
function crossingEdges(P: Pslg, edgeOfSeg: Int32Array): Set<number> {
  const V = P.verts, S = P.segs, n = S.length;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, L = 0;
  for (const s of S) {
    for (const v of [s.a, s.b]) { x0 = Math.min(x0, V[2 * v]!); x1 = Math.max(x1, V[2 * v]!); y0 = Math.min(y0, V[2 * v + 1]!); y1 = Math.max(y1, V[2 * v + 1]!); }
    L += Math.hypot(V[2 * s.a]! - V[2 * s.b]!, V[2 * s.a + 1]! - V[2 * s.b + 1]!);
  }
  const h = Math.max(L / n, 1e-300);
  const G = new Map<string, number[]>();
  S.forEach((s, i) => {
    const ax = V[2 * s.a]!, ay = V[2 * s.a + 1]!, bx = V[2 * s.b]!, by = V[2 * s.b + 1]!;
    for (let cx = Math.floor((Math.min(ax, bx) - x0) / h); cx <= Math.floor((Math.max(ax, bx) - x0) / h); cx++)
      for (let cy = Math.floor((Math.min(ay, by) - y0) / h); cy <= Math.floor((Math.max(ay, by) - y0) / h); cy++) {
        const k = `${cx},${cy}`;
        const l = G.get(k);
        if (l) l.push(i); else G.set(k, [i]);
      }
  });
  const bad = new Set<number>();
  const seen = new Set<number>();
  for (const l of G.values())
    for (let p = 0; p < l.length; p++)
      for (let q = p + 1; q < l.length; q++) {
        const i = l[p]!, j = l[q]!;
        const key = i < j ? i * n + j : j * n + i;
        if (seen.has(key)) continue;
        seen.add(key);
        const s = S[i]!, t = S[j]!;
        const shared = s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b;
        const ax = V[2 * s.a]!, ay = V[2 * s.a + 1]!, bx = V[2 * s.b]!, by = V[2 * s.b + 1]!;
        const cx = V[2 * t.a]!, cy = V[2 * t.a + 1]!, dx = V[2 * t.b]!, dy = V[2 * t.b + 1]!;
        const o1 = orient2d(ax, ay, bx, by, cx, cy), o2 = orient2d(ax, ay, bx, by, dx, dy);
        const o3 = orient2d(cx, cy, dx, dy, ax, ay), o4 = orient2d(cx, cy, dx, dy, bx, by);
        let hit = false;
        if (!shared) hit = (o1 > 0 ? 1 : o1 < 0 ? -1 : 0) * (o2 > 0 ? 1 : o2 < 0 ? -1 : 0) <= 0 && (o3 > 0 ? 1 : o3 < 0 ? -1 : 0) * (o4 > 0 ? 1 : o4 < 0 ? -1 : 0) <= 0
          && !(o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0 && (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx) || Math.max(ay, by) < Math.min(cy, dy) || Math.max(cy, dy) < Math.min(ay, by)));
        else {
          // sharing one endpoint: overlap only if collinear and pointing the same way
          if (o1 === 0 && o2 === 0) {
            const pv = s.a === t.a || s.a === t.b ? s.a : s.b;
            const px = V[2 * pv]!, py = V[2 * pv + 1]!;
            const u = pv === s.a ? [bx - px, by - py] : [ax - px, ay - py];
            const w = pv === t.a ? [dx - px, dy - py] : [cx - px, cy - py];
            if (u[0]! * w[0]! + u[1]! * w[1]! > 0) hit = true;
          }
        }
        if (hit) { bad.add(edgeOfSeg[i]!); bad.add(edgeOfSeg[j]!); }
      }
  return bad;
}

export function mesh2d(g: Geometry2D, opts: MeshOptions2D = {}): Mesh {
  const t0 = performance.now();
  const [bx0, by0, bx1, by1] = g.bbox;
  const diag = Math.hypot(bx1 - bx0, by1 - by0);
  const hmax = opts.hmax ?? diag / 20;
  const grade = opts.grade ?? 0.3;
  const maxAngle = ((opts.maxAngleDeg ?? 10) * Math.PI) / 180;
  if (!(hmax > 0)) throw new Error('mesh: hmax must be > 0');
  const F = fineSegments(g);
  const classify = makeClassifier(F.S, F.L, F.R, by0 - 0.01 * diag, by1 + 0.01 * diag);
  const pad = 0.01 * diag;
  const rect = { x0: bx0 - pad, y0: by0 - pad, x1: bx1 + pad, y1: by1 + pad };
  // sources from entity selections
  const sources: Array<{ segs: Float64Array; domain?: number; h0: number; grade?: number }> = [];
  const regionMax: number[] = [];
  let hminAuto = hmax;
  const segsWhere = (pred: (k: number) => boolean) => {
    const out: number[] = [];
    for (let s = 0; s < F.edgeOf.length; s++) if (pred(F.edgeOf[s]!)) out.push(F.S[4 * s]!, F.S[4 * s + 1]!, F.S[4 * s + 2]!, F.S[4 * s + 3]!);
    return Float64Array.from(out);
  };
  for (const r of opts.refine ?? []) {
    if (!(r.h > 0)) throw new Error('mesh: refine.h must be > 0');
    hminAuto = Math.min(hminAuto, r.h);
    const gr = r.grade ?? grade;
    const byKind: Record<string, string[]> = { domains: [], boundaries: [], points: [] };
    for (const id of r.select) {
      const k = id.startsWith('dom:') ? 'domains' : id.startsWith('bnd:') ? 'boundaries' : id.startsWith('pnt:') ? 'points' : null;
      if (!k) throw new Error(`mesh: refine selection '${id}' needs a dom:, bnd: or pnt: prefix`);
      byKind[k]!.push(id);
    }
    if (byKind.domains!.length)
      for (const d of resolveSelection(g.entities, 'domains', byKind.domains!, { descendants: true })) {
        regionMax[d] = Math.min(regionMax[d] ?? Infinity, r.h);
        sources.push({ segs: segsWhere((k) => g.edges[k]!.left === d || g.edges[k]!.right === d), domain: d, h0: r.h, grade: gr });
      }
    if (byKind.boundaries!.length) {
      const B = new Set(resolveSelection(g.entities, 'boundaries', byKind.boundaries!, { descendants: true }));
      sources.push({ segs: segsWhere((k) => B.has(g.edges[k]!.boundary)), h0: r.h, grade: gr });
    }
    if (byKind.points!.length)
      for (const p of resolveSelection(g.entities, 'points', byKind.points!, { descendants: true })) {
        const v = g.pointVertex[p]!;
        const x = g.vertices[2 * v]!, y = g.vertices[2 * v + 1]!;
        sources.push({ segs: Float64Array.from([x, y, x, y]), h0: r.h, grade: gr });
      }
  }
  const hmin = opts.hmin ?? hminAuto / 50;
  const sizeAt = createSizeField({ rect, maxEdge: hmax, grade, sources, regionMax, classify });
  // discretize, check crossings, densify the offending edges and retry
  const mult = new Float64Array(g.edges.length).fill(1);
  let P: Pslg | null = null;
  for (let round = 0; ; round++) {
    P = discretize(g, sizeAt, maxAngle, mult);
    const edgeOfSeg = Int32Array.from(P.segs.map((s) => s.edge));
    const bad = crossingEdges(P, edgeOfSeg);
    if (!bad.size) break;
    if (round >= 5) throw new Error(`mesh: boundary discretization still self-intersects after densification (edges ${[...bad].join(', ')})`);
    for (const e of bad) mult[e]! *= 2;
  }
  const tDisc = performance.now();
  const curvePoint = (k: number, t: number) => point(g.edges[k]!.curve, t);
  const raw = meshDomain({
    rect, verts: P.verts, segs: P.segs, classify, curvePoint, sizeAt,
    minAngleBound: opts.radiusEdge ?? 1.35, minEdge: hmin, maxVertices: opts.maxVertices ?? 4e6,
  });
  const tMesh = performance.now();
  const m = toMesh2D(g, raw, opts.order ?? 1);
  const q = triQuality(raw.nodes, raw.tri);
  m.quality = {
    minAngleDeg: q.minAngleDeg!, maxAngleDeg: q.maxAngleDeg!, maxRadiusEdge: q.maxRadiusEdge!, minShape: q.minShape,
    meanShape: q.meanShape, nPoor: q.nPoor, nInverted: q.nInverted, area: q.measure, ...(m.quality ?? {}),
  };
  const tEnd = performance.now();
  m.stats = {
    nodes: m.nodes.length / 2, cells: m.cells.domain.length, facets: m.facets.boundary.length, pslgVerts: P.verts.length / 2,
    pslgSegs: P.segs.length, segSplits: raw.stats.nSegSplits, inserts: raw.stats.nInsert, projected: raw.stats.nProjected,
    discretize_ms: tDisc - t0, cdt_ms: tMesh - tDisc, total_ms: tEnd - t0,
  };
  return m;
}

function toMesh2D(g: Geometry2D, raw: ReturnType<typeof meshDomain>, order: 1 | 2): Mesh {
  const nodes0 = raw.nodes, tri = raw.tri;
  const segInfo = new Map<number, { curve: number; ta: number; tb: number; a: number }>();
  const N = raw.nNodes;
  const ek = (a: number, b: number) => (a < b ? a * N + b : b * N + a);
  for (const s of raw.segs) segInfo.set(ek(s.a, s.b), { curve: s.curve, ta: s.ta, tb: s.tb, a: s.a });
  let nodes = nodes0, conn = tri;
  let fconn: Int32Array;
  const fb = Int32Array.from(raw.segs.map((s: { tag: number }) => s.tag));
  let minJac = 1;
  if (order === 2) {
    const mid = new Map<number, number>();
    const extra: number[] = [];
    const midOf = (a: number, b: number) => {
      const k = ek(a, b);
      let m = mid.get(k);
      if (m !== undefined) return m;
      const si = segInfo.get(k);
      let p: [number, number];
      if (si && si.curve >= 0) {
        const t = 0.5 * (si.ta + si.tb);
        p = point(g.edges[si.curve]!.curve as Curve, t);
      } else p = [0.5 * (nodes0[2 * a]! + nodes0[2 * b]!), 0.5 * (nodes0[2 * a + 1]! + nodes0[2 * b + 1]!)];
      m = N + extra.length / 2;
      extra.push(p[0], p[1]);
      mid.set(k, m);
      return m;
    };
    const nt = tri.length / 3;
    conn = new Int32Array(6 * nt);
    for (let t = 0; t < nt; t++) {
      const a = tri[3 * t]!, b = tri[3 * t + 1]!, c = tri[3 * t + 2]!;
      conn.set([a, b, c, midOf(a, b), midOf(b, c), midOf(c, a)], 6 * t);
    }
    fconn = new Int32Array(3 * raw.segs.length);
    raw.segs.forEach((s: { a: number; b: number }, i: number) => fconn.set([s.a, s.b, midOf(s.a, s.b)], 3 * i));
    nodes = new Float64Array(2 * N + extra.length);
    nodes.set(nodes0);
    nodes.set(extra, 2 * N);
    // curved-element validity: Jacobian at the corners and edge midpoints relative to the straight element
    for (let t = 0; t < nt; t++) {
      const X = (q: number) => nodes[2 * conn[6 * t + q]!]!, Y = (q: number) => nodes[2 * conn[6 * t + q]! + 1]!;
      const det0 = (X(1) - X(0)) * (Y(2) - Y(0)) - (X(2) - X(0)) * (Y(1) - Y(0));
      for (const [L1, L2] of [[0, 0], [1, 0], [0, 1], [0.5, 0], [0.5, 0.5], [0, 0.5]] as const) {
        const L0 = 1 - L1 - L2;
        // d/dL1 and d/dL2 of the P2 map (N0 = L0 (2 L0 - 1), ..., N3 = 4 L0 L1, N4 = 4 L1 L2, N5 = 4 L2 L0; L0 = 1 - L1 - L2)
        const dN1 = [1 - 4 * L0, 4 * L1 - 1, 0, 4 * (L0 - L1), 4 * L2, -4 * L2];
        const dN2 = [1 - 4 * L0, 0, 4 * L2 - 1, -4 * L1, 4 * L1, 4 * (L0 - L2)];
        let xa = 0, ya = 0, xb = 0, yb = 0;
        for (let i = 0; i < 6; i++) { xa += dN1[i]! * X(i); ya += dN1[i]! * Y(i); xb += dN2[i]! * X(i); yb += dN2[i]! * Y(i); }
        const r = (xa * yb - xb * ya) / det0;
        if (r < minJac) minJac = r;
      }
    }
  } else {
    fconn = new Int32Array(2 * raw.segs.length);
    raw.segs.forEach((s: { a: number; b: number }, i: number) => fconn.set([s.a, s.b], 2 * i));
  }
  const pointNode = new Int32Array(g.pointVertex.length).fill(-1);
  // PSLG vertex v of the geometry keeps its coordinates; find its node by exact coordinates
  const pos = new Map<string, number>();
  for (let v = 0; v < N; v++) pos.set(`${nodes0[2 * v]},${nodes0[2 * v + 1]}`, v);
  g.pointVertex.forEach((v, i) => { pointNode[i] = pos.get(`${g.vertices[2 * v]},${g.vertices[2 * v + 1]}`) ?? -1; });
  const mesh: Mesh = {
    dim: 2, axisym: g.axisym, nodes,
    cells: { type: order === 2 ? 'tri6' : 'tri3', conn, domain: raw.triDomain },
    facets: { type: order === 2 ? 'line3' : 'line2', conn: fconn, boundary: fb },
    entities: g.entities, hash: meshHash(nodes, conn), pointNode,
  };
  mesh.tagHash = tagHash(mesh.cells.domain, fconn, fb, [...g.entities.domains, ...g.entities.boundaries, ...(g.entities.points ?? [])].map((e) => e.id));
  if (order === 2) mesh.quality = { minJacobianRatioP2: minJac };
  return mesh;
}
