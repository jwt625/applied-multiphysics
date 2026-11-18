# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared writer of eval/expected/<ID>.json (amp-eval-expected/0) for the driven-wave reference scripts (DevLog-047)."""

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


def write_expected(case: str, generator: str, command: str, method: str, targets: list[dict]) -> Path:
    doc = {
        "schema": "amp-eval-expected/0",
        "case": case,
        "class": "c" if case != "AC-01" else "b",
        "generator": generator,
        "command": command,
        "method": method,
        "generated_at": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "versions": {
            "python": sys.version.split()[0],
            "numpy": numpy.__version__,
            "scipy": scipy.__version__,
            "mpmath": mpmath.__version__,
        },
        "platform": {"system": platform.system(), "machine": platform.machine(), "python_impl": platform.python_implementation().lower()},
        "targets": targets,
    }
    p = EXP / f"{case}.json"
    p.write_text(json.dumps(doc, indent=2) + "\n")
    return p
