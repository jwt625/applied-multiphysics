# DevLog-040: library consistency, UI consistency, study picker (lane T3, chunk 1)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | T3 (DevLog-037 s.3, scopes A2 + C2) |
| Owns | `sims/*.yaml`, `apps/web/src/lib/library/**`, `apps/web/src/lib/landing/**`, `apps/web/src/lib/state/nav.svelte.ts`, `apps/web/src/lib/workbench/**` and `apps/web/src/lib/engine/**` (study picker), `apps/web/src/routes/play/**` and `apps/web/src/lib/play/**` (nav-host dedupe), `packages/agent/src/tools/**` (only if run_study needs a study argument), study selection in `packages/physics/src/driver.ts` (only if the driver cannot run a non-first study) |
| Does not touch | other lanes' paths, `registrations.ts`, `packages/spec/**`, `CONTRACTS-v0.md`, git, `apps/web/build` |

Conventions: F = fact read from code or a run; E = estimate; D = decision; O = open item.

## 1. Facts found before planning (2026-11-18 08:47-08:50 PST)

- F: sims without `plots:`: cylinder-cavity-axisym, cylinder-cavity-qd (no `results:` at all), nafems-le1, nafems-t2, nafems-t3, semi-infinite-convection, si-slab-te0, si-slab-tm0.
- F: `# eval:` headers checked against each case's `title` and `spec:` pointer (eval/cases/*/*.yaml):
  - helmholtz-coil lists EM-03; EM-03 is the Palace coplanar rings inductance case (spec: sims/coplanar-rings.yaml). Wrong pairing.
  - kirsch-plate lists SM-02; SM-02 is NAFEMS LE1 (spec: sims/nafems-le1.yaml). Wrong pairing.
  - cylinder-cavity-axisym lists RF-21 only; RF-01 (Palace cylinder conductor Q) names sims/cylinder-cavity-axisym.yaml three times. Missing pairing.
  - nafems-t2, nafems-t3, nafems-t4, semi-infinite-convection have no header; the cases HT-03, HT-02, HT-01, HT-04 name them in `spec:`.
- F: the driver already selects a study: `planStudy(spec, studyId)`, `runStudy(prep, {studyId})` defaults to `prep.study.id`, and `prepareRun({studyId})` picks it (`pickStudy`). No driver change needed.
- F: the first-study limit sits in the web app: `runner.worker.ts` takes `studies[0]`; `Session.compute` runs the first study (or the parametric sweep); `results/api.ts runStudies(spec)` says the shown run answers for the first study (plus parametric wrappers); `agent/mount.ts` rejects any other study id.
- F: `run_study` already has a required `study` argument (packages/agent/src/tools/schemas.ts:49) and `session.ts` checks it against the spec's study ids. No agent package change is needed for a non-first study.
- F: `state/nav.svelte.ts` duplicates `ViewMode`, `CameraRequest`, `NavResult`, `Screenshot`, `NavigationHost` of `@amp/agent` (src/nav.ts, exported from the index; `showPlot?` is already part of the agent's interface). Its `NavTrail` is a Svelte `$state` trail with a different record signature (actor, tool, args, result, message) from the agent's class (no message, listener set); both Workbench and Play build nav hosts with the same recording and screenshot code.

## 2. Plan

1. Results for every sim (C10, patterns of comparable sims):
   - nafems-le1: plot2d `syy_map` (solid.syy, MPa) with deformation, as kirsch-exact / lame-cylinder.
   - nafems-t2, nafems-t3, semi-infinite-convection (1D strips): plot2d `T_map` (ht.T) and a centre cut line with a plot1d `T_line` linegraph (x = arc), as si-microheater-to; nafems-t3 / semi-infinite in degC like their evaluation items.
   - si-slab-te0 / -tm0 (thin window): plot2d `E_map` (ewg.normE) as the other mode sims, plus a vertical cut line through the window with a plot1d profile (the slab profile is the informative view).
   - cylinder-cavity-axisym: plot2d `E_mode` on the meridional section, first mode, |E| from E_rphiz components.
   - cylinder-cavity-qd: full `results:` (solution dataset, frequencies and Q global items, table, plot3d `E_mode` as cylinder-cavity).
   - Verify: a Node script (scratch) solves each changed sim through prepareRun + runStudy and evaluates every plot item and evaluation group with the web results adapter (`evalNodal`, `evalDataset`, `evalTable`); then a browser pass (headless) that selects each new plot group and screenshots it.
2. `# eval:` headers: fix the three named ones, add the four missing ones; check every other header against the case `spec:` pointers; re-check DevLog-039 (lane T2) near the end.
3. Dedupe:
   - analog-hide rule: one export in `library/catalog.ts` (`HIDDEN_ANALOGS`, `listed()`), used by Workbench and Landing.
   - nav types: `state/nav.svelte.ts` re-exports the `@amp/agent` types (type-only import, no runtime cost); the local reactive trail stays (UI reactivity, message field) but its entry type is built from the agent's `NavEntry`.
   - nav host construction: one factory `navHost(actor, impl)` in `state/nav.svelte.ts` (recording, standard "not available in this view" results, shared screenshot through `captureGraphics`), used by Workbench and Play.
4. Study picker:
   - engine: `RunOptions.studyId`; the worker solves that study (default: first).
   - Session: `study` (explicit choice, null = default behaviour unchanged), `solvedStudy` (study of the displayed solution); `compute()` runs the chosen study (a parametric one as a sweep).
   - results: `runStudies(spec, solved?)` and `RunSource.solvedStudy?` (additive optional args; default identical) so datasets of the solved study evaluate; Headlines passes the solved study. These two files are outside my owned paths: minimal additive edits, logged in s.4.
   - Workbench toolbar: a compact `<select>` of the studies (only when the model has more than one), tooltip with type and physics; the physics label follows the chosen study.
   - agent mount: the runner accepts any study id of the spec (selects it in the picker, then computes).
   - Verify in the browser: pzt4-cube std_oc and membrane-air eig_vac compute and their evaluation tables / plots show values.
5. Notes for chunk 2 on things seen but not owned (s.5).

## 3. TODO

- [x] DevLog plan (this file)
- [x] Results for the 8 sims
- [x] Node verification of every new plot item
- [x] `# eval:` headers (and the same pairings in `library/catalog.ts`)
- [x] Legacy global names (DevLog-028 O8) replaced by module scalars in the owned sims
- [x] Analog-hide rule shared
- [x] Nav types and nav-host factory shared (Workbench, Play)
- [x] Study picker (engine, session, results, workbench, agent mount)
- [x] `pnpm -r check`, apps/web `pnpm test`
- [x] Browser verification (new plot groups, study picker on pzt4-cube and membrane-air), screenshots looked at
- [x] DevLog-039 requests re-checked (none filed for T3 at 09:11 PST)
- [x] Hand-off

## 4. Progress log

- 2026-11-18 08:50 PST: Read CLAUDE.md, DevLog-037, C10, the sims, Workbench / Session / worker / nav / Play / mount. Plan written.
- 2026-11-18 08:52 PST: `# eval:` cross-check (headers vs catalog `evalCases` vs the case files' `spec:` pointers and titles). Fixed headers: helmholtz-coil [EM-04] (EM-03 removed: rings case), kirsch-plate [SM-01] (SM-02 removed: LE1), cylinder-cavity-axisym [RF-21, RF-01] (RF-01 names this file for its frequency targets), si-rib-waveguide [WO-02] (WO-01 removed: the 1D slab case; the sim's own `missing` says so); added nafems-t2 [HT-03], nafems-t3 [HT-02], nafems-t4 [HT-01], semi-infinite-convection [HT-04]. Same three wrong pairings fixed in `library/catalog.ts` (`evalCases` / `evalClass`).
- 2026-11-18 08:53 PST: plot groups added (s.2 item 1) and a full `results:` for cylinder-cavity-qd. Node check (scratch script: prepareRun + runStudy, then the web results adapter `evalTable` / `evalNodal` / `evalDataset` on every group): every new surface and line item evaluates with no error and no NaN (le1 syy -1.507..92.67 MPa; t2 T 927.0..1000 K; t3 T 0..61.85 degC at 32 s; semi-infinite T 0..157.2 degC; slabs |E| up to 1 V/m (normalised); axisym cavity |E| mode 0 up to 295.8 V/m).
- 2026-11-18 08:54 PST: the same check found pre-existing global items that are not module scalars (DevLog-028 O8): `ac.freq`, `wave.freq`, `hz.freq`, `rf.f`, `rf.freq` and `ht.T` as a global. Replaced in the owned sims by module scalars at the indices the paired cases extract: box-acoustics f_mode1..10 = ac.f_1..f_10 (index 0 is the f = 0 mode; AC-02 floor 1 Hz); bragg-edge-lower / -upper f_lower / f_upper = wave.f_0; wr90-te-cutoffs fc_TE10 / TE20 / TE01 = hz.f_1..f_3; cylinder-cavity-axisym the six RF-21 modes at the RF-21 extract indices 0, 1, 2, 3, 5, 8; cylinder-cavity (3D) TM010, TE111, TM011, TE211, TM110 at 3D indices 0, 1, 3, 4, 8 from a solve (TE011 is not listed: three modes within 0.6 MHz near 5.000 GHz, TM111 pair and TE011, not separable by frequency) plus Q_d = rf.Q_0; semi-infinite-convection T_probes = a point item on a cutpoint with the four HT-04 depths. Values after the fix (one level, default mesh): AC-02 modes 171.516 ... 430.147 Hz; WR-90 6.55715 / 13.1147 / 14.7543 GHz; RF-21 2.90365 / 2.92239 / 3.46817 / 4.14706 / 4.62655 / 5.00206 GHz; HT-04 140.419 / 98.8528 / 51.7628 / 14.4542 degC (case 140.4188 / 98.8528 / 51.7628 / 14.4540); qd Q_d 2500.00. Static check of all 48 sims afterwards: only `ewg.neff` (hadley-rib-wo02, si-rib-waveguide) and `solid.V_term_18` (ln-fbar-2d) are outside RESULT_NAMES patterns, and both evaluate (unprefixed `neff` scalar; piezo `V_term_<k>`).
- 2026-11-18 08:56 PST: analog-hide rule moved to `library/catalog.ts` (`HIDDEN_ANALOGS`, `LISTED_ENTRIES`, `listedIds`); Workbench and Landing use it.
- 2026-11-18 08:57 PST: `state/nav.svelte.ts`: types re-exported from `@amp/agent` (type-only import); trail entry type built from the agent's `NavEntry`; one factory `makeNavHost(actor, impl, missing)` (recording, screenshot, showPlot only when the view implements it) used by Workbench and Play. The Play view's messages are unchanged.
- 2026-11-18 08:58 PST: study picker: `RunOptions.studyId` (engine protocol + worker), `Session.study` / `chosenStudy` / `runStudy` / `solvedStudy`, `studiesOf()`, `parametricOf(data, id?)`; `runStudies(spec, solved?)` and `RunSource.solvedStudy?` in `results/api.ts`, `o.study` in `post/headline.ts`, one line in `ui/Headlines.svelte`, Bottom table / pin pass the solved study; toolbar `<select>` (only with more than one study; tooltip lists type and physics per study and the shown solution's study); the physics label and Compute tooltip follow the chosen study; `agent/mount.ts` runner accepts any study of the spec (sets the choice, then computes). apps/web `pnpm check`: 0 errors, 0 warnings.
- 2026-11-18 09:00 PST: dev server on 41733 (`logs/T3-dev-20261118T085854.log`); first browser pass on nafems-le1 OK (syy_map drawn, table syy_D 92.66602 MPa). Second pass: every sim unavailable because `@amp/physics` failed to load in the dev server (`packages/core/src/la/sparse.mjs` does not provide `blockElementSlots`: lane S4 mid-edit). Waiting for S4's tree to settle before the browser pass.

- 2026-11-18 09:03 PST: restarted my dev server (stale transformed `sparse.mjs` in vite's module graph after S4's edit; Node loads the package fine). Pages also reload whenever another lane edits a package file; the browser script detects a reload (window marker) and retries.
- 2026-11-18 09:06-09:07 PST: browser pass, headless shell 1234, 1440 x 900, `/workbench?sim=<id>`, Compute through the toolbar button, each new plot group shown through the `showPlot` hook, Table tab read from the DOM; no console errors or page errors (dev-server 404s of `/_app/immutable/*` modulepreloads excluded, s.5). Results: nafems-le1 syy_D 92.66602 MPa, syy_map drawn with deformation; nafems-t2 T_B 927.004 K, T_map and T_line drawn; nafems-t3 T_probe 36.60363 degC at t = 32 s, map + profile; semi-infinite-convection T_probes 140.4188 / 98.85282 / 51.76282 / 14.4542 degC, profile decays to 0 by x = 0.8 m; si-slab-te0 neff 2.849488, si-slab-tm0 neff 2.054616, both |E| map + profile (TM0 profile peaks at the core faces, as the normal E jumps by eps_core / eps_clad); cylinder-cavity-axisym table of the six RF-21 modes (2.903646 ... 5.00206 GHz), E_mode |E| maximum on the axis, zero at r = a (TM010); cylinder-cavity-qd f_low 2.889821 GHz, Q_d 2500, plot3d badge "not drawn here" (R4) with the quick view drawing the mode. Screenshots looked at: `<scratch>/shots/*.png`.
- 2026-11-18 09:08-09:09 PST: study picker in the browser: pzt4-cube picker options std_sc, std_oc (default std_sc); std_oc chosen in the `<select>`, Compute: solved std_oc, 36449 DOF, 11.78 s; tbl_open f1_open 79810.04 Hz, f2_open 93584.27 Hz (CP-06 targets 81590 / 93410 Hz: -2.2 % / +0.19 %, within the catalog's 3 % note); tbl_short shows N/A (study not solved, tooltip says so); V_open plot group selected, quick view draws es_oc.V. membrane-air: eig_vac chosen, solved 56369 DOF in 0.66 s, tbl_vac f_memb_vac 21.1851 Hz, tbl_air N/A.
- 2026-11-18 09:10 PST: agent runner path in the page (`studyRunner(session).run`): unknown study -> `no study 'nope' (studies: eig, eig_vac)`; `eig_vac` -> ok, 56369 DOF, f_0 21.185 Hz; the picker follows (eig_vac) and `solvedStudy` = eig_vac. si-rib-waveguide picker defaults to the parametric study sweep_t (the old default: Compute sweeps). kirsch-plate (one study): no picker. Landing: 42 / 42 cards, equal to `libraryFor(listedIds(SIM_IDS), LISTED_ENTRIES)`; hidden: the six acoustics analogs of EM problems. Play kirsch-plate solves; nav factory: set_view_mode ok, focus_node refused with the view's message, no show_plot.
- 2026-11-18 09:11 PST: `pnpm -r check`: all packages Done, apps/web svelte-check 0 errors / 0 warnings (1479 files). apps/web `pnpm test`: 55 pass, 0 fail. Dev server stopped (logs `logs/T3-dev-20261118T085854.log`, `logs/T3-dev-20261118T090247.log`).

## 5. Notes for chunk 2 (seen, not owned)

- Graphics: the "deformed x727" caption sits under the headline box (bottom left) on nafems-le1; a cut-line label at the right edge is clipped ("axi" for `axis` on nafems-t3); the colorbar minimum label is clipped at the right edge ("-6.10e-6").
- Headlines: with a non-first study solved, headline items of the other study show "not evaluated" (honest, but the box could list only items of the solved study or say which study they need).
- Quick view after a study switch draws the first field of the merged solution (pzt4 std_oc: es_oc.V); fine, but the plot group of the solved study (V_open) is not selected automatically.
- plot3d groups are still not drawn (R4 badge); cylinder-cavity-qd, pzt4-cube, box-acoustics rely on the quick view.
- Dev server: `/workbench` HTML carries modulepreload links to `/_app/immutable/*` build chunks that 404 under `vite dev` (13 per page load); they do not break the page. Source not traced (probably the route's server load / prerender output).
- Dev server under parallel lanes: every package edit triggers a full page reload; a mid-edit export mismatch can stay in vite's module graph until restart (seen with `packages/core/src/la/sparse.mjs` 09:00-09:02 PST). The T1 e2e smoke should detect reloads (window marker) and restart the server on a "failed to load" warning.
- `run_study` keeps a required `study`; an optional study (default: the workbench choice) needs `packages/agent/src/session.ts` (not owned). The browser runner now accepts any study.
- cylinder-cavity (3D): TE011 is not listed in its evaluation group: three modes within 0.6 MHz near 5.000 GHz (TM111 pair and TE011) cannot be told apart by frequency; an `ezFraction`-like scalar for emw would separate them.

## 6. Requests to the coordinator

- Files edited outside the owned list, all for the study picker (additive, default behaviour unchanged when no study is chosen): `apps/web/src/lib/results/api.ts` (`runStudies(spec, solved?)`, `RunSource.solvedStudy?`), `apps/web/src/lib/post/headline.ts` (`o.study`), `apps/web/src/lib/ui/Headlines.svelte` (passes `s.solvedStudy`), `apps/web/src/lib/agent/mount.ts` (runner accepts any study). Please review in the integration diff.
- Changelog line (web worker protocol, additive): `RunOptions.studyId` in `apps/web/src/lib/engine/protocol.ts`; the runner worker solves that study (default the first). C6 types in @amp/spec unchanged.
- To T1 (apps/web/test is theirs): a unit test for `runStudies(spec, solved)` (second study; parametric choice includes its inner study) and for `makeNavHost` (missing methods answer with the view message, every call recorded); the e2e landing count can import `HIDDEN_ANALOGS` / `listedIds` / `LISTED_ENTRIES` from `library/catalog.ts` instead of restating the rule.
- To T2: evaluation item ids renamed in sims (in case result-node extracts are planned): box-acoustics `freqs` -> `f_mode1`..`f_mode10`; bragg-edge-lower / -upper `edges` -> `f_lower` / `f_upper`; wr90-te-cutoffs `cutoffs` -> `fc_TE10`, `fc_TE20`, `fc_TE01`; cylinder-cavity-axisym and cylinder-cavity `freqs` -> `f_TM010` ... (axisym also `f_TE011`), cylinder-cavity `Q_d`; semi-infinite-convection `T_probes` is now a point item on the four HT-04 depths (values equal the case references to 4-6 digits on the default mesh). New headers: nafems-t2 HT-03, nafems-t3 HT-02, nafems-t4 HT-01, semi-infinite-convection HT-04; removed wrong ones: helmholtz-coil EM-03, kirsch-plate SM-02, si-rib-waveguide WO-01; added cylinder-cavity-axisym RF-01.
- Landing previews: the eight sims now have plot groups; regenerate previews at integration if they read plot groups.
