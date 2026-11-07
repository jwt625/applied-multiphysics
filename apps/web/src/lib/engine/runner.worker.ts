// SPDX-License-Identifier: GPL-3.0-or-later
// Engine runner Web Worker (C6, DevLog-011 s.1.6): spec text -> parse/validate (@amp/spec) -> geometry + mesh
// (@amp/geom, @amp/mesh; @amp/physics prepareRun when exported) -> physics module run (@amp/physics) -> result.
// Without a registered module the run ends with `unavailable` and its reasons; nothing is computed in its place.
/// <reference lib="webworker" />
import { formatIssues, parseSpecText } from '@amp/spec';
import type { Mesh, PhysicsModule, RunContext, Solution } from '@amp/spec/types';
import { buildMesh } from './spec-adapter';
import { preloadMaterials } from './materials-node-shim';
import { meshFromSpec } from '@amp/mesh/spec';
import { toMesh2D, triShapeQuality } from '../post/field2d';
import { cellQuality } from '../post/solid3d';
import { findModule, loadPhysics } from './physics';
import { appRegistry } from './registry';
import { nowIso, type FromRunner, type RunOptions, type ToRunner } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const runs = new Map<string, AbortController>();

const post = (m: FromRunner, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

function solutionBuffers(s: Solution): ArrayBuffer[] {
	const b = s.fields.map((f) => f.data.buffer as ArrayBuffer);
	if (s.steps) b.push(s.steps.values.buffer as ArrayBuffer);
	return [...new Set(b)];
}

async function run(id: string, specText: string, opts: RunOptions) {
	const ac = new AbortController();
	runs.set(id, ac);
	let stage = 'parse';
	const progress = (st: string, frac: number, msg?: string) => post({ type: 'progress', id, stage: st, frac, ...(msg ? { msg } : {}), ts: nowIso() });
	try {
		const t0 = performance.now();
		const phys = await loadPhysics();
		const { reg, source } = appRegistry(phys);
		const parsed = parseSpecText(specText, reg);
		const tParse = performance.now() - t0;
		if (!parsed.ok || !parsed.spec) throw new Error(`spec does not validate:\n${formatIssues(parsed.issues)}`);
		progress('parse', 1, `${source}, ${tParse.toFixed(1)} ms`);
		if (ac.signal.aborted) return;

		// readiness of the first study's physics (C4) before any mesh at solve order is built
		const study = parsed.spec.studies?.[0];
		const reasons: string[] = [];
		const ready: Array<{ mod: PhysicsModule; pid: string }> = [];
		for (const pid of (study as { physics?: string[] } | undefined)?.physics ?? []) {
			const node = parsed.spec.physics?.find((p) => p.id === pid);
			const mod = node ? findModule(phys, node.type) : null;
			if (!node) reasons.push(`physics '${pid}' not in the spec`);
			else if (!mod) reasons.push(`no @amp/physics module registered for type '${node.type}' (${pid})`);
			else {
				const r = mod.readiness(parsed.spec, pid);
				if (!r.ready) reasons.push(...r.reasons.map((x) => `${pid}: ${x}`));
				else ready.push({ mod, pid });
			}
		}
		if (!study) reasons.push('no study in the spec');
		if (!phys?.prepareRun && ready.length) reasons.push('@amp/physics prepareRun is not exported: no run context (materials, study) can be built');
		const solve = !opts.meshOnly && !reasons.length && ready.length > 0 && !!phys?.prepareRun;

		stage = 'mesh';
		progress('mesh', 0);
		let mesh: Mesh;
		let ms = { parse: tParse, geometry: 0, mesh: 0 };
		let prep: (RunContext & { notes?: string[] }) | null = null;
		let meshSource: string;
		const tm = performance.now();
		if (solve) {
			await preloadMaterials();
			prep = await phys!.prepareRun!({ spec: parsed.data as Record<string, unknown>, physicsId: ready[0]!.pid, hFactor: opts.meshScale ?? 1, signal: ac.signal, ...(opts.case ? { case: opts.case } : {}) });
			mesh = prep.mesh;
			meshSource = '@amp/physics prepareRun (solve order)';
		} else {
			if ((opts.meshScale ?? 1) === 1) {
				mesh = meshFromSpec(parsed.data as Record<string, unknown>, { order: 1 });
				meshSource = '@amp/mesh meshFromSpec (order 1)';
			} else {
				// coarse drag preview: the same features and size field with every size scaled (meshFromSpec has no scale)
				mesh = buildMesh(parsed.spec, parsed.params, opts.meshScale!).mesh;
				meshSource = `apps/web spec adapter (sizes x${opts.meshScale})`;
			}
		}
		ms = { parse: tParse, geometry: 0, mesh: performance.now() - tm };
		progress('mesh', 1, `${mesh.cells.domain.length} ${mesh.cells.type} cells, ${meshSource}`);
		// structured clone (no transfer): the worker still needs the mesh for the solve
		// element quality computed here, off the main thread (audit S6)
		const quality = mesh.dim === 2 ? triShapeQuality(toMesh2D(mesh)) : cellQuality(mesh);
		post({ type: 'mesh', id, mesh, quality, ms, source: meshSource, ts: nowIso() }, [quality.buffer]);
		if (opts.meshOnly || ac.signal.aborted) return;
		if (!solve || !prep) {
			post({ type: 'unavailable', id, reasons: reasons.length ? reasons : ['nothing to run'], ts: nowIso() });
			return;
		}
		stage = 'solve';
		for (const n of prep.notes ?? []) progress('prepare', 1, n);
		const { mod, pid } = ready[0]!;
		let sol;
		try {
			sol = await mod.run({ ...prep, physicsId: pid, progress, signal: ac.signal });
		} catch (e) {
			// a module that cannot run with the inputs it was given (e.g. a material value that is N/A) has no result
			if (ac.signal.aborted) return;
			post({ type: 'unavailable', id, reasons: [`${pid}: ${(e as Error).message}`, ...(prep.notes ?? [])], ts: nowIso() });
			return;
		}
		if (ac.signal.aborted) return;
		post({ type: 'result', id, solution: sol, ts: nowIso() }, solutionBuffers(sol));
	} catch (e) {
		if (ac.signal.aborted) return;
		post({ type: 'error', id, message: e instanceof Error ? e.message : String(e), stage, ts: nowIso() });
	} finally {
		runs.delete(id);
	}
}

ctx.onmessage = (ev: MessageEvent<ToRunner>) => {
	const m = ev.data;
	if (m.type === 'run') void run(m.id, m.specText, (m.options ?? {}) as RunOptions);
	else if (m.type === 'cancel') runs.get(m.id)?.abort();
};
