# R1: eo-modulator-atlas engine and /sim workbench survey

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | R1 (read-only research) |
| Subject repo | eo-modulator-atlas (`engine/`, `app/src/lib/sim`, `app/src/routes/sim`, `sims/`, `validation/`, DevLog-023..046) |
| For | applied-multiphysics, DevLog-000-scoping (2026-09-28; predates this engine work) |
| Method | Read module headers/exports/imports, LOC by `wc -l`, DevLogs 023-034, 036, 039, 042, 043, 046 (focused greps + key sections), SPEC.md, 2 sim configs, validation layout + summary JSON. Nothing run, built or edited. |

Notation: **[F]** = fact read from file (path:line where useful). **[I]** = my inference. All timings are the
DevLogs' own measurements (Node 23.7.0, Apple M4 Pro, machine shared with other lanes, `nice -n 10`, spread ~10-20 %
per DevLog-024 "Limitations"); none were re-measured here.

---

## 0. What it is, in one paragraph

[F] A dependency-light (runtime deps: `yaml`, `robust-predicates`; `engine/package.json`) GPL-3.0-or-later ES-module
engine, ~18.1k LOC in `engine/src` plus ~10.2k LOC tests/bench, that runs identically in a Web Worker and in Node. It
solves 2D cross-sections only: own conforming Delaunay mesher, P1/P2 Lagrange electrostatics, full-vector Nedelec
mode solver (order 1/2) with shift-invert block Arnoldi on own supernodal LDL^T, Pockels overlap, quasi-TEM RLGC
line, periodic Bloch cell, traveling-wave EO response, and a 2D steady drift-diffusion solver (Scharfetter-Gummel,
Newton-GMRES). A COMSOL-like SvelteKit workbench (`/sim`, ~10k LOC in `app/src/lib/sim`) renders results with an own
WebGL2 renderer. Validation uses an isolated uv project (`validation/`) with femwell, scikit-fem, tidy3d local mode
solver and DEVSIM as open-source references. No WASM, no WebGPU, no 3D, no server, no MCP.

---

## 1. Engine module map

LOC from `wc -l` (2026-11-06). Tests = engine test files that exercise the module (names in `engine/tests/`; counts
of `test(` calls per file in parentheses). G = generic (physics-agnostic or FEM-generic), P = generic pattern but
EO-coupled code, E = EO/TFLN/Si-modulator specific.

### 1a. Numerics core (no physics)

| Module | LOC | Purpose / numerics | Imports | Tests | Class |
|---|---|---|---|---|---|
| `sparse.mjs` | 1514 | CSR patterns from element meshes (`buildPattern`, `buildElementPattern`, slot maps), own AMD (default) and coordinate-bisection ND orderings, symbolic analysis (etree, Gilbert-Ng-Peyton column counts, relaxed supernodes), supernodal multifrontal Cholesky (dense column-major fronts, 4-col unrolled Schur), multi-RHS solves, `UpLookingCholesky` kept as oracle, `jacobiEigen`, opt-in `timingSink` | none | perf-sparse (7), indirectly all | G |
| `ldlt.mjs` | 827 | Sparse symmetric indefinite LDL^T (1x1 static pivots + perturbation count + iterative refinement), real and complex-symmetric, up-looking and supernodal; reusable symbolic. Basis: quasi-definite (Vanderbei 1995) | none | vector-ldlt (2) | G |
| `vector-dense.mjs` | 349 | Dense Hessenberg + Francis QR (EISPACK hqr re-implemented), inverse-iteration eigenvectors; for Arnoldi Ritz problems n <= few hundred | none | via vector-mode | G |
| `complex.mjs` | 39 | `{re, im}` helpers | none | via rf/eo-response | G |
| `semi/linear.mjs` | 147 | Bernoulli B(x), restarted right-preconditioned GMRES (MGS + Givens), Jacobi-scaled SPD block wrapper over sparse.mjs | sparse, fem | via semi tests | G |

### 1b. Geometry, mesh, FEM

| Module | LOC | Purpose / numerics | Imports | Tests | Class |
|---|---|---|---|---|---|
| `geometry.mjs` | 231 | Polygon utils (area, ccw, bbox, point-in-polygon, distance, clip), PSLG build | none | templates-geometry (5) | G |
| `mesh.mjs` | 897 | Own conforming 2D quality mesher: Bowyer-Watson Delaunay + Ruppert/Chew refinement, encroachment segment recovery (no CDT flips), graded size field; robust predicates; vertex budget throws (`mesh.mjs:668,690`). Rationale: no permissive npm CDT-with-quality; Shewchuk Triangle excluded (`mesh.mjs` header) | robust-predicates, geometry | perf-mesh (3), conformity checks in vector-mode | G |
| `section.mjs` | 171 | `CrossSection`: **painter-order** region classification ("later wins"), electrodes as holes, size hints -> mesh | mesh, geometry | indirect | P |
| `fem.mjs` | 376 | P1 triangles (closed-form), P2 space/assembly/gradient, `restrictMatrix`, `PoissonSolver` (energy, gradient) | sparse | electrostatics (4), perf-p2 (3) | G |
| `recess.mjs` | 81 | Inward polygon offset (Wheeler incremental inductance) | none | rf-line | G-ish (polygon offset) |
| `mesh-entry.mjs` | 41 | `buildSectionMesh` for the UI "Build mesh" (mesh without solve, draft fallback) | config, section | smoke | P |

### 1c. Physics solvers

| Module | LOC | Purpose / numerics | Imports | Tests | Class |
|---|---|---|---|---|---|
| `electrostatics.mjs` | 384 | 2D anisotropic Laplace, Dirichlet electrodes with weights, mirror symmetry, C' by energy and terminal charge, C0', n_RF, Z0; `TriLocator`, `gradientAt` | fem, sparse, materials | electrostatics, reference K4/K6 | P (Poisson generic; C'/Z0 post is RF-line specific) |
| `optics.mjs` | 767 | Scalar P1 mode solver (quasi-TE E-form / quasi-TM H-form), shift-invert subspace iteration, group index (perturbation default, FD oracle); labelled approximate | fem, sparse, section, materials | optics (6), optics-limits (14) | P (legacy path) |
| `vector-mode.mjs` | 1868 | Full-vector modes: Nedelec 1st kind order 1 (Whitney) / order 2 hierarchical (8 DOF) + Lagrange P1/P2 for E_z, Lee-Sun-Cendes beta^2, shift-invert block Arnoldi with thick restart on LDL^T, inertia (Sylvester) spurious-mode check, warm shift, lossy (complex-symmetric) metal, SPP guard, Hellmann-Feynman ng and EO perturbation, field evaluation kernels (`VECTOR_KERNELS`, `vector-mode.mjs:1868`) | optics, section, fem, sparse, materials, ldlt, electrostatics, vector-dense | vector-mode (15 tests / 22 gates G1-G9 per DevLog-025:263), reference K1-K3 | G-core + E-post (EO overlap, Pockels inside the same file) |
| `optical-stage.mjs` | 283 | Dispatch scalar/vector, mode identity/doubling, lossy guard, metal fractions, bounded warm cache (LRU 4 entries / 64 MB) | optics, vector-mode, eo-overlap, fields | optical-runner (3) | E |
| `semi/solver.mjs` | 833 | Steady 2D drift-diffusion: SG box method on P1 mesh, coupled Newton in (psi, phi_n, phi_p), Slotboom updates, GMRES with Cholesky block preconditioner, Gummel warm start/fallback, bias ramp, tangent predictor | semi/linear, models, device, electrostatics | semi-1d-pn (11), semi-rib (10) | G-ish (Si DD; not EO) |
| `semi/device.mjs` | 251 | Device mesh, control volumes, doping per CV, contacts, scaling | sparse, fem, electrostatics, geometry, models, config | semi tests | P |
| `semi/models.mjs` | 200 | Sproul-Green n_i, Masetti, Caughey-Thomas, SRH, Nedeljkovic 2011 / Soref-Bennett plasma dispersion; every coefficient with locator | none | semi-models (9) | G (Si material models) |
| `semi/smallsignal.mjs`, `semi/optics.mjs`, `semi/dataset.mjs`, `semi/config.mjs`, `semi/run-cli.mjs` | 72 / 109 / 70 / 294 / 23 | C(V), series R, f_RC; plasma -> vector-mode perturbation; postproc dataset; block validation; stale standalone CLI | as named | semi tests, s7-semi-twe (7) | E/P |
| `semi-stage.mjs` | 386 | Stage entry: DD + small signal + plasma-dispersion optics, sweeps over bias; header still says runner does not dispatch it (stale; `run.mjs` imports it) | config, optical-stage, semi/*, sweep | semi-rib, s7-semi-twe | E |
| `eo-overlap.mjs` | 366 | Pockels overlap (scalar), MZM arm/push-pull/VpiL conventions, "FROZEN CONVENTIONS" header | materials, electrostatics, optics | eo-overlap (19) | E |
| `rf-line.mjs` | 482 | Uniform RLGC line, skin depth, Wheeler R', slab surface impedance, dielectric loss from regions, sweeps | complex | rf-line (25) | E (generic TL math inside) |
| `loaded-line.mjs` | 200 | ABCD, Bloch cell (Shin 2011), Bragg, cascade | complex, rf-line | s7-loaded-line (7), s7-cascade (6) | E (ABCD generic) |
| `eo-response.mjs` | 200 | Traveling-wave EO response (Alferness 1982), S21_EO, bandwidth crossings | complex, rf-line | s7-eo-response (9) | E |
| `materials.mjs` | 285 | Library access (`data/materials.json`, 4 entries), Sellmeier dispersion, crystal->lab rotation, Pockels Voigt tensors | materials.json | library-citations (3) | P (library mechanism generic; content LN-centric) |

### 1d. Model spec, orchestration, postprocessing

| Module | LOC | Purpose | Imports | Tests | Class |
|---|---|---|---|---|---|
| `config.mjs` | 1012 | Hand-written strict validator + expansion (params -> `=` expr -> template -> library), `inspectConfig` (draft preview + per-stage readiness), many enums; `MAX_VERTICES = 80000` (`config.mjs:12`) | semi/config, yaml, geometry, materials, params, templates, electrostatics, section | config (9), audit wave (17) | E (pattern reusable) |
| `params.mjs` | 352 | Own recursive-descent arithmetic parser (no eval), params with cycles detection, key-suffix unit checking | none | params-expressions (7) | G |
| `templates.mjs` | 210 | One template: `TEMPLATE_TYPES = ['tfln_rib_gsg']` (`templates.mjs:10`) | none | templates-geometry | E (mechanism G) |
| `sweep.mjs` | 219 | Parametric studies: `enumerateSweep`, `runSweepPoint(text, index)` for worker pools, async `runSweep` with AbortSignal; content-hash reuse of mesh / ES solution (`sweep.mjs:140,159,198`) | yaml, config, run, params, postproc/store | sweep-enumeration (4) | P |
| `stage-compat.mjs` | 151 | Single rule set for stage combination (runs / implied-by / blocked reason / conflicts), shared by runner and UI | config | stage-compat (11) | P |
| `stages.mjs` | 623 | EO, RF, loaded-line, response, junction-response stage bodies | 12 modules | s7-stages (8), eo-rf-runner (30) | E |
| `run.mjs` | 460 | `runCrossSection` / `runConfig`; target comparison; three result builders (cross-section, mode-only, semiconductor-only; `run.mjs:322-326, 373-378, 446-452`) | 9 modules | eo-rf-runner, fields-solver-options (15) | E |
| `fields.mjs` | 136 | FNV-1a 64-bit content hash, typed-array field export, transferables | materials, eo-overlap | fields-export (3) | P |
| `yaml-edit.mjs` | 182 | Source-splice YAML edits (`getIn/setIn/deleteIn/applyOverrides`) preserving comments and number spellings, each splice verified by re-parse, fallback to Document printer | yaml | via app tests, bench | G |
| `postproc/expr.mjs` | 521 | Own expression language: comparisons, logicals, unit postfix `2[um]`, complex-aware, compiled to array-at-a-time closures with constant folding | units | postproc (18) | G |
| `postproc/units.mjs` | 167 | SI dimension vectors (m, kg, s, A), unit parser, display conversion | none | postproc | G |
| `postproc/refine.mjs` | 210 | Barycentric lattice patterns (level r), sub-triangle connectivity, smoothing groups (none / inside material / everywhere) shared with UI | none | postproc-refine (6) | G |
| `postproc/evaluate.mjs` | 476 | `evaluatePlot` (node/element/corner/quadrature/refined/cut line), `evaluateDerived` (global, surface int/avg/max/min, line int/avg, point), `modeTable`, globals over sweeps; 6-point degree-4 quadrature, line integrals split at element crossings | store, expr, units, refine | postproc | G |
| `postproc/store.mjs` | 1220 | Solution store: datasets over solved meshes, variable registry with SI units, exact point evaluation per element basis, point sets, byte-bounded LRU (128 MiB default) | electrostatics, vector-mode, eo-overlap, eo-analysis, optical-stage, expr, units, refine, semi/dataset | postproc | P (store core generic; dataset builders EO-coupled) |
| `postproc/sweep-store.mjs` | 94 | Sweep globals + LRU of full stores (2 stores / 512 MiB) | store, evaluate, sweep, fields | postproc | G-ish |
| `postproc/eo-analysis.mjs` | 322 | EO integrand split by Pockels coefficient/region, conventional Gamma, implied VpiL | materials, vector-mode, eo-overlap, optics | postproc | E |

### 1e. Test/bench surface

[F] 33 test files, ~10k LOC. Latest recorded: `npm test` 334 tests, 331 pass, 0 fail, 2 skipped, 1 todo
(DevLog-043:245); `npm run test:reference` 15/15 (DevLog-043:246); app `vitest` 78 passed and `pnpm smoke` 51 PASS
(DevLog-046 Verification). Gate categories: analytic (parallel plates, slab TE/TM, PEC guide, SPP, uniform-field
Pockels, 1D PN), self-consistency (Hellmann-Feynman vs FD of same solver), cross-solver (reference-cases),
regression vs frozen engine (bench, relative 1e-9), contract (field export shape, stage compat), audit-derived tests
(`audit-claude-wave-2026-10-02.test.mjs`). Bench: `bench/bench.mjs` (frozen `--src` A/B, JSONL log
`logs/bench-YYYYMMDDTHHMM.jsonl`, baseline compare), `vector-bench.mjs`, `postproc-bench.mjs`.

---

## 2. Config / spec model

### 2a. How a simulation is described [F]

- One YAML file per device, `schema: eo-atlas.sim/v1` (`sims/SPEC.md:1-103`); 42 configs in `sims/`, 6,335 lines total;
  all 42 `validation_status: unvalidated`.
- Top-level keys (`engine/schema/sim.schema.json` properties): `schema, id, paper_id, device_id, title, repro_grade,
  validation_status, chain, materials, geometry, alt_geometries, optics, targets, provenance, missing, limitations,
  line, sweep, params, template, study, studies, semiconductor`.
- Geometry: polygons / rects in um, regions in **painter order (later wins)**, electrodes = holes with Dirichlet
  weights, `optical_window`, mesh hints; `alt_geometries` for other cuts (loaded/unloaded).
- Units: encoded in key suffixes (`_um`, `_nm`, `_ghz`, `_ohm`, `_Sm`); engine converts to SI. Param `unit` is for
  display and a limited sum-of-terms consistency check (SPEC.md:376-410).
- `params` + `"=expr"` strings anywhere a number goes (own parser, 500 chars, depth 64). Expansion order:
  params -> expressions -> template -> library; `config.raw` = expanded, original kept as `source` (SPEC.md:378).
- `template: {type: tfln_rib_gsg, ...}` generates geometry + EO arm windows; only one template exists.
- `studies.<name>: {type: parametric, stages, sweep: [{param, values|range}], outputs, sweep_targets}`; multi-axis
  row-major, <= 2000 points; sweeps act on `params` only.
- `chain` lists intended stages; `chain` never causes execution (engine/README). Stages are selected explicitly at
  run time; `stage-compat.mjs` decides combinations (matrix in SPEC.md "Stage contract").
- Materials: inline values or `library: <key>` into `engine/data/materials.json` (4 entries: LN congruent, SiO2, Si,
  Au), each value with source read, locator, condition, verification level; `result.materialSources` reports origin.
- Validation boundary: hand-written strict validation in `config.mjs` (unknown keys rejected, "physical inputs are
  never silently filled in"); `inspectConfig` gives a draft preview + per-stage readiness for incomplete configs.
  The JSON Schema (2,949 lines) is hand-maintained alongside; tests check consistency (`config.test.mjs:126`,
  `optical-runner.test.mjs:16`) and the UI reads its enums (`app/src/lib/sim/enums.ts:3`).

### 2b. Provenance fields [F]

- `provenance: {dotted.path: {class: paper_exact | figure_digitized | project_inference | standard_reference | unknown,
  locator|citation, note}}`, `missing: [...]`, `limitations: [...]`, targets with `source {device_id, field, locator,
  basis, comparable}` and `tol_rel | tol_abs`. Example density: `sims/renaud2023/config.yaml` has ~35 provenance rows,
  8 `missing`, 12 `limitations`.
- Run results carry `warnings`, labels (e.g. `scalar_optical_not_full_vector`, `library_material_constants_used`),
  `materialSources`, `params`, `geometryHash`, `materialHash`, `reused`, `timing`, `opticalSolver`, `elementOrder`,
  `targets`, `targetSummary` (`run.mjs:322-326`). **No engine version, git hash, input hash, timestamp or host** in
  the result; results are never persisted ("No results are persisted", `run.mjs:1`).

### 2c. How the UI edits it [F]

- YAML text is canonical (DevLog-023 D6). Forms call `yaml-edit.mjs` `setIn/deleteIn`: scalar edits splice the
  value's source range so comments, key order and number spellings survive byte for byte; every splice re-parsed and
  verified; fallback to the `yaml` Document printer (`yaml-edit.mjs:1-12`). Empty field = delete key (DevLog-027 U16).
- Template-generated geometry is read-only in forms (not in the source); library values shown italic, editing writes
  an override (UI-D2). Form edits are encoded as URL overrides; free YAML-tab edits are not (DevLog-027 Limitations).
- Undo/redo exists only for the Results tree (snapshots, <= 50 steps; `results.svelte.ts:299-311`), not for model
  (YAML) edits.

### 2d. Fitness as a general typed model spec for GUI + agent [I]

Strengths worth keeping:
- Text-diffable, comment-preserving, one file = one model; agent edits by text or by dotted path; splice editing is
  a solved, tested problem.
- Strictness culture: unknown keys rejected, no physical defaults, readiness per stage with reasons, `missing` and
  `limitations` as first-class fields, provenance classes per dotted path. This is exactly what DevLog-000 rule 2
  needs.
- Params + safe expressions + parametric studies + content-hash reuse is a good general study model.

Not fit as-is for applied-multiphysics:
- Schema is EO-device shaped (`optics`, `line`, `semiconductor`, `eo_axis`, `vpi_convention`), not a physics-agnostic
  tree of components / physics interfaces / boundary conditions / studies.
- Painter-order region semantics contradicts DevLog-000 section 4 ("explicit domain/boundary/selection assignment;
  no overlap-order semantics"). No boundary selections, no named entities, no persistent geometry IDs.
- Units in key suffixes do not generalize (thermal, mechanical, 3D packaging quantities); a typed quantity field
  `{value, unit}` or unit-annotated schema is needed. The postproc `units.mjs` dimension system is the better base.
- Two sources of truth (hand-written `config.mjs` validator + hand-maintained JSON Schema). DevLog-000 proposes
  Pydantic; the clean move is one schema that generates both the validator and the JSON Schema (Pydantic -> JSON
  Schema, consumed by the TS UI and the JS/WASM engine).
- No revision history / rollback for model edits (DevLog-000 D3 requires direct edits with rollback).

---

## 3. Performance

### 3a. Measured numbers [F]

Electrostatics (DevLog-024 "Final before/after", median of 5, `runCrossSection` wall, P1):

| Case | nNodes | nnz(L) before -> after | Before ms | After ms | Speedup |
|---|---|---|---|---|---|
| mao2022-es | 33,034 | 1.76M -> 0.98M | 668 | 266 | 2.5x |
| arabjuneghani2022-es | 26,759 | 2.14M -> 0.69M | 877 | 174 | 5.0x |
| chen2022-unloaded-es | 49,281 | 4.42M -> 1.34M | 2097 | 323 | 6.5x |
| lin2025-es-opt (ES + scalar mode) | 39,405 | 1.85M -> 1.01M | 1008 | 346 | 2.9x |
| mao2022-wheeler (ES + 3 recessed vacuum solves) | 33,034 | - | 2126 | 675 | 3.1x |

- Factor phase 3.7-21x from AMD fill reduction (fill 12.5-23.5 -> 6.9-8.2) times supernodal kernel (2-4x)
  (DevLog-024:377). Supernodal factor ~2 G multiply-add/s in JS (DevLog-024:203-206).
- Ordering decision: own AMD for every size; improved ND saves 10-20 % flops above 100k unknowns but costs 0.4-0.5 s
  ordering in JS (DevLog-024:203).
- P2 vs P1 electrostatics: at equal accuracy (0.08 % on C') P2 at mesh scale 2.8 is 4.7-4.8x faster than P1 at scale
  0.5; P2 default adopted (DevLog-024:297-321, DevLog-026:268).
- After P2 default (DevLog-024:529, round 3): mao2022 ES P2 at P1 mesh 1622 ms (nnz(L) 11.1M); ES + vector P2 2057 ms.

Vector mode solver (DevLog-025:321-349, 2 modes, tol 1e-7):

| Case | Order | DOF | Model ms | Factor ms | Eigen ms (ops) | Solve total ms |
|---|---|---|---|---|---|---|
| K2 TFLN rib, box 0.06 | 1 | 24,158 | 112 | 43 | 110 (24) | 189 |
| K2, box 0.12 | 2 | 31,904 | 126 | 78 | 154 (25) | 254 |
| K2, box 0.12 + corner 0.01 | 2 | 55,901 | 187 | 117 | 234 (25) | 387 |
| K2 warm (next wavelength) | 2 | 31,904 | 90 | 63 | 62 (10) | 157 |
| K1 Si strip, corner 0.01 | 2 | 33,543 | 87 | 67 | 215 (34) | 315 |

- Accuracy: order 2 within 2.7e-5 of the femwell n_eff in 380 ms, within 4e-7 in 574 ms (DevLog-025:348).
- Order-aware local-wavelength auto-sizing cut K2 221,211 -> 72,814 DOF (1794 -> 443 ms) (DevLog-025:149).
- Rejected: two-stage shift (extra factorization, 530-564 ms), block size 2 cold (360 ms eigen) (DevLog-025:339-346).

End-to-end and sweeps:
- renaud2023 vector single run 1.4 s; 4-point gap sweep 5.8 s CLI sequential vs proposed targets < 0.5 s and < 3 s for
  10 points: **not met** (DevLog-023:563-564).
- Wavelength-only sweep reuses ES: points 2-5 449, 336, 260, 212 ms (DevLog-026:428).
- 12-point renaud2023 vector gap sweep 16.3 s, process RSS peak 1.26 GB in Node (DevLog-026:612).
- K4 lossy TM mode: 44.5k / 66.6k / 103.5k DOF -> 2.3 / 3.4 / 5.5 s; loss not converged at default mesh (DevLog-026:743).
- Drift-diffusion: rib DD per 1 V reverse step 375-560 ms (2 V step 751 ms), 4 biases 4.0 s; han2023 7 biases 4.5 s
  (23k nodes); anjali2025 20.9 s (44k nodes) (DevLog-039:344-347, 503). In browser han2023 solve 5.3 s wall in worker
  (DevLog-042 Gates).

Browser (headless Chrome, ANGLE Metal, production build):
- Solve wall from Compute click: mao2022-a ES 830 ms; renaud2023 ES + optical + EO 639 ms (engine 615 ms); 4-point
  study on 2 workers 1,388 ms (DevLog-027:284-306). [I] Browser and Node are within the same range; no measured
  browser penalty was reported.
- Render: 110k-200k triangles pan/zoom at vsync (16.7 ms rAF, CPU draw 0.1-0.3 ms); Canvas 2D fallback 33 ms
  (DevLog-027 table).
- Refined plots (DevLog-034:229-248): mao2022 Fine P2 110,186 elements, r = 3 -> 991,674 sub-triangles: first field
  paint 78 ms, expression switch 18-20 ms round trip, cached switch 0.2 ms, no long tasks > 50 ms; GPU buffers 33.9 MB
  per (mesh, r) + 4.4 MB per value array; main heap 80-116 MB (175 MB at Finer); cap 2.5M sub-triangles.
- Postproc (DevLog-032 Measurements): plot requests 2-18 ms first, 1-3 ms repeat; surface integral 23.5 ms first.
- Bundle: `/sim` closure 456 KB (10 files), worker chunk 269 KB (DevLog-027 round 1); SimPage node ~700 KB later
  (DevLog-046 Causes).

### 3b. Bottlenecks found [F]

- After L-PERF, meshing is 35-45 % of an ES run and factorization 15-25 % (DevLog-024:340-342). The JS mesher and
  the painter-order classify are the next targets; `section.mjs` classify was not optimized (DevLog-024 Limitations).
- Dense kernels ~75 % of `factorNumeric` (DevLog-024:244).
- Vector eigen phase ~60 % of a thin-film solve (TE0/TM0 ~10 % apart in mu -> ~25 operator applications)
  (DevLog-025 Limitations).
- 80,000-vertex hard cap per mesh (`config.mjs:12`); K4/K5/K6 and several Wheeler configs exceed it at mesh scale 1,
  forcing scale 2 (reference-cases header; DevLog-024:575).
- Arrow placement per frame re-locates arrows (~10 ms CPU per frame on mao2022 Fine) (DevLog-034 open items).

### 3c. Accelerator gates [F]

- WASM: D4 gate "adopt only if JS > 2x slower than a hand-written kernel" (DevLog-023:150-152). Micro-benchmark of the
  Schur-update kernel with a hand-assembled module (60-line JS byte encoder, no toolchain): JS 2.63-2.93 G madd/s,
  WASM scalar 1.9-2.3x, WASM SIMD f64x2 2.9-3.8x; whole-factorization estimate 2.2x (SIMD), 1.7x (scalar); **not
  implemented**, deferred (DevLog-024:325-343).
- No SharedArrayBuffer by design (GitHub Pages cannot set COOP/COEP); transferable ArrayBuffers only (D4).
- Workers: one Web Worker per Compute (created per run, so the reuse cache helps only within a sweep worker); sweep
  pool `min(4, hardwareConcurrency - 1)`, `?pool=N` override (DevLog-027 U12, Limitations).
- WebGPU: not mentioned anywhere in engine, app or DevLogs (grep, 2026-11-06). WebGL2 used for rendering only.

### 3d. Load performance (DevLog-046) [F]

- Requirement (user): "Any tab/page/subpage should start showing and loading after max 100 ms, ~10 ms preferred."
- Causes: `ssr = false` (empty HTML), route chunks fetched on click (/sim node ~700 KB), Plotly 4.6 MB single long
  task, deep `$state` proxy over a 4.4 MB atlas object, layout waiting for atlas.json.
- Fixes: prerender with SSR + inlined CSS, server-load summary, `Preload` of data, `navigating` overlay + one-frame
  yield, preload code on viewport/hover, raw state, /sim page imported after mount behind a same-layout shell,
  Plotly split bundles + lazy draw, skeletons, service worker (pages precached; hashed code stored on first use).
- Result (local, 190 ms simulated TTFB): tab click to paint 5-53 ms (met); repeat-visit first paint 84-120 ms
  (borderline); first visit 248-260 ms (network bound, not met); /sim config ready on first visit ~1.45 s.
- [I] For applied-multiphysics: the shell-then-lazy-import pattern for the workbench and the service-worker cache
  policy carry over directly; the atlas-data-specific parts do not.

---

## 4. Validation

### 4a. Layout [F]

- `validation/` = isolated uv project (`pyproject.toml`: numpy, scipy, scikit-fem, femwell, gmsh, shapely, tidy3d,
  pyamg, devsim==2.11.0, Python 3.12), not the root project (DevLog-023 O2).
- `validation/cases/*.yaml` (21 files): canonical inputs in the same `eo-atlas.sim/v1` YAML, consumed unchanged by the
  engine and by the Python reference scripts. Families: K1 (Si strip), K2/K3 (TFLN rib air / SiO2 clad), K4 (G-S-G ES +
  EO), K5-g3..g8 (gap sweep), K6a/K6b (CPW conformal-map/FEM), K7 / K7K4 (off-centre waveguide D sweep), K10-K12 (Si
  PN / PIN DD). K8/K9 (S7 response, T-rail cell) live in `reference/s7-K8.json`, `s7-K9.json` (no YAML case).
- `validation/eoref/` = own reference library (es.py, fmode.py vector FEM N2/P2 femwell formulation, pockels.py,
  dd1d.py own 1D DD, semi_devsim.py DEVSIM models, plasma.py); `validation/scripts/ref_*.py` per family;
  `run_all.sh` serial with an RSS watchdog (kills > 1.8 GB), logs to `../logs/`.
- `validation/reference/*.json`: per-case outputs + `summary.json`, `summary-eo.json`, `summary-s8.json`, `gates.json`
  (package versions recorded: scikit-fem 12.0.2, femwell 0.1.12, gmsh 4.15.2, tidy3d 2.12.0, ...).

### 4b. Tiers [F] (DevLog-023:116-135)

| Tier | Content | Status |
|---|---|---|
| A analytic | plates, slabs, PEC guide, SPP, uniform-field Pockels, conformal-map CPW, 1D PN closed forms | in engine tests |
| B cross-solver | femwell / scikit-fem (primary), tidy3d local FD mode solver (sanity only, not a gate), DEVSIM (S8); COMSOL excluded by user ("No COMSOL runs", DevLog-023:277) | K1-K7, K10-K12 gated |
| C paper simulated | paper's own simulated n_RF, Z0, VpiL | targets in configs |
| D paper measured / sweeps | renaud2023 Vpi vs gap and wavelength, etc. | targets + sweep_targets |

### 4c. How expected values and tolerances are stored [F]

- Reference: `summary.json` per case per quantity `{value, U, f_finest, method, p}` (Richardson extrapolation with an
  uncertainty U; e.g. K1 FEM n_eff 2.4472234 +- 5.9e-7, tidy3d 2.44655 +- 0.036 as sanity) plus `case_sha256`.
- Engine side: `engine/tests/reference-cases.test.mjs` reads cases and summary at test time; tolerance = U + per-case
  engine budget at the test mesh, budget ~2.5x the measured difference, listed in the file header with the measured
  values (`reference-cases.test.mjs:1-30`). Heavy cases behind `ENGINE_REFERENCE_FULL=1`.
- Paper targets live in each config (`targets`, `sweep_targets`, with `tol_rel`/`tol_abs`, `comparable`, `basis`).
  The runner reports `status: pass | fail | not_evaluated` + reason + diagnostic per target and `targetSummary`
  (evaluated vs passed counted separately). CLI exit 2 on any failed target.

### 4d. Counts and pass status [F]

- Cross-solver: 15/15 reference tests pass (DevLog-043:246). Example agreements: K2 n_eff +1.1e-6, K3 -1e-7 vs
  femwell; K4 push-pull VpiL -0.15 % at P2 scale 1.5 (DevLog-025:292-312).
- Papers: all 42 configs `unvalidated`; 10 blocked by missing inputs or geometry faults (DevLog-023:570-572); 7 error
  for missing RF permittivity (DevLog-036:147-152). Measured VpiL misses (mao2022, renaud2023, arabjuneghani2022 #2,
  boynton2020) attributed to inputs/fabrication, not solver error (DevLog-029). renaud2023 vector: gap 2/4 pass,
  wavelength 3/5 pass (DevLog-026:678). Bandwidth: boynton2020, mao2022, yang2022 pass; arabjuneghani2022 roll-off
  fail; several not_evaluated (DevLog-036:181-192).
- Policy: "Neither a passing test run nor opening the UI changes `validation_status`" (engine/README).

[I] The validation design (case YAML shared by engine and references, Richardson U stored with the reference,
budget documented next to the measured difference, sanity-only vs gating references) is directly reusable and is the
strongest transferable asset after the numerics core.

---

## 5. UI/UX (`/sim`)

### 5a. Layout and structure [F]

- `app/src/routes/sim/+page.svelte` (73 LOC) = shell; `lib/sim/SimPage.svelte` imported after mount (DevLog-046).
- Toolbar / [Model Builder tree | Settings | Graphics] / bottom tabs Messages, Progress, Log, Table; pointer and
  keyboard splitters, sizes in localStorage (try/catch); <= 760 px stacks into one column (DevLog-027 Layout).
- Model tree nodes (`ModelTree.svelte`): Parameters, Materials, Geometry, Mesh, Physics (Electrostatics, Mode
  Analysis, EO Coupling, RF Line, Semiconductor), Study (Stationary + Mode, Parametric Sweep, Bias Sweep), Results
  (Datasets, Selections, Cut Line 2D, Cut Point 2D, 2D/1D Plot Groups, Derived Values, Tables, Export, Targets);
  context menu Rename/Duplicate/Move/Delete.
- State: `workbench.svelte.ts` (909 LOC, one runes class: text, section, stages, jobs, results, log, staleness),
  `results.svelte.ts` (578 LOC, COMSOL Results model with undo/redo), `post/session.ts` + `post/contract.ts` (typed
  worker postproc protocol), `sim.worker.ts` (158 LOC: run, point, mesh, post: datasets/variables/modes/plot/derived/
  line/check; cancel = terminate).
- Staleness: mesh key and result key; stale results stay visible with a marker (COMSOL behavior, UI-D1); a new
  solution keeps plot groups/selections/tables (R5).

### 5b. Visualization tech [F]

- Own WebGL2 renderer (`renderer.ts`, 755 LOC), no deps: de-indexed triangle buffers, one indexed draw per layer,
  layers = COMSOL features (surface, contour in fragment shader up to 64 levels, region, instanced arrows), wireframe
  from barycentrics with `fwidth`, 256-entry colormap texture, scales linear / symmetric / log10 / signed-log;
  LRU buffer cache per (mesh, r); context-loss recovery; Canvas 2D fallback (flat sub-triangles, marching-triangle
  contours) (`renderer.ts:1-8`, DevLog-027 U1/U6).
- Colormaps: Rainbow (default), RainbowLight, Thermal, Wave, Viridis, Cividis, GrayScale (`colormap.ts:18`); anchors are
  own approximations of COMSOL's described ramps (DevLog-032).
- DevLog-034 interpolation: user request "the optical field plot is discrete across mesh elements. Do proper at least
  quadratic interpolation." Solution: element-local barycentric lattice of level r (Normal r = 3), values evaluated
  exactly from each element basis in the engine (`postproc/refine.mjs`, shared with UI), Gouraud within
  sub-triangles, COMSOL smoothing options (None / Inside material domains (default) / Everywhere). Drawn = exact to
  1e-15 interior; drawn-field error decays r^-2; Max/Min marker uses exact value, probe reports both exact and drawn
  when smoothing changes it.
- 1D plots: own Canvas 2D `LinePlot.svelte` / `Plot1D.svelte` (nice ticks, log toggles, hover, paper overlay points,
  PNG/CSV). Plotly removed from /sim (D7); still on /explore (lazy split bundles).
- Hover probe = exact point evaluation in the worker (coalesced), not interpolation of drawn values (R3).

### 5c. Interactions [F]

Pan (drag), wheel zoom at cursor, zoom extents / to window / zoom box, select mode for domain selections
(shift-click adds), cut line drawing, two-finger pinch + `touch-action: pan-y`, export Data/Table/Image, shareable URL
state (config id, param overrides, study, stages scoped to config), `?pool=`, `?renderer=canvas`, `?debug=1`. No
single-key mode toggles found (only Enter/Escape handlers; grep of `keydown`), contrary to DevLog-000 section 7.

### 5d. What the user liked, asked for or corrected [F, quotes from DevLogs]

| Date | User statement | Outcome |
|---|---|---|
| 2026-10-14 | Requirements: browser only, no server, minimal deps; "Ruthlessly optimize for performance"; COMSOL-like UI "while staying clean, simple, straightforward" (DevLog-023:11-18) | D1-D8 decisions |
| 2026-10-14 | "No COMSOL runs. Cross-checks use open-source packages"; orchestrator delegates all coding; validation by fresh-context subagents (DevLog-023:275-280) | validation/ lane |
| 2026-10-15 | "Solver seems to run, but visualization and eval should follow similar specs as COMSOL's UI/UX has." (DevLog-030:13) | Results model rebuild (DevLog-031/032) |
| 2026-10-15 | "the optical field plot is discrete across mesh elements. Do proper at least quadratic interpolation. It should be quite standard." (DevLog-034:13) | refined lattice plots |
| 2026-10-16 | "Why is the optical and semicond solver mutually exclusive?"; config switch "inherits and could even enable the blocked solver. Make sure the UI/UX logic is consistent." (DevLog-043:13-15) | `stage-compat.mjs`, per-config state reset |
| 2026-11-03 | "Any tab/page/subpage should start showing and loading after max 100 ms, ~10 ms preferred." (DevLog-046:12) | load-performance work |

[I] Pattern: the user corrects (a) arbitrary rules that are not physics (stage exclusivity), (b) state leaking
between models, (c) visibly non-standard FEM postprocessing, (d) slow first paint. All four are design requirements
for applied-multiphysics from day one.

---

## 6. Agent surface

[F]
- CLI `engine/cli.mjs` (134 LOC): `node cli.mjs CONFIG.yaml [--stages ...] [--optical] [--section] [--mesh-scale]
  [--param name=value ...] [--solver vector|scalar] [--mode-only] [--check] [--sweep [STUDY]] [--list-points]
  [--eval EXPR --dataset --kind --over --point --line --unit] [--list-vars] [--modes DATASET] [--num-modes N]`.
  JSON to stdout, progress to stderr, exit 0 / 1 (error) / 2 (failed target). `--check` = per-stage readiness without
  solving. Nothing is written to disk.
- Programmatic: `runCrossSection(text, opts)`, `inspectConfig`, `stageCompatibility`, `enumerateSweep`,
  `runSweepPoint`, `createSolutionStore` + `evaluatePlot/evaluateDerived` (same in Node and worker); `.d.mts` type
  stubs for config, fields, mesh-entry, optical-stage, params, run, stage-compat, sweep, templates, yaml-edit.
- Agent editing = text edits of the YAML or `yaml-edit.mjs` `setIn` by dotted path.
- Browser hooks for agents/tests: `window.__simWorkbench` (dev or `?debug=1`, `SimPage.svelte:34`), `__simProbe`,
  `__simView`, `__simMarkers`, `__simDrawn` (`Graphics.svelte:983-995`); Playwright smoke `app/scripts/smoke.mjs`
  (1,438 LOC) drives the real UI and compares browser values to Node (1e-9).
- Absent: HTTP API, MCP server, persisted run records (no input hash + engine version + timestamp record), job queue.

[I] The CLI + `--check` + `--eval` with exit codes is a good agent contract; it lacks a run record and a
mutation API with history. Debug hooks on `window` are the seed of "agent inspects the GUI" from DevLog-000 section 4.

---

## 7. Known weaknesses, tech debt, open items

[F] (from DevLogs; [I] where marked)
1. 2D cross-section only; no 3D, no thermal, no mechanics, no time domain, no driven full-wave. RF is quasi-TEM 2D
   (`quasi_static_2d_rf` label). Nothing here addresses DevLog-000 D8 (3D RF and package) directly.
2. 80,000-vertex per-mesh cap; several reference and paper configs need mesh scale 2 to run.
3. Time targets unmet: renaud2023 vector single run 1.4 s vs < 0.5 s; sweep 5.8 s (4 pts) vs < 3 s (10 pts).
4. WASM SIMD kernel proposed (est. 2.2x on factorization), never built. No multi-threaded factorization.
5. Lossy-metal mode loss not converged at default mesh (label on every lossy result); no metal-surface refinement.
6. Scalar optics kept as a legacy approximate path with an open audit todo (D5); P2 never added to it.
7. Wheeler recess needs 3 extra meshes and solves (mesh-morphing proposal undecided).
8. Build Selected / Up To Here not implemented; geometry has no separate build step.
9. Field datasets per sweep point not retained (only globals; sweep store keeps <= 2 full stores).
10. Free YAML edits not encoded in share links; no undo for model edits.
11. Semiconductor stage cannot be swept in the UI; Delta n range dominated by contact regions.
12. S7 open items: tan delta sources for 12 periodic configs; sideband dB convention unconfirmed per paper; frequency-
    dependent conductor K not implemented (DevLog-036:267-284).
13. Materials library has 4 entries; LiTaO3, SiN, BCB, BTO RF permittivity missing (blocks 10 configs).
14. [I] `run.mjs` builds three separately coded result objects (cross-section, mode-only, semiconductor-only); the
    stage graph is hard-coded per path rather than a generic DAG.
15. [I] `vector-mode.mjs` (1,868 LOC) mixes the generic eigen solver with EO perturbation and Pockels code;
    `postproc/store.mjs` hard-imports EO dataset builders. Both need splitting before reuse.
16. [I] Stale comments (`semi-stage.mjs` header says the runner does not dispatch it; `semi/run-cli.mjs` "until
    engine/cli.mjs dispatches it").
17. [I] Two validation definitions (JSON Schema + `config.mjs` code) must be kept in sync by tests.
18. [I] Mesher is polygon-only (no curves, no CAD import, no persistent IDs); fine for 2D EO cuts, insufficient for
    packaging layouts (GDS-scale polygon counts, TSV circles) without a different geometry kernel.

Rights note [F]: engine is GPL-3.0-or-later (`engine/LICENSE`, package.json), lineage eo_fem (GPL); algorithms are
re-implemented from published descriptions (Davis CSparse book, EISPACK, Lee-Sun-Cendes), Shewchuk Triangle explicitly
excluded; InP-Modulator (no license) used for formulas only, clean-room (DevLog-023:107). [I] Compatible with
applied-multiphysics GPL-3.0-or-later; a per-file provenance check is still prudent before copying (DevLog-000 rule for
the harness repo applies in spirit).

---

## 8. Reuse recommendation for applied-multiphysics

Categories: **AS-IS** = extract as-is into shared core; **GEN** = extract with generalization; **KEEP** = EO-specific,
keep in eo-atlas (or as an EO plugin); **REDESIGN**.

| Module / asset | Recommendation | Reason |
|---|---|---|
| `sparse.mjs` | AS-IS | Physics-free, benchmarked supernodal Cholesky + AMD with oracle; core of any browser FEM. |
| `ldlt.mjs` | AS-IS | Generic indefinite / complex-symmetric LDL^T needed by any shift-invert or saddle-point solve. |
| `vector-dense.mjs`, `complex.mjs` | AS-IS | Small, dependency-free numerics. |
| `semi/linear.mjs` (GMRES, Bernoulli) | AS-IS | Generic Krylov; move out of `semi/`. |
| `fem.mjs` | GEN | P1/P2 triangle assembly is generic; needs element abstraction (tets, quadrature, vector-valued) for 3D. |
| `geometry.mjs` | AS-IS | Plain polygon utilities. |
| `mesh.mjs` | GEN | Keep as the zero-install browser 2D mesher; add named entity tags; Gmsh/OCC remains the 3D and CAD path per DevLog-000. |
| `section.mjs` | REDESIGN | Painter-order classification conflicts with DevLog-000 explicit selection semantics and persistent IDs. |
| `recess.mjs` | KEEP | Wheeler-specific use; general offsetting belongs in the geometry kernel. |
| `electrostatics.mjs` | GEN | Split anisotropic Poisson (generic, reusable for thermal conduction too) from C'/Z0 line post. |
| `optics.mjs` (scalar) | KEEP | Legacy approximate path; vector solver supersedes it. |
| `vector-mode.mjs` | GEN | Split: generic Nedelec/Lagrange 2D port-mode eigen solver (useful for waveguide ports of a 3D RF solve) vs EO perturbation / Pockels (KEEP). |
| `optical-stage.mjs` | KEEP | EO-stage dispatch and warm cache tied to EO flow. |
| `eo-overlap.mjs`, `eo-response.mjs`, `stages.mjs`, `postproc/eo-analysis.mjs` | KEEP | TFLN/MZM conventions. |
| `rf-line.mjs`, `loaded-line.mjs` | GEN (partial) | RLGC, ABCD, Bloch cascade are generic TL utilities; strip EO config coupling; useful as analytic gates for Palace transmission-line cases (M3). |
| `semi/*`, `semi-stage.mjs` | KEEP (models.mjs: GEN) | Si phase-shifter specific; `models.mjs` sourced Si models could seed the materials package. |
| `materials.mjs` + `data/materials.json` | GEN | Citation-per-value schema matches DevLog-000 section 5; convert to one-YAML-per-material package; keep tensor rotation helpers. |
| `params.mjs` | GEN | Safe expression evaluator; merge with `postproc/expr.mjs` into one expression language with units. |
| `postproc/expr.mjs`, `units.mjs` | AS-IS | Generic, eval-free, SI dimension vectors, complex-aware. |
| `postproc/refine.mjs` | AS-IS | Exact element-local lattice display + smoothing shared by engine and UI; the user explicitly asked for this. |
| `postproc/evaluate.mjs` | GEN | Derived values / cut lines are generic; needs 3D and boundary selections. |
| `postproc/store.mjs`, `sweep-store.mjs` | GEN | Keep the registry/LRU/exact-evaluation design; replace hard-coded EO dataset builders with a backend-provided dataset interface (VTU/typed arrays per DevLog-000). |
| `config.mjs` | REDESIGN | EO-shaped hand validator; replace with one typed schema (Pydantic -> JSON Schema -> TS) and keep its rules: strict keys, no physical defaults, per-stage readiness with reasons. |
| `sim.schema.json` | REDESIGN | Generate from the typed model, do not hand-maintain. |
| `yaml-edit.mjs` | AS-IS | Comment-preserving verified splice editing is exactly what GUI + agent co-editing needs. |
| `templates.mjs` | GEN (mechanism) / KEEP (`tfln_rib_gsg`) | Template-expands-to-plain-geometry pattern generalizes to layer-stack/package templates. |
| `sweep.mjs` | GEN | Enumerate-by-index for worker pools, cancellation, content-hash reuse are general; decouple from `run.mjs`. |
| `stage-compat.mjs` | GEN (pattern) | One rule function shared by runner and UI with reasons; reimplement over a generic stage/physics DAG. |
| `run.mjs` | REDESIGN | Three hand-built result paths; replace with a generic study DAG and a persisted run record (inputs hash, engine version, timings, warnings). |
| `fields.mjs` | GEN | FNV content hash + transferable export generic; field shape is EO. |
| `mesh-entry.mjs` | GEN | "Mesh without solve" entry is a needed UI action. |
| `cli.mjs` | GEN | Keep the contract (JSON stdout, stderr progress, `--check`, `--eval`, exit 2 on failed target); add run records and HTTP/MCP on the same API. |
| `bench/bench.mjs` | AS-IS (pattern) | Frozen-`--src` A/B + JSONL + leaf-wise baseline compare is the right perf-regression harness. |
| `validation/` structure | GEN | Shared case files, Richardson U in reference JSON, documented budgets, sanity-only vs gating, RSS watchdog; replace EO cases with thermal/RF/package cases. |
| `app/src/lib/sim/renderer.ts`, `colormap.ts`, `ticks.ts`, `colorbar.ts`, `LinePlot.svelte`, `Plot1D.svelte`, `Splitter.svelte`, `Tooltip.svelte` | GEN | Dependency-free WebGL2 2D field renderer and plotting are reusable; 3D viewer is a separate decision (DevLog-000 open). |
| `results.svelte.ts`, `post/contract.ts`, `post/session.ts`, `PlotGroupSettings`, `DerivedValues`, `ExprInput` | GEN | COMSOL Results model (datasets, plot groups with layered features, selections, derived values, tables, undo) is physics-agnostic in design. |
| `workbench.svelte.ts`, `ModelTree.svelte`, `Settings.svelte` | REDESIGN | Fixed EO node set; rebuild as schema-driven tree/forms; carry over staleness keys and per-config state reset (DevLog-043). |
| `EoCoupling`, `EoPoint`, `RfPoint`, `SemiResults`, `BiasSelect`, `semi*.ts` | KEEP | EO/semi pages. |
| `app/scripts/smoke.mjs` + `window.__sim*` hooks | GEN (pattern) | Browser-vs-Node equality smoke and debug hooks are the basis of agent GUI inspection. |
| DevLog-046 load pattern (shell + lazy workbench, SW cache) | GEN | Directly meets the stated 100 ms tab budget pattern. |

---

## 9. Decision-relevant summary (15 lines)

1. A working, tested browser FEM core exists (GPL-3.0-or-later, 2 runtime deps): supernodal Cholesky + AMD, indefinite/complex LDL^T, Arnoldi, GMRES, P1/P2 and Nedelec order 1/2 on triangles; it is the natural "light backend" DevLog-000 assigned to scikit-fem.
2. It is 2D only (triangles, polygons, 80k-vertex cap); nothing addresses 3D RF/package (D8). Palace/MOOSE remain necessary for the first vertical.
3. Measured speed (Node, M4 Pro): 27-49k-node 2D ES runs 0.17-0.32 s (P1, incl. mesh), vector modes 32-56k DOF solve 0.25-0.39 s + 0.13-0.19 s model build, all in JS; time targets for full EO runs and sweeps (< 0.5 s, < 3 s/10 pts) were not met.
4. WASM SIMD gate measured 3.8x on the kernel, ~2.2x estimated end-to-end; never built. No WebGPU anywhere. No SharedArrayBuffer by design (Pages cannot set COOP/COEP).
5. After optimization, meshing (35-45 %) is the dominant ES phase; the own JS mesher is the next bottleneck and is polygon-only, no persistent IDs.
6. Generic, extract-as-is candidates: sparse, ldlt, vector-dense, complex, GMRES, geometry, yaml-edit, postproc expr/units/refine, bench harness.
7. Extract-with-generalization: fem, mesh, Poisson part of electrostatics, Nedelec mode solver (as a port-mode solver), params, sweep, store/evaluate, materials library, RLGC/ABCD utilities, WebGL2 renderer, Results UI model.
8. Redesign: config.mjs + hand-maintained JSON Schema (two sources of truth, EO-shaped), section.mjs painter-order regions (contradicts DevLog-000 explicit selections), run.mjs (three hard-coded result paths), fixed EO Model Builder tree.
9. Spec model strengths to keep: YAML canonical with verified comment-preserving splices, strict keys, no physical defaults, per-stage readiness with reasons, provenance class per dotted path, `missing` / `limitations` fields.
10. Spec gaps: units in key suffixes, no boundary selections or entity IDs, no model-edit undo/rollback (D3), results carry no engine version / input hash / timestamp (no run records).
11. Validation design is the most transferable process asset: case YAML shared by engine and Python references, Richardson U stored with each reference, per-case budget documented next to the measured difference, sanity-only vs gating references, 15/15 cross-solver gates pass; all 42 paper configs remain `unvalidated` by policy.
12. Reference stack already proven in uv: femwell, scikit-fem, gmsh 4.15.2, tidy3d local mode solver (sanity only), DEVSIM 2.11.0 (Apache-2.0); COMSOL excluded by the user.
13. UI assets worth carrying: own WebGL2 layered renderer (60 fps at 1M sub-triangles, first paint 78 ms), exact refined-lattice plots with COMSOL smoothing (user-requested), exact worker-side probe, COMSOL Results model with undo.
14. User corrections to design in from day one: no non-physics stage rules, no state leakage across configs, standard FEM postprocessing, < 100 ms tab paint (shell + lazy workbench + SW cache).
15. Agent surface is CLI-only (JSON stdout, `--check`, `--eval`, exit 2 on failed target) plus `window.__sim*` debug hooks; no HTTP API, MCP or persisted run records yet.
