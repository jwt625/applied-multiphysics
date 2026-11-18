// SPDX-License-Identifier: GPL-3.0-or-later
// DevLog-043 gate runner (lane S2): converged runs behind the fast tests in packages/physics/test/modes-*.test.ts.
// Usage (repo root): nice -n 10 node --max-old-space-size=1536 validation/modes2/gates.ts logs/modes2-gates-<ts>.json
// Peak RSS about 1 GB (G-LEAK f = 3, 154k DOF).
import { readFileSync, writeFileSync } from 'node:fs';

const P = new URL('../../packages/', import.meta.url).pathname;
const { solveModes } = await import(`${P}physics/src/modes/index.ts`);
const { tensorMesh, gradedLine } = await import(`${P}physics/src/modes/fixtures.ts`);
const { modeTransform } = await import(`${P}physics/src/modes/transform.ts`);
const { prepareRun, runStudy } = await import(`${P}physics/src/index.ts`);
const { parseYaml } = await import(`${P}spec/src/index.ts`);
const { defaultLibrary } = await import(`${P}materials/src/node.ts`);
const { dispersion } = await import(`${P}materials/src/dispersion.ts`);
const um = 1e-6;
const out: Record<string, unknown> = { date: new Date().toISOString() };
const log = (k: string, v: unknown) => { out[k] = v; console.log(k, JSON.stringify(v)); };

// ---- G-SPP: Au (Johnson-Christy 0.6595 um: n 0.14, k 3.697) / air
{
  const lam = 0.6595, n = 0.14, k = 3.697;
  const em = [n * n - k * k, -2 * n * k];
  const d = (em[0]! + 1) ** 2 + em[1]! ** 2;
  const qr = (em[0]! * (em[0]! + 1) + em[1]! * em[1]!) / d, qi = (em[1]! * (em[0]! + 1) - em[0]! * em[1]!) / d;
  const r = Math.sqrt(0.5 * (Math.hypot(qr, qi) + qr)), nspp = [r, qi / (2 * r)];
  const k0 = 2 * Math.PI / lam;
  const ref = { nRe: nspp[0], kappa: -nspp[1]!, Lspp_um: 1 / (2 * k0 * -nspp[1]!) };
  const rows = [];
  for (const [La, Lm, nn] of [[2.5, 0.25, 60], [5, 0.5, 60], [5, 0.5, 120], [10, 1, 120]] as const) {
    const ys = gradedLine([{ a: -Lm * um, b: 0, n: nn, r: 60, toward: 'b' }, { a: 0, b: La * um, n: nn, r: 60, toward: 'a' }]);
    const mesh = tensorMesh([0, 0.01 * um], ys, ['dom:au', 'dom:air'], (_x: number, y: number) => (y < 0 ? 0 : 1));
    const o = await solveModes({ mesh, eps: [em[0], 1], epsIm: [-em[1]!, 0], wavelength: lam * um, nModes: 1, order: 2, pec: ['bnd:rect.top', 'bnd:rect.bottom'], fields: false });
    const m = o.result.modes[0];
    rows.push({ La_um: La, Lm_um: Lm, cells: nn, neff: m.neff, kappa: m.kappa, dRe: m.neff - ref.nRe, relKappa: m.kappa / ref.kappa - 1, Lprop_um: 1e6 * o.solution.scalars.Lprop_0.value, dof: o.result.stats.dof });
  }
  log('G-SPP', { ref, rows });
}

// ---- G-LEAK (Bienstman 2006) and PML parameter study
function leaky(f: number, Xw = 2, Dp = 1, Ys = 1) {
  const N = (n: number) => Math.max(1, Math.round(n * f));
  const xs = gradedLine([{ a: 0, b: 0.25 * um, n: N(6) }, { a: 0.25 * um, b: Xw * um, n: N(12), r: 8, toward: 'a' }, { a: Xw * um, b: (Xw + Dp) * um, n: N(8) }]);
  const ys = gradedLine([{ a: (-1 - Ys - Dp) * um, b: (-1 - Ys) * um, n: N(8) }, { a: (-1 - Ys) * um, b: -1 * um, n: N(8), r: 3, toward: 'b' }, { a: -1 * um, b: 0, n: N(14), r: 4, toward: 'both' }, { a: 0, b: 0.22 * um, n: N(5) }, { a: 0.22 * um, b: 1.5 * um, n: N(12), r: 8, toward: 'a' }]);
  const yb = (-1 - Ys) * um;
  const mesh = tensorMesh(xs, ys, ['dom:core', 'dom:box', 'dom:sub', 'dom:air', 'dom:pr_air', 'dom:pr_box', 'dom:pr_sub', 'dom:pc_sub', 'dom:pb_sub'], (x: number, y: number) => {
    const right = x > Xw * um;
    if (y < yb) return right ? 7 : 8;
    if (y < -1 * um) return right ? 6 : 2;
    if (y < 0) return right ? 5 : 1;
    if (right) return 4;
    return x < 0.25 * um && y < 0.22 * um ? 0 : 3;
  });
  return mesh;
}
{
  const rows = [];
  for (const [f, a, Xw, Dp, Ys] of [[1, 2, 2, 1, 1], [2, 2, 2, 1, 1], [3, 2, 2, 1, 1], [2, 1, 2, 1, 1], [2, 4, 2, 1, 1], [2, 2, 2, 2, 1], [2, 2, 3, 1, 2]] as const) {
    const mesh = leaky(f, Xw, Dp, Ys);
    const tr = modeTransform(mesh, { pml: [{ domains: [4, 5, 6, 7, 8], strength: a, power: 2 }] });
    const t0 = performance.now();
    const o = await solveModes({ mesh, eps: [3.5 ** 2, 1.45 ** 2, 3.5 ** 2, 1, 1, 1.45 ** 2, 3.5 ** 2, 3.5 ** 2, 3.5 ** 2], wavelength: 1.55 * um, nModes: 4, order: 2, neffShift: 2.42, pec: ['bnd:rect.left', 'bnd:rect.top'], transform: { sx: tr.sx, sy: tr.sy, h: tr.h }, fields: false });
    const m = o.result.modes.find((x: any) => x.teFraction > 0.9 && x.kappa < 1e-6);
    rows.push({ f, strength: a, interiorX_um: Xw, pml_um: Dp, sub_um: Ys, neff: m?.neff, kappa: m?.kappa, dRe: m ? m.neff - 2.41237 : null, relIm: m ? m.kappa / 2.913e-8 - 1 : null, dof: o.result.stats.dof, ms: Math.round(performance.now() - t0) });
  }
  log('G-LEAK', { ref: { neff: 2.41237, kappa: 2.913e-8, source: 'Bienstman 2006 via Tidy3D notebook' }, rows });
}

// ---- G-BEND (Hiremath 2005 Table 3 / mpmath), metric and conformal, two windows
{
  const REF = readFileSync(new URL('bent_slab_ref.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rows = [];
  for (const [f, Ls, Xc, Dp, model] of [[4, 4, 3, 2, 'metric'], [4, 6, 4, 3, 'metric'], [4, 4, 3, 2, 'conformal']] as const)
    for (const r of REF) {
      const R = r.R_um, ls = Math.min(Ls, R - 2.5);
      const N = (n: number) => Math.max(1, Math.round(n * f));
      const xs = gradedLine([{ a: (-2 - ls) * um, b: -2 * um, n: N(16), r: 4, toward: 'b' }, { a: -2 * um, b: 0, n: N(16), r: 2, toward: 'both' }, { a: 0, b: Xc * um, n: N(24), r: 3, toward: 'a' }, { a: Xc * um, b: (Xc + Dp) * um, n: N(16) }]);
      const mesh = tensorMesh(xs, [0, 0.05 * um], ['dom:sub', 'dom:core', 'dom:clad', 'dom:pml'], (x: number) => (x < -2 * um ? 0 : x < 0 ? 1 : x < Xc * um ? 2 : 3));
      const tr = modeTransform(mesh, { pml: [{ domains: [3], strength: 2, power: 2 }], bend: { radius: R * um, x0: 0, model } });
      const pec = r.pol === 'TE' ? ['bnd:rect.top', 'bnd:rect.bottom', 'bnd:rect.left', 'bnd:rect.right'] : ['bnd:rect.left', 'bnd:rect.right'];
      const o = await solveModes({ mesh, eps: [1.6 ** 2, 1.7 ** 2, 1.55 ** 2, 1.55 ** 2], wavelength: 1.55 * um, nModes: 3, order: 2, neffShift: r.beta_over_k + 0.01, pec, transform: { sx: tr.sx, sy: tr.sy, h: tr.h, model }, fields: false });
      const m = o.result.modes.slice().sort((a: any, b: any) => Math.hypot(a.neff - r.beta_over_k, a.kappa - r.alpha_over_k) - Math.hypot(b.neff - r.beta_over_k, b.kappa - r.alpha_over_k))[0];
      rows.push({ model, f, inner_um: ls, clad_um: Xc, pml_um: Dp, R_um: R, pol: r.pol, beta_k: m.neff, alpha_k: m.kappa, ref_beta_k: r.beta_over_k, ref_alpha_k: r.alpha_over_k, table3: r.table3, dBeta: m.neff - r.beta_over_k, relAlpha: m.kappa / r.alpha_over_k - 1, dof: o.result.stats.dof });
    }
  log('G-BEND', rows);
}

// ---- G-NG (Si strip, Si Salzberg-Villa-Tatian and Li 1980 eq. 22 alternatives, SiO2 Malitson) and G-TFLN
const lib = defaultLibrary();
const sim = (name: string) => parseYaml(readFileSync(new URL(`../../sims/${name}`, import.meta.url), 'utf8')).data as any;
const q = (v: number) => ({ value: v, unit: '1/m' });
{
  const rows = [];
  for (const [w, siOpt, hf] of [[450, { alternative: 'salzberg_villa_tatian' }, 1], [450, { alternative: 'salzberg_villa_tatian' }, 0.5], [450, {}, 1], [500, { alternative: 'salzberg_villa_tatian' }, 1]] as const) {
    const run = async (lam: number, on: boolean) => {
      const si = dispersion(lib, 'silicon', lam, siOpt), ox = dispersion(lib, 'sio2-thermal-oxide', lam);
      const spec = sim('si-strip-te0.yaml');
      spec.params.w_core = { value: w, unit: 'nm' }; spec.params.lambda0 = { value: lam * 1e6, unit: 'um' };
      spec.materials[0].override.n = si.n; spec.materials[1].override.n = ox.n;
      if (on) spec.physics[0].settings.dispersion = { dndlambda: { Si: q(si.dn_dlambda), SiO2: q(ox.dn_dlambda) } };
      const s = (await runStudy(await prepareRun(spec, { physicsId: 'ewg', hFactor: hf }))) as any;
      return { neff: s.scalars.neff_0.value, ng: s.scalars.ng_0.value, dof: s.stats.dof, si, ox };
    };
    const lam = 1.55e-6, d = 1e-3 * lam;
    const c = await run(lam, true), n0 = await run(lam, false), p = await run(lam + d, false), m = await run(lam - d, false);
    const fd = c.neff - lam * (p.neff - m.neff) / (2 * d);
    rows.push({ w_nm: w, si: { n: c.si.n, dn_dlambda: c.si.dn_dlambda, ng: c.si.ng, source: c.si.nValue.sourceKeys, derivative: c.si.derivative }, sio2: { n: c.ox.n, dn_dlambda: c.ox.dn_dlambda }, hFactor: hf, neff: c.neff, ngDispersive: c.ng, ngNonDispersive: n0.ng, ngFD: fd, relFormulaFD: c.ng / fd - 1, dof: c.dof });
  }
  log('G-NG', { published: { cheriton2022: { w_nm: 450, neff: 2.34, ng: 4.37 } }, rows });
}
{
  const lam = 1.957e-6;
  const lo = dispersion(lib, 'linbo3-congruent', lam, { component: 'perp' }), le = dispersion(lib, 'linbo3-congruent', lam, { component: 'par' });
  const ox = dispersion(lib, 'sio2-thermal-oxide', lam, { extrapolate: true }), air = dispersion(lib, 'air', lam, { alternative: 'mathar2007_ir' });
  const spec = sim('tfln-mzm-eo.yaml');
  spec.physics.find((p: any) => p.id === 'ewg').settings.dispersion = false;   // the sim carries library dispersion (DevLog-046): base = non-dispersive
  const base = (await runStudy(await prepareRun(structuredClone(spec), { physicsId: 'ewg' }))) as any;
  spec.physics.find((p: any) => p.id === 'ewg').settings.dispersion = { dndlambda: { LN: { perp: q(lo.dn_dlambda), par: q(le.dn_dlambda) }, SiO2: q(ox.dn_dlambda), Air: q(air.dn_dlambda) } };
  const s = (await runStudy(await prepareRun(spec, { physicsId: 'ewg' }))) as any;
  log('G-TFLN', { dndlambda_per_m: { LN_perp: lo.dn_dlambda, LN_par: le.dn_dlambda, SiO2: ox.dn_dlambda, SiO2_extrapolated: ox.extrapolated, Air: air.dn_dlambda, Air_derivative: air.derivative },
    ng: s.scalars.ng_0.value, ngNonDispersive: base.scalars.ng_0.value, ref: 2.276, neff: s.scalars.neff_0.value, VpiL: s.scalars.VpiL.value, VpiLBase: base.scalars.VpiL.value });
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
