// SPDX-License-Identifier: GPL-3.0-or-later
// Fixtures for the agent tests and the agent task suite: a session over a sims/ spec, an in-memory memory store, a
// recording navigation host, and the FE study runner.
//
// FeRunner (audit S10): the study runner of the task suite is the real FE solver, @amp/physics prepareRun + module
// run in Node, so values depend on the spec (geometry, loads, mesh). It reports what the solver returns (C5 scalars,
// stats, timing, run record with the op log head) and no eval gate: the hero specs are not the eval case models
// (sims/kirsch-plate.yaml uses uniform traction on W/D = 20; SM-01 uses the exact Kirsch traction and Richardson),
// so a gate would need the case pairing, which is the host's job (L5 worker / L8 harness).
// Stages: parse -> prepare (validation, geometry, mesh, materials) -> readiness -> solve.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createOpLog, parseYaml, resolveParams, type OpLog, type Registry } from '@amp/spec';
import type { Mesh, Solution } from '@amp/spec/types';
import { physicsRegistry, prepareRun, registry as physicsModules } from '@amp/physics';
import { AgentSession } from '../src/session.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { memoryBackend } from '../src/memory/backends.ts';
import { RecordingNavHost } from '../src/nav.ts';
import { summarizeSolution, type StudyRunner, type StudyOutcome } from '../src/runner.ts';
import { NodeResultsHost } from './results-host.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..', '..', '..');
export const simText = (id: string): string => readFileSync(join(REPO, 'sims', `${id}.yaml`), 'utf8');

export class FeRunner implements StudyRunner {
  readonly calls: Array<{ studyId: string; specText: string; oplogHead: string; ms: number }> = [];
  /** Latest solve per study (solution, its mesh, the params it was solved with, the spec text): the results host reads it. */
  readonly last = new Map<string, { solution: Solution; mesh: Mesh; params: ReadonlyMap<string, { si: number; dim: readonly number[] }>; specText: string }>();
  async run(input: { specText: string; studyId: string; signal: AbortSignal; oplogHead: string }): Promise<StudyOutcome> {
    const t0 = performance.now();
    const study = input.studyId;
    const done = (o: StudyOutcome): StudyOutcome => { this.calls.push({ studyId: study, specText: input.specText, oplogHead: input.oplogHead, ms: performance.now() - t0 }); return o; };
    const parsed = parseYaml(input.specText);
    if (parsed.issues.length) return done({ ok: false, study, stage: 'parse', message: parsed.issues.slice(0, 3).map((i) => i.message).join('; ') });
    const spec = parsed.data as { studies?: Array<{ id?: string; physics?: string[] }>; physics?: Array<{ id?: string; type?: string }> };
    const st = spec.studies?.find((x) => x.id === study);
    const physicsId = st?.physics?.[0];
    const type = spec.physics?.find((p) => p.id === physicsId)?.type;
    const mod = type ? physicsModules[type] : undefined;
    if (!st || !physicsId || !mod) return done({ ok: false, study, stage: 'prepare', message: `no physics module for study ${study}` });
    let ctx;
    try { ctx = await prepareRun({ spec: parsed.data as Record<string, unknown>, physicsId, signal: input.signal }); }
    catch (e) { return done({ ok: false, study, stage: 'prepare', message: (e as Error).message.slice(0, 500) }); }
    const rd = mod.readiness(ctx.spec, physicsId);
    if (!rd.ready) return done({ ok: false, study, stage: 'readiness', message: rd.reasons.join('; '), readiness: rd });
    try {
      const sol = await mod.run(ctx);
      this.last.set(study, { solution: sol as Solution, mesh: ctx.mesh as Mesh, params: resolveParams((parsed.data as { params?: unknown }).params).scope, specText: input.specText });
      return done({ ok: true, study, solution: summarizeSolution({ ...sol, run: { ...sol.run, oplogHead: input.oplogHead } }), readiness: rd, gates: [] });
    } catch (e) { return done({ ok: false, study, stage: 'solve', message: (e as Error).message.slice(0, 500), readiness: rd }); }
  }
}

export interface Fixture {
  registry: Registry;
  text: string;
  log: OpLog;
  memory: MemoryStore;
  backend: ReturnType<typeof memoryBackend>;
  nav: RecordingNavHost;
  runner: FeRunner;
  results: NodeResultsHost;
  session: AgentSession;
}

export async function fixture(sim: string, o: { text?: string; memory?: Record<string, string>; forbidden?: () => readonly string[]; sessionId?: string; maxReadBytes?: number } = {}): Promise<Fixture> {
  const registry = physicsRegistry();
  const text = o.text ?? simText(sim);
  const log = await createOpLog(text, { registry });
  const backend = memoryBackend(o.memory ?? {});
  const memory = await MemoryStore.open(backend, { ...(o.forbidden ? { forbidden: o.forbidden } : {}) });
  const nav = new RecordingNavHost({ mediaType: 'image/png', base64: 'iVBORw0KGgo=', width: 1, height: 1 });
  const runner = new FeRunner();
  const results = new NodeResultsHost(log, runner);
  const session = new AgentSession({ log, registry, memory, nav, runner, results, sessionId: o.sessionId ?? 'eval', ...(o.forbidden ? { forbidden: o.forbidden } : {}), ...(o.maxReadBytes ? { maxReadBytes: o.maxReadBytes } : {}) });
  return { registry, text, log, memory, backend, nav, runner, results, session };
}

/** JSON inside the first untrusted block of a tool-result text (scripted turns read results like a model would). */
export function blockJson(text: string | null): unknown {
  if (!text) return null;
  const m = /<<<AMP-UNTRUSTED ([0-9a-f]{24}) source=[^>]*>>>\n[^\n]*\n([\s\S]*?)\n<<<\/AMP-UNTRUSTED \1>>>/.exec(text);
  return m ? JSON.parse(m[2] as string) : null;
}

/** Trusted JSON head of a tool-result text. */
export function headJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try { return JSON.parse(text.split('\n')[0] as string) as Record<string, unknown>; } catch { return null; }
}
