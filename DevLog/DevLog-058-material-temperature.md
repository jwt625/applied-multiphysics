# DevLog-058: material temperature and material sourcing (lane G1, chunk 3)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | G1 (DevLog-037 s.4.2) |
| Status | done (s.5 results, s.6 requests, s.7 open items, s.8 hand-off) |
| Owns | `packages/spec/src/schema.ts` (materials item only), `packages/physics/src/prepare.ts`, `materials/**`, `packages/materials/**`, the materials blocks (and their provenance lines) of `sims/{tsv-stress-axisym,tsv-stress-3d,interposer-thermal-3d,die-warpage-3d,microstrip-rdl,cpw-si-interposer}.yaml`, new tests in `packages/physics/test/` and `packages/materials/test/`, this file |
| Read | CLAUDE.md; DevLog-037 s.4.1, s.4.2; DevLog-049 (R1, O4, O6); DevLog-041 (format, s.4.2 N/A list); DevLog-046; `packages/physics/src/prepare.ts`; `packages/spec/src/schema.ts` materials item; `packages/materials/src/library.ts` |

Conventions: F = fact read from code, a source or a run; D = decision; E = estimate; O = open item; R = request.

## 1. Facts (2026-11-18 18:14 PST)

- F: `resolveMaterials(spec, types, case, T, lib, notes, mc)` takes one run-level `T` (`CaseCtx.T`); `libOpts(p)` passes it to every library leaf, `dndT` takes the thermo-optic coupling `Tref` instead; `libraryDispersion` / `libraryKappaDispersion` get the same run T. No caller passes `T` (DevLog-049 R1), so T-table / T-fit leaves of `ref:` materials fail with "depends on T" (a note).
- F: `@amp/materials` `checkValid` tests a leaf's stated `valid.T` range only when a T is passed: a scalar leaf whose validity excludes the material T throws `MaterialRangeError` once T is given (previously it resolved). Per-sim check needed (s.3).
- F: `materialsAt(lambda)` caches per lambda; the material T is part of the (immutable) prepared spec and the run T is fixed per prepared run, so the cache is already per T; the key gets T anyway (brief).
- F: the six sims carry overrides equal to the library at 298.15 K (DevLog-049 F), with provenance notes naming the missing temperature.

## 2. Plan (written 2026-11-18 18:15 PST, before coding)

1. Schema: materials item gains `T: quantity('K').optional()` next to `override` (both the generic and the registry form use `specFromParts`).
2. prepare.ts `resolveMaterials`: per material `Tm` = resolved node `T` (params allowed; N/A or unresolvable -> note, fall back) else run `T`. `libOpts`, `libraryDispersion`, `libraryKappaDispersion` use `Tm`; `dndT` keeps the coupling `Tref` (linearisation point of the thermo-optic coupling, unchanged). Provenance note per `ref:` material with a node T: `materials.<id> (<ref>): library values at T = <x> K (material temperature)`, plus `run temperature <y> K not used for this material` when both differ. Overrides are untouched (an override wins over the library at any T). `materialsAt` cache key `lambda|T`.
3. Tests `packages/physics/test/material-temperature.test.ts`: node T resolves a T-table leaf (Si k, alpha; Cu alpha) to the library value at that T; node T beats run T; run T used without node T; no T anywhere keeps the "depends on T" note; materialsAt keeps the node T; schema rejects a non-K T. Spec test if the spec package has a schema test file pattern (new file only).
4. Sims: for each overridden leaf compare the library value at 298.15 K bitwise with the override (script in `<scratch>/g1/`); where equal: drop the override, add `T: {value: 298.15, unit: K}` to the material, provenance line for `materials.<id>.T`. Where not equal or where T would break another leaf (validity): keep the override, state why. Before / after PK-01..06 CLI values.
5. Sourcing (research subagent, primary sources only): Ge (n dispersion, k, alpha, E / nu or C, rho, cp), Ta and TaN film (rho_e, k), underfill UF 8830S k, TiN film k. New files `materials/germanium.yaml`, `materials/tantalum-film.yaml`, `materials/tan-film.yaml` only where at least one value is sourced; N/A with `missing` otherwise. Validator and `@amp/materials` tests.
6. Gates: spec / materials / physics tests, `pnpm -r check`, PK-01..06 CLI one at a time, the 9 em-modes regression sims (`validation/modes2/regress.ts`).

## 3. TODO

- [x] Schema `T` on materials item
- [x] prepare.ts per-material T + notes + materialsAt key
- [x] Tests (physics `material-temperature.test.ts` 7, materials `material-sourcing-2.test.ts` 4; spec tests unchanged: the schema checks live in the physics test, spec tests are not this lane's path)
- [x] Sims: overrides -> T (bitwise check)
- [x] PK-01..06 CLI (and PK-07..11 after the coordinator's scope addition)
- [x] em-modes regression
- [x] Sourcing Ge, Ta, TaN, underfill k, TiN k (sourcing sub-worker; reviewed)
- [x] Validator, materials tests, `pnpm -r check`
- [x] Requests (CONTRACTS changelog), hand-off

## 4. Progress log

- 2026-11-18 18:14 PST: read brief, DevLog-037 s.4, DevLog-049, DevLog-041, DevLog-046, prepare.ts, schema.ts, library.ts. Plan written (s.2).
- 2026-11-18 18:16 PST: sourcing sub-worker launched (Ge, Ta / TaN films, underfill k, TiN k; primary sources only; edits `materials/` only).
- 2026-11-18 18:20 PST: baseline materials dump of every sim / study (prepareRun only, 88 entries, `<scratch>/g1/mat-before.json`; script `<scratch>/g1/matdump.ts`).
- 2026-11-18 18:25-18:35 PST: schema line (s.6 R1); prepare.ts: `materialT()` per material, `libOpts(p, Tm)`, library dispersion / kappa dispersion at Tm, notes, `materialsAt` key `lambda|runT`, material-T notes not repeated per wavelength. Dump after the code change: identical to the baseline for all 88 entries (one extra entry: a sim added by another lane meanwhile).
- 2026-11-18 18:36 PST: sourcing sub-worker done (s.5.3); validator 37 / 37, materials tests 34 / 34 (logs/G1-validate-20261118T183551.log, logs/G1-test-20261118T183551.log).
- 2026-11-18 18:37-18:40 PST: five sims edited (s.5.2); same-process solve of the committed (HEAD) and the edited spec: bitwise identical for all fields and scalars; PK-01..06 CLI pass.
- 2026-11-18 18:43 PST: em-modes regression dump `logs/G1-modes-regress-after-20261118T184311.json` equals the chunk 2 dump `logs/E2-modes-regress-after-20261118-140204.json` for all 9 sims (mesh hash, steps, scalars, field sums of squares, notes).
- 2026-11-18 18:44-18:48 PST: `pnpm -r check` clean (logs/G1-check-20261118T184452.log); physics tests 209 / 209 (logs/G1-physics-test-20261118T184514.log; the package suite peaks at 2.7 GB RSS under `time -l`, a pre-existing suite property, noted); new materials test file.
- 2026-11-18 18:48 PST: coordinator scope addition: the five new packaging sims of the other packaging lane. Applied to three (s.5.2); solves bitwise identical; PK-07..11 CLI pass. Materials 38 / 38, spec 65 / 65, validator 37 / 37, tsc clean.

## 5. Results

### 5.1 Code

- Schema: materials item `T: quantity('K', POS).optional()` (any temperature unit: K, degC; > 0 K; params allowed). Both the generic and the registry spec forms (`specFromParts`).
- `prepare.ts`: per material `Tm` = node `T` when given and resolvable, else the run `T` (`CaseCtx.T`), else none. `Tm` drives every library leaf of that material (`libOpts`), the library dn/dlambda and dkappa/dlambda of that material; `dndT` keeps the thermo-optic coupling `Tref` (unchanged). Notes: `materials.<id> (<ref>): library values at T = <x> K (material temperature)[, not at the run temperature <y> K][; override values as given]`; `materials.<id>.T: N/A; run temperature <y> K used` (or `; no temperature for the library`); `materials.<id>.T: <x> K has no effect (no library reference; ...)` on a material without `ref:`. Overrides win at any T. `materialsAt` keeps copy semantics, key `lambda|runT`, and does not repeat the material-T notes per wavelength.
- Without a node T the code path is unchanged: materials dump of all sims identical (s.4), em-modes regression identical.

### 5.2 Sims (overrides replaced by `T: {value: 298.15, unit: K}`; every replaced override equals the library value at 298.15 K bitwise, checked with `<scratch>/g1/libcheck.ts`)

| Sim | Material | Overrides removed | Kept | Resolved-table change |
|---|---|---|---|---|
| tsv-stress-axisym | cu, silicon | Cu alpha, k; Si alpha, k | - | + cp (Cu 389.319, Si 712.1 J/(kg K)); unused by the stationary study |
| tsv-stress-3d | cu, silicon | same | - | same |
| die-warpage-3d | silicon | Si alpha, k | substrate unchanged (scalar library leaves) | + Si cp |
| interposer-thermal-3d | si | Si k | bump_layer (no library ref; underfill k still has no default) | + Si cp |
| cpw-si-interposer | silicon | Si eps_r (11.662595) | air | none |
| microstrip-rdl | - | none: no temperature-table override (polyimide eps_r is a scalar leaf) | all | none |
| bump-array-thermal | si | Si k | solder | + Si cp |
| waveguide-heater-3d | silicon | Si k | oxide | + Si cp |
| hybrid-bond-pad | cu | Cu k | Cu alpha (relative expansion `alpha_cu - alpha_si`, params held constant to 398 K above the 4-300 K Cu fit: not a library value, kept with its label); sio2 alpha (relative) | + Cu cp |
| waveguide-heater-to | - | none: Si and SiO2 have no `ref:` (all overrides incl. n, dndT at 1.55 um); a ref would change the binding (library eps_r etc.) | all | none |
| microstrip-thick | - | none: no temperature-table override | all | none |

Provenance: each removed `materials.<id>.override.<p>` line replaced by one `materials.<id>.T` line (basis user) naming the library leaves, the value and the source. Bitwise: same-process solves of HEAD vs edited spec (`<scratch>/g1/solvecmp.ts`): 0 differing field values and scalars for all 8 edited sims. CLI: PK-01..11 pass (logs/G1-cli-PK-0*-20261118T18*.log): PK-01 5 / 5 gated pass; PK-02 4 pass, 4 info; PK-03 3 pass; PK-04 1 pass, 2 info; PK-05 1 pass, 3 info; PK-06 1 pass, 2 info; PK-07 2 pass, 4 info; PK-08 1 pass, 2 info; PK-09 2 pass, 3 info; PK-10 1 pass, 8 info; PK-11 1 pass, 5 info.

### 5.3 Materials sourced (all accessed 2026-11-18; locators and `read` notes in the files)

| File | Property | Value | Source |
|---|---|---|---|
| germanium (new) | n | table 1.90-18.00 um at 293 K (43 rows, +-2e-3), air wavelengths (inferred from p.583); alternative eq. (28) (formula li1980-eq22, L = 1, 293 K, within 6.6e-5 of the table) | Li 1980 JPCRD 9, 561, p.593 Table 4, p.584 eq. (28) (local cache, 400 dpi renders) |
| germanium | dndT | 5.057e-4 to 4.013e-4 1/K (1.9-18 um, 293 K), +-0.5e-4 | Li 1980 p.595 Table 5 |
| germanium | k | table 200-1200 K (0.602 W/(cm K) at 298.2 K), +-10 % above 290 K; alternative Glassbrenner-Slack 1964 Table I | HPL 1972 JPCRD 1, 279, p.339 |
| germanium | alpha | table 100-1200 K (5.791 ppm/K at 293 K), basis derived | expansion polynomials quoted by Li 1980 p.585 from TPRC Vol. 12 (TPRC not read; uncertainty N/A) |
| germanium | rho, cp, C | N/A | no primary read (JANAF has no condensed Ge; McSkimin papers paywalled; HAL copy anti-bot) |
| tantalum-film (new) | rho_e | 157.8 +- 1.7 uOhm cm (about 200 nm RF sputtered, unheated Si, beta-dominated); alternatives alpha-Ta on TaN / TiN seed 26.7, 600 C 58.1, AlN seed 177.0, 703 nm RF film 95 | Singer et al. 2024 (arXiv:2409.06041) Sec. III.B; Nie et al. 2001 |
| tantalum-film | k | 8.0 +- 1.2 W/(m K) (170 nm, RT sputtered, tentatively beta-rich); alternative bulk HPL 1972 p.399 (labelled bulk) | Deng, Ma, Jiang, accepted manuscript (arXiv:2609.17990) |
| tan-film (new) | rho_e | 0.426 mOhm cm (7.5 % N2, fcc TaN, 619 nm, 295 K); alternatives 2.5-30 % N2: 0.116-14.8 mOhm cm | Nie et al. 2001 Table 1 (arXiv:cond-mat/0305683) |
| tan-film | k | 4.22 +- 0.17 W/(m K) (330 nm Ta2N-dominated, TDTR); a different film from the rho_e default (stated) | Zhang et al. (arXiv:2411.15767) Sec. 3.2 |
| tin-film | k | default N/A kept; alternative `moraes2015_3omega` 3.1 W/(m K) at 295 K (580 nm dc reactive-sputtered fcc TiN, 500 C, 3-omega) | Moraes 2015 TU Wien MSc thesis (doi:10.34726/hss.2015.29230), pdf p.41, 42, 48; thesis, not peer reviewed |
| underfill-uf8830s | k | default N/A kept; alternative `distributor_listing` 0.6 W/(m K) (distributor page, no method / temperature) | Krayden product page (former CAPLINQ URL redirects there); no Henkel document gives k (TDS 2017, LT-8234, LT-6885 checked) |

D1: tin-film k and underfill k stay N/A by default; the measured / listed values are explicit alternatives (`alternative:` in a sim), because each is one deposition (TiN) or a non-manufacturer listing (underfill) and `packages/materials/test/packaging-e3.test.ts` asserts the default N/A.
F (sub-worker side finding, not checked here): Li 1980 dL/L293 polynomials with the constant read as percent reproduce Ge dndT; the same reading may resolve the Si inconsistency noted in DevLog-041 s.3.

## 6. Requests

- R1 (coordinator, CONTRACTS-v0 changelog), proposed text:
  `- 2026-11-18 18:50 PST, coordinator: C1 / C4 (G1, DevLog-058): materials item gains optional `T` (temperature quantity, > 0 K; packages/spec/src/schema.ts l.362). prepareRun evaluates the library tables / fits of a `ref:` material at its node T, else at the run temperature (CaseCtx.T), else without a temperature (T-dependent leaves then absent with a note, as before); overrides win at any T; the thermo-optic Tref still sets dndT. Provenance note per material with a node T; materialsAt keeps the node T (cache key lambda and run T).`
- R2 (coordinator or the sims' owners): header comments still describe the removed overrides. Proposed replacements (comments only):
  - `sims/tsv-stress-axisym.yaml` l.7-8: `alpha and k are temperature tables there and prepareRun has no` / `temperature for library tables yet (DevLog-049 R1), so they are overrides equal to the library value at 298.15 K.` -> `alpha and k are temperature tables there, evaluated at the material temperature 298.15 K.`
  - `sims/tsv-stress-3d.yaml` l.8-9: `alpha and k as overrides equal to the library values at 298.15 K (no temperature for library tables yet, DevLog-049 R1).` -> `alpha and k from the library at the material temperature 298.15 K.`
  - `sims/interposer-thermal-3d.yaml` l.12: `Si k: materials/silicon at 298.15 K as an override (no temperature for library tables yet, DevLog-049 R1); constant k` -> `Si k: materials/silicon at the material temperature 298.15 K; constant k`
  - `sims/die-warpage-3d.yaml` l.10: `alpha at 298.15 K as an override, DevLog-049 R1` -> `alpha at the material temperature 298.15 K`
  - `sims/cpw-si-interposer.yaml` l.8-9: `at 298.15 K, as an override because prepareRun passes no temperature to library tables (DevLog-049 R1).` -> `at the material temperature 298.15 K.`
  - `sims/bump-array-thermal.yaml` l.11: `298.15 K as an override (library tables get no temperature yet)` -> `the material temperature 298.15 K`
- R3 (web, optional): the workbench material editor and the agent tools could expose the node `T` (not required: the spec round-trips it).

## 7. Open items

- O1: a run-level default temperature from the study (e.g. stationary heat: the solved temperature or a `settings.T_material`) is not added; T-dependent properties remain constant per material (linear models). Temperature-dependent k(T) / alpha(T) in the solvers is a separate feature.
- O2: tan-film rho_e is stated at 295 K only (validity [295, 295] K): a material T of 298.15 K makes that leaf throw a range error (by design of `valid`); a sim using it should set T = 295 K or `extrapolate`.
- O3: Ge n / kappa at 1.55 um (absorbing), Ge rho, cp, C: N/A (s.5.3). Ta alpha-phase film k: none found.
- O4: TiN film k default: decide whether the single 3-omega thesis value becomes the default (then edit `packaging-e3.test.ts` l.34 to check the value).

## 8. Hand-off

Changed: `packages/spec/src/schema.ts` (l.362 only), `packages/physics/src/prepare.ts`, `materials/{germanium,tantalum-film,tan-film}.yaml` (new), `materials/{tin-film,underfill-uf8830s}.yaml`, materials blocks and provenance lines of `sims/{tsv-stress-axisym,tsv-stress-3d,die-warpage-3d,interposer-thermal-3d,cpw-si-interposer,bump-array-thermal,waveguide-heater-3d,hybrid-bond-pad}.yaml`; new tests `packages/physics/test/material-temperature.test.ts`, `packages/materials/test/material-sourcing-2.test.ts`. Gates: spec 65 / 65, materials 38 / 38, validator 37 / 37, physics 209 / 209, `pnpm -r check` clean, PK-01..11 CLI pass, em-modes regression identical. Scratch scripts (not tracked): `<scratch>/g1/{matdump,libcheck,solvecmp}.ts`.
