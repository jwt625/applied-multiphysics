// SPDX-License-Identifier: GPL-3.0-or-later
// 3D display of an axisymmetric (r, z) solution (Pass 2 item 5; DevLog-015): the boundary of the meridional mesh
// revolved about the z axis into a surface of revolution, and the azimuthal-order-m field reconstructed on it:
//   E_r(r, z) cos(m phi), E_phi(r, z) sin(m phi), E_z(r, z) cos(m phi)
// i.e. one partner of an m >= 1 doublet (the other is rotated by pi / (2m)); sign convention arbitrary. Display only.
// DevLog-015: line3 boundary facets are revolved through their mid node (curved profile, exact nodal values at all
// three facet nodes, or their P1 interpolant when the data covers corners only); smooth normals from the profile (crease 35 deg); an optional cutaway keeps phi in [phi0, phi1]
// and closes the opening with the meridional section itself at phi0 and phi1 (the 2D mesh, tri6 split into 4
// triangles through the mid-edge nodes), so the field inside the cavity is visible. Every vertex is a 2D mesh node:
// the values drawn are the 2D nodal field (for E_rphiz: the vertex-averaged P1 projection of the Nedelec solution)
// times the azimuthal factor.
import type { Mesh } from '@amp/spec/types';

export interface RevolvedSurface {
	pos: Float32Array;
	/** unit normal per vertex */
	nrm: Float32Array;
	node: Int32Array;
	/** corner pair of a mid-edge vertex (tri6 / line3 mid nodes; corners: the node twice), for nodal data on corners only */
	pair: Int32Array;
	phi: Float32Array;
	/** ring circles at geometry corners and the outline of the section planes, segment pairs (3 floats per vertex) */
	rings: Float32Array;
	c0: [number, number, number];
	half: [number, number, number];
}

const TRI6_SPLIT = [[0, 3, 5], [3, 1, 4], [5, 4, 2], [3, 4, 5]];

export function revolveSurface(m: Mesh, nPhi = 64, cut: [number, number] | null = null): RevolvedSurface {
	const N = m.nodes, f = m.facets, c = m.cells;
	const npf = f.type === 'line3' ? 3 : 2, nf = f.conn.length / npf;
	const npc = c.type === 'tri6' ? 6 : 3, nc = c.conn.length / npc;
	let rmax = 0, z0 = Infinity, z1 = -Infinity;
	for (let i = 0; i < N.length; i += 2) { rmax = Math.max(rmax, N[i]!); z0 = Math.min(z0, N[i + 1]!); z1 = Math.max(z1, N[i + 1]!); }
	const zc = (z0 + z1) / 2, tol = 1e-9 * Math.max(rmax, z1 - z0);
	const R = (n: number) => N[2 * n]!, Z = (n: number) => N[2 * n + 1]!;
	const [p0, p1] = cut ?? [0, 2 * Math.PI];
	const K = Math.max(4, Math.round((nPhi * (p1 - p0)) / (2 * Math.PI)));
	const phiK = (k: number) => p0 + ((p1 - p0) * k) / K;

	// outward side of each boundary facet: away from the centroid of the cell that owns its corner edge
	const owner = new Map<string, number>();
	for (let e = 0; e < nc; e++) for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) { const a = c.conn[npc * e + i]!, b = c.conn[npc * e + j]!; owner.set(a < b ? `${a},${b}` : `${b},${a}`, e); }
	type Seg = { a: number; b: number; e: number; n: [number, number] };
	const segs: Seg[] = [];
	for (let s = 0; s < nf; s++) {
		const a = f.conn[npf * s]!, b = f.conn[npf * s + 1]!;
		if (R(a) < tol && R(b) < tol) continue; // on the axis: not a surface
		const cell = owner.get(a < b ? `${a},${b}` : `${b},${a}`);
		let cr = 0, cz = 0;
		if (cell !== undefined) { for (let k = 0; k < 3; k++) { cr += R(c.conn[npc * cell + k]!) / 3; cz += Z(c.conn[npc * cell + k]!) / 3; } }
		const parts = npf === 3 ? [[a, f.conn[3 * s + 2]!], [f.conn[3 * s + 2]!, b]] : [[a, b]];
		for (const [p, q] of parts as Array<[number, number]>) {
			const dr = R(q) - R(p), dz = Z(q) - Z(p), l = Math.hypot(dr, dz) || 1;
			let n: [number, number] = [dz / l, -dr / l];
			const mr = (R(p) + R(q)) / 2 - cr, mz = (Z(p) + Z(q)) / 2 - cz;
			if (cell !== undefined && n[0] * mr + n[1] * mz < 0) n = [-n[0], -n[1]];
			segs.push({ a: p, b: q, e: f.boundary[s]!, n });
		}
	}
	// smooth profile normal at a segment end: segments at that node within 35 deg of this one
	const at = new Map<number, Seg[]>();
	for (const g of segs) for (const n of [g.a, g.b]) { const l = at.get(n); if (l) l.push(g); else at.set(n, [g]); }
	const cosC = Math.cos((35 * Math.PI) / 180);
	const endNormal = (g: Seg, n: number): [number, number] => {
		let sr = 0, sz = 0;
		for (const h of at.get(n)!) if (h.n[0] * g.n[0] + h.n[1] * g.n[1] >= cosC) { sr += h.n[0]; sz += h.n[1]; }
		const l = Math.hypot(sr, sz) || 1;
		return [sr / l, sz / l];
	};

	const pos: number[] = [], nrm: number[] = [], node: number[] = [], phi: number[] = [], pair: number[] = [];
	// corners of each mid node (line3 facets, tri6 cells)
	const mids = new Map<number, [number, number]>();
	if (npf === 3) for (let s = 0; s < nf; s++) mids.set(f.conn[3 * s + 2]!, [f.conn[3 * s]!, f.conn[3 * s + 1]!]);
	if (npc === 6) for (let e = 0; e < nc; e++) for (const [mi, a, b] of [[3, 0, 1], [4, 1, 2], [5, 2, 0]] as const) mids.set(c.conn[6 * e + mi]!, [c.conn[6 * e + a]!, c.conn[6 * e + b]!]);
	const vert = (n: number, p: number, nx: number, ny: number, nz: number) => {
		const r = R(n);
		pos.push(r * Math.cos(p), r * Math.sin(p), Z(n) - zc);
		nrm.push(nx, ny, nz);
		node.push(n);
		phi.push(p);
		const pr = mids.get(n);
		pair.push(pr ? pr[0] : n, pr ? pr[1] : n);
	};
	const shell = (n: number, p: number, pn: [number, number]) => vert(n, p, pn[0] * Math.cos(p), pn[0] * Math.sin(p), pn[1]);
	for (const g of segs) {
		const na = endNormal(g, g.a), nb = endNormal(g, g.b);
		for (let k = 0; k < K; k++) {
			const q0 = phiK(k), q1 = phiK(k + 1);
			shell(g.a, q0, na); shell(g.b, q0, nb); shell(g.b, q1, nb);
			shell(g.a, q0, na); shell(g.b, q1, nb); shell(g.a, q1, na);
		}
	}
	// section planes of a cutaway: the meridional mesh at phi0 (outward normal -e_phi) and phi1 (+e_phi)
	if (cut) {
		for (const [p, sgn] of [[p0, -1], [p1, 1]] as const) {
			const nx = -Math.sin(p) * sgn, ny = Math.cos(p) * sgn;
			for (let e = 0; e < nc; e++) {
				const tris = npc === 6 ? TRI6_SPLIT : [[0, 1, 2]];
				for (const t of tris) for (const k of t) vert(c.conn[npc * e + k]!, p, nx, ny, 0);
			}
		}
	}

	// rings where the boundary entity changes (geometry corners), off the axis, over the kept range
	const ent = new Map<number, Set<number>>();
	for (const g of segs) for (const n of [g.a, g.b]) { const s = ent.get(n) ?? new Set(); s.add(g.e); ent.set(n, s); }
	const rings: number[] = [];
	for (const [n, s] of ent) {
		if (s.size < 2 || R(n) < tol) continue;
		const r = R(n), z = Z(n) - zc;
		for (let k = 0; k < K; k++) { const q0 = phiK(k), q1 = phiK(k + 1); rings.push(r * Math.cos(q0), r * Math.sin(q0), z, r * Math.cos(q1), r * Math.sin(q1), z); }
	}
	// outline of the section planes (the meridional boundary, axis included)
	if (cut) for (const p of [p0, p1]) for (let s = 0; s < nf; s++) {
		const ids = npf === 3 ? [f.conn[3 * s]!, f.conn[3 * s + 2]!, f.conn[3 * s + 1]!] : [f.conn[2 * s]!, f.conn[2 * s + 1]!];
		for (let k = 0; k + 1 < ids.length; k++) { const a = ids[k]!, b = ids[k + 1]!; rings.push(R(a) * Math.cos(p), R(a) * Math.sin(p), Z(a) - zc, R(b) * Math.cos(p), R(b) * Math.sin(p), Z(b) - zc); }
	}
	return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), node: Int32Array.from(node), pair: Int32Array.from(pair), phi: Float32Array.from(phi), rings: Float32Array.from(rings), c0: [0, 0, zc], half: [rmax, rmax, (z1 - z0) / 2] };
}

/** Reconstructed field at the revolved vertices: comp -1 magnitude, 0 E_r, 1 E_phi, 2 E_z (Cartesian-free, display). */
export function revolvedValues(data: ArrayLike<number>, m: number, comp: number, s: RevolvedSurface, a = 1, p1 = true): Float32Array {
	const n = s.node.length, out = new Float32Array(n), nData = data.length / 3;
	// a P1 field (H1P1) is defined by its corner values: a mid node takes the mean of its edge corners (the P1
	// interpolant there; em-axisym stores 0 at mid nodes, checked 2026-11-06); a P2 field: the node's own value
	const at = (i: number, d: number) => { const k = s.node[i]!; return k < nData && (!p1 || s.pair[2 * i] === s.pair[2 * i + 1]) ? data[3 * k + d]! : 0.5 * (data[3 * s.pair[2 * i]! + d]! + data[3 * s.pair[2 * i + 1]! + d]!); };
	for (let i = 0; i < n; i++) {
		// m = 0: no azimuthal variation of any component (TM0n: E_r, E_z; TE0n: E_phi)
		const p = s.phi[i]!, c = m === 0 ? 1 : Math.cos(m * p), sn = m === 0 ? 1 : Math.sin(m * p);
		const er = at(i, 0) * c, ep = at(i, 1) * sn, ez = at(i, 2) * c;
		out[i] = a * (comp === 0 ? er : comp === 1 ? ep : comp === 2 ? ez : Math.hypot(er, ep, ez));
	}
	return out;
}
