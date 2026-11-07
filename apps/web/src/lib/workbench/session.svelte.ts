// SPDX-License-Identifier: GPL-3.0-or-later
// One open model with its engine and post workers: mesh and solution state, staleness from the op log's `invalidates`,
// run scheduling (re-mesh on geometry/mesh edits, Compute on demand, coarse preview runs during drags).
import { units, type Registry } from '@amp/spec';
import type { Mesh, Operation, Solution } from '@amp/spec/types';
import { EngineClient, type RunOutcome } from '../engine/client';
import { PostClient } from '../post/client';
import { toMesh2D, triShapeQuality, type Mesh2D } from '../post/field2d';
import { cellQuality } from '../post/solid3d';
import { ModelState } from '../state/model.svelte';
import { appLog } from '../state/log.svelte';
import { fmtMs } from '../gfx/ticks';
import { loadCaseFor, type CaseInfo } from '../cases';

export type Status = 'idle' | 'meshing' | 'meshed' | 'solving' | 'solved' | 'unavailable' | 'error';

export interface MeshInfo { type: string; cells: number; nodes: number; source: string; ms: { parse: number; geometry: number; mesh: number }; roundTripMs: number; qmin: number; qmean: number }

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
	status = $state<Status>('idle');
	reasons = $state<string[]>([]);
	error = $state('');
	staleMesh = $state(false);
	staleSolution = $state(false);
	lastOutcomeMs = $state(0);
	private unsub: () => void;

	private constructor(model: ModelState) {
		this.model = model;
		this.unsub = model.onEdit((op) => this.onEdit(op));
	}

	static async open(id: string, text: string, reg: Registry): Promise<Session> {
		const s = new Session(await ModelState.open(id, text, reg));
		s.caseInfo = await loadCaseFor(id).catch(() => null);
		return s;
	}

	get dim(): number {
		const d = this.model.data as { geometry?: { dim?: number } } | null;
		return d?.geometry?.dim ?? 2;
	}

	/** Physics modules exist (set by the caller once @amp/physics is known): Compute after geometry edits. */
	autoCompute = $state(false);
	/** Input-to-repaint time of the last drag step (coarse re-mesh or re-solve), ms. */
	dragMs = $state(0);
	private meshBusy = false;
	private meshPending: number | null = null;
	private dragT0 = 0;

	/** Coalesced re-mesh (one run in flight, the latest request runs next). */
	private scheduleMesh(scale: number) {
		if (this.meshBusy) { this.meshPending = scale; return; }
		this.meshBusy = true;
		const t0 = this.dragT0 || performance.now();
		const run = this.autoCompute ? this.compute(undefined, scale) : this.buildMesh(undefined, scale);
		void run.finally(() => {
			this.meshBusy = false;
			if (scale > 1) this.dragMs = performance.now() - t0;
			this.dragT0 = 0;
			const next = this.meshPending;
			this.meshPending = null;
			if (next !== null) this.scheduleMesh(next);
		});
	}

	/** End of a drag gesture: full-resolution mesh (and solve when a module exists). */
	finishDrag() {
		this.model.endDrag();
		this.scheduleMesh(1);
	}

	private onEdit(op: Operation) {
		const inv = new Set(op.invalidates);
		if (inv.has('geometry') || inv.has('mesh')) {
			this.staleMesh = true;
			this.staleSolution = !!this.solution;
			if (this.model.dragging) this.dragT0 = performance.now();
			this.scheduleMesh(this.model.dragging ? 2 : 1);
		} else if (inv.has('solution') && this.solution) this.staleSolution = true;
		if (this.model.dragging && (op.coalesced ?? 1) > 1) return;
		appLog.info(`op #${op.seq} ${op.kind} ${op.patch.filter((p) => p.op !== 'test').map((p) => `${p.op} ${p.path}`).join(', ')}${op.validation.ok ? '' : ` (invalid: ${op.validation.errors.length} issues)`}`);
	}

	private setMesh(mesh: Mesh, ms: MeshInfo['ms'], source: string, t0: number) {
		this.mesh = mesh;
		this.post.setMesh(mesh);
		let q: Float64Array;
		if (mesh.dim === 2) {
			this.m2 = toMesh2D(mesh);
			q = triShapeQuality(this.m2);
		} else {
			this.m2 = null;
			q = cellQuality(mesh);
		}
		this.quality = q;
		let qmin = Infinity, qs = 0;
		for (const v of q) { if (v < qmin) qmin = v; qs += v; }
		this.meshInfo = { type: mesh.cells.type, cells: mesh.cells.domain.length, nodes: mesh.nodes.length / mesh.dim, source, ms, roundTripMs: performance.now() - t0, qmin, qmean: qs / q.length };
		this.staleMesh = false;
	}

	private handle(o: RunOutcome, what: string): RunOutcome {
		this.lastOutcomeMs = o.ms;
		if (o.kind === 'error') { this.status = 'error'; this.error = o.message; appLog.error(`${what}: ${o.stage ?? ''} ${o.message}`); }
		else if (o.kind === 'unavailable') { this.status = 'unavailable'; this.reasons = o.reasons; appLog.warn(`${what}: results unavailable: ${o.reasons.join('; ')}`); }
		else if (o.kind === 'result') {
			this.status = 'solved';
			this.solution = o.solution;
			this.staleSolution = false;
			appLog.info(`${what}: solved in ${fmtMs(o.ms)}, ${o.solution.stats.dof} DOF, ${o.solution.stats.solver}`);
		} else if (o.kind === 'meshed') this.status = this.solution && !this.staleSolution ? 'solved' : 'meshed';
		return o;
	}

	/** Mesh only (Geometry and Mesh views). `text` overrides the model text (drag previews). */
	async buildMesh(text?: string, meshScale = 1): Promise<RunOutcome> {
		if (!this.model.parsed?.ok && text === undefined) {
			this.status = 'error';
			this.error = 'the model does not validate; see Messages';
			return { kind: 'error', message: this.error, ms: 0 };
		}
		this.status = 'meshing';
		const t0 = performance.now();
		const o = await this.engine.run(text ?? this.model.text, { meshOnly: true, meshScale }, {
			mesh: (m, ms, src) => this.setMesh(m, ms, src, t0),
			progress: (st, f, msg, ts) => appLog.stage('mesh', st, f, msg, ts)
		});
		if (o.kind !== 'cancelled' && text === undefined) appLog.info(`mesh: ${this.meshInfo?.cells ?? 0} ${this.meshInfo?.type ?? ''} cells in ${fmtMs(o.ms)} (worker round trip)`);
		return this.handle(o, 'mesh');
	}

	/** Eval case whose sourced material values fill N/A properties (shown in the UI; can be switched off). */
	caseInfo = $state.raw<CaseInfo | null>(null);
	useCase = $state(true);

	/** Full run: mesh, then the physics module (C4) when one is registered. */
	async compute(text?: string, meshScale = 1): Promise<RunOutcome> {
		this.status = 'solving';
		const t0 = performance.now();
		appLog.clearProgress();
		const kase = this.useCase && this.caseInfo ? { case: this.caseInfo.data } : {};
		const o = await this.engine.run(text ?? this.model.text, { meshScale, ...kase }, {
			mesh: (m, ms, src) => this.setMesh(m, ms, src, t0),
			progress: (st, f, msg, ts) => { appLog.stage('run', st, f, msg, ts); if (st === 'prepare' && msg) appLog.info(`prepare: ${msg}`); }
		});
		return this.handle(o, 'compute');
	}

	cancel() {
		this.engine.cancel();
		appLog.warn('run cancelled');
		this.status = this.mesh ? 'meshed' : 'idle';
	}

	dispose() {
		this.unsub();
		this.engine.dispose();
		this.post.dispose();
	}
}
