# DevLog-027: Results tree, 2D / 1D plot groups, quick view, canvas drawing (lane R2)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | R2 (DevLog-023 s.4 R2; one graphics pane with an optional split, no export of any kind, s.5.1) |
| Owns | `apps/web/src/lib/state/tree.ts`; `apps/web/src/lib/workbench/*` except `Bottom.svelte`; `apps/web/src/lib/gfx/*`; new `apps/web/src/lib/results/plot*`, `results/LinePlot.svelte`; this file |
| Parallel | R3 (DevLog-028): adapter, `results/api.ts`, post-worker `results` messages, Table tab, headlines, agent tools (`show_plot` calls R2's `showPlot` host hook) |
| Read | DevLog-023 s.3, s.4 R2, s.5.1; DevLog-025; DevLog-026; DevLog-028 (plan 23:22); CONTRACTS C1, C10; `packages/spec/src/{results,oplog,invalidation}.ts`; `packages/post/src/{expr,datasets,evaluations}.ts`, `gates/fixture-r1.ts`; `apps/web/src/lib/{workbench,gfx,state,schema,post,ui}/*`; `packages/agent/src/session.ts`; `../eo-modulator-atlas/app/src/lib/sim/{LinePlot.svelte,ticks.ts}` at 0546007 (read only) |
| Status | done (gates s.5); audit fixes s.6; open items s.7 |

Conventions: "F" = fact read from code or a run; "D" = decision of this lane (reason given); "O" = open item.

## 1. Plan (2026-11-06 23:26 PST)

### 1.1 Facts (F)
- `state/tree.ts` lists results nodes flat under Results (one per dataset, evaluation group, table, plot group; items under their group); there is no add / remove UI anywhere in the tree.
- Every edit already goes through `ModelState.apply` (op log `amp-oplog/1`); `dragStep` coalesces a gesture when every step replaces the same single path (oplog `coalesce`).
- An edit under `results` invalidates `plots` only (C7), but `Session.staleSolution` compares the solution's spec hash with the model's, so today any results edit badges the field "stale" and desaturates it. R2 must carry the solution's spec hash across results-only edits.
- `Session.finishDrag` re-meshes (or re-solves) after every drag; a cut-line drag must not.
- The Graphics toolbar state (field, component, step, range rule, log, colormap, contours, lattice level, raw) is component state; the 2D renderer draws surface, contour and region layers on a refined lattice, plus SVG overlays (boundary lines, highlight, markers, handles, flux lines). It has no warp (no height attribute) and no displacement of the display (deformation needs displaced lattice positions).
- `@amp/post` (R1) runs on the main thread and in workers: `cutLine` (uniform n or crossing pieces), `cutPoints`, `edgeDataset` (chains), `compileFieldExpr` (names `<physics>.<field>[.comp]`; a vector field needs a component), `evalMax` / `evalMin` (method stated), `evalGlobal`.
- R3 (DevLog-028 s.1.2) will publish `results/api.ts`: `ResultsClient` with `datasetValues(id, expr, step)`, `nodalValues(expr, step)`, `group(id)`, `table(id)`; `NavigationHost.showPlot?(id)` in `packages/agent`.
- EO `app/src/lib/sim/LinePlot.svelte` (293 LOC, Canvas 2D, ticks, log toggles, hover, second y axis, CSV / PNG buttons): no LICENSE file under `app/`; the repo's `engine/LICENSE` is GPL-3.0; same owner; APA already ported it as GPL-3.0-or-later (`advanced-packaging-atlas/app/src/lib/sim/LinePlot.svelte` header). DevLog-023 s.3.4 directs the port. Rights: port as GPL-3.0-or-later with the C1 header (O: coordinator confirms).

### 1.2 Design (D)
- **Ops** (`results/plot-ops.ts`, pure TS, Node-testable): templates for every type of the schema unions (`DATASET_TYPES`, `EVAL_ITEM_TYPES`, tables, `PLOT_GROUP_TYPES`, `PLOT_ITEM_TYPES`), filled per DevLog-023 s.3.1 rule 5 from the model only (first study, first solution dataset, bounding box of the mesh, first boundary / domain id, first field or vector field of the solution, units already used by the spec for that expression); a type whose inputs do not exist (e.g. a line graph without a line dataset, a cut plane in a 2D model) is listed disabled with the reason. Ids unique over the whole spec. Builders: add, delete, duplicate (new ids for the node and its items), enable / disable (`enabled: false` / key removed), move up / down; each returns one JSON Patch applied as one op. The agent's `apply_ops` with the same patch produces the same text (gate).
- **Tree** (`state/tree.ts`, `workbench/Tree.svelte`): Results > Datasets / Evaluations / Tables / Plots folders (always shown, also when `results` is absent); "+" on folders and on groups (items), right-click menu on nodes (Delete, Duplicate, Disable / Enable, Move up / down). Disabled nodes drawn dim.
- **Settings** (`workbench/Settings.svelte`): the generated form; `x-amp-ref` fields become pickers of compatible ids (DevLog-025 s.5 R2); `x` (arc or expression) and `steps` are text fields. Node actions on the results node header.
- **Freshness** (`workbench/session.svelte.ts`): an op that invalidates `plots` only keeps the solution (and mesh) fresh when it was fresh before the op (also for coalesced drags).
- **Plot data** (`results/plot-data.ts`, pure TS): series of 1D items (line graph on cut line / edge: x = arc or expression, pieces and chains as separate polylines so jumps of discontinuous expressions stay visible, NaN outside; point graph and global vs steps or sweep points; table graph through R3 when available) and 2D overlay data (max / min markers with method, point markers, boundary line colours, arrows, deformation of boundary lines), via `results/plot-api.ts`: a local stub with the intent of R3's `ResultsClient` (main thread, `@amp/post`) until `results/api.ts` exists; then switched (O).
- **1D view** (`results/LinePlot.svelte` port, `gfx/Plot1D.svelte`): dependency-free Canvas 2D, nice ticks, log x / y, hover crosshair, legend; CSV / PNG buttons removed (s.5.1). Absolute units in the axis labels.
- **2D groups** (`gfx/Graphics.svelte`): a `group` prop renders a plot2d group: surface (a field reference uses the exact FE basis; a general expression is interpolated at the mesh nodes, stated in the tooltip), contour (`levels.count` = nice levels, `levels.values`), line, max / min, point, arrow, mesh (wireframe), deformation (displaced lattice and boundary lines, scale auto = 10 % of the bounding-box diagonal); height and streamline are listed but not drawn (badge: the 2D renderer has no warp / no streamline tracer for general fields). No group = quick view (today's toolbar), with "Save as plot group" (one op: plot2d group with surface, plus contour when on).
- **Graphics pane** (`workbench/Workbench.svelte`): selecting a plot group or one of its items shows it; a plot1d group replaces the field view; "Split" shows the field (quick view or the last 2D group) above the 1D graph. "Quick view" returns to the toolbar view.
- **Drawing** (`gfx/Canvas2D.svelte`, Graphics): toolbar tools "Cut line" (press-drag-release) and "Cut point" (click) create a dataset (one op; cut line also a plot1d group with a line graph of the shown field, in the same op). Selected cut-line datasets show end handles; dragging an end is `dragStep` on `/results/datasets/<i>/from|to` (coalesced to 1 op), the plot recomputed from the previewed spec each step; release ends the gesture without a re-mesh.
- **Agent hook**: `showPlot(id)` on the workbench NavigationHost object (trail entry `show_plot`); R3 wires the tool.
- **Gate 7**: `results/plot-gate7.worker.ts` (module worker, same Vite bundling as the post worker) runs `gate7Fixture()`; `__ampWorkbench.gate7()` (dev / hooks builds only) returns the hash.

### 1.3 Gates (DevLog-023 s.4 R2)
1. Screenshots 1440 and 390: kirsch-exact, 1D group with FE `solid.sxx` and the Kirsch closed form along x = 0 (MPa, log toggle).
2. Helmholtz coil B_z on the axis as a line graph.
3. Same YAML diff for a node created by UI gesture and by `apply_ops` (browser and Node test).
4. Undo / redo of each node type.
5. Cut-line end drag: 1 op, preview < 1 s.
6. Gate 7: browser worker hash = `packages/post/gates/fixture-r1.expected.json`.
7. `pnpm check` 0 errors; root `pnpm test` all pass.
8. Existing behaviours: splitters, auto results, sweep selector, probe table, tree-driven view, op-log round trip.

## 2. TODO
- [x] plan
- [x] plot-ops.ts + Node test
- [x] tree folders, menus, context actions; Settings pickers
- [x] results-only edits keep the solution fresh
- [x] LinePlot port, Plot1D, plot-data; split pane (no stub: R3's ResultsClient landed first)
- [x] plot2d group rendering; quick view save
- [x] cut line / cut point drawing, end-handle drag
- [x] showPlot hook; gate 7 worker
- [x] gates 1-8 with evidence
- [x] fresh-context audit; fixes

## 3. Progress
- 2026-11-06 23:18 PST: started; read DevLog-023 / 025 / 026, CONTRACTS C1 / C10, spec results, post kernels, web workbench, gfx, state, agent session, EO LinePlot.
- 2026-11-06 23:24 PST: read DevLog-028 (R3 plan): api names adopted for the stub.
- 2026-11-06 23:26 PST: plan written.
- 2026-11-06 23:28 PST: `results/plot-ops.ts` + Node test (`results/plot-ops.test.ts`: 5 tests, every enabled entry of kirsch-exact / helmholtz-coil / box-acoustics valid with byte-exact undo / redo; UI patch = agent `apply_ops` text; drag = 1 op). Log `logs/R2-plot-ops-test-20261107T072819Z.log`.
- 2026-11-06 23:31 PST: R3 published `results/api.ts` (ResultsClient, worker wired): the planned local stub is not needed; plot data use `ResultsClient` directly.
- 2026-11-06 23:31-23:41 PST: tree folders and menus, Settings pickers and actions, session freshness aliases, LinePlot port, `results/plot-data.ts`, `gfx/Plot1D.svelte`, Graphics plot groups / quick view / draw tools / handles, Workbench split and `showPlot`, gate-7 worker. `pnpm check` 0 errors (`logs/R2-web-check-20261107T074102Z.log`).
- 2026-11-06 23:41 PST: dev server on port 47613 (`logs/R2-dev-20261107T074118Z.log`); browser runs with headless Chromium (swiftshader WebGL).
- 2026-11-06 23:42-23:49 PST: gates 1, 2 (screenshots), 3, 4 (browser), 5 (drag), 6 (gate 7) run; fixes from them: tree popup captured its node after closing (context actions threw), handles drawn under the peak marker (moved above), `x` of a line graph shown as JSON (string-only unions edited as text), coinciding overlay curves (second series dashed).

- 2026-11-06 23:53 PST: fresh-context read-only audit started (subagent; 22 findings); fixes applied (s.6) before the final runs.
- 2026-11-07 00:05 PST: Node test 6 / 6 (`logs/R2-plot-ops-test-20261107T080553Z.log`), `pnpm check` 0 errors (`logs/R2-web-check-20261107T080529Z.log`).
- 2026-11-07 00:11 PST: final browser gate runs (`logs/R2-gates-browser-20261107T081151Z.json`, screenshots `logs/R2-shot-*-20261107T081151Z.png`).
- 2026-11-07 00:14 PST: root `pnpm test` started (s.5 gate 7).

## 4. Needs from other lanes (recorded, not edited)
- R3: `NavigationHost.showPlot?(id)` in `packages/agent` and the `show_plot` tool: the workbench host implements `showPlot(id)` (selects the group, shows it, records `show_plot` in the navigation trail; plot3d answers ok with a "drawn from R4" message). R3's `results/api.ts` is used directly (no stub was needed).
- Coordinator: move `apps/web/src/lib/results/plot-ops.test.ts` to `apps/web/test/` (R2 does not own `test/`), so the root `pnpm test` runs it; it imports `@amp/agent` and `@amp/physics` (both already dependencies of apps/web).
- Coordinator: confirm the LinePlot rights reading (s.1.1: EO `app/` has no own LICENSE; repo `engine/LICENSE` GPL-3.0; APA ported the same file as GPL-3.0-or-later). The port header names EO commit 0546007 (the sibling's HEAD read on 2026-11-06 by `git log -1` in that repo, read only).

## 5. Gates (final runs 2026-11-07 00:05-00:14 PST)
| Gate | Result | Evidence |
|---|---|---|
| 1 kirsch-exact 1D group, FE `solid.sxx` and Kirsch closed form along x = 0 | built by UI gestures only (draw tool, Settings vector fields, "+" Line Graph, text fields): 13 user ops, spec valid, solution stays fresh; MPa on y, y (mm) on x, log y on; hover at y = 11.81 mm: FE 113.514 MPa, closed form 113.783 MPa (1010 tri6) | `R2-shot-kirsch-exact-pg1d-1440-*.png`, `R2-shot-kirsch-exact-pg1d-390-*.png` (390 from the share URL of the same spec, shown through `showPlot`) |
| 2 Helmholtz coil B_z on the axis | "+" Cut Line, ends (0, -0.3) m to (0, 0.3) m, "+" 1D Plot Group, "+" Line Graph `mf.Bz` uT vs z (cm); plateau 8.95 uT near z = 0 (the EM-04 closed form is 8.99176 uT; finite coil section, DevLog-001 s.8) | `R2-shot-helmholtz-coil-Bz-axis-1440-*.png` |
| 3 same YAML diff UI vs `apply_ops` | browser: 4 node kinds (1D group, cut line, evaluation group, 2D group) by "+" click, undo, then the same patch as an agent op: text identical (4 / 4). Node: the same through `AgentSession.execute('apply_ops')`, plus a drawn cut line with its 1D group | gates JSON `ops.g3`; `plot-ops.test.ts` test 3 |
| 4 undo / redo of each node type | browser: all 40 enabled "+" entries of kirsch-exact (9 dataset / group / table entries, 7 evaluation items, 4 plot1d items, 10 + 10 plot2d items, ...) valid, Undo and Redo buttons byte-exact; context actions (duplicate, disable, move, delete with dependents) on a dataset, evaluation group, table, plot group and item: valid, undo / redo byte-exact. Node: 138 entries over kirsch-exact, helmholtz-coil (axisym: revolve, plot3d) and box-acoustics (3D: cut plane, plot3d items) | gates JSON `ops.g4`, `ops.acts`; `R2-plot-ops-test-*.log` |
| 5 cut-line end drag | 20 pointer moves on the start handle: 1 op (coalesced 21 steps, single-path replace, invalidates plots only), no re-mesh, solution fresh; move to re-plotted 1D graph (next animation frame): median 111 ms, max 179 ms (headless swiftshader, other lanes running) | gates JSON `drag`; `R2-shot-kirsch-exact-drag-1440-*.png` |
| 6 gate 7 browser hash | `gate7Fixture()` in a module worker (`results/plot-gate7.worker.ts`, Vite-bundled like the post worker), HeadlessChrome 151: SHA-256 `b913438e...cd822`, 1899 values, equal to `fixture-r1.expected.json` | gates JSON `gate7` |
| 7 `pnpm check`, root `pnpm test` | check 0 errors; root test: see s.8 | `R2-web-check-20261107T080529Z.log`, `R2-test-*.log` |
| 8 existing behaviours | Compute switches to Results; tree splitter drag 220 -> 279 px; click in Results adds a probe row (sxx 102.61 MPa) and opens the Table tab; tree view: feature -> geometry, refine -> mesh, study -> results, plot group -> results with the group; 20 form edits + 20 undos restore the text; si-rib-waveguide sweep: 7 points, dataset selector present | gates JSON `regress`, `sweep`; `R2-shot-regress-1440-*.png`, `R2-shot-sweep-1440-*.png` |

Also checked by eye: 2D groups (`R2-shot-kirsch-exact-pgA-*.png`: expression surface `solid.sxx/s_inf` [1] with contours, max / min markers with method, a point marker, line colours on `bnd:hole.edge`, arrows, deformation x239 auto; `pgB`: field-reference surface `solid.u.x` in um with a manual range -2 to 12 um, inferno, mesh item; `saved`: the quick view saved as a group).

## 6. Audit (fresh context, read only, 2026-11-06 23:53 PST; 22 findings) and fixes
Fixed:
1. (high) Expression surfaces could draw values of an older request (another mesh, expression or step): the nodal values are keyed by run, mesh hash, expression, unit, step, dataset and resolved params; old values are dropped when the key changes; a token keeps the latest request.
2. Delete left dangling references (model invalid): Delete removes the node and every results node that reads it, transitively, in one op; the menu shows "Delete (+N)" with the ids in the tooltip.
3. The selected cut line was an index pointer: stored by id and resolved to its current index (moves, undo, agent edits).
4. Overlays used the last step while the surface showed another: one resolved step for the surface, max / min, points, lines and arrows; the deformation uses the displacement of the shown step.
5. Manual range and contour values on expression surfaces were converted as SI: converted to the unit of the drawn values.
6. A group's dataset was ignored: only solution datasets are drawn; other dataset types (cut plane, mirror, join, revolve) and a plot2d group on a 3D mesh are listed as not drawn.
7. Overlay effect: latest-wins token and error capture.
8. Results-only param edits did not re-key cached values: the resolved params are part of the key.
9. Manual colour range stated in the colorbar tooltip ('manual'); a dimensionless expression shows unit 1, 'norm.' only for normalized fields.
10. Eigen solutions: max / min and point markers show no number (arbitrary amplitude).
13. 1D view: coarse-preview badge; "results out of date" when the mesh changed.
14. Disabled groups are not drawn (badge / message).
16. Add and tree actions report errors in Messages instead of unhandled rejections.
17. Quick-view save: new solution dataset id prefix `sol`.
Not fixed (s.7): 11 partly (listed as not drawn, no 2D view of a cut plane), 12 (done with 4), 15, 18, 20, 21, 22. Finding 19 (DevLog claims): this section, s.5 and s.7 correct them: steps are edited in the JSON snippet field (only all-string unions such as `x` are plain text); point / global graphs use the displayed run only (no sweep axis yet); the cut-line end moves with a plain drag of its handle (no Shift).

## 7. Open items
- Sweeps: point graph, global and table graph plot the displayed run only; x over sweep points needs R5 (`Session.sweep` points hold scalars, solutions only for the held ones). Audit 18: a results-only param edit after a sweep keeps the sweep's snapshot params.
- Not drawn in R2 (listed in the view): height (2D renderer has no warp), streamline for general vector fields, contours of a second expression, a second surface, datasets other than solutions (R4 / R5), plot3d groups (R4).
- Arrows sit at mesh nodes binned on a 24 x 24 grid (not a regular sampling grid); markers, probes and guides stay at undeformed positions in a deformed view (stated in the tooltip).
- Templates and the quick-view expression use the first physics of the first study (audit 21; all sims have one physics today).
- Each handle move is one op step through the serial op-log queue (audit 22); a fast drag can queue steps; measured preview stays < 0.2 s.
- Keyed lists use ids: duplicate ids typed in the YAML tab raise a Svelte each-key error in dev builds (audit 15).
- Dashed legend swatch uses the text colour for its second segment (audit 20, cosmetic).
