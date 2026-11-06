# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-a EM and RF generators.

EM-01 coax line constants, EM-04 Helmholtz coil (exact loop field via elliptic integrals, exposed for field checks),
RF-02 WR-90 cutoffs and straight-section S-parameters, RF-04 thin half-wave dipole impedance,
RF-21 PEC cylindrical cavity closed forms (analytic twin of class-c RF-01; resolves the Palace TM010 digits).

Run: cd validation && uv run python a/gen_em.py
"""

from __future__ import annotations

import math

import mpmath as mp
import numpy as np
from common import C0, EPS0, ETA0, MU0, r3_compare, target, write_expected
from scipy.special import ellipe, ellipk, jn_zeros, jnp_zeros, sici

GEN = "validation/a/gen_em.py"
EULER_GAMMA = 0.57721566490153286061


# ---------------------------------------------------------------- EM-01 coax
def em01() -> None:
    a, b, er = 0.5e-3, 1.75e-3, 2.1
    ln = math.log(b / a)
    Z0 = ETA0 * ln / (2 * math.pi * math.sqrt(er))
    Cp = 2 * math.pi * EPS0 * er / ln
    Lp = MU0 * ln / (2 * math.pi)
    cf = {"method": "closed form"}
    write_expected(
        "EM-01",
        [target("Z0", Z0, "Ohm", cf, r3=r3_compare(Z0, "51.8334")),
         target("C_per_m", Cp, "F/m", cf, r3=r3_compare(Cp * 1e12, "93.2565", "compared in pF/m")),
         target("L_per_m", Lp, "H/m", cf, r3=r3_compare(Lp * 1e9, "250.5526", "compared in nH/m")),
         target("LC_over_mu0eps0epsr", Lp * Cp / (MU0 * EPS0 * er), "1", cf, locator="TEM identity, exactly 1"),
         target("Z0_from_sqrt_L_over_C", math.sqrt(Lp / Cp), "Ohm", cf)],
        GEN, "Coax TEM: Z0 = eta0 ln(b/a)/(2 pi sqrt(eps_r)), C' = 2 pi eps0 eps_r / ln(b/a), L' = mu0 ln(b/a)/(2 pi)",
        extra={"inputs": {"a_m": a, "b_m": b, "eps_r": er, "eta0_Ohm": ETA0}},
    )


# ---------------------------------------------------------------- EM-04 Helmholtz coil
def loop_field(rho, z, R: float, z0: float, current: float) -> tuple[np.ndarray, np.ndarray]:
    """(B_rho, B_z) in T of a circular filament loop radius R at height z0, current I, at points (rho, z).

    Smythe / Jackson closed form with complete elliptic integrals K(m), E(m), m = k^2 = 4 R rho / ((R + rho)^2 + dz^2).
    """
    rho = np.asarray(rho, dtype=float)
    dz = np.asarray(z, dtype=float) - z0
    s = (R + rho) ** 2 + dz**2
    m = 4 * R * rho / s
    K, E = ellipk(m), ellipe(m)
    d = (R - rho) ** 2 + dz**2
    pref = MU0 * current / (2 * math.pi * np.sqrt(s))
    Bz = pref * (K + (R * R - rho**2 - dz**2) / d * E)
    with np.errstate(invalid="ignore", divide="ignore"):
        Br = np.where(rho > 0, pref * dz / np.where(rho > 0, rho, 1.0) * (-K + (R * R + rho**2 + dz**2) / d * E), 0.0)
    return Br, Bz


def helmholtz_field(rho, z, R: float = 0.1, current: float = 1.0, turns: int = 1):
    """Helmholtz pair: loops at z = -R/2 and +R/2, same current. Origin at the centre."""
    Br1, Bz1 = loop_field(rho, z, R, -R / 2, current * turns)
    Br2, Bz2 = loop_field(rho, z, R, +R / 2, current * turns)
    return Br1 + Br2, Bz1 + Bz2


def em04() -> None:
    R, cur, N = 0.1, 1.0, 1
    I = cur  # noqa: E741
    B0 = (4 / 5) ** 1.5 * MU0 * N * I / R
    _, Bz_e = helmholtz_field(np.array([0.0]), np.array([0.0]), R, I, N)
    # On-axis exact derivatives with mpmath (Bz(z) = mu0 I R^2 / 2 * sum (R^2 + (z -+ R/2)^2)^(-3/2))
    mp.mp.dps = 40
    Rm = mp.mpf(R)

    def bz_axis(zz):
        return MU0 * I * N * Rm**2 / 2 * ((Rm**2 + (zz - Rm / 2) ** 2) ** -1.5 + (Rm**2 + (zz + Rm / 2) ** 2) ** -1.5)

    d2 = mp.diff(bz_axis, 0, 2)
    d4 = mp.diff(bz_axis, 0, 4)
    # Off-axis probe for field checks: 0.02 m off axis, 0.01 m above centre
    Br_p, Bz_p = helmholtz_field(np.array([0.02]), np.array([0.01]), R, I, N)
    # Uniformity: relative deviation of |B| from B0 on a sphere radius 0.1 R (max over 200 points)
    th = np.linspace(0, math.pi, 201)
    Brs, Bzs = helmholtz_field(0.1 * R * np.sin(th), 0.1 * R * np.cos(th), R, I, N)
    dev = float(np.max(np.abs(np.hypot(Brs, Bzs) - B0)) / B0)
    cf = {"method": "closed form"}
    write_expected(
        "EM-04",
        [target("B_center", B0, "T", {"method": "closed form", "elliptic_integral_value": float(Bz_e[0]),
                                      "diff": abs(float(Bz_e[0]) - B0)},
                r3=r3_compare(B0 * 1e6, "8.99176", "compared in uT"), locator="(0, 0)"),
         target("d2Bz_dz2_center", float(d2), "T/m^2", {"method": "mpmath numerical derivative, 40 digits"},
                locator="on axis at the centre; zero by construction"),
         target("d4Bz_dz4_center", float(d4), "T/m^4", {"method": "mpmath numerical derivative, 40 digits"},
                locator="on axis at the centre; leading non-uniformity term"),
         target("Br_probe", float(Br_p[0]), "T", cf, locator="(rho, z) = (0.02, 0.01) m"),
         target("Bz_probe", float(Bz_p[0]), "T", cf, locator="(rho, z) = (0.02, 0.01) m"),
         target("uniformity_sphere_0.1R", dev, "1", cf, locator="max | |B| - B0 | / B0 on a sphere radius 0.1 R")],
        GEN,
        "Helmholtz pair of filament loops, radius R, spacing R. B0 = (4/5)^(3/2) mu0 N I / R; off-axis field from "
        "the elliptic-integral loop formula (Smythe 1950 / Jackson 5.37 form).",
        extra={"inputs": {"R_m": R, "I_A": I, "N": N}, "field_function": "validation/a/fields.py:EM-04"},
    )


# ---------------------------------------------------------------- RF-02 WR-90
def rf02() -> None:
    a, b = 22.86e-3, 10.16e-3
    fc = {(m, n): C0 / 2 * math.sqrt((m / a) ** 2 + (n / b) ** 2) for m, n in [(1, 0), (2, 0), (0, 1), (1, 1)]}
    f, L = 10.0e9, 50.0e-3
    k0 = 2 * math.pi * f / C0
    beta = math.sqrt(k0**2 - (math.pi / a) ** 2)
    phase = -(beta * L)
    cf = {"method": "closed form"}
    write_expected(
        "RF-02",
        [target("fc_TE10", fc[(1, 0)], "Hz", cf, r3=r3_compare(fc[(1, 0)] / 1e9, "6.55714", "compared in GHz")),
         target("fc_TE20", fc[(2, 0)], "Hz", cf, r3=r3_compare(fc[(2, 0)] / 1e9, "13.11428", "compared in GHz")),
         target("fc_TE01", fc[(0, 1)], "Hz", cf, r3=r3_compare(fc[(0, 1)] / 1e9, "14.75357", "compared in GHz")),
         target("fc_TE11_TM11", fc[(1, 1)], "Hz", cf),
         target("beta_TE10_10GHz", beta, "rad/m", cf, locator="f = 10 GHz"),
         target("S21_phase_10GHz_L50mm", math.remainder(phase, 2 * math.pi), "rad", cf,
                locator="arg S21 = -beta L wrapped to (-pi, pi], L = 50 mm, ports de-embedded to the section ends"),
         target("S21_mag", 1.0, "1", cf), target("S11_mag", 0.0, "1", cf, tolerance_hint={"abs": 1e-3}),
         target("Z_TE10_10GHz", ETA0 * k0 / beta, "Ohm", cf, locator="TE10 wave impedance")],
        GEN, "Rectangular PEC guide: f_c = (c/2) sqrt((m/a)^2 + (n/b)^2); TE10 beta = sqrt(k0^2 - (pi/a)^2); "
             "lossless matched straight section S21 = exp(-j beta L), S11 = 0",
        extra={"inputs": {"a_m": a, "b_m": b, "f_Hz": f, "L_m": L}},
    )


# ---------------------------------------------------------------- RF-04 dipole
def rf04() -> None:
    si, ci = sici(2 * math.pi)
    cin = EULER_GAMMA + math.log(2 * math.pi) - ci
    R = ETA0 / (4 * math.pi) * cin
    X = ETA0 / (4 * math.pi) * si
    mp.mp.dps = 30
    cin_m = mp.euler + mp.log(2 * mp.pi) - mp.ci(2 * mp.pi)
    Rm = float(mp.mpf(ETA0) / (4 * mp.pi) * cin_m)
    Xm = float(mp.mpf(ETA0) / (4 * mp.pi) * mp.si(2 * mp.pi))
    R30 = 30 * cin
    X30 = 30 * si
    write_expected(
        "RF-04",
        [target("R_in", R, "Ohm", {"method": "closed form", "mpmath_30digit": Rm, "diff": abs(R - Rm)},
                r3=r3_compare(R, "73.079")),
         target("X_in", X, "Ohm", {"method": "closed form", "mpmath_30digit": Xm, "diff": abs(X - Xm)},
                r3=r3_compare(X, "42.515"))],
        GEN,
        "Infinitely thin centre-fed half-wave dipole, sinusoidal current (induced-EMF method). Balanis eq. 4-79 with "
        "kl = pi: cos(kl) = -1, sin(kl) = 0, so X_m = (eta0/4pi) Si(2 pi) (the radius term multiplies sin(kl) and "
        "vanishes) and R_r = (eta0/4pi) Cin(2 pi); Z_in = Z_m / sin^2(kl/2) = Z_m. Cin(x) = gamma + ln x - Ci(x).",
        extra={"inputs": {"eta0_Ohm": ETA0, "Si_2pi": si, "Cin_2pi": cin},
               "flag_resolution": {"dipole": f"Z_in = {R:.6f} + j{X:.6f} Ohm with eta0 = {ETA0:.9f} Ohm (CODATA "
                                             f"mu0); with the eta0 ~ 120 pi = 30 * 4 pi convention: {R30:.6f} + "
                                             f"j{X30:.6f} Ohm. Textbook 73 + j42.5 is the rounded form. Independent "
                                             f"of wire radius only in the thin limit; FEM gates on the trend."}},
    )


# ---------------------------------------------------------------- RF-21 cylindrical cavity
def cavity_modes(a: float, d: float, er: float) -> tuple[dict[str, float], dict[str, float]]:
    x = {"TM01": jn_zeros(0, 1)[0], "TM11": jn_zeros(1, 1)[0], "TE11": jnp_zeros(1, 1)[0],
         "TE21": jnp_zeros(2, 1)[0], "TE01": jnp_zeros(0, 1)[0]}
    pref = C0 / (2 * math.pi * math.sqrt(er))

    def f(xnm, p):
        return pref * math.sqrt((xnm / a) ** 2 + (p * math.pi / d) ** 2)

    return {"TM010": f(x["TM01"], 0), "TE111": f(x["TE11"], 1), "TM011": f(x["TM01"], 1), "TM110": f(x["TM11"], 0),
            "TE211": f(x["TE21"], 1), "TE011": f(x["TE01"], 1)}, x


def rf21() -> None:
    a, er = 2.74e-2, 2.08
    d = 2 * a
    fr, x = cavity_modes(a, d, er)
    # mpmath 30-digit recomputation of every mode (Bessel zeros from mpmath)
    mp.mp.dps = 30
    xm = {"TM01": mp.besseljzero(0, 1), "TM11": mp.besseljzero(1, 1), "TE11": mp.besseljzero(1, 1, derivative=1),
          # mpmath counts x = 0 as the first zero of J0'
          "TE21": mp.besseljzero(2, 1, derivative=1), "TE01": mp.besseljzero(0, 2, derivative=1)}
    pm = mp.mpf(C0) / (2 * mp.pi * mp.sqrt(mp.mpf("2.08")))
    am, dm = mp.mpf("2.74e-2"), 2 * mp.mpf("2.74e-2")

    def fm(xx, p):
        return pm * mp.sqrt((xx / am) ** 2 + (p * mp.pi / dm) ** 2)

    fmp = {"TM010": fm(xm["TM01"], 0), "TE111": fm(xm["TE11"], 1), "TM011": fm(xm["TM01"], 1),
           "TM110": fm(xm["TM11"], 0), "TE211": fm(xm["TE21"], 1), "TE011": fm(xm["TE01"], 1)}
    palace = {"TM010": "2.903605", "TE111": "2.922212", "TM011": "3.468149", "TM110": "4.626474",
              "TE211": "4.146842", "TE011": "5.000140"}
    targets = []
    for k, v in fr.items():
        targets.append(target(f"f_{k}", v, "Hz", {"method": "closed form", "mpmath_30digit": float(fmp[k]),
                                                    "diff": abs(v - float(fmp[k]))},
                              r3=r3_compare(v / 1e9, palace[k], "vs Palace cylinder.md analytic table, in GHz"),
                              ten_digits_GHz=mp.nstr(fmp[k] / 1e9, 10)))
    # Palace table hypothesis: Bessel zeros rounded to 4 decimals
    r4 = {k: round(float(v), 4) for k, v in xm.items()}
    pref = C0 / (2 * math.pi * math.sqrt(er))
    modes = {"TM010": ("TM01", 0), "TE111": ("TE11", 1), "TM011": ("TM01", 1), "TM110": ("TM11", 0),
             "TE211": ("TE21", 1), "TE011": ("TE01", 1)}
    f_r4 = {k: pref * math.sqrt((r4[z] / a) ** 2 + (p * math.pi / d) ** 2) for k, (z, p) in modes.items()}
    r4_vs_palace = {k: (f_r4[k] / 1e9 - float(palace[k])) / float(palace[k]) for k in modes}
    tm010_trunc = f_r4["TM010"]
    targets.append(target("Q_dielectric", 1 / 4e-4, "1", {"method": "closed form"},
                          r3=r3_compare(2500.0, "2.50e3"),
                          locator="Q_d = 1/tan(delta) for a uniformly filled cavity, every mode"))
    write_expected(
        "RF-21", targets, GEN,
        "PEC circular cylinder cavity filled with eps_r: f = c/(2 pi sqrt(eps_r)) sqrt((x/a)^2 + (p pi/d)^2), "
        "x = Bessel zero (TM) or derivative zero (TE).",
        extra={"inputs": {"a_m": a, "d_m": d, "eps_r": er, "tan_delta": 4e-4},
               "bessel_zeros": {k: float(v) for k, v in xm.items()},
               "flag_resolution": {
                   "TM010": f"x01 c/(2 pi a sqrt(eps_r)) = {mp.nstr(fmp['TM010'] / 1e9, 10)} GHz (x01 = "
                            f"{mp.nstr(xm['TM01'], 16)}). Palace's analytic-table 2.903605 GHz is reproduced by "
                            f"rounding x01 to 2.4048: {tm010_trunc / 1e9:.6f} GHz. Gate on the closed form.",
                   "all_modes": "Every Palace analytic-table entry is reproduced within 1.1e-7 rel. by Bessel zeros "
                                "rounded to 4 decimals (2.4048, 1.8412, 3.8317, 3.0542, 3.8317); exact zeros differ "
                                "from the table by up to 1.1e-5 rel.",
                   "palace_table_vs_4_decimal_zeros_rel": r4_vs_palace,
                   "frequencies_with_4_decimal_zeros_Hz": f_r4}},
    )


if __name__ == "__main__":
    em01()
    em04()
    rf02()
    rf04()
    rf21()
    print("em: wrote EM-01, EM-04, RF-02, RF-04, RF-21")
