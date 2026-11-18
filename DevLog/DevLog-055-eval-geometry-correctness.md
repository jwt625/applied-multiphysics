# DevLog-055: eval and geometry correctness (lane E9, chunk 2)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | E9 (DevLog-037 s.4.1) |
| Owns | `packages/geom/**`, `packages/post/**`, `packages/eval/**`, existing `eval/cases/{a,b,c}` files except CP-43 / WO-65 / AC-01, `validation/a/**`, `validation/b/**`, `validation/c/build_cases.py` except the WO-65 `t2_apply` entry, `.github/**` |
| Not owned | `packages/mesh/**` (E4), `validation/c/cases_ext/*` (other lanes), sims, apps/web |

Conventions: F = fact read from code, files or runs; E = estimate; D = decision; O = open item; R = request.

## 1. Plan (2026-11-18 13:27 PST)

### 1.1 Facts at start
- F: 48 sims; baseline mesh dump (mesh hash, tagHash, node / cell counts, quality at order 1 and 2 of every `sims/*.yaml`, scratch script `<scratch>/regress.ts`): `logs/E9-regress-before-20261118T132501.json`.
- F: `buildGeometry2D` emits one geometry edge per arrangement sub; a keepTools difference with a curved tool leaves the tool's circle as its 1-degree pieces (DevLog-044 s.2 09:07, O1). `mergeEdgePieces` (stack.ts) merges them for stacks only; it also merges collinear lines and always re-numbers vertices, so calling it as is in 2D would change meshes of sims without curved tools.
- F: sims that use keepTools: 19; curved tools in 5 (coplanar-rings, phc-point-defect, phc-square-rods-lower / -upper, nafems-t1-hotspot; DevLog-044). Cases on them: EM-03 (coplanar-rings, class c), WO-04 (phc-square-rods-lower / -upper, class c), CP-21 (nafems-t1-hotspot, class a), WO-63 (phc-point-defect, pending, not run).
- F: DG0 point values (`points.ts interpolate`, `evaluate.ts evaluateField`) are the cell constant; the 2D view (apps/web `field2d.ts recoverDG0`) recovers per (corner node, domain) area-weighted means and draws them linearly, so a cut line of a DG0 field shows a staircase.
- F: eval fallback (`evaluate.ts fallbackGate`): zero level-to-level changes count as shrinking; nothing checks that the levels were refined (equal DOF on every level passes).
- F: stack meshes are built and quality-screened in `packages/mesh/src/stack.ts` (`meshStack`, `stackQuality`): mesh package, lane E4.
- F: `.github/workflows/ci.yml` uses actions/checkout@v4, pnpm/action-setup@v4, actions/setup-node@v4, actions/upload-artifact@v4 (Node 20 runtime, forced to Node 24 on the runner; DevLog-037 10:43).

### 1.2 Plan (D)
1. Curved-tool pieces (DevLog-044 O1): `buildGeometry2D` merges consecutive curved pieces (arc / ellipse arc) of one boundary with equal sides through a degree-2 vertex that is not a named point; lines are not merged; when nothing merges the geometry object is returned unchanged (same vertex numbering), and when pieces merge the kept vertices keep their relative order. `mergeEdgePieces` gains these as options; the stack path keeps its current behaviour (default options). Option `mergeCurvePieces: false` on `buildGeometry2D` gives the old geometry (tests compare both). Tests: rect + circle keepTools gives 6 edges (as without keepTools), entity table unchanged, mesh min angle at r = hmax above 20 deg.
   Regression: mesh dump after vs before: only the five sims may change; eval cases EM-03, WO-04, CP-21 before / after on the same CLI flags (default levels, `--fields python` default), every target tabled; WO-63 is pending (no gated target run).
2. O-C1: `@amp/post` DG0 recovery: `recoverDG0(mesh, field)` (per (corner node, domain) cell-measure-weighted mean, the display's rule) and `interpolate(f, ps, { smooth: true })`, `sample(..., { smooth: true })`, `ExprOptions.smooth` (DG0 fields read through the recovery, linear on the cell corners; jumps kept at domain interfaces). Default unchanged (cell constant). Tests: linear field projected to DG0 recovered exactly in the interior; bounded by cell values; interface jump kept; cut line has no staircase.
3. Eval H5 hole: fallback requires the levels to be refined (DOF strictly growing, else h strictly decreasing); otherwise "not refined" and no pass. Tests: stagnant sequence with equal DOF fails; refined exact sequence (CP-03 style) still passes. Strict finest-level rule unchanged.
4. T1 R1 pending references: per target, decide whether an existing sim produces the value; wire the ones that can through the builders; table the rest with the reason.
5. S3 O3 flat-tet warning: the dihedral screen lives in `packages/mesh` (E4): request with exact lines (s.6).
6. CI: bump actions to releases that run on Node 24 (release notes cited), jobs unchanged.

Validation: geom / post / eval tests; physics tests; mesh dump diff; class a / b / c CLI counts before and after (flags as the coordinator: `--skip=CP-43` for b, `--skip=WO-65` for c); builders (`a/test_build_preserves.py`, `c/test_build_matches.py`, `b/check_cases.py`).

## 2. TODO
- [x] baseline mesh dump and full CLI run (before)
- [x] 2D curved-piece merge + tests + regression + eval before / after
- [x] post DG0 recovery + tests + API note
- [x] eval DOF-growth check + tests
- [x] T1 R1 references
- [x] flat-tet warning request
- [x] CI action versions
- [x] after runs, tests, hand-off

## 3. Progress log
- 2026-11-18 13:22 PST: start; read CLAUDE.md, DevLog-037 s.4.1 and log, DevLog-044 s.2 / s.5, DevLog-039, DevLog-038 s.6, ci.yml, geom / post / eval sources.
- 2026-11-18 13:25 PST: baseline mesh dump `logs/E9-regress-before-20261118T132501.json` (48 sims, order 1 and 2). Full CLI run (before) started in the background (scratch `evalall.sh`: class a; b `--skip=CP-43`; c `--skip=WO-65`; nice 10, heap 1536 MB, BLAS threads 2).
- 2026-11-18 13:27 PST: plan written (s.1).
- 2026-11-18 13:27 PST: full CLI run (before) done: class a 15 / 1 / 13 (`logs/eval-20261118T132551.jsonl`, console `logs/E9-eval-before-a-20261118T132551.log`, peak RSS 1020 MB), b 0 / 1 / 19 with CP-43 skipped (`logs/eval-20261118T132635.jsonl`, 486 MB), c 7 / 1 / 28 with WO-65 skipped (`logs/eval-20261118T132639.jsonl`, 1577 MB). Same counts as DevLog-037 10:25. Case ids: the 85 tracked files (no new case file from other lanes was picked up: a 29, b 20, c 36).
- 2026-11-18 13:29 PST: item 1 done in `packages/geom/src/model.ts`: `mergeEdgePieces` moved from stack.ts into model.ts with options `curvesOnly`, `stable`; `buildGeometry2D(spec, { mergeCurvePieces })` (default true) applies `{ curvesOnly: true, stable: true }`; the stack path builds its sketches with `mergeCurvePieces: false` and merges them as before (default options), so stacks are unchanged. Mesh dump after: `logs/E9-regress-after-20261118T132932.json`: exactly the five sims changed (s.4.1), 43 / 48 identical (mesh hash and tagHash, order 1 and 2).
- 2026-11-18 13:29-13:30 PST: eval after for EM-03, WO-04, CP-21 (`--case`, default flags): `logs/eval-20261118T132948.jsonl`, `-132950`, `-132951` (s.4.2).
- 2026-11-18 13:31 PST: DevLog-044 reproduction (rect 100 um + circle keepTools, hmax 10 um; `logs/E9-minangle-*.log`): r 10 / 12 / 20 um: geometry edges 364 -> 6, min angle 0.50 / 0.60 / 0.95 deg -> 22.25 / 22.15 / 22.21 deg.
- 2026-11-18 13:31-13:33 PST: tests: geom 51 / 51 (`logs/E9-geom-test-*.log`, +3 in `test/merge-pieces.test.ts`), mesh 20 / 20 and physics 172 / 172 (`logs/E9-mesh-test-20261118T133103.log`, `logs/E9-physics-test-20261118T133103.log`, 101 s).
- 2026-11-18 13:32 PST: item 2 done in `packages/post` (s.5): `recoverDG0`, `interpolate(..., { smooth })`, `sample(..., { smooth })`, `ExprOptions.smooth`; tests `test/dg0-smooth.test.ts` (3); post 16 / 16 (`logs/E9-post-test-*.log`). si-slab-te0 normE along x = 0, 400 points (`logs/E9-dg0-cutline-*.log`): cell values 248 distinct of 400 with 152 equal neighbours (staircase) -> smooth 400 distinct, 0 equal neighbours; the largest remaining steps are at the core / cladding interfaces y = +-0.11 um (jump kept per domain, as in the 2D view).
- 2026-11-18 13:34 PST: item 3 done in `packages/eval/src/evaluate.ts`: `fallbackGate` requires refined levels (`refinedLevels`: DOF strictly growing, else h strictly decreasing; else no pass, reason "levels not refined (DOF a, b, c)"). Tests `test/stagnation.test.ts` (3); eval 89 / 89 (`logs/E9-eval-test-*.log`).
- 2026-11-18 13:36-13:44 PST: item 4 (s.6): EM-04 uniformity and CP-21 infinite-plate targets wired in the class-a files (preserved fields `extract`, target `spec`; `a/test_build_preserves.py` ok, `logs/E9-a-build-preserves-*.log`); WO-63 defect frequency wired through the class-c builder (`t2_apply` WO-63 entry; rebuilt into a scratch dir, only WO-63.yaml copied). Harness: expr term kind `result` (an evaluation item of the spec's results inside an expr; loader check, worker loads the results adapter for nested terms; tests in `result-extract.test.ts`, `stagnation.test.ts`); eval 91 / 91. WO-63 energy fraction probed with @amp/post integrals (`logs/E9-wo63-energy-probe-20261118T134300.log`): 0.632872 / 0.632627 at 13.5k / 53.8k DOF vs MPB 0.624795 (rel 2e-2): wireable once the sim has the evaluation items (R3).
- 2026-11-18 13:39 PST: F: `validation/c/build_cases.py` failed (KeyError 'WO-70' in `apply_audit`) as soon as a `cases_ext` module (lane E1 driven.py) added a case: `RIGHTS[FAMILY[cid]]` has no entry for ext ids. Fixed (13:47): the audit pass (`apply_audit`: rights by family, `source_accessed` 2026-11-06 on basis-D references, per-case wiring) runs on the built-in cases only; `cases_ext` cases are written as their lanes author them (a first fix that only skipped the rights lookup stamped the 2026-11-06 access date onto the new driven cases). `c/test_build_matches.py`: 40 / 40 (`logs/E9-c-build-matches-*.log`; includes lane E1's new cases present at 13:47).
- 2026-11-18 13:44 PST: item 6: `.github/workflows/ci.yml` actions bumped (s.8). Full CLI run (after) started.
- 2026-11-18 13:44-13:47 PST: full CLI run (after), same flags (s.7). 13:47: WO-63 energy-fraction request verified end to end in a scratch root (sim copy with the R3 items, case copy with the R3 extract): 0.632872 / 0.632548 / 0.632601 at 13.5k / 23.0k / 41.9k DOF vs 0.624795 (+1.25 %, tolerance 2 %, info).
- 2026-11-18 13:48 PST: tsc clean for geom, post, eval, mesh, physics; scan of the changed files for local paths: none. Sections 4-10 written.

## 4. Item 1: curved-tool pieces (DevLog-044 O1)

### 4.1 Mesh regression (`logs/E9-regress-before-20261118T132501.json` vs `logs/E9-regress-after-20261118T132932.json`)
43 of 48 sims identical (mesh hash and tagHash at order 1 and 2; incl. the five 3D sims). Changed (order 1 nodes; order 2 nodes; min angle):

| Sim | P1 nodes | P2 nodes | min angle (deg) |
|---|---|---|---|
| coplanar-rings | 7807 -> 3513 | 31111 -> 13932 | 21.75 -> 25.32 |
| nafems-t1-hotspot | 1881 -> 1519 | 7351 -> 5912 | 21.94 -> 23.46 |
| phc-point-defect | 15891 -> 3446 | 63318 -> 13601 | 21.74 -> 26.28 |
| phc-square-rods-lower | 838 -> 389 | 3278 -> 1489 | 21.98 -> 26.57 |
| phc-square-rods-upper | 838 -> 389 | 3278 -> 1489 | 21.98 -> 26.57 |

F: the 1-degree pieces had made these meshes 2.2-4.6x denser along the tool circles than the size field asks for.

### 4.2 Eval before / after (default levels and flags; before `logs/eval-20261118T132551.jsonl`, `-132639`; after `logs/eval-20261118T132948.jsonl`, `-132950`, `-132951`, same values in the full run 13:44)

| Case / target | gated | before: value, status, DOF | after: value, status, DOF | ref | tolerance |
|---|---|---|---|---|---|
| CP-21 sigma_yy_D (Pa) | yes | 4.97413e7 fail (Richardson unavailable, oscillatory; changes not shrinking), 21.7k / 38.4k / 74.3k | 5.06760e7 extrapolated (finest 4.97647e7) pass, 17.4k / 35.4k / 72.4k | 5.0e7 | rel 1.5e-2 |
| EM-03 M_ab_filament_exact (H) | yes | 1.982605e-12 pass, 30.9k / 46.4k / 82.1k | 1.982604e-12 pass, 13.7k / 30.2k / 67.0k | 1.981370e-12 | as case |
| EM-03 L_aa (H) | yes | 4.180661e-11 pass | 4.180661e-11 pass | 4.178537e-11 | as case |
| EM-03 L_bb (H) | yes | 7.072079e-10 pass | 7.072079e-10 pass | 7.072050e-10 | as case |
| EM-03 M_ab (info) | no | 1.982605e-12 | 1.982604e-12 | 1.973921e-12 | info |
| WO-04 gap_lower (c/a) | yes | 0.28066173 pass, 3.2k / 4.2k / 6.1k | 0.28066172 pass, 1.4k / 2.6k / 5.0k | 0.28066439 | rel 1e-4 |
| WO-04 gap_upper (c/a) | yes | 0.41716250 pass, 3.2k / 4.2k / 6.2k | 0.41716251 pass, 1.4k / 2.6k / 5.1k | 0.41716240 | rel 1e-4 |
| WO-04 pwe / mpb32 lower, upper (info) | no | 0.28066175 / 0.41716260 | 0.28066175 / 0.41716261 | 0.28066257 / 0.41716547; 0.28094796 / 0.41711425 | info |
| WO-63 | - | pending (not run) | defect frequency wired (s.6) | - | - |

No gated target regressed; CP-21 sigma_yy_D turns from fail to pass under the unchanged strict rule (the level sequence is no longer oscillatory: 48.886 / 49.399 / 49.765 MPa; extrapolated 50.676 MPa, 1.35 % off, finest 0.47 % off, both inside 1.5 %).

## 5. Item 2: DG0 recovery in `@amp/post` (API for lane E6)
- `recoverDG0(mesh, field): Float64Array`: corner values per cell, index `(cell * nCorner + corner) * components + component`, corners = the first nCorner nodes (VTK order); per (corner node, domain) cell-measure-weighted mean (the rule of apps/web `field2d.ts recoverDG0`); jumps kept at domain interfaces; non-finite cells left out; bounded by the cell values; cached per (field, mesh). Cell types tri3, tri6, quad4, tet4, tet10, hex8.
- `interpolate(f, ps, { smooth: true })`: DG0 values linear (bilinear / trilinear) on the cell corners; other spaces unchanged; `grad` on DG0 still an error.
- `sample(sol, field, points, { smooth: true })`.
- `ExprOptions.smooth` (`compileFieldExpr`, `evaluateExpr`, and the eval functions that take ExprOptions): DG0 fields read through the recovery; such a field then reports `continuous: true`. Use for plots (cut lines, cut points, grids); keep the default for max / min / integrals (exact cell values).
- E6 use: pass `{ smooth: true }` in the options of the `compileFieldExpr` call that evaluates line / point datasets (apps/web `results/adapter.ts` around the dataset evaluation), for line plots of DG0 expressions.
- F (si-slab-te0 normE, x = 0, 400 points): cell values 248 distinct, 152 equal neighbours -> smooth 400 distinct, 0 equal neighbours; the largest steps left are the core / cladding interfaces (y = +-0.11 um), as in the 2D view.

## 6. Item 4: T1 R1 pending references

| Case / target | Decision | Result / reason |
|---|---|---|
| EM-04 uniformity_sphere_0.1R | wired (case file, preserved `extract`) | expr max(abs(bmax - b0), abs(bmin - b0)) / b0 over the case's 201 points on r = 0.1 R (validation/a/gen_em.py points), b0 = computed B(0): 1.14020e-4 vs 1.13942e-4 (abs 2e-5), info |
| EM-04 truncation.dirichlet_A.Rb30R | not wired | needs a spherical A = 0 boundary at R_b = 30 R; sims/helmholtz-em04.yaml has a rectangular box at 100 R (params cannot turn the box into a sphere); needs a new sim variant |
| CP-21 sigma_yy_D_infinite | wired (target spec `{sim, params: {Lq: 100}}`, extract result syy_D) | quarter membrane 100 mm (a / Lq = 0.01): 48.450 / 48.956 / 49.373 MPa at 19.5k / 37.5k / 77.3k DOF vs 50 MPa (rel 1.5e-2), info; still converging upward, below the case bounds [50, 50.5] MPa at these levels |
| CP-04 tip_UY | not wired (stays untestable) | engine has no k(T), alpha(T), h(T), no surface-to-surface radiation, no NLGEOM (heat module: surface-to-ambient radiation only); case text unchanged |
| EM-61 L_kin, L_total_london | not wired | no London (kinetic inductance) model; gated, so EM-61 stays pending |
| RF-01 Q_c_TE011, Q_TE011_copper | not wired | emw-axisym exports E only (E_rphiz, H1 projection) and has no surface-impedance wall BC; Q_c needs the wall integral of abs(H_t)^2 (perturbation) or an R_s BC (open item O2) |
| WO-63 defect_frequency_band_25 | wired (builder `t2_apply` WO-63 entry; case spec now sims/phc-point-defect.yaml) | 0.3768586 (13.5k / 23.0k / 41.9k DOF, peak 403 MB) vs MPB 0.378166 at resolution 16 (-0.35 %, rel 5e-3), info; the 1.0M-DOF limit of the old reason came from the 1-degree pieces (s.4) |
| WO-63 energy_fraction_in_the_defect_region | request R3 (needs sim evaluation items) | verified in a scratch root: 0.632601 vs 0.624795 (+1.25 %, rel 2e-2) |
| CP-43 Z0_real, VpiL_measured | request R4 (CP-43 file is not in this lane's paths) | Z0_real: es.Z0 (2D quasi-TEM, one terminal: L' from the vacuum capacitance) vs the 50 Ohm design statement, informative; VpiL_measured: the designed-section VpiL against the measured device, informative (non-comparable per the case). Not run here (level 0 above 2 GB RSS) |

Harness addition used by R3: expr term kind `result` (loader check `result term needs node`; worker loads the results adapter when any nested term is a result).

## 7. Full CLI runs (nice 10, heap 1536 MB, BLAS threads 2; b `--skip=CP-43`, c `--skip=WO-65`; default `--fields`)

| Class | before (13:25-13:27) | after (13:44-13:47) | JSONL before / after | peak RSS before / after |
|---|---|---|---|---|
| a | 15 / 1 / 13 (29 cases) | 16 / 0 / 13 (29) | `eval-20261118T132551` / `-134452` | 1020 / 800 MB |
| b | 0 / 1 / 19 (20) | 0 / 1 / 19 (20) | `-132635` / `-134541` | 486 / 460 MB |
| c | 7 / 1 / 28 (36) | 10 / 2 / 28 (40) | `-132639` / `-134547` | 1577 / 1438 MB |

Counts are pass / fail / pending. Case ids: before = the 85 tracked files; after = the same 85 plus lane E1's new class-c cases RF-70, WO-70, WO-71 (pass) and WO-72 (fail: S21_abs.l1600.L0), present on disk at 13:45. On the original 85 cases: CP-21 fail -> pass; target changes CP-21 sigma_yy_D_infinite, EM-04 uniformity, WO-63 defect frequency pending -> info; EM-03, WO-04 values per s.4.2; CP-06 values differ at 1e-15 relative (pzt4-cube mesh unchanged in s.4.1: from concurrent solver work of another lane, not this lane); every other target identical in value and status. Consoles: `logs/E9-eval-{before,after}-{a,b,c}-*.log`.

## 8. Item 6: CI actions (Node 24)
`runs.using` read from each tag's action.yml (GitHub API, 2026-11-18): checkout v4.4.0, setup-node v4.4.0, upload-artifact v4.6.2, pnpm/action-setup v4.1.0 = node20; actions/checkout@v5 (v5.0.0, 2025-08-11, github.com/actions/checkout/releases/tag/v5.0.0), actions/setup-node@v5 (v5.0.0, 2025-09-04, .../setup-node/releases/tag/v5.0.0), actions/upload-artifact@v6 (v6.0.0, 2025-12-12, .../upload-artifact/releases/tag/v6.0.0; v5 still ran node20 by default), pnpm/action-setup@v5 (v5.0.0, 2026-03-17, github.com/pnpm/action-setup/releases/tag/v5.0.0) = node24. Breaking notes: runner >= 2.327.1 (GitHub-hosted runners qualify); setup-node v5 enables a package-manager cache from `packageManager`, which is the pnpm cache the workflow already requests (`cache: pnpm`). Jobs, steps, inputs unchanged; YAML parses (2 jobs, 8 + 7 steps). Not yet run on GitHub.

## 9. Requests
- R1 (lane E4, `packages/mesh/src/stack.ts` `meshStack`, after `mesh.quality = stackQuality(mesh);`; S3 O3 flat-tet warning; threshold is a design choice, not a sourced value):
  ```ts
  const md = mesh.quality.minDihedralDeg;
  const flat = md !== undefined && md < FLAT_TET_DEG
    ? [`flat tetrahedra: min dihedral angle ${md.toFixed(2)} deg (below ${FLAT_TET_DEG} deg): a layer much thinner than the in-plane cell size; refine that layer's sketch edges (mesh.refine) or lower mesh.size.hmax`]
    : [];
  const warnings = [...new Set([...st.warnings, ...(m2.warnings ?? []), ...flat])];
  ```
  replacing the existing `const warnings = ...` line, plus `/** min dihedral (deg) below which meshStack warns (design threshold, DevLog-055) */ export const FLAT_TET_DEG = 5;` at module level. prepareRun already turns mesh warnings into readiness notes. Expected: the DevLog-044 examples (2.2-2.8 deg) warn.
- R2 (coordinator): library catalogs show CP-21 as fail (DevLog-037 09:18); after s.4 it passes on the CLI (logs/eval-20261118T134452.jsonl). Update the catalog entry / log pointer.
- R3 (coordinator or the sims owner; `sims/phc-point-defect.yaml` `results.evaluations.ev_eig.items`, after `f_defect`), verified in s.6:
  ```yaml
        - {id: W_rods_defect, type: integral, expr: "wave.p^2 * (r < a)", over: ["dom:r10", "dom:r20", "dom:r01", "dom:r02", "dom:r11", "dom:r12", "dom:r21", "dom:r22"], label: "integral of p^2 over the rods within r < a of the defect"}
        - {id: W_bg_defect, type: integral, expr: "wave.p^2 * (r < a)", over: ["dom:bg"], label: "integral of p^2 over the air within r < a of the defect"}
        - {id: W_rods, type: integral, expr: "wave.p^2", over: ["dom:r10", "dom:r20", "dom:r01", "dom:r02", "dom:r11", "dom:r12", "dom:r21", "dom:r22"]}
        - {id: W_bg, type: integral, expr: "wave.p^2", over: ["dom:bg"]}
  ```
  then in `validation/c/build_cases.py` `t2_apply` WO-63 entry replace the `note(...)` call with
  ```python
        R["energy_fraction_in_the_defect_region"]["extract"] = {"kind": "expr", "expr": "(eps * Wri + Wbi) / (eps * Wr + Wb)", "terms": {
            "eps": _const(12, "1", "sims/phc-point-defect.yaml params.eps_rod"),
            "Wri": {"kind": "result", "node": "W_rods_defect"}, "Wbi": {"kind": "result", "node": "W_bg_defect"},
            "Wr": {"kind": "result", "node": "W_rods"}, "Wb": {"kind": "result", "node": "W_bg"}}}
  ```
  and rebuild WO-63 (`uv run python c/build_cases.py --out <dir>`, copy WO-63.yaml). eps p^2 is the analog of eps abs(E_z)^2 (energy density with D = eps E, as the tutorial's get_dfield / compute_field_energy).
- R4 (lane E2, `eval/cases/b/CP-43.yaml`): `Z0_real`: add `extract: {kind: scalar, name: es.Z0}, levels: [0]`; `VpiL_measured`: add `extract: {kind: result, node: VpiL}, levels: [0]`; update the note line that says they carry no extract (Z0 is the quasi-static TEM value of the electrostatics step; both stay `gate: false`). Not run by this lane (memory rule).
- R5 (coordinator, `eval/schema/amp-eval-0.schema.json` `$defs.extract.properties.terms.description`): "expr: name -> sub-extract (scalar, probe, reduce, expr, result) or a constant {value, unit}". CONTRACTS-v0 changelog: C8 fallback needs refined levels (DOF strictly growing, else h strictly decreasing); C8 expr term kind `result`; @amp/post `recoverDG0`, `smooth` options (s.5); @amp/geom `buildGeometry2D` merges curved pieces (option `mergeCurvePieces`, export `mergeEdgePieces`, `MergeEdgeOptions`).

## 10. Open items
- O1: EM-04 truncation target needs a sim with a spherical truncation boundary (sims owner).
- O2: RF-01 Q_c needs H output from emw-axisym (or a surface-impedance BC) and an integral item; module owner.
- O3: EM-61 London model and CP-04 (k(T), alpha(T), h(T), surface-to-surface radiation, NLGEOM) are engine features, not wiring.
- O4: CP-21 sigma_yy_D_infinite at Lq = 100 mm is still below the case bounds at the default levels (49.37 MPa at 77k DOF); informative.
- O5: `validation/c/build_cases.py` writes ext cases unaudited (s.3 13:47): lanes adding cases own their rights and access dates.
- O6: new sims from other lanes (14 untracked at 13:48) were not in the mesh dumps; any with a keepTools curved tool now mesh with merged arcs from the start.

## 11. Hand-off
Changed (owned paths): `packages/geom/src/{model,stack,index}.ts`, `packages/geom/test/merge-pieces.test.ts`; `packages/post/src/{points,sample,expr,index}.ts`, `packages/post/test/dg0-smooth.test.ts`; `packages/eval/src/{evaluate,registry,loader,engine-worker}.ts`, `packages/eval/test/{stagnation,result-extract}.test.ts`; `eval/cases/a/{EM-04,CP-21}.yaml`, `eval/cases/c/WO-63.yaml`; `validation/c/build_cases.py` (WO-63 entry, ext cases unaudited); `.github/workflows/ci.yml`; this file. Tests: geom 51 / 51, post 16 / 16, eval 91 / 91, mesh 20 / 20, physics 172 / 172; builders: class a preserves ok, class c 40 / 40, class b 20 cases 0 errors.
