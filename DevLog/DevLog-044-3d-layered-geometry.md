# DevLog-044: 3D layered geometry through the spec (lane S3, chunk 1, B3)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | S3 (DevLog-037 s.3, B3) |
| Owns | `packages/geom/**`, `packages/mesh/**`, `packages/physics/src/prepare.ts`, `packages/physics/src/common/lagrange.ts`, new `packages/physics/test/geom3d*.test.ts`, this file |
| Read | CLAUDE.md, DevLog-037, DevLog-004, DevLog-034 s.3 (N1), DevLog-036, CONTRACTS-v0 C2 + changelog; `packages/geom/src/{model,extrude,spec}.ts`, `packages/mesh/src/{spec,solid3d,layered.mjs,refine,mesh2d}.ts`, `packages/physics/src/{prepare,driver}.ts`, `common/{lagrange,mesh}.ts` |
| Status | done (gates s.3); requests s.6 |

Conventions: F = fact read from code or a run; D = decision (reason given); O = open item; R = request to another lane / coordinator.

## 1. Plan (2026-11-18 08:56 PST)

### 1.1 Facts
- F: `geometryFromSpec` (dim 3) accepts only `box` and `cylinder`; `meshFromSpec` meshes a box list (hex8 grid) or one cylinder (extruded tet4); anything else throws "3D CSG is tier 2" (`packages/mesh/src/spec.ts`).
- F: `extrudeLayered` (geom) + `meshExtruded` (mesh) exist: one 2D geometry, layers activate a subset of its 2D domains, ids `<d>.L<k>`; used only by `meshCylinder`. Prism split = minimum-global-index rule (`layered.mjs`, port of APA em3d; Dompierre, Labbe, Vallet, Camarero 1999, "How to subdivide pyramids, prisms and hexahedra into tetrahedra", Proc. 8th International Meshing Roundtable).
- F: 2D features (`rect`, `circle`, ...) are registered with dims `2d`, `2d-axisym`; a 3D spec cannot name them.
- F: `mesh2d(order 2)` puts tri6 mid nodes on the exact curves; vertices are the same as order 1.
- F: `prepareRun` nested levels (hFactor = 2^-k) exist for 2D, one cylinder, one tet10 box; others re-mesh.
- F: physics on tets: heat, elastic, electrostatics, currents, acoustics take tet4 / tet10 generically (`assembleCells`, `shapeTable`); em3d takes tet4 / tet10. `lagrange.ts` has no prism6 (not needed when tets cover all physics).

### 1.2 Spec shape (D)
2D features become sketch features in a 3D geometry (their dims gain `3d`). One `extrude` feature stacks z-layers; each layer names its own sketch (a list of earlier 2D features, built like a 2D geometry from those features and their inputs):

```yaml
geometry:
  dim: 3
  features:
    - {id: cell, type: rect, settings: {size: ["p", "p"], center: [0, 0]}}
    - {id: via, type: circle, settings: {center: [0, 0], radius: "a"}}
    - {id: si, type: difference, settings: {base: cell, tools: [via], keepTools: true}}
    - id: stack
      type: extrude
      settings:
        z0: 0 um                     # optional, default 0
        layers:
          - {id: sub, thickness: 100 um, sketch: [si, via], nz: 6}
          - {id: ox, thickness: 2 um, sketch: [cell]}
```
- Layer: `id` (node id; `top` and `bottom` reserved; default `L<k>`), `thickness`, optional `z0` (must be >= the running top; a gap is empty space), `sketch` (earlier 2D features; empty list = empty layer), optional `nz` (cells along z) or `dz` (cell size along z; default `mesh.size.hmax`).
- A layer's sketch is built exactly like a 2D geometry from the listed features and their transitive inputs (booleans consume their inputs; overlaps without a boolean are an error, as in 2D). Different layers may reuse the same 2D features.
- At most one `extrude` per geometry; `box` / `cylinder` cannot be combined with it.
- `mesh.refine` in an extrude spec selects 2D sketch entities (`dom:via`, `bnd:via.edge`): the shared 2D mesh is refined there in every layer.

### 1.3 Entity names (D, follows C2 and DevLog-036 G1 / G2)
Notation: `D` a 2D domain id of layer l's sketch, `B` a 2D boundary id, `S` the extrude feature id; a split suffix `#k` of `D` / `B` moves to the end of the 3D id (`D = si#2` -> `dom:si.sub#2`), as the grammar requires.
- Domain per (layer, sketch domain): `dom:<D>.<l>`; parent `dom:<D>`, `dom:<S>.<l>` (whole layer). `dom:via` selects the via in every layer.
- Side wall per (layer, sketch boundary separating two different domains or a domain and empty space): `bnd:<B>.<l>`; parent `bnd:<B>` (`bnd:via.edge` = every via wall).
- Caps on a layer plane: pieces of `bnd:<D>.<l>.top` (lower domain) and `bnd:<D'>.<l'>.bottom` (upper domain). The lower domain owns an interface (as the box grid's minus-side rule): id = the lower top piece, parent = the upper bottom piece; exterior caps carry their own name. A top or bottom face with several pieces is numbered over all pieces, exterior first, then partner domain order: `#1`, `#2`, ... (G2 rule); one piece keeps the plain id. Exterior caps on the first / last plane also list `bnd:<S>.bottom` / `bnd:<S>.top`.
- Layer ids are human-readable and persistent under layer insertion (index names `.L<k>` renumber); the default layer id is `L<k>`, so unnamed layers keep the C2 grammar of DevLog-004.
- Overlay (internal): all layer sketches are fragmented into one 2D arrangement (`combine('fragment')` of one object per layer), meshed once, so every layer interface is conforming by construction. Overlay entities carry the sketch ids in `ancestors` (used by `mesh.refine`).

### 1.4 Mixed primitives (D)
- A 3D geometry of boxes and z-axis cylinders that is not a box list or one cylinder (the cases that threw "3D CSG is tier 2") is converted to a stack: z breakpoints from every solid, one layer per interval, sketch = the footprints (rect, circle) of the solids spanning it. Primitive names stay valid through parents: `dom:<id>`, box `bnd:<id>.xmin|xmax|ymin|ymax` (rect left|right|bottom|top), cylinder `bnd:<id>.side` (circle edge), `bnd:<id>.zmin|zmax` / `.bottom|.top` on the solid's end caps.
- Overlapping solids (e.g. a cylinder inside a box) need a boolean: error naming the solids and the z range, pointing to `extrude` with a 2D difference. x / y cylinders mixed with other solids: error (true 3D CSG stays tier 2). Box lists and one cylinder keep their current meshers (hashes unchanged).

### 1.5 Mesh and elements (D)
- 2D: `mesh2d` on the overlay (hmax, hmin, grading, refine, budget from the spec). z: per layer `subdivideInterval(z0, z1, dz)`.
- tet4: each prism split into 3 tets by the minimum-global-index rule (Dompierre et al. 1999), quad side facets cut by the same rule, so prisms and facets conform across layers and domains.
- tet10: lift of the 2D tri6: the mid node of a 3D edge between (v, p) and (w, q) is (2D mid node of edge vw, (z_p + z_q) / 2), or (x_v, (z_p + z_q) / 2) when v = w. The prism map is quadratic in (x, y) and linear in z, i.e. degree 2 in each tet's barycentric coordinates, so this is the exact P2 interpolant of the curved prism; side walls on circles / ellipses get mid nodes on the exact curve.
- Facets: tri3 / tri6 caps and side triangles (boundary and internal interfaces), outward normal on exterior facets, +z on interface caps, side interfaces out of the lower-index domain.
- Nested levels in `prepareRun`: `refineUniform` with a projector that puts new side-wall nodes on the exact 2D curve (z kept).
- No prism6 shape functions (tets cover every 3D physics); `lagrange.ts` unchanged unless a gate needs it.

### 1.6 Gates
- (a) Box as an `extrude` (rect sketch, 1 layer) vs the existing box paths (Kuhn tet10 box and hex8 grid): heat and elastic polynomial solutions exact on both (round-off), and a non-polynomial heat case (uniform source, T = 0 walls) + elastic bending case: difference stated next to each path's change between two mesh levels.
- (b) Three-layer slab, heat flux q on the bottom, T fixed on top, insulated sides: T_bottom - T_top = q sum(t_i / k_i) and interface temperatures, exact for P1 / P2 (piecewise linear T, conforming interfaces).
- (c) TSV: (c1) Cu cylinder through a Si cylinder cell, isothermal top / bottom, insulated side: G = (k_Cu A_Cu + k_Si A_Si) / t exactly (T linear in z); (c2) blind via (Cu in the lower layer, Si cap layer above): G between the adiabatic-column lower bound and the isothermal-plane upper bound (Dirichlet / Thomson variational principles, derivation in s.3), and equal to a 2D-axisymmetric heat run of the same r-z section within discretization error (two levels).
- (d) Mesh determinism: same `hash` and `tagHash` twice in one Node process and across two processes.
- Regression: geom, mesh, physics tests; `pnpm -r check`; the five 3D sims bitwise (scalars, field sha-256, mesh hash) vs `logs/S3-regress-before-20261118T085201.json`; mesh hash + tagHash of every sim at order 1 and 2 unchanged.
- Record DOF, mesh time and solve time per gate run.

### 1.7 TODO
- [x] Baseline regression dump (`logs/S3-regress-before-20261118T085201.json`)
- [x] geom: combine origin info, `buildStack` (overlay + 3D entity table), spec `extrude` registration, 2D feature dims, mixed primitives
- [x] mesh: `meshStack` (tet4 / tet10 lift), projector, `meshFromSpec` routing, better tier-2 error
- [x] physics: prepareRun base mesh + nested levels for stacks
- [x] tests: geom (names), mesh (conformity, volume, determinism), physics gates (a)-(e)
- [x] example YAMLs (s.4)
- [x] regression + checks; hand-off

## 2. Progress
- 2026-11-18 08:47 PST: read the brief, DevLog-037, -004, -034 s.3, -036, C2.
- 2026-11-18 08:52 PST: baseline regression dump (scratch script, mesh hash + tagHash of all 48 sims at order 1 / 2, and the five 3D sims solved: every study, scalars as exact strings, field sha-256): `logs/S3-regress-before-20261118T085201.json`. 3D solve times: box-acoustics 0.2 s, cylinder-cavity-qd 0.1 s, cylinder-cavity 8.9 s, hot-arm-actuator 7.6 s, pzt4-cube 14.0 s per study.
- 2026-11-18 08:56 PST: plan written (s.1).
- 2026-11-18 08:58-09:05 PST: geom: `combine` returns origin info (`domOrigins`, `edgeSrc`; additive), `toGeometry` exported; `stack.ts` (`buildStack`, `stackFromSolids`, `id3`, `capKey`); spec: `extrude` registration with a sketch check, 2D feature dims gain `3d`, `geometryFromSpec` routes extrude / mixed solids to a stack, `isStack3D`. Mixed-primitive box sides renamed to the 3D face names (the 2D rect names `top` / `bottom` would read as box faces).
- 2026-11-18 09:05 PST: mesh: `stack.ts` (`meshStack`, `stackProjector`), `meshFromSpec` routing and the new tier-2 message. Conformity check (scratch): 0 faces in > 2 tets, every exterior / interface face has exactly one facet, tet4 and tet10.
- 2026-11-18 09:07 PST: F (O1 below): a keepTools difference with a curved tool leaves the tool edge as its 1-degree arrangement pieces (`buildGeometry2D` gives 364 geometry edges for rect + circle keepTools vs 6 without keepTools); `mesh2d` then puts a PSLG vertex every degree, and with r below about 1.1 hmax the hmin floor blocks refinement: min angle 0.5 deg (r = hmax = 10 um). Pre-existing, 2D too. Not changed in `buildGeometry2D` (it would change the meshes of coplanar-rings, phc-*, nafems-t1-hotspot; all five have min angle >= 21.7 deg today). Stacks merge the pieces (`mergeEdgePieces`, sketches and overlay): TSV stack min dihedral 0.16 deg -> 2.8 deg (the rest is the 5 um layer under 10 um triangles).
- 2026-11-18 09:08 PST: prepareRun: stacks mesh through `meshFromSpec(order)`, nested levels by `refineUniform` + wall projector; `levelMesh` treats stacks as simplex chains.
- 2026-11-18 09:10-09:16 PST: physics gates (first runs; c1 / c2 levels and a4 h reduced after a 126k-DOF elastic level took 36.5 s and a 578k-DOF c2 level 82 s); `curvedQuality` (125 points per tet) took 1.4 of 1.43 s of a 19.5k-tet tet10 stack mesh: stacks use `stackQuality` (straight-cell metrics + P2 Jacobian at corners, mids, centroid), and `refineUniform` gained an optional `quality` hook (default unchanged). Coincident circles of two layers produced 1-degree overlay pieces too (c2: 52k tets at hmax 5 um): the overlay is merged as well (8k tets).
- 2026-11-18 09:17 PST: regression `logs/S3-regress-after-20261118T091729.json` vs before: 48 / 48 sims identical (mesh hash + tagHash at order 1 and 2; box-acoustics, cylinder-cavity, cylinder-cavity-qd, hot-arm-actuator, pzt4-cube: every study's scalars as exact strings, field sha-256 and the prepared mesh hash).
- 2026-11-18 09:18-09:20 PST: tests: geom 43 / 43 (`logs/S3-geom-test-20261118T091819.log`), mesh 19 / 19 (`logs/S3-mesh-test-20261118T091819.log`), physics 153 / 153 (91 s; before (e1), (e2) were added; log superseded by the 09:25 run).
- 2026-11-18 09:22 PST: `pnpm -r check` exit 0, 11 projects, svelte-check 0 errors (`logs/S3-check-20261118T092233.log`).
- 2026-11-18 09:20-09:23 PST: examples (s.4) validated by a scratch script (prepareRun with T = 298.15 K + runStudy): `logs/S3-examples-20261118T092253.log`. Gates (a)-(e) consolidated: `logs/S3-geom3d-test-20261118T092319.log` (10 / 10).
- 2026-11-18 09:25-09:27 PST: final physics suite after the (a2) series change (320 terms) and gates (e1), (e2): 156 / 156 (`logs/S3-physics-test-20261118T092528.log`). No source change after the 09:17 regression dump (later edits: tests, examples, this file).

## 3. Gates (Node v23.7.0, M4 Pro, `nice -n 10`, heap cap 1.5 GB; log `logs/S3-geom3d-test-20261118T092319.log`)

Test file `packages/physics/test/geom3d.test.ts`; every value below is printed there as a `GEOM3D {...}` line. Coefficients are test numbers, not material data. All 3D runs are P2 (tet10) unless stated.

| Gate | Case | Result | DOF | Mesh ms | Solve ms |
|---|---|---|---|---|---|
| (a1) | box 1 x 0.6 x 0.4 mm, T 400 / 300 K on x ends, linear | max nodal error: box path 8.9e-12 K, extrude 7.2e-12 K | 2223 / 5535 | 7 / 50 | 95 / 160 |
| (a2) | uniform source 1e10 W/m^3, k 10, T = 300 K walls; T_max vs triple sine series 15.79947 K rise | error / rise: box 5.2e-4 -> 3.3e-5, extrude 3.2e-4 -> 1.3e-5 (hFactor 1 -> 1/2); box - extrude 3.2e-3 K -> 3.1e-4 K | 1463 -> 13455 / 3801 -> 34275 | 12 / 215 (level 1) | 964 / 2338 (level 1) |
| (a3) | uniaxial 50 MPa, rollers, linear u | max error / u_ref: box 2.7e-14, extrude 2.8e-14 | 988 / 2394 | 1 / 12 | 84 / 198 |
| (a4) | cantilever, clamp x = 0, 10 MPa shear traction at x = L | u_max box 2.7864e-6 -> 2.8208e-6 m, extrude 2.8025e-6 -> 2.8267e-6 m; difference 5.8e-3 -> 2.1e-3 rel, below the box path's own level change 1.2e-2 | 1050 -> 7020 / 2550 -> 17388 | 4 / 45 | 893 / 1383 |
| (b) | 3 layers 0.2 / 0.05 / 0.3 mm, k 150 / 1.4 / 400, q 1e4 W/m^2 in, T 300 K top | T_bottom 300.3779761904646 vs 300.3779761904762 K; max nodal error / dT: tet10 3.8e-11, tet4 1.2e-11 | 1910 | 23 | 40 |
| (c1) | via a = 5 um in cell b = 20 um, t = 50 um, k 400 / 10, isothermal ends | T linear in z to 2.6e-11 K; G = 8.639364e-4 vs (k_v A_v + k_m A_m) / t = 8.639380e-4 W/K (-1.8e-6: P2 area of the circles) | 26375 | 164 | 1337 |
| (c2) | via in the lower 50 um, 10 um cap layer of matrix | G 3D 4.29296e-4 -> 4.28127e-4; axisym 4.27553e-4 -> 4.27483e-4 W/K; 3D - axisym 4.3e-3 -> 1.5e-3 rel; bounds [2.66163e-4, 5.11963e-4] | 10465 -> 84915 (3D), 12292 -> 48909 (axisym) | 104 / 485 | 391 / 14580 |
| (d) | TSV + cap stack, hmax 4 um, tet4 24288 cells / tet10 | same hash and tagHash twice in one process and in a second Node process (`f02828b60a1f7a42`, `871d25ccd36ef2dd`) | - | 44 / 171 | - |
| (e1) | acoustics, rigid room 1 x 0.8 x 0.6 m as extrude | f1-f4 rel error 1.7e-5, 4.2e-5, 1.1e-4, 6.8e-4 vs (c/2) sqrt(sum (n/L)^2) | 1617 | - | 69 |
| (e2) | emw, PEC disk a = 2.74 cm, d = 2a, eps_r 2.08 as extrude | TM010 2.9036313 GHz vs x01 c0 / (2 pi a sqrt(eps_r)) = 2.9036361 GHz (-1.6e-6) | 36244 | - | 2369 |

Notes:
- (a2) the series is truncated at odd indices < 640 per direction (change 160 -> 320 terms: 2.6e-6 K, about 1/80 of the finest path error). Both paths converge to it; their difference falls 10x per level. The extrude mesh is a CDT (unstructured in x, y), so it is not the Kuhn mesh: equality is to discretization error, not bitwise.
- (a4) no closed form for a short 3D cantilever: the gate is that the two paths differ by less than one path's own change between levels.
- (c2) bound derivation (conductance between two isothermal faces, unit dT, insulated sides):
  - Upper (Dirichlet principle): G = min over T with T = 1 / 0 on the faces of the integral of k |grad T|^2. Restricting T to be constant on the interface plane z = t1 (a subset of the admissible fields) can only raise the minimum, and splits the problem into two layers with isothermal faces. In the via layer each material column carries the same linear T(z) (exact, as gate c1 shows), so G1 = (k_v A_v + k_m A_m) / t1; the cap layer G2 = k_m A / t2. G_up = 1 / (1 / G1 + 1 / G2).
  - Lower (Thomson principle, the dual): G = max over divergence-free fluxes q with q . n = 0 on the insulated sides of 2 Phi(q) - integral of |q|^2 / k, Phi = total flux through the face. Restricting q to have zero normal component on the cylinder r = a (an adiabatic wall through both layers) can only lower the maximum and splits the cell into two columns with 1D conduction: G_lo = A_v / (t1 / k_v + t2 / k_m) + k_m A_m / (t1 + t2).
  - The axisymmetric run solves the same r-z section (same continuous problem). 3D converges towards it from above (4.3e-3, 1.5e-3), the axisymmetric value changes by 1.6e-4 between its levels; the remaining difference is 3D discretization (re-entrant material corner at r = a, z = t1, and dz = 10 um in the via layer).
- Not gated here: currents and electrostatics on stacks (same tet4 / tet10 assembly paths as heat, which (a1)-(c2) exercise; hot-arm-actuator covers currents on tet10).

## 4. Example specs (for chunk 2 library sims; not in `sims/`)

Validated with prepareRun (T = 298.15 K for the library tables) + runStudy (`logs/S3-examples-20261118T092253.log`): tsv-unit-cell-3d tet10 8766 cells, 12312 DOF, mesh 97 ms, solve 0.4 s; die-on-interposer-3d 38946 cells, 52744 DOF, mesh 0.42 s, solve 2.6 s (with a validation-only underfill k: the library has none); waveguide-heater-3d 50154 cells, 68690 DOF, mesh 0.34 s, solve 4.9 s. Dimensions, powers and heat transfer coefficients are illustrative inputs, not sourced values.

```yaml
# Example (DevLog-044 s.4): one Cu TSV in a Si unit cell under a SiO2 layer, heat conduction. Dimensions and loads are
# illustrative inputs (not from a source); materials from the library (temperature tables: run with T, e.g. 298.15 K; the oxide k is stated at 25 C).
# Thermal stress needs Si elastic data: the library gives the cubic stiffness C only (E, nu are N/A by design).
schema: amp-spec/0
id: tsv-unit-cell-3d
title: TSV unit cell (3D layer stack)
params:
  p: {value: 40, unit: um, description: TSV pitch (cell side)}
  a: {value: 5, unit: um, description: TSV radius}
  t_si: {value: 50, unit: um, description: Si thickness}
  t_ox: {value: 2, unit: um, description: oxide thickness}
  q_in: {value: 1e6, unit: W/m^2, description: heat flux into the top (illustrative)}
  T_sink: {value: 300, unit: K, description: bottom temperature}
geometry:
  dim: 3
  features:
    - {id: cell, type: rect, settings: {size: ["p", "p"], center: {value: [0, 0], unit: um}}}
    - {id: tsv, type: circle, settings: {center: {value: [0, 0], unit: um}, radius: "a"}}
    - {id: si, type: difference, settings: {base: cell, tools: [tsv], keepTools: true}}
    - {id: ox, type: rect, settings: {size: ["p", "p"], center: {value: [0, 0], unit: um}}}
    - id: stack
      type: extrude
      settings:
        layers:
          - {id: sub, thickness: "t_si", sketch: [si, tsv], dz: 10 um}
          - {id: diel, thickness: "t_ox", sketch: [ox]}
materials:
  - {id: cu, ref: materials/copper, select: ["dom:tsv"]}
  - {id: silicon, ref: materials/silicon, select: ["dom:si"]}
  - {id: oxide, ref: materials/sio2-thermal-oxide, select: ["dom:ox"]}
physics:
  - id: ht
    type: heat
    select: ["dom:stack"]
    bcs:
      - {id: q, type: heat-flux, select: ["bnd:stack.top"], settings: {q: "q_in"}}
      - {id: sink, type: temperature, select: ["bnd:stack.bottom"], settings: {T: "T_sink"}}
studies:
  - {id: std, type: stationary, physics: [ht]}
mesh:
  size: {hmax: 5 um}
```

```yaml
# Example (DevLog-044 s.4): Si die on a 2 x 2 SAC305 bump array in underfill on a Si interposer; the die and the bump
# layer cover only the die footprint (empty space around them). Dimensions and power are illustrative inputs.
# Library tables: run with T (e.g. 298.15 K). materials/underfill-uf8830s has no k yet (N/A on its TDS).
schema: amp-spec/0
id: die-on-interposer-3d
title: Die on interposer (3D layer stack)
params:
  L_ip: {value: 2, unit: mm, description: interposer side}
  t_ip: {value: 100, unit: um, description: interposer thickness}
  L_die: {value: 1, unit: mm, description: die side}
  t_die: {value: 200, unit: um, description: die thickness}
  h_b: {value: 50, unit: um, description: bump layer height}
  r_b: {value: 40, unit: um, description: bump radius}
  P_die: {value: 1, unit: W, description: die power (illustrative)}
  h_top: {value: 1000, unit: W/(m^2*K), description: heat transfer coefficient on the die top (illustrative)}
  T_amb: {value: 300, unit: K}
geometry:
  dim: 3
  features:
    - {id: ip, type: rect, settings: {size: ["L_ip", "L_ip"], center: {value: [0, 0], unit: mm}}}
    - {id: b1, type: circle, settings: {center: {value: [-0.25, -0.25], unit: mm}, radius: "r_b"}}
    - {id: b2, type: circle, settings: {center: {value: [0.25, -0.25], unit: mm}, radius: "r_b"}}
    - {id: b3, type: circle, settings: {center: {value: [-0.25, 0.25], unit: mm}, radius: "r_b"}}
    - {id: b4, type: circle, settings: {center: {value: [0.25, 0.25], unit: mm}, radius: "r_b"}}
    - {id: uf_area, type: rect, settings: {size: ["L_die", "L_die"], center: {value: [0, 0], unit: mm}}}
    - {id: uf, type: difference, settings: {base: uf_area, tools: [b1, b2, b3, b4], keepTools: true}}
    - {id: die, type: rect, settings: {size: ["L_die", "L_die"], center: {value: [0, 0], unit: mm}}}
    - id: stack
      type: extrude
      settings:
        layers:
          - {id: interposer, thickness: "t_ip", sketch: [ip], nz: 2}
          - {id: bumps, thickness: "h_b", sketch: [uf, b1, b2, b3, b4], nz: 2}
          - {id: chip, thickness: "t_die", sketch: [die], nz: 2}
materials:
  - {id: si_ip, ref: materials/silicon, select: ["dom:ip"]}
  - {id: solder, ref: materials/sac305, select: ["dom:b1", "dom:b2", "dom:b3", "dom:b4"]}
  - {id: underfill, ref: materials/underfill-uf8830s, select: ["dom:uf"]}
  - {id: si_die, ref: materials/silicon, select: ["dom:die"]}
physics:
  - id: ht
    type: heat
    select: ["dom:stack"]
    bcs:
      - {id: power, type: heat-source, select: ["dom:die.chip"], settings: {Q: "P_die/(L_die^2*t_die)"}}
      - {id: cool, type: convection, select: ["bnd:stack.top"], settings: {h: "h_top", T_ext: "T_amb"}}
      - {id: board, type: temperature, select: ["bnd:stack.bottom"], settings: {T: "T_amb"}}
studies:
  - {id: std, type: stationary, physics: [ht]}
mesh:
  size: {hmax: 0.2 mm}
  refine:
    - {select: ["bnd:b1.edge", "bnd:b2.edge", "bnd:b3.edge", "bnd:b4.edge"], h: 25 um}
```

```yaml
# Example (DevLog-044 s.4): Si strip waveguide in SiO2 on a Si substrate with a W heater strip on top (a thermo-optic
# phase shifter section of length L). Heater power as a volume source; dimensions and power are illustrative inputs.
# Library tables: run with T (e.g. 298.15 K; the oxide k is stated at 25 C). TiN (materials/tin-film) has no k yet.
schema: amp-spec/0
id: waveguide-heater-3d
title: Waveguide under a heater (3D layer stack)
params:
  W: {value: 20, unit: um, description: model width (x)}
  L: {value: 20, unit: um, description: section length (y)}
  w_wg: {value: 0.5, unit: um, description: waveguide width}
  t_wg: {value: 0.22, unit: um, description: waveguide thickness}
  w_h: {value: 2, unit: um, description: heater width}
  t_h: {value: 0.12, unit: um, description: heater thickness}
  P_h: {value: 10, unit: mW, description: heater power (illustrative)}
  T_sub: {value: 300, unit: K}
geometry:
  dim: 3
  features:
    - {id: chip, type: rect, settings: {size: ["W", "L"], center: {value: [0, 0], unit: um}}}
    - {id: wg, type: rect, settings: {size: ["w_wg", "L"], center: {value: [0, 0], unit: um}}}
    - {id: core_ox, type: difference, settings: {base: chip, tools: [wg], keepTools: true}}
    - {id: htr, type: rect, settings: {size: ["w_h", "L"], center: {value: [0, 0], unit: um}}}
    - id: stack
      type: extrude
      settings:
        layers:
          - {id: substrate, thickness: 10 um, sketch: [chip], nz: 3}
          - {id: box, thickness: 2 um, sketch: [chip], nz: 2}
          - {id: core, thickness: "t_wg", sketch: [core_ox, wg]}
          - {id: clad, thickness: 1 um, sketch: [chip], nz: 2}
          - {id: heater, thickness: "t_h", sketch: [htr]}
materials:
  - {id: si_sub, ref: materials/silicon, select: ["dom:chip.substrate"]}
  - {id: oxide, ref: materials/sio2-thermal-oxide, select: ["dom:chip.box", "dom:core_ox", "dom:chip.clad"]}
  - {id: si_wg, ref: materials/silicon, select: ["dom:wg"]}
  - {id: heater_metal, ref: materials/tungsten, select: ["dom:htr"]}
physics:
  - id: ht
    type: heat
    select: ["dom:stack"]
    bcs:
      - {id: power, type: heat-source, select: ["dom:htr"], settings: {Q: "P_h/(w_h*L*t_h)"}}
      - {id: sink, type: temperature, select: ["bnd:stack.bottom"], settings: {T: "T_sub"}}
studies:
  - {id: std, type: stationary, physics: [ht]}
mesh:
  size: {hmax: 2 um}
  refine:
    - {select: ["dom:wg", "dom:htr"], h: 0.5 um}
```

## 5. Open items
- O1 (geom, 2D): keepTools differences with curved tools keep the 1-degree arrangement pieces as geometry edges (s.2, 09:07). Fix candidate: `mergeEdgePieces` in `buildGeometry2D`; changes the meshes of coplanar-rings, phc-point-defect, phc-square-rods-lower / -upper, nafems-t1-hotspot (decision for the coordinator; eval values of those sims would need a rerun).
- O2: non-nested hFactor (not a power of 1/2) scales hmax only; layer `nz` / `dz` stay (nested levels refine z too).
- O3: thin layers under coarse triangles give flat tets (min dihedral 2.2-2.8 deg in the examples); P2 handles them, but `mesh.refine` on the thin-layer sketch entities, or a smaller hmax, is the remedy. No anisotropic quality warning yet.
- O4: no prism6 shape functions (tets serve every 3D physics); `lagrange.ts` unchanged.
- O5: true 3D CSG (overlapping solids, x / y cylinders with other solids, non-prismatic shapes) stays tier 2; the error now says what to do.
- O6: mixed boxes / z cylinders through a stack: `pnt:` / `edg:` entities are not produced for stacks (none for any 3D path today).
- O7: `stackQuality` volume is the straight-cell volume (tet10 curved volume needs `curvedQuality`, about 50x slower).

## 6. Requests
- R-coord-1 (CONTRACTS-v0 changelog, C2 / C3): feature `extrude` (layers: id, thickness, z0, sketch, nz | dz); 2D features valid in dim 3 as sketches; stack names (s.1.3: `dom:<D>.<layer>`, walls `bnd:<B>.<layer>`, caps `.top` / `.bottom` with the lower-owner and G2 numbering rules, `dom:<stack>`, `dom:<stack>.<layer>`, `bnd:<stack>.top|bottom`; split suffix moves to the end); layer ids as sub-entities (default `L<k>`, `top` / `bottom` reserved); mixed boxes / z cylinders mesh as stacks with box `xmin..zmax` and cylinder `side|bottom|top` names kept.
- R-web-1 (apps/web, T1 / chunk 2 UI): `apps/web/src/lib/engine/spec-adapter.ts` `buildMesh` (3D preview) accepts one box or one cylinder only; route dim 3 through `@amp/mesh/spec` `meshFromSpec(spec, {order: 1})` (as the runner worker already does) so extrude and mixed-solid specs preview. The meshes are tet4 / tri3 (preview) and tet10 / tri6 (solve), the same types as the cylinder path; facets include internal interfaces (cap and wall interfaces between layers / domains), so a surface view should draw exterior facets (one adjacent tet) or offer per-entity visibility; empty regions (gap layers, area outside a die) have no cells.
- R-T4-1 (materials): k for `underfill-uf8830s` and `tin-film` (both N/A), so the die-on-interposer and TiN-heater examples run from the library; an isotropic E / nu choice for Si (or elastic with the cubic C) for TSV thermal stress.
- R-chunk2-1 (E3 packaging examples): s.4 YAMLs are the starting points (TSV unit cell with thermal stress once R-T4-1 lands; die-on-interposer with more bumps via `mesh.refine` on the bump edges; waveguide-under-heater coupled to a 2D em-modes cut through the thermo-optic coupling).

## 7. Audit fixes (2026-11-18)

Lane F3 (fix lane). Owns `packages/geom/**`, `packages/mesh/**`, `packages/physics/test/geom3d*.test.ts`, this section. Findings from the fresh-context audit, verified before fixing.

### 7.1 Findings (verified 2026-11-18 09:52 PST, scratch probe)
- A1 (MAJOR, verified): `stackFromSolids` side rename (stack.ts, old l.343-346) set `parent` / `ancestors` to the owning box face only. 2D sketch of boxes A x[0,1], B x[1,2] (full contact): the shared piece is `bnd:A.right` with parent `[bnd:A.right, bnd:B.left]` (2D rule, C2 G1); after the rename it is `bnd:A.xmax.z0` with parent `[bnd:A.xmax]` only, so `bnd:B.xmin` matches nothing. Partial contact (B y[0.5,2]): `bnd:A.xmax.z0#2` (shared) lost `bnd:B.xmin`, so `bnd:B.xmin` selected the exposed piece only. Same gap in the extrude path at the per-layer level: `bnd:B.left` selects a shared wall (2D ancestors are kept), `bnd:B.left.<layer>` does not.
- A2 (MINOR, verified): `stackFromSolids(solids, id = 'solids')`: a primitive named `solids` gives `dom:solids.z0` both as its own domain id and as the layer aggregate parent of every domain; `bnd:solids.top` likewise ambiguous.

### 7.2 Plan
- A1: side walls in `buildStack`: add the per-layer name of every other 2D boundary name in the sketch boundary's parent / ancestors (`bnd:<B'>.<layer>`) to `ancestors`. `stackFromSolids`: map every 2D name of the sketch boundary (own id, parent, ancestors) to the 3D face name; own -> id as before; a neighbour's name -> `parent` (plain 3D face name, as in 2D) and `ancestors` (plain, unsplit base, per-layer name). No 2D rect / circle names leak. Ids unchanged, so `tagHash` (ids only) and mesh hashes unchanged.
- A2: reserve the stack id: `stackFromSolids` throws a clear error when a solid is named like the stack id; spec check on `box` / `cylinder` reports it at validation when the geometry is a mixed stack (`isStack3D`).
- Tests (geom `stack.test.ts`, mesh `stack.test.ts`): fully shared box faces, partly shared (in y and in z), z cylinder on a box (cap) and beside a box, extrude per-layer alias, facet area of a BC on the neighbour name = full face area; reserved id (geom error + spec issue).
- Regression: S3 scratch script (48 sims, mesh hash + tagHash at order 1 / 2; five 3D sims solved) vs `logs/S3-regress-before-20261118T085201.json`; geom, mesh, physics tests; `pnpm -r check`.

### 7.3 Progress
- 2026-11-18 09:53 PST: plan written.
- 2026-11-18 09:54 PST: A1 fixed in `packages/geom/src/stack.ts`. `buildStack` side walls: `ancestors` gain the per-layer name of every other 2D boundary name in the sketch boundary's parent / ancestors (`bnd:B.left.m` selects the wall `bnd:A.right.m#2` shared with B). `stackFromSolids`: every 2D name of a side wall (own, parent, ancestors) maps to the 3D face name; the owner gives the id (unchanged), a neighbouring solid's face goes into `parent` (plain, as in 2D) and `ancestors` (plain, unsplit base, per-layer). Probe after the fix: full contact `bnd:A.xmax.z0` parent `[bnd:A.xmax, bnd:B.xmin]`; partial contact `bnd:B.xmin` -> `[bnd:A.xmax.z0#2, bnd:B.xmin.z0]`. No 2D rect / circle names leak (test). Entity ids unchanged.
- 2026-11-18 09:54 PST: A2 fixed: `MIXED_STACK_ID = 'solids'` (exported); `stackFromSolids` throws "solid id 'solids' is reserved in a geometry of mixed boxes / cylinders: it names the whole stack (...); rename the solid"; `box` / `cylinder` registrations gain a spec check (issue at path `id`) when the geometry is a mixed stack (`isStack3D`); a box list may still use the id (no stack aggregates there).
- 2026-11-18 09:55 PST: tests added. geom `stack.test.ts` (+5): fully shared box face (both names, plain and per layer; parent), partly shared in y and in z, z cylinder on a box (cap interface selected by `bnd:C.bottom` and `bnd:A.zmax`, exposed ring by the box only) / beside a box (tangent: no shared area, no cross names) / under a box, extrude wall shared by two sketch rects (plain and per-layer 2D names), reserved id (geom error, spec issue, box list allowed). mesh `stack.test.ts` (+1): boxes A and B touching on y [0.5, 1] x z [0.25, 1]: facet area selected by `bnd:A.xmax` = 1, by `bnd:B.xmin` = 1.875 (full face incl. the 0.375 contact), union = 2.5, to 1e-12; mesh conforming.
- 2026-11-18 09:56 PST: regression (S3 script `<scratch>/S3/regress.ts`, unchanged): `logs/F3-regress-after-20261118T095628.json` vs `logs/S3-regress-before-20261118T085201.json`, `logs/S3-regress-after-20261118T091729.json` and `logs/I1-S3-regress-after-20261118T093647.json`: 48 / 48 sims identical (mesh hash + tagHash at order 1 and 2), and the five 3D sims (6 studies) identical: prepared mesh hash, scalars as exact strings, field sha-256.
- 2026-11-18 09:57-09:59 PST: tests: geom 48 / 48 (`logs/F3-geom-test-20261118T095719.log`), mesh 20 / 20 (`logs/F3-mesh-test-20261118T095719.log`), physics 164 / 164 incl. `geom3d.test.ts` (99.8 s; `logs/F3-physics-test-20261118T095756.log`; count includes tests added by concurrent lanes). `pnpm -r check` exit 0, svelte-check 0 errors (`logs/F3-check-20261118T095940.log`).

### 7.4 Result
- A1, A2 closed. Contract note for the coordinator (R-coord-1 addendum): in stacks, both owners' names select a shared side wall, as plain names and as per-layer names (`bnd:<B'>.<layer>`); for mixed boxes / z cylinders as the 3D face names (`bnd:B.xmin`, `bnd:B.xmin.z<k>`); the mixed-solid stack id `solids` is reserved for solid ids. No tracked file outside `packages/geom/**`, `packages/mesh/**` and this section changed; `packages/physics/test/geom3d*.test.ts` unchanged (still passes).
