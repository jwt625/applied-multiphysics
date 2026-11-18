# DevLog-039: eval hygiene and reproducibility (lane T2, chunk 1)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | T2 (DevLog-037 s.3, A1) |
| Owns | `eval/**`, `validation/a/**`, `validation/b/**`, `validation/c/**`, `packages/eval/**` (harness bugs and small features) |
| Not owned | `sims/*.yaml` (T3), new validation dirs of other lanes, `CONTRACTS-v0.md` (coordinator) |

Conventions: F = fact read from code or files; E = estimate; D = decision; O = open item; R = request to another lane.

## 1. Facts verified before coding (2026-11-18 08:47-08:51 PST)

- F: 85 cases (a 29, b 20, c 36). Case `spec:` is a sims path for 13 cases (AC-02, EM-01, EM-04, HT-01..04, RF-21, SM-01, SM-02, WO-01, EM-02, EM-03, RF-01); every other case is `{status: pending}`.
- F: pending `ref` values that name an existing sim: CP-02, CP-21, SM-21, CP-43, WO-02, CP-03, CP-04, CP-06, HT-61, RF-03, RF-62, WO-63, WO-65. Pending refs that name no file: 49 (incl. the wrong ids WO-21 `bragg-stack`, RF-02 `wr90-guide`, WO-04 `phc-square-rods`, EM-61 `micro-coax-london`). WO-41 has no ref.
- F: the schema (`eval/schema/amp-eval-0.schema.json` `$defs.specRef`) describes the pending `ref` as "proposed sims/ path"; nothing in apps/ or packages/ reads it.
- F: `validation/a/build_cases.py --force` rebuild reproduces all 29 class-a files byte for byte (`test_build_preserves.py`: ok, 238 preserved paths); it preserves `spec`, references' `extract`, `metric_id`, `spec`, `levels`, convergence `h_factors`, `expected_order`; everything else is regenerated.
- F: `validation/c/build_cases.py` has no preserve step; it skips existing files unless `--force`. A rebuild differs from the repo in CP-04 (untestable_reason) and CP-06 (status, untestable_reason, activation, spec.ref): the manual edits of DevLog-035 s.13 item 6.
- F: class b has no builder (hand-edited files; `validation/b/check_cases.py` checks them).
- F: harness: case spec = sims path, embedded spec or pending; per-target `spec` overrides; no parameter overrides, no study choice per target (study = the case's `study.type`, else the first non-parametric), no combination of targets across specs; unit strings with an annotation such as `1 (c/a)` do not parse; `length` (SM-21) does not convert.
- F: default levels when the case gives no `h_factors`: `levels_min` levels at ratio max(ratio_min, 1.5), i.e. hFactor 1, 0.667, 0.444. The scratch runners of DevLog-021/022 used 1, 0.5, 0.25; DevLog-035 used a single level.

## 2. Plan (D)

Harness features (small, additive; schema is in `eval/schema`, mine; contract changelog line requested from the coordinator):
- H1 specRef object form for a sims file with overrides: `{sim: sims/<id>.yaml, params?: {name: value | expr string}, study?: <study id>}`. Needed for WO-41 variants B, D (eps 8), RF-03 isotropic variant (eps_par 9.3), CP-06 open-circuit study. Params override `spec.params[name]` (value replaced, unit kept when a number is given) before validation.
- H2 unit annotation: a unit string `<unit> (<note>)` is read as `<unit>` (WO-04 `1 (c/a)`).
- H3 extract kind `combine`: a target computed per level from other targets of the same case (`expr` over `{name: target id}`), so a target can span two specs (WO-21 gap / midgap from the lower and upper half cells).
- H4 pending specRef semantics: `ref` = an existing sims file that models the case although the case cannot gate on it yet; new key `proposed` = a proposed sims path with no file yet. Loader check (node-io, has fs): a `spec` / target `spec` path that does not exist is an error; a pending `ref` that does not exist is a warning; a `proposed` that exists is a warning ("point the case at it").

Case edits (task 1): for each case with a working sim, set `spec:` (case or per target) and `extract` per target; fix stale reasons and `missing` lists; move non-existent refs to `proposed`; fix the 4 wrong ids.
- Class a: SM-21 (lame-cylinder, probes; unit `length` -> `m` with the sim's assumption), RF-02 (wr90-te-cutoffs, eigen floor 1e6), WO-21 (bragg-edge-lower/-upper per target, expr f / (c0 / lambda0); gap / midgap via H3), CP-02 (nafems-le11, result node szz_A), CP-21 (nafems-t1-hotspot, result node syy_D).
- Class b: WO-41 (split the 4-variant array target into 4 targets with the same values and tolerance; H1 for B, D), CP-43 (tfln-mzm-eo, result nodes VpiL, ng). WO-02 stays pending (t = 0 not modelled; 3 levels need 2.5-5.5 GB RSS, DevLog-022 s.8); reason updated.
- Class c: HT-61 (poisson-square), CP-03 (heated-wire; q via expr), RF-62 (cpw-halfspace; n_rf via expr), RF-03 (cpw-sapphire; H1 variant), WO-04 (phc-square-rods-lower/-upper per target), WO-65 (si-strip-te0), CP-06 (pzt4-cube, H1 study), EM-61 (micro-coax-lgeom for L_geom; L_kin, L_total stay pending, gated, so the case stays pending), WO-63 (phc-point-defect, non-gated; case stays pending by design).
- Heavy cases: run levels as the case defines; if a level exceeds the 2 GB RSS rule, use per-target `levels` (schema field) and record it in the case notes and here, never the tolerance.

Expected JSONs (task 2): CP-02, SM-02, SM-05, SM-22 headers cite missing files; check `validation/a/gen_*.py` coverage, run the generator only if it covers the case and writes only the missing file (zip backup of eval/expected first).

Builders (task 3): class a: extend PRESERVE lists or the builder per case for every field I edit outside the preserved set (status, missing, notes, unit, spec). Class c: add a T2 wiring block (as the I1 wiring) carrying DevLog-035 s.13 edits and mine, plus `--out DIR` and a `test_build_matches.py` that rebuilds into a temp dir and diffs against `eval/cases/c`.

Full run (task 4): `node --max-old-space-size=1536 packages/eval/src/cli.ts --class X` for a, b, c sequentially, `nice -n 10`, BLAS threads 2; RSS sampled with `/usr/bin/time -l`; JSONL + summary in `logs/`.

## 3. TODO

- [x] H1-H5 + `--skip` in packages/eval, schema, README, tests (`test/hygiene.test.ts`, 6 tests)
- [x] class a case edits (SM-21, RF-02, WO-21, CP-02, CP-21) + builder (SM-21 unit, header, `spec_pending`)
- [x] class b case edits (WO-41 split + levels, CP-43 wiring, WO-02 / CP-08 / CP-42 / CP-44 / RF-41 / SM-42 reasons)
- [x] class c case edits through the builder (`t2_apply`: HT-61, CP-03, RF-62, RF-03, WO-04, WO-65, CP-06, EM-61, WO-63, CP-04) + `--out` + `test_build_matches.py`
- [x] proposed vs ref across all cases (0 loader warnings); wrong ids fixed (WO-21, RF-02, WO-04, EM-61; CP-06 `pzt-cube`)
- [x] missing expected JSONs: none needed (s.6)
- [x] per-case CLI runs; full run a, b, c (s.7)
- [x] T3 requests (s.9)
- [x] package tests, builder tests, validators (s.8)

## 4. Harness changes (packages/eval, eval/schema, eval/README.md)

| Id | Change | Files |
|---|---|---|
| H1 | specRef form `{sim: sims/<id>.yaml, params?: {name: number or expr string}, study?: <id>, note?}`: params replaced before `validateSpec` (number keeps the unit, string drops it), study chosen for single- and multi-physics specs; unknown param or study is an error | schema `$defs.specRef`; loader.ts `SimOverride`; registry.ts `applyOverrides`, `resolveSpec`, `select`, `caseStudy` |
| H2 | unit annotation: `1 (c/a)` read as `1` (only after a dimensionless head; `W/(m K)` untouched) | registry.ts `unitCore` (convertUnit, expr target unit, field relative check) |
| H3 | extract kind `combine`: `{expr, targets: {name: target id}}`, evaluated per level (matched by hFactor) after the spec groups ran; inputs in their target units; no nested combine; loader checks the ids | schema; loader.ts; registry.ts `combineTarget`, `observe` |
| H4 | pending `ref` = existing sims file (warning when absent); new `proposed` = planned path (warning when it exists); a run path (`spec`, target `spec`, `{sim}`) that does not exist is a loader error | schema; loader.ts `specPaths`, `ParseOptions.fileExists`; node-io.ts |
| H5 | fallback rule: a level-to-level change at the noise floor (<= 1000 eps x abs(f), or <= 1e-6 x the tolerance limit) counts as zero, so levels that agree to round-off (CP-03: exact P2 solution, changes 1e-13 relative) pass instead of "not shrinking" | evaluate.ts `fallbackGate`, `ROUNDOFF_REL`, `NEGLIGIBLE_OF_LIMIT` |
| - | `pi` available in `expr` and `combine` expressions (was "unknown variable 'pi'") | registry.ts `BUILTIN_CONST` |
| - | CLI `--skip ID,ID`: listed cases reported pending "skipped by --skip", not run (used for CP-43, over the 2 GB RSS rule) | cli.ts, runner.ts |

D: the harness rule for `after: richardson` (extrapolated value AND finest level within the budget) is unchanged; it is stricter than the DevLog-021/022 scratch runners (Richardson only) and is the reason for 2 of the 4 shortfalls (s.7, O1).

## 5. Case wiring (2026-11-18)

| Case | Spec | Extracts | Levels | CLI 09:08-09:11 |
|---|---|---|---|---|
| SM-21 | sims/lame-cylinder.yaml | probes `u` (comp 0/1) at A, B, D, F; `sxx`, `syy` at A; unit `length` -> `m` (builder; assumption added) | default 1, 0.667, 0.444 | pass 7/7 |
| RF-02 | sims/wr90-te-cutoffs.yaml | eigen floor 1e6, index 0/1/2; S21, S11 (gate false) pending | default | pass 3/3 gated |
| WO-21 | target specs bragg-edge-lower / -upper | expr f_0 / (c0 / lambda0); gap_to_midgap = combine | default | pass 3/3 |
| CP-02 | sims/nafems-le11.yaml | result `szz_A` | default | pass (fallback, changes shrinking) |
| CP-21 | sims/nafems-t1-hotspot.yaml | result `syy_D` | default | fail (s.7) |
| WO-41 | target specs; B, D via `{sim, params: {eps_core or eps_clad: 8}}`; array target split into n_eff_A..D (values, tolerance unchanged) | scalar neff_0 | h_factors 1, 0.5, 0.25 (DevLog-022 levels) | fail (s.7) |
| CP-43 | sims/tfln-mzm-eo.yaml | result VpiL, ng | levels [0] | not run: level 0 exceeds 2 GB RSS (s.7) |
| HT-61 | sims/poisson-square.yaml | expr T_max / 1 K | default | pass |
| CP-03 | sims/heated-wire.yaml | T_max, T_min; q = h (T_s - T_inf) 2 pi r0 L (constants from the case) | default | pass 3/3 (needs H5) |
| RF-62 | sims/cpw-halfspace.yaml | C_per_m; n_rf = c0 sqrt(L' C'); Z0 | default | fail (s.7) |
| RF-03 | sims/cpw-sapphire.yaml; isotropic targets `{sim, params: {eps_par: 9.3}}` | Z0 | default | pass (gated 1/1, 2 info) |
| WO-04 | target specs phc-square-rods-lower / -upper (also PWE, MPB-32 info targets) | expr f_0 a / c | default | pass 2/2 gated |
| WO-65 | sims/si-strip-te0.yaml | neff_0 (ng_energy: no extract, not comparable) | h_factors 1, 0.5, 0.25 (DevLog-022 levels; peak RSS 2022 MB) | pass |
| CP-06 | target specs `{sim: pzt4-cube, study: std_sc / std_oc}` | result f1_short ... f2_open | levels [0] (hFactor 0.667 exceeds 2 GB) | pass 4/4 |
| EM-61 | sims/micro-coax-lgeom.yaml | expr L' l | default | pending (L_geom pass; L_kin, L_total gated, no London model) |
| WO-63 | pending, ref phc-point-defect | none | - | pending (non-gated only; 1.0M DOF) |
| CP-04 | pending, ref hot-arm-actuator | none | - | untestable (DevLog-035 s.13 text kept by the builder) |
| WO-02 | pending, ref hadley-rib-wo02 (was si-rib-waveguide) | none | - | pending (t = 0, array target, 2.5-5.5 GB) |

Pointers fixed: WO-21 `bragg-stack` -> target specs; RF-02 `wr90-guide` -> wr90-te-cutoffs; WO-04 `phc-square-rods` -> -lower / -upper; EM-61 `micro-coax-london` -> micro-coax-lgeom; CP-06 builder id `pzt-cube` -> pzt4-cube. Every other pending case now uses `proposed` (no file) with a per-case reason (class a: DevLog-021 s.4.1 gaps; class b: rewritten where stale; class c: generic pointer to DevLog-022 s.3.5). Dry run: 85 cases, 0 loader errors, 0 warnings.

## 6. Expected JSONs (task 2)

F: CP-02, SM-02, SM-05, SM-22 have no basis-D target and no `expected:` link; their values are cited (P / S). No generator in validation/a covers them (`gen_solid.py` has sm01, sm03, sm04, sm06, sm07, sm21, cp21). The header line was the builder's fixed text; `build_cases.py` now writes "from cited values (no basis-D target, no expected JSON)" for such cases and the 4 headers are corrected. No JSON generated.

## 7. Full CLI run (2026-11-18 09:08-09:11 PST, nice 10, heap cap 1536 MB, BLAS threads 2, RSS guard 2 GB)

Final rerun after T3's sims changes (DevLog-040 s.6), 2026-11-18 09:14-09:17 PST: class a `logs/eval-20261118T091440.jsonl` (15 pass, 1 fail, 13 pending; peak 702 MB), class b `logs/eval-20261118T091532.jsonl` (`--skip CP-43`; 0 / 1 / 19), class c first attempt stopped by the guard during WO-65 (2161 MB, console log discarded, its JSONL was never written), class c again with `--skip WO-65`: `logs/eval-20261118T091636.jsonl` (7 pass, 1 fail, 28 pending; peak 1550 MB). Totals of the final run: 22 pass, 3 fail, 50 pending, 8 untestable, 2 skipped (CP-43, WO-65) of 85. WO-65 passed in the 09:09 run below (class peak 1660 MB; alone 2022 MB at 09:03) but needs 2.0-2.2 GB at its finest level (506k DOF), so it is at the memory rule's edge (O3). The tables below are from the 09:08-09:11 run; the final run differs only in WO-65 (pass -> skipped).

Logs: class a `logs/eval-20261118T090857.jsonl` + `-summary.md` (console `logs/T2-eval-a-20261118T090856.log`, 51 s, peak RSS 757 MB); class b `logs/eval-20261118T090950.jsonl` (`--skip CP-43`, 6 s, 482 MB); class c `logs/eval-20261118T090956.jsonl` (69 s, 1660 MB).

| class | cases | pass | fail | pending | untestable | skipped (RSS) |
|---|---|---|---|---|---|---|
| a | 29 | 15 | 1 | 13 | 0 | 0 |
| b | 20 | 0 | 1 | 15 | 3 | 1 |
| c | 36 | 8 | 1 | 22 | 5 | 0 |
| all | 85 | 23 | 3 | 50 | 8 | 1 |

| domain | cases | pass | fail | pending | untestable | skipped |
|---|---|---|---|---|---|---|
| AC | 5 | 1 | 0 | 3 | 1 | 0 |
| CP | 13 | 3 | 1 | 5 | 3 | 1 |
| EM | 6 | 4 | 0 | 2 | 0 | 0 |
| FL | 15 | 0 | 0 | 13 | 2 | 0 |
| HT | 5 | 5 | 0 | 0 | 0 | 0 |
| RF | 8 | 3 | 1 | 4 | 0 | 0 |
| SC | 2 | 0 | 0 | 2 | 0 | 0 |
| SM | 12 | 3 | 0 | 9 | 0 | 0 |
| TR | 6 | 0 | 0 | 5 | 1 | 0 |
| WO | 13 | 4 | 1 | 7 | 1 | 0 |

Class a vs 2026-11-07 (`logs/eval-20261107T102633-summary.md`): cases 11 pass / 0 fail / 18 pending -> 15 / 1 / 13; targets 37 pass / 95 pending / 4 info -> 51 pass / 1 fail / 80 pending / 4 info. The 11 earlier passes still pass (after the S4 perf work present on disk at 09:08).

CLI passes: 23 in the 09:08 run, 22 reliably within the 2 GB rule (WO-65 borderline) (13 before + SM-21, RF-02, WO-21, CP-02, HT-61, CP-03, RF-03, WO-04, WO-65, CP-06). Target 27: shortfall 4, each a real result, no tolerance or reference touched:
- CP-21 fail: sigma_yy max 49.794 / 49.875 / 49.741 MPa at 21.7k / 38.4k / 74.3k DOF (ref 50 MPa, tol 1.5 %): every level within tolerance, but Richardson is unavailable (oscillatory) and the fallback needs shrinking level changes (8.2e4, 1.3e5 Pa). The scratch run (DevLog-035 s.12) was one level.
- WO-41 fail: finest level outside abs 1e-7 for all four variants (A 5.1e-7, B 2.1e-7, C 8.6e-7, D 5.2e-6 at 57.6k DOF) although the Richardson values of A, C, D are within 1e-7 (-2.5e-9, +1.6e-9, -2.7e-8; B oscillatory). Harness rule: extrapolated AND finest within the budget (D above). A finest level within 1e-7 would need about 1M DOF (E: from the observed order 1.8), above the memory rule.
- RF-62 fail: C' and Z0 finest level 5.3e-4 and 5.3e-4 relative off (tol 1e-4) at 125k DOF; Richardson values 6.1e-5 and 1.6e-5 off (within); n_rf passes. Same rule as WO-41; DevLog-022 already noted "the pass needs Richardson".
- CP-43 not run: level 0 (345k DOF, electrostatics -> em-modes) reached 2048 MB RSS after 33 s and was stopped by the guard (2026-11-18 09:0x); wired with `levels: [0]` for a larger machine or after S4 / B6 memory work.

## 8. Tests (2026-11-18 09:07-09:12 PST)

- `cd packages/eval && node --test --test-concurrency=1 test/*.test.ts`: 86 / 86 pass (80 before + 6 in `test/hygiene.test.ts`); `npx tsc -p . --noEmit`: clean.
- `cd validation && uv run python a/test_build_preserves.py`: ok (255 preserved paths, 0 changed, 0 files changed by an in-place rebuild, 167 target values match; `logs/l7a-check-20261118T090714.log`).
- `uv run python c/test_build_matches.py` (new): 36 / 36 class-c files reproduced byte for byte by a fresh build.
- `uv run python c/validate_cases.py`: 36 cases, 112 references, 0 errors. `b/check_cases.py`: 20 cases, 0 with errors. `a/validate_cases.py`: 29 / 29 pass.
- CLI `--dry-run` over all classes: 85 cases, 0 loader errors, 0 warnings.

## 9. Requests

To T3 (sims, library):
- R1 `sims/cylinder-cavity-qd.yaml` `# eval: [RF-21]`: RF-01's Q_d target also runs on it; add RF-01.
- R2 `sims/cylinder-cavity.yaml` `# eval: [RF-21, RF-01]`: no case runs on this 3D hero (RF-21 and RF-01 run on cylinder-cavity-axisym + cylinder-cavity-qd); mark the pairing informative or drop it.
- R3 `sims/si-rib-waveguide.yaml` `# eval: [WO-02, WO-01]`: WO-01 runs on si-slab-te0 / si-slab-tm0; WO-02's pending ref is now hadley-rib-wo02. Same informative / drop choice.
- R4 `sims/heat-plate-fin.yaml` `# eval: [HT-01]`: HT-01 runs on nafems-t4 (the hero is built on it); same choice.
- R5 `sims/joule-wire.yaml` `# eval: [CP-03]`: CP-03 runs on heated-wire; joule-wire is an alternative chain (fine as a pairing; note only).
- R6 library catalogs (`catalog-bc.ts`, `catalog-mp.ts`): the newly wired cases now run on the harness (s.5); `via`/`log` could point at the s.7 JSONL. CP-21, WO-41, RF-62 show "pass" in the catalogs but fail on the CLI rule (s.7); CP-43 is not CLI-run here.
- Already with T3 (not repeated): helmholtz-coil EM-03, kirsch-plate SM-02, cylinder-cavity-axisym missing RF-01. Coordinator note 09:13: T3 fixed these and si-rib-waveguide (-> [WO-02], so R3 is done) and is no longer running; R1, R2, R4-R6 go to the coordinator.
- T3 renamed evaluation items (DevLog-040 s.6: box-acoustics, bragg-edge-*, wr90-te-cutoffs, cylinder-cavity*, semi-infinite-convection): no case extract references them (the T2 extracts use module scalars / eigen lists; `result` nodes used: VpiL, ng, f1_short..f2_open, syy_D, szz_A, all present at 09:14). AC-02, RF-02, RF-21, HT-04, WO-21 rerun at 09:14: pass.

To the coordinator:
- C1 CONTRACTS-v0 C8 changelog line (schema is authoritative, additive): specRef `{sim, params, study}`; pending `ref` (existing file) vs `proposed` (planned); extract kind `combine`; unit annotation `1 (note)`; `pi` in expressions; fallback noise floor; CLI `--skip`.
- C2 decision on O1.

## 10. Open items

- O1 Richardson rule: `after: richardson` needs the extrapolated value AND the finest level within the budget. RF-62 and WO-41 (A, C, D) pass on the extrapolated value alone; to pass they need finer meshes than the 2 GB rule allows here, or a rule change (coordinator / eval owner decision, not changed here).
- O2 CP-21: the `syy_D` item is a nodal max over the membrane; its level sequence oscillates (polygonal circle). A point probe just outside D, or a mesh that conforms to the circle at every level, may give a monotone sequence (request to T3 if wanted).
- O3 CP-43 and CP-06 run on level 0 only (memory); WO-65 needs 2.0-2.2 GB at its finest level (2022 MB alone at 09:03, guard stop at 2161 MB in the 09:16 class run), so the full run skips it. S4 / B6 memory work would let them run on the case's full level sequence.
- O4 WO-41 B (eps 8) is oscillatory at levels 1, 0.5, 0.25 (as DevLog-022 found on 3 levels).
- O5 CP-04 citation "JMM 11:252" is the VM page's typo for JMM 11(5) 452-462 (DevLog-035 s.2.7); not changed in the case (not re-verified by T2).
- O6 class-c builder: `spec_default` picks `ref` or `proposed` from the presence of `sims/<id>.yaml` at build time, so a sim added by T3 flips the pointer on the next rebuild (intended).

## 11. Progress log

- 2026-11-18 08:47 PST: start; read CLAUDE.md, DevLog-037, harness (loader, registry, engine-worker, runner, cli), DevLog-021 s.4, DevLog-022 s.3/6/8, DevLog-035 s.12/13.
- 2026-11-18 08:48 PST: `validation/a/test_build_preserves.py`: ok (log `logs/l7a-check-20261118T084821.log`).
- 2026-11-18 08:51 PST: inventory (s.1) and plan (s.2) written.
- 2026-11-18 08:52-08:55 PST: H1, H3, H4 (schema, loader, registry, node-io); eval tests 80 / 80; dry run shows 43 `spec-ref` warnings (pending refs to missing files).
- 2026-11-18 08:56 PST: class-a edits (SM-21, RF-02, WO-21, CP-02, CP-21) and builder (SM-21 unit, header, `spec_pending`); `test_build_preserves.py` ok. CLI: SM-21, RF-02, WO-21, CP-02 pass; CP-21 fail.
- 2026-11-18 08:58-09:00 PST: WO-41 split + overrides: fails on default levels and on 1 / 0.5 / 0.25 (finest-level rule). CP-43 wired: level 0 stopped at 2 GB RSS.
- 2026-11-18 09:00-09:04 PST: class-c T2 wiring in the builder; H2, H5, `pi`; HT-61, CP-03, RF-03, WO-04, WO-65 (ratio-2 levels, 2022 MB), CP-06 (level 0, 1541 MB) pass; RF-62 fails; EM-61 pending.
- 2026-11-18 09:05-09:07 PST: `--skip`; class-b and class-a pending reasons, `proposed`; `test_build_matches.py`; tests and validators green; README.
- 2026-11-18 09:08-09:11 PST: full CLI run a, b (skip CP-43), c (s.7).
- 2026-11-18 09:12 PST: results, requests and open items written.
- 2026-11-18 09:13-09:17 PST: coordinator note on T3's item renames: no extract affected (checked); affected cases rerun; full rerun a, b, c (WO-65 over 2 GB in the class run, then skipped).
