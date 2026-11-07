// SPDX-License-Identifier: GPL-3.0-or-later
// Results model (DevLog-025, CONTRACTS C10): schema per node type, cross-reference checks, the expression vocabulary,
// schema_at per type, the operation round trip (add, edit, remove, revert, replay) per type, and the reader helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../src/validate.ts';
import { specJsonSchema, schemaAt } from '../src/schema.ts';
import { wave1Registry } from '../src/provisional/wave1.ts';
import { createOpLog, replayJSONL } from '../src/oplog.ts';
import { parseStrict } from '../src/yaml-edit.mjs';
import { getAt, keysOf, type JsonPatchOp } from '../src/patch.ts';
import { checkSelections } from '../src/selection.ts';
import {
  DATASET_TYPES, EVAL_ITEM_TYPES, PLOT_GROUP_TYPES, PLOT_ITEM_TYPES, resultNodes, headlineItems, surfaceItems, resultUnits,
  resultNodeHash, changedResultNodes, rewriteDerivatives, symbolsFor, runId, artifactKey,
} from '../src/results.ts';
import { readHero } from './heroes.ts';

const reg = wave1Registry();
type O = Record<string, any>;
const TEXT = { kirsch: readHero('kirsch-plate'), box: readHero('box-acoustics'), coil: readHero('helmholtz-coil'), fin: readHero('heat-plate-fin') };
const dataOf = (t: string): O => parseStrict(t).toJS() as O;
const issuesOf = (d: unknown) => validateSpec(d, reg).issues.filter((i) => i.severity !== 'notice');
const codes = (d: unknown) => issuesOf(d).map((i) => `${i.code} ${i.dotted}`);
const user = { actor: 'user' as const };
let tick = 0;
const clock = () => `2026-11-06T23:00:${String(tick++ % 60).padStart(2, '0')}.000-08:00`;

// setup nodes the samples read (added first, through the op log)
const SETUP: Record<string, JsonPatchOp[]> = {
  cp: [{ op: 'add', path: '/results/datasets/-', value: { id: 'n_cp', type: 'cutpoint', data: 'sol_std1', points: [['D/2', '0 mm'], ['W/4', 'W/4']] } }],
  cl: [{ op: 'add', path: '/results/datasets/-', value: { id: 'n_cl', type: 'cutline', data: 'sol_std1', from: ['0 mm', 'D/2'], to: ['0 mm', 'W/2'], n: 200 } }],
  edge: [{ op: 'add', path: '/results/datasets/-', value: { id: 'n_edge', type: 'edge', data: 'sol_std1', select: ['bnd:hole.edge'] } }],
  tbl: [{ op: 'add', path: '/results/tables', value: [{ id: 'n_tbl0', from: 'ev_std1' }] }],
  p1: [{ op: 'add', path: '/results/plots/-', value: { id: 'n_p1g', type: 'plot1d', items: [] } }],
};

interface Sample { name: string; base: keyof typeof TEXT; setup?: Array<keyof typeof SETUP>; at: string; node: O; type: string; edit?: [string, unknown] }
const ds = (base: Sample['base'], node: O, setup: Sample['setup'] = []): Sample => ({ name: `dataset ${node.type}`, base, setup, at: '/results/datasets/-', node, type: node.type });
const ev = (node: O, setup: Sample['setup'] = []): Sample => ({ name: `evaluation ${node.type}`, base: 'kirsch', setup, at: '/results/evaluations/@ev_std1/items/-', node, type: node.type });
const pi = (g: '1d' | '2d' | '3d', node: O, setup: Sample['setup'] = []): Sample => ({
  name: `plot${g} ${node.type}`, base: g === '3d' ? 'box' : 'kirsch', setup: g === '1d' ? ['p1', ...setup] : setup,
  at: g === '1d' ? '/results/plots/@n_p1g/items/-' : g === '2d' ? '/results/plots/@sxx/items/-' : '/results/plots/@p_mode/items/-', node, type: node.type,
});
const SAMPLES: Sample[] = [
  ds('kirsch', { id: 'n_sol', type: 'solution', data: 'std1', steps: 'last' }),
  ds('kirsch', { id: 'n_cp', type: 'cutpoint', data: 'sol_std1', points: [['D/2', '0 mm'], ['W/4', 'W/4']] }),
  ds('kirsch', { id: 'n_cl', type: 'cutline', data: 'sol_std1', from: ['0 mm', 'D/2'], to: ['0 mm', 'W/2'], n: 200 }),
  ds('kirsch', { id: 'n_edge', type: 'edge', data: 'sol_std1', select: ['bnd:hole.edge'] }),
  ds('box', { id: 'n_cpl', type: 'cutplane', data: 'sol_eig', point: ['Lx/2', 'Ly/2', 'Lz/2'], normal: [0, 0, 1], offsets: ['0.1 m'] }),
  ds('coil', { id: 'n_rev', type: 'revolve', data: 'sol_std1', sweep: '270 deg', layers: 64 }),
  ds('kirsch', { id: 'n_mir', type: 'mirror', data: 'sol_std1', planes: [{ normal: [1, 0] }, { normal: [0, 1] }], parity: { 'solid.sxy': [-1, -1] } }),
  ds('kirsch', { id: 'n_join', type: 'join', a: 'sol_std1', b: 'sol_std1', op: 'difference' }),
  { name: 'evaluation group', base: 'kirsch', at: '/results/evaluations/-', node: { id: 'n_evg', data: 'sol_std1', items: [{ id: 'n_evg_g', type: 'global', expr: 'sigma_inf', unit: 'MPa' }] }, type: 'group' },
  ev({ id: 'n_pt', type: 'point', data: 'n_cp', expr: 'solid.mises', unit: 'MPa' }, ['cp']),
  ev({ id: 'n_gl', type: 'global', expr: 'solid.mises_max', unit: 'MPa' }),
  ev({ id: 'n_int', type: 'integral', data: 'n_cl', expr: 'solid.sxx', unit: 'N/m' }, ['cl']),
  ev({ id: 'n_avg', type: 'average', expr: 'solid.sxx', unit: 'MPa', over: ['dom:plate'] }),
  ev({ id: 'n_max', type: 'max', expr: 'solid.mises', unit: 'MPa', over: ['dom:plate'], method: 'quad' }),
  ev({ id: 'n_min', type: 'min', data: 'n_edge', expr: 'solid.sxx', unit: 'MPa', method: 'points' }, ['edge']),
  ev({ id: 'n_meas', type: 'measure', over: ['dom:plate'], unit: 'mm^2' }),
  { name: 'table', base: 'kirsch', at: '/results/tables', node: [{ id: 'n_tbl', from: 'ev_std1', orient: 'columns' }] as unknown as O, type: 'table', edit: ['/results/tables/@n_tbl/orient', 'rows'] },
  { name: 'plot group plot1d', base: 'kirsch', setup: ['cl'], at: '/results/plots/-', node: { id: 'n_p1', type: 'plot1d', items: [{ id: 'n_lg', type: 'linegraph', data: 'n_cl', x: 'y', expr: 'solid.sxx', unit: 'MPa' }] }, type: 'plot1d' },
  { name: 'plot group plot2d', base: 'kirsch', at: '/results/plots/-', node: { id: 'n_p2', type: 'plot2d', data: 'sol_std1', items: [{ id: 'n_p2s', type: 'surface', expr: 'solid.mises', unit: 'MPa', range: { rule: 'full' }, colormap: 'auto' }] }, type: 'plot2d' },
  { name: 'plot group plot3d', base: 'box', at: '/results/plots/-', node: { id: 'n_p3', type: 'plot3d', data: 'sol_eig', steps: 0, items: [{ id: 'n_p3s', type: 'surface', expr: 'ac.p', unit: 'Pa' }] }, type: 'plot3d' },
  pi('1d', { id: 'n_lg', type: 'linegraph', data: 'n_cl', x: 'arc', expr: 'sigma_inf*(1 + (D/2)^2/(2*y^2) + 1.5*(D/2)^4/y^4)', unit: 'MPa', label: 'Kirsch exact' }, ['cl']),
  pi('1d', { id: 'n_pg', type: 'pointgraph', data: 'n_cp', expr: 'solid.mises', unit: 'MPa' }, ['cp']),
  pi('1d', { id: 'n_g1', type: 'global', data: 'sol_std1', expr: 'solid.mises_max', unit: 'MPa' }),
  pi('1d', { id: 'n_tg', type: 'tablegraph', table: 'n_tbl0', columns: ['kt'] }, ['tbl']),
  pi('2d', { id: 'n_surf', type: 'surface', expr: 'solid.mises', unit: 'MPa', range: { rule: 'manual', min: '0 MPa', max: '3 MPa' }, colormap: 'inferno', log: false }),
  pi('2d', { id: 'n_cont', type: 'contour', expr: 'solid.sxx', unit: 'MPa', levels: { count: 14 }, color: 'uniform' }),
  pi('2d', { id: 'n_arr', type: 'arrow', expr: 'solid.u' }),
  pi('2d', { id: 'n_str', type: 'streamline', expr: 'solid.u', count: 20 }),
  pi('2d', { id: 'n_line', type: 'line', expr: 'solid.sxx', unit: 'MPa', select: ['bnd:hole.edge'] }),
  pi('2d', { id: 'n_mm', type: 'maxmin', expr: 'solid.mises', unit: 'MPa', show: 'max', method: 'lattice' }),
  pi('2d', { id: 'n_ppt', type: 'point', data: 'n_cp', expr: 'solid.mises', unit: 'MPa' }, ['cp']),
  pi('2d', { id: 'n_mesh', type: 'mesh' }),
  pi('2d', { id: 'n_def', type: 'deformation', expr: 'solid.u', scale: 'auto' }),
  pi('2d', { id: 'n_hgt', type: 'height', expr: 'solid.mises', unit: 'MPa', scale: 1 }),
  pi('3d', { id: 'n_s3', type: 'surface', expr: 'ac.p', unit: 'Pa' }),
  pi('3d', { id: 'n_sl', type: 'slice', expr: 'ac.p', unit: 'Pa', normal: 'z', at: ['Lz/2', '0.1 m'] }),
  pi('3d', { id: 'n_iso', type: 'isosurface', expr: 'ac.p', levels: { values: ['0 Pa'] } }),
  pi('3d', { id: 'n_vol', type: 'volume', expr: 'ac.p', unit: 'Pa', range: { rule: 'p1-99' } }),
  pi('3d', { id: 'n_a3', type: 'arrow', expr: 'ac.p' }),
  pi('3d', { id: 'n_st3', type: 'streamline', expr: 'ac.p' }),
  pi('3d', { id: 'n_l3', type: 'line', expr: 'ac.p', select: ['edg:room.e1'] }),
  pi('3d', { id: 'n_mm3', type: 'maxmin', expr: 'ac.p', show: 'both', method: 'nodal' }),
  pi('3d', { id: 'n_m3', type: 'mesh' }),
  pi('3d', { id: 'n_d3', type: 'deformation', expr: 'ac.p', scale: 2 }),
];

test('every node type has a sample (coverage of the vocabulary)', () => {
  const have = new Set(SAMPLES.map((s) => s.name));
  for (const t of DATASET_TYPES) assert.ok(have.has(`dataset ${t}`), t);
  for (const t of EVAL_ITEM_TYPES) assert.ok(have.has(`evaluation ${t}`), t);
  for (const g of PLOT_GROUP_TYPES) { assert.ok(have.has(`plot group ${g}`), g); for (const t of PLOT_ITEM_TYPES[g]) assert.ok(have.has(`${g} ${t}`), `${g} ${t}`); }
  assert.ok(have.has('table') && have.has('evaluation group'));
});

test('migrated fixtures validate; results selections are resolved by checkSelections', () => {
  for (const [k, t] of Object.entries(TEXT)) assert.deepEqual(codes(dataOf(t)), [], k);
  const d = dataOf(TEXT.kirsch);
  const seen: string[] = [];
  const out = checkSelections(d as never, { table: { domains: [], boundaries: [] }, resolve: (_t, _k, ids) => { seen.push(...ids); return { indices: [], unknown: [...ids] }; } });
  assert.ok(out.some((i) => i.dotted === 'results.evaluations.0.items.0.over.0' && i.code === 'unknown_entity'));
  assert.ok(seen.includes('bnd:hole.edge'));
});

test('op round trip per node type: add, edit, remove, revert, replay; schema_at resolves the type', async () => {
  for (const s of SAMPLES) {
    const log = await createOpLog(TEXT[s.base], { registry: reg, clock });
    for (const k of s.setup ?? []) { const o = await log.apply(SETUP[k]!, user); assert.ok(o.validation.ok, `${s.name} setup ${k}: ${o.validation.errors.join('; ')}`); }
    const add = await log.apply([{ op: 'add', path: s.at, value: s.node }], { actor: 'agent:t1', reason: `add ${s.name}` });
    assert.ok(add.validation.ok, `${s.name} add: ${add.validation.errors.join('; ')}`);
    assert.deepEqual(add.invalidates, ['plots'], s.name);
    const nodeId = Array.isArray(s.node) ? (s.node[0] as O).id : s.node.id;
    const ptr = resultNodes((log.data as O).results).find((n) => n.id === nodeId)!.idPointer;
    assert.ok(ptr, s.name);
    // schema_at: the node's own sub-schema
    const sa = schemaAt(reg, ptr, log.data);
    assert.ok(sa, `${s.name}: schema_at ${ptr}`);
    const props = (sa!.json as { properties?: Record<string, { const?: string }> }).properties ?? {};
    if (s.type === 'table') assert.ok(props.from && !props.type, s.name);
    else if (s.type === 'group') assert.ok(props.items && !props.type, s.name);
    else assert.equal(props.type?.const, s.type, `${s.name}: schema_at type`);
    // edit
    const [ep, ev2] = s.edit ?? [`${ptr}/label`, `${s.name} edited`];
    const ed = await log.apply([{ op: 'add', path: ep, value: ev2 }], user);
    assert.ok(ed.validation.ok, `${s.name} edit: ${ed.validation.errors.join('; ')}`);
    assert.deepEqual(getAt(log.data, keysOf(log.data, ep)), ev2);
    const withNode = log.text;
    // remove, then revert the remove
    const rm = await log.apply([{ op: 'remove', path: ptr }], user);
    assert.ok(!resultNodes((log.data as O).results).some((n) => n.id === nodeId), `${s.name} removed`);
    assert.ok(rm.validation.ok, `${s.name} remove: ${rm.validation.errors.join('; ')}`);
    const rv = await log.revert(rm.seq, user);
    assert.ok(rv.validation.ok, `${s.name} revert: ${rv.validation.errors.join('; ')}`);
    assert.equal(log.text, withNode, `${s.name}: revert restores the text byte for byte`);
    assert.ok(log.text.includes('# '), 'comments kept');
    // replay recomputes everything from the patches and the genesis text
    const re = await replayJSONL(log.toJSONL(), { registry: reg });
    assert.ok(re.ok, `${s.name} replay: ${re.errors.join('; ')}`);
    assert.equal(re.log!.text, log.text, `${s.name} replay text`);
    // undo everything: the original text again
    while (log.canUndo) await log.undo(user);
    assert.equal(log.text, TEXT[s.base], `${s.name}: undo all`);
  }
});

test('a results block can be created from nothing by ops', async () => {
  const t = TEXT.kirsch.replace(/\nresults:\n(?: {2,}.*\n)+/, '\n');
  assert.ok(!t.includes('results:'));
  const log = await createOpLog(t, { registry: reg, clock });
  const a = await log.apply([{ op: 'add', path: '/results', value: { datasets: [{ id: 's1', type: 'solution', data: 'std1' }] } }], user);
  assert.ok(a.validation.ok, a.validation.errors.join('; '));
  const b = await log.apply([{ op: 'add', path: '/results/plots', value: [{ id: 'g', type: 'plot2d', data: 's1', items: [] }] }], user);
  assert.ok(b.validation.ok, b.validation.errors.join('; '));
  const c = await log.apply([{ op: 'add', path: '/results/plots/@g/items/-', value: { id: 'g_s', type: 'surface', expr: 'solid.sxx', unit: 'MPa' } }], user);
  assert.ok(c.validation.ok, c.validation.errors.join('; '));
  assert.deepEqual(surfaceItems((log.data as O).results), [{ group: 'g', id: 'g_s', type: 'plot2d', expr: 'solid.sxx', unit: 'MPa' }]);
});

const K = () => dataOf(TEXT.kirsch);
const withK = (f: (r: O, d: O) => void) => { const d = K(); f(d.results, d); return codes(d); };

test('cross references: datasets, studies, groups, tables, cycles, duplicate ids, exports', () => {
  assert.deepEqual(withK((r) => { r.plots[0].data = 'std1'; }), ['unknown_dataset results.plots.0.data']);
  assert.match(issuesOf((() => { const d = K(); d.results.plots[0].data = 'std1'; return d; })())[0]!.message, /is a study/);
  assert.deepEqual(withK((r) => { r.evaluations[0].items[0].data = 'nope'; }), ['unknown_dataset results.evaluations.0.items.0.data']);
  assert.deepEqual(withK((r) => { delete r.evaluations[0].data; }), ['missing_dataset results.evaluations.0.items.0.data']);
  assert.deepEqual(withK((r) => { r.tables = [{ id: 't', from: 'nope' }]; }), ['unknown_evaluation results.tables.0.from']);
  assert.deepEqual(withK((r) => { r.datasets.push({ id: 'a1', type: 'mirror', data: 'b1', planes: [{ normal: [1, 0] }] }, { id: 'b1', type: 'mirror', data: 'a1', planes: [{ normal: [0, 1] }] }); }).filter((c) => c.startsWith('dataset_cycle')).length, 1);
  assert.deepEqual(withK((r) => { r.plots[0].items[0].id = 'kt'; }), ['duplicate_id results.plots.0.items.0.id']);
  assert.deepEqual(withK((r) => { r.datasets[0].id = 'solid'; r.evaluations[0].data = 'solid'; r.plots[0].data = 'solid'; }), ['duplicate_id results.datasets.0.id']);
  assert.deepEqual(withK((r) => { r.exports = [{ id: 'x1', type: 'data', from: 'sxx', format: 'csv' }]; }), ['unknown_key results.exports']);
  assert.deepEqual(withK((r) => { r.plots.push({ id: 'p', type: 'plot1d', items: [{ id: 'tg', type: 'tablegraph', table: 'nope' }] }); }), ['unknown_table results.plots.1.items.0.table']);
  assert.deepEqual(withK((r) => { r.tables = [{ id: 't', from: 'ev_std1' }]; r.plots.push({ id: 'p', type: 'plot1d', items: [{ id: 'tg', type: 'tablegraph', table: 't', columns: ['kt', 'zz'] }] }); }), ['unknown_item results.plots.1.items.0.columns.1']);
  assert.deepEqual(withK((r) => { r.plots[0].type = 'plot2x'; }), ['invalid_union results.plots.0.type']);
  assert.match(issuesOf((() => { const d = K(); d.results.plots[0].items[0].type = 'surfac'; return d; })())[0]!.message, /unknown plot2d item type 'surfac' \(allowed: surface, contour/);
  assert.deepEqual(withK((r) => { r.plots[0].items.push({ id: 'sl', type: 'slice', expr: 'solid.sxx', normal: 'z', at: ['1 mm'] }); }).length, 1, 'slice is a 3D item only');
});

test('dataset kind compatibility and vector lengths', () => {
  const add = (n: O) => withK((r) => { r.datasets.push(n); });
  assert.deepEqual(add({ id: 'c', type: 'cutplane', data: 'sol_std1', point: ['0 m', '0 m', '0 m'], normal: [0, 0, 1] }), ['dataset_kind results.datasets.1.data']);
  assert.deepEqual(add({ id: 'c', type: 'revolve', data: 'sol_std1', sweep: '90 deg', layers: 8 }), ['dataset_kind results.datasets.1.data']);
  assert.deepEqual(add({ id: 'c', type: 'cutline', data: 'sol_std1', from: ['0 m', '0 m', '0 m'], to: ['0 m', '1 m', '0 m'] }), ['vector_length results.datasets.1.from', 'vector_length results.datasets.1.to']);
  assert.deepEqual(add({ id: 'c', type: 'cutline', data: 'sol_std1', from: ['0 m', 'D'], to: ['0 m', 'D'] }), ['degenerate results.datasets.1.to']);
  assert.deepEqual(add({ id: 'c', type: 'cutpoint', data: 'sol_std1', points: [['1 mm']] }), ['vector_length results.datasets.1.points.0']);
  assert.deepEqual(add({ id: 'c', type: 'mirror', data: 'sol_std1', planes: [{ normal: [0, 0] }], parity: { 'solid.sxy': [-1, 1], 'ht.T': [1] } }), ['degenerate results.datasets.1.planes.0.normal', 'vector_length results.datasets.1.parity.solid.sxy', 'unknown_physics results.datasets.1.parity.ht.T']);
  assert.deepEqual(add({ id: 'c', type: 'edge', data: 'sol_std1', select: ['bnd:nope.edge'] }), ['unknown_feature results.datasets.1.select.0']);
  // edge of an edge (no entities), join of different shapes
  assert.deepEqual(withK((r) => { r.datasets.push({ id: 'e1', type: 'edge', data: 'sol_std1', select: ['bnd:hole.edge'] }, { id: 'e2', type: 'edge', data: 'e1', select: ['bnd:hole.edge'] }); }), ['dataset_kind results.datasets.2.data']);
  assert.deepEqual(withK((r) => { r.datasets.push({ id: 'e1', type: 'edge', data: 'sol_std1', select: ['bnd:hole.edge'] }, { id: 'j', type: 'join', a: 'sol_std1', b: 'e1', op: 'difference' }); }), ['dataset_kind results.datasets.2.b']);
  // a cutplane of a 3D model feeds a 2D plot group; a 3D group cannot use it
  const b = dataOf(TEXT.box);
  b.results.datasets.push({ id: 'cpl', type: 'cutplane', data: 'sol_eig', point: ['Lx/2', 'Ly/2', 'Lz/2'], normal: [0, 0, 1] });
  b.results.plots.push({ id: 'g2', type: 'plot2d', data: 'cpl', items: [{ id: 'g2s', type: 'surface', expr: 'ac.p', unit: 'Pa' }] });
  assert.deepEqual(codes(b), []);
  b.results.plots[0].data = 'cpl';
  assert.deepEqual(codes(b), ['dataset_kind results.plots.0.data'], 'reported once, at the group');
  // edge datasets select curves: bnd in 2D, edg in 3D
  b.results.plots[0].data = 'sol_eig';
  b.results.datasets.push({ id: 'e3', type: 'edge', data: 'sol_eig', select: ['bnd:room.top'] });
  assert.deepEqual(codes(b), ['entity_kind results.datasets.2.select.0']);
  assert.deepEqual(add({ id: 'c', type: 'edge', data: 'sol_std1', select: ['edg:plate.e1'] }), ['entity_kind results.datasets.1.select.0']);
  assert.deepEqual(add({ id: 'c', type: 'mirror', data: 'sol_std1', planes: [{ normal: [1, 0] }], parity: { 'solid.u.phi': [-1] } }), ['expression results.datasets.1.parity.solid.u.phi']);
});

test('item / dataset compatibility: plots and evaluations', () => {
  const evi = (it: O, ...ds: O[]) => withK((r) => { r.datasets.push(...ds); r.evaluations[0].items.push(it); });
  const cl = { id: 'cl', type: 'cutline', data: 'sol_std1', from: ['0 m', 'D/2'], to: ['0 m', 'W/2'] };
  assert.deepEqual(evi({ id: 'p', type: 'point', expr: 'solid.sxx' }), ['dataset_kind results.evaluations.0.items.1.type']);
  assert.deepEqual(evi({ id: 'm', type: 'max', expr: 'solid.sxx', method: 'nodal' }), ['dataset_kind results.evaluations.0.items.1.over']);
  assert.deepEqual(evi({ id: 'm', type: 'integral', data: 'cl', expr: 'solid.sxx', over: ['dom:plate'] }, cl), ['dataset_kind results.evaluations.0.items.1.over']);
  assert.deepEqual(evi({ id: 'm', type: 'integral', data: 'cl', expr: 'solid.sxx' }, cl), []);
  assert.deepEqual(evi({ id: 'm', type: 'integral', data: 'cp', expr: 'solid.sxx' }, { id: 'cp', type: 'cutpoint', data: 'sol_std1', points: [['0 m', 'D']] }), ['dataset_kind results.evaluations.0.items.1.data']);
  assert.deepEqual(evi({ id: 'm', type: 'max', data: 'cp', expr: 'solid.sxx', method: 'points' }, { id: 'cp', type: 'cutpoint', data: 'sol_std1', points: [['0 m', 'D']] }), []);
  const pl = (g: O, ...ds: O[]) => withK((r) => { r.datasets.push(...ds); r.plots.push(g); });
  assert.deepEqual(pl({ id: 'g', type: 'plot1d', items: [{ id: 'lg', type: 'linegraph', data: 'sol_std1', x: 'arc', expr: 'solid.sxx' }] }), ['dataset_kind results.plots.1.items.0.data']);
  assert.deepEqual(pl({ id: 'g', type: 'plot1d', items: [{ id: 'lg', type: 'linegraph', x: 'arc', expr: 'solid.sxx' }] }), ['missing_dataset results.plots.1.items.0.data']);
  assert.deepEqual(pl({ id: 'g', type: 'plot1d', data: 'cl', items: [{ id: 'lg', type: 'linegraph', x: 'y', expr: 'solid.sxx' }, { id: 'pg', type: 'pointgraph', expr: 'solid.sxx' }] }, cl), ['dataset_kind results.plots.1.items.1.type']);
  assert.deepEqual(pl({ id: 'g', type: 'plot2d', data: 'cl', items: [] }, cl), ['dataset_kind results.plots.1.data']);
  assert.deepEqual(pl({ id: 'g', type: 'plot2d', data: 'sol_std1', items: [{ id: 'pp', type: 'point', data: 'sol_std1' }] }), ['dataset_kind results.plots.1.items.0.data']);
  assert.deepEqual(pl({ id: 'g', type: 'plot2d', data: 'sol_std1', items: [{ id: 'ln', type: 'line', data: 'mir', expr: 'solid.sxx' }] }, { id: 'mir', type: 'mirror', data: 'sol_std1', planes: [{ normal: [1, 0] }] }), ['dataset_kind results.plots.1.items.0.data']);
  assert.deepEqual(pl({ id: 'g', type: 'plot2d', data: 'sol_std1', items: [{ id: 'mm', type: 'maxmin', expr: 'solid.sxx' }] }), ['missing_key results.plots.1.items.0.show', 'missing_key results.plots.1.items.0.method']);
  assert.deepEqual(pl({ id: 'g', type: 'plot2d', data: 'sol_std1', items: [{ id: 's', type: 'surface', expr: 'solid.sxx', range: { rule: 'manual', min: '0 MPa' } }] }), ['custom results.plots.1.items.0.range.max']);
});

test('expression vocabulary: names, components, coordinates, t, d(), units', () => {
  const ex = (e: string, unit?: string, d = K(), at: (r: O) => O = (r) => r.plots[0].items[0]) => { const it = at(d.results); it.expr = e; if (unit === undefined) delete it.unit; else it.unit = unit; return issuesOf(d).map((i) => i.message); };
  assert.deepEqual(ex('solid.sxx/sigma_inf', '1'), []);
  assert.deepEqual(ex('sqrt(solid.sxx^2 + solid.syy^2)', 'MPa'), []);
  assert.deepEqual(ex('solid.u.x', 'mm'), []);
  assert.match(ex('solid.u.phi', 'mm')[0]!, /component must be one of \.x \.y \.z/);
  assert.match(ex('sxx', 'MPa')[0]!, /unknown name 'sxx'/);
  assert.match(ex('ht.T', 'K')[0]!, /no physics 'ht'/);
  assert.match(ex('solid.sxx*z', 'MPa')[0]!, /'z' is not available on this dataset \(allowed: x, y, r\)/);
  assert.match(ex('solid.sxx*t', 'MPa')[0]!, /'t' is not available/);
  assert.match(ex('nosuchfn(solid.sxx)', 'MPa')[0]!, /unknown function/);
  assert.deepEqual(ex('d(solid.u.x, x)', '1'), []);
  assert.deepEqual(ex('-d(d(solid.u.y, y), x)*r', '1'), []);
  assert.match(ex('d(solid.u.x, t)', '1')[0]!, /d\(f, v\) needs a space coordinate/);
  assert.match(ex('d(solid.u.x)', '1')[0]!, /d\(\) takes 2 arguments/);
  // closed forms (no field names) are dimension-checked against the unit
  assert.deepEqual(ex('sigma_inf*(1 + (D/2)^2/(2*y^2))', 'MPa'), []);
  assert.match(ex('sigma_inf*(1 + (D/2)^2/(2*y^2))', 'm')[0]!, /expression has unit Pa, but unit 'm' is m/);
  assert.match(ex('sigma_inf + y', 'MPa')[0]!, /incompatible units/);
  // axisym: r z and components .r .phi .z; time studies: t
  const c = dataOf(TEXT.coil);
  assert.deepEqual(ex('mf.normB*r/R', 'T', c), []);
  assert.match(ex('mf.B.x', 'T', dataOf(TEXT.coil))[0]!, /component must be one of \.r \.phi \.z/);
  assert.match(ex('mf.normB*x', 'T', dataOf(TEXT.coil))[0]!, /'x' is not available on this dataset \(allowed: r, z\)/);
  // a physics not solved by the study of the dataset
  const two = K();
  two.physics.push({ id: 'solid2', type: 'elastic', select: ['dom:plate'], settings: { model: 'plane-stress' } });
  assert.match(ex('solid2.sxx', 'MPa', two)[0]!, /physics 'solid2' is not solved by the study of this dataset \(solved: solid\)/);
  // global items: no coordinates
  assert.match(ex('solid.mises_max*x', 'MPa', K(), (r) => { r.evaluations[0].items[0].type = 'global'; delete r.evaluations[0].items[0].over; delete r.evaluations[0].items[0].method; return r.evaluations[0].items[0]; })[0]!, /'x' is not available on this dataset \(allowed: none\)/);
  // with an injected result-dimension resolver, field expressions are unit-checked too
  const dims = (type: string, name: string) => (type === 'elastic' && name === 'sxx' ? [-1, 1, -2, 0, 0, 0, 0] : null);
  const d = K();
  d.results.plots[0].items[0].unit = 'm';
  assert.match(validateSpec(d, reg, { resultDims: dims }).issues[0]!.message, /expression has unit Pa, but unit 'm' is m/);
  d.results.plots[0].items[0].expr = 'solid.szz';
  assert.match(validateSpec(d, reg, { resultDims: dims }).issues[0]!.message, /physics type 'elastic' has no result 'szz'/);
  assert.deepEqual(codes(d), [], 'without a resolver, field names are not unit-checked');
  // errors in d() expressions quote the source as written
  assert.match(ex('d(solid.u.x, x) + )', '1')[0]!, /expression "d\(solid\.u\.x, x\) \+ \)"/);
  // a failed param skips only the unit check of the expressions using it, not their other names
  const fp = K();
  fp.params.bad = 'nosuch*2';
  assert.ok(ex('zzz + bad', 'MPa', fp).some((m) => /unknown name 'zzz'/.test(m)));
  assert.equal(rewriteDerivatives('d(a.b, x) + 2*d(d(a.c,y), x)', symbolsFor({ embed: 2, axisym: false })), '((a.b)/(x)) + 2*((((a.c)/(y)))/(x))');
});

test('steps: keywords, indices, {values, unit} checked against the study kind', () => {
  assert.deepEqual(withK((r) => { r.plots[0].steps = 'last'; r.datasets[0].steps = [0, 1]; }), []);
  assert.deepEqual(withK((r) => { r.datasets[0].steps = { values: [1], unit: 's' }; }), []);
  const f = dataOf(readHero('heat-plate-fin'));
  f.studies.push({ id: 'tr', type: 'time', physics: ['ht'], settings: { start: '0 s', stop: '10 s', dt: '1 s', method: 'bdf2' } });
  f.results.datasets.push({ id: 'sol_tr', type: 'solution', data: 'tr', steps: { values: [1, 2], unit: 'Hz' } });
  assert.deepEqual(codes(f), ['step_unit results.datasets.2.steps.unit']);
  f.results.datasets[2].steps = { values: [1, 2], unit: 's' };
  f.results.plots.push({ id: 'pt', type: 'plot2d', data: 'sol_tr', items: [{ id: 'pts', type: 'surface', expr: 'ht.T*t/(1[s])', unit: 'K' }] });
  assert.deepEqual(codes(f), []);
});

test('JSON Schema: results node types exported as definitions; no exports section', () => {
  const js = specJsonSchema(reg) as { $defs: Record<string, { properties?: Record<string, unknown> }> };
  for (const t of DATASET_TYPES) assert.ok(js.$defs[`Dataset_${t}`], t);
  for (const t of EVAL_ITEM_TYPES) assert.ok(js.$defs[`Eval_${t}`], t);
  for (const g of PLOT_GROUP_TYPES) { assert.ok(js.$defs[`PlotGroup_${g}`], g); for (const t of PLOT_ITEM_TYPES[g]) assert.ok(js.$defs[`${g[0]!.toUpperCase()}${g.slice(1)}_${t}`], `${g} ${t}`); }
  assert.deepEqual(Object.keys(js.$defs.Results!.properties!), ['datasets', 'evaluations', 'tables', 'plots']);
  assert.ok(JSON.stringify(js.$defs.Ref_dataset).includes('"x-amp-ref":"dataset"'));
  assert.ok(JSON.stringify(js.$defs.ResultExpr).includes('"x-amp-expression":"results"'));
});

test('reader helpers: nodes, headline items, surfaces, units', () => {
  const k = K();
  const nodes = resultNodes(k.results);
  assert.deepEqual(nodes.map((n) => `${n.section}:${n.id}:${n.type}${n.parent ? `<${n.parent}` : ''}`), ['datasets:sol_std1:solution', 'evaluations:ev_std1:group', 'evaluations:kt:max<ev_std1', 'plots:sxx:plot2d', 'plots:sxx_surf:surface<sxx']);
  for (const n of nodes) { assert.equal(getAt(k, keysOf(k, n.pointer)), n.node); assert.equal(getAt(k, keysOf(k, n.idPointer)), n.node); }
  assert.deepEqual(headlineItems(k.results), [{ id: 'kt', type: 'max', expr: 'solid.sxx/sigma_inf', unit: '1', dataset: 'solution', study: 'std1', method: 'nodal', over: ['bnd:hole.edge'] }]);
  assert.deepEqual(surfaceItems(k.results), [{ group: 'sxx', id: 'sxx_surf', type: 'plot2d', expr: 'solid.sxx', unit: 'MPa' }]);
  const f = dataOf(TEXT.fin);
  assert.deepEqual(headlineItems(f.results), [{ id: 'T_E', type: 'point', expr: 'ht.T', unit: 'degC', dataset: 'cutpoint', study: 'std1', at: ['0.6 m', '0.2 m'], source: 'solution' }]);
  assert.deepEqual(resultUnits(f.results).map((u) => `${u.id} ${u.expr} ${u.unit}`), ['T_map_surf ht.T degC', 'T_E ht.T degC']);
  const b = dataOf(TEXT.box);
  assert.deepEqual(surfaceItems(b.results), [{ group: 'p_mode', id: 'p_mode_surf', type: 'plot3d', expr: 'ac.p', unit: 'Pa', step: 1 }]);
  // the dataset an item reads, 'last' steps, point forms, disabled dataset chains
  const h = dataOf(TEXT.kirsch);
  h.results.datasets.push({ id: 'cl', type: 'cutline', data: 'sol_std1', from: ['0 m', 'D/2'], to: ['0 m', 'W/2'] }, { id: 'pv', type: 'cutpoint', data: 'sol_std1', points: [{ value: [1, 2], unit: 'mm' }] });
  h.results.evaluations[0].items.push({ id: 'mx', type: 'max', data: 'cl', expr: 'solid.sxx', method: 'nodal', steps: 'last' }, { id: 'pp', type: 'point', data: 'pv', expr: 'solid.sxx' });
  h.results.plots[0].steps = 'last';
  assert.deepEqual(codes(h), []);
  assert.deepEqual(headlineItems(h.results).map((x) => [x.id, x.dataset, x.study, x.step, x.source ?? null, x.at ?? null]), [
    ['kt', 'solution', 'std1', undefined, null, null], ['mx', 'cutline', 'std1', 'last', null, null], ['pp', 'cutpoint', 'std1', undefined, 'solution', [{ value: 1, unit: 'mm' }, { value: 2, unit: 'mm' }]],
  ]);
  assert.equal(surfaceItems(h.results)[0]!.step, 'last');
  h.results.datasets[0].enabled = false;
  assert.deepEqual([headlineItems(h.results), surfaceItems(h.results)], [[], []]);
  // disabled nodes are skipped; malformed input yields nothing (never throws)
  k.results.evaluations[0].enabled = false;
  assert.deepEqual(headlineItems(k.results), []);
  assert.deepEqual(resultNodes([{ id: 'legacy', type: 'plot2d' }]), []);
  assert.deepEqual(headlineItems(null), []);
});

test('node hashes for value artifacts: upstream and param changes propagate; siblings do not', async () => {
  const a = K();
  a.results.datasets.push({ id: 'cl', type: 'cutline', data: 'sol_std1', from: ['0 m', 'D/2'], to: ['0 m', 'W/2'] });
  a.results.evaluations[0].items.push({ id: 'Fx', type: 'integral', data: 'cl', expr: 'solid.sxx', unit: 'N/m' });
  a.results.plots.push({ id: 'pl', type: 'plot1d', items: [{ id: 'lg', type: 'linegraph', data: 'cl', x: 'y', expr: 'sigma_inf*(1 + (D/2)^2/(2*y^2))', unit: 'MPa' }] });
  assert.deepEqual(codes(a), []);
  const h0 = await resultNodeHash(a, 'Fx');
  assert.match(h0!, /^[0-9a-f]{64}$/);
  assert.equal(await resultNodeHash(a, 'nope'), null);
  const b = structuredClone(a);
  b.results.datasets[1].n = 50; // upstream of Fx and lg
  assert.deepEqual(await changedResultNodes(a, b), ['Fx', 'cl', 'ev_std1', 'lg', 'pl']);
  const c = structuredClone(a);
  c.results.evaluations[0].items[0].method = 'quad'; // a sibling of Fx
  assert.deepEqual(await changedResultNodes(a, c), ['ev_std1', 'kt']);
  const d = structuredClone(a);
  d.params.sigma_inf.value = 2; // used by kt and the exact line graph, not by Fx
  assert.deepEqual(await changedResultNodes(a, d), ['ev_std1', 'kt', 'lg', 'pl']);
  const e = structuredClone(a);
  e.results.evaluations[0].label = 'renamed'; // labels are display only
  e.results.evaluations[0].items[0].label = 'K_t';
  assert.deepEqual(await changedResultNodes(a, e), []);
  const g = structuredClone(a);
  g.results.evaluations[0].data = 'cl'; // Fx names its own dataset: the group default does not reach it
  assert.ok(!(await changedResultNodes(a, g)).includes('Fx'));
  const run = await runId({ engine: 'e', specHash: 'a', meshHash: 'b', startedAt: '2026-11-06T23:00:00-08:00', platform: { runtime: 'node' }, fidelity: 'rigorous' });
  assert.equal(artifactKey(h0!, run), `${h0}:${run}`);
});
