# DevLog-063: advanced packaging examples, part 2 (lane G6, chunk 3)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | G6 (DevLog-037 s.4.2) |
| Status | done (s.4 gates; s.6 requests; s.7 hand-off) |
| Owns | new `sims/<id>.yaml` it creates; `apps/web/src/lib/library/catalog-pkg.ts` (append); new `validation/c/cases_ext/pkg2.py`; new `validation/pkg2/**`; new `eval/expected/PK-07..19.json`; case ids PK-07..PK-19; this file |
| Read | CLAUDE.md; DevLog-037 s.4.1-4.2; DevLog-049; DevLog-044 s.1-4; DevLog-058 s.1-2 (lane G1, material T in progress); `catalog-pkg.ts`; `validation/c/cases_ext/pkg.py`; `validation/pkg/*.py`; `sims/{microstrip-rdl,tsv-stress-axisym,interposer-thermal-3d,si-microheater-to}.yaml`; `packages/physics/src/electrostatics/index.ts`; `packages/physics/src/couplings/photonic.ts` (header); `packages/eval/src/registry.ts` (per-target spec, params overrides, combine targets) |

Conventions: F = fact read from code, a source or a run; D = decision; E = estimate; O = open item; R = request.

## 1. Plan (written 2026-11-18 18:19 PST, before coding)

### 1.1 Facts

- F: electrostatics masks cells outside the physics selection (inactive nodes fixed), so a metal strip of finite thickness is a domain left out of `select`, with the terminal on its walls.
- F: Qucs technical documentation s.11.1.3 (qucs.sourceforge.net/tech/node75.html, read 2026-11-18) gives the Wheeler (11.19)-(11.20) and Hammerstad-Jensen (11.22)-(11.25) thickness corrections; it states no accuracy for them (the 0.01 % / 0.2 % figures are for the zero-thickness forms). A web search (2026-11-18) found no stated accuracy for the thickness term either.
- F: the thermo-optic coupling carries a nodal field on the same study mesh (`couplings/photonic.ts` l.6): no 3D heat -> 2D mode cut transfer.
- F: eval cases support a per-target `spec` (`{sim, params}` overrides) and `combine` targets (registry.ts l.351, l.456).
- F: lane G1 (DevLog-058) is adding a material temperature; until it lands the new sims use overrides equal to the library value at 298.15 K (as PK-01..06), labelled.

### 1.2 Items (priority order; ids)

| # | Sim / case | Model | Gate (reference) |
|---|---|---|---|
| 1 | `microstrip-thick` / PK-07 | RDL microstrip with a Cu strip of thickness t (metal domain left out of the electrostatics, terminal on its four walls) on polyimide over ground | L' (vacuum solve) vs an independent boundary-element solution of the thick strip over ground with images (own code, `validation/pkg2/strip_bem.py`, converged with stated digits; independent of the FE). C', Z0 vs Hammerstad-Jensen with thickness correction (Qucs eqs. 11.22-11.25): informative, the source states no accuracy for the thickness term; Wheeler (11.19-11.20) also listed. Zero-thickness limit: the PK-03 sim as a second target spec; increase of C'_0 with t (rigorous sign: capacitance grows with the conductor) |
| 2 | `bump-array-thermal` / PK-08 | axisymmetric unit cell of a solder-bump array: Si die / SAC305 column / Si interposer, equal-area circular cell, isothermal die back and interposer bottom, void around the bump (no underfill) | rigorous two-sided bounds (own derivation): Dirichlet principle with a trial field from isothermal-disc plate solutions gives R >= R_col + R_iso(die) + R_iso(interposer); complementary principle with the uniform-flux plate solutions (exact series, separation of variables) gives R <= R_col + R_uf(die) + R_uf(interposer). R_iso by a Galerkin solve with an edge-singular flux basis (converged, digits stated). Parallel-column (1D) resistance informative |
| 3 | `hybrid-bond-pad` / PK-09 | axisymmetric Cu pad recessed in SiO2 on Si, uniform temperature rise; pad top protrusion relative to the oxide surface | closed form for the laterally free and laterally rigid limits (own, labelled) as informative bracket, unless a published value or exact case is found |
| 4 | `waveguide-heater-3d` / PK-10 | 3D layer stack (Si substrate, BOX, Si core in oxide, cladding) with a thin-film heater as a surface heat flux on a strip of the cladding top (heater spans the section; y-ends adiabatic, so the field is y-invariant) | rigorous bounds on the heater-strip mean temperature rise per power: exact multilayer Fourier-series solutions (own) with the core layer all oxide (upper) and all Si (lower), compliance monotone in k. Core temperature rise informative |
| 4b | `waveguide-heater-to` / PK-11 | 2D cross-section of the same stack: heat -> em-modes (thermo-optic), phase per heater power | informative: the 3D -> 2D cut transfer does not exist (request); the 2D section equals the y-invariant 3D field; phase per power vs a first-order estimate from the bounds |

D: thin-film heater as a surface flux avoids the TiN / W film k (TiN k N/A; bulk W k would be a film-k assumption); stated in the sim.

## 2. TODO

- [x] Plan (this section)
- [x] PK-07 microstrip-thick (BEM reference; HJ with thickness informative; Wheeler dropped, see s.3 18:21)
- [x] PK-08 bump-array-thermal (bounds)
- [x] PK-10 / PK-11 waveguide heater 3D + thermo-optic cross-section
- [x] PK-09 hybrid-bond pad (wide-pad gate; real pad informative)
- [x] catalog entries, cases, expected JSONs, build + test_build_matches, CLI
- [x] Gate table, requests, hand-off

## 3. Progress log

- 2026-11-18 18:13-18:18 PST: read the inputs listed above; facts s.1.1.
- 2026-11-18 18:19 PST: plan written.
- 2026-11-18 18:20-18:22 PST: PK-07. BEM reference `validation/pkg2/strip_bem.py` (image method, corner-graded panels, exact panel integrals of ln r). Check against Hammerstad-Jensen in air: t/h = 1e-4: -8.7e-7, 1e-3: +7.8e-6, 1e-2: +7.0e-5, 0.1: +5.3e-4, 0.2: +8.8e-4 (HJ thickness correction minus BEM in C'_0): the BEM agrees with the zero-thickness closed form in the thin limit, and the HJ thickness term drifts by under 0.1 % at t/h = 0.2. BEM converged to 2.5e-7 (Richardson of 320 / 640 panels per side). Wheeler's (11.19) was not used: the Qucs rendering lacks a square that the scikit-rf code was cut before showing, so its exact form was not verified. Sim param `t` is a reserved symbol (renamed `t_m`); BC id must differ from feature ids (`line`). Conductor corners (exterior angle 3 pi / 2): observed order 1.49 (L'), 1.27 (C'); case expected order 4/3.
- 2026-11-18 18:23-18:26 PST: PK-08. `validation/pkg2/bump_bounds.py`: uniform-flux series (40000 terms, N/2 change 3e-10); isothermal disc by Galerkin with the basis (1 - r^2/a^2)^(m - 1/2): M 2 / 4 / 6 agree to 1e-8; the truncated series under-estimates the singular-basis energy ~ 1/N, extrapolated 2 R(2N) - R(N) (N -> 2N change 1.9e-6 / 3.0e-6). Half-space checks (b = 100 a, thick plate): uniform flux 0.266667 / (k a) vs 8 / (3 pi^2) = 0.27019 times the flux-tube factor; isothermal 0.246461 / (k a) vs 0.25 times the same order of factor. First run: heat flow sign (z up, heat flows down): fixed. R = 237.824 K/W in [234.136, 239.047].
- 2026-11-18 18:27-18:34 PST: PK-10 / PK-11. Plain bounds (core layer all oxide / all Si) are 44 % apart; the sharper bounds use the layered fields as trial fields in the true medium (Dirichlet: all-Si field; complementary: all-oxide flux), 32-34 % apart: rigorous but wide, because the Si strip is a strong local perturbation (D: kept as a range gate with the width stated). Downward propagation of high modes overflowed with cosh / sinh; rewritten with decaying exponentials only (`_ratios`). x grid aligned with the strip edge. 2D sim: `1.5 um` inside an expression is not accepted (unit literals need brackets); a parameter `d_win` was added. Case fields: physics tag `optics-modes`, study type `eigen` for a mode study.
- 2026-11-18 18:35 PST: PK-10 first full run: level 2 = 313,740 DOF, peak RSS 4.89 GB with the default direct factor (over the 2 GB rule). With `settings: {solver: auto}` on the heat study (AMG-PCG chosen, 257 iterations, residual 9.4e-11): 1.44-1.61 GB, 45 s, results equal to 1e-12 relative.
- 2026-11-18 18:36-18:38 PST: PK-09. Frame of the Si wafer (alpha - alpha_Si, base fixed): exact change of frame for a rigid wafer that expands freely; elastic `displacement` takes constants only, so u_r = alpha_Si dT r could not be prescribed directly. Wide-pad variant through the case's per-target `{sim, params: {a: 10, R: 20}}`.
- 2026-11-18 18:39-18:42 PST: catalog entries (5, category packaging); `test_build_matches`: 62 class-c cases compared, 1 differing: WO-73 (lane G4's case, not this lane's files); PK-07..11 identical. `@amp/materials` test 34 / 34, `@amp/spec` test 65 / 65, apps/web `pnpm check` 0 errors (1536 files). ruff is not installed in the validation environment (not run; no installs).
- 2026-11-18 18:42-18:43 PST: final CLI PK-07..11: 5 / 5 cases pass, 7 gated targets pass, 22 info (`logs/G6-cli-pk2-all-20261118T184214.log`, peak RSS in `.err`: 0.80 / 0.42 / 0.46 / 1.44 / 1.27 GB).

## 4. Results

### 4.1 Gate table (harness CLI, engine `@amp/physics`; records `logs/eval-20261118T1842{14,22,25,29}.jsonl`, `logs/eval-20261118T184316.jsonl`)

| Case / sim | Target | Engine | Reference | Rel. diff | Tol | Gate | Reference source |
|---|---|---|---|---|---|---|---|
| PK-07 microstrip-thick (hF 1, 0.5, 0.25; 9,204 / 37,557 / 151,707 DOF) | L' | ext 379.776 nH/m (fine 379.764) | 379.768 nH/m | ext +2.1e-5, p_obs 1.49 | 5e-4 | pass | own BEM, `validation/pkg2/strip_bem.py` (converged 2.5e-7) |
| | C'_0(t) / C'_0(0) | 1.11003 | 1.11043 | -3.6e-4 | 1e-3 | pass | BEM thick / Hammerstad-Jensen zero thickness (0.01 % for W/h <= 1); FE ratio from this sim and sims/microstrip-rdl.yaml (finest levels) |
| | L' vs HJ with thickness | ext 379.776 nH/m | 379.436 nH/m | +9.0e-4 | | info | Qucs s.11.1.3 eqs. (11.22)-(11.25); no accuracy stated for the thickness term |
| | C' | ext 62.369 pF/m | 62.291 pF/m | +1.25e-3 | | info | same |
| | Z0 | ext 78.033 Ohm | 78.047 Ohm | -1.8e-4 | | info | same |
| PK-08 bump-array-thermal (hF 1, 0.5, 0.25; 70,243 DOF finest) | R per bump cell | 237.824 K/W | [234.136, 239.047] K/W | inside (2.1 % wide) | range | pass | variational bounds, own derivation, `validation/pkg2/bump_bounds.py` |
| | R vs parallel column | 237.824 K/W | 206.869 K/W (no spreading) | +15.0 % | | info | 1D series formula |
| PK-09 hybrid-bond-pad, wide variant a = 10 h (hF 1, 0.5; 24,645 / 99,318 DOF) | pad-centre top rise | 2.902965 nm | 2.903591 nm | -2.2e-4 (levels agree to 1e-9) | 1e-3 | pass | thin-film closed form, own derivation, `validation/pkg2/pad_film.py` |
| | oxide top rise at the rim | -0.290139 nm | -0.290136 nm | +1.1e-5 | 1e-3 | pass | same |
| PK-09 real pad a = 1.5 h | protrusion over the oxide | 2.795 nm (dT = 100 K) | free 1.608, constrained 3.194 nm | inside | | info | engineering limits, not bounds |
| PK-10 waveguide-heater-3d (hF 1, 0.5; 313,740 DOF finest, 1.44 GB) | mean heater rise at 1 mW | 23.501 K | [18.042, 24.176] K | inside (34 % wide) | range | pass | variational bounds with exact layered fields, own derivation, `validation/pkg2/heater_layers.py` |
| | phase at 1 mW (3D core integral x section dn_eff / dT_core) | 0.21611 rad | infinite heater x L_h: 0.21656 rad | -2.1e-3 | | info | estimate (assumes the section temperature shape scales along y) |
| | mean core temperature rise | 9.07 K (whole modelled length) | | | | info | |
| PK-11 waveguide-heater-to (hF 1, 0.5; 353,343 DOF finest) | mean heater rise at 1 mW | 25.598 K | [19.493, 25.737] K | inside (32 % wide) | range | pass | same bounds, 2D series |
| | dn_eff at 1 mW over 20 um (TE0, 1550 nm) | 2.671e-3 | | | | info | no independent mode reference |
| | P_pi (heater 20 um) | 14.51 mW | | | | info | |
| | core rise | 13.63 K | | | | info | dn_eff / dT_core = 1.96e-4 1/K (Si dn/dT 1.82e-4 1/K) |

Inputs (all illustrative unless named): PK-07 W = h = 10 um, t = 2 um, eps_r 2.9; PK-08 bump radius 50 um, pitch 200 um, height 75 um, Si die 200 um, Si interposer 100 um, SAC305 k 61; PK-09 pad radius 1.5 um, thickness 1 um, cell radius 5 um, dT +100 K; PK-10 / 11 Si strip 500 x 220 nm, BOX 2 um, cladding 1 um, heater 2 x 20 um as a surface flux, model 30 x 30 um, substrate 15 um at 293.15 K.

### 4.2 Informative items and reasons

- PK-07 C', Z0 vs Hammerstad-Jensen with thickness: the source gives no accuracy for the thickness term (s.1.1); the BEM covers only the vacuum line (L'), a layered-dielectric BEM was not built.
- PK-09 real pad: no exact closed form or published non-COMSOL value for a pad with a / h ~ 1.5 was found in the time box; the free and constrained limits are engineering estimates, not bounds (the oxide's lateral push is not monotone in a provable way here).
- PK-10 / PK-11 phase: the engine has no 3D -> 2D cut transfer for the thermo-optic coupling (R1); the 3D phase is an estimate through the cross-section's dn_eff / dT_core. No independent mode solver reference.

## 5. Open items

- O1: PK-10 / PK-11 bracket is rigorous but 32-34 % wide; a tighter lower bound needs a trial field with the Si strip's local structure (e.g. a Ritz combination of several layered fields, or an own 2D reference solver). The FE values sit 0.5-3 % below the upper bound.
- O2: PK-08 range checked on the finest level only (the records carry no per-level values for result targets); the harness could report level values for range rules.
- O3: PK-09 uses a rigid wafer; a compliant Si substrate needs a prescribed u_r = alpha_Si dT r rim condition or an elastic substrate with a periodic rim (R2).
- O4: Overrides at 298.15 K remain (Si k, alpha; Cu alpha) until lane G1's material temperature lands; PK-09 holds alpha constant over 100 K above the Cu fit range (4-300 K).
- O5: ruff was not run (not installed in `validation/`).

## 6. Requests

- R1 (coordinator; couplings owner): thermo-optic coupling from a 3D heat solution to a 2D em-modes cut: `packages/physics/src/couplings/photonic.ts` requires the nodal field on the same study mesh (l.23, "is not nodal on the study mesh"). Proposal: optional coupling setting `cut: {axis: y, at: <length>}` (or `plane`) that samples the upstream 3D nodal T with `@amp/post` `sample` at the em-modes mesh nodes mapped into 3D, and an optional `average: [y0, y1]` to integrate along the propagation axis (phase of a finite heater). Then PK-10 can run heat (3D) -> em-modes (2D) in one study.
- R2 (lane G3, elastic): `displacement` BC values are constants (`packages/physics/src/elastic/index.ts` l.442-445, `q(spec, s[k], ...)`); allow a space expression (as `pressure` does with `compileField`, l.460) so a rim can follow u_r = alpha_Si dT r. Not blocking (PK-09 uses an exact frame change).
- R3 (harness, minor): range-rule targets report only the finest level; per-level values in the record would show convergence from below (O2).

## 7. Hand-off

Files (all new unless noted): `sims/{microstrip-thick,bump-array-thermal,hybrid-bond-pad,waveguide-heater-3d,waveguide-heater-to}.yaml`; `apps/web/src/lib/library/catalog-pkg.ts` (5 entries appended, RUN2, header comment); `validation/c/cases_ext/pkg2.py`; `validation/pkg2/{common_pkg2,strip_bem,bump_bounds,pad_film,heater_layers}.py`; `eval/expected/PK-0{7,8,9}.json`, `PK-1{0,1}.json`; `eval/cases/c/PK-0{7,8,9}.yaml`, `PK-1{0,1}.yaml` (built). Ids PK-12..19 unused. Rebuild a case after editing pkg2.py: delete its `eval/cases/c/PK-xx.yaml`, then `cd validation && uv run python c/build_cases.py`. Regenerate references: `cd validation && uv run python pkg2/<script>.py` (heater_layers about 20 s).
