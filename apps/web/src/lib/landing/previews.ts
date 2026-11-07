// SPDX-License-Identifier: GPL-3.0-or-later
// Preview images of the examples (DevLog-030): written by scripts/previews.ts to static/previews/<id>-<view>.<ext>,
// listed in ./previews.json (the manifest, bundled so the prerendered landing knows which images exist).
import { asset } from '$app/paths';
import manifest from './previews.json';

export type View = 'geom' | 'mesh' | 'result';
export const VIEWS: ReadonlyArray<{ id: View; label: string; tip: string }> = [
	{ id: 'geom', label: 'G', tip: 'Geometry' },
	{ id: 'mesh', label: 'M', tip: 'Mesh' },
	{ id: 'result', label: 'R', tip: 'Result (default plot of the solved model)' },
];

export interface PreviewEntry {
	/** sha256 of the sims file text + generator version */
	hash: string;
	/** ISO date of the capture */
	date: string;
	/** file names under static/previews; null = not captured */
	files: Record<View, string | null>;
	/** why a view is missing (e.g. 'solve: unavailable: ...') */
	missing?: Partial<Record<View, string>>;
	/** run facts from the capture: status, cells, solve time */
	status?: string;
	cells?: number;
	solveMs?: number;
}

export interface PreviewManifest {
	format: 'amp-previews/0';
	size: [number, number];
	sims: Record<string, PreviewEntry>;
}

const M = manifest as unknown as PreviewManifest;

export function previewOf(id: string): PreviewEntry | null {
	return M.sims?.[id] ?? null;
}

export function previewUrl(file: string): string {
	return asset(`/previews/${file}` as Parameters<typeof asset>[0]);
}

/** default view of a card: the result, else the mesh, else the geometry; null without any image */
export function defaultView(p: PreviewEntry | null): View | null {
	if (!p) return null;
	return p.files.result ? 'result' : p.files.mesh ? 'mesh' : p.files.geom ? 'geom' : null;
}
