// SPDX-License-Identifier: GPL-3.0-or-later
// Periodic (Bloch / Floquet) unit cells in 2D (DevLog-050 s.1.3): split the boundaries of one periodic condition into
// its two opposite sides, find the lattice translation from side A to side B, and pair the mesh nodes of the two sides.
// The sides must be straight and parallel; side A is the one with the smaller offset along the common normal, the
// normal being oriented along +x (or +y when the sides are horizontal). The translation d maps side A onto side B,
// including a tangential shift (parallelogram cells). Deterministic: no randomness, ties broken by coordinates.

import type { Mesh } from '@amp/geom';

export interface PeriodicSides {
  /** unit normal of the sides (+x, or +y for horizontal sides) and unit tangent t = (-n_y, n_x) */
  n: [number, number];
  t: [number, number];
  /** offsets n . x of side A (smaller) and side B */
  offA: number;
  offB: number;
  /** lattice translation from side A to side B (m) */
  d: [number, number];
  /** per input segment: 0 = side A, 1 = side B */
  side: Uint8Array;
  /** absolute tolerance used (m) */
  tol: number;
}

const fmt = (v: number) => Number(v.toPrecision(6));
const pt = (x: number, y: number) => `(${fmt(x)}, ${fmt(y)}) m`;

/**
 * Split straight segments (x0, y0, x1, y1 per segment) into two parallel sides and compute the translation between
 * them. `what` names the condition in error messages. Throws when the segments are not two straight, parallel,
 * equally long sides.
 */
export function periodicSides(segs: ArrayLike<number>, what: string, tolRel = 1e-9): PeriodicSides {
  const ns = Math.floor(segs.length / 4);
  if (ns < 2) throw new Error(`${what}: a periodic condition needs boundaries on two opposite sides (got ${ns} segment${ns === 1 ? '' : 's'})`);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let s = 0; s < ns; s++) for (const o of [0, 2]) {
    const x = segs[4 * s + o]!, y = segs[4 * s + o + 1]!;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const L = Math.hypot(x1 - x0, y1 - y0);
  const tol = tolRel * L;
  // direction from the longest segment (deterministic: first one on ties)
  let best = -1, bl = 0;
  for (let s = 0; s < ns; s++) {
    const l = Math.hypot(segs[4 * s + 2]! - segs[4 * s]!, segs[4 * s + 3]! - segs[4 * s + 1]!);
    if (l > bl * (1 + 1e-12)) { bl = l; best = s; }
  }
  if (!(bl > tol)) throw new Error(`${what}: the selected boundaries have zero length`);
  let tx = (segs[4 * best + 2]! - segs[4 * best]!) / bl, ty = (segs[4 * best + 3]! - segs[4 * best + 1]!) / bl;
  let nx = -ty, ny = tx;
  if (nx < -1e-12 || (Math.abs(nx) <= 1e-12 && ny < 0)) { nx = -nx; ny = -ny; }
  tx = -ny; ty = nx;
  const off = new Float64Array(ns);
  for (let s = 0; s < ns; s++) {
    const ax = segs[4 * s]!, ay = segs[4 * s + 1]!, bx = segs[4 * s + 2]!, by = segs[4 * s + 3]!;
    const oa = nx * ax + ny * ay, ob = nx * bx + ny * by;
    if (Math.abs(oa - ob) > tol) throw new Error(`${what}: the boundary piece from ${pt(ax, ay)} to ${pt(bx, by)} is not parallel to the others; a periodic condition needs two straight, parallel sides`);
    off[s] = 0.5 * (oa + ob);
  }
  const vals = Array.from(off).sort((a, b) => a - b);
  const groups: number[] = [vals[0]!];
  for (const v of vals) if (v - groups[groups.length - 1]! > tol) groups.push(v);
  if (groups.length !== 2) throw new Error(`${what}: the selected boundaries lie on ${groups.length} parallel line${groups.length === 1 ? '' : 's'}; select the two opposite sides of the cell (both sides in one periodic condition)`);
  const offA = groups[0]!, offB = groups[1]!;
  const side = new Uint8Array(ns);
  let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
  for (let s = 0; s < ns; s++) {
    side[s] = Math.abs(off[s]! - offA) <= Math.abs(off[s]! - offB) ? 0 : 1;
    for (const o of [0, 2]) {
      const v = tx * segs[4 * s + o]! + ty * segs[4 * s + o + 1]!;
      if (side[s] === 0) { aMin = Math.min(aMin, v); aMax = Math.max(aMax, v); } else { bMin = Math.min(bMin, v); bMax = Math.max(bMax, v); }
    }
  }
  if (Math.abs((aMax - aMin) - (bMax - bMin)) > tol) throw new Error(`${what}: the two sides have different lengths (${fmt(aMax - aMin)} m and ${fmt(bMax - bMin)} m); periodic sides must be translates of each other`);
  const dn = offB - offA, dt = bMin - aMin;
  return { n: [nx, ny], t: [tx, ty], offA, offB, d: [dn * nx + dt * tx, dn * ny + dt * ty], side, tol };
}

export interface PeriodicPairs {
  /** paired nodes: node b[i] = node a[i] translated by d (ordered along the side) */
  a: Int32Array;
  b: Int32Array;
  d: [number, number];
  sides: PeriodicSides;
}

/**
 * Pair the nodes of the two sides of one periodic condition (facets of the condition's selection, both sides).
 * Every node on side A must have a node on side B at x + d (tolerance tolRel x the size of the selection); otherwise a
 * plain error names the first unmatched node.
 */
export function pairPeriodicNodes(mesh: Mesh, facets: ArrayLike<number>, what = 'periodic condition', tolRel = 1e-9): PeriodicPairs {
  if (mesh.dim !== 2) throw new Error(`${what}: periodic conditions are implemented for 2D meshes`);
  const kf = mesh.facets.type === 'line3' ? 3 : 2;
  const nf = facets.length;
  const segs = new Float64Array(4 * nf);
  for (let i = 0; i < nf; i++) {
    const f = facets[i]!;
    const a = mesh.facets.conn[kf * f]!, b = mesh.facets.conn[kf * f + 1]!;
    segs.set([mesh.nodes[2 * a]!, mesh.nodes[2 * a + 1]!, mesh.nodes[2 * b]!, mesh.nodes[2 * b + 1]!], 4 * i);
  }
  const S = periodicSides(segs, what, tolRel);
  const setA = new Set<number>(), setB = new Set<number>();
  for (let i = 0; i < nf; i++) for (let q = 0; q < kf; q++) (S.side[i] ? setB : setA).add(mesh.facets.conn[kf * facets[i]! + q]!);
  for (const n of setA) if (setB.has(n)) throw new Error(`${what}: node at ${pt(mesh.nodes[2 * n]!, mesh.nodes[2 * n + 1]!)} lies on both sides`);
  const [tx, ty] = S.t, [dx, dy] = S.d;
  const sOf = (n: number, shift: boolean) => tx * (mesh.nodes[2 * n]! - (shift ? dx : 0)) + ty * (mesh.nodes[2 * n + 1]! - (shift ? dy : 0));
  const A = [...setA].map((n) => ({ n, s: sOf(n, false) })).sort((p, q) => p.s - q.s || p.n - q.n);
  const B = [...setB].map((n) => ({ n, s: sOf(n, true) })).sort((p, q) => p.s - q.s || p.n - q.n);
  const a: number[] = [], b: number[] = [];
  let i = 0, j = 0;
  const miss = (n: number, fromB: boolean) => {
    const x = mesh.nodes[2 * n]!, y = mesh.nodes[2 * n + 1]!;
    const px = fromB ? x - dx : x + dx, py = fromB ? y - dy : y + dy;
    return new Error(`${what}: the node at ${pt(x, y)} has no partner at ${pt(px, py)} on the opposite side, so the two sides are meshed differently. A spec with this periodic condition meshes both sides alike; a mesh made without it cannot be used`);
  };
  while (i < A.length || j < B.length) {
    if (i >= A.length) throw miss(B[j]!.n, true);
    if (j >= B.length) throw miss(A[i]!.n, false);
    const pa = A[i]!, pb = B[j]!;
    if (Math.abs(pa.s - pb.s) <= S.tol) {
      const ex = mesh.nodes[2 * pa.n]! + dx - mesh.nodes[2 * pb.n]!, ey = mesh.nodes[2 * pa.n + 1]! + dy - mesh.nodes[2 * pb.n + 1]!;
      if (Math.hypot(ex, ey) > S.tol) throw miss(pa.n, false);
      a.push(pa.n); b.push(pb.n); i++; j++;
    } else if (pa.s < pb.s) throw miss(pa.n, false);
    else throw miss(pb.n, true);
  }
  return { a: Int32Array.from(a), b: Int32Array.from(b), d: S.d, sides: S };
}

/** Periodic selections of a spec: the `select` of every `periodic` condition of every physics, in spec order. */
export function periodicSelections(spec: Record<string, unknown>): Array<{ id: string; select: string[] }> {
  const out: Array<{ id: string; select: string[] }> = [];
  for (const p of (spec.physics ?? []) as Array<{ bcs?: Array<{ id: string; type: string; select?: string[] }> }>)
    for (const b of p.bcs ?? []) if (b.type === 'periodic' && b.select?.length) out.push({ id: b.id, select: [...b.select] });
  return out;
}
