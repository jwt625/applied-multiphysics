# DevLog-029: landing page with previews, and truly multiphysics examples (coordinator)

| Field | Value |
|---|---|
| Date | 2026-11-07 |
| Lane | coordinator (plan, contracts C11, integration, audits, git) |
| Owns | this file, `DevLog/contracts/CONTRACTS-v0.md` (C11 + changelog), stub files `packages/physics/src/couplings/{photonic,twoway}.ts` until the lanes take them, git |
| Request | Wentao, 2026-11-07: "1. a landing page similar to what gdsjam project has but with consistent and updated style of this project, and showcase the examples with a preview of the geom/mesh/result. Check how comsol application library's preview images look like. Classify by category like in gdsjam. Enable search. 2. come up with a few examples that are more and truely multiphysics, e.g. see some from advanced packaging, and some from my local comsol directory in documents as well as more comsol in NAS." |
| Status | done except commit + push (s.4); open items s.6 |

Conventions: "F" = fact read from code or files; "D" = decision; "O" = open item.

## 1. Decisions (Wentao, 2026-11-07 08:2x PST)

| # | Question | Answer |
|---|---|---|
| Q1 | Landing route | Landing at `/`. Workbench moves to `/workbench?sim=<id>`; old `/?sim=` and `/#d=` links forward to the workbench. |
| Q2 | Use of COMSOL folders | Folder and file names for topics; app-library thumbnails for preview style; AND Wentao's own `.mph` model inputs (geometry dimensions, materials he typed) may be read. No COMSOL results or solved values. No app-library model content beyond the thumbnails. Provenance for such inputs: `basis: user`, source = folder name, e.g. "Wentao's model NAS Documents/COMSOL/20241210_CTE_bending (inputs only)". |
| Q3 | Multiphysics scope | All four sets: thermal stress, Joule heating chain, photonic couplings (thermo-optic, electro-optic), two-way / eigen couplings (piezo, structure-acoustic, optomechanics). |
| Q4 | Git | Commit to `main` and push to github.com/jwt625/applied-multiphysics. No deploy. |

## 2. Findings (F, 2026-11-07 08:00-08:22 PST)

### 2.1 gdsjam landing (PlayGround/20251117_GDSJam/gdsjam, read only)
- `src/components/ui/FileUpload.svelte`: drop zone, then "Or try an example", groups by category (`EXAMPLE_CATEGORY_ORDER`), a grid of cards: preview PNG (`public/previews/<id>.png`), name, one-line description, size + attribution link. No search. Catalog in `src/lib/examples/examples.ts` (`{id, name, description, category, attribution, sourceUrl, license, previewOverviewUrl}`).

### 2.2 COMSOL Application Library previews (local install, thumbnails only)
- Each library `.mph` carries `modelimage.png` 280 x 210 and `modelimage_large.png` 1024 x 768 (both 4:3).
- Content: one result plot on the geometry (colormap surface, sometimes deformed / 3D view), white background, no axes, no colorbar, sometimes min / max labels at the extrema. No text title.
- Our previews: same 4:3 framing and "result on the geometry, no axes" idea, but in this project's dark style; three per example (geometry, mesh, result).

### 2.3 This repo
- `/` = workbench (`apps/web/src/routes/+page.svelte`, `?sim=`, `#d=`), Play views at `/play/[sim]`, `/play/rt`. 36 sims, catalog with 8 categories (`apps/web/src/lib/library/catalog.ts` + `catalog-bc.ts`), `LibraryPicker.svelte` with search and chips.
- Screenshot tooling: `apps/web/scripts/shots.ts` (playwright-core 1.63.0, headless shell or system Chrome, serves `build/` with `_headers`). Canvas readback: `apps/web/src/lib/gfx/capture.ts`.
- Engine: no coupling runs. `runner.worker.ts` solves only the first physics of the first study (`ready[0]`). The spec already has `couplings: [{id, type, from, to, settings}]` (schema + validate), and the registry has kind `coupling` with `for: [from type, to type]`; nothing is registered.
- Hooks that exist: heat takes a per-cell volume source `Q` and field sources; elastic takes `thermal: {alpha per cell, T nodal, Tref}` (not bound from the spec). Elastic: 2D plane stress / strain and 3D tet, stationary only (no eigen, no axisym). Electrostatics 2D / axisym; no DC currents module.
- Results: expression prefix `<physics id>.<name>`; `physicsIdOf` in `results/adapter.ts` accepts a prefix only when the study has a single physics.
- Coupled eval cases already sourced: CP-02 (NAFEMS LE11, axisym thermal stress), CP-21 (NAFEMS T1 hot spot), CP-03 (Joule wire), CP-04 (Si electrothermal hot-arm actuator, Mankame-Ananthasuresh 2001), CP-06 (PZT-4 cube modes, Boucher 1981), CP-08 / CP-42 (Si optomechanical nanobeam), CP-43 / CP-44 (TFLN MZM VpiL), CP-01 (natural convection), CP-05 (electro-osmosis), CP-07 / CP-41 (FSI). DevLog-001 H11: microheater on Si waveguide (currents + heat + elasticity + modes).

### 2.4 Topic sources
- Wentao's COMSOL models (NAS `Documents/COMSOL`, 51 folders; local `Documents/COMSOL/20260824_leaky_thin_SiN`). Multiphysics candidates by name: `20241210_CTE_bending` (bimorph, heat + solid), `20250927_LN_FBAR_gapped` (piezo LN FBAR, 2D + 3D slice), `20250331_SAW_toy`, `20240922_mass_loaded_membrane_acoustics` (structure-acoustic), `20240813_microwave_oven` (EM + heat; needs driven EM, not in the engine), `20240709_gear_box` (vibration + noise), `20250208_egg_periodic_cooking` (heat), `20240810_thermal_cryo` (heat).
- advanced-packaging-atlas (read only): warpage cases `si_interposer_peers/*`, `cowos_*`, `emib_t`, thermal `cowos_r/thermal_rjc`, `cpo_module/thermal`, `hbm_stack/stack_thermal`; validation bases in its DevLog-010 "First canonical sims" (ECTC papers).

## 3. Plan

### 3.1 Coupling architecture (D, contract C11 in CONTRACTS-v0)
- One-way couplings are sequential: a driver in `@amp/physics` (`runStudy`) orders the study's physics by the couplings (topological), runs each module, and passes upstream results to downstream modules as typed `inputs` on the RunContext. All physics share one mesh (the study mesh); each physics selects its own domains.
- Two-way couplings (piezo, structure-acoustic) are monolithic: the coupling type registers a solver that receives the run contexts of both physics and returns one solution.
- The merged Solution tags every field and scalar with its physics id, so `<physics id>.<name>` resolves with several physics in a study.
- Reason: the simplest robust scheme for the selected examples (all one-way except piezo and structure-acoustic), reuses every module unchanged in its single-physics path.

### 3.2 Lanes (wave 1, concurrent; each writes its plan into its DevLog before coding)

| Lane | DevLog | Owns | Depends on |
|---|---|---|---|
| LP landing + previews | 030 | `apps/web/src/routes/**` (new `/` landing, `/workbench`), `apps/web/src/lib/landing/**`, `library/catalog.ts` + `LibraryPicker.svelte` (fields, categories incl. multiphysics), link sites of `/?sim=` (Play, share, agent nav: link edits only), `apps/web/scripts/previews.ts`, `apps/web/static/previews/**` | none; previews of new sims rerun at integration |
| MC coupling core | 031 | `packages/physics/src/{couplings/index.ts, couplings/core.ts, currents/**, driver.ts, prepare.ts, registrations.ts, index.ts}`, the coupling-input paths of `heat/index.ts` and `elastic/index.ts`, `packages/spec/src/types/physics.ts` (RunContext.inputs, Solution tags), `apps/web/src/lib/engine/runner.worker.ts`, physics-prefix resolution in `packages/post` and `apps/web/src/lib/results/adapter.ts` | C11 (this file) |
| MO photonic couplings | 032 | `packages/physics/src/modes/**` (perturbation inputs), `couplings/photonic.ts` | C11; MC driver for end-to-end runs |
| MT two-way + solid modal | 033 | eigen path of elastic (`elastic/modal.ts` + a dispatch in `elastic/index.ts` run), axisymmetric elastic, `piezo/**`, `couplings/twoway.ts` (piezoelectric, acoustic-structure) | C11 |
| MX example research + sims | 035 | new `sims/<id>.yaml` for the multiphysics examples, new `materials/*.yaml`, `apps/web/src/lib/library/catalog-mp.ts`, `validation/mp/**` (analytic / open reference scripts), reads Wentao's `.mph` inputs | C11 spec syntax; runs after MC / MO / MT land |

Wave 2: optomechanics (microdisk g_OM axisym first; CP-08 nanobeam feasibility) on MT's solid modal (DevLog-034), integration, preview regeneration, fresh-context audits, commit, push.

### 3.3 Candidate examples (to be sourced by MX; any without a sourced input is dropped or labelled)

| Set | Example | Physics chain | Reference |
|---|---|---|---|
| thermal stress | NAFEMS T1 hot spot | heat -> elastic | CP-21 |
| thermal stress | NAFEMS LE11 | heat -> axisym elastic | CP-02 |
| thermal stress | bimetal / bimorph strip bending | heat -> elastic | Timoshenko 1925 bimetal formula; Wentao's CTE_bending inputs |
| thermal stress | chip-on-substrate warpage (2D plane strain) | heat -> elastic | advanced-packaging-atlas ECTC-sourced case |
| Joule | Joule-heated wire | currents -> heat | CP-03 |
| Joule | Si hot-arm electrothermal actuator | currents -> heat -> elastic | CP-04 |
| photonic | microheater on Si waveguide, thermo-optic phase shift | currents -> heat -> em-modes | H11; dn/dT sourced |
| photonic | TFLN MZM VpiL | electrostatics -> em-modes (Pockels) | CP-43 / CP-44 |
| two-way | PZT-4 cube breathing modes | piezo eigen | CP-06 |
| two-way | LN FBAR resonance | piezo eigen (2D) | Wentao's LN_FBAR inputs; analytic thickness-mode estimate |
| two-way | mass-loaded membrane in air | elastic-acoustic eigen | Wentao's membrane inputs; analytic membrane modes for the uncoupled check |
| wave 2 | microdisk g_OM, nanobeam g0 | emw-axisym + axisym solid modes / em3d + solid modes | CP-08, CP-42; omega / R analytic |

### 3.4 Landing page (LP)
- `/`: header (name, one line, links: Workbench, Play, GitHub), search box (title, physics, category, tags, eval case; keyboard `/` focuses), category chips with counts, grid grouped by category (gdsjam pattern) with a "Multiphysics" category first.
- Card: 4:3 preview, three tabs geometry / mesh / result (result default; hover or key switches), title, physics chain chips, dimension, eval case + status in tooltip. Click opens `/workbench?sim=<id>`; a Play badge links the Play view.
- Previews: generated by `apps/web/scripts/previews.ts` from the real engine in headless Chromium (workbench graphics pane, per sim: geometry, mesh, result), 480 x 360 WebP (or PNG if WebP fails), dark background, no axes, colorbar off; skip-existing by spec hash (manifest JSON); log to `logs/previews-<ts>.json`.
- Style: this project's tokens (dark default, sharp corners, dense), not gdsjam's.

## 4. TODO
- [x] Q1-Q4 answered, recorded (s.1)
- [x] C11 written into CONTRACTS-v0
- [x] wave 1 lanes LP (030), MC (031), MO (032), MT (033), MX (035) spawned
- [x] wave 1 results reviewed
- [x] wave 2: optomechanics (034), integration, previews for new sims; extra lane MG (036) for anisotropic electrostatics + boundary naming
- [x] fresh-context audit, fixes (FE in DevLog-031 s.9, FC in DevLog-035 s.13)
- [x] pnpm check + test, build, screenshot review of `/` and new sims
- [ ] commit + push

## 5. Results (multiphysics sims, from the spec; DevLog-035 s.11-13, logs/MX-run-all-20261107T094211.jsonl, logs/FC-run-20261107T101942.jsonl)

| Sim | Chain | Key number | Reference | Rel |
|---|---|---|---|---|
| nafems-t1-hotspot | heat -> elastic | sigma_yy(D) 49.794 MPa | 50 MPa (CP-21) | -0.41 % |
| nafems-le11 | heat -> elastic (axisym) | sigma_zz(A) -105.935 MPa | -105 MPa (CP-02) | +0.89 % |
| bimetal-strip | heat -> elastic | kappa | Timoshenko 1925 | -5.1e-9 |
| chip-warpage-2d | heat -> elastic | bow 162.751 um | laminate closed form 162.833 um | -0.05 % |
| joule-wire | currents -> heat (axisym) | T_center 488.672 K | CP-03 | ~2e-13 |
| hot-arm-actuator | currents -> heat -> elastic (3D) | tip u_y -7.719 um | CP-04 27 um (not comparable: constant properties, linear, no radiation) | informative |
| si-microheater-to | currents -> heat -> em-modes | P_pi 9.435 mW | Wang 2020 measured 8.5 mW | +11 % |
| tfln-mzm-eo | electrostatics -> em-modes (Pockels) | VpiL 4.221 V cm | CP-43 4.06 V cm (tol 10 %) | +4.0 % |
| pzt4-cube | piezoelectric (3D) | short 65101.5 / 88146.3 Hz; open 79810.0 / 93584.3 Hz | CP-06 (tol 3 %) | -2.2 / +0.2 % |
| ln-fbar-2d | piezoelectric (2D) | active mode 6.63845 GHz | TE1 closed form 6.62295 GHz | +0.23 % |
| membrane-air | acoustic-structure (axisym) | coupled fundamental 66.385 Hz | uncoupled checks only | n/a |
| gaas-microdisk-om | elastic + emw-axisym (optomechanical) | RBM1 1.3754 GHz; abs(g0) x 2pi MB 1.296e6, PE 1.056e6 rad/s | Baker 2014 1.375 GHz; 1.33e6 / 1.21e6 rad/s | +0.03 %; -2.6 % / -12.8 % (frame: crystal-avg vs Baker's cylindrical) |

## 6. Open items
- O1 CP-08 / CP-42 nanobeam g0 not run: case geometry inputs missing; engine gaps (3D extrude, iterative ND2 solver, PML) in DevLog-034 s.3.
- O2 CP-06 f1 offset -2.2 % in both electrode conditions: electrical constants and C66 ruled out; likely listed mechanical constants or the measurement (DevLog-033).
- O3 Workbench solves only the first study (pzt4-cube open circuit, membrane-air in vacuo need their own run).
- O4 emw-axisym fails (G^T M G not positive definite) when its selection leaves mesh cells out (DevLog-031 s.9 item 5).
- O5 LN dndT N/A (no open primary source); GaAs / Si photoelastic constants not storable in @amp/materials (no property type).
- O6 Eval case text of CP-04/06/21/43 (`spec.reason`, `missing`) describes the pre-sim state; the case files are generated by validation/{a,c}/build_cases.py (builders not updated).
- O7 Group index without material dispersion (em-modes eps_g = eps): tfln-mzm-eo n_g 2.226 vs 2.276 at the tolerance edge.
- O8 Landing: ln-fbar-2d card is a thin band at card size (500 nm film over ~60 um); membrane-air card shows the f = 0 mode; the 6 acoustics-analog EM sims stay hidden (same rule as the picker).
- O9 Hot-arm thermal model: constant 300 K properties; k(T), alpha(T), h(T), radiation, geometric nonlinearity not expressible.

## 7. Progress log
- 2026-11-07 08:00 PST: read gdsjam landing, COMSOL thumbnails, repo engine / web state, packaging atlas, NAS COMSOL folder list.
- 2026-11-07 08:2x PST: Q1-Q4 answered (s.1).
- 2026-11-07 08:25 PST: C11 written; stubs couplings/photonic.ts, couplings/twoway.ts; wave 1 spawned (LP, MC, MO, MT, MX; 5 concurrent subagents). Ports: LP 47431-47439.
- 2026-11-07 08:41 PST: LP (DevLog-030) done: landing at /, /workbench route, forwards, 36/36 previews (108 WebP), check/test/build pass. Open: rerun previews --force at integration; canvas labels in thumbnails; no workbench->landing link; 6 acoustic-analog sims hidden (same rule as picker).
- 2026-11-07 08:48 PST: MC (DevLog-031) done: runStudy driver, currents, joule-heating, thermal-expansion, tagged merge, post prefix by tag; 11/11 coupling gates (T1 50.446 MPa in 50.0-50.5 bounds, bimetal rel 2.9e-9, CP-03 coupled rel 2e-13); class-a eval 136/136 identical. Resumed for O1 (eval harness runStudy), O2 (workbench header/Bottom by physics tag) + workbench->landing link.
- 2026-11-07 08:54 PST: MC O1/O2 closed: eval harness + agent FeRunner use runStudy (class-a 136/136 identical; eval 80/80, agent 63/63, task suite 29/29), workbench physics-chain label, Bottom probe by tag, workbench->landing link.
- 2026-11-07 09:02 PST: MO (DevLog-032) done: thermo-optic + electro-optic (Pockels) into em-modes; gates: G-TO1 identity 1.3e-14, CP-43 VpiL 4.241 V cm vs 4.06 paper-sim (+4.5%, tol 10%), CP-44 4.015 vs atlas 4.022, microheater P_pi 9.44 mW vs 8.5 mW measured (Wang 2020, +11%); em-modes sims bitwise identical. Requests R0-R2, R4, R5 -> MC (resumed); R3 (anisotropic electrostatics) + G1 (shared-edge naming) -> new lane MG (DevLog-036). M1 (LN dndT, air n, oxide dndT T) -> MX at integration.
- 2026-11-07 09:05 PST: MX (DevLog-035) done: 11 coupled sims (nafems-t1-hotspot, nafems-le11, bimetal-strip, chip-warpage-2d, joule-wire, hot-arm-actuator, si-microheater-to, tfln-mzm-eo, pzt4-cube, ln-fbar-2d, membrane-air), catalog-mp.ts 11 entries, materials/titanium.yaml + linbo3 rho, validation/mp references. 6/11 validate; rest blocked on registrations -> MC (X1 merged registry incl. piezo C symmetries, X2 elastic axisym + electrostatics 3d, X3 2D out-of-plane current drive, X4 materials test) + full run of the 11.
- 2026-11-07 09:08 PST: MX M1 follow-up: LN dndT N/A (no open primary source; Moretti 2005 paywalled), air n Mathar 2007 IR alternative added, oxide dndT = Leviton-Frey 2006 fit (30-300 K; microheater exceeds range, noted). Hot-arm 3D exterior-face selection -> MG as G2.
- 2026-11-07 09:15 PST: MT (DevLog-033) done: elastic modal (2D/3D/axisym), axisym elastic, piezoelectric + acoustic-structure monolithic; gates: cantilever f1 1.9e-5, LE11 -105.94 MPa (+0.89%), CP-06 short -2.19%/+0.18%, open -2.18%/+0.22% (tol 3%), FSI 1D column 1e-5; class-a 136/136 identical. Routing: MC (a)-(d) readiness hook, rho need, RESULT_NAMES, exports; MX X1 pzt4 mode indices, X3 piezo tensors in materials; MT resumed: unify orientation on settings.crystals (euler advanced), NaN-outside-domain render check in workbench, bounded CP-06 f1 offset look. Wave 2 optomechanics lane MOM (DevLog-034) spawned.
- 2026-11-07 09:17 PST: MX X1 done (pzt4-cube eval -> electrically active modes, tetragonal-4mm C66 3.0e10 per VM175); all 11 sims validate on app registry. X3 piezo tensors staged in validation/mp/pending-materials/ (rejected by @amp/materials schema: cubic-only C, no e_piezo) -> MC registers; MX copies in after.
- 2026-11-07 09:22 PST: MT F1-F3 done: piezo accepts settings.crystals (euler advanced, exclusive; equivalence 1.6e-14 on ln-fbar-2d); NaN fields render blank, ranges finite (membrane-air, ln-fbar-2d in workbench); CP-06 f1 -2.2%: electrical constants/convention and C66 ruled out (open/short ratios match to 0.06%), likely listed mechanical constants or the measurement (open). Noted for integration: dev-server 404s on /_app/immutable/chunks (service worker?), solid.u = 0 off-solid.
- 2026-11-07 09:28 PST: MC all requests done (one registry, materials C 6mm/4mm/3m + e_piezo, prepareRun tensors/wavelength, Q_total, 2D out-of-plane currents, monolithic readiness, exports); class-a 136/136 identical; 11/11 MX sims validate, 8 solve (T1 49.79 MPa, LE11 -105.94, joule-wire exact, microheater Ppi 9.435 mW, TFLN VpiL 4.221 V cm, ng 2.226 at tol edge, PZT short -2.2%/+0.15%). Blocked: bimetal + chip-warpage (elastic point constraints) and hot-arm (hex8 elastic) -> MT E1/E2. MX: frequency evals + mode ID (fbar, membrane), microheater real currents chain, pzt study order, copy staged tensors. MG: 3D capacitance unit F.
- 2026-11-07 09:31 PST: MG (DevLog-036) done: anisotropic electrostatics (slab gate 1e-15), TFLN via module + runStudy (CP-43 4.2527, CP-44 4.0228 V cm; shift from P1->P2 field), G1/G2 naming, 3D capacitance F; 47 sims selections identical, isotropic es bit-identical, 506/506 tests. Coordinator applied R-MC-1 (electrostatics settings.crystals) + C2 changelog. MX: hot-arm h_side add bnd:conn.xmin#1, bnd:cold.xmin#1. Open for audit: mergeCrystals string compare (x vs +x, deg vs rad).
- 2026-11-07 09:35 PST: MX fixes done: ln-fbar-2d active mode 6.63845 GHz (+0.24% vs TE1 6.6229), pzt4 open 79810/93584 Hz (all four within 2.2%), membrane-air coupled fundamental 66.385 Hz (in vacuo with mass 21.185 Hz), microheater real currents chain (P 18.889 W/m, Ppi 9.435 mW), piezo tensors in materials/ (14/14 valid), hot-arm exterior faces. Coordinator: materials test N/A assertion -> linbo3 dndT (22/22). Open: evalTable null crash (mixed item steps; unsolved study) -> integration; two f=0 modes in membrane-air -> MT. LP resumed: capture flag hiding canvas labels, 1D plot preview for thin models, downstream-physics result view, previews --force.
- 2026-11-07 09:36 PST: coordinator checked the reported evalTable null crash: not an adapter bug. MX's scratch runner mapped cells with `c.value` while TableRow.cells are plain values or null (the error text is in row.errors). Adapter behaviour for unselected steps / unsolved study (null cell + error string) is as designed (DevLog-028 s.1.2). No change.
- 2026-11-07 09:40 PST: MOM (DevLog-034) done: optomechanical coupling (moving boundary + photoelastic), GaAs microdisk vs Baker 2014 Table 3 (g_MB -2.4%/-2.0%, g_PE -0.3%/-1.6%, x_zpf <=3%); CP-08/CP-42 not run (case geometry missing; engine gaps N1-N6 in DevLog-034 s.3). Coordinator applied R-MC1/R-MC2 (couplings/index.ts, RESULT_NAMES) and moved sims/gaas-microdisk-om.yaml; mom tests 4/4. MT E1/E2 done: pnt: constraints + displacement BC, hex8->tet10 split (hexToTet10); bimetal kappa rel -5.1e-9, chip-warpage bow 162.751 vs 162.833 um, hot-arm tip -7.72 um (informative; CP-04 27 um not comparable: constant properties, linear); membrane-air two f=0 modes = one per closed cavity (physical; fundamental f_2 66.385 Hz correct). Coordinator applied MT R7 (prepare.ts hex8->tet10 when elastic present). MX: hot-arm hmax D1/2, gaas materials + catalog entry, full 12-sim table.
- 2026-11-07 09:45 PST: MX final: 12 sims (14 runs) validate + solve from spec (logs/MX-run-all-20261107T094211.jsonl); all eval-case targets in tolerance; gaas.yaml added (photoelastic tensors recorded as missing: no property type). Coordinator fixed gaas-microdisk-om: header line, fm -> mech.f_2 (RBM1 1.37540 GHz), added g0MB/g0PE/g0 items for (optical 0, RBM1): -206.24 / -168.02 / -374.26 kHz (g/2pi; = -1.296e6 / -1.056e6 rad/s; crystal-avg frame).
- 2026-11-07 09:51 PST: coordinator integration checks: pnpm -r check exit 0; tests all packages pass after fixing MOM test helper (library: null -> default library, sim now uses ref: materials/gaas); physics 105/105; class-a eval logs/eval-20261107T095025.jsonl vs logs/eval-20261107T092519.jsonl: 136/136 targets identical. Engine audit spawned (fresh context).
- 2026-11-07 09:56 PST: LP previews/2 done (48/48 captured; labels hidden via capture stylesheet; 1D line-plot results for thin models; multiphysics cards show the last physics of the chain; landing 42 cards, Multiphysics first). Bug found by LP and fixed by coordinator: browser runner never passed the material library to prepareRun (Node-only default), so ref: materials without override were missing in the browser (pzt4-cube, ln-fbar-2d, gaas-microdisk-om unavailable). runner.worker.ts now passes library: defaultLibrary(); physics.ts type updated; web check 0 errors. LP resumed: regenerate those previews, FOCUS for microheater/TFLN cards.
- 2026-11-07 10:07 PST: LP final: all 48 sims have G/M/R previews; pzt4-cube, ln-fbar-2d, gaas-microdisk-om solve in the browser with scalars bitwise equal to Node; FOCUS entries for si-microheater-to, tfln-mzm-eo, ln-fbar-2d; 1D cards get a top band for tabs. Coordinator: disabled normalized-amplitude point items (ln-fbar-2d uy_mid, membrane-air uz_centre) and their groups ev_eig, which became headlines in metres (headlineItems takes point/max/min only); both sims validate, frequencies unchanged; spec tests 65/65.
- 2026-11-07 10:14 PST: fresh-context audit (engine + sims) done: no confirmed physics/math bug; class-a 137/137 identical vs f0ab95d; selections identical; provenance matches cited sources. Findings routed: FE (engine: thermal->eigen readiness, sigma<=0 cells, EO one-terminal doc, web runner studyId, optomech PE outside optical domain, modalMass degree-5 rule, tensor symmetry inference, hex split per study, prepare comment, hygiene moves + mt-gates in run-all); FC (content: LE11 exact coordinates, private paths and .mph names removed, plus one LN FBAR value of unclear origin, pzt-4 variant stated, gaas g0 convention, TFLN clamped-basis assumption + atlas commit, stale texts and eval spec.ref, catalog statuses/titles, C11 contract update).
- 2026-11-07 10:23 PST: FC done: 48 sims validate + mesh, 15 materials valid, 85 eval cases load (0 errors); LE11 -105.935 MPa (min angle 27.6 deg), ln-fbar-2d active 6.638455 GHz, gaas unchanged at printed digits after triRule(5). Open (not changed): eval case text CP-04/06/21/43 spec.reason and missing still describe the pre-sim state; case files are generated by validation/{a,c}/build_cases.py (builders not updated).
- 2026-11-07 10:30 PST: FE done: 10 audit items; 520 tests pass, check clean, class-a 136/136 identical (logs/eval-20261107T102633.jsonl). Notes: modalMass triRule(4) was already exact (Duffy n x n exact to degree 2n-2), change is defensive, values move <= 9e-15; open: emw-axisym fails (G^T M G not PD) when its selection leaves mesh cells out (owner em-axisym, not fixed). mt-gates cp06 stale after ref: switch -> MT resumed.
- 2026-11-07 10:36 PST: MT fixed gates cp06/cp06sens for the ref: sim (library values materialized; numbers identical). Previews refreshed for 8 changed sims (captured 8, failed 0); plain production build; landing screenshot reviewed (42 cards, Multiphysics first, forwards OK); privacy scan of changed files clean; pnpm -r check clean. Committing and pushing.
