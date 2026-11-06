// Ported from eo-modulator-atlas/engine/tests/sweep-enumeration.test.mjs at 0546007 (GPL-3.0-or-later). Changes: the
// EO config text (PARAM_GSG) and the EO solver are replaced by the same sweep axes passed directly to the generic API
// (parametricStudy / pointValues / runSweep) and a synthetic point runner; the assertions on enumeration order, ranges,
// axis errors, swept-override rejection, index range, cancellation and per-point errors are kept with the same values
// and messages. Dropped (EO solver / spec-level, not in @amp/core): study selection by name ('several studies',
// 'unknown study'), 'expected parametric', sweep_targets tolerance, VpiL closed forms, mesh / ES reuse.
// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parametricStudy, pointValues, enumeratePoints, rejectSweptOverrides, runSweep, MAX_STUDY_POINTS } from '../src/sweep.mjs';

const PARAMS = { g_um: { value: 2 }, lambda_nm: { value: 1550 } };
const GRID = [{ param: 'g_um', values: [2, 3, 4] }, { param: 'lambda_nm', values: [1500, 1600] }];

test('sweep: enumeration order (nested, last axis fastest), ranges, errors', () => {
  const grid = parametricStudy(GRID, { params: PARAMS });
  assert.equal(grid.nPoints, 6);
  const pts = enumeratePoints(grid);
  assert.deepEqual(pts.map((p) => [p.values.g_um, p.values.lambda_nm]), [[2, 1500], [2, 1600], [3, 1500], [3, 1600], [4, 1500], [4, 1600]]);
  assert.deepEqual(pts.map((p) => p.index), [0, 1, 2, 3, 4, 5]);
  const wl = parametricStudy([{ param: 'lambda_nm', range: { start: 1500, stop: 1600, n: 3 } }], { params: PARAMS });
  assert.deepEqual(wl.axes[0].values, [1500, 1550, 1600]);
  const gap = parametricStudy([{ param: 'g_um', values: [2, 3] }], { params: PARAMS });
  assert.throws(() => rejectSweptOverrides(gap, { g_um: 3 }), /swept by the study/);
  rejectSweptOverrides(gap, { lambda_nm: 1500 });
  const bad = (sweep, re) => assert.throws(() => parametricStudy(sweep, { params: PARAMS }), re);
  bad([{ param: 'zz', values: [1] }], /unknown parameter zz/);
  bad([{ param: 'g_um', values: [] }], /non-empty array/);
  bad([{ param: 'g_um', values: [1], range: { start: 1, stop: 2, n: 2 } }], /exactly one of values or range/);
  bad([{ param: 'g_um', range: { start: 1, stop: 2, n: 0 } }], /integer >= 1/);
  bad([{ param: 'g_um', values: [2] }, { param: 'g_um', values: [3] }], /swept twice/);
  bad([{ param: 'g_um', range: { start: 1, stop: 2, n: 3000 } }], /exceed the limit/);
  assert.equal(MAX_STUDY_POINTS, 2000);
  assert.throws(() => pointValues(gap, 9), /outside 0\.\.1/);
});

test('sweep: sequential run, per-point callbacks, results in point order', async () => {
  const gap = parametricStudy([{ param: 'g_um', values: [2, 3] }], { params: PARAMS });
  const seen = [];
  const r = await runSweep(gap, (v) => ({ y: 10 * v.g_um }), {}, (p, done, total) => seen.push([p.index, done, total]));
  assert.deepEqual(seen, [[0, 1, 2], [1, 2, 2]]);
  assert.equal(r.errors, 0);
  assert.deepEqual(r.points.map((p) => p.result.y), [20, 30]);
  assert.equal(r.cancelled, false);
});

test('sweep: cancellation and point errors', async () => {
  const grid = parametricStudy(GRID, { params: PARAMS });
  const ac = new AbortController();
  const r = await runSweep(grid, () => 1, { signal: ac.signal }, (p, done) => { if (done === 2) ac.abort(); });
  assert.equal(r.cancelled, true);
  assert.equal(r.completed, 2);
  // A failing point records the error and the sweep continues (EO: g_um = 0.1 inverted the arm windows).
  const e = await runSweep(parametricStudy([{ param: 'g_um', values: [0.1, 2] }, { param: 'lambda_nm', values: [1500, 1600] }], { params: PARAMS }),
    (v) => { if (v.g_um < 1) throw new Error('x_um: window inverted'); return 1; });
  assert.equal(e.errors, 2);
  assert.match(e.points[0].error, /x_um/);
  assert.equal(e.points[2].error, null);
  const s = await runSweep(grid, () => { throw new Error('boom'); }, { stopOnError: true });
  assert.equal(s.completed, 1);
});
