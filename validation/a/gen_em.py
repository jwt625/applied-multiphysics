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
    # Truncation of the open domain by a sphere of radius R_b centred on the coil. The pair's far field is a dipole
    # m = 2 pi R^2 N I (the quadrupole cancels by symmetry). Its regular image is a uniform field at the centre:
    # A_phi = 0 on R_b (B.n = 0): B_img = -2 mu0 m / (4 pi R_b^3); H_t = 0 on R_b: B_img = +mu0 m / (4 pi R_b^3).
    # The next image term (l = 3) vanishes at the centre. Values relative to B0:
    m_dip = 2 * math.pi * R**2 * N * I
    trunc = []
    for rb in (10, 20, 30, 100):
        Rb = rb * R
        trunc.append(target(f"truncation.dirichlet_A.Rb{rb}R", -2 * MU0 * m_dip / (4 * math.pi * Rb**3) / B0, "1",
                            {"method": "closed form, leading (dipole) image"},
                            locator=f"(B_fem(0) - B0)/B0 from A_phi = 0 on a sphere R_b = {rb} R"))
        trunc.append(target(f"truncation.neumann_A.Rb{rb}R", MU0 * m_dip / (4 * math.pi * Rb**3) / B0, "1",
                            {"method": "closed form, leading (dipole) image"},
                            locator=f"(B_fem(0) - B0)/B0 from H_t = 0 on a sphere R_b = {rb} R"))
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
         target("uniformity_sphere_0.1R", dev, "1", cf, locator="max | |B| - B0 | / B0 on a sphere radius 0.1 R")]
        + trunc,
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
    # Finite-radius reference: Hallen MoM input conductance at L = lambda/2 (h = lambda/4)
    mom = []
    levels = [200, 400, 800]
    for name, a_l in [("lambda_over_100", 1e-2), ("lambda_over_300", 1 / 300), ("lambda_over_1000", 1e-3)]:
        Zs = [hallen_dipole(0.25, a_l, N) for N in levels]
        G = [1e3 / z for z in Zs]
        g_ext, pord = richardson3(G[0].real, G[1].real, G[2].real)
        g_fine_q = (1e3 / hallen_dipole(0.25, a_l, levels[-1], nphi=96, nq=16)).real
        mom.append(target(
            f"G_in.a_{name}", g_ext * 1e-3, "S",
            {"method": "Hallen MoM, exact kernel, triangle basis, delta gap; Richardson over N = 200/400/800",
             "levels_N": levels, "G_mS": [g.real for g in G], "B_mS": [g.imag for g in G],
             "observed_order": pord, "richardson_minus_finest_rel": abs(g_ext - G[-1].real) / g_ext,
             "quadrature_check_finest_rel": abs(g_fine_q - G[-1].real) / G[-1].real,
             "B_note": "B grows ~ ln N (zero-width-gap capacitance): not converged, never gated"},
            locator=f"input conductance Re(1/Z_in), L = lambda/2, radius a = {a_l:g} lambda",
            Z_in_finest_Ohm=[Zs[-1].real, Zs[-1].imag]))
    write_expected(
        "RF-04",
        [target("R_in", R, "Ohm", {"method": "closed form", "mpmath_30digit": Rm, "diff": abs(R - Rm)},
                r3=r3_compare(R, "73.079")),
         target("X_in", X, "Ohm", {"method": "closed form", "mpmath_30digit": Xm, "diff": abs(X - Xm)},
                r3=r3_compare(X, "42.515")),
         target("G_in.thin_limit", (1 / complex(R, X)).real,
                "S", {"method": "closed form, 1/(R + jX) of the thin-wire values"})] + mom,
        GEN,
        "Infinitely thin centre-fed half-wave dipole, sinusoidal current (induced-EMF method). Balanis eq. 4-79 with "
        "kl = pi: cos(kl) = -1, sin(kl) = 0, so X_m = (eta0/4pi) Si(2 pi) (the radius term multiplies sin(kl) and "
        "vanishes) and R_r = (eta0/4pi) Cin(2 pi); Z_in = Z_m / sin^2(kl/2) = Z_m. Cin(x) = gamma + ln x - Ci(x).",
        extra={"inputs": {"eta0_Ohm": ETA0, "Si_2pi": si, "Cin_2pi": cin},
               "flag_resolution": {"dipole": f"Z_in = {R:.6f} + j{X:.6f} Ohm with eta0 = {ETA0:.9f} Ohm (CODATA "
                                             f"mu0); with the eta0 ~ 120 pi = 30 * 4 pi convention: {R30:.6f} + "
                                             f"j{X30:.6f} Ohm. Textbook 73 + j42.5 is the rounded form. Independent "
                                             f"of wire radius only in the thin limit; the finite-radius gate is the "
                                             f"Hallen MoM input conductance."}},
    )


# ---------------------------------------------------------------- RF-04 finite-radius reference: Hallen MoM
def hallen_dipole(h: float, a: float, N: int, lam: float = 1.0, nphi: int = 48, nq: int = 8) -> complex:
    """Input impedance (Ohm) of a centre-fed tubular PEC dipole, half-length h, radius a, delta-gap feed, V = 1 V.

    Hallen's equation, exact (tube) kernel, symmetric triangle basis centred at z_n = n dz (n = 0..N-1, dz = h/N,
    so I(h) = 0 and the full length carries current), point matching at z_m = m dz (m = 0..N), plus the
    homogeneous constant C:
      sum_n I_n int Lambda_n(z') K(z_m - z') dz' + (j/eta0) C cos(k z_m) = -(j/eta0) (V/2) sin(k z_m),
      K = (1/2pi) int_0^2pi exp(-j k R)/(4 pi R) dphi, R^2 = (z - z')^2 + 4 a^2 sin^2(phi/2).
    Static part 1/R integrated in z' analytically, in phi by Gauss-Legendre with phi = pi t^2 (removes the log
    singularity); dynamic part (exp(-jkR) - 1)/R with the reduced kernel (difference O(k^2 a^2)).
    exp(+j omega t). Known property of the delta gap with the exact kernel: the input susceptance grows like ln N
    (gap capacitance of a zero-width gap), so only the input conductance converges; it is the gated quantity.
    """
    k = 2 * math.pi / lam
    dz = h / N
    zn = np.arange(N) * dz
    zm = np.arange(N + 1) * dz
    tg, tw = np.polynomial.legendre.leggauss(nphi)
    t = 0.5 * (tg + 1)
    wphi = 0.5 * tw * 2 * t  # (1/2pi) int_0^2pi dphi = (1/pi) int_0^pi dphi, dphi = 2 pi t dt
    b = 2 * a * np.sin(math.pi * t**2 / 2)
    xq, wq = np.polynomial.legendre.leggauss(nq)

    def seg(z, p, q, al, be):
        """int_p^q (al + be z') K(z - z') dz' for segment arrays p, q, al, be and match points z."""
        Z = z[:, None, None]
        B = b[None, None, :]
        u2, u1 = q[None, :, None] - Z, p[None, :, None] - Z
        A0 = al[None, :, None] + be[None, :, None] * Z
        st = A0 * (np.arcsinh(u2 / B) - np.arcsinh(u1 / B)) + be[None, :, None] * (
            np.sqrt(u2**2 + B**2) - np.sqrt(u1**2 + B**2))
        stat = np.sum(st * wphi[None, None, :], axis=2) / (4 * math.pi)
        zz = 0.5 * (p + q)[None, :, None] + 0.5 * (q - p)[None, :, None] * xq[None, None, :]
        R = np.sqrt((zz - Z) ** 2 + a * a)
        w = al[None, :, None] + be[None, :, None] * zz
        dyn = np.sum(w * (np.exp(-1j * k * R) - 1) / R * wq[None, None, :], axis=2) * 0.5 * (q - p)[None, :]
        return stat + dyn / (4 * math.pi)

    p1, q1, al1, be1 = zn - dz, zn, -(zn - dz) / dz, np.full(N, 1 / dz)   # rising ramp
    p2, q2, al2, be2 = zn, zn + dz, (zn + dz) / dz, np.full(N, -1 / dz)   # falling ramp
    cols = seg(zm, p1, q1, al1, be1) + seg(zm, p2, q2, al2, be2)
    mirror = seg(zm, -q1, -p1, al1, -be1) + seg(zm, -q2, -p2, al2, -be2)
    mirror[:, 0] = 0.0  # the n = 0 triangle spans [-dz, dz] already
    A = np.zeros((N + 1, N + 1), dtype=complex)
    A[:, :N] = cols + mirror
    A[:, N] = 1j / ETA0 * np.cos(k * zm)
    rhs = -1j / ETA0 * 0.5 * np.sin(k * zm)
    return complex(1.0 / np.linalg.solve(A, rhs)[0])


def richardson3(f1: float, f2: float, f3: float, r: float = 2.0) -> tuple[float, float]:
    """Extrapolate from three levels (coarse to fine, ratio r); returns (f_ext, observed order)."""
    e1, e2 = f2 - f1, f3 - f2
    pord = math.log(abs(e1 / e2)) / math.log(r)
    return f3 + e2 / (r**pord - 1), pord


# ---------------------------------------------------------------- RF-21 cylindrical cavity
def cavity_modes(a: float, d: float, er: float) -> tuple[dict[str, float], dict[str, float]]:
    x = {"TM01": jn_zeros(0, 1)[0], "TM11": jn_zeros(1, 1)[0], "TE11": jnp_zeros(1, 1)[0],
         "TE21": jnp_zeros(2, 1)[0], "TE01": jnp_zeros(0, 1)[0]}
    pref = C0 / (2 * math.pi * math.sqrt(er))

    def f(xnm, p):
        return pref * math.sqrt((xnm / a) ** 2 + (p * math.pi / d) ** 2)

    return {"TM010": f(x["TM01"], 0), "TE111": f(x["TE11"], 1), "TM011": f(x["TM01"], 1), "TM110": f(x["TM11"], 0),
            "TE211": f(x["TE21"], 1), "TE011": f(x["TE01"], 1)}, x


def cavity_mode_table(a: float, d: float, er: float, f_max: float) -> list[dict]:
    """All TE_mnp / TM_mnp modes of a PEC cylinder cavity below f_max, sorted, with multiplicity (2 for m > 0:
    cos/sin m phi) and their index range in a 3D eigenvalue list (1-based, ascending, degenerate modes adjacent)."""
    pref = C0 / (2 * math.pi * math.sqrt(er))
    rows = []
    for m in range(0, 8):
        xs_tm = jn_zeros(m, 6)
        xs_te = jnp_zeros(m, 6)
        for n in range(1, 7):
            for p in range(0, 8):
                for fam, xx in (("TM", xs_tm[n - 1]), ("TE", xs_te[n - 1])):
                    if fam == "TE" and p == 0:
                        continue  # TE_mn0 does not exist
                    f = pref * math.sqrt((xx / a) ** 2 + (p * math.pi / d) ** 2)
                    if f <= f_max:
                        rows.append({"label": f"{fam}{m}{n}{p}", "family": fam, "m": m, "n": n, "p": p, "f_Hz": f,
                                     "multiplicity": 1 if m == 0 else 2})
    rows.sort(key=lambda r: (r["f_Hz"], r["family"], r["m"]))
    idx = 1
    for r in rows:
        r["index_3d_first"], r["index_3d_last"] = idx, idx + r["multiplicity"] - 1
        idx += r["multiplicity"]
    for r in rows:
        r["degenerate_with"] = [q["label"] for q in rows
                                if q is not r and abs(q["f_Hz"] - r["f_Hz"]) <= 1e-12 * r["f_Hz"]]
    return rows


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
    table = cavity_mode_table(a, d, er, f_max=5.3e9)
    ident = {row["label"]: row for row in table}
    targets = []
    for k, v in fr.items():
        row = ident[k]
        targets.append(target(f"f_{k}", v, "Hz", {"method": "closed form", "mpmath_30digit": float(fmp[k]),
                                                    "diff": abs(v - float(fmp[k]))},
                              r3=r3_compare(v / 1e9, palace[k], "vs Palace cylinder.md analytic table, in GHz"),
                              ten_digits_GHz=mp.nstr(fmp[k] / 1e9, 10),
                              mode={kk: row[kk] for kk in ("family", "m", "n", "p", "multiplicity",
                                                           "index_3d_first", "index_3d_last", "degenerate_with")}))
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
               "mode_table_to_5.3GHz": table,
               "classifier": "TE: E_z = 0 everywhere; TM: H_z = 0. Azimuthal order m from the phi dependence "
                             "cos(m phi) or the 2D-axisym harmonic. TE011 and TM111 are exactly degenerate "
                             "(x'01 = x11 because J0' = -J1); separate them by m (0 vs 1) or E_z = 0.",
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
