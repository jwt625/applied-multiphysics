# DevLog-062: photonics examples, part 2 (lane G5, chunk 3)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | G5 (DevLog-037 s.4.2), chunk 3 |
| Owns | new `sims/<id>.yaml` of this lane; appends to `apps/web/src/lib/library/catalog-driven.ts` and `catalog-modes.ts`; new `validation/c/cases_ext/photonics2.py`; WO-82 / WO-83 entries of `validation/c/cases_ext/modes.py`; new `validation/photonics2/**`; new `eval/expected/<own ids>.json`; `eval/cases/c/<own ids>.yaml` (builder output); this file |
| Status | done 2026-11-18 (s.4-7): WO-74, WO-86, WO-88 gated, WO-89 informative, WO-82 / 83 second reference gated; WO-87 not built (R1) |
| Read | CLAUDE.md; DevLog-037 s.4.1-4.2; DevLog-047; DevLog-048; DevLog-042 s.1; DevLog-043; `sims/tfln-mzm-eo.yaml`, `sims/si-microheater-to.yaml`, `sims/tfln-rib-air.yaml`, `sims/si-slab-tm0.yaml`; `packages/physics/src/couplings/photonic.ts`; `packages/physics/src/modes/coupled.ts` (inputs); `packages/physics/src/wave2d/kernel.ts` (ports in PML); `validation/c/cases_ext/{README.md,modes.py}`; `packages/eval/src/loader.ts` (expected-file rule); eo-modulator-atlas (read only, HEAD 0546007) `validation/cases/K4.yaml`, `validation/reference/{K2,K3}-tidy3d.json`, `K4-es-eo.json` |

Conventions: F = fact read from code, a source or a run; D = decision (reason given); E = estimate; O = open item; R = request.

## 1. Plan (2026-11-18 18:40 PST, before coding)

### 1.1 Facts that shape the plan
- F: the eval loader ties every `expected.file` of a case to `eval/expected/<ID>.json` (loader.ts semanticChecks). WO-82 / WO-83 expected files are written by `validation/modes3/references.py` (lane E2 file, not mine). D: the second (Tidy3D) reference of WO-82 / WO-83 goes in as inline values without `expected` (allowed: several class-c cases have none), with the atlas file sha256 in the provenance and a check script `validation/photonics2/atlas_tidy3d.py` that re-reads the atlas file and asserts the inline values.
- F: atlas `K2-tidy3d.json` / `K3-tidy3d.json` (2026-10-14, re-extrapolated 2026-10-15): Tidy3D 2.12.0 local FD mode solver, staircase, no subpixel, PEC window, 3 levels (25 / 12.5 / 6.25 nm core cells), observed-order extrapolation with a GCI band U (factor 1.25). K2 n_eff 1.89424 (U 4.2e-3), n_g 2.29092 (U 6.0e-4); K3 n_eff 1.91248 (U 3.7e-3), n_g 2.26498 (U 2.2e-4). The atlas marks them `sanity_only_not_a_gate`.
- F: `em-modes` accepts one electro-optic and any number of thermo-optic inputs together (modes/coupled.ts lines 234-237, 397): the combined thermo-optic + electro-optic chain is supported by the couplings.
- F: `materials/linbo3-congruent.yaml` has `dndT: N/A` (no open primary source, 2026-11-07) and no thermal conductivity `k`. The research subagent of this lane (2026-11-18) found no open primary dn/dT source for congruent LN near 1550 nm (Moretti 2005, Schlarb-Betzler 1993, Jundt 1997, Gayer 2008 paywalled); one secondary statement without citation (arXiv 1806.04755: dn_e/dT 3.34e-5 /K, dn_o/dT 0); LN k only for stoichiometric LN (Zhou et al., Phys. Rev. Materials 10, 094607 (2026), FDTR 4.0 +- 0.8 W/(m K) in-plane).
- F: emw-2d ports may lie in a PML that stretches along the port tangent (kernel.ts: complex port mode problem); a port inside a PML stretching along its normal is an error. Modes are sorted by Re(beta^2): a Si substrate in the port cross-section would put substrate modes (n up to 3.47) ahead of the guided TE0 (2.83).
- F: post expressions take field components (`<phys>.<field>.<comp>`) and `d(f, y)`; evaluations integrate over cut lines; the harness reads evaluation items through the `result` extract (web results adapter).

### 1.2 Items, ids, references
| Id | Sim | Reference (independent, citable) | Gate plan |
|---|---|---|---|
| WO-82 / WO-83 (added targets) | existing `tfln-rib-air`, `tfln-rib-oxide` | atlas Tidy3D FD mode solver, extrapolated, with its GCI band U | n_eff and n_g gated on both levels with tolerance = U of the reference (its stated 95 % band; basis stated); TE fraction informative |
| WO-86 | `sims/tfln-mzm-pushpull.yaml`: two x-cut LN ribs in the gaps of a GSG line (Au 0.8 um on the slab, gap 5 um, signal 20 um), single-ended drive, push-pull by geometry | atlas canonical push-pull case (validation/cases/K4.yaml) reference `K4-es-eo.json`: scikit-fem P2 electrostatics + vector FEM N2/P2 arm modes + first-order Pockels, 3 levels, VpiL 2.27860 V cm (U 5.4e-4) | VpiL and dn/dV on two levels; tolerance from the measured level errors with margin (recorded) and >= the reference U |
| WO-87 | thermo-optic + electro-optic TFLN phase shifter | none: LN dn/dT and k missing (s.1.1) | not built: request R1 (materials) with the candidate sources; the chain itself is supported |
| WO-74 | `sims/si-grating-coupler-2d.yaml`: uniform SOI grating, side view, TM (E out of plane = chip TE), port on the input waveguide, PML top / bottom | Taillaert et al., Jpn. J. Appl. Phys. 45, 6071 (2006), Fig. 3 "power up" (2D eigenmode expansion with PML): 220 nm Si n 3.47, BOX 1 um n 1.44, Si substrate, air top, period 630 nm, etch 70 nm, fill 0.5, TE; digitized | upward fraction P_up / P_in at several wavelengths; tolerance = reading resolution + an allowance for the unstated number of periods (estimated from this model's residual transmission, labelled) |
| WO-88 | `sims/si-slot-slab.yaml`: 1D slot (five layers: SiO2 / Si / slot / Si / SiO2), x-invariant window as in `si-slab-tm0` | exact multilayer slab dispersion relation (own script, transfer matrix, mpmath vs scipy); geometry and indices from the slot patent (US 7519257: rails 220 nm, slot 100 nm, n 3.48 / 1.44 at 1.55 um) | n_eff on two levels (analytic, tight) |
| WO-89 | `sims/sin-strip.yaml`: 1.0 um x 300 nm LPCVD SiN on oxide, oxide clad | Munoz et al., Sensors 17, 2088 (2017) measured TE n_g 1.892 (OFDR) | informative (measured; fabricated dimensions and film indices differ) |

### 1.3 Gate rule
Same as DevLog-047 / 048: each gated quantity on two nested levels (h_factors [1, 0.5]) as two targets, the finer level with an equal or tighter tolerance; tolerance basis stated per target.

### 1.4 Order of work
WO-82 / 83 Tidy3D targets; WO-86; WO-88 (fast, analytic); WO-74; WO-89; WO-87 request; catalog entries; builder, CLI, tests; hand-off.

## 2. TODO
- [x] WO-82 / WO-83 second reference (inline Tidy3D targets, check script)
- [x] WO-86 push-pull TFLN VpiL sim, reference script, case
- [x] WO-88 slot slab, analytic reference, case
- [x] WO-74 grating coupler, digitized reference, case
- [x] WO-89 SiN strip (informative)
- [x] WO-87 combined thermo-optic + electro-optic: request R1 (not built: material data)
- [x] catalog entries; builder; test_build_matches; CLI per case; spec + materials tests
- [x] results table, requests, open items, hand-off

## 3. Progress log
- 2026-11-18 18:13 PST: read the brief files.
- 2026-11-18 18:16-18:35 PST: read-only research subagent (2D grating coupler references, slot references, LN thermal data); sources in s.1.1 / 1.2; downloads kept in the session scratch (not tracked).
- 2026-11-18 18:40 PST: plan written (s.1).
- 2026-11-18 18:38-18:39 PST: WO-82 / WO-83 Tidy3D targets (`TIDY3D` inline values and `tidy3d_refs` in `cases_ext/modes.py`, check script `validation/photonics2/atlas_tidy3d.py`: values and sha256 ok); CLI WO-82 8/8 pass + 4 info, WO-83 8/8 pass + 4 info (`logs/G5-cli-wo82-83-*.log`).
- 2026-11-18 18:41-18:52 PST: `sims/tfln-mzm-pushpull.yaml` (atlas push-pull case geometry; electrodes are air in the optical window; mesh-only window around rib B so the mirrored arm samples an equally fine field). Level 0 161k DOF 22 s 0.59 GB; level 1 646k DOF 179 s 1.46 GB RSS (`logs/G5-k4-L0-*.log`, `logs/G5-k4-L1-*.log`). `validation/photonics2/k4_reference.py` -> `eval/expected/WO-86.json`. First CLI: loader error (gold material entry without `source`), then a harness timeout (default 120 s with no speed budget): D: `speed.budget_s.native` 240 s, measured, which also sets the wall-clock limit (20 x budget per level, capped at 600 s). WO-86 6/6 pass.
- 2026-11-18 18:49-18:59 PST: `validation/photonics2/slot_slab.py` (five-layer slab, TM; mpmath vs scipy 4e-16; checked against the WO-01 symmetric-slab closed form with the slot set to 0: identical to 1e-15) -> WO-88.json; `sims/si-slot-slab.yaml`; patent dimensions and inventor list verified on the patent page (2026-11-18). Levels: -9.6e-7, -6.2e-8, -3.9e-9 (order 4). WO-88 2/2 pass.
- 2026-11-18 18:53-19:01 PST: grating coupler. F: a port whose cross-section crosses the top / bottom PML returned "fundamental mode not propagating" (complex port problem, mode ordering by Re(beta^2)); D: ports cover only the non-PML layers (PML ends are natural walls). F: a `global` evaluation cannot reference another evaluation item and a field expression cannot reference the scalar `w.P_in`; D: port power fixed at 1 W/m (P_up in W/m is numerically the fraction); the harness divides by `P_in` through an `expr` extract. Core polygon from `validation/photonics2/grating_polygon.py` (edges e0 / e1 / e2 independent of the period count). Digitizer `validation/photonics2/digitize_taillaert.py` (600 dpi render; y ticks fitted to 1.0e-4, x ticks within 0.5 px; legend box excluded; curve tracked from 1620 nm down). Period-count study (`logs/G5-gc-Nstudy-*.log`): s.4.3. Poynting balance on a closed rectangle added as the gate (exact property). WO-74 4/4 pass + 10 info.
- 2026-11-18 19:01-19:04 PST: `sims/sin-strip.yaml` (library Si3N4 Luke 2015 and SiO2 Malitson with dispersion); Munoz et al. 2017 values re-read on PMC (2026-11-18): stack s.3.1, n_g s.3.4, guide type of the measurement not stated. WO-89 2 info (case pending: no gated target, by design).
- 2026-11-18 19:04 PST: catalog entries (`catalog-driven.ts`: 1; `catalog-modes.ts`: 3); final CLI over WO-74, WO-80..86, WO-88, WO-89 (`logs/G5-cli-final-20261118T190421.log`).

## 4. Results (F, 2026-11-18; Node v23.7.0, Apple M4 Pro, nice 10, other lanes running; levels h_factors [1, 0.5])

### 4.1 Gate table
| Case / sim | Quantity | Reference (locator, date) | Level 0 | Level 1 | Tolerance L0 / L1 (basis) | Result |
|---|---|---|---|---|---|---|
| WO-82 tfln-rib-air | n_eff TE0 | Tidy3D 2.12.0 FD mode solver, extrapolated 1.894239 (U 4.2e-3); atlas `validation/reference/K2-tidy3d.json` key extrapolated (2026-10-14 / 10-15) | -7.1e-5 | -7.1e-5 | abs 4.2e-3 / 4.2e-3 (reference band U) | pass |
| | n_g TE0 | same, 2.290919 (U 6.0e-4) | -7.4e-5 | -7.0e-5 | abs 6.1e-4 / 6.1e-4 (U) | pass |
| | TE fraction | same, 0.990393 | +2.1e-4 | +2.1e-4 | info | info |
| WO-83 tfln-rib-oxide | n_eff TE0 | Tidy3D, 1.912481 (U 3.7e-3); `K3-tidy3d.json` | -1.07e-4 | -1.06e-4 | abs 3.7e-3 (U) | pass |
| | n_g TE0 | Tidy3D, 2.264982 (U 2.2e-4) | +4.3e-5 | +4.6e-5 | abs 2.3e-4 (U) | pass |
| | TE fraction | Tidy3D 0.993961 | +2.7e-5 | +2.8e-5 | info | info |
| WO-86 tfln-mzm-pushpull | VpiL (push-pull, full terminal voltage) | atlas push-pull case `K4-es-eo.json` extrapolated 2.278604 V cm (U 5.4e-4) | 2.274822 V cm (-1.66e-3 rel) | 2.276937 V cm (-7.3e-4 rel) | rel 3e-3 / 1.5e-3 (measured errors x ~2) | pass |
| | dn_eff/dV right arm | same, -1.700479e-5 /V (U 5.5e-9) | +1.73e-3 rel | +8.1e-4 rel | rel 3e-3 / 1.5e-3 | pass |
| | n_eff right arm | atlas `K2-fem.json` extrapolated 1.894167067 | +2.3e-7 | +4.8e-7 | abs 1e-6 / 1e-6 (as WO-82) | pass |
| WO-88 si-slot-slab | n_eff slot mode | exact five-layer slab (`slot_slab.py`) 2.328990313466 | -9.6e-7 | -6.2e-8 | abs 2e-6 / 1.5e-7 (measured x ~2) | pass |
| WO-74 si-grating-coupler-2d | n_eff input-waveguide mode (port) | exact slab with the port walls (`gc_reference.py`) 2.824653303 (paper p.6072: 2.83) | -1.1e-5 | -7.4e-7 | abs 3e-5 / 3e-6 (measured x ~3) | pass |
| | Poynting balance (closed rectangle) / P_in | 0 (exact) | 2.5e-3 | -5.6e-4 | abs 5e-3 / 1.5e-3 (measured x 2-3) | pass |
| | upward fraction at 1540 / 1550 / 1570 / 1600 / 1610 nm | Taillaert 2006 Fig. 3 digitized 0.4506 / 0.4578 / 0.4672 / 0.4613 / 0.4511 | 0.4641 / 0.4712 / 0.4828 / 0.4873 / 0.4805 | 0.4630 / 0.4700 / 0.4817 / 0.4863 / 0.4796 | info | info |
| WO-89 sin-strip | n_g TE0 at 1555 nm | Munoz 2017 s.3.4 measured 1.892 (OFDR), 1.90-1.92 (MZI) | 1.94981 | 1.94981 | info | info |

Tolerance decisions (D): from the measured level errors with a margin of 2-3 where the reference is exact or converged (WO-74 n_eff and balance, WO-86, WO-88; same rule as DevLog-048 D1); the reference's own uncertainty band where the reference is coarser than the engine (Tidy3D U). The WO-86 / WO-88 / WO-74 tolerances were set after the level runs (recorded here, as in DevLog-047).

### 4.2 Reading of the informative items
- WO-74 upward fraction: the model is 0.012-0.029 above the digitized curve (larger at long wavelength). The paper does not state the number of periods. Period-count study of this model, level 0 (`logs/G5-gc-Nstudy-*.log`): 1550 nm: 0.451 / 0.465 / 0.469 / 0.471 / 0.472 for 15 / 20 / 25 / 30 / 40 periods (T 0.043 / 0.015 / 0.005 / 0.0018 / 0.0002); 1600 nm: 0.458 / 0.475 / 0.484 / 0.487 / 0.489. The paper's values fall inside the 15-20 period range of this model; with the period count unknown, a gate would only test that assumption, so the comparison stays informative. Reflection near the second-order Bragg wavelength: |S11|^2 0.51 at 1640 nm, 0.48 at 1645 nm (paper's dotted curve peaks at about 0.43 near 1645 nm, read by eye, not digitized).
- WO-89: the model n_g 1.950 is 3 % above the OFDR value and 1.6-2.6 % above the MZI range; measured guide type (strip or 150 nm rib), film indices (paper: SiN 2.01, oxides 1.464 / 1.45) and dimensions differ from the library-based model.
- WO-82 / 83: the engine agrees with the Tidy3D extrapolation to 4e-5..1.1e-4, well inside the reference's band (the FD solver converges at first order, its finest level is 3.4e-3 from its extrapolation).

### 4.3 Thermo-optic + electro-optic phase shifter (WO-87, not built)
- F: the chain is supported (em-modes takes one electro-optic and any thermo-optic inputs; with `armB: mirror` the heated field is mirrored, so a heater on one arm needs `armB: none` or `ideal`).
- F: missing data: LN dn/dT (`materials/linbo3-congruent.yaml` dndT N/A) and LN thermal conductivity (no `k`). No open primary source found by this lane (s.1.1). Request R1. No other library material has `r_eo`.

## 5. Requests (exact)
- R1 (materials lane / coordinator; `materials/linbo3-congruent.yaml`): add `k` and `dndT` for congruent LN from primary sources. Candidates found 2026-11-18: dn/dT: L. Moretti et al., J. Appl. Phys. 98, 036101 (2005), doi 10.1063/1.1988987 (n_o, n_e at 1523 nm, 320-515 K; paywalled); U. Schlarb, K. Betzler, Phys. Rev. B 48, 15613 (1993) (paywalled); a secondary open statement without citation: arXiv 1806.04755 (Laser Photonics Rev., doi 10.1002/lpor.201800228): dn_e/dT 3.34e-5 /K, dn_o/dT about 0 at room temperature in the telecom band (not primary; not used). k: W. Zhou et al., Phys. Rev. Materials 10, 094607 (2026), arXiv 2607.01673: stoichiometric LN, FDTR 4.0 +- 0.8 W/(m K) in-plane (open; composition differs); congruent LN: Bashir et al., J. Alloys Compd. 1008, 176549 (2024) (CC-BY, publisher returned 403 to this lane's fetch; a manual download would settle it). With both properties the combined sim is: the WO-86 cross-section plus a heater strip above one arm, heat (Si substrate sink) -> thermo-optic + electrostatics -> electro-optic into one em-modes, `armB: none`.
- R2 (catalog, coordinator; `apps/web/src/lib/library/catalog-modes.ts`, entries of lane E2): the `tfln-rib-air` / `tfln-rib-oxide` refs now read `targets: '4/4 gated (+2 info)'`; with the second reference they are `'8/8 gated (+4 info)'` and the note can add "; second reference: Tidy3D finite-difference mode solver (within its uncertainty band)". Log: `logs/G5-cli-final-20261118T190421.log`.
- R3 (kernel note for the wave2d owner, not blocking): a port whose cross-section crosses a PML that stretches along the port tangent is accepted by the kernel, but with substrate-free layers it returned "fundamental mode not propagating" in this geometry (air PML above, oxide PML below). E (not checked in the kernel): the complex port problem is ordered by Re(beta^2), and PML-type modes may precede the guided mode. Repro: `sims/si-grating-coupler-2d.yaml` with the ports selecting also `bnd:pmlt.left`, `bnd:pmlbl.left` (and the `.right` counterparts). Suggest: pick the incident mode by the largest Re(beta) among modes whose field is concentrated outside the PML, or allow `excite` to name a mode index; until then ports should end at the PML.
- R4 (results / post owner, not blocking): a `global` evaluation item cannot reference another evaluation item (e.g. `P_up / w.P_in`), and field expressions cannot read solution scalars (`w.P_in`); normalised flux results need a fixed port power. Suggest: allow solution scalars in integrand expressions.

## 6. Open items
- O1 WO-74 gate on the paper curve: needs the period count of the published simulation (not in the paper; Taillaert 2004 PTL or the thesis may state it).
- O2 WO-87 (thermo-optic + electro-optic) waits for R1.
- O3 Slot waveguide in 2D (rails 220 x 250 nm, the patent's FIG. 1): no non-COMSOL published value found (Almeida 2004 and Xu 2004 full texts not open; Dell'Olio and Passaro 2007 used COMSOL); the 1D slot is gated instead.
- O4 WO-89 stays informative (measured).
- O5 WO-86 level 1 is 646k DOF, 1.46 GB RSS, 3 min: the heaviest of this lane's cases.

## 7. Hand-off
- Files: sims `tfln-mzm-pushpull`, `si-slot-slab`, `si-grating-coupler-2d`, `sin-strip`; `apps/web/src/lib/library/catalog-driven.ts` (1 entry), `catalog-modes.ts` (3 entries); `validation/c/cases_ext/photonics2.py` (WO-74, WO-86, WO-88, WO-89); `validation/c/cases_ext/modes.py` (WO-82 / WO-83: `TIDY3D`, `tidy3d_refs`); `validation/photonics2/{common,atlas_tidy3d,k4_reference,slot_slab,gc_reference,grating_polygon,digitize_taillaert}.py`, `validation/photonics2/taillaert2006_fig3.json`, `sin_reference.py`; `eval/expected/{WO-74,WO-86,WO-88,WO-89}.json`; `eval/cases/c/{WO-74,WO-82,WO-83,WO-86,WO-88,WO-89}.yaml` (builder output).
- Regenerate: `cd validation && uv run python photonics2/<script>.py` (k4_reference and atlas_tidy3d read the sibling atlas; digitize_taillaert needs the 600 dpi render of the author copy, not committed); then `uv run python c/build_cases.py` and `uv run python c/test_build_matches.py`.
- Ids: WO-74, WO-86, WO-88, WO-89 used; WO-87 reserved (thermo-optic + electro-optic); WO-75..79 free.

## 8. Final checks (2026-11-18 19:10 PST)
- CLI (`logs/G5-cli-final-20261118T190421.log`): WO-74 4/4 pass + 10 info; WO-80 6/6; WO-81 4/4; WO-82 8/8 + 4 info; WO-83 8/8 + 4 info; WO-84 2/2 + 6 info; WO-85 8/8 + 10 info; WO-86 6/6; WO-88 2/2; WO-89 2 info (pending: no gated target). 0 fail, 0 error, 0 timeout.
- `pnpm --filter @amp/spec test` 65/65 (live sims test passes with the 4 new sims); `pnpm --filter @amp/materials test` 38/38.
- `uv run python c/build_cases.py` then `c/test_build_matches.py`: 66 class-c cases, 0 differing. F: the builder run also rewrote files of other lanes' modules from their current state (PK-02, PK-06 show as modified in git status; not edited by this lane).
