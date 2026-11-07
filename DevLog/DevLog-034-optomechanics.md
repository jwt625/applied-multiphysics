# DevLog-034: optomechanical coupling g0 (moving boundary + photoelastic), axisymmetric microdisk, nanobeam feasibility (lane MOM)

| Field | Value |
|---|---|
| Date | 2026-11-07 |
| Lane | MOM (DevLog-029 s.3.3 wave 2) |
| Owns | `packages/physics/src/couplings/optomech.ts` (new), `packages/physics/src/optomech/**` (new helpers), `packages/physics/test/mom-*` (`mom-coupling.test.ts`, `mom-common.ts`, `mom-conv.ts` runner), new sims of this lane (`gaas-microdisk-om`, staged in `validation/mom/sims/` until R-MC1), `validation/mom/**`, this file |
| Parallel | MC (031: driver, prepare, registrations, index, couplings core + index, spec types, post, runner), MT (033: elastic/**, coupled/**, couplings/twoway.ts), MO (032: modes/**, couplings/photonic.ts), MG (036: electrostatics/**, geom/**), MX (035: existing sims, materials, catalog-mp.ts) |
| Read | DevLog-029, 031, 033; CONTRACTS-v0 C11 + changelog; `packages/physics/src/{driver.ts, couplings/*, em-axisym/index.ts, elastic/modal.ts, coupled/assemble.ts, prepare.ts}`; eval cases CP-08, CP-42; `sims/{cylinder-cavity-axisym,membrane-air}.yaml`; cached sources Chan 2012 (arXiv 1206.2099v1), Eichenfield 2009 (arXiv 0906.1236); downloaded (scratch, not committed) Ding 2010 (arXiv 1007.3392v?), Baker 2014 (arXiv 1403.4269v1), refractiveindex.info GaAs/Skauli.yml |
| Status | done (gates s.4); feasibility CP-08 / CP-42 s.3; requests s.5; open items s.6 |

Conventions: "F" = fact read from code, a run or a source; "D" = decision of this lane (reason given); "O" = open item; "E" = estimate (labelled).

## 1. Plan (2026-11-07 09:20 PST)

### 1.1 Facts (F)
- Driver (`driver.ts`): sequential couplings map an upstream solution into the downstream `RunContext.inputs`; monolithic couplings get the run contexts of both physics and return one Solution; a study may produce one step set only (a monolithic group counts once). Monolithic couplings may carry `readiness(spec, node)`, which replaces the single-module readiness of the group (driver line 134).
- `CouplingImpl` has one `from` / `to` type pair; `couplingImpl(type)` returns the first implementation of a type. So one coupling type serves one physics pair.
- `emw-axisym` (`em-axisym/index.ts`): meridional (r, z) tri3, E = (E_r cos m phi, E_phi sin m phi, E_z cos m phi), unknowns e_t (Nedelec order p) and w = r E_phi (Lagrange order p). `solveAxisymModes` returns the full DOF vectors `x` and the `space`; the module's nodal field `E_rphiz` is a vertex average (E_perp is discontinuous at a dielectric interface, so the nodal field is not usable for the boundary integral).
- Elastic modal (`elastic/modal.ts`): isotropic E, nu only (`isoD`); axisym = azimuthal order 0, weight r, per radian; normalisation int rho u . u dV = 1 per radian. `assembleSolid` (coupled/assemble.ts) takes a per-cell D callback (any nv x nv matrix).
- `prepare.ts` resolves `rho` for an elastic eigen study; elastic NEEDS are E, nu, alpha. `materials/silicon.yaml` carries the cubic C tensor (Hall 1967) and no E, nu.
- Sources (read 2026-11-07):
  - Chan et al. 2012 APL 101 081115, arXiv 1206.2099v1 p.2: eq. (1) g_OM,MB = -(omega_o / 2) oint (Q . n)(Delta eps |E_par|^2 - Delta(eps^-1) |D_perp|^2) dS / int E . D dV, max |Q| = 1, n outward, Delta eps = eps_Si - eps_air, Delta(eps^-1) = eps_Si^-1 - eps_air^-1 (citing Johnson et al. 2002 PRE 65 066611); eq. (2) g_OM,PE = -(omega_o / 2) <E| d eps / d alpha |E> / int E . D dV; d eps_ij / d alpha = -eps0 n^4 p_ijkl S_kl; Si (p11, p12, p44) = (-0.094, 0.017, -0.051) with x || [100], y || [010] (refs. 12 = Biegelsen 1974 PRL 32 1196, 13 = Yariv-Yeh 1983); g = g_OM sqrt(hbar / (2 m_eff omega_m)), m_eff per ref. 10. Its eq. (3) labels the shear products Ex Ey S4, Ex Ez S5, Ey Ez S6 (Voigt order xy, xz, yz) and drops the factor 2 on the last term; this lane contracts the full tensor instead.
  - Eichenfield et al. 2009 Nature 462 78, arXiv 0906.1236 appendix D (p.9-10): alpha = max |Q|, m_eff = int rho |Q|^2 dV / max |Q|^2; 1 / L_OM = (1/2) int (dq/dalpha . n)(Delta eps |E_par|^2 - Delta(eps^-1) |D_perp|^2) dA / int eps |E|^2 dV (eq. D4); "L_OM is equal to ... the radius of a microtoroid or microdisk for the radial breathing mode".
  - Ding et al. 2010 PRL 105 263903, arXiv 1007.3392 p.3: thick-disk limit (h sufficiently larger than lambda / n, effective-index separation) gives the WGM dispersion in k R only, so dω/dR = -ω/R exactly for a pure radial displacement; expected to fail for thin disks (< lambda / n) and for modes with out-of-plane motion. GaAs disks (pedestal dimensions not tabulated) are therefore not rebuilt here.
  - Baker et al. 2014 Opt. Express 22 14072, arXiv 1403.4269v1: GaAs disk R = 1 um, h = 320 nm, no pedestal, TE p = 1 m = 10 WGM at lambda0 ~ 1.3 um (Table 1: 1.32 um); isotropic GaAs rho 5317 kg/m^3, E 85.9 GPa, nu 0.31 (Table 4); p11 -0.165, p12 -0.140, p44 -0.072 at 1.15 um (Table 2, ref. 34); Table 3: 1st RBM 1.375 GHz, g_om^geo 1080 GHz/nm, g_om^pe 984 GHz/nm, total 2064, x_zpf 1.23e-15 m, g0 1.33 / 1.21 / 2.54 MHz; 2nd RBM 3.5 GHz, 412 / 1720 / 2132 GHz/nm, x_zpf 1.15e-15 m, g0 0.474 / 1.98 / 2.45 MHz; text p.11: omega0 / R ~ 1.4 THz/nm and FEM g^geo ~ 20 % below it. Their eq. (13) applies the cubic p matrix in the local (r, theta, z) frame.
  - GaAs n: Skauli et al. 2003 J. Appl. Phys. 94 6447 Sellmeier (22 C, 0.97-17 um) via the refractiveindex.info entry GaAs/nk/Skauli.yml (CC0), fetched 2026-11-07.

### 1.2 Design (D)
- **Coupling type** `optomechanical`, `from: elastic`, `to: emw-axisym`, kind `monolithic` (both eigen problems are solved inside `run`, then every optical x mechanical pair is evaluated). Reason: the result belongs to neither physics (it is a post-eigen pair quantity), the driver allows one step set per study, and a monolithic group is the existing extension point that gets both run contexts. A 3D pair (elastic -> emw) needs a second type name (one impl per type); deferred with the nanobeam (s.3).
- **Settings**: `optical: {nModes?, shift?}` (defaults: the study's nModes and shift), `mechanical: {nModes?, shift?}` (defaults: the study's nModes, no shift = lowest modes; changed 09:34 from "study shift", which is an optical frequency), `photoelastic?: [{material, p11, p12, p44, frame}]` (cubic m3m, contracted, dimensionless; `frame: crystal-avg` = crystal z || [001] along the disk axis, azimuthal average of the rotated tensor, exact for every optical order m != 2 with an m = 0 mechanical mode; `frame: cylindrical` = the cubic matrix applied in the local (r, phi, z) axes, Baker 2014 eq. (13) convention; both stated, default crystal-avg), `pairs?` (optional subset). Background index for the photoelastic term: n^2 = eps_r of the cell (isotropic optics).
- **Mechanics**: own axisym modal solve on MT's `assembleSolid` (needs an arbitrary D per cell): isotropic E, nu as MT, or a cubic `C` tensor reduced to its azimuthal average with z || [001] (transversely isotropic; an approximation, stated: the 4 phi part of a cubic crystal couples m = 0 to m = +-4). Request to MT: a `D` hook in `ModalProblem` so the copy can go.
- **Optics**: `solveAxisymModes` directly (raw ND / Lagrange coefficients). E evaluated inside each triangle from the basis (same basis code and DOF layout as em-axisym; reimplemented in `optomech/axisym-fields.ts`).
- **Moving boundary** (Johnson 2002 / Chan eq. 1): over the meridional edges between a solid cell and a non-solid optical cell, Gauss points on the edge, E from both adjacent triangles: E_par = (tangential in-plane, E_phi) averaged over the two sides (continuous in the FE space up to the w / r evaluation), D_perp = eps_r E_n averaged over the two sides; integrand (Q . n)(Delta eps |E_par|^2 - Delta(1/eps) |D_perp|^2) r ds; n outward from the solid. Denominator int eps_r |E|^2 r dr dz over the optical domain. The azimuthal factor (pi for m >= 1, 2 pi for m = 0 with all components) is common to both and cancels. Q = mechanical u at the edge (P2 interpolation).
- **Photoelastic** (Chan eq. 2): per solid cell, quadrature: axisym strain (S_rr, S_zz, S_phiphi, 2 S_rz) from u, d eps_ij = -n^4 p_ijkl S_kl (relative), integrand E_i d eps_ij E_j r over the cell; the phi-integration leaves E_r, E_phi, E_z with the same factor (pi) for m >= 1, and the cross terms with E_phi vanish (m = 0 strain has no r-phi, phi-z shear and the averaged tensor has no such couplings).
- **Units and signs**: g_OM = d omega_o / d alpha (rad/s per m) with alpha = max |Q| (Eichenfield / Chan convention). Reported as g_OM / 2 pi in Hz/m (scalars) with the Baker / Ding sign comparison stated (their g = -d omega / dx). Mechanical sign fixed: the dominant component of u at the max-|u| node is positive. m_eff = int rho |Q|^2 dV / max |Q|^2 over the full 3D body (2 pi times the meridional integral); x_zpf = sqrt(hbar / (2 m_eff Omega_m)); g0 = g_OM x_zpf (normalisation-invariant). hbar = 1.054571817e-34 J s (CODATA 2018, exact by the 2019 SI h).
- **Output**: steps = optical modes then mechanical modes (kind eigen, Hz; documented); fields `E_rphiz` (tag optical) and `u` (tag mechanical) at their step indices; scalars per pair `g0_<i>_<j>` (Hz, g0 / 2 pi), `g0MB_<i>_<j>`, `g0PE_<i>_<j>`, `gOM_<i>_<j>`, `gOMMB_..`, `gOMPE_..` (Hz/m, / 2 pi), per mode `fo_<i>`, `fm_<j>`, `meff_<j>` (kg), `xzpf_<j>` (m), `m_<i>` (azimuthal order).

### 1.3 Gates (in order)
1. G-MB1 analytic, 2D limit: dielectric cylinder spanning the whole height with PMC top and bottom (z-invariant fields), rigid sidewall displacement Q . n = 1: g_OM = -omega / R (scale invariance in r; Ding 2010 p.3; Eichenfield D.2). Tolerance set by discretisation (E: < 1e-3).
2. G-MB2 finite difference: the same g_OM by re-solving the optical problem on the mesh moved by +-delta Q (moving-boundary formula vs d omega / d alpha of the discrete problem). Thin GaAs disk, 1st RBM.
3. G-PE1 finite difference, isotropic channel: p11 = p12 = p, p44 = 0 makes d eps scalar per point (-n^4 p tr S); re-solve with cell eps_r + cell-mean d eps, compare with the perturbation integral.
4. G-B14 Baker 2014 Table 3 (GaAs R 1 um, h 320 nm, TE p = 1 m = 10): f_RBM1, f_RBM2, g_geo, g_pe, x_zpf, g0; and omega / R. Tolerances proposed, not tuned: frequencies 3 %, g_geo 10 %, g_pe 15 % (frame convention), x_zpf 5 %.
5. Thin-disk regime: g_OM(rigid sidewall) / (omega / R) for the R 1 um disk (informative; the thick-disk limit does not hold at h = 320 nm < lambda / n per Ding 2010).

### 1.4 TODO
- [x] plan (this section)
- [x] optomech helpers: axisym field evaluation, p tensor averaging, modal solve, pair integrals
- [x] couplings/optomech.ts: CouplingImpl + Registration + readiness + NEEDS
- [x] tests mom-*.test.ts: G-MB1, G-MB2, G-PE1, G-B14
- [x] gaas-microdisk-om spec (+ provenance), run through prepareRun + runStudy; staged at `validation/mom/sims/gaas-microdisk-om.yaml` (s.4.4)
- [x] CP-08 / CP-42 feasibility (geometry, dof, time) and gap list
- [x] tsc, pnpm -r test, class-a eval unchanged (s.4.4)
- [x] report: requests to MC (index line, RESULT_NAMES, NEEDS), MT (D hook), MX (catalog entry, gaas material, Si p_ij)

## 2. Progress log
- 2026-11-07 09:20 PST: read DevLogs, contracts, code; sources read (Chan, Eichenfield cached; Ding 2010, Baker 2014, Skauli entry downloaded to the session scratch, sha256 recorded in s.4). Plan written.
- 2026-11-07 09:26 PST: `optomech/tensors.ts`, `optomech/axisym.ts`, `couplings/optomech.ts`, `sims/gaas-microdisk-om.yaml`; first run through prepareRun + runStudy: RBM1 1.3754 GHz, x_zpf 1.229e-15 m (Baker 1.375 GHz, 1.23e-15 m).
- 2026-11-07 09:30 PST: gates `test/mom-coupling.test.ts` pass (s.4); convergence runner `test/mom-conv.ts` (s.4.2); E-field cache across mechanical modes (overlap 0.90 -> 0.59 s at the default mesh).
- 2026-11-07 09:32 PST: CP-08 / CP-42 feasibility (s.3); class-a eval, `pnpm -r test`, `pnpm -r check` started (s.4.4).
- 2026-11-07 09:34 PST: mechanical default shift = none (was the study shift, an optical frequency); sim staged in `validation/mom/sims/` after the spec live-sims failure (s.4.4).
- 2026-11-07 09:38 PST: class-a identical counts, check 0 errors, `pnpm -r --no-bail test` all pass; report to the coordinator.

## 3. CP-08 / CP-42 (Si optomechanical-crystal nanobeams): feasibility and gap list (2026-11-07 09:32 PST)

Verdict: not run. Both cases are `status: untestable` for missing inputs that no engine work removes (CP-08: the a(x) taper exists only as Fig. 2(a), cell counts and the centre-hole rh are not tabulated; CP-42: the defect holes were measured per hole from SEM, not tabulated). Engine gaps, in order of effort:

| # | Gap | Fact (F) / estimate (E) | Owner |
|---|---|---|---|
| N1 | 3D geometry with elliptic holes | F: `@amp/geom` has 2D `ellipse` / `polygon` and layered extrusion (`extrude.ts`); `@amp/mesh` `meshExtruded` makes tet4 / prism6. F: `prepareRun` builds 3D meshes only for box lists and one cylinder. Needed: a spec feature `extrude` (2D sketch -> z layers: air / Si 220 nm / air) wired in prepareRun, and tet10 (`toP2`) for P2 elasticity. E: 0.5-1 day | MG / L3 |
| N2 | Optical solver size | F: em3d is direct LDL^T; RF-21 ran 32,804 ND2 DOF in seconds, 2.9e5 ND2 DOF did not fit the 1.5 GB heap (DevLog-010 s.7). E: CP-08 eighth model (x, y, z mirror planes as PEC / PMC), beam ~15 um long (cell count not tabulated: assumption), Si h ~50 nm, air h ~150 nm, 1 um air margin: ~3e4 tets, ~2e5 ND2 DOF (6.6 DOF per tet for ND2 on tets, E): at or over the heap cap. Needs the iterative AMS path (DevLog-010 open) or ND1 on a finer mesh (accuracy unmeasured) | L4 |
| N3 | Open optical boundary | F: em3d has PEC / PMC only: f_o is computable, the radiation-limited Q_o target of CP-08 (2.2e7) is not (needs PML / scattering BC) | L4 |
| N4 | 3D anisotropic solid modes | F: `solveElasticModes` takes isotropic E, nu only; `assembleSolid` takes any 6 x 6 D. Needed for Si with x || [100] (CP-08) | MT (request R-MT1) |
| N5 | 3D overlaps | moving-boundary integral over interface triangles (E from ND2 on both tets), photoelastic over tets with the full cubic p rotated to the beam axes (no azimuthal average), m_eff / x_zpf as here. E: 0.5 day | MOM |
| N6 | Coupling type per pair | F: one `CouplingImpl` per type (`couplingImpl` returns the first): 3D needs a second type (e.g. `optomechanical-3d`, elastic -> emw) or a registry change to several `for` pairs | MC (decision) |
| N7 | Unit cells | X-point optical band edge and Gamma-point breathing mode of a mirror-symmetric cell need no Bloch BC (PEC / PMC / roller planes at the cell faces) once N1 exists; Chan 2012 gives unit-cell values as plots only (no gate) | - |
| N8 | Mechanical size | E: tet10 P2 on the Si only, eighth model ~1e4 tets: ~4e4 DOF, feasible in Node and browser (comparable to AC-02 33,825 DOF) | - |

## 4. Results (2026-11-07 09:30 PST; logs `logs/mom-test-20261107-093056.log`, `logs/mom-conv-20261107-093010.log`)

Units: g_OM in rad/s per nm where compared with Baker 2014 (finding F1 below); the coupling's scalars are g / 2 pi (Hz, Hz/m).

### 4.1 Gates

| Gate | Result | Reference | Tolerance | Status |
|---|---|---|---|---|
| G-MB1 2D limit: GaAs cylinder R 1 um spanning a 0.4 um window with PMC top / bottom, z-invariant TE m = 10 mode (201.0688 THz), rigid sidewall shift | g_OM / 2 pi = -200.9689 GHz/nm (per nm of sidewall) | -omega / R / 2 pi = -201.0688 GHz/nm (scale invariance in r; Ding 2010 p.3, Eichenfield 2009 D.2) | 1e-3 | pass, rel 5.0e-4 |
| G-MB2 finite difference: GaAs disk (sim), TE p = 1 m = 10 x RBM1, solid nodes moved by +-0.2 nm x Q, re-solved | g_MB = -1054.303 rad/s/nm (perturbation formula) | -1053.673 rad/s/nm (central difference of the discrete eigenvalue) | 2e-2 | pass, rel 6.0e-4 |
| G-PE1 finite difference, isotropic photoelastic channel (p11 = p12 = -0.15, p44 = 0: d eps_r = -eps_r^2 p tr S per cell) | g_PE = -948.046 rad/s/nm | -948.068 rad/s/nm (re-solve with cell eps_r +- delta) | 2e-2 | pass, rel 2.4e-5 |
| G-B14 Baker 2014 Table 3, frequencies | RBM1 1.3754 GHz, RBM2 3.5042 GHz (bowl 0.4937 GHz) | 1.375, 3.5 (0.494) GHz | 3 % | pass |
| G-B14 x_zpf (max-|Q| reduction point) | RBM1 1.229e-15 m, RBM2 1.184e-15 m | 1.23e-15, 1.15e-15 m | 5 % | pass (-0.1 %, +3.0 %) |
| G-B14 g_om geometric | RBM1 1054.3, RBM2 403.9 rad/s/nm | 1080, 412 "GHz/nm" | 10 % | pass (-2.4 %, -2.0 %) |
| G-B14 g_om photoelastic, frame `cylindrical` (Baker eq. 13 convention) | RBM1 981.0, RBM2 1693.3 rad/s/nm | 984, 1720 "GHz/nm" | 15 % | pass (-0.3 %, -1.6 %) |
| G-B14 g0 (cylindrical frame), x 1e6 rad/s | RBM1 MB 1.296, PE 1.206; RBM2 MB 0.478, PE 2.005 | 1.33, 1.21; 0.474, 1.98 | informative | -2.6 %, -0.3 %; +0.8 %, +1.3 % |
| Optical WGM | TE p = 1 m = 10 at 223.892 THz, lambda 1339.0 nm (E_z energy fraction 0.0024) | Baker Table 1: 1.32 um; Table 3 caption: ~1.3 um | informative | +1.4 % vs 1.32 um |

Sign: both contributions lower omega_o when the rim moves out (g_MB, g_PE < 0 for RBM1 with the mode sign convention of s.1.2); Baker's g = -d omega / dx is positive for both: same physics. The mode sign is a normalisation convention (RBM2 comes out with the opposite overall sign: its max-|u| node's dominant component points the other way); the relative sign of MB and PE is physical and matches Baker (they add).

### 4.2 Mesh convergence (GaAs disk, default hmax Rb/12, disk h/8)

| disk h, air h | cells | DOF (opt + mech) | Node wall (s) | f_o (THz) | f_RBM1 (GHz) | g_MB RBM1 | g_PE RBM1 (crystal-avg) | g_MB RBM2 | g_PE RBM2 | g0 / 2 pi RBM1 (kHz) |
|---|---|---|---|---|---|---|---|---|---|---|
| h/6, Rb/10 | 1489 | 14,838 | 1.15 | 223.8923 | 1.375399 | -1048.9 | -858.94 | 401.2 | 2105.8 | -373.2 |
| h/8, Rb/12 | 2336 | 23,789 | 1.37 | 223.8917 | 1.375399 | -1054.3 | -858.92 | 403.9 | 2105.4 | -374.3 |
| h/12, Rb/16 | 4470 | 47,134 | 3.39 | 223.8919 | 1.375399 | -1054.5 | -858.94 | 403.9 | 2104.8 | -374.3 |
| h/16, Rb/20 | 7226 | 77,431 | 6.27 | 223.8921 | 1.375399 | -1052.6 | -858.94 | 403.0 | 2104.7 | -373.9 |

g in rad/s/nm. g_PE converged to 1e-4; g_MB within +-0.3 % without a monotone trend (E: the field at the disk corners, where E_perp is singular, enters the edge integral; the averaging of the two sides converges slowly there). The default level is within 0.2 % of the finest.

### 4.3 Regime of g ~ omega / R (thin disk)
- omega_o / R = 1406.8 rad/s/nm (Baker p.11: "~1.4 THz/nm", their units, F1).
- Rigid sidewall translation of the 320 nm disk: g = 0.861 omega / R (h/8 level; 0.857-0.861 over the 4 levels). The thick-disk derivation (effective-index separation, dispersion in k R only, Ding 2010 p.3) needs h well above lambda / n = 1.339 / 3.40 = 0.39 um; at h = 0.32 um the vertical confinement adds a length scale and the WGM frequency is no longer a function of k R alone. G-MB1 (z-invariant field) recovers -omega / R to 5e-4.
- RBM1 with the real mode shape (max-|Q| normalisation, Poisson out-of-plane motion included): g_MB = 0.749 omega / R (Baker: 1080 / 1400 = 0.77, "roughly 20 % below").

### 4.4 Performance and regression
- Default sim (Node v23.7.0, nice 10): prepare 0.05 s, optical (m = 10, 4 modes, ND2 + P2) 0.56 s, mechanical (6 modes, P2) 0.11 s, overlaps (4 x 6 pairs) 0.59 s; 23,789 DOF; total 1.37 s. Browser: not measured (same code path; E: similar order, the web runner calls runStudy).
- Class-a eval (`logs/MOM-eval-a-20261107T093207.log`, records `logs/eval-20261107T093207.jsonl`): cases 11 pass, 18 pending; targets 37 pass, 95 pending, 4 info: identical to the MC baseline counts (DevLog-031 s.2, 08:29). No existing file was edited by this lane, and nothing imports the new files until R-MC1.
- `pnpm -r check`: 0 errors (`logs/MOM-pnpm-check-20261107T093207.log`).
- `pnpm -r test` first pass failed in `packages/spec` `sims-live.test.ts`: every `sims/*.yaml` must validate against the registry, and `optomechanical` is not registered until R-MC1. Fix (09:35): the spec moved to `validation/mom/sims/gaas-microdisk-om.yaml` (header line says so); `test/mom-common.ts` loads `sims/<id>.yaml` when present, else the staged copy. The coordinator moves it to `sims/` together with R-MC1. Rerun `pnpm -r --no-bail test` (`logs/MOM-pnpm-test-nobail-20261107T093535.log`): all 12 packages pass (physics 105 / 0 incl. the 4 MOM tests; materials 22 / 0: an earlier `pzt-4 C` failure there was a parallel MX edit in progress, gone in this run).

### 4.5 Findings
- F1 (units): Baker 2014 quotes g_om in "GHz/nm" and g0 in "MHz" as angular rates (rad/s): omega0 / R = 2 pi x 223.9 THz / 1 um = 1.41e12 rad/s per nm matches their "~1.4 THz/nm", and g0 = g_om x_zpf = 1080e18 x 1.23e-15 = 1.33e6 matches "1.33 MHz" only in rad/s. In Hz: Baker RBM1 g0 / 2 pi = 2.54 / 2 pi = 0.404 MHz; ours (cylindrical frame) 0.398 MHz.
- F2 (photoelastic frame): for a (001) GaAs disk the azimuthally averaged p tensor (`crystal-avg`, exact for m != 2 with an m = 0 mechanical mode) gives g_PE 858.9 (RBM1, -12.4 % vs the cylindrical convention) and 2105.4 rad/s/nm (RBM2, +24 %). Baker's eq. 13 applies the cubic matrix in the local (r, theta, z) frame, i.e. it assumes [100] along r at every azimuth. The default of the coupling is `crystal-avg`; the sim states it; `cylindrical` reproduces Baker.
- F3 (Chan 2012 eq. 3): the shear products are labelled Ex Ey S4, Ex Ez S5, Ey Ez S6 (Voigt order xy, xz, yz) and the last term lacks the factor 2 of the first two; the coupling contracts the full tensor (2 Re(E_i E_j) for every off-diagonal pair).
- F4 (stiffness): an axisymmetric run of a cubic crystal (Si with C from materials/silicon.yaml) uses the azimuthal average of C with [001] on the axis (approximation: the 4 phi part couples m = 0 to m = +-4 mechanical modes); exercised only by the tensor test (no Si disk sim).

## 5. Requests (to the coordinator for routing)

- R-MC1 (`couplings/index.ts`, MC): register the coupling (no other change needed; `optomech.ts` imports `twoway.ts` helpers, no cycle through index):
  ```ts
  import { OPTOMECH_COUPLINGS, OPTOMECH_REGISTRATIONS, OPTOMECH_NEEDS } from './optomech.ts';
  export const COUPLING_NEEDS: Record<string, { to?: string[]; from?: string[] }> = { ...CORE_NEEDS, ...PHOTONIC_NEEDS, ...OPTOMECH_NEEDS };
  export const COUPLINGS: CouplingImpl[] = [...CORE_COUPLINGS, ...PHOTONIC_COUPLINGS, ...TWOWAY_COUPLINGS, ...OPTOMECH_COUPLINGS];
  export const COUPLING_REGISTRATIONS: Registration[] = [...CORE_REGISTRATIONS, ...PHOTONIC_REGISTRATIONS, ...TWOWAY_REGISTRATIONS, ...OPTOMECH_REGISTRATIONS];
  ```
  Until then the spec is staged at `validation/mom/sims/gaas-microdisk-om.yaml` (a `sims/` copy would fail `packages/spec` sims-live and `prepareRun` validation: unknown coupling type); move it to `sims/gaas-microdisk-om.yaml` with this change. The MOM tests work around the missing registration (`test/mom-common.ts` strips and restores the coupling node; it switches to the plain path automatically once registered).
- R-MC2 (`registrations.ts` RESULT_NAMES, MC): `optomechanical` scalars `g0_<i>_<j>`, `g0MB_<i>_<j>`, `g0PE_<i>_<j>` (Hz, g0 / 2 pi), `gOM_<i>_<j>`, `gOMMB_<i>_<j>`, `gOMPE_<i>_<j>` (Hz/m, g_OM / 2 pi), `<elastic>.f_<j>`, `<elastic>.meff_<j>` (kg), `<elastic>.xzpf_<j>` (m), `<emw-axisym>.f_<i>`, `.m_<i>`, `.ezFraction_<i>`; fields `E_rphiz` (optical steps), `u` (mechanical steps). After the driver merge the pair scalars are keyed `<elastic id>.g0_<i>_<j>` (monolithic rule) plus the bare names.
- R-MC3 (info, web / results): the merged step list holds optical steps (THz) then mechanical steps (GHz), kind `eigen`; a field exists only on its own steps. A step picker that assumes every field on every step would show no `u` on optical steps (and no E on mechanical ones).
- R-MT1 (`elastic/modal.ts`, MT): optional `D?: (e: number) => Float64Array` in `ModalProblem` (used instead of `isoD` when given). `optomech/axisym.ts` `solidModesAxisym` copies the modal scheme only because of that; 3D Si (CP-08) needs it too.
- R-MX1 (`materials/`, MX): `materials/gaas.yaml` (rho, isotropic E / nu or the cubic C, n(lambda) Skauli 2003 Sellmeier, photoelastic p11 p12 p44 with wavelength), and a `p_photoelastic` (cubic) property for `silicon.yaml` (Chan 2012 / Biegelsen 1974: -0.094, 0.017, -0.051, crystal axes x [100], y [010], measured at 3.39 um per Baker 2014 Table 2). The sim keeps spec overrides with provenance until then.
- R-MX2 (`apps/web/src/lib/library/catalog-mp.ts`, MX): entry
  ```ts
  { id: 'gaas-microdisk-om', title: 'GaAs microdisk optomechanical g0 (axisym)', category: 'multiphysics', physics: ['elastic', 'emw-axisym'], dimension: 'axisym',
  	evalCases: [], evalClass: [], ref: { ...NOT_RUN, note: 'reference: Baker 2014 Opt. Express 22 14072 Table 3; engine gates in DevLog-034 s.4 (no eval case)' },
  	couplings: [{ type: 'optomechanical', from: 'elastic', to: 'emw-axisym' }], tags: ['optomechanics', 'g0', 'whispering gallery', 'radial breathing mode', 'photoelastic', 'moving boundary', 'GaAs', 'Baker 2014'] },
  ```
- R-LP1 (previews): regenerate the preview of `gaas-microdisk-om` after R-MC1.

## 6. Open items
- O1 3D optomechanics (CP-08 / CP-42): s.3 gaps N1-N6; the case inputs are missing anyway.
- O2 Optical material dispersion: eps_r at one wavelength (1.32 um); the WGM lands at 1339.0 nm. One fixed-point step (n at 1.339 um = 3.3987, Skauli) would move lambda by about -0.1 % (E: lambda ~ n at fixed m); not iterated.
- O3 Radiation loss of the WGM is not modelled (closed PEC window); f_o is the real part only.
- O4 g_MB converges within +-0.3 % without a monotone trend (corner singularity on the edge integral); a corner-graded mesh or the volume form of the perturbation would tighten it.
- O5 Mechanical modes are azimuthal order 0 only (MT); an optical pair with m_mech != 0 needs m_opt +- m_mech selection rules (not implemented).
- O6 `crystal-avg` is exact for optical m != 2 (readiness reports m = 2); the anisotropic stiffness average (F4) is an approximation.
- O7 Browser timing not measured.

## 7. Sources downloaded by this lane (session scratch, not committed; 2026-11-07)

| Source | URL | sha256 |
|---|---|---|
| Ding et al. 2010 PRL 105 263903 (arXiv 1007.3392) | https://arxiv.org/pdf/1007.3392 | ee4b76b6a14c0d9d3bd10f503b7a5e6eb42efe91d3e68c1db1b286ec352262a8 |
| Baker et al. 2014 Opt. Express 22 14072 (arXiv 1403.4269v1) | https://arxiv.org/pdf/1403.4269 | 3c4930bad1f5e6d7009e524455c3460ba15b1a5878363f1d59839fdc0441420a |
| refractiveindex.info GaAs/nk/Skauli.yml (CC0; Skauli et al. 2003 JAP 94 6447) | https://raw.githubusercontent.com/polyanskiy/refractiveindex.info-database/main/database/data/main/GaAs/nk/Skauli.yml | 4c7b62ff1d4bb68e1d6bbab770d44368d8020fe93ea1e669b2819674cbbfc1a8 |

Cached in the repo (read only): Chan et al. 2012 `cache/eval-b/chan-2012/` (CP-08), Eichenfield et al. 2009 `cache/eval-b/eichenfield-2009/` (CP-42). Johnson et al. 2002 PRE 65 066611 was not read directly; its formula is taken as restated in Chan 2012 eq. 1 and Eichenfield 2009 eq. D4 (identical sign conventions). Biegelsen 1974 not read (paywalled); the Si p_ij are as quoted by Chan 2012 and Baker 2014 Table 2 (3.39 um).
