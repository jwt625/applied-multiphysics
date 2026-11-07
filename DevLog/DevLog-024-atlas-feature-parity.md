# DevLog-024: atlas feature parity inventory (lane W6, read only)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | W6 (feature-parity inventory; read only) |
| Owns | this file only |
| Trigger | user feedback on the live app (2026-11-06, via coordinator): "many of previous example/project implemented features are missing" |
| Read | `../eo-modulator-atlas/app/src/lib/sim/**`, `../eo-modulator-atlas/DevLog/DevLog-027,032,043,046`; `../advanced-packaging-atlas/app/src/lib/sim/**`, `../advanced-packaging-atlas/app/src/lib/three/**`, `../advanced-packaging-atlas/app/src/lib/process/**` (viewer UX only), `../advanced-packaging-atlas/DevLog/DevLog-010..018`, `lanes/`; `apps/web/src/lib/**`, `packages/post/src/index.ts`; `DevLog/DevLog-019..022` (lanes W1-W4 plans) |
| Not done | nothing run, built, installed or edited outside this file; no git |

## 0. Method and caveats (2026-11-06 20:50-21:05 PST)
- Atlas inventories: two read-only subagents, one per atlas, read every file under `app/src/lib/sim/` (plus route, layout, service worker, css) and cited `file:line`. I spot-checked 6 citations myself (eo `Graphics.svelte:781`, `:898`; eo `PlotGroupSettings.svelte:112-117`; eo `SweepSettings.svelte:25-35`; packaging `ResultPages.svelte:152-164`; packaging `Graphics.svelte:520-529`): all match. The rest are the subagents' citations, not re-verified one by one.
- "Here" inventory: read directly by me (`Workbench.svelte`, `Bottom.svelte`, `Tree.svelte`, `Settings.svelte`, `Timeline.svelte`, `YamlTab.svelte`, `gfx/Graphics.svelte`, `gfx/Canvas2D.svelte`, `gfx/Colorbar.svelte`, `gfx/colormaps.ts`, `gfx/capture.ts`, `schema/form.ts`, `ui/FieldEditor.svelte`, `workbench/session.svelte.ts`, headers of the rest) plus greps.
- W2 is editing `Graphics.svelte`, `Bottom.svelte`, `Canvas2D/3D.svelte`, `workbench/*` while I read (probe table, sweep selector and `PaneSplitter.svelte` already appear). Line numbers for `apps/web` are as read at about 21:00 PST and will drift.
- Path prefixes in the table: `EO/` = `../eo-modulator-atlas/app/src/lib/sim/`; `AP/` = `../advanced-packaging-atlas/app/src/lib/sim/`; `W/` = `apps/web/src/lib/`. "absent" = the subagent searched and found nothing.
- Effort is an **estimate** in agent working time: S = up to about 2 h, M = about 2-6 h, L = more than 6 h. These are not measured.
- User value is my ranking (H / M / L) for a COMSOL-style multiphysics workbench, weighted by the user's stated rules (absolute units, data-only plots, verify numbers, dense pro tool).
- Status: **present** / **partial** / **missing** / **W1** / **W2** / **W3** (covered by a running lane, DevLog-019 / 020 / 021) / **N/A** (no physics here that needs it).

## 1. Parity table

### 1.1 Layout and panels
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Resizable panes, sizes persisted | `EO/SimPage.svelte:177-182`, `:22-42` | `AP/SimPage.svelte:39-48`, `:252-257` | present (`W/workbench/Workbench.svelte:168-189`, `:79-113`); agent column fixed 300 px -> **W2** (`W/workbench/PaneSplitter.svelte`) | H | - | W2 |
| Splitter keyboard resize | `EO/Splitter.svelte:19` | `AP/Splitter.svelte:20-26` | present (`W/ui/Splitter.svelte`, 16 px); W2 adds Home/End/reset | M | - | W2 |
| Bottom tabs Messages / Progress / Log / Table | `EO/BottomPanel.svelte:78-83` | `AP/BottomPanel.svelte:73-81` | present + Timeline, Navigation, Memory (`W/workbench/Bottom.svelte`); Table -> **W2** | H | - | W2 |
| Busy line under the toolbar during any run | `EO/SimPage.svelte:174`, `:197` | `AP/SimPage.svelte:249`, `:270-272` | partial: 2 px bar in Graphics only after 1 s (`W/gfx/Graphics.svelte:577`), toolbar status text (`Workbench.svelte:158`) | L | S | W2 |
| Inert loading shell with same layout | `app/src/routes/sim/+page.svelte:21-46` (eo) | `app/src/routes/sim/+page.svelte:29-50` (ap) | present (`apps/web/src/routes/+page.svelte:31`) | - | - | - |
| Side-by-side compare of two runs (A / B), difference B - A | absent | `AP/ResultPages.svelte:152-164`, `AP/workbench.svelte.ts:369-426`, `AP/Graphics.svelte:571`, `:597-602` | missing | M | L | new results lane |

### 1.2 Model tree and settings
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Tree keyboard (arrows select / collapse) | `EO/ModelTree.svelte:131-153` | `AP/ModelTree.svelte:152-165` | present (`W/workbench/Tree.svelte:13-19`) | - | - | - |
| Status tags per node (stale, blocked, off, running, empty) | `EO/ModelTree.svelte:34-40`, `:367` | `AP/ModelTree.svelte:18`, `:99-122` | partial: issue count, results greyed when unavailable (`Tree.svelte:29-31`); no stale / running / not-computed tags | M | S | W2 |
| Context menu: add / duplicate / rename / delete / enable-disable / move features, plot groups, tables | `EO/ModelTree.svelte:157-277`, `:313-345` | absent | missing (tree is generated from the spec, `W/state/tree.ts`; edits only via forms or YAML) | M | M | new model-editing lane |
| Inline rename (F2, double-click) | `EO/ModelTree.svelte:292-311` | absent | missing | L | S | new model-editing lane |
| Tree hover highlights the domains in Graphics | `EO/ModelTree.svelte:336`, `EO/Graphics.svelte:521` | `AP/ModelTree.svelte:186`, `AP/Graphics.svelte:427-429` | missing (W2 s.1.5 covers selection, not hover) | M | S | W2 |
| Tree selection switches view and highlights | `EO/ModelTree.svelte:102-129` | `AP/ModelTree.svelte:128-149` | **W2** (DevLog-020 s.1.5) | H | - | W2 |
| Click a domain or part in Graphics -> selects its tree node | `EO/Graphics.svelte:799-820` (Select tool) | `AP/Graphics.svelte:497-519`, `AP/ModelTree.svelte:167-172` | missing | M | M | W2 |
| Schema / path-driven form fields (text, enum, bool, read-only) | `EO/Field.svelte:45-55` | `AP/Field.svelte:10-22`, `:46-56` | present and stricter: JSON-Schema widgets, dimension-checked quantity + unit (`W/schema/form.ts:8-19`, `W/ui/FieldEditor.svelte`) | - | - | - |
| Expression values with resolved value in tooltip | `EO/Field.svelte:19-30` | `AP/Field.svelte:31`, `:44` | present (`W/workbench/Settings.svelte:24-33`) | - | - | - |
| Expression autocomplete, variable browser, debounced unit check | `EO/ExprInput.svelte:55-197` | absent | missing | M | M | new model-editing lane |
| Inherited / template values styled and overridable | `EO/Field.svelte:23`, `:67` | template status badges `AP/ParamsTable.svelte:83-101` | missing in forms (not seen in `FieldEditor.svelte`) | L | S | new model-editing lane |
| Parameters table: filter, status, refs, range slider | `EO/Settings.svelte:175-183` | `AP/ParamsTable.svelte:14-35`, `:62-101` | partial: slider + exact field per param (`Settings.svelte:68-75`, `W/ui/ParamSlider.svelte`); no filter, refs or status column | M | S | new model-editing lane |
| Presets in the workbench | absent | `AP/ParamsTable.svelte:68-78` | partial: Play view only (`W/play/Play.svelte`) | L | S | new model-editing lane |
| Material library values on the material node | `EO/Settings.svelte:195-199` | `AP/MaterialsTable.svelte:18-55` | present (`Settings.svelte:92-99`) | - | - | - |
| Mesh page with Build and statistics (nodes, elements, min angle, ms) | `EO/Settings.svelte:240-260` | `AP/Settings.svelte:182-188` | partial: toolbar Mesh button; stats only in the footer tooltip (`Graphics.svelte:715`) | M | S | W2 |
| Study readiness / blocked reasons | `EO/Settings.svelte:118-121` | `AP/Settings.svelte:217-230` | present (`Settings.svelte:100-106`) | - | - | - |
| Provenance shown as a table (class, locator, citation) and per-value badges | `EO/Settings.svelte:160-174` | `AP/provenance.ts:8-40`, `AP/Settings.svelte:51-52` | partial: raw JSON listing (`Settings.svelte:76-77`) | M | S | new model-editing lane |
| Download the YAML with session edits | `EO/Settings.svelte:171` (published file only) | `AP/Settings.svelte:127` | missing (share link and op-log JSONL only) | M | S | W2 |

### 1.3 Geometry, mesh and result views
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Geometry / Mesh / Results views with keys | `EO/Graphics.svelte:246-250` | `AP/Graphics.svelte:553` | present (`Graphics.svelte:579-584`, keys G/M/R `:492-497`) | - | - | - |
| Auto-switch to Results after Compute | `EO/workbench.svelte.ts:769-779` | via plot-on-select | **W2** (DevLog-020 s.1.2) | H | - | W2 |
| Axes with ticks in absolute length units (2D) | `EO/Graphics.svelte:608-645` | absent in 3D sim view; triad `AP/Graphics.svelte:449-460` | missing (overlay draws boundaries, markers, handles only: `W/gfx/Canvas2D.svelte:258-290`) | H | S | W2 (Canvas2D) |
| Scale bar | absent | `AP/EmSection.svelte:78-83`, `app/src/lib/three/viewer.ts:980` | missing | M | S | W2 |
| 3D axis triad | absent | `AP/Graphics.svelte:449-460` | missing | M | S | W2 (Canvas3D) |
| 3D view presets iso / front / top / right, keys 1-4 | absent | `AP/Graphics.svelte:520-529`, `:555`, `AP/graphics/BoxViewer.ts:36-41` | missing: fit only (`Workbench.svelte:70` says "fit only") | M | S | W2 (Canvas3D) |
| Mesh colouring choices (material, element size, quality) | `EO/Graphics.svelte:169-178` | cell size `AP/ResultPages.svelte:108` | partial: shape quality only (`Graphics.svelte:268-275`) | L | S | W2 |
| Zoom box tool | `EO/Graphics.svelte:1110-1117` | absent | missing | L | S | W2 |
| Double-click = zoom extents | `EO/Graphics.svelte:1153` | absent | missing (F key, Fit button) | L | S | W2 |
| Pinch zoom on touch | `EO/Graphics.svelte:712`, `:729` | absent | missing (wheel only, `Canvas2D.svelte:245`) | M | S | W2 |
| Measure ruler (length, dx, dy) | `EO/Graphics.svelte:586-595`, `:767` | absent | missing | M | S | W2 |
| Domain labels at centroids | `EO/Graphics.svelte:532` | part hover readout `AP/Graphics.svelte:536-547` | missing (hover footer names the domain, `Graphics.svelte:710`) | M | S | W2 |
| Auto title (field, dataset, step) on the plot | `EO/Graphics.svelte:119`, `:1157` | banners `AP/Graphics.svelte:575-583` | partial: field selector and dataset in footer | L | S | W2 |
| Stale / invalid / coarse badges | `EO/Graphics.svelte:1148-1150` | `AP/Graphics.svelte:575-583` | present (`Graphics.svelte:669-671`) | - | - | - |
| Section plane, slice, deformation scale, mirror | - | `AP/Graphics.svelte:557-559`, `AP/ResultPages.svelte:125-151` | present (`Graphics.svelte:599-665`) | - | - | - |
| z-exaggeration (display only) | absent | `AP/Graphics.svelte:35`, `:561` | missing | L | S | W2 |
| X-ray / translucent host domains in 3D | absent | `AP/Graphics.svelte:564` | missing | L | S | W2 |
| WebGL context loss: notice, recovery, Canvas 2D fallback | `EO/Graphics.svelte:938-976`, `EO/renderer.ts:549-616` | `AP/graphics/BoxViewer.ts:103-110` | partial: `isContextLost()` check only (`W/gfx/renderer2d.ts:312`); Canvas 2D fallback dropped for v0 (`renderer2d.ts:4`) | M | M | W1 |

### 1.4 Plots, colormaps, ranges, field features
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Smooth interpolation / refinement / smoothing options | `EO/PlotGroupSettings.svelte:133-147`, `EO/refined.ts:1-30` | `AP/graphics/FieldLayer.ts:11-47` | **W1** (DevLog-019: per-fragment P2, DG0 recovery, Raw toggle) | H | - | W1 |
| User-defined plot groups: layered features (surface, contour, arrows, line, max/min), each with its own dataset | `EO/results.svelte.ts:147-152`, `EO/PlotGroupSettings.svelte:187-207` | fixed groups `AP/ModelTree.svelte:62-124` | missing: one field selector in the toolbar (`Graphics.svelte:612-613`); results tree nodes are spec `results` entries | M | L | new results lane |
| Manual colour range (min / max, prefilled, kept across Computes) | `EO/PlotGroupSettings.svelte:60`, `:112-117` | `AP/ResultPages.svelte:114-120`, `AP/Graphics.svelte:316-324` | missing: rules full / p1-99 only (`Graphics.svelte:626-629`) | H | S | W2 |
| Manual data range (values outside not drawn) | `EO/PlotGroupSettings.svelte:118-122` | absent | missing | L | S | W1 + W2 |
| Range scales: linear, symmetric, log abs, signed log | `EO/PlotGroupSettings.svelte:102`, `EO/layers.ts:12-36` | linear / log | partial: auto symmetric when both signs >= 5 %; log only when > 2 decades and positive (`Graphics.svelte:185-195`, `:630`); no user symmetric toggle, no symlog | M | S | W2 |
| Colormaps: 7 tables + reverse | `EO/colormap.ts:6-27` | `AP/colormap.ts:8-54` | partial: viridis, cividis, inferno, balance; no reverse (`W/gfx/colormaps.ts:8-9`) | M | S (rights check per table) | W1 |
| Contours: number of levels, explicit list, colour | `EO/PlotGroupSettings.svelte:229-238` | iso list `AP/ResultPages.svelte:131-136` | partial: on/off at colorbar ticks (`Graphics.svelte:282`, `:633`) | M | S | W2 (+ W1 shader) |
| Arrow plots of vector fields (E, q, u): grid, length mode, scale, colour | `EO/PlotGroupSettings.svelte:239-258`, `EO/layers.ts:101` | `AP/graphics/ArrowLayer.ts:39-89`, `AP/ResultPages.svelte:137-143` | missing: "arrows dropped for v0" (`renderer2d.ts:4`); flux lines for T and field lines for A_phi only (`Graphics.svelte:635-636`) | H | M | W1 |
| Max / min markers (both, exact) | `EO/Graphics.svelte:227-233`, `:571-584` | max von Mises per part `AP/ResultPages.svelte:168-176` | partial: peak marker of the drawn lattice (`Graphics.svelte:314`) | L | S | W2 |
| 3D isosurfaces: count or explicit list | - | `AP/ResultPages.svelte:131-136` | partial: count 1-12 (`Graphics.svelte:658-659`) | L | S | W2 |
| Eigenmode table (eigenvalue, n_eff / f, derived per mode; row click selects the mode) | `EO/ModeTable.svelte:25-39` | absent | partial: step dropdown with eigenvalues (`Graphics.svelte:621-624`) | H | S | new results lane |
| 1D line plot component: multi-series, log x / y, hover crosshair, legend, right axis, CSV / PNG | `EO/LinePlot.svelte:20-266` | `AP/LinePlot.svelte:3-267` | missing (no 1D graph anywhere in `apps/web`) | H | M | new results lane |
| Cut line 2D (drag to draw; Line Graph, line integral, line average) | `EO/Graphics.svelte:781`, `EO/ResultsPages.svelte:171-183` | cut line through a probe `AP/ResultPages.svelte:185-189` | missing (backend exists: `packages/post/src/sample.ts:29` `linePoints`, `sample`) | H | M | new results lane |
| Global plot: quantity vs sweep parameter / step / frequency | `EO/Plot1D.svelte:56-120`, `EO/SweepPlot.svelte:39-71` | warpage vs T `AP/ResultPages.svelte:21-49` | missing (W2 adds the dataset selector, not the curve) | H | M | new results lane |
| Time-history plot at a probe (transient) | absent | `AP/ResultPages.svelte:190-198` | partial: step selector + Play steps (`Graphics.svelte:621-631`); no T(t) plot | M | S (after 1D plot) | new results lane |
| Reference / target overlay and targets table (pass / fail vs tolerance) | `EO/TargetsTable.svelte:18-34`, `EO/Plot1D.svelte:100-117` | `AP/Settings.svelte:257-260` | partial: Headlines (`W/ui/Headlines.svelte`) and Play accuracy estimate (`W/post/accuracy.ts`); no workbench table of eval-case targets vs computed | H | M | new results lane |
| Smith chart, S-parameters, Touchstone | absent | `AP/SmithChart.svelte`, `AP/EmPages.svelte:53-97` | N/A (no driven RF solver; DevLog-022 s.1.1) | - | - | - |

### 1.5 Units and sweeps
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Quantity inputs with units | key-suffix units `EO/units.ts:2-15` | key-suffix units `AP/units.ts:5-34` | present and stricter: value + unit, dimension-checked (`FieldEditor.svelte`) | - | - | - |
| Display unit choice per plot (compatible units, SI prefixes) | `EO/UnitInput.svelte:22-50` | degC / K select `AP/ResultPages.svelte:112` | partial: the spec result's unit only (`Graphics.svelte:179-180`) | M | S | W2 |
| Sweep dataset selection | `EO/SolutionSelect.svelte:14-20` | variant / step pickers `AP/ResultPages.svelte:110-111` | **W2** (DevLog-020 s.1.3; selector at `Graphics.svelte:585-591`) | H | - | W2 |
| Sweep definition UI: parameter picker, values list / start:step:stop / linspace, preview, point cap | `EO/SweepSettings.svelte:25-51`, `EO/sweepValues.ts:3-30` | parser ported but unused (`AP/sweepValues.ts:8-41`) | missing: parametric study only through the form / YAML (`W/workbench/session.svelte.ts:284-300` reads it) | H | S-M | new model-editing lane |
| Sweep run table: per point status, metric, ms, error tooltip; CSV | `EO/SweepSettings.svelte:52-62`, `EO/SweepPlot.svelte:52` | absent | partial: status per option in the dataset selector (`Graphics.svelte:590`) | M | S | new results lane |
| Parallel sweep in a worker pool (`?pool=N`) | `EO/pool.ts:1-100`, `EO/workbench.svelte.ts:185-191` | ported, unused (`AP/pool.ts:20-99`) | missing: sequential (`session.svelte.ts:335`) | M | M | engine / session owner |
| Evaluate a derived value over all sweep points | `EO/ResultsPages.svelte:230` | absent | missing | M | S (after derived values) | new results lane |

### 1.6 Probes, derived values, tables
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Hover probe, exact FE value | `EO/Graphics.svelte:822-895` | `AP/Graphics.svelte:366-379` | present (`Graphics.svelte:510-523`) | - | - | - |
| Click probe table (rows, clear, export) | cut point `EO/Graphics.svelte:789` | `AP/ResultPages.svelte:177-184` | **W2** (`W/post/probe.ts`, `W/state/probes.svelte.ts`, Table tab) | H | - | W2 |
| Derived values: surface integral / average / max / min, line integral / average, point eval; rows accumulate in a table with solution and params columns | `EO/results.svelte.ts:153-155`, `EO/ResultsPages.svelte:40-51`, `EO/derived.ts:1-30` | per-part T max / avg `AP/Settings.svelte:231-262` | partial: Headlines evaluate the spec's own `scalar` / `probe` results only (`W/post/headline.ts:2-6`); backend `integrate`, `extrema` exist (`packages/post/src/derived.ts:9`, `:34`) | H | M | new results lane |
| Selections for derived values (click domains, shift add / remove) | `EO/Graphics.svelte:799-820`, `EO/ResultsPages.svelte:195-200` | absent | missing (selection widget is a text list of ids, `FieldEditor.svelte`) | M | M | W2 + results lane |
| Dataset / run summary page (mesh, DOF, timing, stages) | `EO/DerivedValues.svelte:34-85`, `EO/ResultsPages.svelte:158-170` | `AP/ResultPages.svelte:93-100` | partial: log lines, footer mesh tooltip (`Graphics.svelte:715`) | L | S | W2 |

### 1.7 Export
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| PNG export of the graphics (size dialog, legend and title toggles, file named after model) | `EO/Graphics.svelte:898-927`, `:1163-1170` | `AP/Graphics.svelte:530-535`, `:569` | missing for the user: `W/gfx/capture.ts:12` serves only the agent screenshot tool (`Workbench.svelte:72-76`); `preserveDrawingBuffer: false` so it must redraw and read back in one task (`capture.ts:20-26`, already solved) | H | S | W2 |
| CSV of the plotted field (x, y, value, header naming the solution) | `EO/ResultsPages.svelte:103-139` | absent | missing (backend `toCsv`, `packages/post/src/sample.ts:51`) | M | S | new results lane |
| CSV download of tables (probes, derived, sweep) | `EO/ResultsPages.svelte:141`, `EO/SweepPlot.svelte:52` | `AP/ResultPages.svelte:183`, `AP/BottomPanel.svelte:66-69` | partial: probe table Copy TSV (**W2**, `Bottom.svelte:24`, `:79`); no file download | M | S | W2 |
| VTU export (ParaView) | absent | `AP/post.ts:463`, `AP/ResultPages.svelte:62-75` | missing | M | M | new results lane |
| Log save (timestamped .txt) and clear | `EO/BottomPanel.svelte:52-55`, `:63-68` | `AP/BottomPanel.svelte:47-50`, `:57-64` | missing (`Bottom.svelte` Log tab has neither) | M | S | W2 |
| Op-log JSONL download | absent | absent | present, here only (`W/workbench/Timeline.svelte:24-31`) | - | - | - |

### 1.8 Share, undo, shortcuts, tooltips
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Share link with the spec edits | `EO/urlState.ts:13-45` (form edits; free YAML edits not encoded) | `AP/urlState.ts:10-65`, `AP/linkText.ts:1-26` | present and complete: full RFC 6902 diff (`Workbench.svelte:120-125`, `W/state/diff.ts`) | - | - | - |
| Link restores view state (node, view, clip, camera, study) | `EO/urlState.ts:13-45` (section, mesh, stages) | `AP/urlState.ts:10-65`, `AP/SimPage.svelte:149-159` | partial: sim + spec diff only; view mode, selected node, field, step, dataset not encoded | M | S | W2 |
| Undo / redo | `EO/results.svelte.ts:299-366` (results model only) | absent | present and stronger: op log with undo, redo, per-op revert (`Timeline.svelte`, `W/state/model.svelte.ts`) | - | - | - |
| Graphics shortcuts | double-click fit | F, 1-4 (`AP/Graphics.svelte:520-529`) | present G / M / R / W / F / Space (`Graphics.svelte:487-498`); 1-4 presets missing (see 1.3) | - | - | - |
| Global tooltip, focus-visible | `EO/Tooltip.svelte:1-75` | `app/src/lib/Tooltip.svelte:1-78` (ap) | present (`W/ui/Tip.svelte`) | - | - | - |

### 1.9 Progress, cancel, errors
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Compute / Cancel; cancel keeps finished sweep points | `EO/workbench.svelte.ts:624-633`, `:898-908` | `AP/workbench.svelte.ts:521-528` | present (`session.svelte.ts:490-494`) | - | - | - |
| Progress rows per stage | `EO/BottomPanel.svelte:94-99` | `AP/workbench.svelte.ts:563-568` | present (`Bottom.svelte` Progress tab) | - | - | - |
| Messages: switch to Messages on a new error, red count badge, first-seen time, Clear | `EO/BottomPanel.svelte:35`, `:56-61`, `:81`, `:92` | `AP/BottomPanel.svelte:51-55`, `:83-88` | partial: count in the tab label, click jumps to the node (`Bottom.svelte:25`, `:34`); no auto-switch, no red badge, no timestamps, no Clear | M | S | W2 |
| Compute-disabled reason in the button tooltip | via stage tooltips `EO/SimPage.svelte:159-166` | `AP/workbench.svelte.ts:205-215` | partial: reasons in the Results panel (`Graphics.svelte:684-689`); button tooltip static (`Workbench.svelte:146`) | L | S | W2 |
| EM / long-run progress with ETA | absent | `AP/engineRun.ts:117-136` | missing (fraction bar only) | L | S | engine owner |

### 1.10 Performance
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Solve in a worker, post worker holds the solution, stale-reply drop | `app/src/lib/sim.worker.ts:62-121` (eo) | `AP/sim.worker.ts:31-74`, `AP/postClient.ts:1-45` | present (`W/engine/client.ts`, `W/post/client.ts`) | - | - | - |
| Lazy workbench, modulepreload, service worker | `app/src/routes/+layout.server.ts:8-20`, `app/src/service-worker/index.ts` (eo) | `app/src/hooks.server.ts:9-41`, service worker (ap) | present (`W/shell/preload.server.ts`, `apps/web/src/service-worker/index.ts`, ported from eo) | - | - | - |
| Post request LRU cache by bytes | `EO/plots.svelte.ts:1-60` | absent | not verified here | L | - | - |
| Parallel sweep pool | see 1.5 | see 1.5 | missing | M | M | session owner |

### 1.11 Accessibility and mobile
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| ARIA tree, tablist, separator, status / alert | `EO/ModelTree.svelte:323`, `EO/BottomPanel.svelte:78`, `:85` | `AP/ModelTree.svelte:179-186` | present (tree, tablist, separator); `role=status` / `alert` on the status text and errors not seen | L | S | W2 |
| Phone layout | stacked panes at 760 px `EO/SimPage.svelte:201-214` | stacked `AP/SimPage.svelte:275-289` | present: pane switcher (`Workbench.svelte:159-161`, `:219-238`) | - | - | - |
| Light theme toggle | `app/src/lib/ThemeToggle.svelte` (eo) | `app/src/lib/ThemeToggle.svelte` (ap) | missing (dark only; matches the user's default) | L | M | - |

### 1.12 Other
| Feature | eo-atlas | packaging-atlas | Here | Value | Effort (est.) | Owner |
|---|---|---|---|---|---|---|
| Example / case picker with groups | `EO/SimPage.svelte:147-151` | `AP/SimPage.svelte:22-34`, `:226-235` | **W3** (`W/library/LibraryPicker.svelte`, DevLog-021) | H | - | W3 |
| Stage chain selection (which physics stages run) | `EO/SimPage.svelte:159-166`, `EO/workbench.svelte.ts:236-298` | study picker `AP/SimPage.svelte:236-240` | N/A for single-physics specs; a study picker is missing when a spec has several studies (first study runs, `Workbench.svelte:146` tooltip) | M | S | W2 |
| Agent panel, navigation trail, memory | absent | absent | here only (`W/agent/*`, `Bottom.svelte` Navigation / Memory) | - | - | - |
| Robust range rule, symmetry mirroring, flux / field lines, Richardson accuracy, real-time GPU kernels | partial | partial | here only | - | - | - |

## 2. Missing features ranked by user value (not covered by W1 / W2 / W3)

| Rank | Feature | Value | Effort (est.) | Suggested owner | Why |
|---|---|---|---|---|---|
| 1 | 1D line plot component + cut lines (draw on 2D view; Line Graph, line integral / average) | H | M | new results lane | No 1D graph exists anywhere; both atlases have one; every profile, sweep and time plot depends on it; backend sampling already exists |
| 2 | PNG export of the graphics view (size, legend / title toggles) | H | S | W2 | Capture code exists only for the agent; both atlases export PNG |
| 3 | Manual colour range (min / max, prefilled, kept across Computes) + user symmetric toggle | H | S | W2 | Comparing runs or sweep points needs a fixed range; both atlases have it |
| 4 | Axes with ticks in absolute length units on the 2D view; scale bar; 3D triad | H | S | W2 | User rule: plots in absolute units; today only the hover footer gives coordinates |
| 5 | Arrow plots of vector fields (E, heat flux q, displacement u) | H | M | W1 | Dropped in v0; eo and packaging both have arrows; flux lines cover T only |
| 6 | Sweep result plot (headline / derived quantity vs swept parameter) + sweep run table with CSV | H | M | new results lane | W2 makes datasets selectable; the curve over the sweep is what the user wants from a sweep |
| 7 | Derived values UI (integral / average / max / min over a selection, point eval) accumulating into a table with dataset and params columns | H | M | new results lane | Only the spec's own headline results are evaluated; backend `integrate`, `extrema` exist |
| 8 | Sweep definition UI (parameter picker, list / start:step:stop / linspace, preview, cap) | H | S-M | new model-editing lane | Today a sweep needs a hand-written parametric study in YAML or the generic form |
| 9 | Eigenmode table (eigenvalue, frequency or n_eff, derived per mode; click selects the mode) | H | S | new results lane | em-modes, emw, acoustics heroes are eigen; today a dropdown |
| 10 | Data export: CSV of the plotted field and of tables (file download), VTU | M | S (CSV), M (VTU) | new results lane | Both atlases export data; here only TSV copy of probes (W2) and op-log JSONL |
| 11 | Reference / eval-target table in the workbench (computed vs expected, tolerance, pass / fail) | H | M | new results lane | Project is built around eval cases; Play has an accuracy estimate, the workbench has none |
| 12 | 3D view presets (iso / front / top / right) with keys 1-4 | M | S | W2 | `set_camera` already reports "fit only" |
| 13 | Messages auto-switch on new error, red badge, timestamps, Clear; Log Save and Clear | M | S | W2 | Both atlases; cheap |
| 14 | Contour options (levels count / list / colour); isosurface list | M | S | W2 + W1 | Today a toggle at colorbar ticks |
| 15 | Colormap set (Rainbow, Thermal, Wave, GrayScale) + reverse | M | S | W1 | Rights check per table first (CLAUDE.md) |
| 16 | Download YAML with session edits | M | S | W2 | packaging atlas has it; share link is the only way out today |
| 17 | Link restores view state (mode, node, field, step, dataset, camera) | M | S | W2 | packaging atlas restores node, view, clip, study |
| 18 | Tree context menu (add / duplicate / delete / enable-disable / move) and inline rename | M | M | new model-editing lane | eo atlas; each action is one op-log patch here |
| 19 | Expression input with autocomplete and unit check | M | M | new model-editing lane | eo atlas `ExprInput` |
| 20 | Compare two runs (pin A; side by side; B - A) | M | L | new results lane | packaging atlas; useful with sweeps |
| 21 | Graphics click selects the tree node; tree hover highlights domains; domain labels | M | S-M | W2 | Both atlases |
| 22 | Measure ruler, zoom box, pinch zoom, double-click fit | M | S | W2 | eo atlas |
| 23 | Parallel sweep worker pool | M | M | session / engine owner | eo atlas; code exists in both atlases (packaging copy unused) |
| 24 | Canvas 2D fallback and context-loss recovery | M | M | W1 | eo atlas; machines without WebGL2 get no picture today |
| 25 | User-defined plot groups with layered features | M | L | new results lane | eo atlas; larger redesign; do after 1, 5, 7 |
| 26 | Display unit choice per plot | M | S | W2 | eo atlas `UnitInput` |
| 27 | Provenance as a formatted table, per-value status badges | M | S | new model-editing lane | Raw JSON today |
| 28 | Study picker when a spec has several studies | M | S | W2 | First study only today |

Lower value, not ranked: busy line, mesh colour by size, z-exaggeration, X-ray, light theme, plot titles / legend toggles, max+min markers, time-history plot (falls out of 1), ETA, presets in the workbench, run summary page.

## 3. Notes for the coordinator
- Proposed new lanes (not started; they need file ownership that does not collide with W1 / W2):
  - **results lane**: new `apps/web/src/lib/results/` (`LinePlot.svelte`, `CutLine.ts`, `Derived.svelte`, `SweepPlot.svelte`, `ModeTable.svelte`, `export.ts`). Needs small hooks in `Graphics.svelte` (W2) for the cut-line drag tool and the plot view slot.
  - **model-editing lane**: sweep definition UI, tree context menu, expression input, provenance table; owns new files under `apps/web/src/lib/workbench/` only after W2 finishes (W2 owns `workbench/*` now).
- Items 2, 3, 4, 12, 13, 16, 17 are small and sit in files W2 owns (`Graphics.svelte`, `Canvas2D/3D.svelte`, `Bottom.svelte`, `Workbench.svelte`): cheapest as a W2 follow-up round.
- Items 5, 15, 24 sit in renderer files W1 owns.
- Do not port the packaging atlas's known defects: `dscale` parsed but never applied, and the Link tooltip contradicting the `text=` packing (`AP/SimPage.svelte:149-159`, `:245`, per subagent).

## 4. Progress
- 2026-11-06 20:50 PST: started; two read-only inventory subagents launched (one per atlas).
- 2026-11-06 20:50-21:02 PST: read `apps/web` workbench, gfx, state, post, schema, ui; lanes W1-W4 DevLogs.
- 2026-11-06 21:02 PST: spot-checked 6 atlas citations (all match); wrote this DevLog.
- 2026-11-06 21:04 PST: checked the file for absolute paths and emoji (none); done.
