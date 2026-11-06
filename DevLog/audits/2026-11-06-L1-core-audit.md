# Audit 2026-11-06: lane L1 `@amp/core` (DevLog-002)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Auditor | fresh-context audit subagent (no prior conversation; files inspected directly) |
| Target | `packages/core/**`, `DevLog/DevLog-002-core-extraction.md` |
| References | CLAUDE.md, CONTRACTS-v0 C1/C2, DevLog-001, EO `eo-modulator-atlas` HEAD `0546007` and APA `advanced-packaging-atlas` HEAD `fe39985` (read from `.git/refs/heads/main`, no git command) |
| Edits | this file only; scratch output in the session scratchpad (not in the repo) |

Verdict: **no blocking findings.** Provenance, licensing, tests, types and benchmarks reproduce as claimed. Four significant findings are about fitness for lane L4 (units convention in `tri-fe`, untyped declarations, core-own test gaps, missing generic drivers), not about the port itself.

## 1. What was checked and how

### 1.1 Port headers, SPDX, Palace attribution

- `head -1` of all 35 `src/**/*.mjs`: 34 start with `// Ported from <repo>/engine/src/<path> at <sha> (GPL-3.0-or-later). Changes: ...`; `index.mjs` (new) starts with SPDX. Every `.mjs`, `.d.mts`, test, helper and bench file has `// SPDX-License-Identifier: GPL-3.0-or-later` within the first 12 lines (no file missing). Commit shas `0546007` / `fe39985` match `.git/refs/heads/main` of EO / APA.
- Palace-derived files: `grep -il palace` over the ported APA sources gives exactly `em3d/{krylov,pmg,ams}.mjs` among the ported files (`lumped.mjs`, `prom.mjs` not ported). Core `la/{krylov,pmg,ams}.mjs` keep the Apache-2.0 "Adapted from awslabs/palace ... at 29ad351f" block (krylov.mjs:4-8, pmg.mjs:4-12, ams.mjs:6-12), and `packages/core/NOTICE` lists all three with their Palace source files and the Palace NOTICE line. `cmp packages/core/LICENSE-APACHE-2.0 advanced-packaging-atlas/engine/src/em3d/LICENSE-APACHE-2.0`: identical. The Palace NOTICE text was not checked against Palace itself (no local Palace clone); it matches APA `em3d/NOTICE`.

### 1.2 Diff of ported files against source

All 31 one-to-one ports compared with `diff` / `diff -u` (not only a sample). The only differences are:

| Kind | Files | Diff content |
|---|---|---|
| header only (2 added lines) | units, expr, params, la/{sparse, ldlt, complex, vector-dense, krylov, amg, ams, stencil, mg, block, halfmg, pcg}, la/wasm/{encoder, kernels, accel}, fem/{tri-fe, hcurl, space, q1-grid} | port header + SPDX |
| header + import paths | la/{dense, ldlt-blocked, ldlt-wasm, ldlt-select, gmres-real, order3d, pmg}, fem/tri | exactly the import rewrites the header states (pmg: 5 import lines) |
| header + constant | fem/nedelec1 | `import { LOCAL_EDGES } from './mesh.mjs'` -> `import { TET_EDGES as LOCAL_EDGES } from './hcurl.mjs'`; APA `em3d/mesh.mjs:361-368` and core `hcurl.mjs:52-59` are the same 6 pairs in the same order |

Extracted modules:
- `la/arnoldi.mjs` vs EO `vector-mode.mjs` lines 825-1087: `diff` shows one added blank line and `export` added to `seededRandom`, `dotv`, `ritzBasis`, `ritz`; nothing else. Matches the header.
- `fem/quadrature.mjs` `TRI_Q4` is textually identical to EO `vector-mode.mjs:634-642` `Q4`.
- `sweep.mjs`: `sweepAxis` = EO `sweepValues` (sweep.mjs:38-57) verbatim; axis checks, `pointValues`, `rejectSweptOverrides` and the `runSweep` loop match EO lines 80-88, 113-130, 198-213 with config / target code removed and the runner injected, as the header says. One behavioural change not in the header: see minor M3.

The EO / APA "byte-identical bodies" claim: EO vs APA `sparse`, `ldlt`, `complex`, `params` differ by 2 lines each (APA's own port-header comment); `units` differs by the K / ppm additions (24 diff lines), as stated.

### 1.3 Tests and types (rerun)

| Check | Command | Audit result | DevLog claim |
|---|---|---|---|
| core suite | `cd packages/core && nice -n 10 node --max-old-space-size=1536 --test --test-concurrency=1 "test/*.test.mjs"` | 61 tests, 61 pass, 0 fail, 15 files, 6.7 s | 61 / 61, 6.6 s, 15 files |
| per-file counts | `grep` + test names | match section 4.1 (la-halfmg 3 = 2 per-case loop + 1) | same |
| types | `../../node_modules/.bin/tsc -p . --noEmit` (5.9.3) | exit 0, no output | clean |
| package script | `pnpm --filter @amp/core check` | exit 0 (root `typescript` 5.9.3 now installed) | "fails until contract request 1" (now stale, M6) |
| runtime exports vs `.d.mts` | scratch script importing every module and parsing its `.d.mts` | every runtime export declared; no declared value missing at runtime (`halfmg._internals` members are namespace members, not a mismatch) | - |
| `index.mjs` loads | `node -e 'import("./src/index.mjs")'` | 34 namespaces, 12 ms | - |
| Node-only APIs in `src` | `grep -rn "process\.\|require(\|node:" src` | none (Worker-safe) | - |

### 1.4 Atlas suites against core

- EO suite rerun through the redirect hook (`AMP_EO_ATLAS=$PWD nice -n 10 node --max-old-space-size=1536 --import .../test/atlas-redirect/register.mjs --test --test-concurrency=1 tests/*.test.mjs`): **334 tests, 331 pass, 0 fail, 2 skipped, 1 todo, 107.4 s**, 9 modules redirected (complex, fem, ldlt, params, postproc/expr, postproc/units, semi/linear, sparse, vector-dense). Same as DevLog-002 4.2 and EO DevLog-043 line 245. The "failing tests" block at the end of the log is the `todo` D5 test, not a failure.
- APA suite: **not rerun** (about 250 s, over the 2 min budget). Checked instead: `logs/core-redirect-apa-20261106T152729.log` ends with `tests 330 / pass 330 / fail 0`, `duration_ms 245319`, `exit 0`; its redirect lines cover 24 distinct APA modules, as stated. APA's own record: DevLog-014 line 172 (G13, 330 / 330, 257.2 s); the DevLog-002 pointer "DevLog-013:353" is line 354 (M6).
- No file in either atlas is newer than `packages/core/src/index.mjs` after the audit runs (`find -newer`), so the runs wrote nothing into the atlases.

### 1.5 Gate-3 benchmarks (rerun, all five workloads, 20.5 s wall)

`nice -n 10 node --max-old-space-size=1536 bench/core-bench.mjs --eo <eo>/engine --apa <apa>/engine --runs 7 --out <scratchpad>/audit-bench-20261106T154014.jsonl`; load average 3.64 at start (other lanes active).

| Family | Audit core / in-process (ms) | ratio | DevLog core / in-process | ratio | Audit core / log | DevLog core / log | Identical results |
|---|---|---|---|---|---|---|---|
| Supernodal Cholesky (n 54,763, nnzL 1,794,543) | 101.6 / 96.94 | 1.048 | 101.4 / 99.3 | 1.02 | 1.091 | 1.09 | max dx 0 |
| LDL^T indefinite (n 24,158, nNeg 6,011) | 42.34 / 45.57 | 0.929 | 46.8 / 46.4 | 1.01 | 1.025 | 1.13 | max dx 0 |
| Shift-invert block Arnoldi (24 op. applications) | 92.02 / 94.91 | 0.970 | 94.1 / 90.1 | 1.04 | 0.912 | 0.93 | n_eff 1.8938016907541757 both |
| PCG + z-line GMG (93,840 nodes, 11 it, 4 levels) | 179.8 / 177.9 | 1.011 | 189.0 / 182.5 | 1.04 | 0.720 | 0.76 | max dT 0 |
| GMRES + p-MG (18,662 DOF, 19 + 19 it) | 573.8 / 574.9 | 0.998 | 573 / 586 | 0.98 | N/A | N/A | max dS 0 |

All within 15 % in-process; the PCG + GMG vs-log outlier (0.72) reproduces and APA's own `solveThermal` in the same process gives 184.5 ms (32.07 + 152.4) against the logged 249.6 ms, which supports the DevLog's reading that the log line, not the port, is slow. Caveat in M7.

### 1.6 DevLog numeric claims

| Claim | Measured | Status |
|---|---|---|
| 35 `.mjs` modules, 10,720 lines | `find src -name '*.mjs' \| wc -l` = 35; `cat \| wc -l` = 10,720; 35 `.d.mts` | correct |
| per-module LOC (section 5) | spot-checked 15 rows (arnoldi 273, sweep 113, stencil/mg/block/halfmg/pcg 200/460/685/647/105, amg/ams 281/113, index 37/37, quadrature 20/6) | correct |
| tests / helpers / fixtures / bench 2,149 lines | `.mjs` + `.ts` under test/ and bench/: 2,152 | off by 3 (M6) |
| 61 / 61, 15 files | rerun | correct |
| EO 334 / 331 / 0 / 2 / 1 | rerun | correct |
| APA 330 / 330, 245.3 s | log only | consistent with log |

### 1.7 Scans

- Physical constants: `grep -rnE "8\.854|299792|1\.2566|4e-7|273\.15|293\.15|1\.380649|1\.602|6\.626|9\.81|5\.67e-8|mu0|eps0|EPS0|MU0|kB"` over `src`: no constants (hits are a comment "multiply by eps0/2" in tri.mjs:293 and local variables named `C0`/`A0` in block / halfmg / accel). No material property literals. Remaining numeric defaults are solver controls (tolerances, restart, theta, coarseMax) and unit factors in `units.mjs` / `params.mjs`. One unit-scale literal that matters: `UM2 = 1e-12` (S1).
- Absolute local paths: none in `src`, `test`, `bench`, `NOTICE`, `package.json` (hits only in pnpm-generated `node_modules/.bin` shims, gitignored).
- Emoji: none (UTF-8 4-byte and dingbat ranges). Non-ASCII only in unit aliases (`Ω`, `°`, `µ`, `μ`, `·`) in units.mjs:27-28,96,126,128 and params.mjs:36, which are intended.
- Debug leftovers: no `console.*`, `debugger`, `TODO`, `FIXME` in `src`.
- Atlas imports: every import in `src` is relative and inside `packages/core/src`; no module imports atlas code. Atlas-model coupling remains inside two modules (M1, M2).

## 2. Findings

### Blocking

None.

### Significant

**S1. `fem/tri-fe.mjs` (and `fem/tri.mjs` docs) assume micrometre coordinates; C1 / C2 say SI metres.**
Evidence: tri-fe.mjs:8 "Coordinates in the mesh are micrometres; this module returns areas in m^2 (scale 1e-12)", tri-fe.mjs:13 `export const UM2 = 1e-12`, used unconditionally in `elementMass` (tri-fe.mjs:159) and `elementLoad` (:170), so `assembleByTag(..., {mass: true})` and load vectors scale by 1e-12. tri.mjs:4 "Coordinates are micrometers", tri.mjs:348 "Gradient of phi per triangle (V/um)". CONTRACTS-v0 C1 "Units inside the engine: SI base units"; C2 `nodes` "SI metres". A C2 mesh fed to tri-fe gives mass and load 1e-12 too small, silently; stiffness is scale free in 2D so a pure Poisson test would not show it. DevLog-002 section 5 lists tri-fe changes as "moved" and does not flag the convention.
Fix: keep the ported numerics, but (a) record the convention in DevLog-002 section 5 and as a contract note, (b) give L4 an SI entry point, e.g. a `lengthScale` option on `elementMass` / `elementLoad` / `assembleByTag` defaulting to the APA value for the redirect run, or a thin core wrapper that uses scale 1, (c) add a core test: unit square in metres, P1 and P2 mass matrix sum = area (1 m^2), load sum = area.

**S2. la / fem declarations are effectively untyped for TypeScript callers.**
Evidence: about 1,000 `any` tokens in `src/la/*.d.mts` and `src/fem/*.d.mts` (e.g. sparse.d.mts 81, ldlt.d.mts 70, block.d.mts 77, halfmg.d.mts 76, hcurl.d.mts 59, tri.d.mts 55); only units / expr / params / sweep / quadrature / complex / index are `any`-free. Negative probe (scratch tsconfig extending `packages/core/tsconfig.json`): `new SparseCholesky('not a pattern')`, `gmres(1, 2, 3, 4)`, `buildSpace({ nonsense: true }, 7)` and `const z: string = buildSpace(...).nDof` all compile; only `parseUnit(3)` is rejected. C1 makes new code (L4 physics) TypeScript, so the `tsc` gate gives L4 no protection at the core boundary. Known as DevLog-002 proposal 6, but deferred.
Fix: before L4 consumes core, add `src/la/types.d.mts` (`CsrPattern {n, rowptr, colidx, nnz}`, symbolic / numeric factor interfaces, `StencilOp`, `MGHierarchy`, `HcurlTetMesh`, `HcurlSpace`, `TriMesh {nNodes, nTris, tri, x, y}`) and retype the entry points L4 will call: `buildPattern`, `buildElementPattern`, `elementSlots`, `matVec`, `analyze`, `SparseCholesky`, `SupernodalLDLT`, `ComplexSupernodalLDLT`, `makeFactor`, `blockArnoldi`, `gmres` (both), `pcg`, `buildMG`, `mgPrecond`, `restrictMatrix`, `assemble` / `assembleP2`, `buildSpace`, `tetGeometry`, `tetMatricesP`, `triTables`. Extend `test/types-smoke.ts` with `// @ts-expect-error` lines like the probe above.

**S3. Several modules have no test in the core suite; their only coverage is the redirect run against the sibling atlases.**
Evidence: no file under `test/` imports `src/fem/space.mjs`, `src/fem/tri-fe.mjs`, `src/la/pmg.mjs`, `src/la/ams.mjs`, `src/la/wasm/kernels.mjs` or `src/index.mjs` (`grep -l "src/<module>'" test/*.mjs test/helpers/*.mjs` = 0); `la/complex.mjs` only indirectly. DevLog-002 section 5 marks these "(via redirect)" / "(needs a tet mesh)". The redirect run needs both atlases present at the audited commits; once they move or are absent (CI, other machines), regressions in these modules go undetected by `pnpm test`. `fem/space.mjs` and `fem/hcurl.mjs` are on the H5 critical path; `tri-fe` carries S1.
Fix: add a structured tet helper (box split into 6 tets per hex, vertex indices sorted ascending, the shape documented in contract request 3) and tests: `buildSpace` DOF counts for order 1 (nEdges) and order 2 (2 nEdges + 2 nFaces); a PEC box cavity eigen solve (`tetMatricesP` + `SupernodalLDLT` + `blockArnoldi`, shift above zero) against the closed form k^2 = pi^2 (m^2/a^2 + n^2/b^2 + p^2/c^2) for the lowest mode, which is a closed-form reference; tri-fe mass sum (S1); a runtime `import('../src/index.mjs')` smoke test. pmg / ams can wait for refactor proposal 7.

**S4. Generic pieces missing for the wave-1 physics (API fitness for L4).**
Evidence from `grep` over `src` (no hits for `bdf|theta.?method|newton|timestep|axisym`) and the module exports:

| Hero (DevLog-001 table) | What core provides | Gap |
|---|---|---|
| H2 heat (HT-01 Robin, HT-02 transient, HT-03 radiation) | tri.mjs / tri-fe.mjs P1/P2 stiffness + mass, `restrictMatrix`, `SparseCholesky`, PCG + GMG on rectilinear grids, q1-grid Robin / flux faces (hex grids only) | no boundary-facet (line2 / line3) Robin / flux assembly on triangle meshes; no time integrator (A8 lists BDF / generalized-alpha); no Newton / Picard loop (HT-03 eps sigma T^4) |
| H1 2D elasticity P2 | scalar P2 assembly (`assembleP2`, 3 coefficients per triangle), `p2Grad`, CSR patterns | no vector-valued (2 components per node) DOF map or B-matrix assembly on triangles; no traction edge loads; `la/block.mjs` 3 x 3 blocks are grid stencils only |
| H3 axisym magnetostatics | constant-per-triangle coefficient assembly | no quadrature-based assembly with r-dependent weights; EO has no axisym code at all (`grep -rln axisym eo-modulator-atlas/engine/src`: 0 files), so DevLog-001 H3 "Reuse: EO fem (axisym weights)" has nothing to reuse |
| H4 vector modes | `hcurl.triTables` (ND trace mass, 2D curl-curl, H1 stiffness / mass, mixed), `tri2dGrads`, `gradGram2d`, `curlGram2d`, `blockArnoldi`, `SupernodalLDLT` | no triangle edge-DOF space (`fem/space.mjs` is tet only); the Lee-Sun-Cendes assembly and the shift / inertia driver remain in EO `vector-mode.mjs` |
| H5 3D Nedelec eigen | `buildSpace`, `tetGeometry`, `tetMatricesP` (order 1-2), real / complex LDL^T, `blockArnoldi`; L3 `toHcurlMesh` delivers the mesh (packages/mesh/src/hcurl.ts:17) | no global ND assembly (APA `em3d/solver.mjs` `prepare3d` not ported), no PEC elimination for edge / face DOFs, no driver handling the gradient null space (shift choice) |
| H6 acoustics | q1-grid `assembleConduction` + `assembleMass` (grid K, M), `stencilToCSR` (free-node block), LDL^T, Arnoldi | no CSR `A + sigma B` on a shared pattern helper; no H1 tet assembly (`tetTables` builds ND only; `h1Basis` + `compileBilinear` are the pieces) |
| all | - | the shift-invert driver (DevLog-002 proposal 4) is needed by H4, H5 and H6; fem modules take atlas mesh shapes (`{nNodes, nTris, tri, x, y}`), and there is no C2 -> triangle-mesh adapter (only the 3D `toHcurlMesh` in L3) |

Fix: promote proposal 4 (generic `shiftInvertEigen(A, B, sigma, {nWant, tol, inertia})` in `la/`) and proposal 5 (one triangle space module with scalar / vector P1 / P2 and facet integrals) to L1 follow-up tasks before or alongside L4; add `la/csr-axpy` (or a `combine(patA, valA, valB, sigma)` helper); add a C2 2D adapter (L3 or core) that produces `{nNodes, nTris, tri, x, y}` in metres. Time stepping and Newton can be L4-owned but should be specified as core-generic in DevLog-001 A8 so that H2, H8 and H9 share one implementation.

### Minor

**M1. Physics-specific helpers inside `la/`.** `la/gmres-real.mjs:12` exports `bernoulli` (Scharfetter-Gummel, semiconductor) and `ScaledSpdBlock` (:116); the module imports `restrictMatrix` from `../fem/tri.mjs` (gmres-real.mjs:9), so `la` depends on `fem`. Fix: when the file is next touched, move `bernoulli` / `ScaledSpdBlock` to physics (semiconductor) and `restrictMatrix` to `la/sparse` (or a `la/csr` module).

**M2. em3d case semantics in `la/pmg.mjs`.** pmg.mjs:74-85 read `mesh.tetSolid`, `P.solidProps[s].kind === 'conductor' && .model === 'pec'`, `P.inDomain`, `P.dirichlet`. Generic only in name; already proposal 7. Fix: as proposal 7 (pass a PEC node mask and the order-1 prolongation).

**M3. `parametricStudy` silently skips the unknown-parameter check when `params` is omitted.** sweep.mjs:46 `const known = params == null ? null : ...` then `if (known && !known.has(a.param))`. EO always checks (`!Object.hasOwn(defs, a.param)`, EO sweep.mjs:83). The header does not mention it, and C3 wants strict, explicit behaviour. Fix: make `params` required (throw if missing) or record the relaxation in the header.

**M4. Stale attribution pointers inside Palace-derived bodies.** krylov.mjs:8, pmg.mjs:12, ams.mjs:12 say "see engine/src/em3d/NOTICE" (an APA path). Line 1 of each file points to `../../NOTICE` correctly, so attribution is intact. Fix: none required for the port-as-is rule; optionally append "(here: packages/core/NOTICE)" to line 1 wording, which is already there in substance.

**M5. Ported code in a test helper without a C1 first-line header.** `test/helpers/grid-thermal.mjs` contains `activeNodes` "ported from advanced-packaging-atlas/engine/src/grid/index.mjs at fe39985 (verbatim)" (header lines 6-7), but line 1 is the SPDX line. Fix: add the C1 `// Ported from ... Changes: ...` line as line 1.

**M6. DevLog-002 text that is stale or slightly off.**
- Contract requests 1 and 2 are resolved: root `package.json` has `typescript` 5.9.3, `node_modules/.bin/tsc` exists, `pnpm --filter @amp/core check` exits 0; `tsconfig.base.json` `lib` is now `["ES2023"]`. TODO line "Coordinator: root typescript devDependency" and section 8 "needs contract request 1" are out of date. Contract request 3 is delivered by L3 (`packages/mesh/src/hcurl.ts` `toHcurlMesh`).
- Plan 1.1 says Arnoldi lines 826-1098; the code and progress log say 825-1087 (verified 825-1087).
- "APA DevLog-013:353" is line 354.
- Tests / helpers / fixtures / bench "2,149 lines": measured 2,152.
- Section 5 "LOC incl. the 2-line port header": headers of arnoldi (7 lines), quadrature (6), sweep (9) are longer.
- Section 8 "gates 1-4 met", but DevLog-002 defines only Gate 1 (4.1) and Gate 3 (4.3); gates 2 and 4 are not named in DevLog-002 or DevLog-001.
Fix: update the TODO, section 6 status, the line references and the gate list.

**M7. Gate-3 interpretation.** Core and atlas run byte-identical function bodies, so in-process ratios near 1.0 are expected by construction (the audit's LDL^T 0.93 and the DevLog's 1.01 on the same code show the noise level, about +-7 %); the informative evidence is the bitwise-identical results and the vs-log column. The p-MG bench builds `P` with APA's `prepare3d`, so `P.pmg` comes from APA `preparePMG` and the coarse factor from `P.p.factor`; core `preparePMG` is exercised only by the APA redirect run. Fix: state this in 4.3; if a core-only p-MG timing is wanted, call core `preparePMG` on `P` in the bench.

**M8. `fem/space.mjs` does not check the sorted-vertex precondition.** Correctness of the hierarchical basis without signs needs ascending vertex order per tet (space.mjs:9; hcurl.mjs:7); the module does not assert it, and only L3's adapter sorts (packages/mesh/src/hcurl.ts:24). Fix: a debug-time check in a core wrapper (`assertSortedTets(mesh)`), or document it in the `.d.mts` of `buildSpace`.

**M9. Global mutable state.** `la/ldlt-select.mjs` `setDefaultFactor` and `la/sparse.mjs` `timingSink` are module-level. Fine for one solve per Worker; note it for L4 if one Worker runs several studies concurrently.

## 3. Not checked

- Full APA suite rerun (about 250 s; log inspected instead).
- Palace NOTICE text against the Palace repository itself (no local clone; matches APA em3d/NOTICE).
- Numerical correctness of the ported algorithms beyond the ported tests, the redirect runs and the bitwise A/B identity.
