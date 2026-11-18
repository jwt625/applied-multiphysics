// SPDX-License-Identifier: GPL-3.0-or-later
// DevLog-039 (lane T2): sims reference with params / study overrides (H1), unit annotation (H2), combine targets
// across specs (H3), pending ref / proposed file checks (H4), round-off floor of the fallback rule (H5), --skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { units } from '@amp/spec';
import { compileExpression } from '../../core/src/expr.mjs';
import { applyOverrides, combineTarget, convertUnit, setUnitsApi, unitCore } from '../src/registry.ts';
import { evaluateTarget } from '../src/evaluate.ts';
import { runCase } from '../src/runner.ts';
import { parseCase, specPaths, type Reference } from '../src/loader.ts';
import type { Source } from '../src/source.ts';
import { caseYaml } from './helpers.ts';

const base = (over: Partial<Reference> = {}): Reference => ({
  quantity: 'q', metric_id: 'q', value: 1, unit: '1', tolerance: { rel: 1e-6 }, basis: 'D', form: 'closed_form',
  provenance: { citation: 'c', locator: 'l', accessed: null }, ...over,
});

test('H1: params override replaces the value (number keeps the unit, string drops it); study must exist', () => {
  const text = 'schema: amp-spec/0\nid: x\nparams:\n  eps: {value: 2.25, description: d}\n  L: {value: 3, unit: mm}\nstudies:\n  - {id: s1, type: eigen}\n  - {id: s2, type: eigen}\n';
  const a = applyOverrides(text, { sim: 'sims/x.yaml', params: { eps: 8, L: '2 [mm] * 2' }, study: 's2' });
  assert.ok('data' in a);
  const p = (a as { data: { params: Record<string, Record<string, unknown>> } }).data.params;
  assert.deepEqual(p.eps, { value: 8, description: 'd' });
  assert.deepEqual(p.L, { value: '2 [mm] * 2' });
  const bad = applyOverrides(text, { sim: 'sims/x.yaml', params: { nope: 1 } });
  assert.ok('error' in bad && /no such param/.test(bad.error));
  const badStudy = applyOverrides(text, { sim: 'sims/x.yaml', study: 's9' });
  assert.ok('error' in badStudy && /study 's9'/.test(badStudy.error));
});

test('H2: unit annotation after a dimensionless unit is ignored; other parentheses are units', () => {
  assert.equal(unitCore('1 (c/a)'), '1');
  assert.equal(unitCore('W/(m K)'), 'W/(m K)');
  assert.equal(unitCore('m (mesh unit)'), 'm (mesh unit)');
  setUnitsApi(units);
  assert.deepEqual(convertUnit(0.28, '1', '1 (c/a)'), { value: 0.28 });
});

test('H3: combine evaluates per level on other targets, matched by h; pending / error propagate', () => {
  setUnitsApi(units);
  const lo = base({ metric_id: 'lo', quantity: 'lo' }), up = base({ metric_id: 'up', quantity: 'up' });
  const g = base({ metric_id: 'g', quantity: 'g', extract: { kind: 'combine', expr: '(up - lo) / ((up + lo) / 2)', targets: { lo: 'lo', up: 'up' } } });
  const obs = {
    lo: { levels: [{ value: 0.7, h: 1, dof: 10 }, { value: 0.72, h: 0.5, dof: 40 }] },
    up: { levels: [{ value: 1.3, h: 1, dof: 12 }, { value: 1.28, h: 0.5, dof: 44 }, { value: 1.27, h: 0.25, dof: 170 }] },
  };
  const r = combineTarget(g, [lo, up, g], obs, compileExpression as never);
  assert.ok('levels' in r);
  const lv = (r as { levels: Array<{ value: number; h: number; dof: number }> }).levels;
  assert.equal(lv.length, 2);   // h 0.25 only in one input
  assert.ok(Math.abs(lv[0]!.value - 0.6) < 1e-15 && lv[0]!.dof === 22);
  assert.ok(Math.abs(lv[1]!.value - 0.56 / 1.0) < 1e-15);
  const pend = combineTarget(g, [lo, up, g], { ...obs, lo: { pending: 'no module' } }, compileExpression as never);
  assert.ok('pending' in pend && /no module/.test(pend.pending));
  const dimErr = combineTarget({ ...g, unit: 'm' }, [lo, up, g], obs, compileExpression as never);
  assert.ok('error' in dimErr && /dimension/.test(dimErr.error));
  const withPi = combineTarget(base({ metric_id: 'p', unit: '1', extract: { kind: 'combine', expr: 'lo * pi', targets: { lo: 'lo' } } }), [lo], obs, compileExpression as never);
  assert.ok('levels' in withPi && Math.abs((withPi.levels[0]!.value as number) - 0.7 * Math.PI) < 1e-15);
});

test('H4: loader flags missing spec files, missing pending refs, existing proposals and bad combine targets', () => {
  const yaml = (spec: string, refs = '') => `schema: amp-eval/0\nid: XX-01\nclass: a\ntitle: t\nstatus: unvalidated\nphysics: [heat-cond]\ndimension: 2D\nspec: ${spec}\nreferences:\n  - {quantity: q, metric_id: q, value: 1, unit: '1', tolerance: {rel: 1.0e-6}, basis: D, form: closed_form, provenance: {citation: c, locator: l, accessed: null}${refs}}\n`;
  const exists = (p: string) => p === 'sims/have.yaml';
  const kw = (t: string) => parseCase(t, 'x.yaml', { fileExists: exists }).issues.map((i) => `${i.severity}:${i.keyword}`);
  assert.deepEqual(kw(yaml('sims/have.yaml')).filter((k) => k.includes('spec-')), []);
  assert.ok(kw(yaml('sims/none.yaml')).includes('error:spec-file'));
  assert.ok(kw(yaml('{sim: sims/none.yaml, params: {a: 1}}')).includes('error:spec-file'));
  assert.ok(kw(yaml('{status: pending, reason: r, ref: sims/none.yaml}')).includes('warning:spec-ref'));
  assert.ok(kw(yaml('{status: pending, reason: r, proposed: sims/have.yaml}')).includes('warning:spec-proposed'));
  assert.deepEqual(kw(yaml('{status: pending, reason: r, proposed: sims/none.yaml}')).filter((k) => k.includes('spec-')), []);
  assert.ok(kw(yaml('sims/have.yaml', ', spec: sims/none.yaml')).includes('error:spec-file'));
  assert.ok(kw(yaml('sims/have.yaml', ', extract: {kind: combine, expr: a, targets: {a: zz}}')).includes('error:extract-combine'));
  assert.ok(kw(yaml('sims/have.yaml', ', extract: {kind: combine, expr: a, targets: {a: q}}')).includes('error:extract-combine'));
  assert.deepEqual(specPaths({ sim: 'sims/a.yaml', study: 's' }), [['sims/a.yaml', 'run']]);
});

test('H5: level changes at the round-off floor count as zero in the fallback rule', () => {
  const r = base({ value: 100.08377583671476, tolerance: { rel: 1e-4, after: 'richardson' } });
  // oscillating at 1e-13 relative (exact discretization): Richardson unavailable, fallback must pass
  const o = { levels: [100.08377583667657, 100.08377583665076, 100.08377583668346].map((value, i) => ({ value, h: 2 ** -i, dof: 100 * 4 ** i })) };
  const t = evaluateTarget(r, r.value as number, o, {});
  assert.equal(t.status, 'pass', t.reason);
  // a real oscillation (1e-3 relative, not shrinking) still fails
  const o2 = { levels: [100.0, 100.1, 100.0].map((value, i) => ({ value, h: 2 ** -i, dof: 100 * 4 ** i })) };
  const t2 = evaluateTarget({ ...r, value: 100.0, tolerance: { rel: 1e-2, after: 'richardson' } }, 100.0, o2, {});
  assert.equal(t2.status, 'fail');
});

test('--skip: a skipped case is pending with the reason, the source is not called', async () => {
  const lc = parseCase(caseYaml({ id: 'XX-02' }), 'x.yaml');
  assert.deepEqual(lc.issues.filter((i) => i.severity === 'error'), []);
  let called = 0;
  const src: Source = { name: 'stub', describe: () => 'stub', plan: async () => ({ runnable: true, reason: '' }), observe: async () => { called++; return { kind: 'pending', reason: 'x' }; } };
  const r = await runCase(lc, src, { skip: ['XX-02'] });
  assert.equal(r.status, 'pending');
  assert.match(r.reason ?? '', /skipped by --skip/);
  assert.equal(called, 0);
});
