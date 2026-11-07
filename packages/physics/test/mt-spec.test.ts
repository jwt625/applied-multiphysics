// SPDX-License-Identifier: GPL-3.0-or-later
// Lane MT (DevLog-033): spec-level runs of the monolithic couplings through the study driver (runStudy), the eigen
// dispatch of the elastic module, and the coupling registrations. The prepared run context is built directly (mesh
// from @amp/mesh, materials from the overrides) so these tests do not depend on prepareRun's tensor handling.
// Coefficients are arbitrary test numbers, not material data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '@amp/spec';
import { meshFromSpec } from '@amp/mesh/spec';
import type { Mesh, RunContext, Spec } from '@amp/spec/types';
import { physicsRegistry, runStudy, elasticModule } from '../src/index.ts';
import { TWOWAY_COUPLINGS } from '../src/couplings/twoway.ts';
import { le11Spec } from '../gates/mt-common.ts';

function prepared(raw: Record<string, unknown>, physicsId: string, materials: RunContext['materials']): RunContext {
  const v = validateSpec(structuredClone(raw), physicsRegistry());
  const errs = v.issues.filter((i) => i.severity !== 'notice');
  assert.ok(v.ok && v.spec, `spec invalid: ${errs.map((i) => `${i.dotted}: ${i.message}`).join('; ')}`);
  const spec = v.spec as Spec;
  const mesh = meshFromSpec(raw, { order: 2 }) as Mesh;
  return { spec, physicsId, mesh, materials, study: spec.studies![0]!, progress: () => {}, signal: new AbortController().signal };
}

const q = (value: number | number[], unit: string) => ({ value, unit });

test('registrations: piezoelectric and acoustic-structure couplings, tensor properties C / e_piezo / eps_r', () => {
  const reg = physicsRegistry();
  assert.deepEqual(reg.get('coupling', 'piezoelectric')?.for, ['elastic', 'electrostatics']);
  assert.deepEqual(reg.get('coupling', 'acoustic-structure')?.for, ['elastic', 'acoustics']);
  assert.ok(reg.get('property', 'C')?.tensor?.['hexagonal-6mm']);
  assert.ok(reg.get('property', 'e_piezo')?.tensor?.['trigonal-3m']);
  assert.ok(reg.get('property', 'eps_r')?.tensor?.uniaxial && reg.get('property', 'eps_r')?.scalar !== false);
  assert.ok(reg.get('property', 'C')?.tensor?.['tetragonal-4mm']?.includes('C66'));
  assert.equal(TWOWAY_COUPLINGS.length, 2);
});

test('spec: piezoelectric 2D plane strain column (c axis along y by settings.euler), open circuit, through runStudy', async () => {
  const t = 2e-3, w = 1e-4;
  const raw = {
    schema: 'amp-spec/0', id: 'piezo-col', title: 'piezo column',
    geometry: { dim: 2, features: [{ id: 'col', type: 'rect', settings: { size: q([w, t], 'm'), center: q([w / 2, t / 2], 'm') } }] },
    materials: [{ id: 'pz', select: ['dom:col'], override: {
      rho: q(7000, 'kg/m^3'),
      C: { symmetry: 'hexagonal-6mm', unit: 'GPa', components: { C11: 130, C12: 70, C13: 60, C33: 100, C44: 30 } },
      e_piezo: { symmetry: 'hexagonal-6mm', unit: 'C/m^2', components: { e15: 8, e31: -3, e33: 10 } },
      eps_r: { symmetry: 'uniaxial', components: { perp: 6e-9 / 8.8541878128e-12, par: 5e-9 / 8.8541878128e-12 } },
    } }],
    physics: [
      { id: 'solid', type: 'elastic', select: ['dom:col'], settings: { model: 'plane-strain' }, bcs: [{ id: 'lat', type: 'roller', select: ['bnd:col.left'] }, { id: 'lat2', type: 'roller', select: ['bnd:col.right'] }] },
      { id: 'es', type: 'electrostatics', select: ['dom:col'], bcs: [{ id: 'gnd', type: 'ground', select: ['bnd:col.bottom'] }, { id: 'top', type: 'terminal', select: ['bnd:col.top'] }] },
    ],
    couplings: [{ id: 'pz1', type: 'piezoelectric', from: 'solid', to: 'es', settings: { euler: q([0, -90, 0], 'deg') } }],
    mesh: { size: { hmax: q(t / 16, 'm') } },
    studies: [{ id: 'eig', type: 'eigen', physics: ['solid', 'es'], settings: { nModes: 10 } }],
  };
  const prep = prepared(raw, 'solid', { pz: { rho: 7000 } });
  const sol = await runStudy(prep);
  const cD = 1.0e11 + 100 / 5e-9, vD = Math.sqrt(cD / 7000);
  // thickness-extensional modes: u_y share > 0.99
  const te: number[] = [];
  sol.fields.filter((f) => f.name === 'u').forEach((f) => {
    let a = 0, all = 0; for (let i = 0; i < f.data.length; i += 2) { a += f.data[i + 1]! ** 2; all += f.data[i]! ** 2 + f.data[i + 1]! ** 2; }
    if (a / all > 0.99) te.push(sol.steps!.values[f.step!]!);
  });
  for (const [i, n] of [[1, 1], [2, 2], [3, 3]] as const) {
    const ref = (n * vD) / (2 * t);
    assert.ok(Math.abs(te[i]! - ref) / ref < 1e-3, `open mode ${n}: ${te[i]} vs ${ref}`);
  }
  assert.ok(sol.fields.some((f) => f.name === 'V' && f.physics === 'es') && sol.fields.some((f) => f.name === 'u' && f.physics === 'solid'), 'fields tagged with physics ids');
  assert.ok(Object.keys(sol.scalars).some((k) => /f_1$/.test(k)), `scalars ${Object.keys(sol.scalars).slice(0, 6)}`);
});

test('spec: acoustic-structure 1D layered column through runStudy vs the transmission-line roots', async () => {
  const a = 0.5, b = 1.0, w = 0.02;
  const raw = {
    schema: 'amp-spec/0', id: 'fsi-col', title: 'fsi column',
    geometry: { dim: 2, features: [
      { id: 'sol', type: 'rect', settings: { size: q([w, a], 'm'), center: q([w / 2, a / 2], 'm') } },
      { id: 'flu', type: 'rect', settings: { size: q([w, b], 'm'), center: q([w / 2, a + b / 2], 'm') } }] },
    materials: [
      { id: 'sm', select: ['dom:sol'], override: { E: q(1, 'GPa'), nu: 0.25, rho: q(1000, 'kg/m^3') } },
      { id: 'fm', select: ['dom:flu'], override: { c: q(1500, 'm/s'), rho: q(1000, 'kg/m^3') } }],
    physics: [
      { id: 'solid', type: 'elastic', select: ['dom:sol'], settings: { model: 'plane-strain' }, bcs: [
        { id: 'base', type: 'fixed', select: ['bnd:sol.bottom'] }, { id: 'l', type: 'roller', select: ['bnd:sol.left'] }, { id: 'r', type: 'roller', select: ['bnd:sol.right'] }] },
      { id: 'air', type: 'acoustics', select: ['dom:flu'] },
    ],
    couplings: [{ id: 'fsi', type: 'acoustic-structure', from: 'solid', to: 'air' }],
    mesh: { size: { hmax: q(0.025, 'm') } },
    studies: [{ id: 'eig', type: 'eigen', physics: ['solid', 'air'], settings: { nModes: 5 } }],
  };
  const prep = prepared(raw, 'solid', { sm: { E: 1e9, nu: 0.25, rho: 1000 }, fm: { c: 1500, rho: 1000 } });
  const sol = await runStudy(prep);
  const Ms = (1e9 * 0.75) / (1.25 * 0.5), cs = Math.sqrt(Ms / 1000), Zs = 1000 * cs, Zf = 1000 * 1500;
  const g = (wv: number) => Zs * Math.sin((wv * b) / 1500) * Math.cos((wv * a) / cs) + Zf * Math.sin((wv * a) / cs) * Math.cos((wv * b) / 1500);
  const ref: number[] = [];
  for (let wv = 1; ref.length < 4; wv += 1) if (Math.sign(g(wv)) !== Math.sign(g(wv + 1))) { let lo = wv, hi = wv + 1; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (Math.sign(g(m)) === Math.sign(g(lo))) lo = m; else hi = m; } ref.push((lo + hi) / (4 * Math.PI)); }
  const got = Array.from(sol.steps!.values).filter((f) => f > 0);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(got[i]! - ref[i]!) / ref[i]! < 1e-4, `mode ${i}: ${got[i]} vs ${ref[i]}`);
  assert.ok(sol.fields.some((f) => f.name === 'p' && f.physics === 'air'));
});

test('spec: elastic eigen study dispatches to the modal solver (2D plane stress cantilever, f_0 > 0, steps in Hz)', async () => {
  const raw = {
    schema: 'amp-spec/0', id: 'cant', title: 'cantilever',
    geometry: { dim: 2, features: [{ id: 'beam', type: 'rect', settings: { size: q([1, 0.05], 'm'), center: q([0.5, 0.025], 'm') } }] },
    materials: [{ id: 'm', select: ['dom:beam'], override: { E: q(100, 'GPa'), nu: 0.25, rho: q(5000, 'kg/m^3') } }],
    physics: [{ id: 'solid', type: 'elastic', select: ['dom:beam'], settings: { model: 'plane-stress' }, bcs: [{ id: 'clamp', type: 'fixed', select: ['bnd:beam.left'] }] }],
    mesh: { size: { hmax: q(0.025, 'm') } },
    studies: [{ id: 'eig', type: 'eigen', physics: ['solid'], settings: { nModes: 2 } }],
  };
  const prep = prepared(raw, 'solid', { m: { E: 1e11, nu: 0.25, rho: 5000 } });
  const sol = (await elasticModule.run(prep)) as Awaited<ReturnType<typeof elasticModule.run>> & { normalization?: string };
  assert.equal(sol.steps?.kind, 'eigen');
  assert.ok(sol.scalars.f_0!.value > 0 && sol.scalars.f_1!.value > sol.scalars.f_0!.value);
  // Euler-Bernoulli f1 = 1.8751^2 / (2 pi) sqrt(E h^2 / (12 rho L^4)) = 0.5596 sqrt(E h^2 / (12 rho)) for L = 1
  const fEB = (1.87510407 ** 2 / (2 * Math.PI)) * Math.sqrt((1e11 * 0.05 ** 2) / (12 * 5000));
  assert.ok(Math.abs(sol.scalars.f_0!.value - fEB) / fEB < 0.01, `f_0 ${sol.scalars.f_0!.value} vs EB ${fEB}`);
  assert.match(sol.normalization ?? '', /int rho u \. u dV = 1/);
});

// ------------------------------------------------------------------------------------------------ LE11 (CP-02)

import * as z from 'zod';
import { quantity } from '@amp/spec';

/** Registry with the elastic registration extended to 2d-axisym (the change requested from MC, DevLog-033 s.5 R1). */
function axisymRegistry() {
  const reg = physicsRegistry();
  const el = reg.get('physics', 'elastic')!;
  if (!el.dims?.includes('2d-axisym')) reg.register({ ...el, dims: ['2d', '2d-axisym', '3d'],
    settings: z.strictObject({ model: z.enum(['plane-stress', 'plane-strain', '3d', 'axisym']).optional(), thickness: quantity('m', { gt: 0 }).optional() }) }, { replace: true });
  return reg;
}

test('spec: NAFEMS LE11 (CP-02) heat -> axisym elastic through runStudy (thermal-expansion of MC): sigma_zz(A) within 1 % of -105 MPa', async () => {
  const raw = le11Spec(0.05);
  const v = validateSpec(structuredClone(raw), axisymRegistry());
  const errs = v.issues.filter((i) => i.severity !== 'notice');
  assert.ok(v.ok && v.spec, `spec invalid: ${errs.map((i) => `${i.dotted}: ${i.message}`).join('; ')}`);
  const mesh = meshFromSpec(raw, { order: 2 }) as Mesh;
  const prep: RunContext = { spec: v.spec as Spec, physicsId: 'ht', mesh, materials: { steel: { E: 210e9, nu: 0.3, alpha: 2.3e-4, k: 1 } }, study: (v.spec as Spec).studies![0]!, progress: () => {}, signal: new AbortController().signal };
  const sol = await runStudy(prep);
  const nn = mesh.nodes.length / 2;
  let vA = -1; for (let i = 0; i < nn; i++) if (Math.hypot(mesh.nodes[2 * i]! - 1, mesh.nodes[2 * i + 1]!) < 1e-9) vA = i;
  const T = sol.fields.find((f) => f.name === 'T')!.data;
  let terr = 0; for (let i = 0; i < nn; i++) terr = Math.max(terr, Math.abs(T[i]! - (273.15 + mesh.nodes[2 * i]! + mesh.nodes[2 * i + 1]!)));
  assert.ok(terr < 1e-4, `heat T vs r + z: max err ${terr} K`);
  const szz = sol.fields.find((f) => f.name === 'szz' && f.physics === 'solid')!.data[vA]!;
  assert.ok(Math.abs(szz / -105e6 - 1) < 0.01, `sigma_zz(A) ${szz / 1e6} MPa vs -105 MPa`);
});

test('materialTensor: flattened <prop>.<component> keys pick the symmetry with the most matching components', async () => {
  const { materialTensor } = await import('../src/couplings/twoway.ts');
  const { STIFFNESS_COMPONENTS } = await import('../src/coupled/tensors.ts');
  const spec = { materials: [{ id: 'a', select: [] }] } as unknown as Spec;
  const t3m = materialTensor(spec, { a: { 'C.C11': 1, 'C.C12': 2, 'C.C13': 3, 'C.C14': 4, 'C.C33': 5, 'C.C44': 6 } }, 'a', 'C', STIFFNESS_COMPONENTS);
  assert.equal(t3m?.sym, 'trigonal-3m');
  const t6 = materialTensor(spec, { a: { 'C.C11': 1, 'C.C12': 2, 'C.C13': 3, 'C.C33': 5, 'C.C44': 6 } }, 'a', 'C', STIFFNESS_COMPONENTS);
  assert.equal(t6?.sym, 'hexagonal-6mm');
  const tc = materialTensor(spec, { a: { 'C.C11': 1, 'C.C12': 2, 'C.C44': 6 } }, 'a', 'C', STIFFNESS_COMPONENTS);
  assert.equal(tc?.sym, 'cubic');
  assert.equal(materialTensor(spec, { a: { E: 1 } }, 'a', 'C', STIFFNESS_COMPONENTS), null);
});

test('spec: piezoelectric end to end through prepareRun (tensor overrides flattened by prepareRun) and runStudy', async () => {
  const { prepareRun } = await import('../src/index.ts');
  const t = 2e-3, w = 1e-4, EPS0 = 8.8541878128e-12;
  const raw = {
    schema: 'amp-spec/0', id: 'piezo-col-prep', title: 'piezo column (prepareRun)',
    geometry: { dim: 2, features: [{ id: 'col', type: 'rect', settings: { size: q([w, t], 'm'), center: q([w / 2, t / 2], 'm') } }] },
    materials: [{ id: 'pz', select: ['dom:col'], override: { rho: q(7000, 'kg/m^3'),
      C: { symmetry: 'hexagonal-6mm', unit: 'GPa', components: { C11: 130, C12: 70, C13: 60, C33: 100, C44: 30 } },
      e_piezo: { symmetry: 'hexagonal-6mm', unit: 'C/m^2', components: { e15: 8, e31: -3, e33: 10 } },
      eps_r: { symmetry: 'uniaxial', components: { perp: 600, par: 500 } } } }],
    physics: [
      { id: 'solid', type: 'elastic', select: ['dom:col'], settings: { model: 'plane-strain' }, bcs: [{ id: 'l', type: 'roller', select: ['bnd:col.left'] }, { id: 'r', type: 'roller', select: ['bnd:col.right'] }] },
      { id: 'es', type: 'electrostatics', select: ['dom:col'], bcs: [{ id: 'gnd', type: 'ground', select: ['bnd:col.bottom'] }, { id: 'top', type: 'terminal', select: ['bnd:col.top'] }] }],
    couplings: [{ id: 'pz1', type: 'piezoelectric', from: 'solid', to: 'es', settings: { euler: q([0, -90, 0], 'deg') } }],
    mesh: { size: { hmax: q(t / 16, 'm') } },
    studies: [{ id: 'eig', type: 'eigen', physics: ['solid', 'es'], settings: { nModes: 4 } }],
  };
  const prep = await prepareRun(raw, {});
  const sol = await runStudy(prep);
  const vD = Math.sqrt((1e11 + 10 ** 2 / (500 * EPS0)) / 7000);
  const f1 = sol.steps!.values[1]!, ref = vD / (2 * t);
  assert.ok(Math.abs(f1 - ref) / ref < 1e-4, `f1 ${f1} vs ${ref}`);
});

test('spec: piezoelectric settings.crystals (cut x, propagation z) and settings.euler (pi/2, 0, 0) give identical frequencies (3m test tensor); both together is an error', async () => {
  const t = 2e-3, w = 4e-4;
  const base = (settings: Record<string, unknown>) => ({
    schema: 'amp-spec/0', id: 'piezo-orient', title: 'orientation forms',
    geometry: { dim: 2, features: [{ id: 'col', type: 'rect', settings: { size: q([w, t], 'm'), center: q([w / 2, t / 2], 'm') } }] },
    materials: [{ id: 'pz', select: ['dom:col'], override: { rho: q(4600, 'kg/m^3'),
      C: { symmetry: 'trigonal-3m', unit: 'GPa', components: { C11: 200, C12: 55, C13: 75, C14: 9, C33: 240, C44: 60 } },
      e_piezo: { symmetry: 'trigonal-3m', unit: 'C/m^2', components: { e15: 3.7, e22: 2.4, e31: 0.2, e33: 1.3 } },
      eps_r: { symmetry: 'uniaxial', components: { perp: 44, par: 28 } } } }],
    physics: [
      { id: 'solid', type: 'elastic', select: ['dom:col'], settings: { model: 'plane-strain' } },
      { id: 'es', type: 'electrostatics', select: ['dom:col'], bcs: [{ id: 'gnd', type: 'ground', select: ['bnd:col.bottom'] }, { id: 'top', type: 'terminal', select: ['bnd:col.top'] }] }],
    couplings: [{ id: 'pz1', type: 'piezoelectric', from: 'solid', to: 'es', settings }],
    mesh: { size: { hmax: q(t / 8, 'm') } },
    studies: [{ id: 'eig', type: 'eigen', physics: ['solid', 'es'], settings: { nModes: 6 } }],
  });
  const mats = { pz: { rho: 4600 } };
  const a = await runStudy(prepared(base({ crystals: [{ material: 'pz', cut: 'x', propagation: 'z' }] }), 'solid', mats));
  const b = await runStudy(prepared(base({ euler: ['pi/2', 0, 0] }), 'solid', mats));
  const fa = Array.from(a.steps!.values), fb = Array.from(b.steps!.values);
  for (let i = 0; i < fa.length; i++) assert.ok(Math.abs(fa[i]! - fb[i]!) <= 1e-9 * Math.max(1, Math.abs(fb[i]!)), `mode ${i}: ${fa[i]} vs ${fb[i]}`);
  const v = validateSpec(base({ euler: ['pi/2', 0, 0], crystals: [{ material: 'pz', cut: 'x', propagation: 'z' }] }), physicsRegistry());
  assert.ok(!v.ok && v.issues.some((i) => /crystals or euler/.test(i.message)), 'both forms rejected');
});
