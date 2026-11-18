// SPDX-License-Identifier: GPL-3.0-or-later
// em-modes material dispersion in n_g (lane S2, DevLog-043 G-NG, G-TFLN): eps_g = n (n - lambda dn/dlambda) in the
// energy form of n_g vs n_eff - lambda dn_eff/dlambda from two full solves with every index at lambda (1 +- 1e-3)
// (exact identity up to O(dlambda^2)); missing dn/dlambda is an error; tfln-mzm-eo (CP-43, Pan 2021 paper-simulated
// n_g 2.276, tol 0.05) with LN (Zelmon 1997), SiO2 (Malitson 1965) and air (Mathar 2007) dispersion from the library.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '@amp/spec';
import { defaultLibrary } from '@amp/materials/node';
import { dispersion } from '@amp/materials';
import { prepareRun, runStudy } from '../src/index.ts';
import type { RunContext, Spec } from '@amp/spec/types';
import { emModes } from '../src/modes/index.ts';
import { tensorMesh, gradedLine } from '../src/modes/fixtures.ts';

const lib = defaultLibrary();
const sim = (name: string) => parseYaml(readFileSync(new URL(`../../../sims/${name}`, import.meta.url), 'utf8')).data as Record<string, any>;
const q = (v: number) => ({ value: v, unit: '1/m' });

async function strip(lam: number, disp: 'on' | 'off' | 'missing') {
  const si = dispersion(lib, 'silicon', lam, { alternative: 'salzberg_villa_tatian' }), ox = dispersion(lib, 'sio2-thermal-oxide', lam);
  const spec = sim('si-strip-te0.yaml');
  spec.params.w_core = { value: 450, unit: 'nm' };
  spec.params.lambda0 = { value: lam * 1e6, unit: 'um' };
  spec.materials[0].override.n = si.n; spec.materials[1].override.n = ox.n;
  if (disp === 'on') spec.physics[0].settings.dispersion = { dndlambda: { Si: q(si.dn_dlambda), SiO2: q(ox.dn_dlambda) } };
  if (disp === 'missing') spec.physics[0].settings.dispersion = { dndlambda: { Si: q(si.dn_dlambda) } };
  const sol = (await runStudy(await prepareRun(spec, { physicsId: 'ewg' }))) as any;
  return { neff: sol.scalars.neff_0.value as number, ng: sol.scalars.ng_0.value as number, notes: (sol.notes ?? []) as string[] };
}

test('G-NG: Si strip 450 x 220 nm TE0, n_g with Si / SiO2 dispersion equals n_eff - lambda dn_eff/dlambda (FD)', async () => {
  const lam = 1.55e-6, d = 1e-3 * lam;
  const c = await strip(lam, 'on');
  const p = await strip(lam + d, 'off'), m = await strip(lam - d, 'off');
  const fd = c.neff - (lam * (p.neff - m.neff)) / (2 * d);
  assert.ok(Math.abs(c.ng / fd - 1) < 1e-6, `formula ${c.ng} vs FD ${fd}`);
  const nd = await strip(lam, 'off');
  assert.equal(nd.neff, c.neff, 'dispersion changes n_g only');
  // published comparison (informative, DevLog-043 s.4): Cheriton et al. 2022 (arXiv:2408.06461 s.2.2) n_g 4.37;
  // dispersion moves n_g from ~4.15 (non-dispersive) to ~4.29
  assert.ok(c.ng > nd.ng + 0.1 && c.ng < 4.37 + 0.1, `n_g ${c.ng} (non-dispersive ${nd.ng})`);
  assert.ok(c.notes.some((n) => n.startsWith('em-modes dispersion:')));
});

test('dispersion without dn/dlambda for a material in the selection is an error (no default)', async () => {
  await assert.rejects(strip(1.55e-6, 'missing'), /no dn\/dlambda for material\(s\) SiO2/);
});

test('G-TFLN: tfln-mzm-eo n_g with LN / SiO2 / air dispersion vs CP-43 paper-simulated 2.276; VpiL unchanged', async () => {
  const lam = 1.957e-6;
  const lo = dispersion(lib, 'linbo3-congruent', lam, { component: 'perp' }), le = dispersion(lib, 'linbo3-congruent', lam, { component: 'par' });
  const ox = dispersion(lib, 'sio2-thermal-oxide', lam, { extrapolate: true });
  const air = dispersion(lib, 'air', lam, { alternative: 'mathar2007_ir' });
  const spec = sim('tfln-mzm-eo.yaml');
  spec.physics.find((p: any) => p.id === 'ewg').settings.dispersion = false;   // the sim carries library dispersion (DevLog-046): base = non-dispersive
  const base =(await runStudy(await prepareRun(structuredClone(spec), { physicsId: 'ewg' }))) as any;
  spec.physics.find((p: any) => p.id === 'ewg').settings.dispersion = { dndlambda: { LN: { perp: q(lo.dn_dlambda), par: q(le.dn_dlambda) }, SiO2: q(ox.dn_dlambda), Air: q(air.dn_dlambda) } };
  const sol = (await runStudy(await prepareRun(spec, { physicsId: 'ewg' }))) as any;
  const ng = sol.scalars.ng_0.value, ng0 = base.scalars.ng_0.value;
  assert.ok(Math.abs(ng - 2.276) < 0.05 && Math.abs(ng - 2.276) < Math.abs(ng0 - 2.276), `n_g ${ng} (non-dispersive ${ng0}) vs 2.276`);
  assert.equal(sol.scalars.VpiL.value, base.scalars.VpiL.value);
  assert.equal(sol.scalars.neff_0.value, base.scalars.neff_0.value);
});

// ---- lossy media (audit fix 2026-11-18): eps_g = N (N - lambda dN/dlambda), N = n - j kappa
const um = 1e-6;
/** Au / air planar SPP window (um): Au y in [-Lm, 0], air y in [0, La], optional PML on top of the air. */
function sppMesh(La: number, Lm: number, nc: number, pml = 0) {
  const segs = [{ a: -Lm * um, b: 0, n: nc, r: 60, toward: 'b' as const }, { a: 0, b: La * um, n: nc, r: 60, toward: 'a' as const }];
  if (pml) segs.push({ a: La * um, b: (La + pml) * um, n: 12, r: 1, toward: 'a' as const });
  const ys = gradedLine(segs);
  return tensorMesh([0, 0.01 * um], ys, ['dom:au', 'dom:air', 'dom:pml'], (_x, y) => (y < 0 ? 0 : y < La * um ? 1 : 2));
}
function sppSpec(lam: number, o: { n: number; k: number; disp?: unknown; pml?: boolean }): Spec {
  const doms = o.pml ? ['dom:au', 'dom:air', 'dom:pml'] : ['dom:au', 'dom:air'];
  return {
    schema: 'amp-spec/0', id: 'spp', title: 'spp', params: { lambda0: { value: lam, unit: 'm' } }, geometry: { dim: 2, features: [] },
    materials: [
      { id: 'Au', override: { n: { value: o.n, unit: '1' }, kappa: { value: o.k, unit: '1' } }, select: ['dom:au'] },
      { id: 'Air', override: { n: { value: 1, unit: '1' } }, select: o.pml ? ['dom:air', 'dom:pml'] : ['dom:air'] },
    ],
    physics: [{ id: 'ewg', type: 'em-modes', select: doms, settings: { order: 2, loss: true, ...(o.disp !== undefined ? { dispersion: o.disp } : {}), ...(o.pml ? { pml: [{ select: ['dom:pml'] }] } : {}) }, bcs: [{ id: 'w', type: 'pec', select: ['bnd:rect.top', 'bnd:rect.bottom'] }] }],
    studies: [{ id: 'm', type: 'mode', physics: ['ewg'], settings: { wavelength: 'lambda0', nModes: 1, ...(o.pml ? { neffShift: 1.05 } : {}) } }],
  } as unknown as Spec;
}
async function spp(mesh: ReturnType<typeof sppMesh>, lam: number, o: { n: number; k: number; disp?: unknown; pml?: boolean }) {
  const spec = sppSpec(lam, o);
  const ctx: RunContext = { spec, physicsId: 'ewg', mesh, materials: { Au: { n: o.n, kappa: o.k }, Air: { n: 1 } }, study: spec.studies![0]!, progress: () => {}, signal: new AbortController().signal };
  const s = (await emModes.run(ctx)) as any;
  return { neff: s.scalars.neff_0.value as number, ng: s.scalars.ng_0.value as number, kappa: s.scalars.kappaEff_0.value as number, notes: (s.notes ?? []) as string[] };
}

test('lossy dispersion: zero dn/dlambda and dkappa/dlambda reproduce the non-dispersive n_g exactly (Au / air SPP; also with a PML)', async () => {
  const lam = 0.6595e-6, n = 0.14, k = 3.697;   // Johnson and Christy 1972 row 0.6595 um (materials/gold.yaml)
  const zero = { dndlambda: { Au: 0, Air: 0 }, dkappadlambda: { Au: 0 } };
  for (const pml of [false, true]) {
    const mesh = sppMesh(5, 0.5, 60, pml ? 1 : 0);
    const off = await spp(mesh, lam, { n, k, pml }), z = await spp(mesh, lam, { n, k, pml, disp: zero });
    assert.equal(z.ng, off.ng, `pml ${pml}: n_g ${z.ng} vs ${off.ng}`);
    assert.equal(z.neff, off.neff);
    // planar interface of non-dispersive media: no length scale, so n_g = n_eff (window truncation ~ e^-27)
    assert.ok(Math.abs(off.ng - off.neff) < 1e-8, `pml ${pml}: n_g ${off.ng} vs n_eff ${off.neff}`);
  }
});

test('lossy dispersion: n_g with library gold n(lambda), kappa(lambda) equals n_eff - lambda dn_eff/dlambda (FD); kappa held constant when dkappa/dlambda is not given', async () => {
  // 0.78 um lies inside the Johnson-Christy table segment 0.7560-0.8211 um (piecewise-linear n and kappa), so the
  // library slopes and the FD steps (+- 1e-3 lambda) use the same linear segment; air is modelled as n = 1 (no dispersion)
  const lam = 0.78e-6, d = 1e-3 * lam;
  const nk = (l: number) => ({ n: lib.getProperty('gold', 'n', { lambda: l }).value as number, k: lib.getProperty('gold', 'kappa', { lambda: l }).value as number });
  const h = 1e-4 * lam;
  const dn = (nk(lam + h).n - nk(lam - h).n) / (2 * h), dk = (nk(lam + h).k - nk(lam - h).k) / (2 * h);
  assert.ok(Math.abs(dn) > 0 && Math.abs(dk) > 0);
  const mesh = sppMesh(6, 0.5, 60);
  const c = await spp(mesh, lam, { ...nk(lam), disp: { dndlambda: { Au: q(dn), Air: 0 }, dkappadlambda: { Au: q(dk) } } });
  const p = await spp(mesh, lam + d, nk(lam + d)), m = await spp(mesh, lam - d, nk(lam - d));
  const fd = c.neff - (lam * (p.neff - m.neff)) / (2 * d);
  assert.ok(Math.abs(c.ng / fd - 1) < 1e-6, `formula ${c.ng} vs FD ${fd}`);
  assert.ok(Math.abs(c.ng - c.neff) > 1e-3, 'material dispersion moves n_g away from n_eff');
  // without dkappa/dlambda: kappa constant at kappa(lambda); FD with n(lambda) only
  const k0 = nk(lam).k;
  const c2 = await spp(mesh, lam, { ...nk(lam), disp: { dndlambda: { Au: q(dn), Air: 0 } } });
  const p2 = await spp(mesh, lam + d, { n: nk(lam + d).n, k: k0 }), m2 = await spp(mesh, lam - d, { n: nk(lam - d).n, k: k0 });
  const fd2 = c2.neff - (lam * (p2.neff - m2.neff)) / (2 * d);
  assert.ok(Math.abs(c2.ng / fd2 - 1) < 1e-6, `kappa constant: formula ${c2.ng} vs FD ${fd2}`);
  assert.ok(c2.notes.some((x) => x.includes('no dkappa/dlambda for Au') && x.includes('kappa treated as wavelength-independent')));
  assert.ok(c.notes.some((x) => x.includes('complex eps_g = N (N - lambda dN/dlambda)')) && !c.notes.some((x) => x.includes('no dkappa/dlambda')));
});
