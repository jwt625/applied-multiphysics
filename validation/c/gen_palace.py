# SPDX-License-Identifier: GPL-3.0-or-later
"""Class-c generators for the Palace examples (awslabs/palace v0.19.0, Apache-2.0; lane L7c, DevLog-008).

Re-derives, from the formulas and inputs printed in the Palace docs, the analytic reference values that
the docs tabulate. No Palace code, mesh or config is copied; only the formulas (facts) are re-implemented.

  EM-02  docs/src/examples/spheres.md  L27-40 (Lekner series), L42 inputs, L74-80 values
  EM-03  docs/src/examples/rings.md    L28-39 (formulas), L42 inputs, L73-83 values
  RF-01  docs/src/examples/cylinder.md L31-65 (f, Q_d, Q_c), L26-28 + L100 inputs, L113-123, L150-156
  EM-61  docs/src/examples/coaxial.md  L124-170 (London kinetic inductance), L178-182, L223-231
  RF-61  docs/src/examples/coaxial.md  L19-23 (RG-401/U, eps 2.08, tan d 4e-2), L99-116 (100 Ohm port)

Run: cd validation && uv run python c/gen_palace.py
"""

from __future__ import annotations

import math

import numpy as np
from common_c import C0, EPS0, ETA0, MU0, source_compare, target, write_expected
from scipy import special

GEN = "validation/c/gen_palace.py"
PALACE = "awslabs/palace tag v0.19.0 (commit ca9a6a2d1e64a410229c3d7538507e5eae975cc6)"


def em02() -> None:
    a, b, c = 0.01, 0.02, 0.05
    u = math.acosh((c * c - a * a - b * b) / (2 * a * b))
    pref = 4 * math.pi * EPS0 * a * b * math.sinh(u)

    def series(f, n0: int, tol: float = 1e-16):
        s, n, terms = 0.0, n0, 0
        while True:
            t = f(n)
            s += t
            terms += 1
            if abs(t) < tol * abs(s) and terms > 3:
                return s, terms
            n += 1

    saa, naa = series(lambda n: 1 / (a * math.sinh(n * u) + b * math.sinh((n + 1) * u)), 0)
    sbb, nbb = series(lambda n: 1 / (b * math.sinh(n * u) + a * math.sinh((n + 1) * u)), 0)
    sab, nab = series(lambda n: 1 / math.sinh(n * u), 1)
    caa, cbb, cab = pref * saa, pref * sbb, -pref / c * sab
    loc = "palace docs/src/examples/spheres.md L74-80"
    tg = [
        target(
            "C_aa",
            caa,
            "F",
            {"method": "Lekner series", "terms": naa, "tol": 1e-16},
            source_compare(caa, "1.230518", 1e-12, f"{loc}, in pF"),
            locator=loc,
        ),
        target(
            "C_bb",
            cbb,
            "F",
            {"method": "Lekner series", "terms": nbb, "tol": 1e-16},
            source_compare(cbb, "2.431543", 1e-12, f"{loc}, in pF"),
            locator=loc,
        ),
        target(
            "C_ab",
            cab,
            "F",
            {"method": "Lekner series", "terms": nab, "tol": 1e-16},
            source_compare(cab, "-0.4945668", 1e-12, f"{loc}, in pF"),
            locator=loc,
        ),
    ]
    write_expected(
        "EM-02",
        tg,
        GEN,
        "Maxwell capacitance matrix of two conducting spheres in vacuum, Lekner (J. Electrostat. 69, 2011) "
        "series as printed in the Palace docs; cosh u = (c^2 - a^2 - b^2)/(2ab).",
        extra={"inputs": {"a_m": a, "b_m": b, "c_m": c}, "source_repo": PALACE},
    )


def em03() -> None:
    ra, rb, w = 10e-6, 100e-6, 1e-6
    mab = MU0 * math.pi * ra**2 / (2 * rb)
    laa = MU0 * ra * (math.log(16 * ra / w) - 1.75)
    lbb = MU0 * rb * (math.log(16 * rb / w) - 1.75)
    # Informative cross-check: exact mutual inductance of two coplanar coaxial filament loops (Maxwell)
    k2 = 4 * ra * rb / (ra + rb) ** 2
    k = math.sqrt(k2)
    mab_exact = MU0 * math.sqrt(ra * rb) * ((2 / k - k) * special.ellipk(k2) - (2 / k) * special.ellipe(k2))
    loc = "palace docs/src/examples/rings.md L73-83"
    tg = [
        target(
            "M_ab",
            mab,
            "H",
            {"method": "closed form mu0 pi r_a^2 / (2 r_b) (r_a << r_b, w = 0)"},
            source_compare(mab, "1.973921", 1e-12, f"{loc}, in pH"),
            locator=loc,
            exact_filament_loops=mab_exact,
            approx_vs_exact_rel=(mab - mab_exact) / mab_exact,
            note="rings.md L29 prints mu0 pi r_b^2 / (2 r_a); the printed value 1.973921 pH equals "
            "mu0 pi r_a^2 / (2 r_b): typo in the docs formula, value consistent with the correct form",
        ),
        target(
            "M_ab_filament_exact",
            mab_exact,
            "H",
            {"method": "Maxwell coaxial filament loops: mu0 sqrt(ra rb) ((2/k - k) K(k) - (2/k) E(k)), scipy"},
            source_compare(mab_exact, "1.973921", 1e-12, f"{loc}, in pH (small-loop limit)"),
            locator=loc,
            note="exact for zero-width coplanar loops; the 1 um strip width is a further, small effect",
        ),
        target(
            "L_aa",
            laa,
            "H",
            {"method": "thin-ring self inductance mu0 r (ln(16 r / w) - 1.75)"},
            source_compare(laa, "41.78537", 1e-12, f"{loc}, in pH"),
            locator=loc,
        ),
        target(
            "L_bb",
            lbb,
            "H",
            {"method": "thin-ring self inductance mu0 r (ln(16 r / w) - 1.75)"},
            source_compare(lbb, "707.2050", 1e-12, f"{loc}, in pH"),
            locator=loc,
        ),
    ]
    write_expected(
        "EM-03",
        tg,
        GEN,
        "Inductance matrix of two coplanar concentric rings, formulas and inputs as printed in the "
        "Palace docs (approximate: thin ring, r_a << r_b); exact filament-loop M_ab recorded.",
        extra={"inputs": {"r_a_m": ra, "r_b_m": rb, "w_m": w}, "source_repo": PALACE},
    )


def rf01() -> None:
    a, eps_r, tand, rs = 0.0274, 2.08, 4e-4, 0.0184
    d = 2 * a
    v = C0 / math.sqrt(eps_r)
    x01 = special.jn_zeros(0, 1)[0]
    xp01 = special.jnp_zeros(0, 1)[0]
    xp11 = special.jnp_zeros(1, 1)[0]
    f_tm010 = v / (2 * math.pi) * x01 / a
    f_te111 = v / (2 * math.pi) * math.hypot(xp11 / a, math.pi / d)
    # Q_c of TE_nml, Palace cylinder.md L56-62 (Pozar 6.7 / Ex. 6.4 form), n = 0, m = 1, l = 1
    n, l_ = 0, 1
    f = v / (2 * math.pi) * math.hypot(xp01 / a, l_ * math.pi / d)
    eps = EPS0 * eps_r
    k = 2 * math.pi * f * math.sqrt(MU0 * eps)
    eta = math.sqrt(MU0 / eps)
    beta = l_ * math.pi / d
    p = xp01
    qc = (
        (k * a) ** 3
        * eta
        * a
        * d
        / (4 * p**2 * rs)
        * (1 - (n / p) ** 2)
        / ((a * d / 2) * (1 + (beta * a * n / p**2) ** 2) + (beta * a**2 / p) ** 2 * (1 - n**2 / p**2))
    )
    qd = 1 / tand
    q = 1 / (1 / qc + 1 / qd)
    tg = [
        target(
            "f_TM010",
            f_tm010,
            "Hz",
            {"method": "closed form, scipy Bessel zero"},
            source_compare(f_tm010, "2.903605", 1e9, "cylinder.md L115 analytic table (GHz)"),
            locator="palace docs/src/examples/cylinder.md L115 (table), L224 (Floquet table 2.903636)",
            note="exact value equals RF-21 (class a, L7a); Palace's L115 entry uses a rounded Bessel zero",
        ),
        target(
            "f_TE111",
            f_te111,
            "Hz",
            {"method": "closed form"},
            source_compare(f_te111, "2.922212", 1e9, "cylinder.md L119 (GHz)"),
            locator="palace docs/src/examples/cylinder.md L119",
        ),
        target(
            "f_TE011",
            f,
            "Hz",
            {"method": "closed form"},
            source_compare(f, "5.000140", 1e9, "cylinder.md L118 (GHz)"),
            locator="palace docs/src/examples/cylinder.md L118",
        ),
        target(
            "Q_c_TE011",
            qc,
            "1",
            {"method": "Q_c formula cylinder.md L56-62, R_s 0.0184 Ohm"},
            source_compare(qc, "2.94e4", 1.0, "cylinder.md L155"),
            locator="palace docs/src/examples/cylinder.md L150-159 (Pozar Ex. 6.4)",
        ),
        target(
            "Q_TE011_copper",
            q,
            "1",
            {"method": "1/Q = 1/Q_c + 1/Q_d"},
            source_compare(q, "2.30e3", 1.0, "cylinder.md L151 (Palace computed)"),
            locator="palace docs/src/examples/cylinder.md L150-151",
        ),
        target(
            "Q_d",
            qd,
            "1",
            {"method": "1/tan delta"},
            source_compare(qd, "2.50e3", 1.0, "cylinder.md L135"),
            locator="palace docs/src/examples/cylinder.md L50, L135",
        ),
    ]
    write_expected(
        "RF-01",
        tg,
        GEN,
        "Teflon-filled circular cylinder cavity (a 2.74 cm, d = 2a): mode frequencies, dielectric and "
        "conductor Q, formulas as printed in the Palace docs (Pozar).",
        extra={"inputs": {"a_m": a, "d_m": d, "eps_r": eps_r, "tan_delta": tand, "R_s_ohm": rs}, "source_repo": PALACE},
    )


def em61() -> None:
    # RG-401/U diameters 0.0645 in / 0.215 in (coaxial.md L19-20) read as um via L0 = 1e-6 (L123-125):
    # a = 0.0645 / 2 * 25.4 = 0.81915 um, b = 2.7305 um (the docs print these rounded as 0.819 / 2.731 um)
    a, b, ell, lam, dthk = 0.0645 / 2 * 25.4e-6, 0.215 / 2 * 25.4e-6, 40e-6, 0.4e-6, 0.1e-6
    lgeom = MU0 * ell / (2 * math.pi) * math.log(b / a)
    lkin = MU0 * lam / math.tanh(dthk / lam) * ell / (2 * math.pi) * (1 / a + 1 / b)
    sweep = []
    for lm, txt in [
        (0.025e-6, "9.9494"),
        (0.05e-6, "10.2903"),
        (0.1e-6, "11.2988"),
        (0.2e-6, "15.1265"),
        (0.4e-6, "30.3670"),
        (0.8e-6, "91.3095"),
        (1.6e-6, "335.0747"),
    ]:
        lk = MU0 * lm / math.tanh(dthk / lm) * ell / (2 * math.pi) * (1 / a + 1 / b)
        sweep.append(
            {
                "lambda_m": lm,
                "L_H": lgeom + lk,
                "L_kin_H": lk,
                "source": source_compare(lgeom + lk, txt, 1e-12, "coaxial.md L223-231 Exact column (pH)"),
            }
        )
    loc = "palace docs/src/examples/coaxial.md L166-170 (formula), L178-182 (table)"
    tg = [
        target(
            "L_geom",
            lgeom,
            "H",
            {"method": "closed form mu0 l / (2 pi) ln(b/a)"},
            source_compare(lgeom, "9.6318", 1e-12, "coaxial.md L180 Exact (pH)"),
            locator=loc,
        ),
        target(
            "L_total_london",
            lgeom + lkin,
            "H",
            {"method": "L_geom + mu0 lambda coth(d/lambda) l/(2 pi) (1/a + 1/b)"},
            source_compare(lgeom + lkin, "30.3670", 1e-12, "coaxial.md L181 Exact (pH)"),
            locator=loc,
        ),
        target(
            "L_kin",
            lkin,
            "H",
            {"method": "closed form"},
            source_compare(lkin, "20.7352", 1e-12, "coaxial.md L182 Exact (pH)"),
            locator=loc,
        ),
    ]
    write_expected(
        "EM-61",
        tg,
        GEN,
        "Shorted micro-coax with superconducting (London) conductor films: geometric plus kinetic "
        "inductance, flat-film sheet inductance mu0 lambda coth(d/lambda), formula as in Palace docs.",
        extra={
            "inputs": {"a_m": a, "b_m": b, "length_m": ell, "lambda_m": lam, "film_d_m": dthk},
            "lambda_sweep": sweep,
            "source_repo": PALACE,
            "assumption": "a, b from the RG-401/U diameters in inches scaled to um (L0 = 1e-6); the docs "
            "print them rounded (0.819 / 2.731 um); with the rounded values L_geom "
            "is 9.6347 pH (3e-4 off the docs' 9.6318)",
        },
    )


def rf61() -> None:
    din, dout = 0.0645 * 0.0254, 0.215 * 0.0254
    eps_r, tand, zl = 2.08, 4e-2, 100.0
    eps_c = eps_r * (1 - 1j * tand)
    z0 = ETA0 / (2 * math.pi * np.sqrt(eps_c)) * math.log(dout / din)
    z0_lossless = ETA0 / (2 * math.pi * math.sqrt(eps_r)) * math.log(dout / din)
    gam = (zl - z0) / (zl + z0)
    g0 = (zl - z0_lossless) / (zl + z0_lossless)
    tg = [
        target(
            "Z0_lossless",
            z0_lossless,
            "ohm",
            {"method": "eta0 ln(b/a) / (2 pi sqrt(eps_r))"},
            source_compare(z0_lossless, "50", 1.0, "coaxial.md L19 nominal 50 Ohm"),
            locator="palace docs/src/examples/coaxial.md L19-21",
        ),
        target(
            "abs_S11_lumped100",
            float(abs(gam)),
            "1",
            {
                "method": "|(Z_L - Z0)/(Z_L + Z0)| with complex Z0 (eps_r (1 - j tan d)), frequency independent "
                "for constant tan d (quasi-TEM)"
            },
            source_compare(float(abs(gam)), "0.3333333", 1.0, "coaxial.md L114 'expect |Gamma| = 1/3'"),
            locator="palace docs/src/examples/coaxial.md L113-116",
            lossless_abs_gamma=g0,
            Z0_complex={"re": z0.real, "im": z0.imag},
        ),
        target(
            "abs_S11_dB",
            20 * math.log10(abs(gam)),
            "dB",
            {"method": "20 log10 |Gamma|"},
            source_compare(20 * math.log10(abs(gam)), "-9.5", 1.0, "coaxial.md L115"),
            locator="palace docs/src/examples/coaxial.md L115",
        ),
    ]
    write_expected(
        "RF-61",
        tg,
        GEN,
        "RG-401/U coax section (inner 0.0645 in, outer 0.215 in diameter, eps_r 2.08, tan d 4e-2) "
        "driven by a 100 Ohm lumped port: reflection magnitude from the quasi-TEM line impedance.",
        extra={
            "inputs": {
                "d_inner_m": din,
                "d_outer_m": dout,
                "eps_r": eps_r,
                "tan_delta": tand,
                "Z_port_ohm": zl,
                "f_sweep_Hz": [5e9, 15e9],
            },
            "source_repo": PALACE,
        },
    )


def rf03() -> None:
    """Audit B1: CPW (w 30 um, s 18 um) on a 500 um uniaxial sapphire substrate, C axis normal (eps 9.3 in plane,
    11.5 normal), air above and below, zero-thickness metal, semi-infinite grounds.

    Method: (1) a uniaxial layer with planar interfaces maps exactly (Laplace) to an isotropic layer with
    eps_eq = sqrt(eps_x eps_y) and thickness h' = h sqrt(eps_x / eps_y); (2) quasi-static partial-capacitance
    conformal map for a CPW on a finite substrate (Simons, Coplanar Waveguide Circuits, 2001, eqs. 2.4-2.6 form):
    eps_eff = 1 + (eps - 1)/2 K(k1)K(k0')/(K(k1')K(k0)), k0 = a/b, k1 = sinh(pi a/2h)/sinh(pi b/2h);
    Z0 = 30 pi / sqrt(eps_eff) K(k0')/K(k0). Also the infinite-substrate limit (exact for a half-space).
    """

    def kk(k):
        return special.ellipk(k**2) / special.ellipk(1 - k**2)

    a, b, h = 15e-6, 33e-6, 500e-6
    k0 = a / b

    def z0(eps, hh):
        k1 = math.sinh(math.pi * a / (2 * hh)) / math.sinh(math.pi * b / (2 * hh))
        eps_eff = 1 + (eps - 1) / 2 * kk(k1) / kk(k0)
        return ETA0 / 4 / math.sqrt(eps_eff) / kk(k0), eps_eff

    ex, ey = 9.3, 11.5
    eps_eq, h_eq = math.sqrt(ex * ey), h * math.sqrt(ex / ey)
    z_an, ee_an = z0(eps_eq, h_eq)
    z_iso93, _ = z0(9.3, h)
    z_iso115, _ = z0(11.5, h)
    z_half = ETA0 / 4 / math.sqrt((eps_eq + 1) / 2) / kk(k0)
    loc = "palace docs/src/examples/cpw.md L18-25"
    tg = [
        target(
            "Z0_anisotropic",
            z_an,
            "ohm",
            {
                "method": "uniaxial -> isotropic map + partial-capacitance conformal map",
                "eps_eq": eps_eq,
                "h_eq_m": h_eq,
                "eps_eff": ee_an,
                "half_space_limit_ohm": z_half,
                "finite_h_effect_rel": (z_an - z_half) / z_half,
                "value_with_30pi_prefactor": z_an * 30 * math.pi / (ETA0 / 4),
            },
            source_compare(z_an, "56.02", 1.0, "cpw.md L25 (Palace prints 56.02 for this substrate)"),
            locator=loc,
        ),
        target(
            "Z0_isotropic_9p3",
            z_iso93,
            "ohm",
            {"method": "partial-capacitance conformal map, eps 9.3, h 500 um"},
            source_compare(z_iso93, "56.02", 1.0, "cpw.md L25"),
            locator=loc,
            value_with_30pi_prefactor=z_iso93 * 30 * math.pi / (ETA0 / 4),
            note="with the handbook prefactor 30 pi (eta0 ~ 120 pi) this is 56.02 Ohm, the docs value: the docs "
            "value corresponds to isotropic eps 9.3; this generator uses eta0/4 exactly (-0.07 %)",
        ),
        target("Z0_isotropic_11p5", z_iso115, "ohm", {"method": "as above, eps 11.5"}, None, locator=loc),
    ]
    write_expected(
        "RF-03",
        tg,
        GEN,
        "Quasi-static Z0 of a CPW on a 500 um C-axis sapphire substrate (anisotropic and isotropic variants).",
        extra={
            "inputs": {
                "w_m": 30e-6,
                "s_m": 18e-6,
                "h_m": h,
                "eps_perp_c": ex,
                "eps_par_c": ey,
                "c_axis": "normal to the substrate",
            },
            "source_repo": PALACE,
        },
    )


if __name__ == "__main__":
    for fn in (em02, em03, rf01, em61, rf61, rf03):
        fn()
        print("wrote", fn.__name__.upper().replace("EM", "EM-").replace("RF", "RF-"))
