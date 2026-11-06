// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/core entry: one namespace per module (names such as gmres and spmv exist in several modules). Subpath imports
// (`@amp/core/units`, `@amp/core/la/sparse`, ...) load a single module; see package.json exports and DevLog-002.
export * as units from './units.mjs';
export * as expr from './expr.mjs';
export * as params from './params.mjs';
export * as sweep from './sweep.mjs';
export * as sparse from './la/sparse.mjs';
export * as ldlt from './la/ldlt.mjs';
export * as ldltBlocked from './la/ldlt-blocked.mjs';
export * as ldltWasm from './la/ldlt-wasm.mjs';
export * as ldltSelect from './la/ldlt-select.mjs';
export * as complex from './la/complex.mjs';
export * as dense from './la/dense.mjs';
export * as vectorDense from './la/vector-dense.mjs';
export * as arnoldi from './la/arnoldi.mjs';
export * as gmresReal from './la/gmres-real.mjs';
export * as krylov from './la/krylov.mjs';
export * as stencil from './la/stencil.mjs';
export * as mg from './la/mg.mjs';
export * as block from './la/block.mjs';
export * as halfmg from './la/halfmg.mjs';
export * as pcg from './la/pcg.mjs';
export * as amg from './la/amg.mjs';
export * as ams from './la/ams.mjs';
export * as pmg from './la/pmg.mjs';
export * as order3d from './la/order3d.mjs';
export * as wasmEncoder from './la/wasm/encoder.mjs';
export * as wasmKernels from './la/wasm/kernels.mjs';
export * as wasmAccel from './la/wasm/accel.mjs';
export * as femTri from './fem/tri.mjs';
export * as femTriFe from './fem/tri-fe.mjs';
export * as femQ1Grid from './fem/q1-grid.mjs';
export * as hcurl from './fem/hcurl.mjs';
export * as nedelec1 from './fem/nedelec1.mjs';
export * as hcurlSpace from './fem/space.mjs';
export * as quadrature from './fem/quadrature.mjs';
