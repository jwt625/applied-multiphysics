# DevLog-035: truly multiphysics examples, sourced (lane MX)

| Field | Value |
|---|---|
| Date | 2026-11-07 |
| Lane | MX (DevLog-029 s.3.2, s.3.3) |
| Owns | new `sims/<id>.yaml` (multiphysics examples), additions to `materials/*.yaml`, contents of `apps/web/src/lib/library/catalog-mp.ts`, `validation/mp/**`, this file |
| Parallel | LP (DevLog-030, creates catalog-mp.ts), MC (031, coupling core: currents, joule-heating, thermal-expansion), MO (032, thermo-optic, electro-optic), MT (033, piezoelectric, acoustic-structure, solid modal, axisym elastic) |
| Read | DevLog-029 (all), CONTRACTS C3, C10, C11; sims/heat-plate-fin, kirsch-plate, heated-wire, si-strip-te0, cpw-halfspace; catalog.ts, catalog-bc.ts; materials/*.yaml + packages/materials/src/properties.ts; eval cases CP-02, CP-03, CP-04, CP-06, CP-21, CP-43, CP-44; packages/spec provisional registry + physics registrations |
| Status | wave 1 done: 11 sims written and validated (s.5); runs wait for MC / MO / MT; open items s.6 |

Conventions: "F" = fact read from a file or source; "D" = decision of this lane (reason given); "O" = open item. Every physical value in a sim carries a provenance entry (source + locator + ISO date) or is `N/A`; modelling choices are `basis: user` with note "modelling choice". Wentao's own COMSOL inputs: `basis: user`, source "Wentao's model inputs, <NAS>/COMSOL/<folder> (inputs only)" (s.13: no model file names). No COMSOL result, solved value, built-in material-library value or Application Library content is used.

## 1. Plan (2026-11-07 08:28 PST)

### 1.1 Facts (F)
- C11 coupling types: joule-heating (currents -> heat), thermal-expansion (heat -> elastic, `settings.Tref` in C11; the provisional seed registers `T_ref`), thermo-optic (heat -> em-modes, `dn_dT` property in C11; the materials package names it `dndT`), electro-optic (electrostatics -> em-modes, `r_eo` trigonal-3m), piezoelectric (elastic -> electrostatics, monolithic), acoustic-structure (elastic -> acoustics, monolithic). Physics type `currents` does not exist yet (MC adds it).
- Registered physics today: heat, elastic (2d plane-stress / plane-strain, 3d; no axisym, no eigen), electrostatics (2d, axisym), em-modes (2d), acoustics (eigen). Registered material properties (`packages/materials/src/properties.ts`): no piezoelectric e tensor, C only `cubic`, no hexagonal / 6mm / trigonal stiffness. So PZT-4 and LN piezo tensors cannot be stored as typed material properties yet (O1).
- Materials with sourced values usable here: copper (E, nu, alpha fit, rho_e table), aluminum-6061-t6 (E, nu, alpha fit), gold (rho_e, alpha, E), silicon (C cubic, alpha table, k table, dndT at 293 K, n), sio2-thermal-oxide (E, nu, alpha, k, n, dndT), fused-silica, linbo3-congruent (n_o / n_e, eps^S, r_eo at 633 nm), air (rho, c, k).
- One file in COMSOL folder `20250927_LN_FBAR_gapped` is the Application Library model "Thin-Film BAW Composite Resonator" (modelinfo author COMSOL): excluded, nothing read beyond modelinfo.xml. Folder `20240922_mass_loaded_membrane_acoustics` also holds an Application Library model file and its library PDF: excluded.

### 1.2 Approach (D)
1. Read Wentao's own .mph inputs (smodel.json tree or dmodel.xml grep, into the scratchpad only; Parameters, geometry features, material choices, BC types, study settings; Results / solver branches skipped). Material values inside his models come from the COMSOL built-in material library: only the material choice is used, values are sourced elsewhere.
2. Delegate three bounded research tasks (subagents, read only, report values with page / table locators and quotes): (a) packaging-atlas warpage case for a 2D plane-strain chip-on-substrate model; (b) open primary sources for PZT-4 and LiNbO3 piezo tensors (c^E, e, eps^S, rho); (c) an open-access Si-waveguide microheater paper with full cross-section, heater material and resistivity, measured P_pi, plus an open source for the CP-04 hot-arm inputs. Each returned value is checked against the quoted locator before use.
3. Write one sim per example (s.2 table), materials additions, analytic references under `validation/mp/`, catalog-mp entries.
4. Validate every sim with the @amp/spec validator against the physics registry; record unregistered-type errors as expected until MC / MO / MT land (no workaround). Re-read DevLog-031..033 as they appear and align settings keys.

### 1.3 Examples (target list, DevLog-029 s.3.3)

| # | id (proposed) | chain | reference |
|---|---|---|---|
| 1 | nafems-t1-hotspot | heat -> elastic (plane stress) | CP-21 |
| 2 | nafems-le11 | heat -> elastic (axisym) | CP-02 |
| 3 | bimetal-strip | heat -> elastic (plane stress) | Timoshenko 1925 closed form |
| 4 | chip-warpage-2d | heat -> elastic (plane strain) | packaging-atlas case |
| 5 | joule-wire | currents -> heat (axisym) | CP-03 |
| 6 | hot-arm-actuator | currents -> heat -> elastic | CP-04 |
| 7 | si-microheater-to | currents -> heat -> em-modes (thermo-optic) | analytic dphi + paper P_pi (info) |
| 8 | tfln-mzm-eo | electrostatics -> em-modes (electro-optic) | CP-43 / CP-44 |
| 9 | pzt4-cube | elastic <-> electrostatics (piezo eigen) | CP-06 |
| 10 | ln-fbar-2d | elastic <-> electrostatics (piezo eigen 2D) | thickness-mode closed form |
| 11 | membrane-air | elastic <-> acoustics (eigen) | membrane closed form (uncoupled) |

## 2. Examples

All sims validate against the app registry except where s.5 lists an unregistered setting. Reference numbers: validation/mp/README.md (generated by `validation/mp/references.py`, run 2026-11-07 08:46 PST). "W" = Wentao's own COMSOL inputs (s.3). "VM" = public Ansys verification-manual input listing (cite_values + re_derive_setup, as for the existing CP cases).

### 2.1 Summary

| # | Sim | Chain (C11) | Dim | Reference | Sourcing | N/A or labelled |
|---|---|---|---|---|---|---|
| 1 | nafems-t1-hotspot | heat -> thermal-expansion -> elastic | 2D plane stress | CP-21: sigma_yy(D) 50 MPa | complete (CP-21) | k = 1 W/(m K) modelling choice (T uniform for any k) |
| 2 | nafems-le11 | heat -> thermal-expansion -> elastic | axisym | CP-02: sigma_zz(A) -105 MPa | complete (CP-02, atlas meridian) | Tref 0 C assumed (CP-02); k modelling choice (Q = -k/r reproduces T = r + z) |
| 3 | bimetal-strip | heat -> thermal-expansion -> elastic | 2D plane stress | Timoshenko 1925: kappa 0.03934 1/m, dw(L/4) 4.426 um | complete: W (t1, t2, T0, Tref, Al/Cu choice) + library (copper, aluminum-6061-t6) | L = 60 mm modelling choice; layer assignment modelling choice |
| 4 | chip-warpage-2d | heat -> thermal-expansion -> elastic | 2D plane strain | ECTC 2011 Table 3: 335 um (3D, with dies; qualitative); laminate 1.356 1/m | partial: geometry, E, CTE, temperatures from the paper | C4/UF height 55 um, nu of core / UF = atlas templates (labelled); Si nu derived (Hill); dies, build-up N/A |
| 5 | joule-wire | currents -> joule-heating -> heat | axisym | CP-03: T_center 488.672 K, T_surface 487.511 K | complete (CP-03) | sigma 1e6 S/m modelling choice (CP-03 fixes the heat generation only); V0 derived |
| 6 | hot-arm-actuator | currents -> joule-heating -> heat -> thermal-expansion -> elastic | 3D (6 boxes) | CP-04: tip 27 um (paper figure via VM223) | inputs complete via VM listing | informative: k(T), alpha(T), h(T), radiation, NLGEOM not representable (missing) |
| 7 | si-microheater-to | heat -> thermo-optic -> em-modes | 2D | Wang 2020: P_pi 8.5 mW measured (informative) | geometry, P, T_sink from the paper; library n, dn/dT, k; Ti k from HPL 1972 | heater as volume source (no 2D out-of-plane currents: R1); air dn/dT = 0 assumed; W, H_air modelling choices |
| 8 | tfln-mzm-eo | electrostatics -> electro-optic -> em-modes | 2D | CP-43: VpiL 4.06 V cm (paper simulation) | geometry via eo-modulator-atlas (paper); library LN n (1.957 um), eps^S, r^S | r at 633 nm used at 1957 nm; air = vacuum (assumption) |
| 9 | pzt4-cube | elastic <-> piezoelectric <-> electrostatics | 3D quarter | CP-06: 66.56 / 88.01 kHz short, 81.59 / 93.41 kHz open (measured) | complete via VM175 listing (Boucher 1981 cited) | c^E / eps^S convention not stated in the listing (assumed); C66 3.0 listed vs 3.05 derived by the 6mm form |
| 10 | ln-fbar-2d | elastic <-> piezoelectric <-> electrostatics | 2D plane strain | closed form TE1 6.6229 GHz, TS1 4.4327 GHz | W (geometry, electrodes, rotation, electrical BCs); LN tensors Warner 1967 via Weis-Gaylord 1985 + Ogi 2002 | plane strain excludes u_z (stated); air = vacuum |
| 11 | membrane-air | elastic <-> acoustic-structure <-> acoustics | axisym | uncoupled checks: plate f01 197.45 Hz, air column 11.34 kHz; coupled: none (informative) | W (all materials, dimensions, air) | axisym reduction of his 3D square model (a = Lx/2, offset cut dropped, rigid ends) |
| 12 | extras | - | - | - | - | none added: the other multiphysics topics in Wentao's folders need physics the engine lacks (s.2.13) |

### 2.2 nafems-t1-hotspot (CP-21)
- Inputs: quarter 10 x 10, r = 1 (CP-21 via atlas nafems-T1, Abaqus deck); E 100 GPa, nu 0.3, alpha 1e-5 / 0 (CP-21, Altair OS-V 0100); T 100 C, Tref 0 C (CP-21).
- Heat: T = 100 C on the outer edges, insulated symmetry edges -> uniform 100 C, equivalent to the benchmark load because alpha = 0 outside the spot.
- Evaluation: max of syy over the membrane (for a circular inclusion sigma_yy outside peaks at theta = 0, i.e. at D; atlas independent_check). Gate: 50 MPa, 1.5 % (CP-21).

### 2.3 nafems-le11 (CP-02)
- Inputs: meridian A, B, P4, P5, P7, I, H (atlas nafems-LE11 from FeenoX .geo); sphere radii 1.0 / 1.4; E 210 GPa, nu 0.3, alpha 2.3e-4 (CP-02); T = r + z C; uz = 0 at z = 0 and on the top face.
- Heat reproduces T exactly: T BC r + z on all boundaries, Q = -k / r (axisymmetric Laplacian of r = 1/r). Needs `model: axisym` (MT) and coordinate expressions in BC / source fields (registered as 'spacetime' fields).
- Open: Tref 0 C assumed (CP-02 missing).

### 2.4 bimetal-strip (W: 20241210_CTE_bending)
- W inputs: t1 = 1 mm, t2 = 3 t1, T0 = 313 K (temperature BC), heat Tref 293.15 K, materials Al and Cu, plane strain, secant CTE, free + rigid-motion suppression; layers 12 vs 24 mm wide (w1, w2 = 2 w1; sweep w1 6-30 mm).
- Used: t1, t2, T0, Tref, the Al / Cu pair. Changed (D): equal layer lengths L = 60 mm and plane stress so that Timoshenko's beam formula is the reference; half model with a roller at x = 0 and one pinned point.
- Values: Cu E 123.5 GPa, nu 0.35 (Ledbetter-Naimon 1974), alpha(293.15 K) 1.65707e-5 /K (NIST OFHC fit); Al 6061-T6 E 68.258 GPa (9.9e3 ksi), nu 0.33 (MIL-HDBK-5J), alpha(293.15 K) 2.26423e-5 /K (NIST 6061 fit). His COMSOL material-library values are not used.
- Reference: kappa = 0.039340 1/m; uy(L/4) - uy(0) = +4.4258 um.

### 2.5 chip-warpage-2d (advanced-packaging-atlas, ECTC 2011 Xilinx interposer)
- Research subagent (2026-11-07 08:30-08:33) over the atlas: no atlas case has sourced materials and a 2D-comparable reference; best candidate ectc.2011.5898527-b ("COC on pkg after C4 UF process", no lid). Runners-up: -b-m1 (chip-on-chip, -60.7 um), ectc51529.2024.00155 (JOINT2 120 mm, stiffener).
- Sourced (paper via atlas): substrate 42.5 mm, core 800 um, interposer 31 mm x 100 um, Table 2 RT values (core 18.9 GPa / 11 ppm in-plane; C4 UF 8.5 GPa / 32 ppm; Si 150 GPa / 3 ppm), stress-free 150 C, final 25 C, Table 3 warpage 13.2 mil.
- Labelled estimates: C4 + UF height 55 um (atlas template, analog paper), nu core 0.11 and UF 0.29 (atlas templates, other papers). Derived: Si nu 0.2231 (Hill average of Hall 1967 C).
- Reference: qualitative only (3D quarter model with dies, non-linear, T-dependent; warpage definition not stated). Laminate estimate 1.3555 1/m (dome), bow 306 um over 42.5 mm.

### 2.6 joule-wire (CP-03)
- Same inputs as sims/heated-wire.yaml; the heat source comes from currents (ground at z = 0, potential V0 at z = Lz). sigma 1e6 S/m (modelling choice), V0 = sqrt(q / sigma) Lz = 0.32715 V. Gate: CP-03 closed form.

### 2.7 hot-arm-actuator (CP-04)
- Subagent found the full input set in the public VM223 input listing (Hlp_V_VM223TXT.html, 2025R2): outline keypoints from D1..D9, D11 = 20 um, E 169 GPa, nu 0.3, rho_e 4.2e-4 ohm m (constant), k(T) and alpha(T) 300-1500 K, eight film-coefficient tables h(T), emissivity 0.7 to 300 K, anchors fixed and at 300 K, 15 V, NLGEOM. Correct citation: JMM 11(5), 452-462 (2001) (CP-04's "11:252" is the VM page's typo). Listing lines checked by MX.
- Written as six boxes (hex grid mesher, conforming interfaces), 300 K values only. Exterior remainders bnd:conn.xmin and bnd:cold.xmin cannot be selected alone (their ids select the interfaces through parent links), so they stay insulated (O4).

### 2.8 si-microheater-to
- Source: X. Wang et al., IEEE PTL 32(19) 1281 (2020), NSF public-access copy; reference device without thermal isolation (other candidates rejected by the subagent: Harris 2014 doped-Si heater without BOX / cladding thickness; Jacques 2019 behind a bot check; Sabouri 2021 metal not named).
- Inputs (paper; quotes checked by MX in the text layer of the NSF copy, 09:03): Si 450 x 220 nm, BOX 3 um, t_c 500 nm, Ti 1.5 um x 100 nm x 450 um, R 6.5 kOhm, substrate 300 um at 300 K, 1550 nm TE, P_pi 8.5 mW. Library: Si n 3.47669 and dn/dT 1.8181e-4 /K (Li 1980, 293 K), k 148 W/(m K) at 300 K (HPL 1972); SiO2 n 1.44442 (Malitson), dn/dT 8.162e-6 /K (Leviton-Frey 2006 at 293.15 K), k 1.38 (Corning); Ti k 21.9 W/(m K) at 300 K (HPL 1972 p.130 of the reprint, read by MX); air n (Ciddor), k (Kadoya).
- Chain: heat -> thermo-optic -> em-modes; heater Joule heat as a volume source P_h / (L_h w_h t_h) because the 2D currents module has only in-plane current (R1). thermo-optic settings: Tref = T_sink, power = P_h / L_h (MO's Ppi output).
- Optical window 4 x 3.5 um by `fragment`; Ti heater excluded from the optical domain (PEC boundary).

### 2.9 tfln-mzm-eo (CP-43)
- Geometry ported from eo-modulator-atlas sims/pan2021/config.yaml (f418495, as cited by CP-43; file unchanged at atlas HEAD 0546007, s.13): domain, layers, ribs (30 deg sidewall = atlas inference), electrodes, optical window, mirror plane x = -11.75 um, mesh sizes.
- Materials from this repo's library (not the atlas placeholders): LN n_o 2.19805, n_e 2.12648 at 1.957 um (Zelmon), eps^S 44.3 / 27.9, r^S (633 nm); SiO2 n 1.43911 (Malitson at 1.957 um), eps 3.9; Si eps 11.656; air n = eps = 1 (assumption: Ciddor fit ends at 1.69 um, air eps N/A).
- electro-optic settings per MO: armB mirror, mirrorX, terminal sig_t, crystals [{LN, cut x, propagation y}]. CP-44 (Arab Juneghani 2022) not written: its BOX and sidewall are atlas placeholders (CP-44 missing list); CP-43 has the paper-stated cross-section.

### 2.10 pzt4-cube (CP-06)
- Subagent found the Boucher 1981 constants as text in the public VM175 input listing (CP-06 had them as images on the results page); listing lines checked by MX. Quarter model 10 x 10 x 20 mm, rollers on x = 0, y = 0; two electrostatics physics (es_sc: both electrodes grounded; es_oc: top floating terminal) and two studies sharing the elastic physics. Eigen: 10 modes, shift 50 kHz (VM175 MODOPT range 50-150 kHz). Breathing modes by VM175 index (short 2, 5; open 4, 8; 1-based).
- Second PZT-4 set (VM231 listing, Parton et al. 1989 p.28) noted by the subagent, not used.

### 2.11 ln-fbar-2d (W: 20250927_LN_FBAR_gapped)
- W inputs (his 3D-slice piezo model in the folder): t = 100 nm slice (periodic y faces), w_dom 100 um, w_gap 50 um, w_metal 5 um, t_metal 500 nm, t_LN 500 nm, g_metal 1 um, t_air = w_gap; LN block z in [-t_LN, 0], air block centred, electrodes at x = +-(w_gap/2 + w_metal/2), z = g_metal + t_metal/2; Rotated System ZXZ (0, pi/2, pi/2) on the piezo material; electrostatics: Ground 1, Terminal 1 (charge, Q0 = 0), Zero Charge; mesh hmax 10 um, LN hmax t_LN/5 (swept 2 layers); studies: frequency domain and eigenfrequency (100 modes, shift typed by him; not used). LN and Al values are COMSOL library values: not used.
- Rotation derivation: R = Rz(0) Rx(pi/2) Rz(pi/2) maps crystal X -> global z, Y -> -x, Z -> -y; in the 2D frame (x, y, z) = (his x, his z, -his y): X -> +y, Y -> -x, Z -> +z, R = Rz(pi/2), euler (pi/2, 0, 0) in MT's ZXZ convention. So: X-cut plate, c axis out of plane, lateral field along crystal -Y; E_Y couples to S_XX through e21 = -e22 (drives the thickness-extension mode).
- LN tensors: c^E Weis-Gaylord 1985 Table 6 row [23] (Warner 1967, read from a page render by MX); e from Ogi 2002 Table III Warner column (page render read by MX); eps^S Table 1 row [23] (library); rho 4.628 g/cm3 (Weis p.194, text layer).

### 2.12 membrane-air (W: 20240922_mass_loaded_membrane_acoustics)
- W inputs (his mass-loaded membrane acoustics model in the folder): Lx = Ly = 20 mm, h_M 25 um (PEI: rho 1270, E 2.9 GPa, nu 0.44), steel mass cylinder R 2.5 mm, h_k 2 mm (rho 7860, E 210 GPa, nu 0.3) minus an offset cylinder r 1.5 mm at l0 0.5 mm, duct L 30 mm, air rho0 1.225, c0 340, f0 200 Hz (sweep parameter), ports at both ends, fixed membrane edge, eigen 5 modes around 1 Hz.
- Axisym reduction (D, modelling choices): a = Lx/2, centred mass without the offset cut, rigid tube and ends. Uncoupled references derived (Kirchhoff clamped plate; rigid air column).

### 2.13 Extras considered, not added (D)
- 20240813_microwave_oven (EM + heat): needs driven frequency-domain EM with losses; the engine has EM eigen only.
- 20250331_SAW_toy: solid mechanics only in his model (no piezo physics); 20241221_1D_PnC, 20250327_acoustic_taper_toy: solid only (by folder and file names; SAW_toy by modelinfo); 20240810_thermal_cryo, 20250208_egg_periodic_cooking: heat only; 20240709_gear_box: not opened. None adds a coupling the 11 sims do not already cover.

## 3. Wentao's COMSOL inputs read (inputs only)

Method: `unzip -p <file>.mph smodel.json | dmodel.xml` into the session scratchpad (outside the repo), parsed with Python (`python3 -I`) and grep; Results, solver-sequence, dataset and table branches skipped; nothing written to the NAS; nothing copied into the repo.

| Folder (<NAS>/COMSOL/) | File | Read | Not used |
|---|---|---|---|
| 20241210_CTE_bending | his bimorph solid + heat model | Parameters w1 12 mm, t1 1 mm, w2 = 2 w1, t2 = 3 t1, T0 313 K; Rectangles r1 (w1 x t1 at (0, t1/2)), r2 (w2 x t2 at (0, -t2/2)); materials Al, Cu (choice); Solid plane strain; heat Tref 293.15 K, Tinit 293 K; Temperature BC T0; Thermal Expansion (secant); parametric sweep w1 = range(6, 3, 30) mm; time-dependent list 0-0.2 s | material values (COMSOL library); domain-to-material map (Cu entities "3,1" not mappable from inputs) |
| 20250927_LN_FBAR_gapped | his 3D-slice piezo model | s.2.11 | LiNbO3 and Al values (COMSOL library); eigen shift |
| 20250927_LN_FBAR_gapped | Application Library model file | modelinfo.xml only: COMSOL Application Library "Thin-Film BAW Composite Resonator" (author COMSOL) | excluded (library content) |
| 20240922_mass_loaded_membrane_acoustics | his mass-loaded membrane acoustics model | s.2.12 (parameter table, Blocks, Cylinders, Difference inputs cyl1 - cyl2, physics feature list, study settings) | no solved data |
| 20240922_mass_loaded_membrane_acoustics | Application Library model file and its PDF | not opened (Application Library model and its PDF) | excluded |
| 20240922_mass_loaded_membrane_acoustics | two further models of his (toy, membrane only) | modelinfo.xml only | - |
| 20250331_SAW_toy | his SAW toy model | modelinfo.xml only (Solid mechanics only) | - |

## 4. Materials added (2026-11-07)
- `materials/titanium.yaml` (new): k(T) 250-600 K, Ho-Powell-Liley 1972 recommended values (reprint pdf p.130, read from a 200 dpi page render).
- `materials/linbo3-congruent.yaml`: rho was N/A -> 4.628 g/cm3 (Weis-Gaylord 1985 p.194, text layer), alternative Ogi 2002 4.636 g/cm3; new source `ogi2002`; `missing` entry now points to the located c^E (Weis Table 6) and e (Ogi Table III) values. No existing value changed.
- `materials/pzt-4.yaml`: one `missing` entry recording the VM175 listing values (not stored: vendor page, convention not stated). No value changed.
- Not storable in @amp/materials yet: stiffness of 6mm / 3m crystals and piezoelectric e (C is cubic-only there; e_piezo is an MT provisional registration). The tensors live as cited spec overrides in pzt4-cube and ln-fbar-2d.
- `node packages/materials/scripts/validate.ts`: 14 files, 14 valid, 0 issues (2026-11-07 08:59 PST).

## 5. Validator results (2026-11-07 09:00 PST, log `logs/MX-validate-20261107T090028.log`)

Scratch validator (session scratchpad): `validateSpec` of @amp/spec with (A) `physicsRegistry()` = the app / eval registry (includes MC, MO, MT registrations as landed by 09:00) and (B) A + `registerMaterialProperties` of @amp/materials; then `meshFromSpec` + `checkSelections` with the @amp/geom resolver.

| Sim | A (app registry) | B (+ materials props) | Mesh / selections |
|---|---|---|---|
| nafems-t1-hotspot | OK | OK | ok / all resolve |
| nafems-le11 | elastic settings.model 'axisym' not in the enum | same | ok / all resolve |
| bimetal-strip | OK | OK | ok / all resolve |
| chip-warpage-2d | OK | OK | ok / all resolve |
| joule-wire | OK | OK | ok / all resolve |
| hot-arm-actuator | OK | OK | ok (hex grid, 83k nodes) / all resolve |
| si-microheater-to | dndT not a registered property | OK | ok / all resolve |
| tfln-mzm-eo | n uniaxial tensor and r_eo not registered | OK | ok / all resolve |
| pzt4-cube | electrostatics registered for 2d / axisym only (3D piezo) | C hexagonal-6mm rejected (materials C = cubic only supersedes MT's provisional C) | ok / all resolve |
| ln-fbar-2d | OK | C trigonal-3m rejected (as above) | ok / all resolve |
| membrane-air | elastic settings.model 'axisym' not in the enum | same | ok / all resolve |

Not worked around (lane rule). Each is a registration owned by another lane (s.6).

## 6. Open items (requests to other lanes)
- R1 (MC): 2D currents with an out-of-plane drive (E_z = V / L, current along the waveguide) so the microheater chain can be currents -> heat -> em-modes. Until then si-microheater-to uses a volume source.
- R2 (MC, registrations): elastic `settings.model` enum lacks `axisym` (MT axisym path; nafems-le11, membrane-air); electrostatics dims lack `3d` (pzt4-cube, MT piezo 3D).
- R3 (MC / L10, registry): the app registry (`physicsRegistry()`) does not include the @amp/materials property registrations, so `dndT`, `r_eo` and uniaxial `n` overrides are rejected in the app although MO's couplings read them; with @amp/materials registered, its cubic-only `C` supersedes MT's provisional `C` (hexagonal-6mm, trigonal-3m). One registry with both is needed.
- R4 (L10 test): `packages/materials/test/library.test.ts` "sims/ outcomes unchanged" asserts that registering the material properties changes no sim's validation outcome; it now fails for ln-fbar-2d, pzt4-cube, si-microheater-to, tfln-mzm-eo, which use dndT / r_eo / tensor overrides (scratch replica, 2026-11-07 08:59). The invariant no longer holds once sims use material-registered properties; the coordinator decides (test change or registry change).
- O1: crystal-tensor override names follow MT's code (C, e_piezo, uniaxial eps_r = clamped eps^S; C66 derived for 6mm); `euler` given as ["pi/2", 0, 0] (dimensionless, radians), to be checked at the first run.
- O2: breathing-mode identification in pzt4-cube by VM175 index; check by mode shape.
- O3: rights: VM175 / VM223 listings are Ansys pages marked proprietary; only numeric inputs are cited (same treatment as CP-03 / CP-04 / CP-06).
- O4: geometry selection: an exterior remainder of a split box face (hot-arm conn.xmin, cold.xmin) cannot be selected without its interface pieces (parent links), so those faces carry no film coefficient.
- O5: Si dn/dT is the 293 K value only (Li 1980 Table 2); a T-dependent dn/dT of Si at 1550 nm is not in the library.
- O6: chip-warpage-2d stays qualitative until die thickness, build-up stack and Poisson ratios are sourced.
- O7: Wang 2020 P_pi values are for MZI switches (heater on one arm); the 8.5 mW reference device has no thermal isolation (p.1284).

## 7. Progress log
- 2026-11-07 08:25 PST: read DevLog-029, C3 / C10 / C11, sims, catalog, materials format, eval cases.
- 2026-11-07 08:26 PST: NAS mounted (`<NAS>`); listed candidate folders; read modelinfo of 6 models; CTE_bending inputs extracted (s.3).
- 2026-11-07 08:28 PST: plan written; three research subagents spawned (packaging atlas warpage; PZT-4 / LiNbO3 piezo tensors; microheater paper and CP-04 inputs).
- 2026-11-07 08:30-08:36 PST: subagent results in; LN tensors checked against page renders (Weis Table 6, Ogi Table III) and the text layer (Weis p.194); VM175 / VM223 listing lines checked; MC / MO / MT DevLogs and registrations read (keys aligned: Tref, power, armB / mirrorX / terminal / crystals, C / e_piezo / eps_r, euler).
- 2026-11-07 08:37-08:42 PST: FBAR 3D-slice and membrane inputs extracted; Ti k read from HPL 1972 (p.130 render); Leissa SP-160 not downloadable (anti-bot page), clamped-plate constant derived instead.
- 2026-11-07 08:45 PST: validation/mp/references.py written and run.
- 2026-11-07 08:47-08:58 PST: 11 sims written, each validated as written; fixes: provenance basis vocabulary, deformation item form, unit syntax in expressions (`120[um]`), split boundary pieces (sub.top#1), PZT tensors aligned to MT's 6mm form, study id clash.
- 2026-11-07 08:59 PST: materials (titanium new; LN rho; notes), materials validate 14/14; catalog-mp.ts filled (11 entries; tsc clean).
- 2026-11-07 09:00 PST: full validation log; DevLog sections 2-6.
- 2026-11-07 09:03 PST: Wang 2020 quotes checked in the text layer (p.1282 waveguide, BOX, t_c, heater; p.1283 substrate, 300 K; p.1284 R, P_pi).

## 8. Follow-up: MO request M1 (coordinator, 2026-11-07 09:05 PST)

| Item | Result | Where |
|---|---|---|
| (1) LN dn/dT, ordinary and extraordinary, 1550-2000 nm | N/A: no open primary found. Moretti et al., J. Appl. Phys. 98, 036101 (2005) (n_o, n_e at 632 and 1523 nm, 320-515 K) is paywalled and its CNR IRIS record has no file. Weis-Gaylord 1985 p.197 only cites refs [30]-[32] (no numbers in the review). Jundt 1997 (n_e only), Schlarb-Betzler 1993 and Edwards-Lawrence 1984 not openly reachable. Gayer 2008 is MgO-doped LN. arXiv 2601.00174 gives no numbers | `materials/linbo3-congruent.yaml` property `dndT: N/A` with this reason |
| (2) air n beyond 1.69 um | added: Mathar 2007 dry-air table 1.30-2.50 um (15 C, 101.325 kPa, 370 ppm CO2), refractiveindex.info Mathar-1.3.yml (CC0), every 5th row (0.05 um steps); primary not read | `materials/air.yaml` n alternative `mathar2007_ir`, source `mathar2007`; default n stays Ciddor (0.23-1.69 um) |
| (3) T of the thermal-oxide dn/dT | the value is a T-dependent fit, not a single temperature: Leviton-Frey 2006 Sellmeier of bulk Corning 7980 differentiated in T, valid 30-300 K and 0.4-2.6 um (yaml `vars`); the oxide film uses the bulk value (`analog_of: fused-silica`). Table 6 alternative = 295 K column. Sims evaluate it at 293.15 K | si-microheater-to provenance note added (heated cladding above 300 K is outside the fit range) |
| hot-arm exterior faces vs MG G1 (DevLog-036) | not resolved by G1: G1 adds parents for 2D difference-tool footprints (more parent links); the hot-arm case is the 3D box-grid mesher, where the exterior remainder `bnd:conn.xmin` shares its id with the parent of the interface pieces. G1 not landed at 09:07 either. Selections unchanged; O4 stays | - |

- tfln-mzm-eo: air n now 1.00027306 at 1.957 um (linear interpolation of the Mathar table, derived); air eps_r stays 1 (assumption).
- Materials validate 14 / 14 (09:06); tfln-mzm-eo and si-microheater-to validate OK under registry B (09:08).
- 2026-11-07 09:05-09:08 PST: follow-up done (web: one search, two page fetches, two GitHub fetches; rate-limited).

## 9. Follow-up: MT requests X1, X3 (coordinator, 2026-11-07 09:15 PST)

- X1 `sims/pzt4-cube.yaml`: MT's identification read (DevLog-033 s.4.3: breathing = electrically active modes; open circuit |V_top| > 1 %, short circuit = modes absent from the open spectrum; index 0 = f = 0 rigid z translation; same indices on three meshes). Adopted: short f1 / f2 = `solid.f_2` / `solid.f_7`, open f1 / f2 = `solid.f_4` / `solid.f_8`. `C` and `e_piezo` switched to `tetragonal-4mm` with C66 = 3.0e10 as printed in the VM175 listing ('TBDATA,16,3.0E10'); provenance and assumptions updated.
- X3 tensors written with sources and axis conventions, REJECTED by @amp/materials (C: cubic only; e_piezo not a property; no hexagonal-6mm / tetragonal-4mm symmetry; 25 issues). Not worked around. To keep `loadLibrary()` working for every other lane (it throws on any invalid file), `materials/pzt-4.yaml` and `materials/linbo3-congruent.yaml` were restored to their validated state and the complete updated files are staged under `validation/mp/pending-materials/` (header: copy over once MC registers C 6mm / 4mm / 3m and e_piezo, diff first):
  - pzt-4: rho 7500, eps_r uniaxial 804.6 / 659.7 (clamped assumed), C tetragonal-4mm 132 / 71 / 73 / 115 / 26 / 30 GPa, e_piezo e15 10.5, e31 -4.1, e33 14.1; basis `paper_model_input`, source `vm175` (Ansys listing citing Boucher 1981; primary paywalled, not read). Axis: poling = +z, signs as listed.
  - linbo3-congruent: C trigonal-3m 203 / 53 / 75 / 9 / 245 / 60 GPa (Weis-Gaylord Table 6 row [23], Warner 1967; Smith-Welsh row as alternative), e_piezo 3.7 / 2.5 / 0.2 / 1.3 (Ogi 2002 Table III Warner column). Axis convention: IRE 1949 (Proc. IRE 37, 1378), stated by Weis-Gaylord p.195 (+y and +z faces negative on compression); C14 positive as tabulated; Ogi states no convention, its e signs are consistent with Weis's d22 > 0 under IRE 1949. The IEEE 1978 / 1987 standard is not read here, so no conversion is made. rho and eps_r already in the file.
- Piezo sims stay on spec overrides (no `ref:` possible while the library cannot hold the tensors); the override values equal the staged entries.
- Validation (log `logs/MX-validate-20261107T091720.log`): all 11 sims OK against the current app registry (MC R2 landed: axisym elastic, 3D electrostatics, tetragonal-4mm). Materials 14 / 14 valid.
- 2026-11-07 09:15-09:18 PST: X1, X3 done as above.
- 2026-11-07 09:22 PST (coordinator, MT DevLog-033 F1): ln-fbar-2d orientation switched from `euler: ["pi/2", 0, 0]` to `crystals: [{material: LN, cut: x, propagation: z}]` (same rotation; MT: identical modes, max rel diff 1.6e-14); provenance key renamed to couplings.pz.settings.crystals. Validates OK against the app registry.

## 10. Follow-up: MC run fixes (coordinator, 2026-11-07 09:28 PST; MG G2 09:3x)

Runner: scratch script with MC's chain (validateSpec with `physicsRegistry()`, `prepareRun({spec, physicsId, studyId, level 0, hFactor 1})`, `runStudy`, sim evaluation tables through `apps/web/src/lib/results/adapter.ts` `evalTable`); results `logs/MX-run-20261107T093237.jsonl`; validation `logs/MX-validate-20261107T093357.log` (11 / 11 OK); materials 14 / 14 valid.

| Sim | Change | Result (default mesh) | Reference |
|---|---|---|---|
| ln-fbar-2d | `ref: materials/linbo3-congruent`; evaluations: group `ev_te` (steps first) with `f_te_active` = solid.f_18 (largest floating-terminal voltage among the 20 modes, MT's criterion), `V_te_active`, `f_te_piston` = solid.f_6 (largest centre thickness displacement); per-mode `uy_mid` kept as shape indicator | 20 modes 6.6033-6.6429 GHz (230570 dof); active 6.63845 GHz (+0.24 %), piston-like 6.61354 GHz (-0.14 %) | closed form TE1 6.6229 GHz (laterally infinite plate, u_z = 0) |
| membrane-air | new study `eig_vac` (solid only); groups `ev_air` (solid.f_2 = first f > 0), `ev_vac` | coupled 0, 0, 66.385, 1951.7, 2687.6 Hz; in vacuo 21.185, 761.87, 2104.3 Hz | plate without mass 197.45 Hz (closed form); the mass lowers it to 21.19 Hz, the closed air cavities raise it to 66.39 Hz |
| si-microheater-to | real chain: currents `eh` (heater only, `outOfPlane: {I: I_h}`), I_h = sqrt(P_h / R_h), R_h = 6.5 kOhm (paper p.1284), Ti sigma = L_h / (R_h w_h t_h) -> joule-heating -> heat -> thermo-optic -> em-modes; heat-source removed | P' = 18.8889 W/m (= P_h / L_h), E_z 16518 V/m, T_core 307.88 K, dneff 1.5515e-3, Ppi 9.435 mW (165949 dof) | measured P_pi 8.5 mW: +11 % (informative) |
| pzt4-cube | `ref: materials/pzt-4`; groups with `steps: first`; std_sc already first, note added (harness picks the first eigen study; open circuit = second study, own run) | short 65101.5 / 88146.3 Hz (-2.19 % / +0.16 %); open 79810.0 / 93584.3 Hz (-2.18 % / +0.19 %) (36448 dof) | CP-06 66560 / 88010 / 81590 / 93410 Hz, tol 3 % |
| hot-arm-actuator | h_side + `bnd:conn.xmin#1`, `bnd:cold.xmin#1` (exterior remainders after MG G2); validated only | - | - |
| materials | staged files copied into materials/ (pzt-4: rho, eps_r, C 4mm, e_piezo; linbo3-congruent: C 3m, e_piezo); stale description / missing lines updated; `validation/mp/pending-materials/` deleted | 14 / 14 valid | - |

- Air-loading direction (derivation, for the membrane): for a closed cavity much smaller than the acoustic wavelength (first plane-wave cavity mode 11.34 kHz >> 66 Hz) the pressure is uniform and p = -rho c^2 dV / V (the linear constitutive law the acoustics module uses), so each cavity adds a stiffness rho c^2 (int u_z dA)^2 / V_c per unit modal amplitude: frequency up. Air inertia adds mass: frequency down. Upper bound of the stiffening (rigid piston of the full area, both cavities): 2 rho c^2 A / L_c = 5.9e3 N/m with Wentao's rho0, c0 (estimate, derived). The runs show the net effect up: 21.19 -> 66.39 Hz.
- Adapter issue (to the results lane): `evalTable` fails with "Cannot read properties of null (reading 'value')" when a group mixes per-step rows with items that carry their own `steps: first` (both eigen sims); worked around in the specs by group-level `steps: first` (valid C10 usage, not an engine workaround). Groups of a study that the run did not solve also error in `evalTable` instead of returning per-cell errors.
- membrane-air: two f = 0 modes, both with membrane displacement; one zero mode expected (equal uniform cavity pressures); open with MT.
- FBAR / membrane mode indices are mesh-dependent; re-identify after a mesh change (stated in the sims).
- Materials test: `packages/materials/test/library.test.ts` "listNA covers every N/A" asserts `pzt-4` C is N/A; it now fails (21 / 22 pass) because C is sourced. Test owner (L10 / MC) to update the assertion (e.g. linbo3-congruent dndT is N/A).
- 2026-11-07 09:28-09:35 PST: done as above.

## 11. Follow-up: hot-arm mesh, GaAs material, MOM catalog entry (coordinator, 2026-11-07 09:40 PST)

- hot-arm-actuator: mesh.size.hmax D1/4 -> D1/2 (MT: converged; D1/4 = 840k dof). Run end to end from the spec (s.12).
- `materials/gaas.yaml` (new, R-MX1 of MOM): n = Skauli 2003 dispersion via refractiveindex.info Skauli.yml (CC0, sha256 4c7b62ff..., formula 1 = sellmeier-c2, 0.97-17 um, 22 C; n(1.32 um) = 3.402118, same as MOM's n_GaAs); rho 5317 kg/m^3, E 85.9 GPa, nu 0.31 = Baker et al. 2014 arXiv v1 Table 4 model inputs (basis paper_model_input, text layer read by MX, sha256 3c4930ba...); cubic C N/A (no primary read). Photoelastic p11 -0.165, p12 -0.140, p44 -0.072 at 1.15 um (Baker Table 2, citing the CRC Handbook 2012) recorded under `missing`: @amp/materials has no photoelastic property type (not worked around).
- `materials/silicon.yaml`: `missing` entry with the Si photoelastic values: Chan 2012 arXiv 1206.2099 p.2 (-0.094, 0.017, -0.051), axes [100] / [010], wavelength not stated there; Baker 2014 Table 2: -0.09, +0.017, -0.051 at 3.39 um citing Biegelsen 1974 (both secondary; same property-type gap).
- sims/gaas-microdisk-om.yaml (MOM's): GaAs -> `ref: materials/gaas` for rho, E, nu (identical); eps_r stays an override (n_GaAs^2 at 1.32 um). Its header line 1 still says "Staged here until ..." (MOM's text, not edited).
- catalog-mp.ts: MOM's entry added; all 12 entries now carry run outcomes (`RUN` = engine, log s.12; pass for the gated CP cases within tolerance on the default mesh, info otherwise).
- Materials 15 / 15 valid; all 12 sims validate (`physicsRegistry()`).

## 12. All multiphysics sims from the spec (2026-11-07 09:42-09:44 PST, `logs/MX-run-all-20261107T094211.jsonl`)

Scratch runner per sim and study: `validateSpec` (`physicsRegistry()`), `prepareRun({spec, studyId, level 0, hFactor 1})`, `runStudy`, the sim's evaluation tables through the results adapter. Default mesh, single level (no Richardson); time = prepare + solve wall time in Node (nice 10, BLAS threads 2).

| Sim | Chain | dof | Time (s) | Key number | Reference | Rel diff |
|---|---|---|---|---|---|---|
| nafems-t1-hotspot | heat -> elastic | 21710 | 0.5 | sigma_yy max in membrane 49.794 MPa | 50 MPa (CP-21, +-1.5 %) | -0.41 % |
| nafems-le11 | heat -> elastic (axisym) | 9261 | 0.5 | sigma_zz(A) -105.936 MPa | -105 MPa (CP-02, +-1 %) | +0.89 % |
| bimetal-strip | heat -> elastic | 58490 | 0.9 | uy(L/4) - uy(0) = 5.78973 - 1.36394 = 4.425796 um | Timoshenko 4.425796 um | -5.1e-9 |
| chip-warpage-2d | heat -> elastic | 239026 | 2.7 | bow over the interposer half-length 162.751 um (dome); at the substrate edge 280.644 um | laminate 162.833 um; ECTC 2011 335 um (3D, qualitative) | -0.05 % (laminate) |
| joule-wire | currents -> heat | 11778 | 0.4 | T_center 488.671945 K, T_surface 487.510590 K | CP-03 closed form | 2e-13, -2e-13 |
| hot-arm-actuator | currents -> heat -> elastic (3D) | 126125 | 9.9 | tip u_y -7.719 um (|u| 7.719 um), T_max 631.0 K, P 0.1482 W | 27 um (VM223 from paper Fig. 5) | -71 % (informative: 300 K k, alpha, h; no radiation, NLGEOM) |
| si-microheater-to | currents -> heat -> em-modes | 165949 | 4.4 | Ppi 9.435 mW (dneff 1.5515e-3 at 8.5 mW, T_core 307.88 K) | measured 8.5 mW (Wang 2020) | +11.0 % |
| tfln-mzm-eo | electrostatics -> em-modes | 345174 | 7.1 | VpiL 4.221 V cm, n_g 2.226 | 4.06 V cm (CP-43, +-10 %); n_g 2.276 | +3.96 %; -0.050 abs |
| pzt4-cube std_sc | elastic <-> electrostatics (3D) | 36448 | 15.7 | f1, f2 short 65101.5, 88146.3 Hz | 66560, 88010 Hz (CP-06, +-3 %) | -2.19 %, +0.15 % |
| pzt4-cube std_oc | elastic <-> electrostatics (3D) | 36449 | 16.3 | f1, f2 open 79810.0, 93584.3 Hz | 81590, 93410 Hz | -2.18 %, +0.19 % |
| ln-fbar-2d | elastic <-> electrostatics | 230570 | 9.8 | active 6.63845 GHz, piston-like 6.61354 GHz | TE1 closed form 6.62295 GHz | +0.23 %, -0.14 % |
| membrane-air eig | elastic <-> acoustics (axisym) | 111671 | 2.3 | coupled fundamental 66.385 Hz | in vacuo with mass 21.185 Hz (eig_vac); plate without mass 197.45 Hz | x 3.13 vs in vacuo (air stiffening, s.10) |
| membrane-air eig_vac | elastic (axisym) | 56369 | 1.1 | 21.185 Hz | - | - |
| gaas-microdisk-om | elastic <-> emw-axisym (optomechanical) | 23789 | 1.7 | f_o 223.892 THz; RBM1 mech.f_2 1.37540 GHz; g0 (opt 0, mech 2) MB -206.24 kHz, PE -168.02 kHz (g0 / 2 pi); x 2 pi = 1.296e6, 1.056e6 rad/s | Baker 2014 Table 3: 1.375 GHz; g0 geo 1.33e6, pe 1.21e6 rad/s | +0.03 %; -2.6 %, -12.8 % (PE frame crystal-avg vs Baker's cylindrical frame, DevLog-034 s.4) |

- MT's numbers confirmed from the spec: bimetal kappa rel -5.1e-9 (via the uy difference), chip-warpage bow 162.751 um vs laminate 162.833 um, hot-arm tip u_y -7.719 um at 126k dof.
- gaas-microdisk-om (MOM's sim): its evaluation item `fm` = `mech.f_0` reads the free disk's rigid mode (0 Hz); RBM1 is `mech.f_2` (1.3754 GHz). Not edited (MOM's file); reported to the coordinator.
- 2026-11-07 09:40-09:45 PST: s.11, s.12.

## 13. s.13 audit fixes (FC)

Lane FC (coordinator, 2026-11-07 10:14 PST): content items of the fresh-context audit of the uncommitted work, coordinator decisions given. Plan = the eight items below, in order; no edits under `packages/**` or `apps/web/src/lib/engine/**` (lane FE). Runs: scratch runner (s.10), nice 10, BLAS threads 2; results `logs/FC-run-20261107T101942.jsonl`; validation `logs/FC-validate-20261107T102135.log`.

- [x] 1. `sims/nafems-le11.yaml`: rounded points replaced by exact params `z4 = 1[m]/sqrt(2)` (P4 = (z4, z4), zbox height z4) and `r5 = sqrt(1.96 - 0.5)*1[m]` (P5 = (r5, z4)); P7, I, H written as z4 + 0.69 m / z4 + 1.09 m (atlas heights 0.345 + 0.345 + 0.400) so H-P4 stays vertical. Mesh: min angle 27.6 deg, min edge 0.010 m (was a 2.7e-6 m sliver edge, min angle 0.0041 deg). Rerun: sigma_zz(A) = -105.935 MPa vs -105 MPa (+0.89 %, CP-02 tol 1 %; was -105.94), 9224 dof; T(A) = 1.000 degC.
- [x] 2. Private references: s.1 convention line, s.1.1, s.2.11, s.2.12, s.3 table and s.7 progress line: model file names removed, NAS mount path -> `<NAS>`, folder column `<NAS>/COMSOL/`. bimetal-strip, ln-fbar-2d, membrane-air: header and every provenance source now "Wentao's model inputs, <NAS>/COMSOL/<folder> (inputs only)", no file names. ln-fbar-2d: the search-shift value typed in his model and the file name removed (the f_shift provenance note now says only that his shift is not used); `f_shift` was already the closed-form TE1 6.6229 GHz (validation/mp/references.json), unchanged. Rerun: active mode still index 18 at 6.638455 GHz (largest |V_term|, 3.4x the next, index 10), piston-like index 6 at 6.613536 GHz; 230570 dof. catalog-mp.ts tag 'Wentao COMSOL inputs' -> 'author model inputs' (3 entries). Grep of DevLog-035 and validation/mp for local absolute paths and model file names: clean.
- [x] 3. `materials/pzt-4.yaml`: id kept; `name` and `description` state "PZT-4, Boucher et al. 1981 data set as listed in Ansys VM175; differs from Berlincourt/Morgan PZT-4 datasheet values" (coordinator text).
- [x] 4. `sims/gaas-microdisk-om.yaml`: header states the convention (engine g0 / 2 pi in Hz, sign d omega / d alpha, negative for expansion; Baker 2014 |g0| in rad/s, its printed "GHz/nm" and "MHz" are angular rates per DevLog-034 F1; compare |g0| x 2 pi); no engine numbers in the header. g0 item labels carry the same convention. Stale `missing` entry replaced: GaAs is in materials/ (rho, E, nu); the photoelastic constants are not storable (no property type) and stay coupling settings with provenance.
- [x] 5. `sims/tfln-mzm-eo.yaml`: assumption added (clamped eps^S, r^S = RF basis as in the atlas and CP-43; DC stress-free basis would change VpiL, audit estimate about -4 %, not run). Atlas commit: `git log` of eo-modulator-atlas (read only) shows `sims/pan2021/config.yaml` last changed in f418495; 0546007 (atlas HEAD, a DevLog-only commit) has the identical file. Sim header and s.2 now cite f418495 as CP-43 does, noting the file is unchanged at 0546007.
- [x] 6. membrane-air zero-mode assumption: one f = 0 mode per closed cavity, two cavities (MT, DevLog-033 progress 09:38). chip-warpage-2d header: "positive = dome" marked as inference (the paper states no sign convention; atlas metric definition: negative = smiley face, p.2 text). Eval cases (`spec.ref` is the `ref` of the pending specRef form, schema `$defs.specRef`): CP-21 -> sims/nafems-t1-hotspot.yaml, CP-06 -> sims/pzt4-cube.yaml, CP-43 -> sims/tfln-mzm-eo.yaml. CP-04 stays `untestable`, reason rewritten: inputs located (VM223 listing, s.2.7), still untestable because the engine lacks k(T), alpha(T), h(T), radiation and NLGEOM; hot-arm-actuator runs informative (tip u_y -7.719 um vs 27 um). CP-06: status `untestable` -> `unvalidated` (the reason is resolved: constants in materials/pzt-4.yaml, 4/4 within 3 % in `logs/MX-run-all-20261107T094211.jsonl`); `untestable_reason: null`, the resolution recorded in `activation`. Loader: 85 cases, 0 errors, 0 warnings.
- [x] 7. catalog-mp.ts: pzt4-cube caseStatus 'untestable' -> 'unvalidated' (as the other passing CP entries). Titles aligned with the sims: hot-arm-actuator and gaas-microdisk-om catalog titles = sim titles; si-microheater-to: the sim title was stale ("heat -> optics" before the currents chain of s.10), so the sim title now reads "(currents -> heat -> optics)" = the catalog title. FE's modal-mass quadrature fix read in `packages/physics/src/optomech/axisym.ts` (`modalMass` uses triRule(5), 10:17 file time); gaas-microdisk-om rerun: f_o 223.8917 THz, RBM1 mech.f_2 1.375399 GHz, m_eff 4.0389e-15 kg, x_zpf 1.2291e-15 m (Baker 1.23e-15), g0 / 2 pi MB -206.240 kHz, PE -168.019 kHz, total -374.259 kHz; |g0| x 2 pi = 1.2958e6 / 1.0557e6 rad/s vs Baker 1.33e6 / 1.21e6 (-2.6 %, -12.8 %, PE frame difference as in s.12); unchanged from s.12 to the printed digits (the disk cells are straight-sided). New `RUN_FC` record (log `logs/FC-run-20261107T101942.jsonl`) for gaas-microdisk-om and nafems-le11 (its geometry changed in item 1). tsc on catalog-mp.ts clean.
- [x] 8. CONTRACTS-v0.md C11: `optomechanical` row (MOM, DevLog-034); index.ts rule lists OPTOMECH; table `dndT` and "nodal V (E = -grad V at quadrature points)"; MC 08:46 entry corrected (notes concatenated and de-duplicated, not prefixed; only `normalization` prefixed `<ids joined by +>: <text>`, per driver.ts 288-291); changelog entry "2026-11-07 10:21 PST, coordinator, audit fixes" incl. the mode-study wavelength rule for single-physics mode studies (prepare.ts) and the electro-optic one-terminal limit (driver.ts studyReadiness).

Validation at the end: all 48 sims validate (`validateSpec` with `physicsRegistry()` + material properties) and mesh with all selections resolving; materials 15 / 15 valid (`packages/materials/scripts/validate.ts`); eval cases 85 loaded, 0 errors, 0 warnings.

Open (not in FC scope, for the coordinator): CP-04 `missing` and CP-06 `materials` / `missing` lists still describe the pre-resolution state, and the `spec.reason` texts of CP-04, CP-06, CP-21, CP-43 still say the sims are not yet published; the eval case files are generated by `validation/c/build_cases.py` / `validation/a/build_cases.py`, so a regeneration would revert items 6 unless the builders are updated.

- 2026-11-07 10:14 PST: start; items 1-5 edited, LE11 rerun.
- 2026-11-07 10:19 PST: FE quadrature fix seen in axisym.ts; LE11, ln-fbar-2d, gaas-microdisk-om rerun (`logs/FC-run-20261107T101942.jsonl`).
- 2026-11-07 10:21 PST: items 6-8; full validation (`logs/FC-validate-20261107T102135.log`).
