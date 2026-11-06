# R2: advanced-packaging-atlas sim engine and UI survey (reuse, extract, redesign)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | R2 (read-only survey) |
| Subject repo | advanced-packaging-atlas (APA): `engine/`, `sims/`, `validation/`, `app/src/{routes/sim,lib/sim,lib/three}`, DevLogs 010, 012, 013, 014, 018, lanes |
| Compared with | eo-modulator-atlas (EO) at HEAD 0546007 (2026-11-03); APA port base eb97f96 (2026-10-20) |
| Method | Read headers, exports, DevLogs, SPEC, ledgers; `wc -l`; read-only `diff` and `git log` on EO. No builds, tests or runs. |
| Context | applied-multiphysics DevLog-000 (2026-09-28) predates this work; it chose Palace + MOOSE desktop backends and a Pydantic spec. |

Convention: **F** = fact read in a file (path:line where useful). **I** = my inference. Numbers are copied from the
cited file; none were re-measured.

## 1. Engine module map

Totals (F, `wc -l`): `engine/src` 34,774 lines (34,560 in .mjs), 41 test files (6,912 lines, ~272 top-level `test(`
calls; last recorded full suite 330/330 in 245-257 s, DevLog-013:353, DevLog-014:150). Only runtime dependency: `yaml`
(engine/package.json). Same code runs in a Web Worker and Node (engine/README.md:3-6).

| Module | LOC | Purpose | Numerics | Internal deps | Tests (files) | Scope |
|---|---|---|---|---|---|---|
| `la/` | 4,945 | Sparse and structured linear algebra | CSR patterns; own AMD + coordinate ND orderings; supernodal multifrontal Cholesky; LDL^T real/complex supernodal (quasi-definite, no pivoting); 27-point scalar and 3x3-block stencils; GMG with x-y semi-coarsening, z-line GS (4-colour), Galerkin RAP, Cholesky coarse; half-stencil block MG (low memory); PCG; runtime WASM encoder + f64x2 SIMD kernels (`la/wasm/`) | none | la-sparse, la-ldlt, la-mg, la-block, la-halfmg, la-wasm, la-params | Generic (stencil/MG parts: generic for tensor grids) |
| `params/` | 531 | Safe expression evaluator, SI units/dimensions | recursive-descent parser, no eval; 5-dim unit vectors (K added) | none | la-params | Generic |
| `grid/` | 712 | Rectilinear grid aligned to every box face; part/material cell maps; named exterior-face selections; quarter/half symmetry crops with mirror check | graded 1D spacing by size-field equidistribution, snapping | none | grid | Generic for box-part models (input = SPEC box list) |
| `thermal/` | 2,430 | Steady + transient conduction; also hosts the **case parser for all physics** (`case.mjs`, 1,114 lines) | Q1 hex exact separable element; Robin/flux/Dirichlet/contact resistance/source patch/T-field BCs; full-tensor k; Picard for k(T); BE/CN theta scheme; closed forms `analytic.mjs` | grid, la, params | thermal-tierA, thermal-verify, thermal-wave2, cli, cli-l10 | Solver generic; `case.mjs` packaging-coupled |
| `mech/` | 4,255 | Linear thermo-elasticity, process sequence, rate-form E(T) sweep, total-Lagrangian nonlinear, viscoelastic skeleton, warpage post | q1 / q1im (Wilson incompatible modes, condensed; default) / q2s 20-node; iso/ortho/cubic + rotations; direct Cholesky, PCG + Jacobi/block-Jacobi/GMG/p-MG; low-mem half-stencil f64 + f32 MG; DOF-dropping activation; Prony + WLF/Arrhenius (Simo-Hughes); JEITA ED-7306 warpage, coplanarity, curvature fits, singular-corner flags | grid, la, homog, thermal (case parser) | mech-core, mech-tierA, mech-case, mech-nl, mech-nl-l27, mech-process, mech-ve | Solver generic; `post.mjs` warpage and `case.mjs` packaging-flavoured |
| `homog/` | 1,282 | Effective properties of bump/TSV/RDL fields | periodic RVE FE on box cells (6 load cases + thermal), exact Backus laminate, thin-layer merge rule, precomputed table with constituent fingerprints | la, materials, mech | homog-rve, homog-overrides, homog-table-l27 | RVE/laminate generic; key grammar and table packaging-specific |
| `materials/` | 1,959 (+ 2,377 lines YAML in `engine/data/materials/`) | Sourced library: schema `ap-sim.materials/1`, loader, evaluators, secant-CTE rebase, cubic Si, ROM homogenization, case overrides, aliases | unit conversion at load; CTE re-base closed form; hold-last extrapolation flags | params, homog (Node only, injected) | materials, materials-l21, -l27, -overrides | Code generic; data cites APA DB paper ids |
| `families/` | 7,772 (of which ~4,870 generated `specs/*.mjs`) | 12 package-family generators (CoWoS-S/L/R, EMIB-T, FCBGA, InFO_oS, HBM, SoIC, glass core, fan-out panel, CPO, Si-IF), presets, constraint rules, bounds, transcriber from `config/package3d` | expression grammar with Python semantics (`expr.mjs`) | none (reads package3d.json) | families, families_cases | Packaging-specific |
| `runner/` | 372 | Template-basis sensitivity runner, labelled variants | reruns at sensitivity bounds | families, materials, mech, thermal | runner | Generic idea, packaging wiring |
| `em2d/` | 5,546 (incl. 1,125 vendored robust-predicates) | 2D cross-section multiconductor RLGC(f), MTL, Touchstone | own constrained Delaunay + quality refinement (ported); P1/P2 Lagrange; volumetric lossy conductors; Djordjevic-Sarkar / causal_fit / table dielectrics; Hammerstad/Huray/cannonball roughness; modal MTL, mixed-mode, passivity; small dense complex LA; blocked and WASM-SIMD complex LDL^T front update (`ldlt-blocked`, `ldlt-wasm`, `ldlt-select`) | la | em2d-em0/em1/em2/mtl/wasm | Generic (interconnect EM) |
| `em3d/` | 4,756 (+ Apache LICENSE, NOTICE) | Frequency-domain 3D FEM for discontinuity blocks | layered 2.5D mesh (em2d triangulation extruded, prism -> 3 tets); hierarchical Nedelec order 1-2 + H1 (exact barycentric integration); PEC/PMC/IBC/thin-conductor BC; stretched-coordinate PML; wave ports (quasi-TEM multi-mode, TE10, full-wave Lee-Sun-Cendes port eigenmode) via Woodbury; lumped ports; direct complex LDL^T; GMRES + 2-level p-MG with Hiptmair GS; PROM adaptive sweep (MRI greedy); Redheffer cascade; line-run de-embedding; SA-AMG + AMS written but **not wired** | em2d (24 imports), la | em3d, em3d-ports, em3d-deembed, em3d-p2, em3d-em4, em3d-em5 | Generic except the layered-mesh restriction |
| `cli.mjs` | 309 | Node CLI over all studies | - | all | cli, cli-l10 | Generic shape, packaging wiring |
| `bench/` | 2 files | Thermal bench (direct vs PCG+MG), G1 WASM gate bench | JSONL to `logs/bench-*.jsonl`, `logs/g1-*.jsonl` | grid, thermal, la | - | Generic |

Facts on structure:
- F: dependency graph (import counts): thermal -> grid/la/params; mech -> grid/la/homog/thermal; homog -> la/materials/mech; em3d -> em2d/la. `la`, `params`, `grid`, `families` import nothing internal.
- F: thermal and mechanics operate only on axis-aligned boxes snapped to a rectilinear grid (SPEC 2-3; DevLog-010:47). Cylinders (bumps, TSVs) exist only inside RVE cells or em3d solids.
- F: em3d meshes only layered extrusions (DevLog-014:76-78, D8: no AMR because the extrusion structure is load-bearing).
- I: the case parser living in `thermal/case.mjs` (imported by `mech/case.mjs:10`) is lane history, not design; it is the main coupling point to untangle when extracting.
- I: `em2d/dense.mjs` and the three `em2d/ldlt-*.mjs` files are general LA placed in em2d because of lane write scopes (header of `ldlt-blocked.mjs`: "proposed upstream to lane L1").

## 2. Overlap with eo-modulator-atlas

Engine files with "Ported from eo-modulator-atlas ... at eb97f96" headers, diffed against EO HEAD (F):

| APA file | EO file | diff lines (APA / EO side) | State |
|---|---|---|---|
| `la/sparse.mjs` | `engine/src/sparse.mjs` | 2 / 0 | identical except the 2-line port header |
| `la/ldlt.mjs` | `ldlt.mjs` | 2 / 0 | identical |
| `la/complex.mjs` | `complex.mjs` | 2 / 0 | identical |
| `params/params.mjs`, `params.d.mts` | `params.mjs`, `params.d.mts` | 2 / 0 each | identical |
| `em2d/geometry.mjs` | `geometry.mjs` | 2 / 0 | identical |
| `em2d/mesh.mjs` | `mesh.mjs` | 4 / 2 | predicates import path only |
| `params/units.mjs` | `postproc/units.mjs` | 17 / 7 | superset: 5th dimension K, ppm, thermal named forms; EO 4-vectors still valid |
| `em2d/fe.mjs` | `fem.mjs` | 127 / 248 | partial port (p2Space, p2Grad, restrictMatrix) plus P1, mass, load, per-tag assembly |
| `em2d/_port/robust-predicates.mjs` | npm `robust-predicates` 3.0.3 | - | vendored (Unlicense); header says replace with npm dep later |

- F: EO has 2 commits after eb97f96; none touches the ported engine files (`git log eb97f96..HEAD -- <files>` empty). So the divergence is entirely APA-side additions, not drift.
- F: Not ported, re-implemented: EO full-wave port eigenmode "re-implemented from the EO DevLog-025 formulation, with no EO code copied" (DevLog-012:282); WASM encoder is new ("EO's encoder was a scratchpad script", L1 notes:435). New in APA with no EO counterpart: stencil LA, GMG, block/half MG, WASM kernels, blocked/WASM complex LDL^T, grid, thermal, mech, homog, materials, families, em2d RLGC/MTL, em3d.
- F: DevLog-010:77 (A1): "Extract a shared package later, once at least 5 modules are identical in both repos." I: that threshold is met (sparse, ldlt, complex, params, geometry identical; mesh near-identical).
- F: UI files with EO port/pattern headers: 24 in `app/src/lib/sim`. Diff vs EO `app/src/lib/sim` (same names): near-verbatim (<= 5 lines) `colorbar.ts`, `ticks.ts`, `Splitter.svelte`, `LinePlot.svelte`, `exportUtil.ts`, `Icon.svelte`; light changes `colormap.ts` (59 vs 82 lines, trimmed), `pool.ts`, `urlState.ts`, `units.ts`, `sweepValues.ts`, `Field.svelte`, `BottomPanel.svelte`; heavy rewrite `workbench.svelte.ts` (644 vs 909), `ModelTree.svelte` (211 vs 379), `Settings.svelte` (309 vs 467), `fieldmath.ts` (53 vs 224). `yamlSplice.ts` = TS conversion of EO `engine/src/yaml-edit.mjs`, "no functional change".
- F: "Adapted from awslabs/palace ... at 29ad351f (Apache-2.0)" headers: `em3d/krylov.mjs` (GMRES), `em3d/pmg.mjs` (p-MG, Hiptmair relaxation), `em3d/lumped.mjs`, `em3d/prom.mjs` (adaptive sweep), `em3d/ams.mjs`; `em3d/NOTICE` lists them, `em3d/LICENSE-APACHE-2.0` verbatim. No Palace source text copied; algorithms re-implemented in JS (DevLog-014:39-51).

## 3. Config / spec model (`sims/SPEC.md`, v0.25, 541 lines)

F, structure (SPEC.md:9-50):
- Case `schema: ap-sim/0`, `id` = path under `sims/`, `status` (`unvalidated | verified | validated | measured_regression | draft`, plus `untestable` SPEC 16), `family` (generator), `params` (value, `"=expr"`, or `{value, status, ref|note}`), `geometry` (`symmetry`, `drop_kinds`, `resolve` = arrays kept discrete), `materials` (`map` part id > part kind > template key -> library key; `overrides` per field with provenance), `mesh` (`max_xy_mm`, `min_cells_per_layer`, `grading`, `max_nodes` hard budget, "never a silent coarsening"), `physics.thermal` (sources, BCs on named selections), `physics.mechanics` (element, stress-free T default/per part, supports `rigid_motion` xor `symmetry`, rtol), `studies` (list: `thermal_stationary`, `thermal_transient`, `thermo_elastic`, `thermo_elastic_sweep`, `process_sequence`; study-level `params`/overrides), `targets` (keyed by DB `metric_id`, quantity, selection, definition, tolerance `{rel}|{abs_C}|{sign_only}`, tier), `assumptions`, `missing`.
- Rule (SPEC.md:52-53): unknown key = error; every number not from a family default or library must carry provenance. Enforced in JS (`thermal/case.mjs:51`, `:245`); there is no JSON Schema or other machine-readable schema file (grep found none).
- Selections: `top: bottom: side: xmin:...:<part>` with globs, `default`, `sym:x|y`, `interface:<a>/<b>`, `part:<glob>`, `corner:<part>`, `bottom:model` (SPEC 7, 10, 15).
- Process steps (`mech/process.mjs` header; `sims/si_interposer_peers/120mm_warpage.yaml:110-120`): `{id, activate, deactivate, stress_free_C, temperature: {uniform_C}, supports?, materials: {map}}`; activation by DOF dropping, stress-free restart on material switch.
- EM cases are separate schemas: `family: em2d` (SPEC 9: section box/BCs, dielectrics, conductors with shapes and roughness, materials models, sweep, lines, mixed-mode pairs, variants) and `family: em3d` (SPEC 14, 14.1-14.6: box, axis, solids painter order, ports wave/lumped, PML, mesh, `max_dof` guard, order, solver, adaptive).
- Variants: `{id, title, patch}` deep merge, `null` deletes, keyed by name (SPEC 9, 14); labelled variant files in `sims/<family>/variants/` with basis `calibration | sensitivity | diagnostic` (SPEC 24).
- Provenance axes (DevLog-010:97-103, A11): geometry `reported | derived | public | template | user` ("status never upgrades", `families/params.mjs` header); material `basis` (`datasheet | handbook | measured | paper_model_input | derived | template | case_override | sensitivity`), with `source + locator + verified_on`; case `validation_status`; results carry `engine_version` (src/data/package3d/metrics hashes, dirty flag) and `convergence` records (SPEC 19), `homogenization_record` (SPEC 20).
- Contract growth: 25 numbered additive sections between 2026-10-20 and 2026-10-22 (sections out of order: 14.x after 15/16), all recorded in DevLog-012 "Contract changes".
- Corpus: 37 case YAMLs across 13 dirs, 2,442 lines (`sims/*/*.yaml`).

I, fitness as a general typed spec edited by GUI and agent:
- Good and portable: strict unknown-key policy; `{value, status, ref}` provenance objects anywhere a number goes; `assumptions` / `missing` lists; study list with per-study overrides; process-step model; variants as patches; targets with tolerance forms and tiers; engine stamp on results; unit-suffixed keys.
- Not general: geometry is "family generator + params" (no explicit geometry entities, no persistent IDs, selections are part-name globs on box faces); physics blocks are hard-coded per physics; EM uses two disjoint schemas; targets are coupled to the APA DB (`metric_id`, `data/metrics.csv`); the schema exists only as prose plus JS validators, so GUI forms cannot be generated from it.
- The GUI edits the same YAML via comment-preserving splices (`yamlSplice.ts`), so GUI and agent share one text source of truth; that pattern matches applied-multiphysics D3 (direct edits) but there is no rollback history (see 7).

## 4. Performance

F, measured (Node 23.7 on the dev Mac unless "browser"):

| Workload | Size | Time | Memory | Source |
|---|---|---|---|---|
| Thermal bench PCG+MG vs direct | 2.7e5 nodes | 518 ms (13 it) vs direct 15.5 s | - | DevLog-012:63 |
| cowos_r thermal_rjc s1 | 1.6e5 nodes | 5.7 s CLI; 3.4-4.7 s browser | - | DevLog-012:141, 190 |
| Largest browser thermal solve | 1.12e6 nodes | 17.9 s | - | DevLog-012:192 |
| cowos_l thermal s1 | 5.2e5 nodes | 12.6 s, 114 it | - | DevLog-012:205 |
| Mechanics MG vs direct | 1e5 DOF | 3.0 s vs 14.8 s / 1.35 GB | - | DevLog-012:226 |
| Mechanics MG | 3e5 DOF | 6.3 s | 678 MB | DevLog-012:226 |
| M1 cowos_l warpage (browser, rtol 1e-7) | 1.08e6 DOF, q1im | s2 106 s, s3 226 s | 1.29 / 1.535 GiB (target 1.5 GB) | RESULTS.md:99-104 |
| emib_t bridge_stress s2 | 1.49e6 DOF | 1,116 s, 498-532 it | 1.97 GB Node | DevLog-013:218 |
| em2d sweep (P2, 47k triangles) | 54 freqs | 17 s -> 14.6 s (blocked LDL^T) | - | DevLog-012:88, 328 |
| EM-4 order 1 direct | 59.5k DOF | 16.0 -> 8.5 s/f (blocked) -> 4.3 s/f (WASM) | 1.50-1.57 GB | DevLog-012:328, 336; L13 notes:88-143 |
| EM-4 order 1 | 97.4k DOF | 173.6 s / 4 f | 2.24 GB | DevLog-014:25 |
| EM-4 order 2 GMRES + p-MG | 145k DOF (+58k companions) | 19-20 s device + 11.5 s companions per f | 2.22 GB (fails G7) | DevLog-014:166 |
| EM-4 order 2 device only | 291k DOF | 36.5 s/f | 1.25-1.59 GB | DevLog-014:166 |
| PROM adaptive sweep, EM-4 | 21 pts 1-100 GHz | 58.2 s vs 270.3 s HDM (4.6x), max dS 1.65e-10 | - | DevLog-014:168 |
| Engine suite | 330 tests | 245-257 s | peak RSS 1.08 GB (290-test run) | DevLog-013:353; L13 notes:127 |

Limits and budgets (F):
- Direct factor scaling on hex grids: fill ~n^1.375, work ~n^2.01; direct practical to ~2e5 heat nodes / ~1e5 elasticity DOF (DevLog-010:49, R2).
- Browser direct 3D EM budget ~6e4 DOF (0.38-0.75 GB factor, 23-68 s/f in JS); audit corrected an earlier "2e5 fits" claim (DevLog-010:61, 207).
- Browser memory target <= 1.5 GB per worker; single worker, no threads, because SharedArrayBuffer needs COOP/COEP that GitHub Pages cannot set (DevLog-014:71-73).
- q1im + GMG converges slowly on real packages: 100-300 iterations typical, 1,146 at cowos_s s2h, 3,000-iteration cap hit at cowos_s 25 C (RESULTS.md:83-85); root cause: softer q1im bending spectrum under z-line smoothing, not coarse locking; non-locking coarse spaces tried and failed (DevLog-012:438-450).
- GMRES + p-MG stalls on needle cells (microstrip axis x: no convergence in 400) (DevLog-014:164, 179-182).
- Layered em3d mesher grows DOF multiplicatively; EM-5a 2 % port-Z gate needs ~1M order-2 DOF (DevLog-014:185-188).

Accelerator gates (DevLog-010:91-95, A9):

| Gate | Rule | Outcome |
|---|---|---|
| G1 WASM SIMD | adopt at > 2x end-to-end | Failed. Thermal end-to-end 1.37-1.43x (kernels 2.6-3.4x, setup dominates); block elasticity 1.02x; complex LDL^T front update 1.82x (EM-4), em2d 1.27x. All opt-in (`--wasm`, `factor: 'wasm'`). (DevLog-012:336, 359; `logs/g1-20261020T1501.jsonl`) |
| G2 WebGPU (f32 MG in f64 refinement, >= 5x on 2 GPUs) | - | Never attempted (no lane notes found). |
| G3 threads via coi-serviceworker | - | Not done; DevLog-014 chose single-worker design. |

Load performance (DevLog-018, app only, 2026-11-03):
- F: requirement "Any tab ... starts showing within 100 ms (10 ms preferred)" (DevLog-018:11-12).
- F: /sim route shell cut from 337 KB to 2.7 KB, workbench lazy-loaded after mount (DevLog-018:65); sim worker split earlier into 129 kB entry + 31 lazy chunks (DevLog-012:655); prerendered HTML, service worker with per-prefix cache, preload links from the build manifest.
- F: live result: tab click to paint 5-67 ms (median 10); first-visit first paint 160-324 ms (network bound, not met); first /sim with a real run 34 requests, 1.6 MB raw (DevLog-018:124, 194-201).

## 5. Validation

F, structure (`validation/README.md:7-28, 41-49`):
- 62 case files: A 17 (TA1-TA6 thermal, MA1-MA9 + MA5b mechanical, em_0_analytic) + shared `_materials_tier_a.yaml`; B 6 (NAFEMS LE1, LE10, LE11, T1, T3, T4); C 8 paper-simulated (incl. em_3); D 8 paper-measured (incl. em_1, em_2); H 23 cross-paper trend rules (H01-H23).
- Tier tolerances: A rel 1e-3 global / 1e-2 point stress; B rel 1e-2 after refinement; C warpage max(10 um, 10 %), thermal 5 %; D warpage sign, +-20 C, max(20 um, 25 %), thermal 10 %; H rule pass/fail (`range`, `ratio_range`, `order_of_magnitude`, `monotonic`, `direction`, `sign_flip`, `rank_order`, `range_by_class`) with `fails_if`, `strength` weak/moderate, `support` rows copied from the DB.
- Tier H was Wentao's addition (DevLog-010:174-180).
- Status transitions only by a logged run; `untestable` needs `untestable_reason` + `activation`; sign gates need `requires_shape_class: [dome, bowl]` (README:75-90; SPEC 16).

Storage of expected values (F):
- YAML `expected` rows `{variant, quantity, definition, value, unit, tolerance, script_key}`; `script_key` points into JSON generated by stdlib Python scripts (`expected/tier_a.py -> tier_a_values.json`, `tier_b.py`, `em0.py`, `implied_tsf.py`).
- `form: reference_fe` rows point into L5 reference outputs `{file, path, field}` under `validation/reference/results/*.json` (34 JSON files) with `gci` and `diff_vs_closed_form` (e.g. `cases/A/MA4-clt-multilayer.yaml`).
- `check_db_targets.py` re-checks every case value against `data/*.csv`, script JSON and reference JSON: 0 errors over 369 DB, 92 script, 23 reference values (DevLog-013:352).
- `validation/RESULTS.md` is a hand-maintained ledger (verdicts pass / miss / untestable / indeterminate / calibration / superseded / no target), runs stamped with engine src/data hashes, all "dirty".

Reference solvers actually used (F): `validation/reference/` uv project (Python 3.12, GPL-3.0-or-later): scikit-fem (Q1/Q2s thermal and thermo-elastic, lowest-order Nedelec, total-Lagrangian plate), NGSolve 6.2 (LGPL; higher-order Nedelec for EM-4/EM-5a), gmsh, scipy, scikit-rf, pyamg, qdldl. Palace: cloned at 29ad351f as an algorithm reference only, never built (Wentao: "no Palace", DevLog-013:71). openEMS, CalculiX: planned, not used. COMSOL: no run recorded in the files read; the COMSOL-273-style process gate was checked against lamination superposition (DevLog-012:349).

Status (F, RESULTS.md, latest rows):

| Area | Pass | Miss / indeterminate / untestable |
|---|---|---|
| Verification (A/B) | Engine Q1 = scikit-fem Q1 node by node <= 1.1e-10 K; q2s = Q2s to 1e-13..1.6e-8 (u), 8-9 digits (stress); CLT through CLI path within 0.05 %; PLATE-NL bifurcation -32.00 K vs -31.998 K, path equal to 2.7e-8 | 6 coarse-level thermal rows outside 1e-3 (discretization) |
| Thermal C/D | cowos_r Rjc vs paper zero-contact model +4.3 %; Tj rise -6.5 % (val case band); info_os TIM A -3 % | cowos_r Rjc vs measured -26.7 % (TIM contact resistance undisclosed); info_os TIM B/C/D -27..-46 % |
| Mechanics C/D | xilinx no-lid +341.2 vs +335.3 um (plausibility only); fcbga and glass sign at 25/225 C; 120 mm Cu-ring trend; cowos_l s3 coplanarity at 225 C; ring48x RT/HT ratio; H01 sign flip | cowos_l s2 coplanarity 251 vs 64 um; ring48x 370 vs 186; xilinx lidded W-shape; 50 mm sign; 120 mm SUS430 trend; cowos_s W-shape sign opposite; bare substrates and fan-out untestable; corner von Mises indeterminate |
| EM | em1 cannonball 4/4, T80C 4/4; em2 5/5 (+3.8..+11.4 %); EM-4 L -1.3 % (order 1), +0.7 % (order 2, 145k DOF) | em1 base and T115C miss at 140 GHz; EM-4 C +12 % / S11 +1.3 dB at order 1 (mesh-limited), +3.0 % / +0.3 dB at order 2 (at gate edge); EM-5a untestable / not reached |

- F: L9 root-cause study: engine verified; warpage misses traced to undisclosed inputs (lid/TIM coupling, stress-free T, stack asymmetry), view-side ambiguity, unmodelled physics (viscoelastic EMC, cure shrinkage, carrier) (DevLog-012:395-415). None tuned away; calibrations labelled.
- I: the code is verified against independent solvers; package-level validation against measurement is input-limited, not solver-limited.

## 6. UI/UX and 3D visualization

F, layout and stack: SvelteKit static site, Svelte 5, three.js r186 WebGLRenderer, no Plotly on /sim (own canvas `LinePlot.svelte`, `SmithChart.svelte`). Layout per R7 spec (research/2026-10-20-sim-ui-ux-visualization.md:316-340): toolbar (case/study picker, Compute/Cancel/Link) | Model Builder tree | Settings | Graphics, bottom tabs Messages / Progress / Log; splitters; dark, sharp corners, custom tooltips.

F, graphics features (`lib/sim/graphics/*.ts`, `Graphics.svelte`, `ResultPages.svelte`, `post.ts`):
- `FieldLayer.ts`: one ShaderMaterial for surface and slice triangles; 256x1 LUT texture; linear/log; SI-to-display affine; range uniforms; deformation `p + s u` in the vertex shader; flat shading from screen-space derivatives; wireframe overlay; raycasting on undeformed geometry.
- Worker-side post (`post.ts`, EO DevLog-030 pattern): exterior surface of active cells; axis-aligned section whose cap is the exact Q1 slice of the field; axis-aligned slice planes; line plots through probes; isosurfaces by marching tets (6 tets per hex); only display arrays leave the worker. Arrows: InstancedMesh, |v| coloured, mirrored copies.
- Geometry preview `BoxViewer.ts`: instanced boxes, exact section trim with filled caps, z-exaggeration, x-ray of host volumes, camera presets, PNG export; dashed edges = template dims; R/D/P/T/U provenance badges in Parameters with ref tooltips; constraint messages from generator rules.
- Deformation: automatic ~10 % of geometry size, factor shown and editable (Wentao decision 2026-10-20, DevLog-010:186-187).
- Symmetry crops drawn mirrored (display only, "COMSOL Mirror 3D"); probes/pins; compare A | B and B - A (gated on same physics and grid); VTU export (cowos_r 14.4 MB in 0.2 s); process-step picker; EM pages (S dB/phase, mixed-mode, Smith, RLGC(f), Touchstone, progress with ETA); "pick channel": click a routed level -> in-memory em2d draft case.
- Measured: first paint 92 ms; orbit 1.4-2.7 ms/frame; slice drag 4-9 ms; section drag 5-24 ms after cache at 1-2e6 cells (DevLog-012:192, 316).
- `/3d` viewer (`lib/three/`, 4,612 lines; packaging-only): one renderer, N family slots via scissor viewports sharing one camera (synchronized compare), merged box meshes, section caps, LOD instanced interconnects, deterministic routing mock-ups (`routing.ts`, 1,336 lines).

F, user statements and corrections found:
- "works in general, but glitchy. Test various operations as well as different toggles and orderings." (DevLog-013:76). L24 found 18 glitches, 6 high: blank view on same-geometry case switch, B - A showing zero, carried-over clip blanking, pick-channel draft lock, WebGL context exhaustion after repeated side-by-side, default study failing in 10/23 families; plus O3: the dev server reloaded /sim on every engine edit while lanes ran (L24 notes:56-82). Regression driver (Playwright, git-ignored `cache/sim_ui_driver/`) 30/30 after L30.
- /3d decisions (DevLog-008:6-30): no auto-orbit; damped orbit/pan/zoom; presets; synchronized compare cameras; section cutaway default; exploded slider; per-material x-ray; callouts toggle; references exposed and traceable; no paper figures.
- Load-time requirement 100 ms per tab (DevLog-018:11).
- No explicit positive-feedback quote on the /sim UI found in the files read.

I: the reusable visualization core is small and clean (FieldLayer, ArrowLayer, post.ts kernels, colormap/colorbar/ticks, LinePlot, SmithChart). All post kernels assume the rectilinear grid; an unstructured-tet backend needs a tet version of surface/slice/iso (marching tets already exists for the iso path).

## 7. Agent surface

F:
- CLI: `node cli.mjs <case.yaml> [--study s] [--json] [--solver auto|direct|pcg_mg] [--sensitivity] [--variants f] [--mesh k=v,...] [--mech-budget-s n] [--stream] [--mech-rtol x] [--wasm]` (cli.mjs:1-5, 258-267). Exit codes 0 ok / 1 input or solver error / 2 target missed (EO convention). "Nothing is written to disk."
- Stand-alone `src/em2d/cli.mjs`, `src/em3d/cli.mjs` (`--variants`, `--json`, `--touchstone-dir`); `src/runner/node.mjs` (sensitivity, labelled variants, `--homog rom|rve`, JSON rows); `bench/*.mjs` JSONL to `logs/`.
- Every result carries `engine_version` {src, data, package3d, metrics hashes, dirty} (SPEC 19; cli.mjs:20-55) and `convergence`.
- Browser = CLI to 1.9e-7 um on M1 (DevLog-012:532), because the same runner (`runCaseAll`) runs in the worker.
- Agents (lanes) edited `sims/*.yaml` directly as text; contract changes were requested to a coordinator and merged into SPEC prose.
- UI: URL query state (`case`, `set=` YAML-path overrides, study, node, camera, clip, kz, deformation, pool, packed in-memory case text); dev-only `window.__simWorkbench` hook used by the Playwright driver; canonical YAML text with comment-preserving splices.
- Not present: HTTP API, MCP tools, persisted run records or result store (outputs never committed; RESULTS.md hand-curated from lane notes), undo/rollback (EO undo removed from ModelTree, its header), machine-readable schema for agents.

I: the agent loop that worked was "edit YAML text -> CLI --json -> read exit code and JSON". It lacks the D3 rollback and a run-record store; both are cheap to add around the existing deterministic runner and engine stamp.

## 8. Known weaknesses, open items, tech debt

F (with source):
1. EM-5a never reached; AMS coarse solver written, AMG verified standalone, not wired (`em3d/amg.mjs:1`, `em3d/ams.mjs:1` STATUS 2026-10-22; DevLog-014:128-132).
2. EM-4 order 2 at 145k DOF peaks at 2.22 GB with companions, over the 1.5 GB browser budget (G7 fail; DevLog-014:166).
3. GMRES + p-MG stalls on anisotropic/needle cells (DevLog-014:164, 179-182).
4. Layered em3d mesher: in-plane refinement extruded through all layers, z-grading at every interval; no z-grading near selected solids (DevLog-014:185-188, next step 4).
5. q1im + GMG 100-300+ iterations on packages, cap hit on cowos_s; q2s `column` smoother default undecided (DevLog-012:438-451; DevLog-013:161, 267).
6. Browser mechanics memory 1.29-1.54 GiB on cowos_l, emib_t 1.97 GB Node (RESULTS.md:99-104; DevLog-013:218).
7. G1 WASM below gate (opt-in); G2 WebGPU and G3 threads never attempted.
8. Nonlinear (q2s total Lagrangian) limited to <= 1e5 DOF; viscoelastic case-level wiring (L27 Part C) not started; rho/cp missing for 46 of 54 library keys, so `thermal_transient` fails on most package cases (DevLog-013:345-349, 363-364).
9. Geometry limited to axis-aligned boxes with snapping (thermal/mech) and layered extrusions (em3d); no CAD, no general tet mesher, no persistent geometry IDs.
10. Contract sprawl: SPEC v0.25 = 25 additive prose sections in 3 days; no schema file; the all-physics case parser lives in `thermal/case.mjs`.
11. Two expression grammars: `params/params.mjs` (EO grammar, `^`) and `families/expr.mjs` (Python semantics, `**`).
12. SPDX/licence lines missing on 78-81 code files (DevLog-012:618, 715); vendored robust-predicates pending npm swap.
13. Results ledger entries stamped dirty; several queued runs never recorded (RESULTS.md:96-97); fresh-context audits of L22 (EM order 2), L27, L28, L29, L30 pending (DevLog-013:358-359).
14. Absolute warpage accuracy bounded by undisclosed paper inputs; thermal TVs ~27 % low without contact resistance (DevLog-012:749-753).
15. UI open: mirrored pins O1 fixed by L30; em3d UI controls for order / solver / adaptive / lumped ports not built (DevLog-013:366); first /3d scene build one long task (~1 s at 4x CPU) (DevLog-018:209).

## 9. Reuse recommendation for applied-multiphysics

Categories: **AS-IS** = extract as-is into shared core; **GEN** = extract with generalization; **KEEP** = packaging-specific, keep in APA; **REDESIGN**.

| Module / file group | Rec. | Reason |
|---|---|---|
| `la/sparse`, `la/ldlt`, `la/complex` | AS-IS | Already identical in APA and EO; meets A1's 5-module extraction rule. |
| `la/pcg`, `la/stencil`, `la/mg`, `la/block`, `la/halfmg` | AS-IS | Physics-agnostic tensor-grid operators and MG; core of any structured-grid backend. |
| `la/wasm/{encoder,kernels,accel}` | AS-IS | Toolchain-free runtime WASM; keep opt-in until a gate passes. |
| `em2d/{dense,ldlt-blocked,ldlt-wasm,ldlt-select}` | GEN | General complex LA misplaced in em2d; move into `la/`. |
| `params/params`, `params/units` | AS-IS | Safe evaluator; APA units is a strict superset of EO's. |
| `families/expr.mjs` | KEEP | Second grammar tied to package3d templates; do not add a second grammar to the core. |
| `grid/` | GEN | Physics-agnostic; generalize the box-part input and selection grammar to core geometry entities. |
| `thermal/{assemble,index,transient,analytic}` | GEN | Generic Q1 conduction + closed forms; decouple from case/target code. |
| `thermal/case.mjs`, `mech/case.mjs`, `cli.mjs` | REDESIGN | Case parsing, targets (`metric_id`, Rjc definitions), CLI dispatch are packaging- and lane-shaped; rebuild as the core spec/runner. |
| `mech/{elements,constitutive,assemble,numbering,materials,supports,solve,gmg,lowmem,process,sweep,nonlinear,viscoelastic}` | GEN | Verified generic thermo-elasticity on the grid; needs a non-grid element path later. |
| `mech/post.mjs` | GEN | Stress post generic; JEITA warpage, shape_class and corner flags become a packaging plugin. |
| `homog/{rve,laminate,merge,cells}` | GEN | Periodic RVE and exact laminate are general; drop packaging array kinds from the key grammar. |
| `homog/{resolver,table}` | KEEP | `homog:<kind>` grammar and per-family precomputed table are packaging-specific. |
| `materials/` code (`library,schema,eval,units,overrides,cubic,homogenize`) | GEN | Matches DevLog-000 section 5 aims (YAML, sourced leaves, basis, uncertainty); make the source registry independent of APA DB ids. |
| `engine/data/materials/*.yaml` | KEEP | Values cite APA DB papers and locators; copy entries only with their sources resolvable. |
| `families/` (all) | KEEP | Package generators, presets, rules, transcribed templates. |
| `runner/{sensitivity,variants}` | GEN | Template-basis sensitivity and labelled variants are a general provenance feature. |
| `em2d/{mesh,geometry,_port}` | AS-IS | Ported mesher (own CDT + refinement; Triangle excluded by licence); swap vendored predicates for the npm dep. |
| `em2d/{fe,section,rlgc,mtl,dielectric,roughness,touchstone,closed-forms,run}` | GEN | Generic interconnect EM; rename SPEC-9 keys into the core spec. |
| `em3d/{hcurl,space,elements,krylov,pmg,prom,lumped,ports,cascade,order}` | GEN | Solid ND1-2 FEM, ports and sweeps; keep Palace NOTICE and Apache headers. |
| `em3d/mesh.mjs` | REDESIGN | Layered-extrusion-only mesher is the root of EM-5a and DOF growth; core needs unstructured tets (or extrusion with local z-grading as a special case). |
| `em3d/{amg,ams}` | GEN | Finish wiring and gate G12 first; needed for blocks above the direct coarse budget. |
| `em3d/{solver,run}` | GEN | Generalize mesh input and case keys. |
| `bench/` | GEN | JSONL bench and gate harness pattern; generalize workloads. |
| `validation/` structure (tiers, schema `ap-sim-val/0`, script-generated expected JSON, `reference_fe`, `check_db_targets.py`, RESULTS ledger) | GEN | The tier/ledger method transfers; DB-keyed tiers C/D/H stay with APA. |
| `validation/cases/A`, `B` (closed forms, NAFEMS) | AS-IS | Physics-generic gates with stdlib scripts and public benchmarks. |
| `validation/reference/` (scikit-fem, NGSolve uv project) | GEN | Reusable desktop oracle; split packaging decks from generic ones. |
| UI `colormap, colorbar, ticks, LinePlot, Splitter, SmithChart, exportUtil, Icon, Field, siUnits, units` | AS-IS | Small generic widgets, already shared with EO. |
| UI `graphics/FieldLayer, ArrowLayer, BoxViewer`, `post.ts`, `postClient.ts`, `sim.worker.ts`, `pool.ts`, `protocol.ts` | GEN | Clean worker-post pattern; post kernels need a tet path beside the grid path. |
| UI `yamlSplice.ts`, `yamlEdit.ts`, `urlState.ts`, `linkText.ts` | AS-IS | Comment-preserving GUI edits on shared YAML text: the GUI/agent single-source mechanism. |
| UI `workbench.svelte.ts`, `ModelTree.svelte`, `Settings.svelte`, `ResultPages.svelte`, `SimPage.svelte` | REDESIGN | Packaging node set, no undo/rollback; core needs a schema-driven tree and D3 rollback. |
| UI `engine.ts`, `engineRun.ts`, `mechPack.ts`, `defaults.ts`, `channel.ts`, `cases.ts`, `ParamsTable`, `MaterialsTable`, `EmPages`, `EmSection` | KEEP | Packaging glue (fixture fallback, family sessions, pick channel). |
| `app/src/lib/three/` (/3d viewer, routing synthesizer) | KEEP | Bound to package3d family model. |
| DevLog-018 load-perf work (prerender, lazy route shell, service worker, preload manifest hook) | GEN | Pattern transfers to any static SvelteKit app; code is atlas-specific. |

I, decision-relevant observations for DevLog-000 revisions:
- DevLog-000 picked Palace (3D RF) and MOOSE (thermal/mech) as desktop backends. Since then Wentao chose "no Palace. Make native EM solver in browser" for APA (DevLog-013:71), and APA shows a browser JS engine reaching verified thermal/mech at ~1e6 DOF and verified EM at 6e4-3e5 DOF. The backend table in DevLog-000 section 4 needs a decision: browser-native JS core first, desktop backends as oracles/scale-out, or the reverse.
- The binding constraint for a general-geometry multiphysics core is meshing: APA avoided it with boxes and extrusions. Gmsh/OCC (DevLog-000 choice) is desktop-only; no permissive WASM tet mesher was found (DevLog-010:62).
- Memory (1.5 GB per worker, single worker, no threads on GitHub Pages) caps browser models; hosted or local-server mode (DevLog-000 D2) can lift it.
