// SPDX-License-Identifier: GPL-3.0-or-later
// Layered 2.5D solids (DevLog-044): a stack of z-layers, each with its own 2D sketch (a set of 2D features built like
// a 2D geometry). All sketches are fragmented into one 2D overlay arrangement, so a mesher that extrudes the overlay
// mesh is conforming across every layer interface by construction. The 3D entity table is named from the sketches:
//   domain     `dom:<D>.<layer>`                 parent dom:<D>, dom:<stack>.<layer>; dom:<stack> selects every domain
//   side wall  `bnd:<B>.<layer>`                 parent bnd:<B>
//   caps       `bnd:<D>.<layer>.top` (lower domain owns an interface; parent = the upper `bnd:<D'>.<layer'>.bottom`),
//              `bnd:<D>.<layer>.bottom` where nothing is below; a face with several pieces is numbered over all
//              pieces, exterior first, then partner domain order (`#1`, `#2`, ...; CONTRACTS-v0 G2 rule); exterior
//              caps on the first / last plane also list bnd:<stack>.bottom / bnd:<stack>.top.
// A split suffix of a 2D id moves to the end of the 3D id (`si#2` in layer sub -> `dom:si.sub#2`), as the C2 grammar
// requires. Layer ids are sub-entities (default `L<k>`, the DevLog-004 grammar); `top` and `bottom` are reserved.

import { buildGeometry2D, combine, mergeEdgePieces, toGeometry, type Feature, type Geometry2D, type Obj, type EdgeRec } from './model.ts';
import type { EntityRef, EntityTable } from './types.ts';
import { hyp2 } from './detmath.ts';

export interface StackLayerInput {
  id?: string;
  /** absolute start (m); must be >= the running top (a gap is empty space) */
  z0?: number;
  thickness: number;
  /** the sketch: 2D features in construction order (the listed features plus their transitive inputs); [] = empty */
  features: Feature[];
  /** cells along z, or cell size along z (m) */
  nz?: number;
  dz?: number;
}
export interface StackInput { id: string; z0?: number; layers: StackLayerInput[] }

export interface StackLayer { id: string; z: [number, number]; nz?: number; dz?: number; sketch: Geometry2D | null; gap: boolean }
export interface DomInfo { layer: number; d2: number }
export type BndInfo =
  | { kind: 'side'; layer: number; b2: number }
  | { kind: 'cap'; plane: number; below: number; above: number };

export interface Stack {
  kind: 'stack';
  id: string;
  /** layers in z order, including internal gap layers (no cells) */
  layers: StackLayer[];
  /** overlay of every sketch (internal ids `<layer>/<2D id>`; ancestors carry the sketch ids for mesh.refine) */
  overlay: Geometry2D;
  /** (overlay domain f, layer k) -> 3D domain index or -1, at f * nL + k */
  dom3: Int32Array;
  /** (overlay boundary b, layer k) -> boundary index in layer k's sketch on which b lies, or -1, at b * nL + k */
  bndSrc: Int32Array;
  /** (layer k, sketch boundary b2) -> 3D side boundary index or -1, at sideOff[k] + b2 */
  sideIndex: Int32Array;
  sideOff: Int32Array;
  /** (plane j, below 3D domain, above 3D domain) -> 3D cap boundary index (key capKey) */
  capIndex: Map<string, number>;
  entities: EntityTable;
  domInfo: DomInfo[];
  bndInfo: BndInfo[];
  warnings: string[];
}

export const capKey = (j: number, below: number, above: number) => `${j}|${below}|${above}`;

const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED = new Set(['top', 'bottom']);
const fail = (m: string): never => { throw new Error(`geom: ${m}`); };
const strip = (id: string) => id.replace(/^(dom|bnd|pnt|edg):/, '');
/** a is x or a split piece of x (the resolver's piece rule) */
const isPiece = (a: string, x: string) => a === x || a.startsWith(`${x}#`);
/** 2D id + sub-entity suffix -> 3D id with the split suffix moved to the end. */
export function id3(kind: 'dom' | 'bnd', id2: string, suffix: string): string {
  const s = strip(id2);
  const m = /((?:#\d+)*)$/.exec(s)!;
  return `${kind}:${s.slice(0, s.length - m[1]!.length)}${suffix}${m[1]}`;
}

export function buildStack(inp: StackInput): Stack {
  if (!ID_RE.test(inp.id)) fail(`extrude id '${inp.id}' invalid`);
  if (!inp.layers.length) fail(`${inp.id}: extrude needs at least one layer`);
  const S = inp.id;
  // sketches
  const sketches = inp.layers.map((L, k) => {
    if (!(L.thickness > 0) || !Number.isFinite(L.thickness)) fail(`${S}: layer ${L.id ?? k} thickness must be > 0`);
    if (!L.features.length) return null;
    try { return buildGeometry2D({ features: L.features }, { mergeCurvePieces: false }); }   // merged below (mergeEdgePieces)
    catch (e) { return fail(`${S}: layer ${L.id ?? `L${k}`} sketch: ${(e as Error).message.replace(/^geom: /, '')}`); }
  });
  let xy = 0;
  for (const g of sketches) if (g) xy = Math.max(xy, hyp2(g.bbox[2] - g.bbox[0], g.bbox[3] - g.bbox[1]));
  if (!(xy > 0)) fail(`${S}: every layer is empty`);
  const height = inp.layers.reduce((a, L) => a + L.thickness, 0);
  const ztol = 1e-9 * Math.max(xy, height);
  // layers in z, with gap layers
  const layers: StackLayer[] = [];
  const seen = new Set<string>();
  let z = inp.z0 ?? 0;
  inp.layers.forEach((L, k) => {
    const id = L.id ?? `L${k}`;
    if (!ID_RE.test(id) || RESERVED.has(id) || seen.has(id)) fail(`${S}: layer id '${id}' invalid, reserved (top, bottom) or duplicate`);
    seen.add(id);
    if (L.z0 !== undefined) {
      if (L.z0 < z - ztol) fail(`${S}: layer ${id} starts at z0 = ${L.z0} m, below the top of the previous layer (${z} m): layers may not overlap`);
      if (L.z0 > z + ztol) { layers.push({ id: `${S}-gap${k}`, z: [z, L.z0], nz: 1, sketch: null, gap: true }); z = L.z0; }
    }
    const lay: StackLayer = { id, z: [z, z + L.thickness], sketch: sketches[k]!, gap: false };
    if (L.nz !== undefined) { if (!(Number.isInteger(L.nz) && L.nz >= 1)) fail(`${S}: layer ${id}: nz must be an integer >= 1`); lay.nz = L.nz; }
    if (L.dz !== undefined) { if (!(L.dz > 0)) fail(`${S}: layer ${id}: dz must be > 0`); lay.dz = L.dz; }
    layers.push(lay);
    z += L.thickness;
  });
  const nL = layers.length;
  // overlay: one object per non-empty layer, ids prefixed by the layer id so that coincident edges of different
  // layers stay distinguishable (chains then never mix layer sets)
  const objs: Obj[] = [], objLayer: number[] = [], recB2: Array<Map<string, number>> = [];
  layers.forEach((L, k) => {
    const g = L.sketch;
    if (!g) return;
    const pre = `${L.id}/`;
    const B = g.entities.boundaries;
    const m = new Map<string, number>();
    const cnt = new Int32Array(B.length);
    const edges: EdgeRec[] = mergeEdgePieces(g).edges.map((e) => {
      const b = B[e.boundary]!;
      const id = pre + strip(b.id);
      m.set(id, e.boundary);
      return { curve: e.curve, id, anc: [b.id, ...(b.ancestors ?? [])], left: e.left, right: e.right, ord: e.boundary, pos: cnt[e.boundary]!++, embedded: e.left === e.right };
    });
    objs.push({
      feature: `${S}/${L.id}`, curveOnly: false, points: [], edges,
      domains: g.entities.domains.map((d) => ({ id: pre + strip(d.id), anc: [d.id, ...(d.ancestors ?? [])] })),
    });
    objLayer.push(k);
    recB2.push(m);
  });
  const R = combine('fragment', S, objs, 1e-9 * xy);
  if (!R.obj.domains.length) fail(`${S}: the layer sketches have no area`);
  const overlay = mergeEdgePieces(toGeometry(R, false, 1e-9 * xy, [S]));
  // 3D domains
  const domains: EntityRef[] = [], domInfo: DomInfo[] = [];
  const domIdx: Int32Array[] = layers.map((L) => new Int32Array(L.sketch?.entities.domains.length ?? 0).fill(-1));
  layers.forEach((L, k) => {
    L.sketch?.entities.domains.forEach((d, i) => {
      domIdx[k]![i] = domains.length;
      domInfo.push({ layer: k, d2: i });
      domains.push({ id: id3('dom', d.id, `.${L.id}`), label: `${strip(d.id)} in layer ${L.id}`, parent: [d.id, `dom:${S}.${L.id}`], ancestors: [d.id, `dom:${S}.${L.id}`, `dom:${S}`, ...(d.ancestors ?? [])] });
    });
  });
  const nF = overlay.entities.domains.length, nB = overlay.entities.boundaries.length;
  const dom3 = new Int32Array(nF * nL).fill(-1);
  R.domOrigins.forEach((orig, f) => {
    for (const [o, d] of orig) dom3[f * nL + objLayer[o]!] = domIdx[objLayer[o]!]![d]!;
  });
  const bndSrc = new Int32Array(nB * nL).fill(-1);
  const bIndex = new Map(overlay.entities.boundaries.map((b, i) => [b.id, i]));
  R.obj.edges.forEach((e, i) => {
    const b = bIndex.get(`bnd:${e.id}`)!;
    for (const [o, id] of R.edgeSrc[i]!) bndSrc[b * nL + objLayer[o]!] = recB2[o]!.get(id)!;
  });
  // 3D boundaries: plane j caps, then layer j side walls
  const boundaries: EntityRef[] = [], bndInfo: BndInfo[] = [];
  const sideOff = new Int32Array(nL + 1);
  layers.forEach((L, k) => { sideOff[k + 1] = sideOff[k]! + (L.sketch?.entities.boundaries.length ?? 0); });
  const sideIndex = new Int32Array(sideOff[nL]!).fill(-1);
  const capIndex = new Map<string, number>();
  const lay = (X: number) => layers[domInfo[X]!.layer]!;
  const sk2 = (X: number) => lay(X).sketch!.entities.domains[domInfo[X]!.d2]!.id;
  for (let j = 0; j <= nL; j++) {
    const pairs: Array<[number, number]> = [];
    const has = new Set<string>();
    for (let f = 0; f < nF; f++) {
      const b = j > 0 ? dom3[f * nL + j - 1]! : -1, a = j < nL ? dom3[f * nL + j]! : -1;
      if (b < 0 && a < 0) continue;
      const k = `${b}|${a}`;
      if (!has.has(k)) { has.add(k); pairs.push([b, a]); }
    }
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const tops = new Map<number, number[]>(), bots = new Map<number, number[]>();
    for (const [b, a] of pairs) {
      if (b >= 0) { const l = tops.get(b) ?? []; l.push(a); tops.set(b, l); }
      if (a >= 0) { const l = bots.get(a) ?? []; l.push(b); bots.set(a, l); }
    }
    const piece = (X: number, partner: number, side: 'top' | 'bottom') => {
      const list = (side === 'top' ? tops : bots).get(X)!.slice().sort((p, q) => p - q);
      const base = id3('bnd', sk2(X), `.${lay(X).id}.${side}`);
      return list.length > 1 ? `${base}#${list.indexOf(partner) + 1}` : base;
    };
    for (const [b, a] of pairs) {
      const parent: string[] = [];
      let id: string, label: string;
      if (b >= 0) {
        id = piece(b, a, 'top');
        label = `top of ${strip(sk2(b))} in layer ${lay(b).id}`;
        if (a >= 0) { parent.push(piece(a, b, 'bottom')); label += ` / bottom of ${strip(sk2(a))} in layer ${lay(a).id}`; }
      } else { id = piece(a, b, 'bottom'); label = `bottom of ${strip(sk2(a))} in layer ${lay(a).id}`; }
      if (j === 0 && b < 0) parent.push(`bnd:${S}.bottom`);
      if (j === nL && a < 0) parent.push(`bnd:${S}.top`);
      capIndex.set(capKey(j, b, a), boundaries.length);
      bndInfo.push({ kind: 'cap', plane: j, below: b, above: a });
      const ref: EntityRef = { id, label };
      if (parent.length) { ref.parent = parent; ref.ancestors = parent.slice(); }
      boundaries.push(ref);
    }
    if (j === nL) break;
    const L = layers[j]!, g = L.sketch;
    if (!g) continue;
    const lr: Array<[number, number] | null> = g.entities.boundaries.map(() => null);
    for (const e of g.edges) if (!lr[e.boundary]) lr[e.boundary] = [e.left, e.right];
    g.entities.boundaries.forEach((B, b2) => {
      const s = lr[b2];
      if (!s || s[0] === s[1]) return;   // embedded curve inside one domain: no wall
      sideIndex[sideOff[j]! + b2] = boundaries.length;
      bndInfo.push({ kind: 'side', layer: j, b2 });
      const anc = [B.id, ...(B.ancestors ?? [])];
      // a wall shared with a neighbouring sketch entity: the neighbour's name in this layer selects it too (both
      // owners' names select a shared piece, C2 G1); its plain 2D name already does through the 2D ancestors
      for (const x of new Set([...(B.parent ?? []), ...(B.ancestors ?? [])]))
        if (x.startsWith('bnd:') && !isPiece(B.id, x)) { const a = id3('bnd', x, `.${L.id}`); if (!anc.includes(a)) anc.push(a); }
      boundaries.push({ id: id3('bnd', B.id, `.${L.id}`), label: `${strip(B.id)} in layer ${L.id}`, parent: [B.id], ancestors: anc });
    });
  }
  const warnings = [...overlay.warnings];
  for (const g of sketches) if (g) warnings.push(...g.warnings);
  return {
    kind: 'stack', id: S, layers, overlay, dom3, bndSrc, sideIndex, sideOff, capIndex,
    entities: { domains, boundaries }, domInfo, bndInfo, warnings: [...new Set(warnings)],
  };
}

// ----------------------------------------------------------------------------------------- mixed 3D primitives

export type PrimitiveSolid =
  | { type: 'box'; id: string; x: [number, number]; y: [number, number]; z: [number, number] }
  | { type: 'cylinder'; id: string; radius: number; height: number; base: [number, number, number]; axis: 'x' | 'y' | 'z' };

const BOX_SIDE: Record<string, string> = { bottom: 'ymin', right: 'xmax', top: 'ymax', left: 'xmin' };
/** stack id of mixed boxes / z cylinders (reserved: no solid may use it) */
export const MIXED_STACK_ID = 'solids';

/**
 * Boxes and z-axis cylinders as a stack (DevLog-044 s.1.4): one layer per interval between the solids' z ends,
 * sketch = footprints of the solids spanning it. Overlapping solids need a boolean (error). The primitive names stay
 * valid: dom:<id>; box bnd:<id>.xmin|xmax|ymin|ymax|zmin|zmax; cylinder bnd:<id>.side|bottom|top (added as parents);
 * a face shared by two solids is selected by both solids' names. The stack id (default MIXED_STACK_ID) is reserved:
 * a solid with that id would collide with the stack aggregates dom:<stack>, dom:<stack>.<layer>, bnd:<stack>.top|bottom.
 */
export function stackFromSolids(solids: PrimitiveSolid[], id = MIXED_STACK_ID): Stack {
  const clash = solids.filter((s) => s.id === id);
  if (clash.length) fail(`solid id '${id}' is reserved in a geometry of mixed boxes / cylinders: it names the whole stack (dom:${id}, dom:${id}.<layer>, bnd:${id}.top / .bottom); rename the solid`);
  const zr = (s: PrimitiveSolid): [number, number] => {
    if (s.type === 'box') return s.z;
    if (s.axis !== 'z') return fail(`cylinder '${s.id}' with axis ${s.axis} combined with other solids: only z-axis cylinders combine with boxes (true 3D CSG is tier 2; rotate the model so the cylinders are along z, or use an extrude feature)`);
    return [s.base[2], s.base[2] + s.height];
  };
  const ranges = solids.map(zr);
  const all = ranges.flat().sort((a, b) => a - b);
  const span = all[all.length - 1]! - all[0]!;
  const tol = 1e-9 * Math.max(span, ...solids.map((s) => (s.type === 'box' ? Math.max(s.x[1] - s.x[0], s.y[1] - s.y[0]) : 2 * s.radius)));
  const zs: number[] = [];
  for (const v of all) if (!zs.length || v - zs[zs.length - 1]! > tol) zs.push(v);
  const feat = (s: PrimitiveSolid): Feature => (s.type === 'box'
    ? { id: s.id, type: 'rect', x: s.x, y: s.y }
    : { id: s.id, type: 'circle', c: [s.base[0], s.base[1]], r: s.radius });
  const layers: StackLayerInput[] = [];
  for (let i = 0; i + 1 < zs.length; i++) {
    const act = solids.filter((_, k) => ranges[k]![0] <= zs[i]! + tol && ranges[k]![1] >= zs[i + 1]! - tol);
    layers.push({ id: `z${i}`, thickness: zs[i + 1]! - zs[i]!, features: act.map(feat) });
  }
  let st: Stack;
  try { st = buildStack({ id, z0: zs[0]!, layers }); }
  catch (e) {
    const msg = (e as Error).message;
    const m = /layer z(\d+) sketch: overlapping domains ([^ ]+(?:, [^ ]+)*) without a boolean/.exec(msg);
    if (m) {
      const i = Number(m[1]);
      fail(`3D solids ${m[2]} overlap in z [${zs[i]}, ${zs[i + 1]}] m: overlapping 3D primitives need a boolean (true 3D CSG is tier 2). Write the model as an extrude feature whose layer sketch uses a 2D difference (e.g. a via: difference of the slab rect and the via circle with keepTools)`);
    }
    throw e;
  }
  // primitive aliases
  const solidOf = new Map(solids.map((s, k) => [s.id, k]));
  const sid = (X: number) => strip(st.layers[st.domInfo[X]!.layer]!.sketch!.entities.domains[st.domInfo[X]!.d2]!.id).replace(/#\d+$/, '');
  const planeZ = (j: number) => (j < st.layers.length ? st.layers[j]!.z[0] : st.layers[j - 1]!.z[1]);
  st.bndInfo.forEach((inf, i) => {
    const ref = st.entities.boundaries[i]!;
    const add = (x: string) => { ref.parent = [...(ref.parent ?? []), x]; ref.ancestors = [...(ref.ancestors ?? []), x]; };
    if (inf.kind === 'side') {
      const lid = st.layers[inf.layer]!.id;
      const B2 = st.layers[inf.layer]!.sketch!.entities.boundaries[inf.b2]!;
      /** 2D rect / circle boundary name -> 3D face name of its solid (`A.left#2` -> solid A, `A.xmin`, `#2`), or null */
      const face = (x: string): { s: string; nm: string; split: string } | null => {
        const B = strip(x);
        const split = /((?:#\d+)*)$/.exec(B)![1]!;
        const [s, sub] = [B.slice(0, B.indexOf('.')), B.slice(B.indexOf('.') + 1, B.length - split.length)];
        const k = solidOf.get(s);
        const nm = k === undefined ? undefined : solids[k]!.type === 'box' ? BOX_SIDE[sub] : sub === 'edge' ? 'side' : undefined;
        return nm ? { s, nm: `${s}.${nm}`, split } : null;
      };
      const own = face(B2.id);
      if (!own) return;
      // the 2D rect / circle names (left, top, edge, ...) would read as box faces: replace them by the 3D face names
      ref.id = id3('bnd', `${own.nm}${own.split}`, `.${lid}`);
      ref.label = `${own.nm}${own.split} in layer ${lid}`;
      const parent = [`bnd:${own.nm}${own.split}`];
      const anc = own.split ? [`bnd:${own.nm}${own.split}`, `bnd:${own.nm}`] : [`bnd:${own.nm}`];
      const put = (l: string[], x: string) => { if (!l.includes(x)) l.push(x); };
      // a face shared with a neighbouring solid (its 2D name is in the sketch boundary's parent / ancestors): the
      // neighbour's face names select the shared piece too (both owners' names select a shared piece, C2 G1)
      for (const x of [...(B2.parent ?? []), ...(B2.ancestors ?? [])]) {
        const f = x.startsWith('bnd:') ? face(x) : null;
        if (!f || f.s === own.s) continue;
        put(parent, `bnd:${f.nm}${f.split}`);
        for (const a of [`bnd:${f.nm}${f.split}`, `bnd:${f.nm}`, id3('bnd', `${f.nm}${f.split}`, `.${lid}`)]) put(anc, a);
      }
      ref.parent = parent;
      ref.ancestors = anc;
      return;
    }
    const z = planeZ(inf.plane);
    if (inf.below >= 0) {
      const k = solidOf.get(sid(inf.below))!;
      if (Math.abs(ranges[k]![1] - z) <= tol) add(`bnd:${solids[k]!.id}.${solids[k]!.type === 'box' ? 'zmax' : 'top'}`);
    }
    if (inf.above >= 0) {
      const k = solidOf.get(sid(inf.above))!;
      if (Math.abs(ranges[k]![0] - z) <= tol) add(`bnd:${solids[k]!.id}.${solids[k]!.type === 'box' ? 'zmin' : 'bottom'}`);
    }
  });
  return st;
}
