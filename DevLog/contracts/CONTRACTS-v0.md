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

## C11 Couplings (multiphysics; DevLog-029 s.3.1, 2026-11-07)

Spec (C3, unchanged keys): `couplings: [{id, type, from: <physics id>, to: <physics id>, settings?}]`; the study lists every physics it solves (`studies[].physics`). All physics of a study share one mesh; each physics keeps its own `select`.

Coupling types (registered with `kind: 'coupling'`, `for: [from type, to type]`; owner in brackets):

| type | from -> to | kind | carries |
|---|---|---|---|
| `joule-heating` [MC] | currents -> heat | sequential | per-cell Q = J . E (W/m^3) |
| `thermal-expansion` [MC] | heat -> elastic | sequential | nodal T, `settings.Tref` (quantity, K) |
| `thermo-optic` [MO] | heat -> em-modes | sequential | nodal T, per-material dn/dT (property `dndT`, 1/K), `settings.Tref` |
| `electro-optic` [MO] | electrostatics -> em-modes | sequential | nodal V (E = -grad V at quadrature points); Pockels tensor (material property `r_eo`, m/V); output dneff/dV, VpiL |
| `piezoelectric` [MT] | elastic -> electrostatics | monolithic | coupled u, V (eigen and stationary) |
| `acoustic-structure` [MT] | elastic -> acoustics | monolithic | coupled u, p (eigen) |
| `optomechanical` [MOM, DevLog-034] | elastic -> emw-axisym | monolithic | both eigen solutions (optical E_rphiz, mechanical u) on one meridional mesh; outputs g0 / gOM per optical x mechanical mode pair (`g0_<i>_<j>`, `g0MB_`, `g0PE_` in Hz as g0 / 2 pi; `gOM_`, `gOMMB_`, `gOMPE_` in Hz/m), `meff_<j>`, `xzpf_<j>` |

```ts
// packages/spec/src/types/physics.ts (MC adds)
interface CoupledInput { coupling: string; from: string; kind: string; data: Record<string, unknown> }  // kind = coupling type
interface RunContext { /* C4 */ inputs?: CoupledInput[] }                 // filled by the driver for downstream physics
interface FieldData { /* C5 */ physics?: string }                          // physics id; set by the driver on merged solutions
// packages/physics/src/couplings/core.ts (MC)
interface CouplingImpl {
  type: string; from: string; to: string;                                  // physics types
  kind: 'sequential' | 'monolithic';
  map?(a: { up: Solution; upId: string; down: RunContext; node: CouplingNode }): CoupledInput;           // sequential
  run?(a: { ctx: Record<string, RunContext>; node: CouplingNode }): Promise<Solution>;                   // monolithic
}
export async function runStudy(prep: RunContext, opts?): Promise<Solution>;  // driver (MC): topological order, merge
```

Rules:
- `runStudy` with one physics and no couplings is exactly the old single-module run (same Solution, no tags required).
- Merged Solution: fields carry `physics`; scalars keyed `<physics id>.<name>` when the study has more than one physics (also kept unprefixed when the name is unique); `stats`/`timing` keyed per physics; `run` is one record.
- Post resolves `<physics id>.<name>` against `FieldData.physics` (untagged fields belong to the study's single physics).
- A coupling node whose implementation is missing is a readiness reason, never a silent skip.
- Each lane registers its coupling types from its own file (`couplings/core.ts`, `couplings/photonic.ts`, `couplings/twoway.ts`); `couplings/index.ts` (MC) concatenates `CORE_COUPLINGS`, `PHOTONIC_COUPLINGS`, `TWOWAY_COUPLINGS`, `OPTOMECH_COUPLINGS` (MOM, `couplings/optomech.ts`) and the matching `*_REGISTRATIONS` (and `CORE_NEEDS`, `PHOTONIC_NEEDS`, `OPTOMECH_NEEDS` into `COUPLING_NEEDS`).

## Changelog

- 2026-11-07 08:3x PST, coordinator: C11 couplings added (DevLog-029). Owners: MC = DevLog-031, MO = DevLog-032, MT = DevLog-033.
- 2026-11-07 08:46 PST, from MC (DevLog-031), C11 as implemented (additive; no rename of C11 names):
  - Types: `CoupledInput`, `RunContext.inputs?`, `FieldData.physics?` as in C11; also `Solution.stats.byPhysics?` (per-physics stats of a merged solution, keyed by physics id, `a+b` for a monolithic group).
  - `runStudy(prep, opts?: {studyId?, modules?, couplings?, progress?, signal?})`; also exported: `studyReadiness(spec, studyId?, opts?) -> {ready, reasons, order}` (module readiness + coupling checks; used by the web runner) and `planStudy`. Couplings take part when `to` is solved by the study; `from` not solved = readiness reason.
  - Merged Solution: timing keys `<physics id>.<stage>` plus stage sums, the prepareRun stages once, `<physics id>.couple` for the map time; `stats.solver` = `<pid>: <solver>; ...`; `run` = the first physics' record with the driver's `startedAt`; at most one distinct `steps` among the physics (else an error); `notes` concatenated (de-duplicated, not prefixed); `normalization` merged as `<physics id>: <text>` per solve group (ids joined by `+` for a monolithic group), groups joined by `; ` (as amended in the 2026-11-07 audit-fix entry).
  - Monolithic `run()` results: untagged fields are tagged `node.from`; scalar keys not starting with one of the group's physics ids are prefixed `node.from`.
  - `thermal-expansion` settings key is `Tref` (C11), replacing the provisional seed's `T_ref`. Elastic cells outside the heat domain get alpha 0 (noted). `joule-heating` data: `{Q: Float64Array per cell}`; `thermal-expansion` data: `{alpha per cell, T nodal, Tref, notes}`.
  - New physics `currents` (2d, 2d-axisym, 3d) with BCs `ground`, `potential`, `terminal` (`V` or `I`), `insulation`, scoped to `currents`; `sigma` resolved by prepareRun. prepareRun resolves materials for the union of the physics types of the chosen study and takes an optional `studyId`.
  - `@amp/post`: `fieldOf(sol, name, step?, physics?)`; `sample` takes `physics` or a `<pid>.<name>` field; a bare field name carried by several physics is an error.
- 2026-11-07 09:2x PST, from MC (DevLog-031 s.6; requests of MO DevLog-032 s.4.1, MX DevLog-035 s.6, MT DevLog-033 s.5):
  - Registry: `physicsRegistry()` = wave-1 seed, then `registerMaterialProperties` (@amp/materials; seed bounds kept), then the @amp/physics registrations; a property both register (MT's `C`, `e_piezo`, `eps_r`) is merged (tensor symmetries unioned, scalar allowed when either allows it) and marked settled (not provisional). @amp/materials `C` takes cubic, hexagonal-6mm, tetragonal-4mm, trigonal-3m; new property `e_piezo` (C/m^2; 6mm, 4mm, 3m); `PropertyDef.components` per symmetry; `tensorMatrix(sym, c, prop?)` with the matrix forms of `@amp/physics` `coupled/tensors.ts`.
  - Registrations: elastic dims + `2d-axisym`, `settings.model` + `axisym` (checked against the geometry space); electrostatics dims + `3d`; em-modes `settings.crystals`; currents `settings.outOfPlane {Ez | V + length | I}` (2D section driven along z); `RESULT_NAMES` heat + `Q_total`, elastic + `srr sphi srz f_<k>`, em-modes + the coupled names of MO, currents + out-of-plane scalars, `piezoelectric`, `acoustic-structure`.
  - `CouplingImpl.readiness?(spec, node): string[]`; `studyReadiness` skips the single-module readiness of physics in a monolithic group and calls the coupling's. A study whose solve groups would produce more than one step set (e.g. electrostatics with several terminals + em-modes) is a readiness reason. `COUPLING_NEEDS` = core + `PHOTONIC_NEEDS`.
  - prepareRun: tensor overrides and library tensors flattened to `rec['<prop>.<component>']` (SI); library `n`, `dndT` at the mode-study wavelength, `dndT` at the thermo-optic `Tref`; coupling needs pulled (thermo-optic `dndT`; optional `r_eo`, piezo `C`, `e_piezo`, `rho`: no note when absent); elastic `rho` in eigen studies and acoustic-structure groups.
  - Heat scalar `Q_total` (integral of the volume sources; W/m in 2D planar, W otherwise; only when a volume source exists). `@amp/post` `fieldOf`: a step-less field of one physics in a merged solution holds for every step of the other physics.
- 2026-11-07 08:51 PST, from MO (DevLog-032), C11 photonic couplings as implemented (additive):
  - Property names are the registered `@amp/materials` names `dndT` (1/K, scalar or uniaxial perp / par) and `r_eo` (m/V, trigonal-3m r13 r22 r33 r51); C11's `dn_dT` reads `dndT`.
  - `thermo-optic` (heat -> em-modes) settings: `Tref` (K, required), `power` (W/m, optional: heat input per length of the 2D heat solution; enables Ppi), `crystals` (optional). Data: `{T nodal (Tref outside the heat domain), space, Tref, power?, powerSource?, crystals?, notes}`.
  - `electro-optic` (electrostatics -> em-modes) settings: `armB: none | mirror | ideal` (required: the push-pull convention is stated, never assumed), `mirrorX` (m, for mirror), `terminal` (an electrostatics terminal id: its 1 V solve) or else the `V_applied` solve with `voltage` (V) or V_t = max(V) - min(V), `direct` (boolean, default true), `crystals`. Data: `{V nodal, space, Vt, VtSource, armB, mirrorX?, direct, crystals?}`.
  - `crystals: [{material, cut, propagation, rotation?}]` (lab y = film normal = crystal `cut`, lab z = `propagation`, rotation = CCW rotation of the lab frame about z; eo-modulator-atlas E2 frame). Accepted in either photonic coupling's settings and in em-modes `settings.crystals` (the latter needs MC to add the key to the em-modes registration).
  - em-modes reads `RunContext.materials` flat keys `n` | `n.perp`, `n.par` (uniaxial, needs a crystal) | `eps_r`; `dndT` | `dndT.perp`, `dndT.par`; `r_eo.r13` .. `r_eo.r51` (requested from MC: prepareRun flattens tensor values to `<prop>.<component>`).
  - em-modes result names added by the coupled path (per mode k; unprefixed copies for k = 0): `neff0_<k>`, `dneff_<k>` (direct), `dneffPert_<k>` (first order), `dphidz_<k>` (rad/m), `Ppi_<k>` (W); `dneffdV_<k>` (1/V, first order, arm A), `dneffdVdirect_<k>` (central difference of two re-solves), `dneffdVB_<k>` (arm B), `VpiL_<k>` (V*m, lambda / (2 |dn_A/dV - dn_B/dV|), V = full terminal voltage V_t), `VpiLsingle_<k>` (V*m, lambda / (2 |dn_A/dV|)). Conventions in `packages/physics/src/modes/coupled.ts` header.
  - `photonic.ts` exports `PHOTONIC_NEEDS` (`thermo-optic`: to `dndT`) for `COUPLING_NEEDS`.

- 2026-11-07 09:10 PST, from MT (DevLog-033), C11 two-way couplings and solid modal / axisym elastic as implemented (additive):
  - `elastic`: eigen study -> solid modal analysis (plane stress / strain, 3D, axisym); `settings.model` gains `axisym` (default on an axisymmetric mesh) and the physics dims `2d-axisym` (the registration change is requested from MC, DevLog-033 s.5 R1). Eigen outputs: `u` per step, `steps {kind: eigen, Hz}`, scalars `f_<k>` (rigid modes reported as 0), `Solution.normalization` set by the solver. Axisym stationary outputs: `u` (u_r, u_z), `srr`, `szz` (axial), `sphi`, `srz`, `mises`, `s1..s3`, `mises_max`, `u_max`; thermal input as the planar models.
  - `piezoelectric` (elastic -> electrostatics, monolithic): orientation by `settings.crystals` (the em-modes / electrostatics `crystalsSchema`: per material cut / propagation / rotation, merged with the electrostatics physics' crystals; user-facing) or `settings.euler` (advanced: 3 angles, ZXZ, R = Rz(phi) Rx(theta) Rz(psi) maps crystal-frame to model-frame components, every material); exactly one (amended 2026-11-07 09:17 PST, coordinator decision). Electrodes from the electrostatics BCs: `ground` V = 0, `potential` V fixed (homogeneous in eigen), `terminal` = floating electrode (one DOF, net charge 0: open circuit), `zero-charge` natural. Eigen and stationary studies; 3d and plane-strain. Outputs: `u` (tag = from), `V` (tag = to, NaN off the dielectric), eigen `f_<k>`, `V_<terminal>_<k>`; stationary `V_<terminal>`, `Q_<electrode bc id>` (C, C/m in 2D; `Q_ground` for the ground set), `u_max`.
  - `acoustic-structure` (elastic -> acoustics, monolithic): unsymmetric u-p form, eigen only; wet interface = faces shared by elastic and acoustics cells; acoustics walls `sound-hard` or `pressure` (p = 0). Outputs `u` (tag = from), `p` (tag = to, NaN off the fluid), `f_<k>`; a closed cavity gives an f = 0 pair.
  - Material properties registered (provisional, until `@amp/materials` adopts them): `C` (Pa, tensor only: `hexagonal-6mm` C11 C12 C13 C33 C44; `tetragonal-4mm` + C66; `trigonal-3m` C11 C12 C13 C14 C33 C44; `cubic` C11 C12 C44), `e_piezo` (C/m^2, tensor only: `hexagonal-6mm` / `tetragonal-4mm` e15 e31 e33; `trigonal-3m` e15 e22 e31 e33), `eps_r` gains the `uniaxial` tensor form (perp, par; as in `@amp/materials`; piezoelectric materials give the clamped eps^S). Matrix forms and axis conventions: `packages/physics/src/coupled/tensors.ts` header. The couplings read tensor overrides from the spec or the flattened `<prop>.<component>` keys of `RunContext.materials`; a solid without `C` uses its isotropic E, nu.
  - `CouplingImpl` objects of MT carry an optional `readiness(spec, node): string[]` (requested as part of the interface, DevLog-033 s.5 R3).
  - 2026-11-07 09:38 PST additions: elastic `fixed` accepts `pnt:` selections (nodes from `Mesh.pointNode`); new elastic BC `displacement` (`bnd` / `pnt`, settings `ux`, `uy`, `uz`, any non-empty subset); `roller` on a point is an error. Elastic on hex8 is an error; 3D box-union hex8 meshes are split into tet10 by `elastic/hex2tet.ts` `hexToTet10` (call site in prepareRun requested from MC). Acoustic-structure solutions carry `detail.closedRegions` and a note: each closed fluid region (no p = 0) adds one f = 0 mode of the u-p form.

- 2026-11-07 10:21 PST, coordinator, audit fixes (fresh-context audit of the uncommitted multiphysics work; applied by lane FC, DevLog-035 s.13):
  - C11 table: `optomechanical` row added (elastic -> emw-axisym, monolithic, carries both eigen solutions; g0 / gOM per mode pair; owner MOM, DevLog-034). Thermo-optic property name `dndT` (was `dn_dT`). Electro-optic carries the nodal V of the electrostatics solve, E = -grad V evaluated at the quadrature points (was "E field per cell").
  - Rule: `couplings/index.ts` also concatenates `OPTOMECH_COUPLINGS` / `OPTOMECH_REGISTRATIONS` (and `OPTOMECH_NEEDS` into `COUPLING_NEEDS`).
  - Merged Solution (`packages/physics/src/driver.ts`): `notes` are concatenated and de-duplicated, not prefixed; only `normalization` is prefixed (`<physics ids joined by +>: <text>`, groups joined by `; `). The 08:46 MC entry is corrected accordingly.
  - prepareRun: library `n` and `dndT` are evaluated at the mode-study wavelength also for single-physics mode studies (not only in coupled studies), so wavelength-dependent library values can differ from the earlier lambda-free evaluation (`prepare.ts`).
  - Electro-optic one-terminal limit: the coupling uses one electrostatics solve, so the `from` electrostatics physics must have exactly one terminal condition (`settings.terminal` selects its 1 V solve; absent = the applied-potential solve); more than one terminal is a readiness reason (`studyReadiness`), since several terminals give one solve per terminal (param steps) that the coupling cannot use.

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
- 2026-11-07 09:31 PST, coordinator: C2 adopted from MG (DevLog-036): G1 difference footprints add `bnd:<tool entity>` to `parent` of a final boundary lying entirely on that tool's edges inside the target (both owners' names select the shared piece); G2 box-grid min-side faces with several pieces are numbered over all pieces, exterior remainder first as `<box>.<dir>#1`, interface pieces list `bnd:<box>.<dir>#k` in parent; `<box>.<dir>` still selects every piece. G2 changes tagHash of affected box-grid meshes. Electrostatics: uniaxial eps_r tensors with `settings.crystals` (registration added by coordinator per MG R-MC-1); 3D capacitance unit F.
- 2026-11-18 09:18 PST, coordinator (chunk 1, DevLog-037):
  - C6: `RunOptions.studyId` (optional) selects the study a run solves; default stays the first study (T3, DevLog-040).
  - C8 (T2, DevLog-039): a case `spec` may be `{sim: sims/<id>.yaml, params, study}`; units with a parenthetical note (e.g. `1 (c/a)`) parse as the bare unit; extract kind `combine` computes one target from targets run on different sims; pending specs carry `ref` (sims file exists) or `proposed` (planned path); the loader errors on a missing spec path and warns on ref/proposed mismatches; round-off-sized level-to-level changes count as zero in the fallback rule; `pi` in expressions; CLI `--skip ID,ID`.
- 2026-11-18 09:20 PST, coordinator: material property types added by T4 (DevLog-041), registered through `registerMaterialProperties`: `p_pe` (photoelastic tensor, Voigt 6x6, cubic or trigonal-3m, unit 1), `kappa` (extinction coefficient, N = n + i kappa), `Tg` (glass transition temperature, K), `tcr` (temperature coefficient of resistance, 1/K). Formulas `cauchy`, `sellmeier-general`, `li1980-eq22`. API `dispersion(lib, id, lambda)` and `complexIndex(lib, id, lambda)`.
- 2026-11-18 09:23 PST, coordinator: em-modes settings added by S2 (DevLog-043), all optional and off by default (existing results bitwise unchanged): `loss` (eps = (n - j kappa)^2 from material n, kappa), `dispersion.dndlambda.<material>` (scalar or {perp, par}, 1/m; n_g through eps_g = n (n - lambda dn/dlambda)), `pml: [{select, strength, power, x, y}]` (complex coordinate stretching), `bend: {radius, x0, model: metric | conformal}` (bend in x-z, axis along y). Result scalars `kappaEff_<k>`, `Lprop_<k>`, `bendLossDbPer90_<k>`. Kernel option `transform`.
- 2026-11-18 09:26 PST, coordinator: driven 2D Helmholtz from S1 (DevLog-042). C4: physics type `emw-2d` (settings.polarization TM = Ez out of plane, TE = Hz), registered in `modules`; `acoustics` with a `frequency` study runs the same solver. Conditions: `pml` (domains; R0, order), `plane-wave` (scattered-field background; direction, amplitude), `port` (nModes, excite, power), `scattering`, `impedance` (EM Zs or sigma; acoustic Z), `normal-velocity`, `pec`/`pmc` for emw-2d. Study `frequency` accepts `values` (Hz) or `wavelengths` (m), exactly one. Steps kind `freq`. C5: complex fields as `<u>_re`, `<u>_im`, `<u>_abs` (`_sc_` for scattered), DG0 derived vectors; per-step scalars suffixed `_<step>` when a study has several frequencies; extra Solution property `wave2d` (per-frequency S matrix with keys, port betas, far field sigma(phi)). The wrapper now keeps a module's own `normalization` statement and adds the per-type one only when absent.
- 2026-11-18 09:28 PST, coordinator: C2 `extrude` geometry feature from S3 (DevLog-044): `settings: {z0, layers: [{id, thickness, sketch: [<2D feature ids>], nz | dz}]}`; in a 3D geometry, 2D features act as sketches. One merged 2D mesh swept through the layers (conforming interfaces; tet4 by the Dompierre 1999 minimum-global-index split; tet10 lifted from the quadratic 2D mesh, mid-nodes exact on circles). Names: domains `dom:<2D domain>.<layer>` (`dom:<2D domain>` = all layers, `dom:<stack>.<layer>` one layer, `dom:<stack>` all); side walls `bnd:<2D boundary>.<layer>`; caps `bnd:<D>.<layer>.top` / `.bottom` (the lower domain owns an interface; a split face is numbered exterior first); `bnd:<stack>.top` / `.bottom` outer caps. Mixed boxes and z-axis cylinders mesh as stacks and keep their primitive names; overlapping solids and x/y cylinders mixed with other solids still error, pointing to `extrude`.
- 2026-11-18 09:36 PST, coordinator: S4 (DevLog-045): stationary study `settings.solver` (`direct` default, `amg-pcg`, `auto`: AMG-PCG when the direct factor costs >= 3e5 flop per DOF or > 1 GiB) and `settings.rtol`, for heat, electrostatics and currents; solver, rtol, iterations and residual in Solution `stats` and a `notes` line. Core: WASM real triangular solve (Cholesky and LDL^T, one or many right-hand sides; bitwise identical to JS; JS fallback); `blockPattern` / `blockElementSlots`; common `cellBlockSlots` / `facetSlots`.
- 2026-11-18 09:41 PST, coordinator: I1 (DevLog-046): prepareRun binds library `kappa` for em-modes `loss` (optional; absent = lossless) at the mode wavelength; `dn_dlambda` (or `.perp` / `.par` for uniaxial n) for em-modes `dispersion`, with provenance notes (piecewise-linear or extrapolated slopes flagged); emw-2d reads eps_r, tan_delta, mu_r, n, kappa (all optional) at lambda = c0 / f for a single-frequency study (several frequencies: one lambda-free evaluation plus a note). `MaterialLibrary` gains optional `get` and eval options `component`, `alternative`, `extrapolate`. em-modes settings `dispersion.library.<material>: {alternative?, extrapolate?}`.
- 2026-11-18 10:00 PST, coordinator: emw-2d / acoustics frequency (F1, DevLog-042 s.7): with ports and volume or boundary sources, S-parameters come from source-free solves; scalar `P_src_<i>` (W/m) is the power the sources alone send out of port i; field output = excited-port field + source field. C2 (F3, DevLog-044 s.7): a side face shared by two solids is selected by both solids' face names (with or without the layer suffix); stack id `solids` is reserved for stacks built from solids.
- 2026-11-18 10:15 PST, coordinator: em-modes (F2, DevLog-043 s.8): lossy media use the complex eps_g = N (N - lambda dN/dlambda), N = n - j kappa; setting `dispersion.dkappadlambda.<material>` (1/m; absent = 0 with a note); result scalar `pmlFraction_<k>` (field energy fraction in PML regions); without `neffShift` the default shift uses non-PML cells and modes under half PML energy rank first; confinement, powerW and transverse H use the transformed permittivity and permeability weights. Kernel option `epsGIm`, export `PML_FRACTION_MAX`.
- 2026-11-18 13:43 PST, coordinator: agent (E7, DevLog-053): navigation tools `cancel_run`, `select_sweep_point`, `probe`, `quick_view` (optional `NavigationHost` methods `cancelRun`, `sweep`, `selectSweepPoint`, `probeAdd`, `probeList`, `probeRemove`, `quickView`, `setQuickView`; a host without them answers `<tool>_unavailable`; recorded in the trail); `set_camera` preset and look_at (look_at takes a `preset` direction) through `apps/web/src/lib/gfx/camera.ts` `setCameraPreset`; `run_study.study` optional, default `StudyRunner.defaultStudy?()` (workbench study picker), else the first study.
- 2026-11-18 13:50 PST, coordinator: E9 (DevLog-055): C8 Richardson fallback passes only on refined levels (DOF strictly growing, else h strictly decreasing; reason "levels not refined"); C8 expr term kind `result` (schema terms description updated); `@amp/post` `recoverDG0(mesh, field)` and `{smooth: true}` in `interpolate`, `sample`, `ExprOptions` (DG0 fields read through area-weighted nodal recovery per domain; for line / point datasets); `@amp/geom` `buildGeometry2D` merges curved keepTools pieces (option `mergeCurvePieces`, default true; export `mergeEdgePieces`, `MergeEdgeOptions`): meshes of coplanar-rings, nafems-t1-hotspot, phc-point-defect, phc-square-rods-lower / -upper changed.
- 2026-11-18 14:03 PST, coordinator: agent (E7, DevLog-053, addendum): tools `edit_tree` {op: add | delete | duplicate | rename, parent?, type?, pointer?, id?, reason} and `define_sweep` {id, study?, axes?: [{param, values?, start?, stop?, n?, unit?}], remove?, reason}, through the optional `ModelEditor` interface (packages/agent/src/edits.ts; web: apps/web/src/lib/agent/editor.ts over the workbench edit builders); each edit is one undoable agent op. Tool-definition size bound raised 16,000 -> 17,000 B (29 tools, 16,830 B).
- 2026-11-18 14:06 PST, coordinator: E8 (DevLog-054): eigen study settings `solver` (`direct` default | `ams` | `auto`: AMS when the direct factor would exceed 300 MiB; 3D electromagnetic eigen solve; ams finds the lowest modes only, a shift above them is refused) and `rtol`; C5 `RunRecord.solver?: SolverRecord & {byPhysics?}`, `SolverRecord {kind: direct | amg-pcg | ams-pcg; rtol, iterations, residual: number | null}` (type only; producers to follow); complex LDL^T triangular solve in WASM (bitwise identical to JS, JS fallback); web `EngineClient.runSweep(jobs, onPoint?, workers?)` worker pool, outcomes in sweep order.
- 2026-11-18 14:09 PST, coordinator: E2 (DevLog-048): prepareRun binds library `dkappa_dlambda` per lossy `ref:` material when an em-modes physics has `loss` and `dispersion` (central difference, provenance note); `Prepared.materialsAt(lambda, notes?)` returns the bound material table re-evaluated at another vacuum wavelength (cached, copy); em-modes rejects a lossy solve given `epsG` without `epsGIm` (kernel and solveModes); eval-case property fill: tensor components (`n.perp` / `n.par`) count as present, optional properties are filled only from the same material id.
- 2026-11-18 14:10 PST, coordinator: E4 (DevLog-050): bc `periodic` (emw-2d; select both opposite sides of one pair; optional setting `k` = k.a / 2 pi for eigen studies and source-driven frequency runs); the mesher gives both sides of each periodic pair the same nodes (2D; `mesh2d` option `periodic`, read by `meshFromSpec` from the physics conditions; meshes of specs without periodic conditions unchanged; the prepareRun mesh cache key includes the periodic selections). Study `bands` (settings `kPath` [{label, k: [k1, k2]}] in units of the reciprocal lattice vectors of the periodic conditions in listed order, `interpolate` (default 4), `nBands` (default 8)); emw-2d also runs the `eigen` study (closed PEC / PMC cavities, periodic cells at the conditions' k). emw-2d frequency studies with a plane wave and periodic conditions solve a Floquet cell (Bloch phase from the incident wave). Results: scalars `f_<b>` (eigen), `f_<b>_<k>`, `fmax_<b>`, `fmin_<b>` (Hz), `kx_<k>`, `ky_<k>` (1/m); fields `Ez_*` / `Hz_*` (re, im, abs) per field step, steps kind `eigen`; extra Solution property `wave2d.bands` = {labels [{index, label}], k (1/m), kReduced, distance (1/m), f (Hz, per k per band), lattice {a, b}, fieldSteps [{step, label, k, band}]}. A scattering condition next to a non-background cell under a plane wave is rejected; ports in a periodic cell are rejected. @amp/mesh exports `periodicSides`, `pairPeriodicNodes`, `periodicSelections`, `FLAT_TET_DEG` (flat-tet warning in layered 3D meshes below 5 degrees, a design threshold).
- 2026-11-18 14:23 PST, coordinator: web (E6, DevLog-052): Solution extras `wave2d` and `notes` typed in `apps/web/src/lib/engine/protocol.ts` (`wave2dOf`, `notesOf`); wire format unchanged. View state in the link: hash parameter `v=` (`gfx/view-link.ts`), added to Share links. Camera API `gfx/camera.ts`: `CAMERA_PRESETS` (iso, top, bottom, front, back, left, right; z up), `setCameraPreset`, `hasCameraView`, `cameraPose`, `applyCamera`.
- 2026-11-18 15:12 PST, coordinator: chunk 2 audit fixes: emw-2d uses a library n over a library eps_r only when the run has a wavelength (driven runs at lambda = c0 / f, per frequency through materialsAt); eigen and bands studies use the library eps_r with tan_delta (note per material); Floquet cells whose envelope LU would exceed 1 GiB of factor storage are refused (design limit); eigen studies with `solver: ams | auto` are refused unless the study solves an emw physics; web sweeps are capped at 200 points (design limit) and idle sweep workers are disposed after 10 s.
- 2026-11-18 18:34 PST, coordinator: C2 (G8, DevLog-065): geometry consumption rule: a feature referenced by a boolean leaves the final geometry (difference tools with keepTools stay, or return when consumed earlier); it may be referenced again by later booleans, each reference using that feature's own shape; an input listed twice in one boolean is an error. Specs where every feature feeds at most one boolean are unchanged. Layer stacks name points `pnt:<2D point>.<layer>.bottom|top` for every named 2D point of each layer sketch (rect corners, polygon / polyline vertices, arc ends, boolean intersection points); at a plane shared by two layers the lower layer's `.top` name owns the point and the upper `.bottom` name selects it too; `pnt:<2D point>` selects that corner at every plane and `pnt:<2D point>.<layer>` both planes of a layer; `Mesh.pointNode` maps them to nodes (tet4 / tet10), so point constraints work on stacks. Mixed boxes / z cylinders and `edg:` stay without such entities. 3D tag hashes cover domain and boundary ids. Flat-tet warnings name the layer, the worst cell's width and height and the remedy. Mesh option `size.maxLayerAspect` (stacks, dimensionless, off when absent): layers whose z cell height dz gives maxLayerAspect * dz < hmax are refined in plane to h = maxLayerAspect * dz (the 2D mesh is shared, so thick layers over that area need more z cells). @amp/mesh exports nothing new from its index; `tetMinDihedralDeg` lives in quality.ts. Spec `mesh.size.maxLayerAspect` registered.
- 2026-11-18 18:50 PST, coordinator: C1 / C4 (G1, DevLog-058): materials item gains optional `T` (temperature quantity, > 0 K). prepareRun evaluates the library tables / fits of a `ref:` material at its node T, else at the run temperature (CaseCtx.T), else without a temperature (T-dependent leaves then absent with a note, as before); overrides win at any T; the thermo-optic Tref still sets dndT. Provenance note per material with a node T; materialsAt keeps the node T (cache key lambda and run T).
- 2026-11-18 18:50 PST, coordinator: C5 / post (G2, DevLog-059; producer by G3): optional `FieldData.elementNodal` (element values at each cell's nodes before averaging, index (cell*k+a)*nc+j) for derived elastic stresses; @amp/post `recoverPerDomain`, option `derived: 'recovered' | 'element' | 'averaged'` on interpolate / evaluateField / sample / ExprOptions / integrate / extrema; default: per-material recovery at interface nodes (bitwise unchanged for fields without interfaces or without elementNodal).
- 2026-11-18 19:12 PST, coordinator: G4 (DevLog-061): C8 extract kind `resonance` {name (per-step scalar), power?, shape: peak | dip, baseline? (dip, default 1), axis: wavelength | frequency, window: [lo, hi], window_unit, scan? (default 13), output: center | fwhm | q | peak | center_halfmax | fwhm_halfmax | q_halfmax, tol? (default 1e-3), max_iter? (default 6)}: per mesh level the harness re-solves the target's frequency study at chosen points (study `wavelengths` or `values` replaced), coarse scan, Lorentzian refinement through a quadratic fit of 1 / p, secant half-maximum crossings; one search per level and definition, shared by targets; centre / width converted from the window unit; per-level `diag` (solves, iterations, centre change, fit residual, search time) in the target record (`levels` also kept for single-level targets with diagnostics). `@amp/eval` exports `nameDeclared(names, x)` (RESULT_NAMES wildcard rule). emw-2d / acoustics-frequency result names: higher port modes `S<i><j>_<p><q>_{re,im,abs,dB,phase}` and the step-suffixed `<name>_<s>` of every frequency-study scalar (several frequencies in one study).
- 2026-11-18 19:36 PST, coordinator: C5 (G3, DevLog-060): RunRecord.solver is filled by withStudySolver (heat, electrostatics, currents, elastic outside eigen studies; every run, with or without a study setting) and em3d; merged studies carry byPhysics keyed like stats.byPhysics. Stationary study `solver` now also applies to elastic (smoothed-aggregation AMG with the rigid-body near-nullspace, P2 -> P1 two-level step for tri6 / tet10). Symmetric shift-invert eigen solves run a Sylvester inertia completeness check (option `check`, default auto: factors up to 8e6 stored entries; on a miss up to 3 reruns, then status missed and a note). Option `AMP_TET_QUADRATURE=matched` / `setTetQuadrature` (default collapsed, unchanged).
- 2026-11-18 20:47 PST, coordinator: chunk 3 audit fixes (DevLog-066): C5 FieldData gains optional `cellGroup?: Int32Array` (derived fields with `elementNodal`): constitutive group per cell, equal values = same material constants, -1 outside the physics. @amp/post recovers derived fields per group at interface nodes and falls back to `cells.domain` when it is absent (additive; elastic and axisymmetric elastic producers fill it). @amp/post `evalGlobal(sol, expr, {step})`: on a frequency study with several frequencies `<name>_<step>` is resolved first (DevLog-061 R1). The web display copy (apps/web post field2d withPerDomain) uses the same cellGroup rule.
