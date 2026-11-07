# Audit: L7b eval class b (2026-11-06)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Auditor | fresh-context audit subagent (no prior conversation) |
| Target | `eval/cases/b/*.yaml` (20), `eval/expected/CP-44.json`, `validation/b/` (`check_cases.py`, `digitize.py`, `fetch_cached.py`, `fill_hashes.py`, `gen_expected.py`, digitize spec + output), `DevLog/DevLog-007-eval-class-b.md` |
| Context read | `CLAUDE.md`, `DevLog/contracts/CONTRACTS-v0.md` (C8 + changelog), `eval/schema/amp-eval-0.schema.json`, R3 (`DevLog/research/2026-11-06-R3-eval-set-sources.md`, s.1-3, s.8) |
| Files changed | this file only. Side effects of the runs (gitignored `logs/`): `audit-l7b-check-cases-20261106T160327.log`, `audit-l7b-loader-dryrun-20261106T160327.log`, `eval-20261106T160327.jsonl` + `-summary.md` (written by the L8 dry run), `audit-l7b-digitize-selftest-20261106T160354.log` |
| Scratch (not in repo) | `<session-scratchpad>/` (`fetch/`, `arxiv/`, `gh/`, `st1996/`, `john2004/`, `bench2new/`, `digitize-selftest/`) |
| Network | 25 requests, 2-5 s apart: FEATFLOW (8), FEATFLOW 2D-2 2014 data zip (1 + HEAD), Hron course PDF, arXiv (6), raw.githubusercontent (6), GitHub licence API (4), WIAS (2). One 429 from mediatum.ub.tum.de (Hornikx record): stopped, not retried |
| Git | read-only `git show/log/diff/cat-file` in the two atlas repos (commit checks); one `git check-ignore` here |

## Verdict

The values are transcribed correctly. 19 of 20 cases were checked: 15 against independently re-fetched open sources, every one with the same sha256 as the lane's cache sidecar, and 4 against the atlas files and paper text at the cited commits. AC-01 could not be re-read. No invented value turned up. The problems are with reference choice and tolerances. Two gates would fail a correct solver: FL-04 c_L,max (the 1996 bound excludes the converged value) and FL-43 c_D,max (the reference is an under-resolved FEATFLOW level, 0.24 % from John 2004, and the gate is 0.2 %). The fix for FL-43 is an open author-hosted copy of John 2004 that the lane listed as a manual download. A third gate fails at one station: FL-02 Re 1000 v(0.9063), where Ghia differs from a 601^2 solution by about 0.011 against a 0.01 tolerance. Seven significant findings cover tolerances that are tighter than the spread between sources, or that do not match the atlas rule they claim to carry. The rest are minor. The checker, the loader and the digitizer self-test all reproduce.

## 1. Values versus sources (19 of 20 cases checked)

Re-fetch: every source below was downloaded again into scratch and hashed. All sha256 values equal the lane's sidecars (FEATFLOW 2D-1/2D-2/2D-3/3D results/FSI tests/CSM tests/FSI definitions, Hron course PDF `e020ab26...`, arXiv physics/0305049 `f422f19d...`, 1401.0188 `5f8762f9...`, 1206.2099 `5050c568...`, 0906.1236 `be720061...`, pysph, Lethe, INS2D, femwell x2).

| Case | Source checked | Values, units, locator | Result |
|---|---|---|---|
| FL-02 | pysph `ghia_cavity_data.py` table1/table2 | 4 x 17 values Re 100/1000; column numbering is 1-based incl. y | match |
| FL-41 | arXiv physics/0505121 p.22 Table 1; INS2D `LDC_pp.m` L231-233 | 0.1189366, 2.067753, (0.5308, 0.5652); 0.3885698 / -0.5270771 / 0.3769447; "0.18 %" text on p.8 | match (locator caveat in m3) |
| FL-42 | Lethe `benchmark-data.txt` L3-13 | 10 x_r values 2.922 ... 13.121; Lethe doc L276 (2.896, 0.8 %) | match |
| FL-03 | FEATFLOW 2D-1 page; 1996 open copy p.12 Table 3 | 5.57953523384 / 0.010618948146 / 0.11752016697; bounds 5.57-5.59, 0.0104-0.0110, 0.0842-0.0852, 0.1172-0.1176 | match |
| FL-04 | FEATFLOW 2D-2 page; 1996 p.13 Table 4 | L6 3.2200 / 0.9859 / 0.30188; bounds 3.22-3.24, 0.99-1.01, 0.295-0.305, 2.46-2.50; 1996 dp definition t0 at c_L max (p.4) | match (B1) |
| FL-43 | FEATFLOW 2D-3 page; 1996 p.14 Table 5 | L6 2.9437637214 / 0.47748781595 / 0.11154138872; bounds 2.93-2.97, 0.47-0.49, -0.115..-0.105 | match (B2) |
| FL-44 | FEATFLOW 3D results + conclusion ([2] = Braack-Richter); 1996 p.16 Table 7, p.5-6 definitions | 6.18533 / 0.009401; bounds 6.05-6.25, 0.008-0.010, 0.165-0.175; Um 0.45, Ubar 4Um/9, points (0.45/0.55, 0.20, 0.205), c = 2F/(rho U^2 D H) | match |
| CP-07 | FEATFLOW FSI tests | FSI1 7+0: 2.270493e-05, 8.208773e-04, 14.29426, 0.7637460; parameters FSI1 column | match |
| CP-41 | FEATFLOW FSI tests | FSI3 dt 0.0005 4+0: -2.86e-3 +- 2.70e-3 [10.92], 1.45e-3 +- 3.490e-2 [5.46], 460.2 +- 27.47, 2.37 +- 153.75 [5.46] | match (S3) |
| SM-41 | FEATFLOW CSM tests | CSM1 5+1 -7.18767 / -66.1023 (x 1e-3 m), CSM2 -0.469000 / -16.9739; g = 2; mu 0.5e6 / 2.0e6 | match |
| CP-01 | arXiv physics/0305049 p.7 Table 1; 1401.0188v2 p.15 Table 1 | 2.245 / 4.522 / 8.825 (Hortmann), 8.8252 (Le Quere), 2.243 / 4.519 / 8.800 (dVD); Pr 0.71 | match (m5 locator) |
| WO-02 | femwell `mode_solver.py` | 8 n_eff, lambda 1.15, n 3.44 / 3.40 / 1, w 3, h 1, +-3e-6 note | match (m6 window) |
| WO-41 | femwell `mode_solver_rectangle.py` | 4 n_eff, eps, metallic edges, lambda 1.5, 1e-8 note, 5e-6 green threshold | match |
| CP-08 | arXiv 1206.2099v1 p.1-4 | 194 THz, 2.2e7, 5.7 GHz, 127 fg, 770 / -90 / 880 kHz, 5.1 GHz, 1.1 MHz, cell tuples, p_ij, [100]/[010] | match (m7: source sums to 790) |
| CP-42 | arXiv 0906.1236 p.9 Table I, p.1, p.7 | 2.254-2.369 GHz sim, 2.254-2.361 meas, 329-704 fg; E 168.5 GPa, n 3.493 fitted | match |
| CP-43 | EO atlas `f418495:sims/pan2021/config.yaml`; `references/pan2021/text.md` L120-154, L226 | 4.06 V cm (sim), 3.67 (meas), n_g 2.276, "good matching with 50 Ohm"; Optica OA licence (Crossref) | match (m8 Z0) |
| CP-44 | EO atlas `f418495:sims/arabjuneghani2022/config.yaml`; paper text L111, L198, L270-272, L327-329, L346 | 3.3 V cm, n_m 2.2, n_g 2.23, 49-52 Ohm, 3.6 dB/cm at 67 GHz; CC BY 4.0 (Crossref vor + am); PDF sha256 `85e8f54c...` = expected JSON | match |
| SM-42 | packaging atlas `d12ff46:validation/cases/C/ectc51529.2024.00155-fem.yaml`; paper text p.5 | 263 / 247 / 216 / 317 / 282 / 249 um; Fig. 12 has no printed values (atlas figure reading +-5 um) | match to atlas (S5) |
| RF-41 | packaging atlas `d12ff46:validation/cases/D/em_1_abf_microstrip_glass.yaml`; paper text L530-558 | 12 IL/mm values; 12 tolerances recomputed as 0.029 + 0.05 x measured (all agree to rounding) | match (m9 table label) |
| AC-01 | not re-verified: Zenodo 403 (lane), mediatum 429 (audit) | closed form abs(p) = rho c is correct physics for a matched duct | unverified source (m10) |

Atlas drift: `git diff f418495 HEAD` (EO atlas) and `d12ff46 HEAD` (packaging atlas) on the cited paths: empty.

## 2. Findings

### Blocking

**B1. FL-04 `c_L_max` gate `within_bounds [0.99, 1.01]` excludes the converged value.**
Evidence: FEATFLOW's own "New reference results" (2D-2 page: "higher-order line integration ... higher quality compared to the results above"). The audit downloaded `20141124_dfg_bench2_official.zip`, about 0.5 MB, and computed the extrema of `bdforces_q2_lv*_dt*`.

| level | dt 1 | dt 2 | dt 4 (finest) |
|---|---|---|---|
| c_L,max L5 | 0.98256 | 0.98594 | 0.98619 |
| c_L,max L6 | 0.98295 | 0.98633 | 0.98657 |
| c_D,max L6 | 3.22730 | 3.22739 | 3.22739 |

From the same L6 finest-dt data: St = 0.30184 (zero crossings, 2 periods) and dp(t0 + 1/2f, t0 at c_L max) = 2.4848-2.4856, both inside the 1996 bounds. The finest 1996 participant (9a, Table 4) also gives 0.9862. The case says "gate reported, not enforced", but that is only a `note`. The target has no `gate: false`, so the harness will enforce the bound.
Fix: replace the c_L_max reference with the 2014 FEATFLOW value 0.9866 (L6, finest dt; cite the zip and its file names), with `rel 2e-3` (proposed) or bounds [0.984, 0.990]. Keep the 1996 interval as `reference_results`. Cache the zip with a sidecar. Optionally move c_D,max to 3.2274 with a tolerance and keep the bounds as a second check.

**B2. FL-43 references are the under-resolved FEATFLOW level 6, not John 2004. Correct solvers fail the c_D,max gate.**
Evidence: John 2004 is openly hosted by the author at `https://wias-berlin.de/people/john/ELECTRONIC_PAPERS/Joh04.IJNMF.pdf` (fetched, 10 pages; the :8443 URL 301-redirects there). From p.784-785:

- eq. 8: c_D,max = 2.950921575, t = 3.93625, error < 5e-7.
- eq. 9: c_L,max = 0.47795, t = 5.693125, error <= 1e-4.
- eq. 10: dp(8 s) = -0.1116, error < 1e-4.
- Highlight thresholds: 0.1 % for drag, 1 % for lift and dp.

FEATFLOW c_D,max is still rising with level (2.9210, 2.9364, 2.9438). It sits 0.243 % below John's value, but the case gate is `rel 2e-3`. The sign question (DevLog-007 flag 3) is settled: John gives -0.1116, which is consistent with the 1996 bounds, so FEATFLOW's +0.11154 is the outlier.
Fix: gate on John 2004 eq. 8-10. Proposed (assumption) tolerances: c_D,max rel 1e-3, c_L,max rel 1e-2, dp(8) rel 1e-2, following John's own emphasis thresholds. Use the signed dp (-0.1116) and keep FEATFLOW as `reference_results`. Remove John 2004 from the manual-download list, record the URL with a rights note ("author-hosted publisher PDF, rights not stated"), and cache it under `cache/eval-b/`.

**B3. FL-02 Re 1000 v-profile: at the x = 0.9063 station, Ghia differs from a fine-grid solution by more than the 0.01 tolerance.**
Evidence: Erturk, Corke, Gokcol, arXiv cs/0411047 (fetched), 601 x 601 grid. Its v-profile table (titled "u-velocity" in the text extraction, columns swapped) gives v(0.895, 0.910, 0.925) = -0.5132, -0.5263, -0.5052 at Re 1000. A parabola through these points gives v(0.9063) = -0.526. Ghia gives -0.51550, so Delta = 0.011. This is consistent with the spectral v_min of -0.5270771 (FL-41). Other margins are small but pass: u(0.1719) Erturk about -0.388 vs Ghia -0.38289 (Delta 0.005); u(0.9688) about 0.582 vs 0.57492 (0.007).
Fix: for Re 1000 use `abs 1.5e-2`, or exclude the stations within 0.1 of the walls from the gate. Better, gate Re 1000 on FL-41 (spectral) and keep Ghia Re 1000 as `reference_results`. State the tolerance basis: Ghia vs Erturk-Corke-Gokcol spread, citing arXiv cs/0411047 and its table.

### Significant

**S1. FL-42 cannot be rebuilt to its 1 % gate.** The inlet (location, and parabolic vs uniform) and the outlet length are assumptions. Lethe's uniform-inlet setup differs from Erturk by 0.8 % at Re 100 and 3.9 % at Re 1000 (Lethe doc L276, L286), and that spread is already larger than the tolerance. Normalization by h is inferred.
Fix: set `gate: false` (or `status: untestable` with `activation: "Erturk 2008 sec. 2 inlet/outlet read"`) until the primary is read. Candidate open source to check: Fomin and Fomina 2017, Computational Continuum Mechanics 10(3), journal.permsc.ru `CCMv10n3a21`, which cites and compares to Erturk. Not fetched by the audit.

**S2. CP-42 tolerance contradicts the case's own missing list.** The gate is rel 5e-3 on breathing-mode frequencies. The case's missing item says the ideal-taper model should show "percent-level frequency offsets (est.)". Adjacent modes are only 0.9-2.0 % apart (2.254, 2.275, 2.294, 2.322, 2.369 GHz), so 0.5 % also risks mode misassignment. Mode 1 is fitted (p.7), so the information is in the spacings.
Fix: gate the frequency differences f_n - f_1 or ratios f_n / f_1 with a tolerance derived from the geometry sensitivity. Alternatively, gate absolute f at rel 2e-2 (proposed) and require mode identification by displacement symmetry.

**S3. CP-41 (FSI3): the same FEATFLOW page holds a second, older FSI3 table that disagrees with the chosen row by more than the tolerances.** The second table carries the Delta t = 0.001 / 0.0005 caption, which is a LaTeX image alt text. Its lev 4 row reads: u_x -2.69e-3 +- 2.53e-3 [10.9], u_y 1.48e-3 +- 34.38e-3 [5.3], drag 457.3 +- 22.66, lift 2.22 +- 149.78. These match the widely quoted Turek-Hron 2006 values; that match is the audit's recollection, since the paper is paywalled. Compared with the case values:

| quantity | case | older table | gap | case tolerance |
|---|---|---|---|---|
| drag amplitude | 27.47 | 22.66 | 21 % | 2 % |
| u_x amplitude | 2.70e-3 | 2.53e-3 | 6.7 % | 5 % |
| lift amplitude | 153.75 | 149.78 | 2.6 % | 5 % |

Spatial convergence in the chosen table: drag amplitude 26.62 (3+0) to 27.47 (4+0), +3.2 %.
Fix: record both tables in `reference_results` with their captions, and state why the 4+0 table is the reference. For the drag amplitude, gate at rel 1e-1 (proposed) or `gate: false`, and keep frequencies and means tight. Fetch `ref_fsi3.point`, listed on `fsi_reference.html`, to settle it.

**S4. SM-42 tolerance does not match the atlas rule it claims.** The atlas case `d12ff46` has `tolerance: {abs_um: 10, rel: 0.10, rule: max}`, i.e. 21.6-31.7 um for these values. The case encodes `abs: 10.0e-6` only, while its note says "max(10 um, 10 %)".
Fix: encode `rel: 0.10` with a 10 um floor. If the schema cannot express max(abs, rel), use `rel 0.10`, because rel exceeds 10 um for every value here.

**S5. SM-42 values are figure readings made outside the lane's digitization protocol.** DevLog-007 s.7: "a value read from a figure enters a case only through digitize.py ... No eyeballed numbers." The six warpage values are atlas bar readings at +-5 um with an unrecorded method. Fig. 12 prints no values (paper text L592-604). The underlying inputs are also atlas template values: Poisson ratios, thicknesses, stress-free temperature.
Fix: either run `digitize.py` on Fig. 12 (IEEE, paywalled: numbers only, figure not copied), or label the values `extraction: digitized (atlas, method N/A)` and mark the case `gate: false` until the inputs are sourced. The atlas itself calls the warpage model a template.

**S6. FL-04 and FL-43 cite FEATFLOW pages and the course copy, but the case files miss the higher-quality data on those same pages.** The 2014 2D-2 zip and John 2004 are the actual references. These are covered by B1 and B2; they are listed here so that DevLog-007 flags 2 and 3 get closed. Fix: update DevLog-007 s.4.3 and the manual-download list (#5 is openly available).

**S7. CP-08 is not runnable, yet its status is `unvalidated`.** The a(x) taper (Fig. 2(a)), the cell counts and rh are missing. The case says "until then the case is not runnable". Fix: `status: untestable`, `untestable_reason`, `activation: "a/a_nom digitized from arXiv 1206.2099 Fig. 2(a) via digitize.py"`.

### Minor

- m1. FL-02 `missing` claims a 0.01 tolerance basis "assumption" while Ghia's accuracy is undocumented. See B3 for a sourced basis.
- m2. FL-41 psi tolerance rel 1e-3 is tighter than the 0.18 % spread the note cites. This is fine for an extrapolated result compared against a spectral reference, but say so in the note.
- m3. FL-41 provenance says INS2D "loads 'BP' data, line 7" and "plots -uGhia, L117". Both lines are commented out (`% run('results/LDC/BP.m');`, `%     plot(-uGhia,yBP,'rx');`). The attribution and sign reasoning rest on comments. The value is independently consistent with Erturk-Corke-Gokcol (u min about -0.3886 near y = 0.17). Fix: reword, and cite arXiv cs/0411047 as a second open source.
- m4. CP-44 `RF_loss_66GHz_digitized` uses `basis: S` for a value read directly from the primary figure. It should be P.
- m5. CP-01 `materials.source` says Pr 0.71 is on "p.6". It is on p.5 of arXiv physics/0305049 (pdftotext page count).
- m6. WO-02 `missing` says the femwell window is "18 um x 14 um"; femwell uses 18 x (10 + 3) = 13 um (`box_thickness = 10`, `clad_thickness = 3`). The case's own `bcs` text is correct.
- m7. CP-08: the paper's parts do not add up, -90 + 880 = 790 kHz vs the total of 770 kHz (arXiv p.3 L214-215). Add a note. The 10 % tolerances cover it.
- m8. CP-43 `Z0_real` is `extraction: digitized` with no digitize spec. The paper text says only "good matching with 50 Ohm" (p.3 L143-145), so this is a design target. Fix: `extraction: text`, `gate: false`, or digitize Fig. 4(a).
- m9. RF-41 locator "Table II": the paper prints "TABLE I." for both tables (text.md L441 and L533). Add "(printed as a second 'Table I')".
- m10. AC-01 was not re-read by L7b or this audit (mediatum 429, Zenodo 403). The closed form is correct physics. The geometry digits (3.4 m, 0.2 m) rest on R3 alone.
- m11. CP-43 rights say "atlas data GPL-3.0". Only `eo-modulator-atlas/engine/LICENSE` is GPL-3.0, and `data/` and `sims/` carry no licence file. Fix: "same owner; atlas data unlicensed (internal)".
- m12. SM-41 still uses `physics: [coupled-fsi]` + `solid-nonlinear-requested`. The schema now has `solid-nonlinear` (CR-1 adopted). Switch the tag.
- m13. `eval/expected/CP-44.json` `versions` records only python. C8 asks for package versions. Add numpy, pillow, tesseract and pdftoppm (Poppler) versions; the digitization depends on all of them.
- m14. `check_cases.py` compares case sha256 to sidecar sha256 but never hashes the cached file itself, and it does not flag `tolerance.note` without "proposed (assumption)" or a source. Add `sha256(file) == sidecar`.
- m15. DevLog-007 s.8 commands still use `--no-project --with ...`. `validation/pyproject.toml` now has numpy, pillow, matplotlib and pyyaml, so plain `uv run` from `validation/` works (verified). Hortmann 1990 DOI is "N/A (not looked up)": look it up via Crossref.

## 3. Reproducibility (problem statements)

| Case | Rebuildable from the YAML? | Note |
|---|---|---|
| FL-02, FL-41, FL-03, FL-04, FL-43, FL-44, CP-01, CP-07, SM-41 | yes | all inputs stated with sources |
| CP-41 | yes | start-up ramp is a labelled assumption |
| WO-02, WO-41 | yes, with labelled BC / polarization assumptions | WO-41 n_eff depends on the symmetry class: PMC assumption flagged |
| AC-01 | yes (closed form) | frequencies free; source not re-verified (m10) |
| FL-42 | no, to the stated tolerance | S1 |
| CP-42 | partly | S2; Poisson ratio and density missing |
| CP-08 | no | S7 |
| CP-43, CP-44 | geometry yes; materials no | LN constants and BOX thickness (CP-44) unverified; atlas says the config "is not runnable as a literature comparison until..." |
| SM-42 | no, for a quantitative gate | template inputs (S5) |
| RF-41 | yes, with atlas variants | Cu conductivity N/A, bracketed by variants |

Every `missing` item has `{input, assumption}` (checker passes). No unlabelled invented values were found. All assumption numbers are labelled: 300 h outlet, 2 s ramp, 1 um PML, hx/2 fillet, 2 um BOX, 20-25 C. The two locator slips are m5 and m6.

## 4. Tolerances

| Case / target | Gate | Source spread / stated uncertainty | Assessment |
|---|---|---|---|
| FL-02 | abs 0.01 | Ghia vs 601^2 up to 0.011 (B3) | too tight at Re 1000 |
| FL-41 psi, omega | rel 1e-3 | accurate solvers within 0.18 % / 0.14 % (Erturk-Dursun p.8) | ok after Richardson (m2) |
| FL-41 extrema | rel 1e-4 | spectral, 7 digits | ok but demanding |
| FL-03 | rel 1e-3 / 1e-2 | bounds +-0.18 %; Nabh spectral | ok |
| FL-04 c_L_max | bounds 0.99-1.01 | converged 0.9866 | wrong (B1) |
| FL-43 | rel 2e-3 / 5e-3 around FEATFLOW L6 | John 2004 errors <= 1e-4 | wrong reference (B2) |
| FL-44 | rel 2e-3 / 2e-2 | FEATFLOW L4 0.01 % / 0.05 % off | ok |
| CP-07, SM-41 | rel 1e-2 ... 1e-3 | FEATFLOW level spread < 0.8 % | ok |
| CP-41 | rel 2-5 % | two tables differ 2.6-21 % | S3 |
| CP-01 | rel 2e-3 | Hortmann / Le Quere vs dVD 0.1-0.3 % | ok |
| WO-02 | abs 5e-6 | Hadley +-3e-6 | ok |
| WO-41 | abs 1e-7 | Hadley +-1e-8 | ok, demanding |
| CP-42 | rel 5e-3 | own estimate: percent-level | S2 |
| SM-42 | abs 10 um | atlas max(10 um, 10 %) | S4 |
| RF-41 | 0.029 + 5 % | atlas U_thru + width | ok (recomputed) |
| CP-44 digitized | abs 0.13 (= U_k2) | digitization only; no measurement uncertainty | ok as `gate: false` |

## 5. Digitizer

Self-test run as asked, from `validation/`: `nice -n 10 uv run python b/digitize.py --selftest --out <scratch>`, with BLAS threads 2, tesseract and pdftoppm from Homebrew. Result: PASS, 5/5 within U (k = 2), errors +0.0049 ... +0.0121 against U 0.025-0.0325, identical to the lane log. Over all 768 extracted columns (audit script on `selftest.json`), coverage within U is 100 %. The mean error is +0.0085 (0.65 px) with sd 0.0032, so the error is mostly systematic bias.

Uncertainty method review:
- The budget (quantization, half line width / sqrt3, calibration fit RMS + tick localization, x through the local slope) is reasonable and conservative for an isolated stroke. The line-width term dominates (about 70 % of U in the self-test).
- The systematic bias of about 0.65 px is not modelled and uses about 27 % of U in the self-test. Its likely source is a half-pixel convention mismatch between the tick centres and the stroke row-mean. Fix: find the bias with a symmetric synthetic test (thin and thick strokes, both line colours), then correct it or add an explicit u_sys term.
- With 2 calibration pairs, the fit RMS is identically 0 (n - 2 dof = 0). Calibration uncertainty then reduces to tick localization, and a mislabelled tick goes undetected. The pilot Z_m panel calibrated from 60 and 40 only; the visible 50 tick was not used. Fix: require at least 3 pairs, or add a scale-error term when n = 2.
- Overlap underestimation is documented by the lane (Z_m at 40 GHz: U 0.137 vs pixel 0.136 Ohm). Fix: enforce pixel size as a floor in code, not only in prose.
- The self-test covers one renderer, one colour and a smooth curve: it checks consistency, not coverage. Add 2-3 synthetic variants (dashed, overlapping, log axis once supported).
- Overlay `outputs/l7b-digitize/pilot/arabjuneghani2022-fig4-overlay.png` inspected: frames, calibration ticks and sample markers sit on the curves in all three panels.

## 6. Rights

- No paywalled content outside `cache/`. No PDF in the repo outside `cache/`, `node_modules/` and `validation/.venv/`. `cache/`, `outputs/` and `logs/` are gitignored (`.gitignore` L18, L20, L24). No absolute local paths in `validation/b`, `eval/cases/b`, `CP-44.json` or DevLog-007. The digitize spec references the atlas PDF by relative path and does not copy it.
- Licence notes checked: Lethe Apache-2.0, femwell GPL-3.0, INS2D LGPL-3.0 (GitHub API + cached LICENSE), pysph NOASSERTION on GitHub with BSD-3-style text in `LICENSE.txt` (note correct). Arab Juneghani 2022: CC BY 4.0 (Crossref vor + am). Pan 2021: Optica OA licence (Crossref). arXiv preprints: default arXiv licence (not checked per paper). Hron course copy: rights unstated (correctly flagged). One correction: the atlas data licence (m11).
- The cache has 12 MB of sidecar-tracked downloads. The derived `.txt` files have no sidecars (acceptable, since they are derived).

## 7. Runs

| Command (from repo root unless noted) | Result | Log |
|---|---|---|
| `cd validation && nice -n 10 uv run python b/check_cases.py --table` | 20 cases, 0 with errors; exit 0 | `logs/audit-l7b-check-cases-20261106T160327.log` |
| `nice -n 10 node --max-old-space-size=1536 packages/eval/src/cli.ts --class b --dry-run` | 20 cases, 92 targets pending, loader 0 errors, 0 warnings; exit 0; `@amp/physics` unavailable | `logs/audit-l7b-loader-dryrun-20261106T160327.log`, records `logs/eval-20261106T160327.jsonl` |
| `cd validation && nice -n 10 uv run python b/digitize.py --selftest --out <scratch>` | PASS 5/5 | `logs/audit-l7b-digitize-selftest-20261106T160354.log` |

Neither the checker nor the loader can catch B1-B3 or S1-S5. These are reference-choice and tolerance problems that only a source comparison finds.

## 8. Proposed fix order

1. B1, B2: re-reference FL-04 c_L_max (2014 zip) and FL-43 (John 2004). Cache both with sidecars and update DevLog-007 s.4.3 flags 2 and 3 and s.5 #5.
2. B3: relax or re-reference FL-02 Re 1000, citing arXiv cs/0411047.
3. S1, S2, S7: mark FL-42 and CP-08 as not gated or untestable; rework the CP-42 gate.
4. S3: add the second FSI3 table and widen the drag-amplitude gate.
5. S4, S5: fix the SM-42 tolerance encoding and the extraction label.
6. Minor items in one pass, then re-run `check_cases.py` and the loader dry run.
