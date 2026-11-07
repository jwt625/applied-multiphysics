# SPDX-License-Identifier: GPL-3.0-or-later
"""SC-02: re-run the DEVSIM diode_1d example and compare with the DEVSIM golden result (lane L7c, DevLog-008).

The example scripts (Apache-2.0) are fetched at a pinned commit into cache/eval-c/devsim/ (gitignored),
checked against sha256 values recorded here, and run unmodified in a subprocess. The golden output is
fetched the same way (devsim/devsim_tests_macos_arm64; repository has no LICENSE file: values are cited,
the file is not committed). Nothing from DEVSIM is copied into the repository.

Gate values (audit B2): devsim_diode_tight.py, extended precision, three meshes, Richardson.

Run: cd validation && uv run python c/gen_devsim.py
"""

from __future__ import annotations

import hashlib
import json
import math
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
    gold_bot = parse((d / "diode_1d.golden.out").read_text())["bot"]

    # Tight reference (audit B2): extended precision, Newton to the round-off floor, mesh refine 1, 2, 4
    levels = []
    for refine in (1, 2, 4):
        r = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("devsim_diode_tight.py")), str(d), str(refine), "extended"],
            capture_output=True,
            text=True,
            env=env,
            timeout=1200,
        )
        line = [x for x in r.stdout.splitlines() if x.startswith("{")]
        if r.returncode != 0 or not line:
            print(r.stderr[-2000:])
            return 1
        levels.append(json.loads(line[-1]))
    tg = []
    for i, ((v, _, _, jt), (_, _, _, jg), (_, _, _, jgb)) in enumerate(
        zip(ours[1:], gold[1:], gold_bot[1:], strict=True)
    ):
        j = [lv["rows"][i]["J_top"] for lv in levels]
        jb = [lv["rows"][i]["J_bot"] for lv in levels]
        cont = max(abs(a + b) / abs(a) for a, b in zip(j, jb, strict=True))
        p_obs = math.log(abs(j[0] - j[1]) / abs(j[1] - j[2])) / math.log(2)
        j_ext = j[2] + (j[2] - j[1]) / 3  # second-order Richardson (formal p = 2, observed p_obs)
        mv = f"{v:.1f}"
        tg.append(
            target(
                f"J_{mv}V",
                j_ext,
                "A/cm^2",
                {
                    "method": "DEVSIM 2.11.2, diode_1d set-up, float128 (extended_*), Newton rel 1e-11 / abs 1e4 "
                    "cm^-3, mesh spacing / 1, 2, 4; Richardson p = 2",
                    "levels": [
                        {"refine": lv["refine"], "n_nodes": lv["n_nodes"], "J_top": jj}
                        for lv, jj in zip(levels, j, strict=True)
                    ],
                    "observed_order": p_obs,
                    "richardson_minus_finest_rel": abs(j_ext - j[2]) / abs(j_ext),
                    "current_continuity_max_rel": cont,
                },
                source_compare(
                    j_ext,
                    repr(jg),
                    1.0,
                    "DEVSIM golden diode_1d.out, 'top' (double precision, absolute_error 1e10: informative only)",
                ),
                locator=f"devsim_tests_macos_arm64@{GOLDEN_COMMIT[:7]} goldenresults/examples/diode/"
                f"diode_1d.out, line 'top {v}'",
                bias_V=v,
                golden_top=jg,
                golden_bot=jgb,
                golden_continuity_rel=abs(jg + jgb) / abs(jg),
                example_rerun_top=jt,
                example_rerun_vs_golden_rel=abs(jt - jg) / abs(jg),
            )
        )
    write_expected(
        "SC-02",
        tg,
        GEN,
        "DEVSIM 1D abrupt Si pn diode (examples/diode/diode_1d.py set-up: N_A = N_D = 1e18 cm^-3, length 1e-5 cm, "
        "SRH tau_n = tau_p = 1e-8 s, Scharfetter-Gummel), DC sweep 0.1-0.5 V; total current density at the "
        "contacts (DEVSIM cm units, A/cm^2). Gate values: extended-precision, mesh-extrapolated; the double-precision "
        "golden and the unmodified example re-run are recorded per target.",
        extra={
            "devsim_commit": DEVSIM_COMMIT,
            "golden_commit": GOLDEN_COMMIT,
            "files_sha256": {k: v[1] for k, v in FILES.items()},
            "driver": "validation/c/devsim_diode_tight.py",
            "physical_parameters": {
                "T_K": 300,
                "q_C": 1.6e-19,
                "k_B_J_per_K": 1.3806503e-23,
                "eps0_F_per_cm": 8.85e-14,
                "eps_r_Si": 11.1,
                "n_i_cm-3": 1.0e10,
                "mu_n_cm2_per_Vs": 400,
                "mu_p_cm2_per_Vs": 200,
                "tau_n_s": 1e-8,
                "tau_p_s": 1e-8,
                "n1_p1_cm-3": 1.0e10,
                "N_A_cm-3": "1e18 for x < 0.5e-5 cm",
                "N_D_cm-3": "1e18 for x > 0.5e-5 cm",
                "contacts": "ohmic (equilibrium carriers), top at x = 0 biased, bot at x = 1e-5 cm grounded",
                "mesh_cm": "1D, spacing 1e-7 at both contacts, 1e-9 at the junction (geometric grading), divided by refine",
                "source": "devsim python_packages/simple_physics.py constants and SetSiliconParameters (devsim 2.11.2 "
                "wheel); diode_common.py SetNetDoping, CreateMesh @e3a25f0; diode_1d.py tau override",
            },
        },
        extra_versions={"devsim": getattr(__import__("devsim"), "__version__", "2.11.2")},
        command="cd validation && uv run python c/gen_devsim.py",
    )
    for t in tg:
        pr = t["precision"]
        print(
            t["metric_id"],
            t["value"],
            "p",
            round(pr["observed_order"], 2),
            "cont",
            pr["current_continuity_max_rel"],
            "golden rel",
            t["source"]["rel_diff"],
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
