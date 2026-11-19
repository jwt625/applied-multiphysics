# DevLog-054: core performance, part 2 (lane E8, chunk 2, roadmap B6)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | E8 (DevLog-037 s.4.1) |
| Owns | `packages/core/**`; `packages/physics/src/common/**` except `lagrange.ts`; `packages/physics/src/{elastic,coupled,heat,em3d}/**`; `apps/web/src/lib/engine/client.ts`; new `apps/web/src/lib/engine/pool.ts`; new tests and bench files under those packages; this file |
| Not owned | wave2d (E4), modes and prepare.ts (E2), mesh (E4), geom / post / eval (E9), `engine/protocol.ts` and `runner.worker.ts` (E6), registrations / driver / spec / CONTRACTS (coordinator) |
| Read | CLAUDE.md; DevLog-037 s.1, s.4.1; DevLog-045 (all); DevLog-016; `core/src/la/{ams,pmg,amg,ldlt,ldlt-blocked,ldlt-wasm,ldlt-select}.mjs`, `la/wasm/solve-real.mjs`; `physics/src/{elastic,coupled,heat,em3d}/**`, `common/{scalar,eigen}.ts`; `apps/web/src/lib/engine/**`, `workbench/session.svelte.ts` (sweep loop, read only) |

Conventions: F = fact read from code or a run; D = decision of this lane; E = estimate; O = open item; R = request to the coordinator or another lane.

## 1. Plan (2026-11-18 13:28 PST, before coding)

### 1.1 Facts
- F: `elastic/index.ts` scatters every element entry by binary search in `pat = blockPatternCached(node, dim)` (its own `blockPattern`, same layout as core `blockPattern`, DevLog-045 R1). `elastic/modal.ts assembleSolid` and `coupled/piezo.ts` call `coupled/assemble.ts scatter` twice per element (K, then M), each a binary search per entry with skips for DOF -1 and value 0 (DevLog-045 R2). `heat/index.ts radiation` searches `entry(S.pat, ...)` per Jacobian entry on every Newton iteration (R3).
- F: piezo element kernel (`coupled/piezo.ts:116-120`): K_uu entry (a, b) = sum_I sum_J B[I,a] C[I,J] B[J,b] with the J loop inside the (a, b) loop (36 x 465 multiply-adds per quadrature point for tet10); pzt4 assembly 5.9-7.2 s of a 12 s run (DevLog-045 s.5).
- F: the complex LDL^T solve (`ldlt.mjs ComplexSupernodalLDLT.solve`, inherited by `BlockedComplexLDLT` and `WasmComplexLDLT`) is JS; users: wave2d driven (`makeFactor` + `solveRefined`, a few solves per factor) and lossy em-modes (`vector-mode.mjs` complex Arnoldi, many solves per factor).
- F: em3d (`emw`) is eigen-only: shift-invert block Arnoldi on a direct factor of K - sigma M (Cholesky for the default negative shift, LDL^T with a shift). `la/ams.mjs` (complex, order-1 Nedelec) and `la/pmg.mjs` (complex, order 2 -> 1 with a direct coarse factor) were ported for a driven solver and are not imported anywhere.
- F: the eigen study registration (`wave1.ts:83`) is a strict object `{nModes, shift?}`: a `solver` setting needs a coordinator edit.
- F: web sweeps run serially in `workbench/session.svelte.ts computeSweep` (lane E5's file) through one `EngineClient` (one run in flight; a new run cancels the previous).

### 1.2 Design
Task 1, scatter and element kernels (bitwise where only the slot lookup changes):
- elastic: `cellBlockSlots(m, pat, dim)` (core `blockElementSlots`, cached per mesh) replaces the binary search; same element and entry order.
- coupled: `scatterPair(p, K, M | null, dofs, Ke, Me, nd)` in `coupled/assemble.ts`: one slot lookup per (a, b) used for both K and M, keeping each matrix's skip rules (DOF -1, value 0) and addition order; `piezo.ts`, `elastic/modal.ts` switch to it.
- heat radiation: `facetSlots(m, S.pat, r.facets)` (cached per facets array) instead of `entry` per entry.
- piezo kernel: C B per quadrature point (nv x ndU, using the B column sparsity), then Ke(a, b) = sum_I B[I, a] (C B)[I, b]; round-off-level change (different summation grouping). Gate: max relative deviation of eigenfrequencies / fields on pzt4 (and the MT piezo tests); accept if <= 1e-12 relative on frequencies, else keep the old kernel and record why.
- elastic per-element allocation: profile hotarm (`--cpu-prof`) first; change only what the profile shows.
Task 2, complex triangular solve in WASM (`la/wasm/solve-complex.mjs`):
- L (Lr, Li) of `ComplexSupernodalLDLT` (and subclasses) allocated in a per-factor WebAssembly.Memory (as the real solve), interleaved complex work vector y; forward column kernel and backward column kernel per supernode over Si, f64x2 lanes (re, im): forward y[t] -= lr (a, b) + li (-b, a) equals the JS `yr -= lr a - li b; yi -= lr b + li a` bit for bit (x - y = x + (-y); li (-b) = -(li b)); backward same with a lane swap. Diagonal step in JS on the same view. Same skips (a = b = 0 column). Fallback: plain arrays and the JS solve when SIMD / compile is blocked or below a size threshold; `DEFAULT_COMPLEX_SOLVE` setter. Gate: bitwise equality test incl. zeros, -0, NaN, Inf; timing on a wave2d-sized and a lossy-modes-sized factor.
Task 3, AMS-preconditioned iterative em3d eigen path:
- Real (SPD) versions in core: `la/ams-real.mjs` (Hiptmair-Xu AMS: G, Pi_x,y,z, AMG per auxiliary space, cycle 01210 with symmetric Gauss-Seidel) and a real two-level p-MG (order 2 -> Whitney block, Hiptmair smoothing on the H1-P2 gradient space, coarse = one AMS cycle) as a symmetric preconditioner for PCG.
- em3d: operator application (K - sigma M)^-1 M x by PCG on the SPD K - sigma M (sigma < 0, the default shift) to an inner relative tolerance, inside the existing shift-invert block Arnoldi; gradient projection unchanged. `CavityProblem.solver: 'direct' | 'ams' | 'auto'` (auto: AMS when the symbolic direct factor would exceed a byte budget), `solverRtol`. With a positive shift (indefinite), the iterative path is refused with a message (direct only).
- Gate: cylinder cavity (RF-21 / `sims/cylinder-cavity.yaml`) eigenfrequencies of the AMS path vs the direct path at the same mesh (relative difference, inner rtol stated), and a level above the direct path's 2 GB limit run under the RSS guard.
- Spec route: request (R) a `solver` / `rtol` setting on the eigen study registration; em3d reads it when present.
Task 4, multi-worker sweeps: `engine/pool.ts` (WorkerPool: N = min(hardwareConcurrency - 1, cap, points), runs merged in sweep order, cancel of all in-flight runs, per-point progress and mesh callbacks); `EngineClient.runSweep(texts, options, handlers)`; worker factory injectable for unit tests (mock workers: order, cancel, error, identical outcomes to the serial loop). The sweep loop in `session.svelte.ts` is E5's: request the exact call change.
Task 5: R4 proposal `run.solver: {kind, rtol, iterations, residual}` as an exact request.

### 1.3 Measurement protocol
- Bench: `packages/core/bench/perf-core-1.mjs` (DevLog-045; dumps + `--compare`), new workloads where needed (radiation: `nafems-t2` or hot-arm; coupled modal: `membrane-air` / `ln-fbar-2d`); new `packages/core/bench/perf-core-2.mjs` for complex solve and the em3d AMS path.
- Baseline dumps before any change (scratchpad), after each change `--compare` (bitwise / 1e-12).
- Timings: `nice -n 10 node --max-old-space-size=1536`, one heavy process at a time, RSS guard on 3D runs, warm median of >= 3-5 runs, load average per row; other lanes run concurrently, so A/B rows are interleaved in the same load window.
- Eval: class-a CLI before / after; per-target values compared.

### 1.4 TODO
- [x] Baseline: bench dumps + timings (pzt4, hotarm, kirsch, nafems-t2, membrane-air, ln-fbar-2d), class-a eval
- [x] Task 1: elastic slots, coupled scatterPair, radiation facetSlots (bitwise); piezo kernel (gate); elastic profile + change
- [x] Task 2: complex WASM solve + tests + timing
- [x] Task 3: real AMS / p-MG, em3d iterative eigen path, gates vs direct, memory run
- [x] Task 4: pool.ts, client.ts runSweep, tests
- [x] Task 5: R4 request
- [x] After: pnpm test, pnpm check, class-a eval compare, timing tables, hand-off

## 2. Progress log

- 2026-11-18 13:28 PST: read the brief, DevLog-037 s.1 / s.4.1, DevLog-045, code; plan above.
- 2026-11-18 13:29 PST: bench workloads fbar (ln-fbar-2d, piezo 2D eigen), membrane (membrane-air, acoustic-structure eigen), t2 (nafems-t2, radiation) added to `packages/core/bench/perf-core-1.mjs`; baseline dumps (`logs/perf-core-2-base-20261118T132949.jsonl`, `.log`); fbar h 0.5 killed by the 1.95 GB RSS guard (2.13 GB), dropped. RSS guard wrapper and sequential runner in the scratchpad.
- 2026-11-18 13:31-13:35 PST: R1 (elastic `cellBlockSlots`), R2 (`coupled/assemble.ts scatterPair`, used by `coupled/piezo.ts` and `elastic/modal.ts`), R3 (heat radiation `facetSlots`), piezo C B kernel. After-run `logs/perf-core-2-a1-20261118T133426.jsonl`: t2, membrane h 1 / 0.5, kirsch h 0.25, hotarm bitwise identical to the baseline; pzt4 / fbar differ at round-off level (s.3.2).
- 2026-11-18 13:36-13:39 PST: pzt4 CPU profile: assembly lines 125 / 148 / 120 (zero-skip branches of the new sums) 66 % of solvePiezo; compact nonzero lists of the B columns (same terms, same order: bitwise identical to the 13:33 kernel, checked on the pzt4 and fbar dumps); `logs/perf-core-2-a2-20261118T133859.jsonl`.
- 2026-11-18 13:39-13:43 PST: hotarm CPU profile: 94 % of the elastic assembly closure is the dense D B and B^T D B products (lines 148-149); per-element `dMatrix` allocation 89 ms of 6.6 s (not a hot spot). `coupled/assemble.ts solidKernel` (nonzero entries of B only; skipped terms are +-0 and leave the partial sums unchanged, so bitwise identical) used by `elastic/index.ts` and `elastic/modal.ts assembleSolid`. hotarm / kirsch / membrane bitwise identical to the baseline (`logs/perf-core-2-a3-20261118T134134.jsonl`). Second finding: 3D tet10 assembly integrates with `tetRule(4)` = 64-point collapsed Gauss (degree 2 cellOrder); see O-list.
- 2026-11-18 13:44 PST: `la/wasm/solve-complex.mjs` (cfwd / cbwd, 569-byte module) wired into `ComplexSupernodalLDLT` (constructor storage + solve); test `packages/core/test/la-complex-solve.test.mjs` 6/6 (bitwise for base / blocked / wasm-front factors, zeros, -0, NaN, Inf, perturbed pivots, refinement, fallbacks).
- 2026-11-18 13:44-13:47 PST: `packages/core/src/la/ams-real.mjs` (`buildAMSReal`, `buildPMGReal`, `leadingBlock`, `pcgCsr`, real SPD counterparts of `ams.mjs` / `pmg.mjs`); `common/eigen.ts` `linearSolver` and `sym` options; em3d `CavityProblem.solver` ('direct' default | 'ams' | 'auto'), `solverRtol`, Whitney nodal interpolation Pi, notes and detail stats; `emwModule.run` reads `settings.solver` / `settings.rtol` of the eigen study when present. Bench `packages/core/bench/perf-core-2-em3d.mjs`. h 2 (5,572 DOF): AMS frequencies equal to the direct ones to 2e-15 relative, PCG 38-40 iterations.
- 2026-11-18 13:47-13:50 PST: cylinder-cavity h 1 (36,832 DOF), AMS vs direct (`logs/perf-core-2-em3d-20261118T134745.jsonl`): 16 / 16 eigenfrequencies within 1.2e-14 relative; PCG 30-32 iterations per solve, 168 solves; wall 60.3 s vs 5.2 s; RSS 333 vs 751 MiB. CPU profile: p-MG apply (fine Gauss-Seidel, 3 residuals) 49 %, CSR products 22 %, PCG vector ops 11 %.
- 2026-11-18 13:36-13:50 PST: `apps/web/src/lib/engine/pool.ts` (WorkerPool, poolSize), `client.ts runSweep`; test `apps/web/test/e8-pool.test.ts` 4/4 (mock workers). Bench `packages/core/bench/sweep-parallel.mjs` (worker_threads, serial vs parallel bitwise check).
- 2026-11-18 13:53 PST: cylinder-cavity h 0.75 (85,108 DOF; the direct path passed 1.9 GB RSS at this level in DevLog-045) with AMS: 212 s, RSS peak 675 MiB (guard), PCG 30-32 iterations per solve (same as h 1 and h 2: mesh-independent), 228 solves; frequencies in s.3.4.
- 2026-11-18 13:56 PST: 'auto' factor sizes: h 1 119 MiB (run RSS 0.74-0.82 GB), h 0.85 237 MiB (1.18-1.44 GB); `EM3D_DIRECT_MAX_BYTES` set to 300 MiB (`logs/perf-core-2-em3d-auto-20261118T135617.jsonl`). Test `packages/physics/test/e8-em3d-ams.test.ts` 3/3. Pool: cancel inside an onPoint callback can no longer finish a newer batch (finish checks the batch identity).
- 2026-11-18 13:57 PST: complex solve bench (`logs/perf-core-2-csolve-20261118T135659.jsonl`, s.3.3); parallel sweep check (`logs/perf-core-2-sweep-20261118T135739.jsonl`): si-rib-waveguide 7 points, 4 worker threads vs serial, 161 / 161 items bitwise identical, 7.46 s -> 4.69 s (load 11).
- 2026-11-18 13:58 PST: class-a eval (`logs/perf-core-2-eval-a-20261118T135758.log`, records `logs/eval-20261118T135758.jsonl`): 16 pass, 0 fail, 13 pending. Against the DevLog-045 09:30 records: 54 target values bitwise identical; CP-21 sigma_yy_D changed with a changed mesh hash (74,273 -> 72,439 DOF; another lane's geometry / mesh work, now pass), CP-21 sigma_yy_D_infinite and EM-04 uniformity_sphere_0.1R are new info targets. No change from this lane.
- 2026-11-18 13:59 PST: `pnpm test` (all packages) and `pnpm -r check` started.
- 2026-11-18 13:59-14:01 PST: `pnpm test` (`logs/perf-core-2-test-20261118T135913.log`): rt 16, core 101, spec 65, geom 51 pass; materials 33 pass / 1 fail (`tfln-rib-air.yaml` validation against the materials registry: a sim added by another lane, not this lane's paths), which stopped the recursive run. `pnpm -r check` exit 0 (`logs/perf-core-2-check-20261118T135913.log`; apps/web svelte-check 0 errors).
- 2026-11-18 14:01-14:05 PST: the remaining packages without bail (`logs/perf-core-2-test2-20261118T140102.log`): eval 91, mesh 24, physics 190, post 16, agent 75, apps/web 118; 0 fail. Results, requests, open items and hand-off written (s.3-6).

## 3. Results (Node v23.7.0, Apple M4 Pro 12 cores; `nice -n 10`, heap 1536 MB; eight other lanes running, load average per row)

Command per bench row: `nice -n 10 node --max-old-space-size=1536 packages/core/bench/perf-core-1.mjs --only <w> [--levels h] --runs 3 --dump DIR` (one process per workload, RSS guard 1.95 GB). Warm = median of 3 runs after one cold run. "Before" = baseline run of the unchanged code at 13:29 (`logs/perf-core-2-base-20261118T132949.jsonl`); "after" = 13:34-13:42 runs (a1 / a2 / a3 logs). The old code is not kept beside the new one (no git in this lane), so rows are sequential, not interleaved: load differs per row and the noise is large (pzt4 warm runs of the unchanged code: 10.5, 16.4, 16.3 s at load 4.4-7.6).

### 3.1 Assembly (task 1)

| Workload | DOF | Change | Assemble stage ms before -> after (load) | Warm wall ms before -> after | Outputs vs baseline |
|---|---|---|---|---|---|
| pzt4-cube h 1 (3D tet10 piezo, eigen) | 36,448 | scatterPair, C B kernel, compact B nonzeros | 11,670 (7.6) -> 2,522 (4.7); DevLog-045: 5,925-7,241 (5.3-6.3) | run 1 10,484 (4.4), median 16,260 (7.6) -> 7,223 (4.7) | round-off (s.3.2) |
| ln-fbar-2d h 1 (2D piezo, eigen) | 230,570 | same | 737 (3.0) -> 678 (4.3) | 5,382 -> 5,347 | round-off (s.3.2) |
| hot-arm h 1 (3D tet10 currents -> heat (radiation) -> elastic) | 126,125 | element slots, solidKernel, radiation facetSlots | solid 3,450 (3.9) -> 2,654 (6.1); total 4,225 -> 3,491 | 6,377 -> 5,898 | bitwise |
| kirsch-plate h 0.25 (2D tri6 elastic) | 170,296 | element slots, solidKernel | 271 (4.1) -> 233 (6.2) | 1,447 -> 1,423 | bitwise |
| membrane-air h 1 / 0.5 (acoustic-structure eigen) | 111,671 / 429,757 | scatterPair, solidKernel (fsi.ts coupling scatter unchanged) | 334 -> 344 / 1,152 -> 1,261 (3.1-3.7 -> 5.9-6.4) | 977 -> 1,099 / 3,831 -> 4,160 | bitwise |
| nafems-t2 h 1 (2D radiation, Newton) | 124 | radiation facetSlots | 0.14 -> 0.15 | 6.1 -> 6.6 | bitwise |

- F (profiles, `--cpu-prof`): pzt4 before the compact-nonzero step, 66 % of solvePiezo self time in the zero-skip branches of the new sums; hotarm, 94 % of the elastic assembly closure in the dense D B / B^T D B products, per-element `dMatrix` allocation 89 ms of 6.6 s (the brief's "allocation hot spot" is not one). membrane's assembly is dominated by `coupled/fsi.ts` (interface scatter with `slotOf`) and the acoustic part; this lane's changes there are bitwise and below the load noise.
- F: the 3D tet10 assembly integrates with `defaultRule(tet10, 4)` = `tetRule(4)`, a 64-point collapsed Gauss rule; the stiffness of an affine tet10 needs degree 2 (thermal load 3). See O2.

### 3.2 Piezo kernel gate (round-off-level change)
- Change: K_uu(a, b) = sum_I B[I, a] (C B)[I, b] with C B per quadrature point instead of sum_I sum_J B[I, a] C[I, J] B[J, b] per entry; K_uV through (e^T grad N) per point. Different grouping of the same products.
- pzt4 h 1 (`--compare`-style, sign-free per eigenvector; `logs/perf-core-2-a1-20261118T133426.log`): 10 eigenfrequencies max relative difference 4.3e-15; u fields <= 1.0e-12, V fields <= 7.6e-12 relative to each field's max, except mode 0 (f = 0, rigid-body mode): its V is round-off noise of amplitude 7.5e-4 V against 4e9 V for the other modes, relative difference 0.97 of that noise.
- fbar h 1: 20 eigenfrequencies <= 1.6e-14; fields <= 1.4e-10; floating-electrode voltages V_term_i <= 2.7e-8 relative (closely spaced modes, relative spacing down to 3e-4; eigen residual 2.1e-12 before, 3.3e-12 after).
- D: accepted (frequencies, the only eval targets on these sims (CP-06, 3 % tolerance), change <= 1.6e-14; field differences are eigenvector conditioning of the round-off change). The compact-nonzero step after it is bitwise (checked on both dumps).

### 3.3 Complex triangular solve in WASM (task 2; `logs/perf-core-2-csolve-20261118T135659.jsonl`, median of 9 solves, BlockedComplexLDLT)

| Pattern | n | nnzL | JS solve ms | WASM solve ms | Speedup | Bitwise | Load |
|---|---|---|---|---|---|---|---|
| 3D 27-point grid 16^3 | 4,096 | 696,337 | 2.38 | 1.14 | 2.09 | yes | 6.6 |
| 3D 27-point grid 24^3 | 13,824 | 4,552,101 | 14.13 | 6.51 | 2.17 | yes | 6.8 |
| 2D 9-node quad grid 401^2 | 160,801 | 9,799,467 | 33.29 | 15.71 | 2.12 | yes | 7.2 |
| 2D 9-node quad grid 801^2 | 641,601 | 48,719,258 | 188.5 | 81.6 | 2.31 | yes | 9.8 |

- Module 569 bytes. Users: wave2d driven (`solveRefined`, a few solves per factor: the factor dominates, the gain is small there) and lossy / PML em-modes (`ComplexSupernodalLDLT` in vector-mode.mjs: one solve per Arnoldi operator application, where the 2.1-2.3x applies). The non-supernodal `ComplexLDLT` is unchanged.

### 3.4 em3d AMS path (task 3; `logs/perf-core-2-em3d-20261118T134745.jsonl`, sims/cylinder-cavity.yaml, ND2, 16 modes, study shift 2.5 GHz)

| h | DOF | Solver | Wall s | Solve stage s | PCG iterations / solve (solves) | RSS peak MiB | f_TM010 Hz | rel. to closed form 2,903,636,072.33 | Load |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 36,832 | direct (LDL^T, shift 2.5 GHz) | 5.2 | 2.9 | - (128 op. applications) | 759 | 2,903,628,765.752348 | -2.516e-6 | 5.9 |
| 1 | 36,832 | AMS, rtol 1e-10 | 60.3 | 58.4 | 30-32 (168) | 333 | 2,903,628,765.75237 | -2.516e-6 | 6.9 |
| 0.75 | 85,108 | direct | - | - | - | killed > 1.9 GB (DevLog-045) | - | - | - |
| 0.75 | 85,108 | AMS, rtol 1e-10 | 212.5 | 209.6 | 30-32 (228) | 675 | 2,903,637,655.975127 | +5.45e-7 | 9.0 |

- Gate: h 1, all 16 eigenfrequencies (incl. the degenerate pairs) AMS vs direct within 1.2e-14 relative; h 2: within 2e-15; box tests (ND1, ND2, partly filled) within 1e-8 (test bound). h 0.75 is beyond the direct path and converges towards the closed form (|error| 2.5e-6 -> 5.5e-7).
- Eigen strategy (D): shift-invert block Arnoldi as the direct path, each operator application (K - sigma M)^-1 M x solved by CG on the SPD K - sigma M with sigma below the spectrum (the module's negative default shift), preconditioner: two-level p-multigrid (ND2 -> Whitney block, forward / backward Gauss-Seidel plus Hiptmair correction on the H1-P2 gradient space) with one AMS cycle (G, Pi_x,y,z, smoothed-aggregation AMG V-cycles) as the coarse solve; ND1 uses AMS directly. Gradient projection unchanged (direct Cholesky of G^T M G, small). The AMS path therefore finds the lowest modes: a study shift above the lowest computed mode is refused with a message (the closest-to-shift set would differ), a shift at or below it gives the same set as the direct path; no inertia count (nBelowShift null).
- 'auto': AMS when the AMD symbolic factor exceeds `EM3D_DIRECT_MAX_BYTES` = 300 MiB (h 0.85: 237 MiB direct at 1.18-1.44 GB RSS; h 0.75 above it, E: about 400 MiB by n^(4/3) scaling).
- Cost: 10-12x the direct wall time at the same size (11 ms per PCG iteration at 36.8k DOF: about six fine-level CSR passes per iteration in JS). It is the memory path, not a speed path.

### 3.5 Parallel sweeps (task 4)
- `engine/pool.ts`: N = min(points, POOL_MAX 4, cores - 1, deviceMemory / 2 GB); outcomes and onPoint callbacks in sweep order; cancel (C6 cancel to in-flight runs, pending points never start, busy workers terminated after 500 ms, idle workers kept); a worker error fails only its point and a fresh worker takes the rest. `EngineClient.runSweep(jobs, onPoint?, workers?)`; `cancel()` and `dispose()` include the pool.
- Identity: Node worker_threads check of the same per-point path (prepareRun + runStudy): si-rib-waveguide 7 points, 161 / 161 scalars and fields bitwise identical between serial and 4 workers; 7.46 s -> 4.69 s at load 11 (the 329k-DOF first point bounds it). The browser path is not run in this lane (the session's sweep loop is lane E5's; R3).

### 3.6 Gates
- Tests (new): `packages/core/test/la-complex-solve.test.mjs` 6, `packages/physics/test/e8-em3d-ams.test.ts` 3, `apps/web/test/e8-pool.test.ts` 4: all pass.
- Class-a eval: 16 pass, 0 fail, 13 pending (the brief's 15 / 1 / 13 changed through another lane's CP-21 mesh); 54 / 54 comparable target values bitwise identical to DevLog-045's records.

## 4. Requests (R)
- R1 (coordinator, `packages/spec/src/provisional/wave1.ts:83-84`, eigen study registration): replace the two lines with
  ```ts
  { kind: 'study', type: 'eigen', ...phys, description: 'Eigenfrequencies: nModes closest to shift (lowest when no shift); solver: linear solver of the 3D electromagnetic eigen solve (direct, default; ams = AMS-preconditioned CG for meshes above the direct solver memory, lowest modes only; auto = AMS when the direct factor would exceed 300 MiB), rtol: AMS inner relative residual',
    settings: z.strictObject({ nModes: int(), shift: quantity('Hz').optional(), solver: z.enum(['direct', 'ams', 'auto']).optional(), rtol: z.number().gt(0).lt(1).optional() }) },
  ```
  `emwModule.run` already reads and checks both (other eigen modules ignore them). Until then the setting is reachable through `solveCavity({ solver, solverRtol })` and the bench (which sets it on the prepared context).
- R2 (coordinator, C5 run record; `packages/spec/src/types/solution.ts` `RunRecord`, after `oplogHead?`, and the matching C5 line in `DevLog/contracts/CONTRACTS-v0.md`), proposal DevLog-045 R4 made exact:
  ```ts
  /** Linear solver of the run, machine-readable (additive to C5; DevLog-054 R2). Merged multiphysics: byPhysics per physics id. */
  solver?: SolverRecord & { byPhysics?: Record<string, SolverRecord> };
  ```
  with, in the same file,
  ```ts
  /** kind: 'direct' (sparse Cholesky / LDL^T), 'amg-pcg', 'ams-pcg'; rtol, iterations (max over the run's linear solves), residual (max achieved relative residual) are null for direct solves. */
  export interface SolverRecord { kind: 'direct' | 'amg-pcg' | 'ams-pcg'; rtol: number | null; iterations: number | null; residual: number | null }
  ```
  Producers once the type exists (this lane's paths, next chunk): `common/scalar.ts withStudySolver` (heat / electrostatics / currents) and `em3d` fill it next to `stats.solver`; `driver.ts` copies per-physics records into `byPhysics` when it merges (coordinator line).
- R3 (lane E5, `apps/web/src/lib/workbench/session.svelte.ts computeSweep`): run the points on the worker pool. Replace the serial `for (const p of points) { ... }` loop by: build every point's text first (`runText`, as now; a failing point gets status 'error'), then
  ```ts
  const outs = await this.engine.runSweep(idx.map((i) => ({ specText: texts[i]!, options: { meshScale: 1, ...kase }, handlers: { mesh: (m, q, ms, src) => { lms[i] = { m, q, ms, src }; }, progress: (st, f, msg, ts) => { /* the current progress handler with p = points[i] */ } } })), (k, o) => { /* the current per-point block (status, mesh, params, scalars, appLog, showPoint, solvedSeq) with p = points[idx[k]!]!, L = lms[p.index] */ });
  ```
  `runSweep` delivers outcomes in sweep order (same sequence as the serial loop) and `engine.cancel()` (already called by the session's cancel) stops it. Optional third argument `workers` (1 = the serial behaviour) for a settings toggle.

## 5. Open items (O)
- O1: em3d AMS path speed: 10-12x the direct wall time at equal size (JS CSR Gauss-Seidel and residual passes, about six fine-level passes per PCG iteration). Options: WASM SIMD CSR kernels (spmv, Gauss-Seidel), fewer residual passes per p-MG cycle, Chebyshev smoothing (Palace), a direct coarse factor when the Whitney block fits the budget (fewer iterations), a block solver for the Arnoldi block. Interior shifts (indefinite K - sigma M) are not covered (MINRES / GMRES with a shifted preconditioner, or LOBPCG on the projected pencil).
- O2: 3D tet10 assembly uses `tetRule(4)` (64-point collapsed Gauss) for every 3D module through `defaultRule(type, 2 cellOrder)`; a degree-matched symmetric rule (stiffness of affine tet10: degree 2; with thermal load: 3) would cut the hot-arm / pzt4 element loops by about 2.4-5x (E, from the point counts 64 -> 27 / 11-14). It changes K at round-off level on affine cells and at discretisation level on curved cells: needs a gate decision (eval values) and touches `common/quad.ts` / `lagrange.ts defaultRule` (the latter not this lane's).
- O3: `coupled/fsi.ts` interface scatter (`slotOf` per entry) unchanged; it and the acoustic part dominate membrane-air's assembly.
- O4: before / after rows are sequential under different loads (no old-code copy without git); pzt4's assembly gain is clear (2.5 s against 5.9-7.2 s in DevLog-045 and about 6.1 s in this baseline's first warm run), the 2D rows are within the load noise.
- O5: browser runs of the pool (real workers, COOP / COEP page) and of the complex WASM solve under the CSP not done in this lane; `wasmComplexSolveSupported()` falls back to plain arrays and the JS solve when compilation is blocked (same results).
- O6: R2 producer side (`run.solver` filled by `withStudySolver` and em3d) waits for the type.

## 6. Hand-off (2026-11-18 14:05 PST)
- Done: R1-R3 slot reuse (bitwise); piezo C B kernel (round-off, gate s.3.2) with compact B nonzeros; `solidKernel` for 2D / 3D elasticity (bitwise); complex LDL^T triangular solve in WASM (bitwise, 2.1-2.3x); em3d AMS-preconditioned iterative eigen path ('direct' default, 'ams', 'auto'); worker pool for sweeps with `EngineClient.runSweep`; requests R1-R3.
- API: core `la/wasm/solve-complex` (`DEFAULT_COMPLEX_SOLVE`, `setDefaultComplexSolve`, `wasmComplexSolveSupported`, `CSOLVE_MIN_NNZL`, re-exported by `la/ldlt-select`); core `la/ams-real` (`buildAMSReal`, `buildPMGReal`, `leadingBlock`, `pcgCsr`, `spmvCsr`, `diagSlots`); physics `common/eigen.ts` `EigenInput.linearSolver`, `EigenInput.sym`; `coupled/assemble.ts` `scatterPair`, `solidKernel`, `solidKernelWork`; em3d `CavityProblem.solver`, `solverRtol`, `EM3D_DIRECT_MAX_BYTES`, `EM3D_AMS_RTOL`, emw `settings.solver` / `settings.rtol` (after R1); web `engine/pool.ts` (`WorkerPool`, `poolSize`, `POOL_MAX`), `EngineClient.runSweep(jobs, onPoint?, workers?)`. Existing signatures unchanged.
- Files: new `packages/core/src/la/wasm/solve-complex.{mjs,d.mts}`, `packages/core/src/la/ams-real.{mjs,d.mts}`, `packages/core/bench/{csolve-bench,perf-core-2-em3d,sweep-parallel}.mjs`, `packages/core/test/la-complex-solve.test.mjs`, `packages/physics/test/e8-em3d-ams.test.ts`, `apps/web/src/lib/engine/pool.ts`, `apps/web/test/e8-pool.test.ts`; edited `packages/core/src/la/{ldlt.mjs,ldlt-select.mjs,ldlt-select.d.mts}`, `packages/core/bench/perf-core-1.mjs` (workloads fbar, membrane, t2), `packages/physics/src/{elastic/index.ts,elastic/modal.ts,coupled/assemble.ts,coupled/piezo.ts,heat/index.ts,em3d/index.ts,common/eigen.ts}`, `apps/web/src/lib/engine/client.ts`.
- Rerun: `nice -n 10 node --max-old-space-size=1536 packages/core/bench/perf-core-1.mjs --only <pzt4|fbar|hotarm|kirsch|membrane|t2> --runs 3 --dump DIR` then `--compare A B`; `... packages/core/bench/perf-core-2-em3d.mjs --h 1 --solver direct|ams|auto [--rtol 1e-10]` (guard RSS; h 0.75 AMS about 3.5 min); `... packages/core/bench/csolve-bench.mjs --dim 3 --N 24`; `... packages/core/bench/sweep-parallel.mjs --workers 4`.

## 7. Integration fix: pool worker state (2026-11-18)
Request R1 of DevLog-064 (lane G7): 4-worker sweeps of `sims/pec-post-scattering.yaml` failed random points with "w: pml: PML cell 0 (centroid -0.04966, 0.05949 m) lies inside the box of the non-PML region [-0.06000, 0.06000] x [-0.06000, 0.06000] m"; 1 worker solved 9/9.

- 2026-11-18 (session start) plan: reproduce headlessly (Node replica of the worker path first, browser second), find the state or race, fix at its place, regression test, 3 x 4-worker sweeps against the serial run.
- Node replica (one realm, the session's 9 point texts, parseSpecText -> studyReadiness -> prepareRun -> mesh quality + structured clone of the mesh message -> runStudy -> transfer of the solution buffers, pool orders such as 0,4,1,5,8 and repeats): no failure. Solution buffers do not alias the mesh; the nested-mesh cache (`prepare.ts` chains, keyed by params) is not hit between different f.
- 18:42 PST browser (vite dev on a free uncommon port, headless Chromium 151.0.7922.34 = Chrome for Testing, deviceMemory forced to 8, `session.sweepWorkers = 4`): reproduced, about half of the fresh-page sweeps lose 1-3 points. Message trace (wrapped `Worker`): only the second job of a pool worker fails; the third job on the same worker solves; the pool never had two runs on one worker and ids never crossed (pool and worker message handling are correct).
- the meshes of failing and passing points are identical (hash, 11028 tri6 cells, domain histogram 5096 PML / 5932 air, entity order). Temporary debug in the worker (removed): `runStudy` re-run on the same prepared context in the same worker right after the failure solves; a temporary count in `buildPml` (removed) showed correct inputs at the failure (11028 active cells, 5096 PML-flagged, no air cell flagged), yet `cellBox(mesh, (c) => !!active[c] && !pmlCell[c])` returned the box of all cells (+-60 mm, the outer box) instead of +-45 mm.
- cause: a V8 miscompile in Chrome 151, not state carried between jobs. With the same build, 6 sweeps each: `--js-flags=--no-maglev` 6/6 clean, `--no-turbofan` 6/6, `--no-use-osr` 6/6, `--no-concurrent-recompilation` 6/6; without flags 3 of 6 sweeps lost points. The loop of `cellBox` called through two different closures gets optimized on-stack-replacement code (compiled concurrently; CPU contention of 4 workers makes it land mid-run) that evaluates the other call site's predicate. Node 23.7 (V8 12.9) does not show it with `--always-osr`, `--always-osr-from-maglev` or `--concurrent-recompilation-delay=20|100`.
- Fix (package module, minimal; wave2d is not a G1 / G3 path): `packages/physics/src/wave2d/pml.ts` `cellBox(mesh, include: Uint8Array, exclude?: Uint8Array)` reads typed-array masks instead of calling a per-cell closure; `buildPml` calls `cellBox(mesh, active, pmlCell)` and `cellBox(mesh, active)`; `wave2d/index.ts` scattering-width box `cellBox(mesh, md.mask)` (one line). Same arithmetic, same boxes. No change in `apps/web/src/lib/engine/**` (pool and worker were correct; the temporary worker debug is reverted).
- Regression test: `packages/physics/test/fx-pool-pml-box.test.ts` (Node, pure): boxes of the pec-post mesh from masks (+-45 mm window, +-60 mm outer) and 60 repeated builds with fresh arrays interleaved with the scattering-width call. Fails before the fix (`TypeError: flag is not a function`, the callback form), passes after. It cannot reproduce the Chrome miscompile itself (Node's V8 does not have it); the browser check below is the functional regression.
- 18:52-18:54 verification: browser, after the fix, 10 fresh-page 4-worker sweeps 10/10 with 9/9 points (before: 3 of 6 to 3 of 4 sweeps failing); then twice in one page 3 consecutive 4-worker sweeps + 1 serial sweep: 9/9 each, every point's scalars (all of them) and DOF identical to the serial run (`logs/fx-pool-browser-sweep-20261119T025353.log`). Gates: `pnpm --filter @amp/web check` 0 errors; `pnpm --filter @amp/web test` 137/137 (`logs/fx-pool-web-test-20261119T025314.log`); physics `test/wave2d-*.test.ts`, `test/bloch-*.test.ts` and the new test 39/39 (`logs/fx-pool-physics-wave2d-20261119T025201.log`); physics `tsc --noEmit` clean.
- Open: other per-cell closures in hot loops (e.g. `differs(c)` in wave2d/index.ts and similar callback-predicate helpers) use the same pattern; no wrong result was seen (4-worker sweeps bitwise equal to serial), but the miscompile is engine-side. The browser repro script (playwright-core, wrapped Worker trace) is in the session scratch, not tracked; a pool check with more than one worker is not part of the e2e smoke (deviceMemory 2 forces one worker).
- 18:55 PST section written; dev server (own, port 47913) stopped.
