# Audit: M2 engine half, hero integration I1 (2026-11-06)

| Field | Value |
|---|---|
| Date | 2026-11-06 (runs 17:24-17:36 PST) |
| Auditor | fresh-context audit subagent (no prior conversation) |
| Claim | DevLog-014 and DevLog-001 s.13 (17:24): H1-H6 pass their eval gates end to end on the real engine through the harness (spec -> geometry -> mesh -> solve -> extract -> gate), nested levels [1, 0.5, 0.25] |
| Audited state | commit `2a8b2ca` (= `ef3cc9b` I1 + a docs-only commit). The harness run record says `@amp/eval@0.0.0+2a8b2ca`, engine `@amp/physics@0.0.1+dirty` |
| Context read | CLAUDE.md; DevLog-001 s.5-s.10 and s.13; DevLog-014; DevLog-011 s.4; CONTRACTS-v0 and its changelog; eval/README.md; eval/cases/a (hero cases), eval/cases/b/WO-41.yaml; eval/expected; sims/ (gate and hero specs); packages/eval/src (cli, registry, engine-worker, evaluate, source); packages/physics/src/prepare.ts, em-axisym, em3d (Q_d) |
| Files changed | this file only. Harness output went to scratch with `--out`. No git, no installs |
| Scratch | `<session-scratchpad>/`: `run1/` (class a run), `run2/` (AC-02 `--speed`), `scripts/probe.ts` (per-level solve, axisym mode labels, ellipse check), `scripts/nested.ts` (node-subset check), `scripts/prepcache.ts` (prepareRun cold vs cached), `scripts/le1_check.py` (independent LE1 solve) |
| Concurrent changes | 9 commits landed during the audit (`595f561` .. `598154b`, 17:26-17:35): L8 fallback rule, L4 box levels and mesh cache, L7a/L7c case edits, web pass 2. The class-a reproduction ran on `2a8b2ca`. The axisym and LE1 probes ran before `30c89b9`, the only commit that touched `prepare.ts`. The nested, prepcache and AC-02 `--speed` runs ran on HEAD and are labelled as such |

## Verdict

The pass claim holds. I reproduced the class-a run bit for bit: 9 pass, 2 fail, 18 pending, 0 error. All 41 non-pending targets have the same value, status and mesh hash as I1's final run (`logs/eval-20261106T172055.jsonl`). Cold times agree within 6 %. The values come from the engine. The specs use the case inputs. I1 changed no tolerance, expected value or reference. The levels are truly nested (coarse nodes are a subset, cells x4 in 2D and x8 in 3D).

The RF-21 axisymmetric reduction is exact for every mode. The sorted-index extraction picks the right mode (m, TE/TM) on every level.

I agree with I1's diagnoses of SM-02, HT-04 and WO-41. For SM-02 an independent P2 solve converges to 92.658 MPa, the engine's value, and not to FeenoX's 92.7011.

The engine half of M2 is not complete as stated. M2 requires < 5 s:
- H6 misses it: 8.4 s cold, 6.25 s warm in I1's run, 5.43 s warm on HEAD.
- H5 is reported at 2.14 s, but its gate (RF-21 7/7) includes Q_d on the 3D path. That target takes 13.1 s and makes the case 15.2 s.

Several reported numbers are artefacts or are mixed:
- The WO-01 and HT-04 observed orders come from a harness bug that uses the case dimension.
- "Warm" times reuse cached meshes.
- DevLog-001 quotes warm times for some heroes and cold for others.

The browser has no timing at gated accuracy. Its hero solves are single coarse levels of different specs; for example, the box at 693 DOF is 3.3e-3 off against a 1e-4 tolerance.

**Verdict: accuracy gates met; speed and reporting not.**

## 1. Reproduction

Command: `nice -n 10 node --max-old-space-size=1536 packages/eval/src/cli.ts --class a --out <scratch>/run1`. Wall time 40.4 s, peak RSS 1.52 GB for the whole process (workers included), exit 2 (SM-02 and HT-04 miss).

| Case | Status | Gated pass | Finest DOF | Time I1 (ms) | Time audit (ms) | Gate route |
|---|---|---|---|---|---|---|
| SM-01 | pass | 5/5 | 65,104 | 1,272 | 1,201 | K_t Richardson p 2.29; syy, ux, uy fallback (p 2.57 / 3.73 / 3.27 vs 2); field L2 1.36e-4, rate 2.05 |
| SM-02 | fail | 0/1 | 65,056 | 1,323 | 1,342 | fallback, oscillatory, |e| not monotone |
| HT-01 | pass | 1/1 | 39,036 | 508 | 536 | Richardson p 2.82 |
| HT-02 | pass | 1/1 | 3,359 | 542 | 559 | fallback (oscillatory) |
| HT-03 | pass | 1/1 | 1,648 | 142 | 145 | finest, 2.1e-12 |
| HT-04 | fail | 3/4 | 9,125 | 3,550 | 3,554 | 0.0223: Richardson (artefact, S1); 0.0859: fallback fails; 0.1866, 0.3462: fallback |
| EM-04 | pass | 3/3 | 184,973 | 2,166 | 2,205 | B_center, Bz fallback (p 3.95 / 3.70 vs 2); Br abs |
| EM-01 | pass | 3/3 | 9,632 | 260 | 281 | Richardson p 3.69 |
| WO-01 | pass | 2/2 | 137,529 / 143,927 | 1,471 (TE0) | 1,546 (TE0), 1,950 (TM0) | fallback (reported p 1.92 / 2.04: artefact, S1) |
| RF-21 | pass | 7/7 | 68,117 axisym; 90,424 3D | 2,142 (freq.) | 2,191 (freq.), 13,052 (Q_d) | 6 frequencies Richardson p 3.74-3.95; Q_d finest |
| AC-02 | pass | 10/10 | 33,825 | 8,317 | 8,427 | Richardson p 4.03-4.24 |

Values are identical to I1's run for 41/41 targets (value, status, meshHash).

## 2. Integrity of each pass

### 2.1 Values from the engine

- Source `engine`. Each level carries its own mesh hash and run record, and values change with the level: AC-02 f_mode1 is 171.5158 / 171.5011 / 171.5001 Hz.
- `packages/physics` and `packages/post` do not read `eval/expected` (grep; the one hit is a comment in magnetostatics).
- The expected JSON supplies only `ref`.
- `prepareRun` can fill missing material values from the case's `materials` block (inputs, not references). No gate spec relies on this: all of them give `override` values.

### 2.2 Spec inputs vs case statements

| Case | Geometry | Materials | BCs / study | Note |
|---|---|---|---|---|
| SM-01 | quarter 50 mm, a = 5 mm | E 200 GPa, nu 0.3 | rollers, free hole, exact Kirsch traction on x = L, y = L | traction expressions checked by hand against the Cartesian Kirsch field: (sxx, sxy) on x = L, (sxy, syy) on y = L |
| SM-02 | ellipses 2 x 1, 3.25 x 2.75 m, quadrant | E 210 GPa, nu 0.3 | rollers; `pressure p = -10 MPa` (traction -p n, i.e. outward) | ok |
| HT-01 | 0.6 x 1.0 m | k 52 | 100 C on y = 0, insulated x = 0, h 750 to 0 C on x = 0.6, y = 1 | ok |
| HT-02 | 0.1 m bar as a 5 mm strip, long sides insulated | k 35, rho 7200, cp 440.5 | 0 C; 273.15 + 100 sin(pi t / 40 s) K; T0 0 C; 32 s | dt 0.05 s fixed (S4) |
| HT-03 | 0.1 m rod as a strip | k 55.6 | 1000 K; radiation eps 0.98 to 300 K | ok |
| HT-04 | 2.0 m strip | k 54, rho 7833, c 465 | h 50 to 1000 C; insulated far end; T0 0 C; 2000 s | BDF2 dt 1 s (modelling choice) |
| EM-04 | R 0.1 m, z +-0.05 m, 1 A | mu_r 1 | magnetic insulation on a box of half-size 100 R | square coil section s = R/100 replaces the filament; truncation shift about -1.4e-6 B0 (case formula for a sphere), far below 1e-3 |
| EM-01 | a 0.5 mm, b 1.75 mm | eps_r 2.1, mu_r 1 | terminal / ground | ok |
| WO-01 | 220 nm core, 2.5 um cladding, PEC on the outer y walls | n 3.477723756 / 1.444023622 | TE0: PEC on the x walls; TM0: PMC (natural) on the x walls; 1.55 um | evanescent amplitude at the wall exp(-gamma 2.5 um) gives truncation of order e^-50 (TE0) / e^-30 (TM0), negligible |
| RF-21 | a 2.74 cm, h 2a | eps_r 2.08, mu_r 1 (axisym, lossless); 3D Q_d spec adds tan_delta 4e-4 | PEC | lossless frequencies differ from the lossy real part by about 3 tan_delta^2 / 8 = 6e-8, far below 1e-5 |
| AC-02 | 1 x 0.8 x 0.6 m | c 343, rho 1.2 | sound-hard | ok |

Every value matches the case. Each override has a `provenance.values` entry naming the case file.

### 2.3 Case edits since 6406f8c

- `git diff 6406f8c 2a8b2ca -- eval/cases/a` changes only `spec:` (pending to `sims/...`), per-target `spec:` (WO-01 TM0, RF-21 Q_d), `extract`, `convergence.h_factors: [1, 0.5, 0.25]` and `expected_order`. SM-06 `extract` changed from `offset: 3` to `index: k`.
- No `value`, `tolerance`, `expected`, `provenance` or `basis` line changed.
- The class-a expected JSONs are untouched. The expected-file changes in that range come from the L7b/L7c commits for classes b and c.
- Class b (`ef3cc9b`): only `metric_id` insertions and the WO-02 pending reason.

The expected orders are not tuned. EM-04 keeps 2 against an observed 3.7-3.95, and WO-01 keeps 4 against a reported 1.9. Both choices pushed targets onto the fallback, not into Richardson.

### 2.4 Nestedness

`scripts/nested.ts`: every node of level k is a node of level k+1, with 0 missing, for kirsch-exact, nafems-le1, box-acoustics (HEAD direct-doubling path), cylinder-cavity-axisym, cylinder-cavity-qd, semi-infinite-convection, si-slab-te0 and helmholtz-em04. Cells grow x4 per level in 2D and x8 in 3D.

SM-02 curved boundaries: nodes on the inner and outer ellipse lie on the exact curve to < 1e-12 on all four levels, with counts 121 / 241 / 481 / 961 on the inner ellipse. The geometry is not frozen at the coarse polygon.

### 2.5 Richardson orders

Targets where Richardson was available:

| Case | Observed p | Theory |
|---|---|---|
| AC-02 | 4.03-4.24 | 4 |
| EM-01 | 3.69 | 4 |
| HT-01 | 2.82 | 3 |
| RF-21 frequencies | 3.74-3.95 | 4 |
| SM-01 K_t | 2.29 | 2 |
| HT-04 x = 0.0223 | 2.28 (artefact, S1) | 3 |

All are within the 0.25 band. Of the 36 passing gated targets:
- 22 pass via Richardson;
- 10 via the finest + monotone fallback (EM-04 x2, HT-02, HT-04 x2, SM-01 x3, WO-01 x2);
- 4 on a plain tolerance or rule (HT-03, Br_probe, Q_d, field L2 rate).

DevLog-014 reports the fallback routes correctly.

## 3. RF-21 via emw-axisym

- **Validity.** The cavity is a body of revolution with an isotropic, homogeneous fill and PEC on every wall. The operator commutes with rotations, so the modes separate exactly into e^{i m phi}. Every m >= 1 mode is a cos / sin pair in 3D and is solved once per |m|.
- **Coverage.** All six RF-21 modes have m in {0, 1, 2}: TM010 0, TE111 1, TM011 0, TM110 1, TE211 2, TE011 0. No approximation is made. The 3D multiplicity is not represented, and no target needs it.
- **Mode identity per level** (`scripts/probe.ts axisym`: `m_k`, `ezFraction_k` from the Solution). Indices 0, 1, 2, 5, 3, 8 carry (m, ezFraction) = (0, 1.0), (1, ~1e-6..5e-9), (0, 0.70), (1, 1.0), (2, ~4e-6..2e-8), (0, 2.5e-26..5.4e-24) on all three levels. That matches TM010, TE111, TM011, TM110, TE211 and TE011 (TE: E_z = 0). Index 7 is TM111 (m 1, 0.856) on all levels.
- **Degeneracy.** TE011 and TM111 are exactly degenerate but have different m, so the axisym path cannot mix them; this is better than 3D. Their order in the merged list depends on discretization error. TM111 converges faster: 5,000,324,476 / 5,000,158,138 / 5,000,147,107 Hz, against 5,002,059,647 / 5,000,275,173 / 5,000,155,074 Hz for TE011. The margin is 8 kHz at the finest level. The order is stable here but fragile under non-nested or graded meshes (M1).
- **Q_d from the coarse 3D spec meets its own rule.** It has 3 nested levels (1,006 / 10,180 / 90,424 DOF, h = 4a / 2a / a), and the finest level is within rel 1e-3. The rule does not test the solver, though. `em3d` computes Q_d^-1 = sum tan_delta eps int|E|^2 / sum eps int|E|^2, which equals tan_delta for a homogeneous fill on any mesh and for any mode. The values are 2500 +- 2e-11 on every level, including the 1,006-DOF level. The spec header says so itself. The target costs 13.1 s, 86 % of the RF-21 case time (S6).
- **Substitution.** H5's gate in DevLog-001 s.8 is RF-01 (class c). I1 gates RF-21 (class a, `hero.suitable: false`, the "analytic twin" of RF-01). The substitution is not recorded in the s.8 table (M2).

## 4. Speed

What the times contain (`engine-worker.ts` `once()`): `prepareRun` (validate, geometry, mesh including the nested refinement, materials) plus `module.run` (assemble, factor, solve, post). Not included:
- YAML parse of the spec (parent process);
- worker spawn and module import;
- target extraction and sampling after the solve.

The per-case overhead is about 0.5-1 s from the harness timestamps (AC-02: 9 s between case starts vs 8.4 s measured).

Cold vs warm:
- "Cold" is the accuracy run: the first call per level in a fresh worker, including JIT warm-up.
- "Warm" (`--speed`, 1 warm-up + median of 5 per level) re-runs `prepareRun` with the mesh chain cached:
  - At `2a8b2ca` a cached call rebuilt the base mesh but skipped `refineUniform`. For example, EM-04 finest geometry_mesh is 27 ms warm (I1 speed log) against 421 ms cold (`scripts/prepcache.ts`).
  - On HEAD (`30c89b9`) a cached call skips all meshing (geometry_mesh 0.0 ms).
- So warm medians measure re-solving on an existing mesh, not an edit-to-result loop (S2).

| Hero | Gate group | Cold, I1 / audit (s) | Warm, I1 (s) | < 5 s in Node |
|---|---|---|---|---|
| H1 | SM-01 | 1.27 / 1.20 | 0.83 | yes |
| H2 | HT-01, HT-02, HT-03 | 0.51 / 0.54; 0.54 / 0.56; 0.14 / 0.15 | 0.19; 0.42; 0.02 | yes |
| H3 | EM-04 | 2.17 / 2.21 | 1.18 | yes |
| H4 | WO-01 TE0 + TM0 | 3.40 / 3.50 (1.47 + 1.93; 1.55 + 1.95) | 0.92 (TE0 only); TM0 not measured | yes |
| H5 | RF-21 frequencies (axisym) | 2.14 / 2.19 (a single repeat: 1.70) | not measured | yes for the frequencies |
| H5 | RF-21 whole case (+ Q_d 3D) | 15.0 / 15.2 | not measured | **no** |
| H6 | AC-02 | 8.32 / 8.43 | 6.25 (HEAD after `30c89b9`: 0.04 + 0.24 + 5.14 = 5.43, `run2/`) | **no** |

Browser timing for the gated specs is not measured. L5's browser numbers (DevLog-011 s.4.2) are for other runs:
- single-level loads of the hero specs: kirsch-plate, heat-plate-fin, helmholtz-coil, box at 693 DOF, cavity 3D before the axisym switch, rib;
- none of them was measured at the gated accuracy (S3).

## 5. The two fails and WO-41

**SM-02: agree.**
- Engine levels: 92.66602 / 92.65742 / 92.65763 MPa, and 92.65804 at a 4th level (258,752 DOF, `scripts/probe.ts`).
- Independent check (`scripts/le1_check.py`): isoparametric tri6, exact annulus mapping, its own assembly. N = 64 / 128 / 256 give 92.5282 / 92.6246 / 92.6497 MPa with p_obs 1.95, extrapolated to 92.658 +- 0.0005 MPa.
- The engine therefore agrees with an independent solver to about 1e-5. FeenoX's 92.7011 (case `reference_results`) is 4.7e-4 high, presumably not mesh-converged.
- The fail comes from the monotone-|error| test against a reference rounded to 3 significant figures: level 1 is closer to 92.7 than levels 2 and 3. Level-to-level changes (8.6 kPa, then 0.2 kPa) do show convergence.

**HT-04 x = 0.0859 m: agree.**
- Errors -7.08e-6 / -2.50e-6 / -3.01e-6 degC against a 0.099 degC budget.
- The error at x = 0.0223 settles at the same -2.6e-6 degC: a BDF2 time-error floor at dt 1 s, because h is refined and dt is not.
- I1's dt sweep (dt 0.25 s: floor about 2e-7, sign change) is consistent.
- The proper fix is `convergence.dt_with_h` (supported since `595f561`) in the case (L7a), not a looser rule.

**WO-41: agree, not an engine bug.**
- Recomputed from `logs/l4-modes-wo02-20261107T010407Z.jsonl`. N = 16 / 32 / 64 give p_obs 1.755 (A), 1.817 (C) and 1.526 (D). Richardson at those orders gives -4.3e-9, +4.2e-9 and +3.2e-8, all within the 1e-7 budget. These match DevLog-014 item 14.
- Using all four levels (N = 8..64), p is stable for C (1.817, 1.817) and D (1.518, 1.526), and drifts slightly for A (1.66 to 1.755). B is pre-asymptotic, with non-monotone differences; its finest error 8.1e-8 already passes.
- Caveat: a three-level fit with its own p reproduces the three points exactly, so agreement with the reference is a consistency check, not a proof. The stable p over four levels is the stronger evidence.
- expected_order for WO-41 must come from the dielectric-wedge exponent (theory), not from these observed orders.

## 6. Findings

### Blocking (for "M2 engine half met")

**B1. The < 5 s criterion is not met for H6, and H5's gate is not under 5 s.**
- Evidence: AC-02 takes 8.43 s cold and 6.25 s warm at `2a8b2ca` (5.43 s warm on HEAD). RF-21 7/7 takes 15.2 s cold, because Q_d runs 3D for 13.1 s. DevLog-001 s.13 lists H5 at 2.14 s.
- Fix:
  - H5: compute Q_d in `emw-axisym` with the same perturbation formula, or state that the hero timing excludes the Q_d identity check (S6).
  - H6: keep M2 open until AC-02 is under 5 s at gated accuracy (L4's s = 1, 2, 3 ladder or a cheaper factorization). Record the number with its protocol (cold or warm, levels, mesh cache).

### Significant

**S1. The harness takes h from DOF and the case `dimension`, not from the spec.**
- Evidence: `registry.ts:437` `dimOf(c.dimension)` and `evaluate.ts` `hFromDof(dof, dim)`. WO-01, HT-02, HT-03 and HT-04 are labelled `1D` but solved on 2D strips, so r = DOF ratio: WO-01 4.10, HT-04 3.64.
- With the true nested r = 2:
  - WO-01 p is 3.98 (TE0) and 3.95 (TM0), not 1.92 / 2.04. Richardson becomes available (f_ext error 1.7e-11).
  - HT-04 x = 0.0223 has p 4.00, outside the band of 3. It would go to the fallback and still pass.
- Pass / fail is unchanged, but DevLog-014's WO-01 and HT-04 orders are artefacts. AC-02's DOF-based r of 1.939 (vs 2) inflates its p by about 5 % (M3). The bug is still present on HEAD.
- Fix (L8): pass `h = hFactor` from the worker into the level observations (exact for nested levels), else use `spec.geometry.dim`. Correct the DevLog-014 table.

**S2. The warm timings reuse cached meshes, and the reports mix warm and cold.**
- Evidence: s.4. At `2a8b2ca` the refinement was skipped on warm repeats; on HEAD all meshing is skipped. DevLog-001 s.13 quotes warm for H1-H4 (0.83, 0.02-0.42, 1.18, 0.92 s) and cold for H5 (2.14 s). H4's 0.92 s covers TE0 only; TM0's cold time is 1.95 s.
- Fix: report cold and warm side by side per hero. Add an "edit loop" protocol that changes one parameter (new chain key) before each timed run, since that is the interactive case.

**S3. The browser path is not measured at gated accuracy, and for H1-H4 the hero models are not the gated specs.**
- Evidence:
  - Play and Workbench solve one base level of kirsch-plate (finite-width tension; K_t shown 3.021), heat-plate-fin, helmholtz-coil (B_center 8.983 uT vs 8.99176 uT), si-rib-waveguide and box-acoustics at 693 DOF.
  - At hFactor 1 the gated specs miss their own tolerances: AC-02 f_mode10 3.3e-3 vs 1e-4, RF-21 TE011 3.8e-4 vs 1e-5, SM-01 syy 1.8e-3 vs 1e-3.
  - Only H6 (box-acoustics) and H5 Play (axisym) run the gated spec.
- Fix: the browser "full result" should run the level sequence (or the finest level) that passed the gate, show its error band, and be timed in Chrome. Either gate the hero specs themselves or state per hero which gate validates which module path.

**S4. HT-02 does not follow its own convergence note.**
- Evidence: the case says "refine both h and dt", but dt stays at 0.05 s on every level, and the target passes on the fallback (oscillatory). Same mechanism as HT-04.
- Fix (L7a): set `convergence.dt_with_h` with space and time orders (available on HEAD).

**S5. The fallback rule was relaxed after these runs, and the relaxed form drops the convergence evidence.**
- Evidence: `595f561` passes when the finest level is within budget and (|e| non-increasing, or every level within budget). That turns SM-02 and HT-04 into passes ("class a 11 pass 0 fail").
- For these two cases the outcome is right (s.5). As a rule, though, it accepts a stagnating or diverging sequence that stays inside a loose budget, which conflicts with "a passing eval gate and a convergence study" (DevLog-001 s.6).
- Fix (L8): require self-convergence instead, i.e. level-to-level |f_k - f_(k-1)| non-increasing. Both SM-02 (8.6 kPa, then 0.2 kPa) and HT-04 x = 0.0859 (4.6e-6, then 5.2e-7 degC) pass that test.

**S6. RF-21 Q_d is an identity check.**
- Evidence: s.3. 2500 +- 2e-11 on every mesh, by construction, at 13.1 s.
- Fix: move it to `emw-axisym`, or label it as a plumbing check and keep it out of the hero time. A meaningful Q gate needs an inhomogeneous fill or wall loss (RF-01 Q_c, pending surface impedance).

**S7. The H4 Play handle broke when I1 renamed `t` to `t_slab`.**
- Evidence: `apps/web/src/lib/play/heroes.ts:35` still has `param: 't'` on HEAD, while `sims/si-rib-waveguide.yaml` has `t_slab`. So `si(p, 't')` is NaN and the slab drag handle has no valid position.
- Fix (L5): change it to `t_slab`, and add a test that every handle's param exists in its spec.

**S8. DevLog-001 s.13 summary inaccuracies.**
- "H1 SM-01 worst -2.8e-6": the worst gated SM-01 error is syy_hole_side 4.7e-5 (fallback), and the field L2 error is 1.4e-4.
- "H5 2.14 s" omits Q_d.
- "H4 0.92 s" is TE0 only, and warm.
- Fix: correct the line from s.1 and s.4 of this audit.

### Minor

- **M1.** RF-21 targets are picked by sorted index. This is correct now (s.3), but TE011 / TM111 ordering is set by discretization error. Use a selector on `m_k` and `ezFraction_k`, which the Solution already carries (DevLog-014 s.5 item 5e).
- **M2.** DevLog-001 s.8 still names RF-01 as H5's gate. Record RF-21 (and RF-01 on the axisym spec, `d644d1a`) there.
- **M3.** AC-02 r is 1.939 from DOF instead of 2, so p is about 5 % high. f_ext is unaffected (r^p = d1 / d2). Fixed together with S1.
- **M4.** EM-04 (B, observed p about 3.7-3.95 vs 2) and the SM-01 displacements (3.3-3.7 vs 2) sit on the fallback. Per-target `expected_order` now exists in the schema (`595f561`). Set it only from a stated derivation, for example pointwise P2 displacement at order 3.
- **M5.** Run records say `@amp/physics@0.0.1+dirty`, because the working tree was dirty (`validation/a/build_cases.py`). The reproduction is weaker as provenance. Commit before gate runs.
- **M6.** WO-02, H4's own rib gate, is still pending on the harness (sweep targets). L4's off-harness script passes the rib thicknesses at tolAbs 5e-6 (`logs/l4-modes-wo02-20261107T010407Z.jsonl`). H4's only harness gate is a slab that the vector solver treats as 2D.
- **M7.** "3D deformation implemented but not visually verified" (DevLog-011 s.4.5). No hero needs 3D displacement (H1 is 2D), so this does not block M2; it should not be counted as done.
- **M8.** Machine etiquette, audit side: the independent LE1 solve at N = 256 peaked at 3.6 GB RSS (Python, single process, 34 s). This is above the per-lane intent, and I did not repeat it. All other audit runs stayed under 1.6 GB.

## 7. Not done

- No browser runs.
- No `--speed` over all heroes; only AC-02 on HEAD.
- No warm timing for WO-01 TM0 or RF-21.
- No 3D cavity level beyond what the cases ask for.
- No change to any file other than this one.
