// SPDX-License-Identifier: GPL-3.0-or-later
// DevLog-055: the Richardson fallback (DevLog-039 H5) must not pass a sequence whose levels were not refined
// (stagnation: equal DOF repeats one solution, so its zero level changes are no convergence evidence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTarget, refinedLevels } from '../src/evaluate.ts';
import type { Reference } from '../src/loader.ts';

const base = (over: Partial<Reference> = {}): Reference => ({
  quantity: 'q', metric_id: 'q', value: 1, unit: '1', tolerance: { rel: 1e-6 }, basis: 'D', form: 'closed_form',
  provenance: { citation: 'c', locator: 'l', accessed: null }, ...over,
});

test('fallback: equal DOF on every level (stagnation) does not pass, even with zero changes inside the budget', () => {
  const r = base({ value: 100, tolerance: { rel: 1e-2, after: 'richardson' } });
  const o = { levels: [100.3, 100.3, 100.3].map((value, i) => ({ value, h: 2 ** -i, dof: 5000 })) };
  const t = evaluateTarget(r, 100, o, {});
  assert.equal(t.status, 'fail', t.reason);
  assert.match(t.reason ?? '', /levels not refined \(DOF 5000, 5000, 5000\)/);
  // one repeated level (DOF does not grow from level 2 to 3) is stagnation too
  const o2 = { levels: [100.4, 100.3, 100.3].map((value, i) => ({ value, h: 2 ** -i, dof: [2000, 5000, 5000][i]! })) };
  assert.equal(evaluateTarget(r, 100, o2, {}).status, 'fail');
});

test('fallback: refined levels that agree to round-off still pass (exact discretization, H5 unchanged)', () => {
  const r = base({ value: 100.08377583671476, tolerance: { rel: 1e-4, after: 'richardson' } });
  const o = { levels: [100.08377583667657, 100.08377583665076, 100.08377583668346].map((value, i) => ({ value, h: 2 ** -i, dof: 100 * 4 ** i })) };
  assert.equal(evaluateTarget(r, r.value as number, o, {}).status, 'pass');
  // h only (no DOF): strictly decreasing h counts as refined; constant h does not
  const oh = { levels: o.levels.map(({ value, h }) => ({ value, h })) };
  assert.equal(evaluateTarget(r, r.value as number, oh, {}).status, 'pass');
  const oc = { levels: o.levels.map(({ value }) => ({ value, h: 0.5 })) };
  assert.equal(evaluateTarget(r, r.value as number, oc, {}).status, 'fail');
});

test('refinedLevels: DOF first, h when a DOF is missing, nothing known is not refined', () => {
  assert.deepEqual(refinedLevels([10, 20, 40]), { refined: true, detail: 'DOF 10, 20, 40' });
  assert.equal(refinedLevels([10, 10, 40]).refined, false);
  assert.equal(refinedLevels([10, undefined, 40], [1, 0.5, 0.25]).refined, true);
  assert.equal(refinedLevels(undefined, [1, 1, 0.25]).refined, false);
  assert.equal(refinedLevels(undefined, [1, NaN, 0.25]).refined, false);
});

test('loader: a result term needs node; usesResult sees nested result terms', async () => {
  const { usesResult } = await import('../src/registry.ts');
  assert.equal(usesResult({ kind: 'expr', expr: 'a', terms: { a: { kind: 'expr', expr: 'b', terms: { b: { kind: 'result', node: 'x' } } } } }), true);
  assert.equal(usesResult({ kind: 'expr', expr: 'a', terms: { a: { kind: 'scalar', name: 'x' } } }), false);
  const { parseCase } = await import('../src/loader.ts');
  const { caseYaml } = await import('./helpers.ts');
  const y = caseYaml({ id: 'XX-09', refExtra: '\n    extract: {kind: expr, expr: "a", terms: {a: {kind: result}}}' });
  const issues = parseCase(y, 'x.yaml').issues.filter((i) => i.severity === 'error').map((i) => i.message);
  assert.ok(issues.some((m) => /result term needs node/.test(m)), issues.join('; '));
});
