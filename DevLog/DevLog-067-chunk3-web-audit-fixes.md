# DevLog-067: chunk 3 web audit fixes (fix lane FX3-web)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | FX3-web (DevLog-037, Audit 3 web / data hygiene, 19:51 PST entry) |
| Owns | `apps/web/src/lib/workbench/**`, `apps/web/src/lib/gfx/**`, `apps/web/src/lib/library/**`, `apps/web/scripts/previews.ts`, `apps/web/src/lib/post/**` (item 2 worker message only), `apps/web/test/**`, `sims/*.yaml` (text only) |
| Does not touch | `apps/web/src/lib/results/adapter.ts`, packages (FX3-engine, DevLog-066), previews images / previews.json (coordinator regenerates), git, e2e |

Conventions: F = fact read from code or a run; D = decision; O = open item.

## 1. Facts (2026-11-18 19:55-19:59 PST)

- F: `Session.queueEval` dedups against `evalQueue` only; `drainEvals` shifts the entry before it awaits, so the in-flight point is not in the queue. `onPoint` queues a solved point, then `showPoint` (same tick) sees `evals === null` and queues it again: every displayed point is evaluated twice. `drainEvals` does not skip points whose `evals` is already set.
- F: `SweepPlot` counts every solved point with `evals === null` as "being evaluated" (waiting, skipped by the cap and never queued alike). `evalsOfTable` returns nothing for a table without rows (`sweep-evals.ts:41`), and a group that throws is only logged, so its error never reaches the gap reason ("not in the table of this point"). `evalQueue` is not cleared on a new sweep or on cancel (stale entries are skipped by token but keep their solutions alive).
- F: `Graphics.hover` on a complex part (|.|, phase, Re(u e^(j phi))) calls `probe2d` twice per mouse move: each posts the full Re / Im data arrays (structured copy) to the post worker.
- F: complex vector (2-component DG0 derived fields of `wave2d`: `<D>_re`, `<D>_im`): `comp` is forced to 0 for phase and Re(u e^(j phi)) when the magnitude is chosen; |.| at comp -1 combines the norms of Re and Im (equal to |u| since |u|^2 = |Re|^2 + |Im|^2).
- F: catalog `tsv-stress-3d`: '4/4 gated (+4 info)', log `logs/E3-cli-pk-all-20261118T140900.log`; current PK-02 run `logs/integ-sims-cli-PK-02-20261118T185426.log`: 6 pass + 2 info (cu_srr, cu_szz, si_szz, cu_sxx_mean, si_szz_mean, rim_ur; si_srr_2a, si_sphi_2a info).
- F: camera select `value={camNow ?? 'custom'}`: picking the shown preset fires no change event; `presetOfPose` compares only the view direction.
- F: catalog-bc phc-square-rods-lower / -upper: `ref: { ...RUN (2026-11-06, w4 log), status: 'not-run', note: '... now runs on ...' }`.
- F: `scripts/previews.ts` l.212 `pick` falls back to the first 3D group while l.334 labels any pick with `last` set as "last physics of the coupling chain".
- F: sims: 36 lines with DevLog-NNN in 28 files; R3, H1..H6, H11, "lane MX", "lane MOM", "the lane's", "DevLog-034 F1", "contract request", "hero" in shown values; the user's name in bimetal-strip, ln-fbar-2d, membrane-air (comments, `source`, `assumptions`).

## 2. Plan

1. Sweep evaluation queue to a pure class `SweepEvalQueue` (`workbench/sweep-evals.ts`): waiting list + in-flight entry; `push` skips a point that is in flight, waiting or already evaluated (`done` callback); the drain skips points whose `evals` is set; cap `SWEEP_EVAL_PENDING` drops the oldest waiting entry and marks the point skipped; `clear()` on a new sweep and on cancel; per-point state `queued | running | skipped | null` read by `publish`. Session uses it. Test: fake evaluator counting calls (onPoint + showPoint sequence: 1 call per point; evaluated point not re-queued; cap skip; clear).
5. `SweepPoint.evalState` (`queued`, `running`, `skipped`, null) and `evalFailed` (group id -> message: a thrown group or a table without rows and with errors). SweepPlot tip: counts of being evaluated / skipped (evaluated when shown) / not evaluated; `evalGaps` reasons: per state, failed group's error. Comment states the real memory bound (waiting + in-flight + held + post worker LRU).
2. Post worker message `pair` (Re / Im fields resident, set once per pair / step / component by an effect, like `setField`); the `probe` reply carries Re and Im per component at the hovered point (same `evalElement` on the per-domain field as `evalAt`). Hover combines locally (no field copy per move). Clicks keep `probe2d`. Pure helper `probePair` in `field2d.ts` tested equal to the `evalAt` path.
6. Complex vectors at comp -1: |.| and Re(u e^(j phi)) = norm over components of the per-component part (`complexVectorValue`; renderer: four lattices Re / Im x 2 components, combined per frame on the CPU for Re(u e^(j phi))); phase stays per component (a norm of phases is not physical: comp forced to 0 as before, stated in the tip). Test.
4. Camera: select shows the current preset as a placeholder option (value cleared after apply), so the shown preset can be picked again; `presetOfPose(pose, lookAt)` also requires the look-at point within tol x distance of the preset's look-at (last applied lookAt, else the view centre). Test.
3. catalog-pkg tsv-stress-3d: targets '6/6 gated (+2 info)', its own run constant (date, log of the PK-02 run).
7. catalog-bc phc analogs: no run date / log; note in plain past tense with the date of the earlier pass written out.
8. previews.ts: plan records why the group was picked; label follows it.
9. sims text (after the class-c eval run ends): rewrite shorthands and the personal name; YAML parse diff (only strings changed, comments ignored) per edited file; `pnpm --filter @amp/spec test`.
Gates: web check clean; web test (137 before) + new tests; spec test; Python scan of sims, catalogs, UI strings.

## 3. Progress

- 2026-11-18 19:59 PST: plan written.
- 2026-11-18 20:00-20:03 PST: items 1, 5 (queue class, Session, SweepPlot), tests `fx3-sweep-queue.test.ts` 5/5.
- 2026-11-18 20:03-20:05 PST: items 2, 6, 4 (worker `pair` message, `probeHit`, vector norms, camera), tests `fx3-gfx.test.ts` 4/4. Class-c eval run ended (pgrep empty) before the first sims edit.
- 2026-11-18 20:06-20:09 PST: items 3, 7, 8; item 9 sims rewrite (scratch script, 36 files incl. six with lane id L4 / L7c found by the scan), YAML parse diff, spec test.
- 2026-11-18 20:09-20:12 PST: web check, web test (three older tests asserted the sims header '# H1 Plate with a hole': updated), final scan.

## 4. Results

| Item | Change | Verification |
|---|---|---|
| 1 sweep points evaluated twice | `workbench/sweep-evals.ts SweepEvalQueue`: waiting list + in-flight entry; `push` refuses a point in flight, waiting or evaluated; the drain skips a point evaluated while it waited; evaluation errors logged, drain continues. `Session` uses it (`evalPoint` per job) | `fx3-sweep-queue.test.ts` (fake evaluator counting calls): onPoint + showPoint in the same tick -> 1 call per point (4 points, 4 calls); evaluated point not re-queued; drain skip |
| 5 sweep eval states | `SweepPoint.evalState` (queued / running / skipped / null, set in `publish`), `evalFailed` (group -> error: thrown or `tableFailure` = no rows with errors); `evalCounts`, `evalGaps(sw, key, group)` reasons per state and "evaluation group g failed: ..."; SweepPlot tip lists being evaluated or waiting / skipped / not evaluated; queue cleared on a new sweep, on a non-sweep compute and on cancel; `SWEEP_EVAL_PENDING` comment states the bound (8 waiting + 1 in flight on top of SWEEP_HELD; results client MAX_RUNS 4 worker copies + main-thread references) | same test file: cap skip state, re-queue when shown, clear, gap texts, counts; g7 test expectation updated to the new reason text |
| 2 complex hover | post worker message `pair` (key, Re, Im through `withPerDomain`), set by a Graphics effect once per pair / step; `probe` reply carries Re and Im of every component (`field2d.ts probeHit`, `componentsAt`); hover combines locally; a stale key falls back to the exact `evalAt` path once; clicks keep `evalAt` (per component) | `fx3-gfx.test.ts`: hover (probeHit) = click (probe2d through the worker's evalAt logic) bitwise for a P2 scalar pair and a 2-component DG0 pair, comps -1 / 0 / 1, all five parts, 4 points; at P2 nodes hover abs = hypot(nodal Re, Im) within 1e-12 relative |
| 6 complex vectors | `complex.ts complexVectorValue` (comp -1: norm over components of the per-component part; phase of a vector null), `instNorm`, `peakAbsVector`; comp forced to 0 only for the phase; renderer: Re(u e^(j phi)) at magnitude from per-component Re / Im lattices, norm per frame on the CPU, range 0..max |u|, colorbar note; component select tip | `fx3-gfx.test.ts`: circular polarisation (1, -j) has length 1 at every phase; instNorm = per-point value; |u| identity |
| 4 camera | select shows the current view as a hidden placeholder option and returns to it after each pick (the shown preset can be applied again); `presetOfPose(p, tol, lookAt)` requires the look-at point within tan(tol) x distance; `currentPreset()` tries the view centre (`CameraTarget.centre`, Canvas3D) and the last explicit lookAt | `fx3-gfx.test.ts`: pan -> null, explicit lookAt -> preset, re-apply |
| 3 tsv-stress-3d | `RUN_PK02` (2026-11-18, `logs/integ-sims-cli-PK-02-20261118T185426.log`), '6/6 gated (+2 info)'; no newer PK-02 log at 20:11 | log read: 6 pass, 2 info |
| 7 phc analogs | no `...RUN` date / log on the not-run entries; note: "this scalar analog passed gap_lower 1/1 gated on 2026-11-06 (log)"; no "now" | grep: no relative time words in catalog strings |
| 8 previews label | `Plan.why` ('last' / 'first3d' / null); label follows it; fallback 'default result view of the workbench' | web check (scripts included) |
| 9 sims text | 36 files: DevLog refs, R3, H1-H6, H11, lane MX / MOM / L4 / L7c, "the lane's", "contract request", "hero" (sims and catalog notes / tags -> "showcase"), personal name and pronouns -> "the author's own model inputs" / "the source model" | YAML parse diff (`logs/fx3-web-sims-yamldiff-20261118T200920.log`): 36 files, 0 non-string changes (only `source` / `note` / `text` / `what` strings and comments); spec test 65/65 (`logs/fx3-web-spec-test-20261118T200926.log`) |

Gates: web check 0 errors 0 warnings (`logs/fx3-web-check-20261118T201214.log`); web test 146/146 (137 + 9 new; `logs/fx3-web-test-20261118T201047.log`); spec test 65/65; final scan (`logs/fx3-web-scan-20261118T201140.log`): DevLog refs 0, lane ids 0, contract request 0, R ids 0, personal names / pronouns 0 in sims, catalogs and UI strings; the 7 remaining "hero" / "H1" hits are false positives (H1 = the FE space in GfxStatus; `entry.hero` property and `./heroes` import paths in markup).

## 5. Open items

- O1: not checked in a browser (no e2e by this lane): camera select placeholder rendering, the vector Re(u e^(j phi)) animation, hover through the resident pair in the real worker. Covered by unit tests on the pure parts; the coordinator's e2e / previews pass exercises the views.
- O2: `materials/titanium.yaml`, `gaas.yaml`, `pzt-4.yaml` header comments carry "lane MX", "lane MOM", DevLog refs (not owned; shown if the material YAML is displayed). `packages/spec/test/fixtures/*.yaml` keep the old sims headers (test fixtures, not shown).
- O3: atlas case file names (K1, K4, K6a) stay in sims comments and sources: real file names in the eo-modulator-atlas repo.
- O4: the phase of a complex vector at magnitude shows component 0 (no physical vector phase); stated in the component select tip.
