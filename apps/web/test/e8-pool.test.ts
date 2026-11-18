// SPDX-License-Identifier: GPL-3.0-or-later
// Worker pool for parametric sweeps (engine/pool.ts, lane E8 DevLog-054) with mock workers: outcomes in sweep order
// whatever the completion order, identical outcomes to a serial pool (size 1), at most `size` runs in flight, cancel
// (in-flight runs get C6 cancel, pending points never start, workers terminated), worker errors, pool size rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerPool, poolSize, type WorkerLike } from '../src/lib/engine/pool.ts';

type Msg = { type: string; id: string; specText?: string };

/** Mock runner: answers a run with a result whose scalar is a function of the spec text, after a delay from the text. */
class MockWorker implements WorkerLike {
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: ErrorEvent) => void) | null = null;
	terminated = false;
	received: Msg[] = [];
	static inFlight = 0;
	static maxInFlight = 0;
	postMessage(m: unknown): void {
		const msg = m as Msg;
		this.received.push(msg);
		if (msg.type !== 'run') return;
		MockWorker.inFlight++;
		MockWorker.maxInFlight = Math.max(MockWorker.maxInFlight, MockWorker.inFlight);
		const x = Number(msg.specText);
		const reply = (data: unknown) => { if (!this.terminated) this.onmessage?.({ data } as MessageEvent); };
		setTimeout(() => {
			if (this.terminated || this.received.some((r) => r.type === 'cancel' && r.id === msg.id)) { MockWorker.inFlight--; return; }
			reply({ type: 'progress', id: msg.id, stage: 'solve', frac: 1, ts: 't' });
			MockWorker.inFlight--;
			if (x < 0) { this.onerror?.({ message: 'boom' } as ErrorEvent); return; }
			if (x === 13) reply({ type: 'error', id: msg.id, message: 'thirteen', stage: 'solve', ts: 't' });
			else reply({ type: 'result', id: msg.id, solution: { scalars: { y: { value: x * x, unit: '1' } } }, ts: 't' });
		}, x >= 0 ? (7 * x) % 11 : 1);
	}
	terminate(): void { this.terminated = true; }
}

const values = (o: Array<{ kind: string; solution?: { scalars: { y: { value: number } } }; message?: string }>) => o.map((r) => (r.kind === 'result' ? r.solution!.scalars.y.value : r.kind === 'error' ? `error:${r.message}` : r.kind));

test('pool: outcomes in sweep order, identical to a serial pool, at most size in flight', async () => {
	const xs = [5, 1, 9, 3, 0, 7, 2, 8, 6, 4, 13, 10];
	const jobs = xs.map((x) => ({ specText: String(x), options: {} }));
	const mk: MockWorker[] = [];
	const factory = () => { const w = new MockWorker(); mk.push(w); return w; };
	MockWorker.maxInFlight = 0;
	const order: number[] = [];
	const par = await new WorkerPool(factory, 4).run(jobs, (i) => order.push(i));
	assert.deepEqual(order, xs.map((_, i) => i));
	assert.equal(MockWorker.maxInFlight, 4);
	assert.equal(mk.length, 4);
	MockWorker.maxInFlight = 0;
	const ser = await new WorkerPool(factory, 1).run(jobs);
	assert.equal(MockWorker.maxInFlight, 1);
	assert.deepEqual(values(par as never), values(ser as never));
	assert.deepEqual(values(par as never), xs.map((x) => (x === 13 ? 'error:thirteen' : x * x)));
});

test('pool: cancel ends in-flight and pending points as cancelled, sends C6 cancel, terminates the busy workers', async () => {
	const mk: MockWorker[] = [];
	const pool = new WorkerPool(() => { const w = new MockWorker(); mk.push(w); return w; }, 2);
	const jobs = [10, 10, 10, 10, 10].map((x) => ({ specText: String(x), options: {} }));
	const seen: string[] = [];
	const p = pool.run(jobs, (i, o) => seen.push(`${i}:${o.kind}`));
	setTimeout(() => pool.cancel(), 2);
	const out = await p;
	assert.deepEqual(out.map((o) => o.kind), ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
	assert.deepEqual(seen, ['0:cancelled', '1:cancelled', '2:cancelled', '3:cancelled', '4:cancelled']);
	const runs = mk.flatMap((w) => w.received.filter((m) => m.type === 'run'));
	assert.equal(runs.length, 2, 'pending points never start');
	for (const w of mk) assert.ok(w.received.some((m) => m.type === 'cancel'));
	await new Promise((r) => setTimeout(r, 600));
	assert.ok(mk.every((w) => w.terminated));
	// the pool still works after a cancel (fresh workers)
	const again = await pool.run([{ specText: '3', options: {} }]);
	assert.deepEqual(values(again as never), [9]);
});

test('pool: a worker error fails only its point; the remaining points run on a fresh worker', async () => {
	const pool = new WorkerPool(() => new MockWorker(), 2);
	const out = await pool.run([1, -1, 2, 3].map((x) => ({ specText: String(x), options: {} })));
	assert.deepEqual(values(out as never), [1, 'error:boom', 4, 9]);
});

test('pool: size rule', () => {
	assert.equal(poolSize(10, 12, 16), 4);
	assert.equal(poolSize(2, 12, 16), 2);
	assert.equal(poolSize(10, 2, 16), 1);
	assert.equal(poolSize(10, 12, 4), 2);
	assert.equal(poolSize(0, 12, 16), 1);
	assert.equal(poolSize(10, 1), 1);
});
