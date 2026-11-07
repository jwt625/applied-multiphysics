// SPDX-License-Identifier: GPL-3.0-or-later
// Follow-up 3 (DevLog-010 s.8): axisymmetric per-m Maxwell eigen solver through the spec path; 3D reconstruction.
// Geometry and permittivity are arbitrary test numbers (not material data); references are closed forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emwAxisymModule, prepareRun, reconstruct3D } from '../src/index.ts';

const spec = {
  schema: 'amp-spec/0', id: 'cav-axi', title: 'axisym cavity test',
  params: { a: { value: 2, unit: 'cm' } },
  geometry: { dim: 2, axisym: true, features: [{ id: 'cav', type: 'rect', settings: { size: ['a', '2*a'], center: ['a/2', 'a'] } }] },
  materials: [{ id: 'fill', override: { eps_r: { value: 3, unit: '1' }, mu_r: { value: 1, unit: '1' } }, select: ['dom:cav'] }],
  physics: [{ id: 'rf', type: 'emw-axisym', select: ['dom:cav'], settings: { azimuthal: [0, 1] },
    bcs: [{ id: 'w', type: 'pec', select: ['bnd:cav.right', 'bnd:cav.top', 'bnd:cav.bottom'] }] }],
  mesh: { size: { hmax: '0.25*a' } },
  studies: [{ id: 'e', type: 'eigen', physics: ['rf'], settings: { nModes: 4, shift: '3 GHz' } }],
};

test('emw-axisym via prepareRun: TM010 and TE111 of a cylinder (Bessel zeros) within 2e-4 on a coarse mesh', async () => {
  const ctx = await prepareRun({ spec });
  assert.ok(emwAxisymModule.readiness(ctx.spec, 'rf').ready);
  const s = await emwAxisymModule.run(ctx);
  const c0 = 299792458, a = 0.02, d = 0.04, n = Math.sqrt(3);
  const fTM010 = (c0 / (2 * Math.PI * n)) * (2.404825557695773 / a);
  const fTE111 = (c0 / (2 * Math.PI * n)) * Math.hypot(1.841183781340659 / a, Math.PI / d);
  const f = Array.from(s.steps!.values);
  const near = (x: number) => f.reduce((b, y) => (Math.abs(y - x) < Math.abs(b - x) ? y : b), f[0]!);
  assert.ok(Math.abs(near(fTM010) - fTM010) < 2e-4 * fTM010, `${near(fTM010)} vs ${fTM010}`);
  assert.ok(Math.abs(near(fTE111) - fTE111) < 2e-4 * fTE111, `${near(fTE111)} vs ${fTE111}`);
  assert.match((s as { normalization?: string }).normalization ?? '', /M-orthonormal/);
});

test('reconstruct3D: cylindrical components rotate to Cartesian', () => {
  const [x, y, z] = reconstruct3D(1, [1, 0, 2], [0, 1, 0]);   // phi = 90 deg, m = 1: E_r cos(90) = 0, E_z cos(90) = 0
  assert.ok(Math.abs(x) < 1e-15 && Math.abs(y) < 1e-15 && Math.abs(z) < 1e-15);
  const [x2, y2, z2] = reconstruct3D(0, [1, 0, 2], [0, 1, 0]);  // m = 0: E_r along y at phi = 90 deg
  assert.ok(Math.abs(x2) < 1e-15 && Math.abs(y2 - 1) < 1e-15 && z2 === 2);
});

test('prepareRun: a non-power-of-2 hFactor really re-meshes the emw cylinder (I1 bug report)', async () => {
  const cyl = {
    schema: 'amp-spec/0', id: 'cyl', title: 'cylinder remesh test', params: { a: { value: 2, unit: 'cm' } },
    geometry: { dim: 3, features: [{ id: 'cav', type: 'cylinder', settings: { radius: 'a', height: '2*a', base: { value: [0, 0, 0], unit: 'm' }, axis: 'z' } }] },
    materials: [{ id: 'fill', override: { eps_r: { value: 2, unit: '1' }, mu_r: { value: 1, unit: '1' } }, select: ['dom:cav'] }],
    physics: [{ id: 'rf', type: 'emw', select: ['dom:cav'], bcs: [{ id: 'w', type: 'pec', select: ['bnd:cav.side', 'bnd:cav.top', 'bnd:cav.bottom'] }] }],
    mesh: { size: { hmax: 'a' } }, studies: [{ id: 'e', type: 'eigen', physics: ['rf'], settings: { nModes: 2 } }],
  };
  const c1 = await prepareRun({ spec: cyl, hFactor: 1 });
  const c2 = await prepareRun({ spec: cyl, hFactor: 0.6667 });
  const c3 = await prepareRun({ spec: cyl, hFactor: 0.5 });
  const n = (c: { mesh: { cells: { conn: Int32Array } } }) => c.mesh.cells.conn.length;
  assert.ok(n(c2) > n(c1) && n(c3) > n(c1), `${n(c1)} ${n(c2)} ${n(c3)}`);
  assert.notEqual(c1.mesh.hash, c2.mesh.hash);
});
