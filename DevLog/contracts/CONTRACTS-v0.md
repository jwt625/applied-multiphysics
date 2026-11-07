# Contracts v0 (cross-lane interfaces)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Owner | coordinator (changes only via the coordinator; lanes propose changes in their DevLog under "Contract requests") |
| Plan | DevLog-001 |

Each contract is a minimum. A lane may add optional fields without asking. Renames, removals and semantic changes go through the coordinator. All shared types live in `packages/spec/src/types/` (owned by L2); until L2 publishes them, lanes copy the shapes below into a local `contract-shim.ts` and delete it once L2's types exist.

## C1 Package conventions

- Package names: `@amp/core`, `@amp/geom`, `@amp/mesh`, `@amp/spec`, `@amp/physics`, `@amp/post`, `@amp/rt`, `@amp/eval`, `@amp/agent`; app: `apps/web`.
- ES modules. New code is TypeScript with erasable syntax only (`erasableSyntaxOnly`), run directly by Node >= 23.6 and bundled by Vite. Ported atlas code stays `.mjs` with `.d.mts` declarations.
- Port header on every ported file, first lines:
  `// Ported from <repo>/<path> at <commit short sha> (GPL-3.0-or-later). Changes: <summary or "none">.`
  Palace-derived files keep their existing Apache-2.0 attribution header and are listed in that package's `NOTICE`.
- SPDX line `// SPDX-License-Identifier: GPL-3.0-or-later` on every new file.
- Runtime dependencies: none, except `yaml` in `@amp/spec`, `robust-predicates` in `@amp/geom`/`@amp/mesh`, and lazily loaded WASM meshers (L3 spike). Every other runtime dependency needs the coordinator's approval.
- Tests: `node --test`. Each package's `package.json` has `test` and `check` (`tsc -p . --noEmit`) scripts.
- Units inside the engine: SI base units, `Float64Array` for data. Display units live in `@amp/core/units`.
- No numeric literal for a physical property in engine code; materials come from the spec or `materials/`.

## C2 Mesh (in memory, transferable)

```ts
type CellType = 'line2' | 'line3' | 'tri3' | 'tri6' | 'quad4' | 'tet4' | 'tet10' | 'hex8' | 'prism6';
interface Mesh {
  dim: 1 | 2 | 3;
  axisym?: boolean;                 // 2D meridional (r, z) mesh
  nodes: Float64Array;              // dim * nNodes, SI metres
  cells: { type: CellType; conn: Int32Array; domain: Int32Array };   // domain = geometry entity index
  facets: { type: CellType; conn: Int32Array; boundary: Int32Array }; // boundary facets + internal interfaces
  entities: EntityTable;            // index -> persistent id, kind, label
  hash: string;                     // sha-256 of nodes + conn (hex), used by run records
}
interface EntityTable { domains: EntityRef[]; boundaries: EntityRef[]; edges?: EntityRef[]; points?: EntityRef[] }
interface EntityRef { id: string; label?: string; parent?: string[] }   // id e.g. "dom:rect1", "bnd:rect1.top"
```

Persistent IDs come from the construction history (`<feature id>.<sub-entity>`). Splitting under a boolean operation gives `<id>#<k>`, ordered deterministically, and `parent` records the origin. Selections in the spec are lists of these IDs.

## C3 Model spec (`amp-spec/0`, YAML canonical)

Top-level keys (L2 owns the full schema; these are fixed now):

```yaml
schema: amp-spec/0
id: kirsch-plate
title: Plate with a hole
params:   { a: {value: 5, unit: mm, range: [1, 20]} }          # expressions allowed: "2*a"
geometry: { dim: 2, axisym: false, features: [ ... ] }       # ordered feature list, each with id
materials: [ { id: steel, ref: "materials/steel-aisi-1020", override: {...}, select: [dom:plate] } ]
physics:  [ { id: solid1, type: elastic, select: [dom:plate], settings: {...},
              bcs: [ { id: fix1, type: fixed, select: [bnd:plate.left] }, ... ] } ]
couplings: [ { id: th2sm, type: thermal-expansion, from: heat1, to: solid1 } ]
mesh:     { size: {...}, refine: [ {select: [...], h: "a/10"} ] }
studies:  [ { id: std1, type: stationary | eigen | time | frequency | parametric, settings: {...} } ]
results:  { datasets: [...], evaluations: [...], tables: [...], plots: [...] }   # grouped object, C10 (was a flat list until 2026-11-06)
provenance: { values: { "materials.0.override.E": {basis: textbook, source: "...", date: 2026-11-06} } }
assumptions: [ ... ]
missing: [ ... ]
```

Rules: strict keys (unknown keys are an error), no hidden physical defaults, units on every dimensional value, and explicit selections only (no "later wins" overlap order).

## C4 Physics module interface (`@amp/physics`)

```ts
interface PhysicsModule {
  type: string;                          // 'heat', 'elastic', 'electrostatics', ...
  dims: Array<'1d' | '2d' | '2d-axisym' | '3d'>;
  readiness(spec: Spec, physicsId: string): { ready: boolean; reasons: string[] };
  run(ctx: RunContext): Promise<Solution>;  // ctx: spec, mesh, materials, study, progress(), signal (AbortSignal)
}
```

## C5 Solution and run record

```ts
interface Solution {
  meshHash: string;
  fields: FieldData[];                   // { name: 'T', unit: 'K', space: 'H1P1'|'H1P2'|'NED1'|'NED2'|'DG0', components: 1|2|3, data: Float64Array, step?: number }
  steps?: { kind: 'time'|'eigen'|'freq'|'param'; values: Float64Array; unit: string };
  scalars: Record<string, { value: number; unit: string }>;    // derived values, e.g. 'K_t', 'f_TM010'
  stats: { dof: number; nnz?: number; iterations?: number; residual?: number; solver: string };
  timing: Record<string, number>;        // ms per stage: geometry, mesh, assemble, factor, solve, post
  run: RunRecord;
}
interface RunRecord {
  engine: string;            // '@amp/physics@<version>+<git short sha or "dirty">'
  specHash: string; meshHash: string;
  startedAt: string;         // ISO 8601 with offset
  platform: { runtime: 'node'|'browser'; ua?: string; cores?: number; gpu?: string; crossOriginIsolated?: boolean };
  fidelity: 'rigorous' | 'realtime';
}
```

## C6 Worker protocol (browser)

Messages to the worker: `{type:'run', id, specText, options}` and `{type:'cancel', id}`. Messages from the worker: `{type:'progress', id, stage, frac, msg, ts}`, `{type:'result', id, solution}` (typed arrays transferred) and `{type:'error', id, message, stage}`. Every message carries `ts` as an ISO string.

## C7 Operation record (`@amp/spec`, implements D3 / A4)

```ts
interface Operation {
  seq: number; ts: string;
  actor: 'user' | `agent:${string}`;
  reason?: string;                       // agent operations: required
  patch: JsonPatchOp[];                  // RFC 6902 against the parsed spec
  inverse: JsonPatchOp[];
  before: string; after: string;         // spec hashes
  validation: { ok: boolean; errors: string[] };
  invalidates: Array<'geometry'|'mesh'|'solution'|'plots'>;
  prev: string; hash: string;            // hash chain
}
```

Revert = append the inverse as a new operation. The YAML text is regenerated by comment-preserving splice; the patch is never applied by regenerating the whole file.

## C8 Eval case (`amp-eval/0`)

The schema is the one in `DevLog/research/2026-11-06-R3-eval-set-sources.md` section 2; L8 owns the loader and validator. Files: `eval/cases/<class>/<ID>.yaml`, where class is `a`, `b` or `c` and IDs are as in R3 (e.g. `SM-01`). Expected values that a script computes are written to `eval/expected/<ID>.json`, together with generator path, package versions and ISO timestamp. Each case either embeds an `amp-spec/0` model or references `sims/<id>.yaml`. Until a physics module exists, `spec` may be `pending` with `reason`.

Result record (JSONL, `logs/eval-YYYYMMDDTHHMMSS.jsonl`): `{case, target, value, ref, tol, pass, time_ms, dof, run}`.

## C9 Real-time kernel interface (`@amp/rt`)

```ts
interface RealtimeKernel {
  id: string; fidelity: 'realtime';
  init(device: GPUDevice, params: Record<string, number>, grid: { nx: number; ny: number; nz?: number; dx: number }): Promise<void>;
  step(n: number): void;                  // encodes n steps into the queue
  view(): { texture?: GPUTexture; buffer?: GPUBuffer; unit: string; range: [number, number] };
  readback(name: string): Promise<Float32Array>;   // used by eval gates
  dispose(): void;
}
```

A CPU reference implementation of the same kernel, small grids only and runnable in Node, exists for every kernel so the eval harness can gate it without a GPU.

## C10 Results model (`results` in amp-spec/0)

Authority: `packages/spec/src/results.ts` (zod schema built into the spec schema, cross-reference checks, expression vocabulary, reader helpers); design in DevLog-023 s.3, lane log DevLog-025. This section is a summary.

```yaml
results:
  datasets:    [ {id, type: solution | cutpoint | cutline | edge | cutplane | revolve | mirror | join, data (join: a, b), ...} ]
  evaluations: [ {id, data?, steps?, items: [ {id, type: point | global | integral | average | max | min | measure, ...} ]} ]
  tables:      [ {id, from: <evaluation group>, orient?: rows | columns} ]
  plots:       [ {id, type: plot1d | plot2d | plot3d, data?, steps?, items: [...]} ]
```

- Every node: `id` (one namespace with the whole spec, so `@id` patch paths work: `/results/plots/@pg/items/@surf/expr`), `label?`, `enabled?` (false: the node and its readers are not computed). Datasets, plot groups and all items are discriminated by `type`; evaluation groups and tables have no `type`.
- `data` names a dataset everywhere, except on a `solution` dataset, where it names a study. Items without `data` use their group's.
- `steps`: `all | first | last | <index> | [indices] | {values, unit}`; absent = all steps of the source. Indices always count the stored steps of the root study's solution (not the positions inside a dataset's own `steps`); an item's `steps` replaces its group's, a group's replaces its dataset's. `{values, unit}` must be in s for time studies and Hz for frequency studies.
- Exports: not in the schema (no export of any kind, DevLog-023 s.5.1); the key `exports` is reserved and rejected as an unknown key until an export stage adds it.
- Deferred kinds (added later as additive changes): datasets surface, grid, parametric curve / surface, sector; cut-line `parallel`; plot groups polar, smith; attributes filter, transparency; join ops other than `difference`.

Datasets (shape = dimension of the data / number of coordinates):

| type | source | shape | key fields |
|---|---|---|---|
| solution | a study | geometry dim / dim (axisym kept); carries geometry entities | `steps?` |
| cutpoint | domain-like or cutplane | points | `points: [vector m]` (length = coordinates of the source) |
| cutline | 2D / 3D domain-like or cutplane | line | `from`, `to` (vector m), `n?` (absent = element-crossing points) |
| edge | solution or join of solutions (entities) | line | `select`: `bnd` curves in 2D, `edg` in 3D |
| cutplane | 3D domain-like | surface in 3D | `point` (3), `normal` (3, dimensionless), `offsets?` (m) |
| revolve | axisymmetric domain-like | volume in 3D | `start?` (rad, absent = 0), `sweep` (0 < sweep <= 2 pi), `layers` |
| mirror | dim >= 2 | as the source, no entities | `planes: [{point?, normal}]` (1-3), `parity?: {<physics>.<field>[.<comp>]: [+-1 per plane]}` |
| join | two datasets of one shape | as `a` | `a`, `b`, `op: difference` |

"Domain-like" = dimension equal to the number of coordinates (solution, revolve, mirror / join of those). Dataset chains are acyclic.

Items and the datasets they accept:

| item | dataset |
|---|---|
| evaluation `point` | cutpoint |
| evaluation `global` | any (module scalars of its root study; no coordinates) |
| evaluation `integral`, `average`, `measure` | solution / join with `over` (required, explicit selection), or a line, surface or volume dataset without entities (cutline, edge, cutplane, revolve, mirror) and without `over` |
| evaluation `max`, `min` (`method`: nodal, quad, points or lattice; required) | as integral, and also cutpoint |
| plot1d `linegraph` (`x`: `arc` or an expression) | any line dataset (cutline, edge; a 1D solution) |
| plot1d `pointgraph` | cutpoint |
| plot1d `global` | any |
| plot1d `tablegraph` | a table (`columns?` = its evaluation items) |
| plot2d `surface contour arrow streamline maxmin mesh deformation height` | 2D dataset (solution 2D / axisym, cutplane, mirror / join 2D) |
| plot2d `point` | cutpoint in the group's space |
| plot2d `line` (`select?: bnd`), plot3d `line` (`select?: edg`) | solution / join with entities |
| plot3d `surface slice isosurface volume arrow streamline maxmin mesh deformation` | 3D dataset (solution 3D, revolve, mirror / join 3D) |

A plot2d / plot3d group needs `data` of its dimension; plot1d groups have optional `data`. `deformation` and `height` are attributes of their group. Plot `maxmin` items require `method` too (each max / min states its method).

Expression vocabulary (result expressions, `ResultExpr`):

- Field and module-scalar names `<physics id>.<name>`, with an optional component `.x .y .z` (`.r .phi .z` on axisymmetric models). The physics must be solved by the root study of the dataset. Bare field names are not accepted (the migration prefixed them). A physics id with `-` cannot be named (the expression grammar reads `-` as minus): use ids without `-` for physics that results refer to.
- Params and `pi`; coordinates in m: `x y r` (2D), `r z` (axisymmetric), `x y z r` (3D; `r` = sqrt(x^2 + y^2) on planar models); `t` (s) only on time-study datasets; no coordinates in `global` items.
- Functions: those of `@amp/core/expr` (abs real imag conj sqrt exp log log10 sin cos tan atan2 min max if) and `d(f, v)`, the derivative of f along the coordinate v, evaluated per element (discontinuous across elements; @amp/post rewrites it before compiling).
- Units: an expression without field names is dimension-checked against its `unit`. Field units are not in the registry yet, so expressions that name fields are checked only when a `resultDims` resolver is injected (`ValidateOptions.resultDims`); otherwise the evaluator (@amp/post) checks them. Not unit-checked at all in the spec yet: `integral` (unit = expression x m^k) and `measure` (m^k), whose k depends on the selection kind and the axisymmetric weight, and the vector items `arrow`, `streamline`, `deformation`.

Values and artifacts:

- Values are never stored in the spec. Tables, evaluation values, sampled arrays and plot data live in session memory only (DevLog-023 s.5.1 Q2).
- An artifact is keyed by `artifactKey(nodeHash, runId)`. `resultNodeHash(spec, id)` = sha-256 of the canonical JSON of the node, everything it reads (its group's defaults, its items, the dataset chain, a table's evaluation group) and the params those reference. `runId(run)` = sha-256 of the canonical C5 RunRecord.
- Edits under `results` invalidate stage `plots` only (C7). `changedResultNodes(before, after)` lists the nodes to recompute (dependents follow through the hashes).
- Honesty rules carry over (DevLog-023 s.3.1): a plot is drawn only on its own mesh; stale or coarse results are badged; eigenmodes are drawn normalized; each max / min states its method; range rules are stated; unavailable is never shown as a value.

## Changelog

- 2026-11-06 15:3x PST (before commit 3698b3f), adopted from L7a (DevLog-006 s.5) and L8:
  - `eval/schema/amp-eval-0.schema.json` (owned by L8) is now authoritative for C8, including `spec`, `metric_id`, `gate`, `expected`, `field_reference`, structured `tolerance.rule`/`norm`, and `budget_s.native`.
  - The expected-value file format is `amp-eval-expected/0`, for all lanes.
  - New reserve case IDs use 21-39 for class a, 41-59 for class b and 61-79 for class c.
  - CP-05 (electro-osmotic slit) is class a and is filed by L7a only.
  - Rule targets that need a sequence (mesh levels, radii) report `pending`, not `fail`, when given a single value.
- 2026-11-06 15:2x PST: tsconfig.base `lib` = ["ES2023"]; packages add DOM or WebWorker themselves, never both (from L1).
- Open: affine temperature units (`degC`) in `@amp/core/units`, requested by L1 and L7a; to be decided in the core v1 pass.
- 2026-11-06 15:4x PST (before commit 79f9e87), adopted from L2 (DevLog-003 s.5):
  - C3 detail is now authoritative in `packages/spec` (zod schema, exported JSON Schema). The C3 text above is a summary only.
  - C7 gains the fields `kind`, `target`, `text`, `textHash` and a genesis line; the authoritative definition is in `packages/spec/src/types/`.
  - Shared C2/C4/C5/C6/C7 types are published in `packages/spec/src/types/`. Lanes drop their `contract-shim.ts`.
  - C1: `zod` (4.6.7, MIT) is an approved runtime dependency of `@amp/spec`.
  - Registry: physics, BC, study, feature, coupling and material-property types are registered by name. The seed in `packages/spec/src/provisional/wave1.ts` is provisional; L4 (physics) and L3 (features) replace it.
  - `degC` is handled in the spec layer for now.
- 2026-11-06 15:4x PST, from L7b: physics tag `solid-nonlinear` to be added (L8). Class-b `source` sub-keys to be documented in the schema (L8).
- 2026-11-06 15:5x PST, adopted from L6 (DevLog-005 s.7):
  - C9 gains the optional members `grid`, `views`, `setView`, `setParams`, `paint`, `overlay` and `info`, defined in `packages/rt/src`.
  - The grid gains an optional `lengthUnit` (Gray-Scott uses model units).
  - Eval readback names are listed in DevLog-005 s.7; L8 may wrap the `@amp/rt` gates directly.
- 2026-11-06 16:0x PST, coordinator decisions on L3's requests (DevLog-004 s.5):
  1. L3's optional C2 fields move into `@amp/spec` types in the contracts-v1 pass at the end of wave 1. Until then they live in `@amp/mesh` and are documented there.
  2. Mixed facet shapes: `facets2` stays for wave 1. Contracts v1 changes C2 `facets` to an array of blocks `{type, conn, boundary}[]`, and the migration happens in one pass across mesh, physics and web.
  3. `Mesh.tagHash` (optional) is added, hashing entity tags and boundary assignment. RunRecord gains an optional `tagHash`. `hash` keeps its meaning (geometry + connectivity).
  4. Approved: `zod` and `@amp/spec` as dependencies of the `@amp/geom/spec` and `@amp/mesh/spec` subpaths only. Core geom/mesh stays free of the spec dependency.
  5. `mesh.size.grading` = maximum ratio of size growth per unit distance (L3 mapping), to be documented in the spec schema description (contracts v1).
  6. Selections match split pieces: selecting `dom:X` selects every `dom:X#k` (expansion via parent links). Readiness messages report the expansion so the user sees which pieces were included.
- 2026-11-06 16:0x PST, adopted from L8 (DevLog-009 s.7):
  - `yaml` is approved as a runtime dependency of `@amp/eval`, which now also depends on `@amp/spec` (workspace).
  - C4 gains `prepareRun(spec, caseCtx)` on the physics package export (module registry `modules` plus `prepareRun`). L4 implements it.
  - C5: `@amp/post` exports `sample(solution, field, points)` returning values at points, used for probe and field targets. L4 implements it.
  - Units not yet supported: `lbf` and non-SI length units in case statements. Cases restate them in SI (L7a: SM-21).
- 2026-11-06 16:0x PST, from the L2 audit (DevLog/audits/2026-11-06-L2-spec-audit.md): operation log v1 work (id-anchored array paths, guarded inverses, replay recomputes derived fields, external head hash) is assigned back to L2. It is a dependency of L9 (agent).
- 2026-11-06 16:1x PST, from L7c (DevLog-008):
  - The rights tags `copy_with_attribution` and `reference_by_hash` are accepted.
  - FL-61 (Turek-Hron CFD1) stays class c: the values come from the FEATFLOW software benchmark pages.
  - A dataset adapter (The Well / PDEBench: start from the stored frame, integrate, VRMSE/nRMSE against our own convergence floor) is assigned to L8 in a later pass. Dataset targets stay `gate: false` until then.
  - validation/ gains devsim 2.11.2, requests, h5py and jsonschema.
- 2026-11-06 16:1x PST (commit 8249307), adopted from L2 audit corrections (DevLog-003 s.7):
  - C7 is now `amp-oplog/1`: `@id` path tokens for array elements, guarded inverses including an `absent` op, per-op effect tracking, revert rules, `coalesced` ops for slider drags, and a replay that recomputes inverse, validation, invalidations and the agent-reason rule. v0 logs do not replay (none exist outside tests).
  - C5 RunRecord gains an optional `oplogHead`, the head hash of the operation log stored outside the log.
  - Spec quantities must be finite, with physical bounds (sizes > 0, absolute T >= 0 K, emissivity 0..1). L4 reviews the property bounds.
  - Keys `__proto__`, `constructor` and `prototype` are rejected everywhere.
- 2026-11-06 16:15 PST, from the L8 audit (B5): the canonical signatures are L4's implementation, and L8 adapts to them. `@amp/post` `sample(solution, mesh, field, points, component?)`; `@amp/physics` exports `modules`, `registry` and `prepareRun` as defined in `packages/physics/src/index.ts` / `spec-adapter.ts`. The C4/C5 text is corrected in the contracts-v1 pass. Target lookup is by `metric_id` (slug grammar `[A-Za-z][A-Za-z0-9_.+-]*`, L7a), never by free-text `quantity`.
- 2026-11-06 16:16 PST, C2 entity-ID grammar decision (L2/L3):
  - Fragment overlap pieces use `&` (e.g. `dom:a&b`), and the spec grammar accepts it.
  - Layers are dotted sub-entities `.L<k>` (e.g. `dom:stack.L3`), not `@`: `@` is reserved for operation-log array-element tokens.
  - Split suffixes `#k` may repeat (up to 8 levels).
  - The one canonical resolver is `resolveEntityIds(table, kind, ids) -> {indices, unknown}` from `@amp/geom`. It never throws, and matches the exact id, split pieces at any depth, and parent links. `@amp/spec` `checkSelections` takes it injected.
- 2026-11-06 16:21 PST, from L10 materials (DevLog-013 s.5):
  - C1: zod 4.6.7 and yaml 2.9.1 are approved for `@amp/materials`.
  - `@amp/materials` owns the material-property types, including C, G, r_eo, mu, rho_e and dndT. L4 does not re-register them.
  - Queued for contracts v1 (L2 scope): a tensor override form in spec materials; basis vocabulary gains `paper_model_input` and `reference_correlation`; `materials/<id>` refs checked against library ids.
- 2026-11-06 16:21 PST, rights-tag vocabulary (from the L7c audit). The authoritative enum is in eval/schema (L8), defined as:
  - `cite_value`: numeric values cited with locator only.
  - `copy_with_attribution`: the licence permits copying source files into the repo, with licence and attribution kept.
  - `reference_by_hash`: data not redistributed; referenced by URL + revision + hash (the hash is required).
  - `copy_text`: verbatim prose allowed (rare; licence must permit derivatives).
  Same licence means the same tags (e.g. Code_Aster GPL-3.0 test files: `copy_with_attribution` in both SM-21 and SM-61). Other tags in use must be mapped to these four or added with a definition.
- 2026-11-06 16:27 PST, from L4 (DevLog-010 s.5):
  - zod 4.6.7 and `@amp/materials` are approved as dependencies of `@amp/physics`.
  - Readiness has no mesh, so mesh warnings go into `prepareRun` notes (accepted).
  - `sample()` keeps the mesh argument (already canonical).
  - Assigned to L2: expression BCs, T0 and time settings, physics-scoped BC types, material tensor overrides.
  - Assigned to L3: nested `refineUniform` and a curved tet10 cylinder mesher.
  - Assigned to L8: Richardson fallback on non-nested meshes.
  - Deferred to after M2: the C2 facet-block change; `facets2` stays until then.
- 2026-11-06 16:32 PST, metric-naming rule (from the L8 audit fixes):
  - Physics modules publish a documented result vocabulary (`RESULT_NAMES` in `@amp/physics`): `<physics>.<quantity>` (e.g. `acoustics.eigenfrequency`, `elastic.mises_max`, `heat.T`), with arrays for eigen and sweep results. Module-local names like `f_0` are not part of the contract.
  - Eval targets keep a case-level slug `metric_id` and map to engine output through `extract: {result: <RESULT_NAME>, index | at | select, reduce?}`. The mapping lives in the case, not in the module.
  - `sample` signature as implemented by L4: `sample(sol, field, points, {mesh})`. This changelog entry supersedes the 16:15 text.
  - Rights tag `cite_values` (plural, already used by 85 cases) is canonical, superseding `cite_value` in the earlier entry.
- 2026-11-06 16:38 PST, from L5 (DevLog-011 s.5):
  - C6 gains the worker messages `mesh` and `unavailable`, and the run options `meshScale`, `meshOnly` and `case` (defined in apps/web; to be moved to `@amp/spec` types in contracts v2).
  - C1: `three` 0.187.0 is approved as a runtime dependency of apps/web.
  - Interim (coordinator decision): when a hero spec has N/A materials, the browser uses the sourced inputs of the paired eval case, shows which case and its sources, and has a toggle. I1 is moving the real values into sims/ and linking each hero to its case in the spec, after which the SIM_CASE table goes away.
  - Assigned to L4 (follow-up after its audit): Nedelec field evaluation or H1 projection in `@amp/post`; `prepareRun` with an injected material library (no node alias); eigenmode normalization stated in the Solution.
- 2026-11-06 16:41 PST, from L9 (DevLog-012 s.5):
  - Approved: zod 4.6.7, yaml 2.9.1 and `@amp/spec` (workspace) for `@amp/agent`.
  - `@anthropic-ai/sdk` for apps/web is pinned exactly to 1.1.0 (published 2026-10-21; npm registry checked 16:41). Newer releases (1.6.0 of 2026-11-05) are too fresh under the two-week supply-chain rule. A newer pin needs a recorded reason (a feature the adapter requires) and a version at least two weeks old.
  - Memory uses its own `amp-memlog/0` log (noted).
  - Assigned to the next web pass: mount the chat panel per DevLog-012 s.6.1. Assigned to L4/L8: a Node `StudyRunner` over `@amp/physics` for the agent task suite. L2, optional: `renameId`, `applyText`.
- 2026-11-06 17:07 PST, from L4 (DevLog-010 s.7.5):
  - C5 Solution gains the optional fields `notes` (mesh warnings, readiness) and `normalization` (eigenmodes).
  - The harness runs readiness after prepareRun (L8).
  - Eval cases may set `convergence.h_factors` (e.g. [1, 0.5, 0.25]) and per-target expected orders (I1 for classes a and b).
  - `@amp/physics` no longer depends on `@amp/post` (accepted).
- 2026-11-06 22:56 PST, from R0 (DevLog-025):
  - C3: `results` is a grouped object `{datasets, evaluations, tables, plots}` that mirrors the model tree (Wentao, DevLog-023 s.5.1 Q1), replacing the flat list. New contract C10 (above) defines the node kinds, dataset compatibility, the expression vocabulary and value artifacts keyed by (node hash, run id). No export nodes (s.5.1 Q2): `exports` is reserved and rejected.
  - Migration: every `sims/*.yaml` with results (35) and the 6 spec test fixtures, by `packages/spec/scripts/migrate-results.ts` (rerunnable, comment-preserving). No eval case embeds a spec (all reference `sims/` or are pending), so none changed. Provenance keys into legacy results were rewritten (`results.T_E.at` -> `results.datasets.T_E_pt.points.0`, 3 files).
  - Readers: `headlineItems`, `surfaceItems`, `resultUnits`, `resultNodes` in `@amp/spec`; apps/web headlines, Graphics, tree, Play, the parametric single-run rewrite and the agent digest / `list_entities` use them. `packages/eval` does not read spec results (no change).
  - `ValidateOptions.resultDims` (optional): a resolver of physics result dimensions; requested from L4 / R1 so field expressions get unit checks.
  - JSON Schema size bound of the spec tests: 41053 -> 65536 B (62947 B with the results model).
- 2026-11-06 23:45 PST, from R3 (DevLog-028):
  - C6: the post worker gains the results message set (defined in `apps/web/src/lib/results/api.ts`, to move to `@amp/spec` types in contracts v2): `results:run {key, solution, mesh, params}` (the worker holds up to 4 runs, LRU; key = `runId` of the C5 run record), `results:drop {key}`, `results:table {spec, id, runs}` (evaluation group or table -> rows x columns), `results:dataset {spec, id, expr, unit?, run, step?}` (points, arc length, values), `results:nodal {spec, expr, unit?, dataset?, run, step?}` (an expression at every mesh node), `results:adhoc {spec, q, runs}` (a temporary item, nothing stored). Replies `results:ok | results:table | results:dataset | results:nodal`, errors as the existing `error`. Tables and dataset values are cached by `artifactKey(resultNodeHash, runId)` (C10): a results edit recomputes only the nodes whose hash changed. The existing messages are unchanged.
  - C8: extract kind `result` (additive; `eval/schema/amp-eval-0.schema.json` enum + `node`, `step`): `extract: {kind: result, node: <evaluation item id>, step?, index?}` evaluates an evaluation item of the case spec's `results` on each level with the results adapter (`apps/web/src/lib/results/adapter.ts`, @amp/post kernels; loaded by path in the engine worker), SI value converted to the target unit. `index` = point of a point item with several points. No case uses it yet; class a unchanged.
  - Agent tools (C7 actors unchanged): `evaluate`, `get_table` (read-only, through the host's `ResultsHost`), `show_plot` (navigation; `NavigationHost.showPlot?(id)`, recorded in the trail). No `export` tool (DevLog-023 s.5.1).
