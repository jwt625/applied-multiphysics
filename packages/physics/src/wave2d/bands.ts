// SPDX-License-Identifier: GPL-3.0-or-later
// emw-2d eigenproblems (DevLog-050 s.1.2, s.1.4): `bands` study (Bloch eigenfrequencies along a k path through the
// reciprocal lattice of the periodic conditions) and `eigen` study (closed PEC / PMC cavities and periodic cells at the
// conditions' k). TM (u = E_z): K = int (1/mu_r) grad u . grad v, M = int eps_r u v; TE (u = H_z): K = int (1/eps_r)
// grad u . grad v, M = int mu_r u v; K u = k0^2 M u, f = c0 k0 / (2 pi). Lossless real media only (the pencil is then
// Hermitian). Bloch reduction R = P^H A P (bloch.ts); a complex Hermitian pencil is solved through its real symmetric
// embedding [[Hr, -Hi], [Hi, Hr]] (every eigenvalue doubled) with the shift-invert block Arnoldi of common/eigen.ts;
// when every Bloch phase is real (e.g. Gamma, X, M of a rectangular lattice) the n x n real pencil is solved directly.

import type { FieldData, RunContext, Solution } from '@amp/spec/types';
import { assembleCells } from '../common/scalar.ts';
import { shiftInvertEigen, type EigenResult } from '../common/eigen.ts';
import { analyze } from '@amp/core/la/sparse';
import { SupernodalLDLT } from '@amp/core/la/ldlt';
import { facetsOn, nCells, nNodes } from '../common/mesh.ts';
import { bcsOf, physicsNode, q } from '../common/ctx.ts';
import { StageTimer, makeSolution, attachMesh, checkAbort } from '../common/solution.ts';
import { BlochReduction, PeriodicMap, bandPath, type V2 } from './bloch.ts';
import { media } from './media.ts';
import type { Csr } from './kernel.ts';

const C0 = 299792458;
type Pol = 'TM' | 'TE';

export const EIGEN_BC_TYPES = ['periodic', 'pec', 'pmc'];

export interface BandsData {
  labels: Array<{ index: number; label: string }>;
  /** wave vectors (1/m) and reduced coordinates per path point */
  k: V2[];
  kReduced: number[][];
  /** cumulative path length (1/m), plot axis */
  distance: number[];
  /** eigenfrequencies (Hz) per path point, nBands each */
  f: number[][];
  lattice: { a: V2[]; b: V2[] };
  fieldSteps: Array<{ step: number; label: string; k: number; band: number }>;
}

interface Embedding { pat: Csr; topL: Int32Array; topR: Int32Array; botL: Int32Array; botR: Int32Array }

/** Pattern of the real embedding [[Hr, -Hi], [Hi, Hr]] of a Hermitian matrix on pattern p. */
function embedding(p: Csr): Embedding {
  const n = p.n, nnz = p.nnz;
  const rowptr = new Int32Array(2 * n + 1), colidx = new Int32Array(4 * nnz);
  const topL = new Int32Array(nnz), topR = new Int32Array(nnz), botL = new Int32Array(nnz), botR = new Int32Array(nnz);
  let w = 0;
  for (let half = 0; half < 2; half++) for (let i = 0; i < n; i++) {
    const r = half * n + i;
    rowptr[r] = w;
    for (let blk = 0; blk < 2; blk++) for (let k = p.rowptr[i]!; k < p.rowptr[i + 1]!; k++) {
      colidx[w] = blk * n + p.colidx[k]!;
      (half === 0 ? (blk === 0 ? topL : topR) : (blk === 0 ? botL : botR))[k] = w;
      w++;
    }
  }
  rowptr[2 * n] = w;
  return { pat: { n: 2 * n, rowptr, colidx, nnz: w }, topL, topR, botL, botR };
}

/**
 * Complex eigenvectors of one eigenvalue cluster of the real embedding (DevLog-050 s.9): the cluster's real vectors
 * w = (x, y) stand for complex v = x + j y, and w and its partner (-y, x) are the same complex mode (j v). The first
 * vector is kept as is; each further one is the remaining vector with the largest part M-orthogonal (complex sense,
 * <u, M v> = u^H M v) to those already taken, Gram-Schmidt in M. At most `want` vectors; fewer when the cluster spans
 * fewer independent complex modes (odd multiplicity).
 */
export function clusterVectors(cl: Float64Array[], n: number, pat: Csr, M: { re: Float64Array; im: Float64Array }, want: number): Array<{ re: Float64Array; im: Float64Array }> {
  const mul = (vr: Float64Array, vi: Float64Array): [Float64Array, Float64Array] => {
    const yr = new Float64Array(n), yi = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sr = 0, si = 0;
      for (let t = pat.rowptr[i]!; t < pat.rowptr[i + 1]!; t++) { const j = pat.colidx[t]!, mr = M.re[t]!, mi = M.im[t]!; sr += mr * vr[j]! - mi * vi[j]!; si += mr * vi[j]! + mi * vr[j]!; }
      yr[i] = sr; yi[i] = si;
    }
    return [yr, yi];
  };
  // u^H y
  const dot = (ur: Float64Array, ui: Float64Array, yr: Float64Array, yi: Float64Array): [number, number] => {
    let r = 0, i = 0;
    for (let k = 0; k < n; k++) { r += ur[k]! * yr[k]! + ui[k]! * yi[k]!; i += ur[k]! * yi[k]! - ui[k]! * yr[k]!; }
    return [r, i];
  };
  const out: Array<{ re: Float64Array; im: Float64Array }> = [];
  if (!cl.length || want < 1) return out;
  const cand = cl.map((w) => ({ re: w.slice(0, n), im: w.slice(n, 2 * n) }));
  out.push(cand[0]!);
  const taken: Array<{ re: Float64Array; im: Float64Array; Mr: Float64Array; Mi: Float64Array; nn: number }> = [];
  const take = (v: { re: Float64Array; im: Float64Array }) => { const [Mr, Mi] = mul(v.re, v.im); taken.push({ ...v, Mr, Mi, nn: dot(v.re, v.im, Mr, Mi)[0] }); };
  take(cand[0]!);
  const used = new Set<number>([0]);
  while (out.length < want) {
    let best = -1, bestFrac = 0, bestV: { re: Float64Array; im: Float64Array } | null = null;
    for (let c = 1; c < cand.length; c++) {
      if (used.has(c)) continue;
      const r = { re: Float64Array.from(cand[c]!.re), im: Float64Array.from(cand[c]!.im) };
      const [Mr0, Mi0] = mul(r.re, r.im);
      const n0 = dot(r.re, r.im, Mr0, Mi0)[0];
      // two Gram-Schmidt passes against the taken vectors: r -= u (u^H M r) / (u^H M u)
      for (let pass = 0; pass < 2; pass++) for (const u of taken) {
        const [pr, pi] = dot(u.Mr, u.Mi, r.re, r.im);   // (M u)^H r = u^H M r (M Hermitian)
        const cr = pr / u.nn, ci = pi / u.nn;
        for (let k = 0; k < n; k++) { const a = u.re[k]!, b = u.im[k]!; r.re[k]! -= cr * a - ci * b; r.im[k]! -= cr * b + ci * a; }
      }
      const [Mr, Mi] = mul(r.re, r.im);
      const frac = n0 > 0 ? Math.sqrt(Math.max(0, dot(r.re, r.im, Mr, Mi)[0]) / n0) : 0;
      if (frac > bestFrac) { best = c; bestFrac = frac; bestV = r; }
    }
    if (best < 0 || bestFrac < 1e-6 || !bestV) break;   // the cluster holds no further independent complex mode
    used.add(best); out.push(bestV); take(bestV);
  }
  return out;
}

/** Number of eigenvalues of K x = lambda M x below theta (Sylvester inertia of K - theta M, LDL^T). */
function inertiaBelow(pat: Csr, K: Float64Array, M: Float64Array, theta: number): number | null {
  const A = new Float64Array(pat.nnz);
  for (let q = 0; q < pat.nnz; q++) A[q] = K[q]! - theta * M[q]!;
  const f = new SupernodalLDLT(analyze(pat));
  const r = f.factor(A);
  return r.ok && r.nPerturbed === 0 ? (r.nNeg ?? null) : null;
}

/**
 * Lowest `want` eigenpairs (or those closest to sigma when sigma > 0) with a completeness check: the Sylvester inertia
 * at a point inside the first gap after the wanted ones must equal the number of computed eigenvalues below it; a
 * missed eigenvalue (possible with Krylov methods on clustered spectra) triggers a retry with a larger search space.
 */
function checkedEigen(pat: Csr, K: Float64Array, M: Float64Array, sigma: number, want: number, block: number, signal: AbortSignal | undefined, notes: string[]): EigenResult {
  let e: EigenResult | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const nWant = Math.min(want + 2 + 6 * attempt, pat.n);
    e = shiftInvertEigen({ pat, K, M, sigma, nWant, kPsd: sigma < 0, tol: 1e-11, blockSize: block, maxBasis: Math.max(40, 3 * nWant + 2 * block), seed: 20261118 + attempt, ...(signal ? { signal } : {}) });
    if (sigma > 0) return e;   // shifted search: no lower-end completeness claim
    const L = Array.from(e.lambda);
    // first gap at or after index want - 1
    let g = -1;
    for (let i = Math.max(0, want - 1); i + 1 < L.length; i++) if (L[i + 1]! - L[i]! > 1e-6 * Math.max(Math.abs(L[i + 1]!), 1e-300)) { g = i; break; }
    if (g < 0) { if (nWant >= pat.n) return e; continue; }
    const theta = 0.5 * (L[g]! + L[g + 1]!);
    const cnt = inertiaBelow(pat, K, M, theta);
    if (cnt === null || cnt === g + 1) return e;
    if (attempt === 3) notes.push(`eigen: ${cnt} eigenvalues lie below ${theta.toPrecision(6)} but ${g + 1} were found after 4 attempts; some bands may be missing`);
  }
  return e!;
}

export async function solveEmwEigen(ctx: RunContext): Promise<Solution & { wave2d: unknown; notes?: string[]; normalization?: string }> {
  const timer = new StageTimer();
  const { spec, mesh, study } = ctx;
  const phys = physicsNode(spec, ctx.physicsId);
  const pol = (phys.settings as { polarization?: Pol } | undefined)?.polarization;
  if (pol !== 'TM' && pol !== 'TE') throw new Error('emw-2d: settings.polarization (TM or TE) is required');
  const isBands = study.type === 'bands';
  timer.start('assemble');
  const md = media(ctx, 'emw', { wavelength: false });   // eigen / bands studies bind no wavelength
  const notes = [...md.notes];
  const nc = nCells(mesh), nn = nNodes(mesh);
  const bcs = bcsOf(spec, ctx.physicsId);
  const bad = bcs.filter((b) => !EIGEN_BC_TYPES.includes(b.type));
  if (bad.length) throw new Error(`${isBands ? 'bands' : 'eigen'} study of emw-2d: conditions ${bad.map((b) => `'${b.id}' (${b.type})`).join(', ')} are not supported (lossless eigenproblems take ${EIGEN_BC_TYPES.join(', ')})`);
  const aC = new Float64Array(nc), bC = new Float64Array(nc);
  let nMax = 0;
  for (let c = 0; c < nc; c++) {
    if (!md.mask[c]) continue;
    const er = md.epsRe[c]!, ei = md.epsIm[c]!, mu = md.mu[c]!;
    const dom = mesh.entities.domains[mesh.cells.domain[c]!]?.id ?? `#${mesh.cells.domain[c]}`;
    if (ei !== 0) throw new Error(`${isBands ? 'bands' : 'eigen'} study of emw-2d: the material of ${dom} is lossy (tan_delta or kappa); band and eigen studies take lossless media (the pencil must be Hermitian)`);
    if (!(er > 0) || !(mu > 0)) throw new Error(`${isBands ? 'bands' : 'eigen'} study of emw-2d: the material of ${dom} has eps_r = ${er}, mu_r = ${mu}; band and eigen studies need positive values`);
    if (pol === 'TM') { aC[c] = 1 / mu; bC[c] = er; } else { aC[c] = 1 / er; bC[c] = mu; }
    nMax = Math.max(nMax, Math.sqrt(er * mu));
  }
  const A = assembleCells(mesh, { k: aC, m: bC, mask: md.mask });
  const K = A.K!, M = A.M!;
  const excluded = new Uint8Array(nn);
  for (let i = 0; i < nn; i++) if (!A.active[i]) excluded[i] = 1;
  const dirType = pol === 'TM' ? 'pec' : 'pmc';
  const kf = mesh.facets.type === 'line3' ? 3 : 2;
  for (const b of bcs.filter((x) => x.type === dirType)) for (const f of facetsOn(mesh, b.select)) for (let a = 0; a < kf; a++) excluded[mesh.facets.conn[kf * f + a]!] = 1;
  const perConds = bcs.filter((b) => b.type === 'periodic').map((b) => {
    const s = (b.settings ?? {}) as { k?: unknown };
    return { id: b.id, facets: facetsOn(mesh, b.select), ...(s.k !== undefined ? { k: q(spec, s.k, `${b.id}.k`) } : {}) };
  });
  const pm = new PeriodicMap(mesh, perConds);
  const red = new BlochReduction(mesh, pm, A.pat, excluded);
  timer.stop('assemble');
  if (red.n === 0) throw new Error('emw-2d eigenproblem: no free unknowns (every node is fixed)');
  // k points
  const s = (study.settings ?? {}) as { kPath?: Array<{ label: string; k: number[] }>; interpolate?: number; nBands?: number; nModes?: number; shift?: unknown };
  let kRed: number[][], kLabel: Array<string | null>;
  let nWantPhys: number, sigma: number;
  // spectral scale: k0^2 of the lowest folded mode of a uniform cell of size L with the largest index (for the shift only)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < nn; i++) { if (!A.active[i]) continue; const x = mesh.nodes[2 * i]!, y = mesh.nodes[2 * i + 1]!; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const lamScale = (2 * Math.PI / Math.hypot(x1 - x0, y1 - y0)) ** 2 / (nMax * nMax);
  if (isBands) {
    if (!pm.lattice.length) throw new Error('bands study: the physics has no periodic condition (the cell needs one or two periodic pairs)');
    const path = bandPath(s.kPath ?? [], s.interpolate ?? 4);
    kRed = path.k; kLabel = path.label;
    nWantPhys = s.nBands ?? 8;
    sigma = -1e-3 * lamScale;
  } else {
    kRed = [pm.kSetting.map((v) => v ?? 0)]; kLabel = ['k'];
    nWantPhys = s.nModes ?? 6;
    const shift = s.shift !== undefined ? q(spec, s.shift, `study ${study.id} shift`) : 0;
    sigma = shift > 0 ? (2 * Math.PI * shift / C0) ** 2 : -1e-3 * lamScale;
  }
  const kVec: V2[] = kRed.map((kr) => (pm.lattice.length ? pm.kFromReduced(kr) : [0, 0] as V2));
  const nb = Math.min(nWantPhys, red.n);
  const allF: number[][] = [];
  const fields: FieldData[] = [];
  const fieldSteps: BandsData['fieldSteps'] = [];
  const stepVals: number[] = [];
  const scalars: Solution['scalars'] = {};
  const U = pol === 'TM' ? 'Ez' : 'Hz', uUnit = pol === 'TM' ? 'V/m' : 'A/m';
  const space = mesh.cells.type === 'tri6' ? 'H1P2' : 'H1P1';
  let emb: Embedding | null = null;
  const seenLabel = new Set<string>();
  let resMax = 0, nUnpaired = 0;
  for (let ki = 0; ki < kRed.length; ki++) {
    checkAbort(ctx.signal);
    ctx.progress?.('solve', ki / kRed.length, `k point ${ki + 1} of ${kRed.length}`);
    const ph = pm.phases(kVec[ki]!);
    const Kc = red.reduce(A.pat, K, null, ph), Mc = red.reduce(A.pat, M, null, ph);
    let isReal = true;
    for (let t = 0; t < Kc.im.length && isReal; t++) if (Math.abs(Kc.im[t]!) > 1e-13 * Math.abs(Kc.re[t]!) + 1e-300 || Math.abs(Mc.im[t]!) > 1e-13 * Math.abs(Mc.re[t]!) + 1e-300) isReal = false;
    timer.start('solve');
    let lam: number[], vecs: Array<{ re: Float64Array; im: Float64Array }>;
    if (isReal) {
      const e = checkedEigen(red.pat, Kc.re, Mc.re, sigma, nb, 4, ctx.signal, notes);
      resMax = Math.max(resMax, ...e.residual);
      lam = Array.from(e.lambda); vecs = e.vecs.map((v) => ({ re: v, im: new Float64Array(v.length) }));
    } else {
      emb ??= embedding(red.pat);
      const Ke = new Float64Array(emb.pat.nnz), Me = new Float64Array(emb.pat.nnz);
      for (let t = 0; t < red.pat.nnz; t++) {
        Ke[emb.topL[t]!] = Kc.re[t]!; Ke[emb.botR[t]!] = Kc.re[t]!; Ke[emb.topR[t]!] = -Kc.im[t]!; Ke[emb.botL[t]!] = Kc.im[t]!;
        Me[emb.topL[t]!] = Mc.re[t]!; Me[emb.botR[t]!] = Mc.re[t]!; Me[emb.topR[t]!] = -Mc.im[t]!; Me[emb.botL[t]!] = Mc.im[t]!;
      }
      const e = checkedEigen(emb.pat, Ke, Me, sigma, 2 * nb, 8, ctx.signal, notes);
      resMax = Math.max(resMax, ...e.residual);
      // every eigenvalue of the embedding is doubled: clusters of multiplicity 2 m hold m complex eigenvectors
      lam = []; vecs = [];
      const L = Array.from(e.lambda);
      for (let i = 0; i < L.length;) {
        let j = i + 1;
        while (j < L.length && Math.abs(L[j]! - L[i]!) <= 1e-7 * Math.max(Math.abs(L[i]!), lamScale * 1e-6)) j++;
        const m = j - i;
        if (m % 2 && j < L.length) nUnpaired++;
        // a degenerate cluster (m > 2) holds several complex modes: take them complex M-orthogonal (DevLog-050 s.9);
        // an isolated pair keeps its first vector as before
        const nm = Math.ceil(m / 2);
        const cv = m > 2 ? clusterVectors(e.vecs.slice(i, j), red.n, red.pat, Mc, nm) : [];
        for (let t = 0; t < nm; t++) {
          lam.push(L[i + 2 * t] ?? L[i]!);
          const v = e.vecs[Math.min(i + 2 * t, j - 1)]!, n = red.n;
          vecs.push(cv[t] ?? { re: v.slice(0, n), im: v.slice(n, 2 * n) });
        }
        i = j;
      }
    }
    timer.stop('solve');
    const fk = lam.slice(0, nb).map((l) => (l > 1e-10 * lamScale ? (C0 * Math.sqrt(l)) / (2 * Math.PI) : 0));   // the constant mode at Gamma: 0
    allF.push(fk);
    fk.forEach((f, b) => { scalars[isBands ? `f_${b}_${ki}` : `f_${b}`] = { value: f, unit: 'Hz' }; });
    if (isBands) { scalars[`kx_${ki}`] = { value: kVec[ki]![0], unit: '1/m' }; scalars[`ky_${ki}`] = { value: kVec[ki]![1], unit: '1/m' }; }
    // fields: every band at each distinct labelled path point (eigen study: every mode)
    const lab = kLabel[ki];
    const keyK = kRed[ki]!.map((v) => v.toFixed(12)).join(',');
    if (lab !== null && lab !== undefined && !seenLabel.has(keyK)) {
      seenLabel.add(keyK);
      timer.start('post');
      for (let b = 0; b < fk.length; b++) {
        const v = vecs[b]!;
        const ur = new Float64Array(nn), ui = new Float64Array(nn);
        red.expand(v.re, v.im, ph, ur, ui);
        // normalise: largest |u| = 1 and real positive there
        let im = 0, mx = -1;
        for (let i = 0; i < nn; i++) { const a = ur[i]! ** 2 + ui[i]! ** 2; if (a > mx) { mx = a; im = i; } }
        const sc = Math.sqrt(mx) || 1, cr = ur[im]! / sc, ci = -ui[im]! / sc;
        for (let i = 0; i < nn; i++) { const a = ur[i]!, c = ui[i]!; ur[i] = (a * cr - c * ci) / sc; ui[i] = (a * ci + c * cr) / sc; }
        const step = stepVals.length;
        stepVals.push(fk[b]!);
        fieldSteps.push({ step, label: lab, k: ki, band: b });
        fields.push({ name: `${U}_re`, unit: uUnit, space, components: 1, data: ur, step });
        fields.push({ name: `${U}_im`, unit: uUnit, space, components: 1, data: ui, step });
        fields.push({ name: `${U}_abs`, unit: uUnit, space, components: 1, data: Float64Array.from(ur, (x, i) => Math.hypot(x, ui[i]!)), step });
      }
      timer.stop('post');
    }
  }
  if (nUnpaired) notes.push(`${nUnpaired} eigenvalue cluster(s) of the real embedding had odd multiplicity below the cut-off (a degenerate partner was not resolved); frequencies are still reported once per pair`);
  if (isBands) for (let b = 0; b < nb; b++) {
    const col = allF.map((r) => r[b]!).filter((v) => v !== undefined);
    scalars[`fmax_${b}`] = { value: Math.max(...col), unit: 'Hz' };
    scalars[`fmin_${b}`] = { value: Math.min(...col), unit: 'Hz' };
  }
  const dist: number[] = [0];
  for (let i = 1; i < kVec.length; i++) dist.push(dist[i - 1]! + Math.hypot(kVec[i]![0] - kVec[i - 1]![0], kVec[i]![1] - kVec[i - 1]![1]));
  const sol = await makeSolution({
    mesh, spec, fields, steps: { kind: 'eigen', values: Float64Array.from(stepVals), unit: 'Hz' }, scalars,
    stats: { dof: red.n, nnz: red.pat.nnz, residual: resMax, solver: `Bloch-reduced Hermitian pencil, shift-invert block Arnoldi (real embedding at complex phases)` },
    timer,
  });
  attachMesh(sol, mesh);
  const out = sol as Solution & { wave2d: unknown; notes?: string[]; normalization?: string };
  const lattice = pm.lattice.length ? { a: pm.lattice, b: pm.lattice.length <= 2 ? pm.reciprocal() : [] } : { a: [], b: [] };
  const bands: BandsData = {
    labels: kLabel.flatMap((l, i) => (l === null ? [] : [{ index: i, label: l }])), k: kVec, kReduced: kRed, distance: dist, f: allF, lattice, fieldSteps,
  };
  out.wave2d = { kind: 'emw', polarization: pol, field: U, study: isBands ? 'bands' : 'eigen', bands };
  notes.push(isBands ? `bands: ${kRed.length} k points, ${nb} bands; fields of every band at the labelled points (steps in path order)` : `eigen: ${nb} modes${pm.lattice.length ? ` at the Bloch wave vector (${kVec[0]![0].toPrecision(6)}, ${kVec[0]![1].toPrecision(6)}) 1/m` : ''}`);
  out.notes = notes;
  out.normalization = 'eigenmodes scaled to a largest modulus of 1 (V/m for E_z, A/m for H_z), real and positive there; time convention exp(+j omega t), Bloch phase u(x + a) = u(x) exp(-j k.a)';
  return out;
}
