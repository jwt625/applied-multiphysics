# DevLog-049: advanced packaging examples and materials (lane E3, chunk 2)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | E3 (DevLog-037 s.4.1) |
| Status | done (s.4 gates; s.6 requests; s.7 hand-off) |
| Owns | new `sims/<id>.yaml` it creates; `apps/web/src/lib/library/catalog-pkg.ts`; `validation/c/cases_ext/pkg.py`; new `validation/pkg/**`; `materials/**`, `packages/materials/**`; new `eval/expected/PK-*.json`; case ids PK-01..PK-19; this file |
| Read | CLAUDE.md; DevLog-037 s.4.1; DevLog-044 s.4-6; DevLog-041; DevLog-046; `catalog.ts`, `catalog-mp.ts`; `eval/README.md`; `validation/c/build_cases.py`, `cases_ext/README.md`; `sims/chip-warpage-2d.yaml`, `bimetal-strip.yaml`, `cpw-halfspace.yaml`, `heated-wire.yaml`; `packages/physics/src/{prepare.ts, elastic/axisym.ts, electrostatics/index.ts, couplings/core.ts}`; `packages/materials/src/library.ts`; advanced-packaging-atlas (read only, GPL-3.0) `validation/cases/A/MA7-lame-tsv.yaml`, `MA3`, `MA9`, `validation/reference/apref/rf.py` |

Conventions: F = fact read from code, a source or a run; D = decision; E = estimate; O = open item; R = request.

## 1. Plan (written 2026-11-18 13:34 PST, before coding)

### 1.1 Facts that shape the plan

- F: `prepareRun` evaluates library tables only with `args.T`; neither the web runner (`runner.worker.ts` l.88) nor the eval harness passes `T`. So a `ref:` material resolves scalar leaves (Cu E, nu; Si C) but every T table / T fit (Si k, alpha; Cu k, alpha) fails with "depends on T" in a sim run from the library or the harness. -> R1 (prepare.ts / spec). Until then the sims use `ref:` plus overrides for the T-dependent leaves only, each override = the library value at 298.15 K (stated, with the library leaf as provenance).
- F: elastic `axisym` (tri6) carries the thermal strain in rr, zz, phiphi; heat runs on axisym meshes; the thermal-expansion coupling takes `alpha` per elastic cell and `settings.Tref`.
- F: electrostatics with one terminal on a 2D planar mesh reports `C_per_m`, `L_per_m` (from the vacuum solve) and `Z0`.
- F: `materials/silicon.yaml` E, nu are N/A by design (cubic C only); `chip-warpage-2d` uses a Hill average as an override (validation/mp/references.py `hill_isotropic`).

### 1.2 Items (priority order)

| # | Item | Model | Gate (reference) |
|---|---|---|---|
| 0 | Materials (R-T4-1) | Si isotropic E, nu = Voigt-Reuss-Hill average of Hall 1967 C (basis derived; Voigt and Reuss bounds as alternatives); underfill k, TiN k: search primary / vendor sources; else N/A and a labelled override in the sims | validator + `@amp/materials` tests green |
| 1 | `tsv-stress-axisym` (PK-01) | Cu via in a Si cylinder, meridional (r, z) section, uniform dT, u_z = 0 on both faces (plane strain: exact for the closed form), outer radius free | Lame two-phase plane-strain closed form for a finite outer radius (own derivation, displacement + traction continuity; same form as the atlas MA7 case): Cu sigma_rr, Si sigma_rr / sigma_tt at r = 2a, sigma_zz in Cu, u_r at r = R; 2+ nested levels |
| 1b | `tsv-stress-3d` (PK-02) | quarter of the same cylinder cell, extrude stack, rollers on x = 0, y = 0, z faces | same closed form; cross-check vs PK-01 |
| 2 | `microstrip-line` (PK-03) | zero-thickness strip on a substrate over a ground plane, truncation box | Hammerstad-Jensen 1980 Z0 (air) and eps_eff (Qucs technical documentation s.11.1 / scikit-rf `mline.py` as the open re-tabulation; primary not read); validity u = W/h <= 1000 (Z01 0.01 % for u <= 1, 0.03 % to 1000), eps_eff 0.2 % for eps_r < 128 and 0.01 <= u <= 100 |
| 2b | `cpw-si-interposer` (PK-04) | zero-thickness CPW on a finite Si interposer, no backside metal | conformal-mapping partial-capacitance form (Qucs s.12, eqs. 12.7-12.9; Gupta et al.); accuracy of the finite-h form not stated by the source -> informative or labelled tolerance |
| 3 | `interposer-thermal-3d` (PK-05) | 2.5D: several dies on bump + underfill layers on a Si interposer (extrude); power per die, cold plate on top or board below | 1D series resistance bound or mesh self-consistency, labelled |
| 4 | `die-warpage-3d` (PK-06) | die on substrate, uniform dT | Timoshenko bimetal curvature in the thin-plate limit (biaxial moduli), labelled limits |
| 4b | hybrid-bond pad, bump array | if time allows | |

Per sim: `sims/<id>.yaml` (`# eval:` header, results + plot groups), `catalog-pkg.ts` entry, class-c case in `validation/c/cases_ext/pkg.py`, reference script under `validation/pkg/`, expected JSON `eval/expected/PK-xx.json`, build + `test_build_matches`, harness CLI pass.

## 2. TODO

- [x] Plan (this section)
- [x] Materials: Si E / nu (Hill); underfill k, TiN k searched, kept N/A
- [x] PK-01 TSV axisym
- [x] PK-02 TSV 3D quarter
- [x] PK-03 microstrip
- [x] PK-04 CPW on Si interposer
- [x] PK-05 interposer thermal map
- [x] PK-06 die warpage 3D
- [x] catalog entries, cases, expected JSONs, build + test_build_matches, CLI
- [x] Results table, requests, hand-off
- [ ] Hybrid-bond pad, bump array (O1)

## 3. Progress log

- 2026-11-18 13:22-13:33 PST: read the inputs listed above; facts s.1.1.
- 2026-11-18 13:34 PST: plan written.
- 2026-11-18 13:35-13:40 PST: materials. `silicon.yaml` E, nu: Voigt-Reuss-Hill average of the Hall 1967 C as the default (derived; E 162.58 GPa, nu 0.2231), alternatives `voigt` (165.72, 0.2177), `reuss` (159.41, 0.2285), `dir100` (130.02, 0.2785). Underfill k: neither Henkel document has it (TDS 2017; product information sheet LT-8234 6/19, read 2026-11-18, adds the DMA modulus 352 MPa at 250 C, stored as alternative `dma_250c`); a distributor listing (0.6 W/(m K) per a web search) was not readable (HTTP 522 / redirect): k stays N/A. TiN film k: Baba et al. THERMINIC 2006 (arXiv:0709.1845) shows sputtered-TiN diffusivity only in figures: k stays N/A. New test `packages/materials/test/packaging-e3.test.ts` (2 tests); validator 34 / 34; tests 32 / 32 before the new file.
- 2026-11-18 13:41 PST: F: `packages/physics/src/wave2d/lu.ts` (lane E4, being edited) briefly had a TypeScript parameter property (`constructor(readonly pat: Csr)`), which Node strip-only mode rejects, so importing `@amp/physics` failed for a minute; it was gone at 13:43. Not my file; noted for the coordinator (erasable syntax rule).
- 2026-11-18 13:42-13:49 PST: PK-01 (`sims/tsv-stress-axisym.yaml`), PK-03 (`sims/microstrip-rdl.yaml`), PK-04 (`sims/cpw-si-interposer.yaml`), references `validation/pkg/{tsv_lame,microstrip_hj,cpw_conformal}.py`, cases in `validation/c/cases_ext/pkg.py`. Rollers must be coplanar per BC (one roller per face). CLI: PK-01 5/5, PK-03 3/3, PK-04 1/1 + 2 info (logs/E3-cli-PK-0{1,3,4}-20261118T134854.log; records logs/eval-20261118T13485{5,6}.jsonl, logs/eval-20261118T134859.jsonl).
- 2026-11-18 13:46-13:50 PST: PK-02 (`sims/tsv-stress-3d.yaml`): quarter-disc extrude (each 2D primitive can feed one boolean only: separate `tsv` / `hole`, `quad` / `quad2`). Level 2 = 116,214 DOF, 12-16 s, peak 1.41 GB: a third level is over the RSS rule, so 2 levels, finest compared. First gate on volume means failed (Cu sxx mean -3.1 % / -1.6 %): the displayed stress is averaged at nodes shared by Cu and Si, so domain integrals of stress converge at first order (R2). Gate moved to interior probes; means kept informative. CLI PK-02 4/4 + 4 info (logs/eval-20261118T135035.jsonl).
- Truncation (PK-03): box 2 mm -> 8 mm at hFactor 0.5: C' +4.4e-5, L' -4.3e-5 relative.
- 2026-11-18 13:51-13:58 PST: PK-05 (`sims/interposer-thermal-3d.yaml`, bounds `validation/pkg/interposer_bounds.py`). Level 2 = 333,186 DOF, 63-75 s, 0.7 GB. Combine target needs unit literals in the expression (`298.15[K]`). CLI 1/1 + 3 info (logs/eval-20261118T135719.jsonl).
- 2026-11-18 13:58-14:05 PST: PK-06 (`sims/die-warpage-3d.yaml`, `validation/pkg/bilayer_plate.py`). First mesh (hmax L/20, 4 + 3 layer cells, 47k DOF tet10) did not finish the elastic solve in 180 s at 1.2 GB RSS (stopped); hmax L/12 level 2 (113k DOF) took 20 s at 2.5 GB (over the 2 GB rule): R3. Chosen hmax L/8, 2 + 2 layer cells: 6.8k / 50k DOF, 4.8 s, 1.1 GB. Stacks have no point entities, so the rigid z motion is removed by a 0.1 mm patch at the bottom centre. CLI 1/1 + 2 info (logs/eval-20261118T140529.jsonl).
- 2026-11-18 14:06 PST: catalog entries (`catalog-pkg.ts`, 6 entries, category packaging); final CLI over PK-01..06 started (one log).

## 4. Results

### 4.1 Gate table (harness CLI, engine `@amp/physics`, levels = hFactor list; values at the finest level unless "ext" = Richardson extrapolation)

| Case / sim | Target | Engine | Reference | Rel. diff | Tol | Gate | Reference source |
|---|---|---|---|---|---|---|---|
| PK-01 tsv-stress-axisym (hF 1, 0.5; 2,397 / 9,595 DOF) | Cu sigma_rr | 170.1022 MPa | 170.1001 MPa | +1.2e-5 | 1e-3 | pass | two-phase plane-strain Lame, finite R (own derivation, `validation/pkg/tsv_lame.py`) |
| | Cu sigma_zz | 323.8476 MPa | 323.8484 MPa | -2.4e-6 | 1e-3 | pass | same |
| | Si sigma_rr (r = 2a) | 37.297 MPa | 37.209 MPa | +2.4e-3 | 3e-3 | pass | same (single nodally averaged point: 37.240 / 37.297 / 37.199 at hF 1 / 0.5 / 0.25) |
| | Si sigma_phi (r = 2a) | -51.358 MPa | -51.384 MPa | +5.2e-4 | 3e-3 | pass | same |
| | rim u_r | -10.02437 nm | -10.02437 nm | -3.8e-7 | 1e-3 | pass | same |
| PK-02 tsv-stress-3d (hF 1, 0.5; 14,842 / 116,214 DOF, 1.41 GB) | Cu sxx (interior point) | 170.1009 MPa | 170.1001 MPa | +4.9e-6 | 1e-3 | pass | same closed form; cross-checks PK-01 |
| | Cu szz | 323.8489 MPa | 323.8484 MPa | +1.8e-6 | 1e-3 | pass | |
| | Si szz (3a, a) | 39.1283 MPa | 39.1244 MPa | +1.0e-4 | 1e-3 | pass | |
| | rim u_r | | | +1.3e-8 | 1e-3 | pass | |
| | Cu sxx volume mean | 167.42 MPa | 170.10 MPa | -1.6e-2 | | info | displayed stress averaged at nodes shared by Cu and Si (R2) |
| | Si szz volume mean | 39.302 MPa | 39.124 MPa | +4.5e-3 | | info | same |
| PK-03 microstrip-rdl (hF 1, 0.5, 0.25; 169,079 DOF finest, 0.6 GB) | L' | ext 421.702 nH/m (fine 421.549) | 421.705 nH/m | ext -5.9e-6 (fine -3.7e-4), p_obs 1.05 | 5e-4 | pass | Hammerstad-Jensen 1980 via Qucs tech. doc. s.11.1 eqs. (11.4)-(11.6), scikit-rf mline.py |
| | C' | ext 58.567 pF/m | 58.505 pF/m | ext +1.06e-3 (fine +1.47e-3) | 3e-3 | pass | eqs. (11.15)-(11.18); closed-form eps_eff accuracy 0.2 % (source) |
| | Z0 | ext 84.855 Ohm | 84.900 Ohm | ext -5.3e-4 (fine -9.1e-4) | 2e-3 | pass | |
| PK-04 cpw-si-interposer (hF 1, 0.5, 0.25; 225,694 DOF finest, 0.8 GB) | L' | ext 401.893 nH/m | 401.892 nH/m | ext +1.9e-6 (fine -7.6e-4), p_obs 1.04 | 1e-3 | pass | exact conformal map (zero thickness, semi-infinite grounds), Qucs s.12 |
| | C' | ext 174.310 pF/m | 174.249 pF/m | +3.5e-4 | | info | partial-capacitance finite-h form, Qucs s.12 eqs. (12.8)-(12.9); accuracy not stated |
| | Z0 | ext 48.017 Ohm | 48.025 Ohm | -1.7e-4 | | info | same |
| PK-05 interposer-thermal-3d (hF 1, 0.5; 43,716 / 333,186 DOF, 0.7 GB) | power-weighted mean junction rise | 1.38988 K | bounds [1.19507, 1.39413] K | inside | range | pass | compliance monotonicity in k (own derivation, `validation/pkg/interposer_bounds.py`); both bounds exact for the model |
| | Tj logic (mean) | 299.7807 K: R_jc,mean 0.05436 K/W | die alone 1D: 0.05467 K/W | | | info | |
| | Tj memory (mean, each) | 298.8174 K: R_jc,mean 0.1335 K/W | die alone 1D: 0.1312 K/W | | | info | heat from the logic die reaches the memory dies through the interposer |
| PK-06 die-warpage-3d (hF 1, 0.5; 6,807 / 49,935 DOF, 1.1 GB) | centre d2w/dr2 | -2.06047 1/m | -2.06027 1/m | +9.5e-5 | 2e-3 | pass | laminated-plate theory = Timoshenko 1925 with E / (1 - nu) (own derivation and check, `validation/pkg/bilayer_plate.py`) |

Logs: final run of all six after the last sims edit: `logs/E3-cli-pk-all-20261118T140900.log` (records `logs/eval-20261118T140900.jsonl` .. `logs/eval-20261118T141030.jsonl`); values in this table are from the runs listed in s.3 (identical inputs; the last edit changed provenance notes only).

Inputs of the gates (all illustrative unless named): TSV a 5 um, R 25 um, dT -100 K; microstrip W = h = 10 um, eps_r 2.9 (PI-2600, 1 kHz); CPW S 20, G 10, h 100 um, eps_r 11.6626 (Si at 298.15 K); interposer 14 x 8 x 0.1 mm, logic 6 x 6 mm 30 W, two 3 x 5 mm 5 W dies, 300 um dies with 10 um active layers, bump layer 40 um with f = 0.1623 of SAC305; warpage 10 x 10 mm, Si 0.3 mm on BT 0.5 mm, dT -100 K.

### 4.2 Materials

| Material | Property | Value | Basis | Source / locator |
|---|---|---|---|---|
| silicon | E (default) | 162.58 GPa | derived | Voigt-Reuss-Hill of Hall 1967 Table III C (journal p.758); alternatives voigt 165.72, reuss 159.41, dir100 130.02 GPa |
| silicon | nu (default) | 0.2231 | derived | same; alternatives 0.2177, 0.2285, 0.2785 |
| underfill-uf8830s | E alternative dma_250c | 352 MPa at 250 C | datasheet | Henkel product information sheet LT-8234 (6/19) p.2 'Thermal Properties' |
| underfill-uf8830s | k | N/A (kept) | | not on either Henkel document; distributor listing not readable (s.3 13:35) |
| tin-film | k | N/A (kept) | | Baba et al. 2006 gives TiN diffusivity in figures only |

Sims use a labelled override only for T-table leaves (R1); the bump layer of PK-05 leaves the underfill term out instead of inventing a k.

## 5. Open items

- O1: hybrid-bond Cu pad expansion (axisymmetric pad recess / protrusion) and solder-bump array thermal resistance: not built. For a straight bump column between isothermal plates the parallel formula is exact (no gate value); a useful gate needs barrel-shaped bumps or pads (series / parallel Wiener bounds). For the pad, no exact closed form with a free top surface was identified; a two-sided bracket (free vs laterally rigid) is not rigorous with a compliant oxide.
- O2: PK-01 Si single-point stress is close to its tolerance at hF 0.5 (+2.4e-3 of 3e-3); the point values oscillate with h (nodally averaged recovery). A per-domain recovery (R2) would tighten it.
- O3: microstrip with finite metal thickness (Hammerstad-Jensen thickness correction) and RDL lines with a top dielectric: not built.
- O4: library temperature (R1) would let the overrides of k / alpha / eps_r go; the sims then run from the library at the study temperature.
- O5: chip-warpage-2d unchanged (paper values), as required.
- O6: waveguide-heater-3d with a TiN heater still needs TiN k (N/A).

## 6. Requests

- R1 (prepare.ts lane E2 + spec / CONTRACTS coordinator): library T-tables have no temperature in any caller: `apps/web/src/lib/engine/runner.worker.ts` l.88 and the eval harness call `prepareRun` without `T`, so `ref:` materials lose every T-dependent leaf (Si k, alpha, eps_r, cp; Cu k, alpha, cp) with the note "depends on T". Proposal: optional material-node field `T` (quantity, K) in `packages/spec/src/schema.ts` materials item (l.357-362: add `T: quantity('K').optional()` next to `override`), and in `packages/physics/src/prepare.ts` `resolveMaterials` evaluate `libOpts` per material with the node T when given, else `args.T` (function `resolveMaterials`, the `libOpts` closure and the `lib.getProperty(id, p, libOpts(p))` call). A study-level default (e.g. stationary `settings.T_material`) would serve multi-material sims; thermal-expansion `Tref` is not a substitute (it is the stress-free temperature). Then PK-01..06 can drop their overrides.
- R2 (elastic module lane E8 / post lane E9): derived stress fields (`sxx`..., `srr`, `sphi`, `mises`) are nodal averages over all cells at a node, across material interfaces, so stress next to a Cu / Si interface mixes both materials and domain integrals / averages of stress converge at first order (PK-02: Cu volume mean -3.1 % / -1.6 % at hF 1 / 0.5 while interior points are within 5e-6). Request: per-domain nodal recovery (average only over cells of the same material domain, discontinuous across domains), or quadrature-point evaluation for `average` / `integral` of derived fields.
- R3 (core / elastic lane E8): 3D tet10 elastic on a plate-like mesh: 47k DOF (10 x 10 mm quarter plate, hmax 0.5 mm, 7 layer cells) did not finish in 180 s at 1.2 GB; 113k DOF took 20 s at 2.5 GB RSS. The heat / electrostatics path has `settings.solver: amg-pcg | auto`; request the same study setting for elastic (`STUDY_SOLVER_TYPES` in `packages/physics/src/common/scalar.ts`), or an AMD-ordered sparse factor for elastic.
- R4 (geom lane E9, minor): a 2D primitive can feed only one boolean ("input 'tsv' was already consumed"); the quarter-cell TSV needs duplicate circles and rects (`tsv` / `hole`, `quad` / `quad2`). A copy feature or reuse would simplify such sketches. Stacks have no `pnt:` entities (DevLog-044 O6): pinning needed a small patch (PK-06).
- R5 (coordinator, note): at 13:41 `packages/physics/src/wave2d/lu.ts` (lane E4) briefly contained a TypeScript parameter property (`constructor(readonly pat: Csr)`), which Node strip-only mode rejects (erasable-syntax rule); it was gone at 13:43.

## 7. Progress (continued) and hand-off

- 2026-11-18 14:07 PST: provenance notes in the six sims rewritten without internal references (plain words); comments keep the DevLog pointers.
- 2026-11-18 14:08 PST: apps/web `pnpm check` 0 errors (1526 files), `pnpm test` 118 / 118 (logs/E3-web-check-*, logs/E3-web-test-* at 20261118T1407xx).
- 2026-11-18 14:08 PST: `@amp/materials` test failed 1 / 34 on another lane's new sims (tfln-rib-air uses a uniaxial n override, which only the materials package registers). Fixed in `packages/materials/test/library.test.ts`: detection `usesMaterialForms` (tensor `symmetry:` or dndT / r_eo / p_pe / kappa / Tg / tcr overrides) plus, per the coordinator relay of lane E2 (DevLog-048 R1), `MAT_SIMS` now lists 'tfln-rib-air' and 'tfln-rib-oxide' explicitly. Tests 34 / 34 (logs/E3-materials-test-20261118T141042.log); validator 34 / 34; tsc clean.
- 2026-11-18 14:09-14:10 PST: final CLI PK-01..06: 6 / 6 cases pass, 15 gated targets pass, 11 info (logs/E3-cli-pk-all-20261118T140900.log). `test_build_matches` 56 / 56 identical (class c incl. other lanes' cases).

TODO state: materials [x]; PK-01..06 [x]; catalog, cases, expected JSONs, build, CLI [x]; results, requests [x]; hybrid-bond pad, bump array [ ] (O1).

Hand-off: files owned and changed: `materials/{silicon,underfill-uf8830s,tin-film}.yaml`; `packages/materials/test/{packaging-e3.test.ts (new), library.test.ts}`; `sims/{tsv-stress-axisym,tsv-stress-3d,microstrip-rdl,cpw-si-interposer,interposer-thermal-3d,die-warpage-3d}.yaml` (new); `apps/web/src/lib/library/catalog-pkg.ts`; `validation/c/cases_ext/pkg.py` (new); `validation/pkg/{common_pkg,tsv_lame,microstrip_hj,cpw_conformal,interposer_bounds,bilayer_plate}.py` (new); `eval/expected/PK-0{1..6}.json`, `eval/cases/c/PK-0{1..6}.yaml` (built). Rebuild a PK case after editing pkg.py: delete its `eval/cases/c/PK-xx.yaml`, then `cd validation && uv run python c/build_cases.py` (the builder skips existing files without --force).
