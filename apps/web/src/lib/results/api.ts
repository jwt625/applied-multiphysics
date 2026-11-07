// SPDX-License-Identifier: GPL-3.0-or-later
// Results API of the web app (lane R3, DevLog-028; contracts C6 results messages, C10). Every number comes from the
// @amp/post kernels through results/adapter.ts, evaluated in the post worker; this module is the main-thread side that
// the Results tree / plot groups (lane R2), the Table tab, the headlines and the agent host call.
//
//   const rc = resultsClient(session.post);
//   const run = await runOf(session);                         // the displayed dataset (single run or sweep point)
//   const t = await rc.table(spec, 'ev_std1', [run]);         // evaluation group or table -> rows x columns
//   const d = await rc.datasetValues(spec, 'cl1', 'solid.sxx', run, { step: 'last' });   // points, s, values
//   const f = await rc.nodalValues(spec, 'solid.sxx/sigma_inf', run, { dataset: 'sol_std1' }); // colour plots
//   const e = await rc.evaluate(spec, { data: 'sol_std1', kind: 'max', expr: 'solid.mises', over: ['dom:plate'], method: 'nodal' }, [run]);
//
// Values live in session memory only (DevLog-023 s.5.1): the worker caches them by artifactKey(node hash, run id), so
// an edit recomputes only the nodes whose hash changed (changedResultNodes) and their dependents. No export.
import type { Mesh, Solution } from '@amp/spec/types';
import { runId } from '@amp/spec';

// ---- shared shapes (adapter, worker, client) -------------------------------------------------------------------

/** Params of a run: SI value and dimension per name (resolveParams(spec.params).scope, or a sweep point's params). */
export type ParamMap = ReadonlyMap<string, { si: number; dim: readonly number[] }>;

/** One solved dataset that results nodes are evaluated on. */
export interface ResultsRun {
	/** run id: sha-256 of the canonical C5 run record (`runId` of @amp/spec); the worker holds runs by this key */
	key: string;
	solution: Solution;
	/** the mesh the solution was computed on (hash = solution.meshHash) */
	mesh: Mesh;
	params: ParamMap;
	/** study ids this run answers for: an item whose root study is not listed is not evaluated (HeadlineItem.study) */
	studies: string[];
	/** dataset label shown in tables: '' for a single run, 'D = 4 mm' for a sweep point */
	label: string;
}

/** What crosses to the worker for a run already held there (no arrays). */
export interface RunRef { key: string; studies: string[]; label: string }

/** Diagnostics of one evaluated value (honesty rules: method, points used, outside / NaN, line coverage). */
export interface CellMeta {
	/** value in SI and its SI unit */
	si: number;
	siUnit: string;
	method?: string;
	n?: number;
	nOutside?: number;
	nNaN?: number;
	coverage?: { covered: number; length: number };
	/** location of a max / min (m) */
	at?: number[];
	/** false when the expression jumps across elements (d(), DG0) */
	continuous?: boolean;
	/** region measure of integrals and averages */
	measure?: { value: number; unit: string };
}

export type ColumnKind = 'index' | 'dataset' | 'step' | 'item';
export interface TableColumn {
	key: string;
	/** header without the unit, e.g. 'kt', 'T_E', 'freq' */
	name: string;
	/** display unit of the values ('' for dimensionless and text columns) */
	unit: string;
	kind: ColumnKind;
	/** item columns: the evaluation item, its type and expression; a point item over several points has one column per point */
	item?: string;
	type?: string;
	expr?: string;
	/** point items: the point (m) of this column */
	point?: number[];
	/** tooltip text (method, dataset, selection) */
	tip: string;
}
export interface TableRow {
	/** cells in column order: index / step / item columns numbers (null = not evaluated), dataset column text */
	cells: Array<number | string | null>;
	/** per cell: diagnostics (item cells) or null */
	meta: Array<CellMeta | null>;
	/** per cell: why it has no value, or null */
	errors: Array<string | null>;
	/** run key and step index of the row */
	run: string;
	step: number;
}
export interface ResultTable {
	/** the table id (tables section) or the evaluation group id */
	id: string;
	group: string;
	label: string;
	/** rows (default): one row per step per run; columns: the view transposes */
	orient: 'rows' | 'columns';
	columns: TableColumn[];
	rows: TableRow[];
	/** reasons the whole group is not evaluated (unknown id, disabled, study not solved, ...) */
	errors: string[];
	/** node hash (C10) of the group and the run keys the rows come from */
	hash: string;
	runs: string[];
	/** worker time, ms (0 when served from the cache) */
	ms: number;
	cached: boolean;
}

/** An expression on the points of a dataset, for line graphs, point graphs and plot markers. */
export interface DatasetValues {
	id: string;
	type: 'solution' | 'cutpoint' | 'cutline' | 'edge';
	/** coordinates per point (2 or 3) */
	dim: number;
	/** point coordinates, dim * n, m */
	points: Float64Array;
	/** arc length per point (cut lines, edges), m */
	s?: Float64Array;
	/** edges: [first, end) point ranges of each connected chain (do not join chains in a plot) */
	chains?: Array<[number, number]>;
	/** cut lines in crossing mode: element pieces (arc length start, end) inside the mesh */
	pieces?: Float64Array;
	/** cut lines: full length and the length inside the mesh, m; edges: total length */
	length?: number;
	covered?: number;
	/** the expression at the points in `unit` (null without an expression) */
	values: Float64Array | null;
	unit: string;
	siUnit: string;
	continuous: boolean;
	/** indices of points outside the mesh (values NaN) */
	outside: number[];
	step: number;
	/** step value (time, frequency, eigenvalue, parameter) and unit, null for stationary solutions */
	stepValue: number | null;
	stepUnit: string | null;
	error?: string;
}

/** An expression at every mesh node (each node evaluated in its first cell): a P1 / P2 nodal field for colour plots. */
export interface NodalValues {
	values: Float64Array | null;
	/** H1P2 on tri6 / tet10 / quadratic meshes, H1P1 otherwise: how to interpolate `values` */
	space: 'H1P1' | 'H1P2';
	unit: string;
	siUnit: string;
	/** false for d() and DG0 expressions: the node value is the first cell's (discontinuous field) */
	continuous: boolean;
	step: number;
	meshHash: string;
	error?: string;
}

/** Ad hoc evaluation (agent `evaluate`, plot max / min markers): the same path as a spec item, nothing is stored. */
export interface AdhocRequest {
	/** dataset id the evaluation reads (a solution, cut point, cut line or edge dataset) */
	data: string;
	kind: 'point' | 'global' | 'integral' | 'average' | 'max' | 'min' | 'measure';
	expr?: string;
	unit?: string;
	/** selection for integral / average / max / min / measure on a solution dataset */
	over?: string[];
	method?: 'nodal' | 'quad' | 'points' | 'lattice';
	/** a temporary cut line on `data` (SI m or spec quantities), with optional uniform point count */
	from?: unknown[];
	to?: unknown[];
	n?: number;
	/** temporary cut points on `data` */
	points?: unknown[][];
	steps?: unknown;
}

export type StepPick = number | 'last' | 'first';

/** Error text of a table cell whose step is outside its item's own step selection (headlines skip such rows). */
export const NOT_SELECTED = 'step not selected by the item';

// ---- worker messages (C6 results set; the post worker answers them through the adapter) ------------------------

export type ResultsToWorker =
	| { type: 'results:run'; req: number; key: string; solution: Solution; mesh: Mesh; params: ParamMap }
	| { type: 'results:drop'; req: number; key: string }
	| { type: 'results:table'; req: number; spec: unknown; id: string; runs: RunRef[] }
	| { type: 'results:dataset'; req: number; spec: unknown; id: string; expr: string | null; unit?: string; run: RunRef; step?: StepPick }
	| { type: 'results:nodal'; req: number; spec: unknown; expr: string; unit?: string; dataset?: string; run: RunRef; step?: StepPick }
	| { type: 'results:adhoc'; req: number; spec: unknown; q: AdhocRequest; runs: RunRef[] };

export type ResultsFromWorker =
	| { type: 'results:ok'; req: number }
	| { type: 'results:table'; req: number; table: ResultTable }
	| { type: 'results:dataset'; req: number; values: DatasetValues }
	| { type: 'results:nodal'; req: number; values: NodalValues };

// ---- main-thread client -----------------------------------------------------------------------------------------

type WorkerCall = (m: Record<string, unknown> & { type: string }, transfer?: Transferable[]) => Promise<unknown>;
/** The post worker client (post/client.ts PostClient), structurally: only its request / reply call is used. */
export interface PostLike { call(m: never): Promise<unknown> }

/** Plain JSON copy of spec data (the model's parsed data; strips anything not structured-cloneable). */
const plain = (spec: unknown): unknown => (spec === null || spec === undefined ? null : JSON.parse(JSON.stringify(spec)));

export class ResultsClient {
	private call: WorkerCall;
	/** runs the worker holds (key -> solution object), most recently used last */
	private held = new Map<string, Solution>();
	static readonly MAX_RUNS = 4;

	constructor(post: PostLike | WorkerCall) {
		this.call = typeof post === 'function' ? post : (m) => (post.call as unknown as WorkerCall).call(post, m);
	}

	/** Make the worker hold a run (copies the solution and mesh once per run key; LRU of MAX_RUNS). */
	async hold(run: ResultsRun): Promise<RunRef> {
		if (this.held.get(run.key) !== run.solution) {
			await this.call({ type: 'results:run', key: run.key, solution: run.solution, mesh: run.mesh, params: new Map(run.params) });
			this.held.delete(run.key);
			this.held.set(run.key, run.solution);
			while (this.held.size > ResultsClient.MAX_RUNS) {
				const k = this.held.keys().next().value!;
				this.held.delete(k);
				void this.call({ type: 'results:drop', key: k });
			}
		} else { this.held.delete(run.key); this.held.set(run.key, run.solution); }
		return { key: run.key, studies: run.studies, label: run.label };
	}

	/** Hold the runs and send one request; when another caller's hold evicted a run in between ("not held"), hold
	 *  again and retry once (audit 6). */
	private async withRuns<T>(runs: ResultsRun[], send: (refs: RunRef[]) => Promise<T>): Promise<T> {
		const refs: RunRef[] = [];
		for (const r of runs) refs.push(await this.hold(r));
		try { return await send(refs); }
		catch (e) {
			if (!(e instanceof Error) || !/is not held/.test(e.message)) throw e;
			for (const r of runs) { this.held.delete(r.key); await this.hold(r); }
			return send(refs);
		}
	}

	/** An evaluation group or a table (by id) over one or more runs: one row per step per run. */
	table(spec: unknown, id: string, runs: ResultsRun[]): Promise<ResultTable> {
		const sp = plain(spec);
		return this.withRuns(runs, async (refs) => ((await this.call({ type: 'results:table', spec: sp, id, runs: refs })) as Extract<ResultsFromWorker, { type: 'results:table' }>).table);
	}

	/** Points (and arc length) of a dataset, with an expression at them (null: points only). */
	datasetValues(spec: unknown, id: string, expr: string | null, run: ResultsRun, o: { step?: StepPick; unit?: string } = {}): Promise<DatasetValues> {
		const sp = plain(spec);
		return this.withRuns([run], async ([ref]) => ((await this.call({ type: 'results:dataset', spec: sp, id, expr, run: ref, ...(o.step !== undefined ? { step: o.step } : {}), ...(o.unit ? { unit: o.unit } : {}) })) as Extract<ResultsFromWorker, { type: 'results:dataset' }>).values);
	}

	/** An expression at every mesh node (colour plots of expressions; `dataset` = the solution dataset whose root study must match). */
	nodalValues(spec: unknown, expr: string, run: ResultsRun, o: { step?: StepPick; unit?: string; dataset?: string } = {}): Promise<NodalValues> {
		const sp = plain(spec);
		return this.withRuns([run], async ([ref]) => ((await this.call({ type: 'results:nodal', spec: sp, expr, run: ref, ...(o.step !== undefined ? { step: o.step } : {}), ...(o.unit ? { unit: o.unit } : {}), ...(o.dataset ? { dataset: o.dataset } : {}) })) as Extract<ResultsFromWorker, { type: 'results:nodal' }>).values);
	}

	/** Ad hoc evaluation through a temporary item (and cut line / points): a one-column table; nothing is stored. */
	evaluate(spec: unknown, q: AdhocRequest, runs: ResultsRun[]): Promise<ResultTable> {
		const sp = plain(spec);
		return this.withRuns(runs, async (refs) => ((await this.call({ type: 'results:adhoc', spec: sp, q, runs: refs })) as Extract<ResultsFromWorker, { type: 'results:table' }>).table);
	}
}

const clients = new WeakMap<object, ResultsClient>();
/** One ResultsClient per post worker client. */
export function resultsClient(post: PostLike): ResultsClient {
	let c = clients.get(post);
	if (!c) { c = new ResultsClient(post); clients.set(post, c); }
	return c;
}

// ---- runs of a workbench / Play session --------------------------------------------------------------------------

/** The part of a Session the results layer reads (structural, so tests and other hosts can supply it). */
export interface RunSource {
	solution: Solution | null;
	mesh: Mesh | null;
	activeParams: ParamMap | undefined;
	activeLabel: string;
	model: { data: unknown };
}

const keys = new WeakMap<Solution, Promise<string>>();
/** Run id of a solution (cached per solution object). */
export function runKey(sol: Solution): Promise<string> {
	let k = keys.get(sol);
	if (!k) { k = runId(sol.run); keys.set(sol, k); }
	return k;
}

/** Study ids a session run answers for: the first study (the browser runner solves it); when it is parametric, also
 *  its inner study; and every parametric study that sweeps one of those (a single run at the base params or a sweep
 *  point is one point of it; the parametric single run re-points its solution datasets the same way). */
export function runStudies(spec: unknown): string[] {
	const st = ((spec as { studies?: Array<{ id?: unknown; type?: unknown; settings?: { study?: unknown } }> } | null)?.studies ?? []);
	const first = st[0];
	if (!first || typeof first.id !== 'string') return [];
	const out = [first.id];
	if (first.type === 'parametric' && typeof first.settings?.study === 'string') out.push(first.settings.study);
	for (const x of st) if (x.type === 'parametric' && typeof x.id === 'string' && typeof x.settings?.study === 'string' && out.includes(x.settings.study) && !out.includes(x.id)) out.push(x.id);
	return out;
}

const solvedParams = new WeakMap<Solution, ParamMap>();
/** Params of a solution: the ones first seen with this solution object (snapshot), else `current`. */
export function paramsOf(sol: Solution, current: ParamMap): ParamMap {
	let p = solvedParams.get(sol);
	if (!p) { p = new Map(current); solvedParams.set(sol, p); }
	return p;
}
/** The displayed dataset of a session as a run (null without a solution on its mesh). The params are the ones first
 *  seen with this solution object (a later param edit without a re-solve does not mix new params with the old
 *  field; the solution is badged stale meanwhile). */
export async function runOf(s: RunSource): Promise<ResultsRun | null> {
	const sol = s.solution, mesh = s.mesh;
	if (!sol || !mesh || !s.activeParams || sol.meshHash !== mesh.hash) return null;
	const params = paramsOf(sol, s.activeParams);
	return { key: await runKey(sol), solution: sol, mesh, params, studies: runStudies(s.model.data), label: s.activeLabel };
}
