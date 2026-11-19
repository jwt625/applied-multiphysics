# SPDX-License-Identifier: GPL-3.0-or-later
"""References of WO-74 (sims/si-grating-coupler-2d.yaml), uniform SOI grating coupler in 2D.

1. Input-waveguide mode: exact TE (E_z out of plane) dispersion of the port cross-section of the sim, oxide 1.5 um /
   Si 220 nm / air 1.5 um with zero normal derivative of E_z at both ends (the emw-2d natural wall), by a transfer
   matrix on (E, dE/dy); mpmath (40 digits) vs scipy brentq; the semi-infinite (open) slab value is reported too.
   The paper quotes n_eff 2.83 for this slab (p.6072, two decimals).
2. Poynting balance: the net power out of the closed rectangle formed by the two horizontal flux lines and the two
   vertical lines near the ports is 0 (lossless interior, Poynting theorem): reference value 0.
3. Upward fraction vs Taillaert et al. 2006 Fig. 3 "power up" (digitized: photonics2/taillaert2006_fig3.json), at the
   wavelengths where the curve was read.

Writes eval/expected/WO-74.json. Run: cd validation && uv run python photonics2/gc_reference.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import mpmath as mp
from scipy.optimize import brentq

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, write_expected  # noqa: E402

HERE = Path(__file__).resolve().parent
N_SI, N_OX, N_AIR = 3.47, 1.44, 1.0
T_SI = 220e-9
D_OX, D_AIR = 1.5e-6, 1.5e-6        # t_box + t_sub below the core at the port; h_air above (sim params)
FIG_LAMS = [1540.0, 1550.0, 1570.0, 1600.0, 1610.0]


def residual(lib, neff, lam, closure):
    """TE: E'' + (k0^2 n^2 - beta^2) E = 0, E and E' continuous. Start in the oxide at its far end."""
    k0 = 2 * lib.pi / lam
    b2 = (k0 * neff) ** 2
    g_ox = lib.sqrt(b2 - (k0 * N_OX) ** 2)
    if closure == "open":
        e, de = 1, g_ox                                  # decaying into the oxide (growing towards the core)
    else:                                                # E' = 0 at the far oxide end, propagate through the oxide
        e, de = lib.cosh(g_ox * D_OX), g_ox * lib.sinh(g_ox * D_OX)
    k = lib.sqrt((k0 * N_SI) ** 2 - b2)
    e, de = e * lib.cos(k * T_SI) + de / k * lib.sin(k * T_SI), -k * e * lib.sin(k * T_SI) + de * lib.cos(k * T_SI)
    g_a = lib.sqrt(b2 - (k0 * N_AIR) ** 2)
    if closure == "open":
        return (de + g_a * e) / g_a                      # decaying into the air: E' = -g E
    # E' = 0 at y = D_AIR into the air: E(y) = e cosh + de/g sinh -> E'(D) = e g sinh + de cosh, scaled
    return (e * g_a * lib.sinh(g_a * D_AIR) + de * lib.cosh(g_a * D_AIR)) * lib.exp(-g_a * D_AIR - g_ox * D_OX) / g_a


def slab_neff(lam: float, closure: str) -> tuple[float, float]:
    r_d = brentq(lambda x: residual(math, x, lam, closure), 2.0, N_SI - 1e-6, xtol=1e-15, rtol=1e-15)
    mp.mp.dps = 40
    r_m = mp.findroot(lambda x: residual(mp, x, mp.mpf(lam), closure), (mp.mpf(2.0), mp.mpf(N_SI) - mp.mpf("1e-6")), solver="illinois")
    return float(r_m), r_d


def main() -> int:
    targets = []
    for cl in ("walled", "open"):
        rm, rd = slab_neff(1.55e-6, cl)
        print(f"slab TE0 1.55 um {cl:6s}: mpmath {rm:.15f} scipy {rd:.15f} diff {abs(rm - rd):.1e}")
        assert abs(rm - rd) < 1e-13
        if cl == "walled":
            walled = rm
        else:
            opened = rm
    targets.append({"metric_id": "neff_1_0", "value": walled, "unit": "1",
                    "precision": {"method": "mpmath 40 digits vs scipy", "open_slab_value": opened, "paper_value": 2.83,
                                  "paper_locator": "Taillaert 2006 p.6072: fundamental TE mode 2.83"}})
    targets.append({"metric_id": "balance", "value": 0.0, "unit": "1", "precision": {"method": "exact (Poynting theorem, lossless interior)"}})
    dig = json.loads((HERE / "taillaert2006_fig3.json").read_text())
    for p in dig["points"]:
        if p["lambda_nm"] in FIG_LAMS and p["value"] is not None:
            targets.append({"metric_id": f"up_{int(p['lambda_nm'])}", "value": p["value"], "unit": "1", "lambda_read_nm": p["lambda_read_nm"],
                            "precision": {"resolution": p["resolution"], "line_extent": p["line_extent"], "method": "digitized (photonics2/digitize_taillaert.py)"}})
    method = ("TE slab dispersion of the port cross-section (exact, walls as in the sim); Poynting balance 0 (exact); upward fraction "
              "digitized from Taillaert et al., Jpn. J. Appl. Phys. 45, 6071 (2006), Fig. 3 (2D eigenmode expansion with PML)")
    out = write_expected("WO-74", "validation/photonics2/gc_reference.py", "cd validation && uv run python photonics2/gc_reference.py", method, targets,
                         {"digitized": "validation/photonics2/taillaert2006_fig3.json"})
    for t in targets:
        print(t["metric_id"], t["value"], t.get("lambda_read_nm", ""))
    print("wrote", out.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
