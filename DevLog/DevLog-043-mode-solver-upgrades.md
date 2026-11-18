# DevLog-043: mode solver upgrades: loss, PML / leaky modes, bends, material dispersion (lane S2, chunk 1, DevLog-037 B2)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | S2 (em-modes upgrades) |
| Owns | `packages/physics/src/modes/**`, `packages/physics/src/couplings/photonic.ts` (only if dispersion needs it), new `packages/physics/test/modes-*.test.ts`, new `validation/modes2/**`, this file; shared: the `em-modes` registration entry and its RESULT_NAMES entry in `registrations.ts` (Edit on a fresh read) |
| Inputs | CLAUDE.md; DevLog-037 s.3 (row S2); DevLog-010 (em-modes); DevLog-032 (O2, O3); DevLog-041 (T4 plan: `kappa`, dispersion helper); CONTRACTS-v0 C4 / C5; `modes/index.ts`, `modes/vector-mode.mjs`, `modes/coupled.ts`, `prepare.ts` (read only) |

Conventions: F = fact read from code or a source; E = estimate; D = decision; O = open item; R = request to the coordinator.

## 1. Baseline (F, 2026-11-18 08:52 PST)

- `em-modes` spec route: per-domain real eps from `n` (eps = n^2) or `eps_r`; uniaxial via `settings.crystals`; PEC / PMC walls; n_g from the energy (Hellmann-Feynman) form with eps_g = eps (non-dispersive). The kernel already has a complex-symmetric path (`epsIm`, ComplexLDLT, realified Arnoldi) and reports `lossDbPerM_<k>`, but `problemFromContext` never sets `epsIm`.
- Material property `kappa` (extinction coefficient, N = n + i kappa, e^{-i omega t}, kappa >= 0 = loss) is already registered by `@amp/materials` (T4). `prepare.ts` resolves for em-modes only `n`, `eps_r` (NEEDS), plus every override key. So a material override `{n, kappa}` reaches `ctx.materials` today; a library `kappa` needs prepare to ask for it (R1).
- Regression baseline: 9 sims with em-modes (`hadley-rib-wo02`, `hadley-square-core`, `hadley-square-hole`, `si-microheater-to`, `si-rib-waveguide`, `si-slab-te0`, `si-slab-tm0`, `si-strip-te0`, `tfln-mzm-eo`), prepareRun + runStudy, all scalars and per-field sum of squares written to `<scratch>/regress-before.json` (peak RSS 0.72 GB, 16 s total). Eval cases: WO-01 = si-slab-te0 / -tm0, WO-02 = si-rib-waveguide, WO-65 = si-strip-te0, CP-43 = tfln-mzm-eo, H11 = si-microheater-to; WO-41 has no sim (pending).
- tfln-mzm-eo n_g_0 = 2.22623 (non-dispersive) vs CP-43 paper-simulated 2.276 (tol 0.05).

## 2. Plan (written 2026-11-18 09:00 PST, before coding)

### 2.1 Formulation (kernel, `vector-mode.mjs`)

The kernel pencil (EO DevLog-025, unknowns e_t = beta E_t, e_z = -j E_z, e_t' = e_t + grad e_z) with mu = 1 is
A' = [S_tt - k0^2 T_eps, k0^2 G_eps; k0^2 G_eps^T, -k0^2 S_eps], B' = [T_tt, 0; 0, -k0^2 T_zz(eps_zz)], A' x = -beta^2 B' x.
Re-deriving it with a diagonal relative permeability mu = diag(mu_x, mu_y, mu_z) (bilinear, unconjugated weak form of curl(mu^-1 curl E) = k0^2 eps E, test field with the adjoint z dependence) gives the same pencil with two weights:
- curl-curl block S_tt weighted by nu_zz = 1 / mu_z;
- B' transverse mass T_tt weighted by nu~ = diag(1 / mu_y, 1 / mu_x) (the transverse part of curl E is (grad E_z + j beta E_t) x z, so the x component of e_t' meets mu_y and vice versa).
Both blocks stay linear in (eps, nu), so complex coefficients are assembled as two real assemblies (real parts, imaginary parts) into the existing complex-symmetric path. With nu absent the old code runs unchanged (separate branch, bitwise identical).

Coordinate transforms enter as material tensors (transformation optics: for an orthogonal map with metric factors (h_x, h_y, h_z), eps'_i = eps_i h_x h_y h_z / h_i^2, same for mu; off-diagonal eps'_xy = eps_xy h_z):
- PML (complex coordinate stretching x~ = x0 + int s_x dx): h_x = s_x, h_y = s_y, s(xi) = 1 - j a (xi / d)^p for depth xi in a layer of thickness d (time convention exp(+j omega t), so outgoing exp(-j k x) decays). a (strength, default to be set by the gates) and p (default 2) are numerical modelling choices, not physical values. Stretching is evaluated at the triangle centroid (piecewise-constant PML).
- Bend (`metric` model, default): the bend lies in the x-z plane, the bend axis is parallel to y, the centre of curvature is at x = x0 - R (R > 0: outer side of the bend at +x; R < 0: centre at x0 + |R|, outer side at -x). With arc length s = R phi along the reference radius |R| (at x = x0), h_z = h = 1 + (x - x0) / R = r / |R|. This is the exact equivalent straight waveguide of a cross-section rotated about the y axis (Maxwell's equations in the local cylindrical frame; transformation-optics form, e.g. D. M. Shyroki, IEEE Trans. Microw. Theory Tech. 56, 414 (2008), doi 10.1109/TMTT.2007.914636, cited for the method, not read in this lane). n_eff = beta / k0 is referenced to the radius |R| (arc length at x = x0). Inside a PML h is continued analytically, h = 1 + (x~ - x0) / R with the complex stretched coordinate.
- Bend (`conformal` model): Heiblum and Harris, IEEE J. Quantum Electron. QE-11, 75 (1975), doi 10.1109/JQE.1975.1068563 (cited for the method; not read in this lane): scalar equivalent index n_eq = n (1 + (x - x0) / R), i.e. eps' = eps h^2 isotropic with mu = 1. Approximation (scalar, first order in x / R with the r-coordinate in place of the logarithmic one); kept as an option for comparison with the metric model, which is exact for the 2D rotation. Validity of both: the window must not reach the centre (h > 0 everywhere; checked, error otherwise); `conformal` additionally drops the anisotropy (mu = diag(h, h, 1 / h) and the eps anisotropy), so it is limited to weak guidance / large R (quantified against the metric model and the bent-slab table in s.4).

Group index with dispersion: n_g = (k0 / beta) [int e_t . eps_g . e_t + theta eps_g,zz e_z^2] / (x^T B' x) with eps_g = eps - (lambda / 2) d eps / d lambda = n (n - lambda dn/dlambda) per principal axis (the kernel's existing epsG input). Derivation: d(k0^2 eps(k0)) / dk0 = 2 k0 eps_g, Hellmann-Feynman on the pencil. The transform factors are k0-independent, so with PML / bend the same formula holds with the transformed (complex) eps_g; the numerator then uses the complex tensor.

### 2.2 Spec shape (em-modes physics settings; every new key optional, absent = old behaviour)

```yaml
physics:
  - id: ewg
    type: em-modes
    select: [...]
    settings:
      order: 2
      loss: true              # use material kappa: eps = (n - j kappa)^2 (exp(+j omega t)); off by default
      pml:                    # complex coordinate stretching on outer domains (complex solve)
        - {select: ["dom:pml_bottom"], strength: 3, power: 2}          # direction and inner edge auto from bounding boxes
        - {select: ["dom:pml_right"], x: [{value: 2, unit: um}, {value: 3, unit: um}]}   # explicit [inner, outer]
      bend: {radius: {value: 10, unit: um}, x0: {value: 0, unit: um}, model: metric}   # metric (exact) | conformal (HH 1975)
      dispersion:             # n_g with material dispersion (eps_g = n (n - lambda dn/dlambda))
        dndlambda: {Si: {value: -0.0771, unit: 1/um}, SiO2: ..., LN: {perp: ..., par: ...}}   # per material id; else ctx.materials[id].dn_dlambda (R2)
```

Auto PML direction (D, revised 09:05 after the first draft compared against the window box and wrongly stretched side layers along y): each PML domain's bounding box is compared with the interior (live cells in no PML entry). A domain lying entirely beyond the interior's x range is stretched along x from its inner edge to its outer edge; likewise y; corner domains get both. A domain overlapping the interior in both x and y is an error (give `x` / `y` explicitly). One material per domain, so a PML side through a layer stack needs one domain per layer.

Results (added, only when they apply): `kappaEff_<k>` (-Im n_eff >= 0 for loss, 1), `Lprop_<k>` (power 1/e length 1 / (2 alpha), m), `lossDbPerM_<k>` (existing), `bendLossDbPer90_<k>` (lossDbPerM x pi |R| / 2, dB) with a bend; `ng_<k>` uses eps_g when `dispersion` is on. Notes say which options ran.

### 2.3 Gates (references)

| Gate | Reference | Tolerance plan |
|---|---|---|
| G-SPP planar Au / air, lambda = 0.6595 um, TM SPP | analytic n_spp = sqrt(eps_m eps_d / (eps_m + eps_d)) (derivation in s.4; textbook form: S. A. Maier, Plasmonics: Fundamentals and Applications, Springer 2007, ch. 2, cited for the result, equation number not verified here); L_spp = 1 / (2 Im beta). Au eps from Johnson and Christy, Phys. Rev. B 6, 4370 (1972) via refractiveindex.info `Au/nk/Johnson.yml` (CC0) row 0.6595 um: n 0.14, k 3.697 | Re n_spp rel 1e-5, L_spp rel 1e-3, window truncation error measured by halving the window |
| G-LEAK Si wire on 1 um BOX over Si (substrate leakage) | P. Bienstman et al., Opt. Quantum Electron. 38, 731-759 (2006), doi 10.1007/s11082-006-9025-9: Re n_eff 2.41237, Im 2.913e-8 ("most precise values"), quasi-TE, 500 x 220 nm, n = 3.5 / 1.45 / 3.5, air top, 1.55 um. Read via the Flexcompute Tidy3D notebook RadiativeLossesModeSolver (code cells, read 2026-11-18); primary PDF not readable here (403) | Re abs 2e-4, Im rel 5 % (to be confirmed by convergence) |
| G-PML-ID guided mode with PML on | the same mode without PML (closed window) | rel 1e-7 Re n_eff, Im n_eff < 1e-10 |
| G-BEND bent slab, TE0 / TM0, R = 10, 20, 50 um | K. R. Hiremath, M. Hammer, R. Stoffer, L. Prkna, J. Ctyroky, Opt. Quantum Electron. 37, 37-61 (2005), doi 10.1007/s11082-005-1118-3, Table 3 (preprint computational-photonics.eu/Papers/Jrnl/bwg.pdf, dated 2005-07-19, p.11): (n_s, n_f, n_c) = (1.6, 1.7, 1.55), d = 2 um, lambda = 1.55 um, R = outer core rim. Independent cross-check: own mpmath root of their Eq. (7) in `validation/modes2/bent_slab.py` | beta/k at the table's 4 decimals (abs 1e-4); alpha/k rel 2 % where alpha/k > 1e-6 |
| G-NG Si strip with Si / SiO2 dispersion | R. Cheriton et al., "Integrated astrophotonic phase control for high resolution optical interferometry", SPIE Astronomical Telescopes + Instrumentation 2022, arXiv:2408.06461, s.2.2: 450 x 220 nm strip, 2 um BOX, 2.2 um SiO2 top cladding, TE, 1550 nm, "effective index ... 2.34, and group index is 4.37" (calculated; tool and material model not stated) | n_g abs 0.05 (rounding 0.005 + unstated Si model); internal: formula n_g vs n_eff - lambda dn_eff/dlambda from two full solves at lambda (1 +- 1e-3), rel 1e-5 |
| G-TFLN tfln-mzm-eo with LN / SiO2 / air dispersion | CP-43 n_g 2.276 paper-simulated (tol 0.05) | moves toward 2.276 |

### 2.4 Work items

1. Kernel: `nu` weights in both element routines; complex transform tensors; complex eps_g numerator; default shift with transforms; exported `transformFactors` helper (new `modes/transform.ts`).
2. Spec adapter: `loss`, `pml`, `bend`, `dispersion` settings; result scalars; notes; readiness checks.
3. Registration: `em-modes` settings schema and RESULT_NAMES entry.
4. Tests `test/modes-loss.test.ts`, `modes-pml.test.ts`, `modes-bend.test.ts`, `modes-dispersion.test.ts` (fast reduced versions of the gates; full gates in `validation/modes2/`).
5. `validation/modes2/bent_slab.py` (mpmath, Eq. (7)) and the gate runner logs.
6. Regression (all 9 sims, before / after), `pnpm -r check`, package tests.

## 3. TODO

- [x] Baseline regression (9 sims)
- [x] Plan (this section)
- [x] Kernel nu / transform / complex eps_g
- [x] Spec adapter + registration
- [x] G-SPP
- [x] G-PML-ID, G-LEAK
- [x] G-BEND (+ mpmath cross-check)
- [x] G-NG, G-TFLN
- [x] Example YAMLs (s.6)
- [x] Regression after, tests, check, hand-off

## 4. Gate results

Converged runs: `validation/modes2/gates.ts` (log `logs/modes2-gates-20261118-091737.json`, 109 s, peak RSS 0.71 GB). Fast versions in `packages/physics/test/modes-{loss,pml,bend,dispersion}.test.ts` (15 tests, about 14 s).

SPP derivation (F, standard): TM fields H_x = A e^{-k_d y} (y > 0), A e^{k_m y} (y < 0) with k_i^2 = beta^2 - eps_i k0^2; continuity of H_x and of (1 / eps) dH_x / dy gives k_d / eps_d + k_m / eps_m = 0, hence beta = k0 sqrt(eps_m eps_d / (eps_m + eps_d)); with eps = eps' - j eps'' (exp(+j omega t)) beta = beta' - j beta'', power 1/e length L = 1 / (2 beta'').

| Gate | Case | Result | Reference | Error | Status |
|---|---|---|---|---|---|
| G-SPP | Au / air, 0.6595 um, air 5 um, Au 0.5 um, 60 graded cells per layer (2155 DOF) | n 1.038530742081, kappa 3.094573e-3, L 16.959152 um | analytic 1.038530741799, 3.094573e-3, 16.959153 um | 2.8e-10; 3.5e-8 rel | pass |
| G-SPP | half window (air 2.5, Au 0.25 um) / 120 cells / doubled window | dRe 2.1e-7 / 2.0e-11 / -8.5e-12; kappa rel -3.5e-5 / 2.1e-9 / 5.8e-9 | analytic | truncation of the half window 2e-7 (Re), 3.5e-5 (Im); doubling the window: < 1e-11 | measured |
| G-SPP spec route | `loss: true`, material override n 0.14 / kappa 3.697, unstructured mesh (refine 4 nm at the interface, 4905 DOF; example s.6) | 1.03853033, kappa 3.09455e-3 | analytic | -4e-7; -8e-6 rel | informative |
| G-LEAK | Bienstman wire, tensor mesh f = 1 / 2 / 3 (17k / 68k / 154k DOF), a = 2, p = 2 | Re 2.412493 / 2.412450 / 2.412416; Im 2.9711e-8 / 2.9142e-8 / 2.91303e-8 | 2.41237, 2.913e-8 | Re +4.6e-5 (f = 3; converging from above at the corner singularities); Im +9e-6 rel | pass (Re 1e-4, Im 1 %) |
| G-LEAK PML study | f = 2: a = 1 / 2 / 4; PML 2 um; interior 3 um and substrate 2 um | Im 2.91420 / 2.91423 / 2.91431e-8; 2.91025e-8; 2.91412e-8 | - | spread 0.14 % | default a = 2, p = 2 kept |
| G-LEAK spec route | example `leaky-si-wire` (unstructured, 34.9k DOF) | 2.4124458, 2.9103e-8 | 2.41237, 2.913e-8 | +7.6e-5; -0.09 % | informative |
| G-PML-ID | Si strip 500 x 220 nm in SiO2, PML frame 1 um around a 2 um margin, spec route | Re n_eff identical to the closed window within 1e-9; kappaEff < 1e-10 | same mesh, no PML | < 1e-9 | pass |
| G-BEND reference | mpmath root of the Bessel-Hankel determinant (`bent_slab.py`, own matching conditions) | all 6 (R 10, 20, 50 um; TE, TM) | Hiremath 2005 Table 3 | alpha/k to all 5 printed digits; beta/k within 5e-5 except R = 10 TE: 1.5889461 vs printed 1.5890 (5.4e-5, just beyond rounding) | pass (independent cross-check) |
| G-BEND metric | f = 4, inner 6 / clad 4 / PML 3 um (2.9k-5.2k DOF) | dBeta -1.4e-5 ... -8.7e-7; alpha rel 1.4e-4 ... 6.4e-4 | mpmath root | <= 1.4e-5; <= 6.4e-4 | pass (1e-4; 3e-3, R = 50: 1e-2) |
| G-BEND metric, smaller window | inner 4 / clad 3 / PML 2 um | R = 50 alpha rel +4.0e-3 (TE), -1.16e-2 (TM) | mpmath | window-limited at alpha/k ~ 1e-6 | measured |
| G-BEND conformal | Heiblum-Harris scalar n (1 + x / R), same meshes | dBeta -4.8e-4 ... -1.1e-3; alpha rel +2.1 % ... +4.8 % (R 10, 20), -12.5 % (R 50) | mpmath | approximation error | documented (conformal is not exact) |
| G-NG identity | Si strip 450 x 220 nm, Si Salzberg-Villa-Tatian, SiO2 Malitson | n_g formula 4.29227 vs FD 4.29227 | n_eff - lambda dn_eff/dlambda, dlambda = 1e-3 lambda | 1.4e-7 (500 nm: 3.2e-8; TFLN uniaxial: 3.5e-8) | pass |
| G-NG published | same | n_eff 2.35619, n_g 4.2923 (non-dispersive 4.1502); h / 2: 4.2923 | Cheriton et al. 2022 (450 x 220, SiO2 clad, TE, 1550 nm): n_eff 2.34, n_g 4.37 (tool and indices not stated) | n_g -0.078 (-1.8 %), n_eff +0.016 | informative: the reference states no material model; both its n_eff and n_g differ in the direction of a narrower or lower-index core; not a gate (O7) |
| G-NG Si model | Si default (Li 1980 table, piecewise-linear derivative) | n_g 4.2988; formula vs FD 1.7e-3 | - | table slope differs from the FD across a node | D: use a smooth Si fit for n_g |
| G-NG 500 nm | 500 x 220 nm, same materials | n_eff 2.44838, n_g 4.19722 | EO atlas K1 ng_energy 4.19617 (WO-65; Sellmeier, n_Si 3.477723756, self-generated by the sibling atlas) | +1.0e-3 | informative |
| G-TFLN | tfln-mzm-eo with LN (Zelmon o / e), SiO2 (Malitson, extrapolated past its fit range at 1.957 um), air (Mathar 2007 table) dn/dlambda | n_g 2.27943 (was 2.22623); n_eff, VpiL bitwise unchanged | CP-43 Pan 2021 paper-simulated 2.276 (tol 0.05) | +0.0034 | pass (DevLog-032 O2 / DevLog-029 O7 fixed once the sim carries the setting, R3) |

Regression: all 9 em-modes sims (WO-01 te0 / tm0, WO-02 si-rib and hadley-rib, WO-65 si-strip, CP-43 tfln-mzm-eo, H11 si-microheater-to, hadley square core / hole) give bitwise identical eigenvalues, scalars and per-field sums of squares before (08:52) and after (09:19) (`logs/modes2-regress-before-20261118-085217.json`, `logs/modes2-regress-after-20261118-091955.json`). WO-41 has no sim (pending case). `pnpm test` in packages/physics: 154 / 154 pass (`logs/modes2-physics-test-20261118-092000.log`); `pnpm -r check`: 11 projects, 0 errors (`logs/modes2-check-20261118-092144.log`).

Bug found and fixed in the kernel: `csqrt` computed Im sqrt(theta) as sqrt((|theta| - Re theta) / 2), which cancels catastrophically for |Im theta| << Re theta: the substrate-leakage Im n_eff came out identical to 17 digits on two different meshes (2.0794e-8, quantised). Now |Im| / (2 Re sqrt) for Re > 0; lossless results unchanged (Im = 0 branch identical).

## 4.1 Validity and limits (D, O)

- Metric bend model: exact for a cross-section rotated about the y axis (no approximation beyond the discretisation and the PML); n_eff refers to the radius |R| at x = x0; Re h > 0 is enforced. Conformal model: scalar, isotropic eps h^2; errors measured above (1e-3 in beta/k, 2-12 % in alpha/k for this low-contrast slab), expected to grow with index contrast; keep it for comparison only.
- PML: centroid (piecewise-constant) stretching; the gates used 8-16 cells across the layer. Fields and power / TE-fraction integrals include the PML cells (diagnostics only there).
- n_g with PML / bend uses the complex transformed eps_g (s and h do not depend on k0, so the energy form stays exact); not separately gated.
- Loss: isotropic kappa only; kappa dispersion not in eps_g (note emitted).

## 4.2 Open items

- O1 pml / bend together with thermo-optic or electro-optic couplings is rejected (the first-order overlaps of coupled.ts are not transformed).
- O2 uniaxial kappa (`kappa.perp` / `kappa.par`) is rejected.
- O3 `ng` of a PML / bend run is reported but not gated.
- O4 the default shift with a bend scales with max Re h of the window; in practice give `neffShift` (the gates and examples do). Resolved 2026-11-18 (s.8): shift from the physical window plus PML-fraction ranking.
- O5 Li 1980 Si table gives a piecewise-linear dn/dlambda (FD mismatch 1.7e-3 at 1550 nm); prefer the smooth Si fits for n_g.
- O6 SiO2 Malitson at 1.957 um is past its stored validity range (`extrapolated: true`): the TFLN n_g uses it as an extrapolation.
- O7 no published n_g for a 500 x 220 or 450 x 220 nm strip with a stated material model was found within this lane (Optica full text not reachable from here); Cheriton 2022 is the only one quoted, informative.
- O8 Bienstman 2006 values read from the Tidy3D notebook's code cells (the primary PDF returned 403); confirm against the paper's table when a copy is available.

## 5. Requests to the coordinator

- R1 (prepare.ts, S3 / coordinator): em-modes with `settings.loss` needs library `kappa`: add `kappa` to the optional property list of em-modes (absent = lossless, no note) and evaluate it at the mode wavelength (`libOpts`: `p === 'kappa'` like `n`). Today only material overrides `{n, kappa}` reach `ctx.materials` (gold.yaml already has Johnson-Christy n / kappa).
- R2 (prepare.ts): when an em-modes physics has `settings.dispersion`, store `dn_dlambda` (scalar) or `dn_dlambda.perp` / `.par` per material with a `ref`, from `@amp/materials` `dispersion(lib, id, lambda, {component})`; note when the derivative is `piecewise-linear` or `extrapolated`. em-modes already reads these keys; `settings.dispersion.dndlambda.<material>` overrides them.
- R3 (T3, sims): add to `sims/tfln-mzm-eo.yaml` physics `ewg.settings` (values from the library on 2026-11-18, `logs/modes2-gates-20261118-091737.json` G-TFLN) to move n_g from 2.2262 to 2.2794 (CP-43 2.276):
  ```yaml
  dispersion:
    dndlambda:
      LN: {perp: {value: -31490.488092577736, unit: 1/m}, par: {value: -26632.793507610328, unit: 1/m}}
      SiO2: {value: -14315.326963915826, unit: 1/m}
      Air: {value: -0.40121996453640674, unit: 1/m}
  ```
  with provenance: LN `materials/linbo3-congruent.yaml` n (Zelmon 1997 Sellmeier) central difference at 1.957 um; SiO2 `materials/sio2-thermal-oxide.yaml` (Malitson 1965), extrapolated beyond the stored range; Air `materials/air.yaml` alternative `mathar2007_ir` (table, piecewise-linear slope). Then T2 can turn CP-43 `n_g_optical` into a gate.
- R4 (coordinator, registrations.ts): edited only the em-modes entry (`settings: EM_MODES_SETTINGS`, description), its RESULT_NAMES entry (`...RESULT_NAMES_MODES2`) and, to reach them, the existing import line from `./modes/coupled.ts` (added `EM_MODES_SETTINGS, RESULT_NAMES_MODES2`). `crystalsSchema` import stays (used by another entry).
- R5 (T2, eval): WO-65 `ng_energy` (atlas K1 with Sellmeier dispersion, 4.19617) is now comparable with `settings.dispersion` (this lane: 4.19722 with the library Salzberg Si n 3.478709 instead of the case's 3.477723756).
- R6 (CONTRACTS changelog): em-modes settings `loss`, `dispersion`, `pml`, `bend`; result scalars `kappaEff_<k>`, `Lprop_<k>`, `bendLossDbPer90_<k>`; kernel option `transform`.

## 6. Example specs for chunk 2

Each was run through prepareRun + runStudy on 2026-11-18 09:20 PST (results in the comment line above it); geometry values not tied to a paper are modelling choices.

Plasmonic mode (n_eff 1.0385303, kappaEff 3.09455e-3, Lprop 16.959 um; analytic 1.0385307, 3.094573e-3, 16.959 um):
```yaml
schema: amp-spec/0
id: au-air-spp
title: Au / air surface plasmon (planar)
description: Planar Au / air interface at 0.6595 um; complex permittivity from n and kappa (Johnson-Christy); thin x-invariant strip (PMC sides), PEC far walls.
params:
  lambda0: {value: 0.6595, unit: um}
geometry:
  dim: 2
  features:
    - {id: au, type: rect, settings: {size: ["0.05 um", "0.5 um"], center: ["0 um", "-0.25 um"]}}
    - {id: air, type: rect, settings: {size: ["0.05 um", "5 um"], center: ["0 um", "2.5 um"]}}
materials:
  - {id: Au, ref: materials/gold, override: {n: 0.14, kappa: 3.697}, select: ["dom:au"]}
  - {id: Air, override: {n: 1}, select: ["dom:air"]}
physics:
  - id: ewg
    type: em-modes
    select: ["dom:au", "dom:air"]
    settings: {order: 2, loss: true}
    bcs:
      - {id: far, type: pec, select: ["bnd:au.bottom", "bnd:air.top"]}
mesh:
  size: {hmax: "0.1 um", grading: 0.3}
  refine:
    - {select: ["bnd:au.top"], h: "0.004 um"}
studies:
  - {id: modes, type: mode, physics: [ewg], settings: {wavelength: "lambda0", nModes: 1}}
```

Leaky Si wire, substrate leakage (n_eff 2.4124458, kappaEff 2.9103e-8, 0.0102 dB/cm; Bienstman 2006 2.41237, 2.913e-8):
```yaml
schema: amp-spec/0
id: leaky-si-wire
title: Si wire substrate leakage (PML)
description: Si wire 500 x 220 nm (n 3.5) on a 1 um SiO2 buffer (n 1.45) over Si (n 3.5), air top, 1.55 um; quasi-TE leakage into the substrate through PML. Half window (PEC on x = 0).
params:
  lambda0: {value: 1.55, unit: um}
  t_box: {value: 1, unit: um}
geometry:
  dim: 2
  features:
    - {id: core, type: rect, settings: {size: ["0.25 um", "0.22 um"], center: ["0.125 um", "0.11 um"]}}
    - {id: airr, type: rect, settings: {size: ["2 um", "1.5 um"], center: ["1 um", "0.75 um"]}}
    - {id: air, type: difference, settings: {base: airr, tools: [core], keepTools: true}}
    - {id: box, type: rect, settings: {size: ["2 um", "t_box"], center: ["1 um", "-t_box/2"]}}
    - {id: sub, type: rect, settings: {size: ["2 um", "1 um"], center: ["1 um", "-t_box - 0.5[um]"]}}
    - {id: pb, type: rect, settings: {size: ["2 um", "1 um"], center: ["1 um", "-t_box - 1.5[um]"]}}
    - {id: pr_air, type: rect, settings: {size: ["1 um", "1.5 um"], center: ["2.5 um", "0.75 um"]}}
    - {id: pr_box, type: rect, settings: {size: ["1 um", "t_box"], center: ["2.5 um", "-t_box/2"]}}
    - {id: pr_sub, type: rect, settings: {size: ["1 um", "1 um"], center: ["2.5 um", "-t_box - 0.5[um]"]}}
    - {id: pc, type: rect, settings: {size: ["1 um", "1 um"], center: ["2.5 um", "-t_box - 1.5[um]"]}}
materials:
  - {id: Si, override: {n: 3.5}, select: ["dom:core", "dom:sub", "dom:pb", "dom:pr_sub", "dom:pc"]}
  - {id: SiO2, override: {n: 1.45}, select: ["dom:box", "dom:pr_box"]}
  - {id: Air, override: {n: 1}, select: ["dom:air", "dom:pr_air"]}
physics:
  - id: ewg
    type: em-modes
    select: ["dom:core", "dom:air", "dom:box", "dom:sub", "dom:pb", "dom:pr_air", "dom:pr_box", "dom:pr_sub", "dom:pc"]
    settings:
      order: 2
      pml: [{select: ["dom:pb", "dom:pr_air", "dom:pr_box", "dom:pr_sub", "dom:pc"], strength: 2, power: 2}]
    bcs:
      - {id: sym, type: pec, select: ["bnd:core.left", "bnd:airr.left", "bnd:box.left", "bnd:sub.left", "bnd:pb.left", "bnd:airr.top", "bnd:pr_air.top"]}
mesh:
  size: {hmax: "0.15 um", grading: 0.3}
  refine:
    - {select: ["dom:core"], h: "0.03 um"}
    - {select: ["dom:box"], h: "0.08 um"}
studies:
  - {id: modes, type: mode, physics: [ewg], settings: {wavelength: "lambda0", nModes: 2, neffShift: 2.42}}
```

Bend loss vs radius (R = 2 um: n_eff 2.457345, 1.91e-4 dB per 90 degrees; no reference: chunk 2 sweeps `R` and should add a published point, O7-style):
```yaml
schema: amp-spec/0
id: si-strip-bend
title: Si strip bend radiation loss
description: Si strip 500 x 220 nm in SiO2 at 1550 nm bent in the chip plane (bend axis vertical, outer side +x); PML on the outer side; sweep radius for loss vs radius.
params:
  R: {value: 2, unit: um, description: bend radius at the strip centre (x = 0)}
  lambda0: {value: 1.55, unit: um}
geometry:
  dim: 2
  features:
    - {id: core, type: rect, settings: {size: ["0.5 um", "0.22 um"], center: ["0 um", "0 um"]}}
    - {id: cladr, type: rect, settings: {size: ["3.5 um", "4 um"], center: ["0.25 um", "0 um"]}}
    - {id: clad, type: difference, settings: {base: cladr, tools: [core], keepTools: true}}
    - {id: pml, type: rect, settings: {size: ["1 um", "4 um"], center: ["2.5 um", "0 um"]}}
materials:
  - {id: Si, override: {n: 3.4787089554992723}, select: ["dom:core"]}
  - {id: SiO2, override: {n: 1.4444232909003691}, select: ["dom:clad", "dom:pml"]}
physics:
  - id: ewg
    type: em-modes
    select: ["dom:core", "dom:clad", "dom:pml"]
    settings:
      order: 2
      pml: [{select: ["dom:pml"]}]
      bend: {radius: "R", x0: "0 um", model: metric}
    bcs:
      - {id: walls, type: pec, select: ["bnd:cladr.left", "bnd:cladr.top", "bnd:cladr.bottom", "bnd:pml.top", "bnd:pml.bottom", "bnd:pml.right"]}
mesh:
  size: {hmax: "0.25 um", grading: 0.3}
  refine:
    - {select: ["dom:core"], h: "0.05 um"}
    - {select: ["bnd:core.left", "bnd:core.right", "bnd:core.top", "bnd:core.bottom"], h: "0.015 um"}
studies:
  - {id: modes, type: mode, physics: [ewg], settings: {wavelength: "lambda0", nModes: 2, neffShift: 2.6}}
```

Directional coupler supermodes (no new option; n_even 2.459812, n_odd 2.439400 -> L_c = lambda / (2 dn) = 37.97 um at this mesh):
```yaml
schema: amp-spec/0
id: si-dc-supermodes
title: Si directional coupler supermodes
description: Two Si strips 500 x 220 nm, 200 nm gap, in SiO2 at 1550 nm; even / odd TE supermodes; coupling length L_c = lambda / (2 (n_even - n_odd)).
params:
  gap: {value: 200, unit: nm}
  lambda0: {value: 1.55, unit: um}
geometry:
  dim: 2
  features:
    - {id: wgl, type: rect, settings: {size: ["0.5 um", "0.22 um"], center: ["-gap/2 - 0.25[um]", "0 um"]}}
    - {id: wgr, type: rect, settings: {size: ["0.5 um", "0.22 um"], center: ["gap/2 + 0.25[um]", "0 um"]}}
    - {id: cladr, type: rect, settings: {size: ["5 um", "4 um"], center: ["0 um", "0 um"]}}
    - {id: clad, type: difference, settings: {base: cladr, tools: [wgl, wgr], keepTools: true}}
materials:
  - {id: Si, override: {n: 3.4787089554992723}, select: ["dom:wgl", "dom:wgr"]}
  - {id: SiO2, override: {n: 1.4444232909003691}, select: ["dom:clad"]}
physics:
  - id: ewg
    type: em-modes
    select: ["dom:wgl", "dom:wgr", "dom:clad"]
    settings: {order: 2}
    bcs:
      - {id: walls, type: pec, select: ["bnd:cladr.left", "bnd:cladr.right", "bnd:cladr.top", "bnd:cladr.bottom"]}
mesh:
  size: {hmax: "0.3 um", grading: 0.3}
  refine:
    - {select: ["dom:wgl", "dom:wgr"], h: "0.05 um"}
studies:
  - {id: modes, type: mode, physics: [ewg], settings: {wavelength: "lambda0", nModes: 4}}
results:
  datasets:
    - {id: sol_modes, type: solution, data: modes}
  evaluations:
    - id: ev
      data: sol_modes
      items:
        - {id: dn, type: global, expr: "ewg.neff_0 - ewg.neff_1", unit: "1"}
```

## 7. Progress log

- 2026-11-18 08:47 PST: read CLAUDE.md, DevLog-037, -010 (em-modes), -032 (O2, O3), -041, C4 / C5, modes sources, prepare.ts.
- 2026-11-18 08:52 PST: regression baseline over 9 em-modes sims (`<scratch>/regress-before.json`).
- 2026-11-18 08:53-08:59 PST: sources: Bienstman 2006 values via the Tidy3D notebook (primary PDF 403); Hiremath 2005 preprint read (Tables 1-3); Johnson-Christy Au rows via refractiveindex.info; Cheriton 2022 arXiv s.2.2.
- 2026-11-18 09:00 PST: plan written.
- 2026-11-18 09:00-09:04 PST: kernel nu weights (separate branch, identity path untouched), transformTensors, complex eps_g numerator; transform.ts; spec adapter (loss, dispersion, pml, bend); settings schema `modes/settings.ts` re-exported from coupled.ts; registration entry. Regression: 9 / 9 sims bitwise identical.
- 2026-11-18 09:05-09:07 PST: G-SPP passes on the first run. G-LEAK: Re within 1.2e-4, Im identical across meshes: found the csqrt cancellation bug, fixed (09:07); then Im 2.971e-8 / 2.914e-8 / 2.9130e-8. PML auto direction revised (interior box). Complex path with a transform keeps the modes nearest the shift (PML modes otherwise crowd out the leaky mode).
- 2026-11-18 09:08-09:11 PST: G-BEND metric vs Hiremath Table 3 within table digits; `validation/modes2/bent_slab.py` (mpmath) reproduces Table 3; conformal deviations measured.
- 2026-11-18 09:11-09:13 PST: G-NG identity (1.4e-7), G-TFLN n_g 2.2794 vs 2.276 (FD check 3.5e-8 on the uniaxial path).
- 2026-11-18 09:13-09:17 PST: tests modes-loss / -pml / -bend / -dispersion (15, all pass); gate runner `validation/modes2/gates.ts`.
- 2026-11-18 09:17-09:22 PST: gate log (109 s, 0.71 GB), regression after (identical), physics tests 154 / 154, `pnpm -r check` clean; four example specs run.

## 8. Audit fixes (2026-11-18)

Lane F2 (fresh-context audit findings 1-4). Owns `packages/physics/src/modes/**`, `packages/physics/test/modes-*.test.ts`, `validation/modes2/**`, the em-modes `description` in `registrations.ts`.

### 8.1 Verification of the findings (F, 09:51-09:57 PST)

- Finding 1 reproduced: Au / air SPP (0.6595 um, n 0.14, kappa 3.697, spec route, `loss: true`, 60 + 60 graded cells): n_g 1.039518865 with dispersion off, 1.120189133 with `dndlambda: {Au: 0, Air: 0}` (n_eff 1.0385307421 both). Cause: `g[d] = n * ng` drops -kappa^2. Second defect found while checking: even with dispersion off, the kernel uses only Re(eps) as eps_g in the n_g numerator of a lossy solve (`materialTensors` copies the real eps). For a planar interface between non-dispersive media n_g must equal n_eff (no length scale; the window holds 13 air decay lengths), but 1.039519 vs 1.038531 differs by 1e-3: the Im(eps) part of the Hellmann-Feynman numerator is missing.
- Finding 2 reproduced: bent slab of the G-BEND test (R = 20 um, TE, PML 3-5 um, no `neffShift`, nModes 1): n_eff 1.81424, kappa 0.1011, bendLossDbPer90 111.8 dB, no warning; with nModes 4 the bend mode (1.618512, kappa 1.8313e-3) is 4th; with neffShift 1.63 it is mode 0. Default shift = 1.7 x Re h_max = 1.7 x 1.25 (h at the PML outer edge, x = 5 um).
- Finding 3: `postProcess` energy uses the untransformed eps; the Poynting integrand has no nu weights, so with a bend the region power, `powerW` and the power identity miss the 1 / h of the transformed permeability (mu' = diag(h, h, 1 / h)).
- Finding 4: em-modes description ends with "(DevLog-043)".

### 8.2 Plan (D, 09:57 PST, before coding)

1. eps_g complex (kernel + adapter). Kernel `materialTensors`: new optional `epsGIm` (eps_g = epsG - j epsGIm, same sign as epsIm); in a lossy solve without explicit epsG, eps_g = eps (complex, the non-dispersive case); n_g numerator uses the complex eps_g (existing complex branch of `postProcess`, also with a transform: `transformTensors` multiplies the complex eps_g). Lossless solves keep the real-eps_g code path (bitwise). Adapter: for a lossy material eps_g = N (N - lambda dN/dlambda), N = n - j kappa, dN/dlambda = dn/dlambda - j dkappa/dlambda; Re = n^2 - kappa^2 - lambda (n dn/dlambda - kappa dkappa/dlambda), Im part 2 n kappa - lambda (n dkappa/dlambda + kappa dn/dlambda). dkappa/dlambda: optional `settings.dispersion.dkappadlambda.<material>` (1/m) or a material `dkappa_dlambda`; absent = kappa treated as wavelength-independent (0), named in the note. Lossless materials keep n (n - lambda dn/dlambda) (bitwise). Zero derivatives then give eps_g = eps exactly, i.e. the non-dispersive result.
2. Bend / PML default shift: Re h_max over live cells outside the PML (physical window) instead of the whole window; per-mode PML fraction (share of int |E|^2 dA, computational coordinates, in PML cells) reported as `pmlFraction_<k>`; with PML and no user shift, solve for extra candidates (nModes + 6) and rank modes with PML fraction <= 0.5 first (nearest the shift), PML-dominated ones only to fill; warning (note) when a returned mode has PML fraction > 0.5. User `neffShift` keeps the old selection (gates bitwise).
3. Confinement with a transform: energy density with Re of the transformed eps', Poynting integrand with the nu~ weights (conjugated for power, unconjugated for the power identity); exact in non-PML cells for the bend (energy and power per unit angle with the r / |R| weight), computational-coordinate diagnostic in PML cells. powerW follows. No transform: code path unchanged.
4. Description and notes: no DevLog / lane codes in user-visible strings of this lane.
5. Tests: zero-derivative identity (lossy, also with PML), lossy FD check (Au / air SPP with library gold n(lambda), kappa(lambda)), non-dispersive planar SPP n_g = n_eff, bend R = 20 um without neffShift, confinement with a bend vs a direct physical integral. Regression (9 sims) before / after, physics tests, `pnpm -r check`.

### 8.3 Progress (PST)

- 2026-11-18 09:51 regression baseline over the 9 em-modes sims (`logs/F2-modes-regress-before-*.json`; mesh hash + tagHash recorded per sim to separate concurrent geometry-lane changes).
- 2026-11-18 09:57 findings 1 and 2 reproduced; plan written.
- 2026-11-18 09:58-10:01 kernel: `epsGIm` / complex eps_g (`materialTensors`, `transformTensors`), `hMaxPhys` default shift, PML cell flags, `pmlFractionOf`, candidate ranking and warning, nu-weighted Poynting and H_t, transformed eps' in the energy; adapter: complex eps_g of lossy materials, `dispersion.dkappadlambda`, `pmlFraction_<k>`, notes; settings schema key and result name.
- 2026-11-18 10:01-10:03 repros rerun: finding 1 n_g 1.0385307420 (off) = 1.0385307420 (zero derivatives), bitwise; finding 2 R = 20 um, nModes 1, no shift: 1.618512, kappa 1.8313e-3. Closed-bend energy fractions vs Hellmann-Feynman FD; old weighting measured with a temporary kernel copy (removed). Regression after: 9 / 9 bitwise.
- 2026-11-18 10:03-10:06 tests: 2 in modes-dispersion, 5 in modes-bend; modes tests 29 / 29.
- 2026-11-18 10:06-10:09 gate runner rerun: G-TFLN base was dispersive since DevLog-046 (sim now carries library dispersion); same one-line fix as DevLog-046 R2 in `validation/modes2/gates.ts`; rerun: all 5 gate blocks equal the 09:17 log.
- 2026-11-18 10:10-10:13 physics tests 172 / 172, `pnpm -r check` clean, final regression 9 / 9 bitwise; regression script saved as `validation/modes2/regress.ts`.

### 8.4 Results (F, 10:13 PST)

| Finding | Fix | Check | Result |
|---|---|---|---|
| 1 lossy eps_g (major) | lossy material: eps_g = N (N - lambda dN/dlambda), N = n - j kappa, dN/dlambda = dn/dlambda - j dkappa/dlambda (complex, both parts in the n_g numerator); dkappa/dlambda from `settings.dispersion.dkappadlambda.<material>` (1/m) or a material `dkappa_dlambda`, else 0 with a note naming the material; lossless materials unchanged (n (n - lambda dn/dlambda)). Kernel: a lossy solve without explicit eps_g now uses the complex eps (was Re eps only), also with PML / bend | zero-derivative identity, Au / air SPP 0.6595 um, closed window and with a 1 um PML on the air side | n_g bitwise equal to dispersion off (1.0385307420101 / 1.0385307420157 with PML); n_g - n_eff = -7.1e-11 / -6.5e-11 (was +9.9e-4 with Re eps only: 1.039519 vs 1.038531) |
| 1 (FD) | - | Au / air SPP at 0.78 um, library gold (Johnson-Christy table, segment 0.7560-0.8211 um): n 0.147373, kappa 4.741447, dn/dlambda 3.072e5 1/m, dkappa/dlambda 8.310e6 1/m; FD of Re n_eff over lambda (1 +- 1e-3) with the library n(lambda), kappa(lambda) | n_g 1.0878622 (n_eff 1.0229392): rel -2.5e-7 vs FD; dlambda halved: -6.2e-8 (ratio 4.0, O(dlambda^2) truncation). kappa held at kappa(lambda0), no dkappa/dlambda: n_g 1.0231732 vs FD rel -1.6e-11; note emitted |
| 2 bend default shift (major) | default shift scales with Re h_max of the live non-PML cells; per-mode PML fraction (share of int \|E\|^2 dA, computational coordinates, in PML cells) as `pmlFraction_<k>`; with PML and no user shift nModes + 6 candidates, modes with PML fraction <= 0.5 ranked first (nearest the shift); note for any returned mode above 0.5. Threshold 0.5 and 6 extra candidates are numerical choices, not physical values. User `neffShift`: selection unchanged | bent slab of G-BEND (f = 2), no neffShift, nModes 1 | R = 10 / 20 / 50 um: 1.5889225 / 1.6185120 / 1.6472430, kappa 1.6049e-2 / 1.8313e-3 / 9.711e-7, PML fraction 0.109 / 0.025 / 6.2e-5 (refs 1.5889461 / 1.6185285 / 1.6472470). Was 1.81424, kappa 0.1011 at R = 20. Measured PML fractions: PML modes 0.75-0.98; radiation modes of the R = 20 window 0.11-0.22 |
| 3 confinement (minor) | with a transform: electric energy with Re of the transformed eps', Poynting (conjugated and unconjugated) with the nu~ weights; `powerW` and H_t (z x nu~ e_t') follow. Exact for the metric bend outside the PML (energy per unit angle with weight r / \|R\| = h; mu' = diag(h, h, 1 / h)). Not changed, documented: E_z output is h E_z (bend coordinates; note in the run), TE fraction and effective area use computational fields; PML cells hold stretched-coordinate values (diagnostic) | closed bend (no PML), region energy fraction vs eps_r dn_eff/deps_r / sum (Hellmann-Feynman FD, d = 1e-5); power identity | R = 10 um core 0.55754950 vs HF 0.55754950 (diff 7.7e-10; old weighting 0.58720065, diff 3.0e-2); R = 20 um diff 1.4e-9 (old 9.1e-3); power identity 1e-15 (old 1.2e-2 / 1.6e-2) |
| 4 UI text (minor) | em-modes description without "(DevLog-043)"; string literals of `modes/**` and the entry scanned for DevLog / lane / decision / gate codes: none left | literal scan | clean |

Tests added: modes-dispersion 2 (zero-derivative identity incl. PML and n_g = n_eff for the planar non-dispersive SPP; lossy FD with and without dkappa/dlambda), modes-bend 5 (default shift R = 10, 20, 50 um; PML-mode note; confinement vs Hellmann-Feynman + power identity). Modes tests 29 / 29; `pnpm --filter @amp/physics test` 172 / 172 (`logs/F2-physics-test-20261118-101035.log`); `pnpm -r check` 11 projects clean, apps/web 0 errors (`logs/F2-check-20261118-101217.log`).

Regression: 9 em-modes sims bitwise identical before (09:52) / after (10:12) in mesh hash, eigenvalues, scalars, per-field sums of squares and notes (`logs/F2-modes-regress-before-20261118-095210.json`, `logs/F2-modes-regress-after-20261118-101236.json`; script `validation/modes2/regress.ts`, peak RSS 1.3 GB). Gate runner (`logs/F2-modes2-gates-20261118-100850.json`, 100 s, max RSS 1.81 GB by /usr/bin/time): all logged values equal the 09:17 log.

Behaviour changes with options on (intended): lossy solves report n_g from the complex eps_g (the Au / air SPP value moves from 1.039519 to 1.038531); runs with PML report `pmlFraction_<k>`; with a bend, `powerW`, power / energy confinement and H_t include the transform weights; bend + PML without `neffShift` selects by PML fraction.

### 8.5 Open items and requests

- O9 prepareRun does not bind a library `dkappa_dlambda` (the em-modes adapter reads it when present); today dkappa/dlambda comes only from `settings.dispersion.dkappadlambda`. R7 (prepare.ts owner): with `settings.dispersion` and `settings.loss`, store `dkappa_dlambda` per lossy `ref:` material (central difference of library kappa, same provenance notes as dn/dlambda).
- O10 E_z of a metric bend is reported in bend coordinates (h E_z); TE fraction and effective area use computational fields (differences of order (x - x0) / R).
- R8 (CONTRACTS changelog): em-modes setting `dispersion.dkappadlambda.<material>` (1/m); result scalar `pmlFraction_<k>`; kernel option `epsGIm`; kernel export `PML_FRACTION_MAX`.
- R9 (UI text, not this lane): `apps/web/src/lib/library/catalog-bc.ts` line 35 shows "(DevLog-022 s.8)" in a user-visible note.
