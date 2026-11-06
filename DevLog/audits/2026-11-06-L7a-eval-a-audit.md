# Audit: L7a eval class a (2026-11-06)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Auditor | fresh-context audit subagent (no prior conversation) |
| Target | `eval/cases/a/*.yaml` (29), `eval/expected/*.json` (24 class-a), `validation/` (pyproject, `a/`), `DevLog/DevLog-006-eval-class-a.md` |
| Context read | `CLAUDE.md`, `DevLog/contracts/CONTRACTS-v0.md` (C8 + changelog), `eval/schema/amp-eval-0.schema.json`, R3 (`DevLog/research/2026-11-06-R3-eval-set-sources.md`) |
| Files changed | this file only. Side effects of the runs: `logs/l7a-check-20261106T154055.log` (run_all --check), `logs/eval-20261106T154851.jsonl` and `logs/eval-20261106T154851-summary.md` (L8 loader dry run) |
| Scratch | `<session-scratchpad>/audit/` (`recompute.py`, `recompute_out.txt`, `fv12_ritz.py`) |

## Verdict

The closed-form values are correct: 107 values across all 24 basis-D files re-derived independently, worst relative difference 1.6e-11. Reproducibility passes. Two blocking problems are in SM-06 (NAFEMS FV12): the in-plane constraint as written locks bending in a 3D solid, and the NAFEMS targets for modes 7-9 sit 0.8-1.0 % above the converged thin-plate solution, so a correct solver would fail the 0.5 % gate. Seven significant problems are about how runnable the cases are and whether their tolerances make sense (RF-21 mode identification, EM-04 tolerances and truncation, RF-04 rule, SM-07 rotation definition, WO-03 absorbing sub-case, SC-01 eps_r, FL-01 element assumption). The rest are minor.

## 1. Physics re-derivation (independent)

Method: own script (`recompute.py`, `uv run --no-project --with numpy --with scipy --with mpmath`). Written from the formulas without reading `validation/a/gen_*.py`. It reads `eval/expected/*.json` only to compare. The routes differ from L7a's where L7a documents its method:

| Case | Physics | Audit route | Result |
|---|---|---|---|
| HT-01 | heat, steady | 2000-term separation of variables (own eigen roots) | 5.8e-16 |
| HT-02 | heat, transient | lifting x/L f(t) + sine series with exact ODE solution, 2e5 terms (L7a: periodic + transient) | 1.9e-15 (both t = 32 s and 36 s) |
| HT-03 | heat, radiation | brentq, scipy CODATA sigma | 0 |
| HT-04 | heat, semi-infinite | mpmath erfc closed form | <= 3.3e-15, 4 depths |
| SM-01 | solids, Kirsch | Kirsch stresses + Barber displacement, plane stress kappa = (3-nu)/(1+nu); Hooke check by finite differences 3.9e-11 | 0 (K_t, hoop, u_x(L,0), u_y(0,L)) |
| SM-03 | solids, buckling | pi^2 E I / L^2, scipy psi/inch/lbf | 0 |
| SM-04 | solids, Hertz | rigid plane, E* = E/(1-nu^2) | 0 (a, p0, delta) |
| SM-07 | solids, plasticity | M/M_yp = 1.5 - 0.5 (kappa_y/kappa)^2 | <= 1.7e-16 |
| SM-21 | solids, Lame | plane stress (free ends); plane strain would give DX_A = 5.72e-5, not 5.9e-5 | 0, 6 targets |
| CP-21 | thermal stress | E alpha dT / 2; free disk x (1 + (a/b)^2) | 1.5e-16 |
| EM-01 | electrostatics/magnetostatics | 2 pi eps / ln(b/a), mu0/(2 pi) ln(b/a), scipy CODATA | <= 1.4e-16 |
| EM-04 | magnetostatics | direct Biot-Savart quadrature, 4000 segments per loop (L7a: elliptic integrals) | <= 1.7e-12 (B0, B_z, B_rho probes, uniformity scan) |
| RF-02 | RF waveguide | c/(2a), c/a, c/(2b); -beta L wrapped | <= 6.8e-16 |
| RF-04 | RF antenna | eta0/(4 pi) Cin(2 pi), eta0/(4 pi) Si(2 pi), mpmath, eta0 = mu0 c | 6.0e-13 |
| RF-21 | RF resonator | scipy jn_zeros/jnp_zeros, 6 modes | 0 |
| WO-01 | optics, slab | own TE/TM dispersion root | <= 1.6e-16 |
| WO-03 | optics, Mie | own mpmath (30 digits) a_n, b_n, d_n; |E(0)|^2 = |d1|^2 derived; on-axis and x-axis scattered field from M_o1n, N_e1n at phi = 0 | <= 1.6e-11 (qback), all 12 targets including 4 near-field probes |
| WO-21 | optics, PhC | 1 +- (2/pi) asin(dn/sum n); transfer-matrix root cos(K Lambda) = -1 | 0 |
| AC-02 | acoustics | enumeration of (l, m, n) | 0, 10 modes, ordering correct |
| AC-03 | acoustics | j_n'/h_n' partial waves; sigma/(pi a^2) = 4/(ka)^2 sum (2n+1)|A_n|^2; |f(pi)| = 2/(ka) |sum (-1)^n (2n+1) A_n| | <= 5.1e-16 |
| FL-01 | fluids | Kovasznay lambda; zero-mean p by quad; Poiseuille | 0 |
| TR-01 | transport | Danckwerts closed form and an independent profile route (mpmath) | <= 2.7e-15 |
| SC-01 | semiconductor | V_bi; W; exact first integral with both carriers | <= 2.0e-16 |
| CP-05 | coupled EOF | u_HS, lambda_D (1:1, c0 = 1 mol/m^3), cosh profile mean and centre | 0 |

Material spot checks: SiO2 Malitson at 1.55 um = 1.4440236217 vs the case's 1.444023622 (2e-10). Si Salzberg-Villa (refractiveindex.info coefficients) = 3.4777237562 vs 3.477723756 (2e-10).

I found no wrong formulas, unit errors or CODATA errors. Plane stress vs plane strain is right in SM-01, SM-02, SM-21 and CP-21. For SM-21, Code_Aster's own title is "CYLINDRE CREUX EN CONTRAINTES PLANES". Mode ordering is right in AC-02 and RF-02. For RF-21 see S1.

The flag resolutions in DevLog-006 s.4.2 also hold:
- HT-02 locator: the Altair T3 page says "0.08 m from point A", t = 32 s, 36.60 C. It does not say which end is heated, so the series fixes it.
- RF-21 Palace rounding: the Palace table (fetched) lists 2.903605 GHz.
- RF-04 dipole value.
- WO-03 size parameter.
- SM-07 VM24 truncation.

## 2. Findings

### Blocking

**B1. SM-06 boundary condition locks plate bending in a 3D solid.**
- Evidence: `SM-06.yaml` sets `dimension: 3D` with `selection: all nodes, type: constraint, fixed: [ux, uy]`. In a solid, bending needs in-plane displacement that varies through the thickness (u = -z w_x), so pinning u_x = u_y at every node suppresses flexure. The Abaqus FV12 page (fetched 2026-11-06) says the constraint applies "at all nodes" for shells and that "continuum shell meshes use equation constraints to provide equivalent midsurface kinematic constraints".
- Fix: either restate as a shell/plate model (2D Kirchhoff or Mindlin, midsurface u_x = u_y = theta_z = 0), or keep 3D and constrain only the midsurface in-plane displacement, e.g. mid-plane nodes or a through-thickness average equation. Write the chosen form into `bcs`.

**B2. SM-06 NAFEMS targets for modes 7-9 disagree with the converged thin-plate solution by more than the gate tolerance.**
- Evidence: my Rayleigh-Ritz Kirchhoff free square plate (`fv12_ritz.py`, Legendre basis, N = 14/18/22 all identical to 4 decimals; E 200 GPa, nu 0.3, rho 8000, t 0.05, a 10 m) gives:

  | Mode | Ritz (Hz) | NAFEMS (Hz) | NAFEMS - Ritz |
  |---|---|---|---|
  | 4 | 1.6217 | 1.622 | 0 % |
  | 5 | 2.3595 | 2.360 | 0 % |
  | 6 | 2.9223 | 2.922 | 0 % |
  | 7, 8 | 4.1902 | 4.233 | +1.0 % |
  | 9 (10) | 7.3560 | 7.416 | +0.8 % |

  The Ritz eigenvalues lambda^2 = 13.468, 19.596, 24.270, 34.80, 61.09 match the Leissa free-plate values as I remember them; I did not fetch Leissa. At t/a = 0.005, shear deformation lowers the frequencies only negligibly, so it cannot close a +1 % gap. The case tolerance is `rel: 0.005, after: richardson`, so a converged correct solver would fail modes 7-9.
- Fix: add basis-D targets from a documented Ritz series (generator + JSON) and gate on them. Set the NAFEMS P values to `gate: false`, or widen them to >= 1.5 %, with a note. Record that the NAFEMS basis for FV12 is unknown. Abaqus's own table on the same page shows S4R at 4.265 and 7.880, above both.

### Significant

**S1. RF-21 needs mode identification; n = 8 does not reach the gated modes in 3D; TE011 is exactly degenerate with TM111.**
- Evidence: the spectrum above 2.5 GHz (audit, matches the fetched Palace table) is:

  | Mode | f (GHz) |
  |---|---|
  | TM010 | 2.903636 |
  | TE111 (x2) | 2.922197 |
  | TM011 | 3.468175 |
  | TE211 (x2) | 4.146882 |
  | TE112 (x2) | 4.396663 |
  | TM110 (x2) | 4.626481 |
  | TM012 | 4.776992 |
  | TE011 | 5.000146 |
  | TM111 (x2) | 5.000146 |

  In 3D, TE011 is about the 11th-14th eigenvalue, beyond `n: 8`. In 2D-axisym "per m", the targets do not state m. TE011 and TM111 share the same frequency, so gating TE011 needs a field-type classifier.
- Fix: add `m` and `family: TE|TM` per target. Use n >= 14 for 3D. Define the classifier, e.g. TE0n: E_rho = E_z = 0, or E_phi dominant with m = 0.

**S2. EM-04 tolerances are inconsistent, and the allowed truncation is too small.**
- Evidence:
  - B_rho at the probe is -8.35e-9 T = 9.3e-4 B0. Its `rel: 0.01` demands an absolute accuracy of 8e-11 T = 9e-6 B0.
  - The uniformity metric (1.14e-4) at `rel: 0.05` demands 5.7e-6 B0.
  - B_center is only `rel: 1e-3`.
  - The geometry allows "sphere or cylinder radius >= 10 R" as the open boundary. My estimate (not computed in a script) is that a flux-tangent wall at R_b = 10 R adds a near-uniform image field of order mu0 I R^2/R_b^3, i.e. about 1e-3 B0. That is comparable to the B_center tolerance and about 100x the B_rho and uniformity tolerances. Richardson extrapolation does not remove truncation error.
- Fix: state the B_rho and uniformity tolerances as `abs` in units of B0, or mark them `gate: false`. Require a Kelvin transform or infinite elements, or R_b >= 30 R, and add a truncation-sensitivity note. Better, compute the truncation error with the generator for the chosen R_b.

**S3. RF-04 gate is only a monotonic-error rule.**
- Evidence: R_in has `rule: {type: monotonic, of: error}` over three radii with no bound. A solver with errors of 30/20/10 % passes. X_in is `gate: false` with `rel: 0.1` and no radius or gap. Delta-gap reactance depends on the gap width, which is unspecified.
- Fix: specify the gap width and the radius list in `geometry`. Add a bound at the thinnest radius once a finite-radius reference exists (King-Middleton or Hallen tables, class b, as the case itself notes). Until then, label the case "trend only" in `hero`/`note`.

**S4. SM-07 rotation definition is ambiguous under the half model.**
- Evidence: geometry is the full beam (L = 0.254 m) with `symmetry: half (mid-span)`. The target is "end-to-end rotation over L" = kappa x 10 in. With the half model, the end rotation relative to mid-span is kappa x 5 in, a factor of 2. Also:
  - The moment application (rigid end vs linear traction) is not stated.
  - `bcs.values_over_Myp` lists 1.5 but `study.values` does not.
- Fix: define theta = relative rotation of the two end sections of the full 10 in beam (= 2 x half-model end rotation). State the load application. Remove 1.5 or mark it as the collapse limit, not a load step.

**S5. WO-03 absorbing sub-case is not runnable as stated.**
- Evidence: `absorbing: {size_parameter: 1.0, note: only x matters}`. There is no radius and no frequency, and `f_list` has only the dielectric frequency. The absorbing targets (qext, qsca, qabs, g) are gated.
- Fix: give a radius and wavelength labelled synthetic, e.g. lambda = 632.8 nm and a = lambda/(2 pi). Add the f_list entry. State eps for the engine's time convention: (1.5 + 1i)^2 under e^{-i omega t}, conjugate under e^{+j omega t}.

**S6. SC-01 eps_r = 11.7 has no source (hard rule: every value sourced or N/A).**
- Evidence: `materials.Si.source: "eps_r 11.7 per R3, source to verify"`. R3 cites Hu for formulas only. The gated E_max scales as eps_r^-1/2, so 11.7 vs 11.9 is 0.85 %, above the 1e-3 tolerance. The JSON already carries 11.9 variants.
- Fix: cite a primary table (e.g. the Sze & Ng appendix or Hu's own constant, after fetching it), or relabel 11.7 as `synthetic` explicitly. N_A, N_D and n_i are R3/Hu textbook inputs and are fine as synthetic.

**S7. FL-01 Poiseuille tolerances assume Taylor-Hood P2.**
- Evidence: `poiseuille.u_max` and `flow_rate` use `rel: 1e-6` with the provenance "P2 velocity is exact". An equal-order stabilized element or P1-bubble (Mini) element will not reach 1e-6 on a coarse mesh, which turns an element-choice difference into a fail.
- Fix: add `after: richardson` or `finest`. Alternatively, state the element requirement in `study.settings` and keep 1e-6 only for P2.

### Minor

**M1. CP-05 inputs.**
- `c0: 1.0` has no unit in the YAML; "1 mol/m^3" appears only in the JSON locator.
- eps_r 80 and eta 1e-3 are attributed to "R3 s.3.10", but R3 itself says "Wikipedia re-tab; not fetched".
- Fix: add `unit: mol/m^3` and label all four inputs synthetic.

**M2. AC-03 metric definition missing.**
- `|f(pi)|` "backscatter form function" gives no formula, and normalizations differ by a factor of 2 between texts.
- Fix: add `definition: 2/(ka) |sum (-1)^n (2n+1) j_n'(ka)/h_n'(ka)|`. My recompute matched with this form.

**M3. metric_id strings are fragile.**
- Some ids contain spaces, brackets, `/`, `=`, `|`, e.g. `T_B[k = 55.6 W/(m K); sigma CODATA]`, `rotation_M/Myp=1.1666[literal]`, `dielectric.near.|E|^2[z=+1.5a]`.
- They work in the L8 loader, but they are awkward as CLI arguments and file keys and in JSONL greps.
- Fix: use slug ids and keep the description in `definition`.

**M4. Eigen shift 0.0 with zero modes.**
- SM-05 and SM-06 have rigid-body modes, AC-02 has the constant-pressure mode, and a curl-curl RF-02 has a gradient null space. A shift-invert at exactly 0 is singular.
- Fix: use a small negative shift (solids, acoustics) or a positive shift below the first cutoff (RF-02).

**M5. Ansys VM targets lack URL locators.**
- HT-04 (VM28), SM-03 (VM127), SM-04 (VM63) and SM-07 (VM24) cite the VM by name only.
- Fix: add `ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM<nn>.html`. All four returned HTTP 200 on 2026-11-06.

**M6. SM-22 Altair LE10 locator is unversioned.**
- `help.altair.com/hwsolvers/...` will drift.
- Fix: pin a versioned URL (2021/2022/2023 as for T1/T3/T4/LE11).

**M7. SM-22 quotes Altair verbatim.**
- The provenance quotes one sentence verbatim from an all-rights-reserved Altair page ("All results are normalized with the target value (5.38 MPa)").
- Risk is low (a factual locator), but `forbidden: copy_text` is set.
- Fix: paraphrase.

**M8. CP-21 geometry sources.**
- The `missing` field covers the 10 x 10 quarter membrane but not the hot-spot radius 1.0. The Altair T1 page (fetched) states neither.
- The D bounds (50.0-50.5 MPa) bracket the effect, so the 1.5 % gate is safe.
- Fix: add the radius to `missing`.

**M9. SM-04 Richardson on contact.**
- Richardson extrapolation is unreliable for frictionless contact (non-smooth convergence at the contact edge).
- The 0.5 % band itself is supported by VM63: Ansys reports 1.011 mm vs target 1.010, while the closed form is 1.00964 mm, so Ansys is +0.14 %.
- Fix: change to `after: finest` and keep 0.5 %.

**M10. RF-02 mixes 2D and 3D targets.**
- S21 and S11 targets sit in a `dimension: 2D` case. They are gate:false, which is fine for now.
- Fix: split the 3D S-parameter variant into its own case or sub-spec when L2 models land.

**M11. run_all.py --check compares only targets present in the regenerated files.**
- It would not flag stale extra targets left in `eval/expected/`.
- YAML/JSON drift is covered separately by `validate_cases.py`, which passes 29/29.
- Fix: also compare the target key sets.

**M12. DevLog-006 s.4.3 row SM-07 M_yp mixes units.**
- The row shows "2711.6 N m" against R3 "24000" (in-lb) and labels it agree. This is cosmetic.
- Fix: show both units.

## 3. Tolerances (summary)

Defensible as set:
- 1e-3 after Richardson for smooth probes.
- 1e-4 to 1e-6 for closed-form eigenvalues and roots: AC-02, RF-02, RF-21, WO-01, WO-21, HT-03 (1D P1 is exact for the linear part).
- SM-21 rel 1e-3, versus Code_Aster's own 1e-3 on DX and 1-2 % on nodal stresses for a linear 3D mesh.
- P values at their quoted digits: SM-02 1 %, SM-22 1 %, CP-02 1 %.
- SM-05 FV52 at 0.5 % (5 significant figures quoted; not cross-checked here).

Need a rule or a change: SM-06 (B2), EM-04 B_rho and uniformity (S2), RF-04 (S3), FL-01 Poiseuille (S7), SM-04 Richardson (M9).

Rule-based field targets are reasonable proposals (SM-01 stress L2 rate >= 1, FL-01 velocity L2 rate >= 2). Per the C8 changelog, the adapter reports single-value runs of these as pending.

## 4. Locator spot checks (fetched 2026-11-06, about 3 s apart)

| Locator | Case | Status | Content check |
|---|---|---|---|
| Ansys VM28 Hlp_V_VM28.html | HT-04 | 200 | k 54, rho 7833, c 465, h 50, 0 -> 1000 C, 2000 s; targets 140.0/98.9/51.8/14.5 at Y = .9777/.9141/.8134/.6538, i.e. depths 0.0223/0.0859/0.1866/0.3462 m; Holman 4th ed. p. 106. Matches |
| Ansys VM63 Hlp_V_VM63.html | SM-04 | 200 | R 8 mm, E 1000 N/mm^2, nu 0.3, F = 30 x 2 pi N; target a = 1.010 mm (Ansys 1.011); load application not stated. Matches |
| Ansys VM-NAFEMS Hlp_V_VMC5.html | SM-05 | 200 | FV52 (modified), 10 x 10 x 1 m, E 200 GPa, nu 0.3, rho 8000; UZ = 0 on the 4 bottom edges; modes 4-10 values match exactly |
| Palace docs cylinder.md (raw GitHub) | RF-21 | 200 | a 2.74 cm, d = 2a, eps_r 2.08, tan d 4e-4; analytic table matches R3 and confirms TE011 = TM111 = 5.000140 GHz; Q_d 2.50e3; Apache-2.0 |
| FeenoX mechanical.html | SM-02, SM-22, CP-02 | 200 | LE1 "reference is 92.7" (FeenoX 92.7011); LE10 -5.37968 MPa (the page itself gives no reference value); LE11 T = sqrt(x^2 + y^2) + z, -105.04 MPa. Matches |
| Code_Aster astest/sslv04a.comm (GitLab raw) | SM-21 | 200 | E 200000, NU 0.3, PRES 60; MODELISATION 3D, title "CONTRAINTES PLANES"; DX(A) VALE_REFE 5.9e-5, DX(E) 4.17193e-5, SIXX(A) -60, SIYY(A) 100, ANALYTIQUE; GPL-3.0-or-later. Matches |
| Abaqus v2016 mirror ch04s04anf18.html | SM-06 | 200 | thickness 0.05, E/nu/rho match; side length absent (figure); constraint is an image; NAFEMS row RBM, 1.622, 2.360, 2.922, 4.233, 4.233, 7.416, N/A (modes 1-3, 4-10). Matches the case; see B1, B2 |
| Altair OS-V 0100 (T1) | CP-21 | 200 | E 100e3 MPa, nu 0.3, alpha 1e-5 (hot spot) / 0 (rest), 100 C, target 50 MPa; geometry not stated |
| Altair OS-V 0110 (T3) | HT-02 | 200 | k 35, cp 440.5, rho 7200; 0.08 m from A, 32 s, 36.60 C; heated end not stated |
| Altair T4, LE11 (2023), LE10 (unversioned); CalculiX forum T2; Ansys VM24, VM127 | various | 200 (HTTP status only) | not content-checked |
| abaqus-docs.mit.edu (NAFEMS benchmark map) | CP-21, R3 | **410 Gone** | dead, already flagged by L7a and R3 |

## 5. Reproducibility

- `cd validation && nice -n 10 uv run python a/run_all.py --check`: "compared 148 target values; 0 differ or are missing", exit 0, wall 1.0 s, log `logs/l7a-check-20261106T154055.log`.
- `uv run python a/validate_cases.py`: 29 pass, 0 fail.
- `uv run python a/fields.py --selftest`: ok.
- L8 loader `node packages/eval/src/cli.ts --class a --dry-run`: 29 cases, 124 targets pending, loader 0 errors, 0 warnings (records `logs/eval-20261106T154851.jsonl`).

## 6. Rights

- No COMSOL files, runs or values in the cases, generators or expected JSON. `grep -i comsol` hits only the DevLog rule line.
- None of the EM-01/EM-04/TR-01/WO-03 parameters trace to third-party model files; they are labelled synthetic or come from miepython/BH.
- The rights blocks are accurate per source:
  - NAFEMS: paid, values cited via vendor or open pages.
  - Ansys/Altair: all rights reserved, values and formulas only.
  - Code_Aster: GPL-3.0-or-later.
  - Palace: Apache-2.0.
  - miepython: MIT.
  - dolfinx-tutorial: CC BY 4.0, `copy_with_attribution`.
  - Hu: formulas only.
  - Abaqus mirror: rights unclear, used as a pointer only.
- Copied text: one short verbatim Altair sentence in SM-22 provenance (M7). Elsewhere there are only short factual locator fragments, e.g. FeenoX "reference is 92.7", which is GPL.

## 7. Proposed fix order

1. B1 and B2 (SM-06): restate the constraint; add a Ritz D generator and gate on it.
2. S1, S2, S5: make RF-21, EM-04 and WO-03 runnable and their gates consistent.
3. S3, S4, S6, S7: definitions and sources.
4. Minor items in one builder pass (`build_cases.py --force`, then `validate_cases.py` and `run_all.py --check`).
