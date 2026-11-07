// SPDX-License-Identifier: GPL-3.0-or-later
// Key-leak gate (DevLog-012 s.1.6 gate 3). The BYO key goes only into the options of the provider client the adapter
// constructs (the SDK sends it to the provider endpoint). It never appears in request bodies, the op log, the spec,
// memory files or the memory log, the navigation trail, run records, the transcript, events or error messages, and
// localStorage holds it only after an explicit opt-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyStore, KEY_STORAGE_NAME, type KeyValueStorage } from '../src/keys.ts';
import { createAnthropicAdapter, anthropicBody, type AnthropicClientOptions, type AnthropicMessageLike } from '../src/provider/anthropic.ts';
import { ProviderError } from '../src/provider/types.ts';
import { Agent, type AgentEvent } from '../src/loop.ts';
import { toolDefinitions } from '../src/tools/defs.ts';
import { fixture } from '../eval/fixtures.ts';

const KEY = `sk-ant-api03-TEST-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

class MapStorage implements KeyValueStorage {
  m = new Map<string, string>();
  writes = 0;
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.writes++; this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

/** Fake SDK client: records the constructor options and every request body; replays Anthropic-shaped messages. */
function fakeSdk(script: AnthropicMessageLike[], fail?: unknown) {
  const options: AnthropicClientOptions[] = [];
  const bodies: string[] = [];
  let i = 0;
  const createClient = (o: AnthropicClientOptions) => {
    options.push({ ...o });
    return {
      beta: { messages: { stream: (body: Record<string, unknown>) => {
        bodies.push(JSON.stringify(body));
        return {
          on: (_e: 'text', _cb: (d: string) => void) => undefined,
          finalMessage: async () => { if (fail) throw fail; const m = script[i++]; if (!m) throw new Error('fake script exhausted'); return m; },
        };
      } } },
    };
  };
  return { createClient, options, bodies };
}

const msg = (content: Array<{ type: string; [k: string]: unknown }>, stop = 'tool_use'): AnthropicMessageLike => ({ model: 'claude-opus-5-5', content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } });

test('key store: memory by default, localStorage only after opt-in, cleared on opt-out', () => {
  const st = new MapStorage();
  const k = new KeyStore(st);
  k.set(KEY);
  assert.equal(st.writes, 0);
  assert.equal(st.getItem(KEY_STORAGE_NAME), null);
  assert.equal(JSON.stringify(k).includes(KEY), false);
  k.setPersist(true);
  assert.equal(st.getItem(KEY_STORAGE_NAME), KEY);
  assert.equal(new KeyStore(st).reveal(), KEY);
  k.setPersist(false);
  assert.equal(st.getItem(KEY_STORAGE_NAME), null);
  k.set(KEY, { persist: true });
  k.clear();
  assert.equal(st.getItem(KEY_STORAGE_NAME), null);
  assert.equal(k.reveal(), null);
});

test('key leak: a full agent turn with edits, memory, navigation and a run', async () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error('no network in tests'); }) as typeof fetch;
  try {
    const keys = new KeyStore(new MapStorage());
    keys.set(KEY);
    const fx = await fixture('kirsch-plate', { forbidden: () => keys.forbidden() });
    const sdk = fakeSdk([
      msg([{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tu1', name: 'apply_ops', input: { ops: [{ op: 'replace', path: '/params/D/value', value: 8 }], reason: 'test' } }]),
      msg([{ type: 'tool_use', id: 'tu2', name: 'memory_write', input: { name: 'units', type: 'units', description: 'units', body: 'mm', reason: 'test' } },
           { type: 'tool_use', id: 'tu3', name: 'focus_node', input: { pointer: '/params/D' } },
           { type: 'tool_use', id: 'tu4', name: 'run_study', input: { study: 'std1', reason: 'test' } }]),
      // a (hypothetically) compromised model that learned the key somehow tries to persist it
      msg([{ type: 'tool_use', id: 'tu5', name: 'memory_write', input: { name: 'leak', type: 'note', description: 'x', body: `key ${KEY}`, reason: 'x' } },
           { type: 'tool_use', id: 'tu6', name: 'apply_ops', input: { ops: [{ op: 'replace', path: '/description', value: KEY }], reason: 'x' } }]),
      msg([{ type: 'text', text: 'done' }], 'end_turn'),
    ]);
    const provider = createAnthropicAdapter({ keys, createClient: sdk.createClient });
    const events: AgentEvent[] = [];
    const agent = new Agent({ session: fx.session, provider, onEvent: (e) => events.push(e), budget: { maxRepairs: 0 } });
    const r = await agent.runTurn('change D and remember units');
    assert.equal(r.stop, 'end_turn');
    // both key-carrying calls were refused before they reached the spec, the memory store or the trail
    assert.deepEqual(r.toolCalls.map((c) => `${c.name}:${c.isError}`), ['apply_ops:false', 'memory_write:false', 'focus_node:false', 'run_study:false', 'memory_write:true', 'apply_ops:true']);
    // the only place the key goes: the client options, exactly {apiKey, dangerouslyAllowBrowser}
    assert.ok(sdk.options.length >= 1);
    for (const o of sdk.options) assert.deepEqual(Object.keys(o).sort(), ['apiKey', 'dangerouslyAllowBrowser']);
    assert.ok(sdk.options.every((o) => o.apiKey === KEY && o.dangerouslyAllowBrowser === true));
    assert.equal(fetchCalls, 0, 'the agent package made its own network call');
    // the memory store refused the key
    assert.equal(fx.memory.text('leak.md'), null);
    // scan every artifact the session produced
    const artifacts: Record<string, string> = {
      specText: fx.log.text,
      opLog: fx.log.toJSONL(),
      // what the app sends: system, tools and every user-role message (context, tool results). Assistant turns are
      // the provider's own output replayed to the same endpoint; here the scripted compromised model wrote the key there.
      requestBodies: sdk.bodies.map((b) => { const o = JSON.parse(b); return JSON.stringify([o.system, o.tools, o.messages.filter((m: { role: string }) => m.role === 'user')]); }).join('\n'),
      memoryFiles: JSON.stringify([...fx.backend.files.entries()]),
      memoryLog: fx.memory.toJSONL(),
      trail: JSON.stringify(fx.session.trail.entries),
      runs: JSON.stringify(fx.session.sideEffects) + JSON.stringify(fx.session.results.get('std1')),
      transcriptToolResults: JSON.stringify(agent.messages.filter((m) => m.role === 'user')),
      events: JSON.stringify(events),
      toolDefs: JSON.stringify(toolDefinitions()),
      keyStoreJson: JSON.stringify(keys),
    };
    for (const [name, text] of Object.entries(artifacts)) assert.equal(text.includes(KEY), false, `key found in ${name}`);
  } finally { globalThis.fetch = realFetch; }
});

test('key leak: the spec never carries the key because no tool can read it', async () => {
  // A model can only write into the spec what it was given. Nothing the agent sends contains the key (previous test:
  // request bodies), and no tool returns it. This checks the tool surface: no tool result ever includes the key.
  const keys = new KeyStore();
  keys.set(KEY);
  const fx = await fixture('kirsch-plate', { forbidden: () => keys.forbidden() });
  const outs = [];
  for (const [n, input] of [['get_spec', {}], ['list_entities', {}], ['list_ops', {}], ['schema_at', { pointer: '' }], ['get_run_record', {}], ['memory_read', { name: 'x' }]] as const) outs.push(JSON.stringify(await fx.session.execute(n, input)));
  assert.equal(outs.join('').includes(KEY), false);
  assert.equal(fx.log.toJSONL().includes(KEY), false);
  assert.equal(fx.log.text.includes(KEY), false);
});

test('provider errors are redacted and classified by status, not by message text', async () => {
  const keys = new KeyStore();
  keys.set(KEY);
  const sdk = fakeSdk([], Object.assign(new Error(`invalid x-api-key: ${KEY}`), { status: 401 }));
  const p = createAnthropicAdapter({ keys, createClient: sdk.createClient });
  await assert.rejects(p.send({ system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.kind, 'auth');
    assert.equal(e.message.includes(KEY), false);
    assert.ok(e.message.includes('[redacted key]'));
    return true;
  });
  const none = createAnthropicAdapter({ keys: new KeyStore(), createClient: sdk.createClient });
  await assert.rejects(none.send({ system: 's', tools: [], messages: [] }), (e: unknown) => e instanceof ProviderError && e.kind === 'no_key');
});

test('request body: model, adaptive thinking, effort, cache breakpoint, eager tool streaming, fallbacks; no key', () => {
  const b = anthropicBody({ system: 'SYS', tools: toolDefinitions(), messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { model: 'claude-opus-5-5', effort: 'high', maxTokens: 64000, fallbacks: 'default' }) as Record<string, any>;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.deepEqual(b.thinking, { type: 'adaptive' });
  assert.deepEqual(b.output_config, { effort: 'high' });
  assert.deepEqual(b.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
  assert.ok(b.tools.every((t: { eager_input_streaming?: boolean }) => t.eager_input_streaming === true));
  assert.deepEqual(b.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(b.fallbacks, 'default');
  assert.equal(b.tool_choice, undefined); // forced tool choice is a 400 on claude-opus-5-5
  assert.equal(JSON.stringify(b).includes('sk-ant'), false);
});

test('source scan: the package makes no network calls of its own and names no other endpoint', () => {
  // DevLog-018: the OpenAI-compatible adapter calls the host-injected `opts.fetch` and its DeepSeek preset names
  // https://api.deepseek.com (plus the pricing page it cites); nothing else in src/ may do either.
  const allowedUrl = /https:\/\/api\.deepseek\.com(?=['/])|https:\/\/api-docs\.deepseek\.com\/[a-z_/]+/g;
  const root = join(import.meta.dirname, '..', 'src');
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk(root);
  for (const f of files) {
    let code = readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    if (f.endsWith('openai-compatible.ts')) code = code.replace(/\bopts\.fetch\(/g, 'opts.injectedFetch(').replace(allowedUrl, 'ALLOWED_URL');
    for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /new WebSocket/, /sendBeacon/, /EventSource/, /https?:\/\//, /console\.(log|info|debug|warn|error)/]) {
      assert.equal(bad.test(code), false, `${f}: ${bad}`);
    }
  }
});
