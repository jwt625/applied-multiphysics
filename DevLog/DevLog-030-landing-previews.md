# DevLog-030: landing page with geometry / mesh / result previews (lane LP)

| Field | Value |
|---|---|
| Date | 2026-11-07 |
| Lane | LP (DevLog-029 s.3.2, s.3.4) |
| Owns | `apps/web/src/routes/**`, `apps/web/src/lib/landing/**`, `library/catalog.ts` + `LibraryPicker.svelte` (category and field additions only), `library/catalog-mp.ts` (creation only; MX fills it), link sites of the workbench URL (link edits only), `apps/web/scripts/previews.ts`, `apps/web/static/previews/**`, this file |
| Read | DevLog-029 s.1, s.2.1-2.3, s.3.4; gdsjam `FileUpload.svelte`, `examples.ts` (read only); `apps/web/scripts/shots.ts`, `gfx/capture.ts`, `Graphics.svelte`, `Workbench.svelte` (hooks), `service-worker/index.ts`, `scripts/base-check.ts` |
| Request | Wentao, 2026-11-07 (DevLog-029 header, decisions Q1) |
| Status | done (gates s.4); open items s.5 |

Conventions: "F" = fact read from code or a run; "D" = decision of this lane (reason given); "O" = open item.

## 1. Plan (2026-11-07 08:27 PST)

### 1.1 Facts (F)
- `/` is the workbench (`routes/+page.svelte`, `+page.server.ts` preloads `Workbench.svelte`); `?sim=<id>`, `#d=<share>`. `trailingSlash = 'never'`, so `/workbench` prerenders to `build/workbench.html` (Pages serves it at `/workbench`).
- Link sites of the workbench at `/`: `play/Play.svelte` ("workbench" link `resolve('/')?sim=`), `play/RtPanel.svelte` (brand link, tooltip "Workbench"), scripts `shots.ts`, `v1-shots.ts`, `base-check.ts` (`/?sim=`, `${BASE}/`). `Workbench.svelte` `goModel` (`?sim=` relative) and `copyShare` (`location.pathname`) are relative to the current page, so they follow the move without an edit. Agent navigation tools (`packages/agent`) do not build URLs. `deploy/worker.js` redirects the bare base to `base/` keeping the query: lands on `/` and is forwarded.
- Service worker precaches every prerendered page and every static file (`assets`), so `static/previews/*` would all be fetched on install.
- `html, body { overflow: hidden }` (app.css): the landing scrolls inside its own container.
- Hooks (`window.__ampWorkbench`: `session`, `setMode`) exist only in dev or `VITE_AMP_HOOKS=1` builds.
- Catalog: 8 categories, `coupled` has no entry; 36 sims; the workbench picker hides 7 EM analogs solved with the acoustics module (field shown as Pa; coordinator decision DevLog-021).

### 1.2 Design (D)
- Routes: `/` = landing (`lib/landing/Landing.svelte`); `/workbench` = the old workbench route moved unchanged (shell + lazy load + preload). On `/`, a `?sim=` or `#d=` URL is forwarded with `location.replace(<base>/workbench + search + hash)` before the landing renders anything else (client-side; no server redirects needed on Pages).
- Catalog: category `multiphysics` ("Multiphysics", first) replaces the unused `coupled`; new optional field `couplings?: {type, from, to}[]` (physics types); `CATALOG_MP` from `catalog-mp.ts` merged like `CATALOG_BC` (placed first). `LibraryPicker` gets the short label only.
- Landing: header (name, one line, links Workbench / Play / GitHub), search (title, id, physics, category, tags, eval case: the catalog's `matches`; `/` focuses, Esc clears), category chips with counts (multi-select), grid grouped by category (Multiphysics first). Same entry set as the workbench picker (analog exclusion rule reused) plus uncatalogued sims files under Other. Card: 4:3 preview with three tabs geometry / mesh / result (result default, falls back to mesh when the manifest has no result), hover on a tab switches; title, physics chips (or the coupling chain), dimension, status square; tooltip = `entryTip`. Card click opens `/workbench?sim=<id>`; a Play badge links `/play/<id>` for heroes. Tip.svelte mounted for `data-tip`.
- Previews manifest `static/previews/manifest.json` imported at build time (`import.meta.glob`, eager; empty when absent) so the prerendered landing knows which images exist; image URLs through `asset()` (base path).
- `scripts/previews.ts`: builds nothing itself; needs a `VITE_AMP_HOOKS=1` root build in `build/`. Serves `build/` with `_headers` on a free port in 47431-47439 (lsof check), headless shell (SwiftShader), one fresh context per sim at 480 x 360 CSS px, deviceScaleFactor 2. Clean capture state without app changes: a stylesheet injected by the script (fixed full-window `.gfx`, stage without the colorbar strip, toolbar / footer / colorbar / progress hidden). Per sim: wait for the mesh, `setMode('geometry')` shot, `setMode('mesh')` shot, `session.requestCompute()`, wait settled (timeout), `setMode('results')` shot when `status === 'solved'` and fresh. Screenshots (960 x 720 PNG) downscaled in an about:blank page to 480 x 360 and encoded `image/webp` (quality 0.85) by canvas; PNG when the browser returns no WebP. Manifest per sim: sha256 of the sims file text + a script version, files, result status / reason, timings; skip when hash and files match, `--force`, `--only a,b`. Log `logs/previews-<ts>.json`. `nice -n 10`, `--max-old-space-size=1536`.
- Service worker: `/previews/` excluded from the install precache, stored on first use (landing images are not needed offline before first view).

### 1.3 Gates
1. `pnpm check` 0 errors, `pnpm test` pass (apps/web).
2. Production build with and without `BASE_PATH=/applied-multiphysics`; `/` and `/workbench` prerendered; internal links under the base.
3. Previews for all 36 sims (result missing listed with the reason).
4. Screenshots of `/` at 1440 x 900 and 390 x 844 (scratch, not in the repo), looked at; `/?sim=kirsch-plate` forwards to `/workbench?sim=kirsch-plate` and the workbench opens kirsch-plate; `/#d=` forwards keeping the hash.

## 2. TODO
- [x] plan (this section)
- [x] routes: landing `/`, `/workbench`, forwarding
- [x] catalog: multiphysics category, couplings field, catalog-mp.ts; LibraryPicker label
- [x] link sites: Play, RtPanel, service worker, scripts, `_headers`
- [x] landing UI
- [x] scripts/previews.ts; previews for all sims
- [x] gates 1-4

## 3. Progress
- 2026-11-07 08:25 PST: started; read DevLog-029, routes, catalog, picker, shots.ts, capture.ts, Graphics / Workbench hooks, service worker, base-check.
- 2026-11-07 08:27 PST: plan written.
- 2026-11-07 08:30 PST: routes moved (`routes/workbench/+page.{svelte,server.ts}`; `routes/+page.server.ts` removed: the landing needs no preload), forwarding on `/`; catalog `multiphysics` (replaces the unused `coupled`), `couplings` field, `physicsChain`, `catalog-mp.ts`; `lib/landing/{Landing,Card}.svelte`, `previews.ts`. D: the manifest lives at `src/lib/landing/previews.json` (bundled), not under `static/`: SvelteKit sets Vite `publicDir` = `static`, and files there cannot be imported. Link edits: Play "workbench", RtPanel brand link, `shots.ts` / `v1-shots.ts` / `base-check.ts` paths; `static/_headers` gains a `/workbench` block (no-transform, as `/` and `/play/*`, DevLog-017 s.5); service worker skips `/previews/` in the precache, stores them on first use. `pnpm check` 0 errors, `pnpm test` 15/15.
- 2026-11-07 08:34 PST: `scripts/previews.ts`; pilot (kirsch-plate, helmholtz-coil, box-acoustics): 3 / 3 views each, 4-5 s per sim; looked at the contact sheet. F: the workbench draws mirrored quarter models (kirsch) in geometry / result mode but the mesh mode shows the solved quarter, so the mesh image sits in one quadrant of the union crop; large air domains (helmholtz) fill the frame.
- 2026-11-07 08:35-08:38 PST: full run (`logs/previews-20261107T163518.json`): 33 captured + 3 pilot skipped; all 36 sims have geometry, mesh and result (status solved; none needed the case fill; 0 page errors); 3.6-17 s per sim; 108 WebP, 1.2 MB. Looked at the contact sheets of all 36: framing and content correct; 1D-on-a-strip models (NAFEMS T2 / T3, semi-infinite, Bragg, Si slabs) are thin strips (true aspect, not stretched).
- 2026-11-07 08:38-08:40 PST: production builds root and `BASE_PATH=/applied-multiphysics`, landing verified in headless Chromium (s.4); rerun with unchanged sims: 36 skipped (`logs/previews-20261107T164005.json`); root production build restored in `build/` (0 hook references).
- 2026-11-07 09:35 PST: coordinator follow-ups (wave 2): (1) canvas labels off in thumbnails, (2) thin 2D models as a 1D line plot, (3) multiphysics result = last physics of the chain, (4) rerun all with `--force` incl. the 11 MX sims and `gaas-microdisk-om`.
- 2026-11-07 09:38 PST: (1) D: done in the capture stylesheet of `previews.ts`, no app edit (probe / peak markers, labels, cut-line guides, handles are SVG overlays of Canvas2D / Canvas3D, not canvas pixels: `.mk`, `.gd`, `.hd`, `.ring`, `svg text` hidden); Graphics.svelte / renderer2d.ts / viewer3d.ts untouched. (2) mesh box aspect > 4 (2D): result = the spec's first plot1d group; else a plot1d over the spec's cut line; else a capture-only cut line (applied to the page's model, never written to the sims file) along the long axis at mid-height, along the radius for axisymmetric models (the 1D-radial wires vary across, not along, the strip); expression and unit of the shown 2D plot, else `<physics>.<first field>` in SI; shot at 480 x 360 CSS px (axis text legible at card size), not cropped. Geometry / mesh stay true scale. (3) one-way couplings (joule-heating, thermal-expansion, thermo-optic, electro-optic): `showPlot` of the first plot2d whose surface expression is on the last physics of the chain; two-way couplings keep the spec's first plot. Manifest `resultView` records what the result image shows. Generator version `previews/2`. Pilot 8 sims, contact sheet looked at.
- 2026-11-07 09:40-09:44 PST: full `--force` run on the 09:38 build: 48 / 48 captured, results missing for hot-arm-actuator (hex8), ln-fbar-2d, pzt4-cube (materials absent from that build); engine and materials landed since: hooks build again and a second full `--force` run (hot-arm-actuator after MX's hmax D1/2 edit, 09:42).
- 2026-11-07 09:46-09:53 PST: second full `--force` run on a fresh hooks build (`logs/previews-20261107T174455.json`): 48 / 48 captured; hot-arm-actuator solves (hmax D1/2, 11 s capture). Tried a pixel-based result zoom for fields confined to a small region (guided modes in large cladding boxes); it framed some results badly (NAFEMS T1 corner) and breaks the shared G / M / R framing: removed. Line plots without a 2D plot group now prefer a magnitude field (`normE`; a TM0 slab's first component is ~0 and plotted noise). Recaptured the affected sims (`logs/previews-20261107T175111.json`, `-175320`, `-175413`).
- 2026-11-07 09:54 PST: contact sheets of all 48 (multiphysics first) looked at; root production build (0 hook references); landing 1440 x 900 and 390 x 844: 42 cards (48 minus the 6 hidden analogs), Multiphysics group first with 12 cards and coupling chains, 42 images, 0 failed requests, 0 page errors; forwarding unchanged. `pnpm check` 0 / 0, `pnpm test` 15 / 15. 141 files, 1.6 MB in static/previews.

### 3.1 Result previews missing (2026-11-07 09:55 PST; all three solved since 10:00 PST, see the progress log)

| Sim | Reason (from the browser run) |
|---|---|
| pzt4-cube | unavailable: `material 'pzt4' has neither a stiffness tensor C nor E, nu; materials.pzt4: no material library available for materials/pzt-4 (inject one with prepareRun({library}))` |
| ln-fbar-2d | unavailable: `material 'LN' has no density rho; materials.LN: no material library available for materials/linbo3-congruent` |
| gaas-microdisk-om | unavailable: `material 'GaAs' has no value for 'rho'; materials.GaAs: no material library available for materials/gaas` |

F: `runner.worker.ts` calls `preloadMaterials()` but passes no `library` to `prepareRun`; `prepare.ts` `defaultLibrary()` returns null outside Node, so every `ref: materials/<id>` property the spec does not override is missing in the browser (Node runs are unaffected). Fix (lane MC's file): pass `library: defaultLibrary()` from `materials-node-shim.ts`. Then `scripts/previews.ts --force --only pzt4-cube,ln-fbar-2d,gaas-microdisk-om` (the sims hash does not see an engine change). The gaas result view (breathing-mode displacement vs WGM |E|) is to be chosen when it solves; its spec has one plot group (`p_opt`, E_r).
- 2026-11-07 09:56-10:04 PST: coordinator fixed the browser material library (`runner.worker.ts` passes `library`). Added `FOCUS` entries in `play/heroes.ts` (only these two; the workbench applies FOCUS as its ROI, the capture inherits it): si-microheater-to = x within 1.5 w_h, y from -(t_wg + t_c) to t_wg + t_c + 2 t_h; tfln-mzm-eo = x within the electrode gap g, y from -t_box/2 to t_film - h_rib + 2 t_el (all from the sims params; the factors are framing choices). Hooks build, `--force --only` the 5 sims: all solve (`logs/previews-20261107T175723.json`). gaas-microdisk-om: compared a capture-only breathing-mode view (|u| on mech step 2 with deformation) with the spec's optical E_r plot at card size: the optical WGM reads better; the capture-only override hook (`RESULT_VIEW` in previews.ts) is kept empty. Browser vs Node (prepareRun + runStudy with the Node material library), same sims file, scratch script: same mesh hash and bitwise-equal scalars for pzt4-cube (20 scalars), ln-fbar-2d (80), gaas-microdisk-om (292; two NaN pairs), kirsch-plate (kt headline 3.021, 10810 DOF), helmholtz-coil (B_center 8.983 uT), membrane-air (10). Root production build, landing looked at: 42 cards, Multiphysics first, every multiphysics card with a result image.
- 2026-11-07 10:03-10:08 PST: polish. (1) `FOCUS['ln-fbar-2d']` in `play/heroes.ts`: x out to the electrode outer edges (w_gap/2 + w_metal), y from -2 t_LN to g_metal + 2 t_metal (params). The film is 500 nm across about 60 um, so at card size the u_y mode is still a thin striped band (lateral overtones), now with both electrodes in frame. (2) 1D captures get a 50 px top inset (dark band) so the card's G / M / R tabs no longer cover the y-axis ticks; the 11 1D cards recaptured (`logs/previews-20261107T180438.json`). (3) F: the ln-fbar-2d headline "uy_mid -3.399 m" comes from the sims file, `sims/ln-fbar-2d.yaml` line 74 (`ev_eig` item `uy_mid`, type point on `mid_pt`, expr solid.u.y, unit m: a normalised mode amplitude), selected by the headline rule `headlineItems` (packages/spec/src/results.ts: only enabled max / min / point items are headlines; the `global` items f_te_active / V_te_active / f_te_piston of `ev_te` never are). The value is the first step (mode 0) of a normalised eigenmode, not a physical displacement. Fix options for MX / R3: mark `uy_mid` `enabled: false` or move it out of the headline set, or let global items be headlines. Final plain build (0 hook references), landing 1440 / 390 looked at: 42 cards, 42 images, 0 errors.

## 4. Results (2026-11-07 08:40 PST)

| Gate | Result |
|---|---|
| 1 check / test | `pnpm check` 0 errors 0 warnings (one transient error from another lane's in-progress `Crystal` type, gone on rerun); `pnpm test` 15 / 15 |
| 2 builds | root and base builds exit 0; `/`, `/workbench`, `/play/*` prerendered; base build: every internal link of the landing under `/applied-multiphysics/`, preview URLs under the base |
| 3 previews | 36 / 36 sims with geom + mesh + result; no result missing |
| 4 browser | landing 1440 x 900 and 390 x 844 (root and base): 30 cards (36 sims minus the 6 hidden acoustics-analog EM sims), 30 images, 0 failed requests, 0 page errors; `/` focuses search; "SM-21" leaves Lame cylinder; hovering G switches to the geometry image; `/?sim=kirsch-plate` -> `/workbench?sim=kirsch-plate` (kirsch opens), `/?sim=box-acoustics#d=abc` -> `/workbench?sim=box-acoustics#d=abc`, `/#d=xyz` -> `/workbench#d=xyz`; same with the base prefix. Screenshots in the session scratch, not in the repo |

Regenerate: `cd apps/web && VITE_AMP_HOOKS=1 pnpm build && nice -n 10 node --max-old-space-size=1536 scripts/previews.ts [--force] [--only id1,id2]`, then a production build (`pnpm build`) so `build/` has no hooks. Unchanged sims (sha256 of the sims file + generator version) are skipped; the manifest is rewritten after every sim.

## 5. Open items (O)
- O1: the previews were captured from the working tree at 08:34 PST, while lanes MC / MO / MT had uncommitted engine edits (runner worker, physics, post). Rerun with `--force` at integration (renderer or engine changes do not change the sims hash).
- O2: closed 2026-11-07 09:38 PST: markers, labels, guides and handles hidden by the capture stylesheet (they are SVG overlays).
- O7: closed 2026-11-07 10:00 PST (FOCUS entries). Same pattern open for ln-fbar-2d: its default plot (u_y of a 500 nm film across the full box) reads as a thin striped line at card size; a FOCUS entry or a plot on the film region would fix it.
- O8: closed 2026-11-07 10:05 PST (top inset in the 1D capture).
- O3: the 2D mesh view is the workbench's quality-coloured mesh mode; quarter models drawn mirrored in geometry / result (kirsch) show the quarter mesh in one quadrant of the shared crop.
- O4: the landing hides the same 6 EM-through-acoustics analogs as the workbench picker (rule copied from `Workbench.svelte`); previews exist for them.
- O5: `deploy/serve.mjs` (not this lane) has no `.webp` type (serves `application/octet-stream`; Chromium still draws them); Cloudflare Pages sets `image/webp`.
- O6: the workbench has no link back to the landing (not requested; a link edit in `Workbench.svelte` if wanted).
