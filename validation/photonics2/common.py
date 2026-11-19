# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared helpers of the photonics-examples-2 reference scripts (DevLog-062): expected-JSON writer (amp-eval-expected/0)."""

from __future__ import annotations

import datetime as _dt
import json
import platform
import sys
from pathlib import Path

import mpmath
import numpy
import scipy

ROOT = Path(__file__).resolve().parents[2]
EXP = ROOT / "eval" / "expected"


def write_expected(case: str, generator: str, command: str, method: str, targets: list[dict], inputs: dict | None = None) -> Path:
    doc: dict = {
        "schema": "amp-eval-expected/0",
        "case": case,
        "class": "c",
        "generator": generator,
        "command": command,
        "method": method,
        "generated_at": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "versions": {"python": sys.version.split()[0], "numpy": numpy.__version__, "scipy": scipy.__version__, "mpmath": mpmath.__version__},
        "platform": {"system": platform.system(), "machine": platform.machine(), "python_impl": platform.python_implementation().lower()},
        "targets": targets,
    }
    if inputs:
        doc["inputs"] = inputs
    p = EXP / f"{case}.json"
    p.write_text(json.dumps(doc, indent=2) + "\n")
    return p
