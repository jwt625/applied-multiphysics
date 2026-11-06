// SPDX-License-Identifier: GPL-3.0-or-later
// A source produces observations for the targets of a case: the engine (physics registry), the expected-JSON
// self-check, or an external Python reference.

import type { LoadedCase } from './loader.ts';
import type { TargetObservation } from './evaluate.ts';
import type { RunRecord } from './contract-shim.ts';

export interface SpeedRecord {
  level: number;
  dof: number | null;
  warmup_ms: number[];
  samples_ms: number[];
  median_ms: number;
  mad_ms: number;
  stages_median_ms: Record<string, number>;
  iterations: number | null;
  budget_s?: number;
  meets_budget?: boolean | null;   // only at a level that meets the tolerance (R3 s.5.3 item 5)
}

export type CaseObservation =
  | { kind: 'pending'; reason: string }
  | { kind: 'error'; reason: string }
  | {
      kind: 'observed';
      targets: Record<string, TargetObservation | { pending: string } | { error: string }>;
      run: RunRecord | Record<string, unknown>;
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
  plan(lc: LoadedCase): Promise<{ runnable: boolean; reason: string }>;
  observe(lc: LoadedCase, opts: ObserveOptions): Promise<CaseObservation>;
}

export function dimOf(dimension: string | string[] | undefined): number | undefined {
  const d = Array.isArray(dimension) ? dimension[0] : dimension;
  if (!d) return undefined;
  const m = /^([0-3])D/.exec(d);
  return m ? Number(m[1]) : undefined;
}
