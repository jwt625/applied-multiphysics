# DevLog-028: evaluations, tables, adapter, agent tools (lane R3)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | R3 (DevLog-023 s.4 R3; no export of any kind, s.5.1) |
| Owns | `apps/web/src/lib/results/{api,adapter}.ts`, `results/eval*`; `apps/web/src/lib/post/{post.worker,headline}.ts`; `workbench/Bottom.svelte`; `state/probes.svelte.ts`; `ui/Headlines.svelte`; `play/HeroHead.svelte`; `packages/agent/**`; `packages/eval/**`; CONTRACTS changelog C6 / C8; this file |
| Parallel | R2 (DevLog-027): Results tree, plot groups, LinePlot, canvas; consumes `results/api.ts` |
| Read | DevLog-023 s.3, s.3.6, s.4 R3, s.5.1; DevLog-025 (open items); DevLog-026 (API s.4, open items s.6); CONTRACTS C5, C6, C8, C10; `packages/spec/src/results.ts`; `packages/post/src/*`; web post worker, headline, probes, Bottom, Headlines, HeroHead, session; `packages/agent/src/*`, `eval/*`; `packages/eval/src/{registry,loader,engine-worker,workspace}.ts` |
| Status | done (gates s.5); fresh-context audit and fixes s.7; open items s.6 |

Conventions: "F" = fact read from code or a run; "D" = decision of this lane (reason given); "O" = open item.

## 1. Plan (2026-11-06 23:22 PST)

### 1.1 Facts (F)
- `@amp/post` kernels take plain arguments (DevLog-026 s.4). Nothing maps spec nodes to them yet; `post/headline.ts` evaluates `max`/`min` nodal with its own loop and `point` through the worker `evalAt` (2D only).
- The agent session sees only `SolutionSummary` (no fields): `evaluate` / `get_table` need a host that holds solutions.
- `packages/eval` depends only on `@amp/spec` and loads the engine packages by path (`workspace.ts`); `packages/agent` has `@amp/physics` as a dev dependency only. Neither can import `apps/web` as a package.
- The browser session solves the first study (a parametric study in front: its inner study, or a sweep of it). Sweep points carry their own solution, mesh and params (`Session.sweep.points[i]`).
- Evaluation items in sims (grep 2026-11-06 23:20): 1 `max` (kirsch `kt`), 13 `point`, 21 `global`; several legacy global names (`ac.freq`, `rf.f`, ...) are not module scalars (DevLog-025 s.5) and must report an error, not a value.

### 1.2 Design (D)
- **Adapter** (`results/adapter.ts`, pure TS; imports only `@amp/spec`, `@amp/post` and types): resolves a results node against the spec (dataset chain to its root study, steps item > group > dataset, quantities to SI with the run's params scope, physics id prefix) and calls the `@amp/post` kernels. It never throws for a node: every cell carries a value or an error string. Reason: one evaluator for browser worker, agent task suite and eval harness; plain module so Node can load it by path (packages cannot depend on apps/web; O: move into a package in contracts v2).
- **Run** = `{solution, mesh, params, studies, runId, label}`: `studies` lists the study ids the run answers for (the first study; a parametric study and its inner study for single runs and sweep points). An item whose root study is not in `studies` is "not evaluated: study X not solved" (honours `HeadlineItem.study`).
- **Datasets** supported: solution (steps), cutpoint, cutline (uniform n or crossing), edge (2D). cutplane / revolve / mirror / join: "not evaluated (R4 / R5)". Snap 1e-6 (reference-coordinate tolerance) for cut points and cut lines, so points on curved walls locate.
- **Items**: point (cutpoint; one column per point), global (`evalGlobal`), integral / average / measure (solution with `over` -> domain or boundary region by entity kind; line / edge datasets), max / min (with `method`, plus cutpoint). Values in the item `unit` (dimension checked; mismatch is an error), else in the SI unit of the result.
- **Tables**: one row per step of the evaluation group (steps of the root solution) per run; columns `#`, dataset (sweep label or run), step value (with unit) when the solution has steps, then one column per item (name `id (unit)`); cell meta: method, n, outside, NaN, coverage, at. `orient: columns` transposes in the view only.
- **Cache**: `results/eval-cache.ts`, values keyed by `artifactKey(resultNodeHash(spec, id), runId)`. An edit changes only the hashes of changed nodes and their dependents (`changedResultNodes`), so only those miss and recompute. Bounded (entries LRU).
- **Worker** (`post.worker.ts`): new messages `results:run` (hold a run: solution + mesh + params, LRU of 4 runs), `results:eval` (evaluation group / table / item / dataset values / ad hoc), `results:drop`. Existing messages unchanged.
- **API** (`results/api.ts`): `ResultsClient` over `PostClient` for R2 and the Table tab: `table(id)`, `group(id)`, `datasetValues(id, expr, step)`, `nodalValues(expr, step)` (an expression at the mesh nodes, for colour plots), `evaluateAdhoc(...)`, `runOf(session)`. Types for tables, columns, dataset values.
- **Headlines**: `post/headline.ts` evaluates `headlineItems` through the adapter (worker), every method `@amp/post` supports; `Headlines.svelte` / `HeroHead.svelte` pass the run. Gate: kirsch `kt` = 3.021233775361685 at 10810 DOF from both.
- **Table tab** (`Bottom.svelte`): sub-tabs Probes | one per evaluation group (or table); probe "pin" = one user op adding a `cutpoint` dataset and a `point` item (group `ev_pins`, created when absent). Session memory only; Copy TSV stays for probe rows only (no table export, s.5.1).
- **Agent** (`packages/agent`): `ResultsHost` interface (`evaluate`, `getTable`) in the session options; `NavigationHost.showPlot?(id)` (R2 implements in the workbench); tools `evaluate`, `get_table` (read), `show_plot` (navigation, trail). `export` is not added (s.5.1). Task-suite host in Node: the FE runner keeps the last solution + mesh per study and the adapter evaluates it. Suite cases: Kirsch cut line along x = 0 (sigma_xx at r = a), coax V(r) and the line integral of E (DevLog-023 s.3.6).
- **Harness** (`packages/eval`): `extract: {kind: result, node: <item id>, step?, point?}` evaluates a results node of the case spec through the adapter (loaded by path) on each level; C8 changelog entry; schema enum extended (additive). Class a unchanged.

### 1.3 Gates
1. Kirsch `kt` from the evaluation group (table) equals the headline and 3.021233775361685 (10810 DOF).
2. Adapter values equal the R1 Node values on the same meshes: Kirsch cut-line integral (gate-3 values of `logs/r1-post-gates-20261107T070753Z.json`), coax V(r) on the radial cut line (R1 kernel call, bitwise).
3. Agent suite in full with the mock, new cases included.
4. Eval class a statuses identical to `logs/eval-20261106T231232.jsonl`.
5. `pnpm check` 0 errors (apps/web), root `pnpm test` all pass.
6. Browser screenshots of the Table tab with an evaluation group and a pinned probe.

## 2. TODO
- [x] plan (this section); `results/api.ts` published for R2
- [x] `results/adapter.ts`, `results/eval-cache.ts`, worker messages
- [x] headline.ts on the adapter; Headlines / HeroHead
- [x] Bottom Table tab: evaluation tables; probe pin
- [x] agent: ResultsHost, evaluate / get_table / show_plot, task-suite cases
- [x] eval: extract kind `result`; C8 changelog; schema enum
- [x] gates 1-6 with logs (s.5)
- [x] fresh-context audit; fixes (s.7)

## 3. Progress
- 2026-11-06 23:18 PST: started; read DevLog-023 / 025 / 026, CONTRACTS, spec results, post kernels, web post / headline / probes / Bottom, agent, eval.
- 2026-11-06 23:22 PST: plan written.
- 2026-11-06 23:24 PST: `results/api.ts` published (types, worker message set, `ResultsClient`, `runOf`); R2 can build on it.
- 2026-11-06 23:28 PST: `results/adapter.ts`; first kirsch run: `kt` through `evalMax` boundary nodal = 3.021233775361687, 2 ulp above the R0 value 3.021233775361685, because the kernel locates facet nodes by a Newton inverse map (reference coordinates off in the last bits). The adapter now evaluates boundary nodal max / min at the facet nodes' exact reference coordinates (NODE_REF, the same as the kernel's domain nodal path) and reduces with the kernel (`evalMax` on a cut-points region): `kt` = 3.021233775361685 bitwise, 87 nodes (O1 for R1 / `@amp/post`).
- 2026-11-06 23:31 PST: `results/eval-cache.ts`, `results/eval-worker.ts`, worker `results:*` messages, `post/headline.ts` on the tables, Headlines / HeroHead pass the spec and the displayed dataset; `pnpm check` 0 errors.
- 2026-11-06 23:33 PST: Table tab sub-tabs (Probes + one per table / evaluation group), pin (`results/eval-pin.ts`); `pnpm check` 0 errors.
- 2026-11-06 23:41 PST: agent: `ResultsHost` (`src/results.ts`), tools `evaluate`, `get_table`, `show_plot` (`NavigationHost.showPlot?`), prompt line; Node host `eval/results-host.ts` (FE runner keeps the last solve per study); tasks T28 (Kirsch cut line x = 0) and T29 (coax V(r) plot + E line integral) pass, null transcripts rejected. Loop fix: `results_stale` only when an edit after the run invalidates more than `plots` (a results-node edit kept forcing a rerun repair; C7 says results edits invalidate plots only). Web host `results/eval-host.ts`, wired in `agent/mount.ts` (one line; file outside both lanes, recorded here).
- 2026-11-06 23:43 PST: eval harness: extract kind `result` (loader, registry, engine worker; schema enum additive); test with the real engine in a throw-away root (kirsch kt = 3.021233775361685, unknown node = error).
- 2026-11-06 23:45 PST: R1 equality gate (`apps/web/test/results-eval.test.ts`, first-pass log superseded by `logs/R3-gates-20261107T000849.log`); CONTRACTS changelog C6 / C8 / agent tools.
- 2026-11-06 23:45 PST: eval class a: `logs/eval-20261106T234543.jsonl`: 136 / 136 target statuses and values identical to `logs/eval-20261106T231232.jsonl`.
- 2026-11-06 23:46 PST: agent suite 29 / 29 (`logs/L9-eval-20261106T234639.jsonl`; first-pass stdout removed); null transcripts accepted only by T07 / T08 (injection: doing nothing is correct), as before.
- 2026-11-06 23:47 PST: root `pnpm test` all pass (first-pass log superseded by `logs/R3-test-20261107T000544.log`).
- 2026-11-06 23:48-23:51 PST: dev server on port 47843 (`logs/R3-dev-20261106T234844.log`); browser checks (Chrome headless, playwright-core): kirsch Table tab ev_std1 `kt` 3.021234 and headline 3.021 (same table); probe pin -> `pin1_pt` cutpoint + `pin1` point item in `ev_pins` by one user op (invalidates plots only), pinned value 1.050173 MPa = probe row 1.0501731414 MPa; heat-plate-fin `T_E` 18.25414 degC (SI 291.4041441 K); box-acoustics `freqs`: honest error (legacy name `ac.freq` is not a module scalar); si-rib-waveguide sweep point: first run showed "study 'sweep_t' is not solved" -> `runStudies` now also lists parametric studies that sweep the solved study; rerun shows neff 3.414084 for `t_slab = 0.7 um`. Screenshots kept in session scratch (`<scratch>/shots/R3-table-*.png`).

## 4. API (`apps/web/src/lib/results/api.ts`, for R2 and the hosts)

```ts
type ParamMap = ReadonlyMap<string, { si: number; dim: readonly number[] }>;
interface ResultsRun { key /* runId */; solution; mesh; params: ParamMap; studies: string[]; label: string }
class ResultsClient {                       // resultsClient(session.post): one per post worker
  hold(run): Promise<RunRef>                // worker holds up to 4 runs (LRU)
  table(spec, id /* evaluation group or table */, runs): Promise<ResultTable>
  datasetValues(spec, id /* cutpoint | cutline | edge */, expr | null, run, { step?, unit? }): Promise<DatasetValues>
  nodalValues(spec, expr, run, { step?, unit?, dataset? }): Promise<NodalValues>   // H1P1 / H1P2 nodal field for colour plots
  evaluate(spec, AdhocRequest /* {data, kind, expr, unit, over, method, from, to, n, points, steps} */, runs): Promise<ResultTable>
}
runOf(session): Promise<ResultsRun | null>   // displayed dataset (single run or sweep point)
runStudies(spec): string[]; runKey(solution): Promise<string>
ResultTable { id, group, label, orient, columns: TableColumn[], rows: TableRow[], errors, hash, runs, ms, cached }
TableColumn { key, name, unit, kind: index | dataset | step | item, item?, type?, expr?, point?, tip }
TableRow { cells: (number | string | null)[], meta: (CellMeta | null)[], errors: (string | null)[], run, step }
CellMeta { si, siUnit, method?, n?, nOutside?, nNaN?, coverage?, at?, continuous?, measure? }
DatasetValues { id, type, dim, points, s?, chains?, pieces?, length?, covered?, values, unit, siUnit, continuous, outside, step, stepValue, stepUnit, error? }
NodalValues { values, space, unit, siUnit, continuous, step, meshHash, error? }
```
Adapter (`results/adapter.ts`, pure, Node-loadable): `evalTable`, `evalDataset`, `evalNodal`, `evalItemAt`, `evalItemValue`, `adhocSpec`, `indexSpec`, `chainOf`, `boundaryNodes`, `stepIndices`. Agent: `ResultsHost {table, dataset, adhoc}` (`packages/agent/src/results.ts`), `NavigationHost.showPlot?(id)` (R2 implements in the workbench nav host).

## 5. Gates

| Gate | Result | Evidence |
|---|---|---|
| 1. Kirsch `kt`: evaluation group = headline = 3.021233775361685 (10810 DOF) | Node: table cell, `evalItemValue` and the harness `result` extract all 3.021233775361685 bitwise (87 nodes, method nodal); browser: the headline reads the same table (3.021 shown at 4 significant digits, table 3.021234 at 7) | `apps/web/test/results-eval.test.ts` (log `logs/R3-gates-20261107T000849.log`), `packages/eval/test/result-extract.test.ts`, `<scratch>/shots/R3-table-ev-kirsch-20261107T000909.png` |
| 2. Adapter = R1 Node values on the same meshes | Kirsch cut-line integral of sigma_xx through a spec `integral` item: 4974664.346323662, 4974671.730855403, 4974721.720638285, 4974741.991725743 N/m on the 4 levels, bitwise equal to R1 gate 3 (mesh hashes equal R1's); coax V(r) on the phi = 0.3 radial line (1001 points, mesh hashes equal R1's): 1001 / 1001 values bitwise equal to a kernel call with R1's arguments on each of the 3 levels, and the max error against ln(b/r)/ln(b/a) on these points (5.6847e-4, 9.3058e-5, 1.2166e-5 V) is within the logged R1 gate-5a level errors (asserted); agent T28 / T29: the host's integral cell = the direct kernel value (asserted), which equals the R1 gate-3 level-1 value and the gate-5c level-1 value (1 V) bitwise | `logs/R3-gates-20261107T000849.log`, `logs/L9-eval-20261107T000743.jsonl` |
| 3. Agent suite in full | 29 / 29 with the mock (27 old + T28, T29); null transcripts accepted only by T07 / T08 (as before) | `logs/L9-eval-20261107T000743.jsonl` (stdout `logs/R3-agent-suite-20261107T000742.log`) |
| 4. Class a unchanged | 136 / 136 statuses and values identical (cases 11 pass, 18 pending; targets 37 pass, 95 pending, 4 info) | `logs/eval-20261107T000746.jsonl` (also `logs/eval-20261106T234543.jsonl`) vs `logs/eval-20261106T231232.jsonl` |
| 5. `pnpm check`, root `pnpm test` (after the audit fixes) | 0 errors; all 11 packages pass (apps/web 15, agent 63, eval 80) | `logs/R3-web-check-20261107T000535.log`, `logs/R3-test-20261107T000544.log` |
| 6. Screenshots (after the fixes, looked at) | kirsch: Table tab ev_std1 (kt 3.021234, headline 3.021), probe rows with pin buttons, pinned probe in ev_pins (1.050173 MPa = probe 1.0501731414 MPa); heat-plate-fin T_E 18.25414 degC; si-rib sweep point neff 3.414084 | `<scratch>/shots/R3-table-*-20261107T000909.png` |

## 6. Open items and needs (O)
- O1 (`@amp/post`, R1): `evalMax` / `evalMin` with method `nodal` on a boundary locate the facet nodes by Newton inverse map, so node values can differ in the last bits (kirsch `kt` 3.021233775361687 vs 3.021233775361685). The adapter builds the facet-node point set at exact reference coordinates (`boundaryNodes`) and reduces with the kernel; the same in `@amp/post` would remove the special case.
- O2 (contracts v2): the adapter lives in apps/web; the agent task-suite host and the eval engine worker load it by relative path / file URL (packages cannot depend on apps/web). Move it (and the api types) into `@amp/post` or a new `@amp/results`.
- O3 (closed by R2): the session keeps the solution fresh after results-only edits (`session.svelte.ts`), as the agent loop and the Node host now do (C7: results edits invalidate plots only).
- O4 (R4): pinning a probe clicked in a mirrored view half pins the clicked point, which is outside the mesh (N/A in the table, never a folded value: the parity of odd fields would be silent). Needs the mirror dataset.
- O5 (R2): `post/headline.ts` accepts `o.spec`; `gfx/Graphics.svelte` (probe markers) and `post/accuracy.ts` still call `headlines(results, ...)` without it (behaviour as before R3: root study not checked there).
- O6 (R0 semantics): every enabled `point` item is a headline, so pinned probes appear in the headline overlays (as "pin1 1.05 MPa"). A headline flag on items would let the user choose.
- O7 (R5): evaluation tables cover the displayed dataset only (a sweep shows the selected point with its label); tables over all sweep points wait for R5. Items with their own `steps` are evaluated on the rows in them only.
- O8: legacy global names (`ac.freq`, `rf.f`, `rf.freq`, `hz.freq`, `wave.freq`; DevLog-025 s.5) report "unknown variable" in tables (honest, but the spec should name module scalars).
- O10 (core / R1): results without a display unit show the SI unit name of the inferred dimension, e.g. `J/m^3` for a stress expression (`@amp/core/units` formatUnit); a bare field could use the field's own unit (`Pa`).
- O11 (R2): params of a run are snapshotted per solution object on first use (`paramsOf` in api.ts) so a param edit without a re-solve does not mix new params with the old field; a session-side snapshot taken at solve time would be exact.
- O9: the dev page requests `/_app/immutable/*` chunks that 404 under `vite dev` (11 console errors, from the preload shell, not from results code).
- 2026-11-06 23:52 PST: fresh-context audit started (read-only subagent); report received 2026-11-07 00:03 PST.
- 2026-11-07 00:05 PST: audit fixes applied (s.7); `pnpm check` 0 errors (`logs/R3-web-check-20261107T000535.log`); root `pnpm test` all pass (`logs/R3-test-20261107T000544.log`); agent suite 29 / 29 (`logs/L9-eval-20261107T000743.jsonl`); class a identical (`logs/eval-20261107T000746.jsonl`); gate log `logs/R3-gates-20261107T000849.log`; browser re-check `<scratch>/shots/R3-table-*-20261107T000909.png`. Superseded R3 stdout logs of the first pass removed (the jsonl records kept).
- 2026-11-07 00:09 PST: dev server on port 47843 stopped (verified no listener).

## 7. Audit (fresh context, read only, 2026-11-06 23:52 - 2026-11-07 00:03 PST) and fixes
13 findings.
| # | Finding | Fix |
|---|---|---|
| 1 high | a dataset whose chain passes through a join / mirror (or revolve / cutplane) was built on the root mesh: silent wrong values (join cutpoint = value of `a`; mirror cut line covered half) | `chainOf` refuses any non-solution parent between a dataset and its solution: "not evaluated yet (stage R4 / R5)"; test |
| 2 medium | steps: rows came from the group / first chain; an item's own steps only filtered, an item's own dataset steps were ignored; headline / table / harness could disagree | `itemSteps` (item > group > the item's dataset's solution); rows = union of the items' selections; cells outside an item's selection carry `NOT_SELECTED`; headline takes the last row in the item's selection; `evalItemValue` uses `itemSteps`; test on wr90 eigen (item steps 0 under dataset steps last) |
| 3 medium | headline dropped the SI unit of items without a unit | headline unit = the table column unit |
| 4 medium | browser runs used the current params, not the solve-time params, after a param edit without a re-solve | `paramsOf` snapshot per solution object (runOf, headline); O11 for a session-side snapshot |
| 5 low-medium | eigen pins: raw eigenvector amplitude in an SI unit | every field-reading column of an eigen solution states "solver normalization (arbitrary scale)" in its tip |
| 6 low-medium | a shared client could evict a run another caller is using ("not held") | `withRuns`: re-hold and retry once on "not held" |
| 7 low | cached tables kept old labels (labels are not in the node hash) | labels of the table / group / items are part of the cache key |
| 8 low | headline effects could apply out of order | request token in Headlines.svelte and HeroHead.svelte |
| 9 low | gate evidence: coax compared only to a fresh kernel call; agent checkers checked the tool integral via the answer text; check / test logs predated the last edit | coax test asserts the error against the logged R1 gate-5a errors; T28 / T29 assert the host cell = the direct kernel value; check, test, suite, class a rerun after the fixes |
| 10 low | `J/m^3` name for stress | O10 (core / R1) |
| 11 low | dev server still running at audit time | stopped 00:09 |
| 12 low | `evaluate {node: item / group}` ignored expr / unit; a step not in the table gave 0 rows | `not_for_evaluation_nodes`, `step_not_in_table` errors |
| 13 low | O3 out of date | O3 closed |
Verified by the auditor: gate 1 and gate 2 (Kirsch) values, the L9 log, class a 136 / 136, unit conversions (affine), cache keys, buffer copies before transfer, read-only agent tools with untrusted blocks, `show_plot` in the trail, harness change additive, no export, no absolute paths or emoji in R3 files.
