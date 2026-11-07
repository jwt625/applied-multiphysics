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

export interface CaseConvergence { hFactors: number[]; hNote: string; order: number | undefined; fs: number | undefined; tol: { rel?: number; abs?: number } | null; caseId: string }

export interface LevelRecord { h: number; dof: number; ms: number; values: number[]; meshHash: string; cells: number }
export interface AccState {
	status: 'running' | 'done' | 'unavailable';
	levels: LevelRecord[];
	/** level being solved (status running) */
	next: number | null;
	conv: CaseConvergence;
	def: AccuracyDef;
	/** per value index (eigen: per mode) */
	rich: RichardsonRuleResult[];
	reason: string;
	/** performance.now() at the end of the sequence (= ms since navigation start) */
	doneAt: number;
	startedAt: number;
}

/** Convergence block and tolerance of the paired case (eval/cases, amp-eval/0). */
export function caseConvergence(caseId: string, data: Record<string, unknown> | null, metric: string): CaseConvergence {
	const c = (data?.convergence ?? {}) as { h_factors?: number[]; expected_order?: number; safety_factor?: number };
	const refs = (data?.references ?? (data as { targets?: unknown[] } | null)?.targets ?? []) as Array<{ metric_id?: string; tolerance?: { rel?: number; abs?: number } }>;
	const ref = refs.find((r) => r.metric_id === metric);
	const tol = ref?.tolerance ? { ...(typeof ref.tolerance.rel === 'number' ? { rel: ref.tolerance.rel } : {}), ...(typeof ref.tolerance.abs === 'number' ? { abs: ref.tolerance.abs } : {}) } : null;
	const hf = Array.isArray(c.h_factors) && c.h_factors.length >= 2 ? [...c.h_factors].sort((a, b) => b - a) : null;
	return {
		hFactors: hf ?? [1, 0.5, 0.25],
		hNote: hf ? `h_factors of ${caseId}` : `${caseId} lists no h_factors: nested ratio-2 sequence [1, 0.5, 0.25]`,
		order: typeof c.expected_order === 'number' ? c.expected_order : undefined,
		fs: typeof c.safety_factor === 'number' ? c.safety_factor : undefined,
		tol: tol && (tol.rel !== undefined || tol.abs !== undefined) ? tol : null,
		caseId
	};
}

/** Headline quantity of one level (values in the spec unit; eigen: every mode frequency in Hz). */
export async function levelValues(def: AccuracyDef, sol: Solution, mesh: Mesh, params: Map<string, ParamInfo>, results: unknown[], post: PostClient): Promise<number[]> {
	const q = def.quantity;
	if ('eigen' in q) return sol.steps?.kind === 'eigen' ? Array.from(sol.steps.values).filter((v) => v > 0) : [];
	if ('scalar' in q) { const v = sol.scalars[q.scalar]?.value; return typeof v === 'number' ? [v] : []; }
	const h = (await headlines(results as Parameters<typeof headlines>[0], sol, mesh, params, post)).find((x) => x.id === q.headline);
	return h && h.value !== null ? [h.value] : [];
}

/** Richardson per value index over the recorded levels (coarse -> fine). */
export function estimate(levels: LevelRecord[], conv: CaseConvergence): RichardsonRuleResult[] {
	if (levels.length < 2) return [];
	const n = Math.min(...levels.map((l) => l.values.length));
	const hs = levels.map((l) => l.h);
	const out: RichardsonRuleResult[] = [];
	for (let i = 0; i < n; i++) out.push(richardsonRule(levels.map((l) => l.values[i]!), hs, { ...(conv.order !== undefined ? { expectedOrder: conv.order } : {}), ...(conv.fs !== undefined ? { fs: conv.fs } : {}) }));
	return out;
}

export interface Verdict { kind: 'within' | 'above' | 'na'; err: number | null; errBasis: 'rel' | 'abs'; limit: number | null; text: string }

/** Estimated error of value index i against the case tolerance. Missing evidence is 'na', never 'within'. */
export function verdict(a: AccState, i: number): Verdict {
	const r = a.rich[i];
	const tol = a.conv.tol;
	const basis: 'rel' | 'abs' = tol?.rel !== undefined ? 'rel' : 'abs';
	if (!r) return { kind: 'na', err: null, errBasis: basis, limit: null, text: a.status === 'running' ? 'refining' : 'no estimate' };
	if (!r.available || r.gci_fine === null || r.u_abs === null) {
		const ch = r.rel_change_last;
		return { kind: 'na', err: null, errBasis: basis, limit: null, text: `Richardson unavailable (${r.reason ?? 'n/a'})${ch !== null && Number.isFinite(ch) ? `; last change ${ch.toExponential(1)} rel` : ''}` };
	}
	const err = basis === 'rel' ? r.gci_fine : r.u_abs;
	const limit = tol ? (basis === 'rel' ? tol.rel! : tol.abs!) : null;
	if (limit === null) return { kind: 'na', err, errBasis: basis, limit, text: `no tolerance for ${a.def.metric} in ${a.conv.caseId}` };
	return { kind: err <= limit ? 'within' : 'above', err, errBasis: basis, limit, text: '' };
}
