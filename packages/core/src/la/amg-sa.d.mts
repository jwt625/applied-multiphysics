// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/amg-sa.mjs (lane G3, DevLog-060).
export interface CsrValues { n: number; m?: number; rowptr: Int32Array; colidx: Int32Array; val: Float64Array }
/** C = A B (CSR), typed arrays, rows sorted. */
export function csrMatMatTyped(A: CsrValues, B: CsrValues): Required<CsrValues>;
/** Transpose of a CSR matrix. */
export function csrTransposeTyped(A: CsrValues): Required<CsrValues>;
/** Rigid-body near-nullspace of a node-blocked system (rows inv[i] = node * dim + component, coordinates X). */
export function rigidBodyModes(inv: Int32Array, X: ArrayLike<number>, dim: number): { nodeOf: Int32Array; nNodes: number; B: Float64Array; nB: number };
/** Smoothed-aggregation AMG with a near-nullspace B (n x nB) over nodes nodeOf; cycle(b, x) applies one V-cycle. */
export function buildAMGSA(A: { n: number; rowptr: Int32Array; colidx: Int32Array; val: Float64Array }, o: {
  nodeOf: Int32Array; nNodes?: number; B: Float64Array; nB: number;
  theta?: number; coarseMax?: number; maxLevels?: number; sweeps?: number; dropTol?: number;
  /** 'error' (default): throw for a singular (under-constrained) system detected on the dense coarsest level */
  singular?: 'error' | 'allow';
}): { levels: { n: number; nnz: number }[]; cycle: (b: Float64Array, x: Float64Array) => void; coarse: AMGCoarseInfo | null };
/** Dense coarsest level: unknowns, smallest pivot / original diagonal, pivots <= SINGULAR_PIVOT_RATIO x diagonal. */
export interface AMGCoarseInfo { n: number; minPivotRatio: number; nSmall: number }
/** Coarsest-level pivot ratio at or below which the system is reported as singular (DevLog-066). */
export const SINGULAR_PIVOT_RATIO: number;
/** Two-level multigrid: Gauss-Seidel on A, coarse correction through P with coarse(P^T A P) (e.g. buildAMGSA). */
export function buildTwoLevel(A: { n: number; rowptr: Int32Array; colidx: Int32Array; val: Float64Array }, P: { n: number; m: number; rowptr: Int32Array; colidx: Int32Array; val: Float64Array },
  coarse: (Ac: { n: number; rowptr: Int32Array; colidx: Int32Array; val: Float64Array }) => { levels: { n: number; nnz: number }[]; cycle: (b: Float64Array, x: Float64Array) => void },
  o?: { sweeps?: number }): { levels: { n: number; nnz: number }[]; cycle: (b: Float64Array, x: Float64Array) => void; coarse: AMGCoarseInfo | null };
