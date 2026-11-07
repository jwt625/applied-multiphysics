# Audit: L8 eval harness (2026-11-06)

| Field | Value |
|---|---|
| Date | 2026-11-06 (runs 16:04-16:11 PST) |
| Auditor | fresh-context audit subagent (no prior conversation) |
| Target | `packages/eval/**`, `eval/schema/amp-eval-0.schema.json`, `eval/README.md`, `DevLog/DevLog-009-eval-harness.md` |
| Context read | `CLAUDE.md`, CONTRACTS-v0 (C4, C5, C8 + changelog), DevLog-001 (A5, A12, M1), R3 s.2 and s.5, DevLog-010 (planned `prepareRun` / `sample`), `packages/core/src/la/pcg.mjs` (work per iteration) |
| Files changed | this file only. The requested CLI runs wrote `logs/eval-20261106T160450.*` (dry run), `logs/eval-20261106T160455.*` (`--adapter expected`), `logs/eval-20261106T160501.*` (`--class a --json`). The bench rerun and robustness runs wrote only to scratch. |
| Scratch | `<scratch>/l8audit/`: `kat.ts` + `kat.json` (metric known answers), `degen.ts`, `fieldsx.ts` + `fieldsx.json` (TS vs Python fields), `carl.ts` / `carl.py` (Carlson vs mpmath), `robust.ts` + `robust.json` + `roots/` (robustness), `schemachk.ts`, `survey.py` / `survey2.py` (case survey), `bench.out` + `bench-poisson-20261106T160624.jsonl` (bench rerun) |

## Verdict

The numerical core is correct. Tolerance forms, the rate fit, Celik observed order, Richardson, GCI, eigen matching and field norms all give the known answers. The TS exact-field port agrees with `validation/a/fields.py` to 2.2e-13 at random points. The Carlson integrals match mpmath to 1.1e-15. The bench numbers reproduce (BP3-style r_max 52.12 vs the 52.4 MDOF/s claimed, -0.5 %). Tests 52/52 pass, tsc is clean, and exit codes 0/1/2 behave as documented.

The harness is not yet safe to gate real engine runs. Five problems block that:
- There is no timeout or isolation. A module whose promise never settles makes the CLI exit 0 with no output and no logs.
- "Pending allowed" means a broken `@amp/physics` import exits 0.
- Scalar lookup uses `quantity`, which fails for 131 of 313 targets.
- SM-06's encoding (scalar reference with eigen extraction) always errors.
- The `prepareRun` / `sample` signatures disagree between the contract, the harness and DevLog-010.

Seven significant problems follow, about false passes and about the speed and run-record protocol.

## 1. Rerun of tests, typecheck and CLI

| Command | Result | DevLog-009 (time) | Agreement |
|---|---|---|---|
| `pnpm test` (packages/eval) | 52 tests, 52 pass, exit 0 (cli 10, fields 4, loader 17, metrics 16, speed 5) | 52/52, same split (15:58 hand-off) | yes |
| `pnpm check` | `tsc -p . --noEmit` exit 0 (covers src, test, bench) | clean | yes |
| `cli.ts --dry-run` | 85 cases, 313 targets, 0 loader errors, 0 warnings, 85 pending (all `spec pending`), exit 0 | 85 cases, 298 targets, 3 loader errors (SM-07), exit 1 (15:56) | Differs because the cases changed after 15:56: L7a fixed SM-07 and added targets. DevLog not updated |
| `cli.ts --adapter expected` | cases 33 pass, 0 fail, 52 pending, 0 error; targets 139 pass, 0 fail, 161 pending, 0 error, 13 info; exit 0 | 30/1/53/1; targets 130/3/156 (15:56) | Differs. SM-06 was fixed by L7a (DevLog-006 B2). The 13 `info` targets are not printed on the CLI line (finding M4) |
| `cli.ts --class a --json` | one JSON object `{meta, exit: 0, summary, jsonl, results}`; 29 cases pending, 136 targets | n/a | ok |
| usage errors | `--class d`, `--case NOPE`, `--adapter foo`, `--bogus`, `--fields xx` all exit 1; `--help` exits 0 | documented | yes |
| exit 2 | mock engine, NaN result: exit 2 (scratch `roots/nan_result`) | documented | yes |

## 2. Metric correctness (known answers, `kat.ts`)

| Check | Input | Result |
|---|---|---|
| rel at the boundary | 101 vs 100, rel 1e-2 | pass, limit 1 |
| negative ref | -99.5 vs -100, rel 1e-2 | pass, limit uses \|ref\| |
| abs + rel = max | ref 100, abs 0.5, rel 1e-3: 100.6 fails (limit 0.5); ref 1000: 1000.9 passes (limit 1) | ok |
| ref = 0, rel only | limit 0, rel_err Infinity; the loader errors on inline 0 with rel (`rel-zero-ref`) | ok (not checked for refs that come only from the expected JSON) |
| non-finite | NaN value, NaN ref, Inf value: all fail | ok |
| negative tolerances | schema `exclusiveMinimum: 0` rejects them (`schemachk.ts`) | ok |
| rules | range inclusive; NaN outside; sign of 0 fails; monotonic strict; rate min/max; NaN rate fails | ok |
| rate fit | err = 3 h^2 on h 0.4..0.05: rate 2, ln C = ln 3 to 1e-12; sign-insensitive; zero error dropped | ok |
| observed order | f = 1 + 0.3 h^2, r = 2: p 2, f_ext 1 to 1e-13; non-constant r (0.3, 0.17, 0.1): p 2 to 1e-9 (fixed point) | ok |
| GCI | equals 1.25 \|(f1 - f2)/f1\| / (r^p - 1) to 1e-15 (Celik eq. 5); u_abs = 1.25 \|f_fine - f_ext\| | ok |
| oscillatory / flat / 2-level | null order with a reason; assumed order uses fs 3.0 | ok |
| eigen multiplicity | ref [1, 2, 2, 3] vs computed [1.0001, 1.9999, 2.0002, 3.0001, 4]: pass, group mult 2, split 1.5e-4 | ok |
| RF-21 TE011 / TM111 | triple-degenerate ref 5.000146e9 x3 vs split +-3e-6: pass, mult 3 | ok as numbers. Mode identity (m, TE/TM) cannot be decided by value, so RF-21's per-mode scalars rely on the module's classifier |
| subsequence | spurious mode skipped | ok |
| field norms | a = 1.01 b: l2_rel = max_rel = 0.01, rms_abs = 0.01 sqrt(7.5) | ok |

Known-answer failures and risks are listed as findings S1-S3, B4, M2, M3 and M11.

## 3. Field evaluators and Carlson integrals

- TS port vs `fields.py`: 20 seeded random points per case, 8 cases at default parameters plus WO-03 (m = 2 + 0.3i), EM-04 (R 0.05, I 2, N 10) and AC-03 (ka 0.7); 25 fields in total. Worst pointwise relative difference 2.18e-13 (WO-03 Ey). Every other field is <= 9.5e-14, and Kovasznay and Poiseuille are bit-identical. This confirms the DevLog claim (1e-12 gate, worst 2.44e-13 on its own grid).
- `carlsonRF`, `carlsonRD` and `ellipKE` vs mpmath (40 digits):
  - RF worst 1.5e-16, RD worst 3.5e-16.
  - K worst 2.8e-16 and K - E worst 3.9e-16 over m in [0, 1 - 1e-12].
  - E worst 1.07e-15 at m = 0.999999 (about 5 ulp) and 4.3e-16 at m = 0.9. The DevLog's "to 1 ulp" holds only away from m -> 1 (finding M7).

## 4. Speed harness

Rerun: `nice -n 10 node --max-old-space-size=1536 cli.ts --bench all --sizes 8,16,32,64,96 --out <scratch>`, 54.5 s wall, load average about 4.

| Quantity | DevLog 5.3 (15:37) | Audit (16:06) | Diff |
|---|---|---|---|
| BP3-style r_max | 52.4 MDOF/s | 52.12 | -0.5 % |
| BP1-style r_max | 57.6 | 55.32 | -4.0 % |
| n_0.8 BP1 / BP3 | 729 / 29,791 | 729 / 29,791 | 0 |
| rate fit BP1 / BP3 | 2.007 / 2.004 | 2.007 / 2.004 | 0 |
| max rel nodal error, every row | | identical to 4 digits | 0 |
| T_tol(1e-3) single BP1 / BP3 | 637.5 / 654.1 ms | 657.8 / 661.3 ms | +3 % / +1 % |
| BP3 n = 96 pipeline | 2837.98 ms | 2860.16 ms | +0.8 % |

The 52.4 MDOF/s claim reproduces within shared-machine noise.

Methodology:
- Sound:
  - `timeRuns` discards 1 warm-up and takes the median of 5 (with MAD, min and max).
  - `performance.now()` in Node has sub-microsecond resolution; the smallest timed sample is 0.78 ms.
  - Throughput uses a fixed 50 Jacobi-PCG iterations (rtol 0) and times only the solve.
  - Time-to-accuracy times assemble + constrain + MG setup + solve, with a median per level.
  - The non-conformance caveat appears in the bench header, in DevLog 5.2 and in the README ("BP1/BP3-style").
- Weak: findings S5, S6 and M5. The label is missing from the output records. DOF counting is not stated. The engine-path time-to-accuracy does not follow the A12 protocol. No case can be judged against a Node budget.

## 5. Results output (C8, C5, A5)

- Target lines carry the C8 minimum `{case, target, value, ref, tol, pass, time_ms, dof, run}` plus `kind, class, physics, source, case_status, status, gated, unit, quantity` and diagnostics. Verified in `logs/eval-20261106T160455.jsonl` (313 target lines, 1 meta line, 1 summary line).
- The meta line has `schema amp-eval-run/0`, `started_at` and `finished_at` as ISO 8601 with offset (`2026-11-06T16:04:55-08:00`; the offset code also handles +05:30 and -03:30), harness `@amp/eval@0.0.0+6406f8c` (commit read from `.git` files, git is not run) and a platform `{runtime, ua, cores, node, os, arch, cpu, mem_gb}`. The C5 `gpu` and `crossOriginIsolated` fields are N/A in Node.
- `run` on the engine path is passed through from the module unchecked (finding S4). Only the finest level's record is kept (also S4).
- Log names `logs/eval-YYYYMMDDTHHMMSS.jsonl` and `-summary.md` match C8. They use local time with no zone, second resolution, and overwrite on collision (finding M1).

## 6. Robustness (`robust.ts`, mock `@amp/spec` + `@amp/physics` on scratch roots, 15 s watchdog)

| Scenario | Exit | Behaviour |
|---|---|---|
| malformed YAML | 1 | `XX-01.yaml:5:1 / [error yaml] Flow sequence ...` |
| schema: no `references` | 1 | `:1:1 / [error required] missing required key 'references'` |
| missing expected file | 1 | `:13:15 /references/0/expected [error expected-missing]` |
| expected JSON with `NaN` literal | 1 | `[error json] Unexpected token 'N'` plus expected-missing |
| NaN result, `after: richardson` | 2 | fail, reason `richardson unavailable (not_converged)` (misleading, M2) |
| NaN result, finest | 2 | fail, no reason |
| module throws | 1 | case error `run failed: boom` |
| **module promise never settles** | **0** | **no stdout, no JSONL, no summary: silent exit 0 (B1)** |
| **module hangs (timer / busy loop)** | none | **killed by the 15 s watchdog: no timeout in the harness (B1)** |
| **`@amp/physics` import fails (syntax error)** | **0** | every case `pending`, exit 0 (B2) |
| `run: {}` (empty run record) | 0 | pass (S4) |
| metric_id `f_TE011`, quantity `f TE011` | 1 | `Solution.scalars has no 'f TE011' (has: f_TE011)` (B3) |
| two runs in the same second, same `--out` | 0, 0 | one file pair left: the second run overwrote the first (M1) |

The Python adapter (`AbortSignal.timeout(600 s)`) and the exact-field adapter (120 s) do have timeouts. The engine path does not: `opts.signal ?? new AbortController().signal` is never aborted, and the CLI passes no signal.

## 7. Findings

### Blocking (before the harness gates engine runs)

| # | Finding | Evidence | Proposed fix |
|---|---|---|---|
| B1 | No timeout and no isolation on the engine path. A never-settling module promise drains the event loop and the CLI exits 0 with no output and no logs. A timer or busy loop hangs forever. | `robust.json`: `hang_unsettled_promise` exit 0 in 102 ms, logs []; `hang_timer` / `hang_busy_loop` killed at 15 s. `registry.ts` L207-215, `cli.ts` L113-115 | (1) Set `process.exitCode = 1` before `main()` and overwrite it on completion. (2) Run each case in a `worker_threads` Worker with `resourceLimits` (old-gen 1536 MB) and `terminate()` on a per-level deadline (`--timeout`, default derived from `speed.budget_s` x k), passing `AbortSignal.timeout` into `prepareRun` / `run`. (3) Report a timeout as status `error`, reason `timeout after N s at level k`. |
| B2 | Pending is allowed even when the engine is broken. A failing `@amp/physics` import gives all pending and exit 0. Today 85/85 cases are pending and the run exits 0, so a gate built on this exit code can never fail. | `roots/badimport`: `import of ./src/index.mjs failed: Unexpected token ';'`, exit 0. `runner.ts` `exitCode` | In engine mode (not dry run), an engine-load failure is exit 1. Add a gate list (e.g. `--require-runnable <ids>` or `eval/gates.yaml`, or `--min-pass N`) so a pending gated target in a listed case is an error. Optionally diff against a baseline JSONL to flag pass -> pending regressions. |
| B3 | Scalar extraction defaults to `Solution.scalars[quantity]`. In 131 of 313 targets the quantity differs from the target id and no `extract.name` is given, and 130 quantities contain spaces (`f TE011`). C5's own example keys scalars by metric id (`f_TM010`). | `survey.py`; `robust.json` `quantity_with_space_metric_id_scalar`: error. `registry.ts` L111 | Default `name = targetId(r)` (id, else metric_id), falling back to `quantity`. State the rule in C5/C8 and the README. |
| B4 | SM-06 cannot be evaluated. Its 7 targets have scalar references with `extract: {kind: eigen, offset: 3, floor: 0.01}`, and every one uses the same offset. `evaluateTarget` returns `error: reference is a scalar, observation is an array`. `offset` and `floor` together also skip the rigid modes twice. | `kat.json` `sm06_scalar_ref_eigen_extract`: error; `eigen_floor_and_offset_double_skip`: refs [1.62, 2.36] vs computed [~0 x3, 1.62, 2.36] give 2 unmatched. `eval/cases/a/SM-06.yaml` L39-51 | Add `extract.index` (0-based position in the sorted list after `floor`) for scalar eigen targets. Define `offset` as applied after `floor`, or make using both a validator error. Add a loader error for a scalar reference + `kind: eigen` without `index`. L7a then rewrites SM-06 (modes 4-10 = index 0-6 after floor, or offset 3 without floor). |
| B5 | The engine hook signatures are not fixed. The CONTRACTS changelog says `prepareRun(spec, caseCtx)` and `sample(solution, field, points)`. The harness calls `prepare({case, spec, physicsId, level, hFactor, signal})`. DevLog-010 plans `sample(solution, mesh, field, points, component?)`. The harness drops `ctx` (and so the mesh) after `run`, so it could not call a mesh-taking `sample`, and probe / field extraction returns `pending`. | `registry.ts` L19-20, L128, L210-214; CONTRACTS changelog 16:0x; DevLog-010 L38 | Write the exact TS signatures into C4/C5 (one object argument, as the harness has now). Keep `ctx.mesh` per level next to the Solution. Wire `extract.kind: probe | field` to `@amp/post` `sample` when it is exported. |

### Significant

| # | Finding | Evidence | Proposed fix |
|---|---|---|---|
| S1 | A field target drops non-finite samples with no limit, so a field that is NaN at 3 of 4 points passes. | `kat.json` `field_target_mostly_nan`: pass, n 1, n_dropped 3. `metrics.ts` L53, `evaluate.ts` L99-110 | Fail (or error) when `n_dropped > 0`, unless the case sets `extract.max_dropped` (count or fraction). Print n_dropped in the summary. |
| S2 | Eigen array targets ignore `after: richardson`: the finest level is matched and Richardson is never run. Element-wise Richardson on sorted degenerate partners is also unstable. | `kat.json` `eigen_array_after_richardson`: value [1.001, 2], `richardson: null`. `degen.ts`: partners f0 + 0.5 h^2 +- split (1e-3, 1e-4, 6e-4) give p_obs 0.99 / 3.41 and errors -4.2e-4 / +2.1e-4; the group mean gives p 2 and 0 error. With RF-21's rel 1e-5 this fails a correct solver. | Match each level, then extrapolate the matched values. For degenerate reference groups, extrapolate the group mean and report the split. |
| S3 | Richardson passes outside the asymptotic range. With p_obs 0.5 against an expected 2 (order_ratio 0.25) and a finest value 25 % off, the status is `pass` and the only sign is the reason text. | `kat.json` `scalar_richardson_low_order_gate`. `evaluate.ts` L189-195 (reported, not gated, by design) | When \|p_obs / expected_order - 1\| > 0.25: either compare the finest level with u_num at fs 3.0, or fail with `not asymptotic`. A case can opt out with `convergence.order_check: false`. |
| S4 | The run record is not checked (A5). `run: {}` passes. Engine version, specHash, meshHash, startedAt, platform and fidelity are taken on trust, and the coarse levels' run records and mesh hashes are dropped. | `robust.json` `run_record_empty`: pass. `registry.ts` L248 | Validate `RunRecord` against the `@amp/spec` type (required keys, ISO date with offset). A missing key makes the case an `error` in gate mode. Store `{dof, meshHash, wall_ms}` per level in the target `levels`. |
| S5 | Engine time-to-accuracy uses one cold wall time per level, taken from the accuracy runs (with JIT and first-run effects). Only the finest level gets warm-up + median of 5. A12 asks for median-of-5 throughout. | `registry.ts` L210-215, L236-246; `runner.ts` L91-96 | With `--speed`, time every level with `timeRuns`, or label `time_to_accuracy.protocol: single_run`. |
| S6 | No case can be judged against a speed budget in Node. 0 of 85 cases have `budget_s.native`, 55 have only `browser`, and 30 have none. `meets_budget` also compares the finest-level median rather than the time to reach the tolerance (R3 s.5.3 item 5). With `after: richardson`, every level is needed, so the relevant time is the cumulative one. | `survey2.py`: (native, browser) = {(F, T): 55, (F, F): 30}. `runner.ts` L97-101 | Base `meets_budget` on T_tol (cumulative for richardson targets). Use `budget_s.browser` only in the browser runner. L7a/b/c add native budgets (labelled estimates) where Node gating is wanted. |
| S7 | Not built yet: browser runner, report page, dataset adapter (assigned 16:1x), multiphysics orchestration (more than one physics entry is `pending`). `runner.ts` lazily imports the Node-only `adapters/fields.ts` as its default, so a browser runner must inject `exactField`. No `@amp/eval` engine run has happened, so M1's "harness runs them in Node and reports accuracy + time" is met only by the expected self-check, which says nothing about the engine. | `runner.ts` L76; `registry.ts` L186; DevLog-009 s.8 "Open" (stated honestly) | Track as wave-1 TODOs in DevLog-009. The browser runner reuses loader / metrics / evaluate / runner / report with a Worker Source and the TS fields port, and records `crossOriginIsolated` and timer clamping in meta. |

### Minor

| # | Finding | Evidence | Proposed fix |
|---|---|---|---|
| M1 | Log names have second resolution and no zone, and `writeFileSync` overwrites. Two runs in the same second keep only the second. This conflicts with the rule never to overwrite outputs. | scratch `roots/baseline_pass/out2`: 2 runs, 1 file pair | Open with `flag: 'wx'` and add a `-N` suffix on EEXIST, or add milliseconds. Keep the C8 pattern as a prefix. |
| M2 | A non-finite engine value is reported as `fail` with a misleading reason (`richardson unavailable (not_converged)`), or with no reason. | `roots/nan_result*` | Check finiteness per level first: status `error`, reason `non-finite value at level k`. |
| M3 | A tolerance with both `rule` and `rel` / `abs` is schema-valid. Scalar targets silently ignore `rel` / `abs`; field targets apply both. Used by FL-01 and SM-01 (abs + rate). | `schemachk.ts` `rel_and_rule`: ok; `evaluate.ts` L121-137 | Apply both on the scalar path, or reject the combination for scalars. |
| M4 | The CLI summary line omits `info`: 139 + 161 = 300 of 313 targets. | `exp.out` vs JSONL summary `info: 13` | Print `info`. |
| M5 | Bench: (a) BP3 throughput counts free nodes, but PCG works on all (n+1)^3 nodes (`pcg.mjs` loops lo..hi), a factor N / DOF_free of 2.13 at n = 8, 1.21 at 32 and 1.06 at 96. This lowers small-n BP3 rates and shifts n_0.8. (b) Allocating x and the 4 PCG vectors falls inside the timed region. (c) The "-style / non-conforming" label is missing from the JSONL (`bench: "bp3"`), the console headings and the DevLog 5.3 table column. | `bench/poisson.ts` L78-80, L128-134; `bench-poisson-20261106T160624.jsonl` | Record `dof_counting: free_nodes`, `conforming_ceed: false` and `bench: bp3-style` in the meta and records. Optionally report both DOF counts. Preallocate outside the timer. |
| M6 | NaN and Infinity are written as the strings `"NaN"` / `"Infinity"` in the JSONL, which is undocumented. | `report.ts` L23 | Document this in the README (or write null plus a `nonfinite` flag). |
| M7 | DevLog-009 is stale after 15:56: current counts are in section 1 above. The progress log is out of order (the 15:56 entry sits before 15:48). Contract request 0 is resolved in `package.json`, but `contract-shim.ts` still uses the relative path and says the request is pending. "K, E match mpmath to 1 ulp" holds only away from m -> 1 (E is 1.07e-15 relative at m = 0.999999). | sections 1 and 3 | Add a final validation entry, reorder the log, switch the shim to `@amp/spec/types`, and restate the claim as "<= 5 ulp, m <= 1 - 1e-6". |
| M8 | The schema message for `.nan` / `.inf` reads "expected number, got number". | `schemachk.ts` `value_nan` | Report "non-finite number". |
| M9 | `time_ms` on a target line is the sum of every level's wall time (prepare + run), and the README does not say so. | `evaluate.ts` L86-87 | Document it, or split into `time_ms_finest` and `time_ms_total`. |
| M10 | There is no minimum sample duration. Browser timer clamping is not handled; it matters only for the browser runner. | `speed.ts` | Repeat a sample until it lasts >= 10 ms (count the reps) when the first sample is short. |
| M11 | `matchEigen` subsequence with fewer computed than reference values returns zero pairs, so all references are unmatched and the diagnostics are lost. | `kat.json` `eigen_missing_partner_subseq`: 0 pairs, 5 unmatched | Allow partial assignment (the DP with skips on both sides) and report the missing ones. |

## 8. Gaps before real engine gating (item 7, summary)

1. `@amp/physics` `index.ts` with `modules` + `prepareRun`: absent at 16:10 (L4). The signature must be fixed in C4 first (B5).
2. `@amp/post` `sample(...)`: not exported. The harness needs the mesh kept per level (B5). No case has `extract.kind: probe | field` yet (0 of 313), so this matters once L7 cases add them.
3. Specs: all 85 cases have `spec: {status: pending}`, so 0 cases are runnable until the L2 `sims/` models land.
4. Gate semantics: B1 (timeout / isolation), B2 (pending passes), B3 (scalar naming), B4 (SM-06) and S1-S4 should be fixed before the exit code is trusted in CI.
5. Dataset adapter (The Well / PDEBench, VRMSE / nRMSE): not started (assigned 16:1x). Dataset targets stay `gate: false`.
6. Browser runner and report page: not started. Browser budgets (55 cases) can only be judged there (S6, S7).
