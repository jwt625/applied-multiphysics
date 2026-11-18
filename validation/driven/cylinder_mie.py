# SPDX-License-Identifier: GPL-3.0-or-later
"""Reference scattering widths for the cylinder examples (Si nanowire in air, PEC post), DevLog-047.

Plane wave u_inc = U0 exp(-j k0 x) (time convention exp(+j omega t)) on an infinite circular cylinder of radius a in
vacuum, TM polarization (u = E_z). Jacobi-Anger: exp(-j k rho cos phi) = sum_n j^-n J_n(k rho) exp(j n phi).
Scattered field u_s = U0 sum_n j^-n c_n H_n^(2)(k0 rho) exp(j n phi) with
  PEC (E_z = 0 on rho = a):            c_n = -J_n(k0 a) / H_n(k0 a)
    (Balanis, Advanced Engineering Electromagnetics, 2nd ed. 2012, sec. 11.5.1, TM^z)
  dielectric (eps_r = n^2, mu_r = 1):   continuity of E_z and dE_z/drho at rho = a (TM, a = 1/mu_r = 1 on both sides),
    inside d_n J_n(k1 rho), k1 = n k0:
    c_n = (k1 J_n(k0a) J_n'(k1a) - k0 J_n'(k0a) J_n(k1a)) / (k0 H_n'(k0a) J_n(k1a) - k1 H_n(k0a) J_n'(k1a))
Far field (H_n^(2)(x) ~ sqrt(2/(pi x)) exp(-j(x - n pi/2 - pi/4))): sigma_2D(phi) = (4/k0) |sum_n c_n exp(j n phi)|^2
(forward phi = 0, back phi = pi); total W_s = (4/k0) sum |c_n|^2 = (1/2pi) int sigma_2D dphi, which is what the engine's
`sigma2d_total` reports (mean of sigma_2D over 360 angles). Optical theorem (lossless): -(4/k0) Re sum c_n = W_s.

Independent routes: scipy.special (double) and mpmath (50 digits) must agree to 1e-12 relative; the optical theorem
must hold to 1e-12. The derivation of the penetrable coefficients is the reference for that formula (continuity
conditions above); it is the same form as validation/wave2d/cylinder_series.py, recomputed here for the example
geometries (that script is read only and fixed to k0 a = pi).

Output: eval/expected/WO-70.json and eval/expected/RF-70.json, plus validation/driven/cylinder_spectra.json (spectra
for the DevLog plots). Run: cd validation && OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 uv run python driven/cylinder_mie.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import mpmath as mp
import numpy as np
from scipy import special as sp

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common_driven import EXP, write_expected  # noqa: E402

mp.mp.dps = 50
NMAX = 40
C0 = 299792458.0  # m/s, SI defining constant (exact)

# Example inputs (must equal the sims): see sims/si-nanowire-scattering.yaml and sims/pec-post-scattering.yaml
N_SI = 3.4767  # materials/silicon.yaml n (Li 1980) at 1.55 um, 3.476687 rounded to 4 decimals (2026-11-18)
A_SI = 0.3e-6  # m, rod radius (modelling input)
LAMS_SI = [1.3e-6, 1.55e-6, 1.8e-6]  # m, gated wavelengths (multi-wavelength study `spec3` of the sim)
SWEEP_SI = [round(1.2e-6 + 0.05e-6 * i, 12) for i in range(17)]  # 1.20 ... 2.00 um, the sim's parametric sweep
F_PEC = 10e9  # Hz (modelling input)
A_PEC = 15e-3  # m, post radius (modelling input)


def coeffs_scipy(k0: float, a: float, n1: float | None) -> np.ndarray:
    n = np.arange(-NMAX, NMAX + 1)
    x0 = k0 * a
    J, Jp = sp.jv(n, x0), sp.jvp(n, x0)
    H, Hp = sp.hankel2(n, x0), sp.h2vp(n, x0)
    if n1 is None:
        return -J / H
    k1 = k0 * n1
    x1 = k1 * a
    J1, J1p = sp.jv(n, x1), sp.jvp(n, x1)
    return (k1 * J * J1p - k0 * Jp * J1) / (k0 * Hp * J1 - k1 * H * J1p)


def coeffs_mpmath(k0: float, a: float, n1: float | None) -> list[complex]:
    out = []
    x0 = mp.mpf(k0) * mp.mpf(a)
    for n in range(-NMAX, NMAX + 1):
        J, Jp = mp.besselj(n, x0), mp.besselj(n, x0, derivative=1)
        Y, Yp = mp.bessely(n, x0), mp.bessely(n, x0, derivative=1)
        H, Hp = J - 1j * Y, Jp - 1j * Yp
        if n1 is None:
            out.append(complex(-J / H))
            continue
        k1 = mp.mpf(k0) * mp.mpf(n1)
        x1 = k1 * mp.mpf(a)
        J1, J1p = mp.besselj(n, x1), mp.besselj(n, x1, derivative=1)
        c = (k1 * J * J1p - mp.mpf(k0) * Jp * J1) / (mp.mpf(k0) * Hp * J1 - k1 * H * J1p)
        out.append(complex(c))
    return out


def widths(c, k0: float) -> dict[str, float]:
    n = np.arange(-NMAX, NMAX + 1)
    c = np.asarray(c, dtype=complex)
    fwd = 4 / k0 * abs(np.sum(c)) ** 2
    back = 4 / k0 * abs(np.sum(c * np.exp(1j * n * math.pi))) ** 2
    tot = 4 / k0 * float(np.sum(np.abs(c) ** 2))
    ext = -4 / k0 * float(np.real(np.sum(c)))
    return {"back": back, "fwd": fwd, "total": tot, "ext": ext}


def case(k0: float, a: float, n1: float | None) -> dict[str, float]:
    s = widths(coeffs_scipy(k0, a, n1), k0)
    m = widths(coeffs_mpmath(k0, a, n1), k0)
    agree = max(abs(s[k] / m[k] - 1) for k in ("back", "fwd", "total"))
    opt = abs(m["ext"] / m["total"] - 1)
    assert agree < 1e-12, f"scipy vs mpmath {agree}"
    assert opt < 1e-12, f"optical theorem {opt}"
    return {**m, "scipy_vs_mpmath": agree, "optical_theorem": opt}


def main() -> int:
    targets_wo, spectra = [], {"si_rod": [], "pec_post": []}
    for i, lam in enumerate(LAMS_SI):
        r = case(2 * math.pi / lam, A_SI, N_SI)
        for q in ("back", "fwd", "total"):
            targets_wo.append(
                {
                    "metric_id": f"sigma2d_{q}_{i}",
                    "value": r[q],
                    "unit": "m",
                    "precision": {
                        "method": f"Bessel series n = -{NMAX}..{NMAX}, mpmath 50 digits",
                        "scipy_vs_mpmath": r["scipy_vs_mpmath"],
                        "optical_theorem_rel": r["optical_theorem"],
                    },
                    "inputs": {"lambda0_m": lam, "radius_m": A_SI, "n_rod": N_SI, "background": "vacuum"},
                    "locator": "validation/driven/cylinder_mie.py (penetrable coefficients from the TM continuity conditions)",
                }
            )
    for lam in SWEEP_SI:
        r = case(2 * math.pi / lam, A_SI, N_SI)
        spectra["si_rod"].append({"lambda0_m": lam, "sigma2d_back_m": r["back"], "sigma2d_fwd_m": r["fwd"], "sigma2d_total_m": r["total"]})
    write_expected(
        "WO-70",
        "validation/driven/cylinder_mie.py",
        "cd validation && uv run python driven/cylinder_mie.py",
        "TM plane wave on a dielectric rod (n 3.4767, radius 0.3 um) in vacuum at 1.3, 1.55, 1.8 um: 2D scattering "
        "width back, forward and total from the Bessel / Hankel series (scipy vs mpmath, optical theorem).",
        targets_wo,
    )
    k0 = 2 * math.pi * F_PEC / C0
    r = case(k0, A_PEC, None)
    targets_rf = [
        {
            "metric_id": f"sigma2d_{q}",
            "value": r[q],
            "unit": "m",
            "precision": {"method": f"Bessel series n = -{NMAX}..{NMAX}, mpmath 50 digits", "scipy_vs_mpmath": r["scipy_vs_mpmath"], "optical_theorem_rel": r["optical_theorem"]},
            "inputs": {"f_Hz": F_PEC, "radius_m": A_PEC, "k0a": k0 * A_PEC},
            "locator": "Balanis, Advanced Engineering Electromagnetics, 2nd ed. (2012), sec. 11.5.1 (TM^z PEC cylinder); validation/driven/cylinder_mie.py",
        }
        for q in ("back", "fwd", "total")
    ]
    for f in [6e9 + 1e9 * i for i in range(9)]:
        kk = 2 * math.pi * f / C0
        rr = case(kk, A_PEC, None)
        spectra["pec_post"].append({"f_Hz": f, "sigma2d_back_m": rr["back"], "sigma2d_fwd_m": rr["fwd"], "sigma2d_total_m": rr["total"]})
    write_expected(
        "RF-70",
        "validation/driven/cylinder_mie.py",
        "cd validation && uv run python driven/cylinder_mie.py",
        "TM plane wave on a PEC circular cylinder (radius 15 mm) at 10 GHz in vacuum: 2D scattering width back, forward "
        "and total from the Bessel / Hankel series (scipy vs mpmath, optical theorem).",
        targets_rf,
    )
    (Path(__file__).resolve().parent / "cylinder_spectra.json").write_text(json.dumps(spectra, indent=1) + "\n")
    for t in targets_wo + targets_rf:
        print(t["metric_id"], t["value"])
    print("wrote", EXP / "WO-70.json", EXP / "RF-70.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
