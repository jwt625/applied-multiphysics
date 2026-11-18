# DevLog-041: materials for photonics and advanced packaging (lane T4, chunk 1, DevLog-037 A3)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | T4 (materials) |
| Owns | `materials/**`, `packages/materials/**`, this file |
| Inputs | CLAUDE.md; DevLog-037 s.1-s.3 (row T4); DevLog-013 (schema `amp-material/0`, package `@amp/materials`); CONTRACTS-v0 C1, C3, C11 changelog (material property names); DevLog-035 R3, R4, s.11 (gaas.yaml, photoelastic gap); `sims/chip-warpage-2d.yaml` (read only) |
| Prior art (read only) | advanced-packaging-atlas (APA) at `fe39985`: `engine/data/materials/*.yaml`, `_sources.yaml`; eo-modulator-atlas (EO): `engine/data/materials.json` |

Conventions: F = fact read from a file or source; E = estimate; D = decision; O = open item.

## 1. Plan (written 2026-11-18 08:50 PST, before editing)

### 1.1 Baseline (F, 2026-11-18 08:48 PST)

- `pnpm --filter @amp/materials test`: 22 / 22 pass. `validate`: 15 files, 15 valid, 0 issues. DevLog-035 R4 (the "sims/ outcomes unchanged" test failing for sims with material-registered properties) no longer reproduces: the test passes today (status recorded in s.3).
- Property types: 20 (`rho, E, nu, G, C, e_piezo, k, cp, alpha, eps_r, tan_delta, mu_r, sigma, rho_e, n, dndT, r_eo, c, mu`). No photoelastic tensor, no extinction coefficient / complex index, no glass transition temperature.
- Formulas: `sellmeier-c2`, `sellmeier-c` (both with a constant term A), `gas-dispersion`, Leviton-Frey, NIST cryogenic forms, `poly`. No Cauchy form. Fits with cited coefficients exist for fused silica (Malitson), LN (Zelmon o / e), GaAs (Skauli), Si (Salzberg-Villa / Tatian, alternative; the default Si n is the Li 1980 table, linear interpolation).
- Disk: about 3 GiB free. No PDFs or datasets kept on disk: fetched files go to the session scratchpad, a text excerpt is kept there, the binary is deleted after reading.

### 1.2 Package changes (`packages/materials`)

1. Property `p_pe`: photoelastic tensor p_IJ (unit 1), Voigt 6x6, convention Delta(eps^-1)_I = p_IJ S_J with engineering shear strain (as `@amp/physics` optomech/tensors.ts). Symmetries: `cubic` (p11, p12, p44) and `trigonal-3m` (p11, p12, p13, p14, p31, p33, p41, p44; p66 = (p11 - p12) / 2; x = a axis, mirror plane y-z, the r_eo / C convention of this package). `tensorMatrix(sym, c, 'p_pe')` returns the full non-symmetric 6x6.
2. Property `kappa`: extinction coefficient (imaginary part of the complex refractive index N = n + i kappa, e^{-i omega t} sign convention, kappa >= 0 for loss), unit 1, scalar or uniaxial; needs `n_medium` like `n`. Metals and lossy dielectrics store `n` and `kappa` as tables in vacuum wavelength. Complex permittivity follows: eps = (n + i kappa)^2.
3. Property `Tg`: glass transition temperature (K), scalar, with the method (DMA / TMA / DSC) in `conditions.text`. Packaging polymers store alpha1 as the default `alpha` (valid up to Tg) and alpha2 as alternative `above_tg` (valid from Tg); no step function is invented.
4. Formulas: `cauchy` (n = A + B / lambda^2 + C / lambda^4), `sellmeier-c2` and `sellmeier-c` already cover the Sellmeier forms; `li1980-si` if Li 1980 eq. (22) can be read from the page render (smooth n(lambda, T) for Si group index).
5. Helper `src/dispersion.ts` for lane S2: `dispersion(lib, id, lambda, opts) -> {n, dn_dlambda, ng, kappa?, epsRe?, epsIm?, ...provenance}` (central difference on the stored n; tables flagged as piecewise linear), and `complexIndex(lib, id, lambda)`.
6. Tests: photoelastic matrices (cubic, 3m), Si and GaAs p values, kappa / complex eps of a metal, Cauchy and new Sellmeier entries against printed values, group index of fused silica against a closed-form derivative, Tg / alpha2 alternative.

### 1.3 Materials (priority = use in chunk 2 examples)

| Priority | id (planned) | Target sources (primary first) |
|---|---|---|
| 1 | `sin-lpcvd` | n: Luke et al. 2015 Sellmeier (LPCVD stoichiometric); dn/dT: Arbabi-Goddard 2013; others where a primary is readable, else N/A |
| 1 | `aluminum` (pure) | k HPL 1972 (APA via); rho_e Desai et al. 1984 (JPCRD, open); alpha, rho, E from NIST solder DB (handbook) ; n, kappa at 1550 nm (Rakic 1995 or McPeak 2015) |
| 1 | `gold` (add) | n, kappa vs lambda (Olmon 2012 or Johnson-Christy 1972) |
| 1 | `tin-film`, `tungsten` | n, kappa near 1550 nm; W k (HPL 1972), rho_e; TiN film electrical / thermal values only from a named deposition |
| 1 | `underfill-uf8830s`, `emc-cv8710` | Henkel LOCTITE ECCOBOND UF 8830S TDS; Panasonic CV8710 data sheet (E, alpha1 / alpha2, Tg, k, rho) |
| 1 | `sac305`, `nickel`, `borofloat33` | Indium Corp. Indalloy 256 PDS; HPL 1972 + Ledbetter-Reed 1973 (APA via); SCHOTT BOROFLOAT 33 data sheet |
| 1 | `silicon`, `gaas` (add) | `p_pe` cubic from the best readable source; GaAs Cij if readable |
| 2 | `germanium` | Li 1980 Table (Ge, local cache), dn/dT; k HPL 1972 |
| 2 | `inp` | n Pettit-Turner 1965 Sellmeier (database entry as pointer) |
| 2 | `aln` | n_o, n_e (uniaxial) |
| 2 | `abf-gl102`, `bt-core`, `polyimide` | named grade only (vendor data sheet, else paper values for the named grade, labelled) |
| 2 | `ito`, `ta2o5` or `tio2`, `bcb` | named deposition / product |
| 3 | `tantalum`, `sic-4h`, `litao3` | if sourced |

Rules applied: every value has unit, basis, source, locator, ISO access date, uncertainty or `{na}`, conditions, `valid`; database entries (refractiveindex.info) only as a pointer, citing the primary paper, `read` saying what was actually read; vendor values name the product and document; no averaging across vendors; N/A with `missing` when no source was read.

### 1.4 Requests that will go to the coordinator (s.5)

- chip-warpage-2d overrides that materials can now replace (T3 owns `sims/`).
- Any registry consequence of the new property types (`p_pe`, `kappa`, `Tg`) for `physicsRegistry()` (registrations.ts is the coordinator's).

## 2. TODO

- [x] Plan (this section) before editing
- [x] Property types `p_pe`, `kappa`, `Tg`, `tcr`; formulas `cauchy`, `sellmeier-general`, `li1980-eq22`; dispersion helper
- [x] Tests for the new types and helper (`test/photonics-packaging.test.ts`, 10 tests)
- [x] Priority-1 materials (Si3N4, Al, Au optics, W, TiN film, underfill, EMC, SAC305, Ni, BOROFLOAT 33, Si / GaAs p_pe)
- [x] Priority-2 materials (InP, AlN, ABF GL-102, BT HL832NX, polyimide PI-2600, ITO, Ta2O5 film, BCB)
- [x] Priority-3 materials as sourced (LiTaO3, SiC 4H); not authored: Ge, Ta / TaN (s.4.3)
- [x] Validator, tests, tsc; summary of N/A gaps
- [x] S2 API section, coordinator requests, hand-off
- [ ] Fresh-context audit (coordinator)

## 3. Progress log

- 2026-11-18 08:47 PST: read CLAUDE.md, DevLog-037, DevLog-013, CONTRACTS-v0 (material parts), DevLog-035 R3 / R4 / s.11, package sources, `silicon.yaml`, `gaas.yaml`, `sims/chip-warpage-2d.yaml`, APA and EO material data. Baseline: 22 / 22 tests, 15 / 15 files valid.
- 2026-11-18 08:50 PST: plan written.
- 2026-11-18 08:55-09:00 PST: package: property types `p_pe` (cubic, trigonal-3m), `kappa`, `Tg`, `tcr`; formula `cauchy`; `src/dispersion.ts` (`dispersion`, `complexIndex`), exported from the index; `tsc` clean.
- 2026-11-18 08:58-09:05 PST: sources: refractiveindex.info entries (20 + 3 small YAML files to the session scratchpad, 3 s apart, sha256 recorded in each `read`); Arbabi-Goddard abstract (Illinois portal); Luke 2015 abstract (NCBI eutils); Li 1980 eq. (22) read from 220 dpi renders of journal p.567-568 (local cache). Li's printed dL/L293 polynomials are not consistent with dL(293) = 0 (they give -0.0703 and -0.0208 at 293 K; with them read as fractions eq. (22) misses Table 1 at 293 K by up to 2.4e-2, read as percent by up to 1.8e-4, with L = 1 by <= 3.5e-5; computed by T4): formula `li1980-eq22` with L = 1, restricted to 293 K.
- 2026-11-18 09:00-09:10 PST: vendor documents fetched to the scratchpad, text extracted, PDFs deleted: Henkel UF 8830S TDS, Panasonic CV8710 data sheet, SCHOTT BOROFLOAT 33, Indium Indalloy 256 PDS, Dow CYCLOTENE 3000 guide, HD MicroSystems PI-2600 technical information, MGC HL832NX web page, Baker 2014 arXiv; PMC full text of Minenkov 2024 (ITO). Blocked and not retried: opus4.kobv.de (HTML challenge), Europe PMC (HTTP 503), orbit.dtu.dk PDF (HTTP 403); HD-4100 and PI-2611 links were safety data sheets (no properties, discarded).
- 2026-11-18 09:00-09:15 PST: materials written (19 new files, 2 extended: silicon, gaas, gold); `validate` 34 / 34 after each file.
- 2026-11-18 09:17 PST: gates: `pnpm --filter @amp/materials test` 32 / 32 pass (`logs/T4-test-20261118T091745.log`), `validate` 34 files, 34 valid, 0 issues (`logs/T4-validate-20261118T091745.log`), `tsc --noEmit` clean; `pnpm table` evaluates every new leaf at the reference conditions (no errors; rows in s.4.1).

## 4. Results

### 4.0 Package changes (`packages/materials`)

| File | Change |
|---|---|
| `src/properties.ts` | `kappa` (extinction coefficient, unit 1, scalar or uniaxial; N = n + i kappa, eps = N^2), `p_pe` (photoelastic p_IJ, Voigt 6x6, Delta(eps^-1)_I = p_IJ S_J with engineering shear, as `@amp/physics` optomech/tensors.ts; cubic p11 p12 p44, trigonal-3m p11 p12 p13 p14 p31 p33 p41 p44 with p66 = (p11 - p12)/2, Nye class 3m with x = a axis, mirror plane y-z), `Tg` (K), `tcr` (1/K); `tensorMatrix(sym, c, 'p_pe')` |
| `src/formulas.ts` | `cauchy` (n = A + B/l^2 + C/l^4), `sellmeier-general` (refractiveindex.info formula 4), `li1980-eq22` (Si, Li 1980 eq. (22) with L = 1) |
| `src/dispersion.ts` | `dispersion(lib, id, lambda, opts)`, `complexIndex(lib, id, lambda, opts)` (s.5) |
| `src/validate.ts`, `src/library.ts` | `kappa` needs `n_medium` like `n`; air-referenced kappa scaled by n_air like n |
| `test/photonics-packaging.test.ts` | 10 tests: Si / GaAs p_pe and 6x6 forms, 3m form, kappa and complex eps (Au, Al, ITO nodes), formulas, Li eq. (22) vs Table 1 (<= 5e-5), fused-silica n_g vs closed-form derivative (< 2e-6), group index of SiN / LN / GaAs / InP / Si, Si3N4 values, Tg / alpha1 / alpha2 and data-sheet values in SI, registry |

Bases used in the new leaves: datasheet (vendor documents, typical values, not specifications), handbook (NIST solder database compilation; each value names the compiled source), measured (papers, database entries pointing to papers), paper_model_input (values printed in peer-reviewed model tables: Si / GaAs p_pe, ABF GL-102, SAC305 E(T)), derived (nu = E/(2G) - 1; unit rescalings).

### 4.1 Materials added or extended (values at 293.15 K / 1550 nm vacuum unless stated; SI from `pnpm table`)

| id | key values | sources |
|---|---|---|
| `si3n4-lpcvd` (new) | n 1.9963 (Luke fit 0.31-5.5 um); alt n 1.977 +- 0.003 at 1550 nm (LPCVD stoichiometric); dn/dT 2.45e-5 +- 0.09e-5 /K; rho, E, nu, alpha, k, eps_r N/A | Luke 2015 (database entry), Arbabi-Goddard 2013 abstract |
| `silicon` (ext.) | p_pe p11 -0.094, p12 0.017, p44 -0.051 (alt Baker 3.39 um: -0.09); n alt `li1980_eq22` (293 K, 1.2-14 um, smooth) | Chan 2012 (citing Biegelsen 1974), Baker 2014; Li 1980 eq. (22) |
| `gaas` (ext.) | p_pe p11 -0.165, p12 -0.140, p44 -0.072 at 1.15 um | Baker 2014 Table 2 (citing CRC Handbook 2012) |
| `gold` (ext.) | n 0.524, kappa 10.74 (Johnson-Christy, 0.41-1.94 um, linear between the coarse nodes 1.393 / 1.610 um); alt Olmon evaporated n 0.323, kappa 10.62 at 1.55 um (0.4-2.47 um) | Johnson-Christy 1972, Olmon 2012 (database entries) |
| `aluminum` (new) | rho 2702; E 68.9 GPa, G 26.5, nu 0.300 (derived); k(T) 236.8; cp 902.1; alpha 23.03 ppm/K; rho_e 2.62e-8 ohm m; tcr 4.2e-3 /K; n 1.578, kappa 15.66 (Rakic), alt McPeak | NIST solder DB v4 (Lange, AIP, Smithells), HPL 1972 (APA via), Rakic 1995, McPeak 2015 |
| `tungsten` (new) | rho 19300; E 340 GPa (alt 411), G 135, nu 0.259 (derived); k 169 (alt 174, 0-100 C); cp 135.9; alpha 4.0 ppm/K; rho_e 5.48e-8; tcr 4.8e-3 /K (300 K); n 2.230, kappa 4.83 (Ordal) | NIST solder DB v4, Ordal 1988 |
| `nickel` (new) | rho 8900; E 210 GPa; nu 0.296 +- 0.029; k(T) 91.5; cp 442.6; alpha 12.8 ppm/K; rho_e 6.9e-8; tcr 6.8e-3 /K; mu_r N/A | NIST solder DB v4, HPL 1972 and Ledbetter-Reed 1973 (APA via) |
| `tin-film` (new) | n 2.172, kappa 8.00 (50 nm pulsed-DC sputtered); rho_e, k, alpha, tcr N/A | Beliaev 2023 (database entry, abstract) |
| `ito-xy15s` (new) | n 0.224, kappa 1.43 at 1.55 um (ENZ near 1.2 um for this film); rho_e 1.4e-6 +- 0.2e-6 ohm m (4-wire), alt 1.7e-6 (ellipsometry) | Minenkov 2024 (open access, Table 1; n, k database entry of its Fig. 3 data) |
| `inp` (new) | n 3.1649 (0.95-10 um, room temperature) | Handbook of Optics fit of Pettit-Turner 1965 (database entry) |
| `aln` (new) | n_o 2.1199, n_e 2.1602 (0.22-5 um) | Pastrnak-Roskovcova 1966 (database entries) |
| `litao3` (new) | n_o 2.1189, n_e 2.1228 (table 0.45-4 um) | Bond 1965 (database entries) |
| `ta2o5-film` (new) | n 2.0856 (ion-assisted e-beam, 0.4-1.8 um) | Gao 2012 (database entry) |
| `sic-4h` (new) | n_o 2.5644, n_e 2.6087; E, alpha, rho N/A (polytype-unstated handbook values as alternatives only); k N/A | Wang 2013 (database entries), NIST solder DB Table 2.2.6 |
| `underfill-uf8830s` (new) | E 11.5 GPa (DMA storage, 25 C); alpha1 25 ppm/K (25-118 C), alt above_tg 100; Tg 118 C TMA (alt 126.5 DMA); nu, k, rho N/A | Henkel TDS (January 2017) |
| `emc-cv8710u` (new) | E 24 GPa (flexural, 25 C), alt 0.7 GPa at 260 C; alpha1 9, alt alpha2 36 ppm/K; Tg 160 C (TMA); rho 1980; k 0.95; eps_r 4.0, tan_delta 0.010 at 1 MHz; nu, cp N/A | Panasonic CV8710 data sheet No. 200908-3 |
| `sac305` (new) | rho 7350, k 61, rho_e 13.2e-8 (data sheet); E(T) 52.5 GPa (-50 C) to 33.6 GPa (220 C), nu 0.29, alpha(T) 20.5-25.0 ppm/K (paper model inputs); data-sheet E 6.9 GPa, nu 0.35, alpha 21 as alternatives | Indium PDS 100346 R0; TCPMT 2025 Table III (APA via) |
| `borofloat33` (new) | rho 2230; E 64 GPa; nu 0.2; alpha 3.25 ppm/K secant 20-300 C; Tg 525 C; k 1.2 (90 C); cp 830; eps_r 4.6, tan_delta 0.0037 (1 MHz); n_d 1.471 | SCHOTT data sheet (2019 file) |
| `abf-gl102` (new) | E 13 GPa; nu 0.29; alpha 20 ppm/K in-plane (25-150 C), alt 49 (150-240 C); Tg 171 C (DMA); k, eps_r N/A | ECTC 2025 / 2024 / 2026 papers (APA local copies, re-read) |
| `bt-hl832nx` (new) | E 28 GPa; nu 0.19; alpha1 14, alt alpha2 5 ppm/K (in-plane); Tg 230 C DMA (alt 200 TMA); rho 2100; cp 1000; k 0.8; eps_r 4.9 / 4.8 / 4.7, tan_delta 0.011 / 0.011 / 0.012 at 1 / 5 / 10 GHz | MGC product web page |
| `polyimide-pi2600` (new) | E 8.5 GPa; alpha 3 ppm/K; Tg 360 C; rho 1400; k 0.1046 (from 25e-5 cal/(cm s C)); eps_r 2.9, tan_delta 0.002 at 1 kHz; nu, cp N/A | HD MicroSystems PI-2600 technical information (2018-02-06) |
| `bcb-cyclotene3000` (new) | E 2.9 +- 0.2 GPa; nu 0.34; alpha 42 ppm/K (RT); k 0.29 (24 C); eps_r 2.575 (estimate: midpoint of 2.50-2.65 at 1-20 GHz), tan_delta 0.0014 (midpoint of 0.0008-0.002); n, Tg N/A | Dow CYCLOTENE 3000 guide (Feb 2005) |

Spreads worth knowing (F, from the stored data): SiN n at 1550 nm 1.996 (Luke fit) vs 1.977 (Arbabi LPCVD) = -0.019; Au n at 1.55 um 0.524 (Johnson-Christy, linear between nodes) vs 0.323 (Olmon evaporated), kappa 10.74 vs 10.62; W optical constants of Werner 2009 differ from Ordal 1988 by about 1 in n near 1.24 um (not stored).

### 4.2 Properties left N/A (new files; reason in `missing`)

Si3N4 film: rho, E, nu, alpha, k, eps_r (no open primary reached). TiN film: rho_e (Beliaev full text HTTP 403), k, alpha, tcr. SiC 4H: E (needs 6mm C), alpha, rho, k (4H-specific primary not read). Underfill UF 8830S: nu, k, cured rho (not on the TDS). EMC CV8710U: nu, cp. ABF GL-102: k, eps_r. Polyimide PI-2600: nu, cp. BCB: n (optical), Tg (only "> 350 C"). Aluminum, nickel: mu_r. InP, AlN, LiTaO3, Ta2O5: only optical data authored (other properties listed under file-level `missing`).

### 4.3 Not authored

- Germanium: Li 1980 (local cache) covers Ge only at 1.9-16 um (eq. (28)); n, k at 1550 nm (absorbing) need another source (database entries Nunley, Jellison, Aspnes exist, not evaluated). Time-boxed out.
- Ta / TaN barrier: no open primary read (Ta k is in HPL 1972, not cached; TaN film data deposition specific).
- NiCr, Pt heaters, AlGaAs, InGaAsP, SU-8, low-k: not attempted in this chunk.

## 5. API for lane S2 (mode solver: material dispersion, complex permittivity)

```ts
import { loadLibrary } from '@amp/materials/node';          // browser: createLibrary(docs) as apps/web/src/lib/materials.ts
import { dispersion, complexIndex } from '@amp/materials';
const lib = loadLibrary();
dispersion(lib, 'si3n4-lpcvd', 1.55e-6);                    // {n, dn_dlambda (1/m), ng, epsRe, epsIm, kappa?, derivative: 'smooth', h, nValue, extrapolated}
dispersion(lib, 'silicon', 1.55e-6, { T: 293, alternative: 'li1980_eq22' });   // smooth Si dispersion (default Si n is a table)
dispersion(lib, 'linbo3-congruent', 1.55e-6, { component: 'par' });           // uniaxial: 'perp' = n_o, 'par' = n_e
complexIndex(lib, 'gold', 1.55e-6);                         // {n, kappa, epsRe = n^2 - kappa^2, epsIm = 2 n kappa}
```

- lambda is the vacuum wavelength in m; n is relative to vacuum (air-referenced data are converted, DevLog-013 s.7 S2).
- dn/dlambda is a central difference of the stored n over +-h, h = relStep x lambda (default relStep 1e-4). `derivative` says whether n is a fit ('smooth'), a table ('piecewise-linear': n_g then reflects the slope of the table segment and is only as good as the node spacing; at a node the two segments are averaged) or a constant.
- Smooth fits available for n_g at 1550 nm: fused silica and thermal oxide (Malitson; Leviton-Frey with T), SiN (Luke), Si (`li1980_eq22`, 293 K; or `salzberg_villa_tatian`), LN o / e (Zelmon), GaAs (Skauli), InP (Pettit-Turner), AlN o / e, SiC 4H o / e. Tables: Au, Al, W, TiN, ITO, Ta2O5, LiTaO3, default Si.
- Loss: `kappa` exists for gold, aluminum, tungsten, tin-film, ito-xy15s. Sign convention: eps = (n + i kappa)^2 with kappa >= 0 for loss under exp(-i omega t); with exp(+j omega t) use eps = epsRe - j epsIm. em-modes `epsIm` can take `epsIm` directly.
- Throws `MaterialRangeError` outside a fit / table / `valid` range unless `{extrapolate: true}` (result flagged); `MaterialNAError` for N/A.

## 6. Requests

To the coordinator:
1. CONTRACTS-v0 changelog: new material property names `p_pe` (photoelastic, Voigt 6x6, cubic / trigonal-3m), `kappa` (extinction coefficient), `Tg` (K), `tcr` (1/K); formulas `cauchy`, `sellmeier-general`, `li1980-eq22`; helper `dispersion` / `complexIndex`. They register through `registerMaterialProperties`, so `physicsRegistry()` picks them up without a registrations.ts change (the "sims/ outcomes unchanged" registry test still passes).
2. prepareRun (`packages/physics/src/prepare.ts`, not owned here): when a mode study reads materials at its wavelength, also read `kappa` (optional) so em-modes can set `epsIm = 2 n kappa` from the library; flatten `p_pe` to `p_pe.p11` etc. if the optomechanical coupling should read library photoelastic constants instead of `settings.photoelastic`.
3. DevLog-035 R4 (materials test failing for sims with material-registered properties): no longer reproduces; the test passes (32 / 32 in this lane's run). Close it.

To lane T3 (`sims/chip-warpage-2d.yaml`, not edited here):
- The paper-exact overrides (ECTC 2011 Table 2: core E 18.9 GPa / CTE 11, C4 UF 8.5 GPa / 32, Si 150 GPa / 3) should stay: they define the case. No library material is the ECTC 2011 core or underfill.
- Replaceable estimates: `core.nu` 0.11 (atlas template) could cite `materials/bt-hl832nx` nu 0.19 (MGC data sheet of a named BT core laminate) as an analog with that basis; `c4uf.nu` 0.29 has no sourced replacement (the UF 8830S TDS gives no Poisson ratio). `si.nu` already derives from `materials/silicon` C.
- `k` overrides (basis user, T uniform) could cite `materials/bt-hl832nx` k 0.8, `materials/underfill-uf8830s` (k N/A) and `materials/silicon` k; not needed for the result.
- New packaging examples (chunk 2, A5) can reference: `underfill-uf8830s`, `emc-cv8710u`, `sac305`, `bt-hl832nx`, `abf-gl102`, `polyimide-pi2600`, `bcb-cyclotene3000`, `borofloat33`, `nickel`, `tungsten`, `aluminum`, `copper`, `silicon`. Underfill / EMC: `alpha` is valid below Tg only; above Tg use `{alternative: 'above_tg'}` (the library does not switch automatically).

## 7. Hand-off

Commands: `pnpm --filter @amp/materials test | check | validate | table`. State: 34 material files valid; 32 / 32 tests; tsc clean. Fetched documents are not kept (text excerpts in the session scratchpad only); every `read` field names the document, date and sha256 prefix.
