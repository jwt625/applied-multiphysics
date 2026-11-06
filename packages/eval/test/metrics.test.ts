// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkField, checkScalar, convergenceRateFit, evalRule, fieldError, hFromDof, matchEigen, observedOrder, richardson,
} from '../src/metrics.ts';
import { evaluateTarget } from '../src/evaluate.ts';
import type { Reference } from '../src/loader.ts';

const close = (a: number, b: number, tol = 1e-12) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test('checkScalar: rel, abs, max(abs, rel), zero reference', () => {
  const a = checkScalar(1.0005, 1, { rel: 1e-3 });
  close(a.diff, 5e-4); close(a.limit, 1e-3); assert.equal(a.limit_basis, 'rel'); assert.equal(a.pass, true);
  assert.equal(checkScalar(1.002, 1, { rel: 1e-3 }).pass, false);
  assert.equal(checkScalar(-0.9995, -1, { rel: 1e-3 }).pass, true);
  const b = checkScalar(0.00105, 0.001, { abs: 1e-4, rel: 1e-2 });
  close(b.limit, 1e-4); assert.equal(b.limit_basis, 'max(abs,rel)'); assert.equal(b.pass, true);
  const z = checkScalar(1e-9, 0, { rel: 1e-3 });
  assert.equal(z.rel_err, Infinity); assert.equal(z.limit, 0); assert.equal(z.pass, false);
  assert.equal(checkScalar(1e-9, 0, { abs: 1e-6 }).pass, true);
  assert.equal(checkScalar(NaN, 1, { abs: 1 }).pass, false);
});

test('fieldError: L2 and max, non-finite samples dropped', () => {
  const e = fieldError([1, 2, 3, NaN], [1, 2, 4, 5]);
  assert.equal(e.n, 3); assert.equal(e.n_dropped, 1);
  close(e.l2_rel, 1 / Math.sqrt(21)); close(e.rms_abs, Math.sqrt(1 / 3)); close(e.max_abs, 1); close(e.max_rel, 0.25);
  const c = checkField(e, { rel: 0.3, norm: 'max' });
  assert.equal(c.metric, 'max_rel'); assert.equal(c.pass, true);
  assert.equal(checkField(e, { rel: 0.2 }).pass, false);
  assert.equal(checkField(e, { abs: 0.5 }).metric, 'rms_abs');
});

test('convergenceRateFit: err = 3 h^2 gives rate 2, C = 3', () => {
  const h = [0.1, 0.05, 0.025, 0.0125];
  const r = convergenceRateFit(h, h.map((x) => 3 * x * x));
  close(r.rate, 2); close(Math.exp(r.log_c), 3, 1e-10); close(r.r2, 1); assert.equal(r.n, 4);
  r.pairwise.forEach((p) => close(p, 2));
});

test('observedOrder: constant ratio, non-constant ratio, oscillatory, too few', () => {
  const h1 = [0.4, 0.2, 0.1];
  close(observedOrder(h1.map((h) => 1 + 0.5 * h * h), h1).p!, 2, 1e-10);
  const h2 = [1, 0.6, 0.25];
  close(observedOrder(h2.map((h) => 2 + h ** 1.5), h2).p!, 1.5, 1e-9);
  assert.deepEqual(observedOrder([1, 0.9, 1.05], h1), { p: null, reason: 'oscillatory' });
  assert.equal(observedOrder([1, 2], [1, 0.5]).reason, 'too_few_levels');
});

test('richardson: exact extrapolation and GCI (Celik eq. 5)', () => {
  const h = [0.4, 0.2, 0.1];
  const f = h.map((x) => 1 + 0.5 * x * x);
  const r = richardson(f, h);
  close(r.f_ext!, 1, 1e-13); close(r.p_obs!, 2, 1e-10); assert.equal(r.r, 2); assert.equal(r.fs, 1.25);
  const ea = (1.02 - 1.005) / 1.005;
  close(r.rel_change_last!, ea); close(r.gci_fine!, (1.25 * ea) / 3, 1e-10); close(r.u_abs!, r.gci_fine! * 1.005);
  const two = richardson([1.02, 1.005], [0.2, 0.1], { assumedOrder: 2 });
  close(two.f_ext!, 1); assert.equal(two.fs, 3); assert.equal(two.p_obs, null);
  assert.equal(richardson([1, 0.9, 1.05], h).f_ext, null);
});

test('hFromDof', () => { close(hFromDof(10000, 2), 0.01); close(hFromDof(1e6, 3), 0.01); });

test('matchEigen: floor, multiplicity groups, split', () => {
  const comp = [109.45, 0, 1e-9, 45.9, 109.43, 0, 167.9, 0];
  const m = matchEigen(comp, [45.897, 109.44, 109.44, 167.89], { rel: 1e-3 }, { floor: 1e-3 });
  assert.equal(m.n_dropped, 4); assert.equal(m.pass, true); assert.deepEqual(m.unmatched_refs, []);
  assert.equal(m.groups.length, 1); assert.equal(m.groups[0]!.multiplicity, 2);
  close(m.groups[0]!.split_rel, 0.02 / 109.44, 1e-9);
  assert.deepEqual(m.pairs.map((p) => p.value), [45.9, 109.43, 109.45, 167.9]);
});

test('matchEigen: subsequence skips a spurious mode that breaks sorted matching', () => {
  const comp = [10.001, 10.5, 20.002, 29.997];
  const ref = [30, 10, 20];
  assert.equal(matchEigen(comp, ref, { rel: 1e-3 }).pass, false);
  const s = matchEigen(comp, ref, { rel: 1e-3 }, { match: 'subsequence' });
  assert.equal(s.pass, true);
  assert.deepEqual(s.pairs.map((p) => [p.ref_index, p.value]), [[1, 10.001], [2, 20.002], [0, 29.997]]);
});

test('matchEigen: offset and missing modes', () => {
  const m = matchEigen([1, 2, 3], [2, 3, 4], { rel: 1e-6 }, { offset: 1 });
  assert.equal(m.pairs.length, 2); assert.deepEqual(m.unmatched_refs, [2]); assert.equal(m.pass, false);
});

test('evalRule: range, sign, monotonic, rate', () => {
  assert.equal(evalRule({ type: 'range', range: [5.57, 5.59] }, [5.58]).pass, true);
  assert.equal(evalRule({ type: 'range' }, [5.6], { bounds: [5.57, 5.59] }).pass, false);
  assert.equal(evalRule({ type: 'sign' }, [-3], { ref: -1 }).pass, true);
  assert.equal(evalRule({ type: 'sign', sign: 1 }, [-3]).pass, false);
  assert.equal(evalRule({ type: 'monotonic', direction: 'decreasing' }, [3, 2, 1]).pass, true);
  assert.equal(evalRule({ type: 'monotonic', direction: 'increasing' }, [1, 1, 2]).pass, false);
  assert.equal(evalRule({ type: 'rate', min: 1.9 }, [], { rate: 2.01 }).pass, true);
  assert.equal(evalRule({ type: 'rate', min: 1.9 }, [], {}).pass, false);
});

const ref = (tol: Reference['tolerance'], extra: Partial<Reference> = {}): Reference => ({
  quantity: 'q', unit: '1', tolerance: tol, basis: 'D', form: 'closed_form', provenance: { citation: 'c', locator: 'l', accessed: '2026-11-06' }, ...extra,
});

test('evaluateTarget: Richardson pass with GCI band, order flag, oscillatory fail, finest-level fail', () => {
  const h = [0.4, 0.2, 0.1];
  const lv = h.map((x) => ({ value: 1 + 0.5 * x * x, h: x, wall_ms: 1 }));
  const r = evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: lv });
  assert.equal(r.status, 'pass'); close(r.value as number, 1, 1e-13); assert.equal(r.time_ms, 3);
  close(r.rate!.rate, 2, 1e-9);
  // u_num = GCI_fine * |f_fine| = 1.25 * (0.015 / 1.005) / 3 * 1.005 = 6.25e-3, reported next to the 1e-3 budget
  close(r.u_num!, 6.25e-3, 1e-10); close(r.limit!, 1e-3);
  const o = evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: h.map((x) => ({ value: 1 + x, h: x })) }, { expectedOrder: 2 });
  assert.equal(o.status, 'pass'); close(o.order_ratio!, 0.5, 1e-9); assert.match(o.reason!, /not asymptotic/);
  const osc = evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: [1, 0.9, 1.05].map((v, i) => ({ value: v, h: h[i]! })) });
  assert.equal(osc.status, 'fail'); assert.match(osc.reason!, /oscillatory/);
  const f = evaluateTarget(ref({ rel: 1e-3 }), 1, { levels: lv });
  assert.equal(f.status, 'fail'); close(f.diff!, 0.005);
  const info = evaluateTarget(ref({ rel: 1e-3 }, { gate: false }), 1, { levels: lv });
  assert.equal(info.status, 'info'); assert.equal(info.pass, false);
});

test('evaluateTarget: eigen array, element-wise array, field samples', () => {
  const e = evaluateTarget(ref({ rel: 1e-3 }, { extract: { kind: 'eigen', floor: 1e-6 } }), [2, 1], { levels: [{ value: [0, 1.0001, 2.0001] }] });
  assert.equal(e.status, 'pass'); assert.equal(e.eigen!.n_dropped, 1);
  const a = evaluateTarget(ref({ abs: 0.1 }), [1, 2, 3], { levels: [{ value: [1, 2.05, 3.2] }] });
  assert.equal(a.status, 'fail'); close(a.diff!, 0.2);
  const s = evaluateTarget(ref({ rel: 0.3, norm: 'max' }, { extract: { kind: 'field', samples_key: 'k' } }), undefined, { levels: [{ value: { values: [1, 2, 3] } }] }, { refSamples: [1, 2, 4] });
  assert.equal(s.status, 'pass'); close(s.field!.measured, 0.25);
});

test('evaluateTarget: field rate rule over levels; monotonic of error over a sweep', () => {
  const h = [0.2, 0.1, 0.05];
  const rs = [1, 2, 3];
  const lv = h.map((x) => ({ value: { values: rs.map((v) => v * (1 + x * x)) }, h: x }));
  const f = evaluateTarget(ref({ rule: { type: 'rate', min: 1.9 } }, { extract: { kind: 'field', field: 'u', samples_key: 'k' } }), undefined, { levels: lv }, { refSamples: rs });
  assert.equal(f.status, 'pass'); close(f.rate!.rate, 2, 1e-9);
  const m = evaluateTarget(ref({ rule: { type: 'monotonic', direction: 'decreasing', of: 'error' } }), 73.079, { levels: [{ value: [74.5, 73.6, 73.2] }] });
  assert.equal(m.status, 'pass');
  const m2 = evaluateTarget(ref({ rule: { type: 'monotonic', direction: 'decreasing', of: 'error' } }), 73.079, { levels: [{ value: [74.5, 75.0, 73.2] }] });
  assert.equal(m2.status, 'fail');
});

test('evaluateTarget: element-wise Richardson on arrays; exact boundary stations kept', () => {
  const h = [0.4, 0.2, 0.1];
  const ex = [1, 0.5, 0];
  const lv = h.map((x) => ({ value: ex.map((v, i) => (i === 0 ? v : v + 0.3 * x * x)), h: x }));
  const r = evaluateTarget(ref({ abs: 1e-6, after: 'richardson' }), ex, { levels: lv });
  assert.equal(r.status, 'pass');
  close((r.value as number[])[1]!, 0.5, 1e-12);
});

test('evaluateTarget: range rule on bounds without a reference value', () => {
  const r = evaluateTarget(ref({ rule: { type: 'range' } }, { bounds: [0.0842, 0.0852] }), undefined, { levels: [{ value: 0.0847 }] });
  assert.equal(r.status, 'pass');
  assert.equal(evaluateTarget(ref({ rule: { type: 'range' } }, { bounds: [0.0842, 0.0852] }), undefined, { levels: [{ value: 0.09 }] }).status, 'fail');
});

test('evaluateTarget: sequence rules with a single value are pending, not fail', () => {
  const a = evaluateTarget(ref({ abs: 1e-3, rule: { type: 'rate', min: 2 } }), 0, { levels: [{ value: 0 }], exact: true });
  assert.equal(a.status, 'pending'); assert.match(a.reason!, /needs >= 2 mesh levels/);
  const b = evaluateTarget(ref({ rule: { type: 'monotonic', direction: 'decreasing', of: 'error' } }), 73.079, { levels: [{ value: 73.079 }], exact: true });
  assert.equal(b.status, 'pending');
  const c = evaluateTarget(ref({ rule: { type: 'rate', min: 1.9 } }, { extract: { kind: 'field', field: 'u', samples_key: 'k' } }), undefined, { levels: [{ value: { values: [1] } }] }, { refSamples: [1] });
  assert.equal(c.status, 'pending');
});

