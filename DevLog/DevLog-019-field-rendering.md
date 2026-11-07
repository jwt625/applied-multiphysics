# DevLog-019: smooth field rendering (lane W1)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | W1 (field rendering quality) |
| Owns | `apps/web/src/lib/gfx/renderer2d.ts`, `gfx/field-material.ts`, `gfx/viewer3d.ts`, `post/field2d.ts`, `post/post.worker.ts`, `post/solid3d.ts`, `post/revolve.ts`, this file |
| Trigger | user feedback on the live app (2026-11-06): "the result visualization has bad interpolation of the solved data, i.e., no smooth interpolation" |
| References (read only) | `eo-modulator-atlas` DevLog-034 and `engine/src/postproc/refine.mjs` (`smoothingSlots`, `smoothValues`), `engine/src/postproc/evaluate.mjs` (`smoothToNodes`); `advanced-packaging-atlas` `app/src/lib/sim/graphics/FieldLayer.ts` |

## 0. Findings (2026-11-06 20:50-20:57 PST, dev server, before any change)

Where the faceting comes from, by field space (fields listed from the Play views' solutions):

| View | Fields | Current display | Faceted? |
|---|---|---|---|
| kirsch-plate (42352 tri6, 170296 DOF) | `u`, `sxx`... `mises`: H1P2 (stresses already recovered to nodes in `@amp/physics` elastic `nodalStress`: unweighted mean of element stresses at the element nodes) | refined lattice r = min(3, floor(sqrt(3e5 / nT))) = 2: exact P2 values at the lattice points, linear between them | smooth at the framed size; contours polygonal (2 segments per element side) when zoomed to element scale |
| heat-plate-fin (121168 tri6) | `T`: H1P2 | lattice r = 1: only the 3 corner values of each P2 element, linear between them; the 3 mid-side values are dropped | P2 curvature lost inside each element |
| si-rib-waveguide (47037 tri6) | `Ex`... `normE`: **DG0** (em-modes writes one value per triangle centroid) | r = 1, 3 equal corner values per element: flat per cell | **yes, every triangle visible** (`w1/si-rib-waveguide-before-full.png` in the session scratch) |
| helmholtz-coil | `A_phi`, `Br`, `Bz`, `normB`: H1P2 (B recovered to nodes in the engine) | lattice r | as Kirsch |
| box-acoustics (3D, 23040 tet10) | `p`: H1P2 | tet10 exterior faces split in 4 sub-triangles through the mid-edge nodes, value per vertex, LUT per fragment on the interpolated value | piecewise linear over the 4 sub-triangles |

The 2D renderer already samples the LUT per fragment on the interpolated value (`renderer2d.ts` FS `lut(mapT(vVal))`), and the 3D TSL material does the same. What is linear (and so faceted) is the value itself between lattice points, and DG0 is constant per cell.

What the atlases did:
- eo-modulator-atlas (DevLog-034): refined element-local lattice with exact basis values, then "Smoothing" of coincident element-side lattice values (none / inside material domains (default) / everywhere); per-node recovery of element-local values is the area-weighted mean of the corner values of the elements sharing the node (`smoothToNodes`). The probe always shows the exact value; the colour range follows the drawn values.
- advanced-packaging-atlas: von Mises at cell corners from the engine; LUT per fragment; flat lighting from screen-space derivatives.

## 1. Plan (written 2026-11-06 20:58 PST, before coding)

### 1.1 2D: exact per-fragment evaluation of the element basis
- `renderer2d.ts`: a new optional per-element coefficient path. A layer may carry `coef` (element coefficients, texture-ready: per element the 6 P2 values (corners 0, 1, 2, mids 01, 12, 20) of up to 3 components). They live in an RGBA32F texture; the vertex shader finds the element as `gl_VertexID / np` (the lattice is element-major and draws are indexed, so `gl_VertexID` is the lattice index), fetches its values once per vertex and passes them `flat` to the fragment shader, which evaluates the P2 basis at the interpolated parent barycentrics (`vBary`, already there for the wireframe) and, for a magnitude, takes the norm of the interpolated vector per fragment. Then the display affine (a v + b), the mirror sign and the LUT, per fragment. P1 coefficients are written as P2 with mid values = edge means (the P2 basis reproduces linears exactly), so one shader handles P1, P2 and recovered DG0. Contours (fwidth on the per-fragment value) follow the curved iso-lines inside elements. The lattice r then only shapes curved (tri6) element geometry.
- Lattice values stay as they are: used for the colour range, the peak marker, and the raw view.
- `post.worker.ts` `lattice`: new `smooth` flag (default true). Smooth: returns `coef` as above plus lattice values of the same smooth field (so the range follows what is drawn). Raw (`smooth: false`): today's arrays unchanged (DG0 flat at r = 1, H1 linear on the lattice) and no `coef`.

### 1.2 DG0 recovery to nodes
- Area-weighted mean of the cell values of the cells sharing a corner node, **per domain** (a node on a material interface gets one value per domain, so jumps of e.g. E_normal across Si / SiO2 stay sharp): eo-modulator-atlas `smoothToNodes` weights + its default "inside material domains" grouping. P1 inside each element from its 3 corner values.
- Why not SPR: superconvergent patch recovery fits a polynomial per vertex patch to samples at superconvergent points. For centroid (DG0) samples of a Nedelec-derived field it would be more accurate at boundaries, but it can overshoot (|E| < 0, range beyond the data) and needs patch assembly per vertex; the averaged field is bounded by its cell values, so the colour range never exceeds the data and the probe (exact cell value) is always inside the colorbar. The better fix is in the engine (an H1 projection or element-local P2 samples of E from em-modes); recorded in s.5.
- Stresses, B, E of the other modules are already nodal (H1) in `@amp/physics`; nothing to recover in the viewer.

### 1.3 Raw toggle
- "Raw" button (results, 2D): draws the unsmoothed field (DG0 per cell, H1 on the lattice as before), tooltip says so. Needs the smallest possible hook in `Graphics.svelte` (W2): a boolean state, `smooth` in the lattice request and its cache key, `coef` passed into the layers, and the button. Recorded under cross-lane edits.

### 1.4 3D
- `viewer3d.ts` / `field-material.ts`: per-fragment P2 on tet10 exterior faces: the 4 sub-triangles of a face are consecutive in the `exterior()` soup (`solid3d.ts`), so the viewer can build per-vertex face barycentrics and the face's 6 values from the per-vertex values and evaluate the P2 basis per fragment, when the drawable says its soup is grouped that way. Done only if the hook stays a single flag in `Graphics.svelte`; else recorded as open.

### 1.5 Verification
- Before / after screenshots: Kirsch Play zoomed on the hole (2 zoom levels), heat Play, waveguide Play, box-acoustics 3D. Probe values at fixed points before and after (exact FE evaluation, should be identical; the drawn value may differ for DG0 by the recovery).
- Frame interval on the Kirsch Play view (SwiftShader, rAF-paced wheel steps), solve time from the session.
- `pnpm check`, `pnpm test` in `apps/web`.

## 2. TODO
- [x] renderer2d: coefficient texture path (P2 per fragment, magnitude, psi)
- [x] field2d: `smoothCoefficients`, `recoverDG0` (per domain, area-weighted), `evalCoef`, `packCoef`
- [x] post.worker: `smooth` flag, coef + smooth lattice values
- [x] Graphics.svelte hook (cross-lane, minimal) + Raw button
- [x] 3D per-fragment P2 on tet10 faces (no Graphics hook needed: the viewer detects the tet10 face grouping)
- [x] screenshots before / after, probe check, frame timing
- [x] pnpm check, pnpm test
- [x] stop dev server

## 3. Progress log
- 2026-11-06 20:52 PST: dev server on port 47613 (`logs/W1-dev-20261106T205210.log`); before screenshots of all six Play views into the session scratch; live site Kirsch screenshot identical to local.
- 2026-11-06 20:58 PST: plan written.
- 2026-11-06 21:01 PST: renderer2d coefficient path, field2d recovery / coefficients, worker `smooth` flag, Graphics hook; Kirsch Play renders, Raw button present.
- 2026-11-06 21:08 PST: 3D P2 path (field-material opts.p2, viewer3d `p2Groups` + attributes fb / pa / pb).
- 2026-11-06 21:10 PST: the si-rib-waveguide Play view fails before any field is drawn ("provenance path 'studies.sweep_t.settings.sweep.0.values' does not resolve", from the sims lane's concurrent YAML edits); DG0 verified in the workbench instead (si-rib-waveguide, 5642 tri6, Compute).
- 2026-11-06 21:18 PST: pnpm check 0 errors (`logs/W1-check-20261106T211809.log`), pnpm test 10/10 (`logs/W1-test-20261106T211817.log`); dev server stopped.

## 4. Results

### 4.1 What changed
| File | Change |
|---|---|
| `post/field2d.ts` | `ElementCoef` type; `recoverDG0` (per-domain area-weighted corner recovery); `smoothCoefficients` (6 P2 values per element and component; P1 / DG0 mids = edge means); `evalCoef`; `packCoef` (RGBA32F texel layout, 4096 wide) |
| `post/post.worker.ts` | `lattice` request `smooth` (default true): returns `coef` (transferred) and lattice values of the same smooth field; `smooth: false` = previous arrays unchanged |
| `gfx/renderer2d.ts` | optional `coef` per layer: RGBA32F texture per ElementCoef (LRU 6), VS fetches the element's texels by `gl_VertexID / np` and passes 5 flat vec4; FS evaluates the P2 basis at the parent barycentrics, the vector norm for a magnitude, `a f + b`, times x for r A_phi, times the mirror sign, then the LUT; contours use the same per-fragment value. Shader warm-up covers both paths |
| `gfx/field-material.ts` | `opts.p2`: value = P2 basis of the parent face from attributes `fb`, `pa`, `pb` |
| `gfx/viewer3d.ts` | `p2Groups(pos)` detects the tet10 face grouping of `exterior()` (repeated mid-edge positions); `p2Attrs` builds fb / pa / pb (for other soups pa = pb = vertex value, i.e. linear); exterior surface material uses p2 |
| `post/solid3d.ts`, `post/revolve.ts` | unchanged |

### 4.2 Evidence (SwiftShader headless shell, 1440x900; scratch scripts in the session scratch `w1/`)
- Final pair in `logs/`: `W1-before-raw-si-rib-normE-20261106T211829.png` (Raw = the previous display path: per-cell flat) and `W1-after-smooth-si-rib-normE-20261106T211829.png` (smooth), workbench si-rib-waveguide, normE, same view. The flat triangles are gone; the Ey view (scratch `wb-si-rib-waveguide-Ey-*.png`) keeps the jump at the Si / air interface sharp.
- Kirsch Play (H1P2, 42352 tri6): before vs after full / 9.5x / 90x zoom on the hole: 0.10-0.19 % of pixels differ by > 2 grey levels, all on the contour lines (sub-pixel shift from polygonal to curved). At element scale (8 wheel steps, wireframe on) smooth vs Raw differ in 0.12 % of pixels. The Kirsch view was not faceted before: stresses are nodal (H1P2) from the engine and the lattice r = 2 already rendered them smoothly.
- heat-plate-fin Play (H1P2, 121168 tri6, lattice r = 1): before vs after: 0.02 % of pixels differ by > 2 grey levels (max 13).
- box-acoustics Play 3D (tet10, mode 1, 171.5 Hz): before vs after max difference 1 grey level (the mode is near-linear per element at this mesh); the P2 path was confirmed active (`p2Groups` true on a tet10 exterior, false on tet4; Node check).
- Drawn value vs exact FE probe (2000 points per field, smooth coefficients vs `evalElement`): Kirsch sxx, mises, |u| and heat T: max difference 0 (bit-identical in float64). Waveguide DG0 (recovered): normE mean 0.28 %, max 11.0 % of max |field|; Ey mean 0.31 %, max 38 % (at the rib corner singularity, where neighbouring cell values differ most); Ex mean 0.28 %, max 11.0 %. The hover probe itself is unchanged (same `evalElement` path), so probe values are identical before and after; Kirsch probe at (0, 5.0 mm) = 3.0213 MPa.
- Recovery checks (Node, scratch `w1/smooth-check.ts`): H1P2 coefficients reproduce `evalElement` exactly for a scalar and a 2-component magnitude; DG0 recovery of piecewise-constant per-domain data is exact (8.9e-16) with the jump kept; recovered range of a linear field's centroid samples equals the cell range (bounded); interior node error 0.087 for |grad| 2.24, h = 0.1 (first-order bias of averaging, expected).

### 4.3 Timings (Kirsch Play, 170296 DOF)
| | before | after |
|---|---|---|
| frame interval, rAF-paced wheel steps, SwiftShader (median / p90 / max) | 182.7 / 192.9 / 198.9 ms | 180.2 / 185.6 / 192.5 ms |
| solve (session `lastOutcomeMs`) | 335.8 ms | 352.8 ms |
| page load to solved (wall) | 588 ms | 533 ms |
SwiftShader is a CPU rasterizer: these intervals measure the relative cost of the shader change, not the frame rate on a GPU. Solve times are run-to-run noise (the solver is untouched).

## 5. Open items and engine needs
- Engine (`@amp/physics` em-modes): fields are DG0 at triangle centroids although the solver has Nedelec order 2 + P2 element fields. Exporting an H1 projection (or element-corner / P2 samples) of E and H would give the viewer the true higher-order field; the viewer recovery is first order and its contours are piecewise linear per element on coarse meshes (visible in `wb-si-rib-waveguide-Ey-smooth.png`).
- si-rib-waveguide Play view: run fails on a provenance path after the concurrent sims edit (not this lane); recheck once fixed.
- The dev server's sim list (`import.meta.glob`) did not pick up `sims/si-strip-te0.yaml` and other new files without a restart.
- Raw toggle is 2D only; the 3D surface is always P2 per fragment on tet10 (no raw 3D view). 3D DG0 fields (none produced today) are still drawn per cell by `Graphics.svelte`.
- Unit tests for `recoverDG0` / `smoothCoefficients` belong in `apps/web/test/post.test.ts` (not owned by this lane); the checks live in the session scratch only.

## 6. Cross-lane edits
- `apps/web/src/lib/gfx/Graphics.svelte` (W2), 2026-11-06 21:01 PST: `rawField` state; `:${rawField}` in `fkey`; DG0 lattice r = 1 only when raw; `smooth: !rawField` in the field lattice request; `coef: L.out.coef` / `coef: P.coef` on the surface and contour layers; contours allowed for DG0 when smooth; one "Raw" button next to Contours (tooltip states what raw and smooth draw and that the probe is exact). Pre-edit copy kept in the session scratch (`w1/Graphics.svelte.pre-W1`).
- No edits to `packages/*`.

## 7. Audit fixes (`DevLog/audits/AUDIT-wave3-2026-11-06.md`, W1 findings), 2026-11-06 21:43-21:48 PST

| Finding | Fix | Files |
|---|---|---|
| M1: smoothed DG0 range (si-strip-te0 Ey colorbar +-0.854) contradicted the eigenmode note (max \|Ey\| = 1), the peak tip and the exact probe | Kept the smooth display; colour range, robust percentiles and the peak marker of a smoothed DG0 field now come from the **exact per-cell values** (area-weighted, focus box by cell centroid); the peak sits at that cell's centroid and its tip says "(cell value, at the cell centroid)". The recovered field is bounded by the cell values, so nothing drawn exceeds the colorbar. The smoothing note is now in the colorbar tooltip: "drawn smoothed: per-cell values recovered to the element corners ...; colorbar ends and peak marker are the exact per-cell values (Raw draws the cells)". H1 fields unchanged (their lattice values are exact FE values) | `post/post.worker.ts` (`LatticeOut.peakCell`), `Graphics.svelte` (cross-lane: note, tip, `peakCell` in view2d) |
| m2: no MAX_TEXTURE_SIZE guard | The texel layout is linear, so the texture width shrinks to `MAX_TEXTURE_SIZE` (data padded); if the height still does not fit, or the upload raises a GL error, the layer falls back to its lattice values (the smooth field, linear between lattice points) instead of drawing a constant | `gfx/renderer2d.ts` |
| m3: Raw for 2D only | `Viewer3D.setSmooth(on)`: raw writes pa = pb = vertex value (linear on the 4 face sub-triangles); same Raw button shown for tet10 3D results | `gfx/viewer3d.ts`; cross-lane: `Canvas3D.svelte` (`smooth` prop + one effect), `Graphics.svelte` (`smooth={!rawField}`, 3D Raw button) |
| m4: `p2Attrs` reallocated per value update | fb / pa / pb arrays and `value` / `disp` attributes are rewritten in place when the vertex count is unchanged | `gfx/viewer3d.ts` |

Verification (dev server port 47613, `logs/W1-dev-20261106T214529.log`; scripts and PNGs in the session scratch `w1/`):
- si-strip-te0 Ey (workbench, 4529 tri6): smooth colorbar range -1 to 1 (was -0.854 to 0.854), Raw -1 to 1; note shown; marker tip "largest \|Ey\| on the mesh (cell value, at the cell centroid)". Exact probe at the peak cell (cell 1970, centroid (0.247, -0.113) um): -0.42051 = raw cell value, normalized -1 = colorbar end. `m1-si-strip-te0-Ey-{smooth,raw}.png`.
- si-rib-waveguide normE (workbench): smooth range 3.46e-11 to 1, Raw 6.19e-12 to 1 (both exact cell values; the lower ends differ by which cells fall in the view box: centroids vs corners); probe at the peak cell 1 = colorbar end. `m1-si-rib-waveguide-normE-{smooth,raw}.png`.
- 3D Raw: workbench box-acoustics (360 tet10), highest mode: smooth draws straight bands, Raw the kinked piecewise-linear bands (`wb3d-pair.png`); Play box-acoustics (23040 tet10) smooth vs Raw max difference 2 grey levels (mesh fine relative to the mode); animation runs with the in-place buffers, no page errors.
- `pnpm check` 0 errors 0 warnings (`logs/W1-check-20261106T214853.log`); `pnpm test` 10/10 (`logs/W1-test-20261106T214853.log`). Dev server stopped 21:48 PST.

Cross-lane edits (added): `Canvas3D.svelte` (W2): `smooth` prop and `$effect(() => v.setSmooth(smooth))`; `Graphics.svelte` (W2): colorbar note concatenation, peak tip wording, `peakCell` in the 2D view object, `smooth={!rawField}` on Canvas3D, a Raw button for tet10 3D results. Pre-edit copies: session scratch `w1/Graphics.svelte.pre-W1-fix`, `w1/Canvas3D.svelte.pre-W1-fix`.

Open: the 3D colour range is still taken over the nodal values (`Graphics.svelte` view3d), so P2 overshoot between nodes saturates at the colorbar ends (audit m3 note); a range over the drawn P2 face values would need sampling in the post worker.
