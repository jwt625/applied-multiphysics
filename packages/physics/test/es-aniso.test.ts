// SPDX-License-Identifier: GPL-3.0-or-later
// Anisotropic electrostatics (DevLog-036 R3, lane MG).
//   G-ES1  uniaxial slab capacitor, rotated crystal: the slab (width w, thickness d, natural side walls) is laid out
//          with its normal along a principal axis of the in-plane tensor, so V is linear across the slab and exact in
//          P1 / P2; closed form C' = eps0 eps_n w / d with eps_n = eps_par (normal along the c axis) or eps_perp.
//          Rotation convention (modes/crystal.mjs labFromCrystal docstring): x-cut, y-propagating crystal has its c axis
//          along lab x; settings rotation t turns the lab frame CCW, so the c axis lies at angle -t from lab x:
//          c = (cos t, -sin t). A wrong sign would put the c axis at +t, 60 deg off the slab normal here.
//   G-ES2  crystals given on a coupling node (from or to this physics) are used as well; a uniaxial material without
//          a crystal orientation is an error; conflicting orientations are an error.
// eps values: LN eps^S perp 44.3, par 27.9 (materials/linbo3-congruent.yaml, Weis-Gaylord 1985 Table 1); here only
// test inputs of the closed form.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunContext, Spec } from '@amp/spec/types';
import { prepareRun } from '../src/prepare.ts';
import { electrostaticsModule, EPS0 } from '../src/index.ts';

const PERP = 44.3, PAR = 27.9;
const W = 10e-6, D = 1e-6;

function slabSpec(normalDeg: number): Record<string, unknown> {
  // normal n at normalDeg from lab x, tangent u = n rotated by +90 deg
  const a = (normalDeg * Math.PI) / 180;
  const n = [Math.cos(a), Math.sin(a)], u = [-Math.sin(a), Math.cos(a)];
  const P = [[0, 0], [W * u[0]!, W * u[1]!], [W * u[0]! + D * n[0]!, W * u[1]! + D * n[1]!], [D * n[0]!, D * n[1]!]];
  return {
    schema: 'amp-spec/0', id: 'es-aniso-slab', title: 'uniaxial slab capacitor',
    geometry: { dim: 2, features: [{ id: 'slab', type: 'polygon', settings: { points: P.map((p) => ({ value: p, unit: 'm' })) } }] },
    materials: [{ id: 'LN', override: { eps_r: { symmetry: 'uniaxial', components: { perp: PERP, par: PAR } } }, select: ['dom:slab'] }],
    // polygon edges: e0 p0 -> p1 (plane n = 0), e2 p2 -> p3 (plane n = d); e1, e3 side walls (natural, zero normal D)
    physics: [{ id: 'es', type: 'electrostatics', select: ['dom:slab'], bcs: [
      { id: 'top', type: 'terminal', select: ['bnd:slab.e2'] }, { id: 'gnd', type: 'ground', select: ['bnd:slab.e0'] }] }],
    mesh: { size: { hmax: { value: 0.4e-6, unit: 'm' } } },
    studies: [{ id: 's', type: 'stationary', physics: ['es'] }],
  };
}

async function capacitance(tDeg: number, normalDeg: number, crystals: unknown = [{ material: 'LN', cut: 'x', propagation: 'y', rotation: `${tDeg} deg` }]): Promise<number> {
  const prep = await prepareRun(slabSpec(normalDeg), { physicsId: 'es' });
  // settings.crystals of the electrostatics physics (registration request to MC, DevLog-036 s.3): set on the prepared spec
  (prep.spec.physics![0] as { settings?: unknown }).settings = { crystals };
  const sol = await electrostaticsModule.run(prep as RunContext);
  return sol.scalars.C_top_top!.value;
}

test('G-ES1 uniaxial slab capacitor, rotated crystal: C\' = eps0 eps_n w / d (closed form, exact for linear V)', async (t) => {
  const tDeg = 30;
  const cases: Array<[string, number, number, number]> = [
    // [label, rotation t (deg), slab normal angle (deg from lab x), eps along the normal]
    ['normal along c (-t)', tDeg, -tDeg, PAR],
    ['normal across c (90 - t)', tDeg, 90 - tDeg, PERP],
    ['no rotation, normal along c (lab x)', 0, 0, PAR],
    ['no rotation, normal along lab y (perp)', 0, 90, PERP],
  ];
  for (const [label, rot, nDeg, epsN] of cases) {
    const C = await capacitance(rot, nDeg);
    const ref = (EPS0 * epsN * W) / D;
    t.diagnostic(`${label}: C' ${C} F/m, closed form ${ref} F/m, rel ${(C / ref - 1).toExponential(2)}`);
    assert.ok(Math.abs(C / ref - 1) < 1e-9, `${label}: ${C} vs ${ref}`);
  }
  // the opposite rotation sign puts the c axis 60 deg off the normal: eps_n = par cos^2 60 + perp sin^2 60, not par
  const Cw = await capacitance(-tDeg, -tDeg);
  const mix = PAR * 0.25 + PERP * 0.75;
  t.diagnostic(`rotation -t with normal at -t: C' ${Cw} F/m; eps_n(par) ${(EPS0 * PAR * W) / D}, mixed-axis estimate ${(EPS0 * mix * W) / D}`);
  assert.ok(Math.abs(Cw / ((EPS0 * PAR * W) / D) - 1) > 0.05, 'sign of the rotation matters');
  // c along the propagation axis (x-cut, z-propagating): in-plane eps = perp for any slab orientation
  const Cz = await capacitance(0, 17, [{ material: 'LN', cut: 'x', propagation: 'z' }]);
  assert.ok(Math.abs(Cz / ((EPS0 * PERP * W) / D) - 1) < 1e-9, `c along z: ${Cz}`);
});

test('G-ES2 crystals from a coupling node; missing and conflicting orientations are errors', async () => {
  const prep = await prepareRun(slabSpec(0), { physicsId: 'es' });
  await assert.rejects(electrostaticsModule.run(prep as RunContext), /uniaxial eps_r .* no crystal orientation/);
  const s = prep.spec as Spec & { couplings?: unknown[] };
  s.couplings = [{ id: 'eo', type: 'electro-optic', from: 'es', to: 'ewg', settings: { armB: 'ideal', crystals: [{ material: 'LN', cut: 'x', propagation: 'y' }] } }];
  const C = (await electrostaticsModule.run(prep as RunContext)).scalars.C_top_top!.value;
  assert.ok(Math.abs(C / ((EPS0 * PAR * W) / D) - 1) < 1e-9, `coupling crystals: ${C}`);
  (s.physics![0] as { settings?: unknown }).settings = { crystals: [{ material: 'LN', cut: 'z', propagation: 'y' }] };
  await assert.rejects(electrostaticsModule.run(prep as RunContext), /crystal orientation of material 'LN' differs/);
});

test('G-ES3 3D box capacitor: C = eps0 eps_r A / d in F (natural side walls, uniform field, exact)', async (t) => {
  const a = 2e-3, b = 1e-3, d = 0.5e-3, er = 3.9;
  const spec = {
    schema: 'amp-spec/0', id: 'es-3d-box', title: '3D box capacitor',
    geometry: { dim: 3, features: [{ id: 'blk', type: 'box', settings: { size: [{ value: a, unit: 'm' }, { value: b, unit: 'm' }, { value: d, unit: 'm' }], center: [{ value: a / 2, unit: 'm' }, { value: b / 2, unit: 'm' }, { value: d / 2, unit: 'm' }] } }] },
    materials: [{ id: 'm', override: { eps_r: er }, select: ['dom:blk'] }],
    physics: [{ id: 'es', type: 'electrostatics', select: ['dom:blk'], bcs: [
      { id: 'top', type: 'terminal', select: ['bnd:blk.zmax'] }, { id: 'gnd', type: 'ground', select: ['bnd:blk.zmin'] }] }],
    mesh: { size: { hmax: { value: 0.25e-3, unit: 'm' } } },
    studies: [{ id: 's', type: 'stationary', physics: ['es'] }],
  };
  const prep = await prepareRun(spec, { physicsId: 'es' });
  assert.equal(prep.mesh.dim, 3);
  const C = (await electrostaticsModule.run(prep as RunContext)).scalars.C_top_top!;
  const ref = (EPS0 * er * a * b) / d;
  t.diagnostic(`3D: C ${C.value} ${C.unit}, closed form ${ref} F, rel ${(C.value / ref - 1).toExponential(2)}`);
  assert.equal(C.unit, 'F');
  assert.ok(Math.abs(C.value / ref - 1) < 1e-9, `${C.value} vs ${ref}`);
});
