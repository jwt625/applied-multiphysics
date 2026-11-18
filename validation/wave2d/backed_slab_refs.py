# SPDX-License-Identifier: GPL-3.0-or-later
"""Wall-backed slab reference values for the wave2d gate G-f (DevLog-042 s.7.3). Time convention exp(+j omega t).

1D scalar problem (a u')' + a k^2 u = 0: background (a1, k1) for x < 0, slab (a2, k2) on 0 < x < t, wall at x = t.
Background field u = e^{-j k1 x} + r e^{j k1 x}; u and q = a u' continuous at x = 0. Wall condition (outward normal +x):
  natural   q(t) = 0                  (TE pec on H_z, TM pmc on E_z, sound-hard)
  robin     q(t) + c u(t) = 0         (acoustic impedance Z: c = j omega / Z)
  neumann   q(t) = g                  (acoustic normal velocity v into the domain: g = j omega v)
  dirichlet u(t) = 0                  (TM pec on E_z)
Route 1 (impedance recursion): gamma = q / u at the wall (0 natural, -c robin, infinite dirichlet), transported to x = 0:
  gamma0 = a2 k2 (a2 k2 tan(k2 t) + gamma_t) / (a2 k2 - gamma_t tan(k2 t))   (dirichlet: gamma0 = -a2 k2 cot(k2 t))
  r = (gamma0 + j a1 k1) / (j a1 k1 - gamma0)
  (the lossless-line input-impedance relation, Pozar, Microwave Engineering, 4th ed., sec. 2.3, with u ~ voltage,
  -q / (j omega) ~ current); a Neumann source adds the source-only outgoing wave s e^{j k1 x},
  s = g / (j a1 k1 cos(k2 t) - a2 k2 sin(k2 t)), to the natural-wall r.
Route 2 (transfer matrix): [u; q](t) = M [u; q](0), M = [[cos k2 t, sin(k2 t) / (a2 k2)], [-a2 k2 sin k2 t, cos k2 t]],
  u(0) = 1 + r, q(0) = -j a1 k1 (1 - r), and the wall condition: one linear equation in r.
Both routes must agree to 1e-13; lossless walls (natural, dirichlet) also |r| = 1.

Output: validation/wave2d/backed_slab_reference.json. Run: cd validation && uv run python wave2d/backed_slab_refs.py
"""

import cmath
import json
import math
from pathlib import Path

C0 = 299792458.0


def route1(a1, k1, a2, k2, t, wall, c=0j, g=0j):
    tn = math.tan(k2 * t)
    if wall == "dirichlet":
        gamma0 = -a2 * k2 / tn
    else:
        gt = -c if wall == "robin" else 0j
        gamma0 = a2 * k2 * (a2 * k2 * tn + gt) / (a2 * k2 - gt * tn)
    r = (gamma0 + 1j * a1 * k1) / (1j * a1 * k1 - gamma0)
    if wall == "neumann":
        r += g / (1j * a1 * k1 * math.cos(k2 * t) - a2 * k2 * math.sin(k2 * t))
    return r


def route2(a1, k1, a2, k2, t, wall, c=0j, g=0j):
    cs, sn = math.cos(k2 * t), math.sin(k2 * t)
    M = [[cs, sn / (a2 * k2)], [-a2 * k2 * sn, cs]]
    z = -1j * a1 * k1
    # u(t) = M00 (1 + r) + M01 z (1 - r), q(t) = M10 (1 + r) + M11 z (1 - r)
    if wall == "dirichlet":
        al, be, rhs = M[0][0], M[0][1] * z, 0j
    else:
        cc = c if wall == "robin" else 0j
        al, be = M[1][0] + cc * M[0][0], (M[1][1] + cc * M[0][1]) * z
        rhs = g if wall == "neumann" else 0j
    # al (1 + r) + be (1 - r) = rhs
    return (rhs - al - be) / (al - be)


def main():
    k0 = 2 * math.pi  # lambda0 = 1 m (EM); acoustics f = 343 Hz, c = 343 m/s: lambda = 1 m
    om_em = 2 * math.pi * C0
    om_ac = 2 * math.pi * 343.0
    t = 0.3
    rho1, c1, rho2, c2 = 1.2, 343.0, 3.6, 200.0
    cases = {
        "te_eps4_pec": dict(physics="emw-2d", pol="TE", eps2=4.0, mu2=1.0, wall="natural", bc="pec",
                            a1=1.0, k1=k0, a2=1 / 4.0, k2=k0 * 2.0, omega=om_em),
        "tm_eps2_mu4_pmc": dict(physics="emw-2d", pol="TM", eps2=2.0, mu2=4.0, wall="natural", bc="pmc",
                                a1=1.0, k1=k0, a2=1 / 4.0, k2=k0 * math.sqrt(8.0), omega=om_em),
        "tm_eps4_pec": dict(physics="emw-2d", pol="TM", eps2=4.0, mu2=1.0, wall="dirichlet", bc="pec",
                            a1=1.0, k1=k0, a2=1.0, k2=k0 * 2.0, omega=om_em),
        "ac_hard": dict(physics="acoustics", rho2=rho2, c2=c2, wall="natural", bc="sound-hard"),
        "ac_impedance": dict(physics="acoustics", rho2=rho2, c2=c2, wall="robin", bc="impedance", Z_Pa_s_per_m=1000.0),
        "ac_velocity": dict(physics="acoustics", rho2=rho2, c2=c2, wall="neumann", bc="normal-velocity", v_m_per_s=1e-3),
    }
    out = {"time_convention": "exp(+j omega t)", "t_m": t, "rho1": rho1, "c1": c1, "f_ac_Hz": 343.0, "lambda0_m": 1.0,
           "reference_plane_x_m": 0.0, "cases": {}}
    for name, cs in cases.items():
        if cs["physics"] == "acoustics":
            cs.update(a1=1 / rho1, k1=om_ac / c1, a2=1 / cs["rho2"], k2=om_ac / cs["c2"], omega=om_ac)
        c = 1j * cs["omega"] / cs["Z_Pa_s_per_m"] if cs["wall"] == "robin" else 0j
        g = 1j * cs["omega"] * cs["v_m_per_s"] if cs["wall"] == "neumann" else 0j
        args = (cs["a1"], cs["k1"], cs["a2"], cs["k2"], t, cs["wall"], c, g)
        r1, r2 = route1(*args), route2(*args)
        dev = abs(r1 - r2)
        assert dev < 1e-13, (name, dev)
        if cs["wall"] in ("natural", "dirichlet"):
            assert abs(abs(r1) - 1) < 1e-14, (name, abs(r1))
        rec = {k: v for k, v in cs.items() if k not in ("omega",)}
        rec.update(r_re=r1.real, r_im=r1.imag, r_abs=abs(r1), route1_vs_route2=dev)
        out["cases"][name] = rec
        print(f"{name}: r = {r1:.12f} |r| = {abs(r1):.12f}, route1 vs route2 {dev:.1e}")
    Path(__file__).with_name("backed_slab_reference.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
