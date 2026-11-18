# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared helpers for the packaging reference scripts (lane E3, DevLog-049): expected-JSON writer (class c, the
validation/c/common_c.py writer) and the library inputs used by the sims (values evaluated by @amp/materials at
298.15 K; source leaves named in each sim's provenance)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "c"))
from common_c import write_expected  # noqa: E402

__all__ = ["write_expected", "LIB"]

# @amp/materials getProperty(id, prop, {T: 298.15}) on 2026-11-18 (SI). E, nu of silicon: Voigt-Reuss-Hill average
# of the Hall 1967 C (materials/silicon.yaml, derived). Copper alpha: NIST cryogenic OFHC fit at 298.15 K.
LIB = {
    "silicon": {"E": 162.58e9, "nu": 0.2231, "alpha": 2.600985401459854e-6, "k": 149.038},
    "copper": {"E": 123.5e9, "nu": 0.35, "alpha": 1.6581238447607446e-5, "k": 401.004},
}
