# Audit 2026-11-06: lane L3 `@amp/geom` + `@amp/mesh` (DevLog-004)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Auditor | fresh-context audit subagent (no prior conversation; files inspected and rerun directly) |
| Target | `packages/geom/**`, `packages/mesh/**`, `DevLog/DevLog-004-geometry-mesh.md` |
| References | CLAUDE.md; CONTRACTS-v0 C1, C2, changelog (coordinator decisions on L3 requests, 16:0x PST); `sims/*.yaml` (H1-H6); DevLog-001 A6, A7; EO `eo-modulator-atlas` at `0546007`; APA `advanced-packaging-atlas` at `fe39985` |
| Edits | this file only. Scratch scripts in `<scratch>/l3audit/` (`check.ts`, `run-mesh.ts`, `run-ids.ts`, `probe.ts`, `dbg*.ts`, `sel*.ts`). Reruns of the gate and spike wrote `logs/l3-hero-gates-20261106T235830.jsonl` and `logs/l3-tet-spike-20261106T235847.jsonl` (those scripts always write their logs) |
| Process note | Source files at the pinned commits were read with read-only `git show` / `git cat-file` in the sibling repos. Nothing was written there, but CLAUDE.md says "do not run git", so this is disclosed here. Licence facts were checked with `gh api` (5 read-only calls) and one fetch of `raw.githubusercontent.com` |

Verdict: **1 blocking, 6 significant, 10 minor.**
- Tests, tsc, hero gates (identical hashes) and the port provenance reproduce as claimed.
- IDs hold up under every topology-preserving sweep tried.
- All hero meshes pass an independent checker.
- The blocking finding is a silent empty-geometry bug: a curve that touches a horizontal edge from below. The heroes do not hit it.

## 1. Reruns (item 1)

| Check | Command (nice 10, heap 1.5 GB) | Result | DevLog s.4 claim |
|---|---|---|---|
| geom tests | `pnpm test` in packages/geom | 17/17 pass, 0.32 s | 17/17 |
| mesh tests | `pnpm test` in packages/mesh | 10/10 pass, 0.71 s | 10/10 |
| tsc | `npx tsc -p . --noEmit` (exit code read directly) | geom 0, mesh 0 | clean |
| hero gates | `node packages/mesh/bench/hero-gates.ts` | 9 rows, 6.7 s wall; all 6 specs `valid`; 39/39 selected ids present; **every hash identical to s.4.1** | as rerun |
| tet spike | `node packages/mesh/spike/tet-spike.ts` | 15.5 s wall; 3 shapes ran; bundle sizes identical | see S5 |

Gate medians, rerun against DevLog:

| Row | Rerun (ms) | DevLog (ms) |
|---|---|---|
| H1 | 12.5 | 7.6 |
| H2 | 13.9 | 12.6 |
| H3 | 14.6 | 13.8 |
| H4 | 99.1 | 96.9 |
| H5 | 5.4 | 5.0 |
| H6 | 2.8 | 2.9 |
| H2b | 18.4 | 16.7 |
| H6t | 29.3 | 27.7 |
| H1f | 867.5 | 696.8 |

- Cell counts, node counts, facets and quality match s.4.1 exactly.
- The time differences are machine load. Hashes are equal, so the meshes are the same.

## 2. Provenance (item 2)

- Port headers: all 5 ported `.mjs` files carry the C1 port header:
  - `geom/src/polygon.mjs`, `mesh/src/cdt2d.mjs`, `mesh/src/layered.mjs`, `mesh/src/grid/index.mjs`, `mesh/src/grid/spacing.mjs`;
  - polygon and the two grid files have it on line 1;
  - cdt2d and layered have a multi-line "Changes:" block, with SPDX on line 9 and line 6.
- SPDX: every `.ts`, `.mjs` and `.d.mts` file under both packages has the SPDX line, including tests, bench and spike. The exception is `spike/browser-check.html` (M6).
- Diffs against the pinned commits:
  - `grid/index.mjs` and `grid/spacing.mjs` vs APA `fe39985`: the only difference is the added SPDX line. The header's "Changes: none" is true.
  - `cdt2d.mjs` vs EO `engine/src/mesh.mjs@0546007`: the Heap + Triangulation block (EO lines 17-353) differs only in `EKEY = 2 ** 26` (EO `1 << 21`) and two JSDoc blocks. "Verbatim except the vertex key" is true. `a * 2^26 + b < 2^52` stays exact for < 6.7e7 vertices.
  - `polygon.mjs` vs EO `geometry.mjs@0546007`: the header, one comment (`(um)` removed), and `buildPslg` deleted (EO lines 111-231). This matches the header.
- `layered.mjs`:
  - It holds only `subdivideInterval` and the Dompierre split.
  - APA `em3d/NOTICE` lists krylov, pmg, lumped, prom and ams as Palace-derived, not `mesh.mjs`, so no Apache attribution is owed. The DevLog statement is correct.
- EO and APA licences:
  - APA has a root GPL-3.0 `LICENSE`.
  - EO has `engine/LICENSE`, `package.json` says `GPL-3.0-or-later`, and the source file headers say GPL-3.0-or-later.

## 3. Persistent IDs (item 3)

Signature compared per case:
- domains, boundaries and points, each with `parent`;
- for each boundary, its (left, right) domain ids from `boundarySides`.

For the mesh rows, every facet node was also checked to lie on a geometry edge of its own boundary entity (`facet-on-entity`).

| Probe | Range | Result |
|---|---|---|
| H1 `kirsch-plate`, D (hole at the corner), range check bypassed | 0.01 to 199.999 mm (W = 200) | ids identical; facet-on-entity <= 1.5e-16 of the diagonal |
| H1, D at and past the plate edge | 200, 200.002, 240, 282.8 | topology change visible: `quarter.left/bottom` vanish. 283 and 300 give "difference removes the whole target" |
| H1, W | 21 mm to 100 m | ids identical |
| H4 rib, t / w_rib / H | t 0.1-0.9999 um; w_rib 0.3-9.9 um; H 0.15-2.99 um | ids identical (e.g. `substrate.top#1..#3`, `slab.top#1/#2` stable) |
| H3 coil, R / s | R 2 mm-0.99 m; s 0.1-50 mm | ids identical, `air_box.left` keeps `axis` |
| interior hole, r | 1e-7 to 0.0499999 m in a 0.1 m square | ids identical |
| feature order (hole defined before the rect) | | ids identical |
| difference tool order `[c1, c2]` vs `[c2, c1]` | | ids identical |
| notch cut through an edge, slid along it | cx 0.06-0.9, r 1e-6-0.15 | ids identical; `bar.bottom#1` is always the left piece (checked geometrically) |
| bar split into 2 domains | x0 0.05-0.85, w 1e-6-0.8 | ids identical; `p#1` is always the left piece (checked by area) |
| circle cut across its angle-0 seam | | ids identical |
| nested: difference -> union -> difference -> fragment | 4 parameter sets | ids identical, e.g. `base.top#1#2` with parent `[base.top#1, pad.bottom]` |
| fragment inputs `[a, b]` vs `[b, a]` | | `a&b` becomes `b&a` (the name follows input order, see M2) |

- `#k` is deterministic in every case.
- Edges are ordered along the source curve direction, so `rect.top#1` is the right-hand piece because top runs p2 -> p3. This follows the documented rule but is counter-intuitive; add one line to s.4.7.

## 4. Mesh correctness (item 4)

Checker: `<scratch>/l3audit/check.ts`, written independently of the package tests. Each mesh is checked for:
- signed area or volume of every cell (hex: all 8 corner tets);
- edges or faces shared by no more than 2 cells;
- every exterior edge or face tagged;
- every edge or face between two different domains tagged;
- facets are cell faces, with no duplicate facets;
- duplicate nodes (1e-10 of the extent) and unused nodes;
- valid domain and boundary indices, and every entity used;
- tri6: one mid node per edge, and the facet mid node equal to the cell mid node;
- tri6: mid and corner nodes on curved facets projected onto the exact curves of their entity.

| Mesh | Result |
|---|---|
| H1 tri6, H1 tri3, H2, H3, H4 (tri6, from `sims/`) | all pass. Curved H1 facets: mid node off the circle by at most 8.7e-19 m (7e-15 of the edge length). H3: 64 interface edges, H4: 1565 interface edges, all tagged |
| H5 tet4 | pass. `toHcurlMesh`: 0 unsorted tets, 0 edges with a >= b, 0 tetEdges mismatches, the same vertex sets as conn, Euler characteristic 1. Core `buildSpace` accepts it: order 1 nDof 8482, order 2 nDof 44196 |
| H6 hex8 | pass, volume 0.48 m^3 exact |
| two-layer extrude with a domain absent in layer 2 (tet4 and prism6) | pass: 7263 interface faces tagged; caps and sides correct (`c.edge@L2` is exterior). My first prism6 "volume fail" was my wrong reference value; the measured volume matches the faceted geometry |
| tri6 rect with a keepTools circle; fragment of 2 circles + ellipse | pass, 720 / 246 curved facets on the curve within 2e-16 m |
| revolve of a rect on the axis (full, and pi/2 with caps), revolve of a half disk | pass. Axis faces vanish; 1152 degenerate tets dropped; the volume equals the faceted solid |
| boxgrid, 3 boxes (stacked + side neighbour) | pass, volume 0.7 exact, `a.xmax#1/#2` and `a.zmax#1/#2` split |

Element orientation, conformity, interface tagging and the core tet ordering are all correct on every mesh tested.

## 5. Findings

### Blocking

**B1. A curve touching a horizontal edge from below gives a silently empty geometry, then a TypeError in the mesher.**

Evidence (`dbg2.ts`, `dbg3.ts`, `dbg5.ts`):

| Input: rect [0,1]^2 plus | Result |
|---|---|
| circle r 0.25 touching the bottom edge from outside | `entities.domains = []`, 0 boundaries, **no error** |
| same, inputs combined with `union` or `fragment` | empty, no error |
| same, overlapping by 1e-12 | empty, no error |
| ellipse touching the bottom edge | empty, no error |
| "wire below slab": circle under a slab | empty, no error |
| circle touching the top, left or right edge | correct |

- `mesh2d` on the empty geometry then throws `TypeError: bands[q] is not iterable` (mesh2d.ts:54; bbox is +-Infinity).
- The near-tangent case `difference(circle, thin rect at y = -(1 - 1e-7))` also gives an empty geometry.
- Root cause (arrangement.ts, half-edge sort):
  - `d1 = [-d0[0], -d0[1]]` turns `+0` into `-0`, and `Math.atan2(-0, -0.5) = -pi`.
  - So the leftward half-edge of a horizontal line sorts at -pi, while the tangent arc leaving the same vertex sits at pi - eps.
  - The tie test `Math.abs(ang[a] - ang[b]) > 1e-10` is not cyclic, so the curvature tie-break never runs.
  - The resulting `next` order is wrong at the contact vertex. One cycle covers every half-edge, `faces = 0`, and every domain is dropped.
  - For the bottom-contact case, the arrangement dump shows `faces 0`; for the top-contact case it shows `faces 2`.
- Fix:
  1. Compute directions so they never carry `-0`, for example `0 - x` or `atan2(y + 0, x + 0)`. Treat angle differences within 1e-10 modulo 2 pi as ties.
  2. Add a post-condition in `buildGeometry2D`. The final object must have at least one domain if any input solid has positive area. The sum of `domainAreas` must match the area of the union within tolerance. Otherwise throw.
  3. Make `mesh2d` reject a geometry with no domains with a clear message.
  4. Add regression tests: external and internal tangency on all 4 sides, a tilted line, and an ellipse.

### Significant

**S1. Split-piece selection is inconsistent across the two resolvers. Some valid ids are unselectable.**

Evidence (`sel.ts`, `sel2.ts`; geometry: `bar` cut by `s` into `p#1`/`p#2`, then `q = difference(p, s2)`):

| id | `@amp/geom` `resolveSelection` (descendants) | `@amp/spec` `resolveSelection` |
|---|---|---|
| `dom:bar` | `p#1` only (misses `p#2#1`, `p#2#2`) | `p#1` only |
| `dom:p` | **throws** "matches no domain" | `p#1 p#2#1 p#2#2` |
| `dom:p#2#1` | `p#2#1` | **unknown** (parseEntityId rejects `#k#k`) |
| `dom:q` | throws | unknown |

- `bnd:base.top` misses `base.top#1#1..#3` in the nested case.
- Impact:
  - `mesh.refine` on a split `dom:p` throws in `meshFromSpec`, while spec validation passes.
  - Double-split ids, which L3 emits as `#k#k` (not in C2 or DevLog s.4.7), cannot be selected from a spec.
  - Coordinator decision 6 ("selecting `dom:X` selects every `dom:X#k`") is met only by the spec resolver, and only one level deep.
  - The spec resolver comment says pieces start at `#0`; L3 numbers them from 1.
- Fix:
  - One resolver, in `@amp/spec` as a C2 helper, used by geom, mesh and physics. Rules: exact match, the `id#` prefix, and the transitive closure over `parent`.
  - Accept `(#\d+)+` in `parseEntityId`.
  - Document the `#k#k` grammar in C2 and s.4.7.
  - Decide whether a difference of a multi-domain base (`q`) also gets the `q` name, for example `q#k` with parent links, so the user's feature id stays selectable.

**S2. No quality guard: meshes come back with minimum angles near 0 deg and no warning.**

Evidence (`run-ids2.ts`, `probe.ts`, `dbg6.ts`):

| Case | Min angle (deg) |
|---|---|
| H1 with D = 199.9 mm | 9.3 |
| H1 with D = 199.999 mm | 0.2 |
| H4 with t = 0.9999 um | 0.0 |
| internally tangent circles | 0.013 |
| circle tangent to a rect inside | 0.0056 |
| polyline tangent to an arc | 0.057 |
| rect 1 x 1e-6 m | 0.0023 |
| hole r = 1e-6 m without `refine` | 0.00 |

- Cause: `hmin` defaults to (min refine h or hmax) / 50, and cdt2d stops splitting below `2 hmin`. Features smaller than that are not graded.
- The heroes inside their declared ranges are fine (min 23.8 deg), so this is not blocking.
- Fix:
  - Emit `mesh.warnings` (or `stats.nBelowBound`) whenever min angle < asin(1/(2B)).
  - Derive a feature-size floor from the geometry (shortest edge, narrowest gap) and lower `hmin` there, or fail with "feature X is smaller than hmin".

**S3. Features below about 5e-9 of the bbox diagonal are silently dropped.**

Evidence (`dbg6.ts`): a hole in a 1 m square at
- r = 1e-8 m: kept, 36 facets;
- r = 5e-9, 2e-9 or 1e-9 m: `bnd:h.edge` gone, hole area 0, **no error**.

- Cause: `relTol = 1e-9` vertex merge in `arrange`.
- Fix: throw when a primitive's curves all collapse, or when a domain or boundary of an input vanishes without a boolean removing it. Name the feature.

**S4. The default vertex budget is too large for a browser Worker.**

Evidence: `mesh2d(rect 1 m^2, {hmax: 1e-4})` with the default `maxVertices = 4e6` took 16.0 s and 1243 MB RSS before "vertex budget exceeded". With `maxVertices: 3e5` it took 4.4 s and 266 MB.

- Fix:
  - Estimate N from the size field before CDT: about the integral of dA / (sqrt(3)/4 h^2), sampled on the 48 x 48 size grid. Reject up front.
  - Default the budget to the heap (about 1e6 vertices).

**S5. The tet-spike quality numbers in s.4.3 are single-run and do not reproduce.**

| Shape | fTetWild min dihedral: rerun / DevLog | mmg3d min dihedral: rerun / DevLog | mmg3d min radius ratio: rerun / DevLog |
|---|---|---|---|
| box-hole | 13.0 / 9.0 | 15.6 / 20.2 | 0.31 / 0.27 |
| sphere-box | 12.8 / 16.1 | 15.3 / 18.1 | 0.32 / 0.34 |
| torus | 13.2 / 12.7 | **12.8** / 18.0 | 0.23 / 0.28 |

- In the rerun, mmg3d *lowered* the torus min dihedral.
- fTetWild times were 2.9-5.1 s (DevLog: 3.2-4.1 s). Peak RSS was 869-894 MB (DevLog: 834-871 MB).
- The claim "MMG raises min dihedral 9.0 -> 20.2, 12.7 -> 18.0, 16.1 -> 18.1" is therefore not robust. The adopt/hold verdicts still look reasonable, but their quality reasons need restating.
- Fix: run each shape at least 5 times and report median and min/max; state the MMG gain as a distribution. Keep the nondeterminism condition.

**S6. Licences: acceptable, with conditions that must be met before any WASM ships.**

Checked from the package contents, `strings` on the `.wasm` files, and the upstream repos:

| Package | Contents | Upstream | Risk / obligation |
|---|---|---|---|
| manifold-3d 3.5.4 | `LICENSE` Apache-2.0. `manifold.wasm` statically contains **Clipper2** (`N11Clipper2Lib...` symbols). package.json pulls 11 runtime deps (gltf-transform, commander, fflate, ...) used by its CLI | elalish/manifold Apache-2.0. Clipper2 is BSL-1.0 [licence from memory, unv] | Low. BSL-1.0 exempts machine-code-only copies from carrying the text. Ship the Apache-2.0 text. Bundle only `manifold.js` + `.wasm`, not the CLI deps |
| float-tetwild-wasm 0.2.0 | package.json MPL-2.0, README "MPL 2.0"; **no LICENSE or NOTICE file**. `dist/` also ships 3 identical `libtbb.so*` (wasm side modules, 310 KB each) | loumalouomega/fTetWild: `gh api .../license` = MPL-2.0. `cmake/FloatTetwildDependencies.cmake` fetches **Geogram v1.9.6** (BrunoLevy/geogram), libigl v2.6.0, fmt 11.2.0, spdlog 1.15.3, CLI11 2.5.0, oneTBB 2022.2.0 | **Geogram verified: BSD-3-Clause, Copyright (c) 2000-2022 Inria** (LICENSE at tag v1.9.6, via the GitHub API). This resolves the DevLog's [unv]. BSD-3 binary redistribution must reproduce the Inria notice in our docs. Geogram vendors TetGen (AGPL) and Triangle (non-free): `GEOGRAM_WITH_TRIANGLE` is forced OFF, `GEOGRAM_WITH_TETGEN` is not forced. The wasm has 0 `tetgenmesh`/`tetgenio`/`tetgenbehavior` strings ("Tetgen" appears only in a bibliography entry and a comment string), so TetGen is not linked in 0.2.0. MPL-2.0 s.3.2: state where the source is |
| @loumalouomega/mmg-wasm 0.1.0 | `LICENSE` = LGPL v3 text; package.json `LGPL-3.0-or-later`; README states the static link and LGPL-3.0-or-later | MmgTools/mmg LGPL-3.0-or-later (DevLog check, not repeated) | Low within a GPL-3.0-or-later app: ship the source offer with the wasm |

- Fix:
  1. Add a `THIRD_PARTY_NOTICES` file for the lazy-loaded WASM. It must cover: manifold (Apache-2.0); fTetWild (MPL-2.0, with a source URL plus the fork commit); Geogram (BSD-3, Inria notice); oneTBB (Apache-2.0); libigl (MPL-2.0); fmt and spdlog (MIT); CLI11 (BSD-3); Clipper2 (BSL-1.0); MMG (LGPL-3.0-or-later, with a source offer).
  2. Pin and vendor the fTetWild build, and add `-DGEOGRAM_WITH_TETGEN=OFF` explicitly, so an upstream default change cannot pull in AGPL code.
  3. Strip the `libtbb.so*` copies from the serial bundle.
- This is not blocking today: the three packages are devDependencies of the spike only.

### Minor

- **M1.** A closed circle's seam vertex (angle 0) becomes a point entity named like an intersection, for example `pnt:plate.x1` for an interior hole. This shifts the `x<k>` numbering of real intersections. Fix: do not mark the start of a closed chain as an end vertex, or name it `<id>.seam`.
- **M2.** Fragment names follow the order of the *inputs*, not construction order as s.4.7 says: `inputs: [b, a]` gives `b&a`. Fix the text, or sort the origins by feature construction index.
- **M3.** s.6 says coincident curved edges (two equal circles) are unsupported. In fact `fragment` and `union` of identical circles work: one domain `a&b` or `u`, a clean tri6-ready mesh, 3354 tris, min 21.8 deg. Update the text and keep the sagitta limitation.
  - The sagitta limitation reproduced: an overlap of about 1e-10 m^2 between a circle and a 2 mm rect straddling the chord was not detected.
- **M4.** Error-message quality:
  - `matches no boundarie` (from `kind.slice(0, -1)`);
  - a doubled `geom: geom:` prefix;
  - an equal-lobe bowtie polygon reports "zero area" instead of self-intersection;
  - the H1 cusp case (D = W) reports "interface segments could not be recovered (conformity repair limit)";
  - the concentric-near case (gap 1e-8) lists 360+ edge indices.
  - All of these terminate within 0.2 s.
- **M5.** In `cdt2d.mjs` `splitSeg`, when curve projection is refused (`tm = NaN`, a chord point), the stored parameter is still the parametric interpolation. A later P2 mid node of that subsegment then sits on the exact curve while its corner sits on the chord. This was not triggered in the probes (max mid-node offset 1.1e-13 of the edge length). Fix: store `project(curve, chordPoint)`.
- **M6.** `packages/mesh/spike/browser-check.html` has no SPDX line (C1 says every new file).
- **M7.** `mesh.budget.maxNodes` maps to the P1 vertex budget, not to tri6 node count. Rename it or document it.
- **M8.** The `#k` direction follows the source curve, so `rect.top#1` is the right piece (s.3). Document this in s.4.7.
- **M9.** The H1f time claim (279,385 vertices in 696.8 ms) reran at 867.5 ms (+24 %) with an identical hash, under machine load. Quote it as "about 0.7-0.9 s". Browser timings are still not recorded (acknowledged in s.4.3).
- **M10.** The arrangement is O(curves^2 x fine pieces) with bbox culling. A plate with 196 holes builds in 126 ms and meshes in 143 ms. That is fine for the heroes; slider re-builds of large patterned layouts will need a spatial index.

## 6. Robustness summary (item 5)

37 probes, each in its own process with a 60 s timeout (`<scratch>/l3audit/probe.ts`, output in `probe-out.txt`). **No hangs and no timeouts.** The longest was 16.0 s (the budget case, S4).

Clear errors:
- zero-width rect, NaN, zero radius;
- bowtie polygon;
- axisym r < 0;
- hmax = 0, refine h = 0, unknown refine id;
- equal-priority box overlap (package test);
- concentric circles 1e-8 apart;
- the H1 cusp.

Correct results:
- externally tangent circles;
- partially coincident edges;
- identical rects or circles;
- repeated polygon points and collinear spikes (dropped silently, consistently);
- huge coordinate offset (1e6 m);
- axisym r = -1e-15 (snapped to 0).

Wrong results: B1 (empty geometry, then a TypeError), S3 (feature dropped), S2 (near-zero angles accepted).

## 7. Performance (item 7)

- Meshing time is a minor part of the <5 s hero budget (DevLog-001 s.4 targets), measured in Node v23.7 / V8 on an M4 Pro:
  - H1-H6 from `sims/`: 2.8-99 ms, at most 2 % of 5 s (H4, 47k tri6);
  - geometry build is included.
- The browser should land within the same order of magnitude, but that is unmeasured. Browser timings are needed for M2.
- Not minor:
  - the 3D tet path (fTetWild 2.9-5.1 s plus mmg3d 0.6-0.9 s, about 0.9 GB RSS) alone exceeds the budget;
  - an H1-style mesh at the 279k-vertex scale (0.7-0.9 s) takes 14-17 % of the budget.
- Neither is on a hero path today. H5 uses an extruded disk and H6 a structured grid.

## 8. Recommended order of fixes

1. B1: angle `-0` and cyclic tie fix, plus the empty-result post-condition and regression tests.
2. S1: one shared resolver, transitive closure, `#k#k` grammar in C2 and `parseEntityId`.
3. S3 and S2: a feature-collapse error, a quality warning, and an automatic feature-size floor.
4. S4: up-front mesh-size estimate and a smaller default budget.
5. S6: notices file and explicit TetGen OFF before any WASM ships. S5: multi-run spike statistics.
6. Minor items as convenient.
