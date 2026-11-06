# validation/

uv Python project (Python 3.12) with open reference generators and solvers for the eval set (`amp-eval/0`, schema in `DevLog/research/2026-11-06-R3-eval-set-sources.md` s.2; contract C8). `uv` only, never pip.

| Path | Owner | Content |
|---|---|---|
| `pyproject.toml`, `uv.lock` | L7a | dependencies: numpy, scipy, mpmath, pyyaml (other lanes request additions through the coordinator) |
| `a/` | L7a | class a: closed forms and series (DevLog-006) |
| `b/` | L7b | class b: paper cases |
| `c/` | L7c | class c: open-solver suites and datasets |

## Class a quick start

```bash
cd validation
uv sync
uv run python a/run_all.py            # regenerate eval/expected/<ID>.json for every class-a generator
uv run python a/run_all.py --check    # reproducibility gate: regenerate into a temp dir and compare (no overwrite)
uv run python a/build_cases.py        # write eval/cases/a/<ID>.yaml (skips existing; --force to rewrite)
uv run python a/validate_cases.py     # schema check of eval/cases/a/*.yaml + YAML/JSON value agreement
uv run python a/fields.py --list      # exact-field evaluator for field-error metrics (see its --help)
```

Logs of `run_all.py` go to `logs/l7a-{generate,check}-<timestamp>.log`.

## Expected-value files (`eval/expected/<ID>.json`, `amp-eval-expected/0`)

`case`, `generator` (repo-relative path), `command`, `method`, `generated_at` (ISO 8601 with offset), `versions` (python, numpy, scipy, mpmath, pyyaml, scipy.constants mu_0 as the CODATA marker), `targets[]` with `metric_id`, `value`, `unit`, `precision` (series terms and change on doubling, root tolerance, or an independent cross-check), `r3` (agreement with the value R3 states), `locator`. Some files add `flag_resolution`, `inputs`, `field_function`.

## Field functions

`a/fields.py <CASE> --points pts.json` evaluates exact fields at given points: SM-01 (Kirsch stresses and displacements), FL-01 (Kovasznay), FL-01-pois, WO-03 (Mie total E field, complex), EM-04 (Helmholtz coil B), AC-03 (rigid-sphere pressure, complex), TR-01 (Danckwerts profile), CP-05 (electro-osmotic profile). The same functions are importable from `a/gen_*.py`.

## Rules

- No COMSOL files, runs or values (DevLog-001 Q5).
- Every value is a closed form or series computed here (basis D) or a cited primary value (basis P) with a locator; synthetic inputs are labelled.
- BLAS threads are pinned to 1 by `a/common.py`; run heavy jobs with `nice -n 10`.
