# DevLog-011: Web workbench and Play views (lane L5, `apps/web`)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L5 (DevLog-001 section 9) |
| Owns | `apps/web/**`, this file |
| Inputs | DevLog-001 A4, A10, A11, A13, Q6, Q8, performance targets, s.6 guidelines; CONTRACTS-v0 (C1-C7, C9, changelog); DevLog-002, DevLog-003; R1 s.5; R2 s.6; R4 s.5; R5 s.2, 4, 5 |
| Consumes (read only) | `@amp/spec` (L2, done), `@amp/geom` + `@amp/mesh` (L3, in progress), `@amp/physics` + `@amp/post` (L4, in progress), `@amp/rt` (L6, in progress) |
| Sources ported (read only) | EO `eo-modulator-atlas` at `0546007`: `app/src/lib/sim/renderer.ts` (WebGL2 layered field renderer), `refined.ts` + `engine/src/postproc` refine pattern (lattice), service worker and shell pattern (DevLog-046). APA `advanced-packaging-atlas` at `fe39985`: `app/src/lib/sim/graphics/FieldLayer.ts` (three.js field material), `app/src/lib/sim/post.ts` (marching-tet isosurface kernel) |

## 1. Plan (written 2026-11-06 15:51 PST, before coding)

### 1.1 Stack (exact pins)

| Package | Version | Why |
|---|---|---|
| `@sveltejs/kit` | 3.0.0 | same as EO/APA (proven with the static shell pattern) |
| `@sveltejs/adapter-static` | 4.0.0 | static build for Cloudflare Pages (A13) |
| `@sveltejs/vite-plugin-svelte` | 7.3.1 | EO/APA |
| `svelte` | 5.57.1 | runes |
| `svelte-check` | 4.7.6 | `pnpm check` |
| `vite` | 8.3.2 | EO/APA |
| `typescript` | 5.9.3 | root pin |
| `three` | 0.187.0 | A10 (r187 WebGLRenderer) |
| `playwright-core` | 1.63.0 | verification screenshots (EO's pin; corrected from 1.65.0, audit S12); uses the local Chromium in `~/Library/Caches/ms-playwright` |

Engine packages are `link:` dependencies (`../../packages/*`). Install with `pnpm install --ignore-workspace` inside `apps/web` so the root lockfile (coordinator) is not touched (same as L3).

### 1.2 Routes and loading (A13, first paint < 100 ms)

| Route | Content |
|---|---|
| `/` | Workbench. Query: `sim=<id>` (default `kirsch-plate`). Shell paints with the final grid tracks, workbench code is dynamic-imported after mount, with `modulepreload` links from the client manifest (EO DevLog-046) |
| `/play/<sim-id>` | Play view per hero (prerendered for the six `sims/*.yaml`) |
| `/play/rt/<kernel>` | Real-time GPU panel embedding `@amp/rt` kernels once exported (prerendered for `lbm-d2q9`, `fdtd-tmz`, `gray-scott`) |

- `static/_headers`: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff`, immutable cache for `/_app/immutable/*`. All assets self-hosted (no CDN, no web fonts).
- Service worker (`src/service-worker/index.ts`, EO pattern): one cache per deploy, pages precached, hashed code stored on first use, previous cache kept for one deploy.
- Inline CSS (`inlineStyleThreshold`), system fonts.

### 1.3 State and the operation log (A4)

- One `ModelState` (runes class) per open model: `OpLog` from `@amp/spec` (`createOpLog(text, {registry})`), parsed spec, issues with line/col, params map. The YAML text is only ever changed by `log.apply/undo/redo/revert`; every form edit, slider, drag, YAML-tab edit goes through it with `actor: 'user'`.
- YAML tab edits: the edited text is parsed; the diff to the current data becomes an RFC 6902 patch (minimal per-leaf replace/add/remove), applied with `log.apply` (splice). If the text does not parse, it stays as a draft with the parse error and nothing is applied. If the spliced text differs from the typed text (formatting only), the log text wins and the difference is reported.
- Drags coalesce: during a drag the preview spec is local (not logged); on release one op is appended. Coarse re-solves during the drag run on the preview text with a coarse mesh option.
- Timeline panel: rows `ts | seq | kind | actor | reason`, diff on expand (patch ops, old -> new values, invalidated artifacts, validation), per-op revert, undo/redo buttons and `Ctrl/Cmd+Z`, `Shift+Ctrl/Cmd+Z`. Export JSONL.

### 1.4 Workbench layout (COMSOL-grade, s.6)

Toolbar (model picker, Build mesh, Compute, Cancel, Undo, Redo, Share) / [Model Builder tree | Settings (Form / YAML tabs) | Graphics] / bottom tabs Messages, Log, Progress, Timeline. Pointer + keyboard splitters, sizes persisted (try/catch). CSS grid with `minmax(0, 1fr)` tracks: every panel scrolls internally, the canvas never resizes because of content. <= 760 px: single column with a panel switcher.

- Tree generated from the spec: Parameters, Geometry (features in order), Materials, Physics (each with its BCs), Couplings, Mesh, Studies, Results; plus Provenance, Assumptions, Missing when present. Issue markers on nodes with validation issues (count in tooltip).
- Settings forms generated from the registry's JSON Schema (`specJsonSchema`): walk `properties`, `oneOf` (discriminated by `type.const`), `$ref`; widgets: quantity (`x-amp-quantity`: value + unit, or expression text), selection (`x-amp-selection`: id chips), enum (select), boolean, number/integer, string. Unknown shapes fall back to a YAML snippet editor of that subtree (still one op).
- Graphics modes Geometry / Mesh / Results, single keys `G`, `M`, `R`; `W` wireframe, `F` zoom extents, `Space` play/pause animation (when a step or phase exists).
- Messages: validation issues and readiness; Log: timestamped rows (ISO time first); Progress: stage bars from the worker.

### 1.5 Viewer

- 2D: port of the EO `GlRenderer` (surface, contour, region layers; wireframe from barycentrics; 256-entry LUT; linear/log/symlog). Changes: SI metres with a float32 origin, perceptual colormaps only, no Canvas 2D fallback in v0 (recorded as a limit). Refined-lattice smoothing: element-local barycentric lattice of level r (default 3) evaluated exactly from the P1/P2 basis (H1P1/H1P2 fields), DG0 drawn flat.
- Hover probe: a post worker holds the display mesh and fields; the main thread sends (x, y), the worker locates the element (uniform bucket grid) and evaluates the FE basis exactly, returning x, y, value, unit and expression (field name). Coalesced to one request in flight.
- 3D: three.js r187 `WebGLRenderer`. Field material: first test `WebGLNodesHandler` with a TSL material needing a custom per-vertex attribute (value), a LUT texture, a deformation attribute and clipping planes; if any fails, one GLSL `ShaderMaterial` (APA FieldLayer pattern). Evidence recorded in s.4.
- 3D post in the worker: exterior boundary faces of tet4/hex8/prism6 meshes, plane slices (marching tets on the signed distance, field interpolated), isosurfaces (APA marching-tet kernel generalized from the hex grid to C2 cells: tet4 direct, hex8 split into 6 tets, prism6 into 3), deformation `p + s u` in the vertex shader with `s` defaulting to 10 % of the bounding-box diagonal over max |u| (shown and editable), animation of eigen phase (`Re(u e^{i phi})` for real modes = `u cos(phi)`) or time steps.
- Colorbar: absolute units, nice ticks, 3 significant figures; colormaps viridis, cividis, inferno (sequential), balance (diverging, cmocean) for signed fields. LUT data generated from the published tables with a NOTICE (viridis/cividis/inferno CC0 from BIDS mpl-colormaps via matplotlib; balance from cmocean MIT, the table already in `@amp/rt/src/colormaps.ts`).
- Mesh mode colours elements by mesh quality (shape q = 4 sqrt(3) A / sum l^2 for triangles; a real mesh diagnostic, not physics); Geometry mode colours domains.

### 1.6 Worker runner (C6)

- `runner.worker.ts`: `{type:'run', id, specText, options}` -> parse (`parseSpecText`, wave-1 registry plus `@amp/physics` registrations when exported) -> geometry + mesh (`@amp/geom`, `@amp/mesh`; L4's `prepareRun` when exported, otherwise a thin local spec adapter for the 2D features rect/circle/polygon/union/difference and the 3D box/cylinder) -> physics module from `@amp/physics` `modules` by type (detected with `import.meta.glob` so the build works before L4 exports exist) -> `result` with transferred typed arrays.
- Additions (proposed in s.5): `{type:'mesh', id, mesh, ts}` after meshing (display before solve) and `{type:'unavailable', id, reasons, ts}` when no module exists. `cancel` aborts through the `AbortSignal`, and terminates the worker if the module does not return within 500 ms.
- Results unavailable is shown as such in the Results mode and the tree (grey, tooltip with reasons), never green.

### 1.7 Play view (Q8)

Large canvas, at most about 5 sliders (with exact fields and units) bound to spec params with a `range`, or to the params the hero's Play config lists. Drag handles where the geometry allows (kirsch-plate: hole radius ring handle -> `params.D`; helmholtz-coil: coil spacing; heat-plate-fin: none until fins exist). Presets (named param sets, applied as one op each). Share-by-URL: `#d=` base64url of the JSON patch list from the sim's original spec (the spec diff); loading replays it as ops. Coarse re-solve on drag (mesh `hmax` x 2 option), target < 1 s, measured and shown in the corner.

### 1.8 Real-time GPU panel

`/play/rt/<kernel>`: when `@amp/rt` exports `LbmD2Q9`, `FdtdTMz`, `GrayScott` and its renderer, embed them in the Play layout with sliders for their params; otherwise show "not available: @amp/rt not exported" and the WebGPU probe result.

### 1.9 Gates

1. `pnpm check` clean, `pnpm build` clean.
2. Playwright-core headless Chromium screenshots of the workbench and every Play view at 1440x900 and 390x844; inspected; layout problems fixed; one final screenshot per view kept in `logs/`.
3. First paint (FCP from `performance.getEntriesByType('paint')`) of `/` and `/play/kirsch-plate` from the built site on a static server with the `_headers` applied, median of 5 loads, target < 100 ms; tab-switch time (pointer click to the next frame after the new panel renders), target < 100 ms.
4. Oplog round trip in the UI: 20 form edits then 20 undos give the original text byte for byte (automated in the playwright script).
5. Coarse re-solve on drag: time from slider input to the repainted mesh (and field when a module exists), reported.
6. Unit tests (`node --test`) of the pure TS modules: patch-from-diff, lattice refine, point location + P1/P2 probe, marching tets (sphere isosurface area of a linear-in-r field against 4 pi r^2 within the discretization error), slice.

## 2. TODO

- [x] Scaffold: package.json, vite config, tsconfig, app.html, app.css tokens, `_headers`, service worker; install
- [x] Shell routes `/`, `/play/[sim]`, `/play/rt/[kernel]` with lazy load and modulepreload
- [x] Colormap LUTs + NOTICE
- [x] ModelState over OpLog; patch-from-diff; YAML tab; oplog v1 coalescing (coordinator 16:15); refused reverts shown
- [x] Model Builder tree; schema-driven Settings forms; materials rows from @amp/materials (coordinator 16:25)
- [x] Splitters, layout, bottom tabs (Messages, Log, Progress, Timeline, Navigation)
- [x] Worker runner (C6); @amp/physics prepareRun + modules (L4 landed during the run); `meshFromSpec` for previews; local adapter only for coarse drag meshes
- [x] 2D renderer port; refined lattice; post worker hover probe
- [x] 3D viewer: TSL field material via WebGLNodesHandler, exterior faces, section, slices, isosurfaces, deformation (code path, no 3D displacement hero yet), eigen phase / step animation
- [x] Colorbar (absolute units, percentile option)
- [x] Play view: sliders, drag handles, presets, share URL, coarse re-solve timing
- [x] RT panel (L6 kernels, coordinator 16:00)
- [x] Navigation host + trail and reserved agent column (L9, coordinator 16:20)
- [x] Unit tests (6/6)
- [x] Playwright screenshots, inspect, fix; timings
- [x] `pnpm check`, `pnpm build`
- [x] Hand-off
- [x] Fresh-context audit (coordinator) and its corrections (s.7)

## 3. Progress log

- 2026-11-06 15:51 PST: read inputs (CLAUDE.md, DevLog-001/002/003/004/005/010, CONTRACTS-v0, R1 s.5, R2 s.6, R4 s.5, R5 s.2/4/5), EO renderer/shell/service worker, APA FieldLayer and marching-tet kernel. State of dependencies: `@amp/spec` done (oplog, splice, JSON Schema with `x-amp-quantity` / `x-amp-selection` metadata); `@amp/geom` 2D model done, `@amp/mesh` in progress (mesh2d, boxgrid, extrude, cylinder present); `@amp/physics` has `src/common` only (no index, no modules); `@amp/post` empty; `@amp/rt` index present, kernels in progress. Plan written.
- 2026-11-06 15:52 PST: `pnpm install --ignore-workspace` in apps/web (writes `apps/web/pnpm-lock.yaml`). The root `pnpm-lock.yaml` has a 15:52:22 mtime and now lists an `apps/web` importer. Two later `--ignore-workspace` installs (adding `@webgpu/types` and `@amp/materials`) left the root lockfile byte-identical (checked with `diff` against a copy), so the 15:52 rewrite was most likely a concurrent root install by another lane that picked up the new `apps/web/package.json` (apps/* is a workspace member); cause not confirmed. Reported in s.5.
- 2026-11-06 16:00 PST: spec adapter meshes all six sims through `@amp/geom`/`@amp/mesh` (kirsch 2635 tri3 in 23 ms, si-rib 46971 tri3 in 65 ms, cylinder 6528 tet4 in 10 ms, box 1232 hex8 in 7 ms; Node, first run). Post kernels, diff/patch, schema walker tested (`node --test`, 6/6).
- 2026-11-06 16:08 PST: TSL probe done (s.4.1).
- 2026-11-06 16:00-16:20 PST: coordinator notes applied: L6 done (RT panel from `packages/rt/demo` definitions, LBM forces labelled not validated); `amp-oplog/1` (every drag and Settings slider is one coalesced op, gesture-scoped; refused reverts listed with the reason; per-op effect shown); L9 started (NavigationHost implemented structurally, Navigation tab, reserved Agent column, agent ops already in the Timeline with actor, reason, revert); materials done (materials/*.yaml via `import.meta.glob`, parsed with `parseMaterialText`, provenance in tooltips, N/A as unavailable).
- 2026-11-06 16:20 PST: `pnpm check` 0 errors 0 warnings; first build; first screenshot pass. Found and fixed: degenerate colour range on uniform hex quality (float noise stretched over the map), colorbar overlapping the canvas, hidden coils / hole in Play (added per-hero focus box and geometry outlines), handles under the colorbar, text selection during drags, slider and handle drags merging into one op across gestures.
- 2026-11-06 16:25 PST: @amp/physics exported (index, prepareRun, 7 modules, `physicsRegistry`). Wired: registry from `physicsRegistry()`, `prepareRun({spec, physicsId, hFactor, signal, case})`, `@amp/materials/node` aliased to a browser shim that serves the same documents. The heroes' material values are N/A in sims/, so Compute passes the paired eval case (SM-01, HT-01, EM-04, WO-02, RF-21, AC-02) whose `materials` block carries sourced values; the toolbar shows which case and its sources, and it can be switched off.
- 2026-11-06 16:28 PST: a screenshot showed NED2 (cavity E) data drawn as if nodal: wrong. Fixed: only H1P1/H1P2/DG0 fields are drawn; other spaces show "no display yet" with the reason. Also: 3D wireframe visibility kept across surface rebuilds, 3D fit uses the narrower field of view and an 80 px colorbar offset, Play opens in Results with a 1st-99th percentile colour range (area weighted in 2D) that the colorbar labels.
- 2026-11-06 16:37 PST: final check/test/build/screenshot run; 24 screenshots kept in `logs/`.

## 4. Results

### 4.1 TSL on WebGLRenderer (three r187, `WebGLNodesHandler`)

Probe: `apps/web/test/tsl-probe/` (stand-alone Vite build, not part of the app), headless Chromium (chrome-headless-shell 1234, ANGLE SwiftShader), read-back pixels of a known quad. Log `logs/L5-tsl-probe-20261106T160805.log`.

| Feature needed by the field material | Result |
|---|---|
| custom float attribute (`attribute('value')`) mapped by uniforms into a 256x1 LUT `DataTexture` | works; the LUT needs `colorSpace = SRGBColorSpace` (otherwise the output transform brightens it: 16 -> 71 in 8 bit) |
| custom vec3 attribute (`disp`) times a uniform in `positionNode` | works |
| `material.clippingPlanes` (with `localClippingEnabled`) | **does not clip** under the handler |
| `renderer.clippingPlanes` | **does not clip** under the handler |
| manual clip: `If(dot(positionWorld, n) > d, Discard())` in `colorNode` | works |
| bundle, probe page (three core + nodes + TSL, minified, gzip -9) | 211,869 B |

Decision: the field material is written in TSL and runs through `WebGLNodesHandler`; clipping uses the manual `Discard` node, not three's clipping planes.


### 4.2 Gates (rerun after the audit fixes, I1 sims edits and L3 detmath; `logs/L5-shots-20261107T011938.json`, tests `logs/L5-test-20261106T171927.log`, production build `logs/L5-build-20261106T172122.log`)

Machine and browsers as before: M4 Pro shared with other lanes; chrome-headless-shell 151.0.7922.34 (SwiftShader WebGL) for the workbench and Play; Google Chrome 156.0.8078.80 headless with WebGPU for RT. The static build is served by `scripts/shots.ts` on 127.0.0.1:47391 with the headers parsed from `build/_headers` (port checked free, closed at exit). The verification build sets `VITE_AMP_HOOKS=1`; the production build has no `__amp*` hooks (grep: 0 files).

| Gate | Result |
|---|---|
| `pnpm check` | 0 errors, 0 warnings, 1132 files |
| `pnpm build` | ok; 10 prerendered pages (`/`, 6 hero Play views, 3 RT); CSP meta with the bootstrap hash on every page |
| `pnpm test` | 6/6 |
| First paint (FCP), 5 fresh loads | `/` 37.5 ms median (first cold load 464 ms), `/play/kirsch-plate` 37.5 ms, `/play/rt/lbm-d2q9` 35.6 ms |
| Tab switch (click to next frame) / mode switch | 15.6-16.3 ms / 18.2 ms median, 29.5 ms max |
| Op log round trip through the Settings form | 20 edits + 20 Undo clicks: byte-identical (3304 B) |
| **B1** Helmholtz Play, exact field I 1 A -> 2 A | W_m 7.38915e-7 J -> 2.95566e-6 J, ratio 4 (to 1e-9); Undo restores 7.38915e-7 J; result fresh after each |
| **B2** workbench 390 px, log pane open | all 4 pane-switcher buttons are the element under their own centre |
| **S3** browser mesh hash = Node `prepareRun` mesh hash for the same spec text | 6/6 heroes equal (kirsch `f3b9575e`, 2647 tri6; heat `454090a7`; helmholtz `f2bad9a3`; rib `6b1bc947`; cavity `caf0e859`; box `272246fc`) |
| Play load to fresh result | kirsch 216 ms (10,810 DOF), heat 226 ms (15,339), helmholtz 232 ms (14,645), box 221 ms (693), cavity 2,668 ms (14,882), rib 3,804 ms (328,754) |
| Drag gestures (12 slider steps, 10 handle moves) | 1 op each (`coalesced` 13 / 11); fresh full result after release in all six |
| Coarse preview during drags (input to result, sizes x2) | kirsch 42 ms median (100 max), heat 29 (45), helmholtz 43 (75), box 17 (24), rib 330 (696), cavity 396 (402). Target < 1 s: pass |
| Main-thread long tasks during the 12-step drags | 0 in all six (before the fixes: box 18-26 tasks of 58-141 ms, cavity 14) |
| Long tasks at load | one per view, 71-139 ms (first TSL/GLSL compile and first upload) |
| Page and console errors | none |

### 4.3 Bundles (gzip -9)

Production build: `index.html` 24 kB with inline CSS and CSP meta. Unchanged structure: workbench code preloaded by the shell, three.js chunk only for 3D models, runner worker with the engine packages.

### 4.4 Screenshots kept (`logs/`, timestamp 20261107T011938, one per view)

Workbench: `L5-workbench-kirsch-plate-results-1440`, `-kirsch-plate-390`, `-kirsch-plate-log-390` (B2), `-box-acoustics-slice-iso-1440`, `-box-acoustics-section-anim-1440`, `-box-acoustics-390`, `-timeline-1440` (agent row). Play: `L5-play-<hero>-{1440,390}`. RT: `L5-rt-<kernel>-{1440,390}`. Inspected: kirsch K_t headline 3.021 with the peak marker 3.02 MPa at the hole top; helmholtz B_center 8.983 uT with field lines (r A_phi contours) around the coils; heat T_E 18.25 degC; box 171.5 Hz (1,0,0) mode normalized with planar isosurfaces; cavity TM010 2.904 GHz from `E_nodal` (L4's H1 projection), maximum on the axis; rib mode 0 normalized |E|, DG0 cell values (no contours on DG0); RT panels start paused with a hint.

### 4.5 Known limits

- No Canvas 2D fallback; WebGPU required for the RT panels.
- 3D deformation implemented but not visually verified (no 3D displacement hero).
- Nedelec `E` fields still have no display of their own; the cavity view uses L4's `E_nodal` projection.
- `_headers` and CSP exercised on the local server only, not on Cloudflare Pages. zod probes `new Function` once and falls back under the CSP (no console error was recorded).
- `set_camera` supports `fit` only; `screenshot` returns the graphics canvas.
- Module scalars (`mises_max`, `T_max`, ...) are listed in SI with display symbols; the spec's own results (headlines) are in their spec units.
- Verification in software WebGL; GPU timings in a real browser not measured.

## 5. Contract requests

1. **C6 (coordinator)**: add the worker messages `{type:'mesh', id, mesh, ms, source, ts}` (mesh before the solve) and `{type:'unavailable', id, reasons, ts}` (no module, not ready, or the module cannot run with its inputs); `options` keys `meshScale`, `meshOnly`, `case` (`apps/web/src/lib/engine/protocol.ts`).
2. **Root lockfile (coordinator)**: `pnpm-lock.yaml` now lists the `apps/web` importer (s.3, 15:52). Either keep it (apps/* is a workspace member; a root `pnpm install` will keep it in sync with `apps/web/package.json`) or decide on per-package `--ignore-workspace` installs; `apps/web/pnpm-lock.yaml` exists as well.
3. **C1 (coordinator)**: runtime dependency `three` 0.187.0 in `apps/web` (A10). Dev: SvelteKit 3.0.0, adapter-static 4.0.0, vite-plugin-svelte 7.3.1, svelte 5.57.1, svelte-check 4.7.6, vite 8.3.2, `@types/three` 0.187.0, `@webgpu/types` 0.1.74, playwright-core 1.63.0 (exact pins).
4. **L4**: (a) [done by L4: `E_nodal` is drawn for the cavity] an H1 (nodal) projection of Nedelec fields (`E` of emw and em-modes) in the Solution, or Nedelec evaluation in `@amp/post`, so the viewer can draw them; (b) `prepareRun` uses `@amp/materials/node` (fs); please accept an injected library (`prepareRun({..., library})`) so the browser does not need the alias in `apps/web/vite.config.ts`; (c) [obsolete: the rib now carries its own n values] case key mismatch for the rib; (d) eigenmode amplitudes carry the field unit (Pa, V/m) though their scale is a normalization: state the normalization in the Solution (e.g. `steps.normalization`).
5. **L2 / sims owner**: the six heroes have their material values N/A (`missing` entries); the browser can only solve them with the paired eval case's values. A `sims`-level reference to the case (e.g. `provenance` or a `validation: {case: SM-01}` key) would replace the `SIM_CASE` table in `apps/web/src/lib/cases.ts`. The kirsch `missing` text still says `materials/` is empty (it is not since DevLog-013).
6. **L9**: `@amp/agent` has no `src/index.ts` yet; the workbench implements `NavigationHost` structurally (`apps/web/src/lib/state/nav.svelte.ts`, exposed as `window.__ampWorkbench.nav(actor)`) and will import the interface once it is exported. The Agent column is reserved (300 px, toggled in the toolbar).
7. **C9 (coordinator)**: confirms L6's optional members are sufficient for the RT panel; no change needed.

## 6. Hand-off

State (2026-11-06 17:21 PST, after the audit corrections in s.7): workbench, six hero Play views and three RT panels build, check and run; all six heroes solve in the browser with fresh, hash-tagged results; all gates in s.4.2 pass. Production builds carry no `window.__amp*` hooks; verification builds use `VITE_AMP_HOOKS=1 pnpm build`. The L9 chat panel is not mounted (waiting for DevLog-012 notes); `ModelState.applyAgent` and `window.__ampWorkbench.nav(actor)` (dev/verification builds) are ready for it.

Run (from `apps/web`, Node 23, pnpm 10):

```
pnpm install --ignore-workspace      # link: deps to packages/*
pnpm check && pnpm test && pnpm build
node --max-old-space-size=1536 scripts/shots.ts <outDir> 47391   # serves build/, screenshots + timings -> logs/L5-shots-<ts>.json
```

Layout (`apps/web/src`):

| Path | Content |
|---|---|
| `routes/+page.svelte`, `routes/play/[sim]`, `routes/play/rt/[kernel]` | inert shells with final grid tracks, lazy page code (`lib/shell/lazy.ts`), modulepreload from the client manifest (`lib/shell/preload.server.ts`) |
| `service-worker/index.ts`, `static/_headers` | cache per deploy; COOP same-origin, COEP require-corp, CORP same-origin |
| `lib/state/` | `model.svelte.ts` (OpLog wrapper, drag coalescing, refused reverts), `diff.ts` (patch diff, share code), `params.ts`, `tree.ts`, `log.svelte.ts`, `nav.svelte.ts` |
| `lib/engine/` | `runner.worker.ts` (C6), `client.ts`, `physics.ts` (late binding by glob), `registry.ts`, `spec-adapter.ts` (coarse drag meshes), `materials-node-shim.ts` |
| `lib/post/` | `field2d.ts` (lattice, P1/P2, locator), `solid3d.ts` (exterior, marching tets, slices, quality), `post.worker.ts` + client |
| `lib/gfx/` | `renderer2d.ts` (EO port), `Canvas2D.svelte`, `viewer3d.ts` + `field-material.ts` (TSL), `Canvas3D.svelte`, `Graphics.svelte`, `Colorbar.svelte`, `colormaps.ts` |
| `lib/workbench/`, `lib/play/` | Workbench (tree, settings, YAML, timeline, bottom tabs), session; Play view, hero handles/focus/presets, RT panel |
| `lib/materials.ts`, `lib/cases.ts`, `lib/sims.ts` | materials/*.yaml, eval cases, sims/*.yaml through `import.meta.glob` |
| `test/`, `scripts/shots.ts`, `scripts/serve.ts`, `test/tsl-probe/` | unit tests, verification driver, static server, TSL evidence page |

Hooks for agents and tests: `window.__ampWorkbench` (`session`, `setTab`, `setMode`, `nav(actor)`), `window.__ampPlay` (`session`).

Open: s.4.5 limits; contract requests s.5; fresh-context audit.

## 7. Audit corrections (audit `DevLog/audits/2026-11-06-L5-web-audit.md`, coordinator order 2026-11-06 ~16:58 PST)

| # | Disposition | Change | Evidence |
|---|---|---|---|
| B1 | fixed | Session tags every solution with the spec hash it was computed from (`ModelState.specHash` = op `after`) and whether it was coarse; `fresh` / `staleSolution` are derived, never set. With physics present (Play) every op that invalidates geometry, mesh or solution schedules a run (one in flight, latest wins), so undo, redo, presets and exact-field edits re-solve. Drag ends await the last op before the full run. Stale results are drawn desaturated with a "stale: earlier spec" badge; scalars and headlines are dimmed and marked. Play has a Compute button | s.4.2 B1 row (W_m x4 exact, Undo restores) |
| B2 | fixed | the phone log pane takes the main grid row instead of `position: fixed; top: 76px`; toolbar height fixed at 84 px (same in the shell) | s.4.2 B2 row; `L5-workbench-kirsch-plate-log-390` |
| S1 | fixed | a run that ends unavailable or in an error clears the solution; "computing" (pending) is distinct from "unavailable"; a solution on another mesh shows "Results out of date" | code `session.svelte.ts` handle() |
| S2 | fixed | the eval case is off by default (the heroes carry their own materials since I1); it is credited only for the properties `prepareRun` notes report as filled ("case values used: ..." or "materials: from the model"); headlines carry a "case" marker when case values were used; the pairing comes from the `# eval: [...]` line of the sims file (the SIM_CASE table is gone); an unavailable run with N/A inputs offers "use eval case X values" | Play aside, workbench toolbar tooltip |
| S3 | fixed (with L3 detmath) | gate compares the browser solve-mesh hash with Node `prepareRun` on the exact text the browser holds; mesh hash in the footer tooltip | 6/6 equal (s.4.2) |
| S4 | fixed | eigen fields drawn normalized (max abs = 1), no unit, colorbar "norm." with the reason in the tooltip; the phase animation is offered only for signed components (a magnitude does not change sign) | box, rib, cavity screenshots |
| S5 | fixed | range rule stated in the colorbar tooltip: full or area-weighted p1-99, over the view box when there is one; diverging map only when both signs carry >= 5 % of the range; peak marker (value and location) on 2D results; Play defaults: kirsch full over the hole box (0..3.02 MPa, peak 3.02 at the hole top), helmholtz p1-99 over the coil box (B_center visible) | kirsch, helmholtz screenshots |
| S6 | fixed | refined lattice, value scaling, ranges and peaks run in the post worker (typed arrays transferred); element quality in the runner worker; 3D materials and render objects are reused and only geometry data is replaced; the 3D canvas stays mounted while a remesh is in flight (a CPU profile showed the canvas being recreated: `setSize` + `forceContextLoss` + `getContext`, 1.5 s over 8 drag steps) | long tasks during drags: 0 in all six (s.4.2) |
| S7 | fixed | coarse re-solve (sizes x2) during every drag, geometry or not; "coarse preview" badge; progress bar after 1 s with the worker stage | rib lambda0/t drags: 330 ms median previews |
| S8 | fixed | field controls only for drawable fields; colormap select shows "auto (<map in use>)"; log toggle only when the range spans > 2 decades and the unit is not affine | screenshots |
| S9 | fixed | log toggle (see S8); symlog not offered (no tick rule for it yet) | - |
| S10 | fixed | CSP: SvelteKit hash mode meta on pages (`default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'` + bootstrap hash, `connect-src 'self' https://api.anthropic.com`, `worker-src 'self' blob:`, `object-src 'none'`, `base-uri`/`form-action 'self'`); `_headers`: `frame-ancestors 'none'` for all, a script CSP for `/_app/*` (workers). Hooks only in dev or `VITE_AMP_HOOKS=1` builds. The op log is a true private field; `apply` binds `user`, `applyAgent(session, patch, reason)` binds `agent:<session>` | production bundle: 0 hook references |
| S11 | fixed | agent rows: amber left bar and an "agent" label (no icon), actor filter (all / user / agent), revert per op; `applyAgent` is the apply path for L9 | `L5-workbench-timeline-1440` |
| S12 | fixed | s.4 rerun; playwright-core pin is 1.63.0 (s.1.1 corrected below) | s.4.2 |
| M1 | fixed | fixed phone toolbar height in workbench and shell | - |
| M2 | fixed | active buttons white on #2462b5 (5.3:1); `--na` #8f8c86 | - |
| M3 | partly | Play controls 36 px and canvas handles 26 px on phones; workbench controls stay 22 px (dense pro layout) | - |
| M4 | fixed | pending shows "computing", not "unavailable" | - |
| M5 | partly | display symbols (micro, degree, no trailing "1"); the spec's `kt` and probes are computed and shown in spec units (headlines); module scalars stay SI | - |
| M6 | fixed | opens on the spec's plot result field | helmholtz opens on normB |
| M7 | fixed | colorbar labels both ends plus interior nice ticks | - |
| M8 | fixed | tooltip near the bottom edge is placed above its element using its measured height | - |
| M9 | fixed | RT panels start paused with a hint; title ellipsis keeps the badge visible at 390 px | RT screenshots |
| M10 | fixed | JSONL tooltip says amp-oplog/1; redo rows say why they have no revert; tree rows and message rows act on Enter | - |
| M11 | fixed | `preserveDrawingBuffer: false`; the screenshot tool redraws and reads back in the same task | - |
| M12 | fixed | horizontal colorbar along the bottom at <= 760 px | 390 screenshots |

Top-10 improvements:

| # | Disposition |
|---|---|
| 1 range + peak marker | done (S5) |
| 2 headline numbers | done: spec `scalar` results of the form max/min(field) over a selection with a param expression, and `probe` results (2D, exact FE evaluation), in spec units; other forms say "not evaluated" |
| 3 field lines / contours | done for 2D: contours on by default in Play; magnetic field lines as contours of r A_phi (axisymmetric). Streamlines and LIC skipped: no velocity field in the wave-1 heroes |
| 4 3D shading | partly: feature edges (dihedral > 30 deg) outline the solid in geometry and results views; derivative-based shading kept. Ground plane and smooth tet10 faces skipped (tet10 faces drawn by corners) |
| 5 eigen interaction | done: mode list in the Play aside selects the mode and starts the animation; the animation starts on the first canvas interaction |
| 6 live coarse feedback + progress | done (S7) |
| 7 units and symbols | done (display only) |
| 8 timeline badges and filter | done (S11); hover diff kept as the expand row |
| 9 mobile | partly: horizontal colorbar, 36 px controls in Play, fixed toolbar; bottom sheet skipped |
| 10 worker offload | done (S6) |

Not mounted: the L9 chat panel (coordinator: wait for DevLog-012 mount and CSP notes).

### 7.1 Progress

- 2026-11-06 16:58 PST: audit read; plan = audit fix order (B1, B2, S1, S2, S4, S5, S3, S10, then the rest).
- 2026-11-06 17:05 PST: ModelState (private log, specHash, applyAgent), Session rewrite (freshness, scheduling, progress, truthful case use), post worker lattice/display/evalAt jobs, headline evaluator, Graphics rewrite.
- 2026-11-06 17:10 PST: CSP, hooks gate, timeline agent rows, phone layout, contrast, RT calm start; shots script gains the B1, B2, S3 and long-task checks and parses `_headers`.
- 2026-11-06 17:12-17:19 PST: verification runs found: a `$state` proxy posted to the worker (focus box; fixed by copying), the 3D canvas remounting on every remesh (CPU profile; fixed), per-object TSL rebuilds (render objects pooled). Coordinator note: L3 detmath, hashes now equal across Node and Chrome (S3 gate added).
- 2026-11-06 17:21 PST: final run, production build without hooks, 25 screenshots kept.


## 8. Pass 2 (coordinator order 2026-11-06 ~17:22 PST)

No live LLM call was made; every agent test ran on `@amp/agent`'s `ScriptedProvider`. No key was entered in any test or screenshot.

### 8.1 Changes

| Item | Done |
|---|---|
| 1 chat panel | `@amp/agent` (`link:`) and `@anthropic-ai/sdk` 1.1.0 (exact) added; root lockfile unchanged (diff). `lib/agent/mount.ts` mounts per DevLog-012 s.6.1: `log` = `ModelState.agentLog(session)` (the same op log; every write must carry exactly `agent:<session>` and a reason, `user` accepted only for undo and revert from the panel's "revert turn"; the UI refreshes after each agent op), `nav` = the workbench `navHost(actor)` or the Play view's host (calls recorded in the Navigation trail), `runner` = the session's C6 worker (current text, first study), memory on OPFS (falls back to an in-memory backend), `storage` = localStorage for the opt-in only, `isApiError` and `isToolInputParseError` (`AnthropicError && !APIError`), budget defaults USD 1 per turn and USD 5 per session. The SDK is imported only when the panel mounts without a test provider. `AgentPanel.svelte`: key field (password input, never echoed; "remember on this device" opt-in, Clear key), messages as text, Send / Stop, secret warning with Redact (`hasSecret` / `redact`), budget line (calls, tools, tokens in/out/cache, turn and session cost as estimate or N/A, editable caps), revert per turn, prompt inspector. Workbench: Agent column (stays mounted once opened). Play: Agent button opens a third column (overlay on phones). Memory tab in the bottom panel: files, raw edit as the user (one memory op per save), the memory log with actor and reason, Refresh for outside edits. Agent spec ops appear in the Timeline (amber bar, actor, reason, revert) |
| 2 CSP | page meta (kit hash mode): `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' <bootstrap hash>; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.anthropic.com; worker-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`; `_headers`: `frame-ancestors 'none'` for all paths and the same script policy for `/_app/*` (workers). Tightened from pass 1: `worker-src` no longer allows `blob:`, `form-action 'none'`, `font-src 'self'`. Network reach of the panel: this origin and `https://api.anthropic.com` only |
| 3 no key in captures | screenshots are taken with the panel closed; the screenshot tool captures the graphics canvas only; the tests use the scripted mock and no key; check: key field is `type=password`, localStorage empty after mounting |
| 4 Play agent test | mock script "make the hole 2x larger and rerun" (apply_ops D 10 -> 20 mm with its range, run_study std1, answer), typed into the panel and sent with its Send button |
| 5 axisymmetric cavity | `/play/cylinder-cavity` loads `sims/cylinder-cavity-axisym.yaml` (`emw-axisym`, m = 0, 1, 2) and draws each mode revolved in 3D (`post/revolve.ts`: the meridional boundary revolved in 64 sectors; E_r cos(m phi), E_phi sin(m phi), E_z cos(m phi), one doublet partner; normalized to max 1 on the drawn surface; the solver's normalization statement in the colorbar tooltip). Mode buttons show f and m. `?solver=3d` (aside "solver" switch) keeps the 3D Nedelec solve. Results shown also include the per-mode scalars of the selected mode only |

Also: `Solution.normalization` (L4) is shown in the eigenmode colorbar tooltip; the revolved canvas stays mounted during drags (the first version switched 2D/3D canvases per remesh: 38 long tasks; fixed: 0).

### 8.2 Gates (`logs/L5-shots-20261107T013227.json`, tests `logs/L5-test-20261106T172959.log`, production build `logs/L5-build-20261106T173359.log`)

| Gate | Result |
|---|---|
| `pnpm check` / `pnpm build` / `pnpm test` | 0 errors 0 warnings (1374 files) / ok, 10 pages, CSP meta present, 0 hook references in the production build / 6/6 |
| Play agent (mock) | D 10 -> 20 mm; study rerun (new run, fresh, solved for the current spec hash); 1 agent op `agent:s-...` with reason "User: hole diameter 2x (10 mm -> 20 mm); D range widened to include it"; 0 wire violations; Undo restores the spec text byte for byte |
| Workbench agent column | mounts; key field is a password input; localStorage keys: none |
| B1 (I x2 gives W_m x4) / B2 (switcher reachable) / op log round trip | pass / pass / byte-identical |
| S3 mesh hashes browser = Node | 6/6 (cavity now the axisym mesh `f5f6aeb5`, 169 tri6) |
| FCP / tab switch / mode switch | 38.6 / 38.0 / 36.9 ms medians (`/`, kirsch Play, LBM); 15.7-16.5 ms; 19.2 ms median |
| Play load to fresh result | kirsch 213 ms, heat 232, helmholtz 241, box 230, cavity (axisym, 4,103 DOF) 272 ms (3D was 2.7 s), rib 3,876 ms |
| Drag previews (median) and long tasks during drags | kirsch 52 ms, heat 29, helmholtz 44, rib 316, cavity 28, box 15; 0 long tasks in all six |
| Errors | none |

Screenshots (25, `logs/L5-*-20261107T013227.png`, one per view, panel closed in all).

### 8.3 Progress

- 2026-11-06 17:22 PST: read DevLog-012 s.6, s.7 and `@amp/agent` (chat, session, memory, mock).
- 2026-11-06 17:25-17:31 PST: dependencies, agentLog, mount, panel, Memory tab, Play panel and nav host, CSP; mock test passes on the first run.
- 2026-11-06 17:31-17:34 PST: axisymmetric cavity view; a drag test found canvas switching (fixed); final run; production build.

### 8.4 Open

- Not exercised: a live Anthropic call (by instruction), OPFS in other browsers, the key opt-in path end to end (only the empty state was checked; no key may be entered in tests).
- The agent runner solves the current text and the first study only; `geometry` is passed as null (no BuiltGeometry adapter yet).
- The revolved view draws one partner of each m >= 1 doublet and no interior (section shows the shell); slices and isosurfaces are 3D-mesh only.
