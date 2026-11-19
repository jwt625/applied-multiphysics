// SPDX-License-Identifier: GPL-3.0-or-later
// Integration fix "pool worker state" (DevLog-054): the PML box test of wave2d (pml.ts cellBox / buildPml) on the mesh of
// sims/pec-post-scattering.yaml. In Chrome 151 the closure form of cellBox intermittently returned the box of all physics
// cells as the non-PML box in the second and later runs of a sweep worker (V8 optimized on-stack-replacement code; the
// inputs were correct and a retry in the same worker passed). Node 23 (V8 12.9) does not show that miscompile, so this
// test pins the fixed form instead: cellBox takes typed-array masks (the pre-fix callback form throws "flag is not a
// function" on the first call), the boxes are the
// window and the outer square, and repeated builds with fresh arrays (hot, optimized loop) keep giving the same boxes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '@amp/spec';
import { prepareRun } from '../src/index.ts';
import { buildPml, cellBox } from '../src/wave2d/pml.ts';
import { selectEntities } from '../src/common/mesh.ts';

const spec = parseYaml(readFileSync(new URL('../../../sims/pec-post-scattering.yaml', import.meta.url), 'utf8')).data as Record<string, unknown>;

test('fx-pool: wave2d PML boxes from typed-array masks, stable over repeated builds', async () => {
  const prep = await prepareRun({ spec, physicsId: 'w', studyId: 's', hFactor: 1 });
  const mesh = prep.mesh;
  const nc = mesh.cells.domain.length;
  const pmlDoms = new Set(selectEntities(mesh.entities, 'domains', ['dom:pml']));
  const mk = () => {
    const active = new Uint8Array(nc).fill(1), pml = new Uint8Array(nc);
    for (let c = 0; c < nc; c++) if (pmlDoms.has(mesh.cells.domain[c]!)) pml[c] = 1;
    return { active, pml };
  };
  // params L = 45 mm (window half width), dpml = 15 mm: window [-45, 45] mm, outer square [-60, 60] mm
  const near = (b: { x0: number; x1: number; y0: number; y1: number }, h: number, what: string) => {
    for (const v of [-b.x0, b.x1, -b.y0, b.y1]) assert.ok(Math.abs(v - h) < 1e-12, `${what}: ${JSON.stringify(b)}, expected +-${h} m`);
  };
  const { active, pml } = mk();
  near(cellBox(mesh, active, pml)!, 0.045, 'non-PML box');
  near(cellBox(mesh, active)!, 0.06, 'box of all physics cells');
  // repeated builds with fresh arrays, interleaved with the solver's own cellBox call (scattering-width box): every
  // build gives the same boxes and never throws the "PML cell lies inside the box" error
  const R0 = new Float64Array(nc).fill(1e-6), ord = new Float64Array(nc).fill(2);
  for (let i = 0; i < 60; i++) {
    const a = mk();
    const p = buildPml(mesh, a.active, a.pml, R0, ord);
    near(p.inner, 0.045, `build ${i} inner`);
    near(p.outer, 0.06, `build ${i} outer`);
    near(cellBox(mesh, a.active)!, 0.06, `build ${i} all cells`);
  }
});
