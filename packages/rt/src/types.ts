// SPDX-License-Identifier: GPL-3.0-or-later
// Local copy of CONTRACTS-v0 C9 (RealtimeKernel) plus the L6 optional additions.
// Delete the C9 part once @amp/spec publishes packages/spec/src/types/ (contracts preamble).

export interface Grid {
  nx: number;
  ny: number;
  nz?: number;
  /** cell size in metres (FDTD, LBM) or in model length units (Gray-Scott, The Well domain [-1, 1]) */
  dx: number;
}

export interface KernelView {
  texture?: GPUTexture;
  buffer?: GPUBuffer;
  unit: string;
  range: [number, number];
}

/** CONTRACTS-v0 C9. */
export interface RealtimeKernel {
  id: string;
  fidelity: "realtime";
  init(device: GPUDevice, params: Record<string, number>, grid: Grid): Promise<void>;
  /** encodes n steps into the queue */
  step(n: number): void;
  view(): KernelView;
  /** used by eval gates */
  readback(name: string): Promise<Float32Array>;
  dispose(): void;
}

/** One selectable view of a kernel (L6 addition). */
export interface ViewSpec {
  id: string;
  label: string;
  unit: string;
  /** colormap family: sequential (viridis) or diverging (balance) */
  map: "viridis" | "balance";
}

/** Canvas paint operation in cell coordinates (L6 addition). */
export interface PaintOp {
  tool: string;
  shape: "disc" | "rect" | "line";
  x0: number;
  y0: number;
  x1?: number;
  y1?: number;
  /** radius (disc) or half-width (line), cells */
  r?: number;
  value?: number;
}

export interface KernelInfo {
  /** bytes of GPU buffers allocated by this kernel, computed from buffer sizes */
  gpuBytes: number;
  /** lattice cells updated per step */
  cellsPerStep: number;
  steps: number;
}

/** C9 plus optional members used by the demo and the gates. */
export interface RealtimeKernelExt extends RealtimeKernel {
  readonly grid: Grid;
  views(): ViewSpec[];
  setView(id: string): void;
  setParams(p: Record<string, number>): void;
  paint(op: PaintOp): void;
  /** u32 per cell: material class for the renderer overlay (0 = none) */
  overlay(): GPUBuffer;
  info(): KernelInfo;
}
