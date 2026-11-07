# Audit: L7c eval class c (2026-11-06)

| Field | Value |
|---|---|
| Date | 2026-11-06 (16:20 PST) |
| Auditor | fresh-context audit subagent (no prior conversation) |
| Target | `eval/cases/c/*.yaml` (36), the 11 class-c files in `eval/expected/`, `validation/c/*.py`, `DevLog/DevLog-008-eval-class-c.md` |
| Context read | `CLAUDE.md`, `DevLog/contracts/CONTRACTS-v0.md` (C8 + changelog), `eval/schema/amp-eval-0.schema.json`, R3 (sections 2-4, 6, 8) |
| Files changed | this file only. Side effect of the L8 dry run: `logs/eval-20261106T160253.jsonl` and `logs/eval-20261106T160253-summary.md`. Generators and the case builder ran from scratch copies that write to the scratch directory, so `eval/expected/`, `eval/cases/c/` and `cache/eval-c/` were not written |
| Scratch | `<session-scratchpad>/` (`fetch/` primary files, `genc/` generator copies, `expected/`, `cases-c/`) |
| Web | 60 requests to primary hosts, 3-6 s apart (GitHub raw at pinned tags/commits, GitLab code_aster 17.5.8, TU Dortmund FEATFLOW, HF API, DaRUS API, arXiv PDF, Ansys VM166/VM58, `gh api` for licences) |

## Verdict

The cited values are transcribed correctly. 27 primary files fetched at the pinned tags/commits are byte-identical to the lane's `cache/eval-c/sources/` copies (same sha256), and every value I checked against its line matches. Re-derivation passes: the regenerated expected values are bit-identical in all 11 files, and the rebuilt 36 YAML files are byte-identical. The audit re-derived EM-02, EM-03, RF-01, RF-61, EM-61, EM-05, SM-61 and CP-03 independently. SM-61 (gate on the Timoshenko closed form) is right. The EM-05 quarter-section reading of 2288 W/m is supported by the VM166 page itself.

Blocking problems (a correct solver would fail the gate):
- RF-03: the Z0 = 56.02 Ohm target is the conformal-map value for isotropic eps_r = 9.3. A correct solver using the anisotropic sapphire the case states gives about 53.4 Ohm.
- SC-02: from 0.1 to 0.3 V, DEVSIM's own golden is loosely converged. The contact currents disagree by up to 3.3 %, so the 1e-3 gate is not meaningful.

Nine significant problems cover:
- the duplicate RF-01 / RF-21 targets;
- the FL-62 code range;
- the AC-62 boundary conditions;
- dataset protocols that are not executable (WO-66, AC-61, TR-63) or not defined at the last frame (FL-63, FL-64, TR-03);
- FL-07, which has no hash;
- rights tags that are undefined and used inconsistently;
- SC-02 inputs that are not stated.

## 1. Values against primary sources (16 cases at line level)

All files were fetched at the cited tag/commit and compared with the lane cache by sha256. Every file matched: Palace spheres/rings/cylinder/coaxial/cpw.md @v0.19.0; MPB Python_Tutorial.md @v1.12.0; Meep Basics.md, test_holey_wvg_cavity.py, test_ring.py @v1.35.1; DEVSIM diode_1d.py @e3a25f0 and golden diode_1d.out @85e6e1f; deal.II step-7 results.dox and step-7.cc @v9.8.0; scikit-fem test_examples.py @12.0.2; TMR naca0012_val_sa.html, cf/drag_convergence.dat @20a39f5; PDEArena maxwell.py, maxwell3d.yaml @78a8b03; PDEBench LICENSE.txt @4ff3e3a; code_aster sdll01a.comm @17.5.8 (sha256 56a87cd1...); FEATFLOW fsi_cfd_tests.html; HF READMEs (gray_scott, shear_flow, acoustic_maze).

| Case | Primary locator checked | Source value | Case value | Independent re-derivation | Verdict |
|---|---|---|---|---|---|
| EM-02 | spheres.md L29-39 (series), L76-78 | 1.230518 / 2.431543 / -0.4945668 pF | 1.2305175 / 2.4315431 / -0.49456676 pF | own Lekner sum, 60 terms: identical to 16 digits | OK |
| EM-03 | rings.md L29, L74, L81-82; w = 1 um L43 | M_ab 1.973921 pH, L 41.78537 / 707.2050 pH | same | mu0 pi r_b^2/(2 r_a) = 1974 pH, mu0 pi r_a^2/(2 r_b) = 1.97392 pH, so the lane's formula-typo flag is correct; exact filament loops 1.98137 pH (+0.38 %) | OK (see m3) |
| RF-01 | cylinder.md L26-27, L50, L56-65, L100, L115-119, L150-155 | TM010 2.903605, TE111 2.922212, TE011 5.000140 GHz; Q_c 2.94e4 | 2.9036361, 2.9221972, 5.0001463 GHz; Q_c 29395, Q 2304.0 | own Bessel zeros: identical. Palace table = rounded zeros (p01 = 2.4048 reproduces 2.903605) | OK (duplicate, S1) |
| RF-61 | coaxial.md L19-24, L99-116 | "|Gamma| = 1/3", -9.5 dB | 0.33318 (lossy line, Z0 50.0536 Ohm) | Z0 = eta0/(2 pi sqrt 2.08) ln(0.215/0.0645) = 50.0536; lossy 0.333182, lossless 0.332857 | OK |
| EM-61 | coaxial.md L124-137, L166-170, L180-182 | 9.6318 / 30.3670 / 20.7352 pH | 9.63178 / 30.36697 / 20.73519 pH | own formula, a = 0.81915, b = 2.7305, l = 40 um | OK |
| RF-03 | cpw.md L18-25 | Z0 56.02 Ohm, sapphire eps 11.5 (par. C) / 9.3 (perp.), C axis z | 56.02 Ohm, gate 1 % | conformal map, h 500 um: isotropic 9.3 -> 56.019 Ohm; isotropic 11.5 -> 50.85; uniaxial (eps_eq = sqrt(9.3 x 11.5) = 10.34, h' = h sqrt(9.3/11.5)) -> 53.39 Ohm | BLOCKING (B1) |
| EM-05 | Ansys VM166 v242 page (Loading, Modeling Notes, Results) | By(0,0) -0.0018 - j0.0210 T; loss 2288 W/m; sigma 2.5380711e7; "omega = 60 Hz" | -0.00184392 - j0.0210448 T; 9151.786 W/m full, 2287.946 quarter | own mpmath solver (30 digits), sigma 2.5380711e7: -0.00184392 - j0.0210448, 9151.786 W/m (agrees to 1e-9) | OK (see m1) |
| CP-03 | Ansys VM58 page | 419.9 / 417.9 F, 341.5 Btu/hr | 488.672 K, 487.511 K, 100.084 W | T_s = T_a + q r/(2h) = 417.85 F; T_c = T_s + q r^2/(4k) = 419.94 F; q pi r^2 = 341.50 Btu/hr | OK |
| SM-61 | sdll01a.comm L54 (A, IY, IZ, AY), L79 (E, NU, RHO), L90-97 (BCs), L162 (430-4500 Hz), L185-246 (TEST_RESU) | VALE_REFE 431.555, 1265.924, 1498.295, 2870.661, 3797.773, 4377.837; VALE_CALC 431.892, 1266.006, 1500.763, 2873.534, 3799.969, 4370.821 | closed form 431.882, 1265.924, 1500.367, 2870.798, 3797.773, 4361.251 | own Timoshenko determinant (kappa = 1/1.17692, rotary inertia) + fixed-free bar: identical | OK (section 1.1) |
| TR-61 | results.dox L85-97 (Q1), L160-172 (Q2) | L2 Q1 16384 cells 7.660e-04 (rate 1.99); L2 Q2 1.394e-05; H1 Q2 rate 1.99 | 0.000766, 1.394e-05, rates 2 | n/a (cited) | OK |
| WO-04/61/62/63 | Python_Tutorial.md L69, L83, L120, L184, L248, L256, L269, L305, L320, L337, L349 | 0.282623311147724 / 0.419334798706834; 0.275065617068082 / 0.446289918847647; 0.223977612336924 / 0.274704473679751; 0.378166; 0.624794702341156 | same digits | n/a | OK (m6) |
| WO-05 | Basics.md L1105 (res 10), L1117-1119 | 0.118101575043663 (Q 80.68), 0.147162555528154 (316.29), 0.175246750722663 (1677.48) | same | exact annulus TM resonances (Bessel/Hankel, own): 0.11819169 (m 3, Q 77.26), 0.14743103 (m 4, Q 343.9), 0.17577937 (m 5, Q 1634.2); Meep res 10 is 0.08 / 0.18 / 0.30 % low | OK; 0.5 % tolerance holds with margin 1.7x (m5) |
| WO-64 | test_holey_wvg_cavity.py L10-19 (eps 13, w 1.2, r 0.36, d 1.4, N 3, sy 6, pad 2, dpml 1), L40 (res 20), L66-69 | f 0.23445415346009466, Q 372.40808234438254 | same | n/a | OK |
| SC-02 | golden diode_1d.out L587, L632, L677, L722, L767 ('top' rows) | 1.1592313132996792e-07 ... 1.815515517328843e-02 A/cm^2 | local re-run, rel <= 7.6e-16 | re-run by the audit (devsim 2.11.2): bit-identical | value OK; gate BLOCKING (B2) |
| FL-05 | cf_convergence.dat, drag_convergence.dat zone CFL3D row 1 | 0.270562153E-02, 0.285985288E-02 | same | n/a | OK |
| FL-62 | naca0012_val_sa.html table | CL(10) CFL3D 1.0909, FUN3D 1.0983, NTS 1.0891, JOE 1.0918; CD(10) 0.01231 / 0.01242 / 0.01243 | range [1.0909, 1.0983], [0.01231, 0.01242] | n/a | values OK; range S2 |
| FL-61 | fsi_cfd_tests.html L190 (level 6+0) | drag 1.42929e+01, lift 1.11905e+00 | 14.2929, 1.11905 N/m | n/a | OK |
| HT-61 | test_examples.py L8-12 | FEM gold 0.073657185490792 | exact series 0.0736713533 | known value of max u for -lap u = 1 on the unit square | OK |
| RF-62 / WO-65 | eo-modulator-atlas DevLog-028 L307-308, L345-347; K6a.json, K1-fem.json (read only) | 213.7269 pF/m, 2.519921, 39.3285 Ohm; n_eff 2.44722338 +- 5.9e-7 | same | K6a closed form JSON identical | OK |

### 1.1 SM-61: closed form vs Code_Aster VALE_REFE

- The closed form is reproduced exactly. The inputs are Cowper kappa = 10(1+nu)/(12+11nu) = 0.84967 = 1/AY, rotary inertia, simply supported bending, and the fixed-free axial bar at A (DX = 0) and B (DX free).
- No single shear coefficient reproduces VALE_REFE. Fitting kappa mode by mode gives 0.8351, 0.8404, 0.8495 and 0.8623 for bending 1-4. Dropping rotary inertia gives +1.4 % to +4.3 %. So the SFM VPCS reference values come from some other (unstated) approximation.
- code_aster's own 40-element POU_D_T results approach the closed form from above. The errors are +2.3e-5, +2.6e-4, +9.5e-4 and +2.2e-3 for bending n = 1-4, growing with mode number as discretization error does. They do not approach VALE_REFE: for mode 6 the FE value 4370.82 lies between the closed form (4361.25) and VALE_REFE (4377.84).
- Conclusion: gating on the closed form is right. VALE_REFE is informative only, and the lane's flag (up to 3.8e-3, above the test's own PRECISION 2e-3) is confirmed. See m2 for a small omission.

### 1.2 EM-05: quarter-symmetry reading of 2288 W/m

- The VM166 page (v242, fetched 2026-11-06) says "The problem can be modeled in quarter symmetry", with A = 0 at x = 0 and the natural condition at y = 0. Ansys' own quarter-model results are 2341.3 W/m (PLANE13) and 2315.2 W/m (PLANE233), ratios 1.023 and 1.012.
- The exact solution with the page's sigma 2.5380711e7 and B0 = 0.1 T peak gives a time-averaged full-section loss of 9151.786 W/m. A quarter is 2287.95 W/m, 2.3e-5 from 2288. With sigma 2.538e7 (R3's rounding), a quarter is 2287.997 W/m.
- The reading of "omega = 60 Hz" as f = 60 Hz is confirmed. With omega = 60 rad/s, By(0) would be +0.0633 - j0.0506 T, which contradicts the target.
- Other readings that also give 9152/4 (half section with B0 rms, or one-eighth section without the 1/2) do not match the stated quarter model.
- The reading is supported. The lane's phrase "the page does not state it" is too weak (m1).

## 2. Licences (checked at the primary repo)

| Source | Primary evidence | Licence | GPL-3.0-or-later compatible | Case tags |
|---|---|---|---|---|
| Palace | LICENSE @v0.19.0; per-file SPDX Apache-2.0; `gh api` Apache-2.0 | Apache-2.0 | yes (one way) | copy_with_attribution in 4 of 5 Palace cases; RF-03 lacks it (S7) |
| MPB, Meep | License_and_Copyright.md @tags: "version 2 ... or (at your option) any later version"; MPB: example Scheme code "freely used, modified, and redistributed" | GPL-2.0-or-later | yes | copy_text / copy_input_files forbidden (over-restrictive, S7) |
| code_aster astest | sdll01a.comm L3-17 header, GPL v3 or later; root COPYING 404 at 17.5.8 (the lane's `aster/COPYING` is a cached 404 body, m9) | GPL-3.0-or-later | yes | SM-61 forbids copy_input_files, while L7a's SM-21 (same suite, same licence) allows copy_with_attribution (S7) |
| deal.II step-7 | step-7.cc L3 `SPDX-License-Identifier: LGPL-2.1-or-later`; GitHub NOASSERTION (dual) | LGPL-2.1-or-later | yes | cite only |
| DEVSIM | diode_1d.py SPDX Apache-2.0; LICENSE Apache-2.0 | Apache-2.0 | yes | the golden repo has no licence (`gh api` 404): values cited, file only cached at runtime (correct) |
| scikit-fem | `gh api` BSD-3-Clause (file is `LICENSE`, not `LICENSE.md`) | BSD-3-Clause | yes | OK |
| NASA TMR | LICENSE @20a39f5 CC0 1.0 | CC0-1.0 | yes | copy_data allowed (correct) |
| FEATFLOW | page has Impressum, no licence | none stated | values only | cite_values (correct) |
| Ansys VM58/166/175/223 | page footer "Contains proprietary and confidential information of ANSYS, Inc."; "All rights reserved" | proprietary | values (facts) only | cite_values; no prose copied (10-word shingle scan of all YAML and `validation/c/*.py` against the fetched pages: only input-number strings match) |
| The Well | HF API: license tag cc-by-4.0 on all 5 repos (R3 said 4 repos lack the tag; no longer true); code BSD-3-Clause (`gh api`) | CC-BY-4.0 | yes (data, with attribution) | reference_by_hash |
| PDEBench | DaRUS API v8.0 license "CC BY 4.0"; LICENSE.txt "MIT except where otherwise stated" | CC BY 4.0 / MIT | yes | reference_by_hash |
| PDEArena Maxwell-3D | HF tag mit; repo MIT (`gh api`) | MIT | yes | copy_with_attribution |
| AirfRANS | LICENSE ODbL (`gh api` ODbL-1.0) | ODbL-1.0 | data kept out (R3 s.6) | reference_by_hash claimed, but no hash exists (S6) |
| eo-modulator-atlas | sibling repo, no top-level LICENSE file; owner's own work | own work | yes | OK |

Copying of restrictive documentation text: none found. COMSOL: no files, runs or values. The word appears only in the validator's check and in DevLog-008's policy lines.

## 3. Dataset metadata cases

| Case | Id / revision (primary) | File + hash (primary) | Equations / params vs primary | Protocol well defined? |
|---|---|---|---|---|
| TR-03 | polymathic-ai/gray_scott_reaction_diffusion sha 913ef567 = case | bubbles_F_0.098_k_0.057.hdf5, 2,650,800,128 B, LFS sha256 db6bac94... = case | README L53, L90-93: delta 2e-5/1e-5, 6 (f, k), [-1,1]^2, dt 1, stored every 10; B equation prints "- AB^2" (lane flag confirmed) | frames 1, 10: yes. "last" (t = 10000): not without a horizon rule (S4); grid-label assumption is open |
| AC-61 | helmholtz_staircase a2429505 = case | omega_006, 335,544,320 B, d32ae84d... = case | case notes | no: frame 0 does not determine the solution (source, time-harmonic); geometry must come from the mask (S5) |
| AC-62 | acoustic_scattering_maze 8df383a3 = case | chunk_18, 15,980,298,240 B, dd7198b4... = case | README L51-53, L87, L95, L99-101 = notes; stored BC attrs disagree (S3) | not until the BCs and the domain extent ([0,1] stored vs [-1,1] README) are resolved |
| FL-63 | rayleigh_benard 10e143eb = case | Ra 1e6 Pr 1, 1,082,130,432 B, da1c78ca... = case | case notes | short horizon only; "last" (t = 49.75) is past predictability (S4) |
| FL-64 | shear_flow 1bca59ae (2026-10-19) = case | Re 1e4 Sc 0.1, 1,694,498,816 B, 0af4b6bb... = case | README L65-80, L115-117 = notes; README 128 x 256 vs stored 256 x 512 (flag confirmed) | as FL-63 (S4) |
| TR-02 | DaRUS doi:10.18419/darus-2986 v8.0 (2024-02-13), file 255675 | 8,232,966,952 B, md5 1fe41923... = case | arXiv v7 D.1 eq. 6-8 (x in (0,1), t in (0,2], k_max 8, N 2) = notes | yes (exact shift); stored t has 202 labels for 201 frames (flag) |
| TR-62 | file 281363 | 8,232,968,312 B, md5 e6d9a4f6... = case | D.3 eq. 11-12 = notes | yes |
| FL-06 | file 133219 | 1,310,724,488 B, md5 81694ed3... = case | D.4 eq. 13-15 = notes | yes (steady, stored a(x)); a(x) interpolation is an assumption |
| TR-63 | file 133017 | 13,243,560,688 B, md5 b8d0b860... = case | D.9 eq. 24-26, Du 1e-3, Dv 5e-3, k 5e-3, (-1,1)^2, t <= 5 = notes; BC not stated in the paper (confirmed) | no: layout and BC are unverified (probe failed) (S5) |
| WO-66 | pdearena/Maxwell-3D 945a09ca = case | Maxwell3D_test_126488.h5, 314,575,504 B, b8fbaae8... = case | maxwell3d.yaml = notes (config `samples: 32` vs 25 in the file: m7) | no: the 32^3 crop has no sources or exterior; regeneration needs the unpinned `fdtd` package (S5) |
| FL-07 | none | none (`file: N/A`) | not checked (no fetch) | no hash, no revision (S6) |

- DaRUS duplicate-md5 flag: confirmed (8 NS_incom pairs, e.g. 512-131/132, 512-20/21).
- DaRUS totals: 336 files, 3,902,903,970,421 B (= lane).
- Cache: `cache/eval-c/` is 6.1 MB on disk (`du -sh`) and covered by `.gitignore` (`cache/`). The ten sidecars total 62.0 MB. Adding the failed probes from the logs (2 x 49.28 + 11.80 + 8.00 + 7.86 MB) and the first gray_scott probe (6.29 MB) gives 194.5 MB, which matches DevLog-008 and stays under 200 MB.

## 4. Reproducibility (runs by this audit)

| Command (nice 10, from `validation/`) | Result |
|---|---|
| `uv run python c/validate_cases.py` | 36 cases, 85 references, 0 errors (jsonschema imported) |
| `gen_palace.py`, `gen_suites.py`, `gen_devsim.py` (scratch copies; `AMP_EXPECTED_DIR` and the cache path pointed to scratch) | each < 1 s wall (devsim < 2 s); all 11 expected files: target values bit-identical to the committed JSON |
| `build_cases.py --force` (scratch copy, CASES -> scratch) | 36 YAML, `diff -r` against `eval/cases/c`: identical |
| `node --max-old-space-size=1536 packages/eval/src/cli.ts --class c --dry-run` | 36 cases, 85 targets pending, 0 loader errors, 0 warnings, exit 0 |

## 5. Overlap with classes a and b

- IDs: no duplicates across `eval/cases/{a,b,c}`. All new class-c IDs are in 61-79.
- RF-01 vs RF-21 (class a): same cavity (a 27.4 mm, d 2a, eps 2.08, tan d 4e-4), same closed form. f TM010, TE111, TE011 and Q_d are bit-identical gating targets in both (S1).
- FL-61 (CFD1, rigid flag) vs CP-07 (FSI1, class b): same geometry and Re, different targets. The split of one FEATFLOW page family across classes b and c was a coordinator decision. No change needed.
- RF-61 Z0 (gate false) and EM-61 L_geom use the coax formulas of EM-01 (class a, different radii). This is acceptable.
- Inputs needed to rebuild: present for 30 of 36 cases. Gaps: SC-02 (S8), RF-03 (ground width and enclosure, listed under missing), AC-61 (staircase geometry, listed), TR-63 (layout and BC, listed), WO-66 (generator version, listed), FL-07 (file and hash), HT-61 (source term only in the title, m4), MPB/Meep resolution not in `study` (m6).

## 6. Findings

### Blocking

**B1. RF-03 target 56.02 Ohm is the isotropic eps_r 9.3 value, not the anisotropic substrate the case specifies.**
- Evidence: in-plane eps 9.3 and normal eps 11.5 (cpw.md L21-24). The conformal-map CPW on a finite substrate (w 30, s 18, h 500 um) gives 56.019 Ohm for isotropic 9.3, which is exactly the printed 56.02. The uniaxial substrate maps to isotropic eps sqrt(9.3 x 11.5) = 10.34 with h' = h sqrt(9.3/11.5) and gives 53.39 Ohm (-4.7 %).
- Impact: the case gates at 1 % with `gate: true`, so a solver that models the stated anisotropy fails by about 4.7 %.
- Fix, pick one:
  - (a) Gate on the anisotropic quasi-static closed form, 53.39 Ohm (basis D, generator in `gen_palace.py`), and keep 56.02 as informative.
  - (b) Declare an isotropic eps 9.3 sub-case for 56.02.
- Also: `form` should be `closed_form` (handbook formula), not `solver_ref`.

**B2. SC-02 gate at 1e-3 (0.1-0.3 V) is tighter than the reference's own convergence error.**
- Evidence: in the golden, the 'top' and 'bot' total currents should be equal and opposite in DC. They differ by 2.45 % (0.1 V), 3.26 % (0.2 V), 0.35 % (0.3 V), 1.5e-4 (0.4 V) and 4e-6 (0.5 V). The example solves with `absolute_error=1e10` (diode_1d.py L40, L49), so at low current the Newton loop stops on the absolute criterion.
- Impact: a current-conserving independent solver can differ from J_top by more than 1e-3 at 0.1-0.3 V and fail.
- Fix: gate 0.4-0.5 V at 1e-3. Either make 0.1-0.3 V informative or set their tolerance to at least 5e-2, or gate on (|J_top| + |J_bot|)/2 with a stated rule. Record the mismatch in `assumptions`.

### Significant

**S1. RF-01 duplicates RF-21.**
- Evidence: 4 of RF-01's 6 targets (f TM010, TE111, TE011, Q_d) are the same values from the same closed form as class-a RF-21.
- Impact: double counting in pass rates.
- Fix: make RF-01 the impedance-wall case only (Q_c TE011, Q copper, which RF-21 does not have) and point to RF-21 for the frequencies. Alternatively, set `gate: false` on the duplicates.

**S2. FL-62 ranges cover only CFL3D..FUN3D.**
- Evidence: the TMR page lists seven codes on the same grid with "max 1 % difference in lift, 4 % in drag". NTS gives CL 1.0891 (below 1.0909) and CD 0.01243 (above 0.01242), and JOE gives 1.0918.
- Impact: a solver as good as NTS fails.
- Fix: use the envelope of all listed codes, widened to the page's stated spread. Better, gate on the TMR NACA 0012 numerical-analysis (grid-converged) case and keep the validation table informative.

**S3. AC-62 boundary conditions conflict with the stored data.**
- Evidence: the case says "open in y, reflective in x" (README L87). The stored HDF5 attributes in all three probed variants are `x0_wall` WALL, `xL_open` OPEN, `y0_wall` WALL, `yL_open` OPEN (cache structure.json). The stored extent is [0,1]^2, while README L95 says [-1,1]^2.
- Fix: read the HF `generation/*.py` scripts and use the stored BC attributes and masks as authoritative. State the BCs per edge in `bcs` before any gate.

**S4. "Frames 1, 10, last" has no defined last-frame gate for the chaotic or long-horizon datasets (FL-63, FL-64, TR-03).**
- Evidence: FL-63's own note says "Chaotic at high Ra: use ... short horizons". The last stored frames are at t = 49.75, 19.9 and 10000. There the self-convergence floor of two resolutions is not a discretization floor.
- Fix: replace "last" with a stated horizon (for example the first frame where our two finest levels differ by VRMSE > 0.1) and move long-horizon checks to statistics (spectra, moments).

**S5. Protocol not executable as written for AC-61, WO-66 and TR-63.**
- AC-61: time-harmonic with a point source, so frame 0 does not determine the trajectory. The case note proposes a BVP solve, but the metric line still says "integrate from frame".
- WO-66: the stored 32^3 crop has no sources or exterior. Regeneration needs the 64^3 run, the per-sample seed and an unpinned `fdtd` version. The `d_field` array is actually `grid.E` (maxwell.py L142).
- TR-63: the file layout and the BC are unverified.
- Fix: give each case its own protocol line (AC-61: frequency-domain BVP vs the stored phases; WO-66: regenerate with a pinned `fdtd` version and the seed derivation from maxwell.py L148, or drop it). Keep `status: untestable` with `activation` until the probe or pin exists.

**S6. FL-07 claims `reference_by_hash` but has no hash, file or revision.**
- Evidence: `dataset.file: N/A (not fetched...)`.
- Fix: record the archive URL, size and sha256 from a HEAD/range read, or mark the case `untestable` with `activation: archive hash recorded`.

**S7. Rights tags are undefined and applied inconsistently.**
- Evidence:
  - `copy_with_attribution`, `reference_by_hash`, `redistribute_data_without_attribution` and `copy_text_without_attribution` were accepted in the contract changelog, but neither the schema nor any doc defines them.
  - Palace (Apache-2.0), scikit-fem (BSD) and PDEArena (MIT) cases list `copy_with_attribution` in `allowed` and `copy_text` / `copy_input_files` in `forbidden` at the same time, which contradicts itself.
  - RF-03 (Palace) lacks the tag.
  - The GPL-2.0-or-later (MPB, Meep), GPL-3.0-or-later (code_aster) and LGPL (deal.II) sources forbid copying, although R3 s.6 lists them as copy-compatible. L7a's SM-21 (code_aster, same licence) allows `copy_with_attribution`.
- Fix (L8 + coordinator):
  - Define each tag in the schema `rightsItem` description, for example `copy_with_attribution` = may copy code, text or input files into the GPL-3.0-or-later repo, keeping the licence, copyright and NOTICE files and stating changes.
  - Then apply one rule per licence family across lanes a/b/c, and drop `copy_text` from `forbidden` where `copy_with_attribution` is allowed.

**S8. SC-02 does not state the inputs needed to rebuild it.**
- Evidence: the materials are "DEVSIM simple_physics defaults via diode_common.SetParameters". The case gives no explicit n_i, eps_Si, T, tau_n/tau_p or mobility model, and the mesh only as text.
- Fix: write the numeric values (read from diode_common.py at e3a25f0) into `materials` and `bcs`.

**S9. Tolerances on unconverged solver references are "after richardson" with no measured margin (WO-04, 61, 62, 63, 64).**
- Evidence: the MPB values are at resolution 32 or 16 and Meep's at 20. For WO-05 the audit's exact Bessel solution shows the Meep resolution-10 error is 0.08-0.30 %, inside 0.5 %. For MPB and WO-64 the margin is unknown.
- Fix: write the independent PWE generator (already a DevLog-008 TODO) before gating. Until then, compare at the source's resolution or mark the 0.5-1 % tolerances as estimates with a pending check.

### Minor

- m1. EM-05: replace "inferred ... the page does not state it" with "VM166 states a quarter-symmetry model (Analysis Assumptions); Ansys' quarter-model results 2341.3 / 2315.2 W/m". The relative tolerance of 2e-3 on Re By (-0.00184 T, 9 % of |By|) is sensitive to inputs: a sigma change of 2.8e-6 moves it by 1.35e-4. Use a tolerance relative to |By|.
- m2. SM-61: `reference_results` omits VALE_CALC for mode 6 (4370.82061, sdll01a.comm L241). Add it. Also, the provenance `accessed` is null on basis-D targets that cite the comm file.
- m3. EM-03: M_ab gates on the r_a << r_b approximation (1.97392 pH) at 2 %. The exact coaxial filament-loop value is 1.98137 pH (+0.38 %). Gate on the exact value with a smaller tolerance, or state the 0.38 % model error.
- m4. HT-61: the source term f = 1 appears only in the title. Add it to `bcs` or a structured field.
- m5. WO-05: an exact reference exists (annulus TM resonances: 0.11819169 / 0.14743103 / 0.17577937, Q 77.26 / 343.9 / 1634.2). Add a generator and gate on it, with Meep informative.
- m6. MPB and Meep cases: put the resolution (32, 16, 10 or 20) and mesh_size in `study`, not only in tolerance notes. The MPB doc's own gap range for the defect section (0.2812-0.4174, L320) differs from its printed gap (0.2826-0.4193, L120). Add this to the flags.
- m7. WO-66: maxwell3d.yaml says `samples: 32`, while the file size implies 25. Note it.
- m8. DevLog-008 drift:
  - Contract request 1 is already satisfied (validation/pyproject.toml has devsim, requests, h5py and jsonschema), but the rebuild line still uses `--with`.
  - The plan said "at most one small read per dataset", but diff-react had 3 attempts (69.1 MB) and gray_scott 2. The total stayed under 200 MB.
- m9. `cache/eval-c/sources/aster/COPYING` is a cached GitLab 404 JSON body. `skfem` licence path is `LICENSE`, not `LICENSE.md`. Delete the bad cache entry and cite the per-file GPL header as the licence evidence.
- m10. `validate_cases.py` docstring says COMSOL mentions are allowed in rights/notes text that excludes it, but the code rejects any mention. The behaviour is fine; fix the docstring.
- m11. `gen_suites.py` em05 has a dead line (`ref = -b0 # ... sign check below`). Remove it.
