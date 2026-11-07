# DevLog-004: Geometry and meshing (lane L3)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Status | Audit corrections applied (2026-11-06 16:24 PST); see section 7 |
| Scope | `@amp/geom` (2D primitives, booleans, persistent IDs, axisym, extrude, revolve), `@amp/mesh` (2D CDT port + generalization, structured grid port, layered prism/tet port, quality, P2, hash), 3D tet spike (manifold-3d, fTetWild WASM, MMG WASM) |
| Owner | Lane L3 (Claude Opus 5.5 subagent) |
| Owns | `packages/geom/**`, `packages/mesh/**`, this file |
| Plan | DevLog-001 A6, A7, Q4; heroes section 8; contracts C1, C2 |
| Sources read | EO `engine/src/{geometry,section,mesh,mesh-entry}.mjs` at 0546007; APA `engine/src/grid/{index,spacing}.mjs`, `engine/src/em3d/mesh.mjs` at fe39985; R1 s.1b/s.7, R2 s.1/s.8, R4 s.2/s.7 |

## 1. Plan (written 2026-11-06 15:15 PST, before coding)

### 1.1 `@amp/geom` (TypeScript, plus one ported `.mjs`)

- Ported: EO `geometry.mjs` -> `packages/geom/src/polygon.mjs` (+ `.d.mts`, port header). Polygon utilities only; `buildPslg` is not ported (its O(n^2) split loop and mask/electrode tags are replaced by the arrangement below).
- Curves are exact parametric pieces: line segment, circular arc, elliptical arc. Each has `point(t)`, `tangent(t)`, `t in [0, 1]`.
- Primitives (each is a feature with an `id`):
  - Solids: `rect` (sub-entities bottom, right, top, left; points p0..p3), `circle` (side), `ellipse` (side), `polygon` (e0..e{n-1}; v0..v{n-1}).
  - Curves: `arc`, `polyline` (embedded edges; they split faces they cross only in `fragment`).
- Booleans (`union`, `difference`, `intersection`, `fragment`) run on one engine: a planar arrangement.
  - Curves are discretized finely for topology only. Segment crossings use `orient2d` from `robust-predicates`.
  - Each crossing is refined onto the exact curves by Newton on (t1, t2).
  - Faces come from half-edge tracing; each face gets its origin set (the input domains that contain it) from a point-in-face test.
  - Result geometry stays exact: edges keep (curve, t0, t1).
- No painter order: overlaps resolve only by `fragment` (or a boolean). Two overlapping solids left in the model without a boolean are an error.
- Persistent IDs (C2):
  - A primitive `F` gives domain `F` and boundaries `F.<sub>`.
  - `difference` keeps the target domain IDs. `union` and `intersection` give the feature's own ID. `fragment` gives the origin set joined by `&`, in construction order.
  - When one source becomes several pieces, they are `<id>#k` (k from 1).
    - Edges are ordered by parameter along the source curve.
    - Domains are ordered by the first parent boundary position they touch, with a centroid fallback.
  - Every result entity carries `parent` (the source IDs).
  - Test: the ID tables match across parameter changes that keep topology; a topology change is detected.
- Axisym: a geometry flag, with validation r >= 0 and the r = 0 boundaries marked as the axis.
- 3D: `extrudeLayered(geom2d, layers)` and `revolve(geom2d, {angle})` give the 3D entity tables (domain `<d>@<layer>`, side `<b>@<layer>`, caps `<d>@<layer>.bottom/.top`). Superseded 16:16 PST: `.L<k>` (s.4.7).

### 1.2 `@amp/mesh`

- Port EO `mesh.mjs` -> `packages/mesh/src/cdt2d.mjs` (+ `.d.mts`). Changes:
  - The hull is the bounding box, and triangles outside every domain are frozen and dropped.
  - Classification is topological: flood fill bounded by tagged subsegments, using the left/right face of each subsegment, so there is no point-in-polygon on the final labels.
  - Segment tags are boundary entity indices, carrying (curve, t0, t1).
  - Segment splits are projected onto the exact curve when that is safe.
  - The vertex key is widened from 2^21 to 2^26, and `maxVertices` becomes an option with no 80k cap.
  - Size sources: polygon, polyline, point.
- TS front end `mesh2d(geom, opts)`:
  - Size field `{hmax, hmin, grade}` plus `refine: [{select: [ids], h, grade}]` on domains, boundaries and points.
  - Curves are discretized at the local size and a max angle.
  - Output is the C2 Mesh: tri3 or tri6 with curve-snapped mid-edge nodes, line2/line3 facets with boundary indices, the entity table, and the hash.
- Quality: triangles (min/max angle, radius-edge, shape q = 4 sqrt(3) A / sum l^2); tets (min/max dihedral, radius ratio). Histograms.
- Ports from APA:
  - `grid/index.mjs` + `spacing.mjs` -> `structured.mjs`. Adapter to C2 hex8 with quad4 facets and boundary tags. Equal-priority overlaps are an error (no later-wins rule).
  - `em3d/mesh.mjs` (zPlanes, Dompierre prism split) -> `layered.mjs`. Input is the C2 2D mesh plus layers. Output is prism6 or tet4, with facet tags from the 2D segment tags and the caps.
- Revolve mesh: sweep tri3 into wedges, merge axis nodes, split by the same min-index rule, and drop degenerate tets.
- Hash: sha-256 (own synchronous implementation, tested against node:crypto) over nodes + cells.conn as C2 says. An optional `tagHash` covers domain/boundary arrays and entity IDs.

### 1.3 3D tet spike

- devDependencies of `packages/mesh`, exact versions: `manifold-3d`, `float-tetwild-wasm`, `@loumalouomega/mmg-wasm` (R4 s.2: 3.5.4, 0.2.0, 0.1.0).
- Check each licence from the package tarball and the upstream repo.
- Node script `packages/mesh/spike/tet-spike.ts`, one shape per process run so RSS is measured per shape:
  - Shapes: box with a cylindrical hole, sphere in a box (two regions), torus.
  - Pipeline: manifold CSG -> surface -> fTetWild -> MMG3D optimize.
  - Record: time, tet count, min dihedral angle, quality, peak RSS, gz bundle size.
- Worker check: a Node `worker_threads` load, plus a short headless browser check only if a browser is available without installs. Any server is killed right after.

### 1.4 Gates (heroes H1-H6)

Mesh each hero geometry with entity IDs and boundary tags, and record time, element count, quality and hash in section 4.
- H1: plate with a hole (2D)
- H2: finned plate (2D)
- H3: axisym coil cross-section with an air box
- H4: Si rib waveguide cross-section
- H5: 3D cylinder cavity (layered extrusion of a circle)
- H6: 3D box (structured hex grid and extruded tets)

Hero dimensions are placeholders for meshing only. They are not physics values.

### 1.5 Constraints

- `nice -n 10`, `node --max-old-space-size=1536`, one heavy process at a time.
- Logs go to `logs/` with a timestamp in the filename. No mesh output is committed.
- No git. Initially, dependencies were installed per package with `pnpm install --ignore-workspace`. From 15:52, after the coordinator's root install, installs run from the root and the per-package lockfiles were deleted.

### 1.6 Plan changes during the lane (coordinator notes, 15:36 and 15:50)

- H(curl): `toHcurlMesh(mesh)` adapter for the `@amp/core` fem/space, nedelec1 and pmg tet-mesh shape (DevLog-002 contract request 3). C2 tet4 conn stays positively oriented, and the adapter sorts each tet's vertices.
- `@amp/spec` types replace the local shim (`packages/geom/src/types.ts` extends them with L3's optional fields).
- Naming aligned with L2 (DevLog-003 s.5 item 4) and the six `sims/*.yaml`:
  - circle and ellipse boundary: `edge`;
  - `difference` names its result after the feature;
  - box z faces: `zmin` / `zmax`;
  - 3D `box` and `cylinder` primitives.
- Feature registrations move to the `@amp/geom/spec` subpath; the gates now run straight from `sims/*.yaml`.

## 2. TODO

- [x] Package skeletons (package.json, tsconfig), deps installed per package (`--ignore-workspace`)
- [x] geom: curves, primitives, arrangement, booleans, IDs, axisym, extrude/revolve entity tables
- [x] geom tests incl. ID stability (14/14)
- [x] mesh: cdt2d port + generalization, mesh2d front end, tri6, quality, hash
- [x] mesh: structured grid port + adapter; layered prism/tet port; revolve mesh
- [x] mesh tests (10/10)
- [x] H(curl) adapter for @amp/core (coordinator note 1), checked against core `buildSpace` orders 1 and 2
- [x] Switch to @amp/spec types; root install; `@amp/geom/spec` registrations + adapter; `@amp/mesh/spec`
- [x] Hero gates H1-H6 from sims/*.yaml, all selected IDs present (section 4.1)
- [x] Tet spike: install, licences, 3 shapes, Node Worker + headless Chrome Worker, recommendation (section 4.3)
- [x] `check` (tsc) and `test` green for both packages (geom 17/17, mesh 10/10)
- [x] Hand-off
- [x] Fresh-context audit (coordinator): `DevLog/audits/2026-11-06-L3-geom-mesh-audit.md`, 1 B / 6 S / 10 M
- [x] Audit corrections (section 7); tests geom 37/37, mesh 11/11; hero gate rerun, hashes unchanged

## 3. Progress log

- 2026-11-06 15:11 PST: Read CLAUDE.md, DevLog-001, CONTRACTS-v0, R4 s.2/s.7, R1/R2 mesh parts and the EO/APA source files. `packages/` was empty. Node v23.7.0, pnpm 10.12.4, no global tsc.
- 2026-11-06 15:15 PST: Plan written (section 1).
- 2026-11-06 15:17 PST: Skeletons; `pnpm install --ignore-workspace` in packages/geom and packages/mesh (typescript 5.9.3, @types/node 24.19.2, robust-predicates 3.0.3); spike devDeps pinned exact: manifold-3d 3.5.4, float-tetwild-wasm 0.2.0, @loumalouomega/mmg-wasm 0.1.0.
- 2026-11-06 15:28 PST: @amp/geom done: curves.ts, arrangement.ts (fine-polyline topology + orient2d + Newton-refined crossings, half-edge faces, component nesting, origin sets propagated across edges), model.ts (primitives, union/intersection/difference(+keepTools)/fragment, final implicit fragment that rejects overlaps, chains -> boundary IDs, `#k`, parents, points, axisym), extrude.ts (layered + revolve entity tables). `node --test`: 14/14 pass; `tsc` clean.
- 2026-11-06 15:33 PST: cdt2d.mjs (EO port), mesh2d.ts, sha256.ts, quality.ts. First mesh: plate with a hole, 1853 tri3, min angle 27.8 deg, 19 ms.
- 2026-11-06 15:36 PST: Coordinator note: L1 done (H(curl) mesh shape), tsconfig lib ES2023, root install done. Per-package lockfiles deleted.
- 2026-11-06 15:40 PST: boxgrid.ts (APA grid port), layered.mjs (APA em3d split port), solid3d.ts (extrude, revolve), hcurl.ts. Mesh tests 10/10. `toHcurlMesh` accepted by core `buildSpace`: order 1 nDof 5135, order 2 nDof 26426, on an RF-01 cylinder mesh.
- 2026-11-06 15:41 PST: First gate run. My H1f row claimed the >80k cap from tri6 node counts, which is wrong (vertices are what count). Fixed to a P1 mesh, and the superseded log was deleted.
- 2026-11-06 15:43-15:46 PST: Tet spike run. Node Worker check passed. Headless Chrome via `--dump-dom` gave no console visibility; rerun over CDP passed (section 4.3). Server and Chrome were stopped, and the temp profiles in the scratchpad were deleted.
- 2026-11-06 15:47 PST: Licences checked (section 4.4).
- 2026-11-06 15:50 PST: Coordinator note: @amp/spec done. Renames: circle `edge`, difference result = feature id, box `zmin/zmax`. Added `meshCylinder`, `@amp/geom/spec`, `@amp/mesh/spec`; dropped the shim; root `pnpm install`. Tests re-baselined to the new names (geom 17/17, mesh 10/10).
- 2026-11-06 15:53 PST: Gates rerun from sims/*.yaml: all 6 validate with the @amp/geom registrations, and 39/39 selected ids are present. Spike rerun with per-stage RSS; MMG `IPARAM_mem` 64 MB test added.
- 2026-11-06 15:58 PST: Hand-off.
- 2026-11-06 16:05-16:24 PST: Audit corrections (section 7).
  - Coordinator grammar decision applied: layers `.L<k>`, revolve `.<rev>`, resolver `resolveEntityIds`.
  - Budget timings: `logs/l3-budget-20261106T161945.jsonl`. Spike, 5 reps: `logs/l3-tet-spike-20261107T002118.jsonl`. Gate: `logs/l3-hero-gates-20261107T002336.jsonl`.

## 4. Results

Platform: Apple M4 Pro, Node v23.7.0 (arm64), `nice -n 10`, heap cap 1.5 GB. Times are the median of 5 runs after 1 warm-up and cover geometry build plus mesh (the 3D rows include the 2D mesh). The hash is stable over the 5 runs for every row.

### 4.1 Hero mesh gates (`logs/l3-hero-gates-20261106T235348.jsonl`; rerun after the audit corrections: `logs/l3-hero-gates-20261107T002336.jsonl`, identical hashes, no warnings, 39/39 ids through `resolveEntityIds`)

Inputs:
- H1-H6 are the L2 specs in `sims/*.yaml`, with their params and `mesh` blocks unchanged (dimensions from the R3 eval cases).
- Each spec validates against `@amp/spec` once the `@amp/geom` feature registrations replace the provisional seed.
- "IDs" = entity ids the spec selects that exist and carry cells or facets.
- Quality columns:
  - 2D: minimum angle; q = 4 sqrt(3) A / sum l^2.
  - 3D tet: minimum dihedral angle; q = 3 r_in / R_circ.
  - hex: q = 6 V_min-tet / V.

| Hero | Mesh | Time (ms) | Cells / nodes | Facets | Domains / boundaries | IDs | Quality | Hash (sha-256, first 16) |
|---|---|---|---|---|---|---|---|---|
| H1 `kirsch-plate` | tri6 | 7.6 | 2635 / 5468 | 197 | 1 / 5 | 6/6 | 25.1 deg, q_min 0.617 | `81aad861265f7ab8` |
| H2 `heat-plate-fin` (NAFEMS T4 plate) | tri6 | 12.6 | 7601 / 15498 | 295 | 1 / 4 | 5/5 | 28.7 deg, q_min 0.596 | `cf0eb80fc320b2d4` |
| H3 `helmholtz-coil` (axisym) | tri6 | 13.8 | 7421 / 15050 | 271 | 3 / 12 | 6/6 | 24.4 deg, q_min 0.504 | `e1d4d9dc9ba523f1` |
| H4 `si-rib-waveguide` | tri6 | 96.9 | 46971 / 94200 | 1822 | 3 / 16 | 11/11 | 23.8 deg, q_min 0.540 | `44481ed4a384c571` |
| H5 `cylinder-cavity` | tet4 (extruded disk) | 5.0 | 6528 / 1395 | 1120 | 1 / 3 | 4/4 | 17.4 deg, q_min 0.416 | `4f46534f6bb583a3` |
| H6 `box-acoustics` | hex8 (structured) | 2.9 | 1232 / 1620 | 708 | 1 / 6 | 7/7 | q_min 1.000, 0 inverted | `c93d3ae0aab451f4` |
| H2b finned plate (bench, placeholder dims) | tri6 | 16.7 | 7522 / 16233 | 1188 | 1 / 24 | n/a | 28.2 deg, q_min 0.610 | `92c591fb3facc886` |
| H6t AC-02 box (bench) | tet4 (extruded) | 27.7 | 59040 / 11492 | 6304 | 1 / 6 | n/a | 16.0 deg, q_min 0.384 | `3e85fb15dc1b7796` |
| H1f H1 refined (bench) | tri3 | 696.8 | 556470 / 279385 | 2298 | 1 / 5 | n/a | 22.1 deg, q_min 0.569 | `6f466d745e6e8a00` |

- H1f shows the cap is lifted: 279,385 vertices against the EO 80k cap. Its time is about 0.7-0.9 s under load (audit M9: 697 / 868 / 822 ms in three runs). H1f exceeds nothing, but the default vertex budget is now 5e5 (section 7, S4).
- H2 in `sims/` is the NAFEMS T4 plate, with no fin. The finned plate is H2b, with placeholder dimensions and no sim yet.
- 2D min angles are at or above the radius-edge bound B = 1.35 (21.7 deg) in every row.
- tri6 curved-element check: minimum Jacobian ratio > 0.5 is asserted in tests. P2 mid-edge nodes lie on the exact circle within 1e-15 relative.

### 4.2 Tests (`pnpm test`; after the audit corrections: geom 37/37, mesh 11/11, see section 7)

- `@amp/geom`, 17/17:
  - areas of primitives and booleans vs closed forms (lens 1e-12);
  - ID stability across 5 topology-preserving parameter changes: identical id tables and adjacency;
  - a topology change is visible;
  - fragment naming, coincident edges, overlap rejection, keepTools, axisym, embedded curves, extrude/revolve tables, determinism;
  - spec registrations; all 6 sims validate; spec adapter ids; 3D primitives.
- `@amp/mesh`, 10/10:
  - SHA-256 vs node:crypto, including the C2 byte definition;
  - 2D conformity, every exterior edge tagged, quality, area, determinism, tri6 on curve, domain-selection refinement;
  - axisym axis nodes at r = 0 exactly, embedded arc facets, >80k vertices;
  - boxgrid facets equal the exterior quads, interface tags, equal-priority overlap rejected;
  - extrude tet4 and prism6: conformity by independent face matching, no inverted tets, volume exact, every boundary entity has facets;
  - revolve: torus volume within 1 % of Pappus (sectors 48), partial-angle caps;
  - `toHcurlMesh`: sorted tets, edge map, Euler characteristic 1.

### 4.3 3D tet spike (single run: `logs/l3-tet-spike-20261106T235406.jsonl`; **superseded by the 5-run statistics in section 7, S5**)

Setup:
- Pipeline: manifold-3d CSG -> triangle soup -> float-tetwild-wasm (serial build: what a browser without COI loads) -> mmg3d `-optim` (hausd = 1e-3 of the bbox diagonal).
- One process per shape, Node, defaults `epsRel 1e-3`, `idealEdgeLengthRel 0.05`.
- Shapes (placeholder dimensions):
  - box-hole: 100 x 100 x 50 mm minus an r 20 mm cylinder;
  - sphere-box: r 25 mm inside a 100 mm cube, two regions classified by tet centroid;
  - torus: R 40 mm, r 10 mm.
- Surface segments: 96, and 48 for the torus section.

| Shape | Surface tris | fTetWild time (ms) | fTetWild tets | min dihedral (deg) / q_min | mmg3d time (ms) | mmg3d tets | min dihedral (deg) / q_min | Inverted | Volume (mmg3d) vs exact | Peak RSS (MB) |
|---|---|---|---|---|---|---|---|---|---|---|
| box-hole | 400 | 4071 | 12432 | 9.0 / 0.147 | 516 | 19739 | 20.2 / 0.266 | 0 / 0 | 4.37372e-4 vs 4.37168e-4 m^3 (+0.05 %, faceted hole) | 862 |
| sphere-box | 4620 | 3179 | 21212 | 16.1 / 0.233 | 965 | 33503 | 18.1 / 0.340 | 0 / 0 | sphere 6.49078e-5 vs 6.54498e-5 (-0.8 %), box 9.35076e-4 vs 9.34550e-4 | 871 |
| torus | 9216 | 3873 | 10601 | 12.7 / 0.223 | 762 | 26928 | 18.0 / 0.282 | 0 / 0 | 7.83131e-5 vs 7.89568e-5 (-0.8 %, faceted section) | 834 |

- Load times (Node): manifold 11 ms, fTetWild 10-12 ms, MMG 13-15 ms.
- RSS after load: 39 / 43 / 42 MB, from a 31 MB baseline.
- RSS by stage (box-hole): 94 MB after the loads, 214 MB after fTetWild, 846 MB after mmg3d. The peak is in the mmg3d stage.
- `IPARAM_mem = 64` MB makes mmg3d fail (`ier 1`, "unable to allocate initial solution"). RSS still reached 559 MB. The cause is open.
- fTetWild output is not deterministic run to run:
  - torus tets: 11596, 9755, 10601 over three runs;
  - the one-tet smoke test gave 510 tets in Node and 670 in Chrome.
- A mesh hash from this path is therefore not reproducible.
- Bundle size, gzip -9 of the files a browser fetches:

| Package | Raw (MB) | gzip -9 (MB) |
|---|---|---|
| manifold-3d 3.5.4 (js + wasm) | 0.624 | 0.224 |
| float-tetwild-wasm 0.2.0, serial (index + mjs + wasm) | 2.233 | 0.730 |
| @loumalouomega/mmg-wasm 0.1.0 (mjs + runtime + descriptor + core + wasm) | 1.500 | 0.453 |

- Worker loading:
  - Node `worker_threads`: all three load and run (`spike/worker-check.mjs`).
  - Headless Chrome 156, module Worker, no COI: all three load and run.
    - `spike/browser-check.html`, `browser-worker.mjs`, `browser-cdp.mjs`.
    - Throwaway `python3 -m http.server` on 127.0.0.1:47813 and DevTools on 47814; both were stopped after the run.
    - fTetWild picked its serial build itself (`threaded: false`, `crossOriginIsolated: false`).
  - Browser timings were not recorded: the worker read the clock before awaiting, and that is fixed in the file now.

Recommendation:

| Package | Verdict | Reason / condition |
|---|---|---|
| manifold-3d 3.5.4 | **Adopt** (tier-2 3D CSG) | Apache-2.0, 0.22 MB gz, ~10 ms CSG, loads in a Worker without COI. Its mesh output is Float32, so snap vertices in f64 before tagging |
| float-tetwild-wasm 0.2.0 | **Adopt with conditions**, lazy, never the default hero path | Robust: 0 inverted on all shapes. Conditions: (1) 3-4 s serial for 10-20k tets misses the < 1 s re-mesh target, so run it in a Worker with progress; (2) output is not deterministic, so cache the mesh by input hash and treat the result as data, not a function of the spec; (3) no per-region sizing or labels, so domains come from centroid classification; (4) the npm tarball ships no LICENSE or third-party notices, so our build must carry MPL-2.0 + deps notices; (5) single maintainer: pin and vendor the build script (`.github/workflows/wasm.yml` of the fork) |
| @loumalouomega/mmg-wasm 0.1.0 | **Adopt with conditions** for quality optimisation after fTetWild; **hold** for mobile | Corrected (audit S5): over 5 runs, the min-dihedral gain is median +3.4 to +5.2 deg but ranges from -0.8 to +7.9 deg, and the min radius ratio can drop. MMG `-optim` is a usual-case improvement, not a guarantee. Keeps domain refs; LGPL-3.0+ (compatible). The ~0.6 GB RSS growth needs a size study before phone targets |

The heroes do not need the WASM path: H5 is an extruded disk and H6 a structured grid. Revolve covers coils and tori, at 48 sectors within 1 % of the Pappus volume.

### 4.4 Licences (checked 2026-11-06 from the tarballs and the GitHub API)

| Package | Tarball | Upstream | Notes |
|---|---|---|---|
| manifold-3d 3.5.4 | LICENSE = Apache-2.0 | elalish/manifold: Apache-2.0 | GPLv3-compatible |
| float-tetwild-wasm 0.2.0 | package.json MPL-2.0; **no LICENSE file** | loumalouomega/fTetWild (fork of wildmeshing/fTetWild): MPL-2.0, LICENSE.MPL2 | File headers are plain MPL-2.0, with no "Incompatible With Secondary Licenses" notice, so MPL s.3.3 allows GPL combination. GMP is forced off under Emscripten. Bundled deps, with Geogram resolved: see `packages/mesh/THIRD_PARTY_NOTICES.md` (Geogram v1.9.6 BSD-3 Inria; TetGen must be pinned OFF) |
| @loumalouomega/mmg-wasm 0.1.0 | LICENSE = LGPL-3.0 | loumalouomega/MMG-WASM: LGPL-3.0; MmgTools/mmg LICENSE: "LGPL ... version 3 ... or any later version" (COPYING, COPYING.LESSER) | LGPL-3.0-or-later; serving the wasm needs the source offer (R4 s.8) |
| robust-predicates 3.0.3 | Unlicense | mourner/robust-predicates | runtime dep (C1) |

### 4.5 Port map

| New file | Source | Changes |
|---|---|---|
| `packages/geom/src/polygon.mjs` | EO `engine/src/geometry.mjs`@0546007 | buildPslg removed; comments |
| `packages/mesh/src/cdt2d.mjs` | EO `engine/src/mesh.mjs`@0546007 | Heap and Triangulation verbatim (vertex key 2^21 -> 2^26). meshDomain rewritten: tagged PSLG, padded hull, curve projection of splits, topological flood-fill labels, exterior frozen, segment-set size sources (domain / boundary / point), `maxVertices` option |
| `packages/mesh/src/grid/{index,spacing}.mjs` | APA `engine/src/grid/*`@fe39985 | none; the C2 adapter (`boxgrid.ts`) rejects equal-priority overlaps |
| `packages/mesh/src/layered.mjs` | APA `engine/src/em3d/mesh.mjs`@fe39985 (not Palace-derived; not in APA em3d NOTICE) | Only zPlanes interval subdivision and the Dompierre prism split; painter-order solids, cuts and subMesh not ported |

New TS:
- geom: `curves`, `arrangement`, `model`, `extrude`, `types`, `spec`.
- mesh: `mesh2d`, `sha256`, `quality`, `boxgrid`, `solid3d`, `hcurl`, `spec`.

### 4.6 H(curl) adapter for @amp/core (coordinator note 1)

`toHcurlMesh(mesh)` in `packages/mesh/src/hcurl.ts` returns what `@amp/core` fem/space.mjs, fem/nedelec1.mjs and la/pmg.mjs read:
- `nodes` (3 per node, m), `nNodes`;
- `tets` (4 per tet, **sorted ascending**), `nTets`;
- `edges` (a < b), `nEdges`;
- `tetEdges` (6 per tet, local pairs 01 02 03 12 13 23 = core `TET_EDGES`), `edgeIndex(a, b)`;
- `tetSolid` (= cells.domain).

C2 `cells.conn` for tet4 stays positively oriented, so other consumers keep the orientation. Checked: `buildSpace` order 1 (5135 DOF) and order 2 (26426 DOF) on an RF-01 cylinder mesh. Not covered: pmg's `solidProps` / PEC context, which is an em3d case model (DevLog-002 s.7 item 7).

### 4.7 ID grammar (confirmed for L2, DevLog-003 s.5 item 4)

Primitives:
- rect: `bottom right top left`, points `p0..p3` (p0 = (x0, y0), counter-clockwise).
- circle and ellipse: `edge`.
- polygon: `e0..` (edge i from point i to i+1), `v0..`.
- arc: `e0`, `v0 v1`.
- polyline: `e0..`, `v0..`.
- box: `xmin xmax ymin ymax zmin zmax`.
- cylinder: `side bottom top`.

Booleans:
- union, intersection and difference (single-domain base) name the result domain after the feature. A difference whose base has several domains keeps the base's domain ids.
- fragment: `a&b` (origin domains in construction order).
- Boundaries keep the creating feature's id. Pieces are `#k`, in source parameter order (edges) or first-boundary-contact order (domains), with `parent` = origins.
- Coincident sources: the first in construction order wins, and the rest go in `parent`.
- New intersection points: `<feature>.x<k>`.

Layered extrude and revolve (changed 16:16 PST by the C2 grammar decision; `@` is reserved for operation-log tokens):
- layer k (0-based, in list order): `<d>.L<k>`, `<b>.L<k>`, `<d>.L<k>.bottom` / `.top`; the layer id is kept as a `label`;
- revolve `rev`: `<d>.rev`, `<b>.rev`, `<d>.rev.start` / `.end`.

Grammar details:
- Repeated splits: `X#k#m` (from 1, up to 8 levels per the C2 decision). Pieces of a boundary are numbered along the *source curve direction*, so `rect.top#1` is the right-hand piece, because top runs from p2 to p3 (audit M8).
- Fragment names follow the order of the fragment's `inputs` list, not the construction order: `inputs: [b, a]` gives `b&a` (audit M2, text corrected).
- Every entity carries `ancestors` (all transitive origins), used by the resolver.
- A circle's angle-0 seam is no longer a point entity (audit M1).

Canonical resolver: `resolveEntityIds(table, kind, ids) -> {indices, unknown, expansion}`, exported by `@amp/geom`.
- It matches the exact id, pieces `X#k...` at any depth, and `parent` or `ancestors`. It never throws.
- `expansion` (id -> matched ids) is an addition, for readiness messages.
- `selectIndices` is the throwing wrapper the meshers use. The old `resolveSelection` is removed.

Structured boxes: an interface is owned by the minus-side box (`<box>.zmax#k`, plus-side face in `parent`), plus `bnd:sym.x` and `bnd:sym.y`.

New feature types beyond the seed: ellipse, arc, polyline, intersection, fragment.

## 5. Contract requests

1. **C2 optional fields** into `@amp/spec/types`. Today they are typed in `packages/geom/src/types.ts` as an extension:
   - `EntityRef.axis`;
   - `Mesh.tagHash`, `quality`, `stats`, `pointNode`, `facets2`.
2. **C2 mixed facets.** prism6 needs tri3 caps and quad4 sides; one `facets.type` cannot hold both. Now: `facets` = tri3 and `facets2` = quad4. Request: `facets` as an array of blocks, or adopt `facets2`.
3. **C2 hash scope.** `hash` covers nodes + cells.conn only, so a re-tagged mesh (different domains or boundaries) keeps the same hash. Request: run records also carry `tagHash`, which covers cells.domain, facets.conn, facets.boundary and the entity ids, or C2 widens `hash`.
4. **C1 runtime dependencies.** `@amp/geom` now depends on `@amp/spec` (workspace) and `zod` 4.6.7, for the `@amp/geom/spec` subpath only; the main entry imports neither. Approve, or have `@amp/spec` re-export `z` so geom needs only `@amp/spec`.
5. **C3 `mesh.size.grading`.** L3 maps it to the size growth per unit distance, h = h0 + g d (default 0.3). Please document this. A per-refine `grade` would also help; it exists in `mesh2d` but not in the schema.
6. **Selection semantics (C3/L2).** Resolved 16:16 PST: `resolveEntityIds` (s.4.7, section 7 S1). An id selects the exact entity. Selecting all pieces of a split or merge needs the descendants rule (`resolveSelection(..., {descendants: true})` matches `parent`). Which rule does the spec use when an id no longer exists exactly?
7. **L4**: `toHcurlMesh` (section 4.6) is the tet input for core H(curl). For 3D specs, `mesh.refine` is not wired for boxgrid and cylinder; only `size.hmax` is used.

## 6. Hand-off

Done:
- `@amp/geom`: 2D primitives, exact-curve booleans with persistent IDs, axisym, extrude and revolve entity tables, spec bindings.
- `@amp/mesh`:
  - 2D CDT with size fields, entity refinement, tri6 and quality;
  - structured hex;
  - layered prism/tet, revolve and cylinder;
  - C2 hash and tagHash;
  - H(curl) adapter;
  - spec mesher.
- 3D spike measured.
- Hero gates 6/6 from sims, with 39/39 selected ids present.

Run:
```
pnpm --filter @amp/geom test && pnpm --filter @amp/mesh test
nice -n 10 node --max-old-space-size=1536 packages/mesh/bench/hero-gates.ts
nice -n 10 node --max-old-space-size=1536 packages/mesh/spike/tet-spike.ts
```

Open:
- 3D CSG in `@amp/geom` (tier 2 via manifold) is not integrated. 3D tier 1 is a box list, one cylinder, extrude or revolve.
- Arrangement limit: crossing detection uses 1-degree chords, so a near-tangent double crossing inside a chord sagitta (3.8e-5 r) is missed. Correction (audit M3): coincident equal circles do work under fragment and union.
- No uniform h-refinement helper (`refineUniform`) yet. Convergence studies re-mesh at a smaller h instead.
- Spike: mmg3d memory (~0.6 GB RSS growth), fTetWild nondeterminism, browser timings not recorded. Geogram licence resolved: BSD-3 (THIRD_PARTY_NOTICES.md).
- Fresh-context audit pending (coordinator).
- Scratch: `.request-tmp/` (geom-smoke.ts, mesh-smoke.ts, hcurl-check.ts, unit-check.ts, rss-base.mjs, a node_modules symlink) is gitignored. No mesh files were written.

## 7. Audit corrections (audit `DevLog/audits/2026-11-06-L3-geom-mesh-audit.md`, applied 2026-11-06 16:05-16:24 PST)

| # | Finding | Disposition | Change and evidence |
|---|---|---|---|
| B1 | A curve touching a horizontal edge from below gives an empty geometry, then a TypeError | **Fixed** | `arrangement.ts`: `dirAngle()`. `+ 0` removes -0, and angles within 1e-10 of -pi are folded onto +pi, so ties across the cut reach the curvature tie-break. Post-conditions: Euler V - E + F = 1 + C and positive face areas, else a clear error. `buildGeometry2D` throws when the final geometry has no domain; `mesh2d` throws "the geometry has no domain to mesh". 18 regression tests: circles touching the bottom, top, left and right edges and an ellipse below, each as final / union / fragment; inner tangency; wire below a slab; a tilted polygon. **With the old atan2, 7 of the 18 fail; with the fix, 18 of 18 pass** |
| S1 | Two inconsistent selection resolvers; nested pieces unselectable | **Fixed** | One canonical `resolveEntityIds(table, kind, ids)` in `@amp/geom`, the name and signature fixed by the coordinator and L2 (DevLog-003 s.8, contract changelog 16:16). It matches exact, `X#k...` at any depth, and `parent` + new `ancestors` (lineage recorded through every boolean, extrude and revolve). It never throws; `expansion` is returned for readiness. `mesh2d` refine and the hero gate use it (via `selectIndices`). Test: bar -> p#1 / p#2#1 / p#2#2. `dom:bar` and `dom:p` select all three, `dom:p#2` selects two, `bnd:bar.bottom` selects all three pieces. L2 delegates `checkSelections` to it |
| S2 | No quality guard (min angles near 0 deg accepted) | **Fixed (warn)** | `Mesh.warnings` (L3 optional field) gets an entry when the min angle is below `warnAngleDeg` (default 5; count of bad triangles), for each boundary shorter than 2 hmin, and from geometry warnings for entities within 1000 x tol. Physics readiness should list `mesh.warnings` as reasons (to L4). Test: an internally tangent circle warns, and a clean H1 mesh has no warnings. All 9 gate rows: no warnings. No automatic hmin floor (left to the user, now told) |
| S3 | Features below about 5e-9 of the diagonal dropped silently | **Fixed** | Three new errors, each naming the feature: (a) a primitive whose extent is below 10 x tol; (b) an entity whose curves all collapse; (c) one entity folding onto itself as coincident pieces. Probe on a 1 m square: r = 2e-8 and 1e-8 kept; 7e-9, 5e-9, 3e-9 and 1e-9 raise clear errors; none drops silently. Test added. r = 1e-8 is kept but its area error is 6 %, which is what the near-tolerance warning reports |
| S4 | The default vertex budget (4e6) runs 16 s / 1.2 GB before failing | **Fixed** | Default `maxVertices` = **5e5** (`DEFAULT_MAX_VERTICES`), a parameter. Measured (`logs/l3-budget-20261106T161945.jsonl`): 556,098 vertices in 3.6 s / 437 MB peak RSS; 1,077,706 in 8.1 s / 648 MB. Up-front estimate from the size field on a 64 x 64 grid, calibrated at 1.1 vertices per (sqrt(3)/4 h^2) (measured 1.11 / 1.08). Over-budget cases fail in 2-3 ms; hmax 1e-4 on 1 m^2 gives "about 1.2e+8 vertices estimated". The in-CDT check stays as the backstop. Test added |
| S5 | Single-run spike numbers do not reproduce; the MMG claim is not robust | **Fixed** | 5 reps per shape (`logs/l3-tet-spike-20261107T002118.jsonl`; table below). MMG claim corrected in s.4.3: the median gain is positive, the range includes a loss |
| S6 | Licences and notices needed before any WASM ships | **Fixed (doc)** | `packages/mesh/THIRD_PARTY_NOTICES.md`. Clipper2 BSL-1.0 checked from AngusJohnson/Clipper2, and its symbols are present in manifold.wasm. fTetWild fork commit `b6362a34`, Geogram v1.9.6 BSD-3 (Inria, LICENSE at tag), oneTBB, libigl, fmt, spdlog, CLI11, json, fast-envelope, MMG LGPL-3.0-or-later. **TetGen must be pinned `-DGEOGRAM_WITH_TETGEN=OFF` (FORCE) in our vendored build before shipping.** The fork has only an overridable `option(... OFF)`; 0 TetGen strings in the 0.2.0 wasm |
| M1 | Circle seam vertex named like an intersection | Fixed | closed chains mark no end vertex |
| M2 | Fragment name order | Fixed (doc) | s.4.7: input order |
| M3 | Equal circles do work | Fixed (doc) | s.6 corrected |
| M4 | Error messages | Fixed partly | "boundarie" fixed (`selectIndices`); the doubled `geom: geom:` came from the final op's label and now reads "final fragment of the remaining objects"; long edge lists are cut to 6 boundary ids. Bowtie "zero area" wording: deferred |
| M5 | Chord-fallback split keeps a parametric t | Deferred | Not triggered (max offset 1.1e-13 of the edge); the fix needs a projection callback into cdt2d.mjs |
| M6 | No SPDX line in browser-check.html | Fixed | HTML comment SPDX line |
| M7 | `budget.maxNodes` semantics | Fixed (doc) | `@amp/mesh/spec` comment: it maps to the P1 vertex budget, not the tri6 node count |
| M8 | `#k` direction | Fixed (doc) | s.4.7 |
| M9 | H1f time | Fixed (doc) | s.4.1: about 0.7-0.9 s |
| M10 | O(curves^2) arrangement | Deferred | Fine for the heroes (196 holes: 126 ms build); needs a spatial index for large patterned layouts |

S5: tet spike, 5 runs per shape (Node, serial fTetWild, mmg3d `-optim`; median [min, max]):

| Shape | fTetWild ms | fTetWild tets | fTetWild min dihedral (deg) | mmg3d ms | mmg3d tets | mmg3d min dihedral (deg) | Gain in min dihedral (deg) | mmg3d min radius ratio | Peak RSS (MB) |
|---|---|---|---|---|---|---|---|---|---|
| box-hole | 3803 [3024, 4979] | 11298 [10921, 13237] | 11.6 [10.4, 12.4] | 500 [466, 539] | 16625 [16421, 20257] | 17.0 [14.6, 18.1] | +5.2 [+2.2, +7.7] | 0.196 [0.191, 0.292] (fTetWild 0.264) | 855 [832, 870] |
| sphere-box | 2427 [2349, 2902] | 19803 [19689, 22916] | 12.1 [11.2, 15.1] | 943 [927, 1004] | 32579 [32159, 33541] | 17.5 [14.4, 19.1] | +4.5 [-0.8, +7.9] | 0.311 [0.257, 0.320] | 890 [875, 900] |
| torus | 4654 [3861, 5083] | 9965 [9452, 10300] | 12.3 [11.5, 13.6] | 772 [756, 808] | 26930 [26431, 27351] | 15.6 [13.3, 18.5] | +3.4 [+0.5, +7.0] | 0.314 [0.126, 0.333] | 848 [824, 870] |

Inverted tets: 0 in all 15 runs.

Verdicts after S5:
- manifold: adopt.
- fTetWild: lazy and optional, cached by input hash (not deterministic).
- MMG: adopt with conditions as an optimiser whose gain is usual but not guaranteed (keep the better of the before and after meshes by min dihedral); hold for mobile because of memory.

Not changed: the tet4 C2 orientation and the H(curl) adapter (audit s.4: correct). Hero hashes are unchanged by the corrections (they touch tags, lineage and checks, not node or connectivity bytes).

## 8. Follow-up for L4 (DevLog-010 s.5 item 6; 2026-11-06 16:25-16:35 PST)

| Request | Done | Where |
|---|---|---|
| (1) `refineUniform(mesh, {geometry?, project?})` | tri3, tri6, tet4, tet10 red refinement (4 / 8 children; octahedron cut along its shortest diagonal; children re-oriented positive) | `packages/mesh/src/refine.ts` |
| (2) curved tet10 cylinder | `meshCylinder(spec, {order: 2})` = tet4 extrusion + `toP2` with side mid-edge nodes projected radially onto r = a (geometric midpoint: mean angle, mean height); `cylinderSideProjector`, `cylinderProjector` | `solid3d.ts`, `refine.ts` |
| (3) M5 | chord-fallback split points now record the parameter of their projection (`curveProject` callback into cdt2d) | `cdt2d.mjs`, `mesh2d.ts` |

`refineUniform` behaviour:
- Nesting: every child is the parent's geometry map (affine P1, quadratic P2) applied to a reference sub-simplex.
- Old nodes keep their indices and new nodes are appended, so `pointNode` stays valid.
- `cells.domain`, `facets.boundary` and the entity table are copied unchanged.
- New boundary nodes go to the exact curve:
  - 2D: mesh2d now stores `facetCurve` (geometry edge index) and `facetParam` (t at both facet ends) on the mesh, and refinement splits them.
  - 3D: through the projector.
- Helpers: `curvedQuality` (area or volume by collapsed Gauss-Legendre 5^d on the P2 map, plus the minimum Jacobian ratio) and `boundaryMeasure` (facet length or area, P1 or P2).

Convergence, RF-01 cavity a = 2.74 cm, d = 2a, exact V = pi a^2 d, S = 2 pi a (a + d) (`logs/l3-cyl-convergence-20261107T003052.jsonl`, `packages/mesh/bench/cylinder-convergence.ts`):

| Series | h (mm) | Tets | V rel. error | order | S rel. error | order | min Jacobian ratio (P2) |
|---|---|---|---|---|---|---|---|
| nested tet4 | 13.70 | 1032 | -5.07e-3 | - | -2.54e-3 | - | (0 inverted) |
| nested tet4 | 6.85 | 8256 | -1.27e-3 | 2.00 | -6.34e-4 | 2.00 | |
| nested tet4 | 3.43 | 66048 | -3.17e-4 | 2.00 | -1.59e-4 | 2.00 | |
| nested tet10 | 13.70 | 1032 | -1.93e-6 | - | -1.29e-6 | - | 0.979 |
| nested tet10 | 6.85 | 8256 | -1.22e-7 | 3.99 | -8.08e-8 | 3.99 | 0.955 |
| nested tet10 | 3.43 | 66048 | -7.65e-9 | 4.00 | -5.06e-9 | 4.00 | 0.977 |
| fresh tet4 | 13.70 / 6.85 / 3.43 | 1032 / 6000 / 47040 | -5.07e-3 / -5.07e-3 / -1.66e-3 | - / 0.00 / 1.61 | -2.54e-3 / -2.54e-3 / -8.30e-4 | | |
| fresh tet10 | 13.70 / 6.85 / 3.43 | 1032 / 6000 / 47040 | -1.93e-6 / -1.93e-6 / -2.68e-7 | - / 0.00 / 2.85 | -1.29e-6 / -1.29e-6 / -1.78e-7 | | 0.979 / 0.996 / 0.994 |

- Fresh meshes at h = a/2 and a/4 have the same boundary, because the 10-degree turning-angle limit (36 segments), not hmax, sets the circle discretization there. For a clean h-sequence, use the nested series, or set `maxAngleDeg` small enough that hmax governs.
- Nested sequences reach the asymptotic orders exactly: 2 (straight tet4) and 4 (curved tet10). Richardson on them is well posed.

Tests (mesh 13/13; tsc clean in both packages):
- 2D disk: tri3 and tri6 nested, 3 levels. Every facet node (corners and mids) stays on the circle (< 1e-14). Area order 2 / 4. The old nodes are unchanged.
- 3D cylinder: tet4 conformity checked at every level, and tet10 Jacobian ratio > 0.5. Volume and area orders 2 / 4 within 0.2.

Hero gate (`logs/l3-hero-gates-20261107T003236.jsonl`):
- The gate now records a failing row instead of aborting.
- H1-H3, H5, H6, H2b, H6t and H1f: hashes identical to before.
- **H4 now fails before meshing**, and the cause is outside L3. `@amp/spec` param validation now reserves `t` (field symbol), and `sims/si-rib-waveguide.yaml` uses a param `t` (slab thickness). With `t` renamed in a scratch copy, the H4 mesh is unchanged: hash `44481ed4a384c571`, 46,971 tri6, no warnings.
- The same cause fails 1 geom test, "every sims/*.yaml validates" (geom 36/37). The sims owner (L2) should rename `t`; L3 left the test and `sims/` as they are.
