// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of modes/vector-mode.mjs (port of eo-modulator-atlas engine/src/vector-mode.mjs at 0546007). Result
// records are left as `any` (EO shapes, see the JSDoc in the .mjs).
export interface KernelTriMesh { nNodes: number; nTris: number; tri: Int32Array; x: Float64Array; y: Float64Array; triRegion: Int32Array }
export interface VectorModelOptions {
  order?: 1 | 2;
  pecNodes?: Uint8Array;
  pecEdge?: (a: number, b: number) => boolean;
  dead?: Uint8Array;
  regionNames?: string[];
  factorization?: 'supernodal' | 'uplooking';
  ordering?: 'amd' | 'nd';
}
export interface SolveOptions {
  eps: Float64Array;
  epsIm?: Float64Array | null;
  epsG?: Float64Array | null;
  numModes?: number;
  nTarget?: number | null;
  tol?: number;
  blockSize?: number;
  maxBasis?: number | null;
  maxRestarts?: number;
  warm?: any;
  fields?: boolean;
  inertiaCheckN?: number | null;
  epsDelta?: Float64Array;
  epsDeltaGroup?: Float64Array;
  epsDeltaScale?: number;
  adaptiveShift?: boolean;
  shiftFromWarm?: boolean;
  refineSteps?: number;
  marginSides?: Array<'left' | 'right' | 'bottom' | 'top'>;
}
export const VECTOR_LABELS: readonly string[];
export function buildVectorModel(mesh: KernelTriMesh, opts?: VectorModelOptions): any;
export function materialTensors(model: any, opts: { eps: Float64Array; epsIm?: Float64Array | null; epsG?: Float64Array | null }): {
  eps: Float64Array; epsG: Float64Array; epsIm: Float64Array | null; nMax: number; indices: number[]; pairs: any; ngValid?: boolean;
};
export function assembleVector(model: any, epsT: Float64Array, k0: number, withConst?: boolean): { A: Float64Array; B: Float64Array };
export function solveVectorModes(model: any, lambdaUm: number, opts: SolveOptions): any;
export function vectorPerturbation(model: any, mode: any, dEpsT: Float64Array, lambdaUm: number): number;
export function selectVectorMode(result: any, polarization: 'TE' | 'TM', order?: number): any;
export const VECTOR_KERNELS: Readonly<Record<string, any>>;
