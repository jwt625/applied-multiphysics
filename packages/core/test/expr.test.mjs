// Ported from eo-modulator-atlas/engine/tests/postproc.test.mjs at 0546007 (GPL-3.0-or-later). Changes: only the
// expression-language and unit tests are kept (lines 19-90 and the compileExpression / parseUnit assertions of test
// 'E4/E6/E7'); store, plot, derived, sweep and EO tests need EO run/config/store and stay with the postproc port (not
// L1). Imports point at ../src/expr.mjs and ../src/units.mjs (APA units superset with K: EO behaviour checked here).
// The evaluateGlobals assertions of 'E4/E6/E7' are dropped (postproc/evaluate.mjs is not in @amp/core).
// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileExpression, parseExpression, ExpressionError } from '../src/expr.mjs';
import { parseUnit, formatUnit, displayConversion, DIMLESS } from '../src/units.mjs';
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// ---- expression language -----------------------------------------------------------------------------------------

const constScope = (vars = {}) => ({ resolve: (n) => (Object.hasOwn(vars, n) ? { kind: 'const', ...vars[n] } : n === 'i' ? { kind: 'const', re: 0, im: 1, dim: DIMLESS } : null) });
const val = (src, vars) => compileExpression(src, constScope(vars)).constant;
const V = parseUnit('V').dim, M = parseUnit('m').dim;

test('expr: precedence and associativity', () => {
  assert.equal(val('1 + 2 * 3').re, 7);
  assert.equal(val('-2^2').re, -4);
  assert.equal(val('2^3^2').re, 512);
  assert.equal(val('2^-1').re, 0.5);
  assert.equal(val('(1 + 2) * 3').re, 9);
  assert.equal(val('8 / 4 / 2').re, 1);
  assert.equal(val('1 < 2 && 3 >= 3').re, 1);
  assert.equal(val('1 > 2 || !(1 == 1)').re, 0);
  assert.equal(val('if(2 != 2, 5, 6)').re, 6);
  assert.equal(val('max(1, 4, 2) - min(3, -1)').re, 5);
  assert.equal(val('atan2(1, 1) * 4').re, Math.PI);
  assert.ok(Math.abs(val('log10(1000)').re - 3) < 1e-15);
});

test('expr: complex arithmetic', () => {
  assert.deepEqual(val('i^2'), { re: -1, im: 0 });
  const s = val('sqrt(-4)');
  assert.ok(Math.abs(s.re) < 1e-15 && Math.abs(s.im - 2) < 1e-15);
  assert.equal(val('abs(3 + 4*i)').re, 5);
  assert.deepEqual(val('conj(1 + 2*i)'), { re: 1, im: -2 });
  assert.deepEqual(val('imag((1 + 2*i) * (3 - i))'), { re: 5, im: 0 });
  const e = val('exp(i * pi)', { pi: { re: Math.PI, dim: DIMLESS } });
  assert.ok(Math.abs(e.re + 1) < 1e-15 && Math.abs(e.im) < 1e-15);
  assert.throws(() => val('max(i, 1)'), /complex/);
  assert.throws(() => val('i < 1'), /real operands/);
});

test('expr: units are inferred and checked', () => {
  const vars = { u: { re: 2, dim: V }, d: { re: 4e-6, dim: M } };
  const c = compileExpression('u / d', constScope(vars));
  assert.equal(c.unit, 'V/m');
  assert.equal(c.constant.re, 5e5);
  assert.equal(compileExpression('sqrt(d^2)', constScope(vars)).unit, 'm');
  assert.equal(val('2[um]').re, 2e-6);
  assert.equal(compileExpression('d[1/m]', constScope(vars)).unit, '1');
  assert.throws(() => compileExpression('u + d', constScope(vars)), (e) => e instanceof ExpressionError && /incompatible units V and m/.test(e.message) && e.pos === 2);
  assert.throws(() => compileExpression('exp(d)', constScope(vars)), /dimensionless/);
  assert.throws(() => compileExpression('d^u', constScope(vars)), /exponent must be dimensionless/);
  assert.throws(() => compileExpression('min(u, d)', constScope(vars)), /incompatible/);
  assert.equal(displayConversion(parseUnit('V/m').dim, 'V/um').factor, 1e6);
  assert.throws(() => displayConversion(parseUnit('V/m').dim, 'pF/m'), /does not match/);
});

test('expr: errors and no evaluation of host code', () => {
  for (const src of ['', '1 +', '(1', '1)', 'foo(1)', 'sqrt', '1 2', 'a[', '"x"', 'x.constructor', '__proto__', 'process.exit(1)', 'this', 'a;b', '`x`']) {
    assert.throws(() => compileExpression(src, constScope()), ExpressionError, src);
  }
  assert.throws(() => parseExpression('1'.repeat(3000)), /longer than/);
  assert.throws(() => parseExpression('('.repeat(80) + '1' + ')'.repeat(80)), /nesting too deep/);
  assert.throws(() => compileExpression('sqrt(1, 2)', constScope()), /takes 1 argument/);
});

test('units: parser and formatting', () => {
  assert.deepEqual(parseUnit('pF/m'), { dim: parseUnit('F/m').dim, factor: 1e-12 });
  assert.equal(parseUnit('V*cm').factor, 1e-2);
  assert.equal(formatUnit(parseUnit('1/(V*um^2)').dim), '1/(V*m^2)');
  assert.ok(Math.abs(parseUnit('1/(V*um^2)').factor - 1e12) < 1e-3);
  assert.equal(parseUnit('kg').factor, 1);
  assert.equal(parseUnit('THz').factor, 1e12);
  assert.equal(formatUnit(parseUnit('W/um^2').dim), 'W/m^2');
  assert.throws(() => parseUnit('V/furlong'), /unknown unit/);
  assert.throws(() => parseUnit('2V'), /only the number 1/);
});

// ---- keep, store, identities -------------------------------------------------------------------------------------

test('E4/E6/E7 (expr part): one position per message, ambiguous exponent units', () => {
  assert.throws(() => compileExpression('1[min]', constScope()), (e) => /unit \[min\]: unknown unit 'min' at position 3$/.test(e.message));
  assert.throws(() => compileExpression('1 2', constScope()), /unexpected '2' at position 3/);
  assert.throws(() => compileExpression('2^2[um]', constScope()), /ambiguous/);
  assert.equal(compileExpression('(2^2)[um]', constScope()).unit, 'm');
  assert.equal(parseUnit('dB/cm').factor, 100);
});
