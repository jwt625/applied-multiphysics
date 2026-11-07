# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-c generators that re-derive open-suite / vendor-verification targets from closed forms
(lane L7c, DevLog-008). Only inputs and target numbers are cited; no text or input file is copied.

  EM-05  Ansys VM166 (target: Emson, RAL-86-049, 1986, p. 39): hollow Al cylinder in a uniform 60 Hz
         transverse field. Exact 2D magnetoquasistatic solution (modified Bessel functions).
  CP-03  Ansys VM58 (target: Rohsenow-Choi 1963 ex. 6.5): wire with uniform heat generation and surface
         convection. Closed form.
  SM-61  Code_Aster astest/sdll01a.comm (tag 17.5.8, GPL-3.0-or-later): short simply supported Timoshenko
         beam, in-plane bending and axial modes. Closed form (Timoshenko frequency equation).
  HT-61  scikit-fem tests/test_examples.py TestEx01 (tag 12.0.2, BSD-3-Clause): -lap u = 1 on the unit square,
         u = 0 on the boundary; maximum of u by the double Fourier series.

Run: cd validation && uv run python c/gen_suites.py
"""

from __future__ import annotations

import math

import numpy as np
from common_c import MU0, source_compare, target, write_expected
from scipy import integrate, special

GEN = "validation/c/gen_suites.py"


def em05() -> None:
    ri, ro, sigma, f, b0 = 0.05715, 0.06985, 2.5380711e7, 60.0, 0.1
    w = 2 * math.pi * f
    kap = np.sqrt(1j * w * MU0 * sigma)  # e^{+j w t} phasor; A_z = f(r) cos(theta), B_y(far) = B0
    # unknowns C (inside: f = C r), D, E (shell: D I1 + E K1), F (outside: f = -B0 r + F / r)
    i1, k1 = special.iv, special.kv

    def di1(z):
        return special.ivp(1, z)

    def dk1(z):
        return special.kvp(1, z)

    m = np.array(
        [
            [ri, -i1(1, kap * ri), -k1(1, kap * ri), 0],
            [1, -kap * di1(kap * ri), -kap * dk1(kap * ri), 0],
            [0, i1(1, kap * ro), k1(1, kap * ro), -1 / ro],
            [0, kap * di1(kap * ro), kap * dk1(kap * ro), 1 / ro**2],
        ],
        dtype=complex,
    )
    rhs = np.array([0, 0, -b0 * ro, -b0], dtype=complex)
    c, d, e, ff = np.linalg.solve(m, rhs)
    by0 = -c  # B_y = -dA/dx, A = C x inside

    def fr(r):
        return d * i1(1, kap * r) + e * k1(1, kap * r)

    # time-averaged loss per unit length: (1/2) sigma w^2 int |A|^2 dA, int cos^2 = pi
    loss = 0.5 * sigma * w**2 * math.pi * integrate.quad(lambda r: abs(fr(r)) ** 2 * r, ri, ro, limit=200)[0]
    # far field: A = -B0 r cos(theta) = -B0 x -> B_y = -dA/dx = +B0. Inside B_y = -C.
    by0_c = complex(by0)
    tg = [
        target(
            "By_center_re",
            by0_c.real,
            "T",
            {"method": "exact Bessel solution, 4x4 interface system"},
            source_compare(by0_c.real, "-0.0018", 1.0, "VM166 target By(0,0) real part"),
            locator="Ansys VM166 Results Comparison, Target column",
            phasor_convention="e^{+j w t}",
        ),
        target(
            "By_center_im",
            by0_c.imag,
            "T",
            {"method": "exact Bessel solution"},
            source_compare(by0_c.imag, "-0.0210", 1.0, "VM166 target By(0,0) imaginary part"),
            locator="Ansys VM166 Results Comparison, Target column",
            phasor_convention="e^{+j w t}",
        ),
        target(
            "loss_per_length",
            loss,
            "W/m",
            {"method": "(1/2) sigma w^2 pi int |f(r)|^2 r dr, scipy quad, full cross-section, time average"},
            source_compare(loss, "2288", 1.0, "VM166 target power loss (see quarter-section target)"),
            locator="Ansys VM166 Results Comparison, Target column",
        ),
        target(
            "loss_per_length_quarter",
            loss / 4,
            "W/m",
            {"method": "full-section loss / 4"},
            source_compare(loss / 4, "2288", 1.0, "VM166 target power loss"),
            locator="Ansys VM166 Results Comparison, Target column",
            note="the VM166 target equals one quarter of the full-section time-averaged loss; inferred to be "
            "a quarter-symmetry model value (assumption, the page does not state it)",
        ),
    ]
    write_expected(
        "EM-05",
        tg,
        GEN,
        "Infinitely long hollow conducting cylinder in a uniform transverse time-harmonic field, "
        "A_z = f(r) cos(theta); inside f = C r, shell f = D I1(kr) + E K1(kr) with k^2 = j w mu0 sigma, "
        "outside f = -B0 r + F/r; continuity of f and f' at r_i and r_o (mu = mu0 everywhere).",
        extra={
            "inputs": {
                "r_i_m": ri,
                "r_o_m": ro,
                "sigma_S_per_m": sigma,
                "f_Hz": f,
                "B0_T": b0,
                "B0_meaning": "peak amplitude of the applied field B_y = B0 cos(w t)",
            },
            "far_field": "A = -B0 r cos(theta) -> B_y = +B0",
        },
    )


def cp03() -> None:
    btu_hr = 0.29307107  # W per Btu/hr (IT)
    ft = 0.3048
    k = 13 * btu_hr / (ft * 5 / 9)  # Btu/hr-ft-F -> W/(m K)
    h = 5 * btu_hr / (ft**2 * 5 / 9)  # Btu/hr-ft2-F -> W/(m2 K)
    qv = 111311.7 * btu_hr / ft**3  # Btu/hr-ft3 -> W/m3
    r0 = 0.375 * 0.0254
    ta = (70 - 32) * 5 / 9 + 273.15
    ts = ta + qv * r0 / (2 * h)
    tc = ts + qv * r0**2 / (4 * k)
    q = qv * math.pi * r0**2 * ft  # 1 ft of wire

    def f_of(t):
        return (t - 273.15) * 9 / 5 + 32

    tg = [
        target(
            "T_center",
            tc,
            "K",
            {"method": "closed form T_a + q r0/(2h) + q r0^2/(4k)"},
            source_compare(f_of(tc), "419.9", 1.0, "VM58 target, degF"),
            locator="Ansys VM58 Results Comparison",
            value_degF=f_of(tc),
        ),
        target(
            "T_surface",
            ts,
            "K",
            {"method": "closed form T_a + q r0/(2h)"},
            source_compare(f_of(ts), "417.9", 1.0, "VM58 target, degF"),
            locator="Ansys VM58 Results Comparison",
            value_degF=f_of(ts),
        ),
        target(
            "q_per_ft",
            q,
            "W",
            {"method": "q''' pi r0^2 x 1 ft"},
            source_compare(q / btu_hr, "341.5", 1.0, "VM58 target, Btu/hr"),
            locator="Ansys VM58 Results Comparison",
            value_Btu_per_hr=q / btu_hr,
        ),
    ]
    write_expected(
        "CP-03",
        tg,
        GEN,
        "Long cylindrical wire, uniform volumetric heat generation, convection to air: 1D radial "
        "conduction closed form. Inputs converted from US units (Btu IT = 1055.05585262 J).",
        extra={
            "inputs_SI": {
                "k_W_per_mK": k,
                "h_W_per_m2K": h,
                "q_W_per_m3": qv,
                "r0_m": r0,
                "T_air_K": ta,
                "length_m": ft,
            },
            "inputs_source_units": {
                "k": "13 Btu/hr-ft-F",
                "h": "5 Btu/hr-ft2-F",
                "q": "111311.7 Btu/hr-ft3",
                "r0": "0.375 in",
                "T_air": "70 F",
            },
        },
    )


def sm61() -> None:
    e_mod, nu, rho, length = 2.0e11, 0.3, 7800.0, 1.0
    area, iz = 0.02, 0.6666667e-4
    cisa = 1.17692  # Code_Aster AY/AZ: area / shear area
    kappa = 1 / cisa
    g = e_mod / (2 * (1 + nu))
    freqs = []
    for n in range(1, 8):
        kn = n * math.pi / length
        a4 = rho**2 * iz / (kappa * g)
        a2 = -(rho * area + rho * iz * kn**2 * (1 + e_mod / (kappa * g)))
        a0 = e_mod * iz * kn**4
        disc = math.sqrt(a2 * a2 - 4 * a4 * a0)
        w2 = (-a2 - disc) / (2 * a4)
        freqs.append(("bending", n, math.sqrt(w2) / (2 * math.pi)))
    c_bar = math.sqrt(e_mod / rho)
    for m_ in range(1, 4):
        freqs.append(("axial", m_, (2 * m_ - 1) * c_bar / (4 * length)))
    freqs = sorted([f for f in freqs if 430.0 <= f[2] <= 4500.0], key=lambda f: f[2])
    refs = ["431.555", "1265.924", "1498.295", "2870.661", "3797.773", "4377.837"]
    tg = []
    for i, (kind, n, fr) in enumerate(freqs[:6]):
        tg.append(
            target(
                f"f{i + 1}",
                fr,
                "Hz",
                {"method": f"closed form ({kind} n = {n})", "kind": kind, "order": n},
                source_compare(fr, refs[i], 1.0, f"sdll01a.comm TEST_RESU NUME_ORDRE={i + 1} VALE_REFE"),
                locator="gitlab.com/codeaster/src tag 17.5.8 astest/sdll01a.comm L186-246",
            )
        )
    write_expected(
        "SM-61",
        tg,
        GEN,
        "Simply supported Timoshenko beam (supports on the neutral fibre), L 1 m, section 0.2 x 0.1 m "
        "(I_z = 6.6667e-5 m^4), shear coefficient 1/1.17692, E 2e11 Pa, nu 0.3, rho 7800 kg/m3: "
        "in-plane bending (Timoshenko frequency equation, lower branch) and axial fixed-free modes "
        "(the axial condition follows from DX fixed at one support only), modes in 430-4500 Hz.",
        extra={
            "inputs": {"E_Pa": e_mod, "nu": nu, "rho": rho, "L_m": length, "A_m2": area, "Iz_m4": iz, "kappa": kappa}
        },
    )


def ht61() -> None:
    # u(1/2, 1/2) = sum_{m,n odd} 16 / (pi^4 m n (m^2 + n^2)) sin(m pi/2) sin(n pi/2)
    s = 0.0
    nmax = 4001
    m = np.arange(1, nmax + 1, 2, dtype=float)
    sg = np.where(((m - 1) / 2) % 2 == 0, 1.0, -1.0)
    mm, nn = np.meshgrid(m, m, indexing="ij")
    ss = np.outer(sg, sg)
    terms = 16 / (math.pi**4 * mm * nn * (mm**2 + nn**2)) * ss
    s = float(terms.sum())
    half = float(terms[: m.size // 2, : m.size // 2].sum())
    tg = [
        target(
            "u_max",
            s,
            "1",
            {"method": "double sine series, odd m, n <= 4001", "change_vs_half": s - half},
            source_compare(
                s, "0.073657185490792", 1.0, "scikit-fem TestEx01 P1 solution on MeshTri().refined(6); FEM, not exact"
            ),
            locator="github.com/kinnala/scikit-fem tag 12.0.2 tests/test_examples.py L12",
        )
    ]
    write_expected(
        "HT-61",
        tg,
        GEN,
        "Poisson -lap u = 1 on (0,1)^2, u = 0 on the boundary; u_max = u(1/2, 1/2) by the double Fourier sine series.",
        extra={"inputs": {"f": 1.0, "domain": "(0,1)^2"}},
    )


def rf62() -> None:
    from common_c import C0, EPS0

    s_w, w_g, eps_r = 20e-6, 5e-6, 11.7
    k = s_w / (s_w + 2 * w_g)
    kk = special.ellipk(k**2) / special.ellipk(1 - k**2)
    eps_eff = (eps_r + 1) / 2
    c = 4 * EPS0 * eps_eff * kk
    c0 = 4 * EPS0 * kk
    n_rf = math.sqrt(c / c0)
    z0 = 1 / (C0 * math.sqrt(c * c0))
    loc = "eo-modulator-atlas validation/reference/K6a.json closed_form_t0_infinite; DevLog-028 L345-347"
    tg = [
        target(
            "C_per_length",
            c,
            "F/m",
            {"method": "conformal map, zero-thickness CPW on a dielectric half-space"},
            source_compare(c, "213.7269", 1e-12, "K6a closed form (pF/m)"),
            locator=loc,
        ),
        target(
            "n_rf",
            n_rf,
            "1",
            {"method": "sqrt(C / C0)"},
            source_compare(n_rf, "2.519921", 1.0, "K6a closed form"),
            locator=loc,
        ),
        target(
            "Z0",
            z0,
            "ohm",
            {"method": "1 / (c sqrt(C C0))"},
            source_compare(z0, "39.3285", 1.0, "K6a closed form"),
            locator=loc,
        ),
    ]
    write_expected(
        "RF-62",
        tg,
        GEN,
        "Coplanar waveguide S 20 um / W 5 um, zero thickness, semi-infinite grounds, on a dielectric "
        "half-space eps_r 11.7 under air: quasi-static C', n_RF, Z0 by conformal mapping.",
        extra={"inputs": {"S_m": s_w, "W_m": w_g, "eps_r": eps_r, "k": k}},
    )


def wo05() -> None:
    """Audit m5: exact TM (E_z) resonances of the Meep tutorial ring (n 3.4, r 1..2, air), units c = a = 1.
    E_z = J_m(k r) inside, A J_m(n k r) + B Y_m(n k r) in the ring, C H1_m(k r) outside (outgoing, e^{-i w t});
    continuity of E_z and dE_z/dr at r = 1, 2; complex root of the 4x4 determinant (mpmath, 30 digits)."""
    import mpmath as mp

    mp.mp.dps = 30
    n, r1, r2 = 3.4, 1.0, 2.0

    def det(f, m):
        k = 2 * mp.pi * f

        def jj(z):
            return mp.besselj(m, z)

        def yy(z):
            return mp.bessely(m, z)

        def hh(z):
            return mp.hankel1(m, z)

        def d(fun, z):
            return mp.diff(fun, z)

        a1, b1, a2, b2 = k * r1, n * k * r1, n * k * r2, k * r2
        mat = mp.matrix(
            [
                [jj(a1), -jj(b1), -yy(b1), 0],
                [k * d(jj, a1), -n * k * d(jj, b1), -n * k * d(yy, b1), 0],
                [0, jj(a2), yy(a2), -hh(b2)],
                [0, n * k * d(jj, a2), n * k * d(yy, a2), -k * d(hh, b2)],
            ]
        )
        return mp.det(mat)

    meep = [
        ("0.118101575043663", "80.683059081382"),
        ("0.147162555528154", "316.29272471914"),
        ("0.175246750722663", "1677.48461212767"),
    ]
    tg = []
    for i, (m, f0) in enumerate([(3, 0.1181), (4, 0.1472), (5, 0.1752)]):
        f = mp.findroot(lambda x, m=m: det(x, m), mp.mpc(f0, -0.0005))
        f2 = mp.findroot(lambda x, m=m: det(x, m), mp.mpc(float(f.real) * 1.001, float(f.imag) * 1.1))
        fr, q = float(f.real), float(f.real / (-2 * f.imag))
        prec = {"method": "complex root, mpmath 30 digits", "restart_diff": float(abs(f - f2)), "m": m}
        tg.append(
            target(
                f"f{i + 1}",
                fr,
                "1 (c/a)",
                prec,
                source_compare(fr, meep[i][0], 1.0, "Meep tutorial (resolution 10)"),
                locator="meep doc/docs/Python_Tutorials/Basics.md L1117-1119",
            )
        )
        tg.append(
            target(
                f"Q{i + 1}",
                q,
                "1",
                prec,
                source_compare(q, meep[i][1], 1.0, "Meep tutorial (resolution 10)"),
                locator="meep doc/docs/Python_Tutorials/Basics.md L1117-1119",
            )
        )
    write_expected(
        "WO-05",
        tg,
        GEN,
        "Exact TM resonances (complex frequency) of a dielectric ring n 3.4, inner radius 1, "
        "outer radius 2, in air (Meep tutorial 'Modes of a Ring Resonator' geometry).",
        extra={"inputs": {"n": n, "r_inner": r1, "r_outer": r2, "units": "c = a = 1"}},
    )


if __name__ == "__main__":
    for fn in (em05, cp03, sm61, ht61, rf62, wo05):
        fn()
        print("wrote", fn.__name__)
