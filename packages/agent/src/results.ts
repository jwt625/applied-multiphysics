// SPDX-License-Identifier: GPL-3.0-or-later
// Results values seen from the agent (lane R3, DevLog-028; DevLog-023 s.3.6). The host evaluates: the workbench through
// its post worker (apps/web results/api.ts), the task suite and the eval harness in Node through the same adapter
// (@amp/post kernels). The agent never computes values itself, and these calls change nothing: edits to results nodes
// go through apply_ops like every other edit. Values are session memory only (no export, DevLog-023 s.5.1).

/** One evaluated table, as the host returns it (JSON; values in the column units, null = not evaluated). */
export interface ResultsTableJson {
  id: string;
  group: string;
  label: string;
  orient: 'rows' | 'columns';
  columns: Array<{ key: string; name: string; unit: string; kind: string; item?: string; type?: string; expr?: string; point?: number[]; tip: string }>;
  rows: Array<{ cells: Array<number | string | null>; meta: Array<object | null>; errors: Array<string | null>; run: string; step: number }>;
  errors: string[];
  hash: string;
  runs: string[];
}

/** An expression on the points of a line / point dataset (values in `unit`). */
export interface DatasetValuesJson {
  id: string;
  type: string;
  dim: number;
  n: number;
  points: number[][];
  s?: number[];
  length?: number;
  covered?: number;
  values: number[] | null;
  unit: string;
  continuous: boolean;
  outside: number[];
  step: number;
  stepValue: number | null;
  stepUnit: string | null;
  error?: string;
}

/** Ad hoc evaluation: the same path as a spec evaluation item; a temporary cut line (from / to) or cut points. */
export interface AdhocEvaluation {
  data: string;
  kind: 'point' | 'global' | 'integral' | 'average' | 'max' | 'min' | 'measure';
  expr?: string;
  unit?: string;
  over?: string[];
  method?: 'nodal' | 'quad' | 'points' | 'lattice';
  from?: unknown[];
  to?: unknown[];
  n?: number;
  points?: unknown[][];
  steps?: unknown;
}

/** Evaluated over the host's latest solution of the item's root study; stale = that solution is of an older spec. */
export interface HostAnswer<T> { value: T; stale: boolean; study: string | null }

export interface ResultsHost {
  /** Table of an evaluation group or a table node (the group of an item when `id` is an item). */
  table(id: string): Promise<HostAnswer<ResultsTableJson>>;
  /** Points / arc length of a dataset and an expression there (`expr` null: points only). */
  dataset(id: string, expr: string | null, o: { unit?: string; step?: number | 'last' | 'first' }): Promise<HostAnswer<DatasetValuesJson>>;
  /** Ad hoc evaluation (nothing stored). */
  adhoc(q: AdhocEvaluation): Promise<HostAnswer<ResultsTableJson>>;
}
