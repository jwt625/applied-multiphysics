// SPDX-License-Identifier: GPL-3.0-or-later
// Flux lines of a 2D scalar potential field (DevLog-015): curves tangent to q = -grad(u) (heat flux direction for a
// temperature u with an isotropic conductivity), traced from the boundary where the flux enters the domain. Seeds are
// spaced at equal increments of the inflow integral of -grad(u) . n_in ds, so on a single material every line carries
// the same heat and line density follows |q|. Gradients are the exact gradients of the P1 / P2 field on the element
// (corner-affine geometry map; exact for straight-sided elements). Midpoint (RK2) integration, step a quarter of the
// local element size; a line ends where it leaves the domain. Display only.
import type { Mesh } from '@amp/spec/types';
import type { Field2D, Locator, Mesh2D } from './field2d';

/** Gradient of the field on element t at barycentrics L (corner-affine map). */
export function gradAt(m: Mesh2D, f: Field2D, t: number, L0: number, L1: number, L2: number): [number, number] {
	const c = m.conn, N = m.nodes, o = m.npe * t;
	const a = c[o]!, b = c[o + 1]!, d = c[o + 2]!;
	const xa = N[2 * a]!, ya = N[2 * a + 1]!;
	const j00 = N[2 * b]! - xa, j01 = N[2 * d]! - xa, j10 = N[2 * b + 1]! - ya, j11 = N[2 * d + 1]! - ya;
	const det = j00 * j11 - j01 * j10;
	// rows of J^-1: grad L1, grad L2
	const g1x = j11 / det, g1y = -j01 / det, g2x = -j10 / det, g2y = j00 / det;
	const g0x = -g1x - g2x, g0y = -g1y - g2y;
	const v = (k: number) => f.data[f.components * c[o + k]!]!;
	if (f.space !== 'H1P2' || m.npe !== 6) {
		return [v(0) * g0x + v(1) * g1x + v(2) * g2x, v(0) * g0y + v(1) * g1y + v(2) * g2y];
	}
	// dN/dL: corners L(2L-1) -> 4L-1; mids 4 Li Lj
	const d0 = v(0) * (4 * L0 - 1) + v(3) * 4 * L1 + v(5) * 4 * L2;
	const d1 = v(1) * (4 * L1 - 1) + v(3) * 4 * L0 + v(4) * 4 * L2;
	const d2 = v(2) * (4 * L2 - 1) + v(4) * 4 * L1 + v(5) * 4 * L0;
	return [d0 * g0x + d1 * g1x + d2 * g2x, d0 * g0y + d1 * g1y + d2 * g2y];
}

export interface FluxLines { segs: Float64Array; arrows: Float64Array; nLines: number }

export function fluxLines(mesh: Mesh, m: Mesh2D, loc: Locator, f: Field2D, nLines: number): FluxLines {
	const N = m.nodes, c = m.conn;
	const size = Math.max(m.bbox[2] - m.bbox[0], m.bbox[3] - m.bbox[1]);
	// boundary facets of the domain: corner edges owned by exactly one cell
	const owners = new Map<string, number[]>();
	for (let t = 0; t < m.nT; t++) for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
		const a = c[m.npe * t + i]!, b = c[m.npe * t + j]!, k = a < b ? `${a},${b}` : `${b},${a}`;
		const l = owners.get(k); if (l) l.push(t); else owners.set(k, [t]);
	}
	const fc = mesh.facets, npf = fc.type === 'line3' ? 3 : 2;
	type In = { x: number; y: number; nx: number; ny: number; w: number };
	const inflow: In[] = [];
	let total = 0;
	for (let s = 0; s < fc.conn.length / npf; s++) {
		const a = fc.conn[npf * s]!, b = fc.conn[npf * s + 1]!;
		const own = owners.get(a < b ? `${a},${b}` : `${b},${a}`);
		if (!own || own.length !== 1) continue;
		const t = own[0]!;
		const xa = N[2 * a]!, ya = N[2 * a + 1]!, xb = N[2 * b]!, yb = N[2 * b + 1]!, len = Math.hypot(xb - xa, yb - ya);
		let nx = -(yb - ya) / len, ny = (xb - xa) / len;
		let cx = 0, cy = 0;
		for (let k = 0; k < 3; k++) { cx += N[2 * c[m.npe * t + k]!]! / 3; cy += N[2 * c[m.npe * t + k]! + 1]! / 3; }
		if (nx * (cx - (xa + xb) / 2) + ny * (cy - (ya + yb) / 2) < 0) { nx = -nx; ny = -ny; }
		// inflow density -grad(u) . n_in at 3 Gauss-like points of the facet
		for (const s3 of [1 / 6, 1 / 2, 5 / 6]) {
			const x = xa + s3 * (xb - xa) + 1e-7 * size * nx, y = ya + s3 * (yb - ya) + 1e-7 * size * ny;
			const h = loc.locate(x, y);
			if (!h) continue;
			const g = gradAt(m, f, h.t, h.L[0], h.L[1], h.L[2]);
			const q = -(g[0] * nx + g[1] * ny);
			if (q > 0) { inflow.push({ x, y, nx, ny, w: (q * len) / 3 }); total += (q * len) / 3; }
		}
	}
	const segs: number[] = [], arrows: number[] = [];
	if (!(total > 0) || !inflow.length) return { segs: new Float64Array(0), arrows: new Float64Array(0), nLines: 0 };
	let acc = 0, k = 0;
	const seeds: In[] = [];
	for (const p of inflow) {
		const next = acc + p.w;
		while (k < nLines && ((k + 0.5) * total) / nLines <= next) { seeds.push(p); k++; }
		acc = next;
	}
	const P = (x: number, y: number) => {
		const h = loc.locate(x, y);
		if (!h) return null;
		const g = gradAt(m, f, h.t, h.L[0], h.L[1], h.L[2]);
		const t = h.t, o = m.npe * t;
		const A = 0.5 * Math.abs((N[2 * c[o + 1]!]! - N[2 * c[o]!]!) * (N[2 * c[o + 2]! + 1]! - N[2 * c[o]! + 1]!) - (N[2 * c[o + 2]!]! - N[2 * c[o]!]!) * (N[2 * c[o + 1]! + 1]! - N[2 * c[o]! + 1]!));
		return { gx: -g[0], gy: -g[1], h: Math.sqrt(A) };
	};
	for (const sd of seeds) {
		let x = sd.x, y = sd.y;
		const line: number[] = [x, y];
		let len = 0;
		for (let it = 0; it < 4000; it++) {
			const p0 = P(x, y);
			if (!p0) break;
			const n0 = Math.hypot(p0.gx, p0.gy);
			if (!(n0 > 0)) break;
			const st = 0.25 * p0.h;
			const xm = x + 0.5 * st * (p0.gx / n0), ym = y + 0.5 * st * (p0.gy / n0);
			const p1 = P(xm, ym);
			if (!p1) break;
			const n1 = Math.hypot(p1.gx, p1.gy);
			if (!(n1 > 0)) break;
			x += st * (p1.gx / n1); y += st * (p1.gy / n1);
			len += st;
			line.push(x, y);
		}
		if (line.length < 6) continue;
		for (let i = 0; i + 3 < line.length; i += 2) segs.push(line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!);
		// direction mark at 40 % of the arc length
		let s = 0;
		for (let i = 0; i + 3 < line.length; i += 2) {
			const dl = Math.hypot(line[i + 2]! - line[i]!, line[i + 3]! - line[i + 1]!);
			if (s + dl >= 0.4 * len) { arrows.push(line[i]!, line[i + 1]!, (line[i + 2]! - line[i]!) / dl, (line[i + 3]! - line[i + 1]!) / dl); break; }
			s += dl;
		}
	}
	return { segs: Float64Array.from(segs), arrows: Float64Array.from(arrows), nLines: seeds.length };
}
