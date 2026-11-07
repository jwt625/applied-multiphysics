// SPDX-License-Identifier: GPL-3.0-or-later
// Mesh builders run identically in Node and in a browser (test/xplat.test.ts). Inputs are plain JSON (resolved SI
// numbers), so only @amp/geom, @amp/mesh and robust-predicates execute on both sides.
import { buildGeometry2D, type Feature } from '@amp/geom';
import { mesh2d, meshCylinder, cylinderSideProjector, meshBoxes, meshRevolved, refineUniform, type MeshOptions2D, type Box3 } from '../src/index.ts';

export interface XInput {
  twoD: Array<{ name: string; features: Feature[]; axisym: boolean; opts: MeshOptions2D }>;
  cyl: { id: string; radius: number; height: number; base: [number, number, number]; axis: 'x' | 'y' | 'z' }; cylH: number;
  boxes: Box3[]; boxH: number;
}

export function hashes(inp: XInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of inp.twoD) {
    const g = buildGeometry2D({ features: c.features, axisym: c.axisym });
    const m = mesh2d(g, c.opts);
    out[c.name] = `${m.hash}/${m.tagHash}`;
    out[`${c.name}+refine`] = refineUniform(m, { geometry: g }).hash;
  }
  const cy = meshCylinder(inp.cyl, { mesh2d: { hmax: inp.cylH }, dz: inp.cylH, order: 2 });
  out.cylinder_tet10 = cy.hash;
  out['cylinder_tet10+refine'] = refineUniform(cy, { project: cylinderSideProjector(cy, inp.cyl) }).hash;
  out.boxes_graded = meshBoxes(inp.boxes, { h: inp.boxH, grading: 1.3 }).hash;
  const torus = buildGeometry2D({ axisym: true, features: [{ id: 'core', type: 'circle', c: [0.1, 0], r: 0.02 }] });
  out.torus_revolve = meshRevolved(torus, { id: 'rev', sectors: 24, mesh2d: { hmax: 0.006 } }).hash;
  return out;
}
