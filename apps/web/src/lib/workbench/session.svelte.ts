// SPDX-License-Identifier: GPL-3.0-or-later
// One open model with its engine and post workers: mesh and solution state, run scheduling (one run in flight, the
// latest request runs next), coarse runs during drags (sizes x2), progress for long runs.
// Freshness (audit B1): every solution is tagged with the spec hash it was computed from; it is fresh only while that
// hash equals the model's current spec hash and it came from a full-resolution run. A run that ends unavailable or in
// an error drops the solution (audit S1). Eval-case values are credited only when prepareRun reports using them (S2).
import { createOpLog, parseSpecText, resolveQuantity, units, type ParamInfo, type Registry } from '@amp/spec';
import type { JsonPatchOp } from '@amp/spec/types';
import type { Mesh, Operation, Solution } from '@amp/spec/types';
import { EngineClient, type RunOutcome } from '../engine/client';
import { PostClient } from '../post/client';
import { toMesh2D, type Mesh2D } from '../post/field2d';
import { ModelState } from '../state/model.svelte';
import { appLog } from '../state/log.svelte';
import { fmtMs } from '../gfx/ticks';
import { loadCaseFor, type CaseInfo } from '../cases';
import { caseConvergence, levelValues, type AccState, type AccuracyDef, type LevelRecord } from '../post/accuracy';
import { scopeOf } from '../engine/spec-adapter';
import { fmt } from '../gfx/ticks';

/** largest nested level the full-accuracy sequence solves in the browser (DOF) */
export const ACC_DOF_CAP = 1_000_000;

export type Status = 'idle' | 'meshing' | 'meshed' | 'solving' | 'solved' | 'unavailable' | 'error';

export interface MeshInfo { hFactor: number; type: string; cells: number; nodes: number; source: string; hash: string; ms: { parse: number; geometry: number; mesh: number }; roundTripMs: number; qmin: number; qmean: number }

/** One axis of a parametric study (DevLog-020 s.1.3): the swept param, its spec unit, the values (SI and in that unit). */
export interface SweepAxis { param: string; unit: string; si: number[]; values: number[] }
/** One point (dataset) of a sweep: its param values, the run outcome and the mesh and solution it was computed on. */
export interface SweepPoint {
	index: number;
	/** param -> value in the param's spec unit */
	values: Record<string, number>;
	label: string;
	status: 'pending' | 'solving' | 'solved' | 'unavailable' | 'error' | 'cancelled';
	message: string;
	solution: Solution | null;
	mesh: Mesh | null;
	quality: Float64Array | null;
	meshMs: MeshInfo['ms'] | null;
	meshSource: string;
	/** resolved params of the point's spec text (headline expressions and probe positions use them) */
	params: Map<string, ParamInfo> | null;
	ms: number;
	/** scalar results and DOF, kept for every point (the mesh and solution only for SWEEP_HELD points) */
	scalars: Solution['scalars'] | null;
	dof: number;
	/** mesh and solution are in memory; a solved point that is not held is re-solved when selected */
	held: boolean;
}
/** sweep points whose mesh and solution stay in memory: the displayed one plus the most recently used (LRU) */
export const SWEEP_HELD = 3;
export interface SweepState { studyId: string; innerId: string; axes: SweepAxis[]; points: SweepPoint[]; spec: string; done: number; startedAt: number }

/** The first parametric study of the data (amp-spec/0 core type `parametric`), or null. */
export function parametricOf(data: unknown): { index: number; id: string; inner: string; sweep: Array<Record<string, unknown>> } | null {
	const st = (data as { studies?: Array<{ id?: string; type?: string; settings?: { study?: string; sweep?: Array<Record<string, unknown>> } }> } | null)?.studies ?? [];
	const i = st.findIndex((x) => x?.type === 'parametric');
	if (i < 0) return null;
	const n = st[i]!;
	return { index: i, id: n.id ?? `#${i}`, inner: n.settings?.study ?? '', sweep: n.settings?.sweep ?? [] };
}

/** SI value -> display unit (affine degC handled by the spec's unit table). */
export function displayScale(unit: string | null | undefined): { a: number; b: number; unit: string } {
	if (!unit) return { a: 1, b: 0, unit: '' };
	try {
		const u = units.parseUnit(unit);
		return { a: 1 / u.factor, b: -u.offset / u.factor, unit };
	} catch {
		return { a: 1, b: 0, unit };
	}
}

export class Session {
	readonly model: ModelState;
	readonly engine = new EngineClient();
	readonly post = new PostClient();
	mesh = $state.raw<Mesh | null>(null);
	m2 = $state.raw<Mesh2D | null>(null);
	quality = $state.raw<Float64Array | null>(null);
	meshInfo = $state.raw<MeshInfo | null>(null);
	solution = $state.raw<Solution | null>(null);
	/** spec hash and mesh scale the solution was computed from */
	solutionSpec = $state('');
	solutionCoarse = $state(false);
	status = $state<Status>('idle');
	reasons = $state<string[]>([]);
	error = $state('');
	lastOutcomeMs = $state(0);
	/** live progress of the current run */
	runStart = $state(0);
	progress = $state<{ stage: string; frac: number; msg?: string } | null>(null);
	/** prepareRun notes of the last run (material sources, mesh notes) */
	notes = $state<string[]>([]);
	/** physics modules exist: geometry and parameter edits re-solve (Play) */
	autoCompute = $state(false);
	/** input-to-result time of the last coarse drag step, ms */
	dragMs = $state(0);
	/** paired eval case (`# eval: [...]` line of the sims file); used only when switched on */
	caseInfo = $state.raw<CaseInfo | null>(null);
	useCase = $state(false);
	/** Play: full-accuracy sequence after each full run (nested levels of the paired case; post/accuracy.ts) */
	accuracy: AccuracyDef | null = null;
	acc = $state.raw<AccState | null>(null);
	/** hFactor of the displayed solution (1 = the spec's mesh; < 1 = a nested refinement from the accuracy sequence) */
	solutionLevel = $state(1);
	/** increments when a full-resolution Compute delivers a solution (first point of a sweep); the workbench shows Results */
	solvedSeq = $state(0);
	/** Compute runs a parametric study as a sweep (workbench only; Play solves the single study at the slider values) */
	sweepEnabled = false;
	/** parametric sweep of the last Compute (DevLog-020 s.1.3); null when the spec has none */
	sweep = $state.raw<SweepState | null>(null);
	/** displayed sweep point (dataset), -1 when there is no sweep */
	active = $state(-1);
	/** the user picked or probed a dataset while the sweep runs: later points do not take over the display */
	private pinned = false;
	private sweepToken = 0;
	/** master copy of the sweep points (this.sweep publishes snapshots of it), the study and the model snapshot */
	private pts: SweepPoint[] = [];
	private sweepPar: NonNullable<ReturnType<typeof parametricOf>> | null = null;
	private sweepBase: { text: string; data: unknown; params: Map<string, ParamInfo> | undefined } | null = null;
	/** least recently used first */
	private lru: number[] = [];
	/** point being re-solved after eviction (-1: none) */
	pointLoading = $state(-1);
	private reEngine: EngineClient | null = null;
	private reToken = 0;
	private accEngine: EngineClient | null = null;
	private accToken = 0;
	private unsub: () => void;
	private busy = false;
	private pending: { scale: number; solve: boolean } | null = null;
	private dragT0 = 0;

	private constructor(model: ModelState) {
		this.model = model;
		this.unsub = model.onEdit((op) => this.onEdit(op));
	}

	static async open(id: string, text: string, reg: Registry): Promise<Session> {
		const s = new Session(await ModelState.open(id, text, reg));
		s.caseInfo = await loadCaseFor(id, text).catch(() => null);
		return s;
	}

	get dim(): number {
		const d = this.model.data as { geometry?: { dim?: number } } | null;
		return d?.geometry?.dim ?? 2;
	}

	/** The solution belongs to the current spec and to a full-resolution run. */
	get fresh(): boolean {
		return !!this.solution && this.solutionSpec === this.model.specHash && !this.solutionCoarse;
	}
	get staleSolution(): boolean {
		return !!this.solution && this.solutionSpec !== this.model.specHash;
	}
	get staleMesh(): boolean {
		return !!this.mesh && this.meshSpec !== this.model.specHash && this.meshDependsOnEdit;
	}
	private meshSpec = $state('');
	private meshDependsOnEdit = $state(false);
	/** params of the displayed dataset (a sweep point), else the model's */
	get activeParams(): Map<string, ParamInfo> | undefined {
		const p = this.sweep && this.active >= 0 ? this.sweep.points[this.active] : null;
		return p?.params ?? this.model.parsed?.params;
	}
	/** identity of the displayed dataset: probe rows and their marks are tied to it (survives a re-solve after eviction) */
	get datasetKey(): string {
		return this.sweep && this.active >= 0 ? `sweep:${this.sweep.startedAt}:${this.active}` : `run:${this.solution?.run.startedAt ?? ''}`;
	}
	/** label of the displayed dataset ("D = 4 mm"), '' without a sweep */
	get activeLabel(): string {
		return this.sweep && this.active >= 0 ? (this.sweep.points[this.active]?.label ?? '') : '';
	}
	/** eval-case properties the last run actually used (from prepareRun notes) */
	get caseFilled(): string[] {
		return this.notes.filter((n) => /from the eval case/.test(n)).map((n) => n.replace(/^materials\./, '').replace(/:.*$/, ''));
	}

	/** Coalesced runs: one in flight, the latest request runs next. */
	private schedule(scale: number, solve: boolean) {
		if (this.busy) { this.pending = { scale, solve: solve || !!this.pending?.solve }; return; }
		this.busy = true;
		const t0 = this.dragT0 || performance.now();
		const run = solve ? this.compute(scale) : this.buildMesh(scale);
		void run.finally(() => {
			this.busy = false;
			if (scale > 1) this.dragMs = performance.now() - t0;
			this.dragT0 = 0;
			const next = this.pending;
			this.pending = null;
			if (next) this.schedule(next.scale, next.solve);
		});
	}

	/** End of a drag gesture (after its last op has landed): full-resolution run. */
	finishDrag() {
		this.model.endDrag();
		this.schedule(1, this.autoCompute);
	}

	private onEdit(op: Operation) {
		const inv = new Set(op.invalidates);
		const geo = inv.has('geometry') || inv.has('mesh');
		if (geo) this.meshDependsOnEdit = true;
		this.stopRefine();
		if (this.model.dragging) this.dragT0 = performance.now();
		const scale = this.model.dragging ? 2 : 1;
		if (this.autoCompute && (geo || inv.has('solution'))) this.schedule(scale, true);
		else if (geo) this.schedule(scale, false);
		if (this.model.dragging && (op.coalesced ?? 1) > 1) return;
		appLog.info(`op #${op.seq} ${op.kind} ${op.patch.filter((p) => p.op !== 'test').map((p) => `${p.op} ${p.path}`).join(', ')}${op.validation.ok ? '' : ` (invalid: ${op.validation.errors.length} issues)`}`);
	}

	private setMesh(mesh: Mesh, quality: Float64Array, ms: MeshInfo['ms'], source: string, t0: number, spec: string, hFactor = 1) {
		this.mesh = mesh;
		this.post.setMesh(mesh);
		this.m2 = mesh.dim === 2 ? toMesh2D(mesh) : null;
		this.quality = quality;
		let qmin = Infinity, qs = 0;
		for (const v of quality) { if (v < qmin) qmin = v; qs += v; }
		this.meshInfo = { hFactor, type: mesh.cells.type, cells: mesh.cells.domain.length, nodes: mesh.nodes.length / mesh.dim, source, hash: mesh.hash, ms, roundTripMs: performance.now() - t0, qmin, qmean: qs / quality.length };
		this.meshSpec = spec;
		this.meshDependsOnEdit = false;
	}

	private handle(o: RunOutcome, what: string, spec: string, scale: number): RunOutcome {
		this.lastOutcomeMs = o.ms;
		this.progress = null;
		this.runStart = 0;
		if (o.kind === 'error') {
			this.status = 'error';
			this.error = o.message;
			if (what === 'compute') this.solution = null;
			appLog.error(`${what}: ${o.stage ?? ''} ${o.message}`);
		} else if (o.kind === 'unavailable') {
			this.status = 'unavailable';
			this.reasons = o.reasons;
			this.solution = null;
			appLog.warn(`${what}: results unavailable: ${o.reasons.join('; ')}`);
		} else if (o.kind === 'result') {
			this.status = 'solved';
			this.solution = o.solution;
			this.solutionSpec = spec;
			this.solutionCoarse = scale > 1;
			this.solutionLevel = 1;
			if (scale === 1) appLog.info(`${what}: solved in ${fmtMs(o.ms)}, ${o.solution.stats.dof} DOF, ${o.solution.stats.solver}`);
			if (scale === 1 && what === 'compute') this.solvedSeq++;
			if (scale === 1 && what === 'compute' && this.accuracy && !this.model.dragging && spec === this.model.specHash) void this.refine(spec, o.solution, o.ms);
		} else if (o.kind === 'meshed') this.status = this.solution ? 'solved' : 'meshed';
		return o;
	}

	private handlers(t0: number, spec: string, tag: string) {
		return {
			mesh: (m: Mesh, q: Float64Array, ms: MeshInfo['ms'], src: string) => this.setMesh(m, q, ms, src, t0, spec),
			progress: (st: string, f: number, msg: string | undefined, ts: string) => {
				appLog.stage(tag, st, f, msg, ts);
				this.progress = { stage: st, frac: f, ...(msg ? { msg } : {}) };
				if (st === 'prepare' && msg) { this.notes = [...this.notes, msg]; appLog.info(`prepare: ${msg}`); }
			}
		};
	}

	/** Mesh only (Geometry and Mesh views). */
	async buildMesh(meshScale = 1): Promise<RunOutcome> {
		if (!this.model.parsed?.ok) {
			this.status = 'error';
			this.error = 'the model does not validate; see Messages';
			return { kind: 'error', message: this.error, ms: 0 };
		}
		const spec = this.model.specHash;
		// sweep (DevLog-020 s.7, audit m1): the view shows what the dataset selector says. With a dataset of a sweep
		// computed for the current spec selected, Mesh shows that dataset's own solve mesh (the mesh its solution was
		// computed on; a mesh-only build would be the order-1 preview mesh and orphan the solution). Otherwise the base
		// model is meshed and the selector switches to "base model (spec values)"
		const sw = this.sweep, pt = sw && this.active >= 0 ? this.pts[this.active] : null;
		if (pt && sw && sw.spec === spec && pt.held && pt.mesh && meshScale === 1) {
			this.showPoint(this.active);
			appLog.info(`mesh: dataset ${pt.label} shown with its solve mesh (${pt.mesh.cells.domain.length} ${pt.mesh.cells.type} cells); select "base model" in the dataset list to mesh the spec values`);
			return { kind: 'meshed', ms: 0 };
		}
		// leaving the datasets: their solution is not drawn on the base model (the selector and the view say "base model")
		if (sw && this.active >= 0) { this.active = -1; this.solution = null; }
		this.status = this.solution ? this.status : 'meshing';
		const t0 = performance.now();
		const o = await this.engine.run(this.model.text, { meshOnly: true, meshScale }, this.handlers(t0, spec, 'mesh'));
		if (o.kind !== 'cancelled' && meshScale === 1) appLog.info(`mesh: ${this.meshInfo?.cells ?? 0} ${this.meshInfo?.type ?? ''} cells in ${fmtMs(o.ms)} (worker round trip)`);
		return this.handle(o, 'mesh', spec, meshScale);
	}

	/** Full run: mesh, then the physics module (C4) of the first study; a parametric study runs as a sweep. */
	async compute(meshScale = 1): Promise<RunOutcome> {
		const par = parametricOf(this.model.data);
		if (par && meshScale === 1 && this.sweepEnabled) return this.computeSweep(par);
		this.sweepToken++;
		this.reToken++;
		this.pointLoading = -1;
		this.sweep = null;
		this.pts = [];
		this.active = -1;
		const spec = this.model.specHash;
		let text = this.model.text;
		// the runner solves the first study: a parametric study in front is taken out of the run copy
		if (par && par.index === 0) {
			try { text = await this.runText(par, {}, this.snapshot()); }
			catch (e) { return this.handle({ kind: 'error', message: `parametric study ${par.id}: ${(e as Error).message}`, ms: 0 }, 'compute', spec, meshScale); }
		}
		this.status = 'solving';
		this.runStart = performance.now();
		this.progress = null;
		this.notes = [];
		if (meshScale === 1) appLog.clearProgress();
		const kase = this.useCase && this.caseInfo ? { case: this.caseInfo.data } : {};
		const o = await this.engine.run(text, { meshScale, ...kase }, this.handlers(this.runStart, spec, 'run'));
		return this.handle(o, 'compute', spec, meshScale);
	}

	/** Axes of a parametric study: values resolved against the model's params (SI) and expressed in each param's unit. */
	private sweepAxes(par: NonNullable<ReturnType<typeof parametricOf>>): SweepAxis[] {
		const params = this.model.parsed?.params;
		if (!params) throw new Error('the model params do not resolve');
		const scope = scopeOf(params);
		const defs = ((this.model.data as { params?: Record<string, unknown> } | null)?.params ?? {});
		const si = (q: unknown) => { const r = resolveQuantity(q, scope); if (r.na) throw new Error('a sweep value is N/A'); return r.si; };
		return par.sweep.map((ax) => {
			const param = String(ax.param ?? '');
			const def = defs[param];
			// the param's own unit; an expression param without one is swept in its SI unit (written as {value, unit})
			const info = params.get(param);
			const unit = def && typeof def === 'object' && typeof (def as { unit?: unknown }).unit === 'string' ? (def as { unit: string }).unit : (info?.unit ?? (info ? units.formatUnit(info.dim) : ''));
			let vs: number[];
			if (Array.isArray(ax.values)) vs = ax.values.map(si);
			else {
				const r = ax.range as { start: unknown; stop: unknown; n: number } | undefined;
				if (!r || !(r.n >= 2)) throw new Error(`axis ${param}: values or range {start, stop, n} required`);
				const a = si(r.start), b = si(r.stop);
				vs = Array.from({ length: r.n }, (_, i) => a + ((b - a) * i) / (r.n - 1));
			}
			const d = displayScale(unit);
			// the param's own unit; rounded to 12 significant digits so 0.1-step ranges read as typed
			return { param, unit, si: vs, values: vs.map((v) => Number((d.a * v + d.b).toPrecision(12))) };
		});
	}

	/** The model as one sweep reads it for all its points (edits during the sweep do not leak into later points). */
	private snapshot(): { text: string; data: unknown; params: Map<string, ParamInfo> | undefined } {
		return { text: this.model.text, data: this.model.data, params: this.model.parsed?.params };
	}

	/** Spec text of one run of a parametric study: swept params set, the parametric study removed (not logged). */
	private async runText(par: NonNullable<ReturnType<typeof parametricOf>>, values: Record<string, number>, base: { text: string; data: unknown; params: Map<string, ParamInfo> | undefined }): Promise<string> {
		const data = base.data as { params?: Record<string, unknown>; studies?: Array<{ id?: string }>; results?: { datasets?: Array<{ type?: string; data?: string }> }; provenance?: { values?: Record<string, unknown> }; assumptions?: Array<{ paths?: unknown[] }>; missing?: unknown[] };
		const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
		const patch: JsonPatchOp[] = [];
		for (const [k, v] of Object.entries(values)) {
			const def = data.params?.[k];
			if (def && typeof def === 'object' && 'value' in def) patch.push({ op: 'replace', path: `/params/${esc(k)}/value`, value: v });
			else {
				const info = base.params?.get(k);
				const unit = info?.unit ?? (info && info.dim.some((d) => d !== 0) ? units.formatUnit(info.dim) : '');
				patch.push({ op: 'replace', path: `/params/${esc(k)}`, value: unit ? { value: v, unit } : v });
			}
		}
		// solution datasets of the parametric study read its inner study in the single run (results C10)
		(Array.isArray(data.results?.datasets) ? data.results.datasets : []).forEach((d, i) => { if (d?.type === 'solution' && d.data === par.id) patch.push({ op: 'replace', path: `/results/datasets/${i}/data`, value: par.inner }); });
		// provenance, assumption and missing paths into the removed study would no longer resolve (validation error)
		const inStudy = (path: unknown) => typeof path === 'string' && (path === `studies.${par.id}` || path.startsWith(`studies.${par.id}.`) || path === `studies.${par.index}` || path.startsWith(`studies.${par.index}.`));
		for (const k of Object.keys(data.provenance?.values ?? {})) if (inStudy(k)) patch.push({ op: 'remove', path: `/provenance/values/${esc(k)}` });
		(data.assumptions ?? []).forEach((a, i) => {
			const ps = Array.isArray(a?.paths) ? a.paths : [];
			if (ps.some(inStudy)) patch.push({ op: 'replace', path: `/assumptions/${i}/paths`, value: ps.filter((x) => !inStudy(x)) });
		});
		const miss = (data.missing ?? []).map((m, i) => ({ m, i })).filter(({ m }) => !!m && typeof m === 'object' && inStudy((m as { path?: unknown }).path));
		for (const { i } of miss.reverse()) patch.push({ op: 'remove', path: `/missing/${i}` });
		patch.push({ op: 'remove', path: `/studies/${par.index}` });
		// the runner solves the first study: the inner study goes first
		const rest = (data.studies ?? []).filter((_, i) => i !== par.index);
		const k = rest.findIndex((x) => x?.id === par.inner);
		if (k < 0) throw new Error(`no study '${par.inner}'`);
		if (k > 0) patch.push({ op: 'move', from: `/studies/${k}`, path: '/studies/0' });
		const log = await createOpLog(base.text, { embedText: false });
		await log.apply(patch, { actor: 'user', reason: 'sweep point (private copy, not in the model log)' });
		return log.text;
	}

	/** Parametric sweep (DevLog-020 s.1.3): one engine run per point, row-major over the axes (first slowest). */
	private async computeSweep(par: NonNullable<ReturnType<typeof parametricOf>>): Promise<RunOutcome> {
		const tok = ++this.sweepToken;
		const spec = this.model.specHash;
		const t0 = performance.now();
		if (!this.model.parsed?.ok) { this.sweep = null; this.active = -1; return this.handle({ kind: 'error', message: 'the model does not validate; see Messages', ms: 0 }, 'compute', spec, 1); }
		const base = this.snapshot();
		let axes: SweepAxis[];
		try { axes = this.sweepAxes(par); }
		catch (e) { this.sweep = null; this.active = -1; return this.handle({ kind: 'error', message: `parametric study ${par.id}: ${(e as Error).message}`, ms: 0 }, 'compute', spec, 1); }
		const total = axes.reduce((n, a) => n * a.values.length, 1);
		const points: SweepPoint[] = [];
		for (let i = 0; i < total; i++) {
			const values: Record<string, number> = {};
			let r = i;
			for (let k = axes.length - 1; k >= 0; k--) { const n = axes[k]!.values.length; values[axes[k]!.param] = axes[k]!.values[r % n]!; r = Math.floor(r / n); }
			const label = axes.map((a) => `${a.param} = ${fmt(values[a.param]!, 4)}${a.unit && a.unit !== '1' ? ` ${a.unit}` : ''}`).join(', ');
			points.push({ index: i, values, label, status: 'pending', message: '', solution: null, mesh: null, quality: null, meshMs: null, meshSource: '', params: null, ms: 0, scalars: null, dof: 0, held: false });
		}
		this.pinned = false;
		this.pts = points;
		this.sweepPar = par;
		this.sweepBase = base;
		this.lru = [];
		this.reToken++;
		this.pointLoading = -1;
		this.active = -1;
		this.solution = null;
		this.sweep = { studyId: par.id, innerId: par.inner, axes, points, spec, done: 0, startedAt: t0 };
		this.status = 'solving';
		this.runStart = t0;
		this.progress = null;
		this.notes = [];
		appLog.clearProgress();
		appLog.info(`sweep ${par.id}: ${total} points over ${axes.map((a) => `${a.param} (${a.values.length})`).join(' x ')}`);
		const kase = this.useCase && this.caseInfo ? { case: this.caseInfo.data } : {};
		let solved = 0, last: RunOutcome = { kind: 'cancelled', ms: 0 };
		const put = () => { if (tok === this.sweepToken) this.publish(); };
		for (const p of points) {
			if (tok !== this.sweepToken) return { kind: 'cancelled', ms: performance.now() - t0 };
			p.status = 'solving';
			put();
			const tag = `sweep ${p.index + 1}/${total}`;
			let text: string;
			try { text = await this.runText(par, p.values, base); }
			catch (e) { p.status = 'error'; p.message = (e as Error).message; put(); last = { kind: 'error', message: p.message, ms: 0 }; continue; }
			// cancelled while the point text was built: start no run
			if (tok !== this.sweepToken) return { kind: 'cancelled', ms: performance.now() - t0 };
			let lm: { m: Mesh; q: Float64Array; ms: MeshInfo['ms']; src: string } | null = null;
			const o = await this.engine.run(text, { meshScale: 1, ...kase }, {
				mesh: (m, q, ms, src) => { lm = { m, q, ms, src }; },
				progress: (st, f, msg, ts) => {
					appLog.stage(tag, st, f, msg, ts);
					if (tok !== this.sweepToken) return;
					this.progress = { stage: `${tag} ${st}`, frac: (p.index + (st === 'solve' ? f : 0)) / total, ...(msg ? { msg } : {}) };
					if (st === 'prepare' && msg && p.index === 0) this.notes = [...this.notes, msg];
				}
			});
			if (tok !== this.sweepToken || o.kind === 'cancelled') { p.status = 'cancelled'; put(); return o; }
			p.ms = o.ms;
			const L = lm as { m: Mesh; q: Float64Array; ms: MeshInfo['ms']; src: string } | null;
			if (L) { p.mesh = L.m; p.quality = L.q; p.meshMs = L.ms; p.meshSource = L.src; p.held = true; }
			p.params = parseSpecText(text, this.model.reg).params;
			if (o.kind === 'result') { p.status = 'solved'; p.solution = o.solution; p.scalars = o.solution.scalars; p.dof = o.solution.stats.dof; solved++; }
			else if (o.kind === 'unavailable') { p.status = 'unavailable'; p.message = o.reasons.join('; '); }
			else if (o.kind === 'error') { p.status = 'error'; p.message = o.message; }
			if (p.held) this.touch(p.index);
			put();
			if (o.kind === 'result') appLog.info(`${tag} ${p.label}: solved in ${fmtMs(o.ms)}, ${o.solution.stats.dof} DOF`);
			else appLog.warn(`${tag} ${p.label}: ${p.status}: ${p.message}`);
			if (o.kind === 'result' && !this.pinned) this.showPoint(p.index);
			if (o.kind === 'result' && solved === 1) this.solvedSeq++;
			if (this.active < 0 && L) this.showPoint(p.index);
			last = o;
		}
		const ms = performance.now() - t0;
		this.lastOutcomeMs = ms;
		this.progress = null;
		this.runStart = 0;
		const failed = points.filter((p) => p.status !== 'solved');
		if (solved) {
			this.status = 'solved';
			appLog.info(`sweep ${par.id}: ${solved}/${total} points solved in ${fmtMs(ms)}`);
		} else if (last.kind === 'unavailable') { this.status = 'unavailable'; this.reasons = last.reasons; }
		else { this.status = 'error'; this.error = failed.map((p) => `${p.label}: ${p.message}`).join('\n') || 'sweep failed'; }
		const anySol = this.solution ?? points.find((p) => p.solution)?.solution;
		return solved && anySol ? { kind: 'result', solution: anySol, ms } : solved ? { kind: 'meshed', ms } : last;
	}

	/** Display sweep point i (dataset selector): its mesh, solution and params; the user's choice holds while the sweep runs. */
	selectPoint(i: number) {
		if (i < 0 && this.sweep) { this.pinned = true; this.active = -1; this.solution = null; this.reToken++; this.pointLoading = -1; void this.buildMesh(); return; }
		if (!this.sweep?.points[i]) return;
		this.pinned = true;
		this.showPoint(i);
	}

	/** The user works with the displayed dataset (probe click): a running sweep stops taking over the display. */
	pinView() {
		if (this.sweep) this.pinned = true;
	}

	/** Publish the master point list (snapshots: consumers see new objects on every change). */
	private publish() {
		if (!this.sweep) return;
		this.sweep = { ...this.sweep, points: this.pts.map((q) => ({ ...q })), done: this.pts.filter((p) => p.status !== 'pending' && p.status !== 'solving').length };
	}

	/** Mark point i used; drop the mesh and solution of the least recently used points beyond SWEEP_HELD (never the shown one). */
	private touch(i: number) {
		this.lru = [...this.lru.filter((x) => x !== i), i];
		let held = this.pts.filter((p) => p.held).length;
		for (const j of [...this.lru]) {
			if (held <= SWEEP_HELD) break;
			const p = this.pts[j];
			if (!p || !p.held || j === this.active || j === i) continue;
			Object.assign(p, { mesh: null, quality: null, solution: null, held: false });
			this.lru = this.lru.filter((x) => x !== j);
			held--;
		}
	}

	private showPoint(i: number) {
		const sw = this.sweep, p = this.pts[i];
		if (!sw || !p) return;
		this.active = i;
		this.reToken++;
		this.pointLoading = -1;
		if (!p.held && p.status === 'solved') { void this.resolvePoint(i); return; }
		if (p.mesh && p.quality && p.meshMs && this.mesh !== p.mesh) this.setMesh(p.mesh, p.quality, p.meshMs, p.meshSource, performance.now(), sw.spec);
		this.solution = p.solution;
		this.solutionSpec = sw.spec;
		this.solutionCoarse = false;
		this.solutionLevel = 1;
		if (p.held) this.touch(i);
		this.publish();
	}

	/** Re-solve an evicted point from the sweep's model snapshot (own worker, so a running sweep is not cancelled). */
	private async resolvePoint(i: number) {
		const sw = this.sweep, p = this.pts[i], par = this.sweepPar, base = this.sweepBase;
		if (!sw || !p || !par || !base) return;
		const tok = ++this.reToken;
		this.pointLoading = i;
		this.solution = null;
		const text = await this.runText(par, p.values, base);
		if (tok !== this.reToken) return;
		this.reEngine ??= new EngineClient();
		let lm: { m: Mesh; q: Float64Array; ms: MeshInfo['ms']; src: string } | null = null;
		const kase = this.useCase && this.caseInfo ? { case: this.caseInfo.data } : {};
		const o = await this.reEngine.run(text, { meshScale: 1, ...kase }, { mesh: (m, q, ms, src) => { lm = { m, q, ms, src }; } });
		if (tok !== this.reToken || this.sweep?.startedAt !== sw.startedAt) return;
		this.pointLoading = -1;
		const L = lm as { m: Mesh; q: Float64Array; ms: MeshInfo['ms']; src: string } | null;
		if (o.kind !== 'result' || !L) { appLog.warn(`sweep ${p.label}: re-solve failed: ${o.kind === 'error' ? o.message : o.kind}`); this.publish(); return; }
		Object.assign(p, { mesh: L.m, quality: L.q, meshMs: L.ms, meshSource: L.src, solution: o.solution, held: true });
		appLog.info(`sweep ${p.label}: re-solved in ${fmtMs(o.ms)} (not held in memory, SWEEP_HELD = ${SWEEP_HELD})`);
		this.showPoint(i);
	}

	/** Compute through the scheduler (buttons, presets): coalesces with runs in flight. */
	requestCompute() {
		this.schedule(1, true);
	}

	/** Stop the accuracy sequence (any edit): its worker is terminated at once, so it never delays a drag preview. */
	stopRefine() {
		this.accToken++;
		this.accEngine?.dispose();
		this.accEngine = null;
		if (this.acc?.status === 'running') this.acc = null;
	}

	/**
	 * Full-accuracy sequence: the levels of the paired case after hFactor 1, solved in a second worker on the same spec
	 * text; each finer result replaces the displayed solution (real solutions only, coarse to fine), and the headline
	 * quantity per level feeds the Richardson estimate (post/accuracy.ts).
	 */
	private async refine(spec: string, sol0: Solution, ms0: number) {
		const def = this.accuracy, mesh0 = this.mesh, params = this.model.parsed?.params;
		if (!def || !mesh0 || !params) return;
		this.stopRefine();
		const tok = ++this.accToken;
		const conv = caseConvergence(this.caseInfo?.id ?? 'N/A', this.caseInfo?.data ?? null, def.metric);
		const results = (this.model.data as { results?: unknown } | null)?.results ?? null;
		const startedAt = performance.now();
		const rec = async (h: number, sol: Solution, mesh: Mesh, ms: number): Promise<LevelRecord> => ({ h, dof: sol.stats.dof, ms, ...(await levelValues(def, sol, mesh, params, results, this.post)), meshHash: mesh.hash, cells: mesh.cells.domain.length });
		const levels: LevelRecord[] = [await rec(1, sol0, mesh0, ms0)];
		const hs = conv.hFactors.filter((h) => h < 1);
		const put = (st: Partial<AccState>) => { if (tok === this.accToken) this.acc = { status: 'running', levels: [...levels], next: null, conv, def, reason: '', doneAt: 0, startedAt, ...st }; };
		if (conv.hFactors[0] !== 1) { put({ status: 'unavailable', reason: `${conv.hNote} does not start at 1` }); return; }
		for (const h of hs) {
			// browser cap: the predicted DOF of a nested level (dof(1) / h^dim); the rib's h = 0.5 level (1.3M DOF) ended in
			// a stack overflow inside em-modes on 2026-11-06 (DevLog-015 s.5), so larger levels are not attempted
			const pred = levels[0]!.dof / h ** mesh0.dim;
			if (pred > ACC_DOF_CAP) { put({ status: 'unavailable', reason: `level h ${h}: predicted ${(pred / 1e6).toPrecision(2)}M DOF exceeds the browser cap of ${ACC_DOF_CAP / 1e6}M DOF` }); return; }
			put({ next: h });
			const text = this.model.text;
			const kase = this.useCase && this.caseInfo ? { case: this.caseInfo.data } : {};
			this.accEngine ??= new EngineClient();
			let lm: { mesh: Mesh; q: Float64Array; ms: MeshInfo['ms']; src: string } | null = null;
			const t0 = performance.now();
			const o = await this.accEngine.run(text, { meshScale: h, ...kase }, { mesh: (mesh, q, ms, src) => { lm = { mesh, q, ms, src }; } });
			if (tok !== this.accToken || spec !== this.model.specHash) return;
			if (o.kind !== 'result' || !lm) { put({ status: 'unavailable', reason: o.kind === 'error' ? `level h ${h}: ${o.message}` : o.kind === 'unavailable' ? `level h ${h}: ${o.reasons.join('; ')}` : `level h ${h}: ${o.kind}` }); return; }
			const L = lm as { mesh: Mesh; q: Float64Array; ms: MeshInfo['ms']; src: string };
			// show the finer real solution (same spec, nested mesh)
			this.setMesh(L.mesh, L.q, L.ms, L.src, t0, spec, h);
			this.solution = o.solution;
			this.solutionSpec = spec;
			this.solutionCoarse = false;
			this.solutionLevel = h;
			levels.push(await rec(h, o.solution, L.mesh, o.ms));
			if (tok !== this.accToken) return;
			appLog.info(`accuracy: level h ${h}: ${o.solution.stats.dof} DOF in ${fmtMs(o.ms)}`);
		}
		this.accEngine?.dispose();
		this.accEngine = null;
		put({ status: 'done', doneAt: performance.now() });
	}

	cancel() {
		this.stopRefine();
		this.sweepToken++;
		this.reToken++;
		this.pointLoading = -1;
		this.reEngine?.cancel();
		if (this.sweep) {
			for (const p of this.pts) if (p.status === 'solving' || p.status === 'pending') p.status = 'cancelled';
			this.publish();
		}
		this.engine.cancel();
		appLog.warn('run cancelled');
		this.progress = null;
		this.runStart = 0;
		this.status = this.solution ? 'solved' : this.mesh ? 'meshed' : 'idle';
	}

	dispose() {
		this.stopRefine();
		this.unsub();
		this.engine.dispose();
		this.reEngine?.dispose();
		this.post.dispose();
	}
}
