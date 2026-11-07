// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, type AgentEvent } from '../src/loop.ts';
import { ScriptedProvider, say, turn, use } from '../src/provider/mock.ts';
import { createAnthropicAdapter, estimateCostUSD, type AnthropicMessageLike } from '../src/provider/anthropic.ts';
import { KeyStore } from '../src/keys.ts';
import { SYSTEM_PROMPT } from '../src/prompt.ts';
import { fixture } from '../eval/fixtures.ts';

test('refusal stops the turn; no tools run', async () => {
  const fx = await fixture('kirsch-plate');
  const p = new ScriptedProvider([{ content: [use('apply_ops', { ops: [], reason: 'x' })], stopReason: 'refusal' }]);
  const r = await new Agent({ session: fx.session, provider: p }).runTurn('x');
  assert.equal(r.stop, 'refusal');
  assert.equal(r.toolCalls.length, 0);
});

test('a tool call cut off at max_tokens is not executed', async () => {
  const fx = await fixture('kirsch-plate');
  const p = new ScriptedProvider([{ content: [use('apply_ops', { ops: [{ op: 'remove', path: '/physics' }], reason: 'x' })], stopReason: 'max_tokens' }]);
  const r = await new Agent({ session: fx.session, provider: p }).runTurn('x');
  assert.equal(r.stop, 'truncated');
  assert.equal(fx.log.ops.length, 0);
});

test('tool budget: excess calls get error results and the turn stops', async () => {
  const fx = await fixture('kirsch-plate');
  const p = new ScriptedProvider([turn(use('get_spec', {}), use('get_spec', {}), use('get_spec', {}))]);
  const agent = new Agent({ session: fx.session, provider: p, budget: { maxToolCalls: 2 } });
  const r = await agent.runTurn('x');
  assert.equal(r.stop, 'budget_tool_calls');
  assert.equal(r.toolCalls.length, 2);
  // every tool_use got a tool_result (history stays well-formed)
  const last = agent.messages.at(-1)!;
  assert.equal(last.content.filter((b) => b.type === 'tool_result').length, 3);
});

test('pause_turn (no server tools) stops without touching history; abort stops; provider errors are reported', async () => {
  const fx = await fixture('kirsch-plate');
  const p = new ScriptedProvider([{ content: [say('...')], stopReason: 'pause_turn' }]);
  const ag = new Agent({ session: fx.session, provider: p });
  assert.equal((await ag.runTurn('x')).stop, 'unexpected_stop');
  assert.equal(ag.messages.filter((m) => m.role === 'assistant').length, 0);
  const ac = new AbortController(); ac.abort();
  assert.equal((await new Agent({ session: fx.session, provider: new ScriptedProvider([turn(say('x'))]) }).runTurn('x', { signal: ac.signal })).stop, 'aborted');
  const r = await new Agent({ session: fx.session, provider: new ScriptedProvider([]) }).runTurn('x');
  assert.equal(r.stop, 'provider_error');
});

test('goal check feeds back once, then ends unresolved when the model does not fix it', async () => {
  const fx = await fixture('kirsch-plate');
  const p = new ScriptedProvider([turn(use('run_study', { study: 'std1', reason: 'x' })), turn(say('done')), turn(say('still done'))]);
  const goal = { describe: 'K_t below 2', check: (os: Array<{ ok: boolean; solution?: { scalars: Record<string, { value: number }> } }>) => {
    const kt = os.find((o) => o.ok)?.solution?.scalars.K_t?.value;
    return { ok: kt !== undefined && kt < 2, detail: `K_t = ${kt}` };
  } };
  const events: AgentEvent[] = [];
  const r = await new Agent({ session: fx.session, provider: p, onEvent: (e) => events.push(e) }).runTurn('x', { goal: goal as never });
  assert.equal(r.stop, 'unresolved');
  assert.deepEqual(r.problems, ['goal_not_met']);
  assert.equal(r.repairs, 1);
  assert.equal(events.filter((e) => e.type === 'repair').length, 1);
});

test('budget events carry tokens and an estimated cost for priced models', async () => {
  const fx = await fixture('kirsch-plate');
  const keys = new KeyStore(); keys.set('k-test-not-a-real-key');
  const hi: Array<{ type: string; text: string }> = [{ type: 'text', text: 'hi' }];
  const m: AnthropicMessageLike = { model: 'claude-opus-5-5', content: hi, stop_reason: 'end_turn', usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  const provider = createAnthropicAdapter({ keys, createClient: () => ({ beta: { messages: { stream: () => ({ on: () => undefined, finalMessage: async () => m }) } } }) });
  const events: AgentEvent[] = [];
  const r = await new Agent({ session: fx.session, provider, onEvent: (e) => events.push(e) }).runTurn('hi');
  assert.equal(r.costUSD, 4); // 1e6 input tokens at the cached table rate of USD 4 / MTok (claude-api skill, 2026-10-06)
  assert.equal(estimateCostUSD('unknown-model', r.usage), null);
  assert.ok(events.some((e) => e.type === 'budget' && e.state.usage.inputTokens === 1_000_000));
});

test('assistant raw content (thinking blocks) is replayed unchanged on the next request', async () => {
  const fx = await fixture('kirsch-plate');
  const keys = new KeyStore(); keys.set('k-test-not-a-real-key');
  const bodies: Array<Record<string, any>> = [];
  const thinking = { type: 'thinking', thinking: '', signature: 'opaque-sig' };
  const c1: Array<{ type: string; [k: string]: unknown }> = [thinking, { type: 'tool_use', id: 't1', name: 'get_spec', input: {} }];
  const c2: Array<{ type: string; [k: string]: unknown }> = [{ type: 'text', text: 'ok' }];
  const msgs: AnthropicMessageLike[] = [
    { model: 'claude-opus-5-5', content: c1, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'claude-opus-5-5', content: c2, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  let i = 0;
  const provider = createAnthropicAdapter({ keys, createClient: () => ({ beta: { messages: { stream: (b: Record<string, unknown>) => { bodies.push(structuredClone(b)); return { on: () => undefined, finalMessage: async () => msgs[i++]! }; } } } }) });
  await new Agent({ session: fx.session, provider }).runTurn('read');
  const assistant = bodies[1]!.messages[1];
  assert.deepEqual(assistant.content[0], thinking);
  assert.equal(bodies[1]!.system[0].text, SYSTEM_PROMPT);
  // tools + system prefix byte-identical across requests (prompt caching)
  assert.equal(JSON.stringify(bodies[0]!.tools) + JSON.stringify(bodies[0]!.system), JSON.stringify(bodies[1]!.tools) + JSON.stringify(bodies[1]!.system));
});
