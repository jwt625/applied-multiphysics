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

test('evaluateTarget: Richardson gate (audit S3): extrapolated and finest in budget, order band, oscillatory', () => {
  const h = [0.4, 0.2, 0.1];
  const lv = h.map((x) => ({ value: 1 + 0.5 * x * x, h: x, wall_ms: 1 }));
  const r = evaluateTarget(ref({ rel: 1e-2, after: 'richardson' }), 1, { levels: lv }, { expectedOrder: 2 });
  assert.equal(r.status, 'pass'); close(r.value as number, 1, 1e-13); assert.equal(r.time_ms, 3);
  close(r.rate!.rate, 2, 1e-9); close(r.order_ratio!, 1, 1e-9);
  // u_num = GCI_fine * |f_fine| = 1.25 * (0.015 / 1.005) / 3 * 1.005 = 6.25e-3, reported next to the budget
  close(r.u_num!, 6.25e-3, 1e-10); close(r.limit!, 1e-2);
  // finest level 1.005 outside a 1e-3 budget: fail although f_ext is exact
  const fin = evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: lv }, { expectedOrder: 2 });
  assert.equal(fin.status, 'fail'); assert.match(fin.reason!, /finest level/);
  // observed order 1 vs theoretical 2 (ratio 0.5, band 0.25): Richardson unavailable (shared rule), gated on the
  // finest value + monotone error (Follow-up 3 item 4)
  const lo = h.map((x) => ({ value: 1 + 0.01 * x, h: x }));
  const o = evaluateTarget(ref({ rel: 1e-2, after: 'richardson' }), 1, { levels: lo }, { expectedOrder: 2 });
  assert.equal(o.status, 'pass'); assert.equal(o.richardson_fallback, 'finest+monotone'); assert.match(o.reason!, /outside the band 0.25 of the theoretical order 2/);   // changes 0.002, 0.001: shrinking
  close(o.value as number, 1.001, 1e-12);
  const loFar = h.map((x) => ({ value: 1 + 0.05 * x, h: x }));   // finest 1.005: outside a 1e-3 budget
  assert.equal(evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: loFar }, { expectedOrder: 2 }).status, 'fail');
  const wide = evaluateTarget(ref({ rel: 1e-2, after: 'richardson' }), 1, { levels: lo }, { expectedOrder: 2, orderBand: 0.6 });
  assert.equal(wide.status, 'pass'); assert.equal(wide.richardson_fallback, undefined); close(wide.value as number, 1, 1e-12);
  assert.equal(evaluateTarget(ref({ rel: 1e-2, after: 'richardson' }), 1, { levels: lo }, { expectedOrder: 2, orderCheck: false }).richardson_fallback, undefined);
  // oscillatory (non-nested meshes): fallback = finest within budget + |error| non-increasing (L4 DevLog-010 s.5)
  const osc = evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: [1, 0.9, 1.05].map((v, i) => ({ value: v, h: h[i]! })) });
  assert.equal(osc.status, 'fail'); assert.match(osc.reason!, /oscillatory.*fallback/);
  const fb = evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: [1 + 1e-3, 1 - 2e-4, 1 + 1.5e-6].map((v, i) => ({ value: v, h: h[i]! })) }, { expectedOrder: 2 });
  assert.equal(fb.status, 'pass'); assert.equal(fb.richardson_fallback, 'finest+monotone'); assert.match(fb.reason!, /richardson unavailable \(order not observed \(oscillatory\)\)/);
  // Follow-up 5 (M2 audit S5): finest within the budget AND shrinking level-to-level changes; non-monotone error = note
  // changes 1.5e-4 then 3.5e-4 (growing), finest 3e-4 within the budget -> fail
  const nm = evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: [1 + 1e-4, 1 - 5e-5, 1 + 3e-4].map((v, i) => ({ value: v, h: h[i]! })) });
  assert.equal(nm.status, 'fail'); assert.match(nm.reason!, /not shrinking/);
  // changes 3e-4 then 2.015e-4 (shrinking), error non-monotone -> pass with the note
  const nm3 = evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: [1 + 1e-4, 1 - 2e-4, 1 + 1.5e-6].map((v, i) => ({ value: v, h: h[i]! })) });
  assert.equal(nm3.status, 'pass'); assert.match(nm3.reason!, /note: \|error\| vs the reference is non-monotone/);
  // SM-02 audit numbers: changes 8.6 kPa then 0.2 kPa, finest -4.6e-4 vs a 1e-2 budget -> pass, error non-monotone noted
  const sm02 = evaluateTarget(ref({ rel: 1e-2, after: 'richardson' }), 92.7e6, { levels: [92.6576e6 - 8.6e3 + 0.2e3, 92.6576e6 - 0.2e3, 92.6576e6].map((v, i) => ({ value: v, h: h[i]! })) }, { expectedOrder: 2 });
  assert.equal(sm02.status, 'pass'); assert.match(sm02.reason!, /changes shrinking/);
  // stagnating or growing changes inside a loose budget: fail (no convergence evidence)
  const stag = evaluateTarget(ref({ rel: 1e-1, after: 'richardson' }), 1, { levels: [1.01, 1.02, 1.03].map((v, i) => ({ value: v, h: h[i]! })) }, { expectedOrder: 2 });
  assert.equal(stag.status, 'fail'); assert.match(stag.reason!, /not shrinking/);
  // HT-04 x = 0.0859 audit numbers: changes 4.6e-6 then 5.2e-7 degC, budget 0.099 degC -> pass
  const ht04 = evaluateTarget(ref({ abs: 0.099, after: 'richardson' }), 98.85282526, { levels: [98.8528 + 4.6e-6 - 5.2e-7, 98.8528 - 5.2e-7, 98.8528].map((v, i) => ({ value: v, h: h[i]! })) }, { expectedOrder: 2 });
  assert.equal(ht04.status, 'pass');
  const f = evaluateTarget(ref({ rel: 1e-3 }), 1, { levels: lv });
  assert.equal(f.status, 'fail'); close(f.diff!, 0.005);
  const info = evaluateTarget(ref({ rel: 1e-3 }, { gate: false }), 1, { levels: lv });
  assert.equal(info.status, 'info'); assert.equal(info.pass, false);
});

test('evaluateTarget: non-finite values fail the target with the level named (audit S1, M2)', () => {
  const n = evaluateTarget(ref({ rel: 1e-3, after: 'richardson' }), 1, { levels: [{ value: 1.1, h: 0.4 }, { value: NaN, h: 0.2 }, { value: 1.0, h: 0.1 }] });
  assert.equal(n.status, 'fail'); assert.match(n.reason!, /non-finite value at level 2 of 3/);
  const a = evaluateTarget(ref({ abs: 1 }), [1, 2], { levels: [{ value: [1, Infinity] }] });
  assert.equal(a.status, 'fail');
  const fs = evaluateTarget(ref({ rel: 0.5 }, { extract: { kind: 'field', field: 'u', samples_key: 'k' } }), undefined, { levels: [{ value: { values: [1, NaN, NaN, NaN] } }] }, { refSamples: [1, 2, 3, 4] });
  assert.equal(fs.status, 'fail'); assert.match(fs.reason!, /non-finite samples/);
  const ok = evaluateTarget(ref({ rel: 0.5 }, { extract: { kind: 'field', field: 'u', samples_key: 'k', max_dropped: 3 } }), undefined, { levels: [{ value: { values: [1, NaN, NaN, NaN] } }] }, { refSamples: [1, 2, 3, 4] });
  assert.equal(ok.status, 'pass');
  const e = evaluateTarget(ref({ rel: 1e-3 }, { extract: { kind: 'eigen' } }), [1, 2], { levels: [{ value: [1, 2, NaN] }] });
  assert.equal(e.status, 'fail'); assert.match(e.reason!, /non-finite eigenvalues/);
});

test('evaluateTarget: rule plus rel / abs applies both on the scalar path (audit M3)', () => {
  const lv = [0.4, 0.2, 0.1].map((x) => ({ value: 0.5 * x * x, h: x }));
  const r = evaluateTarget(ref({ abs: 1e-3, rule: { type: 'rate', min: 1.9 } }), 0, { levels: lv });
  assert.equal(r.status, 'fail'); assert.match(r.reason!, /tolerance missed/);
  assert.equal(evaluateTarget(ref({ abs: 1e-2, rule: { type: 'rate', min: 1.9 } }), 0, { levels: lv }).status, 'pass');
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
  const r = evaluateTarget(ref({ abs: 5e-3, after: 'richardson' }), ex, { levels: lv });
  assert.equal(r.status, 'pass');
  close((r.value as number[])[1]!, 0.5, 1e-12);
  assert.equal(evaluateTarget(ref({ abs: 1e-6, after: 'richardson' }), ex, { levels: lv }).status, 'fail');
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

test('B4 known answer: scalar eigen targets by index after floor; floor + offset double skip', () => {
  // free plate: 3 rigid modes (~1e-6), then 1.62, 2.36, 2.92 (FV12-like list)
  const comp = [2.92, 1e-6, 1.62, -2e-6, 2.36, 3e-7];
  const t = (index: number, v: number) => evaluateTarget(ref({ rel: 1e-3 }, { extract: { kind: 'eigen', floor: 0.01, index } }), v, { levels: [{ value: comp }] });
  assert.equal(t(0, 1.62).status, 'pass'); assert.equal(t(1, 2.36).status, 'pass'); assert.equal(t(2, 2.92).status, 'pass');
  assert.equal(t(3, 4.0).status, 'fail');
  assert.equal(evaluateTarget(ref({ rel: 1e-3 }, { extract: { kind: 'eigen', floor: 0.01 } }), 1.62, { levels: [{ value: comp }] }).status, 'error');
  // the old encoding: floor and offset 3 together skip the rigid modes twice -> unmatched
  const dbl = evaluateTarget(ref({ rel: 1e-3 }, { extract: { kind: 'eigen', floor: 0.01, offset: 3 } }), [1.62, 2.36], { levels: [{ value: comp }] });
  assert.equal(dbl.status, 'fail');
  assert.equal(evaluateTarget(ref({ rel: 1e-3 }, { extract: { kind: 'eigen', offset: 3 } }), [1.62, 2.36], { levels: [{ value: comp }] }).status, 'pass');
});

test('S2: eigen Richardson after matching; degenerate pair extrapolated as a subspace (cluster mean)', () => {
  // f0 = [1, 2, 2]; the degenerate pair splits by +-s(h) with an irregular s, mean converges as h^2
  const h = [0.4, 0.2, 0.1], s = [1e-3, 1e-4, 6e-4];
  const lv = h.map((x, i) => ({ value: [1 + 0.5 * x * x, 2 + 0.5 * x * x - s[i]!, 2 + 0.5 * x * x + s[i]!, 9], h: x }));
  const r = evaluateTarget(ref({ rel: 1e-2, after: 'richardson' }, { extract: { kind: 'eigen', match: 'subsequence' } }), [1, 2, 2], { levels: lv }, { expectedOrder: 2 });
  assert.equal(r.status, 'pass');
  const v = r.value as number[];
  close(v[0]!, 1, 1e-12);
  close((v[1]! + v[2]!) / 2, 2, 1e-12);       // cluster mean extrapolated exactly
  close(v[2]! - v[1]!, 2 * 6e-4, 1e-9);       // finest split kept
});

test('M11: subsequence matching with fewer computed than reference values keeps the partial assignment', () => {
  const m = matchEigen([1.0001, 3.0002], [1, 2, 3], { rel: 1e-3 }, { match: 'subsequence' });
  assert.equal(m.pairs.length, 2); assert.deepEqual(m.unmatched_refs, [1]); assert.equal(m.pass, false);
});

test('richardsonRule (shared with L4): band of the theoretical order, unavailable outside it', async () => {
  const { richardsonRule, RICHARDSON_ORDER_BAND } = await import('../src/metrics.ts');
  assert.equal(RICHARDSON_ORDER_BAND, 0.25);
  const h = [0.4, 0.2, 0.1];
  const q = richardsonRule(h.map((x) => 1 + x * x), h, { expectedOrder: 2 });
  assert.equal(q.available, true); close(q.f_ext!, 1, 1e-13); close(q.order_ratio!, 1, 1e-9);
  const p26 = richardsonRule(h.map((x) => 1 + x ** 2.6), h, { expectedOrder: 2 });   // ratio 1.3 > 1.25
  assert.equal(p26.available, false); assert.match(p26.reason!, /outside the band/);
  assert.equal(richardsonRule(h.map((x) => 1 + x ** 2.4), h, { expectedOrder: 2 }).available, true);   // 1.2 inside
  assert.equal(richardsonRule([1, 0.9, 1.05], h, { expectedOrder: 2 }).available, false);
  assert.equal(richardsonRule([1.02, 1.005], [0.2, 0.1], { expectedOrder: 2 }).available, false);
  const two = richardsonRule([1.02, 1.005], [0.2, 0.1], { expectedOrder: 2, allowAssumed: true });
  assert.equal(two.available, true); close(two.f_ext!, 1, 1e-12); assert.equal(two.fs, 3);
  const none = richardsonRule(h.map((x) => 1 + x * x), h);
  assert.equal(none.available, true); assert.match(none.reason!, /not checked/);
});

test('SM-01 numbers: unit 1 field target with abs 1e-3 is the relative L2 (5.86e-4 passes); explicit rel_l2 / rel_max', () => {
  // reference stresses ~1e8 Pa, error scaled to relative L2 5.86e-4 (RMS ~3.9e4 Pa, which must not meet abs 1e-3)
  const refS = Array.from({ length: 126 }, (_, i) => 1e8 * (1 + 0.5 * Math.sin(i)));
  const nr = Math.sqrt(refS.reduce((a, b) => a + b * b, 0));
  const dir = refS.map((_, i) => Math.cos(3 * i));
  const nd = Math.sqrt(dir.reduce((a, b) => a + b * b, 0));
  const eng = refS.map((v, i) => v + (5.86e-4 * nr * dir[i]!) / nd);
  const t = (tol: Reference['tolerance'], unit = '1') => evaluateTarget(ref(tol, { unit, extract: { kind: 'field', fields: ['sxx'], samples_key: 'k' } }), 0, { levels: [{ value: { values: eng } }] }, { refSamples: refS });
  const a = t({ abs: 1e-3, norm: 'l2' });
  assert.equal(a.status, 'pass'); assert.equal(a.field!.metric, 'l2_rel'); close(a.field!.measured, 5.86e-4, 1e-9);
  assert.equal(t({ abs: 5e-4, norm: 'l2' }).status, 'fail');
  assert.equal(t({ abs: 1e-3, norm: 'rel_l2' }, 'Pa').status, 'pass');
  const pa = t({ abs: 1e-3, norm: 'l2' }, 'Pa');                  // dimensional unit: abs is the RMS in Pa
  assert.equal(pa.status, 'fail'); assert.equal(pa.field!.metric, 'rms_abs');
  assert.equal(t({ abs: 1e-2, norm: 'rel_max' }).field!.metric, 'max_rel');
});

test('Follow-up 4: dt_with_h scales dt per level as h^(space_order / time_order)', async () => {
  const { dtFactorsFor } = await import('../src/registry.ts');
  const c = (conv: Record<string, unknown>) => ({ convergence: conv } as never);
  assert.deepEqual(dtFactorsFor(c({ h_factors: [1, 0.5, 0.25] }), [1, 0.5, 0.25]), [1, 1, 1]);
  const d = dtFactorsFor(c({ dt_with_h: true, space_order: 2, time_order: 1 }), [1, 0.5, 0.25]);
  assert.deepEqual(d, [1, 0.25, 0.0625]);
  const e = dtFactorsFor(c({ dt_with_h: true, expected_order: 2, time_order: 2 }), [1, 0.5, 0.25]);
  assert.deepEqual(e, [1, 0.5, 0.25]);
});

