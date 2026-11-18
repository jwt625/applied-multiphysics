# SPDX-License-Identifier: GPL-3.0-or-later
"""Three-layer bent slab modes (TE / TM) from the Bessel-Hankel dispersion relation (lane S2, DevLog-043 G-BEND).

Independent cross-check of Hiremath, Hammer, Stoffer, Prkna, Ctyroky, Opt. Quantum Electron. 37, 37-61 (2005),
doi 10.1007/s11082-005-1118-3, Table 3. Ansatz (their Eq. (6), time dependence exp(i omega t), outgoing H^(2)):
  phi = As J_nu(ns k r)                      r <= R - d
        Af J_nu(nf k r) + Bf Y_nu(nf k r)    R - d <= r <= R
        Ac H2_nu(nc k r)                     r >= R
phi = E_y (TE: phi and d phi / dr continuous) or H_y (TM: phi and (1 / n^2) d phi / dr continuous). The 4 x 4 matching
determinant is written out here from these interface conditions (not copied from their Eq. (7)) and its root in the
angular mode number nu = gamma R is found with mpmath (complex order Bessel functions). gamma = beta - i alpha;
beta / k and alpha / k are referenced to the outer rim R, as in the table.

Usage: uv run python modes2/bent_slab.py  (prints JSON lines; runtime a few seconds)
"""
import json

import mpmath as mp

mp.mp.dps = 40


def det(nu, k, R, d, ns, nf, nc, pol):
    rm, rp = R - d, R
    # derivative weight: d/dr of Z_nu(n k r) = n k Z'_nu; TM adds 1 / n^2
    w = (lambda n: n) if pol == "TE" else (lambda n: 1 / n)
    J, Y, H = mp.besselj, mp.bessely, mp.hankel2
    a = lambda f, n, r: f(nu, n * k * r)
    da = lambda f, n, r: w(n) * f(nu, n * k * r, 1) if f is not H else w(n) * mp.diff(lambda z: H(nu, z), n * k * r)
    M = mp.matrix(
        [
            [a(J, ns, rm), -a(J, nf, rm), -a(Y, nf, rm), 0],
            [da(J, ns, rm), -da(J, nf, rm), -da(Y, nf, rm), 0],
            [0, a(J, nf, rp), a(Y, nf, rp), -a(H, nc, rp)],
            [0, da(J, nf, rp), da(Y, nf, rp), -da(H, nc, rp)],
        ]
    )
    return mp.det(M)


def solve(R, pol, guess, lam=1.55, d=2.0, ns=1.6, nf=1.7, nc=1.55):
    k = 2 * mp.pi / lam
    f = lambda nu: det(nu, k, R, d, ns, nf, nc, pol)
    nu0 = mp.mpc(guess[0], -guess[1]) * k * R
    nu = mp.findroot(f, (nu0, nu0 * (1 + mp.mpf("1e-6"))), solver="secant", tol=mp.mpf("1e-30"), maxsteps=200)
    g = nu / R
    return {"R_um": R, "pol": pol, "beta_over_k": float(mp.re(g) / k), "alpha_over_k": float(-mp.im(g) / k), "nu": [float(mp.re(nu)), float(mp.im(nu))]}


if __name__ == "__main__":
    # guesses: Table 3 values (beta / k, alpha / k); the root is refined to full precision
    table3 = {
        (10, "TE"): (1.5890, 1.6025e-2), (10, "TM"): (1.5855, 1.8702e-2),
        (20, "TE"): (1.6185, 1.8299e-3), (20, "TM"): (1.6156, 2.1391e-3),
        (50, "TE"): (1.6473, 9.6704e-7), (50, "TM"): (1.6451, 1.2668e-6),
    }
    for (R, pol), g in table3.items():
        r = solve(R, pol, g)
        r["table3"] = {"beta_over_k": g[0], "alpha_over_k": g[1]}
        print(json.dumps(r))
