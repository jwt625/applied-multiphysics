// SPDX-License-Identifier: GPL-3.0-or-later
// A source produces observations for the targets of a case: the engine (physics registry), the expected-JSON
// self-check, or an external Python reference.

import type { LoadedCase } from './loader.ts';
import type { TargetObservation } from './evaluate.ts';
import type { RunRecord } from './contract-shim.ts';

export interface LevelTimingSummary {
  level: number;
  dof: number | null;
  warmup_ms: number[];
  samples_ms: number[];
  median_ms: number;
  mad_ms: number;
  stages_median_ms: Record<string, number>;
  iterations: number | null;
}

/** --speed: 1 warm-up + median of 5 at every mesh level (audit S5; protocol recorded). */
export interface SpeedRecord {
  protocol: 'warmup1_median5_per_level';
  timing: 'warm';                   // `levels` are warm medians (M2 audit S2); cold numbers are in the *_cold fields
  mesh_cache_note?: string;
  levels: LevelTimingSummary[];
  budget_s?: number;               // native budget; the browser budget belongs to the browser runner (audit S6)
  budget_note?: string;
  t_tol_cold_ms?: number | null;   // cold end to end (first call per level, meshing included): the budget check uses this
  t_tol_warm_ms?: number | null;   // warm medians, informative only
  case_wall_cold_ms?: number;      // worker spawn to result, all levels (cold)
  meets_budget?: boolean | null;   // cold T_tol vs budget_s.native; null when pending
}

export type CaseObservation =
  | { kind: 'pending'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'timeout'; reason: string }
  | {
      kind: 'observed';
      targets: Record<string, TargetObservation | { pending: string } | { error: string } | { timeout: string }>;
      run: RunRecord | Record<string, unknown>;
      levelRuns?: Array<{ level: number; timing?: 'cold'; dof: number; meshHash: string; wall_ms: number; prepare_ms?: number; run_ms?: number; spec?: string; informative?: boolean }>;
      caseWallColdMs?: number;          // cold wall of the groups with a gated target (the timed gate)
      informativeWallColdMs?: number;   // cold wall of informative-only groups (gate: false), reported apart
      dim?: number;
      speed?: SpeedRecord;
    };

export interface ObserveOptions {
  speed?: boolean;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface Source {
  name: string;
  describe(): string;
  /** What would happen for this case without running it (dry run). */
  plan(lc: LoadedCase): Promise<{ runnable: boolean; reason: string; error?: boolean }>;
  observe(lc: LoadedCase, opts: ObserveOptions): Promise<CaseObservation>;
}

export function dimOf(dimension: string | string[] | undefined): number | undefined {
  const d = Array.isArray(dimension) ? dimension[0] : dimension;
  if (!d) return undefined;
  const m = /^([0-3])D/.exec(d);
  return m ? Number(m[1]) : undefined;
}
