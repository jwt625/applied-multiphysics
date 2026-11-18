// SPDX-License-Identifier: GPL-3.0-or-later
// Main-thread client of the runner worker (C6). One run in flight per client; a new run cancels the previous one.
// Cancel = C6 `cancel` (AbortSignal in the worker), then terminate and restart the worker after 500 ms without an
// answer (a module that does not poll its signal cannot block the UI). Parametric sweeps can run on a pool of workers
// (runSweep, pool.ts; DevLog-054).
import type { Mesh, Solution } from '@amp/spec/types';
import { nowIso, type FromRunner, type RunOptions } from './protocol.ts';
import { POOL_MAX, WorkerPool, poolSize, type PoolJob } from './pool.ts';

/**
 * Idle time after a sweep before the pool's workers are terminated (each holds its own engine, mesh and factor). A
 * sweep started within this time reuses them; after it, the next sweep starts fresh workers. Design choice.
 */
export const POOL_IDLE_MS = 10_000;

export interface RunHandlers {
	progress?: (stage: string, frac: number, msg: string | undefined, ts: string) => void;
	mesh?: (mesh: Mesh, quality: Float64Array, ms: { parse: number; geometry: number; mesh: number }, source: string) => void;
}

export type RunOutcome =
	| { kind: 'result'; solution: Solution; ms: number }
	| { kind: 'unavailable'; reasons: string[]; ms: number }
	| { kind: 'meshed'; ms: number }
	| { kind: 'error'; message: string; stage?: string; ms: number }
	| { kind: 'cancelled'; ms: number };

let seq = 0;

export class EngineClient {
	private worker: Worker | null = null;
	private current: { id: string; done: (o: RunOutcome) => void; h: RunHandlers; t0: number; meshOnly: boolean; meshed: boolean } | null = null;

	private ensure(): Worker {
		if (this.worker) return this.worker;
		const w = new Worker(new URL('./runner.worker.ts', import.meta.url), { type: 'module', name: 'amp-runner' });
		w.onmessage = (ev: MessageEvent<FromRunner>) => this.onMessage(ev.data);
		w.onerror = (ev) => {
			const c = this.current;
			if (c) { this.current = null; c.done({ kind: 'error', message: ev.message || 'worker error', stage: 'worker', ms: performance.now() - c.t0 }); }
		};
		this.worker = w;
		return w;
	}

	private onMessage(m: FromRunner) {
		const c = this.current;
		if (!c || m.id !== c.id) return;
		const ms = performance.now() - c.t0;
		if (m.type === 'progress') c.h.progress?.(m.stage, m.frac, m.msg, m.ts);
		else if (m.type === 'mesh') {
			c.meshed = true;
			c.h.mesh?.(m.mesh, m.quality, m.ms, m.source);
			if (c.meshOnly) { this.current = null; c.done({ kind: 'meshed', ms }); }
		} else {
			this.current = null;
			if (m.type === 'result') c.done({ kind: 'result', solution: m.solution, ms });
			else if (m.type === 'unavailable') c.done({ kind: 'unavailable', reasons: m.reasons, ms });
			else c.done({ kind: 'error', message: m.message, ...(m.stage ? { stage: m.stage } : {}), ms });
		}
	}

	run(specText: string, options: RunOptions, h: RunHandlers = {}): Promise<RunOutcome> {
		this.cancel();
		const w = this.ensure();
		const id = `r${++seq}`;
		return new Promise((done) => {
			this.current = { id, done, h, t0: performance.now(), meshOnly: !!options.meshOnly, meshed: false };
			w.postMessage({ type: 'run', id, specText, options, ts: nowIso() });
		});
	}

	cancel(): void {
		this.pool?.cancel();
		const c = this.current;
		if (!c || !this.worker) return;
		this.current = null;
		this.worker.postMessage({ type: 'cancel', id: c.id, ts: nowIso() });
		const w = this.worker;
		const timer = setTimeout(() => {
			if (this.worker === w && this.current === null) { w.terminate(); this.worker = null; }
		}, 500);
		void timer;
		c.done({ kind: 'cancelled', ms: performance.now() - c.t0 });
	}

	get busy(): boolean {
		return this.current !== null || !!this.pool?.busy;
	}

	private pool: WorkerPool | null = null;
	private poolIdle: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Parametric sweep on a pool of runner workers (DevLog-054): every job is one run (as `run`), up to poolSize(jobs)
	 * runs in parallel; resolves with the outcomes in job order and calls onPoint(i, outcome) in job order (the same
	 * sequence as a serial loop over `run`, identical solutions). A running single run or sweep is cancelled first;
	 * `cancel` stops the sweep (unfinished points end 'cancelled'). `workers` overrides the pool size (1 = serial).
	 */
	runSweep(jobs: PoolJob[], onPoint?: (i: number, o: RunOutcome) => void, workers?: number): Promise<RunOutcome[]> {
		this.cancel();
		this.clearPoolIdle();
		// the pool size follows the device rule (or the workers toggle), not the job count: WorkerPool.run starts at most
		// min(size, jobs) workers, so a sweep with fewer points reuses the pool instead of recreating it
		const n = workers ?? poolSize(POOL_MAX);
		if (!this.pool || this.pool.size !== n) {
			this.pool?.dispose();
			this.pool = new WorkerPool(() => new Worker(new URL('./runner.worker.ts', import.meta.url), { type: 'module', name: 'amp-runner-pool' }), n, nowIso);
		}
		const pool = this.pool;
		return pool.run(jobs, onPoint).then((out) => {
			// idle workers are released POOL_IDLE_MS after the sweep (unless another sweep started meanwhile)
			if (this.pool === pool && !pool.busy) {
				this.clearPoolIdle();
				this.poolIdle = setTimeout(() => {
					this.poolIdle = null;
					if (this.pool === pool && !pool.busy) { pool.dispose(); this.pool = null; }
				}, POOL_IDLE_MS);
			}
			return out;
		});
	}

	private clearPoolIdle(): void {
		if (this.poolIdle !== null) { clearTimeout(this.poolIdle); this.poolIdle = null; }
	}

	dispose(): void {
		this.clearPoolIdle();
		this.worker?.terminate();
		this.worker = null;
		this.pool?.dispose();
		this.pool = null;
	}
}
