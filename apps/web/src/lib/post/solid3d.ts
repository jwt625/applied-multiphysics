// SPDX-License-Identifier: GPL-3.0-or-later
// 3D post kernels on C2 meshes (DevLog-011 s.1.5), run in the post worker; only display arrays leave it.
// - exterior: boundary faces of tet4 / tet10 (corners) / hex8 / prism6 cells (faces seen once), triangulated,
//   de-indexed so nodal (H1) and per-cell (DG0) values map to vertices directly.
// - iso / slice: marching tetrahedra. The tet case table and the cut interpolation follow the isosurface kernel of
//   advanced-packaging-atlas app/src/lib/sim/post.ts at fe39985 (GPL-3.0-or-later), generalized from the rectilinear
//   hex grid to C2 cells (hex8 split into 6 tets around the 0-6 diagonal in VTK order, prism6 into 3). Exact for the
//   linear interpolant of corner values on each tet. A slice is the zero level set of the signed distance to the plane,
//   with the field interpolated at the cut points.
import type { Mesh } from '@amp/spec/types';

type V3 = [number, number, number];

const TETS: Record<string, number[][]> = {
	tet4: [[0, 1, 2, 3]],
	tet10: [[0, 1, 2, 3]],
	hex8: [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]],
	prism6: [[0, 1, 2, 3], [1, 2, 3, 4], [2, 3, 4, 5]]
};
const FACES: Record<string, number[][]> = {
	tet4: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
	tet10: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
	hex8: [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]],
	prism6: [[0, 2, 1], [3, 4, 5], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]]
};
const NPE: Record<string, number> = { tet4: 4, tet10: 10, hex8: 8, prism6: 6 };

export function cellInfo(m: Mesh) {
	const t = m.cells.type;
	const npe = NPE[t];
	if (!npe || m.dim !== 3) throw new Error(`3D post: cell type ${t} not supported`);
	return { npe, nC: m.cells.conn.length / npe, tets: TETS[t]!, faces: FACES[t]! };
}

export function bbox3(N: ArrayLike<number>): { lo: V3; hi: V3; c: V3; diag: number } {
	const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < N.length; i += 3) for (let k = 0; k < 3; k++) { const v = N[i + k]!; if (v < lo[k]!) lo[k] = v; if (v > hi[k]!) hi[k] = v; }
	const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
	return { lo, hi, c, diag: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) };
}

export interface Surface {
	/** triangle soup: 9 floats per triangle, metres relative to `c0` */
	pos: Float32Array;
	/** node index per vertex (nodal fields and displacement); for tet10 mid-edge vertices the mid-edge node */
	node: Int32Array;
	/** the two corner nodes of the edge of a mid-edge vertex (corner vertices: the node twice), for P1 fields */
	pair: Int32Array;
	/** cell index per vertex (DG0 fields) */
	cell: Int32Array;
	/** smooth outward unit normal per vertex (area-weighted over the faces at the node within a 35 deg crease) */
	nrm: Float32Array;
	/** wireframe segments: pairs of node indices (corner edges) */
	edges: Int32Array;
	/** feature edges (dihedral angle between the adjacent exterior faces above 30 deg): pairs of node indices */
	features: Int32Array;
	c0: V3;
}

/** tet10 mid-edge node (VTK order: corners, (01) (12) (02) (03) (13) (23)) of the local corner pair. */
const TET10_MID: Record<string, number> = { '0,1': 4, '1,2': 5, '0,2': 6, '0,3': 7, '1,3': 8, '2,3': 9 };

/**
 * Exterior faces (seen by one cell only), oriented outward (cell centroid test), triangulated. tet10 faces are split
 * into 4 triangles through their mid-edge nodes, so curved faces are drawn curved and P2 nodal values are exact at
 * all 6 face nodes (DevLog-015).
 */
export function exterior(m: Mesh): Surface {
	const { npe, nC, faces } = cellInfo(m);
	const C = m.cells.conn, N = m.nodes;
	const quad = m.cells.type === 'tet10';
	const seen = new Map<string, { cell: number; f: number[]; loc: number[] } | null>();
	for (let e = 0; e < nC; e++)
		for (const f of faces) {
			const nodes = f.map((k) => C[npe * e + k]!);
			const key = [...nodes].sort((a, b) => a - b).join(',');
			if (seen.has(key)) seen.set(key, null);
			else seen.set(key, { cell: e, f: nodes, loc: f });
		}
	const c0 = bbox3(N).c;
	const P = (i: number, k: number) => N[3 * i + k]!;
	const tri: number[] = [], triCell: number[] = [], triPair: number[] = [];
	const edges: number[] = [];
	const enorm = new Map<string, { a: number; b: number; n: number[][] }>();
	const fnormal = (a: number, b: number, c: number): number[] => {
		const u = [P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2)], w = [P(c, 0) - P(a, 0), P(c, 1) - P(a, 1), P(c, 2) - P(a, 2)];
		return [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
	};
	const unit = (v: number[]) => { const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1; return [v[0]! / l, v[1]! / l, v[2]! / l]; };
	for (const v of seen.values()) {
		if (!v) continue;
		let f = v.f, loc = v.loc;
		// outward: the face normal points away from the cell centroid
		const nc = Math.min(npe, quad ? 4 : npe);
		const cc = [0, 0, 0];
		for (let k = 0; k < nc; k++) for (let d = 0; d < 3; d++) cc[d]! += P(C[npe * v.cell + k]!, d) / nc;
		const fc = [0, 0, 0];
		for (const n of f) for (let d = 0; d < 3; d++) fc[d]! += P(n, d) / f.length;
		const n0 = fnormal(f[0]!, f[1]!, f[2]!);
		if (n0[0]! * (fc[0]! - cc[0]!) + n0[1]! * (fc[1]! - cc[1]!) + n0[2]! * (fc[2]! - cc[2]!) < 0) { f = [...f].reverse(); loc = [...loc].reverse(); }
		const fn = unit(fnormal(f[0]!, f[1]!, f[2]!));
		const push = (a: number, b: number, c: number, pa: [number, number], pb: [number, number], pc: [number, number]) => { tri.push(a, b, c); triCell.push(v.cell); triPair.push(...pa, ...pb, ...pc); };
		if (quad && f.length === 3) {
			const mid = (i: number, j: number) => { const a = loc[i]!, b = loc[j]!; return C[npe * v.cell + TET10_MID[a < b ? `${a},${b}` : `${b},${a}`]!]!; };
			const [A, B, Cc] = f as [number, number, number];
			const ab = mid(0, 1), bc = mid(1, 2), ca = mid(2, 0);
			push(A, ab, ca, [A, A], [A, B], [Cc, A]);
			push(ab, B, bc, [A, B], [B, B], [B, Cc]);
			push(ca, bc, Cc, [Cc, A], [B, Cc], [Cc, Cc]);
			push(ab, bc, ca, [A, B], [B, Cc], [Cc, A]);
		} else for (let k = 1; k + 1 < f.length; k++) push(f[0]!, f[k]!, f[k + 1]!, [f[0]!, f[0]!], [f[k]!, f[k]!], [f[k + 1]!, f[k + 1]!]);
		for (let k = 0; k < f.length; k++) {
			const a = f[k]!, b = f[(k + 1) % f.length]!, key = a < b ? `${a},${b}` : `${b},${a}`;
			const e = enorm.get(key);
			if (!e) { enorm.set(key, { a, b, n: [fn] }); edges.push(a, b); } else e.n.push(fn);
		}
	}
	// smooth normals: per node, area-weighted triangle normals; each vertex takes those within 35 deg of its own face
	const nT = tri.length / 3;
	const tn = new Float64Array(3 * nT);
	const at = new Map<number, number[]>();
	for (let t = 0; t < nT; t++) {
		const n = fnormal(tri[3 * t]!, tri[3 * t + 1]!, tri[3 * t + 2]!);
		tn.set(n, 3 * t);
		for (let k = 0; k < 3; k++) { const id = tri[3 * t + k]!; const l = at.get(id); if (l) l.push(t); else at.set(id, [t]); }
	}
	const cosC = Math.cos((35 * Math.PI) / 180);
	const pos = new Float32Array(9 * nT), nrm = new Float32Array(9 * nT), node = new Int32Array(3 * nT), cell = new Int32Array(3 * nT), pair = new Int32Array(6 * nT);
	for (let t = 0; t < nT; t++) {
		const own = unit([tn[3 * t]!, tn[3 * t + 1]!, tn[3 * t + 2]!]);
		for (let k = 0; k < 3; k++) {
			const id = tri[3 * t + k]!, o = 3 * (3 * t + k);
			let sx = 0, sy = 0, sz = 0;
			for (const q of at.get(id)!) {
				const qx = tn[3 * q]!, qy = tn[3 * q + 1]!, qz = tn[3 * q + 2]!, l = Math.hypot(qx, qy, qz) || 1;
				if ((qx * own[0]! + qy * own[1]! + qz * own[2]!) / l >= cosC) { sx += qx; sy += qy; sz += qz; }
			}
			const n = unit([sx, sy, sz]);
			for (let d = 0; d < 3; d++) { pos[o + d] = P(id, d) - c0[d]!; nrm[o + d] = n[d]!; }
			node[3 * t + k] = id;
			cell[3 * t + k] = triCell[t]!;
			pair[2 * (3 * t + k)] = triPair[6 * t + 2 * k]!;
			pair[2 * (3 * t + k) + 1] = triPair[6 * t + 2 * k + 1]!;
		}
	}
	const feat: number[] = [];
	const cos30 = Math.cos(Math.PI / 6);
	for (const e of enorm.values()) {
		const [n0, n1] = e.n;
		if (!n1 || n0![0]! * n1[0]! + n0![1]! * n1[1]! + n0![2]! * n1[2]! < cos30) feat.push(e.a, e.b);
	}
	return { pos, node, pair, cell, nrm, edges: Int32Array.from(edges), features: Int32Array.from(feat), c0 };
}

export interface Cut {
	/** 9 floats per triangle, metres relative to c0 */
	pos: Float32Array;
	/** colour value per vertex (level for iso, interpolated field for slices) */
	val: Float32Array;
	/** interpolated displacement per vertex (3 floats) when given */
	disp: Float32Array | null;
	nTri: number;
}

/**
 * Marching tetrahedra of the scalar `s` (one value per node) at `level`; `carry` (per node) is interpolated to the cut
 * vertices, `disp` (3 per node) too.
 */
export function marchingTets(m: Mesh, s: ArrayLike<number>, level: number, carry: ArrayLike<number> | null, disp: ArrayLike<number> | null, c0: V3): Cut {
	const { npe, nC, tets } = cellInfo(m);
	const C = m.cells.conn, N = m.nodes;
	const pos: number[] = [], val: number[] = [], dsp: number[] = [];
	const nd = new Int32Array(4);
	const cut = (a: number, b: number) => {
		const sa = s[a]!, sb = s[b]!;
		const f = sb === sa ? 0.5 : (level - sa) / (sb - sa);
		for (let k = 0; k < 3; k++) pos.push(N[3 * a + k]! + f * (N[3 * b + k]! - N[3 * a + k]!) - c0[k]!);
		val.push(carry ? carry[a]! + f * (carry[b]! - carry[a]!) : level);
		if (disp) for (let k = 0; k < 3; k++) dsp.push(disp[3 * a + k]! + f * (disp[3 * b + k]! - disp[3 * a + k]!));
	};
	for (let e = 0; e < nC; e++) {
		let lo = Infinity, hi = -Infinity;
		for (let k = 0; k < npe && k < 8; k++) { const v = s[C[npe * e + k]!]!; if (v < lo) lo = v; if (v > hi) hi = v; }
		if (level < lo || level > hi) continue;
		for (const t of tets) {
			for (let k = 0; k < 4; k++) nd[k] = C[npe * e + t[k]!]!;
			const inside: number[] = [], outside: number[] = [];
			for (let k = 0; k < 4; k++) (s[nd[k]!]! >= level ? inside : outside).push(nd[k]!);
			if (!inside.length || !outside.length) continue;
			if (inside.length === 1 || outside.length === 1) {
				const one = inside.length === 1 ? inside[0]! : outside[0]!;
				const rest = inside.length === 1 ? outside : inside;
				cut(one, rest[0]!); cut(one, rest[1]!); cut(one, rest[2]!);
			} else {
				const [a, b] = inside as [number, number], [c, d] = outside as [number, number];
				cut(a, c); cut(a, d); cut(b, d);
				cut(a, c); cut(b, d); cut(b, c);
			}
		}
	}
	return { pos: Float32Array.from(pos), val: Float32Array.from(val), disp: disp ? Float32Array.from(dsp) : null, nTri: val.length / 3 };
}

/** Plane slice n . x = d (n unit) with the nodal field `f` on it. */
export function slice(m: Mesh, nrm: V3, d: number, f: ArrayLike<number> | null, disp: ArrayLike<number> | null, c0: V3): Cut {
	const N = m.nodes, nn = N.length / 3;
	const sd = new Float64Array(nn);
	for (let i = 0; i < nn; i++) sd[i] = nrm[0] * N[3 * i]! + nrm[1] * N[3 * i + 1]! + nrm[2] * N[3 * i + 2]! - d;
	return marchingTets(m, sd, 0, f, disp, c0);
}

/** Total area of a cut (m^2), for tests and diagnostics. */
export function cutArea(c: Cut): number {
	let A = 0;
	const p = c.pos;
	for (let t = 0; t < c.nTri; t++) {
		const o = 9 * t;
		const ux = p[o + 3]! - p[o]!, uy = p[o + 4]! - p[o + 1]!, uz = p[o + 5]! - p[o + 2]!;
		const vx = p[o + 6]! - p[o]!, vy = p[o + 7]! - p[o + 1]!, vz = p[o + 8]! - p[o + 2]!;
		A += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
	}
	return A;
}

/** Automatic deformation scale: 10 % of the bounding-box diagonal over max |u| (APA decision 2026-10-20). */
export function autoDeformScale(diag: number, u: ArrayLike<number>, comps = 3): number {
	let mx = 0;
	for (let i = 0; i < u.length; i += comps) {
		let s = 0;
		for (let k = 0; k < comps; k++) s += u[i + k]! ** 2;
		if (s > mx) mx = s;
	}
	return mx > 0 ? (0.1 * diag) / Math.sqrt(mx) : 0;
}

/** Mean-ratio quality per cell: tets 12 (3|V|)^(2/3) / sum l^2 (1 = regular); hex/prism: min over their tets. */
export function cellQuality(m: Mesh): Float64Array {
	const { npe, nC, tets } = cellInfo(m);
	const C = m.cells.conn, N = m.nodes;
	const out = new Float64Array(nC);
	const tq = (a: number, b: number, c: number, d: number) => {
		const P = (i: number, k: number) => N[3 * i + k]!;
		const u = [P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2)];
		const v = [P(c, 0) - P(a, 0), P(c, 1) - P(a, 1), P(c, 2) - P(a, 2)];
		const w = [P(d, 0) - P(a, 0), P(d, 1) - P(a, 1), P(d, 2) - P(a, 2)];
		const V = (u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!)) / 6;
		let s = 0;
		for (const [x, y] of [[a, b], [a, c], [a, d], [b, c], [b, d], [c, d]] as const) s += (P(x, 0) - P(y, 0)) ** 2 + (P(x, 1) - P(y, 1)) ** 2 + (P(x, 2) - P(y, 2)) ** 2;
		return s > 0 ? (12 * Math.cbrt((3 * Math.abs(V)) ** 2)) / s : 0;
	};
	for (let e = 0; e < nC; e++) {
		let q = Infinity;
		for (const t of tets) q = Math.min(q, tq(C[npe * e + t[0]!]!, C[npe * e + t[1]!]!, C[npe * e + t[2]!]!, C[npe * e + t[3]!]!));
		out[e] = q;
	}
	return out;
}
