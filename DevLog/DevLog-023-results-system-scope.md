# DevLog-023: Results / postprocessing system, scope (lane W5)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | W5 (results and postprocessing scoping; planning only, no code) |
| Owns | this file |
| Request | Wentao, via coordinator: "scope out additional visualization options similar to comsol. e.g., create new 2d or 3d plot with corresponding types, create additional data set from cutplane and cutline etc." |
| Read (this repo) | `packages/spec/src/{schema,validate,invalidation,units}.ts`, `packages/post/src/*`, `packages/agent/src/{tools/schemas,session,runner}.ts`, `apps/web/src/lib/{workbench,gfx,post,state}/*`, `sims/*.yaml`, DevLog-011, -015, -020 (W2 plan, 20:53 PST), CONTRACTS-v0, research R1/R2, `validation/a/gen_solid.py` |
| Read (siblings, read only) | `eo-modulator-atlas` at 0546007: `app/src/lib/sim/{results.svelte.ts,post/contract.ts}`, `engine/src/postproc/{evaluate,expr}.mjs`, DevLog-030/032. `advanced-packaging-atlas` at fe39985: `app/src/lib/sim/{results.ts,ResultPages.svelte,SmithChart.svelte,LinePlot.svelte}` |
| Status | plan only; stages R0-R7 below need coordinator assignment |

Conventions: "F" = fact read from code or docs (path or URL given); "E" = estimate (labelled); "P" = proposal.

## 0. Summary

Today results are one implicit view: the Graphics panel picks a field from the solution and offers toolbar toggles (contours, slice, iso, section, deform, mirror). The spec `results` list carries only a field name and a unit per plot, and the toolbar state is not in the spec or the operation log. The proposal: a typed Results model in `amp-spec` with datasets, evaluations, tables, plot groups with plots, and exports. Every node is added and edited through the operation log, so the agent and the human edit it the same way. Evaluation kernels move into `@amp/post`, so Node (eval harness, agent runner) and the browser post worker compute the same numbers. The work is staged R0-R7, each stage gated against closed-form values (Kirsch, coax, box modes, TM010, erfc).

## 1. Current state (F, 2026-11-06 21:00 PST)

### 1.1 Spec

- `packages/spec/src/schema.ts:318-332`: `RESULT_TYPES = plot1d | plot2d | plot3d | table | scalar | probe`. Node `{id, type, label?, data: <study id>, expr?, unit?, select?, at?: vector(m), step?}`. A probe needs `at`. Everything else is free: no plot type, no dataset, no range, no colormap.
- `validate.ts:324-329`: checks the id is unique, that `data` names a study, and the selections.
- `invalidation.ts`: any edit under `results` invalidates `plots` only (no re-solve). This is already the right stage, but it applies to the whole section, not per node.
- Usage in `sims/*.yaml` (grep): 19 files have `results`; node types 10 plot2d, 2 plot3d, 7 probe, 1 scalar, 7 table. Forms used: `expr: <physics>.<field>`, `scalar` as `max(<field>)/<param>` over a selection (kirsch `kt`), and `table` over eigen steps or a sweep (`si-rib-waveguide` `neff` over `sweep_t`).
- Expressions: `@amp/core/expr` (a port of the EO `expr.mjs`) already compiles array-at-a-time with SI dimension inference and a `field` resolver kind (`packages/spec/src/units.ts:61-95`). `@amp/post` does not use it yet: no field expression (e.g. `solid.sxx/s_inf`, `sqrt(...)`) is evaluated anywhere today.

### 1.2 `@amp/post` (engine, Node + worker)

- `evaluate.ts`: `Locator` (bucket grid + Newton inverse map) and `evaluateField` on C2 meshes, dims 2/3, values and gradients, H1 P1/P2/Q1 and DG0. NaN outside.
- `sample.ts`: `sample(sol, field, points, {mesh, component|'norm', step, snap})`, `linePoints(a, b, n)`, `gridPoints` (2D), `toCsv`.
- `derived.ts`: `integrate` (quadrature, optional 2 pi r weight), `extrema` (nodal max/min with argmax).
- `store.ts`: `SolutionStore`, a mesh cache by hash (16), `fieldOf(name, step)`.
- `refine.mjs`: the EO refined-lattice pattern (COMSOL Quality > Resolution analogue).

### 1.3 Web app

| Area | What exists (F) |
|---|---|
| Graphics (`gfx/Graphics.svelte`, 699 LOC) | modes Geometry / Mesh / Results; field, component and step pickers; range rule full / p1-99; log; colormap; contours at nice ticks; refined lattice level r; peak marker; probe markers from spec `probe` results; heat flux lines (T), field lines (r A_phi); mirror (Play, hero-configured parity); 3D: exterior surface, section (clip), one axis-aligned slice, N isosurfaces, deformation p + s u, eigen phase / step animation, revolved surface for axisym EM modes. All of this is component state: not in the spec, not in the op log, not reachable by the agent except through `set_view_mode` and `screenshot` |
| Post worker (`post/post.worker.ts`) | messages `mesh, field, probe, exterior, display, evalAt, lattice, flux, revolve, iso, slice`; 2D `Locator` in `post/field2d.ts` (a second implementation next to `@amp/post` `Locator`) |
| Kernels in the app (`post/solid3d.ts`, `revolve.ts`, `flux2d.ts`) | marching tets (iso, slice), exterior faces, cell quality, revolve, flux-line tracing. Not in `@amp/post`, so Node cannot reproduce them |
| Headlines (`post/headline.ts`) | evaluates spec `scalar` (`max|min(field)` + param expression, nodal) and `probe` (2D, exact FE). Other forms report "not evaluated" |
| Tree (`state/tree.ts`) | Results = a flat list of nodes labelled id / type. No add or remove menu anywhere in the tree (every structural edit goes through YAML, the form or the agent) |
| Settings form (`schema/form.ts`) | generated from the exported JSON Schema (`x-amp-quantity`, `x-amp-selection`, enums). A richer results schema gets forms without new UI code |
| 1D plots | none in `apps/web` (no line-graph component) |
| Export | `gfx/capture.ts` (PNG of the canvas, also used by the agent `screenshot`); no CSV export in the app |

### 1.4 In flight: W2 (DevLog-020, plan 20:53 PST)

- Sweep datasets: the session runs a `parametric` study point by point; `Session.sweep` holds the points (values, solution, mesh, params); `selectPoint(i)`; a dataset selector in the toolbar and in Settings.
- Probe table: click to pick (2D exact `evalAt`, 3D ray hit + `sample`); a bottom "Table" tab (`#, x, y, (z), field, value, unit, dataset`), Copy TSV; numbered markers.
- Tree drives the view mode. W2 owns `workbench/*`, `Graphics.svelte`, `Canvas2D/3D.svelte`, `state/*`, new `post/probe.ts`. W1 owns `renderer2d.ts`, `field-material.ts`, `viewer3d.ts`, `field2d.ts`, `post.worker.ts`, `solid3d.ts`, `revolve.ts` (DevLog-020 header). Every stage below that touches these files waits for W1 and W2 to land.

### 1.5 Agent

`packages/agent/src/tools/schemas.ts`: edits go through `apply_ops` (JSON Patch with `@id` tokens), reads through `get_spec`, `schema_at`, `list_entities` (includes `results`), `get_results_summary` (module scalars, stats; no spec-results values), `run_study`; UI tools `set_view_mode`, `screenshot`. The agent cannot ask for a value along a line, an integral, or a plot of a given kind.

### 1.6 Sibling atlases (F, read only)

| Repo | Results features |
|---|---|
| EO `app/src/lib/sim/results.svelte.ts` (578 LOC), `post/contract.ts` (119) | A COMSOL Results model, 2D only, kept in UI state with its own undo / redo (not the spec): datasets (solution, parametric), selections, Cut Line 2D, Cut Point 2D; plot groups 2D (surface, contour, arrow surface, line, max/min marker) and 1D (line graph, global, table graph); derived values (global, surface int / avg / max / min, line int / avg, point); wide tables with column roles; per-feature range, data range, colour table, resolution / smoothing; CSV / PNG export. Engine `evaluate.mjs` (476): line integrals split at element crossings with 3-point Gauss per piece; 6-point degree-4 surface rule; refined-lattice max / min with exact values at the markers. `LinePlot.svelte` (293, Canvas 2D: nice ticks, log toggles, hover, second y axis, PNG / CSV) |
| APA `app/src/lib/sim` | Ported `LinePlot.svelte`; `SmithChart.svelte` (120, Canvas 2D, hover, CSV / PNG); `graphics/ArrowLayer.ts` (96, InstancedMesh arrows); probes / pins; compare A, B and B - A; VTU export; Cut Line 3D page; mirrored symmetry crops (R2 survey lines 159-164) |

Lesson carried over (R1 lines 265-270, 363-364): Plotly cost a 4.6 MB bundle and a long task, and EO removed it from `/sim` for its own Canvas `LinePlot`. Keep 1D plots dependency-free.

## 2. Reference model

All sources accessed 2026-11-06. COMSOL names are used for concepts only; no COMSOL file, run or value is used.

### 2.1 COMSOL Results branch

Categories (COMSOL 6.3 Results Overview, https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_results.37.002.html):

- Configurations: which times, eigenvalues or parameter values to use.
- Datasets.
- Derived Values / Evaluation Groups / Tables.
- Plot Groups and Plots.
- Export (data, images, animations, player). There is a "Run all exports after solving" option.
- Reports.
- Views: optional, hidden by default.

**Datasets** (COMSOL 6.4 Table 21-7, https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_results.37.043.html; 42 rows). Relevant to this project:

- Solution (solver-created).
- Cut Point 1D/2D/3D, Cut Line 2D/3D, Cut Plane.
- Edge 2D/3D (boundaries / edges), Surface (3D boundaries).
- Revolution 1D/2D, Mirror 2D/3D, Sector 2D/3D.
- Join (two solutions, e.g. their difference).
- Grid 1D/2D/3D.
- Parametric Curve 2D/3D, Parametric Surface.
- Filter, Isosurface, Average and Integral, Maximum and Minimum, Transformation 2D/3D, Extrusion, Embed.
- Array, Spatial FFT, Time Average / Integral, Mesh.

Module-specific rows (particle, ray, grain, shell, layered material, response spectrum) are out of scope.

**Dataset details:**

- Cut Line: two points. Resolution comes from the mesh and the plot's Quality setting (use Parametric Curve for full control). Snapping: none, closest boundary, or closest edge (3D). Additional parallel lines carry a line-number variable (https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_results.37.049.html).
- Cut Plane: allows several parallel planes. Mirror 3D: three points, or a point and a normal (https://doc.comsol.com/6.2/doc/com.comsol.help.comsol/comsol_ref_results.35.008.html).
- Revolution 1D/2D, Sector 2D/3D and Mirror 2D take axis data (https://doc.comsol.com/6.2/doc/com.comsol.help.comsol/comsol_ref_results.35.006.html).

**Plot groups:** 1D, 2D, 3D, polar and Smith. Smith needs the RF or AC/DC module. A group holds plots drawn together in one window, on a shared or per-plot dataset. Attributes (deformation, color expression, filter, selection) modify individual plots. Physics creates default plots, which a study setting can switch off (https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_results.37.108.html). Polar uses the 1D plot types and settings (https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_results.37.118.html).

**Plot types** (COMSOL 6.4 Table 21-11, https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_results.37.109.html; 78 rows). Relevant to this project:

| Group | Plot types |
|---|---|
| Field plots | Surface (2D domains, 3D boundaries), Contour, Line (2D boundaries, 3D edges), Point, Arrow Surface / Volume / Line / Point, Streamline, Streamline Surface / Multislice, Slice, Multislice, Isosurface, Volume, Mesh, Max/Min Volume / Surface / Line / Point |
| Graphs | Line Graph, Point Graph, Global, Table Graph / Surface / Contour / Point, Histogram, Function |
| Structural | Principal Stress Volume / Surface / Line |
| Polar and Smith | Radiation Pattern, Directivity, Admittance / Impedance / Reflection Graph (Smith) |
| Sweeps | Waterfall, Nyquist, Contour / Isosurface Series |

Plot attributes (Table 21-12, same page): Color Expression, Deformation, Height Expression, Filter, Selection, Transformation, Transparency, Marker, Graph Marker, Error Bars, Material Appearance, Comparison, Solution Array.

**Derived values / evaluation nodes** (COMSOL 6.4 Table 21-10, https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_results.37.091.html):

- Point Evaluation, Global Evaluation.
- Global / Point Matrix Evaluation, System Matrix (these three are not allowed in Evaluation Groups).
- Volume / Surface / Line, each as Average, Integration, Maximum, Minimum and Standard Deviation.
- Measurement (volume, area, length, distance, mass properties).
- Global Evaluation Sweep.

"Surface" means 2D domains or 3D boundaries; "Line" means 1D domains, 2D boundaries or 3D edges.

**Evaluation Group** (https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_results.37.089.html):

- A container like a plot group: shared settings, and it is the table its children write to.
- The table can be transposed.
- Child results can be combined by a sum, average, difference or custom expression of child tags.
- Results concatenate horizontally or vertically.
- Row limit; stored in the model, in a file, or both.
- Re-evaluation on solve is optional.
- Solution parameters per child, or inherited from the group.

**Probes** (Definitions; https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_definitions.21.126.html):

- Probe types: domain / boundary / edge / point, giving average, min, max or integral; domain-point and boundary-point probes give a value at a point; global variable probes (6.3 page https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_definitions.21.121.html).
- Each probe creates a Probe Table, a Probe Table Plot and a Probe Solution dataset, all updated while solving.

### 2.2 Other tools: what is better or simpler

| Tool | Feature | Lesson for this project |
|---|---|---|
| ParaView (https://docs.paraview.org/en/latest/UsersGuide/filteringData.html) | Filters form a pipeline (input port -> filter -> output port, multi-input filters, "Change Input" rewires); Slice (plane, sphere, box, cylinder), Clip, Threshold, Contour, Calculator / Python Calculator (new arrays from expressions), Glyph, Stream Tracer, Warp By Vector, Probe, **Plot Over Line** (sample and chart in one step), Integrate Variables | One uniform node kind ("dataset from dataset") is simpler than COMSOL's split between datasets and plot attributes. Plot Over Line = cut line + line graph in one click: offer it as a single "+ Line plot here" action that creates both nodes |
| ParaView state / trace (https://paraview.readthedocs.io/en/latest/Tutorials/ClassroomTutorials/advancedStateManagement.html; trace: https://docs.paraview.org/en/v6.1.0/_sources/Tutorials/SelfDirectedTutorial/batchPythonScripting.rst.txt) | State saved as `.pvsm` (XML) or `.py`; Python Trace records GUI actions as a replayable script | Our op log already is the trace: making results spec nodes gives "replayable visualization state" for free |
| Ansys Mechanical (https://ansyshelp.ansys.com/public/Views/Secured/corp/v251/en/wb_sim/ds_linearized_stresses.html) | Construction Geometry > Path / Surface objects that results are scoped to; Linearized Stress along a straight path (Two Points or X-axis-intersection path types) | Cut lines as reusable geometry objects that several results reference (the same as our cut-line datasets); a path type that clips itself to the mesh (points always inside) avoids NaN ends |
| Ansys Fluent (https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/flu_ug/flu_ug_reporting_sec_monitoring_solution.html; https://ansyshelp.ansys.com/public/views/secured/corp/v251/en/flu_th/flu_th_SurfaceIntegration.html) | Report definitions (surface / volume integrals, area-weighted average) feed Report Plots and Report Files during the solve | One definition drives a monitor plot, a file and a value: the same as an evaluation node feeding a table, a 1D plot and an eval target |
| Elmer (https://mirrors.nic.funet.fi/index/elmer/slides/ElmerPostInSolver.pdf; ElmerGUI defs https://cocalc.com/github/ElmerCSC/elmerfem/blob/devel/ElmerGUI/Application/edf-extra/saveline.xml) | SaveLine (polyline coordinates + divisions; saves every field by default), SaveScalars (operators such as min, boundary integral, flux; exact coordinates option), ResultOutputSolver (vtu) | Postprocessing as declarative entries in the case file, the same as ours; "save every field on the line" is a useful default for agents (one call, all fields) |
| FEniCS / DOLFINx + PyVista (https://docs.fenicsproject.org/dolfinx/main/python/demos/demo_pyvista.html) | `plot.vtk_mesh` from a function space (P2 and DG data drawn natively), `warp_by_scalar`, `glyph`, `streamlines`, off-screen `screenshot` | A height-expression view of a 2D scalar field (warp by scalar) is cheap and reads well; higher-order data stays exact (our refined lattice already does this) |

## 3. Proposed design (P)

### 3.1 Principles

1. **The spec is the plot.** Every dataset, evaluation, table definition, plot group, plot and export is a spec node under `results`. It is edited by JSON Patch through the op log (`actor: user | agent:*`). Undo, revert, share-URL diffs and replay already work for it.
2. **Values are not in the spec.** Table rows, sampled arrays and images are artifacts computed from (spec node hash, solution run id). Exception: an explicit "pin" turns probe rows into spec nodes (s.3.5).
3. **One evaluator.** Every number shown or returned (UI, agent, eval harness) comes from `@amp/post` kernels. The app keeps only display work (lattices, colour ranges, GPU buffers).
4. **Honesty rules carry over** (DevLog-011 s.7, audits B1, S1, S4, S5):
   - A plot is drawn only on its own mesh.
   - A stale or coarse result is badged.
   - Eigenmodes are drawn normalized, without a unit.
   - Each max / min states its method (nodal, lattice or quadrature).
   - Range rules are stated in the tooltip.
   - Unavailable is never shown green.
5. **No hidden physical defaults.** Templates prefill geometry-derived choices (cut-line ends from the bounding box, the first study, the first field of the module's `RESULT_NAMES`), and those values are visible in the spec. Nothing physical is invented.

### 3.2 Schema (`amp-spec`, L2 owns; contract C3 change)

Proposed `results` shape: a grouped object that mirrors the tree. Q1 asks whether to keep the flat list instead.

```yaml
results:
  datasets:
    - {id: sol1, type: solution, data: std1, steps: all}               # steps: all | last | first | [i, ...] | {values: [...], unit}
    - {id: cl1, type: cutline, data: sol1, from: [0, "a"], to: [0, "L"], n: 200, parallel: []}   # 2D or 3D by dim
    - {id: hole, type: edge, data: sol1, select: ["bnd:hole.edge"]}     # arc-length parameter s
    - {id: cp1, type: cutplane, data: sol3, point: ["Lx/2", 0, 0], normal: [1, 0, 0], offsets: []}  # yields a 2D dataset
    - {id: pts, type: cutpoint, data: sol1, points: [["Lx", "Ly/5"]]}
    - {id: rev, type: revolve, data: sol1, angles: {start: 0, sweep: 270, unit: deg}, layers: 64}
    - {id: mir, type: mirror, data: sol1, planes: [{normal: [1, 0]}, {normal: [0, 1]}], parity: {solid.sxy: [-1, -1]}}
    - {id: diff, type: join, a: solh, b: solh2, op: difference}        # later stage
  evaluations:
    - id: ev1
      label: K_t and line integral
      data: sol1                                                       # group default; children may override
      items:
        - {id: kt, type: max, over: ["bnd:hole.edge"], expr: "solid.sxx/s_inf", unit: "1", method: lattice}
        - {id: Fx, type: integral, data: cl1, expr: solid.sxx, unit: "N/m"}
        - {id: s_pt, type: point, data: pts, expr: solid.mises, unit: MPa}
        - {id: area, type: measure, over: ["dom:plate"], unit: "mm^2"}
  plots:
    - id: pg_s
      type: plot2d                                                     # plot1d | plot2d | plot3d | polar | smith
      data: sol1
      steps: last
      items:
        - {id: surf, type: surface, expr: solid.mises, unit: MPa, range: {rule: full}, colormap: auto}
        - {id: cont, type: contour, expr: solid.sxx, unit: MPa, levels: {count: 14}, color: uniform}
        - {id: mm, type: maxmin, expr: solid.mises, show: max}
        - {id: dfm, type: deformation, expr: solid.u, scale: auto}     # attribute: applies to the group
    - id: pg_line
      type: plot1d
      items:
        - {id: lg, type: linegraph, data: cl1, x: "y", expr: solid.sxx, unit: MPa}
        - {id: lg_ex, type: linegraph, data: cl1, x: "y", expr: "s_inf*(1 + a^2/(2*y^2) + 1.5*a^4/y^4)", unit: MPa, label: Kirsch exact}
  tables:
    - {id: t1, from: ev1, orient: rows}                                # one row per step or sweep point
  exports:
    - {id: x1, type: data, from: lg, format: csv}
    - {id: x2, type: image, from: pg_s, size: [1600, 1000]}
```

**Schema rules:**

- Discriminated unions on `type` per group, so `schema_at` and the generated Settings form resolve each type.
- Every length or angle is a `quantity` (unit-checked), and expressions are dimension-checked against `unit` through `@amp/core/expr`.
- One id namespace across the whole spec, which is needed for `@id` patch paths (`/results/plots/@pg_s/items/@surf/expr`).

**Cross-reference checks (`validate.ts`):**

- Dataset chains are acyclic.
- Kind compatibility: a `cutplane` needs a 3D source; `revolve` needs `axisym`; a `plot2d` item needs a 2D dataset (dim 2 or a cut plane); `linegraph` needs a line-like dataset (cut line, edge or parametric curve); `pointgraph` needs a cut point.
- `data` resolves to a study or a dataset.
- Selections resolve with `checkSelections`.

**Expression vocabulary** (C-section text):

- Field names `<physics>.<field>` and components `.x .y .z` (`.r .phi .z` in axisym).
- Params; `x y z r t`; functions `abs sqrt exp log sin cos atan2 min max if real imag`.
- Gradient `d(f, x)`, evaluated per element. It is discontinuous across elements and labelled as such.
- Module scalars as `<physics>.<scalar>` for global evaluations.

**Legacy forms** (the 27 nodes in sims) map one to one:

| Legacy node | New form |
|---|---|
| `plot2d` / `plot3d` | plot group with one `surface` |
| `probe` | `cutpoint` + `point` evaluation |
| `scalar` | `max` / `min` evaluation |
| `table` | evaluation group over steps or sweep points + table |

L2 migrates all 19 sims and any spec embedded in eval cases in one pass. The C3 `results: [...]` line changes.

**Invalidation:** edits under `results` keep stage `plots`. The session diffs node hashes before and after (`op.before` / `op.after` specs) and recomputes only changed nodes and their dependents. No C7 field is needed.

### 3.3 Where computation runs

| Work | Where | Notes |
|---|---|---|
| Field expressions over points or quadrature points | `@amp/post` new `expr.ts` over `@amp/core/expr` compiled closures | array at a time; units from field `unit` |
| Datasets: cut point, cut line (uniform n and exact element-crossing segments), edge (boundary facets ordered by arc length), cut plane (move `apps/web/src/lib/post/solid3d.ts` `slice` / `marchingTets` into `@amp/post`), surface (3D boundary faces), revolve (generalize `revolve.ts` from E_rphiz to any axisym field and component), mirror (with parity), join (evaluate b at a's points) | `@amp/post` | pure TS on C2 meshes; Node-testable |
| Evaluations: point, global, line / surface / volume integral / average / max / min, measure | `@amp/post` (`derived.ts` extended) | line integrals split at element crossings with 3-point Gauss per piece (EO `evaluate.mjs` method); axisym weight 2 pi r; max / min method `nodal`, `lattice` (refined lattice, exact values) or `quad` |
| Browser execution | post worker; the existing worker gains a `results` message set that wraps `@amp/post` calls | one heavy request in flight per plot; latest wins (pattern of `PostClient.probe`) |
| Display: refined lattice, colour ranges, contour lines, arrows, streamlines (RK4 on the element locator), 3D buffers | apps/web post worker (display) and GPU (WebGL2 2D renderer, three.js TSL 3D) | GPU for drawing only. No WebGPU compute is needed at current sizes (E: largest browser mesh is the rib, 328,754 DOF, DevLog-011 s.4.2). Volume rendering (R7) is the first GPU-compute candidate |
| Node (eval harness, agent `StudyRunner`) | `@amp/post` directly | the same numbers as the browser; eval targets can name an evaluation node (C8 `extract: {result: "results.<id>"}`, L8) |
| Locators | consolidate `apps/web/src/lib/post/field2d.ts` `Locator` onto `@amp/post` `Locator` | after a speed check on the rib mesh; one point-location implementation |

### 3.4 UI (model tree under Results)

```
Results
  Datasets          [+]  Solution | Cut Point 2D/3D | Cut Line 2D/3D | Cut Plane | Edge | Surface | Revolution 2D | Mirror 2D/3D | Join | Grid | Parametric Curve
  Evaluations       [+]  Evaluation Group > Point | Global | Line / Surface / Volume: Integral, Average, Max, Min | Measure
  Tables                 (computed; opens in the bottom Table tab)
  1D Plot Group     [+]  Line Graph | Point Graph | Global | Table Graph   (Polar / Smith later)
  2D Plot Group     [+]  Surface | Contour | Arrow Surface | Streamline | Line | Max/Min | Point | Mesh; attributes Deformation, Height, Filter
  3D Plot Group     [+]  Surface | Slice | Isosurface | Volume | Arrow Volume | Streamline | Line | Max/Min | Mesh; attributes Deformation, Filter, Transparency
  Export            [+]  Data | Table | Image | Mesh (VTU)
```

**Tree interactions:**

- "+" opens a menu on the folder row and on right-click. Each entry issues one `add` op with a template: required fields filled per s.3.1 rule 5, and the new node is selected.
- Delete, Duplicate, Disable (`enabled: false`) and Move up / down are ops too.
- This is the first add / remove UI in the tree. Build it generically, so Geometry, Physics and Materials can reuse it. That needs coordination with W2, which owns `state/tree.ts` and `workbench/*`.

**Graphics:**

- Selecting a plot group draws it, as in COMSOL. The Graphics pane shows the selected group and its dim decides the canvas: 2D renderer, three.js, or the 1D `LinePlot`.
- Today's toolbar becomes a "quick view": an unsaved scratch plot group. "Save as plot group" writes it to the spec in one op. Play views keep working unchanged on the quick view.

**Interactive creation** (each gesture = one coalesced op, like slider drags today):

- Drag on the 2D canvas = Cut Line 2D (with a "+ Line Graph" companion = ParaView Plot Over Line).
- Click = Cut Point.
- 3D plane gizmo = Cut Plane or Slice.
- Shift-drag on a handle moves the cut line end.

**Settings:** generated from the schema (`schema/form.ts`). Dataset pickers are enums of compatible ids; expression fields get the unit check message.

**1D plots:** port EO `LinePlot.svelte` (port header, C1): Canvas 2D, nice ticks, log x / y, hover readout, a second y axis, PNG / CSV. Smith comes from APA `SmithChart.svelte` when S-parameters exist (R7).

### 3.5 Interaction with W2 (DevLog-020)

| W2 item | Results design use | Request to W2 / coordinator |
|---|---|---|
| `Session.sweep` points (values, solution, mesh, params) | the source of a sweep dataset: `steps` / `points: all` iterate the points; the `si-rib` `neff` table = evaluation group over `sweep_t` -> table -> 1D Global plot vs `t_slab` | keep a stable point shape keyed by study id: `{index, values, label, status, solution, mesh}`; dataset id `"<study>[<i>]"` beside the display label `D = 10 mm (3/5)` |
| Probe table (UI rows, bottom "Table" tab) | computed tables of evaluation groups list in the same tab (one sub-tab per table); probe rows stay UI state (not op-logged) | the row type `{x, y, z?, field, value, unit, dataset}` and the evaluator should become `@amp/post` point evaluation in R1, so probe values and spec point evaluations agree exactly; add "Pin rows": one user op creating a `cutpoint` dataset + a point evaluation group |
| Click pick in Canvas2D / 3D (`onpick`) | reused for "+ Cut Point" and the ends of cut-line drawing | expose `onpick` with a mode (probe vs create) |
| Tree drives the view | "results" and plot-group nodes select the Results mode and the active group | add a `results:plotgroup` case to the tree-to-mode mapping when R2 lands |

### 3.6 Agent exposure

Edits use only the existing `apply_ops` (+ `schema_at` per type), the same ops as the UI.

New tools (the tool list stays small, as `schemas.ts` header asks):

| Tool | Kind | Input | Output |
|---|---|---|---|
| `evaluate` | read | `{node: <evaluation or dataset id>}` or ad hoc `{data, kind, expr, unit, over? / from? to? n?}` | values with units, method, NaN count, measure (length / area), stale flag; ad hoc calls change nothing |
| `get_table` | read | `{table, from_row?, to_row?}` | rows with column units, paged |
| `show_plot` | navigation (UI only) | `{plot: <plot group id>}` | selects and draws it; pair with `screenshot` |
| `export` | side effect (user confirms in the panel) | `{export: <id>}` | file download in the browser; in Node, writes under `logs/` with a timestamped name |

- `get_results_summary` gains spec evaluation values (per group, units, stale flag).
- Task-suite cases (L9 / L8): "add a cut line through the Kirsch hole along x = 0 and report sigma_xx at r = a", "plot V(r) of the coax and the line integral of E".

### 3.7 Performance budgets (all targets; E unless a source is given)

| Item | Target | Basis |
|---|---|---|
| Re-plot after a results-node edit (no re-solve), 2D, kirsch size (10,810 DOF) | < 50 ms input to paint | E; F reference: EO plot requests 2-18 ms first, 1-3 ms repeat (R1 line 236) |
| Same, rib size (328,754 DOF) | < 300 ms | E; refined-lattice cap about 3e5 sub-triangles already applied (Graphics `lv`) |
| Cut line, 500 points, 2D, kirsch size | < 10 ms in the worker | E |
| Surface integral, kirsch size | < 30 ms | E; F reference: EO surface integral 23.5 ms first (R1 line 236) |
| Cut plane / slice, 3D box or cavity meshes (1,232 hex8 / 6,528 tet4, DevLog-011 s.3) | < 50 ms | E; to be measured in R4 |
| Evaluation group over an N-point sweep | <= N x the single-point time + 10 % | E |
| Main thread | 0 long tasks (> 50 ms) while editing or dragging results nodes | existing gate (DevLog-015 header) |
| Retained solutions (sweeps, joins) | byte-bounded LRU, 256 MiB default | E; EO uses 128 MiB (R1 line 93) |
| `LinePlot` bundle | < 15 kB gzip, no plotting dependency | E; lesson from EO Plotly (R1 line 265) |

## 4. Staged plan

Sizes are estimates (E) in new or changed LOC, scaled from the EO sizes in s.1.6. Each stage keeps the gates `pnpm check`, `pnpm test`, the drag and long-task gates, and a browser mesh hash equal to Node.

### R0: schema and contracts (L2 + coordinator)

- Scope: the s.3.2 schema; cross-ref checks; expression vocabulary; migration of the 19 sims (and eval-case-embedded specs); per-node invalidation in the session.
- Files: `packages/spec/src/{schema,validate}.ts`, a new `results.ts`, the JSON Schema export, `sims/*.yaml` (migration), `apps/web/src/lib/post/headline.ts` (reads new evaluation nodes).
- Contracts: C3 (results shape); new **C10 Results model** (node kinds, dataset compatibility, expression vocabulary, value artifacts keyed by node hash + run id).
- Gates:
  - Every sim and eval spec validates.
  - Op round trip (add, edit, remove, revert, replay) for each node type.
  - `schema_at` resolves each type.
  - Old and new kirsch `kt` give the same value.
- Size E: 500-800 LOC + migration.

### R1: engine kernels in `@amp/post` (L4 or a post lane)

- Scope:
  - `expr.ts` (field expressions, components, `d()`).
  - Datasets `solution` (steps), `cutpoint`, `cutline` (2D/3D; uniform and element-crossing), `edge` (2D), `cutplane` (slice moved from apps/web).
  - Evaluations point / global / integral / average / max / min / measure, with the axisym weight.
  - Port `LinePlot` (apps/web, can run in parallel).
- Files: `packages/post/src/{expr,datasets,evaluations}.ts`, `derived.ts`, tests.
- Contracts: C5 note (`@amp/post` API, superseding the `sample` signature text); C8 `extract: {result: "results.<id>"}` (L8).
- Gates (Node, analytic):
  1. Kirsch exact (`sims/kirsch-exact.yaml`, a = 5 mm, L = 50 mm, s_inf = 100 MPa). Cut line x = 0, y from a to L: sigma_xx(0, y) vs the closed form s_inf (1 + a^2/(2y^2) + 3a^4/(2y^4)) (Kirsch 1898, as in `validation/a/gen_solid.py` `kirsch_field`). Report the max abs error over the line and its decrease under h -> h/2.
  2. The same along y = 0: s_inf (1 - 5a^2/(2x^2) + 3a^4/(2x^4)) (equal to 0 at x = a).
  3. Line integral of sigma_xx over the x = 0 cut line vs s_inf [(L - a) + (a^2/2)(1/a - 1/L) + (a^4/2)(1/a^3 - 1/L^3)] = 4.97475e6 N/m. This number comes from the closed form (computed 2026-11-06 with node arithmetic and checked against a 2e5-point midpoint sum).
  4. Edge dataset on `bnd:hole.edge`: sigma_thetatheta = s_inf (1 - 2 cos 2 theta), evaluated through the expression `sxx*sin(th)^2 + syy*cos(th)^2 - 2*sxy*sin(th)*cos(th)` with `th = atan2(y, x)`. Equals 3 s_inf at theta = 90 deg.
  5. Coax (`sims/coax-line.yaml`, V = 1 V terminal on r = a, 0 at b): radial cut line V(r) = ln(b/r)/ln(b/a); `-d(es.V, r)` = 1/(r ln(b/a)); line integral of E_r from a to b = 1 V.
  6. Measure: the kirsch quarter area against L^2 - pi a^2/4, with the error stated as from the polygonal hole.
  7. Node and browser worker give bit-identical values on the same mesh.
- Tolerance rule: each gate passes when the error decreases at the element's expected order between nested levels (`convergence.h_factors`, contract changelog 17:07) and the finest level's error is reported. No absolute tolerance is set before the R1 runs.
- Size E: 1,200-1,800 LOC incl. tests.

### R2: Results tree, 2D and 1D plot groups (web lane after W1 / W2)

- Scope:
  - Tree folders and "+" menus (generic add / delete / duplicate / disable ops).
  - Plot-group rendering for 2D (surface, contour, line, max/min marker, point, arrow surface, deformation and height attributes) and 1D (line graph, point graph, global, table graph).
  - The quick view and "Save as plot group".
  - Drawing a cut line and cut point on the 2D canvas.
  - Agent `show_plot`.
- Files: `apps/web/src/lib/{state/tree.ts, workbench/*, gfx/*, results/*}`, the `LinePlot` port.
- Contracts: C6 post-worker results messages (move to `@amp/spec` types in contracts v2).
- Gates:
  - Screenshots at 1440 and 390 of kirsch (`pg_line`: FE sigma_xx and the exact Kirsch expression overlaid on one 1D plot; absolute units; log toggle).
  - Helmholtz B_z on the axis line graph.
  - The same YAML diff whether a node is created by UI gesture or by agent `apply_ops`.
  - Undo / redo of each.
  - Drag of a cut-line end: 1 op, < 1 s preview.
- Size E: 1,500-2,200 LOC.

### R3: evaluations, tables, export, probe pin

- Scope:
  - Evaluation groups and tables in the bottom Table tab, next to W2's probe table.
  - Pin probe rows.
  - Export data / table CSV, image PNG at a size (uses `capture.ts`), mesh + fields VTU.
  - Agent `evaluate`, `get_table`, `export`.
  - Headlines read evaluation nodes.
- Gates:
  - Kirsch `kt` from the evaluation group equals the headline.
  - CSV round trip (header `name [unit]`, NaN empty, as `toCsv`).
  - Agent task-suite cases s.3.6 pass against R1 values.
  - VTU opens in ParaView (manual check by Wentao, optional).
- Size E: 900-1,300 LOC.

### R4: 3D datasets and plot groups

- Scope:
  - 3D plot group: surface, multiple slices, isosurface, volume with a filter, arrow volume (instanced arrows, APA `ArrowLayer` pattern), 3D streamlines (RK4 in the worker), line (edges), max/min.
  - Datasets cut plane (to a 2D plot group), surface, cut line 3D.
  - Revolution 2D for any axisym field.
  - Mirror 2D/3D with parity in the spec (replaces the hero `MIRROR` table).
- Gates:
  - Box acoustics mode (1,0,0) (Lx = 1.0 m): the normalized cut line along x matches |cos(pi x / Lx)|; the cut plane z = Lz/2 is uniform in y.
  - Cylinder cavity TM010 (a = 2.74 cm): cut plane z = d/2 of normalized E_z vs J0(j01 r / a), j01 the first zero of J0.
  - Revolution of the helmholtz air domain: volume measure = pi Rair^2 (2 Zair).
  - Mirror: an integral over the mirrored kirsch = 4 x the quarter (an exact identity) for even fields.
  - Screenshots.
- Size E: 1,800-2,600 LOC.

### R5: steps, sweeps, comparisons

- Scope:
  - Point graph over time / eigen / sweep steps.
  - Global plot vs a sweep parameter.
  - Evaluation groups over all W2 sweep points.
  - Join (difference between two solutions or two mesh levels; feeds the accuracy view).
  - Probe-style evaluation during transient solves (COMSOL probe analogue), if the runner reports steps.
- Gates:
  - Semi-infinite convection (`sims/semi-infinite-convection.yaml`): point graph T(t) at the case's depths vs the Carslaw-Jaeger erfc solution as in eval case HT-04.
  - Rib `neff` vs `t_slab` table graph equals the per-point values from W2's sweep.
- Size E: 800-1,200 LOC.

### R6: agent hardening

- Scope: results tasks in the L9 / L8 task suite; prompt notes per node type; `get_results_summary` with evaluation values; a memory note pattern for the user's preferred plots.
- Gates: the task suite passes; every agent results op carries a reason; navigation calls are recorded in the trail.
- Size E: 300-500 LOC + cases.

### R7: later (each gated on a physics need)

- Polar plot group and radiation pattern (needs far-field physics).
- Smith (needs S-parameters; APA `SmithChart` port).
- Histogram.
- Grid and parametric curve / surface datasets.
- Sector.
- 2D streamlines for non-T fields.
- Height expression in 3D.
- Principal stress glyphs.
- Volume rendering (GPU ray marching on a resampled grid).
- Animation export (Q5).

Order and dependencies:

- R0 comes first.
- R1 and the `LinePlot` port can start in parallel with R0 (kernels take explicit arguments).
- R2 waits for W1 / W2 to land and for R0.
- R3 and R4 can run in parallel after R2.
- R5 waits for W2's sweep.

## 5. Open questions for Wentao

1. **Schema shape.** Should `results` become a grouped object (`datasets / evaluations / tables / plots / exports`, mirrors the tree, needs a one-pass migration of 19 sims and a C3 change)? Or should it stay a flat typed list (no migration, grouped only in the tree)? Recommendation: grouped object.
2. **Computed values.** Should tables and evaluation values live only in session memory (recomputed from spec + solution, exported on request), or also be persisted (OPFS run store or JSONL under `logs/`)? Recommendation: session only plus explicit export.
3. **1D plots placement.** Should a 1D plot group replace the field view in the one Graphics pane (COMSOL behaviour), or open in a second split so the field and its cut-line graph show together? Recommendation: one pane, with an optional split.
4. **Priority.** Is R0-R3 (2D + 1D + evaluations) before R4 (3D) the right order? And may polar, Smith and far field wait until a physics module produces far fields or S-parameters?
5. **Animation export.** Is MP4 export of step / phase animations in scope (browser encoder; H.264 yuv420p, faststart per your media defaults), or is a later stage fine?

## 6. TODO

- [x] Read current state (spec, post, web, agent, W2 plan)
- [x] Reference model from public docs (COMSOL, ParaView, Ansys, Elmer, FEniCS)
- [x] Read sibling atlases (EO results model, APA plots)
- [x] Design, stages, gates, questions
- [ ] Coordinator: assign R0..R5; relay Q1-Q5
- [ ] Contract requests to the coordinator: C3 results shape, new C10, C6 results messages, C8 `extract` by results id

## 7. Progress

- 2026-11-06 20:50 PST: started; read CLAUDE.md, CONTRACTS-v0, schema, `@amp/post`, workbench, gfx, post worker, tree, agent tools.
- 2026-11-06 20:57 PST: DevLog-020 (W2) appeared; read; s.3.5 aligned with it.
- 2026-11-06 21:00 PST: COMSOL / ParaView / Ansys / Elmer / FEniCS docs read (URLs in s.2, accessed 2026-11-06); Kirsch line-integral and coax values computed from closed forms; DevLog written.

## 8. Contract requests

- C3: the `results` shape per s.3.2 (Q1 decides object vs list).
- New C10 Results model: node kinds, dataset compatibility table, expression vocabulary (components, `d()`), value artifacts keyed by (node hash, run id), honesty rules for plots.
- C6: post-worker `results` messages (eval, dataset, plot data) defined beside C10.
- C8 (L8): `extract: {result: "results.<id>"}` so an eval target can name a spec evaluation.
