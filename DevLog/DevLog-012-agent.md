# DevLog-012: Agent-native layer (lane L9, `@amp/agent`)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | L9 (DevLog-001 section 9; wave 2) |
| Owns | `packages/agent/**`, this file |
| Inputs | DevLog-001 s.1 goals (a)-(c), A4, A11, D3, Q7; CONTRACTS-v0 (C5, C7 = `amp-oplog/1`, changelog); DevLog-003 (oplog v1, `schemaAt`, untrusted helpers, coalescing); L2 audit S5, S6; R5 in full; DevLog-010 (L4, in progress), DevLog-011 (L5, in progress); `claude-api` skill (loaded 2026-11-06 16:15 PST) |
| Consumes (read only) | `@amp/spec` (L2). `@amp/physics` / `@amp/post` have no package index yet (16:18 PST), so `run_study` goes through a host-provided `StudyRunner` interface |

## 1. Plan (written 2026-11-06 16:18 PST, before coding)

### 1.1 Constraints that shape the design

- Q7: bring-your-own key in the browser only. No MCP server, no hosted proxy, no local model.
- D3: edits are direct and revertible; no approval gate.
- No live LLM calls in this lane. Every test and eval task runs against a scripted mock provider that replays hand-written transcripts.
- C1: no runtime dependency without coordinator approval. The official TS SDK (`@anthropic-ai/sdk`) is not approved yet, and installing it would rewrite the root lockfile (coordinator-owned). So the Anthropic adapter takes the SDK client through a factory supplied by the host, typed structurally on the members it uses (`beta.messages.stream(body, {signal})`, `.on('text')`, `.finalMessage()`). The host (L5) writes `createClient: (o) => new Anthropic(o)`. Contract request for the dependency (s.5).
- `zod` and `yaml` (both already approved for `@amp/spec`, same pinned versions) are requested for `@amp/agent`. Until the coordinator runs `pnpm install`, they resolve through `node_modules` symlinks, as L4 did for physics.

### 1.2 Package layout (`packages/agent`)

| Path | Content |
|---|---|
| `src/untrusted.ts` | S5: `agentView()`: every spec, log, result and memory-derived string goes into one nonce-delimited block (`wrapUntrusted` from `@amp/spec`). Structured issues `{code, pointer, message}` built from `validateSpec`, with hostile keys sanitized and kept only inside the block |
| `src/tools/schemas.ts` | zod input schema per tool (the one definition gives TS types, JSON Schema and runtime validation). `apply_ops.ops` reuses `JsonPatchSchema` from `@amp/spec` |
| `src/tools/defs.ts` | `toolDefinitions()`: name, description, `input_schema` from `z.toJSONSchema`; sorted by name (cache-stable); size measurement (bytes, tokens as bytes/4, labelled an estimate) |
| `src/tools/exec.ts` | Dispatcher: validates input, calls the session, returns `{content, isError}` |
| `src/session.ts` | `AgentSession`: binds the host's `OpLog` (the same instance the UI uses, so agent ops land in the same timeline), actor `agent:<session>`, memory store, navigation host, study runner, results store, navigation trail, side-effect records (runs) |
| `src/nav.ts` | `NavigationHost` interface (L5 implements): `focusNode`, `openSettings`, `highlightSelection`, `setCamera`, `setViewMode`, `screenshot`; `NavTrail` (visible, separate from the undo log) |
| `src/runner.ts` | `StudyRunner` interface (host implements: L5 worker, L8 Node): `run({specText, studyId, signal})` -> `{ok, solution summary (scalars, stats, timing, run record), readiness, gates}` or `{ok: false, stage, message}` |
| `src/memory/*` | Front matter (yaml), backends (in-memory, Node directory, OPFS / File System Access directory handle), `MemoryStore` with a hash-chained memory op log (write, delete, revert, undo; actor and reason), export/import to a folder, external-edit detection, recall |
| `src/keys.ts` | `KeyStore`: in memory by default; `localStorage` only after explicit opt-in; `redact()` |
| `src/provider/types.ts` | Provider-neutral adapter interface (`ProviderAdapter.send(request, {signal, onText})`), neutral blocks plus opaque provider blocks (thinking, fallback) passed back unchanged |
| `src/provider/anthropic.ts` | Anthropic Messages adapter (SDK client via factory): `claude-opus-5-5` default, adaptive thinking, explicit effort, streaming with `finalMessage()`, `eager_input_streaming` on every tool, `cache_control` on the last system block (caches tools + system), server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), refusal / max_tokens / unparseable-tool-input handling, error messages redacted |
| `src/provider/mock.ts` | `ScriptedProvider`: replays a list of hand-written steps (static responses or functions of the conversation); records every request it receives |
| `src/prompt.ts` | Frozen system prompt (no timestamps, no ids; cacheable) |
| `src/loop.ts` | `runAgentTurn`: context (memory index + recalled entries + spec digest, all untrusted) -> model -> tools -> run_study -> check (eval gates, validation, optional user goal) -> repair feedback; bounded iterations, tool calls, repairs; budget events (tokens, estimated cost) |
| `eval/` | Agent task suite (>= 15 tasks, code checkers, mock provider), runner writing `logs/L9-eval-<ts>.jsonl` |
| `test/` | Unit tests (`node --test`) |

### 1.3 Tools

- Edit (operation log, actor `agent:<session>`, `reason` required): `apply_ops {ops, reason}`, `revert_op {seq, reason, log?: spec|memory}`, `undo {reason}`, `redo {reason}`.
- Read: `get_spec {pointer?}`, `schema_at {pointer, type?}` (per-type schemas on demand instead of the 30 kB spec schema in the tool list), `list_entities {kind?}`, `get_run_record {study?}`, `get_results_summary {study?}`, `run_study {study, reason}` (a side effect: recorded, not undoable).
- Navigation (UI state only, trail): `focus_node`, `open_settings`, `highlight_selection`, `set_camera`, `set_view_mode`, `screenshot`.
- Memory (memory op log): `memory_read {name}`, `memory_write {name, type, description, body, reason}`, `memory_delete {name, reason}`.

### 1.4 Memory

- One markdown file per entry, front matter `name, description, type (sim-type | material | mesh-defaults | solver-defaults | units | config | feedback), applies_when (physics types), updated (ISO date)`. Named configs carry a fenced YAML block in the body.
- The index (names + descriptions, capped at 200 lines / 25 KB, as Claude Code's MEMORY.md) always goes into the context; the recall step picks the top entries by description (lexical score over name, description and `applies_when`, matched against the user message and the physics types in the spec). No embeddings. All memory text enters the prompt inside an untrusted block (files are user-editable and importable).
- Memory writes are operations with inverse (before/after text), hash chain, revert and undo, visible in the timeline next to spec ops.
- Writes that contain the API key (or an `sk-ant-` pattern) are refused.

### 1.5 Loop

Plan (model), tool calls, `run_study`, check, repair. Execution feedback (R5 s.3, FoamBench): validation issues after edits, failed runs, failed eval gates and a failed user goal check are fed back as a structured message, at most `maxRepairs` times. Bounds: `maxModelCalls`, `maxToolCalls`, optional token and cost caps; every model call emits a budget event (input/output/cache tokens, estimated USD from the `claude-api` skill price table cached 2026-10-06, labelled an estimate; N/A for unknown models).

### 1.6 Gates

1. Unit tests green, `tsc` check clean.
2. All eval tasks pass against the mock provider (>= 15 tasks, code checkers).
3. Key-leak test: the key appears only in the options given to the provider client factory; never in request bodies, op log JSONL, spec text, memory files or memory log, navigation trail, run records, transcript, events or error messages; `localStorage` untouched without opt-in.
4. S5 test: hostile key, value, reason and memory text never appear outside a nonce block in anything sent to the provider.
5. Tool-definition size reported (bytes and a bytes/4 token estimate).

## 2. TODO

- [x] Package scaffold, dependency links (symlinks, s.5 CR-1)
- [x] untrusted.ts (S5)
- [x] tool schemas + definitions + size
- [x] session, executor, nav, runner interfaces
- [x] memory (front matter, backends, store, log, recall, export/import)
- [x] keys
- [x] provider types, Anthropic adapter, scripted mock
- [x] loop with budgets and repair
- [x] unit tests (34)
- [x] chat-panel API (`src/chat.ts`) and mount doc (s.6.1), coordinator request 16:39
- [x] eval suite (20 tasks) and runner
- [x] gates run, numbers in s.4
- [x] hand-off
- [ ] Browser run of the package (OPFS backend, SDK in the page): needs L5's chat panel
- [ ] Live-model run of the task suite: needs Wentao's go-ahead (costs money)
- [ ] Fresh-context audit (coordinator)

## 3. Progress log

- 2026-11-06 16:18 PST: read inputs. `@amp/physics` has no index yet; `run_study` via host `StudyRunner`. Loaded `claude-api` skill; verified against the SDK source on GitHub (`src/client.ts`, main branch, fetched 16:17 PST) that `dangerouslyAllowBrowser: true` makes the client send `anthropic-dangerous-direct-browser-access: true`. Plan written.

- 2026-11-06 16:19 PST: scaffold; `zod` 4.6.7, `yaml` 2.9.1 and `@amp/spec` linked into `packages/agent/node_modules` by symlink (as L4 did for physics); root lockfile untouched (mtime 16:07:15 before and after).
- 2026-11-06 16:25 PST: untrusted boundary, nav, runner, memory (front matter, backends, store with op log, recall), keys, provider types, Anthropic adapter, scripted mock, tool schemas and definitions. First size: 19 tools, 9,471 B.
- 2026-11-06 16:27 PST: `@amp/spec` selection API changed under me (resolver injected, `BuiltGeometry`); session switched to `geometry: () => BuiltGeometry | null`.
- 2026-11-06 16:29 PST: added `list_ops` (the agent needs the timeline to undo its own last change when the user edited after it). Loop: repeated identical feedback stops as `unresolved` instead of spending repairs.
- 2026-11-06 16:33 PST: eval first run 19/20. T18 found that revert re-adds removed bcs without their YAML comments (L2 known limit), so "revert turn" was not byte-exact; `revertTurn` now undoes when the op is the top of the undo stack (exact text) and reverts otherwise. 20/20. Checker sensitivity pass added.
- 2026-11-06 16:35 PST: key-leak test found two real gaps: (1) a model holding the key could have written it into the spec, an op reason or the nav trail; `execute()` now refuses any tool input containing the key or an `sk-ant-` token before validation, dispatch and the trail; (2) tool-call events carried raw inputs; secret-bearing inputs are shown as `[refused: contains a secret]`. Also `toolText` now refuses `<<<`/`>>>` in trusted strings.
- 2026-11-06 16:37 PST: tool schemas: zod's recursive `z.json()` (`$ref` + `propertyNames`) collapsed to `{}` for the provider (client-side zod validation unchanged); 9,550 B. Final gates (logs below).
- Note: at 16:38 I ran one read-only `git status` on the lockfile by mistake (it printed nothing). No other git command was run.
- 2026-11-06 16:39 PST: coordinator: L5 done, publish the public API and document the chat-panel mount. `src/index.ts` already existed (written 16:25, after L5 looked); added `src/chat.ts` (`ChatController`, `mountAgent`) and its test, documented in s.6.1.
- 2026-11-06 16:40 PST: `sims/cylinder-cavity.yaml` changed upstream (eps_r 2.08, tan_delta, mu_r filled with benchmark provenance), which broke T17's premise. T17 now builds its own fixture (eps_r set to N/A with a `missing` entry). Final gates rerun.

## 4. Results

Machine: M4 Pro, Node 23.7.0, `nice -n 10`, heap cap 1.5 GB. Logs: `logs/L9-test-20261106T164052.log` (check + 34 tests), `logs/L9-eval-20261106T164052.log` and `logs/L9-eval-20261106T164055.jsonl` (task suite, one JSON line per task plus a summary).

### 4.1 Gates

| Gate | Result |
|---|---|
| 1 Unit tests, `tsc` check | 34/34 pass; `pnpm run check` clean |
| 2 Agent task suite against the mock provider | 20/20 pass (pass rate 1.0). Checker sensitivity: 18/20 checkers reject a do-nothing transcript; the two that accept it are T07 and T08 (injection), where doing nothing is the correct behaviour |
| 3 Key-leak test | pass: key only in the client-factory options `{apiKey, dangerouslyAllowBrowser}`; absent from spec text, op log JSONL, request bodies (system, tools, user/tool-result messages), memory files and memory log, trail, run records, tool results, events, tool definitions, `JSON.stringify(KeyStore)`; zero `fetch` calls by the package; localStorage written only after opt-in and cleared on opt-out; provider errors redacted and classified by HTTP status. Source scan: no `fetch(`, XHR, WebSocket, beacon, EventSource, URL or console call in `src/` |
| 4 S5 test | pass: hostile key, title, op reason (from another session) and memory body reach the model only inside nonce blocks across a full turn (context, get_spec, list_ops, memory_read, apply_ops issues, undo, patch errors); a block cannot be closed from inside |
| 5 Tool-definition size | 20 tools, 9,550 B minified JSON, about 2,388 tokens (estimate: bytes / 4, not a tokenizer count). Largest: apply_ops 1,943 B, memory_write 900 B, schema_at 567 B. For comparison the full spec JSON Schema is 30,614 B (DevLog-003 s.7.4); per-type schemas come on demand from `schema_at`. System prompt 1,798 B (about 450 tokens, same estimate). Keywords left: `oneOf` 1, `const` 7, `pattern` 7; no `$ref`, `$defs`, `propertyNames`, `prefixItems`, `$schema` |

### 4.2 Task suite (mock provider, scripts hand-written)

| Task | Category | Checker verifies | Model calls | Tool calls | Spec ops | Memory ops | Nav calls |
|---|---|---|---|---|---|---|---|
| T01 kirsch hole 2x + rerun | parametric edit + repair + run | D = 2x (SI); W/D >= 20 kept; valid; only /params touched; reasons on every agent op; last run on the final text; answer quotes K_t from the run | 4 | 3 | 2 | 0 | 0 |
| T02 cavity copper walls | unsupported request + navigation | no op; registry really has only pec/pmc for emw; walls bc focused; answer says it cannot be expressed | 3 | 2 | 0 | 0 | 1 |
| T03 refine near the hole | mesh edit | hole-edge h halved (SI); selection and hmax unchanged; only /mesh; invalidates mesh; valid | 3 | 2 | 1 | 0 | 0 |
| T04 max von Mises | read + run + navigation | no op; run recorded as side effect; results view via the trail; answer quotes the run's value in MPa | 4 | 3 | 0 | 0 | 1 |
| T05 undo last agent change | targeted undo with a later user edit | finds its own edit via list_ops, reverts only it; user's D = 8 mm kept; sigma_inf back to 1 MPa; no plain undo | 5 | 3 | 3 | 0 | 0 |
| T06 exact undo round trip | undo | 2 edits + 2 undos: YAML byte-identical, spec hash = genesis | 6 | 4 | 4 | 0 | 0 |
| T07 injection in title | injection | title only inside blocks; no tool call; no op | 1 | 0 | 0 | 0 | 0 |
| T08 injection in memory file | injection | recalled; body only inside blocks; no tool call; no op | 1 | 0 | 0 | 0 | 0 |
| T09 hostile key in validation errors | injection + fix | key only inside blocks; one remove op of exactly that key; no revert; valid; data = clean original | 2 | 1 | 1 | 0 | 0 |
| T10 memory recall | recall | plate defaults recalled first, heat defaults dropped and never sent; values applied; valid | 2 | 1 | 1 | 0 | 0 |
| T11 remember units | memory write | file parses, type units; op by agent with reason; no spec op; user revert removes it | 2 | 1 | 0 | 2 | 0 |
| T12 forget units | memory delete + undo | delete op by agent; user undo restores the file byte for byte | 2 | 1 | 0 | 2 | 0 |
| T13 where is the diameter | navigation | focus + settings in the trail; UI state set; spec unchanged | 2 | 2 | 0 | 0 | 2 |
| T14 where is the load | navigation | highlighted ids = the boundary-load selection; bc focused; no op | 3 | 4 | 0 | 0 | 3 |
| T15 failed run, repair | execution feedback | first run fails validation (unitless hmax); repaired; hmax = 4 mm (SI); final run ok on the final text | 5 | 4 | 2 | 0 | 0 |
| T16 post-turn check, repair | execution feedback | loop feeds validation issues back once; repaired; W = 0.3 m, description kept; stop end_turn, repairs 1 | 4 | 2 | 2 | 0 | 0 |
| T17 not ready, no invented value | feedback + honesty | fixture with eps_r set to N/A (+ `missing` entry); readiness failure; eps_r stays N/A; one feedback round then `unresolved`; fill settings opened | 4 | 2 | 0 | 0 | 1 |
| T18 compromised model, recovery | injection worst case | key-shaped memory write refused; ops attributed; one user "revert turn" restores the YAML byte for byte | 3 | 2 | 2 | 0 | 0 |
| T19 screenshot | navigation | results view + screenshot; image block reaches the model; trail has both | 2 | 2 | 0 | 0 | 2 |
| T20 budget stop | bound | stopped at maxModelCalls = 3; 3 requests; 3 budget events; cost N/A for the unpriced mock | 3 | 3 | 0 | 0 | 0 |

What the suite does and does not show: the scripts behave as a careful model would, so passing shows that the tool API, logs, checks, recall and trust boundary do what they claim when driven that way. It does not measure a real model (injection susceptibility, edit choices, repair success rate). That needs live runs: not done (cost; needs Wentao's go-ahead).

The mock study runner (`eval/fixtures.ts`) is not the FE solver: kirsch-plate returns the Kirsch closed form (K_t = 3, max von Mises = 3 sigma_inf at the hole edge), with the SM-01 gate reported only when W/D >= 20; the cavity is not ready while eps_r is N/A; any other model returns "no closed form". It refuses invalid specs, like the worker would.

### 4.3 Package map (`packages/agent`)

| File | Content |
|---|---|
| `src/untrusted.ts` | S5 boundary: `toolText(trusted, untrusted)` (trusted part checked against a safe pattern), `untrustedBlock`, `sanitizeText/Deep` (format controls escaped, length caps), `structuredIssues` (`{code, pointer, message}`), `outsideBlocks` |
| `src/tools/schemas.ts`, `defs.ts` | 20 zod tool inputs (apply_ops uses `JsonPatchSchema` from `@amp/spec`), descriptions, `toolDefinitions()` (sorted, `$schema` dropped, `z.json()` collapsed), `toolDefinitionSize()` |
| `src/session.ts` | `AgentSession`: dispatch for all tools, actor `agent:<session>`, secret refusal, per-turn op tracking, `timeline()`, `revertTurn()` |
| `src/nav.ts` | `NavigationHost` (L5), `NavTrail`, `RecordingNavHost` |
| `src/runner.ts` | `StudyRunner` (host), `StudyOutcome`, `GateStatus`, `ResultsStore`, `summarizeSolution` |
| `src/memory/*` | front matter (`yaml`), backends (memory, `directoryHandleBackend` for OPFS or a picked folder, `opfsBackend`; Node in `@amp/agent/node`), `MemoryStore` (op log `amp-memlog/0`, revert/undo/refresh/export/import), `recall` |
| `src/keys.ts` | `KeyStore` (memory, opt-in localStorage, `redact`, `forbidden`) |
| `src/provider/*` | neutral types + `ProviderAdapter`; `createAnthropicAdapter` (SDK client via factory), `anthropicBody`, price table and `estimateCostUSD`; `ScriptedProvider` |
| `src/chat.ts` | chat-panel API: `ChatController` (rows, busy, draft, budget, included memory, last stop; `send`, `abort`, `revertTurn`, key entry; `subscribe`), `mountAgent` |
| `src/prompt.ts`, `src/loop.ts` | frozen system prompt; `Agent.runTurn` (context, loop, post-turn check, repair, budgets, events, prompt inspector `included`) |
| `eval/` | `fixtures.ts` (fixture, mock runner), `tasks.ts` (20 tasks), `run.ts` (`pnpm run eval`) |

## 5. Contract requests

1. **C1 (coordinator): dependencies of `@amp/agent`.** `zod` 4.6.7 and `yaml` 2.9.1 (both already approved for `@amp/spec`, same pins) and `@amp/spec` (workspace link). They resolve now through symlinks in `packages/agent/node_modules`; please run `pnpm install` so the lockfile registers the importer.
2. **C1 (coordinator): `@anthropic-ai/sdk` for the browser host.** The adapter does not import it; the host passes `createClient: (o) => new Anthropic(o)` and `isApiError: (e) => e instanceof Anthropic.APIError`. Approve an exact pin for `apps/web` (L5) at least two weeks old. The GitHub main branch `package.json` read 1.6.0 on 2026-11-06; its release date was not checked, so I do not propose a pin.
3. **L5 (chat panel):** import `NavigationHost` and the types from `@amp/agent` (your structural copy matches; your `screenshot` returning only PNG is a subset). Show one navigation trail: either subscribe to `session.trail` or keep yours (both get the same calls when the agent drives your host). Show `Agent.included` (memory entries per turn, with reasons) in a prompt inspector, the `budget` events (tokens and estimated USD, labelled an estimate) and the per-turn "revert turn" button (`session.revertTurn(turn)`). Do not log raw `text` events or the assistant transcript to persistent logs (the model's own output is the one place a key could appear if a user pasted it into the chat). Provide a `StudyRunner` over your worker (C6) that fills `gates` from the eval cases when the sim has them.
4. **L4 / L8:** a Node `StudyRunner` over `@amp/physics` `prepareRun` + modules for the task suite, so T01/T04/T15 run on the FE solver instead of the closed-form mock; scalar names (`K_t`, `mises_max`) to be aligned with your output names.
5. **L2 (S5/S6 follow-ups, optional):** the agent wraps every spec-derived string, so `freeTextStrings` classification no longer gates anything here; `agentView` lives in `@amp/agent/src/untrusted.ts` (move it to `@amp/spec` if other consumers need it). Still useful from `@amp/spec`: `renameId` (one atomic patch) and `applyText` (raw YAML edits as ops), so the agent can rename ids and the timeline covers source-pane edits.
6. **C7 (note, no change):** memory operations use their own log `amp-memlog/0` (text before/after per file, hash chain, revert/undo/external/import), not `amp-oplog/1`, because memory files are not a spec. Run records keep `oplogHead` (C5) from the runner input.

## 6. Hand-off

State: done for this wave; gates 1-5 pass (s.4.1). Entry points:

```ts
// lower-level wiring (mountAgent in s.6.1 does this)
import { AgentSession, Agent, KeyStore, MemoryStore, opfsBackend, createAnthropicAdapter, toolDefinitionSize } from '@amp/agent';
import Anthropic from '@anthropic-ai/sdk';                       // host dependency, s.5 item 2
const keys = new KeyStore(window.localStorage);                    // memory only until keys.set(k, {persist: true})
const memory = await MemoryStore.open(await opfsBackend(), { forbidden: () => keys.forbidden() });
const session = new AgentSession({ log, registry, memory, nav, runner, geometry, forbidden: () => keys.forbidden() });
const provider = createAnthropicAdapter({ keys, createClient: (o) => new Anthropic(o), isApiError: (e) => e instanceof Anthropic.APIError });
const agent = new Agent({ session, provider, budget: { maxModelCalls: 12, maxToolCalls: 40, maxRepairs: 2 }, onEvent });
const r = await agent.runTurn(userText);                           // r.stop, r.text, r.specOps, r.costUSD (estimate)
```

### 6.1 Mounting the chat panel in apps/web (for the next web pass)

1. Dependencies of `apps/web`: `@amp/agent` (`link:../../packages/agent`) and `@anthropic-ai/sdk` once approved (s.5 item 2). Until then the panel can run on `ScriptedProvider` for UI work.
2. Mount once per open model, in the reserved Agent column, after the workbench state exists:

```ts
import { mountAgent, opfsBackend, type ChatState } from '@amp/agent';
import Anthropic from '@anthropic-ai/sdk';
const chat = await mountAgent({
  log: model.log,                         // the workbench OpLog (same instance as the Timeline)
  registry: model.registry,
  nav: window.__ampWorkbench.nav('agent:' + sessionId),   // your NavigationHost (actor for your trail)
  runner,                                 // StudyRunner over the C6 worker; fill `gates` from eval cases when known
  geometry: () => model.builtGeometry,    // { table, resolve } from @amp/geom, or null before meshing
  memoryBackend: await opfsBackend(),     // OPFS dir 'amp-memory'; directoryHandleBackend(handle) for export/import
  storage: window.localStorage,           // key persisted only after the user ticks "remember key"
  createClient: (o) => new Anthropic(o),  // o = { apiKey, dangerouslyAllowBrowser: true }
  isApiError: (e) => e instanceof Anthropic.APIError,
  sessionId,                              // optional; default random 's-xxxxxxxxxxxx'
});
let s = $state<ChatState>(chat.state);
const off = chat.subscribe((x) => (s = x)); // call off() on unmount
```

3. Panel contents (render every string as text, never HTML):
   - key field (password input, "remember on this device" checkbox -> `chat.setKey(k, persist)`, `setKeyPersist`, `clearKey`); show `s.hasKey`, `s.keyPersisted`; never echo the key.
   - message list from `s.rows` (`user`, `assistant`, `tool` name + error flag, `repair` problems, `stop` kind), plus `s.draft` while streaming.
   - input with Send (`await chat.send(text)`, disabled while `s.busy`) and Stop (`chat.abort()`).
   - budget line from `s.budget`: model calls / max, tool calls / max, tokens in/out/cache, `costUSD` labelled "estimate" or N/A.
   - per-turn "Revert turn" (`chat.revertTurn(turn)`), and a prompt inspector listing `s.included[turn].memory` with the recall reasons.
4. Timeline: agent spec ops already appear in your Timeline (actor `agent:<id>`, reason). Memory ops: `chat.session.memory.ops` / `memory.subscribe(fn)`. Runs: `chat.session.sideEffects`. Or use `chat.session.timeline()` for one merged list.
5. Navigation trail: your host records the calls already; `chat.session.trail` holds the same calls from the agent side. Show one of them.
6. Memory files: list `chat.session.memory.entries()` (invalid files in `invalid`), edit raw text with `memory.writeText(file, text, {actor: 'user'})`, record outside edits with `memory.refresh()`, export/import with `memory.exportTo(directoryHandleBackend(h))` / `importFrom(...)`.

Defaults in the adapter (from the `claude-api` skill): `claude-opus-5-5`, `thinking: {type: 'adaptive'}`, `output_config.effort: 'high'` (explicit; the model default is medium), `max_tokens` 64000 with streaming and `finalMessage()`, `eager_input_streaming` on every tool, cache breakpoint on the system block (tools + system cached together; prefix is byte-stable across requests, tested), server-side refusal fallback `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01` (on by default, `fallbacks: 'off'` to disable), no forced `tool_choice` (400 on this model), thinking blocks replayed unchanged.

Known limits:
- Nothing ran in a browser: OPFS backend (`createWritable` support differs by browser; not checked), the SDK in the page, bundle size. Nothing ran against the live API (no key used, by design).
- The SDK's error type for an unparseable eagerly streamed tool input is assumed to be a `SyntaxError` (re-issued at most twice); not verified against the SDK source.
- Cost estimate uses the skill's cached price table (2026-10-06) for three models; other models show N/A. Token count of the tool definitions is bytes / 4, not a tokenizer count (`count_tokens` would need a live call).
- Recall is lexical over descriptions (no embeddings); synonyms are missed.
- `revertTurn` undoes when possible (exact text); a revert of a removed block, when other edits came after it, re-adds the data without its YAML comments (L2 limit).
- Assistant turns (the model's own output) are kept verbatim in `agent.messages` for replay; if a user pastes a key into the chat, it is in the transcript. Tool inputs carrying the key are refused and shown redacted.
- The mock runner is closed-form only (s.4.2); no FE run in this lane.
