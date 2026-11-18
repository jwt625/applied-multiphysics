// SPDX-License-Identifier: GPL-3.0-or-later
// Results that belong to the solved study: which headline items the displayed run can answer (the others are named
// with the study they need), and which plot group to show after a solve of another study. A results node belongs to
// the study at the root of its dataset chain (a solution dataset's `data`); the studies a run answers for come from
// `runStudies` (results/api.ts: the solved study, its inner study, the parametric studies over them).
import { headlineItems } from '@amp/spec';
import { runStudies } from '../results/api.ts';

type O = Record<string, unknown>;
const isObj = (x: unknown): x is O => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x: unknown): O[] => (Array.isArray(x) ? x.filter(isObj) : []);

/** Root study of a dataset chain (follows `data` through derived datasets to a solution dataset), or null. */
export function datasetStudy(data: unknown, datasetId: unknown): string | null {
	const ds = arr(isObj(data) && isObj(data.results) ? data.results.datasets : undefined);
	let id = datasetId;
	for (let k = 0; k < 32 && typeof id === 'string'; k++) {
		const d = ds.find((x) => x.id === id);
		if (!d) return null;
		if (d.type === 'solution') return typeof d.data === 'string' ? d.data : null;
		id = d.data;
	}
	return null;
}

/** Headline item ids the run of `solved` answers for, and the left-out items with the study each needs. */
export function headlineSplit(data: unknown, solved: string | null | undefined): { show: Set<string>; other: Array<{ id: string; study: string }> } {
	const results = isObj(data) ? data.results : undefined;
	const studies = new Set(runStudies(data, solved));
	const show = new Set<string>(), other: Array<{ id: string; study: string }> = [];
	for (const h of headlineItems(results)) {
		if (!h.study || studies.has(h.study)) show.add(h.id);
		else other.push({ id: h.id, study: h.study });
	}
	return { show, other };
}

/**
 * Plot group to show after a solve of `solved`: the current one when it reads a study the run answers for (or reads
 * no study); else the first enabled 2D / 3D group that does; else null (the quick view of the solution).
 */
export function plotGroupForStudy(data: unknown, solved: string | null | undefined, current: string | null): string | null {
	const studies = new Set(runStudies(data, solved));
	const plots = arr(isObj(data) && isObj(data.results) ? data.results.plots : undefined);
	const fits = (g: O) => { const st = datasetStudy(data, g.data); return st === null || studies.has(st); };
	const cur = current ? plots.find((g) => g.id === current) : undefined;
	if (cur && fits(cur)) return current;
	const g = plots.find((x) => x.enabled !== false && (x.type === 'plot2d' || x.type === 'plot3d') && typeof x.id === 'string' && datasetStudy(data, x.data) !== null && fits(x));
	return g ? (g.id as string) : null;
}
