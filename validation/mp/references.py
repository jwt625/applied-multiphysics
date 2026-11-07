# SPDX-License-Identifier: GPL-3.0-or-later
"""Closed-form and derived reference values for the multiphysics example sims (lane MX, DevLog-035).

Every input below is copied from the sim it serves (sims/<id>.yaml), where each value carries its source; this script
only derives. Derivations are stated next to each function; validation/mp/README.md lists formulas and sources.

Run:  cd validation && uv run python mp/references.py            (prints and writes mp/references.json)
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy import optimize, special

EPS0 = 8.8541878128e-12  # F/m, CODATA 2018 (scipy.constants.epsilon_0 is the same value)


def bimetal_strip() -> dict:
    """Timoshenko 1925 bimetal curvature (beam = uniaxial stress = 2D plane stress strip).

    kappa = 6 (a2 - a1) dT (1 + m)^2 / (h [3 (1 + m)^2 + (1 + m n)(m^2 + 1/(m n))]), m = t1/t2, n = E1/E2, h = t1 + t2
    (S. Timoshenko, J. Opt. Soc. Am. 11(3), 233 (1925); formula as written in advanced-packaging-atlas
    validation/cases/A/MA3-timoshenko-bimetal.yaml at fe39985). Layer 1 = top (Cu), layer 2 = bottom (Al 6061-T6).
    Deflection of the curved strip relative to its centre: w(x) - w(0) = kappa x^2 / 2 (small slope).
    """
    t1, t2 = 1.0e-3, 3.0e-3                       # m, Wentao's CTE_bending inputs t1 = 1 mm, t2 = 3 t1
    E1, E2 = 123.5e9, 68258097202.36677           # Pa, materials/copper.yaml E; aluminum-6061-t6.yaml E (9.9e3 ksi)
    a1, a2 = 1.657068574830686e-5, 2.2642347668173694e-5  # 1/K, library alpha at 293.15 K (copper fit, 6061 fit)
    dT = 313.0 - 293.15                            # K, Wentao's T0 = 313 K, strain reference 293.15 K
    L = 60e-3                                      # m, sim param L (modelling choice)
    m, n, h = t1 / t2, E1 / E2, t1 + t2
    kappa = 6 * (a2 - a1) * dT * (1 + m) ** 2 / (h * (3 * (1 + m) ** 2 + (1 + m * n) * (m**2 + 1 / (m * n))))
    x_q = L / 4
    return {
        "kappa_1_per_m": kappa,
        "radius_m": 1 / kappa,
        "dw_centre_to_quarter_m": kappa * x_q**2 / 2,
        "x_quarter_m": x_q,
        "sign": "a2 > a1 and dT > 0: the bottom (Al, higher alpha) layer lengthens more, the strip bends concave towards the top (Cu): ends move up relative to the centre (+y), so uy(L/4) - uy(0) > 0",
        "inputs": {"t1": t1, "t2": t2, "E1": E1, "E2": E2, "alpha1": a1, "alpha2": a2, "dT": dT, "L": L},
    }


def hill_isotropic(C11: float, C12: float, C44: float) -> tuple[float, float]:
    """Voigt-Reuss-Hill average of a cubic stiffness tensor -> isotropic E, nu (Hill 1952 averaging rule).

    K = (C11 + 2 C12)/3; G_V = (C11 - C12 + 3 C44)/5; G_R = 5 / (4/(C11 - C12) + 3/C44); G = (G_V + G_R)/2;
    E = 9 K G / (3 K + G); nu = (3 K - 2 G) / (2 (3 K + G)).
    """
    K = (C11 + 2 * C12) / 3
    GV = (C11 - C12 + 3 * C44) / 5
    GR = 5 / (4 / (C11 - C12) + 3 / C44)
    G = (GV + GR) / 2
    return 9 * K * G / (3 * K + G), (3 * K - 2 * G) / (2 * (3 * K + G))


def chip_warpage() -> dict:
    """Plane-strain multilayer beam (laminated strip, all layers the full length) under a uniform dT.

    Per layer i (z from the bottom): E'_i = E_i / (1 - nu_i^2), e_i = (1 + nu_i) alpha_i dT (plane strain).
    Force and moment balance of eps(z) = eps0 + kappa z:  sum E'_i int (eps0 + kappa z - e_i) dz = 0,
    sum E'_i int (eps0 + kappa z - e_i) z dz = 0 -> 2 x 2 linear system. The sim has layers of different lengths
    (interposer 31 mm on a 42.5 mm substrate), so this value is an approximation of the mid-span curvature, not a gate.
    """
    nu_si_hill = hill_isotropic(165.64e9, 63.94e9, 79.51e9)[1]
    layers = [  # bottom to top: (name, t m, E Pa, nu, alpha 1/K)
        ("substrate_core", 800e-6, 18.9e9, 0.11, 11e-6),
        ("c4_underfill", 55e-6, 8.5e9, 0.29, 32e-6),
        ("interposer_si", 100e-6, 150e9, nu_si_hill, 3e-6),
    ]
    dT = 25.0 - 150.0
    z0, A = 0.0, np.zeros((2, 2))
    b = np.zeros(2)
    for _, t, E, nu, al in layers:
        Ep, e = E / (1 - nu**2), (1 + nu) * al * dT
        z1 = z0 + t
        I0, I1, I2 = t, (z1**2 - z0**2) / 2, (z1**3 - z0**3) / 3
        A += Ep * np.array([[I0, I1], [I1, I2]])
        b += Ep * e * np.array([I0, I1])
        z0 = z1
    eps0, kappa = np.linalg.solve(A, b)
    L_int = 31e-3
    return {
        "nu_si_hill": nu_si_hill,
        "kappa_1_per_m": float(kappa),
        "bow_over_interposer_length_m": float(kappa * L_int**2 / 8),
        "bow_over_substrate_length_m": float(kappa * 42.5e-3**2 / 8),
        "dT_K": dT,
        "note": "eps(z) = eps0 + kappa z with z up, so kappa = -w'' > 0 = top fibres longer than the bottom: convex up (dome, centre higher than the ends); approximation: all layers full length",
    }


def joule_wire() -> dict:
    """CP-03 as a Joule chain: uniform axial field E_z in a wire of conductivity sigma gives Q = sigma E_z^2.

    E_z = sqrt(q_gen / sigma), V0 = E_z Lz. The temperatures are those of CP-03 (eval/expected/CP-03.json).
    """
    q, sigma, Lz = 1152043.498788998, 1.0e6, 0.3048
    Ez = math.sqrt(q / sigma)
    return {"E_z_V_per_m": Ez, "V0_V": Ez * Lz, "I_A": sigma * Ez * math.pi * 0.009525**2,
            "T_center_K": 488.6719453208466, "T_surface_K": 487.5105902777777}


def microheater() -> dict:
    """Wang et al. 2020 reference device (no thermal isolation): heater conductivity from the measured resistance.

    sigma = L_h / (R w_h t_h) (assumes the 6.5 kOhm is the heater strip alone). Heat source per volume for a heater
    power P: Q = P / (L_h w_h t_h). Thermo-optic phase: dphi = (2 pi / lambda) dneff L_h; P_pi = pi / (dphi/dP).
    """
    L, R, w, t = 450e-6, 6.5e3, 1.5e-6, 100e-9
    sigma = L / (R * w * t)
    P = 8.5e-3
    return {"sigma_Ti_film_S_per_m": sigma, "rho_Ti_film_ohm_m": 1 / sigma, "Q_at_P_pi_W_per_m3": P / (L * w * t),
            "P_per_length_W_per_m": P / L, "dneff_for_pi_at_1550": 1.55e-6 / (2 * L)}


def ln_fbar() -> dict:
    """Thickness modes of a laterally infinite X-cut LiNbO3 plate (normal = crystal X), traction-free, no electrodes.

    Christoffel tensor for propagation along the normal n = X with piezoelectric stiffening (D_n = 0 in a plate with no
    electrodes on its faces): G_ij = c_iXjX + e_XiX e_XjX / eps_XX. Voigt: XX = 1, YY = 2, ZZ = 3, YZ = 4, XZ = 5, XY = 6.
    Trigonal 3m (IRE 1949 frame as tabulated): c15 = c16 = 0, c14 = -c24 = c56, c66 = (c11 - c12)/2;
    e (rows X, Y, Z): X = [0, 0, 0, 0, e15, -e22], Y = [-e22, e22, 0, e15, 0, 0], Z = [e31, e31, e33, 0, 0, 0].
    2D model (plane strain, u_Z = 0 with Z = crystal c axis out of the plane): polarizations X and Y only.
    f_n = n v / (2 t), v = sqrt(G / rho). The 3D (unconstrained) values are listed for comparison.
    """
    c11, c12, c13, c14, c33, c44 = 2.03e11, 0.53e11, 0.75e11, 0.09e11, 2.45e11, 0.60e11  # Pa, Weis 1985 Table 6 [23]
    c66 = (c11 - c12) / 2
    e15, e22, e31, e33 = 3.7, 2.5, 0.2, 1.3                                               # C/m^2, Ogi 2002 Table III
    eps11 = 44.3 * EPS0                                                                   # Weis 1985 Table 1 [23]
    rho, t = 4628.0, 500e-9
    # c_iXjX for i, j in (X, Y, Z): Voigt indices of (i X): X->1, Y->6, Z->5
    v = {"X": 0, "Y": 5, "Z": 4}
    C = np.array([[c11, c12, c13, c14, 0, 0], [c12, c11, c13, -c14, 0, 0], [c13, c13, c33, 0, 0, 0],
                  [c14, -c14, 0, c44, 0, 0], [0, 0, 0, 0, c44, c14], [0, 0, 0, 0, c14, c66]])
    eX = np.array([0, 0, 0, 0, e15, -e22])
    pol = ["X", "Y", "Z"]
    G = np.array([[C[v[i], v[j]] + eX[v[i]] * eX[v[j]] / eps11 for j in pol] for i in pol])
    out = {}
    w2, _ = np.linalg.eigh(G[:2, :2])
    out["2d_plane_strain"] = [{"G_Pa": float(g), "v_m_per_s": math.sqrt(g / rho), "f1_Hz": math.sqrt(g / rho) / (2 * t)} for g in w2]
    w3, vec3 = np.linalg.eigh(G)
    out["3d_unconstrained"] = [{"G_Pa": float(g), "v_m_per_s": math.sqrt(g / rho), "f1_Hz": math.sqrt(g / rho) / (2 * t),
                                "polarization_XYZ": [float(x) for x in vec3[:, k]]} for k, g in enumerate(w3)]
    out["inputs"] = {"c11": c11, "c12": c12, "c13": c13, "c14": c14, "c33": c33, "c44": c44, "c66": c66,
                     "e15": e15, "e22": e22, "e31": e31, "e33": e33, "eps11S_rel": 44.3, "rho": rho, "t_LN": t}
    return out


def membrane_air() -> dict:
    """Uncoupled checks for the axisymmetric mass-loaded plate in an air-filled tube.

    (a) Clamped circular Kirchhoff plate without the mass: w = A J0(lam r/a) + B I0(lam r/a); w(a) = w'(a) = 0 gives
        J0(lam) I1(lam) + I0(lam) J1(lam) = 0; f = lam^2 / (2 pi a^2) sqrt(D / (rho h)), D = E h^3 / (12 (1 - nu^2)).
    (b) Rigid-walled air column of length Lc (closed both ends), plane-wave modes f_n = n c / (2 Lc).
    """
    a, h, E, nu, rho = 10e-3, 0.025e-3, 2.9e9, 0.44, 1270.0
    lam = optimize.brentq(lambda x: special.j0(x) * special.i1(x) + special.i0(x) * special.j1(x), 2.5, 3.5)
    D = E * h**3 / (12 * (1 - nu**2))
    f_plate = lam**2 / (2 * math.pi * a**2) * math.sqrt(D / (rho * h))
    c0, Lc = 340.0, (30e-3 - 0.025e-3) / 2
    return {"lambda01": lam, "lambda01_sq": lam**2, "D_N_m": D, "f01_plate_Hz": f_plate,
            "air_column_length_m": Lc, "f_cavity_Hz": [n * c0 / (2 * Lc) for n in (1, 2, 3)]}


def main() -> None:
    out = {"bimetal-strip": bimetal_strip(), "chip-warpage-2d": chip_warpage(), "joule-wire": joule_wire(),
           "si-microheater-to": microheater(), "ln-fbar-2d": ln_fbar(), "membrane-air": membrane_air()}
    path = Path(__file__).with_name("references.json")
    path.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
