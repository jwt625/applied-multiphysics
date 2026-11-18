# SPDX-License-Identifier: GPL-3.0-or-later
"""Reference reflection / transmission of the quarter-wave Bragg mirror example (sims/bragg-mirror-ports.yaml), DevLog-047.

Model: SiO2 (n_L) | (H L)^(N-1) H | SiO2, H = Si3N4 (n_H), quarter-wave thicknesses t_H = lam_B / (4 n_H),
t_L = lam_B / (4 n_L), N = 6 high-index layers; input and output SiO2 sections of length L_in, L_out between the port
planes and the stack. The 2D example is a channel of height H_ch with natural (PMC for E_z) walls, so every port mode is
cos(m pi y / H_ch) in every layer and the problem separates exactly: mode m sees a 1D stack with
k_x,j = sqrt((k0 n_j)^2 - (m pi / H_ch)^2) (m = 0: normal incidence; m = 1: a plane wave at sin(theta) = pi / (H_ch k0 n_L)
in SiO2, s-polarised since E = E_z is normal to the plane of incidence).

TM, u = E_z, a = 1/mu_r = 1: u and du/dx continuous. Time convention exp(+j omega t); incident u = exp(-j kx x).
  route 1, transfer (characteristic) matrix of (u, du/dx) through each layer of thickness d and wavenumber k:
      [[cos kd, sin(kd)/k], [-k sin kd, cos kd]]  (Born and Wolf, Principles of Optics, 7th ed., sec. 1.6.2, in the
      (u, u') form); solve for r, t with u = e^{-jkx} + r e^{jkx} at x = 0 and t e^{-jk(x - L)} at x = L.
  route 2, admittance recursion: gamma = u'/u starts at the output plane as -j k_out (outgoing wave only) and is carried
      back through each layer with the inverse layer matrix, (u, u')(x0) = [[cos kd, -sin(kd)/k], [k sin kd, cos kd]]
      (u, u')(x0 + d) (the lossless-line input-impedance relation, Pozar, Microwave Engineering, 4th ed., sec. 2.3, in
      admittance form); at x = 0, r = (gamma0 + j k) / (j k - gamma0). Route 2 gives r only (independent of route 1).
  route 3 (one point): quarter-wave stack at lam_B, normal incidence, n_0 = n_s = n_L:
      R = ((1 - (n_H/n_L)^(2N)) / (1 + (n_H/n_L)^(2N)))^2 (Macleod, Thin-Film Optical Filters, 4th ed. 2010, ch. 6,
      quarter-wave stack; derived here from the quarter-wave characteristic matrix [[0, j/n], [j n, 0]]).
Routes 1 and 2 must agree to 1e-12 in r; route 3 to 1e-12 in R; |r|^2 + |t|^2 = 1 to 1e-12.

The engine's S-parameters are referred to the port planes (x = 0 and x = L) and power-normalised; both ports are in
SiO2, so S11 = r and |S21| = |t| for each mode. Gated on magnitudes (the port mode sign, hence the phase of S21, is
a normalisation choice).

Output: eval/expected/WO-71.json and validation/driven/bragg_spectrum.json.
Run: cd validation && OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 uv run python driven/bragg_tmm.py
"""

from __future__ import annotations

import cmath
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common_driven import write_expected  # noqa: E402

# inputs (must equal sims/bragg-mirror-ports.yaml)
N_H = 1.9963  # materials/si3n4-lpcvd.yaml n at 1.55 um (1.996280, rounded to 4 decimals), 2026-11-18
N_L = 1.4444  # materials/sio2-thermal-oxide.yaml n (Malitson 1965) at 1.55 um (1.444423, rounded), 2026-11-18
LAM_B = 1.55e-6  # m, design (Bragg) wavelength (modelling input)
N_PAIRS = 6  # high-index layers (modelling input)
L_IN = 0.6e-6  # m (modelling input)
L_OUT = 0.6e-6  # m (modelling input)
H_CH = 1.0e-6  # m, channel height (modelling input; sets the oblique mode angle)
LAMS = [1.30e-6, 1.45e-6, 1.55e-6, 1.70e-6, 1.85e-6]  # gated wavelengths
SWEEP = [round(1.2e-6 + 0.025e-6 * i, 12) for i in range(33)]  # 1.200 ... 2.000 um, the sim's parametric sweep


def layers() -> list[tuple[float, float]]:
    """(n, thickness) from x = 0 to x = L, input / output SiO2 included."""
    tH, tL = LAM_B / (4 * N_H), LAM_B / (4 * N_L)
    out = [(N_L, L_IN)]
    for k in range(N_PAIRS):
        out.append((N_H, tH))
        if k < N_PAIRS - 1:
            out.append((N_L, tL))
    out.append((N_L, L_OUT))
    return out


def kx(n: float, k0: float, ky: float) -> complex:
    v = (k0 * n) ** 2 - ky**2
    return math.sqrt(v) if v >= 0 else -1j * math.sqrt(-v)


def route1(lam: float, m: int) -> tuple[complex, complex]:
    k0, ky = 2 * math.pi / lam, m * math.pi / H_CH
    M = np.eye(2, dtype=complex)
    for n, d in layers():
        k = kx(n, k0, ky)
        c, s = cmath.cos(k * d), cmath.sin(k * d)
        M = np.array([[c, s / k], [-k * s, c]]) @ M
    k_in = kx(N_L, k0, ky)
    # state at 0: (1 + r, -j k (1 - r)); at L: (t, -j k t); M (state0) = stateL
    a = M @ np.array([1, -1j * k_in])
    b = M @ np.array([1, 1j * k_in])
    # a + r b = t (1, -j k)
    A = np.array([[b[0], -1], [b[1], 1j * k_in]])
    r, t = np.linalg.solve(A, -a)
    return complex(r), complex(t)


def route2(lam: float, m: int) -> complex:
    k0, ky = 2 * math.pi / lam, m * math.pi / H_CH
    gam = -1j * kx(N_L, k0, ky)  # outgoing wave at the output plane: u' / u = -j k
    for n, d in reversed(layers()):
        k = kx(n, k0, ky)
        # transport u'/u backwards by d: u(x0) and u'(x0) from the inverse layer matrix
        c, s = cmath.cos(k * d), cmath.sin(k * d)
        u, up = c * 1 - s / k * gam, k * s * 1 + c * gam
        gam = up / u
    kin = kx(N_L, k0, ky)
    return (gam + 1j * kin) / (1j * kin - gam)


def quarter_wave_R() -> float:
    q = (N_H / N_L) ** (2 * N_PAIRS)
    return ((1 - q) / (1 + q)) ** 2


def main() -> int:
    targets, spec = [], []
    worst = 0.0
    for lam in sorted(set(LAMS + SWEEP)):
        row = {"lambda0_m": lam}
        for m in (0, 1):
            r, t = route1(lam, m)
            r2 = route2(lam, m)
            worst = max(worst, abs(r - r2), abs(abs(r) ** 2 + abs(t) ** 2 - 1))
            row[f"R_mode{m}"], row[f"T_mode{m}"] = abs(r) ** 2, abs(t) ** 2
            if lam in LAMS:
                tag = f"l{round(lam * 1e9)}"
                for nm, v in ((f"S11{'' if m == 0 else '_11'}_abs", abs(r)), (f"S21{'' if m == 0 else '_11'}_abs", abs(t))):
                    targets.append(
                        {
                            "metric_id": f"{nm}.{tag}",
                            "value": v,
                            "unit": "1",
                            "precision": {"method": "transfer matrix (route 1) vs admittance recursion (route 2)", "route_agreement": abs(r - r2)},
                            "inputs": {"lambda0_m": lam, "port_mode": m, "angle_in_SiO2_deg": math.degrees(math.asin(m * math.pi / H_CH / (2 * math.pi / lam * N_L)))},
                            "locator": "validation/driven/bragg_tmm.py routes 1 and 2",
                        }
                    )
        spec.append(row)
    assert worst < 1e-12, worst
    r0, _ = route1(LAM_B, 0)
    qw = quarter_wave_R()
    assert abs(abs(r0) ** 2 - qw) < 1e-12, (abs(r0) ** 2, qw)
    targets.append(
        {
            "metric_id": "R_quarter_wave",
            "value": qw,
            "unit": "1",
            "precision": {"method": "closed form", "vs_route1": abs(abs(r0) ** 2 - qw)},
            "inputs": {"lambda0_m": LAM_B, "N": N_PAIRS, "n_H": N_H, "n_L": N_L},
            "locator": "Macleod, Thin-Film Optical Filters, 4th ed. (2010), ch. 6 (quarter-wave stack); derivation in the script header",
        }
    )
    write_expected(
        "WO-71",
        "validation/driven/bragg_tmm.py",
        "cd validation && uv run python driven/bragg_tmm.py",
        "Quarter-wave Si3N4 / SiO2 Bragg mirror (6 high-index layers, lam_B 1.55 um) between two SiO2 port sections in a "
        "channel with natural walls: |S11|, |S21| of port modes 0 (normal) and 1 (oblique) by the transfer matrix, "
        "cross-checked by an admittance recursion and the quarter-wave closed form.",
        targets,
    )
    (Path(__file__).resolve().parent / "bragg_spectrum.json").write_text(json.dumps(spec, indent=1) + "\n")
    print("route agreement / energy worst", worst, "R(lam_B)", qw)
    for t in targets:
        print(t["metric_id"], t["value"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
