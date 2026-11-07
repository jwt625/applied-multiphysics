# DevLog-020: workbench UX (lane W2): resizable panels, auto results, sweep datasets, probe table, tree-driven view

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | W2 (workbench UX) |
| Owns | `apps/web/src/lib/workbench/*`, `apps/web/src/lib/gfx/Graphics.svelte` (shared with W1, who added the Raw toggle in the same file during this lane; edits were small targeted replacements), `gfx/Canvas2D.svelte`, `gfx/Canvas3D.svelte`, `apps/web/src/lib/state/*`, `apps/web/src/lib/agent/AgentPanel.svelte`, new `apps/web/src/lib/post/probe.ts`, this file |
| Does not touch | W1: `gfx/renderer2d.ts`, `gfx/field-material.ts`, `gfx/viewer3d.ts`, `post/field2d.ts`, `post/post.worker.ts`, `post/solid3d.ts`, `post/revolve.ts`. W3/W4: `sims/`, `lib/library/**`. `packages/*`. `ui/*` (unowned: `ui/Splitter.svelte`, `ui/Headlines.svelte` stay as they are) |
| Inputs | User feedback on the live app (2026-11-06, via coordinator); sibling parity (read only): `eo-modulator-atlas/app/src/lib/sim/{Splitter,SimPage,Graphics}.svelte` |
| Verification | dev server on an uncommon free port, playwright-core + chrome-headless-shell (swiftshader); no `pnpm build` (shared `apps/web/build`) |

## 1. Plan (written 2026-11-06 20:53 PST, before coding)

### 1.1 Resizable panels
- New `workbench/PaneSplitter.svelte` (the unowned `ui/Splitter.svelte` stays for any other user): WAI-ARIA window splitter (`role=separator`, `aria-valuenow/min/max`, `aria-controls`), pointer drag with capture, arrows 16 px (Shift 64 px), Home/End = min/max, Enter or double-click = reset to default.
- Sizes: tree, settings, agent (new: the agent column becomes resizable, was a fixed 300 px), bottom. Persist in `localStorage` `amp-web-panes` (try/catch, read and write); clamp to min sizes (tree 140, settings 220, agent 240, bottom 60) and to the container so the graphics pane keeps >= 240 px width and >= 160 px height.
- Graphics is the remainder (minmax(0, 1fr)); its size changes only through the splitters or the window.

### 1.2 Auto-show results
- `Session.solvedSeq` increments when a full-resolution Compute delivers a result (and per sweep point). Workbench watches it and sets the view mode to Results. Mesh-only runs, coarse drag runs and unavailable or error outcomes do not switch.

### 1.3 Sweep datasets
- The engine runner solves the first study and `prepareRun` skips parametric studies, so the session runs the sweep itself: a `parametric` study in the spec makes Compute run one engine solve per point (row-major over the axes, as `@amp/core` sweep). Per point: the spec text with the swept params set (op-log splice on a private copy of the text, not logged) and the parametric study removed; validated by the runner like any run.
- `Session.sweep`: axes (param, display unit, values), points (values, label, status, solution, mesh, quality, meshInfo, params). `Session.selectPoint(i)` makes point i the displayed dataset (mesh, post-worker mesh, solution, params). The colorbar, hover probe, probe markers and headline numbers follow the active dataset.
- UI: dataset selector in the graphics toolbar (`D = 10 mm (3/5)`), and the same selector in Settings of the parametric study and result nodes. Headlines: `ui/Headlines.svelte` reads `s.model.parsed.params`; the workbench passes it a session view whose params are those of the active point (no edit to the unowned file; cross-lane request below).
- Test spec: kirsch-plate plus a parametric study over D, built at run time through the share URL (`#d=`) or the hooks; no file under `sims/` is edited.

### 1.4 Probe table
- `post/probe.ts`: row type, evaluation (2D: post worker `evalAt`, exact FE value; 3D: `@amp/post` `sample` on the main thread at the picked surface point), TSV export.
- Canvas2D: a click (pointer up within 4 px of its down point) reports the world point (`onpick`). Canvas3D: same click test, ray from the camera through the cursor, nearest hit on the drawn exterior surface (undeformed positions plus the shown deformation), world point = hit + mesh centre.
- Bottom panel: new "Table" tab; columns: #, x, y, (z), field, value, unit, dataset; Clear, Copy TSV. Lengths in the view's length unit (absolute, labelled), value in the colorbar's display unit. Probe points are marked on the 2D plot (numbered markers; only rows of the shown dataset and field).

### 1.5 Model tree drives the view
- On a tree selection (event, not a derived binding, so a manual mode click is never overridden until the next tree click): geometry, feature -> Geometry (feature: highlight its domains and boundaries); mesh, size, refine -> Mesh; studies, study, results, result -> Results; materials / material, physics / phys / bc -> Geometry with the selected domains or boundaries highlighted. Params, model, provenance and other nodes keep the current mode.
- Tree highlight is separate from the agent's `highlight_selection` (the "Clear highlight" button stays for the agent highlight only).

### 1.6 Verification
- Drive each feature end to end in headless Chromium against the dev server; screenshots in `logs/W2-*`; `pnpm check`, `pnpm test`; `scripts/shots.ts` gates if they can run without `pnpm build` (they serve `build/`, so they cannot run against the dev server without a build: recorded as an open item if so).

## 2. TODO
- [x] DevLog plan (this section)
- [x] 1.1 PaneSplitter + sizes, agent splitter, persistence, reset, keyboard
- [x] 1.2 solvedSeq + auto Results
- [x] 1.3 sweep in Session, selector in Graphics and Settings, headline view
- [x] 1.4 probe.ts, Canvas2D/3D pick, Table tab, markers (2D and 3D)
- [x] 1.5 tree -> mode + highlight
- [x] verification script + screenshots
- [x] pnpm check, pnpm test
- [x] fresh-context audit, corrections
- [x] results, open items

## 3. Progress
- 2026-11-06 20:53 PST: plan written.
- 2026-11-06 21:01 PST: Session sweep, PaneSplitter, probe.ts, ProbeTable, tree-view, Graphics/Canvas2D/Canvas3D/Bottom/Settings/Workbench edits; `pnpm check` 0 errors.
- 2026-11-06 21:02 PST: dev server on 47627 (47613 and 5287 held by other lanes); verification script (scratch, playwright-core + headless shell, swiftshader).
- 2026-11-06 21:03-21:08 PST: verification runs. Fixes found by them: test sweep spec needed `physics` on the parametric study (schema requires it; the sweep now refuses an invalid model); Settings point list did not refresh (point objects reused: each update now copies them); 3D probe returned N/A at surface points (Float32 drawing positions lie up to ~1e-8 m outside the mesh: retry 1e-6 of the model size inward); highlight lines were not mirrored with the symmetric display; 3D probe markers added (SVG overlay projected per frame).
- 2026-11-06 21:09-21:14 PST (between the 21:09 date check and the 21:14 check log): fresh-context audit (subagent, read-only). Corrections below (s.5.3).
- 2026-11-06 21:15 PST: real sweep check on `si-rib-waveguide` (its own `sweep_t`, 7 points) exposed a second validation failure (provenance path into the removed parametric study): fixed. Play `si-rib-waveguide` solves one run, no dataset selector.
- 2026-11-06 21:16 PST: final verification run, `pnpm check` 0 errors, `pnpm test` 10/10; dev server stopped 21:17 PST.

## 4. Cross-lane requests
- W1 (`gfx/viewer3d.ts`): a public `ray(clientX, clientY): {origin, dir}` (or `camera` getter) and `project(p): {x, y, visible}` with depth occlusion. `Canvas3D.svelte` now reads the private `camera` field at run time for picking and marker projection; 3D probe markers are not occluded by the body.
- W1 (`post/post.worker.ts`): a 3D `evalAt` (point location in the worker) so 3D probes leave the main thread; today `@amp/post` `sample` runs on the main thread (lazy-loaded on the first 3D probe).
- Unowned `ui/Headlines.svelte`: read `s.activeParams ?? s.model.parsed?.params`. The workbench passes a session view with the active point's params instead (Workbench.svelte `hv`); the Play view needs nothing (it never sweeps).
- Engine (`apps/web/src/lib/engine/runner.worker.ts`, `@amp/physics`): the runner solves `studies[0]`; a native parametric runner (one prepare per point, shared materials) would replace the session-level loop. Not requested as a blocker.
- Pre-existing, not W2: the dev server emits modulepreload links from a stale `.svelte-kit/output` manifest (`shell/preload.server.ts`), so every dev page load logs 404s for `/_app/immutable/chunks/*`.

## 5. Results

### 5.1 Per item (evidence in `logs/`, final run `logs/W2-verify-20261106T211629.json`, real sweep `logs/W2-rib-sweep-20261106T211553.json`)
| Item | Status | Evidence |
|---|---|---|
| 1 Resizable panels | done. Tree, Settings, Agent (new splitter, was fixed 300 px), bottom; graphics is the rest. Min 140 / 220 / 240 / 60 px, graphics >= 240 x 160 px, clamped to the window without losing the stored size. `localStorage` `amp-web-panes` (try/catch). Double-click or Enter = default; arrows 16 px, Shift 64 px, Home / End = min / max; `role=separator` with `aria-valuenow/min/max`; 9 px hit area on a 3 px bar; hidden on phones | drag +80 / -100 / -120 px -> 300 / 270 / 420 px; 2 x ArrowRight 340 -> 372 px; far drag clamps at 140; reload keeps 320 / 372 / 420 / 270; dblclick -> 220; End -> 822 (window-limited max); Enter -> 220. `W2-splitters-dragged-20261107T051629.png`, `W2-mobile-390-20261107T051629.png` |
| 2 Auto results | done. `Session.solvedSeq` counts full-resolution Compute results (first solved point of a sweep); the workbench sets Results once per increment, so a later manual mode click stays | Mesh -> Compute -> `results`; manual Geometry click after it stays `geometry`. `W2-auto-results-20261107T051629.png` |
| 3 Sweep datasets | done. A `parametric` study runs as one engine run per point (row-major) on a private copy of the text (swept params set; the parametric study, its provenance / assumption / missing paths removed; results pointing at it re-pointed to the inner study). Dataset selector in the graphics toolbar (`D = 4 mm (1/3)`, amber), the same selector plus a point list (status, time) in Settings of study and result nodes, dataset tag in the graphics footer. Mesh, colorbar, hover probe, probe markers, spec probe markers and headline numbers follow the selected point (`Session.activeParams`). Workbench only (`sweepEnabled`); Play solves the single study at the slider values | kirsch-plate + `sweepD` over D = 4, 7, 10 mm (op through the hooks; share code in the run JSON): 3/3 solved, K_t headline 3 / 3.006 / 3.021, colorbar max 3 / 3.01 / 3.02 MPa. si-rib-waveguide `sweep_t` (7 points, 9.1 s wall): n_eff_0 3.412125 (t = 0.1 um) ... 3.414084 (t = 0.7 um), monotonic; the file's reference comment gives 3.414100 at 0.7 um. `W2-sweep-last-*`, `W2-sweep-D4-*`, `W2-sweep-settings-D7-*`, `W2-sweep-si-rib-20261107T051553.png` |
| 4 Probe table | done. Click (press released within 4 px; a pan does not add a row) in Results: 2D exact FE value through the post worker `evalAt` (mirrored points evaluated at their computed image times the parity, as the hover probe), 3D ray pick on the drawn exterior surface (deformation and clip honoured; no pick while animating or when only slices / isosurfaces are shown) then `@amp/post` `sample`. Table tab: #, x, y, (z) in the view's length unit, field (with component), value, unit (display unit; `normalized` for eigenmodes), dataset; row remove, Clear, Copy TSV (header with units). Numbered amber markers on the plot for rows of the shown run, dataset and field (2D and 3D) | 3 clicks -> 3 rows + 3 markers, tab switched to `Table (3)`; TSV copied; row 2 = hover-probe value (0.865797 MPa vs 865797 Pa raw). box-acoustics (172 Hz mode, normalized): 0.7775 at x = 78.46 cm and 0.7057 at 75.07 cm vs \|cos(pi x / 1 m)\| = 0.779 / 0.709. `W2-probe-table-*`, `W2-probe-3d-*` |
| 5 Tree drives the view | done. Geometry / feature -> Geometry (feature: its domains and named boundaries highlighted), Mesh / Size -> Mesh, Refine -> Mesh with its selection, Studies / study / Results / result -> Results, material / physics / BC / coupling -> Geometry with the selection highlighted (expanded to mesh ids incl. split pieces, parent, ancestors; boundary lines mirrored with the display). Params and other nodes keep the mode. Applied on the selection event only, so manual mode clicks are not overridden; tree highlight is separate from the agent highlight | geometry/hole/mesh/refine/std1/steel/tension/Parameters/sxx -> geometry/geometry/mesh/mesh/results/geometry/geometry/(kept)/results; manual Mesh after a tree click stays `mesh`. `W2-tree-feature-hole-*`, `W2-tree-bc-tension-*` |

### 5.2 Checks
- `pnpm check`: 0 errors, 0 warnings (`logs/W2-check-20261106T211540.log`). `pnpm test`: 10/10 (`logs/W2-test-20261106T211706.log`).
- `scripts/shots.ts` serves `apps/web/build` and this lane must not run `pnpm build`, so it was not run. Its workbench gates were re-run against the dev server: op-log round trip 20 edits + 20 undos byte-identical; agent panel key field is a password field, no key in storage; 390 px pane switcher buttons all hit-testable after opening the log pane; splitters hidden on phones. Play views (kirsch-plate, box-acoustics, si-rib-waveguide) solve with no page errors (`W2-play-*`).

### 5.3 Audit corrections (fresh-context audit, 2026-11-06)
1. Play regression: hero `si-rib-waveguide` has a parametric study, so Play would have swept 7 points per slider release, ignored the slider value and skipped the accuracy sequence. Fixed: sweeps only when `Session.sweepEnabled` (set by the workbench); a single run keeps the model text unless the parametric study is first.
2. The sweep read the live model for each point: fixed with a snapshot (text, data, params) at sweep start.
3. Cancel during the point-text build could start an invisible run: token re-checked before each engine run.
4. Sweeping a param without its own unit: falls back to the SI unit of its dimension.
5. Mesh button during a sweep cancelled it: disabled while solving.
6. Probe markers of an earlier run on the same point index: markers now also match the run timestamp.
7. 3D pick during a mode animation: no pick while playing (drawn shape moves).
8. Headline proxy rebuilt on every sweep update: derived on the presence of a sweep only.
9. Pane maths assumed 3 splitters when the agent pane is closed: corrected (6 / 9 px).
10. Settings point rows: `aria-disabled`, Space activates. 11. Cancel updates the done count.
Not changed: 3D probe markers sit on the undeformed body (rows store the reference point where the field is evaluated).

## 6. Open items
- 3D boundary highlight from the tree (faces) is not drawn: the 3D view colours domains only (`regionColors`); needs a face-highlight drawable in `viewer3d.ts` (W1).
- 3D probe markers are not depth-occluded and are drawn at the undeformed point (cross-lane request above).
- No probe in the revolved (axisymmetric 3D) view: a click there would need (r, z) mapping and the azimuthal factor.
- Sweep memory: capped at SWEEP_HELD = 3 points with mesh and solution (s.7, 2026-11-06).
- `shots.ts` gates need a build: the coordinator should run them after the next build.
- Unit tests for `post/probe.ts` (`rayHit`, `toTsv`) belong in `apps/web/test/` (not owned by this lane).

## 7. Wave-3 audit fixes (`DevLog/audits/AUDIT-wave3-2026-11-06.md` m1, m5, m8)

Started 2026-11-06 21:43 PST, done 21:49 PST. Ownership unchanged. The coordinator's `Workbench.svelte` edits (LibraryPicker in place of the sim select, `.tb select` CSS removed) were not touched. W1's audit edits in `Graphics.svelte` and `Canvas3D.svelte` (smooth / Raw, colorbar note, peak tip) are intact next to these changes; `pnpm check` ran after both.

### 7.1 Behaviour (decisions)
- **m1: Mesh with a sweep.** The view shows what the dataset selector says.
  - If a dataset of a sweep computed for the current spec is selected, Mesh shows that dataset's own solve mesh. That is the mesh its solution was computed on, so the solution stays drawn and the labels stay right. A mesh-only build would produce the order-1 preview mesh, which never matches a solve mesh, and would orphan the solution. The Log says so.
  - Otherwise the base model is meshed. This covers no dataset selected, a stale sweep after an edit, and the new "base model (spec values)" entry in the selector. The selector shows "base model (spec values)", the footer dataset tag is hidden, the dataset solution is not drawn, and Results says "Base model (spec values): not a dataset of parametric study ...". It no longer says "Results out of date".
  - Not changed, and not specific to sweeps: after a single Compute, Mesh still builds the order-1 preview mesh and the result shows as out of date.
- **m5: memory cap.**
  - `SWEEP_HELD = 3`: the displayed point plus the two most recently used keep their mesh, quality and solution, evicted least recently used first. The displayed point is never evicted.
  - Every point keeps its scalars, DOF, params, status and time.
  - Selecting an evicted point re-solves it from the sweep's model snapshot in its own worker, so a running sweep is not cancelled. The selector shows "(re-solve)" and the point list shows `*`.
- **m8: auto-advance.**
  - A probe click or a dataset pick pins the display. A running sweep then no longer switches to new points; before any interaction it still follows the newest solved point.
  - Probe rows carry `key = Session.datasetKey` (sweep start + point index, or run timestamp). Marks are drawn while that dataset is shown and survive a re-solve after eviction.

### 7.2 Verification (si-rib-waveguide `sweep_t`, 7 points; `logs/W2-audit-m-20261106T214814.json`)
- **m8:**
  - Probing point 1 after it solved (during the run) kept `t_slab = 0.1 um (1/7)` displayed through the remaining 6 points.
  - Its mark was still there after the sweep, and again after visiting an evicted point and coming back.
  - Evidence: `logs/W2-m8-pinned-probe-20261107T054814.png`.
- **m5:**
  - JS heap (after `gc()`, `--enable-precise-memory-info`) was 36 MB at open and 63 MB after 7 points. The audit measured 91 MB without the cap. Held points: {0, 5, 6}.
  - Scalars are kept for all 7 points: n_eff_0 3.412125 ... 3.414084, DOF 328754 ... 39051.
  - Selecting evicted point 2 re-solved it; mesh hash = solution mesh hash f4434168, and the held set stayed at 3.
  - Evidence: `logs/W2-m5-resolved-20261107T054814.png`.
- **m1:**
  - With point 7 selected, Mesh kept mesh 7b973fc6 = solution mesh 7b973fc6, with no "out of date" and both labels at `t_slab = 0.7 um`. Evidence: `logs/W2-m1-mesh-point7-*.png`.
  - Choosing "base model" meshed the spec values (tri3, e747adc4) with no solution drawn.
  - Editing t_slab to 0.2 um re-meshed the base model (4a81f46f) with the selector on "base model" and the base-model note shown. Evidence: `logs/W2-m1-edit-base-*.png`.
- **Regression:** the earlier W2 run was repeated: splitters, auto Results, kirsch sweep with K_t 3 / 3.006 / 3.021, 2D and 3D probes, tree, op-log round trip, 390 px switcher. All the same, with no page errors.
- `pnpm check` 0 errors (`logs/W2-check-20261106T214940.log`); `pnpm test` 10/10 (`logs/W2-test-20261106T214943.log`). Dev server on 47627 stopped.

### 7.3 Open
- The Mesh button after a single (non-sweep) Compute builds the order-1 preview mesh, so the result shows out of date. This was already so before W2; making Mesh show the solve mesh there too would be the same rule as 7.1.
- `SWEEP_HELD` is a count, not a byte budget. A sweep of very large points still holds 3 of them.
