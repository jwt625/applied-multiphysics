// SPDX-License-Identifier: GPL-3.0-or-later
// Lane T4 (DevLog-041): photoelastic tensor, extinction coefficient / complex index, Tg and TCR property types, new
// formulas, the dispersion helper for mode solvers, and the photonics / packaging materials. Reference numbers are the
// values printed in the sources (locators in the YAML files) or independent closed-form evaluations written here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibrary } from '../src/node.ts';
import { MaterialRangeError } from '../src/library.ts';
import { dispersion, complexIndex } from '../src/dispersion.ts';
import { FORMULAS } from '../src/formulas.ts';
import { PROPERTY_BY_NAME, tensorMatrix, registerMaterialProperties } from '../src/properties.ts';
import { wave1Registry } from '@amp/spec/provisional';

const lib = loadLibrary();
const close = (a: number, b: number, rel: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg ?? ''} ${a} vs ${b} (rel ${rel})`);
const comp = (v: unknown): Record<string, number> => v as Record<string, number>;

test('p_pe: cubic photoelastic tensors of Si (Chan 2012) and GaAs (Baker 2014), 6x6 Voigt', () => {
  const si = lib.getProperty('silicon', 'p_pe');
  assert.equal(si.symmetry, 'cubic');
  assert.equal(si.unit, '1');
  assert.deepEqual(comp(si.value), { p11: -0.094, p12: 0.017, p44: -0.051 });
  const P = si.matrix as number[][];
  assert.deepEqual(P[0], [-0.094, 0.017, 0.017, 0, 0, 0]);
  assert.deepEqual(P[2], [0.017, 0.017, -0.094, 0, 0, 0]);
  assert.equal(P[3]?.[3], -0.051);
  assert.equal(P[5]?.[5], -0.051);
  assert.equal(si.basis, 'paper_model_input');
  assert.equal(lib.getProperty('silicon', 'p_pe', { alternative: 'baker2014', component: 'p11' }).value, -0.09);
  const ga = lib.getProperty('gaas', 'p_pe', { lambda: 1.15e-6 });
  assert.deepEqual(comp(ga.value), { p11: -0.165, p12: -0.14, p44: -0.072 });
  assert.throws(() => lib.getProperty('gaas', 'p_pe', { lambda: 1.55e-6 }), MaterialRangeError); // stated at 1.15 um only
});

test('p_pe: trigonal-3m matrix form (Nye, class 3m, mirror plane y-z) is non-symmetric with p66 = (p11 - p12) / 2', () => {
  const c = { p11: 1, p12: 2, p13: 3, p14: 4, p31: 5, p33: 6, p41: 7, p44: 8 };
  const P = tensorMatrix('trigonal-3m', c, 'p_pe');
  assert.deepEqual(P, [[1, 2, 3, 4, 0, 0], [2, 1, 3, -4, 0, 0], [5, 5, 6, 0, 0, 0], [7, -7, 0, 8, 0, 0], [0, 0, 0, 0, 8, 7], [0, 0, 0, 0, 4, -0.5]]);
  assert.deepEqual(PROPERTY_BY_NAME.get('p_pe')?.components?.cubic, ['p11', 'p12', 'p44']);
});

test('kappa: complex index of gold (Johnson-Christy nodes) and the complex permittivity', () => {
  // Au/nk/Johnson.yml row 1.6100 um: n 0.56, k 11.21 (no air conversion: n_medium unstated)
  assert.equal(lib.getProperty('gold', 'kappa', { lambda: 1.61e-6 }).value, 11.21);
  const z = complexIndex(lib, 'gold', 1.61e-6);
  assert.equal(z.n, 0.56);
  close(z.epsRe, 0.56 ** 2 - 11.21 ** 2, 1e-12);
  close(z.epsIm, 2 * 0.56 * 11.21, 1e-12);
  assert.ok(z.epsRe < -100 && z.epsIm > 0); // metal, loss with kappa > 0
  // Olmon evaporated alternative, node 1.53 um: n 0.3157, k 10.48
  assert.equal(lib.getProperty('gold', 'kappa', { lambda: 1.53e-6, alternative: 'olmon2012_evaporated' }).value, 10.48);
  // aluminum Rakic node 1.5498 um: n 1.5782, k 15.656; ITO XY15S node 1.52902 um: n 0.22395, k 1.37415
  assert.equal(lib.getProperty('aluminum', 'kappa', { lambda: 1.5498e-6 }).value, 15.656);
  assert.equal(complexIndex(lib, 'ito-xy15s', 1.52902e-6).kappa, 1.37415);
  // a dielectric without kappa gives kappa 0
  assert.equal(complexIndex(lib, 'si3n4-lpcvd', 1.55e-6).kappa, 0);
});

test('formulas: cauchy, sellmeier-general equals sellmeier-c2 for the same terms, li1980-eq22', () => {
  close(FORMULAS.cauchy!.evaluate({ lambda: 2 }, { A: 1.5, B: 0.01, C: 0.001 }), 1.5 + 0.01 / 4 + 0.001 / 16, 1e-15);
  const c2 = FORMULAS['sellmeier-c2']!.evaluate({ lambda: 1.55 }, { A: 2.1399, B: [1.3786, 3.861], C: [0.1715, 15.03] });
  const gen = FORMULAS['sellmeier-general']!.evaluate({ lambda: 1.55 }, { A: 3.1399, B: [1.3786, 3.861], P: [2, 2], C: [0.1715, 15.03], Q: [2, 2], D: [], R: [] });
  close(gen, c2, 1e-14);
  // SiC 4H extraordinary (formula 4) by hand: n^2 = 6.79485 + 0.15558 / (l^2 - 0.03535) - 0.02296 l^2
  const l = 1.55, ne = Math.sqrt(6.79485 + 0.15558 / (l * l - 0.03535) - 0.02296 * l * l);
  close(comp(lib.getProperty('sic-4h', 'n', { lambda: 1.55e-6 }).value).par as number, ne, 1e-12);
});

test('Si: Li 1980 eq. (22) alternative reproduces the Li Table 1 nodes at 293 K within 5e-5', () => {
  // both leaves are air-referenced and converted identically, so compare them at the same vacuum wavelengths
  for (const lam of [1.2, 1.3, 1.4, 1.55, 2.0, 3.0, 5.0, 10.0, 14.0]) {
    const nAir = lib.getProperty('air', 'n', { lambda: lam * 1e-6, extrapolate: true }).value as number;
    const l0 = lam * 1e-6 * nAir; // vacuum wavelength of the table node
    const t = lib.getProperty('silicon', 'n', { lambda: l0, T: 293, extrapolate: true }).value as number;
    const f = lib.getProperty('silicon', 'n', { lambda: l0, T: 293, alternative: 'li1980_eq22', extrapolate: true }).value as number;
    assert.ok(Math.abs(f - t) < 5e-5, `${lam} um: eq22 ${f} table ${t}`);
  }
  assert.throws(() => lib.getProperty('silicon', 'n', { lambda: 1.55e-6, T: 350, alternative: 'li1980_eq22' }), MaterialRangeError);
});

test('dispersion(): group index of fused silica (Malitson) against the closed-form Sellmeier derivative', () => {
  const B = [0.6961663, 0.4079426, 0.8974794], C = [0.0684043, 0.1162414, 9.896161];
  const nAir = lib.getProperty('air', 'n', { lambda: 1.55e-6 }).value as number;
  // Malitson is air-referenced: evaluate at lambda_air (um), n_vac = n_rel x n_air (air index varies slowly; its own
  // dispersion is included numerically by the helper and is below 1e-7 here, so a 2e-6 bound is used for ng)
  const la = 1.55 / nAir;
  let n2 = 1, d = 0;
  for (let i = 0; i < 3; i++) {
    const c2 = (C[i] as number) ** 2, q = la * la - c2;
    n2 += (B[i] as number) * la * la / q;
    d += -(B[i] as number) * 2 * la * c2 / (q * q); // d(n^2)/dlambda
  }
  const n = Math.sqrt(n2), dn = d / (2 * n);
  const ngRef = n - la * dn; // group index is invariant under a constant lambda rescale; n_air dispersion neglected
  const r = dispersion(lib, 'fused-silica', 1.55e-6);
  assert.equal(r.derivative, 'smooth');
  close(r.n, n * nAir, 1e-9);
  assert.ok(Math.abs(r.ng - ngRef * nAir) < 2e-6, `${r.ng} vs ${ngRef * nAir}`);
  assert.ok(r.ng > 1.46 && r.ng < 1.47);
  assert.equal(r.epsIm, 0);
});

test('dispersion(): SiN, LN, GaAs, InP, Si (eq. 22) group indices are above the phase index; tables are flagged', () => {
  const sin = dispersion(lib, 'si3n4-lpcvd', 1.55e-6);
  assert.ok(sin.n > 1.99 && sin.n < 2.0 && sin.ng > sin.n, JSON.stringify([sin.n, sin.ng]));
  const ln = dispersion(lib, 'linbo3-congruent', 1.55e-6, { component: 'par' });
  assert.ok(ln.ng > ln.n);
  for (const id of ['gaas', 'inp']) { const r = dispersion(lib, id, 1.55e-6); assert.ok(r.ng > r.n, id); }
  const si = dispersion(lib, 'silicon', 1.55e-6, { T: 293, alternative: 'li1980_eq22' });
  assert.equal(si.derivative, 'smooth');
  assert.ok(si.ng > 3.6 && si.ng < 3.7, String(si.ng));
  assert.equal(dispersion(lib, 'silicon', 1.55e-6).derivative, 'piecewise-linear');
  const au = dispersion(lib, 'gold', 1.55e-6);
  assert.equal(au.derivative, 'piecewise-linear');
  assert.ok((au.kappa as number) > 9 && au.epsRe < 0);
});

test('Si3N4: Luke Sellmeier default, Arbabi-Goddard 1550 nm alternative and dn/dT', () => {
  assert.equal(lib.getProperty('si3n4-lpcvd', 'n', { lambda: 1.55e-6, alternative: 'arbabi2013_1550' }).value, 1.977);
  close(lib.getProperty('si3n4-lpcvd', 'dndT', { lambda: 1.55e-6 }).value as number, 2.45e-5, 1e-12);
  assert.throws(() => lib.getProperty('si3n4-lpcvd', 'E'), /N\/A/);
});

test('packaging: Tg in K, alpha1 below Tg with alpha2 as alternative, data-sheet values in SI', () => {
  close(lib.getProperty('underfill-uf8830s', 'Tg').value as number, 391.15, 1e-12);
  close(lib.getProperty('underfill-uf8830s', 'Tg', { alternative: 'dma' }).value as number, 399.65, 1e-12);
  close(lib.getProperty('underfill-uf8830s', 'alpha', { T: 300 }).value as number, 25e-6, 1e-12);
  assert.throws(() => lib.getProperty('underfill-uf8830s', 'alpha', { T: 423.15 }), MaterialRangeError); // 150 C > Tg
  close(lib.getProperty('underfill-uf8830s', 'alpha', { alternative: 'above_tg' }).value as number, 100e-6, 1e-12);
  close(lib.getProperty('underfill-uf8830s', 'E', { T: 298.15 }).value as number, 11.5e9, 1e-12);
  close(lib.getProperty('emc-cv8710u', 'k', { T: 298.15 }).value as number, 0.95, 1e-12);
  close(lib.getProperty('emc-cv8710u', 'rho', { T: 298.15 }).value as number, 1980, 1e-12);
  close(lib.getProperty('emc-cv8710u', 'Tg').value as number, 433.15, 1e-12);
  close(lib.getProperty('bt-hl832nx', 'eps_r', { f: 5e9 }).value as number, 4.8, 1e-12);
  close(lib.getProperty('bt-hl832nx', 'cp').value as number, 1000, 1e-12);
  close(lib.getProperty('polyimide-pi2600', 'k').value as number, 0.1046, 1e-12);
  const b = lib.getProperty('borofloat33', 'alpha', { T: 400 });
  assert.equal(b.cteKind, 'secant');
  close(b.T_ref as number, 293.15, 1e-12);
  close(b.value as number, 3.25e-6, 1e-12);
  close(lib.getProperty('sac305', 'E', { T: 298.15 }).value as number, (52.5 + (33.6 - 52.5) * 75 / 270) * 1e9, 1e-12);
  close(lib.getProperty('sac305', 'rho_e').value as number, 13.2e-8, 1e-12);
  close(lib.getProperty('sac305', 'sigma').value as number, 1 / 13.2e-8, 1e-12); // package rule sigma = 1 / rho_e
  close(lib.getProperty('ito-xy15s', 'rho_e').value as number, 1.4e-6, 1e-12);
  close(lib.getProperty('tungsten', 'tcr', { T: 300 }).value as number, 4.8e-3, 1e-12);
  close(lib.getProperty('aluminum', 'nu').value as number, 0.3, 1e-12);
  close(lib.getProperty('nickel', 'k', { T: 300 }).value as number, 90.7, 1e-12);
});

test('registry: p_pe, kappa, Tg, tcr register with their tensor forms', () => {
  const reg = wave1Registry();
  const names = registerMaterialProperties(reg);
  for (const n of ['p_pe', 'kappa', 'Tg', 'tcr']) assert.ok(names.includes(n) || reg.get('property', n), n);
  const p = reg.get('property', 'p_pe') as { scalar?: boolean; tensor?: Record<string, string[]> } | undefined;
  assert.equal(p?.scalar, false);
  assert.deepEqual(p?.tensor?.cubic, ['p11', 'p12', 'p44']);
});
