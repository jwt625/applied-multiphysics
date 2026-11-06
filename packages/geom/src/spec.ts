// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/geom/spec: amp-spec/0 bindings of the geometry features. (1) GEOM_FEATURES: the registry entries that supersede
// the provisional seed of @amp/spec (register with {replace: true}); (2) geometryFromSpec: spec geometry block ->
// Geometry2D (2D / axisym) or a list of 3D primitives. This subpath depends on @amp/spec and zod; the main @amp/geom
// entry stays dependency-free (robust-predicates only).
//
// Sub-entity names (confirmed for L2, DevLog-003 s.5 item 4):
//   rect bottom/right/top/left (+ points p0..p3), circle and ellipse edge, polygon e0..e(n-1) (+ v0..), arc e0,
//   polyline e0.. (+ v0..), box xmin/xmax/ymin/ymax/zmin/zmax, cylinder side/bottom/top (bottom at `base`).
//   union / intersection / difference (single-domain target): result domain = feature id; fragment: origin ids
//   joined with '&'; boundaries keep their creating feature's id; pieces `#k`; `parent` lists the origins.

import * as z from 'zod';
import { quantity, vector, nodeId, resolveQuantity, type Registration, type Registry, type ScopeValue } from '@amp/spec';
import { buildGeometry2D, type Feature, type Geometry2D } from './model.ts';
import type { Vec2 } from './curves.ts';

const owner = '@amp/geom';
const D2 = ['2d', '2d-axisym'] as const;
const ids = z.array(nodeId).min(1);

export const GEOM_FEATURES: Registration[] = [
  { kind: 'feature', type: 'rect', owner, dims: D2, description: 'Axis-aligned rectangle; boundaries bottom/right/top/left, points p0..p3',
    settings: z.strictObject({ size: vector('m', 2), center: vector('m', 2) }) },
  { kind: 'feature', type: 'circle', owner, dims: D2, description: 'Disk; boundary edge',
    settings: z.strictObject({ center: vector('m', 2), radius: quantity('m') }) },
  { kind: 'feature', type: 'ellipse', owner, dims: D2, description: 'Ellipse with semi-axes along (cos rot, sin rot) and its normal; boundary edge',
    settings: z.strictObject({ center: vector('m', 2), semiAxes: vector('m', 2), rotation: quantity('1').optional() }) },
  { kind: 'feature', type: 'polygon', owner, dims: D2, description: 'Simple polygon; boundaries e0..e(n-1) (edge i from point i to i+1), points v0..',
    settings: z.strictObject({ points: z.array(vector('m', 2)).min(3) }) },
  { kind: 'feature', type: 'arc', owner, dims: D2, description: 'Circular arc (embedded curve); boundary e0, points v0, v1',
    settings: z.strictObject({ center: vector('m', 2), radius: quantity('m'), start: quantity('1'), end: quantity('1') }) },
  { kind: 'feature', type: 'polyline', owner, dims: D2, description: 'Open polyline (embedded curve); boundaries e0.., points v0..',
    settings: z.strictObject({ points: z.array(vector('m', 2)).min(2) }) },
  { kind: 'feature', type: 'union', owner, dims: D2, refs: ['inputs'], description: 'Union of earlier features: one domain named after this feature',
    settings: z.strictObject({ inputs: z.array(nodeId).min(2) }) },
  { kind: 'feature', type: 'intersection', owner, dims: D2, refs: ['inputs'], description: 'Intersection of earlier features: one domain named after this feature',
    settings: z.strictObject({ inputs: z.array(nodeId).min(2) }) },
  { kind: 'feature', type: 'difference', owner, dims: D2, refs: ['base', 'tools'], description: 'base minus tools, named after this feature; keepTools keeps the tools as separate domains',
    settings: z.strictObject({ base: nodeId, tools: ids, keepTools: z.boolean().optional() }) },
  { kind: 'feature', type: 'fragment', owner, dims: D2, refs: ['inputs'], description: 'Split overlapping inputs into explicit pieces named by their origin domains joined with &',
    settings: z.strictObject({ inputs: ids }) },
  { kind: 'feature', type: 'box', owner, dims: ['3d'], description: 'Axis-aligned box; boundaries xmin/xmax/ymin/ymax/zmin/zmax',
    settings: z.strictObject({ size: vector('m', 3), center: vector('m', 3) }) },
  { kind: 'feature', type: 'cylinder', owner, dims: ['3d'], description: 'Circular cylinder from base centre along axis; boundaries side/bottom/top',
    settings: z.strictObject({ radius: quantity('m'), height: quantity('m'), base: vector('m', 3), axis: z.enum(['x', 'y', 'z']) }) },
];

/** Supersede the provisional feature registrations (and add the ones the seed lacks). */
export function registerGeomFeatures(reg: Registry): Registry {
  for (const r of GEOM_FEATURES) reg.register(r, { replace: true });
  return reg;
}

export type Resolver = { q(v: unknown): number; vec(v: unknown, n: number): number[] };

/** SI resolver over a resolved param scope (resolveParams(spec.params).scope); N/A is an error for geometry. */
export function makeResolver(scope: ReadonlyMap<string, ScopeValue>): Resolver {
  const q = (v: unknown): number => {
    const r = resolveQuantity(v, scope);
    if (r.na) throw new Error('geom: N/A is not a valid geometry value');
    return r.si;
  };
  const vec = (v: unknown, n: number): number[] => {
    let out: number[];
    if (Array.isArray(v)) out = v.map(q);
    else if (v && typeof v === 'object' && 'value' in v && 'unit' in v && Array.isArray((v as { value: unknown }).value)) {
      const { value, unit } = v as { value: number[]; unit: string };
      out = value.map((x) => q({ value: x, unit }));
    } else throw new Error('geom: expected a vector');
    if (out.length !== n) throw new Error(`geom: expected a ${n}-vector`);
    return out;
  };
  return { q, vec };
}

export interface FeatureNodeLike { id: string; type: string; settings?: Record<string, unknown> }
export type Solid3D =
  | { type: 'box'; id: string; x: [number, number]; y: [number, number]; z: [number, number] }
  | { type: 'cylinder'; id: string; radius: number; height: number; base: [number, number, number]; axis: 'x' | 'y' | 'z' };

/** One spec feature node -> @amp/geom 2D feature (lengths SI). */
export function featureFromSpec(n: FeatureNodeLike, R: Resolver): Feature {
  const s = n.settings ?? {};
  const v2 = (x: unknown) => R.vec(x, 2) as Vec2;
  switch (n.type) {
    case 'rect': {
      const [w, h] = R.vec(s.size, 2), [cx, cy] = R.vec(s.center, 2);
      return { id: n.id, type: 'rect', x: [cx! - w! / 2, cx! + w! / 2], y: [cy! - h! / 2, cy! + h! / 2] };
    }
    case 'circle': return { id: n.id, type: 'circle', c: v2(s.center), r: R.q(s.radius) };
    case 'ellipse': {
      const [rx, ry] = R.vec(s.semiAxes, 2);
      return { id: n.id, type: 'ellipse', c: v2(s.center), rx: rx!, ry: ry!, rot: s.rotation === undefined ? 0 : R.q(s.rotation) };
    }
    case 'polygon': return { id: n.id, type: 'polygon', points: (s.points as unknown[]).map(v2) };
    case 'arc': return { id: n.id, type: 'arc', c: v2(s.center), r: R.q(s.radius), a0: R.q(s.start), a1: R.q(s.end) };
    case 'polyline': return { id: n.id, type: 'polyline', points: (s.points as unknown[]).map(v2) };
    case 'union': case 'intersection': case 'fragment': return { id: n.id, type: n.type, inputs: s.inputs as string[] };
    case 'difference': {
      const f: Feature = { id: n.id, type: 'difference', target: s.base as string, tools: s.tools as string[] };
      if (s.keepTools) f.keepTools = true;
      return f;
    }
    default: throw new Error(`geom: feature type '${n.type}' is not a 2D feature`);
  }
}

/** Spec geometry block -> built 2D geometry, or the 3D primitive list (3D CSG is tier 2, DevLog-001 A6). */
export function geometryFromSpec(geo: { dim: number; axisym?: boolean; features: FeatureNodeLike[] }, R: Resolver):
  { dim: 2; geometry: Geometry2D } | { dim: 3; solids: Solid3D[] } {
  if (geo.dim === 2) return { dim: 2, geometry: buildGeometry2D({ axisym: !!geo.axisym, features: geo.features.map((f) => featureFromSpec(f, R)) }) };
  if (geo.dim !== 3) throw new Error(`geom: dim ${geo.dim} not supported`);
  const solids = geo.features.map((n): Solid3D => {
    const s = n.settings ?? {};
    if (n.type === 'box') {
      const sz = R.vec(s.size, 3), c = R.vec(s.center, 3);
      const r = (k: number): [number, number] => [c[k]! - sz[k]! / 2, c[k]! + sz[k]! / 2];
      return { type: 'box', id: n.id, x: r(0), y: r(1), z: r(2) };
    }
    if (n.type === 'cylinder')
      return { type: 'cylinder', id: n.id, radius: R.q(s.radius), height: R.q(s.height), base: R.vec(s.base, 3) as [number, number, number], axis: s.axis as 'x' | 'y' | 'z' };
    throw new Error(`geom: 3D feature '${n.type}' is not supported in tier 1 (box, cylinder)`);
  });
  return { dim: 3, solids };
}
