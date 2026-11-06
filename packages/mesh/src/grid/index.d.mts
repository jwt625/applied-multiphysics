// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations for index.mjs (ported from advanced-packaging-atlas/engine/src/grid/index.mjs at fe39985).
export interface GridPart {
  id: string; kind?: string; material?: string; x_mm: number; y_mm: number; w_mm: number; d_mm: number; z_um: number; h_um: number;
  priority?: number; in?: string;
}
export interface GridSelection { groups: Array<{ axis: string; side: string; cells: Int32Array }>; area_m2: number; faces: number }
export interface Grid {
  xs: Float64Array; ys: Float64Array; zs: Float64Array; nx: number; ny: number; nz: number;
  cellPart: Int32Array; cellMat: Int32Array; parts: GridPart[]; materials: string[]; partMat: Int32Array;
  partRange: Int32Array; partCells: Int32Array; priority: number[]; symmetry: string; symFactor: number;
  selections: Record<string, GridSelection>; warnings: string[]; stats: Record<string, unknown>;
}
export const SYMMETRIES: readonly string[];
export function buildGrid(parts: GridPart[], opt?: {
  max_xy_mm?: number; max_z_mm?: number | null; min_cells_per_layer?: number; grading?: number; max_nodes?: number;
  symmetry?: string; drop_kinds?: string[]; materialOf?: (p: GridPart) => string; snap_xy_um?: number; snap_z_um?: number;
  planes?: { x_mm?: number[]; y_mm?: number[]; z_um?: number[] }; interfaces?: Array<[string, string]>;
}): Grid;
export function activeNodes(grid: Grid): Uint8Array;
export function resolveSelection(grid: Grid, name: string): GridSelection | null;
