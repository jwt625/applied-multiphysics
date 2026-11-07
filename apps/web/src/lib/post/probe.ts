// SPDX-License-Identifier: GPL-3.0-or-later
// Probe table (DevLog-020 s.1.4): point evaluations of the displayed field at clicked points. 2D: exact FE evaluation
// in the post worker (`evalAt`, the hover-probe path); 3D: `@amp/post` `sample` on the main thread at the picked
// surface point. Values are converted with the view's display affine (spec unit, or eigenmode normalization) so the
// table shows what the colorbar shows. Ray picking of the drawn 3D surface and TSV export live here too.
import type { FieldData, Mesh, Solution } from '@amp/spec/types';
import type { PostClient } from './client';
import type { Space } from './field2d';

export interface ProbeRow {
	n: number;
	ts: string;
	dim: 2 | 3;
	/** point in m (SI) */
	p: [number, number, number];
	/** length unit of the coordinate columns and its factor from m */
	lu: { unit: string; f: number };
	/** field label as drawn (name, component or magnitude) */
	field: string;
	/** value in `unit` (display unit of the colorbar), null outside the mesh */
	value: number | null;
	unit: string;
	/** dataset (sweep point label) or '' for a single solution */
	dataset: string;
	/** sweep point index, -1 without a sweep */
	point: number;
	/** run the value was computed from (Solution.run.startedAt) */
	run: string;
	/** dataset identity (Session.datasetKey): the row's mark is drawn while this dataset is shown */
	key: string;
}

/** Field value at a 2D point (m): exact FE evaluation in the post worker; component -1 = magnitude. */
export async function probe2d(post: PostClient, f: FieldData, comp: number, x: number, y: number): Promise<number | null> {
	const r = await post.call<'evalAt'>({ type: 'evalAt', field: { space: f.space as Space, data: f.data, components: f.components }, comp, points: [x, y] });
	const v = r.values[0];
	return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/** Field value at a 3D surface point (m) with @amp/post sample (point location + isoparametric interpolation).
 *  The picked point comes from Float32 drawing positions, so it can sit up to ~1e-7 relative outside the mesh: when
 *  the point itself is not located, it is retried 1e-6 of the model size along -dir, +dir and toward the centre c.
 *  NaN everywhere -> null. @amp/post loads on the first 3D probe (not in the first-paint bundle). */
export async function probe3d(sol: Solution, mesh: Mesh, f: FieldData, comp: number, p: [number, number, number], dir: [number, number, number], c: [number, number, number], size: number): Promise<number | null> {
	const { sample } = await import('@amp/post');
	const e = 1e-6 * size, dc = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) || 1;
	const pts = [p, p.map((v, k) => v - e * dir[k]!), p.map((v, k) => v + e * dir[k]!), p.map((v, k) => v + (e * (c[k]! - v)) / dc)];
	const vals = sample(sol, f.name, pts, { mesh, snap: 1e-3, component: comp < 0 ? 'norm' : comp, ...(f.step !== undefined ? { step: f.step } : {}) });
	for (const v of vals) if (Number.isFinite(v)) return v;
	return null;
}

/**
 * Nearest intersection of a ray with a triangle soup (positions relative to the mesh centre, optional displacement
 * times scale, as drawn), skipping the clipped half space dot(p, n) > d. Returns the hit point as drawn and the same
 * surface point on the undeformed body (where the field is evaluated), both in the input frame, or null.
 */
export function rayHit(o: [number, number, number], dir: [number, number, number], pos: Float32Array, disp: Float32Array | null, scale: number, clip: { n: [number, number, number]; d: number } | null): { drawn: [number, number, number]; ref: [number, number, number] } | null {
	const P = (i: number, k: number) => pos[3 * i + k]! + (disp ? scale * disp[3 * i + k]! : 0);
	let best = Infinity, bt = -1, bu = 0, bv = 0;
	for (let t = 0; t + 2 < pos.length / 3; t += 3) {
		const ax = P(t, 0), ay = P(t, 1), az = P(t, 2);
		const e1x = P(t + 1, 0) - ax, e1y = P(t + 1, 1) - ay, e1z = P(t + 1, 2) - az;
		const e2x = P(t + 2, 0) - ax, e2y = P(t + 2, 1) - ay, e2z = P(t + 2, 2) - az;
		// Moller-Trumbore
		const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
		const det = e1x * px + e1y * py + e1z * pz;
		if (Math.abs(det) < 1e-30) continue;
		const inv = 1 / det, tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
		const u = (tx * px + ty * py + tz * pz) * inv;
		if (u < 0 || u > 1) continue;
		const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
		const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
		if (v < 0 || u + v > 1) continue;
		const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
		if (s <= 0 || s >= best) continue;
		if (clip) {
			const hx = o[0] + s * dir[0], hy = o[1] + s * dir[1], hz = o[2] + s * dir[2];
			if (hx * clip.n[0] + hy * clip.n[1] + hz * clip.n[2] > clip.d) continue;
		}
		best = s; bt = t; bu = u; bv = v;
	}
	if (bt < 0) return null;
	const R = (k: number) => (1 - bu - bv) * pos[3 * bt + k]! + bu * pos[3 * (bt + 1) + k]! + bv * pos[3 * (bt + 2) + k]!;
	return { drawn: [o[0] + best * dir[0], o[1] + best * dir[1], o[2] + best * dir[2]], ref: [R(0), R(1), R(2)] };
}

const num = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(8)).toString() : '');

/** Header of the table and of the TSV export (units in the column names). */
export function columns(rows: readonly ProbeRow[]): string[] {
	const lu = rows[0]?.lu.unit ?? 'm';
	const has3 = rows.some((r) => r.dim === 3);
	return ['#', `x (${lu})`, `y (${lu})`, ...(has3 ? [`z (${lu})`] : []), 'field', 'value', 'unit', 'dataset'];
}

/** TSV of the rows (tab-separated, one header line; lengths in each row's own length unit, converted to the first row's). */
export function toTsv(rows: readonly ProbeRow[]): string {
	const lu = rows[0]?.lu ?? { unit: 'm', f: 1 };
	const has3 = rows.some((r) => r.dim === 3);
	const out = [columns(rows).join('\t')];
	for (const r of rows) {
		const c = r.p.map((v) => num(v * lu.f));
		out.push([String(r.n), c[0], c[1], ...(has3 ? [r.dim === 3 ? c[2] : ''] : []), r.field, r.value === null ? 'N/A' : num(r.value), r.unit, r.dataset].join('\t'));
	}
	return out.join('\n') + '\n';
}
