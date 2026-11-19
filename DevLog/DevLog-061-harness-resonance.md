# DevLog-061: harness resonance search, driven result names, band-sim specs (lane G4, chunk 3)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | G4 (DevLog-037 s.4.2), chunk 3 |
| Owns | `packages/eval/**`; `eval/schema/amp-eval-0.schema.json` (resonance extract); `packages/physics/src/wave2d/spec.ts` (result names only); `validation/c/build_cases.py` (WO-61, WO-04 entries only); `validation/c/cases_ext/driven.py` (WO-73 only); `eval/cases/c/{WO-61,WO-04,WO-73}.yaml` (builder output); this file |
| Read | CLAUDE.md; DevLog-037 s.4.1, s.4.2; DevLog-047 (R3, R4, O2, s.4.2 ring table); DevLog-050 s.5 R5; DevLog-055; `eval/README.md`; `packages/eval/src/**`; `packages/physics/src/wave2d/{spec,index}.ts`; `packages/post/src/evaluations.ts` (evalGlobal); `apps/web/src/lib/results/adapter.ts` (global items, tables); `validation/driven/{ring_scan.ts,ring_reference.json}`; `validation/c/cases_ext/{bloch,driven}.py`; `validation/c/build_cases.py` (WO-04 / WO-61 entries); `sims/{ring-resonator-bus,phc-square-rods-bands,phc-triangular-rods-bands}.yaml` |
| Status | done 2026-11-18 (s.9 hand-off); class c run in s.8 |

Conventions: F = fact read from code or a run; D = decision of this lane (reason given); E = estimate; O = open item; R = request.

## 1. Plan (2026-11-18 18:16 PST, before coding)

### 1.1 Facts
- F: the engine worker (`packages/eval/src/engine-worker.ts`) runs each mesh level once (`prepareRun` + `runStudy`) and extracts every target from that one Solution. A resonance needs several solves per level at other wavelengths.
- F: a frequency study takes `settings.wavelengths` (emw) or `settings.values` (Hz); with more than one entry wave2d suffixes every scalar with `_<step>` (`packages/physics/src/wave2d/index.ts` `sfx`); one study run shares the symbolic analysis over its frequencies (one numeric factorization each). `prepareRun` keeps a mesh chain cache, so a re-prepare with another study list reuses the level's mesh (the ring scan script does exactly this).
- F: the harness pre-check of result names (`registry.ts` `known`) turns each `<x>` of a RESULT_NAMES entry into `[^_]+`; `S<i><j>_abs` does not match `S11_10_abs` nor `S21_abs_3`, hence DevLog-047 R3.
- F: ring example (DevLog-047 s.4.2): drop peaks (Lorentzian fit centres) 1.5303997 / 1.5305649 um (m = 24, levels 0 / 1), 1.5838438 / 1.5839975 um (m = 23); isolated ring (exact) 1.5310262 / 1.5846400 um; loaded Q about 2258 (m = 24), 1688 (m = 23); level 0 solve about 1.1 s (48.5k DOF), level 1 about 5.3 s (194k DOF, 0.91 GB RSS).
- F: a results `global` item resolves scalars by exact name (`packages/post/src/evaluations.ts` `evalGlobal`); a table of global items has one row (last step) (`apps/web/src/lib/results/adapter.ts` `evalTable`, `onlyGlobal`). Per-frequency global items therefore need `packages/post` (lane G2) and `apps/web/src/lib/results` (lane G7): request, not code here (coupling rule s.4.2).

### 1.2 Resonance extract (harness)
`extract: {kind: resonance, scalar, power?, shape: peak | dip, baseline?, axis: wavelength | frequency, window: [lo, hi], window_unit, scan?, output, tol?, max_iter?, study?}`.
Per mesh level, in the worker (one search per distinct search definition and level, shared by every target that reads it):
1. Coarse scan: `scan` points (default 13) evenly over the window, one study run (the study's `wavelengths` / `values` replaced by the list). y = scalar^power. Peak function p = y (peak) or baseline - y (dip, baseline default 1). The largest p at the window edge is an error (window too narrow), never a silent edge value.
2. Lorentzian refinement: 1 / p of a Lorentzian p = A / (1 + ((x - x0) / g)^2) is exactly quadratic in x, so a quadratic least-squares fit of 1 / p gives x0, g, A in closed form. Start from the three samples around the scan maximum; then iterate on 5 new samples at x0 + g {-1, -1/2, 0, 1/2, 1}, refitting on the newest batch only, until |dx0| <= tol * 2g and |dg| <= tol * g (tol default 1e-3, max_iter default 6).
3. Half-maximum width (second width estimate, no line-shape model): p_pk = p(x0) from the last batch; each crossing p(x) = p_pk / 2 by secant iteration from x0 -+ g and x0 -+ 1.1 g (both sides in one run per iteration) until the step is below tol * g (max 8 iterations).
4. Outputs: `center` (x0), `fwhm` (2g), `q` (x0 / 2g), `center_halfmax`, `fwhm_halfmax`, `q_halfmax`, `peak` (y at x0, the scalar^power itself; a dip gives the minimum). Per-level diagnostics in the JSONL (solves, iterations, last centre change, max relative fit residual over the last batch).
Method error (to verify in tests): exact Lorentzian in x -> x0, g to round-off; a Lorentzian in frequency read on a wavelength axis -> width error of order 1 / Q; a smooth background or a neighbouring line -> shows in the fit residual and in the fit vs half-maximum width difference (reported, not hidden).
FSR: a `combine` target on two centres (existing harness kind), no new code.

### 1.3 WO-73 gates (decision basis written before the runs; final tolerances recorded with their basis in s.4)
- Gate: Lorentzian Q vs half-maximum Q per resonance and level (method consistency, as DevLog-047), drop power at the peak vs coupled-mode theory (lossless symmetric add-drop transfers all power at resonance), harness centre vs the scripted scan of DevLog-047 (same engine, different search: checks the extract), FSR vs the exact isolated ring with a tolerance from a stated bound on the coupling-induced shifts.
- Informative: resonance wavelengths vs the isolated ring (coupling-induced shift about 0.7 linewidths, not computed independently), Q (no independent reference).
- Cost: E: about 25-35 solves per resonance per level; two resonances: level 0 about 1-2 min, level 1 about 5-7 min, within the 600 s worker cap only with a case budget; to measure on level 0 first.

### 1.4 Result names (wave2d spec.ts, names only)
Append higher-mode S names `S<i><j>_<p><q>_{re,im,abs,dB,phase}` and the `_<s>` step-suffixed form of every frequency-study scalar (emw-2d and acoustics-frequency). Order kept (the web add-menu filters out names with `<`).

### 1.5 WO-61 / WO-04 on the emw-2d band sims
Builder entries only: case `spec:` -> `sims/phc-triangular-rods-bands.yaml` (WO-61), `sims/phc-square-rods-bands.yaml` (WO-04); extracts `f * a / c` with `fmax_0` / `fmin_1` (a = 1 um, c = 299792458 m/s) on every target; convergence two nested levels [1, 0.5] (the band sims' WO-90 / WO-93 levels; Richardson needs three levels, the third over the time budget), gated targets `after: finest` at the same rel 1e-4. The acoustic-analog sims (`phc-square-rods-lower/-upper`) stay in `sims/` as hidden models, no longer referenced by WO-04.

### 1.6 Requests (to write in s.6)
- R4 per-frequency global items: exact lines for `evalGlobal` (G2) and the adapter / table (G7).
- CONTRACTS changelog text for the resonance extract kind and the result names.

## 2. TODO
- [x] resonance module + worker integration + loader / schema + tests
- [x] wave2d result names + harness test
- [x] WO-73: timing, gates, driven.py, rebuild, CLI
- [x] WO-61 / WO-04 builder entries, rebuild, CLI
- [x] gates: eval tests, physics tests, CLI list, class c full run
- [x] requests, results, hand-off

## 3. Progress log
- 2026-11-18 18:16 PST: read the brief files; plan written (s.1). Class c baseline (coordinator run logs/eval-20261118T150503, before chunk 3): 28 pass / 1 fail / 28 pending cases; targets 174 / 2 / 78, 48 info.
- 2026-11-18 18:20 PST: `packages/eval/src/resonance.ts` (search) and `test/resonance.test.ts` (synthetic line shapes): exact Lorentzian recovered to round-off (centre 1e-10 um, FWHM 1e-8 rel); frequency Lorentzian on a wavelength axis within 2 / Q; background plus a neighbouring line moves the centre by about 2e-3 FWHM and shows in the residual and the width difference; window-edge, flat and non-finite inputs are errors. F: the secant half-maximum crossings converge well below their stopping step (an expected 'fail' at a 1e-7 Q tolerance passed; test corrected).
- 2026-11-18 18:22 PST: worker integration (search per level and search definition, shared by targets; study list replaced; values converted from the window unit; diagnostics per level `diag` in the record), loader checks, schema (`kind: resonance` and its keys; additions only, verified by diff after a first JSON rewrite had folded a duplicate key: restored), registry name pre-check for resonance, exported `nameDeclared`. End-to-end test with a mock module: pass.
- 2026-11-18 18:23 PST: wave2d `RESULT_NAMES_WAVE2D`: higher-mode `S<i><j>_<p><q>_*` and step-suffixed `<name>_<s>` of every frequency-study scalar (both emw-2d and acoustics-frequency); test of declared / undeclared names through `nameDeclared`.
- 2026-11-18 18:24 PST: WO-73 builder (s.4), WO-04 / WO-61 builder entries (s.5); builder to scratch, only WO-73, WO-04, WO-61 copied; the other driven and band cases byte-identical. WO-73 CLI run started (`--timeout 1500` for the first timing).
- 2026-11-18 18:31 PST: WO-73 first run: 22 pass, 12 info, 347 s, 1.24 GB (s.4.2). Budget native 180 s set from it (also sets the per-worker limit); `levels` (with `diag`) now kept in single-level target records.
- 2026-11-18 18:34-18:46 PST: CLI gate list (`logs/G4-cli-20261118T183429.log`): WO-04, WO-61, WO-73, WO-90..WO-93, WO-70..WO-72, RF-70 all pass (s.8). WO-73 note text corrected (measured shift per level); rebuilt; `test_build_matches.py` ok (63 class-c cases, 0 differing).
- 2026-11-18 18:47 PST: eval tests 99/99 (`logs/G4-eval-tests-*.log`), eval and physics typecheck clean.
- 2026-11-18 18:47-19:11 PST: physics tests 209/209; full class c run (s.8).

## 4. WO-73 ring resonances (harness)

### 4.1 Decisions (D) and tolerance bases
| Target (per order m = 24, 23 and level 0, 1) | Reference | Tolerance and basis | Gate |
|---|---|---|---|
| `lam<m>` drop-peak centre | scripted scan of the same model (DevLog-047 s.4.2, 7 digits) | abs 0.01 FWHM (6.8e-6 / 9.4e-6 um); the two searches differ by their fit span on a line that is Lorentzian in frequency (asymmetry O(1 / Q)); expected about 1e-3 FWHM | yes: method cross-check of the extract on the real model |
| `drop<m>` drop power at the centre | 1 (coupled-mode theory, derivation below) | abs 1e-3 (DevLog-047's value, set after its runs; 1 - D measured 5e-5..9e-5) | yes |
| `Qcons<m>` Lorentzian Q / half-maximum Q - 1 (combine) | 0 | abs 3e-3: about 5 / Q of the lower-Q line (1 / Q = 4.4e-4, 5.9e-4) | yes: consistency of two width estimates |
| `fsr` order 23 minus order 24 centres (combine) | isolated ring (exact) 53.6138 nm | rel 1e-2, labelled estimate: the coupled FSR differs from the isolated FSR by the difference of the two coupling-induced shifts, which has no independent reference here; DevLog-047 measured -0.34 %; 1e-2 is about 3x that and below the FSR change of a 1 % error in group index or radius (FSR = lambda^2 / (n_g 2 pi R)) | yes, with that basis stated in the case |
| `lam<m>_iso` centre vs the isolated ring | exact annulus modes | shown against 1 FWHM | no: coupling-induced shift (about -0.7 FWHM), no independent reference |
| `Q<m>`, `Qhm<m>` | scripted scan | rel 1e-2 shown | no: the loaded Q is set by the couplers; no independent reference |

Drop power at resonance (coupled-mode theory in time, lossless, two identical couplers): resonator amplitude a with da/dt = (j w0 - 2 / tau_e) a + kappa s_in, kappa = sqrt(2 / tau_e) (power conservation for one port of decay rate 1 / tau_e), drop output s_d = kappa a. At w = w0: a = kappa s_in / (2 / tau_e), |s_d|^2 / |s_in|^2 = kappa^4 tau_e^2 / 4 = 1. Departures: unequal couplers on the mesh (the two buses are meshed independently), radiation (radiation Q above 1e9, ring_reference.json), the higher port modes.

### 4.2 Results (`logs/eval-20261118T182526.jsonl`, CLI `--case WO-73 --timeout 1500`, 347 s wall, peak RSS 1.24 GB; 34 targets: 22 pass, 12 info)
| Quantity | Level 0 | Level 1 | Reference | Result |
|---|---|---|---|---|
| order 24 centre, um | 1.5303984 | 1.5305636 | scan 1.5303997 / 1.5305649 | diff -1.27e-6 / -1.29e-6 um (0.0019 FWHM): pass |
| order 23 centre, um | 1.5838415 | 1.5839952 | scan 1.5838438 / 1.5839975 | diff -2.30e-6 / -2.28e-6 um (0.0024 FWHM): pass |
| same vs isolated ring | -0.628 nm (0.93 FWHM) / -0.798 nm (0.85 FWHM) | -0.463 nm (0.68 FWHM) / -0.645 nm (0.69 FWHM) | 1.5310262 / 1.5846400 um | info |
| FSR, nm | 53.4431 | 53.4316 | 53.6138 | -0.318 % / -0.340 %: pass (tol 1 %) |
| Q fit / half-maximum, order 24 | 2257.84 / 2257.87 | 2258.61 / 2258.64 | | Qcons -1.3e-5 / -1.5e-5: pass |
| same, order 23 | 1688.65 / 1688.70 | 1689.13 / 1689.17 | | Qcons -2.4e-5 / -2.4e-5: pass |
| drop power at centre, order 24 / 23 | 0.999947 / 0.999910 | 0.999962 / 0.999914 | 1 | pass (tol 1e-3) |
| reciprocity, energy | <= 7.6e-14 | <= 2.0e-13 | 0 | pass (unchanged targets) |

Reading (F unless marked): the harness centres sit 1.3e-6 to 2.3e-6 um below the scripted-scan fit centres, the same offset as between that scan's own zoomed maximum and its 11-point fit (DevLog-047 logs: 1.5303973 vs 1.5303997 um): the local fit (+-1/2 FWHM) finds the maximum, the wide fit (+-1 FWHM) is pulled by the line-shape asymmetry. The two harness Q estimates agree to 2.4e-5, ten times closer than the scan's (2.2e-4..5.3e-4), for the same reason; the scan's half-maximum Q agrees with the harness half-maximum Q to 4e-5 (info targets). Level 0 to 1: centres move +0.165 / +0.154 nm (0.24 / 0.16 FWHM).
Search diagnostics (rerun with the case budget and default time limits, `logs/eval-20261118T183615.jsonl`, values bitwise equal to the first run): 26 solves per search (9 scan + 2 x 5 refinement + 5 + 2 x 1 secant), centre change at the last refinement 5e-7..9e-6 FWHM, max relative residual of the 5-point Lorentzian fit 9.2e-4 (order 24) / 1.2e-3 (order 23), i.e. about 2 / Q, the expected asymmetry of a frequency Lorentzian on the wavelength axis; secant half-maximum steps 1.6e-5..2.2e-5 g at stop. Search time 22-23 s (level 0), 118-146 s (level 1).

## 5. WO-04 / WO-61 on the emw-2d band sims
- Builder (`validation/c/build_cases.py` `t2_apply`, the WO-04 entry replaced, WO-61 added): case `spec:` `sims/phc-square-rods-bands.yaml` (WO-04), `sims/phc-triangular-rods-bands.yaml` (WO-61); every target `extract: f * a / c` with `fmax_0` (lower edge) / `fmin_1` (upper edge), a = 1 um (sim param), c = 299792458 m/s; per-target `spec:` removed; tolerances unchanged in value, `after: finest`; convergence h [1, 0.5] (as WO-90 / WO-93); budget native 40 s / 60 s with the WO-90 / WO-93 measured basis (also sets the worker time limit). D: same lattices and the same MPB references as WO-90 / WO-93, which already gate both levels; WO-04 / WO-61 now gate the finest level of the same runs (the coordinator's chunk 2 R5 decision deferred this to now).
- Results (CLI, `logs/eval-20261118T183429.jsonl`, `...183512.jsonl`; finest level vs MPB Richardson, tol rel 1e-4): WO-04 gap_lower 0.2806618 (rel 9.3e-6), gap_upper 0.4171626 (5.7e-7), 41.5 s cold; WO-61 gap_lower 0.2744187 (6.1e-6), gap_upper 0.4452165 (3.4e-6), 61.8 s cold; both cases pass (2 gated, 6 info each).
- F: the acoustic-analog sims `sims/phc-square-rods-lower.yaml` / `-upper.yaml` stay in `sims/` as hidden library models (catalog rule HIDDEN_ANALOGS: acoustics analogs of EM problems are not listed, openable by link); no case runs them now; catalog `evalCases` edit requested (R3).

## 6. Requests

- R1 (lane G2, `packages/post/src/evaluations.ts`; via the coordinator; DevLog-047 R4 part 1): per-frequency global items. In `evalGlobal`, accept a step and resolve the step-suffixed scalar of a multi-frequency solution first:
```ts
export function evalGlobal(sol: Solution | null, expr: string, o: Pick<ExprOptions, 'params' | 'physicsId'> & { step?: number } = {}): { value: number; unit: string; dim: number[] } {
  const scalars = sol?.scalars ?? {};
  // a frequency study with several frequencies names its scalars '<name>_<step>' (wave2d); a global item at a step reads that form
  const stepped = o.step !== undefined && sol?.steps?.kind === 'freq' && sol.steps.values.length > 1;
  ...
      for (const k of [name, ...(segs.length > 1 && (!o.physicsId || segs[0] === o.physicsId) ? [segs.slice(1).join('.')] : [])]) {
        const ks = stepped ? `${k}_${o.step}` : null;
        if (ks && Object.hasOwn(scalars, ks)) { const s = scalars[ks]!, u = parseUnit(s.unit || '1'); return { kind: 'const', re: s.value * u.factor, dim: u.dim, global: true }; }
        if (Object.hasOwn(scalars, k)) { /* unchanged */ }
      }
```
  Test: a two-frequency wave2d solution (or a hand-built Solution with `steps: {kind: 'freq', values: [f0, f1]}` and scalars `S21_abs_0`, `S21_abs_1`): `evalGlobal(sol, 'w.S21_abs^2', {physicsId: 'w', step: 1})` equals `S21_abs_1^2`; without `step` the bare-name behaviour is unchanged (error naming the available scalars).
- R2 (lane G7, `apps/web/src/lib/results/adapter.ts`; via the coordinator; DevLog-047 R4 part 2): (a) `evalItemAt` case `'global'`: pass the step, `evalGlobal(sol, expr, { params, step, ...(s.physicsId ? { physicsId: s.physicsId } : {}) })`; (b) `evalTable`: a group of global items on a multi-frequency solution gets one row per step and the step column: `const multiFreq = steps?.kind === 'freq' && steps.values.length > 1;`, `const withStep = !!steps && (!onlyGlobal || multiFreq);` and in the row loop `own.set(it, onlyGlobal && !multiFreq ? stepIndices(run.solution, 'last') : stepIndices(run.solution, itemSteps(ix, it, g)))`. Then a `global` plot item or a table graph over one multi-wavelength study draws a spectrum (no parametric sweep needed). The harness `result` extract with `step: k` then reads per-frequency global items without harness changes.
- R3 (coordinator, `apps/web/src/lib/library/catalog-bc.ts`): WO-04 now runs on `sims/phc-square-rods-bands.yaml` and WO-61 on `sims/phc-triangular-rods-bands.yaml` (s.5). Edit `evalCases`: `phc-square-rods-lower` and `phc-square-rods-upper` -> `[]` (their `ref` texts "gap_lower 1/1 gated ..." then describe an earlier run; suggest `ref: {status: 'info', date: '2026-11-18', targets: 'scalar analog of the WO-04 gap edges; WO-04 now runs on phc-square-rods-bands', via: 'harness'}`), `phc-square-rods-bands` -> `['WO-90', 'WO-91', 'WO-04']`, `phc-triangular-rods-bands` -> `['WO-93', 'WO-61']`. The two analog sims stay hidden library models (HIDDEN_ANALOGS rule, openable by link).
- R4 (coordinator, `DevLog/contracts/CONTRACTS-v0.md` changelog): text in s.7.
- R5 (coordinator, `eval/README.md`, not owned here): after the `Derived values` bullet add: "- Resonances (`extract.kind: resonance`): `{name, power?, shape: peak | dip, baseline?, axis: wavelength | frequency, window: [lo, hi], window_unit, scan?, output}` re-solves the target's frequency study per mesh level at chosen wavelengths (or frequencies): coarse scan of `scan` points (default 13; the step should be below the linewidth; an extreme at the window edge is an error), Lorentzian refinement (quadratic least squares of 1 / p on 5 points at x0 + g {-1, -1/2, 0, 1/2, 1}, until the centre moves by <= tol FWHM), half-maximum crossings by the secant method; `output` center, fwhm, q (Lorentzian fit), center_halfmax, fwhm_halfmax, q_halfmax (crossings), peak (scalar^power at the centre). Targets with the same search share it; FSR is a `combine` of two centres. Per-level diagnostics (`diag`: solves, iterations, centre change, fit residual, search time) are in the target record. Example: WO-73."

## 7. CONTRACTS changelog text (for the coordinator, R4)
- 2026-11-18, coordinator: G4 (DevLog-061): C8 extract kind `resonance` {name (per-step scalar), power?, shape: peak | dip, baseline? (dip, default 1), axis: wavelength | frequency, window: [lo, hi], window_unit, scan? (default 13), output: center | fwhm | q | peak | center_halfmax | fwhm_halfmax | q_halfmax, tol? (default 1e-3), max_iter? (default 6)}: per mesh level the harness re-solves the target's frequency study at chosen points (study `wavelengths` or `values` replaced), coarse scan, Lorentzian refinement through a quadratic fit of 1 / p, secant half-maximum crossings; one search per level and definition, shared by targets; centre / width converted from the window unit; per-level `diag` (solves, iterations, centre change, fit residual, search time) in the target record (`levels` also kept for single-level targets with diagnostics). `@amp/eval` exports `nameDeclared(names, x)` (RESULT_NAMES wildcard rule). emw-2d / acoustics-frequency result names: higher port modes `S<i><j>_<p><q>_{re,im,abs,dB,phase}` and the step-suffixed `<name>_<s>` of every frequency-study scalar (several frequencies in one study).

## 8. Gates
| Gate | Result | Record |
|---|---|---|
| eval tests | 99 / 99 (8 new in `test/resonance.test.ts`) | logs/G4-eval-tests-*.log |
| physics tests | 209 / 209 | logs/G4-physics-tests-20261118T184636.log |
| eval / physics typecheck | clean | |
| `test_build_matches.py` | ok, 63 class-c cases, 0 differing | |
| CLI WO-04 / WO-61 | pass 2 + 6 info each | logs/eval-20261118T183429, 183512 |
| CLI WO-73 | pass 22 + 12 info (was 8 / 8) | logs/eval-20261118T183615 |
| CLI WO-90 / 91 / 92 / 93 | pass 4+4 info / 8 / 4 / 4 | logs/eval-20261118T184150..184334 |
| CLI WO-70 / 71 / 72, RF-70 | pass 18 / 42 / 18 / 6 | logs/eval-20261118T184449..184548 |
| class c (skip WO-65) | before (logs/eval-20261118T150503, 57 cases): 28 pass / 1 fail / 28 pending; targets 174 / 2 / 78, 48 info. After (63 cases): 35 / 1 / 27; targets 211 / 2 / 68, 94 info. Status changes: WO-61 pending -> pass (this lane); PK-07..PK-11, WO-86 new (other lanes) pass; WO-04 pass -> pass (now on the band sim); WO-73 8 -> 34 targets. Only fail: RF-62 (unchanged, pre-existing) | logs/eval-20261118T185253.jsonl |

## 9. Open items and hand-off
- O1 WO-73 resonance centres vs the exact ring stay informative until the coupling-induced shift has an independent value (options: a coupled-mode or perturbation calculation of the shift for this coupler; or the same ring at two or three larger gaps through params overrides, showing the centre approach the isolated value as the coupling falls; the narrower lines need a finer coarse scan, about 30 solves per level).
- O2 The resonance search costs 26 solves per resonance and level (WO-73 level 1: 118-146 s); a level-1 search seeded from the level-0 result (narrower window, fewer scan points) would save about 5 solves.
- O3 Per-frequency global items (DevLog-047 R4) need R1 (post) and R2 (results adapter); no harness change is needed after them (the `result` extract already passes `step`).
- O4 After R3 (catalog evalCases) the library pages of the analog sims no longer claim WO-04.
- Files: `packages/eval/src/{resonance.ts, engine-worker.ts, loader.ts, evaluate.ts, registry.ts}`, `packages/eval/test/resonance.test.ts`, `eval/schema/amp-eval-0.schema.json` (additions), `packages/physics/src/wave2d/spec.ts` (names), `validation/c/cases_ext/driven.py` (WO-73), `validation/c/build_cases.py` (WO-04 / WO-61 in `t2_apply`), `eval/cases/c/{WO-04,WO-61,WO-73}.yaml`, this file.
