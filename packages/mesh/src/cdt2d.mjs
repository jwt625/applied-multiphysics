// Ported from eo-modulator-atlas/engine/src/mesh.mjs at 0546007 (GPL-3.0-or-later). Changes: Heap and Triangulation
// kept verbatim except the vertex key (2^21 -> 2^26, lifting the ~2.1M hard limit; the 80k cap lived in EO config.mjs
// and is not carried over: maxVertices is an option). meshDomain rewritten for a geometry-tagged PSLG: the hull is a
// padded bounding box, segments carry a boundary tag, left/right domain and an exact-curve reference (split points are
// projected onto the curve when safe), refinement-time labels come from an adjacent subsegment or a classifier
// callback, final labels come from a flood fill bounded by subsegments (no painter order, no point-in-polygon on the
// final labels), size sources are segment sets with an optional "inside domain" zero-distance region, and exterior
// triangles are frozen. buildPslg / extractMesh / meshQuality replaced (see mesh2d.ts, quality.ts). Math.hypot and
// Math.pow / Math.log2 replaced by sqrt / exact power-of-two scaling so results are identical in every JS engine.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Original rationale (EO): the available permissive npm packages either do unconstrained Delaunay only (delaunator,
// ISC) or constrained Delaunay without quality refinement / size fields (cdt2d MIT, poly2tri BSD); Shewchuk Triangle is
// not freely usable and is excluded by project rule. This module implements incremental Delaunay (robust predicates
// from the public-domain `robust-predicates` package), conforming segment recovery by encroachment splitting (input
// segments become unions of Delaunay edges, so no constrained-edge flipping is required), and circumcenter refinement
// driven by a radius-edge bound and a graded size field.

import { orient2d, incircle } from 'robust-predicates';
import { detmath } from '@amp/geom';

// deterministic across engines (DevLog-004 s.9): sqrt-based lengths, exact power-of-two split distance
const hyp = (x, y) => Math.sqrt(x * x + y * y);

const orient = (ax, ay, bx, by, cx, cy) => -orient2d(ax, ay, bx, by, cx, cy); // >0 if ccw

/** Binary max-heap of [priority, tri, serial]. */
class Heap {
  constructor() {
    this.p = [];
    this.t = [];
    this.s = [];
  }
  get size() {
    return this.p.length;
  }
  push(pri, tri, ser) {
    let i = this.p.length;
    this.p.push(pri);
    this.t.push(tri);
    this.s.push(ser);
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.p[par] >= this.p[i]) break;
      this._swap(i, par);
      i = par;
    }
  }
  pop() {
    const out = [this.p[0], this.t[0], this.s[0]];
    const lp = this.p.pop(),
      lt = this.t.pop(),
      ls = this.s.pop();
    if (this.p.length) {
      this.p[0] = lp;
      this.t[0] = lt;
      this.s[0] = ls;
      let i = 0;
      const n = this.p.length;
      for (;;) {
        let l = 2 * i + 1,
          r = l + 1,
          m = i;
        if (l < n && this.p[l] > this.p[m]) m = l;
        if (r < n && this.p[r] > this.p[m]) m = r;
        if (m === i) break;
        this._swap(i, m);
        i = m;
      }
    }
    return out;
  }
  _swap(i, j) {
    const { p, t, s } = this;
    const pi = p[i],
      ti = t[i],
      si = s[i];
    p[i] = p[j];
    t[i] = t[j];
    s[i] = s[j];
    p[j] = pi;
    t[j] = ti;
    s[j] = si;
  }
}

const EKEY = 2 ** 26; // EO: 1 << 21. a * EKEY + b < 2^52 stays exact in a double
const ekey = (a, b) => (a < b ? a * EKEY + b : b * EKEY + a);

class Triangulation {
  constructor(cap = 1024) {
    this.nv = 0;
    this.px = new Float64Array(cap);
    this.py = new Float64Array(cap);
    this.vtri = new Int32Array(cap);
    // per-vertex scratch of commit(): new triangle starting / ending at a cavity-boundary vertex (stamped)
    this.vStartT = new Int32Array(cap);
    this.vEndT = new Int32Array(cap);
    this.vStartS = new Uint32Array(cap);
    this.vEndS = new Uint32Array(cap);
    this.commitStamp = 0;
    this.nt = 0; // slots used
    this.tv = new Int32Array(3 * cap);
    this.tn = new Int32Array(3 * cap);
    this.alive = new Uint8Array(cap);
    this.serial = new Uint32Array(cap);
    this.nextSerial = 1;
    this.free = [];
    this.stampIn = new Uint32Array(cap);
    this.stampOut = new Uint32Array(cap);
    this.stamp = 1;
    this.last = 0;
  }
  _growV() {
    const cap = this.px.length * 2;
    const g = (a, T) => {
      const b = new T(cap);
      b.set(a);
      return b;
    };
    this.px = g(this.px, Float64Array);
    this.py = g(this.py, Float64Array);
    this.vtri = g(this.vtri, Int32Array);
    this.vStartT = g(this.vStartT, Int32Array);
    this.vEndT = g(this.vEndT, Int32Array);
    this.vStartS = g(this.vStartS, Uint32Array);
    this.vEndS = g(this.vEndS, Uint32Array);
  }
  _growT() {
    const cap = this.alive.length * 2;
    const g = (a, T, k = 1) => {
      const b = new T(cap * k);
      b.set(a);
      return b;
    };
    this.tv = g(this.tv, Int32Array, 3);
    this.tn = g(this.tn, Int32Array, 3);
    this.alive = g(this.alive, Uint8Array);
    this.serial = g(this.serial, Uint32Array);
    this.stampIn = g(this.stampIn, Uint32Array);
    this.stampOut = g(this.stampOut, Uint32Array);
  }
  addVertex(x, y) {
    if (this.nv >= this.px.length) this._growV();
    if (this.nv >= EKEY) throw new Error('mesh: too many vertices');
    this.px[this.nv] = x;
    this.py[this.nv] = y;
    this.vtri[this.nv] = -1;
    return this.nv++;
  }
  _newTri(a, b, c) {
    let t;
    if (this.free.length) t = this.free.pop();
    else {
      if (this.nt >= this.alive.length) this._growT();
      t = this.nt++;
    }
    this.tv[3 * t] = a;
    this.tv[3 * t + 1] = b;
    this.tv[3 * t + 2] = c;
    this.tn[3 * t] = this.tn[3 * t + 1] = this.tn[3 * t + 2] = -1;
    this.alive[t] = 1;
    this.serial[t] = this.nextSerial++;
    return t;
  }
  _kill(t) {
    this.alive[t] = 0;
    this.free.push(t);
  }
  /** Initialise with two triangles covering the rectangle corners (vertex ids 0..3 ccw). */
  initRect(x0, y0, x1, y1) {
    const v0 = this.addVertex(x0, y0),
      v1 = this.addVertex(x1, y0),
      v2 = this.addVertex(x1, y1),
      v3 = this.addVertex(x0, y1);
    // diagonal v0-v2
    const t0 = this._newTri(v0, v1, v2),
      t1 = this._newTri(v0, v2, v3);
    // t0: edge opposite v1 is (v2,v0) -> shared with t1 ; t1: edge opposite v3 is (v0,v2)... opposite v3 is (v0,v2)
    this.tn[3 * t0 + 1] = t1;
    this.tn[3 * t1 + 2] = t0;
    for (const t of [t0, t1]) for (let i = 0; i < 3; i++) this.vtri[this.tv[3 * t + i]] = t;
    this.last = t0;
  }
  /** Walk to the triangle containing p. Returns {tri} or {outside:true, tri, edge}. */
  locate(x, y, start) {
    let t = start >= 0 && this.alive[start] ? start : this.last;
    if (!this.alive[t]) t = this._anyAlive();
    const maxSteps = 4 * this.nt + 100;
    let rot = 0;
    for (let step = 0; step < maxSteps; step++) {
      let moved = false;
      for (let k = 0; k < 3; k++) {
        const i = (k + rot) % 3;
        const a = this.tv[3 * t + ((i + 1) % 3)],
          b = this.tv[3 * t + ((i + 2) % 3)];
        if (orient(this.px[a], this.py[a], this.px[b], this.py[b], x, y) < 0) {
          const n = this.tn[3 * t + i];
          if (n < 0) return { outside: true, tri: t, edge: i };
          t = n;
          moved = true;
          rot = (i + 1) % 3;
          break;
        }
      }
      if (!moved) {
        this.last = t;
        return { tri: t };
      }
    }
    // fallback brute force
    for (let q = 0; q < this.nt; q++) {
      if (!this.alive[q]) continue;
      let ok = true;
      for (let i = 0; i < 3 && ok; i++) {
        const a = this.tv[3 * q + ((i + 1) % 3)],
          b = this.tv[3 * q + ((i + 2) % 3)];
        if (orient(this.px[a], this.py[a], this.px[b], this.py[b], x, y) < 0) ok = false;
      }
      if (ok) return { tri: q };
    }
    return { outside: true, tri: t, edge: 0 };
  }
  _anyAlive() {
    for (let t = 0; t < this.nt; t++) if (this.alive[t]) return t;
    return -1;
  }
  inCircle(t, x, y) {
    const a = this.tv[3 * t],
      b = this.tv[3 * t + 1],
      c = this.tv[3 * t + 2];
    return incircle(this.px[a], this.py[a], this.px[b], this.py[b], this.px[c], this.py[c], x, y);
  }
  /** Compute the Bowyer-Watson cavity of point (x,y) starting from triangle t0 (containing it). */
  cavity(x, y, t0) {
    const st = ++this.stamp;
    const cav = [t0];
    this.stampIn[t0] = st;
    const bnd = []; // {a,b,outer,ct}
    for (let h = 0; h < cav.length; h++) {
      const t = cav[h];
      for (let i = 0; i < 3; i++) {
        const n = this.tn[3 * t + i];
        const a = this.tv[3 * t + ((i + 1) % 3)],
          b = this.tv[3 * t + ((i + 2) % 3)];
        if (n >= 0) {
          if (this.stampIn[n] === st) continue;
          if (this.stampOut[n] !== st) {
            if (this.inCircle(n, x, y) > 0) {
              this.stampIn[n] = st;
              cav.push(n);
              continue;
            }
            this.stampOut[n] = st;
          }
        }
        bnd.push({ a, b, outer: n, ct: t });
      }
    }
    return { cav, bnd };
  }
  /** Commit cavity with new vertex v (already added). Returns array of new triangle ids. */
  commit(v, cav, bnd) {
    const x = this.px[v],
      y = this.py[v];
    const cs = ++this.commitStamp;
    const { vStartT, vEndT, vStartS, vEndS } = this;
    const created = [];
    const info = [];
    for (const e of bnd) {
      if (e.outer < 0 && Math.abs(orient(this.px[e.a], this.py[e.a], this.px[e.b], this.py[e.b], x, y)) === 0) continue;
      const t = this._newTri(v, e.a, e.b);
      this.tn[3 * t] = e.outer;
      created.push(t);
      vStartT[e.a] = t;
      vStartS[e.a] = cs;
      vEndT[e.b] = t;
      vEndS[e.b] = cs;
      info.push(t, e);
    }
    for (let k = 0; k < info.length; k += 2) {
      const t = info[k],
        e = info[k + 1];
      if (vEndS[e.a] === cs) this.tn[3 * t + 2] = vEndT[e.a]; // across edge (v,a): opposite b -> index 2
      if (vStartS[e.b] === cs) this.tn[3 * t + 1] = vStartT[e.b]; // across edge (b,v): opposite a -> index 1
      if (e.outer >= 0) {
        for (let i = 0; i < 3; i++) if (this.tn[3 * e.outer + i] === e.ct) this.tn[3 * e.outer + i] = t;
      }
      this.vtri[e.a] = t;
      this.vtri[e.b] = t;
    }
    this.vtri[v] = created[0];
    for (const t of cav) this._kill(t);
    this.last = created[0];
    return created;
  }
  /** Find the triangle (and local edge index i) having directed edge a->b, or -1. */
  findEdge(a, b) {
    const t0 = this.vtri[a];
    if (t0 < 0) return null;
    // rotate around a in both directions
    for (const dir of [0, 1]) {
      let t = t0;
      for (let guard = 0; guard < 1000; guard++) {
        // local index of a
        let ia = 0;
        if (this.tv[3 * t + 1] === a) ia = 1;
        else if (this.tv[3 * t + 2] === a) ia = 2;
        const u = this.tv[3 * t + ((ia + 1) % 3)],
          w = this.tv[3 * t + ((ia + 2) % 3)];
        if (u === b) return { t, i: (ia + 2) % 3, forward: true };
        if (w === b) return { t, i: (ia + 1) % 3, forward: false };
        // move to neighbour across edge (a,u) [opposite w, index ia+2] for dir 0, across (w,a) [opposite u, ia+1] for dir 1
        const n = this.tn[3 * t + (dir === 0 ? (ia + 2) % 3 : (ia + 1) % 3)];
        if (n < 0 || n === t0) break;
        t = n;
      }
    }
    return null;
  }
  circum(t) {
    const a = this.tv[3 * t],
      b = this.tv[3 * t + 1],
      c = this.tv[3 * t + 2];
    const ax = this.px[a],
      ay = this.py[a];
    const bx = this.px[b] - ax,
      by = this.py[b] - ay,
      cx = this.px[c] - ax,
      cy = this.py[c] - ay;
    const d = 2 * (bx * cy - by * cx);
    const b2 = bx * bx + by * by,
      c2 = cx * cx + cy * cy;
    const ux = (cy * b2 - by * c2) / d,
      uy = (bx * c2 - cx * b2) / d;
    return { x: ax + ux, y: ay + uy, r: hyp(ux, uy) };
  }
}

// ------------------------------------------------------------------------------------------------ size field

/** Distance from (px, py) to segment set S (4 numbers per segment). */
function distSegs(px, py, S) {
  let d2 = Infinity;
  for (let k = 0; k < S.length; k += 4) {
    const ax = S[k], ay = S[k + 1], dx = S[k + 2] - ax, dy = S[k + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    const q = qx * qx + qy * qy;
    if (q < d2) d2 = q;
  }
  return Math.sqrt(d2);
}

/**
 * Graded size field h(x, y) = min(maxEdge, regionMax[domain], min_k (h0_k + g_k d_k(x, y))), with d_k the distance to the
 * segment set of source k (0 inside source domain k when it has one). The EO pruning is kept: sources sorted by h0,
 * bounding-box lower bounds, and a 48 x 48 grid of candidate lists; the result equals the exhaustive minimum.
 * @param {{rect:{x0:number,y0:number,x1:number,y1:number}, maxEdge:number, grade?:number,
 *   sources?:{segs:Float64Array, domain?:number, h0:number, grade?:number}[], regionMax?:number[],
 *   classify?:(x:number,y:number)=>number}} spec
 */
export function createSizeField(spec) {
  const { rect, maxEdge } = spec;
  const grade = spec.grade ?? 0.35;
  const sources = spec.sources ?? [];
  const regionMax = spec.regionMax ?? [];
  const classify = spec.classify ?? (() => -1);
  const srcOrder = sources.map((s, i) => i).sort((i, j) => sources[i].h0 - sources[j].h0 || i - j);
  const nSrc = sources.length;
  const sSegs = srcOrder.map((i) => sources[i].segs);
  const sDom = Int32Array.from(srcOrder, (i) => sources[i].domain ?? -1);
  const sH0 = Float64Array.from(srcOrder, (i) => sources[i].h0);
  const sG = Float64Array.from(srcOrder, (i) => sources[i].grade ?? grade);
  const sBox = new Float64Array(4 * nSrc);
  srcOrder.forEach((i, k) => {
    const S = sources[i].segs;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let q = 0; q < S.length; q += 2) {
      if (S[q] < x0) x0 = S[q];
      if (S[q] > x1) x1 = S[q];
      if (S[q + 1] < y0) y0 = S[q + 1];
      if (S[q + 1] > y1) y1 = S[q + 1];
    }
    sBox.set([x0, y0, x1, y1], 4 * k);
  });
  const hasRegionMax = regionMax.some((v) => Number.isFinite(v));
  const anyDom = sDom.some((d) => d >= 0);
  const dist = (k, x, y, cls) => (sDom[k] >= 0 && cls === sDom[k] ? 0 : distSegs(x, y, sSegs[k]));
  const prune = sG.every((g) => g >= 0);
  const GN = prune && nSrc > 2 ? 48 : 0;
  const gdx = (rect.x1 - rect.x0) / (GN || 1), gdy = (rect.y1 - rect.y0) / (GN || 1);
  const cells = new Array(GN * GN).fill(null);
  const half = 0.5 * hyp(gdx, gdy);
  const cellList = (ci, cj) => {
    const x0 = rect.x0 + ci * gdx, y0 = rect.y0 + cj * gdy, x1 = x0 + gdx, y1 = y0 + gdy;
    const cx = 0.5 * (x0 + x1), cy = 0.5 * (y0 + y1);
    const ccls = anyDom ? classify(cx, cy) : -1;
    let hub = maxEdge;
    for (let k = 0; k < nSrc; k++) {
      const u = sH0[k] + sG[k] * (dist(k, cx, cy, ccls) + half);
      if (u < hub) hub = u;
    }
    const keep = [];
    for (let k = 0; k < nSrc; k++) {
      const bx = Math.max(sBox[4 * k] - x1, 0, x0 - sBox[4 * k + 2]), by = Math.max(sBox[4 * k + 1] - y1, 0, y0 - sBox[4 * k + 3]);
      if (sH0[k] + sG[k] * Math.sqrt(bx * bx + by * by) <= hub * (1 + 1e-9)) keep.push(k);
    }
    return Int32Array.from(keep);
  };
  const allSrc = Int32Array.from({ length: nSrc }, (_, k) => k);
  let nEval = 0;
  const sizeAt = (x, y, cls = null) => {
    nEval++;
    let h = maxEdge;
    let c = cls;
    if (hasRegionMax || anyDom) {
      if (c === null) c = classify(x, y);
      if (hasRegionMax && c >= 0) {
        const rm = regionMax[c];
        if (rm !== undefined && rm < h) h = rm;
      }
    }
    let list = allSrc, q1 = nSrc;
    if (GN) {
      const ci = Math.floor((x - rect.x0) / gdx), cj = Math.floor((y - rect.y0) / gdy);
      if (ci >= 0 && cj >= 0 && ci < GN && cj < GN) {
        const k = cj * GN + ci;
        list = cells[k] ?? (cells[k] = cellList(ci, cj));
        q1 = list.length;
      }
    }
    for (let q = 0; q < q1; q++) {
      const k = list[q];
      const h0 = sH0[k];
      if (prune) {
        if (h0 >= h) break;
        const bx = Math.max(sBox[4 * k] - x, 0, x - sBox[4 * k + 2]), by = Math.max(sBox[4 * k + 1] - y, 0, y - sBox[4 * k + 3]);
        if (h0 + sG[k] * Math.sqrt(bx * bx + by * by) > h * (1 + 1e-9)) continue;
      }
      const hh = h0 + sG[k] * dist(k, x, y, c);
      if (hh < h) h = hh;
    }
    return h;
  };
  sizeAt.count = () => nEval;
  return sizeAt;
}

// ------------------------------------------------------------------------------------------------ mesher

/**
 * Conforming Delaunay quality mesh of a tagged PSLG.
 *
 * @param {Object} spec
 * @param {{x0:number,y0:number,x1:number,y1:number}} spec.rect hull rectangle; every vertex must lie inside
 * @param {Float64Array} spec.verts PSLG vertices (2 per vertex, distinct)
 * @param {{a:number,b:number,tag:number,left:number,right:number,curve:number,ta:number,tb:number}[]} spec.segs
 *   PSLG segments (vertex indices), boundary tag, domain left / right of a -> b (-1 exterior), exact-curve index
 *   (-1 = straight) and parameters of a and b on that curve
 * @param {(x:number,y:number)=>number} spec.classify domain of a point (refinement-time only)
 * @param {(curve:number,t:number)=>[number,number]} [spec.curvePoint] exact curve evaluation for split projection
 * @param {(curve:number,x:number,y:number,t:number)=>number} [spec.curveProject] parameter of the closest curve point (near t)
 * @param {(x:number,y:number,cls?:number|null)=>number} spec.sizeAt size field (createSizeField)
 * @param {number} [spec.minAngleBound] radius-edge ratio bound B (default 1.35, about 21.7 deg)
 * @param {number} spec.minEdge absolute floor for refinement
 * @param {number} [spec.maxVertices] vertex budget (default 4e6)
 */
export function meshDomain(spec) {
  const t0 = performance.now();
  const { rect, verts, segs, classify, sizeAt } = spec;
  const curvePoint = spec.curvePoint ?? null;
  const B = spec.minAngleBound ?? 1.35;
  const minEdge = spec.minEdge;
  const maxVertices = spec.maxVertices ?? 4e6;
  const nIn = verts.length / 2;
  const T = new Triangulation(Math.max(1024, nIn * 8));
  T.initRect(rect.x0, rect.y0, rect.x1, rect.y1);
  const vmap = new Int32Array(nIn).fill(-1);
  for (let i = 0; i < nIn; i++) {
    const x = verts[2 * i], y = verts[2 * i + 1];
    const loc = T.locate(x, y, T.last);
    if (loc.outside) throw new Error('mesh: PSLG vertex outside hull');
    const v = T.addVertex(x, y);
    const { cav, bnd } = T.cavity(x, y, loc.tri);
    T.commit(v, cav, bnd);
    vmap[i] = v;
  }
  const tInsert = performance.now();
  const seg = new Map();
  let segVert = new Uint8Array(Math.max(1024, 2 * T.nv));
  const flagSegVert = (v) => {
    if (v >= segVert.length) {
      const g = new Uint8Array(Math.max(2 * segVert.length, v + 1));
      g.set(segVert);
      segVert = g;
    }
    segVert[v] = 1;
  };
  const maybeSeg = (a, b) => a < segVert.length && b < segVert.length && segVert[a] === 1 && segVert[b] === 1;
  for (const s of segs) {
    const a = vmap[s.a], b = vmap[s.b];
    const k = ekey(a, b);
    if (seg.has(k)) throw new Error('mesh: duplicate PSLG segment');
    seg.set(k, { a, b, tag: s.tag, left: s.left, right: s.right, curve: s.curve, ta: s.ta, tb: s.tb });
    flagSegVert(a);
    flagSegVert(b);
  }

  const segQueue = [];
  const segQueued = new Set();
  const enqueueSeg = (a, b, force = false) => {
    const k = ekey(a, b);
    if (!seg.has(k)) return;
    if (!force && segQueued.has(k)) return;
    segQueued.add(k);
    segQueue.push([a, b, force]);
  };
  const encroaches = (a, b, x, y) => {
    const dx1 = x - T.px[a], dy1 = y - T.py[a], dx2 = x - T.px[b], dy2 = y - T.py[b];
    return dx1 * dx2 + dy1 * dy2 < -1e-12 * (dx1 * dx1 + dy1 * dy1 + dx2 * dx2 + dy2 * dy2);
  };
  const segEncroached = (a, b) => {
    const e = T.findEdge(a, b);
    if (e) {
      const t = e.t;
      const apex = T.tv[3 * t + e.i];
      if (encroaches(a, b, T.px[apex], T.py[apex])) return true;
      const n = T.tn[3 * t + e.i];
      if (n >= 0) {
        for (let k = 0; k < 3; k++) {
          const vv = T.tv[3 * n + k];
          if (vv !== a && vv !== b && T.tn[3 * n + k] === t) {
            if (encroaches(a, b, T.px[vv], T.py[vv])) return true;
          }
        }
      }
      return false;
    }
    return true; // not a DT edge => necessarily non-Gabriel
  };
  for (const k of seg.keys()) {
    const s = seg.get(k);
    if (segEncroached(s.a, s.b)) enqueueSeg(s.a, s.b);
  }

  /** Domain of triangle t: from an adjacent subsegment (exact), else the classifier at the centroid. */
  let nClassify = 0;
  const triDomainNow = (t, cx, cy) => {
    for (let i = 0; i < 3; i++) {
      const a = T.tv[3 * t + ((i + 1) % 3)], b = T.tv[3 * t + ((i + 2) % 3)];
      if (!maybeSeg(a, b)) continue;
      const s = seg.get(ekey(a, b));
      if (s) return s.a === a ? s.left : s.right;
    }
    nClassify++;
    return classify(cx, cy);
  };

  const bad = new Heap();
  const retries = new Map();
  const retry = (t, ser) => {
    const n = (retries.get(ser) ?? 0) + 1;
    retries.set(ser, n);
    if (n <= 3) bad.push(0.5, t, ser);
  };
  const evalTri = (t) => {
    if (!T.alive[t]) return;
    const a = T.tv[3 * t], b = T.tv[3 * t + 1], c = T.tv[3 * t + 2];
    const cx = (T.px[a] + T.px[b] + T.px[c]) / 3, cy = (T.py[a] + T.py[b] + T.py[c]) / 3;
    const cls = triDomainNow(t, cx, cy);
    if (cls < 0) return; // frozen: exterior
    const lab = hyp(T.px[a] - T.px[b], T.py[a] - T.py[b]),
      lbc = hyp(T.px[b] - T.px[c], T.py[b] - T.py[c]),
      lca = hyp(T.px[c] - T.px[a], T.py[c] - T.py[a]);
    const lmin = Math.min(lab, lbc, lca), lmax = Math.max(lab, lbc, lca);
    if (lmax < 2 * minEdge) return;
    const cc = T.circum(t);
    const ratio = cc.r / lmin;
    const h = sizeAt(cx, cy, cls);
    const sz = lmax / h;
    let pri = 0;
    if (sz > 1) pri = Math.max(pri, 10 + sz);
    if (ratio > B && lmin > minEdge) pri = Math.max(pri, ratio);
    if (pri > 0) bad.push(pri, t, T.serial[t]);
  };
  const afterInsert = (v, created) => {
    for (const t of created) {
      const a = T.tv[3 * t + 1], b = T.tv[3 * t + 2];
      if (!maybeSeg(a, b)) continue;
      const k = ekey(a, b);
      if (seg.has(k) && encroaches(a, b, T.px[v], T.py[v])) enqueueSeg(a, b);
    }
    for (const t of created) evalTri(t);
  };
  const interiorToCavity = (tr, i) => {
    const n = T.tn[3 * tr + i];
    return n >= 0 && T.stampIn[n] === T.stamp;
  };
  const vertDegree = new Map();
  for (const s of seg.values()) {
    vertDegree.set(s.a, (vertDegree.get(s.a) ?? 0) + 1);
    vertDegree.set(s.b, (vertDegree.get(s.b) ?? 0) + 1);
  }
  let nProjected = 0;
  const splitSeg = (a, b) => {
    const k = ekey(a, b);
    const s = seg.get(k);
    if (!s) return;
    const len = hyp(T.px[a] - T.px[b], T.py[a] - T.py[b]);
    if (len < 2 * minEdge) return;
    // concentric-shell split (EO): power-of-two distance from a shared vertex
    let t = 0.5;
    const sharedA = vertDegree.get(a) > 2, sharedB = vertDegree.get(b) > 2;
    if (sharedA !== sharedB) {
      const dsh = len * 0.5;
      const p2 = detmath.ldexp(minEdge, detmath.roundLog2(dsh / minEdge)); // EO: Math.pow(2, Math.round(Math.log2(dsh / minEdge))) * minEdge
      const tt = Math.min(0.75, Math.max(0.25, p2 / len));
      t = sharedA ? tt : 1 - tt;
    }
    // t is measured from the subsegment's own endpoint a (its stored direction may differ from the queue's)
    const ta = s.a === a ? s.ta : s.tb, tb = s.a === a ? s.tb : s.ta;
    let x = T.px[a] + t * (T.px[b] - T.px[a]), y = T.py[a] + t * (T.py[b] - T.py[a]);
    let tm = ta + t * (tb - ta);
    let loc = null;
    if (curvePoint && s.curve >= 0) {
      const p = curvePoint(s.curve, tm);
      const off = hyp(p[0] - x, p[1] - y);
      if (off <= 0.25 * len && p[0] > rect.x0 && p[0] < rect.x1 && p[1] > rect.y0 && p[1] < rect.y1) {
        const l2 = T.locate(p[0], p[1], T.vtri[a] >= 0 ? T.vtri[a] : T.last);
        if (!l2.outside) { x = p[0]; y = p[1]; loc = l2; if (off > 0) nProjected++; }
      }
    }
    if (!loc) {
      loc = T.locate(x, y, T.vtri[a] >= 0 ? T.vtri[a] : T.last);
      // chord point (projection refused): record the curve parameter of its projection (audit M5), else NaN
      if (curvePoint && s.curve >= 0) tm = spec.curveProject ? spec.curveProject(s.curve, x, y, tm) : NaN;
    }
    if (loc.outside) return;
    const { cav, bnd } = T.cavity(x, y, loc.tri);
    const seenE = new Set();
    for (const tr of cav)
      for (let i = 0; i < 3; i++) {
        const ea = T.tv[3 * tr + ((i + 1) % 3)], eb = T.tv[3 * tr + ((i + 2) % 3)];
        if (!maybeSeg(ea, eb)) continue;
        const ek = ekey(ea, eb);
        if (ek === k || seenE.has(ek)) continue;
        seenE.add(ek);
        if (seg.has(ek) && (encroaches(ea, eb, x, y) || interiorToCavity(tr, i))) enqueueSeg(ea, eb);
      }
    const v = T.addVertex(x, y);
    const created = T.commit(v, cav, bnd);
    seg.delete(k);
    segQueued.delete(k);
    const m = Number.isNaN(tm) ? ta + t * (tb - ta) : tm;
    // keep the stored direction s.a -> s.b
    if (s.a === a) {
      seg.set(ekey(a, v), { ...s, a, b: v, ta, tb: m });
      seg.set(ekey(v, b), { ...s, a: v, b, ta: m, tb });
    } else {
      seg.set(ekey(b, v), { ...s, a: b, b: v, ta: tb, tb: m });
      seg.set(ekey(v, a), { ...s, a: v, b: a, ta: m, tb: ta });
    }
    flagSegVert(v);
    vertDegree.set(v, 2);
    for (const [p, q] of [[a, v], [v, b]]) if (segEncroached(p, q)) enqueueSeg(p, q);
    afterInsert(v, created);
  };

  let nSegSplits = 0;
  const processSegs = () => {
    while (segQueue.length) {
      if (T.nv > maxVertices) throw new Error(`mesh: vertex budget ${maxVertices} exceeded (raise maxVertices or coarsen the size field)`);
      const [a, b, force] = segQueue.pop();
      const k = ekey(a, b);
      segQueued.delete(k);
      if (!seg.has(k)) continue;
      if (force || segEncroached(a, b)) {
        splitSeg(a, b);
        nSegSplits++;
      }
    }
  };
  processSegs();
  const tSegs = performance.now();
  for (let t = 0; t < T.nt; t++) if (T.alive[t]) evalTri(t);

  let nInsert = 0, guard = 0, nRepair = 0;
  for (;;) {
    while (bad.size) {
      if (T.nv > maxVertices) throw new Error(`mesh: vertex budget ${maxVertices} exceeded (raise maxVertices or coarsen the size field)`);
      if (++guard > 5e7) throw new Error('mesh: iteration guard');
      const [, t, ser] = bad.pop();
      if (!T.alive[t] || T.serial[t] !== ser) continue;
      const cc = T.circum(t);
      if (!(Number.isFinite(cc.x) && Number.isFinite(cc.y))) continue;
      const loc = T.locate(cc.x, cc.y, t);
      if (loc.outside) {
        const tt = loc.tri, i = loc.edge;
        const a = T.tv[3 * tt + ((i + 1) % 3)], b = T.tv[3 * tt + ((i + 2) % 3)];
        if (seg.has(ekey(a, b))) {
          enqueueSeg(a, b, true);
          processSegs();
          if (T.alive[t] && T.serial[t] === ser) retry(t, ser);
          else if (T.alive[t]) evalTri(t);
        }
        continue;
      }
      const { cav, bnd } = T.cavity(cc.x, cc.y, loc.tri);
      let enc = false;
      const seen = new Set();
      for (const tr of cav) {
        for (let i = 0; i < 3; i++) {
          const a = T.tv[3 * tr + ((i + 1) % 3)], b = T.tv[3 * tr + ((i + 2) % 3)];
          if (!maybeSeg(a, b)) continue;
          const k = ekey(a, b);
          if (seen.has(k)) continue;
          seen.add(k);
          if (seg.has(k) && (encroaches(a, b, cc.x, cc.y) || interiorToCavity(tr, i))) {
            enqueueSeg(a, b, true);
            enc = true;
          }
        }
      }
      if (enc) {
        processSegs();
        if (T.alive[t]) {
          if (T.serial[t] === ser) retry(t, ser);
          else evalTri(t);
        }
        continue;
      }
      const v = T.addVertex(cc.x, cc.y);
      const created = T.commit(v, cav, bnd);
      nInsert++;
      afterInsert(v, created);
      processSegs();
    }
    // conformity check (EO): every subsegment must be a triangulation edge
    let missing = 0;
    for (const s of [...seg.values()]) {
      if (T.findEdge(s.a, s.b) || T.findEdge(s.b, s.a)) continue;
      enqueueSeg(s.a, s.b, true);
      missing++;
    }
    if (!missing) break;
    nRepair += missing;
    if (nRepair > 1e5) throw new Error('mesh: interface segments could not be recovered (conformity repair limit)');
    processSegs();
  }
  const tRefine = performance.now();

  // ---- final labels: flood fill bounded by subsegments ----
  const label = new Int32Array(T.nt).fill(-2);
  const stack = [];
  let conflicts = 0;
  for (let t = 0; t < T.nt; t++) {
    if (!T.alive[t]) continue;
    for (let i = 0; i < 3; i++) {
      const a = T.tv[3 * t + ((i + 1) % 3)], b = T.tv[3 * t + ((i + 2) % 3)];
      if (!maybeSeg(a, b)) continue;
      const s = seg.get(ekey(a, b));
      if (!s) continue;
      const d = s.a === a ? s.left : s.right;
      if (label[t] === -2) { label[t] = d; stack.push(t); }
      else if (label[t] !== d) conflicts++;
    }
  }
  while (stack.length) {
    const t = stack.pop();
    for (let i = 0; i < 3; i++) {
      const n = T.tn[3 * t + i];
      if (n < 0) continue;
      const a = T.tv[3 * t + ((i + 1) % 3)], b = T.tv[3 * t + ((i + 2) % 3)];
      if (maybeSeg(a, b) && seg.has(ekey(a, b))) continue;
      if (label[n] === -2) { label[n] = label[t]; stack.push(n); }
      else if (label[n] !== label[t]) conflicts++;
    }
  }
  if (conflicts) throw new Error(`mesh: ${conflicts} inconsistent domain labels across subsegments (geometry tags)`);
  let nUnlabeled = 0;
  for (let t = 0; t < T.nt; t++)
    if (T.alive[t] && label[t] === -2) {
      const a = T.tv[3 * t], b = T.tv[3 * t + 1], c = T.tv[3 * t + 2];
      label[t] = classify((T.px[a] + T.px[b] + T.px[c]) / 3, (T.py[a] + T.py[b] + T.py[c]) / 3);
      nUnlabeled++;
    }

  // ---- compact ----
  const used = new Int32Array(T.nv).fill(-1);
  let nn = 0, ntri = 0;
  for (let t = 0; t < T.nt; t++) if (T.alive[t] && label[t] >= 0) {
    ntri++;
    for (let i = 0; i < 3; i++) if (used[T.tv[3 * t + i]] < 0) used[T.tv[3 * t + i]] = nn++;
  }
  const nodes = new Float64Array(2 * nn);
  for (let v = 0; v < T.nv; v++) if (used[v] >= 0) { nodes[2 * used[v]] = T.px[v]; nodes[2 * used[v] + 1] = T.py[v]; }
  const tri = new Int32Array(3 * ntri), triDomain = new Int32Array(ntri);
  let q = 0;
  for (let t = 0; t < T.nt; t++) if (T.alive[t] && label[t] >= 0) {
    for (let i = 0; i < 3; i++) tri[3 * q + i] = used[T.tv[3 * t + i]];
    triDomain[q++] = label[t];
  }
  const outSegs = [];
  for (const s of seg.values()) {
    if (used[s.a] < 0 || used[s.b] < 0) continue;
    outSegs.push({ a: used[s.a], b: used[s.b], tag: s.tag, curve: s.curve, ta: s.ta, tb: s.tb });
  }
  outSegs.sort((p, r) => p.tag - r.tag || p.curve - r.curve || p.ta - r.ta || p.a - r.a);
  const tEnd = performance.now();
  return {
    nodes, tri, triDomain, segs: outSegs, nNodes: nn, nTris: ntri,
    stats: {
      nSegSplits, nInsert, nRepair, nProjected, nClassify, nUnlabeled, nSizeAt: sizeAt.count ? sizeAt.count() : 0,
      ms: tEnd - t0, insert_ms: tInsert - t0, segments_ms: tSegs - tInsert, refine_ms: tRefine - tSegs, label_ms: tEnd - tRefine,
    },
  };
}
