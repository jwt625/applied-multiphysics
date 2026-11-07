// SPDX-License-Identifier: GPL-3.0-or-later
// R1 gates 1-6 on real engine solves (gates/r1-gates.ts; DevLog-026 s.5) and the gate 7 fixture hash (Node side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runR1Gates } from '../gates/r1-gates.ts';
import { gate7Fixture } from '../gates/fixture-r1.ts';

test('R1 gates 1-6: errors decrease at the expected order on nested levels', async () => {
  const { rows } = await runR1Gates();
  for (const g of ['1', '2', '3', '4', '4b', '5a', '5b', '5c', '6']) assert.ok(rows.some((r) => r.gate === g), `gate ${g} present`);
  const bad = rows.filter((r) => r.status === 'fail');
  assert.deepEqual(bad.map((r) => `${r.gate}: orders ${r.orders.map((p) => p.toFixed(2)).join(', ')}, finest ${r.finest_error}`), []);
});

test('gate 7 fixture: deterministic, and the Node hash matches the recorded value', async () => {
  const exp = JSON.parse(readFileSync(new URL('../gates/fixture-r1.expected.json', import.meta.url), 'utf8')) as { sha256: string; count: number };
  const a = await gate7Fixture(), b = await gate7Fixture();
  assert.deepEqual(a, b);
  assert.equal(a.count, exp.count);
  assert.equal(a.sha256, exp.sha256);
});
