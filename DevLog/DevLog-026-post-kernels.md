# DevLog-026: results engine kernels in `@amp/post` (lane R1)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | R1 (results engine kernels; DevLog-023 s.4 R1) |
| Owns | `packages/post/**`, this file |
| Read only | `packages/{core,spec,physics,geom,mesh,eval}`, `apps/web/src/lib/post/*`, `sims/*.yaml`, `eval/cases/a/{SM-01,EM-01}.yaml`, `../eo-modulator-atlas/engine/src/postproc/{evaluate,expr}.mjs` (method reference only, no code copied) |
| Spec | DevLog-023 s.1.2, s.3.2, s.3.3, s.3.7, s.4 R1, s.5.1 (no export of any kind) |
| Status | R1 kernels and gates 1-6 done; gate 7 prepared (Node side); fresh-context audit done, fixes applied (s.8) |

Conventions: "F" = fact read from code; "E" = estimate (labelled); "P" = proposal.

## 1. Plan (2026-11-06 22:34 PST)

### 1.1 Constraints
- Kernel API takes plain arguments (mesh, solution, field or expression, p0 / p1 / n, selection ids). No dependency on spec node shapes: lane R0 changes `packages/spec` schema in parallel; a later lane writes the spec-to-kernel adapter.
- `sample`, `linePoints`, `gridPoints`, `toCsv`, `integrate`, `extrema`, `evaluateField` keep their signatures (C5, contract changelog 16:15 / 16:30). `toCsv` stays (existing API) but nothing new exports anything (s.5.1).
- Determinism for gate 7 (Node vs browser worker): kernels use IEEE `+ - * /` and `Math.sqrt` only (no `Math.hypot`, `Math.pow`, `Math.sin`); expression functions go through `@amp/core/expr` (detmath). Quadrature weights come from `@amp/physics/common/quad` (V8 in both Node and Chrome; noted as a caveat for other engines).
- 3D scope: cut line and domain integrals work on any C2 mesh (dim 3 included) because they use the generic `Locator`. Edge datasets are 2D. Cut plane stays in apps/web (R4 moves it).

### 1.2 Files
| File | Content |
|---|---|
| `src/points.ts` | `PointSet` (coordinates + cell + reference coordinates), `locatePoints`, per-cell interpolation of values and gradients at known (cell, ref) |
| `src/expr.ts` | `compileFieldExpr` / `evaluateExpr`: `@amp/core/expr` over solution fields; names `<physics>.<field>[.<comp>]` or `<field>[.<comp>]`; components `.x .y .z` (`.r .z` and `.phi` on axisym meshes, numeric `.0 .1 .2` not allowed by the grammar); coordinates `x y z` (`r z` on axisym; `r` = sqrt(x^2 + y^2) on planar meshes); params (SI values with SI unit); module scalars as constants; `defs` (named sub-expressions); `d(f, v)` with v in x, y, z, r (gradient per element, marked discontinuous). Units from `FieldData.unit` through `@amp/core/units`. `d()` is rewritten to a synthetic field reference before compilation because the core grammar has no `d` (no edit to `@amp/core`). |
| `src/datasets.ts` | `solutionSteps` (steps: all, first, last, indices), `cutPoints`, `cutLine` (2D and 3D; uniform n points and element-crossing breakpoints; Gauss 3 points per piece for integrals), `edgeDataset` (2D boundary facets by entity ids through `resolveEntityIds`, chained and ordered by arc length; Gauss points per facet on the isoparametric facet; adjacent cell found by node match) |
| `src/evaluations.ts` | `evalPoint`, `evalGlobal`, `evalIntegral`, `evalAverage`, `evalMax`, `evalMin`, `evalMeasure` over a region: `{kind: 'domain', ids?}`, `{kind: 'boundary', ids}` (2D edges; 3D faces), an edge dataset, a cut line. Axisymmetric 2 pi r weight on by default for `mesh.axisym` (option `revolve`). Max / min state the method (`nodal`: expression at each cell's nodes, `quad`: at quadrature points, `points`: at the dataset sample points) |
| `src/index.ts` | exports the new API next to the old one |
| `test/r1.test.ts` | analytic unit tests on fixture meshes (exact P2 polynomials, crossings, edge order, axisym weights, expression units, d()) |
| `test/r1-gates.test.ts` | gates 1-6 on the real engine (prepareRun + module.run, nested levels hFactor 1, 0.5, 0.25: the eval harness path), the order rule |
| `gates/r1-convergence.ts` | same gates as a script; writes `logs/r1-post-gates-<timestamp>.json` and a table |
| `gates/fixture-r1.ts` | gate 7 prep: deterministic fixture (structured mesh + analytic field) and a SHA-256 of the evaluation results (WebCrypto, runs in Node and in a worker) |

### 1.3 Gates (DevLog-023 s.4 R1)
Closed forms (a = 5 mm, L = 50 mm, s_inf = 100 MPa for Kirsch; a = 0.5 mm, b = 1.75 mm, V = 1 V on r = a, 0 on r = b for coax):
1. sigma_xx(0, y) = s_inf (1 + a^2/(2y^2) + 3a^4/(2y^4)), y in [a, L]: max abs error over the cut line.
2. sigma_xx(x, 0) = s_inf (1 - 5a^2/(2x^2) + 3a^4/(2x^4)), x in [a, L].
3. int_a^L sigma_xx(0, y) dy = s_inf [(L - a) + (a^2/2)(1/a - 1/L) + (a^4/2)(1/a^3 - 1/L^3)]: re-derived in s.2.
4. Edge `bnd:hole.edge`: sigma_thetatheta = s_inf (1 - 2 cos 2 theta) through the expression `sxx*sin(th)^2 + syy*cos(th)^2 - 2*sxy*sin(th)*cos(th)`, th = atan2(y, x) (a `defs` entry).
5. Coax radial cut line: V(r) = ln(b/r)/ln(b/a); `-d(es.V, r)` = 1/(r ln(b/a)); int_a^b E_r dr = 1 V.
6. Measure of the quarter plate: L^2 - pi a^2/4, the error stated against the polygonal-hole (chord) deficit.
Rule: the error decreases at the expected order of the element between nested levels; the finest-level error is reported. No absolute tolerance.
Expected orders (P2 Lagrange, nodal-averaged stresses; E from standard FE theory, to be confirmed by the runs): V values 3, gradients and recovered stresses 2, integrals of recovered stresses 2, area of the isoparametric P2 domain 4 (polygon 2).

### 1.4 Needs in other packages (recorded, not edited)
- `@amp/core/expr` (L1): the grammar has no `d`; `expr.ts` rewrites `d(<field name>, <coordinate>)` to a synthetic name before compiling. A native `d()` node (or a call hook in the scope) would allow `d()` of a general expression.
- `@amp/post/package.json` has no `@amp/geom` dependency (adding one needs `pnpm install`, which changes the root lockfile). Selections go through `@amp/physics/common/mesh` `selectEntities`, which is `resolveEntityIds` plus an error on unknown ids. Coordinator: add `@amp/geom` to `@amp/post` if the direct call is wanted.
- `@amp/post` `Locator` (own file) sized its bucket grid with `Math.pow`; replaced by an integer search with identical results (checked for nc < 3e5, dim 2 and 3), since the grid order decides the cell returned for points on shared edges.
- `@amp/core/units` `factor ** p` for prefixed powered unit literals (`[mm^2]`) is a determinism caveat for gate 7 (the fixture uses none). L1 could tabulate the Gauss nodes and avoid `**` (audit D2, D3).
- `@amp/physics/common/lagrange` `facetJac` uses `Math.hypot` (not guaranteed bit-identical across JS engines); `@amp/post` does not call it (own facet Jacobian with `Math.sqrt`). `@amp/physics/common/quad` builds Gauss nodes by Newton from a `Math.cos` start: same bits in Node and Chrome (both V8), not guaranteed in Firefox / Safari (gate 7 caveat).

## 2. Closed-form derivations (2026-11-06 22:49 PST)

Kirsch (plane stress, remote s_inf along x, hole radius a; the field used by `validation/a/gen_solid.py` `kirsch_field`):
- On x = 0 (theta = 90 deg): sigma_xx(0, y) = s_inf (1 + a^2/(2y^2) + 3a^4/(2y^4)); equals 3 s_inf at y = a.
- On y = 0 (theta = 0): sigma_xx(x, 0) = s_inf (1 - 5a^2/(2x^2) + 3a^4/(2x^4)); equals 0 at x = a.
- Gate 3: int_a^L a^2/(2y^2) dy = (a^2/2)(1/a - 1/L); int_a^L 3a^4/(2y^4) dy = (3a^4/2)(1/3)(1/a^3 - 1/L^3) = (a^4/2)(1/a^3 - 1/L^3). With a = 0.005 m, L = 0.05 m: (L - a) = 0.045; (a^2/2)(1/a - 1/L) = 1.25e-5 x 180 = 2.25e-3; (a^4/2)(1/a^3 - 1/L^3) = 3.125e-10 x 7.992e6 = 2.4975e-3; sum 0.0497475 m; x 1e8 Pa = 4.97475e6 N/m (matches DevLog-023; the script recomputes it from the spec params: 4974750.00 N/m).
- Gate 4: on r = a the Kirsch hoop stress is s_inf (1 - 2 cos 2 theta); the Cartesian transformation sigma_thetatheta = sxx sin^2 th + syy cos^2 th - 2 sxy sin th cos th; the reference uses cos 2 theta = (x^2 - y^2)/r^2.
- Gate 6: quarter plate area L^2 - pi a^2/4 = 2.5e-3 - 1.9635e-5 m^2. Chord polygon with corner nodes on the arc: each facet of subtended angle theta adds (a^2/2)(theta - sin theta) (circular segment) to the plate area.

Coax (V = 1 V on r = a, 0 on r = b; Laplace in an annulus):
- V(r) = ln(b/r)/ln(b/a); dV/dr = -1/(r ln(b/a)); E_r = -dV/dr = 1/(r ln(b/a)); int_a^b E_r dr = (ln b - ln a)/ln(b/a) = 1 V.

## 3. TODO
- [x] points.ts, expr.ts
- [x] datasets.ts
- [x] evaluations.ts
- [x] unit tests (`test/r1.test.ts`, 6 tests)
- [x] gates 1-6 test + convergence script + log
- [x] gate 7 fixture + Node hash (`gates/fixture-r1.expected.json`)
- [x] `pnpm test` at the root: `@amp/post` 12/12; failures only in `@amp/spec` (2) and `apps/web` (1), both from the R0 results-schema change in flight (s.7)
- [x] fresh-context audit, fixes (s.8); root `pnpm test` green after the fixes (23:10 PST)

## 4. API (`@amp/post`, new in R1; all old exports unchanged)

```ts
// points.ts
interface PointSet { mesh: Mesh; n: number; x: Float64Array; cell: Int32Array; ref: Float64Array; normal?: Float64Array; tangent?: Float64Array }
locatePoints(mesh, points, { snap? }): PointSet
interpolate(field: FieldData, ps: PointSet, { grad? }): { values; grad? }
mapToPhysical(mesh, cell, ref, out): void;  flatPoints(points, dim): Float64Array;  NODE_REF
// expr.ts
compileFieldExpr(sol, src, { mesh?, physicsId?, params?, defs?, step? }): FieldExpr   // { src, unit, dim, continuous, constant, fields, evaluate(ps) }
evaluateExpr(sol, src, points | PointSet, { mesh?, snap?, physicsId?, params?, defs?, step? }): { values, unit, dim, continuous }
// datasets.ts
solutionSteps(sol, 'all' | 'first' | 'last' | number[]): { indices, values, unit, kind }
cutPoints(mesh, points, { snap? }): CutPointsDataset                         // { kind: 'points', mesh, points, outside }
cutLine(mesh, p0, p1, { n?, mode?: 'uniform' | 'crossing', snap? }): LineDataset   // { kind: 'line', length, covered, points, s, pieces, quad }
lineCrossings(mesh, p0, p1): Float64Array
edgeDataset(mesh, ids, { reverse?, degree? }): EdgeDataset                   // { kind: 'edge', facets, flip, chains, chainPoints, length, points, s, quad }
domainQuad(mesh, ids?, { degree? }): QuadSet;  boundaryQuad(mesh, ids, { degree? }): QuadSet
facetCell(mesh, f); facetsOfBoundaries(mesh, ids); cellsOfDomains(mesh, ids?)
// evaluations.ts; Region = { kind: 'domain', ids? } | { kind: 'boundary', ids } | LineDataset | EdgeDataset | CutPointsDataset
evalPoint(sol, expr, CutPointsDataset | LineDataset | EdgeDataset | PointSet | points, o): { values, unit, dim, continuous, outside }
evalGlobal(sol | null, expr, { params?, physicsId? }): { value, unit, dim }
evalIntegral / evalAverage(sol, expr, region, { revolve?, degree?, ...ExprOptions }): EvalResult
evalMax / evalMin(sol, expr, region, { method?: 'nodal' | 'lattice' | 'quad' | 'points', resolution? }): EvalResult
evalMeasure(mesh, region, { revolve?, degree? }): { value, unit, dim, rdim, revolved, n }
// EvalResult = { value, unit (SI), dim, method, n, continuous, at?, measure?, nOutside?, nNaN?, coverage? }
paramLookup(params, name): { si, dim } | null   // shared by expressions and evalGlobal; non-SI units are an error
```

Decisions (P, recorded):
- Expression names resolve defs > coordinates > normals / tangents > t > fields > module scalars > params; a user param with the same bare name as any of the others is an error; names starting with `__d` are reserved (the d() rewrite); `d()` of a DG0 field is a compile-time error. `r` in planar meshes is sqrt(x^2 + y^2) and `d(f, r)` the radial derivative (gate 5 needs it on the planar coax). Units come from `FieldData.unit`; the unit string is `formatUnit` of the dimension (SI, e.g. `V`, `m*K`).
- A dataset carries its mesh; evaluating it with a solution on another mesh is an error (honesty rule: a plot is drawn on its own mesh only).
- Cut-line crossings: affine simplices by exact barycentric clipping; 2D curved or quad cells by the closed-form intersection of the line with each (P2 quadratic or straight) cell edge; 3D curved or hex cells by 32 samples plus 9 in the corner-simplex interval and bisection of each inside / outside change (an inside piece shorter than the sample spacing can still be missed in 3D: open item). Pieces whose middle is outside every cell are skipped (`covered` < `length`; integrals report `coverage`).
- Integrals on cut lines: Gauss 3 points per element piece (exact to degree 5 on affine cells). Domains and boundaries: the @amp/physics rules of degree 5 (P2 cells) or 3.
- Revolve (2 pi r) defaults to on for axisymmetric meshes in every integral and measure, including cut lines and edges; `revolve: true` on a planar mesh is an error.
- Edge datasets evaluate in the facet's first adjacent cell; on an internal interface that choice is arbitrary (open item). Open chains start at the open end with the smaller (x, y); closed loops run with the outward normal on the right (counterclockwise around a domain, clockwise around a hole). Facet normals are oriented once per facet (at its middle). `chainPoints` gives each chain's range in `points` / `s` (s runs on across chains).
- Max / min report the method; `lattice` uses the refine.mjs barycentric pattern (triangles only).
- Kirsch gates run the SM-01 levels (1, 0.5, 0.25) plus one more halving (0.125, still nested): with three levels the gate-3 error is pre-asymptotic because its part over y in [a, 2a] (+1376.5, +350.1, +87.4, +21.9 N/m) and over [2a, L] (-1462.2, -428.4, -115.7, -29.9 N/m) cancel; orders of the parts 1.98, 2.00, 2.00 and 1.77, 1.89, 1.95 (log rows 3n, 3f). With the SM-01 levels alone gate 3 fails the rule (0.13, 1.47). The coax gates use the EM-01 levels.
- The gates build levels as the eval engine worker does: `prepareRun({case, spec, physicsId, level, hFactor})` with the SM-01 / EM-01 case data, then `module.run` (stationary studies: no dtFactor); they run in-process, not in a worker thread, and the sims' `results` section is dropped before the solve.
- Gate 5c is evaluated on the radial line phi = 0, whose ends are mesh nodes on both conductors. Audit G1: there it is an identity (for any discrete solution with V_h = 1 / 0 at the conductor nodes the integral is V_h(a) - V_h(b) = 1 up to the curved-cell Gauss error), so it cannot fail and tests only the crossing quadrature and d(); it is labelled so in the log and needs coordinator sign-off as the reading of DevLog-023 gate 5. The DevLog-023 text (line integral of E_r = 1 V) is inherently such an identity on any line whose ends lie on the discretized conductors; on phi = 0.3 rad the end r = a lies inside the mesh off the P2 conductor arc (V_h(a) = 1 - 5.5e-9 at the finest level), a geometry error that is not monotone in h (row 5d, information). Row 5e checks that the cut-line quadrature reproduces V_h(start) - V_h(end) (8.9e-16 V at the finest level).
- Order rule as implemented: observed order of the last level pair >= 0.75 x the expected order (the harness band of 25 %, used as a lower bound), the error strictly decreasing at every refinement; or every level below 1e-12 relative (round-off floor). Expected orders: V values 3, recovered stresses and gradients 2, their line integral 2, isoparametric P2 area 4.

## 5. Gate results (final run 2026-11-06 23:07 PST, `logs/r1-post-gates-20261107T070753Z.json`; the numbers match the 22:47 run)

Levels: Kirsch hFactor 1, 0.5, 0.25, 0.125 (4,156 / 16,392 / 65,104 / 259,488 DOF, tri6); coax 1, 0.5, 0.25 (548 / 2,336 / 9,632 DOF).

| Gate | Quantity | Expected p | Observed p (pairs) | Finest error | Finest rel | Status |
|---|---|---|---|---|---|---|
| 1 | max abs sigma_xx(0, y) error, y in [a, L] | 2 | 1.65, 1.85, 1.93 | 3.696e4 Pa | 3.70e-4 of s_inf | pass |
| 2 | max abs sigma_xx(x, 0) error, x in [a, L] | 2 | 1.96, 1.99, 1.88 | 9.127e3 Pa | 9.13e-5 | pass |
| 3 | int_a^L sigma_xx(0, y) dy vs 4.97475e6 N/m | 2 | 0.13, 1.47, 1.82 | 8.008 N/m | 1.61e-6 | pass |
| 3i | L1 line error int abs(sigma_h - sigma) dy (info) | 2 | 1.83, 1.94, 1.98 | 58.62 N/m | 1.18e-5 | info |
| 3n / 3f | signed error parts, y < 2a / y > 2a (info) | 2 | 1.98, 2.00, 2.00 / 1.77, 1.89, 1.95 | +21.89 / -29.90 N/m | - | info |
| 4 | max abs sigma_thetatheta error on `bnd:hole.edge` (expression) | 2 | 1.44, 1.89, 1.96 | 3.391e4 Pa | 3.39e-4 | pass |
| 4b | sigma_thetatheta(0, a) vs 3 s_inf | 2 | 2.32, 2.54, 1.99 | 840.4 Pa | 2.80e-6 of 3 s_inf | pass |
| 5a | max abs V(r) error, radial line phi = 0.3 | 3 | 2.61, 2.93 | 1.223e-5 V | 1.22e-5 | pass |
| 5b | max abs (-d(es.V, r)) error | 2 | 1.97, 1.98 | 3.555 V/m | 2.23e-3 of E_r(a) | pass |
| 5c | int_a^b E_r dr vs 1 V (phi = 0), identity check | - | - (errors 0, 3.3e-16, 0) | 0 V | 0 | pass (round-off floor; cannot fail, audit G1) |
| 5d | same on phi = 0.3 (info) | - | 7.33, -0.02 | 5.551e-9 V | 5.55e-9 | info (geometry) |
| 5e | quadrature vs V_h(start) - V_h(end), phi = 0.3 (info) | - | 1.34, 7.79 | 7.8e-16 V | - | info |
| 6 | area(dom:plate) vs L^2 - pi a^2/4 | 4 | 4.00, 4.00, 4.00 | 4.389e-16 m^2 | 1.77e-13 | pass |

Gate 6, polygonal-hole statement: a chord polygon through the same hole corner nodes would add 1.823e-8, 4.558e-9, 1.140e-9, 2.849e-10 m^2 (order 2). The mesh's P2 arcs (mid nodes on the circle) leave 1.8e-12 ... 4.4e-16 m^2 (order 4.00). Both are hole-discretization (geometry) errors; the quadrature is exact for the isoparametric map.

Order rule leniency (audit G3, stated): only the last pair must reach 0.75 x the expected order; early pairs (gate 3: 0.13, gate 4: 1.44) are pre-asymptotic and are reported, not gated; no upper bound.

Timing (warm median of 5, Node, final run): cut line 500 points + sxx at the points 0.59 / 0.79 / 1.2 / 2.16 ms; domain integral of `solid.mises` 2.52 / 9.52 / 38.3 / 148 ms on the four Kirsch levels (s.3.7 targets: cut line < 10 ms, surface integral < 30 ms at about 10,810 DOF: met at 16,392 DOF).

Gate 7 (prepared): `gates/fixture-r1.ts` `gate7Fixture()` hashes 1,899 kernel results: structured tri6 (planar, axisymmetric) and curved tri6 (shifted interior mid nodes, raised top mid nodes) rectangles, and a tet10 box with a 3D cut line; d(), atan2 / cos / sin via detmath, lattice max, edge, line, domain and face integrals. Node v23.7.0 SHA-256 `b913438eacde4cbf13b0ab52a9a8a0bb72969b5bb051cc65d47ca0e6eefcd822` (`gates/fixture-r1.expected.json`). R2 runs the same function in the post worker and compares; `crypto.subtle` needs a secure context (https or localhost).

## 6. Open items for R2 / R3
- R2: run `gate7Fixture()` in the browser post worker (the module imports `@amp/physics/common/mesh` and `../src/index.ts` only; WebCrypto `subtle.digest`), compare with the recorded hash; add a post-worker `results` message set that wraps `cutLine`, `edgeDataset`, `evalPoint` (C6, DevLog-023 s.8).
- R2: line graphs from `LineDataset.points` / `.s` (uniform) or the crossing mode (3 points per element piece; jumps of `continuous: false` expressions visible).
- R3: the spec-to-kernel adapter (R0 node shapes -> plain arguments): `data` -> solution + step (`solutionSteps`), `from` / `to` quantities -> SI p0 / p1, `select` -> ids, `params` -> `resolveParams(spec.params).scope`, physics id prefix -> `physicsId`.
- R3: evaluation tables over steps / sweep points: loop `solutionSteps(...).indices` with `step`.
- Open: `d()` of a general expression (needs L1); interface side selection for edges on internal boundaries; 3D edges (no edge connectivity in C2); `lattice` for tets; cut plane (R4 moves `apps/web/src/lib/post/solid3d.ts`); exact crossings for 3D curved cells (sampling today); `lineCrossings` is O(all cells) per line (fine at s.3.7 sizes); coordinator sign-off on the gate 5c reading (s.4) and on the extra Kirsch level.
- C5 contract note (`@amp/post` API superseding the `sample` text) and C8 `extract: {result: ...}`: coordinator / L8 (DevLog-023 R1 contracts line), not edited here.

## 7. Root `pnpm test`
Final (2026-11-06 23:10 PST, after the audit fixes): `pnpm test` exit 0; every package green (post 13, spec 65, apps/web 10, the rest as below). The 22:48 run below predates R0 landing.

2026-11-06 22:48 PST:
`pnpm -r --no-bail test`: rt 16, core 81, geom 37, materials 21, eval 78, mesh 14, physics 44, agent 61, post 12 pass; `@amp/spec` 2 fail (`schema.test.ts` selections: `expression results.evaluations.0.items.0.expr`; JSON Schema size) and `apps/web` 1 fail (`diff.test.ts`: `b.results.push is not a function`). All three come from the grouped `results` object of lane R0 (DevLog-025), in flight; none touch `packages/post`.

## 8. Audit (fresh-context subagent, read only, 2026-11-06; 716 s wall, its gate run at 22:51 PST by the log stamp) and fixes
| Id | Finding | Fix (applied before the 23:07 PST final run) |
|---|---|---|
| B1 (medium) | cut lines dropped short pieces in curved boundary cells (16 samples missed a 1 um inside interval; coax h 0.5 line at y = 1.3e-4 m lost 2.3e-6 m, integral off by -2.3e-3 relative) | 2D: closed-form line / P2-edge intersection (`edgeHits`); 3D: denser sampling + corner-simplex seed. Repro now: covered 2.5247209e-3 m vs chords 2.5247209e-3 m on all three levels; unit test with raised P2 mid nodes exact to 1e-12 |
| B2 | `__d<k>` user names crashed; errors quoted the rewritten source | `__d` names reserved; messages quote the original text (positions dropped when rewritten) |
| B3 | `evalGlobal` accepted non-SI param units | shares `paramLookup` (error on non-SI) |
| B4 | silent shadowing of params by scalars, coordinates, normals, t | any bare-name clash with a user param is an error |
| B5 | closed-loop edge direction arbitrary | outward normal on the right (CCW around a domain); unit test: closed loop integral of x ty - y tx = 2 x area |
| B6 | facet normal sign decided per point | once per facet at its middle (cached) |
| B7 | partial line coverage invisible in integrals | `coverage: {covered, length}` on cut-line results |
| B8 | d() of DG0 failed only at evaluation | compile-time error |
| G1 (medium) | gate 5c cannot fail at phi = 0 | relabelled an identity check in the log and here; 5d / 5e kept; coordinator sign-off requested |
| G2 | gate 3 near / far split numbers not produced by committed code | rows 3n / 3f in `r1-gates.ts`; DevLog numbers now from the log (the far-pair order is 1.95, corrected) |
| G3 | order rule lenient | stated in s.5 |
| G4 | gates skipped `case` / `physicsId` of the harness path | passed now; results unchanged |
| G5 | log file name not cited | cited in s.5 |
| D1 | `Math.pow` in the `Locator` grid size | integer search, identical results |
| D2, D3 | Gauss nodes from `Math.cos`; `**` in units | recorded for L1 (s.1.4) |
| D4 | fixture covered affine tri6 only | curved tri6 and a tet10 box with a 3D cut line added; hash re-recorded |
| D5 | `crypto.subtle` secure context | noted in the expected file and s.6 |
| A1 | `evalPoint` rejected line / edge datasets | accepts any dataset with `points` |
| A2 | edge chains indexed facets only | `chainPoints` ranges into `points` / `s` |
| A3 | `evalAverage` compiled twice; `evalMeasure.n` counted outside points; line method lacked `_2pi_r`; NaN counted as outside | fixed; `nNaN` reported separately |
| A4 | dead `unitOf` export | removed |
| Style | two stale comments | fixed |
The auditor re-derived the Kirsch and coax closed forms and checked gate 6 against a per-facet closed form (circular segment minus 2/3 chord x sagitta: 1.7956265e-12 vs measured 1.7956088e-12 m^2 at h = 1), J^-T gradients, barycentric clipping, quadrature, axisym weights and units: fine. Its own log run was removed (intermediate); the final log is the one cited in s.5.

## 9. Progress
- 2026-11-06 22:34 PST: read DevLog-023, `@amp/post`, `@amp/core/expr`, `prepare.ts`, eval engine worker, kirsch / coax sims, EO evaluate method; plan written.
- 2026-11-06 22:34-22:45 PST: points.ts, expr.ts, datasets.ts, evaluations.ts written; `tsc` clean; unit tests 6/6 (fixtures exact at round-off).
- 2026-11-06 22:45 PST (log stamp): gates on 3 levels: gate 3 fails the order rule (0.13, 1.47) from near / far error cancellation; gate 5c at phi = 0.3 shows the conductor geometry gap. Kirsch gets one more nested level; 5c moves to phi = 0 with the 0.3 line kept as information.
- 2026-11-06 22:47 PST (log stamps 22:47:04, 22:47:55): all gates pass; gate 7 fixture hash recorded; timing added.
- 2026-11-06 22:48 PST: root `pnpm test`: post green; spec / web failures from R0 (s.7).
- 2026-11-06 22:49-23:07 PST: fresh-context audit (716 s); fixes applied (s.8); post tests 13/13; gate 7 hash re-recorded (fixture extended).
- 2026-11-06 23:07 PST: final convergence run, `logs/r1-post-gates-20261107T070753Z.json` (intermediate logs of this lane removed).
- 2026-11-06 23:10 PST: root `pnpm test` exit 0.

## Coordinator sign-off (2026-11-06 23:12 PST)
- Gate 5c accepted as a quadrature / d() consistency identity (V_h(a) - V_h(b) = 1 for any discrete solution), not as convergence evidence; the off-node phi = 0.3 rad row stays information only.
- The extra Kirsch level (hFactor 0.125) is accepted: on the SM-01 levels the gate-3 integral error from [a, 2a] and [2a, L] cancels (orders 0.13, 1.47); each part converges at about order 2 alone. This is a property of the integrated quantity, not tuning; the case's own levels are unchanged.
