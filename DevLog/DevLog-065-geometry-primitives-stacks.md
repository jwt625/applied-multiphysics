# DevLog-065: geometry primitives reuse, stack point entities, thin-layer guidance (lane G8, chunk 3)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | G8 (DevLog-037 s.4.2) |
| Owns | `packages/geom/**`, `packages/mesh/**`, new tests there, this file |
| Not owned | sims, `packages/spec/**`, `packages/physics/**`, `CONTRACTS-v0.md` (requests in s.6) |

Conventions: F = fact read from code, files or runs; E = estimate; D = decision; O = open item; R = request.

## 1. Plan (2026-11-18 18:19 PST)

### 1.1 Facts at start
- F: `buildGeometry2D` (`packages/geom/src/model.ts`) keeps a `live` map; a boolean takes its inputs from it and deletes them (difference: target, and tools unless `keepTools`); a later reference fails with "input 'x' was already consumed". Hence duplicate shapes in sketches: `sims/tsv-stress-3d.yaml` has `tsv` / `hole` and `quad` / `quad2` (DevLog-049 R4).
- F: no spec-level consumption check exists (`packages/spec` validates only that refs exist); `apps/web` spec-adapter calls `buildGeometry2D`.
- F: stacks (`packages/geom/src/stack.ts` `buildStack`) produce domains and boundaries only; no `pnt:` / `edg:` (DevLog-044 O6). PK-06 (`sims/die-warpage-3d.yaml`) holds a 0.1 mm patch at u_z = 0 instead of pinning a point.
- F: physics point constraints already work through `Mesh.entities.points` + `Mesh.pointNode` (`packages/physics/src/coupled/assemble.ts` `bcNodes`, used by elastic `fixed` / `displacement`).
- F: `tagHash` is consumed only inside `packages/mesh`; 2D meshes (`mesh2d`, `refineUniform`, `toP2`) hash domain + boundary + point ids; `meshStack` hashes domain + boundary ids.
- F: flat-tet warning (`meshStack`, `FLAT_TET_DEG = 5`, design threshold) gives one global min dihedral without the layer.
- F: baseline mesh dump of all 70 sims (meshFromSpec order 1 and 2: hash, tagHash, nodes, cells, facets, point count, warnings; 3D stacks also one `refineUniform` level of the order-2 mesh as prepareRun does: hash, tagHash, nodes): `logs/G8-regress-before-20261118T181624.json` (scratch script `<scratch>/g8/regress.ts`, peak RSS 0.39 GB). Stack sims: die-warpage-3d, interposer-thermal-3d (warns: min dihedral 1.20 deg), tsv-stress-3d.

### 1.2 Decisions
- D1 (consumption rule). Every feature id names the shape that feature built; shapes are immutable. A boolean may reference any earlier feature, also one that an earlier boolean already used, any number of times; each reference uses that feature's own shape (never a later boolean's result). Referencing consumes: a consumed feature is not in the final geometry by itself. Exception, as today: difference tools with `keepTools` stay in (or, when consumed earlier, return to) the final set as separate domains. Final geometry = features not consumed, fragmented; overlaps without a boolean stay an error. Errors: an input not defined before the feature (unchanged text); an id listed twice in one boolean (base also among the tools, or a repeated input): new clear error. Existing specs (each feature used by at most one boolean) build exactly as before: the live-set order is untouched when a kept tool is already live.
- D2 (stack points). For every named 2D point P of layer l's sketch (rect corners `p0..p3`, polygon / polyline `v<i>`, arc ends, boolean intersection points `x<i>`), one 3D point at the layer's bottom plane and one at its top plane: `pnt:<P>.<l>.bottom`, `pnt:<P>.<l>.top` (split suffix moved to the end, as for domains). Two layers sharing a plane and a point location give one entity: the lower layer's `.top` owns the id, the upper layer's `.bottom` name goes into `parent` (cap rule of DevLog-044 s.1.3). `parent` also lists the plain 2D id `pnt:<P>` (selects that corner at every plane, as `dom:<D>` selects every layer); `ancestors` add `pnt:<P>.<l>` (both planes of layer l) and the 2D ancestors. Mixed boxes / z cylinders (`stackFromSolids`): no points (2D rect corner names would read as box names; box corner names are not defined in C2): O-item.
- D3 (`edg:`): not added: the Mesh has no edge-element block and no consumer selects edge nodes in 3D; O-item.
- D4 (tag hash). 3D meshes keep hashing domain + boundary ids (`meshStack`, and `refineUniform` / `toP2` when `dim === 3`); stack point ids are derived from the sketch and layer ids already covered. 2D unchanged. So every existing mesh keeps hash and tagHash.
- D5 (flat-tet guidance). When the global min dihedral is below `FLAT_TET_DEG`, the per-layer min dihedral is computed (cost only then) and one warning per layer below the threshold names the layer, its min dihedral, its z cell height and the largest in-plane cell edge in that layer, and the remedy: `mesh.refine` on that layer's sketch domains (ids listed) with h near the z cell height, or a smaller `mesh.size.hmax`. Warnings are not hashed.
- D6 (opt-in in-plane refinement). `meshStack` option `maxLayerAspect` (dimensionless; off by default): for every layer whose z cell height dz gives `maxLayerAspect * dz < hmax`, the overlay faces active in that layer get a refine entry with h = `maxLayerAspect * dz`. `meshFromSpec` reads `mesh.size.maxLayerAspect` when present (schema line: request R2); absent = unchanged path.

### 1.3 Gates
- Mesh regression: all 70 baseline sims identical (hash, tagHash, nodes, cells, facets at order 1 and 2; refined level of the stack sims); only warning text may change (interposer-thermal-3d).
- geom / mesh / physics tests green; `pnpm -r check` clean.
- Tests: reuse rule (tool in two differences, union + difference, keepTools after consumption, duplicate in one boolean, undefined input text, unique-consumer geometry identical to before); tsv-stress-3d sketch without duplicates gives the same domains / areas; stack points (names, parent, coincident planes, node coordinates at order 1 and 2, nested refinement keeps pointNode); flat warning names the layer; maxLayerAspect raises the layer's min dihedral.
- Physics check (scratch, logged): small elastic stack under thermal expansion pinned only by points (corner fixed + two corners with partial pins) solves; PK-06 variant pinned at `pnt:quarter.p0.sub.bottom` instead of the patch compared with the current result.

## 2. TODO
- [x] baseline mesh dump
- [x] D1 reuse rule + tests
- [x] D2 / D4 stack points + mesh pointNode + tests
- [x] D5 / D6 flat-tet guidance and option + tests
- [x] regression after, tests, check
- [x] physics check (scratch) and PK-06 proposal
- [x] requests, hand-off

## 3. Progress
- 2026-11-18 18:13 PST: read brief, DevLog-037 s.4, -044, -049 R4, -050, -055; geom / mesh sources.
- 2026-11-18 18:16 PST: baseline dump `logs/G8-regress-before-20261118T181624.json` (70 sims).
- 2026-11-18 18:19 PST: plan written (s.1).
- 2026-11-18 18:21 PST: D1 in `packages/geom/src/model.ts` (`buildGeometry2D`: `built` map of every feature's own shape; `take` reads it; duplicate-input check; keepTools re-adds a tool with `Map.set`, which keeps an already-live tool in place). Tests `packages/geom/test/reuse.test.ts` (7). A first test asserting final domain order was wrong (order follows boundary keys, not insertion) and was dropped; the regression dump is the identity check.
- 2026-11-18 18:22 PST: D2 / D4 (`packages/geom/src/stack.ts` `stackPoints`, `BuildStackOptions.points`, `Stack.pointAt`; `packages/mesh/src/stack.ts` `pointNode`; `packages/mesh/src/refine.ts` `tagIds`), D5 / D6 first version, `meshFromSpec` reads `mesh.size.maxLayerAspect`. Regression `logs/G8-regress-after1-20261118T182227.json`: 70 / 70 identical.
- 2026-11-18 18:23 PST: D6 probe (scratch `aspect.ts`; 1 x 1 mm plate, 0.5 mm substrate (nz 2) under a 0.4 x 0.4 mm, 2 um skin, hmax 0.2 mm). Min dihedral: no option 0.81 deg (skin), 774 cells; aspect 4: 0.48 deg (substrate, tall cells under the 8 um in-plane cells), 135,348 cells; aspect 20: 2.54 deg (substrate) / 3.03 deg (skin), 8,571 cells; aspect 50: 1.29 deg (skin), 1,839 cells; aspect 4 with substrate nz 20: 4.64 deg, 1,017,294 cells; aspect 20 with nz 20: 3.03 deg, 72,237 cells. F: the 2D mesh is shared by every layer, so in-plane refinement for a thin layer gives tall cells in the thick layers over it unless they get more z cells. D5 changed accordingly: the warning classifies the worst cell of each flagged layer (wider than tall / taller than wide / thin 2D triangle) and gives the matching remedy; D6 kept as opt-in with this trade-off stated.
- 2026-11-18 18:25 PST: aliases: a stack point also answers to the per-plane / per-layer forms of its 2D aliases (coincident points of other features), as side walls do since DevLog-044 s.7. Tests `packages/mesh/test/stack-points.test.ts` (6). geom 58 / 58, mesh 30 / 30 (`logs/G8-geom-test-20261118T182509.log`, `logs/G8-mesh-test-20261118T182509.log`).
- 2026-11-18 18:26 PST: physics check (scratch `pin.ts`, `logs/G8-pin-check-20261118T182649.log`, peak RSS 0.34 GB): (1) one-material two-layer stack (1 x 1 mm, 0.2 + 0.1 mm, tet10, 783 cells, 12 point entities), uniform -100 K, held only by `fixed` at `pnt:cell.p0.lo.bottom`, `uy, uz = 0` at `pnt:cell.p1.lo.bottom`, `uz = 0` at `pnt:cell.p3.lo.bottom`: max |u - alpha dT x| = 2.0e-19 m vs max |u| 1.0e-6 m (free expansion exact to round-off; test coefficients, not material data). (2) PK-06 as in `sims/` vs without the centre patch, pinned by `fixed` at `pnt:quarter.p0.sub.bottom`: curvature -2.060534 vs -2.060427 1/m (case reference -2.0602699631, tolerance rel 2e-3: 1.3e-4 vs 7.6e-5 off); uz(x1) -1.015608 vs -1.030208 um (the patch held 0.1 mm flat); 1068 vs 960 cells.
- 2026-11-18 18:27 PST: tsv-stress-3d without the duplicate shapes (scratch `tsvvar.ts`): same mesh hash at order 1 and 2 (`ac120d1b6e07f107`, `d6cb15c0cc2704df`), same node / cell / facet counts; tagHash differs only through entity ids (`bnd:quad2.left.wafer` -> `bnd:quad.left.wafer#2`, `hole` names gone).
- 2026-11-18 18:27-18:30 PST: physics tests 195 / 196 (`logs/G8-physics-test-20261118T182717.log`, 185 s): the failure is `perf-core-1.test.ts` 'stationary settings.solver: invalid values are rejected ...' expecting `elastic` absent from the solver-setting list: the solver lane's work in progress (elastic in the study solver setting), not a geometry / mesh path. `pnpm -r check` exit 0, svelte-check 0 errors (`logs/G8-check-20261118T183032.log`).
- 2026-11-18 18:31 PST: the flat-layer screen first called `tetQuality` per cell (interposer-thermal-3d order 1: 61 -> 251 ms); replaced by an allocation-free `tetMinDihedralDeg` (quality.ts, same formulas; test: per-cell minimum equals the quality summary bitwise): 55 ms.
- 2026-11-18 18:31 PST: final regression `logs/G8-regress-after-20261118T183148.json` vs `logs/G8-regress-before-20261118T181624.json`: 70 / 70 identical (hash, tagHash, nodes, cells, facets at order 1 and 2; refined level of die-warpage-3d, interposer-thermal-3d, tsv-stress-3d); only the interposer-thermal-3d warning text changed (s.4). geom 58 / 58, mesh 30 / 30 (`logs/G8-*-test-20261118T183148.log`); mesh and physics `tsc` clean after the last edit.

## 4. Results

### 4.1 Consumption rule (D1)
- `buildGeometry2D`: a feature may feed any number of booleans; each reference takes that feature's own shape; referencing consumes (keepTools tools stay or return). New error: "<feature>: input 'x' is listed twice (a boolean takes each input once)". "was already consumed" no longer exists; "is not defined before this feature" unchanged (also for self and forward references).
- Layer sketches inherit the rule (a sketch is built as a 2D geometry).

### 4.2 Stack point entities (D2, D4)
- Names `pnt:<P>.<layer>.bottom|top` for every named 2D point of each layer sketch; shared plane locations owned by the lower layer (`parent` = upper `.bottom` name + plain `pnt:<P>`); ancestors: `pnt:<P>.<layer>`, 2D ancestors, per-plane / per-layer forms of 2D aliases. `Mesh.pointNode` set for tet4 / tet10, kept by `refineUniform` / `toP2`. Counts on the current stack sims: die-warpage-3d 21, interposer-thermal-3d 56, tsv-stress-3d 10, bump-array-thermal 10 (new sim of another lane); every point has a node at order 1 and 2.
- 3D tag hash = domain + boundary ids (stack, refined, P2). No 3D mesh had point entities before, so no hash changed.
- Mixed boxes / z cylinders: no point entities (unchanged). No `edg:` entities.

### 4.3 Thin-layer guidance (D5, D6)
- Warning per flagged layer, e.g. interposer-thermal-3d (was one line "flat tetrahedra: min dihedral angle 1.20 deg ..."):
  "flat tetrahedra in layer 'active': min dihedral angle 1.20 deg (below 5 deg) in a cell 499 um wide and 10 um high; the cell is much wider than tall (a thin layer under coarse in-plane cells). Remedy: mesh.refine on this layer's sketch domains (dom:logic, dom:mem_l, dom:mem_r) with h comparable to the z cell height, or a smaller mesh.size.hmax; the 2D mesh is shared by all layers, so thick layers over the refined area need more z cells (nz or dz) to stay well shaped" (and the same for layer 'bumps', 4.75 deg, 40 um).
- Taller-than-wide cells: "... the cell is much taller than wide (in-plane cells refined below this layer's z cell height, possibly for another layer: the 2D mesh is shared by all layers). Remedy: more z cells in this layer (nz or dz), or less in-plane refinement over it". Thin 2D triangle (min angle below 5 deg): "... its 2D triangle is thin ...".
- `maxLayerAspect` (opt-in, off by default): trade-off measured in s.3 18:23; a sim opting in should also set nz / dz of the thick layers.

## 5. Open items
- O1: `edg:` entities for stacks (vertical corner edges `edg:<P>.<layer>`, cap edges): needs an edge entity -> node list on the Mesh and a consumer; not done.
- O2: mixed boxes / z cylinders have no `pnt:` (box corner names, e.g. `pnt:<box>.c0..c7`, are not defined in C2).
- O3: in a swept stack the in-plane mesh is shared by every layer; thin and thick layers over one area cannot both be well shaped without many z cells (s.3 18:23 table). A remedy beyond the opt-in would need z-graded or per-region z planes (not a swept mesh).
- O4 (pre-existing, unchanged): a layer sketch that lists a feature consumed by another listed feature of the same sketch (e.g. `[si, tsv]` with `si` a difference without keepTools) silently drops it; a validation message is a candidate.
- O5 (pre-existing, unchanged): a 2D point whose coincident sources share one id gets that id twice in `parent` (harmless for selection).
- O6: physics test 'stationary settings.solver: invalid values ...' fails while the solver lane adds elastic to the solver setting (not this lane's code).

## 6. Requests (coordinator)
- R1 CONTRACTS-v0 changelog (C2), text: "2026-11-18 (DevLog-065): geometry consumption rule: a feature referenced by a boolean leaves the final geometry (difference tools with keepTools stay, or return when consumed earlier); it may be referenced again by later booleans, each reference using that feature's own shape; an input listed twice in one boolean is an error. Specs where every feature feeds at most one boolean are unchanged. Layer stacks name points `pnt:<2D point>.<layer>.bottom|top` for every named 2D point of each layer sketch (rect corners, polygon / polyline vertices, arc ends, boolean intersection points); at a plane shared by two layers the lower layer's `.top` name owns the point and the upper `.bottom` name selects it too; `pnt:<2D point>` selects that corner at every plane and `pnt:<2D point>.<layer>` both planes of a layer; `Mesh.pointNode` maps them to nodes (tet4 / tet10), so point constraints work on stacks. Mixed boxes / z cylinders and `edg:` stay without such entities. 3D tag hashes cover domain and boundary ids. Flat-tet warnings name the layer, the worst cell's width and height and the remedy. Mesh option `size.maxLayerAspect` (stacks, dimensionless, off when absent): layers whose z cell height dz gives maxLayerAspect * dz < hmax are refined in plane to h = maxLayerAspect * dz (the 2D mesh is shared, so thick layers over that area need more z cells). @amp/mesh exports nothing new from its index; `tetMinDihedralDeg` lives in quality.ts."
- R2 `packages/spec/src/schema.ts` `meshSchema.size` (only if `maxLayerAspect` is to be usable from specs): replace the `size:` line with
  `size: z.strictObject({ hmax: quantity('m', POS), hmin: quantity('m', POS).optional(), grading: quantity('1', POS).optional().meta({ description: 'Maximum size growth per unit distance, |dh/dx| (dimensionless; L3 mapping, contract changelog 2026-11-06)' }), maxLayerAspect: quantity('1', POS).optional().meta({ description: 'Layer stacks: in-plane cell size at most this times a layer z cell height (thin layers refined in plane; off when absent; the 2D mesh is shared by all layers)' }) }),`
- R3 `sims/die-warpage-3d.yaml` (PK-06; geometry / BC / provenance lines only; the material block stays with the materials lane): replace the patch by a corner pin.
  - header lines 7-8 -> `# Rigid-body z motion: the bottom centre corner (x = y = z = 0) is held fixed (u_x, u_y are zero there by symmetry);`, `# curvature is taken from u_z at two bottom points.`; line 9: drop `d, ` from the list of modelling inputs.
  - delete `params.d` (line 20) and `provenance.values.params.d` (line 91).
  - geometry features: delete `patch` and `rest`; both layers `sketch: [quarter]`.
  - bcs: `- {id: sym_x, type: roller, select: ["bnd:quarter.left"]}`, `- {id: sym_y, type: roller, select: ["bnd:quarter.bottom"]}`, `- {id: centre_z, type: fixed, select: ["pnt:quarter.p0.sub.bottom"]}`.
  - provenance `params.x1` note -> `"modelling choice: far from the free edges"`; `uz_corner` label -> `"u_z at the bottom corner (bow relative to the pinned centre)"`; assumption line 102 -> `{text: "The bottom centre corner is held fixed (a point pin; u_x, u_y vanish there by symmetry), which removes the rigid z motion only", paths: [physics.solid.bcs.centre_z]}`.
  - Measured (s.3 18:26): curvature -2.060427 1/m (7.6e-5 from the case reference; was 1.3e-4); mesh 960 cells (was 1068). The class-c builder entry for PK-06 needs no change unless it copies the patch parameter (not checked; `validation/c/cases_ext/pkg.py` is another lane's file).
- R4 `sims/tsv-stress-3d.yaml` (optional, no numerical change: same mesh hash at order 1 and 2): delete features `hole` and `quad2`; `ring` tools `[tsv]`; `si` inputs `[ring, quad]`; rollers `select: ["bnd:quad.left"]` and `["bnd:quad.bottom"]`. tagHash changes (entity ids), mesh hash does not.
- R5 (physics test, optional): add the free-expansion point-pin check of s.3 18:26 (1) as `packages/physics/test/stack-points.test.ts` (spec text in `<scratch>/g8/pin.ts`, part (1); gate max |u - alpha dT x| <= 1e-12 max |u|).

## 7. Hand-off
- Changed: `packages/geom/src/{model,stack,index}.ts`, `packages/mesh/src/{stack,spec,refine,quality}.ts`; new tests `packages/geom/test/reuse.test.ts`, `packages/mesh/test/stack-points.test.ts`. No other tracked file.
- Regression: 70 / 70 sims identical (dumps in `logs/G8-regress-*`). Scratch scripts: `<scratch>/g8/{regress,compare,pts,aspect,pin,tsvvar}.ts`.
- Next: R1-R5 by the coordinator; O1-O4 for a later chunk.
