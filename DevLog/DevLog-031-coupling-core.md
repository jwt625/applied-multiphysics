# DevLog-031: coupling core, study driver, DC currents, Joule heating and thermal expansion (lane MC)

| Field | Value |
|---|---|
| Date | 2026-11-07 |
| Lane | MC (DevLog-029 s.3.2) |
| Owns | `packages/physics/src/{driver.ts, couplings/index.ts, couplings/core.ts, currents/**, prepare.ts, registrations.ts, index.ts}`, the coupling-input paths of `heat/index.ts` and `elastic/index.ts`, `packages/spec/src/types/**`, `apps/web/src/lib/engine/runner.worker.ts`, physics-prefix resolution in `packages/post`, `apps/web/src/lib/results/adapter.ts` `physicsIdOf`, this file |
| Parallel | LP (030, web routes / landing), MO (032, `modes/**`, `couplings/photonic.ts`), MT (033, elastic eigen / axisym, `piezo/**`, `couplings/twoway.ts`), MX (035, `sims/*.yaml`, `materials/*.yaml`) |
| Read | DevLog-029 s.2.3, s.3.1-3.3; CONTRACTS-v0 C3, C4, C5, C10, C11; `packages/physics/src/{index,prepare,registrations}.ts`, `heat/`, `elastic/`, `electrostatics/`, `common/*`; `packages/spec/src/{types/*,registry.ts,provisional/wave1.ts}`; `packages/post/src/{expr,store,evaluations}.ts`; `apps/web/src/lib/engine/{runner.worker,physics,registry}.ts`; `apps/web/src/lib/results/adapter.ts`; `apps/web/src/lib/gfx/Graphics.svelte` (field choice); eval cases CP-03, CP-21; `sims/heated-wire.yaml` |
| Status | done (gates s.4); open items and requests s.5 |

Conventions: "F" = fact read from code or a run; "D" = decision of this lane (reason given); "O" = open item.

## 1. Plan (2026-11-07 08:29 PST)

### 1.1 Facts (F)
- `prepareRun` resolves materials only for the properties of one physics type (`NEEDS[type]`, prepare.ts) and picks the study of that physics. Elastic already lists `alpha`; nobody lists `sigma`.
- The spec seed registers coupling `thermal-expansion` (heat -> elastic) with `settings.T_ref` (provisional); C11 names it `settings.Tref`. No sim or test uses `couplings` yet (grep 2026-11-07 08:28).
- heat takes a per-cell volume source `Q` (W/m^3) in `HeatProblem.Q`; the spec binding never fills it. elastic takes `thermal: {alpha per cell, T nodal, Tref}`; the spec binding never fills it.
- electrostatics: scalar H1 assembly (`assembleCells`, weight r in axisym), 2D and axisym only; terminal unit solves, energy-form capacitance matrix. `assembleCells` also works on tets / hexes.
- `@amp/post` `fieldOf(sol, name, step)` looks up by name only; `compileFieldExpr` strips a `<physicsId>.` prefix (the given one, or any non-field first segment). `apps/web` `physicsIdOf` returns a prefix only for single-physics studies; Graphics matches fields by name (`fieldRef(expr, fields, physIds, axisym)`).
- The web runner solves `ready[0]` only.

### 1.2 Design (D)
- **Types** (`packages/spec/src/types`, additive): `CoupledInput {coupling, from, kind, data}`, `RunContext.inputs?`, `FieldData.physics?`, `Solution.stats.byPhysics?` (per-physics stats of a merged solution).
- **Driver** `runStudy(prep, opts)` (`driver.ts`): the study = `opts.studyId` or `prep.study`; its physics = `study.physics` or `[prep.physicsId]`. Couplings whose `to` is solved by the study and whose `from` is too take part; `to` solved but `from` not = readiness reason. Monolithic couplings merge their two physics into one group. Kahn topological order over groups (ties in study order); a cycle is a readiness reason. Each sequential module gets `{...prep, physicsId, inputs}`; inputs come from `CouplingImpl.map({up, upId, down, node})`. Single physics without couplings: return `module.run({...prep, physicsId})` unchanged (bit-identical). Merge: fields tagged `physics` (shallow copies, data shared), scalars `<pid>.<name>` plus unprefixed when unique, `timing` `<pid>.<stage>` plus summed stages, `stats` summed with `byPhysics`, one run record (spec hash, mesh hash, driver start), notes unioned, steps from the one physics that has steps (two different step sets: error). Readiness: `studyReadiness(spec, studyId?)` (modules, coupling implementations, coupling endpoints, cycles, coupling property needs).
- **Couplings** (`couplings/core.ts`): `joule-heating` (currents -> heat): per-cell Q = cell mean of sigma |grad V|^2 (r-weighted mean in axisym, so the integral of Q equals the Joule power exactly), from the currents solution's per-cell `Q` field (DG0); cells outside the currents domain: 0. `thermal-expansion` (heat -> elastic): nodal T (last step if the heat solution has steps; noted), alpha per cell from the elastic materials, `Tref` from `settings.Tref` (C11 name; registration replaces the seed's `T_ref`); elastic cells outside the heat domain get alpha 0 (no temperature there, so no thermal strain; noted). Registrations `kind: coupling` with `for`.
- **heat / elastic bindings**: heat adds `inputs` of kind `joule-heating` into `HeatProblem.Q` (sum); elastic sets `thermal` from one `thermal-expansion` input (two: error). Nothing else in those files changes.
- **currents** (`currents/index.ts`): -div(sigma grad V) = 0 on 2D (per unit depth unless `settings.thickness`), 2D axisym, 3D. BCs: `ground`, `potential` (V field), `terminal` (settings `V` or `I`, A; 2D planar current terminals need `thickness`), `insulation` (natural, explicit). Solve: unit solves per terminal + one for the fixed potentials, conductance matrix G (energy form), terminal voltages for current terminals from `G Vt = I - I_p`, superposition. Outputs: `V` (H1), `E`, `J` (DG0 vectors), `Q` (DG0, W/m^3), scalars `I_<t>` (A), `V_<t>` (V), `R_<t>` = 1 / G_tt (Ohm; other terminals and grounds at 0 V), `G_<i>_<j>`, `P` (W; W/m in 2D without thickness). Registered dims 2d, 2d-axisym, 3d; BC types scoped to `currents`.
- **prepare.ts**: materials for the union of the needs of every physics of the chosen study (`sigma` for currents; one type = unchanged); optional `studyId`.
- **Post**: `fieldOf(sol, name, step, physics?)`; in `compileFieldExpr` and `evalGlobal`, when the solution has tagged fields, a first segment equal to a tagged physics id selects that physics' fields; untagged solutions resolve as today. adapter `physicsIdOf`: unchanged result for one physics; several physics: undefined (post resolves by tags). Graphics: match the field by name and physics tag (minimal edit) and label tagged fields `<pid>.<name>` in the field list, if needed.
- **Web runner**: readiness over all physics of the first study plus `studyReadiness`; then `runStudy`. Falls back to `module.run` when `runStudy` is not exported.

### 1.3 Gates
1. Single-physics `runStudy` bit-identical to `module.run` (fields, scalars) on existing sims.
2. currents: 3D box resistor with a current terminal: V = I R, R = L / (sigma A), P = I^2 R; axisym rod R = L / (sigma pi r^2); 2D with thickness R = L / (sigma W t). Test inputs (nominal, labelled).
3. Joule -> heat: CP-03 coupled variant (heated-wire with sigma_test and V0 chosen so sigma E^2 = q_gen of CP-03): T_center, T_surface vs the CP-03 closed form (eval/expected/CP-03.json).
4. heat -> elastic: free uniform heating (plane stress 2D, 3D tet10): stress ~ 0, u = alpha dT x exact. NAFEMS T1 (CP-21): sigma_yy just outside the hot spot at D vs 50 MPa within 1.5 %. Bimetal strip curvature vs Timoshenko 1925 (formula and source in s.4).
5. Class-a eval statuses and values identical to the baseline run before the change; `pnpm check` / `pnpm test`.

## 2. TODO
- [x] types, driver, couplings core + index, registrations
- [x] currents module
- [x] heat / elastic input bindings, prepare union
- [x] post + adapter + Graphics prefix resolution
- [x] web runner
- [x] tests / gates, class-a regression, check + test, browser run of a coupled spec
- [x] CONTRACTS changelog entry

## 3. Progress log
- 2026-11-07 08:29 PST: plan written; class-a baseline `logs/eval-20261107T082912.jsonl` (stdout `logs/MC-eval-a-baseline-20261107T082912.log`): cases 11 pass, 18 pending; targets 37 pass, 95 pending, 4 info.
- 2026-11-07 08:3x PST: types, currents, couplings core / index, registrations, prepare union, heat / elastic bindings, driver, index exports. `tsc` clean.
- 2026-11-07 08:37 PST: gates test `packages/physics/test/coupling.test.ts`; T1 first failed on a duplicate id in the test spec (material id = feature id), fixed in the test.
- 2026-11-07 08:38 PST: post `fieldOf` / expression / `sample` physics tags; web runner on `runStudy` / `studyReadiness`; adapter `physicsIdOf` comment; Graphics + `plot-data.ts` `fieldRef` keyed by physics tag. Checks: spec, physics, post, eval, agent `tsc` 0 errors, web `svelte-check` 0 errors (`logs/MC-check-20261107T083856.log`); `pnpm -r test` all pass (`logs/MC-test-20261107T083924.log`).
- 2026-11-07 08:41 PST: class a after: `logs/eval-20261107T084149.jsonl`: 136 / 136 target statuses and values identical to the baseline.
- 2026-11-07 08:44 PST: browser (vite dev, port 47461, headless shell): `/workbench?sim=heated-wire#d=<patch>` (coupled CP-03 variant), Compute: "solved 211 ms", field list `cur.V cur.E cur.J cur.Q ht.T`, ht.T 488-489 K, cur.Q uniform 1.15e6 W/m^3 (`logs/MC-browser-joule-T-20261107T084541.png`, `logs/MC-browser-joule-Q-20261107T084541.png`). Server stopped, port free. Results adapter on the merged solution (Node): T_center 488.67194532 K, T_surface 487.51059028 K, `cur.P` 100.0838 W (= CP-03 q_per_ft 100.0838 W), `max cur.Q` 1152043.4988 W/m^3, `ht.V` rejected (no such field of ht).
- 2026-11-07 08:47 PST: coordinator asked to close O1 / O2 (s.5).
- 2026-11-07 08:52 PST: O1 done (eval harness + agent FeRunner on the study driver). Class a `logs/eval-20261107T085023.jsonl` vs `logs/eval-20261107T084149.jsonl`: 136 / 136 identical (stdout `logs/MC-eval-a-o1-20261107T085023.log`). `packages/eval` tests 80 / 80 (`logs/MC-eval-test-20261107T085023.log`), `packages/agent` tests 63 / 63 (`logs/MC-agent-test-20261107T085023.log`), agent task suite 29 / 29 on the scripted mock provider (`logs/L9-eval-20261107T085203.jsonl`). Harness probe (temporary test, removed): an embedded coupled CP-03 variant plans as "run study 'std1' (cur -> ht)" and observes `ht.T_max` 488.67194532 K and `cur.P` 100.0838 W.
- 2026-11-07 08:53 PST: O2 done; web `svelte-check` 0 errors (`logs/MC-web-check-20261107T085009.log`); browser (vite dev 47461, stopped, port free): link `href="/"` text `amp`, label `heat + currents`, coupled solve "solved 174 ms", field list `cur.V cur.E cur.J cur.Q ht.T` (`logs/MC-browser-header-20261107T085351.png`). A first browser pass right after the dev-server restart clicked Compute before the cold compile finished (only "meshed"); the warm rerun solved.
- 2026-11-07 08:46 PST: CONTRACTS changelog entry; annulus test added; final gates `logs/MC-gates-20261107T084600.log` 11 / 11. Physics `pnpm test` at this time: 70 / 75, the 5 failures are MT's new `test/mt-piezo.test.ts` (in progress, lane MT); `tsc` errors only in MO / MT files (`test/photonic.test.ts`, `gates/mt-probe-tmp.ts`), none in MC files (`logs/MC-physics-test-20261107T084600.log`).

- 2026-11-07 09:02 PST: coordinator forwarded MO requests (DevLog-032 s.4.1 R0-R5 + merged-steps note); 09:0x MX requests (DevLog-035 s.6: X1 merged registry with MT's C, X2 elastic axisym / electrostatics 3d, X3 out-of-plane currents, X4 materials test, run of the 11 MX sims); 09:1x MT requests (DevLog-033 s.5 R1-R5).
- 2026-11-07 09:0x-09:15 PST: implemented (details s.6). MC gates (16-test run `logs/MC-gates-20261107T090742.log`; final run in s.6). MX sims run `logs/MC-mp-sims-20261107T091036.{log,json}` (before MT R3); rerun in s.6.
- 2026-11-07 09:13 PST: spec `test/sims-live.test.ts` failed for ln-fbar-2d / pzt4-cube: it calls `registerMaterialProperties` after `physicsRegistry()`, which re-imposed the cubic-only C over the merged (still flagged provisional) C. Fixed: merged registrations are settled (`provisional: false`, owner `@amp/physics + @amp/materials`); the test passes.

## 4. Gate results (`logs/MC-gates-20261107T084600.log`)

| Gate | Result | Reference |
|---|---|---|
| currents 3D tet10 bar, I = 2 A terminal | R 5.0000e-3 Ohm (rel 1.2e-12), V = I R, P = I^2 R (rel 1.3e-12), Q uniform | R = L / (sigma W t); test inputs |
| current terminal against a 0.5 V potential boundary | V_t = 0.5 + I R (rel < 1e-9) | superposition |
| axisym rod, 0.1 V terminal | I 15.70796327 A (rel 1.1e-13) | I = V sigma pi r^2 / L |
| axisym annulus, radial current | I rel 3.0e-7 (P2 vs ln r); integral of cell-mean Q = P (rel 1.0e-14); P = V I | I = 2 pi sigma H V / ln(r2 / r1) |
| 2D film with thickness / per unit depth | R rel < 1e-9; unit `Ohm*m` per depth; current terminal without thickness = readiness reason | R = L / (sigma W t) |
| Joule -> heat, CP-03 coupled variant (sigma 1e6 S/m test input, V0 = Lz sqrt(q_gen / sigma) = 0.32715 V) | T_center 488.671945321 K (rel 2.1e-13), T_surface 487.510590278 K (rel 1.7e-13), P = q_gen V (rel < 1e-9) | eval/expected/CP-03.json (closed form) |
| free uniform heating, plane stress 2D and 3D tet10 | u = alpha dT x (rel < 1e-9); mises_max 7.4e-6 Pa (2D), 5.9e-6 Pa (3D) vs E alpha dT 2.4e8 Pa | exact |
| NAFEMS T1 (CP-21), heat on the hot spot (100 degC Dirichlet, Tref 0 degC), elastic plane stress | sigma_yy(D+) 50.446 MPa (target 50.0 MPa, rel 0.89 %; within the CP-21 bounds 50.0-50.5 MPa); sxx inside -49.55 MPa | CP-21 (NAFEMS T1 via Altair OS-V 0100); atlas P2 Richardson 50.4475 MPa |
| bimetal strip, plane stress, clamped root, parabola fit on the interface over 0.2-0.8 L | kappa 0.93155648 1/m vs 0.93155648 1/m (rel 2.9e-9) | Timoshenko 1925, J. Opt. Soc. Am. 11(3) 233-255: kappa = 6 (a2 - a1) dT (1 + m)^2 / (h [3 (1 + m)^2 + (1 + m n)(m^2 + 1 / (m n))]), m = t1/t2, n = E1/E2, h = t1 + t2; test inputs |
| single physics through runStudy | heated-wire, kirsch-plate, coax-line: identical scalars, field data, no tags | module.run |
| readiness | unsolved upstream physics, missing implementation, alpha N/A for thermal-expansion, cycle: each a reason | C11 rules |
| class a | 136 / 136 identical | `logs/eval-20261107T082912.jsonl` vs `logs/eval-20261107T084149.jsonl` |

Note (F): the bimetal agreement is at round-off because the interior plane-stress solution of a long bilayer is the beam solution (sigma_yy = tau = 0, displacement quadratic), which P2 represents exactly; the CP-03 variant is exact because the Joule source is uniform.

## 5. Open items and requests

- O1 closed 2026-11-07 08:52 PST (coordinator request 08:47): `packages/eval` `registry.ts` reads `runStudy` / `studyReadiness` from the @amp/physics exports; `select()` keeps the single-physics path unchanged and, for specs with several physics, picks the case study (case study type, else the first non-parametric study), checks `studyReadiness`, and passes `studyId`; the result vocabulary is the union over the study's physics (bare and `<pid>.`-prefixed); `engine-worker.ts` runs `runStudy(ctx)` when exported (one physics = the same Solution). `packages/agent/eval/fixtures.ts` FeRunner: several physics -> `studyReadiness` + `prepareRun({studyId})`; every run through `runStudy`.
- O2 closed 2026-11-07 08:53 PST: `workbench/Workbench.svelte`: top bar `amp` link to the landing page (`resolve('/')`) before the library picker, and a label of the first study's physics types joined by ' + ' when the study has more than one physics (study order; tooltip says the couplings set the solve order). `workbench/Bottom.svelte` pin: rows of a merged solution get `<pid>.` from their field's physics tag (unique tag), components looked up by `<pid>.<name>`.
- R-MX (sims): coupled sim syntax (validated by the test specs):
```yaml
physics:
  - {id: cur, type: currents, select: ["dom:wire"], bcs: [
      {id: top, type: terminal, select: ["bnd:wire.top"], settings: {V: {value: 0.327, unit: V}}},   # or {I: {value: 2, unit: A}}
      {id: gnd, type: ground, select: ["bnd:wire.bottom"]},
      {id: ins, type: insulation, select: ["bnd:wire.right"]}]}       # 2D planar with current terminals: settings: {thickness: ...}
  - {id: ht, type: heat, select: ["dom:wire"], bcs: [...]}
  - {id: solid, type: elastic, select: ["dom:wire"], settings: {model: plane-stress}, bcs: [...]}
couplings:
  - {id: jh, type: joule-heating, from: cur, to: ht}
  - {id: te, type: thermal-expansion, from: ht, to: solid, settings: {Tref: {value: 20, unit: degC}}}
studies:
  - {id: std1, type: stationary, physics: [cur, ht, solid]}   # every physics the study solves; order is set by the couplings
```
  Materials need `sigma` (currents), `k` (heat), `E`, `nu`, `alpha` (elastic + thermal-expansion). Result expressions `cur.V`, `cur.Q`, `cur.J.z`, `ht.T`, `solid.mises`, scalars `cur.P`, `cur.I_top`, `cur.R_top`, `ht.T_max`. A physics id with `-` cannot be named in results (C10). A coupling whose `from` physics is not in the study is a readiness reason.
- R-MT: (a) monolithic `run({ctx, node})` gets one RunContext per physics (with `inputs` if a sequential coupling feeds either); tag returned fields with `physics` (untagged = `node.from`) and key scalars `<pid>.<name>` (unprefixed keys are prefixed `node.from`). (b) The thermal-expansion binding sits at the end of `elasticProblemFromContext` (`ctx.inputs` kind `thermal-expansion` -> `ElasticProblem.thermal`); keep it if the function is refactored, and honour `thermal` in the axisymmetric path (hoop thermal strain) for CP-02 (LE11). (c) `test/mt-piezo.test.ts` had 5 failures and `gates/mt-probe-tmp.ts` a tsc error at 08:46 (in progress).
- R-MO: thermo-optic can follow `couplings/core.ts` `thermalExpansion.map`: last T step, settings key `Tref` (C11), nodes outside the heat domain at Tref. `test/photonic.test.ts` line 190 had a tsc error at 08:46.

## 6. Requests of MO, MX, MT (2026-11-07 09:02-09:26 PST)

| Request | Done (files) |
|---|---|
| MO R0 / MX X1 merged registry | `registrations.ts` `physicsRegistry()`: seed -> `registerMaterialProperties` (seed bounds re-applied) -> @amp/physics registrations -> properties registered by both merged (tensor symmetries unioned, scalar if either allows) and marked settled (`provisional: false`). Coordinator 09:1x: @amp/materials `C` gains hexagonal-6mm, tetragonal-4mm, trigonal-3m; new `e_piezo` (6mm, 4mm, 3m); `PropertyDef.components`; `tensorComponents()`; `tensorMatrix(sym, c, prop?)` with MT's matrix forms (`packages/materials/src/{properties,schema,validate,library}.ts`) |
| MO R1 | `prepare.ts`: tensor overrides and library tensors -> `rec['<prop>.<comp>']` (SI); library n, dndT at the mode wavelength, dndT at the thermo-optic Tref; coupling needs pulled; optional `r_eo` (no note when absent) |
| MO R2 | em-modes `settings.crystals` (MO's `crystalsSchema`); `RESULT_NAMES['em-modes']` + `RESULT_NAMES_COUPLED` |
| MO R4 | `couplings/index.ts` `COUPLING_NEEDS` = `CORE_NEEDS` + `PHOTONIC_NEEDS` |
| MO R5 | heat `Q_total` = integral of the volume sources (per-cell Q incl. Joule, heat-source conditions at the last solved time), boundary fluxes excluded; W/m in 2D planar, W in axisym / 3D; present only with a volume source |
| MO note (steps) | `studyReadiness`: more than one solve group producing steps (predicted: electrostatics with > 1 terminal = param, heat in a time study, em-modes / emw / emw-axisym / acoustics = eigen, elastic in an eigen study) is a reason; the merge error names the fix. Post `fieldOf`: a step-less field of one physics holds for every step of another (si-microheater `T_core` had failed with "field 'T' has no step 1") |
| MX X2 / MT R1 | elastic dims + `2d-axisym`, model + `axisym` (checked against the geometry space); electrostatics dims + `3d`; RESULT_NAMES elastic + `srr sphi srz f_<k>` |
| MX X3 | currents `settings.outOfPlane {Ez | V + length | I}`: formulation in `currents/index.ts` header (uniform E_z in all conductors of the section, J_z = sigma E_z, Q = sigma E_z^2, I = E_z int sigma dA, P' = E_z^2 int sigma dA, R' = 1 / int sigma dA; no in-plane solve; insulation conditions only) |
| MX X4 | `packages/materials/test/library.test.ts`: the outcome invariant kept for every sim except `MAT_SIMS` (ln-fbar-2d, pzt4-cube, si-microheater-to, tfln-mzm-eo), which must validate with `physicsRegistry()`; C / e_piezo forms asserted |
| MT R3 | `CouplingImpl.readiness?`; `studyReadiness` skips module readiness inside monolithic groups and calls the coupling's |
| MT R4b | `prepare.ts`: elastic `rho` when the study is eigen or an acoustic-structure group exists; piezoelectric pulls optional `C`, `e_piezo`, `rho` |
| MT R5 | `index.ts` exports `solveElasticModes`, `ELASTIC_MODAL_NORMALIZATION`, `solveElasticAxisym`, `solvePiezo`, `PIEZO_NORMALIZATION`, `solveAcousticStructure`, `FSI_NORMALIZATION`; no NORMALIZATION entry for elastic (the modal / coupled solvers set their own; `wrap` does not overwrite) |
| MT R2 note | 3D standalone electrostatics capacitance unit `F/m` -> `F`: `electrostatics/index.ts` is lane MG's file; not changed (request to MG) |

Verification (2026-11-07 09:21-09:26 PST):
- MC gates 17 / 17 (`logs/MC-gates-20261107T092141.log`): new tests registry (dndT, r_eo, uniaxial n, cubic and 6mm C, axisym model check, electrostatics 3d), tensor flattening, library options at lambda / Tref (fake library), heated-wire `Q_total` = q_gen pi r0^2 Lz (rel < 1e-12), out-of-plane heater R = L / (sigma w t) and `Q_total` = P' (rel < 1e-9), two-step-set readiness reason.
- `pnpm -r test` all pass (core 81, rt 16, spec 65, eval 80, geom 39, materials 22, mesh 15, physics 97, agent 63, post 13, web 15; `logs/MC-test-20261107T092141.log`); `tsc` of spec, physics, post, eval, agent, materials clean (`logs/MC-check-20261107T091130.log`, materials and physics re-checked after the last edits); web `svelte-check` 0 errors (`logs/MC-web-check-20261107T092634.log`).
- Class a `logs/eval-20261107T092519.jsonl` vs `logs/eval-20261107T084149.jsonl`: 136 / 136 identical.
- Staged MX material files (`validation/mp/pending-materials/{pzt-4,linbo3-congruent}.yaml`): both validate with no issue; library getProperty: pzt-4 C tetragonal-4mm (6x6), e_piezo 4mm (3x6), eps_r uniaxial 804.6 / 659.7, rho 7500; linbo3 C trigonal-3m (6x6), e_piezo trigonal-3m (3x6), rho 4628 (`logs/MC-pending-materials-20261107T092122.log`). Not copied (MX's step).

### 6.1 The 11 MX sims (validate + prepareRun + runStudy + the sim's own evaluations through the results adapter; `logs/MC-mp-sims-20261107T092141.{log,json}`)

| Sim | Validates | Solves | Key numbers | Reference | Blocked by |
|---|---|---|---|---|---|
| nafems-t1-hotspot | yes | yes (21710 dof) | syy_D 49.79 MPa (sim item); MC test variant 50.45 MPa (element strain just outside D) | 50.0 MPa +-1.5 % (CP-21) | - |
| nafems-le11 | yes | yes (9261 dof) | szz_A -105.94 MPa | -105 MPa (CP-02), +0.89 % | - |
| bimetal-strip | yes | no | - | kappa 0.03934 1/m (references.json) | elastic `fixed` on a point (`pnt:al.p0`) is not supported (solveElastic selects facets only): MX sim fix (constrain a boundary instead) or point constraints in elastic (MT / elastic owner) |
| chip-warpage-2d | yes | no | - | kappa 1.3555 1/m (qualitative) | same point-constraint issue (`pnt:sub.p0`) |
| joule-wire | yes | yes (11778 dof) | T_center 488.67194532 K, T_surface 487.51059028 K, P 100.0838 W | CP-03 closed form 488.6719453 / 487.5105903 K, references.json I 305.92 A | - |
| hot-arm-actuator | yes | no | - | CP-04 | hex8 mesh: elastic stress recovery has no hex8 (`refNodes: hex8`): MX tet / tri mesh, or hex8 in elastic (MT / elastic owner) |
| si-microheater-to | yes | yes (165949 dof) | T_core 307.88 K, dneff 1.5515e-3, Ppi 9.435 mW | dneff for pi 1.7222e-3 at 18.889 W/m; measured P_pi 8.5 mW (Wang 2020): +11 % | - (X3 now allows currents -> joule-heating with `outOfPlane: {V or I}`; MX can switch the volume source to the currents chain) |
| tfln-mzm-eo | yes | yes (345174 dof) | VpiL 4.221 V cm, n_g 2.226, dneff/dV -1.151e-5 1/V | CP-43 VpiL 4.06 V cm +-10 % (+4.0 %); n_g 2.276 +-0.05 (-0.05) | - |
| pzt4-cube | yes | yes (36448 dof, std_sc) | f1_short 65101 Hz, f2_short 88146 Hz; open-circuit items need study std_oc (the runner solves the first study) | CP-06 66560 Hz (-2.2 %, tol 3 %), 88010 Hz (+0.15 %) | open-circuit values: second study (run it separately) |
| ln-fbar-2d | yes | yes (230570 dof) | modes 6.603-6.643 GHz (20 modes), uy_mid -3.399 (normalized mode, no physical scale) | references.json 2D thickness mode 6.6229 GHz (G = c11); mode identification by shape open | evaluation item is a normalized eigenmode amplitude: MX should evaluate a frequency |
| membrane-air | yes | yes (111671 dof) | f 0, 0, 66.39, 1951.7, 2687.6 Hz; uz_centre 4.003 (normalized) | uncoupled plate f01 197.45 Hz, cavity 11343 Hz (references.json) | identification of the coupled plate mode (66.4 Hz vs 197.5 Hz in vacuo) and the two f = 0 modes: MT / MX |

Sim fixes for MX (not edited by MC): bimetal-strip and chip-warpage-2d point constraints; hot-arm-actuator hex8 mesh; ln-fbar-2d and membrane-air evaluation items on normalized amplitudes; si-microheater-to can use `currents` with `outOfPlane` (e.g. `{V: <heater voltage>, length: "L_h"}`, or `{I: ...}`) instead of the fixed volume source; pzt4-cube open-circuit items need their own run.

## 9. Audit fixes (FE) (2026-11-07 10:14-10:29 PST)

Lane FE: the engine findings of the fresh-context audit (DevLog-029 10:14), coordinator decisions as given. Plan = the ten items below, in order; no edits to sims/, materials/, eval/cases/, catalog-mp.ts, DevLog-035 or CONTRACTS-v0 (lane FC).

- [x] 1. thermal-expansion into an eigen study: `driver.ts` studyReadiness reason "coupling '<id>': thermal-expansion into an eigen study is not supported (no thermal prestress in modal analysis)" (elastic/modal.ts ignores the thermal input). Readiness only; runStudy does not re-check.
- [x] 2. currents: cells with sigma <= 0 (or NaN, or outside the mask) are outside the conduction domain (`solveCurrents` mask); the spec binding names the materials in a solution note; no conducting cell left = run error "currents: no conducting cell (sigma > 0) in the domain". Auditor repro (sigma_b = 0 and 1e-12): R_t = 1.000 Ohm*m both.
- [x] 3. electro-optic one-terminal limit: `settings.terminal` description states it; studyReadiness adds "coupling '<id>' (electro-optic): electrostatics '<es>' has N terminal conditions (...); electro-optic supports exactly one terminal ..." next to the existing steps reason.
- [x] 4. apps/web runner.worker.ts passes `studyId` of the readiness-checked study into prepareRun; `studyId?: string` added to the prepareRun type in apps/web engine/physics.ts.
- [x] 5. optomechanical: photoelastic solid cells outside the optical domain are skipped (`photoelasticCells` in couplings/optomech.ts) with a note "... skipped in the photoelastic integral (the optical mode is solved only inside its closed window, so E = 0 there in this model)". Unit-tested only: an end-to-end run with such cells is blocked earlier by emw-axisym, which fails with "G^T M G not positive definite" whenever its selection leaves out mesh cells (dofs outside the mask stay free with zero rows; found 2026-11-07 10:20 with a split-disk and an outside-the-window variant of gaas-microdisk-om). Open item for the em-axisym owner.
- [x] 6. modalMass quadrature: triRule(4) -> triRule(5). Note: triRule(n) is the Duffy n x n rule, exact to degree 2n - 2 (checked numerically 10:17: triRule(4) exact to degree 6), so triRule(4) was already exact for the degree-5 integrand on affine tri6; triRule(5) (degree 8) also covers curved tri6. gaas-microdisk-om RBM1 (mech index 2): m_eff 4.038896221752493e-15 -> 4.0388962217524925e-15 kg, x_zpf 1.2291007678544814e-15 -> 1.2291007678544816e-15 m, g0MB/2pi -206240.1749 -> -206240.1749 Hz, g0PE/2pi -168019.3093 -> -168019.3093 Hz; max relative change over all scalars 8.9e-15.
- [x] 7. flattened tensor keys (`materialTensor`, couplings/twoway.ts): symmetry from the exact key set (C14 -> trigonal-3m, C66 -> tetragonal-4mm, 5 keys -> hexagonal-6mm, 3 -> cubic); no exact match (both C14 and C66, or an incomplete set) = error naming the material. Piezo e15/e31/e33 matches 6mm and 4mm with the same tensor form (first taken). Library keys checked: linbo3-congruent C (3m), e_piezo (3m); pzt-4 C (4mm), e_piezo (3 keys), eps_r uniaxial; silicon C cubic.
- [x] 8. prepare.ts: hex8 -> tet10 split only when the selected study (pickStudy: studyId, else the first study of the physics / eval case study type) solves an elastic physics (a study without a physics list: the prepared physics is elastic). The mesh-chain cache key includes the flag.
- [x] 9. prepare.ts comment fixed. Contracts changelog line for the coordinator: prepareRun evaluates library n and dndT of a mode study at the study wavelength (MatContext.lambda) also for a single physics without couplings, so wavelength-dependent library values can differ from the earlier lambda-free evaluation.
- [x] 10. hygiene: `packages/physics/src/electrostatics/check-sims.ts` -> `packages/physics/scripts/check-sims.ts`; `packages/geom/scripts/dump-selections.ts` -> `packages/physics/scripts/dump-selections.ts` (imports `@amp/mesh/spec`, `@amp/geom`; empty geom/scripts removed); `packages/physics/test/mom-conv.ts` -> `packages/physics/scripts/mom-conv.ts`; physics tsconfig includes `scripts/**/*.ts`; `gates/run-all.ts` runs `mt-gates.ts` last. DevLog-034 / DevLog-036 still cite the old paths (not edited by FE).

Tests: `packages/physics/test/audit-fe.test.ts` (6 tests: items 1, 2, 3, 5, 7, 8).

Progress:
- 2026-11-07 10:14 PST: start; read driver, currents, photonic, optomech, twoway, prepare, web runner.
- 2026-11-07 10:18 PST: gaas-microdisk-om before/after dump (item 6), values above.
- 2026-11-07 10:22 PST: audit-fe tests 6/6 (`logs/FE-audit-test-20261107T102105.log` and later reruns).
- 2026-11-07 10:23 PST: `pnpm -r check` clean (`logs/FE-check-20261107T102250.log`); `pnpm -r --workspace-concurrency=1 test` 11 packages, 520 tests, 0 fail (`logs/FE-test-20261107T102318.log`).
- 2026-11-07 10:26 PST: class a `logs/eval-20261107T102633.jsonl` vs `logs/eval-20261107T095025.jsonl`: 136 / 136 target records identical (case, target: pass, value).
- 2026-11-07 10:28 PST: `gates/mt-gates.ts` alone (`logs/FE-mt-gates-stdout-20261107T102752.log`): exits 1 in gate cp06: "piezoelectric: material 'pzt4' has neither a stiffness tensor C nor E, nu". Cause: sims/pzt4-cube.yaml now uses `ref: materials/pzt-4` (09:32) while the gate (09:33) reads `override.C` and passes `materials: { pzt4: { rho } }` without the library; same result with the old materialTensor (no keys -> null). Gate needs updating by its owner (MT); full `pnpm gates` not run (unbounded runtime, and it would end on this exit 1).
