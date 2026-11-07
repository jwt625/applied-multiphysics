// SPDX-License-Identifier: GPL-3.0-or-later
// Loader and evaluation tests (DevLog-013 gate 2). Reference numbers are values printed in the sources (locators in
// the YAML files), not values computed by this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMaterialsDir, loadLibrary, DEFAULT_MATERIALS_DIR } from '../src/node.ts';
import { MaterialNAError, MaterialRangeError, createLibrary } from '../src/library.ts';
import { parseMaterialText } from '../src/validate.ts';
import { parseUnit, toSI } from '../src/units.ts';
import { FORMULAS } from '../src/formulas.ts';
import { registerMaterialProperties, PROPERTY_DEFS } from '../src/properties.ts';
import { materialJsonSchema } from '../src/schema.ts';
import { wave1Registry } from '@amp/spec/provisional';
import { parseSpecText } from '@amp/spec';

const lib = loadLibrary();
const close = (a: number, b: number, rel: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg ?? ''} ${a} vs ${b} (rel ${rel})`);

test('every materials/*.yaml validates', () => {
  const r = loadMaterialsDir();
  assert.deepEqual(r.issues, []);
  assert.equal(r.docs.length, r.files.length);
  assert.ok(r.files.length >= 13);
});

test('units: core units, exact extensions, affine degC', () => {
  assert.equal(toSI(1, parseUnit('W/(cm*K)')), 100);
  close(toSI(1, parseUnit('uohm*cm')), 1e-8, 1e-12);
  close(toSI(1, parseUnit('ksi')), 6894757.293168361, 1e-12);
  close(toSI(1, parseUnit('lb/in^3')), 27679.904710203125, 1e-12);
  assert.equal(toSI(20, parseUnit('degC')), 293.15);
  assert.equal(toSI(1, parseUnit('ppm/K')), 1e-6);
});

test('sims/ references resolve (L2 request: steel, air, copper)', () => {
  for (const id of ['structural-steel', 'air', 'copper']) assert.ok(lib.get(`materials/${id}`), id);
  assert.ok(lib.getProperty('materials/structural-steel', 'E', { T: 293.15 }).value as number > 1e11);
});

test('tables: nodes reproduce the printed values; interpolation; SI conversion', () => {
  assert.equal(lib.getProperty('copper', 'k', { T: 300 }).value, 401); // HPL p.332: 4.01 W/(cm K)
  close(lib.getProperty('copper', 'rho_e', { T: 293 }).value as number, 1.678e-8, 1e-12); // Matula Table 2
  close(lib.getProperty('air', 'mu', { T: 300 }).value as number, 18.57e-6, 1e-12); // Kadoya Table 8
  close(lib.getProperty('air', 'k', { T: 300 }).value as number, 26.23e-3, 1e-12); // Kadoya Table 12
  close(lib.getProperty('air', 'c', { T: 300 }).value as number, 347.4, 1e-12); // Lemmon Table A2
  close(lib.getProperty('air', 'rho', { T: 300 }).value as number, 0.040634 * 28.9586, 5e-5); // Table A2 x M
  close(lib.getProperty('water', 'rho', { T: 300 }).value as number, 996.557, 1e-12); // WebBook
  close(lib.getProperty('water', 'cp', { T: 300 }).value as number, 4180.64, 1e-12);
  // Li Table 1 node 1.55 um (air-referenced): queried at the vacuum wavelength exactly at the node's vacuum equivalent
  const nAir = lib.getProperty('air', 'n', { lambda: 1.55e-6 }).value as number;
  close(lib.getProperty('silicon', 'n', { lambda: 1.55e-6 * nAir }).value as number, 3.4757 * (lib.getProperty('air', 'n', { lambda: 1.55e-6 * nAir }).value as number), 1e-9);
  close(lib.getProperty('silicon', 'dndT', { lambda: 1.55e-6 * nAir }).value as number, 1.818e-4, 1e-9); // Li Table 2 (not converted)
  // linear interpolation midway between nodes
  close(lib.getProperty('air', 'c', { T: 305 }).value as number, (347.4 + 353.1) / 2, 1e-12);
});

test('loglog interpolation and the sigma = 1 / rho_e rule', () => {
  const r = lib.getProperty('gold', 'rho_e', { T: 296.5 }).value as number;
  const exp = Math.exp(Math.log(2.214e-8) + (Math.log(296.5) - Math.log(293)) / (Math.log(300) - Math.log(293)) * (Math.log(2.271e-8) - Math.log(2.214e-8)));
  close(r, exp, 1e-12);
  const s = lib.getProperty('copper', 'sigma', { T: 293 });
  close(s.value as number, 1 / 1.678e-8, 1e-12);
  assert.equal(s.basis, 'derived');
  assert.equal(s.unit, 'S/m');
  assert.match(s.derived ?? '', /1 \/ rho_e/);
});

test('fits: Leviton-Frey reproduces their Table 4 (validates the 30 transcribed coefficients)', () => {
  const n = (lam: number, T: number): number => lib.getProperty('fused-silica', 'n', { lambda: lam * 1e-6, T, alternative: 'leviton_frey_corning7980' }).value as number;
  // arXiv p.7 Table 4: 1.5 um 295 K 1.44502; 0.6 um 300 K 1.45850; 2.0 um 30 K 1.43716; 1.0 um 200 K 1.45012
  for (const [lam, T, ref] of [[1.5, 295, 1.44502], [0.6, 300, 1.45850], [2.0, 30, 1.43716], [1.0, 200, 1.45012]] as const)
    assert.ok(Math.abs(n(lam, T) - ref) < 1.5e-5, `LF n(${lam} um, ${T} K) = ${n(lam, T)} vs ${ref}`);
});

test('fits: structural steel nu at room temperature matches the NCSTAR text value 0.288', () => {
  const nu = lib.getProperty('structural-steel', 'nu', { T: 293.15 }).value as number;
  assert.ok(Math.abs(nu - 0.288) < 5e-4, String(nu));
  close(lib.getProperty('structural-steel', 'E', { T: 273.15 }).value as number, 206.0e9, 1e-12); // e0 at 0 C
});

test('fits: Sellmeier forms (Malitson, Zelmon) give the transparent-range indices', () => {
  const ln = lib.getProperty('linbo3-congruent', 'n', { lambda: 1.957e-6 }); // L7b CR-5, CP-43
  const v = ln.value as Record<string, number>;
  assert.ok((v.perp as number) > (v.par as number)); // negative uniaxial (n_e < n_o)
  assert.ok((v.perp as number) > 2.1 && (v.perp as number) < 2.3 && (v.par as number) > 2.0 && (v.par as number) < 2.2);
  assert.equal(ln.symmetry, 'uniaxial');
  assert.deepEqual(ln.matrix, [[v.perp, 0, 0], [0, v.perp, 0], [0, 0, v.par]]);
  const fs = lib.getProperty('fused-silica', 'n', { lambda: 1.55e-6 }).value as number;
  assert.ok(fs > 1.44 && fs < 1.45);
  // Li 1980 (default) and Salzberg-Villa (alternative) agree within Li's +-2e-3 plus the 26 C vs 20 C offset
  const a = lib.getProperty('silicon', 'n', { lambda: 1.55e-6 }).value as number;
  const b = lib.getProperty('silicon', 'n', { lambda: 1.55e-6, alternative: 'salzberg_villa_tatian' }).value as number;
  assert.ok(Math.abs(a - b) < 4e-3, `${a} vs ${b}`);
});

test('secant CTE formula: continuous at T_ref, equals the derivative there', () => {
  const f = FORMULAS['nist-cryo-linexp-secant']!;
  const c = { a: [-412.77, -0.30389, 8.7696e-3, -9.9821e-6, 0], scale: 1e-5, T_ref: 293 };
  const at = f.evaluate({ T: 293 }, c), near = f.evaluate({ T: 293.001 }, c);
  assert.ok(Math.abs(at - near) < 1e-12 * 1e3, `${at} ${near}`);
  const r = lib.getProperty('aluminum-6061-t6', 'alpha', { T: 250 });
  assert.equal(r.cteKind, 'secant');
  assert.equal(r.T_ref, 293);
});

test('tensors: cubic Si stiffness (L7b CR-5), 3m EO tensor, components', () => {
  const C = lib.getProperty('silicon', 'C');
  assert.equal(C.unit, 'Pa');
  close((C.value as Record<string, number>).C11 as number, 165.64e9, 1e-12); // Hall Table III 1.6564e12 dyn/cm2
  assert.equal(C.matrix?.length, 6);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) assert.equal(C.matrix?.[i]?.[j], C.matrix?.[j]?.[i]);
  close(lib.getProperty('silicon', 'C', { component: 'C44' }).value as number, 79.51e9, 1e-12);
  const r = lib.getProperty('linbo3-congruent', 'r_eo');
  close((r.value as Record<string, number>).r33 as number, 30.8e-12, 1e-12);
  close(-(r.matrix?.[5]?.[0] as number), 3.4e-12, 1e-12);
  assert.equal(r.matrix?.[5]?.[1], 0);
  close(lib.getProperty('linbo3-congruent', 'eps_r', { alternative: 'unclamped', component: 'perp' }).value as number, 85.2, 1e-12);
  close(lib.getProperty('silicon', 'rho').value as number, 2329.0, 1e-12);
});

test('errors: N/A, out of range, missing variable, unknown names; extrapolation is flagged', () => {
  assert.throws(() => lib.getProperty('structural-steel', 'k'), MaterialNAError);
  assert.throws(() => lib.getProperty('copper', 'k', { T: 700 }), MaterialRangeError);
  assert.throws(() => lib.getProperty('copper', 'k'), /depends on T/);
  assert.throws(() => lib.getProperty('copper', 'nope'), /no property/);
  assert.throws(() => lib.getProperty('unobtainium', 'k'), /unknown material/);
  const x = lib.getProperty('copper', 'k', { T: 650, extrapolate: true });
  assert.equal(x.extrapolated, true);
});

test('result carries source, locator, basis, date', () => {
  const r = lib.getProperty('air', 'rho', { T: 293.15 });
  assert.match(r.source, /Lemmon/);
  assert.match(r.source, /doi:10\.1063\/1\.1285884/);
  assert.equal(r.basis, 'reference_correlation');
  assert.match(r.accessed, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.locator, /Table A2/);
});

test('validator rejects invented or incomplete entries', () => {
  const base = readFileSync(resolve(DEFAULT_MATERIALS_DIR, 'gold.yaml'), 'utf8');
  const bad1 = base.replace('missing: "no Poisson ratio for gold in the sources read (NIST solder DB Table 1.10 gives no shear modulus for gold)"', 'note: x');
  assert.ok(!parseMaterialText(bad1, 'gold').ok, 'N/A without missing');
  const bad2 = base.replace('    locator: "Table 1.10 row Gold 99.99', '    locatorX: "Table 1.10 row Gold 99.99');
  assert.ok(!parseMaterialText(bad2, 'gold').ok, 'unknown key');
  const bad3 = base.replace('unit: W/(cm*K)', 'unit: W/(cm*s)');
  assert.ok(parseMaterialText(bad3, 'gold').issues.some((i) => /dimension/.test(i.message)), 'wrong dimension');
  const bad4 = base.replace('source: hpl1972', 'source: nowhere');
  assert.ok(parseMaterialText(bad4, 'gold').issues.some((i) => /not in sources/.test(i.message)), 'unknown source');
  assert.ok(!parseMaterialText(base, 'golden').ok, 'id must match the file name');
});

test('listNA covers every N/A with its reason', () => {
  const na = lib.listNA();
  assert.ok(na.length > 0);
  for (const n of na) assert.ok(n.missing.length > 10, `${n.material}.${n.property}`);
  assert.ok(na.some((n) => n.material === 'pzt-4' && n.property === 'C'));
});

test('registry: property types (with scalar / tensor forms) supersede the provisional spec seed; sims/ outcomes unchanged', () => {
  const reg = wave1Registry();
  const done = registerMaterialProperties(reg);
  assert.ok(done.includes('E') && done.includes('C') && done.includes('r_eo'));
  for (const d of PROPERTY_DEFS) assert.equal(reg.get('property', d.name)?.owner, '@amp/materials');
  assert.deepEqual(registerMaterialProperties(reg), []); // idempotent
  assert.deepEqual(reg.get('property', 'C')?.tensor, { cubic: ['C11', 'C12', 'C44'] });
  assert.equal(reg.get('property', 'C')?.scalar, false);
  assert.deepEqual(reg.get('property', 'r_eo')?.tensor, { 'trigonal-3m': ['r13', 'r22', 'r33', 'r51'] });
  const sims = resolve(import.meta.dirname, '../../../sims');
  for (const f of readdirSync(sims).filter((x) => x.endsWith('.yaml'))) {
    // sims/ grows with other lanes' types; the materials registration must not change any outcome
    const text = readFileSync(resolve(sims, f), 'utf8');
    const r = parseSpecText(text, reg), r0 = parseSpecText(text, wave1Registry());
    assert.equal(r.ok, r0.ok, `${f}: ${JSON.stringify(r.issues?.slice(0, 2))}`);
    assert.deepEqual(r.issues.map((i) => i.message), r0.issues.map((i) => i.message), f);
  }
});

test('JSON Schema export', () => {
  const js = materialJsonSchema();
  assert.equal(js.title, 'amp-material/0');
  assert.ok(JSON.stringify(js).includes('"alternatives"'));
});

test('createLibrary rejects duplicate ids', () => {
  const d = lib.get('gold')!;
  assert.throws(() => createLibrary([d, d]), /duplicate/);
});

test('S1: single-number values carry a validity range; outside it throws unless extrapolate (flagged)', () => {
  assert.throws(() => lib.getProperty('gold', 'alpha', { T: 1000 }), MaterialRangeError);
  assert.equal(lib.getProperty('gold', 'alpha', { T: 1000, extrapolate: true }).extrapolated, true);
  assert.throws(() => lib.getProperty('fused-silica', 'alpha', { T: 600 }), MaterialRangeError);
  assert.equal(lib.getProperty('fused-silica', 'alpha', { T: 300 }).extrapolated, undefined); // 26.85 C inside 5-35 C
  assert.throws(() => lib.getProperty('silicon', 'C', { T: 1000 }), MaterialRangeError);
  assert.ok(lib.getProperty('silicon', 'C', { T: 298.15 }).value); // the measured 25 C point
  assert.throws(() => lib.getProperty('ptfe', 'eps_r', { f: 1e9 }), MaterialRangeError);
  assert.throws(() => lib.getProperty('linbo3-congruent', 'r_eo', { lambda: 1.55e-6 }), MaterialRangeError);
  const r = lib.getProperty('linbo3-congruent', 'r_eo', { lambda: 1.55e-6, extrapolate: true });
  assert.equal(r.extrapolated, true);
  // without the variable the value is returned with its validity attached
  assert.deepEqual(lib.getProperty('gold', 'alpha').valid?.T, { unit: 'degC', range: [20, 20] });
  // every non-N/A single-number leaf has `valid` (validator gate)
  for (const id of lib.ids()) for (const [p, l] of Object.entries(lib.get(id)!.properties))
    for (const x of [l, ...l.alternatives]) if (typeof x.value === 'number' || x.tensor) assert.ok(x.valid, `${id}.${p}`);
});

test('S2: refractive index is relative to vacuum at the vacuum wavelength; air-referenced data converted with air.n', () => {
  const nAir = lib.getProperty('air', 'n', { lambda: 1.55e-6 }).value as number;
  assert.ok(nAir > 1.00026 && nAir < 1.00029, String(nAir));
  const fs = lib.getProperty('fused-silica', 'n', { lambda: 1.55e-6 });
  assert.equal(fs.nMedium, 'air');
  close(fs.airIndex as number, nAir, 1e-15);
  // Malitson converted vs Leviton-Frey absolute at 20 C: agree to < 1e-5 (LF p.3 reports agreement 'well less than 1e-5')
  const lf = lib.getProperty('fused-silica', 'n', { lambda: 1.55e-6, T: 293.15, alternative: 'leviton_frey_corning7980' });
  assert.equal(lf.nMedium, 'vacuum');
  assert.ok(Math.abs((fs.value as number) - (lf.value as number)) < 1e-5, `${fs.value} vs ${lf.value}`);
  assert.equal(lib.getProperty('linbo3-congruent', 'n', { lambda: 1.55e-6 }).nMedium, 'unstated');
  // beyond the Ciddor range (1.69 um) the conversion is flagged
  assert.equal(lib.getProperty('silicon', 'n', { lambda: 1.957e-6 }).extrapolated, true);
  assert.throws(() => lib.getProperty('silicon', 'n', { lambda: 1.55e-6, T: 400 }), MaterialRangeError);
});

test('S3: fused-silica dn/dT is the derivative of the Leviton-Frey fit; Table 6 only at its nodes', () => {
  const d = lib.getProperty('fused-silica', 'dndT', { lambda: 1.5e-6, T: 295 });
  close(d.value as number, 8.2028e-6, 1e-4);
  close(d.uncertaintySI?.abs as number, 6.8e-7, 1e-12);
  // equals a numerical derivative of the n alternative
  const n = (T: number): number => lib.getProperty('fused-silica', 'n', { lambda: 1.5e-6, T, alternative: 'leviton_frey_corning7980' }).value as number;
  close(d.value as number, (n(296) - n(294)) / 2, 1e-3);
  close(lib.getProperty('fused-silica', 'dndT', { lambda: 1.5e-6, T: 295, alternative: 'table6_295k' }).value as number, 8.45e-6, 1e-12);
  assert.throws(() => lib.getProperty('fused-silica', 'dndT', { lambda: 1.55e-6, T: 295, alternative: 'table6_295k' }), /not interpolated/);
});

test('M2 / M3: range tolerance at the fit edge; uncertainty in SI', () => {
  assert.ok(lib.getProperty('linbo3-congruent', 'n', { lambda: 5e-6 }).value);
  close(lib.getProperty('silicon', 'rho').uncertaintySI?.abs as number, 0.2, 1e-9);
  close(lib.getProperty('silicon', 'C').uncertaintySI?.rel as number, 2e-4, 1e-12);
});
