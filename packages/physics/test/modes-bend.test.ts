// SPDX-License-Identifier: GPL-3.0-or-later
// em-modes bends (lane S2, DevLog-043 G-BEND): 2D bent slab (n_s, n_f, n_c) = (1.6, 1.7, 1.55), d = 2 um, lambda =
// 1.55 um, R at the outer core rim, vs K. R. Hiremath et al., Opt. Quantum Electron. 37, 37-61 (2005),
// doi 10.1007/s11082-005-1118-3, Table 3 (preprint p.11), and vs the independent mpmath root of the Bessel-Hankel
// matching determinant (validation/modes2/bent_slab.py -> bent_slab_ref.jsonl). Metric (exact) and conformal
// (Heiblum-Harris) models; the bend option in the spec route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { RunContext, Spec } from '@amp/spec/types';
import { emModes, solveModes } from '../src/modes/index.ts';
import { tensorMesh, gradedLine } from '../src/modes/fixtures.ts';
import { modeTransform } from '../src/modes/transform.ts';

const um = 1e-6;
const REF = readFileSync(new URL('../../../validation/modes2/bent_slab_ref.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { R_um: number; pol: string; beta_over_k: number; alpha_over_k: number; table3: { beta_over_k: number; alpha_over_k: number } });

/** Radial cross-section: x = r - R (outer rim at x = 0), substrate | core | cladding | PML; y a thin invariant strip. */
function bentSlab(R: number, f = 2) {
  const N = (n: number) => Math.max(1, Math.round(n * f));
  const ls = Math.min(4, R - 2.5);
  const xs = gradedLine([{ a: (-2 - ls) * um, b: -2 * um, n: N(16), r: 4, toward: 'b' }, { a: -2 * um, b: 0, n: N(16), r: 2, toward: 'both' }, { a: 0, b: 3 * um, n: N(24), r: 3, toward: 'a' }, { a: 3 * um, b: 5 * um, n: N(16) }]);
  return tensorMesh(xs, [0, 0.05 * um], ['dom:sub', 'dom:core', 'dom:clad', 'dom:pml'], (x) => (x < -2 * um ? 0 : x < 0 ? 1 : x < 3 * um ? 2 : 3));
}
const EPS = [1.6 ** 2, 1.7 ** 2, 1.55 ** 2, 1.55 ** 2];
const PEC = { TE: ['bnd:rect.top', 'bnd:rect.bottom', 'bnd:rect.left', 'bnd:rect.right'], TM: ['bnd:rect.left', 'bnd:rect.right'] } as const;

async function bendMode(R: number, pol: 'TE' | 'TM', model: 'metric' | 'conformal', f = 2) {
  const mesh = bentSlab(R, f);
  const tr = modeTransform(mesh, { pml: [{ domains: [3], strength: 2, power: 2 }], bend: { radius: R * um, x0: 0, model } });
  const ref = REF.find((r) => r.R_um === R && r.pol === pol)!;
  const out = await solveModes({ mesh, eps: EPS, wavelength: 1.55 * um, nModes: 3, order: 2, neffShift: ref.beta_over_k + 0.01, pec: [...PEC[pol]], transform: { sx: tr.sx, sy: tr.sy, h: tr.h, model }, fields: false });
  const m = out.result.modes.slice().sort((a: any, b: any) => Math.hypot(a.neff - ref.beta_over_k, a.kappa - ref.alpha_over_k) - Math.hypot(b.neff - ref.beta_over_k, b.kappa - ref.alpha_over_k))[0];
  return { m, ref };
}

test('G-BEND reference: mpmath roots reproduce Hiremath 2005 Table 3 (beta/k within 6e-5 of the 4-decimal values, alpha/k 1e-4)', () => {
  assert.equal(REF.length, 6);
  for (const r of REF) {
    assert.ok(Math.abs(r.beta_over_k - r.table3.beta_over_k) < 6e-5, `${r.R_um} ${r.pol} beta/k ${r.beta_over_k}`);
    assert.ok(Math.abs(r.alpha_over_k / r.table3.alpha_over_k - 1) < 1e-4, `${r.R_um} ${r.pol} alpha/k ${r.alpha_over_k}`);
  }
});

for (const [R, pol] of [[10, 'TE'], [20, 'TE'], [20, 'TM'], [50, 'TE']] as const)
  test(`G-BEND metric: bent slab R = ${R} um ${pol}0 beta/k and alpha/k vs the analytic root`, async () => {
    const { m, ref } = await bendMode(R, pol, 'metric');
    assert.ok(Math.abs(m.neff - ref.beta_over_k) < 1e-4, `beta/k ${m.neff} vs ${ref.beta_over_k}`);
    const tolA = R === 50 ? 1e-2 : 3e-3;   // R = 50: alpha/k ~ 1e-6, window-limited at this size (DevLog-043 s.4)
    assert.ok(Math.abs(m.kappa / ref.alpha_over_k - 1) < tolA, `alpha/k ${m.kappa} vs ${ref.alpha_over_k}`);
  });

test('G-BEND conformal (Heiblum-Harris scalar) deviates from the exact root more than the metric model', async () => {
  const c = await bendMode(20, 'TE', 'conformal'), g = await bendMode(20, 'TE', 'metric');
  const errC = Math.abs(c.m.neff - c.ref.beta_over_k), errG = Math.abs(g.m.neff - g.ref.beta_over_k);
  assert.ok(errC > 10 * errG, `conformal ${errC} vs metric ${errG}`);
  assert.ok(Math.abs(c.m.kappa / c.ref.alpha_over_k - 1) < 0.05, 'conformal alpha within 5 % at R = 20 um');
});

test('spec route: settings.bend + pml give bendLossDbPer90; a huge radius recovers the straight slab', async () => {
  const mk = (bend: unknown, shift = 1.63): Spec => ({
    schema: 'amp-spec/0', id: 'bend', title: 'bend', params: { lambda0: { value: 1.55, unit: 'um' } }, geometry: { dim: 2, features: [] },
    materials: [
      { id: 'sub', override: { n: { value: 1.6, unit: '1' } }, select: ['dom:sub'] },
      { id: 'core', override: { n: { value: 1.7, unit: '1' } }, select: ['dom:core'] },
      { id: 'clad', override: { n: { value: 1.55, unit: '1' } }, select: ['dom:clad', 'dom:pml'] },
    ],
    physics: [{ id: 'ewg', type: 'em-modes', select: ['dom:sub', 'dom:core', 'dom:clad', 'dom:pml'], settings: { order: 2, pml: [{ select: ['dom:pml'] }], bend }, bcs: [{ id: 'w', type: 'pec', select: [...PEC.TE] }] }],
    studies: [{ id: 'm', type: 'mode', physics: ['ewg'], settings: { wavelength: 'lambda0', nModes: 1, neffShift: shift } }],
  } as unknown as Spec);
  const mesh = bentSlab(20);
  const ctx = (spec: Spec): RunContext => ({ spec, physicsId: 'ewg', mesh, materials: { sub: { n: 1.6 }, core: { n: 1.7 }, clad: { n: 1.55 } }, study: spec.studies![0]!, progress: () => {}, signal: new AbortController().signal });
  const s = await emModes.run(ctx(mk({ radius: { value: 20, unit: 'um' } }))) as any;
  const ref = REF.find((r) => r.R_um === 20 && r.pol === 'TE')!;
  assert.ok(Math.abs(s.scalars.neff_0.value - ref.beta_over_k) < 1e-4);
  const k0 = 2 * Math.PI / 1.55e-6;
  const want = (20 / Math.LN10) * k0 * s.scalars.kappaEff_0.value * (Math.PI / 2) * 20e-6;
  assert.ok(Math.abs(s.scalars.bendLossDbPer90_0.value / want - 1) < 1e-9, 'dB per 90 degrees = 20 log10(e) k0 kappa pi R / 2');
  assert.ok(s.notes.some((n: string) => n.startsWith('em-modes bend: metric model')));
  // straight limit: R = 1 m, TE0 of the straight asymmetric slab (Table 3 R = infinity: 1.6775)
  const st = await emModes.run(ctx(mk({ radius: { value: 1, unit: 'm' } }, 1.69))) as any;
  assert.ok(Math.abs(st.scalars.neff_0.value - 1.6775) < 1e-4, `straight limit ${st.scalars.neff_0.value}`);
  // the window may not reach the bend centre
  await assert.rejects(emModes.run(ctx(mk({ radius: { value: 5, unit: 'um' } }))), /bend centre/);
});

// ---- audit fixes (2026-11-18): default shift with a bend, PML fraction, transformed confinement
function bendSpec(R: number, nModes: number, shift?: number): Spec {
  return {
    schema: 'amp-spec/0', id: 'bend', title: 'bend', params: { lambda0: { value: 1.55, unit: 'um' } }, geometry: { dim: 2, features: [] },
    materials: [
      { id: 'sub', override: { n: { value: 1.6, unit: '1' } }, select: ['dom:sub'] },
      { id: 'core', override: { n: { value: 1.7, unit: '1' } }, select: ['dom:core'] },
      { id: 'clad', override: { n: { value: 1.55, unit: '1' } }, select: ['dom:clad', 'dom:pml'] },
    ],
    physics: [{ id: 'ewg', type: 'em-modes', select: ['dom:sub', 'dom:core', 'dom:clad', 'dom:pml'], settings: { order: 2, pml: [{ select: ['dom:pml'] }], bend: { radius: { value: R, unit: 'um' } } }, bcs: [{ id: 'w', type: 'pec', select: [...PEC.TE] }] }],
    studies: [{ id: 'm', type: 'mode', physics: ['ewg'], settings: { wavelength: 'lambda0', nModes, ...(shift !== undefined ? { neffShift: shift } : {}) } }],
  } as unknown as Spec;
}
const runBend = async (R: number, nModes: number, shift?: number) => {
  const spec = bendSpec(R, nModes, shift);
  const ctx: RunContext = { spec, physicsId: 'ewg', mesh: bentSlab(R), materials: { sub: { n: 1.6 }, core: { n: 1.7 }, clad: { n: 1.55 } }, study: spec.studies![0]!, progress: () => {}, signal: new AbortController().signal };
  return (await emModes.run(ctx)) as any;
};
const PML_NOTE = 'PML or radiation modes';

for (const R of [10, 20, 50] as const)
  test(`bend without neffShift: R = ${R} um TE0 is mode 0 (default shift from the physical window, PML-fraction ranking)`, async () => {
    const ref = REF.find((r) => r.R_um === R && r.pol === 'TE')!;
    const s = await runBend(R, 1);
    assert.ok(Math.abs(s.scalars.neff_0.value - ref.beta_over_k) < 1e-4, `beta/k ${s.scalars.neff_0.value} vs ${ref.beta_over_k}`);
    assert.ok(Math.abs(s.scalars.kappaEff_0.value / ref.alpha_over_k - 1) < (R === 50 ? 1e-2 : 3e-3), `alpha/k ${s.scalars.kappaEff_0.value} vs ${ref.alpha_over_k}`);
    assert.ok(s.scalars.pmlFraction_0.value < 0.2, `PML fraction ${s.scalars.pmlFraction_0.value}`);
    assert.ok(!s.notes.some((n: string) => n.includes(PML_NOTE)));
  });

test('bend: a shift among the PML modes returns them with PML fraction > 0.5 and a note', async () => {
  const s = await runBend(20, 1, 1.82);
  assert.ok(s.scalars.pmlFraction_0.value > 0.5, `PML fraction ${s.scalars.pmlFraction_0.value}`);
  assert.ok(s.notes.some((n: string) => n.includes(PML_NOTE) && n.includes('move neffShift')));
});

test('bend confinement: region electric-energy fractions equal eps_r dn_eff/deps_r / sum (Hellmann-Feynman FD); power identity', async () => {
  // closed window (PEC, no PML), R = 10 um: real modes; energy per unit angle carries the weight r / |R| = h
  const xs = gradedLine([{ a: -6 * um, b: -2 * um, n: 32, r: 4, toward: 'b' }, { a: -2 * um, b: 0, n: 32, r: 2, toward: 'both' }, { a: 0, b: 3 * um, n: 48, r: 3, toward: 'a' }]);
  const mesh = tensorMesh(xs, [0, 0.05 * um], ['dom:sub', 'dom:core', 'dom:clad'], (x) => (x < -2 * um ? 0 : x < 0 ? 1 : 2));
  const tr = modeTransform(mesh, { bend: { radius: 10 * um, x0: 0, model: 'metric' } });
  const eps0 = [1.6 ** 2, 1.7 ** 2, 1.55 ** 2];
  const run = async (eps: number[]) => (await solveModes({ mesh, eps, wavelength: 1.55 * um, nModes: 1, order: 2, neffShift: 1.6, pec: [...PEC.TE], transform: { sx: tr.sx, sy: tr.sy, h: tr.h, model: 'metric' }, fields: false })).result.modes[0];
  const m0 = await run(eps0);
  const d = 1e-5, g: number[] = [];
  for (let r = 0; r < 3; r++) {
    const p = eps0.slice(), q = eps0.slice(); p[r]! *= 1 + d; q[r]! *= 1 - d;
    g.push(((await run(p)).neff - (await run(q)).neff) / (2 * d));
  }
  const S = g.reduce((a, b) => a + b, 0);
  ['dom:sub', 'dom:core', 'dom:clad'].forEach((n, r) => assert.ok(Math.abs(m0.confinement[n].electricEnergy - g[r]! / S) < 1e-7, `${n}: ${m0.confinement[n].electricEnergy} vs ${g[r]! / S}`));
  assert.ok(m0.confinement['dom:core'].electricEnergy > 0.5, 'bend mode in the core');
  assert.ok(m0.powerIdentity < 1e-10, `power identity ${m0.powerIdentity}`);
});
