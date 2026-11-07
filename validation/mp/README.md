# validation/mp: references of the multiphysics examples (lane MX, DevLog-035)

`references.py` derives every closed-form or derived reference value of the multiphysics sims from inputs copied from
those sims (each input is sourced in the sim's `provenance`). Run from `validation/`:

```bash
uv run python mp/references.py      # prints and writes mp/references.json
```

Values below are from the run of 2026-11-07 (`references.json`). Eval-case targets are restated with their case file.

| Sim | Reference quantity | Value | Form | Source |
|---|---|---|---|---|
| nafems-t1-hotspot | sigma_yy at D = (1, 0), just outside the hot spot | 50 MPa (1.5 % band) | benchmark; infinite-plate closed form E e*/2 | eval/cases/a/CP-21.yaml (NAFEMS T1 via Altair OS-V 0100) |
| nafems-le11 | sigma_zz at A = (1, 0) m | -105 MPa (1 %) | benchmark | eval/cases/a/CP-02.yaml (NAFEMS LE11 via Altair OS-V 0070) |
| bimetal-strip | curvature kappa | 0.039340 1/m | closed form | Timoshenko, J. Opt. Soc. Am. 11, 233 (1925); formula as in advanced-packaging-atlas validation/cases/A/MA3-timoshenko-bimetal.yaml |
| bimetal-strip | uy(L/4, 0) - uy(0, 0), L = 60 mm | +4.4258 um | kappa x^2 / 2 | as above |
| chip-warpage-2d | laminate curvature (all layers full length, plane strain) | 1.3555 1/m (dome) | closed form, approximate for the stepped stack | classical laminated beam; atlas MA4 (CLT) for the method |
| chip-warpage-2d | bow over 42.5 mm (kappa L^2 / 8) | 306 um | approximate | as above; paper value 335 um (3D, with dies) is qualitative only |
| joule-wire | T_center, T_surface | 488.6719 K, 487.5106 K | closed form | eval/expected/CP-03.json (Rohsenow-Choi ex. 6.5 via VM58) |
| joule-wire | V0 for q''' = 1.152 MW/m^3 at sigma = 1e6 S/m | 0.32715 V | derived | V0 = sqrt(q / sigma) Lz |
| hot-arm-actuator | tip displacement at 15 V | 27 um | paper figure via Ansys VM223 | eval/cases/c/CP-04.yaml; informative here (300 K properties) |
| si-microheater-to | P_pi | 8.5 mW (measured) | paper | Wang et al., IEEE PTL 32, 1281 (2020) p.1284; informative |
| si-microheater-to | Ti film conductivity | 4.615e5 S/m | derived | sigma = L_h / (R w_h t_h), R = 6.5 kOhm (p.1284) |
| si-microheater-to | dneff for a pi shift over L_h | 1.7222e-3 | derived | lambda / (2 L_h) |
| tfln-mzm-eo | push-pull VpiL | 4.06 V cm (10 %) | paper simulation | eval/cases/b/CP-43.yaml (Pan 2021 p.3, Fig. 2(c)) |
| pzt4-cube | f1 / f2 short; f1 / f2 open | 66560 / 88010 Hz; 81590 / 93410 Hz | measured | eval/cases/c/CP-06.yaml (Boucher 1981 Table 1 via VM175) |
| ln-fbar-2d | TE1, 2D plate with u_z = 0 | 6.6229 GHz | closed form | f = sqrt(C11 / rho) / (2 t) |
| ln-fbar-2d | TS1 (in-plane shear, piezo-stiffened) | 4.4327 GHz | closed form | f = sqrt((C66 + e22^2 / eps11^S) / rho) / (2 t) |
| ln-fbar-2d | 3D plate (u_z free) shear pair, for comparison | 4.1106, 4.8226 GHz | closed form | 3 x 3 Christoffel with C14 coupling |
| membrane-air | clamped circular plate f01 (no mass, no air) | 197.45 Hz | closed form | Kirchhoff plate, lambda^2 = 10.2158 from J0 I1 + I0 J1 = 0 |
| membrane-air | rigid closed air half-column f1 | 11342.8 Hz | closed form | f_n = n c0 / (2 Lc) |

## Derivations

- **Timoshenko bimetal**: kappa = 6 (a2 - a1) dT (1 + m)^2 / (h [3 (1 + m)^2 + (1 + m n)(m^2 + 1/(m n))]), m = t1 / t2, n = E1 / E2, h = t1 + t2; beam theory (uniaxial stress) = 2D plane stress. Layer 1 = Cu (top, 1 mm), layer 2 = Al 6061-T6 (bottom, 3 mm), dT = 313 - 293.15 K.
- **Laminate (plane strain)**: per layer E' = E / (1 - nu^2), thermal strain (1 + nu) alpha dT; force and moment balance of eps(z) = eps0 + kappa z give a 2 x 2 linear system. kappa > 0 = top fibres longer = convex up (dome).
- **Si isotropic constants**: Voigt-Reuss-Hill average of the Hall 1967 cubic C (materials/silicon.yaml): K = (C11 + 2 C12) / 3, G_V = (C11 - C12 + 3 C44) / 5, G_R = 5 / (4 / (C11 - C12) + 3 / C44), G = (G_V + G_R) / 2, nu = (3K - 2G) / (2 (3K + G)) = 0.2231.
- **LiNbO3 thickness modes**: propagation along the plate normal n = crystal X; Christoffel G_ij = c_iXjX + e_XiX e_XjX / eps_XX (D_n = 0, no electrodes on the faces). Trigonal 3m matrices as in packages/physics/src/coupled/tensors.ts. With u_Z = 0 (plane strain, c axis out of plane) the X and Y polarizations decouple (c16 = 0): G_XX = C11 (e11 = 0), G_YY = C66 + e22^2 / eps11.
- **Clamped circular plate**: w = A J0(lambda r / a) + B I0(lambda r / a), w(a) = w'(a) = 0 -> J0(lambda) I1(lambda) + I0(lambda) J1(lambda) = 0, first root lambda = 3.19622; f = lambda^2 / (2 pi a^2) sqrt(D / (rho h)), D = E h^3 / (12 (1 - nu^2)).
