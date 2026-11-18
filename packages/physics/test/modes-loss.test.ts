// SPDX-License-Identifier: GPL-3.0-or-later
// em-modes lossy materials (lane S2, DevLog-043 G-SPP): planar Au / air surface plasmon vs the analytic dispersion
// n_spp = sqrt(eps_m eps_d / (eps_m + eps_d)) (derivation DevLog-043 s.4; S. A. Maier, Plasmonics: Fundamentals and
// Applications, Springer 2007, ch. 2) and L_spp = 1 / (2 Im beta). Au at 0.6595 um: n 0.14, kappa 3.697 (Johnson and
// Christy, Phys. Rev. B 6, 4370 (1972), via refractiveindex.info Au/nk/Johnson.yml, also materials/gold.yaml).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunContext, Spec } from '@amp/spec/types';
import { emModes, solveModes } from '../src/modes/index.ts';
import { tensorMesh, gradedLine } from '../src/modes/fixtures.ts';

const um = 1e-6;
const LAM = 0.6595, N_AU = 0.14, K_AU = 3.697;
const cdiv = (a: number[], b: number[]) => { const d = b[0]! ** 2 + b[1]! ** 2; return [(a[0]! * b[0]! + a[1]! * b[1]!) / d, (a[1]! * b[0]! - a[0]! * b[1]!) / d]; };
const csqrt = (z: number[]) => { const m = Math.hypot(z[0]!, z[1]!); const r = Math.sqrt(0.5 * (m + z[0]!)); return [r, z[1]! / (2 * r)]; };
/** exp(+j omega t): eps_m = (n - j kappa)^2; n_spp = n' - j n'' */
function sppAnalytic(n: number, k: number, ed: number) {
  const em = [n * n - k * k, -2 * n * k];
  const q = csqrt(cdiv([em[0]! * ed, em[1]! * ed], [em[0]! + ed, em[1]!]));
  const k0 = (2 * Math.PI) / LAM;
  return { nRe: q[0]!, kappa: -q[1]!, Lum: 1 / (2 * k0 * -q[1]!) };
}
/** 1D layered window: Au y in [-Lm, 0], air y in [0, La] (um), graded toward the interface; x-invariant strip. */
function sppMesh(La: number, Lm: number, nA: number, nM: number) {
  const ys = gradedLine([{ a: -Lm * um, b: 0, n: nM, r: 60, toward: 'b' }, { a: 0, b: La * um, n: nA, r: 60, toward: 'a' }]);
  return tensorMesh([0, 0.01 * um], ys, ['dom:au', 'dom:air'], (_x, y) => (y < 0 ? 0 : 1));
}

test('G-SPP: planar Au / air SPP n_eff and propagation length vs analytic; window truncation measured', async () => {
  const ref = sppAnalytic(N_AU, K_AU, 1);
  const eps = [N_AU ** 2 - K_AU ** 2, 1], epsIm = [2 * N_AU * K_AU, 0];
  const run = async (La: number, Lm: number, n: number) => {
    const out = await solveModes({ mesh: sppMesh(La, Lm, n, n), eps, epsIm, wavelength: LAM * um, nModes: 1, order: 2, pec: ['bnd:rect.top', 'bnd:rect.bottom'], fields: false });
    return { m: out.result.modes[0], s: out.solution.scalars };
  };
  const big = await run(5, 0.5, 60);       // 13 air decay lengths, 18 metal decay lengths
  const fine = await run(5, 0.5, 120);     // same window, h / 2
  const small = await run(2.5, 0.25, 60);  // half window (truncation)
  assert.ok(Math.abs(big.m.neff - ref.nRe) < 1e-8, `Re n_eff ${big.m.neff} vs ${ref.nRe}`);
  assert.ok(Math.abs(big.m.kappa / ref.kappa - 1) < 1e-5, `kappa ${big.m.kappa} vs ${ref.kappa}`);
  assert.ok(Math.abs(fine.m.neff - ref.nRe) < 1e-9 && Math.abs(fine.m.kappa / ref.kappa - 1) < 1e-6);
  const L = big.s.Lprop_0!.value;
  assert.ok(Math.abs(L / (ref.Lum * um) - 1) < 1e-5, `L_spp ${L} vs ${ref.Lum * 1e-6}`);
  assert.equal(big.s.lossDbPerM_0!.unit, 'dB/m');
  // the half window is measurably worse (truncation + mesh), still within 1e-6 / 1e-4
  assert.ok(Math.abs(small.m.neff - ref.nRe) < 1e-6 && Math.abs(small.m.kappa / ref.kappa - 1) < 1e-4);
  assert.ok(big.m.teFraction < 1e-6, 'SPP is TM (E_y)');
});

function sppSpec(loss: boolean | undefined): Spec {
  return {
    schema: 'amp-spec/0', id: 'spp', title: 'spp', params: { lambda0: { value: LAM, unit: 'um' } }, geometry: { dim: 2, features: [] },
    materials: [
      { id: 'Au', override: { n: { value: N_AU, unit: '1' }, kappa: { value: K_AU, unit: '1' } }, select: ['dom:au'] },
      { id: 'Air', override: { n: { value: 1, unit: '1' } }, select: ['dom:air'] },
    ],
    physics: [{ id: 'ewg', type: 'em-modes', select: ['dom:au', 'dom:air'], settings: { order: 2, ...(loss !== undefined ? { loss } : {}) }, bcs: [{ id: 'w', type: 'pec', select: ['bnd:rect.top', 'bnd:rect.bottom'] }] }],
    studies: [{ id: 'm', type: 'mode', physics: ['ewg'], settings: { wavelength: 'lambda0', nModes: 1 } }],
  } as unknown as Spec;
}

test('spec route: settings.loss binds material n + kappa (complex solve); loss off stays lossless with a note', async () => {
  const mesh = sppMesh(5, 0.5, 60, 60);
  const ctxOf = (spec: Spec): RunContext => ({ spec, physicsId: 'ewg', mesh, materials: { Au: { n: N_AU, kappa: K_AU }, Air: { n: 1 } }, study: spec.studies![0]!, progress: () => {}, signal: new AbortController().signal });
  const on = await emModes.run(ctxOf(sppSpec(true))) as any;
  const ref = sppAnalytic(N_AU, K_AU, 1);
  assert.ok(Math.abs(on.scalars.neff_0.value - ref.nRe) < 1e-8);
  assert.ok(Math.abs(on.scalars.kappaEff_0.value / ref.kappa - 1) < 1e-5);
  assert.ok(on.notes.some((n: string) => n.includes('em-modes loss: complex permittivity')));
  // without settings.loss the metal is not lossy: eps = n^2 > 0 (old behaviour), and a note says kappa was ignored
  const off = await emModes.run(ctxOf(sppSpec(undefined))) as any;
  assert.equal(off.scalars.lossDbPerM_0, undefined);
  assert.ok(off.notes.some((n: string) => n.includes('kappa but settings.loss is off')));
});
