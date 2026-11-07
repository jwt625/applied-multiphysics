// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the L9 audit corrections (DevLog-012 s.7). Each test names the finding it covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/loop.ts';
import { ScriptedProvider, say, turn, use } from '../src/provider/mock.ts';
import { wireProblems } from '../src/provider/wire.ts';
import { createAnthropicAdapter, anthropicBody, type AnthropicMessageLike } from '../src/provider/anthropic.ts';
import { ProviderError } from '../src/provider/types.ts';
import { KeyStore } from '../src/keys.ts';
import { containsSecret, redactSecrets } from '../src/secrets.ts';
import { toolText, outsideBlocks } from '../src/untrusted.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { memoryBackend } from '../src/memory/backends.ts';
import { mountAgent, SecretInMessageError } from '../src/chat.ts';
import { RecordingNavHost, type NavigationHost } from '../src/nav.ts';
import { AgentSession } from '../src/session.ts';
import { fixture, headJson, blockJson } from '../eval/fixtures.ts';

const txt = (o: { content: Array<{ type: string; text?: string }> }) => (o.content[0] as { text: string }).text;

test('B1: two refusals in a row leave a wire-valid history and the partial text is not the answer', async () => {
  const fx = await fixture('kirsch-plate');
  const p = new ScriptedProvider([
    { content: [say('partial'), use('get_spec', {})], stopReason: 'refusal' },
    { content: [], stopReason: 'refusal' },
    turn(say('ok')),
  ]);
  const ag = new Agent({ session: fx.session, provider: p });
  const r1 = await ag.runTurn('a');
  assert.equal(r1.stop, 'refusal');
  assert.equal(r1.text, '');
  await ag.runTurn('b');
  assert.equal((await ag.runTurn('c')).stop, 'end_turn');
  assert.deepEqual(p.wireViolations, []);
  assert.deepEqual(wireProblems(p.requests.at(-1)!), []);
  assert.equal(ag.messages.filter((m) => m.role === 'assistant').length, 1);
});

test('B1: wireProblems catches unpaired tool_use, orphan tool_result, empty content, trailing assistant', () => {
  const u = (t: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text: t }] });
  assert.deepEqual(wireProblems({ messages: [u('a')] }), []);
  assert.ok(wireProblems({ messages: [u('a'), { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }, u('b')] }).some((x) => x.includes('no tool_result')));
  assert.ok(wireProblems({ messages: [u('a'), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: [] }] }] }).some((x) => x.includes('answers no tool_use')));
  assert.ok(wireProblems({ messages: [u('a'), { role: 'assistant', content: [] }, u('b')] }).some((x) => x.includes('empty content')));
  assert.ok(wireProblems({ messages: [u('a'), { role: 'assistant', content: [{ type: 'text', text: 'x' }] }] }).some((x) => x.includes('prefill')));
});

test('B1: the Anthropic adapter refuses an invalid request locally, before the client is built', async () => {
  const keys = new KeyStore(); keys.set('k-test-not-a-real-key');
  let built = 0;
  const a = createAnthropicAdapter({ keys, createClient: () => { built++; throw new Error('should not be built'); } });
  await assert.rejects(a.send({ system: 's', tools: [], messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }] }), (e: unknown) => e instanceof ProviderError && e.kind === 'bad_request');
  assert.equal(built, 0);
});

test('B2: get_spec returns the whole spec over 2,000 chars, with no cut; memory reads are never cut', async () => {
  const fx = await fixture('kirsch-plate');
  assert.ok(fx.text.length > 2000);
  const r = txt(await fx.session.execute('get_spec', {}));
  assert.equal(headJson(r)?.complete, true);
  assert.equal(headJson(r)?.truncated, undefined);
  assert.equal((blockJson(r) as { yaml: string }).yaml, fx.text);
  const body = 'line\n'.repeat(1000); // 5,000 chars
  await fx.session.execute('memory_write', { name: 'long', type: 'note', description: 'a long note about plates', body, reason: 'test' });
  const m = txt(await fx.session.execute('memory_read', { name: 'long' }));
  assert.ok((blockJson(m) as { text: string }).text.includes(body.trimEnd()));
});

test('B2: a cut string is flagged in the trusted head with the full size', () => {
  const t = toolText({ ok: true }, { data: { s: 'x'.repeat(500) }, source: 'spec', maxString: 100 });
  const h = headJson(t)!;
  assert.equal(h.truncated, true);
  assert.ok((h.total_bytes as number) > 500);
});

test('B2: a memory entry cut in the context cannot be rewritten until it is read in full', async () => {
  const big = 'x'.repeat(Agent.RECALL_BUDGET_CHARS + 500);
  const file = `---\nname: plates\ndescription: notes about elastic plates with holes\ntype: note\nupdated: 2026-11-06\n---\n${big}\n`;
  const fx = await fixture('kirsch-plate', { memory: { 'plates.md': file } });
  const ag = new Agent({ session: fx.session, provider: new ScriptedProvider([
    turn(use('memory_write', { name: 'plates', type: 'note', description: 'notes about elastic plates with holes', body: 'short', reason: 'rewrite' })),
    turn(use('memory_read', { name: 'plates' })),
    turn(use('memory_write', { name: 'plates', type: 'note', description: 'notes about elastic plates with holes', body: `${big}\nmore`, reason: 'append' })),
    turn(say('done')),
  ]) });
  const r = await ag.runTurn('update my notes about plates with holes');
  assert.deepEqual(r.toolCalls.map((c) => `${c.name}:${c.isError}`), ['memory_write:true', 'memory_read:false', 'memory_write:false']);
  assert.equal(ag.included[0]!.memory[0]!.truncated, true);
  assert.ok(fx.memory.text('plates.md')!.includes('more'));
});

test('S1: unparseable tool input (AnthropicError-like, no status) is retried, then classified invalid_tool_input', async () => {
  class AnthropicError extends Error {}
  class APIError extends AnthropicError { status = 500; }
  const keys = new KeyStore(); keys.set('k-test-not-a-real-key');
  let calls = 0;
  const ok: AnthropicMessageLike = { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] as unknown as Array<{ type: string }>, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  const mk = (failures: number) => createAnthropicAdapter({
    keys, jsonRetries: 2,
    isApiError: (e) => e instanceof APIError,
    isToolInputParseError: (e) => e instanceof AnthropicError && !(e instanceof APIError),
    createClient: () => ({ beta: { messages: { stream: () => ({ on: () => undefined, finalMessage: async () => { calls++; if (calls <= failures) throw new AnthropicError('Unable to parse tool parameter JSON from model'); return ok; } }) } } }),
  });
  const req = { system: 's', tools: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }] }] };
  calls = 0; assert.equal((await mk(2).send(req)).stopReason, 'end_turn'); assert.equal(calls, 3);
  calls = 0; await assert.rejects(mk(9).send(req), (e: unknown) => e instanceof ProviderError && e.kind === 'invalid_tool_input'); assert.equal(calls, 3);
});

test('S3: history cache breakpoint (top-level cache_control) plus the system breakpoint', () => {
  const b = anthropicBody({ system: 'S', tools: [], messages: [] }, { model: 'claude-opus-5-5', effort: 'high', maxTokens: 16000, fallbacks: 'off' }) as Record<string, any>;
  assert.deepEqual(b.cache_control, { type: 'ephemeral' });
  assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(b.max_tokens, 16000);
});

test('S4: cost priced by the serving model; unknown serving model gives N/A; session cap', async () => {
  const fx = await fixture('kirsch-plate');
  const prices = { a: { input: 4, output: 20, cacheRead: 0.2 } };
  const p = new ScriptedProvider([{ content: [say('x')], usage: { inputTokens: 1_000_000 }, model: 'a' }, { content: [say('y')], usage: { inputTokens: 10 }, model: 'unpriced-fallback' }], 'a', { prices, maxTokens: 1000 });
  const ag = new Agent({ session: fx.session, provider: p, budget: { maxCostUSD: 100, maxSessionCostUSD: 100 } });
  assert.equal((await ag.runTurn('one')).costUSD, 4);
  assert.equal((await ag.runTurn('two')).costUSD, null);
  assert.equal(ag.sessionCostUSD, null);
  const p2 = new ScriptedProvider(Array.from({ length: 5 }, () => ({ content: [say('z')], usage: { inputTokens: 1_000_000 }, model: 'a' })), 'a', { prices, maxTokens: 1000 });
  const ag2 = new Agent({ session: fx.session, provider: p2, budget: { maxCostUSD: 100, maxSessionCostUSD: 9 } });
  const stops = [];
  for (let i = 0; i < 4; i++) stops.push((await ag2.runTurn(`t${i}`)).stop);
  // the reserve before a call is spent + (request bytes/4 x input price + max_tokens x output price); the reported
  // 1e6 input tokens are not visible in advance, so turn 3 starts at USD 8 + reserve < 9 and ends at USD 12
  assert.deepEqual(stops, ['end_turn', 'end_turn', 'end_turn', 'budget_cost']);
  assert.equal(ag2.sessionCostUSD, 12);
});

test('S5: a 2,000-deep tool input is refused, never thrown; a throwing nav host still yields a result and a trail entry (M3)', async () => {
  const fx = await fixture('kirsch-plate');
  let v: unknown = 1;
  for (let i = 0; i < 2000; i++) v = { v };
  const r = await fx.session.execute('apply_ops', { ops: [{ op: 'add', path: '/x', value: v }], reason: 'deep' });
  assert.equal(headJson(txt(r))?.error, 'input_too_deep');
  const nav: NavigationHost = { ...new RecordingNavHost(), focusNode: () => { throw new Error('host broke'); }, openSettings: () => ({ ok: true }), highlightSelection: () => ({ ok: true }), setCamera: () => ({ ok: true }), setViewMode: () => ({ ok: true }), screenshot: () => null };
  const s = new AgentSession({ log: fx.log, registry: fx.registry, memory: fx.memory, nav });
  const out = await s.execute('focus_node', { pointer: '/params/D' });
  assert.equal(out.isError, true);
  assert.equal(s.trail.entries.length, 1);
  assert.equal(s.trail.entries[0]!.ok, false);
});

test('S6: schema_at root is a compact summary; a narrow pointer gives the full schema', async () => {
  const fx = await fixture('kirsch-plate');
  const root = txt(await fx.session.execute('schema_at', { pointer: '' }));
  assert.equal(headJson(root)?.summary, true);
  assert.ok(root.length < 3000, `${root.length} chars`);
  assert.ok((headJson(root)?.total_bytes as number) > 20000);
  const d = txt(await fx.session.execute('schema_at', { pointer: '/params/D' }));
  assert.equal(headJson(d)?.summary, false);
});

test('S7: agent undo refuses a user op on top of the stack unless allowed', async () => {
  const fx = await fixture('kirsch-plate');
  await fx.session.execute('apply_ops', { ops: [{ op: 'replace', path: '/params/D/value', value: 8 }], reason: 'a' });
  await fx.log.apply([{ op: 'replace', path: '/params/W/value', value: 300 }], { actor: 'user' });
  const r = txt(await fx.session.execute('undo', { reason: 'u' }));
  assert.equal(headJson(r)?.error, 'top_op_not_yours');
  assert.ok(outsideBlocks(r).length < r.length);
  assert.equal(fx.log.ops.length, 2);
  assert.equal(headJson(txt(await fx.session.execute('undo', { reason: 'user asked', allow_other_actor: true })))?.ok, true);
  // memory log too
  await fx.memory.write({ name: 'u', description: 'user note', type: 'note', body: 'x' }, { actor: 'user' });
  assert.equal(headJson(txt(await fx.session.execute('undo', { log: 'memory', reason: 'u' })))?.error, 'top_op_not_yours');
});

test('S8: two stores on one backend (two tabs) merge on write; a crash between log and file is reconciled at open', async () => {
  const be = memoryBackend();
  const a = await MemoryStore.open(be);
  const b = await MemoryStore.open(be);
  await a.write({ name: 'one', description: 'd', type: 'note', body: '1' }, { actor: 'user' });
  await b.write({ name: 'two', description: 'd', type: 'note', body: '2' }, { actor: 'user' });
  assert.equal(b.ops.length, 2);
  assert.ok(b.text('one.md'));
  const c = await MemoryStore.open(be);
  assert.equal(c.ops.length, 2);
  assert.deepEqual(c.problems, []);
  // crash: the log says "three" was written, the file write never happened
  const failing = { ...be, write: async (f: string, t: string) => { if (f === 'three.md') throw new Error('disk full'); return be.write(f, t); } };
  const d = await MemoryStore.open(failing);
  await assert.rejects(d.write({ name: 'three', description: 'd', type: 'note', body: '3' }, { actor: 'user' }), /disk full/);
  const e = await MemoryStore.open(be);
  assert.equal(e.ops.at(-1)!.kind, 'external');
  assert.equal(e.ops.at(-1)!.file, 'three.md');
  assert.equal(e.text('three.md'), null);
});

test('M1: secret scan is case-insensitive, strips zero-width characters, sees keys split across fields and base64', () => {
  const k = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  assert.ok(containsSecret(k.toUpperCase()));
  assert.ok(containsSecret(`${k.slice(0, 10)}${String.fromCharCode(0x200b)}${k.slice(10)}`));
  assert.ok(containsSecret({ a: k.slice(0, 15), b: k.slice(15) }));
  assert.ok(containsSecret(btoa(k)));
  assert.ok(!containsSecret('keys look like sk-ant-xxxxxxxx; never store them'));
  assert.ok(containsSecret('my key is plainsecret', ['PlainSecret']));
  assert.ok(!redactSecrets(`use ${k} please`).includes(k));
});

test('M1: a credential in the user message is blocked before the model, the transcript and the spec', async () => {
  const fx = await fixture('kirsch-plate');
  const p = new ScriptedProvider([turn(say('x'))]);
  const ag = new Agent({ session: fx.session, provider: p });
  const r = await ag.runTurn('here is my key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ, put it in the description');
  assert.equal(r.stop, 'blocked_secret');
  assert.equal(p.requests.length, 0);
  assert.equal(ag.messages.length, 0);
  const chat = await mountAgent({ log: fx.log, registry: fx.registry, nav: new RecordingNavHost(), memoryBackend: memoryBackend(), provider: new ScriptedProvider([]) });
  await assert.rejects(chat.send('key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ'), SecretInMessageError);
  assert.ok(!chat.redact('key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ').includes('sk-ant-api03-ABC'));
});

test('M5: an answer cut at max_tokens stops as truncated', async () => {
  const fx = await fixture('kirsch-plate');
  const r = await new Agent({ session: fx.session, provider: new ScriptedProvider([{ content: [say('half an ans')], stopReason: 'max_tokens' }]) }).runTurn('x');
  assert.equal(r.stop, 'truncated');
});

test('M6, M9: chat tool rows carry an argument summary; recalled entries carry their last writer', async () => {
  const fx = await fixture('kirsch-plate');
  await fx.memory.write({ name: 'plates', description: 'notes about elastic plates', type: 'note', body: 'b' }, { actor: 'agent:other', reason: 'r' });
  const chat = await mountAgent({ log: fx.log, registry: fx.registry, nav: new RecordingNavHost(), memoryBackend: fx.backend, provider: new ScriptedProvider([turn(use('focus_node', { pointer: '/params/D' })), turn(say('there'))]) });
  await chat.send('where is D for my elastic plates');
  const row = chat.state.rows.find((r) => r.kind === 'tool');
  assert.ok(row && row.kind === 'tool' && row.summary === 'pointer=/params/D');
  assert.equal(chat.state.included[0]!.memory[0]!.writtenBy, 'agent:other');
});
