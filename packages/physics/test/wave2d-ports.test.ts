// SPDX-License-Identifier: GPL-3.0-or-later
// wave2d gates G-b1 (Fresnel, ports), G-c (PML reflection), G-d (waveguide S-parameters), G-e (acoustic duct, AC-01
// setup in 2D) of DevLog-042 s.1.7, plus unit checks (dense eigen solver, study validation, readiness, driver path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, ref, sc, rect, probeC, log } from './wave2d-common.ts';
import { symGenEig, cplxGenEig } from '../src/wave2d/dense.ts';
import { emw2dModule, studyFrequencies } from '../src/wave2d/index.ts';
import { prepareRun, registry, runStudy } from '../src/index.ts';

const k0 = 2 * Math.PI;   // lambda0 = 1 m
const cang = (re: number, im: number, ph: number): [number, number] => [re * Math.cos(ph) - im * Math.sin(ph), re * Math.sin(ph) + im * Math.cos(ph)];

test('dense generalised eigen solvers: residual and B-orthonormality', () => {
  const n = 7;
  const A = new Float64Array(n * n), B = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { A[i * n + j] = Math.cos(i + 2 * j) + Math.cos(j + 2 * i); B[i * n + j] = (i === j ? 4 : 0) + 0.3 / (1 + Math.abs(i - j)); }
  const { d, X } = symGenEig(A, B, n);
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    let r = 0; for (let j = 0; j < n; j++) r += (A[i * n + j]! - d[k]! * B[i * n + j]!) * X[j * n + k]!;
    assert.ok(Math.abs(r) < 1e-12, `residual ${r}`);
  }
  for (let k = 0; k < n; k++) for (let l = 0; l < n; l++) {
    let s = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s += X[i * n + k]! * B[i * n + j]! * X[j * n + l]!;
    assert.ok(Math.abs(s - (k === l ? 1 : 0)) < 1e-12);
  }
  const AI = A.map((_, i) => 0.1 * Math.sin(i)), Asym = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Asym[i * n + j] = AI[Math.min(i, j) * n + Math.max(i, j)]!;
  const e = cplxGenEig(A, Asym, B, new Float64Array(n * n), n);
  for (let k = 0; k < n; k++) {
    let s0 = 0, s1 = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const b = B[i * n + j]!; s0 += b * (e.Xr[i * n + k]! * e.Xr[j * n + k]! - e.Xi[i * n + k]! * e.Xi[j * n + k]!); s1 += b * (e.Xr[i * n + k]! * e.Xi[j * n + k]! + e.Xi[i * n + k]! * e.Xr[j * n + k]!); }
    assert.ok(Math.abs(s0 - 1) < 1e-10 && Math.abs(s1) < 1e-10, `bilinear norm ${s0} ${s1}`);
  }
});

/** Channel of height H (natural walls unless given), domains a = [0, x1], b = [x1, x2]; ports / PML per case. */
function channel(o: { pol: 'TM' | 'TE'; h: number; x1: number; x2: number; H: number; eps: [number, number]; tand?: [number, number]; bcs: unknown[] }) {
  return {
    schema: 'amp-spec/0', id: 'w2d-ch', title: 'channel',
    geometry: { dim: 2, features: [rect('a', 0, o.x1, 0, o.H), rect('b', o.x1, o.x2, 0, o.H)] },
    materials: [{ id: 'm1', override: { eps_r: o.eps[0], mu_r: 1, ...(o.tand ? { tan_delta: o.tand[0] } : {}) }, select: ['dom:a'] }, { id: 'm2', override: { eps_r: o.eps[1], mu_r: 1, ...(o.tand ? { tan_delta: o.tand[1] } : {}) }, select: ['dom:b'] }],
    physics: [{ id: 'w', type: 'emw-2d', select: ['dom:a', 'dom:b'], settings: { polarization: o.pol }, bcs: o.bcs }],
    mesh: { size: { hmax: { value: o.h, unit: 'm' } } },
    studies: [{ id: 's', type: 'frequency', physics: ['w'], settings: { wavelengths: [{ value: 1, unit: 'm' }] } }],
  };
}

test('G-b1 Fresnel reflection at a planar interface, normal and oblique (33.75 deg), TM (s) and TE (p), via port modes', async () => {
  // channel height H = 0.9 m with natural walls: port mode q = cos(q pi y / H) = two plane waves at sin(theta) = q pi / (H k1)
  const H = 0.9, eps2 = 2.25, D = 0.5;
  for (const pol of ['TM', 'TE'] as const) {
    const errs: number[][] = [];
    for (const h of [0.05, 0.025]) {
      const { sol } = await run(channel({ pol, h, x1: D, x2: 1, H, eps: [1, eps2], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'], settings: { nModes: 4 } }, { id: 'p2', type: 'port', select: ['bnd:b.right'], settings: { nModes: 4 } }] }));
      const e: number[] = [];
      for (const qm of [0, 1]) {
        const ky = (qm * Math.PI) / H, b1 = Math.sqrt(k0 * k0 - ky * ky), b2 = Math.sqrt(k0 * k0 * eps2 - ky * ky);
        const a2 = pol === 'TM' ? 1 : 1 / eps2;
        const r = (b1 - a2 * b2) / (b1 + a2 * b2), T = 1 - r * r;
        const key = qm === 0 ? 'S11' : 'S11_11', k21 = qm === 0 ? 'S21' : 'S21_11';
        // S11 refers to the port plane: r = S11 exp(+2 j beta1 D) (beta1 of the discrete port mode)
        const [rr, ri] = cang(sc(sol, `${key}_re`), sc(sol, `${key}_im`), 2 * sc(sol, `beta_1_${qm}`) * D);
        const dT = Math.abs(sc(sol, `${k21}_abs`) ** 2 - T);
        log(`fresnel ${pol} h ${h} mode ${qm} theta ${(Math.asin(ky / k0) * 180 / Math.PI).toFixed(2)} deg: r ${rr.toFixed(8)} ${ri.toExponential(2)} ref ${r.toFixed(8)} |S21|^2 - T ${dT.toExponential(2)} dof ${sol.stats.dof}`);
        e.push(Math.hypot(rr - r, ri), dT);
      }
      errs.push(e);
    }
    assert.ok(Math.max(...errs[0]!) < 2e-5 && Math.max(...errs[1]!) < 1e-6, `${pol}: ${JSON.stringify(errs)}`);
  }
});

test('G-c PML reflection vs thickness and angle (port + PML, vacuum channel)', async () => {
  const H = 0.9, rows: Array<{ d: number; R0: number; m0: number; m1: number }> = [];
  for (const [d, R0] of [[0.25, 1e-8], [0.5, 1e-8], [1, 1e-8], [0.5, 1e-6]] as Array<[number, number]>) {
    const { sol } = await run(channel({ pol: 'TM', h: 0.05, x1: 1, x2: 1 + d, H, eps: [1, 1], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'], settings: { nModes: 4 } }, { id: 'absorb', type: 'pml', select: ['dom:b'], settings: { R0 } }] }));
    rows.push({ d, R0, m0: sc(sol, 'S11_abs'), m1: sc(sol, 'S11_11_abs') });
  }
  log('pml', JSON.stringify(rows));
  // stated bounds (DevLog-042 s.4): R0 = 1e-8, h = lambda/20, order 2: |S11| <= 2e-4 (d = lambda/4), 1e-5 (lambda/2), 2e-6 (lambda)
  assert.ok(rows[0]!.m0 < 2e-4 && rows[0]!.m1 < 2e-4, JSON.stringify(rows[0]));
  assert.ok(rows[1]!.m0 < 1e-5 && rows[1]!.m1 < 1e-5, JSON.stringify(rows[1]));
  assert.ok(rows[2]!.m0 < 2e-6 && rows[2]!.m1 < 2e-6, JSON.stringify(rows[2]));
  assert.ok(rows[2]!.m0 < rows[1]!.m0 && rows[1]!.m0 < rows[0]!.m0, 'reflection decreases with thickness');
  // default R0 1e-6: continuum limit R0^cos(theta) at 33.75 deg = 1.03e-5
  assert.ok(rows[3]!.m0 < 1e-5 && rows[3]!.m1 < 2 * Math.pow(1e-6, Math.cos(Math.asin(Math.PI / H / k0))), JSON.stringify(rows[3]));
});

interface PlanarRef { waveguide: { eps_core: number; eps_clad: number; w_m: number; H_m: number; beta_1_per_m: number } }
const WG = ref<PlanarRef>('planar_reference.json').waveguide;

function waveguide(h: number, step: boolean, nModes: number) {
  const L = 2, H = WG.H_m, w = WG.w_m;
  const feats: unknown[] = [rect('box', 0, L, -H, H)];
  if (!step) feats.push(rect('core', 0, L, -w / 2, w / 2));
  else feats.push(rect('c1', 0, L / 2, -w / 2, w / 2), rect('c2', L / 2, L, -w, w), { id: 'core', type: 'union', settings: { inputs: ['c1', 'c2'] } });
  feats.push({ id: 'clad', type: 'difference', settings: { base: 'box', tools: ['core'], keepTools: true } });
  return {
    schema: 'amp-spec/0', id: 'w2d-wg', title: 'slab waveguide',
    geometry: { dim: 2, features: feats },
    materials: [{ id: 'm_clad', override: { eps_r: WG.eps_clad, mu_r: 1 }, select: ['dom:clad'] }, { id: 'm_core', override: { eps_r: WG.eps_core, mu_r: 1 }, select: ['dom:core'] }],
    physics: [{ id: 'w', type: 'emw-2d', select: ['dom:clad', 'dom:core'], settings: { polarization: 'TM' },
      bcs: [{ id: 'p1', type: 'port', select: ['bnd:box.left', step ? 'bnd:c1.left' : 'bnd:core.left'], settings: { nModes } },
        { id: 'p2', type: 'port', select: ['bnd:box.right', step ? 'bnd:c2.right' : 'bnd:core.right'], settings: { nModes } },
        { id: 'walls', type: 'pec', select: ['bnd:box.top', 'bnd:box.bottom'] }] }],
    mesh: { size: { hmax: { value: h, unit: 'm' } } },
    studies: [{ id: 's', type: 'frequency', physics: ['w'], settings: { wavelengths: [{ value: 1, unit: 'm' }] } }],
  };
}

test('G-d straight slab waveguide: |S21| = 1, arg S21 = -beta L, beta vs the slab dispersion root', async () => {
  const L = 2, errs: Array<[number, number, number]> = [];
  for (const h of [0.05, 0.025]) {
    const { sol, ms } = await run(waveguide(h, false, 1));
    const b = sc(sol, 'beta_1_0');
    const ph = Math.atan2(sc(sol, 'S21_im'), sc(sol, 'S21_re'));
    const dph = Math.abs(Math.atan2(Math.sin(ph + b * L), Math.cos(ph + b * L)));
    const e: [number, number, number] = [Math.abs(sc(sol, 'S21_abs') - 1), dph, Math.abs(b / WG.beta_1_per_m - 1)];
    log(`waveguide h ${h}: |S21| - 1 ${e[0].toExponential(2)}, phase err ${e[1].toExponential(2)} rad, beta ${b} (ref ${WG.beta_1_per_m}, rel ${e[2].toExponential(2)}), |S11| ${sc(sol, 'S11_abs').toExponential(2)}, dof ${sol.stats.dof}, ${Math.round(ms)} ms`);
    errs.push(e);
  }
  assert.ok(errs.every((e) => e[0] < 1e-6), JSON.stringify(errs));
  assert.ok(errs[0]![1] < 1e-3 && errs[1]![1] < 1e-4, JSON.stringify(errs));
  assert.ok(errs[0]![2] < 1e-5 && errs[1]![2] < 1e-6, JSON.stringify(errs));
});

test('G-d symmetric step (w -> 2w): reciprocity S_ij = S_ji and energy conservation over all propagating modes', async () => {
  const { sol } = await run(waveguide(0.05, true, 32));
  const S = sol.wave2d.perFrequency[0]!.S as { keys: unknown[]; re: number[]; im: number[] };
  const nk = S.keys.length;
  let recip = 0, energy = 0;
  for (let j = 0; j < nk; j++) {
    let p = 0;
    for (let i = 0; i < nk; i++) { p += S.re[i * nk + j]! ** 2 + S.im[i * nk + j]! ** 2; recip = Math.max(recip, Math.hypot(S.re[i * nk + j]! - S.re[j * nk + i]!, S.im[i * nk + j]! - S.im[j * nk + i]!)); }
    energy = Math.max(energy, Math.abs(p - 1));
  }
  log(`step: ${nk} propagating (port, mode) pairs, max |Sij - Sji| ${recip.toExponential(2)}, max |sum_i |Sij|^2 - 1| ${energy.toExponential(2)}, |S21| ${sc(sol, 'S21_abs')}, S12 ${sc(sol, 'S12_re')} ${sc(sol, 'S12_im')}`);
  assert.ok(nk >= 4 && recip < 1e-10 && energy < 1e-10, `${nk} ${recip} ${energy}`);
});

test('G-d lossy uniform guide (tan_delta, complex port modes): S21 = exp(-j beta L), beta = k0 sqrt(eps (1 - j tan_delta))', async () => {
  const eps = 2.25, td = 0.01, L = 1;
  const { sol } = await run(channel({ pol: 'TM', h: 0.025, x1: 0.5, x2: L, H: 0.2, eps: [eps, eps], tand: [td, td], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'] }, { id: 'p2', type: 'port', select: ['bnd:b.right'] }] }));
  // beta = k0 sqrt(eps (1 - j td)), branch Re > 0, Im < 0
  const m = Math.hypot(eps, eps * td), ar = Math.atan2(-eps * td, eps) / 2;
  const br = k0 * Math.sqrt(m) * Math.cos(ar), bi = k0 * Math.sqrt(m) * Math.sin(ar);
  const ref21: [number, number] = [Math.exp(bi * L) * Math.cos(-br * L), Math.exp(bi * L) * Math.sin(-br * L)];
  const e = Math.hypot(sc(sol, 'S21_re') - ref21[0], sc(sol, 'S21_im') - ref21[1]);
  log(`lossy guide: S21 ${sc(sol, 'S21_re')} ${sc(sol, 'S21_im')} ref ${ref21[0]} ${ref21[1]} err ${e.toExponential(2)}; |S21| ${sc(sol, 'S21_abs')}; notes ${JSON.stringify(sol.notes)}`);
  assert.ok(e < 1e-4, `S21 error ${e}`);
});

test('G-e acoustic duct (AC-01 setup in 2D): normal velocity in, rho c impedance out: |p| / (rho c v) = 1, phase -k x', async () => {
  const c = 343, rho = 1.2, v = 1, Lx = 3.4, H = 0.2, freqs = [100, 250, 500];
  const spec = {
    schema: 'amp-spec/0', id: 'w2d-duct', title: 'duct', geometry: { dim: 2, features: [rect('duct', 0, Lx, 0, H)] },
    materials: [{ id: 'air', override: { c: { value: c, unit: 'm/s' }, rho: { value: rho, unit: 'kg/m^3' } }, select: ['dom:duct'] }],
    physics: [{ id: 'ac', type: 'acoustics', select: ['dom:duct'], bcs: [
      { id: 'in', type: 'normal-velocity', select: ['bnd:duct.left'], settings: { v: { value: v, unit: 'm/s' } } },
      { id: 'out', type: 'impedance', select: ['bnd:duct.right'], settings: { Z: { value: rho * c, unit: 'Pa*s/m' } } },
      { id: 'walls', type: 'sound-hard', select: ['bnd:duct.top', 'bnd:duct.bottom'] }] }],
    mesh: { size: { hmax: { value: 0.05, unit: 'm' } } },
    studies: [{ id: 's', type: 'frequency', physics: ['ac'], settings: { values: freqs.map((f) => ({ value: f, unit: 'Hz' })) } }],
  };
  const { sol, mesh } = await run(spec);
  assert.equal(sol.steps?.kind, 'freq');
  assert.equal(sol.steps?.values.length, 3);
  let emax = 0;
  freqs.forEach((f, i) => {
    assert.equal(sc(sol, `freq_${i}`), f);
    const k = (2 * Math.PI * f) / c;
    for (const x of [0, 0.85, 1.7, 2.55, 3.4]) {
      const p = probeC(mesh, sol, 'p', x, H / 2, i);
      const refp: [number, number] = [rho * c * v * Math.cos(-k * x), rho * c * v * Math.sin(-k * x)];
      emax = Math.max(emax, Math.hypot(p[0] - refp[0], p[1] - refp[1]) / (rho * c * v));
    }
  });
  log(`duct: max |p - rho c v exp(-j k x)| / (rho c v) = ${emax.toExponential(2)} over 3 frequencies, dof ${sol.stats.dof}`);
  assert.ok(emax < 1e-3, `duct error ${emax}`);
});

test('frequency study: values or wavelengths (exactly one), wavelengths only for EM; readiness (supported and unsupported BC types) and driver path', async () => {
  const st = (settings: Record<string, unknown>) => ({ id: 's', type: 'frequency', settings }) as never;
  assert.deepEqual(studyFrequencies({} as never, st({ values: [{ value: 2, unit: 'GHz' }] }), 'emw'), [2e9]);
  assert.ok(Math.abs(studyFrequencies({} as never, st({ wavelengths: [{ value: 1.55, unit: 'um' }] }), 'emw')[0]! - 299792458 / 1.55e-6) < 1);
  assert.throws(() => studyFrequencies({} as never, st({ wavelengths: [{ value: 1, unit: 'm' }] }), 'acoustics'), /electromagnetic/);
  // spec validation rejects both / neither
  const base = channel({ pol: 'TM', h: 0.1, x1: 0.5, x2: 1, H: 0.2, eps: [1, 1], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'] }, { id: 'p2', type: 'port', select: ['bnd:b.right'] }] });
  const both = structuredClone(base); (both.studies[0]!.settings as Record<string, unknown>).values = [{ value: 1, unit: 'GHz' }];
  await assert.rejects(prepareRun(both, {}), /exactly one of values/);
  // readiness: a supported condition (impedance) is accepted
  const ok = structuredClone(base) as { physics: Array<{ bcs: unknown[] }> };
  ok.physics[0]!.bcs.push({ id: 'x', type: 'impedance', select: ['bnd:a.top'], settings: { R: { value: 50, unit: 'ohm' } } });
  assert.equal(emw2dModule.readiness(ok as never, 'w').ready, true);
  // readiness and run: an unsupported condition type (heat 'temperature') is rejected with its id and type
  const bad = structuredClone(base) as { physics: Array<{ bcs: unknown[] }> };
  bad.physics[0]!.bcs.push({ id: 'hot', type: 'temperature', select: ['bnd:a.top'], settings: { T: { value: 300, unit: 'K' } } });
  const rd = emw2dModule.readiness(bad as never, 'w');
  assert.equal(rd.ready, false);
  assert.ok(rd.reasons.some((r) => /BC 'hot': type 'temperature' is not supported by the frequency-domain solver/.test(r)), JSON.stringify(rd.reasons));
  const pb = await prepareRun(base, {});
  (pb.spec.physics![0]!.bcs as unknown[]).push({ id: 'hot', type: 'temperature', select: ['bnd:a.top'], settings: { T: { value: 300, unit: 'K' } } });
  await assert.rejects(emw2dModule.run(pb), /unsupported BC types for the frequency-domain solver: hot \(temperature\)/);
  // driver: a single-physics study runs the module (modules registry extended with emw-2d until index.ts registers it)
  const p = await prepareRun(base, {});
  const sol = await runStudy(p, { modules: { ...registry, 'emw-2d': emw2dModule } });
  assert.ok(Math.abs(sc(sol, 'S21_abs') - 1) < 1e-6);
});

test('impedance (Leontovich: good conductor, reactive R +- j X) and first-order scattering BC: reflection vs closed forms', async () => {
  const D = 0.6, H = 0.9;
  const ETA0 = 299792458 * 1.25663706212e-6;   // c0 mu0 (CODATA mu0 as in electrostatics/index.ts)
  const omega = 2 * Math.PI * 299792458;
  for (const pol of ['TM', 'TE'] as const) {
    // good conductor, sigma = 5.8e7 S/m (test input): Zs = (1 + j) sqrt(omega mu0 / (2 sigma)); Gamma_E = (Zs - eta0) / (Zs + eta0)
    const sig = 5.8e7, rs = Math.sqrt((omega * 1.25663706212e-6) / (2 * sig));
    const den = (rs + ETA0) ** 2 + rs * rs;
    const gE: [number, number] = [((rs - ETA0) * (rs + ETA0) + rs * rs) / den, (rs * (rs + ETA0) - (rs - ETA0) * rs) / den];
    const gRef: [number, number] = pol === 'TM' ? gE : [-gE[0], -gE[1]];
    const { sol } = await run(channel({ pol, h: 0.05, x1: 0.3, x2: D, H, eps: [1, 1], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'], settings: { nModes: 2 } }, { id: 'wall', type: 'impedance', select: ['bnd:b.right'], settings: { sigma: { value: sig, unit: 'S/m' } } }] }));
    const g = cang(sc(sol, 'S11_re'), sc(sol, 'S11_im'), 2 * sc(sol, 'beta_1_0') * D);
    const e = Math.hypot(g[0] - gRef[0], g[1] - gRef[1]);
    // conductor loss: 1 - |Gamma| (2.4e-5 here) to 1 %; complex Gamma to 1e-4 (phase referred through the discrete beta)
    const loss = 1 - sc(sol, 'S11_abs'), lossRef = 1 - Math.hypot(...gRef);
    log(`impedance ${pol}: Gamma ${g[0]} ${g[1]} ref ${gRef[0]} ${gRef[1]} err ${e.toExponential(2)}; 1 - |S11| ${loss.toExponential(4)} ref ${lossRef.toExponential(4)}`);
    assert.ok(e < 1e-4 && Math.abs(loss / lossRef - 1) < 1e-2, `impedance ${pol}: ${e}, loss ${loss} vs ${lossRef}`);
    // reactive load Zs = eta0 (0.5 +- 0.8 j) (test input): |Im Gamma| ~ 0.55, so the tolerance 1e-4 resolves X and its
    // sign (X > 0 inductive with exp(+j omega t): Im Gamma_E > 0; TE Gamma_H = -Gamma_E)
    for (const sx of [1, -1]) {
      const Zs: [number, number] = [0.5 * ETA0, sx * 0.8 * ETA0];
      const dz = (Zs[0] + ETA0) ** 2 + Zs[1] ** 2;
      const gEx: [number, number] = [((Zs[0] - ETA0) * (Zs[0] + ETA0) + Zs[1] * Zs[1]) / dz, (Zs[1] * (Zs[0] + ETA0) - (Zs[0] - ETA0) * Zs[1]) / dz];
      const gX: [number, number] = pol === 'TM' ? gEx : [-gEx[0], -gEx[1]];
      const rx = await run(channel({ pol, h: 0.05, x1: 0.3, x2: D, H, eps: [1, 1], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'] }, { id: 'wall', type: 'impedance', select: ['bnd:b.right'], settings: { R: { value: Zs[0], unit: 'ohm' }, X: { value: Zs[1], unit: 'ohm' } } }] }));
      const gx = cang(sc(rx.sol, 'S11_re'), sc(rx.sol, 'S11_im'), 2 * sc(rx.sol, 'beta_1_0') * D);
      const ex = Math.hypot(gx[0] - gX[0], gx[1] - gX[1]);
      log(`impedance ${pol} X ${sx > 0 ? '+' : '-'}0.8 eta0: Gamma ${gx[0]} ${gx[1]} ref ${gX[0]} ${gX[1]} err ${ex.toExponential(2)}`);
      assert.ok(Math.sign(gx[1]) === Math.sign(gX[1]) && Math.abs(gX[1]) > 0.5 && Math.sign(gX[1]) === (pol === 'TM' ? sx : -sx), `impedance ${pol}: sign of Im Gamma ${gx[1]} vs ${gX[1]}`);
      assert.ok(ex < 1e-4, `impedance ${pol} X ${sx}: ${ex}`);
    }
    // matched Zs = eta0: absorbs normal incidence; first-order ABC: r(theta) = (cos theta - 1) / (cos theta + 1)
    const m = await run(channel({ pol, h: 0.05, x1: 0.3, x2: D, H, eps: [1, 1], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'], settings: { nModes: 2 } }, { id: 'wall', type: 'impedance', select: ['bnd:b.right'], settings: { R: { value: ETA0, unit: 'ohm' } } }] }));
    const a = await run(channel({ pol, h: 0.05, x1: 0.3, x2: D, H, eps: [1, 1], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'], settings: { nModes: 2 } }, { id: 'abc', type: 'scattering', select: ['bnd:b.right'] }] }));
    const ct = Math.sqrt(1 - (Math.PI / H / k0) ** 2), rAbc = (ct - 1) / (ct + 1);
    const ga = cang(sc(a.sol, 'S11_11_re'), sc(a.sol, 'S11_11_im'), 2 * sc(a.sol, 'beta_1_1') * D);
    log(`matched ${pol}: |S11| ${sc(m.sol, 'S11_abs').toExponential(2)}; scattering BC: |S11| ${sc(a.sol, 'S11_abs').toExponential(2)}, oblique r ${ga[0]} ${ga[1]} ref ${rAbc}`);
    assert.ok(sc(m.sol, 'S11_abs') < 1e-5 && sc(a.sol, 'S11_abs') < 1e-5, 'normal incidence absorbed');
    assert.ok(Math.hypot(ga[0] - rAbc, ga[1]) < 1e-4, `ABC oblique ${ga} vs ${rAbc}`);
  }
});

test('parametric sweeps: frequency study values from params (wavelength param), acoustic port S21 = exp(-j k L)', async () => {
  const mk = (lam: number) => {
    const s = channel({ pol: 'TM', h: 0.05, x1: 0.5, x2: 1, H: 0.2, eps: [1, 1], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'] }, { id: 'p2', type: 'port', select: ['bnd:b.right'] }] }) as Record<string, unknown> & { studies: Array<{ settings: Record<string, unknown> }> };
    s.params = { lam: { value: lam, unit: 'm' } };
    s.studies[0]!.settings = { wavelengths: ['lam'] };
    return s;
  };
  for (const lam of [1, 0.8]) {
    const { sol } = await run(mk(lam));
    const ph = Math.atan2(sc(sol, 'S21_im'), sc(sol, 'S21_re')), b = (2 * Math.PI) / lam;
    assert.ok(Math.abs(Math.atan2(Math.sin(ph + b), Math.cos(ph + b))) < 2e-3, `lam ${lam}: phase ${ph}`);
    assert.ok(Math.abs(sc(sol, 'freq') - 299792458 / lam) < 1e-3);
  }
  const c = 343, f = 500, L = 1;
  const duct = {
    schema: 'amp-spec/0', id: 'w2d-duct-port', title: 'duct ports', geometry: { dim: 2, features: [rect('duct', 0, L, 0, 0.2)] },
    materials: [{ id: 'air', override: { c: { value: c, unit: 'm/s' }, rho: { value: 1.2, unit: 'kg/m^3' } }, select: ['dom:duct'] }],
    physics: [{ id: 'ac', type: 'acoustics', select: ['dom:duct'], bcs: [{ id: 'p1', type: 'port', select: ['bnd:duct.left'] }, { id: 'p2', type: 'port', select: ['bnd:duct.right'] }, { id: 'walls', type: 'sound-hard', select: ['bnd:duct.top', 'bnd:duct.bottom'] }] }],
    mesh: { size: { hmax: { value: 0.04, unit: 'm' } } },
    studies: [{ id: 's', type: 'frequency', physics: ['ac'], settings: { values: [{ value: f, unit: 'Hz' }] } }],
  };
  const { sol } = await run(duct);
  const k = (2 * Math.PI * f) / c;
  const e = Math.hypot(sc(sol, 'S21_re') - Math.cos(-k * L), sc(sol, 'S21_im') - Math.sin(-k * L));
  log(`acoustic duct ports: S21 err ${e.toExponential(2)}, |S11| ${sc(sol, 'S11_abs').toExponential(2)}`);
  assert.ok(e < 1e-4 && sc(sol, 'S11_abs') < 1e-6, `acoustic port ${e}`);
});

test('complex index from n and kappa (lane T4 property, exp(-i omega t) sign): eps = (n - j kappa)^2 here; S21 = exp(-j k0 (n - j kappa) L)', async () => {
  const n = 1.5, kap = 0.002, L = 1;
  const s = channel({ pol: 'TE', h: 0.025, x1: 0.5, x2: L, H: 0.2, eps: [1, 1], bcs: [{ id: 'p1', type: 'port', select: ['bnd:a.left'] }, { id: 'p2', type: 'port', select: ['bnd:b.right'] }] }) as { materials: Array<{ override: Record<string, unknown> }> };
  for (const m of s.materials) m.override = { n, kappa: kap, mu_r: 1 };
  const { sol } = await run(s);
  const ref21: [number, number] = [Math.exp(-k0 * kap * L) * Math.cos(-k0 * n * L), Math.exp(-k0 * kap * L) * Math.sin(-k0 * n * L)];
  const e = Math.hypot(sc(sol, 'S21_re') - ref21[0], sc(sol, 'S21_im') - ref21[1]);
  log(`n, kappa guide (TE): S21 err ${e.toExponential(2)}, |S21| ${sc(sol, 'S21_abs')} ref ${Math.exp(-k0 * kap * L)}`);
  assert.ok(e < 1e-4, `n-kappa S21 error ${e}`);
});
