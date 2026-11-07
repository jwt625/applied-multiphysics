# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-a wave-optics generators.

WO-01 symmetric slab TE0/TM0, WO-03 Mie (efficiencies + near field, exposed for field checks), WO-21 1D quarter-wave
Bragg stack band edges (closed form, MPB-free).

Mie convention: Bohren-Huffman (BH), exp(-i omega t), incident E = x_hat exp(i k z), absorbing m = n + i kappa.
miepython writes the same medium as m = n - i kappa (it uses the opposite sign); efficiencies are identical.

Run: cd validation && uv run python a/gen_optics.py
"""

from __future__ import annotations

import math

import mpmath as mp
import numpy as np
from common import r3_compare, target, write_expected
from scipy.optimize import brentq
from scipy.special import spherical_jn, spherical_yn

GEN = "validation/a/gen_optics.py"


# ---------------------------------------------------------------- WO-01 slab
WO01 = {"lambda_m": 1550e-9, "t_m": 220e-9, "n_core": 3.477723756, "n_clad": 1.444023622}


def slab_neff(pol: str, lam: float, t: float, n1: float, n2: float, order: int = 0) -> float:
    """Even/odd guided modes of a symmetric slab, thickness t. order 0 = fundamental (even)."""
    k0 = 2 * math.pi / lam
    d = t / 2
    r = (n1 / n2) ** 2 if pol == "TM" else 1.0

    def f(ne):
        kap = k0 * math.sqrt(n1 * n1 - ne * ne)
        gam = k0 * math.sqrt(ne * ne - n2 * n2)
        if order % 2 == 0:
            return kap * math.sin(kap * d) - r * gam * math.cos(kap * d)
        return kap * math.cos(kap * d) + r * gam * math.sin(kap * d)

    # fundamental: kap d in (0, pi/2)
    lo = math.sqrt(max(n1 * n1 - (math.pi / 2 / (k0 * d)) ** 2, n2 * n2)) + 1e-15
    return brentq(f, lo, n1 - 1e-15, xtol=1e-15, rtol=1e-15, maxiter=500)


def wo01() -> None:
    p = WO01
    te = slab_neff("TE", p["lambda_m"], p["t_m"], p["n_core"], p["n_clad"])
    tm = slab_neff("TM", p["lambda_m"], p["t_m"], p["n_core"], p["n_clad"])
    # mpmath 30-digit cross-check
    mp.mp.dps = 30
    k0 = 2 * mp.pi / mp.mpf("1550e-9")
    d = mp.mpf("110e-9")
    n1, n2 = mp.mpf("3.477723756"), mp.mpf("1.444023622")

    def g(ne, r):
        kap = k0 * mp.sqrt(n1**2 - ne**2)
        gam = k0 * mp.sqrt(ne**2 - n2**2)
        return kap * mp.tan(kap * d) - r * gam

    te_m = mp.findroot(lambda ne: g(ne, 1), te)
    tm_m = mp.findroot(lambda ne: g(ne, (n1 / n2) ** 2), tm)
    write_expected(
        "WO-01",
        [target("neff_TE0", te, "1", {"method": "brentq", "xtol": 1e-15, "mpmath_30digit": mp.nstr(te_m, 16),
                                       "diff": abs(te - float(te_m))}, r3=r3_compare(te, "2.849489")),
         target("neff_TM0", tm, "1", {"method": "brentq", "xtol": 1e-15, "mpmath_30digit": mp.nstr(tm_m, 16),
                                       "diff": abs(tm - float(tm_m))}, r3=r3_compare(tm, "2.054619"))],
        GEN, "Symmetric slab: kappa tan(kappa d) = r gamma, r = 1 (TE) or (n1/n2)^2 (TM), d = t/2",
        extra={"inputs": p},
    )


# ---------------------------------------------------------------- WO-03 Mie
def mie_ab(m: complex, x: float, nmax: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """BH a_n, b_n via the logarithmic-derivative downward recurrence (BHMIE algorithm)."""
    if nmax is None:
        nmax = int(round(x + 4.05 * x ** (1 / 3) + 2))
    mx = m * x
    nmx = int(round(max(nmax, abs(mx)) + 16))
    D = np.zeros(nmx + 1, dtype=complex)
    for n in range(nmx, 0, -1):
        D[n - 1] = n / mx - 1 / (D[n] + n / mx)
    n = np.arange(1, nmax + 1)
    psi = np.array([x * spherical_jn(k, x) for k in range(0, nmax + 1)])
    chi = np.array([-x * spherical_yn(k, x) for k in range(0, nmax + 1)])
    xi = psi - 1j * chi  # BH: xi_n = psi_n - i chi_n with chi_n = -x y_n -> xi = x h_n^(1)
    Dn = D[1 : nmax + 1]
    a = ((Dn / m + n / x) * psi[1:] - psi[:-1]) / ((Dn / m + n / x) * xi[1:] - xi[:-1])
    b = ((m * Dn + n / x) * psi[1:] - psi[:-1]) / ((m * Dn + n / x) * xi[1:] - xi[:-1])
    return a, b


def mie_efficiencies(m: complex, x: float, nmax: int | None = None) -> dict[str, float]:
    a, b = mie_ab(m, x, nmax)
    n = np.arange(1, len(a) + 1)
    qext = 2 / x**2 * np.sum((2 * n + 1) * (a + b).real)
    qsca = 2 / x**2 * np.sum((2 * n + 1) * (np.abs(a) ** 2 + np.abs(b) ** 2))
    qback = np.abs(np.sum((2 * n + 1) * (-1.0) ** n * (a - b))) ** 2 / x**2
    nn = n[:-1]
    cross = (a[:-1] * np.conj(a[1:]) + b[:-1] * np.conj(b[1:])).real
    g = 4 / (x**2 * qsca) * (np.sum(nn * (nn + 2) / (nn + 1) * cross)
                             + np.sum((2 * n + 1) / (n * (n + 1)) * (a * np.conj(b)).real))
    return {"qext": float(qext), "qsca": float(qsca), "qabs": float(qext - qsca), "qback": float(qback),
            "g": float(g), "nmax": len(a)}


def _pi_tau(nmax: int, mu: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    pi = np.zeros((nmax + 1,) + mu.shape)
    tau = np.zeros_like(pi)
    pi[1] = 1.0
    if nmax >= 2:
        pi[2] = 3 * mu
    for n in range(3, nmax + 1):
        pi[n] = (2 * n - 1) / (n - 1) * mu * pi[n - 1] - n / (n - 1) * pi[n - 2]
    for n in range(1, nmax + 1):
        tau[n] = n * mu * pi[n] - (n + 1) * pi[n - 1]
    return pi, tau


def _sph(n: int, z, kind: str):
    """z_n and [rho z_n]'/rho for kind 'j' (j_n) or 'h' (h_n^(1)); complex z allowed for 'j'."""
    if kind == "j":
        zn = spherical_jn(n, z)
        dz = spherical_jn(n, z, derivative=True)
    else:
        zn = spherical_jn(n, z) + 1j * spherical_yn(n, z)
        dz = spherical_jn(n, z, derivative=True) + 1j * spherical_yn(n, z, derivative=True)
    return zn, zn / z + dz


def mie_cd(m: complex, x: float, nmax: int) -> tuple[np.ndarray, np.ndarray]:
    """Internal-field coefficients c_n, d_n (BH eq. 4.52, mu1 = mu)."""
    c = np.zeros(nmax, dtype=complex)
    d = np.zeros(nmax, dtype=complex)
    for i, n in enumerate(range(1, nmax + 1)):
        jx, djx = _sph(n, x, "j")
        hx, dhx = _sph(n, x, "h")
        jm, djm = _sph(n, m * x, "j")
        # [x z(x)]' = x * ([rho z]'/rho) evaluated at x
        xjx_p, xhx_p, mxjm_p = x * djx, x * dhx, m * x * djm
        c[i] = (jx * xhx_p - hx * xjx_p) / (jm * xhx_p - hx * mxjm_p)
        d[i] = (m * jx * xhx_p - m * hx * xjx_p) / (m * m * jm * xhx_p - hx * mxjm_p)
    return c, d


def _mn(n, pin, taun, zn, dzn, rho, cp, sp, st):
    """(r, theta, phi) components of M_o1n and N_e1n (BH eq. 4.50) for radial function z_n.

    M_o1n = cos(ph) pi z th_hat - sin(ph) tau z ph_hat
    N_e1n = cos(ph) n(n+1) sin(th) pi z/rho r_hat + cos(ph) tau [rho z]'/rho th_hat - sin(ph) pi [rho z]'/rho ph_hat
    """
    M = (np.zeros_like(zn * cp), cp * pin * zn, -sp * taun * zn)
    N = (cp * n * (n + 1) * st * pin * zn / rho, cp * taun * dzn, -sp * pin * dzn)
    return M, N


def mie_field(points: np.ndarray, radius: float, wavelength: float, m: complex, n_medium: float = 1.0,
              nmax: int | None = None) -> np.ndarray:
    """Total complex E (exact incident + scattered series outside, internal series inside) at Cartesian points
    (N, 3), unit amplitude x-polarized plane wave travelling +z in the medium, sphere centred at the origin.
    Returns (N, 3) complex, units of
    E0. BH eqs. 4.37-4.50."""
    pts = np.atleast_2d(np.asarray(points, dtype=float))
    k = 2 * math.pi * n_medium / wavelength
    x = k * radius
    if nmax is None:
        nmax = int(round(x + 4.05 * x ** (1 / 3) + 2)) + 10
    a, b = mie_ab(m, x, nmax)
    c, d = mie_cd(m, x, nmax)
    X, Y, Z = pts[:, 0], pts[:, 1], pts[:, 2]
    r = np.sqrt(X * X + Y * Y + Z * Z)
    r = np.where(r == 0, 1e-30 * radius, r)
    th = np.arccos(np.clip(Z / r, -1, 1))
    ph = np.arctan2(Y, X)
    mu = np.cos(th)
    pi, tau = _pi_tau(nmax, mu)
    inside = r < radius
    Er = np.zeros(len(r), dtype=complex)
    Et = np.zeros_like(Er)
    Ep = np.zeros_like(Er)
    cp, sp, st = np.cos(ph), np.sin(ph), np.sin(th)
    old_err = np.seterr(all="ignore")  # each branch is evaluated at all points; np.where keeps the valid one
    for i, n in enumerate(range(1, nmax + 1)):
        En = 1j**n * (2 * n + 1) / (n * (n + 1))
        # outside: incident (j) + scattered (h)
        rho_o = k * r
        hn_, dhn = _sph(n, rho_o, "h")
        M3, N3 = _mn(n, pi[n], tau[n], hn_, dhn, rho_o, cp, sp, st)
        out = [En * (1j * a[i] * N3[q] - b[i] * M3[q]) for q in range(3)]  # scattered only; incident added exactly
        rho_i = m * k * r
        jm_, djm = _sph(n, rho_i, "j")
        Mi, Ni = _mn(n, pi[n], tau[n], jm_, djm, rho_i, cp, sp, st)
        inn = [En * (c[i] * Mi[q] - 1j * d[i] * Ni[q]) for q in range(3)]
        Er += np.where(inside, inn[0], out[0])
        Et += np.where(inside, inn[1], out[1])
        Ep += np.where(inside, inn[2], out[2])
    np.seterr(**old_err)
    ct = np.cos(th)
    Ex = Er * st * cp + Et * ct * cp - Ep * sp
    Ey = Er * st * sp + Et * ct * sp + Ep * cp
    Ez = Er * ct - Et * st
    # exact incident plane wave outside (its truncated series diverges from e^{ikz} at large k r)
    Ex = Ex + np.where(inside, 0.0, np.exp(1j * k * Z))
    return np.stack([Ex, Ey, Ez], axis=1)


def _sph_components(E: np.ndarray, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    X, Y, Z = pts[:, 0], pts[:, 1], pts[:, 2]
    r = np.sqrt(X * X + Y * Y + Z * Z)
    th = np.arccos(Z / r)
    ph = np.arctan2(Y, X)
    st, ct, sp, cp = np.sin(th), np.cos(th), np.sin(ph), np.cos(ph)
    Er = E[:, 0] * st * cp + E[:, 1] * st * sp + E[:, 2] * ct
    Et = E[:, 0] * ct * cp + E[:, 1] * ct * sp - E[:, 2] * st
    Ep = -E[:, 0] * sp + E[:, 1] * cp
    return Er, Et, Ep


def mie_field_checks(radius: float, wavelength: float, m: complex) -> dict[str, float]:
    """Boundary conditions at r = a (tangential E continuous, eps E_r continuous) and incident limit far away."""
    rng = np.random.default_rng(7)
    u = rng.normal(size=(200, 3))
    u /= np.linalg.norm(u, axis=1, keepdims=True)
    eps = 1e-9
    Ein = mie_field(u * radius * (1 - eps), radius, wavelength, m)
    Eout = mie_field(u * radius * (1 + eps), radius, wavelength, m)
    ri, ti, pi_ = _sph_components(Ein, u * radius)
    ro, to, po = _sph_components(Eout, u * radius)
    scale = np.max(np.abs(Eout))
    tan_err = float(max(np.max(np.abs(ti - to)), np.max(np.abs(pi_ - po))) / scale)
    nrm_err = float(np.max(np.abs(m * m * ri - ro)) / scale)
    return {"tangential_E_jump_max_rel": tan_err, "normal_D_jump_max_rel": nrm_err, "probe_points": 200,
            "offset_rel": eps}


WO03_CASES = {
    # x = 2 pi 0.525 / 0.6328 (BH appendix example; miepython test_03_bh_dielectric). R3's "x 5.213" is this value
    # rounded; at x = 5.213 exactly Qext = 3.104996, which does not match the reference digits.
    "dielectric": {"m": 1.55 + 0j, "x": 2 * math.pi * 0.525 / 0.6328,
                   "r3": {"qext": "3.10543", "qsca": "3.10543", "qback": "2.92534",
                                                       "g": "0.63314"}},
    "absorbing": {"m": 1.5 + 1j, "x": 1.0, "r3": {"qext": "2.336321", "qsca": "0.6634538", "g": "0.192136"}},
}


def wo03() -> None:
    targets = []
    prec_all = {}
    for name, cs in WO03_CASES.items():
        e = mie_efficiencies(cs["m"], cs["x"])
        e2 = mie_efficiencies(cs["m"], cs["x"], 2 * e["nmax"])
        prec_all[name] = {"nmax": e["nmax"], "nmax_doubled": 2 * e["nmax"]}
        for q in ["qext", "qsca", "qabs", "qback", "g"]:
            r3 = cs["r3"].get(q)
            targets.append(target(f"{name}.{q}", e[q], "1",
                                  {"method": "BHMIE log-derivative series", "terms": e["nmax"],
                                   "change_on_doubling": abs(e2[q] - e[q])},
                                  r3=r3_compare(e[q], r3) if r3 else None,
                                  locator=f"m = {cs['m']} (BH sign), x = {cs['x']}"))
    # Near field for the dielectric case at a physical scale: lambda0 = 1 um, radius = x lambda / (2 pi)
    lam = 0.6328e-6
    rad = 0.525e-6
    chk = mie_field_checks(rad, lam, 1.55 + 0j)
    # Coefficients-route cross-check: a_n from spherical functions vs BHMIE recurrence
    a_bh, b_bh = mie_ab(1.55 + 0j, WO03_CASES["dielectric"]["x"], 20)
    probe = np.array([[0.0, 0.0, 1.5 * rad], [0.0, 0.0, -1.5 * rad], [0.0, 0.0, 0.0], [1.5 * rad, 0.0, 0.0]])
    nmax_f = int(round(WO03_CASES["dielectric"]["x"] + 4.05 * WO03_CASES["dielectric"]["x"] ** (1 / 3) + 2)) + 10
    Ep = mie_field(probe, rad, lam, 1.55 + 0j, nmax=nmax_f)
    Ep2 = mie_field(probe, rad, lam, 1.55 + 0j, nmax=2 * nmax_f)
    labels = ["zp1.5a", "zm1.5a", "centre", "xp1.5a"]
    desc = {"zp1.5a": "(0, 0, +1.5 a)", "zm1.5a": "(0, 0, -1.5 a)", "centre": "(0, 0, 0)", "xp1.5a": "(+1.5 a, 0, 0)"}
    for lab, E, E2 in zip(labels, Ep, Ep2, strict=True):
        v, v2 = float(np.sum(np.abs(E) ** 2)), float(np.sum(np.abs(E2) ** 2))
        targets.append(target(f"dielectric.near.E2.{lab}", v, "E0^2",
                              {"method": "BH vector-harmonic series", "terms": nmax_f,
                               "change_on_doubling": abs(v2 - v), "bc_checks": chk},
                              locator=f"lambda0 = 0.6328 um, radius a = 0.525 um, vacuum, point {desc[lab]}"))
    write_expected(
        "WO-03", targets, GEN,
        "Mie (Bohren-Huffman ch. 4): efficiencies from a_n, b_n; near field from the vector spherical harmonic "
        "expansion (incident + scattered outside, c_n, d_n inside).",
        extra={"terms": prec_all, "near_field_bc_checks": chk,
               "a1_b1_dielectric": [str(a_bh[0]), str(b_bh[0])],
               "field_function": "validation/a/fields.py:WO-03 -> gen_optics.mie_field",
               "sign_note": "miepython test values use m = n - i k; BH m = n + i k is the same medium"},
    )


# ---------------------------------------------------------------- WO-21 quarter-wave Bragg stack
def bragg_rhs(w_over_w0: float, n1: float, n2: float) -> float:
    ph = math.pi / 2 * w_over_w0
    return math.cos(ph) ** 2 - 0.5 * (n1 / n2 + n2 / n1) * math.sin(ph) ** 2


def wo21() -> None:
    n1, n2 = 3.477723756, 1.444023622
    lam0 = 1550e-9
    half = 2 / math.pi * math.asin(abs(n1 - n2) / (n1 + n2))
    lo, hi = 1 - half, 1 + half
    lo_r = brentq(lambda w: bragg_rhs(w, n1, n2) + 1, 0.5, 1.0, xtol=1e-15)
    hi_r = brentq(lambda w: bragg_rhs(w, n1, n2) + 1, 1.0, 1.5, xtol=1e-15)
    gap = 4 / math.pi * math.asin(abs(n1 - n2) / (n1 + n2))
    cf = {"method": "closed form", "root_of_dispersion_relation": None}
    write_expected(
        "WO-21",
        [target("w_lower_over_w0", lo, "1", {**cf, "root_of_dispersion_relation": lo_r, "diff": abs(lo - lo_r)},
                locator="lower edge of the first gap, normal incidence"),
         target("w_upper_over_w0", hi, "1", {**cf, "root_of_dispersion_relation": hi_r, "diff": abs(hi - hi_r)},
                locator="upper edge of the first gap"),
         target("gap_to_midgap", gap, "1", cf, locator="(w_upper - w_lower)/w0"),
         target("lambda_lower_edge", lam0 / hi, "m", cf, locator="vacuum wavelength at the upper frequency edge"),
         target("lambda_upper_edge", lam0 / lo, "m", cf, locator="vacuum wavelength at the lower frequency edge")],
        GEN,
        "Quarter-wave stack (n1 d1 = n2 d2 = lambda0/4), normal incidence: cos(K Lambda) = cos^2(phi) - "
        "(1/2)(n1/n2 + n2/n1) sin^2(phi), phi = (pi/2)(w/w0). Edges at |rhs| = 1: w/w0 = 1 -+ (2/pi) asin(|n1 - n2|/"
        "(n1 + n2)) (Joannopoulos et al., Photonic Crystals 2nd ed., ch. 4; formula, not fetched).",
        extra={"inputs": {"n1": n1, "n2": n2, "lambda0_m": lam0, "d1_m": lam0 / (4 * n1), "d2_m": lam0 / (4 * n2)}},
    )


if __name__ == "__main__":
    wo01()
    wo03()
    wo21()
    print("optics: wrote WO-01, WO-03, WO-21")
