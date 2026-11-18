# DevLog-046: library material binding for the optical solvers (lane I1, chunk 1)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | I1 (integration of DevLog-043 R1 / R2 / R3 and DevLog-042 R2) |
| Owns | `packages/physics/src/prepare.ts`, `sims/tfln-mzm-eo.yaml` (physics settings; see D2), new `packages/physics/test/prepare-materials.test.ts`, this file; `packages/physics/src/modes/settings.ts` only for a minimal additive key (D1) |
| Inputs | CLAUDE.md; DevLog-037 (progress log); DevLog-041 s.5 (materials API); DevLog-043 s.2-5 (em-modes settings, R1-R3); DevLog-042 s.6 (R2, O4) |

Conventions: F = fact read from code or a source; D = decision; O = open item; R = request to the coordinator.

## 1. Baseline (F, 2026-11-18 09:30 PST)

- `prepare.ts` resolves for em-modes only `n`, `eps_r` (+ coupling needs); `libOpts` passes the mode wavelength to `n` and `dndT` only. `kappa` and `dn_dlambda` never come from the library; `emw-2d` has no NEEDS entry, so `ref:` materials resolve nothing for it, and a frequency study passes no wavelength.
- `MaterialLibrary` (prepare.ts) is `{getProperty}` only; callers inject the full `@amp/materials` Library (web worker: `materials-node-shim.ts defaultLibrary()`; Node: `@amp/materials/node`), the eval harness passes none (Node default).
- em-modes (`modes/index.ts`) reads `ctx.materials[id].kappa` with `settings.loss`, `dn_dlambda` / `dn_dlambda.perp` / `.par` with `settings.dispersion`, and `settings.dispersion.dndlambda.<material>` first. The settings schema already allows `dispersion: true`.
- wave2d `media()`: `eps_r` (+ `tan_delta`) takes precedence over `n` (+ `kappa`); `mu_r` defaults to 1 with a note.
- Library at 1.957 um (F, run 09:29): LN o / e Zelmon smooth (dn/dlambda -31490.49 / -26632.79 1/m); SiO2 Malitson smooth, flagged extrapolated (the air-to-vacuum conversion uses Ciddor air outside 0.23-1.69 um); air default (Ciddor) throws MaterialRangeError at 1.957 um, alternative `mathar2007_ir` is a table (piecewise-linear, -0.4012 1/m); gold table ends at 1.937 um.
- None of the 9 em-modes sims uses `ref:` (all overrides).

## 2. Plan (written 2026-11-18 09:33 PST, before coding)

1. MatContext gets the solved physics nodes. em-modes with `settings.loss: true` -> `kappa` optional (absent = lossless, no note), read at the mode wavelength (`libOpts`: kappa like n).
2. em-modes with `settings.dispersion` (true or object) and a mode wavelength: for every `ref:` material whose domains meet that physics' selection and that has no `settings.dispersion.dndlambda.<id>` override and no `dn_dlambda` override: `dispersion(lib, id, lambda, {component, alternative, extrapolate, T})` from `@amp/materials`; scalar n -> `dn_dlambda`, uniaxial n -> `dn_dlambda.perp` / `.par`. One provenance note per material (library id, leaf, source, derivative kind, h) with the flags "piecewise-linear" and "extrapolated" spelled out; a note when an override n differs from the library n used for the slope; a note when dispersion() throws (em-modes then reports the missing material).
3. `MaterialLibrary` widened compatibly: getProperty options gain `component`, `alternative`, `extrapolate`; optional `get(id)` (needed by dispersion(); a library without it gets a note, no throw). The web and Node callers already pass the full Library.
4. `NEEDS['emw-2d'] = ['eps_r', 'tan_delta', 'mu_r', 'n', 'kappa']`, all optional for emw-2d. Frequency study solving emw-2d with exactly one frequency / wavelength: `lambda = c0 / f` for library n, kappa, dndT; several: one evaluation without a wavelength plus a note (DevLog-042 O4); notes only when a `ref:` material is present.
5. `sims/tfln-mzm-eo.yaml`: `dispersion` from the library (D1, D2); n, eps_r, r_eo overrides unchanged.
6. Tests `packages/physics/test/prepare-materials.test.ts`: library kappa == override kappa (Au / air SPP, DevLog-043 s.6) to round-off; emw-2d `ref:` material with n, kappa == override (S-parameters); dispersion notes and values; override precedence.
7. Regression: materials dump of every sim / study before and after (`logs/I1-matdump-*`), em-modes solves (S2 script), S3 script (mesh hashes + 3D solves); `pnpm --filter @amp/physics test`, `pnpm -r check`.

D1 (09:33): air needs the `mathar2007_ir` alternative at 1.957 um (the default Ciddor fit throws there), and the em-modes settings cannot name a library leaf. Minimal additive key in `modes/settings.ts`: `dispersion.library.<material>: {alternative?, extrapolate?}` (read by prepare.ts only; em-modes ignores it). No automatic alternative selection (an explicit choice is auditable).
D2 (09:33): library dispersion needs `ref:` on the tfln materials (LN, SiO2, Air); the override values stay, so n, eps_r, r_eo resolve exactly as before (overrides win). This touches the `materials` block beyond "physics settings only"; listed for the coordinator.

## 3. TODO

- [x] Baseline dumps (materials, em-modes solves, S3 script)
- [x] prepare.ts: kappa, dispersion, emw-2d NEEDS + lambda, MaterialLibrary
- [x] settings.ts `dispersion.library`
- [x] tfln-mzm-eo.yaml switch; numbers
- [x] tests
- [x] regression after, physics tests, `pnpm -r check`
- [x] hand-off

## 4. Results (F, 2026-11-18 09:40 PST)

| Item | Result |
|---|---|
| tfln-mzm-eo n_g_0 | 2.2794263432655026 (was 2.2262262336348586); CP-43 paper-simulated 2.276 (tol 0.05): +0.0034 |
| tfln-mzm-eo n_g_1 | 2.441279462748327 (was 2.3818281940175825) |
| tfln-mzm-eo n_eff_0, VpiL | 1.8007141887720186, 0.04220787356923662 V m (4.2208 V cm): bitwise unchanged; all fields unchanged |
| library dn/dlambda at 1.957 um (1/m) | LN perp -31490.488092577736, par -26632.793507610328 (Zelmon, smooth); SiO2 -14315.326963915826 (Malitson, smooth, extrapolated flag); Air -0.40121996453640674 (Mathar table, piecewise-linear): bitwise equal to the DevLog-043 R3 numbers |
| library vs override, Au / air SPP (em-modes loss) | n_eff, kappaEff, Lprop within 1e-12 rel (same inputs) |
| library vs override, ITO channel (emw-2d, 0.6595 um, single wavelength) | S11, S21 re / im within 1e-12; |S21| vs exp(-k0 kappa L) within 1e-2 |

Regression (before 09:30, after 09:36):
- materials dump of all 48 sims, every non-parametric study (`logs/I1-matdump-{before-20261118T093043,after-20261118T093647}.json`): 47 identical (materials as exact strings, non-mesh notes); tfln-mzm-eo differs only by the 4 added dn_dlambda values and their 4 provenance notes.
- em-modes solves, 9 sims (S2 script; `logs/I1-modes-regress-*`): 8 identical (eigenvalues, scalars, field sums of squares); tfln-mzm-eo only `ng_0`, `ng_1` changed.
- S3 script (mesh hash + tagHash of 48 sims at order 1 / 2; 3D solves with field sha-256; `logs/I1-S3-regress-*`): identical, and identical to S3's own after-dump of 09:17.
- `pnpm --filter @amp/physics test`: 162 / 162 (`logs/I1-physics-test-20261118T093801.log`); new file 5 / 5 (`logs/I1-prepare-materials-test-20261118T093617.log`, with modes-dispersion 3 / 3). `pnpm -r check`: clean, apps/web 0 errors (`logs/I1-check-*.log`).

## 5. Open items and requests

- O1 emw-2d frequency study with several frequencies: library values are resolved once without a wavelength (DevLog-042 O4); wavelength-dependent library n / kappa then fail and need overrides (noted in the run).
- O2 a library alternative can be named only for dispersion (`settings.dispersion.library.<material>.alternative`); the library `n` itself still uses the default leaf, so the tfln air n stays an override. A material-level `alternative` (spec materials schema, coordinator-owned) would cover both.
- O3 emw-2d: when a library material gives eps_r and n, the module uses eps_r (noted per material). For an emw-2d-only study an override n (or kappa) without override eps_r keeps library eps_r / tan_delta out (noted). Library eps_r values are mostly low-frequency permittivities.
- O4 kappa dispersion is not in eps_g (DevLog-043 4.1); uniaxial kappa still rejected by em-modes.
- O5 SiO2 dn/dlambda at 1.957 um carries the `extrapolated` flag (air-to-vacuum conversion with Ciddor air beyond 1.69 um; DevLog-043 O6).
- R1 (coordinator) D2: `sims/tfln-mzm-eo.yaml` got `ref:` on LN, SiO2, Air (overrides unchanged), the `dispersion` setting, one header comment line and one provenance line.
- R2 (coordinator) out-of-lane one-line edit: `packages/physics/test/modes-dispersion.test.ts` G-TFLN sets `settings.dispersion = false` for its non-dispersive base (the sim now carries dispersion; deleting the key would break the sim's provenance path).
- R3 (CONTRACTS changelog): prepareRun binds library `kappa` (em-modes `loss`), `dn_dlambda` / `dn_dlambda.perp|par` (em-modes `dispersion`, provenance notes), emw-2d properties with lambda = c0 / f for one frequency; `MaterialLibrary` gains optional `get` and eval options `component`, `alternative`, `extrapolate`; em-modes settings `dispersion.library.<material>: {alternative?, extrapolate?}`.
- R4 (eval, chunk 2): CP-43 `n_g_optical` can now be gated (2.2794 vs 2.276, abs tol 0.05).

## 6. Progress log

- 2026-11-18 09:28 PST: read CLAUDE.md, DevLog-037 s.3-7, -041 s.5, -043 s.2-6, -042 s.6, prepare.ts, modes/index.ts (loss / dispersion), modes/settings.ts, wave2d/index.ts (media, studyFrequencies), @amp/materials dispersion.ts / library.ts, tfln-mzm-eo.yaml.
- 2026-11-18 09:30 PST: baseline dumps started (`logs/I1-matdump-before-20261118T093043.json`, `logs/I1-modes-regress-before-20261118T093043.json`, `logs/I1-S3-regress-before-20261118T093043.json`).
- 2026-11-18 09:33 PST: plan written.
- 2026-11-18 09:33-09:35 PST: prepare.ts (opticalMaterialContext, libraryDispersion, emw-2d NEEDS / OPTIONAL, kappa at lambda, MaterialLibrary widened), settings.ts `dispersion.library`, tfln-mzm-eo.yaml switched; tfln run: n_g 2.27943, n_eff and VpiL unchanged.
- 2026-11-18 09:35-09:36 PST: tests `prepare-materials.test.ts` (5); first run: provenance path broke when a test deleted `settings.dispersion` (fixed: set false; same fix in modes-dispersion G-TFLN, R2), one over-broad note assertion fixed. 8 / 8 with modes-dispersion.
- 2026-11-18 09:36-09:40 PST: regression after (materials dump, em-modes solves, S3 script), physics tests 162 / 162, `pnpm -r check` clean.
