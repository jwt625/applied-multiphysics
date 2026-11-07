# DevLog-021: Example library and class-a sims (lane W3)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | W3 (example library + class-a sims) |
| Owns | `apps/web/src/lib/library/**` (except `catalog-bc.ts` contents, lane W4), new `sims/<id>.yaml` for class-a cases, this file |
| Read only | `Workbench.svelte` (W2), gfx files (W1), existing `sims/*.yaml`, `eval/cases/**`, `eval/expected/**`, `packages/*` |
| User feedback | "the example libraries should include more sims, e.g. as many of the eval examples as possible, and classify them by category." |

## 1. Plan (written 2026-11-06 20:54 PST, before coding)

### 1.1 How sims are listed today (read 2026-11-06)
- `apps/web/src/lib/sims.ts`: `import.meta.glob('sims/*.yaml', ?raw)` -> `SIM_IDS` (sorted file ids), `loadSimText(id)`, `DEFAULT_SIM = 'kirsch-plate'`, `HEROES` (6 ids with a Play view).
- `Workbench.svelte` top bar: a plain `<select>` over `SIM_IDS`, `onchange -> goModel(id)`. Route `+page.svelte` reads `?sim=<id>`.
- `apps/web/src/lib/cases.ts`: paired eval case from the `# eval: [ID, ...]` line of a sims file.
- Eval cases point at their spec via the case `spec:` field; 11 class-a cases have a sims file, 18 are `spec: {status: pending, ref: sims/<proposal>.yaml}`.

### 1.2 Library (apps/web/src/lib/library/)
- `catalog.ts`: `CatalogEntry {id, title, category, physics, dimension, evalCases, evalClass, caseStatus, ref, tags, hero}`; categories fixed (8): heat transfer, structural mechanics, electrostatics / magnetostatics, RF / microwave, wave optics / photonics, acoustics, fluids / real-time, coupled. Every existing sims file + the new class-a ones; imports `CATALOG_BC` from `./catalog-bc.ts` (W4 fills it; created empty here). Helpers: `CATEGORIES`, `catalog(available?)` (drops entries whose sims file is absent), `matches(entry, query, filters)`.
- `LibraryPicker.svelte`: button showing the current sim; opens a dense panel: search box, filter chips (category, physics, dimension 2D / axisym / 3D, eval class a / b / c), list grouped by category with counts; row tooltip (`data-tip`) = eval case, reference, status, physics, tags. Keyboard: Escape closes, Enter picks the first match. Svelte 5 callback prop `onpick(id)`. Not mounted in `Workbench.svelte` (W2 owns it); contract in s.3.
- Screenshot check through a temporary route, deleted at the end.

### 1.3 Class-a sims
Engine capability (read `packages/physics/src/registrations.ts`, module headers, `prepare.ts`, `geom/src/spec.ts`):
- heat (2d / axisym / 3d; stationary + transient; T, flux, convection, radiation, source); elastic (2d plane stress / strain, 3d tet; stationary only; fixed, roller on axis-normal boundaries, traction, pressure; thermal strain exists in the solver but is not bound from the spec); electrostatics (2d, axisym); magnetostatics (axisym); em-modes (2d); emw (3d eigen); emw-axisym (eigen); acoustics (eigen only; sound-hard, p = 0).
- 3D geometry in the spec: `box`, `cylinder` only (no extrude / revolve feature).

Decision per pending case (to be confirmed by the runs):
- SM-21 Lame cylinder: runnable (plane stress, pressure, rollers). Quarter annulus instead of the 45 deg sector because `roller` needs an axis-normal boundary; exact by axisymmetry for points A, B, D, F.
- RF-02 WR-90 cutoffs (2D cross-section eigen, 3 gated cutoffs): runnable as an exact scalar analog: TE_mn cutoffs are the Neumann eigenvalues of the cross-section Laplacian, which the acoustics eigen solver computes with sound-hard walls and c = c0 / sqrt(eps_r mu_r). Flagged `analog` in the catalog. S-parameter targets (3D variant, not gated) not covered.
- WO-21 Bragg stack gap edges: runnable as an exact scalar analog at normal incidence (E'' + (n w / c0)^2 E = 0, E and E' continuous = acoustics with uniform rho, c = c0 / n). Zone-edge modes of the mirror-symmetric cell are even / odd about the layer centres, so the two gap edges are the lowest modes of the half cell (half Si + half SiO2) with (sound-hard at the Si centre, p = 0 at the SiO2 centre) and the reverse. Two sims; ratios to w0 computed in the run script. Flagged `analog`.
- Not runnable with the current engine (reason recorded in s.4): AC-03 (driven scattering), CP-02 and CP-21 (thermal strain not bound from the spec; CP-02 also needs axisym or revolved 3D solid), CP-05 (Stokes + electro-osmosis), FL-01 (Navier-Stokes), RF-04 (driven antenna, radiation BC), SC-01 (drift-diffusion / Poisson-Boltzmann), SM-03 (buckling), SM-04 (contact), SM-05 (solid modal; 3D box meshes are hex8, elastic is tet only), SM-06 (plate modal), SM-07 (plasticity), SM-22 (3D elliptic plate needs extrude of a 2D section), TR-01 (advection-reaction), WO-03 (driven 3D scattering).
- Run: scratch script on the harness API (`loadCaseFile` + `EngineSource` + `runCase`) with the case's `spec` replaced in memory by the new sims path and, where a target has no `extract`, an in-memory extract (probe / eigen) stated per target in s.4. No case file is edited. Existing class-a sims run through the CLI unchanged.

## 2. TODO
- [x] catalog.ts + catalog-bc.ts
- [x] LibraryPicker.svelte
- [x] sims: lame-cylinder, wr90-te-cutoffs, bragg-edge-lower, bragg-edge-upper
- [x] validate each new sim with @amp/spec, run, compare with eval/expected
- [x] class-a baseline run (CLI, class a); class-c cases of existing sims (EM-02, EM-03, RF-01)
- [x] screenshot the picker (temporary route `w3-library-demo`, deleted 2026-11-06 21:05)
- [x] new sims computed in the workbench (dev server, `?sim=<id>`, Compute): all four solve, no page errors
- [x] pnpm check (0 errors, 0 warnings in library files), pnpm test (all packages pass)
- [x] stop servers (port 5287 free)
- [ ] coordinator: mount LibraryPicker in the workbench top bar (s.3)
- [ ] case lane: move the in-memory spec / extract mapping of s.4.2 into eval/cases/a/SM-21.yaml and RF-02.yaml

## 3. Picker contract

Files: `apps/web/src/lib/library/{catalog.ts, catalog-bc.ts, LibraryPicker.svelte}`.

`LibraryPicker.svelte` (Svelte 5 props; no events, a callback prop):

| prop | type | default | meaning |
|---|---|---|---|
| `onpick` | `(id: string) => void` | required | called with the picked sims id; the host loads it (Workbench: `goModel(id)`); the popover closes itself |
| `current` | `string` | `''` | open model id: highlighted row, trigger label (category + title, tooltip = entry tip) |
| `available` | `readonly string[]` | `SIM_IDS` (sims.ts) | sims files that exist; catalog entries without a file are hidden; files without an entry are listed under "Other" (so W4 files appear before W4 adds entries) |
| `entries` | `readonly CatalogEntry[]` | `CATALOG` | catalog to show (CATALOG_A + CATALOG_BC, first entry per id wins) |
| `inline` | `boolean` | `false` | panel only, always open, fills its container (for a library page / pane) |
| `open` | `boolean` (bindable) | `false` | popover state |

Behaviour: search (every word must match id, title, category label, physics, eval case id, tag or analog note; case-insensitive); filter chips: 8 categories, dimension 2D / axisym / 3D, eval class a / b / c (multi-select, OR within a group, AND across groups); physics select; Clear. Rows: run-status square (pass green, fail / error red, pending amber, info blue, not run hollow), id, title, physics, dimension, eval cases, flags `P` (Play view) and `A` (analog). Row tooltip (`data-tip`, shown by `ui/Tip.svelte`, which the host must mount; Workbench already does): sims file, eval case + class + case status, reference status / targets / date / how run, note, log path, physics, analog, tags. Keyboard: Up / Down, Enter picks, Escape closes; click outside closes. Group headers are sticky per group. Width min(720 px, 100vw - 16 px); below 640 px the title / physics / case columns hide.

Mounting suggestion for W2 / coordinator (Workbench.svelte top bar, replacing or next to the `<select>`):

```svelte
import LibraryPicker from '../library/LibraryPicker.svelte';
<LibraryPicker current={simId} onpick={goModel} />
```

`catalog.ts` exports: types `Category`, `Dim`, `EvalClass`, `RefStatus`, `RefInfo`, `CatalogEntry`, `Filters`; `CATEGORIES` (id, label, tip; fixed order), `CATALOG_A` (this lane), `CATALOG` (A + BC, deduplicated), `matches(entry, query, filters)`, `libraryFor(available, entries)`, `entryTip(entry)`. `catalog-bc.ts` exports `CATALOG_BC: CatalogEntry[]` (W4; created empty with a header comment). `ref` holds run outcomes only (status, targets count, date, via, repo-relative log), no physical values.

## 4. Class-a table

### 4.1 All 29 class-a cases (engine runs 2026-11-06)

Logs: `logs/W3-eval-class-a-20261106T205440.log` (+ `logs/eval-20261106T205440.jsonl`, CLI, unchanged cases), `logs/W3-run-new-20261106T205928.log` (SM-21, RF-02 via the harness API, s.4.2), `logs/W3-run-bragg-20261106T205736.log` (WO-21, direct engine), `logs/W3-eval-c-20261106T205756.log` (EM-02, EM-03, RF-01).

| case | sims | result vs eval/expected | note |
|---|---|---|---|
| AC-02 | box-acoustics | pass 10/10 | existing |
| AC-03 | none | not runnable | driven scattering (acoustics is eigen only; no incident field, no radiation BC) |
| CP-02 | none | not runnable | thermal strain not bound from the spec (solver has it); needs axisym elastic or revolved 3D solid |
| CP-05 | none | not runnable | Stokes + electro-osmosis (no fluid module) |
| CP-21 | none | not runnable | thermal strain not bound from the spec (elastic `elasticProblemFromContext` sets no `thermal`) |
| EM-01 | coax-line | pass 3/3 | existing |
| EM-04 | helmholtz-em04 | pass 3/3 gated, 2 pending | existing |
| FL-01 | none | not runnable | Navier-Stokes / Stokes (no fluid module) |
| HT-01 | nafems-t4 | pass 1/1 (+1 info) | existing |
| HT-02 | nafems-t3 | pass 1/1 (+1 info) | existing |
| HT-03 | nafems-t2 | pass 1/1 (+1 info) | existing |
| HT-04 | semi-infinite-convection | pass 4/4 | existing |
| RF-02 | wr90-te-cutoffs (new) | pass 3/3 gated (fc_TE10, fc_TE20, fc_TE01); S21 / S11 (non-gated, 3D variant) pending | scalar analog (acoustics, c = c0); harness API with in-memory spec + extracts |
| RF-04 | none | not runnable | driven antenna (gap source, radiation BC) |
| RF-21 | cylinder-cavity-axisym (+ cylinder-cavity-qd) | pass 6/6 (+ Q_dielectric info) | existing |
| SC-01 | none | not runnable | semiconductor drift-diffusion / nonlinear Poisson |
| SM-01 | kirsch-exact | pass 5/5 | existing |
| SM-02 | nafems-le1 | pass 1/1 | existing |
| SM-03 | none | not runnable | linear buckling eigenproblem (elastic is stationary only) |
| SM-04 | none | not runnable | contact |
| SM-05 | none | not runnable | solid modal; also 3D box meshes are hex8, elastic 3D is tet4 / tet10 |
| SM-06 | none | not runnable | plate modal (no plate / shell or solid modal) |
| SM-07 | none | not runnable | plasticity |
| SM-21 | lame-cylinder (new) | pass 7/7 | harness API with in-memory spec + probe extracts; finest level 43534 DOF |
| SM-22 | none | not runnable | 3D thick elliptic plate: spec 3D geometry has only box / cylinder (no extrude of a 2D section) |
| TR-01 | none | not runnable | advection-diffusion-reaction (heat has no advection or linear reaction term) |
| WO-01 | si-slab-te0, si-slab-tm0 | pass 2/2 | existing |
| WO-03 | none | not runnable | driven 3D scattering (emw is eigen only) |
| WO-21 | bragg-edge-lower + bragg-edge-upper (new) | pass 3/3 (direct engine): relative error at the finest level 1.6e-11 (lower), 9.2e-10 (upper), 1.5e-9 (gap / midgap); tolerance 1e-6; observed order 3.98-3.99 | scalar analog (acoustics, c = c0 / n, uniform rho); ratios computed in the script; not on the harness (two specs per target) |

Totals: 14 of 29 class-a cases run and pass (11 existing + SM-21, RF-02, WO-21 new); 15 not runnable with the current engine.

### 4.2 Run mapping for the new sims (in memory; no case file edited)
- SM-21: `spec: sims/lame-cylinder.yaml`; extracts `probe` of `u` (component 0 or 1) at A (0.1, 0), B (0.2, 0), D (0.2 cos 22.5 deg, 0.2 sin 22.5 deg), F (0.2 cos 45 deg, 0.2 sin 45 deg); `sxx`, `syy` at A; target unit `length` read as `m` (the harness cannot convert `length`). Points D, F are mesh vertices through the embedded rays `ray_D`, `ray_F` (a point on the curved edge between vertices lies outside the straight-edged mesh and samples NaN; first runs failed DX_D / DX_F for that reason). `SIYY_A` needed the bore refinement h = (b - a)/160 (with h = (b - a)/40: 100.52 MPa, rel. 5e-3 > 1e-3).
- RF-02: `spec: sims/wr90-te-cutoffs.yaml`; extracts `{kind: eigen, floor: 1e6, index: 0 | 1 | 2}` for fc_TE10, fc_TE20, fc_TE01 (floor drops the f = 0 Neumann null mode).
- WO-21: harness has no target that combines two specs; `run-bragg` script runs both half cells at hFactor 1, 0.5, 0.25 (prepareRun + acoustics module) and forms f / f0 (f0 = c0 / lambda0) and (upper - lower) / mean.

### 4.3 Analog sims
`wr90-te-cutoffs`, `bragg-edge-lower`, `bragg-edge-upper` solve the stated equation exactly but through the acoustics module (field `p`, unit Pa, stands for H_z or E). They carry `analog` in the catalog (flag `A`, tooltip) and the header comment of each file. If the coordinator prefers no analogs in the library, drop the three entries; the sims files stand alone.

## 5. Progress log
- 2026-11-06 20:54 PST plan written; class-a baseline run started (CLI, `--class a`): 11 pass, 18 pending (spec pending), 0 fail.
- 2026-11-06 20:56 PST sims/lame-cylinder.yaml, sims/wr90-te-cutoffs.yaml, sims/bragg-edge-{lower,upper}.yaml written; all validate with @amp/spec (physicsRegistry).
- 2026-11-06 20:57 PST WO-21 half cells: both edges and gap / midgap within 2e-9 of eval/expected (s.4.1). Class-c EM-02 pass, EM-03 pass, RF-01 pending (Q targets).
- 2026-11-06 20:59 PST SM-21 pass 7/7 after the rays at D, F and the bore refinement; RF-02 pass 3/3 gated.
- 2026-11-06 21:01 PST catalog.ts (24 entries), catalog-bc.ts (empty, W4), LibraryPicker.svelte; screenshots through the temporary route at 900 x 720 and 390 x 760 (no horizontal scroll, no page errors); fixed stacked sticky group headers (one wrapper per group).
- 2026-11-06 21:02 PST four new sims computed in the workbench (`?sim=<id>`, Compute): solved, no page errors; bragg sims showed the second mode (results `step: 1`), changed to `step: 0` (band-edge mode; 0-based like box-acoustics) and re-checked: upper edge 2.46e14 Hz.
- 2026-11-06 21:03 PST `pnpm check`: 0 errors (svelte-check 1411 files); no warnings in library files. `pnpm test`: all packages pass (rt 16, core 81, spec 53, materials 21, geom 37, eval 78, mesh 14, physics 44, post 4, agent 61, web 10).
- 2026-11-06 21:05 PST dev server on 5287 stopped; temporary route deleted.
