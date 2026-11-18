# SPDX-License-Identifier: GPL-3.0-or-later
"""Eigenmode-expansion (mode matching) reference for the 1x2 MMI example (sims/mmi-1x2-splitter.yaml), DevLog-047.

2D in-plane TE (u = H_z, a = 1/eps_r, mu_r = 1), time convention exp(+j omega t), closed box |y| < Hb/2 with PEC side
walls (natural for H_z). The structure is piecewise constant along x: input guide | MMI section (length Lm) | two
output guides. Method (independent of the 2D finite-element solver: exact in x, discretised only across y):
  1. cross-section modes of each section on one common 1D grid (Lagrange P2, nodes on every index step):
     (k0^2 Mk - K_a) phi = beta^2 M_a phi with K_a = int a phi' v', Mk = int phi v, M_a = int a phi v; ALL modes of the
     discrete space are kept (complete basis, no truncation), phi^T M_a phi = 1, beta with Im <= 0;
  2. interface conditions (continuity of H_z and of a dH_z/dx, the latter in weak form):
     Phi_A (a+ + a-) = Phi_B (b+ + b-),  M_a,A Phi_A B_A (a+ - a-) = M_a,B Phi_B B_B (b+ - b-)   (B = diag(beta));
     with Phi_B^-1 = Phi_B^T M_a,B: T = Phi_B^T M_a,B Phi_A, W = B_B^-1 Phi_B^T M_a,A Phi_A B_A, giving the interface
     scattering matrix R_AA = (T + W)^-1 (W - T), T_BA = T (I + R_AA), T_AB = 2 (T + W)^-1, R_BB = T T_AB - I;
  3. propagation exp(-j beta Lm) in the MMI section and the Redheffer star product of interface 1, the section and
     interface 2 (the standard bidirectional eigenmode-expansion cascade, e.g. Bienstman and Baets, Opt. Quantum
     Electron. 33, 327 (2001), for the method; the formulas above are derived here and are the reference);
  4. power normalisation: P = Re(beta) |amp|^2 / (2 omega eps0) for phi^T M_a phi = 1, so S_ij = amp_i sqrt(Re beta_i) /
     (amp_j sqrt(Re beta_j)) over propagating modes.
The example's output ports split the right edge at y = 0 with a natural end there; for excitation from the input port
the field is even in y (fundamental output supermode even to 1e-6 on the grid; it is nearly degenerate with
the odd one), so the half-port fundamental mode equals the even output supermode restricted to one half and
|S21| = |S31| = |b_even| / sqrt(2) with b_even the power-normalised amplitude of the even fundamental output supermode.

Checks: energy sum |S_i1|^2 over all propagating modes = 1 to 1e-10; transverse-grid convergence (dy and dy / 2) is
recorded as the reference's precision.

Output: eval/expected/WO-72.json. Run: cd validation && OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 uv run python driven/mmi_eme.py
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from scipy import linalg

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common_driven import write_expected  # noqa: E402

# inputs (must equal sims/mmi-1x2-splitter.yaml), lengths in um
N_SI, N_OX = 3.4767, 1.4444
W_IN, W_MMI, L_MMI, D_OUT, HB = 0.4, 2.0, 4.6, 0.5, 4.0
LAMS = [1.50, 1.55, 1.60]


def grid(dy: float) -> np.ndarray:
    n = round(HB / dy)
    return np.linspace(-HB / 2, HB / 2, n + 1)


def section_eps(y_mid: np.ndarray, kind: str) -> np.ndarray:
    if kind == "in":
        core = np.abs(y_mid) < W_IN / 2
    elif kind == "mmi":
        core = np.abs(y_mid) < W_MMI / 2
    else:
        core = (np.abs(y_mid - D_OUT) < W_IN / 2) | (np.abs(y_mid + D_OUT) < W_IN / 2)
    return np.where(core, N_SI**2, N_OX**2)


def assemble(yv: np.ndarray, eps_el: np.ndarray):
    """P2 elements on the vertices yv (one mid node per element): K_a, M_1, M_a (dense; small)."""
    ne = len(yv) - 1
    nn = 2 * ne + 1
    K, M1, Ma = (np.zeros((nn, nn)) for _ in range(3))
    # reference P2 on [0, 1], nodes 0, 1/2, 1 -> local order (0, mid, 1)
    k_ref = np.array([[7, -8, 1], [-8, 16, -8], [1, -8, 7]]) / 3.0
    m_ref = np.array([[4, 2, -1], [2, 16, 2], [-1, 2, 4]]) / 30.0
    for e in range(ne):
        h = yv[e + 1] - yv[e]
        idx = [2 * e, 2 * e + 1, 2 * e + 2]
        a = 1.0 / eps_el[e]
        for i in range(3):
            for j in range(3):
                K[idx[i], idx[j]] += a * k_ref[i, j] / h
                M1[idx[i], idx[j]] += m_ref[i, j] * h
                Ma[idx[i], idx[j]] += a * m_ref[i, j] * h
    return K, M1, Ma


def modes(k0: float, yv: np.ndarray, kind: str):
    eps = section_eps(0.5 * (yv[:-1] + yv[1:]), kind)
    K, M1, Ma = assemble(yv, eps)
    b2, Phi = linalg.eigh(k0**2 * M1 - K, Ma)  # Phi^T Ma Phi = I
    order = np.argsort(-b2)
    b2, Phi = b2[order], Phi[:, order]
    beta = np.where(b2 >= 0, np.sqrt(np.abs(b2)), -1j * np.sqrt(np.abs(b2)))
    return beta.astype(complex), Phi, Ma


def interface(A, B):
    bA, PA, MA = A
    bB, PB, MB = B
    T = PB.T @ MB @ PA
    W = (PB.T @ MA @ PA) * (bA[None, :] / bB[:, None])
    inv = np.linalg.inv(T + W)
    RAA = inv @ (W - T)
    TBA = T @ (np.eye(len(bA)) + RAA)
    TAB = 2 * inv
    RBB = T @ TAB - np.eye(len(bB))
    return {"R11": RAA, "T21": TBA, "T12": TAB, "R22": RBB}


def star(S, Q):
    """Redheffer star product: S (ports 1 -> 2) followed by Q (2 -> 3)."""
    n = S["R22"].shape[0]
    I = np.eye(n)
    F = np.linalg.inv(I - S["R22"] @ Q["R11"])  # inner forward wave c = F S21 a
    G = np.linalg.inv(I - Q["R11"] @ S["R22"])  # inner backward wave d = G Q12 b
    return {
        "R11": S["R11"] + S["T12"] @ Q["R11"] @ F @ S["T21"],
        "T21": Q["T21"] @ F @ S["T21"],
        "T12": S["T12"] @ G @ Q["T12"],
        "R22": Q["R22"] + Q["T21"] @ S["R22"] @ G @ Q["T12"],
    }


def solve(lam: float, dy: float) -> dict[str, float]:
    k0 = 2 * math.pi / lam
    yv = grid(dy)
    In, Mm, Out = modes(k0, yv, "in"), modes(k0, yv, "mmi"), modes(k0, yv, "out")
    S1 = interface(In, Mm)
    P = np.exp(-1j * Mm[0] * L_MMI)
    prop = {"R11": np.zeros((len(P), len(P)), complex), "T21": np.diag(P), "T12": np.diag(P), "R22": np.zeros((len(P), len(P)), complex)}
    S = star(star(S1, prop), interface(Mm, Out))
    bi, bo = In[0], Out[0]
    a0 = np.zeros(len(bi), complex)
    a0[0] = 1
    r = S["R11"] @ a0
    t = S["T21"] @ a0
    pi_, po = bi.real > 0, bo.real > 0
    nr = np.where(pi_, np.abs(r) * np.sqrt(np.abs(bi.real) / bi[0].real), 0)
    nt = np.where(po, np.abs(t) * np.sqrt(np.abs(bo.real) / bi[0].real), 0)
    energy = float(np.sum(nr**2) + np.sum(nt**2))
    # fundamental output supermode must be even: check its symmetry on the grid
    phi_e = Out[1][:, 0]
    sym = float(np.max(np.abs(phi_e - phi_e[::-1])) / np.max(np.abs(phi_e)))
    return {"S11_abs": float(nr[0]), "S21_abs": float(nt[0] / math.sqrt(2)), "energy": energy, "even_check": sym,
            "neff_in0": float(bi[0].real / k0), "neff_out0": float(bo[0].real / k0)}


def main() -> int:
    targets = []
    for lam in LAMS:
        a = solve(lam, 0.01)
        b = solve(lam, 0.005)
        assert abs(b["energy"] - 1) < 1e-10, b["energy"]
        assert b["even_check"] < 1e-6, b["even_check"]  # even and odd output supermodes are nearly degenerate
        print(lam, {k: (a[k], b[k]) for k in a})
        tag = f"l{round(lam * 1000)}"
        for q in ("S11_abs", "S21_abs"):
            targets.append(
                {
                    "metric_id": f"{q}.{tag}",
                    "value": b[q],
                    "unit": "1",
                    "precision": {"method": "bidirectional eigenmode expansion, all modes of a P2 transverse grid", "dy_um": 0.005,
                                  "change_vs_dy_0.01_um": abs(b[q] - a[q]), "energy_error": abs(b["energy"] - 1)},
                    "inputs": {"lambda0_um": lam, "n_core": N_SI, "n_clad": N_OX, "w_um": W_IN, "W_um": W_MMI, "Lm_um": L_MMI, "d_um": D_OUT, "Hb_um": HB},
                    "locator": "validation/driven/mmi_eme.py (method in the script header)",
                }
            )
    write_expected(
        "WO-72",
        "validation/driven/mmi_eme.py",
        "cd validation && uv run python driven/mmi_eme.py",
        "1x2 MMI (Si 3.4767 / SiO2 1.4444, w 0.4, W 2, Lm 4.6, outputs at +-0.5, box 4 um, TE in-plane): |S11| and |S21| of "
        "the fundamental modes by bidirectional eigenmode expansion with all transverse modes.",
        targets,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
