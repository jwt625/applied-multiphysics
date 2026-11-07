// SPDX-License-Identifier: GPL-3.0-or-later
// Study execution seen from the agent. The host provides the runner: the workbench (L5) through its worker (C6),
// the eval harness (L8) in Node through @amp/physics. The agent never builds meshes or solves itself.

import type { RunRecord } from '@amp/spec';

/** Eval-gate status of one target (C8 result record subset). `pending` / `unavailable` are never shown as a pass. */
export interface GateStatus {
  case: string;
  target: string;
  value: number | null;
  ref: number | null;
  unit: string;
  tol: number | null;
  pass: boolean | 'pending' | 'unavailable';
}

export interface Readiness { ready: boolean; reasons: string[] }

/** What the agent sees of a solution: derived scalars, stats, timings, the run record. Never field arrays. */
export interface SolutionSummary {
  scalars: Record<string, { value: number; unit: string }>;
  stats: { dof: number; nnz?: number; iterations?: number; residual?: number; solver: string };
  timing: Record<string, number>;
  run: RunRecord;
  steps?: { kind: 'time' | 'eigen' | 'freq' | 'param'; values: number[]; unit: string };
}

export type StudyOutcome =
  | { ok: true; study: string; solution: SolutionSummary; readiness?: Readiness; gates?: GateStatus[] }
  | { ok: false; study: string; stage: string; message: string; readiness?: Readiness };

export interface StudyRunner {
  run(input: { specText: string; studyId: string; signal: AbortSignal; oplogHead: string }): Promise<StudyOutcome>;
}

/** Latest outcome per study (results store for get_run_record / get_results_summary). */
export class ResultsStore {
  private byStudy = new Map<string, { outcome: StudyOutcome; specHash: string; at: string }>();
  set(outcome: StudyOutcome, specHash: string, at: string): void { this.byStudy.set(outcome.study, { outcome, specHash, at }); }
  get(study?: string): { outcome: StudyOutcome; specHash: string; at: string } | undefined {
    if (study !== undefined) return this.byStudy.get(study);
    let last: { outcome: StudyOutcome; specHash: string; at: string } | undefined;
    for (const v of this.byStudy.values()) if (!last || v.at >= last.at) last = v;
    return last;
  }
  studies(): string[] { return [...this.byStudy.keys()]; }
}

/** Summarize a C5 Solution for the agent (drops field arrays). */
export function summarizeSolution(sol: { scalars: SolutionSummary['scalars']; stats: SolutionSummary['stats']; timing: SolutionSummary['timing']; run: RunRecord; steps?: { kind: 'time' | 'eigen' | 'freq' | 'param'; values: ArrayLike<number>; unit: string } }): SolutionSummary {
  return {
    scalars: sol.scalars, stats: sol.stats, timing: sol.timing, run: sol.run,
    ...(sol.steps ? { steps: { kind: sol.steps.kind, values: Array.from(sol.steps.values), unit: sol.steps.unit } } : {}),
  };
}
