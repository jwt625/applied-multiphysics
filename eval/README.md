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
```

Heavy runs: prefix `nice -n 10` and add `node --max-old-space-size=1536`.

Exit codes: `0` every gated target passed (pending allowed), `1` error (loader, run, usage), `2` a gated target missed. Errors take precedence over misses.

Outputs (not committed, `logs/` is ignored): `logs/eval-YYYYMMDDTHHMMSS.jsonl` (one `meta` line, one `target` line per target with the C8 fields `{case, target, value, ref, tol, pass, time_ms, dof, run}` plus diagnostics, `speed` lines, one `summary` line) and `logs/eval-YYYYMMDDTHHMMSS-summary.md` (pass / fail / pending / error counts per class and per physics tag, missed targets with budget, errors with file:line, pending grouped by reason). Bench: `logs/bench-poisson-YYYYMMDDTHHMMSS.jsonl`.

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

Units: a Solution value is converted to the target unit with the `@amp/spec` units API (`@amp/core/units` plus affine `degC`); different dimensions or an unknown unit (e.g. `lbf`) make the target an `error`.

How a target is judged:
- `after: richardson`: observed order from the three finest levels (Celik et al. 2008, fixed point for non-constant ratios), Richardson value from the two finest, pass on `|f_ext - ref| <= budget`. The GCI band of the finest level (`u_num`, safety factor 1.25 with observed order, 3.0 with an assumed order) and `p_obs / expected_order` are reported next to the budget.
- `after: finest` (default): the finest level is compared.
- Arrays: element-wise, or `extract.kind: eigen` (both lists sorted, degenerate values repeated; `match: subsequence` tolerates spurious modes; `floor` drops rigid-body / null modes).
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
