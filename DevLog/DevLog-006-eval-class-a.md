# DevLog-006: Eval set class a (analytic and textbook)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L7a |
| Status | Hand-off ready (fresh-context audit pending) |
| Owns | `eval/cases/a/**`, `eval/expected/` (class-a files), `validation/pyproject.toml`, `validation/uv.lock`, `validation/README.md`, `validation/a/**`, this file |
| Inputs | DevLog-001 (A12, Q5), CONTRACTS-v0 (C3, C8), R3 (sections 2, 3, 8) |
| Rules | No COMSOL values (Q5). No invented numbers: every value is P (primary page), S (open re-tab) or D (derived here, formula + generator). Synthetic inputs are labelled `synthetic` |

## 1. Plan

1. `validation/` uv project: Python 3.12, numpy, scipy, mpmath, pyyaml. `uv run` only.
2. One YAML per class-a case in R3 s.3 (23 rows labelled a, plus CP-05: R3 labels it c in the table but its count "a 24" and its D basis make it class a; see Contract requests) and the cheap reserve analytic items:
   - NAFEMS LE10 and T1 (only with a live public value locator), Code_Aster SSLV04A analytic, cylinder cavity closed forms (analytic twin of Palace RF-01), 1D quarter-wave Bragg stack (MPB-free closed form).
   - Kovasznay, Poiseuille, Danckwerts, pn junction, Euler, Hertz, Kirsch full field, coax, WR-90, Mie, box modes, slab modes, Helmholtz coil, EOF slit, Carslaw-Jaeger are already R3 class-a rows (or CP-05); they get full field functions where needed.
3. Generators in `validation/a/`: one module per case family, each writes `eval/expected/<ID>.json` with value, generator path, package versions, ISO timestamp, and series precision (terms used, change on doubling) or root-finder tolerance.
4. Recompute every R3 value; record agreement. Resolve R3 s.8 flags that are analytic: HT-02 locator, Palace TM010 digits, dipole impedance.
5. Field functions (Kirsch, Kovasznay, Mie near field, plus Helmholtz off-axis, rigid-sphere pressure, Danckwerts profile, EOF profile) importable and callable through a points-in / values-out CLI for L8.
6. `validation/a/validate_cases.py`: minimal validator for the R3 s.2 schema until L8's loader lands.
7. Summary table, contract requests, hand-off.

## 2. TODO

- [x] uv project (`validation/pyproject.toml`, `uv.lock`)
- [x] Sources fetched for reserve items (SSLV04A, T1, LE10, VM24 geometry, VM63, FV52, FV12, miepython tests)
- [x] Generators + expected JSON (25 files, 167 target values after the audit pass)
- [x] Case YAMLs (29 files)
- [x] Validator passes on all cases (interim validator 29/29; L8 loader 0 errors, 0 warnings); reproducibility check 0/148 differ
- [x] Summary table
- [x] Hand-off
- [x] Fresh-context audit (coordinator): DevLog/audits/2026-11-06-L7a-eval-a-audit.md; corrections in s.7
- [ ] Re-point `spec` to `sims/<id>.yaml` once L2 publishes amp-spec/0 models

## 3. Progress log

- 2026-11-06 15:12 PST: read CLAUDE.md, DevLog-001, CONTRACTS-v0, R3 in full. Plan written.
- 2026-11-06 15:26 PST: validation/ uv project created (Python 3.12.11; numpy 2.5.4, scipy 1.18.1, mpmath 1.4.1, pyyaml 6.0.3). Generators gen_heat, gen_solid, gen_em, gen_optics, gen_misc and fields.py written and run; 24 expected JSON in eval/expected/. Sources fetched (rate-limited, 7 pages): Code_Aster sslv04a.comm (gitlab), Ansys VM24, VM63, VM-NAFEMS FV52, Abaqus v2016 mirror FV12 (pointer only), Altair OS-V T1 and LE10 search, FeenoX mechanical examples, miepython tests/test_mie.py.
- 2026-11-06 15:26 PST: findings so far: WO-03 R3 "x 5.213" is rounded; reference digits hold at x = 2 pi 0.525/0.6328 = 5.2128197 (miepython test_03); Palace cavity table reproduced by 4-decimal Bessel zeros; SM-07 VM24 0.01469 vs closed form 0.014695 (rounding).
- 2026-11-06 15:31 PST: build_cases.py wrote 29 YAML; validate_cases.py 29/29 pass (negative test: altered value, bad dimension, renamed key all caught); run_all.py --check: 148 values compared, 0 differ (logs/l7a-check-20261106T153253.log); fields.py --selftest ok; ruff clean.
- 2026-11-06 15:34 PST: Altair LE10 page opened (target 5.38 MPa magnitude; page cites NAFEMS R0015 by mistake). L8's first loader run over these cases reported 3 errors (prose `tolerance.rule`).
- 2026-11-06 15:35 PST: rules restated in L8's structured form (`rate`, `monotonic` with `of: error`). L8 loader (`node packages/eval/src/cli.ts --class a --dry-run`, read-only use): 29 cases, 0 errors, 0 warnings, 124 targets pending (spec pending). `--adapter expected`: 93 targets pass, 0 value mismatches; 3 rule targets (SM-01, FL-01 rate; RF-04 monotonic) report fail because the adapter feeds one value to a multi-level rule (see Contract requests 8).
- 2026-11-06 16:02 PST: audit corrections applied (s.7). Regenerated: 24 + 1 (SM-06) expected files, 167 target values; `run_all.py --check` 0 differ / missing / stale (logs/l7a-check-20261106T160120.log; the pre-regeneration check correctly flagged the 40 renamed or new ids, logs/l7a-check-20261106T160014.log). Interim validator 29/29. L8 dry run: 29 cases, 136 targets pending, loader 0 errors, 0 warnings (logs/eval-20261106T160158.jsonl). L8 `--adapter expected`: 102 targets pass, 0 fail, 22 pending. ruff clean.

## 4. Results

### 4.1 Files

| Path | Content |
|---|---|
| `validation/a/common.py` | expected-JSON writer, versions, constants (scipy.constants), R3 comparison at R3's digits |
| `validation/a/gen_heat.py` | HT-01 (T4 eigen series), HT-02 (T3, two independent series), HT-03 (T2 root), HT-04 (Carslaw-Jaeger) |
| `validation/a/gen_solid.py` | SM-01 Kirsch field, SM-03, SM-04, SM-07, SM-21 (Lame), CP-21 (T1 inclusion) |
| `validation/a/gen_em.py` | EM-01, EM-04 (elliptic-integral loop field), RF-02, RF-04, RF-21 (cavity) |
| `validation/a/gen_optics.py` | WO-01 slab, WO-03 Mie (BHMIE + vector-harmonic near field), WO-21 Bragg |
| `validation/a/gen_misc.py` | AC-02, AC-03, FL-01, TR-01, SC-01 (incl. exact Poisson-Boltzmann E_max), CP-05 |
| `validation/a/fields.py` | exact-field CLI for L8 (SM-01, FL-01, FL-01-pois, WO-03, EM-04, AC-03, TR-01, CP-05) |
| `validation/a/build_cases.py` | writes `eval/cases/a/*.yaml`; D values read from the JSON (no transcription) |
| `validation/a/validate_cases.py` | interim R3 s.2 validator + YAML/JSON value agreement |
| `validation/a/run_all.py` | regenerate all, or `--check` into a temp dir and compare |

Cases (29): R3 class a HT-01..04, SM-01..07, EM-01, EM-04, RF-02, RF-04, WO-01, WO-03, AC-02, AC-03, FL-01, TR-01, SC-01, CP-02, CP-05 (24); reserve SM-21 (Code_Aster SSLV04A), SM-22 (NAFEMS LE10), CP-21 (NAFEMS T1), RF-21 (cylinder cavity closed forms), WO-21 (quarter-wave Bragg stack) (5). Basis P only (no generator): SM-02, SM-05, CP-02, SM-22 (SM-06 gained a Ritz generator in the audit pass); CP-21 has a P gate plus D bounds. Heroes (R3): SM-01, EM-04, WO-03, AC-02. Reserve items skipped: none of the listed ones; NAFEMS LE2-LE6, FV2-FV32, VM50/120/125/188/191, TTLV01A not attempted (not in the task list).

### 4.2 Flag resolutions (R3 s.8 and new)

| Item | Resolution |
|---|---|
| HT-02 locator | 36.603116 C at x = 0.08 m from the 0 C end, t = 32 s (two series agree to 9e-9 C). FEATool's x = 0.02 m is the same point from the heated end; its t = 36 s gives 36.681301 C. At x = 0.02 m from the 0 C end, T = 0.19 C (36 s) |
| Palace TM010 | x01 c / (2 pi a sqrt(eps_r)) = 2.903636072 GHz (x01 = 2.404825557695773). Palace's 2.903605 is reproduced by x01 rounded to 2.4048. All six Palace analytic-table entries match 4-decimal Bessel zeros within 1.1e-7; exact zeros differ by 1.3e-6 to 1.1e-5. Gate on the exact value |
| Dipole impedance | 73.079010 + j42.515115 Ohm with CODATA eta0 = 376.730313 Ohm (Balanis 4-79 at kl = pi: the radius term multiplies sin(kl) = 0). With eta0 = 120 pi: 73.129602 + j42.544547 Ohm |
| WO-03 size parameter (new) | R3 "x 5.213" is rounded: the reference digits hold at x = 2 pi 0.525/0.6328 = 5.2128197 (miepython test_03_bh_dielectric). At x = 5.213 exactly, Qext = 3.104996 (fails at 5 digits) |
| SM-07 (new) | closed form 0.0146955 rad at M/M_yp = 1.1666 vs Ansys VM24 target 0.01469 (truncated, 3.7e-4 rel). Gate on the closed form |
| SM-21 geometry (new) | SSLV04A radii are in the mesh only; a = 0.1, b = 0.2 recovered uniquely from the test's own ANALYTIQUE values; every VALE_REFE reproduced within 2.4e-6 rel |
| SC-01 eps_r | 11.1 in R3 has no source (Si commonly 11.7-11.9; not verified here). Gate uses 11.7 per R3; listed under `missing` |
| CP-05 class | R3 table labels it c; its D basis and R3's count "a 24" make it a. Filed as `eval/cases/a/CP-05.yaml` |
| HT-01 | NAFEMS 18.3 C is the exact series value 18.253757 C rounded (agrees with advanced-packaging-atlas scikit-fem 18.25375654 to 3e-9) |
| SC-01 E_max | exact equilibrium Poisson-Boltzmann E_max = 0.97248 x depletion value = sqrt(1 - 2 V_T/V_bi) (Sze correction, matches to 6e-10); this is the drift-diffusion gate, W is informative |
| SM-22 | Altair OS-V 0060 states 5.38 MPa (magnitude) and cites NAFEMS R0015 by mistake; sign from FeenoX -5.37968 |

### 4.3 Summary table (D values recomputed here vs R3; P values as cited)

Agreement = |value - R3| <= half a unit in R3's last digit. Rows: every target with an R3 value, else the first two references of the case (SM-06: all D gates). Regenerated after the audit corrections.

| ID | Physics | Target | Value | R3 value | Agreement |
|---|---|---|---|---|---|
| AC-02 | acoustics | f_mode1 | 171.5 Hz | 171.500 | agree, rel 0.0e+00 |
| AC-02 | acoustics | f_mode2 | 214.375 Hz | 214.375 | agree, rel 0.0e+00 |
| AC-02 | acoustics | f_mode3 | 274.5339517 Hz | 274.534 | agree, rel 1.8e-07 |
| AC-02 | acoustics | f_mode4 | 285.8333333 Hz | 285.833 | agree, rel 1.2e-06 |
| AC-03 | acoustics | sigma_over_pia2_ka0.5 | 0.03874356304 1 | n/a | n/a (not in R3) |
| AC-03 | acoustics | sigma_over_pia2_ka1.0 | 0.3216288591 1 | n/a | n/a (not in R3) |
| CP-02 | solid-thermal-stress | sigma_zz_A | -1.05e+08 Pa | P value | basis P (gate) |
| CP-05 | coupled-eof,electrostatics,stokes | u_HS | 0.0003541675128 m/s | 3.5417e-4 | agree, rel 7.0e-06 |
| CP-21 | solid-thermal-stress | sigma_yy_D | 5e+07 Pa | P value | basis P (gate) |
| EM-01 | electrostatics,magnetostatics | C_per_m | 9.325647296e-11 F/m | 93.2565 | agree, rel 2.9e-07 |
| EM-01 | electrostatics,magnetostatics | L_per_m | 2.505525937e-07 H/m | 250.5526 | agree, rel 2.5e-08 |
| EM-01 | electrostatics,magnetostatics | Z0 | 51.83343117 Ohm | 51.8334 | agree, rel 6.0e-07 |
| EM-04 | magnetostatics | B_center | 8.991762855e-06 T | 8.99176 | agree, rel 3.2e-07 |
| FL-01 | laminar-ns,stokes | kovasznay.field_rel_L2_u | 0 1 | n/a | n/a (not in R3) |
| FL-01 | laminar-ns,stokes | kovasznay.v.x0.5_y0.25 | -0.106002969 m/s | n/a | n/a (not in R3) |
| HT-01 | heat-cond,heat-conv | T_E | 18.25375654 degC | 18.3 | agree, rel 2.5e-03 |
| HT-01 | heat-cond,heat-conv | T_E_nafems | 18.3 degC | P value | basis P (info) |
| HT-02 | heat-cond,heat-transient | T_x0.08_t32 | 36.60311596 degC | 36.60 | agree, rel 8.5e-05 |
| HT-02 | heat-cond,heat-transient | T_C_nafems | 36.6 degC | P value | basis P (info) |
| HT-02 | heat-cond,heat-transient | T_x0.08_t36 (not gated) | 36.6813008 degC | 36.68 | agree, rel 3.5e-05 |
| HT-03 | heat-cond,heat-rad | T_B.k55.6.sigma_codata | 927.0039505 K | 927.004 | agree, rel 5.3e-08 |
| HT-03 | heat-cond,heat-rad | T_B_nafems | 927 K | P value | basis P (info) |
| HT-03 | heat-cond,heat-rad | T_B.k55.563.sigma_codata (not gated) | 926.9670882 K | 926.967 | agree, rel 9.5e-08 |
| HT-04 | heat-cond,heat-conv,heat-transient | T_x0.0223_t2000 | 140.4188308 degC | 140.42 | agree, rel 8.3e-06 |
| HT-04 | heat-cond,heat-conv,heat-transient | T_x0.0859_t2000 | 98.85282526 degC | 98.85 | agree, rel 2.9e-05 |
| HT-04 | heat-cond,heat-conv,heat-transient | T_x0.1866_t2000 | 51.76276978 degC | 51.76 | agree, rel 5.4e-05 |
| HT-04 | heat-cond,heat-conv,heat-transient | T_x0.3462_t2000 | 14.45400658 degC | 14.45 | agree, rel 2.8e-04 |
| RF-02 | rf-waveguide,rf-sparams | fc_TE10 | 6557140376 Hz | 6.55714 | agree, rel 5.7e-08 |
| RF-02 | rf-waveguide,rf-sparams | fc_TE20 | 1.311428075e+10 Hz | 13.11428 | agree, rel 5.7e-08 |
| RF-02 | rf-waveguide,rf-sparams | fc_TE01 | 1.475356585e+10 Hz | 14.75357 | agree, rel 2.8e-07 |
| RF-04 | rf-antenna | R_in | 73.07901024 Ohm | 73.079 | agree, rel 1.4e-07 |
| RF-04 | rf-antenna | X_in | 42.51511468 Ohm | 42.515 | agree, rel 2.7e-06 |
| RF-21 | rf-resonator | f_TM010 | 2903636072 Hz | 2.903605 | disagree, rel 1.1e-05 |
| RF-21 | rf-resonator | f_TE111 | 2922197191 Hz | 2.922212 | disagree, rel 5.1e-06 |
| RF-21 | rf-resonator | f_TM011 | 3468175213 Hz | 3.468149 | disagree, rel 7.6e-06 |
| RF-21 | rf-resonator | f_TM110 | 4626480968 Hz | 4.626474 | disagree, rel 1.5e-06 |
| RF-21 | rf-resonator | f_TE211 | 4146881712 Hz | 4.146842 | disagree, rel 9.6e-06 |
| RF-21 | rf-resonator | f_TE011 | 5000146299 Hz | 5.000140 | disagree, rel 1.3e-06 |
| RF-21 | rf-resonator | Q_dielectric | 2500 1 | 2.50e3 | agree, rel 0.0e+00 |
| SC-01 | semiconductor-dd,electrostatics | V_bi | 0.9524228693 V | 0.95242 | agree, rel 3.0e-06 |
| SC-01 | semiconductor-dd,electrostatics | W_0V.epsr11.7 | 4.963145444e-08 m | 49.63 | agree, rel 2.9e-05 |
| SC-01 | semiconductor-dd,electrostatics | W_0V.epsr11.1 (not gated) | 4.834210539e-08 m | 48.34 | agree, rel 4.4e-05 |
| SM-01 | solid-linear | K_t | 3 1 | 3 | agree, rel 0.0e+00 |
| SM-02 | solid-linear | sigma_yy_D | 9.27e+07 Pa | P value | basis P (gate) |
| SM-03 | solid-buckling | F_cr_lbf | 38.55314219 lbf | 38.553 | agree, rel 3.7e-06 |
| SM-04 | solid-contact | a_contact | 0.001009635444 m | 1.00964 | agree, rel 4.5e-06 |
| SM-05 | solid-modal | f_mode4..10 | 45.897, 109.44, 109.44, 167.89, 193.59, 206.19, 206.19 Hz | P value | basis P (gate) |
| SM-06 | solid-modal | f_mode4 | 1.621654379 Hz | n/a | n/a (not in R3) |
| SM-06 | solid-modal | f_mode5 | 2.359496274 Hz | n/a | n/a (not in R3) |
| SM-06 | solid-modal | f_mode6 | 2.922282465 Hz | n/a | n/a (not in R3) |
| SM-06 | solid-modal | f_mode7 | 4.190242765 Hz | n/a | n/a (not in R3) |
| SM-06 | solid-modal | f_mode8 | 4.190242765 Hz | n/a | n/a (not in R3) |
| SM-06 | solid-modal | f_mode9 | 7.356003661 Hz | n/a | n/a (not in R3) |
| SM-06 | solid-modal | f_mode10 | 7.356003663 Hz | n/a | n/a (not in R3) |
| SM-06 | solid-modal | f_modeN.nafems (4..9) | 1.622, 2.360, 2.922, 4.233, 4.233, 7.416 Hz | P value | basis P (info) |
| SM-07 | solid-plasticity | rotation.m1.0.literal | 0.012 rad | 0.01200 | agree, rel 2.9e-16 |
| SM-07 | solid-plasticity | rotation.m1.1666.literal | 0.01469546898 rad | 0.01469 | disagree, rel 3.7e-04 |
| SM-07 | solid-plasticity | rotation.m1.3333.literal | 0.02078253154 rad | 0.02078 | agree, rel 1.2e-04 |
| SM-07 | solid-plasticity | M_yp (not gated) | 2711.635897 N m (= 24000 in-lb) | 24000 in-lb | agree, rel 1.5e-16 |
| SM-21 | solid-linear | DX_A | 5.9e-05 length | n/a | n/a (not in R3) |
| SM-21 | solid-linear | DX_B | 4e-05 length | n/a | n/a (not in R3) |
| SM-22 | solid-linear | sigma_yy_D | -5.38e+06 Pa | P value | basis P (gate) |
| TR-01 | transport-reaction,transport-diffusion | pfr.C_L_over_C0 | 0.3678794412 1 | n/a | n/a (not in R3) |
| TR-01 | transport-reaction,transport-diffusion | danckwerts.C_L_over_C0_Pe1 | 0.4676558815 1 | n/a | n/a (not in R3) |
| WO-01 | optics-modes | neff_TE0 | 2.849489467 1 | 2.849489 | agree, rel 1.6e-07 |
| WO-01 | optics-modes | neff_TM0 | 2.054618547 1 | 2.054619 | agree, rel 2.2e-07 |
| WO-03 | optics-scattering | dielectric.qext | 3.105425531 1 | 3.10543 | agree, rel 1.4e-06 |
| WO-03 | optics-scattering | dielectric.qsca | 3.105425531 1 | 3.10543 | agree, rel 1.4e-06 |
| WO-03 | optics-scattering | dielectric.g | 0.633136758 1 | 0.63314 | agree, rel 5.1e-06 |
| WO-03 | optics-scattering | dielectric.qback | 2.92534065 1 | 2.92534 | agree, rel 2.2e-07 |
| WO-03 | optics-scattering | absorbing.qext | 2.336320985 1 | 2.336321 | agree, rel 6.6e-09 |
| WO-03 | optics-scattering | absorbing.qsca | 0.6634537615 1 | 0.6634538 | agree, rel 5.8e-08 |
| WO-03 | optics-scattering | absorbing.g | 0.1921363959 1 | 0.192136 | agree, rel 2.1e-06 |
| WO-21 | optics-phc | w_lower_over_w0 | 0.7288172322 1 | n/a | n/a (not in R3) |
| WO-21 | optics-phc | w_upper_over_w0 | 1.271182768 1 | n/a | n/a (not in R3) |

Disagreements: RF-21 vs the Palace analytic table (explained in 4.2; R3 already flagged it) and SM-07 at M/M_yp = 1.1666 (VM24 truncation). All other R3 values agree at R3's digits.

### 4.4 Precision records (from the JSON)

- Series: HT-01 400 terms, change on doubling 0 (exponential decay at y = 0.2); HT-02 40 terms (periodic + transient, mpmath 40 digits), 4000-term cross-check series differs by 9e-9 C; WO-03 14 terms (BHMIE), doubling change <= 5e-11; near field 24 terms, doubling change <= 2e-10, tangential-E and normal-D jumps at r = a <= 8.5e-9 rel; AC-03 15-30 terms, doubling change 0, Rayleigh-limit ratio 0.99991 at ka = 0.01, sigma/(pi a^2) = 1.948 at ka = 200, |dp/dr|/k at r = a 7e-10.
- Field self-checks: Kirsch Hooke residual 1.9e-10, equilibrium 1.0e-9 (finite differences); Kovasznay NS momentum residual 5.9e-6, divergence 9.4e-7 (FD step 1e-4, truncation-limited).
- Roots: brentq xtol 1e-13 to 1e-15; WO-01 mpmath 30-digit cross-check differs by <= 4.4e-16.

## 5. Contract requests

1. **amp-eval/0 additions** used in all 29 files (L8 has adopted them as S18-S28 in DevLog-009; the coordinator should fold them into C8/R3 s.2):
   - top level `spec: {status: pending, ref: sims/<id>.yaml, reason}`; `field_reference: {function, fields, complex?}`; `source_case` (SM-21);
   - per reference: `metric_id`, `gate` (default true), `expected: {file, metric_id}` for basis D, `note`;
   - `tolerance.norm`, structured `tolerance.rule` (`rate`, `monotonic` with `of: error`, `note`); `speed.budget_s.native: null` until O3; `speed.budget_basis`.
2. **Expected-JSON format** `amp-eval-expected/0` as in `validation/README.md`; propose L7b/L7c use the same keys.
3. **New IDs**: SM-21, SM-22, CP-21, RF-21, WO-21. Proposed rule against collisions: new reserve IDs use NN 21-39 (class a), 41-59 (b), 61-79 (c).
4. **CP-05 is class a** (`eval/cases/a/CP-05.yaml`); L7c should not also file CP-05.
5. **sims/ ids for L2** (proposals, one per case in `spec.ref`): nafems-t4, nafems-t3, nafems-t2, semi-infinite-convection, kirsch-plate, nafems-le1, euler-column, hertz-sphere, nafems-fv52, nafems-fv12, plastic-hinge, coax-line, helmholtz-coil, wr90-guide, half-wave-dipole, cylinder-cavity, si-slab, mie-sphere, bragg-stack, rigid-box-modes, rigid-sphere-scattering, kovasznay-poiseuille, dispersion-reactor, pn-junction, eo-slit, nafems-le11, lame-cylinder, nafems-le10, nafems-t1.
6. **Field metric interface** (L8 decides): exact fields are Python (`validation/a/fields.py`, JSON points in, JSON values out). Either the Node harness shells out to `uv run` at eval time, or L8 ports the eight closed forms to TS (formulas in the generator docstrings) with the CLI as cross-check. L8's `extract: {kind: field, evaluator, points, params}` (S10) fits the first option; `extract` blocks are not yet written in the cases because the physics output names (C5 `fields[].name`) are not fixed.
7. **Units**: BC temperatures are in K; several targets are in degC (`unit: degC`); SM-21 uses the Code_Aster mesh's own length unit with E in MPa (`unit: length`). L8 needs `degC` and a passthrough for `length`, or SM-21 is restated in SI (one-line change in the builder).
8. **metric_id grammar** (audit M3): `[A-Za-z][A-Za-z0-9_.+-]*` (no spaces, brackets, `/`, `=`, `|`, commas, parentheses). Enforced in `validation/a/common.py` and `validate_cases.py`; proposed for L8's schema `references[].metric_id` and the expected JSON.
9. **L8 expected adapter**: rule targets that need a level or radius sequence (`rate`, `monotonic`) should report pending, not fail, when only the single expected value is available (SM-01 field_rel_L2_stress, FL-01 kovasznay.field_rel_L2_u; RF-04 now gates G_in instead). L8 now reports them pending (adapter run 16:02: 0 fail).

## 6. Hand-off

- State: 29 class-a cases, schema-valid under the interim validator and L8's loader (0 errors, 0 warnings); outputs of all generators reproducible (`cd validation && uv run python a/run_all.py --check`, 0/167 differ, none stale). `status: unvalidated` and `spec: pending` everywhere (no engine run yet).
- To change a case: edit `validation/a/build_cases.py`, run `uv run python a/build_cases.py --force`, then `uv run python a/validate_cases.py`. To change a value: edit the generator, run `a/run_all.py`, then rebuild the cases.
- Open:
  - fresh-context audit of generators and cases;
  - SM-05 in-plane constraint details (Ansys gives only UZ = 0 on the bottom edges); FV12 side length (from R3; figure only) and the basis of the NAFEMS FV12 values;
  - RF-04 MoM is this lane's own solver: an independent finite-radius table (King-Middleton, class b) would cross-check it; EM-04 truncation formula is leading-order analytic, not checked against a numerical solve;
  - CP-21 membrane size has no live public locator (Abaqus deck now 410 Gone; the APA lane read it on 2026-10-20);
  - SC-01 eps_r source; copper-wall Q of the cavity (Pozar Ex. 6.4) not computed here (RF-01 is class c);
  - tolerances are this lane's proposals (rel 1e-3 after Richardson for smooth probes, 1e-4 to 1e-6 for eigenvalues and roots, P values at their quoted digits); speed budgets copy R3's browser estimates (not measured).

## 7. Audit corrections (DevLog/audits/2026-11-06-L7a-eval-a-audit.md)

| Finding | Disposition | Change |
|---|---|---|
| B1 SM-06 in-plane constraint at all nodes locks bending | fixed | Restated as a midsurface plate model (`dimension: 2D`, u_x = u_y = theta_z = 0 on the midsurface); a 3D solid may constrain midsurface nodes only (stated in `geometry.spec.alt_3d`) |
| B2 SM-06 NAFEMS modes 7-9 0.8-1.0 % above converged thin plate | fixed | New generator `gen_solid.py::sm06`: Rayleigh-Ritz Kirchhoff free plate, Chebyshev tensor basis (own code; the auditor's script uses Legendre), levels 10/14/18/22/26 per direction, change between the two finest <= 2.1e-8 Hz. Modes 4-10: 1.62165, 2.35950, 2.92228, 4.19024 (x2), 7.35600 (x2) Hz, equal to the auditor's values at his 4 decimals. Gated D targets at rel 2e-3 after Richardson; NAFEMS values kept as `f_modeN.nafems`, `gate: false`, rel 1.5 %, with a note |
| S1 RF-21 mode identification, n, TE011/TM111 degeneracy | fixed | `cavity_mode_table` enumerates TE/TM (m, n, p) to 5.3 GHz with multiplicity and 3D index; each target's `definition` carries family, m, n, p, multiplicity, 3D index range and the degenerate partner; `study.n` 16 (3D) or per-m solves m = 0, 1, 2; classifier written into `study.settings` |
| S2 EM-04 tolerances vs truncation | fixed | Generator adds the dipole-image truncation shift (A_phi = 0: -1.398 (R/R_b)^3; H_t = 0: +0.699 (R/R_b)^3 of B0), for R_b = 10, 20, 30, 100 R. Requirement: exact open BC or R_b >= 30 R (5.2e-5 B0). B_rho tolerance now abs 9e-10 T (1e-4 B0); uniformity `gate: false`; truncation at 30 R recorded as informative |
| S3 RF-04 unbounded monotonic rule | fixed | New finite-radius reference: Hallen MoM, exact tube kernel, triangle basis, delta gap (`gen_em.py::hallen_dipole`), N = 200/400/800, observed order 0.93-1.00, Richardson correction <= 0.18 %, quadrature check <= 1.4e-7. Gated targets: input conductance G_in at a = lambda/100, lambda/300, lambda/1000 (8.2993, 8.4459, 8.8085 mS), rel 3e-2. Susceptance diverges like ln N with a delta gap (recorded, never gated); thin-wire R_in, X_in, G_in informative. Geometry now gives lambda = 1 m, radii, gap <= 2a |
| S4 SM-07 factor 2 under half symmetry | fixed | Definition: relative rotation of the two end sections of the full 10 in beam (half model: 2 x end rotation vs the mid-span plane); load application stated (plane end section, moment at centroid); 1.5 removed from the load list (collapse limit) |
| S5 WO-03 absorbing sub-case not runnable | fixed | Synthetic radius lambda/(2 pi) = 100.7 nm at lambda = 632.8 nm (same frequency as the dielectric sub-case); eps_r under both time conventions stated |
| S6 SC-01 eps_r unsourced | fixed (as assumption) | Ioffe NSM page failed TLS; no primary fetched. eps_r 11.7 labelled an assumption; sensitivity recorded (11.9: E_max -0.84 %; V_bi independent) |
| S7 FL-01 element assumption | fixed | `study.settings.element_assumed_by_tolerances: Taylor-Hood P2/P1`; Poiseuille tolerances `after: finest` with a note for other elements |
| M1 CP-05 units and labels | fixed | `c0_unit: mol/m^3`; all inputs labelled synthetic, R3's own caveat quoted |
| M2 AC-03 definition | fixed | Formula and normalization in `definition` |
| M3 metric_id grammar | fixed | Renamed (HT-03, SM-07, WO-03 near field, FL-01 probes, SC-01); grammar enforced in generator and validator; contract request 8 |
| M4 eigen shift 0 with null spaces | fixed | SM-05, SM-06, AC-02 shift -1 (rad/s)^2; RF-02 5 GHz (below TE10); SM-03 note (buckling has no null space) |
| M5 VM URL locators | fixed | VM24, VM28, VM63, VM127 URLs in material sources / reference_results |
| M6 SM-22 unversioned Altair URL | fixed | 2021 versioned URL (content read on the unversioned page; noted) |
| M7 SM-22 verbatim Altair sentence | fixed | Paraphrased |
| M8 CP-21 hot-spot radius source | fixed | Added to `missing` |
| M9 SM-04 Richardson on contact | fixed | `after: finest`, 0.5 % kept |
| M10 RF-02 mixed 2D/3D targets | deferred | Recorded in RF-02 `assumptions`; split when L2 models land |
| M11 run_all --check stale targets | fixed | Compares key sets both ways and flags class-a expected files no generator writes; verified on the rename (40 flagged before regeneration, 0 after) |
| M12 DevLog SM-07 M_yp units | fixed | Row shows N m and in-lb |
