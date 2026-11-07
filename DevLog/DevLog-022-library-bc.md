# DevLog-022: example library, class-b and class-c sims (lane W4)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | W4 (class-b and class-c example sims) |
| Owns | new class-b/c files in `sims/`, `apps/web/src/lib/library/catalog-bc.ts`, this file |
| Does not touch | existing `sims/*.yaml`, `eval/cases/**`, `eval/expected/**`, `packages/*`, other web files (W1/W2: gfx, workbench; W3: class a, picker, `catalog.ts`) |
| Inputs | user feedback via coordinator (2026-11-06): "the example libraries should include more sims, e.g. as many of the eval examples as possible, and classify them by category"; `eval/cases/{b,c}`; `eval/expected`; engine physics `packages/physics/src/registrations.ts` |
| Verification | each sim: `@amp/spec` parse + validate with `physicsRegistry()`, `prepareRun` + module run in Node (scratch runner, not tracked), compare with the case reference / `eval/expected`; logs in `logs/w4-library-bc-<stamp>.jsonl` |

## 1. Plan (written 2026-11-06 20:54 PST, before writing sims)

### 1.1 Engine capability (read 2026-11-06 20:50-20:54 PST)
- Physics types: `heat` (2D, 2D-axisym, 3D; temperature, heat-flux, convection, surface-radiation, insulation, heat-source; stationary or bdf1/bdf2/CN), `elastic` (2D/3D static; fixed, roller, free, boundary-load, pressure; no eigen, thermal strain not bound from the spec), `electrostatics` (2D, 2D-axisym; scalar eps_r; terminal, ground, potential, zero-charge; 2D single terminal also gives C_per_m, L_per_m, Z0 from a vacuum solve), `magnetostatics` (2D-axisym A_phi only; coil-current, magnetic-insulation), `em-modes` (2D; scalar n / eps_r per domain; pec, pmc natural), `emw` (3D eigen, PEC), `emw-axisym` (eigen per m, PEC), `acoustics` (eigen only; sound-hard, p = 0).
- Missing everywhere: driven frequency response, impedance / absorbing / PML / port BCs, Bloch periodic BCs, tensor material properties from the spec, elastic eigen, Navier-Stokes, transport, reaction terms, semiconductor, eddy currents, dataset-driven coefficient fields.

### 1.2 Triage (to be confirmed per case while writing)
| Case | Class | Physics | Plan |
|---|---|---|---|
| WO-41 | b | em-modes | sims per variant A-D (pec + natural pmc), n_eff vs femwell re-tabulation of Hadley 2002 |
| WO-02 | b | em-modes | existing `sims/si-rib-waveguide.yaml`; sweep t_slab in the runner (no new file), record |
| WO-65 | c | em-modes | new sim, Si strip TE0 n_eff, window PEC +-2 um |
| CP-03 | c | heat 2D-axisym | new sim, heated wire, T_center, T_surface (q_per_ft derived) |
| HT-61 | c | heat 2D | new sim, Poisson on the unit square as heat with k 1, Q 1, T 0 |
| RF-62 | c | electrostatics 2D | new sim, zero-thickness CPW on eps_r 11.7 half-space (truncated; truncation study) |
| RF-03 | c | electrostatics 2D | new sims: isotropic eps 9.3 variant; uniaxial via the exact planar map stated in the case's assumptions |
| EM-61 | c | electrostatics 2D (TEM duality) | new sim for L_geom only; L_kin / L_total need a London-film model (gap) |
| EM-02, EM-03, RF-01 | c | existing sims | run through the harness, record, catalog if W3 does not |
| others | b, c | - | not runnable: list the missing capability |

### 1.3 Steps
1. Scratch runner (session scratchpad, not tracked): parse + validate the sim with `physicsRegistry()`, `prepareRun` at hFactor 1 / 0.5 / 0.25 where cheap, module run, extract scalars or probes, compare with the reference; JSONL to `logs/`.
2. Write each sim with a header comment (eval case, source, rights), params / BCs / materials from the case, `provenance.values`, `# eval: [ID]` as the last line (DevLog-014 convention).
3. Run one sim at a time, `nice -n 10`, `--max-old-space-size=1536`.
4. Catalog: read `catalog.ts` (W3) for the entry type; write `catalog-bc.ts`. Until it exists, keep a JSON draft in s.4 here.
5. Report: case -> sim -> result table, counts by category, engine gaps ranked by cases unlocked.

## 2. Progress
- 2026-11-06 20:54 PST: plan written.
- 2026-11-06 20:55 PST: scratch runner `<scratch>/run-sim.ts` (not tracked): parse with `@amp/spec` `parseYaml` + `validateSpec(physicsRegistry())`, `prepareRun({spec, case, hFactor})` per level, `registry[type].run`, targets as expressions over the Solution scalars, Richardson from the last three levels (monotone only), JSONL to `logs/w4-library-bc-20261106T205541.jsonl` (all runs below; times in the log are UTC; line numbers below are 1-based). Superseded lines: 2, 5, 9, 15-19.
- 2026-11-06 20:55 PST: HT-61 `poisson-square`, CP-03 `heated-wire`: pass. CP-03 q per ft first computed from the inputs (log line 2, superseded); now from the sim's surface temperature (energy balance, line 3). This restates T_surface, so CP-03 has 2 independent checks, not 3.
- 2026-11-06 20:56 PST: WO-41 `hadley-square-core` (A, B via `--set eps_core=8`), `hadley-square-hole` (C, D via `eps_clad=8`): material `eps_r` takes a param expression. B on 3 levels fails (line 5, superseded); on 4 levels (line 8) the finest is within tolerance (abs 8.2e-8 < 1e-7), but the last two level changes are -1.13e-7 and -1.23e-7 (not asymptotic): within tolerance at the finest level, not converged.
- 2026-11-06 20:57-20:59 PST: WO-65 `si-strip-te0`: first mesh (core refine only) converges at a constant 2.05e-5 per level (log line 9, superseded); core-edge refinement t/16 added: n_eff pass. `ng_0` 4.0556 vs case 4.19617: the engine's own wavelength finite difference (constant n, 1.545 / 1.555 um) gives 4.0555, so the engine is self-consistent; the atlas K1.yaml header says its ng uses Sellmeier dispersion in every material, which the case's material block (constant n) does not carry. Not comparable; recorded as such.
- 2026-11-06 21:00 PST: RF-62 `cpw-halfspace`: zero-thickness strip and grounds as bottoms of five air columns (adjacent rects keep separate edges). Truncation and mesh study below. Pass after Richardson.
- 2026-11-06 21:01 PST: RF-03 `cpw-sapphire`: one file for both variants (uniaxial default; `eps_par = 9.3` gives the isotropic variant) through params `h_eq`, `eps_eq`. Pass; truncation R 2.5 / 5 / 10 mm.
- 2026-11-06 21:02 PST: EM-61 `micro-coax-lgeom`: L_geom pass; L_kin / L_total not runnable.
- 2026-11-06 21:03-21:04 PST: WO-02 on the hero `si-rib-waveguide` with the case window (`--set W_win=18;D_sub=10`): log lines 15-19 compare against shifted references (a zsh 1-based array slip in my loop; superseded by lines 20-26). Third nested level: `RangeError: Maximum call stack size exceeded` at `packages/physics/src/modes/vector-mode.mjs:105` (`Math.max(...mesh.triRegion)` over a large typed array). New eval model `hadley-rib-wo02` (case window) rerun at all 7 thicknesses (lines 30-36).
- 2026-11-06 21:04 PST: harness on the existing class-c sims: EM-02 pass (3/3), EM-03 pass (3/3 + 1 info), RF-01 pending (frequencies info, Q_c / Q_copper pending) (`logs/eval-20261106T210425.jsonl`, `-210427`, `-210435`). W3 catalogs these files.
- 2026-11-06 21:05-21:08 PST: WO-04 scan of all four mirror classes at Gamma, X, M (scratch specs), then `phc-square-rods-lower` / `-upper`; WO-63 `phc-point-defect` (separate cut rects per rod: a tool feature is consumed by its first `difference`).
- 2026-11-06 21:09 PST: catalog type found in W3's `catalog.ts`; `catalog-bc.ts` filled (12 entries); `tsc --noEmit --strict` on catalog.ts + catalog-bc.ts clean; every id has a sims file, no duplicates.
- 2026-11-06 21:11 PST: results, gaps, open items written (s.3-6).

## 3. Results

Levels: nested uniform refinement, hFactor 1 / 0.5 / 0.25 unless noted. "rich" = Richardson value from the last three levels (observed order p). Tolerances from the case.

### 3.1 New sims (12 files, 10 cases)
| Case | Class | Sim | Target | Finest | Richardson (p) | Reference | Rel. error (used) | Tol | Result | Finest DOF |
|---|---|---|---|---|---|---|---|---|---|---|
| HT-61 | c | `poisson-square` | u_max | 0.0736713524 | 0.0736713533 (4.4) | 0.0736713533 | -4.4e-10 | 1e-5 rel | pass | 9,893 |
| CP-03 | c | `heated-wire` | T_center | 488.67194532 K | same (5.2) | 488.67194532 | -2.6e-13 | 1e-4 rel | pass | 88,305 |
| CP-03 | c | `heated-wire` | T_surface | 487.51059028 K | - | 487.51059028 | -1.2e-12 | 1e-4 rel | pass | 88,305 |
| CP-03 | c | `heated-wire` | q_per_ft (energy balance; restates T_surface) | 100.083776 W | - | 100.083776 | -3.0e-12 | 1e-4 rel | pass | 88,305 |
| WO-41 A | b | `hadley-square-core` | n_eff | 1.276274553 | 1.276274038 (1.8) | 1.27627404 | -1.9e-9 | 1e-7 abs | pass | 57,567 |
| WO-41 B | b | `hadley-square-core` eps_core 8 | n_eff | 2.656797002 (4 levels) | - (non-monotone) | 2.65679692 | 3.1e-8 (finest; abs 8.2e-8) | 1e-7 abs | within tol at the finest level, not converged (last changes -1.1e-7, -1.2e-7) | 230,271 |
| WO-41 C | b | `hadley-square-hole` | n_eff | 1.387927284 | 1.387926427 (1.8) | 1.387926425 | 1.1e-9 | 1e-7 abs | pass | 57,552 |
| WO-41 D | b | `hadley-square-hole` eps_clad 8 | n_eff | 2.761470522 | 2.761465293 (1.5) | 2.761465320 | -9.8e-9 | 1e-7 abs | pass | 57,552 |
| WO-02 | b | `hadley-rib-wo02` t 0.1 / 0.2 (1 level) | n_eff | 3.412125861 / 3.412278985 | - | 3.412126 / 3.412279 | -4.1e-8 / -4.5e-9 | 5e-6 abs | within tol at the finest level, not converged (case: 3 levels, Richardson) | 461,530 / 198,369 |
| WO-02 | b | `hadley-rib-wo02` t 0.3 / 0.4 / 0.5 (2 levels) | n_eff | 3.412492309 / 3.412774839 / 3.413132829 | - | 3.412492 / 3.412774 / 3.413132 | 9.1e-8 / 2.5e-7 / 2.4e-7 | 5e-6 abs | within tol at the finest level, not converged (case: 3 levels, Richardson) | 519,913 / 395,497 / 325,425 |
| WO-02 | b | `hadley-rib-wo02` t 0.6 / 0.7 (2 levels) | n_eff | 3.413571838 / 3.414101095 | - | 3.413571 / 3.414100 | 2.5e-7 / 3.2e-7 | 5e-6 abs | within tol at the finest level, not converged (case: 3 levels, Richardson) | 284,849 / 250,665 |
| WO-02 | b | - | n_eff t = 0 | - | - | 3.412022 | - | - | not modelled (needs a slab-free geometry) | - |
| WO-65 | c | `si-strip-te0` | n_eff_TE0 (gate) | 2.447225167 | 2.447222475 (1.0) | 2.44722338 | -3.7e-7 | 2e-6 abs | pass | 506,345 |
| WO-65 | c | `si-strip-te0` | ng_energy (non-gated) | 4.055615 | 4.055619 (1.6) | 4.19616697 | -3.3e-2 | 3e-6 abs | not comparable (case ng includes material dispersion) | 506,345 |
| RF-62 | c | `cpw-halfspace` | C' | 213.7850 pF/m | 213.7290 pF/m (1.06) | 213.7269 pF/m | 9.9e-6 | 1e-4 rel | pass | 496,850 |
| RF-62 | c | `cpw-halfspace` | n_RF | 2.5199143 | 2.5199182 (1.4) | 2.5199206 | -9.6e-7 | 1e-5 rel | pass | 496,850 |
| RF-62 | c | `cpw-halfspace` | Z0 | 39.31768 Ohm | 39.32803 (1.06) | 39.32846 | -1.1e-5 | 1e-4 rel | pass | 496,850 |
| RF-03 | c | `cpw-sapphire` | Z0_anisotropic (gate) | 53.32883 Ohm | 53.34988 (1.05) | 53.35190 | -3.8e-5 | 5e-3 rel | pass | 348,550 |
| RF-03 | c | `cpw-sapphire` eps_par 9.3 | Z0_isotropic_9p3 (non-gated) | 55.95626 | 55.97836 (1.04) | 55.98025 | -3.4e-5 | 5e-3 rel | pass | 349,478 |
| RF-03 | c | `cpw-sapphire` eps_par 9.3 | Z0 printed by Palace docs (non-gated) | 55.95626 | 55.97836 | 56.02 | -7.4e-4 | 1e-3 rel | pass | 349,478 |
| EM-61 | c | `micro-coax-lgeom` | L_geom | 9.6317782 pH | 9.6317827 pH (3.9) | 9.6317824 pH | 2.8e-8 | 1e-4 rel | pass | 9,844 |
| EM-61 | c | - | L_total_london, L_kin | - | - | 30.367 / 20.735 pH | - | 1e-4 rel | not runnable (London films) | - |
| WO-04 | c | `phc-square-rods-lower` | gap_lower | 0.2806617337 | 0.2806617329 (4.0) | 0.2806643917 | -9.5e-6 | 1e-4 rel | pass | 51,412 |
| WO-04 | c | `phc-square-rods-upper` | gap_upper | 0.4171625184 | 0.4171625144 (3.9) | 0.4171623956 | 2.8e-7 | 1e-4 rel | pass | 51,380 |
| WO-63 | c | `phc-point-defect` | defect frequency (non-gated) | 0.3768585648 | 0.3768585595 (4.0) | 0.378166 (MPB res. 16) | -3.5e-3 | 5e-3 rel | pass (info) | 1,009,604 |

Notes:
- Edge / corner singularities set the observed order: CPW strip edges p ~ 1 (C, Z0), dielectric corners p ~ 1-1.8 (WO-41, WO-65). The finest-level RF-62 C is 3e-4 off; the pass needs Richardson, which the case asks for (`after: richardson`).
- WO-04 lower edge: the FEM limit 0.28066173 is 9.5e-6 below the MPB Richardson value and 3.0e-6 below the PWE limit 0.28066257 (both in eval/expected/WO-04.json); within the case tolerance 1e-4, recorded for the WO-04 owner.
- WO-02: no thickness meets the case convergence rule (levels_min 3, after: richardson): t 0.1 / 0.2 ran on 1 level, the rest on 2. At t 0.7 hFactor 1 -> 0.5 changes n_eff by 1.2e-5 (> the 5e-6 tolerance), so the finest-level agreement is not a converged result; the third level is blocked by the stack overflow (s.5 B1). Catalog status: pending.

### 3.2 Truncation and mesh studies
- RF-62, hFactor 1, hmax R/8 (first draft): C' at R 1.5 / 3 / 6 / 12 mm scattered by 2e-4 relative (mesh changes with R dominate). Fixed far mesh (hmax 0.375 mm) and strip refinement W/40: Richardson C' 213.7290 (R 3 mm) vs 213.7310 pF/m (R 12 mm), 9e-6 relative; R 3 mm kept.
- RF-03 Richardson Z0 (uniaxial): R 2.5 / 5 / 10 mm -> 53.35129 / 53.34988 / 53.34954 Ohm (spread 3.4e-5 relative, tolerance 5e-3); R 5 mm kept.
- WO-65 mesh: core refine t/4 only: 2.4472768 / 2.4472563 / 2.4472358 (constant 2.05e-5 steps, 210k DOF finest, fails); hmax W/40 + core t/10: 2.4472488 / 2.4472336; core-edge refine t/16 (kept): 2.4472335 / 2.4472279 / 2.4472252, p 1.0. The atlas reference reaches 2.4472220-2.4472232 at 33-44k DOF (K1-fem.json levels), so the engine mesh / formulation converges slower here (s.6 O3).

### 3.3 WO-04 symmetry-class scan (quarter cell, hFactor 1, lowest three eigenfrequencies in c/a)
| k point | class (x, y) | f_0 | f_1 | f_2 |
|---|---|---|---|---|
| Gamma | even, even | 0 | 0.54596 | 0.81114 |
| Gamma | even, odd | 0.55128 | 1.08328 | 1.16133 |
| Gamma | odd, even | 0.55127 | 1.08328 | 1.16126 |
| Gamma | odd, odd | 0.85184 | 1.44190 | 1.44853 |
| X | even, even | 0.24164 | 0.74203 | 0.86105 |
| X | even, odd | 0.55678 | 1.15153 | 1.18330 |
| X | odd, even | 0.41716 | 0.71238 | 1.10844 |
| X | odd, odd | 0.83873 | 1.17228 | 1.44168 |
| M | even, even | 0.28066 | 0.85746 | 0.87985 |
| M | even, odd | 0.49587 | 0.87821 | 1.14983 |
| M | odd, even | 0.49587 | 0.87820 | 1.14983 |
| M | odd, odd | 0.68270 | 0.90011 | 1.43491 |

Band 1 (lowest over all classes): Gamma 0, X 0.24164, M 0.28066 -> maximum at M (even, even). Band 2: Gamma 0.54596, X 0.41716 (odd, even), M 0.49587 -> minimum at X. Band extrema between the symmetry points are not sampled; the agreement with the path-sampled reference (MPB / PWE) to <= 1e-5 supports that the extrema sit at M and X.

### 3.4 Existing sims paired with class-b/c cases (catalogued by W3 in `catalog.ts`)
| Case | Sim | Run | Result |
|---|---|---|---|
| EM-02 | `two-spheres` | harness, `logs/eval-20261106T210425.jsonl` | pass 3/3 |
| EM-03 | `coplanar-rings` | harness, `logs/eval-20261106T210427.jsonl` | pass 3/3 (+1 info) |
| RF-01 | `cylinder-cavity-axisym` | harness, `logs/eval-20261106T210435.jsonl` | pending: f_TM010 / f_TE111 / f_TE011 / Q_d info, Q_c_TE011 / Q_TE011_copper pending (no conductor-loss Q) |
| WO-02 | `si-rib-waveguide` (hero) | engine, case window via params | same values as `hadley-rib-wo02` (log lines 20-26); the hero's own window (10 / 3 / 3 um) was not run against WO-02 |

### 3.5 Not runnable (missing capability per case)
| Case | Class | Category | Missing |
|---|---|---|---|
| AC-01 | b | acoustics | driven frequency response; normal-velocity and impedance (matched) BCs |
| CP-01 | b | coupled | Boussinesq heat + incompressible Navier-Stokes |
| CP-07, CP-41 | b | coupled | ALE fluid-structure interaction, Navier-Stokes, St. Venant-Kirchhoff solid |
| CP-08 | b | coupled | untestable (case); 3D elastic eigen + 3D vector optical eigen + optomechanical overlap |
| CP-42 | b | coupled | untestable (case); 3D elastic eigen |
| CP-43 | b | coupled | tensor (x-cut LN) permittivity in electrostatics and em-modes from the spec, EO overlap chain (VpiL); LN values not stated by the paper (case) |
| CP-44 | b | coupled | as CP-43 + RF conductor / dielectric line loss |
| FL-02, FL-03, FL-04, FL-41, FL-43, FL-44 | b | fluids | incompressible Navier-Stokes (FL-04 St is gated in the real-time LBM tier, DevLog-005; not an amp-spec sim) |
| FL-42 | b | fluids | untestable (case); Navier-Stokes |
| RF-41 | b | rf | lossy line (conductor + dielectric loss vs f and T); measured data |
| SM-41 | b | structural | geometrically nonlinear elasticity (St. Venant-Kirchhoff) |
| SM-42 | b | structural | thermal-strain coupling bound from the spec (solver has it, `elasticProblemFromContext` does not pass it), 3D layered stack; stress-free temperature N/A in the case |
| AC-61 | c | acoustics | untestable (case); driven Helmholtz with an open boundary |
| AC-62 | c | acoustics | transient acoustics, variable coefficients from a dataset |
| CP-04 | c | coupled | untestable (case); Joule heating + thermoelasticity |
| CP-06 | c | coupled | untestable (case); piezoelectric eigen |
| EM-05 | c | em-static | time-harmonic eddy currents (A-V, 2D) |
| EM-61 (L_kin, L_total) | c | em-static | London-film (kinetic inductance) model |
| FL-05, FL-62 | c | fluids | RANS (Spalart-Allmaras) |
| FL-06 | c | fluids | coefficient field a(x) from a dataset (the heat operator -div(k grad u) = Q would solve it); dataset ingestion |
| FL-07 | c | fluids | untestable (case); RANS |
| FL-61 | c | fluids | incompressible Navier-Stokes |
| FL-63 | c | fluids | Boussinesq Navier-Stokes |
| FL-64 | c | fluids | Navier-Stokes + passive transport |
| RF-01 (Q targets) | c | rf | surface-impedance (conductor-loss) Q in emw / emw-axisym |
| RF-61 | c | rf | driven frequency-domain EM with a lumped port (S11) |
| SC-02 | c | coupled | semiconductor drift-diffusion |
| SM-61 | c | structural | elastic eigen (modal) study; the reference is Timoshenko beam theory (beam elements or a comparability check of a 2D continuum) |
| TR-02, TR-62 | c | fluids | transient advection / Burgers |
| TR-03 | c | fluids | reaction-diffusion (FEM); the pattern-class gate exists in the real-time Gray-Scott tier (DevLog-005), not an amp-spec sim |
| TR-61 | c | fluids | linear reaction term (-lap u + u = f) and error-norm extraction against the exact field |
| TR-63 | c | fluids | untestable (case); reaction-diffusion |
| WO-05 | c | optics | open boundary (PML / absorbing) for resonance f and Q (the real-time FDTD tier has CPML; not a sim) |
| WO-61 | c | optics | Bloch-periodic BCs (the K point is not reachable by mirror-class reduction) |
| WO-62 | c | optics | Bloch-periodic BCs, TE + TM complete gap |
| WO-64 | c | optics | open boundary (PML) for the holey-cavity Q |
| WO-66 | c | optics | untestable (case); 3D FDTD |

### 3.6 Counts by category (56 cases: b 20, c 36)
| Category | Cases | With a sim (new) | With a sim (existing) | Partial | Not runnable |
|---|---|---|---|---|---|
| Heat transfer | 2 (HT-61, CP-03) | 2 | 0 | 0 | 0 |
| Structural mechanics | 3 (SM-41, SM-42, SM-61) | 0 | 0 | 0 | 3 |
| Electrostatics / magnetostatics | 4 (EM-02, EM-03, EM-05, EM-61) | 1 (EM-61, L_geom only) | 2 | 1 | 1 |
| RF / microwave | 5 (RF-01, RF-03, RF-41, RF-61, RF-62) | 2 | 1 (RF-01, frequencies only) | 1 | 2 |
| Wave optics / photonics | 10 (WO-02, -04, -05, -41, -61, -62, -63, -64, -65, -66) | 5 (WO-02, -04, -41, -63, -65) | 0 | 3 (WO-02 gated t = 0 point and convergence; WO-63, WO-65 non-gated targets) | 5 |
| Acoustics | 3 (AC-01, AC-61, AC-62) | 0 | 0 | 0 | 3 |
| Fluids / real-time (FL, TR) | 19 | 0 | 0 | 0 | 19 (FL-04, TR-03 covered by real-time kernels, not sims) |
| Coupled (CP, SC) | 10 | 0 | 0 | 0 | 10 |
| Total | 56 | 10 cases / 12 files | 3 | 5 (of the 13 with a sim) | 43 |

## 4. Catalog
`apps/web/src/lib/library/catalog-bc.ts` (filled 2026-11-06 21:09 PST, type `CatalogEntry` from W3's `catalog.ts`): 12 entries, heat 2, em-static 1, rf 2, optics 7. `ref.via: engine`, `ref.log: logs/w4-library-bc-20261106T205541.jsonl`; no physical values in the file. The existing class-c-paired sims (two-spheres, coplanar-rings, cylinder-cavity-axisym, si-rib-waveguide) stay in W3's `CATALOG_A` (first id wins).

## 5. Engine gaps (ranked by cases unlocked, untestable cases excluded from the count)
| # | Capability | Unlocks | Count |
|---|---|---|---|
| G1 | Incompressible Navier-Stokes (laminar, steady + transient) | FL-02, FL-03, FL-04, FL-41, FL-43, FL-44, FL-61; with heat: CP-01, FL-63; with transport: FL-64 | 7 (10 with Boussinesq / transport) |
| G2 | Transient scalar transport / reaction-diffusion (advection, Burgers, Gray-Scott) and a linear reaction term in the stationary scalar operator | TR-02, TR-03, TR-62; TR-61 (reaction term only) | 4 |
| G3 | Driven frequency-domain solves with impedance / absorbing (PML) / port BCs (acoustics and EM) | AC-01, WO-05, WO-64, RF-61 | 4 |
| G4 | Bloch-periodic BCs (Floquet phase on paired boundaries) | WO-61, WO-62 (WO-04 directly, without the mirror-class analog) | 2 |
| G5 | Tensor (anisotropic) permittivity: electrostatics solver is scalar per cell (solver gap); em-modes `solveModes` takes [xx, xy, yy, zz] tensors but `problemFromContext` passes scalars (spec-binding gap); + EO overlap chain | CP-43, CP-44 (RF-03 directly, without the planar map) | 2 |
| G6 | RANS turbulence (Spalart-Allmaras) | FL-05, FL-62 | 2 |
| G7 | Conductor / dielectric loss: surface-impedance Q (emw, emw-axisym) and lossy quasi-TEM lines | RF-01 (2 Q targets), RF-41, CP-44 (RF loss target) | 1 case + 2 partial |
| G8 | Fluid-structure interaction (ALE) + St. Venant-Kirchhoff | CP-07, CP-41; SVK alone: SM-41 | 3 |
| G9 | Elastic eigen (modal) study | SM-61 (CP-08, CP-42 untestable) | 1 |
| G10 | Thermal-strain coupling bound from the spec (solver supports `thermal`) | SM-42 (stress-free temperature still N/A in the case) | 1 |
| G11 | Eddy currents (time-harmonic A-V) | EM-05 | 1 |
| G12 | London / superconducting films | EM-61 (2 targets) | partial |
| G13 | Semiconductor drift-diffusion | SC-02 | 1 |
| G14 | Transient acoustics + dataset ingestion | AC-62 | 1 |
| G15 | Coefficient fields from datasets (per-cell k) | FL-06 | 1 |
| G16 | Material dispersion (epsG) in em-modes: the ported kernel `vector-mode.mjs` takes `epsG`, but `ModesProblem` / `solveModes` and `problemFromContext` do not expose it | WO-65 ng target | 1 target |

Bugs found (not mine to fix; `packages/*` is out of scope):
- B1: `packages/physics/src/modes/vector-mode.mjs:105` `Math.max(...mesh.triRegion)` throws `RangeError: Maximum call stack size exceeded` on large meshes (reproduce: `hadley-rib-wo02` with `t_slab = 0.7` at hFactor 0.25, i.e. two nested refinements of the 250,665-DOF hFactor 0.5 mesh, about 1.0M DOF by the 4x rule; the throw precedes any DOF report; also hit at t 0.1 / 0.2 hFactor 0.5). A loop or `reduce` fixes it.

## 6. Open items
- O1 (eval owners L7b / L7c, not edited here): case `spec:` fields still say pending for the cases that now have sims: WO-41 (`hadley-square-core`, `hadley-square-hole`), WO-02 (`hadley-rib-wo02`), WO-65 (`si-strip-te0`), CP-03 (`heated-wire`), HT-61 (`poisson-square`), RF-62 (`cpw-halfspace`), RF-03 (`cpw-sapphire`), EM-61 (`micro-coax-lgeom`, L_geom only), WO-04 (`phc-square-rods-lower` / `-upper`), WO-63 (`phc-point-defect`). The harness needs extracts per target (scalar names `T_max`, `T_min`, `neff_0`, `C_per_m`, `Z0`, `L_per_m`, `f_0`; derived ones: n_RF = c0 sqrt(L' C'), L_geom = L' l, q = h (T_s - T_inf) 2 pi r0 L) and parametric targets for WO-02 / WO-41 variants. Two cases propose other ids in `spec.ref`: EM-61 `sims/micro-coax-london.yaml` (file: `micro-coax-lgeom`), WO-04 `sims/phc-square-rods.yaml` (files: `phc-square-rods-lower` / `-upper`). WO-63 `study.shift` 0.38 is attributed to tutorial L341-349, where the tutorial sets target_freq = (0.2812 + 0.4174)/2 = 0.3493 (audit 2026-11-06); the result does not depend on it (one even/even mode in the gap).
- O2 (W3): `si-rib-waveguide` catalog entry says WO-02 pending; the WO-02 numbers on the case window are in s.3.1 (eval model `hadley-rib-wo02`).
- O3 (L4): WO-65 n_eff converges at p ~ 1 on the engine mesh vs about 1e-6 at 33k DOF in the atlas reference; check mesh grading at dielectric corners or the tri6 -> straight-triangle path.
- O4 (WO-04 owner): FEM lower edge 9.5e-6 below the MPB Richardson value, 3e-6 below the PWE limit (within tolerance).
- O5: t = 0 point of WO-02 needs a separate geometry (rib directly on the substrate); not written.
- O6: FL-04 and TR-03 are covered by the real-time tier kernels (Play), which the catalog cannot list (entries are keyed by sims files).
- O7: no browser check of the new sims in the workbench (W1-W3 are running dev servers; W3 owns the picker). All 12 files validate with `@amp/spec` + `physicsRegistry()` and run through `prepareRun`, which the web runner also uses.

## 7. Audit (fresh-context subagent, read-only, 2026-11-06 21:12-21:21 PST)
Checks with no findings: numeric inputs vs cases, BC / geometry selections (resolved on built geometry), WO-04 / WO-63 Bloch-class reasoning, RF-03 map, rights / no copied text / no paths, every s.3.1 number vs the log, engine-capability claims. Corrections applied 2026-11-06 21:22 PST:
- JSONL line references were 0-based: renumbered (1-based), line 5 (WO-41 B on 3 levels) added to the superseded list.
- `hadley-rib-wo02`: catalog status pass -> pending; no thickness meets levels_min 3 + Richardson, t 0.7 level change 1.2e-5 > tol. WO-41 B relabelled "within tol at the finest level, not converged".
- `micro-coax-lgeom`: eps_r provenance said Palace uses vacuum; the doc uses Teflon eps_r 2.08 (affects C' only). Now basis user with the duality note; unused `mu_r` removed.
- `phc-point-defect`: shift 0.38 sourced to the case only; the tutorial target is 0.3493 (open item for L7c in O1).
- s.3.6 partial counts (WO-02, WO-63, WO-65), CP-03 q restates T_surface (2 independent checks), TE fraction >= 0.9998, B1 DOF wording, G5 / G16 wording (solver vs binding gaps), Rights lines in poisson-square and phc-* headers.

## 8. WO-02 re-run on 3 levels (after the coordinator's B1 fix, 2026-11-06 21:43-21:47 PST)
B1 fixed by the coordinator (`vector-mode.mjs:105` is now a loop). `hadley-rib-wo02` re-run with hFactor 1 / 0.5 / 0.25 (nested), one process at a time, `nice -n 10`, heap cap 1536 MB; log lines 37-43 of `logs/w4-library-bc-20261106T205541.jsonl`. t 0.1 / 0.2 on the sim file's mesh would reach 7.4M / 3.2M DOF at the third level, so they ran on a scratch variant with a 2x coarser base (hmax W_win/20, guide refine t_slab/2; same model otherwise, not tracked).

| t (um) | Mesh | n_eff hF 1 / 0.5 / 0.25 | Finest DOF | Last-level change | Reference | finest - ref | Result |
|---|---|---|---|---|---|---|---|
| 0.1 | coarse x2 | 3.412125852 / 3.412125860 / 3.412125783 | 2,583,393 | -7.7e-8 | 3.412126 | -2.2e-7 | pass |
| 0.2 | coarse x2 | 3.412276608 / 3.412278906 / 3.412278836 | 1,103,729 | -7.0e-8 | 3.412279 | -1.6e-7 | pass |
| 0.3 | file | 3.412491963 / 3.412492309 / 3.412492121 | 2,081,761 | -1.9e-7 | 3.412492 | 1.2e-7 | pass |
| 0.4 | file | 3.412773122 / 3.412774839 / 3.412774588 | 1,583,953 | -2.5e-7 | 3.412774 | 5.9e-7 | pass |
| 0.5 | file | 3.413127749 / 3.413132829 / 3.413132582 | 1,303,641 | -2.5e-7 | 3.413132 | 5.8e-7 | pass |
| 0.6 | file | 3.413563589 / 3.413571838 / 3.413571651 | 1,141,401 | -1.9e-7 | 3.413571 | 6.5e-7 | pass |
| 0.7 | file | 3.414088891 / 3.414101095 / 3.414101023 | 1,004,601 | -7.2e-8 | 3.414100 | 1.0e-6 | pass |
| 0 | - | - | - | - | 3.412022 | - | not modelled |

- All sequences rise then fall (non-monotone), so the Richardson value is unavailable; the last-level change is <= 2.5e-7, 20x below the 5e-6 tolerance, and every finest value is within 1.0e-6 of the reference (which is given to 6 decimals).
- Cost: finest wall 12.5-37.8 s, peak RSS 2.5-5.5 GB (`/usr/bin/time -l`; typed arrays are outside the JS heap cap).
- Catalog `hadley-rib-wo02`: status stays pending, only because the gated target's t = 0 point is not modelled; the stack-overflow note is removed (audit m6, `DevLog/audits/AUDIT-wave3-2026-11-06.md`). s.3.1 WO-02 rows (1-2 levels) are superseded by this table.
