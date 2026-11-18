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
	/** study to solve (amp-spec `studies[].id`); absent = the first study */
	studyId?: string;
}

export type ToRunner = ToWorker;
export type FromRunner =
	| FromWorker
	| { type: 'mesh'; id: string; mesh: Mesh; quality: Float64Array; ms: { parse: number; geometry: number; mesh: number }; source: string; ts: string }
	| { type: 'unavailable'; id: string; reasons: string[]; ts: string };

export const nowIso = (): string => {
	const d = new Date();
	const off = -d.getTimezoneOffset();
	const p = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
};

/** Box in the model plane (m). */
export interface Box2 { x0: number; y0: number; x1: number; y1: number }
/** One frequency of a driven 2D solve (@amp/physics wave2d, DevLog-042 s.1.5 / s.6 R4). */
export interface Wave2DFrequency {
	/** Hz */
	f: number;
	/** power-normalised scattering matrix over the reported (port, mode) keys, row-major (i = out, j = in) */
	S?: { keys: Array<{ port: string; mode: number }>; re: number[]; im: number[] };
	/** propagation constants per port and mode (1/m), [re, im] */
	beta?: Array<Array<[number, number]>>;
	/** outgoing power of the sources per port (W/m) */
	srcPower?: number[];
	/** 2D scattering width over the angle phi (rad, from +x), m */
	farField?: { phi: number[]; sigma2d: number[]; band?: unknown; bandCells?: number };
}
export interface Wave2DExtras {
	kind: 'emw' | 'acoustics';
	polarization?: 'TM' | 'TE';
	/** base name of the complex field (Ez, Hz, p) */
	field: string;
	freqs: number[];
	perFrequency: Wave2DFrequency[];
	/** non-PML region (inner) and the whole physics box (outer) when the model has a PML */
	pml: { inner: Box2; outer: Box2 } | null;
	/** band structure of a periodic cell (bands study): path points, cumulative path length, frequencies per point */
	bands?: Wave2DBands;
}
export interface Wave2DBands {
	/** labelled path points (index into the path) */
	labels: Array<{ index: number; label: string }>;
	/** cumulative path length (1/m), the plot axis */
	distance: number[];
	/** eigenfrequencies (Hz) per path point, one per band */
	f: number[][];
	/** lattice vectors a_i and reciprocal vectors b_i (m, 1/m) */
	lattice?: { a: number[][]; b?: number[][] };
	/** field steps of the solution: path point label and band (0-based) per eigen step */
	fieldSteps?: Array<{ step: number; label: string; k: number; band: number }>;
}
/**
 * Properties a module may add to its Solution beyond C5 (`wave2d`, `notes`, `normalization`). The runner posts the
 * Solution object as is; a structured clone keeps own enumerable properties, so these reach the main thread unchanged.
 */
export interface SolutionExtras { wave2d?: Wave2DExtras; notes?: string[]; normalization?: string }

const isBox = (b: unknown): b is Box2 => !!b && typeof b === 'object' && ['x0', 'y0', 'x1', 'y1'].every((k) => Number.isFinite((b as Record<string, unknown>)[k]));
/** The driven-solve extras of a solution, or null when absent or malformed (a module from another version). */
export function wave2dOf(sol: unknown): Wave2DExtras | null {
	const w = (sol as { wave2d?: unknown } | null)?.wave2d as Partial<Wave2DExtras> | undefined;
	if (!w || typeof w !== 'object') return null;
	const b = w.bands as Partial<Wave2DBands> | undefined;
	const bands = b && Array.isArray(b.distance) && Array.isArray(b.f) && b.f.length === b.distance.length && b.f.every((r) => Array.isArray(r)) ? { labels: Array.isArray(b.labels) ? b.labels.filter((l) => Number.isInteger(l?.index) && typeof l?.label === 'string') : [], distance: b.distance.map(Number), f: b.f, ...(b.lattice && Array.isArray(b.lattice.a) ? { lattice: b.lattice } : {}), ...(Array.isArray(b.fieldSteps) ? { fieldSteps: b.fieldSteps } : {}) } : null;
	if (!bands && (!Array.isArray(w.freqs) || !Array.isArray(w.perFrequency))) return null;
	const pml = w.pml && isBox(w.pml.inner) && isBox(w.pml.outer) ? w.pml : null;
	return { kind: w.kind === 'acoustics' ? 'acoustics' : 'emw', ...(w.polarization ? { polarization: w.polarization } : {}), field: String(w.field ?? ''), freqs: Array.isArray(w.freqs) ? w.freqs.map(Number) : [], perFrequency: Array.isArray(w.perFrequency) ? w.perFrequency : [], pml, ...(bands ? { bands } : {}) };
}
/** Solver notes of a solution (module remarks such as a quantity not computed), [] when none. */
export function notesOf(sol: unknown): string[] {
	const n = (sol as { notes?: unknown } | null)?.notes;
	return Array.isArray(n) ? n.map(String) : [];
}

/** Typed arrays of a mesh, for transfer. */
export function meshBuffers(m: Mesh): ArrayBuffer[] {
	const out = [m.nodes, m.cells.conn, m.cells.domain, m.facets.conn, m.facets.boundary].map((a) => a.buffer as ArrayBuffer);
	return [...new Set(out)];
}
