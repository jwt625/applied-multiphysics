// SPDX-License-Identifier: GPL-3.0-or-later
// 3D display of an axisymmetric (r, z) solution (Pass 2 item 5): the boundary of the meridional mesh revolved about the
// z axis into a surface of revolution (nPhi sectors), and the azimuthal-order-m field reconstructed on it:
//   E_r(r, z) cos(m phi), E_phi(r, z) sin(m phi), E_z(r, z) cos(m phi)
// i.e. one partner of an m >= 1 doublet (the other is rotated by pi / (2m)); sign convention arbitrary. Display only:
// values at the revolved vertices are the exact nodal values of the 2D field (vertices are 2D boundary nodes).
import type { Mesh } from '@amp/spec/types';

export interface RevolvedSurface {
	pos: Float32Array;
	node: Int32Array;
	phi: Float32Array;
	/** ring circles at geometry corners (feature edges), 3 floats per vertex, segment pairs */
	rings: Float32Array;
	c0: [number, number, number];
	half: [number, number, number];
}

export function revolveSurface(m: Mesh, nPhi = 64): RevolvedSurface {
	const N = m.nodes, f = m.facets;
	const npf = f.type === 'line3' ? 3 : 2, nf = f.conn.length / npf;
	let rmax = 0, z0 = Infinity, z1 = -Infinity;
	for (let i = 0; i < N.length; i += 2) { rmax = Math.max(rmax, N[i]!); z0 = Math.min(z0, N[i + 1]!); z1 = Math.max(z1, N[i + 1]!); }
	const zc = (z0 + z1) / 2, tol = 1e-9 * Math.max(rmax, z1 - z0);
	const pos: number[] = [], node: number[] = [], phi: number[] = [];
	const vert = (n: number, p: number) => { const r = N[2 * n]!; pos.push(r * Math.cos(p), r * Math.sin(p), N[2 * n + 1]! - zc); node.push(n); phi.push(p); };
	const segs: Array<[number, number, number]> = [];
	for (let s = 0; s < nf; s++) {
		const a = f.conn[npf * s]!, b = f.conn[npf * s + 1]!;
		if (N[2 * a]! < tol && N[2 * b]! < tol) continue; // on the axis: not a surface
		segs.push([a, b, f.boundary[s]!]);
		for (let k = 0; k < nPhi; k++) {
			const p0 = (2 * Math.PI * k) / nPhi, p1 = (2 * Math.PI * (k + 1)) / nPhi;
			vert(a, p0); vert(b, p0); vert(b, p1);
			vert(a, p0); vert(b, p1); vert(a, p1);
		}
	}
	// rings where the boundary entity changes (geometry corners), off the axis
	const ent = new Map<number, Set<number>>();
	for (const [a, b, e] of segs) for (const n of [a, b]) { const s = ent.get(n) ?? new Set(); s.add(e); ent.set(n, s); }
	const rings: number[] = [];
	for (const [n, s] of ent) {
		if (s.size < 2 || N[2 * n]! < tol) continue;
		const r = N[2 * n]!, z = N[2 * n + 1]! - zc;
		for (let k = 0; k < nPhi; k++) {
			const p0 = (2 * Math.PI * k) / nPhi, p1 = (2 * Math.PI * (k + 1)) / nPhi;
			rings.push(r * Math.cos(p0), r * Math.sin(p0), z, r * Math.cos(p1), r * Math.sin(p1), z);
		}
	}
	return { pos: Float32Array.from(pos), node: Int32Array.from(node), phi: Float32Array.from(phi), rings: Float32Array.from(rings), c0: [0, 0, zc], half: [rmax, rmax, (z1 - z0) / 2] };
}

/** Reconstructed field at the revolved vertices: comp -1 magnitude, 0 E_r, 1 E_phi, 2 E_z (Cartesian-free, display). */
export function revolvedValues(data: ArrayLike<number>, m: number, comp: number, s: RevolvedSurface, a = 1): Float32Array {
	const n = s.node.length, out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		// m = 0: no azimuthal variation of any component (TM0n: E_r, E_z; TE0n: E_phi)
		const k = s.node[i]!, p = s.phi[i]!, c = m === 0 ? 1 : Math.cos(m * p), sn = m === 0 ? 1 : Math.sin(m * p);
		const er = data[3 * k]! * c, ep = data[3 * k + 1]! * sn, ez = data[3 * k + 2]! * c;
		out[i] = a * (comp === 0 ? er : comp === 1 ? ep : comp === 2 ? ez : Math.hypot(er, ep, ez));
	}
	return out;
}
