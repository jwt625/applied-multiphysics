# Evaluation set (`amp-eval/0`)

Accuracy and speed cases for the engine. Plan: `DevLog/DevLog-001-plan-poc-and-eval.md` (A12, M1). Sources: `DevLog/research/2026-11-06-R3-eval-set-sources.md`. Harness: `packages/eval` (`DevLog/DevLog-009-eval-harness.md`). Class lanes: L7a `DevLog-006`, L7b `DevLog-007`, L7c `DevLog-008`.

## Layout

```text
eval/
  schema/amp-eval-0.schema.json   case schema (JSON Schema 2020-12); changelog in DevLog-009 s.3
  cases/a/<ID>.yaml               analytic / textbook (L7a)
  cases/b/<ID>.yaml               paper results (L7b)
  cases/c/<ID>.yaml               other open solvers and datasets (L7c)
  expected/<ID>.json              generated reference values (amp-eval-expected/0): generator, versions, generated_at, targets[]
```

One YAML per case. The file stem equals `id`, the directory equals `class`. The engine and the Python references in `validation/` read the same case file.

## Run

```bash
node packages/eval/src/cli.ts --dry-run                 # load + validate every case, show what would run
node packages/eval/src/cli.ts                           # run on the engine (@amp/physics); pending where no module exists
node packages/eval/src/cli.ts --class a --tag heat      # filters: --class a|b|c, --case ID, --tag <physics tag or prefix>
node packages/eval/src/cli.ts --adapter expected        # self-check: case YAML value vs eval/expected/<ID>.json
node packages/eval/src/cli.ts --adapter python          # adapter.python.script via uv run --project validation
node packages/eval/src/cli.ts --fields ts               # exact fields from the TS port (default: python, validation/a/fields.py)
node packages/eval/bench/fields-crosscheck.ts           # gate: TS port vs fields.py, 1e-12 relative
node packages/eval/src/cli.ts --speed                   # + 1 warm-up and median of 5 on the finest level, time-to-accuracy
node packages/eval/src/cli.ts --bench all --sizes 8,16,32,64   # BP1/BP3-style Poisson throughput on @amp/core
node packages/eval/src/cli.ts --json                    # machine-readable result on stdout
node packages/eval/src/cli.ts --strict                  # a gated target left pending is an error (exit 1)
node packages/eval/src/cli.ts --timeout 120 --max-mem 1536   # per-case wall clock (s) and worker heap cap (MB)
```

Heavy runs: prefix `nice -n 10` and add `node --max-old-space-size=1536`.

Exit codes: `0` every gated target passed (pending allowed unless `--strict`), `1` error (loader, run, usage, run record, a present but broken `@amp/physics` / `@amp/post`, a timeout), `2` a gated target missed. Errors take precedence over misses. The process exit code is 1 until the run completes, so a drained event loop never looks like a pass.

Engine path: each case runs in its own `worker_threads` Worker (`packages/eval/src/engine-worker.ts`) with a heap cap (`--max-mem`, default 1536 MB) and a wall-clock limit: `--timeout S`, else 20 x `speed.budget_s` (native, else browser) per level, at least 30 s per level, 60 s per level without a budget, x 7 with `--speed`, capped at `--timeout-cap` (default 600 s). A hang or busy loop is `timeout`, a never-settling promise or a heap overrun is `error`; both exit 1 with a log line. Hooks (L4): `@amp/physics` `modules`, `registry`, `prepareRun` (`(args)` or `(spec, caseCtx)`), `physicsRegistry()` and `RESULT_NAMES`; `@amp/post` `sample(solution, field, points, {mesh, component})`, called with the level's own mesh. Every level's run record must carry `engine, specHash, meshHash, startedAt` (ISO 8601 with offset), `platform.runtime` and `fidelity`, else the case is an error.

Outputs (not committed, `logs/` is ignored; a name that exists already gets a `-2`, `-3`, ... suffix, nothing is overwritten): `logs/eval-YYYYMMDDTHHMMSS.jsonl` (one `meta` line, one `target` line per target with the C8 fields `{case, target, value, ref, tol, pass, time_ms, dof, run}` plus diagnostics, `speed` lines, one `summary` line) and `logs/eval-YYYYMMDDTHHMMSS-summary.md` (pass / fail / pending / error counts per class and per physics tag, missed targets with budget, errors with file:line, pending grouped by reason). Bench: `logs/bench-poisson-YYYYMMDDTHHMMSS.jsonl`.

JSONL notes: non-finite numbers are written as the strings `"NaN"`, `"Infinity"`, `"-Infinity"`. `time_ms` on a target line is the sum of the wall times (prepare + run) of every mesh level of the accuracy runs; with `--speed` the `speed` line carries the per-level medians (`protocol: warmup1_median5_per_level`), `t_tol_ms` (time to reach every gated tolerance; cumulative over the levels for Richardson targets) and `meets_budget` against `budget_s.native` only (pending without one). Bench records carry `bench: bp1-style | bp3-style` and `conforming_ceed: false`.

## Writing a case

Minimal shape (all keys in the schema; unknown keys are errors, `x-*` top-level keys are allowed):

```yaml
schema: amp-eval/0
id: HT-03
class: a
title: NAFEMS T2 radiating rod
status: unvalidated            # unvalidated | verified | validated | measured_regression | untestable (+ untestable_reason)
physics: [heat-rad]
dimension: 1D
units: SI
spec: {status: pending, reason: "no 1D heat module yet"}   # or sims/<id>.yaml, or an embedded amp-spec/0 model
references:
  - quantity: T_B                # target id = id, else metric_id, else quantity (+ [k=v] of `case`)
    metric_id: T_B                 # id shared with eval/expected/<ID>.json targets[].metric_id
    expected: {file: eval/expected/HT-03.json, metric_id: T_B}   # generated value; or an inline `value:`
    unit: K
    tolerance: {rel: 1.0e-3, after: richardson}   # rel | abs | both (= max(abs, rel |ref|)) | rule {type: range|sign|monotonic|rate}
    basis: D                     # P primary | S open re-tabulation | D derived
    form: closed_form
    provenance: {citation: "...", locator: "...", accessed: 2026-11-06}
    extract: {kind: scalar, name: T_B}             # optional; scalar | eigen | steps | probe | field
convergence: {levels_min: 3, ratio_min: 1.5, method: richardson_gci, expected_order: 2}
rights: {source_license: "...", allowed: [cite_values], forbidden: [copy_text]}
```

Class-b `source` block (primary publication; schema `properties.source`, strict keys):

| Key | Type | Meaning |
|---|---|---|
| `citation` | string, required | full reference of the primary paper |
| `doi` | string or null | |
| `open_access` | boolean | primary paper free to read |
| `open_copy` | fileRef or null | open author / arXiv / course copy |
| `retabulation` | fileRef or list | open re-tabulation of the paper's numbers (basis S) |
| `reference_page`, `reference_pages` | fileRef, list | benchmark web page(s) with the values |
| `secondary_references`, `later_reference` | citationRef list / one or list | other papers that report the same quantity |
| `atlas_ref` | `{repo, path, id, commit, sim_case?, evidence?, note?}` | the same case in a sibling atlas (read-only) |
| `note` | string | |

fileRef = `{url?, where?, version?, cache?, sha256?, licence?, note?}`; `sha256` is 64 hex digits of the cached copy (`cache/` is not committed). citationRef = `{citation, doi?, open_access?, note?}`.

Rights tags (`rights.allowed` / `rights.forbidden`; enum in the schema, `$defs/rightsItem`):

| Tag | Meaning |
|---|---|
| `cite_values` | cite the numbers with their locator |
| `re_derive_setup` | re-derive geometry, BCs and materials from the original reference |
| `copy_text` | copy text verbatim |
| `copy_text_without_attribution` | copy text without attribution |
| `copy_with_attribution` | copy content with attribution (permissive or copyleft-compatible licence) |
| `copy_figures` | copy figures |
| `copy_input_files` | copy input decks, meshes or model files |
| `copy_code` | copy source code |
| `copy_data` | copy data files into the repo |
| `copy_booklet_content` | copy NAFEMS booklet content |
| `copy_v_doc_text` | copy Code_Aster V-documentation text (GNU FDL) |
| `redistribute_data` | redistribute the data files |
| `redistribute_data_without_attribution` | redistribute the data without attribution |
| `reference_by_hash` | keep the data out of the repo and reference it by manifest + hash; requires dataset.hash |

`reference_by_hash` in `allowed` is a loader error without `dataset.hash` (`sha256:<64 hex>` or `md5:<32 hex>`).

Units: a Solution value is converted to the target unit with the `@amp/spec` units API (`@amp/core/units` plus affine `degC`); different dimensions or an unknown unit (e.g. `lbf`) make the target an `error`.

Target lookup: by `metric_id` only (slug `[A-Za-z][A-Za-z0-9_.+-]*`), as the `Solution.scalars` key unless `extract.name` is given. A target without `metric_id` is a loader warning and stays pending on the engine path; a metric the module does not declare in `RESULT_NAMES` or does not produce is pending with the reason.

How a target is judged:
- `after: richardson` uses the shared rule `richardsonRule` (exported from `@amp/eval/metrics`, also used by L4's gate scripts). Observed order from the three finest levels (Celik et al. 2008, fixed point for non-constant ratios). Richardson is **available** only when the observed order lies within the band of the theoretical order (`convergence.expected_order`): `|p_obs / p_theory - 1| <= band`, band = `convergence.order_band`, default `RICHARDSON_ORDER_BAND` = 0.25 (p_obs in [1.5, 2.5] for p_theory 2, [2.25, 3.75] for 3). Without a theoretical order the observed order is accepted and flagged "not checked"; `order_check: false` widens the band to infinity. When available: pass needs `|f_ext - ref| <= budget` and the finest level within the budget; the GCI band of the finest level (`u_num`, fs 1.25) is reported next to it. When unavailable (order outside the band, oscillatory or non-nested sequence, flat, fewer than 3 levels): never extrapolated; the target is gated on the finest value within the budget plus a non-increasing |error| over the levels (`richardson_fallback: finest+monotone`), with the reason.
- `after: finest` (default): the finest level is compared.
- Arrays: element-wise, or `extract.kind: eigen` (both lists sorted, degenerate values repeated; `match: subsequence` tolerates spurious and missing modes; `floor` drops rigid-body / null modes, `offset` skips more after the floor: use one of them, not both). With `after: richardson` every level is matched first; a degenerate reference cluster is extrapolated through its mean, each member keeping its finest-level split.
- Derived values (`extract.kind: reduce | expr`): `reduce` takes `op` (max, min, mean, absmax, absmin) of a field over `points`; `expr` evaluates an expression over named `terms` (each a `scalar` by name, `probe`, `reduce`, nested `expr`, or a constant `{value, unit}`) with `@amp/core/expr`, dimension-checked; the result must have the target unit's dimension and is converted to it. Example, SM-01 K_t: `{kind: expr, expr: "smax / s_inf", terms: {smax: {kind: reduce, field: stt, op: max, points: [...]}, s_inf: {value: 100, unit: MPa}}}`.
- Tensor and vector field targets: `extract: {kind: field, fields: [sxx, syy, sxy], ...}` (several fields) or `{field: u, components: [0, 1], ...}` (one vector field); samples are concatenated component-major on both sides; `evaluator_fields` names the evaluator fields in the same order (default = `fields`), `samples_key` values may be flat or one array per component. The relative L2 / max norm is taken over all components together.
- Per-target model: `references[].spec` (same forms as the case `spec`) overrides the case-level spec for that target; each distinct spec runs in its own worker with its own mesh levels (e.g. WO-01 TE0 on `sims/si-slab.yaml`, TM0 on `sims/si-slab-tm0.yaml`).
- Scalar eigen targets: `extract: {kind: eigen, floor: <f>, index: <k>}` takes position k (0-based) of the sorted list after floor / offset.
- NaN or Inf on any level fails the target with the level named; a field target fails on non-finite samples unless `extract.max_dropped` allows them.
- A rule with `rel` / `abs` next to it: both apply.
- Fields: `extract.kind: field` with `samples_key` (points + values in the expected JSON) or `evaluator: validation/a/fields.py` + `points`; relative L2 (`norm: l2`) or max (`norm: max`) over the sample points.
- `gate: false`: reported as `info`, never the gate.
- Sequence rules (`rate`, `monotonic`) with a single value (one level, the expected self-check) are `pending`, not `fail`.
- Never compare at a singular nodal maximum; use probes, integrals, ring means (atlas rule).

## Python reference adapter protocol

`adapter.python.script` is run as `nice -n 10 uv run --project validation python <script> --case eval/cases/<class>/<ID>.yaml --json` from the repo root. It prints one JSON object (whole stdout or its last line):

```json
{"targets": {"<target id>": {"value": 1.0} , "<id2>": {"levels": [{"value": 1.02, "dof": 1000, "h": 0.1, "wall_ms": 12}]}, "<id3>": {"pending": "why"}},
 "run": {"engine": "scikit-fem@<version>"}}
```
