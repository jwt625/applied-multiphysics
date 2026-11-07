// SPDX-License-Identifier: GPL-3.0-or-later
// 2D feature model: primitives, booleans on a planar arrangement, persistent entity IDs from construction history
// (C2: `<feature>.<sub>`, `<id>#k` on splits, `parent` links). No painter order: overlapping solids must be resolved
// by an explicit boolean or fragment; overlaps left at build time are an error.
//
// ID rules (DevLog-004 s.1.1):
// - primitive F: domain F, boundaries F.<sub> (rect bottom/right/top/left; circle and ellipse edge; polygon e<i>;
//   arc e0; polyline e<i>), points F.<p> (rect p0..p3; polygon/polyline v<i>).
// - union, intersection and difference name the result domain after the boolean feature (difference of a target with
//   several domains keeps the target's domain IDs instead); fragment names each face by its origin domains joined with
//   '&' in construction order; boundaries keep the ID of the feature that created them (L2 DevLog-003 s.5 item 4).
// - one source split into several pieces: `<id>#k`, k = 1.. ordered by the first position the piece touches along
//   the source entities (edges: parameter along the source; domains: first boundary contact), which is invariant
//   under parameter changes that keep topology.
// - boundary IDs come from the first source in construction order; coincident sources are listed in `parent`.

import { type Curve, type Vec2, point, deriv, reverse } from './curves.ts';
import { arrange, type Arrangement } from './arrangement.ts';
import type { EntityRef, EntityTable } from './types.ts';

export interface DomainRec { id: string; parent?: string[]; anc?: string[] }
export interface EdgeRec {
  curve: Curve;
  id: string;
  parent?: string[];
  /** every transitive origin id (with prefix), for selection expansion */
  anc?: string[];
  left: number;
  right: number;
  /** order of the entity in its object, and position of this record along the entity (for #k ordering) */
  ord: number;
  pos: number;
  /** from a curve object (arc / polyline): kept as an embedded edge inside domains */
  embedded: boolean;
}
export interface PointRec { id: string; p: Vec2; parent?: string[]; anc?: string[] }
export interface Obj { feature: string; domains: DomainRec[]; edges: EdgeRec[]; points: PointRec[]; curveOnly: boolean }

export type Feature =
  | { id: string; type: 'rect'; x: [number, number]; y: [number, number] }
  | { id: string; type: 'circle'; c: Vec2; r: number }
  | { id: string; type: 'ellipse'; c: Vec2; rx: number; ry: number; rot?: number }
  | { id: string; type: 'polygon'; points: Vec2[] }
  | { id: string; type: 'arc'; c: Vec2; r: number; a0: number; a1: number }
  | { id: string; type: 'polyline'; points: Vec2[] }
  | { id: string; type: 'union'; inputs: string[] }
  | { id: string; type: 'intersection'; inputs: string[] }
  | { id: string; type: 'difference'; target: string; tools: string[]; keepTools?: boolean }
  | { id: string; type: 'fragment'; inputs: string[] };

export interface GeometrySpec2D { dim?: 2; axisym?: boolean; features: Feature[] }

export interface GeomEdge {
  v0: number;
  v1: number;
  curve: Curve;
  /** index into entities.boundaries */
  boundary: number;
  /** domain indices (entities.domains) left / right of v0 -> v1; -1 = exterior */
  left: number;
  right: number;
}

export interface Geometry2D {
  dim: 2;
  axisym: boolean;
  tol: number;
  bbox: [number, number, number, number];
  vertices: Float64Array;
  edges: GeomEdge[];
  entities: EntityTable;
  /** entities.points[k] -> vertex index */
  pointVertex: Int32Array;
  /** features in construction order (ids) */
  features: string[];
  /** non-fatal issues (near-tolerance features); surfaced by the mesher and as readiness reasons */
  warnings: string[];
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const uniqNot = (l: string[], self: string) => [...new Set(l)].filter((x) => x !== self);
const fail = (m: string): never => {
  throw new Error(`geom: ${m}`);
};
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- primitives

function lineRec(a: Vec2, b: Vec2, id: string, left: number, right: number, ord: number, pos = 0, embedded = false): EdgeRec {
  return { curve: { kind: 'line', a, b }, id, left, right, ord, pos, embedded };
}

export function primitive(f: Feature): Obj {
  const id = f.id;
  switch (f.type) {
    case 'rect': {
      const [x0, x1] = f.x, [y0, y1] = f.y;
      if (![x0, x1, y0, y1].every(finite) || !(x1 > x0) || !(y1 > y0)) fail(`${id}: rect needs x0 < x1 and y0 < y1`);
      const p: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const names = ['bottom', 'right', 'top', 'left'];
      return {
        feature: id, curveOnly: false, domains: [{ id }],
        edges: names.map((s, i) => lineRec(p[i]!, p[(i + 1) % 4]!, `${id}.${s}`, 0, -1, i)),
        points: p.map((q, i) => ({ id: `${id}.p${i}`, p: q })),
      };
    }
    case 'circle':
    case 'ellipse': {
      const isC = f.type === 'circle';
      const rx = isC ? f.r : f.rx, ry = isC ? f.r : f.ry, rot = isC ? 0 : (f.rot ?? 0);
      if (![f.c[0], f.c[1], rx, ry, rot].every(finite) || !(rx > 0) || !(ry > 0)) fail(`${id}: ${f.type} needs a finite centre and radii > 0`);
      const halves: Curve[] = isC
        ? [{ kind: 'arc', c: f.c, r: rx, a0: 0, a1: Math.PI }, { kind: 'arc', c: f.c, r: rx, a0: Math.PI, a1: 2 * Math.PI }]
        : [{ kind: 'earc', c: f.c, rx, ry, rot, a0: 0, a1: Math.PI }, { kind: 'earc', c: f.c, rx, ry, rot, a0: Math.PI, a1: 2 * Math.PI }];
      return {
        feature: id, curveOnly: false, domains: [{ id }], points: [],
        edges: halves.map((curve, k) => ({ curve, id: `${id}.edge`, left: 0, right: -1, ord: 0, pos: k, embedded: false })),
      };
    }
    case 'polygon': {
      const P = f.points;
      if (!Array.isArray(P) || P.length < 3 || !P.every((q) => finite(q[0]) && finite(q[1]))) fail(`${id}: polygon needs >= 3 finite points`);
      let A = 0;
      for (let i = 0; i < P.length; i++) { const a = P[i]!, b = P[(i + 1) % P.length]!; A += a[0] * b[1] - b[0] * a[1]; }
      if (A === 0) fail(`${id}: polygon has zero area`);
      const ccw = A > 0;
      return {
        feature: id, curveOnly: false, domains: [{ id }],
        edges: P.map((a, i) => lineRec(a, P[(i + 1) % P.length]!, `${id}.e${i}`, ccw ? 0 : -1, ccw ? -1 : 0, i)),
        points: P.map((q, i) => ({ id: `${id}.v${i}`, p: q })),
      };
    }
    case 'arc': {
      if (![f.c[0], f.c[1], f.r, f.a0, f.a1].every(finite) || !(f.r > 0) || f.a0 === f.a1 || Math.abs(f.a1 - f.a0) >= 2 * Math.PI)
        fail(`${id}: arc needs r > 0 and 0 < |a1 - a0| < 2 pi`);
      const curve: Curve = { kind: 'arc', c: f.c, r: f.r, a0: f.a0, a1: f.a1 };
      return {
        feature: id, curveOnly: true, domains: [],
        edges: [{ curve, id: `${id}.e0`, left: -1, right: -1, ord: 0, pos: 0, embedded: true }],
        points: [{ id: `${id}.v0`, p: point(curve, 0) }, { id: `${id}.v1`, p: point(curve, 1) }],
      };
    }
    case 'polyline': {
      const P = f.points;
      if (!Array.isArray(P) || P.length < 2 || !P.every((q) => finite(q[0]) && finite(q[1]))) fail(`${id}: polyline needs >= 2 finite points`);
      return {
        feature: id, curveOnly: true, domains: [],
        edges: P.slice(0, -1).map((a, i) => lineRec(a, P[i + 1]!, `${id}.e${i}`, -1, -1, i, 0, true)),
        points: P.map((q, i) => ({ id: `${id}.v${i}`, p: q })),
      };
    }
    default:
      return fail(`${(f as Feature).id}: not a primitive`);
  }
}

// ---------------------------------------------------------------- booleans

type Op = 'union' | 'intersection' | 'difference' | 'fragment' | 'final';
type Key = [number, number, number];
const keyLess = (a: Key, b: Key) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export interface CombineResult { obj: Obj; arr: Arrangement; subKept: Uint8Array; subRec: Int32Array; faceDom: Int32Array }

export function combine(op: Op, fid: string, objs: Obj[], tol: number): CombineResult {
  const who = op === 'final' ? 'final fragment of the remaining objects' : fid;
  const recObj: number[] = [], recs: EdgeRec[] = [];
  for (let o = 0; o < objs.length; o++) for (const e of objs[o]!.edges) { recObj.push(o); recs.push(e); }
  const A = arrange(recs.map((r) => r.curve), tol);
  // no silent loss (audit S3): an entity of positive length whose every curve collapsed below tol is an error
  const lost = new Map<string, number>();
  recs.forEach((r, i) => {
    const k = r.id;
    if (!lost.has(k)) lost.set(k, 0);
    if (A.recPieces[i]! > 0) lost.set(k, 1);
    else if (A.recLength[i]! <= tol) lost.set(k, Math.max(lost.get(k)!, 0.5));
  });
  // two pieces of one entity of one object merged as coincident: the feature degenerated (e.g. a circle below tol)
  for (const S of A.subs)
    for (let a = 0; a < S.srcs.length; a++)
      for (let b = a + 1; b < S.srcs.length; b++) {
        const ra = S.srcs[a]!.rec, rb = S.srcs[b]!.rec;
        if (recObj[ra] === recObj[rb] && recs[ra]!.id === recs[rb]!.id)
          fail(`${who}: boundary '${recs[ra]!.id}' folds onto itself below the geometric tolerance ${tol.toPrecision(3)} m (feature too small relative to the model size)`);
      }
  for (const [k, v] of lost)
    if (v === 0) fail(`${who}: boundary '${k}' collapses below the geometric tolerance ${tol.toPrecision(3)} m (feature too small relative to the model size)`);
  const domOff: number[] = [];
  let nd = 0;
  for (const o of objs) { domOff.push(nd); nd += o.domains.length; }
  const keyObj = new Int32Array(nd), keyDom = new Int32Array(nd);
  objs.forEach((o, i) => o.domains.forEach((_, d) => { keyObj[domOff[i]! + d] = i; keyDom[domOff[i]! + d] = d; }));
  const dKey = (o: number, d: number) => (d < 0 ? -1 : domOff[o]! + d);
  const nS = A.subs.length, nF = A.faces.length;
  // domains on the left / right of each sub (forward direction)
  const subL: number[][] = [], subR: number[][] = [];
  for (const S of A.subs) {
    const L: number[] = [], R: number[] = [];
    for (const s of S.srcs) {
      const e = recs[s.rec]!, o = recObj[s.rec]!;
      const l = dKey(o, s.fwd ? e.left : e.right), r = dKey(o, s.fwd ? e.right : e.left);
      if (l >= 0) L.push(l);
      if (r >= 0) R.push(r);
    }
    subL.push(L); subR.push(R);
  }
  // origin sets by propagation from the unbounded face
  const faceHe: number[][] = Array.from({ length: nF + 1 }, () => []);
  for (let h = 0; h < 2 * nS; h++) faceHe[A.heFace[h]! + 1]!.push(h);
  const origin: Array<number[] | null> = new Array(nF + 1).fill(null);
  origin[0] = [];
  const queue = [-1];
  for (let qi = 0; qi < queue.length; qi++) {
    const f = queue[qi]!;
    const of = origin[f + 1]!;
    for (const h of faceHe[f + 1]!) {
      const g = A.heFace[h ^ 1]!;
      if (g === f) continue;
      const s = h >> 1, fwd = (h & 1) === 0;
      const leave = fwd ? subL[s]! : subR[s]!, enter = fwd ? subR[s]! : subL[s]!;
      const ng = of.filter((k) => !leave.includes(k));
      for (const k of enter) if (!ng.includes(k)) ng.push(k);
      ng.sort((a, b) => a - b);
      const cur = origin[g + 1];
      if (cur == null) { origin[g + 1] = ng; queue.push(g); }
      else if (cur.length !== ng.length || cur.some((k, i) => k !== ng[i])) fail(`${who}: inconsistent region classification (check for coincident curved edges or self-intersecting input)`);
    }
  }
  // kept faces and group keys
  const objsOf = (o: number[]) => new Set(o.map((k) => keyObj[k]!));
  const group: Array<string | null> = new Array(nF).fill(null);
  for (let f = 0; f < nF; f++) {
    const o = origin[f + 1] ?? [];
    if (!o.length) continue;
    const os = objsOf(o);
    if (op === 'union') group[f] = 'U';
    else if (op === 'intersection') { if (objs.every((_, i) => os.has(i))) group[f] = 'U'; }
    else if (op === 'difference') {
      if (os.has(0) && os.size === 1) group[f] = String(o[0]);
    } else {
      if (op === 'final' && os.size > 1) {
        const ids = o.map((k) => objs[keyObj[k]!]!.domains[keyDom[k]!]!.id);
        fail(`overlapping domains ${ids.join(', ')} without a boolean: resolve the overlap with difference, union or fragment`);
      }
      group[f] = o.join(',');
    }
  }
  // domains = connected components of faces with the same group (fragment / final: one face each)
  const uf = Int32Array.from({ length: nF }, (_, i) => i);
  const find = (a: number): number => { while (uf[a] !== a) { uf[a] = uf[uf[a]!]!; a = uf[a]!; } return a; };
  if (op !== 'fragment' && op !== 'final')
    for (let s = 0; s < nS; s++) {
      const f = A.heFace[2 * s]!, g = A.heFace[2 * s + 1]!;
      if (f >= 0 && g >= 0 && group[f] != null && group[f] === group[g]) uf[find(f)] = find(g);
    }
  // source key of a sub: [obj, ord, pos + t] minimized over sources
  const subKey: Key[] = A.subs.map((S) => {
    let best: Key = [Infinity, Infinity, Infinity];
    for (const s of S.srcs) {
      const e = recs[s.rec]!;
      const k: Key = [recObj[s.rec]!, e.ord, e.pos + Math.min(s.ta, s.tb)];
      if (keyLess(k, best) < 0) best = k;
    }
    return best;
  });
  const comps = new Map<number, { faces: number[]; key: Key; base: string; origins: number[] }>();
  for (let f = 0; f < nF; f++) {
    if (group[f] == null) continue;
    const r = find(f);
    let c = comps.get(r);
    if (!c) { c = { faces: [], key: [Infinity, Infinity, Infinity], base: '', origins: [] }; comps.set(r, c); }
    c.faces.push(f);
    for (const k of origin[f + 1]!) if (!c.origins.includes(k)) c.origins.push(k);
    for (const h of A.faces[f]!.outer.concat(...A.faces[f]!.holes)) if (keyLess(subKey[h >> 1]!, c.key) < 0) c.key = subKey[h >> 1]!;
  }
  const domName = (k: number) => objs[keyObj[k]!]!.domains[keyDom[k]!]!;
  for (const c of comps.values()) {
    c.origins.sort((a, b) => a - b);
    if (op === 'union' || op === 'intersection') c.base = fid;
    else if (op === 'difference') c.base = objs[0]!.domains.length === 1 ? fid : domName(c.origins[0]!).id;
    else c.base = c.origins.map((k) => domName(k).id).join('&');
  }
  const compList = [...comps.entries()].sort((a, b) => keyLess(a[1].key, b[1].key));
  const baseCount = new Map<string, number>();
  for (const [, c] of compList) baseCount.set(c.base, (baseCount.get(c.base) ?? 0) + 1);
  const baseSeen = new Map<string, number>();
  const domains: DomainRec[] = [];
  const faceDom = new Int32Array(nF).fill(-1);
  for (const [, c] of compList) {
    const cnt = baseCount.get(c.base)!;
    const k = (baseSeen.get(c.base) ?? 0) + 1;
    baseSeen.set(c.base, k);
    const id = cnt > 1 ? `${c.base}#${k}` : c.base;
    let parent: string[] | undefined;
    const renamed = op === 'union' || op === 'intersection' || (op === 'difference' && objs[0]!.domains.length === 1);
    if (renamed || cnt > 1 || c.origins.length > 1) parent = c.origins.map((q) => `dom:${domName(q).id}`);
    else parent = domName(c.origins[0]!).parent;
    for (const f of c.faces) faceDom[f] = domains.length;
    const anc = uniqNot(c.origins.flatMap((q) => [`dom:${domName(q).id}`, ...(domName(q).anc ?? [])]), `dom:${id}`);
    const rec: DomainRec = parent ? { id, parent } : { id };
    if (anc.length) rec.anc = anc;
    domains.push(rec);
  }
  // kept subs
  const curveOnly = objs.every((o) => o.curveOnly);
  const subKept = new Uint8Array(nS);
  const dl = new Int32Array(nS), dr = new Int32Array(nS);
  const emb = new Uint8Array(nS);
  for (let s = 0; s < nS; s++) {
    const f = A.heFace[2 * s]!, g = A.heFace[2 * s + 1]!;
    dl[s] = f >= 0 ? faceDom[f]! : -1;
    dr[s] = g >= 0 ? faceDom[g]! : -1;
    emb[s] = A.subs[s]!.srcs.some((q) => recs[q.rec]!.embedded) ? 1 : 0;
    subKept[s] = curveOnly || dl[s] !== dr[s] || (emb[s] === 1 && (dl[s]! >= 0 || dr[s]! >= 0)) ? 1 : 0;
  }
  // source entity ids per sub, ordered by (obj, ord)
  const subIds: string[][] = A.subs.map((S) => {
    const l = S.srcs.map((q) => ({ id: recs[q.rec]!.id, o: recObj[q.rec]!, ord: recs[q.rec]!.ord }));
    l.sort((a, b) => a.o - b.o || a.ord - b.ord);
    const out: string[] = [];
    for (const x of l) if (!out.includes(x.id)) out.push(x.id);
    return out;
  });
  const sig = subIds.map((l, s) => `${l.join('|')}#${emb[s]}`);
  // chains through degree-2 vertices with equal signature and domains
  const nV = A.vx.length;
  const inc: number[][] = Array.from({ length: nV }, () => []);
  for (let s = 0; s < nS; s++) if (subKept[s]) { inc[A.subs[s]!.v0]!.push(s); inc[A.subs[s]!.v1]!.push(s); }
  const inChain = new Int32Array(nS).fill(-1);
  type Step = { s: number; dir: 1 | -1 };
  const chains: Array<{ steps: Step[]; key: Key; base: string; ids: string[]; closed: boolean }> = [];
  const endV = (st: Step) => (st.dir > 0 ? A.subs[st.s]!.v1 : A.subs[st.s]!.v0);
  const startV = (st: Step) => (st.dir > 0 ? A.subs[st.s]!.v0 : A.subs[st.s]!.v1);
  const lr = (st: Step): [number, number] => (st.dir > 0 ? [dl[st.s]!, dr[st.s]!] : [dr[st.s]!, dl[st.s]!]);
  const compatible = (a: Step, b: Step) => sig[a.s] === sig[b.s] && lr(a)[0] === lr(b)[0] && lr(a)[1] === lr(b)[1];
  for (let s0 = 0; s0 < nS; s0++) {
    if (!subKept[s0] || inChain[s0]! >= 0) continue;
    const ci = chains.length;
    const steps: Step[] = [{ s: s0, dir: 1 }];
    inChain[s0] = ci;
    let closed = false;
    for (;;) {
      const last = steps[steps.length - 1]!, v = endV(last);
      if (inc[v]!.length !== 2) break;
      const t = inc[v]![0] === last.s ? inc[v]![1]! : inc[v]![0]!;
      if (t === s0) { closed = true; break; }
      if (inChain[t]! >= 0) break;
      const st: Step = { s: t, dir: A.subs[t]!.v0 === v ? 1 : -1 };
      if (!compatible(last, st)) break;
      steps.push(st);
      inChain[t] = ci;
    }
    if (!closed)
      for (;;) {
        const first = steps[0]!, v = startV(first);
        if (inc[v]!.length !== 2) break;
        const t = inc[v]![0] === first.s ? inc[v]![1]! : inc[v]![0]!;
        if (inChain[t]! >= 0) break;
        const st: Step = { s: t, dir: A.subs[t]!.v1 === v ? 1 : -1 };
        if (!compatible(st, first)) break;
        steps.unshift(st);
        inChain[t] = ci;
      }
    // orient along the primary source
    const ids = subIds[s0]!;
    const prim = ids[0]!;
    const primSrc = (st: Step) => A.subs[st.s]!.srcs.find((q) => recs[q.rec]!.id === prim)!;
    const f0 = primSrc(steps[0]!);
    if ((f0.fwd ? 1 : -1) !== steps[0]!.dir) {
      steps.reverse();
      for (const st of steps) st.dir = st.dir > 0 ? -1 : 1;
    }
    const stepKey = (st: Step): Key => {
      const q = primSrc(st), e = recs[q.rec]!;
      return [recObj[q.rec]!, e.ord, e.pos + Math.min(q.ta, q.tb)];
    };
    if (closed) {
      let bi = 0;
      for (let i = 1; i < steps.length; i++) if (keyLess(stepKey(steps[i]!), stepKey(steps[bi]!)) < 0) bi = i;
      steps.push(...steps.splice(0, bi));
    }
    chains.push({ steps, key: stepKey(steps[0]!), base: prim, ids, closed });
  }
  chains.sort((a, b) => keyLess(a.key, b.key));
  const cCount = new Map<string, number>();
  for (const c of chains) cCount.set(c.base, (cCount.get(c.base) ?? 0) + 1);
  const cSeen = new Map<string, number>();
  const parentOfId = new Map<string, string[] | undefined>();
  const ancOfId = new Map<string, string[]>();
  for (const e of recs) {
    if (!parentOfId.has(e.id)) parentOfId.set(e.id, e.parent);
    if (e.anc) ancOfId.set(e.id, uniqNot([...(ancOfId.get(e.id) ?? []), ...e.anc], ''));
  }
  const edges: EdgeRec[] = [];
  const subRec = new Int32Array(nS).fill(-1);
  chains.forEach((c, ord) => {
    const cnt = cCount.get(c.base)!;
    const k = (cSeen.get(c.base) ?? 0) + 1;
    cSeen.set(c.base, k);
    const id = cnt > 1 ? `${c.base}#${k}` : c.base;
    const parent = cnt > 1 || c.ids.length > 1 ? c.ids.map((x) => `bnd:${x}`) : parentOfId.get(c.base);
    const anc = uniqNot(c.ids.flatMap((x) => [`bnd:${x}`, ...(ancOfId.get(x) ?? [])]), `bnd:${id}`);
    c.steps.forEach((st, pos) => {
      const S = A.subs[st.s]!;
      let curve = st.dir > 0 ? S.curve : reverse(S.curve);
      if (curve.kind === 'line') {
        const a = startV(st), b = endV(st);
        curve = { kind: 'line', a: [A.vx[a]!, A.vy[a]!], b: [A.vx[b]!, A.vy[b]!] };
      }
      const [l, r] = lr(st);
      subRec[st.s] = edges.length;
      const rec: EdgeRec = { curve, id, left: l, right: r, ord, pos, embedded: emb[st.s] === 1 };
      if (parent) rec.parent = parent;
      if (anc.length) rec.anc = anc;
      edges.push(rec);
    });
  });
  // points: chain end vertices
  const isEnd = new Uint8Array(nV);
  for (const c of chains) {
    if (c.closed) continue; // a closed loop (circle seam) has no end vertex (audit M1)
    isEnd[startV(c.steps[0]!)] = 1;
    isEnd[endV(c.steps[c.steps.length - 1]!)] = 1;
  }
  const named = new Map<number, PointRec[]>();
  for (const o of objs)
    for (const p of o.points) {
      let best = -1, bd = tol;
      for (let v = 0; v < nV; v++) {
        if (!isEnd[v]) continue;
        const d = Math.hypot(A.vx[v]! - p.p[0], A.vy[v]! - p.p[1]);
        if (d <= bd) { bd = d; best = v; }
      }
      if (best >= 0) { const l = named.get(best); if (l) l.push(p); else named.set(best, [p]); }
    }
  const newPts: Array<{ v: number; key: Key }> = [];
  const points: PointRec[] = [];
  for (let v = 0; v < nV; v++) {
    if (!isEnd[v]) continue;
    const l = named.get(v);
    const p: Vec2 = [A.vx[v]!, A.vy[v]!];
    if (l) {
      const rec: PointRec = { id: l[0]!.id, p };
      if (l.length > 1) rec.parent = l.map((q) => `pnt:${q.id}`);
      else if (l[0]!.parent) rec.parent = l[0]!.parent;
      const anc = uniqNot(l.flatMap((q) => [`pnt:${q.id}`, ...(q.anc ?? [])]), `pnt:${rec.id}`);
      if (anc.length) rec.anc = anc;
      points.push(rec);
    } else {
      let key: Key = [Infinity, Infinity, Infinity];
      for (const s of inc[v]!) {
        for (const q of A.subs[s]!.srcs) {
          const e = recs[q.rec]!;
          const t = A.subs[s]!.v0 === v ? q.ta : q.tb;
          const k: Key = [recObj[q.rec]!, e.ord, e.pos + t];
          if (keyLess(k, key) < 0) key = k;
        }
      }
      newPts.push({ v, key });
    }
  }
  newPts.sort((a, b) => keyLess(a.key, b.key));
  newPts.forEach((q, i) => points.push({ id: `${fid}.x${i + 1}`, p: [A.vx[q.v]!, A.vy[q.v]!] }));
  return { obj: { feature: fid, domains: curveOnly ? [] : domains, edges, points, curveOnly }, arr: A, subKept, subRec, faceDom };
}

// ---------------------------------------------------------------- build

function bboxOfObjs(objs: Obj[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objs)
    for (const e of o.edges)
      for (let i = 0; i <= 16; i++) {
        const p = point(e.curve, i / 16);
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      }
  return [x0, y0, x1, y1];
}

/** Build a 2D geometry from an ordered feature list (lengths in metres). */
export function buildGeometry2D(spec: GeometrySpec2D, opts: { relTol?: number } = {}): Geometry2D {
  if (spec.dim !== undefined && spec.dim !== 2) fail('buildGeometry2D: dim must be 2');
  const live = new Map<string, Obj>();
  const order: string[] = [];
  const all: Obj[] = [];
  const seen = new Set<string>();
  const prims: Obj[] = [];
  for (const f of spec.features) if (!['union', 'intersection', 'difference', 'fragment'].includes(f.type)) prims.push(primitive(f));
  const bb0 = bboxOfObjs(prims);
  const scale = Math.hypot(bb0[2] - bb0[0], bb0[3] - bb0[1]);
  if (!(scale > 0)) fail('empty geometry');
  const tol = (opts.relTol ?? 1e-9) * scale;
  // no silent drop (audit S3): a primitive smaller than 10 x the merge tolerance cannot be represented
  prims.forEach((o) => {
    const b = bboxOfObjs([o]);
    const ext = Math.hypot(b[2] - b[0], b[3] - b[1]);
    if (ext < 10 * tol) fail(`${o.feature}: extent ${ext.toPrecision(3)} m is below 10 x the geometric tolerance (${tol.toPrecision(3)} m = ${opts.relTol ?? 1e-9} x model size ${scale.toPrecision(3)} m); scale the model or pass a smaller relTol`);
  });
  let pi = 0;
  const take = (ids: string[], who: string) =>
    ids.map((x) => {
      const o = live.get(x);
      if (!o) fail(`${who}: input '${x}' ${seen.has(x) ? 'was already consumed' : 'is not defined before this feature'}`);
      return o!;
    });
  for (const f of spec.features) {
    if (!ID_RE.test(f.id)) fail(`feature id '${f.id}' must match ${ID_RE}`);
    if (seen.has(f.id)) fail(`duplicate feature id '${f.id}'`);
    seen.add(f.id);
    let o: Obj;
    if (f.type === 'union' || f.type === 'intersection' || f.type === 'fragment') {
      if (!Array.isArray(f.inputs) || f.inputs.length < (f.type === 'fragment' ? 1 : 2)) fail(`${f.id}: ${f.type} needs inputs`);
      const ins = take(f.inputs, f.id);
      for (const x of f.inputs) live.delete(x);
      o = combine(f.type, f.id, ins, tol).obj;
    } else if (f.type === 'difference') {
      if (!f.tools?.length) fail(`${f.id}: difference needs tools`);
      const ins = take([f.target, ...f.tools], f.id);
      if (ins.some((x) => x.curveOnly)) fail(`${f.id}: difference needs solid inputs`);
      live.delete(f.target);
      if (!f.keepTools) for (const x of f.tools) live.delete(x);
      o = combine('difference', f.id, ins, tol).obj;
      if (!o.domains.length) fail(`${f.id}: difference removes the whole target`);
    } else o = prims[pi++]!;
    live.set(f.id, o);
    order.push(f.id);
    all.push(o);
  }
  const remaining = [...live.values()];
  if (!remaining.some((o) => !o.curveOnly)) fail('no solid domain in the geometry');
  const R = combine('final', 'geom', remaining, tol);
  if (!R.obj.domains.length) fail('the final geometry has no domain although solid features exist (report this geometry)');
  const G = toGeometry(R, !!spec.axisym, tol, order);
  // near-tolerance entities (audit S2): resolvable, but represented with few significant digits
  const len = new Map<number, number>();
  for (const e of G.edges) {
    const a = [G.vertices[2 * e.v0]!, G.vertices[2 * e.v0 + 1]!], b = [G.vertices[2 * e.v1]!, G.vertices[2 * e.v1 + 1]!];
    const m = point(e.curve, 0.5);
    len.set(e.boundary, (len.get(e.boundary) ?? 0) + Math.hypot(m[0] - a[0]!, m[1] - a[1]!) + Math.hypot(b[0]! - m[0], b[1]! - m[1]));
  }
  for (const [b, L] of len)
    if (L < 1e3 * tol) G.warnings.push(`${G.entities.boundaries[b]!.id}: length ${L.toPrecision(3)} m is within 1000 x the geometric tolerance (${tol.toPrecision(3)} m); its shape is not reliable`);
  return G;
}

function toGeometry(R: CombineResult, axisym: boolean, tol: number, features: string[]): Geometry2D {
  const { obj, arr, subKept, subRec } = R;
  const used = new Int32Array(arr.vx.length).fill(-1);
  let nv = 0;
  const edges: GeomEdge[] = [];
  const bIndex = new Map<string, number>();
  const boundaries: EntityRef[] = [];
  for (const e of obj.edges) {
    if (!bIndex.has(e.id)) {
      bIndex.set(e.id, boundaries.length);
      const ref: EntityRef = { id: `bnd:${e.id}` };
      if (e.parent) ref.parent = e.parent;
      if (e.anc) ref.ancestors = e.anc;
      boundaries.push(ref);
    }
  }
  for (let s = 0; s < arr.subs.length; s++) {
    if (!subKept[s]) continue;
    const S = arr.subs[s]!, rec = obj.edges[subRec[s]!]!;
    for (const v of [S.v0, S.v1]) if (used[v]! < 0) used[v] = nv++;
    // orient as the record (chain direction)
    const fwd = rec.curve.kind === 'line' ? Math.hypot(rec.curve.a[0] - arr.vx[S.v0]!, rec.curve.a[1] - arr.vy[S.v0]!) <= tol : true;
    const sameDir = rec.curve.kind === 'line' ? fwd : (() => {
      const p = point(rec.curve, 0);
      return Math.hypot(p[0] - arr.vx[S.v0]!, p[1] - arr.vy[S.v0]!) <= Math.hypot(p[0] - arr.vx[S.v1]!, p[1] - arr.vy[S.v1]!);
    })();
    edges.push({
      v0: used[sameDir ? S.v0 : S.v1]!, v1: used[sameDir ? S.v1 : S.v0]!, curve: rec.curve,
      boundary: bIndex.get(rec.id)!, left: rec.left, right: rec.right,
    });
  }
  const vertices = new Float64Array(2 * nv);
  for (let v = 0; v < arr.vx.length; v++) if (used[v]! >= 0) { vertices[2 * used[v]!] = arr.vx[v]!; vertices[2 * used[v]! + 1] = arr.vy[v]!; }
  const pointsRef: EntityRef[] = [];
  const pv: number[] = [];
  for (const p of obj.points) {
    let best = -1, bd = tol;
    for (let v = 0; v < nv; v++) {
      const d = Math.hypot(vertices[2 * v]! - p.p[0], vertices[2 * v + 1]! - p.p[1]);
      if (d <= bd) { bd = d; best = v; }
    }
    if (best < 0) continue;
    const ref: EntityRef = { id: `pnt:${p.id}` };
    if (p.parent) ref.parent = p.parent;
    if (p.anc) ref.ancestors = p.anc;
    pointsRef.push(ref);
    pv.push(best);
  }
  const domains: EntityRef[] = obj.domains.map((d) => {
    const ref: EntityRef = { id: `dom:${d.id}` };
    if (d.parent) ref.parent = d.parent;
    if (d.anc) ref.ancestors = d.anc;
    return ref;
  });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of edges)
    for (let i = 0; i <= 32; i++) {
      const p = point(e.curve, i / 32);
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
  if (axisym) {
    if (x0 < -tol) fail(`axisymmetric geometry extends to r = ${x0} < 0`);
    const onAxis = new Map<number, boolean>();
    for (const e of edges) {
      const ok = e.curve.kind === 'line' && Math.abs(e.curve.a[0]) <= tol && Math.abs(e.curve.b[0]) <= tol;
      onAxis.set(e.boundary, (onAxis.get(e.boundary) ?? true) && ok);
    }
    for (const [b, ok] of onAxis) if (ok) boundaries[b]!.axis = true;
    for (let v = 0; v < nv; v++) if (Math.abs(vertices[2 * v]!) <= tol) vertices[2 * v] = 0;
    for (const e of edges) if (e.curve.kind === 'line') {
      if (Math.abs(e.curve.a[0]) <= tol) e.curve.a = [0, e.curve.a[1]];
      if (Math.abs(e.curve.b[0]) <= tol) e.curve.b = [0, e.curve.b[1]];
    }
    x0 = Math.max(0, x0);
  }
  return {
    dim: 2, axisym, tol, bbox: [x0, y0, x1, y1], vertices, edges,
    entities: { domains, boundaries, points: pointsRef }, pointVertex: Int32Array.from(pv), features, warnings: [],
  };
}

/** Does entity id `a` belong to selection id `x`: equal, or a piece `x#k`, `x#k#m`, ... */
const isPieceOf = (a: string, x: string) => a === x || a.startsWith(`${x}#`);

export type EntityKindKey = 'domains' | 'boundaries' | 'edges' | 'points';

/**
 * The canonical selection resolver (CONTRACTS-v0 changelog 2026-11-06 16:16; audit S1). Owned by @amp/geom, used by
 * @amp/mesh and injected into @amp/spec checkSelections. An id X of the given kind selects every entity whose id is X
 * or a split piece X#k, X#k#m, ... (any depth), or whose `parent` or `ancestors` (transitive closure over parent,
 * recorded at construction) contain X or a piece of X. Never throws: ids that match nothing go to `unknown`.
 * `expansion` (id -> matched entity ids) is an addition for readiness messages (coordinator decision 6).
 */
export function resolveEntityIds(table: EntityTable, kind: EntityKindKey, ids: readonly string[]):
  { indices: number[]; unknown: string[]; expansion: Record<string, string[]> } {
  const list = table[kind] ?? [];
  const out = new Set<number>();
  const unknown: string[] = [];
  const expansion: Record<string, string[]> = {};
  for (const x of ids) {
    const hit: string[] = [];
    list.forEach((e, i) => {
      if (isPieceOf(e.id, x) || e.parent?.some((p) => isPieceOf(p, x)) || e.ancestors?.some((p) => isPieceOf(p, x))) { out.add(i); hit.push(e.id); }
    });
    if (hit.length) expansion[x] = hit;
    else unknown.push(x);
  }
  return { indices: [...out].sort((a, b) => a - b), unknown, expansion };
}

/** resolveEntityIds that throws on unknown ids (internal convenience for the meshers). */
export function selectIndices(table: EntityTable, kind: EntityKindKey, ids: string[]): number[] {
  const r = resolveEntityIds(table, kind, ids);
  if (r.unknown.length) fail(`selection ${r.unknown.map((u) => `'${u}'`).join(', ')} matches no ${kind === 'boundaries' ? 'boundary' : kind.slice(0, -1)}`);
  return r.indices;
}

/** Area of every domain by Green's theorem on the exact curves (Gauss-Legendre per edge). */
export function domainAreas(g: Geometry2D, nSeg = 64): Float64Array {
  const A = new Float64Array(g.entities.domains.length);
  const gx = [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664];
  const gw = [0.23692688505618908, 0.47862867049936647, 0.5688888888888889, 0.47862867049936647, 0.23692688505618908];
  for (const e of g.edges) {
    let c = 0;
    const n = e.curve.kind === 'line' ? 1 : nSeg;
    for (let i = 0; i < n; i++)
      for (let q = 0; q < 5; q++) {
        const t = (i + 0.5 + 0.5 * gx[q]!) / n;
        const p = point(e.curve, t), d = deriv(e.curve, t);
        c += (gw[q]! / (2 * n)) * 0.5 * (p[0] * d[1] - p[1] * d[0]);
      }
    if (e.left >= 0) A[e.left]! += c;
    if (e.right >= 0) A[e.right]! -= c;
  }
  return A;
}
