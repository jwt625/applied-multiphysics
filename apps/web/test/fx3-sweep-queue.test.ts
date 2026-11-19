// SPDX-License-Identifier: GPL-3.0-or-later
// Fix lane FX3-web (DevLog-067 items 1 and 5): the sweep evaluation queue evaluates every point once (a point in flight,
// waiting or evaluated is not queued again; the drain skips a point evaluated while it waited), drops the oldest
// waiting point beyond the cap (state skipped), clears on a new sweep / cancel; gap reasons per state and a failed
// group's error. Fake evaluator counting calls; expected counts written out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SweepEvalQueue, evalCounts, evalGaps, tableFailure, type EvalSweepLike, type SweepEval } from '../src/lib/workbench/sweep-evals.ts';
import type { ResultTable } from '../src/lib/results/api.ts';

type Job = { tok: number; i: number };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function harness(cap = 8) {
	const evals = new Map<number, number>();
	const calls: number[] = [];
	let release: Array<() => void> = [];
	let tok = 1;
	const q = new SweepEvalQueue<Job>(
		async (j) => {
			calls.push(j.i);
			await new Promise<void>((r) => release.push(r));
			if (j.tok === tok) evals.set(j.i, 42);
		},
		(j) => j.tok !== tok || evals.has(j.i),
		cap
	);
	const finish = async () => { for (let k = 0; k < 50; k++) { const r = release; release = []; r.forEach((f) => f()); await tick(); } };
	return { q, calls, evals, finish, newSweep: () => { tok++; q.clear(); }, tok: () => tok };
}

test('a solved point queued by onPoint and again by showPoint (same tick) is evaluated once', async () => {
	const h = harness();
	for (let i = 0; i < 4; i++) {
		assert.equal(h.q.push({ tok: h.tok(), i }), true);
		assert.equal(h.q.push({ tok: h.tok(), i }), false, 'in flight or waiting: not queued again');
	}
	assert.equal(h.q.state(h.tok(), 0), 'running');
	assert.equal(h.q.state(h.tok(), 3), 'queued');
	await h.finish();
	assert.deepEqual(h.calls, [0, 1, 2, 3]);
	assert.equal(h.q.push({ tok: h.tok(), i: 2 }), false, 'evaluated: not queued again (showPoint later)');
	await h.finish();
	assert.deepEqual(h.calls, [0, 1, 2, 3]);
	assert.equal(h.q.state(h.tok(), 2), null);
});

test('the drain skips a point evaluated while it waited', async () => {
	const h = harness();
	h.q.push({ tok: h.tok(), i: 0 });
	h.q.push({ tok: h.tok(), i: 1 });
	h.evals.set(1, 7); // evaluated elsewhere while waiting
	await h.finish();
	assert.deepEqual(h.calls, [0]);
});

test('cap: the oldest waiting point is skipped (state skipped) and can be queued again when shown', async () => {
	const h = harness(2);
	for (let i = 0; i < 5; i++) h.q.push({ tok: h.tok(), i });
	// 0 in flight; waiting 1, 2, 3, 4 -> cap 2 drops 1 and 2
	assert.equal(h.q.state(h.tok(), 0), 'running');
	assert.equal(h.q.state(h.tok(), 1), 'skipped');
	assert.equal(h.q.state(h.tok(), 2), 'skipped');
	assert.equal(h.q.state(h.tok(), 4), 'queued');
	assert.equal(h.q.push({ tok: h.tok(), i: 1 }), true, 'shown later: queued again');
	assert.equal(h.q.state(h.tok(), 1), 'queued');
	assert.equal(h.q.state(h.tok(), 3), 'skipped', 'the cap drops the oldest waiting point (3)');
	await h.finish();
	assert.equal(new Set(h.calls).size, h.calls.length, 'no point evaluated twice');
});

test('clear (new sweep, cancel): waiting jobs dropped; the job in flight does not store into the new sweep', async () => {
	const h = harness();
	h.q.push({ tok: h.tok(), i: 0 });
	h.q.push({ tok: h.tok(), i: 1 });
	h.newSweep();
	assert.equal(h.q.state(h.tok(), 1), null);
	await h.finish();
	assert.deepEqual(h.calls, [0]);
	assert.equal(h.evals.size, 0);
	h.q.push({ tok: h.tok(), i: 0 });
	await h.finish();
	assert.deepEqual(h.calls, [0, 0]);
	assert.equal(h.evals.get(0), 42);
});

test('gap reasons per evaluation state and a failed group error; counts by state', () => {
	const e: SweepEval = { name: 'neff', group: 'ev', groupLabel: 'ev', unit: '1', value: 1.5, tip: '' };
	const sw: EvalSweepLike = { points: [
		{ status: 'solved', scalars: null, evals: { 'eval:ev/neff': e }, evalState: null },
		{ status: 'solved', scalars: null, evals: null, evalState: 'queued' as const },
		{ status: 'solved', scalars: null, evals: null, evalState: 'running' as const },
		{ status: 'solved', scalars: null, evals: null, evalState: 'skipped' as const },
		{ status: 'solved', scalars: null, evals: null, evalState: null },
		{ status: 'solved', scalars: null, evals: {}, evalFailed: { ev: 'unknown dataset cut1' }, evalState: null },
		{ status: 'error', scalars: null, evals: null, evalState: null }
	] };
	assert.deepEqual(evalCounts(sw), { queued: 1, running: 1, skipped: 1, none: 1 });
	assert.deepEqual(evalGaps(sw, 'eval:ev/neff', 'ev'), [
		'waiting for evaluation',
		'being evaluated',
		'not evaluated: more points waited than the queue holds (evaluated when the point is shown)',
		'not evaluated (evaluated when the point is shown)',
		'evaluation group ev failed: unknown dataset cut1'
	]);
	const t = (rows: number, errors: string[]) => ({ id: 'ev', group: 'ev', label: 'ev', orient: 'rows', columns: [], rows: Array.from({ length: rows }, () => ({})), errors, hash: '', runs: [], ms: 0, cached: false }) as unknown as ResultTable;
	assert.equal(tableFailure(t(0, ['study modes not solved'])), 'study modes not solved');
	assert.equal(tableFailure(t(1, ['x'])), null);
	assert.equal(tableFailure(t(0, [])), null);
});
