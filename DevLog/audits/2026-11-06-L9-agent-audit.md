# Audit: L9 `@amp/agent` and DevLog-012 (fresh context)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Target | `packages/agent/**` (src, test, eval), `DevLog/DevLog-012-agent.md` |
| Inputs read | CLAUDE.md; DevLog-001 s.1 (c), A11, Q7, D3; CONTRACTS-v0 changelog (SDK pin 1.1.0, 16:41 entry); L2 audit S5, S6; R5 s.3-4 (headings and the S5/S6-related parts); `claude-api` skill (loaded 2026-11-06 for this audit) |
| SDK check | `@anthropic-ai/sdk@1.1.0` tarball from the npm registry (published 2026-10-21T22:03:12Z per `npm view ... time`), unpacked and installed in the audit scratch directory only (not in the repo). Type definitions read; adapter driven through the real SDK with a fake `fetch` (no network, no key, no live API call) |
| Edits | This file only. Rerunning the eval wrote `logs/L9-eval-20261106T164349.jsonl` (the runner always writes a log) |

## 0. Reruns (nice -n 10)

| Command | Result |
|---|---|
| `pnpm test` (packages/agent) | 34/34 pass, 0 fail |
| `pnpm check` (tsc) | exit 0 |
| `pnpm eval` | 20/20 tasks pass; checker sensitivity 18/20 reject a do-nothing transcript (T07, T08 accept it); tool definitions 20 tools, 9,550 B (~2,388 tokens, bytes/4 estimate) |

The auditee's numbers reproduce. Probe scripts used below (kept outside the repo):
`<session-scratchpad>/adapter-probe.mjs` (real SDK 1.1.0 + fake fetch), `.../scratchpad/sse-probe.mjs`, `.../scratchpad/sdk/inst/probe.ts` (tsc against SDK 1.1.0 types), `.../scratchpad/loop-probe.ts`, `.../scratchpad/depth-probe.ts`, `.../scratchpad/patch-probe.ts`, `.../scratchpad/schema-probe.ts`, `.../scratchpad/getspec-probe.ts`.

## 1. Verified correct (with evidence)

- Model and request shape against the skill: `claude-opus-5-5`; `thinking: {type: 'adaptive'}` (no `budget_tokens`, no `disabled`, both 400 on Opus 5.5); explicit `output_config.effort: 'high'` (Opus 5.5 default is `medium`); `max_tokens` 64000 with streaming and `finalMessage()`; `eager_input_streaming: true` on every client tool; no forced `tool_choice`; no sampling parameters (so the `2026-10-21` API version that SDK 1.1.0 sends is safe).
- Wire, captured from SDK 1.1.0 through the adapter: header `anthropic-beta: server-side-fallback-2026-07-01`, `anthropic-dangerous-direct-browser-access: true`, `anthropic-version: 2026-10-21`; body keys `model,max_tokens,system,tools,thinking,output_config,messages,fallbacks,stream`, `fallbacks: "default"`, `betas` not in the body; key absent from the body.
- SDK 1.1.0 types accept the claims: `BetaFallbacksParam = Array<BetaFallbackParam> | 'default'`; `server-side-fallback-2026-07-01` is in the `AnthropicBeta` union; `dangerouslyAllowBrowser` sets the browser header (`client.js` line 964). The skill says the scalar `"default"` form pairs with `-2026-07-01` (array form with `-2026-06-01`); the code pairs them correctly.
- Prompt caching of the prefix: tools sorted and cached once, frozen system prompt (no timestamps), breakpoint on the system block. Prefix is about 2,388 + 450 tokens (bytes/4 estimate), above the 512-token minimum the skill lists for Opus 5.5, so it caches.
- Tool loop: `refusal` and `max_tokens` checked before any tool runs; a `tool_use` cut at `max_tokens` is popped and not executed; parallel `tool_use` blocks get all `tool_result` blocks in one user message; calls past `maxToolCalls` get `is_error` results (no unpaired ids); thinking/fallback blocks replayed unchanged through `raw` (SDK `parsed_output` is non-enumerable, so raw replay serializes cleanly).
- Key handling: a 401 whose body echoes the key comes out as `invalid x-api-key [redacted key]`; network errors carry no key; `KeyStore.toJSON` hides it; localStorage only after opt-in.
- Untrusted boundary: a hostile op `reason` (including a fake closing marker) returned by `list_ops` stays inside the nonce block (`loop-probe.ts`); `wrapUntrusted` escapes `<<<AMP-UNTRUSTED` inside bodies, so a known nonce does not help.
- Patch input: `/__proto__/...`, `/params/__proto__`, `/constructor/prototype/...` are rejected (`patch_failed`), no pollution; `Infinity` values rejected at validation.
- Inspectability (goal c): every spec edit goes through the shared `OpLog` with actor `agent:<id>` and required reason; memory writes, deletes, reverts and undos are `amp-memlog/0` ops with exact before/after text; navigation calls (including failed ones) go to `NavTrail`; runs go to `sideEffects`; `timeline()` merges all four; `revertTurn` reverts spec and memory ops of a turn. No tool changes the spec or memory outside these paths (all 20 dispatch branches read).
- SDK pin: 1.1.0 is 16 days old on 2026-11-06, which meets the two-week rule in the contracts changelog.

## 2. Findings

### Blocking (before any real-model trial)

**B1. A refusal leaves the refused assistant message in history, which corrupts every later request.**
Evidence: `loop.ts` line 146 pushes the assistant message before the refusal check at line 149. `loop-probe.ts`: turn 1 refusal with partial text plus a `tool_use`, turn 2 refusal with empty content; the turn-3 request is `user | assistant:text+tool_use | user | assistant:(empty) | user`. The real API rejects a `tool_use` without a `tool_result` in the next user message and an empty non-final assistant message, so after one refusal every turn in that chat fails with a 400. `TurnResult.text` is the partial text ("partial"), and the skill says to discard partial output on a mid-stream refusal. `loop.test.ts` "refusal stops the turn" checks only that no tool ran.
Fix: on `refusal`, do not keep the assistant message (pop it as for `max_tokens`), set `text` to '' and show the category; add a wire-validity invariant (see S10) and a two-turn refusal test.

**B2. Every untrusted string is cut at 2,000 characters, including the whole-spec read, memory reads and recalled memory bodies.**
Evidence: `sanitizeDeep(data, max = 2000)` in `untrustedBlock`. `getspec-probe.ts`: `get_spec {}` on kirsch-plate returns `{"ok":true,"format":"yaml","head":0}` with the YAML ending `...[862 more chars]`; the trusted head has no truncation flag. All 18 files in `sims/` are larger than 2,000 B (smallest `coax-line.yaml` 2,060 B), so the main read path is always truncated. `memory_write` accepts a 20,000-char body, but `memory_read` returns only 2,000 (`...[3074 more chars]` for a 5,000-char body), and the loop's context block cuts recalled bodies the same way, so a read-modify-write of a long memory file by the agent loses data (revertible, but silent).
Fix: per-field caps (no cap or a large one for the spec YAML and memory bodies, up to their own schema maxima); `truncated: true` and the total length in the trusted head when anything is cut; paging (`get_spec {from_line, to_line}`) for large specs; a test with a spec over the cap.

### Significant

**S1. Unparseable tool input with SDK 1.1.0 is misclassified and never retried; the `jsonRetries` path is dead code.**
Evidence: `sse-probe.mjs` / `adapter-probe.mjs`: for `input_json_delta` fragments `{"ops": ` + `}`, `finalMessage()` rejects with `AnthropicError` ("Unable to parse tool parameter JSON from model ..."), not `SyntaxError`, with no `status`. The adapter checks `e instanceof SyntaxError`, so it throws `ProviderError` kind `network` after 1 call; the turn ends `provider_error`. DevLog-012 s.6 lists this as an unverified assumption; it is now verified false. The vendored partial parser is tolerant: `{"a": 1` parses to `{}` and `{"ops": [1,2` + `,"reason":"ab` to `{"ops":[1,2,"reason"]}`, so truncated input can parse silently (zod and the `max_tokens` check cover most of it, as the skill describes).
Fix: host predicate `isToolInputParseError: (e) => e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)` (or that test in the adapter through `isApiError`), retry at most `jsonRetries` times, then a clear kind; keep the probe as a test with the real SDK behind a fake `fetch` once the SDK is a dev dependency.

**S2. The documented wiring `createClient: (o) => new Anthropic(o)` does not type-check against SDK 1.1.0.**
Evidence: `sdk/inst/probe.ts` with the repo's tsc: `Type 'Anthropic' is not assignable to type 'AnthropicClientLike'` (`stream` body: `Record<string, unknown>` lacks `max_tokens, messages, model`), `BetaMessageStream<null>` not assignable to `AnthropicStreamLike`, and `BetaMessage` not assignable to `AnthropicMessageLike` (`Index signature for type 'string' is missing in type 'BetaTextBlock'`). `apps/web` runs `svelte-check --threshold error`, so the mount in DevLog-012 s.6.1 fails to compile without a cast. Runtime shapes match (probe ran).
Fix: loosen the structural types (`content: ReadonlyArray<{ type: string }>` read through narrow casts; `stream(body: never, ...)` or a generic), or add `@anthropic-ai/sdk` 1.1.0 as a type-only dev dependency of `@amp/agent` (coordinator decision, C1); add the probe as a compile test.

**S3. The conversation history is not cached.**
Evidence: the only `cache_control` is on the system block (`anthropicBody`). Each model call resends the full `messages` (context blocks with spec digest and memory, tool results, screenshots, `schema_at` output) at the full input price; in a 12-call turn the early tool results are billed up to 12 times. SDK 1.1.0 has the top-level `cache_control` body parameter (`messages.d.ts` line 7029), which the skill recommends for this case.
Fix: send top-level `cache_control: {type: 'ephemeral'}` (or a breakpoint on the last user block); keep the system breakpoint; in the first live run check `cache_read_input_tokens` grows across calls.

**S4. No default cost cap, and the caps are checked only before a call.**
Evidence: `DEFAULT_BUDGET = {maxModelCalls: 12, maxToolCalls: 40, maxRepairs: 2}`; `maxCostUSD` and `maxOutputTokens` undefined; `max_tokens` 64000. Worst-case output alone at the skill's Opus 5.5 price ($20/MTok): 12 x 64,000 x 20 / 1e6 = $15.36 per turn (an upper bound, not an expected cost; input not included). There is no session cap. The estimate prices by `provider.model`, not `resp.model`, so a server-side fallback to another model is priced at Opus 5.5 rates (or should be N/A).
Fix: a default `maxCostUSD` set by the user in the panel; check `cost + maxTokens x output price` before each call; a session cap; price by `resp.model` (N/A when unknown).

**S5. `AgentSession.execute()` can throw, and the loop does not catch it.**
Evidence: `depth-probe.ts`: `apply_ops` with a value nested 2,000 levels deep throws `RangeError` from `zod` `safeParse` (1,000 levels returns normally); `safeParse` is outside the `try` in `execute`, and `loop.ts` line 180 calls `execute` without a `try`. A throw rejects `runTurn` after the assistant `tool_use` is in history and before its `tool_result`, which leaves an unpaired id (same 400 as B1). The comment on `execute` says it never throws.
Fix: wrap each `execute` in the loop in `try/catch` that yields an `is_error` result; move `safeParse` inside the `try`; bound input depth and size before parsing.

**S6. `schema_at` results can be very large and are pretty-printed.**
Evidence: `schema-probe.ts`: `schema_at {pointer: ''}` returns 80,869 B (about 20k tokens, bytes/4 estimate), `/materials/@plate` 14,079 B, `/physics/-` with type `heat` 13,870 B, `/physics/@solid/bcs/@tension` 4,136 B. `untrustedBlock` uses `JSON.stringify(..., null, 1)`. With S3 unfixed each such result is re-billed on every later call of the turn. The on-demand design itself is right (S6 of the L2 audit) and the tool list is small (9,550 B).
Fix: minified JSON inside blocks; refuse the root and other shallow pointers above a size cap with a fixed hint ("narrow the pointer"); dedupe repeated subschemas via `$defs`.

**S7. The agent's `undo` undoes the newest op on the shared stack, including user edits.**
Evidence: `loop-probe.ts`: after a user edit of D, the agent tool `undo` reverts it (`targetBySelf: false`, reported only after the fact). The op is attributed and visible, so goal (c) holds, but T05 already treats plain undo as the wrong action when the user edited last.
Fix: `undo` refuses when the top op is not by this actor (`top_op_not_yours`, point to `revert_op`), or takes an explicit `allow_other_actor` flag.

**S8. Memory log consistency across tabs and failures.**
Evidence (code reading, `memory/store.ts`): each `MemoryStore` holds its own chain in memory and rewrites `memory-log.jsonl` whole on every commit; two tabs on the same OPFS directory overwrite each other's log, so ops disappear from the visible history. `commit` writes the file before the log, so a failure between the two leaves a change with no persisted op. `open()` loads files without comparing them to the log's final state, and `mountAgent` never calls `refresh()`, so such a change is never recorded as an `external` op.
Fix: `navigator.locks.request` around commits (browser), append-only log writes, `refresh()` at mount, and a mismatch check at open.

**S9. No Content-Security-Policy in apps/web.**
Evidence: `apps/web/static/_headers` sets COOP, COEP, CORP, nosniff, referrer and permissions policies, no CSP; `src/app.html` has none. With an opted-in key in localStorage, any script injection can read it and send it anywhere, while Q7 says the key goes only to the provider.
Fix (L5): CSP with `connect-src 'self' https://api.anthropic.com` and `script-src 'self'` (SvelteKit `kit.csp` handles its inline bootstrap); check that the CORS fetch to the API still works under COEP `require-corp` in the first browser run.

**S10. Task-suite gaps: outcomes are checked, but physics values are constants and the failure paths are untested.**
Evidence: checkers do test outcomes, not tool-call shapes: SI values (`si()`), touched paths, byte-identical text and genesis hash (T06, T18), navigation state, run side effects. Gaps:
- `MockClosedFormRunner` returns `K_t = 3` for any valid kirsch spec and `mises_max = 3 sigma_inf`, so "answer quotes K_t from the run" (T01, T15) and T04 test plumbing, not physics. Acknowledged in DevLog-012 s.4.2.
- T01 regex `/K_t = 3\b/` also accepts "K_t = 3.5".
- T07 and T08 checks do not depend on the script (the wrapping is done by the harness); they are harness tests labelled as tasks.
- Sensitivity is measured only against a do-nothing model. No "plausible but wrong" mutants (wrong path, wrong value, plain undo in T05, a number quoted without a run in T04).
- No task or test covers: a refusal followed by another turn (would have caught B1), malformed tool JSON (S1), a provider error then a new turn, a spec over 2,000 chars (would have caught B2), abort mid-run, a cost cap, an invalid tool input followed by repair.
- No check that each recorded request would be valid on the wire (role alternation or merge, every `tool_use` answered in the next user message, non-empty content).
Fix: a wire-validity invariant run on every `ScriptedProvider` request in every task; 3-5 mutant scripts per category; the missing failure-path tasks; T01/T04/T15 on the FE runner when L4/L8 deliver it (DevLog-012 s.5 item 4).

### Minor

**M1. `sk-ant-` heuristic.** `loop-probe.ts`: false negatives for a key split across two fields, with a zero-width space, base64-encoded, or upper-cased; false positive for "keys look like sk-ant-xxxxxxxx; never store them". The exact-key `forbidden` check has the same blind spots. Impact is low because the key never enters model context, except when the user pastes it into the chat: user text is not checked and goes to the model, `Agent.messages` and chat rows. Fix: check user text before sending (warn, offer redaction); normalize (NFKC, strip format controls, case-fold) before matching.

**M2. Screenshots.** The image reaches the model outside any untrusted wrapper and can show rendered spec text (title, tree labels); a `workbench` capture can include the key field. Fix: exclude the chat and key panel from captures; one line in the system prompt that images are data too.

**M3. Navigation trail on host exceptions.** `trail.record` runs only after `dispatch` returns; a throwing `NavigationHost` method leaves no trail entry although the UI may have changed. Fix: record in `finally` with `ok: false`.

**M4. Error kinds.** `adapter-probe.mjs`: a failed `fetch` (SDK `APIConnectionError`) is classified `other`, malformed JSON `network`. `createClient` and `anthropicBody` run outside the adapter's `try`, so an exception there is not redacted. Fix: kind by SDK class through host predicates; move both into the `try`.

**M5. `max_tokens` without a tool call** ends the turn as `end_turn` with truncated text. Fix: stop kind `truncated` with a note.

**M6. Chat rows** show only the tool name and an error flag; `ChatController` ignores `tool_call` events, so read-tool arguments (pointer, study) are invisible in the panel. Fix: a short trusted argument summary per tool row.

**M7. Progress text.** On Opus 5.5 text between tool calls comes back as empty thinking blocks unless `thinking.display: 'updates'` (beta `thinking-display-updates-2026-08-18`, per the skill); the panel will show nothing between tool calls. Consider it for goal (c); measure cost in the live run.

**M8. Memory privacy.** `memory-log.jsonl` keeps full before/after text forever, so deleted memory content persists there and in `exportTo`. Document it; offer a user-initiated log compaction.

**M9. Persistent injection via memory.** A memory file written in a compromised turn is auto-recalled in later sessions (inside the untrusted block). Fix: show the last writer (actor) per recalled entry in the context and a badge in the prompt inspector.

**M10. DevLog drift.** Plan s.1.2 lists `src/tools/exec.ts` and `runAgentTurn` (dispatch is in `session.ts`, the API is `Agent.runTurn`); s.1.4 type list lacks `note`; s.6 known limit on `SyntaxError` should record the verified behaviour (S1); s.5 item 2 (no pin proposed) is superseded by the 1.1.0 pin.

## 3. Missing before a real-model trial

1. FE `StudyRunner` in apps/web: an adapter from `EngineClient` (`apps/web/src/lib/engine/client.ts`) `RunOutcome` to `StudyOutcome` (`result` -> `summarizeSolution`, `unavailable` -> readiness, `error` -> stage/message; gates from the paired eval case). `EngineClient` keeps one run in flight and a new run cancels the previous one, so the agent needs its own client or a queue, or agent runs will cancel user runs and the reverse. Scalar names (`K_t`, `mises_max`) to be aligned with physics output.
2. Browser memory backend: `opfsBackend` (`createWritable`) has not run in any browser; multi-tab locking (S8); `refresh()` at mount.
3. Chat-panel mount: apps/web has no `@amp/agent` or `@anthropic-ai/sdk` dependency yet (placeholder text in `Workbench.svelte` line 175); its `NavigationHost` is a structural copy (`nav.svelte.ts`); S2 type fix; CSP (S9); key field excluded from screenshots (M2).
4. B1, B2, S1, S3, S4, S5 fixed and covered by tests; a default cost cap visible in the panel.
5. A live-run harness (on Wentao's go-ahead): the task suite against the real adapter with a hard cost cap, per-call `usage` logged (cache reads/writes), transcripts logged with the key redacted, `count_tokens` for the tool definitions instead of bytes/4.
6. Bundle check of SDK 1.1.0 in the static build (it depends on `@opentelemetry/api`, `standardwebhooks`, `json-schema-to-ts`; size not measured).
