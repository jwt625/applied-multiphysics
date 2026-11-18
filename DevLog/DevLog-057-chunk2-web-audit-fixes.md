# DevLog-057: chunk 2 web / agent / data audit fixes (fix lane FX-web)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | FX-web (DevLog-037 progress 14:37 audit, web / agent / data hygiene) |
| Owns | `apps/web/src/lib/state/**`, `apps/web/src/lib/gfx/**`, `apps/web/src/lib/engine/client.ts`, `apps/web/src/lib/results/adapter.ts`, `apps/web/NOTICE`, `packages/agent/**`, `apps/web/test/**`, sims named in s.2 item 7 / 8 |
| Does not touch | `packages/physics/src/wave2d`, `prepare.ts`, physics `index.ts`, WO-72 files, `catalog-driven.ts` (lane FX-engine, DevLog-056), git |
| Timing | e2e smoke with a watching dev server until 14:50 PST: no edits under packages/, apps/, sims/, eval/, validation/, materials/ before then |

Conventions: F = fact read from code or a run; E = estimate; D = decision; O = open item.

## 1. Facts found before planning (2026-11-18 14:39-14:46 PST)

- F: `edit-ops.ts` `rewriteDotted` handles `rename` and `remove`; `duplicateNodePatch` inserts at `<list>/<i+1>` with no dotted-path shift, and gives fresh ids only to a physics node's `bcs`.
- F: `nafems-le11.yaml` provenance keys are index addressed (`geometry.features.1.settings.size` = zbox, `geometry.features.3.settings.radius` = c_in, `geometry.features.5.settings.points` = upper).
- F: `view-link.ts` `num` accepts `1e999` (Infinity); `c:` bounded only by `-1..15`; Graphics `comp` derived from `compUser` unbounded by `field.components`, so `data[components*n + c]` reads the next node for `c >= components`. Agent `quick_view.component` max 8.
- F: `sweep.ts` `setSweepPatch`: `replace /physics` when the study has no `physics` key (invalid RFC 6902 op); with absent `settings` it returns only the settings add and drops the queued physics op.
- F: `client.ts` `runSweep` recreates the pool whenever `poolSize(jobs.length)` differs from the pool size (job count dependent); idle workers live until `dispose`.
- F: polygon points accept param expressions (nafems-le11 `"z4 + 0.69[m]"`; `@amp/core` params: sqrt, tan, ...). In tfln-rib-air / -oxide the rib polygon and `topr` (air / oxide above, bottom 0.3 um) are literal; `t_film` is not used anywhere, `w_top` not used, `t_slab` only in the slab rect.
- F (scratch runs, `<scratch>/fx-web/air-*.yaml`, single mesh level via the prepareRun / runStudy driver): literal polygon n_eff_0 1.894167342802788 (dof 63041); polygon from params with 1/sqrt(3) walls 1.894167367928181 (dof 62977); with the atlas-rounded wall coefficient 1.8941673489198774 (dof 62977); literal polygon with y in nm 1.894167354944464 (dof 63075). The mesh changes with 1e-22 m coordinate differences (0.3 um literal = 3e-7 m, t_slab 300 nm = 3.0000000000000004e-7 m), so a bitwise or 1e-12 match is not reachable with any rewrite; the spread is 2.5e-8 in n_eff (WO-82 tolerance 1e-6 abs, after Richardson). With t_film 700 nm the parameterized model changes (n_eff 1.93037), so the params act.
- F: matplotlib `lib/matplotlib/_cm_listed.py` (main, fetched 2026-11-18) carries `_twilight_data` with no author or licence comment; `doc/release/prev_whats_new/whats_new_3.0.rst` announces twilight without an author; `LICENSE/` has no twilight-specific file. Pull request matplotlib/matplotlib#6254 "adds two new cyclic color schemes" (GitHub user bastibe, closed 2018-05-28) contributed twilight (viscm-derived) to matplotlib; it states no separate licence.

## 2. Plan

1. Duplicate shifts dotted paths: `rewriteDotted` gets an `insert` action (paths whose node index at the list depth is > i are shifted by +1; paths into the original stay). `duplicateNodePatch` = add op + diff of the dotted sections (as delete). Test: nafems-le11 duplicate `/geometry/features/0`, every provenance key resolves to the same node id before and after; si-microheater-to, tfln-mzm-eo likewise (all features / materials / physics nodes duplicated in turn, all provenance, assumption and missing paths resolve to the same nodes).
2. Duplicate gives fresh ids to every nested `id` in the copy (feature, material, physics, condition). Test.
3. Component bound: `boundComponent(c, n)` in `view-link.ts` (kept if integer, `-1 <= c < max(n, 1)`, else -1 = default). Graphics: `comp` bounded by the drawn field's components; `compUser` reset to -1 when the drawn field (name, physics) changes after the first one; link `c:` applied through the bound. Agent: `setQuickView` refuses an out-of-range component with a message (components of the target field); schema description states the bound. Tests: pure helper + agent quick_view refusal path (mock hooks).
4. `decodeView`: numbers must be finite; camera with non-finite values or zero distance (pos = target) ignored. Test `decodeView('ph:1e999~cam:1e999_0_0_0_0_0')` = {}.
5. `setSweepPatch`: `add` vs `replace` per key presence for physics and settings; absent settings: physics op kept plus settings add. Tests for absent settings and absent physics (apply the patch with the @amp/spec patch applier and compare to the expected node).
6. Sweep cap: `MAX_SWEEP_POINTS = 200` (D: design limit, matches the existing 200-value bound of `define_sweep` values; each point is a full solve) in `sweepProblem`; agent `define_sweep` axis `n` max 200 and description. `runSweep`: pool size from the device rule independent of the job count (`poolSize(POOL_MAX)`; `WorkerPool.run` already uses min(size, jobs)) so the pool is recreated only when the size rule or the workers toggle changes; idle pool disposed 10 s after a sweep completes (D: short idle time; restarting costs one worker start per sweep). Tests: sweepProblem cap; client idle disposal with a mock Worker if client.ts loads in Node, else record as O.
7. tfln-rib-air / -oxide: polygon `[-(w_top/2 + (t_film - t_slab)/sqrt(3)), t_slab]`, `[+..., t_slab]`, `[w_top/2, t_film]`, `[-w_top/2, t_film]` (60 degree walls fixed, stated in the description); `topr` from `t_slab`. Verify with the em-modes CLI cases WO-82, WO-83 (pass/fail and values vs the pre-change values in the latest eval logs); record the 2.5e-8 non-bitwise change and its cause.
8. Shorthands: rewrite the named provenance strings and adapter messages in plain words; scan sims/*.yaml, catalog-*.ts, materials non-comment lines and new UI / tool description strings for lane codes; fix in owned paths, list others for the coordinator.
9. NOTICE and colormaps.ts header: twilight from matplotlib PR #6254 (GitHub user bastibe, 2018-05-28), distributed under the matplotlib licence; no separate licence stated; URLs and access date 2026-11-18.
10. Test: custom OpenAI-compatible endpoint stores its key under the per-origin name and fetch hits only that endpoint.

Gates: web check clean, web test (119 before), agent test + check (75 before), spec test.

## 3. Progress

- 2026-11-18 14:46 PST: Facts and plan written; scratch geometry runs done (s.1). Waiting for 14:50 before edits.
- 2026-11-18 14:48 PST: Item 8 sims text delegated to one helper subagent (read before 14:50, edits after; WO-72 / mmi-1x2-splitter and the two tfln-rib files excluded). It reported one empty temp file created and removed in packages/spec before 14:50 (no leftover).
- 2026-11-18 14:50-14:56 PST: Items 1-7, 9, 10 and the adapter / tfln text of item 8 implemented with tests.
- 2026-11-18 14:55 PST: WO-82, WO-83 CLI pass (logs/fxweb-WO-8x-20261118T145527.out, records logs/eval-20261118T145527.jsonl, -145531.jsonl).
- 2026-11-18 14:56-14:57 PST: Gates green (logs/fxweb-gates-*-20261118T1456*.log); helper's sims rewrite (29 sims, catalog-bc tag) spot-checked; re-scan leaves only file names (K1.yaml, K2.yaml, K3.yaml) and Ansys VM223 keypoint names.

## 4. Results

| Item | Change | Test |
|---|---|---|
| 1 duplicate shifts dotted paths | `rewriteDotted` action `insertAfter` (+1 on later siblings' index segments); `duplicateNodePatch` = add + diff of provenance / assumptions / missing (provenance keys that move are re-added at the end of the map, as delete does) | `apps/web/test/fx-edit-ops.test.ts`: nafems-le11 dup of features/0 (zbox -> features.2, c_in -> .4, upper -> .6; undo restores text); every feature / material / physics / condition of nafems-le11, si-microheater-to, tfln-mzm-eo duplicated in turn, all dotted paths resolve to the same nodes, ids unique |
| 2 nested ids | every nested `id` of the copy gets `<prefix>_copy<n>` (document order) | same file, synthetic feature / material / condition / physics |
| 3 component bound | `boundComponent`, `componentProblem` (view-link.ts); Graphics `comp` bounded by the drawn field's components, `compUser` reset to -1 when the drawn entry changes (link component bound to the link's field, or the first field drawn), quick view reports the bounded value, `setQuickView` refuses with a message for the requested field; agent `quick_view` refuses `component_out_of_range` for the shown field, schema max 15 with the rule in the description | `fx-view-link.test.ts`, `packages/agent/test/fx-web.test.ts` |
| 4 non-finite link numbers | `num` returns finite numbers only (`e+NN` accepted); camera ignored when the distance is zero or not finite; encode never writes such a camera | `decodeView('ph:1e999~cam:1e999_0_0_0_0_0')` = {} and others |
| 5 setSweepPatch | add vs replace per key presence (physics, settings, study, sweep); absent settings keeps the physics op | `fx-sweep.test.ts` (patches applied with `applyPatch`) |
| 6 sweep size, pool | D: `MAX_SWEEP_POINTS = 200` (design limit) in `sweepProblem`; agent `define_sweep` n 2..200; `runSweep` pool size `poolSize(POOL_MAX)` (job-count independent, so a smaller sweep reuses the pool), idle pool disposed `POOL_IDLE_MS = 10000` ms after a sweep (D: design choice); client.ts imports with `.ts` so it loads in Node | `fx-sweep.test.ts` (cap), `fx-pool-idle.test.ts` (mock Worker, mock timers), agent `fx-web.test.ts` (schema) |
| 7 tfln rib params | D: polygon from params, `[-(w_top/2 + (t_film - t_slab)/sqrt(3)), t_slab]`, ..., `[+-w_top/2, t_film]`, walls fixed at 60 degrees (header comment); `topr` from `t_slab`. Not bitwise (s.1: the mesher reacts to the 4e-23 m difference between 0.3 um and 300 nm): WO-82 neff_0 L0 1.894167342802788 -> 1.894167367928181, L1 1.8941675693078046 -> 1.8941675722238809, ng_0 L1 2.290849152342247 -> 2.2908491546938134; WO-83 neff_0 L0 1.912374542246369 -> 1.9123745571166917, L1 1.9123755209773068 -> 1.9123755225398726; all targets pass (tol 1e-6 / 5e-7 abs). t_film 700 nm changes the solve (scratch run) | CLI WO-82, WO-83 |
| 8 shorthands | adapter.ts messages in plain words; tfln-rib provenance; helper: 29 sims + catalog-bc tag (R3, L3, L4, L7a, MT, MX, MG, MC, F1, O1, K1, DevLog refs, "L69" line locators) | spec test 65/65; re-scan |
| 9 twilight | NOTICE and colormaps.ts: contributed by GitHub user bastibe, matplotlib PR #6254 (closed 2018-05-28), matplotlib licence; no separate licence or author name stated in the PR, `_cm_listed.py` or the 3.0 release notes (accessed 2026-11-18) | N/A |
| 10 custom endpoint key | test: key stored under `amp.agent.provider-key.custom:https://llm.example.org`, another provider's stored key not read, every fetch at `https://llm.example.org/v1/chat/completions` with that key | agent `fx-web.test.ts` |

Gates (2026-11-18 14:56-14:57 PST): web check 0 errors; web test 129/129 (119 before); agent check clean, test 78/78 (75 before); spec test 65/65; materials test 34/34.

## 5. Open items

- O: `sims/chip-warpage-2d.yaml` locators / sources carry advanced-packaging-atlas row ids (`stack_layers.csv -a-L12`, `-a-L08`, `components.csv ...-a-c3`, `-a-c2`, `ectc51909.2023.00155-a-i3`); no plain-word replacement known yet.
- O: eval case WO-65 title says "EO-atlas K1" (eval/ not owned by this lane).
- O: `sims/si-rib-waveguide.yaml` assumption "(check the femwell source)" may be resolvable: eval/cases/b/WO-02.yaml states the rib height is measured from the substrate top (helper finding, not checked here).
- O: helper's Salzberg-Villa / Tatian and Malitson citations come from the eo-modulator-atlas materials data file, not from reading the papers.
- O: Graphics component reset and quick-view refusal are not covered by a browser test (no dev server in this lane); the pure helpers and the agent path are tested.
