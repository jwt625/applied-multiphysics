# DevLog-008: Eval class c (open-solver suites and physics datasets)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L7c |
| Owns | `eval/cases/c/**`, `eval/expected/` (class-c files only), `validation/c/**`, this file |
| Inputs | DevLog-001 (A12, Q5), CONTRACTS-v0 C8, R3 (sections 1-6, 8) |
| Status | Audit corrections applied (36 cases, 15 expected files, 0 loader errors / 0 warnings) |

## Plan (written 2026-11-06 15:15 PST, before any fetch or code)

1. Write the 17 class-c cases already listed in R3 section 3 (EM-02, EM-03, EM-05, RF-01, RF-03, WO-04, WO-05, FL-05, FL-06, FL-07, TR-02, TR-03, SC-02, CP-03, CP-04, CP-05, CP-06; R3 says 16, its table rows give 17) as `amp-eval/0` YAML, re-checking each value at its primary locator.
2. Add about 14 new class-c cases from open-licence suites, licence checked in the primary repo, locator = repo + path + line + commit/tag:
   - Palace coaxial example (Apache-2.0).
   - Code_Aster `astest` (GPL-3.0-or-later test files only): SSLV04A, TTLV01A, one modal test.
   - deal.II step-7 convergence table; dolfinx-tutorial exact-solution case.
   - MPB triangular-rods and diamond gaps; one more Meep test golden.
   - DEVSIM: diode_1d golden (SC-02) plus one more golden.
   - FEATFLOW page not already claimed by class b (Turek-Hron CFD1).
   - NASA TMR NACA 0012 (CC0).
   - FeenoX / Elmer / MFEM test values where the licence allows citing.
   - eo-modulator-atlas tier-B fixtures (K1 Si strip mode, K6a CPW), cited by path (read-only).
3. Dataset metadata cases: The Well gray_scott (TR-03), helmholtz_staircase, acoustic_scattering, rayleigh_benard, shear_flow; PDEBench 1D advection (TR-02), 1D Burgers, 2D Darcy (FL-06), 2D FitzHugh-Nagumo; PDEArena Maxwell-3D. Licence, ids, equations, parameters, resolution and file sizes from HF API / DaRUS API; R3 section 4 protocol. At most one small read per dataset into `cache/eval-c/` (< 50 MB each, < 200 MB total; HDF5 header + frame 0 via HTTP range reads where whole files exceed 50 MB), with a sidecar JSON (url, date, sha256).
4. Generators in `validation/c/` (uv only, `uv run --with ...` until L7a's pyproject lands): Palace analytic tables (Lekner spheres, rings, cylinder cavity, coax), DEVSIM diode_1d re-run vs golden, scikit-fem example scalar, closed forms quoted by Ansys VMs that are textbook formulas. Output `eval/expected/<ID>.json` with generator path, versions, ISO timestamp.
5. Local schema validator `validation/c/validate_cases.py` against R3 section 2; gate = all class-c cases validate.
6. ID rule for new class-c cases: `<prefix>-51` and up, so lanes L7a/L7b (which may extend R3 numbering from 10 upward) cannot collide. Recorded as a contract request.

Constraints: no COMSOL anything (Q5); no git; web fetches 3-6 s apart with jitter; `nice -n 10`; one heavy process at a time.

Plan changes after the coordinator note (15:45): schema = `eval/schema/amp-eval-0.schema.json`; expected format
`amp-eval-expected/0`; new class-c IDs 61-79 (not 51+); CP-05 dropped (class a, L7a); RF-01 cites L7a's RF-21
resolution. L7a had already filed Code_Aster SSLV04A as SM-21 (class a), so this lane took SDLL01A instead; L7b holds
the FEATFLOW DFG/FSI/CSM cases, so this lane took only Turek-Hron CFD1. TTLV01A dropped: its geometry lives only in
the MED mesh / FDL V-doc.

## TODO

- [x] Plan (this section)
- [x] Verify R3 class-c values at primary locators (Palace, Meep/MPB, DEVSIM, NASA TMR, Ansys VM pages)
- [x] New suite cases: licence + locator + values (20 new, IDs 61-66)
- [x] Dataset metadata (HF / DaRUS / PDEArena) + small range reads + sidecars (10 of 12 probes succeeded)
- [x] Generators + expected JSON (11 files)
- [x] Validator: L8 CLI dry-run 0 loader errors; local validator 0 errors
- [x] Summary table, contract requests, hand-off
- [x] Fresh-context audit (coordinator, `DevLog/audits/2026-11-06-L7c-eval-c-audit.md`); corrections below
- [x] PWE generator for WO-04/WO-61; exact ring resonances for WO-05; anisotropic CPW for RF-03; tight DEVSIM for SC-02
- [ ] Still open: TR-61 scikit-fem re-run; independent checks for WO-62/63/64 (TE / supercell / FDTD); dataset adapter (L8)

## Progress log

- 2026-11-06 15:15 PST: Read CLAUDE.md, DevLog-001, CONTRACTS-v0, R3 in full. `eval/cases/c` empty. EO atlas tier-B fixtures located (`validation/reference/K1-fem.json`, `K6a.json`, DevLog-028 round-2 tables).
- 15:15-15:35: Primary sources fetched with a rate-limited helper (3-6 s + jitter; GitHub via `gh api`, raw files pinned to tags/commits): Palace v0.19.0 docs + 3 regression gold CSVs; MPB v1.12.0 tutorial + licence; Meep v1.35.1 Basics.md, test_ring.py, test_holey_wvg_cavity.py; DEVSIM main e3a25f0 examples + golden repo devsim_tests_macos_arm64 85e6e1f; Code_Aster 17.5.8 sslv04a/ttlv01a/sdll01a; deal.II v9.8.0 step-7; scikit-fem 12.0.2 tests; NASA TMR pages + .dat; FEATFLOW CFD tests page (TU Dortmund host); Ansys VM58/166/175/223. Copies in `cache/eval-c/sources/` (gitignored).
- 15:25-15:45: Dataset metadata via HF API (7 The Well repos, PDEArena) and DaRUS API (PDEBench, 336 files, 3.903 TB). `validation/c/probe_dataset.py` reads HDF5 headers + frame 0 by HTTP range requests (no full downloads). 10 probes OK; PDEBench 2D diff-react (3 tries) and NS_incom and PDEArena Maxwell-3D hit their byte caps (see Results). Total transferred 194.5 MB (incl. one repeated gray_scott probe of 6.3 MB), under the 200 MB budget; probing stopped there.
- 15:45: Coordinator note received (schema, expected format, IDs 61-79, CP-05, RF-21); plan adjusted (above).
- 15:45-15:55: Generators `gen_palace.py`, `gen_suites.py`, `gen_devsim.py`; `build_cases.py` writes 36 YAML; `validate_cases.py`.
- 15:56: `node packages/eval/src/cli.ts --class c --dry-run`: 36 cases, 85 targets, 0 loader errors, exit 0 (records `logs/eval-20261106T155648.jsonl`). Local validator (jsonschema 2020-12 + value cross-check): 0 errors.
- 15:57: All generators re-run after `ruff format`; values unchanged. Logs: `logs/eval-c-*.log`.

## Results

### Cases (36: 16 from R3, 20 new). Gate target shown; regenerable = value comes from a generator in `validation/c/`

| ID | Source | Licence | Physics | Target | Value | Locator | Regen. |
|---|---|---|---|---|---|---|---|
| AC-61 | The Well | CC-BY-4.0 | acoustics | VRMSE vs stored trajectory at frames 1, 10, last | N/A (dataset metric) (1) | HF helmholtz_staircase README 'About the data'; paper App. E.3 (VRMSE) | no |
| AC-62 | The Well | CC-BY-4.0 | acoustics | VRMSE vs stored trajectory at frames 1, 10, last | N/A (dataset metric) (1) | HF acoustic_scattering_maze README 'About the data'; paper App. E.3 (VRMSE) | no |
| CP-03 | Ansys VM58 (pointer) | Ansys VM page, all rights reserved (values cited) | heat-cond, heat-conv | T_center | 488.6719453 K | ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM58.html, Re | yes |
| CP-04 | Ansys VM223 (pointer) | Ansys VM page, all rights reserved (values cited) | coupled-joule, coupled-thermoelastic | tip UY | 2.7e-05 m | ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM223.html, R | no |
| CP-06 | Ansys VM175 (pointer) | Ansys VM page, all rights reserved (values cited) | coupled-piezo, solid-modal | f1 short | 66560 Hz | ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM175.html, R | no |
| EM-02 | Palace examples | Apache-2.0 | electrostatics | C_aa | 1.230517502e-12 F | palace docs/src/examples/spheres.md L27-40 (series), L74-80 (values) | yes |
| EM-03 | Palace examples | Apache-2.0 | magnetostatics | M_ab | 1.97392088e-12 H | palace docs/src/examples/rings.md L28-30, L73-75 | yes |
| EM-05 | Ansys VM166 (pointer) | Ansys VM page, all rights reserved (values cited) | eddy, currents | By(0,0) real | -0.001843915599 T | ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM166.html, R | yes |
| EM-61 | Palace examples | Apache-2.0 | magnetostatics | L_geom | 9.631782433e-12 H | palace docs/src/examples/coaxial.md L166-170, L180 | yes |
| FL-05 | NASA TMR | CC0-1.0 | turbulent | Cf(x = 0.970084071) | 0.00270562153 (1) | tmbwg.github.io/turbmodels/FlatPlate/SA/cf_convergence.dat zone CFL3D row 1 | no |
| FL-06 | PDEBench | CC BY 4.0 | porous | nRMSE vs stored solution | N/A (dataset metric) (1) | paper App. D.4 eq. 13-15 | no |
| FL-07 | AirfRANS | ODbL-1.0 | turbulent | C_D, C_L relative error vs AirfRANS simulation | N/A (dataset metric) (1) | airfrans.readthedocs.io notes/dataset.html | no |
| FL-61 | FEATFLOW benchmarks | open web page, no terms stated | laminar-ns | drag force | 14.2929 N/m | wwwold.mathematik.tu-dortmund.de/~featflow/en/benchmarks/cfdbenchmarking/fsi_ben | no |
| FL-62 | NASA TMR | CC0-1.0 | turbulent | C_L (alpha 10) | 1.0909 (1) | tmbwg.github.io/turbmodels/naca0012_val_sa.html table L170-183 | no |
| FL-63 | The Well | CC-BY-4.0 | coupled-heat-ns, laminar-ns | VRMSE vs stored trajectory at frames 1, 10, last | N/A (dataset metric) (1) | HF rayleigh_benard README 'About the data'; paper App. E.3 (VRMSE) | no |
| FL-64 | The Well | CC-BY-4.0 | laminar-ns, transport-diffusion | VRMSE vs stored trajectory at frames 1, 10, last | N/A (dataset metric) (1) | HF shear_flow README 'About the data'; paper App. E.3 (VRMSE) | no |
| HT-61 | scikit-fem examples | BSD-3-Clause | heat-cond | u_max | 0.07367135328 (1) | github.com/kinnala/scikit-fem tag 12.0.2 tests/test_examples.py L8-12 (FEM gold  | yes |
| RF-01 | Palace examples | Apache-2.0 | rf-resonator | f TM010 | 2903636072 Hz | palace docs/src/examples/cylinder.md L31-44, L115 | yes |
| RF-03 | Palace examples | Apache-2.0 | rf-waveguide | Z0 (uniaxial sapphire) | 53.3518982 ohm | palace docs/src/examples/cpw.md L18-25 (inputs); 56.02 informative | yes |
| RF-61 | Palace examples | Apache-2.0 | rf-sparams | abs(S11) | 0.3331824528 (1) | palace docs/src/examples/coaxial.md L19-23, L99-116 | yes |
| RF-62 | eo-modulator-atlas tier B | own work | electrostatics, rf-waveguide | C' | 2.137269193e-10 F/m | eo-modulator-atlas DevLog/DevLog-028-open-source-references.md L345; validation/ | yes |
| SC-02 | DEVSIM examples | Apache-2.0 | semiconductor-dd | J 0.1 V (float128, mesh-extrapolated) | 1.205839786e-07 A/cm^2 | validation/c/devsim_diode_tight.py via gen_devsim.py; golden informative | yes |
| SM-61 | Code_Aster astest | GPL-3.0-or-later | solid-modal | f1 | 431.8818422 Hz | gitlab.com/codeaster/src tag 17.5.8 (c1f5c46ef795e0bf6d82a29dc20da30d281535ce) a | yes |
| TR-02 | PDEBench | CC BY 4.0 | transport-diffusion | nRMSE vs stored solution | N/A (dataset metric) (1) | paper App. D.1 eq. 6-8; Table 1 (Ns 1024, Nt 200) | no |
| TR-03 | The Well | CC-BY-4.0 | transport-reaction | VRMSE vs stored trajectory at frames 1, 10, last | N/A (dataset metric) (1) | HF gray_scott_reaction_diffusion README 'About the data'; paper App. E.3 (VRMSE) | no |
| TR-61 | deal.II tutorial | LGPL-2.1-or-later | transport-reaction | L2 error rate, Q1 global refinement | 2 (1) | dealii examples/step-7/doc/results.dox L66-97 | no |
| TR-62 | PDEBench | CC BY 4.0 | transport-diffusion | nRMSE vs stored solution | N/A (dataset metric) (1) | paper App. D.3 eq. 11-12 | no |
| TR-63 | PDEBench | CC BY 4.0 | transport-reaction | nRMSE vs stored solution | N/A (dataset metric) (1) | paper App. D.9 eq. 24-26; Table 1 (128 x 128, Nt 100, 1000 samples) | no |
| WO-04 | MPB tutorial | GPL-2.0-or-later | optics-phc | gap lower edge (converged, PWE) | 0.2806626 c/a | validation/c/gen_pwe.py; MPB L120 informative | yes |
| WO-05 | Meep tutorial + test | GPL-2.0-or-later | optics-modes, rf-resonator | f1 exact (m = 3) | 0.1181916937 c/a | validation/c/gen_suites.py wo05; Meep L1117 informative | yes |
| WO-61 | MPB tutorial | GPL-2.0-or-later | optics-phc | gap lower edge (converged, PWE) | 0.2744193 c/a | validation/c/gen_pwe.py; MPB L184 informative | yes |
| WO-62 | MPB tutorial | GPL-2.0-or-later | optics-phc | complete gap lower edge (band 2) | 0.2239776123 c/a | mpb doc/docs/Python_Tutorial.md L269 | no |
| WO-63 | MPB tutorial | GPL-2.0-or-later | optics-phc | defect frequency (band 25) | 0.378166 c/a | mpb doc/docs/Python_Tutorial.md L320, L349 | no |
| WO-64 | Meep tests | GPL-2.0-or-later | optics-phc, rf-resonator | f | 0.2344541535 c/a | meep python/tests/test_holey_wvg_cavity.py L66-73 | no |
| WO-65 | eo-modulator-atlas tier B | own work | optics-modes | n_eff TE0 | 2.44722338 (1) | eo-modulator-atlas DevLog/DevLog-028-open-source-references.md L307; validation/ | no |
| WO-66 | PDEArena | MIT | optics-scattering | nRMSE of E, H vs stored frames | N/A (dataset metric) (1) | github.com/pdearena/pdearena main 78a8b03d50115d8bb24ce9f04efa5b920fcd4369 pdeda | no |

Untestable (status `untestable`, with activation): CP-04 (VM223 omits h, emissivity, T_amb, d10), CP-06 (PZT-4 matrices are images; target is measured). Dataset cases carry `gate: false` metrics with a [0, 1] sanity bound until our own convergence floor exists (R3 s.4 protocol in each case's notes).

### Generator results (agreement with the value the source prints)

| Case | Quantity | Generated | Source prints | Rel. diff | Note |
|---|---|---|---|---|---|
| EM-02 | C_aa / C_bb / C_ab | 1.2305175 / 2.4315431 / -0.49456676 pF | 1.230518 / 2.431543 / -0.4945668 | <= 4.0e-7 | Lekner series |
| EM-03 | M_ab, L_aa, L_bb | 1.973921 / 41.78537 / 707.2050 pH | same | <= 8.3e-8 | docs formula typo for M_ab (r_a, r_b swapped); value consistent |
| RF-01 | f TM010 | 2.903636072 GHz | 2.903605 | 1.07e-5 | rounded Bessel zero in Palace table (= L7a RF-21) |
| RF-01 | Q_c TE011 / Q copper | 2.9395e4 / 2304.0 | 2.94e4 / 2.30e3 | 1.7e-4 / 1.8e-3 | at printed precision: agree |
| EM-61 | L_geom / L_total / L_kin | 9.63178 / 30.36697 / 20.73519 pH | 9.6318 / 30.3670 / 20.7352 | <= 1.8e-6 | 7-point lambda sweep also agrees |
| RF-61 | abs(S11), 100 Ohm port | 0.33318 | "1/3" (approx.) | 4.5e-4 | line is 50.05 Ohm with tan d 4e-2 |
| RF-62 | C' / n_RF / Z0 | 213.72692 pF/m / 2.519921 / 39.32846 Ohm | 213.7269 / 2.519921 / 39.3285 | <= 1.0e-6 | conformal map |
| EM-05 | By(0,0) | -0.0018439 - j0.0210448 T | -0.0018 - j0.0210 | at printed digits | exact Bessel solution |
| EM-05 | loss | 9151.79 W/m full section; /4 = 2287.95 | 2288 | 2.3e-5 (quarter) | target is a quarter-section value (inferred) |
| CP-03 | T_c / T_s / q | 419.94 F / 417.85 F / 341.50 Btu/hr | 419.9 / 417.9 / 341.5 | <= 1.2e-4 | Ansys FE gives 417.8 F |
| SM-61 | 6 modes in 430-4500 Hz | 431.882, 1265.924, 1500.367, 2870.798, 3797.773, 4361.251 Hz | 431.555, 1265.924, 1498.295, 2870.661, 3797.773, 4377.837 | 2e-7 (axial) to 3.8e-3 (bending n 4) | flag below |
| HT-61 | u_max | 0.0736713533 | FEM gold 0.073657185 | 1.9e-4 | gold is P1 FEM, not exact |
| SC-02 | J at 0.1-0.5 V | 1.15923e-7 .. 1.81552e-2 A/cm^2 | golden | < 1e-15 | unmodified example re-run (superseded as gate by the float128 reference, see Audit corrections B2) |

### Dataset facts resolved from the stored files (HTTP range reads of HDF5 headers)

| Dataset | Stored arrays (probed file) | Conflict resolved |
|---|---|---|
| The Well gray_scott | A, B [20, 1001, 128, 128] f32; t 0..10000 step 10; x linspace(-1, 1, 128) | x array includes both ends of a periodic domain (flag) |
| The Well helmholtz_staircase | pressure_re/im [3, 50, 1024, 256], mask [1024, 256]; x -8..8, y -0.5..3.5 | - |
| The Well acoustic_scattering_maze | pressure [100, 202, 256, 256], velocity [..., 2]; t 0..4 | R3 "201 vs 100": 202 stored frames (README 201, yaml 202); x, y stored 0..1 vs README [-1, 1] |
| The Well acoustic inclusions / discontinuous | [100, 102, 256, 256]; t 0..2 | 102 frames (README 101) |
| The Well rayleigh_benard | [5, 200, 512, 128] (+ velocity); t 0..49.75 step 0.25; x 0..4, z 0..1 | - |
| The Well shear_flow | [4, 200, 256, 512] (+ velocity); t 0..19.9; x 0..1, y 0..1 | R3 size/grid conflict: stored 256 x 512, HF total 471.19 GB / 84 files (README: 128 x 256, 114.7 GB; yaml 256 x 512) |
| PDEBench 1D advection, Burgers | tensor [10000, 201, 1024] f32; x cell centres; t-coordinate 202 entries | 201 frames + 202 time labels (flag); Table 1 says Nt 200 |
| PDEBench 2D Darcy | nu [10000, 128, 128], tensor [10000, 1, 128, 128] f32 | - |
| PDEBench 2D diff-react | probe failed (one HDF5 group per sample; byte caps hit) | size 13,243,560,688 B = 1000 x 101 x 128^2 x 2 x 4 B + 5.3 MB (D) |
| PDEBench NS_incom 512-0 | probe failed (cap) | R3 "512 vs 256" NOT resolved; DaRUS also lists byte-identical files (same md5) e.g. 512-131/512-132, 512-134/512-136, 512-135/512-137 (new flag) |
| PDEArena Maxwell-3D | probe failed (cap); from generator code: d_field, h_field (samples, 8, 32, 32, 32, 3) float64, 32^3 crop of a periodic 64^3 run | file size 314,575,504 B consistent with 25 samples x float64 (D) |

Sidecars: `cache/eval-c/<name>/sidecar.json` (url, ISO date, file size, upstream sha256 or md5, bytes transferred, request count, sha256 of `structure.json` and `frame0.npz`).

### Flags (new or changed vs R3 s.8)

1. Palace rings.md L29 prints M_ab = mu0 pi r_b^2 / (2 r_a); the value 1.973921 pH is mu0 pi r_a^2 / (2 r_b).
2. Palace coax London case: the docs round a, b to 0.819 / 2.731 um; exact values come from the 0.0645 / 0.215 in diameters (3e-4 difference in L_geom).
3. Meep ring: the unit-test gold (test_ring.py L67, 0.118101315147, tol 1e-3) differs from the tutorial printout (0.118101575043663) by 2.2e-6.
4. Code_Aster SDLL01A: VALE_REFE bending frequencies differ from the continuum Timoshenko closed form by up to 3.8e-3 (mode 6), beyond the test's own PRECISION 2e-3; code_aster's FE values sit near the closed form. SM-61 gates on the closed form.
5. Ansys VM166 loss target 2288 W/m equals a quarter of the full-section loss (2.3e-5); VM166 writes "omega = 60 Hz" (read as f).
6. Ansys VM175 kHz label vs magnitudes (R3 flag) stands; VM223 lacks h, emissivity, T_amb, d10.
7. The Well gray_scott README B equation shows "- A B^2" (standard model: + A B^2); stored x labels include both periodic ends.
8. The Well acoustic and shear_flow stored coordinates run 0..1 where READMEs say [-1, 1]; shear_flow yaml names its scalars "Rayleigh, Schmidt" (file attrs Reynolds, Schmidt).
9. PDEBench Burgers repo config (xL -1, xR 1, dt_save 0.05) does not match the stored file (x in (0, 1), 201 frames, dt 0.01).
10. PDEBench DaRUS NS_incom: several file pairs share one md5 (duplicates).
11. EO K6a/K1 fixtures are the atlas's own work; the EO `validation/` folder has no licence file (engine is GPL-3.0-or-later).
12. TMR SST flat-plate values (R3) were not re-checked; FL-05 keeps them as informative only.

## Contract requests

1. (done by L7a: devsim, requests, h5py, jsonschema are in `validation/pyproject.toml`) `validation/pyproject.toml` (L7a): add `devsim==2.11.2` (Apache-2.0, PyPI macOS arm64 wheel) and `requests`
   for `c/gen_devsim.py`; `h5py` for `c/probe_dataset.py`; `jsonschema` for `c/validate_cases.py`. Until then the
   commands use `uv run --with ...` (stated in each script header).
2. L8 schema: allow `dataset` extra keys used here (`hf_revision`, `n_hdf5_files`, `total_hdf5_bytes`, `file_bytes`,
   `darus_file_id`, `probe_sidecar`, `stored_grid`) - already allowed (`additionalProperties: true`); please keep it so.
3. L8 runner: dataset targets have `value: null`, `gate: false`, `form: dataset`; they need a dataset adapter
   (load frame 0 from the cache by hash, run, compute VRMSE/nRMSE) before they can be gated.
4. Coordinator: rights tags used beyond the common list: `copy_with_attribution`, `reference_by_hash`,
   `redistribute_data_without_attribution`, `copy_text_without_attribution`.
5. Coordinator / L7b: FL-61 (Turek-Hron CFD1) sits next to L7b's FEATFLOW cases; move it to class b if preferred
   (same page family, values are FEATFLOW's finest level).

## Hand-off

- Files: `eval/cases/c/*.yaml` (36), `eval/expected/{EM-02,EM-03,EM-05,EM-61,RF-01,RF-03,RF-61,RF-62,CP-03,SM-61,HT-61,SC-02,WO-04,WO-05,WO-61}.json`,
  `validation/c/{common_c,gen_palace,gen_suites,gen_pwe,gen_devsim,devsim_diode_tight,build_cases,validate_cases,probe_dataset}.py`.
- Rebuild (deps are in `validation/pyproject.toml` now): `cd validation && uv run python c/gen_palace.py && uv run python c/gen_suites.py && uv run python c/gen_pwe.py && uv run python c/gen_devsim.py && uv run python c/build_cases.py --force && uv run python c/validate_cases.py`; then `node packages/eval/src/cli.ts --class c --dry-run`.
- `build_cases.py --force` rewrites every class-c YAML from code (case definitions, then `apply_audit()`); hand edits to the YAML must go into the builder.
- No COMSOL files, runs or values. No git. No files written outside owned paths except `cache/eval-c/` (gitignored) and `logs/eval-c-*.log`.
- Ruff: imports fixed and `ruff format` applied; 44 E501 (long string literals) remain in `validation/c/`.
- Next: dataset adapter + own convergence floors (TR-02 exact shift first, then FL-06 Darcy on stored a(x)); TR-61 scikit-fem re-run; independent PWE for the MPB cases; retry the three failed header probes with a smarter walker only under a new byte budget.

## Audit corrections (2026-11-06 16:20-16:33 PST; audit `DevLog/audits/2026-11-06-L7c-eval-c-audit.md`)

All corrections live in `validation/c/build_cases.py::apply_audit()` (keyed by case id) and the generators. Final checks 16:32: generators re-run, `validate_cases.py` 36 cases / 104 references / 0 errors, L8 dry-run 0 loader errors / 0 warnings, exit 0 (`logs/eval-20261106T163235.jsonl`, `logs/eval-c-rebuild-*.log`).

| Item | Disposition | What changed (numbers) |
|---|---|---|
| B1 RF-03 | Fixed (gate on the anisotropic reference) | `gen_palace.py::rf03`: the uniaxial sapphire (eps 9.3 in plane, 11.5 normal) maps exactly to isotropic eps_eq = sqrt(9.3 x 11.5) = 10.342 with h' = 449.6 um, then the partial-capacitance conformal map. Gate Z0 = 53.352 Ohm (rel 5e-3; finite-h correction 3.8e-4). The docs' 56.02 Ohm is informative: it equals isotropic eps 9.3 with the handbook prefactor 30 pi (56.019; 55.980 with eta0/4). With 30 pi the anisotropic value is 53.389, matching the audit's 53.39. Form `closed_form` |
| B2 SC-02 | Fixed (tight reference) | `devsim_diode_tight.py`: DEVSIM 2.11.2 float128 (extended_solver/model/equation), Newton rel 1e-11 / abs 1e4 cm^-3 at the observed round-off floor, mesh spacing / 1, 2, 4, Richardson p 2. Tightening Newton in double precision did NOT fix continuity: the error is round-off in the low-bias current, not loose iteration. Gate J = 1.20584e-7, 1.14093e-6, 1.59266e-5, 4.48738e-4, 1.81547e-2 A/cm^2 at 0.1-0.5 V (rel 1e-3), with continuity < 3e-16 and Richardson-minus-finest <= 4.6e-6. Golden is 4.0e-2 / 4.0e-3 / 3.0e-4 / 3.4e-5 / 2.2e-5 off and stays informative |
| S8 SC-02 inputs | Fixed | materials/geometry/bcs now state every parameter: eps_r 11.1, eps0 8.85e-14 F/cm, n_i 1e10, T 300 K, q 1.6e-19, k_B 1.3806503e-23, mu 400/200, SRH tau 1e-8 s, n1 = p1 = n_i, doping, mesh, ohmic contacts (simple_physics.py L34-44, L122-141; diode_1d.py L24-25) |
| S1 RF-01 | Fixed (informative duplicates) | f TM010/TE111/TE011 and Q_d are `gate: false` with a pointer to RF-21. RF-01 now gates only Q_c TE011 and Q with copper walls |
| S2 FL-62 | Fixed | ranges are the envelope of all 7 codes: C_L(10) [1.0891, 1.1000], C_D(10) [0.01225, 0.01245]. The numerical-analysis page has plots only, so no converged numeric gate |
| S3 AC-62 | Fixed | BCs per edge from the stored HDF5 attrs (x0 WALL, xL OPEN, y0 WALL, yL OPEN, same in all 3 variants) and the generator (`acoustics_2d_interface_maze.py` L105-112: lower wall, upper extrap). The README conflict is recorded. Physical domain [-1, 1]^2 per generator L114-115 (stored coords 0..1). K 4, c = sqrt(K/rho) (L129-134). 1 extra fetch (6.7 kB) |
| S4 TR-03, FL-63, FL-64 | Fixed | "last frame" removed. VRMSE only up to the own predictability horizon H (first frame where our two finest levels differ by VRMSE > 0.1). After H, statistics are compared instead (TR-03: mean and variance vs t plus the A spectrum at t 10000; FL-63: mean b(z) and Nu over t 25-49.75; FL-64: tracer variance, KE, mean u_x(y)). All `gate: false` until the floor exists |
| S5 AC-61, WO-66, TR-63 | Fixed (untestable with activation) | Case-specific protocol lines: AC-61 frequency-domain BVP vs stored phases; WO-66 regenerate from seed with a pinned `fdtd` (grid.E stored as d_field, maxwell.py L142); TR-63 needs a header probe and the BC |
| S6 FL-07 | Fixed (untestable) | No sha256 available without the 10 GB download. HEAD recorded 10,029,067,577 B, Last-Modified 2022-08-11, ETag 62f519b5-255c76d39. `reference_by_hash` no longer claimed |
| S7 rights | Fixed | One rule per licence family with tags from the schema `rightsItem` enum (the enum says `cite_values`, not `cite_value`; schema followed): open code/docs (Apache, BSD, MIT, GPL-2.0+, GPL-3.0+, LGPL, CC0, own work) = [cite_values, re_derive_setup, copy_with_attribution]; proprietary or no terms (Ansys, FEATFLOW) = [cite_values, re_derive_setup], forbidding copy_with_attribution, copy_text, copy_figures, copy_input_files; open data = + reference_by_hash; ODbL without hash forbids copy_data, redistribute_data. SM-61 forbids copy_v_doc_text, as SM-21 does. `validate_cases.py` checks the enum and that reference_by_hash has a hash |
| S9 MPB/Meep | Fixed for WO-04, WO-61, WO-05; deferred for WO-62/63/64 | `gen_pwe.py` (TM PWE, MPB k path, 197-1793 plane waves): converged WO-04 0.280663 / 0.417165, WO-61 0.274419 / 0.445220, last-step change <= 6e-6. MPB at resolution 32 is 6.9e-3 / 5.2e-3 / 2.4e-3 / 2.4e-3 high, so the old 1 % gate had only a 1.4x margin. Gate is now the PWE value (rel 1e-3), with MPB informative. WO-05 gates on the exact annulus resonances (mpmath): 0.1181916937 / 0.1474310329 / 0.1757793737, Q 77.255 / 343.92 / 1634.21, all equal to the audit's values. Meep at resolution 10 is 7.6e-4 / 1.8e-3 / 3.0e-3 low (informative). WO-62/63/64 are `gate: false` until there is an independent check (TE PWE, supercell, FDTD) |
| m1 EM-05 | Fixed | By tolerance abs 4.2e-5 T (2e-3 of abs(By)). Quarter-symmetry note now cites the VM166 page statement and the Ansys quarter-model losses |
| m2 SM-61 | Fixed | VALE_CALC mode 6 (4370.82061) added. Basis-D targets carry `source_accessed` |
| m3 EM-03 | Fixed | Gate is the exact coplanar filament-loop M_ab = 1.98137 pH (rel 5e-3, strip width est.). The 1.97392 pH small-loop value is informative |
| m4 HT-61 | Fixed | source term f = 1 added to `bcs` |
| m5 WO-05 | Fixed | see S9 |
| m6 MPB/Meep resolution | Fixed | `study.resolution_source` per case; MPB L320 vs L120 gap-range discrepancy noted in WO-63 |
| m7 WO-66 | Fixed | yaml `samples: 32` vs 25 in the file, noted |
| m8 DevLog drift | Fixed | rebuild line uses the project env; diff-react had 3 attempts (69.1 MB) and gray_scott 2 probes, already counted in the 194.5 MB total |
| m9 cache | Fixed | removed my cached GitLab 404 body `cache/eval-c/sources/aster/COPYING`. Code_Aster licence evidence = per-file GPL-3.0-or-later header. scikit-fem licence cited as BSD-3-Clause via the GitHub API |
| m10 validator docstring | Fixed | COMSOL rule now reads "no mention anywhere" (as coded) |
| m11 dead code | Fixed | removed `ref = -b0` in `gen_suites.py::em05` |
| L8 loader warnings | Fixed | each target now has an explicit, unique `metric_id` (Meep/MPB informative ids prefixed `meep_`/`mpb_`) |

### Follow-up 2026-11-06 16:34 PST: WO-04 / WO-61 un-gated (coordinator rule: self-built reference gates only after reproducing the external one under its own settings)

- Disposition: `gate: false` on the PWE targets of WO-04 and WO-61, so both cases currently have no gate.
- Reason: `gen_pwe.py` is a pure plane-wave expansion (Fourier-series eps, no real-space grid, no subpixel smoothing). MPB's printed edges (0.282623311 / 0.419334799 and 0.275065617 / 0.446289919) come from a 32 x 32 grid with MPB's anisotropic subpixel averaging. `gen_pwe.py` does not implement that discretization, so it cannot reproduce MPB to MPB's printed digits. The check was not attempted, because the method mismatch makes it fail by construction.
- What is shown: PWE self-convergence over 197-1793 plane waves, last-step change <= 6e-6, converging to 0.280663 / 0.417165 and 0.274419 / 0.445220. MPB at resolution 32 sits 2.4e-3 to 6.9e-3 above these values. The MPB tutorial's own L320 range (0.2812-0.4174) is also below its L120 values, which is consistent with MPB converging downward, but this is not a proof.
- To gate later, either:
  - run MPB itself (conda only, not allowed here) at resolutions 32, 64 and 128 and show convergence to the PWE values; or
  - add MPB's grid plus subpixel-averaging discretization to an independent solver, reproduce the resolution-32 digits, then refine.
- Checks: validate_cases.py 0 errors; L8 dry-run 0 loader errors / 0 warnings, exit 0 (`logs/eval-20261106T163407.jsonl`).

### Engine wiring and first engine runs (2026-11-06 17:24-17:27 PST)

- Applied I1's lines (DevLog-014 s.5 item 8) through `build_cases.py::apply_audit()` (the "wiring" block), so they survive `--force` rebuilds:
  - EM-02: `spec: sims/two-spheres.yaml`, C_aa/C_bb/C_ab -> scalars C_ta_ta / C_tb_tb / C_ta_tb.
  - EM-03: `spec: sims/coplanar-rings.yaml`, M_ab_filament_exact and M_ab -> L_ra_rb, L_aa -> L_ra_ra, L_bb -> L_rb_rb.
  - RF-01: `spec: sims/cylinder-cavity.yaml`, eigen floor 1e6 Hz, index 0 / 1 / 11, Q_d -> Q_0.
  - Q_c_TE011 and Q_TE011_copper stay pending: the engine has no surface-impedance BC yet.
- Checks: validate_cases.py 36 cases / 104 references / 0 errors.
- `node packages/eval/src/cli.ts --case <ID>` on the engine (worker, 3 levels):

| Case | Result | Values (engine vs reference) | Log |
|---|---|---|---|
| EM-02 | pass (3/3) | C_aa 1.230522e-12 vs 1.230518e-12 F (3.6e-6); C_bb 2.431577e-12 vs 2.431543e-12 (1.4e-5); C_ab -4.945538e-13 vs -4.945668e-13 (2.6e-5) | `logs/eval-20261106T172438.jsonl`, `logs/eval-c-engine-EM-02-*.log` |
| EM-03 | pass (3 gated + 1 info) | M_ab 1.982604e-12 vs exact filament 1.981370e-12 H (6.2e-4, within 5e-3; small-loop 1.973921e-12 is info); L_aa 4.180659e-11 vs 4.178537e-11 (5.1e-4); L_bb 7.072076e-10 vs 7.072050e-10 (3.6e-6) | `logs/eval-20261106T172439.jsonl` |
| RF-01 | timeout (6/6 targets) | worker limit 120 s (20 x budget_s) hit on the 3D `cylinder-cavity.yaml` levels; no error message beyond the timeout | `logs/eval-20261106T172450.jsonl`, `logs/eval-c-engine-RF-01-*.log` |

- RF-01 next step (coordinator or I1 decision):
  - point the frequencies at `sims/cylinder-cavity-axisym.yaml`, as RF-21 does (they are informative duplicates anyway), and keep 3D only for the impedance-wall Q once that BC exists; or
  - raise RF-01's `speed.budget_s.browser` (now 2 s) so the worker limit covers the 3D levels.
