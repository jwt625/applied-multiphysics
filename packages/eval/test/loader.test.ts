// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatIssue, parseCase, referenceValue } from '../src/loader.ts';
import { Validator } from '../src/schema-validate.ts';
import { caseYaml } from './helpers.ts';

const opts = { stem: 'XX-01', dirClass: 'a', today: '2026-11-06' };
const errors = (text: string, o: Parameters<typeof parseCase>[2] = opts) => parseCase(text, 'eval/cases/a/XX-01.yaml', o).issues.filter((i) => i.severity === 'error');

test('minimal valid case: no issues', () => {
  const lc = parseCase(caseYaml(), 'eval/cases/a/XX-01.yaml', opts);
  assert.deepEqual(lc.issues.map(formatIssue), []);
  assert.equal(lc.data?.id, 'XX-01');
});

test('unknown key: error at the key with line and column', () => {
  const e = errors(caseYaml({ extra: 'tolerence: 3\n' }));
  assert.equal(e.length, 1);
  assert.equal(e[0]!.path, '/tolerence');
  assert.equal(e[0]!.keyword, 'additionalProperties');
  assert.equal(e[0]!.line, 20);
  assert.equal(e[0]!.col, 1);
});

test('x- extension keys are allowed', () => {
  assert.deepEqual(errors(caseYaml({ extra: 'x-lane-note: anything\n' })), []);
});

test('nested unknown key inside a reference', () => {
  const e = errors(caseYaml({ refExtra: '\n    tolerence: {rel: 1}' }));
  assert.equal(e.length, 1);
  assert.equal(e[0]!.path, '/references/0/tolerence');
  assert.equal(e[0]!.line, 18);
});

test('tolerance without rel, abs or rule', () => {
  const e = errors(caseYaml({ tol: '{after: finest}' }));
  assert.equal(e.length, 1);
  assert.equal(e[0]!.path, '/references/0/tolerance');
  assert.match(e[0]!.message, /no alternative matches/);
});

test('wrong type, enum and date format are reported with paths', () => {
  const t = caseYaml().replace('class: a', 'class: d').replace('value: 1', 'value: "one"').replace('accessed: 2026-11-06', 'accessed: 2026-13-01');
  const e = errors(t);
  const paths = e.map((x) => x.path).sort();
  assert.ok(paths.includes('/class'));
  assert.ok(paths.includes('/references/0/value'));
  assert.ok(paths.includes('/references/0/provenance/accessed'));
});

test('missing required top-level key', () => {
  const e = errors(caseYaml().replace(/rights: .*\n/, ''));
  assert.equal(e.length, 1);
  assert.equal(e[0]!.path, '');
  assert.match(e[0]!.message, /missing required key 'rights'/);
});

test('id vs file name and class vs directory', () => {
  const e = errors(caseYaml({ id: 'XX-02', cls: 'b' }));
  assert.deepEqual(e.map((x) => x.keyword).sort(), ['class-dir', 'id-filename']);
});

test('untestable needs a reason', () => {
  const t = caseYaml().replace('status: unvalidated', 'status: untestable');
  const e = errors(t);
  assert.equal(e.length, 1);
  assert.match(e[0]!.message, /untestable_reason/);
  assert.deepEqual(errors(t + 'untestable_reason: "input X not disclosed (paper p. 3)"\n'), []);
});

test('future accessed date is an error', () => {
  const e = errors(caseYaml(), { ...opts, today: '2026-11-05' });
  assert.equal(e.length, 1);
  assert.equal(e[0]!.keyword, 'future-date');
});

test('duplicate YAML key is a parse error with position', () => {
  const e = errors(caseYaml() + 'title: again\n');
  assert.equal(e[0]!.keyword, 'yaml');
  assert.ok(e[0]!.line! > 1);
});

test('spec: sims ref, pending and bad forms', () => {
  assert.deepEqual(errors(caseYaml({ spec: 'sims/xx-01.yaml' })), []);
  assert.deepEqual(errors(caseYaml({ spec: '{status: pending, reason: "no physics module yet"}' })), []);
  const e = errors(caseYaml({ spec: 'pending' }));
  assert.equal(e.length, 1);
  assert.equal(e[0]!.path, '/spec');
});

test('expected link: metric_id resolved from the expected JSON; missing entry, file mismatch, accessed null', () => {
  const meta = { case: 'XX-01', generator: 'g', versions: {}, generated_at: '2026-11-06T00:00:00-08:00' };
  const t = caseYaml().replace('    value: 1\n', '    expected: {file: eval/expected/XX-01.json, metric_id: q.dot.1}\n');
  const o = { ...opts, expectedFile: 'eval/expected/XX-01.json' };
  const ok = parseCase(t, 'f', { ...o, expectedText: JSON.stringify({ ...meta, targets: [{ metric_id: 'q.dot.1', value: 2.5 }] }) });
  assert.deepEqual(ok.issues, []);
  assert.equal(referenceValue(ok.data!.references[0]!, ok.expected), 2.5);
  const bad = parseCase(t, 'f', { ...o, expectedText: JSON.stringify({ ...meta, targets: [] }) });
  assert.ok(bad.issues.some((i) => i.keyword === 'expected-key' && i.severity === 'error'));
  const none = parseCase(t, 'f', { ...o, expectedText: null });
  assert.ok(none.issues.some((i) => i.keyword === 'expected-missing'));
  const other = parseCase(t.replace('file: eval/expected/XX-01.json', 'file: eval/expected/YY-01.json'), 'f', { ...o, expectedText: '{}' });
  assert.ok(other.issues.some((i) => i.keyword === 'expected-file'));
  const differs = parseCase(caseYaml({ refExtra: '\n    expected: {metric_id: q}' }), 'f', { ...o, expectedText: JSON.stringify({ ...meta, targets: [{ metric_id: 'q', value: 1.001 }] }) });
  assert.deepEqual(differs.issues.map((i) => [i.severity, i.keyword]), [['warning', 'value-vs-expected']]);
  assert.deepEqual(errors(caseYaml().replace('basis: D', 'basis: P').replace('accessed: 2026-11-06', 'accessed: null')).map((i) => i.keyword), ['accessed-required']);
  assert.deepEqual(errors(caseYaml().replace('accessed: 2026-11-06', 'accessed: null')), []);
});

test('richardson needs levels_min >= 3', () => {
  const t = caseYaml().replace('levels_min: 3', 'levels_min: 2').replace('h_factors: [1, 0.5, 0.25]', 'h_factors: [1, 0.5]');
  assert.deepEqual(errors(t).map((x) => x.keyword), ['richardson-levels']);
});

test('validator: unsupported keyword throws at compile time', () => {
  assert.throws(() => new Validator({ type: 'object', dependentRequired: {} }), /unsupported keyword 'dependentRequired'/);
});

test('validator: oneOf with two matches is an error', () => {
  const v = new Validator({ oneOf: [{ type: 'number' }, { minimum: 0 }] });
  assert.equal(v.validate(1).length, 1);
  assert.equal(v.validate(-1).length, 0);
});

test('rule shorthand within_bounds normalizes to {type: range}; prose rule is an error', () => {
  const lc = parseCase(caseYaml({ tol: '{rule: within_bounds}', refExtra: '\n    bounds: [0.5, 1.5]' }), 'eval/cases/a/XX-01.yaml', opts);
  assert.deepEqual(lc.issues.filter((i) => i.severity === 'error'), []);
  assert.deepEqual(lc.data!.references[0]!.tolerance.rule, { type: 'range' });
  const e = errors(caseYaml({ tol: "{rule: 'rate >= p on 3 meshes'}" }));
  assert.equal(e.length, 1); assert.equal(e[0]!.path, '/references/0/tolerance/rule');
});

