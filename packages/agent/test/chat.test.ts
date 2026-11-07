// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpLog } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';
import { mountAgent, type ChatState } from '../src/chat.ts';
import { memoryBackend } from '../src/memory/backends.ts';
import { RecordingNavHost } from '../src/nav.ts';
import { ScriptedProvider, say, turn, use } from '../src/provider/mock.ts';
import * as api from '../src/index.ts';
import { simText, MockClosedFormRunner } from '../eval/fixtures.ts';

test('public API is exported from the package index', () => {
  for (const n of ['mountAgent', 'ChatController', 'Agent', 'AgentSession', 'toolDefinitions', 'toolDefinitionSize', 'createAnthropicAdapter', 'ScriptedProvider', 'MemoryStore', 'opfsBackend', 'directoryHandleBackend', 'memoryBackend', 'recall', 'KeyStore', 'NavTrail', 'SYSTEM_PROMPT', 'outsideBlocks']) {
    assert.ok(n in api, n);
  }
});

test('chat controller: rows, busy, budget, revert turn, key entry', async () => {
  const registry = wave1Registry();
  const text = simText('kirsch-plate');
  const log = await createOpLog(text, { registry });
  const provider = new ScriptedProvider([
    turn(say('Setting D.'), use('apply_ops', { ops: [{ op: 'replace', path: '/params/D/value', value: 8 }], reason: 'User: D 8 mm' })),
    turn(say('D is now 8 mm.')),
  ]);
  const chat = await mountAgent({ log, registry, nav: new RecordingNavHost(), runner: new MockClosedFormRunner(registry), memoryBackend: memoryBackend(), provider });
  const states: ChatState[] = [];
  chat.subscribe((s) => states.push(s));
  const r = await chat.send('Set D to 8 mm');
  assert.equal(r.stop, 'end_turn');
  assert.deepEqual(chat.state.rows.map((x) => x.kind), ['user', 'assistant', 'tool', 'assistant', 'stop']);
  assert.ok(states.some((s) => s.busy) && !chat.state.busy);
  assert.equal(chat.state.budget?.modelCalls, 2);
  assert.equal(log.ops.length, 1);
  assert.equal(log.ops[0]!.actor, chat.session.actor);
  await chat.revertTurn(1);
  assert.equal(log.text, text);
  assert.equal(chat.state.hasKey, false);
  chat.setKey('k-test-not-a-real-key');
  assert.equal(chat.state.hasKey, true);
  assert.equal(chat.state.keyPersisted, false);
  chat.clearKey();
  assert.equal(chat.state.hasKey, false);
});
