# DevLog-048: photonics mode-solver examples and prepareRun material items (lane E2, chunk 2)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | E2 (photonics examples on em-modes; prepareRun / em-modes items) |
| Owns | `packages/physics/src/prepare.ts`, `packages/physics/src/modes/**`, `packages/physics/src/couplings/photonic.ts`; new sims of this lane; `apps/web/src/lib/library/catalog-modes.ts`; `validation/c/cases_ext/modes.py`; new `validation/modes3/**`; new `packages/physics/test/modes-e2.test.ts`; new `eval/expected/WO-8x.json`; eval `spec:` of CP-43 and the `t2_apply` WO-65 entry of `validation/c/build_cases.py`; this file |
| Inputs | CLAUDE.md; DevLog-037 s.4.1; DevLog-043 (s.4-8, O8, O9 / R7); DevLog-046 (O1-O5, R4); DevLog-041 s.5; catalog.ts; eval/README.md; validation/c/cases_ext/README.md, driven.py (pattern) |

Conventions: F = fact read from code or a source; E = estimate; D = decision; O = open item; R = request to the coordinator.

## 1. Sources (F, read 2026-11-18 by a read-only research subagent; copies in the session scratch, not committed)

| Topic | Source | Values used | Status |
|---|---|---|---|
| Leaky Si wire | P. Bienstman et al., Opt. Quantum Electron. 38, 731-759 (2006), doi 10.1007/s11082-006-9025-9, open author copy photonics.intec.ugent.be/download/pub_2092.pdf | structure p.732 Fig. 1 (500 x 220 nm, n 3.5 / 1.45 / 3.5, 1 um buffer, air top, 1.55 um, fundamental TE); CAMFR 2.412372 - 2.9135e-8 j (p.749, text below Fig. 16); aperiodic Fourier modal method extrapolated 2.412372039 + i 2.9134801e-8 (p.751, Fig. 18 caption); Table 6 p.757 method spread | primary paper confirmed (closes DevLog-043 O8). The paper has no bend results |
| Bend loss, Si strip | Kakihara, Kono, Saitoh, Koshiba, Opt. Express 14, 11128 (2006), doi 10.1364/OE.14.011128, open copy eprints.lib.hokudai.ac.jp (OE14-23.pdf) | 445 x 220 nm, n 3.5, SiO2 1.45 below, air above, quasi-TE 1.55 um, R to the wire centre; Fig. 4a: R = 1 um about 0.023 dB / 90 deg (figure-read, no table) | figure-read: informative unless the reading precision can be bounded |
| Bend loss, measured | Vlasov and McNab, Opt. Express 12, 1622 (2004), abstract: 0.086 +- 0.005 dB / 90 deg at R = 1 um, 0.013 at R = 2 um (TE, measured, includes transition loss) | informative only |
| Directional coupler | Flexcompute Tidy3D notebook BroadbandDirectionalCoupler, cell 14 output: 2 Si strips 500 x 220 nm, gap 200 nm, SiO2 all around, 1.55 um, TE, FD mode solver grid_resolution 40, Si "Li1993_293K", SiO2 "Horiba": n+ 2.459162628532339, n- 2.43821523251537 | other open solver, discretisation and material model differ: tolerance is an estimate |
| Slot | Almeida 2004: abstract only (no geometry or n_eff accessible). Dell'Olio and Passaro 2007 Table 2: computed with COMSOL | not usable (no values; COMSOL values excluded by DevLog-001 Q5) |
| SiN | Munoz et al., Sensors 17, 2088 (2017), PMC5620990, s.3.1 / 3.4: 1.0 um x 300 nm LPCVD SiN, 2.5 um thermal SiO2 below, 2 um PECVD SiO2 above, measured TE n_g 1.892 (OFDR, 80 nm scan at 1555 nm), MZI 1.90-1.92 | measured: informative |
| TFLN K2, K3 | eo-modulator-atlas (sibling repo, read only, own work of the same author; HEAD 0546007) `validation/cases/K2.yaml`, `K3.yaml`, `validation/reference/K2-fem.json`, `K3-fem.json` (femwell order-2 FEM, Richardson) | n_eff, ng_energy (Sellmeier dispersion) | rights as WO-65 (own work; cite_values, re_derive_setup, copy_with_attribution) |

## 2. Plan (written 2026-11-18 13:45 PST, before coding)

B items (code):
1. B5 (DevLog-043 R7 / O9): prepareRun binds library `dkappa_dlambda` per lossy `ref:` material when the em-modes physics has `settings.dispersion` and `settings.loss`: central difference of library kappa at lambda (1 +- 1e-4), same step as dn/dlambda, with a provenance note (table segments named piecewise-linear); a material override or `settings.dispersion.dkappadlambda.<id>` wins.
2. B6 (audit minor): kernel `materialTensors` refuses a lossy solve with `epsG` but no `epsGIm` (the default Im eps_g = epsIm drops -lambda (n dkappa/dlambda + kappa dn/dlambda)); `solveModes` checks the same with the domain-level arrays. Callers that want the constant-kappa non-dispersive imaginary part pass `epsGIm = epsIm` explicitly. Test.
3. B7 (DevLog-046 O1 / DevLog-042 O4): `RunContext.materialsAt(lambda)` (optional function added by prepareRun) returns the bound material table with library n, kappa (and eps_r, tan_delta, mu_r where the library has them) at a given vacuum wavelength; overrides unchanged. Request to E4 to consume it in wave2d per frequency.
4. B8: CP-43 `n_g_optical` gate (spec only), WO-65 `ng_energy` with dispersion (t2_apply entry only), RSS check.

A items (sims, ids WO-80..):
- WO-80 `au-air-spp` (library gold, loss on): analytic SPP; two levels.
- WO-81 `leaky-si-wire`: Bienstman 2006 (Re and Im n_eff); two levels.
- WO-82 `tfln-rib-air` (atlas K2), WO-83 `tfln-rib-oxide` (atlas K3): n_eff, ng_energy with library dispersion.
- WO-84 `si-dc-supermodes`: Tidy3D values (estimated tolerance), L_c.
- WO-85 `si-strip-bend`: parametric sweep over R, Kakihara 2006 figure point (informative unless bounded).
- WO-86 `sin-strip`: Munoz 2017 measured n_g (informative).
- K4 VpiL / TO + EO phase shifter: only if time remains.

Gate rule (same as E1, DevLog-047): each gated value on two nested levels (h_factors [1, 0.5]) as two targets, fine-level tolerance tighter or equal.

## 3. TODO

- [x] B6 epsGIm guard + test
- [x] B5 dkappa_dlambda binding + test
- [x] B7 materialsAt API + test + request to E4
- [x] WO-80, WO-81 sims, references, cases
- [x] WO-82, WO-83 (TFLN K2, K3)
- [x] WO-84 DC, WO-85 bend sweep
- [ ] WO-86 SiN strip, slot waveguide, K4 VpiL, TO + EO phase shifter (not done: O1-O3)
- [x] CP-43 gate, WO-65 ng
- [x] regression (9 sims), physics test, check, CLI runs
- [x] hand-off

## 4. Progress log

- 2026-11-18 13:22 PST: read CLAUDE.md, DevLog-037 s.4.1, -043, -046, -041 s.5, catalog.ts, eval README, cases_ext README, prepare.ts, modes/index.ts, settings.ts, build_cases.py (t2_apply, ext_cases).
- 2026-11-18 13:27-13:41 PST: research subagent (read-only) for published references (s.1).
- 2026-11-18 13:45 PST: plan written.
- 2026-11-18 13:42 PST: regression baseline, 9 em-modes sims (`logs/E2-modes-regress-before-20261118-134215.json`, 1.10 GB).
- 2026-11-18 13:43-13:47 PST: B6 guard (kernel `materialTensors` + `solveModes`), B5 `libraryKappaDispersion` in prepare.ts, B7 `Prepared.materialsAt`. Tests blocked for a few minutes by another lane's in-progress `wave2d/lu.ts` (parameter property, not erasable); passed on retry.
- 2026-11-18 13:47-13:53 PST: sims au-air-spp, leaky-si-wire, tfln-rib-air, tfln-rib-oxide, si-dc-supermodes, si-wire-bend; runner `validation/modes3/run.ts`.
- 2026-11-18 13:51-13:53 PST: Kakihara Fig. 4 digitized (`validation/modes3/digitize_fig.py` -> `kakihara2006_fig4.json`).
- 2026-11-18 13:54-13:58 PST: references (`validation/modes3/references.py` -> eval/expected/WO-80..85.json), cases (`validation/c/cases_ext/modes.py`). Harness found a prepareRun case-fill defect (s.5 D3), fixed; all six cases pass.
- 2026-11-18 14:02-14:08 PST: regression after (9 / 9 bitwise), physics tests 190 / 190, check clean, web check clean; final CLI log; coordinator relay (materials registry test): R1 verified with a temporary test copy (removed); results, requests, hand-off written.
- 2026-11-18 13:59-14:02 PST: CP-43 extracts (coordinator relay of DevLog-055 R4) and run (1.06 GB peak RSS); WO-65 ng_energy on the new sim si-strip-te0-ng (t2_apply entry); test_build_matches ok (54 cases).

## 5. Results (F, 2026-11-18)

Harness CLI (`node --max-old-space-size=1536 packages/eval/src/cli.ts --case <ID>`, consolidated log `logs/E2-cli-final-20261118.log`): WO-80..WO-85 and CP-43 pass, 0 fail, 0 error. Levels hFactor 1 and 0.5 (nested); peak RSS of any run 0.78 GB (CP-43 1.06 GB, /usr/bin/time).

| Case / sim | Quantity | Reference | Level 0 | Level 1 | Tolerance (L0 / L1) | Gate |
|---|---|---|---|---|---|---|
| WO-80 au-air-spp | Re n_eff | analytic 1.0385307418 | -4.0e-7 rel | -2.6e-8 rel | rel 1e-6 / 1e-7 | pass |
| | Im n_eff | analytic 3.0945733e-3 | -8.0e-6 rel | -5.3e-7 rel | rel 2e-5 / 2e-6 | pass |
| | L_prop | analytic 16.959153 um | +8.0e-6 rel | +5.0e-7 rel | rel 2e-5 / 2e-6 | pass |
| WO-81 leaky-si-wire | Re n_eff | Bienstman 2006 p.751: 2.412372039 | +7.4e-5 | +3.2e-5 | abs 1.5e-4 / 6e-5 | pass |
| | Im n_eff | 2.9134801e-8 | -1.1e-3 rel | -2.5e-4 rel | rel 3e-3 / 1e-3 | pass |
| WO-82 tfln-rib-air | n_eff | atlas K2 1.894167067 (U 5.8e-8) | +2.8e-7 | +5.0e-7 | abs 1e-6 / 1e-6 | pass |
| | n_g (library dispersion) | 2.290849881 (U 2e-7) | -5.0e-6 | -7.3e-7 | abs 1e-5 / 3e-6 | pass |
| WO-83 tfln-rib-oxide | n_eff | atlas K3 1.912375488 (U 1.9e-7) | -9.5e-7 | +3.3e-8 | abs 2e-6 / 5e-7 | pass |
| | n_g | 2.265028607 (U 6.3e-7) | -3.9e-6 | -6.3e-7 | abs 1e-5 / 3e-6 | pass |
| WO-84 si-dc-supermodes | L_c | Tidy3D notebook: 37.00 um (n 2.459163 / 2.438215) | 38.07 um (+2.9 %) | 38.08 um (+2.9 %) | rel 5 % (E) | pass |
| | n_even / n_odd | | 2.459714 / 2.439357 | 2.459700 / 2.439350 | abs 5e-3 (E) | info |
| WO-85 si-wire-bend | TE dB / 90 deg, R 1.25 / 1.5 um | Kakihara Fig. 4a digitized 0.00635 / 0.00183 | in tolerance | in tolerance | half line extent + 2 px | pass |
| | TM dB / 90 deg, R 5 / 10 um | Fig. 4b 1.101 / 0.328 | 1.116 / 0.345 | 1.117 / 0.346 | 0.051 / 0.041 dB | pass |
| | TE R 1 um (info) | Fig. 4a curve end, extent 0.0199-0.0228 | 0.02385 | 0.02379 | - | info |
| CP-43 tfln-mzm-eo | n_g_optical | Pan 2021 2.276 | 2.27943 | - | abs 0.05 | pass (level 0, 345k DOF, 1.06 GB) |
| | Z0_real, VpiL_measured (relay) | 50 ohm; 3.67 V cm | 48.48 ohm; 4.2208 V cm | - | informative | info (run, under 2 GB) |
| WO-65 si-strip-te0-ng | ng_energy | atlas K1 4.19616697 | 4.1961328 | 4.1961565 | informative at level 1 | not run by the harness (the n_eff group needs level 2, about 2.0 GB); values from `validation/modes3/run.ts` |

Other checks:
- DC material sensitivity: Si n 3.47667 (library Li 1980 eq. 22, 293 K) instead of 3.47871 moves n_even / n_odd by -2.1e-3 / -2.2e-3 and dn by +0.5 %; the remaining 2.4 % in dn is within the documented discretisation spread of a finite-difference solver at this resolution (atlas K2-tidy3d.json: 1.9078 / 1.9010 / 1.8976 at 25 / 12.5 / 6.25 nm vs FEM 1.89417).
- Bend sweep: TE 0.02385 (R 1 um), 1.84e-3 (1.5), 1.5e-4 (2) dB; TM 2.56 (2), 1.116 (5), 0.345 (10) dB per 90 deg (level 0). The engine runStudy of a parametric study solves the base point only; the sweep plot runs through the web sweep machinery (state/sweep.ts), not checked by this lane.
- Regression: 9 em-modes sims bitwise identical (mesh hash, eigenvalues, scalars, field sums of squares, notes): `logs/E2-modes-regress-before-20261118-134215.json` vs `logs/E2-modes-regress-after-20261118-140204.json`.
- `pnpm test` in packages/physics 190 / 190 (`logs/E2-physics-test-20261118-140222.log`), `pnpm check` clean; apps/web `pnpm check` 0 errors; `test_build_matches` ok (54 class-c cases).
- E1 driven cases rerun after D3: WO-70, WO-71, WO-72, RF-70 pass (`logs/E2-cli-e1check-*.log`).

Decisions:
- D1 tolerances: set from the measured level errors with a margin (analytic and converged references), or from the reference's own resolution (other solver: estimate, labelled; digitized figure: half the drawn line extent + 2 px).
- D2 WO-85 gates radii where the digitized curve is not steep and not at the axis: TE 1.25 / 1.5 um, TM 5 / 10 um; others informative.
- D3 (bug fix in prepare.ts, found by the harness): the eval-case fill of an absent property used `!(p in rec)`, so a uniaxial n (`n.perp` / `n.par`) counted as absent and took the single other case material's scalar n (SiO2 n into LN), and an optional property (kappa, emw-2d eps_r ...) was copied from the single case material that has it into every other material (gold kappa into air). Now `has()` (tensor components count) and optional properties come only from the same material id. Sims without an eval case are unaffected (regression above).
- D4 B6: lossy solve + epsG without epsGIm is an error in the kernel and in solveModes (only index.ts passes epsG; it always passes epsGIm in lossy solves).

## 6. Requests (exact)

- R1 (E3 / coordinator, `packages/materials/test/library.test.ts`, materials registry test fails on my uniaxial-n sims by design): change the MAT_SIMS line to
  `const MAT_SIMS = ['ln-fbar-2d', 'pzt4-cube', 'si-microheater-to', 'tfln-mzm-eo', 'tfln-rib-air', 'tfln-rib-oxide'];`
  Checked 2026-11-18 with a temporary copy of both tests: every other sim keeps its seed outcome and all six validate with the merged registry (0 failures).
- R2 (E4, wave2d multi-frequency material dispersion; DevLog-046 O1 / DevLog-042 O4): prepareRun now returns `materialsAt(lambda: number, notes?: string[]): MaterialTable` on the prepared context (type `Prepared` in prepare.ts; returns a copy, cached per lambda; library n, kappa, dndT and em-modes dispersion slopes at lambda; overrides unchanged; out-of-range properties are left out with a note). For a frequency study with several frequencies call `(ctx as Prepared).materialsAt?.(c0 / f)` per frequency and use it in place of `ctx.materials`; the existing note "resolved once, without a wavelength" in prepare.ts can then be dropped by the coordinator once wave2d uses it.
- R3 (CONTRACTS changelog): prepareRun binds library `dkappa_dlambda` (em-modes `loss` + `dispersion`, provenance note); `Prepared.materialsAt(lambda)`; kernel / solveModes reject a lossy epsG without epsGIm; eval-case fill change D3.
- R4 (catalog, coordinator): `si-strip-te0-ng` has an entry in catalog-modes.ts (paired with WO-65); remove it if helper sims should stay out of the library list.

## 7. Open items

- O1 not built: slot waveguide (Almeida 2004 full text not reachable; the only tabulated slot n_eff found, Dell'Olio and Passaro 2007, was computed with COMSOL: excluded), SiN strip (only a measured n_g, Munoz 2017: informative at best), K4 VpiL and the combined thermo-optic + electro-optic phase shifter (em-modes coupled path; not attempted for time).
- O2 WO-84 tolerance is an estimate (other solver and material models); a converged open reference (own FEM convergence is 1.3e-5 between levels) with the same Si / SiO2 models would allow a tight gate.
- O3 WO-85: references are figure readings; PML strength not varied in this lane (DevLog-043 G-LEAK study: spread 0.14 % in Im n_eff for strength 1-4).
- O4 WO-65 ng_energy needs the 506k DOF level for the Richardson gate (about 2.0 GB): stays informative.
- O5 materialsAt is not used by any solver yet (R2).

## 8. Hand-off

Files: `packages/physics/src/prepare.ts` (B5, B7, D3), `packages/physics/src/modes/index.ts` and `vector-mode.mjs` (B6), `packages/physics/test/modes-e2.test.ts` (3 tests), sims `au-air-spp`, `leaky-si-wire`, `tfln-rib-air`, `tfln-rib-oxide`, `si-dc-supermodes`, `si-wire-bend`, `si-strip-te0-ng`, `apps/web/src/lib/library/catalog-modes.ts`, `validation/c/cases_ext/modes.py`, `validation/modes3/{run.ts, references.py, digitize_fig.py, kakihara2006_fig4.json, k1_slopes.py}`, `eval/expected/WO-80..85.json`, `eval/cases/c/WO-80..85.yaml` and `WO-65.yaml` (built), `eval/cases/b/CP-43.yaml` (Z0_real, VpiL_measured extracts), `validation/c/build_cases.py` (WO-65 t2_apply entry only). Rebuild: `cd validation && uv run python modes3/references.py && uv run python c/build_cases.py --force --out <tmp>` then copy the WO-8x files; check with `uv run python c/test_build_matches.py`.
