# DevLog-037: roadmap after the multiphysics wave, chunk 1 and chunk 2 (coordinator)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | coordinator (proposal, lane plans, integration, audits, git) |
| Owns | this file, `packages/physics/src/registrations.ts` and `driver.ts` (lanes may add only the lines named in their brief), `DevLog/contracts/CONTRACTS-v0.md` changelog, git |
| Request | Wentao, 2026-11-18: "inspect repo, and propose next steps (subprojects and tasks). Keep in mind the overarching goal is to have a browser based multiphysics solver that attacks photonics/optics as well as advanced packaging first. There are at least 2-3 aspects: 1. sourcing and implementing more and better and more complex examples for the library. 2. improve capability and performance of the solvers. 3. improve interactivity and consistency and testing of the UI/UX." Then: "divide the work into two chunks, first one start implementing now with coordinated subagents, and second chunk setup a timer at 1:15 pm PT today to kick them off. cmt and push each chunk when done. Within each chunk always plan out more details and then orchestrate subagents to implement, take notes in devlogs as usual, and cmt & push once tested and validated." |
| Inputs | three read-only inventories (examples/eval, solvers/perf, UI/testing), 2026-11-18 08:36-08:42 PST; DevLog-001, -024, -029, -034 read by the coordinator |

Conventions: F = fact read from code or files; E = estimate; D = decision; O = open item.

## 1. State on 2026-11-18 (facts from the inventories)

Library and eval
- F: 48 sims (33 2D, 10 axisym, 5 3D). 15 photonics, 9 RF; 1 real packaging case (chip-warpage-2d, qualitative). 5 of the 15 photonics sims are acoustic scalar analogs and are hidden in the UI.
- F: 85 eval cases (a 29, b 20, c 36). 13 pass on the harness CLI. 14 more pass only through scratch runners; the case `spec:` still says pending. 0 fail. 53 have no sim.
- F: 4 cases point at sim ids that do not exist (WO-21, RF-02, WO-04, EM-61). 45 `sims/*.yaml` paths referenced by cases do not exist. CP-02, SM-02, SM-05 and SM-22 cite expected JSONs that are missing. Wrong `# eval:` headers: helmholtz-coil (EM-03), kirsch-plate (SM-02), cylinder-cavity-axisym (omits RF-01).
- F: materials: 15. Missing for photonics: SiN, Ge, InP/InGaAsP, AlGaAs, AlN, LiTaO3, TiO2/Ta2O5, SU-8/BCB, ITO, Al, heater metals (TiN, NiCr, Pt, W); no photoelastic property type. Missing for packaging: underfill, EMC mold compound, ABF, BT core, polyimide, SAC305/SnAg solder, Ni, Ta/TaN, borosilicate glass, low-k, SiC. `chip-warpage-2d.yaml` hard-codes core, underfill and Si values.

Solvers
- F: no driven frequency-domain FEM solve. No PML, ports, impedance, scattering or Floquet BC anywhere in physics. Every EM and acoustic interface is eigen-only with PEC/PMC/sound-hard closure. The only PML is the CPML in the rt FDTD kernel.
- F: complex LDL^T (supernodal, blocked, WASM), complex GMRES, p-MG (ND2 -> ND1) and AMS are in core; only lossy em-modes uses the complex factor; AMS and p-MG are not wired.
- F: em-modes accepts `epsIm` and reports `lossDbPerM`, but the spec route never sets it. No material dispersion (n_g uses eps_g = eps).
- F: 3D in the spec route is a box list (hex8) or one cylinder (tet4); anything else errors with "3D CSG is tier 2". `extrudeLayered`, `meshExtruded`, `meshRevolved` exist but are not wired. prism6 has no shape functions.
- F: single-threaded everywhere (no SharedArrayBuffer, no WASM threads), although COOP/COEP are already served. AMG-PCG exists but is not settable from the spec.
- F: largest runs: em3d ND2 277k DOF 267 s at 4.3 GB RSS (direct); em-modes 520k DOF 12.5-37.8 s at 2.5-5.5 GB. Assembly scatter (binary search per entry) is about 25 % of assembly time (DevLog-033 O6). WASM triangular solve not built (DevLog-016).
- F: couplings are sequential one-way plus monolithic piezo and acoustic-structure (eigen); no staggered or fixed-point iteration; no temperature-dependent properties beyond radiation Newton.

UI/UX and testing
- F: apps/web `pnpm test` runs 16 tests in 4 files; `src/lib/results/plot-ops.test.ts` (6 tests) is outside the glob and never runs. No component tests, no Playwright assertion suite, no visual baselines, no CI (`.github/` absent).
- F: tree add/delete/duplicate/move exists for results nodes only; geometry, physics and BC nodes can be changed only through forms, YAML or the agent; no rename. No sweep-definition UI. Only the first study is solved (no study picker). plot3d groups and non-solution datasets are not drawn; height and streamline items not drawn.
- F: 7 sims have no plot groups (cylinder-cavity-axisym, nafems-le1, nafems-t2, nafems-t3, semi-infinite-convection, si-slab-te0, si-slab-tm0); cylinder-cavity-qd has no `results:` at all.
- F: duplicated code: the analog-hide rule (Workbench.svelte:50, Landing.svelte:16); the nav host (Workbench, Play); `state/nav.svelte.ts` redefines types that `@amp/agent` now exports. `Graphics.svelte` is 1091 lines.
- F: the agent has 23 tools. UI actions with no tool: cancel, sweep point selection, probes, quick-view settings, study choice, share. `set_camera` preset/look_at are rejected. The web app mounts only the Anthropic provider; the OpenAI-compatible provider in `@amp/agent` is unused.
- F: DevLog-024 parity items still missing: axes/ticks/scale bar/3D triad, sweep-vs-parameter plot, sweep-definition UI, eigenmode table, eval-target table, 3D camera presets, Messages badge, more colormaps and reverse, YAML download, view state in the link, expression autocomplete, run compare, click-to-select, ruler/zoom box, parallel sweep, GL fallback, display units, provenance table, study picker. Export stays deferred (Wentao, 2026-11-06).

Machine (2026-11-18 08:40 PST)
- F: data volume 2.3 GiB free (100 % used); 12 cores, 24 GB RAM. Repo footprint: node_modules 360 MB, cache 137 MB, validation/.venv 200 MB. Nothing outside the repo is touched. Consequence for lanes: no installs or browser downloads, small logs, no large build artifacts, RSS per heavy run <= 2 GB.

## 2. Proposal: subprojects and tasks

Ordered by leverage for photonics and packaging. Chunk assignment in brackets.

A. Library: more, better, more complex examples
- A1 Eval hygiene and reproducibility [1]: fix case pointers and headers, put the 14 scratch-runner passes into case `spec:` blocks so the CLI reproduces them, update `validation/*/build_cases.py`, add the missing expected JSONs, then one full harness run over all three classes.
- A2 Library consistency [1]: plot groups for the 7 sims without them, results for cylinder-cavity-qd, correct `# eval:` headers.
- A3 Materials for photonics and packaging [1]: about 20 sourced materials (list in s.1) and a photoelastic property type.
- A4 Photonics examples on the new solvers [2]: bend loss vs radius, directional coupler supermodes and coupling length, slot waveguide, SiN strip, Au surface plasmon (loss), rib substrate leakage, TFLN rib families from the EO atlas (K2-K4), combined TO + EO; driven 2D: Mie cylinder scattering, ring resonator Q, Bragg grating spectrum, waveguide junction S-parameters, 2D grating coupler.
- A5 Packaging examples on the new solvers [2]: TSV thermal stress (axisym, Ryu-style analytic gate, and 3D array), die-on-substrate 3D warpage, 2.5D interposer thermal map with several dies (junction-to-case resistance), microstrip / RDL C', L', Z0, hybrid-bond Cu pad expansion, solder-bump array thermal resistance, CPW on a Si interposer.
- A6 Real photonic-crystal bands (H7) once Bloch BCs exist [2].
- Later: Navier-Stokes heroes H8-H10 (cooling, microfluidics), drift-diffusion for Si PN modulators, 3D nanobeam optomechanics (needs 3D PML + iterative ND2).

B. Solver capability and performance
- B1 Driven complex scalar Helmholtz in 2D with PML, plane-wave scattered-field source and port excitation [1]. One kernel serves EM TE/TM (out-of-plane Ez or Hz) and frequency-domain acoustics.
- B2 Mode solver upgrades [1]: complex permittivity from the spec (metal loss), PML for leaky modes, bend modes by conformal transform, material dispersion for n_g.
- B3 3D geometry through the spec [1]: `extrude` feature (2D sketch to z layers), mixed box + cylinder 3D, prism or tet split shape functions, wired through `prepareRun`. Unlocks TSV, interposer, 3D waveguide and microheater models.
- B4 Performance, part 1 [1]: precomputed assembly scatter maps, WASM triangular solve, AMG-PCG and solver choice settable from the spec, timing table before and after.
- B5 Bloch/Floquet periodic BC [2] (enables A6 and grating unit cells).
- B6 Performance, part 2 [2]: AMS-preconditioned iterative path for 3D em (and AMG-PCG defaults for large 3D heat/elastic), parallel sweeps over several workers, browser timing at gated accuracy.
- Later: 3D driven EM with PML and ports, temperature-dependent properties with Newton, staggered two-way couplings, prestressed modal analysis, GDS import for photonic and packaging layouts, WebGPU-accelerated inner iterations.

C. UI/UX interactivity, consistency, testing
- C1 Test net and CI [1]: run `plot-ops.test.ts`; unit tests for probe, DG0 recovery, tree, params; a Playwright assertion smoke over every sim (load, mesh, compute, non-blank canvas, no console errors, headline value against the catalog reference); GitHub Actions workflow for check, test and a fast class-a eval subset.
- C2 Consistency [1]: one shared analog-hide rule, one nav-host type from `@amp/agent`, a study picker in the workbench (solve any study, DevLog-029 O3).
- C3 Interactivity [2]: tree add/delete/rename for geometry, material, physics and BC nodes; sweep-definition UI; sweep-vs-parameter 1D plot; eigenmode table.
- C4 Graphics [2]: complex and driven field display (Re, Im, |.|, phase, phase animation), spectrum and S-parameter 1D plots, axes/ticks/scale bar, more colormaps with reverse, 3D camera presets, view state in the link, split of `Graphics.svelte`.
- C5 Agent parity [2]: tools for cancel, sweep point, probes, quick-view settings, camera presets, study choice; provider selector with the OpenAI-compatible adapter (DeepSeek preset) and CSP entry.
- Deferred by Wentao: export (CSV, PNG, VTU, MP4).

## 3. Chunk 1 (start 2026-11-18 ~08:45 PST): foundations

Goal: a correctness net, a reproducible eval set and the solver capabilities that chunk 2's examples need.

| Lane | DevLog | Scope | Owns (exclusive) | Validation |
|---|---|---|---|---|
| T1 test net + CI | 038 | C1 | `apps/web/test/**`, `apps/web/scripts/e2e*.ts` (new), `apps/web/package.json` scripts, `src/lib/results/plot-ops.test.ts` (move), `.github/**` (new), root `package.json` scripts | apps/web `pnpm test` count rises, all green; e2e smoke over every listed sim green or each failure recorded as a real bug; workflow YAML linted by `actionlint` if present, else reviewed |
| T2 eval hygiene | 039 | A1 | `eval/**`, `validation/**`, `packages/eval/**` (harness bugs only) | full CLI run, all classes; summary log; pass count on the CLI >= 27 or each gap explained |
| T3 library + UI consistency | 040 | A2, C2 | `sims/*.yaml`, `apps/web/src/lib/library/**`, `apps/web/src/lib/landing/**`, `apps/web/src/lib/state/nav.svelte.ts`, `apps/web/src/lib/workbench/**` (study picker only), `apps/web/src/routes/play/**` (nav host only) | `pnpm check` green; every sim has results + plot groups; study picker solves pzt4-cube open circuit and membrane-air in vacuo in the browser |
| T4 materials | 041 | A3 | `materials/**`, `packages/materials/**` | validator green; every value sourced with ISO date or `N/A`; photoelastic tensor type with test |
| S1 driven Helmholtz + PML | 042 | B1 | `packages/physics/src/wave2d/**` (new); one import line and one spread line in `registrations.ts`, RESULT_NAMES entry, driver dispatch lines for the new type | gates: 2D cylinder scattering vs Bessel series, slab reflection vs Fresnel, PML reflection bound, acoustic duct transmission; tests in `packages/physics/test/` new files |
| S2 mode solver upgrades | 043 | B2 | `packages/physics/src/modes/**`, `couplings/photonic.ts` only if dispersion needs it | gates: planar Au/air surface plasmon vs analytic dispersion; leaky slab or published bend loss with PML; Si strip n_g with Sellmeier vs published value |
| S3 3D geometry | 044 | B3 | `packages/geom/**`, `packages/mesh/**`, `packages/physics/src/prepare.ts`, `packages/physics/src/common/lagrange.ts` | extruded box equals the box-grid heat/elastic result; Cu cylinder in Si box (TSV-like) 3D conduction vs 1D series/parallel bounds; mesh hashes identical across two runs |
| S4 performance 1 | 045 | B4 | `packages/core/**`, `packages/physics/src/common/**` except `lagrange.ts` | bitwise or 1e-12 identical results; before/after timing table on AC-02, H1, H4, a 3D tet10 modal; all package tests green |

Shared-file rule: `registrations.ts`, `driver.ts`, `packages/spec/**` and `CONTRACTS-v0.md` belong to the coordinator. A lane may add only the lines named in its brief, through Edit on a fresh read; anything else is filed as a request in its DevLog.

Integration (coordinator), in order: `pnpm check`, `pnpm test` (all packages), class-a CLI, T1 e2e smoke, fresh-context audit, fixes, then one commit and push of chunk 1.

## 4. Chunk 2 (timer 2026-11-18 13:15 PST): examples and interactivity on the new capabilities

Lane plans are written at 13:15 from chunk 1's hand-offs; the outline below is the starting point.

| Lane | Scope | Depends on |
|---|---|---|
| E1 photonics examples, driven | A4 driven: Mie cylinder, ring Q, Bragg spectrum, junction S-parameters, grating coupler | S1 |
| E2 photonics examples, modes | A4 modes: bend loss, coupler, slot, SiN, plasmon, leakage, TFLN K2-K4, TO + EO | S2, T4 |
| E3 packaging examples | A5 | S3, T4 |
| E4 Bloch BC + real H7 | B5, A6 | S1 complex path |
| E5 UI interactivity | C3 | T3 study picker |
| E6 UI graphics | C4 | S1 complex fields |
| E7 agent parity | C5 | E5 host methods |
| E8 performance 2 | B6 | S4 |

Start rule: if chunk 1 lanes are still running at 13:15, start only the chunk 2 lanes whose owned paths do not overlap a running lane, and queue the rest. Global cap: 10 concurrent subagents.

## 5. Open questions (not blocking; defaults taken)

- O1: GitHub Actions on the public repo (free minutes). Default: add one workflow (check, test, fast eval subset). Remove on request.
- O2: export remains deferred (Wentao 2026-11-06).
- O3: Navier-Stokes heroes H8-H10 and drift-diffusion are proposed for a chunk 3, not scheduled.

## 6. TODO

- [x] Inventories (3 read-only subagents)
- [x] This proposal and chunk plans
- [x] Chunk 1 lanes T1, T2, T3, T4, S1, S2, S3, S4 launched
- [x] Chunk 2 timer at 13:15 PST (one-shot, session-only)
- [x] Chunk 1 integration, two fresh-context audits, fixes, commit, push
- [ ] Chunk 2 lane plans (13:15), launch, integration, audit, commit, push

## 7. Progress log

- 2026-11-18 08:36 PST: Three read-only inventory subagents launched (examples/eval, solvers/perf, UI/testing).
- 2026-11-18 08:42 PST: Inventories back. Disk 2.3 GiB free noted. Proposal and chunk plans written (this file).
- 2026-11-18 08:44 PST: One-shot timer set for 13:15 PST to start chunk 2 (session-only; it fires when the coordinator is idle).
- 2026-11-18 08:47 PST: Chunk 1 lanes launched in the background: T1 (DevLog-038), T2 (039), T3 (040), T4 (041), S1 (042), S2 (043), S3 (044), S4 (045). 8 of 10 slots used. Briefs carry the shared-file rule, ports (T1 41731-2, T3 41733-4), the low-disk and RSS limits, and the no-git rule.
- 2026-11-18 08:56 PST: Wentao cleaned up the disk; data volume now 18Gi free. Chunk 1 lanes keep their no-install rule; for chunk 2 the low-disk limit is relaxed to small logs and no large artifacts.
- 2026-11-18 09:13 PST: T3 done (DevLog-040): plot groups for 8 sims, broken global items replaced by module scalars, eval headers fixed, analog rule and nav host deduped, study picker (RunOptions.studyId; driver unchanged). Checks: pnpm -r check clean, apps/web 55/55, browser screenshots reviewed by T3. Out-of-lane edits to review at integration: results/api.ts, post/headline.ts, ui/Headlines.svelte, agent/mount.ts. Requests relayed to T1 (tests, HIDDEN_ANALOGS import) and T2 (renamed evaluation ids). Coordinator TODO: changelog line for RunOptions.studyId; regenerate landing previews at integration.
- 2026-11-18 09:18 PST: T2 done (DevLog-039). Full CLI run 09:14-09:17 over 85 cases: 22 pass, 3 fail (CP-21, WO-41, RF-62), 50 pending, 8 untestable, 2 skipped for the 2 GB RSS cap (CP-43, WO-65). Class a 15/1/13 vs 11/0/18 on 2026-11-07; no tolerance or reference changed. Builders reproduce all edits (class c 36/36 byte-identical).
  - D (coordinator): T2 O1 "should a Richardson-gated target also need its finest level within tolerance": KEEP the current strict rule. Relaxing a gate rule to turn two fails green is tuning; WO-41 and RF-62 stay fail until finer levels or a converged run pass the rule. Flagged to Wentao.
  - Applied T2 requests: library catalog CP-21, WO-41 (both sims), RF-62 now show fail with the 2026-11-18 harness logs; cylinder-cavity-qd eval header + RF-01; cylinder-cavity and heat-plate-fin pairings marked informative. Contract changelog lines for C6 studyId and C8 H1-H5 added. apps/web check clean.
- 2026-11-18 09:20 PST: T4 done (DevLog-041): 19 new materials, 3 extended; property types p_pe, kappa, Tg, tcr; dispersion/complexIndex API; materials tests 32/32, validator 34/34. DevLog-035 R4 does not reproduce (closed). Not authored: Ge, Ta/TaN. Main N/A: Si3N4 film mechanics/thermal, TiN resistivity, SiC-4H k, nu of underfill/EMC/PI-2600, ABF k. Si/GaAs p_pe and SAC305 E(T) are from secondary peer-reviewed sources (flagged in the files). API relayed to S2 (bind kappa inside modes/**). chip-warpage-2d keeps its ECTC 2011 values (T4 advice); revisit in chunk 2 packaging lane. T4's own fresh-context audit not run; covered by the chunk 1 audit.
- 2026-11-18 09:23 PST: T1 done (DevLog-038): apps/web tests 60/60 (15 ran before); e2e smoke (`pnpm e2e`) 55 checks, 46 pass, 9 warn, 0 fail over landing (42/42 cards), 6 Play routes, 48 sims; 24 case values outside tolerance are single-level comparisons of Richardson-gated targets (rel 1.1e-6..4.1e-3), counted as warnings; CI workflow .github/workflows/ci.yml (check, test, 10 class-a cases; e2e job non-blocking, not yet run on GitHub). Coordinator fixed T1's B1 (preload.server.ts emitted production chunk preloads under vite dev when a stale build manifest existed: now skipped when import.meta.env.DEV) and B2 (previews.ts asset path without leading slash). apps/web check clean, test 60/60. TODO at integration: rerun e2e and drop the B1 known-issue allowance in scripts/e2e-smoke.ts if the 404s are gone. T1 R1 (about 15 references pending because the sim lacks the value) goes to chunk 2.
- 2026-11-18 09:23 PST: S2 done (DevLog-043): em-modes loss, dispersion, PML, bend (metric and conformal). Gates: Au/air SPP vs analytic (Re 2.8e-10), leaky Si wire vs Bienstman 2006 (Re +4.6e-5, Im +9e-6 rel), PML on/off guided 1e-9, bent slab vs Hiremath 2005 Table 3 (metric dBeta <= 1.4e-5, alpha <= 6.4e-4 rel; conformal 2-12 % in alpha, limit recorded), n_g energy vs finite difference 1.4e-7, tfln-mzm-eo n_g 2.2794 vs CP-43 2.276 (was 2.2262). All 9 em-modes sims bitwise unchanged; physics tests 154/154. Kernel fix: csqrt precision for low-loss Im(n_eff).
  - D (coordinator): S2 R3 (hard-coded dn/dlambda numbers in tfln-mzm-eo.yaml) replaced by R2 (prepare.ts computes dn/dlambda from @amp/materials dispersion() with provenance); R1 + R2 + the tfln sim switch are done by the coordinator after S3 releases prepare.ts. R5 (WO-65 ng) and CP-43 n_g gating go to chunk 2.
- 2026-11-18 09:26 PST: S1 done (DevLog-042): driven complex Helmholtz (emw-2d TM/TE, acoustics frequency) with PML, plane-wave scattered field, modal ports with S-parameters, impedance/scattering BCs. Gates on >= 2 levels: PEC cylinder vs Bessel series (sigma_back 4e-6 fine), dielectric cylinder <= 4.1e-5, Fresnel 3.7e-7, Airy slab 7.8e-6, PML |S11| 1.1e-6 at d = lambda, waveguide |S21| - 1 = 3e-13, reciprocity 1.8e-14, acoustic duct 1.9e-4; series refs cross-checked scipy vs mpmath + optical theorem. 123,552 complex DOF in 2.0 s (0.6 GB RSS). Coordinator applied R1 (physics index registration, NEEDS, NORMALIZATION; wrapper keeps a module's own normalization) and R3 (changelog): physics check clean, tests 156/156. Pending after S3 releases prepare.ts: S1 R2 (NEEDS emw-2d material props, lambda = c0/f for a single-frequency study). R4 (web display of complex fields, S-parameter and far-field plots) goes to chunk 2 E6. Note: the coordinator's T4-API relay at ~09:20 went to S1 instead of S2 by mistake; S1 bound kappa only in wave2d (correct), S2 used the library API on its own; no harm.
- 2026-11-18 09:28 PST: S3 done (DevLog-044): `extrude` layered 3D (tet4/tet10, conforming, exact circles), nested levels in prepareRun, mixed box + z-cylinder as stacks. Gates: box-as-extrude vs box path exact for linear fields; 3-layer series resistance 3.8e-11; via-through-cell G exact to the P2 circle area (-1.8e-6); blind via 3D vs axisym 1.5e-3 and converging, inside derived bounds; determinism across processes; acoustics room modes 6.8e-4, cavity TM010 -1.6e-6. 48/48 sims unchanged (mesh hash + tagHash, five 3D sims bitwise). Tests geom 43/43, mesh 19/19, physics 156/156. Contract changelog added.
  - D (coordinator): S3 O1 (pre-existing 2D keepTools difference leaves curved tools as 1-degree pieces, min angle 0.5 deg when r ~ hmax) is NOT fixed in 2D in chunk 1: it changes the meshes of coplanar-rings, the three phc sims and nafems-t1-hotspot, so it needs an eval rerun; scheduled for chunk 2 with before/after gates.
  - Routed: R-web-1 (3D preview of stacks via meshFromSpec, exterior facets) to chunk 2 E6; R-T4-1 (underfill and TiN k; Si cubic C or isotropic choice for TSV stress) to chunk 2 E3; example YAMLs (TSV cell, die on interposer, waveguide under heater) seed E3.
- 2026-11-18 09:28 PST: Lane I1 (DevLog-046) launched for the queued prepare.ts requests: S2 R1 (library kappa), S2 R2 (library dn/dlambda incl. crystal components), S1 R2 (emw-2d props, lambda = c0/f), tfln-mzm-eo switched to library dispersion. Running lanes: S4, I1.
- 2026-11-18 09:36 PST: S4 done (DevLog-045): WASM real triangular solve (default, bitwise identical), precomputed scatter slots (scatter measured at 1.5-2.7 % of 3D assembly and 17 % of kirsch, not ~25 %), stationary solver setting (direct default; amg-pcg; auto by factor cost). Warm medians: H6 3,737 -> 2,886 ms; em3d ND2 57k DOF 17,580 -> 9,283 ms; H4 rib 520k DOF 5,831 -> 4,338 ms; pzt4 modal unchanged (assembly-bound). Root pnpm test 709/709, check clean, class-a 15/1/13 unchanged with 55/55 target values bitwise identical. Routed to chunk 2 E8: R1-R3 (elastic, coupled K/M and radiation Jacobian scatter reuse), R4 (solver field in the run record), element kernels (piezo assembly 6-7 s of 12 s), multi-worker 3D factorization, AMS path above 60k em3d DOF, complex WASM solve. Note: one S4 em3d run reached 4.8 GB RSS before it was killed (over the 2 GB rule); later runs used a guard.
- 2026-11-18 09:36 PST: Fresh-context audit of chunk 1 launched (everything except prepare.ts and tfln-mzm-eo.yaml, which I1 is editing). Running: I1, audit.
- 2026-11-18 09:41 PST: I1 done (DevLog-046): library kappa and dn/dlambda bound in prepareRun; emw-2d library props at lambda = c0/f. tfln-mzm-eo now uses library dispersion: n_g_0 2.2794263 (was 2.2262262; CP-43 2.276), n_g_1 2.4412795 (was 2.3818282); n_eff_0 and VpiL bitwise unchanged; dn/dlambda bitwise equal to S2's values. Physics tests 162/162, check clean; library path equals override path to 1e-12 (Au SPP; emw-2d ITO channel). Regression: 47/48 material dumps identical (tfln adds 4 dn values + notes), 8/9 em-modes solves identical (tfln only n_g). Accepted out-of-lane edits R1 (ref: on LN/SiO2/Air in tfln sim) and R2 (G-TFLN test base sets dispersion false). Routed to chunk 2: O1 multi-frequency library dispersion, O2 material-level alternative (spec schema), R4 gate CP-43 n_g.
- 2026-11-18 09:41 PST: Integration started: root pnpm check + pnpm test.
- 2026-11-18 09:51 PST: Integration results before audit fixes: root check clean; tests 654/654 over 11 packages (logs/integ1-test-20261118T094135.log); eval CLI a 15 pass / 1 fail (CP-21) / 13 pending, b 0 / 1 (WO-41) / 19 (CP-43 skipped), c 7 / 1 (RF-62) / 28 (WO-65 skipped): 22 pass, same as T2; e2e 55 checks, 46 pass, 9 warn, 0 fail, 0 known-issue 404s after the B1 fix (logs/T1-e2e-20261118T174639-summary.md).
- 2026-11-18 09:51 PST: Fresh-context audit 1 of chunk 1: 0 blocker, 4 major, 9 minor. Majors: (1) wave2d scattered-field wall source uses the cell coefficient instead of the background one (TE error 0.87 in the auditor's slab-on-wall check); (2) em-modes n_g drops -kappa^2 for lossy media with dispersion on; (3) bend without neffShift returns a PML mode as mode 0; (4) stackFromSolids drops the neighbour box's name on shared faces. Fix lanes launched: F1 (wave2d, DevLog-042), F2 (modes, DevLog-043), F3 (geom stack, DevLog-044). Minors accepted as-is with notes: eval H5 floor (cannot pass a non-converged sequence; pre-existing stagnation hole, DOF-growth check to chunk 2), single-level gates for CP-06/EM-61/TFLN under the 2 GB rule, scalar.ts module-global solver setting (one run per realm; documented).
- 2026-11-18 09:51 PST: Coordinator: internal shorthands removed from shipped material strings (non-comment YAML lines: lane codes, DevLog numbers, APA abbreviation; 'by T4', 'by lane MX', 'in this lane' etc.) and from the sigma derivation text in packages/materials/src/library.ts. Backup of materials/ in the session scratchpad. Materials tests 32/32, validator 34/34.
- 2026-11-18 10:00 PST: F1 done (DevLog-042 s.7): wall/Robin facets use the background coefficient; normal-velocity facets under a plane wave also fixed (incident term missing). New gate G-f (backed slab vs impedance recursion, cross-checked by transfer matrix to 2.2e-16): r errors fine level 1.2e-5..1.5e-5 (before the fix 0.47-1.00). Ports + sources: S from source-free solves, P_src_<i> added (duct piston test 7.5e-7). Impedance gate now sees the reactance sign (Im Gamma +-0.554, errors ~6e-6). wave2d 19/19, physics 164/164. Coordinator decision on F1 O7: an exterior facet without BC next to a non-background cell under a plane wave is rejected with a message (F1 resumed to implement).
- 2026-11-18 10:00 PST: F3 done (DevLog-044 s.7): shared side faces selectable by both solids' names (also the extrude layer-suffixed form); 'solids' stack id reserved. geom 48/48, mesh 20/20, physics 164/164; 48 sims identical (mesh hash, tagHash), five 3D sims identical in scalars and field hashes.
- 2026-11-18 10:04 PST: F1 O7 done: plane-wave runs with an exterior facet without BC next to a non-background, non-PML cell fail before assembly with a message naming the boundaries (readiness has no mesh); gates G-b2 and G-f now state their channel-wall BCs explicitly, numbers unchanged; rejection test added. wave2d 20/20, physics 165/165.
- 2026-11-18 10:15 PST: F2 done (DevLog-043 s.8): lossy eps_g complex form (plus a second defect: lossy solves used Re(eps) as eps_g even without dispersion); Au SPP n_g = n_eff to 7e-11; finite-difference check with library Au n, kappa at 0.78 um 2.5e-7 (4x smaller at half step). Bend default shift from non-PML cells, pmlFraction_<k>, R = 20 um without shift now 1.618512 (was a PML mode 1.81424). Confinement/powerW/H with transformed weights (1.4e-9 vs perturbation; old weighting 3.0e-2 off). 9 em-modes sims bitwise identical with options off; physics 172/172. R7 (library dkappa/dlambda in prepareRun) to chunk 2.
- 2026-11-18 10:15 PST: Coordinator removed internal references from user-visible strings: catalog-bc (DevLog-022 note), catalog.ts multiphysics tip, catalog-mp optomech note, spec results description (schema tooltip). Runtime notes/errors grep: 0 hits. Final integration rerun started.
- 2026-11-18 10:25 PST: Final integration rerun after fixes: check clean; tests 670/670 (logs/integ2-test-*); eval a 15/1/13, b 0/1/19, c 7/1/28 (22 pass, 3 known strict-rule fails, unchanged); e2e 55 checks, 46 pass, 9 warn, 0 fail (logs/T1-e2e-20261118T182003-summary.md). Hooks build + previews: 19 captured, 29 skipped (unchanged sims), 0 failed; 5 result images changed (nafems-le1, nafems-t3, semi-infinite-convection, si-slab-te0, si-slab-tm0), viewed by the coordinator. Finding O-C1 for chunk 2 graphics: 1D cut-line sampling of DG0 fields (em-modes normE) has no smooth recovery, so the si-slab profiles show a staircase at n = 400 (the 2D view is smooth); fix in the sampler, not by coarsening the cut line. Pre-commit scan of all changed/new files: no local paths, secrets, emoji or files > 1 MB. Second fresh-context audit (fix verification) running.
- 2026-11-18 10:33 PST: Audit 2 (fix verification): items 1-3 verified independently (wave2d closed-cavity total-field probe 3.9e-6 at h 0.025 for every wall type; lossy n_g vs finite difference 1.8e-7 with the kappa terms, -1.27e-3 without; stack shared faces in 6 configurations). Item 4 incomplete: coordinator fixed the remaining user-visible shorthands (linbo3 T3 and a dangling 'and', formulas.ts, prepare.ts note, optomech readiness, spec basis descriptions, plot-ops tip, rt-kernels caveats x3, engine registry source, Graphics.svelte note, library tooltip no longer prints internal log paths, 'fresh-context audit' wording in silicon/ptfe/aluminum-6061 notes); one test assertion followed the note text. Checks after: root check clean, physics 172/172, spec 65/65, materials 32/32 + validator 34/34, web 60/60. eval/schema descriptions (not shown in the app) left as is.
  - Audit 2 minors routed to chunk 2: a scattering BC next to a non-background cell is accepted but ill-posed (reject or document); PML-fraction mode ranking applies to all PML runs without neffShift (9-sim regression unaffected); direct kernel callers passing epsG without epsGIm drop the -lambda kappa dn/dlambda loss term.
- 2026-11-18 10:33 PST: Chunk 1 committed and pushed: 01db73a on main (249 files, +14,355 / -531). First GitHub Actions run of .github/workflows/ci.yml triggered by this push.
- 2026-11-18 10:43 PST: First CI run 44371000658: e2e job pass (9m13s, software GL on ubuntu); check-test-eval failed at test: every package passed on Linux (rt 9 with no GPU, core 95, spec 65, geom 48, materials 32, eval 86, mesh 19, physics 172, post 13, agent 63) except apps/web results-eval.test.ts, which read the untracked logs/r1-post-gates-20261107T070753Z.json (pre-existing hidden local dependency from the results R1-R3 work). Fix: the file is copied unchanged to apps/web/test/fixtures/ and the test reads it there; no other test reads logs/. Web 60/60 locally. Note for chunk 2: actions v4 run on forced Node 24 (deprecation warnings).
- 2026-11-18 10:53 PST: CI run 44372834388: tests pass on Linux, e2e pass; eval subset failed at SM-01 field_rel_L2_stress (Python exact-field evaluator needs uv, absent on the runner). Fix: CI eval step uses --fields ts (TypeScript evaluators); all 10 subset cases exit 0 locally with --fields ts.
