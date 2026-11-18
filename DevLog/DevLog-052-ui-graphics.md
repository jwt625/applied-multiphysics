# DevLog-052: UI graphics and results display (lane E6, chunk 2, C4)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | E6 (DevLog-037 s.4.1, C4) |
| Owns | `apps/web/src/lib/gfx/**`, `apps/web/src/lib/results/**` except `api.ts`, `apps/web/src/lib/engine/protocol.ts`, `runner.worker.ts`, `spec-adapter.ts`, `apps/web/src/lib/post/**`, new tests `apps/web/test/e6-*.test.ts`, this file |
| Read | CLAUDE.md, DevLog-037 s.1 / s.4.1 (O-C1 in the 10:25 entry), DevLog-042 s.1.5 / s.6 R4 / s.7.7, DevLog-044 s.6 R-web-1, DevLog-040 s.5, DevLog-024, DevLog-038, DevLog-055 s.2 (E9 plan for O-C1); `gfx/**`, `results/**`, `engine/**`, `post/solid3d.ts`, `packages/physics/src/wave2d/index.ts` (Solution extras), `packages/mesh/src/spec.ts` |
| Status | done (s.5 results; s.6 requests; s.7 open items; s.8 hand-off) |

Conventions: F = fact read from code or a run; D = decision (reason given); O = open item; R = request.

## 1. Facts before planning (2026-11-18 13:22-13:30 PST)

- F: `solveWave2D` returns `Solution & { wave2d, notes?, normalization }`; `wave2d = { kind: 'emw' | 'acoustics', polarization?, field: 'Ez' | 'Hz' | 'p', freqs: number[], perFrequency: [{ f, S?: { keys: [{port: id, mode}], re[], im[] } (row-major nk x nk), beta?, srcPower?, farField?: { phi[] (rad, 360), sigma2d[] (m), band, bandCells } }], pml: { inner: Box, outer: Box } | null }`, Box = `{x0, y0, x1, y1}` (m). Fields per step: `<u>_re/_im/_abs` (H1P2), `<u>_sc_re/_im/_abs` (plane wave), DG0 vectors `H_re/_im` etc.; `steps = { kind: 'freq', values (Hz), unit: 'Hz' }`.
- F: the runner posts the Solution with `postMessage` (structured clone, field buffers transferred). Own enumerable properties (`wave2d`, `notes`, `normalization`) survive a structured clone; the session stores the object as is (`session.svelte.ts` l.291). Not yet verified in a browser.
- F: `Graphics.svelte` 1091 lines; field selector lists every field name; step selector prints `fmt(value) unit`; phase animation exists only for eigen steps (`Re(u e^(i phase))` is a sign flip of a real mode in 2D, uniform `amp` in 3D).
- F: colormaps: 4 (viridis, cividis, inferno, balance); `colormapLut(name, reverse)` and `Layer2D.reverse` and `cssGradient(name, reverse)` already exist; no UI for reverse, Viewer3D ignores it in `setColormap` callers.
- F: 3D exterior (`post/solid3d.ts exterior`) keeps the faces with one adjacent cell only, so internal layer / domain interfaces are not drawn. The runner meshes a mesh-only preview with `meshFromSpec(spec, {order: 1})` (extrude and mixed solids work); the coarse drag preview (`meshScale != 1`) goes through `spec-adapter.buildMesh`, which rejects anything but one box or one cylinder in 3D (R-web-1).
- F: `Workbench.show()` passes plot3d groups to Graphics as `plot`; Graphics draws plot2d only (badge "not drawn here").
- F: headline box (ui/Headlines, E5) sits at left 6 px, bottom 26 px; Graphics' group-note chips at left 6 px, bottom 22 px: they overlap (DevLog-040 s.5).
- F: O-C1: cut-line values come from `@amp/post cutLine` through `results/adapter.ts`; E9 (DevLog-055 s.2 item 2) adds `smooth: true` options to `@amp/post` sampling. The display path does no sampling of its own.

## 2. Plan

Order follows the brief's priorities; the split (6) is done first so the new features land in the split files and not in the 1091-line file.

1. Split `Graphics.svelte` without behaviour change (D: a `$state` class holds the user view state, so sub-components mutate it directly instead of 30 bindable props):
   - `gfx/view-state.svelte.ts` (class `GfxView`: wire, frame, mirror, range rule, scale, colormap + reverse, level, contours, raw, field lines, field, component, complex part, deformation, section / slice / iso, axes, camera preset);
   - `gfx/GfxToolbar.svelte` (the top bar), `gfx/GfxStatus.svelte` (invalid model, unavailable / computing, badges, group chips), `gfx/GfxFoot.svelte` (probe readout, dataset, mesh line);
   - `gfx/outline2d.ts` (boundary, highlight and PML segments, pure).
2. Complex results (`gfx/complex.ts`, pure, tested): groups `<u>_re/_im/_abs` (and `_sc_`) into one selector entry with a part selector Re, Im, |.|, phase, Re(u e^(j phi)); the shown field is built on the main thread from the step's `_re`/`_im` pair (nodal ops, same space); phase in rad, cyclic map; phase animation: two raw lattices (Re, Im) from the post worker, combined per frame `cos(phi) Re - sin(phi) Im` with a fixed symmetric range +-max |u| (no colour-range jumps); paused = the exact smooth path at the slider phase. Frequency step selector labelled with engineering prefixes in Hz (`fmtEng`).
3. Protocol: `engine/protocol.ts` declares `SolutionExtras` (`wave2d`, `notes`, `normalization`) and a guarded reader `wave2dOf(sol)`; the runner keeps posting the object as is (structured clone) and logs nothing new. Solver notes shown as a chip with the notes in its tooltip.
4. Driven plots (`gfx/ResultInset.svelte` inset over the 2D view, toggled from the toolbar; data from `sol.wave2d`): S-parameters |S| in dB and phase (deg) vs frequency (Hz with prefix), one series per (i, j) of the reported keys, uses `results/LinePlot.svelte`; far field: `gfx/PolarPlot.svelte` sigma2d(phi) polar with linear / dB toggle, plus a Cartesian view through LinePlot. Single frequency: S shown as markers and a table row in the tooltip. Band / array results (E4): a 1D plot of any `number[]`-valued array result found on the solution (generic reader; finalised when E4's shape is known).
5. PML outline: inner box of `wave2d.pml` as dashed segments in the 2D overlay, labelled in a tooltip.
6. Axes: 2D frame ticks with the length unit, a scale bar, toggle (axes / scale bar / none); 3D axis triad (SVG, projected each frame). Colormaps: add sourced tables (plasma, magma, turbo, twilight (cyclic, for phase), gray, RdBu) if a local generator is available (validation/.venv matplotlib), else only the reverse switch; reverse in 2D, 3D, colorbar. Colorbar min label room; group chips moved off the headline box; cut-line labels kept inside the canvas.
7. 3D: `gfx/camera.ts` exports `CAMERA_PRESETS` and `setCameraPreset(preset, lookAt?) : boolean` (registry like `capture.ts`; false when no 3D view is mounted); toolbar select; plot3d groups drawn through the plot2d group path (surface expression / field reference, range, colormap; items without a 3D drawing listed as not drawn); coarse 3D preview through `meshFromSpec` with scaled sizes (R-web-1); exterior extraction tested on a 2-layer stack.
8. View state in the link: `gfx/view-link.ts` (pure encode / decode, tested round trip) + Graphics applies `v=` from `location.hash` on mount and registers a `viewCode()` getter; the share URL line in Workbench is a request (R1).
9. O-C1: no own sampling; when E9's `smooth` option lands, `results/adapter.ts` passes it for line graphs of DG0 fields (one line), else request.

Validation: `pnpm --filter @amp/web check` clean; `pnpm --filter @amp/web test` with new `test/e6-*.test.ts` (complex ops, colormap reverse, link round trip, exterior facets, camera preset math); e2e smoke 0 fail on port 41743; screenshots reviewed (driven Re and phase, S-parameters, far field, 3D stack, camera preset, band plot if available), one per feature kept under `logs/`.

## 3. TODO

- [x] split Graphics.svelte (partial: status, notes, foot, complex controls, 3D tools, outline2d; the main toolbar stays, O1)
- [x] complex.ts + part selector + phase animation + Hz labels
- [x] protocol SolutionExtras, notes chip
- [x] DrivenInset (S-parameters, far field polar, band diagram), PML outline
- [x] axes / scale bar / triad, colormaps + reverse, colorbar / chips / cut-line label fixes
- [x] camera.ts + toolbar; plot3d groups; 3D coarse preview via meshFromSpec
- [x] view-link.ts + mount (share line: R1)
- [x] O-C1 wired to E9's smooth option
- [x] tests e6-*, check, test, e2e, screenshots
- [x] hand-off

## 4. Progress log

- 2026-11-18 13:29 PST: read the brief's inputs; facts s.1; plan s.2.
- 2026-11-18 13:46 PST: D: the split (plan item 1) moved to the end: features land first, in new files where possible (complex.ts, driven.ts, camera.ts, view-link.ts, DrivenInset.svelte, PolarPlot.svelte), so the split is one mechanical step over the final code.
- 2026-11-18 13:46 PST: colormaps: plasma, magma, twilight (cyclic), gray generated with matplotlib 3.11.2 from `validation/.venv` by the 2026-11-06 rule (256 equal steps, 8-bit rounding); the same script reproduces the existing viridis table byte for byte. RdBu (ColorBrewer, Apache-2.0) and turbo (Apache-2.0) left out (NOTICE text would be needed). The twilight author is not stated in the matplotlib source: not named.
- 2026-11-18 13:46 PST: complex display, protocol extras, driven inset, PML outline, axes / scale bar, 3D triad, camera presets, plot3d groups, view link, R-web-1 coarse 3D preview through meshFromSpec. svelte-check clean on my files (3 transient errors in `packages/physics/src/wave2d/index.ts` from lane E4's edit in progress, gone at the next run).
- 2026-11-18 13:46 PST: coordinator relay of E7 R1: `registerViewHooks` (probes, probeAt, quickView, setQuickView) added in Graphics.svelte per DevLog-053 s.6, adapted to complex entries (quickView `fields` lists the selector entries; setQuickView accepts entries and raw field names). E7 confirmed `setCameraPreset` works (pzt4-cube preset top, look_at front). svelte-check 0 errors.
- 2026-11-18 13:46 PST: tests `apps/web/test/e6-{complex,colormap,link,camera,driven,exterior}.test.ts`: 24 / 24 pass.
- 2026-11-18 13:54 PST: first browser runs (dev server 41743, headless shell, `<scratch>/shot.mjs`): pec-post-scattering (E1 sim) solves; `sol.wave2d` and `sol.notes` arrive on the main thread unchanged through the structured clone (F, `session.solution.wave2d` present); |Ez| view, PML outline, axes, far-field polar inset drawn. Two defects seen in the screenshots and fixed: (1) phase drawn by linear interpolation of arg values smeared every branch cut into a dark band (twilight passes through its dark middle between +pi and -pi); now Re and Im lattices are passed to the renderer (`Layer2D.values2`, `complex`) and |u|, arg u and Re(u e^(j phi)) are combined per fragment (atan2 per pixel: no smearing; the phase animation is a uniform, nothing uploaded per frame); (2) the inset covered the second and third toolbar rows: it now opens below the measured toolbar height.
- 2026-11-18 13:54 PST: coordinator relay of E9 (O-C1 done in `@amp/post`): `results/adapter.ts evalDataset` (cut line, cut point and edge dataset values for 1D line graphs) passes `smooth: true`; point items, max / min, integrals keep the exact cell values (D: point items are evaluation numbers compared with references; changing them is not a display decision).
- 2026-11-18 14:00 PST: split (s.2 item 1, reduced): `GfxStatus.svelte` (badges, unavailable / computing messages; badges now stack below the measured toolbar height instead of a fixed 36 px), `GfxNotes.svelte` (chips), `GfxFoot.svelte`, `ComplexControls.svelte`, `Tools3D.svelte`, `outline2d.ts` (facet segments). D: no `$state` class for the user view state (plan s.2 item 1): the remaining toolbar is the only consumer and the bindable props of the two extracted toolbar parts were enough. Defect found in the browser and fixed: `.top > *` is scoped by Svelte, so buttons rendered by a child component inherited `pointer-events: none` and the canvas took their clicks; now `.top > :global(*)`.
- 2026-11-18 14:05 PST: e2e smoke run 1 (logs/T1-e2e-20261118T220045-summary.md): 74 checks, 64 pass, 10 warn, 0 fail (warns are the single-level Richardson comparisons, as in DevLog-038). Web unit tests 115 / 115. The run overlapped the split edit (pages loaded after 14:00 got the split code); a full rerun follows.
- 2026-11-18 14:10 PST: coordinator relay of E4 R4: band diagrams from `sol.wave2d.bands` (Bands inset: one line per band over the path length in 1/m, labelled vertical lines at `labels[i].index`, f in Hz with prefix or f a / c0 with a = |a1| from `lattice.a`); the step selector labels eigen steps from `fieldSteps` ("M band 1: 84.14 THz"). `wave2dOf` accepts a bands-only extras object (no `freqs`). `LinePlot.svelte`: optional `legend` (keys without the log toggles) and `xMarks` (labelled vertical lines).
- 2026-11-18 14:15 PST: screenshots reviewed (s.5.3). O-C1 check: si-slab-te0 `E_line` (normE, 400-point cut line) is a smooth profile, no staircase.
- 2026-11-18 14:16 PST: final e2e rerun started; results s.5.2.
- 2026-11-18 14:21 PST: final e2e (logs/T1-e2e-20261118T221623-summary.md): 77 checks, 57 pass, 12 warn, 8 fail. None is a graphics failure: (a) 4 browser-RSS failures, all sims with a parametric sweep: hadley-rib-wo02 1354 -> 2134 MB, mmi-1x2-splitter 1490 -> 2600, ring-resonator-bus 1119 -> 2329, si-rib-waveguide 1450 -> 2050 MB between run 1 (14:00) and this run; sweep sims that passed grew too (pec-post-scattering 1002 -> 1547, bragg-mirror-ports 1138 -> 1848), sims without a sweep did not (au-air-spp 817 -> 862). E (inference, not measured per process): the multi-worker sweep pool of lane E8 (`engine/pool.ts`, used by `session.svelte.ts`) holds one worker per sweep point in flight; (b) 4 reference failures of the new em-modes cases WO-80..WO-83 (au-air-spp, leaky-si-wire, tfln-rib-air, tfln-rib-oxide) with tolerances `after: finest` compared at one browser level (the e2e downgrades only `after: richardson` to a warning). Routed as R6, R7. Dev server on 41743 stopped.

## 5. Results

### 5.1 Features (all in owned paths)
| Item | Where | Notes |
|---|---|---|
| Complex fields | `gfx/complex.ts`, `ComplexControls.svelte`, Graphics | `<u>_re/_im/_abs` (and `_sc_`) are one selector entry "(complex)"; parts Re, Im, abs, phase (rad, -pi..pi, twilight), Re(u e^(j phi)) with a phase slider (deg) and Animate (0.5 cycle/s). Re and Im draw the solution field itself (exact P2 per pixel). abs, phase and Re(u e^(j phi)) draw the exact Re / Im lattice values interpolated linearly and combined per fragment (`renderer2d` `values2` + `complex` uniform): no seam at the phase branch cut, the animation only changes a uniform. Re(u e^(j phi)) range fixed to +-max abs u. Opening part follows the spec's plot expression (`_abs` -> abs). Hover readout of abs / phase interpolates the nodal part values (O3). |
| Frequency steps | Graphics `stepLabel` | engineering prefix (e.g. "14 GHz", "249.8 THz"); band studies "M band 1: 84.14 THz" |
| Protocol | `engine/protocol.ts` | `SolutionExtras`, `Wave2DExtras`, `Wave2DBands`, `wave2dOf()`, `notesOf()`; no wire change (structured clone already carried `wave2d` and `notes`; verified in the browser: `session.solution.wave2d` present for pec-post-scattering, bragg-mirror-ports, phc-square-rods-bands) |
| Solver notes | `GfxNotes.svelte` | chip "n solver notes", text in the tooltip |
| S-parameters | `gfx/driven.ts`, `DrivenInset.svelte` | abs S in dB or phase in deg (unwrapped along frequency, wrap toggle) vs f (prefixed Hz), one input column at a time (select), legend per S_ij; tooltip states the largest deviation of sum_i abs(S_ij)^2 from 1 |
| Far field | `PolarPlot.svelte`, `DrivenInset.svelte` | sigma_2D(phi) polar (linear with m prefixes, or dB re 1 m floored 40 dB below the max) or over phi; at the shown frequency |
| Band diagram | `DrivenInset.svelte`, `driven.ts bandSeries` | E4 R4 (log 14:10) |
| PML outline | Graphics `pmlBoxes`, `Canvas2D boxes` | dashed inner box, label and tooltip |
| Axes | `Canvas2D` | axes along the model box clamped into view (x, y or r, z; length unit), scale bar (1-2-5 near 100 px), or none; default axes in the workbench, scale bar in Play |
| 3D triad | `Canvas3D`, `Viewer3D.triad()` | x, y, z projected each frame, lower right |
| Colormaps | `colormaps.ts` | + plasma, magma, twilight (cyclic), gray; reverse in 2D, 3D, colorbar |
| DevLog-040 s.5 | Colorbar, GfxNotes, Canvas2D | colorbar labels get 57 px (was 50; "-6.10e-6" fits); chips moved to the bottom right (off the headline box); cut-line / cut-point labels flip left at the right edge and stay inside vertically |
| Camera presets | `gfx/camera.ts` | API in s.8; toolbar "view" select; E7 confirmed the API (pzt4-cube, preset top, look_at front) |
| plot3d groups | Graphics | drawn through the plot-group path (surface expression or field reference, range, colormap; deformation via the solution's displacement); other 3D items listed as not drawn |
| 3D preview | `engine/spec-adapter.ts` | coarse drag preview of any 3D spec through `meshFromSpec` with scaled sizes (R-web-1); exterior faces only (`post/solid3d exterior`, tested) |
| View in the link | `gfx/view-link.ts` | `v=` hash parameter (mode, field, part, comp, step, phase, colormap, reverse, rule, log, axes, camera pose); applied on mount, step on the first solution; share line in Workbench is R1 |
| O-C1 | `results/adapter.ts evalDataset` | `smooth: true` (E9's @amp/post option) for line, point and edge dataset values (1D plots); evaluation items unchanged |
| E7 R1 | Graphics | `registerViewHooks` (probes, probeAt, quickView, setQuickView), complex entries listed |
| Internal shorthands | Graphics | removed "in R2", "stages R4 / R5" from group notes (user-visible) |

### 5.2 Checks
- `pnpm --filter @amp/web check`: 0 errors, 0 warnings (1526 files), last at 14:16 PST.
- `pnpm --filter @amp/web test`: 115 / 115 (run during e2e run 1), 119 / 119 at 14:22 PST (final); e6 files 25 / 25 after the band test (complex 7, colormap 3, link 4, camera 3, driven 6, exterior 2).
- e2e smoke: run 1 14:00-14:06 PST 74 checks, 64 pass, 10 warn, 0 fail; final run 14:16-14:21 PST 77 checks, 57 pass, 12 warn, 8 fail (none from this lane; s.4 14:21, R6, R7).

### 5.3 Screenshots reviewed (logs/, one per feature)
`E6-driven-re.png` (Re Ez, balance, PML box, axes in mm), `E6-driven-phase.png` (arg Ez, twilight, no seams), `E6-sparams.png` (bragg-mirror-ports with 21 wavelengths 1.2-1.95 um patched into the study in the browser: stop band near 170-225 THz, S11 near 0 dB, S21 near -8 dB; mode-1 entries near -140 dB), `E6-farfield.png` (pec-post-scattering 14 GHz, forward lobe about 300 mm), `E6-bands.png` (square rods r 0.2 a, eps 12, TM, f a / c0: band 1 max about 0.28, band 2 min about 0.42, consistent with the MPB gap 0.2807 / 0.4172 in DevLog-050), `E6-3d-stack.png` (die-warpage-3d extrude stack, two layer colours, triad), `E6-camera-front.png` (preset front: x right, z up; pose target = model centre), `E6-cutline-dg0.png` (si-slab-te0 normE cut line, smooth), `E6-plot3d.png` (pzt4-cube plot3d group u_short: displacement magnitude with deformation), `E6-link.png` (page opened with `#v=` code: plasma reversed, scale bar, Re(Ez e^jφ) at 57 deg; `currentViewCode()` returned the same state).

## 6. Requests (exact)

- R1 (E5, `apps/web/src/lib/workbench/Workbench.svelte`, share with the view state): add the import and wrap the URL of `copyShare` (line 369):
```ts
import { withViewCode } from '../gfx/view-link';
// line 369, replace
const url = `${location.origin}${location.pathname}?sim=${encodeURIComponent(simId)}${s.model.sharePatch().length ? `#d=${s.model.shareCode()}` : ''}`;
// with
const url = withViewCode(`${location.origin}${location.pathname}?sim=${encodeURIComponent(simId)}${s.model.sharePatch().length ? `#d=${s.model.shareCode()}` : ''}`);
```
- R2 (E5, same file, `showPlot`, line 262): plot3d groups are drawn now; replace `return r[i]!.type === 'plot3d' ? { ok: true, message: '3D plot groups are drawn from stage R4; the graphics pane shows a not-drawn badge' } : { ok: true };` with `return { ok: true };`; the comment above `show()` ("3D groups are drawn in stage R4") is outdated.
- R3 (coordinator, `apps/web/NOTICE`, colormaps bullet): add "plasma, magma (BIDS mpl-colormaps, Nathaniel Smith and Stefan van der Walt), CC0 1.0; twilight, as distributed in matplotlib 3.11.2 under the matplotlib licence (BSD-style); a separate licence for the table was not verified; gray: linear ramp (no third-party data)."
- R4 (sims owner, `sims/cylinder-cavity.yaml` and `sims/cylinder-cavity-qd.yaml`): plot3d item `E_mode_surf` has `expr: rf.normE`, which the solution does not have (fields `E` (NED2) and `E_nodal` (H1P2)); the group now shows "1 not evaluated: unknown variable 'rf.normE'". Suggested `expr: rf.E_nodal.norm` (the expression language's `.norm` component), not verified against the cavity sims.
- R6 (coordinator / E8): browser RSS of sweep sims over 2 GB in the e2e after the worker pool landed (s.4 14:21); a pool size bounded by memory, or 1 under the e2e, would restore the limit.
- R7 (coordinator / T1 e2e rule or E2 cases): WO-80..WO-83 tolerances `after: finest` fail at one browser level; either the e2e treats `after: finest` like `after: richardson` (warning) or the cases gate differently.
- R5 (coordinator, CONTRACTS-v0 changelog, web worker protocol, typing only): "2026-11-18 (E6, DevLog-052): apps/web `engine/protocol.ts` types the Solution extras `wave2d` (driven: freqs, perFrequency S / farField / beta / srcPower, pml boxes; bands: labels, distance, f, lattice, fieldSteps), `notes`, `normalization`; no message change." E8: no change needed in `engine/client.ts`.

## 7. Open items

- O1: `Graphics.svelte` is 1205 lines (1091 before this lane, grown by the features, then reduced by the split). Extracted: status, notes, footer, complex controls, 3D tools, outlines. The main toolbar (about 110 lines of markup, 25 state values) and the plot-group block remain; a further split needs the view state in one `$state` class (planned, not done).
- O2: S-parameters are plotted over the frequencies of one study; a parametric sweep over frequency (e.g. pec-post-scattering `sweep`) gives one frequency per sweep point, so its spectrum belongs to a sweep-vs-parameter plot (E5) over the per-point scalars `S<i><j>_dB`.
- O3: hover / click probes of abs and phase interpolate the nodal part values (exact for Re, Im and Re(u e^(j phi)), approximate for abs and phase between nodes); the drawn colours use the per-pixel combination.
- O4: 3D: the axis triad is small (20 px arms); the camera select shows the last preset after a free orbit; lookAt of a revolved view is relative to the revolved surface centre.
- O5: series colours repeat after 6 (band 7, 8 share colours with bands 1, 2).
- O6: complex DG0 vectors (`H_re/_im`): phase and Re(u e^(j phi)) are drawn per component (no magnitude), by design.

## 8. Hand-off

Camera API (for E7, `apps/web/src/lib/gfx/camera.ts`):
```ts
export const CAMERA_PRESETS = ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right'] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];
/** z up; preset = direction from the look-at point to the camera; distance = fit distance of the model box.
 *  lookAt in model coordinates (m). false: no 3D view mounted, unknown preset, or lookAt not 3 finite numbers. */
export function setCameraPreset(preset: string, lookAt?: [number, number, number]): boolean;
export function hasCameraView(): boolean;
export function cameraPose(): { pos: [number, number, number]; target: [number, number, number] } | null;
export function applyCamera(p: CameraPose | CameraPreset): void; // now, or when the next 3D view mounts
```
View link: `gfx/view-link.ts` `encodeView`, `decodeView`, `viewCodeOf(hash)`, `withView(url, code)`, `currentViewCode()`, `withViewCode(url)`.
Files: `apps/web/src/lib/gfx/{Graphics,Canvas2D,Canvas3D,Colorbar,DrivenInset,PolarPlot,ComplexControls,Tools3D,GfxStatus,GfxNotes,GfxFoot}.svelte`, `gfx/{complex,driven,camera,view-link,outline2d,colormaps,renderer2d,viewer3d}.ts`, `results/{LinePlot.svelte,adapter.ts}`, `engine/{protocol,spec-adapter}.ts`, `apps/web/test/e6-{complex,colormap,link,camera,driven,exterior}.test.ts`. Dev server for screenshots: `scripts/e2e-vite.ts` (HMR off) on 41743, stopped at the end. No git, no installs.

## Integration fix: flat 3D elastic previews

2026-11-18 15:29 PST. Landing previews `die-warpage-3d-result` and `tsv-stress-3d-result` showed one flat teal colour.
- Cause (reproduced in headless Chromium on the hooks build): not a renderer bug. The quick view opened on the first drawable field, `ht.T`, which is exactly uniform in both sims (T_use prescribed on both faces, no source: 298.15 K everywhere); `mapping` pads a zero-width range by 1 % each side, so every vertex sat at the viridis midpoint. The deformation shown was the elastic displacement, hence the bowed but uncoloured plate. The spec's 3D plots were ignored on two paths: `surfaceItems` (spec) lists only `surface` items, so the `volume` items `solid.u.z` / `solid.mises` never chose the opening field (and `solid.u.z`, a component expression, did not match a field key); and a shown plot3d group with a `volume` item had no base item (`gBase` took `surface` / `contour` only), so it fell back to region colours.
- Fix (`apps/web/src/lib/gfx/Graphics.svelte` only): `gBase` takes a `volume` item in a 3D group (exterior coloured by its expression; group notes updated; 3D colorbar label = item label or expression); the opening field also considers volume items of plot3d groups and resolves component expressions through `fieldRef`; with no spec plot it skips fields that are constant over the mesh. No sims file changed.
- Verification: repro shows quick view `solid.u` magnitude (0 to 5.27e-5 m) for die-warpage-3d and `solid.mises` (47.8 to 272 MPa) for tsv-stress-3d; showing group `warp_3d` draws u_z -52.2 to 0 um. Previews regenerated (`--only die-warpage-3d,tsv-stress-3d --force`, log `logs/previews-20261118T232856.json`) and inspected: graded |u| across the plate, Mises concentrated at the via interface. `pnpm --filter @amp/web check` 0 errors, `pnpm --filter @amp/web test` 129 pass.
- Note: `scripts/previews.ts` picks only plot2d groups, so 3D sims are captured in the quick view (die-warpage-3d shows |u|, not the spec's u_z).
