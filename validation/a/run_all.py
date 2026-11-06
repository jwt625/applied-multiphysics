# SPDX-License-Identifier: GPL-3.0-or-later
"""Run every class-a generator.

  uv run python a/run_all.py            regenerate eval/expected/*.json (class a) in place
  uv run python a/run_all.py --check    regenerate into a temporary directory and compare every target value with
                                        the files in eval/expected/ (reproducibility gate; nothing is overwritten)

A log with a timestamp in its name is written to logs/.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
GENERATORS = ["gen_heat.py", "gen_solid.py", "gen_em.py", "gen_optics.py", "gen_misc.py"]


def run(outdir: Path | None, log) -> None:
    env = dict(os.environ, OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
    if outdir is not None:
        env["AMP_EXPECTED_DIR"] = str(outdir)
    for g in GENERATORS:
        p = subprocess.run([sys.executable, str(HERE / g)], env=env, capture_output=True, text=True, cwd=HERE)
        log.write(f"{g}: rc={p.returncode}\n{p.stdout}{p.stderr}\n")
        if p.returncode != 0:
            raise SystemExit(f"{g} failed:\n{p.stderr}")


def compare(ref_dir: Path, new_dir: Path, log) -> int:
    bad = 0
    n = 0
    for f in sorted(new_dir.glob("*.json")):
        new = json.loads(f.read_text())
        old_path = ref_dir / f.name
        if not old_path.exists():
            log.write(f"MISSING in eval/expected: {f.name}\n")
            bad += 1
            continue
        old = {t["metric_id"]: t["value"] for t in json.loads(old_path.read_text())["targets"]}
        for t in new["targets"]:
            n += 1
            ov = old.get(t["metric_id"])
            nv = t["value"]
            same = ov is not None and (ov == nv or math.isclose(ov, nv, rel_tol=1e-12, abs_tol=1e-300))
            if not same:
                bad += 1
                log.write(f"DIFF {f.stem} {t['metric_id']}: expected {ov} regenerated {nv}\n")
    log.write(f"compared {n} target values; {bad} differ or are missing\n")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    (REPO / "logs").mkdir(exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    log_path = REPO / "logs" / f"l7a-{'check' if a.check else 'generate'}-{stamp}.log"
    with log_path.open("w") as log:
        log.write(f"started {dt.datetime.now().astimezone().isoformat(timespec='seconds')}\n")
        if a.check:
            with tempfile.TemporaryDirectory(prefix="l7a-expected-") as td:
                run(Path(td), log)
                bad = compare(REPO / "eval" / "expected", Path(td), log)
        else:
            run(None, log)
            bad = 0
            log.write(f"generated {len(GENERATORS)} generator modules into eval/expected/\n")
        log.write(f"finished {dt.datetime.now().astimezone().isoformat(timespec='seconds')}\n")
    print(log_path.read_text().splitlines()[-2])
    print(f"log: {log_path.relative_to(REPO)}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
