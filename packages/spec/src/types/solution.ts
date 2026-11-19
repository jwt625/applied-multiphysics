// SPDX-License-Identifier: GPL-3.0-or-later
// C5 solution and run record types (CONTRACTS-v0).

export type FieldSpace = 'H1P1' | 'H1P2' | 'NED1' | 'NED2' | 'DG0';

export interface FieldData {
  name: string; unit: string; space: FieldSpace; components: 1 | 2 | 3; data: Float64Array; step?: number;
  /** physics id of the field; set by the study driver on merged multiphysics solutions (C11) */
  physics?: string;
  /** derived H1 fields whose `data` is a nodal average of element values (stresses): the element values at the cell
   * nodes before averaging, index (cell * k + a) * components + j (k nodes per cell, VTK order), NaN for cells
   * outside the physics. Read by @amp/post for per-domain recovery and element-value integrals (DevLog-059). */
  elementNodal?: Float64Array;
  /** derived fields with `elementNodal`: constitutive group per cell (cells with equal values have the same material
   * constants, so the field is continuous between them; -1 outside the physics). @amp/post recovers per group at
   * interface nodes, and per geometric domain (cells.domain) when absent (DevLog-066). */
  cellGroup?: Int32Array;
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
  /** Linear solver of the run, machine-readable (additive to C5). Merged multiphysics: byPhysics per physics id. */
  solver?: SolverRecord & { byPhysics?: Record<string, SolverRecord> };
}

/** kind: 'direct' (sparse Cholesky / LDL^T), 'amg-pcg', 'ams-pcg'; rtol, iterations (max over the run's linear solves), residual (max achieved relative residual) are null for direct solves. */
export interface SolverRecord { kind: 'direct' | 'amg-pcg' | 'ams-pcg'; rtol: number | null; iterations: number | null; residual: number | null }

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
