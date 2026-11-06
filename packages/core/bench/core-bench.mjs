// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/core solver benchmarks (DevLog-002 gate 3): one workload per solver family, each timed with the @amp/core
// solver and with the atlas solver on the same matrix in the same process (median of --runs after one warm-up), and
// compared with the atlas's logged timing. Workload matrices come from the atlases (read only, imported from the
// paths given): EO mesher + electrostatics / vector-mode model, APA grid + thermal operator, APA em3d layered mesh.
// Nothing is written to the atlases. One JSONL record per family to logs/core-bench-<YYYYMMDDTHHMMSS>.jsonl.
// Usage (from packages/core): nice -n 10 node --max-old-space-size=1536 bench/core-bench.mjs --eo <eo>/engine
//   --apa <apa>/engine [--runs 5] [--only direct,arnoldi,mg,pmg]   (or env AMP_EO_ATLAS / AMP_APA_ATLAS)
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import * as coreSparse from '../src/la/sparse.mjs';
import * as coreLdlt from '../src/la/ldlt.mjs';
import { blockArnoldi, dotv } from '../src/la/arnoldi.mjs';
import { buildMG, mgPrecond } from '../src/la/mg.mjs';
import { pcg } from '../src/la/pcg.mjs';
import { buildPMG } from '../src/la/pmg.mjs';
import { gmres } from '../src/la/krylov.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EO = arg('eo', process.env.AMP_EO_ATLAS), APA = arg('apa', process.env.AMP_APA_ATLAS);
const RUNS = Number(arg('runs', 5));
const ONLY = (arg('only', 'direct,arnoldi,mg,pmg')).split(',');
const p2 = (v) => String(v).padStart(2, '0');
const d = new Date();
const STAMP = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const LOG = arg('out', join(REPO, 'logs', `core-bench-${STAMP}.jsonl`));
mkdirSync(dirname(LOG), { recursive: true });
const imp = (root, rel) => import(pathToFileURL(join(root, rel)).href);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };
const r3 = (x) => (x == null ? null : +x.toPrecision(4));
/** A/B timing in one process: one warm-up each, then RUNS rounds alternating the order (A B, B A, ...). */
function abTime(fa, fb) {
  let la = fa(), lb = fb();
  const ta = [], tb = [];
  for (let r = 0; r < RUNS; r++) {
    const one = (f, out) => { const t0 = performance.now(); const v = f(); out.push(performance.now() - t0); return v; };
    if (r % 2 === 0) { la = one(fa, ta); lb = one(fb, tb); } else { lb = one(fb, tb); la = one(fa, ta); }
  }
  return [{ median: median(ta), all: ta.map(r3), last: la }, { median: median(tb), all: tb.map(r3), last: lb }];
}
const ratio = (a, b) => (a != null && b ? r3(a / b) : null);
const platform = { node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length, loadavg: os.loadavg().map(r3) };
function record(rec) {
  const row = { date: new Date().toISOString(), ...platform, runs: RUNS, ...rec };
  appendFileSync(LOG, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}
const readJsonl = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---- 1. direct: supernodal Cholesky on the EO electrostatics matrix, supernodal LDL^T on the EO vector pencil ----
async function benchDirect() {
  const { applyOverrides } = await imp(EO, 'src/yaml-edit.mjs');
  const { parseConfig, crossSectionOf } = await imp(EO, 'src/config.mjs');
  const { solveElectrostatics } = await imp(EO, 'src/electrostatics.mjs');
  const eoSparse = await imp(EO, 'src/sparse.mjs');
  const text = applyOverrides(readFileSync(join(EO, '..', 'sims', 'mao2022', 'config.yaml'), 'utf8'), [['template.mesh.element_order', 1]]);
  const cfg = parseConfig(text);
  const es = solveElectrostatics(crossSectionOf(cfg, 'geometry'), { resolvedMaterials: cfg.materials, meshScale: 1, elementOrder: 1 });
  const subs = [es.solver.sub, es.solver0.sub];
  const pat = subs[0].pat;
  // as EO electrostatics: ordering + symbolic once, two numeric factorizations (dielectric and vacuum)
  const run = (S) => () => {
    const t0 = performance.now();
    const ch = new S.SparseCholesky(pat);
    const t1 = performance.now();
    let ok = ch.factor(subs[0].val);
    const ch0 = new S.SparseCholesky(pat, null, { sym: ch.sym });
    ok = ch0.factor(subs[1].val) && ok;
    const t2 = performance.now();
    if (!ok) throw new Error('factor failed');
    return { analyze_ms: t1 - t0, factor_ms: t2 - t1, nnzL: ch.sym.nnzL, x: ch.solve(Float64Array.from({ length: pat.n }, (_, i) => Math.sin(i))) };
  };
  const out = {};
  const rows = { core: [], atlas: [] };
  const tt = abTime(() => { const r = run(coreSparse)(); rows.core.push(r); return r; }, () => { const r = run(eoSparse)(); rows.atlas.push(r); return r; });
  for (const [q, k] of [[0, 'core'], [1, 'atlas']]) {
    const t = tt[q], rr = rows[k].slice(1);
    out[k] = { wall_ms: r3(t.median), factor_ms: r3(median(rr.map((r) => r.factor_ms))), analyze_ms: r3(median(rr.map((r) => r.analyze_ms))), nnzL: t.last.nnzL, x: t.last.x };
  }
  let dx = 0;
  for (let i = 0; i < pat.n; i++) dx = Math.max(dx, Math.abs(out.core.x[i] - out.atlas.x[i]));
  const logFile = join(EO, '..', 'logs', 'bench-20261015T0926.jsonl');
  const ref = readJsonl(logFile).find((r) => r.id === 'mao2022-es-p1')?.phases?.electrostatics;
  record({ family: 'direct-cholesky', workload: 'EO mao2022 electrostatics P1 (sims/mao2022/config.yaml, template.mesh.element_order 1 as EO bench pinOverrides, meshScale 1), SparseCholesky: analyze once + 2 numeric factors', n: pat.n, nnzA: pat.nnz,
    core: { factor_ms: out.core.factor_ms, analyze_ms: out.core.analyze_ms, nnzL: out.core.nnzL }, atlas_inprocess: { factor_ms: out.atlas.factor_ms, analyze_ms: out.atlas.analyze_ms, nnzL: out.atlas.nnzL },
    atlas_log: ref ? { file: 'eo-modulator-atlas/logs/bench-20261015T0926.jsonl', id: 'mao2022-es-p1', factor_ms: r3(ref.factor_ms), nFactor: ref.nFactor, ordering_ms: r3(ref.ordering_ms), symbolic_ms: r3(ref.symbolic_ms), nFree: ref.nFree, nnzL: ref.nnzL } : null,
    core_vs_inprocess: ratio(out.core.factor_ms, out.atlas.factor_ms), core_vs_log: ratio(out.core.factor_ms, ref?.factor_ms), solution_max_abs_diff: dx });

  // indefinite LDL^T: EO vector-mode K2 order 1 pencil K = A + sigma B (validation/cases/K2.yaml, vector-bench row 1)
  const vm = await vectorModel();
  const { n, K, sym } = vm;
  const eoLdlt = await imp(EO, 'src/ldlt.mjs');
  const runL = (L) => () => { const f = new L.SupernodalLDLT(sym); const r = f.factor(K); return { r, x: f.solve(Float64Array.from({ length: n }, (_, i) => Math.cos(i))) }; };
  const [tc, ta] = abTime(runL(coreLdlt), runL(eoLdlt));
  let dl = 0;
  for (let i = 0; i < n; i++) dl = Math.max(dl, Math.abs(tc.last.x[i] - ta.last.x[i]));
  const vref = vm.ref;
  record({ family: 'direct-ldlt-indefinite', workload: 'EO K2 TFLN rib vector modes, order 1, refine box h 0.06 um (vector-bench row order1_box0.06), SupernodalLDLT numeric factor of A + sigma B at the default shift', n, nnzL: sym.nnzL,
    core: { factor_ms: r3(tc.median), nNeg: tc.last.r.nNeg, nPerturbed: tc.last.r.nPerturbed }, atlas_inprocess: { factor_ms: r3(ta.median), nNeg: ta.last.r.nNeg },
    atlas_log: vref ? { file: 'eo-modulator-atlas/logs/vector-bench-20261015T1511Z.jsonl', label: vref.label, factorMs: vref.solveMedianMs.factorMs, dof: vref.dof, nnzL: vref.nnzL, note: 'factorMs includes forming K = A + sigma B' } : null,
    core_vs_inprocess: ratio(tc.median, ta.median), core_vs_log: ratio(tc.median, vref?.solveMedianMs.factorMs), solution_max_abs_diff: dl });
}

let VM = null;
async function vectorModel() {
  if (VM) return VM;
  const { parseConfig, crossSectionOf, opticalOptions } = await imp(EO, 'src/config.mjs');
  const { buildVectorModel, vectorMaterialTensors, assembleVector, solveVectorModes } = await imp(EO, 'src/vector-mode.mjs');
  const cfg = parseConfig(readFileSync(join(EO, '..', 'validation', 'cases', 'K2.yaml'), 'utf8'));
  const lambda0Um = opticalOptions(cfg.raw).lambda0Um;
  const modelOptions = { lambda0Um, order: 1, refine: [{ x: [-1.6, 1.6], y: [-0.6, 1.1], h_um: 0.06 }], hints: { max_edge_um: 0.4, grade: 0.25 } };
  const model = buildVectorModel(crossSectionOf(cfg, 'geometry'), cfg.materials, modelOptions);
  const k0 = (2 * Math.PI) / lambda0Um;
  const mt = vectorMaterialTensors(model, lambda0Um, {});
  const nTarget = mt.nMax * Math.sqrt(1 + 1e-3); // EO solveVectorModes nDefault (lossless)
  const sigma = k0 * k0 * nTarget * nTarget;
  const { A, B } = assembleVector(model, mt.eps, k0, true);
  const pat = model.pattern.pat, n = pat.n;
  const K = new Float64Array(pat.nnz);
  for (let q = 0; q < K.length; q++) K[q] = A[q] + sigma * B[q];
  const ref = readJsonl(join(EO, '..', 'logs', 'vector-bench-20261015T1511Z.jsonl')).find((r) => r.case === 'K2' && r.label === 'order1_box0.06');
  VM = { model, k0, sigma, nTarget, A, B, K, pat, n, sym: model.sym, nZ: model.dof.nZDof, lambda0Um, solveVectorModes, ref };
  return VM;
}

// ---- 2. Arnoldi: shift-invert block Arnoldi on the EO K2 order-1 pencil (solveReal default path) ----
async function benchArnoldi() {
  const vm = await vectorModel();
  const { pat, n, A, B, K, sym, sigma, nTarget, k0, lambda0Um, solveVectorModes, ref } = vm;
  const csrMatVec = (val, x, out) => { for (let i = 0; i < n; i++) { let s = 0; for (let p = pat.rowptr[i]; p < pat.rowptr[i + 1]; p++) s += val[p] * x[pat.colidx[p]]; out[i] = s; } return out; };
  const f = new coreLdlt.SupernodalLDLT(sym);
  const fr = f.factor(K);
  if (!fr.ok || fr.nPerturbed) throw new Error('unexpected factor result');
  // EO solveReal (no warm, no nTarget, adaptiveShift default): first cycle basis max(numModes + 8, 12), onFirstRestart
  // switches only when nTarget / nTopEst > 1.34; numModes 2, tol 1e-7, blockSize 1, maxBasis max(20, 3 numModes + 8)
  const numModes = 2;
  const eig = () => {
    let solves = 0;
    const op = (X) => {
      const m = X.length, rhs = new Float64Array(n * m);
      for (let c = 0; c < m; c++) csrMatVec(B, X[c], rhs.subarray(c * n, (c + 1) * n));
      solves += m;
      const sol = m === 1 ? f.solve(rhs) : f.solveMany(rhs, m);
      return X.map((_, c) => sol.slice(c * n, (c + 1) * n));
    };
    const arOpts = { nWant: numModes, blockSize: 1, maxBasis: Math.max(20, 3 * numModes + 8), tol: 1e-7, maxRestarts: 30, seed: 20261014, realOnly: true };
    let switched = false;
    const ar = blockArnoldi(n, op, { ...arOpts, firstCycleBasis: Math.max(numModes + 8, 12), onFirstRestart: (mus) => {
      const thetas = mus.filter((m) => m.re !== 0).map((m) => sigma - 1 / m.re);
      const top = Math.max(...thetas);
      if (!(top > 0)) return false;
      switched = nTarget / (Math.sqrt(top) / k0) > 1.34;
      return switched;
    } });
    if (switched) throw new Error('adaptive shift would switch: this bench reproduces only the no-switch path');
    let vecs = ar.vecs.map((v) => v.re);
    vecs = op(vecs);
    for (const v of vecs) { const nv = Math.sqrt(dotv(v, v)); for (let i = 0; i < n; i++) v[i] /= nv; }
    const neff = vecs.map((x) => { const Ax = csrMatVec(A, x, new Float64Array(n)), Bx = csrMatVec(B, x, new Float64Array(n)); return Math.sqrt(-dotv(x, Ax) / dotv(x, Bx)) / k0; }).sort((a, b) => b - a);
    return { solves, neff, restarts: ar.restarts, converged: ar.converged };
  };
  const eoAll = [];
  const [tc, te] = abTime(eig, () => { const res = solveVectorModes(vm.model, lambda0Um, { numModes, fields: true }); eoAll.push(res.timing.eigenMs); return res; });
  const eoRuns = eoAll.slice(1), eoLast = te.last;
  const eoNeff = eoLast.modes.map((m) => m.neff).sort((a, b) => b - a);
  record({ family: 'arnoldi', workload: 'EO K2 TFLN rib vector modes, order 1, h 0.06 um box, 2 modes, tol 1e-7: shift-invert block Arnoldi (thick restart) + 1 refinement step on core SupernodalLDLT', n,
    core: { eigen_ms: r3(tc.median), operatorApplications: tc.last.solves, restarts: tc.last.restarts, converged: tc.last.converged, neff: tc.last.neff },
    atlas_inprocess: { eigen_ms: r3(median(eoRuns)), operatorApplications: eoLast.stats.operatorApplications, shift: eoLast.shift.source, neff: eoNeff },
    atlas_log: ref ? { file: 'eo-modulator-atlas/logs/vector-bench-20261015T1511Z.jsonl', label: ref.label, eigenMs: ref.solveMedianMs.eigenMs, operatorApplications: ref.operatorApplications, te0_neff: ref.te0.neff } : null,
    core_vs_inprocess: ratio(tc.median, median(eoRuns)), core_vs_log: ratio(tc.median, ref?.solveMedianMs.eigenMs),
    neff_max_abs_diff_vs_inprocess: Math.max(...tc.last.neff.map((v, i) => Math.abs(v - eoNeff[i]))) });
}

// ---- 3. PCG + GMG on the APA thermal bench grid M ----
async function apaBenchGrid() {
  // APA bench/bench.mjs is a script (not imported here, so nothing runs or writes in the atlas); its workload
  // definitions benchParts, K, benchThermal and GRIDS.M are re-declared verbatim from fe39985 lines 16-44
  const P = (id, kind, material, x, y, w, dd, z, h, extra = {}) => ({ id, kind, material, x_mm: x, y_mm: y, w_mm: w, d_mm: dd, z_um: z, h_um: h, ...extra });
  const parts = [
    P('substrate', 'substrate', 'sub', 0, 0, 55, 55, 0, 1600), P('c4uf', 'underfill', 'uf', 0, 0, 34, 28, 1600, 80),
    P('interposer', 'interposer', 'si', 0, 0, 32, 26, 1680, 100), P('ubump', 'microbump', 'ubump', 0, 0, 30, 24, 1780, 30),
    P('soc', 'die', 'si', 0, 0, 14, 20, 1810, 775), P('hbm_1', 'hbm', 'si', -11.5, -6, 8, 11, 1810, 775), P('hbm_2', 'hbm', 'si', 11.5, -6, 8, 11, 1810, 775),
    P('hbm_3', 'hbm', 'si', -11.5, 6, 8, 11, 1810, 775), P('hbm_4', 'hbm', 'si', 11.5, 6, 8, 11, 1810, 775), P('mold', 'mold', 'mold', 0, 0, 32, 26, 1810, 775, { priority: -1 }),
    P('tim', 'tim', 'tim', 0, 0, 32, 26, 2585, 50), P('lid', 'lid', 'cu', 0, 0, 50, 50, 2635, 2000),
  ];
  const K = { sub: [30, 30, 0.6], si: [148, 148, 148], uf: [0.5, 0.5, 0.5], mold: [0.8, 0.8, 0.8], tim: [5, 5, 5], cu: [390, 390, 390], ubump: [2, 2, 20] };
  const thermal = { sources: [{ parts: 'soc', power_W: 500 }, { parts: 'hbm_*', power_W: 120 }],
    bcs: [{ selection: 'top:lid', type: 'htc', h_W_m2K: 3e4, T_inf_C: 30 }, { selection: 'bottom:substrate', type: 'htc', h_W_m2K: 500, T_inf_C: 30 }] };
  const M = { max_xy_mm: 1.0, min_cells_per_layer: 2, grading: 1.3, max_z_mm: 0.4 };
  return { parts, K, thermal, M };
}
async function benchMG() {
  const { buildGrid } = await imp(APA, 'src/grid/index.mjs');
  const th = await imp(APA, 'src/thermal/index.mjs');
  const { applyConstraints } = await imp(APA, 'src/thermal/assemble.mjs');
  const apaMg = await imp(APA, 'src/la/mg.mjs'), apaPcg = await imp(APA, 'src/la/pcg.mjs'), apaSt = await imp(APA, 'src/la/stencil.mjs');
  const { parts, K, thermal, M } = await apaBenchGrid();
  const grid = buildGrid(parts, M);
  const resolve = (key) => ({ k_W_mK: K[key] });
  // atlas in-process: APA solveThermal pcg_mg rtol 1e-10 (bench.mjs SOLVERS.pcg_mg)
  const apaRuns = [];
  let apaLast = null;
  for (let r = 0; r <= RUNS; r++) { apaLast = th.solveThermal(grid, thermal, resolve, { solver: 'pcg_mg', rtol: 1e-10 }); if (r) apaRuns.push(apaLast.timing); }
  // the same operator for the core solver: APA prepareThermal + assembleThermal + applyConstraints (cellK as APA with exact k)
  const prep = th.prepareThermal(grid, thermal);
  const k = new Float64Array(6 * grid.cellMat.length);
  for (let c = 0; c < grid.cellMat.length; c++) if (grid.cellMat[c] >= 0) k.set(th.kComponents(K[grid.materials[grid.cellMat[c]]], grid.materials[grid.cellMat[c]]), 6 * c);
  const A = th.assembleThermal(prep, { k, tensor: false });
  applyConstraints(A.op, A.F, prep.Td, prep.active);
  const fresh = () => ({ ...A.op, A: A.op.A.slice(), fixed: A.op.fixed.slice() });
  const solveWith = (mgMod, pcgMod, stMod) => () => {
    const op = fresh();
    const t0 = performance.now();
    const mg = mgMod.buildMG(op, grid.xs, grid.ys, { coarseMax: 6000, ordering: 'nd' });
    const t1 = performance.now();
    const b = stMod.padded(op), x = stMod.padded(op);
    b.set(A.F, op.pad);
    const r = pcgMod.pcg(op, (rr, z) => mgMod.mgPrecond(mg, rr, z), b, x, { rtol: 1e-10, maxIter: 1000, ref: 'b' });
    const t2 = performance.now();
    return { setup_ms: t1 - t0, solve_ms: t2 - t1, iterations: r.iterations, relres: r.relres, x, levels: mg.stats.levels };
  };
  const coreSt = await import('../src/la/stencil.mjs');
  const cAll = [], aAll = [];
  abTime(() => { const v = solveWith({ buildMG, mgPrecond }, { pcg }, coreSt)(); cAll.push(v); return v; }, () => { const v = solveWith(apaMg, apaPcg, apaSt)(); aAll.push(v); return v; });
  const cRows = cAll.slice(1), aRows = aAll.slice(1);
  const sum = (rows) => ({ setup_ms: r3(median(rows.map((q) => q.setup_ms))), solve_ms: r3(median(rows.map((q) => q.solve_ms))), setup_plus_solve_ms: r3(median(rows.map((q) => q.setup_ms + q.solve_ms))), iterations: rows.at(-1).iterations, levels: rows.at(-1).levels });
  let dx = 0;
  const xc = cRows.at(-1).x, xa = aRows.at(-1).x;
  for (let i = 0; i < xc.length; i++) dx = Math.max(dx, Math.abs(xc[i] - xa[i]));
  const ref = readJsonl(join(APA, '..', 'logs', 'bench-20261020T1427.jsonl')).find((r) => r.grid === 'M' && r.solver === 'pcg_mg');
  const core = sum(cRows), atl = sum(aRows);
  const apaSolve = { setup_ms: r3(median(apaRuns.map((t) => t.setup_ms))), solve_ms: r3(median(apaRuns.map((t) => t.solve_ms))), iterations: apaLast.timing.iterations };
  record({ family: 'pcg-gmg', workload: 'APA thermal bench grid M (bench.mjs benchParts, GRIDS.M), PCG + z-line GMG, rtol 1e-10 (ref b), coarseMax 6000, ordering nd', nodes: A.op.N,
    core, atlas_inprocess: atl, atlas_solveThermal_inprocess: apaSolve,
    atlas_log: ref ? { file: 'advanced-packaging-atlas/logs/bench-20261020T1427.jsonl', grid: 'M', label: ref.label, setup_ms: r3(ref.setup_ms), solve_ms: r3(ref.solve_ms), iterations: ref.iterations, nodes: ref.nodes } : null,
    core_vs_inprocess: ratio(core.setup_plus_solve_ms, atl.setup_plus_solve_ms), core_vs_log: ratio(core.setup_plus_solve_ms, ref ? ref.setup_ms + ref.solve_ms : null), solution_max_abs_diff_K: dx });
}

// ---- 4. GMRES + p-MG on an APA em3d case (TE10 guide, order 2, iterative; em3d-p2.test.mjs te10) ----
async function benchPMG() {
  const { buildLayeredMesh } = await imp(APA, 'src/em3d/mesh.mjs');
  const { prepare3d, solveAt } = await imp(APA, 'src/em3d/solver.mjs');
  const { makeMaterials } = await imp(APA, 'src/em2d/dielectric.mjs');
  const mesh = buildLayeredMesh({ box: { x: [0, 3000], y: [0, 1000], z: [0, 500] }, solids: [], mesh: { max_edge_um: 200, max_dz_um: 200, grade: 1 } });
  const P = prepare3d(mesh, { order: 2, solver: 'iterative', materials: makeMaterials({}), background: 'air', solidProps: [], ports: [{ name: 'p1', side: 'xmin', mode: { type: 'te10' } }, { name: 'p2', side: 'xmax', mode: { type: 'te10' } }] });
  const f = 200e9;
  const coreInfo = [];
  const makeSolver = ({ re, im, Ucols, blocks }) => {
    const t0 = performance.now();
    const pmg = buildPMG(P.pmg, re, im, { cols: Ucols, blocks }, { factor: P.p.factor, smooth: 2, auxSmooth: 1 });
    coreInfo.push({ build_ms: performance.now() - t0, solves: [] });
    return (br, bi) => {
      const ts = performance.now();
      const r = gmres(pmg.applyA, pmg.apply, br, bi, { rtol: 1e-10, maxIter: 400, restart: 30, work: P._coreWork ?? (P._coreWork = {}) });
      coreInfo.at(-1).solves.push({ iterations: r.iterations, ms: performance.now() - ts, converged: r.converged });
      return { re: r.re, im: r.im };
    };
  };
  const [tc, ta] = abTime(() => solveAt(P, f, { makeSolver }), () => solveAt(P, f));
  let dS = 0;
  for (let k = 0; k < tc.last.S.re.length; k++) dS = Math.max(dS, Math.hypot(tc.last.S.re[k] - ta.last.S.re[k], tc.last.S.im[k] - ta.last.S.im[k]));
  const lastCore = coreInfo.at(-1);
  const coreSolveMs = median(coreInfo.slice(1).map((c) => c.build_ms + c.solves.reduce((s, q) => s + q.ms, 0)));
  const atlasIt = ta.last.solver?.solves ?? [];
  record({ family: 'gmres-pmg', workload: 'APA em3d TE10 guide 3000 x 1000 x 500 um, layered mesh max_edge 200 um, order 2, solver iterative (GMRES restart 30, rtol 1e-10, p-MG smooth 2), 200 GHz, 2 ports', dof: P.stats.dof, coarse: P.pmg.nc,
    core: { solveAt_ms: r3(tc.median), pmg_build_plus_gmres_ms: r3(coreSolveMs), iterations: lastCore.solves.map((q) => q.iterations) },
    atlas_inprocess: { solveAt_ms: r3(ta.median), iterations: atlasIt.map((q) => q.iterations), gmres_ms: atlasIt.map((q) => r3(q.ms)) },
    atlas_log: { note: 'no logged timing for this case in APA logs/ or DevLog-014 (G5 records iterations only: TE10 19 at rtol 1e-10, 2 GS sweeps)' },
    core_vs_inprocess: ratio(tc.median, ta.median), S_max_abs_diff: dS });
}

console.log(`log ${LOG}`);
if (!EO && ONLY.some((o) => o === 'direct' || o === 'arnoldi')) throw new Error('give --eo <eo-modulator-atlas/engine> or AMP_EO_ATLAS');
if (!APA && ONLY.some((o) => o === 'mg' || o === 'pmg')) throw new Error('give --apa <advanced-packaging-atlas/engine> or AMP_APA_ATLAS');
for (const fam of ONLY) {
  if (fam === 'direct') await benchDirect();
  else if (fam === 'arnoldi') await benchArnoldi();
  else if (fam === 'mg') await benchMG();
  else if (fam === 'pmg') await benchPMG();
  else throw new Error(`unknown family ${fam}`);
}
