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
| `playwright-core` | 1.65.0 | verification screenshots (same pin as `@amp/rt`); uses the local Chromium in `~/Library/Caches/ms-playwright` |

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
- [ ] Fresh-context audit (coordinator)

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


### 4.2 Gates (final run `logs/L5-shots-20261107T003504.json`; build `logs/L5-build-20261106T163254.log`; tests `logs/L5-test-20261106T163254.log`)

Machine: M4 Pro laptop shared with other lanes; static build served by `scripts/shots.ts` (in-process server on 127.0.0.1:47391 with the `_headers` COOP/COEP, port checked free, closed at exit). Browsers: chrome-headless-shell 151.0.7922.34 (WebGL via ANGLE SwiftShader, i.e. software rendering) for workbench and Play; installed Google Chrome 156.0.8078.80 headless with `--enable-unsafe-webgpu` for the RT panels (the headless shell has no WebGPU adapter).

| Gate | Result |
|---|---|
| `pnpm check` (svelte-check) | 0 errors, 0 warnings, 1085 files |
| `pnpm build` (adapter-static) | ok; 10 prerendered pages (`/`, 6 Play, 3 RT) |
| `pnpm test` (node --test) | 6/6: refine pattern, P2 lattice and probe exact for a quadratic (lattice 1e-5 float32, probe < 1e-12), curved tri6 probe 400/400 located, marching tets (sphere isosurface area of \|x - c\| on a 0.04 hex grid within 1 % of 4 pi r^2, slice area exact to 1e-9, exterior area 6 to 1e-5), patch diff + op log + share code round trip, schema walker widgets |
| First paint (FCP), fresh context, no service worker, 5 loads | `/` median 36.5 ms (first load 508 ms: cold browser process, then 36.4-36.7); `/play/kirsch-plate` 38.1 ms (37.2-38.6); `/play/rt/lbm-d2q9` 36.1 ms. Target < 100 ms: pass |
| Tab switch (click to the next animation frame), 3 rounds | Log 15.1, Progress 15.8, Timeline 16.4, Messages 16.0 ms median (one frame at 60 Hz); mode switch G/M/R 19.1 ms median, 30.1 max. Target < 100 ms: pass |
| Op log round trip through the UI | 20 edits of D in the Settings form, 20 Undo clicks: text byte-identical (2969 B) |
| Drag coalescing | every Play slider gesture of 12 steps = 1 op (`coalesced` 13 incl. release); every canvas handle drag of 10 moves = 1 new op (`coalesced` 11) |
| Coarse re-solve during a drag (input to mesh/result arrival, sizes x2) | kirsch 36 ms median (85 max), heat 36 (45), helmholtz 31 (46), rib 10 (30, mesh only: no result, see below), cavity 192 (215), box 70 (75). Target < 1 s: pass |
| Full solve in the browser (Play load, eval-case materials) | kirsch 83 ms (11,090 DOF), heat 121 ms (26,021), helmholtz 75 ms (14,799), cavity 2,009 ms (13,192 DOF, NED2 eigen), box 78 ms (2,700); rib unavailable (`material 'core': n is N/A`, see s.5). Workbench Compute: kirsch 177 ms, box 202 ms (round trip incl. mesh) |
| Page errors / console errors during the run | none |

### 4.3 Bundles (gzip -9)

`index.html` 24.3 kB (inline CSS). Workbench code preloaded by the shell: 185 kB gz (includes zod, yaml, @amp/spec). three.js + TSL chunk 219 kB gz, loaded only for 3D models. Runner worker 122 kB gz (+ 53 kB gz shared chunk): @amp/physics, @amp/mesh, @amp/geom, @amp/core.

### 4.4 Screenshots kept (`logs/`, timestamp 20261107T003504)

Workbench: `L5-workbench-kirsch-plate-results-1440`, `-kirsch-plate-390`, `-box-acoustics-slice-iso-1440`, `-box-acoustics-section-anim-1440`, `-box-acoustics-390`, `-timeline-1440`. Play: `L5-play-<sim>-{1440,390}` for the six heroes. RT: `L5-rt-{lbm-d2q9,fdtd-tmz,gray-scott}-{1440,390}`. Inspected: kirsch sxx peaks at the hole top (about 3x sigma_inf, mises_max 3.00e6 Pa for sigma_inf 1 MPa); box mode at 172 Hz is the (1,0,0) shape with planar isosurfaces normal to x; helmholtz Bz has the two-loop pattern; LBM shows the vortex street.

### 4.5 Known limits

- No Canvas 2D fallback (WebGL2 required for the 2D view); WebGPU required for RT panels (shows the probe and "not available" otherwise).
- 3D deformation is implemented (vertex displacement x scale, auto 10 % of the diagonal, editable) but no hero has a 3D displacement field yet, so it is not visually verified. 2D deformation is not implemented.
- Nedelec fields (cavity E, rib modes) have no display: `@amp/post` evaluateField supports H1/DG0 only.
- Service worker and `_headers` were exercised only by the local server; not yet on Cloudflare Pages.
- Navigation host: `set_camera` supports `fit` only (presets and look_at return a failure message); `screenshot` returns the graphics canvas only.
- Playwright verification ran in software WebGL (SwiftShader); GPU timings in a real browser are not measured.

## 5. Contract requests

1. **C6 (coordinator)**: add the worker messages `{type:'mesh', id, mesh, ms, source, ts}` (mesh before the solve) and `{type:'unavailable', id, reasons, ts}` (no module, not ready, or the module cannot run with its inputs); `options` keys `meshScale`, `meshOnly`, `case` (`apps/web/src/lib/engine/protocol.ts`).
2. **Root lockfile (coordinator)**: `pnpm-lock.yaml` now lists the `apps/web` importer (s.3, 15:52). Either keep it (apps/* is a workspace member; a root `pnpm install` will keep it in sync with `apps/web/package.json`) or decide on per-package `--ignore-workspace` installs; `apps/web/pnpm-lock.yaml` exists as well.
3. **C1 (coordinator)**: runtime dependency `three` 0.187.0 in `apps/web` (A10). Dev: SvelteKit 3.0.0, adapter-static 4.0.0, vite-plugin-svelte 7.3.1, svelte 5.57.1, svelte-check 4.7.6, vite 8.3.2, `@types/three` 0.187.0, `@webgpu/types` 0.1.74, playwright-core 1.63.0 (exact pins).
4. **L4**: (a) an H1 (nodal) projection of Nedelec fields (`E` of emw and em-modes) in the Solution, or Nedelec evaluation in `@amp/post`, so the viewer can draw them; (b) `prepareRun` uses `@amp/materials/node` (fs); please accept an injected library (`prepareRun({..., library})`) so the browser does not need the alias in `apps/web/vite.config.ts`; (c) `si-rib-waveguide` materials `core/sub/cov` do not match the WO-02 case keys `core/substrate/cover`, so the browser run reports `n is N/A`; (d) eigenmode amplitudes carry the field unit (Pa, V/m) though their scale is a normalization: state the normalization in the Solution (e.g. `steps.normalization`).
5. **L2 / sims owner**: the six heroes have their material values N/A (`missing` entries); the browser can only solve them with the paired eval case's values. A `sims`-level reference to the case (e.g. `provenance` or a `validation: {case: SM-01}` key) would replace the `SIM_CASE` table in `apps/web/src/lib/cases.ts`. The kirsch `missing` text still says `materials/` is empty (it is not since DevLog-013).
6. **L9**: `@amp/agent` has no `src/index.ts` yet; the workbench implements `NavigationHost` structurally (`apps/web/src/lib/state/nav.svelte.ts`, exposed as `window.__ampWorkbench.nav(actor)`) and will import the interface once it is exported. The Agent column is reserved (300 px, toggled in the toolbar).
7. **C9 (coordinator)**: confirms L6's optional members are sufficient for the RT panel; no change needed.

## 6. Hand-off

State: workbench, six Play views and three RT panels build, check and run; physics results display for five of six heroes (rib waiting on L4 item 4c); all gates in s.4.2 pass.

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
