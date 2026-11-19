# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared helpers for the packaging reference scripts, part 2 (lane G6, DevLog-063): the class-c expected-JSON writer
(validation/c/common_c.py) and physical constants as used by @amp/physics."""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "c"))
from common_c import write_expected  # noqa: E402

__all__ = ["write_expected", "MU0", "EPS0", "C0", "ETA0", "LIB"]

MU0, EPS0 = 1.25663706212e-6, 8.8541878128e-12  # CODATA 2018, as @amp/physics electrostatics
C0 = 1 / math.sqrt(MU0 * EPS0)
ETA0 = math.sqrt(MU0 / EPS0)

# Library values used by the sims (SI), evaluated by @amp/materials at 298.15 K where the leaf is a T table (same values
# as validation/pkg/common_pkg.py LIB); scalar leaves as stored. Source leaves are named in each sim's provenance.
LIB = {
    "silicon": {"k": 149.038, "E": 162.58e9, "nu": 0.2231, "alpha": 2.600985401459854e-6},
    "copper": {"k": 401.004, "E": 123.5e9, "nu": 0.35, "alpha": 1.6581238447607446e-5},
    "sac305": {"k": 61.0},
    "sio2": {"k": 1.38, "E": 73.0e9, "nu": 0.16, "alpha": 0.5e-6},
    "polyimide": {"eps_r": 2.9},
}
