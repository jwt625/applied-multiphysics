# DevLog-053: agent tool parity and provider selector (lane E7, chunk 2)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | E7 (agent parity, DevLog-037 s.4.1) |
| Owns | `packages/agent/**`, `apps/web/src/lib/agent/**`, `apps/web/src/lib/state/nav.svelte.ts`, CSP lines in `apps/web/vite.config.ts`, `apps/web/static/_headers`, `apps/web/scripts/base-check.ts`, new tests `apps/web/test/e7-*.test.ts`, this file |
| Inputs | DevLog-037 s.1 (agent facts) and s.4.1 (lane rules); DevLog-001 Q7 (BYO key in the browser only, stored locally, sent only to the provider); DevLog-012 (agent); DevLog-018 (OpenAI-compatible adapter, DeepSeek preset, s.5 browser request); DevLog-040 (study picker, nav host factory); code read 2026-11-18 13:20-13:28 PST |
| Depends on | E6 `apps/web/src/lib/gfx/camera.ts` (`CAMERA_PRESETS`, `setCameraPreset(preset, lookAt?)`); E6 Graphics registration of probe and quick-view hooks (request R1); E5 tree and sweep-definition functions (relayed later) |

Conventions: F = fact read from code, files or docs; D = decision; O = open item; R = request.

## 0. Sources

| Topic | URL | Accessed | What it says (relevant part) |
|---|---|---|---|
| DeepSeek API base URL | https://api-docs.deepseek.com/ | 2026-11-18 13:27 PST | base URL `https://api.deepseek.com`; model names `deepseek-flash` (served by DeepSeek-V4.1-Flash-1017) and `deepseek-v4-pro`; legacy `deepseek-v4-flash` still accepted, model retired |
| DeepSeek models and pricing | https://api-docs.deepseek.com/quick_start/pricing | 2026-11-18 13:27 PST | `deepseek-flash` USD per 1M tokens off-peak / peak: cache hit 0.003 / 0.006, cache miss 0.15 / 0.3, output 0.6 / 1.2; `deepseek-v4-pro` 0.022 / 0.044, 0.66 / 1.32, 1.98 / 3.96; peak 01:00-04:00 and 06:00-10:00 UTC Monday-Friday excluding Chinese public holidays; context 1M |

F: `DEEPSEEK_PRESET` in `packages/agent/src/provider/openai-compatible.ts` (written 2026-11-06) matches these values; no change to the preset numbers, only the re-check date in its comment.

## 1. State before this lane (F)

- 23 tools (`packages/agent/src/tools/schemas.ts`), tool definitions 13,609 B (limit asserted in `test/tools.test.ts`: 16,000 B).
- `run_study.study` required. The web runner (`apps/web/src/lib/agent/mount.ts studyRunner`) sets the workbench study choice `s.study` to the requested study before `s.compute()`.
- Workbench nav host (`Workbench.svelte navHost`, E5 path) rejects `set_camera` preset and look_at; only `fit` works.
- UI actions without a tool: Cancel (`Session.cancel()`), sweep point (`Session.selectPoint(i)`, `Session.sweep`), probes (`ProbeTable` owned by Workbench, rows added by `Graphics.svelte pick2d / pick3d`), quick-view settings (Graphics local state: `fieldKey`, `compUser`, `cmPick`, `ruleUser`, `scalePick`, `contoursUser`, `wireUser`), study choice (toolbar select, `Session.study`), share.
- Only the Anthropic provider is mounted. CSP `connect-src 'self' https://api.anthropic.com` in `vite.config.ts` (meta CSP of pages) and `static/_headers` (`/_app/*`, scripts and workers).

## 2. Plan (written 2026-11-18 13:30 PST, before coding)

### 2.1 Tools (`packages/agent`)

| Tool | Input | Host method (optional on `NavigationHost`) | Notes |
|---|---|---|---|
| `cancel_run` | `{}` | `cancelRun()` | stops a running mesh / solve / sweep / accuracy sequence started from the workbench; changes no spec; in the navigation trail |
| `select_sweep_point` | `{ index? }` | `sweep()`, `selectSweepPoint(i)` | no index: list the points of the last parametric sweep (label, param values, status, shown); index: show that point (dataset) everywhere |
| `probe` | `{ action: add, list, remove, clear; at?: [x, y] or [x, y, z] m; n? }` | `probeAdd(at)`, `probeList()`, `probeRemove(n or all)` | add evaluates the drawn field at the point (display unit) and appends a probe-table row |
| `quick_view` | `{ field?, component?, colormap?, range? full, p1-99, log?, contours?, wire? }` | `quickView()`, `setQuickView(patch)` | no field set: read the current settings and the choices |
| `set_camera` (changed) | as before | `setCamera` | preset and look_at now reach the 3D view through E6 `setCameraPreset`; look_at keeps a preset direction (default iso); distance is reported as not applied |
| `run_study` (changed) | `study` optional | `StudyRunner.defaultStudy()` | default: the workbench's chosen study, else the first study |

All new host methods are optional: a host without them answers `<tool>_unavailable`. Tool results carry spec-derived strings (field names, labels) inside the untrusted block. `RecordingNavHost` gains in-memory implementations for tests and the task suite. Tool-size budget: keep definitions under 16,000 B if possible; if the four tools exceed it, raise the asserted bound with the measured size recorded here.

### 2.2 Web host (`apps/web/src/lib/state/nav.svelte.ts`, `apps/web/src/lib/agent/mount.ts`)

- `agentNavHost(base, actor, deps)` in nav.svelte.ts wraps the view's host (Workbench or Play, unchanged): adds `cancelRun` (Session.cancel), `sweep` / `selectSweepPoint` (Session.sweep, Session.selectPoint), probe and quick-view methods through a view-hook registry (`registerViewHooks`, filled by the graphics view: request R1 to E6), and a `setCamera` that sends preset / look_at to `setCameraPreset` when the camera module is present, else to the base host. Every call recorded in `navTrail`.
- Camera module guard: `import.meta.glob('../gfx/camera.ts')` in mount.ts (an empty map while the file does not exist; no build error).
- `studyRunner.defaultStudy()` returns `Session.runStudy`.

### 2.3 Provider selector (`apps/web/src/lib/agent/`)

- `providers.ts` (pure): provider choices `anthropic`, `deepseek` (preset, model `deepseek-flash` or `deepseek-v4-pro`), `custom` (OpenAI-compatible base URL, https only, model id, cost N/A, reasoning field dropped); choice stored in localStorage `amp.agent.provider` (not secret); CSP `connect-src` read at run time from the page's CSP meta tag, with a fallback list equal to the build CSP; a custom origin not allowed by it is flagged before any request.
- Keys: each provider keeps its own `KeyStore` name (`amp.agent.provider-key.<name>`), memory by default, localStorage only after the existing opt-in. No other storage.
- AgentPanel key row: select Anthropic | DeepSeek | Custom, model select for DeepSeek, base URL + model inputs for Custom; switching re-mounts the agent (new chat: histories are provider-specific). Tooltips: endpoint, model, prices with source and access date.
- D (custom URLs and CSP): `connect-src` gets the preset hosts only (`https://api.anthropic.com`, `https://api.deepseek.com`); no wildcard, so injected content cannot send the key or data to an arbitrary host. A custom base URL works only when its origin is in the page CSP (a self-hosted build adds it in `vite.config.ts` and `static/_headers`); the panel says so and does not send to a blocked origin.

### 2.4 CSP

- `vite.config.ts` `'connect-src': ['self', 'https://api.anthropic.com', 'https://api.deepseek.com']`; `_headers` `/_app/*` the same; `base-check.ts` asserts both hosts.

### 2.5 Tests

- `packages/agent/test/parity.test.ts`: each new tool through `AgentSession.execute` with `RecordingNavHost`; a scripted-mock agent turn that calls all new tools; `run_study` default study; trail entries; unavailable answers.
- Task suite (`eval/tasks.ts`) unchanged and green.
- `apps/web/test/e7-providers.test.ts`: provider config parse/store, CSP parsing and origin check, CSP consistency between `vite.config.ts`, `_headers` and the fallback list. `apps/web/test/e7-nav.test.ts`: `agentNavHost` with a fake session and hooks (compiled like `nav-studies.test.ts`).
- Browser: dev server on 41745, screenshot of the provider selector reviewed.

## 3. TODO

- [x] schemas, session dispatch, nav types, RecordingNavHost, runner default study
- [x] agent tests + task suite + check
- [x] nav.svelte.ts agentNavHost + view hooks; mount.ts wiring; camera guard
- [x] providers.ts + AgentPanel selector
- [x] CSP vite.config.ts, _headers, base-check.ts
- [x] web tests e7-*, web check + test
- [x] dev server screenshot; base-check (build) if no other lane is building
- [x] requests, open items, hand-off
- [x] E5 tree / sweep-definition tools (O1, resumed 13:56 PST after the coordinator relayed DevLog-051 s.7)

## 4. Progress log

- 2026-11-18 13:28 PST: Read briefs, code and DevLog-018; DeepSeek docs re-fetched (s.0). Ports 41745 and 41746 free. Plan written.
- 2026-11-18 13:38 PST: Agent package done: 4 tools added (27 total, definitions 15,740 B, under the 16,000 B bound), set_camera look_at direction + host note, run_study default study (`StudyRunner.defaultStudy`), optional host methods and `RecordingNavHost` test state, prompt line, toolSummary keys. `test/parity.test.ts` 8 tests; agent `pnpm test` 71/71 (task suite included), `pnpm check` clean.
- 2026-11-18 13:38 PST: Web: `agentNavHost` + `registerViewHooks` in nav.svelte.ts; mount.ts wraps the view host, camera module by glob import (absent today), provider choice; `providers.ts`; AgentPanel selector; CSP in vite.config.ts, _headers, base-check (plus a meta connect-src check). Web tests 91/91 (e7-providers 6, e7-nav 4). svelte-check: 0 errors and 0 warnings in E7 files; 4 errors in E5 in-progress files (Workbench.svelte, test/e5-edit-ops.test.ts), not E7's.
- 2026-11-18 13:40 PST: Browser (dev server 127.0.0.1:41745, headless Chromium, kirsch-plate): selector screenshots for Anthropic, DeepSeek and a custom endpoint reviewed (dark, sharp, one dense key row; DeepSeek tooltip shows endpoint, model, prices with source and access date; custom `https://api.example.com/v1` refused before mounting with the CSP message; only `amp.agent.provider` in localStorage, no key stored without opt-in; no page errors, no external request). Live wiring through the mounted session: `run_study` without a study solved the picker's `std1` (`study_default: true`); `cancel_run` "nothing was running"; `select_sweep_point` no_sweep; `quick_view` no_field_drawn and `probe` no_probe_table (graphics hooks not registered yet, R1); E6's `gfx/camera.ts` had landed: on pzt4-cube `set_camera` preset top and look_at front applied (graphics screenshot reviewed: x-z view, triad x/z), `distance` reported as not applied; on the 2D kirsch-plate preset refused "no 3D view is shown". Dev server stopped.
- 2026-11-18 13:41 PST: Build with BASE_PATH=/applied-multiphysics VITE_AMP_HOOKS=1 (logs/E7-build-20261118T134043.log) and `node scripts/base-check.ts <scratch> 41746`: 27/27 ok (logs/E7-base-check-20261118T134058.log, logs/D1-base-check-20261118T214059.json), including `_app` header connect-src with both hosts and the new meta connect-src check on 11 pages. DeepSeek `pricingSource.accessed` set to 2026-11-18 (values re-checked, unchanged). Final agent `pnpm test` 71/71 (logs/E7-agent-test-20261118T134143.log), check clean.

- 2026-11-18 13:56 PST: Resumed for O1 (coordinator relay: E5 builders in DevLog-051 s.7; E5 also routed the workbench `navHost.setCamera` to `setCameraPreset`, so R3 is closed).
- 2026-11-18 14:03 PST: O1 done. `packages/agent/src/edits.ts` (`TreeOp`, `SweepDef`, `EditPatch`, `ModelEditor`; `AgentSessionOptions.editor`, `MountOptions.editor`). Tools `edit_tree {op: add, delete, duplicate, rename; parent?, type?, pointer?, id?; reason}` and `define_sweep {id, study?, axes?: [{param, values? (text), start?, stop?, n?, unit?}], remove?, reason}`: the host builds the patch, the session applies it through its op log as one agent op (reason, mark for revert turn, validation issues as apply_ops); refusals return the builder's reason (add: plus the allowed types); a stored sweep is read back and becomes the chosen study. Web: `apps/web/src/lib/agent/editor.ts` `modelEditor(reg, choose)` over `treeOpPatch` (with `validateSpec`), `modelAddMenu`, `setSweepPatch`, `removeSweepPatch`, `sweepDefOf`; mount.ts passes it with `s.study = id`. No mode-table tool: `get_results_summary` already returns the eigen steps and the per-mode scalars it would reorganize. Prompt edit bullet names both tools.
  - Tool definitions: 29 tools, 16,830 B. First compacted the new descriptions and schemas (17,980 -> 16,830 B: shorter descriptions of the parity tools and the two edit tools, string-only sweep values, no per-field length caps on the new tools; the 1 MB input bound and the builders still check). Existing tools left as they were. Bound in `test/tools.test.ts` raised 16,000 -> 17,000 B (reason: two edit tools the brief requires; about 2.6 % of the definitions above the old bound; prefix is cached).
  - Tests: `packages/agent/test/edits.test.ts` (4: unavailable, edit_tree applied / refused / arguments, define_sweep values and range / chosen / read back / remove refusal, scripted mock turn + revert turn) with a fake editor; `apps/web/test/e7-edits.test.ts` (3) over the real builders on kirsch-plate (rename moves provenance keys, delete refused with the referencing pointers, unknown feature type refused with the type list, sweep stored as `["6 mm", "8 mm"]` and removed, scripted mock turn reverted to the original bytes). Gates: agent test 75/75 and check clean (logs/E7-agent-test-20261118T140216.log); web test 118/118 (logs/E7-web-test-20261118T140216.log); web check 0 errors, 0 warnings (all lanes' files).
  - Note for E5 (not a defect in this lane): `addNodePatch` under `/materials` ignores `type` (any type adds a material).

## 5. Results

### 5.1 Tools (27; definitions 15,740 B, bound 16,000 B in `test/tools.test.ts`)

| Tool | Input (zod, strict) | Result head (trusted) | Data (untrusted block) | Errors |
|---|---|---|---|---|
| `cancel_run` (new) | `{}` | `ok`, `note` (what was cancelled, or "nothing was running") | none | `cancel_run_unavailable`, `ui_refused` |
| `select_sweep_point` (new) | `{ index?: int >= 0 }` | `total, done, shown, selected?` | sweep: study, inner, points (index, label, values with units, status, shown, selectable) | `select_sweep_point_unavailable`, `no_sweep`, `no_sweep_point`, `ui_refused` (unsolved point) |
| `probe` (new) | `{ action: add, list, remove, clear; at?: [x, y] or [x, y, z] m; n?: int >= 1 }` | add: `n, inside`; others: `count` | add: the row (n, at_m, field, value, unit, dataset); others: rows | `probe_unavailable`, `missing_point`, `missing_probe_number`, `no_probe_table`, `ui_refused` |
| `quick_view` (new) | `{ field?, component? -1..8, colormap?, range? full or p1-99, log?, contours?, wire? }` | `changed: [keys]` | settings and choices (fields, components, colormaps, logAvailable, plotGroup) | `quick_view_unavailable`, `no_field_drawn`, `ui_refused` (unknown field or colormap, with current settings) |
| `set_camera` (changed) | as before; `preset` also gives the look_at direction (default iso) | `note` when the host has one | none | `missing_camera_argument`, `ui_refused` |
| `run_study` (changed) | `study` optional | `study_default: true` when defaulted | as before | `no_study`, `unknown_study`, `no_runner` |

All four new tools are navigation tools (`NAV_TOOLS`): they change no spec and are recorded in the session's navigation trail and the page's Navigation tab. Host methods are optional on `NavigationHost` (`cancelRun`, `sweep`, `selectSweepPoint`, `probeAdd`, `probeList`, `probeRemove`, `quickView`, `setQuickView`); `StudyRunner.defaultStudy?()`; `CameraRequest.look_at.preset?`.

### 5.2 Web

- `state/nav.svelte.ts`: `agentNavHost(base, actor, { session, camera, hooks })` (wraps the view's host; cancel only when something runs: mesh, solve, sweep, accuracy refinement, sweep point re-solve), `registerViewHooks` / `viewHooks` (graphics view hooks: probe table, `probeAt`, `quickView`, `setQuickView`), `running`, `sweepInfo`, `probeInfo`.
- `agent/mount.ts`: wraps the view host for the agent, `studyRunner.defaultStudy = Session.runStudy`, camera through `import.meta.glob('../gfx/camera.ts')`, provider choice (Anthropic SDK path unchanged; DeepSeek and custom through `mountAgent({ openaiCompatible })`), `customPreset` (key name per origin, no prices, reasoning field dropped), `ProviderAbout` for the tooltip. Return type now `{ chat, about }` (only AgentPanel calls it).
- `agent/providers.ts`: choice storage, base URL rules (https, no credentials, query or fragment), CSP connect-src parse (page meta tag, else the build list) and source matching, `choiceProblem`.
- `agent/AgentPanel.svelte`: provider select (Anthropic | DeepSeek | OpenAI-compatible), DeepSeek model select (deepseek-flash, deepseek-v4-pro), custom base URL + model id + Use; switching re-mounts (new chat; the in-memory key of the previous provider is dropped, a remembered key stays under its own name); disabled while a turn runs; Play's scripted mock unchanged.
- CSP: `connect-src 'self' https://api.anthropic.com https://api.deepseek.com` in `vite.config.ts` and `static/_headers`; `base-check.ts` asserts the header and every page's meta connect-src.
- D (custom endpoints): no wildcard or extra host in the shipped CSP. A custom endpoint is mounted only when the page CSP allows its origin; otherwise the panel shows the CSP message and sends nothing. Self-hosters add the origin to both CSP places (and `BUILD_CONNECT_SRC` keeps the test in step).

### 5.3 Tests

- `packages/agent/test/parity.test.ts` (8): unavailable answers on a bare host; cancel; sweep list / select / unsolved / unknown; probe add 2D and 3D, list, remove, clear, input errors; quick_view read / patch / refusals; set_camera preset, look_at direction, host note; run_study default (host choice, stale choice, first study, explicit study wins); a scripted mock-provider turn calling every new tool (wire check clean, trail 6 entries, no spec op). Agent total 71/71 incl. the task suite (eval.test.ts) unchanged.
- `apps/web/test/e7-providers.test.ts` (6) and `e7-nav.test.ts` (4); web total 91/91 at 13:37.

## 6. Requests

- R1 (to E6 via the coordinator; `apps/web/src/lib/gfx/Graphics.svelte` or its split): register the graphics view hooks so `probe` and `quick_view` work in the browser. Until then both answer `no_probe_table` / `no_field_drawn`. Code against the current names (adapt to the split):

```ts
import { registerViewHooks, type QuickViewInfo, type QuickViewPatch } from '../state/nav.svelte';
// agent probe and quick-view tools: this view's probe table, a probe at a point, and the quick-view settings
$effect(() => {
	if (!probes) return;
	return registerViewHooks({
		probes,
		probeAt: async (p) => {
			if (mode !== 'results') return { row: null, message: 'switch to the results view first' };
			if (!sol || !field || !drawable) return { row: null, message: 'no field is drawn' };
			const n0 = probes.rows.length;
			if (m2) await pick2d({ x: p[0], y: p[1] });
			else return { row: null, message: '3D probe at a point: not wired (needs probe3d at p with any ray direction)' };
			return probes.rows.length > n0 ? { row: probes.rows.at(-1)! } : { row: null, message: 'the solution changed while probing' };
		},
		quickView: (): QuickViewInfo | null => (mode !== 'results' || !sol || !names.length) ? null : {
			field: field ? keyOf(field) : null, fields: [...names],
			component: field && field.components > 1 ? compUser : null,
			components: field && field.components > 1 ? Array.from({ length: field.components }, (_, i) => (field!.name === 'E_rphiz' ? ['r', 'phi', 'z'][i]! : String(i))) : [],
			colormap: cmPick, colormaps: [...COLORMAPS], range: ruleUser === 'robust' ? 'p1-99' : 'full',
			log: scalePick === 'log', logAvailable: !!map?.logOk, contours: contoursUser, wire: wireUser, plotGroup: grp?.id ?? null
		},
		setQuickView: (q: QuickViewPatch) => {
			if (q.field !== undefined && !names.includes(q.field)) return { ok: false, message: `no field ${q.field}` };
			if (q.colormap !== undefined && q.colormap !== 'auto' && !(COLORMAPS as readonly string[]).includes(q.colormap)) return { ok: false, message: `no colormap ${q.colormap}` };
			if (q.field !== undefined) fieldKey = q.field;
			if (q.component !== undefined) compUser = q.component;
			if (q.colormap !== undefined) cmPick = q.colormap as 'auto' | ColormapName;
			if (q.range !== undefined) ruleUser = q.range === 'p1-99' ? 'robust' : 'full';
			if (q.log !== undefined) scalePick = q.log ? 'log' : 'linear';
			if (q.contours !== undefined) contoursUser = q.contours;
			if (q.wire !== undefined) wireUser = q.wire;
			return { ok: true, ...(grp ? { message: `plot group ${grp.id} is drawn; the quick view applies after returning to it` } : {}) };
		}
	});
});
```

  `pick2d` already pins the dataset, applies mirroring and the display affine, and adds the row like a click. A 3D probe at a given point (not a surface pick) is optional: `probe3d(so, me, f, comp, P, [0, 0, 1], centre, diag)` then `probes.add(...)` as in `pick3d`.
- R2 (to the coordinator, `DevLog/contracts/CONTRACTS-v0.md` changelog): "2026-11-18 (E7, DevLog-053): agent tools `cancel_run`, `select_sweep_point`, `probe`, `quick_view` (navigation; optional `NavigationHost` methods `cancelRun`, `sweep`, `selectSweepPoint`, `probeAdd`, `probeList`, `probeRemove`, `quickView`, `setQuickView`; recorded in the trail); `set_camera` look_at takes a `preset` direction; `run_study.study` optional, default `StudyRunner.defaultStudy?()` (workbench: the study picker), else the first study; edit tools `edit_tree` and `define_sweep` (spec edits through the agent op log; host patch builders via `AgentSessionOptions.editor: ModelEditor`)."
- R3 (closed: E5 routed it): `Workbench.svelte navHost.setCamera` still answers "camera 'preset' is not implemented in v0 (fit only)" for callers other than the agent; the agent host bypasses it when `gfx/camera.ts` exists. E5 may route preset/look_at to `setCameraPreset` too.

## 7. Open items

- O1: closed 2026-11-18 14:03 PST (edit_tree, define_sweep; s.4).
- O2: Browser `probe` and `quick_view` depend on R1. Node and unit coverage complete.
- O3: Live DeepSeek call from the browser not made (no key in this lane; BYO only). The CORS preflight was checked on 2026-11-06 (DevLog-018 s.5); the POST response under COEP `require-corp` is still unverified until a user runs it.
- O4: Custom endpoints send `max_tokens` (Chat Completions); servers that only accept `max_completion_tokens` reject the request with their own message, shown in the chat. Not handled.
- O5: Share remains without a tool (writes the clipboard and the URL; not in this lane's scope).

## 8. Hand-off

Files: `packages/agent/src/{nav.ts, runner.ts, session.ts, chat.ts, prompt.ts, tools/schemas.ts, provider/openai-compatible.ts}`, `packages/agent/eval/fixtures.ts` (FeRunner `defaultStudy?`), `packages/agent/test/parity.test.ts`; `apps/web/src/lib/state/nav.svelte.ts`, `apps/web/src/lib/agent/{mount.ts, providers.ts (new), AgentPanel.svelte}`, `apps/web/vite.config.ts` (connect-src line), `apps/web/static/_headers`, `apps/web/scripts/base-check.ts`, `apps/web/test/e7-providers.test.ts`, `apps/web/test/e7-nav.test.ts`. Checks: agent test 71/71 and check clean; web test 91/91, svelte-check clean for E7 files (E5 in-progress errors exist in Workbench.svelte and test/e5-edit-ops.test.ts); base-check 27/27. No git run; no installs; no keys in any file.
