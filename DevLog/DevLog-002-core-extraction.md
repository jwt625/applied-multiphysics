# DevLog-002: core extraction (lane L1, `@amp/core`)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L1 (DevLog-001 section 9) |
| Owns | `packages/core/**`, this file |
| Inputs | DevLog-001 sections 3-9, CONTRACTS-v0 C1, R1 section 8, R2 sections 2 and 9 |
| Sources (read only) | `eo-modulator-atlas` (EO) at `0546007`, `advanced-packaging-atlas` (APA) at `fe39985` (HEAD of `main`, read from `.git/refs`, no git command run) |

## 1. Plan (written before coding, 2026-11-06 15:15 PST)

Goal: one dependency-free package `@amp/core` with the generic numerics of both atlases, ported with C1 headers, its atlas tests ported and green, `tsc --noEmit` clean against `.d.mts` declarations, and one benchmark per solver family that reproduces the atlas timing.

Rules adopted:
- Port as-is. Changes are limited to import paths, moving a generic function out of a physics file, and injecting what used to be an EO/APA-coupled import (sweep). Every change is written in the port header.
- Where EO and APA diverged, the APA version is taken (sparse, ldlt, complex, params identical; units: APA superset with K). EO's tests are run against the APA version (ported tests plus a read-only redirect run of the EO suite, see 1.4).
- WASM SIMD complex LDL^T stays opt-in (`DEFAULT_FACTOR = 'blocked'` as in APA).
- Palace-derived files (APA em3d `krylov`, `pmg`, `ams`) keep their Apache-2.0 attribution header, are listed in `packages/core/NOTICE`, and `LICENSE-APACHE-2.0` is copied verbatim from APA em3d.
- No numeric literals for physical properties (none expected in numerics).

### 1.1 Module layout (`packages/core/src`)

| Target | Source | Kind |
|---|---|---|
| `units.mjs` | APA `engine/src/params/units.mjs` (EO `postproc/units.mjs` + K) | as-is |
| `expr.mjs` | EO `engine/src/postproc/expr.mjs` | import path only |
| `params.mjs` | APA `params/params.mjs` (= EO `params.mjs`) | as-is |
| `sweep.mjs` | EO `engine/src/sweep.mjs`, generic part only | extracted: axes, point enumeration, override check, sequential runner with cancellation; config/run/store coupling replaced by injected callbacks |
| `la/sparse.mjs`, `la/ldlt.mjs`, `la/complex.mjs` | APA `la/` (= EO) | as-is |
| `la/vector-dense.mjs` | EO `vector-dense.mjs` | as-is |
| `la/dense.mjs` | APA `em2d/dense.mjs` (complex dense LU / eig) | import path |
| `la/ldlt-blocked.mjs`, `la/ldlt-wasm.mjs`, `la/ldlt-select.mjs` | APA `em2d/` | import paths; WASM opt-in |
| `la/stencil.mjs`, `la/mg.mjs`, `la/block.mjs`, `la/halfmg.mjs`, `la/pcg.mjs`, `la/wasm/*` | APA `la/` | as-is |
| `la/gmres-real.mjs` | EO `semi/linear.mjs` | import paths (real GMRES, Bernoulli, scaled SPD block) |
| `la/krylov.mjs` | APA `em3d/krylov.mjs` (Palace-derived) | as-is |
| `la/amg.mjs`, `la/ams.mjs` | APA `em3d/` | as-is (not wired in APA; status line kept) |
| `la/pmg.mjs` | APA `em3d/pmg.mjs` (Palace-derived) | import paths |
| `la/order3d.mjs` | APA `em3d/order.mjs` | import path |
| `la/arnoldi.mjs` | EO `vector-mode.mjs` lines 825-1087 (block Arnoldi, thick restart, Ritz; range corrected 2026-11-06, audit M6) | extracted verbatim; physics stays in EO |
| `fem/tri.mjs` | EO `fem.mjs` (P1/P2 triangles, PoissonSolver) | import path |
| `fem/tri-fe.mjs` | APA `em2d/fe.mjs` (P1/P2 spaces, mass, load, per-tag assembly) | import path |
| `fem/hcurl.mjs` | APA `em3d/hcurl.mjs` (hierarchical H1/ND order 1-2, exact barycentric moments, TRI_QUAD) | as-is |
| `fem/nedelec1.mjs` | APA `em3d/elements.mjs` (Whitney tets) | `LOCAL_EDGES` import from the mesher replaced by the same constant (if a mesher-only import is the only blocker) |
| `fem/space.mjs` | APA `em3d/space.mjs` (global ND DOF map) | import path |
| `fem/quadrature.mjs` | to decide after reading: quadrature tables that are already inside the atlases (EO 6-point degree 4, APA `TRI_QUAD`, `GAUSS01`) re-exported, not rewritten | re-export |
| `index.mjs` | new | namespace exports |

Package files: `package.json` (`@amp/core`, `test` = `node --test`, `check` = `tsc -p . --noEmit`, `exports` with subpaths incl. `./units`, `./expr`), `tsconfig.json` extending `../../tsconfig.base.json`, `NOTICE`, `LICENSE-APACHE-2.0`, `.d.mts` next to every `.mjs`, and `test/types-smoke.ts` so `tsc` exercises the declarations.

### 1.2 Delivery order

1. `units`, `expr`, `params` (lane L2 needs them) with tests; note the importable time here.
2. `la/sparse`, `ldlt`, `complex`, `vector-dense`, `dense`, `ldlt-*`, `arnoldi`, `gmres-real`.
3. `la/stencil`, `mg`, `block`, `halfmg`, `pcg`, `wasm`.
4. `la/krylov`, `amg`, `ams`, `pmg`, `order3d`; `fem/*`.
5. `sweep`.
6. Declarations, `tsc`, benchmarks, module table.

### 1.3 Tests

- Port each atlas test file of a ported module. Where a test needs non-core code (EO mesher/sections, APA grid/thermal/em3d mesher), follow APA's precedent (APA `tests/la-sparse.test.mjs` header): replace the fixture by a self-contained one (structured triangle or hex grid in a test helper), or carry the small fixture module under `packages/core/test/fixtures/` with a port header (test-only, not exported). Record each replacement in the port header and in the module table.
- Fidelity check against the atlases: run selected atlas test files read-only with a Node resolve hook that redirects the atlas's own numerics imports to `@amp/core` files (EO and APA suites unchanged, nothing written into the sibling repos). This is the "EO tests still pass against the APA version" check.

### 1.4 Benchmarks (gate 3)

Bench scripts in `packages/core/bench/`, logs to `logs/core-bench-<stamp>.jsonl`. Fixtures that need atlas-only code (EO mesher, APA grid/thermal, APA em3d mesher) are generated by importing the atlas read-only through a `--eo` / `--apa` path argument (or env `AMP_EO_ATLAS`, `AMP_APA_ATLAS`); no sibling path is hard-coded. Each bench times the core solver and the atlas solver on the same matrix in one process, and the result is also compared with the atlas's logged number.

| Family | Workload | Atlas reference |
|---|---|---|
| Direct Cholesky / LDL^T | EO electrostatics P1 matrix (mao2022 ES, ~5.5e4 DOF) and the vector-mode K2 order-1 indefinite pencil (24,158 DOF) | EO `logs/bench-20261015T0926.jsonl` (factor_ms), `logs/vector-bench-20261015T1511Z.jsonl` (factorMs) |
| PCG + GMG | APA bench package grid M (93,840 nodes) | APA `logs/bench-20261020T1427.jsonl` grid M |
| GMRES + p-MG | APA em3d TE10 order 2 iterative (small, layered mesh from APA, read only) | in-process A/B; atlas logged numbers if found |
| Arnoldi | EO K2 order-1 vector modes (shift-invert, 2 modes) | EO `logs/vector-bench-20261015T1511Z.jsonl` eigenMs |

Machine etiquette: `nice -n 10`, `node --max-old-space-size=1536`, one heavy process at a time.

## 2. TODO

- [x] Package scaffold: package.json (`test`, `check`, `bench`, subpath `exports`), tsconfig (extends base; lib ES2023 + WebWorker, skipLibCheck false), NOTICE, LICENSE-APACHE-2.0
- [x] units, expr, params + tests (L2 unblock): importable 2026-11-06 15:17 PST
- [x] la direct: sparse, ldlt, complex, vector-dense, dense, ldlt-blocked/wasm/select + tests
- [x] la/arnoldi extracted + test
- [x] la/gmres-real + test
- [x] la structured: stencil, mg, block, halfmg, pcg, wasm + tests
- [x] la em3d: krylov, amg, ams, pmg, order3d + tests (pmg via APA redirect only, see table)
- [x] fem: tri, tri-fe, hcurl, nedelec1, space, q1-grid, quadrature + tests (tri-fe, space via APA redirect only)
- [x] sweep (generic) + tests
- [x] `.d.mts` for every module, index, `tsc --noEmit` clean
- [x] Redirect runs of the full EO and APA suites against core
- [x] Benchmarks (4 families), logs, numbers (section 4.3)
- [x] Module table (section 5)
- [x] Hand-off (section 8)
- [x] Coordinator: root `typescript` devDependency + `pnpm install` (contract request 1; done by the coordinator, `pnpm --filter @amp/core check` exits 0)
- [x] Audit 2026-11-06 follow-up S1, S2, S3, M3, M6 (section 9)

## 3. Progress log

- 2026-11-06 15:13 PST: read CLAUDE.md, DevLog-001 s.3-9, CONTRACTS-v0, R1 s.1/3/8, R2 s.1/2/4/9; surveyed both engines (exports, imports, test fixtures, bench logs). Plan above.
- 2026-11-06 15:17 PST: **`units`, `expr`, `params` importable** for lane L2: `packages/core/src/{units,expr,params}.mjs` + `.d.mts`; import as `@amp/core/units`, `@amp/core/expr`, `@amp/core/params` (package `exports`) or by relative path. Tests: `test/params-units.test.mjs` (APA la-params, 8) and `test/expr.test.mjs` (EO postproc expr/units subset, 6): 14/14 pass. Units = APA version (5 base dimensions incl. K, ppm); no `degC` (affine) in either atlas.
- 2026-11-06 15:20 PST: all la / fem modules ported (section 5 table); imports resolve; Arnoldi extracted from EO vector-mode.mjs lines 825-1087 into `la/arnoldi.mjs`; generic `sweep.mjs` written from EO sweep.mjs (injected point runner). APA `thermal/assemble.mjs` ported as `fem/q1-grid.mjs` (generic Q1 hex scalar-diffusion assembly on rectilinear grids; needed by the stencil-MG tests). Grid snapshot fixture `test/fixtures/apa-grids.json` generated from APA buildGrid (generator `test/fixtures/gen-apa-grids.mjs`, APA read only).
- 2026-11-06 15:24 PST: ported tests green: la-sparse 7, la-ldlt 2, la-halfmg 3, la-block 5, la-mg 1 (10 PCG iterations = APA 10, Tmax 155.923623 C = APA), la-wasm 3, la-ldlt-wasm 2, fem-hcurl 1, sparse-fem 7 (EO perf-sparse on a structured mesh), fem-tri 3, expr 6, params-units 8, sweep 3; new tests core-solvers 8, fem-quadrature 2.
- 2026-11-06 15:25-15:27 PST: **EO full suite against core** (resolve hook `test/atlas-redirect/`, 9 EO modules redirected to core): 334 tests, 331 pass, 0 fail, 2 skipped, 1 todo, 102.8 s; identical to EO's recorded result (DevLog-043:245: 334 / 331 / 0 / 2 / 1). Log `logs/core-redirect-eo-20261106T152519.log`.
- 2026-11-06 15:28 PST: declarations: tsc 5.9.3 `--allowJs --declaration` baseline for la/fem (checked), hand-written units / expr / params additions / complex / sweep / quadrature; `test/types-smoke.ts`. `tsc -p . --noEmit` clean; also clean for our own .d.mts with `--skipLibCheck false` (filtered to package files; the DOM + WebWorker lib pair in tsconfig.base conflicts in lib.*.d.ts, which is why the base sets skipLibCheck). NOTICE + LICENSE-APACHE-2.0 (byte-identical to APA em3d copy).
- 2026-11-06 15:28 PST: APA full suite against core started (27 APA modules mapped); bench script `bench/core-bench.mjs` written, run after the APA suite (one heavy process at a time).
- 2026-11-06 15:31 PST: **APA full suite against core**: 330 / 330 pass, 245.3 s (24 APA modules actually redirected; la/wasm/kernels, em3d/amg, em3d/ams are imported only through core files or not at all); APA's recorded result is 330 / 330 in 245-257 s (DevLog-014 G13 line 172, DevLog-013:354). Log `logs/core-redirect-apa-20261106T152729.log`.
- 2026-11-06 15:31 PST: first bench run (sequential A then B) showed a 1.22x in-process LDL^T ratio on identical code (JIT / order effect); bench changed to interleaved A/B rounds. That run (`logs/core-bench-20261106T153150.jsonl`) is superseded.
- 2026-11-06 15:32-15:33 PST: benches, interleaved, 7 rounds: `logs/core-bench-20261106T153225.jsonl` (all four families), `logs/core-bench-20261106T153312.jsonl` (PCG + GMG again in a fresh process). Load average 2.6-3.4 on 12 cores during the runs (other lanes active).
- 2026-11-06 15:33 PST: core suite 61 / 61 pass in 6.6 s (15 files; `logs/core-test-20261106T153324.log`). tsc 5.9.3 `-p . --noEmit` with lib ES2023 + WebWorker and skipLibCheck false: exit 0 (`logs/core-tsc-20261106T153402.log`, empty). Scan of packages/core: no absolute local paths, no emoji.

## 4. Results

### 4.1 Gate 1: tests

Core suite (`pnpm --filter @amp/core test` = `node --test test/*.test.mjs`): **61 / 61 pass**, 6.6 s, 15 files. Ported (51 tests): la-sparse 7, la-ldlt 2, la-halfmg 3, la-block 5, la-mg 1, la-wasm 3, la-ldlt-wasm 2 (1 ported + 1 opt-in check), fem-hcurl 1, sparse-fem 7, fem-tri 3, expr 6, params-units 8, sweep 3. New (L1 additions with closed-form references): core-solvers 8 (vector-dense, Arnoldi x2, real GMRES, complex GMRES, AMG-PCG, 3D ND ordering, complex dense), fem-quadrature 2.

Fixture replacements (each recorded in the port header):
- EO mesher (section.mjs / mesh.mjs, lane L3) -> structured triangle meshes `test/helpers/tri-grid.mjs` (sparse-fem, fem-tri).
- APA buildGrid + solveThermal -> grid snapshot `test/fixtures/apa-grids.json` + `test/helpers/grid-thermal.mjs` (la-mg, la-wasm). The ported la-mg reproduces APA exactly: 10 PCG iterations (APA 10), Tmax 155.923623 C (APA 155.923623 C), max |dT| vs direct 2.4e-10 K; la-wasm JS iterations = APA 10.
- APA em3d mesher / solver (em2d-wasm second half, em3d-p2 tests 2-7): not ported; covered by the redirect run (4.2).

Dropped assertions (need code outside core): EO params free-text config test (config.mjs), EO postproc store / plot / derived / sweep-store tests and `evaluateGlobals` lines, EO sweep study selection / `expected parametric` / sweep_targets / closed-form VpiL, EO electrostatics weight normalisation / mirror symmetry / crystal rotation. All of these still pass in the EO redirect run.

### 4.2 Atlas suites against core (EO tests on the APA versions)

Resolve hook `test/atlas-redirect/{register,hooks}.mjs`: the atlas test files run unchanged, in the atlas directory, with every import of a ported atlas file resolved to the core file (each redirect printed once in the log). Nothing is written into the atlases (their tests write only to `os.tmpdir()`).

| Suite | Redirected modules | Result | Atlas's own recorded result |
|---|---|---|---|
| EO `engine/tests/*.test.mjs` | 9 (sparse, ldlt, complex, vector-dense, fem, params, postproc/units -> APA units, postproc/expr, semi/linear) | 334 tests, 331 pass, 0 fail, 2 skipped, 1 todo; 102.8 s | 334 / 331 / 0 / 2 / 1 (EO DevLog-043:245) |
| APA `engine/tests/*.test.mjs` | 24 (la/*, la/wasm/{encoder,accel}, params/*, em2d/{dense,ldlt-*,fe}, em3d/{krylov,pmg,order,hcurl,elements,space}, thermal/assemble) | 330 / 330 pass; 245.3 s | 330 / 330, 245-257 s (APA DevLog-014 G13) |

So EO's tests pass against the APA units superset and against the APA copies of sparse / ldlt / complex / params (byte-identical bodies).

### 4.3 Gate 3: benchmarks

`bench/core-bench.mjs`, Node v23.7.0, Apple M4 Pro, nice 10, heap cap 1536 MB, interleaved A/B (one warm-up each, 7 rounds, median). "In-process" = the atlas's own solver on the same matrix in the same process; "log" = the atlas's recorded number. Results are bitwise identical between core and atlas in every family (max |dx| = 0, max |dS| = 0, n_eff equal).

| Family | Workload | Core (ms) | Atlas in-process (ms) | Core / in-process | Atlas log (ms), source | Core / log |
|---|---|---|---|---|---|---|
| Supernodal Cholesky | EO mao2022 ES P1, n 54,763, nnzL 1,794,543, 2 numeric factors | 101.4 | 99.3 | 1.02 | 93.1 (`factor_ms`, nFactor 2), EO `logs/bench-20261015T0926.jsonl` id mao2022-es-p1 | 1.09 |
| Supernodal LDL^T, indefinite | EO K2 vector pencil order 1, n 24,158, nnzL 960,793, nNeg 6,011, 0 perturbed pivots | 46.8 | 46.4 | 1.01 | 41.3 (`factorMs`, includes forming A + sigma B), EO `logs/vector-bench-20261015T1511Z.jsonl` K2 order1_box0.06 | 1.13 |
| Shift-invert block Arnoldi | same K2 pencil, 2 modes, tol 1e-7, 24 operator applications (log: 24), TE0 n_eff 1.8938016907541757 (log: same) | 94.1 | 90.1 | 1.04 | 100.9 (`eigenMs`), same log line | 0.93 |
| PCG + z-line GMG | APA bench grid M, 93,840 nodes, 4 levels, 11 iterations (log: 11), rtol 1e-10; setup + solve | 189.0 (fresh process 192.5) | 182.5 (179.3); APA solveThermal 193.6 (174.1) | 1.04 (1.07) | 249.6 (setup 35.3 + solve 214.3), APA `logs/bench-20261020T1427.jsonl` grid M wave2-mg-defaults | 0.76 (0.77) |
| GMRES + p-MG | APA em3d TE10 guide, order 2 iterative, 18,662 DOF, coarse 3,187, 19 + 19 GMRES iterations (DevLog-014 G5: 19); solveAt wall | 573 | 586 | 0.98 | none logged (DevLog-014 records iterations only) | N/A |

Interpretation (audit M7): core and atlas run byte-identical function bodies, so in-process ratios near 1.0 are expected by construction (the audit rerun gave 0.93-1.05, about +-7 % noise); the informative evidence is the bitwise-identical results and the vs-log column. The p-MG bench builds `P` with APA `prepare3d`, so `preparePMG` there is APA's; core `preparePMG` is covered by `test/core-coverage.test.mjs` and the APA redirect run.

Gate 3 verdict: within 15 % of the atlas for all families in-process (0.98-1.07). Against the logged numbers: Cholesky 1.09, LDL^T 1.13, Arnoldi 0.93 (within); PCG + GMG 0.76 (outside, faster): APA's own current code measures 0.78 (solveThermal in-process 193.6 ms, fresh process 174.1 ms) against the same log line, whose 3 runs spread 262-318 ms total, so the logged number, not the port, is off; GMRES + p-MG has no logged timing (iterations match). Load average 2.6-3.4 during the runs.


## 5. Module table

LOC = lines of the core `.mjs` (incl. the port header: 2 lines for most files; arnoldi 7, quadrature 6, sweep 11, tri-fe 2 long lines) / its `.d.mts`; rows that group several modules list the `.mjs` lines of each. EO = eo-modulator-atlas `engine/src` at `0546007`; APA = advanced-packaging-atlas `engine/src` at `fe39985`. "Redirect" = the unchanged atlas test files run against the core module through `test/atlas-redirect/` (section 4.2). No source file is newer than its repo's last HEAD reflog entry (EO 2026-11-03 22:22, APA 2026-11-03 23:35; mtime check, no git), so the copied working-tree files are taken as the committed ones.

| Core module | Source path@commit | Changes | Tests (core) | Atlas tests via redirect | LOC |
|---|---|---|---|---|---|
| `units.mjs` | APA `params/units.mjs`@fe39985 (EO `postproc/units.mjs` + K) | none | params-units (2 of 8), expr (1) | EO postproc 18; APA la-params, thermal, materials | 179 / 23 |
| `expr.mjs` | EO `postproc/expr.mjs`@0546007 | none (resolves to APA units) | expr 6 | EO postproc 18, postproc-refine 6 | 523 / 26 |
| `params.mjs` | APA `params/params.mjs`@fe39985 (= EO `params.mjs`) | none; .d.mts adds 4 missing exports | params-units 6 | EO params-expressions 7; APA la-params 8 | 356 / 25 |
| `sweep.mjs` | EO `sweep.mjs`@0546007 (generic part) | config / run / store coupling removed; runner injected; `parametricStudy`, `enumeratePoints` wrap the EO checks; unknown-parameter check only when `params` is given (audit M3, documented) | sweep 3 | (EO sweep tests need EO run.mjs; not redirected) | 115 / 17 |
| `la/sparse.mjs` | APA `la/sparse.mjs`@fe39985 (= EO `sparse.mjs`) | none | la-sparse 7, sparse-fem 7 | EO all; APA all | 1518 / 211 |
| `la/ldlt.mjs` | APA `la/ldlt.mjs`@fe39985 (= EO `ldlt.mjs`) | none | la-ldlt 2 | EO vector-ldlt 2, vector-mode 15; APA em2d / em3d | 831 / 193 |
| `la/complex.mjs` | APA `la/complex.mjs`@fe39985 (= EO) | none | via dense | EO rf / response tests; APA em2d | 43 / 15 |
| `la/dense.mjs` | APA `em2d/dense.mjs`@fe39985 | moved to la/; import path | core-solvers 1 | APA em2d-*, em3d-* | 533 / 70 |
| `la/ldlt-blocked.mjs`, `ldlt-wasm.mjs`, `ldlt-select.mjs` | APA `em2d/ldlt-*.mjs`@fe39985 | moved to la/; import paths; default `blocked` (WASM opt-in) | la-ldlt-wasm 2 | APA em2d-wasm 1, em2d / em3d | 219 / 304 / 27 |
| `la/vector-dense.mjs` | EO `vector-dense.mjs`@0546007 | none | core-solvers 1 | EO vector-mode 15 | 351 / 49 |
| `la/arnoldi.mjs` | EO `vector-mode.mjs`@0546007 lines 825-1087 | extracted verbatim; 4 helpers exported | core-solvers 2 | (internal to EO vector-mode; bench A/B, section 4.3) | 273 / 59 |
| `la/gmres-real.mjs` | EO `semi/linear.mjs`@0546007 | moved; import paths | core-solvers 1 | EO semi-1d-pn 11, semi-rib 10 | 149 / 54 |
| `la/krylov.mjs` | APA `em3d/krylov.mjs`@fe39985 (Palace-derived) | moved to la/ | core-solvers 1 | APA em3d-p2 (iterative) | 221 / 22 |
| `la/pmg.mjs` | APA `em3d/pmg.mjs`@fe39985 (Palace-derived) | moved; imports -> core | core-coverage 1 (iterative = direct, order-2 PEC box) | APA em3d-p2 G1/G2 iterative = direct | 436 / 67 |
| `la/amg.mjs`, `la/ams.mjs` | APA `em3d/amg.mjs`, `ams.mjs`@fe39985 (ams Palace-derived) | moved; not wired (APA status kept) | core-solvers 1 (amg), core-coverage 1 (ams) | none in APA | 281 / 113 |
| `la/order3d.mjs` | APA `em3d/order.mjs`@fe39985 | renamed; import path | core-solvers 1 | APA em3d-* | 77 / 6 |
| `la/stencil.mjs`, `mg.mjs`, `block.mjs`, `halfmg.mjs`, `pcg.mjs` | APA `la/`@fe39985 | none | la-block 5, la-halfmg 3, la-mg 1, la-wasm 3 | APA thermal-*, mech-*, homog-* | 200 / 460 / 685 / 647 / 105 |
| `la/wasm/encoder.mjs`, `kernels.mjs`, `accel.mjs` | APA `la/wasm/`@fe39985 | none (opt-in) | la-wasm 3, core-coverage 1 (kernels) | APA la-wasm 3 | 129 / 197 / 152 |
| `fem/tri.mjs` | EO `fem.mjs`@0546007 | moved; import path | fem-tri 3, sparse-fem 7 | EO electrostatics 4, perf-p2 3, all ES users | 378 / 132 |
| `fem/tri-fe.mjs` | APA `em2d/fe.mjs`@fe39985 | moved; `lengthScale` option on elementMass / elementLoad / assembleByTag, default SI metres (audit S1); APA redirect via um shim | core-coverage 1 | APA em2d-*, em3d-* (45, through `test/atlas-redirect/apa-em2d-fe-um.mjs`) | 259 / 30 |
| `fem/hcurl.mjs` | APA `em3d/hcurl.mjs`@fe39985 | moved | fem-hcurl 1, fem-quadrature 1 | APA em3d-p2 7 | 369 / 75 |
| `fem/nedelec1.mjs` | APA `em3d/elements.mjs`@fe39985 | moved; `LOCAL_EDGES` from mesher -> identical `TET_EDGES` | fem-hcurl 1 | APA em3d-* | 120 / 19 |
| `fem/space.mjs` | APA `em3d/space.mjs`@fe39985 | moved | core-coverage 3 (space, pmg, ams; tet box helper) | APA em3d-p2 | 117 / 43 |
| `fem/q1-grid.mjs` | APA `thermal/assemble.mjs`@fe39985 | moved (generic Q1 hex assembly) | la-block, la-mg, la-wasm | APA thermal-*, mech-* | 300 / 65 |
| `fem/quadrature.mjs` | EO `vector-mode.mjs`@0546007 `Q4` + re-exports | TRI_Q4 copied; GAUSS01 / TRI_QUAD / simplexMoment re-exported | fem-quadrature 2 | - | 20 / 6 |
| `index.mjs` | new | namespace per module | types-smoke.ts, core-coverage 1 | - | 37 / 37 |

Totals: 35 `.mjs` modules, 10,724 lines incl. headers (`wc -l src/**/*.mjs`; 10,720 before the audit follow-up); `.d.mts` 36 files incl. `la/types.d.mts`; test / helpers / fixtures / redirect / bench `.mjs` + `.ts` 2,476 lines (the earlier 2,149 was off by 3: 2,152, audit M6).

## 6. Contract requests

1. **TypeScript for `check`.** Resolved by the coordinator (root `typescript` 5.9.3; `pnpm --filter @amp/core check` exits 0). `packages/core/package.json` lists `typescript` 5.9.3 as a devDependency; nothing is installed (no `pnpm install` run, the lockfile is root-owned). Request: the coordinator adds `typescript@5.9.3` (root devDependency or accepts the package one) and runs `pnpm install`. Until then `pnpm --filter @amp/core check` fails with "tsc not found"; the gate was run with the same version from `advanced-packaging-atlas/app/node_modules` (read only).
2. **tsconfig.base libs.** Resolved: `tsconfig.base.json` lib is now `[ES2023]`; core keeps `[ES2023, WebWorker]`, skipLibCheck false. `lib: [ES2023, DOM, DOM.Iterable, WebWorker]` makes lib.dom and lib.webworker conflict, which forces `skipLibCheck: true`, and skipLibCheck also skips every package's own `.d.mts`. `@amp/core` overrides to `lib: [ES2023, WebWorker]`, `skipLibCheck: false` (clean). Proposal: base without DOM + WebWorker together; each package picks one.
3. **Tet mesh fields for H(curl).** Delivered by L3 (`packages/mesh/src/hcurl.ts` `toHcurlMesh`); core types the shape as `HcurlTetMesh` in `src/la/types.d.mts`. `fem/space.mjs`, `fem/nedelec1.mjs` and `la/pmg.mjs` read the APA em3d mesh object: `nodes` (Float64Array, 3 per node, metres), `nNodes`, `tets` (Int32Array, 4 per tet, **vertex indices sorted ascending per tet**: the hierarchical basis needs it for global consistency without signs), `nTets`, `edges` (2 per edge), `nEdges`, `tetEdges` (6 per tet, local pairs 01 02 03 12 13 23), `edgeIndex(a, b)`, and `tetSolid` (pmg PEC handling). Request: C2 `Mesh` (L3) gets an adapter `toHcurlMesh(mesh)` producing these, or C2 adds them as optional derived fields.
4. **Temperature display units.** `units.mjs` (APA) has K, mK and K-based compounds but no degC (affine: needs an offset, not only a factor). If L2 / L5 want `degC` in the spec or display, `parseUnit` must return an offset too; that is a change of the `{dim, factor}` shape, so it goes through the coordinator.
5. **Sweep API.** `@amp/core/sweep` is now config-free: `parametricStudy(sweep, {params})`, `pointValues`, `enumeratePoints`, `rejectSweptOverrides`, `runSweep(study, runPoint, {signal, stopOnError}, onPoint)`. The study block keys (`type: parametric`, `stages`, `outputs`, `sweep_targets`) and study selection by name belong to the spec (L2).


## 7. Refactor proposals (not done; numerics left as ported)

1. One expression grammar: `params.mjs` (config `=expr`, real only, key-suffix units) and `expr.mjs` (complex, unit literals, dimension inference) parse overlapping languages (R1 section 8 said the same). Merge into `expr.mjs` with a real-only mode, once L2 settles the spec units-as-values (A3) and key suffixes go away.
2. One CSR mat-vec / pattern type: `sparse.matVec`, `pmg.spmv` (complex), `tri-fe.cmatvec`, `amg` local `spmv`, EO vector-mode `csrMatVec` (still in EO) do the same job on the same `{n, rowptr, colidx, nnz}` shape.
3. Two GMRES: `la/gmres-real.mjs` (EO, real, Saad-Schultz) and `la/krylov.mjs` (APA, complex, Palace-style). A complex GMRES with a real fast path would serve both.
4. A generic shift-invert eigen driver: EO `solveReal` / `solveComplex` wrap `blockArnoldi` with the shift, inertia (Sylvester) check, warm start and adaptive shift. The generic part (factor A + sigma B with `ldlt`, op = K^-1 B, theta = sigma - 1/mu, inertia count) can move into `la/` so L4's cavity (H5) and acoustics (H6) eigen solves reuse it without copying EO code.
5. `fem/tri.mjs` (EO) and `fem/tri-fe.mjs` (APA) both implement P1/P2 triangle spaces and `p2Grad` / `restrictMatrix` variants (APA's is a partial port with additions). Converge on one triangle-space module with element abstraction (P1/P2, scalar/vector) before L4 writes 2D elasticity (H1).
6. Declarations: la / fem `.d.mts` are generated from JSDoc and keep `any` for untyped parameters (`CsrPattern`, symbolic analysis, stencil operator, MG hierarchy are inline object types or `any`). Hand-tighten the shared types into one `la/types.d.mts` when the modules are next edited (A2).
7. `la/pmg.mjs` and `la/ams.mjs` take an em3d-shaped context (`{order, R, space, mesh, solidProps, inDomain, dirichlet}` with solid PEC semantics). A thinner interface (fine matrix, order-1 prolongation, discrete gradient) would make them independent of the em3d case model.
8. AMG / AMS are still not wired anywhere (APA G12); wiring AMS as the order-1 coarse solve is the path past the direct coarse budget (~6e4 DOF in the browser, R2 section 4).


## 8. Hand-off

State 2026-11-06 15:35 PST (updated 16:01 after the audit follow-up, section 9): `@amp/core` complete for the L1 scope. Gates as set in the lane brief: (1) ported atlas tests pass (4.1), (2) `tsc --noEmit` clean with `.d.mts` declarations (progress 15:33, section 9), (3) benchmarks within 15 % (4.3), (4) module table (section 5); all met (gate 3 against the atlas in-process for all five workloads; against logs for 3 of 4 logged workloads, the PCG + GMG log line is slower than APA's own current code, see 4.3).

- Import: `@amp/core/units`, `@amp/core/expr`, `@amp/core/params`, `@amp/core/sweep`, `@amp/core/la/<name>`, `@amp/core/fem/<name>`, or the namespaces of `@amp/core` (`index.mjs`). Inside the repo, relative imports of `packages/core/src/...` work without install.
- Run: `cd packages/core; node --test test/*.test.mjs` (67 tests, ~7 s). Types: `pnpm --filter @amp/core check` (`tsc -p . --noEmit`; `test/types-smoke.ts` holds the wrong-call probes). Bench: `nice -n 10 node --max-old-space-size=1536 bench/core-bench.mjs --eo <eo>/engine --apa <apa>/engine [--runs 7] [--only direct,arnoldi,mg,pmg]` (~25 s, log in `logs/`). Atlas fidelity: from the atlas engine dir, `AMP_EO_ATLAS=$PWD node --import <core>/test/atlas-redirect/register.mjs --test --test-concurrency=1 tests/*.test.mjs` (EO ~105 s; APA with `AMP_APA_ATLAS`, ~250 s).
- Regenerate the grid fixture: `node test/fixtures/gen-apa-grids.mjs --apa <apa>/engine`.
- For L4: the WASM complex LDL^T stays opt-in (`setDefaultFactor('wasm')` or `makeFactor('wasm', sym)`); `fem/q1-grid.mjs` is the generic Q1 hex assembly used by the APA thermal path; the shift-invert driver around `blockArnoldi` is still in EO (`vector-mode.mjs` solveReal), see proposal 4; the bench Arnoldi function is a 30-line working example of it.
- Open: contract requests 1-5; refactor proposals 1-8; fresh-context audit (coordinator).

## 9. Audit corrections

Audit `DevLog/audits/2026-11-06-L1-core-audit.md` (no blocking findings). Follow-up asked by the coordinator: S1, S2, S3, M3, M6 (S4 physics gaps go to L4; no new numerics added here). Done 2026-11-06 15:45-16:01 PST.

| Finding | Correction | Evidence |
|---|---|---|
| S1 tri-fe micrometres | `fem/tri-fe.mjs`: `elementMass(space, geo, t, Me, lengthScale = 1)`, `elementLoad(..., lengthScale = 1)`, `assembleByTag(..., {lengthScale = 1})`; `lengthScale` = metres per mesh coordinate unit, default SI per C1 / C2; `UM = 1e-6` exported (APA behaviour), `UM2` kept. Port header and module doc updated. APA redirect maps `em2d/fe.mjs` to the shim `test/atlas-redirect/apa-em2d-fe-um.mjs` (same exports, `lengthScale = UM` default). `fem/tri.mjs` has no fixed scale (documented in its `.d.mts`) | core-coverage test 1: integral of 1 over the unit square = 1 m^2 to 1e-12 for P1 / P2 mass sum, load sum and `assembleByTag` mass, in metres (default) and in um with `lengthScale UM`. APA em2d-* / em3d-* via the shim: 39 / 39 + em3d 6 / 6 pass (`logs/core-redirect-apa-em-20261106T155815.log`, `logs/core-redirect-apa-em3d-20261106T155951.log`) |
| S2 untyped declarations | `src/la/types.d.mts` (CsrPattern, SymbolicAnalysis, NumericFactor, LdltFactorResult, StencilOp, BlockStencilOp, Precond, TriMesh, TriGeometry, HcurlTetMesh, DiagComplexTensor). Hand-written, `any`-free: sparse, ldlt, ldlt-blocked / -wasm / -select, pcg, stencil, mg (buildMG / mgPrecond / MGHierarchy), krylov, gmres-real, arnoldi, fem/tri, fem/tri-fe, fem/space, fem/nedelec1; hcurl element / table / quadrature signatures (`tetMatricesP`, `triTraceMass`, `tetTables`, `triTables`, `compileBilinear`, `evalBilinear*`, `simplexMoment`, `TRI_QUAD`) and `GAUSS01` typed. Remaining `any`: basis-construction internals of hcurl, block / halfmg / dense / amg / ams / pmg / q1-grid / wasm internals (not on the downstream list) | `test/types-smoke.ts`: 13 `@ts-expect-error` probes incl. the audit's 4 (`new SparseCholesky('not a pattern')`, `gmres(1, 2, 3, 4)`, `buildSpace({ nonsense: true }, 7)`, `const z: string = buildSpace(...).nDof`) plus parseUnit(3), makeFactor with a SymbolicLDLT, pcg({}), buildMG with number[], wrong Arnoldi operator, factor(pattern), tetMatricesP order 3, bad expr scope kind, string lengthScale. With the directives removed, each of the 13 lines errors (TS2345 / TS2353 / TS2322); with them, `tsc -p . --noEmit` exit 0 (`logs/core-tsc-20261106T155603.log`, empty). The tightened types also caught a wrong call in the earlier smoke test (makeFactor given a SymbolicLDLT) |
| S3 core-suite gaps | `test/helpers/tet-grid.mjs` (structured Kuhn tet box, vertex indices ascending, APA em3d edge numbering) and `test/core-coverage.test.mjs` (6 tests): tri-fe (S1), space (DOF counts order 1 = nEdges, order 2 = 2 nEdges + 2 nFaces, Euler V - E + F - T = 1, faceDofs / dofPoint), pmg (order-2 PEC box, 1,058 free DOFs, coarse 163: GMRES + p-MG 16 iterations, relres 9.5e-11, max relative difference to the direct complex LDL^T 2.8e-10), ams (order-1 level of the same box, nodal interpolation from the edge vectors: AMS-preconditioned GMRES 14 iterations vs 195 unpreconditioned at rtol 1e-8), wasm kernels (27-point apply = JS applyStencil to 1e-14, scalar and f64x2), index (34 namespaces, bindings identical to the module files) | core suite 67 / 67, 16 files, 7.2 s (`logs/core-test-20261106T155603.log`) |
| M3 sweep | header and `.d.mts` state that the unknown-parameter check runs only when `params` is given (EO always checks); behaviour unchanged | `src/sweep.mjs` lines 8-10 |
| M6 DevLog slips | Arnoldi range 825-1087 in 1.1; DevLog-013:354 and DevLog-014 line 172; line totals recounted; header lengths; contract requests 1-3 marked resolved / delivered; gates 1-4 named in section 8; M7 interpretation note in 4.3 | this file |

Gates after the follow-up: core suite 67 / 67; EO redirect suite unchanged at 334 tests, 331 pass, 0 fail, 2 skipped, 1 todo (109.4 s, `logs/core-redirect-eo-20261106T155618.log`); tsc clean; all 13 probes are compile errors. No file in either atlas is newer than the new test file (find -newer), so nothing was written there. Not done (out of the asked scope): M1, M2, M4, M5, M8, M9; S4 belongs to L4 (proposals 4 and 5 in section 7 remain L1 candidates if the coordinator assigns them).


## 10. detmath moved into core (coordinator request, 2026-11-06 17:00-17:11 PST)

Request: L3 found that Node v23.7.0 and Chrome 156 differ in the last ulp of Math.sin / cos / atan2 / log / exp / pow (DevLog-004 s.9) and wrote `detmath` (IEEE + - * / and sqrt only) in packages/geom. Move it to `@amp/core/detmath`, make `@amp/core/expr` use it, re-export it from geom (one-time geom edit granted), add a cross-runtime fixture test, and rerun core, geom, mesh and `packages/mesh/test/xplat.test.ts`.

Done:
- `packages/core/src/detmath.ts`: L3's file, body byte-identical (`diff` of the bodies empty), 2 header lines added. TypeScript (new code per C1), exported as `@amp/core/detmath` (package.json `exports`) and as the `detmath` namespace of `index.mjs`; core tsconfig now includes `src/**/*.ts`.
- `packages/geom/src/detmath.ts` (the one granted geom edit; backup of L3's version in the session scratchpad): now `export * from '../../core/src/detmath.ts';`. **Deviation:** a relative path, not the bare `@amp/core/detmath`. The bare specifier would need two edits outside the grant: `@amp/core` in geom's package.json dependencies plus `pnpm install`, and an `@amp/core/detmath` entry in the browser import map of `packages/mesh/test/xplat.test.ts`. Both modules resolve to the same file (pnpm links resolve to the real path). The coordinator can switch to the bare specifier with those two edits.
- `src/expr.mjs` changes (port header updated):
  - Through detmath: sin, cos, tan (as sin/cos from `sinCos`), atan2, exp, log and log10, plus the complex exp/log paths.
  - Real `^` with a non-constant or non-integer exponent uses a new `detPow`:
    - 0 and 1 cases handled first;
    - `b = 0.5` by sqrt;
    - integer `|b| <= 1024` by repeated squaring;
    - otherwise `exp(b log a)`.
  - Constant integer exponents still go through `powInt` (multiplications only); `10^-4` = 1e-4 exactly.
  - Not changed (documented): Math.cosh / sinh in the imaginary part of complex sin / cos, and Math.hypot (L3 measured hypot equal across engines).
  - Accuracy against Math on the fixture inputs:

| Function | Max error vs Math (measured, fixture inputs) |
|---|---|
| sin, cos | 1.1e-16 absolute |
| atan2 | 8.9e-16 absolute |
| log, exp | 2.2e-16 relative |
| tan | 1.5e-15 relative |
| pow | 7.5e-15 relative (`exp(b log a)` amplification, \|b log a\| <= 46) |

- Cross-runtime fixture:
  - Inputs: `test/helpers/detmath-xplat.mjs` gives 4000 fixed inputs each for sin/cos, atan2, log, exp and pow (an LCG, IEEE arithmetic only). It records output bits for detmath, Math and `@amp/core/expr` (array evaluation over field variables).
  - Generator: `test/fixtures/gen-detmath-xplat.mjs` runs the same source files in Node and in every Chromium it finds, through Playwright request interception with types stripped (as xplat.test.ts). It takes playwright-core from packages/mesh.
  - Output: `test/fixtures/detmath-xplat.json` (5 KB) holds the SHA-256 of each output set.
  - Result at generation: headless shell Chromium 151.0.7922.34 and Chrome 156.0.8078.80 each match Node on all det.* and expr.* digests. Both differ from Node on all six Math.* digests (sin, cos, atan2, log, exp, pow).
- `test/detmath.test.mjs` (4 tests):
  - accuracy bounds;
  - special values, plus ldexp / frexp / roundLog2;
  - Node reproduces every Chromium det.* and expr.* digest, and the fixture records the Math.* disagreement;
  - `^` exactness (`10^-4`, `(-8)^3`, `2^0.5` = Math.SQRT2, integer field exponents) and pow within 1e-14 of Math.
- Check that the test bites: with `Math.sin` restored in expr's real sin path, the cross-runtime test fails on `expr.sin`. With the detmath path it passes.
- `core-coverage` index test updated for the `detmath` namespace.

Results:

| Run | Result | Log (`logs/`) |
|---|---|---|
| core suite | 71 / 71 pass, 17 files | `core-test-20261106T170911.log` |
| core tsc | exit 0 (empty log) | `core-tsc-20261106T170911.log` |
| geom tests | 37 / 37 | `core-detmath-geom-test-20261106T170925.log` |
| mesh tests | 14 / 14 | `core-detmath-mesh-test-20261106T170925.log` |
| geom tsc, mesh tsc | exit 0 | same stamp |
| `packages/mesh/test/xplat.test.ts`, alone | 1 / 1, 3.7 s; not skipped, so the browser loaded the core file through the relative re-export | `core-detmath-xplat-20261106T171006.log` |
| EO expression tests via the redirect (postproc, postproc-refine, params-expressions) | 34 / 34 | `core-redirect-eo-postproc-20261106T171019.log` |

Open:
- `units.mjs` computes `u.factor ** p` for unit exponents, e.g. `um^2`. JS `**` is implementation-approximated for non-trivial cases (`10 ** -4` differs between Node and Chrome, DevLog-004 s.9). Exponent 1, the usual case for lengths, is exact. Making unit powers go through repeated multiplication is a small follow-up that was not requested.
- The bare-specifier re-export from geom (see Deviation above).
