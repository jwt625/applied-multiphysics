// SPDX-License-Identifier: GPL-3.0-or-later
// L1 additions (audit 2026-11-06 S1 / S3): core-suite tests for modules whose only coverage was the atlas redirect run:
// fem/space, fem/tri-fe, la/pmg, la/ams, la/wasm/kernels and the index exports. No atlas code; meshes from
// helpers/tet-grid.mjs and helpers/tri-grid.mjs. References: closed forms (area of the unit square, Euler
// characteristic of a box complex, DOF counts of the order-1 / order-2 Nedelec spaces), the direct LDL^T solution
// (iterative = direct, as APA DevLog-014 G4) and the JS stencil apply (WASM kernel).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildElementPattern, elementSlots, analyze } from '../src/la/sparse.mjs';
import { ComplexSupernodalLDLT } from '../src/la/ldlt.mjs';
import { gmres } from '../src/la/krylov.mjs';
import { preparePMG, buildPMG } from '../src/la/pmg.mjs';
import { buildAMS } from '../src/la/ams.mjs';
import { levelKernels } from '../src/la/wasm/kernels.mjs';
import { simdSupported } from '../src/la/wasm/encoder.mjs';
import { createStencil, padded, applyStencil } from '../src/la/stencil.mjs';
import { buildSpace, buildFaces } from '../src/fem/space.mjs';
import { tetGeometry } from '../src/fem/nedelec1.mjs';
import { tetMatricesP } from '../src/fem/hcurl.mjs';
import { p1Space, p2Space, triangleGeometry, elementMass, elementLoad, assembleByTag, restrictPattern, UM } from '../src/fem/tri-fe.mjs';
import * as core from '../src/index.mjs';
import * as sparseMod from '../src/la/sparse.mjs';
import * as unitsMod from '../src/units.mjs';
import { tetBox } from './helpers/tet-grid.mjs';
import { lines, triGrid } from './helpers/tri-grid.mjs';

// ---- fem/tri-fe: explicit length scale (S1) ----
test('tri-fe: integral of 1 over the unit square in metres = 1 m^2 (P1, P2; mass and load); um mesh with lengthScale UM', () => {
  for (const [scale, L] of [[1, 1], [UM, 1e6]]) {
    const mesh = triGrid(lines([0, L], L / 5), lines([0, L], L / 4));
    const geo = triangleGeometry(mesh);
    for (const space of [p1Space(mesh), p2Space(mesh)]) {
      const k = space.k, Me = new Float64Array(k * k), fe = new Float64Array(k);
      let m = 0, l = 0;
      for (let t = 0; t < mesh.nTris; t++) {
        elementMass(space, geo, t, Me, scale);
        elementLoad(space, geo, t, fe, scale);
        for (const v of Me) m += v;
        for (const v of fe) l += v;
      }
      assert.ok(Math.abs(m - 1) < 1e-12 && Math.abs(l - 1) < 1e-12, `${space.kind} scale ${scale}: mass ${m}, load ${l}`);
      const { M } = assembleByTag(space, geo, new Int32Array(mesh.nTris), 1, { stiffness: false, mass: true, lengthScale: scale });
      assert.ok(Math.abs(M[0].reduce((s, v) => s + v, 0) - 1) < 1e-12);
    }
  }
  // default is SI: a mesh in metres needs no option
  const mesh = triGrid(lines([0, 1], 0.25), lines([0, 1], 0.25)), sp = p1Space(mesh), geo = triangleGeometry(mesh), fe = new Float64Array(3);
  let l = 0;
  for (let t = 0; t < mesh.nTris; t++) { elementLoad(sp, geo, t, fe); l += fe[0] + fe[1] + fe[2]; }
  assert.ok(Math.abs(l - 1) < 1e-12);
});

// ---- fem/space ----
test('space: order-1 / order-2 DOF counts, Euler characteristic of the box complex, tet DOF ranges', () => {
  const mesh = tetBox(3, 2, 2, [1, 0.8, 0.6]);
  const F = buildFaces(mesh);
  assert.equal(mesh.nNodes - mesh.nEdges + F.nFaces - mesh.nTets, 1);
  const s1 = buildSpace(mesh, 1), s2 = buildSpace(mesh, 2);
  assert.equal(s1.nDof, mesh.nEdges);
  assert.equal(s2.nDof, 2 * mesh.nEdges + 2 * F.nFaces);
  assert.equal(s2.ndt, 20);
  for (let q = 0; q < s2.tetDofs.length; q++) assert.ok(s2.tetDofs[q] >= 0 && s2.tetDofs[q] < s2.nDof);
  // every DOF is used by some tet; face DOFs of a tet face agree with faceDofs()
  const used = new Uint8Array(s2.nDof);
  for (const d of s2.tetDofs) used[d] = 1;
  assert.equal(used.reduce((a, b) => a + b, 0), s2.nDof);
  const v = [0, 1, 2].map((i) => mesh.tets[i]);
  const fd = s2.faceDofs(v);
  assert.equal(fd.length, 8);
  assert.ok(fd.every((d) => s2.tetDofs.subarray(0, 20).includes(d)));
  const p = s2.dofPoint(0, new Float64Array(3));
  const [a, b] = [mesh.edges[0], mesh.edges[1]];
  for (let d = 0; d < 3; d++) assert.ok(Math.abs(p[d] - 0.5 * (mesh.nodes[3 * a + d] + mesh.nodes[3 * b + d])) < 1e-15);
});

/** Order-2 system A = S - k2 M (eps complex) on the free DOFs of a PEC box, in the layout of APA em3d prepare3d. */
function pecSystem(mesh, k2, eps) {
  const space = buildSpace(mesh, 2), nE = mesh.nEdges, ndt = 20;
  const pat = buildElementPattern(space.nDof, space.tetDofs, ndt);
  const dirichlet = new Uint8Array(space.nDof);
  const onB = (a, b, c = a) => mesh.boundaryNode[a] && mesh.boundaryNode[b] && mesh.boundaryNode[c] &&
    [0, 1, 2].some((d) => { const xs = [a, b, c].map((n) => mesh.nodes[3 * n + d]); const L = Math.max(...Array.from({ length: mesh.nNodes }, (_, n) => mesh.nodes[3 * n + d])); return xs.every((x) => x === 0) || xs.every((x) => x === L); });
  for (let e = 0; e < nE; e++) if (onB(mesh.edges[2 * e], mesh.edges[2 * e + 1])) dirichlet[e] = dirichlet[nE + e] = 1;
  for (let f = 0; f < space.nFaces; f++) if (onB(space.faces[3 * f], space.faces[3 * f + 1], space.faces[3 * f + 2])) dirichlet[2 * nE + 2 * f] = dirichlet[2 * nE + 2 * f + 1] = 1;
  const free = Uint8Array.from(dirichlet, (x) => 1 - x);
  const R = restrictPattern(pat, free);
  const fre = new Float64Array(pat.nnz), fim = new Float64Array(pat.nnz);
  const slots = elementSlots(pat, space.tetDofs, ndt);
  const g = new Float64Array(12), Sre = new Float64Array(400), Sim = new Float64Array(400), Mre = new Float64Array(400), Mim = new Float64Array(400);
  const nu = { re: [1, 1, 1], im: [0, 0, 0] }, ep = { re: [eps[0], eps[0], eps[0]], im: [eps[1], eps[1], eps[1]] };
  for (let t = 0; t < mesh.nTets; t++) {
    const V = tetGeometry(mesh.nodes, mesh.tets.subarray(4 * t, 4 * t + 4), g);
    tetMatricesP(2, g, V, nu, ep, Sre, Sim, Mre, Mim);
    for (let q = 0; q < 400; q++) { const s = slots[400 * t + q]; fre[s] += Sre[q] - k2 * Mre[q]; fim[s] += Sim[q] - k2 * Mim[q]; }
  }
  const re = Float64Array.from(R.src, (s) => fre[s]), im = Float64Array.from(R.src, (s) => fim[s]);
  const inDomain = new Uint8Array(2 * nE).fill(1);
  return { space, R, re, im, P: { order: 2, R, space, mesh, solidProps: [], inDomain, dirichlet } };
}
const cmv = (pat, re, im) => (xr, xi, yr, yi) => {
  for (let i = 0; i < pat.n; i++) {
    let sr = 0, si = 0;
    for (let q = pat.rowptr[i]; q < pat.rowptr[i + 1]; q++) { const j = pat.colidx[q]; sr += re[q] * xr[j] - im[q] * xi[j]; si += re[q] * xi[j] + im[q] * xr[j]; }
    yr[i] = sr; yi[i] = si;
  }
};

// ---- la/pmg (+ krylov, space, hcurl) ----
test('pmg: GMRES + p-multigrid equals the direct complex LDL^T on an order-2 PEC box (iterative = direct)', () => {
  const mesh = tetBox(4, 3, 3, [1, 0.8, 0.6]);
  const k2 = 0.7 * Math.PI ** 2 * (1 + 1 / 0.64); // below the lowest box mode k^2 = pi^2 (1/a^2 + 1/b^2)
  const { R, re, im, P } = pecSystem(mesh, k2, [1, -0.05]);
  const PM = preparePMG(P, { ordering: 'amd' });
  PM.fpat = R.pat;
  assert.ok(PM.nc > 0 && PM.nc < PM.nf && PM.na > 0);
  const pmg = buildPMG(PM, re, im, { cols: [], blocks: [] }, { factor: 'blocked', smooth: 2, auxSmooth: 1 });
  const n = R.nf;
  const br = Float64Array.from({ length: n }, (_, i) => Math.sin(0.37 * i)), bi = Float64Array.from({ length: n }, (_, i) => 0.1 * Math.cos(0.11 * i));
  const it = gmres(pmg.applyA, pmg.apply, br, bi, { rtol: 1e-10, maxIter: 200, restart: 30 });
  const fac = new ComplexSupernodalLDLT(analyze(R.pat));
  assert.ok(fac.factor(re, im).ok);
  const x = fac.solve(br, bi);
  let d = 0, m = 0;
  for (let i = 0; i < n; i++) { d = Math.max(d, Math.hypot(it.re[i] - x.re[i], it.im[i] - x.im[i])); m = Math.max(m, Math.hypot(x.re[i], x.im[i])); }
  assert.ok(it.converged, `relres ${it.relres}`);
  assert.ok(it.iterations <= 60, `iterations ${it.iterations}`);
  assert.ok(d / m < 1e-8, `iterative vs direct ${d / m}`);
  // the operator of the preconditioner is the system matrix
  const yr = new Float64Array(n), yi = new Float64Array(n), zr = new Float64Array(n), zi = new Float64Array(n);
  pmg.applyA(br, bi, yr, yi);
  cmv(R.pat, re, im)(br, bi, zr, zi);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(yr[i] - zr[i]) + Math.abs(yi[i] - zi[i]) < 1e-9 * (Math.abs(zr[i]) + Math.abs(zi[i]) + 1));
});

// ---- la/ams (not wired in APA; construct + apply as a preconditioner) ----
test('ams: constructs on the order-1 level of the PEC box and preconditions GMRES on a shifted curl-curl system', () => {
  const mesh = tetBox(4, 3, 3, [1, 0.8, 0.6]);
  const { R, re, im, P } = pecSystem(mesh, -1, [1, 0.02]); // S + M (positive definite real part)
  const PM = preparePMG(P, { ordering: 'amd' });
  const { cpat, cSrc, nc, G } = PM;
  const cre = Float64Array.from(cSrc, (q) => re[q]), cim = Float64Array.from(cSrc, (q) => im[q]);
  const cdiag = new Int32Array(nc);
  for (let i = 0; i < nc; i++) for (let q = cpat.rowptr[i]; q < cpat.rowptr[i + 1]; q++) if (cpat.colidx[q] === i) cdiag[i] = q;
  // order-1 discrete gradient = the Whitney rows of PM.G (vertex columns come first in the auxiliary numbering)
  let nv = 0;
  for (let q = 0; q < G.rowptr[nc]; q++) nv = Math.max(nv, G.colidx[q] + 1);
  const G1 = { n: nc, m: nv, rowptr: G.rowptr.slice(0, nc + 1), colidx: G.colidx.slice(0, G.rowptr[nc]), val: G.val.slice(0, G.rowptr[nc]) };
  // nodal interpolation Pi_d: Whitney DOF of edge (a, b) of a nodal field v: 0.5 (v_a + v_b) . (x_b - x_a)
  const edgeOfRow = new Int32Array(nc);
  for (let e = 0; e < mesh.nEdges; e++) if (R.map[e] >= 0) edgeOfRow[R.map[e]] = e;
  const Pis = [0, 1, 2].map((d) => {
    const rowptr = new Int32Array(nc + 1), cols = [], vals = [];
    for (let i = 0; i < nc; i++) {
      const e = edgeOfRow[i];
      const a = mesh.edges[2 * e], b = mesh.edges[2 * e + 1], h = mesh.nodes[3 * b + d] - mesh.nodes[3 * a + d];
      const ent = [];
      for (let p = G1.rowptr[i]; p < G1.rowptr[i + 1]; p++) ent.push([G1.colidx[p], 0.5 * h]);
      ent.sort((x, y) => x[0] - y[0]);
      for (const [c, v] of ent) { cols.push(c); vals.push(v); }
      rowptr[i + 1] = cols.length;
    }
    return { n: nc, m: nv, rowptr, colidx: Int32Array.from(cols), val: Float64Array.from(vals) };
  });
  const ams = buildAMS({ cpat, cre, cim, apc: cre, cdiag, G1, Pis, smooth: 1 });
  assert.equal(ams.stats.aux.length, 4);
  const br = Float64Array.from({ length: nc }, (_, i) => Math.sin(0.3 * i) + 0.2), bi = new Float64Array(nc);
  const xr = new Float64Array(nc), xi = new Float64Array(nc);
  ams.apply(br, bi, xr, xi);
  assert.ok(xr.every(Number.isFinite) && xi.every(Number.isFinite) && xr.some((v) => v !== 0));
  const op = cmv(cpat, cre, cim);
  const plain = gmres(op, null, br, bi, { rtol: 1e-8, maxIter: 1000, restart: 50 });
  const pre = gmres(op, (rr, ri, zr, zi) => ams.apply(rr, ri, zr, zi), br, bi, { rtol: 1e-8, maxIter: 1000, restart: 50 });
  assert.ok(pre.converged, `AMS-GMRES relres ${pre.relres}`);
  assert.ok(pre.iterations < plain.iterations, `AMS ${pre.iterations} vs none ${plain.iterations}`);
});

// ---- la/wasm/kernels ----
test('wasm kernels: the 27-point apply kernel equals the JS stencil apply (scalar and f64x2)', () => {
  const NX = 7, NY = 5, NZ = 4;
  const op = createStencil(NX, NY, NZ);
  for (let q = 0; q < op.A.length; q++) op.A[q] = Math.sin(0.7 * q) + (q % 27 === 13 ? 30 : 0);
  const xJ = padded(op);
  for (let i = op.pad; i < op.pad + op.N; i++) xJ[i] = Math.cos(0.3 * i);
  const yJ = applyStencil(op, xJ, padded(op));
  for (const simd of [false, true]) {
    if (simd && !simdSupported()) continue;
    const L = op.A.length, P = xJ.length;
    const memory = new WebAssembly.Memory({ initial: Math.ceil((8 * (L + 2 * P)) / 65536) + 1 });
    const A = new Float64Array(memory.buffer, 0, L), x = new Float64Array(memory.buffer, 8 * L, P), y = new Float64Array(memory.buffer, 8 * (L + P), P);
    A.set(op.A); x.set(xJ);
    const k = levelKernels(NX, NY, memory, { simd });
    k.apply(A.byteOffset, x.byteOffset, y.byteOffset + 8 * op.pad, op.N);
    let d = 0, m = 0;
    for (let i = op.pad; i < op.pad + op.N; i++) { d = Math.max(d, Math.abs(y[i] - yJ[i])); m = Math.max(m, Math.abs(yJ[i])); }
    assert.ok(d / m < 1e-14, `simd ${simd}: ${d / m}`);
  }
});

// ---- index ----
test('index: one namespace per module, the same bindings as the module files', () => {
  const names = ['units', 'expr', 'params', 'sweep', 'detmath', 'sparse', 'ldlt', 'ldltBlocked', 'ldltWasm', 'ldltSelect', 'complex', 'dense', 'vectorDense', 'arnoldi',
    'gmresReal', 'krylov', 'stencil', 'mg', 'block', 'halfmg', 'pcg', 'amg', 'ams', 'pmg', 'order3d', 'wasmEncoder', 'wasmKernels', 'wasmAccel',
    'femTri', 'femTriFe', 'femQ1Grid', 'hcurl', 'nedelec1', 'hcurlSpace', 'quadrature'];
  assert.deepEqual(Object.keys(core).sort(), [...names].sort());
  assert.equal(core.sparse.SparseCholesky, sparseMod.SparseCholesky);
  assert.equal(core.units.parseUnit, unitsMod.parseUnit);
  assert.equal(core.hcurlSpace.buildSpace, buildSpace);
  assert.equal(core.pmg.buildPMG, buildPMG);
  assert.equal(core.wasmKernels.levelKernels, levelKernels);
});
