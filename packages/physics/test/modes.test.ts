// SPDX-License-Identifier: GPL-3.0-or-later
// em-modes: ported EO vector-mode gates (closed forms, reduced sizes; EO engine/tests/vector-mode.test.mjs G1, G2,
// G4, G7, G9) on @amp/core, plus the C4 module contract (spec -> RunContext -> C5 Solution).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Mesh, RunContext, Spec } from '@amp/spec/types';
import { buildVectorModel, solveVectorModes, vectorPerturbation } from '../src/modes/vector-mode.mjs';
import { emModes, kernelMesh, solveModes } from '../src/modes/index.ts';
import { slabMesh } from '../src/modes/fixtures.ts';
import { rectTriMesh } from '../src/common/mesh.ts';

/** PEC rectangular guide a x b filled with index n: theta = beta^2 list (TE_mn: m, n not both 0; TM_mn: m, n >= 1). */
function pecBoxSpectrum(a: number, b: number, n: number, k0: number, maxIdx = 8) {
  const out: Array<{ th: number; kind: string }> = [];
  for (let m = 0; m <= maxIdx; m++)
    for (let q = 0; q <= maxIdx; q++) {
      if (m === 0 && q === 0) continue;
      const th = k0 * k0 * n * n - (m * Math.PI / a) ** 2 - (q * Math.PI / b) ** 2;
      out.push({ th, kind: 'TE' });
      if (m > 0 && q > 0) out.push({ th, kind: 'TM' });
    }
  return out.sort((x, y) => y.th - x.th);
}

/** Kernel model of a PEC-walled rectangle a x b (metres = um units here: lambda passed in the same unit). */
function pecGuide(a: number, b: number, N: number, order: 1 | 2): { model: any; mesh: Mesh } {
  const mesh = rectTriMesh({ x: [0, a * 1e-6], y: [0, b * 1e-6], nx: Math.round(N * a / b), ny: N });
  const km = kernelMesh(mesh, ['bnd:rect.bottom', 'bnd:rect.right', 'bnd:rect.top', 'bnd:rect.left']);
  return { model: buildVectorModel(km.mesh, { order, pecNodes: km.pecNodes, pecEdge: km.pecEdge }), mesh };
}
const uniformEps = (nT: number, e: number) => { const v = new Float64Array(4 * nT); for (let t = 0; t < nT; t++) v.set([e, 0, e, e], 4 * t); return v; };

for (const [order, Ns, lo, hi] of [[1, [8, 16, 32], 1.7, 2.4], [2, [4, 8, 16], 3.5, 4.6]] as const)
  test(`G1 order ${order}: PEC rectangular guide, first 6 beta^2 vs closed forms, observed order ${order === 1 ? 2 : 4}`, () => {
    const a = 2, b = 1, n = 1.5, k0 = 2 * Math.PI;
    const exact = pecBoxSpectrum(a, b, n, k0);
    const errs: number[][] = [];
    for (const N of Ns) {
      const { model } = pecGuide(a, b, N, order);
      const r = solveVectorModes(model, 1, { eps: uniformEps(model.mesh.nTris, n * n), numModes: 6, blockSize: 2, fields: false });
      assert.ok(r.converged);
      for (const m of r.modes) assert.ok(m.residual < 1e-6, `residual ${m.residual}`);
      errs.push(r.modes.map((m: any, i: number) => (m.theta - exact[i]!.th) / exact[i]!.th));
    }
    for (let i = 0; i < 6; i++) {
      const p = Math.log2(Math.abs(errs[1]![i]!) / Math.abs(errs[2]![i]!));
      assert.ok(p > lo && p < hi, `mode ${i} observed order ${p}`);
    }
  });

test('G4 order 2: no spurious modes, 10 PEC-guide eigenvalues match the analytic list one-to-one; Sylvester count agrees', () => {
  const a = 2, b = 1, n = 1.5, k0 = 2 * Math.PI;
  const exact = pecBoxSpectrum(a, b, n, k0);
  const thCheck = 0.5 * (exact[9]!.th + exact[10]!.th);
  const { model } = pecGuide(a, b, 5, 2);
  const r = solveVectorModes(model, 1, { eps: uniformEps(model.mesh.nTris, n * n), numModes: 10, blockSize: 2, fields: false, inertiaCheckN: Math.sqrt(thCheck) / k0 });
  r.modes.forEach((m: any, i: number) => assert.ok(Math.abs(m.theta - exact[i]!.th) / Math.abs(exact[i]!.th) < 5e-3, `mode ${i}`));
  assert.equal(r.inertia.eigenvaluesAboveShift, 0);
  assert.equal(r.inertia.check.eigenvaluesAbove, 10);
});

test('G2 symmetric slab (WO-01 inputs): TE0 with PEC side walls, TM0 with PMC side walls, rel error < 1e-6 at level 4', async () => {
  const cs = JSON.parse(readFileSync(new URL('../../../eval/expected/WO-01.json', import.meta.url), 'utf8'));
  const ref = Object.fromEntries(cs.targets.map((t: any) => [t.metric_id, t.value]));
  // indices of eval/cases/a/WO-01.yaml (materials.Si.n, materials.SiO2.n; eo-modulator-atlas K1 values)
  const nSi = 3.477723756, nOx = 1.444023622, t = 2.2e-7, lambda = 1.55e-6;
  const mesh = slabMesh({ t, L: t / 2 + 2.5e-6, W: 1e-7, nCoreHalf: 8, nClad: 48, nx: 4, c: 2.2 });
  for (const [pol, walls] of [['TE0', ['bnd:rect.left', 'bnd:rect.right']], ['TM0', []]] as const) {
    const { result } = await solveModes({ mesh, eps: [nOx * nOx, nSi * nSi], pec: ['bnd:rect.bottom', 'bnd:rect.top', ...walls], wavelength: lambda, nModes: 1, fields: false });
    const m = result.modes[0];
    assert.ok(Math.abs(m.neff / ref[`neff_${pol}`] - 1) < 1e-6, `${pol}: ${m.neff} vs ${ref[`neff_${pol}`]}`);
    assert.ok(pol === 'TE0' ? m.teFraction > 0.999 : m.teFraction < 1e-3, `${pol} TE fraction ${m.teFraction}`);
  }
});

test('G7 lossy PEC guide (eps = 2.25 - 0.05 j): complex beta^2 = k0^2 eps - kc^2 for the first 3 modes', () => {
  const a = 2, b = 1, k0 = 2 * Math.PI, er = 2.25, el = 0.05;
  const { model } = pecGuide(a, b, 10, 2);
  const nT = model.mesh.nTris;
  const r = solveVectorModes(model, 1, { eps: uniformEps(nT, er), epsIm: uniformEps(nT, el), numModes: 3, nTarget: 1.6, blockSize: 2 });
  const exact = pecBoxSpectrum(a, b, Math.sqrt(er), k0);
  assert.equal(r.modes.length, 3);
  r.modes.forEach((m: any, i: number) => {
    assert.ok(Math.abs(m.theta - exact[i]!.th) / exact[i]!.th < 1e-6, `Re theta ${m.theta} vs ${exact[i]!.th}`);
    assert.ok(Math.abs(m.thetaIm + k0 * k0 * el) < 1e-6 * k0 * k0, `Im theta ${m.thetaIm}`);
    assert.ok(m.lossDbPerCm > 0);
  });
});

test('G9 perturbation: TE10 of a lossless guide, d n_eff = k0 d eps_yy / (2 beta) (Hellmann-Feynman)', () => {
  const a = 2, b = 1, k0 = 2 * Math.PI, er = 2.25;
  const { model } = pecGuide(a, b, 8, 2);
  const nT = model.mesh.nTris;
  const m = solveVectorModes(model, 1, { eps: uniformEps(nT, er), numModes: 1 }).modes[0];
  const dEps = new Float64Array(4 * nT);
  for (let t = 0; t < nT; t++) dEps[4 * t + 2] = 1e-4; // TE10 has E_y only
  const dn = vectorPerturbation(model, m, dEps, 1);
  const beta = Math.sqrt(k0 * k0 * er - (Math.PI / a) ** 2);
  assert.ok(Math.abs(dn / ((k0 * 1e-4) / (2 * beta)) - 1) < 1e-6, `${dn}`);
});

test('C4 module: spec + RunContext -> C5 Solution (steps, scalars, DG0 fields, timing, run record)', async () => {
  const t = 2.2e-7, nSi = 3.477723756, nOx = 1.444023622;
  const mesh = slabMesh({ t, L: t / 2 + 2.5e-6, W: 1e-7, nCoreHalf: 2, nClad: 12, nx: 1, c: 2.2 });
  const spec = {
    schema: 'amp-spec/0', id: 'slab-test', title: 'slab',
    params: { lambda0: { value: 1.55, unit: 'um' } },
    geometry: { dim: 2, features: [] },
    materials: [
      { id: 'si', override: { n: { value: nSi, unit: '1' } }, select: ['dom:core'] },
      { id: 'ox', override: { n: { value: nOx, unit: '1' } }, select: ['dom:clad'] },
    ],
    physics: [{ id: 'ewg', type: 'em-modes', select: ['dom:core', 'dom:clad'], bcs: [{ id: 'w', type: 'pec', select: ['bnd:rect.bottom', 'bnd:rect.top', 'bnd:rect.left', 'bnd:rect.right'] }] }],
    studies: [{ id: 'm', type: 'mode', physics: ['ewg'], settings: { wavelength: 'lambda0', nModes: 2 } }],
  } as unknown as Spec;
  assert.deepEqual(emModes.readiness(spec, 'ewg'), { ready: true, reasons: [] });
  const ctx: RunContext = { spec, physicsId: 'ewg', mesh, materials: { si: { n: nSi }, ox: { n: nOx } }, study: spec.studies![0]!, progress: () => {}, signal: new AbortController().signal };
  const sol = await emModes.run(ctx);
  assert.equal(sol.steps?.kind, 'eigen');
  assert.equal(sol.steps?.values.length, 2);
  assert.ok(Math.abs(sol.scalars.neff_0!.value - 2.8494894672) < 1e-3);
  assert.ok(sol.steps!.values[0]! >= sol.steps!.values[1]!);
  const nc = mesh.cells.conn.length / 3;
  const ex = sol.fields.find((f) => f.name === 'Ex' && f.step === 0)!;
  assert.equal(ex.space, 'DG0'); assert.equal(ex.data.length, nc);
  for (const k of ['model', 'assemble', 'factor', 'solve', 'post']) assert.ok(sol.timing[k]! >= 0, k);
  assert.match(sol.run.engine, /^@amp\/physics@/);
  assert.match(sol.run.specHash, /^[0-9a-f]{64}$/);
  assert.equal(sol.meshHash, mesh.hash);
  const bad = { ...spec, materials: [{ id: 'si', override: { n: 'N/A' }, select: ['dom:core'] }] } as unknown as Spec;
  assert.equal(emModes.readiness(bad, 'ewg').ready, false);
});
