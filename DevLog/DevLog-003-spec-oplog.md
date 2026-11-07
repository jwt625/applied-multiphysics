# DevLog-003: model spec, YAML I/O and operation log (lane L2, `@amp/spec`)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L2 (DevLog-001 section 9) |
| Owns | `packages/spec/**`, `sims/**`, this file |
| Inputs | DevLog-001 sections 3-9 (A3, A4, A5, A11), CONTRACTS-v0 C2, C3, C5, C7; R1 s.2; R2 s.3; R5 s.4 |
| Sources (read only) | `eo-modulator-atlas` (EO) `engine/src/yaml-edit.mjs` at `5a06dfd` (last commit touching the file; repo HEAD `0546007`) |

## 1. Plan (written before coding, 2026-11-06 15:20 PST)

### 1.1 Schema technology: zod v4

Choice: zod 4.6.7 (MIT, zero dependencies, released 2026-10-12, more than two weeks old), pinned exactly, runtime dependency of `@amp/spec` only (pre-approved by the coordinator).

| Need | zod v4 | Hand-rolled builder |
|---|---|---|
| One definition gives static types | `z.infer` | needs its own type-level inference machinery (most of the work) |
| JSON Schema export | native `z.toJSONSchema` (draft 2020-12) | write and test an emitter |
| Strict keys | `z.strictObject` | write |
| Precise error paths | every issue carries `path` | write |
| Registry composition at runtime | schemas are values; discriminated unions built from the registry | write |
| Metadata for agents (dimension, untrusted text) | `.meta()` lands in the JSON Schema | write |

The hand-rolled route reimplements zod's core for no gain; zod's cost is bundle size (to be measured, section 4).

### 1.2 Schema `amp-spec/0` (extends C3)

- Top level (strict): `schema, id, title, description?, params?, geometry, materials?, physics?, couplings?, mesh?, studies?, results?, provenance?, assumptions?, missing?`.
- Quantity forms: `{value: number|expr, unit}`, string `"2 mm"` (number + unit), string expression over params (`"2*a"`, `"a/10"`, units inside expressions as `2[mm]`, the `@amp/core/expr` grammar), or the literal `"N/A"`. A bare number is accepted only where the expected dimension is dimensionless. Every quantity field declares its expected SI dimension (`quantity('m')`, `quantity('W/(m^2*K)')`, `quantity('*')` for any); the dimension check covers literals and expressions (params are resolved first). `degC` is accepted as an affine absolute-temperature unit in literals only (exact offset 273.15 K by definition).
- Vector quantities: `{value: [..], unit}` or an array of scalar quantities.
- Selections: explicit lists of C2 entity IDs, grammar `^(dom|bnd|edg|pnt):<feature>(.<sub>)*(#k)?$`; each registered node declares which entity kinds it accepts; the feature prefix must be a geometry feature id. Runtime helper checks a selection against a built `EntityTable` (C2).
- Provenance per dotted path (`provenance.values`), carried over from EO `provenance.<path>.class` and APA `{value, status, ref}` / material `basis`: `{basis, status?, source?, locator?, date?, note?}`. Path segments may be array indices or element `id`s (`materials.steel.override.E`), so the record survives reordering. Every provenance path must resolve.
- `assumptions` and `missing` blocks. Every `"N/A"` value must be covered by a `missing` entry with that path (or a parent path).
- Registry (`createRegistry()`): kinds `feature`, `physics`, `bc`, `coupling`, `study`, `property`. Each registration is `{kind, type, settings: zod schema, select?: entity kinds, for?: physics types, dims?}`. `buildSchema(registry)` composes discriminated unions on `type`; `@amp/physics` registers without editing core files. Static types come from the generic (unregistered) form of the same builder. Provisional wave-1 registrations (needed so the six examples validate) live in `src/provisional/wave1.ts`, marked provisional, to be superseded by L3/L4.

### 1.3 YAML I/O

- Port EO `yaml-edit.mjs` to `packages/spec/src/yaml-edit.mjs` + `.d.mts` with the C1 port header. Planned changes: JSON-Pointer paths, sequence insert/remove splices, `prune` option on delete (off for the op log, so the text matches RFC 6902 semantics), alias-free parsing.
- `parseSpecText(text, registry)` returns `{ok, spec, errors}`, each error `{path, pointer, code, message, line, col}` (line/col from the YAML node range). YAML aliases and duplicate keys are errors.

### 1.4 Operation log (C7)

- `apply(patch, {actor, reason})`: RFC 6902 on the parsed spec (all six ops), inverse generated with guarding `test` ops, YAML text updated by splice and verified by re-parse, text delta `{at, del, ins}` recorded so undo restores the text byte for byte, validation result, invalidation set, spec hashes, hash chain (sha-256, WebCrypto `crypto.subtle` in browser and Node).
- Undo/redo: append the inverse (or the original) of the top op with its exact inverse text delta. Revert(seq) of an older op appends its inverse, applied by splice (conflicts detected by the `test` ops).
- Agent actors (`agent:<session>`) require `reason`.
- Invalidation rules by path (geometry > mesh > solution > plots), params traced through expression references.
- JSONL: a genesis line (initial text, its hash) then one op per line; `replay()` verifies the chain and every hash.
- Untrusted text: every string read from a loaded model is untrusted for prompts; helper lists free-text paths and wraps data in delimiters that cannot be closed from inside.

### 1.5 Run records (C5) and hashing

`canonicalJson` (sorted keys, RFC 8785-style number formatting), `specHash`, `sha256Hex`, `isoNow()` with offset, `probePlatform()`, `makeRunRecord()`.

### 1.6 Units

Code against an interface matching `@amp/core/units` (`parseUnit -> {dim, factor}`, `dimEq`, `formatUnit`) and `@amp/core/expr` (`compileExpression(src, scope)`). Local shim until L1's package exports exist; record the switch here.

### 1.7 Examples (`sims/`)

H1 kirsch-plate, H2 heat-plate-fin, H3 helmholtz-coil, H4 si-rib-waveguide, H5 cylinder-cavity, H6 box-acoustics. Geometry and loads from the R3 case definitions (SM-01, HT-01, EM-04, WO-02, RF-01, AC-02) with provenance. Material values: `materials/` references or `N/A` with a `missing` entry. Numerical modelling choices (domain truncation, plate size for W/D >= 20) are labelled `basis: user` with an assumption.

### 1.8 Gates

1. Schema tests: all six examples accepted; unknown keys rejected; unitless dimensional values rejected.
2. Splice round trip preserves comments.
3. 1000 random operation sequences, then undo-all: text byte-identical with the original, hash chain valid.
4. Report JSON Schema size and parse+validate time per example.

## 2. TODO

- [x] Package scaffold, deps (zod 4.6.7, yaml 2.9.1 exact; dev tools from the root after the coordinator note)
- [x] Units/expr interface backed by `@amp/core` (no shim needed, see 3)
- [x] Schema core, quantities, selections, provenance, registry, provisional wave-1 types
- [x] JSON Schema export
- [x] yaml-edit port + extensions
- [x] parseSpecText with error paths and line/col
- [x] JSON Patch + inverse
- [x] Operation log, hash chain, undo/redo/revert, invalidation, JSONL, replay
- [x] Untrusted-text helper
- [x] Run record helpers, canonical JSON
- [x] Six example specs
- [x] Tests and gates, numbers in section 4
- [x] Coordinator notes 2026-11-06 (L1 done, sweep keys, degC, tsconfig lib, root installs; L7a sims ids)
- [x] Hand-off
- [x] Fresh-context audit (coordinator, 2026-11-06): corrections in section 7
- [ ] S5 and agent-facing S6 helpers (with L9)

## 3. Progress log

- 2026-11-06 15:20 PST: Read inputs. L1 has `packages/core/src/units.mjs` (5 base dims incl. K, no affine degC) and `expr.mjs` (unit literals `2[um]`, dimension inference). Plan written.
- 2026-11-06 15:18-15:22 PST: L1 published `@amp/core` exports (`./units`, `./expr`) while I scaffolded, so `@amp/spec` imports them directly through the adapter `src/units.ts` (interface `UnitsApi`). **No local shim was written; there is nothing to switch.** The adapter adds only `degC`/`°C` (affine, offset 273.15 K, literals only) and preferred display names.
- 2026-11-06 15:25 PST: zod v4 probed: strict objects, discriminated unions with custom unknown-type message, issue paths, `toJSONSchema` with `$defs` from `meta({id})`.
- 2026-11-06 15:30 PST: schema, registry, validate, yaml-edit port, yaml I/O; all six examples validate. The strict-key policy caught two of my own YAML mistakes (unquoted commas in flow maps).
- 2026-11-06 15:38 PST: coordinator notes applied: devDependencies removed from the package (root typescript 5.9.3, @types/node 24.19.2), root `pnpm install`; package tsconfig `lib: ["ES2023", "DOM"]` (WebCrypto, TextEncoder, performance, navigator); the parametric study moved out of the provisional seed into `src/core-types.ts` (owner `@amp/spec`) with `values` or `range {start, stop, n}` axes, row-major, at most 4 axes.
- 2026-11-06 15:40 PST: patch, oplog, invalidation, run records, untrusted text, selection helpers, shared contract types; tests green (35).
- 2026-11-06 15:42 PST: gate 3 first run (seed 20261106): 996/1000. The 4 failures were my inverse of `move` into an earlier slot of the same array: the inverse `move` had a `from` that is a string prefix of `path` (RFC 6902 forbids that), although remove-then-add is well defined. Inverse changed to `test, remove, add`; regression test added; rerun 1000/1000, and 1000/1000 with seed 7.
- 2026-11-06 15:44 PST: `pnpm test` 35/35, `pnpm check` clean, JSON Schema `$ref`s all resolve (18/18). DevLog and hand-off written.

## 4. Results

Machine: M4 Pro, Node 23.7.0, `nice -n 10`, heap cap 1.5 GB. Logs: `logs/L2-gates-20261106T154257.{log,json}` (seed 20261106), `logs/L2-gates-20261106T154329.{log,json}` (seed 7), `logs/L2-test-20261106T154513.log`.

Gates:

| Gate | Result |
|---|---|
| 1 Schema: six examples accepted | 6/6 (`test/schema.test.ts`) |
| 1 Unknown keys rejected | top level, physics settings, bc, mesh.size, provenance entry, material override; issue carries dotted path, JSON Pointer, line:col, allowed keys |
| 1 Unitless dimensional values rejected | `hmax: 5`, `radius: 5`, traction component `0`, bare `[0, 0]` center; bare numbers still accepted for dimensionless fields (`grading: 1.3`) |
| 2 Splice round trip preserves comments | EO tests ported + hero spec: set/insert/delete change one line, delete of an inserted key restores the bytes, all comments kept; sequence insert/delete splices for block and flow sequences |
| 3 1000 random sequences, undo-all | 1000/1000 byte-identical, hash chain valid; also redo-all byte-identical, 100 JSONL replays OK. Seed 20261106: 4462 edits, 8954 patch ops (replace 3082, add 2327, remove 1730, test 913, copy 470, move 432); 8449 verified splices, 24 printer fallbacks (0.28 %); 25-26 s. Seed 7: 4383 edits, 18 fallbacks (0.22 %), 24.9 s |

JSON Schema (wave-1 registry, generated by `specJsonSchema`): 41,053 B minified, 104,092 B pretty-printed (3,248 lines), 18 `$defs`, 11.9 ms to build cold. For comparison the EO hand-kept schema is 2,949 lines (R1 s.2a) and covers one device family.

Parse + validate (YAML parse, params, zod, cross-references), median of 50 after 5 warm-up runs:

| Example | Bytes | Median ms | Min ms |
|---|---|---|---|
| kirsch-plate | 2969 | 0.846 | 0.643 |
| heat-plate-fin | 2816 | 0.634 | 0.556 |
| helmholtz-coil | 3924 | 0.951 | 0.822 |
| si-rib-waveguide | 4975 | 1.073 | 0.892 |
| cylinder-cavity | 2234 | 0.445 | 0.426 |
| box-acoustics | 2310 | 0.484 | 0.423 |

Not measured: browser bundle size of zod (no bundler in this lane; L5's Vite build should report it), browser timings.

### 4.1 Package map (`packages/spec/src`)

| File | Content |
|---|---|
| `schema.ts` | zod definition: `quantity(dim)`, `vector(dim, n)`, `selection(kinds)`, fixed blocks, `SpecSchema` (generic; source of `Spec` and node types), `buildSpecSchema(registry)`, `specJsonSchema(registry)` |
| `registry.ts`, `core-types.ts`, `provisional/wave1.ts` | registry (kinds feature, physics, bc, coupling, study, property; `check` hooks; `replace`); core parametric study; provisional H1-H6 seed (7 features, 6 physics, 16 conditions, 1 coupling, 5 studies, 12 property names; names, shapes and dimensions only) |
| `validate.ts`, `yaml.ts` | params (dims, cycles, ranges, reserved names), zod pass, cross-references (global id uniqueness, feature refs, selections vs features, material overlap incl. `#k` splits, physics/geometry space, couplings, studies, results, provenance paths, assumption paths, N/A coverage); YAML strict parse with line:col |
| `yaml-edit.mjs/.d.mts` | EO port (header lists 8 changes) |
| `patch.ts`, `oplog.ts`, `invalidation.ts`, `canonical.ts` | RFC 6902/6901, guarded inverses, log, chain, JSONL, replay, invalidation, JCS-style canonical JSON, WebCrypto sha-256 |
| `run-record.ts`, `untrusted.ts`, `selection.ts`, `types/` | C5 helpers; untrusted strings + nonce-delimited prompt wrapper; selection resolution against a C2 EntityTable; shared C2/C4/C5/C6/C7 types |

### 4.2 sims/ ids (reply to L7a, DevLog-006 s.5 item 5)

| L7a proposal | L2 file | Status |
|---|---|---|
| kirsch-plate (SM-01) | `sims/kirsch-plate.yaml` | confirmed |
| helmholtz-coil (EM-04) | `sims/helmholtz-coil.yaml` | confirmed |
| cylinder-cavity (RF-01) | `sims/cylinder-cavity.yaml` | confirmed |
| nafems-t4 (HT-01) | `sims/heat-plate-fin.yaml` | changed: the hero id from my task is `heat-plate-fin`; it is the NAFEMS T4 model (geometry, BCs, point E probe). Reference it as `sims/heat-plate-fin.yaml` |
| rigid-box-modes (AC-02) | `sims/box-acoustics.yaml` | changed: hero id `box-acoustics`; it is the AC-02 model |
| si-slab (WO-01) | none | `sims/si-rib-waveguide.yaml` is the WO-02 Hadley rib (class b), not the WO-01 slab |
| the other 23 ids | none | not authored in wave 1; names accepted as reserved |

## 5. Contract requests

1. **C3 (coordinator)**: record the `amp-spec/0` details now fixed by the schema: optional top-level `description`; registered nodes carry `settings` (strict, per type) and `label`; `studies[].physics` is required (explicit, no "all physics" default); `results[].type` adds `scalar` and `probe` (`at`, `step`, `select`); `mesh = {mesher?, size {hmax, hmin?, grading?}, refine[{select, h}], budget {maxNodes?, maxDof?}}`; quantity forms (object values are numbers or `"N/A"`; expressions are strings, units in brackets); `provenance.values` keys are dotted paths with index or element-id segments; `basis` enum (17 values, `schema.ts` BASIS) and APA `status`; `missing`/`assumptions` entries are strings or `{path, what, needed_for, source, note}` / `{id, text, paths}`; anchors, aliases and custom tags are errors.
2. **C7 (coordinator)**: additive fields `kind` (`edit|undo|redo|revert`), `target`, `text {at, del, ins}`, `textHash`; inverses start with `test` guards; JSONL line 1 is a genesis record `{schema: amp-oplog/0, kind: genesis, ts, specHash, textHash, text?, hash}` and op 1's `prev` is its hash. Hashes are lowercase hex sha-256 of canonical JSON (no `sha256:` prefix, as C2).
3. **C1 (coordinator)**: record `zod` 4.6.7 as an approved runtime dependency of `@amp/spec` only.
4. **L3**: confirm or replace the provisional sub-entity names (rect `left/right/top/bottom`, circle `edge`, polygon `e0..`, box `xmin..zmax`, cylinder `side/top/bottom`) and boolean naming (result domain id = boolean feature id, boundaries keep their origin feature id, `difference.keepTools`); supersede the feature registrations from `@amp/geom` with `{replace: true}`.
5. **L4**: supersede the physics/bc/coupling/study/property registrations from `@amp/physics`; the field-expression names used in the examples' `results[].expr` (`solid.sxx`, `T`, `mf.Bz`, `ewg.neff`, `rf.freq`, `ac.freq`, ...) are placeholders to be renamed to your output names.
6. **materials/ owner**: the examples reference `materials/structural-steel`, `materials/air`, `materials/copper` (all `missing`); benchmark-defined values (T4 k, WO-02 indices, RF-01 eps_r/tan d, AC-02 c) are N/A with the R3 value quoted in `missing`.
7. **L1 (optional)**: affine `degC` is handled in the spec layer (`units.parseUnit` returns `{dim, factor, offset}`) and refused inside expressions; `@amp/core/units` is unchanged. If the engine wants degC in field expressions, that needs a core design (affine vs difference units). Also `formatUnit` names the Pa dimension `J/m^3` (first NAMED match); the spec overrides the display order locally.
8. **CONTRACTS-v0 header**: shared types now live in `packages/spec/src/types/` for C2, C4, C5, C6, C7 (`@amp/spec/types`); lanes can delete their `contract-shim.ts`. C8 (L8) and C9 (L6) types are not included.

## 6. Hand-off

State: done for wave 1; all gates pass. Entry points (`@amp/spec`):

```ts
import { parseSpecText, formatIssues, specJsonSchema, createOpLog, replayJSONL, makeRunRecord, wrapUntrusted, freeTextStrings, checkSelections } from '@amp/spec';
import { wave1Registry, registerWave1 } from '@amp/spec/provisional';
const reg = wave1Registry();                       // core types + provisional wave-1 types
const r = parseSpecText(yamlText, reg);            // {ok, spec, issues[{path, dotted, pointer, code, message, line, col}], params}
const log = await createOpLog(yamlText, { registry: reg });
await log.apply([{ op: 'replace', path: '/params/D/value', value: 8 }], { actor: 'agent:s1', reason: '...' });
await log.undo({ actor: 'user' });                 // exact bytes; log.toJSONL() / replayJSONL()
```

Adding a type without editing core files: `reg.register({kind: 'physics', type, dims, settings: z.strictObject({...}), check?})`, `{kind: 'bc', type, for: [physicsTypes], select: ['bnd'], settings}`, `{kind: 'property', type, unit}`; `{replace: true}` supersedes a provisional seed.

Known limits:
- (Updated 2026-11-06 16:12, oplog v1, section 7) Reverts are id-anchored and guarded: index shifts in id-bearing arrays no longer conflict; elements without ids (e.g. selection entries) and removed elements whose previous sibling is gone still conflict, loudly, with the text unchanged. Undo/redo are exact.
- Comments inside a block collection that an edit replaces wholesale go with it; 0.2-0.3 % of random splice steps fell back to the document printer (data verified; undo still exact through the text delta).
- Field expressions in `results[].expr` are not checked (no output names yet); `pi` is the only built-in constant; param names `pi` and expression function names are reserved.
- Selection ids are checked against feature ids only; sub-entity existence needs the built geometry (`checkSelections`).
- 98 % of gate-3a random edits produce invalid specs by design (ungated D3); gate 3b (valid-to-valid, section 7.4) covers realistic edits.
- The JSON Schema was checked for `$ref` resolution, not against a draft 2020-12 meta-schema validator (none installed).
- Not done: browser run of the package and zod bundle size (L5), fresh-context audit (coordinator).

## 7. Audit corrections (audit `DevLog/audits/2026-11-06-L2-spec-audit.md`, coordinator order 2026-11-06 ~15:58 PST)

### 7.1 Plan (written before coding, 2026-11-06 16:00 PST)

Order as given by the coordinator. S5 and the agent-facing helpers (`agentView`, structured issue templates, `renameId`, `applyText`, tool-input schema) wait for L9.

1. **S3** forbidden keys `__proto__`, `constructor`, `prototype`: rejected as YAML mapping keys (`parseStrict`, `parseYaml`), as any patch path/from token, as any key inside a patch value (deep), and excluded from `NODE_ID`, `PARAM_NAME`, `DOTTED_PATH` (so `z.record` keys and ids cannot carry them).
2. **S4** every resolved quantity and param must be finite; `quantity(dim, {gt|ge|le})` and `vector(dim, n, {gt|ge})` constraints on the SI value, exported to the JSON Schema as `x-amp-min` / `x-amp-exclusive-min` / `x-amp-max`. Applied to mesh sizes, lengths, radii, sizes, thickness, wavelength, time step, frequencies (> 0), absolute temperatures and h (>= 0), emissivity (0..1).
3. **Minors** M13 (rib nModes provenance), M1 (`missing[].path` must resolve), M6 (`parseStrict` rejects custom tags), M5 (patch shape validated with a zod `JsonPatch` schema before apply, readable errors).
4. **S1 + S2, operation log v1**:
   - Pointer tokens `@<id>` address the array element with that `id` (and `@<id>+` = insertion point after it, last token of `add` only). Inverses are written with id anchors wherever the element has an id, so a revert after index shifts still hits the right element.
   - Guarded inverses check the target state: `replace`/`add`/`copy`/`move` inverses start with `test`; `remove` inverses start with the amp extension op `{op: 'absent', path}` (fails when the member exists), and `add` refuses an array element whose `id` already exists in that array.
   - Per-op effect (`applied | undone | reverted`) derived from the log; `revert` of an op not in effect, or of an undo/redo record, fails with a message.
   - Replay recomputes inverse, invalidations, validation (when a registry/validator is given), enforces actor/reason rules and kind/target/stack consistency, and accepts `expectHead` to detect truncation. `RunRecord.oplogHead` (optional, additive to C5) carries the head hash outside the log.
   - Gate extended: valid-to-valid schema-aware edits, revert of old ops (conflicts counted, state unchanged on conflict), branches (undo k, new edits), then undo-all byte-identical.
5. **S6 groundwork**: slider coalescing (`apply(patch, meta, {coalesce: {windowMs}})` merges into the head op when same actor, single `replace` on the same path, inside the window, head op is the undo top); `schemaAt(registry, pointer, data)`; shared `$defs` (reused sub-schemas referenced once). Report the new minified size.

Then rerun tests, check and all gates.

### 7.2 Corrections and dispositions

| # | Disposition | What changed | Evidence |
|---|---|---|---|
| S3 | fixed | `__proto__`, `constructor`, `prototype` rejected: as YAML mapping keys (`parseStrict` and `parseYaml`, via `disallowed()` in yaml-edit), as any pointer token (`parsePointer`), as any key inside a patch value (deep `findForbiddenKey`), and excluded from `NODE_ID`, `PARAM_NAME`, `DOTTED_PATH`, so a record key, id or provenance path cannot carry them | tests `audit S3` (schema) and `forbidden keys are refused` (oplog); audit `proto2.ts`: both patches refused, no pollution; audit spec 06/07: rejected at YAML level with line:col |
| S4 | fixed | every resolved quantity and param must be finite; `quantity(dim, bounds)` / `vector(dim, n, bounds)` with `gt/ge/lt/le` on the SI value, exported as `x-amp-exclusive-min` / `x-amp-min` / `x-amp-exclusive-max` / `x-amp-max`. Applied: mesh `hmax`/`hmin`/`grading`/`refine.h` > 0; rect/box size, circle/cylinder radius, cylinder height, thickness, wavelength, time step, frequencies > 0; absolute temperatures (T, T_ext, T_amb, T_ref) >= 0 K; h >= 0; emissivity in [0, 1]; property bounds E, rho, cp, c > 0; k, sigma, tan_delta >= 0; nu in (-1, 0.5) (isotropic stability). Not bounded: eps_r, mu_r, n (can be < 1 or negative), positions, loads, sources | test `audit S4` (8 rejected forms incl. 1e308 km, 1e400 mm, W*10^400, W/0, -1 mm, 0 m, -300 degC); audit `adv-schema.ts`: specs 12/13/16/17 now "value is not finite" |
| M13 | fixed | `studies.modes.settings.nModes` in `sims/si-rib-waveguide.yaml` has `basis: user` and a note | file |
| M1 | fixed | `missing[].path` must resolve (`unresolved_path`); absent items are described without a path | test in `provenance and dotted paths` |
| M6 | fixed | `parseStrict` (op log path) rejects custom tags, like `parseYaml` | yaml-edit test; audit `tag-probe.ts`: refused |
| M5 | fixed | `JsonPatchSchema` (zod) checked before every apply/invert; readable messages ("op 0: missing required key 'value'", "op must be add, remove, ...") | oplog test `malformed patches`; audit `misc-probe.ts` |
| M10 | fixed (with S3 edit) | `fmt(-0)` writes `0`, so text and spec hash agree | yaml-edit header change (9) |
| M11 | fixed (needed by S1) | a patch of only `test`/`absent` ops is refused, nothing appended | oplog test |
| S1 | fixed (oplog v1) | `@<id>` / `@<id>+` pointer tokens; inverses id-anchored and guarded (`test` on the written value, amp `absent` op before re-adding a removed member or id-bearing element); `add` refuses a duplicate element id; per-op effect `applied/undone/reverted` (`effectOf`); revert refused for ops not in effect and for redo records; revert of an undo record re-applies a branched-off edit | oplog tests `v1 revert`, `v1 branch`; audit `oplog-probe.ts`: 2b now applies to the right bc (anchor `@tension`), 2c refused ("absent ... it exists"), 2d refused (anchor sibling gone; no misplacement), 2e/2e2 refused ("op 1 is undone"), branch recovery by reverting the undo record works, undo-all == original |
| S2 | fixed (oplog v1) | replay re-derives and compares inverse, invalidations, validation (when a registry/validator is given), actor/agent-reason rules, kind/target vs stacks and effects; `expectHead` option; `RunRecord.oplogHead` (optional) via `makeRunRecord({oplogHead})`; header states that the chain detects corruption, not forgery (no key) | oplog test `v1 replay`: forged inverse, deleted agent reason, forged invalidations, forged validation (with registry) and truncation (with `expectHead`) all rejected |
| S6 (part) | groundwork done | `apply(patch, meta, {coalesce: {windowMs}})` merges a drag into the head op (`coalesced: n`; same actor, single `replace` on the same path, head = undo top, inside the window); `schemaAt(registry, pointer, data)` (resolves registered unions by `type`, `@id` tokens); `$defs` shared (one schema per bc type, ids for selections, labels, node ids, vectors; every quantity variant refers to one of two shared form definitions) | oplog test `v1 coalescing`: 200 drag steps -> 1 op (audit: 202 ops, 159 kB JSONL); schema test `schemaAt`; JSON Schema 30,614 B minified (was 41,053, -25 %), 64,964 B pretty, 2,461 lines, 57 `$defs`, all `$ref` resolve |
| S6 (rest) | waits for L9 (coordinator) | `renameId`, `applyText`, per-tool schemas, `describe_type`, provider dialect check | - |
| S5 | waits for L9 (coordinator) | `agentView`, structured issue templates, position-based text classification | - |
| M2, M3, M4 | M4 done (gate 3b, reverts, branches); M2, M3 open | M3 (`text.mode` splice/reprint) and M2 (coverage depth) not done | - |
| M7, M8, M9, M12 | open | M7 `edg` in 2D, M8 sub-entity names (needs L3), M9 `buildSpecSchema` outside `withScope`, M12 meta-schema validation | - |
| audit spec 48 (`nModes: 100000000`) | open | a resource bound is not a physical bound; L4 to set solver budgets | - |

Format changes: the oplog schema is now `amp-oplog/1` (v0 logs do not replay: inverse format changed). JSON Pointer tokens starting with `@` and the `absent` op are amp extensions of RFC 6901/6902; a plain RFC 6902 consumer can read every recorded forward patch that was written with numeric indices.

### 7.3 Progress

- 2026-11-06 16:00 PST: plan 7.1 written.
- 2026-11-06 16:02 PST: S3 (ids, YAML, patch), S4 (finite, bounds), M13, M1, M6, M5 done; 37 then 42 tests green.
- 2026-11-06 16:06 PST: patch.ts and oplog.ts rewritten (v1). The audit probe confirmed the S1 cases; one capability the v0 probe used (recover a branched op by reverting its undo record) was first lost by refusing undo records, then restored as an explicit effect rule.
- 2026-11-06 16:08 PST: gate 3b (valid-to-valid) pilot found a generator bug (copied a domain selection into a boundary condition, 15 invalid results); fixed the generator, 0 invalid.
- 2026-11-06 16:10 PST: S6 groundwork. First try with zod `reused: 'ref'` grew the minified schema to 46,120 B (many tiny `$defs`); replaced by explicit ids plus shared quantity forms: 30,614 B.
- 2026-11-06 16:12 PST: all gates rerun (below), `pnpm test` 43/43, `pnpm check` clean.

### 7.4 Gate rerun (logs `logs/L2-gates-20261106T161128.{log,json}` seed 20261106, `...T161209...` seed 7, `logs/L2-test-20261106T161215.log`)

| Gate | Seed 20261106 | Seed 7 |
|---|---|---|
| 1 schema (6 examples, unknown keys, unitless, S3, S4) | 43/43 tests | - |
| 2 splice round trip | pass (yaml-edit tests) | - |
| 3a raw random + reverts + branches, undo-all byte-identical, chain, replay with expectHead | 1000/1000; 3806 edits, 7798 patch ops; reverts 309 applied / 19 refused with text unchanged; 74 branches; 18 printer fallbacks of 8009 steps (0.22 %); 23.5 s | 1000/1000; 3821 edits; reverts 294 / 23 refused; 76 branches; 17 fallbacks (0.21 %); 23.5 s |
| 3b valid-to-valid + reverts + branches, replay recomputing validation | 1000/1000; 4422 edits, 0 invalid results; reverts 441 / 42 refused; 168 branches; 0 fallbacks; 17.5 s | 1000/1000; 4492 edits, 0 invalid; reverts 502 / 49 refused; 194 branches; 17.8 s |
| JSON Schema size budget (<= 41,053 B) | 30,614 B, pass | 30,614 B |

Parse + validate medians (ms, 50 runs after 5 warm-up): kirsch 0.771, heat 0.603, helmholtz 0.824, rib 1.121 (file now 5,156 B), cavity 0.434, box 0.480.

### 7.5 Contract requests added by the corrections

1. **C5**: optional `RunRecord.oplogHead` (sha-256 hex of the op log head at run start).
2. **C7**: `amp-oplog/1`; pointer tokens `@<id>` and `@<id>+`; extension op `absent`; field `coalesced`; ops of only `test`/`absent` are refused; revert rules (only ops in effect; undo records revertible, redo records not).
3. **L4**: physical bounds in the provisional property and settings registrations are listed in 7.2 S4; keep or tighten them when superseding; set solver budgets (e.g. `nModes`) yourselves.

## 8. Follow-up: split-piece ids and one canonical resolver (L3 audit S1, coordinator 2026-11-06 ~16:13 PST)

Changes (2026-11-06 16:15 PST):
- `ENTITY_ID` accepts repeated split suffixes `(#k){0,8}` (`dom:a#1#2`, `bnd:base.top#1#3`). `parseEntityId(...).split` is now `number[]`, outermost first, and empty for an unsplit id (was `number | null`; no other package used it).
- `entityOverlaps(a, b)`: same id, or one is a split piece of the other at any depth. The material-overlap check uses it.
- `@amp/spec` no longer expands selections. The old `resolveSelection` in `src/selection.ts` (one level deep, and with no consumers outside the package) is removed. `checkSelections(spec, geometry?)` takes `{table, resolve}`:
  - without a geometry it returns one `severity: 'notice'` issue, "selection not checked: geometry not built";
  - with one it reports `unknown_entity` for ids that the injected resolver cannot match.
- Spec-side validation stays static: it checks the grammar, the allowed kinds per node, and that the feature named in each id exists in `geometry.features`.
- Tests: grammar accepts and rejects (5 malformed forms), double-split selection accepted by the schema, overlap at depth 2, the notice without a geometry, and resolution through a test-only reference resolver. `pnpm test` 44/44, `pnpm check` clean (`logs/L2-test-20261106T161540.log`, `logs/L2-check-20261106T161540.log`).

Proposal to L3 (name and signature, to be confirmed in DevLog-004). `@amp/geom` depends on `@amp/spec`, so `@amp/spec` cannot import the resolver. It declares the contract type instead, and callers inject the function:

```ts
// @amp/geom
export function resolveEntityIds(table: EntityTable, kind: 'domains' | 'boundaries' | 'edges' | 'points', ids: readonly string[]): { indices: number[]; unknown: string[] };
// rules: exact id; plus every entity whose id starts with `<id>#` (any depth); plus the transitive closure over `parent`.
// Never throws on unknown ids; they go to `unknown`. The existing throwing resolveSelection can wrap it.
// @amp/spec: type EntityResolver = typeof resolveEntityIds; checkSelections(spec, { table, resolve: resolveEntityIds })
```

Open for L3 and the coordinator:
- ~~The L3 grammar also emits `&` and `@`~~: resolved by the coordinator decision below.
- C2 should document the `#k#k` grammar and the piece numbering (L3 numbers pieces from 1).

Coordinator decision (contract changelog, 2026-11-06 ~16:16 PST):
- `&` is accepted in entity ids, for fragment overlap pieces (`dom:a&b`).
- Layers become `.L<k>` sub-entities in L3, so entity ids carry no `@`.
- The name `resolveEntityIds` is adopted, and L3 exports it.

Applied 2026-11-06 16:17 PST:
- `ENTITY_ID` feature part: up to 16 feature ids joined by `&` (`a&b&c`), then sub-entities, then `#k` pieces.
- `parseEntityId(...).features` lists the `&` components, and validation requires each one to be a geometry feature.
- Rejected: `&a`, `a&`, `a&&b`, `a&1b`, `a@2`, and `&` inside sub-entities (`bnd:a.b&c`).
- `.L2.top` style layer sub-entities already fit the sub-entity grammar.
- Tests added in `entity ids` (schema.test.ts). `pnpm test` 44/44 and `pnpm check` clean (`logs/L2-test-20261106T161643.log`, `logs/L2-check-20261106T161643.log`).

## 9. Contracts v1 (coordinator 2026-11-06 ~16:30 PST; requests L4 DevLog-010 s.5, L10 DevLog-013 s.5, contract changelog)

### 9.1 Plan (written before coding, 2026-11-06 16:32 PST)

1. **Field-valued settings.** A new `field(dim, {bounds, vars})` builder for BC, source and initial-condition settings. It takes everything `quantity()` takes, plus expressions in the reserved symbols x, y, z, r (m) and t (s). Allowed symbols per geometry: 1d x; 2d x, y; 2d-axisym r, z; 3d x, y, z; t when `vars` includes time. Dimensions are checked through `@amp/core/expr`, with the symbols as field scope entries. Bounds apply when the value is constant.
   - New object form `{expr, unit}`: the expression value is in `unit`, and affine units are allowed when the expression is dimensionless. For example HT-02: `{expr: "100*sin(pi*t/(40[s]))", unit: degC}`.
   - x, y, z, r and t become reserved param names; `sims/si-rib-waveguide.yaml` param `t` is renamed `t_slab`.
2. **Initial conditions and time study.**
   - The heat seed gets `settings.T0` = `field('K', space only, >= 0)`.
   - The time study moves to the core registrations with `{start, stop, dt > 0, method: bdf1 | bdf2 | crank-nicolson | generalized-alpha, output?}`; the checks are stop > start and dt <= stop - start.
   - BC fields may use t.
3. **Physics-scoped BC types.** The registry stores BC registrations per (physics type, BC type). One registration may still list several physics, and a `{replace: true}` registration for one physics leaves the others in place.
   - New `getBc(physicsType, type)`.
   - Unknown-BC errors name the physics type and id.
   - The seed gains an elastic `pressure` (normal pressure) next to the acoustics `pressure`.
4. **Tensor overrides.**
   - A property registration may declare `scalar?: boolean` and `tensor?: {<symmetry>: [component names]}`, or supply its own `value` zod schema. `@amp/materials` registers these.
   - Override form: `{symmetry, unit?, components: {...}}`. Components are quantities of the property's dimension, or numbers when `unit` is given, or N/A.
5. **Basis vocabulary.** Add `paper_model_input` and `reference_correlation`, and export `BASIS_DEFINITIONS` with a one-line definition per basis (also used in the JSON Schema description).
6. **Material refs.** `validateSpec` / `parseSpecText` / `OpLogOptions` accept an injected `materials: {ids(): string[]}` (the `@amp/materials` `Library` shape). With it, `materials/<id>` must be a library id; without it, refs are not checked.
- Also: `mesh.size.grading` description (contract changelog decision 5). `facets2` / C2 facets are untouched.
- Then: all gates, JSON Schema size.

### 9.2 Done (2026-11-06 16:37 PST)

| # | Request | Implementation |
|---|---|---|
| 1 | Expression-valued BCs and sources | `field(dim, {bounds, vars})` in `schema.ts`; `vector(dim, n, bounds, vars)` for field vectors; `resolveField()` and `evaluateFieldExpression()` (core expr, symbols as field scope entries, so dimensions are inferred without values); new object form `{expr, unit}` (also accepted by `quantity()` for constants). Seed settings switched to `field`: temperature T, heat-flux q, convection h and T_ext, surface-radiation T_amb, heat-source Q, boundary-load traction, both `pressure` p, coil-current current (time only). Bounds are checked when the value is constant. Messages: "'r' not available here (allowed: x, y, t; geometry 2d)", "affine unit degC needs a dimensionless expression". Tested: HT-02 `{expr: "100*sin(pi*t/(40[s]))", unit: degC}`, a Kirsch-type traction in x, y |
| 2 | Initial conditions and time study | heat `settings.T0` = `field('K', >= 0, space only)` in the seed (L4 already reads `T0`; swap their `T_ABS` for `field(...)` to allow expressions). The core `time` study is `{start, stop, dt > 0, method: bdf1, bdf2, crank-nicolson or generalized-alpha (required), output?}` with checks stop > start, dt <= range, output inside the range. x, y, z, r and t are reserved param names |
| 3 | Physics-scoped BC types | registry keys BCs by (physics type, name). `getBc`, `bcsFor`; `get('bc', name)` only when unambiguous; `{replace: true}` per physics; '*' registrations are shadowed by specific ones. The seed has separate `pressure` for acoustics (p) and elastic (normal pressure). Errors: "unknown bc type 'pressure' for physics type 'heat' (registered there: ...) [physics 'ht']". JSON Schema ids `Bc_<physics>_<name>` for shared names |
| 4 | Tensor overrides | property registrations take `scalar?`, `tensor?: {symmetry: [components]}` or a full `value` schema; override form `{symmetry, unit?, components}`; numbers need `unit`, units must have the property dimension, N/A components need `missing` entries, unknown or absent components are errors |
| 5 | Basis vocabulary | `paper_model_input`, `reference_correlation` added; `BASIS_DEFINITIONS` (19 entries, one line each) exported and placed in the JSON Schema description of `basis` |
| 6 | Material refs | `ValidateOptions.materials: {ids()}` (the `@amp/materials` Library shape) in `validateSpec`, `parseSpecText`, `OpLogOptions.validateOptions`; `unknown_material` when the id is not in the library; no check without it |
| - | grading description | `mesh.size.grading`: "maximum size growth per unit distance, |dh/dx|" (changelog decision 5) |
| - | C2 facets | untouched (`facets2` stays) |

Also: missing-key messages now cover enum and union fields ("missing required key 'method'").

Gates (logs `logs/L2-gates-20261106T163604.*` seed 20261106, `...T163650.*` seed 7; tests `logs/L2-test-20261106T163658.log`):
- `pnpm test` 52/52 (new `test/contracts-v1.test.ts`, 8 tests), `pnpm check` clean. `tsc` of physics, materials, geom, mesh and eval against the new spec: clean; materials tests 17/17.
- 3a raw random with reverts and branches: 1000/1000 on both seeds (counts identical to s.7.4: the generator draws are unchanged).
- 3b valid-to-valid: 1000/1000, 0 invalid results, on both seeds.
- **JSON Schema: 34,382 B minified** (was 30,614; +3,768 B for `{expr, unit}` forms, 13 field definitions, the time study and basis definitions), 70,408 B pretty, 2,589 lines, 60 `$defs`, under the 41,053 B budget.
- Parse + validate medians 0.44-1.13 ms per example.

### 9.3 For I1 (sims/ owner; I did not edit sims/ after the coordinator note)

At 16:34 PST I renamed `t` to `t_slab` in `sims/si-rib-waveguide.yaml`. The coordinator note arrived at the same moment, and I inverted the same five replacements, so no `t_slab` remains (not verified with git, which this lane does not run). Breaks and stale content:
1. **si-rib-waveguide (breaks):** param `t` is now reserved, because t is the time symbol. Port: rename `t` to `t_slab` in `params`, the slab `size`/`center`, `mesh.refine.0.h`, `sweep.0.param` and `provenance params.t`. `test/heroes.ts` applies exactly this rename in memory until the file changes, and stops when the file no longer has `t:`.
2. **Stale `missing` entries:** kirsch-plate, helmholtz-coil and heat-plate-fin say "materials/ ... not authored yet (materials/ empty on 2026-11-06)". `materials/structural-steel`, `air` and `copper` now exist (ids in `materials/*.yaml`), and all three refs pass the new library check.
3. **Optional HT-02 / SM-01 exact-traction specs:** the forms now exist (`{expr, unit: degC}`, a traction vector of x, y expressions). A 1D HT-02 spec needs a 1D interval feature from L3; none is registered.

### 9.4 Contract requests (contracts v1)

1. **C3 (coordinator):** record `field()` semantics, the `{expr, unit}` form, reserved symbols x, y, z, r, t, physics-scoped BC names, the tensor override form, the core `time` study and `BASIS_DEFINITIONS`.
2. **L4:**
   - Use `field()` for the BC and source settings you supersede (heat T0, pressure p and others), so expressions validate.
   - Split your `pressure` registration per physics if the descriptions or settings differ (it still works as one registration for `[acoustics, elastic]`).
   - Evaluating field expressions at quadrature points and time steps is yours: `@amp/core/expr` `compileExpression` with x, y, z, r, t as field scope entries.
3. **L10 materials:**
   - In `registerMaterialProperties`, pass `scalar: d.scalar` and `tensor: Object.fromEntries(d.tensor.map((s) => [s, SYMMETRY_COMPONENTS[s]]))`. Without them the spec cannot know the tensor forms; with them it validates `{symmetry, unit?, components}`.
   - Pass `createLibrary(...)` (it has `ids()`) as `materials` in `parseSpecText` / `validateSpec` / `OpLogOptions.validateOptions`.
4. **L3:** a 1D interval feature for HT-02/HT-03 (geometry dim 1).
