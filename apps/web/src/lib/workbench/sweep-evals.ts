// SPDX-License-Identifier: GPL-3.0-or-later
// Spec evaluation items over the points of a parametric sweep (DevLog-064 s.2 item 1; DevLog-051 O1). A point's
// solution is held only for SWEEP_HELD points, so the session evaluates every enabled evaluation group of the sweep's
// spec on each point when its solve arrives (results/api.ts tables in the post worker) and keeps only the numbers:
// one value per item column (a point item over several points has one column per point), from the last row in the
// item's own step selection (the headline rule, post/headline.ts). Pure helpers here; Session.computeSweep queues.
import { resultsOf } from '@amp/spec';
import { NOT_SELECTED, type ResultTable } from '../results/api.ts';

/** One evaluated item column of one sweep point. */
export interface SweepEval {
	/** column header (item id, `id[k]` for the k-th point of a point item) */
	name: string;
	/** evaluation group id and its label */
	group: string;
	groupLabel: string;
	/** display unit of the value ('' = dimensionless) */
	unit: string;
	/** value in `unit`; null = not evaluated (reason in `why`) */
	value: number | null;
	why?: string;
	/** column tip (item type, expression, selection) plus the step it was read at */
	tip: string;
}

/** Key of an evaluated column (also an option value: printable only); not shown (the plot shows name, unit, group).
 *  The colon keeps it apart from module scalar names. */
export const evalKey = (group: string, column: string): string => `eval:${group}/${column}`;

/** Enabled evaluation groups of a spec: id and label. */
export function evalGroups(spec: unknown): Array<{ id: string; label: string }> {
	return resultsOf(spec).evaluations
		.filter((g) => typeof g?.id === 'string' && g.enabled !== false && Array.isArray(g.items) && g.items.length > 0)
		.map((g) => ({ id: g.id, label: typeof g.label === 'string' && g.label ? g.label : g.id }));
}

/** Values of one group's table on one run: every item column, read at the last row of the item's step selection. */
export function evalsOfTable(t: ResultTable, group: { id: string; label: string }, stepText?: (step: number) => string): Record<string, SweepEval> {
	const out: Record<string, SweepEval> = {};
	// a group the run does not answer for (another study, disabled, unknown dataset) has no rows: not listed
	if (!t.rows.length) return out;
	t.columns.forEach((c, ci) => {
		if (c.kind !== 'item') return;
		const mine = t.rows.filter((r) => r.errors[ci] !== NOT_SELECTED);
		const row = mine.at(-1);
		const base = { name: c.name, group: group.id, groupLabel: group.label, unit: c.unit };
		const v = row?.cells[ci], err = row?.errors[ci];
		const at = row && t.rows.length > 1 ? `; solution step ${stepText ? stepText(row.step) : row.step} (last step the item selects)` : '';
		if (!row) out[evalKey(group.id, c.key)] = { ...base, value: null, why: t.errors.join('; ') || 'no row', tip: c.tip };
		else if (typeof v !== 'number' || !Number.isFinite(v) || err) out[evalKey(group.id, c.key)] = { ...base, value: null, why: err ?? 'not evaluated', tip: `${c.tip}${at}` };
		else out[evalKey(group.id, c.key)] = { ...base, value: v, tip: `${c.tip}${at}` };
	});
	return out;
}

/** Why a group's table gives no value at all on a run (no rows, with the table's reasons), else null. */
export function tableFailure(t: ResultTable): string | null {
	return !t.rows.length && t.errors.length ? t.errors.join('; ') : null;
}

/** What the sweep plot reads from a session sweep (structural). `evalFailed`: group id -> why the group gave no value
 *  on that point (thrown, or a table without rows); `evalState`: see EvalState. */
export interface EvalSweepLike {
	points: ReadonlyArray<{ status: string; scalars: Record<string, { value: number; unit: string }> | null; evals?: Record<string, SweepEval> | null; evalFailed?: Record<string, string> | null; evalState?: EvalState }>;
}

/** One quantity the sweep plot can show: a module scalar or an evaluated item column. */
export interface SweepQuantity { key: string; kind: 'scalar' | 'eval'; name: string; unit: string; group?: string; groupLabel?: string; tip: string }

/** Module scalars and evaluated item columns reported by any solved point (first-seen order; a column with no value
 *  at any point is listed too, so its reason can be shown). */
export function sweepQuantities(sw: EvalSweepLike | null): SweepQuantity[] {
	const sc = new Map<string, SweepQuantity>(), ev = new Map<string, SweepQuantity>();
	for (const p of sw?.points ?? []) {
		if (p.status !== 'solved') continue;
		for (const [k, v] of Object.entries(p.scalars ?? {})) if (!sc.has(k) && Number.isFinite(v.value)) sc.set(k, { key: k, kind: 'scalar', name: k, unit: v.unit, tip: `${k}: scalar reported by the physics module` });
		for (const [k, e] of Object.entries(p.evals ?? {})) if (!ev.has(k) || (ev.get(k)!.unit === '' && e.unit)) ev.set(k, { key: k, kind: 'eval', name: e.name, unit: e.unit, group: e.group, groupLabel: e.groupLabel, tip: e.tip });
	}
	return [...ev.values(), ...sc.values()];
}

/** The sweep with `scalars` replaced by the values of one quantity (key -> {value, unit}), for the curve builder of
 *  state/sweep.ts (`sweepSeries(view, key)`); points without a value become gaps. */
export function quantityView<T extends EvalSweepLike['points'][number]>(points: readonly T[], q: SweepQuantity): Array<T & { scalars: Record<string, { value: number; unit: string }> | null }> {
	if (q.kind === 'scalar') return points.map((p) => ({ ...p }));
	return points.map((p) => {
		const e = p.evals?.[q.key];
		return { ...p, scalars: e && e.value !== null ? { [q.key]: { value: e.value, unit: e.unit } } : null };
	});
}

/** Text of a point's evaluation state while it has no evaluated items. */
export const EVAL_STATE_TEXT: Record<'queued' | 'running' | 'skipped' | 'none', string> = {
	queued: 'waiting for evaluation',
	running: 'being evaluated',
	skipped: 'not evaluated: more points waited than the queue holds (evaluated when the point is shown)',
	none: 'not evaluated (evaluated when the point is shown)'
};

/** Counts of solved points without evaluated items, by state (the sweep plot's tip). */
export function evalCounts(sw: EvalSweepLike | null): Record<'queued' | 'running' | 'skipped' | 'none', number> {
	const n = { queued: 0, running: 0, skipped: 0, none: 0 };
	for (const p of sw?.points ?? []) if (p.status === 'solved' && (p.evals === undefined || p.evals === null)) n[p.evalState ?? 'none']++;
	return n;
}

/** Why a quantity has no value at some solved points (first reason per distinct message); `group` is the quantity's
 *  evaluation group (its failure on a point is the reason there). */
export function evalGaps(sw: EvalSweepLike | null, key: string, group?: string): string[] {
	const out = new Set<string>();
	for (const p of sw?.points ?? []) {
		if (p.status !== 'solved') continue;
		const e = p.evals?.[key];
		if (p.evals === undefined || p.evals === null) out.add(EVAL_STATE_TEXT[p.evalState ?? 'none']);
		else if (!e) out.add(group !== undefined && p.evalFailed?.[group] ? `evaluation group ${group} failed: ${p.evalFailed[group]}` : 'not in the table of this point');
		else if (e.value === null) out.add(e.why ?? 'not evaluated');
	}
	return [...out];
}

/** Evaluation state of a solved sweep point: waiting in the queue, being evaluated, dropped by the queue cap
 *  (evaluated when the point is shown), or none (evaluated, or never queued). */
export type EvalState = 'queued' | 'running' | 'skipped' | null;

/** A queued evaluation: sweep token, point index and what the evaluator needs (the point's solution and mesh). */
export interface EvalJob { tok: number; i: number }

/**
 * Sequential evaluation queue of the sweep points (one evaluation at a time). A point is queued at most once: a point
 * that is waiting, in flight or already evaluated (`done`) is not queued again, and the drain skips a point evaluated
 * while it waited. Beyond `cap` waiting entries the oldest one is dropped and its point marked skipped.
 * Memory: each waiting or in-flight entry keeps its job (the point's solution and mesh) alive, so at most cap + 1
 * jobs are referenced by the queue (on top of the points the session holds itself).
 */
export class SweepEvalQueue<J extends EvalJob> {
	private waiting: J[] = [];
	private cur: J | null = null;
	private busy = false;
	private skipped = new Set<number>();
	private readonly evaluate: (job: J) => Promise<void>;
	private readonly done: (job: J) => boolean;
	private readonly cap: number;
	private readonly on: { skip?: (job: J) => void; error?: (job: J, e: unknown) => void };
	constructor(evaluate: (job: J) => Promise<void>, done: (job: J) => boolean, cap: number, on: { skip?: (job: J) => void; error?: (job: J, e: unknown) => void } = {}) {
		this.evaluate = evaluate;
		this.done = done;
		this.cap = cap;
		this.on = on;
	}

	/** Queue a job; false when its point is evaluated, in flight or already waiting. */
	push(job: J): boolean {
		if (this.done(job) || this.has(job.tok, job.i)) return false;
		this.skipped.delete(job.i);
		this.waiting.push(job);
		while (this.waiting.length > this.cap) {
			const d = this.waiting.shift()!;
			this.skipped.add(d.i);
			this.on.skip?.(d);
		}
		if (!this.busy) void this.drain();
		return true;
	}

	has(tok: number, i: number): boolean {
		return (this.cur !== null && this.cur.tok === tok && this.cur.i === i) || this.waiting.some((q) => q.tok === tok && q.i === i);
	}

	state(tok: number, i: number): EvalState {
		if (this.cur && this.cur.tok === tok && this.cur.i === i) return 'running';
		if (this.waiting.some((q) => q.tok === tok && q.i === i)) return 'queued';
		return this.skipped.has(i) ? 'skipped' : null;
	}

	/** Drop every waiting job and the skipped marks (new sweep, cancel); an evaluation in flight finishes (its caller
	 *  checks the sweep token before storing). */
	clear() {
		this.waiting = [];
		this.skipped.clear();
	}

	private async drain() {
		this.busy = true;
		try {
			for (let q = this.waiting.shift(); q; q = this.waiting.shift()) {
				if (this.done(q)) continue;
				this.cur = q;
				try { await this.evaluate(q); }
				catch (e) { this.on.error?.(q, e); }
				finally { this.cur = null; }
			}
		} finally { this.busy = false; }
	}
}
