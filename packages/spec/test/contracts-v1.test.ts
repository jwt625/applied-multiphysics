// SPDX-License-Identifier: GPL-3.0-or-later
// Contracts v1 (DevLog-003 s.9): field-valued settings, initial conditions and time studies, physics-scoped BC types,
// tensor overrides, basis vocabulary, material-ref checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecText, formatIssues } from '../src/yaml.ts';
import { wave1Registry } from '../src/provisional/wave1.ts';
import { resolveField } from '../src/quantity.ts';
import { fieldSymbols, specJsonSchema, BASIS, BASIS_DEFINITIONS } from '../src/schema.ts';
import { createOpLog } from '../src/oplog.ts';
import { BUILTIN_SCOPE } from '../src/validate.ts';
import { readHero } from './heroes.ts';

const reg = wave1Registry();
const HEAT = readHero('heat-plate-fin');
const KIRSCH = readHero('kirsch-plate');
function edit(text: string, from: string, to: string): string {
  const i = text.indexOf(from);
  assert.ok(i >= 0 && text.indexOf(from, i + 1) < 0, `fixture substring not unique: ${from}`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}
const issues = (t: string, r = reg) => parseSpecText(t, r).issues;
const msgs = (t: string, r = reg) => formatIssues(issues(t, r));

const TIME_STUDY = '  - {id: std1, type: stationary, physics: [ht]}\n  - {id: tr, type: time, physics: [ht], settings: {start: "0 s", stop: "40 s", dt: "0.5 s", method: bdf2}}\n';
const HEAT_T = (t: string) => edit(edit(HEAT, 'settings: {T: "100 degC"}', `settings: {T: ${t}}`), '  - {id: std1, type: stationary, physics: [ht]}\n', TIME_STUDY);

test('field-valued BC: HT-02 style time expression in degC, and space expressions', () => {
  // HT-02: T(0.1 m, t) = 100 sin(pi t / 40 s) degC
  const ht02 = HEAT_T('{expr: "100*sin(pi*t/(40[s]))", unit: degC}');
  assert.deepEqual(issues(ht02), [], msgs(ht02));
  assert.deepEqual(issues(HEAT_T('"273.15[K] + 100[K]*sin(pi*t/(40[s]))"')), []);
  assert.deepEqual(issues(HEAT_T('"373.15[K] - x*10[K/m]"')), [], 'space expression in x');
  // dimension checks
  assert.match(msgs(HEAT_T('"100*sin(pi*t/(40[s]))"')), /expected a quantity in K, got 1/);
  assert.match(msgs(HEAT_T('"373[K]*sin(t)"')), /dimension|dimensionless|unit/i);
  assert.match(msgs(HEAT_T('{expr: "x", unit: degC}')), /affine unit degC needs a dimensionless expression, got m/);
  // geometry decides the space symbols (2d: x, y), plus t
  assert.match(msgs(HEAT_T('"300[K] + r*1[K/m]"')), /'r' not available here \(allowed: x, y, t; geometry 2d\)/);
  // bounds apply to constant values only
  assert.match(msgs(HEAT_T('"-1 K"')), /must be >= 0 K/);
  // a constant quantity field (no symbols) keeps the old behaviour
  assert.deepEqual(issues(HEAT), []);
  // SM-01 style exact traction: vector of expressions in x, y (Pa)
  const kt = edit(KIRSCH, 'traction: ["sigma_inf", "0 Pa"]', 'traction: ["sigma_inf*(1 - (D/2)^2/(x^2 + y^2))", "0 Pa"]');
  assert.deepEqual(issues(kt), [], msgs(kt));
  // constant-only settings still refuse symbols
  assert.match(msgs(edit(KIRSCH, 'radius: "D/2"', 'radius: "x"')), /unknown variable 'x'/);
});

test('resolveField: constant vs varying, SI values', () => {
  const scope = BUILTIN_SCOPE;
  const r = resolveField({ expr: '100*sin(pi*t/(40[s]))', unit: 'degC' }, scope, fieldSymbols('time'));
  assert.equal(r.na, false);
  assert.equal((r as { si: number | null }).si, null, 'varies in time');
  const c = resolveField({ expr: '2*3', unit: 'degC' }, scope, fieldSymbols('time'));
  assert.ok(Math.abs((c as { si: number }).si - 279.15) < 1e-9);
  assert.deepEqual([...fieldSymbols('spacetime', '2d-axisym').keys()], ['r', 'z', 't']);
  assert.deepEqual([...fieldSymbols('space', '3d').keys()], ['x', 'y', 'z']);
});

test('initial condition T0 (space only) and time-study settings', () => {
  const withT0 = (t0: string) => edit(HEAT_T('"100 degC"'), '    select: ["dom:plate"]\n    bcs:', `    select: ["dom:plate"]\n    settings: {T0: ${t0}}\n    bcs:`);
  assert.deepEqual(issues(withT0('"0 degC"')), []);
  assert.deepEqual(issues(withT0('"273.15[K] + y*1[K/m]"')), []);
  assert.match(msgs(withT0('"273.15[K] + t*1[K/s]"')), /'t' not available here \(allowed: x, y/);
  const study = (s: string) => edit(HEAT, '  - {id: std1, type: stationary, physics: [ht]}\n', `  - {id: std1, type: stationary, physics: [ht]}\n  - {id: tr, type: time, physics: [ht], settings: {${s}}}\n`);
  assert.deepEqual(issues(study('start: "0 s", stop: "40 s", dt: "0.5 s", method: bdf2, output: ["10 s", "32 s"]')), []);
  assert.match(msgs(study('start: "0 s", stop: "40 s", dt: "0.5 s"')), /missing required key 'method'/);
  assert.match(msgs(study('start: "0 s", stop: "40 s", dt: "0.5 s", method: euler')), /method/);
  assert.match(msgs(study('start: "40 s", stop: "0 s", dt: "0.5 s", method: bdf1')), /stop must be after start/);
  assert.match(msgs(study('start: "0 s", stop: "1 s", dt: "2 s", method: bdf1')), /dt is longer than the time range/);
  assert.match(msgs(study('start: "0 s", stop: "1 s", dt: "0 s", method: bdf1')), /must be > 0 s/);
  assert.match(msgs(study('start: "0 s", stop: "1 s", dt: "0.1 s", method: bdf1, output: ["2 s"]')), /output time outside/);
});

test('x, y, z, r, t are reserved param names', () => {
  for (const n of ['x', 'y', 'z', 'r', 't']) assert.match(msgs(edit(HEAT, '  Lx: {value: 0.6, unit: m, description: plate width}', `  Lx: {value: 0.6, unit: m, description: plate width}\n  ${n}: {value: 1, unit: m}`)), /is reserved/);
});

test('physics-scoped BC types: one name, separate registrations; errors name the physics', () => {
  assert.ok(reg.getBc('acoustics', 'pressure') && reg.getBc('elastic', 'pressure'));
  assert.notEqual(reg.getBc('acoustics', 'pressure'), reg.getBc('elastic', 'pressure'));
  assert.equal(reg.getBc('heat', 'pressure'), undefined);
  assert.equal(reg.get('bc', 'pressure'), undefined, 'ambiguous name via get()');
  assert.equal(reg.get('bc', 'convection')?.type, 'convection');
  const elastic = edit(KIRSCH, '{id: tension, type: boundary-load, select: ["bnd:quarter.right"], settings: {traction: ["sigma_inf", "0 Pa"]}}', '{id: tension, type: pressure, select: ["bnd:quarter.right"], settings: {p: "-1 MPa"}}');
  assert.deepEqual(issues(elastic), []);
  const heatP = edit(HEAT, '{id: adiabatic, type: insulation,', '{id: adiabatic, type: pressure,');
  const m = issues(heatP)[0]!.message;
  assert.match(m, /unknown bc type 'pressure' for physics type 'heat' \(registered there: convection, heat-flux, heat-source, insulation, surface-radiation, temperature\) \[physics 'ht'\]/);
  // replace for one physics leaves the other
  const r2 = wave1Registry();
  r2.register({ kind: 'bc', type: 'pressure', for: ['elastic'], select: ['bnd'], description: 'L4 normal pressure' }, { replace: true });
  assert.equal(r2.getBc('elastic', 'pressure')?.description, 'L4 normal pressure');
  assert.equal(r2.getBc('acoustics', 'pressure')?.description, 'Acoustic pressure p on the boundary');
  assert.throws(() => r2.register({ kind: 'bc', type: 'pressure', for: ['acoustics', 'heat'], select: ['bnd'] }), /already registered for physics 'acoustics'/);
  // a '*' registration applies to every physics, a specific one shadows it
  r2.register({ kind: 'bc', type: 'note', for: ['*'], select: ['bnd'] });
  assert.ok(r2.getBc('heat', 'note') && r2.bcsFor('acoustics').some((b) => b.type === 'note'));
  assert.ok(JSON.stringify(specJsonSchema(r2)).includes('Bc_elastic_pressure'));
});

test('tensor overrides: forms registered by the materials package, validated per symmetry', () => {
  const r = wave1Registry();
  r.register({ kind: 'property', type: 'C', unit: 'Pa', scalar: false, tensor: { cubic: ['C11', 'C12', 'C44'] }, description: 'stiffness, Voigt' });
  r.register({ kind: 'property', type: 'eps_r', unit: '1', tensor: { uniaxial: ['perp', 'par'] } }, { replace: true });
  const mat = (o: string) => edit(KIRSCH, '{id: steel, ref: materials/structural-steel, select: ["dom:plate"]}', `{id: steel, ref: materials/structural-steel, override: ${o}, select: ["dom:plate"]}`);
  assert.deepEqual(issues(mat('{C: {symmetry: cubic, components: {C11: "165.7 GPa", C12: "63.9 GPa", C44: "79.6 GPa"}}}'), r), []);
  assert.deepEqual(issues(mat('{C: {symmetry: cubic, unit: GPa, components: {C11: 165.7, C12: 63.9, C44: 79.6}}}'), r), []);
  assert.deepEqual(issues(mat('{eps_r: {symmetry: uniaxial, components: {perp: 9.3, par: 11.5}}}'), r), []);
  assert.deepEqual(issues(mat('{eps_r: 3.9}'), r), [], 'scalar form still allowed');
  assert.match(msgs(mat('{C: "200 GPa"}'), r), /C/);
  assert.match(msgs(mat('{C: {symmetry: cubic, components: {C11: 165.7, C12: 63.9, C44: 79.6}}}'), r), /needs the tensor 'unit'/);
  assert.match(msgs(mat('{C: {symmetry: cubic, unit: K, components: {C11: 1, C12: 1, C44: 1}}}'), r), /expected a quantity in Pa/);
  assert.match(msgs(mat('{C: {symmetry: cubic, components: {C11: "1 GPa", C12: "1 GPa"}}}'), r), /C44/);
  assert.match(msgs(mat('{C: {symmetry: hexagonal, components: {C11: "1 GPa"}}}'), r), /symmetry|Invalid/);
  assert.match(msgs(mat('{C: {symmetry: cubic, components: {C11: "1 GPa", C12: N/A, C44: "1 GPa"}}}'), r), /needs a missing entry with path 'materials.steel.override.C.components.C12'/);
  assert.ok(JSON.stringify(specJsonSchema(r)).includes('Tensor_C_cubic'));
});

test('basis vocabulary has definitions, including paper_model_input and reference_correlation', () => {
  for (const b of ['paper_model_input', 'reference_correlation']) assert.ok(BASIS.includes(b as never) && BASIS_DEFINITIONS[b as keyof typeof BASIS_DEFINITIONS].length > 10);
  assert.equal(BASIS.length, Object.keys(BASIS_DEFINITIONS).length);
  assert.deepEqual(issues(edit(HEAT, 'params.Ly: {basis: benchmark,', 'params.Ly: {basis: reference_correlation,')), []);
  assert.ok(JSON.stringify(specJsonSchema(reg)).includes('paper_model_input: value a paper states'));
});

test('materials/<id> refs are checked against an injected library index', async () => {
  const lib = { ids: () => ['air', 'copper', 'silicon'] };
  const coil = readHero('helmholtz-coil');
  assert.deepEqual(parseSpecText(coil, reg, { materials: lib }).issues, []);
  const k = parseSpecText(KIRSCH, reg, { materials: lib });
  assert.deepEqual(k.issues.map((i) => `${i.code} ${i.dotted}`), ['unknown_material materials.0.ref']);
  assert.deepEqual(parseSpecText(KIRSCH, reg).issues, [], 'no library: refs not checked');
  const log = await createOpLog(KIRSCH, { registry: reg, validateOptions: { materials: lib } });
  const op = await log.apply([{ op: 'replace', path: '/materials/0/ref', value: 'materials/copper' }], { actor: 'user' });
  assert.equal(op.validation.ok, true);
});
