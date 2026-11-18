// SPDX-License-Identifier: GPL-3.0-or-later
// wave2d gates G-a1, G-a2, G-e (cylinder) and G-b2 (slab, plane wave) of DevLog-042 s.1.7. References:
// validation/wave2d/cylinder_series.py (Bessel / Hankel series, Balanis AEE 2nd ed. sec. 11.5; scipy vs mpmath and the
// optical theorem) and validation/wave2d/planar_refs.py (Airy slab, closed form vs transfer matrix).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cylinderSpec, run, ref, sc, probeC, log, rect } from './wave2d-common.ts';

interface CylRef { cases: Record<string, { sigma2d_back_m: number; sigma2d_fwd_m: number; sigma2d_total_m: number; probes: Array<{ rho: number; phi: number; re: number; im: number; abs: number }> }> }
const CYL = ref<CylRef>('cylinder_reference.json');

const rel = (a: number, b: number) => Math.abs(a / b - 1);

async function cylinderLevels(name: string, mk: (h: number) => Record<string, unknown>, base: string, levels: number[]) {
  const rc = CYL.cases[name]!;
  const out: Array<{ h: number; dof: number; ms: number; eBack: number; eFwd: number; eTot: number; eProbe: number }> = [];
  for (const h of levels) {
    const { sol, mesh, ms } = await run(mk(h));
    const umax = Math.max(...rc.probes.map((p) => p.abs));
    let eProbe = 0;
    for (const p of rc.probes) {
      const v = probeC(mesh, sol, base, p.rho * Math.cos(p.phi), p.rho * Math.sin(p.phi));
      eProbe = Math.max(eProbe, Math.hypot(v[0] - p.re, v[1] - p.im) / umax);
    }
    const r = { h, dof: sol.stats.dof, ms, eBack: rel(sc(sol, 'sigma2d_back'), rc.sigma2d_back_m), eFwd: rel(sc(sol, 'sigma2d_fwd'), rc.sigma2d_fwd_m), eTot: rel(sc(sol, 'sigma2d_total'), rc.sigma2d_total_m), eProbe };
    log(name, JSON.stringify({ ...r, ms: Math.round(ms), back: sc(sol, 'sigma2d_back'), fwd: sc(sol, 'sigma2d_fwd'), total: sc(sol, 'sigma2d_total'), timing: Object.fromEntries(Object.entries(sol.timing).map(([k, v]) => [k, Math.round(v)])) }));
    out.push(r);
  }
  return out;
}

function gate(name: string, L: Awaited<ReturnType<typeof cylinderLevels>>, tolFine: number, tolProbe: number) {
  const [c, f] = [L[0]!, L[L.length - 1]!];
  for (const k of ['eBack', 'eFwd', 'eTot'] as const) {
    assert.ok(c[k] < 1e-3, `${name} ${k} at h = ${c.h}: ${c[k]}`);
    assert.ok(f[k] < tolFine, `${name} ${k} at h = ${f.h}: ${f[k]}`);
  }
  assert.ok(c.eProbe < 1e-3 && f.eProbe < tolProbe, `${name} probes: ${c.eProbe}, ${f.eProbe}`);
  assert.ok(f.eProbe < c.eProbe / 3, `${name}: near field does not converge (${c.eProbe} -> ${f.eProbe})`);
}

const LEVELS = [0.1, 0.05];

test('G-a1 PEC cylinder TM (E_z) vs Bessel series: near field and scattering width', async () => {
  gate('pec_tm', await cylinderLevels('pec_tm', (h) => cylinderSpec({ physics: 'emw-2d', pol: 'TM', kind: 'pec', h }), 'Ez', LEVELS), 1e-4, 2e-4);
});

test('G-a1 PEC cylinder TE (H_z) vs Bessel series', async () => {
  gate('pec_te', await cylinderLevels('pec_te', (h) => cylinderSpec({ physics: 'emw-2d', pol: 'TE', kind: 'pec', h }), 'Hz', LEVELS), 1e-4, 2e-4);
});

test('G-a2 dielectric cylinder eps_r 4, TM and TE, vs series (incl. interior probes)', async () => {
  gate('diel_tm', await cylinderLevels('diel_tm', (h) => cylinderSpec({ physics: 'emw-2d', pol: 'TM', kind: 'diel', h }), 'Ez', LEVELS), 1e-4, 3e-4);
  gate('diel_te', await cylinderLevels('diel_te', (h) => cylinderSpec({ physics: 'emw-2d', pol: 'TE', kind: 'diel', h }), 'Hz', LEVELS), 1e-4, 3e-4);
});

test('G-e acoustics: rigid (sound-hard) and soft cylinder vs the Neumann / Dirichlet series', async () => {
  // same series as TE / TM PEC (k a = pi): the field equation and the wall conditions are identical for u = p
  gate('hard', await cylinderLevels('pec_te', (h) => cylinderSpec({ physics: 'acoustics', kind: 'hard', h }), 'p', LEVELS), 1e-4, 2e-4);
  const soft = await cylinderLevels('pec_tm', (h) => cylinderSpec({ physics: 'acoustics', kind: 'soft', h }), 'p', [0.1]);
  assert.ok(soft[0]!.eBack < 1e-3 && soft[0]!.eProbe < 1e-3, JSON.stringify(soft[0]));
});

interface PlanarRef { slab: Record<'TM' | 'TE', { eps2: number; t_m: number; r_re: number; r_im: number; tau_re: number; tau_im: number }> }
const PL = ref<PlanarRef>('planar_reference.json');

/** Slab eps_r 4, thickness 0.3 m, in a channel of height 0.2 m (natural walls; listed next to the slab), PML 0.5 m at both ends, plane wave along +x. */
function slabSpec(pol: 'TM' | 'TE', h: number) {
  const t = PL.slab[pol].t_m, H = 0.2, L = 0.75, d = 0.5;
  return {
    schema: 'amp-spec/0', id: 'w2d-slab', title: 'slab',
    geometry: { dim: 2, features: [rect('outer', -L - d, L + d, 0, H), rect('inner', -L, L, 0, H), rect('inner2', -L, L, 0, H), rect('slab', -t / 2, t / 2, 0, H),
      { id: 'pml', type: 'difference', settings: { base: 'outer', tools: ['inner2'] } },
      { id: 'air', type: 'difference', settings: { base: 'inner', tools: ['slab'], keepTools: true } }] },
    materials: [{ id: 'vac', override: { eps_r: 1, mu_r: 1 }, select: ['dom:pml', 'dom:air'] }, { id: 'film', override: { eps_r: PL.slab[pol].eps2, mu_r: 1 }, select: ['dom:slab'] }],
    physics: [{ id: 'w', type: 'emw-2d', select: ['dom:pml', 'dom:air', 'dom:slab'], settings: { polarization: pol },
      bcs: [{ id: 'absorb', type: 'pml', select: ['dom:pml'] }, { id: 'inc', type: 'plane-wave', select: ['dom:air'], settings: { direction: 0, amplitude: { value: 1, unit: pol === 'TM' ? 'V/m' : 'A/m' } } },
        // channel walls next to the slab must be named under a plane wave (DevLog-042 s.7.7); natural = pmc (TM) / pec (TE)
        { id: 'chan', type: pol === 'TM' ? 'pmc' : 'pec', select: ['bnd:slab.top', 'bnd:slab.bottom'] }] }],
    mesh: { size: { hmax: { value: h, unit: 'm' } } },
    studies: [{ id: 's', type: 'frequency', physics: ['w'], settings: { wavelengths: [{ value: 1, unit: 'm' }] } }],
  };
}

test('G-b2 dielectric slab under a plane wave (scattered field) vs the Airy film formula', async () => {
  const k = 2 * Math.PI;
  for (const pol of ['TM', 'TE'] as const) {
    const R = PL.slab[pol], t = R.t_m;
    const errs: number[] = [];
    for (const h of [0.05, 0.025]) {
      const { sol, mesh } = await run(slabSpec(pol, h));
      const U = pol === 'TM' ? 'Ez' : 'Hz';
      // r = u_s(x) exp(-j k (x + t)) on the incidence side; tau = u(x) exp(j k (x - t)) behind the slab
      const xr = -0.5, xt = 0.5, y = 0.1;
      const us = probeC(mesh, sol, `${U}_sc`, xr, y), ut = probeC(mesh, sol, U, xt, y);
      const er = [Math.cos(-k * (xr + t)), Math.sin(-k * (xr + t))], et = [Math.cos(k * (xt - t)), Math.sin(k * (xt - t))];
      const r = [us[0] * er[0]! - us[1] * er[1]!, us[0] * er[1]! + us[1] * er[0]!], tau = [ut[0] * et[0]! - ut[1] * et[1]!, ut[0] * et[1]! + ut[1] * et[0]!];
      const e = Math.max(Math.hypot(r[0]! - R.r_re, r[1]! - R.r_im), Math.hypot(tau[0]! - R.tau_re, tau[1]! - R.tau_im));
      log(`slab ${pol} h ${h}: r ${r[0]!.toFixed(8)} ${r[1]!.toFixed(8)} tau ${tau[0]!.toFixed(8)} ${tau[1]!.toFixed(8)} err ${e.toExponential(2)} dof ${sol.stats.dof} notes ${JSON.stringify(sol.notes ?? [])}`);
      errs.push(e);
    }
    assert.ok(errs[0]! < 1e-3 && errs[1]! < 1e-4 && errs[1]! < errs[0]!, `slab ${pol}: ${errs.join(', ')}`);
  }
});

test('plane-wave direction: incidence along +y rotates the field (PEC cylinder TM, probes rotated by 90 deg)', async () => {
  const rc = CYL.cases.pec_tm!;
  const spec = cylinderSpec({ physics: 'emw-2d', pol: 'TM', kind: 'pec', h: 0.1 }) as { physics: Array<{ bcs: Array<{ type: string; settings?: Record<string, unknown> }> }> };
  spec.physics[0]!.bcs.find((b) => b.type === 'plane-wave')!.settings!.direction = { value: 90, unit: 'deg' };
  const { sol, mesh } = await run(spec);
  const umax = Math.max(...rc.probes.map((p) => p.abs));
  let e = 0;
  for (const p of rc.probes) {
    const v = probeC(mesh, sol, 'Ez', p.rho * Math.cos(p.phi + Math.PI / 2), p.rho * Math.sin(p.phi + Math.PI / 2));
    e = Math.max(e, Math.hypot(v[0] - p.re, v[1] - p.im) / umax);
  }
  assert.ok(e < 1e-3 && rel(sc(sol, 'sigma2d_back'), rc.sigma2d_back_m) < 1e-3, `rotated incidence: ${e}`);
});
