# DevLog-010: Physics wave 1 (lane L4, `@amp/physics`, `@amp/post`)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L4 (DevLog-001 section 9) |
| Owns | `packages/physics/**`, `packages/post/**`, this file |
| Inputs | DevLog-001 s.4-8 (A5, A8, A9, heroes H1-H6, targets), CONTRACTS-v0 C2-C6, DevLog-002 (core), DevLog-003 (spec), DevLog-004 (geom/mesh), DevLog-006 (class-a cases), DevLog-009 (harness), R3 s.3 |
| Sources (read only) | `eo-modulator-atlas` (EO) at `0546007`: `engine/src/vector-mode.mjs`, `engine/src/postproc/*`; Palace docs `rings.md`, `spheres.md` (Apache-2.0, values cited, fetched 2026-11-06) |

## 1. Plan (written 2026-11-06 15:45 PST, before coding)

### 1.1 Package layout

`packages/physics` (TypeScript, erasable syntax; ported EO code as `.mjs` + `.d.mts` with C1 port header):

| Path | Content |
|---|---|
| `src/common/solution.ts` | C5 `Solution` builder: stage timer, run record (`@amp/spec` run-record helpers), engine string `@amp/physics@<ver>+dirty` (no git sha available to lanes) |
| `src/common/mesh.ts` | C2 mesh access: cells by type, facets by boundary index, selection -> index sets, P2 node maps (tri6/tet10), node coordinates |
| `src/common/quad.ts` | Gauss-Legendre, triangle (core `TRI_QUAD` degree 6), tet (collapsed Gauss, any degree), hex tensor rules |
| `src/common/lagrange.ts` | P1/P2 triangle and tet, Q1 hex, line2/line3, tri3/tri6/quad4 facet shape functions and isoparametric Jacobians |
| `src/common/scalar.ts` | Generic scalar H1 assembly: `div(K grad u) + c u` with per-cell coefficients, axisym weight r or 1/r, Robin/flux facet terms, Dirichlet elimination, SPD solve (supernodal Cholesky; AMG-PCG above a size gate) |
| `src/common/eigen.ts` | Shift-invert block Arnoldi driver on `@amp/core` (`analyze` + `SupernodalLDLT`, `blockArnoldi`), Sylvester inertia count, optional null-space projector |
| `src/common/fixtures*.ts` | Structured C2 meshes (rect tri, box tet/hex, disk-extruded cylinder tets) for tests until L3's 3D meshers land |
| `src/heat/` | `heat`: steady + BDF2 transient; k, rho, cp per domain; BCs fixed T, flux, convection, radiation (Newton), insulation, volume source; 2D, axisym, 3D (tet P1/P2, hex Q1) |
| `src/elastic/` | `elastic`: plane stress / plane strain (tri P2), 3D (tet P2); thermal strain input; von Mises, principal stresses, K_t |
| `src/electrostatics/` | `electrostatics`: 2D and axisym; terminals -> Maxwell capacitance matrix; C' and Z0 for 2D lines |
| `src/magnetostatics/` | `magnetostatics` axisym A_phi; coil current density; inductance matrix from energy / flux |
| `src/modes/` | `em-modes`: EO vector mode solver ported (Nedelec + Lagrange part) on `@amp/core` |
| `src/em3d/` | `emw` eigen: 3D Nedelec order 1-2, shift-invert Arnoldi, gradient null-space handling, dielectric Q |
| `src/acoustics/` | `acoustics` eigen: 3D Helmholtz (tet P1/P2, hex Q1) |
| `src/prepare.ts` (planned as `spec-adapter.ts`; renamed, audit M10) | spec -> geometry (L3 `buildGeometry2D`) -> mesh (L3 `mesh2d` / `meshBoxes` / local 3D fixtures) -> RunContext; `prepareRun` for L8 |
| `src/registrations.ts` | registry entries that supersede L2's provisional wave-1 ones where L4 needs settings (`registry.register(r, {replace: true})`) |
| `src/index.ts` | `modules`, `registry`, `prepareRun` (L8 hook, DevLog-009 contract request 2) |
| `gates/` | gate scripts per hero: convergence over >= 3 levels, error vs reference, per-stage wall time, < 5 s check |

`packages/post` (TypeScript; EO `postproc/` store / evaluate / refine ported where generic): solution store (by run, field, step), derived values (integrals, max/min over selections, probes), field evaluation at points (point location on tri/tet/hex, P1/P2/Nedelec interpolation), sampling for plots (lines, grids), CSV export, and `sample(solution, mesh, field, points, component?)` for L8 (DevLog-009 contract request 4).

### 1.2 Numerics decisions

- Assembly in new TS code on `@amp/core` CSR patterns (`buildElementPattern`, `elementSlots`), not on EO `fem/tri.mjs` (EO P1/P2 triangle-only, coupled to its permittivity tensor layout). Solves: supernodal Cholesky (SPD), supernodal LDL^T (indefinite, shift-invert), AMG-PCG (large 3D SPD).
- Axisymmetric scalar (heat, electrostatics): weight r dr dz. Magnetostatics A_phi: weak form int (1/mu) [(1/r) d(r A)/dr d(r w)/dr / r ... ] written with the curl in (r, z) components B_r = -dA/dz, B_z = (1/r) d(r A)/dr, measure r dr dz, so the operator carries the 1/r terms exactly; A_phi = 0 on the axis is a Dirichlet condition. Implemented with test/trial A (not psi = r A), quadrature on r > 0 only (no node evaluation of 1/r).
- Far boundary (magnetostatics, electrostatics open problems): large air domain (half-disk in (r, z)) with geometric mesh grading, not an infinite-element mapping. Reasons: (a) the truncation error has a closed form: for a current loop system of dipole moment m, n x A = 0 on a sphere of radius R_b changes the central field by -mu0 m / (2 pi R_b^3), i.e. -1.40 (R/R_b)^3 for the Helmholtz pair (derived in s.4.3); for an isolated conductor of radius a with the outer sphere grounded, C = 4 pi eps0 a R_b / (R_b - a), i.e. relative error a / R_b; (b) with element size growing in proportion to radius the element count grows with log(R_b), so R_b / R = 50..10^3 costs a few hundred triangles; (c) no new element type to validate. Truncation is verified by a domain-doubling study.
- Radiation: Newton on q = eps sigma (T^4 - T_amb^4), tangent 4 eps sigma T^3; sigma from CODATA via code constant (a physical constant, not a material property; source cited in code).
- Transient: BDF2 with a BDF1 first step; consistent mass.
- 3D Maxwell eigen: shift sigma inside the target band; gradient (null-space) modes map to mu = -1/sigma and are filtered by eigenvalue and by a discrete-divergence check; optional projection of the Arnoldi start block. Curved boundaries: isoparametric quadratic geometry on boundary tets (covariant Piola), because straight-sided tets on a cylinder leave an O(h^2) geometric eigenvalue error that the 1e-5 RF gate does not admit.
- Dielectric Q: first-order perturbation Q_d^-1 = sum_i tan_delta_i W_e,i / W_e (equals 1/tan_delta for a homogeneous fill).

### 1.3 Gates (references as in R3 s.3 and L7a expected JSON)

| Hero | Gate | Reference | Tolerance (from the case) |
|---|---|---|---|
| H2 | HT-01 T4 | T(E) 18.25375654 C (D) | rel 1e-3 after Richardson |
| H2 | HT-02 T3 | 36.60311596 C at x 0.08 m, t 32 s (D) | rel 1e-3 after Richardson (h and dt) |
| H2 | HT-03 T2 | T_B 927.0039505 K (D) | rel 1e-6 |
| H2 | HT-04 Carslaw-Jaeger | 140.4188 / 98.8528 / 51.7628 / 14.4540 C (D) | rel 1e-3 after Richardson |
| H1 | SM-01 Kirsch | K_t 3, field vs closed form; K_t(W/D) -> 3 | rel 1e-3; stress L2 rate >= 1 |
| H1 | SM-02 LE1 | sigma_yy(D) 92.7 MPa (P) | rel 1e-2 |
| H3 | EM-04 Helmholtz | B center 8.991762855 uT (D) | rel 1e-3 after Richardson |
| H3 | EM-03 rings | M_ab 1.973921 pH, L_aa 41.78537, L_bb 707.2050 pH (Palace analytic, thin-wire asymptotics) | set from the asymptotic error of the formulas before the run (s.4.3) |
| - | EM-01 coax | C' 93.25647 pF/m, Z0 51.83343 Ohm (D) | rel 1e-3 |
| - | EM-02 spheres | C_aa 1.230518, C_bb 2.431543, C_ab -0.4945668 pF (Lekner) | to be set before the run |
| H4 | WO-01 slab | n_eff TE0 2.849489467, TM0 2.054618547 (D) | rel 1e-6 after Richardson |
| H4 | WO-02 Hadley rib | n_eff(t) table (S, +-3e-6) | +-3e-6 abs |
| H5 | RF-01 / RF-21 cavity | TM010 2.903636072, TE111 2.922197191, TM011 3.468175213 GHz (D, exact Bessel zeros) | rel 1e-5 after Richardson |
| H6 | AC-02 box | 171.500, 214.375, 274.534, 285.833 Hz (D) | rel 1e-4 after Richardson |

Each hero: >= 3 mesh levels, error vs reference, wall time per stage in Node, < 5 s check at the accuracy the case requires. Gates go to L8 through `@amp/physics` exports `modules` + `prepareRun`.

### 1.4 Work split

L4 runs two forked sub-lanes (same rules, own paths inside `packages/physics`, no DevLog edits; results merged here by L4):
- F1 modes: `src/modes/**`, `test/modes*.test.ts`, `gates/modes*.ts` (WO-01, WO-02).
- F2 3D eigen: `src/em3d/**`, `src/acoustics/**`, `src/common/eigen.ts`, `src/common/fixtures3d.ts`, `test/{em3d,acoustics,eigen}*.test.ts`, `gates/{rf,ac}*.ts` (RF-01, AC-02).
- L4 itself: common, heat, elastic, electrostatics, magnetostatics, spec adapter, registry, `@amp/post`, gates HT/SM/EM.

## 2. TODO

- [x] Package scaffolds (physics, post), common/solution, mesh, quad, lagrange
- [x] common/scalar assembly + solves (Cholesky, AMG-PCG), Robin/flux facets, Dirichlet elimination
- [x] heat steady/transient (BDF2), fixed T (constant or f(x, t)), flux, convection, radiation (Newton), insulation, source; 2D/axisym/3D tet/hex; HT-01..04
- [x] elastic plane stress/strain (tri P2) + 3D (tet P2), thermal strain, von Mises, principal stresses; SM-01, SM-02
- [x] electrostatics 2D/axisym, Maxwell capacitance matrix, C'/L'/Z0; EM-01, EM-02
- [x] magnetostatics axisym A_phi, coils, inductance matrix; EM-04, EM-03
- [x] modes (F1): EO vector-mode port; WO-01, WO-02
- [x] em3d eigen (F2): ND1/ND2, curved tet10, gradient projector, Q_d; RF-01/RF-21 (4 of 6 modes at 1e-5, see 4.2)
- [x] acoustics eigen (F2); AC-02
- [x] registrations, prepareRun, `modules`/`registry` exports; harness loads them (prepare: yes, sample: yes)
- [x] @amp/post: store, derived (integrate, extrema), evaluate at points (+ gradient), sampling (points, lines, grids), CSV, `sample` hook, EO refine port
- [x] Convergence + timing table per hero (4.1)
- [x] tsc clean (physics, post), tests green (physics 33, post 4)
- [x] Hand-off
- [ ] RF-21 TM110 / TE011 at 1e-5 and the <5 s target for all six cavity modes (open, 6.)
- [ ] Eval cases run on the engine through the harness once L7a points `spec:` at specs (contract request 2)

## 3. Progress log

- 2026-11-06 15:39 PST: read CLAUDE.md, DevLog-001, CONTRACTS-v0 (incl. 15:45 changelog), DevLog-002/003/004/006/009, R3 s.3; surveyed `@amp/core` (la, fem), L2 types/run-record/provisional registry and sims, L3 geom/mesh2d (smoke: quarter Kirsch plate tri6 797 cells in 15 ms), L8 registry hook, L7a cases. Fetched Palace rings.md and spheres.md (geometry and analytic values).
- 2026-11-06 15:45 PST: plan written.
- 2026-11-06 15:50 PST: scaffolds (`pnpm install --ignore-workspace --config.lockfile=false` in packages/physics and packages/post: links to core/spec/geom/mesh/post/materials, typescript 5.9.3, @types/node 24.19.2; zod linked to the @amp/spec copy, contract request 4). common/{solution,mesh,quad,lagrange,scalar}.ts; test/common.test.ts 5/5 (quadrature moments, tet4/tet10/hex8 Poisson, tri6 Robin exact to 1e-13, AMG-PCG = Cholesky to 1e-9).
- 2026-11-06 15:52 PST: forked sub-lanes F1 (modes) and F2 (em3d + acoustics + eigen driver) launched (DevLog plan s.1.4).
- 2026-11-06 16:05 PST: coordinator messages handled: shared types from `@amp/spec/types` (no shim used); L1 audit S1 (tri-fe micrometre scale): `@amp/physics` does not use tri-fe; a unit-square integral test in metres guards post (post.test.ts); S2: every core call path used is exercised by tests (sparse buildElementPattern/elementSlots/SparseCholesky, amg buildAMG, ldlt analyze/SupernodalLDLT, arnoldi blockArnoldi, hcurl/space via F2).
- 2026-11-07 00:09 UTC (16:09 PST): heat gates HT-01..04 pass (4.1). HT-04 first run with levels n = 10..80 was non-monotone at x = 0.3462 m (p_obs 0.08, fail); levels moved to n = 20..160 (asymptotic range), pass.
- 2026-11-06 16:12 PST: elastic gates: first run with hmax/refine scaled but the mesh grading fixed showed stress L2 rate 0.73-0.97 (P2 expects 2) and oscillating point values: the size field h(d) = h0 + g d does not refine away from the hole unless g scales too. With g scaled per level: rates 1.88/1.97/1.99, all SM-01/SM-02 targets pass. The same rule is applied in prepareRun (s.1 of prepare.ts).
- 2026-11-06 16:13 PST: F1 hand-off (WO-01, WO-02 pass; 4.2). 16:16 PST: F2 hand-off (AC-02 pass; RF-21 4/6 modes; 4.2). F2's ctx helpers moved to common/ctx.ts (re-exported from em3d/ctx.ts).
- 2026-11-06 16:17-16:24 PST: EM gates (tolerances of EM-02/EM-03 fixed first, 4.3). EM-04 first run: uniformity 2.25e-5 off (limit 2e-5) with the centre region coarse; a refinement-only box around the centre fixed it. EM-02: spheres on the axis must be subtracted (difference), a kept tool crossing r < 0 is rejected by @amp/geom.
- 2026-11-06 16:20 PST: registrations, prepareRun, index; prepareRun + module.run on all six sims (`gates/prepare-smoke.ts`): 5 run (N/A values from the eval case), si-rib-waveguide not ready (n N/A, no case file for WO-02). Harness CLI on HT-01/SM-01/EM-04/AC-02/RF-21: modules and prepare found, cases `pending` (spec pending in the case files). In-memory demo (`gates/harness-demo.ts`, HT-01 with spec sims/heat-plate-fin.yaml and a probe extract): engine run through the harness worker gives T_E = 18.253729 C (rel -1.5e-6) but status `fail`: "richardson unavailable (oscillatory)" on the non-nested CDT levels (contract request 3).
- 2026-11-06 16:26 PST: L3 audit fixes adopted: selections go through `@amp/geom` resolveEntityIds (common/mesh.ts selectEntities, an unknown id is an error for physics); mesh `warnings` are passed on as prepareRun notes (C4 `readiness(spec, physicsId)` has no mesh argument, contract request 8). Regression: tests 33/33 + 4/4, elastic gate unchanged, prepare smoke unchanged.
- 2026-11-06 16:23 PST: final runs of heat and EM gates (logs below); tests: physics 33/33, post 4/4; tsc clean; scans: no non-ASCII, no absolute paths in packages/physics, packages/post.

## 4. Results

Machine: Apple M4 Pro, 12 cores, Node v23.7.0, nice 10, heap cap 1536 MB, 8 other lanes active (load average 3-6). Wall times are Node single-thread, not browser.

### 4.1 Gates per hero (convergence over >= 3 levels, Richardson over the 3 finest with observed order; reference values from eval/expected unless stated)

| Hero | Gate | Levels (DOF) | Finest value | Error used (basis) | Tolerance | Result | Time to accuracy (single level) / all levels |
|---|---|---|---|---|---|---|---|
| H2 | HT-01 T4 T(E) | tri6 structured 4 levels, 176-8,760 | 18.254387 C | -6.4e-6 rel (Richardson, p 2.69) | rel 1e-3 | pass | 13 ms / 61 ms |
| H2 | HT-01 cross-check, L3 mesh2d tri6 hmax 0.025 m | 9,783 | 18.253832 C | 4.1e-6 rel (finest) | - | info | 42 ms |
| H2 | HT-02 T3 T(0.08 m, 32 s), h and dt halved together | 27-237 | 36.597733 C | -1.9e-5 rel (p 2.22) | rel 1e-3 | pass | 2 ms / 7 ms |
| H2 | HT-03 T2 T_B (radiation, Newton) | 4-16 | 927.0039505 K | 2e-12 rel (finest; 1D linear exact) | rel 1e-6 | pass | 0.5 ms |
| H2 | HT-04 Carslaw-Jaeger, 4 depths | 123-963 | 140.4172 / 98.8510 / 51.7608 / 14.4534 C | -4.9e-7 / -3.5e-6 / -2.9e-6 / -8.2e-6 rel (p 2.05-2.21) | rel 1e-3 | pass | 2 ms / 18 ms |
| H1 | SM-01 Kirsch K_t (exact traction, L = 10 a) | tri6 4 levels, 1,604-36,892 | 3.000150 | 5.0e-5 rel (finest; nodal stress averages oscillate, no Richardson) | rel 1e-3 | pass | 66 ms / 1.26 s |
| H1 | SM-01 sigma_yy(a, 0) | same | -100.0018 MPa | 1.8e-5 rel (finest) | rel 1e-3 | pass | |
| H1 | SM-01 u_x(L, 0), u_y(0, L) | same | 2.566087e-5, -7.835875e-6 m | 2.8e-8, -3.7e-9 rel (p 2.59, 3.39) | rel 1e-3 | pass | |
| H1 | SM-01 stress rel L2 error vs Kirsch field | same | 1.97e-3, 5.34e-4, 1.37e-4, 3.44e-5 | rates 1.88, 1.97, 1.99 | rate >= 1 | pass | |
| H1 | SM-01 K_t(W/D), uniform tension | W/D 2.5 / 5 / 10 / 20 / 40 / 80 | 4.7813 / 3.3591 / 3.0860 / 3.0212 / 3.0052 / 3.0004 | K_t - 3 falls about 4x per doubling of W/D | -> 3 | info | 72-98 ms each |
| H1 | SM-02 LE1 sigma_yy(D) | tri6 4 levels, 742-44,290 | 92.6586 MPa | -4.5e-4 rel vs 92.7 (P) | rel 1e-2 | pass | 73 ms |
| H3 | EM-04 B(0), R_b = 100 R, s = R/100 | tri6 3 levels, 11,314-176,858 | 8.991735 uT | -3.1e-6 rel (p 4.01); vs finite-section reference -1.4e-6 | rel 1e-3 | pass | 151 ms / 1.71 s |
| H3 | EM-04 Bz, Br at (0.02, 0.01) m; uniformity on r = 0.1 R | same | 8.997383 uT; -8.3598 nT; 1.1424e-4 | -3.2e-6 rel; 8.6e-12 T abs; 3.0e-7 abs | rel 1e-3; abs 9e-10 T; abs 2e-5 | pass | |
| H3 | EM-04 truncation, R_b = 30 R vs 100 R | finest level settings | -5.039e-5 | dipole image -5.176e-5 + 1.4e-6 | abs 1e-5 | pass | |
| H3 | EM-03 rings M_ab / L_aa / L_bb | tri6 3 levels, 30,895-223,423 | 1.982604 / 41.80660 / 707.2078 pH | 6.2e-4 (vs filament 1.981370) / 5.1e-4 / 4.0e-6 rel (p 3.90) | 5e-3 / 2e-2 / 2e-3 | pass | 0.70 s / 4.54 s |
| H3 | EM-03 M_ab vs Palace 1.973921 pH | | | 4.4e-3 rel (Palace formula is the small-loop limit) | info | | |
| - | EM-01 coax C' / L' / Z0 | tri6 3 levels, 556-7,949 | 93.25655 pF/m, 250.5524 nH/m, 51.83339 Ohm | -6.9e-6, 6.9e-6, 6.9e-6 rel (p 1.88) | rel 1e-3 | pass | 16 ms / 106 ms |
| - | EM-02 Lekner C_aa / C_bb / C_ab | tri6 3 levels, 7,389-112,616 | 1.230522 / 2.431577 / -0.4945540 pF | 4.0e-6 / 1.4e-5 / -2.6e-5 rel (p 3.9-4.0; consistent with the a/R_out = 1e-5 truncation) | rel 1e-3 | pass | 61 ms / 0.97 s |
| H4 | WO-01 slab TE0 / TM0 (F1) | 4 levels, 277-25,951 | | 4.8e-10 / 1.3e-9 rel (p 3.76 / 4.19) | rel 1e-6 | pass | 39 / 28 ms |
| H4 | WO-02 Hadley rib n_eff, t = 0..0.7 um (F1; femwell sources fetched 2026-11-06) | 3 scales, 43k-210k | | Richardson abs err <= 7.8e-7 for all 8 | abs 3e-6 | pass | single level s = 0.5 about 2 s; 3-level sequence 7.0-7.6 s per t |
| H4 | WO-02 metal box, 4 eps pairs (F1) | 4 levels, 3.6k-229k | | <= 1.3e-7 abs (8/1: p 0.66, soft) | abs 1e-6 (F1's choice before the run) | pass | 2.4-3.2 s sequence |
| H5 | RF-21 TM010 / TE111 / TM011 / TE211 (F2; ND2 curved tet10) | N = 4, 5, 6: 13,192-46,068 | | 3.0e-7 / -3.7e-8 / -1.6e-7 / -8.0e-7 rel (p 4.1-4.8) | rel 1e-5 | superseded by Follow-up 2 (s.7.2): under the shared rule only TM010 and TM011 pass | 20 s (CORRECTED 17:05 PST, audit B1: the earlier "2.2 s for the 3 hero modes" used N = 2..4 with p_obs 5.48, outside the band of the theoretical order 4) |
| H5 | RF-21 TM110 / TE011 (F2) | same | | -2.4e-5 (p 1.97) / -1.0e-5 (p 3.54) | rel 1e-5 | FAIL (pre-asymptotic order; with p = 4 assumed: 4.8e-7 / 3.6e-6, not gated) | 22 s for N = 3..6 |
| H5 | RF-21 Q_d (perturbation) | | 2500.000000 | 0 | rel 1e-3 | pass | |
| H6 | AC-02 10 box modes (F2; tet10 P2) | 693 / 4,641 / 14,725 | | worst -7.2e-6 rel (f_mode8, p 3.66-3.87); finest alone within 6.6e-5 | rel 1e-4 | pass | 1.33 s / 1.7 s; hex8 Q1 also passes (p 2.00, 1.5 s) |

<5 s check (Node, at the case accuracy): H1 yes (0.07 s), H2 yes (< 0.07 s), H3 yes (0.15 s for EM-04; EM-03 0.7 s), H4 WO-01 yes, WO-02 rib yes on one level (about 2 s) but no for the 3-level Richardson sequence (7 s), H5 NO (corrected 17:05 PST, audit B1: the 2.2 s figure rested on p_obs 5.48 > 4; see s.7.2: no H5 sequence meets 1e-5 under the shared rule, the best (rings N = 4-6) passes TM010 / TM011 in 20 s), H6 yes (1.7 s).

Palace RF-01 table vs exact Bessel values (F2): deltas -1.10e-5 (TM010), 5.1e-6 (TE111), -7.4e-6 (TM011), -8.8e-6 (TE211), 2.3e-5 (TM110), 8.9e-6 (TE011): consistent with L7a's finding (4-decimal Bessel zeros in Palace's analytic table).

Logs: `logs/l4-heat-20261107T002340Z.jsonl`, `logs/l4-elastic-20261107T002550Z.jsonl`, `logs/l4-em-20261107T002340Z.jsonl`, `logs/l4-modes-wo01-20261106T235508Z.jsonl`, `logs/l4-modes-wo02-20261106T23*.jsonl` (9 files, F1), `logs/l4-rf01-20261106T160210.jsonl`, `logs/l4-rf01-20261106T160146.jsonl`, `logs/l4-ac02-20261106T160324.jsonl` (F2).

### 4.2 Sub-lane reports (merged)

F1 modes: `src/modes/vector-mode.mjs` (+ `.d.mts`, 1245 lines) ported from EO `engine/src/vector-mode.mjs` at 0546007 with a port header. Changes: generic triangle mesh with explicit PEC edge/node sets (EO section, window sides, mirror and meshing removed); per-triangle eps, optional epsIm and epsG; blockArnoldi, TRI_Q4, triangleGeometry, LDLT classes and analyze from @amp/core; EO overlap / optical-field / static-field sampling dropped; tri6 mid-edge nodes ignored (straight triangles). Module `emModes` (type em-modes), `solveModes`, `problemFromContext`; 7 tests. WO-01: TE0 with PEC side walls, TM0 with PMC (exact for the x-invariant mode), window 0.1 um wide. WO-02: inputs from femwell `mode_solver.py` at 6154df58 and `mode_solver_rectangle.py` at 37c2885e (fetched 2026-11-06); femwell's defaults (natural outer boundaries, top mode) are used; half window with PEC then PMC on x = 0, larger n_eff taken (quasi-TE, TE fraction >= 0.9999).

F2 eigen: `src/common/eigen.ts` shiftInvertEigen (Cholesky when sigma < 0, else LDL^T with Sylvester count; blockArnoldi; projector hook on start block and op outputs; one inverse-iteration refinement; Rayleigh quotients); `src/common/fixtures3d.ts` cylinderTetMesh (tet4/tet10, mesh2d or structured ring disk, Dompierre split, side mid-nodes on the exact cylinder, conformity check); `src/em3d/index.ts` (toHcurlMesh, curved covariant-Piola ND1/ND2 on tet10, PEC elimination, M-orthogonal gradient projector from the discrete gradient with a Cholesky of G^T M G, divergence residual about 8e-16 per mode, Q_d, TE/TM character); `src/acoustics/index.ts` (P1/P2 tri/tet, Q1 hex, axisym weight r, pressure BC, zero mode kept as f = 0). Findings: straight tets on the L3 circle discretisation cap TM010 at 2.7e-3 error (curved geometry required); block size 1 fastest; 4-point Gauss per direction converged to 1e-9.

### 4.3 Tolerances fixed before the EM-02 / EM-03 runs (2026-11-06 16:20 PST)

No class-c case files exist yet for EM-02 / EM-03 (L7c), so the L4 gates use these, set from the error of the reference formulas, not from any run:
- EM-03 rings (Palace rings.md: r_a 10 um, r_b 100 um, w 1 um; the analytic values are thin-wire asymptotics). Modelled as round sections of diameter w with uniform current (the -1.75 = -2 + 1/4 constant of mu0 r (ln(16 r / w) - 1.75) is the round-wire value with internal inductance).
  - M_ab against the exact coaxial-filament formula (Maxwell, elliptic integrals; computed in `gates/em.ts`): rel 5e-3 (finite-section correction O((w / 2 r_a)^2) = 2.5e-3, factor 2).
  - L_aa against mu0 r_a (ln(16 r_a / w) - 1.75): rel 2e-2 (neglected terms O((w / 2 r)^2 ln(16 r / w)), about 1e-2 at r_a).
  - L_bb against the same formula at r_b: rel 2e-3.
  - Palace's M_ab = 1.973921 pH (= mu0 pi r_a^2 / (2 r_b), the small-inner-loop limit; the page prints r_a and r_b swapped in the formula, the value matches the corrected form) is reported, not gated (its own error is O((r_a / r_b)^2)).
- EM-02 spheres (Palace spheres.md: a 1 cm, b 2 cm, c 5 cm, vacuum; Lekner 2011 series, recomputed here with 200 terms): C_aa, C_bb, C_ab rel 1e-3 each. Outer grounded sphere at R_out = 1000 m: single-sphere shift a / R_out = 1e-5.
- EM-04: far boundary R_b = 100 R (A = 0): central-field shift -1.398 (R / R_b)^3 = -1.4e-6 (eval/expected/EM-04.json truncation.*). Coil sections s = R / 100 (as sims/helmholtz-coil.yaml); the gate reference stays the filament value of the case, and the finite-section value (filament field averaged over the section) is printed next to it.


### 4.4 Generic pieces to move into @amp/core later (coordinator request, L1 audit S4)

| Piece | File | Notes |
|---|---|---|
| Shift-invert eigen driver | `packages/physics/src/common/eigen.ts` | = DevLog-002 refactor proposal 4 |
| Lagrange shapes (line2/3, tri3/6, quad4, tet4/10, hex8), isoparametric gradients, facet Jacobians | `common/lagrange.ts` | replaces fem/tri.mjs + tri-fe.mjs triangle-only P1/P2 (proposal 5) |
| Quadrature (Gauss-Legendre, collapsed simplex rules, tensor rules) | `common/quad.ts` | any degree |
| Scalar H1 assembly with axisym weight, Robin/flux facets, Dirichlet elimination, restriction with value-source map (shared pattern for A + sigma B) | `common/scalar.ts` | |
| Block (vector) pattern expansion | `elastic/index.ts` blockPattern | for any vector H1 problem |
| C2 -> H(curl) mesh adapter | `em3d/index.ts` toHcurlMesh | L3 now also has `toHcurlMesh` in @amp/mesh: reconcile |
| CSR PCG with AMG preconditioner | `common/scalar.ts` SpdSolver | core pcg.mjs is stencil-only |
| Point location (bucket grid + inverse isoparametric map) | `packages/post/src/evaluate.ts` | |

## 5. Contract requests

1. **C1 (coordinator): zod for `@amp/physics`.** The registrations (`src/registrations.ts`) build strict settings schemas that `@amp/spec` composes, so they must use the same zod instance. Now `"zod": "link:../spec/node_modules/zod"` in packages/physics/package.json; request approval of `zod` 4.6.7 as a runtime dependency of `@amp/physics` (workspace install dedupes it). Same for `@amp/materials` (`link:../materials`, Node-only import inside prepareRun, lazy).
2. **L7a / L2: case `spec:` pointers.** All hero cases are `spec: pending`, so the harness reports them pending although `@amp/physics` exposes `modules`, `registry`, `prepareRun` and `@amp/post` `sample`. Needed per case: a spec path and, for probe targets, `extract: {kind: probe, field, point}`. Field names: `RESULT_NAMES` in `src/registrations.ts` (heat T; elastic u, sxx, syy, sxy, szz, mises, s1, s2; magnetostatics A_phi, Br, Bz, normB; electrostatics V and scalars C_<i>_<j>, C_per_m, L_per_m, Z0; acoustics/emw eigen values in steps (Hz)). The sims/ specs differ from some gates: kirsch-plate is the uniform-tension W/D = 20 variant (SM-01 gates the exact-traction model, which needs a traction expression in x, y that amp-spec/0 quantities cannot express: request an expression-valued BC form or a dedicated `kirsch-traction` BC); helmholtz-coil needs Rair, Zair >= 30 R (the case's own note) and a half disk; mu_r for air/copper must be explicit overrides (materials lane).
3. **L8: Richardson on unstructured levels.** `after: richardson` targets fail with "richardson unavailable (oscillatory)" when CDT levels are not nested (demo: HT-01 T_E rel -1.5e-6, status fail). Proposal: fall back to the finest level with the spread of the last two levels as the uncertainty and pass/fail on |finest - ref| + spread <= limit, or report pending, but not fail. The L4 gates use nested structured meshes where Richardson is gated (HT) and report finest values where it is not (SM-01 point stresses).
4. **L2: registry.** L4 registrations supersede heat, elastic, magnetostatics, em-modes, emw (settings) and add electrostatics + terminal/ground/potential/zero-charge and an elastic `pressure` use; the `pressure` bc type is shared by acoustics (p = value) and elastic (normal pressure), which overloads one name: proposal to split into `pressure` (acoustics) and `normal-pressure` (elastic). Bounds reviewed: T0 >= 0 K, thickness > 0 added; the seed bounds (DevLog-003 S4) for E, nu, k, cp, rho, emissivity are correct for these modules; eps_r and mu_r unbounded is right.
5. **Heat transient in the spec.** The provisional `time` study has no initial condition; L4 reads `physics.settings.T0`. Time-dependent BC values (HT-02: 100 sin(pi t / 40) C) cannot be written as amp-spec/0 quantities; request a time-expression form (`t` as a reserved symbol) for BC settings.
6. **L3: mesh levels.** prepareRun scales hmax, hmin, refine.h and the grading by hFactor (uniform refinement of the size field); `@amp/mesh` default grading 0.3 is assumed when the spec has none. A `refineUniform` (nested) helper in @amp/mesh would make Richardson reliable on CDT meshes (DevLog-004 open item). The cylinder cavity uses the L4 curved tet10 fixture because the tier-1 cylinder mesher is tet4 (straight).
7. **C5:** in-process Solutions carry the mesh as a non-enumerable `mesh` property (`@amp/post attachMesh`), so `sample(solution, field, points)` works without a mesh argument; across a Worker boundary the mesh must be passed (`{mesh}` option) or the mesh hash looked up in the post store.
8. **C4: readiness and the mesh.** `readiness(spec, physicsId)` cannot see the mesh, so L3's mesh `warnings` cannot become readiness reasons; they are in `prepareRun(...).notes`. Proposal: optional `readiness(spec, physicsId, mesh?)` or a `notes` field on RunContext.

## 6. Hand-off

State 2026-11-06 16:25 PST. Done: `@amp/physics` with seven C4 modules (heat, elastic, electrostatics, magnetostatics, em-modes, emw, acoustics) returning C5 Solutions with run record (engine `@amp/physics@0.0.1+dirty`, spec or problem hash, mesh hash, ISO start, platform, fidelity) and per-stage timing (mesh in the gates; assemble, factor, solve, post in the modules); `@amp/post` (store, derived values, evaluation at points with gradients, sampling, CSV, EO refine port); registrations; prepareRun; gates for H1-H6.

Run:
```
cd packages/physics && node --max-old-space-size=1536 --test --test-concurrency=1 test/*.test.ts   # 33 tests, ~5 s
cd packages/post && node --test test/*.test.ts                                                    # 4 tests
nice -n 10 node --max-old-space-size=1536 gates/heat.ts | gates/elastic.ts | gates/em.ts            # H2, H1, H3 + EM-01/02 (each < 15 s)
nice -n 10 node --max-old-space-size=1536 gates/modes-wo01.ts | gates/modes-wo02.ts               # H4 (WO-02 about 60 s)
nice -n 10 node --max-old-space-size=1536 gates/ac-02.ts | gates/rf-01.ts                         # H6, H5 (RF about 30 s)
node gates/run-all.ts   # all of them in sequence
node gates/prepare-smoke.ts; node gates/harness-demo.ts   # spec path and harness path
../../node_modules/.bin/tsc -p . --noEmit                  # clean (also -p ../post)
```

Open:
- H5: RF-21 TM110 (-2.4e-5, p 1.97) and TE011 (-1.0e-5) miss rel 1e-5 after Richardson on N = 4-6 (pre-asymptotic order); all six modes at 1e-5 need N >= 6 (15 s level). Options: AMS-preconditioned iterative shift-invert (core AMS-GMRES: 14 iterations vs 195), more levels, or a 2D-axisym per-m solver. (Corrected 17:05 PST: the earlier claim that the three hero modes pass in 2.2 s is withdrawn, audit B1; s.7.2.)
- H4: WO-02 Richardson sequence 7 s per thickness (single level 2 s meets abs 3e-6 at s = 0.5); no WO-02 case file (L7b/L7c).
- Harness: cases pending until contract requests 2 and 3.
- 3D elasticity and 3D heat are tested on structured tet/hex fixtures only (no 3D hero gate in wave 1); magnetostatics is axisymmetric only; electrostatics has no space charge.
- Stress recovery is nodal averaging (point stresses oscillate at 1e-4 on CDT levels); a patch recovery would give Richardson-able point stresses.
- Fresh-context audit (coordinator).

## 7. Follow-up 2 (2026-11-06 16:39-17:05 PST; coordinator items 1-7 from I1 and L5, fresh-context audit DevLog/audits/2026-11-06-L4-physics-audit.md)

### 7.1 Dispositions

| Item | Disposition | Where |
|---|---|---|
| I1-1 geometry registrations | done: `physicsRegistry()` = `registerPhysics(registerGeomFeatures(wave1Registry()))`; SM-02 ellipse validates | `src/registrations.ts` |
| I1-2 time study `{start, stop, dt, method, output?}` | done: start/stop/dt/output bound; method bdf1, bdf2, crank-nicolson (linear; radiation needs bdf1/bdf2); generalized-alpha is a readiness reason; output times must lie on the dt grid | `src/heat/index.ts` |
| I1-3 `{expr, unit}` fields (x, y, z, r, t) | done: `common/field.ts compileField` (@amp/core expr, spec resolveField for dimension checks; affine units per spec rules). Heat: T, q, T_ext, T_amb, Q (x, t), h (space only), T0 (space); elastic traction vector and pressure (space); electrostatic potential (space). Time-dependent loads are re-assembled per step | `src/common/field.ts`, heat, elastic, electrostatics |
| I1-4 nested levels | done: prepareRun with hFactor = 2^-k returns the k-times `refineUniform`-refined hFactor = 1 mesh (2D: exact curves via the Geometry2D; cylinder: `meshCylinder(..., {order: 2})` + `cylinderSideProjector`; single box with order 2: tet10 Kuhn box + refineUniform); other hFactors re-mesh (noted). H5 retried: s.7.2 | `src/prepare.ts` |
| I1-5 acoustics order | done: acoustics `settings.order` (1 or 2, default 2) registered; prepareRun builds tet10 P2 boxes (box-acoustics sim: f_1 171.500 Hz, f_2 214.376 Hz at 11,339 DOF) | registrations, prepare |
| L5-5 / S3 Nedelec evaluation | done as an H1 projection: emw Solutions carry `E_nodal` (H1P2 on tet10, 3 components; covariant Piola at every geometry node, averaged; tangential E exact, normal component averaged at interfaces) next to the NED coefficients; post `evaluateField` points to it. em-modes fields are DG0 (post evaluates them). Test: TM010 E_z(r)/E_z(0) vs J0(x01 r / a) within 2e-2 at r = a/4, a/2, 3a/4 on a coarse curved mesh, E_r < 2e-2 E_z(0) | `src/em3d/index.ts nodalFields`; test/followup2 |
| L5-6 injected library | done: `prepareRun({..., library})` (the @amp/materials Library shape); without it Node loads the default library through a non-static import, browsers get a note | `src/prepare.ts` |
| L5-7 normalization | done: `Solution.normalization` (optional, additive) set by the module wrapper: emw M-orthonormal (int eps_r E.E dV = 1 V^2 m), acoustics M-orthonormal (int p^2 / (rho c^2) dV = 1), em-modes max abs E = 1 V/m | `src/index.ts` |
| B1 H5 claim | corrected in s.4.1 and s.6 (17:05 PST). Results on nested curved tet10 in s.7.2 | this file |
| S1 exit codes | done: every gate sets 0 / 1 / 2 (`ExitCode` in gates/common.ts; ac-02, rf-01, modes-*); `run-all.ts` runs under nice and exits with the worst code | gates |
| S2 one Richardson rule | done: all gates call `@amp/eval` `evaluateTarget` (gates/common.ts `evaluate`, `verdictRows`) with a stated theoretical order per target (P2 point values 3, P2 gradients / stresses / B 2, energies and eigenvalues 4, BDF2 transients 2) and the 0.25 band; out-of-band or oscillatory sequences are reported "richardson unavailable" and gated on finest + non-increasing error | gates/common.ts |
| S4 readiness | done: wrapper readiness adds `specReadiness`: N/A override values, needed properties absent without a materials/ ref, N/A BC settings, missing T0 for a time study, missing nModes. prepareRun writes eval-case fills into the returned spec, so readiness on `ctx.spec` passes and `run` re-checks it | `src/common/ctx.ts`, `src/index.ts` |
| S5 timing | done: prepareRun records validate, geometry_mesh, materials (ms); the wrapper merges them into `Solution.timing`. End-to-end prepare + run per sim (Node, s.7.3) | prepare, index |
| S6 acoustic density | done: K = int (1/rho) grad p . grad q, M = int p q / (rho c^2); several fluids need rho everywhere (error otherwise); one fluid without rho uses 1 (cancels). Test: two fluids in series vs the interface relation (k1/rho1) sin(k1 L1) cos(k2 L2) + (k2/rho2) sin(k2 L2) cos(k1 L1) = 0, first two modes within 2e-4, and the spectrum without the density contrast differs by > 1e-2 | `src/acoustics/index.ts`; test/followup2 |
| S7 mesh warnings | done: `Solution.notes` (optional, additive) = prepareRun notes + mesh warnings, set by the wrapper; readers: L8 / L5 (contract request 9) | `src/index.ts` |
| M1 | fixed: with terminals and potentials both present, an extra solve gives `V_applied` | electrostatics |
| M2 | fixed: no tan_delta -> no Q_d (no hidden 0); tan_delta on some domains only -> error | em3d binding |
| M3 | Q_d reported as INFO in rf-01 (homogeneous fill: tautological) | gates/rf-01.ts |
| M4 | fixed: axis nodes within 1e-12 of the bounding-box size; nodal B uses the same tolerance (an O(n^2) slip in the first version of this fix stalled the EM gate for minutes; caught and fixed before any result) | magnetostatics |
| M5 | `evaluateField(..., {snap})` / `sample(..., {snap})`: points just outside curved cells (reference tolerance, e.g. 1e-3) are accepted | post |
| M6 | fixed: EM-02, EM-03 (eval/cases/c), WO-02 and WO-41 (eval/cases/b) inputs and references are read from the case and expected files; no reference literal left in gates/em.ts and gates/modes-wo02.ts (the Palace RF table in rf-01 stays as an informative delta) | gates |
| M7 | acknowledged; levels are now nested and fixed per gate | - |
| M8 | fixed: ac-02 and rf-01 logs use the UTC stamp `...Z` | gates |
| M9 | fixed: `@amp/physics` no longer depends on `@amp/post` (local `attachMesh` in common/solution.ts; post reads `solution.mesh`); post -> physics/common only | package.json |
| M10 | fixed (s.1.1) | this file |
| M11 | ungated targets print INFO; RF rows state their levels (s.7.2) | gates |
| M12 | fixed (nice in run-all) | gates/run-all.ts |

### 7.2 Gate results under the shared rule (Node; logs `logs/l4-heat-20261107T005216Z.jsonl`, `l4-elastic-20261107T005243Z.jsonl`, `l4-em-20261107T010123Z.jsonl`, `l4-ac02-20261107T010158Z.jsonl`, `l4-rf01-20261107T010240Z.jsonl` (nested), `l4-rf01-20261107T010254Z.jsonl` (rings), `l4-modes-wo01-20261107T010402Z.jsonl`, `l4-modes-wo02-20261107T010407Z.jsonl`)

| Case | Levels | Basis | Result | Wall of the verdict levels |
|---|---|---|---|---|
| HT-01..04 | as before (structured, ratio 2) | richardson (p 2.05-2.69 within the band of 3 / 2); HT-03 finest | 7/7 pass (unchanged numbers) | 1-54 ms |
| SM-01 (nested CDT) | 1,604-99,296 DOF | richardson: K_t p 2.01 (value 3.0000012, rel 4.1e-7), syy p 1.92 (4.5e-5), u_x p 3.36 (-1.9e-9), u_y p 3.44 (-5.5e-9); stress L2 rates 1.90 / 1.94 / 1.97 | 5/5 pass | 1.58 s |
| SM-02 (nested) | 1,888-115,008 | richardson p 1.96: 92.6591 MPa (-4.4e-4 vs 92.7) | pass | 1.53 s |
| EM-04 (nested) | 11,343-183,033 | B_center, Bz_probe: p_obs 3.95 / 3.74 outside the band of 2 (superconvergent nodal averages on nested meshes) -> finest + monotone: -3.1e-6, -3.2e-6; Br_probe finest abs 4.3e-12 T; uniformity INFO (case gate false); truncation 30 R vs 100 R -5.036e-5 vs image -5.036e-5 | pass | 1.91 s |
| EM-03 (nested, c) | 16,050-258,189 | richardson p 3.88-3.96: M_ab vs filament 6.2e-4 (tol 5e-3), L_aa 5.1e-4 (3e-2), L_bb 4.0e-6 (3e-2); M_ab vs Palace formula INFO 4.4e-3 | pass | 2.79 s |
| EM-01 (nested) | 548-39,104 | richardson p 3.95: C', L', Z0 rel 1.3e-9 (was 6.9e-6 on non-nested levels) | pass | 0.41 s |
| EM-02 (nested, c; case tol 1e-4) | 7,409-117,650 | richardson p 3.93-3.94: 4.0e-6 / 1.4e-5 / -2.6e-5 | pass | 0.89 s |
| WO-01 | as before | richardson p 3.76 / 4.19: 4.8e-10 / 1.3e-9 | pass | < 0.2 s |
| WO-02 rib (b; case tol abs 5e-6) | 3 scales | 4 of 8 richardson (p 3.64-4.41), 4 of 8 finest + monotone (p 2.25-2.62); max abs err 7.2e-7 | 8/8 pass | 7-7.6 s per thickness (3-level verdict); single level s = 0.5 about 2 s |
| WO-41 metal box (b; case tol abs 1e-7) | N = 8..64 | p_obs 0.66-1.82 (dielectric corner) -> finest + monotone: 1.65e-7, 8.1e-8, 2.5e-7, 1.9e-6 | 1/4 pass, 3 FAIL | 2.4-3.2 s |
| AC-02 (tet10, s = 1, 2, 3) | 693-14,725 | richardson p 3.66-3.87 (band of 4): worst -7.2e-6 | 10/10 pass | 1.75 s |
| RF-21 nested curved tet10 (meshCylinder order 2 + refineUniform, base hmax a/1.5) | 3,662 / 32,804 DOF (the next nested level is about 2.9e5 DOF, over the 1.5 GB heap cap) | 2 levels: the rule reports "too few levels" and gates the finest: TM010 -1.7e-5, TE111 4.8e-5, TM011 -1.3e-5, TM110 -1.0e-4, TE211 5.9e-5, TE011 2.2e-4. Error ratio between the two levels 16.5 for TM010 (p = 4.05 against the exact value, informative) | 0/6 pass | 5.3 s |
| RF-21 ring disk N = 4, 5, 6 (non-nested, self-similar) | 13,192-46,068 | richardson within band for TM010 (p 4.77, 3.0e-7) and TM011 (4.25, -1.6e-7) -> pass; TE111, TE211, TE011: extrapolation within 1e-5 but the finest level outside the budget (rule: both required) -> FAIL; TM110 p 1.97 out of band -> finest 1.7e-5 FAIL | 2/6 pass | 20.0 s |

H5 statement (replaces the earlier one): with the shared rule no H5 level sequence meets rel 1e-5 for all six modes; TM010 and TM011 pass on N = 4-6 in 20 s (Node, finest level 13.4 s). The < 5 s target is not met for H5. Options unchanged (AMS-preconditioned iterative shift-invert to reach a third nested level; 2D-axisym per-m solver).

### 7.3 End-to-end prepareRun + run per hero sim (Node, `gates/prepare-smoke.ts`, case values for N/A inputs; stages in ms)

| Sim | DOF | End to end | validate / geometry_mesh / assemble / factor / solve / post |
|---|---|---|---|
| heat-plate-fin | 15,339 | 216 ms | 15 / 49 / 22 / 72 / 5 / 1 |
| kirsch-plate | 10,810 | 176 ms | 4 / 20 / 25 / 67 / 2 / 48 |
| helmholtz-coil | 14,645 | 162 ms | 3 / 39 / 28 / 72 / 4 / 9 |
| box-acoustics (tet10 P2) | 11,339 | 926 ms | 2 / 8 / 216 / 315 / 381 / 1 |
| cylinder-cavity (ND2 curved) | 14,882 | 2,585 ms | 3 / 204 / 113 / 612 / 1,540 / 111 |
| si-rib-waveguide | 328,754 | 3,851 ms | 5 / 109 / model 767 / 167 / 1,200 / 1,490 / 106 |

These are the sims' own mesh sizes, not the gate accuracies; browser times are not measured (L5).

### 7.4 Tests and checks

physics 39/39 (new: test/followup2.test.ts 6: compileField, field Dirichlet in time with crank-nicolson, readiness reasons, prepareRun nested levels + timing merge + field BC, two-fluid acoustics, TM010 nodal E), post 4/4; `tsc -p packages/physics` and `-p packages/post` clean.

### 7.5 Contract requests (new)

9. **C5 (coordinator), additive optional fields**: `Solution.notes?: string[]` (prepareRun notes, mesh warnings) and `Solution.normalization?: string` (eigenvector scaling). Readers: L8 stores notes per level; L5 shows them in Messages (audit S7).
10. **L8**: call `readiness(ctx.spec, ctx.physicsId)` after `prepareRun` (prepareRun fills N/A inputs from the case into `ctx.spec`); readiness on the raw sims/ spec reports their N/A values (audit S4).
11. **L7a/L7c**: set `convergence.h_factors: [1, 0.5, 0.25]` (or [1, 0.5, 0.25, 0.125]) so the harness levels are nested (prepareRun nests only for powers of 1/2), and `convergence.expected_order` per target (values used by the L4 gates: s.7.1 S2).
12. **C1**: `@amp/physics` no longer depends on `@amp/post`; `@amp/post` depends on `@amp/physics` (common/mesh, common/lagrange) and `@amp/spec`.

### 7.6 Note for I1 (2026-11-06 17:05 PST)

- `prepareRun` nested levels are wired: pass `hFactor` = 1, 0.5, 0.25 (powers of 1/2) and the meshes are nested refinements (2D CDT with exact curves; cylinder via `meshCylinder(c, {order: 2})` + projector; single box with acoustics/emw order 2 -> tet10). Any other hFactor re-meshes (notes say so). Ask L7a/L7c for `h_factors: [1, 0.5, 0.25]` (request 11).
- SM-02: `physicsRegistry()` now includes the geometry features (ellipse). L4's own nested SM-02 gate: 92.6591 MPa, p 1.96, pass.
- RF-21: nested curved tet10 is available, but the third nested level (about 2.9e5 ND2 DOF) does not fit the heap cap; under the shared rule the best result is TM010 / TM011 pass (rings N = 4-6, 20 s). H5 is not < 5 s at 1e-5.
- AC-02: box-acoustics now meshes as tet10 P2 by default (`physics.settings.order`, 1 or 2); the sim at its own hmax gives f_1 171.500, f_2 214.376 Hz in 0.93 s end to end.
- Time study: `{start, stop, dt, method, output?}` bound (bdf1, bdf2, crank-nicolson). `{expr, unit}` fields work for heat T, q, h (space), T_ext, T_amb, Q, T0, elastic traction / pressure, electrostatic V.
- Solutions now carry `notes` and `normalization`; readiness reports N/A inputs (call it on `ctx.spec` after prepareRun).
