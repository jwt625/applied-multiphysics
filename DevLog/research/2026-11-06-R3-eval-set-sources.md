# R3: Evaluation-set sources (accuracy and solver speed)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | R3 (research only; no code, no downloads of datasets) |
| Scope | Source catalog, eval-case schema, 48-case starter list, ML-dataset use, speed metric |
| Method | 5 parallel read-only web-research subagents (ML datasets; open-source suites; vendor manuals + NAFEMS; paper benchmarks; speed) + coordinator re-derivation of closed forms (`uv run --no-project --with numpy --with scipy`, script kept in session scratchpad only) + read-only survey of local prior work |
| Access date | 2026-11-06 for every URL below unless noted |
| Status | Draft; fresh-context audit not yet run |

Conventions. Classes: **a** analytic / textbook / canonical benchmark spec; **b** reproducible paper result; **c** other software library or dataset. Value basis: **P** read on a primary or authoritative page; **S** open re-tabulation of a paywalled primary (named); **D** derived by this lane from stated inputs (formula given). "est." = estimate, not a measurement.

## 0. Key findings

1. **COMSOL Application Gallery** is not used as a source in this project (DevLog-001 Q5); its cases are excluded from class c.
2. **abaqus-docs.mit.edu returns HTTP 410 Gone** (2026-11-06). The advanced-packaging-atlas NAFEMS cases cite it. Replace with TNSB values plus a live mirror or Altair/Ansys pages.
3. **Ansys MAPDL Verification Manual (VM1-VM321) is fully public** (ansyshelp.ansys.com/public/...), each VM citing a textbook reference: the richest free pointer set for class-a targets. All rights reserved; cite the original reference, never copy text/inputs.
4. **Best licensed-clean class-c sources**: Palace (Apache-2.0, analytic tables in docs), Code_Aster `astest` (GPL-3.0-or-later, `TEST_RESU` with `REFERENCE="ANALYTIQUE"` in every test file), deal.II, scikit-fem, MPB/Meep (GPL-2.0-or-later), DEVSIM (Apache-2.0), FeenoX (GPL-3.0-or-later), NASA TMR (CC0-1.0, moved to tmbwg.github.io/turbmodels on 2026-02-24).
5. **ML datasets are not bit-reproducible**; the usable mode is "same IC from stored frame 0, integrate, compare VRMSE/nRMSE against own convergence floor". Best fits: PDEBench 1D advection/Burgers/diffusion-sorption, 2D Darcy, 2D FitzHugh-Nagumo; The Well gray_scott, helmholtz_staircase, acoustic_scattering; PDEArena Maxwell-3D.
6. **No browser (WASM/WebGPU) implementation of CEED BP1-BP6 exists** in the sources checked: a browser port with published DOF/s would be new.

## 1. Source catalog

`#` = approx count of usable cases (counted from repo trees / tables on the access date; "~" = estimate).

| Source | Cls | Physics | # usable | Access / license | Format | Reference quantity | URL |
|---|---|---|---|---|---|---|---|
| Closed forms: Timoshenko (Strength of Materials, Elasticity), Roark, Carslaw-Jaeger, Incropera/Holman, Jackson/Pozar/Balanis, Bohren-Huffman, Morse-Ingard, Sze/Hu | a | all | unbounded | books (copyright); formulas are facts | equations | exact scalars, fields | n/a (books); Hu free author PDF chu.berkeley.edu |
| Method of manufactured solutions: Roache 2002 (JFE 124:4), Salari-Knupp 2000 (SAND2000-1444), MASA library | a | all PDEs | unbounded | SAND report free at OSTI; MASA LGPL-2.1 | equations, C++ | exact fields, convergence order | osti.gov/servlets/purl/759450 ; github.com/manufactured-solutions/MASA |
| NAFEMS TNSB (P18), R0015 (FV), R0006, R0123 (CFD vol. 1) | a | solid, modal, heat, thermal stress, CFD | ~40 (LE1-11, T1-4, FV ~30) | paid (P18 GBP 15/45; R0015 17.50/52.50; R0123 22.50/67.50); site terms bar redistribution/republication of downloads; target numbers widely reproduced by vendors | PDF | scalar at named point | nafems.org/publications/resource_center/p18/ ; .../r0015/ ; .../r0123/ ; nafems.org/about-us/legal/downloads/ |
| Ansys MAPDL Verification Manual | c (pointer to a) | heat, solid, modal, buckling, contact, plasticity, EM, piezo, coupled | ~321 VM + NAFEMS part | public, no login; "(c) ANSYS, Inc. All rights reserved"; no reuse grant | HTML | target vs cited textbook value, Ansys value | ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VMTOC.html |
| Altair OptiStruct OS-V verification | c | solid, modal, heat | ~100 (est.) | public; all rights reserved. FV12/FV32/FV52 tables disagree with TNSB-based Abaqus/Ansys: do not use those three | HTML | target + element results | 2022.help.altair.com/2022.1/hwsolvers/os/topics/solvers/os/ |
| Abaqus Benchmarks Manual | c | solid, modal, heat | ~100 (est.) | MIT mirror 410 Gone; vt.edu 403; university mirrors (colorado.edu v2016, uclouvain) live, rights unclear: cite TNSB, not the mirror | HTML | coarse/fine element tables | ceae-server.colorado.edu/v2016/books/bmk/ |
| COMSOL Application Gallery | c | all | 2040 entries | excluded (DevLog-001 Q5) | - | not used | comsol.com/models |
| Compumag TEAM problems (7, 21, 24, ...) | b | magnetostatics, eddy currents | ~30 problems | problem PDFs free; no terms text; measured data in papers (TEAM 7: Fujiwara-Nakata, COMPEL 9:137, 1990, paywalled; Compumag PDF data table is a blank template) | PDF | measured Bz, Jy curves | compumag.org/wp/team/ |
| Palace examples | c | RF, eigenmode, electrostatics, magnetostatics | 15 example dirs; 437 gold CSVs | Apache-2.0 (code and docs) | JSON + Gmsh; CSV gold | analytic tables (f, Q, C, L, Z0) | github.com/awslabs/palace (docs/src/examples) |
| Meep / MPB | c | wave optics, RF | 69 Meep tests; MPB tutorial gaps | GPL-2.0-or-later | Python; unittest asserts | f, Q, band edges | meep.readthedocs.io ; mpb.readthedocs.io |
| openEMS | c | RF | ~36 tutorials | GPL-3.0-or-later | Python/Octave | curves only (no scalar targets) | github.com/thliebig/openEMS |
| Elmer `fem/tests` | c | heat, solid, EM, acoustics, NS, coupled | 1096 dirs | GPL-2.0-or-later code; manuals CC BY-NC | .sif + mesh | mostly solution-norm regression; few literature values | github.com/ElmerCSC/elmerfem |
| DOLFINx demos / dolfinx-tutorial / comet-fenicsx | c | heat, solid, NS, RF, plasticity, contact | 33 demos; tutorial ch. 1-4; ~30 tours | LGPL-3.0-or-later; tutorial CC BY 4.0 (site footer); comet CC BY-SA 4.0 | Python | in-code analytic checks; FEATFLOW curves | github.com/FEniCS/dolfinx ; jsdokken.com/dolfinx-tutorial ; bleyerj.github.io/comet-fenicsx |
| MFEM examples | c | heat, solid, EM, porous, transport | 42 + miniapps | BSD-3-Clause | C++ | printed error vs exact (ex3, ex4, ex5, ex18, ex25, ex31, ex36) | mfem.org/examples |
| deal.II tutorials | c | Poisson, Stokes, NS, elasticity, wave | 91 steps | Apache-2.0 WITH LLVM-exception OR LGPL-2.1-or-later | C++; results tables | convergence tables (step-7); Ghia Re=400 file (step-57) | dealii.org/current/doxygen/deal.II/ |
| NGSolve i-tutorials | c | heat, solid, NS, EM | 72 units | LGPL-2.1 | Jupyter | plots (no numbers in Schafer-Turek unit) | docu.ngsolve.org/latest/i-tutorials/ |
| FeenoX examples/tests | c | heat, solid, modal, thermoelastic | 93 examples, 312 test .fee | GPL-3.0-or-later | .fee + .geo | NAFEMS scalars (LE1 92.7011, LE10 -5.37968, LE11 -105.04) | seamplex.com/feenox/examples ; github.com/seamplex/feenox |
| Code_Aster `astest` | c | heat, solid, modal, buckling, contact, plasticity, coupled | 13,227 files (~3000 tests est.) | test files GPL-3.0-or-later; V-docs GNU FDL (2015 mirror) | .comm + .export + mesh; `TEST_RESU` with `VALE_REFE`, `PRECISION`, `REFERENCE` class | scalar targets in every test | gitlab.com/codeaster/src (astest/) |
| OpenFOAM (Foundation / ESI) | c | laminar, turbulent, heat, multiphase | 260 tutorials; ESI V&V set | GPL-3.0-or-later code; user guide CC BY-NC-ND 3.0; ESI docs CC BY-NC-ND 4.0 | dict cases | curves vs datasets (planarPoiseuille analytic) | github.com/OpenFOAM/OpenFOAM-dev ; doc.openfoam.com/2212/examples/verification-validation/ |
| MOOSE tests | c | all incl. contact, EM | 3130 test specs; 12,222 gold files | LGPL-2.1 | HIT + Exodus/CSV gold | regression gold; analytic in few | github.com/idaholab/moose |
| scikit-fem examples | c | Poisson, elasticity, Stokes, NS, modal | 55 | BSD-3-Clause | Python; test asserts | scalars, some analytic | github.com/kinnala/scikit-fem |
| FEATool examples | c (pointer) | heat, NS, solid | 125 | **proprietary**, no derivative works: cite NAFEMS / DFG instead | MATLAB | `*_ref` scalars | github.com/precise-simulation/featool-multiphysics |
| CalculiX tests | c | solid, heat, contact | N/A | "GPL v2" ("or later" not stated: compatibility with GPL-3.0 unresolved) | .inp | not inspected | dhondt.de |
| SU2 V&V | c | turbulent, MMS NS | 9 | LGPL-2.1 | .cfg | plots | su2code.github.io |
| DEVSIM | c | semiconductor | ~20 examples (est.) | Apache-2.0 | Python; golden .out files | current vs bias | github.com/devsim |
| femwell benchmarks | c (re-tab of b) | wave optics modes | 2 benchmark sets | GPL-3.0 | Python | Hadley 2002 n_eff tables | github.com/HelgeGehring/femwell (docs/benchmarks) |
| miepython tests | c (re-tab of a/b) | Mie | ~10 tests | MIT | Python asserts | Qext, Qsca, g (BHMIE, Wiscombe MIEV0) | github.com/scottprahl/miepython |
| FEATFLOW benchmark pages (TU Dortmund) | b | laminar NS, FSI | DFG 2D-1/2/3, 3D; Turek-Hron CFD/CSM/FSI 1-3 | open web, no terms stated | HTML + .point time series | cD, cL, dp, St, displacements | featflow.de/en/benchmarks/cfdbenchmarking/ |
| Paper benchmarks (Ghia 1982; Botella-Peyret 1998; de Vahl Davis 1983; Erturk 2008; Hadley 2002; Hornikx 2015; Eichenfield 2009; Chan 2012; Moser-Kim-Mansour 1999) | b | NS, natural convection, BFS, modes, acoustics, optomechanics, turbulence | ~15 | mostly paywalled; numbers via open re-tabulations (pysph BSD, INS2D LGPL-3.0, Lethe Apache-2.0, femwell GPL-3.0); arXiv for Eichenfield/Chan; MKM data free | tables | scalars, profiles | see section 7 |
| NASA Turbulence Modeling Resource | c | turbulent RANS | ~30 cases | CC0-1.0 | .dat | Cf, CD, CL with grid convergence | tmbwg.github.io/turbmodels/ |
| JJ "Photonic Crystals" 2nd ed. | a/b | photonic crystals | ~10 band gaps | free PDF posted with permission (Princeton UP copyright) | book | gap edges (figure-level precision) | ab-initio.mit.edu/book |
| The Well (PolymathicAI) | c | acoustics, RD, NS, convection, MHD, astro | 16 families / 26 folders | code BSD-3; data CC-BY-4.0 (paper App. A.6); 4 HF repos lack a license tag; 15 TB | HDF5 fp32 | fields; VRMSE | github.com/PolymathicAI/the_well ; arxiv.org/abs/2412.00568 |
| PDEBench | c | advection, Burgers, RD, Darcy, SWE, NS | 11 subsets | data CC BY 4.0 (DaRUS); code "MIT except where stated" (SPDX NOASSERTION); 3.903 TB | HDF5 | fields; nRMSE, cRMSE, bRMSE, fRMSE | github.com/pdebench/PDEBench ; doi:10.18419/darus-2986 |
| CFDBench | c | laminar NS (cavity, tube, dam, cylinder) | 739 cases | HF apache-2.0; repo no license; paper "available upon request"; generated with ANSYS Fluent | npy 64x64 | fields; MSE, NMSE | huggingface.co/datasets/chen-yingfa/CFDBench ; arxiv.org/abs/2310.05963 |
| AirfRANS | c | turbulent RANS airfoils | 1000 sims | data ODbL-1.0; library MIT; 10.0 GB zip | VTU/VTP; raw OpenFOAM | fields; CD, CL rel. error, Spearman | airfrans.readthedocs.io ; arxiv.org/abs/2212.07564 |
| JHTDB | c | DNS turbulence | ~12 datasets | ODC-By; citation required | web services, HDF5 cutouts | fields, statistics | turbulence.idies.jhu.edu |
| PDEArena | c | NS, SWE, Maxwell-3D | 4 | MIT (code + HF data); seeds published | zarr/HDF5 | fields | pdearena.github.io/pdearena/data/ |
| MKM / Lee-Moser channel DNS | b/c | turbulent channel | 3 + 5 Re_tau | free download, no license stated | text profiles | U+, Reynolds stresses | turbulence.oden.utexas.edu |

Not researched this round (search budget): Siemens Simcenter verification, MSC Nastran (members-only via NAFEMS), Ansys HFSS/Fluent verification (Fluent VM returned 404), nanophotonics ML datasets, BLASTNet license, Gartling 1990 BFS, Vassallo 1997 COST-240 rib tables, Wiscombe NCAR/TN-140 original, Smits 1991 bimorph.

## 2. Proposed eval-case schema (`amp-eval/0`)

Derived from advanced-packaging-atlas `ap-sim-val/0` (keys `schema, id, tier, title, status, physics, inputs, expected, provenance, missing, assumptions, box_compatible, reference_results`, `form: reference_fe`, status ladder unvalidated / verified / validated / measured_regression / untestable) and eo-modulator-atlas `eo-atlas.sim/v1` (`validation_status`, explicit regions, inline materials with source fits). Additions here: `class`, `rights`, `speed`, `hero`, `dataset` block, and per-target `basis` + `locator`. One YAML file per case.

```yaml
schema: amp-eval/0
id: FL-03                          # <physics prefix>-<NN>; stable, never reused
class: b                           # a | b | c (section conventions)
title: Schafer-Turek DFG 2D-1, steady flow past a cylinder, Re = 20
status: unvalidated                # unvalidated | verified | validated | measured_regression | untestable
untestable_reason: null            # required when status = untestable (with locators)
physics: [laminar-ns]              # tags: heat-cond, heat-conv, heat-rad, heat-transient, solid-linear,
                                   # solid-thermal-stress, solid-modal, solid-buckling, solid-contact,
                                   # solid-plasticity, electrostatics, magnetostatics, currents, eddy,
                                   # rf-waveguide, rf-sparams, rf-antenna, rf-resonator, optics-modes,
                                   # optics-scattering, optics-phc, acoustics, stokes, laminar-ns, porous,
                                   # turbulent, transport-diffusion, transport-reaction, semiconductor-dd,
                                   # coupled-<a>-<b> (joule, thermoelastic, piezo, eof, fsi, thermo-optic, optomech)
dimension: 2D                      # 1D | 2D | 2D-axisym | 2D-periodic | 3D
units: SI                          # all values SI unless a target states otherwise
geometry:
  kind: analytic                   # analytic | layer_stack | step_ref | dataset_grid
  spec: {channel_m: [2.2, 0.41], cylinder: {center_m: [0.2, 0.2], radius_m: 0.05}}
  symmetry: none
materials:                         # inline or materials-package keys; every value with source or 'synthetic'
  fluid: {rho: 1.0, mu: 1.0e-3, source: "Schafer-Turek 1996 sec. 2"}
bcs:
  - {selection: inlet, type: velocity, expr: "4*Um*y*(H-y)/H^2", params: {Um: 0.3, H: 0.41}}
  - {selection: outlet, type: do_nothing}
  - {selection: [walls, cylinder], type: no_slip}
initial: null
study: {type: stationary}          # stationary | transient {t_end, dt_out} | eigen {n, shift} | frequency {f_list} | parametric
references:
  - quantity: c_D
    definition: "2 F_D / (rho Ubar^2 D), Ubar = 2 Um / 3"
    value: 5.57953523384
    unit: "1"
    tolerance: {rel: 1.0e-3, after: richardson}   # or abs; or rule (range, monotonic, sign, ...)
    bounds: [5.57, 5.59]           # published bounds where they exist
    basis: P                       # P | S | D (section conventions)
    form: closed_form              # closed_form | benchmark | paper_sim | paper_measured | solver_ref | dataset
    provenance:
      citation: "Nabh 1998 via FEATFLOW DFG 2D-1 reference results"
      locator: "featflow.de/en/benchmarks/cfdbenchmarking/flow/dfg_benchmark1_re20.html, 'Reference results'"
      accessed: 2026-11-06
reference_results:                 # other codes' numbers, informative, never the gate
  - {solver: "Schafer-Turek 1996 participants", c_D_range: [5.57, 5.59]}
convergence: {levels_min: 3, ratio_min: 1.5, method: richardson_gci, safety_factor: 1.25}
speed:
  budget_s: {browser: 5.0, native: 1.0}    # target wall time to reach tolerance on the reference machine
  report: [dofs, wall_s_by_stage, iterations, error_vs_ref]
  reference_timings: []            # published timings for the same problem, with locator
dataset: null                      # for class-c dataset cases: {name, subset, file, sample_index, frame0, metric}
rights:
  source_license: "open web page, no terms stated; paper Springer NNFM 52 (paywalled)"
  allowed: [cite_values, re_derive_setup]
  forbidden: [copy_text, copy_figures, copy_input_files]
hero: {suitable: true, why: "steady wake, 2D, fast", visual: [velocity_magnitude, streamlines]}
missing: []                        # inputs no source discloses
assumptions: []                    # every inferred value, labelled
```

Rules carried over from the atlases: no comparison at singular nodal maxima (use probes, integrals, ring means); at least three meshes with ratio >= 1.5 for class a/b; Richardson + GCI (Roache 1994; Celik et al. 2008); every run writes a timestamped log and a result JSON with inputs hash, solver version, levels, values, error, ISO date.

## 3. Starter list (48 cases)

Columns: hero `H` = proposed hero demo. Browser time = coordinator estimate (est.) for a WASM/WebGPU solver at a mesh that reaches the stated tolerance; not measured. Value basis per section conventions.

### 3.1 Heat transfer (4)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| HT-01 | a | heat-cond, heat-conv | 2D | NAFEMS T4: 0.6 x 1.0 m plate, k 52 W/m K, bottom 100 C, left insulated, right + top h 750 W/m2 K to 0 C | T(E = 0.6, 0.2 m) = 18.3 C | P: Altair OS-V 0120; FEATool ex_heattransfer4.m L127 | NAFEMS paid; value cited | <1 s |
| HT-02 | a | heat-transient | 1D | NAFEMS T3: bar L 0.1 m, k 35, cp 440.5, rho 7200; T(x,0) = 0, T(0,t) = 0, T(0.1,t) = 100 sin(pi t / 40) C | T(0.08 m, 32 s) = 36.60 C | P: Altair OS-V 0110. D: this lane's eigen-series 36.603 C (4000 terms). FEATool states x = 0.02 m, t = 36 s (reversed coordinate; series gives 36.68 C at t = 36 s): flagged | as above | <1 s |
| HT-03 | a | heat-rad | 1D | NAFEMS T2: rod L 0.1 m, T_A 1000 K, end B radiates (eps 0.98) to 300 K | T_B = 927 K | P: NAFEMS via Abaqus/CalculiX forum (C3D20 927.004 K). D: root of k(T_A - T_B)/L = eps sigma (T_B^4 - 300^4): 927.004 K (k 55.6), 926.967 K (k 55.563, FEATool) | as above | <1 s |
| HT-04 | a | heat-transient, heat-conv | 1D | Semi-infinite steel solid, T_i 0 C, sudden convection to 1000 C, h 50 W/m2 K, k 54, rho 7833, c 465 | at t = 2000 s, depth 0.0223 / 0.0859 / 0.1866 / 0.3462 m: 140.0 / 98.9 / 51.8 / 14.5 C | P: Ansys VM28 (cites Holman 4th ed. p. 106). D: Carslaw-Jaeger erfc closed form gives 140.42 / 98.85 / 51.76 / 14.45 C; gate on the closed form | Ansys pointer; formula is textbook | <1 s |

### 3.2 Solid mechanics (7)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| SM-01 H | a | solid-linear | 2D | Kirsch: circular hole in a wide plate under uniaxial tension (plane stress), W/D >= 20 | K_t = sigma_theta,max / sigma_inf = 3 (infinite plate); full field sigma_rr, sigma_theta, tau closed form | a: Kirsch 1898; Timoshenko-Goodier, Theory of Elasticity (formula, not fetched) | textbook | <1 s |
| SM-02 | a | solid-linear | 2D | NAFEMS LE1 elliptic membrane, E 210 GPa, nu 0.3, 10 MPa outer traction | sigma_yy(D) = 92.7 MPa | P: FeenoX mechanical examples ("reference is 92.7"; FeenoX 92.7011) | NAFEMS paid; FeenoX GPL-3.0 | <2 s |
| SM-03 | a | solid-buckling | 1D/3D | Euler column pinned-pinned, L 200 in, 0.5 in square, E 30e6 psi | F_cr = 38.553 lbf | P: Ansys VM127 (cites Timoshenko, Strength of Materials II, p. 148). D: pi^2 E I / L^2 = 38.5531 | textbook | <1 s |
| SM-04 | a | solid-contact | 2D-axisym | Hertz: sphere R 8 mm on rigid plane, E 1000 N/mm2, nu 0.3, F = 60 pi N | contact radius a = 1.010 mm | P: Ansys VM63 (cites Timoshenko-Goodier 3rd ed. pp. 409-413). D: a = (3 F R / 4 E*)^(1/3) = 1.00964 mm | textbook | 1-3 s |
| SM-05 | a | solid-modal | 3D | NAFEMS FV52: simply supported solid plate 10 x 10 x 1 m, E 200 GPa, nu 0.3, rho 8000 | modes 4-10: 45.897, 109.44, 109.44, 167.89, 193.59, 206.19, 206.19 Hz | P: Ansys VM-NAFEMS (Hlp_V_VMC5.html, TNSB Aug 1989). Altair FV52 page disagrees: do not use | NAFEMS paid | 2-5 s |
| SM-06 | a | solid-modal | 3D shell/solid | NAFEMS FV12: free thin square plate 10 x 10 m, t 0.05 m | modes 4-9: 1.622, 2.360, 2.922, 4.233, 4.233, 7.416 Hz | P: Abaqus v2016 mirror ceae-server.colorado.edu ch04s04anf18 (TNSB Rev. 3) | NAFEMS paid; mirror rights unclear | 2-5 s |
| SM-07 | a | solid-plasticity | 2D | Plastic hinge, 1 x 2 in beam, sigma_y 36 ksi, M_yp 24000 in-lb | rotation 0.01200 / 0.01469 / 0.02078 at M/M_yp = 1.0 / 1.1666 / 1.3333; collapse at 1.5 | P: Ansys VM24 (cites Timoshenko II art. 64, p. 349) | textbook | 1-3 s |

### 3.3 Electrostatics, magnetostatics, currents (5)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| EM-01 | a | electrostatics, magnetostatics | 2D | Coax a 0.5 mm, b 1.75 mm, eps_r 2.1 (synthetic) | Z0 = 51.8334 Ohm; C' = 93.2565 pF/m; L' = 250.5526 nH/m; check L'C' = mu eps | D: Z0 = eta0 ln(b/a) / (2 pi sqrt(eps_r)) (Pozar) | textbook | <1 s |
| EM-02 | c | electrostatics | 2D-axisym | Two spheres a 1 cm, b 2 cm, center spacing 5 cm, vacuum | Maxwell capacitance C_aa 1.230518, C_bb 2.431543, C_ab -0.4945668 pF (Lekner analytic) | P: Palace docs spheres.md L76-84 | Apache-2.0 | <2 s |
| EM-03 | c | magnetostatics | 2D-axisym | Coplanar concentric rings r_a 10 um, r_b 100 um, w 1 um | M_ab 1.973921, L_aa 41.78537, L_bb 707.2050 pH (analytic) | P: Palace docs rings.md L60-82 | Apache-2.0 | <2 s |
| EM-04 H | a | magnetostatics | 2D-axisym / 3D | Helmholtz coil, N 1, I 1 A, R 0.1 m, spacing R | B(center) = (4/5)^(3/2) mu0 N I / R = 8.99176 uT; d2B/dz2 = 0 at center | D: Biot-Savart closed form | textbook | <2 s |
| EM-05 | c | eddy, currents | 2D | Hollow Al cylinder r 57.15 / 69.85 mm, sigma 2.538e7 S/m, 60 Hz, B0 0.1 T | By(0,0) = -0.0018 - j0.0210 T; loss 2288 W/m | P: Ansys VM166 (cites Emson, RAL-86-049, 1986, p. 39) | pointer | <2 s |

### 3.4 RF / microwave (4)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| RF-01 H | c | rf-resonator | 2D-axisym (per m) / 3D | PEC cylinder cavity, a 2.74 cm, d = 2a, eps_r 2.08, tan d 4e-4 | TM010 2.903605, TE111 2.922212, TM011 3.468149, TM110 4.626474, TE211 4.146842, TE011 5.000140 GHz; Q_d = 2.50e3; copper walls (Rs 0.0184 Ohm) TE011 Q = 2.30e3 (Pozar Ex. 6.4) | P: Palace docs cylinder.md L26-28, L113-158. D: x01 c / (2 pi a sqrt(eps_r)) = 2.903636 GHz; Palace's own Floquet table also lists TM01 2.903636: 1.1e-5 rel. discrepancy, resolve before gating at <1e-4 | Apache-2.0 | 2D: <2 s; 3D: 5-30 s |
| RF-02 | a | rf-waveguide, rf-sparams | 2D / 3D | WR-90 a 22.86 mm, b 10.16 mm, air; straight section length L | f_c TE10 6.55714, TE20 13.11428, TE01 14.75357 GHz; S21 = exp(-j beta L), S11 = 0, beta = sqrt(k0^2 - (pi/a)^2) | D: closed form (Pozar ch. 3) | textbook | 2D eig <1 s; 3D S 5-20 s |
| RF-03 | c | rf-waveguide | 2D | CPW w 30 um, s 18 um on 500 um sapphire (quasi-TEM) | Z0 = 56.02 Ohm | P: Palace docs cpw.md L19-25 (cites its ref. [1]; anisotropic sapphire eps per that page) | Apache-2.0 | <2 s |
| RF-04 | a | rf-antenna | 2D-axisym / 3D | Thin half-wave dipole, sinusoidal current | Z_in = 73.079 + j42.515 Ohm (infinitely thin, center fed); FEM on finite radius: gate on trend Z_in(radius) and resonant length < lambda/2 | D: R = (eta0 / 4 pi) Cin(2 pi), X = (eta0 / 4 pi) Si(2 pi) (Balanis ch. 4, formula not fetched) | textbook | 3-10 s |

### 3.5 Wave optics (5)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| WO-01 | a | optics-modes | 1D | Symmetric slab: Si 220 nm in SiO2, 1550 nm, n_Si 3.477723756, n_SiO2 1.444023622 (values as in eo-modulator-atlas K1, Salzberg-Tatian / Malitson fits) | n_eff TE0 = 2.849489, TM0 = 2.054619 | D: transcendental dispersion relation, brentq | textbook | <0.5 s |
| WO-02 | b | optics-modes | 2D | Hadley 2002 rib: lambda 1.15 um, n 3.44 / 3.40 / 1, rib 3 x 1 um, slab t 0-0.7 um; plus metal-box square core 0.5 x 0.5 in 1 x 1 at lambda 1.5 | rib n_eff (t = 0, 0.1, ..., 0.7 um): 3.412022, 3.412126, 3.412279, 3.412492, 3.412774, 3.413132, 3.413571, 3.414100 (+-3e-6); box: eps 2.25/1 -> 1.27627404, 8/1 -> 2.65679692 | S: femwell docs/benchmarks (re-tab of Hadley, JLT 20:1219, paywalled) | GPL-3.0 re-tab; paper paywalled | 1-5 s |
| WO-03 H | a | optics-scattering | 2D-axisym / 3D | Mie, dielectric sphere m 1.55, x 5.213; absorbing m 1.5 - 1i, x 1 | Qext = Qsca = 3.10543, Qback 2.92534, g 0.63314; absorbing: Qext 2.336321, Qsca 0.6634538, g 0.192136 | S: miepython tests test_03, test_07 (BHMIE / Wiscombe MIEV0 case 14) | MIT re-tab; formulas textbook | 3D FEM 10-60 s; series <0.1 s |
| WO-04 H | c | optics-phc | 2D-periodic | Square lattice dielectric rods r 0.2a, TM; eps 12 (MPB) and eps 8.9 (JJ book) | eps 12: gap 0.282623311 to 0.419334799 (38.95 %); eps 8.9: 0.32 to 0.44, 31.4 % (figure precision) | P: MPB Python tutorial; JJ 2nd ed. ch. 5 p. 69, fig. 16 caption p. 84 | GPL-2.0+ / book | <2 s (k-path 30 pts) |
| WO-05 H | c | optics-modes, rf-resonator | 2D | Meep ring: n 3.4, w 1, r 1 (a = c = 1 units), resolution 10, f_cen 0.15, df 0.1 | f = 0.118101575 (Q 80.68), 0.147162556 (Q 316.29), 0.175246751 (Q 1677.48) | P: Meep tutorial "Modes of a Ring Resonator"; gold python/tests/test_ring.py L67-68 | GPL-2.0+ | FDTD 2-10 s; FEM eig <2 s |

### 3.6 Acoustics (3)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| AC-01 | b | acoustics | 3D / 1D | Hornikx 2015 duct: 3.4 m, 0.2 x 0.2 m, v_x(0) 1 m/s, matched end | p(x) = -rho c v_x(0) e^(ikx), abs(p) = rho c | P: Hornikx, Kaltenbacher, Marburg, Acta Acust. 101:811 (2015), eq. 2, sec. 4.1 | free PDF "personal use only" | <2 s |
| AC-02 H | a | acoustics | 3D | Rigid box 1.0 x 0.8 x 0.6 m, c 343 m/s | lowest modes 171.500, 214.375, 274.534, 285.833 Hz | D: f = (c/2) sqrt((l/Lx)^2 + (m/Ly)^2 + (n/Lz)^2) | textbook | 1-3 s |
| AC-03 | a | acoustics | 2D-axisym | Plane wave on rigid sphere, ka 0.5-10 | scattered pressure and form function: value to compute from partial-wave series (Morse-Ingard; not fetched) | D (to compute) | textbook | 1-5 s |

### 3.7 Fluid flow (7)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| FL-01 | a | stokes, laminar-ns | 2D | Kovasznay flow, Re 10 on [-0.5, 1.5]^2; plus planar Poiseuille u = 4y(1-y), p = 8(1-x) | exact u, v, p (lambda = Re/2 - sqrt(Re^2/4 + 4 pi^2)); gate: L2/H1 error rates p+1 / p | P: deal.II step-55 ExactSolution; dolfinx-tutorial ns_code1 | Apache-2.0-LLVM / CC BY 4.0 | <2 s |
| FL-02 H | b | laminar-ns | 2D | Lid-driven cavity Re 100, 1000 | Ghia Tables I-II centerline profiles (e.g. Re 100: u(0.5, 0.5) = -0.20581; Re 1000 v(0.5, 0.5) = 0.02526); Botella-Peyret Re 1000: psi_min -0.1189366, omega_c 2.067753, vortex (0.5308, 0.5652), u_min on x = 0.5 -0.3885698, v_max 0.3769447, v_min -0.5270771 | S: pysph ghia_cavity_data.py (BSD); Erturk-Dursun arXiv physics/0505121 Table 1; INS2D LDC_pp.m (LGPL-3.0). Ghia errata in Re 3200/10000/400 rows | JCP paywalled; re-tabs open | Re 100: 1-3 s; Re 1000: 3-15 s |
| FL-03 H | b | laminar-ns | 2D | DFG 2D-1, Re 20, Um 0.3, rho 1, nu 1e-3 | c_D 5.57953523384, c_L 0.010618948146, dp 0.11752016697; bounds c_D 5.57-5.59, c_L 0.0104-0.0110, dp 0.1172-0.1176 | P: FEATFLOW DFG 2D-1 page (Nabh 1998 reference); Schafer-Turek NNFM 52, Table 3 (open copy on Hron course page) | values cite | 2-10 s |
| FL-04 H | b | laminar-ns | 2D | DFG 2D-2, Re 100, Um 1.5 (periodic) | bounds: c_D,max 3.22-3.24, c_L,max 0.99-1.01, St 0.295-0.305; FEATFLOW L6: 3.2200, 0.9859, 0.30188 | P: Schafer-Turek Table 4; FEATFLOW 2D-2 page | values cite | 30-300 s (est.); hero only as precomputed replay or WebGPU |
| FL-05 | c | turbulent | 2D | NASA TMR zero-pressure-gradient flat plate, SA, M 0.2, Re 5e6/unit length | Cf(x = 0.970084071) = 2.70562153e-3 (CFL3D), 2.70540473e-3 (FUN3D); CD 2.85985288e-3 / 2.852469e-3; SST: Cf 2.69085355e-3 / 2.69054633e-3 | P: tmbwg.github.io/turbmodels flatplate_sa, flatplate_sst | CC0-1.0 | native only (est. 1-10 min) |
| FL-06 | c | porous | 2D | PDEBench 2D Darcy, -div(a grad u) = beta, u = 0 on boundary, 128^2, beta in {0.01 .. 100} | stored u fields; metric nRMSE vs own converged FEM on the stored a(x) | P: PDEBench paper App.; DaRUS doi:10.18419/darus-2986 | CC BY 4.0 | <1 s per sample |
| FL-07 | c | turbulent | 2D | AirfRANS sample (NACA 4/5-digit, Re 2-6e6, AoA -5 to 15 deg, k-omega SST, simpleFoam) | C_D, C_L relative error; surface p, field MSE | P: AirfRANS paper sec. 5; readthedocs | ODbL-1.0 | native (25 min on 16 cores per sim, paper Table 4) |

### 3.8 Transport (3)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| TR-01 | a | transport-reaction | 1D | Isothermal plug-flow reactor, first-order A -> B, then axial dispersion (Danckwerts BCs) | C(L)/C0 = exp(-k L / u) (no dispersion); dispersion: closed form (Danckwerts 1953; formula not fetched) | D | textbook | <0.5 s |
| TR-02 | c | transport-diffusion | 1D | PDEBench 1D advection u_t + beta u_x = 0, periodic, 1024 cells, beta in {0.1 .. 7}, t in [0, 2] | exact shift of stored IC; also PDEBench data; metric nRMSE (eq. 4) | P: PDEBench sec. 3.3; config `init_key: 2022` | CC BY 4.0 | <0.1 s |
| TR-03 H | c | transport-reaction | 2D | The Well gray_scott_reaction_diffusion: periodic [-1, 1]^2, 128^2, delta_u 2e-5, delta_v 1e-5, 6 (f, k) sets, t <= 10000 | stored fields; VRMSE vs horizon; pattern class | P: The Well README + paper App. E.3; generator github.com/danfortunato/spectral-gray-scott | CC-BY-4.0 data, BSD-3 code | 2-20 s (WebGPU est.) |

### 3.9 Semiconductor (2)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| SC-01 | a | semiconductor-dd | 1D | Abrupt Si pn junction, N_A = N_D = 1e18 cm^-3, 300 K, n_i 1e10 cm^-3 | V_bi = 0.95242 V; W(0 V) = 49.63 nm (eps_r 11.7) / 48.34 nm (11.1) | D: Hu, Modern Semiconductor Devices for ICs, eqs. 4.1.2, 4.2.8 | free author PDF, all rights reserved | <0.5 s |
| SC-02 | c | semiconductor-dd | 1D | DEVSIM diode_1d: same doping, length 1e-5 cm, mu_n/mu_p 400/200, tau 1e-8 s, SRH, Scharfetter-Gummel | J_tot (A/cm^2, unit inferred) at 0.1-0.5 V: 1.1592e-7, 1.1363e-6, 1.5931e-5, 4.4875e-4, 1.8155e-2; short-base J0 estimate within 0.5 % at 0.5 V (D) | P: DEVSIM goldenresults/examples/diode/diode_1d.out | Apache-2.0 | <1 s |

### 3.10 Coupled multiphysics (8)

| ID | Cls | Tags | Dim | Problem | Reference value(s) | Basis, locator | Rights | Browser (est.) |
|---|---|---|---|---|---|---|---|---|
| CP-01 H | b | coupled-heat-ns (natural convection) | 2D | de Vahl Davis square cavity, Pr 0.71, Ra 1e3-1e6 | Nu_avg 1.118 / 2.243 / 4.519 / 8.800; u_max(x = 0.5) 3.649 / 16.178 / 34.73 / 64.63; Le Quere Ra 1e6 Nu 8.8252 | S: Markatos-Pericleous 1984 Table 2 (de Vahl Davis column; scan OCR noisy, re-check digits); notus-cfd docs for Le Quere | IJNMF paywalled | 2-15 s |
| CP-02 | a | solid-thermal-stress | 3D | NAFEMS LE11 cylinder/taper/sphere, T = sqrt(x^2 + y^2) + z, alpha 2.3e-4 | sigma_zz(A) = -105 MPa | P: Altair OS-V 0070; FeenoX -105.04 MPa (temperature form differs on the Abaqus page: verify) | NAFEMS paid | 5-20 s |
| CP-03 | c | coupled-joule (heat generation) | 1D-axisym | Wire r0 0.375 in, q''' 111311.7 Btu/hr ft^3, h 5, T_air 70 F (Ansys VM58) | T_center 419.9 F, T_surface 417.9 F, q 341.5 Btu/hr | P: Ansys VM58 (cites Rohsenow-Choi 1963 ex. 6.5) | pointer | <0.5 s |
| CP-04 | c | coupled-joule, coupled-thermoelastic | 3D | Si electrothermal microactuator at 15 V (Ansys VM223) | tip UY 0.2700E-04 (units not on page; likely m) | P: Ansys VM223 (cites Mankame-Ananthasuresh, JMM 11:252, 2001) | pointer | 5-30 s |
| CP-05 | a | coupled-eof | 2D | Electro-osmotic slit flow, eps_r 80, zeta -50 mV, E 1e4 V/m, eta 1e-3 Pa s; Debye-Huckel Poisson + Stokes | plug velocity u_HS = eps zeta E / eta = 3.5417e-4 m/s (sign by convention); profile u(y) = u_HS (1 - cosh(y/lambda_D) / cosh(h/lambda_D)) | D: Helmholtz-Smoluchowski (Wikipedia re-tab; standard texts, not fetched) | textbook | <1 s |
| CP-06 | c | coupled-piezo | 3D | PZT-4 cube 0.02 m, short- and open-circuit modes (Ansys VM175) | 66560 / 88010 (short), 81590 / 93410 (open); page unit label kHz is implausible, magnitudes suggest Hz: resolve | P: Ansys VM175 (cites Boucher et al., IEEE SU-28, 1981, Table 1) | pointer | 2-10 s |
| CP-07 | b | coupled-fsi | 2D | Turek-Hron FSI1 (rho_s/rho_f 1, mu_s 0.5e6, Ubar 0.2); CSM1 structure-only | FSI1: u_x(A) 2.270493e-5 m, u_y(A) 8.208773e-4 m, drag 14.29426, lift 0.7637460; CSM1: u_x(A) -7.187e-3, u_y(A) -66.10e-3 m | P: FEATFLOW fsi_fsi_tests.html, fsi_csm_tests.html (finest level) | values cite | 10-60 s |
| CP-08 | b | coupled-optomech | 3D | Si optomechanical crystal nanobeam (Chan 2012) | simulated g/2 pi = 770 kHz, f_m 5.7 GHz, Q_o 2.2e7; geometry: value to extract from paper | P: Chan et al., APL 101:081115 (arXiv 1206.2099) fig. 2-4 captions | arXiv open | native (est. minutes) |

Thermo-optic (CP-09, proposed, not counted): Si strip or WO-01 slab, dn/dT Si 1.87e-4 /K at 1.5 um, 295 K (Frey 2006 Table 4, arXiv physics/0606168); gate = finite-difference dn_eff/dT from two mode solves vs first-order perturbation sum over regions; SiO2 dn/dT not yet sourced (N/A).

**Count and balance**: 48 cases (heat 4, solid 7, EM 5, RF 4, optics 5, acoustics 3, fluids 7, transport 3, semiconductor 2, coupled 8) plus CP-09 proposed; classes a 24, b 8, c 16 (class b is thin: add Erturk BFS, DFG 3D-1Z, Turek-Hron FSI3 from the reserve if needed). Hero (12): SM-01, EM-04, RF-01, WO-03, WO-04, WO-05, AC-02, FL-02, FL-03, FL-04 (replay or WebGPU), TR-03, CP-01 (pick 10 after the first timing run).

**Not in the list, reserve**: NAFEMS LE10 (-5.38 MPa), T1 (50 MPa), LE2/LE3/LE5/LE6 shells (60 MPa, 0.185 m, -108 MPa, 0.802 MPa), FV2/FV4/FV16/FV22/FV32; Ansys VM50, VM120, VM125 (Q 37.0 Btu/hr in; D: 37.04), VM188 (-0.009684 N/m), VM191; Code_Aster SSLV04A (DX(A) 5.9e-5, ANALYTIQUE) and TTLV01A (334.0 at 400 s, 5 %); Palace coax London inductance, coax 100 Ohm port (|Gamma| 1/3); Elmer EM_port_eigen; MPB triangular rods (0.275065617-0.446289919) and diamond (0.396348703-0.440813419); Erturk 2008 BFS x_r table; DFG 3D-1Z (c_D 6.18533, c_L 0.009401); Turek-Hron FSI2/FSI3, CFD1-3, CSM3; MKM channel (centerline U+ 18.301 at Re_tau 178.12); Eichenfield 2009 (2.254 GHz breathing mode); NASA TMR NACA0012 (CL 1.0909-1.0911 at 10 deg); TEAM 7 (needs paywalled measured data); MFEM ex/ deal.II step-7 convergence tables.

## 4. Using The Well / PDEBench-style datasets

Principle (est., agreed by lane a): no independent solver reproduces these bit-for-bit (fp32 storage, downsampling, unpublished seeds, different discretization). Use them as **IC-and-trajectory references**: load stored frame 0 (and stored coefficient fields such as Darcy a(x)), integrate with our solver at a resolution where our own result is converged, compare against the stored trajectory with the dataset's own metric, and report the metric next to our self-convergence floor (difference between our two finest levels). A dataset case passes when error vs dataset is within the dataset's discretization floor, which must be estimated from the dataset's stated scheme (est.) or from its own resolution variants.

| Subset | Equations / params | Resolution | Generator (public?) | Reproducible by us | Metric |
|---|---|---|---|---|---|
| PDEBench 1D advection | u_t + beta u_x = 0, beta {0.1, 0.2, 0.4, 0.7, 1, 2, 4, 7}, periodic | 1024 x 201 | JAX 2nd-order upwind; exact script also; PRNG key 2022 | yes; exact solution available | nRMSE, fRMSE bands (low 0-4, mid 5-12, high 13+) |
| PDEBench 1D Burgers | nu 0.001-4 (12 values), periodic | 1024 x 201 | JAX FD; Hydra configs | yes (non-chaotic) | nRMSE, cRMSE |
| PDEBench 1D diffusion-sorption | nonlinear retardation, D 5e-4 | 1024 x 101 | FV + RK45; 59.83 s per sample (sec. 4.4) | yes | nRMSE, bRMSE |
| PDEBench 2D diffusion-reaction | FitzHugh-Nagumo, Du 1e-3, Dv 5e-3, k 5e-3, Neumann, t <= 5 | 128^2 x 101 (computed at 512^2) | FV + RK45; 2.21 s per sample | yes | nRMSE |
| PDEBench 2D Darcy | -div(a grad u) = beta, Dirichlet 0 | 128^2 steady | pseudo-time relaxation; a(x) generator not described | yes with stored a(x) | nRMSE |
| PDEBench 2D shallow water | radial dam break, g 1, h 2/1, r ~ U(0.3, 0.7) | 128^2 x 101 | PyClaw FV; 0.62 s | yes (shock-capturing FV needed) | nRMSE |
| The Well gray_scott_reaction_diffusion | delta_u 2e-5, delta_v 1e-5, 6 (f, k), periodic, dt 1, t <= 10000 | 128^2 x 1001 | Chebfun Fourier + ETDRK4 (public) | yes, drift over long horizon is the test | VRMSE (1.0 = predicting the spatial mean) |
| The Well helmholtz_staircase | Helmholtz, sound-hard periodic staircase, radiation condition, 16 omega | 1024 x 256 x 50 phases | BIE, deterministic, github.com/fruzsinaagocs/bies | yes; needs PML/Floquet; high-accuracy reference | VRMSE |
| The Well acoustic_scattering (3 variants) | linear acoustics, variable rho, K 4 | 256^2 x 101-201 | Clawpack scripts + NumPy SeedSequence (seed 0) | yes | VRMSE |
| PDEArena Maxwell-3D | FDTD, periodic, eps_r 10, lambda 10 um, L 32 um, dx L/64 | 32^3 x 8 stored | python `fdtd`, seeds published | yes; direct FDTD check | nRMSE |
| The Well rayleigh_benard (low Ra), shear_flow, euler_multi_quadrants, turbulent_radiative_layer_2D | Boussinesq NS / incompressible NS / Euler / Euler + cooling | 512 x 128 / 256 x 512 / 512^2 / 128 x 384 | Dedalus (public, RB seeds 40-49), AMRClaw, Athena++ | statistical only (chaotic or shocks) | spectra, moments, VRMSE at short horizon |
| Not regenerable (HPC or closed codes) | MHD_256, RT instability, supernova, convective envelope, neutron star merger, viscoelastic, PDEBench 3D CFD, JHTDB | - | - | no; JHTDB usable for statistics and small cutouts | - |

Metric definitions (verified): PDEBench nRMSE = ||u_pred - u_true||_2 / ||u_true||_2 (eq. 4); fRMSE per Fourier band (eq. 5); The Well VRMSE = sqrt(<|u - v|^2> / (<|u - u_bar|^2> + eps)), eps 1e-7 in code (App. E.3). Speed comparisons with ML surrogates follow McGreivy-Hakim (Nat. Mach. Intell. 2024): equal-accuracy or equal-runtime vs a strong baseline; PDEBench reports 582.61 s solver vs 0.14 s FNO inference for 2D CFD 512^2 (sec. 4.4), with 107,567 s training.

Known inconsistencies to settle before use: The Well shear_flow size/grid differ across paper, docs, README; acoustic_scattering_maze 201 vs 100 steps; PDEBench NS_incom DaRUS filenames say 512, paper/config 256^2; 4 The Well HF repos without license tag (paper states CC-BY-4.0); shear_flow v2.0 (2026-10) rebuilt splits because ~80 % of v1 val/test duplicated train.

## 5. Speed benchmarking

### 5.1 Reference benchmark definitions (CEED bake-off)

| ID | Operator | Field | Quadrature | Notes |
|---|---|---|---|---|
| BP1 / BK1 | mass | scalar | p+2 Gauss-Legendre | BP = full CG incl. gather/scatter; BK = element kernel only |
| BP2 / BK2 | mass | vector (3) | p+2 GL | |
| BP3 / BK3 | Poisson stiffness | scalar | p+2 GL | homogeneous Dirichlet |
| BP4 / BK4 | stiffness | vector | p+2 GL | |
| BP5 / BK5 | stiffness | scalar | p+1 GLL collocated | Fischer 2020 Table 1 settles GLL |
| BP6 / BK6 | stiffness | vector | p+1 GLL collocated | |

Metric (Fischer et al., IJHPCA 34:562, 2020, eq. 3): DOF/s = (CG iterations x DOFs) / (nodes x seconds), plotted against DOFs per node; summarize r_max, n_0.8 (points per node at 80 % of peak), t_0.8 ~ 1.25 n_0.8 / r_max. Code: CEED/benchmarks (BSD-2), libCEED bps.c (BSD-2; prints DoFs/Sec in CG and L2 error vs exact), MFEM tests/benchmarks/bench_ceed.cpp (BSD-3, Google Benchmark counters "MDof/s").

### 5.2 Published timing anchors

| Value | Problem | Hardware | Locator |
|---|---|---|---|
| 80 (Nek5000), 25 (MFEM) MDOF/s per node | BP5 | IBM BG/Q node | Fischer 2020 sec. 6.3 |
| 18 (MFEM), 20 (Nek), 28 (deal.II) MDOF/s per node | BP3 | BG/Q | Fischer 2020 sec. 6.2 |
| > 10,000 MDOF/s per node; n_0.8 ~ 15M points/node | BP5, libParanumal | Summit, 6 V100 per node | Fischer 2020 sec. 8.2 |
| ~2 GDOF/s per GPU; n_0.8 ~ 3M | BP3, MFEM + libCEED | Lassen V100 | Kolev et al., IJHPCA 35:527 (2021) sec. 4 |
| 0.12 s (GPU), 1.45 s (16 cores), 13.73 s (1 core) for 200 CG iterations | 2D Poisson, 1.3M DOF, p 4, partial assembly | GV100; Xeon Gold 6130 | MFEM paper, CAMWA 81:42 (2021) Table 2 |
| 1.58e7 (k 4), 7.89e6 (k 1) DOF solved per s; assembled AMG 3.94e6 (k 1) | 3D Poisson to 1e-9, ~10M DOF, matrix-free GMG-CG vs ML-AMG | 2 x 14-core Broadwell | Kronbichler-Wall, SISC 40:A3423 (2018) Table 1 |
| 7.42 s (1 node) solve | DOLFINx Poisson weak scaling (BoomerAMG); DOF per process not stored | CSD3 Icelake, 2024-05-15 | FEniCS/performance-test-results csd3_2405.json |
| ~1.5 min (15.5M DOF), ~12 min (246.2M DOF) | Palace eigenmode, transmon + readout | AWS CPU | AWS Quantum blog 2023-02-22 |
| 118.0 MCells/s | openEMS MSL_NotchFilter, 269,780 cells | CPU not stated (user gist, not official) | gist.github.com/biergaizi/7f45c243f6e17b509bd1ea785a6af9e7 |
| WASM 45-55 % slower than native (SPEC CPU avg) | - | 2019 browsers | Jangda et al., USENIX ATC 2019 |
| 24-71 us per WebGPU dispatch | sequential dispatch | 4 GPU vendors, 3 browsers | arXiv 2604.02344 v1 (v2 withdrawn) |
| PDEBench solver per sample: 1D diffusion-sorption 59.83 s; 2D diffusion-reaction 2.21 s; SWE 0.62 s; 2D CFD 512^2 582.61 s | dataset generation | EPYC 7742 + V100 / RTX 3090 | PDEBench sec. 4.4, App. F-G |
| ~25 min per sim on 16 cores | AirfRANS RANS | Threadripper 3960X | AirfRANS Table 4 |

Gaps: no Palace GPU timings published; no official Meep or openEMS throughput tables; FEniCS results lack DOF counts; no peer-reviewed WebGPU SpMV / CG / FDTD throughput; no clean hypre/PETSc "s per MDOF" for 3D Poisson; WGSL f64 support status not verified this round.

### 5.3 Proposed speed metrics (proposal)

1. **Throughput (kernel health)**: browser and native ports of BP1-BP6 / BK1-BK6; report MDOF/s vs DOF per device, r_max, n_0.8, t_0.8 per p and backend. BK and BP separately. For WebGPU, n_0.8 and per-dispatch latency decide where the browser path wins (small meshes are latency-bound, est.).
2. **Time-to-accuracy (user-facing, per eval case)**: for each case, wall time from "model spec loaded" to "result within the case tolerance of the reference", on a mesh sequence; plot work-precision curves (error vs wall time, log-log; SciMLBenchmarks/DiffEqDevTools convention). Headline number: T_tol = interpolated wall time at the case tolerance; secondary: DOF solved per second = DOF / wall time to solution (Kronbichler-Wall), with iteration counts.
3. **Stage breakdown**: geometry, mesh, assembly, preconditioner setup, solve, post-processing, plus browser-only stages (WASM compile, pipeline creation, host-device upload), as in FEniCS performance-test.
4. **Protocol**: one discarded warm-up; median of >= 5 timed runs (SPEC CPU 2017 uses median of 3; Hoefler-Belli SC15: nonparametric CIs, report max over ranks, document all factors); fixed iteration count for throughput, fixed tolerance for time-to-solution; machine descriptor (CPU, GPU, browser + version, memory) in every record; timestamped log per run.
5. **Speed budget field**: `speed.budget_s.browser` per case (default 5 s for hero cases, est.); a case "meets budget" only at the tolerance, never at an unconverged mesh.
6. **Cross-paradigm**: compare against ML surrogates only at equal accuracy (McGreivy-Hakim 2024).

## 6. Rights rules for this repo (proposal)

- Cite numbers with locator; re-derive geometry, BCs and materials from the original reference (NAFEMS, textbook, paper). Never copy vendor text, figures, input decks, meshes or MPH/PDF content into the repo.
- Copy-compatible into GPL-3.0-or-later with attribution: Apache-2.0 (Palace, DEVSIM, Lethe), BSD (MFEM, scikit-fem, miepython-MIT, libCEED), LGPL (deal.II alt., NGSolve, MOOSE, DOLFINx), GPL-2.0-or-later (Meep, MPB, Elmer), GPL-3.0-or-later (FeenoX, Code_Aster tests, openEMS, femwell), CC BY 4.0 / CC-BY-4.0 data (PDEBench, The Well), CC0 (NASA TMR). CC BY-SA 4.0 (comet-fenicsx) is one-way compatible with GPLv3 for its content. ODbL-1.0 (AirfRANS) data: keep out of the repo; reference by manifest + hash (DevLog-000 section 5).
- Do not copy: NC/ND docs (OpenFOAM guides, ESI docs, Elmer manuals), FDL Code_Aster V-docs (the GPL test files are fine), FEATool (proprietary), NAFEMS booklets, COMSOL Examples, vendor manuals. CalculiX: confirm "or later" before any reuse.
- Third-party mirrors of vendor manuals (Abaqus on university servers): pointers only.

## 7. Open items for Wentao (numbered)

1. **O1 COMSOL**: resolved (DevLog-001 Q5): COMSOL is not used as a reference; no COMSOL-generated reference values.
2. **O2**: accept 48-case list size (asked ~40) or trim the reserve-grade rows (EM-05, SM-07, CP-03)?
3. **O3**: speed reference machine(s) for `budget_s` (dev laptop model and browser) to fix before first timing run.

## 8. Conflicts and flags found

- NAFEMS T3 locator: FEATool says x = 0.02 m, t = 36 s; Altair and this lane's series give 36.60 C at x = 0.08 m (from the T = 0 end), t = 32 s.
- Palace cylinder TM010: 2.903605 (analytic table) vs 2.903636 GHz (Floquet table and this lane's closed form).
- Ansys VM28 first point 140.0 C vs closed form 140.42 C (0.3 %); other points agree to 0.1 C.
- Altair FV12/FV32/FV52 values disagree with TNSB-based Abaqus/Ansys tables.
- Ansys VM175 unit label (kHz) vs magnitudes.
- de Vahl Davis digits come from a noisy OCR of a secondary table; v_max at Ra 1e6 ambiguous (217.36 or 219.36).
- Ghia 1982 errata in the Re 3200, 10000, 400 rows (Re 100 and 1000 clean).
- FSI2 reference rows: FEATFLOW "old values" block vs newer runs; Turek-Hron 2006 own table not seen (paywalled).
- NAFEMS LE11 temperature field: FeenoX sqrt(x^2 + y^2) + z vs Abaqus-page rendering (x^2 + y^2) + z.
- abaqus-docs.mit.edu 410 Gone: advanced-packaging-atlas cases B/nafems-LE10, LE11, T1 cite it.

## 9. Sources (accessed 2026-11-06)

Terms: nafems.org/about-us/legal/downloads/ ; nafems.org/publications/resource_center/p18/ , r0015/ , r0006/ , r0123/ ; nafems.org/publications/code-verification/ ; ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VMTOC.html ; compumag.org/wp/team/

Vendor targets: Ansys VM24, VM28, VM58, VM63, VM127, VM166, VM175, VM223, VM-NAFEMS FV52 (.../ans_vm/Hlp_V_VM<nn>.html, Hlp_V_VMC5.html, v242/v251) ; Altair OS-V 0070, 0110, 0120, FV16 (2021/2022 help.altair.com) ; Abaqus v2016 mirror ceae-server.colorado.edu/v2016/books/bmk/ch04s04anf18.html

Open-source: github.com/awslabs/palace docs/src/examples (cylinder.md, spheres.md, rings.md, coaxial.md, cpw.md) ; meep.readthedocs.io/en/latest/Python_Tutorials/Basics/ ; github.com/NanoComp/meep python/tests/test_ring.py ; mpb.readthedocs.io/en/latest/Python_Tutorial/ ; seamplex.com/feenox/examples/mechanical.html ; gitlab.com/codeaster/src astest/sslv04a.comm, ttlv01a.comm ; dealii.org/current/doxygen/deal.II/step_7.html, step_55.html ; jsdokken.com/dolfinx-tutorial ; github.com/kinnala/scikit-fem tests/test_examples.py ; github.com/ElmerCSC/elmerfem fem/tests/EM_port_eigen ; github.com/precise-simulation/featool-multiphysics (LICENSE; examples) ; github.com/devsim (diode_1d.out) ; github.com/HelgeGehring/femwell docs/benchmarks ; github.com/scottprahl/miepython tests/test_mie.py ; github.com/pypr/pysph pysph/examples/ghia_cavity_data.py ; github.com/bsanderse/INS2D ; Lethe examples/incompressible-flow/2d-backward-facing-step

Papers and benchmark pages: featflow.de/en/benchmarks/cfdbenchmarking/flow/dfg_benchmark1_re20.html , dfg_benchmark2_re100.html , dfg_flow3d/dfg_flow3d_results.html , fsi_benchmark/fsi_tests/fsi_fsi_tests.html , fsi_csm_tests.html , fsi_cfd_tests.html ; www2.karlin.mff.cuni.cz/~hron/NMMO403/dfg_benchmark_results.pdf (Schafer-Turek 1996) ; arxiv.org/abs/physics/0505121 (Erturk-Dursun) ; aivc.org/sites/default/files/airbase_3923.pdf (Markatos-Pericleous 1984) ; doi:10.3813/AAA.918875 (Hornikx 2015) ; arxiv.org/abs/0906.1236 (Eichenfield 2009) ; arxiv.org/abs/1206.2099 (Chan 2012) ; arxiv.org/abs/physics/0606168 (Frey 2006) ; ab-initio.mit.edu/book ; tmbwg.github.io/turbmodels/ ; turbulence.oden.utexas.edu/data/MKM/ ; osti.gov/servlets/purl/759450 (Salari-Knupp) ; chu.berkeley.edu (Hu textbook)

Datasets: github.com/PolymathicAI/the_well ; arxiv.org/abs/2412.00568 ; polymathic-ai.org/the_well/datasets_overview/ ; github.com/pdebench/PDEBench ; arxiv.org/abs/2210.07182 ; darus.uni-stuttgart.de doi:10.18419/darus-2986 ; arxiv.org/abs/2310.05963 ; huggingface.co/datasets/chen-yingfa/CFDBench ; arxiv.org/abs/2212.07564 ; airfrans.readthedocs.io ; turbulence.idies.jhu.edu/citing ; pdearena.github.io/pdearena/data/

Speed: ceed.exascaleproject.org/bps/ ; arxiv.org/abs/2004.06722 (Fischer 2020) ; arxiv.org/abs/2109.04996 (Kolev 2021) ; arxiv.org/abs/1911.09220 (MFEM) ; arxiv.org/abs/1611.03029 (Kronbichler-Wall) ; libceed.org/en/latest/examples/bps/ ; github.com/FEniCS/performance-test ; github.com/SciML/DiffEqDevTools.jl src/benchmark.jl ; spec.org/cpu2017/docs/runrules.html ; doi:10.1145/2807591.2807644 (Hoefler-Belli) ; doi:10.1038/s42256-024-00897-5 (McGreivy-Hakim) ; usenix.org/conference/atc19/presentation/jangda ; aws.amazon.com/blogs/quantum-computing/aws-releases-open-source-software-palace-for-cloud-based-electromagnetics-simulations-of-quantum-computing-hardware

Local prior work (read-only): agentic-multiphysics-harness validation backlog (100 cases; T0 13, T1 24, T2 46, T3 17; 7 hook types: closed form, conservation, symmetry/reciprocity, reduced model, literature, convergence, gradient audit); advanced-packaging-atlas validation/README.md and cases/ (tiers A/B/C/D/H, `ap-sim-val/0`); eo-modulator-atlas validation/cases (21 YAML, `eo-atlas.sim/v1`). Harness first-tranche topics overlapping this list (re-derived here from open references only): Helmholtz coil, coax line parameters, Fresnel, tubular reactor, gold-nanosphere Mie, H-bend waveguide, piezo shear beam, Gray-Scott, directional coupler, heating circuit.

## 10. Progress log

- 2026-11-06: Read DevLog-000 and local validation structures; ran 5 research subagents; coordinator recomputed closed forms (T2, T3, VM28, VM127, VM63, VM125, WR-90, coax, Helmholtz coil, dipole, cavity TM010, slab TE0/TM0, EOF, pn junction, box modes); verified COMSOL SLA clauses from the PDF; wrote this file. No downloads of datasets, no code in repo.
- [ ] Fresh-context audit of this file
- [ ] Resolve flags in section 8
- [ ] Close research gaps listed under section 1
