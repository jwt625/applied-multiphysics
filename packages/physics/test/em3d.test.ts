// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tetMatricesP } from '@amp/core/fem/hcurl';
import { boxMesh } from '../src/common/mesh.ts';
import { curvedTetMatrices, tetGrads, solveCavity, C0 } from '../src/em3d/index.ts';

test('curved-element path equals the exact affine tables on a straight tet', () => {
  const V = [[0.1, 0.0, 0.05], [1.2, 0.1, 0.0], [0.2, 0.9, 0.1], [0.3, 0.2, 1.1]];
  const E = [[0, 1], [1, 2], [0, 2], [0, 3], [1, 3], [2, 3]];
  const X = new Float64Array(30);
  V.forEach((v, a) => X.set(v, 3 * a));
  E.forEach(([i, j], e) => { for (let d = 0; d < 3; d++) X[3 * (4 + e) + d] = 0.5 * (V[i!]![d]! + V[j!]![d]!); });
  for (const order of [1, 2] as const) {
    const n = order === 1 ? 6 : 20;
    const S = new Float64Array(n * n), M = new Float64Array(n * n), S2 = new Float64Array(n * n), M2 = new Float64Array(n * n), Si = new Float64Array(n * n), Mi = new Float64Array(n * n);
    curvedTetMatrices(order, X, 1 / 1.7, 2.3, S, M);
    const g = new Float64Array(12), vol = tetGrads(X.subarray(0, 12), g);
    tetMatricesP(order, g, vol, { re: [1 / 1.7, 1 / 1.7, 1 / 1.7], im: [0, 0, 0] }, { re: [2.3, 2.3, 2.3], im: [0, 0, 0] }, S2, Si, M2, Mi, {});
    let dS = 0, dM = 0, nS = 0, nM = 0;
    for (let i = 0; i < n * n; i++) { dS = Math.max(dS, Math.abs(S[i]! - S2[i]!)); dM = Math.max(dM, Math.abs(M[i]! - M2[i]!)); nS = Math.max(nS, Math.abs(S2[i]!)); nM = Math.max(nM, Math.abs(M2[i]!)); }
    assert.ok(dS < 1e-12 * nS && dM < 1e-12 * nM, `order ${order}: dS ${dS / nS} dM ${dM / nM}`);
  }
});

test('PEC unit-cube cavity, ND2: lowest k^2 = 2 pi^2 (x3), 3 pi^2 (x2)', async () => {
  const mesh = boxMesh({ x: [0, 1], y: [0, 1], z: [0, 1], nx: 3, ny: 3, nz: 3, cell: 'tet4' });
  const nc = mesh.cells.conn.length / 4;
  const sol = await solveCavity({ mesh, order: 2, epsR: new Float64Array(nc).fill(1), muR: new Float64Array(nc).fill(1), pec: ['bnd:box.xmin', 'bnd:box.xmax', 'bnd:box.ymin', 'bnd:box.ymax', 'bnd:box.zmin', 'bnd:box.zmax'], nModes: 5 });
  const k2 = Array.from(sol.steps!.values, (f) => (2 * Math.PI * f / C0) ** 2 / Math.PI ** 2);
  assert.equal(k2.length, 5);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(k2[i]! - 2) < 2e-2, `${k2}`);
  for (let i = 3; i < 5; i++) assert.ok(Math.abs(k2[i]! - 3) < 3e-2, `${k2}`);
  assert.ok(Math.max(...sol.detail.divResidual) < 1e-8, `div ${sol.detail.divResidual}`);
});

test('emwModule.run on a spec + RunContext (cylinder, case RF-21 materials)', async () => {
  const { emwModule } = await import('../src/em3d/index.ts');
  const { cylinderTetMesh } = await import('../src/common/fixtures3d.ts');
  const { readFileSync } = await import('node:fs');
  const { parseYaml } = await import('@amp/spec');
  const kase = parseYaml(readFileSync(new URL('../../../eval/cases/a/RF-21.yaml', import.meta.url), 'utf8')).data as { materials: { fill: Record<string, number> }; geometry: { spec: { radius_m: number; height_m: number } } };
  const a = kase.geometry.spec.radius_m;
  const spec = {
    schema: 'amp-spec/0', id: 'cav', title: 'cav', geometry: { dim: 3, features: [] },
    materials: [{ id: 'fill', select: ['dom:cav'] }],
    physics: [{ id: 'rf', type: 'emw', select: ['dom:cav'], bcs: [{ id: 'w', type: 'pec', select: ['bnd:cav.side', 'bnd:cav.top', 'bnd:cav.bottom'] }] }],
    studies: [{ id: 'eig', type: 'eigen', physics: ['rf'], settings: { nModes: 4, shift: '2.5 GHz' } }],
  } as never;
  assert.deepEqual(emwModule.readiness(spec, 'rf'), { ready: true, reasons: [] });
  const mesh = cylinderTetMesh({ radius: a, height: kase.geometry.spec.height_m, h: a / 2, nz: 4, cell: 'tet10', disk: 'rings' });
  const { eps_r, tan_delta, mu_r } = kase.materials.fill as { eps_r: number; tan_delta: number; mu_r: number };
  const sol = await emwModule.run({ spec, physicsId: 'rf', mesh, materials: { fill: { eps_r, tan_delta, mu_r } }, study: (spec as { studies: never[] }).studies[0]!, progress: () => {}, signal: new AbortController().signal });
  assert.equal(sol.steps!.kind, 'eigen');
  assert.equal(sol.steps!.values.length, 4);
  assert.ok(Math.abs(sol.steps!.values[0]! / 2.903636072e9 - 1) < 2e-3);
  assert.ok(Math.abs(sol.scalars.Q_0!.value - 1 / tan_delta) < 1e-6 / tan_delta);
  assert.match(sol.run.engine, /^@amp\/physics@/);
  assert.ok(sol.timing.assemble! > 0 && sol.timing.factor! > 0);
});

test('interior shift without projection: same modes, inertia counts the modes below the shift', async () => {
  const mesh = boxMesh({ x: [0, 1], y: [0, 1], z: [0, 1], nx: 3, ny: 3, nz: 3, cell: 'tet4' });
  const nc = mesh.cells.conn.length / 4;
  const pec = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'].map((s) => `bnd:box.${s}`);
  const shiftHz = (C0 * Math.sqrt(2.5)) / 2;   // k^2 = 2.5 pi^2
  const run = (project: boolean) => solveCavity({ mesh, order: 2, epsR: new Float64Array(nc).fill(1), muR: new Float64Array(nc).fill(1), pec, nModes: 5, shiftHz, project });
  const [a, b] = [await run(true), await run(false)];
  for (let i = 0; i < 5; i++) assert.ok(Math.abs(a.steps!.values[i]! / b.steps!.values[i]! - 1) < 1e-9);
  assert.equal(a.detail.nBelowShift, 3);
  assert.equal(b.detail.nBelowShift, 3);
  assert.ok(Math.max(...b.detail.divResidual) < 1e-6);
});
