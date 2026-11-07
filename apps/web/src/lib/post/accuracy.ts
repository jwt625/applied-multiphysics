// SPDX-License-Identifier: GPL-3.0-or-later
// Full-accuracy result of a Play view (coordinator order 2026-11-06, M2 audit): after the full run (hFactor 1) the
// same spec text is solved on the nested levels of the paired eval case (convergence.h_factors, default [1, 0.5, 0.25];
// prepareRun refines the hFactor-1 mesh uniformly, so the levels are nested with ratio 2). The headline quantity of
// each level gives a Richardson estimate with the shared acceptance rule of the eval harness
// (packages/eval/src/metrics.ts richardsonRule: observed order within 25 % of the case's expected order, GCI of the
// finest level, Celik et al. 2008). The estimate is the discretization error of THIS model's headline; it is compared
// with the paired case's tolerance. Modelling differences between the hero and the case spec (e.g. a finite plate
// versus the exact Kirsch traction) are not part of it, and the badge says so.
import { richardsonRule, type RichardsonRuleResult } from '../../../../../packages/eval/src/metrics.ts';
import type { Mesh, Solution } from '@amp/spec/types';
import type { ParamInfo } from '@amp/spec';
import { headlines } from './headline.ts';
import type { PostClient } from './client';

/** What the badge measures, per hero (apps/web/src/lib/play/heroes.ts ACCURACY). */
export interface AccuracyDef {
	/** metric_id of the paired case whose tolerance applies */
	metric: string;
	quantity: { headline: string } | { eigen: true } | { scalar: string };
	/** display label of the quantity */
	label: string;
}

export interface CaseRef { metric: string; value: number; unit: string; tol: { rel?: number; abs?: number } | null }
export interface CaseConvergence { hFactors: number[]; hNote: string; order: number | undefined; fs: number | undefined; tol: { rel?: number; abs?: number } | null; caseId: string; refs: CaseRef[] }

/** One level of the sequence: values in the quantity's unit (`unit`; eigen: Hz, every solver mode in solver order). */
export interface LevelRecord { h: number; dof: number; ms: number; values: number[]; unit: string; tags?: number[]; meshHash: string; cells: number }
export interface AccState {
	status: 'running' | 'done' | 'unavailable';
	levels: LevelRecord[];
	/** level being solved (status running) */
	next: number | null;
	conv: CaseConvergence;
	def: AccuracyDef;
	reason: string;
	/** performance.now() at the end of the sequence (= ms since navigation start) */
	doneAt: number;
	startedAt: number;
}

const tolOf = (t: { rel?: unknown; abs?: unknown } | undefined) => {
	if (!t) return null;
	const o = { ...(typeof t.rel === 'number' ? { rel: t.rel } : {}), ...(typeof t.abs === 'number' ? { abs: t.abs } : {}) };
	return o.rel !== undefined || o.abs !== undefined ? o : null;
};

/** Convergence block, tolerance and scalar references of the paired case (eval/cases, amp-eval/0). */
export function caseConvergence(caseId: string, data: Record<string, unknown> | null, metric: string): CaseConvergence {
	const c = (data?.convergence ?? {}) as { h_factors?: number[]; expected_order?: number; safety_factor?: number };
	const raw = (data?.references ?? (data as { targets?: unknown[] } | null)?.targets ?? []) as Array<{ metric_id?: string; value?: unknown; unit?: string; tolerance?: { rel?: number; abs?: number } }>;
	const ref = raw.find((r) => r.metric_id === metric);
	const refs: CaseRef[] = raw.filter((r) => typeof r.value === 'number' && r.metric_id).map((r) => ({ metric: r.metric_id!, value: r.value as number, unit: r.unit ?? '1', tol: tolOf(r.tolerance) }));
	const hf = Array.isArray(c.h_factors) && c.h_factors.length >= 2 ? [...c.h_factors].sort((a, b) => b - a) : null;
	return {
		hFactors: hf ?? [1, 0.5, 0.25],
		hNote: hf ? `h_factors of ${caseId}` : `${caseId} lists no h_factors: nested ratio-2 sequence [1, 0.5, 0.25]`,
		order: typeof c.expected_order === 'number' ? c.expected_order : undefined,
		fs: typeof c.safety_factor === 'number' ? c.safety_factor : undefined,
		tol: tolOf(ref?.tolerance),
		caseId,
		refs
	};
}

/** Headline quantity of one level: spec unit for headlines; eigen: every solver mode (Hz), with m for axisymmetric solves. */
export async function levelValues(def: AccuracyDef, sol: Solution, mesh: Mesh, params: Map<string, ParamInfo>, results: unknown, post: PostClient): Promise<{ values: number[]; unit: string; tags?: number[] }> {
	const q = def.quantity;
	if ('eigen' in q) {
		if (sol.steps?.kind !== 'eigen') return { values: [], unit: 'Hz' };
		const values = Array.from(sol.steps.values);
		const m = values.map((_, k) => sol.scalars[`m_${k}`]?.value);
		return { values, unit: sol.steps.unit || 'Hz', ...(m.every((x) => typeof x === 'number') ? { tags: m as number[] } : {}) };
	}
	if ('scalar' in q) { const v = sol.scalars[q.scalar]; return typeof v?.value === 'number' ? { values: [v.value], unit: v.unit || '1' } : { values: [], unit: '1' }; }
	const h = (await headlines(results, sol, mesh, params, post)).find((x) => x.id === q.headline);
	return h && h.value !== null ? { values: [h.value], unit: h.unit || '1' } : { values: [], unit: '1' };
}

/** Relative distance under which a mode of another level is taken as the same mode (nearest frequency, same m). */
const MATCH_REL = 0.05;

export interface Series { values: number[]; hs: number[]; reason: string; target: number | null; unit: string }

/**
 * Values of quantity i of the displayed level (h = displayH) across all recorded levels, coarse -> fine. Eigen: the
 * mode is the solver's mode i of the displayed level; on every other level the mode of nearest frequency (same m)
 * stands for it (multiplicity: degenerate partners share a partner). A 0 Hz mode (rigid / constant field) and an
 * unmatched mode have no estimate.
 */
export function series(a: AccState, displayH: number, i: number): Series {
	const L = a.levels;
	const d = L.find((l) => l.h === displayH) ?? L.at(-1);
	const unit = d?.unit ?? '';
	if (!d) return { values: [], hs: [], reason: 'no level', target: null, unit };
	const f = d.values[i];
	if (f === undefined) return { values: [], hs: [], reason: `quantity ${i} not in the level h ${d.h}`, target: null, unit };
	if (!('eigen' in a.def.quantity)) return { values: L.map((l) => l.values[0]!), hs: L.map((l) => l.h), reason: L.every((l) => l.values.length) ? '' : 'a level has no value', target: f, unit };
	const fmax = Math.max(...d.values.map(Math.abs));
	if (!(Math.abs(f) > 1e-6 * fmax)) return { values: [], hs: [], reason: '0 Hz mode (rigid body / constant field): no discretization estimate', target: f, unit };
	const tag = d.tags?.[i];
	const values: number[] = [];
	for (const l of L) {
		let best: number | null = null;
		l.values.forEach((v, k) => { if ((tag === undefined || l.tags?.[k] === tag) && (best === null || Math.abs(v - f) < Math.abs(best - f))) best = v; });
		if (best === null || Math.abs((best as number) - f) > MATCH_REL * Math.abs(f)) return { values: [], hs: [], reason: `no mode within ${MATCH_REL * 100} % of ${f.toPrecision(6)} ${unit} on level h ${l.h}`, target: f, unit };
		values.push(best);
	}
	return { values, hs: L.map((l) => l.h), reason: '', target: f, unit };
}

/** Case reference that applies to the shown value: the configured metric (scalars) or the nearest Hz reference within 2 % (modes). */
export function caseRef(a: AccState, valueSI: number | null): CaseRef | null {
	if (!('eigen' in a.def.quantity)) return a.conv.refs.find((r) => r.metric === a.def.metric) ?? null;
	if (valueSI === null) return null;
	let best: CaseRef | null = null;
	for (const r of a.conv.refs) if (r.unit === 'Hz' && (!best || Math.abs(r.value - valueSI) < Math.abs(best.value - valueSI))) best = r;
	return best && Math.abs(best.value - valueSI) <= 0.02 * Math.abs(best.value) ? best : null;
}

export interface Verdict { kind: 'within' | 'above' | 'na'; err: number | null; errBasis: 'rel' | 'abs'; limit: number | null; text: string; rich: RichardsonRuleResult | null; s: Series; lastChange: number | null }

/**
 * Mesh (discretization) error estimate of quantity i of the displayed level against a tolerance (the matched case
 * metric's). Missing evidence is 'na', never 'within'.
 */
export function verdict(a: AccState, i: number, displayH: number, tol: { rel?: number; abs?: number } | null): Verdict {
	const s = series(a, displayH, i);
	const basis: 'rel' | 'abs' = tol?.rel !== undefined || !tol ? 'rel' : 'abs';
	const n = s.values.length;
	const lastChange = n >= 2 && s.values[n - 1] !== 0 ? Math.abs((s.values[n - 1]! - s.values[n - 2]!) / s.values[n - 1]!) : null;
	const na = (text: string, rich: RichardsonRuleResult | null = null): Verdict => ({ kind: 'na', err: null, errBasis: basis, limit: null, text, rich, s, lastChange });
	if (s.reason) return na(s.reason);
	if (n < 2) return na(a.status === 'running' ? 'refining' : 'one level only');
	const rich = richardsonRule(s.values, s.hs, { ...(a.conv.order !== undefined ? { expectedOrder: a.conv.order } : {}), ...(a.conv.fs !== undefined ? { fs: a.conv.fs } : {}) });
	if (!rich.available || rich.gci_fine === null || rich.u_abs === null) return na(`Richardson unavailable (${rich.reason ?? 'n/a'})`, rich);
	const err = basis === 'rel' ? rich.gci_fine : rich.u_abs;
	const limit = tol ? (basis === 'rel' ? tol.rel! : tol.abs!) : null;
	if (limit === null) return { kind: 'na', err, errBasis: basis, limit, text: 'no case tolerance for this quantity', rich, s, lastChange };
	return { kind: err <= limit ? 'within' : 'above', err, errBasis: basis, limit, text: '', rich, s, lastChange };
}
