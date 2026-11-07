# DevLog-015: Visual design pass (lane V1)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | V1 (visual design pass of the Play views, the workbench results and the RT panels) |
| Owns | `apps/web/**`, this file |
| Inputs | DevLog-001 s.6 (binding guidelines) and s.12 TODO "Visual design pass"; `DevLog/audits/2026-11-06-L5-web-audit.md` s.3; DevLog-011 s.7-8; R5 s.2; R4 s.5; `dataviz` skill (form, colour jobs, hero number, anti-patterns) |
| Read only | everything outside `apps/web` (sims, packages, eval, materials) |
| Gates kept | `pnpm check`, `pnpm build`, `pnpm test`; FCP < 100 ms; drag previews < 1 s; 0 long main-thread tasks during drags; browser mesh hash = Node; stale-result tagging; CSP unchanged |

## 1. Plan (written 2026-11-06 17:45 PST, before coding)

Starting point (my own review of `logs/L5-play-*-20261107T013227.png`, 1440 and 390): the physics is right, the presentation hides it. Ratings in s.4.

### 1.1 Shared (all views, workbench included)

1. **Colorbar outside the field.** The canvas sits in a stage that excludes a fixed colorbar strip (right, 84 px; bottom strip of 52 px on phones). Nothing can draw under the colorbar; the camera fit no longer needs a right pad.
2. **Smooth camera.** 2D view changes (fit, ROI/all, re-frame after a drag) ease over about 350 ms (log-scale zoom, linear pan). 3D fit eases likewise. Camera only: no field is interpolated.
3. **Headline on the canvas.** The spec's headline results (scalar/probe, already computed in spec units by `post/headline.ts`) move from the aside to a large overlay at the top-left of the field: symbol with subscript (K_t, B_center, T_E), value 4 significant figures, unit with display symbols. A brief highlight when a new fresh value arrives (it encodes "changed"; no tweened numbers). Eigen views: the selected mode's frequency (engineering prefix) and its m.
4. **Engineering units.** Module scalars and mode lists in SI get engineering prefixes (3.02e6 Pa -> 3.02 MPa, 5.20e-7 m -> 520 nm, 2.904e9 Hz -> 2.904 GHz). Display only; spec units stay ASCII.
5. **Contours.** About 12-16 levels at a nice step, thin, semi-transparent dark lines; contour levels shown as ticks on the colorbar. Field lines (axisymmetric B) as light lines.
6. **Peak marker.** Crisp: pixel-snapped crosshair, leader line, label box with value and unit; never outside the canvas.
7. **Symmetry mirroring (2D).** Per hero, from the model's symmetry (kirsch: rollers on x = 0 and y = 0; helmholtz: axis r = 0). Each mirrored copy reuses the GPU buffers with a reflected transform and the field's parity (sxy, u_x, u_y, Br, A_phi odd under the matching reflection; sxx, syy, szz, mises, |u|, normB, Bz even). Fields with no stated parity are not mirrored. Boundary lines on symmetry planes are dropped in the mirrored view. A "mirrored" badge carries the tooltip; a toggle turns it off. Probe on a mirrored point evaluates the computed point and applies the parity. Mesh mode is not mirrored (it shows what was computed).
8. **3D shading.** Smooth per-vertex normals (crease angle 35 deg) from the post worker; lighting as a luminance modulation of the LUT colour (key + fill Lambert, small Blinn specular, view-angle silhouette darkening), face-forwarded for sections. tet10 exterior faces split into 4 triangles through the mid-edge nodes (curved, exact P2 nodal values at 6 points per face). A subtle radial background gradient behind 3D.
9. **Mobile.** Play aside becomes a bottom sheet (peek height with the grab bar, tap to expand); horizontal colorbar strip; canvas fills the rest.

### 1.2 Per view

| View | Changes |
|---|---|
| kirsch | mirrored full plate; ROI = 5 D square centred on the hole (fits on load; re-frames smoothly after a D change ends); "All" toggle frames the whole plate; ring only while dragging; contours at a nice step; peak marker crisp; K_t headline |
| heat-plate-fin | contour styling; T_E headline; probe point E marked (the spec's own probe location) |
| helmholtz-coil | mirrored about the axis (full section through the axis); B lines from r A_phi (exact in axisymmetry); ROI around the coil pair; B_center headline in µT |
| si-rib-waveguide | ROI around the rib; fix the slab handle (param `t_slab`, the handle read `t` and never showed); n_eff headline of the selected mode |
| cylinder-cavity (axisym, revolved) | revolved 3/4 cutaway with both meridional section planes filled with the field (exact nodal values, tri6 split into 4); line3 boundary mid nodes used (smooth profile); analytic smooth normals; instantaneous-magnitude animation |E| |cos wt| on first interaction (exact for a real lossless eigenmode); f headline |
| box-acoustics | lighting, edges, tet10 split; phase animation on first interaction (exists); f headline |
| RT panels | colorbar ticks and layout parity with the FEM views; mobile strip |

### 1.3 Verification

`apps/web/scripts/v1-shots.ts`: vite dev server on an uncommon free port (checked with lsof), headless shell screenshots of every view at 1440x900 and 390x844 (agent panel closed). Review each image, fix, repeat. Final: `pnpm check`, `pnpm test`, `VITE_AMP_HOOKS=1 pnpm build` + `scripts/shots.ts` for the L5 gates, then the production build. One final image per view kept as `logs/V1-*`.

## 2. TODO

- [x] DevLog plan (this file)
- [x] Coordinator message 2026-11-06 ~17:47 PST: (1) rib handle param `t` -> `t_slab`; (2) full-accuracy result after a drag with an accuracy badge, cold browser times at gated accuracy per hero (s.5)
- [x] Screenshot driver `scripts/v1-shots.ts`
- [x] Stage layout: colorbar strip, contour marks in the colorbar
- [x] Canvas2D: eased camera, ROI / All, peak marker, ring only while dragging
- [x] Renderer2D: mirrored copies with parity, contour opacity
- [x] Heroes: mirror config, ROI per hero, rib handle fix, headline symbols
- [x] Headline overlay + engineering units
- [x] 3D: smooth normals, lighting, tet10 split, background
- [x] Cavity cutaway with section planes, magnitude animation
- [x] Heat flux lines (added: the physics of the heat hero), helmholtz 1 % uniformity band, probe markers
- [x] Mobile bottom sheet
- [x] RT panel polish
- [x] Screenshot review loop, all views
- [x] L5 gates rerun
- [x] Ratings before/after (s.4), hand-off

## 3. Progress log

- 2026-11-06 17:40 PST: read CLAUDE.md, DevLog-001 s.6/s.12, L5 audit s.3, DevLog-011 s.7-8, R5 s.2, R4 s.5, dataviz skill; reviewed the 25 L5 screenshots; read Graphics, Canvas2D/3D, renderer2d, viewer3d, field-material, post worker, revolve, solid3d, heroes, Play, RtPanel. Plan written.
- 2026-11-06 17:47 PST: coordinator message (rib handle, full-accuracy result). Added to the plan as s.5.
- 2026-11-06 17:50-17:55 PST: `post/accuracy.ts`, Session full-accuracy sequence (second worker), heroes config (mirror, ROI, accuracy, symbols, rib handle `t_slab`), Renderer2D mirror copies, Canvas2D eased camera and crisp marker, Graphics mirroring / ROI / colorbar strip, Colorbar redesign, HeroHead overlay, Play bottom sheet.
- 2026-11-06 17:49 PST: first kirsch screenshot (dev server 127.0.0.1:47613, port checked free): mirrored full plate, ROI 5 D; accuracy sequence 3 levels, Richardson unavailable (oscillatory).
- 2026-11-06 17:52-17:56 PST: 3D: `exterior` rewritten (outward faces, tet10 split into 4, smooth normals), lit TSL material, revolve with line3 / tri6 mid nodes, cutaway and section planes. Cavity moire traced to em-axisym `E_rphiz` (H1P1) storing 0 at tri6 mid nodes (checked in Node on the h = 1 and 0.25 meshes); the viewer now treats H1P1 data on quadratic meshes by its corner values (exact P1 interpolant).
- 2026-11-06 17:56-18:00 PST: heat flux lines (`post/flux2d.ts`), probe markers, degC display of K scalars, rib ROI, revolved colorbar source fix (the colorbar came from the 2D lattice), workbench ROI + mirror, RT colorbar ticks and phone strip.
- 2026-11-06 17:57 PST: rib level h 0.5 (1.3M DOF) ended with "Maximum call stack size exceeded" inside em-modes; browser DOF cap 1M added (s.5).
- 2026-11-06 18:01-18:10 PST: tests 9/9 (3 new), verification build, `scripts/shots.ts` gates (s.6), helmholtz 1 % band, phone padding for the headline overlay, final screenshots, production build. Dev and static servers stopped. One read-only `git status` was typed by mistake in a shell line (it failed on a bad `head` flag); no other git.

## 4. Ratings (L5 audit 10-point scale; before = L5 audit s.3 / my review of the 013227 shots, after = `logs/V1-*-20261107T020855.png` and `-021158`)

| View | Before | After | One line |
|---|---|---|---|
| kirsch-plate | 5 | 8 | full plate by mirroring, 5 D ROI with eased re-frame, 13 contours with marks in the bar, crisp peak label, K_t large; the far-field sxx = 1 MPa contour still sweeps across the plate (it is real) |
| heat-plate-fin | 5 | 8.5 | isotherms plus heat flux lines (equal-heat seeding, arrows), T_E marked at E, °C everywhere; fin and transient variants still N/A in the spec |
| helmholtz-coil | 5 | 8.5 | full section through the axis, B lines from r A_phi, amber 1 % uniformity band around the centre, B_center at its probe point |
| si-rib-waveguide | 5 | 6.5 | ROI on the rib, n_eff headline, slab handle works; DG0 cells look faceted, no vector arrows, accuracy N/A in the browser |
| cylinder-cavity (axisym) | 4 | 8 | 3/4 cutaway with both meridional planes, smooth lit shell, exact P1 values (moire fixed), |E| cos animation on first touch, f and m headline |
| box-acoustics | 4 | 7 | lit faces, crisp edges, tet10 faces split; still a plain box (no cutaway or default isosurfaces) |
| RT panels | 7 | 7.5 | colorbar strip with ticks and tooltip, phone strip below the field; field colours come from @amp/rt (unchanged) |
| workbench results | 6 | 7 | ROI and mirroring for heroes, colorbar outside the field, lit 3D; the 170 px empty Messages pane is unchanged |

## 5. Full-accuracy result (coordinator order 2026-11-06 ~17:47 PST)

Design (`apps/web/src/lib/post/accuracy.ts`, `workbench/session.svelte.ts` `refine`):
- After every full run (hFactor 1, not during a drag) the Play view solves the same spec text at the remaining `convergence.h_factors` of the paired case ([1, 0.5, 0.25] for SM-01, HT-01, EM-04, RF-21, AC-02; WO-02 lists none, so the nested ratio-2 default is used and said so). `prepareRun` makes these levels nested (uniform refinement of the hFactor-1 mesh).
- A second worker runs the sequence; any edit terminates it at once, so drag previews never wait on it. Each finer real solution replaces the displayed one (coarse to fine), with `h` and DOF under the headline.
- The headline quantity per level (kirsch K_t, heat T_E, helmholtz B_center, rib n_eff of mode 0, cavity and box: every eigenfrequency, the selected mode shown) goes through the eval harness's own rule (`packages/eval/src/metrics.ts` `richardsonRule`, imported read-only): observed order within 25 % of the case's `expected_order`, GCI of the finest level with the case's safety factor.
- Badge: "est. err X <= tol Y CASE" (green border) only when Richardson is available and the GCI is within the case tolerance; amber when above; otherwise "last change X rel, order N/A" or "accuracy N/A" (grey) with the reason. The tooltip lists every level (h, DOF, time, value), the observed order, the extrapolated value, and states that the estimate is the discretization error of this model only (hero-vs-case spec differences, e.g. the finite W/D = 20 plate, are not included).
- Browser cap: a level whose predicted DOF (dof(1) / h^dim) exceeds 1M is not attempted.

Cold browser times at gated accuracy (`logs/V1-shots-20261107T021004.json`; production-equivalent static build with hooks, headless chrome-headless-shell 151, SwiftShader WebGL, M4 Pro shared with other lanes; "load to gated" = navigation start to the end of the sequence):

| Hero | Case, tol | Levels (DOF, worker ms) | Load to gated | Estimate |
|---|---|---|---|---|
| kirsch-plate | SM-01, rel 1e-3 | 10,810 / 233; 42,796 / 431; 170,296 / 1,469 | 2.22 s | Richardson unavailable (oscillatory: K_t 3.021234, 3.021354, 3.021308); last change 1.5e-5 rel |
| heat-plate-fin | HT-01, rel 1e-3 | 15,339 / 240; 60,970 / 435; 243,108 / 1,361 | 2.14 s | GCI 1.7e-7 <= 1e-3 |
| helmholtz-coil | EM-04, rel 1e-3 | 14,645 / 200; 58,993 / 446; 236,801 / 1,413 | 2.17 s | Richardson unavailable (observed order 4.74 vs expected 2); last change 6.4e-6 rel |
| si-rib-waveguide | WO-02, abs 5e-6 | 328,754 / 2,959 | N/A | level h 0.5 (1.3M DOF predicted) above the 1M cap; when tried (17:57) em-modes failed with "Maximum call stack size exceeded" |
| cylinder-cavity (axisym) | RF-21, rel 1e-5 | 4,103 / 257; 16,822 / 716; 68,117 / 1,398 | 2.50 s | GCI 1.7e-8 <= 1e-5 (TM010 2.903636 GHz at h 0.25) |
| box-acoustics | AC-02, rel 1e-4 | 693 / 243; 4,641 / 383; 33,825 / 3,285 | 3.99 s | GCI 5.4e-7 <= 1e-4 (f_1 171.5001 Hz at h 0.25) |

Not measured: a real GPU browser; the 3D Nedelec cavity (`?solver=3d`, no sequence); the rib below the cap.

## 6. Gates (`logs/V1-shots-20261107T021004.json`, tests `logs/V1-test-*.log` last run 9/9, production build `logs/V1-build-20261106T181238.log`)

| Gate | Result |
|---|---|
| `pnpm check` / `pnpm test` / `pnpm build` | 0 errors 0 warnings (1380 files) / 9/9 (new: tet10 exterior area and outward normals, P2 gradient exactness, accuracy verdict never "within" without Richardson) / ok, production build has 0 hook references |
| FCP medians | `/` 37.0 ms, `/play/kirsch-plate` 37.6 ms, `/play/rt/lbm-d2q9` 36.2 ms |
| Drag previews (median / max) | kirsch 53 / 83 ms, heat 26 / 42, helmholtz 49 / 75, rib 399 / 633, cavity 31 / 104, box 17 / 24; canvas-handle drags 1 op each |
| Long tasks during drags / during the accuracy sequence | 0 / 0 in all six |
| Mesh hash browser = Node | 6/6 at hFactor 1, and every nested level (h 0.5, 0.25) equal to Node `prepareRun({hFactor})` in the five heroes that ran them |
| Stale tagging, B1, op log, agent mock, B2 | B1 W_m ratio 4 and undo restores (run with the sequence off so both values share a mesh); op log round trip byte-identical; agent mock D 10 -> 20 mm, rerun fresh, undo restores bytes; phone switcher 4/4 |
| CSP | unchanged (same meta directives and `_headers`) |
| Page / console errors | none |

`scripts/shots.ts` changes: waits for the accuracy sequence before the hash and drag checks, compares every level's mesh hash with Node, records `accuracy` per hero, switches the sequence off for B1, waits 0.6 s for the eased camera before the handle drag, log prefix from `TAG` (default L5).

## 7. Hand-off

Files (all under `apps/web`):

| Path | Change |
|---|---|
| `src/lib/post/accuracy.ts` (new) | full-accuracy definitions, case convergence and tolerance, per-level values, Richardson, verdict |
| `src/lib/post/flux2d.ts` (new) | heat flux lines (exact element gradients, equal-inflow seeding, RK2) |
| `src/lib/play/HeroHead.svelte` (new) | headline overlay with symbols, accuracy badge and tooltip |
| `src/lib/workbench/session.svelte.ts` | `accuracy`, `acc`, `solutionLevel`, `refine`, `stopRefine`, DOF cap; `MeshInfo.hFactor` |
| `src/lib/play/heroes.ts` | ROI (FOCUS) per hero, MIRROR (planes, parity), SYMBOL, ACCURACY, BAND; rib slab handle on `t_slab` |
| `src/lib/play/Play.svelte`, `RtPanel.svelte` | overlay, re-frame after gestures, engineering units, bottom sheet; RT colorbar ticks and phone strip |
| `src/lib/gfx/Graphics.svelte`, `Canvas2D.svelte`, `renderer2d.ts`, `Colorbar.svelte` | stage + colorbar strip, mirroring with parity, ROI / All, eased camera, contours and marks, crisp markers, probe markers, flux lines, uniformity band, cutaway toggle |
| `src/lib/gfx/viewer3d.ts`, `field-material.ts`, `Canvas3D.svelte`, `post/solid3d.ts`, `post/revolve.ts`, `post/post.worker.ts` | smooth normals, lighting, tet10 split, polygon offset for edges, revolved cutaway and mid nodes, magnitude animation, flux job |
| `src/lib/gfx/ticks.ts`, `ui/Headlines.svelte`, `post/headline.ts`, `workbench/Workbench.svelte` | `fmtEng`; phone placement; probe location; workbench ROI + mirror |
| `scripts/v1-shots.ts` (new), `scripts/shots.ts`, `test/post.test.ts` | review driver; gates (s.6); 3 tests |

Findings for other lanes (not changed here, read-only):
1. L4 em-axisym: `E_rphiz` is declared H1P1 but has length 3 x nNodes on tri6 meshes with 0 at the mid nodes (`nodalFields` fills corners only). Either length 3 x nCorners, or the P1 interpolant at the mid nodes, would avoid the trap; the viewer now uses corners for H1P1.
2. L4 em-modes: the rib at hFactor 0.5 (1.3M DOF predicted) fails with "Maximum call stack size exceeded" in the browser worker (2026-11-06 17:57); the rib has no browser accuracy estimate until that is fixed or a smaller window is used.
3. Kirsch K_t (nodal max over the hole edge) oscillates over the nested levels (3.021234, 3.021354, 3.021308): the harness rule declares Richardson unavailable; the SM-01 probe form (sxx at (0, a)) may behave better.

Open (not done): ground plane and screen-space outline pass in 3D (silhouettes are view-angle darkening plus feature edges); E/H arrows or Poynting particles for the cavity; isosurfaces by default for the box; LIC; the workbench's empty Messages pane; RT colormaps (owned by @amp/rt).

## 8. Audit corrections (audit `DevLog/audits/2026-11-06-web-pass2-V1-audit.md`, coordinator order 2026-11-06 ~18:35 PST)

| # | Disposition | Change | Evidence |
|---|---|---|---|
| B1 | fixed | The eigen badge now uses the solver's mode index of the displayed level (no filter). On every other level, the mode with the nearest frequency and the same m (axisymmetric solves) stands for it; a mode not found within 5 % is N/A. A 0 Hz mode (rigid body or constant field) is N/A. The tooltip lists the shown mode's own values per level. The tolerance is that of the case metric whose reference frequency is within 2 % of the shown mode (f_mode1, f_mode2, ...); a mode with no metric shows no tolerance. Code: `post/accuracy.ts` `series`, `caseRef`, `verdict` | box f_1 171.50007 Hz: mesh err 5.39e-7 vs tol 1e-4 (AC-02 f_mode1); f_2: 1.32e-6 (f_mode2); 0 Hz: N/A; cavity: 4 modes matched to f_TM010, f_TE111, f_TM011, f_TE211 (`logs/V1-shots-20261107T024535.json` `accuracy`). Test: box levels with a leading 0 Hz mode, plus a level with modes in another order |
| S1 | fixed | An invalid model shows "Model invalid" with each issue in readable form on the canvas, e.g. "D = 15 mm outside range 1-10 mm" (`state/issues.ts`), with "nothing is computed until the model validates (Undo restores the last valid state)". The earlier geometry is dimmed under a "model invalid: earlier geometry" badge. The Play aside shows the same text. A run that fails with a valid model shows "Run failed" and the worker's message. Agent edits take the same path (the view reads the model's own validation) | `logs/V1-play-kirsch-plate-invalid-1440-20261107T024815.png` |
| S2 | fixed for the level hand-over | Refined-lattice cap lowered from 1.2e6 to 3e5 sub-triangles (kirsch h 0.25: r 2; heat h 0.25: r 1). The surface of revolution is built in the post worker and transferred. Renderer2D warms its program with one degenerate draw per mode at creation, so a driver that compiles at first draw (SwiftShader) does it at load. CPU profiles (removed temporary script) showed no main-thread task after the first second; the remaining load tasks are WebGL context creation and first compile | long tasks during the sequence: 0 in all six; at load 1-2 tasks of 72-147 ms (`V1-shots-20261107T024535.json`) |
| S3 | fixed | Two separate lines. "mesh err est. X (vs tol Y)": green only with Richardson available and X <= Y. "vs CASE ref: Z rel (tol Y)": green or amber against the same tolerance, shown only while the parameters equal the model's own ("N/A (parameters changed)" otherwise). The tooltip says the model may differ from the case's spec | helmholtz: "mesh err N/A, last change 6.4e-6" grey and "vs EM-04 ref: 1.1e-3 rel (tol 1e-3)" amber; heat: 1.7e-7 green and the reference within; box f_1: 5.4e-7 and 4.1e-7 green |
| S5 | fixed | In unmirrored views (Mesh mode, Mirror off), the ROI is intersected with the computed model box. The view re-fits on a container resize (e.g. the agent column opens) unless the user has panned or zoomed. The workbench headline box moved to the bottom-left above the mesh line, so the toolbar can wrap freely | `logs/V1-wb-kirsch-plate-initial-1440-20261107T024813.png`, `V1-wb-kirsch-plate-1440-20261107T024721.png` (r 3 select visible) |
| M1 | fixed | The RT canvas stays hidden and out of flow until it has its laid-out size (the 300 x 150 default canvas moved to 1040 x 650: the whole CLS) | CLS FDTD 0 and Gray-Scott 0 (were 0.134 / 0.124), layout-shift observer |
| S4 | not touched (L4 owns em-axisym) | - | - |
| m3, m4, m7, m8 | fixed | cutaway tooltip and `revolve.ts` header: "vertex-averaged P1 projection of the Nedelec solution"; 3D cavity: "mesh err N/A" with the reason; headline backing 0.9 opaque; the dimensionless colorbar header "1" removed | - |
| m1, m2, m5 (Gray-Scott 1.3 s), m6, m9 | open | m9 is covered by S1 | - |

Gates after the corrections (`logs/V1-shots-20261107T024535.json`; tests 10/10; production build `logs/V1-build-20261106T184900.log`, 0 hook references; CSP unchanged):

| Gate | Result |
|---|---|
| `pnpm check` / `pnpm test` / `pnpm build` | 0 errors, 0 warnings / 10/10 / ok |
| FCP medians | 36.4 / 37.4 / 34.6 ms (`/`, kirsch, LBM) |
| Load to gated accuracy | kirsch 2.31 s, heat 2.14, helmholtz 2.35, cavity 2.63, box 4.08; rib N/A (cap) |
| Drag previews median / max | kirsch 45 / 98 ms, heat 30 / 68, helmholtz 53 / 89, rib 392 / 634, cavity 30 / 106, box 17 / 24; 0 long tasks; handle drags 1 op |
| Mesh hashes | browser = Node at every level in all six |
| B1 W_m, op log, agent mock, phone switcher | pass (ratio 4, byte-identical, D 10 -> 20 mm and undo restores, 4/4) |
| Errors | none |

Screenshots: 24 `logs/V1-*` (timestamps 024721, 024813, 024815, 024820): one per view and size, plus `wb-kirsch-plate-initial` and `play-kirsch-plate-invalid`.

- 2026-11-06 18:35-18:49 PST: audit read; B1/S3 rework of `post/accuracy.ts` and `HeroHead.svelte`, S1 invalid and failed states, S2 profile (CPU profile, CDP; temporary script removed) then fixes, S5 framing, M1, m3/m4/m7/m8; tests rewritten (10/10); gates; final screenshots; production build. Servers on 47613 / 47391 stopped. No git.
