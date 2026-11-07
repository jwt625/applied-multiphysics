// SPDX-License-Identifier: GPL-3.0-or-later
// One open model with its engine and post workers: mesh and solution state, run scheduling (one run in flight, the
// latest request runs next), coarse runs during drags (sizes x2), progress for long runs.
// Freshness (audit B1): every solution is tagged with the spec hash it was computed from; it is fresh only while that
// hash equals the model's current spec hash and it came from a full-resolution run. A run that ends unavailable or in
// an error drops the solution (audit S1). Eval-case values are credited only when prepareRun reports using them (S2).
import { units, type Registry } from '@amp/spec';
import type { Mesh, Operation, Solution } from '@amp/spec/types';
import { EngineClient, type RunOutcome } from '../engine/client';
import { PostClient } from '../post/client';
import { toMesh2D, type Mesh2D } from '../post/field2d';
import { ModelState } from '../state/model.svelte';
import { appLog } from '../state/log.svelte';
import { fmtMs } from '../gfx/ticks';
import { loadCaseFor, type CaseInfo } from '../cases';
import { caseConvergence, levelValues, type AccState, type AccuracyDef, type LevelRecord } from '../post/accuracy';

/** largest nested level the full-accuracy sequence solves in the browser (DOF) */
export const ACC_DOF_CAP = 1_000_000;

export type Status = 'idle' | 'meshing' | 'meshed' | 'solving' | 'solved' | 'unavailable' | 'error';

export interface MeshInfo { hFactor: number; type: string; cells: number; nodes: number; source: string; hash: string; ms: { parse: number; geometry: number; mesh: number }; roundTripMs: number; qmin: number; qmean: number }

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
		this.status = this.solution ? this.status : 'meshing';
		const t0 = performance.now();
		const o = await this.engine.run(this.model.text, { meshOnly: true, meshScale }, this.handlers(t0, spec, 'mesh'));
		if (o.kind !== 'cancelled' && meshScale === 1) appLog.info(`mesh: ${this.meshInfo?.cells ?? 0} ${this.meshInfo?.type ?? ''} cells in ${fmtMs(o.ms)} (worker round trip)`);
		return this.handle(o, 'mesh', spec, meshScale);
	}

	/** Full run: mesh, then the physics module (C4) of the first study. */
	async compute(meshScale = 1): Promise<RunOutcome> {
		const spec = this.model.specHash;
		this.status = 'solving';
		this.runStart = performance.now();
		this.progress = null;
		this.notes = [];
		if (meshScale === 1) appLog.clearProgress();
		const kase = this.useCase && this.caseInfo ? { case: this.caseInfo.data } : {};
		const o = await this.engine.run(this.model.text, { meshScale, ...kase }, this.handlers(this.runStart, spec, 'run'));
		return this.handle(o, 'compute', spec, meshScale);
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
		const results = ((this.model.data as { results?: unknown[] } | null)?.results ?? []);
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
		this.post.dispose();
	}
}
