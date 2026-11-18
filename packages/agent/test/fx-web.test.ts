// SPDX-License-Identifier: GPL-3.0-or-later
// Fix lane FX-web (DevLog-057): quick_view refuses a component outside the shown field's components (items 3), the
// define_sweep schema bounds n (item 6), and a custom OpenAI-compatible endpoint keeps its key under its per-origin
// name and calls only that endpoint (item 10). Mocked fetch only; no network. Expected values written out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type QuickViewInfo } from '../src/nav.ts';
import { TOOL_INPUTS } from '../src/tools/schemas.ts';
import { fixture, headJson } from '../eval/fixtures.ts';
import type { FetchLike, ProviderPreset } from '../src/provider/openai-compatible.ts';

const txt = (o: { content: Array<{ type: string; text?: string }> }) => (o.content[0] as { text: string }).text;
const view = (components: string[]): QuickViewInfo => ({
  field: components.length ? 'u' : 'T', fields: ['T', 'u'], component: components.length ? -1 : null, components, colormap: 'auto', colormaps: ['viridis'],
  range: 'full', log: false, logAvailable: true, contours: false, wire: false, plotGroup: null,
});

test('quick_view: a component outside the shown field is refused before the view is touched', async () => {
  const fx = await fixture('kirsch-plate');
  fx.nav.view = view(['0', '1']);
  const bad = await fx.session.execute('quick_view', { component: 2 });
  assert.equal(headJson(txt(bad))?.error, 'component_out_of_range');
  assert.match(txt(bad), /field u has 2 components: use -1 \(magnitude\) or 0 \.\. 1/);
  assert.equal(fx.nav.calls.filter((c) => c.method === 'setQuickView').length, 0);
  assert.equal(headJson(txt(await fx.session.execute('quick_view', { component: 1 })))?.ok, true);
  assert.equal(headJson(txt(await fx.session.execute('quick_view', { component: -1 })))?.ok, true);
  fx.nav.view = view([]);
  assert.equal(headJson(txt(await fx.session.execute('quick_view', { component: 1 })))?.error, 'component_out_of_range');
  assert.equal(headJson(txt(await fx.session.execute('quick_view', { component: 0 })))?.ok, true);
  // beyond the schema bound: invalid input
  assert.equal(headJson(txt(await fx.session.execute('quick_view', { component: 16 })))?.error, 'invalid_input');
});

test('define_sweep schema: range n in 2 .. 200', () => {
  const s = TOOL_INPUTS.define_sweep;
  const ax = (n: number) => ({ id: 'sw', study: 's', axes: [{ param: 'D', start: '1', stop: '2', n }], reason: 'r' });
  assert.equal(s.safeParse(ax(200)).success, true);
  assert.equal(s.safeParse(ax(201)).success, false);
  assert.equal(s.safeParse(ax(1)).success, false);
});

test('custom OpenAI-compatible endpoint: key under amp.agent.provider-key.custom:<origin>, fetch only at that endpoint', async () => {
  const { mountAgent } = await import('../src/chat.ts');
  const { memoryBackend } = await import('../src/memory/backends.ts');
  const { RecordingNavHost } = await import('../src/nav.ts');
  const fx = await fixture('kirsch-plate');
  // as apps/web agent/mount.ts customPreset(baseURL, model): name `custom:<origin>`, no price table
  const preset: ProviderPreset = { name: 'custom:https://llm.example.org', baseURL: 'https://llm.example.org/v1', model: 'm1', prices: {}, pricingSource: { url: '', accessed: '', note: 'no price table: cost N/A' }, reasoning: 'drop', extraBody: {} };
  // a made-up key (not a real credential); another provider's stored key must not be read
  const KEY = 'test-key-custom-endpoint-0001';
  const store = new Map<string, string>([['amp.agent.provider-key.deepseek', 'test-key-deepseek-0002']]);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const urls: string[] = [];
  const auth: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    auth.push(init.headers.Authorization ?? init.headers.authorization ?? '');
    const body = { id: 'x', object: 'chat.completion', model: 'm1', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const chat = await mountAgent({ log: fx.log, registry: fx.registry, nav: new RecordingNavHost(), memoryBackend: memoryBackend({}), storage, openaiCompatible: { preset, fetch } });
  assert.equal(chat.keys.hasKey, false, 'the DeepSeek key is not picked up by the custom endpoint');
  chat.setKey(KEY, true);
  assert.equal(store.get('amp.agent.provider-key.custom:https://llm.example.org'), KEY);
  assert.equal(store.get('amp.agent.provider-key.deepseek'), 'test-key-deepseek-0002');
  assert.equal(store.has('amp.agent.provider-key.anthropic'), false);
  await chat.send('hello');
  assert.ok(urls.length >= 1);
  assert.deepEqual([...new Set(urls)], ['https://llm.example.org/v1/chat/completions']);
  assert.ok(auth.every((a) => a === `Bearer ${KEY}`));
});
