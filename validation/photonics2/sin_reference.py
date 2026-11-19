# SPDX-License-Identifier: GPL-3.0-or-later
"""Reference of WO-89 (sims/sin-strip.yaml): measured TE group index of the 300 nm LPCVD Si3N4 platform of P. Munoz et al.,
Sensors 17(9), 2088 (2017), doi 10.3390/s17092088 (open access, PMC5620990, read 2026-11-18), s.3.4: OFDR 1.892 (TE;
TM 1.717), 80 nm scan centred at 1555 nm; MZI 1.90-1.92 (TE). Measured values: informative only.
Writes eval/expected/WO-89.json. Run: cd validation && uv run python photonics2/sin_reference.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, write_expected  # noqa: E402


def main() -> int:
    targets = [{"metric_id": "ng_0", "value": 1.892, "unit": "1",
                "precision": {"method": "measured (optical frequency-domain reflectometry), TE", "other_measurement": "MZI 1.90-1.92 (TE)",
                              "locator": "Munoz et al. 2017 s.3.4"}}]
    p = write_expected("WO-89", "validation/photonics2/sin_reference.py", "cd validation && uv run python photonics2/sin_reference.py",
                       "measured group index (Munoz et al., Sensors 17, 2088 (2017), s.3.4); no computation", targets)
    print("wrote", p.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
