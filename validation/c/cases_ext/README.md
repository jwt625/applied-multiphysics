# validation/c/cases_ext

Per-lane class-c case modules. Each `<name>.py` defines `CASES: list[dict]` (amp-eval/0 case dicts, same shape as
`build_cases.all_cases()`). `build_cases.py` loads every module here in name order (files starting with `_` are
skipped) and writes `eval/cases/c/<ID>.yaml`; `test_build_matches.py` then covers them like the built-in cases.
Ids must be unique across the whole class (the builder fails on duplicates).
