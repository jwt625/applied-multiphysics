// SPDX-License-Identifier: GPL-3.0-or-later
// Gate of the WASM SIMD real front kernel (lane P1, DevLog-016; DevLog-001 A8: > 2x end to end on the factor, same
// answer). Per matrix, 'blocked' (JS) and 'wasm' interleaved (one warm-up each, then --runs rounds in A B / B A order):
//   factor_ms   SparseCholesky.factor on a shared symbolic analysis
//   e2e_ms      new SparseCholesky(pat, perm) (ordering + symbolic) + factor + one solve
//   agreement   max |x_wasm - x_js| / max |x_js| on one solve, bitwise flag, relative residuals
// Matrices:
//   ac02  AC-02 finest level (tet10 acoustics, hFactor 0.25 of the case's h_factors): K - sigma M as shiftInvertEigen
//         factors it, captured from @amp/physics prepareRun + acoustics run (pattern rebuilt from the symbolic analysis,
//         fingerprint-checked)
//   eo    EO mao2022 electrostatics P1 (DevLog-002 gate-3 matrix), EO atlas read only (--eo <eo-modulator-atlas/engine>)
//   apa   APA thermal bench grid M, direct_nd (APA StencilCholesky: stencilToCSR + gridNDOrder), APA atlas read only
//         (--apa <advanced-packaging-atlas/engine>)
//   h6    AC-02 end to end (prepareRun + acoustics run at h_factors [1, 0.5, 0.25]) with the default real kernel set to
//         'blocked' and to 'wasm'; eigenfrequencies compared
// Usage (from the repo root): nice -n 10 node --max-old-space-size=1536 packages/core/bench/real-front-gate.mjs
//   --eo <eo>/engine --apa <apa>/engine [--runs 3] [--only ac02,eo,apa,h6]
// One JSONL record per matrix to logs/real-front-gate-<YYYYMMDDTHHMMSS>.jsonl.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { SparseCholesky, patternFingerprint } from '../src/la/sparse.mjs';
import { setDefaultRealFactor, wasmRealSupported } from '../src/la/ldlt-select.mjs';
import { stencilToCSR, gridNDOrder } from '../src/la/stencil.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const EO = arg('eo', process.env.AMP_EO_ATLAS), APA = arg('apa', process.env.AMP_APA_ATLAS);
const RUNS = Number(arg('runs', 3));
const ONLY = arg('only', 'ac02,eo,apa,h6').split(',');
const p2 = (v) => String(v).padStart(2, '0');
const d = new Date();
const STAMP = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const LOG = arg('out', join(REPO, 'logs', `real-front-gate-${STAMP}.jsonl`));
mkdirSync(dirname(LOG), { recursive: true });
const imp = (root, rel) => import(pathToFileURL(join(root, rel)).href);
const r4 = (x) => (x == null ? null : +x.toPrecision(4));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };
const platform = { node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length };
function record(rec) {
  const row = { date: new Date().toISOString(), ...platform, loadavg: os.loadavg().map(r4), runs: RUNS, wasmSupported: wasmRealSupported(), ...rec };
  appendFileSync(LOG, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}

function matvec(pat, v, x) {
  const y = new Float64Array(pat.n);
  for (let i = 0; i < pat.n; i++) { let s = 0; for (let q = pat.rowptr[i]; q < pat.rowptr[i + 1]; q++) s += v[q] * x[pat.colidx[q]]; y[i] = s; }
  return y;
}
const nrm = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s); };

/** Full symmetric CSR (sorted rows) rebuilt from a symbolic analysis' permuted lower pattern. */
function patFromSym(sym) {
  const { n, perm, lowerP, lowerI } = sym;
  const cnt = new Int32Array(n + 1);
  for (let j = 0; j < n; j++) for (let p = lowerP[j]; p < lowerP[j + 1]; p++) { const oi = perm[lowerI[p]], oj = perm[j]; cnt[oi + 1]++; if (oi !== oj) cnt[oj + 1]++; }
  for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  const colidx = new Int32Array(cnt[n]), next = cnt.slice(0, n);
  for (let j = 0; j < n; j++) for (let p = lowerP[j]; p < lowerP[j + 1]; p++) { const oi = perm[lowerI[p]], oj = perm[j]; colidx[next[oi]++] = oj; if (oi !== oj) colidx[next[oj]++] = oi; }
  for (let i = 0; i < n; i++) colidx.subarray(cnt[i], cnt[i + 1]).sort();
  return { n, rowptr: cnt, colidx, nnz: cnt[n] };
}

/** Gate one SPD matrix: factor-only and end-to-end, JS vs WASM interleaved. */
function gate(name, workload, pat, val, perm = null) {
  const b = Float64Array.from({ length: pat.n }, (_, i) => Math.sin(i + 1));
  const sym = new SparseCholesky(pat, perm).sym;
  const kinds = ['blocked', 'wasm'];
  const t = { blocked: { factor: [], e2e: [] }, wasm: { factor: [], e2e: [] } };
  const last = {};
  const factorOnce = (k, keep) => {
    const ch = new SparseCholesky(pat, null, { sym, factor: k });
    const t0 = performance.now();
    if (!ch.factor(val)) throw new Error(`${name}: ${k} factor failed`);
    const ms = performance.now() - t0;
    if (keep) t[k].factor.push(ms);
    if (ch.timing.kernel !== k) throw new Error(`${name}: requested ${k}, ran ${ch.timing.kernel}`);
    return ch;
  };
  const e2eOnce = (k, keep) => {
    const t0 = performance.now();
    const ch = new SparseCholesky(pat, perm, { factor: k });
    if (!ch.factor(val)) throw new Error(`${name}: ${k} factor failed`);
    const x = ch.solve(b, new Float64Array(pat.n));
    const ms = performance.now() - t0;
    if (keep) t[k].e2e.push(ms);
    last[k] = x;
  };
  for (const k of kinds) { factorOnce(k, false); e2eOnce(k, false); }
  for (let r = 0; r < RUNS; r++) for (const k of r % 2 ? [...kinds].reverse() : kinds) { factorOnce(k, true); e2eOnce(k, true); }
  let dmax = 0, xmax = 0, bitwise = true;
  for (let i = 0; i < pat.n; i++) {
    const dx = Math.abs(last.wasm[i] - last.blocked[i]);
    if (last.wasm[i] !== last.blocked[i]) bitwise = false;
    dmax = Math.max(dmax, dx);
    xmax = Math.max(xmax, Math.abs(last.blocked[i]));
  }
  const relres = (x) => { const y = matvec(pat, val, x); for (let i = 0; i < y.length; i++) y[i] -= b[i]; return nrm(y) / nrm(b); };
  const fac = { blocked: median(t.blocked.factor), wasm: median(t.wasm.factor) };
  const e2e = { blocked: median(t.blocked.e2e), wasm: median(t.wasm.e2e) };
  const relDiff = dmax / xmax;
  const speedFactor = fac.blocked / fac.wasm;
  record({
    matrix: name, workload, n: pat.n, nnzA: pat.nnz, nnzL: sym.nnzL, flops: sym.flops, maxFront: sym.maxFront, nsuper: sym.nsuper,
    factor_ms: { blocked: t.blocked.factor.map(r4), wasm: t.wasm.factor.map(r4), median_blocked: r4(fac.blocked), median_wasm: r4(fac.wasm) },
    e2e_ms: { blocked: t.blocked.e2e.map(r4), wasm: t.wasm.e2e.map(r4), median_blocked: r4(e2e.blocked), median_wasm: r4(e2e.wasm) },
    speedup_factor: r4(speedFactor), speedup_factor_min: r4(Math.min(...t.blocked.factor) / Math.max(...t.wasm.factor)), speedup_e2e: r4(e2e.blocked / e2e.wasm),
    solution_rel_diff: relDiff, solution_bitwise: bitwise, relres_blocked: relres(last.blocked), relres_wasm: relres(last.wasm),
    gate_pass: speedFactor > 2 && relDiff <= 1e-12,
  });
}

async function physicsCtx() {
  const { parseYaml } = await import(pathToFileURL(join(REPO, 'packages/spec/src/index.ts')).href);
  const phys = await import(pathToFileURL(join(REPO, 'packages/physics/src/index.ts')).href);
  const { readCase } = await import(pathToFileURL(join(REPO, 'packages/physics/gates/common.ts')).href);
  const spec = parseYaml(readFileSync(join(REPO, 'sims/box-acoustics.yaml'), 'utf8')).data;
  return { phys, spec, cs: readCase('a', 'AC-02') };
}

async function gateAC02() {
  const { phys, spec, cs } = await physicsCtx();
  const f = Math.min(...cs.convergence.h_factors);
  let cap = null;
  const orig = SparseCholesky.prototype.factor;
  SparseCholesky.prototype.factor = function (values) {
    if (!cap || this.sym.n > cap.sym.n) cap = { sym: this.sym, values: values.slice() };
    return orig.call(this, values);
  };
  try {
    const ctx = await phys.prepareRun({ spec, case: cs, hFactor: f });
    await phys.acousticsModule.run(ctx);
  } finally {
    SparseCholesky.prototype.factor = orig;
  }
  const pat = patFromSym(cap.sym);
  if (patternFingerprint(pat) !== cap.sym.patternKey) throw new Error('ac02: rebuilt pattern fingerprint mismatch');
  gate('ac02', `AC-02 finest level (sims/box-acoustics.yaml, hFactor ${f}, tet10 P2), K - sigma M as shiftInvertEigen factors it (AMD)`, pat, cap.values);
}

async function gateEO() {
  if (!EO) throw new Error('give --eo <eo-modulator-atlas/engine>');
  const { applyOverrides } = await imp(EO, 'src/yaml-edit.mjs');
  const { parseConfig, crossSectionOf } = await imp(EO, 'src/config.mjs');
  const { solveElectrostatics } = await imp(EO, 'src/electrostatics.mjs');
  const text = applyOverrides(readFileSync(join(EO, '..', 'sims', 'mao2022', 'config.yaml'), 'utf8'), [['template.mesh.element_order', 1]]);
  const cfg = parseConfig(text);
  const es = solveElectrostatics(crossSectionOf(cfg, 'geometry'), { resolvedMaterials: cfg.materials, meshScale: 1, elementOrder: 1 });
  const sub = es.solver.sub;
  gate('eo', 'EO mao2022 electrostatics P1 (sims/mao2022/config.yaml, template.mesh.element_order 1, meshScale 1), dielectric matrix (AMD)', sub.pat, sub.val);
}

async function gateAPA() {
  if (!APA) throw new Error('give --apa <advanced-packaging-atlas/engine>');
  const { buildGrid } = await imp(APA, 'src/grid/index.mjs');
  const th = await imp(APA, 'src/thermal/index.mjs');
  const { applyConstraints } = await imp(APA, 'src/thermal/assemble.mjs');
  // APA bench/bench.mjs benchParts, K, thermal and GRIDS.M at fe39985 (as core-bench.mjs apaBenchGrid)
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
  const grid = buildGrid(parts, { max_xy_mm: 1.0, min_cells_per_layer: 2, grading: 1.3, max_z_mm: 0.4 });
  const prep = th.prepareThermal(grid, thermal);
  const k = new Float64Array(6 * grid.cellMat.length);
  for (let c = 0; c < grid.cellMat.length; c++) if (grid.cellMat[c] >= 0) k.set(th.kComponents(K[grid.materials[grid.cellMat[c]]], grid.materials[grid.cellMat[c]]), 6 * c);
  const A = th.assembleThermal(prep, { k, tensor: false });
  applyConstraints(A.op, A.F, prep.Td, prep.active);
  const { pat, val, map } = stencilToCSR(A.op);
  const perm = gridNDOrder(A.op.NX, A.op.NY, A.op.NZ, map);
  gate('apa', `APA thermal bench grid M (bench.mjs benchParts, GRIDS.M; ${A.op.N} grid nodes), free block, direct_nd ordering (gridNDOrder)`, pat, val, perm);
}

async function gateH6() {
  const { phys, spec, cs } = await physicsCtx();
  const runOnce = async (k) => {
    setDefaultRealFactor(k);
    const t0 = performance.now();
    const levels = [];
    for (const f of cs.convergence.h_factors) {
      const l0 = performance.now();
      const ctx = await phys.prepareRun({ spec, case: cs, hFactor: f });
      const s = await phys.acousticsModule.run(ctx);
      levels.push({ hFactor: f, dof: s.stats.dof, wall_ms: r4(performance.now() - l0), timing: Object.fromEntries(Object.entries(s.timing).map(([a, v]) => [a, r4(v)])), values: s.values ?? null });
    }
    return { total: performance.now() - t0, levels };
  };
  const t = { blocked: [], wasm: [] }, last = {};
  try {
    for (const k of ['blocked', 'wasm']) await runOnce(k);
    for (let r = 0; r < RUNS; r++) for (const k of r % 2 ? ['wasm', 'blocked'] : ['blocked', 'wasm']) { const o = await runOnce(k); t[k].push(o.total); last[k] = o; }
  } finally {
    setDefaultRealFactor('blocked');
  }
  const same = JSON.stringify(last.blocked.levels.map((l) => l.values)) === JSON.stringify(last.wasm.levels.map((l) => l.values));
  record({
    matrix: 'h6', workload: 'AC-02 end to end in Node: prepareRun + acousticsModule.run at the case h_factors (sims/box-acoustics.yaml), default real kernel blocked vs wasm',
    total_ms: { blocked: t.blocked.map(r4), wasm: t.wasm.map(r4), median_blocked: r4(median(t.blocked)), median_wasm: r4(median(t.wasm)) },
    speedup_e2e: r4(median(t.blocked) / median(t.wasm)), values_identical: same, levels_blocked: last.blocked.levels, levels_wasm: last.wasm.levels,
  });
}

console.log(`log ${LOG}`);
for (const m of ONLY) {
  if (m === 'ac02') await gateAC02();
  else if (m === 'eo') await gateEO();
  else if (m === 'apa') await gateAPA();
  else if (m === 'h6') await gateH6();
  else throw new Error(`unknown matrix ${m}`);
}
