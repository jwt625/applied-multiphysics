// SPDX-License-Identifier: GPL-3.0-or-later
// TS exact-field port: identities and reference values. The full gate against validation/a/fields.py is
// bench/fields-crosscheck.ts (needs uv); elliptic reference values below are mpmath 30-digit (2026-11-06).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ellipKE, legendre, sphJ, sphY, c, MU0 } from '../src/fields/special.ts';
import { evaluateFields, evaluateExactFieldTs } from '../src/fields/index.ts';

const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} vs ${b}`);

test('elliptic K, E vs mpmath', () => {
  const ref: Array<[number, number, number]> = [
    [0.05009392611145899, 1.59104252929158897, 1.55093575236968873],
    [0.5, 1.85407467730137192, 1.3506438810476755],
    [0.999, 4.84113256055029659, 1.00217079083444517],
  ];
  for (const [m, K, E] of ref) { const r = ellipKE(m); close(r.K, K, 1e-15); close(r.E, E, 1e-15); }
  const z = ellipKE(0); close(z.K, Math.PI / 2, 1e-15); close(z.E, Math.PI / 2, 1e-15);
});

test('spherical Bessel: j0, j1, y0 closed forms; Wronskian j_n y_{n-1} - j_{n-1} y_n = 1/x^2', () => {
  const x = 3.7;
  const J = sphJ(30, c(x)).map((v) => v.re), Y = sphY(30, x);
  close(J[0]!, Math.sin(x) / x, 1e-15); close(J[1]!, Math.sin(x) / (x * x) - Math.cos(x) / x, 1e-14); close(Y[0]!, -Math.cos(x) / x, 1e-15);
  for (const n of [1, 5, 12, 25]) close(J[n]! * Y[n - 1]! - J[n - 1]! * Y[n]!, 1 / (x * x), 1e-12);
  const P = legendre(3, 0.3); close(P[2]!, (3 * 0.09 - 1) / 2, 1e-15); close(P[3]!, (5 * 0.027 - 3 * 0.3) / 2, 1e-15);
});

test('closed-form identities at known points', () => {
  const k = evaluateFields('SM-01', [[0, 5e-3], [5e-3, 0]]).fields as Record<string, number[]>;
  close(k.sxx![0]!, 3e8, 1e-13); close(k.syy![1]!, -1e8, 1e-13);
  const h = evaluateFields('EM-04', [[0, 0]]).fields as Record<string, number[]>;
  close(h.B_z![0]!, ((4 / 5) ** 1.5 * MU0 * 1) / 0.1, 1e-13);
  const m = evaluateFields('WO-03', [[0, 0, 1e-3]]).fields.Ex as { re: number[]; im: number[] };
  assert.ok(Math.abs(Math.hypot(m.re[0]!, m.im[0]!) - 1) < 5e-3);
  const t = evaluateFields('TR-01', [[0], [1]]).fields.C_over_C0 as number[];
  assert.ok(t[0]! < 1 && t[1]! < t[0]!);
  const e = evaluateFields('CP-05', [[100e-9]]).fields.u as number[];
  assert.equal(e[0], 0);
});

test('evaluateExactFieldTs mirrors the CLI shape', async () => {
  const r = await evaluateExactFieldTs('validation/a/fields.py', 'FL-01-pois', 'u', [[0.5, 0.5]]);
  assert.deepEqual(r.values, [1]); assert.equal(r.unit, 'm/s');
  await assert.rejects(() => evaluateExactFieldTs('validation/b/other.py', 'SM-01', 'sxx', [[0, 1]]));
  assert.throws(() => evaluateFields('XX-99', [[0]]));
});
