# DevLog-001: Plan - browser-native PoC with hero examples, and the evaluation set

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Status | Plan (research R1-R5 done; proposed decisions awaiting Wentao's answers, section 4) |
| Scope | Goal reset vs DevLog-000, inherited findings from eo-modulator-atlas and advanced-packaging-atlas, architecture, guidelines, workstreams, lanes, milestones |
| Authors | Claude (Opus 5.5, coordinator), at Wentao Jiang's request |
| Research | `DevLog/research/2026-11-06-R1..R5-*.md` |

## 1. Request (Wentao, 2026-11-06)

Two parallel efforts:
1. PoC running with a list of hero / canonical examples.
2. Evaluation set (accuracy and solver speed), classes: (a) analytic / textbook, (b) reproducible results from papers and proceedings, (c) reproducible results from other simulation software public libraries and physics datasets (e.g. COMSOL library, The Well).

Grand goal: a multiphysics solver that runs in the browser as far as possible. It should democratize simulation and give kids and students an exciting, satisfying tool. It must be snappy, with smooth, beautiful visualization, and good enough that incumbent vendors feel threatened. Agent native:
- (a) a chatbot navigates to the place to change, or implements the change;
- (b) it builds memory of the user's simulation types and configs, like Claude and Codex memory;
- (c) every AI operation is visualizable, inspectable and modifiable by the human: geometry, physics, mesh, solver, visualization and numeric-evaluation settings.

## 2. What changed since DevLog-000 (2026-09-28)

| DevLog-000 | Status now | Reason |
|---|---|---|
| D1 first vertical = photonics + RF + thermal for packaging | Superseded (proposed): general multiphysics via a hero set; packaging and photonics stay the depth verticals through the atlases | New goal is general + educational |
| D2 local-first web app with native backends (Palace, MOOSE) | Superseded (proposed): browser-native engine; native solvers only as desktop references in `validation/` | Both atlases already run native JS engines in the browser; Wentao 2026-10-21 (APA DevLog-013:71): "no Palace. Make native EM solver in browser" |
| D3 direct edits with rollback, no approval gate | Kept; now implemented as an operation log (A4) | Neither atlas has undo/rollback for model edits (R1 s.2, R2 s.7) |
| D4 COMSOL as reference | Superseded (Q5) | COMSOL is not used as a reference in this project |
| D5 GPL-3.0-or-later | Kept | Atlas engines are GPL-3.0-or-later; Palace-derived algorithms carry Apache-2.0 NOTICE (compatible) |
| D7 monorepo, materials package | Kept | |
| D8 3D RF and package priority | Superseded (proposed) by the hero set | |
| Section 4 Gmsh + OCC + Pydantic spec + scikit-fem light backend | Superseded (proposed): TS typed spec; JS 2D mesher + structured/prism meshers; fTetWild/MMG/manifold WASM for 3D (R4) | Browser-only constraint |

## 3. Inherited state (facts from R1, R2, R4)

| Item | Finding | Source |
|---|---|---|
| Existing engine code | EO 18.1k LOC (2D: P1/P2, Nedelec 1-2 on triangles, supernodal Cholesky + AMD, indefinite/complex LDLT, Arnoldi, GMRES, drift-diffusion, postproc expressions/units/refine). APA 34.8k LOC (3D thermal, elasticity Q1im + GMG, em2d RLGC, em3d Nedelec 1-2 + p-MG + PROM sweep, homogenization, families). Deps: `yaml` (+ `robust-predicates` in EO). Same code in Worker and Node | R1 s.1, R2 s.1 |
| Shared modules | sparse, ldlt, complex, params, geometry identical except header; APA's own extraction rule (5 identical modules) is met | R2 s.2 |
| Speed | 2D ES 27-49k nodes 0.17-0.32 s; vector modes 32-56k DOF 0.25-0.39 s (Node, M4 Pro). Browser thermal 1.12e6 nodes 17.9 s; mechanics 1.08e6 DOF 106-226 s at 1.29-1.54 GiB; EM direct ~6e4 DOF | R1 s.3, R2 s.4 |
| Accelerators | WASM SIMD: EO 3.8x kernel / ~2.2x est. end-to-end, never built; APA 1.37-1.82x, opt-in. WebGPU and threads never tried. No f64 in WGSL | R1, R2, R4 s.1 |
| Binding limit | Geometry and meshing: EO polygons only, painter-order regions, 80k-vertex cap; APA axis-aligned boxes and layered extrusions; no persistent entity IDs anywhere | R1 s.2, R2 s.8 |
| Spec | YAML canonical text with comment-preserving splice, strict keys, provenance per value, `missing`/`assumptions`. Gaps: units in key suffixes, no boundary selections, no entity IDs, no run records (no engine version, input hash, timestamp), hand-kept 2.9k-line JSON Schema (EO) or none (APA) | R1 s.2, R2 s.3 |
| Validation | Same case YAML read by engine and Python references; Richardson uncertainty; EO 15/15 cross-solver gates; APA 62 cases, tiers A-D + H, scikit-fem 1e-10 K / 1e-8 agreement; paper cases limited by undisclosed inputs | R1 s.4, R2 s.5 |
| UI to carry over | EO WebGL2 layered field renderer (vsync at ~1M sub-triangles, first paint 78 ms), refined-lattice smoothing, worker hover probe, COMSOL-style Results model; APA three.js field material, worker slices/isosurfaces/arrows, compare A/B, VTU export, provenance badges; <100 ms tab load (shell + lazy workbench + service worker) | R1 s.5, R2 s.6 |
| Agent surface | CLI only (JSON, exit 2 on missed target) and `window.__sim*` hooks; no API, MCP or run records | R1 s.6, R2 s.7 |
| Browser 3D meshing | WASM builds exist since 2026-07..10: fTetWild (MPL-2.0, 0.7 MB gz, serial), MMG (LGPL-3.0+, 0.4 MB), gmsh (GPL-2.0+, 11.6 MB, needs cross-origin isolation), manifold-3d (0.2 MB). Single maintainer, so pin and keep build scripts | R4 s.2 |
| Hosting | GitHub Pages cannot set COOP/COEP (no threads/SharedArrayBuffer); Cloudflare Pages, Netlify can | R4 s.1 |
| Competitors | COMSOL 2027 MCP server announced 2026-09-16; SimScale agent free on all plans 2026-09-29; Tidy3D FlexAgent MCP; none publishes a typed diffable spec with a reversible per-operation timeline | R5 s.1-2 |
| Agent evidence | FEABench: 88 % executable COMSOL API calls, at best 1/15 valid targets. FoamBench: single agent 96.4 %, minus error-feedback repair 71.8 % | R5 s.3 |

## 4. Proposed decisions (awaiting answers; final versions go to section 5)

Architecture:

| # | Proposal |
|---|---|
| A1 | **Engine home.** This repo becomes the canonical engine. Generic modules are extracted from both atlases into `packages/` here, with a port header (source repo, path, commit). The atlases are not touched; they migrate later on their own schedule. (Q1) |
| A2 | **Language.** New code in TypeScript, erasable syntax only, so Node 23 runs it without a build and Vite bundles it for the browser. Ported `.mjs` numerics come in as-is with `.d.mts` types and are converted when they are next edited. (Q2) |
| A3 | **Model spec.** One typed schema, defined in TS and exported as JSON Schema for agents and validation (no second hand-kept schema). YAML is the canonical text, keeping the atlas comment-preserving splice. Units are values (`{value, unit}` or `"2 mm"`), not key suffixes. Domains, boundaries, edges and points carry persistent entity IDs taken from the geometry construction history; selections are explicit ID sets, with no painter-order semantics. Provenance per value, and `missing`/`assumptions` blocks, come over from the atlases. |
| A4 | **Operation log.** Every edit, from the UI or the agent, is an operation: JSON patch, inverse patch, actor (`user` or `agent:<session>`), reason, validation result and invalidated artifacts (mesh, solution, plots). The log is hash-chained. Revert appends inverse operations, and undo/redo/timeline are built on the log. Agents edit only through operations. |
| A5 | **Run records.** Every solve stores engine version, spec hash, mesh hash, timings per stage, DOF, solver stats, platform probe (browser, cores, GPU) and ISO timestamp. Results are typed arrays, never nested JSON. Solver outputs are never committed. |
| A6 | **Geometry.** Tier 1 (PoC): 2D sketch plus CSG primitives (in-house, with robust predicates), axisymmetric, extrusion and revolve. Tier 2: 3D CSG via manifold-3d; STEP import via occt-wasm or replicad, lazy-loaded. Persistent IDs on every tier. |
| A7 | **Meshing.** 2D: the EO constrained-Delaunay mesher, generalized and with its vertex cap lifted. 3D: APA structured/prism meshers for layered parts, and fTetWild plus MMG (WASM, lazy) for general tets, via a spike in wave 1. gmsh-wasm only as an expert mode on a cross-origin-isolated host. |
| A8 | **Solvers.** Direct: supernodal LDLT (real, complex, indefinite). Iterative: PCG + GMG/AMG and GMRES + p-MG, with AMS wired for H(curl). Eigen: shift-invert Arnoldi. Time stepping: BDF/generalized-alpha. Newton for nonlinear problems. Accelerators sit behind measured gates (EO D4, APA A9): WASM SIMD at >2x end-to-end; WebGPU f32 inner solves inside f64 refinement at >=5x with the same answer. |
| A9 | **Two engine tiers.** (i) Rigorous: implicit FEM, validated by the eval set. (ii) Real-time: explicit WebGPU kernels (LBM, FDTD, reaction-diffusion, split-step BPM) for instant, interactive play. Real-time results carry a `fidelity: realtime` badge and have their own eval gates against the rigorous tier or the class-c datasets. (Q3) |
| A10 | **Visualization.** three.js r187 WebGLRenderer with field materials written in TSL (runs on WebGL now and ports to WebGPU later). The EO WebGL2 2D renderer is ported, along with worker postprocessing: slices, isosurfaces, streamlines/LIC, arrows, deformation, animation of time and phase. Smooth by default: refined-lattice interpolation and perceptual colormaps. |
| A11 | **Agent.** The tool API is the operation API (A4) plus navigation tools: focus node, open settings, highlight a selection in the 3D view, set a camera, take a screenshot. Navigation changes UI state only. Memory is plain, user-editable files (local OPFS, exportable to a folder) recording sim types, preferred materials, mesh/solver defaults and units; memory writes are also operations. Text inside shared models is untrusted data. (Q7) |
| A12 | **Eval.** Schema `amp-eval/0` (R3 s.2) in `eval/cases/<class>/<id>.yaml`. The engine and the Python references read the same case file. Metrics: accuracy per target with tolerance and locator; speed as time-to-accuracy plus CEED-style DOF x iterations/s; median of 5 runs after one warm-up. Results go to JSONL with the run record. Large reference fields go to a Hugging Face dataset, referenced by hash. |
| A13 | **Hosting.** Static, no server. Cloudflare Pages with COOP/COEP, which enables threads and gmsh-wasm; worker-pool fallback when not cross-origin isolated. (Q6) |

Performance targets (R5 s.2, Nielsen limits; atlas targets):
- Drag-to-repaint (visualization-only change) < 100 ms.
- Coarse re-solve on a parameter drag < 1 s.
- Hero full-accuracy solve < 5 s on an M-series laptop in Chrome or Safari.
- Anything over 10 s runs in the background with progress.
- First paint < 100 ms on tab switch.

## 5. Decisions (Wentao)

Answers received 2026-11-06, about 15:10 PST, via the question dialog.

| Q | Decision | Effect |
|---|---|---|
| Q1 | Extract here | A1 adopted. The atlases are untouched and migrate later |
| Q2 | TS for new code, ported `.mjs` kept with `.d.mts` | A2 adopted |
| Q3 | All four bundles: wave-1 FEM classics, fluids, real-time GPU tier, coupled + periodic | H1-H13 all in PoC scope (wave 1 first). A9 two-tier engine adopted. Lane L6 launches in wave 1 |
| Q4 | 2D / axisym / extruded + 3D tet spike | A6 tier 1 and A7 adopted; the L3 spike is in wave 1 |
| Q5 | Not used | No COMSOL runs, COMSOL files or COMSOL-generated values in this repo. Class c uses open solvers and datasets |
| Q6 | Cloudflare Pages | A13 adopted: COOP/COEP headers, threads allowed, worker-pool fallback. Domain name: TBD (Wentao) |
| Q7 | Bring-your-own key in the browser only | A11 provider is BYO key, stored locally only and never sent anywhere except the provider. MCP server, hosted proxy and local models were not selected and are out of scope for now; L9 drops the MCP server |
| Q8 | Pro workbench + Play view per hero | One COMSOL-grade workbench; each hero also gets a Play view (big canvas, few sliders, presets, share URL) |
| Git | Local git only | `git init`, commits to `main`, no remote until Wentao says |

## 6. Guidelines (binding for all lanes)

- **Style:** no emoji anywhere. ISO dates. Dark by default. Sharp corners on every element, fixed per style with no global override; spinners exempt. Dense layout, minimal text, details in hover tooltips. COMSOL-grade layout: Model Builder tree, Settings, Graphics, Messages/Log/Progress. Log rows start with a timestamp.
- **Plots:** data only, with no titles, captions or takeaways. Absolute units, log toggles, 3 significant figures in hover. Generated by code.
- **Field visuals:** perceptual colormaps (viridis/cividis/cmocean family, diverging for signed quantities). Smooth interpolation by default, wireframe toggle, colorbar in absolute units, deformation scale automatic at about 10 % of geometry size, shown and editable (APA decision 2026-10-20). Animation for time and phase. Every effect encodes a physical quantity.
- **Interaction (R5 s.2):**
  - Direct manipulation on the canvas first.
  - Every parameter has a slider plus an exact field.
  - Presets, and share-by-URL that holds the full spec.
  - A calm start scene.
  - No UI option that the backend does not implement.
  - Missing evidence shows as unavailable, never green.
- **Physics honesty:** never invent a number. Every material value has a basis and source, or `N/A`. No physical defaults hidden in code. Readiness and limitations are shown per study. No stage rules that are not physics (EO correction, DevLog-043).
- **Validation first:** a hero ships only with at least one passing eval gate and a convergence study. Analytic cases first, then open reference solvers, then papers. Never tune to a target.
- **Rights:** per-file provenance check before porting. Apache-2.0-derived files keep their NOTICE and change headers. No COMSOL files or COMSOL-generated values (Q5). Cite original sources, not vendor manuals. Licences to exclude: Triangle, MUMPS, unlicensed repos, non-commercial or no-derivatives documentation (R3 s.6, R4 s.7).
- **Machine:** one CPU-heavy process per lane, `nice -n 10`, Node heap capped at 1.5 GB, Python BLAS threads 1-2. Check ports before binding; ad-hoc servers use uncommon ports. Long jobs run in tmux. Logs carry a timestamp in the filename under `logs/`.
- **Process:**
  - Each lane writes its plan into its own DevLog before coding and owns only its listed paths.
  - Subagents do not run git; the coordinator commits.
  - A fresh-context audit follows each lane's hand-off.

## 7. Repository layout (proposed)

```
packages/core       la (sparse, ldlt, krylov, mg, amg, arnoldi), fem (H1 P1-P2, Nedelec 1-2, quadrature), expr, units, params, sweep
packages/geom       sketch, CSG, extrude/revolve, structured grid, persistent IDs; adapters for manifold/fTetWild/MMG (lazy)
packages/mesh       2D CDT (EO), prism/structured (APA), tet adapters, quality, refinement
packages/spec       TS schema -> JSON Schema, YAML splice, operation log, run records, migrations
packages/physics    heat, elastic, electrostatics, magnetostatics (axisym), currents, acoustics, modes (scalar/vector), em3d, flow (Stokes/NS), transport, couplings
packages/rt         WebGPU real-time kernels (LBM, FDTD, reaction-diffusion, BPM)
packages/post       solution store, expressions on fields, slices/isosurfaces/streamlines, probes, derived values, export (CSV, VTU)
packages/agent      tool schemas, navigation tools, memory store, provider adapters, MCP server (Node)
packages/eval       case loader (amp-eval/0), runner (Node + browser), metrics, speed bench, report
apps/web            SvelteKit static workbench + Play view per hero
eval/cases/{a,b,c}  case YAML; eval/expected/ generated reference JSON
validation/         uv project: scikit-fem, NGSolve, femwell, DEVSIM, MPB/Meep where installable; reference generators
materials/          YAML per material, value + unit + basis + source + ISO date + range
DevLog/             DevLog-NNN, research/, audits/, lanes/
```

## 8. Hero examples (proposed; final list after Q3 and the first timing run)

Wave 1 reuses existing solvers. Wave 2 needs new physics.

| ID | Hero | Physics / method | Eval gate (R3 id) | Reuse | Wave |
|---|---|---|---|---|---|
| H1 | Plate with a hole: drag the hole, watch the stress concentration | 2D elasticity P2 | SM-01 Kirsch K_t = 3; SM-02 LE1 92.7 MPa | EO fem/mesh (new 2D vector elasticity) | 1 |
| H2 | Heat-spreading plate and fin, steady and transient | heat P1/P2 | HT-01 T4 18.3 C; HT-02 T3 36.60 C; HT-03 T2 927 K | EO fem, APA thermal BCs | 1 |
| H3 | Helmholtz coil, field lines and uniformity | axisym magnetostatics | EM-04 8.99176 uT; EM-03 Palace rings | EO fem (axisym weights) | 1 |
| H4 | Si rib waveguide modes, vector fields | vector mode solver | WO-01 slab; WO-02 Hadley rib | EO vector-mode | 1 |
| H5 | Cylindrical cavity eigenmodes, animated E/H | 3D Nedelec eigen | RF-01 TM010 2.9036 GHz | APA em3d + EO Arnoldi | 1 |
| H6 | Room acoustics: box modes, then a driven room | 3D Helmholtz | AC-02 171.500 Hz ... | APA grid + Arnoldi | 1 |
| H7 | Photonic crystal band diagram | 2D Bloch-periodic eigen | WO-04 MPB gap 0.2826-0.4193 | new periodic BCs | 2 |
| H8 | Lid-driven cavity, Re slider | 2D NS, Taylor-Hood + Newton | FL-02 Ghia / Botella-Peyret | new | 2 |
| H9 | Cylinder in a channel: steady to vortex street | 2D NS (rigorous) + LBM (real-time) | FL-03 c_D 5.5795; FL-04 St 0.295-0.305 | new | 2 |
| H10 | Natural convection in a heated box | heat + NS | CP-01 de Vahl Davis Nu | new | 2 |
| H11 | Microheater on a Si waveguide: Joule heat, thermal stress, thermo-optic shift | currents + heat + elasticity + modes | CP-03/CP-05-style gates; CP-09 proposed | EO + APA chain | 2 |
| H12 | Turing patterns (Gray-Scott), live on the GPU | WebGPU reaction-diffusion | TR-03 The Well VRMSE | new rt | 2 |
| H13 | Wave tank / antenna, live | WebGPU FDTD | Changed 2026-11-06 (L6): Yee dispersion vs analytic, CPML reflection, PEC cavity TM11 vs analytic, in place of the RF-04 trend / AC-01 duct gates originally planned | new rt (volna/webantenna MIT as reference) | 2 |

## 9. Workstreams and lanes (proposed)

Lanes own disjoint paths. The coordinator owns `DevLog/DevLog-001*`, root config and contracts, and does all git. At most 10 subagents run at once.

| Lane | Scope | Owns | Depends on | Wave |
|---|---|---|---|---|
| L0 | Scaffold: git init, pnpm workspace, LICENSE, README, CLAUDE.md for agents, test/check scripts, contracts doc (spec v0 types, result format, worker protocol) | root, `DevLog/contracts/` | Q1, Q2 | coordinator, first |
| L1 | Core extraction: la, fem, expr, units, params, sweep from EO/APA with port headers and their tests | `packages/core` | L0 | 1 |
| L2 | Spec v0, YAML splice, entity IDs, operation log, run records | `packages/spec` | L0 contracts | 1 |
| L3 | Geometry + 2D mesh generalization; 3D tet spike (fTetWild + MMG + manifold in a worker) with a timing table | `packages/geom`, `packages/mesh` | L0 | 1 |
| L4 | Physics wave 1 (H1-H6) on core + spec | `packages/physics`, `packages/post` | L1, L2 (stubs allowed) | 1b |
| L5 | Workbench + Play view, renderer ports, operation timeline UI | `apps/web` | L0 contracts; L4 results | 1b |
| L6 | Real-time WebGPU kernels (H12, H13, LBM for H9) and a platform probe | `packages/rt` | L0 | 1 (if Q3 includes it) |
| L7a | Eval class a: case YAML + reference generators (closed forms, series) | `eval/cases/a`, `validation/a/` | R3 schema | 1 |
| L7b | Eval class b: paper cases, digitization protocol, locators | `eval/cases/b`, `validation/b/` | R3 schema | 1 |
| L7c | Eval class c: open-solver suites (Palace docs, Code_Aster, deal.II, MPB/Meep, DEVSIM, FEATFLOW, NASA TMR) and datasets (The Well, PDEBench) metadata | `eval/cases/c`, `validation/c/` | R3 schema; Q5 | 1 |
| L8 | Eval harness: loader, runner (Node + browser), metrics, speed bench, JSONL, report page | `packages/eval` | L0, L7 schema | 1 |
| L9 | Agent: tool schemas generated from operations, navigation tools, memory store, provider adapters, MCP server, agent task suite | `packages/agent` | L2 | 2 |

Wave 1 at launch: L1, L2, L3, L6, L7a, L7b, L7c, L8 (8 lanes). L4 and L5 start once the L1/L2 interfaces exist (stubs are fine), within the 10-lane cap.

## 10. Milestones

| M | Exit criteria |
|---|---|
| M0 | Scaffold; contracts; `pnpm check` and `pnpm test` green on an empty workspace |
| M1 | Eval set v0: at least 30 cases with schema-valid YAML and generated expected values, in all three classes; harness runs them in Node and reports accuracy + time |
| M2 | PoC: H1-H6 run in the browser end to end (spec -> mesh -> solve -> beautiful results), each passing its eval gate and meeting the <5 s target on an M-series laptop; operation log with undo |
| M3 | Agent v0: chat panel drives the operation and navigation tools, memory files, agent task suite with code checkers |
| M4 | Wave-2 heroes (NS, periodic, coupled, real-time GPU) |
| M5 | Public deployment; atlas migration plan |

Fresh-context audits follow M1, M2 and M3 (twice for M2).

## 11. Open questions (for Wentao)

Q1 engine home, Q2 language, Q3 hero scope / real-time tier, Q4 geometry scope for the PoC, Q5 COMSOL as reference, Q6 hosting, Q7 LLM providers, Q8 audience modes. Asked 2026-11-06 via the question dialog; answers go to section 5.

## 12. TODO

- [x] Research R1-R5
- [x] This plan (proposed decisions, guidelines, lanes)
- [x] Answers Q1-Q8 recorded in section 5
- [x] L0 scaffold and contracts (`DevLog/contracts/CONTRACTS-v0.md`, `CLAUDE.md`, workspace root; local git `main`, no remote)
- [x] Wave 1 lanes launched: L1 DevLog-002, L2 DevLog-003, L3 DevLog-004, L6 DevLog-005, L7a DevLog-006, L7b DevLog-007, L7c DevLog-008, L8 DevLog-009
- [ ] Wave 1b: L4 physics H1-H6 (DevLog-010) and L5 workbench + Play view (DevLog-011), once the L1/L2 interfaces exist
- [ ] Wave 2: L9 agent (DevLog-012; BYO key only), heroes H7-H13
- [ ] Fresh-context audit after each wave-1 lane hand-off (done: L1, L2, L7a; running: L3, L6, L7b, L7c; queued: L8)
- [ ] RF-04 (dipole): the 3 % conductance gate rests on L7a's own Hallen moment-method solver, which no published finite-radius table has checked. Set it to `gate: false` until it is cross-checked against a published table (e.g. King's), or against an open MoM code such as NEC-2 run via uv where feasible.
- [ ] Self-generated references must be cross-checked before they gate: RF-04 (L7a Hallen MoM), WO-04 / WO-61 (L7c plane-wave solver must reproduce MPB at MPB's own tutorial resolution to MPB's printed digits), SC-02 (float128 DEVSIM, same code as the golden: acceptable, since it is the same solver tightened). Until then these targets are `gate: false`, or carry a recorded cross-check.
- [x] Decided 2026-11-06 (Wentao delegated: 'use your best judgement'; coordinator ACCEPTS): L6 narrowed the H9 Strouhal gate scope after seeing failures (DevLog-005 s.10.2). The gate is now TRT only, D >= 20, u_max >= 0.025, because BGK diverges at tau 0.54 and a noisy low-u_max signal gave spurious zero crossings; hysteresis was added to the St estimator. Rationale: domain of validity, not tuning to a target. Accepted because BGK at tau 0.54 is a known instability regime and the low-u_max case fails by signal noise, not by physics; the excluded configurations stay excluded from the real-time tier and documented.
- [ ] H5 3D reference path: the third nested level peaked at 4.3 GB RSS (the direct factor sits outside the V8 heap cap), above the per-lane memory rule. Future 3D runs of this size need the iterative AMS eigen path (not built) or a run on the remote GPU box. The interactive H5 uses `emw-axisym` (all six modes at 1e-5, 2.54 s Node).
- [x] H6 speed (resolved 2026-11-06 by P1, see progress log): AC-02 was at 5.5 s end to end in Node (L4 Follow-up 4: direct tet10 box levels; was 8.3 s), still over the 5 s target. The coordinator tested L4's proposal to shorten the level ladder on the harness (17:30): [1, 2/3, 1/2] is rejected by the case's ratio_min 1.5, and [1, 2/3, 4/9] takes 1.5 s but fails 4/10 modes. Case not changed. Remaining cost is factor (2.67 s) and eigen (1.74 s) at the finest level: L4 then tried block size, Arnoldi basis, shift, nested dissection and the existing complex WASM LDL^T (3.7 s vs real Cholesky 2.6 s): none helps. The candidate is a real-valued WASM SIMD supernodal front update in @amp/core (not built).
- [ ] Visual design pass (coordinator's own look at logs/L5-play-kirsch-plate-1440-20261107T013227.png, 17:35). The physics is correct (K_t 3.021, peak marker, MPa colorbar), but the view is plain, not gorgeous:
  - The camera frames the whole 200 mm quarter plate, so the hole region is a small corner. Auto-frame the region of interest, with zoom-to-feature.
  - The dashed hole outline is drawn outside the domain.
  - The colorbar overlaps the field.
  - Three contours only.
  - No symmetry mirroring to show the full plate.
  Per the L5 audit, the 2D Play views rate 5/10 and 3D Play 4/10. Next: a dedicated design-focused lane with screenshot review per view.
- [ ] Wentao (next): manual downloads of paywalled sources: DevLog-007 s.5 list, plus Turek-Hron 2006 and Boucher 1981 (PZT-4 constants). Put them in a local folder (not committed) and tell the coordinator the path.
- [ ] Contracts v1 pass at the end of wave 1: C2 facet blocks, `tagHash`, L3's optional fields into `@amp/spec`, affine units (`degC`, `lbf`), `prepareRun`/`sample` in the C4/C5 text.
- [ ] Fresh-context audit of the research reports R3-R5 (unaudited at hand-off)
- [ ] Fresh-context audit of this plan

- [x] Wave 3 (Wentao feedback 2026-11-06 20:49 PST; plan written before launch). Lanes, owners and DevLogs:
  - W1 field rendering quality (DevLog-019): smooth interpolation of solved fields (P2 / nodal, no faceted per-cell flat colour; 2D and 3D). Owns `apps/web/src/lib/gfx/renderer2d.ts`, `field-material.ts`, `viewer3d.ts`, `lib/post/field2d.ts`, `post.worker.ts`, `solid3d.ts`, `revolve.ts`.
  - W2 workbench UX (DevLog-020): resizable panels (agent panel first), auto-switch to Results after Compute, sweep dataset selector, click probe with a Table tab in the bottom panel (x, y, z, field, value, unit), model-tree selection drives the view mode (geometry / mesh / results). Owns `Workbench.svelte`, `Graphics.svelte`, `Canvas2D.svelte`, `Canvas3D.svelte`, `Bottom.svelte`, `Settings.svelte`, `lib/state/*`, `session.svelte.ts`, `AgentPanel.svelte`, new `lib/post/probe.ts`.
  - W3 example library + class-a sims (DevLog-021): categorized library picker, catalog, sims for as many class-a eval cases as the current physics supports, each solved and compared with eval/expected. Owns `sims/` (class-a files), new `apps/web/src/lib/library/**`.
  - W4 class-b/c sims (DevLog-022): same for classes b and c; catalog entries in `lib/library/catalog-bc.ts`.
  - W5 results-system scoping (DevLog-023, plan only, no code): datasets (solution, sweep, cut line, cut plane, revolution, mirror), plot groups (1D / 2D / 3D) and plot types, derived values, tables, exports; staged plan.
  - W6 feature-parity inventory (DevLog-024, read only): web features in eo-modulator-atlas and advanced-packaging-atlas missing here.
  - Rules for all: no `pnpm build` (shared `apps/web/build`; coordinator builds), dev server on an own free uncommon port, no git, no engine package edits (record needs instead), fresh-context audit after hand-off.

- [x] Results system R0-R3 (Wentao go 2026-11-06 22:30 PST; decisions DevLog-023 s.5.1). Phase A in parallel: R0 schema + contracts C3/C10 + migration of every sim and eval-embedded spec (DevLog-025, owns `packages/spec`, `sims/*.yaml` results blocks, `eval/cases` embedded specs' results, `apps/web/src/lib/post/headline.ts`, CONTRACTS changelog entries); R1 kernels in `@amp/post` with analytic Node gates (DevLog-026, owns `packages/post`). Kernel API takes plain geometric arguments, not spec nodes. Phase B after A: R2 Results tree + 2D/1D plot groups + cut-line drawing + LinePlot port + agent `show_plot` (DevLog-027); R3 evaluation groups + tables + probe pin + agent `evaluate` / `get_table` + headlines from evaluation nodes + harness extract by results node (DevLog-028). No export (TODO).
- [ ] Export (later): CSV, PNG, VTU, MP4 (Wentao 2026-11-06).

## 13. Progress log

- 2026-11-06 14:30 PST: Read DevLog-000 and the sim DevLogs of both atlases (APA 010, 014; EO 023 decisions). Five read-only research lanes launched: R1 EO engine/UI, R2 APA engine/UI, R3 eval sources, R4 browser tech, R5 landscape and agent-native.
- 2026-11-06 15:00 PST: R1-R5 reports in `DevLog/research/`. This plan written. No code, no git, no installs.
- 2026-11-06 15:0x PST (before the 15:08 commit): Wentao answered Q1-Q8 plus git (section 5), then went out.
- 2026-11-06 15:08 PST (commit time): L0 scaffold: LICENSE (GPL-3.0, same sha1 as both atlases), root package.json / pnpm-workspace / tsconfig.base, .gitignore, README, CLAUDE.md, contracts v0; `git init`, first commit on `main`. Wave 1 launched about 15:10 with 8 background lanes (L1, L2, L3, L6, L7a, L7b, L7c, L8).
- 2026-11-06 15:37 PST: L1 (core) and L7a (eval class a) done and committed (ca93b68, 3698b3f). Contract changelog started. L1 audit and L4 physics launched.
- 2026-11-06 15:45 PST: L7b (eval class b, 20 cases) and L2 (spec + op log) done and committed (9ff1d75, ce9db2c). validation/ gains pillow and matplotlib (L7b CR-3). Launched L5 web (DevLog-011), materials lane L10 (DevLog-013; new lane, needed by L2, L4 and L7b) and the L2 audit.
- 2026-11-06 15:47 PST: L1 audit: no blocking findings; S1 (tri-fe assumes micrometre coordinates) sent to L4, and L1 resumed to fix S1-S3. Audit committed (79f9e87). Timestamps in the contract changelog corrected to commit times (the earlier entries had guessed times). The L7b audit is queued because of the 10-agent cap.
- 2026-11-06 16:27 PST: Wave 1 status. Done and committed: L1 core, L2 spec + oplog v1, L3 geom/mesh, L6 rt, L7a/L7b/L7c eval (85 cases: 29 a, 20 b, 36 c), L8 harness, L10 materials (13 materials), L4 physics (H1, H2, H3, H4, H6 pass their gates at 1e-5..1e-9 rel; H5 4/6 modes, TM110/TE011 pre-asymptotic, 22 s for 6 modes; correction from the L4 audit B1: the reported 2.2 s for the three hero RF modes relied on Richardson over N = 2-4 with observed order 5.48 > theoretical 4. With order 4, TM010 fails at -1.41e-5. A robust pass needs N = 4-6, which takes 22 s, so H5 does NOT meet <5 s at 1e-5 yet). Fresh-context audits done for L1, L2, L3, L6, L7a, L7b, L7c, L8; corrections applied for L1, L2, L3, L7a, L7b; L6, L7c and L8 fixes in progress. L4 and L10 audits running. L5 web and L9 agent in progress. Contracts-v1 items assigned to L2 (spec) and L3 (refineUniform, tet10).

- 2026-11-06 17:24 PST: M2 engine half reached, per I1 (DevLog-014, commit ef3cc9b; fresh-context M2 audit running). All six heroes pass their eval gates on the real engine through the harness (spec -> geometry -> mesh -> solve -> extract -> gate, nested levels [1, 0.5, 0.25]), Node end-to-end:
  - H1 SM-01 5/5, worst -2.8e-6, 0.83 s.
  - H2 HT-01/02/03, worst -1.6e-6, 0.02-0.42 s.
  - H3 EM-04 -3.0e-6, 1.18 s.
  - H4 WO-01 TE0/TM0, 4.5e-9, 0.92 s.
  - H5 RF-21 7/7 via emw-axisym, 2.14 s.
  - H6 AC-02 10/10, 4.5e-7, 6.25 s (misses <5 s).
  Class a: 9 pass, 2 fail (SM-02 and HT-04, on the fallback rule only; L8 is relaxing it), 18 pending (non-hero). Browser (L5): first paint 36-38 ms, coarse previews 17-396 ms, full solves 0.22 s (2D heroes, box), 2.7 s (cavity, before the axisym switch), 3.8 s (rib). The browser path's mesh hashes equal Node's. Open for M2: H6 speed, the WO-02 sweep target, chat panel mount (L5 pass 2), the M2 audit.
- 2026-11-06 17:40 PST: CORRECTION of the M2 engine status entry above, from the fresh-context M2 audit (DevLog/audits/2026-11-06-M2-integration-audit.md):
  - Accuracy gates are confirmed: values come from the engine, the levels are truly nested, no tolerance or reference changed, and the SM-02 / HT-04 / WO-41 diagnoses hold (an independent P2 SM-02 solve gives 92.658 MPa).
  - The M2 engine half is NOT complete.
    - H6 is 8.4 s cold / 5.4-6.25 s warm, over 5 s.
    - H5's full RF-21 gate takes 15.2 s cold; the quoted 2.14 s excluded Q_d, whose 3D identity check alone costs 13.1 s.
    - H1-H4 meet <5 s in Node, but the earlier figures were warm (cached meshes) and must not be mixed with cold ones.
    - Browser timing at gated accuracy has never been measured.
    - Browser Play runs single coarse levels that miss gate tolerances (box at 693 DOF: 3.3e-3 vs 1e-4).
  - Wrong figures in the entry above: H1 worst error is 4.7e-5 (not -2.8e-6); the WO-01 orders came from a harness bug; see the audit's S8.
  - Harness bug S1: the mesh-size ratio is derived with the case's dimension label instead of the spec's. WO-01's true orders are 3.98 / 3.95. Pass/fail is unchanged.
  - Follow-ups assigned: L8 (S1, S2 cold/warm labelling, S5 a stricter fallback that requires shrinking level-to-level changes), L7a (HT-02 / HT-04 dt refinement via dt_with_h; RF-21 Q_d identity check on one coarse level), V1 (browser full-accuracy mode with measured timing; H4 Play handle t -> t_slab).
- 2026-11-06 18:08 PST: P1 (DevLog-016) has made a real f64 WASM SIMD supernodal front kernel the default for real SPD/LDL^T. Gate passed 2 of 3: AC-02 2.72x and APA grid 2.43x on the factor; EO 2D 1.34x, below the gate. Results are bitwise identical to the JS path. Coordinator rerun at 18:07: AC-02 harness 10/10 pass, case time 4.27 s cold (logs/eval-20261106T180730.jsonl, with V1 running concurrently); core 81/81. All six heroes now meet <5 s cold end to end in Node. Since then: RF-21 3.09 s cold (Q_d on the coarsest level), HT-04 21.9 s cold (dt refined with h; a non-hero transient case). Browser timing at gated accuracy is pending from V1.
- Open (minor): eval JSONL meta `source_detail` contains an absolute local path. Make it repo-relative (L8).

- 2026-11-06 18:14 PST: V1 visual design pass done (DevLog-015, commit 8d42fd4):
  - Self-ratings: Kirsch 5 -> 8, heat 5 -> 8.5, Helmholtz 5 -> 8.5, cavity 4 -> 8, box 4 -> 7, rib 5 -> 6.5.
  - The browser full-accuracy mode re-solves on the case's nested levels after each run, with a Richardson badge that is green only with evidence. Cold load to gated accuracy (headless, software WebGL): kirsch 2.22 s, heat 2.14 s, helmholtz 2.17 s, cavity 2.50 s, box 3.99 s; rib skipped (h 0.5 would be 1.3M DOF; it overflowed the em-modes stack, so a 1M DOF cap now skips it).
  - Coordinator looked at logs/V1-play-kirsch-plate-1440-20261107T020855.png: a centred mirrored plate with contour lobes, the peak label and a separate colorbar strip; a clear improvement.
  - Open: em-axisym stores E = 0 at tri6 mid nodes (L4 bug); rib accuracy mode; a fresh-context audit of web pass 2 + V1 is running.
- 2026-11-06 18:49 PST: Repo published at github.com/jwt625/applied-multiphysics (public). Before the push the history was rewritten with git-filter-repo to remove 14 session scratch paths containing the local username (backup bundle in the session scratchpad); CLAUDE.md now forbids local paths in tracked files. Fixed the frozen-lockfile install (workspace:* for internal deps; stray apps/web lockfile removed); a fresh clone builds apps/web (4.1 MB, 199 files). Web pass 2 + V1 audit: B1 (eigen badge mode mismatch), S1-S5 and M1 fixed; em-axisym mid-node field fixed (L4). Deployment to Cloudflare Pages waits on Wentao: domain, connection method (Git integration recommended), and a review of the public COMSOL-hold text.
- 2026-11-06 19:01 PST: Wentao's answers, round 2:
  1. Deploy as a subroute of the blog: outside5sigma.com/applied-multiphysics via a Cloudflare Worker route to Cloudflare Pages (the zone is already proxied). Lane D1 (DevLog-017) prepares the base path, headers and Worker.
  2. Cloudflare setup is done by Wentao through the Claude Chrome extension, from a prompt the coordinator provides.
  3. Redact the COMSOL licence discussion: done in the tree (commit 718ab83). History rewrite awaits confirmation.
  4. Live agent trial with DeepSeek: the key comes from the local opencode config (never printed); the API lists deepseek-flash and deepseek-v4-pro; deepseek-flash tool calling was verified by the coordinator (1.6 s). Lane L9b (DevLog-018), with a USD 2 cap.
  5. H9 gate scope: accepted (see TODO).
  6. MPB: allowed via conda; an existing env (volcoupler, meep 1.34.0) is used read-only, no new install (the disk is 97 % full). L7c gates WO-04 / WO-61.
  7. Paywalled downloads: TODO for Wentao.

- 2026-11-06 19:21 PST: First live-model agent trial (L9b, DevLog-018). deepseek-flash (the docs name it DeepSeek-V4.1-Flash-1017), OpenAI-compatible adapter, key read at runtime from the local opencode auth file and never written anywhere (coordinator scan: 0 hits in staged files and logs). Results:
  - 27-task suite, 132 calls, USD 0.071 at peak rates (cap USD 2.00), cache hits 89 %, median call 1.8 s.
  - 13/27 pass; 13/23 counting only tasks whose checker is valid for a live model; about 19/23 with outcome-based grading per L9b.
  - Real failures: T01 broke the W/D >= 20 validity condition; T17 once filled an N/A value (likely from spec comments); T03 also edited provenance text; T19 an invalid fixture PNG left in history.
  - Injection resisted 4/4. No wrong-tool choices; 1 schema error in 132 calls, self-repaired.
  Next for the agent: outcome-only checkers, fixture fixes, validity conditions surfaced to the agent before edits, a rule against touching provenance in the same op, a provider selector in the web app with connect-src api.deepseek.com.
- 2026-11-06 19:21 PST: Deployment prep done (D1, DevLog-017, commit 5ed4bce): BASE_PATH build, scoped _headers / _redirects, route Worker deploy/worker.js (8/8 tests), 26/26 local subpath checks. A Chrome-extension prompt for the Cloudflare setup was given to Wentao; waiting on its report.
- 2026-11-06 20:33 PST: Live at https://outside5sigma.com/applied-multiphysics/ (Pages project + route Worker + path Configuration Rule, set up by Wentao via the Chrome extension; first build 34c4818). Coordinator checks (DevLog-017 s.6): headers, 301, blog pass-through, crossOriginIsolated and SW scope pass on 5 pages. Found zone-edge injection (Bot Fight Mode JS detections, Web Analytics beacon) blocked by the meta CSP: console errors only. Fix: no-transform on HTML; live recheck after the rebuild. Missing paths 404 without a page (follow-up).
- 2026-11-06 20:49 PST: Wentao feedback on the live app (missing atlas features: interpolation, resizable panels, auto results, sweep datasets, probe table; bigger categorized library; tree-driven view mode; COMSOL-like results scoping). Wave 3 lanes W1-W6 planned in s.12 and launched.
- 2026-11-06 21:27 PST: Wave 3 lanes back. W1 (DevLog-019): the faceting was the DG0 em-modes fields (per-cell values); now recovered to corners per domain and drawn with per-pixel P2 evaluation; H1 views were already smooth (pixel diffs <= 0.2 %). W2 (DevLog-020): splitters, auto Results, workbench-only sweep runner + dataset selector, click probe + Table tab, tree-driven view mode; own audit 11 findings fixed. W3 (DevLog-021): LibraryPicker + catalog, class a 14/29 pass (new SM-21, RF-02, WO-21). W4 (DevLog-022): 12 sims, 13/56 b/c cases with a sim, engine gaps ranked. W5 (DevLog-023) results-system plan R0-R7 with 5 questions; W6 (DevLog-024) parity inventory, top-10 missing. Coordinator: picker mounted in the workbench (panel position fixed, the toolbar clipped it); acoustics-module analogs of EM problems hidden from the picker (field shown as Pa); vector-mode.mjs Math.max spread -> loop (stack overflow on large meshes, found by W4). Gates: pnpm test 419/419, pnpm check 0/0, shots.ts pass (op-log identical, mesh hash 6/6, errors none), base-check 26/26. Fresh-context audit running.
- 2026-11-06 21:53 PST: Wave 3 audit (DevLog/audits/AUDIT-wave3-2026-11-06.md): 0 blocker, 1 major, 8 minor. Fixed: M1 (smoothed DG0 colour range / peak now from exact cell values; note shown), m2 (texture width vs MAX_TEXTURE_SIZE, fallback), m3 (Raw toggle in 3D), m4 (3D buffers reused) by W1; m1 (Mesh after a sweep), m5 (sweep keeps 3 meshes/solutions, scalars for all), m8 (probe or pick pins the dataset) by W2; m6 by W4 (WO-02 rerun on 3 levels after the vector-mode fix: 7/8 thicknesses within 1.0e-6 of the reference, last-level change <= 2.5e-7; t = 0 not modelled). m7 decision (coordinator): poisson-square stays listed (valid heat problem, mapping stated in the catalog); acoustics-module EM analogs stay hidden from the picker. Gates after fixes: pnpm test 419/419, check 0/0, shots.ts pass. Open: 3D P2 colour range over drawn face values; Mesh after a single Compute marks the result out of date (pre-existing); sweep cap is a count, not a byte budget; finest WO-02 levels peaked 2.5-5.5 GB RSS (direct factor outside the heap cap).
- 2026-11-06 22:30 PST: History rewritten to drop the redacted text from all past commits (git filter-repo --replace-text, 21 line pairs; HEAD tree unchanged; 88 -> 87 commits, the redaction commit became empty) and force-pushed with lease: main 02c0628. Pre-rewrite bundle in session scratch. Results-system answers recorded (DevLog-023 s.5.1); R0 and R1 launched.
- 2026-11-06 23:17 PST: Results phase A done. R0 (DevLog-025): grouped results schema (datasets / evaluations / tables / plots; exports key reserved and rejected), C10 in CONTRACTS, 41 specs migrated by a rerunnable script, kirsch kt bitwise equal, class a statuses identical, agent suite 27/27; own audit 26 findings, 21 fixed. R1 (DevLog-026): expr / datasets / evaluations in @amp/post, gates 1-6 pass at expected orders, gate-7 Node fixture hash ready; own audit fixed a curved-cell cut-line bug; coordinator sign-off on gate 5c (identity) and the extra Kirsch level. Gates: pnpm test 440/440, check 0/0, shots.ts pass, base-check 26/26. Phase B (R2, R3) launched.
- 2026-11-07 00:26 PST: Results phase B done. R2 (DevLog-027): Results tree folders + "+" menus (add / duplicate / disable / move / delete with dependents, all ops), 2D plot groups (surface, contour, max/min, point, line, arrow, deformation, mesh), 1D groups with the LinePlot port, quick view + save, cut-line / cut-point drawing (drag = 1 op), showPlot hook, browser gate-7 hash equal to Node; own audit 22 findings, 17 fixed. R3 (DevLog-028): results api / adapter / worker messages with artifact cache, evaluation tables + probe pin, headlines from evaluation nodes (kirsch kt bitwise unchanged), agent evaluate / get_table / show_plot (suite 29/29), harness result extract (class a 136/136 identical); own audit 13 findings fixed or recorded. R2's last root test run was cut off when the lane ended; coordinator reran all gates on the merged tree: pnpm test 449/449, check 0/0, shots.ts pass, base-check 26/26. Open (DevLog-027 s.7, DevLog-028 s.6): sweep axes for point / global / table graphs (R5), height / streamline / 3D groups (R4), stress unit name J/m^3 instead of Pa when no display unit, pinned probes listed as headlines, adapter to move into a package (contracts v2).
