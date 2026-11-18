// SPDX-License-Identifier: GPL-3.0-or-later
// em3d AMS-preconditioned iterative path (lane E8, DevLog-054): eigenfrequencies of solver 'ams' equal the direct
// path's to the inner tolerance's level on a PEC box (ND1 and ND2, partly filled with a dielectric), the 'auto' rule
// keeps small problems on the direct factor, an interior study shift is refused with a message, and the direct path is
// unchanged by the new options. Expected values: the direct solve of the same mesh (no external numbers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMesh, nCells } from '../src/common/mesh.ts';
import { solveCavity, C0 } from '../src/em3d/index.ts';

const pec = ['bnd:box.xmin', 'bnd:box.xmax', 'bnd:box.ymin', 'bnd:box.ymax', 'bnd:box.zmin', 'bnd:box.zmax'];

function problem(n: number) {
  const mesh = boxMesh({ x: [0, 1], y: [0, 0.8], z: [0, 0.6], nx: n, ny: n, nz: n, cell: 'tet4' });
  const nc = nCells(mesh);
  // dielectric in the lower half (z < 0.3): inhomogeneous, no degenerate pairs from the cube symmetry
  const epsR = new Float64Array(nc);
  for (let c = 0; c < nc; c++) {
    let z = 0;
    for (let a = 0; a < 4; a++) z += mesh.nodes[3 * mesh.cells.conn[4 * c + a]! + 2]! / 4;
    epsR[c] = z < 0.3 ? 2.5 : 1;
  }
  return { mesh, epsR, muR: new Float64Array(nc).fill(1) };
}

for (const order of [1, 2] as const) {
  test(`em3d ND${order}: AMS path eigenfrequencies equal the direct path's (rtol 1e-10)`, async () => {
    const P = problem(order === 1 ? 6 : 3);
    const base = { mesh: P.mesh, order, epsR: P.epsR, muR: P.muR, pec, nModes: 6 };
    const d = await solveCavity(base);
    const a = await solveCavity({ ...base, solver: 'ams', solverRtol: 1e-10 });
    assert.equal(a.steps!.values.length, d.steps!.values.length);
    let worst = 0;
    d.steps!.values.forEach((f, i) => { worst = Math.max(worst, Math.abs(a.steps!.values[i]! - f) / f); });
    assert.ok(worst < 1e-8, `max relative frequency difference ${worst}`);
    assert.match(String(a.stats.solver), /AMS-preconditioned CG/);
    assert.ok(Number(a.detail.stats.amsIterMax) > 0 && Number(a.detail.stats.amsRelresMax) <= 1e-10);
    assert.equal(a.detail.nBelowShift, null);
    assert.ok(Math.max(...a.detail.divResidual) < 1e-7, `div ${a.detail.divResidual}`);
    // 'auto' keeps this small problem on the direct factor: bitwise the default result
    const au = await solveCavity({ ...base, solver: 'auto' });
    assert.deepEqual(Array.from(au.steps!.values), Array.from(d.steps!.values));
  });
}

test('em3d AMS: a study shift above the lowest mode is refused; a shift below it is accepted', async () => {
  const P = problem(3);
  const base = { mesh: P.mesh, order: 2 as const, epsR: P.epsR, muR: P.muR, pec, nModes: 4 };
  const d = await solveCavity(base);
  const f0 = d.steps!.values[0]!;
  await assert.rejects(solveCavity({ ...base, solver: 'ams', shiftHz: 1.05 * f0 }), /above the lowest computed eigenfrequency/);
  const a = await solveCavity({ ...base, solver: 'ams', shiftHz: 0.5 * f0 });
  assert.ok(Math.abs(a.steps!.values[0]! - f0) / f0 < 1e-8);
  void C0;
  await assert.rejects(solveCavity({ ...base, solver: 'gmres' as never }), /solver 'gmres'/);
});
