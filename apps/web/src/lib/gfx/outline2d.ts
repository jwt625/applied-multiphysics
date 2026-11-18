// SPDX-License-Identifier: GPL-3.0-or-later
// 2D outline segments for the SVG overlay (split from Graphics.svelte, DevLog-052): boundary facets as segments
// x0 y0 x1 y1 (m), line3 facets as two segments through the mid node, mirrored copies of a symmetric display.
import type { Mesh } from '@amp/spec/types';

export interface Copy { sx: number; sy: number; sign: number }

/**
 * Segments of the facets whose boundary passes `keep` (all when null), on the node positions `nodes` (default the
 * mesh nodes; a deformed outline passes x + s u). With mirrored copies, facets lying on a mirror plane are skipped when
 * `skipPlanes` is given (they are interior lines of the mirrored model).
 */
export function facetSegments(mesh: Mesh, o: { keep?: ((boundary: number) => boolean) | null; nodes?: ArrayLike<number>; copies?: Copy[]; skipPlanes?: { x: boolean; y: boolean } | null; tol?: number } = {}): Float64Array {
	const f = mesh.facets, npf = f.type === 'line3' ? 3 : 2, n = f.conn.length / npf, N = o.nodes ?? mesh.nodes;
	const cps = o.copies ?? [{ sx: 1, sy: 1, sign: 1 }];
	const tol = o.tol ?? 0;
	const seg: number[] = [];
	for (let i = 0; i < n; i++) {
		if (o.keep && !o.keep(f.boundary[i]!)) continue;
		const ids = npf === 3 ? [f.conn[3 * i]!, f.conn[3 * i + 2]!, f.conn[3 * i + 1]!] : [f.conn[2 * i]!, f.conn[2 * i + 1]!];
		const xs = ids.map((k) => N[2 * k]!), ys = ids.map((k) => N[2 * k + 1]!);
		if (o.skipPlanes && cps.length > 1 && ((o.skipPlanes.x && xs.every((x) => Math.abs(x) < tol)) || (o.skipPlanes.y && ys.every((y) => Math.abs(y) < tol)))) continue;
		for (const c of cps) for (let k = 0; k + 1 < ids.length; k++) seg.push(c.sx * xs[k]!, c.sy * ys[k]!, c.sx * xs[k + 1]!, c.sy * ys[k + 1]!);
	}
	return Float64Array.from(seg);
}
