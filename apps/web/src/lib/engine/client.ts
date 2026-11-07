// SPDX-License-Identifier: GPL-3.0-or-later
// Main-thread client of the runner worker (C6). One run in flight per client; a new run cancels the previous one.
// Cancel = C6 `cancel` (AbortSignal in the worker), then terminate and restart the worker after 500 ms without an
// answer (a module that does not poll its signal cannot block the UI).
import type { Mesh, Solution } from '@amp/spec/types';
import { nowIso, type FromRunner, type RunOptions } from './protocol';

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
		return this.current !== null;
	}

	dispose(): void {
		this.worker?.terminate();
		this.worker = null;
	}
}
