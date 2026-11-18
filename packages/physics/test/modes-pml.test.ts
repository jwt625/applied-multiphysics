// SPDX-License-Identifier: GPL-3.0-or-later
// em-modes PML (lane S2, DevLog-043): automatic stretch directions; G-LEAK substrate leakage of a Si wire on a 1 um
// BOX over Si (P. Bienstman et al., Opt. Quantum Electron. 38, 731-759 (2006), doi 10.1007/s11082-006-9025-9: "most
// precise" Re n_eff 2.41237, Im 2.913e-8, read via the Flexcompute Tidy3D notebook RadiativeLossesModeSolver; full
// convergence in DevLog-043 s.4); G-PML-ID a guided mode is unchanged with PML on (spec route, settings.pml).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Mesh, RunContext, Spec } from '@amp/spec/types';
import { emModes, solveModes } from '../src/modes/index.ts';
import { tensorMesh, gradedLine } from '../src/modes/fixtures.ts';
import { modeTransform } from '../src/modes/transform.ts';

const um = 1e-6;

/** Half (x >= 0) Bienstman wire: Si 0.5 x 0.22 um on 1 um SiO2 over Si, air top; PML right (x > 2) and bottom (y < -2). */
function leakyMesh(f: number): { mesh: Mesh; eps: number[] } {
  const N = (n: number) => Math.max(1, Math.round(n * f));
  const xs = gradedLine([{ a: 0, b: 0.25 * um, n: N(6) }, { a: 0.25 * um, b: 2 * um, n: N(12), r: 8, toward: 'a' }, { a: 2 * um, b: 3 * um, n: N(8) }]);
  const ys = gradedLine([{ a: -3 * um, b: -2 * um, n: N(8) }, { a: -2 * um, b: -1 * um, n: N(8), r: 3, toward: 'b' }, { a: -1 * um, b: 0, n: N(14), r: 4, toward: 'both' }, { a: 0, b: 0.22 * um, n: N(5) }, { a: 0.22 * um, b: 1.5 * um, n: N(12), r: 8, toward: 'a' }]);
  const doms = ['dom:core', 'dom:box', 'dom:sub', 'dom:air', 'dom:pr_air', 'dom:pr_box', 'dom:pr_sub', 'dom:pc_sub', 'dom:pb_sub'];
  const mesh = tensorMesh(xs, ys, doms, (x, y) => {
    const right = x > 2 * um;
    if (y < -2 * um) return right ? 7 : 8;
    if (y < -1 * um) return right ? 6 : 2;
    if (y < 0) return right ? 5 : 1;
    if (right) return 4;
    return x < 0.25 * um && y < 0.22 * um ? 0 : 3;
  });
  return { mesh, eps: [3.5 ** 2, 1.45 ** 2, 3.5 ** 2, 1, 1, 1.45 ** 2, 3.5 ** 2, 3.5 ** 2, 3.5 ** 2] };
}

test('PML auto direction: side layers stretch along their normal only, the corner along both', () => {
  const { mesh } = leakyMesh(1);
  const t = modeTransform(mesh, { pml: [{ domains: [4, 5, 6, 7, 8], strength: 2, power: 2 }] });
  const L = new Map(t.layers.map((l) => [l.domain, l]));
  for (const d of [4, 5, 6]) { assert.deepEqual(L.get(d)!.x, [2 * um, 3 * um]); assert.equal(L.get(d)!.y, undefined); }
  assert.deepEqual(L.get(8)!.y, [-2 * um, -3 * um]); assert.equal(L.get(8)!.x, undefined);
  assert.ok(L.get(7)!.x && L.get(7)!.y);
  assert.throws(() => modeTransform(mesh, { pml: [{ domains: [3], strength: 2, power: 2 }] }), /cannot infer the stretch direction|every cell/);
});

test('G-LEAK: Si wire substrate leakage (quasi-TE) vs Bienstman 2006 benchmark, coarse mesh', async () => {
  const { mesh, eps } = leakyMesh(1);
  const tr = modeTransform(mesh, { pml: [{ domains: [4, 5, 6, 7, 8], strength: 2, power: 2 }] });
  const out = await solveModes({ mesh, eps, wavelength: 1.55 * um, nModes: 2, order: 2, neffShift: 2.42, pec: ['bnd:rect.left', 'bnd:rect.top'], transform: { sx: tr.sx, sy: tr.sy, h: tr.h }, fields: false });
  const m = out.result.modes.find((x: any) => x.teFraction > 0.9 && x.kappa < 1e-6);
  assert.ok(m, 'leaky quasi-TE mode found');
  // coarse mesh (17k DOF): Re within 2e-4, Im within 5 %; the refined runs (DevLog-043 s.4) reach 4.6e-5 and 0.0 %
  assert.ok(Math.abs(m.neff - 2.41237) < 2e-4, `Re n_eff ${m.neff}`);
  assert.ok(Math.abs(m.kappa / 2.913e-8 - 1) < 0.05, `Im n_eff ${m.kappa}`);
  assert.ok(out.solution.scalars.kappaEff_0 || out.solution.scalars.kappaEff_1);
});

/** Si strip 0.5 x 0.22 um in SiO2 (half, x >= 0), PML frame of SiO2 domains around a 2 um margin. */
function stripSpec(pml: boolean): { spec: Spec; mesh: Mesh } {
  const xs = gradedLine([{ a: 0, b: 0.25 * um, n: 6 }, { a: 0.25 * um, b: 2 * um, n: 12, r: 8, toward: 'a' }, { a: 2 * um, b: 3 * um, n: 6 }]);
  const ys = gradedLine([{ a: -3 * um, b: -2 * um, n: 6 }, { a: -2 * um, b: 0, n: 12, r: 8, toward: 'b' }, { a: 0, b: 0.22 * um, n: 5 }, { a: 0.22 * um, b: 2.22 * um, n: 12, r: 8, toward: 'a' }, { a: 2.22 * um, b: 3.22 * um, n: 6 }]);
  const doms = ['dom:core', 'dom:clad', 'dom:pr', 'dom:pb', 'dom:pt', 'dom:pbr', 'dom:ptr'];
  const mesh = tensorMesh(xs, ys, doms, (x, y) => {
    const r = x > 2 * um, b = y < -2 * um, t = y > 2.22 * um;
    if (r && b) return 5; if (r && t) return 6; if (r) return 2; if (b) return 3; if (t) return 4;
    return x < 0.25 * um && y > 0 && y < 0.22 * um ? 0 : 1;
  });
  const spec = {
    schema: 'amp-spec/0', id: 'strip-pml', title: 'strip', params: { lambda0: { value: 1.55, unit: 'um' } }, geometry: { dim: 2, features: [] },
    materials: [
      { id: 'Si', override: { n: { value: 3.477723756, unit: '1' } }, select: ['dom:core'] },
      { id: 'SiO2', override: { n: { value: 1.444023622, unit: '1' } }, select: ['dom:clad', 'dom:pr', 'dom:pb', 'dom:pt', 'dom:pbr', 'dom:ptr'] },
    ],
    physics: [{ id: 'ewg', type: 'em-modes', select: doms, settings: { order: 2, ...(pml ? { pml: [{ select: ['dom:pr', 'dom:pb', 'dom:pt', 'dom:pbr', 'dom:ptr'] }] } : {}) },
      bcs: [{ id: 'w', type: 'pec', select: ['bnd:rect.left', 'bnd:rect.right', 'bnd:rect.top', 'bnd:rect.bottom'] }] }],
    studies: [{ id: 'm', type: 'mode', physics: ['ewg'], settings: { wavelength: 'lambda0', nModes: 1, neffShift: 2.5 } }],
  } as unknown as Spec;
  return { spec, mesh };
}

test('G-PML-ID: guided Si strip TE0 n_eff unchanged with a PML frame (spec route settings.pml)', async () => {
  const ctxOf = ({ spec, mesh }: { spec: Spec; mesh: Mesh }): RunContext => ({ spec, physicsId: 'ewg', mesh, materials: { Si: { n: 3.477723756 }, SiO2: { n: 1.444023622 } }, study: spec.studies![0]!, progress: () => {}, signal: new AbortController().signal });
  const off = await emModes.run(ctxOf(stripSpec(false))) as any;
  const on = await emModes.run(ctxOf(stripSpec(true))) as any;
  const dn = Math.abs(on.scalars.neff_0.value - off.scalars.neff_0.value);
  assert.ok(dn < 1e-9, `Re n_eff with / without PML differ by ${dn}`);
  assert.ok(Math.abs(on.scalars.kappaEff_0.value) < 1e-10, `kappaEff ${on.scalars.kappaEff_0.value}`);
  assert.ok(on.notes.some((n: string) => n.startsWith('em-modes pml:')));
  assert.ok(Math.abs(off.scalars.neff_0.value - 2.447) < 2e-3, 'TE0 of the 500 x 220 nm strip');
});
