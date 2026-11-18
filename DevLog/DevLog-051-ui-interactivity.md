# DevLog-051: workbench UI interactivity (lane E5, chunk 2)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | E5 (DevLog-037 s.4.1, scope C3) |
| Owns | `apps/web/src/lib/workbench/**`, `apps/web/src/lib/state/**` except `nav.svelte.ts`, `apps/web/src/lib/ui/**`, `apps/web/src/lib/results/api.ts`, new tests `apps/web/test/e5-*.test.ts` |
| Does not touch | `gfx/**`, other `results/**`, `engine/**`, `post/**`, `agent/**`, `nav.svelte.ts`, `library/**`, `packages/**`, git |
| Ports | 41741 (dev server), 41742 spare |

Conventions: F = fact read from code or a run; E = estimate; D = decision; O = open item.

## 1. Facts found before planning (2026-11-18 13:20-13:28 PST)

- F: `state/tree.ts` builds the tree from the spec; only results nodes have actions (`Tree.svelte` `openAct` returns for other kinds; `results/plot-ops.ts` builds their patches). Model nodes are edited only through forms, YAML or the agent.
- F: ids are one namespace over the whole spec (`validate.ts` crossCheck `addId`, duplicate id error). `NODE_ID` regex in `@amp/spec` ids.ts.
- F: references to model node ids: selections (`ENTITY_ID`: `<dom|bnd|edg|pnt>:<feature>(&<feature>)*(.<sub>)*(#k)*`) anywhere (materials, physics, bcs, mesh refine, results `over`); feature settings keys listed in `Registration.refs` (difference `base`/`tools`, union/intersection/fragment `inputs`); `studies[].physics`; `couplings[].from/to`; result expressions `<physics id>.<name>`; results `parity` keys `<physics id>.<field>`; dotted paths in `provenance.values` keys, `assumptions[].paths`, `missing[].path` (segments are keys, indices or element ids; `resolveDotted`).
- F: parametric study schema (`core-types.ts`): `settings: {study, sweep: [{param, values: [q..]} | {param, range: {start, stop, n >= 2}}]}`, 1-4 axes, row-major. The session runs it as a sweep (`session.svelte.ts` computeSweep); per point `scalars` are kept for every point (also evicted ones).
- F: per-mode scalars are named `<name>_<k>` with k the 0-based step index (`f_k`, `Q_k`, `neff_k`, `ng_k`, `lossDbPerM_k`, `ezFraction_k`, `m_k`, ...); multiphysics merges prefix `<physics>.`. Eigen steps: `steps.kind = 'eigen'`, unit Hz (frequency) or 1 (n_eff, em-modes).
- F: `Graphics.svelte` exposes `step` as `$bindable` (eigen mode index in the step selector).
- F: `ui/Headlines.svelte` lists every headline item; items of a study that was not solved show "not evaluated". `headlineItems(results)` (@amp/spec) carries `study` per item; `runStudies(spec, solved)` (results/api.ts) gives the studies a run answers for.
- F: `state/params.ts` `paramValue` writes a unitless string param ('5', unit '1') as "7 1".
- F: `results/LinePlot.svelte` (E6) takes `series[]`, `xLabel`, `yLabel`; `gfx/Plot1D.svelte` draws one spec plot1d group of one run only, so a curve over sweep points cannot come from it without a gfx change.

## 2. Plan

1. `state/edit-ops.ts` (new, pure, no Svelte): patch builders for model tree ops on geometry features, materials, physics and boundary/domain conditions, each returning `{ok: true, patch, id, pointer, ...}` or `{ok: false, reason}`; plus `applyTreeOp(host, op)` that applies one through a host `{data, apply(patch, reason)}` (UI: `ModelState.apply`; agent: a wrapper on `applyAgent`). Every op is one patch = one op-log operation (undo / redo / YAML consistent).
   - add: menus from the registry (features filtered by space dim; physics by space dim; bc types `reg.bcsFor(physics type)`; material: one blank entry). Template = `{id, type}` plus empty required containers (`select: []`, `settings: {}` when the settings schema rejects `{}`... ); D: nothing physical is filled in (no sizes, no values), so the new node shows its validation issues until the user fills the form. Fresh id `<prefix><n>` unique in the whole spec.
   - delete: refused with the referencing places listed when the node's id is referenced (selections, refs, studies, couplings, expressions); provenance / assumption / missing dotted paths into the node are removed in the same op and index-addressed paths of later siblings are shifted.
   - duplicate: deep copy after the original with a fresh id; a physics node's bcs get fresh ids too (one id namespace).
   - rename: D: references are updated in the same op (selection tokens incl. `&` pieces, feature `refs` keys, `studies[].physics`, coupling `from` / `to`, result expressions and parity keys, dotted paths); then a residual scan: if the old id still appears anywhere outside free text, the rename is refused with the pointers (the user edits those in YAML). Optional `validate` hook: refused when the rename adds validation issues.
   - Tree.svelte: context menu (right-click, context-menu key) on feature / material / physics / bc nodes: Rename, Duplicate, Delete; F2 or double-click renames inline; "+" on Geometry, Materials, Physics folders and on physics nodes (bc). Settings pane: the same actions as buttons. Refusals go to the Log (error) and a transient line in the tree.
2. Sweep editor (`workbench/SweepEditor.svelte`, shown on study nodes and the Studies folder): create a parametric study (inner study, one or more axes: param, list or range start / stop / n with unit), edit, remove. Pure builders `sweepFromSpec` / `setSweepPatch` / `removeSweepPatch` in `state/sweep.ts` with a parser for list text ("1, 2, 5") and range; round trip through the spec.
3. Sweep plot (`workbench/SweepPlot.svelte`, bottom tab "Sweep"): any scalar of the solved points (union of `scalars` keys) vs the swept param (first axis; other axes as separate series), absolute units from the scalar's unit and the param unit; consumer of `results/LinePlot.svelte` (read only). Pure data builder `sweepSeries` in `state/sweep.ts`.
4. Eigenmode table (bottom tab "Modes", shown with an eigen solution): per mode index, step value (frequency Hz or n_eff), and every per-mode scalar `<name>_<k>`; click a row sets the Graphics step (bound from Workbench). Pure builder `modeTable` in `state/modes.ts`.
5. Headlines: list only items whose root study is answered by the solved run; one dim line names the items left out and the study they need. After a study switch + solve, select the first plot group whose dataset reads the solved study (Workbench effect on `solvedSeq`). `params.ts`: unitless write "7".
6. Tests `apps/web/test/e5-*.test.ts`: each tree op (spec diff), refusals, rename reference updates, sweep editor round trip (patch applied through a real op log and parsed back), mode table, headline filter, params fix.
7. Validation: `pnpm --filter @amp/web check`, `test`, e2e smoke (port 41741), screenshots of each feature via playwright-core headless (existing tooling), reviewed; at most one kept per feature under `logs/`.

## 3. TODO

- [x] edit-ops.ts + tests
- [x] Tree / Settings / Workbench wiring
- [x] sweep.ts + SweepEditor + tests
- [x] SweepPlot (bottom tab)
- [x] modes.ts + Modes tab + step binding + tests
- [x] Headlines filter, plot group after study switch, params fix + tests
- [x] check, test, screenshots
- [x] e2e smoke (1 fail outside this lane, s.5)
- [x] hand-off (s.7)

## 4. Progress log

- 2026-11-18 13:28 PST: read DevLog-037 s.1 / s.4.1, DevLog-024 parity rows, DevLog-040 s.5, DevLog-038, owned sources, `packages/spec` patch / oplog / schema / registry / core-types; plan written.
- 2026-11-18 13:39 PST: `state/edit-ops.ts`, `state/sweep.ts`, `state/modes.ts`, `state/study-results.ts` written; `params.ts` unitless write fixed; tests `e5-edit-ops.test.ts` (9) and `e5-sweep-modes.test.ts` (8) green. UI: Tree context menu / inline rename / "+" on model folders, Settings buttons + id-edit-as-rename, `SweepEditor.svelte`, `ModesTab.svelte`, `SweepPlot.svelte` (bottom tabs Modes, Sweep), Headlines filter, plot group after a study switch, Graphics step bound in Workbench.
- 2026-11-18 13:56 PST: screenshots reviewed (tree ops, sweep editor + plot, mode table, study switch); e2e run done; gates in s.5.
- 2026-11-18 13:44 PST: relay from the coordinator (E7): signatures written to s.7 now; `navHost.setCamera` routes `preset` and `look_at` to `setCameraPreset(preset, lookAt?)` of `gfx/camera.ts` (E6) instead of refusing (`look_at` without a preset uses 'iso'; `distance` is not used by `setCameraPreset`). `pnpm --filter @amp/web check`: 0 errors (the earlier errors were in Graphics.svelte mid-edit by E6 and one test cast of mine, fixed).

## 5. Results

Final gates (13:56 PST): `pnpm --filter @amp/web check` 0 errors 0 warnings (1517 files); `pnpm --filter @amp/web test` 115 / 115 (all lanes; 17 are this lane's). E2E smoke `logs/E5-e2e-20261118T214936-summary.md` (port 41742, 288 s): 70 checks, 59 pass, 10 warn, 1 fail. The fail is `pec-post-scattering` (a new driven example of another lane): RF-70 sigma2d_fwd / sigma2d_back outside the case tolerance (rel 2.6e-1, 1.8e-2); page load, mesh, solve and canvas passed; not a workbench UI failure. No console errors in the screenshot runs. Kept screenshots: `logs/E5-20261118T2156-{tree-ops,sweep-editor-plot,mode-table,study-switch-plot}.png`; temporary ones deleted; dev server on 41741 stopped.

Features (all in owned paths):
- Model tree ops (`state/edit-ops.ts`; `Tree.svelte`, `Settings.svelte`, `Workbench.svelte`): "+" on Geometry (feature types of the registry, types of another space dimension disabled with the reason), Materials (blank material), Physics (physics types) and on each physics node (its condition types, `reg.bcsFor`); right-click on a feature, material, physics or condition: Rename, Duplicate, Delete; F2 or double-click renames in place; Delete key deletes; the Settings pane has Duplicate / Delete buttons and an edit of the id field is a rename. Each op is one op-log operation (Undo / Redo / YAML consistent). Refusals and notes show under the tree (role alert / status) and in the Log.
- D (rename): references are updated in the same op; refused when the old id stays anywhere else outside free text (pointers listed) or when the validator reports new issues. D (delete): refused while the id (or an id inside the node) is referenced; dotted paths into the node are removed and index-addressed paths of later siblings shifted. D (add): nothing physical filled in; the new node shows its validation issues (e.g. a rect without size / center; the graphics view then shows "Model invalid" until the form is filled or Undo).
- Sweep editor (`SweepEditor.svelte`, on the Studies folder and every study node): new or existing parametric study, inner study, 1-4 axes (param, list or range start / stop / n, unit), preview of the values and the point count (> 50 flagged), Apply / Add sweep (one op; the study picker is set to it), Remove (refused while results datasets read it).
- Sweep plot (bottom tab "Sweep", shown with a sweep): any module scalar of the points vs the first swept param in its unit, other axes as series, gaps for unsolved points, log toggles; drawn with `results/LinePlot.svelte` (read only).
- Eigenmode table (bottom tab "Modes (n)", shown with an eigen solution): mode index, f (Hz) or n_eff, every per-mode scalar; a row click (or Enter) shows the mode (Graphics `step` bound in Workbench).
- Headlines: only items of the solved study; one dim line "k more for <study>" with the item list in the tooltip. After a solve of another study the first 2D / 3D plot group of that study is shown (a fitting current group is kept; the default first solve keeps the quick view as before).
- `params.ts`: a unitless string param is written "7" (was "7 1").
- Agent nav host (relay from E7): `setCamera` preset / look_at routed to `setCameraPreset` (gfx/camera.ts).

Tests: `apps/web/test/e5-edit-ops.test.ts` (9 tests: targets, add menus and templates, delete refusals and dotted-path cleanup, index shift, duplicate, rename feature / physics / material / coupled model, residual refusal) and `e5-sweep-modes.test.ts` (8 tests: read-back of an existing sweep, create / edit / remove round trip through a real op log and the parser, refusals and value parsing, sweep series, mode table, headline split on pzt4-cube and hand-written data, plot group choice, unitless param). `pnpm --filter @amp/web test`: 91 / 91 pass at 13:41 PST (all lanes' tests). `pnpm --filter @amp/web check`: 0 errors, 0 warnings at 13:44 PST.

Screenshots (headless shell, SwiftShader, 1440 x 900, dev server 41741), reviewed:
- kirsch-plate: context menu on `hole`; Delete refused with the 3 referencing places; inline rename to `bore` (1 op, 4 references updated: difference tools, bc select, refine, evaluation `over`; mesh rebuilt); "+" Geometry menu (box, cylinder, extrude disabled in 2D); add rect shows its 2 missing settings; two Undos restore the text.
- kirsch-plate: new range sweep D 2..10 mm, n 3 -> Add sweep -> Compute: 3/3 points, Sweep tab plots mises_max (Pa) vs D (mm).
- cylinder-cavity-axisym: Modes (18) with f (Hz), m, ezFraction; row 2 click shows 3.468 GHz.
- pzt4-cube: study switch std_sc -> std_oc, Compute: plot group V_open selected and drawn (solvedStudy std_oc).
- Not shown in a screenshot: the headline filter; no library sim has max / min / point items in more than one study (checked over all `sims/*.yaml`); covered by the unit tests.

## 6. Open items and requests

- O1: the sweep plot shows module scalars only (`Solution.scalars`, kept for every point). Spec evaluation items (e.g. kirsch `kt`) over all points need evaluation at each point's solve (points beyond `SWEEP_HELD` drop their solution); proposal: evaluate the headline / evaluation tables per point in `computeSweep` and keep the numbers like `scalars`.
- O2: a model without a `materials` or `physics` array has no Materials / Physics folder in the tree, so no "+" there; `addNodePatch` handles the absent array (agent path works).
- O3: deleting a physics is refused while a study lists it (by design: one op never edits studies silently); the message names the study.
- O4: selecting a tool feature (e.g. the hole of a difference) highlights the domains whose ancestors include it (the whole plate), from `state/tree-view.ts` featureIds; unchanged here; a "tool" highlight of its boundary only would read better.
- O5: `look_at` camera requests ignore `distance` (`setCameraPreset(preset, lookAt?)` has no distance).
- O6: the headline filter is not visible on any library sim (no sim has max / min / point items in two studies); unit-tested only.
- O7 (environment): the session scratchpad directory is shared by the lanes; another lane wrote a `shot.mjs` over mine at 13:47 PST. I moved my files to a lane subfolder; lanes should use per-lane subfolders.
- R1 (to the coordinator): none blocking. E7 signatures in s.7.

## 7. Hand-off: exported functions for agent tools (E7)

All builders are pure (spec data in, JSON Patch out) and never apply anything; `applyTreeOp` applies through a host. Agent use: wrap the agent log, e.g. `{ get data() { return model.data; }, apply: (p, reason) => model.applyAgent(session, p, reason) }` (`ModelState.applyAgent` requires a reason; `applyTreeOp` passes `describeOp(op, r)` unless `o.reason` is given).

`apps/web/src/lib/state/edit-ops.ts`
```ts
export type EditKind = 'feature' | 'material' | 'phys' | 'bc';
export type EditResult = { ok: true; patch: JsonPatchOp[]; id: string; pointer: string; note?: string } | { ok: false; reason: string };
export type TreeOp =
  | { op: 'add'; parent: string; type: string; id?: string }      // parent: '/geometry' | '/materials' | '/physics' | '/physics/<i or @id>' (condition)
  | { op: 'delete'; pointer: string }
  | { op: 'duplicate'; pointer: string; id?: string }
  | { op: 'rename'; pointer: string; id: string };
export type Validator = (data: unknown) => ReadonlyArray<{ pointer: string; message: string }>;   // e.g. d => validateSpec(d, reg).issues
export interface EditHost { readonly data: unknown; apply(patch: JsonPatchOp[], reason: string): Promise<unknown> }
export function applyTreeOp(host: EditHost, op: TreeOp, o?: { reg?: Registry | null; validate?: Validator; reason?: string }): Promise<EditResult>;
export function treeOpPatch(data: unknown, op: TreeOp, o?: { reg?: Registry | null; validate?: Validator }): EditResult;
export function addNodePatch(data: unknown, reg: Registry | null, parent: string, type: string, id?: string): EditResult;   // material: type 'material'
export function deleteNodePatch(data: unknown, pointer: string): EditResult;
export function duplicateNodePatch(data: unknown, pointer: string, id?: string): EditResult;
export function renameNodePatch(data: unknown, pointer: string, newId: string, o?: { reg?: Registry | null; validate?: Validator }): EditResult & { updated?: string[] };
export function modelAddMenu(data: unknown, reg: Registry, pointer: string): ModelMenuEntry[];   // the types allowed under a parent (disabled ones carry the reason)
export function editTarget(data: unknown, pointer: string): EditTarget | null;                   // kind, canonical pointer, id of a model node
export function referencesTo(data: unknown, id: string, skip?: string): string[];               // pointers referencing an id
export function describeOp(op: TreeOp, r: { id: string }): string;
```
Pointers accept `@id` tokens (`/physics/@solid/bcs/@tension`). Pass `reg` for add (type checks) and rename (feature `refs` keys); pass `validate` for rename (refused when it adds validation issues).

`apps/web/src/lib/state/sweep.ts`
```ts
export interface SweepAxisDef { param: string; mode: 'values' | 'range'; values: string[]; start: string; stop: string; n: number; unit: string }
export interface SweepDef { id: string; study: string; axes: SweepAxisDef[] }   // id: parametric study (new or existing); study: inner study
export function setSweepPatch(data: unknown, def: SweepDef): EditResult;        // create or replace, one op; refusal reasons from sweepProblem
export function removeSweepPatch(data: unknown, id: string): EditResult;        // refused while results datasets read the study
export function sweepDefOf(data: unknown, id: string): SweepDef | null;         // read back (round trip)
export function newSweepDef(data: unknown, params: ReadonlyArray<{ name: string; value: number | null; unit: string }>): SweepDef;
export function sweepProblem(data: unknown, def: SweepDef, isNew: boolean): string;
export function parseValueList(text: string): string[];
export function sweepCount(def: SweepDef): number;
export function sweepScalars(sw: SweepLike | null): Array<{ name: string; unit: string }>;
export function sweepSeries(sw: SweepLike, scalar: string): { series: Array<{ name: string; x: number[]; y: number[] }>; xLabel: string; yUnit: string; solved: number };
```
Values are text in `unit` (e.g. `{ unit: 'um', values: ['0.1', '0.2'] }` writes `["0.1 um", "0.2 um"]`; an empty unit writes numbers). After applying, set `session.study = def.id` so Compute runs the sweep (the editor does this).

`apps/web/src/lib/state/modes.ts`: `modeTable(sol): { stepName, stepUnit, columns: {key, name, unit}[], rows: {k, value, cells}[] } | null`.
`apps/web/src/lib/state/study-results.ts`: `headlineSplit(data, solvedStudy)`, `plotGroupForStudy(data, solvedStudy, current)`, `datasetStudy(data, datasetId)`.

## 8. Follow-up: sweep points on the worker pool (DevLog-054 R3) and material add type (2026-11-18)

- 14:09 PST: `session.svelte.ts computeSweep` builds every point's text first (a failing point is `error` and is not run), then runs the runnable points through `engine.runSweep(jobs, onPoint, workers)` (lane E8 pool); `onPoint` is the former per-point block (status, mesh, params, scalars, Log, showPoint, solvedSeq), outcomes in sweep order. A point turns `solving` at its first progress event and stays so until its outcome is delivered in order (a finished point can wait for an earlier one). `Session.sweepWorkers` (null = auto `poolSize`, 1 = serial); a workers select in the sweep editor (not stored in the model). Cancel unchanged (`engine.cancel()` -> pool cancel; unfinished points `cancelled`).
- `addNodePatch(.., '/materials', type)` now refuses any type other than 'material' (reported by E7); test added.
- Gates: check 0 errors; test 118 / 118. Session runes do not load in the Node test runner, so the pool path is not unit-tested here (the pool itself has E8's mock-worker tests); verified in the browser instead.
- Browser run (dev server 41741, headless shell, 12 cores, deviceMemory 16 -> 4 workers): kirsch-plate 6-point sweep D 2..10 mm: serial 1190 ms, pool 830 ms; si-rib-waveguide `sweep_t` 7 points: serial 6743 ms, pool 3269 ms. Per-point label, status, every scalar and DOF identical between serial and pool (JSON equal) in both. Cancel 400 ms into a pool sweep: unfinished points `cancelled`, no page errors. Single runs each (timings are one sample, not averaged).
