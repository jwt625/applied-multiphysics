// SPDX-License-Identifier: GPL-3.0-or-later
// Post worker (DevLog-011 s.1.5): holds the display mesh and the current field; answers exact hover probes (point
// location + FE basis evaluation, not interpolation of drawn values) and computes 3D display arrays (exterior,
// slices, isosurfaces). Only display arrays leave the worker.
/// <reference lib="webworker" />
import type { Mesh } from '@amp/spec/types';
import { Locator, evalElement, latticeValues, refinedDisplay, refinePattern, toMesh2D, type Field2D, type Mesh2D } from './field2d';
import { bbox3, exterior, marchingTets, slice } from './solid3d';

export type ToPost =
	| { type: 'mesh'; mesh: Mesh }
	| { type: 'field'; field: (Field2D & { comp: number }) | null }
	| { type: 'probe'; req: number; x: number; y: number }
	| { type: 'exterior'; req: number }
	| { type: 'display'; req: number; r: number }
	| { type: 'evalAt'; req: number; field: Field2D; comp: number; points: number[] }
	| { type: 'lattice'; req: number; field: Field2D; comp: number; r: number; a: number; b: number; psi: boolean; rule: RangeRule; focus: [number, number, number, number] | null }
	| { type: 'iso'; req: number; nodal: Float64Array; levels: number[]; disp: Float64Array | null }
	| { type: 'slice'; req: number; normal: [number, number, number]; d: number; nodal: Float64Array | null; disp: Float64Array | null };

/** Colour range rule (stated in the colorbar tooltip): full data range, or area-weighted 1st-99th percentile; both
 *  over the focus box when one is given (the region the view frames), else over the whole mesh. */
export type RangeRule = 'full' | 'robust';
export interface LatticeOut { values: Float32Array; lo: number; hi: number; dataLo: number; dataHi: number; peak: { x: number; y: number; v: number } | null; ms: number }

export type FromPost =
	| { type: 'display'; req: number; r: number; np: number; nT: number; pos: Float32Array; bary: Float32Array; reg: Float32Array; sub: Uint32Array; c0: [number, number]; ms: number }
	| ({ type: 'lattice'; req: number } & LatticeOut)
	| { type: 'evalAt'; req: number; values: Array<number | null> }
	| { type: 'probe'; req: number; x: number; y: number; hit: { t: number; domain: number; value: number | null } | null; ms: number }
	| { type: 'exterior'; req: number; pos: Float32Array; node: Int32Array; cell: Int32Array; edges: Int32Array; features: Int32Array; c0: [number, number, number]; ms: number }
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
		} else if (m.type === 'display') {
			if (!m2) throw new Error('no 2D mesh');
			const d = refinedDisplay(m2, m.r);
			const out = { pos: d.pos.slice(), bary: d.bary.slice(), reg: d.reg.slice(), sub: d.sub.slice() };
			ctx.postMessage({ type: 'display', req: m.req, r: m.r, np: d.np, nT: d.nT, ...out, c0: d.c0, ms: performance.now() - t0 } satisfies FromPost, [out.pos.buffer, out.bary.buffer, out.reg.buffer, out.sub.buffer]);
		} else if (m.type === 'evalAt') {
			if (!m2) throw new Error('no 2D mesh');
			loc ??= new Locator(m2);
			const values: Array<number | null> = [];
			for (let i = 0; i < m.points.length; i += 2) {
				const h = loc.locate(m.points[i]!, m.points[i + 1]!);
				values.push(h ? evalElement(m2, m.field, h.t, h.L[0], h.L[1], h.L[2], m.comp) : null);
			}
			ctx.postMessage({ type: 'evalAt', req: m.req, values } satisfies FromPost);
		} else if (m.type === 'lattice') {
			if (!m2) throw new Error('no 2D mesh');
			const r = lattice(m2, m);
			ctx.postMessage({ type: 'lattice', req: m.req, ...r, ms: performance.now() - t0 } satisfies FromPost, [r.values.buffer]);
		} else if (m.type === 'exterior') {
			if (!mesh) throw new Error('no mesh');
			const s = exterior(mesh);
			ctx.postMessage({ type: 'exterior', req: m.req, ...s, ms: performance.now() - t0 } satisfies FromPost, [s.pos.buffer, s.node.buffer, s.cell.buffer, s.edges.buffer, s.features.buffer]);
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

/** Lattice values in display units (a v + b; times r for the flux function r A_phi), range by rule, peak location. */
function lattice(m2: Mesh2D, q: Extract<ToPost, { type: 'lattice' }>): Omit<LatticeOut, 'ms'> {
	const pat = refinePattern(q.r);
	const d = refinedDisplay(m2, q.r);
	const v = latticeValues(m2, q.field, q.r, q.comp);
	const n = v.length;
	let dataLo = Infinity, dataHi = -Infinity;
	for (let i = 0; i < n; i++) {
		let x = q.a * v[i]! + q.b;
		if (q.psi) x *= d.pos[2 * i]! + d.c0[0];
		v[i] = x;
		if (x < dataLo) dataLo = x;
		if (x > dataHi) dataHi = x;
	}
	const f = q.focus;
	const inside = (i: number) => {
		if (!f) return true;
		const x = d.pos[2 * i]! + d.c0[0], y = d.pos[2 * i + 1]! + d.c0[1];
		return x >= f[0] && x <= f[2] && y >= f[1] && y <= f[3];
	};
	// area weight per lattice point
	const area = new Float64Array(m2.nT);
	const N = m2.nodes, c = m2.conn;
	for (let t = 0; t < m2.nT; t++) {
		const o = m2.npe * t, a = c[o]!, b = c[o + 1]!, e = c[o + 2]!;
		area[t] = 0.5 * Math.abs((N[2 * b]! - N[2 * a]!) * (N[2 * e + 1]! - N[2 * a + 1]!) - (N[2 * e]! - N[2 * a]!) * (N[2 * b + 1]! - N[2 * a + 1]!)) / pat.np;
	}
	let lo = Infinity, hi = -Infinity, peak: { x: number; y: number; v: number } | null = null;
	const sample: Array<[number, number]> = [];
	const st = Math.max(1, Math.floor(n / 60000));
	for (let i = 0; i < n; i++) {
		if (!inside(i)) continue;
		const x = v[i]!;
		if (!Number.isFinite(x)) continue;
		if (x < lo) lo = x;
		if (x > hi) hi = x;
		if (!peak || Math.abs(x) > Math.abs(peak.v)) peak = { x: d.pos[2 * i]! + d.c0[0], y: d.pos[2 * i + 1]! + d.c0[1], v: x };
		if (q.rule === 'robust' && i % st === 0) sample.push([x, area[Math.floor(i / pat.np)]!]);
	}
	if (!Number.isFinite(lo)) { lo = dataLo; hi = dataHi; }
	if (q.rule === 'robust' && sample.length) {
		sample.sort((p, r2) => p[0] - r2[0]);
		let W = 0;
		for (const s of sample) W += s[1];
		let acc = 0, gotLo = false;
		for (const [x, w] of sample) {
			acc += w;
			if (!gotLo && acc >= 0.01 * W) { lo = x; gotLo = true; }
			if (acc >= 0.99 * W) { hi = x; break; }
		}
	}
	return { values: v, lo, hi, dataLo, dataHi, peak };
}
