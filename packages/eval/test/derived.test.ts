// SPDX-License-Identifier: GPL-3.0-or-later
// Follow-up 3 (I1 / DevLog-014): derived extracts (reduce, expr, dimension-checked through @amp/core/expr), tensor
// and vector field targets, per-target spec. Uses the real @amp/spec units and @amp/core/expr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { units } from '@amp/spec';
import { compileExpression } from '../../core/src/expr.mjs';
import { extractFromSolution, setExpressionCompiler, setUnitsApi, type SampleFn } from '../src/registry.ts';
import { evaluateTarget } from '../src/evaluate.ts';
import { runCase } from '../src/runner.ts';
import { parseCase, type Reference } from '../src/loader.ts';
import type { Solution } from '../src/contract-shim.ts';
import type { Source } from '../src/source.ts';
import { caseYaml, makeRoot, MOCK_PHYSICS } from './helpers.ts';
import { main } from '../src/cli.ts';

const sol = (fields: string[], unit = 'Pa'): Solution => ({
  meshHash: 'm', fields: fields.map((name) => ({ name, unit, space: 'H1P1' as const, components: 1 as const, data: new Float64Array(1) })),
  scalars: { s_inf: { value: 100, unit: 'MPa' } }, stats: { dof: 1, solver: 'stub' }, timing: {},
  run: { engine: 'e', specHash: 's', meshHash: 'm', startedAt: '2026-11-06T00:00:00-08:00', platform: { runtime: 'node' }, fidelity: 'rigorous' },
});
// stt along the hole edge: 3e8 * y / 2 Pa at (0, y); vector u: component k -> k + 1 + x
const sample: SampleFn = (_s, field, pts, o) => Float64Array.from(pts, (p) => (field === 'stt' ? 3e8 * p[1]! / 2 : field === 'u' ? (o?.component ?? 0) + 1 + p[0]! : field === 'sxx' ? 1 : field === 'syy' ? 2 : 3));
const ref = (extract: Reference['extract'], unit = '1', value = 3): Reference => ({ quantity: 'K_t', metric_id: 'K_t', value, unit, tolerance: { rel: 1e-12 }, basis: 'D', form: 'closed_form', provenance: { citation: 'c', locator: 'l', accessed: null }, ...(extract ? { extract } : {}) });

test('item 1: expr K_t = max(stt) / s_inf, dimension-checked, units converted', () => {
  setUnitsApi(units); setExpressionCompiler(compileExpression as never);
  const ex: Reference['extract'] = { kind: 'expr', expr: 'smax / s_inf', terms: { smax: { kind: 'reduce', field: 'stt', op: 'max', points: [[0, 1], [0, 2], [0, 1.5]] }, s_inf: { kind: 'scalar', name: 's_inf' } } };
  const v = extractFromSolution(sol(['stt']), ref(ex), { sample });
  assert.deepEqual(v, { value: 3 });
  const c = extractFromSolution(sol(['stt']), ref({ ...ex, terms: { ...ex!.terms!, s_inf: { value: 1e8, unit: 'Pa' } } }), { sample });
  assert.deepEqual(c, { value: 3 });
  const kpa = extractFromSolution(sol(['stt']), ref({ kind: 'reduce', field: 'stt', op: 'max', points: [[0, 2]] }, 'MPa', 300), { sample });
  assert.deepEqual(kpa, { value: 300 });
  const dimErr = extractFromSolution(sol(['stt']), ref(ex, 'm'), { sample });
  assert.ok('error' in dimErr && /dimension/.test(dimErr.error));
  const addErr = extractFromSolution(sol(['stt']), ref({ kind: 'expr', expr: 'smax + L', terms: { smax: ex!.terms!.smax!, L: { value: 1, unit: 'm' } } }), { sample });
  assert.ok('error' in addErr && /incompatible units/.test(addErr.error));
  const missing = extractFromSolution(sol([]), ref(ex), { sample });
  assert.ok('pending' in missing);
  const e = evaluateTarget(ref(ex), 3, { levels: [{ value: (v as { value: number }).value }] });
  assert.equal(e.status, 'pass');
  setUnitsApi(null); setExpressionCompiler(null);
});

test('item 2: tensor (fields) and vector (components) field extracts, concatenated component-major', () => {
  setUnitsApi(units);
  const pts = [[0, 0], [1, 0]];
  const t = extractFromSolution(sol(['sxx', 'syy', 'sxy']), ref({ kind: 'field', fields: ['sxx', 'syy', 'sxy'], points: pts }, 'Pa'), { sample });
  assert.deepEqual(t, { value: { values: [1, 1, 2, 2, 3, 3] } });
  const u = extractFromSolution(sol(['u'], 'm'), ref({ kind: 'field', field: 'u', components: [0, 1], points: pts }, 'm'), { sample });
  assert.deepEqual(u, { value: { values: [1, 2, 2, 3] } });
  setUnitsApi(null);
});

test('item 2: runner builds the reference from one evaluator field per component', async () => {
  const y = caseYaml({ tol: '{rel: 1.0e-6, norm: l2}', refExtra: '\n    extract: {kind: field, fields: [sxx, syy], evaluator: validation/a/fields.py, evaluator_case: SM-01, points: [[0, 0.01], [0.01, 0]]}' }).replace('unit: "1"', 'unit: Pa');
  const lc = parseCase(y, 'eval/cases/a/XX-01.yaml', { stem: 'XX-01', dirClass: 'a', today: '2026-11-06' });
  assert.deepEqual(lc.issues.filter((i) => i.severity === 'error'), []);
  const calls: string[] = [];
  const exactField = async (_e: string, caseId: string, field: string, points: number[][]) => { calls.push(`${caseId}:${field}`); return { values: points.map(() => (field === 'sxx' ? 10 : 20)), unit: 'Pa', generator: 'stub' }; };
  const mk = (vals: number[]): Source => ({ name: 'stub', describe: () => 'stub', plan: async () => ({ runnable: true, reason: '' }), observe: async () => ({ kind: 'observed', targets: { q: { levels: [{ value: { values: vals } }] } }, run: {} }) });
  const ok = await runCase(lc, mk([10, 10, 20, 20]), { exactField: exactField as never });
  assert.equal(ok.status, 'pass'); assert.deepEqual(calls, ['SM-01:sxx', 'SM-01:syy']);
  const bad = await runCase(lc, mk([10, 10, 20, 20.1]), { exactField: exactField as never });
  assert.equal(bad.status, 'fail');
});

test('item 3: a target may name its own spec; one worker run per spec, the case spec is the default', async () => {
  const phys = MOCK_PHYSICS.replace("scalars: { q: { value: 1 + 0.1 * h * h, unit: '1' } }", "scalars: { q: { value: (1 + 0.1 * h * h) * (ctx.spec.x_scale ?? 1), unit: '1' } }");
  const fx = makeRoot({ physicsSrc: phys });
  try {
    const second = `
  - quantity: q2
    metric_id: q
    id: q_scaled
    value: 2.0
    unit: "1"
    tolerance: {rel: 1.0e-3, after: richardson}
    basis: D
    form: closed_form
    provenance: {citation: synthetic, locator: test, accessed: 2026-11-06}
    spec: {schema: amp-spec/0, x_scale: 2, physics: [{id: p1, type: mock}]}`;
    fx.write('eval/cases/a/XX-01.yaml', caseYaml({ refExtra: second }));
    let buf = '';
    const code = await main(['--root', fx.root, '--no-log', '--json'], { out: (s) => { buf += s; }, err: () => {} });
    const out = JSON.parse(buf) as { results: Array<{ status: string; targets: Array<{ target: string; status: string; value: number }>; levelRuns: Array<{ spec?: string }> }> };
    assert.equal(code, 0);
    assert.deepEqual(out.results[0]!.targets.map((t) => [t.target, t.status]), [['q', 'pass'], ['q_scaled', 'pass']]);
    assert.ok(Math.abs(out.results[0]!.targets[1]!.value - 2) < 1e-12);
    assert.equal(out.results[0]!.levelRuns.length, 6);
  } finally { fx.cleanup(); }
});

test('RESULT_NAMES pre-check reads every name in extract.fields (I1 bug)', async () => {
  const phys = MOCK_PHYSICS.replace("meshHash: 'm' + h, fields: [],", "meshHash: 'm' + h, fields: ['sxx', 'syy', 'sxy'].map((name) => ({ name, unit: 'Pa', space: 'H1P1', components: 1, data: new Float64Array(1) })),")
    + "\nexport const RESULT_NAMES = { mock: { fields: ['sxx', 'syy', 'sxy'], scalars: ['q'] } };\n";
  const fx = makeRoot({ physicsSrc: phys });
  try {
    fx.write('packages/post/package.json', JSON.stringify({ name: '@amp/post', version: '0.0.0-mock', type: 'module', exports: { '.': './src/index.mjs' } }));
    fx.write('packages/post/src/index.mjs', 'export function sample(sol, field, points) { return Float64Array.from(points, () => ({ sxx: 1, syy: 2, sxy: 3 })[field]); }');
    fx.write('eval/expected/XX-01.json', JSON.stringify({ case: 'XX-01', generator: 'g', versions: {}, generated_at: '2026-11-06T00:00:00-08:00', targets: [], samples: { s: { points: [[0, 1], [1, 0]], values: [[1, 1], [2, 2], [3, 3]] } } }));
    const mk = (fields: string) => caseYaml({ tol: '{rel: 1.0e-9}', refExtra: `\n    extract: {kind: field, fields: ${fields}, samples_key: samples.s}` });   // unit "1": relative metric, samples in SI
    const runIt = async () => { let buf = ''; await main(['--root', fx.root, '--no-log', '--json'], { out: (x) => { buf += x; }, err: () => {} }); return JSON.parse(buf) as { results: Array<{ targets: Array<{ status: string; reason?: string }> }> }; };
    fx.write('eval/cases/a/XX-01.yaml', mk('[sxx, syy, sxy]'));
    assert.equal((await runIt()).results[0]!.targets[0]!.status, 'pass');
    fx.write('eval/cases/a/XX-01.yaml', mk('[sxx, szz, sxy]'));
    const t = (await runIt()).results[0]!.targets[0]!;
    assert.equal(t.status, 'pending'); assert.match(t.reason!, /does not produce field 'szz'/);
  } finally { fx.cleanup(); }
});

