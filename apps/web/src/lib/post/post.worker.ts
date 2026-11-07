// SPDX-License-Identifier: GPL-3.0-or-later
// Post worker (DevLog-011 s.1.5): holds the display mesh and the current field; answers exact hover probes (point
// location + FE basis evaluation, not interpolation of drawn values) and computes 3D display arrays (exterior,
// slices, isosurfaces). Only display arrays leave the worker.
/// <reference lib="webworker" />
import type { Mesh } from '@amp/spec/types';
import { Locator, evalElement, toMesh2D, type Field2D, type Mesh2D } from './field2d';
import { bbox3, exterior, marchingTets, slice } from './solid3d';

export type ToPost =
	| { type: 'mesh'; mesh: Mesh }
	| { type: 'field'; field: (Field2D & { comp: number }) | null }
	| { type: 'probe'; req: number; x: number; y: number }
	| { type: 'exterior'; req: number }
	| { type: 'iso'; req: number; nodal: Float64Array; levels: number[]; disp: Float64Array | null }
	| { type: 'slice'; req: number; normal: [number, number, number]; d: number; nodal: Float64Array | null; disp: Float64Array | null };

export type FromPost =
	| { type: 'probe'; req: number; x: number; y: number; hit: { t: number; domain: number; value: number | null } | null; ms: number }
	| { type: 'exterior'; req: number; pos: Float32Array; node: Int32Array; cell: Int32Array; edges: Int32Array; c0: [number, number, number]; ms: number }
	| { type: 'cut'; req: number; pos: Float32Array; val: Float32Array; disp: Float32Array | null; nTri: number; ms: number }
	| { type: 'error'; req: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let mesh: Mesh | null = null;
let m2: Mesh2D | null = null;
let loc: Locator | null = null;
let field: (Field2D & { comp: number }) | null = null;

ctx.onmessage = (ev: MessageEvent<ToPost>) => {
	const m = ev.data;
	const t0 = performance.now();
	try {
		if (m.type === 'mesh') {
			mesh = m.mesh;
			m2 = mesh.dim === 2 ? toMesh2D(mesh) : null;
			loc = null;
			field = null;
		} else if (m.type === 'field') field = m.field;
		else if (m.type === 'probe') {
			if (!m2) return ctx.postMessage({ type: 'probe', req: m.req, x: m.x, y: m.y, hit: null, ms: 0 } satisfies FromPost);
			loc ??= new Locator(m2);
			const h = loc.locate(m.x, m.y);
			const hit = h ? { t: h.t, domain: m2.domain[h.t]!, value: field ? evalElement(m2, field, h.t, h.L[0], h.L[1], h.L[2], field.comp) : null } : null;
			ctx.postMessage({ type: 'probe', req: m.req, x: m.x, y: m.y, hit, ms: performance.now() - t0 } satisfies FromPost);
		} else if (m.type === 'exterior') {
			if (!mesh) throw new Error('no mesh');
			const s = exterior(mesh);
			ctx.postMessage({ type: 'exterior', req: m.req, ...s, ms: performance.now() - t0 } satisfies FromPost, [s.pos.buffer, s.node.buffer, s.cell.buffer, s.edges.buffer]);
		} else if (m.type === 'iso' || m.type === 'slice') {
			if (!mesh) throw new Error('no mesh');
			const c0 = bbox3(mesh.nodes).c;
			const parts = m.type === 'iso' ? m.levels.map((L) => marchingTets(mesh!, m.nodal, L, null, m.disp, c0)) : [slice(mesh, m.normal, m.d, m.nodal, m.disp, c0)];
			const nTri = parts.reduce((a, p) => a + p.nTri, 0);
			const pos = new Float32Array(9 * nTri), val = new Float32Array(3 * nTri), disp = m.disp ? new Float32Array(9 * nTri) : null;
			let o = 0;
			for (const p of parts) {
				pos.set(p.pos, 9 * o); val.set(p.val, 3 * o);
				if (disp && p.disp) disp.set(p.disp, 9 * o);
				o += p.nTri;
			}
			const tr: Transferable[] = [pos.buffer, val.buffer];
			if (disp) tr.push(disp.buffer);
			ctx.postMessage({ type: 'cut', req: m.req, pos, val, disp, nTri, ms: performance.now() - t0 } satisfies FromPost, tr);
		}
	} catch (e) {
		ctx.postMessage({ type: 'error', req: 'req' in m ? m.req : -1, message: (e as Error).message } satisfies FromPost);
	}
};
