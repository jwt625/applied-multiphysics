// SPDX-License-Identifier: GPL-3.0-or-later
// G-EO2 / G-EO3 (DevLog-032): TFLN MZM push-pull VpiL through the electro-optic coupling (field-resolved mirrored arm B).
// References:
//   CP-43 Pan et al. 2021 (Opt. Express 29, 17710), paper-simulated VpiL 4.06 V cm, tolerance rel 0.10 (eval/cases/b/CP-43.yaml);
//         eo-modulator-atlas engine result 4.204 V cm (atlas DevLog-026 S1 table, 2026-10-14; cross-solver, informative).
//   CP-44 Arab Juneghani et al. 2022 (Adv. Photonics Res. 4, 2200216) device 2, measured VpiL 3.3 V cm (informative:
//         the atlas reports the same overshoot with two solvers); atlas vector solver 4.022 V cm, n_eff 1.8458
//         (atlas DevLog-026 'scalar / vector' table) as the cross-solver gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAN2021, ARAB2022, runTfln } from './photonic-tfln.ts';
// Field: electrostatics module (P2 on the study's tri6 mesh) through runStudy (DevLog-036). The direct re-solve uses the
// triangle-mean d eps and the first-order overlap d eps at the quadrature points (modes/coupled.ts); with a P2 potential
// E varies inside a triangle, so the two agree to discretization accuracy (rel 1.2e-4 CP-43, 1.9e-4 CP-44 on 2026-11-07), not to
// round-off as with the former test-side P1 field (1e-6).
const DIRECT_TOL = 1e-3;

const rel = (a: number, b: number) => Math.abs(a / b - 1);

test('G-EO2 CP-43 Pan 2021 TFLN MZM: push-pull VpiL vs paper-simulated 4.06 V cm; direct vs first order; arm balance', async (t) => {
  const { sol, nCells, ms } = await runTfln(PAN2021);
  const S = sol.scalars;
  const v = S.VpiL_0!.value * 100;
  t.diagnostic(`cells ${nCells}, study ${Math.round(ms)} ms; TE0 neff ${S.neff_0!.value}, dn_A/dV ${S.dneffdV_0!.value}, direct ${S.dneffdVdirect_0!.value}, dn_B/dV ${S.dneffdVB_0!.value} 1/V; VpiL ${v} V cm (paper sim 4.06, atlas 4.204)`);
  assert.ok(S.teFraction_0!.value > 0.9, 'mode 0 is TE');
  assert.ok(rel(v, 4.06) < 0.10, `VpiL ${v} vs 4.06 V cm`);
  assert.ok(rel(v, 4.204) < 0.02, `VpiL ${v} vs atlas 4.204 V cm`);
  assert.ok(rel(S.dneffdVdirect_0!.value, S.dneffdV_0!.value) < DIRECT_TOL, `direct vs first order: rel ${rel(S.dneffdVdirect_0!.value, S.dneffdV_0!.value)}`);
  assert.ok(Math.abs(S.dneffdVB_0!.value / S.dneffdV_0!.value + 1) < 1e-3, 'push-pull balance');
});

test('G-EO3 CP-44 Arab Juneghani 2022 device 2: VpiL and n_eff vs the atlas vector solver; measured VpiL informative', async (t) => {
  const { sol, nCells, ms } = await runTfln(ARAB2022);
  const S = sol.scalars;
  const v = S.VpiL_0!.value * 100;
  t.diagnostic(`cells ${nCells}, study ${Math.round(ms)} ms; TE0 neff ${S.neff_0!.value}; dn/dV ${S.dneffdV_0!.value}, direct ${S.dneffdVdirect_0!.value} 1/V; VpiL ${v} V cm (atlas vector 4.022; measured 3.3, ${((v / 3.3 - 1) * 100).toFixed(1)} %)`);
  assert.ok(rel(v, 4.022) < 0.02, `VpiL ${v} vs atlas 4.022 V cm`);
  assert.ok(Math.abs(S.neff_0!.value - 1.8458) < 1e-3, `neff ${S.neff_0!.value} vs atlas 1.8458`);
  assert.ok(rel(S.dneffdVdirect_0!.value, S.dneffdV_0!.value) < DIRECT_TOL, `direct vs first order: rel ${rel(S.dneffdVdirect_0!.value, S.dneffdV_0!.value)}`);
});
