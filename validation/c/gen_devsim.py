# SPDX-License-Identifier: GPL-3.0-or-later
"""SC-02: re-run the DEVSIM diode_1d example and compare with the DEVSIM golden result (lane L7c, DevLog-008).

The example scripts (Apache-2.0) are fetched at a pinned commit into cache/eval-c/devsim/ (gitignored),
checked against sha256 values recorded here, and run unmodified in a subprocess. The golden output is
fetched the same way (devsim/devsim_tests_macos_arm64; repository has no LICENSE file: values are cited,
the file is not committed). Nothing from DEVSIM is copied into the repository.

Run (devsim is not in validation/pyproject.toml; requested in DevLog-008 "Contract requests"):
  cd validation && uv run --with devsim==2.11.2 --with requests python c/gen_devsim.py
"""

from __future__ import annotations

import hashlib
import os
import random
import subprocess
import sys
import time
from pathlib import Path

import requests
from common_c import CACHE_DIR, source_compare, target, write_expected

GEN = "validation/c/gen_devsim.py"
DEVSIM_COMMIT = "e3a25f08c7f17cc6932624c12bf9f0f10d7f7cfd"
GOLDEN_COMMIT = "85e6e1f200374e1e69bb156bc640390b783da6ac"
FILES = {
    "diode_1d.py": (
        f"https://raw.githubusercontent.com/devsim/devsim/{DEVSIM_COMMIT}/examples/diode/diode_1d.py",
        "66a60784e9a54644b6186828343a6101228d13a4e4a0ab007e17aee0992f9cd8",
    ),
    "diode_common.py": (
        f"https://raw.githubusercontent.com/devsim/devsim/{DEVSIM_COMMIT}/examples/diode/diode_common.py",
        "5fb7a95c08165627bffd33ca97755ef206de49ee7f550c91023294de3486e772",
    ),
    "diode_1d.golden.out": (
        f"https://raw.githubusercontent.com/devsim/devsim_tests_macos_arm64/{GOLDEN_COMMIT}/"
        "goldenresults/examples/diode/diode_1d.out",
        "d73bc236345a898f379a29d74fcbf5d899faaa3f9f63d2ea0fd302a2f10b0c7d",
    ),
}


def fetch() -> Path:
    d = CACHE_DIR / "devsim"
    d.mkdir(parents=True, exist_ok=True)
    for name, (url, sha) in FILES.items():
        p = d / name
        if not p.exists():
            time.sleep(3 + random.uniform(0, 3))
            r = requests.get(url, timeout=60, headers={"User-Agent": "amp-eval-lane-L7c/0"})
            r.raise_for_status()
            p.write_bytes(r.content)
        got = hashlib.sha256(p.read_bytes()).hexdigest()
        if got != sha:
            raise SystemExit(f"sha256 mismatch for {name}: {got}")
    return d


def parse(text: str) -> dict[str, list[tuple[float, float, float, float]]]:
    rows: dict[str, list[tuple[float, float, float, float]]] = {"top": [], "bot": []}
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) == 5 and parts[0] in rows:
            rows[parts[0]].append(tuple(float(x) for x in parts[1:]))  # type: ignore[arg-type]
    return rows


def main() -> int:
    import devsim  # noqa: F401  (version record; the run itself is a subprocess)

    d = fetch()
    env = dict(os.environ, OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1")
    # not -I: the example imports diode_common from its own directory (sha256-pinned files only)
    run = subprocess.run(
        [sys.executable, str(d / "diode_1d.py")], cwd=d, capture_output=True, text=True, env=env, timeout=600
    )
    if run.returncode != 0:
        print(run.stderr[-2000:])
        return 1
    (d / "diode_1d.local.out").write_text(run.stdout)
    ours, gold = parse(run.stdout)["top"], parse((d / "diode_1d.golden.out").read_text())["top"]
    tg = []
    for (v, _, _, jt), (vg, _, _, jg) in zip(ours, gold, strict=True):
        if v < 0.05:
            continue
        mv = f"{v:.1f}"
        tg.append(
            target(
                f"J_top_{mv}V",
                jt,
                "A/cm^2",
                {"method": "DEVSIM diode_1d.py re-run, unmodified", "golden_rel_diff": abs(jt - jg) / abs(jg)},
                source_compare(jt, repr(jg), 1.0, "golden diode_1d.out, total current at contact top"),
                locator=f"devsim_tests_macos_arm64@{GOLDEN_COMMIT[:7]} goldenresults/examples/diode/"
                f"diode_1d.out, line 'top {vg}'",
                bias_V=v,
            )
        )
    write_expected(
        "SC-02",
        tg,
        GEN,
        "DEVSIM 1D abrupt Si pn diode (examples/diode/diode_1d.py: N_A = N_D = 1e18 cm^-3, 1e-5 cm, "
        "SRH tau 1e-8 s, Scharfetter-Gummel), DC sweep 0.1-0.5 V; total current density at contact "
        "'top' (DEVSIM cm-based units; 1D device, so A/cm^2).",
        extra={
            "devsim_commit": DEVSIM_COMMIT,
            "golden_commit": GOLDEN_COMMIT,
            "files_sha256": {k: v[1] for k, v in FILES.items()},
        },
        extra_versions={"devsim": getattr(__import__("devsim"), "__version__", "2.11.2 (pinned in uv --with)")},
        command="cd validation && uv run --with devsim==2.11.2 --with requests python c/gen_devsim.py",
    )
    for t in tg:
        print(t["metric_id"], t["value"], t["precision"]["golden_rel_diff"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
