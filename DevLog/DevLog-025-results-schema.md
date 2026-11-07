# DevLog-025: results schema, contracts and migration (lane R0)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | R0 (DevLog-023 s.4 R0) |
| Owns | `packages/spec/**`; the `results` blocks of `sims/*.yaml` and of eval-case embedded specs; `apps/web/src/lib/post/headline.ts`; minimal reader fixes in `packages/eval/src`, `packages/agent/src`, `apps/web/src` (listed in s.4); CONTRACTS-v0 changelog + C10; this file |
| Read | DevLog-023 (all), DevLog-026 (R1 plan, for vocabulary alignment), CONTRACTS-v0, `packages/spec/src/*`, `packages/core/src/expr.mjs`, `packages/physics/src/registrations.ts`, readers listed in s.4 |
| Spec | DevLog-023 s.3.1, s.3.2, s.3.5, s.3.6, s.4 R0, s.5.1 |
| Status | done (gates in s.6); open items in s.5 |

Conventions: "F" = fact read from code or a run; "D" = decision of this lane (reason given); "O" = open item for a later lane.

## 1. Plan (2026-11-06 22:38 PST)

### 1.1 Facts found before coding (F)
- 35 of 36 `sims/*.yaml` have a flow-style `results:` list (cylinder-cavity-qd has none); 66 legacy nodes: 26 plot2d, 2 plot3d, 11 probe, 1 scalar (kirsch-plate `kt`), 26 table. The 6 frozen fixtures add 12.
- No eval case embeds an `amp-spec/0` model: every `spec:` is `sims/<id>.yaml` or `{status: pending, ...}` (grep of `eval/cases/**`, 2026-11-06 22:35). The migration therefore touches `sims/` and the frozen fixtures `packages/spec/test/fixtures/*.yaml` (6 files, owned by `packages/spec`).
- `packages/eval` reads module scalars and fields from the Solution (C5, `extract`), never `spec.results`: no change needed there.
- Readers of spec `results` (grep `results` over `apps/web/src`, `apps/web/test`, `packages/*/src`, `packages/*/test`, `packages/*/eval`): `apps/web/src/lib/post/headline.ts`, `gfx/Graphics.svelte` (plot field, display unit, probe markers), `state/tree.ts`, `workbench/session.svelte.ts` (parametric single run rewrite), `play/Play.svelte` (degC flag), `ui/Headlines.svelte`, `play/HeroHead.svelte`, `post/accuracy.ts` (through `headlines`), `apps/web/test/diff.test.ts`; `packages/agent/src/loop.ts` (context digest), `session.ts` (`list_entities`); `packages/spec/src/{schema,validate,selection}.ts`, tests and `scripts/gates.ts`.
- `@amp/core/expr` names may be dotted (`solid.sxx`, `solid.u.x`); functions abs real imag conj sqrt exp log log10 sin cos tan atan2 min max if; there is no `d()` (R1 rewrites it before compiling, DevLog-026 s.1.2).
- Field units are not in the registry (`RESULT_NAMES` in `@amp/physics` lists names only), so the spec cannot dimension-check an expression that names a field.
- Eval class a baseline before any change: `logs/eval-20261106T223250.jsonl` (stdout `logs/R0-eval-a-baseline-20261106T223250.log`): cases 11 pass, 0 fail, 18 pending; targets 37 pass, 0 fail, 95 pending, 4 info. Same counts as the latest earlier class-a run `logs/eval-20261106T205440.jsonl`.

### 1.2 Shape (D)
```yaml
results:
  datasets:     # solution | cutpoint | cutline | edge | cutplane | revolve | mirror | join
  evaluations:  # groups {id, data?, steps?, items: [point | global | integral | average | max | min | measure]}
  tables:       # {id, from: <evaluation group>, orient?: rows | columns}
  plots:        # groups plot1d | plot2d | plot3d, each with its own item union
```
- Every node: `id` (one namespace with the rest of the spec), `type` (discriminator; tables have none), `label?`, `enabled?` (DevLog-023 s.3.4 "Disable").
- `data` of a plot group, evaluation group, item or non-solution dataset names a **dataset**; only a `solution` dataset names a **study**. Reason: one place maps studies to datasets, so kind compatibility is always checkable and the parametric single-run rewrite touches only solution datasets.
- `steps`: `all | first | last | <index> | [indices] | {values: [...], unit}` on solution datasets, groups and items (absent = all steps of the source).
- **Exports: dropped from the schema** (strict keys reject `results.exports`); the key name stays reserved for the later export stage. Reason: s.5.1 says no export of any kind; an accepted node that does nothing would be a silent no-op in the model, and adding the key later is additive (old specs stay valid) while removing an accepted key later would break specs.
- Deferred kinds (additive later, not accepted now): datasets surface / grid / parametric / sector, cut-line `parallel`; plot groups polar / smith; attributes filter / transparency; join ops other than `difference`.

### 1.3 Cross-reference checks (D)
- Unique ids; references resolve to the right section (dataset, study, evaluation group, table); dataset chains acyclic.
- Dataset shape `{type, dim, embed, axisym, entities, study}` propagated along the chain; compatibility rules in C10 (cutplane needs dim 3; revolve needs axisym; edge needs an entity dataset; plot2d needs dim 2; plot3d dim 3; linegraph a line dataset; pointgraph and point evaluations a cutpoint; integral / average / max / min / measure need `over` on an entity dataset and no `over` on a line or cut-plane dataset).
- Vector lengths: points / from / to = embed dimension; cutplane point and normal 3; mirror normals = embed; parity arrays = number of planes.
- Selections: entity-id grammar and feature existence (existing `checkSel`), and `selectionsOf` includes results selections so `checkSelections` resolves them against a built geometry.
- Expression vocabulary: syntax, functions (core list + `d(f, v)`), names = params, space symbols of the dataset (x y r / r z / x y z r; t only on a time study), `<physics id>.<name>[.<component>]` with the physics in the root study. Dimension check against `unit` when the expression names no field (e.g. the Kirsch closed form), or always when a `resultDims` resolver is injected (O: L4 / R1 publish field units).

### 1.4 Migration (D)
One-pass script `packages/spec/scripts/migrate-results.ts` (rerunnable: skips files already grouped). It replaces only the `results:` block text, verifies that the rest of the parsed spec is unchanged, that every comment line is kept, and that the spec validates against the full registry; dry run by default, `--write` to write, log to `logs/`.

| Legacy | New |
|---|---|
| each study used | dataset `sol_<study>` (`type: solution`) |
| `plot2d` / `plot3d` `X` | plot group `X` (same type, `steps` from `step`) with item `X_surf` (`surface`) |
| `probe` `X` | dataset `X_pt` (`cutpoint`, `points: [at]`) + item `X` (`point`) in group `ev_<study>` |
| `scalar` `X`: `max(f)<tail>` | item `X` (`max`, `over: select`, `expr: f<tail>`, `method: nodal`) in `ev_<study>`; only `/p` or `*p` tails with p > 0 (max(f)/p = max(f/p)) |
| `table` `X` | item `X` (`global`) in `ev_<study>` + table `tbl_<study>` from that group |
| bare field `T` | `<physics>.T` (the single physics of the study) |

### 1.5 Readers (D)
`@amp/spec` gains pure helpers (`resultNodes`, `headlineItems`, `surfaceItems`, `resultUnits`, `resultNodeHash`, `changedResultNodes`) so readers stay one-liners; behaviour stays identical (same headline ids, values, units, plot field choice).

## 2. TODO
- [x] `packages/spec/src/results.ts` schema + checks + helpers; `schema.ts` / `validate.ts` / `selection.ts` wiring; JSON Schema export
- [x] tests: schema per type, cross refs, vocabulary, `schema_at` per type, op round trip per type, JSON Schema
- [x] migration script; dry run; diff review; write; fixtures too
- [x] readers (s.4)
- [x] CONTRACTS changelog C3 + new C10
- [x] gates: sims validate; op round trip; schema_at; kirsch `kt` old vs new; `pnpm test`; `pnpm check` (apps/web); eval class a (s.6)
- [x] fresh-context audit; fixes (s.7)

## 3. Progress
- 2026-11-06 22:31 PST: started; read DevLog-023, CONTRACTS-v0, spec sources, readers.
- 2026-11-06 22:32 PST: eval class a baseline run (s.1.1).
- 2026-11-06 22:38 PST: plan written.
- 2026-11-06 22:46 PST: `results.ts` (schema factory, checks, vocabulary, helpers) and the `schema.ts` / `validate.ts` / `selection.ts` wiring; `pnpm check` (spec) clean.
- 2026-11-06 22:47 PST: migration dry run: 3 files failed validation because `provenance.values` had the key `results.T_E.at` (heat-plate-fin, nafems-t4, fixture heat-plate-fin). The script now also rewrites provenance keys and assumption / missing paths that point into a legacy node (`results.T_E.at` -> `results.datasets.T_E_pt.points.0`): outside the results block, but a direct consequence of it (otherwise the path does not resolve). Dry run diff reviewed by eye for kirsch-plate, si-rib-waveguide, lame-cylinder, box-acoustics, heat-plate-fin (log `logs/R0-migrate-results-20261106T224745.log`).
- 2026-11-06 22:48 PST: `--write`: 41 files migrated (35 sims + 6 fixtures), 1 skipped (cylinder-cavity-qd), 0 failed; 78 legacy nodes; 3 paths rewritten (`logs/R0-migrate-results-20261106T224759.log`). Rerun skips all 42 files (`logs/R0-migrate-results-20261106T224800.log`).
- 2026-11-06 22:52 PST: `test/results.test.ts` (12 tests, 45 samples covering every node type); spec tests 65 / 65 pass; JSON Schema size bound raised 41053 -> 65536 B (now 62947 B; shared `$defs` for refs, expression, step selection).
- 2026-11-06 22:54 PST: readers changed (s.4); agent tests 61 / 61, agent task suite 27 / 27 (`logs/L9-eval-20261106T225449.jsonl`); apps/web tests 10 / 10; `pnpm check` (apps/web) 0 errors (`logs/R0-web-check-20261106T225456.log`).
- 2026-11-06 22:55 PST: kirsch kt gate (legacy algorithm on the legacy node vs new headline.ts on the migrated node, same solve, 10810 DOF): both 3.021233775361685, bitwise equal (`logs/R0-kt-gate-20261106T225538.json`).
- 2026-11-06 22:56 PST: eval class a after migration: identical to the baseline (s.6); CONTRACTS C3 changelog + C10 written; root `pnpm test` all pass (`logs/R0-test-20261106T225657.log`).
- 2026-11-06 22:57 PST: fresh-context read-only audit started (subagent); report received 23:08.
- 2026-11-06 23:12 PST: after the fixes: root `pnpm test` all pass (`logs/R0-test-20261106T231131.log`); eval class a again identical to the baseline, 136 / 136 targets (`logs/eval-20261106T231232.jsonl`).
- 2026-11-06 23:11 PST: audit fixes applied (s.7); spec tests 65 / 65, apps/web check 0 errors (`logs/R0-web-check-20261106T231113.log`), kt gate repeated, still bitwise equal (`logs/R0-kt-gate-20261106T231123.json`); migration rerun skips all 42 files (`logs/R0-migrate-results-20261106T231124.log`).

## 4. Reader changes
All behaviour-identical (same headline ids, values, units, plot field and step choice); each reads the grouped block through an `@amp/spec` helper.

| File | Change |
|---|---|
| `apps/web/src/lib/post/headline.ts` (owned) | takes the results block (`unknown`); items from `headlineItems`; max / min with `method: nodal` evaluate the item expression at every node through `@amp/core/expr` (same nodal reduction as before; max(f)/p = max(f/p) for p > 0, bitwise in IEEE since division by a positive number is monotone); point items as the old probe (single point of the cutpoint dataset); other methods report "not evaluated" |
| `apps/web/src/lib/gfx/Graphics.svelte` | plot field / step from `surfaceItems`, display unit from `resultUnits` (plot items first, then evaluation items), probe markers when `headlineItems` has a point item |
| `apps/web/src/lib/state/tree.ts` | Results node: one child per dataset, evaluation group, table and plot group, items under their group; `childKeys` hide the sections in the form |
| `apps/web/src/lib/workbench/session.svelte.ts` | parametric single run: rewrites `data` of solution datasets of the parametric study (was: every legacy node); accuracy reads the block as `unknown` |
| `apps/web/src/lib/post/accuracy.ts` | `levelValues(..., results: unknown, ...)` (type only) |
| `apps/web/src/lib/play/Play.svelte` | degC flag from `resultUnits` |
| `apps/web/test/diff.test.ts` | the added plot is a plot group |
| `packages/agent/src/loop.ts` | context digest: `results` = `id:type` of every results node (`resultNodes`) |
| `packages/agent/src/session.ts` | `list_entities` results: `{id, section, type, pointer (@id form), data, expr}` |
| `packages/spec/test/{schema,oplog}.test.ts`, `test/random-ops.ts` | new shape in the edits and random ops |
| not changed | `ui/Headlines.svelte`, `play/HeroHead.svelte` (pass the block through `headlines`, whose first parameter is now `unknown`); `packages/eval` (reads Solution scalars and fields only); agent tool schemas (`schema_at` serves the new schema from `schemaAt`) |

## 5. Open items for R1 / R2 / R3
- R1 / L4: publish result names with dimensions (fields and module scalars per physics type) so `ValidateOptions.resultDims` can unit-check field expressions; today only expressions without field names are checked. The legacy table names `ac.freq`, `wave.freq`, `rf.f`, `rf.freq`, `hz.freq` are not in `RESULT_NAMES` (which lists `f_<k>`); they were migrated as written.
- R1: names in the spec are always `<physics id>.<name>[.<comp>]` (bare names rejected), `d(f, v)` with v a space coordinate, `r` allowed on planar models; max / min methods `nodal | quad | points | lattice` (R1 implements nodal, quad, points).
- R5: `semi-infinite-convection` `T_probes` was a legacy table of the field `ht.T` over time without points; migrated 1:1 as a `global` item, which is not meaningful for a field. It needs cut points at the HT-04 depths and a point graph (DevLog-023 R5 gate).
- R2: tree "+" menus can rely on the discriminated unions (`schema_at` per type) and the `x-amp-ref` / `x-amp-expression` JSON Schema annotations (pickers of compatible datasets). `changedResultNodes` gives the per-node recompute set. `enabled: false` is in the schema; readers skip disabled nodes in the helpers.
- R3: headlines move onto `@amp/post` evaluations (all item types, all methods); `get_results_summary` can list evaluation values keyed by `artifactKey`.
- Exports: the `exports` key is reserved and rejected; an export stage adds it as an additive change.
- R3: headlines use the session's current solution whatever the item's root study (`HeadlineItem.study` is available to tell them apart); multi-study specs (si-rib) have no headline items today.
- R5: the parametric single run re-points solution datasets of the sweep to the inner study, so their `steps` then index the inner study's steps.
- JSON Schema: 62947 B of the 65536 B test bound (4 % headroom); the next additions need shared `$defs` or a new bound.

## 6. Gates
| Gate | Result | Evidence |
|---|---|---|
| every sim and eval spec validates | 35 / 35 sims with results + cylinder-cavity-qd, all 36 validate against the full registry; 6 / 6 fixtures; 0 eval cases embed a spec (85 files scanned) | `test/sims-live.test.ts`, `test/schema.test.ts`, migration logs |
| op round trip per node type (add, edit, remove, revert, replay, undo all) | 45 samples: 8 dataset types, evaluation group, 7 evaluation items, table, 3 plot groups, 4 + 10 + 10 plot items; text byte-identical after revert and after undo-all; replay ok | `test/results.test.ts` |
| `schema_at` resolves each type | the `type` const of every sample (tables and evaluation groups by their own keys) | `test/results.test.ts` |
| kirsch `kt` old vs new | 3.021233775361685 both, bitwise equal (87 nodes on `bnd:hole.edge`) | `logs/R0-kt-gate-20261106T225538.json`, `logs/R0-kt-gate-20261106T231123.json` (script kept in session scratch: legacy branch of the pre-migration headline.ts on the pre-migration file) |
| root `pnpm test` | all packages pass (11 packages, 440 tests) | `logs/R0-test-20261106T225657.log`; after the audit fixes `logs/R0-test-20261106T231131.log` |
| `pnpm check` apps/web | 0 errors, 0 warnings | `logs/R0-web-check-20261106T225456.log`, `logs/R0-web-check-20261106T231113.log` |
| eval class a same pass / fail | cases 11 pass, 0 fail, 18 pending; targets 37 pass, 0 fail, 95 pending, 4 info; all 136 target statuses and values identical to the baseline | `logs/eval-20261106T223250.jsonl` (before) vs `logs/eval-20261106T225546.jsonl` and `logs/eval-20261106T231232.jsonl` (after) |

## 7. Audit (fresh context, read only, 2026-11-06 22:57-23:08 PST) and fixes
26 findings. Fixed:
1. Headline max / min ignored the item's dataset: `HeadlineItem` now carries `dataset`, `study`, `source`; headline.ts evaluates max / min only on a solution dataset with `over`, points only on cut points of a solution dataset, else "not evaluated".
2. `steps: last` resolved to step 0: `singleStep` returns `'last'`; headline.ts (`findLast`) and Graphics resolve it to the last stored step.
3. Edge datasets accepted surfaces: `select` must be `bnd` in 2D, `edg` in 3D (`entity_kind`).
4. A failed param hid other expression errors: only the unit check is skipped now.
5-8, 10, 14. C10 text corrected: integral / average / measure accept line, surface or volume datasets without entities; unit-check exceptions listed (integral, measure, arrow, streamline, deformation); evaluation groups have no `type`; edge accepts joins of solutions; linegraph any line dataset; join uses `a` / `b`; step indices always count the root study's stored steps and item > group > dataset precedence; physics ids with `-` cannot be named in expressions.
9. `resultUnits` skips disabled nodes; `headlineItems` / `surfaceItems` skip items whose dataset chain has a disabled dataset.
11, 26. DevLog shape fields and status corrected; progress and gates logged.
12. A wrongly dimensioned plot group is reported once, at the group.
13. Errors in d() expressions quote the source text.
15. Mirror parity components checked against the axisymmetric set.
16. Plot `maxmin` `method` is required.
17 (part). Point headlines accept `{value: [..], unit}` points.
19. Node hashes leave out labels; an item with its own `data` / `steps` does not hash the group defaults.
21, 22, 25. Dead ternary, unused `space` field, migration id reservation.
Not fixed (open, s.5): 17 (headline uses the session's current solution whatever the item's root study: R3), 18 (parametric single run re-points solution datasets to the inner study, so a sweep dataset's `steps` then index the inner study: R5), 20 (JSON Schema at 62947 of 65536 B), 23 (`Headlines.svelte`, `HeroHead.svelte` still type the block as `unknown[]`: harmless, files of another lane), 24 (fallback ids `#i` for malformed nodes in `resultNodes`).
