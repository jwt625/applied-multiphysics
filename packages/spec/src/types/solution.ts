// SPDX-License-Identifier: GPL-3.0-or-later
// C5 solution and run record types (CONTRACTS-v0).

export type FieldSpace = 'H1P1' | 'H1P2' | 'NED1' | 'NED2' | 'DG0';

export interface FieldData {
  name: string; unit: string; space: FieldSpace; components: 1 | 2 | 3; data: Float64Array; step?: number;
  /** physics id of the field; set by the study driver on merged multiphysics solutions (C11) */
  physics?: string;
}

export interface Platform { runtime: 'node' | 'browser'; ua?: string; cores?: number; gpu?: string; crossOriginIsolated?: boolean }

export interface RunRecord {
  /** '@amp/physics@<version>+<git short sha or "dirty">' */
  engine: string;
  specHash: string;
  meshHash: string;
  /** ISO 8601 with offset. */
  startedAt: string;
  platform: Platform;
  fidelity: 'rigorous' | 'realtime';
  /** Head hash of the spec's operation log when the run started (optional, additive to C5; audit S2). */
  oplogHead?: string;
}

export interface Solution {
  meshHash: string;
  fields: FieldData[];
  steps?: { kind: 'time' | 'eigen' | 'freq' | 'param'; values: Float64Array; unit: string };
  /** Derived values, e.g. 'K_t', 'f_TM010'. */
  scalars: Record<string, { value: number; unit: string }>;
  stats: {
    dof: number; nnz?: number; iterations?: number; residual?: number; solver: string;
    /** per-physics stats of a merged multiphysics solution (C11) */
    byPhysics?: Record<string, { dof: number; nnz?: number; iterations?: number; residual?: number; solver: string }>;
  };
  /** ms per stage: geometry, mesh, assemble, factor, solve, post. */
  timing: Record<string, number>;
  run: RunRecord;
}
