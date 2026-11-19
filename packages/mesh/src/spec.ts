// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/mesh/spec: mesh an amp-spec/0 model (parsed data). Params are resolved by @amp/spec, the geometry by
// @amp/geom/spec; the `mesh` block maps to: size.hmax -> hmax, size.hmin -> hmin, size.grading -> grade (growth of the
// target size per unit distance), refine[{select, h}] -> local refinement by entity id (resolveEntityIds), budget.maxNodes -> the P1
// vertex budget `maxVertices` (not the tri6 node count; audit M7). 2D: CDT (tri3 / tri6). 3D: box list -> structured hex8 (h = hmax); single cylinder -> extruded tet4;
// extrude feature or mixed boxes / z cylinders -> layer stack (stack.ts; tet4, or tet10 at order 2; the 2D size options
// and refine selections, on 2D sketch ids, act on the shared overlay mesh; z cells from each layer's nz / dz, else hmax;
// optional size.maxLayerAspect refines thin layers in plane, DevLog-065).
// 2D: `periodic` conditions of the physics (physics[*].bcs) make the mesher put the same nodes on both sides of each
// pair (DevLog-050); specs without them take the unchanged path.

import { resolveParams } from '@amp/spec';
import { makeResolver, geometryFromSpec, type FeatureNodeLike } from '@amp/geom/spec';
import type { Mesh } from '@amp/geom';
import { mesh2d, type MeshOptions2D } from './mesh2d.ts';
import { meshBoxes } from './boxgrid.ts';
import { meshCylinder } from './solid3d.ts';
import { meshStack } from './stack.ts';
import { periodicSelections } from './periodic.ts';

export interface SpecMeshOptions { order?: 1 | 2; cell3d?: 'tet4' | 'prism6' }

export function meshFromSpec(spec: Record<string, unknown>, o: SpecMeshOptions = {}): Mesh {
  const P = resolveParams(spec.params ?? {});
  if (P.issues.length) throw new Error(`mesh: params: ${P.issues.map((i) => i.message).join('; ')}`);
  const R = makeResolver(P.scope);
  const geo = spec.geometry as { dim: number; axisym?: boolean; features: FeatureNodeLike[] };
  const mb = (spec.mesh ?? {}) as { size?: { hmax?: unknown; hmin?: unknown; grading?: unknown; maxLayerAspect?: unknown }; refine?: Array<{ select: string[]; h: unknown }>; budget?: { maxNodes?: number } };
  const G = geometryFromSpec(geo, R);
  const hmax = mb.size?.hmax !== undefined ? R.q(mb.size.hmax) : undefined;
  if (G.dim === 2) {
    const opts: MeshOptions2D = { order: o.order ?? 1 };
    if (hmax !== undefined) opts.hmax = hmax;
    if (mb.size?.hmin !== undefined) opts.hmin = R.q(mb.size.hmin);
    if (mb.size?.grading !== undefined) opts.grade = R.q(mb.size.grading);
    if (mb.refine) opts.refine = mb.refine.map((r) => ({ select: r.select, h: R.q(r.h) }));
    if (mb.budget?.maxNodes) opts.maxVertices = mb.budget.maxNodes;
    // periodic conditions of the physics: both sides of each pair get the same boundary nodes (DevLog-050)
    const per = periodicSelections(spec);
    if (per.length) opts.periodic = per;
    return mesh2d(G.geometry, opts);
  }
  if (!hmax) throw new Error('mesh: 3D spec needs mesh.size.hmax');
  if (G.stack) {
    const m2: MeshOptions2D = { hmax };
    if (mb.size?.hmin !== undefined) m2.hmin = R.q(mb.size.hmin);
    if (mb.size?.grading !== undefined) m2.grade = R.q(mb.size.grading);
    if (mb.refine) m2.refine = mb.refine.map((r) => ({ select: r.select, h: R.q(r.h) }));
    if (mb.budget?.maxNodes) m2.maxVertices = mb.budget.maxNodes;
    // opt-in in-plane refinement of thin layers (DevLog-065 D6); absent = unchanged path
    if (mb.size?.maxLayerAspect !== undefined) return meshStack(G.stack, { mesh2d: m2, dz: hmax, order: o.order ?? 1, maxLayerAspect: R.q(mb.size.maxLayerAspect) });
    return meshStack(G.stack, { mesh2d: m2, dz: hmax, order: o.order ?? 1 });
  }
  if (G.solids.every((s) => s.type === 'box'))
    return meshBoxes(G.solids.map((s) => (s.type === 'box' ? { id: s.id, x: s.x, y: s.y, z: s.z } : (null as never))), { h: hmax });
  if (G.solids.length === 1 && G.solids[0]!.type === 'cylinder') {
    const c = G.solids[0]!;
    return meshCylinder(c, { mesh2d: { hmax }, dz: hmax, cell: o.cell3d ?? 'tet4' });
  }
  throw new Error('mesh: this 3D geometry is not a box list, one cylinder or a layer stack; overlapping or rotated 3D solids need true 3D CSG (tier 2): write the model as an extrude feature with 2D sketches');
}
