# DevLog-045: core performance, part 1 (lane S4, chunk 1, roadmap B4)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | S4 (DevLog-037 s.3, B4) |
| Owns | `packages/core/**`; `packages/physics/src/common/**` except `lagrange.ts` (lane S3); shared edits (Edit on a fresh read, only these lines): a `solver` setting on the stationary study registration in `packages/spec/src/provisional/wave1.ts` and its plumbing in `packages/physics/src/driver.ts`; this file |
| Parallel | T1 (038), T2 (039, runs the eval CLI), T3 (040), T4 (041), S1 (042, wave2d, complex factor), S2 (043, modes, complex factor), S3 (044, geom, mesh, prepare.ts, lagrange.ts) |
| Read | CLAUDE.md; DevLog-037; DevLog-002 s.7; DevLog-016; DevLog-009 s.5; DevLog-033 O6; `core/src/la/{sparse,ldlt,ldlt-select}.mjs`, `la/wasm/{encoder,front-real}.mjs`; `physics/src/common/{scalar,eigen,ctx,solution}.ts`; `physics/src/driver.ts`; `elastic/index.ts`, `coupled/assemble.ts` (read only) |

Conventions: F = fact read from code or a run; D = decision of this lane; E = estimate; O = open item; R = request to the coordinator or another lane.

## 1. Plan (2026-11-18 08:50 PST, before coding)

### 1.1 Facts
- F: `common/scalar.ts` `assembleCells` already scatters through `elementSlots` (core `la/sparse.mjs`, cached per pattern + connectivity). Binary search per entry remains in: `common/scalar.ts` `assembleFacets` (`entry`, Robin / convection facets), `heat/index.ts:145` (radiation Jacobian, `entry`), `elastic/index.ts:165` (every element entry of 2D / 3D elasticity), `coupled/assemble.ts` `slotOf` (piezo, acoustic-structure, solid modal; DevLog-033 O6: about 25 % of assembly), `coupled/eigen-ns.ts:63`. Only the first is in this lane's paths.
- F: real Cholesky triangular solves are `sparse.mjs` `solveNumeric` (one vector) and `supernodalSolve` (q vectors); real LDL^T: `ldlt.mjs` `SupernodalLDLT.solve` / `solveMany`. All are JS. The factor `Lx` is a plain Float64Array.
- F: AC-02 uses `shiftInvertEigen` with Cholesky and block size 1, so every Arnoldi operator application is one `solveNumeric` (DevLog-016: finest level eigen phase 1.7 s).
- F: heat, electrostatics, currents and elastic take `solver?: 'cholesky' | 'amg-pcg'` in their problem objects, but no adapter sets it from the spec; the stationary study registration has no settings.

### 1.2 Design
Task 2, scatter:
- Core: `blockElementSlots(nodePat, blockPat, elem, k, bs)` in `la/sparse.mjs` derives the block CSR slot of every (a, d, b, e) element entry from the node slot map in O(1) per entry (block pattern rows are node rows expanded by bs, as `elastic/index.ts` `blockPattern` builds them); no search. Cached on the block pattern like `elementSlots`.
- Common: `assembleFacets` uses precomputed facet slots (`elementSlots` over the listed facets' connectivity) instead of `entry`.
- The hot binary-search loops are in elastic and coupled (not this lane's paths): measure the gain with a scratch copy that swaps the scatter to the new helper, then file the exact patch as a request (R).
Task 3, WASM triangular solve:
- Per-entry operation order kept exactly (bitwise identical to the JS solve), as in DevLog-016: forward `y[f+r] -= L[r] yj` and `t[r] += L[ca+r] ya + L[cb+r] yb` vectorised over rows r (f64x2, independent per row); backward `dotBelow`'s 4 strided partial sums map to two f64x2 accumulators (lanes s0 s1, s2 s3), tail into s0, final `s0 + s1 + (s2 + s3)`; the backward in-supernode dot stays a scalar loop in the same order.
- `Lx` must be in WASM memory to avoid a copy per solve: `factorNumeric` allocates `num.Lx` (and solve workspace) in a per-factor `WebAssembly.Memory` that never grows (views stay valid); fallback to a Float64Array and the JS solve when SIMD is missing, the allocation fails, or the size exceeds a cap. JS keeps the supernode loop, gather and scatter through `Si`; WASM gets the dense kernels.
- Selection: `DEFAULT_REAL_SOLVE` ('wasm' | 'js') with a setter, same pattern as `DEFAULT_REAL_FACTOR`; equality tests JS vs WASM.
- LDL^T solve: same scheme if the profile shows it matters (vector modes, LDL^T eigen); complex only if cheap.
Task 4, solver setting:
- `wave1.ts` stationary registration gets `settings: {solver?: 'direct' | 'amg-pcg' | 'auto', rtol?: number}` (strict object, optional, so every existing spec stays valid).
- `common/scalar.ts`: `withStudySolver(study, physicsType, run)` sets a run-scoped setting read by `SpdSolver` (only when the module asked for its default 'cholesky'), collects per-solve stats (kind, rtol, iterations, relative residual) and writes them into `stats.solver` / `stats.iterations` / `stats.residual` and a note of the returned solution. Applies to heat, electrostatics, currents only (scalar AMG is not suited to elasticity). 'auto' = AMG-PCG above a DOF threshold set from the measurement; the default stays 'direct'.
- `driver.ts`: wrap the module run calls with `withStudySolver` (minimal edit, separate from other lanes' lines).

### 1.3 Baseline measurement protocol
- Bench script `packages/core/bench/perf-core-1.mjs` (this lane's path; imports @amp/physics by file URL like `real-front-gate.mjs`). Per workload: prepareRun + runStudy (the eval worker's path); cold = first run in a fresh process; warm = median of >= 5 later runs in the same process; stage timings from `sol.timing` (assemble / factor / solve / eigen); `uptime` load recorded per run. Outputs (scalars as exact strings, every field array) saved to the scratchpad for a bitwise / 1e-12 comparison after each change.
- Workloads: AC-02 (`sims/box-acoustics.yaml`, h 1, 0.5, 0.25, finest level timed separately), H1 (`sims/kirsch-plate.yaml`), H4 (`sims/hadley-rib-wo02.yaml`), H5 (`sims/cylinder-cavity-axisym.yaml`, emw-axisym), 3D tet10 modal (`sims/pzt4-cube.yaml`), 3D em3d ND2 (`sims/cylinder-cavity.yaml` at the largest hFactor that keeps RSS <= 2 GB).
- Runs: `nice -n 10 node --max-old-space-size=1536`, one process at a time; logs in `logs/perf-core-1-*.jsonl`.
- Eval: `node packages/eval/src/cli.ts --class a` before and after; per-target values compared (bitwise or 1e-12 relative).

### 1.4 TODO
- [x] Bench script and baseline (timings + output dump)
- [x] Class-a eval baseline
- [x] Task 2: `blockElementSlots` (core), facet slots in `assembleFacets`; scratch measurement of elastic / coupled with the helper; request with the patch
- [x] Task 3: WASM real triangular solve (Cholesky single and multi, LDL^T single and multi); tests (bitwise); default 'wasm'
- [x] Task 4: `solver` setting (wave1.ts), plumbing (driver.ts), `SpdSolver` 'auto', stats; tests; rule from measurement
- [x] After: timings, output comparison, `pnpm test`, `pnpm -r check`, class-a eval comparison
- [x] Before/after table, next bottlenecks for E8, hand-off

## 2. Progress log

- 2026-11-18 08:50 PST: read the brief and DevLogs; plan above.
- 2026-11-18 08:52 PST: bench `packages/core/bench/perf-core-1.mjs` written; baseline started (`logs/perf-core-1-base-20261118T085255.{jsonl,log}`, dumps in the scratchpad). Load average 9-10 from other lanes during the run.
- 2026-11-18 08:56 PST: `la/wasm/solve-real.mjs` (Cholesky fdiag / facc / bdiag, LDL^T lfwd1 / lbwd1 / lfwdq / lbwdq) and its wiring in `sparse.mjs` / `ldlt.mjs`. Baseline processes that started before 08:56:53 (ac02, h6, kirsch, rib, rf21, pzt4 h 1) ran the old code; pzt4 h 0.5 killed at 1.8 GB RSS (over the 2 GB budget with more runs; dropped from the table); hotarm killed (would have run the new code): rerun with `--solve js`.
- 2026-11-18 08:58 PST: test `packages/core/test/la-real-solve.test.mjs`: 8/8, WASM solve bitwise identical to the JS solve (Cholesky single / multi, LDL^T single / multi with q = 1, 2, 3, 4, 11, zeros, -0, NaN, Inf, fallbacks). (The first version used a non-symmetric test matrix, so the residual check failed on both paths; values made symmetric.)
- 2026-11-18 08:59-09:01 PST: core `blockPattern`, `blockElementSlots`; common `cellBlockPattern`, `cellBlockSlots`, `facetSlots` (assembleFacets now uses it); solver setting: `wave1.ts` stationary `settings: {solver?, rtol?}`, `common/scalar.ts` `withStudySolver` / `studySolverSetting` / SpdSolver ambient setting, `driver.ts` wraps the two module run calls. tsc clean (core, physics).
- 2026-11-18 09:02 PST: class-a eval baseline-equivalent run with `DEFAULT_REAL_SOLVE = 'js'` temporarily in the source (the old solve path; the other changes are inert without settings or bitwise by construction): `logs/perf-core-1-eval-a-js-20261118T090200.log`. The default goes back to 'wasm' after this run.
- 2026-11-18 09:03 PST: eval run done: 15 pass, 1 fail (CP-21 sigma_yy_D, Richardson oscillatory; not a solver issue, T2's case), 13 pending; records `logs/eval-20261118T090158.jsonl` (copy kept in the scratchpad). Default back to 'wasm'.
- 2026-11-18 09:03 PST: hotarm baseline with `--solve js` (`logs/perf-core-1-base-hotarm-20261118T090313.jsonl`): solid.assemble 3,500 ms of 5,554 ms run.
- 2026-11-18 09:04 PST: scatter micro-benchmark on real meshes (scratch script; `logs/perf-core-1-scatter-20261118T090400.log`): elastic-style binary-search scatter vs `blockElementSlots` (bitwise-identical K in all three). The scatter is not the dominant assembly cost of elastic / piezo (see s.3.2).
- 2026-11-18 09:04-09:07 PST: after-change bench (`logs/perf-core-1-after-20261118T090452.{jsonl,log}`); `--compare` base vs after: 448 items (scalars + fields, 14 workload levels), 448 bitwise identical.
- 2026-11-18 09:08-09:18 PST: em3d gauge: h 0.5 reached 4.8 GB RSS (killed, over budget; my mistake to start it without a guard, an RSS guard wrapper is used from here on); h 0.75 killed by the guard at 1.9 GB; h 1: 36,832 DOF, 812 MiB.
- 2026-11-18 09:19 PST: em3d h 0.85 (57,086 DOF) A/B `--solve js` vs `--solve wasm` (`logs/perf-core-1-em3d-20261118T091919.{jsonl,log}`): bitwise identical (64 items).
- 2026-11-18 09:21 PST: interleaved A/B (`--solve js` then `--solve wasm` per workload, same load window) started for ac02, rib 0.5, kirsch 0.25, rf21 0.25, pzt4.
- 2026-11-18 09:27 PST: A/B done (`logs/perf-core-1-ab-20261118T092128.{jsonl,log}`), table s.3.1.
- 2026-11-18 09:26-09:29 PST: direct vs AMG-PCG on stationary heat (scratch script; `logs/perf-core-1-solver-20261118T092637.log`): 2D tri6 direct faster at every size up to 643,617 DOF; 3D tet10 AMG-PCG faster from about 30k DOF, direct over the 2 GB budget at about 100k. A DOF threshold cannot separate the two, so 'auto' uses the AMD symbolic analysis (flop per DOF, factor bytes), s.3.3.
- 2026-11-18 09:29 PST: 'auto' verified on the 3D box: h 0.7 (12,167 DOF, 1.92e5 flop/DOF) direct; h 0.5 (29,791 DOF, 7.63e5 flop/DOF) AMG-PCG, 21 iterations, relres 5.66e-11, note in the solution.
- 2026-11-18 09:30 PST: class-a eval with the final code (`logs/perf-core-1-eval-a-wasm-20261118T093049.log`, records `logs/eval-20261118T093049.jsonl`): 15 pass, 1 fail (CP-21, as before), 13 pending; 55 / 55 compared target values bitwise identical to the 09:01 run (scratch script evalcmp.py: same specHash, meshHash and dof per target).
- 2026-11-18 09:31 PST: `pnpm test` (all packages) started.
- 2026-11-18 09:34 PST: `AMP_RT_ALLOW_NO_GPU=1 nice -n 10 pnpm test` exit 0 (`logs/perf-core-1-test-20261118T093149.log`): rt 16, core 95, spec 65, geom 43, materials 32, eval 86, mesh 19, physics 157, post 13, agent 63, apps/web 60; 0 fail. `nice -n 10 pnpm -r check` exit 0 (`logs/perf-core-1-check-20261118T093446.log`).
- 2026-11-18 09:35 PST: results, requests, next bottlenecks written (s.3-6). Solve module 2,721 bytes (below Chrome's 4 KB synchronous-compile limit on a main thread).

## 3. Results (Node v23.7.0, Apple M4 Pro 12 cores; `nice -n 10`, heap 1536 MB; other lanes running, load average in each row)

All timings are medians of the warm runs (5, em3d 3) after one cold run in a fresh process; "cold" = that first run. Wall = prepareRun + runStudy (the eval worker's path). Core factor / solve = time inside SparseCholesky / SupernodalLDLT factor and solve calls (bench wrappers); `[n]` = vectors solved per run. Command per row: `nice -n 10 node --max-old-space-size=1536 packages/core/bench/perf-core-1.mjs --only <w> [--levels h] --runs 5 --solve js|wasm` ("before" = `--solve js`, the pre-lane solve path on the same factor; "after" = default `wasm`).

### 3.1 Before / after, interleaved A/B (same load window; `logs/perf-core-1-ab-20261118T092128.jsonl`, em3d `logs/perf-core-1-em3d-20261118T091919.jsonl`)

| Workload | DOF | Cold wall ms | Warm wall ms (speedup) | Core factor ms | Core solve ms (speedup) [vectors] | Assemble stage ms | RSS max MiB | Load |
|---|---|---|---|---|---|---|---|---|
| AC-02 finest (box-acoustics h 0.25, tet10, Cholesky, Arnoldi) | 33,825 | 3,658 -> 3,172 | 3,491 -> 2,680 (1.30x) | 985 -> 1,035 | 1,533 -> 661 (2.32x) [52] | 619 -> 653 | 945 / 932 | 8.4 / 8.2 |
| H4 rib (hadley-rib-wo02 h 0.5, em-modes, LDL^T) | 519,913 | 6,427 -> 5,133 | 5,831 -> 4,338 (1.34x) | 1,025 -> 986 | 2,250 -> 1,110 (2.03x) [25] | 267 -> 258 | 1,552 / 1,504 | 7.8 / 8.0 |
| H1 kirsch (kirsch-plate h 0.25, tri6 elastic) | 170,296 | 1,762 -> 1,808 | 1,357 -> 1,346 (1.01x) | 351 -> 354 | 36.0 -> 19.7 (1.83x) [1] | 268 -> 269 | 697 / 677 | 7.7 / 7.5 |
| H5 RF-21 (cylinder-cavity-axisym h 0.25, emw-axisym m = 0, 1, 2) | 68,117 | 1,882 -> 1,800 | 1,512 -> 1,429 (1.06x) | 82 -> 85 | 217 -> 133 (1.64x) [217] | 531 -> 529 | 480 / 468 | 7.2 / 7.9 |
| 3D tet10 modal (pzt4-cube h 1, piezo, LDL^T) | 36,448 | 12,070 -> 10,640 | 11,950 -> 11,850 (1.01x) | 2,482 -> 2,561 | 2,889 -> 1,494 (1.93x) [43] | 5,925 -> 7,241 | 1,314 / 1,323 | 5.3 / 6.3 |
| 3D em3d ND2 (cylinder-cavity h 0.85, LDL^T, block 4) | 57,086 | 17,140 -> 9,611 | 17,580 -> 9,283 (1.89x) | 2,526 -> 2,500 | 11,500 -> 3,569 (3.22x) [284] | 312 -> 309 | 1,436 / 1,341 | 8.7 / 8.3 |

- Outputs: every scalar and field of every row bitwise identical (`--compare`: base vs after 448 / 448 items over 14 workload levels incl. hotarm and all H6 levels; em3d 64 / 64).
- em3d size: h 0.85 is the largest tried that stays under 2 GB (h 0.75 passed 1.9 GB RSS, h 0.5 reached 4.8 GB; both killed).
- pzt4 assemble varies 5.9-7.2 s between runs at the same code (load); the WASM change does not touch assembly.
- kirsch / hotarm (single direct solve) gain only in the solve call; their time is in assembly, factor and stress post-processing.

### 3.2 Sequential before / after (old code vs new code; `logs/perf-core-1-base-20261118T085255.jsonl` load 9-10, `logs/perf-core-1-after-20261118T090452.jsonl` load 5-9)

| Workload | DOF | Warm wall ms | Core solve ms |
|---|---|---|---|
| H6 = AC-02 levels h 1 / 0.5 / 0.25, sum | 693 / 4,641 / 33,825 | 3,737 -> 2,886 | 1,630 -> 697 |
| H4 rib h 1 | 129,715 | 1,233 -> 967 | 406 -> 211 |
| RF-21 h 1 / 0.5 | 4,103 / 16,822 | 111 -> 104 / 372 -> 379 | 7.7 -> 7.5 / 40.6 -> 34.4 |
| hotarm (currents -> heat -> elastic, 3D tet10) | 126,125 | 6,494 -> 6,665 | 28.7 -> 17.1 |

Harness: `node packages/eval/src/cli.ts --class a`, AC-02 `time_ms` (cold sum over the three levels, one run each): 4,163 ms (09:01, solve 'js') -> 3,268 ms (09:30, 'wasm'); load 8 vs 3-5, so part of the difference is load.

Scatter (task 2), micro-benchmark on the real meshes (`logs/perf-core-1-scatter-20261118T090400.log`; median of 5; K bitwise identical):

| Mesh | Cells, nodes per cell, bs | Binary-search scatter ms | blockElementSlots build ms | Slot scatter ms |
|---|---|---|---|---|
| hot-arm h 1 (tet10, elastic bs 3) | 13,056, 10, 3 | 94.3 | 30.4 | 18.0 |
| kirsch h 0.25 (tri6, bs 2) | 42,352, 6, 2 | 46.2 | 25.5 | 11.6 |
| pzt4 h 1 (tet10, bs 4 as a stand-in for the 4-field piezo map) | 6,144, 10, 4 | 87.9 | 24.0 | 14.8 |

- F: the binary-search scatter is 1.5-2.7 % of the 3D assembly stages (hotarm solid.assemble 3,500 ms, pzt4 assemble 5.9-7.2 s) and 17 % of kirsch h 0.25's (268 ms), not the ~25 % estimated in DevLog-033 O6 for the 41k cylinder. The element kernels dominate (s.5). The helper still removes 50-80 % of the scatter time and is cached per mesh (repeat assemblies pay only the slot scatter).

### 3.3 Solver choice (task 4): direct vs AMG-PCG, stationary heat (scratch script solver-bench.mjs; `logs/perf-core-1-solver-20261118T092637.log`)

| Problem | Free DOF | flop/DOF (AMD symbolic, unrestricted pattern) | Direct run ms (factor stage) | AMG-PCG rtol 1e-10 run ms (setup + solve), relres | T_max relative difference |
|---|---|---|---|---|---|
| 2D unit square tri6, h 0.25 | 9,893 | 2.3e3 | 48 (17) | 106 (19 + 67), 5.4e-11 | 3.7e-13 |
| 2D h 0.125 | 39,945 | 5.9e3 | 165 (112) | 437 (83 + 274), 6.6e-11 | 2.4e-14 |
| 2D h 0.0625 | 160,529 | 1.7e4 | 690 (358) | 1,848 (324 + 1,227), 8.4e-11 | 7.1e-14 |
| 2D h 0.03125 | 643,617 | 4.0e4 | 3,291 (2,115) | 9,485 (1,279 + 7,037), 8.1e-11 | 1.9e-13 |
| 3D unit cube tet10, h 1 | 3,375 | 6.0e4 | 225 (36) | 195 (25 + 11), 6.4e-11 | 1.6e-12 |
| 3D h 0.7 | 12,167 | 2.7e5 | 721 (149) | 712 (83 + 89), 2.4e-11 | 2.4e-13 |
| 3D h 0.5 | 29,791 | 7.6e5 | 2,462 (1,091) | 1,776 (230 + 266), 5.7e-11 | 1.2e-12 |
| 3D h 0.35 (~100k) | - | 3.0e6 | killed by the 1.95 GB guard (direct) | not reached | - |

flop/DOF from `analyze(cellPattern(mesh))` (scratch flops.mjs, unrestricted node pattern; the restricted pattern the solver sees gives 1.92e5 at 3D h 0.7 and 7.63e5 at h 0.5). Decision D: 'auto' = AMG-PCG when the direct factor costs >= 3e5 flop per DOF (`AUTO_FLOPS_PER_DOF`, the measured break-even) or would exceed 1 GiB (`AUTO_MAX_FACTOR_BYTES`), else direct; it reuses the AMD analysis for the direct factor. A pure DOF threshold would be wrong in one of the two dimensions (2D direct wins at 644k DOF, 3D AMG wins at 30k). hot-arm's thin 3D parts give 5.9e3 flop/DOF (direct). Default stays 'direct': AMG-PCG answers differ from the direct ones at the rtol level (T_max up to 1.6e-12 relative in s.3.3), so 'auto' would break the bitwise / 1e-12 gate on cases that switch.

### 3.4 Gates
- Tests: `packages/core/test/la-real-solve.test.mjs` (8), `packages/core/test/la-block-slots.test.mjs` (6), `packages/physics/test/perf-core-1.test.ts` (4): all pass.
- Class-a eval: 15 pass, 1 fail, 13 pending before and after; 55 / 55 target values bitwise identical (s.2, 09:30).

## 4. Requests (R)
- R1 (elastic owner / coordinator): `packages/physics/src/elastic/index.ts` element scatter (lines 160-168) through the new helper; bitwise identical by construction (same element / entry order, only the slot lookup changes):
  ```ts
  // before the element loop (pat = blockPatternCached(node, dim) has the core blockPattern layout; validated)
  const slots = cellBlockSlots(m, pat, dim);            // import { cellBlockSlots } from '../common/scalar.ts'
  // replaces the binary-search loop over (a, b)
  const base = nd * nd * e;
  for (let a = 0; a < nd; a++) {
    F[dofs[a]!]! += Fe[a]!;
    for (let b = 0; b < nd; b++) K[slots[base + a * nd + b]!]! += a <= b ? Ke[a * nd + b]! : Ke[b * nd + a]!;
  }
  ```
  Expected gain: hotarm 94 -> 18 ms per assembly (+30 ms once per mesh), kirsch h 0.25 46 -> 12 ms (+26 ms once).
- R2 (coupled owner): `coupled/assemble.ts` `scatter` / `slotOf` on `dofPattern` (piezo K and M, fsi): `dofPattern` sorts and merges DOFs (floating electrodes), so the O(1) block formula does not apply; use core `elementSlots(pat, elemDofs, nd)` once per element DOF list and reuse it for K and M (halves the searches). Low priority: the scatter is about 90 ms of the 6-7 s piezo assembly (s.3.2).
- R3 (heat owner): `heat/index.ts:145` radiation Jacobian: `facetSlots(m, S.pat, r.facets)` (cached per facets array) instead of `entry` per entry, so Newton iterations search once.
- R4 (coordinator, C5): the run record has no solver field; the study setting is reported in `stats.solver`, `stats.residual` and a `notes` line. A `run.solver: {kind, rtol, iterations, residual}` field in C5 would make it machine-readable.
- R5 (coordinator): `withStudySolver` keeps the setting in module state during `run()`; correct for one run per JS realm (web worker, eval worker per case). Two concurrent `runStudy` calls in one realm with different settings would interfere; if that is ever needed, the setting should travel in RunContext to the modules (one line in each of heat / electrostatics / currents adapters: `solver: ...`).

## 5. Next bottlenecks (for chunk 2 lane E8 and the owners)
1. Element kernels, not scatter: pzt4 assembly 5.9-7.2 s of 12 s (`coupled/piezo.ts` B^T C B with the nv x nv product inside the (a, b) loop: about 36 x 465 multiply-adds per quadrature point; precomputing C B per point cuts it about 6x, round-off-level change); hotarm solid.assemble 3.5 s of 5.6 s (`elastic/index.ts`; per-element `dMatrix` and per-point array allocations; needs a CPU profile before changing).
2. 3D factor: AC-02 1.0 s, em3d h 0.85 2.5 s, pzt4 2.5 s at about 23 GFlop/s single-thread WASM. Next: multi-worker factorization (COOP / COEP already served; SharedArrayBuffer) or relaxed-SIMD FMA (not bitwise).
3. em3d / modes LDL^T solve: 3.6 s for 284 vectors at h 0.85 after this lane; the LDL^T solve is column-oriented with scalar gathers (the Cholesky-style dense below-block kernel would vectorise it, with a different summation order: round-off-level change, needs a gate decision).
4. em3d beyond 60k DOF does not fit 2 GB with the direct LDL^T (h 0.75 passed 1.9 GB): AMS-preconditioned iterative ND path (E8 B6).
5. Large 3D scalar problems: 'auto' moves them to AMG-PCG (3D tet10 heat at 30k DOF: 2.2x in the solver stages); AMG setup is now the larger part at small sizes. Parallel sweeps over several workers (E8) multiply throughput for parametric studies.
6. Post-processing: kirsch h 0.25 post 555 ms (stress recovery) > factor 393 ms; RF-21 h 0.25 assemble 530 ms of 1.4 s.
7. Complex LDL^T solve (S1 driven Helmholtz, S2 lossy modes) still JS; the same WASM scheme applies (open item O1).

## 6. Open items
- O1: complex triangular solve in WASM not done (S1 / S2 were coding against the complex factor during this lane; left untouched).
- O2: `SOLVE_MIN_NNZL` (50,000 stored L entries) not tuned; below it the JS solve runs (identical results).
- O3: browser check of the solve module under the CSP not rerun in this lane (same encoder and compile path as DevLog-016's front kernel, which was checked; `wasmSolveSupported()` falls back to the JS solve when compilation is blocked).

## 7. Hand-off (2026-11-18 09:35 PST)
- Done: WASM real triangular solves (default 'wasm', bitwise identical); block element slots and facet slots helpers; stationary study `settings.solver` ('direct' default | 'amg-pcg' | 'auto') with `rtol`, for heat, electrostatics, currents, reported in stats and notes.
- API: `@amp/core/la/wasm/solve-real` (`DEFAULT_REAL_SOLVE`, `setDefaultRealSolve`, `wasmSolveSupported`, `SOLVE_MIN_NNZL`, `QCAP`; re-exported selector from `la/ldlt-select`); `@amp/core/la/sparse` `blockPattern`, `blockElementSlots`; `common/scalar.ts` `cellBlockPattern`, `cellBlockSlots`, `facetSlots`, `withStudySolver`, `studySolverSetting`, `autoSolverChoice`, `STUDY_SOLVER_TYPES`, `AUTO_FLOPS_PER_DOF`, `AUTO_MAX_FACTOR_BYTES`, `STUDY_AMG_RTOL`. Existing signatures unchanged (`SpdSolver(pat, kind?, rtol?)`, `assembleFacets`, `entry`).
- Spec: `studies[].settings: {solver?: direct | amg-pcg | auto, rtol?: number in (0, 1)}` on `stationary` (wave1.ts); existing specs unchanged.
- Files: new `packages/core/src/la/wasm/solve-real.mjs` (+ `.d.mts`), `packages/core/bench/perf-core-1.mjs`, `packages/core/test/la-real-solve.test.mjs`, `packages/core/test/la-block-slots.test.mjs`, `packages/physics/test/perf-core-1.test.ts`; edited `packages/core/src/la/{sparse.mjs,sparse.d.mts,ldlt.mjs,ldlt.d.mts,ldlt-select.mjs,ldlt-select.d.mts,types.d.mts}`, `packages/physics/src/common/scalar.ts`, `packages/physics/src/driver.ts` (import + two wrapped run calls), `packages/spec/src/provisional/wave1.ts` (stationary registration).
- Rerun: bench `nice -n 10 node --max-old-space-size=1536 packages/core/bench/perf-core-1.mjs --only <ac02|h6|kirsch|rib|rf21|pzt4|hotarm|em3d> [--solve js|wasm] [--levels ..] [--em3d-h 0.85] [--dump DIR]`, compare `node packages/core/bench/perf-core-1.mjs --compare DIR_A DIR_B`.
