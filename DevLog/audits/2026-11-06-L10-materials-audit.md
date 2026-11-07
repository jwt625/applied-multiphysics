# Audit: L10 materials library (2026-11-06)

| Field | Value |
|---|---|
| Date | 2026-11-06 (16:24-17:05 PST) |
| Auditor | fresh-context audit subagent (no prior conversation) |
| Target | `materials/*.yaml` (13 files), `packages/materials/**` (`@amp/materials`, schema `amp-material/0`), `DevLog/DevLog-013-materials.md` |
| Context read | `CLAUDE.md`, CONTRACTS-v0 + changelog (L10 entry 16:21), APA `engine/data/materials/{silicon,metals,glass_inorganic,_sources}.yaml` at `608b1dc`, EO `engine/data/materials.json` at `bc68738` (read only, `git show`) |
| Files changed | this file only. No YAML, code or DevLog edited. No git in this repo. |
| Scratch | `<session-scratchpad>/`: `recompute.py` (independent dispersion / fit / unit recomputation), `probe.ts`, `probe2.ts` (getProperty behaviour), `cmpwater.py`, `test-*.log`, `tsc-*.log`, `dl/`, `dl2/`, `dl3/` (fresh downloads) |
| Network | 19 GET + 4 HEAD requests, 3-6 s apart: 4 refractiveindex.info YAML + LICENSE (GitHub raw), arXiv 0805.0091, 4 trc.nist.gov cryogenic pages, Palace `cpw.md`, 3 JANAF tables (Cu, Si, Al), 1 WebBook water isobar, 4 srd.nist.gov JPCRD reprints (Swenson 1983, Ledbetter-Naimon 1974, HPL 1972, Matula 1979) + 4 HEAD requests. No paywall bypass. |

## Verdict

No blocking findings. Every value I checked against its source matches: over 600 numbers across 12 of the 13 files (PZT-4 is all N/A), including 33 Sellmeier / fit coefficient sets. All `via` values match the atlas files at the cited commits. The loader works: 17/17 tests pass, `tsc` is clean, 13/13 files validate, and getProperty throws `MaterialNAError` on N/A and `MaterialRangeError` outside table and fit ranges.

Three significant problems remain, all about conventions and silent use outside the stated conditions, not about transcription:
- **S1.** Scalar and tensor values have no validity range, so getProperty returns room-temperature constants at any T, lambda or f, with no error and no flag.
- **S2.** The reference medium of the refractive index is not recorded. The default fused-silica / thermal-oxide index (Malitson) is relative to air, the Leviton-Frey alternative is absolute, and the API documents lambda as a vacuum wavelength.
- **S3.** The fused-silica dn/dT uncertainty (+-2e-8 /K) understates a 3 % disagreement with the derivative of the library's own Leviton-Frey n(T) fit.

## 1. Values against sources (item 1)

Source access: F = fetched fresh in this audit; C = the L10 cache file (`cache/materials/...`); where I re-fetched a cached file, the sha256 was identical (Malitson.yml, Leviton arXiv PDF, Palace cpw.md, WebBook TSV); A = APA local copy (read only).

| Material.property | Source (access) | Checked | Result |
|---|---|---|---|
| fused-silica.n, sio2-thermal-oxide.n | refractiveindex.info SiO2/nk/Malitson.yml (F) | 7 coefficients, range 0.21-6.7 um, 20 C, formula 1 | match |
| fused-silica.n alt `leviton_frey_corning7980` | arXiv 0805.0091 Table 3 (F) | 30 coefficients; Table 4 at (1.5 um, 295 K) 1.44502, (0.6, 300) 1.45850, (2.0, 30) 1.43716, (1.0, 200) 1.45012 | match; my recompute 1.445025 / 1.458501 / 1.437157 / 1.450123 |
| fused-silica.dndT, sio2-thermal-oxide.dndT | arXiv Table 6, column 295 K (F) | 16 values 0.4-2.6 um | match |
| fused-silica rho, E, G, nu, k, cp, alpha (3 ranges) | Corning HPFS sheet p.3 via Edmund (C) | 2.20 g/cm3, 73 GPa, 31 GPa, 0.16, 1.38 W/(m K), 0.770 J/(g K), 0.52 / 0.57 / 0.48 x1e-6 (5-35, 0-200, -100..200 C), "all values @ 25 C" | match |
| linbo3.n | Zelmon-o.yml, Zelmon-e.yml (F) | 14 coefficients, formula 2, 0.4-5.0 um, 21 C | match |
| linbo3.eps_r, r_eo (+4 alternatives) | EO `materials.json` @ bc68738 (`via`) | 2+2 eps, 4x4 r values, locators | match (primary Weis-Gaylord paywalled, not read) |
| silicon.n alt Salzberg | Si/nk/Salzberg.yml (F) | 7 coefficients, 1.357-11.04 um, 26 C | match |
| silicon.n | Li 1980 Table 1 (C, 150 dpi render) | 33 values of the 293 K column incl. 1.55 um = 3.4757 | match; locator page wrong (M1) |
| silicon.dndT | Li 1980 Table 2 (C, render) | 34 values incl. 1.55 um = 1.818 (1e-4 /K); footnote +-0.15e-4 /K | match; locator page wrong (M1) |
| silicon.rho, C (+McSkimin alt) | Hall 1967 (A, text layer) | 2.3290 +- 0.0002 g/cm3 (p.757); Table III 1.6564 / 0.6394 / 0.7951 and 1.6563 / 0.6387 / 0.7955 (p.758) | match |
| silicon.k | HPL 1972 p.394 (F, render) | 14 values 200-600 K | match |
| silicon.cp | JANAF Si-001 (F) | 8 Cp nodes; c_p = Cp / 28.0855e-3 (e.g. 20.000 -> 712.11) | match |
| silicon.alpha | Swenson 1983 Table 2 p.181 (F) | 15 values 200-600 K | match |
| copper.k / gold.k | HPL p.332 / p.340 (F, render) | 14 + 14 values | match |
| copper.rho_e / gold.rho_e | Matula Table 2 p.1161 / Table 5 p.1209 (F, text) | 10 + 10 values; log-log interpolation rule p.1160 | match |
| copper.E, nu | Ledbetter-Naimon Table 10 (F) | E 1.235 +- 0.007 x1e11 N/m2, nu 0.350 +- 0.009 | match |
| copper.cp | NIST OFHC page (F) + JANAF Cu-001 (F) | a..h of the fit; JANAF 25.318 / 25.912 / 26.481 / 26.996; 300 K JANAF 24.462 | match |
| copper.alpha | NIST OFHC page (F) | 7 coefficients, units 1e-6 /K, error 10 % (T < 50 K) / 5 % | match |
| copper.rho (+ alt), alpha alt; gold rho, E, cp, alpha | NIST solder DB v4 Tables 1.10, 2.2.5, 2.2.7 (C, text) | 8.96, 8.92 (20 C), 17.0; 19.3, 74.4 (cast), 127.5 J/(kg K) (25 C), 14.2 (20 C); Table 1.10 has no G for gold | match |
| aluminum-6061-t6 rho, E, G, nu | MIL-HDBK-5J p.3-264 Table 3.6.2.0(b1) (C, own pdftotext) | 0.098 lb/in3, 9.9 / 10.1 / 3.8 (1e3 ksi), 0.33 | match; SI conversion 2712.6 kg/m3, 68.26 GPa, 26.20 GPa recomputed |
| aluminum-6061-t6 k, cp, alpha, E(T) | NIST 6061-T6 page (F) | 9 + 9 + 5 + 5 coefficients, Tlow 18 K, ranges, errors | match |
| ptfe k, cp, alpha | NIST Teflon page (F) | 9 + 9 + 5 coefficients, errors 5 / 1.5 / 2 %; page lists Young's modulus without a table, no density | match |
| ptfe eps_r, tan_delta | NIST TN 1536 p.71 (C) | "Teflon: (2.05 +-0.02, 2 x 10-4 +-8 x 10-5)" | match (exponents garbled in text layer, consistent with the render reading) |
| sapphire eps_r, tan_delta | Palace cpw.md (F) | 11.5 / 9.3, 8.6e-5 / 3.0e-5, c axis = z | match |
| sapphire.alpha | NIST sapphire page (F) | 5 coefficients, data 20-293 K, equation 15-300 K, 4 %; page has no k, no density | match |
| air rho, cp, c | Lemmon 2000 Table A2 (C, own pdftotext) | all 25 rows x 3 columns of `derive-air.ts`; M = 28.9586 g/mol | match |
| air mu, k | Kadoya 1985 Tables 8, 12 (C, 110 dpi render) | 10 + 10 values, row 0.10 MPa | match |
| water rho, cp, c, mu, k | WebBook isobar TSV (F, identical to cache) | 100 values, all liquid phase | match (script `cmpwater.py`) |
| structural-steel E, nu, G; E alt | NCSTAR 1-3D p.12 (C, 110 dpi render); FHWA-IF-12-052 Vol. 1 (C) | 4 + 5 + 6 coefficients, ranges 0-600 / 0-725 / 0-725 C; 29,000 ksi | match |
| sio2-thermal-oxide eps_r, E, nu, alpha | EO / APA files (`via`) | 3.9; 73.0 GPa, 0.16, 0.5 ppm/C | match the atlas files; primaries not read (see below) |
| fused-silica.eps_r | APA `glass_inorganic.yaml` (`via`) | 3.75 at 100 MHz | matches atlas; Korth page not re-read |
| silicon.eps_r | APA `silicon.yaml` (`via`) | 6 digitized values | matches atlas; Fig. 2 digitization not re-done |

Values taken through an atlas from a secondary or model-input source:

| Value | Atlas basis | Comment |
|---|---|---|
| sio2-thermal-oxide.eps_r 3.9 | EO `verification: secondary_open_access` (Zhu 2021 review, Table 1, "primary_cited: not given") | Labelled `paper_model_input`; acceptable, but this is a review-table value, not a film measurement |
| sio2-thermal-oxide E 73.0, nu 0.16, alpha 0.5 | APA `paper_model_input` (TCPMT 2025 Table IV) | The paper's text says the properties "are listed in Table IV [22]", so they are themselves cited from its ref. [22] (APA local copy, text layer). Second-hand model inputs |
| fused-silica.eps_r 3.75 | APA `datasheet` (Korth reseller page for Heraeus glass) | Vendor reseller page |
| gold rho / E / cp / alpha, copper rho and alternatives | NIST solder DB (compilation of Lange 1956, AIP Handbook 1957, ASM 1993) | Read by L10 directly; marked "as cited" in the locators |
| linbo3 eps_r / r_eo | Weis-Gaylord 1985 (evaluated compilation; primaries Warner 1967 and Turner 1966 not read) | EO classes it primary; the note in `read` is adequate |

## 2. Physics sanity and recomputation (item 2)

Independent script `recompute.py` (Python, own formula code, coefficients typed from the fetched sources):

| Quantity | Recompute | Library (`probe.ts`) | Reference |
|---|---|---|---|
| Malitson n(1.55 um) | 1.444024 | 1.444024 | refractiveindex.info formula 1 |
| Malitson n(0.6328 um) | 1.457018 | 1.457018 | same |
| Zelmon n_o / n_e (1.55 um) | 2.211111 / 2.137560 | 2.211111 / 2.137560 | negative uniaxial, n_e < n_o: correct |
| Salzberg-Tatian n_Si(1.55 um) | 3.477724 | 3.477724 | vs Li 1980 3.4757 at 293 K (Li +-2e-3, 26 vs 20 C) |
| Leviton-Frey n(1.55 um, 295 K) | 1.444431 | 1.444431 | Table 4 checks above |
| Si cubic, from Hall C | E[100] 130.0 GPa, nu[100] 0.2785, E[110] 169.0 GPa, B 97.84 GPa, Zener A 1.564 | - | standard Si anisotropy values; C11 > C12, C44 > 0, C11 - C12 > 0, C11 + 2 C12 > 0 (positive definite) |
| Cu / Au sigma(293 K) | 5.959e7 / 4.517e7 S/m | same | Lorenz number at 300 K from k and rho_e: Cu 2.31e-8, Au 2.40e-8 W ohm / K^2 (Sommerfeld 2.44e-8): consistent |
| Air at 300 K | rho 1.1767, cp 1007, c 347.4 (ideal-gas sqrt(1.4 x 287 x 300) = 347.2), mu 18.57 uPa s, k 26.23 mW/(m K) | same | plausible monotonic trends 200-600 K |
| Water | rho 998.18 at 293.15 K (linear interpolation; node 998.804 at 290 K, 997.807 at 295 K), density maximum between 275 and 285 K in the table, c peaks near 345-350 K | same | consistent with IAPWS behaviour |
| LN eps | eps^S_11 44.3 << eps^T_11 85.2; eps^S_33 27.9 < eps^T_33 28.7 | - | the clamped / unclamped ordering is physically correct |
| Sapphire | eps_par 11.5 > eps_perp 9.3 | - | correct ordering |
| 6061 cp | NIST fit 943 (293.15 K), 954 (300 K), 835 (200 K) J/(kg K) | same | JANAF pure Al (F): 897.2 (298.15 K), 898.7 (300 K), 790.8 (200 K); the fit is 5-6 % higher (M10) |
| PTFE alpha (secant about 293 K) | 2.254e-4 /K at 293 K (tangent of the fit), 1.754e-4 at 250 K; y(293) = -3.90 (x1e-5) | same | see M11 |
| Sapphire alpha | 6.097e-6 /K at 293 K; y(293) = +0.23 (x1e-5) | same | at the end of the data range (20-293 K) |
| Fused silica dn/dT, 1.5 um, 295 K | derivative of the LF fit 8.20e-6 /K | default table 8.45e-6 /K | S3 |

## 3. Units and conventions (item 3)

- SI conversion: `uohm*cm`, `W/(cm*K)`, `J/(g*K)`, `mW/(m*K)`, `uPa*s`, `ppm/K`, `ksi`, `lb/in^3`, `degC` (affine) all convert correctly; the tests and my recomputation agree.
- Voigt: the cubic C matrix is the standard 6x6 stiffness with C44 on the engineering-shear rows. The 3m `r_eo` layout `[[0,-r22,r13],[0,r22,r13],[0,0,r33],[0,r51,0],[r51,0,0],[-r22,0,0]]` is the standard form for the mirror plane perpendicular to x, which is what the frame string says ("y-z mirror plane").
- LN: the default eps is clamped (eps^S), with unclamped as an alternative, and the default r is clamped r^S (633 nm), with unclamped, 3390 nm and Kaminow alternatives. Conditions are stated, and the missing 1550 nm r is listed.
- Hall C are adiabatic moduli; the leaf says so.
- CTE: every alpha leaf has `cte_kind`; secant leaves carry T_ref, and the result returns `cteKind` and `T_ref` (SI). Three leaves record "instantaneous" although the source does not state the kind (M4).
- Not recorded: the refractive-index reference medium (S2), and validity ranges of scalar and tensor values (S1).

## 4. N/A honesty (item 4)

`listNA()` returns 24 leaves, the same set as DevLog-013 s.4.2: air mu_r, eps_r; copper mu_r; fused-silica tan_delta; gold nu, mu_r; linbo3 rho; ptfe rho, E; pzt-4 rho, eps_r, C; sapphire rho, k; silicon E, nu, sigma, tan_delta; sio2-thermal-oxide rho, cp; structural-steel rho, k, cp, alpha. Every leaf has a `missing` reason (the validator enforces it; I spot-checked all 24 texts). Each reason that names a source checks out against that source:
- the NIST sapphire page has only expansion data;
- the NIST Teflon page lists Young's modulus with no table and gives no density;
- NIST solder DB Table 1.10 has an empty G cell for gold;
- the Corning sheet has no electrical properties.

No value is filled without a source. File-level `missing` blocks list the properties that were never authored (LN tensors, water eps, 6061 rho_e and > 300 K data, etc.), matching DevLog s.4.2. Two N/A reasons are incomplete (M5, M6).

## 5. Loader, tests, typecheck (item 5)

| Command (nice 10) | Result |
|---|---|
| `pnpm test` (packages/materials) | 17 tests, 17 pass, exit 0 |
| `pnpm check` (`tsc -p . --noEmit`) | exit 0 |
| `pnpm validate` | 13 files, 13 valid, 0 issues |
| JSON Schema regenerate vs `schema/amp-material-0.schema.json` | identical (sorted-key JSON compare) |

`probe.ts` / `probe2.ts`:
- **N/A:** throws `MaterialNAError` with the `missing` text for silicon.E, silicon.sigma, gold.nu, linbo3.rho and pzt-4.C.
- **Out of range:** throws `MaterialRangeError` for copper.k at 199 K and 700 K, silicon.n at 1.1 um and 15 um, fused-silica.n at 7 um, LN.n at 0.3 um, Leviton-Frey at 310 K, steel E at 700 C and -10 C, 6061 alpha at 350 K, air at 190 K, and water at 380 K.
- **Errors, not range errors:** a NaN or missing variable gives "depends on T", and an unknown component or alternative is named in the message.
- **Extrapolation:** `extrapolate: true` sets `extrapolated`.
- **Defects:** S1 (scalars) and M2 (floating-point upper bound).

## 6. Rights (item 6)

- refractiveindex.info: the fetched YAML headers say "public domain ... CC0 1.0", and the repository LICENSE is CC0 1.0 Universal (F). OK.
- Palace `cpw.md`: Apache-2.0; only 4 numbers are taken.
- No wholesale paywalled table is copied:
  - Weis-Gaylord (Springer): 4 eps and 16 r numbers (selected facts);
  - Hall 1967 (APS): 7 numbers;
  - TCPMT 2025 (IEEE): 3 numbers.
  The local subscription copies stay in the atlas repos; nothing paywalled is added here.
- US-government works (MIL-HDBK-5J, NCSTAR, TN 1536, NIST cryogenic pages, NIST solder DB) raise no issue.
- NIST Standard Reference Data are not public domain: see M12.

## Findings

### Blocking

None.

### Significant

**S1. Scalar and tensor values have no validity range; getProperty applies them at any T, lambda or f, without error or flag.**
- **Evidence (`probe2.ts`):**
  - `getProperty('gold','alpha',{T:1000})` returns 1.42e-5 (source: 20 C value);
  - copper E at 1000 K returns 123.5 GPa (room-temperature polycrystal);
  - fused-silica alpha at 600 K returns 5.2e-7 (secant valid 5-35 C only);
  - silicon C at 1000 K returns the 25 C values;
  - LN eps_r at f = 1e15 Hz returns 44.3 / 27.9.
  None is flagged `extrapolated`.
- **Contradiction:** DevLog-013 s.1.2 says "out-of-range evaluation throws unless `extrapolate` is set". Only `evalTable` and `evalFit` check ranges (`library.ts`); `conditions.T` is free text that is never enforced.
- **Proposed fix:**
  - add an optional `valid: {T?: [lo, hi], lambda?: [...], f?: [...]}` to leaves and alternatives (quantity strings or `{unit, range}`);
  - enforce it in `evalForm` / `evalComponent` with the same `MaterialRangeError` / `extrapolate` semantics;
  - when `valid` is absent, return `rangeUnstated: true` in the result so that L4 can decide;
  - populate it from the existing conditions (Corning 5-35 C; Lange 20 C; Hall 25 C; NIST solder DB "temperature not stated" stays unstated).

**S2. The refractive-index reference medium and wavelength convention are not recorded; the default fused-silica and thermal-oxide n is relative to air.**
- **Evidence:** Leviton-Frey (F, arXiv PDF p.3): "the well-accepted dispersion law for synthetic fused silica in air of Malitson ... we adjust the dispersion law to vacuum assuming the index of air at room temperature to be 1.00027".
- **Size:** at 1.55 um, default Malitson n = 1.444024 and the absolute LF n at 295 K = 1.444431, a difference of 4.07e-4. About 3.9e-4 of that is the air correction (1.444024 x 1.00027 = 1.444414); the rest is 20 vs 22 C.
- **API:** `EvalOptions.lambda` is documented as "vacuum wavelength", while Malitson's lambda is an air wavelength.
- **Unknown here:** the conventions of Li 1980 and Zelmon 1997 were not checked in this audit.
- **Proposed fix:**
  - add `n_reference: air | vacuum` (and the wavelength medium) to n and dndT leaves, and return it in the result;
  - record the convention for Malitson (air), Leviton-Frey (vacuum, absolute) and, after reading, Li 1980 and Zelmon 1997;
  - optionally convert air-referenced fits to absolute index on evaluation, with a sourced n_air(lambda);
  - until then, state in DevLog-013 s.6 that the default and the LF alternative differ by about 4e-4 for this reason.

**S3. Fused-silica dn/dT: the stated uncertainty (+-2e-8 /K) hides a 3 % disagreement with the library's own n(T) alternative; table scatter is interpolated.**
- **Disagreement:** the default `dndT` is Leviton-Frey Table 6 (295 K column), 8.45e-6 /K at 1.5 um. Table 6 is computed from the per-wavelength piecewise-quadratic fits n(T) = aT^2 + bT + c ("dn(T)/dT = 2a T + b", arXiv PDF p.6, F), not from the Sellmeier model. The derivative of the Table 3 Sellmeier model (the `leviton_frey_corning7980` alternative) at (1.5 um, 295 K) is 8.20e-6 /K (`recompute.py`), 3 % lower.
- **Scatter:** the 295 K column is non-monotonic (1.5: 8.45, 1.6: 8.29, 1.8: 8.38, 2.2: 8.11, 2.4: 8.38, 2.5: 8.71, 2.6: 8.48 x1e-6), and linear interpolation passes this scatter through.
- **Understated uncertainty:** the leaf's uncertainty quotes the abstract's +-2e-8 /K "statistical variations", which is 10x smaller than the spread between the two routes.
- **Proposed fix:** either set the uncertainty to the Table 6 vs Sellmeier-derivative spread (state the number and both routes), or make the Sellmeier derivative (smooth, consistent with the n alternative) a named alternative or the default, keeping Table 6 as an alternative. Mirror the change in `sio2-thermal-oxide.dndT`.

### Minor

**M1. Li 1980 page locators are off by one.** Table 1 is on journal p.576 (pdf p.17) and Table 2 on p.578 (pdf p.19). Page p.577 (pdf p.18) is Fig. 8, "Recommended n-lambda-T diagram of silicon" (renders checked). Affected: `silicon.n` and `silicon.dndT` locators, the `li1980.read` text, and DevLog-013 s.4.1 and s.4.3 (CR-5 row). Fix: change to p.576 / p.578.

**M2. Floating-point range boundary.** `getProperty('linbo3-congruent','n',{lambda:5e-6})` throws "lambda = 5.000000000000001 um outside the fit range [0.4, 5]" (the SI-to-um conversion rounds). Fix: compare with a relative tolerance (for example 1e-12) in `evalTable` and `evalFit`.

**M3. Result metadata.**
- The `uncertainty` returned by getProperty stays in source units, while `value` is SI (silicon.rho: value 2329 kg/m3, uncertainty `{abs: 0.0002, unit: g/cm^3}`).
- The derived `sigma` result inherits `basis: measured` and the rho_e uncertainty unchanged.
- Fix: convert `abs` / `range` to SI when a unit is present (or add `uncertaintySI`); set `basis: derived` for the sigma rule, and propagate relative uncertainty.

**M4. `cte_kind` is forced where the source is silent.** Three leaves are recorded as "instantaneous" although the source does not state the kind: copper `handbook_constant` (17.0, ASM as cited, kind not stated), gold alpha (Lange "Thermal Exp. coef. (20 C)"), and sio2-thermal-oxide alpha (paper value; "kind recorded as instantaneous by the APA lane"). Fix: allow `cte_kind: unstated` and let consumers decide, or keep the value but make the assumption an explicit `assumptions` entry.

**M5. Structural steel rho / cp N/A reasons are incomplete.** NCSTAR 1-3D, which L10 cached and used for E, nu and G, states assumed values in App. E (report p.285, pdf p.320, C): "For steel, assume ... C_p = 415 J/kg/K, and rho = 7860 kg/m3". FHWA-IF-12-052 Vol. 1 (C) gives a design G = 11,200 ksi. Fix: either add these as alternatives (`paper_model_input`, locator, "assumed values in an estimate") or extend the N/A reason to say that the read source has only assumed values.

**M6. Silicon tan_delta N/A omits the measured HR-Si point.** The reason is sound: losses are conductivity-dominated. The APA file (`si_hr`, via) holds a measured room-temperature value from Krupka 2006 Table I: 1.866e-3 at 6.685 GHz, sample #1, resistivity not stated. Fix: add it as a per-sample alternative, or name it in the `missing` text.

**M7. Uncertainties marked "not transcribed" are stated in the sources.**
- Swenson 1983 p.181 (F): accuracy "+-0.1 % or +-1e-9 /K, whichever is greater, below 300 K" and up to +-1e-8 /K to 850 K, for `silicon.alpha`.
- Krupka 2006 p.3 (A): "experimental errors in the range of 0.1 %" on eps_r, for `silicon.eps_r`, which carries only the +-0.005 digitization error.

Fix: transcribe them.

**M8. EO commit inconsistency.** DevLog-013 header: EO at `0546007`; YAML `via`: `bc68738`. `materials.json` is identical between the two (`git diff --stat` empty). Fix: cite one commit.

**M9. Cache file name.** `cache/materials/structural-steel/fhwa-hif-16-002-vol1.pdf` contains FHWA-IF-12-052 Vol. 1, November 2012 (cover checked). This is cosmetic, since `cache/` is gitignored. Fix: rename, or note it in the sidecar.

**M10. 6061-T6 cp fit vs JANAF.** The NIST 6061-T6 cp fit gives 943 J/(kg K) at 293.15 K and 954 at 300 K. JANAF pure Al (F) gives 897.2 (298.15 K) and 898.7 (300 K); at 200 K the values are 835 vs 790.8. That is a systematic +5-6 %, at or above the fit's stated 5 %. DevLog-013 s.6 says "within its stated 5 % fit error" without naming the reference value. The alloy-vs-pure-Al difference is not quantified by any source read here. Fix: add the JANAF pure-Al cp as a sensitivity alternative (labelled "pure Al, not 6061") and state the offset in the leaf note.

**M11. PTFE alpha near 293 K.** The secant about 293 K evaluated at 293 K is the tangent of a 4th-order polynomial fit, 2.25e-4 /K, whose own y(293) = -3.9e-5 (self-noted). PTFE has solid-solid transitions near room temperature. This is the auditor's background knowledge, not verified from a source in this audit, so the smooth fit may not represent the local slope. Fix: state in the leaf that values within a few K of 293 K come from the smoothed fit and are not resolved transition data, or limit the range until a source is read.

**M12. NIST Standard Reference Data copyright not recorded.** The WebBook page (C) says "(c) 2026 by the U.S. Secretary of Commerce ... All rights reserved. Copyright for NIST Standard Reference Data is governed by the Standard Reference Data Act". The same regime applies to the JPCRD reprints and JANAF (SRD). `water.yaml` copies 100 WebBook values. CLAUDE.md requires a rights check per file, and DevLog-013 has no rights note for SRD. Fix: add a rights line to DevLog-013 for SRD-derived files (attribution present; extract size).

**M13. Accepted by trust (not re-verified in this audit).** Three `via` values were checked against the atlas file only, not against a source:
- `silicon.eps_r` (Krupka Fig. 2 digitization);
- `fused-silica.eps_r` (Korth page);
- `sio2-thermal-oxide` eps_r / E / nu / alpha (Zhu 2021 Table 1 and TCPMT 2025 Table IV are images; TCPMT itself cites ref. [22]).

Nothing to fix unless a later lane needs a primary.

## Checks that passed (no action)

- Every `source` key resolves.
- Every non-N/A leaf has unit, basis, source, locator, accessed date, uncertainty and conditions (validator).
- Every table is strictly increasing.
- Every fit range matches its source (6061 k limited to the 4-300 K data range rather than the 1-300 K equation range: a conservative choice).
- Every formula id is implemented, and the coefficient names are checked.
- No numeric literal for a property in `src/`.
- ISO dates throughout; no emoji.
