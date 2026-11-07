// Ported from eo-modulator-atlas/engine/src/vector-mode.mjs at 0546007 (GPL-3.0-or-later). Changes: model built from a generic triangle mesh (nodes, tri, triRegion) with explicit PEC edge / node sets instead of an EO CrossSection, window sides, mirror option and EO meshing (refinedWindowModel, autoWindowModel, AUTO_SIZING removed); EO material tables (vectorMaterialTensors, tensor4, dispersion anchors, metalEps) replaced by caller-supplied per-triangle permittivity tensors (eps, optional epsIm loss and epsG group tensors; materialTensors keeps the validation, nMax, index list and SPP pairs); block Arnoldi / Ritz imported from @amp/core la/arnoldi (extracted there verbatim), Q4 from @amp/core fem/quadrature TRI_Q4, triangleGeometry from @amp/core fem/tri, LDL^T and analyze from @amp/core la/ldlt, la/sparse; region confinement keyed by model.regionNames; window-margin diagnostic on the mesh bounding box; EO-coupled exports removed (vectorEoOverlap, vectorOpticalFields, sampleStaticFieldQ).
// SPDX-License-Identifier: GPL-3.0-or-later
// Full-vector optical eigenmode solver on a conforming triangle mesh: Nedelec (H(curl)) edge elements for the
// transverse field and Lagrange elements for the longitudinal field, Lee-Sun-Cendes beta^2 formulation, solved by
// shift-invert block Arnoldi (thick restart) with a sparse LDL^T.
//
// Element orders: order 1 = Whitney (Nedelec first kind, degree 1, 3 DOF) + P1 (closed-form element matrices);
// order 2 = hierarchical Nedelec first kind degree 2 (Whitney + gradient edge functions grad(L_a L_b) + 2 face
// functions L_2 N_01, L_0 N_12; 8 DOF) + hierarchical P2 (vertex L_a, edge bubble 4 L_a L_b; 6 DOF), 6-point degree-4
// quadrature (exact for every element integral with piecewise-constant permittivity). Both orders satisfy
// grad(Lagrange space) in the edge space, which the change of variables below requires. Triangles are straight
// (affine): curved mid-edge nodes of a tri6 mesh are not used by this solver.
//
// Frames and conventions: x lateral, y up, z propagation. Fields E(x, y) exp(j(omega t - beta z)), mu = mu0,
// relative permittivity eps per triangle (piecewise constant) with eps_xz = eps_yz = 0.
// Coordinates in um, k0 = 2 pi / lambda_um (1/um), beta in 1/um (callers convert from SI).
//
// Formulation (EO DevLog-025). Unknowns e_t = beta E_t, e_z = -j E_z; change of variables e_t' = e_t + grad e_z.
// Pencil
//     A' x = -beta^2 B' x,   x = (e_t', e_z)
//     A' = [ S_tt - k0^2 T_eps ,  k0^2 G_eps ;  k0^2 G_eps^T , -k0^2 S_eps ]
//     B' = [ T_tt , 0 ; 0 , -k0^2 T_zz(eps_zz) ]
// Shift-invert matrix K = A' + sigma B' is quasi-definite for sigma > k0^2 max eps (LDL^T with 1x1 pivots exists for
// any ordering). Negative pivots of K minus N_z = number of (positive-type) eigenvalues above sigma (Sylvester).
// Lossy materials (eps = eps' - j eps''): complex-symmetric pencil, ComplexLDLT, Arnoldi on the realified operator;
// beta = beta_r - j alpha, loss 20 log10(e) alpha per length.
//
// Physical fields exported (lossless): E_t = e_t / beta (real), E_z = j * ez (ez stored), H_t = z x e_t' / (k0 eta0)
// (real), H_z = j * hz with hz = curl(E_t) / (k0 eta0). Normalised to max |E| = 1 V/m over triangle centroids, largest
// transverse centroid component positive. P_z (W, for that normalisation) = 1e-12 Re[ int e_t . conj(e_t') dA_um / beta ]
// / (2 eta0 k0); for a lossless eigenvector int e_t . e_t' = x^T B' x exactly (row 2 of the pencil).
// Boundaries: PEC (tangential E = 0, E_z = 0) on the given edges / nodes; every other outer boundary is PMC (natural).

import { analyze, ndOrder } from '@amp/core/la/sparse';
import { SymbolicLDLT, LDLT, ComplexLDLT, SupernodalLDLT, ComplexSupernodalLDLT } from '@amp/core/la/ldlt';
import { blockArnoldi, dotv } from '@amp/core/la/arnoldi';
import { triangleGeometry } from '@amp/core/fem/tri';
import { TRI_Q4 } from '@amp/core/fem/quadrature';

const Q4 = TRI_Q4;
/** Labels carried by every vector result (element order label added per model). */
export const VECTOR_LABELS = Object.freeze(['full_vector_optical']);
const ORDER_LABELS = { 1: 'nedelec1_p1', 2: 'nedelec1_deg2_p2' };
/** Free-space impedance mu0 c (ohm), CODATA 2018 (mu0 = 1.25663706212e-6 N/A^2, c exact). */
const ETA0 = 1.25663706212e-6 * 299792458;
const OFFDIAG_TOL = 1e-9;
/** Local DOF counts per triangle: nt (transverse, edge space), nz (longitudinal, Lagrange). */
const NLOC = { 1: { nt: 3, nz: 3 }, 2: { nt: 8, nz: 6 } };

const fail = (msg) => {
  throw new Error(`vector-mode: ${msg}`);
};

// ---------------------------------------------------------------------------------------------------------------
// Model: mesh, edges, DOF map, CSR pattern, ordering, symbolic LDL^T.

/**
 * Build the vector optical model of a triangle mesh (topology, DOF map, pattern, ordering, symbolic analysis). The
 * model depends on the mesh, the PEC set and the element order, not on wavelength or permittivity: one model (and one
 * symbolic factorisation) serves every wavelength, shift and material perturbation.
 * @param {{nNodes:number, nTris:number, tri:Int32Array, x:Float64Array, y:Float64Array, triRegion:Int32Array}} mesh
 *   coordinates in um; triangle vertices in any orientation
 * @param {{order?:1|2, pecNodes?:Uint8Array, pecEdge?:(a:number, b:number) => boolean, dead?:Uint8Array,
 *   regionNames?:string[], factorization?:'supernodal'|'uplooking', ordering?:'amd'|'nd'}} [opts]
 *   pecNodes: per node, 1 = on a PEC boundary (E_z = 0 there); pecEdge(a, b): mesh edge (a, b) lies on a PEC boundary
 *   (tangential E = 0); dead: per triangle, 1 = inside a perfect conductor (no DOFs, its boundary must be PEC).
 */
export function buildVectorModel(mesh, opts = {}) {
  const t0 = performance.now();
  const order = opts.order ?? 2;
  if (!NLOC[order]) fail(`order must be 1 or 2; got ${order}`);
  for (const k of ['nNodes', 'nTris']) if (!(mesh[k] > 0)) fail(`mesh.${k} must be > 0`);
  const geo = triangleGeometry(mesh);
  const nT = mesh.nTris;
  const area = new Float64Array(nT);
  for (let t = 0; t < nT; t++) area[t] = Math.abs(geo.area[t]);
  const dead = opts.dead ?? new Uint8Array(nT);
  const edges = buildEdges(mesh);
  const pecNodes = opts.pecNodes ?? new Uint8Array(mesh.nNodes);
  const pecEdges = new Uint8Array(edges.nE);
  if (opts.pecEdge) for (let e = 0; e < edges.nE; e++) pecEdges[e] = opts.pecEdge(edges.eA[e], edges.eB[e]) ? 1 : 0;
  const dof = buildDofMap(mesh, edges, dead, pecNodes, pecEdges, order);
  const pat = buildPattern(mesh, dof);
  const tPat = performance.now();
  const factorization = opts.factorization ?? 'supernodal';
  const ordering = opts.ordering ?? 'amd';
  if (factorization !== 'supernodal' && factorization !== 'uplooking') fail(`factorization must be supernodal or uplooking; got ${factorization}`);
  if (ordering !== 'amd' && ordering !== 'nd') fail(`ordering must be amd or nd; got ${ordering}`);
  let perm, sym, tOrd;
  if (factorization === 'supernodal') {
    sym = analyze(pat.pat, { ordering, x: dof.x, y: dof.y });
    perm = sym.perm;
    tOrd = tPat + sym.timing.ordering_ms;
  } else {
    perm = ordering === 'nd' ? ndOrder(pat.pat, dof.x, dof.y) : analyze(pat.pat, { ordering: 'amd' }).perm;
    tOrd = performance.now();
    sym = new SymbolicLDLT(pat.pat, perm);
  }
  const tSym = performance.now();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < mesh.nNodes; i++) {
    x0 = Math.min(x0, mesh.x[i]); x1 = Math.max(x1, mesh.x[i]);
    y0 = Math.min(y0, mesh.y[i]); y1 = Math.max(y1, mesh.y[i]);
  }
  const nReg = Math.max(...mesh.triRegion) + 1;
  return {
    kind: 'vector',
    order,
    mesh,
    geo,
    area,
    bbox: { x0, x1, y0, y1 },
    regionNames: opts.regionNames ?? Array.from({ length: nReg }, (_, i) => `region${i}`),
    dead,
    edges,
    dof,
    pattern: pat,
    perm,
    sym,
    factorization,
    ordering,
    timing: { topologyPatternMs: tPat - t0, orderingMs: tOrd - tPat, symbolicMs: tSym - tOrd },
  };
}
function buildEdges(mesh) {
  const nN = mesh.nNodes, nT = mesh.nTris, tri = mesh.tri;
  const start = new Int32Array(nN + 1);
  for (let t = 0; t < nT; t++)
    for (let k = 0; k < 3; k++) {
      const u = tri[3 * t + k], v = tri[3 * t + ((k + 1) % 3)];
      start[(u < v ? u : v) + 1]++;
    }
  for (let i = 0; i < nN; i++) start[i + 1] += start[i];
  const fill = start.slice(0, nN);
  const hiOf = new Int32Array(3 * nT), slotOf = new Int32Array(3 * nT);
  for (let t = 0; t < nT; t++)
    for (let k = 0; k < 3; k++) {
      const u = tri[3 * t + k], v = tri[3 * t + ((k + 1) % 3)];
      const lo = u < v ? u : v;
      const q = fill[lo]++;
      hiOf[q] = u < v ? v : u;
      slotOf[q] = 3 * t + k;
    }
  const triEdge = new Int32Array(3 * nT);
  const triSign = new Int8Array(3 * nT);
  const stamp = new Int32Array(nN).fill(-1), seen = new Int32Array(nN);
  const eA = [], eB = [];
  for (let lo = 0; lo < nN; lo++)
    for (let q = start[lo]; q < start[lo + 1]; q++) {
      const hi = hiOf[q];
      let e;
      if (stamp[hi] === lo) e = seen[hi];
      else {
        e = eA.length;
        eA.push(lo);
        eB.push(hi);
        stamp[hi] = lo;
        seen[hi] = e;
      }
      const s = slotOf[q];
      triEdge[s] = e;
      const t = (s / 3) | 0, k = s % 3;
      triSign[s] = tri[3 * t + k] < tri[3 * t + ((k + 1) % 3)] ? 1 : -1;
    }
  return { nE: eA.length, eA: Int32Array.from(eA), eB: Int32Array.from(eB), triEdge, triSign };
}

/**
 * DOF numbering and the per-triangle local DOF table.
 * Transverse (edge space) DOFs first: Whitney per edge [, gradient edge function per edge, 2 face functions per
 * triangle], then longitudinal: vertex [, edge bubble]. PEC edges / nodes (pecEdges, pecNodes) constrain the edge
 * and node DOFs on them (tangential E and E_z zero); PMC is natural. Local table td: nloc = nt + nz entries per triangle
 * in the local basis order of evalBasis (W01, W12, W20 [, G01, G12, G20, F0, F1] | L0, L1, L2 [, B01, B12, B20]);
 * -1 = constrained or dead triangle. Only the Whitney functions carry an orientation sign (edges.triSign).
 */
function buildDofMap(mesh, edges, dead, pecNodes, pecEdges, order) {
  const { nE, eA, eB, triEdge } = edges;
  const nN = mesh.nNodes, nT = mesh.nTris;
  const { nt, nz } = NLOC[order];
  const nloc = nt + nz;
  const liveNode = new Uint8Array(nN), deadNode = new Uint8Array(nN), liveEdge = new Uint8Array(nE), deadEdge = new Uint8Array(nE);
  for (let t = 0; t < nT; t++)
    for (let k = 0; k < 3; k++) {
      (dead[t] ? deadNode : liveNode)[mesh.tri[3 * t + k]] = 1;
      (dead[t] ? deadEdge : liveEdge)[triEdge[3 * t + k]] = 1;
    }
  const freeEdge = new Uint8Array(nE);
  for (let e = 0; e < nE; e++) freeEdge[e] = liveEdge[e] && !deadEdge[e] && !pecEdges[e] ? 1 : 0;
  const freeNode = new Uint8Array(nN);
  for (let i = 0; i < nN; i++) freeNode[i] = liveNode[i] && !deadNode[i] && !pecNodes[i] ? 1 : 0;
  let n = 0;
  const edgeDof = new Int32Array(nE).fill(-1);
  for (let e = 0; e < nE; e++) if (freeEdge[e]) edgeDof[e] = n++;
  let edgeDof2 = null, faceDof = null, edgeNodeDof = null;
  if (order === 2) {
    edgeDof2 = new Int32Array(nE).fill(-1);
    for (let e = 0; e < nE; e++) if (freeEdge[e]) edgeDof2[e] = n++;
    faceDof = new Int32Array(2 * nT).fill(-1);
    for (let t = 0; t < nT; t++) if (!dead[t]) faceDof[2 * t] = n++, faceDof[2 * t + 1] = n++;
  }
  const nTDof = n;
  const nodeDof = new Int32Array(nN).fill(-1);
  for (let i = 0; i < nN; i++) if (freeNode[i]) nodeDof[i] = n++;
  if (order === 2) {
    edgeNodeDof = new Int32Array(nE).fill(-1);
    for (let e = 0; e < nE; e++) if (freeEdge[e]) edgeNodeDof[e] = n++;
  }
  // DOF coordinates (for the nested-dissection ordering)
  const x = new Float64Array(n), y = new Float64Array(n);
  const setEdge = (arr) => {
    for (let e = 0; e < nE; e++)
      if (arr[e] >= 0) {
        x[arr[e]] = 0.5 * (mesh.x[eA[e]] + mesh.x[eB[e]]);
        y[arr[e]] = 0.5 * (mesh.y[eA[e]] + mesh.y[eB[e]]);
      }
  };
  setEdge(edgeDof);
  for (let i = 0; i < nN; i++)
    if (nodeDof[i] >= 0) {
      x[nodeDof[i]] = mesh.x[i];
      y[nodeDof[i]] = mesh.y[i];
    }
  if (order === 2) {
    setEdge(edgeDof2);
    setEdge(edgeNodeDof);
    for (let t = 0; t < nT; t++)
      for (let j = 0; j < 2; j++) {
        const d = faceDof[2 * t + j];
        if (d < 0) continue;
        const a = mesh.tri[3 * t], b = mesh.tri[3 * t + 1], c = mesh.tri[3 * t + 2];
        x[d] = (mesh.x[a] + mesh.x[b] + mesh.x[c]) / 3;
        y[d] = (mesh.y[a] + mesh.y[b] + mesh.y[c]) / 3;
      }
  }
  // local table
  const td = new Int32Array(nloc * nT).fill(-1);
  for (let t = 0; t < nT; t++) {
    if (dead[t]) continue;
    const o = nloc * t;
    for (let k = 0; k < 3; k++) {
      const e = triEdge[3 * t + k];
      td[o + k] = edgeDof[e];
      td[o + nt + k] = nodeDof[mesh.tri[3 * t + k]];
      if (order === 2) {
        td[o + 3 + k] = edgeDof2[e];
        td[o + nt + 3 + k] = edgeNodeDof[e];
      }
    }
    if (order === 2) {
      td[o + 6] = faceDof[2 * t];
      td[o + 7] = faceDof[2 * t + 1];
    }
  }
  return { order, n, nt, nz, nloc, nTDof, nZDof: n - nTDof, nEdgeDof: nTDof, nNodeDof: n - nTDof, edgeDof, edgeDof2, faceDof, nodeDof, edgeNodeDof, td, x, y };
}

/** CSR pattern as the union of per-triangle nloc x nloc cliques and the per-triangle scatter map. */
function buildPattern(mesh, dof) {
  const nT = mesh.nTris, n = dof.n, nloc = dof.nloc, td = dof.td;
  const cnt = new Int32Array(n + 1);
  for (let q = 0; q < nloc * nT; q++) if (td[q] >= 0) cnt[td[q] + 1]++;
  for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  const fillp = cnt.slice(0, n);
  const dt = new Int32Array(cnt[n]);
  for (let q = 0; q < nloc * nT; q++) if (td[q] >= 0) dt[fillp[td[q]]++] = (q / nloc) | 0;
  const mark = new Int32Array(n).fill(-1);
  const rowptr = new Int32Array(n + 1);
  let cols = new Int32Array(Math.max(16, 4 * nloc * n));
  let nnz = 0;
  const buf = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let p = cnt[i]; p < cnt[i + 1]; p++) {
      const o = nloc * dt[p];
      for (let a = 0; a < nloc; a++) {
        const j = td[o + a];
        if (j >= 0 && mark[j] !== i) {
          mark[j] = i;
          buf.push(j);
        }
      }
    }
    buf.sort((a, b) => a - b);
    if (nnz + buf.length > cols.length) {
      const c2 = new Int32Array(Math.max(cols.length * 2, nnz + buf.length));
      c2.set(cols);
      cols = c2;
    }
    for (let k = 0; k < buf.length; k++) cols[nnz++] = buf[k];
    rowptr[i + 1] = nnz;
  }
  const colidx = cols.slice(0, nnz);
  const pat = { n, rowptr, colidx, nnz };
  const nl2 = nloc * nloc;
  const pos = new Int32Array(nl2 * nT).fill(-1);
  for (let t = 0; t < nT; t++)
    for (let a = 0; a < nloc; a++) {
      const i = td[nloc * t + a];
      if (i < 0) continue;
      for (let b = 0; b < nloc; b++) {
        const j = td[nloc * t + b];
        if (j < 0) continue;
        let lo = rowptr[i], hi = rowptr[i + 1] - 1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1;
          if (colidx[m] < j) lo = m + 1;
          else hi = m - 1;
        }
        pos[nl2 * t + nloc * a + b] = lo;
      }
    }
  return { pat, pos };
}

// ---------------------------------------------------------------------------------------------------------------
// Materials per triangle.

// ---------------------------------------------------------------------------------------------------------------
// Materials per triangle (caller-supplied tensors).

/**
 * Largest planar surface-plasmon index Re sqrt(eps_m eps_d / (eps_m + eps_d)) over every lossy metal (eps_m' < 0) and
 * every dielectric principal permittivity eps_d present in the window (conservative: pairs need not touch). Pairs with
 * eps_m' >= -eps_d support no bound planar SPP and are skipped. Returns {nSppMax, pairs: [{metal, eps_d, nSpp}]}.
 */
function metalPairs(per) {
  const metals = per.filter((p) => p && p.metal && p.eps[0] < 0);
  const diel = [];
  for (const p of per) if (p && p.live && !p.metal) diel.push(p.eps[0], p.eps[2], p.eps[3]);
  let nSppMax = 0;
  const pairs = [];
  for (const m of metals)
    for (const ed of new Set(diel)) {
      const er = m.eps[0], ei = -m.im[0]; // eps_m = er + j ei (ei = -eps'')
      if (!(er < -ed)) continue;
      // q = eps_m ed / (eps_m + ed)
      const nr = er * ed, ni = ei * ed, dr = er + ed, di = ei, d2 = dr * dr + di * di;
      const qr = (nr * dr + ni * di) / d2, qi = (ni * dr - nr * di) / d2;
      const mod = Math.hypot(qr, qi), nSpp = Math.sqrt(0.5 * (mod + qr));
      pairs.push({ metal: m.name, eps_d: ed, nSpp });
      if (Number.isFinite(nSpp)) nSppMax = Math.max(nSppMax, nSpp);
    }
  return { nSppMax, pairs };
}

/**
 * Validated per-triangle permittivity tensors (replaces EO vectorMaterialTensors).
 * @param {ReturnType<typeof buildVectorModel>} model
 * @param {{eps:Float64Array, epsIm?:Float64Array|null, epsG?:Float64Array|null}} opts 4 per triangle [xx, xy, yy, zz];
 *   eps = eps - j epsIm (epsIm >= 0 for loss); epsG = eps - (lambda/2) d eps / d lambda (group term; default eps,
 *   i.e. non-dispersive materials)
 * @returns {{eps:Float64Array, epsG:Float64Array, epsIm:Float64Array|null, nMax:number, indices:number[], pairs:any, ngValid?:boolean}}
 */
export function materialTensors(model, opts = {}) {
  const { mesh, dead } = model;
  const nT = mesh.nTris;
  const need = (a, name) => {
    if (a == null) return null;
    if (!(a instanceof Float64Array) || a.length !== 4 * nT) fail(`${name} must be a Float64Array of length 4 * nTris = ${4 * nT}`);
    return Float64Array.from(a);
  };
  const eps = need(opts.eps, 'eps');
  if (!eps) fail('eps (4 per triangle: xx, xy, yy, zz) is required');
  const epsG = need(opts.epsG, 'epsG') ?? Float64Array.from(eps);
  let epsIm = need(opts.epsIm, 'epsIm');
  if (epsIm && !epsIm.some((v) => v !== 0)) epsIm = null;
  // one record per region (first live triangle), for the SPP pair list and the index list
  const per = model.regionNames.map(() => null);
  let nMax2 = 0;
  for (let t = 0; t < nT; t++) {
    if (dead[t]) continue;
    const o = 4 * t;
    const e = [eps[o], eps[o + 1], eps[o + 2], eps[o + 3]];
    const im = epsIm ? [epsIm[o], epsIm[o + 1], epsIm[o + 2], epsIm[o + 3]] : [0, 0, 0, 0];
    if (!e.every(Number.isFinite) || !im.every(Number.isFinite)) fail(`triangle ${t}: non-finite permittivity`);
    const lossyT = im.some((v) => v !== 0);
    if (!lossyT && !(e[0] > 0 && e[2] > 0 && e[3] > 0)) fail(`triangle ${t}: non-positive lossless permittivity`);
    if (Math.abs(e[1]) > 0 && !(e[0] * e[2] > e[1] * e[1]) && !lossyT) fail(`triangle ${t}: in-plane tensor not positive definite`);
    const r = mesh.triRegion[t];
    if (!per[r]) per[r] = { eps: e, im, live: true, metal: lossyT && e[0] < 0, name: model.regionNames[r] };
    if (!lossyT || e[0] > 0) {
      const a = e[0], b = e[1], c = e[2];
      const lmax = 0.5 * (a + c) + Math.sqrt(0.25 * (a - c) * (a - c) + b * b);
      nMax2 = Math.max(nMax2, lmax, e[3]);
    }
  }
  if (!(nMax2 > 0)) fail('no dielectric with a positive optical permittivity in the window');
  const indices = [];
  for (const p of per) {
    if (!p || p.metal) continue;
    const a = p.eps[0], b = p.eps[1], c = p.eps[2], r = Math.sqrt(0.25 * (a - c) * (a - c) + b * b);
    for (const v of [0.5 * (a + c) + r, 0.5 * (a + c) - r, p.eps[3]]) if (v > 0) indices.push(Math.sqrt(v));
  }
  return { eps, epsG, epsIm, nMax: Math.sqrt(nMax2), indices, pairs: metalPairs(per) };
}


function newBasisBuffers(order) {
  const { nt, nz } = NLOC[order];
  return { vx: new Float64Array(nt), vy: new Float64Array(nt), curl: new Float64Array(nt), phi: new Float64Array(nz), dx: new Float64Array(nz), dy: new Float64Array(nz) };
}

/**
 * Evaluate the local basis of triangle t at barycentric point L (orientation signs applied to Whitney functions).
 * Transverse: W_ab = L_a g_b - L_b g_a (local edges (0,1), (1,2), (2,0)); order 2 adds G_ab = grad(L_a L_b) and the
 * face functions F0 = L_2 W_01, F1 = L_0 W_12. Longitudinal: L_a; order 2 adds 4 L_a L_b.
 * curl(f V) = grad f x V + f curl V (z components).
 */
function evalBasis(order, geo, edges, t, L, B) {
  const gx0 = geo.gx[3 * t], gx1 = geo.gx[3 * t + 1], gx2 = geo.gx[3 * t + 2];
  const gy0 = geo.gy[3 * t], gy1 = geo.gy[3 * t + 1], gy2 = geo.gy[3 * t + 2];
  const gx = [gx0, gx1, gx2], gy = [gy0, gy1, gy2];
  for (let k = 0; k < 3; k++) {
    const a = k, b = (k + 1) % 3;
    const s = edges.triSign[3 * t + k];
    B.vx[k] = s * (L[a] * gx[b] - L[b] * gx[a]);
    B.vy[k] = s * (L[a] * gy[b] - L[b] * gy[a]);
    B.curl[k] = s * 2 * (gx[a] * gy[b] - gy[a] * gx[b]);
    B.phi[k] = L[k];
    B.dx[k] = gx[k];
    B.dy[k] = gy[k];
  }
  if (order === 2) {
    for (let k = 0; k < 3; k++) {
      const a = k, b = (k + 1) % 3;
      B.vx[3 + k] = L[a] * gx[b] + L[b] * gx[a];
      B.vy[3 + k] = L[a] * gy[b] + L[b] * gy[a];
      B.curl[3 + k] = 0;
      B.phi[3 + k] = 4 * L[a] * L[b];
      B.dx[3 + k] = 4 * (L[a] * gx[b] + L[b] * gx[a]);
      B.dy[3 + k] = 4 * (L[a] * gy[b] + L[b] * gy[a]);
    }
    // face functions from the unsigned Whitney functions of local edges 0 and 1
    const w0x = L[0] * gx[1] - L[1] * gx[0], w0y = L[0] * gy[1] - L[1] * gy[0], c0 = 2 * (gx[0] * gy[1] - gy[0] * gx[1]);
    const w1x = L[1] * gx[2] - L[2] * gx[1], w1y = L[1] * gy[2] - L[2] * gy[1], c1 = 2 * (gx[1] * gy[2] - gy[1] * gx[2]);
    B.vx[6] = L[2] * w0x;
    B.vy[6] = L[2] * w0y;
    B.curl[6] = gx[2] * w0y - gy[2] * w0x + L[2] * c0;
    B.vx[7] = L[0] * w1x;
    B.vy[7] = L[0] * w1y;
    B.curl[7] = gx[0] * w1y - gy[0] * w1x + L[0] * c1;
  }
}

/** Order-2 element matrices by quadrature (exact: integrands of degree <= 4). Layout as elementMatricesP1, nloc = 14. */
function elementMatricesQ(t, model, epsT, k0, withConst, ae, be, B) {
  const { nt, nz } = NLOC[model.order];
  const nloc = nt + nz;
  const A = model.area[t];
  const exx = epsT[4 * t], exy = epsT[4 * t + 1], eyy = epsT[4 * t + 2], ezz = epsT[4 * t + 3];
  const k02 = k0 * k0;
  ae.fill(0, 0, nloc * nloc);
  be.fill(0, 0, nloc * nloc);
  for (const q of Q4) {
    evalBasis(model.order, model.geo, model.edges, t, q, B);
    const w = q[3] * A;
    for (let i = 0; i < nt; i++) {
      const vix = B.vx[i], viy = B.vy[i];
      // eps . N_i
      const eix = exx * vix + exy * viy, eiy = exy * vix + eyy * viy;
      for (let j = 0; j < nt; j++) {
        const vjx = B.vx[j], vjy = B.vy[j];
        let av = -k02 * (eix * vjx + eiy * vjy);
        if (withConst) {
          av += B.curl[i] * B.curl[j];
          be[nloc * i + j] += w * (vix * vjx + viy * vjy);
        }
        ae[nloc * i + j] += w * av;
      }
      for (let j = 0; j < nz; j++) {
        const g = w * k02 * (eix * B.dx[j] + eiy * B.dy[j]);
        ae[nloc * i + nt + j] += g;
        ae[nloc * (nt + j) + i] += g;
      }
    }
    for (let i = 0; i < nz; i++) {
      const dix = exx * B.dx[i] + exy * B.dy[i], diy = exy * B.dx[i] + eyy * B.dy[i];
      for (let j = 0; j < nz; j++) {
        ae[nloc * (nt + i) + nt + j] -= w * k02 * (dix * B.dx[j] + diy * B.dy[j]);
        be[nloc * (nt + i) + nt + j] -= w * k02 * ezz * B.phi[i] * B.phi[j];
      }
    }
  }
}

/**
 * Assemble A' and B' (values on the model CSR pattern) for a per-triangle tensor field.
 * @param {Float64Array} epsT 4 per triangle [xx, xy, yy, zz]
 * @param {boolean} [withConst=true] include eps-independent terms (false: only the eps-linear part, e.g. loss)
 */
export function assembleVector(model, epsT, k0, withConst = true) {
  const { pattern, mesh, dead } = model;
  const nloc = model.dof.nloc, nl2 = nloc * nloc;
  const nnz = pattern.pat.nnz;
  const Av = new Float64Array(nnz), Bv = new Float64Array(nnz);
  const ae = new Float64Array(nl2), be = new Float64Array(nl2);
  const Bb = newBasisBuffers(model.order);
  const pos = pattern.pos;
  for (let t = 0; t < mesh.nTris; t++) {
    if (dead[t]) continue;
    if (model.order === 1) elementMatricesP1(t, model, epsT, k0, withConst, ae, be);
    else elementMatricesQ(t, model, epsT, k0, withConst, ae, be, Bb);
    const o = nl2 * t;
    for (let q = 0; q < nl2; q++) {
      const p = pos[o + q];
      if (p < 0) continue;
      Av[p] += ae[q];
      Bv[p] += be[q];
    }
  }
  return { A: Av, B: Bv };
}

/**
 * Order-1 local 6x6 element blocks for one triangle (closed form).
 * Writes into ae (A' local) and be (B' local), row-major 6x6, local orientation already multiplied by edge signs.
 * withConst: include the eps-independent terms (curl-curl in A', T_tt in B').
 */
function elementMatricesP1(t, model, epsT, k0, withConst, ae, be) {
  const { geo, area, edges } = model;
  const A = area[t];
  const gx0 = geo.gx[3 * t], gx1 = geo.gx[3 * t + 1], gx2 = geo.gx[3 * t + 2];
  const gy0 = geo.gy[3 * t], gy1 = geo.gy[3 * t + 1], gy2 = geo.gy[3 * t + 2];
  const gx = [gx0, gx1, gx2], gy = [gy0, gy1, gy2];
  const exx = epsT[4 * t], exy = epsT[4 * t + 1], eyy = epsT[4 * t + 2], ezz = epsT[4 * t + 3];
  // G[i][j] = g_i . M . g_j for M = I and M = eps_t
  const GI = new Float64Array(9), GE = new Float64Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      GI[3 * i + j] = gx[i] * gx[j] + gy[i] * gy[j];
      GE[3 * i + j] = gx[i] * (exx * gx[j] + exy * gy[j]) + gy[i] * (exy * gx[j] + eyy * gy[j]);
    }
  const s = [edges.triSign[3 * t], edges.triSign[3 * t + 1], edges.triSign[3 * t + 2]];
  const k02 = k0 * k0;
  const A12 = A / 12;
  for (let q = 0; q < 36; q++) {
    ae[q] = 0;
    be[q] = 0;
  }
  for (let k = 0; k < 3; k++) {
    const ak = k, bk = (k + 1) % 3;
    const ck = 2 * (gx[ak] * gy[bk] - gy[ak] * gx[bk]);
    for (let l = 0; l < 3; l++) {
      const al = l, bl = (l + 1) % 3;
      const cl = 2 * (gx[al] * gy[bl] - gy[al] * gx[bl]);
      const d = (i, j) => (i === j ? 2 : 1);
      const mass = (G) => A12 * (d(ak, al) * G[3 * bk + bl] - d(ak, bl) * G[3 * bk + al] - d(bk, al) * G[3 * ak + bl] + d(bk, bl) * G[3 * ak + al]);
      const sg = s[k] * s[l];
      let av = -k02 * mass(GE);
      if (withConst) {
        av += A * ck * cl;
        be[6 * k + l] = sg * mass(GI);
      }
      ae[6 * k + l] = sg * av;
    }
    for (let v = 0; v < 3; v++) {
      const gval = (A / 3) * (GE[3 * bk + v] - GE[3 * ak + v]);
      ae[6 * k + 3 + v] = ae[6 * (3 + v) + k] = s[k] * k02 * gval;
    }
  }
  for (let u = 0; u < 3; u++)
    for (let v = 0; v < 3; v++) {
      ae[6 * (3 + u) + 3 + v] = -k02 * A * GE[3 * u + v];
      be[6 * (3 + u) + 3 + v] = -k02 * ezz * A12 * (u === v ? 2 : 1);
    }
}

function csrMatVec(pat, val, x, out) {
  const n = pat.n, rp = pat.rowptr, ci = pat.colidx;
  out = out ?? new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let p = rp[i]; p < rp[i + 1]; p++) s += val[p] * x[ci[p]];
    out[i] = s;
  }
  return out;
}


// ---------------------------------------------------------------------------------------------------------------
// Solve.

/**
 * Full-vector modes at one wavelength.
 * @param {ReturnType<typeof buildVectorModel>} model
 * @param {number} lambdaUm
 * @param {{eps:Float64Array, epsIm?:Float64Array|null, epsG?:Float64Array|null, numModes?:number,
 *   nTarget?:number|null, tol?:number, blockSize?:number, maxBasis?:number|null, maxRestarts?:number, warm?:any,
 *   fields?:boolean, inertiaCheckN?:number|null, epsDelta?:Float64Array, epsDeltaGroup?:Float64Array,
 *   epsDeltaScale?:number, adaptiveShift?:boolean, refineSteps?:number}} opts
 *   eps / epsIm / epsG: per-triangle tensors (materialTensors). nTarget: shift index (default just above the largest
 *   index; modes with n_eff closest below it come first). warm: previous result's .warm (Krylov seed and warm shift
 *   1.02 neffMax, lossless, with automatic fallback when the inertia shows an eigenvalue above it). adaptiveShift
 *   (default true; lossless, no nTarget, no warm): after one short Arnoldi cycle the matrix is refactored 3 % (retry
 *   10 %) above the estimated top n_eff if the inertia confirms nothing lies above it. inertiaCheckN: extra
 *   factorisation at sigma = (k0 n)^2 to count eigenvalues above n (Sylvester; lossless only). epsDelta: additive
 *   per-triangle tensor perturbation times epsDeltaScale; epsDeltaGroup: the matching perturbation of eps_g.
 */
export function solveVectorModes(model, lambdaUm, opts = {}) {
  const t0 = performance.now();
  const numModes = opts.numModes ?? 4;
  const tol = opts.tol ?? 1e-7;
  const blockSize = opts.blockSize ?? 1;
  const k0 = (2 * Math.PI) / lambdaUm;
  const mt = materialTensors(model, opts);
  if (opts.epsDelta) {
    const d = opts.epsDelta, sc = opts.epsDeltaScale ?? 1;
    if (!(d instanceof Float64Array) || d.length !== mt.eps.length) fail('epsDelta must be a Float64Array of length 4 * nTris');
    for (let q = 0; q < d.length; q++) mt.eps[q] += sc * d[q];
    // the group tensor eps_g = eps - (lambda/2) d eps/d lambda needs its own perturbation (audit V10)
    const dg = opts.epsDeltaGroup;
    if (dg) {
      if (!(dg instanceof Float64Array) || dg.length !== mt.epsG.length) fail('epsDeltaGroup must be a Float64Array of length 4 * nTris');
      for (let q = 0; q < dg.length; q++) mt.epsG[q] += sc * dg[q];
    } else mt.ngValid = false;
  }
  // default shift: above the largest dielectric index and, for lossy metal, above every planar SPP index (audit V4)
  const nDefault = Math.max(mt.nMax, mt.epsIm ? mt.pairs.nSppMax : 0) * Math.sqrt(1 + 1e-3);
  // warm shift (lossless only): 2 % above the previous solve's top n_eff (wavelength / parameter sweeps); solveReal
  // falls back to the default shift when the inertia shows an eigenvalue above it or a pivot was perturbed
  let nTarget = opts.nTarget ?? nDefault;
  let warmShift = false;
  if (opts.nTarget == null && !mt.epsIm && opts.shiftFromWarm !== false && opts.warm?.neffMax > 0) {
    const h = opts.warm.neffMax * 1.02;
    if (h < nDefault) {
      nTarget = h;
      warmShift = true;
    }
  }
  const sigma = k0 * k0 * nTarget * nTarget;
  const { A, B } = assembleVector(model, mt.eps, k0, true);
  let Ai = null, Bi = null;
  if (mt.epsIm) {
    const L = assembleVector(model, mt.epsIm, k0, false);
    Ai = L.A.map((v) => -v);
    Bi = L.B.map((v) => -v);
  }
  const tAsm = performance.now();
  const common = { model, mt, k0, lambdaUm, nTarget, sigma, A, B, Ai, Bi, numModes, tol, blockSize, opts, t0, tAsm, warmShift, nDefault };
  return Ai ? solveComplex(common) : solveReal(common);
}

function solveReal({ model, mt, k0, lambdaUm, nTarget, sigma, A, B, numModes, tol, blockSize, opts, t0, tAsm, warmShift, nDefault }) {
  const pat = model.pattern.pat;
  const n = pat.n;
  const nZ = model.dof.nZDof;
  const factorAt = (sg) => {
    const K = new Float64Array(pat.nnz);
    for (let q = 0; q < K.length; q++) K[q] = A[q] + sg * B[q];
    const f = model.factorization === 'supernodal' ? new SupernodalLDLT(model.sym) : new LDLT(model.sym);
    return { f, r: f.factor(K), K, sigma: sg };
  };
  let cur = factorAt(sigma);
  let shiftFallback = false;
  if (warmShift && (!cur.r.ok || cur.r.nPerturbed > 0 || cur.r.nNeg !== nZ)) {
    nTarget = nDefault;
    sigma = k0 * k0 * nTarget * nTarget;
    cur = factorAt(sigma);
    shiftFallback = true;
  }
  if (!cur.r.ok) fail('shift-invert factorisation failed (non-finite pivot)');
  let nFactor = shiftFallback ? 2 : 1;
  const tFac = performance.now();
  let solves = 0;
  const op = (X) => {
    const { f, r, K } = cur;
    const m = X.length;
    const rhs = new Float64Array(n * m);
    for (let c = 0; c < m; c++) csrMatVec(pat, B, X[c], rhs.subarray(c * n, (c + 1) * n));
    solves += m;
    if (r.nPerturbed > 0) return X.map((_, c) => f.solveRefined(pat, K, rhs.subarray(c * n, (c + 1) * n)).x);
    const sol = m === 1 ? f.solve(rhs) : f.solveMany(rhs, m);
    return X.map((_, c) => sol.slice(c * n, (c + 1) * n));
  };
  const maxBasis = opts.maxBasis ?? Math.max(20, 3 * numModes + 8);
  const X0 = opts.warm?.X && opts.warm.n === n ? opts.warm.X : null;
  const arOpts = { nWant: numModes, blockSize, maxBasis, tol, maxRestarts: opts.maxRestarts ?? 30, seed: 20261014, realOnly: true };
  let ar;
  let adaptive = null;
  if (!warmShift && opts.nTarget == null && opts.adaptiveShift !== false && !X0) {
    // adaptive shift (round 3): at the first thick-restart point, estimate the top n_eff from the Ritz values; if the
    // safe shift is far above it (nTarget / nTop > 1.34, i.e. the shift distance shrinks by ~40x), refactor 3 % above
    // nTop when the inertia confirms nothing lies above and no pivot was perturbed, then continue from the Ritz
    // vectors. Otherwise the thick restart simply continues at the safe shift.
    let nTopEst = null;
    const ar1 = blockArnoldi(n, op, { ...arOpts, firstCycleBasis: opts.adaptiveFirstCycle ?? Math.max(numModes + 8, 12), onFirstRestart: (mus) => {
      const thetas = mus.filter((m) => m.re !== 0).map((m) => cur.sigma - 1 / m.re);
      const top = Math.max(...thetas);
      if (!(top > 0)) return false;
      nTopEst = Math.sqrt(top) / k0;
      return nTarget / nTopEst > (opts.adaptiveShiftRatio ?? 1.34);
    } });
    if (!ar1.switched) ar = ar1;
    else {
      // the first-cycle estimate can sit below the true top mode (unconverged Ritz value): 3 % margin, one retry at 10 %
      adaptive = { firstCycleOps: solves, nTopEstimate: nTopEst, accepted: false, rejectedNTarget: [] };
      for (const margin of [1.03, 1.1]) {
        const nNew = nTopEst * margin;
        if (!(nNew < 0.999 * nTarget)) break;
        const cand = factorAt(k0 * k0 * nNew * nNew);
        nFactor++;
        if (cand.r.ok && cand.r.nPerturbed === 0 && cand.r.nNeg === nZ) {
          adaptive = { ...adaptive, accepted: true, fromNTarget: nTarget, toNTarget: nNew };
          cur = cand;
          nTarget = nNew;
          sigma = cand.sigma;
          break;
        }
        adaptive.rejectedNTarget.push(nNew);
      }
      ar = blockArnoldi(n, op, { ...arOpts, X0: ar1.vecs.map((v) => v.re) });
    }
  } else ar = blockArnoldi(n, op, { ...arOpts, X0 });
  const fr = cur.r;
  const modesAboveShift = fr.nNeg - nZ;
  // refinement: inverse-iteration step(s) per Ritz vector (x <- C x), then the pencil Rayleigh quotient
  let vecs = ar.vecs.map((v) => v.re);
  for (let st = 0; st < (opts.refineSteps ?? 1) && vecs.length; st++) {
    vecs = op(vecs);
    for (const v of vecs) {
      const nv = Math.sqrt(dotv(v, v));
      for (let i = 0; i < n; i++) v[i] /= nv;
    }
  }
  const tEig = performance.now();
  const raw = [];
  for (let k = 0; k < vecs.length; k++) {
    const x = vecs[k];
    const Ax = csrMatVec(pat, A, x), Bx = csrMatVec(pat, B, x);
    const xAx = dotv(x, Ax), xBx = dotv(x, Bx);
    const theta = -xAx / xBx;
    let rn = 0, an = 0;
    for (let i = 0; i < n; i++) {
      const r = Ax[i] + theta * Bx[i];
      rn += r * r;
      an += Ax[i] * Ax[i];
    }
    raw.push({ theta: [theta, 0], xr: x, xi: null, xBx: [xBx, 0], residual: Math.sqrt(rn / an), ritzResidual: ar.ritzRes[k] });
  }
  raw.sort((a, b) => b.theta[0] - a.theta[0]);
  let check = null;
  if (opts.inertiaCheckN != null) {
    // A level equal to a material index makes the gradient-type DOFs of that region singular (zero pivots): move it
    // off by 1e-6 relative. Any static pivot perturbation makes the count unreliable (audit V2).
    let nUsed = opts.inertiaCheckN;
    if (mt.indices.some((nm) => Math.abs(nUsed - nm) <= 1e-9 * nm)) nUsed *= 1 + 1e-6;
    const s2 = k0 * k0 * nUsed * nUsed;
    const K2 = new Float64Array(pat.nnz);
    for (let q = 0; q < K2.length; q++) K2[q] = A[q] + s2 * B[q];
    const r2 = (model.factorization === 'supernodal' ? new SupernodalLDLT(model.sym) : new LDLT(model.sym)).factor(K2);
    check = { nCheck: opts.inertiaCheckN, nCheckUsed: nUsed, eigenvaluesAbove: r2.nNeg - model.dof.nZDof, nPerturbed: r2.nPerturbed, reliable: r2.nPerturbed === 0 };
  }
  const modes = raw.map((md) => postProcess(model, mt, k0, md, opts));
  const tPost = performance.now();
  const warnings = [];
  if (modesAboveShift !== 0) warnings.push(`inertia: ${modesAboveShift} eigenvalue(s) above the shift n_target = ${nTarget}; modes with n_eff > n_target may be missing`);
  if (fr.nPerturbed) warnings.push(`LDL^T: ${fr.nPerturbed} static pivot perturbation(s); solves used iterative refinement; inertia count at the shift is not reliable`);
  if (check && !check.reliable) warnings.push(`inertia check at n = ${check.nCheckUsed}: ${check.nPerturbed} static pivot perturbation(s); eigenvaluesAbove is not reliable`);
  if (!ar.converged) warnings.push('Arnoldi did not reach the requested tolerance; see ritzResidual per mode');
  if (mt.ngValid === false) warnings.push('epsDelta without epsDeltaGroup: ng is not defined for this perturbed solve (NaN)');
  return finishResult({ model, k0, lambdaUm, nTarget, sigma, modes, ar, solves, warnings, staticPivots: fr.nPerturbed,
    inertia: { negativePivots: fr.nNeg, zDofs: model.dof.nZDof, eigenvaluesAboveShift: modesAboveShift, reliable: fr.nPerturbed === 0, check },
    timing: { assembleMs: tAsm - t0, factorMs: tFac - tAsm, eigenMs: tEig - tFac, postMs: tPost - tEig, solveTotalMs: tPost - t0 },
    shift: { nTarget, source: warmShift ? (shiftFallback ? 'warm_rejected_default' : 'warm') : opts.nTarget != null ? 'user' : adaptive?.accepted ? 'adaptive' : 'default', adaptive, factorizations: nFactor },
    warm: { X: raw.map((m) => m.xr), n, neffMax: modes.length ? Math.max(...modes.map((m) => m.neff)) : null } });
}

/**
 * Lossy (complex-symmetric) solve: K = (A_r + j A_i) + sigma (B_r + j B_i) factorised by ComplexLDLT; block Arnoldi on
 * the realified operator R(C) = [[Cr, -Ci], [Ci, Cr]], whose eigenvalues are those of C and of conj(C). For a Ritz
 * vector w = [w1; w2] of R(C) with value lambda, z+ = w1 + j w2 satisfies C z+ = lambda z+ and z- = w1 - j w2
 * satisfies C conj(z-) = conj(lambda) conj(z-); the dominant one gives the physical pair. Final eigenvalue from the
 * complex (unconjugated) Rayleigh quotient theta = -(z^T A z) / (z^T B z).
 */
function solveComplex({ model, mt, k0, lambdaUm, nTarget, sigma, A, B, Ai, Bi, numModes, tol, blockSize, opts, t0, tAsm }) {
  const pat = model.pattern.pat;
  const n = pat.n;
  const Kr = new Float64Array(pat.nnz), Ki = new Float64Array(pat.nnz);
  for (let q = 0; q < Kr.length; q++) {
    Kr[q] = A[q] + sigma * B[q];
    Ki[q] = Ai[q] + sigma * Bi[q];
  }
  const fac = model.factorization === 'supernodal' ? new ComplexSupernodalLDLT(model.sym) : new ComplexLDLT(model.sym);
  const fr = fac.factor(Kr, Ki);
  if (!fr.ok) fail('complex shift-invert factorisation failed (non-finite pivot)');
  const tFac = performance.now();
  let solves = 0;
  const cmv = (Mr, Mi, zr, zi) => {
    const a = csrMatVec(pat, Mr, zr), b = csrMatVec(pat, Mi, zi), c = csrMatVec(pat, Mr, zi), d = csrMatVec(pat, Mi, zr);
    for (let i = 0; i < n; i++) {
      a[i] -= b[i];
      c[i] += d[i];
    }
    return { re: a, im: c };
  };
  const refine = fr.nPerturbed > 0;
  const applyC = (zr, zi) => {
    const bz = cmv(B, Bi, zr, zi);
    solves++;
    return refine ? fac.solveRefined(pat, Kr, Ki, bz.re, bz.im) : fac.solve(bz.re, bz.im);
  };
  const op = (X) =>
    X.map((w) => {
      const y = applyC(w.subarray(0, n), w.subarray(n));
      const out = new Float64Array(2 * n);
      out.set(y.re, 0);
      out.set(y.im, n);
      return out;
    });
  const maxBasis = opts.maxBasis ?? Math.max(30, 8 * numModes + 10);
  // the realified operator carries each eigenvalue of C together with eigenvalues of conj(C): ask for twice the
  // modes, recover the physical pairs, remove duplicates, keep numModes
  const ar = blockArnoldi(2 * n, op, { nWant: 2 * numModes, blockSize, maxBasis, tol, X0: null, maxRestarts: opts.maxRestarts ?? 30, seed: 20261015, realOnly: false });
  const raw = [];
  for (let k = 0; k < ar.vecs.length; k++) {
    const { re, im } = ar.vecs[k];
    const imv = im ?? new Float64Array(2 * n);
    const pr = new Float64Array(n), pi = new Float64Array(n), mr = new Float64Array(n), mi = new Float64Array(n);
    let np = 0, nm = 0;
    for (let i = 0; i < n; i++) {
      const a1 = re[i], b1 = imv[i], a2 = re[n + i], b2 = imv[n + i];
      pr[i] = a1 - b2;
      pi[i] = b1 + a2;
      mr[i] = a1 + b2;
      mi[i] = -(b1 - a2);
      np += pr[i] * pr[i] + pi[i] * pi[i];
      nm += mr[i] * mr[i] + mi[i] * mi[i];
    }
    let zr = np >= nm ? pr : mr, zi = np >= nm ? pi : mi;
    for (let st = 0; st < (opts.refineSteps ?? 1); st++) {
      const y = applyC(zr, zi);
      let nn = 0;
      for (let i = 0; i < n; i++) nn += y.re[i] * y.re[i] + y.im[i] * y.im[i];
      nn = Math.sqrt(nn);
      for (let i = 0; i < n; i++) {
        y.re[i] /= nn;
        y.im[i] /= nn;
      }
      zr = y.re;
      zi = y.im;
    }
    const Az = cmv(A, Ai, zr, zi), Bz = cmv(B, Bi, zr, zi);
    const zAz = cdot(zr, zi, Az.re, Az.im), zBz = cdot(zr, zi, Bz.re, Bz.im);
    const theta = cdiv(-zAz[0], -zAz[1], zBz[0], zBz[1]);
    let rn = 0, an = 0;
    for (let i = 0; i < n; i++) {
      const rr = Az.re[i] + theta[0] * Bz.re[i] - theta[1] * Bz.im[i];
      const ri = Az.im[i] + theta[0] * Bz.im[i] + theta[1] * Bz.re[i];
      rn += rr * rr + ri * ri;
      an += Az.re[i] * Az.re[i] + Az.im[i] * Az.im[i];
    }
    raw.push({ theta, xr: zr, xi: zi, xBx: zBz, residual: Math.sqrt(rn / an), ritzResidual: ar.ritzRes[k] });
  }
  // the realified operator can return the same physical eigenvalue twice (nearly real values): keep one
  raw.sort((a, b) => b.theta[0] - a.theta[0]);
  const uniq = [];
  // duplicate = same eigenvalue and parallel eigenvector (|z1^H z2| / (|z1| |z2|) > 0.99); degenerate modes stay
  const herm = (a, b) => {
    let re = 0, im = 0, na = 0, nb = 0;
    for (let i = 0; i < n; i++) {
      re += a.xr[i] * b.xr[i] + a.xi[i] * b.xi[i];
      im += a.xr[i] * b.xi[i] - a.xi[i] * b.xr[i];
      na += a.xr[i] * a.xr[i] + a.xi[i] * a.xi[i];
      nb += b.xr[i] * b.xr[i] + b.xi[i] * b.xi[i];
    }
    return Math.hypot(re, im) / Math.sqrt(na * nb);
  };
  for (const r of raw) if (!uniq.some((u) => Math.hypot(u.theta[0] - r.theta[0], u.theta[1] - r.theta[1]) <= 1e-8 * Math.hypot(...r.theta) && herm(u, r) > 0.99)) uniq.push(r);
  const kept = uniq.slice(0, numModes);
  const tEig = performance.now();
  const modes = kept.map((md) => postProcess(model, mt, k0, md, opts));
  const tPost = performance.now();
  const warnings = [];
  if (fr.nPerturbed) warnings.push(`complex LDL^T: ${fr.nPerturbed} static pivot perturbation(s); solves used iterative refinement`);
  if (!ar.converged) warnings.push('Arnoldi did not reach the requested tolerance; see ritzResidual per mode');
  if (mt.ngValid === false) warnings.push('epsDelta without epsDeltaGroup: ng is not defined for this perturbed solve (NaN)');
  if (mt.pairs.nSppMax > nTarget) warnings.push(`n_target = ${nTarget} lies below the planar surface-plasmon index ${mt.pairs.nSppMax} of a metal/dielectric pair in the window; plasmonic modes above the shift may be missing from the returned set`);
  const above = modes.filter((m) => m.neff > nTarget);
  if (above.length) warnings.push(`${above.length} returned mode(s) have Re n_eff above the shift n_target = ${nTarget} (max ${Math.max(...above.map((m) => m.neff))}); modes above the shift compete by |mu| and the list may not be the highest-n_eff set`);
  if (kept.length < numModes) warnings.push(`only ${kept.length} distinct mode(s) of ${numModes} requested were recovered from the realified operator`);
  return finishResult({ model, k0, lambdaUm, nTarget, sigma, modes, ar, solves, warnings, staticPivots: fr.nPerturbed, inertia: null, spp: mt.pairs,
    timing: { assembleMs: tAsm - t0, factorMs: tFac - tAsm, eigenMs: tEig - tFac, postMs: tPost - tEig, solveTotalMs: tPost - t0 },
    warm: null });
}

function finishResult({ model, k0, lambdaUm, nTarget, sigma, modes, ar, solves, warnings, staticPivots, inertia, timing, warm, spp = null, shift = null }) {
  const pat = model.pattern.pat, n = pat.n;
  return {
    lambdaUm,
    k0,
    nTarget,
    sigma,
    order: model.order,
    modes,
    converged: ar.converged,
    labels: [...VECTOR_LABELS, ORDER_LABELS[model.order]],
    warnings,
    inertia,
    spp,
    shift,
    stats: { dof: n, transverseDofs: model.dof.nTDof, longitudinalDofs: model.dof.nZDof, edges: model.edges.nE, nodes: model.mesh.nNodes, triangles: model.mesh.nTris,
      nnzA: pat.nnz, nnzL: model.sym.nnzL, fillRatio: model.sym.nnzL / ((pat.nnz - n) / 2 + n), factorFlops: model.sym.flops, factorization: model.factorization, ordering: model.ordering,
      krylovBasis: ar.basis, operatorApplications: solves, restarts: ar.restarts, staticPivots },
    timing: { ...model.timing, ...timing },
    warm,
  };
}

function cdot(ar, ai, br, bi) {
  let r = 0, i = 0;
  for (let q = 0; q < ar.length; q++) {
    r += ar[q] * br[q] - ai[q] * bi[q];
    i += ar[q] * bi[q] + ai[q] * br[q];
  }
  return [r, i];
}
function cdiv(ar, ai, br, bi) {
  const d = br * br + bi * bi;
  return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
}
function csqrt(re, im) {
  const m = Math.hypot(re, im);
  const r = Math.sqrt(0.5 * (m + re));
  const i = Math.sqrt(Math.max(0, 0.5 * (m - re)));
  return [r, im < 0 ? -i : i];
}

// ---------------------------------------------------------------------------------------------------------------
// Post-processing (generic in element order; complex-capable for lossy modes).

/** Local coefficients of triangle t (re, im) from a DOF vector. */
function gatherLocal(model, xr, xi, t, cr, ci) {
  const { nloc, td } = model.dof;
  for (let a = 0; a < nloc; a++) {
    const d = td[nloc * t + a];
    cr[a] = d >= 0 ? xr[d] : 0;
    ci[a] = d >= 0 && xi ? xi[d] : 0;
  }
}

/**
 * Field values at a point from local coefficients: P.etp (e_t'), P.et (e_t = e_t' - grad e_z), P.ez, P.curl,
 * each as [re, im] pairs (vectors: [xr, xi, yr, yi]).
 */
function pointFields(model, B, cr, ci, P) {
  const { nt, nz } = NLOC[model.order];
  let pxr = 0, pxi = 0, pyr = 0, pyi = 0, cur = 0, cui = 0;
  for (let i = 0; i < nt; i++) {
    const a = cr[i], b = ci[i];
    pxr += a * B.vx[i];
    pxi += b * B.vx[i];
    pyr += a * B.vy[i];
    pyi += b * B.vy[i];
    cur += a * B.curl[i];
    cui += b * B.curl[i];
  }
  let zr = 0, zi = 0, gxr = 0, gxi = 0, gyr = 0, gyi = 0;
  for (let j = 0; j < nz; j++) {
    const a = cr[nt + j], b = ci[nt + j];
    zr += a * B.phi[j];
    zi += b * B.phi[j];
    gxr += a * B.dx[j];
    gxi += b * B.dx[j];
    gyr += a * B.dy[j];
    gyi += b * B.dy[j];
  }
  P.etp[0] = pxr; P.etp[1] = pxi; P.etp[2] = pyr; P.etp[3] = pyi;
  P.et[0] = pxr - gxr; P.et[1] = pxi - gxi; P.et[2] = pyr - gyr; P.et[3] = pyi - gyi;
  P.ez[0] = zr; P.ez[1] = zi;
  P.curl[0] = cur; P.curl[1] = cui;
}

const newPoint = () => ({ etp: new Float64Array(4), et: new Float64Array(4), ez: new Float64Array(2), curl: new Float64Array(2) });

/** Unconjugated u . M . v for complex 2-vectors [xr, xi, yr, yi] and a real symmetric tensor (mxx, mxy, myy): [re, im]. */
function symTensorForm(u, v, mxx, mxy, myy) {
  const vxr = mxx * v[0] + mxy * v[2], vxi = mxx * v[1] + mxy * v[3];
  const vyr = mxy * v[0] + myy * v[2], vyi = mxy * v[1] + myy * v[3];
  return [u[0] * vxr - u[1] * vxi + u[2] * vyr - u[3] * vyi, u[0] * vxi + u[1] * vxr + u[2] * vyi + u[3] * vyr];
}

function postProcess(model, mt, k0, md, opts) {
  const { mesh, geo, area, regionNames, edges } = model;
  const nT = mesh.nTris;
  const { nloc } = model.dof;
  const theta = md.theta; // [re, im]
  const lossy = !!md.xi;
  const beta = csqrt(theta[0], theta[1]);
  const b2 = beta[0] * beta[0] + beta[1] * beta[1];
  const cr = new Float64Array(nloc), ci = new Float64Array(nloc);
  const B = newBasisBuffers(model.order);
  const P = newPoint();
  let pCr = 0, pCi = 0, pSr = 0, pSi = 0, exx = 0, eyy = 0, ezz = 0, ngr = 0, ngi = 0, e2 = 0, e4 = 0, energyTot = 0;
  const regionPc = new Float64Array(2 * regionNames.length), regionEnergy = new Float64Array(regionNames.length);
  // window-margin diagnostic: power within 10 % of the smaller bounding-box size from the bounding-box sides
  // (opts.marginSides: subset of left/right/bottom/top to include; default all four, e.g. drop a symmetry plane)
  const rect = model.bbox, marginUm = 0.1 * Math.min(rect.x1 - rect.x0, rect.y1 - rect.y0);
  const ms = new Set(opts.marginSides ?? ['left', 'right', 'bottom', 'top']);
  let edgePr = 0, edgePi = 0;
  for (let t = 0; t < nT; t++) {
    if (model.dead[t]) continue;
    gatherLocal(model, md.xr, md.xi, t, cr, ci);
    const o = 4 * t, e = mt.eps, g = mt.epsG;
    const At = area[t];
    let tPr = 0, tPi = 0, tEn = 0;
    for (const q of Q4) {
      evalBasis(model.order, geo, edges, t, q, B);
      pointFields(model, B, cr, ci, P);
      const w = q[3] * At;
      const et = P.et, ep = P.etp, ez = P.ez;
      // Poynting integrand e_t . conj(e_t') and unconjugated e_t . e_t'
      tPr += w * (et[0] * ep[0] + et[1] * ep[1] + et[2] * ep[2] + et[3] * ep[3]);
      tPi += w * (et[1] * ep[0] - et[0] * ep[1] + et[3] * ep[2] - et[2] * ep[3]);
      pSr += w * (et[0] * ep[0] - et[1] * ep[1] + et[2] * ep[2] - et[3] * ep[3]);
      pSi += w * (et[0] * ep[1] + et[1] * ep[0] + et[2] * ep[3] + et[3] * ep[2]);
      const ax = et[0] * et[0] + et[1] * et[1], ay = et[2] * et[2] + et[3] * et[3], az = ez[0] * ez[0] + ez[1] * ez[1];
      exx += w * ax;
      eyy += w * ay;
      ezz += w * az;
      // electric energy density with the real part of eps: |E_t|^2 terms use e_t / beta
      const en = (e[o] * ax + e[o + 2] * ay + 2 * e[o + 1] * (et[0] * et[2] + et[1] * et[3])) / b2 + e[o + 3] * az;
      tEn += w * en;
      // group-index numerator (unconjugated): e_t . eps_g . e_t + theta eps_g,zz e_z^2
      const f = symTensorForm(et, et, g[o], g[o + 1], g[o + 2]);
      const ez2r = ez[0] * ez[0] - ez[1] * ez[1], ez2i = 2 * ez[0] * ez[1];
      ngr += w * (f[0] + g[o + 3] * (theta[0] * ez2r - theta[1] * ez2i));
      ngi += w * (f[1] + g[o + 3] * (theta[0] * ez2i + theta[1] * ez2r));
      const m2 = (ax + ay) / b2 + az;
      e2 += w * m2;
      e4 += w * m2 * m2;
    }
    pCr += tPr;
    pCi += tPi;
    {
      const a = mesh.tri[3 * t], b = mesh.tri[3 * t + 1], c = mesh.tri[3 * t + 2];
      const cx = (mesh.x[a] + mesh.x[b] + mesh.x[c]) / 3, cy = (mesh.y[a] + mesh.y[b] + mesh.y[c]) / 3;
      if ((ms.has('left') && cx - rect.x0 < marginUm) || (ms.has('right') && rect.x1 - cx < marginUm) || (ms.has('bottom') && cy - rect.y0 < marginUm) || (ms.has('top') && rect.y1 - cy < marginUm)) {
        edgePr += tPr;
        edgePi += tPi;
      }
    }
    const ri = mesh.triRegion[t];
    regionPc[2 * ri] += tPr;
    regionPc[2 * ri + 1] += tPi;
    regionEnergy[ri] += tEn;
    energyTot += tEn;
  }
  // P ~ Re[(1/beta) int e_t . conj(e_t')]
  const preal = (re, im) => (re * beta[0] + im * beta[1]) / b2;
  const pTot = preal(pCr, pCi);
  const confinement = {};
  regionNames.forEach((r, i) => {
    if (regionPc[2 * i] !== 0 || regionPc[2 * i + 1] !== 0 || regionEnergy[i] !== 0) confinement[r] = { power: preal(regionPc[2 * i], regionPc[2 * i + 1]) / pTot, electricEnergy: regionEnergy[i] / energyTot };
  });
  // n_g = (k0 / beta) num / (x^T B x)  (complex for lossy; real part reported)
  const ratio = cdiv(ngr, ngi, md.xBx[0], md.xBx[1]);
  const ngc = mt.ngValid === false ? [NaN, NaN] : cdiv(k0 * ratio[0], k0 * ratio[1], beta[0], beta[1]);
  const alpha = -beta[1]; // 1/um, beta = beta_r - j alpha
  const mode = {
    neff: beta[0] / k0,
    beta: beta[0],
    theta: theta[0],
    ng: ngc[0],
    residual: md.residual,
    ritzResidual: md.ritzResidual,
    teFraction: exx / (exx + eyy),
    longitudinalFraction: ezz / ((exx + eyy) / b2 + ezz),
    effectiveAreaUm2: (e2 * e2) / e4,
    confinement,
    powerIdentity: Math.hypot(pSr - md.xBx[0], pSi - md.xBx[1]) / Math.hypot(md.xBx[0], md.xBx[1]),
    windowMargin: { marginUm, powerFraction: preal(edgePr, edgePi) / pTot },
    x: md.xr,
    xBx: md.xBx[0],
  };
  if (lossy) {
    Object.assign(mode, {
      lossy: true,
      betaIm: beta[1],
      thetaIm: theta[1],
      kappa: -beta[1] / k0,
      alphaPerUm: alpha,
      lossDbPerCm: (20 / Math.LN10) * alpha * 1e4,
      ngIm: ngc[1],
      xIm: md.xi,
      xBxIm: md.xBx[1],
    });
  }
  const scale = fieldScale(model, md.xr, md.xi, beta);
  mode.amplitudeScale = scale;
  const s2 = scale[0] * scale[0] + scale[1] * scale[1];
  mode.powerW = (1e-12 * pTot * s2) / (2 * ETA0 * k0);
  if (opts.fields !== false) mode.fields = modeFields(model, md.xr, md.xi, beta, k0, scale);
  return mode;
}

/**
 * Complex scale s such that max over triangle centroids of |E| = 1 (V/m) and the dominant transverse component at
 * that centroid is real positive.
 */
function fieldScale(model, xr, xi, beta) {
  const { mesh, geo, edges } = model;
  const { nloc } = model.dof;
  const cr = new Float64Array(nloc), ci = new Float64Array(nloc);
  const B = newBasisBuffers(model.order), P = newPoint();
  const Lc = [1 / 3, 1 / 3, 1 / 3];
  const b2 = beta[0] * beta[0] + beta[1] * beta[1];
  let mx = 0, best = [1, 0];
  for (let t = 0; t < mesh.nTris; t++) {
    if (model.dead[t]) continue;
    gatherLocal(model, xr, xi, t, cr, ci);
    evalBasis(model.order, geo, edges, t, Lc, B);
    pointFields(model, B, cr, ci, P);
    const ax = P.et[0] * P.et[0] + P.et[1] * P.et[1], ay = P.et[2] * P.et[2] + P.et[3] * P.et[3];
    const m = Math.sqrt((ax + ay) / b2 + P.ez[0] * P.ez[0] + P.ez[1] * P.ez[1]);
    if (m > mx) {
      mx = m;
      // dominant transverse component of E_t = e_t / beta
      const c = ax >= ay ? [P.et[0], P.et[1]] : [P.et[2], P.et[3]];
      best = cdiv(c[0], c[1], beta[0], beta[1]);
    }
  }
  const bm = Math.hypot(best[0], best[1]) || 1;
  // s = conj(best) / (|best| mx)
  return [best[0] / (bm * (mx || 1)), -best[1] / (bm * (mx || 1))];
}

/**
 * Per-triangle centroid field components (typed arrays, transferable).
 * Lossless: ex, ey, hx, hy real amplitudes; ez, hz such that E_z = j ez, H_z = j hz.
 * Lossy: the same arrays hold real parts and exIm, eyIm, ezIm, hxIm, hyIm, hzIm the imaginary parts, with
 * E_z = j (ez + j ezIm), H_z = j (hz + j hzIm). ezNode (and ezNodeIm) at mesh nodes (vertex DOFs; P2 edge bubbles
 * vanish at nodes).
 */
function modeFields(model, xr, xi, beta, k0, s) {
  const { mesh, geo, edges } = model;
  const { nloc } = model.dof;
  const nT = mesh.nTris;
  const lossy = !!xi;
  const mk = () => new Float64Array(nT);
  const F = { ex: mk(), ey: mk(), ez: mk(), hx: mk(), hy: mk(), hz: mk() };
  const Fi = lossy ? { exIm: mk(), eyIm: mk(), ezIm: mk(), hxIm: mk(), hyIm: mk(), hzIm: mk() } : null;
  const ezNode = new Float64Array(mesh.nNodes), ezNodeIm = lossy ? new Float64Array(mesh.nNodes) : null;
  for (let i = 0; i < mesh.nNodes; i++) {
    const d = model.dof.nodeDof[i];
    if (d < 0) continue;
    const a = xr[d], b = xi ? xi[d] : 0;
    ezNode[i] = s[0] * a - s[1] * b;
    if (lossy) ezNodeIm[i] = s[0] * b + s[1] * a;
  }
  const cr = new Float64Array(nloc), ci = new Float64Array(nloc);
  const B = newBasisBuffers(model.order), P = newPoint();
  const Lc = [1 / 3, 1 / 3, 1 / 3];
  const hk = 1 / (k0 * ETA0);
  // complex multiply helpers
  const mul = (ar, ai, br, bi) => [ar * br - ai * bi, ar * bi + ai * br];
  const sb = cdiv(s[0], s[1], beta[0], beta[1]); // s / beta
  for (let t = 0; t < nT; t++) {
    if (model.dead[t]) continue;
    gatherLocal(model, xr, xi, t, cr, ci);
    evalBasis(model.order, geo, edges, t, Lc, B);
    pointFields(model, B, cr, ci, P);
    const ex = mul(sb[0], sb[1], P.et[0], P.et[1]), ey = mul(sb[0], sb[1], P.et[2], P.et[3]);
    const ez = mul(s[0], s[1], P.ez[0], P.ez[1]);
    // H_t = z x e_t' / (k0 eta0): (H_x, H_y) = (-e'_y, e'_x) / (k0 eta0)
    const hx = mul(s[0], s[1], -P.etp[2] * hk, -P.etp[3] * hk), hy = mul(s[0], s[1], P.etp[0] * hk, P.etp[1] * hk);
    const hz = mul(sb[0], sb[1], P.curl[0] * hk, P.curl[1] * hk);
    F.ex[t] = ex[0]; F.ey[t] = ey[0]; F.ez[t] = ez[0]; F.hx[t] = hx[0]; F.hy[t] = hy[0]; F.hz[t] = hz[0];
    if (lossy) {
      Fi.exIm[t] = ex[1]; Fi.eyIm[t] = ey[1]; Fi.ezIm[t] = ez[1]; Fi.hxIm[t] = hx[1]; Fi.hyIm[t] = hy[1]; Fi.hzIm[t] = hz[1];
    }
  }
  return { ...F, ...(Fi ?? {}), ezNode, ...(lossy ? { ezNodeIm } : {}), location: 'triangle_centroid',
    convention: lossy ? 'E_t = ex + j exIm; E_z = j (ez + j ezIm); H_t = hx + j hxIm; H_z = j (hz + j hzIm)' : 'E_t, H_t real; E_z = j ez; H_z = j hz' };
}

// ---------------------------------------------------------------------------------------------------------------
// Perturbations: vector EO overlap and generic permittivity perturbation (Hellmann-Feynman of the discrete pencil).

/** Unconjugated sum over triangles of int e_t . d_eps_t . e_t + theta d_eps_zz e_z^2 (dEpsT 4 per triangle), [re, im]. */
function pencilForm(model, mode, dEpsT, regionAcc = null) {
  const perPoint = dEpsT.length === 4 * Q4.length * model.mesh.nTris; // 4 per quadrature point (24 per triangle)
  const { mesh, geo, area, edges } = model;
  const { nloc } = model.dof;
  const theta = [mode.theta, mode.thetaIm ?? 0];
  const cr = new Float64Array(nloc), ci = new Float64Array(nloc);
  const B = newBasisBuffers(model.order), P = newPoint();
  let sr = 0, si = 0;
  for (let t = 0; t < mesh.nTris; t++) {
    if (model.dead[t]) continue;
    const stride = perPoint ? 4 * Q4.length : 4;
    let nz = false;
    for (let k = 0; k < stride; k++) if (dEpsT[stride * t + k] !== 0) nz = true;
    if (!nz) continue;
    gatherLocal(model, mode.x, mode.xIm ?? null, t, cr, ci);
    let tr = 0, ti = 0;
    for (let qi = 0; qi < Q4.length; qi++) {
      const q = Q4[qi];
      const o = perPoint ? stride * t + 4 * qi : 4 * t;
      const dxx = dEpsT[o], dxy = dEpsT[o + 1], dyy = dEpsT[o + 2], dzz = dEpsT[o + 3];
      evalBasis(model.order, geo, edges, t, q, B);
      pointFields(model, B, cr, ci, P);
      const w = q[3] * area[t];
      const f = symTensorForm(P.et, P.et, dxx, dxy, dyy);
      const ez2r = P.ez[0] * P.ez[0] - P.ez[1] * P.ez[1], ez2i = 2 * P.ez[0] * P.ez[1];
      tr += w * (f[0] + dzz * (theta[0] * ez2r - theta[1] * ez2i));
      ti += w * (f[1] + dzz * (theta[0] * ez2i + theta[1] * ez2r));
    }
    sr += tr;
    si += ti;
    if (regionAcc) regionAcc[mesh.triRegion[t]] += tr;
  }
  return [sr, si];
}

/** delta beta (complex [re, im], 1/um) for a pencil form value: d theta = k0^2 form / (x^T B x), d beta = d theta / (2 beta). */
function dBetaFromForm(mode, k0, form) {
  const beta = [mode.beta, mode.betaIm ?? 0];
  const xBx = [mode.xBx, mode.xBxIm ?? 0];
  const dth = cdiv(k0 * k0 * form[0], k0 * k0 * form[1], xBx[0], xBx[1]);
  return cdiv(dth[0], dth[1], 2 * beta[0], 2 * beta[1]);
}

/**
 * First-order change of n_eff for an arbitrary per-triangle symmetric permittivity perturbation (4 per triangle:
 * xx, xy, yy, zz; real) or per quadrature point (4 x 6 per triangle, TRI_Q4 order). Returns delta n_eff (real part).
 */
export function vectorPerturbation(model, mode, dEpsT, lambdaUm) {
  const k0 = (2 * Math.PI) / lambdaUm;
  return dBetaFromForm(mode, k0, pencilForm(model, mode, dEpsT))[0] / k0;
}

/** Pick the mode of a polarisation family by TE fraction: 'TE' (teFraction >= 0.5) or 'TM', order 0 = highest n_eff. */
export function selectVectorMode(result, polarization, order = 0) {
  const fam = result.modes.filter((m) => (polarization === 'TE' ? m.teFraction >= 0.5 : m.teFraction < 0.5));
  return fam[order] ?? null;
}

/**
 * Element kernels for post-processing (EO postproc used them; @amp/post may): the solver's own 6-point
 * quadrature rule, basis evaluation, local DOF gather and point fields, exported so derived quantities use exactly the
 * solver interpolation. Read-only; no solver behaviour depends on this export.
 */
export const VECTOR_KERNELS = Object.freeze({ Q4, NLOC, ETA0, newBasisBuffers, evalBasis, gatherLocal, pointFields, newPoint });
