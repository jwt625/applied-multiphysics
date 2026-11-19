# DevLog-066: chunk 3 engine audit fixes (fix lane FX3-engine)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | FX3-engine (DevLog-037 s.4.2, audit 3 engine / validation entry of 19:54 PST) |
| Owns | `packages/physics/src/common/**`, `packages/physics/src/elastic/**`, `packages/physics/src/acoustics/**`, `packages/physics/src/em-axisym/**`, `packages/physics/src/couplings/optomech.ts` (the eigen call is in `optomech/axisym.ts`: one note line there, s.6), `packages/physics/src/prepare.ts`, `packages/core/**`, `packages/post/**`, `packages/eval/**`, `packages/spec/src/types/solution.ts` (one optional field), `apps/web/src/lib/results/adapter.ts`, `validation/c/cases_ext/{driven,photonics2}.py`, rebuilt case files, `materials/tantalum-film.yaml`, tests, this file |
| Not owned | apps/web workbench / gfx / library / post display (FX3-web, coordinator), sims text, CONTRACTS (coordinator: changelog text in s.7) |
| Read | CLAUDE.md; DevLog-037 s.4.2 and the two audit-3 entries; DevLog-058, 059, 060, 061, 062; auditor repros `<scratch>/audit3-engine/{eig-gap,axi-amg,matT}.ts` |

Conventions: F = fact read from code or a run; D = decision of this lane; E = estimate; O = open item; R = request.

## 1. Plan (2026-11-18 20:00 PST, before coding; code edits wait for the class-c run to finish)

### 1.1 Facts
- F (eig-gap.ts, run 20:00): 1D Laplacian n 120, nWant 6, `check: 'inertia'`, one eigenvector projected out. sigma -0.01: hidden 3rd / 5th / 6th nearest all end 'missed'. Interior sigma 0.0856: hidden 3rd 'missed'; hidden 5th and 6th 'pass' (the check used the last gap among the computed eigenvalues on each side, so the outermost computed eigenvalue and everything between it and the shift beyond that gap was never counted).
- F: per-domain recovery (`post/src/points.ts recoverPerDomain`) keys the slots on `mesh.cells.domain`; the web display copy (`apps/web/src/lib/post/field2d.ts withPerDomain`) uses the same rule (not owned here).
- F: elastic producers (`elastic/index.ts`, `elastic/axisym.ts`) know per cell E, nu and, when coupled, alpha; `cellProps` resolves them per domain from the material assignment.
- F: `elastic/axisym.ts` creates `new SpdSolver(R.pat, p.solver ?? 'cholesky')` without the `amg` hook: AMG-PCG there is the scalar smoothed aggregation (constant vector only).
- F: `amg-sa.mjs denseCholesky` replaces a non-positive coarse pivot by `max(|A_jj| 1e-12, 1e-300)` and continues; the direct path throws `Cholesky: matrix not positive definite`.
- F: `SpdSolver.pcg` throws only above 10 x rtol; between rtol and 10 x rtol the result is accepted and only `run.solver.residual` shows it.
- F (matT.ts): `getProperty('silicon', 'n', {lambda, T: 298.15})` throws (the leaf is a 293 K table in lambda with `valid.T [293, 293]`); Si dndT at 293.15 K throws; Ge n likewise. Silicon E / nu are constants with `valid.T [25, 25] degC`.
- F: `resonance.ts` samples x0 + g {-1, -1/2, 0, 1/2, 1} and x0 +- 1.1 g without clamping; 'dip' uses `baseline - y` with a default baseline 1 and no check of the fit.
- F: `eval/schema/amp-eval-0.schema.json` target `form` enum: closed_form, benchmark, paper_sim, paper_measured, solver_ref, dataset (no regression / self-consistency form).

### 1.2 Design
1. Eigen completeness (major 1). Replace the gap points by a window check on the nearest-nWant property: D = largest |lambda - sigma| over the computed eigenvalues; theta_hi = sigma + (1 - eps) D, theta_lo = sigma - (1 - eps) D, eps = 1e-6 (+ a floor of 1e-9 |lambda| so Rayleigh-quotient round-off of the outermost eigenvalue cannot put it inside); the inertia counts in (sigma, theta_hi) and (theta_lo, sigma) must equal the computed eigenvalues there (+ nullDim when the interval contains 0). Every eigenvalue strictly nearer to sigma than the farthest computed one must be computed, so a hidden k-th nearest (k <= nWant) is caught on either side; ties at the outermost distance (degenerate partners not requested) are outside the window and do not raise a false miss. Factor count unchanged (one LDL^T per side; the lower side is skipped when the inertia at sigma is 0, nothing can lie below). A retry result is checked on its kept subset. Passing results are the first search unchanged (bitwise); only `stats.check.intervals` change.
2. Per-material recovery (major 2). Optional `FieldData.cellGroup?: Int32Array` (one per cell; cells with equal values belong to one constitutive group; -1 outside the physics). Elastic and axisymmetric producers fill it from the per-cell constants (E, nu, and alpha when a thermal-expansion coupling is present): cells with the same constants are one group, whatever their geometric domain or material node; a stress field is continuous across such a boundary, so the smooth nodal mean applies there. `recoverPerDomain` keys on `cellGroup` when present and of the right length, else on `cells.domain` (unchanged for other producers). Check: stacked same-material domains get the producer's nodal mean (bitwise `data`); PK-02 / CP-21 values unchanged.
3. Axisymmetric AMG (minor). Pass an `amg` hook: smoothed aggregation with the planar rigid-body modes in (r, z) as the near-nullspace (z-translation is the exact zero-energy mode; r-translation and the in-plane rotation are low-energy away from the axis since e_phiphi = u_r / r; documented), P2 cells through the same two-level path as planar elasticity. Keep it only if `solver: amg-pcg` on tsv-stress-axisym needs fewer iterations than the scalar AMG (measured), else keep the scalar one and state it in the code comment.
4. Singular AMG (minor). Dense coarse Cholesky counts pivots <= 1e-10 x their original diagonal; any such pivot -> `buildAMGSA` throws an under-constrained message ("coarse operator singular ...: rigid-body motion not suppressed?"); SpdSolver rethrows it like the direct path. Test: free-floating 2D block with balanced tractions, direct and amg-pcg both throw.
5. PCG residual note (minor). `withStudySolver` adds a note for every AMG-PCG record whose achieved residual exceeds its rtol (accepted up to 10 x rtol), with and without a study setting; `run.solver.residual` unchanged.
6. Material T on T-independent leaves (minor). In `prepare.ts`, a library property is first evaluated without T: when it does not depend on T, that value is used and, if the material / run temperature lies outside the leaf's stated T validity, a note says so; only T-dependent leaves get T (unchanged path, errors as before). Same for the dispersion helpers. dndT: note when the thermo-optic Tref differs from the material T.
7. Resonance (minor). Sample points clamped to the window and to x > 0 (refinement half-span min(g, distance to the window edges)); half-maximum crossings outside the window are an error; 'dip': error when the refinement fit residual exceeds `DIP_FIT_RESIDUAL_MAX` (value and basis in s.4).
8. Queued: `evalGlobal` `step` option (DevLog-061 R1), adapter `step` and one row per step for global-only tables on multi-frequency solutions (R2); eigen-check notes in acoustics, em-axisym (nullDim = number of projected gradient unknowns nH; derivation s.4), optomech.
9. Labels: WO-73 targets against the earlier scripted scan keep `form: solver_ref` (no regression form in the schema) with the note "regression check against the same engine"; WO-74 title names the gated items; tantalum-film Deng, Ma, Jiang -> J. Appl. Phys. 140, 115101 (2026). Rebuild only the changed case files.

### 1.3 Gates
All package tests and `pnpm -r check` green; class-a CLI 16 / 0 / 13 with targets bitwise vs `logs/eval-20261118T194309.jsonl` except documented; CLI PK-01..11, WO-73, WO-74, CP-21 one at a time; peak RSS per heavy run (`/usr/bin/time -l`) <= 2 GB.

## 2. TODO
- [x] 1 eigen window check + test (repro detected; passing results bitwise)
- [x] 2 cellGroup (spec field, elastic / axisym producers, post recovery) + tests
- [x] 3 axisym AMG hook + iteration comparison
- [x] 4 singular AMG detection + test
- [x] 5 PCG residual note + test
- [x] 6 T-independent leaves + Tref note + test
- [x] 7 resonance clamp + dip gate + test
- [x] 8 evalGlobal step, adapter, eigen-check notes + tests
- [x] 9 WO-73 / WO-74 labels, tantalum citation, case rebuild
- [x] gates: tests, check, class a, PK-01..11, WO-73, WO-74, CP-21 with RSS

## 3. Progress log
- 2026-11-18 20:00 PST: plan written; class-c run in progress (no edits under packages / apps / validation / materials until it ends).
- 2026-11-18 20:01 PST: class-c run finished (no `cli.ts --class` process); edits start.
- 2026-11-18 20:23 PST: items 1-5 coded with tests. (1) window check: eig-gap.ts now 'missed' for hidden 3rd / 5th / 6th nearest at both shifts; eigen sims off vs auto bitwise (box-acoustics, cylinder-cavity-axisym, gaas-microdisk-om, ln-fbar-2d, membrane-air, pzt4-cube, wr90-te-cutoffs, phc-point-defect, bragg-edge-lower; `logs/fx3-eigsims-*.log`, 1.81 GB peak). (2) cellGroup in spec / elastic / axisym / post + post test. (3) axisym AMG hook: tsv-stress-axisym AMG-PCG iterations 84 / 171 / 338 (scalar AMG) -> 17 / 20 / 24 at hFactor 1 / 0.5 / 0.25 (1,627 / 6,455 / 25,711 DOF), max |srr| equal to direct within 2e-11 relative. (4) singular coarse pivots: threshold 1e-10 (s.4). (5) PCG note.
- 2026-11-18 20:28 PST: items 6-9 coded with tests (prepare T-independent leaves; resonance clamp + dip gate 3e-3; evalGlobal step + adapter rows + web test; WO-73 / WO-74 labels; tantalum citation verified on the arXiv abstract page 2026-11-18). Class-c rebuild to scratch: only WO-73.yaml, WO-74.yaml changed (labels only), copied back; test_build_matches ok (66 compared, 0 differing). Next: package tests, check, CLI gates.

## 4. Decisions, measurements and bases

- D1 (eigen window, item 1): the check now tests the nearest-nWant property directly (s.1.2 design 1); `WINDOW_EPS` 1e-6 of D, `WINDOW_ABS` 1e-9 of max |lambda| (round-off guard of the outermost Rayleigh quotient). Retries are verified on the kept subset. Factor count per check unchanged (at most one LDL^T per side; none below a Cholesky shift). F: repro (1D Laplacian n 120, nWant 6) hidden 3rd / 5th / 6th nearest: 'missed' at sigma -0.01 and 0.0856 (before: 5th / 6th 'pass' at 0.0856). F: 9 eigen sims bitwise check off vs auto, statuses pass / skipped (perturbed pivots: cylinder-cavity-axisym, the optical part of gaas-microdisk-om; nnzL above the auto limit: ln-fbar-2d, pzt4-cube).
- D2 (em-axisym nullDim, item 8): nullDim = nH, the number of scalar unknowns of the discrete gradient G. G has full column rank (G^T M G is factored by Cholesky just before), so range(G), the space the projector removes, has dimension nH; these are zero eigenvalues of K (m >= 1: e_t = -grad(w) / m, w: q = m e_t + grad w = 0 and curl_t e_t = 0; m = 0: e_t = grad(psi), w = 0). Static fields not in range(G) (m = 0: w = const off the axis, potentials constant on separate PEC parts) stay in the Krylov space and are counted as found when computed. F: on cylinder-cavity-axisym the check is skipped anyway (perturbed pivots at the shift), so its results are unchanged.
- D3 (cellGroup, item 2): group = equal (E, nu, alpha when thermally coupled) per cell, numbered by first appearance; -1 outside the physics. Keyed on constants rather than material nodes: two material nodes with equal constants (e.g. two silicon layers) are one continuous medium for the stress. A cellGroup that is absent, of the wrong length or -1 on a cell with element values falls back to cells.domain.
- D4 (axisym AMG, item 3): kept the rigid-body near-nullspace (iterations 17 / 20 / 24 vs 84 / 171 / 338 scalar AMG at hFactor 1 / 0.5 / 0.25, DOF 1,627 / 6,455 / 25,711; max |srr| vs direct within 2e-11 relative at hF 1; scratch `axi-amg2.ts`).
- D5 (singular AMG, item 4): `SINGULAR_PIVOT_RATIO` 1e-10 (pivot / original diagonal on the dense coarsest level). Measured (scratch `piv.ts`, 2026-11-18): floating bodies give exactly as many small pivots as free rigid modes (2D tri3 / tri6: 3, roller-only 2D: 1, 3D tet4: 6) with ratios -1.1e-9 .. 2.7e-13 (negative or <= 2.7e-13); constrained bodies give ratios >= 1.6e-6 (2D tri6 beam 200:1 with a 1000x stiffness contrast; 5.5e-4 for 20:1; 3D tet10 cantilever 1.5e-3). Limits: a coarsest level above 3000 unknowns (Gauss-Seidel, no factor) is not tested; a structure much more slender than 200:1 lowers the constrained ratio roughly as (t / L)^2 (E, from the two beam cases). `buildAMGSA({singular: 'allow'})` keeps the former behaviour.
- D6 (PCG note, item 5): every AMG-PCG record with residual > rtol (accepted up to `PCG_ACCEPT_FACTOR` 10) adds one note, with or without a study setting; eigen studies and SpdSolvers outside `withStudySolver` have no record, so no note.
- D7 (material T, item 6): a library property is evaluated without T first; success = T-independent leaf, used as-is, note when T is outside its stated `valid.T` (e.g. "materials.Si (materials/silicon).n: the library value does not depend on temperature and is stated for T = 293 K; used as-is at the material temperature 298.15 K"); failure -> the former call with T (values and errors unchanged). Applied to the main property loop and the dn/dlambda, dkappa/dlambda helpers. dndT: note when the thermo-optic Tref differs from the material / run T. The library itself still rejects `getProperty('silicon', 'n', {T: 298.15})` (packages/materials not owned; R3).
- D8 (resonance, item 7): samples clamped to [max(lo, 1e-12 hi), hi]; refinement half-span min(g, x0 - lo, hi - x0); x0 +- 1.1 g outside the window and half-maximum crossings at or beyond the window are errors. Dip gate `DIP_FIT_RESIDUAL_MAX` 3e-3: measured residual / FWHM error per baseline offset (offset / depth): 0.01 -> 1.30e-3 / 1.1 %, 0.02 -> 2.64e-3 / 2.3 %, 0.04 -> 5.41e-3 / 4.6 %, 0.1 -> 1.47e-2 / 12 % (test in `packages/eval/test/resonance.test.ts`); the WO-73 peaks show 0.9e-3 .. 1.2e-3 (`logs/eval-20261118T185253.jsonl`). So a dip passes only when the baseline is within about 2 % of the dip depth (FWHM error below about 2.5 %).
- D9 (labels, item 9): the schema form enum has no regression form; WO-73 targets against the earlier scan keep `solver_ref` with the note prefix "regression check against the same engine (earlier scripted scan of this model, not an independent reference)". WO-74 title: "... port mode index and power balance gated; upward power vs Taillaert Fig. 3 at 1500-1650 nm informative". Tantalum: Deng, Ma, Jiang, J. Appl. Phys. 140, 115101 (2026), doi 10.1063/5.0341686, checked on arxiv.org/abs/2609.17990 (journal-ref and related DOI fields) 2026-11-18.

## 6. Requests (coordinator routes)

- R1 (web post display, `apps/web/src/lib/post/field2d.ts`, `probe.ts`, `apps/web/src/lib/gfx/Graphics.svelte`; not owned here): the display copy of the recovery rule still keys on the triangle domain. (a) `Field2D` gains `cellGroup?: Int32Array`; in `withPerDomain` use `const dom = f.cellGroup && f.cellGroup.length === nT && f.cellGroup.every((g, t) => g >= 0 || !active[t]) ? f.cellGroup : m.domain;` after `active` is filled (same rule as `@amp/post recoveryGroups`). (b) Pass it through: `probe.ts:37` and `Graphics.svelte postField` add `...(f.cellGroup ? { cellGroup: f.cellGroup } : {})` next to `elementNodal`; the display-field builder that sets `elementNodal` on Field2D sets `cellGroup` the same way. (c) `apps/web/test/g2-interface-display.test.ts`: one case with a cellGroup of all zeros on a two-domain mesh -> `withPerDomain` returns the field unchanged, equal to `recoverPerDomain` (null).
- R2 (CONTRACTS-v0 changelog): text in s.7.
- R3 (materials owner, optional): `@amp/materials getProperty` applies the `valid.T` check to leaves that do not depend on T (Si / Ge n, Si E); prepareRun now avoids it (D7), direct library callers still get the range error.
- R4 (optomech ownership): the eigen-check note for the solid modes is set in `packages/physics/src/optomech/axisym.ts` (`SolidModes.checkNote`, 3 lines) and pushed in `couplings/optomech.ts`; the brief named the coupling file only.

## 7. CONTRACTS changelog text (R2)

"2026-11-18 (DevLog-066): C5 FieldData gains optional `cellGroup?: Int32Array` (derived fields with `elementNodal`): constitutive group per cell, equal values = same material constants, -1 outside the physics. @amp/post recovers derived fields per group at interface nodes and falls back to `cells.domain` when it is absent (additive; elastic and axisymmetric elastic producers fill it). @amp/post `evalGlobal(sol, expr, {step})`: on a frequency study with several frequencies `<name>_<step>` is resolved first (DevLog-061 R1)."

## 5. Results (gates)

- `pnpm -r check`: 0 errors (logs/fx3-check-20261118T2*.log). Package tests (logs/fx3-test-*-20261118T202828.log, physics rerun logs/fx3-test-physics2-*.log): core 103, spec 65, materials 38, geom 58, mesh 30, physics 215, post 23, eval 102, rt 16, agent 78, web 148: all pass. One physics failure on the first run (`coupling.test.ts` R1b / R1c: its fake library accepted dndT without T, so D7 treated it as T-independent); the fake now reports dndT as T-dependent like the real library and the test reads the last call; green on the rerun.
- Class a CLI (`logs/eval-20261118T203320.jsonl`): 16 pass / 0 fail / 13 pending; 136 targets bitwise vs `logs/eval-20261118T194309.jsonl`; peak RSS 1.08 GB.
- One case at a time (bitwise vs `logs/eval-20261118T194415.jsonl`, CP-21 vs `logs/eval-20261118T194309.jsonl`; all pass, 0 differing targets):

| Case | targets same | peak RSS | wall |
|---|---|---|---|
| PK-01 | 5 | 0.32 GB | 1.3 s |
| PK-02 | 8 | 1.77 GB | 15.1 s |
| PK-03 | 3 | 0.71 GB | 3.6 s |
| PK-04 | 3 | 0.88 GB | 4.0 s |
| PK-05 | 4 | 1.69 GB | 22.6 s |
| PK-06 | 3 | 1.23 GB | 7.0 s |
| PK-07 | 6 | 0.79 GB | 5.9 s |
| PK-08 | 3 | 0.40 GB | 2.0 s |
| PK-09 | 5 | 0.45 GB | 3.6 s |
| PK-10 | 9 | 1.59 GB | 33.6 s |
| PK-11 | 6 | 1.28 GB | 9.1 s |
| CP-21 | 2 | 0.53 GB | 4.2 s |
| WO-74 | 14 | 1.95 GB | 71.5 s |
| WO-73 | 34 | 1.54 GB | 307.3 s |

- F: no elastic sim in `sims/` assigns one material to several domains, so cellGroup changes no current result (PK-02 / CP-21 bitwise, as required); the same-material case is covered by the post test (two domains, equal constants: recovered = averaged bitwise; distinct constants: bitwise the domain-keyed recovery).

## 8. Open items

- O1: web display path still keys on domains (R1).
- O2: the physics test suite's largest test process peaks at 3.12 GB RSS (`logs/fx3-test-physics2-*.log`); not from the files touched here (fx3-engine 0.26 GB, g3-solver-3 0.33 GB, coupling 0.35 GB measured alone); which file it is was not isolated.
- O3: the eigen check is still skipped when the LDL^T at the shift perturbs pivots (cylinder-cavity-axisym, optical modes of gaas-microdisk-om) and above the auto nnzL limit (ln-fbar-2d, pzt4-cube); skipped checks give no note.
- O4: singular detection only on a dense coarsest level (<= 3000 unknowns); structures far more slender than 200:1 approach the 1e-10 ratio (D5).
- O5: `@amp/materials getProperty` still rejects T on T-independent leaves for direct callers (R3).
- 2026-11-18 20:46 PST: done; hand-off.
