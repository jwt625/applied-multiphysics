# DevLog-013: materials library (lane L10, `materials/`, `@amp/materials`)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L10 (materials) |
| Owns | `materials/**`, `packages/materials/**`, this file |
| Inputs | DevLog-001 s.6 (physics honesty, rights), s.7 (`materials/`); CONTRACTS-v0 C1, C3 + changelog; DevLog-003 (spec registry, `materials/<id>` refs, `N/A` + `missing`); `sims/*.yaml`; DevLog-007 s.6 CR-5; DevLog-010 (L4 consumer) |
| Prior art (read only) | advanced-packaging-atlas (APA) at `608b1dc`: `engine/src/materials/schema.mjs`, `engine/data/materials/*.yaml`, `_sources.yaml`, DevLog-010 A6; eo-modulator-atlas (EO) at `0546007`: `engine/data/materials.json`, DevLog-038 |

## 1. Plan (written 2026-11-06 15:52 PST, before coding)

### 1.1 Schema `amp-material/0` (one YAML per material, `materials/<id>.yaml`, id = file stem)

Top level (strict keys): `schema, id, name, class, description, verified_on, frame?, sources, properties, missing?, assumptions?`.

- `sources`: map `key -> {citation, doi?, url?, access (open | vendor_open | paywalled | local_cache), read, via?}`. `read` says what this lane (or the prior-art lane named in `via`) actually read. Every leaf `source` names a key here.
- `properties`: map `name -> leaf`; names are the registered property types (s.1.3).
- Leaf, exactly one value form:
  - `value`: number, or `N/A` (then `missing` text is required and no number may appear);
  - `table`: `{x: T | lambda | f, x_unit, x[], y[], interp: linear | loglog}`, x strictly increasing; the valid range is the table span;
  - `fit`: `{formula, x, x_unit, coeffs, valid [lo, hi]}`; formula ids are implemented and unit-tested in the package (Sellmeier forms, NIST cryogenic log-polynomial, polynomials);
  - `tensor`: `{symmetry: isotropic | cubic | uniaxial | trigonal-3m | ..., components: {name: number | N/A | sub-leaf with table/fit}}`.
- Every non-N/A leaf: `unit` (source unit, parseable by `@amp/core/units`; converted to SI on load), `basis`, `source`, `locator` (table / page / equation), `accessed` (ISO date of the read), `uncertainty` (`{abs | rel | range, note?}` or `N/A` with reason in `note`), `conditions` (`{T?, p?, lambda?, f?, text?}`), `alternatives` (list, may be empty: `{id, use, ...leaf}`).
- Basis vocabulary: APA A6 `datasheet | handbook | measured | paper_model_input | derived`, plus `standard` (design-code value, e.g. Eurocode) and `reference_correlation` (value computed from a reference equation of state / correlation, e.g. IAPWS via NIST). `measured` covers evaluated compilations of measurements (HPL 1972, Matula 1979), as in APA.
- CTE (`alpha`) declares `cte_kind: instantaneous | secant`, and secant needs `T_ref` (APA A6).
- Derived values are explicit: `derivation` text on the leaf, or package rules listed in the README of the package (only `sigma = 1 / rho_e`), and the result of `getProperty` says so.
- JSON Schema exported from the same zod definition (as `@amp/spec`).

### 1.2 Package `@amp/materials`

- `src/schema.ts` (zod, JSON Schema export), `src/formulas.ts` (formula registry + evaluation), `src/library.ts` (validate, convert to SI via `@amp/core/units`, evaluate at T / lambda / f, tensors to matrices), `src/registry.ts` (property definitions; registration into an `@amp/spec` registry, superseding only provisional seeds), `src/node.ts` (load `materials/` from disk).
- API for L4: `getProperty(materialId, prop, {T, lambda, f, component?, extrapolate?}) -> {value, unit, source, basis, locator, conditions, derived?}`; value in SI (reference unit of the property); out-of-range evaluation throws unless `extrapolate` is set; N/A throws a `MaterialNAError` carrying the `missing` text.
- Runtime deps: `zod` and `yaml` at the versions already pinned by `@amp/spec` (contract request, C1).

### 1.3 Property types

Registered names (reference SI unit): existing spec seed `E, nu, rho, k, cp, alpha, eps_r, tan_delta, mu_r, sigma, n, c`; new `C` (stiffness tensor, Pa), `r_eo` (linear EO tensor, m/V), `mu` (dynamic viscosity, Pa s), `rho_e` (electrical resistivity, ohm m), `dndT` (thermo-optic coefficient, 1/K), `G` (shear modulus, Pa). Tensor properties cannot be overridden in a spec today (override is scalar-only): contract request.

### 1.4 Tier-1 set and sources (primary first; APA / EO primaries re-used with `via`)

| id | Main sources planned |
|---|---|
| structural-steel | EN 1993-1-1 s.3.2.6 (E, G, nu, alpha), EN 1993-1-2 s.3.4 (k(T), cp(T)), EN 1991-1-1 (density); AISC 360 as alternative |
| aluminum-6061-t6 | NIST cryogenic materials page 6061-T6 (fits 4-300 K); MIL-HDBK-5J if obtainable |
| copper | HPL 1972 k(T), Matula 1979 rho_e(T), Ledbetter-Naimon 1974 E, nu (APA primaries), NIST cryo OFHC fits, susceptibility source for mu_r |
| gold | HPL 1972, Matula 1979 (APA / EO primaries); density, E, nu if a primary is found |
| air | JPCRD / NIST reference correlations (Lemmon et al. 2000 EOS, Lemmon-Jacobsen 2004 transport, Kadoya et al. 1985) at 0.101325 MPa |
| water | IAPWS formulations via NIST Chemistry WebBook isobaric table at 0.101325 MPa |
| silicon | Hall 1967 Cij + density, HPL 1972 k, Swenson 1983 alpha, JANAF cp, Krupka 2006 eps_r (APA primaries); Salzberg-Villa / Tatian n (EO); Li 1980 n(lambda, T) if readable |
| fused-silica, sio2-thermal-oxide | Malitson 1965 n; Leviton-Frey dn/dT; vendor data sheet k, E, nu, alpha |
| linbo3-congruent | Zelmon 1997 n_o, n_e (EO); Weis-Gaylord 1985 eps^S / eps^T and r^S / r^T (EO DevLog-038) |
| ptfe | NIST permittivity measurements; vendor property sheet |
| sapphire | Palace cpw.md and its cited source (anisotropic eps) |
| fr-4 | only with a public primary source; else not authored (listed) |
| pzt-4 | Boucher et al. 1981 if obtainable; else N/A with `missing` |

Case-defined values (NAFEMS k = 52, WO-02 indices, RF-01 eps 2.08, AC-02 c 343) stay in the cases.

### 1.5 Gates

1. Every `materials/*.yaml` validates (schema + semantic checks: source keys exist, units parse to the property dimension, tables increasing, fit ranges, N/A has `missing`).
2. Loader tests: unit conversion, table and fit evaluation against values printed in the sources, range errors, tensors, N/A, registry.
3. Summary table (material, property, value at reference conditions, unit, basis, locator) generated from the files.
4. List of properties left N/A and why.

## 2. TODO

- [x] Schema `amp-material/0` (zod) + JSON Schema export (`packages/materials/schema/amp-material-0.schema.json`, 45.6 kB)
- [x] Formula registry, loader, evaluation, tensors, registry hook, Node loader
- [x] Research and author the tier-1 YAML files (13 files)
- [x] Tests (17/17)
- [x] Summary table, N/A list
- [x] Contract requests, hand-off
- [ ] Fresh-context audit (coordinator, after hand-off)
- [ ] FR-4: not authored (no public primary source found, s.4.3)

## 3. Progress log

- 2026-11-06 15:51 PST: Read CLAUDE.md, DevLog-001, CONTRACTS-v0, DevLog-003, sims/*.yaml, DevLog-007 s.6, APA materials schema + data, EO materials.json + DevLog-038. Plan written.
- 2026-11-06 15:55-16:05 PST: Source search and caching (`scripts/fetch-cached.ts`: 3-6 s jitter before every request, generic User-Agent, sidecar JSON {url, finalUrl, date, status, contentType, bytes, sha256}). Read: Palace cpw.md; NIST cryogenic pages (6061-T6, OFHC Cu, Teflon, sapphire); NIST WebBook water isobar + references; Lemmon 2000 (Table A2); Kadoya 1985 (Tables 8, 12 from page renders); NIST NCSTAR 1-3D (Eqs. 2-2..2-4 from page renders); FHWA steel bridge handbook vol. 1; MIL-HDBK-5J (70.9 MB, one request); NIST solder DB v4; NIST TN 1536; Li 1980 (Tables 1, 2 from 300 dpi renders); Leviton-Frey 2006 (arXiv); Corning HPFS sheet (Edmund copy); refractiveindex.info Malitson / Salzberg / Zelmon entries; Hall 1967 text layer from the APA local copy. Blocks, not retried: aisc.org 403 (AISC 360), corning.com 403 (two PDFs), law.resource.org 404 (EN 1993-1-1). Cache: `cache/materials/` 117 MB (gitignored).
- 2026-11-06 16:00 PST: `pnpm install --offline` from the root to link the new package (lockfile importer entry added; see s.5).
- 2026-11-06 16:05-16:15 PST: Package code (schema, units, properties, formulas, validate, library, node), 13 YAML files.
- 2026-11-06 16:19 PST: Gates: 13/13 files valid (`logs/L10-validate-*.log`), 17/17 tests (`logs/L10-test-20261106T161938.log`), `tsc --noEmit` clean, summary table generated (s.4.1).

## 4. Results

### 4.0 Package `@amp/materials` (`packages/materials`)

| File | Content |
|---|---|
| `src/schema.ts` | zod `amp-material/0`: top level, sources, leaf (value / table / fit / tensor + provenance), alternatives, uncertainty, conditions; `materialJsonSchema()` |
| `src/units.ts` | `@amp/core/units` plus exact whole-string extensions `degC` (affine), `ksi`, `psi`, `lb/in^3`; `parseQuantity("20 degC")` |
| `src/properties.ts` | 18 property types with SI reference unit and allowed shapes; symmetries cubic / uniaxial / trigonal-3m; `tensorMatrix()`; `registerMaterialProperties(registry)` |
| `src/formulas.ts` | `sellmeier-c2`, `sellmeier-c`, `nist-cryo-log-poly`, `nist-cryo-linexp-secant`, `poly`, `leviton-frey-sellmeier` (coefficients only from YAML) |
| `src/validate.ts` | YAML parse (unique keys, no aliases) + zod + semantic checks: exactly one value form, unit dimension = property dimension, source keys exist, N/A needs `missing`, tables increasing, formula coefficients and variables, tensor components complete, CTE kind / T_ref, id = file name |
| `src/library.ts` | `createLibrary(docs).getProperty(id, prop, {T, lambda, f, component, alternative, extrapolate})` -> `{value (SI), unit, source, sourceKeys, basis, locator, accessed, conditions, uncertainty, symmetry, matrix, derived, analogOf, cteKind, T_ref, extrapolated}`; `MaterialNAError`, `MaterialRangeError`; `listNA()`; rule sigma = 1 / rho_e |
| `src/node.ts` | `loadMaterialsDir`, `loadLibrary`, `defaultLibrary`, `getProperty(materialId, prop, opts)` on the repo's `materials/` |
| `scripts/` | `fetch-cached.ts`, `validate.ts`, `summary-table.ts`, `json-schema.ts`, `derive-air.ts` (molar -> mass conversion of Lemmon Table A2) |

Design notes:
- Values are stored in the units the source prints (or an exact power-of-ten / definition rescaling stated in `derivation`, e.g. 1e12 dyn/cm2 = 100 GPa); conversion to SI happens on load.
- Tables are 1-D in T, lambda or f; ranges are the table span; outside it `getProperty` throws unless `extrapolate` (then flagged).
- Values taken from APA / EO data files carry `source.via` (repo, path, commit) and the accessed date of the prior lane's read; values L10 read itself carry 2026-11-06.
- Bases used (default leaves + alternatives, counted by script 2026-11-06 16:22 PST): measured 34, handbook 11, datasheet 11, reference_correlation 10, derived 10, paper_model_input 6, standard 1; N/A leaves 24.

### 4.1 Summary table (generated by `pnpm --filter @amp/materials table`; reference conditions T = 293.15 K, lambda = 1550 nm; SI)

| material | property | value at ref. conditions | unit (SI) | basis | source: locator |
|---|---|---|---|---|---|
| air | rho | 1.2046 @293.15 K | kg/m^3 | reference_correlation | lemmon2000: journal p.366-367 Table A2, 0.101325 MPa isobar, column Density (mol/dm3), rows 200-600 K |
| air | cp | 1006.3 @293.15 K | J/(kg*K) | reference_correlation | lemmon2000: journal p.366-367 Table A2, 0.101325 MPa isobar, column cp (J/(mol K)), rows 200-600 K |
| air | c | 343.36 @293.15 K | m/s | reference_correlation | lemmon2000: journal p.366-367 Table A2, 0.101325 MPa isobar, column Speed of sound (m/s), rows 200-600 K |
| air | mu | 0.000018226 @293.15 K | Pa*s | reference_correlation | kadoya1985: journal p.954 Table 8 'Viscosity of air calculated with Eq. (3)' (1e-6 Pa s), row P = 0.10 MPa, columns 200-650 K (page render) |
| air | k | 0.025707 @293.15 K | W/(m*K) | reference_correlation | kadoya1985: journal p.962 Table 12 'Thermal conductivity of air calculated with Eq. (5)' (1e-3 W/(m K)), row P = 0.10 MPa, columns 200-650 K (page render) |
| aluminum-6061-t6 | rho | 2712.6 | kg/m^3 | handbook | mil_hdbk_5j: p.3-264 Table 3.6.2.0(b1), Physical Properties: omega 0.098 lb/in3 |
| aluminum-6061-t6 | E | 68258000000 | Pa | handbook | mil_hdbk_5j: p.3-264 Table 3.6.2.0(b1): E 9.9 (10^3 ksi); Ec 10.1 (10^3 ksi, compression) |
| aluminum-6061-t6 | G | 26200000000 | Pa | handbook | mil_hdbk_5j: p.3-264 Table 3.6.2.0(b1): G 3.8 (10^3 ksi) |
| aluminum-6061-t6 | nu | 0.33 | 1 | handbook | mil_hdbk_5j: p.3-264 Table 3.6.2.0(b1): mu 0.33 |
| aluminum-6061-t6 | k | 154.37 @293.15 K | W/(m*K) | measured | nist_cryo_6061: Thermal Conductivity column, a..i = 0.07918, 1.0957, -0.07277, 0.08084, 0.02803, -0.09464, 0.04179, -0.00571, 0; data range 4-300 K, equation range 1-300 K |
| aluminum-6061-t6 | cp | 943.13 @293.15 K | J/(kg*K) | measured | nist_cryo_6061: Specific Heat column, a..i = 46.6467, -314.292, 866.662, -1298.3, 1162.27, -637.795, 210.351, -38.3094, 2.96344; data and equation range 4-300 K |
| aluminum-6061-t6 | alpha | 0.000022642 @293.15 K (secant, T_ref 293 K) | 1/K | derived | nist_cryo_6061: Linear expansion column, (L - L293)/L293 x 1e5 = a + bT + cT^2 + dT^3 + eT^4 for T > Tlow = 18 K, a..e = -4.1277E2, -3.0389E-1, 8.7696E-3, -9.9821E-6, 0 (f = -415.45 below Tlow); data and equation range 4-300 K |
| copper | rho | 8960 | kg/m^3 | handbook | nist_solder_db_v4: Table 2.2.7 row Cu: density 8.96 g/cm3 (table source: Brandi et al., ASM Handbook Vol. 6, 1993, as cited) |
| copper | k | 401.4 @293.15 K | W/(m*K) | measured | hpl1972: journal p.332, Thermal conductivity of copper, recommended values (solid) |
| copper | rho_e | 1.679e-8 @293.15 K | ohm*m | measured | matula1979: journal p.1161 Table 2, total resistivity (solid), annealed 99.999 % pure bulk Cu (1e-8 ohm m); log-log interpolation per p.1160 |
| copper | E | 123500000000 | Pa | measured | ledbetter_naimon1974: journal p.923 Table 10, polycrystal average values (E 1.235 +- 0.007 x 1e11 N/m2) |
| copper | nu | 0.35 | 1 | measured | ledbetter_naimon1974: journal p.923 Table 10, polycrystal average values (nu 0.350 +- 0.009) |
| copper | cp | 389.1 @293.15 K | J/(kg*K) | derived | nist_cryo_ofhc_cu, janaf1998_cu: 200-300 K: NIST OFHC copper specific-heat fit (log10 y = sum a_i (log10 T)^i, a..h = -1.91844, -0.15973, 8.61013, -18.996, 21.9661, -12.7328, 3.54322, -0.3797; 4-300 K); 400-700 K: JANAF p.1005 Cp 25.318 / 25.912 / 26.481 / 26.996 J/(K mol), A_r 63.546 |
| copper | alpha | 0.000016571 @293.15 K (instantaneous) | 1/K | measured | nist_cryo_ofhc_cu: Expansion Coefficient column (units 10-6 /K): a..g = -17.9081289, 67.131914, -118.809316, 109.9845997, -53.8696089, 13.30247491, -1.30843441 (h, i not given); data and equation range 4-300 K |
| fused-silica | n | 1.444 @1550 nm | 1 | measured | malitson1965: refractiveindex.info SiO2/nk/Malitson.yml: formula 1, coefficients 0 0.6961663 0.0684043 0.4079426 0.1162414 0.8974794 9.896161 |
| fused-silica | dndT | 0.00000837 @1550 nm | 1/K | derived | leviton2006: arXiv p.7 Table 6 'thermo-optic coefficient, dn/dT ... in units of 1/K', column 295 K |
| fused-silica | rho | 2200 | kg/m^3 | datasheet | corning_hpfs_2014: p.3 Mechanical Properties: Density 2.20 g/cm3 ('Unless otherwise stated, all values @ 25 C') |
| fused-silica | E | 73000000000 | Pa | datasheet | corning_hpfs_2014: p.3 Mechanical Properties: Elastic (Young's) Modulus 73 GPa |
| fused-silica | G | 31000000000 | Pa | datasheet | corning_hpfs_2014: p.3 Mechanical Properties: Shear Modulus 31 GPa |
| fused-silica | nu | 0.16 | 1 | datasheet | corning_hpfs_2014: p.3 Mechanical Properties: Poisson's Ratio 0.16 |
| fused-silica | k | 1.38 | W/(m*K) | datasheet | corning_hpfs_2014: p.3 Thermal Properties: Thermal Conductivity 1.38 W/(m K) |
| fused-silica | cp | 770 | J/(kg*K) | datasheet | corning_hpfs_2014: p.3 Thermal Properties: Specific Heat 0.770 J/(g K) |
| fused-silica | alpha | 5.2e-7 (secant, T_ref 278.15 K) | 1/K | datasheet | corning_hpfs_2014: p.3 Thermal Properties: Thermal Expansion (ppm/K), 5 C to 35 C: 0.52 x 10-6 (ASTM E-228) |
| fused-silica | eps_r | 3.75 | 1 | datasheet | korth_silica: silica glass page: dielectric constant 3.75 at 100 MHz, 293 K (as recorded by the APA lane) |
| gold | rho | 19300 | kg/m^3 | handbook | nist_solder_db_v4: Table 2.2.5 row Gold: density (20 C) 19.3 g/cm3 (N. A. Lange, Handbook of Chemistry, 1956, pp. 100-107, as cited) |
| gold | E | 74400000000 | Pa | handbook | nist_solder_db_v4: Table 1.10 row Gold 99.99, condition Cast: E 74.4 GPa (D. E. Gray, ed., AIP Handbook, 1957, pp. 2-61 ff., as cited) |
| gold | k | 318.2 @293.15 K | W/(m*K) | measured | hpl1972: journal p.340, Thermal conductivity of gold, recommended values (solid) |
| gold | rho_e | 2.2152e-8 @293.15 K | ohm*m | measured | matula1979: journal p.1209 Table 5, recommended total resistivity of gold (solid), 1e-8 ohm m |
| gold | cp | 127.5 | J/(kg*K) | handbook | nist_solder_db_v4: Table 2.2.5 row Gold: heat capacity (25 C) 6.0 g-cal/(g-at K), 127.5 J/(kg K) (Lange 1956, as cited) |
| gold | alpha | 0.0000142 (instantaneous) | 1/K | handbook | nist_solder_db_v4: Table 2.2.5 row Gold: thermal expansion coefficient (20 C) 14.2 x 1e-6 /K (Lange 1956, as cited) |
| linbo3-congruent | n | perp 2.2111, par 2.1376 | 1 | measured | zelmon1997: refractiveindex.info LiNbO3/nk/Zelmon-o.yml and Zelmon-e.yml (perp = n_o, par = n_e) |
| linbo3-congruent | eps_r | perp 44.3, par 27.9 | 1 | measured | weis1985: Table 1 'Relative permittivity coefficients', p.197, row Ref. [23] (Warner, Onoe, Coquin 1967): eps^S_11 44.3, eps^S_33 27.9, T_c 1165 C |
| linbo3-congruent | r_eo | r13 8.6e-12, r22 3.4e-12, r33 3.08e-11, r51 2.8e-11 | m/V | measured | weis1985: Table 4 'Linear electro-optic coefficients', p.199, row r^S, 633 nm, Ref. [45] (Turner 1966): r51 28, r22 3.4, r13 8.6, r33 30.8 (1e-12 m/V) |
| ptfe | eps_r | 2.05 | 1 | measured | nist_tn1536: p.71 Sec. 7.5.6: 'measurements of permittivity and loss tangent on the same materials at 10 GHz using a highly-accurate dielectric resonator are Teflon: (2.05 +- 0.02, 2 x 10-4 +- 8 x 10-5)' |
| ptfe | tan_delta | 0.0002 | 1 | measured | nist_tn1536: p.71 Sec. 7.5.6 (same sentence as eps_r) |
| ptfe | k | 0.27259 @293.15 K | W/(m*K) | measured | nist_cryo_teflon: Thermal Conductivity column, a..i = 2.7380, -30.677, 89.430, -136.99, 124.69, -69.556, 23.320, -4.3135, 0.33829; data and equation range 4-300 K |
| ptfe | cp | 1016 @293.15 K | J/(kg*K) | measured | nist_cryo_teflon: Specific Heat column, a..i = 31.88256, -166.51949, 352.01879, -393.44232, 259.98072, -104.61429, 24.99276, -3.20792, 0.16503; data and equation range 4-300 K |
| ptfe | alpha | 0.00022557 @293.15 K (secant, T_ref 293 K) | 1/K | derived | nist_cryo_teflon: Linear expansion column, (L - L293)/L293 x 1e5 = a + bT + cT^2 + dT^3 + eT^4, a..e = -2.125E3, -8.201E-1, 6.161E-2, -3.171E-4, 6.850E-7 (Tlow NA); data and equation range 4-300 K |
| sapphire | eps_r | perp 9.3, par 11.5 | 1 | paper_model_input | palace_cpw: cpw.md lines 21-23: parallel to C-axis eps_r = 11.5, perpendicular to C-axis eps_r = 9.3 |
| sapphire | tan_delta | perp 0.00003, par 0.000086 | 1 | paper_model_input | palace_cpw: cpw.md lines 22-23: parallel to C-axis tan delta = 8.6e-5, perpendicular to C-axis tan delta = 3.0e-5 |
| sapphire | alpha | 0.0000060976 @293.15 K (secant, T_ref 293 K) | 1/K | derived | nist_cryo_sapphire: Linear expansion column, (L - L293)/L293 x 1e5 = a + bT + cT^2 + dT^3 + eT^4, a..e = -7.8850E+01, -2.2346E-02, 1.0185E-04, 5.5594E-06, -8.5422E-09; data range 20-293 K, equation range 15-300 K |
| silicon | rho | 2329 | kg/m^3 | measured | hall1967: journal p.757 Sec. II: pure-sample density 2.3290 +- 0.0002 g/cm3 at 25 C (hydrometric) |
| silicon | C | C11 165640000000, C12 63940000000, C44 79510000000 | Pa | measured | hall1967: journal p.758 Table III column 'Present study': C11 1.6564, C12 0.6394, C44 0.7951 (1e12 dyn/cm2, pure Si, 25 C) |
| silicon | k | 152.84 @293.15 K | W/(m*K) | measured | hpl1972: journal p.394, Thermal conductivity of silicon, recommended values (solid) |
| silicon | cp | 704.18 @293.15 K | J/(kg*K) | derived | janaf1998: Monograph 9 p.1881, Si reference-state table, column Cp (J/K mol): 7.268, 15.636, 20.000, 20.050, 22.142, 23.330, 24.154, 24.803 at the listed T; A_r = 28.0855 |
| silicon | alpha | 0.000002555 @293.15 K (instantaneous) | 1/K | measured | swenson1983: journal p.181 Table 2, alpha' = (L20)^-1 (dL/dT); > 300 K from Eq. (1) with Table 1, <= 300 K from Lyon et al. |
| silicon | eps_r | 11.656 @293.15 K | 1 | measured | krupka2006: p.3 (journal p.3997) Fig. 2, dashed curve, digitized 2026-10-20 by the APA lane |
| silicon | n | 3.4757 @1550 nm | 1 | measured | li1980: journal p.577 Table 1 'Recommended values on the refractive index of silicon', column 293 K (read from a 300 dpi page render) |
| silicon | dndT | 0.0001818 @1550 nm | 1/K | derived | li1980: journal p.579 Table 2 'Recommended values on the temperature derivative of refractive index of silicon', column 293 K (300 dpi page render); unit 1e-4 /K from the table footnote |
| sio2-thermal-oxide | n | 1.444 @1550 nm | 1 | measured (analog of fused-silica) | malitson1965: refractiveindex.info SiO2/nk/Malitson.yml: formula 1 coefficients (bulk fused silica) |
| sio2-thermal-oxide | dndT | 0.00000837 @1550 nm | 1/K | derived (analog of fused-silica) | leviton2006: arXiv p.7 Table 6, column 295 K (Corning 7980 bulk) |
| sio2-thermal-oxide | eps_r | 3.9 | 1 | paper_model_input | zhu2021: Table 1, SiO2 row, column 'RF dielectric constant' (3.9); arXiv PDF p.5 |
| sio2-thermal-oxide | E | 73000000000 | Pa | paper_model_input | tcpmt2025_3538554: p.7 Table IV row SiO2 (E 73.0 GPa, nu 0.16, CTE 0.5 ppm/C) |
| sio2-thermal-oxide | nu | 0.16 | 1 | paper_model_input | tcpmt2025_3538554: p.7 Table IV row SiO2 |
| sio2-thermal-oxide | alpha | 5e-7 (instantaneous) | 1/K | paper_model_input | tcpmt2025_3538554: p.7 Table IV row SiO2 (CTE 0.5 ppm/C) |
| sio2-thermal-oxide | k | 1.38 | W/(m*K) | datasheet (analog of fused-silica) | corning_hpfs_2014: p.3 Thermal Properties: Thermal Conductivity 1.38 W/(m K) (bulk HPFS 7980) |
| structural-steel | E | 205120000000 @293.15 K | Pa | measured | ncstar1_3d: p.12 Eq. 2-2: E(T) = e0 + e1 T + e2 T^2 + e3 T^3, e0 = 206.0 GPa, e1 = -0.04326 GPa/C, e2 = -3.502e-5 GPa/C^2, e3 = -6.592e-8 GPa/C^3, 0 C < T < 600 C |
| structural-steel | nu | 0.28789 @293.15 K | 1 | measured | ncstar1_3d: p.12 Eq. 2-3: nu(T) = n0 + n1 T + n2 T^2 + n3 T^3 + n4 T^4, n0 = 0.28737362, n1 = 2.5302417e-5, n2 = 2.6333384e-8, n3 = -9.9419588e-11, n4 = 1.2617779e-13 (C^-i), 0 C < T < 725 C |
| structural-steel | G | 79633000000 @293.15 K | Pa | derived | ncstar1_3d: p.12 Eq. 2-4: G(T) = g0 + ... + g5 T^5, g0 = 80.005922 GPa, g1 = -0.018303811, g2 = -1.5650288e-5, g3 = -1.5160921e-8, g4 = -1.6242911e-11, g5 = 7.7277543e-15 (GPa/C^i), 0 < T < 725 C |
| water | rho | 998.18 @293.15 K | kg/m^3 | reference_correlation | nist_webbook_water, iapws95: WebBook isobaric table, column 'Density (kg/m3)' |
| water | cp | 4184.3 @293.15 K | J/(kg*K) | reference_correlation | nist_webbook_water, iapws95: WebBook isobaric table, column 'Cp (J/g*K)' |
| water | c | 1482.1 @293.15 K | m/s | reference_correlation | nist_webbook_water, iapws95: WebBook isobaric table, column 'Sound Spd. (m/s)' |
| water | mu | 0.0010024 @293.15 K | Pa*s | reference_correlation | nist_webbook_water, iapws2008_visc: WebBook isobaric table, column 'Viscosity (Pa*s)' |
| water | k | 0.59793 @293.15 K | W/(m*K) | reference_correlation | nist_webbook_water, iapws2011_tc: WebBook isobaric table, column 'Therm. Cond. (W/m*K)' |

### 4.2 Properties left N/A (from `listNA()`)

| material | property | why |
|---|---|---|
| air | mu_r | no primary magnetic-susceptibility source for air read in this lane; a magnetostatics spec must state mu_r (with basis) as an override |
| air | eps_r | no permittivity source for air read in this lane |
| copper | mu_r | no primary magnetic-susceptibility source read for Cu in this lane; a spec that needs mu_r must state it (with basis) as an override |
| fused-silica | tan_delta | no primary or data-sheet loss tangent read for fused silica at RF |
| gold | nu | no Poisson ratio for gold in the sources read (NIST solder DB Table 1.10 gives no shear modulus for gold) |
| gold | mu_r | no magnetic-susceptibility source read for gold in this lane |
| linbo3-congruent | rho | not read from a primary source in this lane (Weis and Gaylord 1985 is the candidate) |
| ptfe | rho | density not given by the sources read (NIST cryogenic page, TN 1536) |
| ptfe | E | NIST cryogenic Teflon page lists Young's modulus but gives no coefficients; no other source read |
| pzt-4 | rho | PZT-4 density not read from a primary source (CP-06 lists 7500 kg/m3 from Ansys VM175, a vendor manual, not used here) |
| pzt-4 | eps_r | clamped permittivity eps^S_11, eps^S_33 / eps0 of PZT-4 not read (Boucher et al. 1981 paywalled) |
| pzt-4 | C | stiffness c^E (6mm: c11, c12, c13, c33, c44, c66) of PZT-4 not read; 6mm symmetry also needs a schema extension |
| sapphire | rho | not read from a source in this lane |
| sapphire | k | not read from a source in this lane (NIST cryogenic page gives expansion only) |
| silicon | E | anisotropic crystal: Young's modulus depends on direction; use the stiffness tensor C (a direction-dependent E follows from C, not stored) |
| silicon | nu | anisotropic crystal: Poisson's ratio depends on direction; use C |
| silicon | sigma | doping-dependent: wafer resistivity is a per-part input (set it in the spec override with its source) |
| silicon | tan_delta | Krupka 2006 (p.1 Eqs. 1-2): losses of HR-Si are conductivity-dominated, so tan delta depends on the wafer resistivity; lattice term not given as a number above 25 K (APA reading) |
| sio2-thermal-oxide | rho | thermal-oxide film density not read from a source |
| sio2-thermal-oxide | cp | thermal-oxide film heat capacity not read from a source (bulk value in fused-silica) |
| structural-steel | rho | not read from an open authorised source: EN 1991-1-1 / EN 1993-1-2 are paywalled (law.resource.org copy gone, HTTP 404), aisc.org returned HTTP 403 |
| structural-steel | k | candidate source EN 1993-1-2 (Eurocode 3, fire design) not read: paywalled, no authorised open copy reached (law.resource.org HTTP 404) |
| structural-steel | cp | candidate source EN 1993-1-2 not read (paywalled) |
| structural-steel | alpha | candidate sources EN 1993-1-1 / EN 1993-1-2 not read (paywalled); AISC 360 download blocked (HTTP 403) |

Also N/A at file level (`missing` blocks): LN elastic / piezo / photoelastic tensors and n(T); Si Cij(T); 6061 k, cp, alpha above 300 K (MIL-HDBK-5J figure only) and resistivity; thermal-oxide film-specific data; PZT-4 piezoelectric e tensor (no property type yet); water static permittivity.

### 4.3 Requests and decisions

| Request | Status |
|---|---|
| L2: `materials/structural-steel`, `materials/air`, `materials/copper` for sims/ | Done. The sims still mark them `missing`; L2 can drop those entries. Note: mu_r of air and copper is N/A (no primary susceptibility source read); helmholtz-coil must state mu_r as an override with `basis: user` or a sourced value |
| L7b CR-5: Si anisotropic stiffness + density | Done: `silicon.C` cubic (Hall 1967 Table III, +-0.02 %), `silicon.rho` 2329.0 kg/m3 |
| L7b CR-5: n_Si at 1550 nm | Done: 3.4757 (Li 1980 Table 1, 293 K, +-2e-3); alternative Salzberg-Villa fit 3.4777 |
| L7b CR-5: LN indices at 1957 nm (CP-43) | Done: Zelmon 1997 fits valid 0.4-5.0 um; Si, SiO2 at 1957 nm also covered (Li table to 14 um, Malitson to 6.7 um). LN RF eps and r_eo are Weis-Gaylord values (r at 633 nm only: no 1957 nm EO value exists in that source) |
| L4: `getProperty(materialId, prop, {T, lambda})` -> `{value, unit, source}` | Done (`@amp/materials/node`, SI values, plus provenance fields) |
| FR-4 | Not authored: the only public values found are secondary (NIST solder DB Table 2.2.6 citing Korhonen 1994; Table 1.11 marked "still needs a complete documentation of source"); IPC-4101 is paywalled |
| PZT-4 | File with every value N/A + `missing` (Boucher 1981 paywalled; no open primary found) |
| Structural steel | E(T), nu(T), G(T) from NCSTAR 1-3D; rho, k, cp, alpha N/A (EN 1993 paywalled, AISC 403) |
| Case-defined values (NAFEMS k 52, WO-02 indices, RF-01 eps 2.08, AC-02 c 343) | Not entered. Exception: sapphire eps / tan delta are the Palace CPW values that RF-03 also carries, entered because the task asks for them; labelled `paper_model_input` |

## 5. Contract requests

1. **C1 (coordinator)**: approve `zod` 4.6.7 and `yaml` 2.9.1 as runtime dependencies of `@amp/materials` (same pinned versions as `@amp/spec`). `pnpm install --offline` was run from the root to link the package; `pnpm-lock.yaml` gained the `packages/materials` importer (it also picked up pending importer entries of other lanes: `@amp/post`, `@amp/mesh`, `@amp/physics` links).
2. **C3 / L2 (spec)**: material `override` accepts scalar quantities only. Tensor properties (`C`, `r_eo`, uniaxial `eps_r`, `n`, `tan_delta`, `k`, `alpha`) need an override form, e.g. `{tensor: {symmetry, components}, unit}`; until then overrides of tensor properties are impossible.
3. **C3 / L2 (spec)**: `provenance.basis` enum lacks `paper_model_input` and `reference_correlation` used by the materials basis vocabulary (APA A6 + 2). Either add them or map (`paper_model_input` -> `paper`, `reference_correlation` -> `handbook`).
4. **L2 (spec)**: optional validation hook so `materials/<id>` refs are checked against the library ids (`createLibrary(...).ids()`), and the sims can drop their "materials/ empty" `missing` entries.
5. **L4 (physics)**: registry ownership. `registerMaterialProperties(reg)` supersedes the provisional property seed (owner `@amp/materials`); L4 should not re-register property types, or should coordinate names. New names: `C`, `G`, `r_eo`, `mu`, `rho_e`, `dndT`. Tensor values come back as `{value: components, matrix}`.
6. **C1 / coordinator**: browser loading of `materials/*.yaml` (L5): `import.meta.glob('/materials/*.yaml', {query: '?raw', eager: true})` + `parseMaterialText` + `createLibrary`; no generated bundle is committed.

## 6. Hand-off

State: wave-1 tier-1 library done; gates pass (13/13 files valid, 17/17 tests, tsc clean).

```ts
import { getProperty, loadLibrary } from '@amp/materials/node';
getProperty('copper', 'k', { T: 300 });                    // {value: 401, unit: 'W/(m*K)', source: 'C. Y. Ho ... doi:10.1063/1.3253100', basis: 'measured', locator: 'journal p.332 ...'}
getProperty('silicon', 'C');                                // {value: {C11, C12, C44} Pa, matrix: 6x6 Voigt, symmetry: 'cubic'}
getProperty('linbo3-congruent', 'n', { lambda: 1.957e-6 }); // {value: {perp: n_o, par: n_e}, matrix: 3x3}
getProperty('fused-silica', 'n', { lambda: 1.5e-6, T: 295, alternative: 'leviton_frey_corning7980' });
getProperty('copper', 'sigma', { T: 293 });                 // derived 1 / rho_e, stated in `derived`
// N/A -> MaterialNAError (with .missing); outside table / fit range -> MaterialRangeError unless {extrapolate: true}
```

Commands: `pnpm --filter @amp/materials test | check | validate | table | schema`.

Known limits:
- Several values are transcribed from APA / EO data files (`via`) and were not re-read here: HPL 1972 k, Matula 1979 resistivity, Ledbetter-Naimon 1974, JANAF cp, Swenson 1983, Krupka 2006, Weis-Gaylord 1985, Zhu 2021, TCPMT 2025. Hall 1967 (Si) was re-read from the APA local copy.
- Malitson 1965, Zelmon 1997, Salzberg-Villa 1957 primaries are paywalled; coefficients come from refractiveindex.info (CC0) entries; the Leviton-Frey fit (open) was checked against its own Table 4 to 1.5e-5.
- NIST cryogenic fits are limited to <= 300 K (6061-T6 k, cp, alpha; Cu alpha; PTFE; sapphire); the 6061 cp fit at 293 K (943 J/(kg K)) sits within its stated 5 % fit error.
- Uniaxial thermal expansion of sapphire is not represented (source gives no direction).
- Tables are 1-D: T-dependence of optical indices exists only through the Leviton-Frey alternative and the dn/dT tables at 293-295 K.
- Not done: fresh-context audit (coordinator); FR-4; magnetic susceptibilities (mu_r) of Cu, Au, air.
