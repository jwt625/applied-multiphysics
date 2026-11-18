// SPDX-License-Identifier: GPL-3.0-or-later
// Pool of runner workers for parametric sweeps (lane E8, DevLog-054): N workers (C6 runner, the same worker as
// EngineClient), each solving one sweep point at a time; points are handed out in sweep order and outcomes are
// delivered in sweep order (a point that finishes early waits for the earlier ones), so a caller sees the same
// sequence as a serial loop over EngineClient.run. Every point is an independent run of the same deterministic code,
// so its solution is identical to the serial run's. Cancel = C6 `cancel` to every in-flight run, then the workers are
// terminated after 500 ms without an answer (as EngineClient). The worker factory is injected (tests use mock workers).
// No value imports: the module loads in Node for the unit tests.
import type { FromRunner, RunOptions } from './protocol';
import type { RunHandlers, RunOutcome } from './client';

/** The part of a Worker the pool uses. */
export interface WorkerLike {
	postMessage(m: unknown): void;
	terminate(): void;
	onmessage: ((ev: MessageEvent) => void) | null;
	onerror: ((ev: ErrorEvent) => void) | null;
}
export type WorkerFactory = () => WorkerLike;

/** One sweep point: the spec text of the run, its options and its handlers (progress / mesh of that point). */
export interface PoolJob {
	specText: string;
	options: RunOptions;
	handlers?: RunHandlers;
}

/** Upper bound of pool workers (each worker holds its own engine, mesh and factor: memory grows with N). */
export const POOL_MAX = 4;

/**
 * Number of workers for `jobs` points: min(jobs, POOL_MAX, logical cores - 1, device memory in GB / 2), at least 1.
 * `hardwareConcurrency` and `deviceMemory` (Chrome, rounded, capped at 8) default to the browser's values.
 */
export function poolSize(jobs: number, hardwareConcurrency?: number, deviceMemoryGB?: number): number {
	const nav = (globalThis as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } }).navigator;
	const hc = hardwareConcurrency ?? nav?.hardwareConcurrency ?? 2;
	const mem = deviceMemoryGB ?? nav?.deviceMemory;
	let n = Math.min(jobs, POOL_MAX, Math.max(1, hc - 1));
	if (typeof mem === 'number' && mem > 0) n = Math.min(n, Math.max(1, Math.floor(mem / 2)));
	return Math.max(1, n);
}

interface Slot {
	w: WorkerLike;
	job: number;
	id: string;
	t0: number;
	meshed: boolean;
}

let seq = 0;

export class WorkerPool {
	private readonly factory: WorkerFactory;
	private readonly now: () => string;
	private slots: Slot[] = [];
	private idle: WorkerLike[] = [];
	private live: WorkerLike[] = [];
	private batch: { jobs: PoolJob[]; out: (RunOutcome | undefined)[]; next: number; emitted: number; onPoint?: (i: number, o: RunOutcome) => void; done: (o: RunOutcome[]) => void; t0: number } | null = null;
	readonly size: number;

	constructor(factory: WorkerFactory, size: number, now: () => string = () => new Date().toISOString()) {
		this.factory = factory;
		this.size = Math.max(1, Math.floor(size));
		this.now = now;
	}

	get busy(): boolean {
		return this.batch !== null;
	}

	/**
	 * Run all jobs; resolves with the outcomes in job order. onPoint(i, outcome) is called in job order (outcome i
	 * after outcomes 0 .. i-1). A running batch is cancelled first.
	 */
	run(jobs: PoolJob[], onPoint?: (i: number, o: RunOutcome) => void): Promise<RunOutcome[]> {
		this.cancel();
		return new Promise((done) => {
			this.batch = { jobs, out: new Array(jobs.length), next: 0, emitted: 0, ...(onPoint ? { onPoint } : {}), done, t0: performance.now() };
			if (!jobs.length) return this.finish(this.batch);
			const n = Math.min(this.size, jobs.length);
			while (this.live.length < n) this.spawn();
			for (const w of [...this.idle]) this.dispatch(w);
		});
	}

	/** Cancel the batch: in-flight runs get C6 `cancel`, pending ones never start; all unfinished points are 'cancelled'. */
	cancel(): void {
		const b = this.batch;
		if (!b) return;
		this.batch = null;
		const ms = performance.now() - b.t0;
		const running = this.slots;
		this.slots = [];
		for (const s of running) s.w.postMessage({ type: 'cancel', id: s.id, ts: this.now() });
		// workers with a cancelled run leave the pool at once and are terminated after 500 ms (the run stops at its next
		// signal check; a module that does not poll its signal cannot hold a worker); idle workers stay for the next batch
		const ws = running.map((s) => s.w);
		this.live = this.live.filter((w) => !ws.includes(w));
		this.idle = this.idle.filter((w) => !ws.includes(w));
		for (const w of ws) { w.onmessage = null; w.onerror = null; }
		if (ws.length) setTimeout(() => { for (const w of ws) w.terminate(); }, 500);
		for (let i = 0; i < b.jobs.length; i++) if (!b.out[i]) b.out[i] = { kind: 'cancelled', ms };
		this.emit(b);
		b.done(b.out as RunOutcome[]);
	}

	/** Terminate every worker. */
	dispose(): void {
		this.cancel();
		for (const w of this.live) w.terminate();
		this.live = [];
		this.idle = [];
	}

	private spawn(): void {
		const w = this.factory();
		w.onmessage = (ev: MessageEvent) => this.onMessage(w, ev.data as FromRunner);
		w.onerror = (ev: ErrorEvent) => {
			const s = this.slots.find((x) => x.w === w);
			// the worker is unusable after an uncaught error: drop it, start a fresh one for the remaining points
			this.live = this.live.filter((x) => x !== w);
			this.idle = this.idle.filter((x) => x !== w);
			w.terminate();
			if (s) this.complete(s, { kind: 'error', message: ev.message || 'worker error', stage: 'worker', ms: performance.now() - s.t0 });
			const b = this.batch;
			if (b && b.next < b.jobs.length) { this.spawn(); this.dispatch(this.idle[this.idle.length - 1]!); }
		};
		this.live.push(w);
		this.idle.push(w);
	}

	private dispatch(w: WorkerLike): void {
		const b = this.batch;
		if (!b || b.next >= b.jobs.length) return;
		const job = b.next++;
		const id = `p${++seq}`;
		this.idle = this.idle.filter((x) => x !== w);
		this.slots.push({ w, job, id, t0: performance.now(), meshed: false });
		const j = b.jobs[job]!;
		w.postMessage({ type: 'run', id, specText: j.specText, options: j.options, ts: this.now() });
	}

	private onMessage(w: WorkerLike, m: FromRunner): void {
		const s = this.slots.find((x) => x.w === w && x.id === m.id);
		const b = this.batch;
		if (!s || !b) return;
		const h = b.jobs[s.job]!.handlers ?? {};
		const ms = performance.now() - s.t0;
		if (m.type === 'progress') h.progress?.(m.stage, m.frac, m.msg, m.ts);
		else if (m.type === 'mesh') {
			s.meshed = true;
			h.mesh?.(m.mesh, m.quality, m.ms, m.source);
			if (b.jobs[s.job]!.options.meshOnly) this.complete(s, { kind: 'meshed', ms });
		} else if (m.type === 'result') this.complete(s, { kind: 'result', solution: m.solution, ms });
		else if (m.type === 'unavailable') this.complete(s, { kind: 'unavailable', reasons: m.reasons, ms });
		else if (m.type === 'error') this.complete(s, { kind: 'error', message: m.message, ...(m.stage ? { stage: m.stage } : {}), ms });
	}

	private complete(s: Slot, o: RunOutcome): void {
		const b = this.batch;
		this.slots = this.slots.filter((x) => x !== s);
		if (!b) return;
		b.out[s.job] = o;
		if (this.live.includes(s.w)) { this.idle.push(s.w); this.dispatch(s.w); }
		this.emit(b);
		if (b.emitted === b.jobs.length) this.finish(b);
	}

	/** Deliver outcomes in job order up to the first missing one. */
	private emit(b: NonNullable<WorkerPool['batch']>): void {
		while (b.emitted < b.jobs.length && b.out[b.emitted]) {
			const i = b.emitted++;
			b.onPoint?.(i, b.out[i]!);
		}
	}

	/** Resolve batch b if it is still the current one (an onPoint callback may have cancelled it or started another). */
	private finish(b: WorkerPool['batch']): void {
		if (!b || this.batch !== b) return;
		this.batch = null;
		b.done(b.out as RunOutcome[]);
	}
}
