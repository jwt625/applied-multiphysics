// Ported from advanced-packaging-atlas/engine/tests/la-mg.test.mjs at fe39985 (GPL-3.0-or-later). Changes: APA
// buildGrid + solveThermal (grid/ and thermal/, not in @amp/core) are replaced by the grid snapshot
// fixtures/apa-grids.json (cuStrips, generated from APA buildGrid with the same parts) and helpers/grid-thermal.mjs
// (ported Q1 assembly, HTC face, sources); the solver calls are those of APA thermal makeSolver (StencilCholesky
// ordering 'nd'; buildMG + mgPrecond + pcg with ref 'b'). Assertions kept (< 30 iterations, first coarsening along x,
// max |dT| < 1e-8 K vs direct); added: iteration count and Tmax equal APA's recorded solveThermal values.
// Scalar GMG robustness (lane L1 wave 2, audit A1 S1): 40 Cu strips 5 um wide on a polymer layer with a 2 mm
// in-plane target size (in-plane cell aspect ~280-400). Conductivities synthetic (0.3 / 390 W/m K), not material data.
// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StencilCholesky } from '../src/la/stencil.mjs';
import { buildMG, mgPrecond } from '../src/la/mg.mjs';
import { pcg } from '../src/la/pcg.mjs';
import { conductionSystem } from './helpers/grid-thermal.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/apa-grids.json', import.meta.url), 'utf8')).cases;

test('Cu strips (in-plane aspect ~280): PCG + GMG converges in < 30 iterations and matches the direct solve', (t) => {
  const fx = FX.cuStrips;
  const { op, b, x, grid, T_inf_C } = conductionSystem(fx);
  const xd = x.slice();
  new StencilCholesky(op, { ordering: 'nd' }).solvePadded(b, xd);
  const mg = buildMG(op, grid.xs, grid.ys, { coarseMax: 6000, ordering: 'nd' });
  const r = pcg(op, (rr, z) => mgPrecond(mg, rr, z), b, x, { rtol: 1e-12, maxIter: 1000, ref: 'b' });
  let e = 0, tmax = -Infinity;
  for (let n = 0; n < op.N; n++) if (!op.fixed[n]) { e = Math.max(e, Math.abs(xd[op.pad + n] - x[op.pad + n])); tmax = Math.max(tmax, x[op.pad + n]); }
  t.diagnostic(`grid ${grid.nx} x ${grid.ny} x ${grid.nz}; MG levels ${mg.stats.levels} (${mg.stats.coarsened.join(',')}), ${r.iterations} iterations (APA ${fx.apa.iterations}), max |dT| ${e.toExponential(2)} K, Tmax ${(tmax + T_inf_C).toFixed(6)} C (APA ${fx.apa.Tmax_C.toFixed(6)})`);
  assert.ok(r.iterations < 30);
  assert.ok(mg.stats.coarsened[0] === 'x');
  assert.ok(e < 1e-8);
  assert.equal(r.iterations, fx.apa.iterations);
  assert.ok(Math.abs(tmax + T_inf_C - fx.apa.Tmax_C) < 1e-8);
});
