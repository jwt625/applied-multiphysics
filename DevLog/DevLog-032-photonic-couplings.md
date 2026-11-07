# DevLog-032: photonic couplings, thermo-optic and electro-optic into em-modes (lane MO)

| Field | Value |
|---|---|
| Date | 2026-11-07 |
| Lane | MO (DevLog-029 s.3.2; contract C11) |
| Owns | `packages/physics/src/modes/**`, `packages/physics/src/couplings/photonic.ts`, tests of these (`packages/physics/test/photonic*.test.ts`), `validation/mo/**`, this file |
| Parallel | MC (DevLog-031: driver, core.ts, prepare.ts, registrations.ts), MT (033), LP (030), MX (035: sims, materials) |
| Read | DevLog-029 s.2.3, 3.1-3.3; CONTRACTS-v0 C1, C4, C5, C11; `packages/physics/src/modes/*`; `couplings/core.ts`, `driver.ts` (MC, as landed 08:35); `packages/materials/src/{properties,library}.ts`; `materials/{linbo3-congruent,silicon,fused-silica}.yaml`; eval cases CP-43, CP-44; eo-modulator-atlas (read only) `engine/src/{eo-overlap,materials,vector-mode}.mjs`, `sims/{pan2021,arabjuneghani2022}/config.yaml`, DevLog-026 S1 table |
| Status | wave 1 done: couplings, tests and gates pass (s.6); requests to MC / MX open (s.4) |

Conventions: "F" = fact read from code, files or a run; "D" = decision of this lane (reason given); "O" = open item.

## 1. Plan (2026-11-07 08:36 PST)

### 1.1 Facts (F)
- The mode kernel (`modes/vector-mode.mjs`, port of the atlas solver) takes a per-triangle permittivity tensor `[xx, xy, yy, zz]` (eps_xz = eps_yz = 0), an `epsDelta` per triangle for a direct re-solve, and `vectorPerturbation(model, mode, dEps, lambda)` for the first-order (Hellmann-Feynman) change of n_eff with dEps per triangle or per quadrature point (6 points, TRI_Q4). Kernel test G9 already gates the perturbation against a closed form.
- Material property names already registered by `@amp/materials` (CONTRACTS changelog 2026-11-06 16:21): `dndT` (1/K, scalar or uniaxial perp/par) and `r_eo` (m/V, trigonal-3m r13 r22 r33 r51). C11 writes `dn_dT`; the registry name is `dndT` (used here; C11 text to be corrected by the coordinator).
- `materials/linbo3-congruent.yaml` has n (uniaxial, Zelmon 1997 Sellmeier), eps_r (uniaxial, clamped / unclamped), r_eo (trigonal-3m, Weis-Gaylord 1985 Table 4, 633 nm clamped default). `silicon.yaml` dndT: Li 1980 table (1.818e-4 /K at 1.55 um, 293 K). `fused-silica.yaml` dndT: Leviton-Frey 2006 fit.
- `RunContext.materials` is `Record<material id, Record<prop, number>>` (scalars only). `prepareRun` resolves override scalars and library refs for the physics' NEEDS without a wavelength; a tensor override (`{symmetry, components}`) is accepted by the spec schema but `resolveQuantity` throws on it. So uniaxial n and r_eo cannot reach a RunContext today (MC request R1).
- MC driver (landed 08:35): `RunContext.inputs: CoupledInput[]`, `CouplingImpl.map({up, upId, down, node})`, merged scalars `<pid>.<name>`, merged steps must agree (an electrostatics study with more than one terminal has param steps and cannot be merged with em-modes eigen steps: use one terminal + ground). `COUPLING_NEEDS` (core.ts) drives coupling property readiness.
- em-modes physics settings are strict `{order}` (registrations.ts, MC). No place for a crystal orientation yet.
- Atlas EO conventions (eo-overlap.mjs, frozen E2): lab x lateral, y film normal, z propagation; `labFromCrystal(cut, propagation, rotation)`; delta(1/n^2)_I = r_Ij E_j (crystal frame), delta eps = -eps delta(1/eps) eps; V_t = full terminal voltage; delta phi = k0 L (dn_A - dn_B); VpiL = lambda / (2 |dn_A - dn_B|). Atlas results (DevLog-026 S1, 2026-10-14): pan2021 VpiL 4.204 V cm (paper-simulated target 4.06), arabjuneghani2022 3.978 V cm scalar, 4.022 V cm vector (measured 3.3).

### 1.2 Design (D)
- **One mesh** (C11): heat / electrostatics fields are nodal (P1 or P2) on the study mesh; the mode kernel uses the same triangles (vertices). T and E = -grad V are evaluated at the 6 kernel quadrature points of each triangle from the upstream shape functions (exact for the P1/P2 field), so no interpolation between meshes. Mesh hash mismatch is an error.
- **em-modes coupled path** (`modes/coupled.ts`): `emModes.run` dispatches to it only when `ctx.inputs` holds a `thermo-optic` or `electro-optic` input; otherwise the old path runs unchanged (reason: existing sims must give identical n_eff). Steps:
  1. base solve with eps0 (materials) -> modes0.
  2. thermo-optic inputs: dEps_T per quadrature point = 2 n dn/dT (T - Tref) (isotropic), uniaxial dn/dT rotated to the lab frame; direct re-solve with eps = (n + dn/dT dT)^2 per triangle (triangle mean of dT); the coupled solution's modes are the heated ones; scalars dneff_<k> (direct), dneffPert_<k> (first order on modes0), dphidz_<k> = k0 dneff (rad/m), and Ppi_<k> = lambda P' / (2 |dneff|) when the heat input per unit length P' is known (linear heat problem, T - Tref proportional to P'; stated assumption).
  3. electro-optic inputs: dEps per volt at each quadrature point from the Pockels tensor (port of atlas `deltaEpsLab`); first-order dneff/dV on the final modes; direct check: central difference of two re-solves at +-V_probe (triangle mean of dEps; V_probe chosen so that max |dEps| / eps = 1e-4, a numerical choice); scalars dneffdV_<k>, dneffdVdirect_<k>, and VpiL in the stated convention.
- **Push-pull convention** (stated, atlas E2 conventions): V_t = full terminal voltage of the electrostatics solve (terminal solve: 1 V; applied potentials: max(V) - min(V) unless `settings.voltage` is given). Arm A = the waveguide in the em-modes selection. Arm B: `settings.armB`: `none` (single arm: VpiL = lambda / (2 |dn_A|)), `mirror` (field-resolved: arm B is the mirror image of arm A about x = `settings.mirrorX`; dn_B = overlap of the arm-A mode with the mirror image of the static field (Ex -> -Ex at x' = 2 x0 - x); valid when the optical tensors are mirror symmetric (no rotation) -- checked), `ideal` (dn_B = -dn_A, labelled idealised). VpiL = lambda / (2 |dn_A - dn_B|) in V m (scalar unit V*m).
- **Crystal orientation**: `crystals: [{material, cut, propagation, rotation?}]` accepted in em-modes physics settings (needs MC registry change, request R2) and in either photonic coupling's settings (works now); one definition per material, conflicts are errors. Uniaxial n / dndT / eps without an orientation are errors.
- **Materials read in em-modes**: flat keys `n`, `n.perp`, `n.par`, `dndT`, `dndT.perp`, `dndT.par`, `r_eo.r13` ... (request R1: prepare flattens tensor values to `<prop>.<component>`). Missing dndT on a selected material with dT != 0 is an error (no default). Missing r_eo = not electro-optic (centrosymmetric materials have r = 0 by symmetry); the result notes list the EO materials used; zero EO materials in the selection is an error.
- **Couplings** (`couplings/photonic.ts`): `thermo-optic` heat -> em-modes, map = nodal T + space + Tref (+ P' if `settings.power` or an upstream scalar is given); `electro-optic` electrostatics -> em-modes, map = nodal V + space + V_t + arm B options. Registrations with strict settings schemas; `PHOTONIC_NEEDS` export for MC's `COUPLING_NEEDS` (thermo-optic: to dndT).
- Port: crystal tensor math from eo-modulator-atlas `engine/src/materials.mjs` at 0546007 into `modes/crystal.mjs` + `.d.mts` with a C1 port header (GPL-3.0-or-later, same licence).

### 1.3 Gates
- G-TO1 Si strip 500 x 220 nm in SiO2 (si-strip-te0 geometry), uniform dT: direct dneff vs first order (rel < 1e-2 at dT = 1 K... tolerance from the O(dT^2) term), and per-domain sensitivities dneff/dn_d satisfy the exact identity sum_d n_d dneff/dn_d = n_g (non-dispersive eps, scaling argument eps -> s^2 eps at fixed omega == eps at s omega) against the solver's energy group index; dneff/dT = sum_d (dn/dT)_d dneff/dn_d. Library dn/dT (Li 1980 Si, Leviton 2006 SiO2).
- G-TO2 heat -> em-modes through the coupling map with a uniform T field equals G-TO1.
- G-EO1 uniform field on an LN slab / block: dneff/dV vs closed form for a uniform-index guide (PEC box TE10: dneff = k0 dEps_yy / (2 beta) per volt) and direct vs perturbation agreement.
- G-EO2 TFLN MZM (CP-43 Pan 2021 geometry from the atlas config): electrostatics -> em-modes on one mesh; VpiL push-pull vs paper-simulated 4.06 V cm (tol 10 %, CP-43) and vs atlas 4.204 V cm; direct vs perturbation.
- G-EO3 CP-44 (Arab Juneghani 2022 device 2) if time allows: VpiL vs atlas vector 4.022 V cm and measured 3.3 V cm (informative).
- Microheater with a published P_pi: research subagent 2026-11-07 08:30-08:34: best candidate Jacques et al., Opt. Express 27(8) 10456 (2019) (abstract: TiN P_pi 21.4 mW, N++ 22.8 mW), but the full text was not readable (Optica bot check); cross-section values only from a secondary notebook (Flexcompute Tidy3D). Not solid as a gate until someone reads the paper (O1).
- No regression: every `sims/*.yaml` with em-modes gives identical n_eff before / after (script, log in `logs/`).

## 2. TODO
- [x] crystal.mjs port + d.mts
- [x] modes/coupled.ts (sampling, dEps, solves, scalars) + dispatch in modes/index.ts; uniaxial n via crystals in the single path
- [x] couplings/photonic.ts (impls, registrations, PHOTONIC_NEEDS)
- [x] tests G-TO1, G-TO2, G-EO1, G-EO2, G-EO3
- [x] em-modes regression (all em-modes sims, n_eff identical)
- [x] tsc check clean + @amp/physics test (86 / 86 after the audit fixes)
- [x] CONTRACTS changelog entry (08:51)
- [x] requests to MC / MX (s.4) with YAML drafts
- [ ] after MC R0-R3: run the TFLN sim YAML end to end through prepareRun + runStudy (replace the test-side P1 Poisson)
- [x] microheater: MX sourced Wang et al. 2020 (sims/si-microheater-to.yaml); run here, s.6 (gate owned by MX)

## 3. Progress log
- 2026-11-07 08:54-09:01 PST: fresh-context audit (s.7) and fixes; photonic tests 7 / 7, regression identical (`logs/mo-regress-after2-20261107-085944.json`), full @amp/physics test 86 / 86 (`logs/mo-physics-test-20261107-090026.log`). MX's `sims/si-microheater-to.yaml` (Wang et al. 2020 PTL device, read by MX) run through prepareRun + runStudy with the R0 workaround (dndT moved from the overrides into the resolved materials): P_pi 9.44 mW vs measured 8.5 mW (s.6). MX's `sims/tfln-mzm-eo.yaml` uses the coupling keys of s.1.2 (needs R0, R1, R3, G1 to run).
- 2026-11-07 08:44-08:53 PST: G-TO2 end to end (spec -> prepareRun -> runStudy, heat -> em-modes) passes; em-modes readiness accepts fragment pieces `dom:a&b` for materials selecting `dom:a` (additive; regression unchanged); TFLN gates CP-43 and CP-44 (test/photonic-tfln*.ts) pass; full @amp/physics test 80 / 80 (`logs/mo-physics-test-20261107-085120.log`); CONTRACTS changelog entry; requests and YAML drafts (s.4).
- 2026-11-07 08:36-08:44 PST: crystal.mjs port, modes/coupled.ts, dispatch + uniaxial support + `epsTri` / `model` reuse in modes/index.ts, couplings/photonic.ts; typecheck clean. Regression: all 7 em-modes sims give bitwise-identical n_eff before / after (`logs/mo-regress-{before,after}-20261107-084103.json`, original modes/index.ts run from a temporary copy, removed). Tests `test/photonic.test.ts` S1, G-TO1, G-EO1, plain-path identity pass (results s.6).
- 2026-11-07 08:25-08:36 PST: read DevLog-029, C11, modes kernel, materials, CP-43/44, atlas EO engine and configs; MC core.ts / driver.ts landed 08:35. Microheater source search delegated (result s.1.3).

## 4. Requests (to other lanes)

### 4.1 MC (DevLog-031)
- R0 `physicsRegistry()` (registrations.ts) must call `registerMaterialProperties` of `@amp/materials`: today `dndT` and `r_eo` are rejected as override keys ("unknown key 'dndT' (allowed: E, alpha, c, cp, eps_r, k, mu_r, n, nu, rho, sigma, tan_delta)").
- R1 prepareRun `resolveMaterials`: (a) tensor overrides `{symmetry, components}` currently throw (`resolveQuantity`: not a quantity); flatten them and library tensor values to `rec['<prop>.<component>']` in SI (`n.perp`, `n.par`, `eps_r.perp`, `r_eo.r33`, `dndT.par`, ...); (b) evaluate library properties of an em-modes physics at the mode study wavelength (`{lambda}`; `n` and `dndT` are wavelength tables / fits and fail without it) and `dndT` at the coupling `Tref` (`{T}`; fused-silica / thermal-oxide dndT need T); (c) pull the downstream properties of `PHOTONIC_NEEDS` (`photonic.ts`; thermo-optic: `dndT`) and `r_eo` where present (r_eo absent = not electro-optic, no reason).
- R2 em-modes registration (L4_REGISTRATIONS): settings `z.strictObject({ order: ..., crystals: crystalsSchema.optional() })` with `crystalsSchema` exported from `couplings/photonic.ts`; RESULT_NAMES['em-modes'].scalars += `RESULT_NAMES_COUPLED` (exported from `modes/coupled.ts`).
- R3 electrostatics: anisotropic eps_r (uniaxial `eps_r.perp` / `eps_r.par` with the same `crystals` orientation; in-plane tensor xx, xy, yy to `assembleCells`). Without it TFLN VpiL is not meaningful (x-cut LN: lateral eps 27.9 vs vertical 44.3, Weis-Gaylord 1985). The gates here solve the field with the anisotropic P1 `PoissonSolver` of `@amp/core` in the test (`test/photonic-tfln.ts`).
- R4 `COUPLING_NEEDS` (core.ts / index.ts): merge `PHOTONIC_NEEDS`.
- R5 heat solution scalar of the total heat input per length (proposal: `Q_total`, W/m in 2D, W in 3D / axisym) so the thermo-optic map can report Ppi from the currents -> heat chain without `settings.power`; the map will read it when it exists (agree the name first).
- Note: merged steps: an electrostatics physics with more than one terminal has `param` steps and cannot merge with em-modes eigen steps (driver error); EO sims use one terminal + ground.

### 4.2 Geometry (coordinator to route)
- G1 the bottom edge of an electrode hole that sits on a layer (e.g. `sig` on `slab`) is named `bnd:slab.top#k` and `bnd:sig.bottom` matches nothing, also with the electrode features first. Terminal selections then miss the electrode bottom (those nodes stay free). The gates fix the potential geometrically (every vertex in the closed electrode rectangle). Wanted: the coincident hole edge carries `bnd:sig.bottom` in `parent` so the selection resolves.

### 4.3 MX (DevLog-035)
- M1 materials: LN `dndT` (n_o, n_e; uniaxial) with a primary source; air `eps_r` (N/A today) and air `n` beyond 1.69 um (1957 nm for CP-43; the gates assume 1 for both, labelled); thermal-oxide `dndT` without T dependence or with a stated T (today it needs `{T}`).
- M2 sim `tfln-mzm-pan2021` (needs R0-R3, G1). Geometry and values exactly as run by gate G-EO2 (`test/photonic-tfln.ts` PAN2021, `tflnSpec`), compact form:

```yaml
# CP-43 Pan et al. 2021 (Opt. Express 29, 17710; doi 10.1364/oe.416908): x-cut TFLN MZM at 1957 nm, GSG, push-pull by arm
# placement. Geometry: designed parameters p.3 (g 6.5, ws 17, wg 60, t 0.5 um; rib top 1.1, h 0.3 of 0.6 um film; BOX 2 um)
# via eo-modulator-atlas sims/pan2021/config.yaml; sidewall 30 deg from vertical and centred waveguide = atlas inferences.
schema: amp-spec/0
id: tfln-mzm-pan2021
title: TFLN MZM VpiL (Pan 2021)
description: x-cut thin-film LN MZM, GSG push-pull; electrostatics -> Pockels effect -> optical mode; VpiL.
params:
  lambda0: {value: 1957, unit: nm, description: vacuum wavelength}
geometry:
  dim: 2
  features:
    - {id: sub, type: rect, settings: {size: ["270 um", "248 um"], center: ["-15 um", "-126 um"]}}
    - {id: box, type: rect, settings: {size: ["270 um", "2 um"], center: ["-15 um", "-1 um"]}}
    - {id: slab, type: rect, settings: {size: ["270 um", "0.3 um"], center: ["-15 um", "0.15 um"]}}
    - {id: ribA, type: polygon, settings: {points: [["-0.7232 um", "0.3 um"], ["0.7232 um", "0.3 um"], ["0.55 um", "0.6 um"], ["-0.55 um", "0.6 um"]]}}
    - {id: ribB, type: polygon, settings: {points: [["-24.2232 um", "0.3 um"], ["-22.7768 um", "0.3 um"], ["-22.95 um", "0.6 um"], ["-24.05 um", "0.6 um"]]}}
    - {id: sig, type: rect, settings: {size: ["17 um", "0.5 um"], center: ["-11.75 um", "0.55 um"]}}
    - {id: gR, type: rect, settings: {size: ["60 um", "0.5 um"], center: ["33.25 um", "0.55 um"]}}
    - {id: gL, type: rect, settings: {size: ["60 um", "0.5 um"], center: ["-56.75 um", "0.55 um"]}}
    - {id: top, type: rect, settings: {size: ["270 um", "119.7 um"], center: ["-15 um", "60.15 um"]}}
    - {id: air0, type: difference, settings: {base: top, tools: [sig, gR, gL]}}
    - {id: air, type: difference, settings: {base: air0, tools: [ribA, ribB], keepTools: true}}
    - {id: owin, type: rect, settings: {size: ["6.2 um", "3 um"], center: ["0 um", "0 um"]}}
    - {id: owinB, type: rect, settings: {size: ["6.2 um", "3 um"], center: ["-23.5 um", "0 um"]}}
    - {id: frag, type: fragment, settings: {inputs: [box, slab, ribA, ribB, air, owin, owinB]}}
materials:
  - {id: LN, ref: materials/linbo3-congruent, select: ["dom:slab", "dom:ribA", "dom:ribB"]}
  - {id: SiO2, ref: materials/sio2-thermal-oxide, select: ["dom:box"]}
  - {id: Si, ref: materials/silicon, select: ["dom:sub"]}
  - {id: Air, override: {n: 1, eps_r: 1}, select: ["dom:air"]}
physics:
  - id: es
    type: electrostatics
    select: ["dom:sub", "dom:box", "dom:slab", "dom:ribA", "dom:ribB", "dom:air"]
    settings: {crystals: [{material: LN, cut: x, propagation: y}]}          # R3
    bcs:
      - {id: V_sig, type: terminal, select: ["bnd:sig.right", "bnd:sig.top", "bnd:sig.left", "bnd:sig.bottom"]}   # G1
      - {id: gnd, type: ground, select: ["bnd:gR.right", "bnd:gR.top", "bnd:gR.left", "bnd:gR.bottom", "bnd:gL.right", "bnd:gL.top", "bnd:gL.left", "bnd:gL.bottom"]}
  - id: ewg
    type: em-modes
    select: ["dom:box&owin", "dom:slab&owin", "dom:ribA&owin", "dom:air&owin"]
    settings: {order: 2, crystals: [{material: LN, cut: x, propagation: y}]}   # R2
couplings:
  - {id: eo, type: electro-optic, from: es, to: ewg, settings: {terminal: V_sig, armB: mirror, mirrorX: "-11.75 um"}}
mesh:
  size: {hmax: "10 um", grading: 0.25}
  refine:
    - {select: ["dom:owin", "dom:owinB"], h: "0.1 um"}
    - {select: ["dom:ribA", "dom:ribB"], h: "0.04 um"}
    - {select: ["bnd:sig.right", "bnd:sig.left", "bnd:gR.left", "bnd:gL.right"], h: "0.04 um"}
studies:
  - {id: std, type: mode, physics: [es, ewg], settings: {wavelength: "lambda0", nModes: 2}}
results:
  datasets:
    - {id: sol, type: solution, data: std}
  evaluations:
    - id: ev
      data: sol
      items:
        - {id: VpiL, type: global, expr: ewg.VpiL_0, unit: "V*cm"}
        - {id: dndV, type: global, expr: ewg.dneffdV_0, unit: "1/V"}
        - {id: dndV_direct, type: global, expr: ewg.dneffdVdirect_0, unit: "1/V"}
        - {id: neff, type: global, expr: ewg.neff_0, unit: "1"}
  tables:
    - {id: tbl, from: ev}
  plots:
    - {id: V_map, type: plot2d, data: sol, items: [{id: V_surf, type: surface, expr: es.V, unit: V}]}
    - {id: E_mode, type: plot2d, data: sol, items: [{id: E_surf, type: surface, expr: ewg.normE, unit: V/m}]}
assumptions:
  - {text: "Air n = 1 and eps_r = 1 (vacuum values; the library has no air permittivity and its index fit ends at 1.69 um)", paths: [materials]}
  - {text: "Pockels tensor r^S at 633 nm (Weis-Gaylord 1985 Table 4) used at 1957 nm: the source has no 1957 nm value", paths: [materials]}
  - {text: "Optical window +-3.1 um x +-1.5 um with PEC walls (cells outside the em-modes selection carry no DOFs)", paths: [physics.ewg.select]}
# eval: [CP-43]   provenance block per value: MX (same sources as the comments above and CP-43)
```

- M3 superseded: MX wrote `sims/si-microheater-to.yaml` (Wang et al. 2020) and `sims/tfln-mzm-eo.yaml`; the drafts below stay for reference. M3 draft (before MX's source): no solid source yet (O1). Draft structure only; every device value N/A until Jacques et al. 2019 (Opt. Express 27, 10456) is read in full. Chain currents -> heat -> em-modes once a resistive heater is modelled (joule-heating, MC), or heat with a `heat-source` and `settings.power` on the thermo-optic coupling:

```yaml
schema: amp-spec/0
id: si-microheater-ppi
title: Si waveguide microheater, P_pi
params:
  lambda0: {value: 1550, unit: nm}
  w_core: {value: 500, unit: nm}            # WO-65 strip (sourced); Jacques 2019 value to verify
  t_core: {value: 220, unit: nm}
  t_box: {value: N/A, unit: um}             # Jacques 2019: verify (secondary: 2 um)
  w_htr: {value: N/A, unit: um}             # verify (secondary: 2 um)
  t_htr: {value: N/A, unit: um}             # verify (secondary: 0.2 um)
  gap_htr: {value: N/A, unit: um}           # heater bottom above core top; verify (secondary: 2 um)
  P_lin: {value: N/A, unit: W/m}            # heater power per length
# geometry: substrate | BOX | core in SiO2 cladding | heater (TiN) in cladding | air; window for em-modes around the core
physics:
  - {id: ht, type: heat, select: [...], bcs: [{id: sink, type: temperature, select: ["bnd:sub.bottom"], settings: {T: "293 K"}}, {id: src, type: heat-source, select: ["dom:htr"], settings: {Q: "P_lin / (w_htr * t_htr)"}}]}
  - {id: ewg, type: em-modes, select: [<core and cladding pieces of the optical window>], settings: {order: 2}}
couplings:
  - {id: to, type: thermo-optic, from: ht, to: ewg, settings: {Tref: "293 K", power: "P_lin"}}
studies:
  - {id: std, type: mode, physics: [ht, ewg], settings: {wavelength: "lambda0", nModes: 1}}
# results: ewg.Ppi_0 (W), ewg.dneff_0, ewg.dphidz_0; materials: Si (dndT Li 1980), SiO2 (dndT Leviton 2006), TiN (k: N/A in the library)
```

## 5. Open items
- O2 n_g of the coupled and plain em-modes runs uses eps_g = eps (non-dispersive): CP-43 n_g 2.226 here vs 2.276 paper-simulated (material dispersion missing). Needs dn/dlambda per material (library fits) into `epsG`; not gated here.
- O3 thermo-optic and electro-optic together in one em-modes physics are supported (heat changes eps, EO sensitivity on the heated mode) but not gated.
- O4 the test-side anisotropic P1 Poisson (test/photonic-tfln.ts) goes away after R3; gates then run through runStudy.
- O1 (closed by MX's Wang 2020 source; kept for a second device) microheater P_pi gate: read Jacques 2019 (Optica OA) full text in a browser: cross-section figure, Table 3 (thermal conductivities), simulation set-up (2D or 3D, boundaries), measured vs simulated P_pi, heater length, licence.

## 6. Results (2026-11-07, Node 23.7.0, `nice -n 10`, `--max-old-space-size=1536`)

| Gate | Quantity | This engine | Reference (source) | Diff | Status |
|---|---|---|---|---|---|
| S1 | P1 / P2 value and gradient at quadrature points | exact to 1e-9 | polynomials | - | pass |
| G-TO1 | Si strip 500 x 220 nm in SiO2, TE0, dT = 1 K: dneff direct / first order | 1.95936e-4 / 1.95933e-4 | each other | 1.2e-5 rel | pass |
| G-TO1 | sum_d n_d dneff/dn_d vs solver n_g | 4.0555764131344 vs 4.0555764131344 | exact identity (eps -> s^2 eps at k0 = eps at s k0) | 1.3e-14 rel | pass |
| G-TO1 | dneff/dT, TE0 (Si dn/dT 1.818e-4 /K Li 1980; SiO2 8.16e-6 /K Leviton 2006) | 1.959e-4 /K | sum (dn/dT)_d dneff/dn_d (dneff/dn_Si 1.0669, dneff/dn_SiO2 0.2390) | < 1e-9 | pass |
| G-TO2 | spec -> prepareRun -> runStudy, heater 1 x 0.2 um, Q 1e14 / 2e14 W/m^3 (test inputs) | dneff 1.4659e-3 / 2.9321e-3; Ppi 10.573 / 10.572 mW | linearity (dneff ratio 2, Ppi constant) | 2e-4 / 9e-5 | pass |
| G-EO1 | z-cut LN PEC box, uniform E_y, TE10: dneff/dV first order / direct | 1.529436e-4 / 1.529436e-4 1/V | closed form (k0 / 2 beta)(-n_e^4 r33 E_y) = 1.529436e-4 | 1.0e-7 rel | pass |
| G-EO2 | CP-43 Pan 2021: push-pull VpiL (mirror arm B, field-resolved) | 4.241 V cm (finer mesh 4.245) | 4.06 paper-simulated (CP-43, tol 10 %); atlas engine 4.204 | +4.5 %; +0.9 % | pass |
| G-EO2 | dn_A/dV first order vs direct; balance dn_B / dn_A | -1.15354e-5 1/V both (5e-10 rel); -1.0000178 | - | - | pass |
| G-EO2 | n_eff TE0, n_g | 1.80067, 2.2263 | n_g 2.276 paper-simulated (CP-43) | -0.050 | not gated (O2) |
| G-EO3 | CP-44 Arab Juneghani 2022 device 2: VpiL | 4.015 V cm | atlas vector solver 4.022 V cm; measured 3.3 V cm | -0.2 %; +21.7 % (atlas: same overshoot) | pass (atlas); informative (measured) |
| G-EO3 | n_eff TE0 | 1.84584 | atlas vector 1.8458 | < 1e-4 | pass |
| regression | n_eff of the 7 em-modes sims | bitwise identical | before the change | 0 | pass |

Materials in the TFLN gates: LN n Zelmon 1997 (perp / par = n_o / n_e at 1957 nm 2.19805 / 2.12648), r_eo Weis-Gaylord 1985 r^S 633 nm (r13 8.6, r22 3.4, r33 30.8, r51 28 pm/V), eps_r clamped 44.3 / 27.9; SiO2 n Malitson, eps_r 3.9 (Zhu 2021 model input); Si eps_r 11.66 (Li 1980); air n = eps_r = 1 (assumption). Mesh: Pan 42130 cells (tri6), em-modes 77479 DOF, 12-13 s per coupled run (base + 2 direct re-solves); Arab 35164 cells, 6.5 s.

| microheater (MX sim, run here) | Wang et al. 2020 PTL device (sims/si-microheater-to.yaml): P_pi, TE0 | 9.44 mW (dneff 1.5515e-3 at P' 18.89 W/m; first order 1.5513e-3; T_max 311.1 K) | measured 8.5 mW (as cited by MX in the sim header; paper not read in this lane) | +11 % | informative (MX gate) |

Logs: `logs/mo-microheater-wang2020-*.log`, `logs/mo-regress-{before,after}-20261107-084103.json`, `logs/mo-tfln-pan2021-*.log`, `logs/mo-tfln-arab2022-*.log`, `logs/mo-test-tfln-*.log`, `logs/mo-physics-test-20261107-085120.log`.

## 7. Fresh-context audit (2026-11-07 08:54-08:58 PST) and fixes
Audit (read only) of coupled.ts, crystal.mjs, modes/index.ts changes, photonic.ts, tests: mirror derivation, Pockels chain, VpiL / VpiLsingle, thermo first order vs direct, P2 sampling, Locator, Ppi: correct. Findings and fixes:
- bug: upstream field masked per node, so em-modes cells outside the heat / electrostatics domain touching the interface got a nonzero dT or E. Fixed: the maps pass `cells` (upstream selection mask); dT and Pockels d eps are zero outside it.
- bug: em-modes `settings.crystals` rejected by the strict registration: already request R2 (MC); coupling-settings `crystals` works meanwhile.
- risk: plain path threw for a uniaxial material without crystals outside the em-modes selection. Fixed: only domains of the selection are resolved.
- risk: mode matching by index between solves. Fixed: `matchMode` (same polarisation family within 0.1 TE fraction, nearest n_eff) for the heated / unheated and +-Vp solves; order changes are noted.
- risk: probe voltage Vp = 1e-4 / max |d eps / eps| (Infinity with zero field, corner-dominated). Fixed: Vp = 1e-5 / max |dn/dV| from the first order; skipped with a note when that is 0.
- risk: mirror without a geometric symmetry check. Fixed: each mirrored quadrature point of a Pockels cell must lie in the same material and in the electrostatics domain, else an error; thermo + mirror noted.
- nits fixed: Ppi note states that P' is not checked against the heat solution and that crosstalk is not modelled; `rotation` description says a bare number is radians; readiness fragment match ignores `#k` selections.
- not changed (pre-existing): em-modes uses `eps_r` as the optical permittivity when `n` is absent (could take an RF value); flagged for the coordinator.
