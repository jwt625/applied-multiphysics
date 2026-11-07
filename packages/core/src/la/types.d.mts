// SPDX-License-Identifier: GPL-3.0-or-later
// Shared structural types of @amp/core linear algebra and FEM (hand-written 2026-11-06, audit S2). Declarations
// only; the shapes are those the ported .mjs modules create and read.

/** Symmetric CSR pattern, full storage (both triangles, diagonal present), rows sorted ascending. */
export interface CsrPattern { n: number; rowptr: Int32Array; colidx: Int32Array; nnz: number }
/** Real CSR matrix (pattern + values), as used by amg.mjs. */
export interface CsrMatrix extends CsrPattern { val: Float64Array }
/** Complex vector as split real / imaginary parts. */
export interface ComplexVector { re: Float64Array; im: Float64Array }

/** Result of sparse.analyze: fill-reducing permutation, elimination tree, supernodes (supernodal Cholesky / LDL^T). */
export interface SymbolicAnalysis {
  n: number; perm: Int32Array; pinv: Int32Array; parent: Int32Array; colCount: Int32Array;
  nnzL: number; nnzA: number; fill: number; flops: number;
  lowerP: Int32Array; lowerI: Int32Array; lowerSrc: Int32Array;
  nsuper: number; superStart: Int32Array; colSuper: Int32Array; superParent: Int32Array; childHead: Int32Array; childNext: Int32Array;
  Sp: Int32Array; Si: Int32Array; Lxp: Float64Array; nnzLStored: number; maxFront: number; patternKey: string;
  timing: { ordering_ms: number; symbolic_ms: number };
}
export interface AnalyzeOptions { perm?: Int32Array; ordering?: 'amd' | 'nd'; x?: Float64Array; y?: Float64Array; relax?: boolean }
/** Numeric supernodal Cholesky factor (sparse.factorNumeric). */
export interface NumericFactor { sym: SymbolicAnalysis; Lx: Float64Array; ok: boolean; work: unknown; /** front kernel used ('blocked' | 'wasm', DevLog-016) */ kernel?: 'blocked' | 'wasm' }

/** Result of an LDL^T factorization: inertia and static pivot perturbations (nNeg absent for complex factors). */
export interface LdltFactorResult { ok: boolean; nNeg?: number; nPerturbed: number; ms: number }

/** 27-point scalar stencil operator on an NX x NY x NZ node grid (stencil.createStencil). */
export interface StencilOp {
  NX: number; NY: number; NZ: number; N: number;
  /** A[27 n + s], s = slot(di, dj, dk); s = 13 is the diagonal. */
  A: Float64Array;
  /** 1 = identity row (inactive or Dirichlet node). */
  fixed: Uint8Array;
  off: Int32Array;
  pad: number;
  bs?: 1;
}
/** 3-DOF block stencil operator (block.createBlockStencil); A[(27 n + s) 9 + 3 r + c]. */
export interface BlockStencilOp { bs: number; NX: number; NY: number; NZ: number; N: number; A: Float64Array; fixed: Uint8Array; off: Int32Array; pad: number }

/** Preconditioner z = M^-1 r on padded vectors. */
export type Precond = (r: Float64Array, z: Float64Array) => void;

/** Triangle mesh in the shape the 2D FEM modules read (EO / APA em2d mesh). Coordinates: see each module. */
export interface TriMesh { nNodes: number; nTris: number; x: Float64Array; y: Float64Array; tri: Int32Array; [extra: string]: unknown }
/** Per-triangle geometry: signed area and P1 shape-function gradients (3 per triangle). */
export interface TriGeometry { area: Float64Array; gx: Float64Array; gy: Float64Array }

/**
 * Tetrahedral mesh for the H(curl) modules (APA em3d mesh shape; DevLog-002 contract request 3). nodes in metres,
 * 4 vertex indices per tet sorted ascending (required by the hierarchical basis), edges with local pairs
 * 01 02 03 12 13 23.
 */
export interface HcurlTetMesh {
  nodes: Float64Array; nNodes: number; tets: Int32Array; nTets: number;
  edges: Int32Array; nEdges: number; tetEdges: Int32Array;
  edgeIndex(a: number, b: number): number | undefined;
  tetSolid?: Int32Array;
}
/** Diagonal complex material tensor {re: [xx, yy, zz], im: [xx, yy, zz]}. */
export interface DiagComplexTensor { re: ArrayLike<number>; im: ArrayLike<number> }
