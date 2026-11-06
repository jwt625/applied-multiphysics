// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as z from 'zod';
import { parseSpecText, formatIssues } from '../src/yaml.ts';
import { validateSpec, resolveDotted } from '../src/validate.ts';
import { specJsonSchema, quantity, SpecSchema, type Spec } from '../src/schema.ts';
import { createRegistry } from '../src/registry.ts';
import { wave1Registry, WAVE1 } from '../src/provisional/wave1.ts';
import { resolveQuantity, classifyString } from '../src/quantity.ts';
import { checkSelections, resolveSelection } from '../src/selection.ts';

const SIMS = new URL('../../../sims/', import.meta.url);
const HEROES = ['kirsch-plate', 'heat-plate-fin', 'helmholtz-coil', 'si-rib-waveguide', 'cylinder-cavity', 'box-acoustics'];
const reg = wave1Registry();
const read = (id: string) => readFileSync(new URL(`${id}.yaml`, SIMS), 'utf8');
const KIRSCH = read('kirsch-plate');

/** Replace one exact substring (must occur once). */
function edit(text: string, from: string, to: string): string {
  const i = text.indexOf(from);
  assert.ok(i >= 0 && text.indexOf(from, i + 1) < 0, `fixture substring not unique: ${from}`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}
const codes = (text: string) => parseSpecText(text, reg).issues.map((i) => `${i.code} ${i.dotted}`);

test('all six hero examples validate', () => {
  const files = readdirSync(SIMS).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(files, [...HEROES].sort());
  for (const id of HEROES) {
    const r = parseSpecText(read(id), reg);
    assert.ok(r.ok, `${id}:\n${formatIssues(r.issues)}`);
    assert.equal(r.spec?.id, id);
  }
});

test('every material value in the examples is a materials/ ref or N/A covered by missing', () => {
  for (const id of HEROES) {
    const r = parseSpecText(read(id), reg);
    for (const m of r.spec!.materials ?? []) {
      for (const [k, v] of Object.entries(m.override ?? {})) {
        const na = v === 'N/A' || (typeof v === 'object' && v !== null && (v as { value: unknown }).value === 'N/A');
        assert.ok(na, `${id} materials.${m.id}.override.${k} is not N/A`);
      }
      if (m.ref) assert.ok((r.spec!.missing ?? []).some((x) => typeof x !== 'string' && x.path === `materials.${m.id}.ref`), `${id}: ref ${m.ref} without a missing entry`);
    }
  }
});

test('unknown keys are rejected at every level, with line and column', () => {
  const top = parseSpecText(edit(KIRSCH, 'title: Plate with a hole', 'title: Plate with a hole\ncolour: red'), reg);
  assert.equal(top.ok, false);
  const i0 = top.issues.find((i) => i.code === 'unknown_key');
  assert.equal(i0?.dotted, 'colour');
  assert.equal(i0?.line, 6);
  assert.equal(i0?.col, 1);
  assert.match(i0!.message, /unknown key 'colour' \(allowed: schema, id, title/);
  assert.deepEqual(codes(edit(KIRSCH, 'settings: {model: plane-stress}', 'settings: {model: plane-stress, thikness: "1 mm"}')), ['unknown_key physics.0.settings.thikness']);
  assert.deepEqual(codes(edit(KIRSCH, '{id: sym_x, type: roller,', '{id: sym_x, type: roller, value: 1,')), ['unknown_key physics.0.bcs.0.value']);
  assert.deepEqual(codes(edit(KIRSCH, 'size: {hmax: "W/40"}', 'size: {hmax: "W/40", hmn: "1 mm"}')), ['unknown_key mesh.size.hmn']);
  assert.deepEqual(codes(edit(KIRSCH, 'params.W: {basis: user,', 'params.W: {basis: user, confidence: high,')), ['unknown_key provenance.values.params.W.confidence']);
  assert.deepEqual(codes(edit(KIRSCH, '{id: steel, ref:', '{id: steel, override: {Youngs: "200 GPa"}, ref:')), ['unknown_key materials.0.override.Youngs']);
});

test('unitless dimensional values are rejected; dimensionless ones accepted', () => {
  assert.deepEqual(codes(edit(KIRSCH, 'size: {hmax: "W/40"}', 'size: {hmax: 5}')), ['quantity mesh.size.hmax']);
  const r = parseSpecText(edit(KIRSCH, 'radius: "D/2"', 'radius: 5'), reg);
  assert.match(r.issues[0]!.message, /unitless value 5 for a quantity in m/);
  assert.deepEqual(codes(edit(KIRSCH, 'traction: ["sigma_inf", "0 Pa"]', 'traction: ["sigma_inf", 0]')), ['quantity physics.0.bcs.2.settings.traction.1']);
  assert.deepEqual(codes(edit(KIRSCH, '{value: [0, 0], unit: mm}', '[0, 0]')), ['quantity geometry.features.1.settings.center.0', 'quantity geometry.features.1.settings.center.1']);
  // dimensionless quantity (refine grading) takes a bare number
  assert.deepEqual(codes(edit(KIRSCH, 'size: {hmax: "W/40"}', 'size: {hmax: "W/40", grading: 1.3}')), []);
});

test('dimension mismatches, unknown params and N/A coverage are reported', () => {
  assert.match(parseSpecText(edit(KIRSCH, 'radius: "D/2"', 'radius: "2 MPa"'), reg).issues[0]!.message, /expected a quantity in m, got Pa/);
  assert.match(parseSpecText(edit(KIRSCH, 'radius: "D/2"', 'radius: "D*D"'), reg).issues[0]!.message, /expected a quantity in m, got m\^2/);
  assert.match(parseSpecText(edit(KIRSCH, 'radius: "D/2"', 'radius: "Dx/2"'), reg).issues[0]!.message, /unknown variable 'Dx'/);
  assert.match(parseSpecText(edit(KIRSCH, 'radius: "D/2"', 'radius: "D + 1"'), reg).issues[0]!.message, /incompatible units/);
  assert.deepEqual(codes(edit(KIRSCH, 'radius: "D/2"', 'radius: N/A')), ['na_without_missing geometry.features.1.settings.radius']);
  assert.deepEqual(codes(edit(KIRSCH, 'radius: "D/2"', 'radius: N/A}}\n    # x\n    - {id: dummy, type: rect, settings: {size: ["1 mm", "1 mm"], center: ["0 mm", "0 mm"]').replace('missing:\n', 'missing:\n  - {path: geometry.features.hole.settings.radius, what: radius}\n')), []);
  assert.deepEqual(codes(edit(KIRSCH, 'sigma_inf: {value: 1, unit: MPa,', 'sigma_inf: {value: 1, unit: MPx,')), ['custom params.sigma_inf.unit'], 'no cascade into expressions that use the param');
  assert.ok(codes(edit(KIRSCH, 'D: {value: 10, unit: mm,', 'D: {value: "W/20 + D",')).some((c) => c.startsWith('param_cycle')));
  assert.ok(codes(edit(KIRSCH, 'D: {value: 10, unit: mm, range: [1, 10]', 'D: {value: 12, unit: mm, range: [1, 10]')).includes('param_range params.D.value'));
});

test('selections: entity grammar, kinds per node type, feature existence, material overlap, duplicate ids', () => {
  assert.deepEqual(codes(edit(KIRSCH, 'select: ["bnd:quarter.left"]', 'select: ["dom:quarter"]')), ['custom physics.0.bcs.0.select.0']);
  assert.deepEqual(codes(edit(KIRSCH, 'select: ["bnd:quarter.left"]', 'select: ["bnd:quater.left"]')), ['unknown_feature physics.0.bcs.0.select.0']);
  assert.deepEqual(codes(edit(KIRSCH, 'select: ["bnd:quarter.left"]', 'select: ["quarter.left"]')), ['invalid_format physics.0.bcs.0.select.0']);
  assert.deepEqual(codes(edit(KIRSCH, '{id: steel, ref: materials/structural-steel, select: ["dom:plate"]}', '{id: steel, ref: materials/structural-steel, select: ["dom:plate"]}\n  - {id: alu, ref: materials/aluminum, select: ["dom:plate#1"]}')), ['material_overlap materials.1.select.0']);
  assert.deepEqual(codes(edit(KIRSCH, '{id: sym_y,', '{id: sym_x,')), ['duplicate_id physics.0.bcs.1.id']);
  assert.deepEqual(codes(edit(KIRSCH, 'tools: [hole]', 'tools: [hole2]')), ['unknown_feature geometry.features.2.settings.tools.0']);
  assert.deepEqual(codes(edit(KIRSCH, '{id: std1, type: stationary, physics: [solid]}', '{id: std1, type: stationary, physics: [solid2]}')), ['unknown_physics studies.0.physics.0']);
  assert.deepEqual(codes(edit(KIRSCH, 'data: std1, expr: solid.sxx', 'data: std2, expr: solid.sxx')), ['unknown_study results.0.data']);
});

test('registry: unknown types are named, physics vs geometry dimension checked, new types need no core edit', () => {
  const r = parseSpecText(edit(KIRSCH, 'type: elastic', 'type: elasticity'), reg);
  assert.match(r.issues[0]!.message, /unknown physics type 'elasticity' \(registered: acoustics, elastic, em-modes/);
  assert.deepEqual(codes(edit(KIRSCH, 'type: elastic', 'type: em-modes').replace(/      - \{id: (sym_x|sym_y|tension|open).*\n/g, '').replace('    settings: {model: plane-stress}\n', '').replace('    bcs:\n', '')), []);
  const d3 = codes(edit(KIRSCH, 'dim: 2', 'dim: 3'));
  assert.deepEqual(d3.filter((c) => c.startsWith('space_dim')), ['space_dim geometry.features.0.type', 'space_dim geometry.features.1.type']);
  assert.ok(d3.includes('check physics.0.settings.model'), 'registration check hook runs');
  // a physics package registers a new physics + bc without touching core files
  const mine = wave1Registry();
  mine.register({ kind: 'physics', type: 'electrostatics', dims: ['2d'], settings: z.strictObject({ eps0Scale: quantity('1').optional() }) });
  mine.register({ kind: 'bc', type: 'potential', for: ['electrostatics'], select: ['bnd'], settings: z.strictObject({ V: quantity('V') }) });
  const es = KIRSCH.replace(/physics:\n[\s\S]*?\nmesh:/, 'physics:\n  - id: es\n    type: electrostatics\n    select: ["dom:plate"]\n    bcs:\n      - {id: v1, type: potential, select: ["bnd:hole.edge"], settings: {V: "1 kV"}}\nmesh:').replace('physics: [solid]', 'physics: [es]').replace(/solid\.sxx/g, 'es.V');
  const ok = parseSpecText(es, mine);
  assert.ok(ok.ok, formatIssues(ok.issues));
  assert.deepEqual(parseSpecText(es.replace('"1 kV"', '"1 A"'), mine).issues.map((i) => i.dotted), ['physics.0.bcs.0.settings.V']);
  assert.equal(parseSpecText(es, reg).ok, false, 'the default registry does not know electrostatics');
  assert.throws(() => mine.register({ kind: 'physics', type: 'heat' }), /already registered/);
  mine.register({ kind: 'physics', type: 'heat', dims: ['2d'] }, { replace: true });
  assert.ok(WAVE1.every((r) => r.provisional));
});

test('YAML level: syntax errors, duplicate keys, anchors and aliases carry positions', () => {
  const dup = parseSpecText(edit(KIRSCH, 'id: kirsch-plate', 'id: kirsch-plate\nid: again'), reg);
  assert.equal(dup.issues[0]?.code, 'yaml');
  assert.equal(dup.issues[0]?.line, 5);
  const alias = parseSpecText(edit(KIRSCH, 'W: {value: 200, unit: mm,', 'W: &w {value: 200, unit: mm,').replace('sigma_inf: {value: 1, unit: MPa, description: remote uniaxial tension}', 'sigma_inf: *w'), reg);
  assert.ok(alias.issues.some((i) => /anchors are not allowed/.test(i.message)));
  assert.ok(alias.issues.some((i) => /aliases are not allowed/.test(i.message)));
  const syn = parseSpecText('schema: amp-spec/0\nid: [unclosed\n', reg);
  assert.equal(syn.ok, false);
  assert.ok(syn.issues[0]?.line);
});

test('quantity forms resolve to SI', () => {
  const scope = new Map([['a', { si: 5e-3, dim: [1, 0, 0, 0, 0] }]]);
  const si = (q: unknown) => { const r = resolveQuantity(q, scope); assert.equal(r.na, false); return (r as { si: number }).si; };
  assert.equal(si('5 mm'), 5e-3);
  assert.equal(si({ value: 5, unit: 'mm' }), 5e-3);
  assert.equal(si('2*a'), 1e-2);
  assert.ok(Math.abs(si('2[mm] + a') - 7e-3) < 1e-18);
  assert.ok(Math.abs(si('100 degC') - 373.15) < 1e-9);
  assert.equal(si('2.4 GHz'), 2.4e9);
  assert.equal(resolveQuantity('N/A', scope).na, true);
  assert.equal(classifyString('2*a').kind, 'expr');
  assert.equal(classifyString('750 W/(m^2*K)').kind, 'literal');
  assert.throws(() => resolveQuantity({ value: '2*a', unit: 'mm' }, scope), /takes a number or "N\/A"/);
  assert.throws(() => resolveQuantity('2[degC]', scope), /affine units/);
});

test('provenance and dotted paths resolve by index or element id', () => {
  const r = parseSpecText(read('heat-plate-fin'), reg);
  assert.deepEqual(resolveDotted(r.data, 'physics.ht.bcs.film.settings.h'), ['physics', 0, 'bcs', 2, 'settings', 'h']);
  assert.deepEqual(resolveDotted(r.data, 'physics.0.bcs.2.settings.h'), ['physics', 0, 'bcs', 2, 'settings', 'h']);
  assert.equal(resolveDotted(r.data, 'physics.ht.bcs.nope'), null);
  assert.deepEqual(codes(edit(read('heat-plate-fin'), 'params.Lx: {basis', 'params.Lz: {basis')), ['unresolved_path provenance.values.params.Lz']);
});

test('JSON Schema export: one generated schema, dimensional quantities exclude bare numbers', () => {
  const js = specJsonSchema(reg) as { $defs?: Record<string, { anyOf?: { type?: string }[]; 'x-amp-quantity'?: string }>; properties?: Record<string, unknown> };
  const text = JSON.stringify(js);
  assert.ok(text.length > 1000);
  const defs = js.$defs ?? {};
  const qm = defs['Quantity_m'];
  assert.ok(qm, 'Quantity_m in $defs');
  assert.ok(!qm.anyOf?.some((b) => b.type === 'number'), 'length quantity admits no bare number');
  assert.ok(defs['Quantity_1']?.anyOf?.some((b) => b.type === 'number'), 'dimensionless quantity admits a number');
  assert.ok(text.includes('"x-amp-selection"'));
  assert.ok(text.includes('"additionalProperties":false'));
  for (const t of ['elastic', 'heat', 'magnetostatics', 'em-modes', 'emw', 'acoustics']) assert.ok(text.includes(`"const":"${t}"`), t);
  // the empty registry still exports (registered parts fail closed)
  assert.ok(JSON.stringify(specJsonSchema(createRegistry())).length > 500);
});

test('static types come from the same schema (generic form)', () => {
  const r = SpecSchema.safeParse(parseSpecText(KIRSCH, reg).data);
  assert.ok(r.success);
  const s: Spec = r.data;
  const bc = s.physics?.[0]?.bcs?.[0];
  assert.equal(bc?.type, 'roller');
  assert.equal(validateSpec(s, reg).ok, true);
});

test('selections resolve against a built entity table (split parts, unknown ids)', () => {
  const table = { domains: [{ id: 'dom:plate#0', parent: ['dom:plate'] }, { id: 'dom:plate#1', parent: ['dom:plate'] }], boundaries: [{ id: 'bnd:quarter.left' }, { id: 'bnd:quarter.right' }] };
  assert.deepEqual(resolveSelection(['dom:plate'], table).indices, [0, 1]);
  assert.deepEqual(resolveSelection(['dom:plate#1'], table).indices, [1]);
  assert.deepEqual(resolveSelection(['bnd:quarter.top'], table).unknown, ['bnd:quarter.top']);
  const spec = parseSpecText(KIRSCH, reg).spec!;
  const missing = checkSelections(spec, table).map((i) => i.dotted);
  assert.ok(missing.includes('physics.0.bcs.1.select.0'));
  assert.ok(!missing.includes('physics.0.bcs.0.select.0'));
});
