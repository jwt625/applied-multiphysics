// SPDX-License-Identifier: GPL-3.0-or-later
// C5 Solution builder: per-stage wall-clock timing, run record (engine, spec hash, mesh hash, ISO start time, platform,
// fidelity) via the @amp/spec run-record helpers (DevLog-001 A5).

import { engineString, isoNow, makeRunRecord, probePlatform, specHash } from '@amp/spec';
import type { FieldData, Mesh, Solution } from '@amp/spec/types';

export const PHYSICS_VERSION = '0.0.1';
/** Lanes run no git, so the build sha is unknown here: C5 says "dirty" then. */
export const ENGINE = engineString('@amp/physics', PHYSICS_VERSION, null);

export class StageTimer {
  timing: Record<string, number> = {};
  private t0 = new Map<string, number>();
  readonly startedAt = isoNow();
  start(stage: string): void { this.t0.set(stage, performance.now()); }
  stop(stage: string): number {
    const t = this.t0.get(stage);
    if (t === undefined) throw new Error(`stage '${stage}' not started`);
    this.t0.delete(stage);
    const dt = performance.now() - t;
    this.timing[stage] = (this.timing[stage] ?? 0) + dt;
    return dt;
  }
  /** Run fn as stage `stage` (synchronous). */
  time<T>(stage: string, fn: () => T): T {
    this.start(stage);
    try { return fn(); } finally { this.stop(stage); }
  }
  /** Add an externally measured duration (ms). */
  add(stage: string, ms: number): void { this.timing[stage] = (this.timing[stage] ?? 0) + ms; }
}

export interface SolutionParts {
  mesh: Pick<Mesh, 'hash'>;
  /** the spec the run came from (hashed canonically); else specHash, else the hash of `problemDigest` */
  spec?: unknown;
  specHash?: string;
  /** stand-in for programmatic runs without a spec: a JSON-able description of the problem */
  problemDigest?: unknown;
  fields: FieldData[];
  steps?: Solution['steps'];
  scalars?: Solution['scalars'];
  stats: Solution['stats'];
  timer: StageTimer;
  fidelity?: 'rigorous' | 'realtime';
}

export async function makeSolution(p: SolutionParts): Promise<Solution> {
  const h = p.specHash ?? (p.spec !== undefined ? await specHash(p.spec) : await specHash(p.problemDigest ?? { programmatic: true }));
  const run = await makeRunRecord({
    engine: ENGINE, specHash: h, meshHash: p.mesh.hash, fidelity: p.fidelity ?? 'rigorous',
    startedAt: p.timer.startedAt, platform: probePlatform(),
  });
  return {
    meshHash: p.mesh.hash,
    fields: p.fields,
    ...(p.steps ? { steps: p.steps } : {}),
    scalars: p.scalars ?? {},
    stats: p.stats,
    timing: { ...p.timer.timing },
    run,
  };
}

export const scalar = (value: number, unit: string) => ({ value, unit });

/** Throw if the run was cancelled (C4 signal). */
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('run cancelled');
}
