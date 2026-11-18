// SPDX-License-Identifier: GPL-3.0-or-later
// Lane E2 (DevLog-048) prepareRun / em-modes items: library dkappa/dlambda binding (B5), the lossy epsG-without-epsGIm
// guard (B6) and per-wavelength material tables (B7). Material values come from materials/*.yaml through the library;
// none is typed in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLibrary } from '@amp/materials/node';
import { prepareRun, runStudy } from '../src/index.ts';
import { solveModes } from '../src/modes/index.ts';

const lib = defaultLibrary();
const AIR0 = { Air: { value: 0, unit: '1/m' } };   // air taken as vacuum: no dispersion
const um = (v: number) => ({ value: v, unit: 'um' });

/** Au / air planar surface plasmon (DevLog-043 s.6 geometry) at lambda0 (um); settings of the em-modes node. */
function sppSpec(lam: number, settings: Record<string, unknown>, au: Record<string, unknown> = { ref: 'materials/gold' }): Record<string, unknown> {
  return {
    schema: 'amp-spec/0', id: 'spp-e2', title: 'Au / air surface plasmon',
    params: { lambda0: um(lam) },
    geometry: { dim: 2, features: [
      { id: 'au', type: 'rect', settings: { size: ['0.05 um', '0.5 um'], center: ['0 um', '-0.25 um'] } },
      { id: 'air', type: 'rect', settings: { size: ['0.05 um', '5 um'], center: ['0 um', '2.5 um'] } },
    ] },
    materials: [{ id: 'Au', ...au, select: ['dom:au'] }, { id: 'Air', override: { n: 1 }, select: ['dom:air'] }],
    physics: [{ id: 'ewg', type: 'em-modes', select: ['dom:au', 'dom:air'], settings: { order: 2, ...settings },
      bcs: [{ id: 'far', type: 'pec', select: ['bnd:au.bottom', 'bnd:air.top'] }] }],
    mesh: { size: { hmax: '0.1 um', grading: 0.3 }, refine: [{ select: ['bnd:au.top'], h: '0.004 um' }] },
    studies: [{ id: 'modes', type: 'mode', physics: ['ewg'], settings: { wavelength: 'lambda0', nModes: 1 } }],
  };
}

test('B5: loss + dispersion bind library dkappa/dlambda (central difference of library kappa) with a provenance note', async () => {
  const lam = 0.78e-6, h = 1e-4 * lam;
  const k = (l: number) => lib.getProperty('gold', 'kappa', { lambda: l }).value as number;
  const want = (k(lam + h) - k(lam - h)) / (2 * h);
  const p = await prepareRun(sppSpec(0.78, { loss: true, dispersion: { dndlambda: AIR0 } }), {});
  const got = p.materials.Au!.dkappa_dlambda!;
  assert.ok(Math.abs(got - want) <= 1e-9 * Math.abs(want), `dkappa/dlambda ${got} vs ${want}`);   // lambda from the spec units: last-bit differences in h
  assert.ok(p.notes.some((x) => x.startsWith('materials.Au.dkappa_dlambda:') && x.includes('piecewise-linear')), 'provenance note (gold kappa is a table)');
  // the solve uses it: no "kappa treated as wavelength-independent" note
  const sol = (await runStudy(p)) as any;
  assert.ok(!(sol.notes ?? []).some((x: string) => x.includes('kappa treated as wavelength-independent')));
  // same n_g as the explicit settings override with the same value
  const o = await prepareRun(sppSpec(0.78, { loss: true, dispersion: { dndlambda: AIR0, dkappadlambda: { Au: { value: got, unit: '1/m' } } } }), {});
  assert.equal(o.materials.Au!.dkappa_dlambda, undefined, 'settings override: library slope not bound');
  const so = (await runStudy(o)) as any;
  assert.equal(sol.scalars.ng_0.value, so.scalars.ng_0.value);
  // dispersion without loss, or loss without dispersion: not bound
  assert.equal((await prepareRun(sppSpec(0.78, { dispersion: { dndlambda: AIR0 } }), {})).materials.Au!.dkappa_dlambda, undefined);
  assert.equal((await prepareRun(sppSpec(0.78, { loss: true }), {})).materials.Au!.dkappa_dlambda, undefined);
});

test('B6: a lossy solve with epsG but no epsGIm is refused (kernel and solveModes); epsGIm = epsIm states constant kappa', async () => {
  const p = await prepareRun(sppSpec(0.6595, { loss: true }, { override: { n: 0.14, kappa: 3.697 } }), {});
  const { problemFromContext } = await import('../src/modes/index.ts');
  const base = problemFromContext(p);
  assert.ok(base.epsIm, 'lossy problem');
  await assert.rejects(solveModes({ ...base, epsG: base.eps }), /needs epsGIm/);
  const ok = await solveModes({ ...base, epsG: base.eps, epsGIm: base.epsIm });
  const ref = await solveModes(base);
  assert.equal(ok.solution.scalars.ng_0!.value, ref.solution.scalars.ng_0!.value, 'epsG = eps, epsGIm = epsIm is the non-dispersive default');
  // lossless problems keep accepting epsG alone
  const q = await prepareRun(sppSpec(0.6595, {}, { override: { n: 0.14, kappa: 3.697 } }), {});
  const b2 = problemFromContext(q);
  assert.equal(b2.epsIm, undefined);
});

test('B7: materialsAt(lambda) re-binds library n / kappa at another wavelength; overrides unchanged; cached', async () => {
  const p = await prepareRun(sppSpec(0.6595, { loss: true }), {});
  for (const lam of [0.6595e-6, 0.78e-6, 1.0e-6]) {
    const t = p.materialsAt(lam);
    assert.equal(t.Au!.n, lib.getProperty('gold', 'n', { lambda: lam }).value);
    assert.equal(t.Au!.kappa, lib.getProperty('gold', 'kappa', { lambda: lam }).value);
    assert.equal(t.Air!.n, 1);
  }
  assert.deepEqual(p.materialsAt(0.6595e-6), p.materials, 'at the study wavelength: identical to the bound table');
  const a = p.materialsAt(0.78e-6); a.Au!.n = -1;
  assert.notEqual(p.materialsAt(0.78e-6).Au!.n, -1, 'returns a copy');
  assert.throws(() => p.materialsAt(0), /positive wavelength/);
  const notes: string[] = [];
  p.materialsAt(1e-2, notes);   // 1 cm: outside the gold table
  assert.ok(notes.some((x) => x.includes('materials.Au')), 'out-of-range note');
});
