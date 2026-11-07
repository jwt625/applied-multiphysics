# validation/c/mpb (outside uv)

Scripts here run with an existing conda interpreter, approved by Wentao on 2026-11-06 for gating WO-04 and WO-61:

- Interpreter: `$MPB_PYTHON`: the python of a conda env with conda-forge pymeep 1.34.0 (Python 3.13.15, `from meep import mpb`).
- Read-only use: nothing is installed, updated or removed in that env, and no new conda envs are created.
- Always run with `-I` and `nice -n 10`, from `cache/eval-c/mpb-runs/` so MPB's output stays out of the repo.
- This is NOT part of the `validation/` uv project. The uv generators (`../gen_pwe.py`) do not depend on it.

Run (from the repo root):

    cd cache/eval-c/mpb-runs && nice -n 10 $MPB_PYTHON -I \
        ../../../validation/c/mpb/mpb_gaps.py square 32

`mpb_convergence.py` (uv side, numpy only) reads the JSON lines that `mpb_gaps.py` prints and writes the
Richardson extrapolation into `eval/expected/WO-04.json` and `WO-61.json` (see DevLog-008 "MPB gating").
