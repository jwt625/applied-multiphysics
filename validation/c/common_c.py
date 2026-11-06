# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared helpers for class-c generators (lane L7c, DevLog-008).

Writes eval/expected/<ID>.json in the `amp-eval-expected/0` format (same keys as the class-a writer in
validation/a/common.py, written independently here so lane L7a's file stays untouched), with `class: c`,
the generator path, the command, package versions, an ISO timestamp and, per target, the value, the
unit, a precision record and the agreement with the value the cited source states.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import platform
import sys
from pathlib import Path
from typing import Any

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy  # noqa: E402
import scipy  # noqa: E402
import scipy.constants as sc  # noqa: E402

VALIDATION_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = VALIDATION_DIR.parent
EXPECTED_DIR = Path(os.environ.get("AMP_EXPECTED_DIR", REPO_ROOT / "eval" / "expected"))
CACHE_DIR = REPO_ROOT / "cache" / "eval-c"

C0 = sc.c
MU0 = sc.mu_0
EPS0 = sc.epsilon_0
ETA0 = math.sqrt(MU0 / EPS0)


def versions(extra: dict[str, str] | None = None) -> dict[str, str]:
    v = {
        "python": platform.python_version(),
        "numpy": numpy.__version__,
        "scipy": scipy.__version__,
        "codata": f"scipy.constants mu_0={MU0!r}",
    }
    if extra:
        v.update(extra)
    return v


def iso_now() -> str:
    return _dt.datetime.now(_dt.UTC).astimezone().isoformat(timespec="seconds")


def rel(a: float, b: float) -> float:
    return abs(a - b) / abs(b) if b != 0 else abs(a - b)


def source_compare(value: float, src_text: str | None, scale: float = 1.0, note: str = "") -> dict[str, Any]:
    """Agreement with the value the cited source prints (literal text, in the source's unit; value/scale is
    compared). 'agree' = within half a unit in the last printed digit."""
    if src_text is None:
        return {"source_value": None, "agreement": "n/a (source prints no value)"}
    s = float(src_text)
    v = value / scale
    mant = src_text.lower().split("e")[0].replace("-", "").replace("+", "").replace(".", "").lstrip("0")
    sig = max(len(mant), 1)
    last = 10 ** (math.floor(math.log10(abs(s))) - sig + 1) if s != 0 else 0.0
    agree = abs(v - s) <= 0.5 * last * (1 + 1e-9)
    return {
        "source_value": src_text,
        "rel_diff": rel(v, s),
        "agreement": "agree" if agree else "disagree",
        "note": note or f"compared at the source's {sig} significant digits",
    }


def target(
    metric_id: str, value: float, unit: str, precision: dict[str, Any], source: dict[str, Any] | None = None, **kw: Any
) -> dict[str, Any]:
    t: dict[str, Any] = {"metric_id": metric_id, "value": value, "unit": unit, "precision": precision}
    if source is not None:
        t["source"] = source
    t.update(kw)
    return t


def write_expected(
    case_id: str,
    targets: list[dict[str, Any]],
    generator: str,
    method: str,
    extra: dict[str, Any] | None = None,
    extra_versions: dict[str, str] | None = None,
    command: str | None = None,
) -> Path:
    EXPECTED_DIR.mkdir(parents=True, exist_ok=True)
    rec: dict[str, Any] = {
        "schema": "amp-eval-expected/0",
        "case": case_id,
        "class": "c",
        "generator": generator,
        "command": command or f"cd validation && uv run python {generator.removeprefix('validation/')}",
        "method": method,
        "generated_at": iso_now(),
        "versions": versions(extra_versions),
        "platform": {
            "system": platform.system(),
            "machine": platform.machine(),
            "python_impl": sys.implementation.name,
        },
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
    if isinstance(o, complex):
        return {"re": o.real, "im": o.imag}
    raise TypeError(type(o))
