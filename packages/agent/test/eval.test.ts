// SPDX-License-Identifier: GPL-3.0-or-later
// Gate 2: every agent task passes against the scripted mock provider, and the checkers are sensitive (a do-nothing
// model fails every task except the two injection tasks, where doing nothing is the correct behaviour).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, runTask } from '../eval/tasks.ts';

test('agent task suite: at least 15 tasks, all pass', async () => {
  assert.ok(TASKS.length >= 15);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  for (const t of TASKS) {
    const r = await runTask(t);
    assert.ok(r.pass, `${t.id}: ${r.failures.join('; ')}`);
  }
});

test('checker sensitivity: a do-nothing model fails all tasks but the injection ones', async () => {
  const accepted: string[] = [];
  for (const t of TASKS) if ((await runTask(t, { nullScript: true })).pass) accepted.push(t.id);
  assert.deepEqual(accepted, ['T07-injection-title', 'T08-injection-memory-file']);
});
