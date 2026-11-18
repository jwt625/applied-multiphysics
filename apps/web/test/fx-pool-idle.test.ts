// SPDX-License-Identifier: GPL-3.0-or-later
// EngineClient sweep pool lifetime (engine/client.ts, fix lane FX-web, DevLog-057 item 6) with a mock Worker: the pool
// is not recreated for a sweep with fewer points, and its idle workers are terminated POOL_IDLE_MS after a sweep.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

type Msg = { type: string; id: string; specText?: string };
const made: MockWorker[] = [];
class MockWorker {
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: ErrorEvent) => void) | null = null;
	terminated = false;
	constructor() { made.push(this); }
	postMessage(m: unknown): void {
		const msg = m as Msg;
		if (msg.type !== 'run') return;
		queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: { type: 'result', id: msg.id, solution: { scalars: {} }, ts: 't' } } as MessageEvent); });
	}
	terminate(): void { this.terminated = true; }
}
(globalThis as { Worker?: unknown }).Worker = MockWorker;
(globalThis as { navigator?: unknown }).navigator ??= {};
const { EngineClient, POOL_IDLE_MS } = await import('../src/lib/engine/client.ts');

const jobs = (n: number) => Array.from({ length: n }, (_, i) => ({ specText: String(i), options: {} as never }));

test('sweep pool: reused for a smaller sweep, idle workers terminated after POOL_IDLE_MS, fresh workers afterwards', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const c = new EngineClient();
		const a = await c.runSweep(jobs(4), undefined, 2);
		assert.deepEqual(a.map((o) => o.kind), ['result', 'result', 'result', 'result']);
		assert.equal(made.length, 2);
		// a 1-point sweep with the same worker setting reuses the pool (no new worker, none terminated)
		await c.runSweep(jobs(1), undefined, 2);
		assert.equal(made.length, 2);
		assert.ok(made.every((w) => !w.terminated));
		mock.timers.tick(POOL_IDLE_MS - 1);
		assert.ok(made.every((w) => !w.terminated));
		mock.timers.tick(1);
		assert.ok(made.every((w) => w.terminated), 'idle pool workers terminated');
		// the next sweep starts fresh workers
		await c.runSweep(jobs(2), undefined, 2);
		assert.equal(made.length, 4);
		assert.ok(!made[2]!.terminated && !made[3]!.terminated);
		// a sweep started inside the idle time cancels the pending release
		mock.timers.tick(POOL_IDLE_MS / 2);
		await c.runSweep(jobs(2), undefined, 2);
		mock.timers.tick(POOL_IDLE_MS / 2 + 1);
		assert.ok(!made[2]!.terminated && !made[3]!.terminated);
		c.dispose();
		assert.ok(made.every((w) => w.terminated));
		mock.timers.tick(2 * POOL_IDLE_MS);
	} finally {
		mock.timers.reset();
	}
});
