# DevLog-060: solver, part 3 (lane G3, chunk 3)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | G3 (DevLog-037 s.4.2) |
| Owns | `packages/core/**`; `packages/physics/src/common/**` incl. `lagrange.ts`; `packages/physics/src/{elastic,heat,em3d,coupled}/**`; `packages/physics/src/driver.ts` (merge lines only); new tests and bench files; this file |
| Not owned | spec registration (`packages/spec/**`), wave2d, modes, prepare.ts, post, eval, mesh, geom, sims (coordinator or other lanes: requests) |
| Read | CLAUDE.md; DevLog-037 s.4.1, s.4.2; DevLog-054 (all); DevLog-045 s.5-7; DevLog-049 R3; DevLog-050 (inertia check, O7); `packages/spec/src/types/solution.ts`; `common/{scalar,eigen,lagrange,quad}.ts`; `elastic/index.ts`; `driver.ts`; `core/src/la/amg.mjs`; `wave2d/bands.ts` (checkedEigen, read only) |

Conventions: F = fact read from code or a run; D = decision of this lane; E = estimate; O = open item; R = request.

## 1. Plan (2026-11-18 18:16 PST, before coding)

### 1.1 Facts
- F: `STUDY_SOLVER_TYPES = ['heat', 'electrostatics', 'currents']` (`common/scalar.ts`); `withStudySolver` swaps `SpdSolver` kind 'cholesky' to AMG-PCG ('amg-pcg' / 'auto'). The core AMG (`la/amg.mjs`) is scalar smoothed aggregation with the constant vector as the only near-null vector: for elasticity it misses the three rotations (and per-component translations are mixed in one aggregate), so it does not suit elasticity (the comment in scalar.ts says so).
- F: elastic 3D builds `K` on the node-blocked pattern (DOF = 3 node + c), restricts to free DOFs (rollers fix single components, so free DOFs per node are 1-3), then `new SpdSolver(R.pat, p.solver ?? 'cholesky')`.
- F: the spec's stationary study already accepts `settings.solver: direct | amg-pcg | auto` and `rtol` for any physics; its description names heat / electrostatics / currents only (wave1.ts:81, coordinator-owned).
- F: `RunRecord.solver?: SolverRecord & { byPhysics? }` and `SolverRecord {kind: 'direct' | 'amg-pcg' | 'ams-pcg'; rtol; iterations; residual}` exist in `solution.ts`; no producer fills them yet; `driver.ts mergeSolutions` copies `first.run`.
- F: `common/eigen.ts shiftInvertEigen` has no completeness check; users: acoustics, elastic/modal, em3d, em-axisym, optomech/axisym, coupled/piezo, wave2d/bands (which checks inertia itself via `checkedEigen`, retrying with a larger search space).
- F: tet rules: `defaultRule(tet, d)` = collapsed Gauss `tetRule(ceil((d + 3) / 2))`: elastic and scalar tet10 ask degree 4 -> 64 points; affine tet10 stiffness needs degree 2, mass degree 4, thermal load degree 3.

### 1.2 Design
1. Elastic AMG (smoothed aggregation with the rigid-body near-nullspace, Vanek, Mandel, Brezina 1996, Computing 56:179-196): new core `la/amg-sa.mjs` `buildAMGBlock(A, {nodeOf, B, nB, theta})`: aggregation on the node graph (strength by the Frobenius norm of the node blocks), tentative prolongator by a QR per aggregate of the near-nullspace rows of its free DOFs (rank-revealing: an aggregate with fewer independent rows keeps fewer coarse DOFs), coarse near-nullspace = the R factors, prolongator smoothing P = (I - omega D^-1 A) T with omega = 4 / (3 rho(D^-1 A)), Galerkin coarse operators, symmetric Gauss-Seidel V-cycle, dense Cholesky on the coarsest level. Near-nullspace for 3D: 3 translations + 3 rotations about the mesh centroid (2D: 2 + 1), rows of the fixed DOFs dropped. Justification: the constant vector alone leaves the rotations (and plate bending, a near-rotation locally) unresolved on coarse levels; SA with rigid-body modes is the standard algebraic method for elasticity (ML / PyAMG / GAMG use it). `SpdSolver` gets an optional near-nullspace hook so elastic passes its node map and coordinates; `STUDY_SOLVER_TYPES` adds 'elastic' (stationary only; modal path unchanged).
   Gate: PK-06 die-warpage-3d and PK-02 tsv-stress-3d with `solver: amg-pcg` vs direct, every evaluation item within the solver tolerance (relative difference vs rtol * condition-level bound; stated); the DevLog-049 R3 plate meshes (hmax L/20 with 4 + 3 layer cells, 47k DOF; hmax L/12, 113k DOF) under the 2 GB guard, direct vs AMG-PCG, wall time and RSS.
2. `run.solver` producers: `withStudySolver` fills `sol.run.solver` from its records (kind, rtol, max iterations, max residual; direct -> nulls) for heat / electrostatics / currents / elastic; em3d fills it from its path ('direct' or 'ams-pcg'); modules that do not record leave it undefined (no change to their output). `driver.ts mergeSolutions`: `run.solver` of the merged solution = the first recorded physics' record plus `byPhysics` per group key (merge lines only).
3. Eigen completeness in `shiftInvertEigen`: option `check: 'auto' | 'inertia' | 'off'`. 'inertia': for the lowest-mode search (sigma below the spectrum) one LDL^T of K - theta M (same symbolic analysis) at theta in the last gap among the computed eigenvalues; count must equal the number found below theta; interior shifts: the count between sigma (inertia from the LDL^T already done) and a gap point above / below. Miss -> retry with a larger nWant / basis and another seed (up to 3), keep the requested number; never two factors alive at once where avoidable. 'auto' (default): 'inertia' when the factor is small (stored-L budget, measured), else skipped and reported in stats. Returned eigenpairs are the same object values when the check passes: bitwise unchanged (proved on the class-a eigen cases and the 3D sims).
4. AMS speed (DevLog-054 O1): profile first; then WASM SIMD CSR spmv / Gauss-Seidel or Chebyshev smoothing in `la/ams-real.mjs`; bitwise where only the kernel changes, else a documented tolerance; timing table at 36,832 and 85,108 DOF (cylinder-cavity h 1, 0.75).
5. Degree-matched tet quadrature as an option (default unchanged): `lagrange.ts setTetQuadrature('collapsed' | 'matched')` (also env `AMP_TET_QUADRATURE` for Node runs): symmetric positive-weight tet rules (4-point degree 2, 14-point degree 5; constants refined by Newton on the exact moment equations and checked by tests) for the requested degree, and per-term degrees on affine tet10 cells in elastic / scalar assembly (stiffness 2(p - 1)); curved cells keep the collapsed rule. Full eval a / b / c (WO-65 skipped) on and off; table of every gated target that changes.

### 1.3 Measurement protocol
- `nice -n 10 node --max-old-space-size=1536`, RSS guard (kill above 1.95 GB) on every 3D run, one heavy process at a time, warm medians where noise matters, load average per row; logs `logs/solver-3-*-<stamp>.*` (small); dumps in the scratchpad, deleted after summarising.
- Identity: class-a CLI with defaults vs `logs/eval-20261118T150402.jsonl` (target values bitwise); eigen bitwise via bench dumps (`perf-core-1.mjs --dump`, `--compare`).

### 1.4 TODO
- [x] Baseline: class-a eigen dumps; PK-06 / PK-02 direct values; R3 plate meshes direct (guarded)
- [x] Task 1: `la/amg-sa.mjs`, SpdSolver hook, elastic in STUDY_SOLVER_TYPES, tests, gates, table
- [x] Task 2: run.solver producers + driver merge, test
- [x] Task 3: eigen completeness check, retry, tests, identity proof
- [x] Task 4: AMS profile, kernels, timing table
- [x] Task 5: tet quadrature option, tests, full eval on / off, table
- [x] After: core / physics tests, pnpm -r check, class-a CLI identity, requests, hand-off (full `pnpm test` of the other packages not run by this lane)

## 2. Progress log

- 2026-11-18 18:16 PST: read the brief and the listed DevLogs and code; plan above.
- 2026-11-18 18:18-18:20 PST: baseline (scratch runner: prepareRun + runStudy + the results adapter's evalItemValue): PK-06 die-warpage-3d hF 1 direct 6,807 DOF; the DevLog-049 R3 first mesh (hmax L/20, layer cells 4 + 3) at hF 1 = 60,337 DOF (elastic 46,596): direct solves in 7.0 s at 1.22 GB RSS (load 20). F: the R3 statement "did not finish in 180 s at 1.2 GB" is not reproduced at that level; its hF 0.5 level (the eval's second level) has 352,760 elastic DOF.
- 2026-11-18 18:21-18:24 PST: `packages/core/src/la/amg-sa.mjs` (`buildAMGSA`, `rigidBodyModes`, typed `csrMatMatTyped` / `csrTransposeTyped`); `SpdSolver` preconditioner hook; elastic in `STUDY_SOLVER_TYPES` (eigen studies excluded). Plain SA on the tet10 system: 46,596 DOF 142-180 PCG iterations (theta 0-0.08); rotations matter (translations only: 346); 356k DOF killed by the guard at 1.97 GB (smoothed prolongator on tet10 node stencils of 30-60 nodes).
- 2026-11-18 18:25-18:27 PST: D: P2 -> P1 two-level p-multigrid (`buildTwoLevel`; Lagrange interpolation onto the free vertex components, Gauss-Seidel on P2) with SA + rigid-body modes on the Galerkin P1 operator (`elastic/index.ts elasticPreconditioner`). 46,596 DOF: 56 iterations, 1.2 s solve, 386 MB peak; 87,168 DOF: 98 iterations; 352,760 DOF: 98 iterations, 46 s wall (assembly 18.8 s), 1.55 GB peak (s.3.1).
- 2026-11-18 18:27-18:29 PST: gate runs PK-02 / PK-06 hF 1 and 0.5, direct vs amg-pcg vs auto (`logs/solver-3-elastic-gate-20261118T182700.jsonl`), s.3.1. `run.solver` producers (`withStudySolver`: every SpdSolver of heat / electrostatics / currents / elastic outside eigen studies, with or without the setting; em3d) and `mergeSolverRecords` + 2 driver lines. Test `perf-core-1.test.ts` STUDY_SOLVER_TYPES assertion updated (elastic added; non-listed physics now checked with 'acoustics').
- 2026-11-18 18:29-18:33 PST: eigen completeness check in `shiftInvertEigen` (`check`, `nullDim`, `setEigenCheckDefault`, `setEigenCheckListener`, `eigenCheckNote`; notes in elastic modal, piezo, em3d when a search was repeated or still misses). Test `packages/physics/test/g3-solver-3.test.ts` 4/4. Identity on the 3D eigen sims (`logs/solver-3-eigen-ident-20261118T183146.jsonl`), s.3.2.
- 2026-11-18 18:34 PST: coordinator relay of lane G2's producer patch (DevLog-059 s.6 R1, `<scratch>/g2/patch/g2-producer.diff`): dry run clean on this lane's tree, applied unchanged (`packages/spec/src/types/solution.ts` FieldData.elementNodal, authorised by the coordinator; `elastic/index.ts`, `elastic/axisym.ts`: element values at the cell nodes kept, nodal data unchanged). Check: physics typecheck clean; PK-02 tsv-stress-3d direct `cu_sxx_mean` 170.11470 MPa (hF 1), 170.10115 MPa (hF 0.5) against the closed form 170.1001 MPa: +8.58e-5, +6.2e-6 (G2: +8.58e-5, +6.12e-6); the point items (cu_sxx, cu_szz, si_szz, rim_ur, si_sxx_2a, si_syy_2a) bitwise equal to the 18:27 gate run.
- 2026-11-18 18:35-18:38 PST: `packages/core/src/la/wasm/csr.mjs` (scalar f64 CSR spmv and forward / backward Gauss-Seidel, bitwise equal to the JS loops; `makeCsrKernels`, `setDefaultCsrKernel`, `CSR_MIN_NNZ` 20,000); used by `ams-real.mjs` (fine-level residuals, Gauss-Seidel, PCG product; per value array, copied on first use), `amg.mjs` and `amg-sa.mjs` V-cycles. Bench `packages/core/bench/csr-bench.mjs` (35,152 rows, 1.76M entries: spmv 1.13 -> 0.67 ms, Gauss-Seidel 2.81 -> 0.86 ms, bitwise). `perf-core-2-em3d.mjs --csr js|wasm`. Test `packages/core/test/la-csr-kernels.test.mjs` 2/2.
- 2026-11-18 18:39-18:44 PST: degree-matched tet quadrature option: `quad.ts symTetRule` (1 / 4 / 14 points, degree 1 / 2 / 5; moments exact to 4.7e-16 relative), `lagrange.ts setTetQuadrature('collapsed' | 'matched')`, `tetQuadrature`, `isAffineTet10`, env `AMP_TET_QUADRATURE`; elastic per-term rules on affine tets in 'matched'. Tests in `g3-solver-3.test.ts` (6/6).
- 2026-11-18 18:45-18:52 PST: AMS timing rows (s.3.3); `packages/core/src/la/wasm/csr.d.mts`; core typecheck clean. Tests: core 103/103 (`logs/solver-3-test-core-20261118T184858.log`), physics 209/209 (`logs/solver-3-test-physics-20261118T184858.log`), with the G2 producer patch applied. Eval runs a / b / c (c without WO-65) with defaults, then with `AMP_TET_QUADRATURE=matched`, started 18:53 (logs under `logs/solver-3-eval-default/`, `logs/solver-3-eval-matched/`).
- 2026-11-18 18:53-19:13 PST: eval with defaults: class a 16 / 0 / 13 (`logs/solver-3-eval-default/eval-20261118T185302.jsonl`), b 2 / 1 / 17 (`...T185354`), c 35 / 1 / 27 (`...T185408`, WO-65 skipped), s.3.5. The class c run was not RSS-guarded and PK-05 level 2 peaks above 5 GB (below): a breach of the 2 GB rule by this lane's run, about 70 s.
- 2026-11-18 19:05-19:20 PST: coordinator relay: PK-05 (interposer-thermal-3d, 3D heat, stationary) peaks at 4.8 GB. Investigation s.3.6: the same peak with the committed HEAD code (extracted to the scratchpad with `git archive`, read only): not a regression of this chunk; the direct Cholesky of level 2 (333,186 DOF) stores 334M entries of L (2.5 GiB). `settings.solver: auto` on the study gives AMG-PCG and 1.44-1.54 GB; request R5.
- 2026-11-18 19:16-19:34 PST: eval with `AMP_TET_QUADRATURE=matched`: a (`logs/solver-3-eval-matched/eval-20261118T191614.jsonl`), b (`...T191710`), c without WO-65 and PK-05 (`...T191722`), s.3.4. Plate assembly timing collapsed vs matched; PK-05 level 1 with 'auto' stays direct (1.98e5 flop/DOF < 3e5).
- 2026-11-18 19:35 PST: `g3-solver-3.test.ts` 7/7 (2D tri3 / tri6 AMG test added); `pnpm -r check` exit 0 (`logs/solver-3-check-20261118T193510.log`, apps/web 0 errors). Scratch copies (HEAD extract, dumps) deleted.

## 3. Results (Node v23.7.0, Apple M4 Pro 12 cores; `nice -n 10`, heap 1536 MB, RSS guard 1.95 GB; seven other lanes running, load average per row)

### 3.1 Elastic in the study solver setting (task 1)

Preconditioner (D): P1 cells: smoothed aggregation (Vanek, Mandel, Brezina 1996) with the rigid-body modes (3 translations, 3 rotations about the centroid; rows of fixed DOFs dropped) as the near-nullspace, node aggregation by the Frobenius strength of the 3 x 3 blocks (theta 0.02), QR per aggregate. P2 cells (tri6 / tet10): two-level p-multigrid, Lagrange P1 interpolation onto the free vertex components, symmetric Gauss-Seidel on the P2 system, the SA hierarchy above on the Galerkin P1 operator. Why: the scalar SA (constant vector only) needed 349-367 iterations on PK-06 hF 1 against 110 with the rigid-body modes; plain SA directly on tet10 needs 142-180 iterations at 46.6k DOF and its smoothed prolongator (tet10 node stencils of 30-60 nodes) exceeded the 1.95 GB guard at 352k DOF; the P2 -> P1 step gives 56 iterations at 46.6k DOF and 98 at 352k DOF.

Gate, AMG-PCG (rtol 1e-10 on ||b - A u|| / ||b||) vs direct, every evaluation item of the sim (`logs/solver-3-elastic-gate-20261118T182700.jsonl`):

| Sim (case) | hF | elastic DOF | direct factor + solve ms | AMG-PCG setup + solve ms | PCG iterations | max relative item difference | 'auto' picks | peak RSS direct / AMG MB |
|---|---|---|---|---|---|---|---|---|
| tsv-stress-3d (PK-02) | 1 | 11,986 | 146 | 199 | 33 | 6.1e-11 | direct | 292 / 245 |
| tsv-stress-3d (PK-02) | 0.5 | 90,489 | 6,467 | 1,914 | 40 | 3.0e-11 | AMG-PCG | 1,568 / 662 |
| die-warpage-3d (PK-06) | 1 | 5,337 | 83 | 257 | 109 | 1.9e-10 | direct | 234 / 197 |
| die-warpage-3d (PK-06) | 0.5 | 38,310 | 2,407 | 1,966 | 90 | 7.6e-11 | AMG-PCG | 1,028 / 366 |

Items: PK-02 cu_sxx, cu_szz, si_szz, cu_sxx_mean, si_szz_mean, rim_ur, si_sxx_2a, si_syy_2a; PK-06 uz_p1, uz_p2, uz_corner. The differences are of the size the residual tolerance allows (a relative residual of 1e-10 bounds the relative error by cond(A) 1e-10); every case tolerance is >= 2e-3. 'auto' uses the scalar rule (AMG-PCG when the AMD factor costs >= 3e5 flop per DOF or > 1 GiB): it picks the direct path on both hF 1 levels and AMG-PCG on both hF 0.5 levels, where AMG-PCG is faster and needs less memory.

Plate-like case (DevLog-049 R3 mesh: hmax L/20, layer cells 4 + 3; and hmax L/12):

| Mesh | hF | total / elastic DOF | Solver | elastic iterations | wall s | elastic factor+solve s | peak RSS MB | load |
|---|---|---|---|---|---|---|---|---|
| L/20, 4 + 3 | 1 | 60,337 / 46,596 | direct | - | 7.0 | 3.6 | 1,216 | 20.6 |
| L/20, 4 + 3 | 1 | 60,337 / 46,596 | amg-pcg | 56 | 5.4 | 1.4 | 385 | 8.4 |
| L/12 | 0.5 | 113,343 / 87,168 | direct | - | - | - | 2.5 GB (DevLog-049 R3) | - |
| L/12 | 0.5 | 113,343 / 87,168 | amg-pcg | 98 | 11.4 | 4.6 | 574 | 8.3 |
| L/20, 4 + 3 | 0.5 | 463,379 / 352,760 | amg-pcg | 98 | 45.9 | 18.2 | 1,554 | 9.8 |

- F: the 47k-DOF level did finish with the direct solver (7.0 s, 1.22 GB); the R3 failure was most likely the eval's second level (352,760 elastic DOF), which the AMG path now solves in 46 s inside 1.55 GB (the elastic assembly, 18.8 s of it, uses the 64-point collapsed rule: s.3.4).
- The study setting reaches elastic through `settings.solver` on the stationary study (already accepted by the spec); defaults unchanged (direct).

### 3.2 Eigen completeness check (task 3)

Identity (`logs/solver-3-eigen-ident-20261118T183146.jsonl`): each eigen study run with the check 'off' (the former algorithm: same calls in the same order), 'auto' (default) and 'inertia', same process:

| Sim | study | DOF | auto | inertia: status, intervals count/found | check ms (inertia) | run ms off / inertia | fields, scalars bitwise (auto, inertia) |
|---|---|---|---|---|---|---|---|
| box-acoustics | eig | 693 | pass | pass, 10/10 | 5 | 231 / 53 (first run cold) | 11/11, 11/11 |
| pzt4-cube | std_sc | 36,448 | skipped (factor 32.7M entries > 8M) | pass, 8/8 | 2,909 | 11,241 / 13,863 | 20/20, 20/20 |
| pzt4-cube | std_oc | 36,449 | skipped (34.8M) | pass, 8/8 | 3,535 | 11,379 / 14,223 | 20/20, 40/40 |
| cylinder-cavity (em3d, projector, nullDim = H1 null space) | eig | 36,832 | skipped (15.5M) | pass, 15/15 | 1,002 | 5,305 / 6,127 | 32/32, 32/32 |
| cylinder-cavity-qd | eig | 1,006 | pass | pass, 1/1 | 2 | 239 / 33 | 4/4, 4/4 |

- Design: lowest-mode search (sigma below the spectrum): inertia of K - theta M at theta in the last gap (relative 1e-6) among the computed eigenvalues above sigma, compared with the number found in (sigma, theta] (count at sigma from the factor already made: 0 for Cholesky, nNeg for LDL^T). Interior shifts: the same above sigma, and below sigma at the first gap. A mismatch reruns the block Arnoldi (factor kept) with nWant + 4a, a larger basis and seed + a (a = 1..3), keeps the nWant closest to sigma and checks again; still missing -> status 'missed' and a solution note (elastic modal, piezo, em3d). 'auto' checks when the stored L of K - sigma M has <= 8e6 entries (extra cost one LDL^T of that size; measured 2-9 ms on the 0.7k-1k DOF sims); larger factors are skipped and reported in stats.check (3D sims at default levels: the check costs 19-31 % of the run there).
- Test: a projector that hides one eigenvector inside the wanted range (claimed null space 0) is detected ('missed' after 4 searches) at a lowest and an interior shift; pass results are bitwise equal to 'off'.
- Class-a eigen cases: s.3.5 (CLI identity).

### 3.3 AMS speed (task 4)

Change: scalar WebAssembly kernels for CSR products and Gauss-Seidel sweeps (`la/wasm/csr.mjs`), per row the same operations in the same order as the JS loops (no SIMD reordering, no fused multiply-add), so bitwise identical; used for the fine-level residuals, Gauss-Seidel and PCG products of `ams-real.mjs` (AMS and the ND2 -> ND1 p-multigrid), and the V-cycles of `amg.mjs` (also the scalar AMG-PCG of heat / electrostatics / currents) and `amg-sa.mjs`. Not done: Chebyshev smoothing (changes iterates; not needed for the 2x) and SIMD (changes the summation order).

cylinder-cavity (ND2, 16 modes, AMS-PCG rtol 1e-10), `packages/core/bench/perf-core-2-em3d.mjs --solver ams --csr js|wasm` (`logs/solver-3-ams-20261118T183605.jsonl`, `logs/solver-3-ams-20261118T183824.jsonl`):

| h | DOF | kernels | wall s | solve stage s | PCG iterations / solve (solves) | peak RSS MB | 16 eigenfrequencies vs js | load (1 min) |
|---|---|---|---|---|---|---|---|---|
| 1 | 36,832 | js | 64.9 | 63.1 | 30-32 (168) | 436 | - | 23.0 |
| 1 | 36,832 | wasm (AMS only) | 36.5 | 35.2 | 30-32 (168) | 451 | bitwise | 22.6 |
| 1 | 36,832 | js | 58.6 | 57.3 | 30-32 (168) | 442 | - | 9.9 |
| 1 | 36,832 | wasm (AMS + AMG) | 37.6 | 36.3 | 30-32 (168) | 427 | bitwise | 16.3 |
| 0.75 | 85,108 | js | 262.6 | 259.0 | 30-32 (228) | 708 | - | 23.3 |
| 0.75 | 85,108 | wasm (AMS + AMG) | 130.4 | 127.1 | 30-32 (228) | 820 | bitwise | 62.3 |

- 1.6-2.0x on the solve stage under the concurrent load (the wasm h 0.75 row ran at load 62); DevLog-054 reported 60.3 s / 212.5 s for the JS path at load 6.9 / 9.0. Extra memory: one copy of each matrix in WebAssembly memory (+0.1 GB at 85k DOF). Kernel bench (`packages/core/bench/csr-bench.mjs --N 26`, 35,152 rows, 1.76M entries): spmv 1.13 -> 0.67 ms, Gauss-Seidel 2.81 -> 0.86 ms, bitwise.

### 3.4 Degree-matched tet quadrature option (task 5; default unchanged)

Option `AMP_TET_QUADRATURE=matched` (or `setTetQuadrature('matched')`): tets use symmetric positive-weight rules of the requested degree (1 / 4 / 14 points for degree 1 / 2 / 3-5 instead of the collapsed 1 / 27 / 64), and elastic on affine tets uses per-term degrees (tet10 stiffness degree 2: 4 points; thermal / body load degree 3: 14 points). Curved tet10 cells keep the requested-degree rule.

Full eval, defaults vs matched (`logs/solver-3-eval-default/eval-20261118T185{302,354,408}.jsonl` vs `logs/solver-3-eval-matched/eval-20261118T191{614,710,722}.jsonl`; class c without WO-65, the matched class c also without PK-05 (direct factor above 5 GB, s.3.6)): class a 10 / 136 targets differ, class b 0 / 97, class c 25 differ of the common targets (7 of them PK-05, not run). No status changes from the option (PK-02 `cu_sxx_mean` / `si_szz_mean` info -> pass and WO-74 / WO-88 / WO-89 come from case files changed by other lanes between the two runs).

| Case / target | gated | default value | matched value | rel. change (finest; max over levels) | ref | tol | cold time ms default -> matched |
|---|---|---|---|---|---|---|---|
| AC-02 f_mode1 .. f_mode10 (10 targets) | yes | e.g. f_mode1 171.49999607946836 Hz | 171.49999607949005 Hz | <= 1.3e-13; <= 1.1e-13 | 171.5 Hz (f_mode1) | 1e-4 after Richardson | 3,261 -> 2,879 |
| CP-06 f1_open / f2_open | yes | 79,810.04134418187 / 93,584.27155768496 Hz | 79,810.04134417075 / 93,584.27155767096 | 1.4e-13 / 1.5e-13 | 81,590 / 93,410 Hz | 3 % | 8,318 -> 6,029 |
| CP-06 f1_short / f2_short | yes | 65,101.46472240769 / 88,146.25503628084 Hz | 65,101.4647224059 / 88,146.25503627997 | 2.8e-14 / 9.9e-15 | 66,560 / 88,010 Hz | 3 % | 8,156 -> 5,644 |
| PK-02 cu_srr, cu_szz, si_szz, rim_ur | yes | 170.1009383601569 MPa, 323.84894986614287 MPa, 39.12829043003662 MPa, -10.024369090459 nm | ... | <= 7.0e-13; <= 2.2e-11 | Lame closed form | 1e-3 | 13,561 -> 10,527 |
| PK-02 cu_sxx_mean, si_szz_mean, si_srr_2a, si_sphi_2a | no | | | <= 4.0e-13; <= 4.1e-11 | | | (same run) |
| PK-06 w_curv | yes | -2.0604847482507234 1/m | -2.06048474808348 1/m | 8.1e-11; 8.1e-11 | -2.06027 1/m | 2e-3 | 11,504 -> 9,945 |
| PK-06 uz_p1, uz_p2 | no (sign) | -1.0302445370882 / -4.1209716594643 um | -1.0302445363039 / -4.1209716584292 um | 7.6e-10 / 2.5e-10 | - | sign | 5,752 -> 4,972 |
| PK-10 dT_heater | yes | 23.501381070022205 K | 23.50138107004915 K | 1.2e-12 | bound [18.04, 24.18] K | range | 25,577 -> 19,805 |
| PK-10 T_core, T_heater, core_rise_integral, dT_heater_vs_layered, dphi_3d | no | | | <= 4.3e-12 | | | 25,577 -> 19,805; 41,502 -> 34,504 |

- Every change is round-off amplified by conditioning (largest 7.6e-10 on the bending-dominated plate, the solve's conditioning); no discretisation-level change appeared on the eval set (E: the meshes of these cases have straight-edged tet10 cells; not checked per mesh).
- Assembly time, plate mesh hmax L/20, layer cells 4 + 3, hF 1 (45,269 elastic DOF, AMG-PCG, load 5.5): elastic assembly 1,989 -> 445 ms (4.5x), wall 3.6 -> 2.0 s, u_z items within 2.8e-10.
- D: option only; the default stays 'collapsed' (coordinator decides).

### 3.5 Identity with defaults
- Class a (`logs/solver-3-eval-default/eval-20261118T185302.jsonl` vs `logs/eval-20261118T150402.jsonl`): 16 pass / 0 fail / 13 pending; 134 / 136 targets bitwise (value and every level). The two others, CP-21 sigma_yy_D (50.4457 MPa, pass) and sigma_yy_D_infinite (info), are lane G2's per-domain recovery (relayed producer patch + G2's post change): per-level values 50.440337 / 50.444691 / 50.445489 MPa equal G2's after-values (DevLog-059 s.5.1).
- Class b (`...T185354` vs `logs/eval-20261118T150452.jsonl`): 97 / 97 bitwise; 2 / 1 / 17 as before.
- Class c (`...T185408` vs `logs/eval-20261118T150503.jsonl`): 281 common targets bitwise; 21 differ, all on paths of other lanes: PK-02 means (G2), PK-06 (material block changes in `sims/die-warpage-3d.yaml`, G1; this lane's direct elastic path gives the 18:19 baseline value bitwise at 18:27), WO-04 / WO-61 (case pointers to the emw-2d band sims). Counts 35 / 1 / 27 (new cases from other lanes).
- Class-a eigen cases (AC-02, AC-03, RF-02, RF-21, SM-05, SM-06, SM-03, HT-02, WO-01, WO-03, WO-21) are within the 134 bitwise targets.

### 3.6 PK-05 memory (coordinator relay, 2026-11-18 19:05)

`<scratch>/g3/pk05.ts` (prepareRun + runStudy of `sims/interposer-thermal-3d.yaml` at hF 0.5, RSS at each stage; SpdSolver / SparseCholesky factor wrapped for logging only), `/usr/bin/time -l` plus the RSS guard:

| Code | Solver | DOF | nnzL | RSS after prepare / before factor / after factor MB | peak (max resident set) | wall s | Tj_logic K |
|---|---|---|---|---|---|---|---|
| committed HEAD 932a818 (scratch copy) | direct (default) | 333,186 | 333,959,915 | 285 / 878 / 3,057 | killed by the guard at 5,374 MB (max RSS 5.64 GB) during the triangular solve setup | 66.6 | - |
| working tree | direct (default) | 333,186 | same | 286 / 894 / - | killed by the guard at 1,985 MB in the factor (same point as HEAD under the 1.95 GB guard: 1,984 MB) | - | 299.7807058347927 (eval run, unguarded) |
| working tree | `settings.solver: amg-pcg` | 333,186 | - | -; run end 1,194 | 1.44 GB | 19.9 | 299.78070583479337 |
| working tree | `settings.solver: auto` (picks AMG-PCG: direct factor 2,548 MiB > 1,024 MiB) | 333,186 | - | -; run end 1,254 | 1.54 GB | 19.8 | 299.78070583479337 |

- F: the memory is the direct factor of level 2 (L alone 2.5 GiB of values); HEAD and the working tree behave the same up to the guard, and the class c log of the commit (`logs/eval-20261118T150503.jsonl`, 333,186 DOF, 63.5 s) ran the same factor. DevLog-049's "0.7 GB" for PK-05 does not match the committed code (E: probably taken at level 1 or as heap rather than RSS). No change of this lane is on the direct path (SpdSolver records only; the default rule is unchanged).
- AMG-PCG vs direct: Tj_logic 2.1e-15, Tj_mem_l 1.7e-15, Tj_mem_r 4e-16 relative (127 PCG iterations, relative residual 8.6e-11); not bitwise. Identical results under 2 GB are not possible with this direct factor and ordering (AMD; a nested-dissection ordering would cut the fill of this thin layered mesh but changes round-off too).

## 4. Requests (R)
- R1 (coordinator, `packages/spec/src/provisional/wave1.ts:81`, stationary study description; settings unchanged): replace the description string with
  ```ts
  description: 'Stationary solve; solver: linear solver of heat / electrostatics / currents / elastic (direct = Cholesky, default; amg-pcg = AMG-preconditioned CG, elasticity with the rigid-body modes; auto = AMG-PCG on large problems), rtol: AMG-PCG relative residual',
  ```
- R2 (coordinator as wave2d owner, `packages/physics/src/wave2d/bands.ts:133`): bands runs its own inertia check (`checkedEigen`); avoid a second one from the driver's 'auto' default by adding `check: 'off', ` after `seed: 20261118 + attempt, ` in the `shiftInvertEigen({...})` call. Results are bitwise the same either way; the saving is one LDL^T of the k-point pencil per solve on small cells.
- R3 (owners of acoustics, em-axisym, optomech; coordinator routes): surface a repeated or failed completeness check as a solution note, as elastic modal / piezo / em3d now do: after the `shiftInvertEigen` call (`acoustics/index.ts:65`, `em-axisym/index.ts:232`, `optomech/axisym.ts:286`) push `eigenCheckNote(eig.stats.check)` (from `../common/eigen.ts`) to the solution notes when it is not null. em-axisym passes a projector without a null-space dimension, so its check is skipped; to enable it pass `nullDim: <dimension of the projected gradient space>` (I did not derive that number for the axisymmetric formulation).
- R5 (coordinator, `sims/interposer-thermal-3d.yaml:62`, PK-05): `  - {id: std1, type: stationary, physics: [ht], settings: {solver: auto}}` (level 1 stays direct by the 'auto' rule if below the thresholds; level 2 AMG-PCG, 1.54 GB, 19.8 s; values change at 1e-15 relative: s.3.6). Alternative without a spec change: none that keeps results bitwise.
- R4 (coordinator, `DevLog/contracts/CONTRACTS-v0.md` changelog): "C5 RunRecord.solver is filled by withStudySolver (heat, electrostatics, currents, elastic outside eigen studies; every run, with or without a study setting) and em3d; merged studies carry byPhysics keyed like stats.byPhysics (DevLog-060)."; the G2 producer field `FieldData.elementNodal` changelog line is the coordinator's (relay).

## 5. Open items (O)
- O1: elastic AMG-PCG on thin plates takes 90-110 iterations (PK-06) against 33-40 on the TSV cell; block (3 x 3 node) Gauss-Seidel or Chebyshev smoothing on the P2 level, or a second SA sweep, are the next candidates. 'auto' uses the scalar break-even (3e5 flop per DOF); it picked the faster solver on all four gate rows, no elastic-specific threshold measured beyond them.
- O2: at 352,760 elastic DOF the elastic assembly (18.8 s) outweighs the AMG-PCG solve (17.2 s); the degree-matched quadrature option (s.3.4) addresses it; the elastic path also keeps the full-pattern K, its restricted copy and the element slot map (about 0.3 GB of slots at that size) alive during the solve.
- O3: eigen completeness: 'auto' skips factors above 8e6 stored entries (3D sims at their default levels); em-axisym has no null-space dimension for its projector (R3); bands has its own check (R2).
- O4: AMS: Chebyshev smoothing and SIMD kernels not done (both change the iterates or summation order); the WASM kernels hold a second copy of each matrix.
- O5: DevLog-049 R3's "47k DOF did not finish in 180 s" did not reproduce at hF 1 (7.0 s direct); the failing run was most likely its hF 0.5 level (E, from the eval's level factors).

## 6. Hand-off
- Done: elastic in the study solver setting (`STUDY_SOLVER_TYPES` + SA AMG with rigid-body modes, P2 -> P1 p-multigrid for tri6 / tet10); `run.solver` producers (withStudySolver, em3d) and the driver merge; eigen completeness check (default 'auto'); WASM CSR kernels for AMS / AMG (bitwise); degree-matched tet quadrature as an option (default 'collapsed'); G2's producer patch applied (relay); PK-05 memory investigated (s.3.6).
- API: core `la/amg-sa` (`buildAMGSA`, `buildTwoLevel`, `rigidBodyModes`, `csrMatMatTyped`, `csrTransposeTyped`), `la/wasm/csr` (`makeCsrKernels`, `setDefaultCsrKernel`, `wasmCsrSupported`, `CSR_MIN_NNZ`); physics `common/scalar.ts` (`SpdSolver(pat, kind, rtol, {amg})`, `Preconditioner`, `solverRecordOf`, `mergeSolverRecords`), `common/eigen.ts` (`EigenInput.check`, `nullDim`, `EigenCheck`, `EIGEN_CHECK_MAX_NNZL`, `EIGEN_CHECK_RETRIES`, `setEigenCheckDefault`, `setEigenCheckListener`, `eigenCheckNote`), `common/quad.ts symTetRule`, `common/lagrange.ts` (`setTetQuadrature`, `tetQuadrature`, `isAffineTet10`, env `AMP_TET_QUADRATURE`), `elastic/index.ts elasticPreconditioner`. Existing signatures unchanged (new optional parameters only).
- Files: new `packages/core/src/la/amg-sa.{mjs,d.mts}`, `packages/core/src/la/wasm/csr.{mjs,d.mts}`, `packages/core/bench/csr-bench.mjs`, `packages/core/test/la-csr-kernels.test.mjs`, `packages/physics/test/g3-solver-3.test.ts`; edited `packages/core/src/la/{amg,ams-real}.mjs`, `packages/core/bench/{perf-core-1,perf-core-2-em3d}.mjs`, `packages/physics/src/common/{scalar,eigen,lagrange,quad}.ts`, `packages/physics/src/elastic/{index,modal,axisym}.ts` (axisym: G2 patch only), `packages/physics/src/coupled/piezo.ts`, `packages/physics/src/em3d/index.ts`, `packages/physics/src/driver.ts` (import + 2 merge lines), `packages/physics/test/perf-core-1.test.ts` (STUDY_SOLVER_TYPES assertion), `packages/spec/src/types/solution.ts` (G2's elementNodal, by relay).
- Rerun: gate `node <scratch>/g3/run-sim.ts --sim sims/<x>.yaml --h 1|0.5 --solver none|amg-pcg|auto [--hmax L/20 --nz 4,3]` (scratch tool; the same through the CLI by setting the study's `settings.solver`); AMS `nice -n 10 node --max-old-space-size=1536 packages/core/bench/perf-core-2-em3d.mjs --h 1 --solver ams --csr js|wasm`; kernels `node packages/core/bench/csr-bench.mjs --N 26`; eigen identity `perf-core-1.mjs --eigen-check off|auto|inertia --dump DIR` then `--compare`; quadrature `AMP_TET_QUADRATURE=matched node packages/eval/src/cli.ts --class <a|b|c>`.
