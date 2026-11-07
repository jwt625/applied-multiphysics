# DevLog-009: Eval harness (`@amp/eval`, lane L8)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L8 (evaluation harness) |
| Owns | `packages/eval/**`, `eval/schema/**`, `eval/README.md`, this file |
| Reads | DevLog-001 (A5, A12, targets, M1), CONTRACTS-v0 (C1, C4, C5, C8), R3 s.2 and s.5, `eval/cases/**`, `eval/expected/**`, sibling `validation/` dirs (read-only) |
| Status | Follow-up 3 done 2026-11-06 16:58 PST (section 10); first real engine run: 9 class-a cases, 7 pass, 2 fail |

## 1. Plan (written 2026-11-06 15:13 PST, before code)

Ideas reused from the atlases (read-only survey):
- Same case file read by engine and references (APA `ap-sim-val/0`, EO `eo-atlas.sim/v1`): the harness loads `eval/cases/<class>/<ID>.yaml`; Python references in `validation/` read the same file.
- Richardson extrapolation with observed order (Celik et al. 2008 fixed-point for non-constant ratio) and GCI with safety factor 1.25 (APA `apref/convergence.py`).
- Tolerance budget printed next to the measured difference (APA `compare.py` `limit` field).
- Exit code 2 on a missed target, 1 on an error (EO `engine/cli.mjs` L110-128).

Package layout (`packages/eval`):

| File | Purpose |
|---|---|
| `src/contract-shim.ts` | C4/C5 shapes (Solution, RunRecord, PhysicsModule, RunContext) until L2 publishes `packages/spec/src/types/` |
| `src/yaml.ts` | YAML parse with source positions (`yaml` package; same dep as `@amp/spec`) |
| `src/schema-validate.ts` | Dependency-free JSON-Schema subset validator (draft 2020-12 keywords used by the schema), errors as JSON pointers |
| `src/loader.ts` | Discover, parse, validate cases; semantic checks (id = filename, class = dir, untestable reason, expected JSON present); error `file:line:col /json/pointer message` |
| `src/metrics.ts` | rel/abs error vs tolerance (with budget), field L2/max at sample points, convergence-rate least-squares fit, observed order, Richardson + GCI, eigenvalue matching with multiplicity |
| `src/speed.ts` | warm-up + median of 5, per-stage timing from `Solution.timing`, time-to-accuracy over a mesh sequence, CEED BP-style throughput (DOF x CG iterations / s) |
| `src/registry.ts` | Physics registry hook; resolves `@amp/physics` modules by case physics tag when present |
| `src/adapters/*.ts` | `expected` self-check adapter; `python` adapter (`uv run` in `validation/`) |
| `src/runner.ts` | Per case: registered module -> run(ctx) -> metrics; else `pending` with reason |
| `src/report.ts` | JSONL per C8 to `logs/eval-YYYYMMDDTHHMMSS.jsonl` + `logs/eval-...-summary.md` |
| `src/cli.ts` | `node packages/eval/src/cli.ts [--class a|b|c] [--case ID] [--tag physics] [--dry-run] [--speed] [--json] [--adapter expected|python]`; exit 0/1/2 |
| `bench/poisson.ts` | Synthetic Poisson problem for the speed harness on `@amp/core` (after L1 lands) |
| `test/*.test.ts` | `node --test`: loader, metrics with known inputs, exit codes |

Schema: `eval/schema/amp-eval-0.schema.json`, JSON Schema 2020-12, finalized from R3 s.2 plus C8 (`spec` embedded / `sims/` ref / pending). Changelog in section 3.

## 2. TODO

- [x] Schema file + changelog
- [x] Shim types, YAML adapter, validator, loader
- [x] Metrics
- [x] Speed harness (interface; run once `@amp/core` lands)
- [x] Registry, adapters (expected self-check, python, exact-field bridge), runner
- [x] Report JSONL + summary
- [x] CLI with exit codes
- [x] Unit tests (loader, metrics, exit codes)
- [x] Dry run over every existing case (0 loader errors or errors listed)
- [x] Speed harness on synthetic Poisson with `@amp/core`
- [x] `eval/README.md`
- [x] TS port of the 8 exact-field closed forms, gate 1e-12 vs the Python CLI
- [ ] Engine run once `@amp/physics` exports `modules` + `prepareRun` (L4 in progress at 15:45)
- [x] Continuous validation of L7a/L7b/L7c cases, failures per lane (section 6; last pass 15:56, 85 cases)

## 3. Schema changelog (`amp-eval/0`)

File: `eval/schema/amp-eval-0.schema.json` (JSON Schema 2020-12, validated by `packages/eval/src/schema-validate.ts`, a dependency-free subset validator that throws on any keyword it does not implement).

Changes relative to the R3 s.2 draft, 2026-11-06:

| # | Change | Why |
|---|---|---|
| S1 | Required top-level keys: `schema, id, class, title, status, physics, dimension, spec, references, rights` | R3 s.2 shows all of them; `spec` is required by C8 |
| S2 | Unknown keys are errors everywhere the schema lists keys (top level, `references[]`, `tolerance`, `rule`, `extract`, `convergence`, `speed`, `rights`, `hero`, `adapter`); `x-*` top-level keys allowed as an escape hatch | Typos such as `tolerence` must not pass silently; C3 strict-keys rule |
| S3 | `spec` (C8): `sims/<path>.yaml` string, embedded object with `schema: amp-spec/0` (contents owned by L2, not validated here), or `{status: pending, reason}` | C8 "spec may be pending with reason" made concrete |
| S4 | `id` pattern `^[A-Z]{2,4}-[0-9]{2,3}[A-Za-z0-9._-]*$`; must equal the file stem; `class` must equal the directory | R3 ids (`SM-01`); stable file layout |
| S5 | `physics` tags: the R3 enum, plus pattern `coupled-<a>(-<b>...)` | R3 tag list; R3 uses `coupled-heat-ns` |
| S6 | `dimension`: enum (`0D, 1D, 1D-axisym, 1D-spherical, 2D, 2D-axisym, 2D-periodic, 3D, 3D-periodic`) or a list of them | R3 rows use 1D-axisym (CP-03) and several dims per case (EM-04) |
| S7 | `references[]`: required `quantity, unit, tolerance, basis, form, provenance` and one of `value` / `expected_key`; optional `id` (target id, default = quantity), `definition, at, bounds, extract, gated, note` | Generated values live in `eval/expected/<ID>.json` (C8), referenced by key; several targets may share a quantity |
| S8 | `tolerance`: `rel`, `abs` (both given = `max(abs, rel |ref|)`, APA `compare.py` rule), `after: richardson | finest | none`, `norm: l2 | max` (field targets), or `rule: {type: range | sign | monotonic | rate, ...}` | R3 "or abs; or rule (range, monotonic, sign, ...)" |
| S9 | `provenance`: required `citation, locator, accessed` (ISO date, not in the future); optional `url, generator` | R3 s.2; never invent |
| S10 | `extract` (new): how to read the target from a C5 Solution: `scalar` (default, `scalars[name or quantity]`), `eigen` / `steps` (`steps.values`, with `offset`, `floor`, `match: sorted | subsequence`), `probe` (`field`, `point`), `field` (`field` + `samples_key` into the expected JSON, or `evaluator` + `points` + `params` for `validation/a/fields.py`) | The harness must know where a value lives in a Solution |
| S11 | `convergence`: `levels_min, ratio_min, method, safety_factor, expected_order, h_factors` (new: mesh scale per level) | Runner needs the level sequence; Celik order check |
| S12 | `adapter.python: {script, args}` (new) | Python reference run through `uv run --project validation` |
| S13 | `expected` (new, optional): explicit expected-JSON path; default `eval/expected/<id>.json` | C8 |
| S14 | `materials.<name>.source` required | R3 "every value with source or 'synthetic'" |
| S15 | `rights.allowed/forbidden` items are an enum (`cite_values, re_derive_setup, copy_text, copy_figures, copy_input_files, copy_code, copy_data, redistribute_data`) | Consistent rights tags |
| S16 | `status: untestable` requires a non-empty `untestable_reason`; optional `activation` | APA `ap-sim-val/0` rule |
| S17 | Optional bookkeeping keys: `notes, tags, created, updated, lane` | |
| S18 | (15:33, after the first dry run over L7a's 29 cases: 703 loader errors) `references[].metric_id` accepted as the target id (target id = `id`, else `metric_id`, else `quantity`) | L7a links targets to `eval/expected/<ID>.json` `targets[].metric_id` |
| S19 | `references[].gate` (boolean, default true) replaces my `gated` | APA `ap-sim-val/0` uses `gate`; L7a writes `gate` |
| S20 | `references[].expected: {file?, metric_id | key}` replaces `expected_key`; `file` must equal the case expected file | L7a writes `expected: {file, metric_id}`; metric ids contain dots (`T_x0.0223_t2000`), so no dotted-path keys for them |
| S21 | `bounds: null` allowed; `provenance.accessed: null` allowed only for basis D (derived here; error for P / S) | Derived values have no access date |
| S22 | `speed.budget_s.{browser,native}` may be null; `speed.budget_basis` (string) | L7a labels estimated budgets |
| S23 | pending `spec` may carry `ref` (proposed `sims/` path) | L7a |
| S24 | `rights` items: snake_case pattern instead of an enum | L7a needs `copy_booklet_content`, `copy_v_doc_text`, `copy_with_attribution` |
| S25 | `study.shift` number or string; `study.f_list` number array or string | L7a describes case-dependent shifts and frequency rules in words |
| S26 | `rule.of: value | error` (apply monotonic / range / sign to `|value - ref|`), `rule.note`, `convergence.note`; `rule: rate` also gates field targets (rate of the field error over levels) | Structured form for L7a's RF-04 trend rule and the SM-01 / FL-01 rate rules |
| S27 | Top-level `field_reference: {function, fields, complex?, note?}` and `source_case: {suite, file, url, accessed}` | L7a (informative pointers) |
| S28 | Expected-JSON `case` (as well as `id`) must equal the case id | L7a writes `case` |
| S29 | (15:36, L7b) top-level `source` (citation block: doi, open copy, re-tabulation url / cache / sha256); `references[].case` (parametric values, appended to the default target id: `u[Re=100]`); `references[].extraction` (tabulated, digitized, text, ...); `tolerance.note`, `speed.note`; rule shorthand strings `range` / `within_bounds` / `sign` (normalized to `{type: ...}`); array targets with `after: richardson` are extrapolated element-wise | L7b FL-02, FL-03, FL-20 |
| S30 | `extract.evaluator_case` (evaluator key when it differs from the case id, e.g. `FL-01-pois`) | fields.py keys |
| S32 | (15:47) physics tag `solid-nonlinear` (L7b CR-1); `source` sub-keys documented and strict: `citation` (required), `doi`, `open_access`, `open_copy`, `retabulation` (one or list), `reference_page(s)`, `secondary_references`, `later_reference`, `atlas_ref`, `note`; `$defs/fileRef` with `sha256` = 64 hex (L7b CR-2) | Coordinator relay of DevLog-007 s.6 |
| S31 | Coordinator decision 2026-11-06: sequence rules (`rate`, `monotonic` over levels or a sweep) with a single value are `pending`, not `fail` | DevLog-006 s.5 item 8; CONTRACTS-v0 changelog 15:45 |

Expected JSON (`amp-eval-expected/0`, written by L7a, not owned by L8): the loader reads `targets[]` by `metric_id` (dotted paths such as `targets.K_t.value` match array elements by `metric_id` or `id`), and warns when `generator`, `versions` or `generated_at` is missing (C8).

## 4. Progress log

- 2026-11-06 15:13 PST: read CLAUDE.md, DevLog-001, CONTRACTS-v0, R3 s.2/s.5, APA `validation/README.md` + `apref/convergence.py` + `compare.py`, EO `engine/cli.mjs` exit codes. `packages/` and `eval/cases/*` empty at this time. Plan written.
- 2026-11-06 15:20 PST: `packages/eval` package.json/tsconfig; deps installed into `packages/eval/node_modules` only (`pnpm install --ignore-workspace --config.lockfile=false`: yaml 2.9.1, typescript 5.9.3, @types/node 22.20.5); no root lockfile touched. Schema, validator, loader, metrics, speed, registry, adapters, runner, report, CLI written.
- 2026-11-06 15:25 PST: `@amp/core` found (L1 port in progress, `src/index.mjs` not yet present; subpath exports `la/*`, `fem/*` resolve). Bench `bench/poisson.ts` written against `la/stencil`, `la/pcg`, `la/mg`, `fem/q1-grid`.
- 2026-11-06 15:27 PST: L7a expected JSONs (18 at 15:25, 24 at 15:28) use `targets[]` keyed by `metric_id`; loader path lookup extended to match array elements by `metric_id`/`id`. L7a `validation/a/fields.py` (points in, values out) wired as the exact-field evaluator (`src/adapters/fields.ts`); smoke: SM-01 sxx at (0, a) = 3.0e8 Pa, at (a, 0) = 0 Pa.
- 2026-11-06 15:28 PST: unit tests 40/40, tsc clean. Richardson pass criterion settled: pass on |f_ext - ref| <= budget; GCI band of the finest level (u_num) and p_obs / expected_order are reported next to it, not gated (GCI bounds f_fine, not f_ext).
- 2026-11-06 15:30 PST: speed gate run on `@amp/core` (section 5.2). `eval/cases/{a,b,c}` still empty.
- 2026-11-06 15:31 PST: first dry run over L7a's 29 class-a cases: 703 loader errors (420 unknown keys `metric_id`, `gate`, `expected`, `budget_basis`, `spec.ref`; nullable `bounds` / `accessed` / `budget_s.native`; rights tags; prose rules). Schema S18-S28 adopted (section 3).
- 2026-11-06 15:33 PST: dry run: 3 loader errors (prose rules), listed in section 6. `rule.of` and field rate rules implemented; 41/41 tests.
- 2026-11-06 15:34 PST: `--adapter expected` self-check over class a: 85 targets pass, 0 fail (section 6).
- 2026-11-06 15:36 PST: L7b's first cases (FL-02, FL-20): new keys adopted (S29); element-wise Richardson for arrays; range rules without a reference value. Coordinator: `@amp/core` done; root `pnpm install` done (my `packages/eval/node_modules` now symlinks into the root store; the lockfile records `@types/node ^22` for this package, root has 24.19.2: left as is, coordinator may align). tsconfig base `lib` ES2023: package typechecks unchanged.
- 2026-11-06 15:37 PST: bench re-run on the finished core, n up to 96 (section 5.3).
- 2026-11-06 15:40 PST: coordinator decisions (sequence rules pending; fields via `uv run` now plus a TS port with a 1e-12 gate; L8 schema authoritative). Sequence-rule pending implemented (S31): SM-01 `field_rel_L2_stress`, FL-01 `kovasznay.field_rel_L2_u`, RF-04 `R_in` now pending in the self-check.
- 2026-11-06 15:44 PST: TS field port + gate 26/26 (section 5.4). Tests 51/51.
- 2026-11-06 15:45 PST: dry run over 49 cases: 0 loader errors (section 6).
- 2026-11-06 15:47 PST: L7b CR-1 / CR-2 adopted (S32; documented in `eval/README.md`). Dry run still 0 errors over 49 cases.
- 2026-11-06 15:48 PST: `@amp/spec` (L2 done) wired: C4/C5 types from `packages/spec/src/types` (relative type import until `@amp/eval` lists `@amp/spec`), spec loading through `parseSpecText` (sims/ files) / `validateSpec` (embedded) with the `@amp/physics` spec registry when exported, else `@amp/spec/provisional` `wave1Registry()`; unit conversion through the spec units API (affine degC; smoke 373.15 K -> 100 degC; `lbf` unknown to core units: SM-03 `F_cr_lbf` is gate false); meta platform from `probePlatform()`. Smoke: all 6 `sims/*.yaml` parse ok with the wave-1 registry. Test fixtures carry a mock `@amp/spec`. Tests 52/52.
- 2026-11-06 15:56 PST: L7c's 36 cases arrived; full validation over 85 cases (section 6): 3 loader errors (SM-07 stale metric ids), self-check 1 fail (SM-06 FV12 modes 7-9).
- 2026-11-06 16:15 PST: fresh-context audit received (`DevLog/audits/2026-11-06-L8-eval-harness-audit.md`: 5 blocking, 7 significant, 11 minor). Coordinator relays: canonical hooks are L4's (contract changelog 16:15), metric_id-only lookup, rights-tag enum with `reference_by_hash` -> hash, L4's oscillatory fallback request (DevLog-010 s.5 item 3), real engine run. Corrections in section 9.
- 2026-11-06 16:27 PST: `@amp/physics` index (7 modules, `prepareRun`, `physicsRegistry`, `RESULT_NAMES`) and `@amp/post` `sample` load in the harness. End-to-end smoke in a scratch root (AC-02 with `spec: sims/box-acoustics.yaml`, links to the real packages): the worker ran 3 levels; every target pending because the module emits `f_0 .. f_4` and the case asks for `f_mode1 .. f_mode10` (naming mismatch L4 / L7a, section 6).
- 2026-11-06 16:28 PST: audit pass done. Tests 66/66; tsc clean; CLI modes re-run (section 9.3).

## 5. Results

### 5.1 Unit tests (2026-11-06 15:28 PST)

`cd packages/eval && node --test --test-concurrency=1 test/*.test.ts`: 41 tests (loader 16, metrics 13, speed 5, cli 7), 41 pass, 0 fail. `tsc -p . --noEmit`: 0 errors. (40 at 15:28; the 41st, field rate rule and monotonic-of-error, added 15:35.)
- loader (16): unknown key at line 20 col 1 `/tolerence`; nested unknown key `/references/0/tolerence` line 18; tolerance without rel/abs/rule; type/enum/date paths; missing `rights`; id vs file name, class vs directory; untestable reason; future `accessed`; duplicate YAML key; spec forms; `expected_key` resolution; Richardson levels; validator compile-time keyword check; oneOf double match.
- metrics (13, incl. evaluateTarget): tolerance budgets incl. zero reference; field L2/max with dropped NaN (l2_rel = 1/sqrt(21)); rate fit of 3 h^2 = 2.000; observed order 2 (ratio 2) and 1.5 (ratios 1.67, 2.4, fixed point); Richardson f_ext = 1 to 1e-13, GCI = 1.25 ea / 3; eigen matching with floor, multiplicity group split 0.02/109.44, subsequence vs sorted with a spurious mode, offset with a missing mode; rules; evaluateTarget paths.
- speed (5): median, warm-up + median of 5 with a fake clock, stage medians, time-to-accuracy (interp 100 sqrt(10) ms), CEED throughput and r_max / n_0.8.
- cli (7): exit 0 (mock `@amp/physics`, Richardson pass, JSONL has the C8 fields, summary table), exit 2 (missed target), gated false = info, exit 1 (loader error beats a miss; also in dry run), pending-only exit 0, expected adapter (1e-7 vs 1e-2 retyping), real-process exit codes 1/1/1/2/0.

### 5.1b Unit tests (2026-11-06 15:44 PST)

51 tests (loader 17, metrics 16, speed 5, cli 9, fields 4), 51 pass. `tsc --noEmit` clean against the new base (`lib` ES2023 only; no DOM or WebWorker needed: the package uses only `performance`, `AbortSignal` and Node types).

### 5.2 Speed harness on `@amp/core` (2026-11-06 15:29:51 PST, first run)

Command: `nice -n 10 node --max-old-space-size=1536 packages/eval/src/cli.ts --bench all --sizes 8,16,32,64`. Records `logs/bench-poisson-20261106T152951.jsonl`, console `logs/eval-bench-20261106T152951.log`. Machine: Apple M4 Pro, 12 cores (7 other lanes active; numbers are under shared load). `@amp/core@0.0.1` modules used: `la/stencil`, `la/pcg`, `la/mg`, `fem/q1-grid` (ported APA code, L1 port in progress at this time).

Problem: unit cube, Q1 hex, manufactured u = sin(pi x) sin(pi y) sin(pi z). BP1-style = mass, BP3-style = stiffness with u = 0 on the boundary. Throughput = Jacobi-PCG, 50 fixed iterations, DOF (free nodes) x iterations / median solve time; 1 warm-up + median of 5. Time-to-accuracy = MG-PCG to rtol 1e-10, wall = assemble + constrain + MG setup + solve, median of 5, tolerance 1e-3 on max relative nodal error.

| bench (BP-style, non-conforming) | n | DOF (free nodes) | Jacobi-PCG solve ms (median) | MDOF/s (free) | MG-PCG it | pipeline ms (median) | max rel nodal err |
|---|---|---|---|---|---|---|---|
| BP1 | 8 | 729 | 0.73 | 49.9 | 1 | 7.65 | 3.929e-2 |
| BP1 | 16 | 4,913 | 4.54 | 54.1 | 1 | 33.35 | 9.682e-3 |
| BP1 | 32 | 35,937 | 32.84 | 54.7 | 7 | 86.80 | 2.412e-3 |
| BP1 | 64 | 274,625 | 247.88 | 55.4 | 7 | 646.75 | 6.026e-4 |
| BP3 | 8 | 343 | 0.94 | 18.2 | 1 | 1.25 | 2.600e-2 |
| BP3 | 16 | 3,375 | 4.41 | 38.3 | 1 | 19.23 | 6.444e-3 |
| BP3 | 32 | 29,791 | 32.42 | 46.0 | 5 | 78.82 | 1.608e-3 |
| BP3 | 64 | 250,047 | 251.93 | 49.6 | 6 | 662.31 | 4.017e-4 |

Derived: rate fit of the nodal error 2.009 (BP1) and 2.005 (BP3), r2 1.0000 (Q1 expectation 2). r_max 55.4 (BP1) / 49.6 (BP3) MDOF/s; n_0.8 = 729 (BP1) / 29,791 (BP3) DOF. T_tol(1e-3): first level meeting it is n = 64, 646.8 ms (BP1) / 662.3 ms (BP3) single solve, 774.6 / 761.6 ms cumulative over the sequence; log-log interpolated 310.6 / 163.3 ms (estimate between n = 32 and 64; no mesh exists at that point). Richardson of u(centre) (exact 1) over n = 8..64: f_ext 1.0000027 (BP1, p_obs 2.006, GCI 7.5e-4) and 1.0000012 (BP3, p_obs 2.004, GCI 5.0e-4). MG-PCG converges in 1 iteration for n <= 16 because the grid is below the MG coarse-solve size (coarseMax 6000, direct). Caveat: not a conforming CEED BP (Q1 only, assembled 27-point stencil, not matrix-free); "BP-style" only.

### 5.3 Speed harness re-run on the finished `@amp/core` (2026-11-06 15:37:02 PST)

After the coordinator's note that L1 is done (DevLog-002). Command as above with `--sizes 8,16,32,64,96`. Records `logs/bench-poisson-20261106T153702.jsonl`, console `logs/eval-bench-20261106T153702.log`. Same machine, shared load.

| bench (BP-style, non-conforming) | n | DOF (free nodes) | Jacobi-PCG solve ms | MDOF/s (free) | MG-PCG it | pipeline ms | max rel nodal err |
|---|---|---|---|---|---|---|---|
| BP1 | 8 | 729 | 0.69 | 52.5 | 1 | 8.26 | 3.929e-2 |
| BP1 | 16 | 4,913 | 4.40 | 55.8 | 1 | 30.88 | 9.682e-3 |
| BP1 | 32 | 35,937 | 31.18 | 57.6 | 7 | 78.55 | 2.412e-3 |
| BP1 | 64 | 274,625 | 239.05 | 57.4 | 7 | 637.53 | 6.026e-4 |
| BP1 | 96 | 912,673 | 807.67 | 56.5 | 6 | 2128.55 | 2.678e-4 |
| BP3 | 8 | 343 | 0.82 | 21.0 | 1 | 1.47 | 2.600e-2 |
| BP3 | 16 | 3,375 | 4.37 | 38.6 | 1 | 19.56 | 6.444e-3 |
| BP3 | 32 | 29,791 | 32.05 | 46.5 | 5 | 78.15 | 1.608e-3 |
| BP3 | 64 | 250,047 | 246.71 | 50.7 | 6 | 654.10 | 4.017e-4 |
| BP3 | 96 | 857,375 | 818.49 | 52.4 | 10 | 2837.98 | 1.785e-4 |

Derived: rate fit 2.007 (BP1) / 2.004 (BP3), r2 1.0000. r_max 57.6 / 52.4 MDOF/s; n_0.8 729 / 29,791 DOF. T_tol(1e-3): n = 64, 637.5 / 654.1 ms single, 755.2 / 753.3 ms cumulative, 296.8 / 161.7 ms log-log interpolated (estimate). Richardson of u(centre): f_ext 1.00000025 (BP1, p_obs 2.0017, GCI 3.3e-4), 1.00000011 (BP3, p_obs 2.0011, GCI 2.2e-4); exact 1. Numbers agree with the 15:29 run within 10 % per row (shared-machine noise).

### 5.4 Exact-field TS port vs `validation/a/fields.py` (gate 1e-12, 2026-11-06 15:44 PST)

Coordinator decision 2026-11-06 item 2. Port: `packages/eval/src/fields/` (special.ts: complex arithmetic, spherical Bessel j_n by Miller downward recurrence for complex z, y_n upward, Legendre, Carlson RF / RD for K and E; closed-forms.ts: the eight closed forms; index.ts: same case keys, defaults, field names, units and {re, im} output as the CLI). Gate script `packages/eval/bench/fields-crosscheck.ts`: one `uv run` per case and field, metric max pointwise |ts - py| / |py| over points with |py| >= 1e-10 max |py| (points at a zero of the field counted, judged normwise), plus normwise max |ts - py| / max |py|. Records `logs/fields-crosscheck-20261106T154410.jsonl`.

Result: 26/26 fields pass (8 cases at default parameters, plus WO-03 absorbing m = 1.5 + 1i, FL-01 Re 40, TR-01 Pe 100). Worst pointwise: EM-04 B_rho 2.44e-13, WO-03[m=1.5+1i] Ey 2.44e-13, WO-03 Ey 5.5e-14; most fields 1e-16 to 1e-14; Kovasznay, Poiseuille, EOF bit-identical.

Finding during the gate: the first port computed K and E by the AGM (E = K (1 - sum)); E was off by 3.7e-15 relative at m = 0.050, and the near-axis B_rho (cancellation in -K + c E, about 1e3 x) missed the gate at 5.8e-12. Switched to Carlson RF / RD (K - E = (m/3) RD(0, 1 - m, 1), DLMF 19.25.1): K, E match mpmath (30 digits) to <= 2 ulp for m <= 0.999; the audit (40 digits) found E at 1.07e-15 relative (about 5 ulp) at m = 0.999999, so the claim is <= 5 ulp for m <= 1 - 1e-6 (audit M7). At the worst point (rho 5 mm, z 30 mm) mpmath gives 2.36823546193752e-8 T; the Python CLI is 2.5e-13 off it, so the residual 2.4e-13 is the Python side's rounding.

Wiring: `--fields python` (default, `uv run` of the CLI) or `--fields ts` (port, browser-safe) for `extract.kind: field` targets.

## 6. Case validation per lane

### 2026-11-06 15:35 PST (29 cases in `eval/cases/a`, 0 in b, 0 in c)

Dry run `logs/eval-20261106T153321.jsonl` (+ `-summary.md`): 29 cases, 112 targets; 3 loader errors, 0 warnings; 26 pending (all `spec pending: amp-spec/0 models not yet published by lane L2`), 3 error (the loader errors). Exit 1.

L7a loader errors (all: `tolerance.rule` is prose, the harness cannot evaluate it):

| File:line | Path | Current | Suggested structured form |
|---|---|---|---|
| `eval/cases/a/SM-01.yaml:98` | `/references/4/tolerance/rule` | `rate >= p (stress) on 3 meshes` | `extract: {kind: field, field: sxx, evaluator: validation/a/fields.py, points: [...]}`, `tolerance: {rule: {type: rate, min: <p>}, norm: l2}` with `convergence.expected_order` |
| `eval/cases/a/RF-04.yaml:31` | `/references/0/tolerance/rule` | `trend: |R_in(radius) - value| decreases monotonically as radius -> 0 ...` | `extract: {kind: steps}` (parametric sweep over radii), `tolerance: {rule: {type: monotonic, direction: decreasing, of: error, note: "radii lambda/100, /300, /1000 at L = lambda/2"}}`; the X_in = 0 length condition as a second target |
| `eval/cases/a/FL-01.yaml:39` | `/references/0/tolerance/rule` | `L2 rate p+1, H1 rate p on 3 meshes` | two field targets (u L2 error, u H1 error) each `{rule: {type: rate, min: <p+1 or p>}}`; H1 seminorm needs gradient samples (not in fields.py yet) |

Self-check `--adapter expected` (`logs/eval-20261106T153407.jsonl`): inline YAML values vs generated values, case tolerance. 20 cases pass, 0 fail, 6 pending, 3 error (the 3 loader errors); targets 85 pass, 0 fail, 20 pending. Pending: no expected JSON for CP-02, SM-02, SM-05, SM-06, SM-22 (P-basis NAFEMS / benchmark values, no generator); CP-21 `sigma_yy_D` has no generated entry; the `*_nafems` P-basis targets of HT-01/02/03 have no generated value (by design).

L7b, L7c: no case files yet.

### 2026-11-06 15:45 PST (29 cases in a, 20 in b, 0 in c)

Dry run `logs/eval-20261106T154521.jsonl`: 49 cases, 216 targets, **0 loader errors, 0 warnings**; 49 pending (spec pending, L2 sims not published; `@amp/physics` present but without `index.ts` / `prepareRun` yet). Exit 0. L7a fixed the three prose rules (now structured); L7b files validate after S29.

Self-check `--adapter expected` (`logs/eval-20261106T154527.jsonl`): 20 cases pass, 0 fail, 29 pending, 0 error; targets 93 pass, 0 fail, 115 pending (class b: only CP-44 has an expected JSON; the other class-b targets are inline P / S values with no generator, so there is nothing to cross-check). Open note for L7b: `FL-02.yaml` `source.retabulation.sha256: FILL` is a placeholder (free-form block, not schema-checked).

### 2026-11-06 15:56 PST (29 in a, 20 in b, 36 in c = 85 cases)

Dry run `logs/eval-20261106T155629.jsonl`: 85 cases, 298 targets; **3 loader errors (all L7a SM-07), 0 warnings**; 84 pending, 1 error. Exit 1. L7b 20/20 and L7c 36/36 validate with 0 errors.

| Lane | Cases | Loader errors | Self-check (`--adapter expected`, `logs/eval-20261106T155642.jsonl`) |
|---|---|---|---|
| L7a | 29 | 3: `eval/cases/a/SM-07.yaml` references `metric_id 'rotation_M/Myp=1.0[literal]'`, `...1.1666[literal]`, `...1.3333[literal]`, but `eval/expected/SM-07.json` (regenerated 15:54:22; YAML from 15:35:41) now names them `rotation.m1.0.literal`, `rotation.m1.1666.literal`, `rotation.m1.3333.literal`. Fix: rebuild the case YAML (validation/a/build_cases.py) | 1 fail: SM-06 (NAFEMS FV12) `f_mode7`, `f_mode8`, `f_mode9`: generated 4.1902, 4.1902, 7.3560 Hz (expected JSON 15:54:22) vs inline TNSB 4.233, 4.233, 7.416 Hz; diff -0.0428 / -0.0428 / -0.0600 Hz vs budget 0.0212 / 0.0212 / 0.0371 (rel 5e-3). Modes 4-6 agree (diff <= 5.0e-4 Hz). The generator's method and the TNSB value disagree by 0.8-1.0 %: L7a to resolve (which model each number is, and the tolerance), not tune |
| L7b | 20 | 0 | 0 fail; 1 case with an expected JSON (CP-44) |
| L7c | 36 | 0 | 0 fail; 34 spec pending, 2 untestable (VM223: no convection coefficient / emissivity / ambient on the page; VM175: PZT-4 matrices are images) |
| all | 85 | 3 | 30 pass, 1 fail (SM-06), 53 pending, 1 error (SM-07); targets 130 pass, 3 fail, 156 pending |

Engine: `@amp/physics` has `src/common`, `src/em3d`, `src/modes` but no `src/index.ts` yet (L4 in progress at 15:56), so every case is pending on the engine path; the harness loads it automatically once `index.ts` exports `modules` + `prepareRun`.

### 2026-11-06 16:28 PST (85 cases, 295 targets; after the audit corrections)

Dry run `logs/eval-20261106T162834-2.jsonl`: 20 loader errors, 140 warnings; exit 1.

| Lane | Loader errors | Fix |
|---|---|---|
| L7a | `SM-06.yaml` 14 (7 targets x 2): scalar eigen targets without `extract.index` (B4) and `floor` + `offset: 3` together (double skip) | `extract: {kind: eigen, floor: 0.01, index: k}`, k = 0..6 for modes 4..10 (3 rigid modes dropped by the floor), no offset |
| L7c | `FL-07.yaml` 1: `reference_by_hash` without `dataset.hash` | add `dataset.hash` (sha256 / md5 of the AirfRANS archive) |
| L7c | `SC-02.yaml` 5: `expected.metric_id 'J_top_0.1V' .. '0.5V'` not in `eval/expected/SC-02.json` | regenerate the expected JSON or rename the ids |
| L7b / L7c (and L7a) | 140 warnings: 128+ targets without `metric_id` | add `metric_id` (slug); until then they stay pending on the engine path |

Engine run `logs/eval-20261106T162834.jsonl` (real `@amp/physics`, worker isolation): 0 workers started, because every case has `spec: {status: pending}`.

| class | cases pass | fail | pending | error | timeout | targets pending |
|---|---|---|---|---|---|---|
| a | 0 | 0 | 28 | 1 (SM-06) | 0 | 123 |
| b | 0 | 0 | 20 | 0 | 0 | 93 |
| c | 0 | 0 | 34 | 2 (FL-07, SC-02) | 0 | 79 |
| all | 0 | 0 | 82 | 3 | 0 | 295 |

Self-check `--adapter expected` `logs/eval-20261106T162835.jsonl`: 33 pass, 0 fail, 49 pending, 3 error (the loader errors); targets 134 pass, 0 fail, 145 pending, 16 info.

Cross-lane naming finding (engine smoke): `acoustics` emits `f_0 .. f_4`, AC-02 asks for `f_mode1 .. f_mode10`; `RESULT_NAMES` uses `f_<k>`, `neff_<k>`, `C_<i>_<j>`, while L7a ids are `f_mode1`, `neff_TE0`, `C_per_m` (the last matches). L4 and L7a need one naming rule (contracts v1); the harness reports the mismatch as pending, it does not map names.

## 7. Contract requests

To the coordinator (CONTRACTS-v0 owner):

0. **`@amp/spec` dependency** (resolved 16:0x: in `package.json`; types now import from `@amp/spec/types`): add `"@amp/spec": "workspace:*"` to `packages/eval/package.json` and re-install; then `src/contract-shim.ts` and `src/registry.ts` switch from the relative type import `../../spec/src/types/index.ts` to `@amp/spec/types` (runtime access already goes through the workspace resolver). Not edited by L8 to keep the root lockfile consistent.
1. **C1 runtime dependency**: `yaml` (^2.9.1, same as `@amp/spec`) for `@amp/eval` (case parsing with source positions for `file:line:col` errors). Installed into `packages/eval/node_modules` only (`--ignore-workspace`, no lockfile); a workspace `pnpm install` by the coordinator will replace it. Dev deps: `typescript` 5.9.3, `@types/node` ^22.
2. **C4 hook for the harness**: `@amp/physics` exports `modules: PhysicsModule[]` (or `registry`) and `prepareRun({case, spec, physicsId, level, hFactor, signal}) -> Promise<RunContext>` that builds geometry and mesh with the mesh size scaled by `hFactor`. Without it every case stays `pending` ("registered but no prepareRun hook"). The harness never meshes on its own.
3. **C5 units** (resolved 15:48 for degC through `@amp/spec` units): remaining gap `lbf` (SM-03 `F_cr_lbf`, gate false) and L7a's `length` passthrough for SM-21 (DevLog-006 s.5 item 7): unknown units make the target an `error`; L7a can restate SM-21 in SI.
4. **C5 sampling hook**: `@amp/post` exports `sample(solution, mesh, field, points, component?) -> Float64Array` for `extract.kind: probe | field`. Until then those targets are `pending`.
5. **C8 additions (additive)**: (a) the `spec` pending shape `{status: pending, reason, ref?}`; (b) the expected-file format `amp-eval-expected/0` as L7a writes it (`case, generator, command, generated_at, versions, targets[{metric_id, value, unit, ...}]`) recorded in C8; (c) JSONL lines carry `kind` (`meta | target | case | issues | speed | summary`); target lines keep the C8 minimum `{case, target, value, ref, tol, pass, time_ms, dof, run}` plus diagnostics (`status, reason, diff, err_abs, err_rel, limit, u_num, richardson, rate, eigen, field, levels`).

## 8. Hand-off (2026-11-06 15:58 PST; refreshed 16:28)

Done:
- `eval/schema/amp-eval-0.schema.json` (authoritative per CONTRACTS-v0 changelog 15:45), changelog S1-S32 in section 3.
- `packages/eval` (3,647 lines TS incl. tests): loader + dependency-free validator (`file:line:col /pointer [severity keyword] message`), metrics, speed, evaluate, runner, registry/engine source, adapters (expected self-check, python `uv run`, exact-field bridge), TS exact-field port `src/fields/`, report (JSONL per C8 + markdown summary), CLI, `bench/poisson.ts` (BP1/BP3-style), `bench/fields-crosscheck.ts` (gate), `eval/README.md`.
- Gates (refreshed 16:28 after the audit pass): unit tests 66/66 (loader 17, metrics 21, speed 5, cli 10, engine 9, fields 4); dry run over 85 cases: 20 loader errors listed per lane (section 6, 16:28); speed harness on `@amp/core` (section 9.3: BP3-style r_max 52.25 MDOF/s on all nodes, 45.63 on free unknowns; Q1 rate 2.004); TS field port 26/26 within 1e-12 (worst 2.44e-13).

Open:
- Engine path: wired to L4's hooks and `@amp/post` `sample` (worker per case); no repo case is runnable yet because every `spec` is pending (L2 sims ids not in the cases) and metric names differ between L4 and L7a (section 6, 16:28).
- Next wave (audit S7): browser runner (Worker Source, TS fields port, `crossOriginIsolated` and timer clamping in meta, M10 minimum sample duration), report page, dataset adapter (The Well / PDEBench, VRMSE / nRMSE vs our own convergence floor), multiphysics orchestration (cases with more than one physics entry stay pending).
- L7a: SM-06 extract (index, no double skip); L7c: FL-07 hash, SC-02 expected ids; all lanes: metric_id on every target.
- Not built (DevLog-001 lane table mentions them; not in this task): browser runner page and report page. `src/index.ts` exports only Worker-safe modules, so a browser runner can reuse loader / metrics / evaluate / runner / report / fields with its own Source.
- `packages/eval/node_modules/.pnpm` holds the residue of the 15:20 isolated install (unused since the root install symlinks into the root store; gitignored); safe to delete with a clean workspace install.

How to resume: read sections 3, 6, 7; run `node packages/eval/src/cli.ts --dry-run` (exit 0 when no loader errors), `cd packages/eval && node --test --test-concurrency=1 test/*.test.ts`, `node packages/eval/bench/fields-crosscheck.ts`, `nice -n 10 node --max-old-space-size=1536 packages/eval/src/cli.ts --bench all`.

## 9. Audit corrections (audit `DevLog/audits/2026-11-06-L8-eval-harness-audit.md`, applied 2026-11-06 16:15-16:28 PST)

### 9.1 Dispositions

| # | Finding | Disposition | Where / evidence |
|---|---|---|---|
| B1 | No timeout or isolation | Fixed. Each engine case runs in a `worker_threads` Worker with `resourceLimits.maxOldGenerationSizeMb` (`--max-mem`, default 1536) and a wall-clock limit (`--timeout`, else from `budget_s`, capped by `--timeout-cap`, default 600 s); `AbortSignal.timeout` passed to `prepareRun`. Hang / busy loop -> status `timeout`, never-settling promise -> `error` ("worker exited without a result"), heap overrun -> `error` ("out of memory"); all exit 1 with a log line. `process.exitCode = 1` until `main()` completes | `src/registry.ts` `runWorker`, `caseTimeoutMs`; `src/engine-worker.ts`; `test/engine.test.ts` (4 tests: unsettled promise 0.1 s, busy loop and timer hang timed out at 1.5 s, heap cap 64 MB) |
| B2 | Broken engine import exits 0 | Fixed. A present but failing `@amp/physics` or `@amp/post` (or no `sample` export) sets `loadError`: every case is `error` in run and dry run, exit 1. An absent package directory stays pending. `--strict` makes a gated pending target exit 1 | `loadDefaultRegistry`, `workspace.ts` `absent`; `exitCode(…, {strict})`; test B2, B3 |
| B3 | Lookup by `quantity` | Fixed. Lookup by `metric_id` only (or `extract.name`); schema pattern = slug grammar; a target without one is a loader warning and pending on the engine path; a metric not in L4's `RESULT_NAMES` (with `<x>` wildcards) or not produced is pending with the reason | `extractFromSolution`, `EngineSource.observe`; schema `metric_id.pattern`; test B3 |
| B4 | SM-06 eigen extraction, double skip | Fixed in the harness: `extract.index` (position after floor / offset) for scalar eigen targets (`selectEigen`); loader errors for a scalar eigen target without `index` and for `floor` + `offset` together. SM-06 itself needs L7a's edit (section 6, 16:28) | `metrics.ts` `selectEigen`; `loader.ts`; known-answer test "B4" (FV12-like list with 3 rigid modes) |
| B5 | Hook signatures | Adapted to L4: `prepareRun` called as `(args)` or `(spec, caseCtx)` by arity (L4 accepts both); `physicsRegistry()` used as the spec registry; `RESULT_NAMES` used for B3; `@amp/post` `sample(solution, field, points, {mesh, component})` as implemented (the changelog text says `sample(solution, mesh, field, points, component?)`; L4's code takes the mesh in the options object, and the harness follows the code). The level's `ctx.mesh` is passed to `sample` inside the worker | `callPrepare`, `extractFromSolution`; tests B5 (two-parameter prepareRun, field target through a mock `sample` that requires the mesh) |
| S1 | NaN dropped silently | Fixed. Any non-finite value on any level fails with the level named; field targets fail on non-finite samples unless `extract.max_dropped`; non-finite computed eigenvalues fail the match | `evaluate.ts`; test "non-finite values" |
| S2 | Eigen arrays skip Richardson | Fixed. Every level is matched, then each mode is extrapolated; a degenerate cluster is extrapolated through its mean and members keep the finest split | `evaluateEigenArray`; test "S2" (irregular split 1e-3 / 1e-4 / 6e-4: mean exact to 1e-12) |
| S3 | Richardson passes outside the asymptotic range | Fixed. Pass needs f_ext and the finest level within the budget and `|p_obs / expected - 1| <= order_band` (default 0.25, `order_check: false` to report only) | `richardsonGate`; schema `convergence.order_band / order_check`; test "Richardson gate" |
| S4 | Run record unchecked | Fixed. Every level's record: `engine, specHash, meshHash` non-empty, `startedAt` ISO 8601 with offset, `platform.runtime`, `fidelity`, and `run.meshHash == Solution.meshHash`; else the case is an error. Per-level `{level, dof, meshHash, wall_ms}` kept in `levelRuns` and target `levels` | `checkRunRecord`; test S4 |
| S5 | Cold time-to-accuracy | Fixed. `--speed` times every level (1 warm-up + median of 5) inside the worker; `protocol: warmup1_median5_per_level` | `engine-worker.ts`, `runner.ts` |
| S6 | Missing native budget blocks | Fixed by marking pending: `meets_budget` is judged on T_tol (cumulative over levels for Richardson targets) against `budget_s.native` only; without one it is `null` with `budget_note`. No browser-to-native scaling factor is used, because none has been measured (it would be an invented number) | `runner.ts`; test "--speed" |
| S7 | Browser runner, report page, dataset adapter, multiphysics | Open, next wave (section 8) | |
| Output | Unique log names; BP label; BP3 DOF | Fixed. `writeUnique` (flag `wx`, `-2`, `-3` suffix) for eval, bench and crosscheck logs; bench records carry `bench: bp1-style / bp3-style`, `conforming_ceed: false`, `dof_all` and `dof_free`, with throughput on both | `node-io.ts`; `bench/poisson.ts`; test M1 |
| M1 | Overwrite on same-second runs | Fixed (above) | |
| M2 | Misleading NaN reason | Fixed: `non-finite value at level k of n` | |
| M3 | Rule plus rel / abs ignored on scalars | Fixed: both apply | test "M3" |
| M4 | `info` not printed | Fixed: CLI line prints info and timeout counts | |
| M5 | Bench DOF counting, timed allocation, label | Fixed: both DOF counts; the initial guess is reset outside the timer (`timeRuns` `setup`); pcg's 4 work vectors are still allocated inside it (core API, stated in the header) | |
| M6 | NaN strings in JSONL | Documented (README) | |
| M7 | Stale DevLog, shim path, ulp claim | Fixed: numbers refreshed (sections 6, 8, 9.3), log order, shim imports `@amp/spec/types`, ulp claim restated (5.4) | |
| M8 | "expected number, got number" | Fixed: "got non-finite number NaN" | `schema-validate.ts` |
| M9 | `time_ms` undocumented | Documented (README): sum of all accuracy levels | |
| M10 | Minimum sample duration | Open (browser runner) | |
| M11 | Subsequence with fewer computed modes | Fixed: alignment with skips on both sides, partial assignment kept | test "M11" |
| L4 request | HT-01 non-nested levels marked fail ("oscillatory") | Fixed: an oscillatory / non-converging sequence is never extrapolated with an assumed order; Richardson is reported unavailable and the target is gated on the finest value within the budget plus non-increasing |error| (`richardson_fallback: finest+monotone`); applies to scalars, element-wise arrays and eigen clusters | `fallbackGate`; tests in "Richardson gate" |
| Coordinator | Rights tags | Fixed: `$defs/rightsItem` is an enum of the 14 tags in use with descriptions (schema description, README table); `reference_by_hash` in `allowed` without `dataset.hash` (`sha256:<64 hex>` or `md5:<32 hex>`) is a loader error. The relayed list said `cite_value`; the cases (85) and the earlier vocabulary use `cite_values`, which is kept | schema, `loader.ts`, README |

### 9.2 Not changed

- The changelog's `sample(solution, mesh, field, points, component?)` text versus L4's code `sample(solution, field, points, {mesh, component})`: the harness follows the code (coordinator: L4's implementation is canonical); the contracts-v1 text should be aligned.
- Metric naming across L4 / L7a (`f_<k>` vs `f_mode<k>`): reported, not mapped.

### 9.3 Re-runs after the corrections (2026-11-06 16:28-16:30 PST)

| Command | Result | Records |
|---|---|---|
| `node --test test/*.test.ts` (packages/eval) | 66 tests, 66 pass (loader 17, metrics 21, speed 5, cli 10, engine 9, fields 4), 5.8 s | |
| `tsc -p . --noEmit` | 0 errors | |
| `cli.ts` (engine) | 85 cases: 0 pass, 0 fail, 82 pending, 3 error, 0 timeout; exit 1 (loader errors) | `logs/eval-20261106T162834.jsonl` |
| `cli.ts --dry-run` | same counts; exit 1 | `logs/eval-20261106T162834-2.jsonl` (same-second run, suffix) |
| `cli.ts --adapter expected` | 33 pass, 0 fail, 49 pending, 3 error; targets 134 pass, 0 fail, 145 pending, 16 info | `logs/eval-20261106T162835.jsonl` |
| `bench/fields-crosscheck.ts` | 26/26 fields within 1e-12 | `logs/fields-crosscheck-20261106T162841.jsonl` |
| `cli.ts --bench all --sizes 8,16,32,64,96` | BP1-style r_max 50.87 MDOF/s (all = free, no Dirichlet), BP3-style 52.25 all nodes (n_0.8 4,913) / 45.63 free (n_0.8 29,791); rates 2.007 / 2.004; T_tol(1e-3) 711.5 / 756.4 ms single (shared machine, 7 lanes) | `logs/bench-poisson-20261106T162848.jsonl` |
| scratch engine smoke (AC-02 -> `sims/box-acoustics.yaml`) | worker ran 3 levels on the real `@amp/physics`; targets pending on metric names | scratchpad only |

## 10. Follow-up 3 (I1 hero integration, DevLog-014; 2026-11-06 16:35-16:58 PST)

| # | Request | Done | Where / tests |
|---|---|---|---|
| 1 | Derived extracts | `extract.kind: reduce` (`op` max / min / mean / absmax / absmin of a field over `points`, via `@amp/post` `sample`) and `kind: expr` (`expr` over named `terms`: scalar by name, probe, reduce, nested expr, constant `{value, unit}`), evaluated with `@amp/core/expr` `compileExpression` (dimension-checked: `a + L` with Pa and m is an error), result dimension compared with the target unit and converted to it (`@amp/spec` units). The worker loads `@amp/core/expr` when a target uses `expr` | `registry.ts` `termSI`; schema `extract.op / expr / terms`, `$defs/constTerm`; loader checks; `test/derived.test.ts` item 1 (K_t = max(stt) / s_inf = 3 with s_inf as a scalar in MPa and as a constant in Pa; MPa output 300; dimension error; incompatible-units error; missing field pending) |
| 2 | Tensor / vector field extracts | `extract.fields: [sxx, syy, sxy]` (several fields) or `field: u, components: [0, 1]`; engine samples and evaluator fields (`evaluator_fields`, default = `fields`) are concatenated component-major; `samples_key` values may be one array per component; L2 / max norms over all components; length mismatch is an error | `extractFromSolution`, `runner.ts`; tests item 2 (concatenation order; runner calls the evaluator once per component, pass at equal values, fail at a 0.5 % change in one component) |
| 3 | More than one spec per case | `references[].spec` (same forms as the case `spec`) overrides the case default; targets are grouped by effective spec, each group runs in its own worker with its own mesh levels; a group's pending / error / timeout applies to its targets only; `levelRuns` carry the group label; `--speed` times the first group (stated in `budget_note`) | `EngineSource.groups / observeGroup`; schema `reference.spec`; test item 3 (two embedded specs, 6 levels, both targets pass) |
| 4 | Shared Richardson rule | `richardsonRule(f, h, {expectedOrder, band, fs, allowAssumed})` and `RICHARDSON_ORDER_BAND = 0.25`, exported from `@amp/eval/metrics` (and the package index). Available only when `|p_obs / p_theory - 1| <= band`; otherwise (and for oscillatory, flat or fewer than 3 levels) `available: false` with the reason, and the caller gates on the finest level. `evaluate.ts` now uses it for scalars, element-wise arrays and eigen clusters: unavailable -> finest within the budget + non-increasing |error| (`richardson_fallback`). This replaces the S3 behaviour "order outside the band = fail" (section 9) with "unavailable, gated on the finest level", per the coordinator's rule for L4. Band documented in `eval/README.md` | `metrics.ts`; test "richardsonRule (shared with L4)" (ratio 1.3 rejected, 1.2 accepted, oscillatory and 2-level unavailable, `allowAssumed` 2-level fs 3) |

Re-runs (16:56-16:58 PST):
- `node --test` 71/71 (loader 17, metrics 22, speed 5, cli 10, engine 9, fields 4, derived 4); `tsc --noEmit` clean.
- Engine run `logs/eval-20261106T165637.jsonl` (real `@amp/physics`; cases now reference L2 sims): **first real engine results**. Per class: a 7 pass / 2 fail / 19 pending / 1 error (SM-06 loader); b 0 / 0 / 20 / 0; c 0 / 0 / 36 / 0. Targets 30 pass, 5 fail, 282 pending, 3 info. Passing cases: AC-02, EM-01, EM-04, HT-01, HT-02, HT-03, HT-04 (HT-01 now passes through the fallback, L4's DevLog-010 s.5 item 3). Misses (for L4):
  - RF-21 `f_TE111`, `f_TM110`, `f_TE211`, `f_TE011`: all 3 levels give the same value (`no_change`: the 3D cavity mesh does not change with `hFactor`), finest 6e-5 to 1.2e-4 relative off vs a 1e-5 budget.
  - SM-02 `sigma_yy_D` (NAFEMS LE1): finest 9.26564e7 vs 9.27e7 Pa, within the 1 % budget, but the sequence oscillates and |error| is not monotone (non-nested levels): fail by the fallback rule.
- Dry run `logs/eval-20261106T165705.jsonl`: 85 cases, 320 targets, 14 loader errors (all SM-06, section 6), 92 warnings (targets without `metric_id`); exit 1.
- `--adapter expected` `logs/eval-20261106T165719.jsonl`: 35 pass, 0 fail, 49 pending, 1 error (SM-06); targets 139 pass, 0 fail, 158 pending, 23 info.
- Field gate `logs/fields-crosscheck-20261106T165706.jsonl`: 26/26 within 1e-12.

Bug fix (I1, 2026-11-06 17:01 PST): the `RESULT_NAMES` pre-check in `EngineSource.observe` read only `extract.field ?? extract.name`, so a tensor target with `extract.fields` was pending with "does not produce field ''". It now checks every name in `fields` (and `reduce` fields) and lists the missing ones. Test "RESULT_NAMES pre-check reads every name in extract.fields" (all declared: pass; `szz` undeclared: pending naming 'szz'). Also fixed on the way: a field target with a dimensionless `unit` (a relative metric) no longer converts its Pa samples to '1' (was "unit mismatch: 'Pa' and '1'"); samples stay in SI on both sides, and a dimensional unit still converts (README). Tests 72/72, tsc clean.

Class-a rerun `logs/eval-20261106T170120.jsonl`: 8 pass, 3 fail, 18 pending, 0 error; targets 31 pass, 7 fail, 95 pending, 3 info. SM-01 now runs all 5 targets: `field_rel_L2_stress` measures relative L2 5.86e-4 with stress rate 1.67 (rule min 1: pass), but the harness applied `abs: 0.001` to the absolute RMS (38,828 Pa) and failed it. Coordinator 17:02: the case is right, the harness was wrong (corrected below; no case change). `K_t` fails the fallback rule (oscillatory, |error| not monotone; finest within the budget): non-nested levels (L3 `refineUniform` pending).

Correction (coordinator, 2026-11-06 17:03 PST): field target norms. Schema `tolerance.norm` gains `rel_l2` (||e||_2 / ||ref||_2) and `rel_max` (max|e| / max|ref|); the budget is `abs`, else `rel`, on that dimensionless number. A field target with `unit: '1'` and `norm: l2` / `max` (or none) is evaluated as the relative norm (`metrics.checkField(…, {relative})`), and the loader warns (`field-relative`) to write `rel_l2` / `rel_max`. A dimensional unit keeps the earlier meaning (rel -> relative norm, abs -> RMS / max |e| in the unit). Documented in `eval/README.md`. Tests: "SM-01 numbers" (126 samples at ~1e8 Pa, relative L2 5.86e-4: passes at abs 1e-3 as `l2_rel`, fails at 5e-4, `rel_l2` with unit Pa passes, `l2` with unit Pa is `rms_abs` and fails) and the loader warning test. 74/74, tsc clean.

Class-a rerun `logs/eval-20261106T170313.jsonl`: 8 pass, 3 fail, 18 pending, 0 error; targets 32 pass, 6 fail, 95 pending, 3 info; 1 loader warning (SM-01 field-relative). SM-01 `field_rel_L2_stress` passes (relative L2 5.86e-4 <= 1e-3; stress rate 1.67 >= 1). SM-01 still fails on `K_t` (oscillatory non-nested levels, |error| not monotone; L3 `refineUniform` pending).

## Follow-up 4 (I1, DevLog-014; 2026-11-06 17:10-17:26 PST)

| # | Request | Done | Tests |
|---|---|---|---|
| 1 | Fallback too strict (SM-02 92.6576 vs 92.7, -4.6e-4 at a 1e-2 budget; HT-04 constant time-step error ~3e-6 degC at a 0.099 degC budget, both failing only on a non-monotone error) | When the shared rule declares Richardson unavailable, a target passes if the finest level is within the budget AND (|error| non-increasing OR every level within the budget). A non-monotone error is a note in the reason. README updated | "Richardson gate" test: non-monotone, all levels within -> pass with the note; a level outside -> fail; SM-02 numbers (92.31, 92.71, 92.6576 vs 92.7, rel 1e-2) -> pass |
| 2 | Per-target `expected_order` | `references[].expected_order` overrides `convergence.expected_order` for the shared rule (schema + runner) | engine test: case order 1 vs observed 2 -> unavailable (outside the band) -> fallback; target `expected_order: 2` -> Richardson accepted, order_ratio 1 |
| 3 | Transient: dt scaled with h | `convergence.dt_with_h: true` + `time_order` (+ `space_order`, default `expected_order`): `dtFactor = hFactor^(space_order / time_order)` per level, passed to `prepareRun` next to `hFactor` (one-object and `(spec, caseCtx)` forms) and recorded per level; loader error when `time_order` or the space order is missing. L4's `prepareRun` must apply `dtFactor` to the study's time step (not yet in L4's code at this time) | `dtFactorsFor` unit test ([1, 0.25, 0.0625] for p_s 2 / p_t 1); engine test: the mock reports the finest-level dtFactor 0.0625 |

Tests 76/76, tsc clean. Class-a rerun `logs/eval-20261106T172532.jsonl`: 11 pass, 0 fail, 18 pending, 0 error; targets 38 pass, 0 fail, 95 pending, 3 info; 1 loader warning (SM-01 field-relative). Passing cases: AC-02, EM-01, EM-04, HT-01, HT-02, HT-03, HT-04, RF-21, SM-01, SM-02, WO-01 (RF-21 and SM-01 passed for the first time in this run; RF-21 had failed at 16:56 with identical levels).

## Follow-up 5 (M2 integration audit `DevLog/audits/2026-11-06-M2-integration-audit.md` + L7a, 2026-11-06 17:30-17:47 PST)

| # | Finding | Done | Tests |
|---|---|---|---|
| S1 | h from DOF with the case `dimension` label ("1D" cases solved on 2D strips): WO-01 orders 1.92 / 2.04, HT-04 off, AC-02 r 1.939 | Engine levels carry `h = hFactor` (exact ratio for nested levels); a DOF-derived h uses the solved spec's `geometry.dim`, never the case label | engine test "M2 audit S1" (DOF = 1/h^2, case label 1D: r = 2, order ratio 1, no fallback; before the fix r = 4, p = 1) |
| S2 | Cold and warm timings mixed; warm reuses cached meshes | Every timing is labelled. Cold = first `prepareRun` + `run` per level in a fresh worker, split into `prepare_ms` (geometry, meshing, refinement) and `run_ms`; target `time_ms` = cold sum with `time_protocol`. Warm (`--speed`) = 1 warm-up + median of 5 in the same worker, `timing: warm` with a mesh-cache note. `t_tol_cold_ms` is the budget check (`meets_budget`, "judged on cold end-to-end time"); `t_tol_warm_ms` informative; `case_wall_cold_ms` = worker spawn to result. The summary has separate cold and warm columns and never adds them. The "edit loop" protocol (change one parameter before each timed run) is not built: open | "--speed" CLI test (cold levels satisfy prepare + run = wall; warm and cold T_tol both present) |
| S5 | Relaxed fallback accepts a stagnating sequence | When Richardson is unavailable: pass iff the finest level is within the budget AND the level-to-level changes shrink, |f_k - f_(k-1)| < |f_(k-1) - f_(k-2)| (two exact zeros count as shrinking; fewer than 3 levels do not pass); a non-monotone |error| is a note. Replaces the Follow-up 4 rule | "Richardson gate" test: growing changes fail; shrinking changes with non-monotone error pass with the note; stagnating changes inside a loose budget fail; SM-02 (8.6 kPa then 0.2 kPa) and HT-04 x = 0.0859 (4.6e-6 then 5.2e-7 degC) audit numbers pass |
| L7a | Informative targets run on every level; no per-target level setting (RF-21 Q_d: 12.95 of 15.76 s) | `references[].levels` (0-based, default all; loader checks the range and warns on a Richardson target with < 3 levels); a spec group runs the union of its targets' levels. A group whose targets are all `gate: false` is informative: never warm-timed, its cold time reported as `informative_wall_cold_ms`, apart from `gate_wall_cold_ms` | engine test: informative target with `levels: [0]` on its own spec runs 1 level, flagged informative, both walls reported, warm repeats only for the gated group |

Tests 78/78 (cli 10, derived 5, engine 12, fields 4, loader 18, metrics 24, speed 5), tsc clean.

Class-a rerun `logs/eval-20261106T174605.jsonl`: 11 pass, 0 fail, 18 pending, 0 error; targets 37 pass, 0 fail, 95 pending, 4 info. With S1 fixed: WO-01 p_obs 3.98 (TE0) / 3.95 (TM0) at r = 2, Richardson now available (audit: 3.98 / 3.95); HT-04 x = 0.0223 p_obs 3.24 (r 2). SM-02 and HT-04 pass under the S5 rule. Cold walls: RF-21 gate 2.25 s, informative (Q_d) 12.88 s, reported apart (RF-21 Q_d has no `levels: [0]` yet: L7a's case edit); AC-02 gate 5.76 s cold; SM-01 1.46 s.
