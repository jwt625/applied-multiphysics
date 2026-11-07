# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-a generators: acoustics (AC-02 box modes, AC-03 rigid sphere), fluids (FL-01 Kovasznay + Poiseuille),
transport (TR-01 PFR + Danckwerts), semiconductor (SC-01 pn junction), coupled (CP-05 electro-osmotic slit).

Field functions (exposed for field-error metrics): ac03_pressure, kovasznay, poiseuille, danckwerts_profile,
eof_profile.

Run: cd validation && uv run python a/gen_misc.py
"""

from __future__ import annotations

import itertools
import math

import mpmath as mp
import numpy as np
from common import EPS0, K_B, N_A, Q_E, r3_compare, target, write_expected
from scipy.special import eval_legendre, spherical_jn, spherical_yn

GEN = "validation/a/gen_misc.py"


# ---------------------------------------------------------------- AC-02 rigid box
def ac02() -> None:
    Lx, Ly, Lz, c = 1.0, 0.8, 0.6, 343.0
    modes = []
    for ix, iy, iz in itertools.product(range(8), range(8), range(8)):
        if ix == iy == iz == 0:
            continue
        f = c / 2 * math.sqrt((ix / Lx) ** 2 + (iy / Ly) ** 2 + (iz / Lz) ** 2)
        modes.append((f, (ix, iy, iz)))
    modes.sort()
    r3 = ["171.500", "214.375", "274.534", "285.833"]
    targets = []
    for i, (f, lmn) in enumerate(modes[:10]):
        targets.append(target(f"f_mode{i + 1}", f, "Hz", {"method": "closed form"},
                              r3=r3_compare(f, r3[i]) if i < 4 else None, locator=f"(l, m, n) = {lmn}"))
    write_expected("AC-02", targets, GEN,
                   "Rigid-walled box: f = (c/2) sqrt((l/Lx)^2 + (m/Ly)^2 + (n/Lz)^2), lowest 10 non-zero modes "
                   "(index search to 7 per axis covers them)",
                   extra={"inputs": {"Lx": Lx, "Ly": Ly, "Lz": Lz, "c": c}})


# ---------------------------------------------------------------- AC-03 rigid sphere
def _rigid_coeffs(ka: float, nmax: int) -> np.ndarray:
    n = np.arange(nmax + 1)
    jp = spherical_jn(n, ka, derivative=True)
    hp = jp + 1j * spherical_yn(n, ka, derivative=True)
    return jp / hp


def ac03_nmax(ka: float) -> int:
    return int(math.ceil(ka + 4 * ka ** (1 / 3) + 10))


def ac03_form(ka: float, theta: float, nmax: int | None = None) -> complex:
    """Far-field form function f(theta): p_s -> p0 (a / 2r) f(theta) exp(i k r), exp(-i w t)."""
    nmax = nmax or ac03_nmax(ka)
    n = np.arange(nmax + 1)
    return complex(2j / ka * np.sum((2 * n + 1) * _rigid_coeffs(ka, nmax) * eval_legendre(n, math.cos(theta))))


def ac03_sigma_norm(ka: float, nmax: int | None = None) -> float:
    """Total scattering cross-section / (pi a^2)."""
    nmax = nmax or ac03_nmax(ka)
    n = np.arange(nmax + 1)
    return float(4 / ka**2 * np.sum((2 * n + 1) * np.abs(_rigid_coeffs(ka, nmax)) ** 2))


def ac03_pressure(r, theta, ka: float, a: float = 1.0, p0: float = 1.0, nmax: int | None = None) -> np.ndarray:
    """Total complex pressure (incident p0 exp(i k z) + scattered) at (r, theta), r >= a, rigid sphere radius a."""
    r = np.asarray(r, dtype=float)
    theta = np.asarray(theta, dtype=float)
    nmax = nmax or ac03_nmax(ka) + 10
    k = ka / a
    A = _rigid_coeffs(ka, nmax)
    p = np.zeros(np.broadcast(r, theta).shape, dtype=complex)
    mu = np.cos(theta)
    for n in range(nmax + 1):
        jn = spherical_jn(n, k * r)
        hn = jn + 1j * spherical_yn(n, k * r)
        p += p0 * 1j**n * (2 * n + 1) * (jn - A[n] * hn) * eval_legendre(n, mu)
    return p


def ac03() -> None:
    targets = []
    for ka in [0.5, 1.0, 2.0, 5.0, 10.0]:
        n0 = ac03_nmax(ka)
        fb, fb2 = abs(ac03_form(ka, math.pi, n0)), abs(ac03_form(ka, math.pi, 2 * n0))
        sg, sg2 = ac03_sigma_norm(ka, n0), ac03_sigma_norm(ka, 2 * n0)
        targets.append(target(f"abs_f_back_ka{ka}", fb, "1",
                              {"method": "partial-wave series", "terms": n0 + 1, "change_on_doubling": abs(fb2 - fb)},
                              locator=f"|f(pi)|, ka = {ka}"))
        targets.append(target(f"sigma_over_pia2_ka{ka}", sg, "1",
                              {"method": "partial-wave series", "terms": n0 + 1, "change_on_doubling": abs(sg2 - sg)},
                              locator=f"sigma_s / (pi a^2), ka = {ka}"))
    # Limits as self-checks
    ka_s = 0.01
    rayleigh = ac03_sigma_norm(ka_s) / ((7 / 9) * ka_s**4)
    geo = ac03_sigma_norm(200.0)
    # Boundary condition check: dp/dr = 0 on r = a (central difference)
    th = np.linspace(0.01, math.pi - 0.01, 50)
    h = 1e-7
    dpdr = (ac03_pressure(1 + h, th, 5.0) - ac03_pressure(1 - h, th, 5.0)) / (2 * h)
    bc = float(np.max(np.abs(dpdr)) / 5.0)
    write_expected(
        "AC-03", targets, GEN,
        "Rigid sphere, plane wave p0 exp(i k z): p_s = -p0 sum i^n (2n+1) [j_n'(ka)/h_n'(ka)] h_n(kr) P_n(cos th) "
        "(Morse-Ingard sec. 8.2 form; not fetched). f(th) = (2i/ka) sum (2n+1) (j_n'/h_n') P_n(cos th); "
        "sigma/(pi a^2) = (4/(ka)^2) sum (2n+1) |j_n'/h_n'|^2.",
        extra={"self_checks": {"rayleigh_ratio_ka0.01_vs_7/9_ka^4": rayleigh, "sigma_over_pia2_ka200": geo,
                               "max_|dp/dr|_over_k_at_r=a_ka5": bc},
               "field_function": "validation/a/fields.py:AC-03 -> gen_misc.ac03_pressure"},
    )


# ---------------------------------------------------------------- FL-01 Kovasznay + Poiseuille
def kovasznay_lambda(Re: float) -> float:
    return Re / 2 - math.sqrt(Re * Re / 4 + 4 * math.pi**2)


def kovasznay(x, y, Re: float = 10.0, domain=((-0.5, 1.5), (-0.5, 1.5))) -> dict[str, np.ndarray]:
    """Kovasznay 1948 steady NS solution, rho = 1, nu = 1/Re. Pressure has zero mean over `domain`."""
    lam = kovasznay_lambda(Re)
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    e = np.exp(lam * x)
    (x0, x1), _ = domain
    mean_e2 = (math.exp(2 * lam * x1) - math.exp(2 * lam * x0)) / (2 * lam * (x1 - x0))
    return {"u": 1 - e * np.cos(2 * math.pi * y), "v": lam / (2 * math.pi) * e * np.sin(2 * math.pi * y),
            "p": 0.5 * (1 - e * e) - 0.5 * (1 - mean_e2)}


def poiseuille(x, y, mu: float = 1.0) -> dict[str, np.ndarray]:
    """Planar Poiseuille on [0, 1] x [0, 1] (dolfinx-tutorial ns_code1 set-up): u = 4 y (1 - y), p = 8 (1 - x)."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    return {"u": 4 * y * (1 - y), "v": 0 * y, "p": 8 * mu * (1 - x)}


def _ns_residual(Re: float) -> dict[str, float]:
    rng = np.random.default_rng(11)
    P = rng.uniform(-0.5, 1.5, size=(300, 2))
    h = 1e-4
    nu = 1 / Re

    def F(x, y):
        return kovasznay(x, y, Re)

    X, Y = P[:, 0], P[:, 1]
    c, xp, xm, yp, ym = F(X, Y), F(X + h, Y), F(X - h, Y), F(X, Y + h), F(X, Y - h)
    res = []
    for q in ["u", "v"]:
        dx = (xp[q] - xm[q]) / (2 * h)
        dy = (yp[q] - ym[q]) / (2 * h)
        lap = (xp[q] + xm[q] + yp[q] + ym[q] - 4 * c[q]) / h**2
        dp = (xp["p"] - xm["p"]) / (2 * h) if q == "u" else (yp["p"] - ym["p"]) / (2 * h)
        res.append(np.max(np.abs(c["u"] * dx + c["v"] * dy + dp - nu * lap)))
    div = np.max(np.abs((xp["u"] - xm["u"]) / (2 * h) + (yp["v"] - ym["v"]) / (2 * h)))
    return {"momentum_residual_max_fd": float(max(res)), "divergence_max_fd": float(div), "fd_step": h}


def fl01() -> None:
    Re = 10.0
    lam = kovasznay_lambda(Re)
    mp.mp.dps = 30
    lam_m = mp.mpf(Re) / 2 - mp.sqrt(mp.mpf(Re) ** 2 / 4 + 4 * mp.pi**2)
    k = kovasznay(np.array([0.5, 1.0]), np.array([0.25, 0.5]), Re)
    chk = _ns_residual(Re)
    cf = {"method": "closed form", "ns_check": chk}
    write_expected(
        "FL-01",
        [target("kovasznay.lambda", lam, "1", {"method": "closed form", "mpmath_30digit": mp.nstr(lam_m, 20)}),
         target("kovasznay.u.x0.5_y0.25", float(k["u"][0]), "m/s", cf),
         target("kovasznay.v.x0.5_y0.25", float(k["v"][0]), "m/s", cf),
         target("kovasznay.p.x1.0_y0.5", float(k["p"][1]), "Pa", cf, locator="zero-mean pressure over the domain"),
         target("kovasznay.field_rel_L2_u", 0.0, "1", cf,
                locator="||u_h - u||_L2/||u||_L2, rate p+1 (velocity), H1 rate p; exact field fields.py FL-01"),
         target("poiseuille.u_max", 1.0, "m/s", {"method": "closed form"}, locator="y = 0.5"),
         target("poiseuille.flow_rate", 2 / 3, "m^2/s", {"method": "closed form"}, locator="int_0^1 u dy"),
         target("poiseuille.wall_shear", 4.0, "Pa", {"method": "closed form"}, locator="mu du/dy at y = 0, mu = 1"),
         target("poiseuille.dp_dx", -8.0, "Pa/m", {"method": "closed form"})],
        GEN,
        "Kovasznay: u = 1 - e^{lam x} cos 2 pi y, v = lam/(2 pi) e^{lam x} sin 2 pi y, p = (1 - e^{2 lam x})/2 + C, "
        "lam = Re/2 - sqrt(Re^2/4 + 4 pi^2). Poiseuille: mu = 1, u = 4 y (1 - y), p = 8 (1 - x).",
        extra={"field_function": "validation/a/fields.py:FL-01 (kovasznay), FL-01-poiseuille"},
    )


# ---------------------------------------------------------------- TR-01 PFR + Danckwerts
TR01 = {"L": 1.0, "u": 1.0e-3, "k": 1.0e-3, "Pe_list": [1.0, 10.0, 100.0]}


def danckwerts_profile(x, L: float, u: float, D: float, k: float, C0: float = 1.0) -> np.ndarray:
    """Steady axial-dispersion reactor, first order: D C'' - u C' - k C = 0, u C0 = u C(0) - D C'(0), C'(L) = 0."""
    mp.mp.dps = 40
    u_, D_, k_, L_ = mp.mpf(u), mp.mpf(D), mp.mpf(k), mp.mpf(L)
    s = mp.sqrt(u_**2 + 4 * k_ * D_)
    r1, r2 = (u_ + s) / (2 * D_), (u_ - s) / (2 * D_)
    # C = A e^{r1 (x - L)} + B e^{r2 x} (scaled to avoid overflow)
    M = mp.matrix([[u_ - D_ * r1, (u_ - D_ * r2)], [r1, r2 * mp.exp(r2 * L_)]])
    M[0, 0] = (u_ - D_ * r1) * mp.exp(-r1 * L_)
    rhs = mp.matrix([u_ * C0, 0])
    A, B = mp.lu_solve(M, rhs)
    xs = np.atleast_1d(np.asarray(x, dtype=float))
    return np.array([float(A * mp.exp(r1 * (mp.mpf(xi) - L_)) + B * mp.exp(r2 * mp.mpf(xi))) for xi in xs])


def danckwerts_exit(Pe: float, Da: float) -> float:
    a = math.sqrt(1 + 4 * Da / Pe)
    return 4 * a * math.exp(Pe / 2) / ((1 + a) ** 2 * math.exp(a * Pe / 2) - (1 - a) ** 2 * math.exp(-a * Pe / 2))


def tr01() -> None:
    L, u, k = TR01["L"], TR01["u"], TR01["k"]
    Da = k * L / u
    targets = [target("pfr.C_L_over_C0", math.exp(-Da), "1", {"method": "closed form"},
                      locator="no dispersion, x = L", inputs={"Da": Da})]
    for Pe in TR01["Pe_list"]:
        D = u * L / Pe
        ex = danckwerts_exit(Pe, Da)
        prof = danckwerts_profile([0.0, 0.5 * L, L], L, u, D, k)
        targets.append(target(f"danckwerts.C_L_over_C0_Pe{Pe:g}", ex, "1",
                              {"method": "closed form (Danckwerts 1953 / Wehner-Wilhelm)",
                               "profile_route_mpmath": float(prof[2]), "diff": abs(ex - float(prof[2]))},
                              locator="x = L", inputs={"Pe": Pe, "Da": Da, "D_m2_s": D}))
        targets.append(target(f"danckwerts.C_0_over_C0_Pe{Pe:g}", float(prof[0]), "1",
                              {"method": "2x2 linear solve, mpmath 40 digits"}, locator="x = 0+ (inlet jump)"))
        targets.append(target(f"danckwerts.C_mid_over_C0_Pe{Pe:g}", float(prof[1]), "1",
                              {"method": "2x2 linear solve, mpmath 40 digits"}, locator="x = L/2"))
    write_expected(
        "TR-01", targets, GEN,
        "First-order reaction, steady. PFR: C/C0 = exp(-Da), Da = kL/u. Axial dispersion with Danckwerts BCs: "
        "C(L)/C0 = 4 a e^{Pe/2} / ((1 + a)^2 e^{a Pe/2} - (1 - a)^2 e^{-a Pe/2}), a = sqrt(1 + 4 Da/Pe), Pe = uL/D. "
        "Inputs are synthetic (R3 gives none).",
        extra={"inputs": TR01, "field_function": "validation/a/fields.py:TR-01 -> gen_misc.danckwerts_profile"},
    )


# ---------------------------------------------------------------- SC-01 pn junction
def sc01() -> None:
    T, NA, ND, ni = 300.0, 1e18 * 1e6, 1e18 * 1e6, 1e10 * 1e6  # m^-3
    vt = K_B * T / Q_E
    vbi = vt * math.log(NA * ND / ni**2)
    targets = [target("V_T", vt, "V", {"method": "closed form"}),
               target("V_bi", vbi, "V", {"method": "closed form"}, r3=r3_compare(vbi, "0.95242"))]
    for er, r3 in [(11.7, "49.63"), (11.9, None), (11.1, "48.34")]:
        W = math.sqrt(2 * er * EPS0 * vbi * (NA + ND) / (Q_E * NA * ND))
        xn = W * NA / (NA + ND)
        Emax = Q_E * ND * xn / (er * EPS0)
        targets.append(target(f"W_0V.epsr{er}", W, "m", {"method": "closed form, depletion approximation"},
                              r3=r3_compare(W * 1e9, r3, "compared in nm") if r3 else None))
        targets.append(target(f"E_max_0V.epsr{er}", Emax, "V/m", {"method": "closed form, depletion approximation"}))
        # Exact first integral of the equilibrium Poisson-Boltzmann equation (Boltzmann statistics, full ionization),
        # symmetric doping so psi = 0 (intrinsic level) at the metallurgical junction:
        # eps E^2 / 2 = q [N_A V_T ln(N_A/n_i) - V_T N_A + 2 n_i V_T - V_T n_i^2/N_A]
        I = vt * (NA * math.log(NA / ni) - NA + 2 * ni - ni * ni / NA)  # noqa: E741
        Epb = math.sqrt(2 * Q_E * I / (er * EPS0))
        targets.append(target(f"E_max_PB_0V.epsr{er}", Epb, "V/m",
                              {"method": "closed form, exact first integral of Poisson-Boltzmann",
                               "ratio_to_depletion_approx": Epb / Emax,
                               "sze_debye_correction_sqrt(1-2VT/Vbi)": math.sqrt(1 - 2 * vt / vbi)},
                              locator="peak field at the junction, equilibrium; gate for a drift-diffusion solve"))
    write_expected(
        "SC-01", targets, GEN,
        "Abrupt pn junction, depletion approximation: V_bi = (kT/q) ln(N_A N_D / n_i^2), "
        "W = sqrt(2 eps V_bi (N_A + N_D)/(q N_A N_D)) (Hu eqs. 4.1.2, 4.2.8). eps_r 11.7 and 11.1 as R3 states; "
        "11.9 added for comparison (eps_r source to be verified; see case missing list). E_max_PB: exact peak field "
        "of the nonlinear equilibrium Poisson equation, the gate for a drift-diffusion solver.",
        extra={"inputs": {"T_K": T, "N_A_m3": NA, "N_D_m3": ND, "n_i_m3": ni}},
    )


# ---------------------------------------------------------------- CP-05 electro-osmotic slit
CP05 = {"eps_r": 80.0, "zeta_V": -0.050, "E_V_m": 1.0e4, "eta_Pa_s": 1.0e-3, "c0_mol_m3": 1.0, "T_K": 298.15,
        "h_m": 100e-9}


def debye_length(eps_r: float, c0: float, T: float, z: int = 1) -> float:
    return math.sqrt(eps_r * EPS0 * K_B * T / (2 * N_A * c0 * (z * Q_E) ** 2))


def eof_profile(y, p: dict[str, float] = CP05) -> np.ndarray:
    """Debye-Hueckel + Stokes, slit |y| <= h, walls at zeta: u(y) = u_HS (1 - cosh(y/lD)/cosh(h/lD)),
    u_HS = -eps zeta E / eta (positive along E for zeta < 0)."""
    lD = debye_length(p["eps_r"], p["c0_mol_m3"], p["T_K"])
    uhs = -p["eps_r"] * EPS0 * p["zeta_V"] * p["E_V_m"] / p["eta_Pa_s"]
    y = np.asarray(y, dtype=float)
    return uhs * (1 - np.cosh(y / lD) / np.cosh(p["h_m"] / lD))


def cp05() -> None:
    p = CP05
    lD = debye_length(p["eps_r"], p["c0_mol_m3"], p["T_K"])
    uhs = -p["eps_r"] * EPS0 * p["zeta_V"] * p["E_V_m"] / p["eta_Pa_s"]
    h = p["h_m"]
    umean = uhs * (1 - lD / h * math.tanh(h / lD))
    ucen = float(eof_profile(0.0))
    cf = {"method": "closed form"}
    write_expected(
        "CP-05",
        [target("u_HS", uhs, "m/s", cf, r3=r3_compare(uhs, "3.5417e-4", "sign: flow along +E for zeta < 0")),
         target("lambda_D", lD, "m", cf, locator="1:1 electrolyte, c0 = 1 mol/m^3 (synthetic), T = 298.15 K"),
         target("u_center", ucen, "m/s", cf, locator="y = 0"),
         target("u_mean", umean, "m/s", cf, locator="slit-averaged velocity"),
         target("zeta_over_V_T", abs(p["zeta_V"]) / (K_B * p["T_K"] / Q_E), "1", cf,
                locator="Debye-Hueckel linearization parameter (>1 here: the case defines the linearized PDE)")],
        GEN,
        "Helmholtz-Smoluchowski u_HS = -eps zeta E/eta; Debye-Hueckel potential psi = zeta cosh(y/lD)/cosh(h/lD); "
        "Stokes u = u_HS (1 - psi/zeta); lD = sqrt(eps kT / (2 N_A c0 e^2)).",
        extra={"inputs": p, "field_function": "validation/a/fields.py:CP-05 -> gen_misc.eof_profile"},
    )


if __name__ == "__main__":
    ac02()
    ac03()
    fl01()
    tr01()
    sc01()
    cp05()
    print("misc: wrote AC-02, AC-03, FL-01, TR-01, SC-01, CP-05")
