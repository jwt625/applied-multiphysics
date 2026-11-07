// SPDX-License-Identifier: GPL-3.0-or-later
// Rigid box modes f = (c/2) sqrt((l/Lx)^2 + (m/Ly)^2 + (n/Lz)^2). c and box from eval/cases/a/AC-02.yaml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '@amp/spec';
import { boxMesh } from '../src/common/mesh.ts';
import { solveAcousticModes } from '../src/acoustics/index.ts';

const kase = parseYaml(readFileSync(new URL('../../../eval/cases/a/AC-02.yaml', import.meta.url), 'utf8')).data as { geometry: { spec: { box_m: number[] } }; materials: { air: { c: number } } };
const [Lx, Ly, Lz] = kase.geometry.spec.box_m as [number, number, number];
const c = kase.materials.air.c;
const exact: number[] = [];
for (let l = 0; l < 6; l++) for (let m = 0; m < 6; m++) for (let n = 0; n < 6; n++) exact.push((c / 2) * Math.hypot(l / Lx, m / Ly, n / Lz));
exact.sort((a, b) => a - b);

for (const cell of ['tet10', 'hex8'] as const) test(`AC-02 box modes, ${cell}`, async () => {
  const s = cell === 'tet10' ? 2 : 4;
  const mesh = boxMesh({ x: [0, Lx], y: [0, Ly], z: [0, Lz], nx: 5 * s, ny: 4 * s, nz: 3 * s, cell });
  const nc = mesh.cells.conn.length / (cell === 'tet10' ? 10 : 8);
  const sol = await solveAcousticModes({ mesh, c: new Float64Array(nc).fill(c), nModes: 6 });
  const f = Array.from(sol.steps!.values);
  assert.equal(f[0], 0);
  const tol = cell === 'tet10' ? 2e-3 : 2e-2;
  for (let i = 1; i < 6; i++) assert.ok(Math.abs(f[i]! - exact[i]!) < tol * exact[i]!, `${i}: ${f[i]} vs ${exact[i]}`);
});

test('p = 0 walls (Dirichlet box): lowest mode (1,1,1)', async () => {
  const mesh = boxMesh({ x: [0, Lx], y: [0, Ly], z: [0, Lz], nx: 10, ny: 8, nz: 6, cell: 'tet10' });
  const nc = mesh.cells.conn.length / 10;
  const sol = await solveAcousticModes({ mesh, c: new Float64Array(nc).fill(c), nModes: 2, pressureZero: ['bnd:box.xmin', 'bnd:box.xmax', 'bnd:box.ymin', 'bnd:box.ymax', 'bnd:box.zmin', 'bnd:box.zmax'] });
  const f111 = (c / 2) * Math.hypot(1 / Lx, 1 / Ly, 1 / Lz);
  assert.ok(Math.abs(sol.steps!.values[0]! - f111) < 1e-3 * f111, `${sol.steps!.values[0]} vs ${f111}`);
});

test('acousticsModule.run on a spec + RunContext', async () => {
  const { acousticsModule } = await import('../src/acoustics/index.ts');
  const spec = {
    schema: 'amp-spec/0', id: 'room', title: 'room', geometry: { dim: 3, features: [] },
    materials: [{ id: 'air', select: ['dom:box'] }],
    physics: [{ id: 'ac', type: 'acoustics', select: ['dom:box'], bcs: [{ id: 'w', type: 'sound-hard', select: ['bnd:box.xmin'] }] }],
    studies: [{ id: 'eig', type: 'eigen', physics: ['ac'], settings: { nModes: 3 } }],
  } as never;
  assert.equal(acousticsModule.readiness(spec, 'ac').ready, true);
  const mesh = boxMesh({ x: [0, Lx], y: [0, Ly], z: [0, Lz], nx: 5, ny: 4, nz: 3, cell: 'tet10' });
  const sol = await acousticsModule.run({ spec, physicsId: 'ac', mesh, materials: { air: { c } }, study: (spec as { studies: never[] }).studies[0]!, progress: () => {}, signal: new AbortController().signal });
  assert.equal(sol.steps!.values[0], 0);
  assert.ok(Math.abs(sol.steps!.values[1]! / exact[1]! - 1) < 1e-3);
  await assert.rejects(acousticsModule.run({ spec, physicsId: 'ac', mesh, materials: { air: {} }, study: (spec as { studies: never[] }).studies[0]!, progress: () => {}, signal: new AbortController().signal }), /no value for 'c'/);
});
