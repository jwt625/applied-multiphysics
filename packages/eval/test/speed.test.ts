// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceedThroughput, median, stageMedians, throughputSummary, timeRuns, timeToAccuracy } from '../src/speed.ts';

const close = (a: number, b: number, tol = 1e-12) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('timeRuns: one warm-up discarded, median of 5, stage medians', async () => {
  // fake clock: run i takes durations[i] ms
  const durations = [100, 5, 3, 4, 1, 2];
  let t = 0, i = 0;
  const now = () => t;
  const fn = () => { t += durations[i]!; const s = { timing: { solve: durations[i]! * 2 } }; i++; return s; };
  const r = await timeRuns(fn, { now });
  assert.deepEqual(r.summary.warmup_ms, [100]);
  assert.deepEqual(r.summary.samples_ms, [5, 3, 4, 1, 2]);
  assert.equal(r.summary.median_ms, 3);
  assert.equal(r.summary.mad_ms, 1);
  assert.deepEqual(r.summary.stages_median_ms, { solve: 6 });
});

test('stageMedians over missing stages', () => {
  assert.deepEqual(stageMedians([{ a: 1, b: 4 }, { a: 3 }, { a: 2, b: 6 }]), { a: 2, b: 5 });
});

test('timeToAccuracy: first level, cumulative, log-log interpolation', () => {
  const r = timeToAccuracy([
    { level: 0, dof: 100, wall_ms: 10, error: 1e-1 },
    { level: 1, dof: 1000, wall_ms: 100, error: 1e-2 },
    { level: 2, dof: 10000, wall_ms: 1000, error: 1e-4 },
  ], 1e-3);
  assert.equal(r.reached, true); assert.equal(r.level, 2); assert.equal(r.t_level_ms, 1000); assert.equal(r.t_cum_ms, 1110);
  close(r.t_interp_ms!, 100 * Math.sqrt(10), 1e-12);
  close(r.dof_per_s!, 10000);
  const n = timeToAccuracy([{ level: 0, dof: 1, wall_ms: 1, error: 0.5 }], 1e-3);
  assert.equal(n.reached, false); assert.equal(n.min_error, 0.5);
});

test('ceedThroughput and summary', () => {
  const t = ceedThroughput(1e6, 100, 2);
  assert.equal(t.dof_per_s, 5e7); assert.equal(t.mdof_per_s, 50);
  assert.throws(() => ceedThroughput(1, 1, 0));
  const s = throughputSummary([{ dof: 1e3, dof_per_s: 1e6 }, { dof: 1e4, dof_per_s: 8.5e6 }, { dof: 1e5, dof_per_s: 1e7 }]);
  assert.equal(s.r_max, 1e7); assert.equal(s.n_08, 1e4); close(s.t_08_s!, 1.25e-3);
});
