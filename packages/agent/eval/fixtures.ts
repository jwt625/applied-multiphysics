// SPDX-License-Identifier: GPL-3.0-or-later
// Fixtures for the agent tests and the agent task suite: a session over a sims/ spec, an in-memory memory store, a
// recording navigation host, and a mock study runner.
//
// MockClosedFormRunner is NOT the FE solver. It stands in for @amp/physics (no package index yet, DevLog-012 s.3) and
// returns only closed-form values that follow from the spec itself:
//   kirsch-plate std1: K_t = 3 (Kirsch 1898, infinite plate under uniaxial tension; R3 SM-01), and the maximum von
//   Mises stress = 3 sigma_inf at the hole edge (theta = 90 deg: sigma_theta = 3 sigma_inf, sigma_r = 0, plane stress).
//   The SM-01 gate is reported only when W/D >= 20 (the case condition), otherwise 'unavailable'.
//   cylinder-cavity: not ready while eps_r is N/A (the spec says so in `missing`).
// It refuses to run an invalid spec (stage 'validate'), like the real worker would.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createOpLog, parseSpecText, makeRunRecord, sha256Hex, type OpLog, type Registry } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';
import { AgentSession } from '../src/session.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { memoryBackend } from '../src/memory/backends.ts';
import { RecordingNavHost } from '../src/nav.ts';
import type { StudyRunner, StudyOutcome } from '../src/runner.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..', '..', '..');
export const simText = (id: string): string => readFileSync(join(REPO, 'sims', `${id}.yaml`), 'utf8');

export class MockClosedFormRunner implements StudyRunner {
  readonly calls: Array<{ studyId: string; specText: string; oplogHead: string }> = [];
  private registry: Registry;
  constructor(registry: Registry) { this.registry = registry; }
  async run(input: { specText: string; studyId: string; signal: AbortSignal; oplogHead: string }): Promise<StudyOutcome> {
    this.calls.push({ studyId: input.studyId, specText: input.specText, oplogHead: input.oplogHead });
    const study = input.studyId;
    const r = parseSpecText(input.specText, this.registry);
    if (!r.ok || !r.spec) return { ok: false, study, stage: 'validate', message: r.issues.slice(0, 5).map((i) => `${i.pointer}: ${i.message}`).join('; ') };
    const spec = r.spec as unknown as { id: string; materials?: Array<{ id: string; override?: Record<string, unknown> }> };
    const na = (spec.materials ?? []).flatMap((m) => Object.entries(m.override ?? {}).filter(([, v]) => v === 'N/A').map(([k]) => `materials.${m.id}.override.${k} is N/A`));
    if (na.length) return { ok: false, study, stage: 'readiness', message: na.join('; '), readiness: { ready: false, reasons: na } };
    if (spec.id === 'kirsch-plate' && study === 'std1') {
      const si = (n: string) => { const p = r.params.get(n); if (!p) throw new Error(`param ${n} missing`); return p.si; };
      const sigma = si('sigma_inf'), W = si('W'), D = si('D');
      const run = await makeRunRecord({ engine: '@amp/agent-eval/mock-closed-form', spec: r.spec, meshHash: await sha256Hex('mock-closed-form:no-mesh'), fidelity: 'rigorous', oplogHead: input.oplogHead });
      const cond = W / D >= 20;
      return {
        ok: true, study,
        solution: {
          scalars: { K_t: { value: 3, unit: '1' }, mises_max: { value: 3 * sigma, unit: 'Pa' } },
          stats: { dof: 0, solver: 'closed-form (mock runner, not FE)' },
          timing: {},
          run,
        },
        readiness: { ready: true, reasons: [] },
        gates: [{ case: 'SM-01', target: 'K_t', value: cond ? 3 : null, ref: 3, unit: '1', tol: 1e-3, pass: cond ? true : 'unavailable' }],
      };
    }
    return { ok: false, study, stage: 'runner', message: `mock runner has no closed form for ${spec.id}/${study}` };
  }
}

export interface Fixture {
  registry: Registry;
  text: string;
  log: OpLog;
  memory: MemoryStore;
  backend: ReturnType<typeof memoryBackend>;
  nav: RecordingNavHost;
  runner: MockClosedFormRunner;
  session: AgentSession;
}

export async function fixture(sim: string, o: { text?: string; memory?: Record<string, string>; forbidden?: () => readonly string[]; sessionId?: string } = {}): Promise<Fixture> {
  const registry = wave1Registry();
  const text = o.text ?? simText(sim);
  const log = await createOpLog(text, { registry });
  const backend = memoryBackend(o.memory ?? {});
  const memory = await MemoryStore.open(backend, { ...(o.forbidden ? { forbidden: o.forbidden } : {}) });
  const nav = new RecordingNavHost({ mediaType: 'image/png', base64: 'iVBORw0KGgo=', width: 1, height: 1 });
  const runner = new MockClosedFormRunner(registry);
  const session = new AgentSession({ log, registry, memory, nav, runner, sessionId: o.sessionId ?? 'eval', ...(o.forbidden ? { forbidden: o.forbidden } : {}) });
  return { registry, text, log, memory, backend, nav, runner, session };
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
