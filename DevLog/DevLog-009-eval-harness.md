# DevLog-009: Eval harness (`@amp/eval`, lane L8)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L8 (evaluation harness) |
| Owns | `packages/eval/**`, `eval/schema/**`, `eval/README.md`, this file |
| Reads | DevLog-001 (A5, A12, targets, M1), CONTRACTS-v0 (C1, C4, C5, C8), R3 s.2 and s.5, `eval/cases/**`, `eval/expected/**`, sibling `validation/` dirs (read-only) |
| Status | Hand-off 2026-11-06 15:58 PST (engine run waits for `@amp/physics` index + `prepareRun`) |

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
- 2026-11-06 15:56 PST: L7c's 36 cases arrived; full validation over 85 cases (section 6): 3 loader errors (SM-07 stale metric ids), self-check 1 fail (SM-06 FV12 modes 7-9).
- 2026-11-06 15:48 PST: `@amp/spec` (L2 done) wired: C4/C5 types from `packages/spec/src/types` (relative type import until `@amp/eval` lists `@amp/spec`), spec loading through `parseSpecText` (sims/ files) / `validateSpec` (embedded) with the `@amp/physics` spec registry when exported, else `@amp/spec/provisional` `wave1Registry()`; unit conversion through the spec units API (affine degC; smoke 373.15 K -> 100 degC; `lbf` unknown to core units: SM-03 `F_cr_lbf` is gate false); meta platform from `probePlatform()`. Smoke: all 6 `sims/*.yaml` parse ok with the wave-1 registry. Test fixtures carry a mock `@amp/spec`. Tests 52/52.

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

| bench | n | DOF | Jacobi-PCG solve ms (median) | MDOF/s | MG-PCG it | pipeline ms (median) | max rel nodal err |
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

| bench | n | DOF | Jacobi-PCG solve ms | MDOF/s | MG-PCG it | pipeline ms | max rel nodal err |
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

Finding during the gate: the first port computed K and E by the AGM (E = K (1 - sum)); E was off by 3.7e-15 relative at m = 0.050, and the near-axis B_rho (cancellation in -K + c E, about 1e3 x) missed the gate at 5.8e-12. Switched to Carlson RF / RD (K - E = (m/3) RD(0, 1 - m, 1), DLMF 19.25.1): K, E match mpmath (30 digits) to 1 ulp. At the worst point (rho 5 mm, z 30 mm) mpmath gives 2.36823546193752e-8 T; the Python CLI is 2.5e-13 off it, so the residual 2.4e-13 is the Python side's rounding.

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

## 7. Contract requests

To the coordinator (CONTRACTS-v0 owner):

0. **`@amp/spec` dependency**: add `"@amp/spec": "workspace:*"` to `packages/eval/package.json` and re-install; then `src/contract-shim.ts` and `src/registry.ts` switch from the relative type import `../../spec/src/types/index.ts` to `@amp/spec/types` (runtime access already goes through the workspace resolver). Not edited by L8 to keep the root lockfile consistent.
1. **C1 runtime dependency**: `yaml` (^2.9.1, same as `@amp/spec`) for `@amp/eval` (case parsing with source positions for `file:line:col` errors). Installed into `packages/eval/node_modules` only (`--ignore-workspace`, no lockfile); a workspace `pnpm install` by the coordinator will replace it. Dev deps: `typescript` 5.9.3, `@types/node` ^22.
2. **C4 hook for the harness**: `@amp/physics` exports `modules: PhysicsModule[]` (or `registry`) and `prepareRun({case, spec, physicsId, level, hFactor, signal}) -> Promise<RunContext>` that builds geometry and mesh with the mesh size scaled by `hFactor`. Without it every case stays `pending` ("registered but no prepareRun hook"). The harness never meshes on its own.
3. **C5 units** (resolved 15:48 for degC through `@amp/spec` units): remaining gap `lbf` (SM-03 `F_cr_lbf`, gate false) and L7a's `length` passthrough for SM-21 (DevLog-006 s.5 item 7): unknown units make the target an `error`; L7a can restate SM-21 in SI.
4. **C5 sampling hook**: `@amp/post` exports `sample(solution, mesh, field, points, component?) -> Float64Array` for `extract.kind: probe | field`. Until then those targets are `pending`.
5. **C8 additions (additive)**: (a) the `spec` pending shape `{status: pending, reason, ref?}`; (b) the expected-file format `amp-eval-expected/0` as L7a writes it (`case, generator, command, generated_at, versions, targets[{metric_id, value, unit, ...}]`) recorded in C8; (c) JSONL lines carry `kind` (`meta | target | case | issues | speed | summary`); target lines keep the C8 minimum `{case, target, value, ref, tol, pass, time_ms, dof, run}` plus diagnostics (`status, reason, diff, err_abs, err_rel, limit, u_num, richardson, rate, eigen, field, levels`).

## 8. Hand-off (2026-11-06 15:58 PST)

Done:
- `eval/schema/amp-eval-0.schema.json` (authoritative per CONTRACTS-v0 changelog 15:45), changelog S1-S32 in section 3.
- `packages/eval` (3,647 lines TS incl. tests): loader + dependency-free validator (`file:line:col /pointer [severity keyword] message`), metrics, speed, evaluate, runner, registry/engine source, adapters (expected self-check, python `uv run`, exact-field bridge), TS exact-field port `src/fields/`, report (JSONL per C8 + markdown summary), CLI, `bench/poisson.ts` (BP1/BP3-style), `bench/fields-crosscheck.ts` (gate), `eval/README.md`.
- Gates: unit tests 52/52 (loader 17, metrics 16, speed 5, cli 10, fields 4); dry run over all 85 cases: 3 loader errors, listed (L7a SM-07); speed harness on `@amp/core` measured (sections 5.2, 5.3: BP3-style r_max 52.4 MDOF/s, Q1 rate 2.004, T_tol(1e-3) 654 ms at n = 64); TS field port 26/26 fields within 1e-12 of the Python CLI (worst 2.44e-13).

Open:
- Engine path: no case has run on the engine yet; needs `packages/physics/src/index.ts` exporting `modules` (or a module map) and `prepareRun(args)` (contract request 2), and L2 sims ids in the cases (`spec` is pending in 82 of 85 cases). Then: `node packages/eval/src/cli.ts --speed` for time-to-accuracy per case.
- `probe` / `field` extraction needs `@amp/post` `sample(...)` (contract request 4); `extract` blocks are not yet written in the cases (field names in C5 not fixed).
- L7a: SM-07 stale metric ids; SM-06 FV12 modes 7-9 generator vs TNSB 0.8-1.0 %.
- Not built (DevLog-001 lane table mentions them; not in this task): browser runner page and report page. `src/index.ts` exports only Worker-safe modules, so a browser runner can reuse loader / metrics / evaluate / runner / report / fields with its own Source.
- `packages/eval/node_modules/.pnpm` holds the residue of the 15:20 isolated install (unused since the root install symlinks into the root store; gitignored); safe to delete with a clean workspace install.

How to resume: read sections 3, 6, 7; run `node packages/eval/src/cli.ts --dry-run` (exit 0 when no loader errors), `cd packages/eval && node --test --test-concurrency=1 test/*.test.ts`, `node packages/eval/bench/fields-crosscheck.ts`, `nice -n 10 node --max-old-space-size=1536 packages/eval/src/cli.ts --bench all`.
