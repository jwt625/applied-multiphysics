// SPDX-License-Identifier: GPL-3.0-or-later
// OpenAI-compatible adapter and DeepSeek preset (DevLog-018 s.1.2). Mocked fetch only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatibleAdapter, DEEPSEEK_PRESET, isPeak, openaiBody, type FetchLike } from '../src/provider/openai-compatible.ts';
import { ProviderError, type ProviderRequest } from '../src/provider/types.ts';
import { wireProblems } from '../src/provider/wire.ts';
import { KeyStore } from '../src/keys.ts';
import { Agent } from '../src/loop.ts';
import { fixture } from '../eval/fixtures.ts';

// a made-up key of the DeepSeek shape (not a real credential)
const KEY = 'sk-0123456789abcdef0123456789abcdef';
const keys = () => { const k = new KeyStore(); k.set(KEY); return k; };

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }
function mockFetch(responses: Array<{ status?: number; json?: unknown; text?: string } | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => r.text ?? JSON.stringify(r.json) };
  };
  return { fetch, calls };
}
const completion = (message: Record<string, unknown>, finish: string, usage: Record<string, unknown> = {}) => ({
  id: 'x', object: 'chat.completion', model: 'deepseek-flash',
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }],
  usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 40 }, total_tokens: 1120, ...usage },
});
const toolCall = (id: string, name: string, args: string) => ({ id, type: 'function', function: { name, arguments: args } });
const REQ: ProviderRequest = {
  system: 'sys', tools: [{ name: 'zeta', description: 'z', input_schema: { type: 'object' } }, { name: 'alpha', description: 'a', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};
const noKey = (x: unknown) => { const s = typeof x === 'string' ? x : JSON.stringify(x); assert.ok(!s.includes(KEY) && !s.includes(KEY.slice(3, 15)), 'key leaked'); };

test('wire format: URL, headers, body keys, sorted function tools, preset extras; key only in the Authorization header', async () => {
  const m = mockFetch([{ json: completion({ content: 'hello' }, 'stop') }]);
  const a = createOpenAICompatibleAdapter({ keys: keys(), fetch: m.fetch, preset: DEEPSEEK_PRESET });
  const r = await a.send(REQ);
  const c = m.calls[0]!;
  assert.equal(c.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(c.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(c.body).sort(), ['max_tokens', 'messages', 'model', 'reasoning_effort', 'stream', 'thinking', 'tool_choice', 'tools']);
  assert.equal(c.body.model, 'deepseek-flash');
  assert.equal(c.body.stream, false);
  assert.equal(c.body.max_tokens, 16000);
  assert.deepEqual(c.body.thinking, { type: 'enabled' });
  assert.deepEqual((c.body.tools as Array<{ type: string; function: { name: string } }>).map((t) => `${t.type}:${t.function.name}`), ['function:alpha', 'function:zeta']);
  assert.deepEqual((c.body.messages as unknown[])[0], { role: 'system', content: 'sys' });
  noKey(c.body);
  noKey(r);
  assert.equal(r.stopReason, 'end_turn');
  assert.deepEqual(r.content, [{ type: 'text', text: 'hello' }]);
});

test('tool results become tool messages right after the assistant (images as data-URL parts), text after them', () => {
  const req: ProviderRequest = {
    system: 's', tools: [],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'get_spec', input: { pointer: '/params' } }, { type: 'tool_use', id: 'c2', name: 'screenshot', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'r1' }] },
        { type: 'tool_result', tool_use_id: 'c2', content: [{ type: 'text', text: 'img' }, { type: 'image', mediaType: 'image/png', base64: 'AAAA' }] },
        { type: 'text', text: 'feedback' },
      ] },
    ],
  };
  const ms = openaiBody(req, { model: 'm', maxTokens: 10, reasoning: 'replay', extraBody: {} }).messages as Array<Record<string, unknown>>;
  assert.deepEqual(ms.map((x) => x.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
  assert.deepEqual((ms[2]!.tool_calls as Array<{ function: { arguments: string } }>).map((t) => t.function.arguments), ['{"pointer":"/params"}', '{}']);
  assert.equal(ms[3]!.tool_call_id, 'c1');
  assert.equal(ms[3]!.content, 'r1');
  assert.deepEqual(ms[4]!.content, [{ type: 'text', text: 'img' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  assert.equal(ms[5]!.content, 'feedback');
  assert.equal(openaiBody({ ...req, tools: [] }, { model: 'm', maxTokens: 10, reasoning: 'replay', extraBody: {} }).tools, undefined);
});

test('reasoning_content: kept as an opaque block and replayed in every later request, within a turn and across turns', async () => {
  const fx = await fixture('kirsch-plate');
  const m = mockFetch([
    { json: completion({ content: '', reasoning_content: 'R1 think', tool_calls: [toolCall('call_1', 'get_spec', '{"pointer":"/params/D"}')] }, 'tool_calls') },
    { json: completion({ content: 'D is 10 mm.', reasoning_content: 'R2 think' }, 'stop') },
    { json: completion({ content: 'Still 10 mm.', reasoning_content: 'R3 think' }, 'stop') },
  ]);
  const a = createOpenAICompatibleAdapter({ keys: keys(), fetch: m.fetch, preset: DEEPSEEK_PRESET });
  const ag = new Agent({ session: fx.session, provider: a });
  const r1 = await ag.runTurn('What is D?');
  assert.equal(r1.stop, 'end_turn');
  assert.equal(r1.text, 'D is 10 mm.');
  const r2 = await ag.runTurn('And now?');
  assert.equal(r2.stop, 'end_turn');
  assert.equal(m.calls.length, 3);
  const assistants = (i: number) => (m.calls[i]!.body.messages as Array<Record<string, unknown>>).filter((x) => x.role === 'assistant');
  // call 2 (same turn): the tool-call message with its reasoning
  assert.deepEqual(assistants(1).map((x) => x.reasoning_content), ['R1 think']);
  assert.equal((assistants(1)[0]!.tool_calls as unknown[]).length, 1);
  // call 3 (next turn): both earlier assistant messages, reasoning included
  assert.deepEqual(assistants(2).map((x) => x.reasoning_content), ['R1 think', 'R2 think']);
  const roles = (m.calls[2]!.body.messages as Array<{ role: string }>).map((x) => x.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
  for (const c of m.calls) noKey(c.body);
  assert.deepEqual(wireProblems({ messages: ag.messages.concat([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]) }), []);
});

test("reasoning 'drop' omits reasoning_content from replayed messages", async () => {
  const fx = await fixture('kirsch-plate');
  const m = mockFetch([
    { json: completion({ content: '', reasoning_content: 'R1', tool_calls: [toolCall('call_1', 'get_spec', '{}')] }, 'tool_calls') },
    { json: completion({ content: 'ok' }, 'stop') },
  ]);
  const a = createOpenAICompatibleAdapter({ keys: keys(), fetch: m.fetch, preset: DEEPSEEK_PRESET, reasoning: 'drop' });
  await new Agent({ session: fx.session, provider: a }).runTurn('x');
  const asst = (m.calls[1]!.body.messages as Array<Record<string, unknown>>).find((x) => x.role === 'assistant')!;
  assert.equal('reasoning_content' in asst, false);
  assert.equal((asst.tool_calls as unknown[]).length, 1);
});

test('usage: cache miss -> input, cache hit -> cacheRead, reasoning reported; cost at peak and time-of-use prices', async () => {
  const m = mockFetch([{ json: completion({ content: 'x' }, 'stop') }]);
  const a = createOpenAICompatibleAdapter({ keys: keys(), fetch: m.fetch, preset: DEEPSEEK_PRESET });
  const r = await a.send(REQ);
  assert.deepEqual(r.usage, { inputTokens: 200, outputTokens: 120, cacheReadTokens: 800, cacheWriteTokens: 0 });
  assert.equal(r.reasoningTokens, 40);
  assert.deepEqual(a.price!('deepseek-flash'), { input: 0.3, output: 1.2, cacheRead: 0.006 });
  assert.equal(a.price!('gpt-unknown'), null);
  const sat = new Date('2026-11-07T03:00:00Z'); // Saturday
  const tue = (h: string) => new Date(`2026-11-10T${h}:00Z`);
  const p = DEEPSEEK_PRESET.prices['deepseek-flash']!;
  assert.equal(isPeak(p, sat), false);
  assert.deepEqual([tue('00:59'), tue('01:00'), tue('03:59'), tue('04:00'), tue('05:59'), tue('06:00'), tue('09:59'), tue('10:00')].map((d) => isPeak(p, d)), [false, true, true, false, false, true, true, false]);
  const tou = createOpenAICompatibleAdapter({ keys: keys(), fetch: m.fetch, preset: DEEPSEEK_PRESET, pricing: 'time-of-use', now: () => sat });
  assert.deepEqual(tou.price!('deepseek-flash'), { input: 0.15, output: 0.6, cacheRead: 0.003 });
});

test('errors are classified and redacted (the key never appears in a message, even when the server echoes it)', async () => {
  const cases: Array<[{ status?: number; json?: unknown; text?: string } | Error, string]> = [
    [{ status: 401, json: { error: { message: `Authentication Fails, your api key: ${KEY} is invalid` } } }, 'auth'],
    [{ status: 402, json: { error: { message: 'Insufficient Balance' } } }, 'billing'],
    [{ status: 429, text: `slow down Bearer ${KEY}` }, 'rate_limit'],
    [{ status: 400, json: { error: { message: 'reasoning_content missing' } } }, 'bad_request'],
    [{ status: 422, json: { error: { message: 'invalid param' } } }, 'bad_request'],
    [{ status: 503, text: 'overloaded' }, 'server'],
    [new TypeError(`fetch failed for ${KEY}`), 'network'],
    [Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'aborted'],
    [{ json: completion({ content: '' }, 'insufficient_system_resource') }, 'server'],
    [{ text: 'not json' }, 'other'],
  ];
  for (const [resp, kind] of cases) {
    const a = createOpenAICompatibleAdapter({ keys: keys(), fetch: mockFetch([resp]).fetch, preset: DEEPSEEK_PRESET });
    await assert.rejects(a.send(REQ), (e: unknown) => {
      assert.ok(e instanceof ProviderError, String(e));
      assert.equal(e.kind, kind, `${kind}: ${e.message}`);
      noKey(e.message); noKey(String(e.stack)); noKey(JSON.stringify(e));
      return true;
    });
  }
  const none = createOpenAICompatibleAdapter({ keys: new KeyStore(), fetch: mockFetch([]).fetch, preset: DEEPSEEK_PRESET });
  await assert.rejects(none.send(REQ), (e: unknown) => e instanceof ProviderError && e.kind === 'no_key');
});

test('stop mapping: length -> max_tokens, content_filter -> refusal; unparseable tool arguments retried, then invalid_tool_input', async () => {
  const len = createOpenAICompatibleAdapter({ keys: keys(), fetch: mockFetch([{ json: completion({ content: 'cut' }, 'length') }]).fetch, preset: DEEPSEEK_PRESET });
  assert.equal((await len.send(REQ)).stopReason, 'max_tokens');
  const cf = await createOpenAICompatibleAdapter({ keys: keys(), fetch: mockFetch([{ json: completion({ content: '' }, 'content_filter') }]).fetch, preset: DEEPSEEK_PRESET }).send(REQ);
  assert.equal(cf.stopReason, 'refusal');
  assert.equal(cf.stopDetails?.category, 'content_filter');
  const bad = { json: completion({ content: '', tool_calls: [toolCall('c', 'apply_ops', '{"ops": [')] }, 'tool_calls') };
  const good = { json: completion({ content: '', tool_calls: [toolCall('c', 'apply_ops', '{"ops":[]}')] }, 'tool_calls') };
  const once = mockFetch([bad, good]);
  const r = await createOpenAICompatibleAdapter({ keys: keys(), fetch: once.fetch, preset: DEEPSEEK_PRESET }).send(REQ);
  assert.equal(once.calls.length, 2);
  assert.deepEqual(r.content.find((b) => b.type === 'tool_use'), { type: 'tool_use', id: 'c', name: 'apply_ops', input: { ops: [] } });
  const always = mockFetch([bad]);
  await assert.rejects(createOpenAICompatibleAdapter({ keys: keys(), fetch: always.fetch, preset: DEEPSEEK_PRESET }).send(REQ), (e: unknown) => e instanceof ProviderError && e.kind === 'invalid_tool_input');
  assert.equal(always.calls.length, 3);
});

test('a locally invalid request is refused before any fetch', async () => {
  const m = mockFetch([{ json: completion({ content: 'x' }, 'stop') }]);
  const a = createOpenAICompatibleAdapter({ keys: keys(), fetch: m.fetch, preset: DEEPSEEK_PRESET });
  await assert.rejects(a.send({ system: 's', tools: [], messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }] }), (e: unknown) => e instanceof ProviderError && e.kind === 'bad_request');
  assert.equal(m.calls.length, 0);
});

test('wireProblems reads OpenAI raw assistant messages through their neutral blocks (an unanswered tool call is caught)', () => {
  const raw = { provider: 'openai-compatible', content: [{ role: 'assistant', content: '', tool_calls: [toolCall('c1', 'get_spec', '{}')] }] };
  const asst = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'c1', name: 'get_spec', input: {} }], raw };
  const u = { role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }] };
  assert.deepEqual(wireProblems({ messages: [u, asst, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'r' }] }] }] }), []);
  assert.equal(wireProblems({ messages: [u, asst, u] }).length, 1);
});

test('mountAgent with openaiCompatible: DeepSeek adapter, key stored under its own name only after opt-in', async () => {
  const { mountAgent } = await import('../src/chat.ts');
  const { memoryBackend } = await import('../src/memory/backends.ts');
  const { RecordingNavHost } = await import('../src/nav.ts');
  const fx = await fixture('kirsch-plate');
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const m = mockFetch([{ json: completion({ content: 'hi' }, 'stop') }]);
  const chat = await mountAgent({ log: fx.log, registry: fx.registry, nav: new RecordingNavHost(), memoryBackend: memoryBackend({}), storage, openaiCompatible: { preset: DEEPSEEK_PRESET, fetch: m.fetch } });
  chat.setKey(KEY);
  assert.equal(store.size, 0);
  chat.setKey(KEY, true);
  assert.deepEqual([...store.keys()], ['amp.agent.provider-key.deepseek']);
  await chat.send('hello');
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0]!.url, 'https://api.deepseek.com/chat/completions');
  noKey(m.calls[0]!.body);
});
