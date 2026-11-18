// SPDX-License-Identifier: GPL-3.0-or-later
// prepareRun library binding for the optical solvers (lane I1, DevLog-046): em-modes `settings.loss` reads library
// kappa at the mode wavelength, em-modes `settings.dispersion` stores library dn/dlambda with provenance notes,
// emw-2d resolves ref: materials (n, kappa) at lambda = c0 / f of a single-frequency study. Every comparison is the
// library path against the explicit override path with the same library values (inputs identical, so results agree
// to round-off); material values are read from materials/*.yaml here, none is typed in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '@amp/spec';
import { defaultLibrary } from '@amp/materials/node';
import { dispersion } from '@amp/materials';
import { prepareRun, runStudy } from '../src/index.ts';
import { emw2dModule } from '../src/wave2d/index.ts';
import { rect } from './wave2d-common.ts';

const lib = defaultLibrary();
const sim = (name: string) => parseYaml(readFileSync(new URL(`../../../sims/${name}`, import.meta.url), 'utf8')).data as Record<string, any>;
const um = (v: number) => ({ value: v, unit: 'um' });

/** Au / air planar surface plasmon at 0.6595 um (DevLog-043 s.6 example, lane S2); Au material given by `au`. */
function sppSpec(au: Record<string, unknown>, loss = true): Record<string, unknown> {
  return {
    schema: 'amp-spec/0', id: 'au-air-spp', title: 'Au / air surface plasmon (planar)',
    params: { lambda0: um(0.6595) },
    geometry: { dim: 2, features: [
      { id: 'au', type: 'rect', settings: { size: ['0.05 um', '0.5 um'], center: ['0 um', '-0.25 um'] } },
      { id: 'air', type: 'rect', settings: { size: ['0.05 um', '5 um'], center: ['0 um', '2.5 um'] } },
    ] },
    materials: [{ id: 'Au', ...au, select: ['dom:au'] }, { id: 'Air', override: { n: 1 }, select: ['dom:air'] }],
    physics: [{ id: 'ewg', type: 'em-modes', select: ['dom:au', 'dom:air'], settings: { order: 2, ...(loss ? { loss: true } : {}) },
      bcs: [{ id: 'far', type: 'pec', select: ['bnd:au.bottom', 'bnd:air.top'] }] }],
    mesh: { size: { hmax: '0.1 um', grading: 0.3 }, refine: [{ select: ['bnd:au.top'], h: '0.004 um' }] },
    studies: [{ id: 'modes', type: 'mode', physics: ['ewg'], settings: { wavelength: 'lambda0', nModes: 1 } }],
  };
}

test('em-modes loss: library kappa (gold, at the mode wavelength) equals the explicit n / kappa override (Au / air SPP)', async () => {
  const lam = 0.6595e-6;
  const n = lib.getProperty('gold', 'n', { lambda: lam }).value as number, k = lib.getProperty('gold', 'kappa', { lambda: lam }).value as number;
  const pl = await prepareRun(sppSpec({ ref: 'materials/gold' }), {});
  assert.equal(pl.materials.Au!.n, n);
  assert.equal(pl.materials.Au!.kappa, k);
  assert.ok(!pl.notes.some((x) => x.startsWith('materials.') && x.includes('.kappa')), 'kappa present: no kappa note');
  const sl = (await runStudy(pl)) as any;
  const so = (await runStudy(await prepareRun(sppSpec({ override: { n, kappa: k } }), {}))) as any;
  for (const s of ['neff_0', 'kappaEff_0', 'Lprop_0']) {
    const a = sl.scalars[s].value, b = so.scalars[s].value;
    assert.ok(Math.abs(a - b) <= 1e-12 * Math.abs(b), `${s}: library ${a} vs override ${b}`);
  }
  // analytic planar SPP (DevLog-043 G-SPP): n_spp = sqrt(eps_m / (eps_m + 1)), eps_m = (n + i kappa)^2; informative bound
  assert.ok(sl.scalars.kappaEff_0.value > 0);
  // loss off: kappa is not requested from the library (no lossless-run note about an unused kappa)
  const p0 = await prepareRun(sppSpec({ ref: 'materials/gold' }, false), {});
  assert.equal(p0.materials.Au!.kappa, undefined);
});

/** Two-port TE channel (lane S1 test geometry) scaled to lambda0 = 0.6595 um, both segments of material `m`. */
function channelSpec(m: Record<string, unknown>, wavelengths: number[] = [0.6595]): Record<string, unknown> {
  const L = 0.6595e-6, H = 0.2 * L, x1 = 0.5 * L;
  return {
    schema: 'amp-spec/0', id: 'w2d-ito', title: 'ITO channel',
    geometry: { dim: 2, features: [rect('a', 0, x1, 0, H), rect('b', x1, L, 0, H)] },
    materials: [{ id: 'ito', ...m, select: ['dom:a', 'dom:b'] }],
    physics: [{ id: 'w', type: 'emw-2d', select: ['dom:a', 'dom:b'], settings: { polarization: 'TE' },
      bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'] }, { id: 'p2', type: 'port', select: ['bnd:b.right'] }] }],
    mesh: { size: { hmax: { value: 0.025 * L, unit: 'm' } } },
    studies: [{ id: 's', type: 'frequency', physics: ['w'], settings: { wavelengths: wavelengths.map(um) } }],
  };
}

test('emw-2d: ref: material with n and kappa (ITO) read at lambda = c0 / f gives the S-parameters of the equivalent override', async () => {
  const lam = 0.6595e-6;
  const n = lib.getProperty('ito-xy15s', 'n', { lambda: lam }).value as number, k = lib.getProperty('ito-xy15s', 'kappa', { lambda: lam }).value as number;
  const pl = await prepareRun(channelSpec({ ref: 'materials/ito-xy15s' }), {});
  // lambda = c0 / f with f = c0 / lambda: equal to round-off
  assert.ok(Math.abs(pl.materials.ito!.n! / n - 1) < 1e-12 && Math.abs(pl.materials.ito!.kappa! / k - 1) < 1e-12, `n ${pl.materials.ito!.n} kappa ${pl.materials.ito!.kappa}`);
  assert.ok(pl.notes.some((x) => x.includes('lambda = c0 / f') && x.includes('single-frequency')), pl.notes.join('\n'));
  const po = await prepareRun(channelSpec({ override: { n: pl.materials.ito!.n, kappa: pl.materials.ito!.kappa } }), {});
  const sl = (await emw2dModule.run(pl)) as any, so = (await emw2dModule.run(po)) as any;
  for (const s of ['S11_re', 'S11_im', 'S21_re', 'S21_im']) {
    const a = sl.scalars[s].value, b = so.scalars[s].value;
    assert.ok(Math.abs(a - b) <= 1e-12, `${s}: library ${a} vs override ${b}`);
  }
  // physical sanity: |S21| ~ exp(-k0 kappa L) of the lossy guide (S1 complex-index test form), loose bound
  const att = Math.exp(((-2 * Math.PI) / lam) * k * lam);
  assert.ok(Math.abs(sl.scalars.S21_abs.value / att - 1) < 1e-2, `|S21| ${sl.scalars.S21_abs.value} vs exp(-k0 kappa L) ${att}`);
});

test('emw-2d: several frequencies resolve library materials once (note); override n keeps library eps_r out', async () => {
  const p = await prepareRun(channelSpec({ ref: 'materials/ito-xy15s' }, [0.6, 0.7]), {});
  assert.ok(p.notes.some((x) => x.includes('2 frequencies') && x.includes('re-evaluates them at lambda = c0 / f per frequency')), p.notes.join('\n'));
  // silica: the library has eps_r (low frequency) and n; an override n states the optical index
  const s = channelSpec({ ref: 'materials/sio2-thermal-oxide', override: { n: 1.5 } }) as any;
  const q = await prepareRun(s, {});
  assert.equal(q.materials.ito!.eps_r, undefined);
  assert.equal(q.materials.ito!.n, 1.5);
  assert.ok(q.notes.some((x) => x.includes('library eps_r') && x.includes('not used')), q.notes.join('\n'));
});

test('em-modes dispersion: library dn/dlambda with provenance notes (tfln-mzm-eo); settings overrides keep precedence', async () => {
  const lam = 1.957e-6;
  const spec = sim('tfln-mzm-eo.yaml');
  const p = await prepareRun(structuredClone(spec), { physicsId: 'ewg' });
  const lo = dispersion(lib, 'linbo3-congruent', lam, { component: 'perp' }), le = dispersion(lib, 'linbo3-congruent', lam, { component: 'par' });
  const ox = dispersion(lib, 'sio2-thermal-oxide', lam), air = dispersion(lib, 'air', lam, { alternative: 'mathar2007_ir' });
  assert.equal(p.materials.LN!['dn_dlambda.perp'], lo.dn_dlambda);
  assert.equal(p.materials.LN!['dn_dlambda.par'], le.dn_dlambda);
  assert.equal(p.materials.SiO2!.dn_dlambda, ox.dn_dlambda);
  assert.equal(p.materials.Air!.dn_dlambda, air.dn_dlambda);
  assert.equal(p.materials.Si!.dn_dlambda, undefined, 'Si (no ref, outside the optical selection) has none');
  const note = (k: string) => p.notes.find((x) => x.startsWith(`materials.${k}:`)) ?? '';
  assert.match(note('LN.dn_dlambda.perp'), /materials\/linbo3-congruent n \(perp\).*smooth.*Zelmon/);
  assert.match(note('SiO2.dn_dlambda'), /extrapolated beyond the stored validity range/);
  assert.match(note('Air.dn_dlambda'), /alternative mathar2007_ir.*piecewise-linear/);
  // settings.dispersion.dndlambda.<material> keeps precedence: no library value, no note for that material
  const s2 = structuredClone(spec);
  s2.physics.find((x: any) => x.id === 'ewg').settings.dispersion.dndlambda = { SiO2: { value: -1, unit: '1/m' } };
  const p2 = await prepareRun(s2, { physicsId: 'ewg' });
  assert.equal(p2.materials.SiO2!.dn_dlambda, undefined);
  assert.ok(!p2.notes.some((x) => x.startsWith('materials.SiO2.dn_dlambda')));
  // without the named alternative the default air fit (Ciddor) is out of range at 1.957 um: noted, no value
  const s3 = structuredClone(spec);
  s3.physics.find((x: any) => x.id === 'ewg').settings.dispersion = true;
  const p3 = await prepareRun(s3, { physicsId: 'ewg' });
  assert.equal(p3.materials.Air!.dn_dlambda, undefined);
  assert.ok(p3.notes.some((x) => x.startsWith('materials.Air (materials/air).dn_dlambda') && x.includes('outside')), p3.notes.join('\n'));
  // a library without get() (getProperty only) resolves everything else and notes the missing dispersion
  const p4 = await prepareRun(structuredClone(spec), { physicsId: 'ewg', library: { getProperty: (i: string, pr: string, o?: any) => lib.getProperty(i, pr, o) } });
  assert.equal(p4.materials.LN!['dn_dlambda.perp'], undefined);
  assert.ok(p4.notes.some((x) => x.includes('no get()')));
});

test('tfln-mzm-eo: library dispersion gives the n_g of the explicit dndlambda path; n_eff and VpiL equal the non-dispersive run', async () => {
  const lam = 1.957e-6;
  const spec = sim('tfln-mzm-eo.yaml');
  const lib1 = (await runStudy(await prepareRun(structuredClone(spec), { physicsId: 'ewg' }))) as any;
  const q = (v: number) => ({ value: v, unit: '1/m' });
  const lo = dispersion(lib, 'linbo3-congruent', lam, { component: 'perp' }), le = dispersion(lib, 'linbo3-congruent', lam, { component: 'par' });
  const ox = dispersion(lib, 'sio2-thermal-oxide', lam), air = dispersion(lib, 'air', lam, { alternative: 'mathar2007_ir' });
  const s2 = structuredClone(spec);
  s2.physics.find((x: any) => x.id === 'ewg').settings.dispersion = { dndlambda: { LN: { perp: q(lo.dn_dlambda), par: q(le.dn_dlambda) }, SiO2: q(ox.dn_dlambda), Air: q(air.dn_dlambda) } };
  const ovr = (await runStudy(await prepareRun(s2, { physicsId: 'ewg' }))) as any;
  assert.equal(lib1.scalars.ng_0.value, ovr.scalars.ng_0.value);
  const s0 = structuredClone(spec);
  s0.physics.find((x: any) => x.id === 'ewg').settings.dispersion = false;
  const nd = (await runStudy(await prepareRun(s0, { physicsId: 'ewg' }))) as any;
  assert.equal(lib1.scalars.neff_0.value, nd.scalars.neff_0.value);
  assert.equal(lib1.scalars.VpiL.value, nd.scalars.VpiL.value);
  // CP-43 paper-simulated n_g 2.276 (tol 0.05); non-dispersive 2.226
  assert.ok(Math.abs(lib1.scalars.ng_0.value - 2.276) < 0.05 && nd.scalars.ng_0.value < lib1.scalars.ng_0.value, `n_g ${lib1.scalars.ng_0.value} (non-dispersive ${nd.scalars.ng_0.value})`);
});
