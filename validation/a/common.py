# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared helpers for class-a generators: expected-JSON writer, versions, constants.

Every generator calls `write_expected(case_id, targets, ...)`, which writes eval/expected/<ID>.json with the
value of each target, the generator path, package versions, an ISO timestamp and the precision record.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import platform
import re
import sys
from pathlib import Path
from typing import Any

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

import mpmath  # noqa: E402
import numpy  # noqa: E402
import scipy  # noqa: E402
import scipy.constants as sc  # noqa: E402
import yaml  # noqa: E402

VALIDATION_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = VALIDATION_DIR.parent
# AMP_EXPECTED_DIR redirects output (used by run_all.py --check to regenerate into a scratch directory)
EXPECTED_DIR = Path(os.environ.get("AMP_EXPECTED_DIR", REPO_ROOT / "eval" / "expected"))
CASES_DIR = REPO_ROOT / "eval" / "cases" / "a"

# Physical constants: scipy.constants (CODATA set reported in every JSON). c, e, k_B, N_A are exact in SI 2019.
C0 = sc.c
MU0 = sc.mu_0
EPS0 = sc.epsilon_0
ETA0 = math.sqrt(MU0 / EPS0)
Q_E = sc.e
K_B = sc.k
N_A = sc.N_A
SIGMA_SB = sc.Stefan_Boltzmann


# metric_id grammar (proposal to L8): ASCII letters, digits, '_', '.', '+', '-'; starts with a letter.
METRIC_ID_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.+-]*")


def versions() -> dict[str, str]:
    return {
        "python": platform.python_version(),
        "numpy": numpy.__version__,
        "scipy": scipy.__version__,
        "mpmath": mpmath.__version__,
        "pyyaml": yaml.__version__,
        "codata": _codata_label(),
    }


def _codata_label() -> str:
    # scipy.constants documents its CODATA edition; mu_0 value identifies it (2018 and 2022 differ in mu_0).
    return f"scipy.constants mu_0={MU0!r}"


def iso_now() -> str:
    return _dt.datetime.now(_dt.UTC).astimezone().isoformat(timespec="seconds")


def rel(a: float, b: float) -> float:
    return abs(a - b) / abs(b) if b != 0 else abs(a - b)


def r3_compare(value: float, r3_text: str | None, digits_note: str = "") -> dict[str, Any]:
    """Agreement record vs the value R3 states, given as R3's literal text (e.g. "36.60", keeps trailing zeros).

    'agree' means |value - R3| <= half a unit in the last digit R3 gives."""
    if r3_text is None:
        return {"r3_value": None, "agreement": "n/a (R3 gives no value)"}
    r3_value = float(r3_text)
    r = rel(value, r3_value)
    mant = r3_text.lower().split("e")[0].replace("-", "").replace("+", "").replace(".", "").lstrip("0")
    sig = max(len(mant), 1)
    # Agreement at R3's stated precision: |v - r3| <= half a unit in the last digit R3 gives.
    last_digit = 10 ** (math.floor(math.log10(abs(r3_value))) - sig + 1)
    agree = abs(value - r3_value) <= 0.5 * last_digit * (1 + 1e-9)
    return {
        "r3_value": r3_text,
        "rel_diff": r,
        "agreement": "agree" if agree else "disagree",
        "note": digits_note or f"compared at R3's {sig} significant digits",
    }


def write_expected(
    case_id: str,
    targets: list[dict[str, Any]],
    generator: str,
    method: str,
    extra: dict[str, Any] | None = None,
) -> Path:
    EXPECTED_DIR.mkdir(parents=True, exist_ok=True)
    rec: dict[str, Any] = {
        "schema": "amp-eval-expected/0",
        "case": case_id,
        "class": "a",
        "generator": generator,
        "command": f"cd validation && uv run python {generator.removeprefix('validation/')}",
        "method": method,
        "generated_at": iso_now(),
        "versions": versions(),
        "platform": {"system": platform.system(), "machine": platform.machine(),
                     "python_impl": sys.implementation.name},
        "targets": targets,
    }
    if extra:
        rec.update(extra)
    path = EXPECTED_DIR / f"{case_id}.json"
    path.write_text(json.dumps(rec, indent=2, default=_json_default) + "\n")
    return path


def _json_default(o: Any) -> Any:
    if isinstance(o, numpy.generic):
        return o.item()
    if isinstance(o, numpy.ndarray):
        return o.tolist()
    if isinstance(o, mpmath.mpf):
        return float(o)
    raise TypeError(type(o))


def target(
    metric_id: str,
    value: float,
    unit: str,
    precision: dict[str, Any],
    r3: dict[str, Any] | None = None,
    **kw: Any,
) -> dict[str, Any]:
    if not METRIC_ID_RE.fullmatch(metric_id):
        raise ValueError(f"metric_id {metric_id!r} violates the grammar {METRIC_ID_RE.pattern}")
    t: dict[str, Any] = {"metric_id": metric_id, "value": value, "unit": unit, "precision": precision}
    if r3 is not None:
        t["r3"] = r3
    t.update(kw)
    return t
