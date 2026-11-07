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
  levels: LevelTimingSummary[];
  budget_s?: number;               // native budget; the browser budget belongs to the browser runner (audit S6)
  budget_note?: string;
  t_tol_ms?: number | null;        // time to reach every gated tolerance (cumulative over levels for richardson)
  meets_budget?: boolean | null;   // null when pending (no native budget, or a gated target not passing)
}

export type CaseObservation =
  | { kind: 'pending'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'timeout'; reason: string }
  | {
      kind: 'observed';
      targets: Record<string, TargetObservation | { pending: string } | { error: string }>;
      run: RunRecord | Record<string, unknown>;
      levelRuns?: Array<{ level: number; dof: number; meshHash: string; wall_ms: number }>;
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
