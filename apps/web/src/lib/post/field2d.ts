// SPDX-License-Identifier: GPL-3.0-or-later
// 2D display mesh, refined lattice and exact point evaluation (DevLog-011 s.1.5).
// Refined display (pattern: eo-modulator-atlas DevLog-034, engine/src/postproc refine at 0546007, re-implemented for C2
// meshes): every triangle is split into r^2 sub-triangles on its barycentric lattice; lattice positions come from the
// element map (affine for tri3, isoparametric quadratic for tri6) and lattice values from the element basis (P1, P2 or
// constant), so what is drawn is the exact FE field at the lattice points, linearly interpolated between them.
import type { Mesh } from '@amp/spec/types';

export type Space = 'H1P1' | 'H1P2' | 'DG0';

export interface Mesh2D {
	type: 'tri3' | 'tri6';
	/** 2 * nNodes, metres */
	nodes: Float64Array;
	conn: Int32Array;
	domain: Int32Array;
	nT: number;
	npe: 3 | 6;
	bbox: [number, number, number, number];
}

export function toMesh2D(m: Mesh): Mesh2D {
	if (m.dim !== 2) throw new Error('2D display needs a 2D mesh');
	const t = m.cells.type;
	if (t !== 'tri3' && t !== 'tri6') throw new Error(`2D display: cell type ${t} not supported`);
	const npe = t === 'tri3' ? 3 : 6;
	const N = m.nodes;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (let i = 0; i < N.length; i += 2) {
		const x = N[i]!, y = N[i + 1]!;
		if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
	}
	return { type: t, nodes: N, conn: m.cells.conn, domain: m.cells.domain, nT: m.cells.conn.length / npe, npe, bbox: [x0, y0, x1, y1] };
}

export interface Pattern {
	r: number;
	/** lattice points per element */
	np: number;
	nSub: number;
	/** barycentrics (L0, L1, L2) per lattice point */
	L: Float64Array;
	/** sub-triangles, 3 local lattice indices each */
	sub: Uint32Array;
}

const patterns = new Map<number, Pattern>();

export function refinePattern(r: number): Pattern {
	const hit = patterns.get(r);
	if (hit) return hit;
	const np = ((r + 1) * (r + 2)) / 2;
	const L = new Float64Array(3 * np);
	const idx = (i: number, j: number) => (j * (2 * r + 3 - j)) / 2 + i; // row j has r+1-j points
	for (let j = 0; j <= r; j++)
		for (let i = 0; i <= r - j; i++) {
			const p = idx(i, j);
			L[3 * p + 1] = i / r;
			L[3 * p + 2] = j / r;
			L[3 * p] = 1 - (i + j) / r;
		}
	const sub: number[] = [];
	for (let j = 0; j < r; j++)
		for (let i = 0; i < r - j; i++) {
			sub.push(idx(i, j), idx(i + 1, j), idx(i, j + 1));
			if (i + j < r - 1) sub.push(idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1));
		}
	const p: Pattern = { r, np, nSub: r * r, L, sub: Uint32Array.from(sub) };
	patterns.set(r, p);
	return p;
}

/** P2 shape functions at barycentrics (corners 0..2, mids 01, 12, 20 as in C2 tri6). */
export function p2(L0: number, L1: number, L2: number, out: Float64Array): void {
	out[0] = L0 * (2 * L0 - 1);
	out[1] = L1 * (2 * L1 - 1);
	out[2] = L2 * (2 * L2 - 1);
	out[3] = 4 * L0 * L1;
	out[4] = 4 * L1 * L2;
	out[5] = 4 * L2 * L0;
}

const W6 = new Float64Array(6);

/** Physical point of element t at barycentrics (exact element map). */
export function mapPoint(m: Mesh2D, t: number, L0: number, L1: number, L2: number, out: [number, number]): void {
	const c = m.conn, N = m.nodes, o = m.npe * t;
	if (m.npe === 3) {
		const a = c[o]!, b = c[o + 1]!, d = c[o + 2]!;
		out[0] = L0 * N[2 * a]! + L1 * N[2 * b]! + L2 * N[2 * d]!;
		out[1] = L0 * N[2 * a + 1]! + L1 * N[2 * b + 1]! + L2 * N[2 * d + 1]!;
		return;
	}
	p2(L0, L1, L2, W6);
	let x = 0, y = 0;
	for (let k = 0; k < 6; k++) { const n = c[o + k]!; x += W6[k]! * N[2 * n]!; y += W6[k]! * N[2 * n + 1]!; }
	out[0] = x; out[1] = y;
}

export interface RefinedDisplay {
	r: number;
	np: number;
	nT: number;
	/** lattice positions relative to the mesh centre (float32 origin), element-major */
	pos: Float32Array;
	c0: [number, number];
	sub: Uint32Array;
	/** parent barycentrics (L1, L2) for the wireframe */
	bary: Float32Array;
	/** domain index per lattice point */
	reg: Float32Array;
}

const memo = new WeakMap<Mesh2D, Map<number, RefinedDisplay>>();

export function refinedDisplay(m: Mesh2D, r: number): RefinedDisplay {
	let mm = memo.get(m);
	if (!mm) memo.set(m, (mm = new Map()));
	const hit = mm.get(r);
	if (hit) return hit;
	const pat = refinePattern(r);
	const c0: [number, number] = [(m.bbox[0] + m.bbox[2]) / 2, (m.bbox[1] + m.bbox[3]) / 2];
	const n = m.nT * pat.np;
	const pos = new Float32Array(2 * n), bary = new Float32Array(2 * n), reg = new Float32Array(n);
	const sub = new Uint32Array(3 * pat.nSub * m.nT);
	const P: [number, number] = [0, 0];
	for (let t = 0; t < m.nT; t++) {
		const o = t * pat.np;
		for (let p = 0; p < pat.np; p++) {
			const L0 = pat.L[3 * p]!, L1 = pat.L[3 * p + 1]!, L2 = pat.L[3 * p + 2]!;
			mapPoint(m, t, L0, L1, L2, P);
			pos[2 * (o + p)] = P[0] - c0[0];
			pos[2 * (o + p) + 1] = P[1] - c0[1];
			bary[2 * (o + p)] = L1;
			bary[2 * (o + p) + 1] = L2;
			reg[o + p] = m.domain[t]!;
		}
		const so = 3 * pat.nSub * t;
		for (let k = 0; k < 3 * pat.nSub; k++) sub[so + k] = o + pat.sub[k]!;
	}
	const d: RefinedDisplay = { r, np: pat.np, nT: m.nT, pos, c0, sub, bary, reg };
	mm.set(r, d);
	while (mm.size > 2) mm.delete(mm.keys().next().value!);
	return d;
}

export interface Field2D {
	space: Space;
	/** nNodes * components (H1) or nCells * components (DG0) */
	data: ArrayLike<number>;
	components: number;
}

/** Value of component `comp` (or the magnitude when comp = -1) of a field on element t at barycentrics. */
export function evalElement(m: Mesh2D, f: Field2D, t: number, L0: number, L1: number, L2: number, comp: number): number {
	const nc = f.components;
	const get = (node: number) => {
		if (comp >= 0) return f.data[nc * node + comp]!;
		let s = 0;
		for (let k = 0; k < nc; k++) s += f.data[nc * node + k]! ** 2;
		return Math.sqrt(s);
	};
	if (f.space === 'DG0') return get(t);
	const c = m.conn, o = m.npe * t;
	if (f.space === 'H1P1' || m.npe === 3) {
		if (comp >= 0 || nc === 1) return L0 * get(c[o]!) + L1 * get(c[o + 1]!) + L2 * get(c[o + 2]!);
		// magnitude of the interpolated vector (not the interpolated magnitude)
		let s = 0;
		for (let k = 0; k < nc; k++) {
			const v = L0 * f.data[nc * c[o]! + k]! + L1 * f.data[nc * c[o + 1]! + k]! + L2 * f.data[nc * c[o + 2]! + k]!;
			s += v * v;
		}
		return Math.sqrt(s);
	}
	p2(L0, L1, L2, W6);
	if (comp >= 0 || nc === 1) {
		let v = 0;
		for (let k = 0; k < 6; k++) v += W6[k]! * get(c[o + k]!);
		return v;
	}
	let s = 0;
	for (let q = 0; q < nc; q++) {
		let v = 0;
		for (let k = 0; k < 6; k++) v += W6[k]! * f.data[nc * c[o + k]! + q]!;
		s += v * v;
	}
	return Math.sqrt(s);
}

/** Lattice values (element-major) of a field at refinement r. */
export function latticeValues(m: Mesh2D, f: Field2D, r: number, comp: number): Float32Array {
	const pat = refinePattern(r);
	const out = new Float32Array(m.nT * pat.np);
	for (let t = 0; t < m.nT; t++)
		for (let p = 0; p < pat.np; p++) out[t * pat.np + p] = evalElement(m, f, t, pat.L[3 * p]!, pat.L[3 * p + 1]!, pat.L[3 * p + 2]!, comp);
	return out;
}

/** Per-element values drawn flat (lattice r = 1, 3 equal corner values). */
export function perElement(values: ArrayLike<number>): Float32Array {
	const out = new Float32Array(3 * values.length);
	for (let t = 0; t < values.length; t++) out[3 * t] = out[3 * t + 1] = out[3 * t + 2] = values[t]!;
	return out;
}

/** Triangle shape quality q = 4 sqrt(3) A / (l01^2 + l12^2 + l20^2) per element (corners), 1 = equilateral. */
export function triShapeQuality(m: Mesh2D): Float64Array {
	const out = new Float64Array(m.nT), N = m.nodes, c = m.conn;
	for (let t = 0; t < m.nT; t++) {
		const o = m.npe * t;
		const a = c[o]!, b = c[o + 1]!, d = c[o + 2]!;
		const ax = N[2 * a]!, ay = N[2 * a + 1]!, bx = N[2 * b]!, by = N[2 * b + 1]!, dx = N[2 * d]!, dy = N[2 * d + 1]!;
		const A = 0.5 * Math.abs((bx - ax) * (dy - ay) - (dx - ax) * (by - ay));
		const s = (bx - ax) ** 2 + (by - ay) ** 2 + (dx - bx) ** 2 + (dy - by) ** 2 + (ax - dx) ** 2 + (ay - dy) ** 2;
		out[t] = s > 0 ? (4 * Math.sqrt(3) * A) / s : 0;
	}
	return out;
}

/** Uniform bucket grid over element bounding boxes for point location. */
export class Locator {
	private m: Mesh2D;
	private nx: number;
	private ny: number;
	private x0: number;
	private y0: number;
	private hx: number;
	private hy: number;
	private start: Int32Array;
	private items: Int32Array;

	constructor(m: Mesh2D) {
		this.m = m;
		const [x0, y0, x1, y1] = m.bbox;
		const n = Math.max(1, Math.ceil(Math.sqrt(m.nT / 2)));
		const w = x1 - x0 || 1, h = y1 - y0 || 1;
		this.nx = Math.max(1, Math.round(n * Math.sqrt(w / h)));
		this.ny = Math.max(1, Math.round(n * Math.sqrt(h / w)));
		this.x0 = x0; this.y0 = y0; this.hx = w / this.nx; this.hy = h / this.ny;
		const nb = this.nx * this.ny;
		const count = new Int32Array(nb + 1);
		const range = (t: number) => {
			const c = m.conn, o = m.npe * t, N = m.nodes;
			let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
			for (let k = 0; k < m.npe; k++) { const v = c[o + k]!; a0 = Math.min(a0, N[2 * v]!); a1 = Math.max(a1, N[2 * v]!); b0 = Math.min(b0, N[2 * v + 1]!); b1 = Math.max(b1, N[2 * v + 1]!); }
			return [this.cx(a0), this.cx(a1), this.cy(b0), this.cy(b1)] as const;
		};
		for (let t = 0; t < m.nT; t++) { const [i0, i1, j0, j1] = range(t); for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) count[j * this.nx + i + 1]!++; }
		for (let b = 0; b < nb; b++) count[b + 1]! += count[b]!;
		this.start = count.slice();
		const fill = count.slice(0, nb);
		this.items = new Int32Array(count[nb]!);
		for (let t = 0; t < m.nT; t++) { const [i0, i1, j0, j1] = range(t); for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.items[fill[j * this.nx + i]!++] = t; }
	}

	private cx(x: number) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.hx))); }
	private cy(y: number) { return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.hy))); }

	/** Element and barycentrics of a point (exact inverse of the element map; Newton for tri6), or null outside. */
	locate(x: number, y: number): { t: number; L: [number, number, number] } | null {
		const [bx0, by0, bx1, by1] = this.m.bbox;
		if (x < bx0 || x > bx1 || y < by0 || y > by1) return null;
		const b = this.cy(y) * this.nx + this.cx(x);
		const m = this.m, N = m.nodes, c = m.conn;
		let best: { t: number; L: [number, number, number]; out: number } | null = null;
		for (let k = this.start[b]!; k < this.start[b + 1]!; k++) {
			const t = this.items[k]!, o = m.npe * t;
			const a = c[o]!, bb = c[o + 1]!, d = c[o + 2]!;
			const ax = N[2 * a]!, ay = N[2 * a + 1]!;
			let e1x = N[2 * bb]! - ax, e1y = N[2 * bb + 1]! - ay, e2x = N[2 * d]! - ax, e2y = N[2 * d + 1]! - ay;
			let det = e1x * e2y - e2x * e1y;
			if (det === 0) continue;
			let L1 = ((x - ax) * e2y - e2x * (y - ay)) / det, L2 = (e1x * (y - ay) - (x - ax) * e1y) / det;
			if (m.npe === 6) {
				// Newton on the quadratic map from the affine guess
				const P: [number, number] = [0, 0];
				for (let it = 0; it < 6; it++) {
					mapPoint(m, t, 1 - L1 - L2, L1, L2, P);
					const rx = x - P[0], ry = y - P[1];
					if (rx * rx + ry * ry < 1e-28 * (1 + x * x + y * y)) break;
					const J = jac6(m, t, L1, L2);
					e1x = J[0]; e2x = J[1]; e1y = J[2]; e2y = J[3];
					det = e1x * e2y - e2x * e1y;
					if (det === 0) break;
					L1 += (rx * e2y - e2x * ry) / det;
					L2 += (e1x * ry - rx * e1y) / det;
				}
			}
			const L0 = 1 - L1 - L2;
			const out = Math.max(0, -L0, -L1, -L2);
			if (out <= 1e-12) return { t, L: [L0, L1, L2] };
			if (!best || out < best.out) best = { t, L: [L0, L1, L2], out };
		}
		return best && best.out < 1e-9 ? { t: best.t, L: best.L } : null;
	}
}

/** Jacobian [dx/dL1, dx/dL2, dy/dL1, dy/dL2] of the tri6 map at (L1, L2). */
function jac6(m: Mesh2D, t: number, L1: number, L2: number): [number, number, number, number] {
	const L0 = 1 - L1 - L2;
	// derivatives of the 6 shape functions wrt L1 and L2 (L0 = 1 - L1 - L2)
	const d1 = [-(4 * L0 - 1), 4 * L1 - 1, 0, 4 * (L0 - L1), 4 * L2, -4 * L2];
	const d2 = [-(4 * L0 - 1), 0, 4 * L2 - 1, -4 * L1, 4 * L1, 4 * (L0 - L2)];
	const c = m.conn, N = m.nodes, o = 6 * t;
	let a = 0, b = 0, cc = 0, d = 0;
	for (let k = 0; k < 6; k++) {
		const n = c[o + k]!;
		a += d1[k]! * N[2 * n]!; b += d2[k]! * N[2 * n]!; cc += d1[k]! * N[2 * n + 1]!; d += d2[k]! * N[2 * n + 1]!;
	}
	return [a, b, cc, d];
}
