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
- [ ] Fresh-context audit (coordinator, after hand-off)

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
- Revert of an older op whose array index shifted since fails on its guard (conflict reported); undo/redo are exact.
- Comments inside a block collection that an edit replaces wholesale go with it; 0.2-0.3 % of random splice steps fell back to the document printer (data verified; undo still exact through the text delta).
- Field expressions in `results[].expr` are not checked (no output names yet); `pi` is the only built-in constant; param names `pi` and expression function names are reserved.
- Selection ids are checked against feature ids only; sub-entity existence needs the built geometry (`checkSelections`).
- 98 % of random gate edits produce invalid specs by design (ungated D3); a schema-aware random edit gate (valid-to-valid) is not written yet.
- The JSON Schema was checked for `$ref` resolution, not against a draft 2020-12 meta-schema validator (none installed).
- Not done: browser run of the package and zod bundle size (L5), fresh-context audit (coordinator).
