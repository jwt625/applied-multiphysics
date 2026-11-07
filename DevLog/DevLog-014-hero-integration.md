# DevLog-014: Hero integration on the eval harness (lane I1)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | I1 (hero integration, milestone M2 engine half) |
| Owns | `sims/**`; in `eval/cases/a/` and `eval/cases/b/` only the `spec` and `extract` fields of targets and missing `metric_id` slugs; `packages/physics/src/result-names.ts` (only to add names); this file |
| Inputs | DevLog-001 s.8, s.10; CONTRACTS-v0 + changelog (metric naming 16:32); DevLog-003, 004, 009 s.9, 010; eval/schema, eval/README |
| Read only | packages/spec (L2), packages/geom + packages/mesh (L3), eval/cases/c (L7c), apps/web (L5), packages/agent (L9), packages/physics + packages/post (L4, under audit), packages/eval (L8) |

## 1. Plan (written 2026-11-06 16:34 PST, before the specs)

Goal: H1-H6 cases run end to end through `node packages/eval/src/cli.ts --case <ID>` on the real engine (spec -> geometry -> mesh -> solve -> extract -> gate) with real pass / fail.

Per case:
1. Write `sims/<case-slug>.yaml` (amp-spec/0) that reproduces the case's geometry, BCs and study. Material values: explicit `override` values copied from the case's `materials` block (the case carries the source; the spec's `provenance.values` names the case file and the original source), or `ref: materials/<id>` where the library has the property. No value without a source.
2. Point the case's `spec:` at the file and add an `extract` per target in the harness form that exists today (`kind: scalar | probe | field | eigen`, `name` / `field` / `point` / `index` / `floor`). The 16:32 contract form `extract: {result, index|at|select, reduce?}` is not in `eval/schema` or the harness yet (schema `extract.additionalProperties: false`), so it cannot be used without a loader error; recorded under Contract requests.
3. Run the case alone, then all of class a. Record pass / fail / pending, error, DOF and wall time per stage and level.
4. A failure that a correct solver should pass: engine bug (evidence for L4) or case bug (evidence for the case lane). Never change a value, tolerance, source or convergence block.

Constraints known before the runs (from reading the code):
- `prepareRun` (L4) remeshes per level by scaling the size field (non-nested CDT levels). L3's `refineUniform` (nested) is not called from `prepareRun`, so the harness cannot give nested sequences until L4 wires it (Contract request). The harness falls back to `finest+monotone` when Richardson is unavailable.
- Engine spec binding (L4): heat BC values and elastic tractions are read with `resolveQuantity` (constants only), so HT-02 (sin(pi t / 40) end temperature) and SM-01 (exact Kirsch traction) need expression-valued BCs in the module binding even though `@amp/spec` now accepts `field` expressions.
- Class-c cases (EM-02, EM-03, RF-01) are L7c's files: specs are written here; the `spec` / `extract` lines are handed to L7c.

## 2. TODO

- [x] Coordinator note 1: `sims/si-rib-waveguide.yaml` param `t` -> `t_slab` (all references); geom spec test 3/3
- [x] H2: HT-01, HT-02, HT-03 pass; HT-04 3/4 (fallback rule, s.5 item 12)
- [x] H1: SM-01 pass (5/5); SM-02 fail by the fallback rule against a rounded reference (s.5 items 7, 12)
- [x] H3: EM-04 pass; EM-03 spec for L7c (s.5 item 8)
- [x] static EM: EM-01 pass; EM-02 spec for L7c
- [x] H4: WO-01 pass (TE0 + TM0 via per-target spec); WO-02 metric_id, spec pending (harness: sweep targets)
- [x] H5: RF-21 pass (7/7: frequencies on `emw-axisym`, Q_d on 3D); RF-01 lines for L7c
- [x] H6: AC-02 pass (10/10)
- [x] Whole class a and class b on the engine (s.4.2)
- [x] <5 s table per hero (s.4.3)
- [x] SM-06 extracts, 92 class-b metric_id slugs, hero sims materials and eval links (coordinator / L5 notes)
- [x] Summary table, contract requests, hand-off
- [ ] WO-02 on the harness (needs sweep targets and a t = 0 geometry variant)
- [ ] HT-04 x = 0.0859 m and SM-02: pass once the fallback rule or the dt refinement changes (s.5 items 12, 13)

## 3. Progress log

- 2026-11-06 16:33 PST: read CLAUDE.md, DevLog-001, CONTRACTS-v0, DevLog-009 s.9, DevLog-010, eval README, schema `extract`; harness `registry.ts` / `engine-worker.ts`; L4 `prepare.ts`, `registrations.ts`, module spec bindings.
- 2026-11-06 16:34 PST: plan (s.1) written; coordinator note 1 done (param `t` -> `t_slab` in `sims/si-rib-waveguide.yaml`; geom spec test 3/3).
- 2026-11-06 16:36 PST: HT-01 (`sims/nafems-t4.yaml`) pass on the harness. 16:36 HT-03 (`sims/nafems-t2.yaml`) pass.
- 2026-11-06 16:37 PST: HT-04 (`sims/semi-infinite-convection.yaml`) error "run failed: not a quantity": `packages/physics/src/heat/index.ts:278` read `study.settings.step`, the `@amp/spec` time study is strict `{start, stop, dt, method, output?}`. HT-02 (`sims/nafems-t3.yaml`) error "expression ... unknown variable 't'" (BC values read with `resolveQuantity`). First `{expr: "273.15[K] + 100[K]*sin(...)", unit: K}` failed validation (K^2: the unit multiplies the expression); corrected to `{expr: "273.15 + 100*sin(pi*t/(40[s]))", unit: K}`.
- 2026-11-06 16:38 PST: SM-02 (`sims/nafems-le1.yaml`) invalid: `physicsRegistry()` lacked `@amp/geom/spec` features (ellipse, intersection). Three binding bugs sent to the coordinator for L4 (16:38).
- 2026-11-06 16:39 PST: coordinator notes 2 (L2 contracts-v1 spec features, stale `missing` entries) and 3 (L5: eval link in specs, real material values, rib material ids): `kirsch-plate` / `helmholtz-coil` stale entries removed or restated (copper and air `mu_r` are N/A in @amp/materials, so `mu_r: 1` overrides from EM-04 "vacuum"); hero sims filled from their cases (heat-plate-fin k 52, box-acoustics c 343 / rho 1.2, cylinder-cavity eps_r 2.08 / tan_delta 4e-4 / mu_r 1, si-rib-waveguide n 3.44 / 3.40 / 1); rib material ids `core / substrate / cover`, window features renamed `win_top / win_sub` (node ids are global, `substrate` / `cover` clashed); `# eval: [...]` comment as the last line of each spec (amp-spec/0 has no field; a first-line comment shifted the line numbers L2's schema tests assert).
- 2026-11-06 16:40 PST: EM-04 (`sims/helmholtz-em04.yaml`, rect truncation box half-size 100 R instead of the L4 half disk, no `intersection` needed) pass. 16:41 EM-01 (`sims/coax-line.yaml`) pass.
- 2026-11-06 16:41 PST: AC-02 -> `sims/box-acoustics.yaml` (nModes 11): fail, Q1 hex8 finest outside the budget (s.4). Engine: prepareRun forces order 1 for acoustics.
- 2026-11-06 16:42-16:45 PST: RF-21 -> `sims/cylinder-cavity.yaml`: hmax a/4 timed out (120 s = 20 x 2 s x 3 levels; levels a/4, a/6, a/9 -> 13k, 45k, ~150k DOF); hmax a/3: 5/7 pass, 54 s.
- 2026-11-06 16:46 PST: WO-01 TE0 (`sims/si-slab-te0.yaml`) pass; TM0 needs its own BC set (`sims/si-slab-tm0.yaml`, PMC x walls), checked outside the harness: 2.0546163 / 2.0546180 / 2.0546184 vs 2.0546185 (levels 1, 0.667, 0.444).
- 2026-11-06 16:47 PST: SM-01 (`sims/kirsch-exact.yaml`, exact Kirsch traction as x, y expressions; Cartesian form checked against `validation/a/gen_solid.py kirsch_field` to 3e-16 rel on 6 edge points) 3/5 pass (L4's expression tractions had landed); SM-02 fail on the fallback monotone rule.
- 2026-11-06 16:48 PST: EM-02 (`sims/two-spheres.yaml`) and EM-03 (`sims/coplanar-rings.yaml`) written for L7c and run outside the harness (s.4).
- 2026-11-06 16:49 PST: WO-02 `metric_id: neff_fund_vs_t_slab` added; spec stays pending with a new reason (s.5). Materials note (DevLog-013 s.7): `kirsch-plate` used `materials/structural-steel`, whose E and nu need T, which an elastic spec cannot state, so prepareRun left E empty ("material 'steel' has no value for 'E'"); switched to the SM-01 case inputs (E 200 GPa, nu 0.3, synthetic). No sims spec uses library indices.
- 2026-11-06 16:50 PST: after L4's heat fixes: HT-02 and HT-04 pass. AC-02 P2 request sent to the coordinator.

- 2026-11-06 16:56-16:59 PST: L8 Follow-up 3 landed: SM-01 `K_t` as `{kind: expr, expr: "sxx_top / s_inf", terms: {sxx_top: probe sxx at (0, a), s_inf: 1e8 Pa}}`; `field_rel_L2_stress` as `{kind: field, fields: [sxx, syy, sxy], evaluator: validation/a/fields.py, points: 42 polar points r = 1.05..8 a, theta 0..90 deg}` (pending: L8 pre-check ignores `fields`, reported); WO-01 `neff_TM0` with target `spec: sims/si-slab-tm0.yaml`: WO-01 passes both. SM-06 extracts fixed (`floor: 0.01, index: 0..6`, offset dropped: 14 loader errors gone). 92 `metric_id` slugs added in class b (quantity plus `case` values, e.g. `Nu_mean.Ra10000`, `IL_per_mm.f_GHz33.T_C25`; flow-style items get the key inside the braces); class a had none missing, class c none missing (nothing to list). Dry run: 85 cases, 0 loader errors, 0 warnings (`logs/eval-20261106T165929*.jsonl` and the run after it).

- 2026-11-06 17:07 PST: L4 Follow-up 2 landed (DevLog-010 s.7). Class a on the engine (`logs/eval-20261106T170718.jsonl`, ratio 1.5, non-nested): 8 pass, 3 fail (RF-21, SM-01 K_t monotone, SM-02 monotone), 18 pending, 0 error.
- 2026-11-06 17:10 PST: coordinator request: `convergence.h_factors: [1, 0.5, 0.25]` and `expected_order` added to HT-01..04 (3: P2 point values; dt fixed, so h-only), SM-01 and SM-02 (2: stresses), EM-01 (4: capacitance is an energy), EM-04 (2: B is a gradient), WO-01, AC-02 (4: eigenvalues). The schema has only a case-level `expected_order` (SM-01 mixes stresses and displacements; the displacements go the fallback route). `sims/box-acoustics.yaml` hmax Lz/8 -> Lz/3 (0.2 m; nested P2 levels 693 / 4,641 / 33,825 DOF as in L4's gate; Lz/8 would give about 7e5 DOF at the third level).
- 2026-11-06 17:11 PST: nested run: HT-01, HT-02, HT-03, SM-01 (5/5, K_t 2.99999166, field L2 now evaluated), EM-01 (6.4e-8), EM-04, WO-01, AC-02 (10/10, worst 4.5e-7) pass. HT-04 2/4 fail: a BDF2 time-error floor (dt 5 s) of -6.6e-5 to -7.7e-5 degC on all levels, so |error| is flat and not monotone. dt 1 s: floor -2.6e-6 to -3.0e-6 degC, still 1 fail (x = 0.0859 m: -7.1e-6, -2.5e-6, -3.0e-6 degC); dt 0.25 s: floor about -2e-7 degC, 1 fail (x = 0.0859: -4.3e-6, +2.5e-7, -2.7e-7 degC: the error crosses zero), 13.7 s. Kept dt 1 s; this is the fallback rule against a fixed time-error floor, 4 to 5 orders below the 1e-3 budget (s.5). SM-02 fail: 92.666017 / 92.657420 / 92.657626 MPa, converged to 92.6576 vs a 3-significant-figure reference 92.7 (s.5).
- 2026-11-06 17:15-17:20 PST: RF-21 with nested levels: base hmax a gives 2,188 / 20,224 DOF (0.4 / 3.3 s) and the third level times out (120 s); base a/3: hFactor 0.5 is already 126,008 DOF, 111 s. Non-nested ratio 1.5 (hFactor 0.6667, 0.4444): `prepareRun` returns the same 14,882-DOF mesh as hFactor 1 (note "re-meshed with scaled sizes", DOF unchanged): engine bug sent to the coordinator. RF-21 left at ratio 1.5 with `expected_order: 4` and no `h_factors`, base hmax a/3.
- 2026-11-06 17:20 PST: WO-41 analysis (s.5 item 14).

- 2026-11-06 17:15-17:18 PST: `--speed` run over the hero cases; stopped (own process) at RF-21 after the coordinator's machine note (3D cavity memory), so RF-21 has no warm timing.
- 2026-11-06 17:18-17:20 PST: L4 `emw-axisym` (DevLog-010 s.8): `sims/cylinder-cavity-axisym.yaml` (meridional rect, m = 0, 1, 2, nModes 6 per m, hmax a/4); merged spectrum checked at hFactor 1 / 0.5 / 0.25 for a stable order (TM111 m = 1 stays at index 7 below TE011 m = 0 at index 8 on all levels); RF-21 indices 0, 1, 2, 5, 3, 8; Q_dielectric on `sims/cylinder-cavity-qd.yaml` (3D, hmax 4a: 1,006 / 10,180 / 90,424 DOF). RF-21 7/7 pass, `h_factors: [1, 0.5, 0.25]` restored. `sims/cylinder-cavity.yaml` hmax back to a/4 (hero view).
- 2026-11-06 17:20-17:21 PST: final class a and class b runs (s.4.2); sims validate; geom spec test 3/3; scans: no non-ASCII, no absolute paths in sims/ and the edited cases.

## 4. Results

Machine: Apple M4 Pro, 12 cores, 24 GB, Node v23.7.0, `nice -n 10`, worker heap cap 1536 MB, other lanes active. All numbers from the harness (`node packages/eval/src/cli.ts`) on the real engine: spec -> `@amp/geom` -> `@amp/mesh` -> `@amp/physics` -> extract (`@amp/post` sample) -> gate. Levels `h_factors: [1, 0.5, 0.25]` (nested `refineUniform` in `prepareRun`) except where stated.

### 4.1 Summary per hero (final run `logs/eval-20261106T172055.jsonl`, class a)

| Hero | Case | Spec(s) | Status | Targets | Error (finest or Richardson, as gated) | DOF finest | End to end Node, 3 levels (cold accuracy run; warm median sum) |
|---|---|---|---|---|---|---|---|
| H1 | SM-01 Kirsch | sims/kirsch-exact.yaml | pass | 5/5 | K_t 2.99999166 (-2.8e-6, Richardson p 2.29); syy(a,0) 4.7e-5; u_x 2.1e-8; u_y 1.1e-7; stress L2 rate rule pass | 65,104 | 1.27 s; 0.83 s |
| H1 | SM-02 NAFEMS LE1 | sims/nafems-le1.yaml | FAIL (rule) | 0/1 | 92.6576 MPa vs 92.7 (P): -4.6e-4, budget 1e-2; levels 92.6660 / 92.6574 / 92.6576 (not monotone in |error| vs the rounded ref) | 65,056 | 1.32 s; 0.82 s |
| H2 | HT-01 NAFEMS T4 | sims/nafems-t4.yaml | pass | 1/1 (+1 info) | 18.253752 C, -2.4e-7 (Richardson p 2.82) | 39,036 | 0.51 s; 0.19 s |
| H2 | HT-02 NAFEMS T3 | sims/nafems-t3.yaml | pass | 1/1 (+1 info) | 36.603057 C, -1.6e-6 (finest + monotone) | 3,359 | 0.54 s; 0.42 s |
| H2 | HT-03 NAFEMS T2 | sims/nafems-t2.yaml | pass | 1/1 (+1 info) | 927.0039505 K, 2.1e-12 | 1,648 | 0.14 s; 0.02 s |
| H2 | HT-04 Carslaw-Jaeger | sims/semi-infinite-convection.yaml | FAIL (rule) | 3/4 | 1.9e-8 / 3.1e-8 / 4.1e-8 / 9.3e-8 rel; x = 0.0859 m fails "non-increasing |error|" at -7.1e-6 / -2.5e-6 / -3.0e-6 C (BDF2 dt 1 s floor), budget 0.099 C | 9,125 | 3.55 s; 3.61 s |
| H3 | EM-04 Helmholtz | sims/helmholtz-em04.yaml | pass | 3/3 gated (2 ungated pending) | B(0) -2.8e-6, Bz probe -3.0e-6 (finest + monotone; p 3.95 / 3.70 vs theory 2), Br probe abs 4.3e-12 T | 184,973 | 2.17 s; 1.18 s |
| - | EM-01 coax | sims/coax-line.yaml | pass | 3/3 | C', L', Z0 6.4e-8 (Richardson p 3.69) | 9,632 | 0.26 s; 0.08 s |
| H4 | WO-01 Si slab | sims/si-slab-te0.yaml, sims/si-slab-tm0.yaml (TM0) | pass | 2/2 | TE0 1.7e-9, TM0 4.5e-9 (finest + monotone; p 1.92 / 2.04 vs theory 4) | 137,529 / 143,927 | 1.47 s + 1.93 s; 0.92 s (TE0 group) |
| H5 | RF-21 cavity | sims/cylinder-cavity-axisym.yaml (6 frequencies), sims/cylinder-cavity-qd.yaml (Q_d, 3D) | pass | 7/7 | TM010 2.7e-10, TE111 8.9e-9, TM011 1.2e-10, TM110 9.4e-10, TE211 3.7e-9, TE011 2.6e-8 (Richardson p 3.74-3.95); Q_d 2500 (7.8e-15) | 68,117 (axisym, m = 0, 1, 2); 90,424 (3D) | frequencies 2.14 s; Q_d 3D group 12.9 s; warm not measured |
| H6 | AC-02 room | sims/box-acoustics.yaml | pass | 10/10 | worst 4.5e-7 (f_mode8), Richardson p 4.03-4.24 | 33,825 | 8.32 s; 6.25 s |

Class b hero: WO-02 (Hadley rib) pending on the harness (sweep target, t = 0 variant; s.5 item 5d); `sims/si-rib-waveguide.yaml` at t_slab = 0.1 um gives n_eff 3.4121254 vs 3.412126 (info, one level, 3.9 s, 328k DOF). L4's own gate passes 8/8 (DevLog-010 s.7.2).

Class c, specs here, run outside the harness (`prepareRun` + module, ratio 1.5 levels, 16:48): EM-02 `sims/two-spheres.yaml` C_aa 1.2305253e-12 (+6.3e-6 vs Lekner), C_ab -4.945552e-13 (-2.3e-5), C_bb 2.4315794e-12 (+1.5e-5), finest 36,121 DOF, 0.24 s; EM-03 `sims/coplanar-rings.yaml` L_aa 4.180658e-11 (+5.1e-4), M_ab 1.982604e-12 (+6.2e-4 vs filament), L_bb 7.072074e-10 (+3e-6), finest 82,256 DOF, 18 s (machine loaded; L4's nested gate 2.8 s).

### 4.2 Whole classes on the engine

| Run | Cases pass / fail / pending / error | Targets pass / fail / pending / info | Log |
|---|---|---|---|
| class a (17:20) | 9 / 2 / 18 / 0 | 36 / 2 / 95 / 3 | `logs/eval-20261106T172055.jsonl` |
| class b (17:21) | 0 / 0 / 20 / 0 | 0 / 0 / 93 / 0 | `logs/eval-20261106T172135.jsonl` |
| dry run, all 85 (16:59) | loader 0 errors, 0 warnings | | `logs/eval-20261106T165929*.jsonl` |

Class-a pending: 18 non-hero cases with `spec: pending` (no sims written for them in this lane). Class b: every spec pending (WO-02 reason updated).

### 4.3 <5 s target (Node, end to end incl. prepareRun = validate + geometry + mesh + materials)

`--speed` (1 warm-up + median of 5 per level, `logs/i1-speed-20261106T171527.txt`), sum over the 3 verdict levels:

| Hero | Case | Warm sum of the 3 levels | Largest stage | < 5 s |
|---|---|---|---|---|
| H1 | SM-01 / SM-02 | 0.83 / 0.82 s | post 331 ms (stress recovery), factor 254 ms | yes |
| H2 | HT-01 / HT-02 / HT-03 / HT-04 | 0.19 / 0.42 / 0.02 / 3.61 s | HT-04 solve 963 ms (2000 BDF2 steps x 3 levels) | yes |
| H3 | EM-04 | 1.18 s | factor 694 ms | yes |
| - | EM-01 | 0.08 s | factor 33 ms | yes |
| H4 | WO-01 (TE0 group) | 0.92 s | model 313 ms, solve 284 ms | yes (TM0 group cold 1.93 s) |
| H5 | RF-21 frequencies (axisym) | cold 2.14 s (speed run stopped: machine note on the 3D group) | finest level 1.42 s | yes (frequencies); the 3D Q_d group 12.9 s cold: no |
| H6 | AC-02 | 6.25 s | factor 3.43 s, solve 2.12 s at 33,825 P2 DOF | no on the nested 3-level verdict; L4's non-nested s = 1, 2, 3 sequence (14,725 DOF finest) 1.75 s |

Browser times are not measured (L5).

## 5. Contract requests

1. **L8 / eval schema: `extract.result`.** The 16:32 changelog form `extract: {result, index | at | select, reduce?}` is not in `eval/schema/amp-eval-0.schema.json` (`extract.additionalProperties: false`) or in `registry.ts extractFromSolution`. All mappings here use the existing form (`kind`, `name`, `field`, `component`, `point`, `index`, `floor`); they convert mechanically once the new form exists. `packages/physics/src/result-names.ts` was not created: the harness consumes `RESULT_NAMES` as `{fields, scalars}` per module type, and every target mapped here is covered by it.
2. **L2: an `eval` field in amp-spec/0** (L5 request): `eval: [case ids]` linking a spec to its eval cases. Meanwhile each spec ends with a comment line `# eval: [ID, ...]`.
3. **L2: `packages/spec/test/schema.test.ts` encodes the old sims rule.** After the coordinator / L5 decision (real sourced values in sims/, no stale `missing`), 3 tests fail on the sims files: "every material value in the examples is a materials/ ref or N/A covered by missing" (`kirsch-plate: ref materials/structural-steel without a missing entry`, then non-N/A overrides), "dimension mismatches, unknown params and N/A coverage" (`na_without_missing geometry.features.1.settings.radius`, a fixture built from a sims file), "provenance and dotted paths" (`fixture substring not unique: {path: materials.solid.override.k,` after the `missing` entry was removed). The tests need the new rule (every override value has a `provenance.values` entry with a source).
4. **L4 (sent 16:38 and 16:50; heat, expression BCs and the geometry registry landed by 16:50):** (a) `physicsRegistry()` without `registerGeomFeatures`; (b) heat transient read `settings.step` (spec: `dt`); (c) BC values constants only (heat T, elastic traction); (d) `prepareRun` remeshes per level (non-nested): wire `refineUniform` / `meshCylinder(order 2)`; (e) acoustics forced to order 1 (Q1 hex8): needs `settings.order` and a P2 (tet10) box mesh.
5. **L8: targets the harness cannot extract yet.** (a) per-target `spec` (WO-01 TM0 needs PMC x walls: `sims/si-slab-tm0.yaml`); (b) derived ratio (SM-01 `K_t` = sigma_xx(0, a) / s_inf); (c) tensor stress field error (SM-01 `field_rel_L2_stress`); (d) parametric-sweep targets (WO-02: 8 slab thicknesses in one target); (e) eigen targets by mode character, not position (RF-21 TE011 is exactly degenerate with TM111; `index: 11` is the case's own "3D ascending index 12" locator, so it is correct, but a classifier would be more robust).
6. **L7a: `eval/cases/a/*.yaml` are generated** by `validation/a/build_cases.py`. Rebuilding them would drop the `spec:` pointers and `extract` lines added here (HT-01..04, SM-01, SM-02, EM-01, EM-04, WO-01, RF-21, AC-02). The generator should carry them.
7. **L7a / L8: SM-02 fallback rule against a 3-significant-figure reference.** `sigma_yy_D` ref 92.7 MPa (basis P). With non-nested levels the fallback gates "finest within budget and |error| non-increasing"; |error| against a rounded reference is not a convergence indicator once the solution is within the rounding (finest 92.656 MPa, 4.7e-4 rel, budget 1e-2). Either nested levels (4d) or a fallback that does not require monotone |error| when every level is within the budget.
8. **L7c: lines for the class-c cases** (specs here, run outside the harness, s.4):
   - EM-02: `spec: sims/two-spheres.yaml`; `C_aa` `{kind: scalar, name: C_ta_ta}`, `C_bb` `{kind: scalar, name: C_tb_tb}`, `C_ab` `{kind: scalar, name: C_ta_tb}`.
   - EM-03: `spec: sims/coplanar-rings.yaml`; `M_ab_filament_exact` and `M_ab` `{kind: scalar, name: L_ra_rb}`, `L_aa` `{kind: scalar, name: L_ra_ra}`, `L_bb` `{kind: scalar, name: L_rb_rb}`.
   - RF-01: `spec: sims/cylinder-cavity.yaml`; `f_TM010` `{kind: eigen, floor: 1.0e+6, index: 0}`, `f_TE111` index 1, `f_TE011` index 11, `Q_d` `{kind: scalar, name: Q_0}`. `Q_c_TE011` and `Q_TE011_copper` need a surface-impedance BC (not in the engine): pending.
9. **L2 / L10: temperature for property evaluation.** `materials/structural-steel` E and nu depend on T; an elastic spec has no place to state T, so `prepareRun` leaves E empty. `sims/kirsch-plate.yaml` now uses the SM-01 case inputs instead of the library ref.
10. **L7a / L8: RF-21 timeout from the budget.** The worker limit is 20 x `budget_s` (2 s) per level = 120 s for 3 levels; levels at ratio 1.5 from hmax a/4 (13k, ~45k, ~150k DOF) time out. `sims/cylinder-cavity.yaml` starts at a/3 (5.4k, 23.6k, 73.9k DOF, 54 s).

11. **L4: emw cylinder re-mesh ignores hFactor** (sent 17:16). `sims/cylinder-cavity.yaml`, hmax a/3: hFactor 1 and 0.6667 both give 14,882 DOF (note says re-meshed with scaled sizes); hFactor 0.5 gives 126,008 DOF (nested). RF-21's three levels are therefore one mesh ("no_change").
12. **L8 / L7a: fallback rule "non-increasing |error|" when the error is far below the budget.** HT-04 (time-error floor, |error| 1e-7..1e-6 degC against a 0.01..0.14 degC budget) and SM-02 (reference rounded to 3 significant figures) fail although every level is within the budget. Proposal: when all levels are within the budget and the spread of the last two levels is below a fraction (e.g. 0.1) of the budget, pass on the finest; or compare monotonicity of level-to-level changes instead of |error| against the reference.
13. **L8 / L4: transient cases refine h only.** HT-02's case note says "refine both h and dt"; the harness passes `hFactor` only and `prepareRun` keeps `study.dt`. Request: scale `dt` with `hFactor^(p_space / p_time)` (3/2 for P2 + BDF2) when the case asks for it (e.g. `convergence.dt_with_h: true`), or `convergence.dt_factors`.
14. **WO-41 (class b, L7b; coordinator question): not an engine bug.** L4's nested uniform levels (`logs/l4-modes-wo02-20261107T010407Z.jsonl`, N = 8..64, 3.6k..229k DOF) converge monotonically to the tabulated values with observed orders 1.75 / 1.82 / 1.53 (variants A, C, D; B is pre-asymptotic, its finest error 8.1e-8 already passes). That order is what a dielectric 90-degree corner singularity gives on uniform refinement; the shared rule rejects Richardson because 1.5-1.8 is outside the 0.25 band of the regular-part order 4, and the finest uniform level is 1.6e-7 / 2.5e-7 / 1.9e-6 off (budget abs 1e-7, itself "proposed (assumption)" in the case). Richardson with the observed order from the three finest levels gives -4.3e-9 / 4.2e-9 / 3.2e-8, i.e. all within 1e-7 (computed here from L4's log, not gated). Fix belongs to (a) L4: graded refinement at the core corner (as the WO-02 rib gate already does) to recover the asymptotic order, and/or (b) L7b: state `expected_order` from the corner exponent for this case. The references are consistent with the engine to about 1e-8.
15. **L8: per-target `expected_order`.** SM-01 mixes stress targets (order 2) and displacement targets (order 3); only a case-level `convergence.expected_order` exists.
16. **L7a: `convergence.h_factors` added in 11 hero cases by I1** (coordinator request 17:08); RF-21 left without `h_factors` (item 11 and s.3 17:15).

## 6. Hand-off

State 2026-11-06 17:23 PST.

Done:
- sims (all validate against `physicsRegistry()`): gate specs `nafems-t4`, `nafems-t3`, `nafems-t2`, `semi-infinite-convection`, `kirsch-exact`, `nafems-le1`, `helmholtz-em04`, `coax-line`, `si-slab-te0`, `si-slab-tm0`, `cylinder-cavity-axisym`, `cylinder-cavity-qd`, `two-spheres`, `coplanar-rings`; hero specs filled with sourced case values (`heat-plate-fin`, `box-acoustics` (also AC-02's spec, hmax Lz/3), `cylinder-cavity` (hmax back to a/4), `si-rib-waveguide` (t_slab, material ids core / substrate / cover), `kirsch-plate` (SM-01 E, nu), `helmholtz-coil` (mu_r 1)). Each spec ends with `# eval: [IDs]`.
- Cases a: `spec:` + `extract` for HT-01..04, SM-01, SM-02, EM-01, EM-04, WO-01 (TM0 target `spec`), RF-21 (per-target `spec` for Q_d), AC-02; SM-06 extracts; `h_factors: [1, 0.5, 0.25]` + `expected_order` in those 11 cases (coordinator request). Cases b: 92 `metric_id` slugs; WO-02 pending reason.
- Results s.4: hero gates pass for H1 (SM-01), H2 (HT-01, HT-02, HT-03), H3 (EM-04), H4 (WO-01), H5 (RF-21), H6 (AC-02) and EM-01; SM-02 and HT-04 fail only on the fallback monotone rule (s.5 item 12).

Open:
- s.5 items 3 (L2 schema tests on sims: the tests also take fixtures from sims substrings, e.g. `{id: steel, ref: materials/structural-steel, select: ["dom:plate"]}` and `{path: materials.solid.override.k,`, both gone), 5d (WO-02 sweep targets), 6 (L7a generator would drop these edits), 8 (L7c lines for EM-02, EM-03, RF-01), 12-13 (fallback rule, dt refinement), 14 (WO-41), 15 (per-target order).
- SM-01 `field_rel_L2_stress` gives a loader warning "field target with unit '1' is evaluated as the relative norm; write norm: rel_l2" (tolerance block, L7a's field).
- AC-02 does not meet < 5 s on the nested 3-level verdict (6.25 s warm).
- `packages/physics/src/result-names.ts` not created (s.5 item 1).

How to resume: `nice -n 10 node --max-old-space-size=1536 packages/eval/src/cli.ts --case <ID>`; `--class a`; `--dry-run` (0 errors, 0 warnings at 16:59). Do not run the 3D cavity at a third nested level from hmax a/1.5 or finer (4.3 GB RSS, DevLog-010 s.8.3).
