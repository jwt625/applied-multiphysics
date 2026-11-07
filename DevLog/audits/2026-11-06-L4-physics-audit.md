# Audit 2026-11-06: lane L4 `@amp/physics` + `@amp/post` (DevLog-010)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Auditor | fresh-context audit subagent (no prior conversation; files inspected and rerun directly) |
| Target | `packages/physics/**`, `packages/post/**`, `DevLog/DevLog-010-physics-wave1.md` |
| References | CLAUDE.md; CONTRACTS-v0 C1, C4, C5 and changelog (to 16:27 PST); DevLog-001 s.4 heroes H1-H6, performance target "< 5 s in Chrome or Safari"; `eval/cases/a/{HT-01..04,SM-01,SM-02,EM-01,EM-04,AC-02,RF-21}.yaml`; `eval/expected/*.json`; `sims/*.yaml` |
| Edits | this file only. Scratch work in `<scratch>/l4audit/` (`run-gates.sh`, `gate-*.log`, `indep/export.ts`, `indep/export_el.ts`, `indep/post_check*.ts`, `py/check.py`, `py/em04_diag*.py`, `py/el.py`, `py/refs.py`). The gate scripts always write their own logs. The reruns wrote `logs/l4-heat-20261107T002751Z.jsonl`, `l4-elastic-20261107T002751Z.jsonl`, `l4-em-20261107T002756Z.jsonl`, `l4-modes-wo01-20261107T002806Z.jsonl`, `l4-ac02-20261106T162806.jsonl`, `l4-rf01-20261106T162811.jsonl` and `l4-modes-wo02-20261107T002813Z.jsonl` |
| Load | 8+ other lanes were active (L2, L5, L8, L9, rt logs written in the same window), so wall times are noisy |

Verdict: **1 blocking, 7 significant, 12 minor.**
- Tests, tsc and every gate number reproduce the DevLog.
- The formulations are correct. Six independent checks agree with the engine to 1e-8 to 1e-15 on the engine's own meshes: HT-01, EM-04 axisym (including the 1/r terms), plane stress and plane strain, AC-02, RF ND1, and the EM-02 truncation analysis.
- The blocking item is a claim, not a solver bug: H5 "< 5 s at 1e-5" rests on a Richardson extrapolation with an anomalous observed order from a pre-asymptotic level.

## 1. Reruns (item 1)

| Check | Command (nice 10, heap 1536 MB, one at a time) | Result | DevLog claim |
|---|---|---|---|
| physics tests | `node --test --test-concurrency=1 test/*.test.ts` | 33/33 pass, 3.8 s | 33, ~5 s |
| post tests | `node --test test/*.test.ts` | 4/4 pass, 0.13 s | 4 |
| tsc | `tsc -p . --noEmit` and `-p ../post` | exit 0, exit 0 | clean |
| gates/heat.ts | | 0.9 s; HT-01..04 PASS; values identical to s.4.1 to the printed digits | as s.4.1 |
| gates/elastic.ts | | 5 s; SM-01 (4 targets + L2 rates 1.88/1.97/1.99) and SM-02 PASS; K_t(W/D) list identical | as s.4.1 |
| gates/em.ts | | 10 s; EM-04, EM-03, EM-01, EM-02 PASS; numbers identical; EM-03 all levels 5.30 s (DevLog 4.54 s), L0 0.77 s (0.70 s) | as s.4.1 (timing noise) |
| gates/modes-wo01.ts | | 0.4 s; TE0 4.76e-10, TM0 1.30e-9 PASS | 4.8e-10 / 1.3e-9 |
| gates/modes-wo02.ts | | 68 s; rib 8/8 (max Richardson err 7.84e-7), box 4/4 PASS | <= 7.8e-7, about 60 s |
| gates/ac-02.ts | | 5 s; tet10 10/10 PASS (worst f_mode8 -7.19e-6), 2.05 s all levels; hex8 PASS | -7.2e-6, 1.7 s |
| gates/rf-01.ts (default `--levels 2,3,4`) | | 2 s; TM010/TE111/TM011 PASS, TM110/TE211/TE011 **FAIL**; prints "gate FAIL", exit code 0 | see B1, S1, M11 |
| gates/prepare-smoke.ts | | 5/6 run, si-rib-waveguide not ready (n N/A) | as s.3 16:20 |
| gates/harness-demo.ts | | HT-01 via the harness worker: T_E 18.253729 C, status `fail` "richardson unavailable (oscillatory)" | as s.3 16:20 |

No single run exceeded 3 min. The DevLog's N = 4, 5, 6 RF log (`logs/l4-rf01-20261106T160210.jsonl`) was read rather than rerun (22 s). It matches the DevLog row.

## 2. Formulation review (item 2)

| Module | Checked | Verdict |
|---|---|---|
| common/scalar | K, M, F with weight r; Robin facet term h N_a N_b w dS; Dirichlet elimination; quadrature degree 2p (+1 for axisym), facet degree 2p + 2 | correct |
| heat | Radiation residual eps sigma (T^4 - T_amb^4) N_a with tangent 4 eps sigma T^3 (Newton on the residual, sign correct). Convection h (T_ext - T) as Robin. BDF2 a = 3/(2 dt) with history (2 T^n - T^{n-1}/2)/dt, BDF1 first step (global O(dt^2) kept; HT-02 p_obs 2.22). Dirichlet f(x, t) applied at t_{n+1}. Factor reuse is correct: it refactors when a changes | correct |
| elastic | Plane stress D = E/(1-nu^2)[..]; plane strain lambda + 2 mu. Thermal strain factor (1 + nu) in plane strain (checked: 2(lambda + mu)(1 + nu) = 3 lambda + 2 mu). s_zz = nu (s_xx + s_yy) - E alpha dT. 3D Voigt with engineering shear. Pressure traction -p n with the outward normal fixed by the cell centroid | correct; independently verified (s.3) |
| magnetostatics | Energy form (1/mu)[A_z w_z + (A_r + A/r)(w_r + w/r)] r; J = N I / area; A = 0 on r = 0 and on the far arc; A/r evaluated only at quadrature points; nodal B_z on the axis uses A/r -> dA/dr. Inductance L_ij = 2 pi int A_j J_i r / (I_i I_j); W = pi A.F | correct; independently verified (s.3). Axis detection `r === 0` exactly (M4) |
| far-boundary claim | Dipole image for B_n = 0 on a sphere R_b: uniform H = -2m/(4 pi R_b^3), so dB = -mu0 m/(2 pi R_b^3). For a Helmholtz pair (m = 2 pi R^2 I) this gives -(R/R_b)^3 / 0.8^1.5 = -1.397542 (R/R_b)^3 (recomputed). Measured (B30 - B100)/B0 = -5.0391e-5 vs predicted -5.0363e-5 | confirmed |
| electrostatics | Weight r with factor 2 pi; energy-form Maxwell C_ij; L' = mu0 eps0 / C'_0 | correct; potentials are ignored when a terminal exists (M1) |
| em-modes (EO port) | Lee-Sun-Cendes pencil with e_t' = e_t + grad e_z. SI -> um conversion `UM = 1e6` on nodes and wavelength. P_z uses 1e-12 (um^2 -> m^2), consistent. Straight triangles only (documented). Tests G1/G2/G4/G7/G9 check closed forms | correct as tested |
| emw 3D | Covariant Piola N = J^-T N_ref, curl = J curl_ref / det J, mass uses \|det J\|. Discrete gradient G (±1 vertex, 1 for hierarchical edge DOFs) on the free H1 DOFs. The M-orthogonal projector removes the gradient space (div residual 7e-16 to 8e-16 in the rerun). Shift sigma = (2 pi 2.5 GHz / c0)^2 from the case. Spurious filter lambda > 1e-6 lamScale. Q_d = x'Mx / x'(tan_delta M)x | correct; ND1 independently verified (s.3); curved ND2 checked by convergence only |
| acoustics | K = int grad p . grad q, M = int p q / c^2, weight r for axisym m = 0 | correct for one fluid; density ignored (S6) |
| length scale | `@amp/physics` does not import `tri-fe`. Its only core FEM imports are `hcurl`, `space`, `quadrature` and `tri.triangleGeometry` (the last used by em-modes in um, which is self-consistent). Scalar, elastic, magnetostatics and em3d assemble in SI metres. The post test integrates a 1 m x 1 m square to 1 m^2 | SI throughout |
| C1 literals | No material property literal in `src/`. Constants carry sources: SIGMA_SB, EPS0, MU0, C0, ETA0 (CODATA 2018). Gates contain modelling choices (s = R/100, R_b = 100 R) and the Celsius offset | clean; one hidden default (M2) |

## 3. Independent verification (item 3)

Each check solves the same discrete problem on the mesh exported from the engine (`indep/export.ts`, `indep/export_el.ts`) with scikit-fem 12.0.2 / SciPy 1.18.1 (`uv run --with scikit-fem --with numpy --with scipy`, BLAS threads 2). The reference values are also recomputed independently.

| Hero | Independent solve | Mesh | Engine | Independent | Rel diff |
|---|---|---|---|---|---|
| H2 HT-01 | skfem P2, Robin facets, Dirichlet 373.15 K | engine `rectTriMesh` n = 20, tri6, 2,220 dof | T_E 18.2584629322 C | 18.2584629323 C | 1e-13 |
| H2 HT-01 ref | Own separation of variables (lambda tan(lambda W) = h/k, 2000 terms) | - | expected 18.253756537134 | 18.2537565371 | < 1e-11 |
| H3 EM-04 | skfem P2 with the axisym A_phi form, including the A/r terms; Dirichlet on axis and far-arc facets | engine L0 `mesh2d` vertices, 11,314 dof (19 curved far cells taken straight) | W_m 7.391616546e-7 J; B_z(0,0) 8.9916756442e-6 T | 7.391616517e-7 J; 8.9916757241e-6 T | 3.9e-9; 8.9e-9 (A_phi(0.02, 0.01) 1.0e-8) |
| H3 EM-04 ref | Biot-Savart pair, mu0 CODATA 2018 | - | expected 8.991762854545e-6 | 8.991762860627e-6 | 6.8e-10 (mu0 convention) |
| H1 SM | skfem vector P2, plane stress and plane strain, fixed + traction + pressure | engine `rectTriMesh` 20 x 4 tri6 | nodal u | nodal u | 2.9e-12 / 2.4e-12 (max \|du\| / max \|u\|) |
| H6 AC-02 | skfem P2 tets, `eigsh` shift-invert sigma = -1 | engine Kuhn box s = 1, tet10, 693 dof | f_1..f_10 | same | max 1.2e-14; engine raw err f_1 9.22e-5 = gate table |
| H6 AC-02 ref | Box modes (c/2) sqrt(sum (n_i/L_i)^2) | - | expected list | identical (6 decimals) | 0 |
| H5 RF | skfem `ElementTetN0` (ND1), PEC on every boundary DOF, `eigsh` at sigma = (2 pi 2.5 GHz/c0)^2 | engine `cylinderTetMesh` tet4 N = 3, 906 free dof (engine also 906) | 4 lowest f | same | max 1.6e-15 |
| H5 RF ref | Bessel zeros (scipy `jn_zeros`, `jnp_zeros`) | - | RF-21 expected, 6 modes | identical (9 decimals) | 0 |
| EM-02 | First-order grounded-shell shift C' = (C^-1 - 11^T/(4 pi eps0 R_out))^-1, R_out = 1000 m | - | gate errors 3.97e-6 / 1.39e-5 / -2.59e-5 | predicted 3.956e-6 / 1.387e-5 / -2.591e-5 | the whole gate error is the shell; FE error < 1e-7 |
| EM-01 ref | C' = 2 pi eps0 eps_r / ln(b/a) | - | expected 9.325647296e-11 F/m, 51.83343117 Ohm | 9.32564729e-11, 51.8334312 | < 1e-9 |

My first EM-04 attempt differed by 2e-6. The cause was my own check: radius-based Dirichlet selection missed the straight-edge midpoint DOFs on the far arc. With facet-based selection the solves agree to 4e-9. Curved ND2 on tet10 (the H5 hero configuration) was not independently assembled because scikit-fem has no second-order tetrahedral Nedelec element. It is covered only by the engine's own convergence to the exact Bessel values.

## 4. Findings

### Blocking

**B1. The H5 "< 5 s at the case accuracy" claim depends on an unreliable extrapolation.**
- Evidence: rerun of `gates/rf-01.ts` with its default levels N = 2, 3, 4.
  - TM010 raw error at N = 4 is 2.24e-5 (above rel 1e-5).
  - Richardson over N = 2..4 gives p_obs 5.48, err_ext 1.89e-6, PASS. The theoretical order of ND2 eigenvalues is 4.
  - With p = 4 assumed (the script's own info column), err_ext is -1.41e-5: **FAIL**.
  - The run ends "gate FAIL" yet prints "<5 s at the gate accuracy: yes", because the line tests only `total < 5000`.
- TM010 converges robustly (p 4.77, 3.0e-7) only on N = 4, 5, 6, which takes 22 s total and 14.9 s for the finest level (`logs/l4-rf01-20261106T160210.jsonl`).
- DevLog s.4.1 ("H5 yes for the three hero modes (2.2 s)") and the DevLog-001 16:27 status line therefore overstate H5.
- Fix:
  - Correct both texts: H5 meets 1e-5 in 15-22 s in Node, not in < 5 s.
  - In the gate, accept Richardson only when p_obs is within about ±25 % of the theoretical order, otherwise use the assumed order with a safety factor of 3.
  - Print "<5 s" only when the gate passes.
  - Pursue the DevLog's own options (AMS-preconditioned iterative shift-invert, or a 2D axisym per-m solver).

### Significant

**S1. Gate scripts exit 0 on failure, so `run-all.ts` always reports success.**
- Evidence: `heat.ts`, `elastic.ts`, `em.ts`, `ac-02.ts` and `rf-01.ts` never set `process.exitCode` (only `modes-wo01.ts` and `modes-wo02.ts` do). `rf-01.ts` printed "gate FAIL" and exited 0 (`gates-summary.log`). `run-all.ts` counts non-zero exits.
- Fix: `process.exitCode = allPass ? 0 : 2` in each script.

**S2. Gate Richardson policy differs from the case rule and from L8, in both directions.**
- `gates/common.ts evaluate()` silently uses the finest value when the observed order is unavailable.
  - SM-01 K_t (3.000150 after 2.963, 3.0009, 3.00008: oscillatory) and syy_hole_side are gated on the finest value although the case says `after: richardson`.
  - L8 fails the same situation (harness-demo: "richardson unavailable (oscillatory)").
- It also uses the extrapolation for any p_obs:
  - EM-01: p 1.88 on non-nested CDT levels. Finest error is +8.5e-7, extrapolated -6.9e-6, so extrapolation made it 8x worse. The DevLog reports the worse number.
  - SM-02: p 7.80.
  - RF TM010: p 5.48 (B1).
- Fix:
  - One policy, shared with L8 (contract request 3): per target, report the basis (richardson / finest / pending).
  - Bound p_obs by the theoretical order.
  - On "finest" targets, pass on \|finest - ref\| + spread of the last two levels.

**S3. `@amp/post` cannot evaluate Nedelec fields.**
- Evidence: `evaluateField` throws "space NED1 not supported (export an H1 or DG0 projection)" (`indep/post_check.ts`).
- `emw` Solutions carry only `E` as NED1/NED2 coefficients in `@amp/core` `buildSpace` numbering. No consumer in post, eval or apps/web evaluates them.
- DevLog s.1.1 planned "P1/P2/Nedelec interpolation". The H5 "animated E/H" view and any RF field or probe target are blocked.
- Fix:
  - Either export a cell-wise projection (E and H at cell centroids, DG0, 3 components; `centroidFields` already computes E), or
  - add NED evaluation to post with the edge/face DOF map attached to the Solution.
  - Add a test against an analytic cavity mode.

**S4. Readiness does not report N/A material values, N/A BC quantities or a missing transient T0.**
- Evidence: `sims/heat-plate-fin.yaml` has `k: N/A`, yet `heatModule.readiness` returns ready true (prepare-smoke). Without the eval case, `run` throws "material 'solid' has no value for 'k'".
- Only em-modes checks `n` N/A. Heat readiness also misses `settings.T0` for time studies (run throws).
- Fix: readiness checks, per module:
  - the overrides of the needed properties for N/A (a `ref:` can be deferred);
  - BC quantities for N/A;
  - T0 for time studies;
  - nModes for eigen studies.

**S5. C5 timing has no geometry or mesh stage on the module path, and no measured "< 5 s" is end to end.**
- Module Solutions report only assemble/factor/solve/post (em-modes adds a non-standard `model` stage).
- `prepareRun` (validation, geometry, mesh, materials) is not timed. The L8 worker `wall_ms` includes it, but `stages` do not.
- Gate totals:
  - elastic and em include `mesh2d` and `buildGeometry2D`;
  - heat gates exclude the mesh build;
  - none includes spec validation or material resolution, a Worker, or a browser.
- DevLog-001 sets the target in Chrome/Safari. DevLog-010 discloses "Node single-thread, not browser".
- Fix: `prepareRun` records `validate`, `geometry`, `mesh` and `materials` times on the context, and modules merge them into `Solution.timing`. Report prepareRun + run wall time per hero, and a browser figure when L5 can measure it.

**S6. Acoustics ignores density.**
- `K = int grad p . grad q` and `M = int p q / c^2`. Correct for one fluid. For several fluids the interface condition (1/rho) dp/dn continuous is violated silently. The module accepts such specs; `prepare.ts` NEEDS already lists rho.
- Fix: per cell k = 1/rho and m = 1/(rho c^2), or a readiness reason when more than one fluid is present.

**S7. Mesh warnings reach `prepareRun(...).notes`, which nothing reads.**
- Evidence: `grep notes` finds no consumer in `packages/eval/src` or `apps/web/src`, so L3 warnings (slivers, sub-resolution boundaries) are dropped.
- Fix: the harness stores `notes` per level and the web Messages tab shows them; or C4 v1 `readiness(spec, id, mesh?)` (contract request 8).

### Minor

- **M1** Electrostatics: `potential` BCs are ignored whenever a terminal exists.
  - Evidence: `Vs` is solved only for terminals, with potential nodes held at 0. The applied-potential field is never produced, with no message.
  - Fix: solve the applied case as an extra step, or add a readiness reason.
- **M2** emw: an absent `tan_delta` silently becomes 0 (`td[c] = 0`), a hidden default under C3.
  - Fix: require it, or record an assumption in the Solution.
- **M3** RF-21 Q_d gate is tautological: with a homogeneous fill Q_d = 1/tan_delta for any field (2500.000000, err 0). Keep it as info. A real check needs a partially filled cavity.
- **M4** Magnetostatics finds axis nodes by `nodes[2 i] === 0`. Nodes at 1e-17 would stay free, and the A/r penalty would only approximately pin them.
  - Fix: a tolerance relative to the bounding box.
- **M5** Locator returns NaN for points within 1e-3 a of a curved tet10 wall: 304 of 4000 at N = 2, 27 at N = 4 in the band [0.999 a, a).
  - Brute force over all cells finds none of them, and reference tolerance 1e-3 finds all of them. So they lie outside the isoparametric domain, which is correct per contract.
  - Wall probes need a snap option.
  - tri6 curved-hole and hex8 checks: 0 NaN, errors 1.6e-8 (isoparametric) and 4e-16.
- **M6** EM-02, EM-03 and WO-02 references are computed or hard-coded in gate scripts; there are no eval case or expected files.
  - "Tolerances fixed before the run" cannot be checked: the s.4.3 header says 16:20 PST, while the log says the EM gate runs started 16:17.
  - Fix: file the cases (L7c) and read them.
- **M7** Mesh sequences were changed after first failures: HT-04 levels 10..80 to 20..160; EM-04 gained a core refinement box; elastic grading is now scaled per level. All are disclosed refinement corrections, not target tuning; the finest raw values pass by 100x or more.
  - One weak point: EM-04 uniformity is not converging (1.1388e-4, 1.1451e-4, 1.1424e-4 vs 1.1394e-4). It passes the abs 2e-5 limit with error 3e-7.
- **M8** `ac-02.ts` and `rf-01.ts` stamp logs in local time without a zone (`l4-rf01-20261106T162811`); the other gates use UTC `Z`.
- **M9** Cyclic package dependency: `@amp/physics` depends on `@amp/post`, and `@amp/post` imports `@amp/physics/common/{mesh,lagrange}`.
- **M10** DevLog s.1.1 names `src/spec-adapter.ts`, and the contracts changelog (16:15) cites it. The file is `src/prepare.ts`.
- **M11** Table and printout clarity:
  - EM-03 prints "PASS M_ab_palace" for a target the DevLog calls ungated.
  - The RF row reports TE211 pass from N = 4..6, while the default gate (N = 2..4) gives TE211 FAIL (-1.12e-5). State the levels per row.
  - TE011 converges at p of about 4 from a large constant (+7.9e-5 at N = 6). TM110's error grows from N = 3 to 4 (5.4e-5 to 6.9e-5) before reaching p of about 4 at N = 5..6. This supports "pre-asymptotic".
- **M12** `run-all.ts` spawns the gates without `nice`.

## 5. Eval honesty (item 4)

- No reference value is read back as a result. Every gated value comes from `sample()` on an engine Solution or from engine scalars. `src/` never reads `eval/expected`.
- `prepareRun` fills N/A material inputs from the eval case's `materials` block (inputs, logged in `notes`), never outputs.
- RF mode matching chooses, within the TE/TM and azimuthal family, the computed mode nearest the reference. This is matching, not substitution.
- No gate tolerance is loosened relative to its case. The DevLog sets EM-02/03 limits itself; there is no case file (M6).
- Convergence claims: every gated hero has 3 or more levels (HT 4, SM 4, EM 3, WO 3-4, AC 3, RF 3-4), and Richardson always uses the three finest. Caveats are S2 and B1.
- C1 literals: clean (s.2).

## 6. Run records (item 5)

- RunRecord fields are filled:
  - `engine '@amp/physics@0.0.1+dirty'`;
  - `specHash` (spec, or a problem digest for programmatic runs);
  - `meshHash`;
  - `startedAt` ISO with offset (e.g. `2026-11-06T16:28:11.204-08:00`);
  - `platform {runtime: node, ua, cores}`;
  - `fidelity rigorous`.
- The optional `tagHash` and `oplogHead` are absent.
- Stage times are real `performance.now()` spans. em3d and acoustics subtract the factor time from `solve` correctly.
- The missing mesh stage and the other timing gaps are described in S5. The "< 5 s" claims are gate-script wall times in Node, not end to end.

## 7. Recommended order

1. B1 (correct the claim)
2. S1 and S2 (gate semantics)
3. S3 (NED evaluation for the H5 view)
4. S4 and S7 (readiness and notes)
5. S5 (timing)
6. S6
7. Minors
