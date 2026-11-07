// SPDX-License-Identifier: GPL-3.0-or-later
// Client of the post worker: probes are coalesced (one in flight, the latest pending one replaces older ones).
import type { Mesh } from '@amp/spec/types';
import type { Field2D, RefinedDisplay } from './field2d';
import type { FromPost, ToPost } from './post.worker';

type ProbeHit = Extract<FromPost, { type: 'probe' }>;
type WithoutReq<T> = T extends unknown ? Omit<T, 'req'> : never;

export class PostClient {
	private w: Worker;
	private req = 0;
	private waiting = new Map<number, (m: FromPost) => void>();
	private probeBusy = false;
	private probeNext: { x: number; y: number; cb: (h: ProbeHit) => void } | null = null;

	constructor() {
		this.w = new Worker(new URL('./post.worker.ts', import.meta.url), { type: 'module', name: 'amp-post' });
		this.w.onmessage = (ev: MessageEvent<FromPost>) => {
			const m = ev.data;
			const f = this.waiting.get(m.req);
			if (f) { this.waiting.delete(m.req); f(m); }
		};
	}

	private send(m: ToPost, tr: Transferable[] = []) { this.w.postMessage(m, tr); }

	setMesh(mesh: Mesh) { this.displays.clear(); this.send({ type: 'mesh', mesh }); }
	setField(field: (Field2D & { comp: number }) | null) { this.send({ type: 'field', field }); }

	probe(x: number, y: number, cb: (h: ProbeHit) => void) {
		if (this.probeBusy) { this.probeNext = { x, y, cb }; return; }
		this.probeBusy = true;
		const req = ++this.req;
		this.waiting.set(req, (m) => {
			this.probeBusy = false;
			if (m.type === 'probe') cb(m);
			const n = this.probeNext;
			this.probeNext = null;
			if (n) this.probe(n.x, n.y, n.cb);
		});
		this.send({ type: 'probe', req, x, y });
	}

	call<T extends FromPost['type']>(m: WithoutReq<Extract<ToPost, { req: number }>>): Promise<Extract<FromPost, { type: T }>> {
		const req = ++this.req;
		return new Promise((res, rej) => {
			this.waiting.set(req, (r) => (r.type === 'error' ? rej(new Error(r.message)) : res(r as Extract<FromPost, { type: T }>)));
			this.send({ ...m, req } as ToPost);
		});
	}

	/** Refined display of the current 2D mesh at level r, built in the worker (cached per mesh and r). */
	private displays = new Map<number, Promise<RefinedDisplay>>();
	display(r: number): Promise<RefinedDisplay> {
		let p = this.displays.get(r);
		if (!p) {
			p = this.call<'display'>({ type: 'display', r }).then((m) => ({ r: m.r, np: m.np, nT: m.nT, pos: m.pos, bary: m.bary, reg: m.reg, sub: m.sub, c0: m.c0 }));
			this.displays.set(r, p);
		}
		return p;
	}

	dispose() { this.w.terminate(); }
}
