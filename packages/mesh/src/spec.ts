// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/mesh/spec: mesh an amp-spec/0 model (parsed data). Params are resolved by @amp/spec, the geometry by
// @amp/geom/spec; the `mesh` block maps to: size.hmax -> hmax, size.hmin -> hmin, size.grading -> grade (growth of the
// target size per unit distance), refine[{select, h}] -> local refinement by entity id (resolveEntityIds), budget.maxNodes -> the P1
// vertex budget `maxVertices` (not the tri6 node count; audit M7). 2D: CDT (tri3 / tri6). 3D: box list -> structured hex8 (h = hmax); single cylinder -> extruded tet4.

import { resolveParams } from '@amp/spec';
import { makeResolver, geometryFromSpec, type FeatureNodeLike } from '@amp/geom/spec';
import type { Mesh } from '@amp/geom';
import { mesh2d, type MeshOptions2D } from './mesh2d.ts';
import { meshBoxes } from './boxgrid.ts';
import { meshCylinder } from './solid3d.ts';

export interface SpecMeshOptions { order?: 1 | 2; cell3d?: 'tet4' | 'prism6' }

export function meshFromSpec(spec: Record<string, unknown>, o: SpecMeshOptions = {}): Mesh {
  const P = resolveParams(spec.params ?? {});
  if (P.issues.length) throw new Error(`mesh: params: ${P.issues.map((i) => i.message).join('; ')}`);
  const R = makeResolver(P.scope);
  const geo = spec.geometry as { dim: number; axisym?: boolean; features: FeatureNodeLike[] };
  const mb = (spec.mesh ?? {}) as { size?: { hmax?: unknown; hmin?: unknown; grading?: unknown }; refine?: Array<{ select: string[]; h: unknown }>; budget?: { maxNodes?: number } };
  const G = geometryFromSpec(geo, R);
  const hmax = mb.size?.hmax !== undefined ? R.q(mb.size.hmax) : undefined;
  if (G.dim === 2) {
    const opts: MeshOptions2D = { order: o.order ?? 1 };
    if (hmax !== undefined) opts.hmax = hmax;
    if (mb.size?.hmin !== undefined) opts.hmin = R.q(mb.size.hmin);
    if (mb.size?.grading !== undefined) opts.grade = R.q(mb.size.grading);
    if (mb.refine) opts.refine = mb.refine.map((r) => ({ select: r.select, h: R.q(r.h) }));
    if (mb.budget?.maxNodes) opts.maxVertices = mb.budget.maxNodes;
    return mesh2d(G.geometry, opts);
  }
  if (!hmax) throw new Error('mesh: 3D spec needs mesh.size.hmax');
  if (G.solids.every((s) => s.type === 'box'))
    return meshBoxes(G.solids.map((s) => (s.type === 'box' ? { id: s.id, x: s.x, y: s.y, z: s.z } : (null as never))), { h: hmax });
  if (G.solids.length === 1 && G.solids[0]!.type === 'cylinder') {
    const c = G.solids[0]!;
    return meshCylinder(c, { mesh2d: { hmax }, dz: hmax, cell: o.cell3d ?? 'tet4' });
  }
  throw new Error('mesh: tier-1 3D meshing supports a box list or one cylinder (3D CSG is tier 2)');
}
