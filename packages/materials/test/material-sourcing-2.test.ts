// SPDX-License-Identifier: GPL-3.0-or-later
// Materials sourced 2026-11-18 (DevLog-058): germanium (Li 1980 n table and eq. (28), HPL 1972 k), tantalum and
// tantalum nitride films, film / distributor k alternatives of tin-film and underfill-uf8830s. Expected values are
// read from the stored documents here (no number typed in): the checks are about evaluation, units and validity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibrary } from '../src/node.ts';
import { MaterialNAError, MaterialRangeError } from '../src/library.ts';

const lib = loadLibrary();
type TableLeaf = { table: { xs: number[]; ys: number[] }; alternatives?: Array<{ id: string; value?: number }> };
const leaf = (id: string, p: string) => (lib.get(id) as unknown as { properties: Record<string, TableLeaf & { value?: number | 'N/A' }> }).properties[p]!;

test('germanium n: table at 293 K; eq. (28) alternative within 1e-4 of every table row; no value below 1.9 um or off 293 K', () => {
  const t = leaf('germanium', 'n').table;
  for (let i = 0; i < t.xs.length; i++) {
    // rows are air wavelengths (n_medium air): the vacuum wavelength of row i is x_i n_air(lambda_vacuum)
    const lamAir = t.xs[i]! * 1e-6;
    let lam = lamAir;
    for (let k = 0; k < 4; k++) lam = lamAir * (lib.getProperty('air', 'n', { lambda: lam, extrapolate: true }).value as number);
    const r = lib.getProperty('germanium', 'n', { lambda: lam, T: 293 });
    const tab = r.value as number;
    assert.ok(r.airIndex !== undefined && Math.abs(tab - t.ys[i]! * r.airIndex) <= 1e-12 * t.ys[i]!, `table row ${t.xs[i]} um`);
    const fit = lib.getProperty('germanium', 'n', { lambda: lam, T: 293, alternative: 'li1980_eq28' }).value as number;
    assert.ok(Math.abs(fit - tab) <= 1e-4, `eq. (28) vs table at ${t.xs[i]} um: ${fit} vs ${tab}`);
  }
  assert.throws(() => lib.getProperty('germanium', 'n', { lambda: 1.55e-6, T: 293 }), MaterialRangeError);
  assert.throws(() => lib.getProperty('germanium', 'n', { lambda: 10e-6, T: 350 }), MaterialRangeError);
});

test('germanium k: HPL 1972 table in W/(cm K) converts to W/(m K) at the stored temperatures; rho, cp, C stay N/A', () => {
  const t = leaf('germanium', 'k').table;
  for (let i = 0; i < t.xs.length; i++) {
    const v = lib.getProperty('germanium', 'k', { T: t.xs[i]! }).value as number;
    assert.ok(Math.abs(v - 100 * t.ys[i]!) <= 1e-12 * 100 * t.ys[i]!, `k at ${t.xs[i]} K`);
  }
  for (const p of ['rho', 'cp', 'C']) assert.throws(() => lib.getProperty('germanium', p), MaterialNAError, p);
});

test('tantalum and tantalum nitride films: rho_e (ohm*cm -> ohm*m) and k resolve; sigma derived from rho_e', () => {
  for (const id of ['tantalum-film', 'tan-film']) {
    const stored = leaf(id, 'rho_e').value as number;
    const r = lib.getProperty(id, 'rho_e', id === 'tan-film' ? { T: 295 } : {});
    assert.ok(Math.abs((r.value as number) - stored * 1e-2) <= 1e-12 * stored * 1e-2, `${id} rho_e`);
    assert.equal(lib.getProperty(id, 'k').value, leaf(id, 'k').value);
    const s = lib.getProperty(id, 'sigma', id === 'tan-film' ? { T: 295 } : {});
    assert.ok(Math.abs((s.value as number) * (r.value as number) - 1) <= 1e-12, `${id} sigma`);
  }
  // the TaN film resistivity is stated at 295 K only: another temperature is outside its validity
  assert.throws(() => lib.getProperty('tan-film', 'rho_e', { T: 350 }), MaterialRangeError);
});

test('tin-film and underfill k: default N/A, the named measurement / distributor listing only as an explicit alternative', () => {
  assert.throws(() => lib.getProperty('tin-film', 'k'), MaterialNAError);
  assert.throws(() => lib.getProperty('underfill-uf8830s', 'k'), MaterialNAError);
  const tinAlt = leaf('tin-film', 'k').alternatives!.find((a) => a.id === 'moraes2015_3omega')!;
  assert.equal(lib.getProperty('tin-film', 'k', { alternative: 'moraes2015_3omega', T: 295 }).value, tinAlt.value);
  const ufAlt = leaf('underfill-uf8830s', 'k').alternatives!.find((a) => a.id === 'distributor_listing')!;
  assert.equal(lib.getProperty('underfill-uf8830s', 'k', { alternative: 'distributor_listing' }).value, ufAlt.value);
});
