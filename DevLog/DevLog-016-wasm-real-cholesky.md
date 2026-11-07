# DevLog-016: WASM SIMD real front kernel (lane P1, core performance)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | P1 (core performance) |
| Owns | `packages/core/src/la/**` (kernel and wiring), `packages/core/test/**`, `packages/core/bench/**`, this file |
| Inputs | DevLog-001 A8 (accelerators behind measured gates: WASM SIMD > 2x end to end, same answer), the TODO item on H6 speed; DevLog-002; DevLog-010 s.9.1 (AC-02 finest level: real Cholesky 2.57-2.59 s, complex WASM LDL^T 3.67-3.81 s); EO DevLog-024 S3.10, APA DevLog-012 (G1, L7 wave 5) (read only) |

## 1. Plan (written 2026-11-06 17:45 PST, before coding)

### 1.1 What exists
- Real SPD: `la/sparse.mjs` `factorNumeric` (`SparseCholesky`), supernodal multifrontal, dense column-major fronts, panel left-looking in column pairs, Schur update in target-column pairs, 4 source columns per pass. Used by acoustics / eigen ('cholesky'), heat, elastic, electrostatics, em3d / em-axisym H blocks.
- Real indefinite: `la/ldlt.mjs` `SupernodalLDLT` (same tree, one target column at a time, weights F[k, c] D[c]). Used by eigen ('ldlt') and vector modes.
- Complex only: `la/ldlt-wasm.mjs` (`WasmComplexLDLT`, f64x2 over split re / im), module bytes built at run time by `la/wasm/encoder.mjs` (no toolchain, no binary asset). Selector `la/ldlt-select.mjs` (complex, default 'blocked').

### 1.2 Design
- Per-entry arithmetic of every existing real kernel (Cholesky panel and Schur, LDL^T panel and Schur) is the same: for target column t and row i, groups of 4 source columns c = 0, 4, ... with c + 3 < cmax: `F[i,t] -= ((F[i,c] w_c + F[i,c+1] w_c+1) + F[i,c+2] w_c+2) + F[i,c+3] w_c+3`; then the remaining source columns one at a time, skipped when w_c = 0. cmax = k for panel column k, nc for the Schur block; w_c = F[t,c] (Cholesky) or F[t,c] D[c] (LDL^T).
- The WASM kernel keeps exactly that per-entry operation sequence (f64x2 lanes are IEEE f64; WASM has no implicit FMA, V8 JS does not fuse either), so the factor should be bitwise identical to the JS path, not only within round-off. Vectorisation is over rows (2 rows per f64x2), register tiling over 4 target columns (16 splatted weights in v128 locals, 4 source vectors shared by the 4 targets).
- Kernels (new `la/wasm/front-real.mjs`, bytes built with the existing encoder): `g4` (4 targets, n groups), `s4` (4 targets, one single source column, all 4 weights nonzero), `g1` / `s1` (one target). Rows [r0, m); the 1-3 head rows of a 4-target tile that lie above a target's diagonal are done in JS with the same expression, so nothing outside the lower triangle is written.
- Panel: 4-column tiles at k = 0, 4, 8, ...: g4 over the groups c < k (shared by the 4 columns), then column by column in JS order: singles from the tile, pivot, scaling (pivot logic stays in JS: Cholesky sqrt and positivity test; LDL^T static perturbation and inertia).
- Front storage F lives in the module's memory (one `WebAssembly.Memory`, fixed size from `sym.maxFront`, never grown, no SharedArrayBuffer). Assembly, extend-add and the stack stay in JS. Fronts with m below a threshold run the unchanged JS code (results are identical either way, so the threshold is speed only).
- Selection: `la/ldlt-select.mjs` gets `DEFAULT_REAL_FACTOR` ('blocked' = current JS kernels, 'wasm'), `setDefaultRealFactor`, `realFactorFallbackWarning`; the state lives in the leaf module `la/wasm/front-real.mjs` (ldlt-select re-exports it) to avoid an import cycle sparse/ldlt <-> ldlt-select. `SparseCholesky` / `factorNumeric` / `SupernodalLDLT` take an optional `factor` option, default from `DEFAULT_REAL_FACTOR`. 'wasm' falls back to 'blocked' without SIMD or when the front does not fit.

### 1.3 Gate (DevLog-001 A8: > 2x end to end on the factor, results identical to the JS path within 1e-12 rel)
Matrices (3 runs each, JS and WASM interleaved, nice 10, heap 1536):
1. AC-02 finest level (tet10 acoustics, ~33.8k DOF): rebuilt through @amp/physics `prepareRun` + acoustics run at hFactor 0.25 with a capture of the factored matrix (K - sigma M as shiftInvertEigen forms it).
2. EO electrostatics: mao2022 ES P1 (n 54,763, the DevLog-002 gate-3 matrix), built with the EO atlas read only.
3. APA thermal grid: bench grid M (93,840 nodes, direct_nd as APA `StencilCholesky`), built with the APA atlas read only.
Per matrix: factor ms (JS, WASM), end-to-end solve ms (analyze + factor + solve), max |dx| / max |x| on a solve, bitwise check of the solution. Gate passes per matrix when factor speedup > 2x and rel diff <= 1e-12. If 2 of 3 pass: default 'wasm' for real SPD and LDL^T; rerun core suite, EO redirect suite (expect 334/331/0/2/1), physics tests, AC-02 harness case; report H6 vs 5 s.
Browser: headless Chromium (playwright-core from apps/web, read only use) loading a module worker under the apps/web `/_app/*` CSP header string, short-lived server on an uncommon free port, killed after.

## 2. TODO
- [x] Kernel module `la/wasm/front-real.mjs` (+ `.d.mts`)
- [x] Wire into `factorNumeric` / `SparseCholesky` and `SupernodalLDLT`; selector in `ldlt-select`
- [x] Tests: bitwise equality JS vs WASM (Cholesky and LDL^T, odd sizes, zero weights, perturbed pivots, failure in a WASM front, memory growth), selector default
- [x] Gate bench `bench/real-front-gate.mjs` on the 3 matrices, log to `logs/`
- [x] Decision on the default ('wasm', 2 of 3 pass); reruns (core, EO redirect, physics, AC-02 harness)
- [x] Browser worker check under the CSP
- [x] Fresh-context audit (no bugs; test gaps closed)
- [x] Results and hand-off

## 3. Progress log
- 2026-11-06 17:45 PST: read CLAUDE.md, DevLog-001 A8 / targets / H6 TODO, DevLog-002, DevLog-010 s.9.1, core la (sparse, ldlt, ldlt-wasm, ldlt-select, wasm/encoder, wasm/kernels), EO DevLog-024 S3.10, APA DevLog-012 WASM rows. Plan above.
- 2026-11-06 17:48 PST: `la/wasm/front-real.mjs` written (g4 / s4 / g1 / s1 kernels, shared growable memory, JS driver with pivots); wired into `factorNumeric` / `SparseCholesky` (`factor` option) and `SupernodalLDLT` (`{factor}` constructor option); `ldlt-select` re-exports `DEFAULT_REAL_FACTOR` / `setDefaultRealFactor` / `wasmRealSupported` and adds `realFactorFallbackWarning`. Synthetic smoke (27-point 3D grids, scratchpad script): 20^3 Cholesky 142-157 -> 63-70 ms, LDL^T (indefinite, 1,936 negative pivots) 216-225 -> 66-74 ms; 30^3 Cholesky 2,209-2,247 -> 792-806 ms (2.8x), LDL^T 3,331-3,390 -> 845-854 ms (3.9x). Solutions and D bitwise identical to the JS path in every case.
- 2026-11-06 17:50 PST: gate bench `bench/real-front-gate.mjs` written; AC-02 matrix run (log `logs/real-front-gate-20261106T175010.jsonl`): factor 2,520-2,552 -> 927-1,005 ms, median 2.72x, bitwise identical solution.
- 2026-11-06 17:51 PST: EO and APA gate runs (log `logs/real-front-gate-20261106T175053.jsonl`). WASM_MIN_FRONT scan on EO (16 / 32 / 64: 36.0 / 32.9 / 32.8 ms median wasm factor): kept 32.
- 2026-11-06 17:52 PST: H6 end-to-end A/B (log `logs/real-front-gate-20261106T175250.jsonl`).
- 2026-11-06 17:53 PST: gate passes on 2 of 3 (AC-02, APA): default real kernel set to 'wasm'. Allocation failure (memory create / grow RangeError) falls back to JS.
- 2026-11-06 17:54-17:57 PST: core suite 80/80 (`logs/p1-core-suite-*.log`), tsc clean; EO redirect 334/331/0/2/1 (`logs/p1-redirect-eo-20261106T175414.log`); physics 43/43 (`logs/p1-physics-tests-20261106T175612.log`); AC-02 harness 3 runs (`logs/p1-harness-ac02-*.log`, `logs/eval-20261106T175623/175628/175632.jsonl`).
- 2026-11-06 17:58 PST: `wasmRealSupported()` now also compiles the module, so a CSP-blocked compile reports unsupported; fallback warning text names the CSP case. Browser check (`logs/p1-browser-worker-20261106T175752.log`).
- 2026-11-06 17:59-18:03 PST: fresh-context audit (subagent, read only). Hand check of op order / encoding / memory / pivots / fallback, plus a randomized differential test: 840 random sparse SPD and indefinite matrices, 0 mismatches (lower Lx, D, nNeg, nPerturbed, ok, solutions); special values (NaN, Inf, -0, 5e-324, 1e300) equal on both paths. No bugs. Findings acted on: (a) the Cholesky failure test failed in a small JS front, so the WASM pivot-failure path was never run: new test puts -1e6 / NaN on the last-eliminated diagonal (root front >= 32 rows) for Cholesky and LDL^T; (b) the growth test may not grow: now starts from `releaseRealFrontKernel()` and asserts growth; (c) the memory never shrinks: added `releaseRealFrontKernel()`. Not changed (nits): the upper triangle of each stored Lx block is stale data on both paths (never read; Lx compared on the lower part only); `realFactorFallbackWarning` does not report the oversize / allocation fallback (`kernel` field does); else-branch bodies not re-indented.
- 2026-11-06 18:04-18:06 PST: final reruns: core 81/81 (`logs/p1-core-suite-20261106T180421.log`), tsc clean, EO redirect 334/331/0/2/1 (`logs/p1-redirect-eo-20261106T180435.log`), physics 43/43 (`logs/p1-physics-tests-20261106T180435.log`).

## 4. Results

### 4.1 Gate (Node v23.7.0, Apple M4 Pro, nice 10, heap 1536 MB, load average 3.5-4.0 from other lanes; 1 warm-up + 3 interleaved runs per kernel)

| Matrix | n / nnzL / maxFront / flops | Factor ms, blocked (JS) | Factor ms, wasm | Factor speedup (median; min-over-max) | End-to-end ms (order + symbolic + factor + solve), blocked -> wasm | Solution vs JS | Gate |
|---|---|---|---|---|---|---|---|
| AC-02 finest level (tet10, hFactor 0.25, K - sigma M, AMD) | 33,825 / 1.65e7 / 2,539 / 2.17e10 | 2,552 / 2,533 / 2,520 | 1,005 / 927 / 930 | 2.72x (2.51x) | 2,612 -> 1,027 (2.54x) | bitwise identical, relres 9.4e-15 both | pass |
| EO mao2022 electrostatics P1 (AMD) | 54,763 / 1.79e6 / 357 / 2.16e8 | 44.1 / 45.2 / 42.2 | 34.8 / 32.9 / 32.9 | 1.34x (1.21x) | 87.2 -> 80.5 (1.08x) | bitwise identical, relres 3.9e-14 both | fail (speed) |
| APA thermal grid M free block (gridNDOrder) | 59,790 / 1.72e7 / 1,634 / 1.33e10 | 1,607 / 1,616 / 1,604 | 753 / 662 / 661 | 2.43x (2.13x) | 1,670 -> 738 (2.26x) | bitwise identical, relres 6.3e-15 both | pass |

Gate rule (DevLog-001 A8): > 2x on the factor and agreement <= 1e-12. Passes on 2 of 3, so the default real kernel is 'wasm' (`DEFAULT_REAL_FACTOR`, `la/wasm/front-real.mjs`, re-exported by `la/ldlt-select.mjs`). The complex `DEFAULT_FACTOR` stays 'blocked'. EO's 2D fronts are small (maxFront 357), so assembly and extend-add (JS) dominate there; it is still 1.3x faster with identical results.
Kernel rate (estimate from symbolic flops / median factor time, includes assembly): AC-02 8.6 -> 23 GFlop/s.

### 4.2 H6 (AC-02 end to end)

| Measurement | blocked (JS) | wasm | Values |
|---|---|---|---|
| bench h6 mode: prepareRun + run at h_factors [1, 0.5, 0.25], in process, 3 runs | 5,240 / 5,135 / 5,072 ms | 3,697 / 3,500 / 3,448 ms (1.47x) | identical (JSON of all level values) |
| finest level stages (last run): factor / solve (Arnoldi + refine) / assemble | 2,605 / 1,664 / 535 ms | 989 / 1,672 / 534 ms | |
| `node packages/eval/src/cli.ts --case AC-02` (harness worker, time_ms = cold sum over levels) | 5,616 / 5,615 ms (17:43 / 17:46 runs before this change) | 4,011 / 4,038 / 4,042 ms | 10/10 pass, identical f_mode values (e.g. 171.49999607946836 Hz), max err_rel 3.6e-6 |

H6 now meets < 5 s in Node (4.0 s harness, 3.5 s in process). Not measured: H6 end to end in a browser (Chrome / Safari) on the workbench; the browser check below is a load and equality check of the kernel, not an H6 timing. The remaining finest-level cost is the eigen solve (Arnoldi triangular solves, 1.7 s), untouched here.

### 4.3 Browser worker under the apps/web CSP
Headless Chromium 151.0.7922.34 (playwright-core 1.63.0 from apps/web, executable chromium_headless_shell-1234), short-lived Node server on 127.0.0.1:48731 (port checked free, killed after) applying `apps/web/static/_headers` rules `/*` (COOP / COEP / CORP) and `/_app/*` (the CSP with `script-src 'self' 'wasm-unsafe-eval'`) to a module worker that imports `packages/core/src` directly. Scripts in the scratchpad, deleted after. Log `logs/p1-browser-worker-20261106T175752.log`.
- Under the CSP: `wasmRealSupported()` true, no fallback warning, both factors ran 'wasm'. 18^3 27-point grid (n 5,832, maxFront 797): Cholesky 99.5 -> 39.6 ms, LDL^T 134 -> 41.6 ms. Solutions bitwise identical. crossOriginIsolated true; SharedArrayBuffer is not used by the kernel.
- Negative control (same CSP without 'wasm-unsafe-eval'): `wasmRealSupported()` false, fallback warning returned, 'wasm' requests ran 'blocked', results identical.

### 4.4 API (all in `@amp/core/la/*`)
- `factorNumeric(sym, values, num?, pat?, {factor?})`, `new SparseCholesky(pat, perm?, {..., factor?})` (`timing.kernel`), `new SupernodalLDLT(sym, {factor?})` (`.kernel`), `num.kernel`. `factor`: 'blocked' | 'wasm' | null (default `DEFAULT_REAL_FACTOR`, read at each factor()).
- `ldlt-select`: `DEFAULT_REAL_FACTOR`, `setDefaultRealFactor`, `wasmRealSupported`, `realFactorFallbackWarning`.
- `wasm/front-real`: `realFrontKernel`, `resolveRealKernel`, `releaseRealFrontKernel`, `WASM_MIN_FRONT` (32), `WASM_MAX_BYTES` (2^30).

## 5. Hand-off
- Caveats: the shared kernel memory grows to the largest front factored (AC-02: about 52 MB) and stays until `releaseRealFrontKernel()`; fronts needing more than 1 GiB, or a refused allocation, run the JS kernels. In a browser, synchronous `new WebAssembly.Module` of the 1,984-byte module is used (fine in a worker and below Chrome's main-thread limit).
- Files: `packages/core/src/la/wasm/front-real.mjs` (+ `.d.mts`), edits in `la/sparse.mjs`, `la/ldlt.mjs`, `la/ldlt-select.mjs` (port headers updated) and their `.d.mts`, `la/types.d.mts`; test `packages/core/test/la-real-front.test.mjs` (10 tests); bench `packages/core/bench/real-front-gate.mjs`.
- Rerun the gate: `nice -n 10 node --max-old-space-size=1536 packages/core/bench/real-front-gate.mjs --eo <eo>/engine --apa <apa>/engine [--runs 3] [--only ac02,eo,apa,h6]`.
- Possible next steps (not done): row-unrolled g4 (4 rows per iteration) or relaxed-SIMD FMA (would break bitwise equality); WASM for the supernodal triangular solves (now the H6 eigen phase); DevLog-001 H6 TODO item update is the coordinator's.
