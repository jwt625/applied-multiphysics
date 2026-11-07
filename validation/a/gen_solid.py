# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-a solid-mechanics generators.

SM-01 Kirsch (full field, exposed for field-error metrics), SM-03 Euler column, SM-04 Hertz sphere on a rigid plane,
SM-07 plastic hinge (rectangular section, elastic-perfectly plastic), SM-21 Lame hollow cylinder (Code_Aster SSLV04A),
CP-21 NAFEMS T1 circular hot spot (eigenstrain inclusion, plane stress).

Run: cd validation && uv run python a/gen_solid.py
"""

from __future__ import annotations

import math

import numpy as np
from common import r3_compare, target, write_expected

GEN = "validation/a/gen_solid.py"
IN = 0.0254  # m, exact
LBF = 4.4482216152605  # N, exact (international pound-force)
PSI = LBF / IN**2  # Pa


# ---------------------------------------------------------------- SM-01 Kirsch
def kirsch_field(x, y, a: float, s_inf: float, E: float, nu: float, plane: str = "stress") -> dict[str, np.ndarray]:
    """Kirsch solution: infinite plate, hole radius a at the origin, uniaxial remote stress s_inf along x.

    Returns Cartesian stresses (Pa) and displacements (m) at points (x, y) with r >= a. Displacements are fixed by
    u = 0 on the symmetry lines (u_y = 0 on y = 0, u_x = 0 on x = 0), i.e. no rigid-body term.
    Formulas: Kirsch 1898; displacement form as in Barber, Elasticity, sec. 8.4 (kappa = (3 - nu)/(1 + nu) for plane
    stress, 3 - 4 nu for plane strain).
    """
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    r = np.hypot(x, y)
    th = np.arctan2(y, x)
    q = (a / r) ** 2
    c2, s2 = np.cos(2 * th), np.sin(2 * th)
    h = s_inf / 2
    srr = h * (1 - q) + h * (1 - 4 * q + 3 * q * q) * c2
    stt = h * (1 + q) - h * (1 + 3 * q * q) * c2
    srt = -h * (1 + 2 * q - 3 * q * q) * s2
    mu = E / (2 * (1 + nu))
    kap = (3 - nu) / (1 + nu) if plane == "stress" else 3 - 4 * nu
    ur = s_inf / (4 * mu) * (r * ((kap - 1) / 2 + c2) + a * a / r * (1 + (1 + kap) * c2) - a**4 / r**3 * c2)
    ut = s_inf / (4 * mu) * ((1 - kap) * a * a / r - r - a**4 / r**3) * s2
    c, s = np.cos(th), np.sin(th)
    sxx = srr * c * c + stt * s * s - 2 * srt * s * c
    syy = srr * s * s + stt * c * c + 2 * srt * s * c
    sxy = (srr - stt) * s * c + srt * (c * c - s * s)
    ux = ur * c - ut * s
    uy = ur * s + ut * c
    return {"sxx": sxx, "syy": syy, "sxy": sxy, "ux": ux, "uy": uy, "srr": srr, "stt": stt, "srt": srt}


SM01 = {"a": 5.0e-3, "L": 50.0e-3, "s_inf": 100.0e6, "E": 200.0e9, "nu": 0.3}


def kirsch_self_check(p: dict[str, float]) -> dict[str, float]:
    """Finite-difference checks: Hooke's law from the displacement field and equilibrium of the stress field."""
    rng = np.random.default_rng(20261106)
    pts = rng.uniform(-p["L"], p["L"], size=(400, 2))
    pts = pts[np.hypot(pts[:, 0], pts[:, 1]) > 1.2 * p["a"]]
    hd = 1e-7
    a, s, E, nu = p["a"], p["s_inf"], p["E"], p["nu"]

    def f(x, y):
        return kirsch_field(x, y, a, s, E, nu)

    X, Y = pts[:, 0], pts[:, 1]
    fxp, fxm, fyp, fym = f(X + hd, Y), f(X - hd, Y), f(X, Y + hd), f(X, Y - hd)
    exx = (fxp["ux"] - fxm["ux"]) / (2 * hd)
    eyy = (fyp["uy"] - fym["uy"]) / (2 * hd)
    gxy = (fyp["ux"] - fym["ux"]) / (2 * hd) + (fxp["uy"] - fxm["uy"]) / (2 * hd)
    f0 = f(X, Y)
    c = E / (1 - nu**2)
    sxx = c * (exx + nu * eyy)
    syy = c * (eyy + nu * exx)
    sxy = E / (2 * (1 + nu)) * gxy
    hooke = max(np.max(np.abs(sxx - f0["sxx"])), np.max(np.abs(syy - f0["syy"])), np.max(np.abs(sxy - f0["sxy"]))) / s
    eq1 = (fxp["sxx"] - fxm["sxx"]) / (2 * hd) + (fyp["sxy"] - fym["sxy"]) / (2 * hd)
    eq2 = (fxp["sxy"] - fxm["sxy"]) / (2 * hd) + (fyp["syy"] - fym["syy"]) / (2 * hd)
    equil = max(np.max(np.abs(eq1)), np.max(np.abs(eq2))) * a / s
    far = f(np.array([1e3 * a]), np.array([0.0]))
    return {"hooke_max_rel_fd": float(hooke), "equilibrium_max_rel_fd": float(equil),
            "sxx_at_r_1000a_over_s_inf": float(far["sxx"][0] / s), "fd_step_m": hd, "points": int(len(X))}


def sm01() -> None:
    p = SM01
    a, s, E, nu, L = p["a"], p["s_inf"], p["E"], p["nu"], p["L"]
    top = kirsch_field(np.array([0.0]), np.array([a]), a, s, E, nu)
    side = kirsch_field(np.array([a]), np.array([0.0]), a, s, E, nu)
    corner = kirsch_field(np.array([L]), np.array([0.0]), a, s, E, nu)
    corner2 = kirsch_field(np.array([0.0]), np.array([L]), a, s, E, nu)
    kt = float(top["sxx"][0] / s)
    chk = kirsch_self_check(p)
    closed = {"method": "closed form", "self_check": chk}
    write_expected(
        "SM-01",
        [
            target("K_t", kt, "1", closed, r3=r3_compare(kt, "3"), locator="sigma_xx / sigma_inf at (0, a), hole edge"),
            target("sxx_hole_top", float(top["sxx"][0]), "Pa", closed, locator="(0, a)"),
            target("syy_hole_side", float(side["syy"][0]), "Pa", closed, locator="(a, 0); = -sigma_inf"),
            target("ux_at_L_0", float(corner["ux"][0]), "m", closed, locator="(L, 0)"),
            target("uy_at_0_L", float(corner2["uy"][0]), "m", closed, locator="(0, L)"),
            target("field_rel_L2_stress", 0.0, "1", closed,
                   locator="||sigma_h - sigma_exact||_L2 / ||sigma_exact||_L2 over the quarter domain; exact field "
                           "from validation/a/fields.py SM-01"),
        ],
        GEN,
        "Kirsch 1898 stress field; plane-stress displacement field (Barber sec. 8.4 form). Quarter domain with "
        "exact Kirsch traction on the outer edges reproduces the infinite-plate field exactly.",
        extra={"inputs": p, "field_function": "validation/a/fields.py:SM-01 -> gen_solid.kirsch_field"},
    )


# ---------------------------------------------------------------- SM-03 Euler column
def sm03() -> None:
    L, b, E = 200 * IN, 0.5 * IN, 30e6 * PSI
    I = b**4 / 12  # noqa: E741
    F = math.pi**2 * E * I / L**2
    write_expected(
        "SM-03",
        [target("F_cr", F, "N", {"method": "closed form"}, locator="first buckling load, pinned-pinned"),
         target("F_cr_lbf", F / LBF, "lbf", {"method": "closed form"}, r3=r3_compare(F / LBF, "38.553"),
                locator="same, US units as Ansys VM127")],
        GEN, "Euler: F_cr = pi^2 E I / L^2, I = b^4/12; inputs converted exactly "
             "(in = 0.0254 m, lbf = 4.4482216152605 N)",
        extra={"inputs_SI": {"L_m": L, "b_m": b, "E_Pa": E, "I_m4": I}},
    )


# ---------------------------------------------------------------- SM-04 Hertz
def sm04() -> None:
    R, E, nu, F = 8.0e-3, 1000.0e6, 0.3, 60 * math.pi
    Es = E / (1 - nu**2)  # rigid plane: 1/E* = (1 - nu^2)/E
    a = (3 * F * R / (4 * Es)) ** (1 / 3)
    p0 = 3 * F / (2 * math.pi * a * a)
    delta = a * a / R
    cf = {"method": "closed form"}
    write_expected(
        "SM-04",
        [target("a_contact", a, "m", cf, r3=r3_compare(a * 1e3, "1.00964", "compared in mm"),
                locator="contact radius", informative={"ansys_vm63_target_mm": 1.010}),
         target("p0", p0, "Pa", cf, locator="peak contact pressure, r = 0"),
         target("delta", delta, "m", cf, locator="approach of the sphere centre relative to the plane")],
        GEN, "Hertz (Timoshenko-Goodier art. 140): a = (3 F R / (4 E*))^(1/3), E* = E/(1 - nu^2) for a rigid plane, "
             "p0 = 3F/(2 pi a^2), delta = a^2/R",
        extra={"inputs": {"R_m": R, "E_Pa": E, "nu": nu, "F_N": F}},
    )


# ---------------------------------------------------------------- SM-07 plastic hinge
def sm07() -> None:
    L, b, h, E, sy = 10 * IN, 1 * IN, 2 * IN, 30e6 * PSI, 36000 * PSI
    myp = sy * b * h * h / 6
    kyp = 2 * sy / (E * h)
    th_yp = kyp * L
    targets = [target("M_yp", myp, "N m", {"method": "closed form"},
                      r3=r3_compare(myp / (LBF * IN), "24000", "compared in in-lb"), locator="first yield moment")]
    for m_lit, m_exact, r3 in [("1.0", 1.0, "0.01200"), ("1.1666", 7 / 6, "0.01469"), ("1.3333", 4 / 3, "0.02078")]:
        for label, m in [("literal", float(m_lit)), ("exact_fraction", m_exact)]:
            th = th_yp / math.sqrt(3 - 2 * m)
            targets.append(target(f"rotation.m{m_lit}.{label}", th, "rad",
                                  {"method": "closed form", "M_over_Myp": m},
                                  r3=r3_compare(th, r3) if label == "literal" else None,
                                  locator="end-to-end rotation over L = 10 in under pure bending"))
    write_expected(
        "SM-07", targets, GEN,
        "Rectangular section, elastic-perfectly plastic: M/M_yp = 1.5 (1 - (kappa_yp/kappa)^2 / 3), so "
        "theta = kappa L = (2 sigma_y L / (E h)) / sqrt(3 - 2 M/M_yp); collapse at M/M_yp = 1.5 (theta -> inf).",
        extra={"inputs_SI": {"L_m": L, "b_m": b, "h_m": h, "E_Pa": E, "sigma_y_Pa": sy}},
    )


# ---------------------------------------------------------------- SM-21 Lame hollow cylinder (Code_Aster SSLV04A)
def lame(r: float, a: float, b: float, p: float, E: float, nu: float) -> tuple[float, float, float]:
    A = p * a * a / (b * b - a * a)
    B = p * a * a * b * b / (b * b - a * a)
    srr, stt = A - B / r**2, A + B / r**2
    u = ((1 - nu) * A * r + (1 + nu) * B / r) / E  # plane stress
    return u, srr, stt


def sm21() -> None:
    a, b, p, E, nu = 0.1, 0.2, 60.0, 200000.0, 0.3
    uA, srA, stA = lame(a, a, b, p, E, nu)
    uB, _, _ = lame(b, a, b, p, E, nu)
    s225, c225 = math.sin(math.pi / 8), math.cos(math.pi / 8)
    s45 = math.sqrt(0.5)
    cf = {"method": "closed form (Lame, plane stress)"}
    refs = {  # Code_Aster sslv04a.comm VALE_REFE (REFERENCE='ANALYTIQUE'), for agreement
        "DX_A": 5.9e-05, "DX_B": 4.0e-05, "DX_D": 3.69552e-05, "DY_D": 1.53073e-05, "DX_E": 4.17193e-05,
        "DX_F": 2.82843e-05, "SIXX_A": -60.0, "SIYY_A": 100.0, "EPXX_A": -4.5e-4, "EPYY_A": 5.9e-4}
    vals = {
        "DX_A": uA, "DX_B": uB, "DX_D": uB * c225, "DY_D": uB * s225, "DX_E": uA * s45, "DX_F": uB * s45,
        "SIXX_A": srA, "SIYY_A": stA, "EPXX_A": (srA - nu * stA) / E, "EPYY_A": (stA - nu * srA) / E}
    units = {"SIXX_A": "MPa", "SIYY_A": "MPa", "EPXX_A": "1", "EPYY_A": "1"}
    targets = []
    for k, v in vals.items():
        rr = refs[k]
        targets.append(target(k, v, units.get(k, "length unit of the mesh (E in MPa)"), cf,
                              code_aster_vale_refe=rr, rel_diff_vs_code_aster=abs(v - rr) / abs(rr)))
    write_expected(
        "SM-21", targets, GEN,
        "Lame thick cylinder, internal pressure p, plane stress. Radii a = 0.1, b = 0.2 are inferred: b/a = 2 is the "
        "unique root of u(a)/u(b) = 5.9/4.0 and a = 0.1 then follows from u(b) = 2 A b / E = 4.0e-5.",
        extra={"inputs": {"a": a, "b": b, "p_MPa": p, "E_MPa": E, "nu": nu}},
    )


# ---------------------------------------------------------------- CP-21 NAFEMS T1 hot spot
def hot_spot(a: float, R: float | None, E: float, nu: float, estar: float) -> float:
    """Hoop stress just outside a circular eigenstrain inclusion (plane stress, same material).

    R = None: infinite plate (closed form E e*/2). Else free outer disk of radius R (linear 3x3 solve).
    """
    if R is None:
        return E * estar / 2
    # inside u = C r; outside u = D r + F / r. Unknowns C, D, F.
    k = E / (1 - nu**2)
    # sigma_r inside = k ((1 + nu) C - (1 + nu) e*); outside = k ((1 + nu) D - (1 - nu) F / r^2)
    M = np.array([[a, -a, -1 / a],
                  [k * (1 + nu), -k * (1 + nu), k * (1 - nu) / a**2],
                  [0.0, k * (1 + nu), -k * (1 - nu) / R**2]])
    rhs = np.array([0.0, k * (1 + nu) * estar, 0.0])
    C, D, F = np.linalg.solve(M, rhs)
    del C
    return float(k * ((1 + nu) * D + (1 - nu) * F / a**2))  # sigma_theta outside at r = a+


def cp21() -> None:
    E, nu, estar, a = 100e9, 0.3, 1e-5 * 100, 1.0
    s_inf = hot_spot(a, None, E, nu, estar)
    s_R10 = hot_spot(a, 10.0, E, nu, estar)
    s_R10_cf = E * estar * (10.0**2 + a * a) / (2 * 10.0**2)
    write_expected(
        "CP-21",
        [target("sigma_yy_D_infinite", s_inf, "Pa", {"method": "closed form E e*/2"},
                locator="D = (a+, 0), infinite plane-stress plate"),
         target("sigma_yy_D_free_disk_R10", s_R10, "Pa",
                {"method": "3x3 linear solve", "closed_form": s_R10_cf, "diff": abs(s_R10 - s_R10_cf)},
                locator="D, free disk R = 10 a (inscribed circle of the 10 x 10 quarter); bound, not the gate")],
        GEN,
        "Circular eigenstrain inclusion e* = alpha dT (alpha 1e-5 /C, dT 100 C), plane stress, same E, nu inside and "
        "out: sigma_theta(a+) = E e*/2 (infinite plate), E e* (R^2 + a^2)/(2 R^2) (free disk R).",
        extra={"inputs": {"E_Pa": E, "nu": nu, "eigenstrain": estar, "a": a}},
    )


# ---------------------------------------------------------------- SM-06 NAFEMS FV12, Kirchhoff free square plate (Ritz)
FV12 = {"E": 200.0e9, "nu": 0.3, "rho": 8000.0, "t": 0.05, "a": 10.0}


def fv12_ritz(N: int, p: dict[str, float] = FV12, nq: int = 96) -> np.ndarray:
    """Rayleigh-Ritz, Kirchhoff plate, all edges free. Basis T_i(xi) T_j(eta), Chebyshev polynomials of the first
    kind on [-1, 1], i, j < N; exact Gauss-Legendre quadrature (degree <= 2N - 2 < 2 nq - 1). Returns f (Hz), sorted,
    rigid-body modes included. Energy: D int [w_xx^2 + w_yy^2 + 2 nu w_xx w_yy + 2 (1 - nu) w_xy^2] dA."""
    from numpy.polynomial import chebyshev as Ch
    from scipy.linalg import eigh

    E, nu, rho, t, a = p["E"], p["nu"], p["rho"], p["t"], p["a"]
    D = E * t**3 / (12 * (1 - nu**2))
    s = a / 2
    xg, wg = np.polynomial.legendre.leggauss(nq)
    I = np.eye(N)  # noqa: E741
    V0 = np.array([Ch.chebval(xg, I[i]) for i in range(N)])
    V1 = np.array([Ch.chebval(xg, Ch.chebder(I[i], 1)) for i in range(N)]) / s
    V2 = np.array([Ch.chebval(xg, Ch.chebder(I[i], 2)) for i in range(N)]) / s**2
    W = wg * s
    A00, A11, A22, A02 = (V0 * W) @ V0.T, (V1 * W) @ V1.T, (V2 * W) @ V2.T, (V0 * W) @ V2.T
    # index (i, j) -> i * N + j with w = sum c_ij phi_i(x) phi_j(y)
    K = D * (np.kron(A22, A00) + np.kron(A00, A22) + nu * (np.kron(A02.T, A02) + np.kron(A02, A02.T))
             + 2 * (1 - nu) * np.kron(A11, A11))
    M = rho * t * np.kron(A00, A00)
    w2 = eigh(K, M, eigvals_only=True)
    return np.sqrt(np.clip(w2, 0, None)) / (2 * np.pi)


def sm06() -> None:
    levels = [10, 14, 18, 22, 26]
    res = {N: fv12_ritz(N) for N in levels}
    fin = res[levels[-1]]
    prev = res[levels[-2]]
    nafems = {4: 1.622, 5: 2.360, 6: 2.922, 7: 4.233, 8: 4.233, 9: 7.416}
    rigid = [float(x) for x in fin[:3]]
    targets = []
    for mode in range(4, 11):
        v = float(fin[mode - 1])
        ref = nafems.get(mode)
        targets.append(target(
            f"f_mode{mode}", v, "Hz",
            {"method": "Rayleigh-Ritz, Chebyshev tensor basis", "basis_per_direction": levels[-1],
             "change_vs_previous_level": abs(v - float(prev[mode - 1])),
             "levels": {str(N): float(res[N][mode - 1]) for N in levels}},
            locator=f"mode {mode} in ascending order (modes 1-3 rigid)",
            nafems_value=ref, nafems_minus_ritz_rel=(ref - v) / v if ref else None))
    write_expected(
        "SM-06", targets, GEN,
        "Kirchhoff thin plate, free square, Rayleigh-Ritz (upper bound, converges from above). Midsurface model: "
        "in-plane motion decoupled, so only flexural modes. Shear deformation and rotary inertia neglected "
        "(t/a = 0.005; Mindlin correction est. < 1e-3 rel. for these modes, not computed).",
        extra={"inputs": FV12, "rigid_modes_Hz": rigid},
    )


if __name__ == "__main__":
    sm01()
    sm03()
    sm04()
    sm06()
    sm07()
    sm21()
    cp21()
    print("solid: wrote SM-01, SM-03, SM-04, SM-06, SM-07, SM-21, CP-21")
