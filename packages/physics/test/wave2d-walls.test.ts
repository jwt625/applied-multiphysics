// SPDX-License-Identifier: GPL-3.0-or-later
// wave2d audit-fix gates (DevLog-042 s.7): G-f plane wave on a wall-backed slab (wall / Robin / Neumann facets next to
// a non-background medium) vs validation/wave2d/backed_slab_refs.py (impedance recursion vs transfer matrix), and
// ports together with sources (S-parameters with sources off, source response reported separately).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, ref, sc, rect, probeC, field, log } from './wave2d-common.ts';

interface SlabCase { physics: 'emw-2d' | 'acoustics'; pol?: 'TM' | 'TE'; eps2?: number; mu2?: number; rho2?: number; c2?: number; bc: string; Z_Pa_s_per_m?: number; v_m_per_s?: number; k1: number; r_re: number; r_im: number }
interface SlabRef { t_m: number; rho1: number; c1: number; f_ac_Hz: number; cases: Record<string, SlabCase> }
const BS = ref<SlabRef>('backed_slab_reference.json');

const q = (v: number | number[], unit: string) => ({ value: v, unit });

/** PML [-1.25, -0.75] | background [-0.75, 0] | slab [0, t] | wall at x = t; channel height 0.2 m (natural walls, listed
 * next to the slab; dn u_inc = 0 there), plane wave along +x. */
function backedSlab(c: SlabCase, h: number) {
  const t = BS.t_m, H = 0.2, L = 0.75, d = 0.5;
  const em = c.physics === 'emw-2d';
  const bg = em ? { eps_r: 1, mu_r: 1 } : { c: q(BS.c1, 'm/s'), rho: q(BS.rho1, 'kg/m^3') };
  const sl = em ? { eps_r: c.eps2!, mu_r: c.mu2! } : { c: q(c.c2!, 'm/s'), rho: q(c.rho2!, 'kg/m^3') };
  const settings = c.bc === 'impedance' ? { Z: q(c.Z_Pa_s_per_m!, 'Pa*s/m') } : c.bc === 'normal-velocity' ? { v: q(c.v_m_per_s!, 'm/s') } : undefined;
  return {
    schema: 'amp-spec/0', id: 'w2d-backed-slab', title: 'wall-backed slab',
    geometry: { dim: 2, features: [rect('outer', -L - d, t, 0, H), rect('inner', -L, t, 0, H), rect('inner2', -L, t, 0, H), rect('slab', 0, t, 0, H),
      { id: 'pml', type: 'difference', settings: { base: 'outer', tools: ['inner2'] } },
      { id: 'air', type: 'difference', settings: { base: 'inner', tools: ['slab'], keepTools: true } }] },
    materials: [{ id: 'bg', override: bg, select: ['dom:pml', 'dom:air'] }, { id: 'film', override: sl, select: ['dom:slab'] }],
    physics: [{ id: 'w', type: c.physics, select: ['dom:pml', 'dom:air', 'dom:slab'], ...(em ? { settings: { polarization: c.pol } } : {}),
      bcs: [{ id: 'absorb', type: 'pml', select: ['dom:pml'] },
        { id: 'inc', type: 'plane-wave', select: ['dom:air'], settings: { direction: 0, amplitude: q(1, em ? (c.pol === 'TM' ? 'V/m' : 'A/m') : 'Pa') } },
        { id: 'wall', type: c.bc, select: ['bnd:slab.right'], ...(settings ? { settings } : {}) },
        { id: 'chan', type: em ? (c.pol === 'TM' ? 'pmc' : 'pec') : 'sound-hard', select: ['bnd:slab.top', 'bnd:slab.bottom'] }] }],
    // slab at h/2 (as G-a2): the shortest local wavelength is 0.354 m (TM eps_r 2, mu_r 4)
    mesh: { size: { hmax: q(h, 'm') }, refine: [{ select: ['dom:slab'], h: q(h / 2, 'm') }] },
    studies: [{ id: 's', type: 'frequency', physics: ['w'], settings: em ? { wavelengths: [q(1, 'm')] } : { values: [q(BS.f_ac_Hz, 'Hz')] } }],
  };
}

test('G-f plane wave on a wall-backed slab (wall / Robin / Neumann next to a non-background medium) vs impedance recursion', async () => {
  const rows: string[] = [], fails: string[] = [];
  for (const [name, c] of Object.entries(BS.cases)) {
    const errs: number[] = [];
    for (const h of [0.05, 0.025]) {
      const { sol, mesh } = await run(backedSlab(c, h));
      const U = c.physics === 'acoustics' ? 'p' : c.pol === 'TM' ? 'Ez' : 'Hz';
      // u_s = r exp(+j k1 x) in the background: r = u_s(x) exp(-j k1 x)
      let e = 0, rr: [number, number] = [0, 0];
      for (const x of [-0.6, -0.4, -0.2]) {
        const us = probeC(mesh, sol, `${U}_sc`, x, 0.1);
        const ph = -c.k1 * x;
        rr = [us[0] * Math.cos(ph) - us[1] * Math.sin(ph), us[0] * Math.sin(ph) + us[1] * Math.cos(ph)];
        e = Math.max(e, Math.hypot(rr[0] - c.r_re, rr[1] - c.r_im));
      }
      rows.push(`${name} h ${h}: r ${rr[0].toFixed(8)} ${rr[1].toFixed(8)} ref ${c.r_re.toFixed(8)} ${c.r_im.toFixed(8)} err ${e.toExponential(2)} dof ${sol.stats.dof}`);
      errs.push(e);
    }
    log(rows.slice(-2).join('\n'));
    if (!(errs[0]! < 1e-3 && errs[1]! < 1e-4 && errs[1]! < errs[0]!)) fails.push(`${name}: ${errs.join(', ')}`);
  }
  assert.deepEqual(fails, []);
});

/**
 * Rigid duct [0, L] x [0, H] (c 343, rho 1.2, 500 Hz): port at x = L, normal velocity v at x = 0 (a velocity source; a
 * rigid wall when the source is off). With the source off the port sees a rigid end: S11 = exp(-2 j k L) (pressure
 * reflection +1 at x = 0, referred to the port plane). The source alone radiates p = rho c v exp(-j k x) into the matched
 * port: outgoing power per unit depth rho c v^2 H / 2.
 */
test('ports with sources: S-parameters with sources off, source response separate (rigid-end duct, velocity piston)', async () => {
  const c = 343, rho = 1.2, f = 500, L = 1, H = 0.2, v = 0.01;
  const duct = (withSrc: boolean) => ({
    schema: 'amp-spec/0', id: 'w2d-duct-src', title: 'duct source + port', geometry: { dim: 2, features: [rect('duct', 0, L, 0, H)] },
    materials: [{ id: 'air', override: { c: q(c, 'm/s'), rho: q(rho, 'kg/m^3') }, select: ['dom:duct'] }],
    physics: [{ id: 'ac', type: 'acoustics', select: ['dom:duct'], bcs: [
      { id: 'p1', type: 'port', select: ['bnd:duct.right'] },
      withSrc ? { id: 'piston', type: 'normal-velocity', select: ['bnd:duct.left'], settings: { v: q(v, 'm/s') } } : { id: 'end', type: 'sound-hard', select: ['bnd:duct.left'] },
      { id: 'walls', type: 'sound-hard', select: ['bnd:duct.top', 'bnd:duct.bottom'] }] }],
    mesh: { size: { hmax: q(0.04, 'm') } },
    studies: [{ id: 's', type: 'frequency', physics: ['ac'], settings: { values: [q(f, 'Hz')] } }],
  });
  const k = (2 * Math.PI * f) / c;
  const a = await run(duct(true)), b = await run(duct(false));
  const s11: [number, number] = [sc(a.sol, 'S11_re'), sc(a.sol, 'S11_im')];
  const eS = Math.hypot(s11[0] - Math.cos(-2 * k * L), s11[1] - Math.sin(-2 * k * L));
  const dS = Math.hypot(s11[0] - sc(b.sol, 'S11_re'), s11[1] - sc(b.sol, 'S11_im'));
  const P = sc(a.sol, 'P_src_1'), Pref = (rho * c * v * v * H) / 2;
  // field: port-excited field + source field; the difference to the source-free run is rho c v exp(-j k x)
  let eF = 0;
  const fa = [field(a.sol, 'p_re'), field(a.sol, 'p_im')], fb = [field(b.sol, 'p_re'), field(b.sol, 'p_im')];
  assert.equal(fa[0]!.length, fb[0]!.length);
  for (const x of [0, 0.25, 0.5, 0.75, 1]) {
    const pa = probeC(a.mesh, a.sol, 'p', x, H / 2), pb = probeC(b.mesh, b.sol, 'p', x, H / 2);
    eF = Math.max(eF, Math.hypot(pa[0] - pb[0] - rho * c * v * Math.cos(-k * x), pa[1] - pb[1] - rho * c * v * Math.sin(-k * x)) / (rho * c * v));
  }
  log(`ports + source: S11 err vs exp(-2jkL) ${eS.toExponential(2)}, S11 with vs without source ${dS.toExponential(2)}; P_src_1 ${P} ref ${Pref} rel ${Math.abs(P / Pref - 1).toExponential(2)}; field superposition err ${eF.toExponential(2)}; notes ${JSON.stringify(a.sol.notes)}`);
  assert.ok(dS < 1e-12, `S11 depends on the source: ${dS}`);
  assert.ok(eS < 1e-4, `S11 vs rigid end: ${eS}`);
  assert.ok(Math.abs(P / Pref - 1) < 1e-4, `source power ${P} vs ${Pref}`);
  assert.ok(eF < 1e-3, `field superposition ${eF}`);   // discretisation error of the travelling wave, as the G-e duct gate
});

test('plane wave: an exterior boundary without a condition next to a non-background medium is rejected (DevLog-042 s.7.7)', async () => {
  const c = BS.cases.te_eps4_pec!;
  const spec = backedSlab(c, 0.05) as { physics: Array<{ bcs: Array<{ id: string }> }> };
  spec.physics[0]!.bcs = spec.physics[0]!.bcs.filter((b) => b.id !== 'chan');   // slab top / bottom left open
  await assert.rejects(run(spec), /plane wave: boundaries 'bnd:slab\.bottom' \(next to 'dom:slab'\); 'bnd:slab\.top' \(next to 'dom:slab'\) have no condition and touch a medium other than the background.*Add a PML domain beyond them, a scattering condition, or a wall condition \(pec, pmc, impedance\) on them/);
  // open boundaries next to the background (channel walls of the air and PML parts) keep today's behaviour (G-f runs with
  // them open); an open slab back face is rejected too
  const spec2 = backedSlab(c, 0.05) as { physics: Array<{ bcs: Array<{ id: string }> }> };
  spec2.physics[0]!.bcs = spec2.physics[0]!.bcs.filter((b) => b.id !== 'wall');
  await assert.rejects(run(spec2), /plane wave: boundary 'bnd:slab\.right' \(next to 'dom:slab'\) has no condition/);
});
