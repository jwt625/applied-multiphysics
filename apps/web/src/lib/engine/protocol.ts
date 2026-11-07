// SPDX-License-Identifier: GPL-3.0-or-later
// Worker protocol: C6 (CONTRACTS-v0, types in @amp/spec/types) plus two additive messages proposed in DevLog-011 s.5:
// `mesh` (the mesh, sent before the solve so the Geometry and Mesh views update at once) and `unavailable` (no physics
// module registered or not ready: results are shown as unavailable, never faked).
import type { FromWorker, Mesh, ToWorker } from '@amp/spec/types';

export interface RunOptions {
	/** multiplies the mesh sizes (coarse re-solve during drags) */
	meshScale?: number;
	/** stop after meshing */
	meshOnly?: boolean;
	/** eval case data passed to @amp/physics prepareRun (sourced material values for N/A properties) */
	case?: Record<string, unknown>;
}

export type ToRunner = ToWorker;
export type FromRunner =
	| FromWorker
	| { type: 'mesh'; id: string; mesh: Mesh; ms: { parse: number; geometry: number; mesh: number }; source: string; ts: string }
	| { type: 'unavailable'; id: string; reasons: string[]; ts: string };

export const nowIso = (): string => {
	const d = new Date();
	const off = -d.getTimezoneOffset();
	const p = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
};

/** Typed arrays of a mesh, for transfer. */
export function meshBuffers(m: Mesh): ArrayBuffer[] {
	const out = [m.nodes, m.cells.conn, m.cells.domain, m.facets.conn, m.facets.boundary].map((a) => a.buffer as ArrayBuffer);
	return [...new Set(out)];
}
