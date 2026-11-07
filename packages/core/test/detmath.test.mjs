// SPDX-License-Identifier: GPL-3.0-or-later
// detmath (moved from @amp/geom, DevLog-004 s.9 / DevLog-002 s.10) and the detmath path of @amp/core/expr:
// accuracy against Math.*, special values, and the cross-runtime fixture fixtures/detmath-xplat.json (SHA-256 of the
// output bits on 4000 fixed inputs per function, recorded in headless Chromium by fixtures/gen-detmath-xplat.mjs):
// Node must reproduce the Chromium digests of detmath and expr exactly; the Math.* digests in the fixture differ
// between the engines, which shows the fixture bites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as D from '../src/detmath.ts';
import { compileExpression } from '../src/expr.mjs';
import { DIMLESS } from '../src/units.mjs';
import { evaluate, inputs } from './helpers/detmath-xplat.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/detmath-xplat.json', import.meta.url), 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('detmath: accuracy against Math on the fixture inputs (sin/cos/atan2 absolute, log/exp relative)', () => {
  const I = inputs();
  let s = 0, c = 0, a = 0, l = 0, e = 0;
  for (const x of I.sin) { s = Math.max(s, Math.abs(D.sin(x) - Math.sin(x))); c = Math.max(c, Math.abs(D.cos(x) - Math.cos(x))); }
  for (const [y, x] of I.atan2) a = Math.max(a, Math.abs(D.atan2(y, x) - Math.atan2(y, x)));
  for (const x of I.log) l = Math.max(l, Math.abs(D.log(x) - Math.log(x)) / Math.max(1e-300, Math.abs(Math.log(x))));
  for (const x of I.exp) e = Math.max(e, Math.abs(D.exp(x) - Math.exp(x)) / Math.exp(x));
  // measured 2026-11-06: 1.1e-16, 1.1e-16, 8.9e-16, 2.2e-16, 2.2e-16
  assert.ok(s <= 2.3e-16 && c <= 2.3e-16, `sin ${s} cos ${c}`);
  assert.ok(a <= 1.8e-15, `atan2 ${a}`);
  assert.ok(l <= 4.5e-16 && e <= 4.5e-16, `log ${l} exp ${e}`);
});

test('detmath: special values and exact helpers', () => {
  assert.deepEqual(D.sinCos(0), [0, 1]);
  assert.ok(Object.is(D.sin(-0), -0));
  assert.ok(D.sinCos(Infinity).every(Number.isNaN));
  assert.equal(D.atan2(0, -1), Math.PI);
  assert.equal(D.atan2(-0, -1), -Math.PI);
  assert.equal(D.atan2(1, 0), Math.PI / 2);
  assert.equal(D.log(1), 0);
  assert.equal(D.log(0), -Infinity);
  assert.ok(Number.isNaN(D.log(-1)));
  assert.equal(D.exp(0), 1);
  assert.equal(D.exp(1000), Infinity);
  assert.equal(D.exp(-1000), 0);
  assert.equal(D.ldexp(1.5, -1074 + 1), 1.5 * 2 ** -1073);
  assert.deepEqual(D.frexp(12), [1.5, 3]);
  for (const x of [0.7, 1, 1.4142, 1.4143, 3, 1e-9, 7e12]) assert.equal(D.roundLog2(x), Math.round(Math.log2(x)), String(x));
  assert.equal(D.hyp2(3, 4), 5);
});

test('cross-runtime: Node reproduces the headless-Chromium digests of detmath and expr bit for bit', () => {
  const node = Object.fromEntries(Object.entries(evaluate(D, compileExpression, DIMLESS)).map(([k, v]) => [k, sha(v)]));
  assert.ok(FX.chromium.length >= 1);
  for (const run of FX.chromium) {
    for (const k of Object.keys(run.digests).filter((q) => !q.startsWith('math.'))) assert.equal(node[k], run.digests[k], `${k}: Node ${process.version} vs Chromium ${run.version}`);
  }
  // the fixture bites: Math.* gave different bits in Chromium and in Node when it was generated
  for (const d of FX.differFromNode) assert.deepEqual(d.keys.sort(), ['math.atan2', 'math.cos', 'math.exp', 'math.log', 'math.pow', 'math.sin']);
  // expr evaluates through detmath: identical bits
  for (const f of ['sin', 'cos', 'atan2', 'log', 'exp']) assert.equal(node[`expr.${f}`], node[`det.${f}`], f);
});

test('expr ^: integer and constant exponents exact, sqrt for 0.5, general exponents within 1e-14 of Math', () => {
  const c = (s) => compileExpression(s, { resolve: () => null }).constant.re;
  assert.equal(c('10^-4'), 1e-4);
  assert.equal(c('(-8)^3'), -512);
  assert.equal(c('2^0.5'), Math.SQRT2);
  assert.equal(c('0^2'), 0);
  const f = (vals) => ({ resolve: (n) => (n in vals ? { kind: 'field', key: n, dim: DIMLESS, complex: false, continuous: true } : null) });
  const a = Float64Array.from([3, 1.1, 7, -2]), b = Float64Array.from([5, -3, 0, 3]);
  const r = compileExpression('a^b', f({ a, b })).run({ n: 4, get: (k) => ({ re: k === 'a' ? a : b, im: null }) }).re;
  assert.deepEqual(Array.from(r), [243, 1 / (1.1 * 1.1 * 1.1), 1, -8]);
  const I = inputs();
  const A = Float64Array.from(I.pow.map((p) => p[0])), B = Float64Array.from(I.pow.map((p) => p[1]));
  const R = compileExpression('a^b', f({ a: A, b: B })).run({ n: A.length, get: (k) => ({ re: k === 'a' ? A : B, im: null }) }).re;
  let e = 0;
  for (let i = 0; i < A.length; i++) e = Math.max(e, Math.abs(R[i] - A[i] ** B[i]) / Math.abs(A[i] ** B[i]));
  assert.ok(e < 1e-14, `pow ${e}`);
});
